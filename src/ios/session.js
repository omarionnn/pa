// The iPhone app's sign-in: the texted-code sign-in Reason Web already has, with a bearer token instead
// of a cookie. The code, its limits and the session row are all the Web ones (`wsign:` codes, the wrong-try
// ceilings in src/events.js, `page_sessions`), so a session is listed and revocable from Web Settings too.
//
// What is different is only what a native client needs:
//   - no form cookie, so a code is bound to a random `challenge` the app makes and sends on both calls;
//   - sessions are marked `client = 'ios'`, and only those open this API, so a browser cookie is not a token;
//   - a session lasts a flat 90 days, however long it sits unused (owner 11-09). Web keeps its 30-day idle limit.
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as events from "../events.js";
import { config } from "../config.js";
import { requestCode, codeHost, boundTo, SESSION_TTL_MS, CODE_TTL_MS } from "../pages/access.js";
import { accountForNumber, signinKey, webUrl } from "../pages/websignin.js";
import { eventActor } from "../pages/event.js";

export const IOS_CLIENT = "ios";
export { SESSION_TTL_MS, CODE_TTL_MS };

/** May THIS conversation use the app API? Asked with the conversation the session resolved to, never one the client named. */
export function iosAllowedFor(conversationId) {
  if (!conversationId) return false;
  if (config.iosApi === "owner") return accounts.featureOwner(conversationId);
  return config.iosApi === true;
}

const CHALLENGE = /^[A-Za-z0-9_-]{32,128}$/;
export const validChallenge = (c) => CHALLENGE.test(String(c ?? ""));
const bindingOf = (challenge) => events.signinBinding(`ios:${challenge}`);

function appCodeLine(code) {
  const mins = Math.round(CODE_TTL_MS / 60000);
  return `Your Reason code is ${code}, to sign in to the Reason app. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was shown.${boundTo(codeHost(webUrl()), code)}`;
}

/**
 * Ask for a code. One answer for every number, and the text is not awaited, so nothing here says which
 * numbers use Reason. Only this device's own hourly limit can be refused out loud.
 */
export function askForCode({ phone, challenge, headers, remoteAddress, runtime, log = () => {} }) {
  const actor = eventActor(headers, remoteAddress);
  if (!events.signinGate(actor)) return { ok: false, reason: "rate_limited" };
  events.noteSigninRequest(actor);
  const who = accountForNumber(String(phone ?? "").slice(0, 254), { allowed: iosAllowedFor });
  if (!who) return { ok: true };
  const asked = requestCode({ id: signinKey(who.conversation_id), title: "Reason" }, { host: "", bound: bindingOf(challenge) });
  if (!asked.ok) { log({ ios_signin_code_refused: asked.reason }); return { ok: true }; }
  if (runtime?._tell) {
    Promise.resolve(runtime._tell(who.conversation_id, appCodeLine(asked.code), { idempotencyKey: `wsign:${who.conversation_id}:${asked.id}` }))
      .then(r => log({ ios_signin_code_sent: true, ok: !!(r?.ok || r?.queued) }))
      .catch(e => log({ ios_signin_code_sent: true, ok: false, why: (e?.message ?? String(e)).split("\n")[0] }));
  }
  return { ok: true };
}

/** Trade a code for a device session. Every miss is the same miss. */
export function verifyCode({ phone, challenge, code, deviceName, headers, remoteAddress, log = () => {} }) {
  const actor = eventActor(headers, remoteAddress);
  const who = accountForNumber(String(phone ?? "").slice(0, 254), { allowed: iosAllowedFor });
  const tried = events.tryKeyedCode({
    conversationId: who?.conversation_id ?? null, code, personKey: who ? signinKey(who.conversation_id) : null,
    browserKey: `iosb:${actor}`, bound: bindingOf(challenge),
  });
  if (!tried.ok) { log({ ios_signin_failed: tried.reason }); return { ok: false, reason: tried.reason }; }
  db.setPageSessionClient(tried.token, IOS_CLIENT);
  const label = String(deviceName ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  db.notePageSessionAgent(tried.token, `Reason iOS${label ? ` · ${label}` : ""}`);
  log({ ios_signin_ok: true });
  return { ok: true, token: tried.token, account: who };
}

export function bearerOf(headers = {}) {
  return /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(headers.authorization ?? ""))?.[1] ?? null;
}

/** Whose device this is, per request, from the token alone. Null for anything else. */
export function iosAccount(headers) {
  const token = bearerOf(headers);
  if (!token || db.pageSessionClient(token) !== IOS_CLIENT) return null;
  const owner = db.pageSessionOwner(token, SESSION_TTL_MS);
  const account = owner ? db.getAccount(owner) : null;
  if (!account || !iosAllowedFor(account.conversation_id)) return null;
  if (!accounts.admit({ channel: account.channel, address: account.address }).allow) return null;
  return { account, token };
}

/** This person's app sessions. `id` is the stored key: a hash, never the token. */
export function devicesOf(conversationId, currentToken) {
  const here = db.pageSessionKey(currentToken);
  return db.pageSessionsFor(conversationId, { maxAgeMs: SESSION_TTL_MS })
    .filter(r => db.pageSessionClientByKey(r.token) === IOS_CLIENT)
    .map(r => ({ id: r.token, name: String(r.user_agent ?? "").replace(/^Reason iOS(?: · )?/, "") || null, created_at: r.created_at, last_seen_at: r.last_seen_at, current: r.token === here }));
}
