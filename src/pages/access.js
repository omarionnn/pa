// Who gets to see a page.
//
// There are two links to a page. The owner's link is the one Reason texts them: it carries a key.
// On a browser that has opened one of their pages before, tapping it just opens the page. On a
// browser that has not (2026-10-17, Omari: a private window opened his page cold, and he wanted the
// phone in the loop), the key alone is not enough: the gate offers to text the owner a six-digit
// code, and typing it once signs that browser in to every page of theirs for 90 days. Holding the
// link proves you were sent it; the code proves you hold the phone it was sent to. There is no
// sharing (removed 2026-10-23): a page is only ever its owner's. A stranger with a bare link is
// offered no code, so nothing they do can make the owner's phone buzz.
//
// Everything here is a decision about access, so none of it is the model's: the code is generated
// here, compared here in constant time, and rate limited from a table rather than from whatever
// happens to be in memory when the process restarts.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import { config, clock } from "../config.js";
import { cookieDomain } from "./siteproxy.js";

export const CODE_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const MAX_CODES_SENT = 3;
export const COOKIE = "reason_page";

// Six digits (2026-10-25, Omari): a number pad, and the iPhone offering the code above the keyboard
// on its own. Drawn uniformly by randomInt and padded, so 004213 is as likely as 913570 and the
// leading zero is part of the code.
export const CODE_DIGITS = 6;
export function newCode() {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

/**
 * What was typed, pasted or autofilled, as the code to compare. A run of exactly six digits wins
 * wherever it sits — "012 345" is not one, but a whole pasted text is — then spaces and dashes go,
 * which also leaves a letter code from before the switch comparable for its last fifteen minutes.
 */
export function typedCode(typed) {
  const t = String(typed ?? "");
  const run = t.match(/(?<!\d)\d{6}(?!\d)/);
  return run ? run[0] : t.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * The host a code is bound to: the address-bar host of the page it is typed into, no scheme or port.
 * A bare IP or localhost (no REASON_PAGES_URL, a dev machine) is no domain to bind to, so none.
 */
export function codeHost(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return ""; }
  return /^(localhost|\[.*\]|[0-9.]+)$/i.test(host) || !host.includes(".") ? "" : host;
}

/**
 * The domain-bound last line Apple reads (`@host #code`, after a blank line), so an iPhone offers
 * the code above the keyboard only on that host. No host, no line: an unbound code is still a code.
 */
export function boundTo(host, code) {
  return host ? `\n\n@${host} #${code}` : "";
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
export function requestCode(page, { host } = {}) {
  if (db.pageCodesIssued(page.id, ATTEMPT_WINDOW_MS) >= MAX_CODES_SENT) {
    return { ok: false, reason: "too_many_sent", retry_after_s: Math.ceil(ATTEMPT_WINDOW_MS / 1000) };
  }
  const { id, code } = issueCode(page.id);
  return { ok: true, id, code, line: codeLine(page, code, { host }) };
}

/** What the owner is texted. Names the page and says it can be ignored, so a code they did not ask for reads as a warning, not a mystery. */
export function codeLine(page, code, { host = codeHost(pageUrl(page.id)) } = {}) {
  const mins = Math.round(CODE_TTL_MS / 60000);
  return `Your Reason code is ${code}, to open "${page.title}" on that browser. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was shown.${boundTo(host, code)}`;
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
  if (!live || !db.pageCodeIs(live.code, typedCode(code))) {
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

export function cookieHeader(token, { path = "/p/", headers = null } = {}) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // Lax rather than Strict: the owner arrives by tapping a link in a text message, which is a
  // cross-site navigation, and Strict would drop the cookie on exactly that first hop back.
  const secure = (config.publicUrl || "").startsWith("https://") ? "; Secure" : "";
  // Under heyreason.com the one cookie is shared by Web, pages, events and /ops (decision 3).
  const domain = headers ? cookieDomain(headers) : "";
  return `${COOKIE}=${token}; Path=${path}${domain ? `; Domain=${domain}` : ""}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * The same cookie, gone: what a "sign out of this browser" answers with. Under the shared domain
 * both copies go — the shared one and a host-only one an older sign-in left on this host.
 */
export function clearCookieHeader({ path = "/", headers = null } = {}) {
  const secure = (config.publicUrl || "").startsWith("https://") ? "; Secure" : "";
  const plain = `${COOKIE}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
  const domain = headers ? cookieDomain(headers) : "";
  return domain ? [plain, `${COOKIE}=; Path=${path}; Domain=${domain}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`] : plain;
}

/** Every `reason_page` value this browser sent, in order (a browser can hold two; see readCookie). */
export function readCookies(header) {
  const found = [];
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE && v.join("=")) found.push(v.join("="));
  }
  return found;
}

/**
 * The session token this browser sent. A browser can hold two (a host-only one from before the
 * cookie was shared, and the shared one); then the first that is still a session wins — unless the
 * live ones belong to different people, which no sign-in of ours makes (a cookie planted from a
 * sibling host would): then none, so a planted session can sign somebody out but never swap them
 * into another account.
 */
export function readCookie(header) {
  const found = readCookies(header);
  if (found.length < 2) return found[0] ?? null;
  const live = found.filter(t => db.pageSessionExists(t));
  if (!live.length) return found[0];
  const owners = new Set(live.map(t => db.pageSessionConversation(t) ?? `page:${t}`));
  return owners.size === 1 ? live[0] : null;
}

/** For tests and for /health: how close this page is to being locked out. */
export function attemptState(pageId) {
  const failed = db.failedPageAttempts(pageId, ATTEMPT_WINDOW_MS);
  return { failed, limit: MAX_FAILED_ATTEMPTS, locked: failed >= MAX_FAILED_ATTEMPTS, since_ms: ATTEMPT_WINDOW_MS, now: clock.now() };
}
