// Face ID before each use of a saved login (vault PR 6; design B8). A careful site, or a login saved
// "ask me each time", has no standing permission: every sign-in needs a fresh Face ID approval, kind
// `login` (the passkey check PR 5 added, src/passkey.js verifyLoginAssertion), over a challenge bound
// to this one login, this site and a fresh nonce.
//
// The approval is one use and short-lived, and it is kept in memory only: a restart drops every
// open one, which fails closed (they tap again). Nothing here touches the vault or a secret: the link
// carries a random token, the page shows only the site's name, and an approval is a yes for one
// sign-in to one site in the next few minutes, consumed by src/filler.js before anything is opened.
import { createHash, randomBytes } from "node:crypto";
import { clock } from "./config.js";
import * as passkey from "./passkey.js";

export const USE_PATH = "/web/login-use/";
/** How long the link may be tapped, and how long a yes stays good for the sign-in it was for. */
export const ASK_TTL_MS = 10 * 60_000;
export const YES_TTL_MS = 5 * 60_000;

// token -> { conversationId, loginId, site, nonce, challenge, state, createdAt, expiresAt, approvedAt }
const asks = new Map();

const sha = (s) => createHash("sha256").update(s).digest("base64url");
/** The challenge Face ID signs: this login, this site, this nonce (43 base64url chars). */
export const useChallenge = (loginId, site, nonce) => sha(`sl-use1|${loginId}|${site}|${nonce}`);

function sweep(now) {
  for (const [t, a] of asks) if (a.expiresAt <= now && a.state !== "approved") asks.delete(t);
  for (const [t, a] of asks) if (a.state === "approved" && a.approvedAt + YES_TTL_MS <= now) asks.delete(t);
}

/**
 * A fresh ask for one sign-in with one saved login. Any earlier ask for the same login is replaced, so
 * one link is open per login. → { token, link }.
 */
export function askFaceId(conversationId, loginId, site, { now = clock.now() } = {}) {
  const c = String(conversationId);
  sweep(now);
  for (const [t, a] of asks) if (a.conversationId === c && a.loginId === loginId) asks.delete(t);
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  asks.set(token, {
    conversationId: c, loginId, site: String(site), nonce, challenge: useChallenge(loginId, site, nonce),
    state: "open", createdAt: now, expiresAt: now + ASK_TTL_MS, approvedAt: 0,
  });
  return { token, link: `${passkey.ORIGIN()}${USE_PATH}${token}` };
}

/** What the page shows for a token: the site's name and whether it can still be approved. null: no such link. */
export function useView(token, { now = clock.now() } = {}) {
  const a = asks.get(String(token));
  if (!a) return null;
  const open = a.state === "open" && a.expiresAt > now;
  return {
    conversationId: a.conversationId, site: a.site, state: open ? "open" : a.state === "approved" ? "approved" : "ended",
    challenge: a.challenge, passkey: open ? passkey.loginAssertionOptions(a.conversationId) : null,
  };
}

/** The page's Face ID answer. → { ok } | { ok: false, error }. The assertion is checked, never kept. */
export async function approveUse(token, assertion, { now = clock.now(), verify = passkey.verifyLoginAssertion } = {}) {
  const a = asks.get(String(token));
  if (!a || a.state !== "open" || a.expiresAt <= now) return { ok: false, error: "link_ended" };
  const out = await verify(a.conversationId, a.challenge, assertion);
  if (!out?.ok) return { ok: false, error: out?.error ?? "not_verified" };
  if (a.state !== "open") return { ok: false, error: "link_ended" };
  a.state = "approved";
  a.approvedAt = now;
  return { ok: true, site: a.site };
}

/**
 * The filler's check before a careful or each-time sign-in: an approved, unused yes for this login,
 * given in the last few minutes. Consumed here, so one Face ID is one sign-in.
 */
export function takeApproval(conversationId, loginId, { now = clock.now() } = {}) {
  const c = String(conversationId);
  for (const [t, a] of asks) {
    if (a.conversationId !== c || a.loginId !== loginId || a.state !== "approved") continue;
    asks.delete(t);
    if (a.approvedAt + YES_TTL_MS > now) return true;
  }
  return false;
}

/** Drop every ask for a person (a login forgotten, or all their logins deleted). */
export function dropAsks(conversationId, loginId = null) {
  const c = String(conversationId);
  for (const [t, a] of asks) if (a.conversationId === c && (loginId == null || a.loginId === loginId)) asks.delete(t);
}

export function _resetAsks() { asks.clear(); }
