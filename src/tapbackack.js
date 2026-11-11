// A fixed-meaning tapback the moment a text is handed to the model (REASON_TAPBACK_ACK).
//
// Anything that reaches the model takes more than a few seconds, and the typing bubble says only
// "something is happening". A tapback on their own message says WHAT: seen, looking something up,
// done, a reminder set. The vocabulary is one map, here, and nowhere else — the model never picks
// these (its own tapbacks are the `react` tool, src/tapbacks.js, and stay the model's).
//
//   👀  seen / on it          put on their text as its turn starts
//   🔍  looking it up         swapped in when the turn runs a lookup tool
//   ⏰  reminder or timer set  swapped in when timer_set succeeds
//   ✅  done                   swapped in when an action of this turn worked, or when the background
//                             job the text started finishes
//
// A swap is "-old" then "new" on the SAME message (Sendblue removes a reaction by the same value with
// a leading '-'; src/expressive.js checkReaction). The handle is the message's BASE handle, read off
// the thread the way src/tapbacks.js reads it, so a text that arrived as three parts gets one tapback
// on the message and not a 422 on its last part (test/parts.test.js).
//
// Two rules keep it from being noise:
//   - a tapback and a text never say the same thing: a reply that is only "on it" / "got it" after 👀
//     went is dropped (isBareAck), because the tapback was that reply;
//   - everything in here is best-effort and serialised per conversation, and nothing in it can cost
//     a reply — a failed tapback is a log line.
import * as db from "./db.js";
import { sendTapback } from "./tapbacks.js";
import { tapbackAckOn } from "./trustflags.js";

/** The whole vocabulary. One meaning per emoji; change it here or nowhere. */
export const ACK = Object.freeze({
  seen: "👀",
  looking: "🔍",
  done: "✅",
  timer: "⏰",
});

/** Tools whose running means "looking something up" rather than answering from what is known. */
export const LOOKUP_TOOLS = new Set([
  "web_search", "web_read", "browser_open", "flight_search", "nearby_places", "research_start", "transit_status", "weather",
]);

/**
 * A reply that only acknowledges — the words a tapback already said. Short, and only these shapes:
 * a longer reply that happens to start "on it" still carries something and still goes.
 */
const BARE_ACK = /^(?:ok(?:ay)?|on it|got it|gotcha|noted|sure(?: thing)?|will do|k|👍|👀|✅|looking(?: into it| now)?|checking(?: now)?|one (?:sec|moment|minute)|give me a (?:sec|minute|moment))[.!]*$/i;
export function isBareAck(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= 40 && BARE_ACK.test(t);
}

/** conversationId → { handle, state, chain } — what is on their last message right now. */
const live = new Map();
/** taskId → handle: the text that started a background job, so its finish can land a ✅ on it. */
const byTask = new Map();

const entry = (c) => {
  let e = live.get(c);
  if (!e) { e = { handle: null, state: null, chain: Promise.resolve() }; live.set(c, e); }
  return e;
};

/** What is on their message now (the state name), or null. For the bare-ack rule and for tests. */
export function current(conversationId) {
  const e = live.get(conversationId);
  return e?.state ?? null;
}

/**
 * Put `state`'s tapback on their message, swapping whatever this module put there before. Serialised
 * per conversation so a 👀 asked for and a 🔍 asked for a moment later land in that order. Returns a
 * promise of `{ ok, state, handle }` or `{ ok: false, skipped }`; never rejects.
 *
 * `handle` names the message when the caller knows it (a job's origin text); otherwise the thread's
 * last inbound message — its base handle, which is what the router stores (src/channels/router.js).
 */
export function mark(conversationId, state, { channels, handle = null, log = () => {} } = {}) {
  const emoji = ACK[state];
  if (!emoji) return Promise.resolve({ ok: false, skipped: `no such state '${state}'` });
  if (!tapbackAckOn(conversationId)) return Promise.resolve({ ok: false, skipped: "off" });
  const e = entry(conversationId);
  const run = async () => {
    const thread = db.getThread(conversationId);
    const target = handle ?? thread?.last_inbound_id ?? null;
    if (!target) return { ok: false, skipped: "no message of theirs" };
    // The same thing again, on the same message: nothing to do.
    if (e.handle === target && e.state === state) return { ok: true, state, handle: target, unchanged: true };
    // Off with the old one first, only when it is on THIS message: a new text of theirs starts clean.
    if (e.handle === target && e.state && ACK[e.state] !== emoji) {
      const off = await sendTapback({ conversationId, channels, reaction: `-${ACK[e.state]}`, messageHandle: target });
      if (!off.ok) log({ tapback_ack_remove_failed: ACK[e.state], conversation: conversationId, why: off.error });
    }
    const on = await sendTapback({ conversationId, channels, reaction: emoji, messageHandle: target });
    if (!on.ok) {
      log({ tapback_ack_failed: emoji, conversation: conversationId, why: on.error });
      // A line or thread that cannot carry one is not asked again this turn.
      e.handle = target; e.state = null;
      return { ok: false, state, handle: target, error: on.error };
    }
    e.handle = target; e.state = state;
    log({ tapback_ack: emoji, state, conversation: conversationId });
    return { ok: true, state, handle: target };
  };
  const p = e.chain.then(run, run).catch((err) => {
    log({ tapback_ack_threw: state, conversation: conversationId, why: (err?.message ?? String(err)).split("\n")[0] });
    return { ok: false, state, error: err?.message ?? String(err) };
  });
  e.chain = p;
  return p;
}

/** Wait for whatever this conversation has queued (tests, and the runtime before it reads `current`). */
export function settled(conversationId) {
  return live.get(conversationId)?.chain ?? Promise.resolve();
}

/** A turn's text started a background job: remember which message, so its finish lands on it. */
export function noteTask(conversationId, taskId, { handle = null } = {}) {
  if (!tapbackAckOn(conversationId) || taskId == null) return;
  const h = handle ?? live.get(conversationId)?.handle ?? db.getThread(conversationId)?.last_inbound_id ?? null;
  if (h) byTask.set(`${conversationId}:${taskId}`, h);
}

/** The job finished well: 👀 → ✅ on the text that started it. */
export function taskDone(conversationId, taskId, { channels, log = () => {} } = {}) {
  const key = `${conversationId}:${taskId}`;
  const h = byTask.get(key) ?? db.getTaskAnywhere(taskId)?.origin_handle ?? null;
  byTask.delete(key);
  if (!h) return Promise.resolve({ ok: false, skipped: "no origin text" });
  return mark(conversationId, "done", { channels, handle: h, log });
}

/**
 * One tool of a turn ran. A lookup tool means "looking it up"; a timer set means "reminder set"; a
 * job started is remembered; a job finished `done` is the swap to ✅. Called from runTool
 * (src/tools.js); never awaited there.
 */
export function noteTool(ctx, name, out) {
  const c = ctx?.conversationId;
  if (!c || !tapbackAckOn(c)) return;
  const opts = { channels: ctx.channels ?? null, log: ctx.log ?? (() => {}) };
  const ok = out && typeof out === "object" && out.ok !== false && !out.error && !out.blocked;
  const n = String(name);
  if (LOOKUP_TOOLS.has(n) && current(c) === "seen") { void mark(c, "looking", opts); return; }
  if (n === "timer_set" && ok) { void mark(c, "timer", opts); return; }
  if (n === "task_start" && ok && out.task?.id != null) { noteTask(c, out.task.id, { handle: ctx.answering?.handle ?? null }); return; }
  if (n === "task_finish" && ok && out.task?.state === "done" && out.task?.id != null) { void taskDone(c, out.task.id, opts); }
}

/**
 * The turn's words went out. An action of this turn that worked — and no job left running — is done:
 * 👀/🔍 → ✅. A turn that only answered leaves what is there: "seen" and "looked it up" stay true.
 */
export function afterReply(conversationId, { acts = [], tasks = null, channels, log = () => {} } = {}) {
  if (!tapbackAckOn(conversationId)) return Promise.resolve({ ok: false, skipped: "off" });
  const acted = (acts ?? []).some(a => a.acting && a.ok);
  const running = tasks && typeof tasks.size === "number" ? tasks.size > 0 : false;
  const state = current(conversationId);
  if (!acted || running || !state || state === "done" || state === "timer") return Promise.resolve({ ok: false, skipped: "nothing to swap" });
  return mark(conversationId, "done", { channels, log });
}

/** For tests: forget everything. */
export function reset() { live.clear(); byTask.clear(); }
