// Who gets to see a page.
//
// There are two links to a page. The owner's link is the one Reason texts them: it carries a key,
// and tapping it opens the page with nothing to type — the owner asked for exactly that, and a
// code step nobody could complete was worse than no page. It is theirs to keep to themselves:
// whoever holds that link can open the page and press its choices. The bare link, without the key,
// is the one for other people: it opens only when the page has been shared, and then read-only.
//
// A bare link to a private page still does not open it. The six-character code path stays for that
// case, and once a browser has got in either way it gets a cookie and stops being asked.
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
 * Can this request see this page?
 *
 * Returns one of:
 *   { allow: true, interactive }     show it. `interactive` only for the owner's own browser.
 *   { allow: false, reason: "code_needed" }
 *   { allow: false, reason: "rate_limited", retry_after_s }
 */
export function checkAccess({ page, cookie, key = null }) {
  // The owner's own link. Checked first so the owner gets the interactive view even on a page
  // they have shared.
  if (key && sameKey(key, page.owner_key)) return { allow: true, interactive: true, via_key: true };

  // Shared means what it says: anyone with the link, read-only. Unsharing takes effect on the next
  // request because this is read fresh every time — there is no cached "was shared" anywhere.
  if (page.shared) return { allow: true, interactive: false };

  if (db.pageSessionValid(page.id, cookie, SESSION_TTL_MS)) {
    // The owner's own browser, proved once. This is the only view where a choice can be pressed.
    return { allow: true, interactive: true };
  }
  const failed = db.failedPageAttempts(page.id, ATTEMPT_WINDOW_MS);
  if (failed >= MAX_FAILED_ATTEMPTS) {
    return { allow: false, reason: "rate_limited", retry_after_s: Math.ceil(ATTEMPT_WINDOW_MS / 1000) };
  }
  return { allow: false, reason: "code_needed" };
}

/**
 * Try a code. On success the browser gets a session token to set as a cookie.
 *
 * Every attempt is written down, right or wrong, before the answer goes back — so a burst of
 * guesses hits the limit even if each one is a separate connection, and a restart does not reset
 * the count.
 */
export function trySubmittedCode({ page, code }) {
  const failed = db.failedPageAttempts(page.id, ATTEMPT_WINDOW_MS);
  if (failed >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: "rate_limited", retry_after_s: Math.ceil(ATTEMPT_WINDOW_MS / 1000) };
  }

  const live = db.livePageCode(page.id);
  if (!live) {
    db.recordPageAttempt(page.id, false);
    return { ok: false, reason: "expired" };
  }
  if (!sameCode(code, live.code)) {
    db.recordPageAttempt(page.id, false);
    const left = Math.max(0, MAX_FAILED_ATTEMPTS - (failed + 1));
    return { ok: false, reason: "wrong", tries_left: left };
  }

  db.recordPageAttempt(page.id, true);
  db.usePageCode(live.id);
  const token = randomBytes(32).toString("base64url");
  db.startPageSession(page.id, token);
  return { ok: true, token };
}

/** The bare link: the one for other people. Opens only when the page is shared, read-only. */
export function pageUrl(pageId) {
  const base = (config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
  return `${base}/p/${pageId}`;
}

/**
 * The owner's link: the one Reason texts them. Tapping it opens the page. Without
 * REASON_PUBLIC_URL it only opens on this machine.
 */
export function ownerUrl(page) {
  return `${pageUrl(page.id)}?k=${page.owner_key}`;
}

/** A browser that arrived by the owner's link stays in, so the bare link works there afterwards. */
export function startOwnerSession(page) {
  const token = randomBytes(32).toString("base64url");
  db.startPageSession(page.id, token);
  return token;
}

/** Is that link reachable from a phone, or only from this machine? Said plainly, never implied. */
export function linksAreReachable() {
  return !!config.publicUrl;
}

export function cookieHeader(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // Lax rather than Strict: the owner arrives by tapping a link in a text message, which is a
  // cross-site navigation, and Strict would drop the cookie on exactly that first hop back.
  const secure = (config.publicUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/p/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
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
