// What a call carries over: into the next call, and into the text after it (call audit, 2026-11-11).
//
// Call 85 (Mon 11-09, 5:50 PM, on his way to a night shift): eleven minutes on the launch — "tomorrow by
// this time the ads are already launched" — and a yes to "want me to put together a pre-launch checklist
// from your notes?". Memory kept all of it (some 25 facts were saved from that call). The next call, 25
// hours later to the minute (call 86), started with none of it, and so did every call after:
//
//   - Reason's call turn reads the newest `config.callHistoryTurns` (12) thread lines, and a call writes
//     one line per fragment of speech, so a call from the morning is far out of reach by the afternoon;
//   - "today so far" (./brief.js) reads the `messages` table, which holds texts — a call is written to
//     the thread and the event log (./postcall.js), never there — so it is blind to calls by design;
//   - the voice's pre-call brief had the same two holes, plus one more: it was never told what day or
//     time it is. Call 94 (Wed 11-11, 9:26 PM): "you're off at 8, yeah?" from a Thursday-to-Sunday
//     schedule fact, on a Wednesday. "I'm not working today."
//   - the checklist was never made: nothing after the call was handed what Reason had said it would do.
//
// So, behind REASON_CALL_CARRYOVER (off | owner | on, read like REASON_CALL_MANNER):
//
//   1. when a person's own call ends, one short read of it — what they told Reason, what Reason said it
//      would do, what was left open — is kept on the call's own row (`calls.summary`, sealed with it);
//   2. their next calls start with those reads for the last two days (`earlierCallsNote`), in the voice's
//      brief and in Reason's call turn; a call whose read did not come back still gives their own words;
//   3. the voice's brief says what day and time it is, what is due in the next day and which jobs are open;
//   4. the voice may bring up the one most relevant open thing after the hello (`CARRY_VOICE_LINES`);
//   5. the after-call turn is handed what Reason said it would do, to do it or say when (`promisedNote`).
//
// Only the call row's own conversation is ever read: nothing of anyone else's, and never a call to a
// business or another person (those are not this person's words).
import * as accounts from "../accounts.js";
import * as db from "../db.js";
import { config, clock } from "../config.js";
import { askStructured, sideAskAllowed } from "../backends/side.js";
import { SPOKE_TO_SOMETHING } from "./provider.js";
import { answeredByMachine } from "./outcome.js";

/** Is the carry-over on for calls of this conversation's account? */
export function carryoverFor(conversationId) {
  const v = config.callCarryover;
  if (v === "on") return true;
  if (v !== "owner" || !conversationId) return false;
  try { return accounts.ownerOf(conversationId)?.isOperator === true; } catch { return false; }
}

// ---------- reading a call that just ended ----------

const LABELS = { told: "They told you", promised: "You said you'd", open: "Left open" };
const ITEMS = 4;
const ITEM_CHARS = 160;

const SYSTEM = "You read a phone call between a person (Them) and their AI assistant (Reason), and note what the assistant must still know on their next call."
  + " Only what was actually said. The line can garble words; leave out anything you cannot make sense of rather than guess. Reply with the JSON asked for, nothing else.";
const SCHEMA = {
  type: "object",
  properties: {
    told: { type: "array", items: { type: "string" }, maxItems: ITEMS },
    promised: { type: "array", items: { type: "string" }, maxItems: ITEMS },
    open: { type: "array", items: { type: "string" }, maxItems: ITEMS },
  },
  required: ["told", "promised", "open"],
  additionalProperties: false,
};

export function carryPrompt(transcript) {
  return `${String(transcript ?? "").slice(-12_000)}\n\n`
    + "From this call, in short plain phrases (a dozen words each at most, no names of other people's private details beyond what Them said):\n"
    + "- told: what Them told Reason that still matters later — where they are or are headed, what they plan to do and by when, how they feel, a decision, a preference. Not small talk, not questions Reason already answered.\n"
    + "- promised: what Reason said it would do or send that the call itself did not show as done (\"I'll text you those\", an offer Them said yes to). Nothing Them declined.\n"
    + "- open: anything left hanging — a question nobody answered, something Them started and dropped, a \"let me call you back\" about a topic.\n"
    + "Empty lists are right for a call with nothing of that kind.";
}

const tidy = (s) => String(s ?? "").replace(/[\n;]+/g, ",").replace(/\s+/g, " ").trim().replace(/[.,]+$/, "").slice(0, ITEM_CHARS);
const listOf = (v) => (Array.isArray(v) ? v : []).map(tidy).filter(Boolean).slice(0, ITEMS);

/** The read as the text kept on the row: one labelled line per kind that has anything, or "". */
export function carryText({ told = [], promised = [], open = [] } = {}) {
  return [["told", told], ["promised", promised], ["open", open]]
    .map(([k, v]) => [LABELS[k], listOf(v)])
    .filter(([, v]) => v.length)
    .map(([label, v]) => `${label}: ${v.join("; ")}`)
    .join("\n");
}

/** One kind back out of the kept text: `itemsFrom(summary, "promised")`. */
export function itemsFrom(summary, kind) {
  const label = LABELS[kind];
  if (!label) return [];
  const line = String(summary ?? "").split("\n").find(l => l.startsWith(`${label}: `));
  return line ? line.slice(label.length + 2).split("; ").map(s => s.trim()).filter(Boolean) : [];
}

/** A person's own call that a person was really on (not a business call, a voicemail or a dead line). */
export function wasTheirCall(row) {
  if (!row || Number(row.is_owner) !== 1) return false;
  if (!SPOKE_TO_SOMETHING.includes(row.state) || row.state === "voicemail") return false;
  if (answeredByMachine(row) || row.outcome_kind === "line_silent") return false;
  return theirLines(row.transcript).length > 0;
}

/** Their side of a transcript string, fragments of one breath joined ("I'm good, how are" + "you"). */
export function theirLines(transcript) {
  const out = [];
  let run = null;
  for (const raw of String(transcript ?? "").split("\n")) {
    const m = /^(Them|Reason)\s*:\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const text = m[2].trim();
    if (m[1] === "Them") {
      if (!text) continue;
      if (run) run.text = `${run.text} ${text}`.replace(/\s+,/g, ",");
      else { run = { text }; out.push(run); }
    } else if (text.split(/\s+/).length > 3) {
      // A real reply ends their breath; a "Yeah," laid over them does not.
      run = null;
    }
  }
  return out.map(r => r.text.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The model's read of the call, `{ told, promised, open }`, or null when it could not be asked. Never throws. */
export async function readCall(row, { ask = askStructured } = {}) {
  if (ask === askStructured && !sideAskAllowed()) return null;
  let out;
  try {
    out = await ask({
      prompt: carryPrompt(row.transcript), system: SYSTEM, schema: SCHEMA,
      model: process.env.REASON_CARRY_CLI_MODEL || "sonnet", timeoutMs: 45_000, feature: "call_carryover",
    });
  } catch { return null; }
  const v = out?.value;
  if (out?.error || !v || !Array.isArray(v.told) || !Array.isArray(v.promised) || !Array.isArray(v.open)) return null;
  return { told: listOf(v.told), promised: listOf(v.promised), open: listOf(v.open) };
}

// One read per call per process; a second settle of the same call waits on the first.
const pending = new Map();
export const carryPending = (id) => pending.get(id) ?? null;

/**
 * Read a person's own finished call and keep the read on its row. Resolves to the row as it then
 * stands; null (nothing started) when the flag is off for them, it was not their call, or the row
 * already has a read. Never throws, never guesses: no answer leaves the row as it was.
 */
export function settleCarry(row, { ask, log = () => {} } = {}) {
  if (!row || !carryoverFor(row.conversation_id) || !wasTheirCall(row) || String(row.summary ?? "").trim()) return null;
  if (pending.has(row.id)) return pending.get(row.id);
  const run = (async () => {
    const read = await readCall(row, ask ? { ask } : {});
    if (!read) { log({ call_carry_unread: row.id }); return row; }
    const text = carryText(read);
    log({ call_carry: row.id, told: read.told.length, promised: read.promised.length, open: read.open.length });
    if (!text) return row;
    return db.updateCall(row.conversation_id, row.id, { summary: text }) ?? row;
  })().catch(e => { log({ call_carry_failed: row.id, why: (e?.message ?? String(e)).split("\n")[0] }); return row; })
    .finally(() => pending.delete(row.id));
  pending.set(row.id, run);
  return run;
}

// ---------- going into the next call ----------

/** How far back a call still rides along, how many, and how long the note may run. */
export const CARRY_HOURS = 48;
export const CARRY_CALLS = 4;
export const CARRY_CHARS = 2000;
const CALL_CHARS = 620;
const WORDS_CHARS = 380;

const clip = (t, n) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };
const dayKey = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** "today 9:57 AM", "yesterday 5:50 PM", "Mon 5:50 PM" — relative to `now`, where they are. */
export function whenSpoken(ms, now, tz = config.tz) {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  const d = dayKey(ms, tz);
  if (d === dayKey(now, tz)) return `today ${time}`;
  if (d === dayKey(now - 24 * 3600_000, tz)) return `yesterday ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms))} ${time}`;
}

/** What one earlier call left: its kept read, or — when there is none — their own words from it. */
export function callLine(row, { now = clock.now(), tz = config.tz } = {}) {
  const mins = row.duration_s ? Math.max(1, Math.round(row.duration_s / 60)) : 0;
  const head = `- ${whenSpoken(row.created_at, now, tz)}, ${row.direction === "in" ? "they called" : "you rang them"}${mins ? `, ${mins} min` : ""}`;
  const kept = String(row.summary ?? "").trim();
  if (kept) return `${head}: ${clip(kept.replace(/\n/g, ". "), CALL_CHARS)}`;
  const said = theirLines(row.transcript).filter(l => l.length >= 20);
  if (!said.length) return "";
  return `${head} (their own words, as the line heard them): ${clip(said.map(l => `"${l}"`).join(" "), WORDS_CHARS)}`;
}

/**
 * Their own earlier calls, for this call's prompt, or "". Read once per call (the same words on every
 * turn, so the prompt cache holds), up to when this call was made.
 */
export function earlierCallsNote(call, { tz = config.tz } = {}) {
  if (!call?.conversation_id || Number(call.is_owner) !== 1 || !carryoverFor(call.conversation_id)) return "";
  const until = Number(call.created_at) || clock.now();
  const key = `${call.conversation_id}#${call.id}#${until}#${tz}`;
  if (kept.has(key)) return kept.get(key);
  let rows = [];
  try { rows = db.listCalls(call.conversation_id, { limit: 30 }); } catch { return ""; }
  const lines = [];
  let used = 0;
  // Newest first off the table; the note reads oldest first.
  for (const r of rows) {
    if (r.id === call.id || Number(r.created_at) >= until || Number(r.created_at) < until - CARRY_HOURS * 3600_000) continue;
    if (!wasTheirCall(r)) continue;
    const line = callLine(r, { now: until, tz });
    if (!line) continue;
    if (used + line.length > CARRY_CHARS) break;
    lines.unshift(line);
    used += line.length;
    if (lines.length >= CARRY_CALLS) break;
  }
  const note = lines.length
    ? "EARLIER CALLS with them, newest last (your own record of your calls, kept by code): what they told you, what you said you'd do, what was left open."
      + " You were on these calls — never ask again for something here, and if something you said you'd do is still open, own it.\n"
      + lines.join("\n")
    : "";
  kept.set(key, note);
  if (kept.size > 200) kept.delete(kept.keys().next().value);
  return note;
}
const kept = new Map();

/** For tests: forget every call's note. */
export function resetCarryover() { kept.clear(); pending.clear(); }

/** What day and time it is where they are — the live voice is told nothing about the clock otherwise. */
export function nowLine(call, { tz = config.tz } = {}) {
  if (!call?.conversation_id || !carryoverFor(call.conversation_id)) return "";
  const at = Number(call.created_at) || clock.now();
  const when = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
  return `Right now, where they are: ${when}. Their schedule and routines in this brief are standing patterns, not today's plan:`
    + " work out from today's day and time whether one applies before you mention it, and when you can't tell, ask (\"you working today?\") rather than say it as fact.";
}

const SOON_HOURS = 24;

/** Reminders due in the next day and the jobs still open, for the voice's brief, or "". */
export function comingUpNote(call, { tz = config.tz } = {}) {
  if (!call?.conversation_id || Number(call.is_owner) !== 1 || !carryoverFor(call.conversation_id)) return "";
  const at = Number(call.created_at) || clock.now();
  const lines = [];
  try {
    const due = db.listTimers(call.conversation_id).filter(t => Number(t.fire_at) > at && Number(t.fire_at) <= at + SOON_HOURS * 3600_000).slice(0, 4);
    for (const t of due) lines.push(`- reminder ${whenSpoken(t.fire_at, at, tz).replace(/^yesterday /, "")}: ${clip(t.note, 120)}`);
  } catch { /* no timers to read */ }
  try {
    for (const t of db.listTasks(call.conversation_id).slice(0, 3)) {
      const title = clip(t.short_title || t.title || t.goal, 100);
      if (title) lines.push(`- job still open: ${title}`);
    }
  } catch { /* no jobs to read */ }
  return lines.length ? `Coming up and still open (from your own records):\n${lines.join("\n")}` : "";
}

/** Added to the voice's instructions on their own call. */
export const CARRY_VOICE_LINES = [
  "If the brief shows one thing that is clearly still live between you — something you said you'd do on an earlier call, a plan of theirs with a time on it that has come round, a reminder due in the next few hours —"
    + " bring up that ONE thing yourself, once, in a short sentence after the hello, as a question, then let them lead (\"hey — did the ads go out in the end?\")."
    + " Only one; not when you rang them for a reason you were given (that reason comes first); not if they've already said why they're calling; and if nothing stands out, don't force it.",
  "Never ask for something an earlier call or the brief already told you.",
];

/** Added to Reason's own call turn. */
export const CARRY_TURN_LINE = "If EARLIER CALLS shows something you said you'd do that is still not done, say so plainly when it comes up and do it now if you can — don't wait to be reminded.";

// ---------- after the call ----------

/** For the after-call turn: what Reason said on the call it would do, or "". */
export function promisedNote(row) {
  if (!row || !carryoverFor(row.conversation_id)) return "";
  const promised = itemsFrom(row.summary, "promised");
  if (!promised.length) return "";
  return `\nOn the call you said you'd: ${promised.map(p => p.replace(/"/g, "'")).join("; ")}.`
    + " Go through them against what you really did (the call above and your record of its lookups). Anything not done yet: do it now with your tools, or set it up,"
    + " and send ONE short text with what's done and what's coming and when — that text IS owed. Anything that books, buys, pays or messages someone else still needs their yes as usual."
    + " If every one of them was already done on the call, NO_REPLY.";
}
