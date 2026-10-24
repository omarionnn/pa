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
import { scrypt, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import { config } from "./config.js";

export const WINDOW_MS = 15 * 60 * 1000;
/** Wrong passwords from one address in the window before it is locked out for the rest of it. */
export const MAX_PER_IP = 5;
/** Wrong passwords from everyone together in the window: past this nobody may try until it passes. */
export const MAX_TOTAL = 30;
const ALL = "ops:pw";

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
 * One try. `{ ok: true }`, or `{ ok: false, reason: "wrong" | "locked" | "off", tries_left? }`.
 * The attempt is written down before the answer goes back, right or wrong.
 */
export async function tryPassword({ password, ip }) {
  if (!passwordEnabled()) return { ok: false, reason: "off" };
  const locked = lockedOut(ip);
  if (locked) return { ok: false, reason: "locked", ...locked };
  const right = await passwordMatches(password);
  db.recordPageAttempt(`${ALL}:${ip}`, right);
  if (right) return { ok: true };
  db.recordPageAttempt(ALL, false);
  const used = db.failedPageAttempts(`${ALL}:${ip}`, WINDOW_MS);
  return { ok: false, reason: "wrong", tries_left: Math.max(0, MAX_PER_IP - used) };
}
