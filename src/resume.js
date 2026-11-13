// Reason carries on by itself once the person has done their part on a page it texted them
// (owner, 2026-11-13: "it should already know I did it and carry on, without me typing go ahead").
//
//   afterApproval   a Face ID yes for one saved-login sign-in (src/pages/loginuse.js): the job they
//                   asked for runs on, in their thread, and they are texted how it went.
//   afterSave       a login saved on Reason's page (src/pages/savelogin.js): a short confirmation, or,
//                   when the save link came in the middle of a job they asked for, that job runs on.
//
// The live-ask gate stays shut (src/filler.js: a saved login is used only for something the person
// asked for themselves; event turns are refused). The turn started here IS an event turn, and the only
// thing that lets its account_signin through is the grant on its ctx: a random id src/loginuse.js
// issued for that one approval or save, bound there to this person, this login and site and the
// request they typed when the link was made (trust.ownerTexts), good for the approval's lifetime and
// used once (takeResume). The grant never leaves the server: not in a link, not in a page, not in the
// thread. Nothing a web page or an email says can make or change one, because only these two calls,
// from the two pages' own POST handlers after a verified Face ID, start a resumed turn.
//
// No runtime (a test, a page served alone) or a runtime that is stopping: nothing starts, and the
// page says so, its button typing "done, go ahead" for them instead.

import { ownerTexts } from "./trust.js";
import { isBareYes, NAMED_WINDOW } from "./namedsite.js";

/**
 * The job a link is made for, in their own typed words (trust.ownerTexts: never an event line, a
 * PDF's or a photo's note, Reason's own text): their newest message that says something, within the
 * named-site window. Their bare "yes" to Reason's "Sign in to X for that?" is not the job; the
 * message it answered is (review 2026-11-13). Only a yes in the window: that yes.
 */
export function requestOf(messages = []) {
  const theirs = ownerTexts(Array.isArray(messages) ? messages : []).slice(-NAMED_WINDOW)
    .map((t) => t.split("\n").filter((l) => !l.trim().startsWith("[")).join(" ").trim()).filter(Boolean);
  for (let i = theirs.length - 1; i >= 0; i--) if (!isBareYes(theirs[i])) return theirs[i];
  return theirs.at(-1) ?? "";
}

/** The event line the resumed turn reads. Their request is quoted as their own words, on one line. */
export function approvedLine({ site, request }) {
  return `They approved signing in to ${site} with Face ID on Reason's page, for what they asked: "${request}". `
    + `Carry on with that job now: call account_signin for ${site}, then do what they asked and text them how it went. They don't need to say go ahead.`;
}
export function savedLine({ site, label, request }) {
  return `They just saved their ${label} login on Reason's page, after asking: "${request}". `
    + `Open with one short line that it's saved. If that request needs ${label}, carry on with it now (account_signin for ${site}) and text them how it went; if all they wanted was to save it, stop there.`;
}
/** The plain confirmation when there is no request to carry on with. Code's words, not the model's. */
export const savedNote = (label) => `Saved your ${label} login. It's locked away, and I'll sign in with it when a job you ask for needs it.`;

function canRun(runtime) {
  return !!runtime && typeof runtime.event === "function" && !runtime.stopping;
}

/**
 * The Face ID yes landed. `resume` is approveUse's (src/loginuse.js): { id, conversationId, site,
 * request }, or null when the ask carried no request. → true when the job was started.
 */
export function afterApproval(runtime, resume, { log = () => {} } = {}) {
  if (!resume?.id || !resume.request || !canRun(runtime)) return false;
  const c = resume.conversationId;
  Promise.resolve()
    .then(() => runtime.event(c, approvedLine(resume), {}, { resumeSignin: resume.id }))
    .catch((e) => log({ login_use: "resume", ok: false, error: e?.code ?? e?.name ?? "error" }));
  log({ login_use: "resume", ok: true });
  return true;
}

/**
 * A login was saved. `grant` is grantAfterSave's id ("" when the link carried no request).
 * → "resumed" (a turn carries on with their request), "told" (the confirmation was texted), or "".
 */
export function afterSave(runtime, { conversationId, site, label, request = "", grant = "" }, { log = () => {} } = {}) {
  if (!runtime || runtime.stopping) return "";
  const name = String(label || site);
  if (grant && request && canRun(runtime)) {
    Promise.resolve()
      .then(() => runtime.event(conversationId, savedLine({ site, label: name, request }), {}, { resumeSignin: grant }))
      .catch((e) => log({ save_login: "resume", ok: false, error: e?.code ?? e?.name ?? "error" }));
    log({ save_login: "resume", ok: true });
    return "resumed";
  }
  const tell = typeof runtime._tell === "function" ? (t) => runtime._tell(conversationId, t, { idempotencyKey: `login-saved:${conversationId}:${site}:${Date.now()}` })
    : typeof runtime.say === "function" ? (t) => runtime.say(conversationId, t) : null;
  if (!tell) return "";
  Promise.resolve().then(() => tell(savedNote(name))).catch((e) => log({ save_login: "told", ok: false, error: e?.code ?? e?.name ?? "error" }));
  return "told";
}
