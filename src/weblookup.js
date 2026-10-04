// Plain fetch and readable text. No browser, no JavaScript, no cookies.
// For "what does this page say". When a page needs clicking, that is the browser's job.
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

export async function webLookup(url, { maxChars = 6000, timeoutMs = 15_000 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: `'${url}' is not a URL.` }; }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: `Only http and https. Got ${parsed.protocol}` };
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.href, {
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
      images,
      ...(images.length ? { images_note: "These are the real image addresses on that page. A picture may only go on a Reason page if it came from a list like this one." } : {}),
    };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `${parsed.href} did not answer within ${timeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach ${parsed.href}: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}
