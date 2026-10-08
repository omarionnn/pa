// Per-message request tracking: every incoming message gets its own record, classified as
// request / correction / chat, and answered under its own text.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-requests-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_BURST_MAX_MS = "0";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { runTool } = await import("../src/tools.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM requests;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  config.burstQuietMs = 0;
  config.burstMaxMs = 0;
});

function harness() {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind, at: clock.now() });
      return "ok";
    },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e), timers: { set: (fn) => { fn(); return {}; }, clear: () => {} } });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  return { runtime, router, fake, turns, logs };
}

let n = 0;
const inbound = (over = {}) => ({
  channel: "fake", externalId: `e-${++n}`, from: "+12025551234", text: "hey",
  chatId: null, service: "iMessage", at: clock.now(), ...over,
});

// ---------- request records ----------

test("a single inbound message creates one request record", async () => {
  const { router } = harness();
  await router.deliver(inbound({ text: "what's the weather" }));

  const reqs = db.openRequests("dm:owner");
  assert.equal(reqs.length, 0, "stale pending requests are dropped after the turn");

  // check the record was created (even though it was dropped post-turn)
  const all = db.db.prepare("SELECT * FROM requests WHERE conversation_id = ?").all("dm:owner");
  assert.equal(all.length, 1);
  assert.equal(all[0].text, "what's the weather");
  assert.equal(all[0].status, "dropped", "unclassified requests are auto-dropped");
});

test("a burst of three texts creates three request records", async () => {
  const { router, logs } = harness();
  // Send all three before any drain runs — fake timers make them all join the same burst.
  const { runtime } = harness();
  const router2 = new Router({
    runtime,
    log: (e) => logs.push(e),
    timers: { set: (fn) => { fn(); return {}; }, clear: () => {} },
  });
  router2.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router2;

  await router2.deliver(inbound({ text: "what's the weather" }));
  await router2.deliver(inbound({ text: "find me a restaurant" }));
  await router2.deliver(inbound({ text: "what time is the game" }));

  const all = db.db.prepare("SELECT * FROM requests WHERE conversation_id = ?").all("dm:owner");
  assert.equal(all.length, 3);
});

// ---------- DB functions ----------

test("createRequest and openRequests", () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "find a monitor" });
  assert.ok(id > 0);
  const open = db.openRequests("dm:owner");
  assert.equal(open.length, 1);
  assert.equal(open[0].id, id);
  assert.equal(open[0].text, "find a monitor");
  assert.equal(open[0].kind, "pending");
  assert.equal(open[0].status, "open");
  assert.equal(open[0].inbound_handle, "H1");
});

test("classifyRequest sets kind and summary", () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "find a monitor" });
  db.classifyRequest(id, { kind: "request", summary: "find monitor under $500" });
  const req = db.getRequest(id);
  assert.equal(req.kind, "request");
  assert.equal(req.summary, "find monitor under $500");
});

test("classifyRequest as correction sets corrects_id", () => {
  const id1 = db.createRequest("dm:owner", { handle: "H1", text: "find a monitor" });
  db.classifyRequest(id1, { kind: "request", summary: "find monitor" });
  const id2 = db.createRequest("dm:owner", { handle: "H2", text: "actually make it 4k" });
  db.classifyRequest(id2, { kind: "correction", summary: "change to 4k", correctsId: id1 });
  const req = db.getRequest(id2);
  assert.equal(req.kind, "correction");
  assert.equal(req.corrects_id, id1);
});

test("answerRequest marks as answered", () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "what's the weather" });
  db.answerRequest(id);
  const req = db.getRequest(id);
  assert.equal(req.status, "answered");
  assert.ok(req.answered_at > 0);
  assert.equal(db.openRequests("dm:owner").length, 0);
});

test("dropRequest marks as dropped", () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "lol" });
  db.dropRequest(id);
  const req = db.getRequest(id);
  assert.equal(req.status, "dropped");
  assert.equal(db.openRequests("dm:owner").length, 0);
});

test("dropStaleRequests only drops pending, not classified", () => {
  const id1 = db.createRequest("dm:owner", { handle: "H1", text: "find a monitor" });
  const id2 = db.createRequest("dm:owner", { handle: "H2", text: "lol" });
  db.classifyRequest(id1, { kind: "request", summary: "find monitor" });
  db.dropStaleRequests("dm:owner");
  assert.equal(db.getRequest(id1).status, "open", "classified request stays open");
  assert.equal(db.getRequest(id2).status, "dropped", "unclassified request dropped");
});

// ---------- tool dispatch ----------

test("request_classify tool classifies and returns ok", async () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "what's the weather" });
  const out = await runTool("request_classify", { id, kind: "request", summary: "weather" }, { conversationId: "dm:owner" });
  assert.equal(out.ok, true);
  assert.equal(out.kind, "request");
  const req = db.getRequest(id);
  assert.equal(req.kind, "request");
  assert.equal(req.summary, "weather");
});

test("request_classify as chat drops the request", async () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "lol that's wild" });
  const out = await runTool("request_classify", { id, kind: "chat" }, { conversationId: "dm:owner" });
  assert.equal(out.ok, true);
  assert.equal(db.getRequest(id).status, "dropped");
});

test("request_classify refuses wrong conversation", async () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "hey" });
  const out = await runTool("request_classify", { id, kind: "request" }, { conversationId: "dm:other" });
  assert.equal(out.ok, false);
});

test("request_classify refuses nonexistent id", async () => {
  const out = await runTool("request_classify", { id: 99999, kind: "request" }, { conversationId: "dm:owner" });
  assert.equal(out.ok, false);
});

test("request_done marks answered", async () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "what's the weather" });
  const out = await runTool("request_done", { id }, { conversationId: "dm:owner" });
  assert.equal(out.ok, true);
  assert.equal(out.status, "answered");
  assert.equal(db.getRequest(id).status, "answered");
});

test("request_done refuses wrong conversation", async () => {
  const id = db.createRequest("dm:owner", { handle: "H1", text: "hey" });
  const out = await runTool("request_done", { id }, { conversationId: "dm:other" });
  assert.equal(out.ok, false);
});
