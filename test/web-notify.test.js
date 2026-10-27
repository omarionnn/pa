// Notifications on Reason Web (handoff v2 §4c item 8, reference sheet-notify 8A–8C) and Web's icons
// (§4e, I1), one pinned test per rule:
//
//   - GET /web/signal: signed in only, this person's needs / just-finished / this browser's setting,
//     and it never counts as using the session (an idle tab still signs out)
//   - 8A: the tab title + filled favicon change only while hidden, only for what's new, reset on look
//   - 8B: one Caveat line on other screens until seen; never on the chat
//   - 8C: per-browser setting, off by default, asked of the browser first; a notification says only
//     "Reason needs your approval."
//   - I1: Web pages link Web's own icons; the files are the handoff's marks in Reason's pen
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-notify-"));
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
delete process.env.REASON_INVITES_OPEN;
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key

const { webRequestFor } = await import("../src/http.js");
const st = await import("../src/pages/websettings.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver, keptOnWeb } = await import("../src/deliver.js");
const invites = await import("../src/invites.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const WIN_FF = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  config.invitesOpen = false;
  db.db.exec(`DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM messages;
    DELETE FROM page_sessions; DELETE FROM oauth_tokens; DELETE FROM agentcard_users; DELETE FROM invites; DELETE FROM invite_allowances;
    DELETE FROM tasks; DELETE FROM inbound_messages; DELETE FROM event_log;`);
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
});

function harness({ turn = async () => "ok" } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => turn(args) });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  const web = router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { router, runtime, deliver, fake, web, logs };
}

let n = 0;
/** A signed-in browser for this conversation, as W1's code step leaves it, used from `ua`. */
function browser(conversationId, ua = MAC_CHROME) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { token, conv: conversationId, ua, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie, "user-agent": b.ua } : {}), ...extra });
async function call(h, { sub = "settings", method = "GET", b = null, query = {}, body = null, headers = {} } = {}) {
  return await webRequestFor({ sub, method, query, headers: headersFor(b, headers), remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
}
const post = (h, b, fields, { csrf = b.csrf, headers = {} } = {}) => call(h, { method: "POST", b, body: new URLSearchParams({ c: csrf, ...fields }).toString(), headers });
const page = async (h, b) => { const out = await call(h, { b }); assert.equal(out.status, 200); return out.body; };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
const opens = async (h, b) => (await call(h, { sub: null, b })).body.includes("st-h1") || (await call(h, { b })).status === 200;


const nt = await import("../src/pages/webnotify.js");
const { createServer } = await import("../src/http.js");
const vm = await import("node:vm");

const signal = (b, headers = {}) => webRequestFor({ sub: "signal", method: "GET", query: {}, headers: headersFor(b, headers), readBody: async () => null });
const approve = (conv, summary = "Book the Hudson Inn") => db.askConfirmation({ conversationId: conv, action: "browser_submit", summary, stakes: "money", askedAfterMsgs: 0 });

// ---------- GET /web/signal ----------

test("signal: signed out is 401; signed in tells only this person's needs, what just finished, and this browser's setting", async () => {
  assert.equal((await signal(null)).status, 401);
  assert.equal((await signal(null, { cookie: "reason_page=nobody" })).status, 401);
  const me = browser(OWNER_C), kofi = browser(KOFI_C);
  let out = await signal(me);
  assert.equal(out.status, 200);
  assert.equal(out.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(out.body), { ok: true, needs: [], done: [], notify: false });
  const c = approve(OWNER_C);
  const waiting = db.createTask(OWNER_C, { title: "pick a date for the dentist", goal: "dentist", maxAttempts: 5 });
  assert.equal(db.updateTask(OWNER_C, waiting.id, { state: "waiting_on_you", sheet: { needs: { question: "Tue or Wed?", tradeoff: "Tue is sooner" } } }).ok, true);
  const t = db.createTask(OWNER_C, { title: "Table for four at Via Carota", goal: "table", maxAttempts: 5 });
  db.finishTask(OWNER_C, t.id, { state: "done", outcome: "booked" });
  approve(KOFI_C, "Kofi's thing");
  out = JSON.parse((await signal(me)).body);
  assert.deepEqual(out.needs.map(n => [n.id, n.approval, n.href]), [[`approval-${c.id}`, true, `/web/ongoing/approval/${c.id}`], [`task-${waiting.id}`, false, `/web/ongoing/task/${waiting.id}`]]);
  assert.equal(out.needs[0].line, "one thing needs a yes");
  assert.equal(out.needs[1].line, "one thing needs an answer");
  assert.equal(out.done.length, 1);
  assert.equal(out.done[0].id, `task-${t.id}`);
  assert.ok(out.done[0].title && out.done[0].title.length <= 40);
  assert.ok(!JSON.stringify(out).includes("Kofi"), "nobody else's");
  assert.equal(JSON.parse((await signal(kofi)).body).needs.length, 1);
});

test("signal: the background check never counts as using the session, so an idle tab still signs out", async () => {
  const me = browser(OWNER_C);
  const before = db.pageSessionsFor(OWNER_C)[0].last_seen_at;
  clock.skip(10 * MIN);
  await signal(me);
  assert.equal(db.pageSessionsFor(OWNER_C)[0].last_seen_at, before, "not touched");
  clock.skip(31 * DAY);
  assert.equal((await signal(me)).status, 401, "idle past the limit: signed out");
});

test("signal: Web off for them is 401", async () => {
  config.web = "owner";
  const kofi = browser(KOFI_C);
  assert.equal((await signal(kofi)).status, 401);
  assert.equal((await signal(browser(OWNER_C))).status, 200);
});

// ---------- 8C: browser notifications, per browser ----------

test("8C: off by default; the button is drawn only for script; on is saved for THIS browser only and turned off by a plain form", async () => {
  const h = harness();
  const me = browser(OWNER_C), other = browser(OWNER_C, IPHONE);
  db.setWebReach(OWNER_C, "web");
  let body = await page(h, me);
  assert.match(body, /<section class="st-sec" id="notify" aria-labelledby="nt-h"><h2 id="nt-h">BROWSER NOTIFICATIONS<\/h2><p class="nt-p">Off\. Reason texts you for <em>timely decisions<\/em> instead\.<\/p><p class="nt-q">Turn these on if you'd rather hear from Reason in this browser than by text, while it's open\.<\/p><button class="nt-on" type="button" hidden data-busy="Turning on…"/);
  assert.match(body, /<p class="hand tilt nt-ask" hidden>your browser will ask first\.<\/p>/);
  assert.match(body, /Notification\.requestPermission\(ok\)/, "the browser is asked first (promise or callback form)");
  assert.match(body, /if\(p!=='granted'\)throw 'no'/, "nothing is saved unless it says yes");
  // The script's save.
  const on = await post(h, me, { do: "notify", on: "1" }, { headers: { accept: "application/json" } });
  assert.deepEqual(JSON.parse(on.body), { ok: true, notify: true });
  assert.equal(db.pageSessionNotify(me.token), true);
  assert.equal(db.pageSessionNotify(other.token), false, "only this browser");
  assert.equal(JSON.parse((await signal(me)).body).notify, true);
  assert.equal(JSON.parse((await signal(other)).body).notify, false);
  body = await page(h, me);
  assert.match(body, /<p class="nt-p">On in this browser\.<\/p>/);
  assert.match(body, /<button class="act2" type="submit" data-busy="TURNING OFF…">TURN OFF IN THIS BROWSER<\/button>/);
  const off = await post(h, me, { do: "notify", on: "0" });
  assert.equal(off.headers.Location, "/web/settings?done=notify-off#notify");
  assert.equal(db.pageSessionNotify(me.token), false);
  // Their reach decides the sentence.
  db.setWebReach(OWNER_C, "none");
  assert.match(await page(h, me), /<p class="nt-p">Off\. Everything waits here instead\.<\/p>/);
  db.setWebReach(OWNER_C, "yes");
  assert.match(await page(h, me), /<p class="nt-p">Off\. Reason texts you for <em>only what needs a yes<\/em> instead\.<\/p>/);
  // 8C as a screen of its own.
  const sub = (await call(h, { b: me, query: { edit: "notify" } })).body;
  assert.match(sub, /← SETTINGS<\/a><\/header><main class="sub nt"><h1 class="sub-l">BROWSER NOTIFICATIONS<\/h1><p class="nt-p">/);
  // Somebody else's form secret: refused, nothing changes.
  const kofi = browser(KOFI_C);
  assert.equal((await post(h, me, { do: "notify", on: "1" }, { csrf: kofi.csrf })).status, 403);
  assert.equal(db.pageSessionNotify(me.token), false);
  db.setWebReach(OWNER_C, "text");
});

test("8C: a notification says only \"Reason needs your approval.\" — never a detail", () => {
  assert.equal(nt.NOTIFY_TEXT, "Reason needs your approval.");
  assert.match(nt.NOTIFY_JS, /new Notification\('Reason',\{body:"Reason needs your approval\.",tag:'reason-needs-you',silent:true\}\)/);
  assert.doesNotMatch(nt.NOTIFY_JS, /new Notification\([^)]*n\.line/);
});

// ---------- 8A / 8B: the tab and the line, run in a pretend browser ----------

/** The notify script in a small pretend browser: a page at `path`, a tab that can be hidden, answers from `next()`. */
function pretend({ path = "/web/settings", signedIn = true, permission = "granted", theme = undefined, osDark = false } = {}) {
  const store = new Map(), shown = [], vis = [], themed = [];
  let answer = { ok: true, needs: [], done: [], notify: false }, timers = [];
  const link = (calm, needs, media) => ({ href: calm, media, dataset: { calm, needs } });
  const links = [link("/web/icons/favicon.svg?v=1", "/web/icons/favicon-needs-you.svg?v=1", "(prefers-color-scheme: light)"), link("/web/icons/favicon-night.svg?v=1", "/web/icons/favicon-night-needs-you.svg?v=1", "(prefers-color-scheme: dark)")];
  const kids = [];
  const main = { firstChild: null, insertBefore(el) { kids.unshift(el); el.parentMain = this; } };
  const make = () => { const hand = { textContent: "" }, a = { href: "", onclick: null }; return { className: "", attrs: {}, set innerHTML(v) { this.html = v; }, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: (s) => (s === ".hand" ? hand : a), remove() { kids.splice(kids.indexOf(this), 1); }, hand, a }; };
  const document = {
    hidden: false, title: "Reason — Settings",
    documentElement: { hasAttribute: (k) => k === "data-c" && signedIn, dataset: theme ? { theme } : {} },
    querySelectorAll: (s) => (s.startsWith("link") ? links : []),
    querySelector: (s) => (s === ".nt-line" ? kids.find(k => k.className === "nt-line") ?? null : s === "main" ? main : null),
    createElement: () => make(),
    addEventListener: (ev, fn) => (ev === "visibilitychange" ? vis : themed).push(fn),
  };
  class Notification { constructor(title, opts) { shown.push({ title, ...opts }); } }
  Notification.permission = permission;
  const ctx = {
    document, location: { pathname: path }, Notification, matchMedia: (q) => ({ matches: /dark/.test(q) && osDark }),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    fetch: async () => ({ status: 200, json: async () => answer }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const tick = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  return {
    document, links, shown, store, line: () => kids.find(k => k.className === "nt-line") ?? null,
    async start(a) { if (a) answer = a; vm.runInContext(nt.NOTIFY_JS, ctx); await tick(); },
    async poll(a) { if (a) answer = a; timers = []; vis.forEach(f => f()); await tick(); },
    async hide(a) { document.hidden = true; await this.poll(a); },
    async show(a) { document.hidden = false; await this.poll(a); },
    retheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; themed.forEach(f => f()); },
  };
}
const need = (id, approval = true, line = "the hudson inn needs a yes") => ({ id, approval, line, href: `/web/ongoing/approval/${id.split("-")[1]}` });

const PAPER = ["/web/icons/favicon.svg?v=1", "/web/icons/favicon.svg?v=1"], PAPER_NEEDS = ["/web/icons/favicon-needs-you.svg?v=1", "/web/icons/favicon-needs-you.svg?v=1"];
const NIGHT = ["/web/icons/favicon-night.svg?v=1", "/web/icons/favicon-night.svg?v=1"], NIGHT_NEEDS = ["/web/icons/favicon-night-needs-you.svg?v=1", "/web/icons/favicon-night-needs-you.svg?v=1"];

test("§4h 5: the title is exactly \"Reason · needs you\" while something needs them, the needs-you mark; back to the page's title when nothing does", async () => {
  assert.equal(nt.NEEDS_TITLE, "Reason \u00b7 needs you");
  const p = pretend();
  await p.start({ ok: true, needs: [], done: [], notify: false });
  assert.equal(p.document.title, "Reason — Settings");
  assert.deepEqual(p.links.map(l => l.href), PAPER);
  await p.poll({ ok: true, needs: [need("approval-1")], done: [], notify: false });
  assert.equal(p.document.title, "Reason · needs you", "while they are looking too");
  assert.deepEqual(p.links.map(l => l.href), PAPER_NEEDS);
  await p.hide();
  assert.equal(p.document.title, "Reason · needs you", "and in the background");
  await p.show();
  assert.equal(p.document.title, "Reason · needs you", "looking does not clear it: answering does");
  await p.poll({ ok: true, needs: [], done: [], notify: false });
  assert.equal(p.document.title, "Reason — Settings");
  assert.deepEqual(p.links.map(l => l.href), PAPER);
  assert.equal(p.shown.length, 0, "no browser notification unless this browser turned them on");
});

test("§4h 5: no count, no \"Done ·\" title; a finished job leaves the tab alone", async () => {
  const p = pretend();
  await p.start({ ok: true, needs: [], done: [], notify: false });
  await p.hide({ ok: true, needs: [need("approval-1"), need("approval-2")], done: [{ id: "task-3", title: "pickup at 6:30", at: 3000 }], notify: false });
  assert.equal(p.document.title, "Reason · needs you");
  await p.poll({ ok: true, needs: [], done: [{ id: "task-3", title: "pickup at 6:30", at: 3000 }], notify: false });
  assert.equal(p.document.title, "Reason — Settings");
  assert.doesNotMatch(nt.NOTIFY_JS, /Done \\u00b7|'\('\+/);
});

test("§4h 5: the night marks on Night: the theme chosen on Web first, else the phone's", async () => {
  const chosen = pretend({ theme: "dark" });
  await chosen.start({ ok: true, needs: [need("approval-1")], done: [], notify: false });
  assert.deepEqual(chosen.links.map(l => l.href), NIGHT_NEEDS, "Night chosen on Web, phone in light");
  chosen.retheme("light");
  assert.deepEqual(chosen.links.map(l => l.href), PAPER_NEEDS, "switched to Paper: follows at once");
  const auto = pretend({ osDark: true });
  await auto.start({ ok: true, needs: [], done: [], notify: false });
  assert.deepEqual(auto.links.map(l => l.href), NIGHT, "Auto follows the phone");
  const paper = pretend({ theme: "light", osDark: true });
  await paper.start({ ok: true, needs: [], done: [], notify: false });
  assert.deepEqual(paper.links.map(l => l.href), PAPER, "Paper chosen wins over a dark phone");
});

test("8C: a browser notification only when it's on here, permission granted, the tab hidden, and only once per approval", async () => {
  const p = pretend();
  await p.start({ ok: true, needs: [], done: [], notify: true });
  await p.hide({ ok: true, needs: [need("approval-5"), need("task-6", false, "one thing needs an answer")], done: [], notify: true });
  assert.deepEqual(p.shown, [{ title: "Reason", body: "Reason needs your approval.", tag: "reason-needs-you", silent: true }]);
  await p.poll();
  assert.equal(p.shown.length, 1, "not twice");
  const q = pretend({ permission: "denied" });
  await q.start({ ok: true, needs: [], done: [], notify: true });
  await q.hide({ ok: true, needs: [need("approval-5")], done: [], notify: true });
  assert.equal(q.shown.length, 0);
});

test("8B: one Caveat line at the top of another screen until they look; never on the chat; gone once answered", async () => {
  const p = pretend({ path: "/web/memory" });
  await p.start({ ok: true, needs: [need("approval-9")], done: [], notify: false });
  const el = p.line();
  assert.ok(el, "drawn");
  assert.equal(el.attrs.role, "status");
  assert.equal(el.hand.textContent, "the hudson inn needs a yes");
  assert.equal(el.a.href, "/web/ongoing/approval/9");
  assert.match(el.html, /See it <span aria-hidden="true">\\u2192|See it <span aria-hidden="true">→/);
  await p.poll();
  assert.ok(p.line(), "stays until they look");
  el.a.onclick();
  await p.poll();
  assert.equal(p.line(), null, "they looked");
  // On the chat (it shows the approval itself): no line, and what it shows counts as seen.
  const chat = pretend({ path: "/web" });
  await chat.start({ ok: true, needs: [need("approval-11")], done: [], notify: false });
  assert.equal(chat.line(), null);
  assert.match(chat.store.get("reason-web-seen"), /approval-11/);
  // Answered: gone.
  const q = pretend({ path: "/web/settings" });
  await q.start({ ok: true, needs: [need("approval-12")], done: [], notify: false });
  assert.ok(q.line());
  await q.poll({ ok: true, needs: [], done: [], notify: false });
  assert.equal(q.line(), null);
});

test("the script stays asleep on a signed-out page", async () => {
  const p = pretend({ signedIn: false });
  await p.start({ ok: true, needs: [need("approval-1")], done: [], notify: false });
  await p.hide();
  assert.equal(p.document.title, "Reason — Settings");
});

// ---------- icons (I1) ----------

test("I1: every Web page links Web's own icons (paper + night by prefers-color-scheme, the filled twins, 180px home-screen PNG)", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  for (const [sub, query] of [["settings", {}], [null, {}], [null, { thread: "" }], ["memory", {}]]) {
    const html = (await call(h, { sub, b: me, query })).body;
    assert.ok(html.includes(`<link rel="icon" type="image/svg+xml" href="/web/icons/favicon.svg?v=${nt.WEB_ICON_VERSION}" data-calm="/web/icons/favicon.svg?v=${nt.WEB_ICON_VERSION}" data-needs="/web/icons/favicon-needs-you.svg?v=${nt.WEB_ICON_VERSION}" media="(prefers-color-scheme: light)">`), `${sub}`);
    assert.ok(html.includes(`href="/web/icons/favicon-night.svg?v=${nt.WEB_ICON_VERSION}" data-calm="/web/icons/favicon-night.svg?v=${nt.WEB_ICON_VERSION}" data-needs="/web/icons/favicon-night-needs-you.svg?v=${nt.WEB_ICON_VERSION}" media="(prefers-color-scheme: dark)">`));
    assert.ok(html.includes(`<link rel="apple-touch-icon" href="/web/icons/apple-touch-icon.png?v=${nt.WEB_ICON_VERSION}">`));
    assert.doesNotMatch(html, /href="\/favicon\.svg/, "not the Reason pages' icon");
  }
  const signin = (await call(h, { sub: null })).body;
  assert.ok(signin.includes(`/web/icons/favicon.svg?v=${nt.WEB_ICON_VERSION}`), "signed out too");
});

test("I1: the icon files: the handoff's marks in Reason's pen, outlined and filled, paper and night; the PNG is 180×180", async () => {
  const { BRAND_PEN, BRAND_PEN_DARK } = await import("../src/pages/brand.js");
  const svg = (f) => nt.webIcon(f).body.toString("utf8");
  assert.match(svg("favicon.svg"), new RegExp(`<rect width="64" height="64" rx="14.0" fill="#f2ebe0"/>.*fill="none" stroke="${BRAND_PEN}"`));
  assert.match(svg("favicon-needs-you.svg"), new RegExp(`fill="${BRAND_PEN}" stroke="${BRAND_PEN}"`));
  assert.match(svg("favicon-night.svg"), new RegExp(`fill="#1c1814"/>.*fill="none" stroke="${BRAND_PEN_DARK}"`));
  assert.match(svg("favicon-night-needs-you.svg"), new RegExp(`fill="${BRAND_PEN_DARK}" stroke="${BRAND_PEN_DARK}"`));
  const png = nt.webIcon("apple-touch-icon.png");
  assert.equal(png.headers["Content-Type"], "image/png");
  assert.equal(png.body.readUInt32BE(16), 180);
  assert.equal(png.body.readUInt32BE(20), 180);
  assert.equal(nt.webIcon("../../.env"), null);
  assert.equal(nt.webIcon("reason-contact.svg"), null, "the contact photo is not here (held)");
});

test("I1: GET /web/icons/<file> over HTTP, cached a day; anything else is not served", async () => {
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/web/icons/favicon-needs-you.svg`, { headers: { host: "heyreason.test" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/svg+xml");
    assert.equal(r.headers.get("cache-control"), "public, max-age=86400");
    const bad = await fetch(`http://127.0.0.1:${port}/web/icons/nope.svg`);
    assert.notEqual(bad.status, 200);
  } finally { server.close(); }
});
