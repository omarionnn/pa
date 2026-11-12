// REASON_FAST_REPLY (src/fastreply.js), the reply-speed pass of 2026-11-11, and the timing line every
// reply now writes (src/replytiming.js). What must hold: with the switch off nothing changes; with it
// on the model is handed the same bytes it was before, in the same order, and only the clock moves.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fast-reply-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.REASON_FAST_REPLY;

const db = await import("../src/db.js");
const { fastReplyMode, fastReplyOn } = await import("../src/fastreply.js");
const timing = await import("../src/replytiming.js");
const said = await import("../src/said.js");
const background = await import("../src/background.js");
const { runTurnViaCli, historyParts, renderHistory, systemWithAnchor, resetAnchors, forgetReadAnchors, ANCHOR_MIN_LINES, SYSTEM_MAX_BYTES } = await import("../src/backends/claude-cli.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { config, clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const OTHER = "dm:sendblue:+15550000001";
const noMcp = async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} });
const none = async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] });
const exchange = (i) => [{ role: "user", content: `[10:${String(i % 60).padStart(2, "0")}] Omari: question ${i}` }, { role: "assistant", content: `answer ${i}` }];
const thread = (n) => Array.from({ length: n }, (_, i) => exchange(i)).flat();

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.REASON_FAST_REPLY;
  clock.reset?.();
  resetAnchors();
  forgetReadAnchors();
  rmSync(join(dir, "cli-anchors.json"), { force: true });
  timing.resetTiming();
  db.db.exec(`DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM outbox; DELETE FROM requests; DELETE FROM request_messages;
    DELETE FROM open_questions; DELETE FROM sent_claims;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.saidLedger = true;
  config.burstQuietMs = 20;
  config.burstMaxMs = 200;
  said.setRecorder(null);
  said.setChecker(null);
});

// ---------- the switch ----------

test("REASON_FAST_REPLY: off by default; owner = the operator's thread only; on = everybody", () => {
  assert.equal(fastReplyMode(), "off");
  assert.equal(fastReplyOn({ conversationId: C }), false);
  process.env.REASON_FAST_REPLY = "owner";
  assert.equal(fastReplyOn({ conversationId: C }), true);
  assert.equal(fastReplyOn({ conversationId: OTHER }), false);
  assert.equal(fastReplyOn({ isOperator: true }), true);
  process.env.REASON_FAST_REPLY = "on";
  assert.equal(fastReplyOn({ conversationId: OTHER }), true);
  process.env.REASON_FAST_REPLY = "nonsense";
  assert.equal(fastReplyMode(), "off");
});

// ---------- the timing line ----------

test("one reply_timing line per reply, numbers only, with every stage the turn went through", async () => {
  const lines = [];
  const runtime = new Runtime({
    log: (l) => lines.push(l),
    runTurn: async (args) => {
      db.saveConversation(args.conversationId, [...db.loadConversation(args.conversationId), { role: "user", content: `[now] Omari: ${args.text}` }, { role: "assistant", content: "sure thing" }]);
      return "sure thing";
    },
  });
  const router = new Router({ runtime, log: (l) => lines.push(l) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  await router.deliver({ channel: "fake", externalId: "T-1", from: OWNER, text: "what time is the train tomorrow at 7:45?", chatId: null, service: "iMessage" });
  const t0 = Date.now();
  while (!lines.some(l => l.reply_timing) && Date.now() - t0 < 3_000) await new Promise(r => setTimeout(r, 5));
  const t = lines.filter(l => l.reply_timing);
  assert.equal(t.length, 1, "exactly one timing line");
  const line = t[0];
  assert.equal(line.reply_timing, C);
  for (const [k, v] of Object.entries(line)) {
    if (k === "reply_timing") continue;
    assert.ok(Number.isFinite(v) && v >= 0, `${k} is a number: ${v}`);
  }
  for (const k of ["hold_ms", "hear_ms", "prep_ms", "queue_ms", "check_ms", "rewrite_ms", "send_ms", "total_ms"]) assert.ok(k in line, `${k} present`);
  assert.equal(line.sent, 1);
  assert.equal(line.rewritten, 0);
  assert.ok(line.total_ms >= line.hold_ms, "the total covers the hold");
  // Nothing of the message in the line: not its words, not its figure.
  assert.doesNotMatch(JSON.stringify(line), /train|7:45|745/);
  assert.equal(fake.sent.length, 1);
  assert.ok(!timing.isOpen(C), "the record is closed once the line is written");
});

test("the timing record is dropped, not written, when a turn never runs; stages are measured since the last mark", () => {
  timing.begin("x", { at: 1_000, now: 1_000 });
  timing.mark("x", "hold", { now: 3_500 });
  timing.mark("x", "prep", { now: 3_600 });
  timing.note("x", "recall", 420.4);
  timing.touch("x", { now: 9_000 });
  timing.mark("x", "send", { now: 9_250 });
  const out = timing.finish("x", () => {}, { now: 9_300 });
  assert.deepEqual(out, { reply_timing: "x", hold_ms: 2_500, prep_ms: 100, recall_ms: 420, send_ms: 250, total_ms: 8_300 });
  timing.begin("y");
  timing.drop("y");
  assert.equal(timing.finish("y"), null, "nothing for a turn that never ran");
  assert.equal(timing.mark("nobody", "hold"), undefined, "a mark with no record is nothing");
});

// ---------- §4: the said check is not asked when it cannot find anything ----------

test("cannotMatch: a figure, or a content word shared with a claim or a closed question, means the reader runs", () => {
  const claims = [{ id: 1, subject: "earliest showing at Alamo", value: "11:00am" }, { id: 2, subject: "closest gym to work", value: "the Equinox on Hudson" }];
  const closed = [{ id: 7, question: "want me to book the table at Carbone?" }];
  assert.equal(said.cannotMatch("sounds good, see you then", claims, closed), true);
  assert.equal(said.cannotMatch("haha yeah that one", claims, closed), true, "only common words");
  assert.equal(said.cannotMatch("it's at 11", claims, closed), false, "a figure");
  assert.equal(said.cannotMatch("the showing moved, fyi", claims, closed), false, "a claim's subject word");
  assert.equal(said.cannotMatch("equinox is the one", claims, closed), false, "a claim's value word");
  assert.equal(said.cannotMatch("shall i book carbone?", claims, closed), false, "a closed question's word");
  assert.equal(said.cannotMatch("ok 👍", claims, closed), true, "no words at all");
  assert.equal(said.cannotMatch("", [], []), true);
});

test("fast: a draft that shares nothing with what stands skips the check and puts the warm CLI down; off: the reader is asked as before", async () => {
  db.addClaim(C, { subject: "earliest showing at Alamo", value: "11:00am" });
  let asked = 0;
  said.setChecker(() => { asked++; return { changed_silently: [], asks_closed: [], unbacked: [] }; });
  let cancelled = 0;
  const warm = { cancel: () => { cancelled++; }, ask: async () => ({ value: {} }) };
  const logs = [];
  const off = await said.checkDraft({ conversationId: C, draft: "haha sounds good, see you there", acts: [], warm, log: (l) => logs.push(l) });
  assert.deepEqual(off, { ok: true });
  assert.equal(asked, 1, "off: the reader ran");
  const on = await said.checkDraft({ conversationId: C, draft: "haha sounds good, see you there", acts: [], warm, fast: true, log: (l) => logs.push(l) });
  assert.deepEqual(on, { ok: true, skipped: "nothing_to_match" });
  assert.equal(asked, 1, "fast: the reader was not asked");
  assert.equal(cancelled, 1, "the warm CLI was put down unasked");
  assert.ok(logs.some(l => l.said_check_skipped === C && l.why === "nothing_to_match"));
  // The same draft naming the thing is still read, fast or not.
  await said.checkDraft({ conversationId: C, draft: "the showing is fine, see you there", acts: [], warm, fast: true });
  assert.equal(asked, 2, "a draft about the claim's subject is read");
  // And a turn whose tools acted is always read: the claim check is about the tools, not the words.
  config.claimCheck = "acting";
  await said.checkDraft({ conversationId: C, draft: "sounds good", acts: [{ name: "store_checkout", ok: true, result: "started", links: [], acting: true }], warm, fast: true });
  assert.equal(asked, 3, "an acting tool's reply is read whatever the words");
});

// ---------- §1: the anchor fits instead of being dropped ----------

test("fast: when the whole window will not fit beside the system prompt, the oldest lines that fit are anchored and the model still sees every line in order; off: no anchor, as before", () => {
  const msgs = thread(25); // 50 messages; the window is the newest 40
  const window = renderHistory(msgs);
  const whole = Buffer.byteLength(window.join("\n"));
  // Room for about half the window.
  const system = "x".repeat(SYSTEM_MAX_BYTES - Math.floor(whole / 2) - 300);
  const logsOff = [];
  const off = historyParts("h", msgs, { system, now: 1_000, log: (l) => logsOff.push(l) });
  assert.equal(off.anchor, "", "off: dropped, as before");
  assert.deepEqual(off.recent, window);
  assert.equal(logsOff[0].history_anchor, "too_long");

  resetAnchors();
  const logs = [];
  const on = historyParts("h", msgs, { system, now: 1_000, log: (l) => logs.push(l), fast: true });
  assert.ok(on.anchor, "fast: an anchor");
  const anchored = on.anchor.split("\n");
  assert.ok(anchored.length >= ANCHOR_MIN_LINES && anchored.length < window.length, `${anchored.length} of ${window.length} lines anchored`);
  assert.deepEqual([...anchored, ...on.recent], window, "every line of the window, in order, across the two parts");
  assert.equal(logs[0].history_anchor, "fitted");
  assert.equal(logs[0].lines, anchored.length);
  assert.ok(Buffer.byteLength(systemWithAnchor(system, on.anchor)) <= SYSTEM_MAX_BYTES, "under the argument limit");

  // Two turns later: the same anchor bytes (a cache hit), the rest of the window and the new lines recent.
  const more = [...msgs, ...exchange(25), ...exchange(26)];
  const next = historyParts("h", more, { system, now: 2_000, log: (l) => logs.push(l), fast: true });
  assert.equal(next.anchor, on.anchor, "kept: byte-identical");
  assert.equal(logs.at(-1).history_anchor, "kept");
  assert.deepEqual([...next.anchor.split("\n"), ...next.recent].slice(-renderHistory(more).length), renderHistory(more), "the newest 40 are all shown, in order");
});

test("fast: a system prompt with room for fewer than ANCHOR_MIN_LINES lines still gets no anchor", () => {
  const msgs = thread(25);
  const system = "x".repeat(SYSTEM_MAX_BYTES - 120);
  const out = historyParts("h", msgs, { system, now: 1_000, fast: true });
  assert.equal(out.anchor, "");
  assert.deepEqual(out.recent, renderHistory(msgs));
});

// ---------- §2: anchors outlive a restart ----------

test("fast: an anchor set before a restart is the same bytes after it; off: a restart forgets, as before", () => {
  const msgs = thread(22);
  const logs = [];
  const first = historyParts("h", msgs, { now: 1_000, log: (l) => logs.push(l), fast: true });
  assert.equal(logs.at(-1).history_anchor, "new");
  assert.ok(existsSync(join(dir, "cli-anchors.json")), "written to the data dir");
  assert.ok(JSON.parse(readFileSync(join(dir, "cli-anchors.json"), "utf8")).h, "under the thread's id");
  // The process restarts.
  resetAnchors(); forgetReadAnchors();
  const again = historyParts("h", [...msgs, ...exchange(22)], { now: 2_000, log: (l) => logs.push(l), fast: true });
  assert.equal(again.anchor, first.anchor, "the same anchor: the cache on the other end is still a hit");
  assert.equal(logs.at(-1).history_anchor, "kept");
  assert.deepEqual(again.recent, renderHistory([...msgs, ...exchange(22)]).slice(-2));
  // Off: the file is not read.
  resetAnchors(); forgetReadAnchors();
  const off = historyParts("h", [...msgs, ...exchange(22)], { now: 3_000, log: (l) => logs.push(l) });
  assert.equal(logs.at(-1).history_anchor, "new");
  assert.notEqual(off.anchor, first.anchor);
});

// ---------- §3: the CLI starts before the prompt is ready ----------

test("fast: the turn's CLI is started with the system prompt and reads its message off stdin once the notes are in — the same system and the same message as before", async () => {
  db.saveConversation(C, thread(22));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.input) {
      const s = await args.input;
      args.sent = s == null ? null : JSON.parse(s);
    }
    return { ok: true, envelope: { result: `reply ${calls.length}` } };
  };
  let recalls = 0;
  const recall = async () => { recalls++; await new Promise(r => setTimeout(r, 20)); return ["RELEVANT MEMORIES:\n- travel: takes the 5 from gun hill (saved today)"]; };
  const turn = () => runTurnViaCli({ conversationId: C, text: "what's next", images: none, startMcp: noMcp, recall, run });

  await turn();
  const off = calls[0];
  assert.equal(typeof off.prompt, "string");
  assert.equal(off.input, undefined, "off: the prompt on the command line, as before");
  assert.match(off.prompt, /takes the 5 from gun hill/);

  db.saveConversation(C, thread(22));
  resetAnchors();
  process.env.REASON_FAST_REPLY = "owner";
  await turn();
  const on = calls[1];
  assert.equal(on.prompt, undefined, "fast: no prompt at spawn");
  assert.ok(on.input && typeof on.input.then === "function", "the message comes down stdin");
  assert.equal(on.sent.type, "user");
  const text = on.sent.message.content.find(b => b.type === "text").text;
  assert.equal(text, off.prompt, "the model reads exactly the message it read before");
  assert.equal(on.system, off.system, "under the same system prompt");
  assert.equal(on.sessionId.length > 0, true);
  assert.equal(recalls, 2);
  // The thread kept the same lines either way.
  assert.equal(db.loadConversation(C).at(-1).content, "reply 2");
});

test("fast: when the message cannot be built, the started CLI is put down unasked and the turn fails as it did", async () => {
  db.saveConversation(C, thread(3));
  process.env.REASON_FAST_REPLY = "on";
  let sent = "unset";
  const run = async (args) => { sent = await args.input; return { ok: false, cancelled: true, error: "the warm start was never asked anything" }; };
  const recall = async () => { throw new Error("memory is on fire"); };
  await assert.rejects(() => runTurnViaCli({ conversationId: C, text: "hi", images: none, startMcp: noMcp, recall, run }), /memory is on fire/);
  assert.equal(sent, null, "the CLI was told there is no question");
  assert.equal(db.loadConversation(C).length, 6, "the inbound line was taken back");
});

// ---------- §5: the background lane is held through the whole turn ----------

test("holdLane pauses the lane until released, once", () => {
  assert.equal(background.blocked()?.why === "reply_in_flight", false);
  const release = background.holdLane();
  assert.equal(background.blocked()?.why, "reply_in_flight");
  release(); release();
  assert.notEqual(background.blocked()?.why, "reply_in_flight", "released once, not twice");
});

test("fast: a person's turn holds the lane through the check and the send; off: only the model's run does", async () => {
  let duringCheck = null;
  said.setChecker(() => { duringCheck = background.blocked()?.why ?? null; return { changed_silently: [], asks_closed: [], unbacked: [] }; });
  db.addClaim(C, { subject: "the showing", value: "11:00am" });
  const make = () => {
    const runtime = new Runtime({
      log: () => {},
      runTurn: async (args) => {
        db.saveConversation(args.conversationId, [...db.loadConversation(args.conversationId), { role: "user", content: `[now] Omari: ${args.text}` }, { role: "assistant", content: "the showing is at eleven" }]);
        return "the showing is at eleven";
      },
    });
    const router = new Router({ runtime, log: () => {} });
    const fake = router.register(new FakeChannel({ number: "+15122164639" }));
    runtime.turnExtras.channels = router;
    runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
      await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
    });
    return { router, fake };
  };
  const h1 = make();
  await h1.router.deliver({ channel: "fake", externalId: "L-1", from: OWNER, text: "when is it", chatId: null, service: "iMessage" });
  let t0 = Date.now();
  while (!h1.fake.sent.length && Date.now() - t0 < 3_000) await new Promise(r => setTimeout(r, 5));
  assert.notEqual(duringCheck, "reply_in_flight", "off: the lane is free during the check (the model's run is over)");
  duringCheck = null;
  process.env.REASON_FAST_REPLY = "owner";
  const h2 = make();
  await h2.router.deliver({ channel: "fake", externalId: "L-2", from: OWNER, text: "and when again", chatId: null, service: "iMessage" });
  t0 = Date.now();
  while (!h2.fake.sent.length && Date.now() - t0 < 3_000) await new Promise(r => setTimeout(r, 5));
  assert.equal(duringCheck, "reply_in_flight", "fast: held through the check");
  await new Promise(r => setTimeout(r, 20));
  assert.notEqual(background.blocked()?.why, "reply_in_flight", "and released after the send");
});
