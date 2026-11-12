// One timing line per reply: `{"reply_timing": <conversation>, <stage>_ms: …, total_ms: …}`.
//
// Written down on 2026-11-11, when replies got slower and the journal could only say so in
// averages: the gap between "read" and the anchor, the gap between the model and the send. This
// is the breakdown — how long each stage of one reply took — in numbers only. No words of theirs,
// no words of Reason's, no figure out of either message; the conversation id is the only name.
//
// Stages, in the order they happen on a text:
//   hold     the last text's arrival → the turn taking it (the burst window, src/channels/router.js)
//   hear     voice notes and contact cards read
//   prep     history rows, requests, the event log → the runtime is asked
//   queue    waiting behind the conversation's other turns (Runtime.enqueue) and the screen's start
//   recall   the memory lookup (src/memorynote.js), measured from the turn's start
//   media    pictures, PDFs, documents, videos fetched and read
//   notes    the notes the prompt carries (purchases, open work, what stands) and the recall awaited
//   anchor   the history split (historyParts)
//   mcp      the loopback tool server started
//   model    the CLI run, spawn → envelope (one or several model calls and their tools)
//   post     the figures guard and the thread saved
//   check    the said check in front of the send
//   rewrite  the one rewrite the check or the guard asked for (0 when none)
//   send     the reply handed to the channel (_emit)
//   total    the last text's arrival → the send done
//
// Turns for one conversation run one at a time (Runtime.enqueue), so one open record per
// conversation is enough. A stage no turn reached is simply absent. Never throws, never awaited.
const open = new Map();

/** Start a record. `at` is when the last text arrived (its row), `now` is the clock. */
export function begin(conversationId, { at = Date.now(), now = Date.now() } = {}) {
  if (!conversationId) return;
  open.set(conversationId, { at, last: now, stages: {} });
}

/** Is a record open for this conversation? */
export const isOpen = (conversationId) => open.has(conversationId);

/** Close `stage`: the time since the last mark (or the start) is its duration. No record: nothing. */
export function mark(conversationId, stage, { now = Date.now() } = {}) {
  const r = open.get(conversationId);
  if (!r) return;
  r.stages[`${stage}_ms`] = Math.max(0, now - r.last);
  r.last = now;
}

/** Note a duration measured elsewhere (a promise that ran beside other stages). */
export function note(conversationId, stage, ms) {
  const r = open.get(conversationId);
  if (!r || !Number.isFinite(ms)) return;
  r.stages[`${stage}_ms`] = Math.max(0, Math.round(ms));
}

/** Reset the mark clock without closing a stage (a stage that should not count what came before). */
export function touch(conversationId, { now = Date.now() } = {}) {
  const r = open.get(conversationId);
  if (r) r.last = now;
}

/** Write the line and forget the record. `extra` is numbers or short codes only, never text. */
export function finish(conversationId, log = () => {}, { now = Date.now(), ...extra } = {}) {
  const r = open.get(conversationId);
  if (!r) return null;
  open.delete(conversationId);
  const line = { reply_timing: conversationId, ...r.stages, total_ms: Math.max(0, now - r.at), ...extra };
  try { log(line); } catch { /* a timing line is never worth a turn */ }
  return line;
}

/** Drop a record without a line (a turn that never ran: outage, interrupted, nothing to answer). */
export function drop(conversationId) { open.delete(conversationId); }

/** For tests. */
export const resetTiming = () => open.clear();
