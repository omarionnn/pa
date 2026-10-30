// A store's own icon, for the Connect page (src/pages/webconnect.js): its apple-touch-icon, or a large
// enough favicon, read from the store's site and handed back as a data: URI (src/shopconnect.js keeps
// it). Anything doubtful gives "" and the page draws a monogram instead: never a broken image.
//
// The host comes from a checkout's start URL, so this is a server fetching a name it was given. Only
// https, only port 443, and every hop (redirects followed by hand, at most 3) must resolve to public
// addresses: no loopback, private, link-local or metadata ranges.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAX_PAGE = 512 * 1024;
const MAX_ICON = 200 * 1024;
const MIN_PX = 32;

let fetcher = (...a) => fetch(...a);
let resolver = (host) => lookup(host, { all: true });
/** Tests hand in a fake web and a fake DNS. */
export function _setNet({ fetch: f, lookup: l } = {}) {
  fetcher = f ?? ((...a) => fetch(...a));
  resolver = l ?? ((host) => lookup(host, { all: true }));
}

/** True for an address the open internet can't reach (or shouldn't be asked about by this server). */
export function privateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return privateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8:");
  }
  return true;
}
async function publicUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return privateAddress(host) ? null : url;
  if (!/\./.test(host) || /\.(local|internal|localhost|lan|home|arpa)$/i.test(host)) return null;
  const addrs = await resolver(host).catch(() => []);
  return addrs.length && addrs.every((a) => !privateAddress(a.address)) ? url : null;
}

/** GET with a byte cap, redirects followed by hand (each hop checked). → { url, type, bytes } or null. */
async function get(u, { max, timeoutMs, accept }) {
  let url = await publicUrl(u);
  for (let hop = 0; url && hop < 4; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetcher(url.href, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.("location");
        url = loc ? await publicUrl(new URL(loc, url).href) : null;
        continue;
      }
      if (!res.ok) return null;
      const len = Number(res.headers?.get?.("content-length") || 0);
      if (len > max) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > max) return null;
      return { url, type: String(res.headers?.get?.("content-type") || "").toLowerCase(), bytes };
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

/** The icons a page's <head> offers, best first: apple-touch-icon, then big or vector icons. */
export function iconLinks(html, base) {
  const out = [];
  for (const tag of String(html).match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (n) => (new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag) ?? []).slice(1).find((x) => x !== undefined) ?? "";
    const rel = attr("rel").toLowerCase();
    if (!/\b(apple-touch-icon(-precomposed)?|icon)\b/.test(rel) || /mask-icon/.test(rel)) continue;
    let href;
    try { href = new URL(attr("href").replace(/&amp;/g, "&"), base).href; } catch { continue; }
    if (!/^https:/.test(href)) continue;
    const size = Math.max(0, ...attr("sizes").split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));
    const svg = /svg/.test(attr("type")) || /\.svg(\?|$)/i.test(href);
    const score = (/apple-touch/.test(rel) ? 1000 : 0) + (svg ? 500 : 0) + Math.min(size, 512);
    out.push({ href, score });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.href);
}

/** What the bytes are, read from the bytes themselves; width where the format says it cheaply. */
export function sniff(b) {
  if (b.length > 24 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return { mime: "image/png", px: b.readUInt32BE(16) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) return { mime: "image/jpeg", px: null };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { mime: "image/gif", px: b.readUInt16LE(6) };
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { mime: "image/webp", px: null };
  if (b.length > 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
    let px = 0;
    for (let i = 0, n = b.readUInt16LE(4); i < n && 6 + i * 16 + 16 <= b.length; i++) px = Math.max(px, b[6 + i * 16] || 256);
    return { mime: "image/x-icon", px };
  }
  const head = b.toString("utf8", 0, Math.min(b.length, 1024)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg\b/i.test(head)) return { mime: "image/svg+xml", px: null };
  return null;
}

/**
 * The store's icon as a data: URI, or "" when there's no good one. `host` is the store's site
 * ("amazon.com"); the homepage is read for its <link rel=icon>s, then the usual paths are tried.
 */
export async function fetchIcon(host, { timeoutMs = 4000 } = {}) {
  const h = String(host ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return "";
  const homes = [`https://www.${h.replace(/^www\./, "")}/`, `https://${h}/`];
  const tried = new Set();
  let base = homes[0];
  let candidates = [];
  for (const home of homes) {
    const page = await get(home, { max: MAX_PAGE, timeoutMs, accept: "text/html" });
    if (!page) continue;
    base = page.url.href;
    candidates = iconLinks(page.bytes.toString("utf8"), base);
    break;
  }
  const origin = new URL(base).origin;
  candidates.push(`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`);
  for (const c of candidates) {
    if (tried.has(c) || tried.size >= 6) continue;
    tried.add(c);
    const img = await get(c, { max: MAX_ICON, timeoutMs, accept: "image/*" });
    const kind = img && sniff(img.bytes);
    if (!kind || (kind.px !== null && kind.px < MIN_PX)) continue;
    return `data:${kind.mime};base64,${img.bytes.toString("base64")}`;
  }
  return "";
}
