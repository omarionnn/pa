// Reason Web, phase W0: the foundations and nothing a person can see (docs/plans/reason-web-phase1.md §6).
//
// What is pinned here, in the plan's own words plus spec §10 as it applies to a phase with no UI:
//
//   - the flag off is zero behaviour change: no web channel, a web inbound refused before admission,
//     nothing written to the history table, the same tool list, the same channel statuses
//   - a web message lands in the person's EXISTING conversation, never a `dm:web:…` of its own, and
//     never in anybody else's: the id comes from the session (server side), `from` is ignored
//   - a web inbound never changes `threads.channel/address` — the phone route stays the phone
//   - a reply goes back the way the message came (web → web, text → text), exactly one of it; a
//     message Reason starts itself goes to the phone even after a web message
//   - a retried web message (same external_id) is one turn and one history row
//   - the per-message history carries role, channel, handle, time; one person's rows are theirs alone
//   - a sign-in code text and a text to a third party are never history
//   - the web adapter's findSent answers from the history, address-bound
//   - `owner` covers the owner's conversation only
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-w0-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_WEB = "on";

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver, whereTo } = await import("../src/deliver.js");
const web = await import("../src/web.js");
const { toolsFor } = await import("../src/tools.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const OTHER = "+13105550123";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const OTHERS = `dm:fake:${OTHER}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  db.db.exec("DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue; DELETE FROM requests;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  db.upsertAccount({ conversationId: OTHERS, channel: "fake", address: OTHER, name: "Ama", isOperator: false });
});

/** The server's own wiring, as serve.js builds it: a web channel is registered only while the switch is on. */
function harness({ turn = async ({ text }) => `re: ${text}` } = {}) {
  const printed = [];
  const logs = [];
  const turns = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: (s) => printed.push(s) });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({
    log: (e) => logs.push(e), channels: router, deliver,
    runTurn: async (args) => { turns.push(args); return turn(args); },
  });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  const webCh = web.webOn() ? router.register(new WebChannel()) : null;
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { runtime, router, fake, web: webCh, printed, logs, turns };
}

/** They have texted before: the thread row a first text makes, which is the phone route. */
const texted = (conversationId = THEIRS, address = FRIEND) =>
  db.upsertThread({ conversationId, channel: "fake", address, isOwner: true, service: "iMessage" });

/** A text, as the fake provider's webhook would hand it over. */
const text = (router, { from = FRIEND, id, body }) =>
  router.deliver({ channel: "fake", externalId: id, from, text: body, chatId: null, at: clock.now() });

/** A web message, as the (later-phase) route will hand it over: the conversation from the session, never from the client. */
const fromWeb = (router, { conversationId = THEIRS, id, body, from = undefined }) =>
  router.deliver({ channel: "web", externalId: id, conversationId, text: body, at: clock.now(), ...(from !== undefined ? { from } : {}) });

// ---------- the switch off: nothing changes ----------

test("with REASON_WEB off there is no web channel, a web message is refused before admission, and nothing is written", async () => {
  config.web = false;
  assert.equal(web.webOn(), false);
  assert.equal(web.webAllowedFor(CONV), false);
  const { router, turns } = harness();
  assert.equal(router.get("web"), null, "serve registers no web channel when the switch is off");
  assert.deepEqual(router.statuses().map(s => s.name).sort(), ["console", "fake"]);
  texted();

  const out = await fromWeb(router, { id: "w1", body: "hello from a browser" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "web_off");
  assert.equal(turns.length, 0, "no turn");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM inbound_messages").get().n, 0, "not even claimed");
  assert.deepEqual(db.getThread(THEIRS).channel, "fake");
  assert.equal(db.getThread(THEIRS).last_channel, "fake", "the refused web message left no trace on the thread");

  // An ordinary text still works exactly as before, and the history table stays empty.
  await text(router, { id: "t1", body: "hi" });
  assert.equal(turns.length, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0, "flag off: the history table is never written");
  // `threads.last_channel` is the one column a text now fills whatever the flag says: nullable,
  // read by nothing in W0, and the route columns beside it are untouched.
  assert.equal(db.getThread(THEIRS).address, FRIEND);
  // db.writeMessage itself is a no-op while off, however it is reached.
  assert.equal(db.writeMessage({ conversationId: THEIRS, role: "user", channel: "fake", externalId: "x", text: "y" }), null);
});

test("the tool list is identical with the switch off and on: W0 adds no tool", () => {
  const names = (c) => toolsFor(c).map(t => t.name).sort();
  config.web = false;
  const offOwner = names(CONV), offThem = names(THEIRS);
  config.web = true;
  assert.deepEqual(names(CONV), offOwner);
  assert.deepEqual(names(THEIRS), offThem);
  config.web = "owner";
  assert.deepEqual(names(CONV), offOwner);
  assert.deepEqual(names(THEIRS), offThem);
});

test("the web adapter says not_connected while the switch is off, and refuses to send", async () => {
  config.web = false;
  const ch = new WebChannel();
  assert.equal(ch.status().status, "not_connected");
  assert.deepEqual(ch.status().missing, ["REASON_WEB"]);
  const r = await ch.send({ to: FRIEND, text: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  config.web = true;
  assert.equal(ch.status().status, "live");
});

// ---------- `owner`: the owner's conversation only ----------

test("REASON_WEB=owner reaches the owner's conversation and nobody else's", async () => {
  config.web = "owner";
  assert.equal(web.webAllowedFor(CONV), true);
  assert.equal(web.webAllowedFor(THEIRS), false);
  const { router, turns } = harness();
  texted(CONV, OWNER);
  texted();

  const theirs = await fromWeb(router, { conversationId: THEIRS, id: "w1", body: "let me in" });
  assert.equal(theirs.ok, false);
  assert.equal(theirs.refused, "web_not_for_them");
  assert.equal(turns.length, 0);

  const mine = await fromWeb(router, { conversationId: CONV, id: "w2", body: "owner on web" });
  assert.equal(mine.ok, true);
  assert.equal(mine.conversationId, CONV);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "owner on web");
});

// ---------- one conversation, never a second one ----------

test("a web message lands in the person's existing conversation, not a dm:web one, and their account keeps its channel", async () => {
  const { router, turns, web: webCh, fake } = harness();
  texted();
  const out = await fromWeb(router, { id: "w1", body: "book the table" });
  assert.equal(out.ok, true);
  assert.equal(out.conversationId, THEIRS, "the session's conversation, nothing minted");
  assert.equal(db.getAccount("dm:web:" + FRIEND), null, "no second account");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 3, "no account created");
  assert.equal(db.getAccount(THEIRS).channel, "fake", "upsertAccount never saw 'web'");
  assert.equal(db.getAccount(THEIRS).address, FRIEND);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].conversationId, THEIRS);
  assert.equal(turns[0].text, "book the table");
  assert.equal(turns[0].channel, "web", "the turn is told where they are speaking from");

  // The reply went to the browser and only the browser.
  assert.deepEqual(webCh.recent.map(m => [m.to, m.text]), [[FRIEND, "re: book the table"]]);
  assert.equal(fake.sent.length, 0, "nothing texted for a web-triggered turn");
  // (The "(web)" label on the thread line itself is the backend's, pinned on the CLI backend below.)
});

test("the conversation comes from the session: a client `from` is ignored and an unknown id is refused", async () => {
  const { router, turns } = harness();
  texted();
  texted(OTHERS, OTHER);
  // Ama's number on the wire, Kofi's session: it is Kofi's message. Nothing of the wire is trusted.
  const out = await fromWeb(router, { conversationId: THEIRS, from: OTHER, id: "w1", body: "whose am i" });
  assert.equal(out.conversationId, THEIRS);
  assert.equal(turns[0].conversationId, THEIRS);
  assert.deepEqual(db.messagesFor(OTHERS), [], "nothing of it reached Ama");
  assert.equal(db.messagesFor(THEIRS).length, 2, "Kofi's line and Reason's reply");

  for (const [conversationId, why] of [["dm:fake:+19999999999", "no_account"], ["", "no_session"], [undefined, "no_session"]]) {
    const r = await router.deliver({ channel: "web", externalId: `bad-${why}`, conversationId, from: FRIEND, text: "hi", at: clock.now() });
    assert.equal(r.ok, false);
    assert.equal(r.refused, why);
  }
  assert.equal(turns.length, 1);
});

test("a paused person is as signed out on web as on their phone", async () => {
  const { router, turns } = harness();
  texted();
  db.setAccountState(THEIRS, "paused");
  const out = await fromWeb(router, { id: "w1", body: "still there?" });
  assert.equal(out.admitted, false);
  assert.equal(out.stopped, "paused");
  assert.equal(turns.length, 0);
  db.setAccountState(THEIRS, "active");
});

// ---------- the phone route is never stolen ----------

test("a web inbound never changes threads.channel or address; it leaves only last_channel", async () => {
  const { router, runtime, fake, web: webCh } = harness();
  texted();
  const before = db.getThread(THEIRS);
  await fromWeb(router, { id: "w1", body: "from the browser" });
  const after = db.getThread(THEIRS);
  assert.equal(after.channel, "fake", "the route is still the phone");
  assert.equal(after.address, FRIEND);
  assert.equal(after.service, before.service);
  assert.equal(after.last_channel, "web");
  assert.equal(after.last_inbound_id, `${THEIRS}:w1`, "the handle, under their conversation");

  // Something Reason starts itself — a reminder — goes to the PHONE, not the tab.
  assert.deepEqual(whereTo({ conversationId: THEIRS }), { channel: "fake", to: FRIEND, chatId: null, started: true });
  db.createTimer(THEIRS, { fireAt: clock.now() + 1000, note: "stretch" });
  clock.skip(2000);
  await runtime.tick();
  assert.equal(fake.sent.at(-1).to, FRIEND);
  assert.equal(webCh.recent.filter(m => m.text !== "re: from the browser").length, 0, "the reminder did not go to the browser");

  // A text afterwards marks the thread as texted again.
  await text(router, { id: "t1", body: "back on my phone" });
  assert.equal(db.getThread(THEIRS).last_channel, "fake");
  assert.equal(fake.sent.at(-1).text, "re: back on my phone", "and its reply came back by text");
});

test("a web message from somebody with no thread yet creates no route: the phone is proven by a text, never a browser", async () => {
  const { router } = harness();
  assert.equal(db.getThread(THEIRS), null);
  const out = await fromWeb(router, { id: "w1", body: "first ever" });
  assert.equal(out.ok, true);
  assert.equal(db.getThread(THEIRS), null, "no thread row");
  assert.equal(whereTo({ conversationId: THEIRS }).channel, "console", "so anything Reason starts falls to the console, exactly as for a conversation that never texted");
});

// ---------- one reply, on the channel the message came on ----------

test("text → web → text: each reply goes back the way its message came, once, and the history labels each", async () => {
  const { router, fake, web: webCh } = harness();
  texted();
  await text(router, { id: "t1", body: "one" });
  await fromWeb(router, { id: "w1", body: "two" });
  await text(router, { id: "t2", body: "three" });

  assert.deepEqual(fake.sent.map(m => m.text), ["re: one", "re: three"]);
  assert.deepEqual(webCh.recent.map(m => m.text), ["re: two"]);

  const rows = db.messagesFor(THEIRS).map(m => [m.role, m.channel, m.text, m.external_id ?? null]);
  assert.deepEqual(rows, [
    ["user", "fake", "one", "t1"],
    ["assistant", "fake", "re: one", "fake-1"],
    ["user", "web", "two", `${THEIRS}:w1`],
    ["assistant", "web", "re: two", webCh.recent[0].message_id],
    ["user", "fake", "three", "t2"],
    ["assistant", "fake", "re: three", "fake-2"],
  ]);
  for (const m of db.messagesFor(THEIRS)) {
    assert.equal(typeof m.at, "number");
    assert.equal(m.deleted_at, null);
  }
  const outboxIds = db.messagesFor(THEIRS).filter(m => m.role === "assistant").map(m => m.outbox_id);
  assert.ok(outboxIds.every(Number.isInteger), "every reply row names the outbox row it went out as");
  assert.equal(new Set(outboxIds).size, 3);
});

// ---------- retries ----------

test("the same web message delivered twice is one turn and one history row", async () => {
  const { router, turns, web: webCh } = harness();
  texted();
  const first = await fromWeb(router, { id: "same", body: "once" });
  const again = await fromWeb(router, { id: "same", body: "once" });
  assert.equal(first.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(turns.length, 1);
  assert.equal(webCh.recent.length, 1, "one reply");
  assert.deepEqual(db.messagesFor(THEIRS).map(m => m.role), ["user", "assistant"]);
});

test("two people's browsers using the same message id never swallow each other's message", async () => {
  const { router, turns } = harness();
  texted();
  texted(OTHERS, OTHER);
  const a = await fromWeb(router, { conversationId: THEIRS, id: "same-uuid", body: "kofi" });
  const b = await fromWeb(router, { conversationId: OTHERS, id: "same-uuid", body: "ama" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, undefined, "Ama's message is not Kofi's retry");
  assert.deepEqual(turns.map(t => [t.conversationId, t.text]), [[THEIRS, "kofi"], [OTHERS, "ama"]]);
  // And Kofi's own retry of that id is still one turn.
  const again = await fromWeb(router, { conversationId: THEIRS, id: "same-uuid", body: "kofi" });
  assert.equal(again.duplicate, true);
  assert.equal(turns.length, 2);
  // The handle kept is under their conversation, so the dedupe row cannot collide across people.
  assert.equal(db.db.prepare("SELECT external_id FROM inbound_messages WHERE conversation_id = ?").get(THEIRS).external_id, `${THEIRS}:same-uuid`);
});

test("web messages held when the switch is turned off are kept, not answered into nothing", async () => {
  const { router, turns, logs } = harness();
  texted();
  // A web message is on the pile (as after a restart), and the switch is now off.
  db.holdInbound({ conversationId: THEIRS, channel: "web", address: FRIEND, externalId: `${THEIRS}:held`, text: "still here?", quietMs: 0, maxMs: 0 });
  config.web = false;
  const r = await router.drainDue(clock.now());
  assert.equal(r.conversations, 1);
  assert.equal(r.turns, 1, "counted as handled by the sweep");
  assert.equal(turns.length, 0, "no model turn was spent on a message nothing could answer");
  assert.ok(logs.some(l => l.web_held_back === THEIRS));
  const row = db.lastPendingInbound(THEIRS);
  assert.ok(row, "the message is back on the pile");
  assert.ok(row.ready_at > clock.now() + 59 * 60_000, "for an hour");
  assert.equal(row.held_times, 0, "not counted as an outage hold");
  // The switch comes back and the sweep reaches it: answered on web.
  config.web = true;
  router.register(new WebChannel());
  clock.skip(61 * 60_000);
  await router.drainDue(clock.now());
  assert.deepEqual(turns.map(t => t.text), ["still here?"]);
});

test("a page's or /ops's sign-in code is never history (pcode: key)", async () => {
  const { runtime, fake } = harness();
  texted(CONV, OWNER);
  await runtime._tell(CONV, "Your Reason code is 123456, to open \"Trip\" on that browser.", { idempotencyKey: "pcode:pg1:7" });
  assert.equal(fake.sent.length, 1, "the code went");
  assert.deepEqual(db.messagesFor(CONV), []);
  assert.deepEqual(db.HISTORY_EXCLUDED_KEYS, ["pcode:", "esign:", "wsign:"]);
});

test("the history dedupes on the handle even when written twice by hand", () => {
  const a = db.writeMessage({ conversationId: THEIRS, role: "user", channel: "web", externalId: "h1", text: "x" });
  const b = db.writeMessage({ conversationId: THEIRS, role: "user", channel: "web", externalId: "h1", text: "x" });
  assert.ok(Number.isInteger(a));
  assert.equal(b, null);
  // A different conversation with the same handle is a different message (handles are per provider, per person).
  assert.ok(Number.isInteger(db.writeMessage({ conversationId: OTHERS, role: "user", channel: "web", externalId: "h1", text: "x" })));
  assert.equal(db.messagesFor(THEIRS).length, 1);
  assert.equal(db.messagesFor(OTHERS).length, 1);
});

// ---------- isolation ----------

test("two conversations never share history rows, whichever channel they used", async () => {
  const { router } = harness();
  texted();
  texted(OTHERS, OTHER);
  await text(router, { id: "k1", body: "kofi text" });
  await fromWeb(router, { conversationId: THEIRS, id: "k2", body: "kofi web" });
  await text(router, { id: "a1", from: OTHER, body: "ama text" });
  await fromWeb(router, { conversationId: OTHERS, id: "a2", body: "ama web" });

  const kofi = db.messagesFor(THEIRS).map(m => m.text);
  const ama = db.messagesFor(OTHERS).map(m => m.text);
  assert.deepEqual(kofi, ["kofi text", "re: kofi text", "kofi web", "re: kofi web"]);
  assert.deepEqual(ama, ["ama text", "re: ama text", "ama web", "re: ama web"]);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 8);
  // Paging is scoped too: after Kofi's first id, only Kofi's.
  const afterFirst = db.messagesFor(THEIRS, { after: db.messagesFor(THEIRS)[0].id });
  assert.deepEqual(afterFirst.map(m => m.text), ["re: kofi text", "kofi web", "re: kofi web"]);
});

// ---------- what is never history ----------

test("a sign-in code text and a text to a third party are not history; a code-written line to them is", async () => {
  const { router, runtime, fake } = harness();
  texted();
  // The event sign-in code, exactly as src/pages/event.js sends it.
  await runtime._tell(THEIRS, "your Reason code is 123456", { idempotencyKey: "esign:" + THEIRS + ":1" });
  // A message Reason sends somebody else on their behalf (an errand), not to them.
  await router.send({ channel: "fake", to: OTHER, text: "hi, Kofi asked me to check…", conversationId: THEIRS, toOwner: false });
  // A line Reason starts itself, to them.
  runtime.say(THEIRS, "heads up, that reminder is set");
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(fake.sent.length, 3, "all three really went out");
  assert.deepEqual(db.messagesFor(THEIRS).map(m => [m.role, m.text]), [["assistant", "heads up, that reminder is set"]]);
  assert.deepEqual(db.messagesFor(OTHERS), []);
});

test("a reply that failed to send is not history; the outbox row is", async () => {
  const { router, fake } = harness();
  texted();
  fake.failWith = "the line is down";
  fake.retryable = false;
  await text(router, { id: "t1", body: "anyone there" });
  assert.deepEqual(db.messagesFor(THEIRS).map(m => [m.role, m.text]), [["user", "anyone there"]]);
  assert.equal(db.db.prepare("SELECT state FROM outbox WHERE conversation_id = ?").get(THEIRS).state, "failed");
});

test("the console's lines are history too, written where the console sends (it has no outbox)", async () => {
  const { router, printed } = harness();
  const out = await router.deliver({ channel: "console", externalId: "c1", from: "console", text: "hello", at: clock.now() });
  assert.equal(out.conversationId, CONV);
  assert.ok(printed.length);
  assert.deepEqual(db.messagesFor(CONV).map(m => [m.role, m.channel, m.text]), [["user", "console", "hello"], ["assistant", "console", "re: hello"]]);
});

// ---------- the adapter's own answers ----------

test("the web adapter's findSent: this process's memory, then the history, bound to the address", async () => {
  const { router, web: webCh } = harness();
  texted();
  texted(OTHERS, OTHER);
  const t0 = clock.now();
  await fromWeb(router, { id: "w1", body: "ping" });
  const sentId = webCh.recent[0].message_id;

  const hit = await webCh.findSent({ to: FRIEND, text: "re: ping", since: t0, until: clock.now() + 1 });
  assert.deepEqual(hit, { ok: true, found: true, message_id: sentId });
  // A fresh adapter (a restarted process) still finds it — in the history, through the outbox row.
  const fresh = new WebChannel();
  assert.deepEqual(await fresh.findSent({ to: FRIEND, text: "re: ping", since: t0, until: clock.now() + 1 }), { ok: true, found: true, message_id: sentId });
  // The same words to somebody else were never sent: not found, so it is safe to send.
  assert.deepEqual(await fresh.findSent({ to: OTHER, text: "re: ping", since: t0, until: clock.now() + 1 }), { ok: true, found: false });
  assert.deepEqual(await fresh.findSent({ to: FRIEND, text: "re: ping", since: clock.now() + 10, until: clock.now() + 20 }), { ok: true, found: false });
});

test("the outbox's own retry of a web send is one history row, through markOutboundSent's dedupe", () => {
  const { row } = db.enqueueOutbound({ idemKey: "k1", conversationId: THEIRS, channel: "web", address: FRIEND, body: "twice?", toOwner: true, maxAttempts: 5 });
  db.claimOutbound(row.id);
  db.markOutboundSent(row.id, { messageId: "web-a" });
  db.markOutboundSent(row.id, { messageId: "web-a" });
  assert.equal(db.messagesFor(THEIRS).length, 1);
  assert.equal(db.messagesFor(THEIRS)[0].outbox_id, row.id);
});

// ---------- the model is told where they are speaking from, on the live backend too ----------

test("the CLI backend labels a web line '(web)' in the thread and a text line not at all", async () => {
  const drive = {
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    run: async () => ({ ok: true, envelope: { result: "hey" } }),
    recall: async () => [],
  };
  db.saveConversation(THEIRS, []);
  await runTurnViaCli({ conversationId: THEIRS, text: "from a browser", channel: "web", ...drive });
  await runTurnViaCli({ conversationId: THEIRS, text: "from my phone", ...drive });
  const users = db.loadConversation(THEIRS).filter(m => m.role === "user").map(m => m.content);
  assert.match(users[0], /\] Kofi \(web\): from a browser$/);
  assert.match(users[1], /\] Kofi: from my phone$/);
});
