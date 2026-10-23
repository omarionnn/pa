// Who gets to see a page.
//
// There are two links to a page. The owner's link is the one Reason texts them: it carries a key.
// On a browser that has opened one of their pages before, tapping it just opens the page. On a
// browser that has not (2026-10-17, Omari: a private window opened his page cold, and he wanted the
// phone in the loop), the key alone is not enough: the gate offers to text the owner a six-character
// code, and typing it once signs that browser in to every page of theirs for 90 days. Holding the
// link proves you were sent it; the code proves you hold the phone it was sent to. There is no
// sharing (removed 2026-10-23): a page is only ever its owner's. A stranger with a bare link is
// offered no code, so nothing they do can make the owner's phone buzz.
//
// Everything here is a decision about access, so none of it is the model's: the code is generated
// here, compared here in constant time, and rate limited from a table rather than from whatever
// happens to be in memory when the process restarts.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import { config, clock } from "../config.js";

// No I, O, 0 or 1: this gets read off one screen and typed into another, by a person, probably
// one-handed.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CODE_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const MAX_CODES_SENT = 3;
export const COOKIE = "reason_page";

export function newCode() {
  const bytes = randomBytes(6);
  return [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join("");
}

function sameCode(a, b) {
  const x = Buffer.from(String(a ?? "").trim().toUpperCase());
  const y = Buffer.from(String(b ?? "").trim().toUpperCase());
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function sameKey(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Mint a code for one page and return it, for Reason to send to the owner. */
export function issueCode(pageId) {
  return db.createPageCode(pageId, { code: newCode(), ttlMs: CODE_TTL_MS });
}

/**
 * Mint a code and hand back the line to text, or say why not. Only a request carrying the owner's
 * key gets here (http.js checks), so the one thing left to bound is how often a held link can make
 * the owner's phone buzz: MAX_CODES_SENT in the attempt window, counted from the table.
 */
export function requestCode(page) {
  if (db.pageCodesIssued(page.id, ATTEMPT_WINDOW_MS) >= MAX_CODES_SENT) {
    return { ok: false, reason: "too_many_sent", retry_after_s: Math.ceil(ATTEMPT_WINDOW_MS / 1000) };
  }
  const { code } = issueCode(page.id);
  return { ok: true, code, line: codeLine(page, code) };
}

/** What the owner is texted. Names the page and says it can be ignored, so a code they did not ask for reads as a warning, not a mystery. */
export function codeLine(page, code) {
  const mins = Math.round(CODE_TTL_MS / 60000);
  return `Code to open "${page.title}" on that browser: ${code}. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was shown.`;
}

/**
 * Can this request see this page?
 *
 * Returns one of:
 *   { allow: true, interactive, via_key }     show it. `interactive` only for the owner's own browser.
 *   { allow: false, reason: "code_needed", via_key }
 *   { allow: false, reason: "rate_limited", retry_after_s, via_key }
 *
 * `via_key` is true when the request carries the owner's key: not enough to open the page on a
 * browser nobody has proved, but enough to be offered a code, and to fetch the page's preview.
 */
export function checkAccess({ page, cookie, key = null }) {
  const via_key = !!(key && sameKey(key, page.owner_key));

  // The owner's own browser, proved once on any page of theirs.
  if (db.pageSessionValid(page.id, cookie, SESSION_TTL_MS)) return { allow: true, interactive: true, via_key };

  // Anybody else — the owner's link on a browser not yet proved included — gets the gate. A page is
  // only ever its owner's: there is no sharing (removed 2026-10-23, at the owner's ask).
  return codeNeeded(page, via_key);
}

function codeNeeded(page, via_key) {
  const failed = db.failedPageAttempts(page.id, ATTEMPT_WINDOW_MS);
  if (failed >= MAX_FAILED_ATTEMPTS) {
    return { allow: false, reason: "rate_limited", retry_after_s: Math.ceil(ATTEMPT_WINDOW_MS / 1000), via_key };
  }
  return { allow: false, reason: "code_needed", via_key };
}

/**
 * Try a code. On success the browser gets a session token to set as a cookie.
 *
 * Every attempt is written down, right or wrong, before the answer goes back — so a burst of
 * guesses hits the limit even if each one is a separate connection, and a restart does not reset
 * the count.
 *
 * There is exactly one failure answer, `wrong`, and that is deliberate. A page with no code
 * outstanding and a page whose code was mistyped used to answer differently ("expired" against
 * "not right"), which told a guesser that the id was real and had a live code on it. The owner
 * does not need the distinction — the gate already tells them where a code comes from — and
 * whoever is typing codes at somebody else's link must not have it. Same answer, same count,
 * same shape, whatever is behind the id.
 */
export function trySubmittedCode({ page, code }) {
  const failed = db.failedPageAttempts(page.id, ATTEMPT_WINDOW_MS);
  if (failed >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: "rate_limited", retry_after_s: Math.ceil(ATTEMPT_WINDOW_MS / 1000) };
  }

  const live = db.livePageCode(page.id);
  if (!live || !sameCode(code, live.code)) {
    db.recordPageAttempt(page.id, false);
    const left = Math.max(0, MAX_FAILED_ATTEMPTS - (failed + 1));
    return { ok: false, reason: "wrong", tries_left: left };
  }

  db.recordPageAttempt(page.id, true);
  db.usePageCode(live.id);
  const token = randomBytes(32).toString("base64url");
  // The owner is the page's; for a page with no row of its own (the status page) it is whoever
  // the caller said, which is how that one browser becomes "the owner's" for every page of theirs.
  db.startPageSession(page.id, token, { conversationId: page.conversation_id ?? null });
  return { ok: true, token };
}

/** The bare link, without the key: what the card and preview addresses are built on. */
export function pageUrl(pageId) {
  if (config.pagesUrl) return `${config.pagesUrl}/${pageId}`;
  const base = (config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return `${base}/p/${pageId}`;
}

/**
 * The owner's link: the one Reason texts them. Tapping it opens the page on a browser they have
 * proved before; on a new one it offers the code. Without REASON_PUBLIC_URL it only opens on this
 * machine.
 */
export function ownerUrl(page) {
  return `${pageUrl(page.id)}?k=${page.owner_key}`;
}

/** Is that link reachable from a phone, or only from this machine? Said plainly, never implied. */
export function linksAreReachable() {
  return !!config.publicUrl;
}

export function cookieHeader(token, { path = "/p/" } = {}) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // Lax rather than Strict: the owner arrives by tapping a link in a text message, which is a
  // cross-site navigation, and Strict would drop the cookie on exactly that first hop back.
  const secure = (config.publicUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function readCookie(header) {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** For tests and for /health: how close this page is to being locked out. */
export function attemptState(pageId) {
  const failed = db.failedPageAttempts(pageId, ATTEMPT_WINDOW_MS);
  return { failed, limit: MAX_FAILED_ATTEMPTS, locked: failed >= MAX_FAILED_ATTEMPTS, since_ms: ATTEMPT_WINDOW_MS, now: clock.now() };
}
