// The status page's password (2026-10-24, the owner's call): a browser that is not already signed
// in is asked for it, and the right one signs that browser in exactly as the texted code does — the
// same operator session, the same 90-day cookie. The code stays on offer behind a link.
//
// The hash lives only in the server's environment (REASON_OPS_PASSWORD_HASH), never in the repo:
// `scrypt:<saltHex>:<hashHex>`, made with Node's crypto.scryptSync(password, salt, 64) at the default
// cost. Unset, there is no password and the page has the code gate alone, as before.
//
// Wrong guesses are counted in page_attempts, per client address and in total, so a restart does
// not reset them and spreading guesses over addresses only gets so far. Nothing typed is ever logged.
// An address is only believed when the website signed for it (verifiedSource); then it has its own
// count and a stranger cannot fill it. See tryPassword for which counts apply to which request.
import { scrypt, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import { config } from "./config.js";
import { siteClientIp } from "./pages/siteproxy.js";

export const WINDOW_MS = 15 * 60 * 1000;
/** Wrong passwords from one address in the window before it is locked out for the rest of it. */
export const MAX_PER_IP = 5;
/** Wrong passwords from everyone together in the window: past this nobody may try until it passes. */
export const MAX_TOTAL = 30;
/**
 * Wrong passwords from everyone together, whatever the path: the ceiling an address the website
 * signed for is held to. Well above MAX_TOTAL, since it is only reached by guessing spread over
 * many real addresses (each of which stops at MAX_PER_IP).
 */
export const MAX_VERIFIED_TOTAL = 300;
const ALL = "ops:pw";
/** Wrong passwords on the owner's keyed link: a count only a request carrying the ops key adds to. */
const KEYED = "ops:pw:key";
/** Per address the website signed for (verifiedSource): `ops:pw:src:<address>`. */
const SOURCE = "ops:pw:src";
/** Every wrong password not on the keyed link, signed or not. */
const EVERY = "ops:pw:every";

/** The stored hash, parsed, or null when there is none or it is malformed (then: no password). */
export function parseHash(stored = config.opsPasswordHash) {
  const m = /^scrypt:([0-9a-f]+):([0-9a-f]+)$/i.exec(String(stored ?? "").trim());
  if (!m || m[1].length < 16 || m[2].length !== 128) return null;
  return { salt: Buffer.from(m[1], "hex"), hash: Buffer.from(m[2], "hex") };
}

export function passwordEnabled() {
  return !!parseHash();
}

/** Does `input` match the stored hash? Constant-time on the derived key. */
export function passwordMatches(input, stored = config.opsPasswordHash) {
  const h = parseHash(stored);
  const pw = String(input ?? "");
  if (!h || !pw || pw.length > 1024) return Promise.resolve(false);
  return new Promise((resolve) => {
    scrypt(pw, h.salt, h.hash.length, (err, key) => resolve(!err && key.length === h.hash.length && timingSafeEqual(key, h.hash)));
  });
}

/**
 * Who is asking. Behind Netlify the browser's address is in x-nf-client-connection-ip, and in the
 * first entry of x-forwarded-for; the Tailscale Funnel in front of this server adds its own. The
 * per-address count is a courtesy — the total cap is what bounds a guesser who forges the header.
 */
export function clientIp(headers = {}, socketAddress = "") {
  const nf = String(headers["x-nf-client-connection-ip"] ?? "").trim();
  if (nf) return nf.slice(0, 64);
  const xff = String(headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  if (xff) return xff.slice(0, 64);
  return String(socketAddress || "unknown").slice(0, 64);
}

/** Null when this address may try, else how long until it may. */
export function lockedOut(ip) {
  const mine = db.failedPageAttempts(`${ALL}:${ip}`, WINDOW_MS);
  const all = db.failedPageAttempts(ALL, WINDOW_MS);
  if (mine >= MAX_PER_IP || all >= MAX_TOTAL) return { retry_after_s: Math.ceil(WINDOW_MS / 1000) };
  return null;
}

/**
 * The address this request is from, when something we trust says so, else "". Only the website's
 * signed rewrite counts (src/pages/siteproxy.js): Netlify replaces any x-nf-client-connection-ip a
 * browser sent, and signs. Not Caddy's X-Files-Domain marker — the Funnel lands on the same port
 * from the same loopback address and passes a browser's headers through, so anyone could write it.
 * An IPv6 address counts as its /64, the block one connection is handed, so rotating inside it
 * buys nothing.
 */
export function verifiedSource(headers = {}) {
  const ip = siteClientIp(headers).toLowerCase();
  if (!ip) return "";
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(":")) return "";
  const [head, tail = null, ...more] = ip.split("::");
  if (more.length) return "";
  const a = head ? head.split(":") : [];
  const b = tail === null ? [] : tail ? tail.split(":") : [];
  const groups = tail === null ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return "";
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const locked = () => ({ ok: false, reason: "locked", retry_after_s: Math.ceil(WINDOW_MS / 1000) });

/**
 * One try. `{ ok: true }`, or `{ ok: false, reason: "wrong" | "locked" | "off", tries_left? }`.
 * The attempt is written down as wrong before the password is even compared, and put right if it
 * was right: then simultaneous guesses each see the ones before them and cannot run past a cap.
 *
 * Which counts a try is held to (audit lead 23):
 *   - `keyed` (the request carries the owner's ops key): a count of its own that only a request
 *     with the key can add to, five wrong in the window;
 *   - `source` (an address the website signed for, verifiedSource): five wrong from that address,
 *     and MAX_VERIFIED_TOTAL from everyone together. Nobody else's guesses fill its five, and the
 *     shared MAX_TOTAL below, which anyone can fill by forging addresses, does not apply to it;
 *   - anything else, as before: five per claimed address, MAX_TOTAL from all of those together.
 * Every try not on the keyed link also adds to the overall count MAX_VERIFIED_TOTAL reads.
 */
export async function tryPassword({ password, ip, keyed = false, source = "" }) {
  if (!passwordEnabled()) return { ok: false, reason: "off" };
  const bucket = keyed ? KEYED : source ? `${SOURCE}:${source}` : `${ALL}:${ip}`;
  const failed = (k) => db.failedPageAttempts(k, WINDOW_MS);
  if (keyed) {
    if (failed(KEYED) >= MAX_PER_IP) return locked();
  } else if (source) {
    if (failed(bucket) >= MAX_PER_IP || failed(EVERY) >= MAX_VERIFIED_TOTAL) return locked();
  } else if (lockedOut(ip) || failed(EVERY) >= MAX_VERIFIED_TOTAL) {
    return locked();
  }
  // Written down now, before the await, so the next request in already counts this one.
  const rows = [db.recordPageAttempt(bucket, false)];
  if (!keyed) rows.push(db.recordPageAttempt(EVERY, false));
  if (!keyed && !source) rows.push(db.recordPageAttempt(ALL, false));
  const right = await passwordMatches(password);
  if (right) {
    db.forgetPageAttempts(rows);
    db.recordPageAttempt(bucket, true);
    return { ok: true };
  }
  return { ok: false, reason: "wrong", tries_left: Math.max(0, MAX_PER_IP - failed(bucket)) };
}
