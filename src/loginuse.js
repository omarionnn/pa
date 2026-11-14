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

// token -> { conversationId, loginId, site, nonce, challenge, state, createdAt, expiresAt, approvedAt,
//            request, resumeId }
const asks = new Map();
// After a save (src/pages/savelogin.js): id -> { conversationId, site, request, expiresAt }. No approval
// in it: a saved login's first use is still subject to Face ID when it is careful or "each time".
const saves = new Map();
/** How long their own request may be quoted on the page and carried into the resumed job. */
const REQUEST_MAX = 400;
const cleanRequest = (t) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, REQUEST_MAX);

const sha = (s) => createHash("sha256").update(s).digest("base64url");
/** The challenge Face ID signs: this login, this site, this nonce (43 base64url chars). */
export const useChallenge = (loginId, site, nonce) => sha(`sl-use1|${loginId}|${site}|${nonce}`);

function sweep(now) {
  for (const [id, g] of saves) if (g.expiresAt <= now) saves.delete(id);
  for (const [t, a] of asks) if (a.expiresAt <= now && a.state !== "approved") asks.delete(t);
  for (const [t, a] of asks) if (a.state === "approved" && a.approvedAt + YES_TTL_MS <= now) asks.delete(t);
}

/**
 * A fresh ask for one sign-in with one saved login. Any earlier ask for the same login is replaced, so
 * one link is open per login. → { token, link }.
 *
 * `request` is what the person asked for, in their own typed words (src/filler.js reads it with
 * trust.ownerTexts off the live turn that made this ask). It is kept with the ask so that, when the
 * Face ID yes lands, Reason can carry on with that exact job by itself (takeResume). Nothing a page,
 * an email or the model says can set it: only the filler's live-ask path calls this.
 */
export function askFaceId(conversationId, loginId, site, { now = clock.now(), request = "", via = "", google = false } = {}) {
  const c = String(conversationId);
  sweep(now);
  for (const [t, a] of asks) if (a.conversationId === c && a.loginId === loginId) asks.delete(t);
  const token = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  asks.set(token, {
    conversationId: c, loginId, site: String(site), nonce, challenge: useChallenge(loginId, site, nonce),
    state: "open", createdAt: now, expiresAt: now + ASK_TTL_MS, approvedAt: 0,
    request: cleanRequest(request), resumeId: "",
    // The thread the link was sent in: "web" (a web chat) or "phone" (their text thread). Back to Messages follows it.
    via: via === "web" ? "web" : via === "phone" ? "phone" : "",
    // The Continue-with-Google route (src/federated.js): the login is the Google one, the site is the one they named.
    google: google === true,
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
    request: a.request, resumed: !!a.resumeId, via: a.via ?? "", google: a.google === true,
    challenge: a.challenge, passkey: open ? passkey.loginAssertionOptions(a.conversationId) : null,
  };
}

/**
 * The page's Face ID answer. → { ok, site, resume } | { ok: false, error }. The assertion is checked,
 * never kept. `resume` (when the ask carried their request): { id, conversationId, site, request }, a
 * fresh random id that only takeResume accepts, for this one approval, once, while the yes is good.
 */
export async function approveUse(token, assertion, { now = clock.now(), verify = passkey.verifyLoginAssertion } = {}) {
  const a = asks.get(String(token));
  if (!a || a.state !== "open" || a.expiresAt <= now) return { ok: false, error: "link_ended" };
  const out = await verify(a.conversationId, a.challenge, assertion);
  if (!out?.ok) return { ok: false, error: out?.error ?? "not_verified" };
  if (a.state !== "open") return { ok: false, error: "link_ended" };
  a.state = "approved";
  a.approvedAt = now;
  if (!a.request) return { ok: true, site: a.site, resume: null };
  a.resumeId = randomBytes(18).toString("base64url");
  return { ok: true, site: a.site, resume: { id: a.resumeId, conversationId: a.conversationId, site: a.site, request: a.request } };
}

/**
 * After a login is saved on Reason's page in the middle of a job they asked for: a one-use grant to
 * carry on with that job, bound to this person, this site and their own request (the save link's
 * quoted request, read with trust.ownerTexts when the link was made). Good for YES_TTL_MS. → id.
 */
export function grantAfterSave(conversationId, site, request, { now = clock.now() } = {}) {
  sweep(now);
  const words = cleanRequest(request);
  if (!words || !site) return "";
  const id = randomBytes(18).toString("base64url");
  saves.set(id, { conversationId: String(conversationId), site: String(site), request: words, expiresAt: now + YES_TTL_MS });
  return id;
}

/**
 * The resumed job's sign-in (src/filler.js, on the event turn the approval or the save started): the
 * grant `id` must be one this file issued, for this person, for this exact login and site, still in its
 * lifetime, and not used. Consumed here either way it matches. → { kind: "approved" | "saved", request }
 * or null. "approved" carries the Face ID yes itself (the approval is used up with it: one yes is one
 * sign-in); "saved" lets the job past the live-ask gate only, so a careful or "each time" login still
 * asks for Face ID.
 */
export function takeResume(conversationId, id, { loginId, site, savedSite = "" } = {}, { now = clock.now() } = {}) {
  const c = String(conversationId);
  const want = String(id ?? "");
  if (!want) return null;
  for (const [t, a] of asks) {
    if (a.resumeId !== want) continue;
    if (a.conversationId !== c || a.loginId !== loginId || a.site !== String(site) || a.state !== "approved") return null;
    asks.delete(t);
    if (a.approvedAt + YES_TTL_MS <= now) return null;
    spent.set(`${c}\n${loginId}`, now);
    spent.set(`${c}\n${loginId}\n${String(site)}`, now);
    return { kind: "approved", request: a.request };
  }
  const g = saves.get(want);
  if (!g || g.conversationId !== c || (g.site !== String(savedSite) && g.site !== String(site))) return null;
  saves.delete(want);
  return g.expiresAt > now ? { kind: "saved", request: g.request } : null;
}

/**
 * The filler's check before a careful or each-time sign-in: an approved, unused yes for this login,
 * given in the last few minutes. Consumed here, so one Face ID is one sign-in.
 */
export function takeApproval(conversationId, loginId, { now = clock.now(), site = null } = {}) {
  const c = String(conversationId);
  for (const [t, a] of asks) {
    if (a.conversationId !== c || a.loginId !== loginId || a.state !== "approved") continue;
    // One Google login serves many sites (src/federated.js): its yes is for the one site it named.
    if (site != null && a.site !== String(site)) continue;
    asks.delete(t);
    if (a.approvedAt + YES_TTL_MS > now) { spent.set(`${c}\n${loginId}`, now); if (site != null) spent.set(`${c}\n${loginId}\n${site}`, now); return true; }
  }
  return false;
}

// When a Face ID yes for a login was last spent (a sign-in went ahead on it), per person and login.
const spent = new Map();
/** How long after a Face ID yes was spent a bare "go ahead" for the same login is the same job, not a new one. */
export const SPENT_QUIET_MS = 10 * 60_000;

/**
 * Where this login's Face ID stands, without using anything up (src/filler.js, before the named-site
 * check): "approved" — a yes for this exact login, unused and in its lifetime; "waiting" — a link was
 * sent and not answered yet; "just_used" — a yes for it was spent in the last few minutes (the job is
 * already going); or "".
 */
export function faceIdState(conversationId, loginId, { now = clock.now(), site = null } = {}) {
  const c = String(conversationId);
  let waiting = false;
  for (const a of asks.values()) {
    if (a.conversationId !== c || a.loginId !== loginId) continue;
    if (site != null && a.site !== String(site)) continue;
    if (a.state === "approved" && a.approvedAt + YES_TTL_MS > now) return "approved";
    if (a.state === "open" && a.expiresAt > now) waiting = true;
  }
  if (waiting) return "waiting";
  const at = spent.get(site != null ? `${c}\n${loginId}\n${site}` : `${c}\n${loginId}`);
  return at != null && now - at < SPENT_QUIET_MS ? "just_used" : "";
}

/** Drop every ask for a person (a login forgotten, or all their logins deleted). */
/**
 * A sign-in to one of `sites` is going ahead (src/filler.js, past every gate): any save grant for those
 * sites is spent with it. One save carries on one job once, whichever turn gets there first.
 */
export function spendSaveGrants(conversationId, sites = []) {
  const c = String(conversationId);
  const want = new Set(sites.filter(Boolean).map(String));
  for (const [id, g] of saves) if (g.conversationId === c && want.has(g.site)) saves.delete(id);
}

export function dropAsks(conversationId, loginId = null) {
  const c = String(conversationId);
  for (const [t, a] of asks) if (a.conversationId === c && (loginId == null || a.loginId === loginId)) asks.delete(t);
  if (loginId == null) for (const [id, g] of saves) if (g.conversationId === c) saves.delete(id);
}

export function _resetAsks() { asks.clear(); saves.clear(); spent.clear(); }
