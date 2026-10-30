// Reason Web: reply to one message (REASON_WEB_REPLY, src/pages/webreply.js). One pinned test per rule:
//
//   - off: no Reply button, no composer line, and a `re` on a send is not read
//   - owner: the operator's own conversation only
//   - a Web reply reaches the turn exactly as an iMessage inline reply does: the line names the message
//     (theirs or Reason's, Web or iMessage), the inbound row keeps parent + thread root
//   - the browser names a history row, never a handle; another person's row is not a reply (the message
//     still goes, ordinary); a malformed `re` is refused
//   - the thread draws a quiet quote line over a reply — theirs from Web, theirs from an iMessage thread,
//     Reason's pinned answer — linking to the parent, and the reply note the turn read is not shown as words
//   - a Web turn's answer is pinned by the same rule as a text's (replies.answerTarget) when the thread
//     moved on, and draws its quote on Web
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-reply-"));
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
const reply = await import("../src/pages/webreply.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  process.env.REASON_WEB_REPLY = "on";
  convo.resetSendLimits();
  db.db.exec(`DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue;
    DELETE FROM requests; DELETE FROM page_sessions;`);
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});

function harness({ turn = async ({ text }) => `re: ${text.split("\n").at(-1)}` } = {}) {
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
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token), conv: conversationId };
}
const headersFor = (b) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", cookie: b.cookie });
const call = (h, { sub = null, method = "GET", b, query = {}, body = null, headers = {} }) =>
  webRequestFor({ sub, method, query, headers: { ...headersFor(b), ...headers }, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
const send = (h, b, { id, text, re = null }) =>
  call(h, { sub: "send", method: "POST", b, body: new URLSearchParams({ id, text, c: b.csrf, ...(re != null ? { re: String(re) } : {}) }).toString(), headers: { accept: "application/json", "x-reason-csrf": b.csrf } });
const history = async (h, b) => JSON.parse((await call(h, { sub: "history", b, query: { after: "0" } })).body).messages;
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const rows = (c) => db.messagesFor(c);
const textIn = (h, { from = KOFI, id, body, replyTo = null, threadRoot = null }) =>
  h.router.deliver({ channel: "fake", externalId: id, from, text: body, chatId: null, at: clock.now(), ...(replyTo ? { replyTo } : {}), ...(threadRoot ? { threadRoot } : {}) });

test("off: no Reply button, no composer line, and a `re` on a send is not read", async () => {
  process.env.REASON_WEB_REPLY = "off";
  const h = harness();
  const kofi = browser(KOFI_C);
  await send(h, kofi, { id: "off-0001-aaaa", text: "is 8 ok for dinner" });
  await until(() => h.web.recent.length === 1);
  const page = (await call(h, { b: kofi, query: { thread: "" } })).body;
  assert.ok(!page.includes('class="rp"'), "no Reply button");
  assert.ok(!page.includes('class="rchip"'), "no composer line");
  assert.ok(!page.includes(".rchip{"), "nor its look");
  const parent = rows(KOFI_C).at(-1).id;
  await send(h, kofi, { id: "off-0002-aaaa", text: "yes", re: parent });
  await until(() => h.turns.length === 2);
  assert.ok(!/inline reply/.test(h.turns[1].text), "the turn reads an ordinary message");
  assert.equal(db.db.prepare("SELECT reply_to FROM inbound_messages WHERE external_id = ?").get(`${KOFI_C}:off-0002-aaaa`).reply_to, null);
});

test("owner: only the operator's own conversation has it", async () => {
  process.env.REASON_WEB_REPLY = "owner";
  const h = harness();
  const me = browser(OWNER_C), kofi = browser(KOFI_C);
  await send(h, me, { id: "own-0001-aaaa", text: "hello" });
  await send(h, kofi, { id: "own-0002-aaaa", text: "hello" });
  await until(() => h.web.recent.length === 2);
  const mine = (await call(h, { b: me, query: { thread: "" } })).body;
  const his = (await call(h, { b: kofi, query: { thread: "" } })).body;
  assert.match(mine, /class="rchip"/);
  assert.ok(!his.includes('class="rchip"'));
  assert.ok((await history(h, me)).every(m => m.canReply), "every line of the owner's carries the button");
  assert.ok((await history(h, kofi)).every(m => !m.canReply && !/class="rp"/.test(m.html)));
});

test("a Web reply to Reason's message reads as an inline reply to it, with the thread kept on the row", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  await send(h, kofi, { id: "rep-0001-aaaa", text: "table for two at 8?" });
  await until(() => h.web.recent.length === 1);
  await send(h, kofi, { id: "rep-0002-aaaa", text: "also what's the weather" });
  await until(() => h.web.recent.length === 2);
  const answer = rows(KOFI_C).find(r => r.role === "assistant" && r.text === "re: table for two at 8?");
  const out = await send(h, kofi, { id: "rep-0003-aaaa", text: "yeah do it", re: answer.id });
  assert.equal(out.status, 200);
  await until(() => h.turns.length === 3);
  assert.match(h.turns[2].text, /\[they sent this as an inline reply in the thread under your message: "re: table for two at 8\?"/);
  assert.match(h.turns[2].text, /yeah do it$/);
  const handle = db.db.prepare("SELECT message_id FROM outbox WHERE id = ?").get(answer.outbox_id).message_id;
  const row = db.db.prepare("SELECT reply_to, thread_root FROM inbound_messages WHERE external_id = ?").get(`${KOFI_C}:rep-0003-aaaa`);
  assert.equal(row.reply_to, handle, "the parent is the message they pressed Reply on");
  assert.equal(row.thread_root, handle, "a message in no thread starts its own");
  // A second reply in that thread, under their own first reply, is in the same thread.
  await until(() => h.web.recent.length === 3);
  const first = rows(KOFI_C).find(r => r.role === "user" && r.external_id === `${KOFI_C}:rep-0003-aaaa`);
  await send(h, kofi, { id: "rep-0004-aaaa", text: "and a window seat", re: first.id });
  await until(() => h.turns.length === 4);
  assert.equal(db.db.prepare("SELECT thread_root FROM inbound_messages WHERE external_id = ?").get(`${KOFI_C}:rep-0004-aaaa`).thread_root, handle);
  assert.match(h.turns[3].text, /in the thread under your message: "re: table for two at 8\?"/);
});

test("a Web reply to one of their own iMessage texts names that text", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  await textIn(h, { id: "sb-handle-1", body: "remind me to call mum" });
  await until(() => h.fake.sent.length === 1);
  const theirs = rows(KOFI_C).find(r => r.role === "user");
  await send(h, kofi, { id: "rep-0101-aaaa", text: "make it 6pm", re: theirs.id });
  await until(() => h.turns.length === 2);
  assert.match(h.turns[1].text, /in the thread under their message: "remind me to call mum"/);
  assert.equal(db.db.prepare("SELECT reply_to FROM inbound_messages WHERE external_id = ?").get(`${KOFI_C}:rep-0101-aaaa`).reply_to, "sb-handle-1");
  assert.equal(h.web.recent.length, 1, "answered on Web");
  assert.equal(h.fake.sent.length, 1, "nothing more texted");
});

test("the browser names a row, never a handle: someone else's row is no reply, a malformed one is refused", async () => {
  const h = harness();
  const me = browser(OWNER_C), kofi = browser(KOFI_C);
  await send(h, me, { id: "own-0201-aaaa", text: "my private line" });
  await until(() => h.web.recent.length === 1);
  const mine = rows(OWNER_C).find(r => r.role === "user");
  const out = await send(h, kofi, { id: "frg-0201-aaaa", text: "replying to his", re: mine.id });
  assert.equal(out.status, 200, "the message itself still goes");
  await until(() => h.turns.length === 2);
  assert.ok(!/inline reply/.test(h.turns[1].text));
  assert.ok(!h.turns[1].text.includes("my private line"));
  assert.ok(h.logs.some(e => e.web_reply_unknown === String(mine.id)));
  assert.equal(reply.handleOfRow(KOFI_C, mine.id), null);
  const bad = await send(h, kofi, { id: "frg-0202-aaaa", text: "x", re: "sb-handle-1" });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error, "bad_reply");
});

test("the thread draws a quote line over a reply, linking to its parent; the note the turn read is not repeated", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  await send(h, kofi, { id: "drw-0001-aaaa", text: "find me a <b>plumber</b>" });
  await until(() => h.web.recent.length === 1);
  const answer = rows(KOFI_C).find(r => r.role === "assistant");
  await send(h, kofi, { id: "drw-0002-aaaa", text: "the second one", re: answer.id });
  await until(() => h.web.recent.length === 2);
  const lines = await history(h, kofi);
  const theirs = lines.find(m => m.cid === "drw-0002-aaaa");
  assert.deepEqual(theirs.quote, { id: answer.id, who: "REASON", text: "re: find me a <b>plumber</b>" });
  assert.match(theirs.html, new RegExp(`<a class="rq" href="/web\\?thread&amp;at=${answer.id}#m-${answer.id}" data-to="${answer.id}"`));
  assert.match(theirs.html, /re: find me a &lt;b&gt;plumber&lt;\/b&gt;/, "escaped");
  assert.ok(!/inline reply/.test(theirs.html), "the stored note is not drawn as their words");
  assert.match(theirs.html, /<div class="said">the second one<\/div>/);
  // The page draws the same line, with the composer's line and its script.
  const page = (await call(h, { b: kofi, query: { at: String(theirs.id) } })).body;
  assert.match(page, /class="rq"/);
  assert.match(page, /class="rchip" hidden/);
  assert.match(page, /R\.rp=function/);
  // A line with no parent has no quote, and a fold of History's day view has neither button nor quote.
  assert.equal(lines[0].quote, null);
  assert.equal(convo.rowOut({ ...rows(KOFI_C).find(r => r.id === theirs.id) }, { conversationId: KOFI_C, reply: false }).quote, null);
});

test("an iMessage thread reply and Reason's pinned answer draw their quote on Web", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  await textIn(h, { id: "sb-root-1", body: "live there" });
  await until(() => h.fake.sent.length === 1);
  await textIn(h, { id: "sb-reply-1", body: "yeah", replyTo: "sb-newest-wrong", threadRoot: "sb-root-1" });
  await until(() => h.fake.sent.length === 2);
  const lines = await history(h, kofi);
  const yeah = lines.find(m => m.role === "user" && /yeah/.test(m.html));
  assert.equal(yeah.quote?.text, "live there", "the thread it was sent in, not the parent Sendblue named");
  assert.equal(yeah.quote?.who, "YOU");
  // Reason's own pinned message (the outbox's reply_to) draws the same way.
  const ob = db.db.prepare("SELECT id FROM outbox WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(KOFI_C);
  db.db.prepare("UPDATE outbox SET reply_to = 'sb-root-1' WHERE id = ?").run(ob.id);
  const pinned = (await history(h, kofi)).find(m => m.role === "assistant" && m.id === rows(KOFI_C).find(r => r.outbox_id === ob.id).id);
  assert.equal(pinned.quote?.text, "live there");
  assert.match(pinned.html, /class="rq"/);
});

test("a Web turn's answer is pinned under the message it answers once the thread has moved on", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let first = true;
  const h = harness({ turn: async ({ text }) => { if (first) { first = false; await gate; } return `re: ${text.split("\n").at(-1)}`; } });
  const kofi = browser(KOFI_C);
  await send(h, kofi, { id: "pin-0001-aaaa", text: "what time is the game" });
  await until(() => h.turns.length === 1);
  assert.equal(h.turns[0].answering?.handle, `${KOFI_C}:pin-0001-aaaa`, "the Web turn knows which message it answers");
  // While that answer is being worked out, the thread moves on: a message lands that this turn did not
  // send and does not answer (claimed, as an arrival is, and not folded into this turn).
  db.claimInbound({ channel: "fake", externalId: "sb-mid-1", conversationId: KOFI_C, text: "and grab milk" });
  release();
  await until(() => h.web.recent.length >= 1);
  const ob = db.db.prepare("SELECT reply_to FROM outbox WHERE conversation_id = ? AND channel = 'web' ORDER BY id LIMIT 1").get(KOFI_C);
  assert.equal(ob.reply_to, `${KOFI_C}:pin-0001-aaaa`, "pinned under the Web message it answers");
  const lines = await history(h, kofi);
  const ans = lines.find(m => m.role === "assistant" && /what time is the game/.test(m.html) && m.quote);
  assert.equal(ans?.quote.text, "what time is the game");
  assert.equal(ans.quote.who, "YOU");
});

test("off: a Web turn is not told which message it answers, so nothing on Web is pinned", async () => {
  process.env.REASON_WEB_REPLY = "off";
  const h = harness();
  await send(h, browser(KOFI_C), { id: "pin-0101-aaaa", text: "hi" });
  await until(() => h.turns.length === 1);
  assert.equal(h.turns[0].answering, undefined);
});

test("threadRootOf follows a reply up to the message its thread started with, and stops on a loop", () => {
  db.claimInbound({ channel: "fake", externalId: "a", conversationId: KOFI_C, text: "a" });
  db.claimInbound({ channel: "fake", externalId: "b", conversationId: KOFI_C, text: "b", replyTo: "a", threadRoot: "a" });
  db.claimInbound({ channel: "fake", externalId: "c", conversationId: KOFI_C, text: "c", replyTo: "b" });
  db.claimInbound({ channel: "fake", externalId: "x", conversationId: KOFI_C, text: "x", replyTo: "y" });
  db.claimInbound({ channel: "fake", externalId: "y", conversationId: KOFI_C, text: "y", replyTo: "x" });
  assert.equal(reply.threadRootOf(KOFI_C, "a"), "a");
  assert.equal(reply.threadRootOf(KOFI_C, "c"), "a");
  assert.ok(["x", "y"].includes(reply.threadRootOf(KOFI_C, "x")));
  assert.equal(reply.threadRootOf(OWNER_C, "c"), "c", "another conversation's rows are not read");
});
