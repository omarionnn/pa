// What a call is allowed to agree to, and what stops it.
//
// The owner's rule, 2026-10-06: "Asking about availability is not permission to book. A new fee or
// term outside what Omari approved pauses the commitment and comes back to him (by text, mid-call if
// he is reachable, otherwise the call ends without committing and the summary says so)."
//
// Three things in this file, in order of how much damage each prevents:
//
//   1. **A call that was only asking cannot agree to anything.** Not because it is told not to — it is
//      told, in ./brief.js — but because this function is handed a brief with `approved.book: false`
//      and refuses. The prompt is how it goes right; this is the floor under it.
//   2. **A price or a term outside what he approved pauses rather than guessing.** Not a refusal: a
//      refusal loses the booking over a ten-dollar fee he would have said yes to in a second. Not an
//      acceptance either. It holds the call, asks him, and if he does not answer, hangs up having
//      agreed to nothing — which is the only one of the three outcomes that is never wrong.
//   3. **Two places cannot both be told yes.** One errand, one commitment, enforced by a single-row
//      claim in SQL rather than by counting, because inquiry calls run in parallel by design and
//      "read the column, see it is empty, write it" has a window in it that is exactly this bug.
//
// A commitment has two steps on purpose, and it is worth saying why rather than collapsing them.
// `propose` runs BEFORE anything is said to the other person — it is the permission check, and its
// answer is yes, not yet, or no. `confirm` runs after they have actually agreed and the details have
// been read back, and it is what records the reference. If it were one step, the call would be
// recording an agreement at the moment it decided to try for one.
import { config, clock } from "../config.js";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { blockingUnclear, exactMoney, recordOf, settled, spokenMoney } from "./readback.js";
import { LIVE_STATES } from "./provider.js";
import { calmWhy } from "./payments.js";

/** Reason's own tool: may I agree to this? Asked before a word of it is said to the other person. */
export const PROPOSE_TOOL = {
  name: "propose_commitment",
  description: "Ask whether you may agree to something on this call — a booking, an appointment, an order, a"
    + " price, a slot. Call this BEFORE you tell them yes, every single time, including when it is"
    + " obviously what was wanted and including when they are waiting on the line for an answer. You"
    + " will be told yes, or that it has to be checked first, and exactly what to say either way."
    + " Asking them what is available is not the same as agreeing to it and does not need this.",
  input_schema: {
    type: "object",
    properties: {
      what: { type: "string", description: "What you would be agreeing to, in one plain sentence: 'a table for four at eight on Saturday the eleventh'." },
      total_cents: { type: "integer", description: "The whole amount they would charge, in cents, including every fee. 18000 for $180. Leave out only if there is genuinely no price." },
      terms: {
        type: "array", items: { type: "string" },
        description: "Every condition they have attached, in their words and SHORT: 'a fifty dollar deposit',"
          + " 'no refunds inside 24 hours', 'card held on file', 'the price goes up after Friday'. Put them ALL in,"
          + " including ones that sound minor — this is what gets checked, and one you leave out is one nobody"
          + " approved. Conditions only: a thing that costs money, binds them, or can be broken. NOT the price"
          + " itself (that is total_cents), not the date or time, and not details like how many people are coming"
          + " or how long it takes. Each one is read out to them as a line they have to say yes or no to, so a"
          + " sentence explaining the situation does not belong in here. Empty means they attached none.",
      },
      // The details, from the only thing that heard the call. There is no way around the model reporting
      // these, and no attempt is made to scrape them out of its sentence instead — the guard is not that
      // the model is kept away from the values, it is that whatever it reports gets READ BACK out loud in
      // words the other person confirms, and the exact value is what goes on the record.
      when: {
        type: "string",
        description: "The agreed date and time as a real moment, ISO 8601 with an offset: '2026-10-10T09:00-04:00'."
          + " If all you have is 'Saturday morning' or 'Tuesday at 3', you do NOT have it yet — ask which date and"
          + " what time, and ask which time zone if there is any doubt. Leave this out rather than guessing it.",
      },
      address: { type: "string", description: "The address, if one is part of what is being agreed, exactly as they said it." },
      confirmation: { type: "string", description: "A reference they have already given, if they gave one before you asked." },
      could_not_hear: {
        type: "array", items: { type: "string", enum: ["date", "time", "price", "address", "confirmation"] },
        description: "Any of these you could not actually make out. Say so here rather than guessing — it stops the agreement"
          + " and tells you to ask them to repeat or spell it, which is the right outcome on a bad line.",
      },
    },
    // `terms` is required, and that is the 2026-10-07 rehearsal's doing. Marco named a fifty dollar
    // deposit out loud; the model proposed the booking without it in `terms`, so `outsideApproval` had
    // nothing to find, so the deposit was never escalated — and the call had asked permission for a
    // version of the booking that did not exist. Required does not make a model honest, but it makes
    // the empty list a statement ("they attached no conditions") rather than a field it skipped.
    required: ["what", "terms"],
  },
};

/**
 * Words that mean a condition was just attached to something.
 *
 * Used in exactly one direction: to REFUSE a proposal whose `terms` came back empty while the other
 * side was plainly naming one. Nothing is read out of their sentence and nothing is written down from
 * it — the model is asked again, because the model is the only thing that actually heard the call.
 * Fail-closed, so a false positive costs one more round and a false negative cannot.
 */
const CONDITION_WORDS = /\b(deposit|non-?refundable|cancellation (fee|policy|charge)|surcharge|service charge|booking fee|admin fee|extra charge|on top|upfront|up front|card on file|hold (on|against) (your|the) card|minimum (charge|spend)|plus tax|gratuity)\b/i;

/** Reason's own tool: they agreed, here is the proof. */
export const CONFIRM_TOOL = {
  name: "confirm_commitment",
  description: "Record that they have now actually agreed to it, after you have read the details back and they"
    + " have said yes to them. Only call this when it is genuinely settled on their side — not when they"
    + " say they will sort it out, not when they say it should be fine, and not when you think it went"
    + " through. If the call ends without this, it is reported as not confirmed, which is the honest answer.",
  input_schema: {
    type: "object",
    properties: {
      commitment_id: { type: "integer", description: "The id propose_commitment gave you." },
      reference: { type: "string", description: "The confirmation or booking number, if they gave one. Read it back and spell it before you put it here." },
      written_promised: { type: "boolean", description: "True if they said they would send an email or text confirming it." },
      they_said_yes: { type: "boolean", description: "True only if they explicitly agreed to the details you read back to them." },
    },
    required: ["commitment_id", "they_said_yes"],
  },
};

/** Reason's own tool: let an option go, politely, because something else was chosen. */
export const RELEASE_TOOL = {
  name: "release_commitment",
  description: "Tell them you will not be taking the option they were holding for you, and that it is free again."
    + " Used when something else was chosen. Say it warmly and thank them — they did nothing wrong and"
    + " this is somebody who may be called again.",
  input_schema: {
    type: "object",
    properties: {
      commitment_id: { type: "integer", description: "The id of the commitment being let go." },
      why: { type: "string", description: "A short, kind reason: 'the timing worked better somewhere else'." },
    },
    required: ["commitment_id"],
  },
};

/** Giving out payment details is never a pause-and-ask. It is a refusal, and it is not negotiable. */
const PAYMENT_DETAILS = /\b(card (number|details)|credit card number|cvv|cvc|security code|expiry|expiration date|sort code|account number|routing number|pin\b|bank details)/i;

/**
 * Are they actually asking for payment details, or is this the sentence refusing to give them?
 *
 * In the 2026-10-07 rehearsal a proposal was DECLINED for wanting payment details because the model
 * had written "I cannot take or give card details over the phone" into it — the refusal working
 * perfectly, reported honestly, and then read as the offence. A commitment turned down for the wrong
 * reason is not a safe failure: it is a row that says the wrong thing happened, and the next person
 * reading it believes it.
 */
const NOT_ASKING = /\b(cannot|can'?t|can not|will not|won'?t|unable to|never|not|no|without|refuse(d)?|declined)\b[^.?!]{0,40}$/i;
export function wantsPaymentDetails(text) {
  const s = String(text ?? "");
  // EVERY match, not the first one: "I can't give card details. They are asking for the cvv." has a
  // negated one in front of a real one, and stopping at the first would clear the sentence that matters.
  const all = new RegExp(PAYMENT_DETAILS.source, "gi");
  for (const m of s.matchAll(all)) {
    // Whatever leads up to the phrase, in its own sentence. "I can't give card details" is not an ask.
    const before = s.slice(0, m.index).split(/[.?!]/).pop();
    if (!NOT_ASKING.test(before)) return m[0];
  }
  return null;
}

/**
 * Which parts of a proposed agreement are outside what the owner approved.
 *
 * Conservative on purpose, in the one direction that is safe: a term this cannot confidently match
 * against something he approved counts as outside, which means he gets asked. The cost of being
 * wrong that way is a text he answers in four seconds. The cost of being wrong the other way is a
 * charge he never agreed to.
 */
export function outsideApproval(brief, { totalCents = null, terms = [] } = {}) {
  const a = brief?.approved ?? {};
  const out = [];

  // `exactMoney`, never `Number()`: a null price must stay absent rather than becoming zero.
  const total = exactMoney(totalCents);
  if (a.maxCents !== null && a.maxCents !== undefined && total !== null && total > a.maxCents) {
    out.push({
      kind: "price",
      what: `${spokenMoney(total)}, which is over the ${spokenMoney(a.maxCents)} you approved`,
      // Both halves kept: the words for the call, the numbers for the text to the owner.
      cents: total, approvedCents: a.maxCents,
    });
  }
  // A price when none was approved at all is not automatically outside — an appointment with no fee is
  // the normal case. A price above a ceiling is. No ceiling and a price means he approved booking
  // without naming a number, which is his call to have made.

  const approved = (a.terms ?? []).map(t => normalize(t));
  // Lenient in the same direction as `propose`: a single string is one term. Read strictly, a term
  // sent as a string would be invisible here — which means outside what he approved and nobody told.
  for (const raw of (Array.isArray(terms) ? terms : [terms])) {
    const term = String(raw ?? "").trim();
    if (!term) continue;
    const n = normalize(term);
    const covered = approved.some(t => t && (n.includes(t) || t.includes(n)));
    if (covered) continue;
    out.push({ kind: "term", what: term });
  }
  return out;
}

const normalize = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * May this call agree to this?
 *
 * Every path writes a row, including the refusals, because "it nearly booked that and came to me
 * instead" is the interesting thing to be able to read afterwards and the hardest to reconstruct.
 *
 * @param {{call: object, brief: object, errandId?: number|null, what: string,
 *          totalCents?: number|null, terms?: string[], details?: object[],
 *          tell?: (text: string) => boolean, log?: Function}} _
 */
export function propose({
  call, brief, errandId = null, what, totalCents = null, terms = [], details = [],
  theirWords = "", tell = () => false, log = () => {},
} = {}) {
  const c = call?.conversation_id;
  const errand = errandId ?? call?.errand_id ?? null;
  const row = (state, why, outside = []) => db.createCommitment(c, {
    callId: call.id, errandId: errand, what, totalCents, terms, state, why, outside,
    readback: recordOf(details),
  });

  // A call that was only asking. The refusal is the whole point of `approved.book` defaulting to false.
  if (!brief?.approved?.book) {
    const r = row("declined", "this call was only asking; it was never approved to agree to anything");
    log({ call_commit_refused: call.id, why: "ask_only" });
    return {
      allowed: false, commitment: r, reason: "ask_only",
      say: `You are not agreeing to anything on this call — you are asking. Tell them it sounds good and that`
        + ` you will confirm with ${ownerName(call)} and come straight back to them. Do not say yes, do not`
        + ` let them hold it in ${ownerName(call)}'s name, and do not imply it is settled.`,
    };
  }

  // Payment details. Checked before anything else, because the one thing worse than a bad booking is a
  // card number on a recording, and no approval anywhere makes that acceptable.
  const paymentAsk = [what, ...(Array.isArray(terms) ? terms : [terms])]
    .map(t => wantsPaymentDetails(t)).find(Boolean);
  if (paymentAsk) {
    const r = row("declined", `they wanted payment details: ${paymentAsk}`);
    log({ call_commit_refused: call.id, why: "payment_details" });
    return {
      allowed: false, commitment: r, reason: "payment_details",
      say: `Do not agree to that and do not read out any card or bank detail — not a number, not an expiry, not a`
        + ` security code, for any reason. Tell them you cannot take or give payment details over the phone, ${calmWhy(`${ownerName(call)}'s`)}`
        + ` Then ask whether they can send a payment link or take it another way, and say you will pass it on.`,
    };
  }

  // A condition they just named that did not make it into the proposal. Refused rather than guessed
  // at: there is no attempt to work out what the deposit was or how much it is, only a refusal to
  // decide anything while the model's account of what was attached is visibly short of theirs.
  //
  // This is the hole the rehearsal fell through twice. Without it, an unreported deposit means
  // `outsideApproval` finds nothing outside, so the proposal is ALLOWED — a booking confirmed with a
  // fifty dollar condition on it that nobody ever approved, which is the exact outcome the owner's
  // "no duplicate commitments, complete quotes" priority is about.
  // A lone string is read as one term rather than as nothing. A model that sends `"a fifty dollar
  // deposit"` where a list belongs has reported the condition; treating that as "they attached none"
  // is the worst possible reading of it, and it is the reading that lets a booking through.
  const named = (Array.isArray(terms) ? terms : [terms]).filter(t => String(t ?? "").trim());
  if (!named.length) {
    const heard = String(theirWords ?? "").match(CONDITION_WORDS);
    if (heard) {
      const r = row("proposed", `a condition they named ("${heard[0]}") was not in the proposal`);
      log({ call_commit_terms_missing: call.id, word: heard[0] });
      return {
        allowed: false, commitment: r, reason: "terms_missing",
        say: `Not yet — they have just mentioned a ${heard[0]}, and you did not put it in. Do not agree to anything`
          + ` and do not say you are checking with ${ownerName(call)} yet, because nothing is being checked until`
          + ` you call this again. Call propose_commitment again with EVERY condition they named in \`terms\`, in`
          + ` their words. If you are not sure what they meant by it, ask them to say it again plainly first.`,
      };
    }
  }

  // What the brief said has to be read back, and how much of it is actually established.
  const need = settled(details, { require: brief.readBack ?? [] });

  // Outside what he approved: hold the call, ask him, agree to nothing in the meantime.
  //
  // THIS COMES FIRST, ahead of the unclear and incomplete checks, and the 2026-10-07 rehearsal is why.
  // A cleaner named a fifty dollar deposit nobody had approved in the same breath as the price, before
  // any date was settled. The incomplete check fired first — correctly, there was no date — so the
  // function returned "ask them for the date", the deposit was never escalated, and four proposals
  // later Omari had not been told about it once. The call meanwhile said "I'm checking the deposit with
  // Omari right now" out loud, which was false: nothing was checking.
  //
  // Asking him early cannot do any harm — a text is not a commitment — and it is what the owner's rule
  // actually asks for: he answers while the call keeps the person talking and pins down the rest. The
  // one exception is below: a difference that rests on a number nobody actually heard.
  const outside = outsideApproval(brief, { totalCents, terms });
  const unheard = new Set(details.filter(d => d?.unclear).map(d => String(d.kind ?? d.label).toLowerCase()));
  // A price that is "over the limit" when the price was not made out is not a fact yet, so he is not
  // asked about it. A named term is a thing they said, not a value heard off a bad line, so it stands.
  const restsOnUnheard = outside.some(o => unheard.has(o.kind));
  if (outside.length && !restsOnUnheard) {
    // He is asked once per call and then left alone until he answers. In the rehearsal he got three
    // near-identical "need your word" texts inside two minutes, because each re-proposal of the same
    // booking paused and texted again. Three texts about one deposit is the same failure as two
    // bookings of one table: his phone is the thing being duplicated instead of the booking.
    const waiting = db.callCommitments(c, call.id).find(m => m.state === "paused_for_owner" && !m.owner_said);
    if (waiting) {
      log({ call_commit_already_asked: call.id, commitment: waiting.id });
      return {
        allowed: false, commitment: waiting, reason: "already_asked", outside, askedOwner: true,
        say: `Do NOT agree to that. ${ownerName(call)} has already been asked about this one and has not answered`
          + ` yet — asking again would just be another text saying the same thing, so do not. Keep the person on`
          + ` the line talking about anything still unsettled, or ask if you can hold. If no answer comes, tell`
          + ` them you have to confirm it and will ring back, thank them, and end the call agreeing to nothing.`,
      };
    }
    const r = row("paused_for_owner", `outside what was approved: ${outside.map(o => o.what).join("; ")}`, outside);
    const sent = tell(ownerQuestion({ call, what, outside, commitment: r }));
    db.updateCommitment(c, r.id, { asked_owner_at: clock.now() });
    log({ call_commit_paused: call.id, commitment: r.id, outside: outside.length, told_owner: sent, missing: need.missing });
    // Something still to establish is not a reason to wait in silence: it is the thing to do with the
    // time his answer takes, and it keeps somebody on the line who would otherwise be hung on dead air.
    const alsoGet = need.missing.length
      ? ` While you wait, get the ${need.missing.join(" and the ")} — it is needed either way, so ask for it now.`
      : "";
    return {
      allowed: false, commitment: db.getCommitment(c, r.id), reason: "needs_owner", outside, askedOwner: sent,
      say: sent
        ? `Do NOT agree to that. It is outside what ${ownerName(call)} approved, and they have just been texted about`
          + ` it — that has actually happened, so you can honestly say you are checking. Tell them you need to check`
          + ` one thing and you will have an answer in a moment, then keep them talking or ask if you can hold.`
          + ` If no answer comes through, tell them you will have to confirm and ring back, thank them, and end the`
          + ` call WITHOUT agreeing to anything.${alsoGet}`
        : `Do NOT agree to that. It is outside what ${ownerName(call)} approved and they cannot be reached right now.`
          + ` Do not say you are checking with them, because you are not. Tell them you will have to confirm it and`
          + ` come back to them, thank them, and end the call without agreeing.${alsoGet}`,
    };
  }

  // A detail that was not heard is not a detail. Agreeing to a price you misheard is worse than
  // agreeing to one that is over the limit, which is why nothing below this line can be allowed.
  const blocked = blockingUnclear(details);
  if (blocked) {
    const r = row("proposed", "a detail that had to be right could not be made out");
    log({ call_commit_unclear: call.id });
    return { allowed: false, commitment: r, reason: "unclear", say: blocked };
  }

  // Everything the brief said has to be read back has to actually be there.
  if (!need.ok && need.missing.length) {
    const r = row("proposed", `nothing agreed yet: no ${need.missing.join(", ")} established`);
    log({ call_commit_incomplete: call.id, missing: need.missing });
    return {
      allowed: false, commitment: r, reason: "incomplete",
      say: `Do not agree yet — you still do not have the ${need.missing.join(" or the ")}. Ask for it plainly,`
        + ` get a specific answer, and then propose it again.`,
    };
  }

  // One errand, one commitment. The claim is atomic in SQL; losing it means another call got there.
  if (errand) {
    if (!db.claimErrandBooking(c, errand, call.id)) {
      const holder = db.getErrand(c, errand)?.committed_call_id;
      const r = row("declined", `another call on this errand is already the one agreeing (call ${holder})`);
      log({ call_commit_lost_lock: call.id, errand, holder });
      return {
        allowed: false, commitment: r, reason: "already_committing",
        say: `Do not agree to this — something else has already been arranged for ${ownerName(call)} and booking this`
          + ` too would double it up. Thank them, say it is covered now, and let them go politely.`,
      };
    }
  }

  const r = row("proposed", "inside what was approved");
  log({ call_commit_allowed: call.id, commitment: r.id, cents: totalCents });
  return {
    allowed: true, commitment: r, reason: "approved",
    say: `Yes — you may agree to this. Read the details back to them first, get their yes to each one, ask for a`
      + ` confirmation number, and then call confirm_commitment with id ${r.id}. Nothing counts until you have`
      + ` done that, so do not treat it as done before you have.`,
  };
}

/**
 * They actually agreed. Records it, with what the confirmation rests on.
 *
 * `they_said_yes` false is not an error and is not treated as one: it is a call that got close, and
 * the honest record of that is a commitment still sitting at `proposed`, which the outcome rules in
 * ./outcome.js then report as not confirmed.
 */
export function confirm({ call, brief = null, commitmentId, reference = "", writtenPromised = false, theySaidYes = false, details = [], log = () => {} } = {}) {
  const c = call?.conversation_id;
  const existing = db.getCommitment(c, commitmentId);
  if (!existing || existing.call_id !== call.id) {
    return { ok: false, error: `There is no commitment ${commitmentId} on this call. Call propose_commitment first.` };
  }
  if (existing.state === "paused_for_owner") {
    return {
      ok: false, error: `That one is still waiting on ${ownerName(call)} and has not been approved. Do not tell them it is`
        + ` confirmed. Say you are still checking, or that you will come back to them.`,
    };
  }
  if (existing.state === "declined") {
    return { ok: false, error: `That one was refused and cannot be confirmed. Do not tell them it is booked.` };
  }
  // The details the brief insisted on, checked again at the moment it is recorded rather than only at
  // the moment it was allowed.
  //
  // It used to be enough that `propose` had checked: nothing could get past it without a date. That
  // stopped being true when a difference outside his approval began pausing BEFORE the completeness
  // check (see `propose` above) — a paused commitment he says yes to becomes `proposed`, and `proposed`
  // was all this asked for. So the one route to a booking with no date on it ran through his own
  // approval of something else entirely. The brief is optional here only because older callers do not
  // pass one; when it is passed, this is the floor.
  const need = brief ? settled(details, { require: brief.readBack ?? [] }) : { ok: true, missing: [], unclear: [] };
  if (!need.ok) {
    const what = [...need.unclear, ...need.missing];
    log({ call_commit_confirm_incomplete: call.id, commitment: commitmentId, missing: what });
    return {
      ok: false, notConfirmed: true,
      error: `Do not record that yet and do not tell them it is booked — you still do not have the`
        + ` ${what.join(" or the ")}. Ask them for it plainly, read it back, and then call this again.`,
    };
  }
  if (!theySaidYes) {
    db.updateCommitment(c, commitmentId, { why: "they did not clearly agree to the details that were read back" });
    log({ call_commit_no_yes: call.id, commitment: commitmentId });
    return {
      ok: false, notConfirmed: true,
      error: `Then it is not confirmed, and it will be reported that way. Ask them directly whether that is booked,`
        + ` in plain words, and wait for an actual yes.`,
    };
  }

  const ref = String(reference ?? "").trim();
  const strength = ref ? "documented" : writtenPromised ? "promised_in_writing" : "spoken_only";
  db.updateCommitment(c, commitmentId, {
    state: "committed", reference: ref, readback: recordOf(details),
    why: ref ? `confirmed, reference ${ref}` : writtenPromised ? "confirmed; written confirmation promised" : "confirmed on the call only",
  });
  // Mirrored onto the call row so settling the call and writing the summary never has to join a table
  // to answer "did this work", which is the question most likely to be asked in a hurry.
  db.updateCall(c, call.id, { confirmation_ref: ref, confirmation_strength: strength, readback: JSON.stringify(recordOf(details)) });
  log({ call_commit_confirmed: call.id, commitment: commitmentId, strength });
  return {
    ok: true, strength, reference: ref,
    say: ref
      ? `Confirmed, with the reference. Thank them and end the call.`
      : `Confirmed. Before you go, ask once whether there is a confirmation number or whether they can send it in`
        + ` writing — and if there is not, that is fine, say thank you and end the call.`,
  };
}

/** Let an option go. The row says it was actually let go, not just chosen against. */
export function release({ call, commitmentId, why = "", log = () => {} } = {}) {
  const c = call?.conversation_id;
  const existing = db.getCommitment(c, commitmentId);
  if (!existing) return { ok: false, error: `There is no commitment ${commitmentId} to let go of.` };
  db.updateCommitment(c, commitmentId, { state: "released", why: why || "let go; something else was chosen" });
  log({ call_commit_released: call.id, commitment: commitmentId });
  return {
    ok: true,
    say: `Tell them warmly that you will not be needing it after all, that it is free again, and thank them for`
      + ` holding it. Do not explain more than you need to and do not apologise repeatedly.`,
  };
}

/**
 * The owner answered a paused commitment. His yes or no, applied.
 *
 * Deliberately not a model judgement about what he meant: the caller hands this a boolean that came
 * from the ordinary gate, which is the same reader that decides what a typed yes means everywhere else
 * in Reason. One judge, one row, whatever channel the answer arrived on.
 */
export function ownerAnswered({ conversationId, commitmentId, yes, said = "", log = () => {} } = {}) {
  const existing = db.getCommitment(conversationId, commitmentId);
  if (!existing) return { ok: false, error: `No commitment ${commitmentId}.` };
  if (existing.state !== "paused_for_owner") {
    return { ok: false, error: `Commitment ${commitmentId} is ${existing.state}, not waiting on an answer.` };
  }
  const state = yes ? "proposed" : "declined";
  db.updateCommitment(conversationId, commitmentId, {
    state, owner_said: String(said ?? "").slice(0, 300),
    why: yes ? "the owner approved the difference" : "the owner said no to the difference",
  });
  log({ call_commit_owner: commitmentId, yes });
  return { ok: true, state, commitment: db.getCommitment(conversationId, commitmentId) };
}

/**
 * The text the owner gets, mid-call, with somebody holding a handset at the other end.
 *
 * Opens with the ask and not with context, because he is being interrupted and the question is the
 * only part that cannot wait. His standing preference is plain bullets with the decision at the top,
 * and a one-tap answer is the most useful shape a text can have here.
 */
export function ownerQuestion({ call, what, outside = [], commitment = null }) {
  const bits = outside.map(o => `- ${o.what}`);
  return [
    `On the phone now — need your word before I agree to anything.`,
    ``,
    `- ${what}`,
    ...bits,
    ``,
    `Yes or no? They're holding. If you don't answer I'll tell them I have to check and ring off without booking.`,
    commitment ? `(#${commitment.id})` : ``,
  ].filter(l => l !== undefined).join("\n");
}

/**
 * Has a paused commitment waited longer than the owner gets?
 *
 * Read by the voice turn, so a call where he never answers ends by itself having agreed to nothing,
 * rather than sitting on the line forever or — much worse — deciding on his behalf.
 */
export function ownerOutOfTime(commitment, { now = clock.now(), seconds = config.callOwnerReplySeconds } = {}) {
  if (!commitment || commitment.state !== "paused_for_owner") return false;
  const asked = Number(commitment.asked_owner_at ?? 0);
  return asked > 0 && now - asked >= seconds * 1000;
}

/**
 * Things at a number that MIGHT have been agreed, because the call ended before anybody knew.
 *
 * The gap this closes, from the 2026-10-07 addendum's release gates: "a disconnect immediately after
 * a possible booking", and "block release on any duplicate commitment".
 *
 * A commitment goes to `proposed` when the gate ALLOWED it — the brief covered it, the price was
 * inside the ceiling — and the call then read it back and said yes to the place. It becomes
 * `committed` only when `confirm_commitment` records what came back. So a `proposed` commitment on a
 * call that is no longer live is the genuinely ambiguous one: the restaurant very probably wrote it
 * down, and Reason does not know. A dropped line two seconds after "lovely, that's booked for
 * Saturday" produces exactly this row.
 *
 * It is not a yes and it is not a no, and the two wrong answers are opposite: calling it agreed
 * tells him something is booked that may not be, and calling it nothing lets the next call book the
 * same table twice. So it is reported as its own third thing, and both callers treat it as "go and
 * find out, do not go and do it again" — `safeToRedial` turns the redial into an asking-only one,
 * and a requested call refuses to be placed with booking on at all.
 *
 * Unscoped by errand on purpose, for the reason `safeToRedial` already is: the question is about the
 * number and the thing, not about which job it belonged to.
 */
export function unresolvedAt(conversationId, toNumber) {
  const number = String(toNumber ?? "").trim();
  if (!number) return [];
  return db.commitmentsAtNumber(conversationId, number).filter((m) => {
    if (m.state !== "proposed") return false;
    // A call still going has not left anything unresolved — it is simply in the middle, and the turn
    // on it is the thing that will resolve it.
    const call = db.getCall(conversationId, m.call_id);
    return !!call && !LIVE_STATES.includes(call.state);
  });
}

/** Whose Reason this call belongs to — not necessarily the operator; everyone who texts has their own. */
const ownerName = (call) => {
  try { return accounts.ownerOf(call?.conversation_id)?.name || config.ownerName; }
  catch { return config.ownerName; }
};
