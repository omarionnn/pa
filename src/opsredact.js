// The status page's key never leaves through anything but the status page (owner 10-27).
//
// The owner's alert texts carry `/ops?k=<key>` (src/ops.js opsUrl) and those texts are rows in their
// thread, so Web drew the key in plain text — in the thread, on Home, in history and search. Every
// response the server writes, except the status page's own, goes through `guardResponse`: a link to
// the status page keeps its address and loses `k=`, and the key itself, should it appear any other
// way, is taken out. The page without the key still opens for the owner's proved browser and still
// asks anybody else for the password; only "text me a code" needs the key, and that stays in the texts.
//
// This reads link structure (a path and its query), never what a message means.
import * as db from "./db.js";
import { config } from "./config.js";

// `/ops` or `/ops.json` — on one of Reason's own hosts, or bare on a page of ours — then its query up
// to whatever ends a link in text, JSON or HTML. Somebody else's site's /ops is left alone.
const OPS_LINK = /(https?:\/\/[^\s/"'<>`]+)?\/ops(\.json)?\?([^\s"'<>`)\]}\\]*)/g;
const ownHost = (origin) => {
  if (!origin) return true;
  let host = "";
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  return [config.opsUrl, config.publicUrl, config.siteUrl, config.pagesUrl].some(u => {
    try { return !!u && new URL(u).host.toLowerCase() === host; } catch { return false; }
  });
};
const TEXTUAL = /^(text\/|application\/(json|javascript|xml|[a-z.+-]*\+json))/i;

/** The key in use now, or null; never minted here (src/ops.js opsKey mints it). */
function currentKey() {
  try { return db.opsGet("key") || null; } catch { return null; }
}

/** Is there a status-page link with a key in this text? */
export function hasOpsKeyLink(text) {
  OPS_LINK.lastIndex = 0;
  for (const m of String(text ?? "").matchAll(OPS_LINK)) if (ownHost(m[1]) && m[3].split(/&(?:amp;)?/).some(p => /^k=/.test(p))) return true;
  const k = currentKey();
  return !!k && String(text ?? "").includes(k);
}

/** The text with every status-page link's `k=` dropped and the key itself taken out. */
export function stripOpsKeys(text) {
  let s = String(text ?? "");
  if (s.includes("/ops")) {
    s = s.replace(OPS_LINK, (whole, origin, json, query) => {
      if (!ownHost(origin)) return whole;
      const amp = query.includes("&amp;") ? "&amp;" : "&";
      const kept = query.split(/&(?:amp;)?/).filter(p => p && !/^k=/.test(p));
      return `${origin ?? ""}/ops${json ?? ""}${kept.length ? `?${kept.join(amp)}` : ""}`;
    });
  }
  const k = currentKey();
  if (k && s.includes(k)) s = s.split(k).join("");
  return s;
}

/** Same, for anything a response writes: a string or a Buffer; anything else as it was. */
function stripChunk(chunk, encoding) {
  if (chunk == null) return chunk;
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const k = currentKey();
    if (b.indexOf("/ops") < 0 && !(k && b.indexOf(k) >= 0)) return chunk;
    return Buffer.from(stripOpsKeys(b.toString("utf8")), "utf8");
  }
  if (typeof chunk === "string") {
    if (encoding && !/^utf-?8$/i.test(encoding)) return chunk;
    return stripOpsKeys(chunk);
  }
  return chunk;
}

const typeOf = (headers) => {
  if (!headers || typeof headers !== "object") return null;
  if (Array.isArray(headers)) {
    // The raw form: [name, value, name, value, …] (or [[name, value], …]).
    const flat = headers.flat();
    for (let i = 0; i < flat.length - 1; i += 2) if (String(flat[i]).toLowerCase() === "content-type") return String(flat[i + 1]);
    return null;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "content-type") return String(v);
  return null;
};
const withoutLength = (headers) => {
  if (Array.isArray(headers)) {
    const flat = headers.flat(), out = [];
    for (let i = 0; i < flat.length - 1; i += 2) if (String(flat[i]).toLowerCase() !== "content-length") out.push(flat[i], flat[i + 1]);
    return out;
  }
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-length"));
};

/**
 * Wrap one response so nothing it writes carries the key. Text bodies only (HTML, JSON, the live
 * stream); a picture or a file goes through untouched. The length header comes off a text body, so
 * a body that got shorter is still sent whole (chunked).
 */
export function guardResponse(res) {
  const textual = () => TEXTUAL.test(String(res.getHeader?.("content-type") ?? res._opsType ?? ""));
  const { writeHead, write, end } = res;
  res.writeHead = function (status, ...rest) {
    const headers = rest[rest.length - 1];
    const type = typeOf(headers) ?? res.getHeader?.("content-type");
    if (type) res._opsType = String(type);
    if (type && TEXTUAL.test(String(type))) {
      if (headers && typeof headers === "object") rest[rest.length - 1] = withoutLength(headers);
      res.removeHeader?.("content-length");
    }
    return writeHead.call(this, status, ...rest);
  };
  res.write = function (chunk, encoding, cb) {
    if (textual()) {
      if (!res.headersSent) res.removeHeader?.("content-length");
      chunk = stripChunk(chunk, typeof encoding === "string" ? encoding : null);
    }
    return write.call(this, chunk, encoding, cb);
  };
  res.end = function (chunk, encoding, cb) {
    if (textual() && chunk != null && typeof chunk !== "function") {
      if (!res.headersSent) res.removeHeader?.("content-length");
      chunk = stripChunk(chunk, typeof encoding === "string" ? encoding : null);
    }
    return end.call(this, chunk, encoding, cb);
  };
  return res;
}
