// Retry, don't offer.
//
// A read-only lookup that failed for a passing reason (a timeout, a 5xx, DNS, a provider not
// answering) is tried again here, in code, a bounded number of times inside a time cap, and only
// then reported. When every try failed, the result says so and a single re-check is set (a timer,
// once) whose answer is texted to them, so the reply states what happened and what Reason WILL do:
// never "want me to try again?".
//
// Never retried here, whatever the error says: anything that spends money or could act twice
// (purchases, bookings, rides, payments, sends to anyone, calls), any sign-in (one refusal stops:
// a wrong password, a refused sign-in or a bot wall is never tried again), and anything they said no
// to. Only the tools in RETRY_TOOLS are wrapped, and a failure that reads as a refusal is not
// transient even there.
//
// The reply check (`offerNote`) is code's, not a model's: a draft whose next step is an offer to try
// again after a failed attempt is sent back through the existing one rewrite (src/runtime.js), with
// a note that says to re-run the step now (safe class, tries left) or to state the outcome and the
// re-check. A must-not failure only ever gets "state it plainly": no retry. No extra model call: the
// rewrite is the one that stage already makes.

import * as db from "./db.js";
import { clock } from "./config.js";

/** Read-only lookups: safe to run again with the same input. Nothing here sends, buys, books or signs in. */
export const RETRY_TOOLS = new Set([
  "web_search", "web_lookup", "image_search", "find_all",
  "weather", "nearby_places", "transit_status",
  "gmail_search", "gmail_read", "gmail_labels",
  "calendar_events", "calendar_event", "apple_calendar_events", "apple_calendar_event",
  "drive_search", "drive_read",
]);

/** Errors worth one more try: the service did not answer, or answered with a server-side failure. */
const TRANSIENT_RE = /\btim(?:ed|e)[ -]?out\b|did not answer|didn'?t answer|not answering|no answer|\btimeout\b|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang ?up|fetch failed|network (?:error|is unreachable)|could not reach|couldn'?t reach|unreachable|\b50[0-4]\b|\bHTTP 5\d\d\b|answered 5\d\d|returned 5\d\d|service unavailable|bad gateway|temporar(?:il)?y|overloaded|did not load|didn'?t load|aborted/i;
/** A refusal, a limit or a wall: never transient, so never retried (a security rule; never loosen it). */
const NEVER_RE = /captcha|bot (?:check|wall|detect)|blocked|refused|password|declined|denied|forbidden|unauthori[sz]ed|\b40[13]\b|rate[- ]?limit|too many|\b429\b|not connected|not_connected|reconnect|sign(?:ed)?[- ]?in|said no|turned down|not allowed|consent/i;

const errorText = (out) => {
  if (out == null) return "no result";
  if (typeof out !== "object") return "";
  return [out.error, out.status, out.blocked, out.why, out.reason].filter(v => typeof v === "string").join(" ");
};
const failed = (out) => out == null || (typeof out === "object" && (out.ok === false || (!!out.error && out.ok !== true)));

/** Is this a failure worth another try: failed, and its words say the service did not answer rather than said no? */
export function isTransient(out) {
  if (!failed(out)) return false;
  if (out && (out.status === "not_connected" || out.status === "rate_limited" || out.retry_after_s)) return false;
  const why = errorText(out);
  if (!why) return out == null;
  if (NEVER_RE.test(why)) return false;
  return TRANSIENT_RE.test(why);
}

/** The pauses before the 2nd and 3rd try (ms), each jittered ±25%. */
export const PAUSES_MS = [400, 1_500];
export const ATTEMPTS = 3;
/** Total time cap: on a text the whole lookup, all tries, stays under this; on a call far less. */
export const CAP_MS = 25_000;
/** On a call: GPT-Live gives a tool 8 s (src/calls/voice.js CALL_TOOL_BUDGET_MS); Cartesia's ask waits 25 s for the whole turn. */
export const CALL_CAP_MS = 6_000;

const realSleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * Run `run` until it works, fails for a reason that is not transient, or the tries / time run out.
 * The next try only starts if the pause plus as long as the last try took still fits in `capMs`, so
 * a 20 s timeout is never followed by another 20 s on a call. Returns `{ out, tries }`.
 */
export async function retryTransient(run, { attempts = ATTEMPTS, pausesMs = PAUSES_MS, capMs = CAP_MS, sleep = realSleep, now = () => Date.now(), random = Math.random } = {}) {
  const t0 = now();
  let tries = 0;
  let out;
  for (;;) {
    const started = now();
    try { out = await run(tries); } catch (e) { out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    tries++;
    if (tries >= attempts || !isTransient(out)) break;
    const took = now() - started;
    const pause = Math.round((pausesMs[tries - 1] ?? pausesMs[pausesMs.length - 1] ?? 0) * (0.75 + random() * 0.5));
    if (now() - t0 + pause + took > capMs) break;
    await sleep(pause);
  }
  return { out, tries };
}

// ---------- when every try failed: one re-check, by timer ----------

export const RECHECK_LABEL = "recheck:lookup";
export const RECHECK_MS = 10 * 60_000;
const NOTE_HEAD = "Re-check, once:";

const WHAT = {
  web_search: "The search", web_lookup: "That page", image_search: "The image search", find_all: "The search",
  weather: "The weather service", nearby_places: "The places lookup", transit_status: "The transit feed",
  gmail_search: "Gmail", gmail_read: "Gmail", gmail_labels: "Gmail",
  calendar_events: "Google Calendar", calendar_event: "Google Calendar", apple_calendar_events: "Apple Calendar", apple_calendar_event: "Apple Calendar",
  drive_search: "Google Drive", drive_read: "Google Drive",
};
export const whatOf = (name) => WHAT[name] ?? "That lookup";

const inputLine = (input) => { try { return JSON.stringify(input ?? {}).slice(0, 300); } catch { return "{}"; } };

/** The pending re-check for this tool in this conversation, if one is set. */
function pendingRecheck(conversationId, name) {
  return db.pendingLabelledTimers(conversationId, RECHECK_LABEL).find(t => String(t.note ?? "").startsWith(`${NOTE_HEAD} ${name} `)) ?? null;
}

/**
 * Set the one re-check for a lookup whose every try failed: a timer that runs the same lookup in
 * RECHECK_MS and texts the answer. Never from a re-check's own firing (once means once), never twice
 * for the same tool while one is pending. Returns the timer row, or null when none was set.
 */
export function scheduleRecheck({ conversationId, name, input, error, fromTimer = null, now = clock.now() }) {
  try {
    if (!conversationId || !RETRY_TOOLS.has(String(name))) return null;
    if (fromTimer != null && db.getTimer(conversationId, fromTimer)?.label === RECHECK_LABEL) return null;
    if (pendingRecheck(conversationId, name)) return null;
    const note = `${NOTE_HEAD} ${name} ${inputLine(input)} failed earlier (${String(error ?? "no answer").slice(0, 160)}) and you told them you would check again and text them.`
      + ` Run ${name} again now with that same input. If it works, text them the answer in one or two lines, saying what it is about.`
      + ` If it still fails, text ONE line saying it is still not answering and what they can use instead, if anything. Never offer to try again, and set no further re-check.`;
    return db.createTimer(conversationId, { fireAt: now + RECHECK_MS, note: note.slice(0, 1_000), label: RECHECK_LABEL });
  } catch { return null; }
}

/** The pending re-check row for this tool, or null. */
export function hasRecheck(conversationId, name) {
  try { return pendingRecheck(conversationId, name); } catch { return null; }
}

/** The same lookup worked after all (the model reworded it, or the next call got through): the re-check is not needed. */
export function cancelRecheck(conversationId, name, { fromTimer = null } = {}) {
  try {
    const t = conversationId ? pendingRecheck(conversationId, name) : null;
    // The re-check's own firing is not cancelled from inside it.
    if (t && fromTimer != null && Number(t.id) === Number(fromTimer)) return false;
    if (t) db.cancelTimer(conversationId, t.id);
    return !!t;
  } catch { return false; }
}

/**
 * The words on a lookup whose tries all failed: what happened and what Reason WILL do. Never an offer.
 * `recheck`: the timer row when one was set. `onCall`: said on a call, so the answer comes by text.
 */
export function exhaustedNote({ name, tries, recheck = null, onCall = false }) {
  const what = whatOf(name);
  const tried = `${what} isn't answering right now (${tries} ${tries === 1 ? "try" : "tries"}).`;
  if (recheck) return `${tried} A re-check is already set for ${Math.round(RECHECK_MS / 60_000)} minutes from now and its answer will be texted to them. ${onCall ? "Say in one short sentence that you'll text them the answer when you have it." : `Say exactly that in one line, e.g. "${what} isn't answering right now. I'll check again in 10 minutes and text you."`} Never offer to try again, and never ask if they want you to.`;
  return `${tried} Say plainly that you couldn't get it and what you need from them or what they can use instead. Never offer to try again, and never ask if they want you to.`;
}

// ---------- the reply check: an offer to try again, after a failed attempt ----------

// "if you want, I can try again", "want me to try again?", "let me know if you'd like me to…",
// "I can try again in a bit", "shall I give it another go?". The offer, not a genuine choice.
const OFFER_RE = /\b(?:if you(?:'d)? (?:want|like)(?: me to)?,? (?:i can |i could |i'?ll )?(?:try|retry|check|look|give it|have another|run it)|(?:do you )?want me to (?:try|retry|check again|look again|give it another|have another|run it again)|(?:should|shall) i (?:try|retry|check again|look again|give it another)|let me know if you(?:'d)? (?:want|like) me to|i can (?:try|retry|check) (?:again|it again|that again|later|in a (?:bit|minute|few))|i could (?:try|check) (?:again|later)|happy to (?:try|check) again|(?:can|could) try again (?:later|in a bit)|try again (?:later|in a bit)\?)/i;

const sentences = (text) => String(text ?? "").split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

/** The sentences of a draft that offer to try again. Exported for the tests. */
export function offersInDraft(draft) {
  return sentences(draft).filter(s => OFFER_RE.test(s));
}

/**
 * What to do with a draft that offers to try again after a failed attempt, or null when it doesn't.
 * Only a draft with such an offer AND a tool that did not work this turn: an offer with nothing
 * failed is not this check's, and a question that needs their choice ("which of these two?") is not
 * an offer at all.
 *   - `{ note }`: a safe lookup with tries left: the one rewrite (src/runtime.js) runs it again.
 *   - `{ text }`: every try made, or a must-not failure (money, a send, a call, a sign-in, a
 *     refusal): code takes the offer out, and says the re-check when one is set. No model call,
 *     and nothing is run again.
 * `acts`: the turn's tool record (src/said.js noteAct), which carries each lookup's `tries`.
 */
export function fixOffer({ draft, acts = [], conversationId = null } = {}) {
  const text = String(draft ?? "");
  const offers = offersInDraft(text);
  if (!offers.length || !Array.isArray(acts)) return null;
  const failedActs = acts.filter(a => a && a.ok === false);
  if (!failedActs.length) return null;
  const last = failedActs[failedActs.length - 1];
  const name = String(last.name);
  const safe = RETRY_TOOLS.has(name) && !NEVER_RE.test(String(last.result ?? ""));
  const quote = offers[0].length > 140 ? `${offers[0].slice(0, 139)}…` : offers[0];
  if (safe && !(Number(last.tries) >= ATTEMPTS)) {
    return {
      kind: "rerun", tool: name,
      note: `It ends on an offer ("${quote}") after ${name} failed. Don't offer: run ${name} again yourself now, or the next sensible route (other words, the site's own page, the link from their mail), then answer with what it gives.`
        + ` If that fails too, say in one line what happened and what you will do; never ask if they want you to.`,
    };
  }
  let out = text;
  for (const o of offers) out = out.replace(o, "");
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();
  const recheck = safe && conversationId ? hasRecheck(conversationId, name) : null;
  if (recheck) out = `${out}${out && !/[.!?]$/.test(out) ? "." : ""} I'll check again in ${Math.round(RECHECK_MS / 60_000)} minutes and text you.`.trim();
  if (!out) return null;
  return { kind: safe ? "stated_with_recheck" : "stated", tool: name, text: out };
}

/**
 * A call's answer (Cartesia's ask_reason, src/calls/cartesia.js): spoken as-is unless it offers to
 * try again. Then the offer comes out, and when a re-check is set for this conversation the line
 * says the answer will come by text (the re-check timer texts it). No model call.
 */
export function callLine(text, conversationId = null) {
  const said = String(text ?? "");
  const offers = offersInDraft(said);
  if (!offers.length) return said;
  let out = said;
  for (const o of offers) out = out.replace(o, "");
  out = out.replace(/ {2,}/g, " ").trim();
  let pending = false;
  try { pending = !!conversationId && db.pendingLabelledTimers(conversationId, RECHECK_LABEL).length > 0; } catch { /* stated plainly then */ }
  if (pending) out = `${out}${out && !/[.!?]$/.test(out) ? "." : ""} I'll text you the answer when I have it.`.trim();
  return out || "I couldn't get that just now.";
}
