// Plain fetch and readable text. No browser, no JavaScript, no cookies.
// For "what does this page say". When a page needs clicking, that is the browser's job.
const BLOCK = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BREAKS = /<(\/p|br|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi;

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
    const { title, text, truncated } = /json/i.test(type)
      ? { title: "", text: body.slice(0, maxChars), truncated: body.length > maxChars }
      : readableText(body, maxChars);
    return { ok: true, status: res.status, url: res.url, title, text, text_truncated: truncated };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: `${parsed.href} did not answer within ${timeoutMs / 1000}s.` };
    return { ok: false, error: `Could not reach ${parsed.href}: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}
