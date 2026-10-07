// Before calling a number again: did this already happen?
//
// The owner's rule, 2026-10-06: "After a dropped call, check what already happened before calling
// again. Never book twice or leave repeated voicemails. The calls table / sheet must carry enough
// state to answer 'did the booking already go through' before any redial."
//
// The case this file is written for is one specific sequence, and it is worth spelling out because the
// wrong behaviour is the obvious one:
//
//   The call reaches a person. The person says "yes, you're booked for Saturday at eight." The line
//   drops before anything is read back or any reference is given.
//
// The obvious next action is to call back and book it. That is how somebody ends up with two tables,
// two charges and a restaurant that thinks they are being messed about. The honest state is "it may or
// may not have gone through", and the only safe next call is a DIFFERENT call: one that asks whether
// it exists and changes nothing. That is `askWhetherItWentThrough` in ./brief.js, and the `redial:
// "ask"` mode in ./outcome.js is what routes to it.
//
// Everything here reads rows. Nothing asks a model whether it thinks it already called — a model
// looking at its own transcript is the least reliable possible source for "did I already do this",
// and the rows are right there.
import { config } from "../config.js";
import * as db from "../db.js";
import { OUTCOMES, redialMode } from "./outcome.js";
import { askWhetherItWentThrough } from "./brief.js";

/**
 * May this number be called again for this errand, and to do what?
 *
 * Returns one of three shapes, and the middle one is the one that matters:
 *
 *   `{ok: true, mode: "retry"}`  — go again with the same goal. Nobody answered, or the line was too
 *                                  bad to settle anything.
 *   `{ok: true, mode: "ask"}`    — go again, but ONLY to find out what happened, with booking off.
 *                                  `brief` comes back rewritten for that; use it rather than the
 *                                  original, which is the whole point.
 *   `{ok: false, error}`         — do not call. Something is already agreed, a message is already
 *                                  sitting in their voicemail, or this number has had its attempts.
 */
export function safeToRedial(conversationId, { toNumber, errandId = null, brief = null, now = Date.now() } = {}) {
  const number = String(toNumber ?? "").trim();
  if (!number) return { ok: false, error: "There is no number to call." };

  // Anything already agreed at this number, on ANY errand. Deliberately unscoped: the question is
  // about the number and the thing, and a check that only looked at its own errand would miss the
  // booking made by the call before the one that dropped.
  const committed = db.commitmentsAtNumber(conversationId, number).filter(m => m.state === "committed");
  if (committed.length) {
    const m = committed.at(-1);
    return {
      ok: false, alreadyDone: true, commitment: m,
      error: `That is already arranged at this number — "${m.what}"${m.reference ? `, reference ${m.reference}` : ""}.`
        + ` Do not call to do it again. If something about it needs changing, that is a different call with a different goal,`
        + ` and say out loud that it already exists.`,
    };
  }

  const history = db.callsToNumber(conversationId, { errandId, toNumber: number });
  if (!history.length) return { ok: true, mode: "first", attempt: 1 };

  // A message already in their voicemail. His rule, and it is per number rather than per errand: a
  // second recorded message from the same assistant is the thing that makes a person stop answering.
  const voicemails = history.filter(k => Number(k.voicemail_left) === 1 || k.outcome_kind === "voicemail_left");
  if (voicemails.length) {
    return {
      ok: false, voicemailAlready: true,
      error: `A message has already been left on this number. Do not ring back to leave another — they have it,`
        + ` and a second one is worse than none. Wait for them to call back, or say out loud that you are waiting.`,
    };
  }

  const last = history.at(-1);
  const mode = redialMode(last.outcome_kind);
  if (mode === "no") {
    return {
      ok: false, settled: true,
      error: `The last call to this number ended as "${OUTCOMES[last.outcome_kind]?.label ?? last.outcome_kind}", which is not`
        + ` something to try again. Say where it got to rather than calling them back.`,
    };
  }

  // The attempt limit. Counted on finished attempts at this number for this errand, so a call still
  // ringing does not use one up and a crashed row does not block the number forever.
  const attempts = history.length;
  const limit = Math.max(1, config.callMaxRetries + 1);
  if (attempts >= limit) {
    return {
      ok: false, outOfTries: true, attempts,
      error: `This number has been tried ${attempts} time(s), which is the limit on this install`
        + ` (${config.callMaxRetries} retr${config.callMaxRetries === 1 ? "y" : "ies"}, REASON_CALL_MAX_RETRIES).`
        + ` Do not keep ringing them. Say that you tried ${attempts} times and got nowhere, and offer another way.`,
    };
  }

  if (mode === "ask") {
    // The important rewrite. Booking is off, the goal is now "find out whether this exists", and it is
    // built from the brief the dropped call was placed under rather than from anything remembered.
    const original = brief ?? safeBrief(last);
    return {
      ok: true, mode: "ask", attempt: attempts + 1,
      brief: askWhetherItWentThrough(original, { what: original?.goal || last.goal }),
      why: `The last call dropped before it was confirmed, so this one only checks whether it went through.`
        + ` It is not allowed to book anything.`,
      note: `Open by saying you are ringing to check on something, not to make a new one.`,
    };
  }

  return { ok: true, mode: "retry", attempt: attempts + 1, brief: brief ?? safeBrief(last) };
}

/**
 * Whether anything on this errand is still waiting on somebody, in words.
 *
 * Read before an errand is called finished, so "two never answered" is in the summary rather than
 * quietly dropped — the same no-false-progress rule as everywhere else: what did not happen is said.
 */
export function stillOpen(conversationId, errandId) {
  const calls = db.errandCalls(conversationId, errandId);
  const waiting = calls.filter(k => ["voicemail_left"].includes(k.outcome_kind));
  const retryable = calls.filter(k => redialMode(k.outcome_kind) === "retry");
  const unknown = calls.filter(k => k.outcome_kind === "dropped_before_confirmation");
  return {
    waitingOnCallback: waiting.map(k => k.to_number),
    couldTryAgain: retryable.map(k => k.to_number),
    // The ones where nobody knows. Named separately because they are the only kind that needs a call
    // to find out rather than a call to try again, and conflating them is how a double booking happens.
    needChecking: unknown.map(k => k.to_number),
  };
}

/** The brief a call was placed under, when the row has one. */
function safeBrief(call) {
  try {
    const b = JSON.parse(call?.brief ?? "{}");
    return b && typeof b === "object" && b.goal ? b : null;
  } catch { return null; }
}
