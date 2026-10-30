// The history anchor: the older part of the conversation rides at the end of the system prompt, byte
// for byte the same from turn to turn, so the prompt cache reads it instead of writing it again
// (speed audit 2026-10-27 §1 and the capacity report of the same day, §4d: 23k tokens written per
// reply because the 40-message window slid every turn).
//
// What must hold: the model is shown the same messages it was shown before — every one of the newest
// 40, in order, across system + user message — never fewer; and two turns in a row share the system
// prompt exactly.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-anchor-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { runTurnViaCli, historyParts, renderHistory, systemWithAnchor, resetAnchors, ANCHOR_RECENT_MAX, ANCHOR_MAX_MS, SYSTEM_MAX_BYTES } = await import("../src/backends/claude-cli.js");
const { systemFor } = await import("../src/agent.js");
const onethought = await import("../src/onethought.js");

const C = "dm:owner";
const noMcp = async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} });
const none = async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] });
const exchange = (i) => [{ role: "user", content: `[10:${String(i % 60).padStart(2, "0")}] Omari: question ${i}` }, { role: "assistant", content: `answer ${i}` }];
const thread = (n) => Array.from({ length: n }, (_, i) => exchange(i)).flat();

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { resetAnchors(); db.saveConversation(C, []); });

test("the first turn anchors the whole window; the next turns add only what followed, under the same anchor", () => {
  const msgs = thread(30); // 60 messages; the window is the newest 40
  const t1 = historyParts("h", msgs, { now: 1_000 });
  assert.equal(t1.recent.length, 0);
  assert.deepEqual(t1.anchor.split("\n"), renderHistory(msgs), "the anchor is exactly the 40 lines the model used to see");
  assert.match(t1.anchor.split("\n")[0], /question 10$/);
  // Two turns later.
  const more = [...msgs, ...exchange(30), ...exchange(31)];
  const t2 = historyParts("h", more, { now: 2_000 });
  assert.equal(t2.anchor, t1.anchor, "byte-identical anchor");
  assert.deepEqual(t2.recent, renderHistory(more).slice(-4), "only the four new lines are new");
  // Everything in the newest 40 is still shown, in order, across the two parts.
  const shown = [...t2.anchor.split("\n"), ...t2.recent];
  const window = renderHistory(more);
  assert.deepEqual(shown.slice(-window.length), window, "the newest 40 are all there, in order");
  assert.ok(shown.length >= window.length);
});

test("past ANCHOR_RECENT_MAX newer messages the anchor moves to the current window, and the model never sees fewer than 40", () => {
  let msgs = thread(25);
  const first = historyParts("h", msgs, { now: 1_000 }).anchor;
  let last = null;
  for (let i = 25; i < 25 + ANCHOR_RECENT_MAX / 2; i++) {
    msgs = [...msgs, ...exchange(i)];
    last = historyParts("h", msgs, { now: 1_000 + i });
    assert.equal(last.anchor, first, `turn ${i}: still the first anchor`);
    assert.equal(last.recent.length, 2 * (i - 24));
  }
  assert.equal(last.recent.length, ANCHOR_RECENT_MAX);
  // One more exchange: 22 newer than the anchor — reset to the newest 40, nothing recent.
  msgs = [...msgs, ...exchange(99)];
  const reset = historyParts("h", msgs, { now: 5_000 });
  assert.notEqual(reset.anchor, first);
  assert.deepEqual(reset.anchor.split("\n"), renderHistory(msgs));
  assert.deepEqual(reset.recent, []);
});

test("an anchor older than ANCHOR_MAX_MS, or whose end is gone from the thread, is set again", () => {
  const msgs = thread(25);
  const a = historyParts("h", msgs, { now: 1_000 }).anchor;
  const stale = historyParts("h", [...msgs, ...exchange(25)], { now: 1_000 + ANCHOR_MAX_MS + 1 });
  assert.notEqual(stale.anchor, a);
  assert.deepEqual(stale.recent, []);
  // Its end edited away (the thread is cut from the front past the anchor's tail): re-anchored.
  historyParts("g", msgs, { now: 1_000 });
  const cut = historyParts("g", thread(80).slice(-40), { now: 2_000 });
  assert.deepEqual(cut.recent, []);
  assert.match(cut.anchor.split("\n").at(-1), /answer 79$/);
});

test("a repeated assistant line does not fool the anchor's end: the last two lines place it", () => {
  const msgs = [
    { role: "user", content: "[10:00] Omari: check the train" }, { role: "assistant", content: "on it." },
    { role: "user", content: "[10:01] Omari: and the bus" }, { role: "assistant", content: "on it." },
  ];
  const a = historyParts("h", msgs, { now: 1_000 });
  assert.equal(a.recent.length, 0);
  const more = [...msgs, { role: "user", content: "[10:02] Omari: also the ferry" }, { role: "assistant", content: "on it." }];
  const b = historyParts("h", more, { now: 2_000 });
  assert.equal(b.anchor, a.anchor);
  assert.deepEqual(b.recent, ["[10:02] Omari: also the ferry", "Reason: on it."], "both new lines are recent — the newest 'on it.' did not pass for the anchor's end");
});

test("a system prompt that would pass the argument limit gets no anchor: the history rides in the message as before", () => {
  const msgs = thread(25);
  const huge = "x".repeat(SYSTEM_MAX_BYTES - 1_000);
  const out = historyParts("h", msgs, { system: huge, now: 1_000 });
  assert.equal(out.anchor, "");
  assert.deepEqual(out.recent, renderHistory(msgs));
  assert.equal(systemWithAnchor(huge, ""), huge);
  // Nothing in the window is ever dropped to make it fit.
  assert.equal(out.recent.length, 40);
});

test("through a turn: identical system prompt on consecutive turns, the full window shown, the rewrite resumed under the same bytes", async () => {
  db.saveConversation(C, thread(22));
  const calls = [];
  const run = async (args) => { calls.push(args); return { ok: true, envelope: { result: `reply ${calls.length}` } }; };
  const turn = (extra = {}) => runTurnViaCli({ conversationId: C, text: "what's next", images: none, startMcp: noMcp, recall: async () => [], run, ...extra });

  await turn();
  const one = calls[0];
  const base = systemFor({ name: "Omari", isOperator: true });
  assert.ok(one.system.startsWith(base), "the person's system prompt comes first, untouched");
  assert.match(one.system, /The conversation so far, oldest first/);
  assert.match(one.system, /question 21\nReason: answer 21$/, "the anchor ends on the newest stored exchange");
  assert.match(one.prompt, /^The conversation so far is at the end of your instructions\.\n\nThe new message:/);
  assert.ok(!/question 21/.test(one.prompt), "nothing in the window is pasted twice");

  await turn({ text: "and after that?" });
  const two = calls[1];
  assert.equal(two.system, one.system, "the system prompt is the same bytes: a cache hit");
  assert.match(two.prompt, /^The conversation so far, continued \(the earlier part is at the end of your instructions\):\n\[.*\] Omari: what's next\nReason: reply 1\n\nThe new message:/);
  // Every one of the newest 40 messages is in front of the model, in order.
  const window = renderHistory(db.loadConversation(C).slice(0, -2)); // before this turn's own line and reply
  const shown = [...one.system.split("\n").slice(-40), ...two.prompt.split("\n\n")[0].split("\n").slice(1)];
  assert.deepEqual(shown.slice(-window.length), window);

  // The said check's rewrite continues the session under exactly the system it started with.
  resetAnchors();
  await turn({ text: "[Your draft reply was NOT sent…]", keep: onethought.CODE_LINE, continueSession: true });
  const three = calls[2];
  assert.ok(three.resume, "resumed");
  assert.equal(three.system, two.system, "same system bytes even though the anchor was forgotten in between");
  assert.ok(!/The conversation so far/.test(three.prompt));
});

test("a line rewritten inside the anchor (a redaction, a scrubbed password) sets it again: the model never reads the old text", () => {
  const msgs = thread(30);
  const t1 = historyParts("h", msgs, { now: 1_000 });
  assert.match(t1.anchor, /answer 20/);
  const redacted = msgs.map(m => m.content === "answer 20" ? { ...m, content: "[deleted at their request]" } : m);
  const t2 = historyParts("h", [...redacted, ...exchange(30)], { now: 2_000 });
  assert.doesNotMatch(t2.anchor, /answer 20\b/, "the old text is gone from the system prompt");
  assert.match(t2.anchor, /\[deleted at their request\]/);
  assert.deepEqual(t2.anchor.split("\n"), renderHistory([...redacted, ...exchange(30)]));
});

test("a line put in before a short anchor sets it again, so nothing of the newest 40 is missed", () => {
  const msgs = [{ role: "user", content: "[10:00] Omari: hi" }];
  const t1 = historyParts("h", msgs, { now: 1_000 });
  assert.equal(t1.anchor, "[10:00] Omari: hi");
  const inserted = [{ role: "assistant", content: "earlier note" }, ...msgs];
  const t2 = historyParts("h", inserted, { now: 2_000 });
  assert.deepEqual([...t2.anchor.split("\n"), ...t2.recent], renderHistory(inserted), "every line shown, in order");
});
