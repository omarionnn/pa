// Fetch a page and return readable text. Parallel Extract when there is a key, Context.dev scrape
// as the fallback, plain fetch when neither is there or both fail.
// When a page needs clicking, that is the browser's job.
import { config } from "./config.js";

const BLOCK = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BREAKS = /<(\/p|br|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi;

/**
 * Keep the image addresses that are usable: https only, resolved against the page, de-duplicated,
 * capped. Shared by the HTML reader and the markdown reader so both are held to the same rule.
 */
function usableImageUrls(candidates, baseUrl, max) {
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    if (out.length >= max) break;
    if (!raw) continue;
    try {
      const u = new URL(String(raw).trim(), baseUrl);
      if (u.protocol !== "https:") continue;          // an http image will be blocked on an https page anyway
      if (/\.svg(\?|$)/i.test(u.pathname)) continue;  // svg is markup; not something to re-serve
      u.hash = "";
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      out.push(u.href);
    } catch { /* not a URL we can use */ }
  }
  return out;
}

/**
 * The image addresses a page really served.
 *
 * This exists so a picture on a Reason page can be a picture something actually published. The
 * model is not allowed to type an image URL from memory — it would produce plausible, dead ones —
 * so the only way one gets onto a page is by coming back from here (or from the browser) first.
 * This is a source of truth, not a scrape.
 */
export function imageUrls(html, baseUrl, max = 40) {
  const found = [];
  // og:image first: it is the one a site chose to represent itself, so it is the best single pick.
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi)) {
    found.push(/content=["']([^"']+)["']/i.exec(m[0])?.[1]);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    // srcset wins when present: the first candidate is usually the smallest, which is what a
    // phone wants.
    const srcset = /srcset=["']([^"']+)["']/i.exec(tag)?.[1];
    if (srcset) found.push(srcset.split(",")[0]?.trim().split(/\s+/)[0]);
    found.push(/\bsrc=["']([^"']+)["']/i.exec(tag)?.[1]);
  }
  return usableImageUrls(found, baseUrl, max);
}

/** The same, for a page that came back as markdown: every `![alt](address)` in it. */
export function markdownImageUrls(md, baseUrl, max = 40) {
  const found = [];
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) found.push(m[1]);
  return usableImageUrls(found, baseUrl, max);
}

export function readableText(html, maxChars = 6000) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  let t = html
    .replace(BLOCK, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(BREAKS, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = t.length > maxChars;
  if (truncated) t = t.slice(0, maxChars);
  return { title: decodeTitle(title), text: t, truncated };
}

function decodeTitle(t) {
  return t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const IMAGES_NOTE = "These are the real image addresses on that page. A picture may only go on a Reason page if it came from a list like this one.";

function withImages(images) {
  return { images, ...(images.length ? { images_note: IMAGES_NOTE } : {}) };
}

/**
 * Parallel Extract: the whole page as markdown, JavaScript-rendered pages and PDFs included.
 *   POST https://api.parallel.ai/v1/extract  — header x-api-key
 *   body { urls:[href], advanced_settings:{ full_content:{max_chars_per_result}, fetch_policy } }
 *   → { results:[{ url, title, publish_date, excerpts[], full_content }], errors:[], usage }
 *
 * `fresh` is for a watch: it asks for a live read when Parallel's copy is older than ten minutes
 * (the smallest age it allows), so a price that moved since the cached copy is not missed. A page
 * someone is reading once can take the cached copy, which is faster.
 */
async function parallelExtract(href, { maxChars, timeoutMs, fresh }) {
  const key = config.parallelKey;
  if (!key) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.parallelBase}/v1/extract`, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        urls: [href],
        advanced_settings: {
          full_content: { max_chars_per_result: maxChars },
          fetch_policy: {
            ...(fresh ? { max_age_seconds: 600 } : {}),
            timeout_seconds: Math.max(5, Math.floor(timeoutMs / 1000) - 2),
          },
        },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const r = json.results?.[0];
    const body = typeof r?.full_content === "string" && r.full_content
      ? r.full_content
      : Array.isArray(r?.excerpts) ? r.excerpts.filter(x => typeof x === "string").join("\n\n") : "";
    if (!body) return null;
    const truncated = body.length > maxChars;
    const text = truncated ? body.slice(0, maxChars) : body;
    const finalUrl = r.url ?? href;
    return {
      ok: true, status: 200, url: finalUrl, title: r.title ?? "", text, text_truncated: truncated,
      ...withImages(markdownImageUrls(body, finalUrl)),
      provider: "parallel",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function contextDevScrape(href, { maxChars, timeoutMs }) {
  const key = config.contextDevKey;
  if (!key) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.contextDevBase}/web/scrape`, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url: href,
        formats: { markdown: true, images: true },
        sharedParams: { mainContentOnly: true },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.markdown?.success || !json.markdown?.data) return null;
    let text = json.markdown.data;
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    const title = json.metadata?.title ?? "";
    const finalUrl = json.metadata?.finalUrl ?? json.url ?? href;
    const images = (json.images?.data ?? [])
      .filter(img => typeof img === "string" || typeof img?.url === "string")
      .map(img => typeof img === "string" ? img : img.url)
      .filter(u => /^https:\/\//.test(u));
    return {
      ok: true, status: 200, url: finalUrl, title, text, text_truncated: truncated,
      ...withImages(images),
      provider: "contextdev",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function plainFetch(href, { maxChars, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(href, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": "Reason/0.1 (+https://github.com/omarionnn)", accept: "text/html,text/plain,*/*" },
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) return { ok: false, status: res.status, url: res.url, error: `${res.status} ${res.statusText} from ${res.url}` };
    if (!/text\/html|text\/plain|application\/(json|xhtml)/i.test(type)) {
      return { ok: false, status: res.status, url: res.url, content_type: type, error: `That URL is ${type}, not a readable page.` };
    }
    const body = await res.text();
    const json = /json/i.test(type);
    const { title, text, truncated } = json
      ? { title: "", text: body.slice(0, maxChars), truncated: body.length > maxChars }
      : readableText(body, maxChars);
    const images = json ? [] : imageUrls(body, res.url);
    return {
      ok: true, status: res.status, url: res.url, title, text, text_truncated: truncated,
      ...withImages(images),
    };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `${href} did not answer within ${timeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach ${href}: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Read one page. `fresh` says a cached copy will not do (a watch re-reading a price); the one-off
 * read someone is waiting on leaves it off and takes the faster copy.
 */
export async function webLookup(url, { maxChars = 6000, timeoutMs = 15_000, fresh = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: `'${url}' is not a URL.` }; }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: `Only http and https. Got ${parsed.protocol}` };
  }
  const opts = { maxChars, timeoutMs, fresh };
  return await parallelExtract(parsed.href, opts)
    ?? await contextDevScrape(parsed.href, opts)
    ?? await plainFetch(parsed.href, opts);
}
