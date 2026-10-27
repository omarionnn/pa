// Reason Web v2, the thread (handoff v2 §4b Prototype S2 + S3, §4d L1 / L2 / L10, staging review SR4).
// One pinned test per behaviour; the browser-side behaviour is in test/web-thread-browser.test.js.
//
//   S2   the "where you are" note: day + device of each message, never guessed (iMessage = phone, Web =
//        the sending browser's kind, Reason's Web line = the device it answered); markup and motion
//   S3   which messages belong to a task is written at the end of each turn that worked on it; a done
//        task settles into one DONE line (count, typed meta, JUST NOW + Caveat); open work never folds
//   SC3  TODAY ↓ lives inside the composer line; 40px between messages, 52px above each day
//   SR4  labels are who · where · when, never a status
//   L1   the page opens with its composer live and the thread's place held by ruled lines; no-script
//        gets the whole thread
//   L2   ↑ FINDING EARLIER MESSAGES… and a ghost, drawn by the page; older pages arrive drawn
//   L10  "on it. <what it's doing>." and the honest line, from the task Reason is working on
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-web-thread-"));
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
const settle = await import("../src/settle.js");
const { runTool } = await import("../src/tools.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const { exportData } = await import("../src/data.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876", KOFI_C = `dm:fake:${KOFI}`;
const AMA = "+13475550000", AMA_C = `dm:fake:${AMA}`;
const DAY = 864e5, MIN = 60_000;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  convo.resetSendLimits();
  db.db.exec(`DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue;
    DELETE FROM requests; DELETE FROM page_sessions; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM task_messages; DELETE FROM web_devices; DELETE FROM confirmations;`);
  for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi"], [AMA_C, AMA, "Ama"]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: false });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
});

/** serve.js's wiring with a stand-in model: `turn(args)` may call the real tools with the turn's own ctx. */
function harness({ turn = async ({ text }) => `re: ${text}` } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => turn(args) });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new FakeChannel({ number: "+16562167455" }));
  router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { router, runtime, logs };
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
const send = (h, b, { id, text, ua = MAC }) =>
  call(h, { sub: "send", method: "POST", b, body: new URLSearchParams({ id, text, c: b.csrf }).toString(), headers: { accept: "application/json", "x-reason-csrf": b.csrf, "user-agent": ua } });
const history = async (h, b, query = {}) => JSON.parse((await call(h, { sub: "history", b, query })).body);
const textIn = (h, { from = KOFI, id, body }) => h.router.deliver({ channel: "fake", externalId: id, from, text: body, chatId: null, at: clock.now() });
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };

/** A row written straight into history, the way W0 writes them. */
let ob = 50_000, ext = 0;
function row({ c = KOFI_C, role = "user", channel = "fake", text = "x", at = clock.now(), cid = null, device = null }) {
  if (role === "user") {
    const e = channel === "web" ? `${c}:${cid ?? `cid-${++ext}-abcdefgh`}` : `h-${++ext}`;
    if (device) settle.noteWebDevice(c, e.slice(c.length + 1), device);
    const id = db.writeMessage({ conversationId: c, role, channel, externalId: e, text, at });
    return { id, ext: e };
  }
  const o = ++ob;
  const id = db.writeMessage({ conversationId: c, role, channel, outboxId: o, text, at });
  return { id, outbox: o };
}
const link = (c, taskId, r) => db.db.prepare("INSERT INTO task_messages (conversation_id, task_id, external_id, outbox_id, created_at) VALUES (?, ?, ?, ?, ?)").run(c, taskId, r.ext ?? null, r.outbox ?? null, clock.now());
function doneTask(c, { label = "Dentist, Thursday 3pm", finishedAt = clock.now(), result = null } = {}) {
  const t = db.createTask(c, { title: label, goal: label, maxAttempts: 5, label });
  db.finishTask(c, t.id, { state: "done", outcome: "done", result });
  db.db.prepare("UPDATE tasks SET finished_at = ? WHERE id = ?").run(finishedAt, t.id);
  return t;
}

// ---------------------------------------------------------------- S2: where you are

test("S2: the device is read off the sending browser, never guessed", () => {
  assert.equal(settle.deviceClass(IPHONE), "phone");
  assert.equal(settle.deviceClass("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"), "phone");
  assert.equal(settle.deviceClass("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15"), "tablet");
  assert.equal(settle.deviceClass("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"), "tablet");
  assert.equal(settle.deviceClass(MAC), "computer");
  assert.equal(settle.deviceClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"), "computer");
  assert.equal(settle.deviceClass(""), null);
  assert.equal(settle.deviceClass("curl/8.4"), null);
  assert.equal(settle.noteWebDevice(KOFI_C, "abc", "toaster"), false, "only the three kinds are kept");
});

test("S2: the note's words — today / yesterday / a weekday / weeks ago / a month — and the device", () => {
  const now = Date.parse("2026-10-27T22:00:00Z"); // Tue Oct 27, 6 PM in New York
  const w = (daysAgo, device) => settle.whereWords({ at: now - daysAgo * DAY, device, now, tz: "America/New_York" });
  assert.equal(w(0, "computer"), "today, on your laptop");
  assert.equal(w(1, "phone"), "yesterday, on your phone");
  assert.equal(w(3, "phone"), "saturday, on your phone");
  assert.equal(w(6, "phone"), "wednesday, on your phone");
  assert.equal(w(9, "phone"), "last week, on your phone");
  assert.equal(w(15, "phone"), "two weeks ago, on your phone");
  assert.equal(w(22, "tablet"), "three weeks ago, on your tablet");
  assert.equal(w(40, "phone"), "in september, on your phone");
  assert.equal(w(400, "phone"), "in september 2025, on your phone");
  assert.equal(w(0, null), "today, on the web", "nothing known about the device: it says so plainly");
});

test("S2: a Web message keeps the device it was typed on; Reason's Web line takes it; a text is the phone", async () => {
  const h = harness();
  const b = browser(KOFI_C);
  await textIn(h, { id: "t1", body: "from my phone" });
  await until(() => db.messagesFor(KOFI_C).length >= 2);
  assert.equal((await send(h, b, { id: "web-mac-00000001", text: "now on my laptop", ua: MAC })).status, 200);
  await until(() => db.messagesFor(KOFI_C).length >= 4);
  const ms = (await history(h, b)).messages;
  const said = (t) => ms.find(m => m.text === t || m.text === `re: ${t}`);
  assert.equal(said("from my phone").where, "today, on your phone");
  assert.equal(said("now on my laptop").where, "today, on your laptop");
  assert.equal(ms.find(m => m.role === "assistant" && m.web).where, "today, on your laptop", "Reason's Web reply: the device it answered");
  assert.equal(db.db.prepare("SELECT device FROM web_devices WHERE conversation_id = ? AND client_id = ?").get(KOFI_C, "web-mac-00000001").device, "computer");
  // A resend of the same id from a phone does not rewrite where it was said.
  await send(h, b, { id: "web-mac-00000001", text: "now on my laptop", ua: IPHONE });
  assert.equal(db.db.prepare("SELECT device FROM web_devices WHERE client_id = ?").get("web-mac-00000001").device, "computer");
  // Somebody else's id names nothing of theirs.
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM web_devices WHERE conversation_id = ?").get(AMA_C).n, 0);
  await call(h, { b }); // the once-only note first
  const page = (await call(h, { b, query: { thread: "" } })).body;
  assert.match(page, /data-where="today, on your laptop"/);
});

test("S2: the note's markup — a status, two slots that crossfade exactly as the prototype (0.5 s / 0.6 s, −2°, 10 px)", () => {
  const html = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines: [convo.rowOut(db.messagesFor(KOFI_C)[0] ?? { id: 1, role: "user", channel: "fake", text: "x", at: clock.now(), media: [] }, { conversationId: KOFI_C })], more: false, sendId: "s" });
  assert.match(html, /<header class="top"><a class="wm"[^]*?<\/a><span class="where" role="status" aria-live="polite" hidden><span class="wn-s on" aria-hidden="true"><\/span><span class="wn-s" aria-hidden="true"><\/span><span class="sr wn-now"><\/span><\/span>/);
  assert.match(html, /\.wn-s\{position:absolute;right:0;top:0;white-space:nowrap;font:400 22px\/30px var\(--hand\);color:var\(--pen\);opacity:0;transform:rotate\(-2deg\) translateY\(-10px\);transition:opacity \.5s ease,transform \.6s cubic-bezier\(\.2,\.8,\.2,1\)\}/);
  assert.match(html, /\.wn-s\.on\{opacity:1;transform:rotate\(-2deg\) translateY\(0\)\}/);
  assert.match(html, /prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important\}/, "reduced motion: no crossfade");
  assert.match(html, /var line=\(bar\?bar\.getBoundingClientRect\(\)\.bottom:0\)\+90,end=window\.innerHeight\+window\.scrollY>=document\.documentElement\.scrollHeight-40/, "current at 90px under the bar; the very bottom is the latest");
  assert.match(html, /behavior:calm2\?'auto':'smooth'/, "reduced motion: no smooth scrolling back to today");
});

// ---------------------------------------------------------------- SC3: spacing and TODAY ↓

test("SC3: TODAY ↓ sits inside the composer line (hidden until scrolled back), never floating; 40px between messages, 52px above a day", () => {
  const html = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines: [], more: false, sendId: "s" });
  assert.match(html, /<input id="c-input"[^>]*><button class="today" type="button" hidden>TODAY <span aria-hidden="true">↓<\/span><\/button><button class="ic c-mic"/);
  assert.match(html, /\.today\{flex-shrink:0;min-height:44px;padding:0 4px;border:0;background:transparent;cursor:pointer;font:400 11px\/1 var\(--mono\);letter-spacing:\.14em;color:var\(--ink\);white-space:nowrap\}/);
  assert.ok(!/\.today\{[^}]*position:(fixed|absolute)/.test(html), "never floats over the thread");
  assert.match(html, /\.thread\{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:40px\}/);
  assert.match(html, /\.day\{text-align:center;margin-top:12px\}/, "40 + 12 = 52px above each day");
  assert.ok(!/\.convo,\.thread\{gap:36px\}/.test(html), "desktop keeps the same rhythm");
  assert.match(html, /ph:\{"rest":"Tell Reason what you need","back":"Reply from here"\}/);
  assert.match(html, /function backTo\(on\)\{if\(!tb\)return;tb\.hidden=!on;if\(box&&R\.ph\)box\.placeholder=on\?R\.ph\.back:R\.ph\.rest\}/);
});

// ---------------------------------------------------------------- SR4

test("SR4: every label is who · where · when; a status never stands in for where and when", () => {
  db.askConfirmation({ conversationId: KOFI_C, action: "book", summary: "Hold the Hudson inn, $540", stakes: "money", askedAfterMsgs: 0 });
  const approvals = convo.waitingApprovals(KOFI_C);
  const html = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines: [], more: false, sendId: "s", approvals });
  assert.ok(!/WAITING ON YOU/.test(html));
  assert.match(html, /<div class="msg re approval"><p class="lbl">REASON · IMESSAGE · \d{1,2}:\d{2} [AP]M<\/p><div class="card appr"><p class="lbl pen">NEEDS YOUR APPROVAL<\/p>/, "the status is inside the card");
  // And on every line, theirs and Reason's, from either place.
  const r = row({ channel: "web", text: "hi", device: "computer" });
  const m = convo.rowOut(db.messagesFor(KOFI_C).find(x => x.id === r.id), { conversationId: KOFI_C });
  assert.match(m.html, /^<p class="lbl"><span>YOU · WEB · <\/span><time datetime="[^"]+">\d{1,2}:\d{2} [AP]M<\/time><\/p>/);
});

// ---------------------------------------------------------------- S3: which messages belong to a task

test("S3 plumbing: a turn that starts a task, and the wake that finishes it, write their own messages down under it", async () => {
  let started = null;
  const h = harness({
    turn: async (args) => {
      const ctx = { conversationId: args.conversationId, turnTasks: args.turnTasks, answering: args.answering, kind: args.kind, events: args.events };
      if (/plumber/.test(args.text)) {
        const out = await runTool("task_start", { title: "Find a plumber", goal: "A plumber who can come this week", wake_in_minutes: 30 }, ctx);
        started = out.task.id;
        return "on it. i'll call around.";
      }
      if (args.taskId) {
        await runTool("task_finish", { task_id: args.taskId, state: "done", outcome: "Booked Joe's Plumbing, Thursday 9am", result: { headline: "Joe's Plumbing, Thursday 9am", facts: ["$120"] } }, ctx);
        return "joe's plumbing can come thursday at 9. booked.";
      }
      return `re: ${args.text}`;
    },
  });
  await textIn(h, { id: "p1", body: "find a plumber who can come this week" });
  await until(() => db.messagesFor(KOFI_C).length >= 2);
  assert.ok(started, "the task was started by the real tool");
  // Something unrelated in between belongs to no task.
  await textIn(h, { id: "p2", body: "also what's the weather" });
  await until(() => db.messagesFor(KOFI_C).length >= 4);
  // The wake: Reason's own turn for the task, which finishes it.
  await h.runtime._turn({ conversationId: KOFI_C, text: "[task wake]", kind: "event", meta: { fromTask: started } });
  await until(() => db.messagesFor(KOFI_C).length >= 5);
  const { owner, folds } = settle.foldsFor(KOFI_C, db.messagesFor(KOFI_C).map(m => m.id));
  const fold = folds.get(started);
  assert.ok(fold, "the done task folds");
  assert.deepEqual(fold.rows.map(r => r.text), ["find a plumber who can come this week", "on it. i'll call around.", "joe's plumbing can come thursday at 9. booked."]);
  assert.equal(owner.size, 3, "the weather exchange is nobody's task");
  // Scoped: another conversation's view of the same ids finds nothing.
  assert.equal(settle.foldsFor(AMA_C, db.messagesFor(KOFI_C).map(m => m.id)).folds.size, 0);
  assert.equal(settle.linkTurn({ conversationId: AMA_C, taskIds: [started], handles: ["p2"] }), 0, "a task id from another conversation links nothing");
});

test("S3: a done task settles into one DONE line at its last message; open work never folds", () => {
  const now = clock.now();
  const a = row({ text: "call the dentist and get me in this week", at: now - 6 * DAY });
  const b2 = row({ role: "assistant", text: "calling now.", at: now - 6 * DAY + MIN });
  const c = row({ role: "assistant", text: "thursday 3pm with dr. patel.", at: now - 6 * DAY + 18 * MIN });
  const t = doneTask(KOFI_C, { finishedAt: now - 6 * DAY + 18 * MIN });
  for (const r of [a, b2, c]) link(KOFI_C, t.id, r);
  const between = row({ text: "unrelated", at: now - 6 * DAY + 5 * MIN });
  // A running task, and a message shared between a done task and a running one.
  const running = db.createTask(KOFI_C, { title: "Dog sitter", goal: "Dog sitter", maxAttempts: 5 });
  const d = row({ text: "find a dog sitter", at: now - 2 * MIN });
  link(KOFI_C, running.id, d);
  const t2 = doneTask(KOFI_C, { label: "Hudson inn held" });
  const shared = row({ role: "assistant", text: "held the inn; looking for sitters next", at: now - MIN });
  link(KOFI_C, t2.id, shared); link(KOFI_C, running.id, shared);
  const lines = db.messagesFor(KOFI_C).map(r => convo.rowOut(r, { conversationId: KOFI_C, now }));
  const html = convo.pageHtml(lines, { conversationId: KOFI_C, now });
  const done = html.match(/<li class="msg done"[^]*?<\/li>/g) ?? [];
  assert.equal(done.length, 1, "one DONE line; the task sharing a message with open work does not fold");
  assert.match(done[0], new RegExp(`^<li class="msg done" data-task="${t.id}" data-id="${c.id}" data-ids="${a.id} ${b2.id} ${c.id}"`));
  assert.match(done[0], /<button class="dl" type="button" aria-expanded="false" aria-controls="fold-\d+"><span class="dl-st" style="transform:rotate\((-3|2)deg\)">DONE<\/span><span class="dl-t"><span class="dl-title">Dentist, Thursday 3pm<\/span><span class="dl-meta">[A-Z]{3} · IMESSAGE · \d{1,2}:\d{2} [AP]M<\/span><\/span><span class="dl-n">3 ↓<\/span><\/button>/);
  assert.match(done[0], /<div class="fold" id="fold-\d+"><p class="q-you">call the dentist and get me in this week<\/p><p class="q-re">calling now\.<\/p><p class="q-re">thursday 3pm with dr\. patel\.<\/p><\/div>/);
  assert.ok(!/dl-fresh/.test(done[0]), "six days on, no 'just wrapped' line");
  assert.ok(!html.includes(`data-id="${a.id}" data-at`), "the folded messages are not drawn on their own");
  for (const r of [between, d, shared]) assert.match(html, new RegExp(`<li class="msg (you|re)" id="m-${r.id}" data-id="${r.id}"`), "everything else stays as it was");
  // The fold comes with the page that holds its last message; an older page skips its earlier lines.
  const older = convo.pageHtml(lines.filter(m => m.id === a.id || m.id === between.id), { conversationId: KOFI_C, now });
  assert.ok(!/class="msg done"/.test(older) && !older.includes(`data-id="${a.id}"`) && older.includes(`data-id="${between.id}"`));
});

test("S3: the DONE line's meta — JUST NOW · money · where for a task just finished (with the Caveat line), else day · where · time", () => {
  const now = Date.parse("2026-10-27T22:00:00Z");
  const r = (at, channel = "web") => ({ at, channel, role: "assistant" });
  const fresh = settle.doneLine({ task: { id: 3, conversation_id: KOFI_C, title: "x", label: "Hudson inn", finished_at: now - 4 * MIN, result_json: JSON.stringify({ headline: "Hudson inn held, Nov 14–16", facts: ["Fri–Sun", "$540"] }) }, rows: [r(now - 30 * MIN), r(now - 4 * MIN)] }, { now, tz: "America/New_York" });
  assert.deepEqual(fresh, { taskId: 3, title: "Hudson inn held, Nov 14–16", meta: "JUST NOW · $540 · WEB", count: 2, fresh: true });
  const tue = settle.doneLine({ task: { id: 4, conversation_id: KOFI_C, title: "x", label: "Dentist, Thursday 3pm", finished_at: now - 6 * DAY }, rows: [r(Date.parse("2026-10-21T13:20:00Z"), "IMESSAGE")] }, { now, tz: "America/New_York" });
  assert.equal(tue.meta, "WED · IMESSAGE · 9:20 AM");
  const old = settle.doneLine({ task: { id: 5, conversation_id: KOFI_C, title: "Passport", label: "", finished_at: now - 15 * DAY }, rows: [r(Date.parse("2026-10-12T13:20:00Z"), "IMESSAGE")] }, { now, tz: "America/New_York" });
  assert.equal(old.meta, "OCT 12 · IMESSAGE");
  const today = settle.doneLine({ task: { id: 6, conversation_id: KOFI_C, title: "x", label: "y", finished_at: now - 3 * 60 * MIN }, rows: [r(now - 3 * 60 * MIN)] }, { now, tz: "America/New_York" });
  assert.equal(today.meta, "TODAY · WEB · 3:00 PM");
  // Drawn: the Caveat line, and it goes once opened (page script + CSS).
  const t = doneTask(KOFI_C, { label: "Hudson inn held", finishedAt: clock.now() - MIN });
  const x = row({ channel: "web", text: "Book it.", device: "computer" }); link(KOFI_C, t.id, x);
  const html = convo.pageHtml(db.messagesFor(KOFI_C).map(m => convo.rowOut(m, { conversationId: KOFI_C })), { conversationId: KOFI_C });
  assert.match(html, /data-fresh="1"[^]*<p class="hand dl-fresh">just wrapped this one up\. tap to see how\.<\/p><\/li>/);
  const page = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines: [], more: false, sendId: "s" });
  assert.match(page, /\.done\.open \.dl-fresh\{display:none\}/);
  assert.match(page, /html\.js \.done:not\(\.open\) \.fold\{display:none\}/, "without script the fold simply stays open");
  assert.match(page, /b\.setAttribute\('aria-expanded',open\?'true':'false'\);b\.querySelector\('\.dl-n'\)\.textContent=open\?'FOLD ↑':li\.dataset\.n\+' ↓'/);
});

// ---------------------------------------------------------------- L10

test("L10: on it, with what it's doing, while Reason works on what they last asked; the honest line says where the result comes", () => {
  const t = db.createTask(KOFI_C, { title: "Find a plumber", goal: "x", maxAttempts: 5, sheet: { steps: [{ text: "Find plumbers", state: "done" }, { text: "Call three", state: "doing", live: "calling three places" }] } });
  const asked = row({ channel: "web", text: "find a plumber who can come this week", device: "computer" });
  link(KOFI_C, t.id, asked);
  assert.deepEqual(convo.workOf(KOFI_C), { taskId: t.id, line: "on it. calling three places.", texted: true, note: "This one takes a few minutes. You can close this; it's in Ongoing, and I'll text you." });
  const html = convo.longWorkHtml(convo.workOf(KOFI_C));
  assert.equal(html, `<div class="longwork" data-task="${t.id}"><div class="lw-on" role="status"><span class="ring"><svg class="bub" aria-hidden="true" viewBox="0 0 40 40"><path d="${"M20 5C28.8 5 36 10.9 36 18.2S28.8 31.4 20 31.4c-1.9 0-3.7-.3-5.4-.8L7 35l2.3-6.6C6.3 26.1 4 22.4 4 18.2 4 10.9 11.2 5 20 5z"}" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg></span><span class="hand lw-line">on it. calling three places.</span></div><p class="lw-note">This one takes a few minutes. You can close this; it&#39;s in Ongoing, and I&#39;ll text you.</p></div>`);
  // Results kept on Web: the line doesn't promise a text.
  db.setWebReach(KOFI_C, "web");
  assert.equal(convo.workOf(KOFI_C).note, settle.LONG_NOTE_WEB);
  db.setWebReach(KOFI_C, "text");
  // No live words: just "on it."
  db.db.prepare("UPDATE tasks SET sheet = ? WHERE id = ?").run(JSON.stringify({ steps: [{ text: "Call three", state: "doing" }] }), t.id);
  assert.equal(convo.workOf(KOFI_C).line, "on it.");
  // Waiting on somebody is not long work in hand; nor is it once they have moved on to something else.
  db.db.prepare("UPDATE tasks SET state = 'waiting' WHERE id = ?").run(t.id);
  assert.equal(convo.workOf(KOFI_C), null);
  db.db.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run(t.id);
  row({ text: "unrelated question", at: clock.now() + 1000 });
  assert.equal(convo.workOf(KOFI_C), null);
  assert.equal(convo.workOf(AMA_C), null);
  const page = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines: [], more: false, sendId: "s" });
  assert.match(page, /<div class="longwork" hidden>/, "drawn hidden, so the page can show it when work starts");
  assert.match(page, /\.longwork\[hidden\],\.onit:not\(\[hidden\]\)~\.longwork\{display:none\}/, "a turn's own 'on it.' takes the place while it runs");
});

// ---------------------------------------------------------------- L1, L2, history pages

test("L1: the thread opens with the composer live and ruled lines in its place; without script it is all there", async () => {
  const h = harness();
  const b = browser(KOFI_C);
  await textIn(h, { id: "l1", body: "first words" });
  await until(() => db.messagesFor(KOFI_C).length >= 2);
  await call(h, { b }); // spends the once-only note
  const page = (await call(h, { b, query: { thread: "" } })).body;
  assert.match(page, /<div class="l1"><p class="lbl" role="status">OPENING YOUR THREAD…<\/p><div class="l1-sp"><\/div><div class="gh gh-re" aria-hidden="true">[^]*?<div class="gh gh-you" aria-hidden="true">[^]*?<div class="gh gh-re" aria-hidden="true">/);
  assert.match(page, /<ol class="thread" role="log" aria-live="polite" aria-relevant="additions" aria-busy="true"><\/ol>/, "the live log starts empty and busy, so the history isn't read out as it lands");
  assert.match(page, /<noscript><div class="start">[^]*?<\/div><ol class="thread" role="log">[^]*first words[^]*<\/ol><\/noscript>/);
  assert.match(page, /defer:true/);
  assert.match(page, /<input id="c-input"/, "the composer is there from the first paint");
  assert.match(page, /<nav class="tabs"/);
  assert.match(page, /html:not\(\.js\) \.l1,html:not\(\.js\) \.thread\[aria-busy\]\{display:none\}/);
  assert.match(page, /\.gh-w span\{display:block;height:2px;background:var\(--hair\);animation:ghost 1\.6s ease-in-out infinite\}/, "ruled lines, 2px, hairline; fade 0.5↔1 over 1.6s (none under reduced motion)");
  assert.match(page, /@keyframes ghost\{50%\{opacity:\.5\}\}/);
  assert.match(page, /STILL LOOKING…/);
  assert.match(page, /taking a little longer than usual\. still here\./);
  assert.ok(!/spinner|shimmer/i.test(page));
  // The first page arrives drawn: day labels, lines, where-notes, and the numbers the script needs.
  const j = await history(h, b);
  assert.match(j.html, /<li class="day" role="separator" data-day="[\d-]+" data-where="today, on your phone"><p class="lbl">TODAY<\/p><\/li><li class="msg you"/);
  assert.equal(j.first, j.messages[0].id);
  assert.equal(j.last, Math.max(...j.messages.map(m => m.id)));
  assert.ok("work" in j);
});

test("L2: ↑ FINDING EARLIER MESSAGES… and a ghost above the day; the older page arrives drawn, the start says what came before", async () => {
  const h = harness();
  const b = browser(KOFI_C);
  const base = clock.now() - 3 * DAY;
  for (let i = 0; i < convo.PAGE + 5; i++) row({ role: i % 2 ? "assistant" : "user", text: `line ${i}`, at: base + i * MIN });
  const first = await history(h, b);
  assert.equal(first.more, true);
  const older = await history(h, b, { before: String(first.first) });
  assert.equal(older.more, false);
  assert.match(older.html, /<li class="day" role="separator" data-day="[\d-]+" data-where="[a-z]+, on your phone">/);
  assert.match(older.start, /^Your conversation before .+ stays in your texts\.$/);
  const page = convo.renderConversation({ account: db.getAccount(KOFI_C), csrf: "c", lines: [], more: true, sendId: "s" });
  assert.match(page, /finding:"<p class=\\"lbl\\" role=\\"status\\">↑ FINDING EARLIER MESSAGES…<\/p><div class=\\"gh gh-re\\" aria-hidden=\\"true\\">/);
  assert.match(page, /start\.innerHTML=R\.finding;start\.classList\.add\('finding'\)/);
});

test("S3 live: a task that settles while the page is open reaches it — on the stream, and on the poll that stands in for it", async () => {
  const b = browser(KOFI_C);
  const h = harness();
  const t = db.createTask(KOFI_C, { title: "Hudson", goal: "x", maxAttempts: 5, label: "Hudson inn held" });
  const a = row({ channel: "web", text: "Book it.", device: "computer" });
  const r2 = row({ role: "assistant", channel: "web", text: "held. $540." });
  const out = convo.streamRequest({ account: db.getAccount(KOFI_C), headers: headersFor(b), query: { after: String(r2.id) }, router: h.router, log: () => {} });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { write: (s) => chunks.push(s), end: () => {} });
  const req = new EventEmitter();
  out.stream(res, req);
  const states = () => chunks.join("").split("\n\n").filter(x => /^event: state$/m.test(x)).map(x => JSON.parse(/^data: (.+)$/m.exec(x)[1]));
  assert.deepEqual(states().at(-1), { work: null, settled: [] });
  // The wake's turn finishes it, then writes its messages down: the stream says so at once.
  db.finishTask(KOFI_C, t.id, { state: "done", outcome: "held" });
  db.db.prepare("INSERT INTO task_messages (conversation_id, task_id, external_id, created_at) VALUES (?, ?, ?, ?)").run(KOFI_C, t.id, a.ext, clock.now());
  db.db.prepare("INSERT INTO outbox (idem_key, conversation_id, channel, address, body, to_owner, created_at, updated_at, state) VALUES (?, ?, 'web', ?, 'held', 1, ?, ?, 'sent')").run(`k-${r2.outbox}`, KOFI_C, KOFI, clock.now(), clock.now());
  const ob2 = db.db.prepare("SELECT MAX(id) AS id FROM outbox").get().id;
  db.db.prepare("UPDATE messages SET outbox_id = ? WHERE id = ?").run(ob2, r2.id);
  assert.equal(settle.linkTurn({ conversationId: KOFI_C, taskIds: [t.id], outboxAfter: ob2 - 1 }), 1);
  const s = states().at(-1);
  assert.equal(s.settled.length, 1);
  assert.deepEqual(s.settled[0].ids, [a.id, r2.id]);
  assert.match(s.settled[0].html, /^<li class="msg done" data-task="\d+"[^]*JUST NOW · WEB[^]*just wrapped this one up/);
  req.emit("close");
  // The poll (the stream's fallback) carries the same.
  const j = await history(h, b, { after: String(r2.id) });
  assert.equal(j.settled.length, 1);
  assert.equal(j.work, null);
  // Not somebody else's.
  assert.deepEqual(convo.settledLately(AMA_C), []);
});

test("their thread data is theirs: the task links and devices are in an export", () => {
  const t = doneTask(KOFI_C);
  const r = row({ channel: "web", text: "x", device: "phone" });
  link(KOFI_C, t.id, r);
  const out = exportData({ conversation: KOFI_C, audio: false, files: false });
  assert.equal(out.tables.task_messages.length, 1);
  assert.equal(out.tables.web_devices.length, 1);
});
