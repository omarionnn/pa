// One request that needs several phone calls, and the one answer it comes back with.
//
// The owner's rule, 2026-10-06: "'Get me an outcome across several calls' is ONE request. Ask every
// provider the same core questions so quotes compare: full price, fees, availability, what is
// included, exclusions, how long the quote holds. Explain the tradeoff (cheapest, earliest, best
// fit); 'best deal' must never silently mean the lowest advertised price."
//
// And the summary he asked for, in his own words: "I reached 4 of 6 places. This one is cheapest at
// $180 including fees; this one can do tomorrow for $210. Two never answered."
//
// Three things here, and the third is the one that is easy to skip.
//
//   **The same questions.** They live on the errand, not on each call, so the sixth call cannot ask a
//   thinner version than the first. That is the failure that turns a comparison into apples and
//   oranges, and it happens quietly: every individual call looks fine.
//
//   **Firm or an estimate.** Kept as a column. "About two hundred" and "two hundred" are different
//   promises, and a summary that flattens them into "$200" is the summary that gets him a bill he did
//   not expect. A quote nobody pinned down is `unknown`, which is honest and is not the same as either.
//
//   **Unreached places are part of the answer.** "I reached 4 of 6" — the two that never answered are
//   in the summary, because an answer that silently drops them reads like the whole market and is not.
//   This is the same rule as the no-false-progress rule everywhere else in Reason: what did not happen
//   gets said out loud.
import { clock, config } from "../config.js";
import * as db from "../db.js";
import { CORE_QUESTIONS, QUOTE_KINDS, buildBrief } from "./brief.js";
import { OUTCOMES, isSuccess, reachedAPerson } from "./outcome.js";
import { exactMoney, hasMoney, spokenMoney } from "./readback.js";

/** Reason's own tool: write down what one place said, in the shape the comparison needs. */
export const QUOTE_TOOL = {
  name: "note_answer",
  description: "Write down what this place told you, so it can be compared with everywhere else. Call it once"
    + " towards the end of the call, when you have their answers. Put in what they actually said, not what"
    + " you think they meant, and leave anything out that they did not tell you rather than guessing it —"
    + " a blank is useful and a made-up number is not.",
  input_schema: {
    type: "object",
    properties: {
      place: { type: "string", description: "Who they are, as they said it: 'Clean Co', 'the one on Lafayette'." },
      total_cents: { type: "integer", description: "The whole amount they would charge INCLUDING every fee and tax, in cents. 18000 for $180. This is the number that gets compared, so it has to be the real one." },
      price_cents: { type: "integer", description: "The headline price before fees, in cents, when they gave one separately." },
      fees_cents: { type: "integer", description: "The fees on top, in cents, when they named them separately." },
      firmness: { type: "string", enum: ["firm", "estimate", "unknown"], description: "'firm' only if they said it is the price. 'estimate' if they said about, around, roughly, starting from, or it depends. 'unknown' if they never made it clear — do not guess 'firm'." },
      holds_until: { type: "string", description: "How long that price is good for, in their words: 'until Thursday', 'today only', 'they wouldn't say'." },
      earliest: { type: "string", description: "The soonest they could do it, in their words, plus other times they offered." },
      included: { type: "array", items: { type: "string" }, description: "What is in the price." },
      excluded: { type: "array", items: { type: "string" }, description: "What is specifically not." },
      said_by: { type: "string", description: "Who told you, if they said: 'Maria on reception'." },
      notes: { type: "string", description: "Anything else that would change the decision. One or two lines." },
    },
    required: ["place", "firmness"],
  },
};

/**
 * Start an errand. The questions default to the core six, so a caller that names none still gets
 * comparable answers.
 */
export function open(conversationId, { goal, kind = "inquiry", questions = null, brief = null, taskId = null } = {}) {
  const qs = Array.isArray(questions) && questions.length ? questions : CORE_QUESTIONS;
  const b = brief ?? buildBrief({ goal, questions: qs });
  return db.createErrand(conversationId, { goal, kind, questions: qs, brief: b, taskId });
}

/**
 * The brief for one leg of an errand: the errand's own brief, with this place's name on it and the
 * errand's questions, so no caller can hand one call a different set.
 */
export function briefForLeg(errand, { place = "", returnNumber = "", book = false } = {}) {
  const base = errand?.brief ?? {};
  return buildBrief({
    ...base,
    goal: base.goal || errand?.goal,
    questions: errand?.questions ?? CORE_QUESTIONS,
    place,
    returnNumber,
    // A leg of an inquiry errand can never be allowed to book, whatever is passed in: the errand's
    // kind is the ceiling, and `book: true` on a call belonging to an inquiry would be the exact
    // "asking is not permission to book" failure arriving by a different route.
    approved: { ...(base.approved ?? {}), book: book === true && errand?.kind === "booking" },
  });
}

/**
 * May another call go out on this errand right now?
 *
 * Two different limits with two different reasons, and they are not interchangeable:
 *
 *   **Parallel** is about money and attention — every live leg bills per minute, and six voices that
 *   may all need the owner in the same minute is worse than three.
 *   **Booking** is about correctness. One at a time, always, not configurable. Two places both being
 *   told yes is the failure this whole area exists to prevent, and a setting that could raise it to
 *   two would be a setting for causing it.
 */
export function roomForAnother(conversationId, errandId, { booking = false } = {}) {
  const errand = db.getErrand(conversationId, errandId);
  if (!errand) return { ok: false, error: `No errand ${errandId}.` };
  if (errand.closed_at) return { ok: false, error: `That errand is already finished.` };
  const live = db.liveErrandCalls(conversationId, errandId);
  if (booking) {
    if (errand.committed_call_id) {
      return { ok: false, error: `Something has already been arranged on this errand (call ${errand.committed_call_id}). Nothing else gets booked.` };
    }
    if (live.length) {
      return { ok: false, error: `There ${live.length === 1 ? "is" : "are"} still ${live.length} call(s) going on this errand. Bookings happen one at a time — wait for them to finish.` };
    }
    return { ok: true, live: 0 };
  }
  const max = Math.max(1, config.callMaxParallel);
  if (live.length >= max) {
    return {
      ok: false, full: true,
      error: `There are already ${live.length} calls going on this errand, which is the limit on this install`
        + ` (${max}, REASON_CALL_MAX_PARALLEL). Wait for one to finish before starting another.`,
    };
  }
  return { ok: true, live: live.length, room: max - live.length };
}

/** Write down what a place said. One quote per call; a second supersedes the first. */
export function noteAnswer(conversationId, { errandId, callId, toNumber = "", ...fields } = {}) {
  const firmness = QUOTE_KINDS.includes(fields.firmness) ? fields.firmness : "unknown";
  // The comparable number is the total with fees in it. When only a headline price and fees were
  // given, it is added up here rather than left to the model — this is the value everything sorts on.
  // `exactMoney` throughout, because `Number(null)` is 0 and a place that would not quote must not
  // arrive in the comparison as costing nothing — a zero sorts straight to the top and gets reported
  // as the cheapest option, which is the one thing the summary must never do.
  const named = exactMoney(fields.totalCents);
  const headline = exactMoney(fields.priceCents);
  const total = named !== null
    ? named
    : (headline !== null ? headline + (exactMoney(fields.feesCents) ?? 0) : null);
  return db.addQuote(conversationId, { ...fields, errandId, callId, toNumber, firmness, totalCents: total });
}

// ---------- the comparison ----------

/**
 * Everything the errand knows, in the shape a decision is made from.
 *
 * `cheapest` and `earliest` are separate fields rather than one `best`, which is the point. The
 * owner's line was that "'best deal' must never silently mean the lowest advertised price", so there
 * is no field called best: there is a cheapest, an earliest, and a sentence saying what choosing one
 * costs you in the other. Whoever reads this has to look at the tradeoff to pick.
 */
export function compare(conversationId, errandId, { now = clock.now() } = {}) {
  const errand = db.getErrand(conversationId, errandId);
  if (!errand) return null;
  const calls = db.errandCalls(conversationId, errandId);
  const quotes = db.errandQuotes(conversationId, errandId);
  const byCall = new Map(quotes.map(q => [q.call_id, q]));

  const legs = calls.map(call => ({
    callId: call.id,
    place: byCall.get(call.id)?.place || call.to_number,
    number: call.to_number,
    outcome: call.outcome_kind || "",
    reached: reachedAPerson(call.outcome_kind),
    quote: byCall.get(call.id) ?? null,
    attempt: Number(call.attempt ?? 1),
    heldFor: Number(call.hold_total_s ?? 0),
  }));

  // Priced legs only, and only ones where somebody actually said a number. A leg with no price is
  // reported as unreached-or-unanswered rather than sorted to the top as if it were free.
  const priced = legs.filter(l => hasMoney(l.quote?.total_cents));
  const cheapest = priced.length
    ? priced.reduce((a, b) => (Number(b.quote.total_cents) < Number(a.quote.total_cents) ? b : a))
    : null;
  const withTime = legs.filter(l => String(l.quote?.earliest ?? "").trim());
  // Not sorted by date: "tomorrow", "next Tuesday" and "two weeks out" are what places actually say,
  // and parsing them into timestamps here would invent a precision nobody gave. The earliest is
  // whichever priced leg the owner can see said the soonest-sounding thing, so this stays a list and
  // the sentence below names them rather than claiming a winner.
  const unreached = legs.filter(l => !l.reached);
  const reached = legs.filter(l => l.reached);
  const estimates = priced.filter(l => l.quote.firmness !== "firm");

  return {
    errand, legs, reached, unreached, priced, cheapest, withTime, estimates,
    committedCallId: errand.committed_call_id ?? null,
    allDone: legs.length > 0 && !db.liveErrandCalls(conversationId, errandId).length,
    now,
  };
}

/**
 * The summary the owner reads. His own example's shape, and nothing claimed that is not in a row.
 *
 * Plain bullets, the decision at the top, no jargon — his standing format. It deliberately ends on a
 * question when there is something to decide, because committing is his and an answer that does not
 * ask is an answer that has quietly decided for him.
 */
export function summary(conversationId, errandId, { now = clock.now() } = {}) {
  const c = compare(conversationId, errandId, { now });
  if (!c) return "";
  const { legs, reached, unreached, priced, cheapest, estimates, errand } = c;
  const lines = [];

  if (!legs.length) return `Nothing has been called yet on: ${errand.goal}`;

  lines.push(`I reached ${reached.length} of ${legs.length} ${legs.length === 1 ? "place" : "places"}.`);

  for (const leg of priced.slice().sort((a, b) => Number(a.quote.total_cents) - Number(b.quote.total_cents))) {
    const q = leg.quote;
    const money = spokenMoneyPlain(q.total_cents);
    const firm = q.firmness === "firm" ? "firm" : q.firmness === "estimate" ? "an estimate" : "they wouldn't pin it down";
    const when = String(q.earliest ?? "").trim();
    const holds = String(q.holds_until ?? "").trim();
    lines.push(
      `- ${leg.place}: ${money}${when ? `, ${when}` : ""} — ${firm}${holds ? `, good ${holds}` : ""}`
      + `${leg.callId === cheapest?.callId ? " · cheapest" : ""}`,
    );
  }

  // Reached, but with no number. Named rather than folded into the unreached, because "they answered
  // and would not quote" is a different fact about a place from "they never picked up".
  for (const leg of reached.filter(l => !hasMoney(l.quote?.total_cents))) {
    lines.push(`- ${leg.place}: ${OUTCOMES[leg.outcome]?.label ?? "spoke to them"}, no price`);
  }

  if (unreached.length) {
    const grouped = new Map();
    for (const l of unreached) {
      const label = OUTCOMES[l.outcome]?.label ?? "no answer";
      grouped.set(label, [...(grouped.get(label) ?? []), l.place]);
    }
    for (const [label, places] of grouped) {
      lines.push(`- ${places.join(", ")}: ${label}`);
    }
  }

  // The tradeoff, said out loud. Only when there is one — two options at the same price with the same
  // availability is not a tradeoff and saying it would be noise.
  const tradeoff = tradeoffLine(c);
  if (tradeoff) { lines.push(``, tradeoff); }

  if (estimates.length && priced.length) {
    lines.push(`Heads up: ${estimates.map(l => l.place).join(", ")} ${estimates.length === 1 ? "gave" : "gave"} an estimate, not a firm price.`);
  }

  if (c.committedCallId) {
    const booked = legs.find(l => l.callId === c.committedCallId);
    lines.push(``, `Booked: ${booked?.place ?? "one of them"}.`);
  } else if (priced.length) {
    lines.push(``, `Want me to book one?`);
  } else if (c.allDone) {
    lines.push(``, `Nobody gave me a price. Want me to try again later, or try different places?`);
  }

  return lines.join("\n");
}

/**
 * What choosing the cheapest costs, in the only terms that matter: time, and whether the price is
 * real. Returns "" when the cheapest is also the soonest and firm, because then there is no trade.
 */
function tradeoffLine(c) {
  const { cheapest, priced } = c;
  if (!cheapest || priced.length < 2) return "";
  const others = priced.filter(l => l.callId !== cheapest.callId);
  const sooner = others.filter(l => String(l.quote.earliest ?? "").trim() && String(cheapest.quote.earliest ?? "").trim()
    && String(l.quote.earliest) !== String(cheapest.quote.earliest));
  const bits = [];
  if (cheapest.quote.firmness !== "firm") {
    bits.push(`the cheapest one is ${cheapest.quote.firmness === "estimate" ? "only an estimate" : "not a price they would stand behind"}`);
  }
  if (sooner.length) {
    const alt = sooner[0];
    bits.push(`${alt.place} could do ${alt.quote.earliest} for ${spokenMoneyPlain(alt.quote.total_cents)}`);
  }
  if (!bits.length) return "";
  return `Cheapest isn't automatically best here: ${bits.join(", and ")}.`;
}

/** "$180" for a text, as against the spoken "a hundred and eighty dollars" the call says. */
function spokenMoneyPlain(cents) {
  const n = exactMoney(cents);
  if (n === null) return "no price";
  const dollars = n / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/** The spoken form, for the rare case the comparison is read out on a call rather than texted. */
export const spokenTotal = (cents) => spokenMoney(cents);

/**
 * Close an errand. `decision` is what was actually settled, in words, for the record.
 *
 * Everything still being held elsewhere is reported rather than released automatically: letting an
 * option go means ringing somebody back and saying so, which is a call, and a call is the owner's to
 * approve. The caller gets the list and offers.
 */
export function close(conversationId, errandId, { decision = "", state = "done", now = clock.now() } = {}) {
  const held = db.errandCommitments(conversationId, errandId).filter(m => ["proposed", "paused_for_owner"].includes(m.state));
  db.updateErrand(conversationId, errandId, { state, decision, closed_at: now });
  return { errand: db.getErrand(conversationId, errandId), stillHeld: held };
}

/** Did this errand achieve what it set out to? Read off the rows, never off a transcript. */
export function achieved(conversationId, errandId) {
  const calls = db.errandCalls(conversationId, errandId);
  return calls.some(k => isSuccess(k.outcome_kind));
}
