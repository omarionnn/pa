// Reason Web Settings (src/pages/websettings.js, routed through src/pages/websignin.js and src/http.js),
// the handoff's "6 · Settings" and sheets 8A/8B. Every control persists AND takes effect, one pinned
// test per rule:
//
//   - signed out: the page and every POST send the browser to sign in; nothing changes
//   - every POST needs the session's own secret and Reason's own origin (403, nothing changes)
//   - How Reason reaches you: the dashed phrases open the edit state (test/web-settings-edit.test.js
//     pins 5A–5D and the four values); src/deliver.js honours it — a finished job's result is texted
//     under 'text' (the default) and kept on Web (history row on web, nothing texted) under 'web'; a
//     task waiting on them, a failed one, and a reminder are texted either way
//   - Private by default is not drawn while it is untrue (approvals are asked with their details)
//   - Signed-in browsers: this person's sessions only, device from the user agent, last active, this
//     one "you're here"; SIGN OUT really ends that session; a handle from somebody else's list ends
//     nothing; Sign out everywhere ends every one of theirs (this one too) and nobody else's
//   - Connected: only what this person's own stores hold; a dead AgentCard connection is not shown
//   - Invites: real count, links with JOINED / UNUSED / CANCELED, Make an invite link makes one;
//     nobody the invites switch leaves dark sees the section or can make one
//   - Theme: saved per account, and every signed-in page on any browser opens in it (server-drawn)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-settings-"));
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

// ---------- signed out, and the guards on every POST ----------

test("signed out: the page and every control send the browser to sign in, and nothing changes", async () => {
  const h = harness();
  const out = await call(h, {});
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web");
  const p = await call(h, { method: "POST", body: "do=reach&reach=web&c=x", headers: { cookie: "reason_page=nobody" } });
  assert.equal(p.status, 303);
  assert.equal(db.webReach(OWNER_C), "text");
});

test("every POST needs the session's own secret and Reason's own origin: refused, nothing changes", async () => {
  const h = harness();
  const me = browser(OWNER_C), kofi = browser(KOFI_C);
  // Somebody else's secret, a made-up one, none at all.
  for (const csrf of [kofi.csrf, "forged", ""]) {
    const out = await post(h, me, { do: "reach", reach: "web" }, { csrf });
    assert.equal(out.status, 403);
  }
  // The right secret, from another site.
  const cross = await post(h, me, { do: "theme", theme: "night" }, { headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } });
  assert.equal(cross.status, 403);
  const all = await post(h, me, { do: "everywhere" }, { headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } });
  assert.equal(all.status, 403);
  assert.equal(db.webReach(OWNER_C), "text");
  assert.equal(db.webTheme(OWNER_C), null);
  assert.equal(db.pageSessionsFor(OWNER_C).length, 1, "nobody was signed out");
});

// ---------- the page (8A / 8B / desktop) ----------

test("the page: Settings, the section index, every section in order, the reference's words", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  const body = await page(h, me);
  assert.match(body, /<h1 class="st-h1">Settings<\/h1>/);
  assert.match(body, /<nav class="st-nav" aria-label="Settings sections"><a href="#reach" aria-current="true">HOW I REACH YOU<\/a><a href="#browsers">BROWSERS<\/a><a href="#notify">NOTIFICATIONS<\/a><a href="#connected">CONNECTED<\/a><a href="#invites">INVITES<\/a><a href="#theme">THEME<\/a><\/nav>/);
  const order = ["HOW REASON REACHES YOU</h2>", "SIGNED-IN BROWSERS</h2>", "BROWSER NOTIFICATIONS</h2>", "CONNECTED</h2>", "INVITES</h2>", "THEME</h2>", ">SIGN OUT OF THIS BROWSER<"].map(t => body.indexOf(t));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `sections in order: ${order}`);
  assert.match(body, /← BACK TO THE CHAT/);
  assert.match(body, /<p class="hand">or just ask me to text you for one thing\.<\/p>/);
  assert.doesNotMatch(body, /coming to this page/);
  // No footer switch: the page's own THEME section is the switch.
  assert.doesNotMatch(body, /<footer class="foot">/);
});

test("Private by default is not drawn while approvals are still asked with their details in the text", async () => {
  const h = harness();
  const body = await page(h, browser(OWNER_C));
  assert.equal(st.PRIVATE_BY_DEFAULT, false);
  assert.doesNotMatch(body, /PRIVATE BY DEFAULT/i);
  assert.doesNotMatch(body, /behind sign-in|never the details/i);
  // The one place the words appear is 8C's sample of what a browser notification says, which is true.
  assert.equal((body.replace(/<script>[^]*?<\/script>/g, "").match(/Reason needs your approval/g) ?? []).length, 1);
  assert.match(body, /<span class="lbl">WHEN THEY'RE ON, ONE SAYS ONLY<\/span><div class="card nt-card"><b>Reason<\/b><span>Reason needs your approval\.<\/span><\/div>/);
});

// ---------- How Reason reaches you ----------

test("reach: the dashed phrases open the four choices; Save sets accounts.web_reach and shows the new sentence", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  // The default is how Reason has always worked: everything texted.
  let body = await page(h, me);
  assert.match(body, /Text me for <a class="ph" href="\/web\/settings\?edit=reach" aria-describedby="reach-how">everything<\/a>\. Keep <a class="ph" href="\/web\/settings\?edit=reach" aria-describedby="reach-how">a copy<\/a> here\./);
  const out = await post(h, me, { do: "reach", reach: "web" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web/settings?saved=reach");
  assert.equal(db.webReach(OWNER_C), "web");
  body = await page(h, me);
  assert.match(body, /Text me for <a class="ph" href="\/web\/settings\?edit=reach" aria-describedby="reach-how">timely decisions<\/a>\. Keep <a class="ph" href="\/web\/settings\?edit=reach" aria-describedby="reach-how">routine results<\/a> here\./);
  assert.equal(db.webReach(KOFI_C), "text", "only this person's");
  await post(h, me, { do: "reach", reach: "text" });
  assert.equal(db.webReach(OWNER_C), "text");
  // Anything else is not a setting: back to the choices, nothing changed.
  const bad = await post(h, me, { do: "reach", reach: "never" });
  assert.equal(bad.headers.Location, "/web/settings?edit=reach");
  assert.equal(db.webReach(OWNER_C), "text");
});

function doneTask(conv, title = "find a dentist") {
  const t = db.createTask(conv, { title, goal: title, maxAttempts: 5 });
  db.finishTask(conv, t.id, { state: "done", outcome: "found one" });
  return t.id;
}

test("delivery: a finished job's result is texted under 'text' and kept on Web under 'web'", async () => {
  const h = harness();
  const id = doneTask(OWNER_C);
  // 'text' (default): texted, as ever.
  await h.deliver({ conversationId: OWNER_C, text: "Found a dentist: Dr. Mensah, Tue 3pm.", fromTask: id });
  assert.ok(await until(() => h.fake.sent.some(m => m.text.includes("Dr. Mensah"))), "texted");
  // 'web': not texted, written to Web's history for the same person.
  db.setWebReach(OWNER_C, "web");
  const before = h.fake.sent.length;
  const r = await h.deliver({ conversationId: OWNER_C, text: "Your passport renewal form is filled in.", fromTask: id });
  assert.equal(r.ok, true);
  assert.ok(await until(() => db.messagesFor(OWNER_C).some(m => m.channel === "web" && m.text.includes("passport"))), "on Web");
  await new Promise(r2 => setTimeout(r2, 30));
  assert.equal(h.fake.sent.length, before, "nothing texted");
  assert.ok(h.web.recent.some(m => m.text.includes("passport") && m.to === OWNER));
  assert.ok(h.logs.some(l => l.kept_on_web === OWNER_C));
});

test("delivery under 'web': timely things are still texted — waiting on them, failed, a reminder, a reply", async () => {
  const h = harness();
  db.setWebReach(OWNER_C, "web");
  const waiting = db.createTask(OWNER_C, { title: "book flights", goal: "book flights", maxAttempts: 5 });
  db.updateTask(OWNER_C, waiting.id, { state: "waiting_on_you" });
  const failed = db.createTask(OWNER_C, { title: "get tickets", goal: "get tickets", maxAttempts: 5 });
  db.finishTask(OWNER_C, failed.id, { state: "failed", outcome: "sold out" });
  const done = doneTask(OWNER_C);
  const route = (o) => ({ channel: "fake", to: OWNER, started: true, ...o });
  assert.equal(keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route(), fromTask: waiting.id }), false);
  assert.equal(keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route(), fromTask: failed.id }), false);
  assert.equal(keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route(), fromTask: null }), false, "a reminder");
  assert.equal(keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route({ started: false }), fromTask: done }), false, "a reply goes back the way it came");
  assert.equal(keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route(), fromTask: done, media: { file: "x" } }), false, "a recording");
  assert.equal(keptOnWeb({ router: h.router, conversationId: KOFI_C, route: route(), fromTask: done }), false, "somebody else's task id is not theirs");
  assert.equal(keptOnWeb({ router: h.router, conversationId: OWNER_C, route: route(), fromTask: done }), true);
  // Web off for them: texted.
  config.web = "owner";
  db.setWebReach(KOFI_C, "web");
  const kofiDone = doneTask(KOFI_C);
  assert.equal(keptOnWeb({ router: h.router, conversationId: KOFI_C, route: route({ to: KOFI }), fromTask: kofiDone }), false);
  for (const fromTask of [waiting.id, failed.id, null]) {
    const before = h.fake.sent.length;
    await h.deliver({ conversationId: OWNER_C, text: `timely ${fromTask}`, fromTask });
    assert.ok(await until(() => h.fake.sent.length > before), `texted: task ${fromTask}`);
  }
});

test("delivery under 'web', end to end: a task turn that finishes the job keeps its result on Web", async () => {
  let taskId = null;
  const h = harness({ turn: async () => { db.finishTask(OWNER_C, taskId, { state: "done", outcome: "done" }); return "All three quotes are in. Cheapest is $410."; } });
  db.setWebReach(OWNER_C, "web");
  taskId = db.createTask(OWNER_C, { title: "movers", goal: "get mover quotes", maxAttempts: 5 }).id;
  await h.runtime._turn({ conversationId: OWNER_C, text: "you are working on task", kind: "event", meta: { fromTask: taskId } });
  assert.ok(await until(() => db.messagesFor(OWNER_C).some(m => m.channel === "web" && m.text.includes("$410"))), "on Web");
  assert.equal(h.fake.sent.filter(m => m.text.includes("$410")).length, 0, "not texted");
});

// ---------- Signed-in browsers ----------

test("browsers: this person's sessions only, device from the user agent, last active, this one 'you're here'", async () => {
  const h = harness();
  const phone = browser(OWNER_C, IPHONE);
  await call(h, { sub: null, b: phone });
  clock.skip(2 * HOUR);
  const old = browser(OWNER_C, WIN_FF);
  await call(h, { sub: null, b: old });
  const weekAgo = clock.now() - 7 * DAY;
  db.db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(weekAgo, old.token);
  const day = st.lastActive(weekAgo);
  assert.match(day, /^[A-Z]{3} \d{1,2}$/);
  const kofi = browser(KOFI_C, IPHONE);
  await call(h, { sub: null, b: kofi });
  const me = browser(OWNER_C, MAC_CHROME);
  const body = await page(h, me);
  assert.equal(db.pageSessionsFor(OWNER_C).find(s => s.token === me.token).user_agent, MAC_CHROME, "the browser is written down");
  const rows = [...body.matchAll(/<div class="br-row[^"]*">.*?<\/div>/g)].map(m => m[0]);
  assert.equal(rows.length, 3, "Kofi's browser is not on the owner's list");
  assert.match(rows[0], /class="br-row here".*Chrome on Mac.*THIS ONE · <\/span>NOW.*<span class="br-here">you're here<\/span>/);
  assert.doesNotMatch(rows[0], /SIGN OUT/);
  assert.match(rows[1], /Safari on iPhone.*2 HOURS AGO.*>SIGN OUT<\/button>/);
  assert.match(rows[2], new RegExp(`Firefox on Windows.*${day}.*>SIGN OUT</button>`));
  assert.doesNotMatch(body, new RegExp(phone.token), "a session token is never on the page");
  assert.match(body, /<a class="every" href="\/web\/settings\?confirm=everywhere">Sign out everywhere<\/a>/, "asks first (5C)");
  assert.doesNotMatch(body, /older sign-in/);
});

test("browsers: sessions never used since browsers were noted are one quiet count, ended by Sign out everywhere", async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) db.startPageSession("p123", `page-${i}-${Math.random()}`, { conversationId: OWNER_C });
  const me = browser(OWNER_C);
  const body = await page(h, me);
  assert.equal((body.match(/class="br-row/g) ?? []).length, 1, "only this one is listed");
  assert.match(body, /<p class="st-quiet">And 3 other sign-ins that haven't opened Reason Web, like Reason's pages\. Signing out everywhere ends them too\.<\/p>/);
  assert.match(body, /class="br-row here"/, "this browser is listed");
  db.db.prepare("DELETE FROM page_sessions WHERE token LIKE 'page-1-%' OR token LIKE 'page-2-%'").run();
  assert.match(await page(h, me), /And 1 other sign-in that hasn't opened Reason Web, like Reason's pages\. Signing out everywhere ends it too\./);
  await post(h, me, { do: "everywhere" });
  assert.equal(db.pageSessionsFor(OWNER_C).length, 0);
});

test("SIGN OUT ends that browser's session for real; this one stays; a handle from another list ends nothing", async () => {
  const h = harness();
  const phone = browser(OWNER_C, IPHONE);
  const kofi = browser(KOFI_C, IPHONE);
  const me = browser(OWNER_C, MAC_CHROME);
  // Kofi's own handle, posted from the owner's page: not the owner's, nothing ends.
  const nope = await post(h, me, { do: "browser", b: st.sessionHandle(kofi.token) });
  assert.equal(nope.status, 303);
  assert.equal((await call(h, { b: kofi })).status, 200, "Kofi is still signed in");
  // The owner's phone, from the owner's page.
  const out = await post(h, me, { do: "browser", b: st.sessionHandle(phone.token) });
  assert.equal(out.headers.Location, "/web/settings?done=browsers#browsers");
  assert.equal((await call(h, { b: phone })).status, 303, "the phone's session opens nothing now");
  assert.equal((await call(h, { b: phone })).headers.Location, "/web");
  assert.equal((await call(h, { b: me })).status, 200, "this browser is still in");
  assert.match((await call(h, { b: me, query: { done: "browsers" } })).body, /role="status">got it\./);
});

test("Sign out everywhere ends every one of this person's browsers, this one too, and nobody else's", async () => {
  const h = harness();
  const phone = browser(OWNER_C, IPHONE), laptop = browser(OWNER_C, WIN_FF), kofi = browser(KOFI_C);
  const me = browser(OWNER_C);
  const out = await post(h, me, { do: "everywhere" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web?out=1");
  assert.ok([].concat(out.headers["Set-Cookie"]).some(c => /^reason_page=;.*Max-Age=0/.test(c)), "the cookie is cleared");
  for (const b of [phone, laptop, me]) assert.equal((await call(h, { b })).status, 303);
  assert.equal(db.pageSessionsFor(OWNER_C).length, 0);
  assert.equal((await call(h, { b: kofi })).status, 200, "Kofi untouched");
});

test("SIGN OUT OF THIS BROWSER posts to the existing sign-out with this session's secret", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  const body = await page(h, me);
  assert.match(body, new RegExp(`<form method="POST" action="/web/signout" class="out-f"><input type="hidden" name="c" value="${me.csrf}"><button class="act2 out" type="submit" data-busy="SIGNING OUT…">SIGN OUT OF THIS BROWSER</button></form>`));
  const out = await call(h, { sub: "signout", method: "POST", b: me, body: `c=${encodeURIComponent(me.csrf)}` });
  assert.equal(out.headers.Location, "/web?out=1");
  assert.equal((await call(h, { b: me })).status, 303);
});

test("device names and last-active words", () => {
  assert.equal(st.deviceName(MAC_CHROME), "Chrome on Mac");
  assert.equal(st.deviceName(IPHONE), "Safari on iPhone");
  assert.equal(st.deviceName(WIN_FF), "Firefox on Windows");
  assert.equal(st.deviceName("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130 Safari/537.36 Edg/130.0"), "Edge on Windows");
  assert.equal(st.deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1) CriOS/130 Mobile Safari/604.1"), "Chrome on iPhone");
  assert.equal(st.deviceName("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(st.deviceName(""), "Unknown browser");
  assert.equal(st.deviceName(null), "Unknown browser");
  const now = Date.UTC(2026, 9, 26, 18);
  assert.equal(st.lastActive(now - 30_000, now), "NOW");
  assert.equal(st.lastActive(now - 12 * MIN, now), "12 MIN AGO");
  assert.equal(st.lastActive(now - HOUR, now), "1 HOUR AGO");
  assert.equal(st.lastActive(now - 5 * HOUR, now), "5 HOURS AGO");
  assert.equal(st.lastActive(Date.UTC(2026, 9, 19, 16), now), "OCT 19");
});

// ---------- Connected ----------

test("connected: only what this person's own stores hold, in the handoff's order; a dead card is not shown", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  let body = await page(h, me);
  assert.match(body, /Nothing is connected yet\. To connect one, ask Reason in the chat\./);
  db.saveOauthTokens(OWNER_C, "github", { accessToken: "g", accountLabel: "omari" });
  db.saveOauthTokens(OWNER_C, "google", { accessToken: "a", accountLabel: "o@example.com" });
  db.saveOauthTokens(OWNER_C, "apple_calendar", { accessToken: "x", accountLabel: "o@icloud.com" });
  db.saveOauthTokens(KOFI_C, "spotify", { accessToken: "s" });
  db.saveOauthTokens(KOFI_C, "uber", { accessToken: "u" });
  // A card connection that AgentCard has refused: dead, so not "connected".
  db.startAgentcardEnrollment({ conversationId: OWNER_C, vaultSessionId: "vs_1" });
  db.saveAgentcardConnection({ conversationId: OWNER_C, userId: "usr_1", accessToken: "", refreshToken: "" });
  body = await page(h, me);
  const names = [...body.matchAll(/<li><span class="cn-n">(.*?)<\/span><span class="cn-s">connected<\/span><\/li>/g)].map(m => m[1]);
  assert.deepEqual(names, ["GOOGLE", "GITHUB", "ICLOUD"]);
  assert.match(body, /To change one, ask Reason in the chat\./);
  db.saveAgentcardConnection({ conversationId: OWNER_C, userId: "usr_1", accessToken: "live", refreshToken: "r", expiresAt: clock.now() + HOUR });
  body = await page(h, me);
  assert.match(body, /<li><span class="cn-n"><span class="m-only">CARD · AGENTCARD<\/span><span class="d-only">AGENTCARD<\/span><\/span><span class="cn-s">connected<\/span><\/li><li><span class="cn-n">GOOGLE/);
  assert.deepEqual(st.connections(KOFI_C).map(c => c.name), ["SPOTIFY", "UBER"]);
});

// ---------- Invites ----------

test("invites: N left, every link stamped JOINED / UNUSED / CANCELED, and Make an invite link makes one", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  let body = await page(h, me);
  assert.match(body, /<p class="inv-n">2 left<\/p>/);
  const out = await post(h, me, { do: "invite" });
  const [made] = db.listInvites(OWNER_C);
  assert.equal(out.headers.Location, `/web/settings?invite=${made.id}`, "5D: the link just made");
  assert.equal(made.state, "unused");
  body = await page(h, me);
  assert.match(body, /<p class="inv-n">1 left<\/p>/);
  assert.match(body, new RegExp(`<li><a class="inv-l" href="${invites.inviteUrl(made.token)}">files\\.heyreason\\.test/i/${made.token.slice(0, 6).replace(/[-]/g, "\\-")}…</a><span class="stamp stamp-ink">UNUSED</span><form method="POST" action="/web/settings">`));
  // Canceling it (in the chat) frees the slot and stamps it.
  assert.equal(invites.cancelLink(OWNER_C, made.id, { replace: false }).ok, true);
  // One that somebody joined with.
  const second = invites.makeLink(OWNER_C);
  const inv2 = db.listInvites(OWNER_C).find(i => i.id === second.number);
  assert.equal(db.redeemInvite({ claimCode: inv2.claim_code, channel: "fake", address: "+13105550123", name: "Esi" }).ok, true);
  body = await page(h, me);
  assert.match(body, /<span class="inv-l gone">[^<]+<\/span><span class="stamp stamp-muted">CANCELED<\/span>/);
  assert.match(body, /<span class="inv-l">[^<]+<\/span><span class="stamp stamp-pen">JOINED<\/span>/);
  assert.match(body, /<p class="inv-n">1 left<\/p>/, "the join spent one of two");
  assert.doesNotMatch(body, new RegExp(made.token), "a canceled link's token is not on the page");
  // The last one, then none left: no button.
  await post(h, me, { do: "invite" });
  body = await page(h, me);
  assert.match(body, /<p class="inv-n">0 left<\/p>/);
  assert.doesNotMatch(body, /Make an invite link/);
  await post(h, me, { do: "invite" });
  assert.equal(db.listInvites(OWNER_C).length, 3, "nothing more is made");
});

test("invites dark (REASON_INVITES_OPEN off): somebody it leaves out sees no section and can make no link", async () => {
  const h = harness();
  const kofi = browser(KOFI_C);
  const body = await page(h, kofi);
  assert.doesNotMatch(body, /id="invites"/);
  assert.doesNotMatch(body, /href="#invites"/);
  await post(h, kofi, { do: "invite" });
  assert.equal(db.listInvites(KOFI_C).length, 0);
  config.invitesOpen = true;
  assert.match(await page(h, kofi), /<p class="inv-n">2 left<\/p>/);
});

// ---------- Theme ----------

test("theme: a radio group of submit buttons; the choice is saved for the account and every page opens in it", async () => {
  const h = harness();
  const me = browser(OWNER_C);
  let body = await page(h, me);
  assert.match(body, /<div class="th-g" role="radiogroup" aria-labelledby="th-h"><button type="submit" role="radio" name="theme" value="paper" aria-checked="false">Paper<\/button>.*value="night" aria-checked="false">Night<\/button>.*value="auto" aria-checked="true">Auto<\/button><\/div>/);
  assert.match(body, /^<!doctype html>\n<html lang="en" data-account-theme="" data-c="[^"]+">/, "never chosen: this browser decides");
  const out = await post(h, me, { do: "theme", theme: "night" });
  assert.equal(out.headers.Location, "/web/settings?done=theme#theme");
  assert.equal(db.webTheme(OWNER_C), "night");
  // Another browser of theirs, never switched: opens at Night, drawn by the server, every page.
  const other = browser(OWNER_C, IPHONE);
  for (const sub of ["settings", null]) {
    const html = (await call(h, { sub, b: other, query: sub ? {} : { thread: "" } })).body;
    assert.match(html, new RegExp(`^<!doctype html>\\n<html lang="en" data-account-theme="night" data-c="${other.csrf}" data-theme="dark"`), `page ${sub}`);
  }
  assert.match(await page(h, other), /value="night" aria-checked="true">Night/);
  // The page's script saves it the same way, as JSON.
  const js = await post(h, me, { do: "theme", theme: "paper" }, { headers: { accept: "application/json" } });
  assert.equal(js.status, 200);
  assert.deepEqual(JSON.parse(js.body), { ok: true, theme: "paper" });
  assert.match((await page(h, other)), /data-account-theme="paper" data-c="[^"]+" data-theme="light"/);
  await post(h, me, { do: "theme", theme: "auto" });
  assert.match(await page(h, other), /data-account-theme="auto" data-c="[^"]+">/);
  const bad = await post(h, me, { do: "theme", theme: "neon" }, { headers: { accept: "application/json" } });
  assert.equal(bad.status, 400);
  assert.equal(db.webTheme(OWNER_C), "auto");
  assert.equal(db.webTheme(KOFI_C), null, "only this person's");
  // Signed-out pages are never told anybody's theme.
  assert.match((await call(h, { sub: null })).body, /^<!doctype html>\n<html lang="en"><head>/);
});

test("the kit's head script follows the account's choice and every switch saves it back", async () => {
  const { KIT_CSS } = await import("../src/pages/webkit.js");
  void KIT_CSS;
  const h = harness();
  const body = await page(h, browser(OWNER_C));
  assert.match(body, /a=h\.getAttribute\('data-account-theme'\);if\(a==='paper'\|\|a==='night'\)localStorage\.setItem\('reason-theme',a==='paper'\?'light':'dark'\);else if\(a==='auto'\)localStorage\.removeItem\('reason-theme'\)/);
  assert.match(body, /fetch\('\/web\/settings',\{method:'POST'/);
});

test("accessibility: real buttons and forms, labelled groups, the busy state, no click handlers on divs", async () => {
  const h = harness();
  await call(h, { sub: null, b: browser(OWNER_C, IPHONE) });
  const body = await page(h, browser(OWNER_C));
  assert.match(body, /<p class="sr" id="reach-how">/);
  assert.match(body, /aria-label="Sign out Safari on iPhone, last active now">SIGN OUT<\/button>/);
  assert.doesNotMatch(body, /<div[^>]*onclick/);
  assert.match(body, /\.ph::after\{[^}]*min-height:44px/, "the phrase's target is 44px tall without spreading the sentence");
  assert.match(body, /\.st-nav a\{min-height:44px/);
  void DAY;
});
