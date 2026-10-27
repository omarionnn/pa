// Reason Web, Web-only chats (owner 10-27 01:15). Home's composer starts a fresh chat: a clean page with
// only that exchange; "Continue the thread →", the Chat tab and "The thread" still open the one shared
// conversation. One pinned test per rule:
//
//   1. Home carries a fresh chat id; the thread links stay the shared thread
//   2. a Web chat's message and reply live in that chat only; the reply is never texted
//   3. the model reads and writes the chat's own thread (historyId), tools act for the person
//   4. a chat can't be read, streamed or sent into by another account
//   5. a task started in a Web chat shows in Ongoing; proactive texts keep their normal channel
//   6. one turn is one chat: held shared + chat messages are never answered together
//   7. Chat history lists past Web chats (provisional placement, Q-v2-51); the day view stays the shared thread
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-web-chats-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";

const { webRequestFor } = await import("../src/http.js");
const convo = await import("../src/pages/webconvo.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver, WEB_HINT } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const AMA = "+13475550000";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;
const AMA_C = `dm:fake:${AMA}`;
const HOUR = 60 * 60 * 1000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  convo.resetSendLimits();
  db.db.exec(`DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue;
    DELETE FROM requests; DELETE FROM page_sessions; DELETE FROM web_chats; DELETE FROM tasks;`);
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false], [AMA_C, AMA, "Ama", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  // They have had Reason's contact card already (as every live account has), so the phone line stays quiet unless a test says otherwise.
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
});

/** serve.js's wiring: router, runtime, the fake texting line, the web channel. `turn` is the model. */
function harness({ turn = async ({ text }) => `re: ${text}` } = {}) {
  const logs = [], turns = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => { turns.push(args); return turn(args); } });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  const web = router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { router, runtime, fake, web, logs, turns };
}

let n = 0;
/** A signed-in browser for this conversation, as W1's code step leaves it. */
function browser(conversationId) {
  const token = `tok-${++n}-${conversationId.length}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
async function call(h, { sub = null, method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
}
/** A message typed on Web, as the page's script posts it. */
const send = (h, b, { id, text, csrf = b.csrf, headers = {}, extra = {} }) =>
  call(h, { sub: "send", method: "POST", b, body: new URLSearchParams({ id, text, c: csrf, ...extra }).toString(), headers: { accept: "application/json", "x-reason-csrf": csrf, ...headers } });
const history = async (h, b, query) => JSON.parse((await call(h, { sub: "history", b, query })).body);
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const textIn = (h, { from = KOFI, id, body }) => h.router.deliver({ channel: "fake", externalId: id, from, text: body, chatId: null, at: clock.now() });
const rowsOf = (c) => db.messagesFor(c).map(m => [m.role, m.channel, m.text]);
const FIRST = /One Reason\.<br><em>Pick up anywhere\.<\/em>/;
/** The thread itself (/web?thread). The person's first-ever GET is the once-only 5C page, so that is spent first. */
async function thread(h, b) {
  await call(h, { b });
  return (await call(h, { b, query: { thread: "" } })).body;
}

/** Open the live stream into a fake response; returns what it wrote and a way to close it. */
function openStream(h, b, query = {}, opts = {}) {
  const out = convo.streamRequest({ account: db.getAccount(b.conv), headers: headersFor(b), query, router: h.router, log: () => {}, ...opts });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { write: (s) => chunks.push(s), end: () => { res.ended = true; }, ended: false });
  const req = new EventEmitter();
  out.stream(res, req);
  const events = () => chunks.join("").split("\n\n").filter(Boolean).map(block => {
    const ev = /^event: (.+)$/m.exec(block)?.[1] ?? null;
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return ev ? { event: ev, data: data ? JSON.parse(data) : null } : null;
  }).filter(Boolean);
  return { out, res, events, close: () => req.emit("close") };
}

// ---------- isolation ----------


const CHAT = "AAAAAAAAAAAAAAAAAAAAAA";
const CHAT2 = "BBBBBBBBBBBBBBBBBBBBBB";
const sendIn = (h, b, chat, id, text) => send(h, b, { id, text, extra: { chat } });

test("1. Home's composer carries a fresh chat id; Continue the thread, the Chat tab and The thread stay the shared thread", async () => {
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await call(h, { b: omari });
  const home = (await call(h, { b: omari, query: { home: "" } })).body;
  const id = /<input type="hidden" name="chat" value="([A-Za-z0-9_-]{22})">/.exec(home)?.[1];
  assert.ok(id, "a minted chat id in Home's form");
  assert.match(home, new RegExp(`chat:"${id}"`), "and in the page's boot");
  assert.match(home, /location\.href=R\.chat\?'\/web\?chat='\+R\.chat:'\/web\?thread'/);
  assert.match(home, /href="\/web\?thread"[^>]*>THE THREAD/);
  assert.match(home, /<nav class="tabs"[^>]*><a href="\/web\?thread"/);
  const again = (await call(h, { b: omari, query: { home: "" } })).body;
  assert.notEqual(/name="chat" value="([^"]+)"/.exec(again)[1], id, "every Home is a new chat");
  // The shared thread's composer names no chat.
  assert.ok(!/name="chat"/.test(await thread(h, omari)));
});

test("2. a Web chat's message and reply stay in that chat and are never texted; the shared thread doesn't see them", async () => {
  const h = harness();
  await textIn(h, { from: OWNER, id: "t1", body: "from my phone" });
  const sentBefore = h.fake.sent.length;
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  const out = await sendIn(h, omari, CHAT, "wc-0001-aaaa", "plan my saturday");
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).chat, CHAT);
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 2));
  assert.equal(h.fake.sent.length, sentBefore, "nothing texted");
  assert.deepEqual(db.messagesFor(OWNER_C, { chat: CHAT }).map(m => [m.role, m.channel, m.text]), [["user", "web", "plan my saturday"], ["assistant", "web", "re: plan my saturday"]]);
  assert.ok(!db.messagesFor(OWNER_C).some(m => /saturday/.test(m.text)), "the shared thread has none of it");
  assert.ok((await history(h, omari, { after: "0" })).messages.every(m => !/saturday/.test(m.text)));
  // The chat's own page, catch-up and older page.
  assert.deepEqual((await history(h, omari, { after: "0", chat: CHAT })).messages.map(m => m.text), ["plan my saturday", "re: plan my saturday"]);
  assert.deepEqual((await history(h, omari, { chat: CHAT })).messages.map(m => m.text), ["plan my saturday", "re: plan my saturday"]);
  await call(h, { b: omari });
  const page = await call(h, { b: omari, query: { chat: CHAT } });
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`name="chat" value="${CHAT}"`), "its composer keeps sending into it");
  assert.ok(!/stays in your texts/.test(page.body));
  // A second chat is its own page too.
  await sendIn(h, omari, CHAT2, "wc-0002-aaaa", "something else");
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT2 }).length === 2));
  assert.equal(db.messagesFor(OWNER_C, { chat: CHAT }).length, 2);
  // The stream for the chat carries the chat's rows only.
  const s = openStream(h, omari, { chat: CHAT });
  await textIn(h, { from: OWNER, id: "t2", body: "phone again" });
  await sendIn(h, omari, CHAT, "wc-0003-aaaa", "and sunday");
  await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 4);
  s.close();
  const texts = s.events().filter(e => e.event === "message").map(e => e.data.text);
  assert.ok(texts.includes("and sunday"));
  assert.ok(!texts.includes("phone again") && !texts.includes("something else"));
});

test("3. the model reads and writes the chat's own thread; its tools still act for the person", async () => {
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await textIn(h, { from: OWNER, id: "t1", body: "shared hello" });
  await sendIn(h, omari, CHAT, "wc-0101-aaaa", "only in the chat");
  assert.ok(await until(() => h.turns.length === 2));
  const [shared, chat] = h.turns;
  assert.equal(shared.historyId, undefined, "a text reads the shared thread");
  assert.equal(chat.conversationId, OWNER_C, "the person's conversation: memory, tasks, approvals");
  assert.equal(chat.historyId, `${OWNER_C}#web:${CHAT}`);
  assert.equal(db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT)), `${OWNER_C}#web:${CHAT}`);
  assert.equal(db.historyKeyFor(KOFI_C, db.webChatRoute(CHAT)), KOFI_C, "never another account's chat key");
  assert.equal(db.historyKeyFor(OWNER_C, null), OWNER_C);
});

test("4. another account can't open, read, stream or send into somebody's chat", async () => {
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await sendIn(h, omari, CHAT, "wc-0201-aaaa", "my private chat");
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 2));
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await call(h, { b: kofi });
  assert.equal((await call(h, { b: kofi, query: { chat: CHAT } })).status, 404);
  assert.equal((await call(h, { sub: "history", b: kofi, query: { chat: CHAT, after: "0" } })).status, 404);
  assert.equal((await call(h, { sub: "history", b: kofi, query: { chat: CHAT } })).status, 404);
  assert.equal(convo.streamRequest({ account: db.getAccount(KOFI_C), headers: headersFor(kofi), query: { chat: CHAT } }).status, 404);
  const turns = h.turns.length;
  const out = await sendIn(h, kofi, CHAT, "wc-0202-aaaa", "let me in");
  assert.equal(out.status, 404);
  assert.equal(h.turns.length, turns, "no turn ran");
  assert.equal(db.webChatOwner(CHAT), OWNER_C);
  assert.ok(!db.messagesFor(OWNER_C, { chat: CHAT }).some(m => m.text === "let me in"));
  // Malformed ids are refused too.
  await call(h, { b: omari });
  assert.equal((await call(h, { b: omari, query: { chat: "../../x" } })).status, 404);
  assert.equal((await sendIn(h, omari, "short", "wc-0203-aaaa", "x")).status, 404);
  // Kofi's own rows never carry Omari's chat id even if forged on the route.
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "web", text: "forged", chatId: db.webChatRoute(CHAT) });
  assert.ok(!db.messagesFor(KOFI_C, { chat: CHAT }).length);
});

test("5. a task started in a Web chat shows in Ongoing; proactive texts keep the person's normal channel", async () => {
  const og = await import("../src/ongoing.js");
  const h = harness({ turn: async ({ conversationId, text }) => {
    db.createTask(conversationId, { title: "find a dinner spot", goal: "a booked table", maxAttempts: 3, label: "Dinner spot" });
    return `on it: ${text}`;
  } });
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await sendIn(h, omari, CHAT, "wc-0301-aaaa", "find me dinner");
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 2));
  assert.ok(og.ongoing(OWNER_C).items.some(x => x.title === "Dinner spot"), "in Ongoing, under the person");
  // A timer, a task wake, an approval: whereTo with no channel is the person's thread (their phone).
  const before = h.fake.sent.length;
  await h.runtime._emit({ conversationId: OWNER_C, text: "your reminder", meta: {} });
  assert.ok(await until(() => h.fake.sent.length === before + 1));
  assert.equal(h.fake.sent.at(-1).text.startsWith("your reminder"), true);
  assert.ok(!db.messagesFor(OWNER_C, { chat: CHAT }).some(m => m.text === "your reminder"), "never into the Web chat");
});

test("6. one turn is one chat: held shared and chat messages are taken apart, oldest first", () => {
  const hold = (chatId, id, at) => db.holdInbound({ conversationId: OWNER_C, channel: "web", address: OWNER, chatId, externalId: `${OWNER_C}:${id}`, text: id, quietMs: 0, maxMs: 0, now: at });
  db.claimWebChat(OWNER_C, CHAT);
  const t = clock.now();
  hold(null, "s1", t); hold(db.webChatRoute(CHAT), "c1", t + 1); hold(null, "s2", t + 2);
  assert.deepEqual(db.takePendingInbound(OWNER_C).map(r => r.text), ["s1", "s2"]);
  assert.deepEqual(db.takePendingInbound(OWNER_C).map(r => r.text), ["c1"]);
  assert.deepEqual(db.takePendingInbound(OWNER_C), []);
});

test("7. Chat history lists past Web chats, each opening its chat; the day view stays the shared thread", async () => {
  const hist = await import("../src/pages/webhistory.js");
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await textIn(h, { from: OWNER, id: "t1", body: "phone line" });
  await sendIn(h, omari, CHAT, "wc-0401-aaaa", "Plan a birthday dinner for Ama");
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 2));
  const page = hist.renderHistory({ account: db.getAccount(OWNER_C) });
  assert.match(page, new RegExp(`<a class="dy" href="/web\\?chat=${CHAT}"><span class="dy-d">Plan a birthday dinner for Ama</span><span class="dy-go" aria-hidden="true">→</span><span class="dy-m">WEB CHAT · [^<]+ · 2 MESSAGES</span>`));
  const dayRows = [...page.matchAll(/<a class="dy" href="\/web\/memory\/history\?day=/g)].length;
  assert.equal(dayRows, 1);
  const key = hist.dayKey(clock.now());
  assert.ok(hist.dayLines(OWNER_C, key).every(m => !/birthday/.test(m.html)), "the day is the shared thread's");
  assert.equal(hist.searchMessages(OWNER_C, "birthday").total, 0);
  // Kofi's history never lists Omari's chat.
  assert.ok(!hist.renderHistory({ account: db.getAccount(KOFI_C) }).includes(CHAT));
});

test("8. review: an approval asked in one thread is granted only by that thread's answer; another thread's trims never move its mark", async () => {
  const trust = await import("../src/trust.js");
  const { saveThread } = await import("../src/thread.js");
  db.db.exec("DELETE FROM confirmations");
  db.claimWebChat(OWNER_C, CHAT);
  const key = db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT));
  const line = (t) => ({ role: "user", content: `[Mon 9:00am] Omari (web): ${t}` });
  const chatThread = [line("buy the headphones")];
  const asked = trust.requestConfirmation({ conversationId: OWNER_C, messages: chatThread, historyId: key, action: "purchase_confirm", summary: "Buy the headphones for $80", stakes: "money" });
  const yes = async () => ({ verdict: "yes" });
  // The shared thread, with plenty said after: none of it answers an ask made in the chat.
  const shared = [line("a"), line("b"), line("sure, go for it")];
  const there = await trust.recordConfirmation({ conversationId: OWNER_C, messages: shared, confirmationId: asked.confirmation_id, judge: yes });
  assert.equal(there.ok, false);
  assert.equal(there.state, "asked_elsewhere");
  // The shared thread is cut to size: the chat's mark stays where it was.
  saveThread(OWNER_C, Array.from({ length: 400 }, (_, i) => line(`old ${i}`)), { max: 50 });
  assert.equal(db.getConfirmation(OWNER_C, asked.confirmation_id).asked_after_msgs, 1);
  // In the chat, no reply yet is still no reply; its own yes grants it.
  assert.equal((await trust.recordConfirmation({ conversationId: OWNER_C, messages: chatThread, historyId: key, confirmationId: asked.confirmation_id, judge: yes })).state, "waiting_for_yes");
  const ok = await trust.recordConfirmation({ conversationId: OWNER_C, messages: [...chatThread, line("yes do it")], historyId: key, confirmationId: asked.confirmation_id, judge: yes });
  assert.equal(ok.ok, true);
  // And the other way round: a shared-thread ask is never answered from a Web chat.
  const sharedAsk = trust.requestConfirmation({ conversationId: OWNER_C, messages: [line("book it")], action: "browser_submit", summary: "Book the table", stakes: "commitment" });
  assert.equal((await trust.recordConfirmation({ conversationId: OWNER_C, messages: [line("x"), line("yes")], historyId: key, confirmationId: sharedAsk.confirmation_id, judge: yes })).state, "asked_elsewhere");
});

test("9. review: a task's DONE line only gathers its own thread's messages; neither page loses a line to the other", async () => {
  const settle = await import("../src/settle.js");
  db.db.exec("DELETE FROM task_messages");
  db.claimWebChat(OWNER_C, CHAT);
  const t = db.createTask(OWNER_C, { title: "t", goal: "g", maxAttempts: 3, label: "Dinner" });
  const inChat = db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "web", externalId: `${OWNER_C}:c-1`, text: "find dinner", chatId: db.webChatRoute(CHAT) });
  const inShared = db.writeMessage({ conversationId: OWNER_C, role: "user", channel: "fake", externalId: "s-1", text: "any luck?" });
  settle.linkTurn({ conversationId: OWNER_C, taskIds: [t.id], handles: [`${OWNER_C}:c-1`, "s-1"] });
  db.finishTask(OWNER_C, t.id, { state: "done", outcome: "booked" });
  const shared = settle.foldsFor(OWNER_C, [inShared]);
  assert.deepEqual([...shared.folds.values()].map(f => f.rows.map(r => r.id)), [[inShared]], "the shared fold has none of the chat's lines");
  const chat = settle.foldsFor(OWNER_C, [inChat], { chat: CHAT });
  assert.deepEqual([...chat.folds.values()].map(f => f.lastId), [inChat], "the chat settles at its own last line, so it is drawn");
});

test("10. review: from a Web chat's turn, no tool reaches the person's own phone", async () => {
  const { runTool } = await import("../src/tools.js");
  db.claimWebChat(OWNER_C, CHAT);
  const key = db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT));
  const h = harness();
  const ctx = { conversationId: OWNER_C, historyId: `${OWNER_C}#web:${CHAT}`, channels: h.router, messages: [] };
  assert.equal(key, ctx.historyId);
  for (const [name, input] of [["message_send", { to: OWNER, text: "hi" }], ["send_picture", { url: "https://example.com/a.png" }], ["mark_moment", { effect: "confetti", moment: "x" }], ["reply_to", { quote: "x" }], ["voice_note_say", { text: "hi" }], ["resend_contact_card", {}]]) {
    const out = await runTool(name, input, ctx);
    assert.equal(out.status, "web_chat", `${name}: ${JSON.stringify(out).slice(0, 200)}`);
  }
  assert.equal(h.fake.sent.length, 0);
});

test("11. review: an approval asked in a Web chat is answered there; a chat's yes never answers an access or call check", async () => {
  const trust = await import("../src/trust.js");
  const og = await import("../src/ongoing.js");
  const page = await import("../src/pages/webongoing.js");
  db.db.exec("DELETE FROM confirmations");
  db.claimWebChat(OWNER_C, CHAT);
  const key = db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT));
  const asked = trust.requestConfirmation({ conversationId: OWNER_C, messages: [], historyId: key, action: "purchase_confirm", summary: "Buy the headphones", stakes: "money" });
  const x = og.findItem(OWNER_C, "approval", asked.confirmation_id);
  assert.equal(x.chat, CHAT);
  assert.equal(page.talkHref(x), `/web?chat=${CHAT}&about=${encodeURIComponent(`approval:${asked.confirmation_id}`)}`);
  // That link opens the chat with the draft in its composer.
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await call(h, { b: omari });
  const r = await call(h, { b: omari, query: { chat: CHAT, about: `approval:${asked.confirmation_id}` } });
  assert.match(r.body, /data-draft>Can I see the details first\?<\/textarea>/);
  // The model's own pending list in a Web chat is that chat's only.
  const { runTool } = await import("../src/tools.js");
  const sharedAsk = trust.requestConfirmation({ conversationId: OWNER_C, messages: [], action: "browser_submit", summary: "Book the table", stakes: "commitment" });
  const inChat = await runTool("confirm_pending", {}, { conversationId: OWNER_C, historyId: key, messages: [] });
  assert.deepEqual(inChat.waiting_on_an_answer.map(w => w.confirmation_id), [asked.confirmation_id]);
  const inShared = await runTool("confirm_pending", {}, { conversationId: OWNER_C, messages: [] });
  assert.deepEqual(inShared.waiting_on_an_answer.map(w => w.confirmation_id), [sharedAsk.confirmation_id]);
});

test("12. review: a yes typed in a Web chat never verifies a call whose check went to their phone", async () => {
  db.db.exec("DELETE FROM calls");
  const call_ = db.createCall(OWNER_C, { provider: "fake", toNumber: OWNER, isOwner: true, goal: "check in", facts: [] });
  db.updateCall(OWNER_C, call_.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 0 });
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await sendIn(h, omari, CHAT, "wc-0501-aaaa", "yes");
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 2));
  assert.equal(h.turns.length, 1, "the chat's own turn ran");
  assert.equal(db.pendingCallVerification(OWNER_C)?.id, call_.id, "still waiting on the phone's answer");
});
