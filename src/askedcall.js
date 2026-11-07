// A call they plainly asked for, to a business, that only asks: no "plain yes before I dial".
//
// The owner's rule, 2026-11-06, from the 7-day review: Reason asked "plain yes before I dial?" right
// after "call Joe's Pizza and ask when they close". The request WAS the yes. Asking again for a call
// that cannot spend, book or agree to anything, to a shop that is not anybody they know, is the gate
// crying wolf — and every time it cries wolf, a yes to Reason gets cheaper.
//
// So the confirm gate lets exactly one kind of call through without a separate yes:
//
//   - code: the call only ASKS (no may_book, no max_price_cents, no approved_terms), the number is
//     not somebody they know (db.knownPersonByNumber: their people list, their memory, any Reason
//     account), and the turn is one THEY started — a timer, a sweep or a task wake never counts as
//     somebody asking for a call.
//   - the model: their own latest words clearly ask for THIS call, to a business or public line,
//     only to find something out. Read by a side model against the call's number and goal, never by
//     a word list. Anything short of a clear yes on all three — or no side model at all — is "ask
//     the usual way", which is exactly what happened before.
//
// Everything else about a call is unchanged: the AI disclosure, the recording notice, the undo hold,
// the payment-details refusal, quiet hours and the caps all run as before. Texting somebody, a call
// that could agree to or spend anything, and a call to somebody they know still need their yes.
import * as db from "./db.js";
import { clock, normalizeNumber } from "./config.js";
import { ownerTexts } from "./trust.js";
import { askStructured, sideAskAllowed } from "./backends/side.js";

/** Can this call commit them to anything? Read off the structured fields only. */
export function onlyAsks(input = {}) {
  return input.may_book !== true
    && !(Number(input.max_price_cents) > 0)
    && !((input.approved_terms ?? []).length > 0);
}

export const INSTRUCTIONS = `You are checking one thing for a personal assistant before it phones somewhere for its user.
You are given the user's own latest messages (newest last) and the call the assistant is about to place: the number, what the call is for, and what it may say.

Answer three questions:
- asked: "yes" only if the user's own words clearly ask for this call — this place, for this purpose — so that asking "shall I?" again would be redundant. "Can you find out when the pharmacy closes" with the pharmacy's number already found counts. A vague wish, a call the assistant suggested and they never took up, a different place or a different purpose is "no". If you cannot tell, "unclear".
- callee: "business" for a shop, restaurant, office, clinic, venue, service or other public line; "person" for an individual they would know personally (a friend, family, a landlord, an ex, a colleague); "unclear" otherwise.
- only_asks: "yes" if the call only finds something out (hours, prices, availability, stock, whether they deliver) and says nothing about the user beyond what that needs. "no" if it books, orders, agrees, cancels, complains on their behalf or passes on a personal message.
Judge only what you are given. Do not imagine the rest of the conversation.`;

const SCHEMA = {
  type: "object",
  properties: {
    asked: { type: "string", enum: ["yes", "no", "unclear"] },
    callee: { type: "string", enum: ["business", "person", "unclear"] },
    only_asks: { type: "string", enum: ["yes", "no", "unclear"] },
  },
  required: ["asked", "callee", "only_asks"],
  additionalProperties: false,
};

/** Their own last few messages, as they wrote them: bracketed turn notes taken off. */
export function theirWords(messages = [], { last = 3 } = {}) {
  return ownerTexts(messages).slice(-last)
    .map(t => t.split("\n").filter(l => !l.trim().startsWith("[")).join(" ").trim())
    .filter(Boolean);
}

/** One verdict per conversation, number and latest message: confirm_request and call_place share it. */
const seen = new Map();
const SEEN_MS = 10 * 60_000;
export function forgetVerdicts() { seen.clear(); }

/**
 * Does their request already cover this call, so nothing need be asked?
 *
 * Returns `{ ok: true, permission }` in the shape the confirm gate carries a standing permission in
 * (`said` is their own words, which is what the receipt quotes and what the reply says it went on),
 * or `{ ok: false, why? }`. Never throws; a side model that is down or unsure is a no.
 */
export async function covers({ conversationId: c, input = {}, messages = [], kind = "event", ask = askStructured, now = clock.now() }) {
  if (kind !== "user") return { ok: false };
  if (!onlyAsks(input)) return { ok: false, why: "This call could agree to something, so it still needs their yes." };
  const number = normalizeNumber(input.to ?? "");
  if (!number) return { ok: false };
  const person = db.knownPersonByNumber(c, number);
  if (person) return { ok: false, why: `${number} is how they reach ${person.who}, somebody they know, so it still needs their yes.` };
  const words = theirWords(messages);
  if (!words.length) return { ok: false };
  if (ask === askStructured && !sideAskAllowed()) return { ok: false };

  const key = `${c}\u0000${number}\u0000${words.at(-1)}`;
  let hit = seen.get(key);
  if (!hit || now - hit.at > SEEN_MS) {
    const prompt = `The user's latest messages, newest last:\n${words.map(w => `- ${w}`).join("\n")}`
      + `\n\nThe call about to be placed:\nnumber: ${number}\nfor: ${String(input.goal ?? "").trim()}`
      + `\nmay say about them: ${(input.facts ?? []).map(String).join("; ") || "nothing"}`;
    let value = null, error = null;
    try {
      const r = await ask({ prompt, system: INSTRUCTIONS, schema: SCHEMA, model: "haiku", feature: "call_gate", timeoutMs: 45_000 });
      value = r?.value ?? null;
      error = r?.error ?? null;
    } catch (e) { value = null; error = e?.message ?? String(e); }
    if (process.env.REASON_CALL_GATE_TRACE) console.error("[call_gate]", JSON.stringify({ value, error, words }));
    hit = { at: now, value };
    seen.set(key, hit);
  }
  const v = hit.value;
  if (!(v?.asked === "yes" && v?.callee === "business" && v?.only_asks === "yes")) return { ok: false };
  return {
    ok: true,
    permission: { permission_id: null, asked_for_call: true, said: words.at(-1) },
  };
}
