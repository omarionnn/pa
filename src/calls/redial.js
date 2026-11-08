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
import { config, clock } from "../config.js";
import * as db from "../db.js";
import { OUTCOMES, redialMode, theySpoke } from "./outcome.js";
import { askWhetherItWentThrough } from "./brief.js";
import * as commit from "./commit.js";

/**
 * How far back "calling again" reaches. The retry limit and the one-voicemail rule are about ringing
 * the same person over and over for the same thing — a run of attempts, not a lifetime. A friend rung
 * on Sunday and again on Thursday is not being redialled; without this window the second call to any
 * contact inherited the first one's errand (2026-11-05, Yaw: Thursday's new message went out as
 * Sunday's Man U script) and a third call was refused as "out of tries" for good.
 * Something that may already be agreed at the number is NOT windowed: that is a fact about them.
 */
export const REDIAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Could this call have agreed to anything? Only then can a dropped line have left something half-done. */
function couldCommit(call) {
  const b = safeBrief(call);
  return b?.approved?.book === true;
}

/** Could a booking have been left half-done on this call? Cleared to book and somebody (or something) spoke, or any commitment. */
function mayHaveBooked(conversationId, call) {
  if (couldCommit(call) && theySpoke(call.transcript) === true) return true;
  return db.callCommitments(conversationId, call.id).length > 0;
}

/**
 * May this number be called again for this errand, and to do what?
 *
 * Returns one of three shapes, and the middle one is the one that matters:
 *
 *   `{ok: true, mode: "retry"}`  — go again. Nobody answered, or the line was too bad to settle
 *                                  anything. No brief comes back: the call carries what it was asked
 *                                  to carry NOW, never the old call's script.
 *   `{ok: true, mode: "ask"}`    — go again, but first find out what happened, with booking off.
 *                                  `brief` comes back rewritten for that, carrying the new call's
 *                                  purpose (`brief` passed in) after the check; use it rather than
 *                                  the new one, which is the whole point.
 *   `{ok: false, error}`         — do not call. Something is already agreed, a message is already
 *                                  sitting in their voicemail, or this number has had its attempts.
 */
export function safeToRedial(conversationId, { toNumber, errandId = null, brief = null, now = clock.now() } = {}) {
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

  // Something that MIGHT be agreed there, because a call ended before anyone found out. Not the
  // same as `committed` above and not the same as nothing: the honest second call is one that goes
  // to ask what happened with booking switched off, which is the `ask` mode this function already
  // has. The alternative is the duplicate commitment the release gates block on — a line that drops
  // right after "that's booked for Saturday", rung again, booking the same table twice.
  const maybe = commit.unresolvedAt(conversationId, number);
  if (maybe.length) {
    const m = maybe.at(-1);
    const original = safeBrief(db.callsToNumber(conversationId, { errandId, toNumber: number }).at(-1)) ?? brief;
    return {
      ok: true, mode: "ask", unresolved: m,
      brief: askWhetherItWentThrough(original, { what: m.what || original?.goal || "", then: brief }),
      why: `A call to this number ended before anybody knew whether "${m.what}" went through, so it may already`
        + ` exist. Ring them ONLY to find out: ask whether it is on their book under the name, and do not agree`
        + ` to anything, book anything or offer to. If it is there, that is the answer; if it is not, say so and`
        + ` come back rather than making it.`,
    };
  }

  // Only the recent run of calls counts as "again" (REDIAL_WINDOW_MS above).
  const history = db.callsToNumber(conversationId, { errandId, toNumber: number })
    .filter(k => !Number.isFinite(Number(k.created_at)) || now - Number(k.created_at) < REDIAL_WINDOW_MS);
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
  // "Dropped before it was confirmed" only means something may be half-agreed when the call was
  // allowed to agree to anything. An asking-only call (a message for a friend, a question for a shop)
  // cannot have left a booking behind, so ringing again is simply ringing again — call 63 to Yaw was a
  // mailbox filed this way, and its "find out whether it went through" rewrite replaced Thursday's
  // new message with Sunday's script.
  //
  // And the other way round (security run-2 R2-I, 2026-11-08): a call that MAY have booked — cleared to
  // book and something on the line spoke, or one that got as far as a commitment — redials ask-only
  // whatever its label says. The label can come from the after-call model read of the other side's
  // words (./goalmet.js names a recording or a mailbox), and a plain "retry" here goes with booking on.
  const kindMode = redialMode(last.outcome_kind);
  const mode = kindMode === "ask" && !couldCommit(last) ? "retry"
    : kindMode === "retry" && mayHaveBooked(conversationId, last) ? "ask" : kindMode;
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
    const original = safeBrief(last) ?? brief;
    return {
      ok: true, mode: "ask", attempt: attempts + 1,
      brief: askWhetherItWentThrough(original, { what: original?.goal || last.goal, then: brief }),
      why: `The last call dropped before it was confirmed, so this one only checks whether it went through.`
        + ` It is not allowed to book anything.`,
      note: `Open by saying you are ringing to check on something, not to make a new one.`,
    };
  }

  // No brief: the call goes with what it was asked to carry now. Handing back the last call's brief
  // here is how "call Yaw again and tell him X" rang him with the old call's questions.
  return { ok: true, mode: "retry", attempt: attempts + 1 };
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
