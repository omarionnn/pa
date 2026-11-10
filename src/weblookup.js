// Fetch a page and return readable text. Parallel Extract or Context.dev scrape when there is a key
// (REASON_LOOKUP_PROVIDER names which goes first), plain fetch as the fallback. When a page needs
// clicking, that is the browser's job.
import { guardedFetch } from "./netguard.js";
import { config } from "./config.js";
import { parallelClient } from "./parallel.js";

const BLOCK = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BREAKS = /<(\/p|br|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi;

/**
 * The image addresses a page really served.
 *
 * This exists so a picture on a Reason page can be a picture something actually published. The
 * model is not allowed to type an image URL from memory — it would produce plausible, dead ones —
 * so the only way one gets onto a page is by coming back from here (or from the browser) first.
 * https only, resolved against the page, de-duplicated, and capped: this is a source of truth, not
 * a scrape.
 */
export function imageUrls(html, baseUrl, max = 40) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    if (out.length >= max || !raw) return;
    try {
      const u = new URL(String(raw).trim(), baseUrl);
      if (u.protocol !== "https:") return;          // an http image will be blocked on an https page anyway
      if (/\.svg(\?|$)/i.test(u.pathname)) return;  // svg is markup; not something to re-serve
      u.hash = "";
      if (seen.has(u.href)) return;
      seen.add(u.href);
      out.push(u.href);
    } catch { /* not a URL we can use */ }
  };

  // og:image first: it is the one a site chose to represent itself, so it is the best single pick.
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi)) {
    add(/content=["']([^"']+)["']/i.exec(m[0])?.[1]);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    // srcset wins when present: the first candidate is usually the smallest, which is what a
    // phone wants.
    const srcset = /srcset=["']([^"']+)["']/i.exec(tag)?.[1];
    if (srcset) add(srcset.split(",")[0]?.trim().split(/\s+/)[0]);
    add(/\bsrc=["']([^"']+)["']/i.exec(tag)?.[1]);
  }
  return out;
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
      images,
      ...(images.length ? { images_note: "These are the real image addresses on that page. A picture may only go on a Reason page if it came from a list like this one." } : {}),
      provider: "contextdev",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function plainFetch(href, { maxChars, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Never this machine's own network, on any hop (src/netguard.js).
    const got = await guardedFetch(href, {
      signal: ac.signal,
      headers: { "user-agent": "ReasonBot/1.0 (+https://heyreason.com)", accept: "text/html,text/plain,*/*" },
    });
    if (!got.ok) return { ok: false, refused: true, error: `Not read: ${got.why}.` };
    const res = got.res;
    const finalUrl = got.url;
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) return { ok: false, status: res.status, url: finalUrl, error: `${res.status} ${res.statusText} from ${finalUrl}` };
    if (!/text\/html|text\/plain|application\/(json|xhtml)/i.test(type)) {
      return { ok: false, status: res.status, url: finalUrl, content_type: type, error: `That URL is ${type}, not a readable page.` };
    }
    const body = await res.text();
    const json = /json/i.test(type);
    const { title, text, truncated } = json
      ? { title: "", text: body.slice(0, maxChars), truncated: body.length > maxChars }
      : readableText(body, maxChars);
    const images = json ? [] : imageUrls(body, finalUrl);
    return {
      ok: true, status: res.status, url: finalUrl, title, text, text_truncated: truncated,
      images,
      ...(images.length ? { images_note: "These are the real image addresses on that page. A picture may only go on a Reason page if it came from a list like this one." } : {}),
    };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `${href} did not answer within ${timeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach ${href}: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parallel Extract (src/parallel.js): JavaScript pages and PDFs come back as markdown, and with an
 * `objective` the text is the passages that bear on it rather than the top of the page. Same shape
 * out as the other two, so research and the watchers cannot tell which one read the page — only
 * `provider` says.
 */
async function parallelExtractOne(href, { maxChars, objective, timeoutMs, client, fresh }) {
  const p = client ?? parallelClient();
  if (!p.status().connected) return null;
  const out = await p.extract([href], { objective, maxChars: maxChars + 500, timeoutMs, fresh });
  const hit = out.ok ? out.results.find(r => r.url === href) ?? out.results[0] : null;
  if (!hit || !hit.text) return null;
  const truncated = hit.text.length > maxChars;
  const text = truncated ? hit.text.slice(0, maxChars) : hit.text;
  return {
    ok: true, status: 200, url: hit.url, title: hit.title, text, text_truncated: truncated,
    images: hit.images,
    ...(hit.images.length ? { images_note: "These are the real image addresses on that page. A picture may only go on a Reason page if it came from a list like this one." } : {}),
    provider: "parallel",
    ...(objective ? { focused_on: objective } : {}),
  };
}

const SCRAPERS = { parallel: parallelExtractOne, contextdev: contextDevScrape };

/**
 * `objective` is what the reader is trying to find out, when there is one: a research run passes
 * its question so a 2,500-character slice is the part of the page ABOUT it. Only Extract uses it.
 *
 * `fresh` says this reader cannot be served a cached page: it is here to see what the page says
 * now, not what it said. Only Extract needs telling — context.dev and the plain fetch always go to
 * the page — so it is what the watchers pass and an ordinary read leaves alone.
 */
export async function webLookup(url, { maxChars = 6000, timeoutMs = 15_000, objective = "", provider = config.lookupProvider, parallel = null, fresh = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: `'${url}' is not a URL.` }; }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: `Only http and https. Got ${parsed.protocol}` };
  }
  // The named one first, then the other, then a plain fetch: each returns null when it has no key
  // or could not read the page, and the chain just moves on.
  const order = [provider, ...Object.keys(SCRAPERS).filter(k => k !== provider)].filter(k => SCRAPERS[k]);
  for (const name of order) {
    const got = await SCRAPERS[name](parsed.href, { maxChars, timeoutMs, objective, client: parallel, fresh });
    if (got) return got;
  }
  return await plainFetch(parsed.href, { maxChars, timeoutMs });
}
