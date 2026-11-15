// "owner" in a send means the person in THIS conversation, never the operator's phone.
//
// 10-27 22:44 ET: on a call in tester Yaw's thread the model sent a flight link with
// message_send {to:"owner"}, and it was texted to the operator's number instead of Yaw's (outbox
// 1850). Every tool that resolved "owner" to an address read `config.ownerNumbers[0]` first:
// message_send, voice_note_send, send_picture, and every document handover. call_place already
// used the conversation's own account and is pinned here too.
//
// No API key, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-owner-thread-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DOCUMENT_ROOT = join(dir, "documents");
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.ts.net";

const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const ownfiles = await import("../src/ownfiles.js");
const { clock, config } = await import("../src/config.js");

const OPERATOR = "+12025551234";
const YAW = "+16165557647";
const YAW_C = `dm:fake:${YAW}`;
const OWNER_C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.undoWindowSeconds = 0;
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM outbox; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM documents; DELETE FROM held_actions; DELETE FROM conversations;");
});

function harness() {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ media: true }));
  db.upsertAccount({ conversationId: OWNER_C, channel: fake.name, address: OPERATOR, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: OWNER_C, channel: fake.name, address: OPERATOR, chatId: null, service: "iMessage" });
  db.upsertAccount({ conversationId: YAW_C, channel: fake.name, address: YAW, name: "Yaw", isOperator: false });
  db.upsertThread({ conversationId: YAW_C, channel: fake.name, address: YAW, chatId: null, service: "iMessage" });
  return { router, fake };
}

// send_picture fetches the picture first and sends Reason's own copy (src/pictureout.js): a stub, never the network.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2b4cd2a0000000049454e44ae426082", "hex");
const pngFetch = async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
const LINK = "google flights, SEA to DC: https://www.google.com/travel/flights?q=SEA%20to%20DCA";

for (const to of ["owner", "me", "self", "OWNER"]) {
  test(`message_send to:'${to}' in a tester's thread reaches the tester, not the operator`, async () => {
    const { router, fake } = harness();
    const out = await runTool("message_send", { to, text: LINK }, { conversationId: YAW_C, channels: router, messages: [] });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.sent_to, YAW);
    assert.deepEqual(fake.sent.map(s => s.to), [YAW], "one text, to Yaw");
    assert.ok(!fake.sent.some(s => s.to === OPERATOR), "nothing reached the operator's phone");
  });
}

test("message_send to:'owner' in the operator's own thread is unchanged", async () => {
  const { router, fake } = harness();
  const out = await runTool("message_send", { to: "owner", text: "hi" }, { conversationId: OWNER_C, channels: router, messages: [] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fake.sent.map(s => s.to), [OPERATOR]);
});

test("a tester's thread with no number on file sends nothing, rather than falling back to the operator", async () => {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ media: true }));
  db.upsertAccount({ conversationId: "dm:fake:nobody", channel: fake.name, address: "", name: "", isOperator: false });
  const out = await runTool("message_send", { to: "owner", text: LINK }, { conversationId: "dm:fake:nobody", channels: router, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(fake.sent.length, 0, "nothing was sent anywhere");
});

test("send_picture in a tester's thread goes to the tester", async () => {
  const { router, fake } = harness();
  const out = await runTool("send_picture", { url: "https://example.com/cabin.jpg", caption: "the cabin" }, { conversationId: YAW_C, channels: router, messages: [], fetchImpl: pngFetch });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fake.sent.map(s => s.to), [YAW]);
});

test("send_picture with a NO_REPLY caption sends the picture and no marker", async () => {
  const { router, fake } = harness();
  const out = await runTool("send_picture", { url: "https://example.com/cabin.jpg", caption: "NO_REPLY" }, { conversationId: YAW_C, channels: router, messages: [], fetchImpl: pngFetch });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(fake.sent.length, 1, "the picture still went");
  assert.doesNotMatch(JSON.stringify(fake.sent), /NO_REPLY/);
});

test("voice_note_send to:'owner' in a tester's thread goes to the tester", async (t) => {
  const { router, fake } = harness();
  // A voice note Reason made for this thread (src/ownfiles.js): only that can go.
  mkdirSync(config.audioTmpRoot, { recursive: true });
  const file = join(config.audioTmpRoot, "note.caf");
  const before = Date.now();
  writeFileSync(file, Buffer.alloc(64, 1));
  ownfiles.noteMade(YAW_C, { path: file }, before);
  const out = await runTool("voice_note_send", { to: "owner", file, text: "" }, { conversationId: YAW_C, channels: router, messages: [] });
  if (!out.ok && out.missing) return t.skip(`voice-note converter not on this machine: ${out.missing}`);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fake.sent.map(s => s.to), [YAW]);
});

test("a document made in a tester's thread is handed to the tester", async () => {
  const { router, fake } = harness();
  const out = await runTool("document_create", {
    kind: "pdf", title: "Flights", blocks: [{ type: "text", text: "SEA to DC" }], say: "here u go",
  }, { conversationId: YAW_C, channels: router, messages: [], renderDocument: async ({ title }) => Buffer.from(`%PDF-1.4 ${title}`) });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(fake.sent.map(s => s.to), [YAW]);
});

test("call_place to:'owner' in a tester's thread rings the tester", async () => {
  harness();
  const { FakeCallProvider } = await import("../src/calls/fake.js");
  const out = await runTool("call_place", { to: "owner", goal: "say hi" }, { conversationId: YAW_C, calls: new FakeCallProvider() });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.to, YAW);
});

test("an explicit third-party number from a tester's thread still needs the confirm gate", async () => {
  const { router, fake } = harness();
  const out = await runTool("message_send", { to: OPERATOR, text: LINK }, { conversationId: YAW_C, channels: router, messages: [] });
  assert.equal(out.ok, false, "the operator is a third party in Yaw's Reason");
  assert.equal(fake.sent.length, 0);
});
