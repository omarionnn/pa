// What happened on the call, in a closed set of words, and what "it worked" has to be backed by.
//
// The owner's rule, 2026-10-06: "Distinguish 'they confirmed it', 'left a voicemail', 'could not
// reach them', and 'the call dropped before confirmation'. A natural-sounding call is not proof of
// success. Report success only with clear confirmation of the requested outcome, with written
// confirmation where available."
//
// The failure this prevents is specific and it is not a model being dishonest. It is that a call
// transcript reads like a success long before the thing is actually done. "Great, I'll get that
// sorted for you" is a warm, cooperative, completely non-committal sentence, and a summary written
// from the feel of a transcript says the table is booked. So the word the owner sees is not written
// by whatever generated the conversation: it is derived here, from whether the specific evidence
// exists, and `confirmed` is unreachable without it.
//
// There is already a `state` on a call row (`placing`/`ringing`/`completed`/`no_answer`/...) and this
// is deliberately not that. `state` is what the *phone* did and comes from the provider. This is what
// the *errand* achieved, and the two come apart in both directions: a call can complete perfectly and
// achieve nothing, and a call that dropped can have already got what it came for.
import { FINAL_STATES } from "./provider.js";

/**
 * Every outcome a call can have, and what each one means for what may be said and done next.
 *
 * - `success` — may this be reported to the owner as the thing he asked for, having happened?
 *   Exactly one outcome has it. That is the point.
 * - `spokeToHuman` — was there a person? Separates "nobody picked up" from "somebody said no".
 * - `redial` — `"no"` never, `"ask"` only to find out what happened, `"retry"` the same goal again.
 *   This is what `./redial.js` reads; see the `dropped_before_confirmation` note below, which is the
 *   whole reason the three values are not a boolean.
 */
export const OUTCOMES = {
  confirmed: {
    success: true, spokeToHuman: true, redial: "no",
    label: "they confirmed it",
    what: "A person agreed to the thing that was asked for, read back, and said yes to it.",
  },
  answered: {
    success: false, spokeToHuman: true, redial: "no",
    label: "they answered the questions",
    // The right outcome for an inquiry call, which is most of them. It got what it rang for and
    // nothing was agreed — because nothing was supposed to be. Not a success in the `success` sense
    // above, because what was requested was information and the errand's own summary reports that;
    // calling it a success here would make "I asked them" and "it is booked" the same word.
    what: "A person gave the answers the call was asking for. Nothing was agreed or committed.",
  },
  needs_owner: {
    success: false, spokeToHuman: true, redial: "no",
    label: "it needs your word before anything is agreed",
    what: "Something came up outside what was approved, so the call stopped short of agreeing to it.",
  },
  refused_by_them: {
    success: false, spokeToHuman: true, redial: "no",
    label: "they said no",
    what: "A person declined, or said they cannot do it. There is nothing to retry.",
  },
  could_not_understand: {
    success: false, spokeToHuman: true, redial: "retry",
    label: "the line was too bad to settle it",
    what: "A detail that had to be right could not be made out, so nothing was agreed.",
  },
  dropped_before_confirmation: {
    success: false, spokeToHuman: true, redial: "ask",
    label: "the call dropped before it was confirmed",
    // The most dangerous outcome in the set, and the reason `redial` is not a boolean. The honest
    // state is "it may or may not have gone through", and the obvious next action — call back and
    // book it — is how somebody gets two bookings and two charges. So the only redial this permits
    // is one that goes back to ASK what happened, which is a different goal.
    what: "The line went down while this was being settled. Whether it went through is NOT known.",
  },
  hold_gave_up: {
    success: false, spokeToHuman: false, redial: "retry",
    label: "nobody came to the phone in time",
    what: "It waited on hold for as long as it was allowed to and then rang off politely.",
  },
  voicemail_left: {
    success: false, spokeToHuman: false, redial: "no",
    // `redial: "no"` because of the owner's "never leave repeated voicemails". The message is there;
    // ringing back to leave a second one is the behaviour being prevented, and a human calling back
    // is the expected next event (see the callback path in ./inbound.js).
    label: "left a voicemail",
    what: "A machine picked up and one message was left. Nobody has heard it yet.",
  },
  voicemail_no_message: {
    // The 2026-10-13 call to Jeffrey: the machine answered, Reason hung up at the beep, and the row
    // still said "one message was left" — which then locked the number out of a retry under the
    // never-a-second-voicemail rule. Reaching a machine and leaving a message are two different
    // facts, and this is the first one on its own. Nothing is sitting in their mailbox, so ringing
    // back is fine; the next call is the one that leaves the message.
    success: false, spokeToHuman: false, redial: "retry",
    label: "reached voicemail, left nothing",
    what: "A machine picked up and no message was left, so they do not know Reason rang.",
  },
  no_answer: {
    success: false, spokeToHuman: false, redial: "retry",
    label: "could not reach them",
    what: "The phone rang out, was busy, or was declined. Nothing was said to anybody.",
  },
  failed: {
    success: false, spokeToHuman: false, redial: "retry",
    label: "the call could not be placed",
    what: "Something on our side or the provider's stopped the call happening at all.",
  },
  blocked: {
    success: false, spokeToHuman: false, redial: "no",
    label: "it was not called",
    what: "A rule here stopped the call before it was dialled — quiet hours, a cap, or a redial that was not safe.",
  },
};

/** The outcome names, for validation and for the one place a schema needs the list. */
export const OUTCOME_KINDS = Object.keys(OUTCOMES);

/** Whether a word is one of ours at all. A row with something else in it is a bug, not a new case. */
export const isOutcome = (k) => Object.hasOwn(OUTCOMES, String(k ?? ""));

/**
 * Did a machine answer this call — with a message left or without? Read by `settleCall`, because a
 * call Reason itself hung up on after leaving a message looks to the platform like `end_call` on a
 * completed conversation, and "completed" is the word for having spoken to a person.
 */
export const reachedMachine = (row) => ["voicemail_left", "voicemail_no_message"].includes(String(row?.outcome_kind ?? ""));

/**
 * The only route to `confirmed`, and it is a gate rather than a formatter.
 *
 * Both of the first two are required, and neither is a judgement call:
 *
 *   `readBack` — the details were said back in full (see ./readback.js). Without it there is nothing
 *   to have confirmed; "yes" to a question nobody repeated is agreement to whatever they heard.
 *   `theirYes` — they then agreed to what was read back.
 *
 * A written reference is NOT required, because plenty of real places do not give one and refusing to
 * call those bookings confirmed would make the honest answer useless. The owner's words were "with
 * written confirmation where available", so where it is available it is recorded and where it is not
 * the confirmation is marked `spoken_only` and the owner is told that is what it rests on. That is
 * the difference between a careful claim and a hedge: he can see which kind he has.
 *
 * @param {{readBack?: boolean, theirYes?: boolean, reference?: string|null,
 *          writtenPromised?: boolean, unclear?: string[]}} evidence
 */
export function confirmationFrom(evidence = {}) {
  const { readBack = false, theirYes = false, reference = null, writtenPromised = false, unclear = [] } = evidence;
  if (unclear.length) {
    return {
      kind: "could_not_understand", confirmed: false, strength: "none",
      why: `not confirmed: ${unclear.join(", ")} could not be made out, so there was nothing safe to agree to.`,
    };
  }
  if (!readBack) {
    return {
      kind: "dropped_before_confirmation", confirmed: false, strength: "none",
      why: "not confirmed: the details were never read back, so nobody agreed to a specific thing.",
    };
  }
  if (!theirYes) {
    return {
      kind: "dropped_before_confirmation", confirmed: false, strength: "none",
      why: "not confirmed: the details were read back and they did not agree to them before the call ended.",
    };
  }
  const ref = String(reference ?? "").trim();
  if (ref) return { kind: "confirmed", confirmed: true, strength: "documented", reference: ref, why: `confirmed, with a reference: ${ref}` };
  if (writtenPromised) {
    return {
      kind: "confirmed", confirmed: true, strength: "promised_in_writing",
      why: "confirmed; they said they would send written confirmation, which has not arrived yet.",
    };
  }
  return {
    kind: "confirmed", confirmed: true, strength: "spoken_only",
    why: "confirmed on the call only — they gave no reference and promised nothing in writing.",
  };
}

/**
 * The outcome for a call that ended without reaching an agreement, from what is known about it.
 *
 * Ordered by what overrides what, and the order is the interesting part. A paused commitment beats
 * everything, because a call that stopped to ask the owner something did not fail and did not
 * succeed. Hold is checked before `no_answer` because a call that sat on hold for five minutes *did*
 * reach the business, and reporting it as "could not reach them" would be false in the way that
 * matters: he would try the same number again at the same time of day.
 *
 * @param {{state?: string, pausedForOwner?: boolean, voicemail?: boolean, gaveUpOnHold?: boolean,
 *          theyDeclined?: boolean, spoke?: boolean, unclear?: string[], asked?: boolean,
 *          placed?: boolean, blockedWhy?: string}} _
 */
export function outcomeFor({
  state = "", pausedForOwner = false, voicemail = false, gaveUpOnHold = false,
  theyDeclined = false, spoke = false, unclear = [], asked = false, placed = true, blockedWhy = "",
} = {}) {
  if (blockedWhy || placed === false) return "blocked";
  if (pausedForOwner) return "needs_owner";
  if (gaveUpOnHold) return "hold_gave_up";
  // `voicemail` is the row's `voicemail_left`, which is only set once a message was actually said
  // (see `noteVoicemail` in ./hold.js). A call that reached a machine without it left nothing.
  if (voicemail) return "voicemail_left";
  if (state === "voicemail") return "voicemail_no_message";
  if (theyDeclined) return "refused_by_them";
  if (unclear.length && spoke) return "could_not_understand";
  if (state === "failed") return "failed";
  if (["no_answer", "busy", "declined"].includes(state)) return "no_answer";
  // Reached a person. Either it got what it rang to ask, or the line went down mid-errand. There is
  // no third option here on purpose: "completed" with nothing achieved is the case the owner is
  // worried about, and it lands on `dropped_before_confirmation`, which reads as unfinished.
  if (spoke || state === "completed") return asked ? "answered" : "dropped_before_confirmation";
  if (!FINAL_STATES.includes(state)) return "dropped_before_confirmation";
  return "no_answer";
}

/**
 * The one sentence the owner reads. Never claims more than the outcome allows, and says what a
 * confirmation rests on when it rests on only somebody's word.
 */
export function ownerLine(kind, { reference = "", strength = "", place = "" } = {}) {
  const o = OUTCOMES[kind];
  if (!o) return `something happened on that call that I do not have a word for (${kind}).`;
  const who = place ? `${place}: ` : "";
  if (kind === "confirmed") {
    if (reference) return `${who}confirmed, reference ${reference}.`;
    if (strength === "promised_in_writing") return `${who}confirmed — they're sending it in writing, which hasn't come through yet.`;
    return `${who}confirmed, but only on the call — no reference and nothing in writing.`;
  }
  return `${who}${o.label}.`;
}

/** May a call with this outcome be dialled again, and to do what? */
export const redialMode = (kind) => OUTCOMES[kind]?.redial ?? "no";

/** Did a human speak on this call? Separates "nobody picked up" from "somebody said no". */
export const reachedAPerson = (kind) => OUTCOMES[kind]?.spokeToHuman === true;

/** The one question the whole file exists to answer honestly. */
export const isSuccess = (kind) => OUTCOMES[kind]?.success === true;
