// Reason Web, phase W2: the conversation (src/pages/webconvo.js, routed through src/pages/websignin.js
// and src/http.js). Spec §10 as it applies to the conversation, one pinned test per rule:
//
//   - two people never see each other's history: page, older pages, catch-up, live stream
//   - a forged conversation id (in a query, in the form, an id from somebody else's history) is refused
//     or finds nothing; the session alone names the conversation
//   - a Web message is answered on Web only: nothing is texted for it
//   - a refresh resending, a second tab, a retried post: one message id = one turn, one history row
//   - the tab closing changes nothing: the send is acknowledged before the turn ends, the turn runs
//     on, and the answer is in history when they come back
//   - the history boundary note shows once (first visit), never again
//   - decision 9: after a switch from Web to texting, Reason's next text carries one line about Web,
//     once per switch; never on a code; not after a long gap
//   - signed out, cross-site, or without the session's secret: refused, no turn
//   - safe rendering: a message's words are never markup; only http(s) links become links
//   - the stream hears its own conversation only, passes typing for its own person only, and ends on sign-out
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-web-convo-"));
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
    DELETE FROM requests; DELETE FROM page_sessions;`);
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

test("two people never see each other's history: the page, older pages, catch-up and the stream are each their own", async () => {
  const h = harness();
  await textIn(h, { from: KOFI, id: "k1", body: "kofi's secret plan" });
  await textIn(h, { from: AMA, id: "a1", body: "ama's private note" });
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const ama = { ...browser(AMA_C), conv: AMA_C };

  const kPage = await thread(h, kofi);
  assert.match(kPage, /kofi&#39;s secret plan/);
  assert.ok(!kPage.includes("ama"), "Kofi's page has nothing of Ama's");
  const aPage = await thread(h, ama);
  assert.match(aPage, /ama&#39;s private note/);
  assert.ok(!aPage.includes("kofi"));

  // Catch-up from zero and an older page are Kofi's only.
  assert.ok((await history(h, kofi, { after: "0" })).messages.every(m => !/ama/.test(m.text)));
  assert.ok((await history(h, kofi, {})).messages.every(m => !/ama/.test(m.text)));
  // Kofi's stream does not carry a line Ama's conversation gets while it is open.
  const s = openStream(h, kofi);
  await textIn(h, { from: AMA, id: "a2", body: "ama again" });
  await textIn(h, { from: KOFI, id: "k2", body: "kofi again" });
  s.close();
  const texts = s.events().filter(e => e.event === "message").map(e => e.data.text);
  assert.ok(texts.includes("kofi again"));
  assert.ok(!texts.some(t => /ama/.test(t)), "nothing of Ama's crossed into Kofi's stream");
});

test("a forged conversation id is refused or finds nothing: the session alone names the conversation", async () => {
  const h = harness();
  await textIn(h, { from: AMA, id: "a1", body: "ama's line" });
  const amaRow = db.messagesFor(AMA_C)[0].id;
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };

  // An older page "before" one of Ama's rows: Kofi's conversation has nothing to stand on.
  assert.deepEqual((await history(h, kofi, { before: String(amaRow) })).messages, []);
  // A conversation named in the query is not read.
  assert.ok((await history(h, kofi, { conversationId: AMA_C, conversation: AMA_C })).messages.every(m => m.text !== "ama's line"));
  // A send naming Ama's conversation in the form lands in Kofi's.
  const out = await send(h, kofi, { id: "forge-0001", text: "mine, whatever the form says", extra: { conversationId: AMA_C, conversation_id: AMA_C } });
  assert.equal(out.status, 200);
  await until(() => h.web.recent.length >= 1);
  assert.ok(rowsOf(KOFI_C).some(r => r[2] === "mine, whatever the form says"));
  assert.ok(!rowsOf(AMA_C).some(r => r[2] === "mine, whatever the form says"), "nothing was written into Ama's conversation");
  // And the router itself refuses a web inbound whose conversation is not the account's.
  const forged = await h.router.deliver({ channel: "web", externalId: "x-forged-1", conversationId: "dm:fake:+19995550000", text: "hi", at: clock.now() });
  assert.equal(forged.ok, false);
  assert.equal(forged.refused, "no_account");
});

// ---------- one reply, where they're chatting ----------

test("a Web message is answered on Web only: nothing is texted, and the reply is in the conversation", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const out = await send(h, kofi, { id: "w-0001-aaaa", text: "find me a quiet dinner spot" });
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.body).ok, true);
  assert.ok(await until(() => h.web.recent.length === 1));
  assert.equal(h.web.recent[0].text, "re: find me a quiet dinner spot");
  assert.equal(h.fake.sent.length, 0, "no text went to the phone");
  assert.deepEqual(rowsOf(KOFI_C), [["user", "web", "find me a quiet dinner spot"], ["assistant", "web", "re: find me a quiet dinner spot"]]);
  // The page shows both, labelled Web.
  const lines = (await history(h, kofi, { after: "0" })).messages;
  assert.deepEqual(lines.map(m => [m.role, m.source]), [["user", "Web"], ["assistant", "Web"]]);
  assert.equal(lines[0].cid, "w-0001-aaaa", "the browser's own id comes back, so its sending bubble is replaced, not doubled");
});

test("a refresh resending, a second tab, a retried post: one message id is one turn and one history row", async () => {
  const h = harness();
  const tab1 = { ...browser(KOFI_C), conv: KOFI_C };
  const tab2 = { ...browser(KOFI_C), conv: KOFI_C };
  const id = "same-id-0001";
  await send(h, tab1, { id, text: "book the table" });
  await until(() => h.web.recent.length === 1);
  const again = await send(h, tab1, { id, text: "book the table" });
  const other = await send(h, tab2, { id, text: "book the table" });
  assert.equal(again.status, 200);
  assert.equal(JSON.parse(again.body).duplicate, true);
  assert.equal(JSON.parse(other.body).duplicate, true, "a second tab of the same person replaying the id is the same message");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.turns.length, 1, "one turn");
  assert.equal(h.web.recent.length, 1, "one reply");
  assert.equal(rowsOf(KOFI_C).filter(r => r[0] === "user").length, 1, "one history row");
  // The same id from ANOTHER person is their own message, not a duplicate of Kofi's.
  const ama = { ...browser(AMA_C), conv: AMA_C };
  const theirs = await send(h, ama, { id, text: "different person" });
  assert.equal(JSON.parse(theirs.body).duplicate, false);
  await until(() => h.turns.length === 2);
  assert.equal(h.turns.length, 2);
});

test("closing the tab keeps the work: the send is acknowledged before the turn ends, and the answer is in history later", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness({ turn: async ({ text }) => { await gate; return `done: ${text}`; } });
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const out = await convo.sendRequest({
    account: db.getAccount(KOFI_C), headers: { ...headersFor(kofi), accept: "application/json", "x-reason-csrf": kofi.csrf },
    readBody: async () => new URLSearchParams({ id: "long-0001", text: "research flights to Accra", c: kofi.csrf }).toString(),
    router: h.router, ackWaitMs: 50,
  });
  assert.equal(out.status, 200, "acknowledged while the turn is still running");
  assert.equal(JSON.parse(out.body).ok, true);
  assert.equal(h.web.recent.length, 0, "no answer yet");
  // The tab is gone: nobody is listening. The turn finishes anyway.
  release();
  assert.ok(await until(() => h.web.recent.length === 1));
  // They come back: a fresh page has the answer.
  const page = await thread(h, { ...browser(KOFI_C), conv: KOFI_C });
  assert.match(page, /done: research flights to Accra/);
});

// ---------- the boundary, once ----------

test("the history boundary note shows on the first Web visit only, never as a recurring popup", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const first = (await call(h, { b: kofi })).body;
  assert.match(first, FIRST);
  assert.match(first, /This is the same Reason you text\. What you send here stays here; it won&#39;t show up in your iMessage thread\./);
  assert.match(first, /<a class="act" href="\/web">Got it <span aria-hidden="true">→<\/span><\/a>/);
  const second = (await call(h, { b: kofi })).body;
  assert.ok(!FIRST.test(second), "not again");
  assert.match(second, /class="greet"/, "the arrival instead");
  assert.ok(!FIRST.test((await call(h, { b: kofi, query: { thread: "" } })).body), "nor on the thread");
  const otherBrowser = (await call(h, { b: { ...browser(KOFI_C), conv: KOFI_C } })).body;
  assert.ok(!FIRST.test(otherBrowser), "once per person, not per browser");
  assert.match((await call(h, { b: { ...browser(AMA_C), conv: AMA_C } })).body, FIRST, "Ama's own first visit shows it to her");
});

// ---------- decision 9 ----------

test("decision 9: after a switch from Web to texting, the next text carries one line about Web, once per switch", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await send(h, kofi, { id: "d9-web-0001", text: "plan saturday" });
  await until(() => h.web.recent.length === 1);
  assert.ok(!h.web.recent[0].text.includes(WEB_HINT), "never on a Web reply");

  await textIn(h, { id: "t1", body: "on my phone now" });
  assert.equal(h.fake.sent.at(-1).text, `re: on my phone now\n\n${WEB_HINT}`);
  await textIn(h, { id: "t2", body: "and another" });
  assert.equal(h.fake.sent.at(-1).text, "re: and another", "once per switch");

  // A second switch earns it again.
  await send(h, kofi, { id: "d9-web-0002", text: "back on web" });
  await until(() => h.web.recent.length === 2);
  await textIn(h, { id: "t3", body: "phone again" });
  assert.equal(h.fake.sent.at(-1).text, `re: phone again\n\n${WEB_HINT}`);
  assert.equal(h.fake.sent.filter(m => m.text.includes(WEB_HINT)).length, 2);

  // A text long after the last Web message is not a mid-task switch.
  await send(h, kofi, { id: "d9-web-0003", text: "one more on web" });
  await until(() => h.web.recent.length === 3);
  clock.skip(13 * HOUR);
  await textIn(h, { id: "t4", body: "next day" });
  assert.equal(h.fake.sent.at(-1).text, "re: next day");
});

test("decision 9: the line never rides on a sign-in code, and the hint is not owed to anybody the switch doesn't cover", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await send(h, kofi, { id: "d9c-0001", text: "hello" });
  await until(() => h.web.recent.length === 1);
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  await h.runtime._tell(KOFI_C, "Your Reason code is 123456", { idempotencyKey: "wsign:dm:fake:x:1" });
  assert.ok(await until(() => h.fake.sent.length === 1));
  assert.equal(h.fake.sent[0].text, "Your Reason code is 123456", "a code text stays exactly a code");
  // Owner-only mode: Kofi's conversation is not covered, so nothing about Web is ever texted to him.
  config.web = "owner";
  await textIn(h, { id: "t9", body: "hi" });
  assert.ok(!h.fake.sent.at(-1).text.includes(WEB_HINT));
});

// ---------- refusals ----------

test("signed out, cross-site, or without the session's secret: refused and no turn", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  for (const sub of ["history", "stream"]) assert.equal((await call(h, { sub })).status, 401, `${sub} signed out`);
  const anon = await call(h, { sub: "send", method: "POST", body: "id=abcdefgh1&text=hi", headers: { accept: "application/json" } });
  assert.equal(anon.status, 401);
  assert.equal((await send(h, kofi, { id: "nocsrf-0001", text: "hi", csrf: "wrong" })).status, 403);
  assert.equal((await send(h, kofi, { id: "xsite-0001", text: "hi", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await send(h, kofi, { id: "x", text: "hi" })).status, 400, "an id the page would never make");
  assert.equal((await send(h, kofi, { id: "empty-0001", text: "   " })).status, 400);
  assert.equal((await send(h, kofi, { id: "long-0001", text: "x".repeat(convo.MAX_TEXT + 1) })).status, 413);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.turns.length, 0);
  // A signed-out session stops being able to send.
  db.endPageSession(kofi.token);
  assert.equal((await send(h, kofi, { id: "after-out-1", text: "hi" })).status, 401);
  // REASON_WEB off: the conversation's paths are not there at all.
  config.web = false;
  const { createServer } = await import("../src/http.js");
  void createServer; // the off switch is pinned at the route in web-signin.test.js; here, the router refuses
  assert.equal((await h.router.deliver({ channel: "web", externalId: "off-1", conversationId: KOFI_C, text: "hi", at: clock.now() })).refused, "web_off");
});

test("a runaway sender is slowed: more than the per-minute limit is refused, nothing beyond it reaches Reason", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  for (let i = 0; i < convo.SEND_LIMIT; i++) assert.equal((await send(h, kofi, { id: `burst-${String(i).padStart(4, "0")}`, text: `m${i}` })).status, 200);
  assert.equal((await send(h, kofi, { id: "burst-over-01", text: "one too many" })).status, 429);
});

// ---------- safe rendering ----------

test("a message's words are never markup: escaped everywhere, and only http(s) addresses become links", async () => {
  const h = harness({ turn: async () => `<img src=x onerror=alert(1)> see https://example.com/a?b=1&c=2. and javascript:alert(1)` });
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await send(h, kofi, { id: "xss-0001", text: `<script>alert("x")</script>` });
  // deliver sends a lone link as its own line, so the reply is two: wait for the one with the markup in it.
  assert.ok(await until(() => rowsOf(KOFI_C).some(r => r[0] === "assistant" && r[2].includes("<img"))));
  const page = await thread(h, kofi);
  assert.ok(!page.includes(`<script>alert("x")</script>`));
  assert.match(page, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.ok(!page.includes("<img src=x"));
  assert.match(page, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer nofollow" target="_blank">/);
  assert.ok(!/href="javascript:/i.test(page));
  assert.equal(convo.linkify("go to (https://a.test/x)."), `go to (<a href="https://a.test/x" rel="noopener noreferrer nofollow" target="_blank">https://a.test/x</a>).`);
});

// ---------- the live stream ----------

test("the stream: catch-up after Last-Event-ID, live lines as they land, typing for its own person only, and it ends on sign-out", async () => {
  const h = harness();
  await textIn(h, { from: KOFI, id: "k1", body: "earlier" });
  const firstId = db.messagesFor(KOFI_C).at(-1).id;
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const s = convo.streamRequest({ account: db.getAccount(KOFI_C), headers: { ...headersFor(kofi), "last-event-id": String(firstId) }, router: h.router, recheckMs: 20 });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { write: (x) => chunks.push(x), end: () => { res.ended = true; }, ended: false });
  s.stream(res, new EventEmitter());
  assert.equal(s.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.ok(!chunks.join("").includes("earlier"), "nothing at or before Last-Event-ID is sent again");
  await send(h, kofi, { id: "live-0001", text: "live one" });
  await until(() => h.web.recent.length === 1);
  const typings = () => (chunks.join("").match(/event: typing/g) ?? []).length;
  assert.ok(typings() >= 1, "Reason's own turn on Kofi's Web message showed as working on it");
  const before = typings();
  await h.web.typing({ to: AMA, on: true });
  assert.equal(typings(), before, "Ama's typing never reaches Kofi's stream");
  await h.web.typing({ to: KOFI, on: true });
  assert.equal(typings(), before + 1);
  const all = chunks.join("");
  assert.match(all, /event: message\ndata: .*"live one"/);
  assert.match(all, /event: message\ndata: .*"re: live one"/);
  assert.match(all, /^id: \d+$/m, "every line carries its id, so a reconnect resumes after it");
  db.endPageSession(kofi.token);
  assert.ok(await until(() => res.ended, 1000), "a signed-out browser stops hearing");
  assert.match(chunks.join(""), /event: signedout/);
});

// ---------- paging ----------

test("long history pages back: forty at a time, oldest first within a page, and the start says what came before", async () => {
  const h = harness();
  for (let i = 0; i < 95; i++) { clock.skip(1000); db.writeMessage({ conversationId: KOFI_C, role: i % 2 ? "assistant" : "user", channel: "fake", externalId: i % 2 ? null : `p${i}`, text: `line ${i}` }); }
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const page = await thread(h, kofi);
  assert.match(page, /line 94/);
  assert.ok(!page.includes(">line 54<"), "only the newest forty on the page");
  assert.match(page, /↑ SHOW EARLIER MESSAGES/);
  const firstOnPage = Number(/data-id="(\d+)"/.exec(page)[1]);
  const p2 = await history(h, kofi, { before: String(firstOnPage) });
  assert.equal(p2.messages.length, 40);
  assert.equal(p2.messages.at(-1).text, "line 54");
  assert.equal(p2.more, true);
  const p3 = await history(h, kofi, { before: String(p2.messages[0].id) });
  assert.deepEqual(p3.messages.map(m => m.text), Array.from({ length: 15 }, (_, i) => `line ${i}`));
  assert.equal(p3.more, false);
  assert.match(p3.start, /^Your conversation before .+ stays in your texts\.$/);
  // Each line says who and where: iMessage for the texts.
  assert.deepEqual([...new Set(p3.messages.map(m => m.source))], ["iMessage"]);
});

test("the page itself: the composer posts to /web/send with the session's secret and a fresh id, labelled for screen readers", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await call(h, { b: kofi });
  const out = await call(h, { b: kofi, query: { thread: "" } });
  assert.equal(out.status, 200);
  assert.match(out.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.equal(out.headers["Cache-Control"], "no-store");
  const body = out.body;
  assert.match(body, /<form class="cform" method="POST" action="\/web\/send"><input type="hidden" name="c" value="[^"]+"><input type="hidden" name="id" value="[0-9a-f-]{36}">/);
  assert.match(body, /<label class="sr" for="c-input">Message Reason<\/label><textarea id="c-input" name="text"/);
  assert.match(body, /placeholder="Tell Reason what you need"/);
  assert.match(body, /<button class="send" type="submit" aria-label="Send">/);
  assert.match(body, /<ol class="thread" role="log" aria-live="polite"/);
  assert.ok(!/og:/.test(body), "no link-preview tags on a private page");
  // A plain form post (no script) is a 303 back to the conversation, and the same id twice is one turn.
  const id = /name="id" value="([^"]+)"/.exec(body)[1];
  const post = () => call(h, { sub: "send", method: "POST", b: kofi, body: new URLSearchParams({ id, text: "no script here", c: kofi.csrf }).toString() });
  const first = await post();
  assert.equal(first.status, 303);
  assert.equal(first.headers.Location, "/web?thread");
  assert.equal((await post()).status, 303);
  await until(() => h.web.recent.length === 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.turns.length, 1);
});

// ---------- review follow-ups (fresh-subagent review of #173) ----------

test("decision 9: an owed line goes stale with the switch window — it never rides on a reminder days later", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  await send(h, kofi, { id: "stale-0001", text: "on web" });
  await until(() => h.web.recent.length === 1);
  // A text arrives (the switch) but its reply never goes out through deliver.
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  clock.skip(13 * HOUR);
  await h.runtime._tell(KOFI_C, "Reminder: stretch");
  assert.ok(await until(() => h.fake.sent.length === 1));
  assert.equal(h.fake.sent[0].text, "Reminder: stretch");
  assert.equal(db.getThread(KOFI_C).web_hint_due, 0, "and it is cleared, not left waiting");
});

test("a HEAD of /web does not spend the once-only boundary note", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  assert.equal((await call(h, { b: kofi, method: "HEAD" })).status, 200);
  assert.match((await call(h, { b: kofi })).body, FIRST, "the first real view still shows it");
});

test("a stream whose session is already gone at the first look ends quietly, without throwing", async () => {
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  const acct = db.getAccount(KOFI_C);
  db.endPageSession(kofi.token);
  const s = convo.streamRequest({ account: acct, headers: headersFor(kofi), router: h.router });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { write: (x) => chunks.push(x), end: () => { res.ended = true; }, ended: false });
  assert.doesNotThrow(() => s.stream(res, new EventEmitter()));
  assert.equal(res.ended, true);
  assert.match(chunks.join(""), /event: signedout/);
  assert.equal(db.historyBus.listenerCount("row"), 0, "nothing left listening");
});

test("the signed-in greeting: \"What's good, <first name>?\", first name only, or \"What's good?\" with no name", async () => {
  const ws = await import("../src/pages/websignin.js");
  assert.equal(ws.greeting("Omari Nyarko"), "What's good, Omari?");
  assert.equal(ws.greeting("  Ama "), "What's good, Ama?");
  assert.equal(ws.greeting(""), "What's good?");
  assert.equal(ws.greeting(null), "What's good?");
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  assert.match((await call(h, { b: kofi })).body, FIRST, "the first visit is 5C");
  assert.match((await call(h, { b: kofi })).body, /<h1 class="greet">What&#39;s good, Kofi\?<\/h1>/);
  db.db.prepare("UPDATE accounts SET name = '' WHERE conversation_id = ?").run(KOFI_C);
  assert.match((await call(h, { b: kofi })).body, /<h1 class="greet">What&#39;s good\?<\/h1>/);
});
