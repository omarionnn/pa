// Reason Web §4h "small details", the plumbing three (HANDOFF §4h items 1, 4 and 6):
//
//   1  while you were out: a last-seen time per browser; a visit 3+ hours after the last, with
//      something done or needing them since, shows one Caveat line under TODAY, once per return
//   4  take it back: a send is never held for it; it is cancellable until the turn takes it, and
//      exactly one of the take-back and the turn's start ever wins (db.cancelHeldInbound)
//   6  the working line counts: only from a real loop (the files of one turn, read one by one);
//      a single PDF is read in one go and gets no page count; the status label is throttled
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-web-4h-plumbing-"));
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
const { COMPOSE_JS } = await import("../src/pages/webcompose.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const { pdfsFor } = await import("../src/media.js");
const doing = await import("../src/doing.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876";
const AMA = "+13475550000";
const KOFI_C = `dm:fake:${KOFI}`;
const AMA_C = `dm:fake:${AMA}`;
const HOUR = 60 * 60 * 1000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  config.burstQuietMs = 0;
  convo.resetSendLimits();
  doing.resetDoing();
  db.db.exec(`DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue;
    DELETE FROM requests; DELETE FROM page_sessions; DELETE FROM tasks; DELETE FROM confirmations;`);
  for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi"], [AMA_C, AMA, "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});

/** serve.js's wiring, with the burst window's wait on a hand-held timer: nothing runs until `release()`. */
function harness() {
  const logs = [], turns = [], waits = [];
  const timers = { set: (fn) => { waits.push(fn); return { unref() {} }; }, clear: () => {} };
  const router = new Router({ log: (e) => logs.push(e), timers });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => { turns.push(args); return `re: ${args.text}`; } });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new FakeChannel({ number: "+16562167455" }));
  const web = router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  /** The burst window has elapsed: every wait wakes, past its ready time. */
  const release = () => { clock.skip(config.burstQuietMs + 1); for (const fn of waits.splice(0)) fn(); };
  return { router, runtime, web, logs, turns, release };
}

let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token), conv: conversationId };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}), ...extra });
const call = (h, { sub = null, method = "GET", b = null, query = {}, body = null, headers = {} } = {}) =>
  webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
/** A Web send as the page posts it, answered quickly (the turn runs on whatever happens). */
const send = (h, b, id, text) => convo.sendRequest({ account: db.getAccount(b.conv), headers: headersFor(b, { accept: "application/json", "x-reason-csrf": b.csrf }),
  readBody: async () => new URLSearchParams({ id, text, c: b.csrf }).toString(), router: h.router, log: (e) => h.logs.push(e), ackWaitMs: 20 });
const cancel = async (h, b, id, { csrf = b.csrf, headers = {} } = {}) => {
  const r = await call(h, { sub: "send/cancel", method: "POST", b, body: new URLSearchParams({ id, c: csrf }).toString(), headers: { accept: "application/json", "x-reason-csrf": csrf, ...headers } });
  return { status: r.status, ...JSON.parse(r.body) };
};
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const held = (c) => db.countPendingInbound(c);
const userRows = (c) => db.messagesFor(c).filter(m => m.role === "user").map(m => m.text);

// ---------------------------------------------------------------- 4 · take it back

test("take it back: before Reason starts, the take-back wins, no turn runs and nothing is in the thread", async () => {
  config.burstQuietMs = 60_000;
  const h = harness();
  const kofi = browser(KOFI_C);
  const sent = await send(h, kofi, "tb-0001-aaaa", "book the 7:30 at peaches");
  assert.equal(JSON.parse(sent.body).ok, true, "the send is acknowledged at once, never held for the take-back");
  assert.ok(await until(() => held(KOFI_C) === 1), "the message waits only the ordinary burst window");
  const out = await cancel(h, kofi, "tb-0001-aaaa");
  assert.deepEqual([out.status, out.ok, out.cancelled], [200, true, true]);
  assert.equal(held(KOFI_C), 0);
  h.release();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.turns.length, 0, "no turn ran");
  assert.deepEqual(userRows(KOFI_C), [], "the message never reached the thread");
  assert.equal(h.web.recent.length, 0, "nothing was answered");
  assert.ok(db.inboundCancelled("web", `${KOFI_C}:tb-0001-aaaa`));
  // The same id sent again (a refresh resending it) is the same message: still nothing runs.
  const again = await send(h, kofi, "tb-0001-aaaa", "book the 7:30 at peaches");
  assert.equal(JSON.parse(again.body).duplicate, true);
  h.release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.turns.length, 0);
});

test("take it back: once the turn has started, it is refused as too late and the turn's answer stands", async () => {
  config.burstQuietMs = 60_000;
  const h = harness();
  const kofi = browser(KOFI_C);
  await send(h, kofi, "tb-0002-aaaa", "find a plumber");
  assert.ok(await until(() => held(KOFI_C) === 1));
  h.release();
  assert.ok(await until(() => h.turns.length === 1), "the turn started");
  const out = await cancel(h, kofi, "tb-0002-aaaa");
  assert.deepEqual([out.status, out.ok, out.error], [409, false, "too_late"]);
  assert.ok(await until(() => h.web.recent.length === 1));
  assert.deepEqual(userRows(KOFI_C), ["find a plumber"]);
  assert.ok(!db.inboundCancelled("web", `${KOFI_C}:tb-0002-aaaa`));
});

test("take it back: a second tap (or a retry) is the same answer — idempotent", async () => {
  config.burstQuietMs = 60_000;
  const h = harness();
  const kofi = browser(KOFI_C);
  await send(h, kofi, "tb-0003-aaaa", "never mind this");
  assert.ok(await until(() => held(KOFI_C) === 1));
  const one = await cancel(h, kofi, "tb-0003-aaaa");
  const two = await cancel(h, kofi, "tb-0003-aaaa");
  assert.deepEqual([one.status, one.cancelled, !!one.already], [200, true, false]);
  assert.deepEqual([two.status, two.cancelled, two.already], [200, true, true]);
  h.release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.turns.length, 0);
});

test("take it back: nobody can take back another person's message — their id is put under the session's own conversation", async () => {
  config.burstQuietMs = 60_000;
  const h = harness();
  const ama = browser(AMA_C), kofi = browser(KOFI_C);
  await send(h, ama, "tb-0004-amaa", "ama's real ask");
  assert.ok(await until(() => held(AMA_C) === 1));
  const out = await cancel(h, kofi, "tb-0004-amaa");
  assert.deepEqual([out.status, out.ok, out.error], [404, false, "not_found"]);
  assert.equal(held(AMA_C), 1, "Ama's message is still waiting for its turn");
  // And the store refuses a key that belongs to another conversation outright.
  assert.deepEqual(db.cancelHeldInbound({ conversationId: KOFI_C, externalId: `${AMA_C}:tb-0004-amaa` }), { ok: false, why: "not_yours" });
  h.release();
  assert.ok(await until(() => h.turns.length === 1), "Ama's turn ran");
  assert.deepEqual(userRows(AMA_C), ["ama's real ask"]);
});

test("take it back: the turn's start and the take-back racing — exactly one wins, in either order, every time", async () => {
  config.burstQuietMs = 60_000;
  for (let i = 0; i < 20; i++) {
    db.db.exec("DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages;");
    const h = harness();
    const kofi = browser(KOFI_C);
    const id = `race-${String(i).padStart(4, "0")}`;
    await send(h, kofi, id, `race ${i}`);
    assert.ok(await until(() => held(KOFI_C) === 1));
    clock.skip(config.burstQuietMs + 1);
    const takeFirst = i % 2 === 0;
    const start = () => h.router.drain(KOFI_C);
    const back = () => Promise.resolve(h.router.takeBack({ conversationId: KOFI_C, id }));
    const [a, b] = await Promise.all(takeFirst ? [back(), start()] : [start(), back()]);
    const taken = takeFirst ? a : b;
    const drained = takeFirst ? b : a;
    h.release();
    await new Promise(r => setTimeout(r, 15));
    const turned = h.turns.length;
    assert.ok(taken.ok !== (turned === 1), `round ${i}: exactly one of take-back (${JSON.stringify(taken)}) and turn (${turned}) won`);
    if (taken.ok) { assert.equal(drained, null); assert.equal(turned, 0); assert.deepEqual(userRows(KOFI_C), []); }
    else { assert.equal(taken.why, "started"); assert.equal(turned, 1); }
    assert.equal(takeFirst ? taken.ok : !taken.ok, true, "who asked first won");
  }
});

test("take it back: tapped before the send has even been claimed, the claim then finds it and nothing runs", async () => {
  config.burstQuietMs = 0;
  const h = harness();
  const kofi = browser(KOFI_C);
  // The send's delivery is slow to reach its claim (a voice note being heard, say): the take-back lands first.
  let go;
  const gate = new Promise(r => { go = r; });
  const realDeliver = h.router.deliver.bind(h.router);
  h.router.deliver = async (inbound) => { await gate; return realDeliver(inbound); };
  const sending = send(h, kofi, "tb-0006-aaaa", "on second thought");
  await new Promise(r => setTimeout(r, 5));
  const out = await cancel(h, kofi, "tb-0006-aaaa");
  assert.deepEqual([out.status, out.cancelled], [200, true]);
  go();
  const body = JSON.parse((await sending).body);
  assert.equal(body.duplicate, true);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.turns.length, 0);
  assert.deepEqual(userRows(KOFI_C), []);
  // An id this browser never sent is not something to take back.
  const none = await cancel(h, kofi, "tb-never-sent");
  assert.deepEqual([none.status, none.error], [404, "not_found"]);
});

test("take it back: same-origin and the session's own secret, POST only, signed in only", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  assert.equal((await cancel(h, kofi, "tb-0007-aaaa", { csrf: "wrong" })).status, 403);
  assert.equal((await cancel(h, kofi, "tb-0007-aaaa", { headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await cancel(h, kofi, "x")).status, 400);
  assert.equal((await call(h, { sub: "send/cancel", method: "GET", b: kofi })).status, 405);
  assert.equal((await call(h, { sub: "send/cancel", method: "POST", body: "id=tb-0007-aaaa", headers: { accept: "application/json" } })).status, 401);
});

test("take it back: the page's control — a real button for 5 s, a pen line draining right to left, gone once Reason starts; reduced motion keeps the window", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  await call(h, { b: kofi });
  const page = (await call(h, { b: kofi, query: { thread: "" } })).body;
  assert.equal(convo.TAKE_BACK_MS, 5000);
  assert.match(page, /var TB=5000;/);
  assert.match(page, /b\.type='button';b\.className='tb-b';b\.textContent='take it back'/);
  assert.match(page, /fetch\('\/web\/send\/cancel'/);
  assert.match(page, /'taken back\. nothing sent\.'/);
  assert.match(page, /setTimeout\(function\(\)\{li\.remove\(\)\},2000\)/, "the note stays 2 s");
  assert.match(page, /'SENT \\u00b7 '\+fmt/, "after the window it is the usual SENT · time");
  assert.match(page, /\.tb-b\{min-height:44px;min-width:44px;[^}]*var\(--hand\);color:var\(--pen\)\}/);
  assert.match(page, /\.tb-l\{display:block;width:100px;height:1px;[^}]*background:var\(--pen\);transform-origin:left;animation:tb-drain 5s linear forwards\}/);
  assert.match(page, /@keyframes tb-drain\{from\{transform:scaleX\(1\)\}to\{transform:scaleX\(0\)\}\}/);
  assert.match(page, /@media \(prefers-reduced-motion:reduce\)\{\.tb-l\{display:none\}\}/);
  // Reason starting = its own line for this message arriving, which replaces the pending one (and its control).
  assert.match(page, /var p=list\.querySelector\('\.msg\[data-pending="'\+m\.cid\+'"\]'\);if\(p\)\{p\.replaceWith\(li\)/);
});

// ---------------------------------------------------------------- 1 · while you were out

test("while you were out: the words — zero parts left out, nothing at all is no line", () => {
  assert.equal(convo.awayWords({ done: 2, needs: 1 }), "while you were out: 2 done, 1 needs you.");
  assert.equal(convo.awayWords({ done: 1 }), "while you were out: 1 done.");
  assert.equal(convo.awayWords({ needs: 2 }), "while you were out: 2 need you.");
  assert.equal(convo.awayWords({ done: 0, needs: 0 }), null);
});

/** The thread page's boot data: what the script will put under TODAY. */
const awayOn = (html) => JSON.parse(/away:(null|\{.*?\})\};/.exec(html)[1]);

test("while you were out: after 3+ hours away, with work done and a question waiting since, one line under TODAY — once per return", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  await call(h, { b: kofi, query: { thread: "" } }); // a visit: the browser's last-seen time
  clock.skip(4 * HOUR);
  const a = db.createTask(KOFI_C, { title: "a", goal: "g", maxAttempts: 3, label: "Dentist moved to Thu 3 PM" });
  db.finishTask(KOFI_C, a.id, { state: "done", outcome: "moved" });
  const b = db.createTask(KOFI_C, { title: "b", goal: "g", maxAttempts: 3, label: "Plumber booked" });
  db.finishTask(KOFI_C, b.id, { state: "done", outcome: "booked" });
  db.askConfirmation({ conversationId: KOFI_C, action: "browser_submit", summary: "Book the 7:30 at Peaches", stakes: "money", target: "x", askedAfterMsgs: 0, amount: 80 });
  clock.skip(10 * 60_000);
  const back = (await call(h, { b: kofi, query: { thread: "" } })).body;
  assert.deepEqual(awayOn(back)?.text, "while you were out: 2 done, 1 needs you.");
  // Without script it is in the drawn thread, right under TODAY.
  assert.match(back, /data-day="[\d-]+"><p class="lbl">TODAY<\/p><\/li><li class="away"><p class="hand">while you were out: 2 done, 1 needs you\.<\/p><\/li>/);
  // A refresh is the next visit: gone.
  const again = (await call(h, { b: kofi, query: { thread: "" } })).body;
  assert.equal(awayOn(again), null);
  assert.ok(!again.includes('class="away"'));
});

test("while you were out: under 3 hours, nothing changed, or a browser's first visit — no line", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  assert.equal(awayOn((await call(h, { b: kofi, query: { thread: "" } })).body), null, "a first visit has nothing to compare with");
  clock.skip(2 * HOUR);
  const t = db.createTask(KOFI_C, { title: "a", goal: "g", maxAttempts: 3, label: "Done soon" });
  db.finishTask(KOFI_C, t.id, { state: "done", outcome: "ok" });
  assert.equal(awayOn((await call(h, { b: kofi, query: { thread: "" } })).body), null, "two hours is not away");
  clock.skip(5 * HOUR);
  assert.equal(awayOn((await call(h, { b: kofi, query: { thread: "" } })).body), null, "away, but nothing changed since");
});

test("while you were out: landing on Home first, the line waits for the thread; per browser; the stream and polls are not visits", async () => {
  const h = harness();
  const phone = browser(KOFI_C), laptop = browser(KOFI_C);
  await call(h, { b: phone });
  await call(h, { b: laptop });
  clock.skip(5 * HOUR);
  const t = db.createTask(KOFI_C, { title: "a", goal: "g", maxAttempts: 3, label: "Tickets" });
  db.finishTask(KOFI_C, t.id, { state: "done", outcome: "got them" });
  // The laptop's open tab polls and streams meanwhile: that is not a visit, so it still comes back.
  await call(h, { sub: "history", b: laptop, query: { after: "0" } });
  const home = (await call(h, { b: phone, query: { home: "" } })).body;
  assert.ok(!home.includes('class="away"') && !/away:\{/.test(home), "Home has no TODAY: the line is the thread's");
  clock.skip(60_000);
  assert.equal(awayOn((await call(h, { b: phone, query: { thread: "" } })).body)?.text, "while you were out: 1 done.");
  assert.equal(awayOn((await call(h, { b: laptop, query: { thread: "" } })).body)?.text, "while you were out: 1 done.", "each browser has its own return");
});

test("while you were out: the line goes under the thread's TODAY, or a TODAY of its own when today has no lines yet", () => {
  const now = clock.now();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const drawn = `<li class="day" role="separator" data-day="${day}"><p class="lbl">TODAY</p></li><li class="msg re">x</li>`;
  assert.equal(convo.withAway(drawn, "while you were out: 1 done.", now),
    `<li class="day" role="separator" data-day="${day}"><p class="lbl">TODAY</p></li><li class="away"><p class="hand">while you were out: 1 done.</p></li><li class="msg re">x</li>`);
  assert.match(convo.withAway(`<li class="msg re">old</li>`, "while you were out: 1 done.", now), /old<\/li><li class="day" role="separator" data-day="[\d-]+"><p class="lbl">TODAY<\/p><\/li><li class="away">/);
  assert.equal(convo.withAway(drawn, null, now), drawn);
  assert.equal(convo.awayHtml("<b>"), `<li class="away"><p class="hand">&lt;b&gt;</p></li>`);
});

// ---------------------------------------------------------------- 6 · the working line counts

test("the working line counts: several files read one by one say which and how far; one PDF gets no count it never had", async () => {
  const files = [{ kind: "pdf", filename: "lease.pdf" }, { kind: "pdf", filename: "IMG_2041.pdf" }, { kind: "doc", filename: "house rules.docx" }];
  const end = doing.begin(KOFI_C, files);
  assert.equal(doing.doingFor(KOFI_C), "reading the 3 files…");
  const c = doing.counter(KOFI_C, files);
  const seen = [];
  c.next(files[0]); seen.push(doing.doingFor(KOFI_C));
  c.next(files[1]); seen.push(doing.doingFor(KOFI_C));
  c.next(files[2]); seen.push(doing.doingFor(KOFI_C));
  assert.deepEqual(seen, ["reading the lease… 1 of 3 files", "reading the PDF… 2 of 3 files", "reading the house rules… 3 of 3 files"]);
  c.done();
  assert.equal(doing.doingFor(KOFI_C), "reading the 3 files…", "the loop is over: back to the turn's own line while it reads");
  end();
  // One PDF: pdftotext / PDFKit read every page in one go, so there is no page to count.
  const one = [{ kind: "pdf", filename: "lease.pdf" }];
  const end1 = doing.begin(KOFI_C, one);
  const c1 = doing.counter(KOFI_C, one);
  c1.next(one[0]);
  assert.equal(doing.doingFor(KOFI_C), "reading the lease…");
  end1();
});

test("the working line counts: the PDF loop reports each file as it starts it, and the stream carries the words", async () => {
  const files = [{ kind: "pdf", filename: "lease.pdf", url: "https://x.test/a.pdf" }, { kind: "image" }, { kind: "pdf", filename: "addendum.pdf", url: "https://x.test/b.pdf" }];
  const order = [];
  await pdfsFor(files, { fetchImpl: async () => { order.push("fetch"); throw new Error("offline"); }, onRead: (a) => order.push(a.filename) });
  assert.deepEqual(order, ["lease.pdf", "fetch", "addendum.pdf", "fetch"]);

  const h = harness();
  const kofi = browser(KOFI_C);
  const out = convo.streamRequest({ account: db.getAccount(KOFI_C), headers: headersFor(kofi), query: {}, router: h.router, log: () => {} });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { write: (s) => chunks.push(s), end: () => {} });
  const req = new EventEmitter();
  out.stream(res, req);
  const two = files.filter(f => f.kind === "pdf");
  const end = doing.begin(KOFI_C, two);
  const c = doing.counter(KOFI_C, two);
  c.next(two[1]);
  req.emit("close");
  c.done(); end();
  const doingEvents = chunks.join("").split("\n\n").filter(b => /^event: doing$/m.test(b)).map(b => JSON.parse(/^data: (.+)$/m.exec(b)[1]).doing);
  assert.ok(doingEvents.includes("reading the addendum… 1 of 2 files"), JSON.stringify(doingEvents));
});

test("the working line counts: the status label carries the same words, changed at most every 3 s", () => {
  assert.match(COMPOSE_JS, /dNext='Reason is '\+\(t\?String\(t\)\.replace\(\/(?:…|\\u2026)\\s\*\/,', '\)/);
  assert.match(COMPOSE_JS, /wait=3000-\(Date\.now\(\)-dLast\)/);
  assert.match(COMPOSE_JS, /onit\.setAttribute\('aria-label',dNext\)/);
  assert.match(COMPOSE_JS, /R\.doing=function\(t\)\{var h=onit&&onit\.querySelector\('\.hand'\);if\(h\)h\.textContent=t\?String\(t\):'on it\.';dLabel\(t\)\}/);
});
