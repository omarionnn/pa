// Reason Web, an item's "… in the chat →" makes Reason speak first about it (owner 10-27 01:20, which
// replaced the prefilled draft). One pinned test per rule:
//
//   1. every detail's link names its row and a fresh click id
//   2. one message per click: a refresh or a double tap is the same claim, one turn
//   3. the turn is an event on Web with the row's full record and the no-command-phrase rule in it
//   4. it lands in the shared thread, or the Web chat the detail was opened from; never texted
//   5. somebody else's row, a forged page, a chat that isn't theirs: refused, no turn
//   6. the thread page posts it once and drops ?about from the URL; nothing is put in the composer
//   7. a scheduled row's description is one clean line: the summarise's, else the note tidied
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-web-speakfirst-"));
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
    DELETE FROM requests; DELETE FROM page_sessions; DELETE FROM web_chats; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM series; DELETE FROM confirmations; DELETE FROM agentcard_purchases;`);
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



const { seedOngoing } = await import("./fixture-ongoing.js");
const og = await import("../src/ongoing.js");
const page = await import("../src/pages/webongoing.js");
const it = await import("../src/itemtitle.js");
const CHAT = "AAAAAAAAAAAAAAAAAAAAAA";
const hrefOf = (html) => /<div class="ogd-foot"><a class="act[^"]*" href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
const about = (h, b, form, headers = {}) => call(h, { sub: "about", method: "POST", b, body: new URLSearchParams({ c: b.csrf, ...form }).toString(), headers: { accept: "application/json", "x-reason-csrf": b.csrf, ...headers } });
const eventTurns = (h) => h.turns.filter(t => t.kind === "event");

test("1. every detail's link names its own row and a fresh click id", () => {
  const ids = seedOngoing(OWNER_C);
  for (const [kind, id] of [["task", ids.working], ["task", ids.waiting], ["task", ids.ready], ["task", ids.failed], ["series", ids.series], ["timer", ids.timer], ["approval", ids.approval]]) {
    const href = hrefOf(page.renderDetail(og.findItem(OWNER_C, kind, id)));
    assert.match(href, new RegExp(`^/web\\?thread&about=${encodeURIComponent(`${kind}:${id}`)}&k=[A-Za-z0-9_-]{16}$`), `${kind} ${id}`);
  }
  const a = hrefOf(page.renderDetail(og.findItem(OWNER_C, "task", ids.waiting)));
  const b = hrefOf(page.renderDetail(og.findItem(OWNER_C, "task", ids.waiting)));
  assert.notEqual(a, b, "each detail page is its own click");
  assert.match(page.renderDetail(og.findItem(OWNER_C, "task", ids.waiting)), /sessionStorage\.getItem\('reason-web-chat'\)/, "opened from a Web chat, it talks there");
});

test("2-4. one message per click, on Web only, with the row's record and the rules in the turn", async () => {
  const ids = seedOngoing(OWNER_C);
  const h = harness({ turn: async ({ text }) => "Still waiting on the store. Want me to check now, or nudge them?" });
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  const k = "click-aaaaaaaaaaaa";
  const sent = h.fake.sent.length;
  const r1 = await about(h, omari, { about: `task:${ids.waiting}`, k });
  assert.equal(r1.status, 200);
  assert.equal(JSON.parse(r1.body).ok, true);
  assert.ok(await until(() => db.messagesFor(OWNER_C).some(m => m.role === "assistant")));
  // A refresh and a double tap: the same click, the same claim.
  const r2 = await about(h, omari, { about: `task:${ids.waiting}`, k });
  assert.equal(JSON.parse(r2.body).duplicate, true);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(eventTurns(h).length, 1, "one turn");
  assert.deepEqual(db.messagesFor(OWNER_C).map(m => [m.role, m.channel, m.text]), [["assistant", "web", "Still waiting on the store. Want me to check now, or nudge them?"]], "Reason speaks first, nothing of theirs is posted");
  assert.equal(h.fake.sent.length, sent, "never texted");
  // The turn: an event on Web, the row's record, the no-command-phrase rule.
  const t = eventTurns(h)[0];
  assert.equal(t.channel, "web");
  assert.match(t.text, /Talk about it in the chat/);
  assert.match(t.text, /a reply about the refund/, "the sheet's waiting-on is in the record");
  assert.match(t.text, /"goal"/);
  assert.match(t.text, /Never quote words for them to type/);
  assert.match(t.text, /check now, or to nudge them/);
  assert.ok(!/reply "|say "|type "/i.test(t.text), "the prompt itself quotes nothing to type");
  // Another click is another message.
  await about(h, omari, { about: `task:${ids.waiting}`, k: "click-bbbbbbbbbbbb" });
  assert.ok(await until(() => eventTurns(h).length === 2));
});

test("3b. each state is told its real moves; an approval ends on the nudge line", () => {
  const ids = seedOngoing(OWNER_C);
  const p = (kind, id) => og.speakFirstPrompt(og.itemRecord(OWNER_C, og.findItem(OWNER_C, kind, id)));
  assert.match(p("series", ids.series), /move the time, change which days or how often, pause it, or stop it/);
  assert.match(p("series", ids.series), /"rule"/);
  assert.match(p("task", ids.failed), /what happened and the plan from here/);
  assert.match(p("task", ids.failed), /watching resale until Thursday night/);
  assert.match(p("approval", ids.approval), /just tell me in the chat when you want it\./);
  assert.match(p("approval", ids.approval), /CeraVe/);
  for (const [kind, id] of [["task", ids.working], ["task", ids.ready], ["timer", ids.timer]]) assert.ok(!/reply "|say "|type "/i.test(p(kind, id)));
});

test("4b. opened from a Web chat, it lands in that chat", async () => {
  const ids = seedOngoing(OWNER_C);
  const h = harness({ turn: async () => "Want to move it?" });
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  db.claimWebChat(OWNER_C, CHAT);
  await about(h, omari, { about: `series:${ids.series}`, k: "click-cccccccccccc", chat: CHAT });
  assert.ok(await until(() => db.messagesFor(OWNER_C, { chat: CHAT }).length === 1));
  assert.equal(db.messagesFor(OWNER_C).length, 0, "not in the shared thread");
  assert.equal(eventTurns(h)[0].historyId, `${OWNER_C}#web:${CHAT}`, "the chat's own model thread");
});

test("5. somebody else's row, a forged page or a chat that isn't theirs: refused, no turn", async () => {
  const ids = seedOngoing(OWNER_C);
  const h = harness();
  const kofi = { ...browser(KOFI_C), conv: KOFI_C };
  assert.equal((await about(h, kofi, { about: `task:${ids.waiting}`, k: "click-dddddddddddd" })).status, 404);
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  assert.equal((await about(h, omari, { about: `task:${ids.waiting}`, k: "click-eeeeeeeeeeee" }, { origin: "https://evil.test", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await about(h, omari, { about: "task:99999", k: "click-ffffffffffff" })).status, 404);
  assert.equal((await about(h, omari, { about: "note:1", k: "click-gggggggggggg" })).status, 400);
  assert.equal((await about(h, omari, { about: `task:${ids.waiting}`, k: "x" })).status, 400);
  db.claimWebChat(KOFI_C, CHAT);
  assert.equal((await about(h, omari, { about: `task:${ids.waiting}`, k: "click-hhhhhhhhhhhh", chat: CHAT })).status, 404, "Kofi's chat");
  assert.equal((await about(h, omari, { about: `task:${ids.waiting}`, k: "click-iiiiiiiiiiii", chat: "BBBBBBBBBBBBBBBBBBBBBB" })).status, 404, "never starts a chat");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(eventTurns(h).length, 0);
});

test("6. the thread page posts it once and drops ?about; the composer stays empty", async () => {
  const ids = seedOngoing(OWNER_C);
  const h = harness();
  const omari = { ...browser(OWNER_C), conv: OWNER_C };
  await call(h, { b: omari });
  const html = (await call(h, { b: omari, query: { thread: "", about: `task:${ids.waiting}`, k: "click-jjjjjjjjjjjj" } })).body;
  assert.match(html, new RegExp(`ab:"task:${ids.waiting}",ak:"click-jjjjjjjjjjjj"`));
  assert.match(html, /fetch\('\/web\/about'/);
  assert.match(html, /<textarea id="c-input"[^>]*required><\/textarea>/, "nothing put in their line");
  assert.ok(!/data-draft/.test(html));
  // Just the about (no click id) is the plain thread: no speaking.
  const plain = (await call(h, { b: omari, query: { thread: "", about: `task:${ids.waiting}` } })).body;
  assert.match(plain, /ab:"",ak:""/);
});

test("7. a scheduled row's description: the summarise's clean line, else the note tidied (no handles, no shouting)", async () => {
  it.resetTitleQueue();
  assert.equal(og.tidyLine("Daily midnight recap of what you WORKED ON that day on github (omarionnn)."), "Daily midnight recap of what you worked on that day on GitHub.");
  assert.equal(og.tidyLine("Check in at 9 AM about the NYC trip @omari_x"), "Check in at 9 AM about the NYC trip");
  const s = (await import("../src/series.js")).start({ conversationId: OWNER_C, what: "Daily midnight recap of what you WORKED ON that day on github (omarionnn).", repeat: { kind: "daily", hour: 0 }, label: "Midnight GitHub recap" });
  const x = og.findItem(OWNER_C, "series", s.series.series_id);
  assert.equal(x.description, "Daily midnight recap of what you worked on that day on GitHub.");
  // A new row: one summarise writes the title and the line together.
  const t = db.createTimer(OWNER_C, { fireAt: clock.now() + HOUR, note: "remind Omari to call the DENTIST (dr_kim)" });
  let calls = 0, schema = null;
  await it.queueTitle("timer", OWNER_C, t.id, t.note, { name: "Omari", ask: async (q) => { calls++; schema = q.schema; return { value: { title: "Call the dentist", line: "Call the dentist to book a cleaning" } }; } });
  assert.equal(calls, 1);
  assert.deepEqual(schema.required, ["title", "line"]);
  assert.equal(og.findItem(OWNER_C, "timer", t.id).description, "Call the dentist to book a cleaning.");
  assert.equal(it.normLine("Text @omari about it", { name: "Omari" }), null);
});
