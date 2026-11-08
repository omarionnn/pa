// Did a call to somebody get what it rang for, when what it rang for was not a booking?
//
// Call 46 (2026-10-27 20:46 ET): "Reach Jeffrey and ask him to call Omari back." Jeff picked up, said
// "Yeah, this is me", heard the message and said "For sure. I will." The errand was done. But nothing
// was read back and agreed — there was nothing to agree — so the row fell through to
// `dropped_before_confirmation` ("whether it went through is NOT known"), `isSuccess` was false, and
// the first call that really finished something for the owner earned nothing in his book.
//
// A booking still only becomes `confirmed` through the read-back gate in ./outcome.js. This is the
// other kind of errand — a message passed to the right person, a question answered, a piece of
// information got — and whether THAT happened is a question about what was said, which is the model's
// to read (the repo's rule: AI reads meaning, never regex). One short question on the claude-cli
// subscription after the call ends, never the billed API. It never guesses upward: no CLI, an error,
// or an answer off the schema all leave the row as it was.
import * as db from "../db.js";
import { askStructured, sideAskAllowed } from "../backends/side.js";
import { theySpoke } from "./outcome.js";

// How the call went, when it was not met (2026-11-07: every unsettled call read "dropped before
// confirmation" — a mailbox that isn't set up, a person who hung up on the first second, a chat).
export const HOW = ["talked", "hung_up_early", "voicemail_not_set_up", "voicemail_greeting", "recording", "unsure"];
const SCHEMA = {
  type: "object",
  properties: {
    met: { type: "boolean" },
    how: { type: "string", enum: HOW },
    why: { type: "string" },
  },
  required: ["met", "how", "why"],
  additionalProperties: false,
};

/** The outcome a not-met read moves the row to, or "" to leave it as it is. */
export const KIND_FOR = {
  talked: "picked_up", hung_up_early: "hung_up_early", voicemail_not_set_up: "voicemail_full",
  voicemail_greeting: "voicemail_no_message", recording: "machine_recording", unsure: "",
};
/**
 * A machine answered. These stand on any call that could not have agreed to anything — but never on
 * one that could (see mayHaveBooked): the read is built from the other side's words, and a machine
 * kind's redial is a plain "retry" with booking allowed, where a dropped book-cleared call's is the
 * ask-only check (./redial.js). Security run-2 R2-I.
 */
const MACHINE_HOW = new Set(["voicemail_not_set_up", "voicemail_greeting", "recording"]);

const SYSTEM = `You read the transcript of a phone call an AI assistant made on someone's behalf, and the goal it was given. Say whether the call achieved that goal.
met = true only when the transcript itself shows it happened: the message was given to the person it was meant for (or to whoever the goal allows) and they took it; the question was asked and actually answered; the information the goal wanted was actually obtained.
met = false when the goal was to book, buy, reserve, change, cancel or agree to something (those are judged elsewhere); when the person never heard or never took the message; when the questions went unanswered or were only promised for later; when it reached a recording, a menu or voicemail; when the line was silent; when the call was cut off before the point was made; or when you are unsure. Warmth and politeness are not achievement.
how: what the call was, read from the transcript — talked (a person answered and there was a real exchange), hung_up_early (a person picked up and the line ended within the first moments, before the point of the call was made, e.g. only "hello? hello?"), voicemail_not_set_up (a recording said the mailbox is not set up, is full, or cannot take messages), voicemail_greeting (a voicemail greeting answered), recording (another recorded message or a phone menu, no person), unsure.
why: one plain sentence saying what was achieved, or what was missing.`;

/** The goal and the transcript, as one prompt. */
const promptFor = (row, transcript) => `${Number(row.is_owner) === 1 ? "This was a call between the assistant and the person it works for.\n" : ""}The goal the call was given:\n${String(row.goal ?? "").slice(0, 1200)}\n\nThe transcript ("Reason" is the assistant, "Them" is the other side):\n${String(transcript ?? "").slice(0, 8000)}`;

/**
 * Whether this row is one the question is asked about at all: a finished call Reason placed to
 * somebody other than the person it works for, that reached a person, and that nothing during the
 * call already settled — the only kind it can change is the "spoke to someone, settled nothing" one.
 */
export function judgeable(row, transcript = row?.transcript) {
  if (!row) return false;
  // Their own call (either way round) is read too, for how it went; a call to somebody else, as before,
  // only one Reason placed.
  if (Number(row.is_owner) !== 1 && String(row.direction ?? "out") !== "out") return false;
  if (row.outcome_kind !== "dropped_before_confirmation") return false;
  return theySpoke(transcript) === true;
}

/**
 * May the read say this call met its goal, or that it was only a chat? Not a call cleared to book or
 * one that got as far as a commitment: those are settled by the read-back gate and nothing else, and
 * the model is never the route by which something counts as booked — or as not booked.
 */
function goalReadable(row) {
  if (!String(row.goal ?? "").trim()) return false;
  return !mayHaveBooked(row);
}

/** Cleared to book, or got as far as a commitment: something may be half-agreed at that number. */
function mayHaveBooked(row) {
  if (parse(row.brief)?.approved?.book === true) return true;
  return Boolean(row.conversation_id && db.callCommitments(row.conversation_id, row.id).length);
}

/** The outcome a read moves this row to, or "" to leave it. */
export function kindFrom(row, verdict) {
  if (!verdict) return "";
  if (MACHINE_HOW.has(verdict.how)) return mayHaveBooked(row) ? "" : KIND_FOR[verdict.how];
  // Their own call: a conversation, never an errand's success (no seal on the book for it).
  if (Number(row.is_owner) === 1) return verdict.how === "hung_up_early" ? "hung_up_early" : verdict.how === "talked" || verdict.met ? "talked" : "";
  if (!goalReadable(row)) return "";
  if (verdict.met) return "goal_met";
  return KIND_FOR[verdict.how] ?? "";
}
const parse = (s) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? {}); } catch { return {}; } };

/**
 * The model's read: `{ met, why }`, or null when it could not be asked or did not answer cleanly.
 * `ask` is the structured side call (src/backends/side.js); tests pass their own.
 */
export async function judgeGoal(row, { transcript = row?.transcript, ask = askStructured } = {}) {
  if (ask === askStructured && !sideAskAllowed()) return null;
  let out;
  try {
    out = await ask({
      prompt: promptFor(row, transcript),
      system: SYSTEM,
      schema: SCHEMA,
      model: process.env.REASON_GOAL_CLI_MODEL || "sonnet",
      timeoutMs: 60_000,
      feature: "call_goal",
    });
  } catch (e) { return null; }
  const { value, error } = out ?? {};
  if (error || typeof value?.met !== "boolean") return null;
  const how = HOW.includes(value.how) ? value.how : "unsure";
  return { met: value.met, how, why: String(value.why ?? "").replace(/\s+/g, " ").trim().slice(0, 300) };
}

// One question per call per process; a second settle of the same call waits on the first.
const pending = new Map();

/**
 * Ask, and if the goal was met move the row to `goal_met` — which is what tells the stamps (the
 * update goes through db.updateCall, so the completion bus hears it). Only from
 * `dropped_before_confirmation`, read again just before writing, so anything that settled the call
 * some other way in the meantime wins. Never throws. Resolves to the row as it then stands.
 */
export function settleGoal(conversationId, row, { ask, log = () => {} } = {}) {
  if (!judgeable(row)) return Promise.resolve(row);
  if (pending.has(row.id)) return pending.get(row.id);
  const run = (async () => {
    let read = row;
    // A transcript can still be arriving (Bland's lands seconds after the call ends, and a late
    // webhook fills the rest in): when the row's has grown since it was read, it is read again.
    for (let tries = 0; tries < 3; tries++) {
      const verdict = await judgeGoal(read, ask ? { ask } : {});
      const now = db.getCall(conversationId, row.id) ?? read;
      if (verdict) log({ call_goal: row.id, met: verdict.met, how: verdict.how });
      else log({ call_goal_unjudged: row.id });
      const kind = kindFrom(now, verdict);
      if (kind && now.outcome_kind === "dropped_before_confirmation") {
        // Only the kind: `outcome` stays the provider's own word for how the call went.
        return db.updateCall(conversationId, row.id, { outcome_kind: kind });
      }
      if (!judgeable(now) || String(now.transcript ?? "").length <= String(read.transcript ?? "").length) return now;
      read = now;
    }
    return db.getCall(conversationId, row.id) ?? row;
  })().catch(e => { log({ call_goal_failed: (e?.message ?? String(e)).split("\n")[0] }); return row; })
    .finally(() => pending.delete(row.id));
  pending.set(row.id, run);
  return run;
}

/** The question still being asked about this call, if one is (so a status read can wait for it). */
export const goalPending = (id) => pending.get(id) ?? null;
