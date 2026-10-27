// Reason Web, one thread only (owner 10-27 07:08). Web-only chats (#209) are retired: nothing starts one,
// every composer posts to the one thread shared with their texts, and the chats already made stay
// readable. One pinned test per rule:
//
//   1. Home's composer and the thread's name no chat; no new-chat entry anywhere; /web?newchat is the thread
//   2. a stale post naming a chat lands in the shared thread and claims no chat
//   3. an old chat opens read-only: all its lines, no composer, "Continue the thread"; its reads stay its own
//   4. another account can't open, read or stream somebody's old chat; a stale post never reaches it
//   5. a turn still keyed to an old chat reads its own thread (historyId), tools act for the person
//   6. one turn is one chat: held shared + chat messages are never answered together
//   7. Chat history lists old chats, each opening read-only; the day view stays the shared thread
//   8. an approval asked in an old chat is adopted by the shared thread, granted only by a reply after that
//   9. a task's DONE line gathers only its own thread's lines
//  10. from a Web-chat turn, no tool reaches the phone
//  11. the approval's Ongoing link is the shared thread; confirm_pending in the shared thread adopts it
//  12. a yes in a Web-chat turn never verifies a call whose check went to their phone
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

// ---------- old chats ----------

const CHAT = "AAAAAAAAAAAAAAAAAAAAAA";
const CHAT2 = "BBBBBBBBBBBBBBBBBBBBBB";
const NEVER = "CCCCCCCCCCCCCCCCCCCCCC";
/** A Web-only chat made before they were retired, as its rows were written then. */
function oldChat(conv, chat, lines) {
  assert.equal(db.claimWebChat(conv, chat), true);
  const start = clock.now() - HOUR;
  return lines.map(([role, text], i) => db.writeMessage({ conversationId: conv, role, channel: "web", text, at: start + i * 1000, chatId: db.webChatRoute(chat) }));
}
/** A message still routed to an old chat (held there before the retirement): the router keeps its own thread. */
const intoOldChat = (h, chat, id, text) => h.router.deliver({ channel: "web", externalId: id, conversationId: OWNER_C, text, chatId: db.webChatRoute(chat), at: clock.now() });
const NEW_CHAT_RE = /NEW WEB CHAT|New Web chat|newchat/;

test("1. Home's composer and the thread's name no chat; no new-chat entry anywhere; /web?newchat is the thread", async () => {
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  const shared = await thread(h, omari);
  const home = (await call(h, { b: omari, query: { home: "" } })).body;
  for (const [name, html] of [["thread", shared], ["home", home]]) {
    assert.match(html, /<form class="cform" method="POST" action="\/web\/send">/, `${name}: a composer`);
    assert.ok(!/name="chat"/.test(html), `${name}: its form names no chat`);
    assert.ok(!/chat:"[A-Za-z0-9_-]{22}"/.test(html), `${name}: its boot names no chat`);
    assert.doesNotMatch(html, NEW_CHAT_RE, `${name}: no new-chat entry`);
  }
  assert.match(home, /href="\/web\?thread"[^>]*>THE THREAD/);
  assert.match(home, /<nav class="tabs"[^>]*><a href="\/web\?thread"/);
  // The daily edition Home too.
  process.env.REASON_WEB_DAILY = "owner";
  try {
    const daily = (await call(h, { b: omari, query: { home: "" } })).body;
    assert.match(daily, /EDITION/, "the daily edition is drawn");
    assert.ok(!/class="cform"/.test(daily), "it has no composer");
    assert.doesNotMatch(daily, NEW_CHAT_RE);
    assert.doesNotMatch((await call(h, { b: omari, query: { thread: "" } })).body, NEW_CHAT_RE);
    const go = await call(h, { b: omari, query: { newchat: "" } });
    assert.equal(go.status, 303);
    assert.equal(go.headers.Location, "/web?thread");
  } finally { process.env.REASON_WEB_DAILY = ""; }
  assert.equal((await call(h, { b: omari, query: { newchat: "" } })).headers.Location, "/web?thread");
  // Home's post (no chat) lands in the shared thread.
  const out = await send(h, omari, { id: "home-0001-aaaa", text: "plan my saturday" });
  assert.equal(out.status, 200);
  assert.ok(!("chat" in JSON.parse(out.body)));
  assert.ok(await until(() => db.messagesFor(OWNER_C).length === 2));
  assert.deepEqual(rowsOf(OWNER_C), [["user", "web", "plan my saturday"], ["assistant", "web", "re: plan my saturday"]]);
  assert.ok(db.messagesFor(OWNER_C).every(m => m.chat_id == null));
  assert.equal(h.turns[0].historyId ?? OWNER_C, OWNER_C, "the shared model thread");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM web_chats").get().n, 0, "no chat was started");
});

test("2. a stale post naming a chat lands in the shared thread and claims no chat", async () => {
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  oldChat(OWNER_C, CHAT, [["user", "old chat line"], ["assistant", "old chat reply"]]);
  const sentBefore = h.fake.sent.length;
  for (const [i, chat] of [CHAT, NEVER, "short"].entries()) {
    const out = await send(h, omari, { id: `stale-000${i}-aaaa`, text: `stale ${i}`, extra: { chat } });
    assert.equal(out.status, 200, chat);
    const j = JSON.parse(out.body);
    assert.equal(j.ok, true);
    assert.ok(!("chat" in j), "the answer names no chat");
  }
  assert.ok(await until(() => db.messagesFor(OWNER_C).length === 6));
  assert.deepEqual(db.messagesFor(OWNER_C).filter(m => m.role === "user").map(m => [m.text, m.chat_id ?? null]), [["stale 0", null], ["stale 1", null], ["stale 2", null]]);
  assert.deepEqual(db.messagesFor(OWNER_C, { chat: CHAT }).map(m => m.text), ["old chat line", "old chat reply"], "the old chat is untouched");
  assert.equal(db.webChatOwner(NEVER) ?? null, null, "never claimed");
  assert.ok(h.turns.every(t => (t.historyId ?? OWNER_C) === OWNER_C));
  assert.equal(h.fake.sent.length, sentBefore, "a Web message's reply is not texted");
  // The form (no script) lands back on the thread.
  const form = await call(h, { sub: "send", method: "POST", b: omari, body: new URLSearchParams({ id: "stale-form-aaaa", text: "form post", c: omari.csrf, chat: CHAT }).toString() });
  assert.equal(form.status, 303);
  assert.equal(form.headers.Location, "/web?thread");
});

test("3. an old chat opens read-only with all its lines; its history and stream stay its own", async () => {
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await textIn(h, { from: OWNER, id: "t1", body: "from my phone" });
  oldChat(OWNER_C, CHAT, [["user", "plan my saturday"], ["assistant", "re: plan my saturday"]]);
  oldChat(OWNER_C, CHAT2, [["user", "something else"]]);
  // The shared thread doesn't see them.
  assert.ok(!db.messagesFor(OWNER_C).some(m => /saturday|something else/.test(m.text)));
  assert.ok((await history(h, omari, { after: "0" })).messages.every(m => !/saturday/.test(m.text)));
  // Its own reads still work.
  assert.deepEqual((await history(h, omari, { after: "0", chat: CHAT })).messages.map(m => m.text), ["plan my saturday", "re: plan my saturday"]);
  assert.deepEqual((await history(h, omari, { chat: CHAT })).messages.map(m => m.text), ["plan my saturday", "re: plan my saturday"]);
  // The page: drawn whole on the server, no composer, the closed foot.
  await call(h, { b: omari });
  const page = await call(h, { b: omari, query: { chat: CHAT } });
  assert.equal(page.status, 200);
  const log = /<ol class="thread"[^>]*>([\s\S]*?)<\/ol>/.exec(page.body)?.[1] ?? "";
  assert.match(log, /plan my saturday/);
  assert.match(log, /re: plan my saturday/);
  assert.ok(!/something else|from my phone/.test(page.body), "only its own lines");
  assert.ok(!/class="cform"/.test(page.body), "no composer");
  assert.ok(!/name="chat"/.test(page.body));
  assert.ok(page.body.includes(convo.CLOSED_CHAT), "the closed foot");
  assert.match(convo.CLOSED_CHAT, /href="\/web\?thread"[^>]*>Continue the thread/);
  assert.match(page.body, new RegExp(`chat:"${CHAT}"`), "the page's own reads stay the chat's");
  // A chat id that was never started is not found.
  assert.equal((await call(h, { b: omari, query: { chat: NEVER } })).status, 404);
  // With a detail's about + click id it is the shared thread, talking about that row.
  const withAbout = await call(h, { b: omari, query: { chat: CHAT, about: "task:1", k: "click-kkkkkkkkkkkk" } });
  assert.equal(withAbout.status, 200);
  assert.match(withAbout.body, /chat:"",ab:"task:1",ak:"click-kkkkkkkkkkkk"/);
  assert.match(withAbout.body, /class="cform"/);
  // The stream for the chat carries the chat's rows only.
  const s = openStream(h, omari, { chat: CHAT });
  await textIn(h, { from: OWNER, id: "t2", body: "phone again" });
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "web", text: "a late chat line", chatId: db.webChatRoute(CHAT) });
  db.writeMessage({ conversationId: OWNER_C, role: "assistant", channel: "web", text: "late in chat two", chatId: db.webChatRoute(CHAT2) });
  await until(() => s.events().some(e => e.event === "message" && e.data.text === "a late chat line"), 1500);
  s.close();
  const texts = s.events().filter(e => e.event === "message").map(e => e.data.text);
  assert.ok(texts.includes("a late chat line"), JSON.stringify(texts));
  assert.ok(!texts.includes("phone again") && !texts.includes("late in chat two"), JSON.stringify(texts));
});

test("4. another account can't open, read or stream somebody's old chat; a stale post never reaches it", async () => {
  const h = harness();
  oldChat(OWNER_C, CHAT, [["user", "my private chat"], ["assistant", "ok"]]);
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await call(h, { b: kofi });
  assert.equal((await call(h, { b: kofi, query: { chat: CHAT } })).status, 404);
  assert.equal((await call(h, { sub: "history", b: kofi, query: { chat: CHAT, after: "0" } })).status, 404);
  assert.equal((await call(h, { sub: "history", b: kofi, query: { chat: CHAT } })).status, 404);
  assert.equal(convo.streamRequest({ account: db.getAccount(KOFI_C), headers: headersFor(kofi), query: { chat: CHAT } }).status, 404);
  assert.ok(!(await call(h, { b: kofi, query: { chat: CHAT } })).body.includes("my private chat"));
  // Kofi's post naming Omari's chat is just a message in Kofi's own thread.
  const out = await send(h, kofi, { id: "wc-0202-aaaa", text: "let me in", extra: { chat: CHAT } });
  assert.equal(out.status, 200);
  assert.ok(await until(() => db.messagesFor(KOFI_C).some(m => m.text === "let me in")));
  assert.equal(db.webChatOwner(CHAT), OWNER_C);
  assert.ok(!db.messagesFor(OWNER_C, { chat: CHAT }).some(m => m.text === "let me in"));
  assert.ok(!db.messagesFor(OWNER_C).some(m => m.text === "let me in"));
  // Malformed ids are refused.
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await call(h, { b: omari });
  assert.equal((await call(h, { b: omari, query: { chat: "../../x" } })).status, 404);
  assert.equal(convo.chatFrom(OWNER_C, CHAT), CHAT);
  assert.equal(convo.chatFrom(KOFI_C, CHAT), null, "another's");
  assert.equal(convo.chatFrom(OWNER_C, NEVER), null, "unclaimed");
  assert.equal(convo.chatFrom(OWNER_C, ""), "");
  // Kofi's own rows never carry Omari's chat id even if forged on the route.
  db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "web", text: "forged", chatId: db.webChatRoute(CHAT) });
  assert.ok(!db.messagesFor(KOFI_C, { chat: CHAT }).length);
});

test("5. a turn still keyed to an old chat reads its own thread; its tools still act for the person", async () => {
  const h = harness();
  db.claimWebChat(OWNER_C, CHAT);
  await textIn(h, { from: OWNER, id: "t1", body: "shared hello" });
  await intoOldChat(h, CHAT, "wc-0101-aaaa", "only in the chat");
  assert.ok(await until(() => h.turns.length === 2));
  const [shared, chat] = h.turns;
  assert.equal(shared.historyId, undefined, "a text reads the shared thread");
  assert.equal(chat.conversationId, OWNER_C, "the person's conversation: memory, tasks, approvals");
  assert.equal(chat.historyId, `${OWNER_C}#web:${CHAT}`);
  assert.equal(db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT)), `${OWNER_C}#web:${CHAT}`);
  assert.equal(db.historyKeyFor(KOFI_C, db.webChatRoute(CHAT)), KOFI_C, "never another account's chat key");
  assert.equal(db.historyKeyFor(OWNER_C, null), OWNER_C);
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

test("7. Chat history lists old chats, each opening read-only; the day view stays the shared thread", async () => {
  const hist = await import("../src/pages/webhistory.js");
  const h = harness();
  await textIn(h, { from: OWNER, id: "t1", body: "phone line" });
  assert.ok(await until(() => db.messagesFor(OWNER_C).length === 2));
  oldChat(OWNER_C, CHAT, [["user", "Plan a birthday dinner for Ama"], ["assistant", "On it."]]);
  const page = hist.renderHistory({ account: db.getAccount(OWNER_C) });
  assert.match(page, new RegExp(`<a class="dy" href="/web\\?chat=${CHAT}"><span class="dy-d">Plan a birthday dinner for Ama</span><span class="dy-go" aria-hidden="true">→</span><span class="dy-m">WEB CHAT · [^<]+ · 2 MESSAGES</span>`));
  const dayRows = [...page.matchAll(/<a class="dy" href="\/web\/memory\/history\?day=/g)].length;
  assert.equal(dayRows, 1);
  const key = hist.dayKey(clock.now());
  assert.ok(hist.dayLines(OWNER_C, key).every(m => !/birthday/.test(m.html)), "the day is the shared thread's");
  assert.equal(hist.searchMessages(OWNER_C, "birthday").total, 0);
  // Its link opens it read-only.
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await call(h, { b: omari });
  const opened = await call(h, { b: omari, query: { chat: CHAT } });
  assert.equal(opened.status, 200);
  assert.match(opened.body, /Plan a birthday dinner for Ama/);
  assert.ok(!/class="cform"/.test(opened.body));
  // Kofi's history never lists Omari's chat.
  assert.ok(!hist.renderHistory({ account: db.getAccount(KOFI_C) }).includes(CHAT));
});

test("8. an approval asked in an old chat is adopted by the shared thread and granted only by a reply after that", async () => {
  const trust = await import("../src/trust.js");
  const { saveThread } = await import("../src/thread.js");
  db.db.exec("DELETE FROM confirmations");
  db.claimWebChat(OWNER_C, CHAT);
  const key = db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT));
  const line = (t) => ({ role: "user", content: `[Mon 9:00am] Omari (web): ${t}` });
  const asked = trust.requestConfirmation({ conversationId: OWNER_C, messages: [line("buy the headphones")], historyId: key, action: "purchase_confirm", summary: "Buy the headphones for $80", stakes: "money" });
  assert.equal(db.getConfirmation(OWNER_C, asked.confirmation_id).thread_key, key);
  // The shared thread is cut to size before anything checks it: the chat's mark stays where it was.
  saveThread(OWNER_C, Array.from({ length: 400 }, (_, i) => line(`old ${i}`)), { max: 50 });
  assert.equal(db.getConfirmation(OWNER_C, asked.confirmation_id).asked_after_msgs, 1);
  let judged = 0;
  const yes = async () => { judged++; return { verdict: "yes" }; };
  // The shared thread checks it: it moves here, and a yes said before that was never said to it.
  const shared = [line("a"), line("b"), line("sure, go for it")];
  const first = await trust.recordConfirmation({ conversationId: OWNER_C, messages: shared, confirmationId: asked.confirmation_id, judge: yes });
  assert.equal(first.ok, false);
  assert.equal(first.state, "waiting_for_yes");
  assert.equal(judged, 0, "nothing was read as its answer");
  const row = db.getConfirmation(OWNER_C, asked.confirmation_id);
  assert.equal(row.thread_key, null, "adopted by the shared thread");
  assert.equal(row.asked_after_msgs, 3, "counted from the shared thread's owner texts now");
  // A turn still keyed to the old chat keeps the old scoping: it can't answer it any more.
  assert.equal((await trust.recordConfirmation({ conversationId: OWNER_C, messages: [line("buy"), line("yes")], historyId: key, confirmationId: asked.confirmation_id, judge: yes })).state, "asked_elsewhere");
  // A shared-thread reply after adoption grants it.
  const ok = await trust.recordConfirmation({ conversationId: OWNER_C, messages: [...shared, line("yes do it")], confirmationId: asked.confirmation_id, judge: yes });
  assert.equal(ok.ok, true);
  assert.equal(ok.state, "granted");
  assert.equal(ok.quote, "yes do it");
  // A shared-thread ask is never answered from a Web-chat turn.
  const sharedAsk = trust.requestConfirmation({ conversationId: OWNER_C, messages: [line("book it")], action: "browser_submit", summary: "Book the table", stakes: "commitment" });
  assert.equal((await trust.recordConfirmation({ conversationId: OWNER_C, messages: [line("x"), line("yes")], historyId: key, confirmationId: sharedAsk.confirmation_id, judge: yes })).state, "asked_elsewhere");
  // A yes already given in the old chat keeps its count when adopted.
  const given = trust.requestConfirmation({ conversationId: OWNER_C, messages: [line("order it")], historyId: key, action: "purchase_confirm", summary: "Order the charger", stakes: "money" });
  assert.equal((await trust.recordConfirmation({ conversationId: OWNER_C, messages: [line("order it"), line("yes")], historyId: key, confirmationId: given.confirmation_id, judge: yes })).state, "granted");
  assert.equal(trust.adoptWebChatAsks(OWNER_C, [line("1"), line("2"), line("3"), line("4"), line("5")]), 1);
  const g = db.getConfirmation(OWNER_C, given.confirmation_id);
  assert.equal(g.thread_key, null);
  assert.equal(g.asked_after_msgs, 1, "a granted ask keeps its count");
  assert.equal((await trust.recordConfirmation({ conversationId: OWNER_C, messages: [line("x")], confirmationId: given.confirmation_id, judge: yes })).state, "granted");
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

test("11. an old chat's approval: its Ongoing link is the shared thread; confirm_pending there adopts it", async () => {
  const trust = await import("../src/trust.js");
  const og = await import("../src/ongoing.js");
  const page = await import("../src/pages/webongoing.js");
  db.db.exec("DELETE FROM confirmations");
  db.claimWebChat(OWNER_C, CHAT);
  const key = db.historyKeyFor(OWNER_C, db.webChatRoute(CHAT));
  const asked = trust.requestConfirmation({ conversationId: OWNER_C, messages: [], historyId: key, action: "purchase_confirm", summary: "Buy the headphones", stakes: "money" });
  const x = og.findItem(OWNER_C, "approval", asked.confirmation_id);
  assert.ok(!("chat" in x), "an approval carries no chat");
  const about = encodeURIComponent(`approval:${asked.confirmation_id}`);
  assert.equal(page.talkHref(x), `/web?thread&about=${about}`, "no click id until a detail page draws it");
  const href = /<div class="ogd-foot"><a class="act[^"]*" href="([^"]+)"/.exec(page.renderDetail(x))?.[1]?.replace(/&amp;/g, "&");
  assert.match(href, new RegExp(`^/web\\?thread&about=${about}&k=[A-Za-z0-9_-]{16}$`));
  // The model's pending list: a turn still keyed to the chat sees the chat's ask only (old scoping)…
  const { runTool } = await import("../src/tools.js");
  const sharedAsk = trust.requestConfirmation({ conversationId: OWNER_C, messages: [], action: "browser_submit", summary: "Book the table", stakes: "commitment" });
  const inChat = await runTool("confirm_pending", {}, { conversationId: OWNER_C, historyId: key, messages: [] });
  assert.deepEqual(inChat.waiting_on_an_answer.map(w => w.confirmation_id), [asked.confirmation_id]);
  // …and the shared thread adopts it, so it lists both.
  const inShared = await runTool("confirm_pending", {}, { conversationId: OWNER_C, messages: [] });
  assert.deepEqual(inShared.waiting_on_an_answer.map(w => w.confirmation_id).sort((a, b) => a - b), [asked.confirmation_id, sharedAsk.confirmation_id].sort((a, b) => a - b));
  assert.equal(db.getConfirmation(OWNER_C, asked.confirmation_id).thread_key, null);
  assert.deepEqual((await runTool("confirm_pending", {}, { conversationId: OWNER_C, historyId: key, messages: [] })).waiting_on_an_answer ?? [], [], "the old chat has nothing left to answer");
});

test("12. review: a yes in a Web chat's turn never verifies a call whose check went to their phone", async () => {
  db.db.exec("DELETE FROM calls");
  const call_ = db.createCall(OWNER_C, { provider: "fake", toNumber: OWNER, isOwner: true, goal: "check in", facts: [] });
  db.updateCall(OWNER_C, call_.id, { verify_sent_at: clock.now(), verify_sent_after_msgs: 0 });
  const h = harness();
  db.claimWebChat(OWNER_C, CHAT);
  await intoOldChat(h, CHAT, "wc-0501-aaaa", "yes");
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 2));
  assert.equal(h.turns.length, 1, "the chat's own turn ran");
  assert.equal(db.pendingCallVerification(OWNER_C)?.id, call_.id, "still waiting on the phone's answer");
});
