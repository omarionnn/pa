// Connect only when a task needs it, then connect the rest once (owner 11-11; src/connectafter.js,
// REASON_CONNECT_AFTER). Through the real router, outbox and database; the model's turn is stood in for
// and does what the real tools would record (a store sign-in landing, a checkout placed, a mail read).
//
//   the first chat: card, try line, never an Amazon offer
//   a task needs Amazon → its link → it works → the connect-the-rest line + link, once
//   the next task → nothing
//   a failed turn, a checkout still running, everything connected, a connection from before → nothing
//   owner mode reaches only the owner; off reaches nobody
//   the page: each service ✓ or a button; a button makes that service's own link; an old link is gone
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-connect-after-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.example";
delete process.env.REASON_ONBOARDING;
delete process.env.REASON_INTRO_AMAZON;
delete process.env.CROSSMINT_CLIENT_KEY;
delete process.env.CROSSMINT_SERVER_KEY;
process.env.REASON_CONNECT_AFTER = "on";
process.env.REASON_TOKEN_KEY = "ab".repeat(32);

const ob = await import("../src/onboarding.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const amazon = await import("../src/amazonconnect.js");
const shop = await import("../src/shopconnect.js");
const ca = await import("../src/connectafter.js");
const page = await import("../src/pages/connectall.js");
const { SYSTEM } = await import("../src/agent.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415557${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_CONNECT_AFTER = "on";
  delete process.env.REASON_INTRO_AMAZON;
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.publicUrl = "https://reason.example.test";
  config.googleClientId = "gid";
  config.googleClientSecret = "gsecret";
  db.db.exec("DELETE FROM accounts; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM oauth_tokens; DELETE FROM shop_stores; DELETE FROM shop_runs; DELETE FROM connect_after; DELETE FROM connect_after_uses; DELETE FROM connect_after_links;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

/** The turn stands in for the model: `act` is what its tools would have done this turn. */
function harness() {
  const turns = [];
  let act = null;
  let reply = "on it";
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); if (act) await act(conversationId); return reply; } });
  const ask = async ({ prompt }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    const reads = { "hey": { kind: "greeting" }, "kofi": { kind: "answer", name: "Kofi" }, "jarvis": { kind: "answer", card_name: "Jarvis" } };
    const r = reads[said] ?? { kind: "task" };
    return { value: { name: "", card_name: "", reply: "", name_line: "", amazon: "", ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {} } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return {
    router, channel, turns,
    doing(fn, r = "on it") { act = fn; reply = r; },
  };
}
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });
const to = (h, num) => h.channel.sent.filter(m => m.to === num).map(m => m.text);
const placed = (c, store = "amazon") => {
  const id = `run_${Math.random().toString(36).slice(2)}`;
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at) VALUES (?, ?, ?, 'paper towels', 'buy', 'done', ?, ?, 'placed', ?)").run(id, c, store, clock.now(), clock.now(), clock.now());
  ca.notePlaced({ conversation_id: c, store });
};
const running = (c) => db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at) VALUES (?, ?, 'amazon', 'x', 'buy', 'running', ?, ?, 'in_progress', ?)").run(`run_${Math.random()}`, c, clock.now(), clock.now(), clock.now());
const sentLine = (lines) => lines.filter(t => t === ca.LINE).length;

async function intro(h, num) {
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  await h.router.deliver(text(num, "jarvis"));
}

test("the first chat: the card and the try line, never an Amazon offer (flag unset = off)", async () => {
  const h = harness();
  const num = newNumber();
  await intro(h, num);
  const said = to(h, num);
  assert.ok(!said.includes(amazon.OFFER), "no Amazon offer");
  assert.ok(said.every(t => !/amazon/i.test(t ?? "")), "nothing about Amazon at all");
  assert.equal(db.getAccount(conv(num)).onboarding, "complete");
  assert.equal(ob.amazonOfferOn(), false);
});

test("a task needs Amazon → its link → it works → one line and the connect-the-rest link; the next task → nothing", async () => {
  const h = harness();
  const num = newNumber();
  const c = conv(num);
  await intro(h, num);
  // 1: the task needs Amazon; the model sends Amazon's own link (stood in) and nothing is connected yet.
  h.doing(async () => {}, "i need you signed in to amazon for that. tap this: https://heyreason.example/web/connect/abc");
  let before = to(h, num).length;
  await h.router.deliver(text(num, "order paper towels on amazon"));
  assert.equal(sentLine(to(h, num).slice(before)), 0, "nothing before it worked");
  // 2: they signed in; the checkout runs and is still going → mid-task, nothing.
  shop.markConnected(c, "amazon");
  h.doing(async (cc) => running(cc), "signed in, placing it now");
  before = to(h, num).length;
  await h.router.deliver(text(num, "done"));
  assert.equal(sentLine(to(h, num).slice(before)), 0, "never mid-task");
  // 3: the order is placed → the line, then the link on its own.
  db.db.exec("UPDATE shop_runs SET status = 'done', stage = 'placed'");
  h.doing(async (cc) => placed(cc), "ordered. arrives thursday");
  before = to(h, num).length;
  await h.router.deliver(text(num, "great"));
  const after3 = to(h, num).slice(before);
  assert.equal(sentLine(after3), 1, "the line, once");
  const i = after3.indexOf(ca.LINE);
  assert.match(after3[i + 1], /^https:\/\/heyreason\.example\/web\/connect-all\/[A-Za-z0-9_-]{32}$/, "the link alone in the next bubble");
  assert.ok(i > after3.indexOf("ordered. arrives thursday"), "after the task's own reply");
  assert.match(db.db.prepare("SELECT outcome FROM connect_after WHERE conversation_id = ?").get(c).outcome, /^sent:amazon$/);
  // 4: another task that works → nothing, ever again.
  h.doing(async (cc) => placed(cc), "reordered");
  before = to(h, num).length;
  await h.router.deliver(text(num, "order more"));
  assert.equal(sentLine(to(h, num).slice(before)), 0);
  assert.equal(ca.decide(c).why, "already");
});

test("email: a Google grant and a mail read that worked → the line; the page offers the rest", async () => {
  const h = harness();
  const num = newNumber();
  const c = conv(num);
  await intro(h, num);
  h.doing(async (cc) => {
    db.saveOauthTokens(cc, "google", { accessToken: "t", scope: "https://www.googleapis.com/auth/gmail.readonly", accountLabel: "k@example.com" });
    clock.skip(1000);
    ca.noteTool(cc, "gmail_search", { query: "receipt" }, { ok: true, messages: [] });
  }, "found it: your receipt from tuesday");
  const before = to(h, num).length;
  await h.router.deliver(text(num, "find my uber receipt"));
  assert.equal(sentLine(to(h, num).slice(before)), 1);
  const view = ca.pageView(c);
  assert.deepEqual(view.map(r => [r.service, r.connected]), [["email", true], ["amazon", false]], "no card without checkouts on; email ✓, amazon to connect");
});

test("never: a failed read, a failed turn, a connection from before, everything connected", async () => {
  const h = harness();
  // a mail read that failed is not the task working
  let num = newNumber(); let c = conv(num);
  await intro(h, num);
  h.doing(async (cc) => { db.saveOauthTokens(cc, "google", { accessToken: "t", accountLabel: "a@x.com" }); ca.noteTool(cc, "gmail_search", {}, { ok: false, error: "401" }); });
  await h.router.deliver(text(num, "check my mail"));
  assert.equal(sentLine(to(h, num)), 0);
  assert.equal(ca.decide(c).why, "no_task_yet");
  // a failed turn
  assert.equal(ca.decide(c, { failed: true }).why, "no_task_yet");
  ca.noteUse(c, "email");
  assert.equal(ca.decide(c, { failed: true }).why, "turn_failed");

  // connected before the first turn under the flag: the baseline, never counted
  num = newNumber(); c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Ama" });
  db.saveOauthTokens(c, "google", { accessToken: "t", accountLabel: "ama@x.com" });
  ca.beforeTurn(c);
  ca.noteUse(c, "email");
  assert.equal(ca.decide(c).why, "no_task_yet");

  // everything offered connected → closed, never later
  num = newNumber(); c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Yaw" });
  ca.beforeTurn(c);
  db.saveOauthTokens(c, "google", { accessToken: "t", accountLabel: "yaw@x.com" });
  shop.markConnected(c, "amazon");
  ca.noteUse(c, "email");
  const out = await ca.afterTurn({ conversationId: c });
  assert.equal(out.act, "close");
  assert.equal(ca.decide(c).why, "already");
});

test("stale or unsent: a success over 6 h old says nothing; a send that went nowhere is tried again later", async () => {
  const num = newNumber(); const c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Akua" });
  ca.beforeTurn(c);
  shop.markConnected(c, "amazon");
  ca.noteUse(c, "amazon");
  clock.skip(ca.FRESH_MS + 60_000);
  assert.equal(ca.decide(c).why, "no_task_yet", "a success from hours ago is not now");
  ca.noteUse(c, "amazon");
  // a router whose channel refuses: nothing went, so nothing is claimed and nothing goes in history
  const refusing = { send: async () => ({ ok: false, error: "down" }) };
  const held = await ca.afterTurn({ conversationId: c, router: refusing, sleep: async () => {} });
  assert.equal(held.act, "held");
  assert.equal(db.db.prepare("SELECT sent_at FROM connect_after WHERE conversation_id = ?").get(c).sent_at, null);
  assert.ok(!JSON.stringify(db.loadConversation(c)).includes(ca.LINE));
  const sent = [];
  const ok = await ca.afterTurn({ conversationId: c, router: { send: async (m) => { sent.push(m.text); return { ok: true }; } }, sleep: async () => {} });
  assert.equal(ok.act, "send");
  assert.equal(sent.length, 2);
  assert.equal(sent[0], ca.LINE);
});

test("amazon counts on a placed order only, never on a page merely opened there", () => {
  const num = newNumber(); const c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Kwame" });
  ca.beforeTurn(c);
  shop.markConnected(c, "amazon");
  ca.noteTool(c, "browser_open", { url: "https://www.amazon.com/s?k=towels" }, { ok: true, url: "https://www.amazon.com/s?k=towels" });
  assert.equal(ca.decide(c).why, "no_task_yet");
  ca.notePlaced({ conversation_id: c, store: "amazon" });
  assert.equal(ca.decide(c).act, "send");
});

test("owner mode reaches only the owner; off reaches nobody", async () => {
  const num = newNumber(); const c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Esi" });
  process.env.REASON_CONNECT_AFTER = "owner";
  assert.equal(ca.allowedFor(c), false);
  assert.equal(ca.allowedFor(config.ownerConversation), true);
  ca.beforeTurn(c);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM connect_after WHERE conversation_id = ?").get(c).n, 0, "nothing even recorded");
  process.env.REASON_CONNECT_AFTER = "off";
  assert.equal(ca.allowedFor(config.ownerConversation), false);
  delete process.env.REASON_CONNECT_AFTER;
  assert.equal(ca.mode(), "off", "default off");
});

test("the line: casual, lowercase, one bubble, no unlock, no question to type", () => {
  assert.equal(ca.LINE, "nice, that worked. so i don't have to keep asking you one thing at a time, you can connect the rest here whenever");
  assert.equal(ca.LINE, ca.LINE.toLowerCase());
  assert.doesNotMatch(ca.LINE, /unlock|upgrade|\n|https?:/i);
});

test("the prompt: connect in the moment with that service's own link, never in setup or settings first", () => {
  assert.match(SYSTEM, /Nothing is connected ahead of time: when a task needs a service, send its own link right then/);
  assert.match(SYSTEM, /never "connect it in setup or settings first"/);
});

test("the page: ✓ or a button; a button makes that service's own link and goes there; a dead link is gone", async () => {
  const num = newNumber(); const c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name: "Kojo" });
  db.saveOauthTokens(c, "google", { accessToken: "t", accountLabel: "kojo@x.com" });
  const { token } = ca.createLink(c);
  const got = await page.connectAllRequest({ sub: token, method: "GET" });
  assert.equal(got.status, 200);
  assert.match(got.body, /Connect the rest/);
  assert.match(got.headers["Content-Security-Policy"], /form-action 'self' https:/, "the button's 303 to the service's own page is not blocked");
  assert.match(got.body, /CONNECTED ✓/);
  assert.match(got.body, new RegExp(`/web/connect-all/${token}/go/amazon`));
  assert.doesNotMatch(got.body, /go\/email/, "email already on: no button");
  // email is connected: asking for it again makes nothing, the page comes back
  const again = await page.connectAllRequest({ sub: `${token}/go/email`, method: "POST", headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(again.status, 200);
  // a cross-site post makes nothing
  const cross = await page.connectAllRequest({ sub: `${token}/go/amazon`, method: "POST", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(cross.status, 405);
  // a button for a service not connected: that service's own link (Google's start page here)
  const num2 = newNumber(); const c2 = conv(num2);
  db.upsertAccount({ conversationId: c2, channel: "fake", address: num2, name: "Adwoa" });
  const t2 = ca.createLink(c2).token;
  const go = await page.connectAllRequest({ sub: `${t2}/go/email`, method: "POST", headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(go.status, 303);
  assert.match(go.headers.location, /\/connect\/start/);
  // unknown or expired
  assert.equal((await page.connectAllRequest({ sub: "A".repeat(32), method: "GET" })).status, 410);
  clock.skip(ca.LINK_TTL_MS + 1000);
  assert.equal((await page.connectAllRequest({ sub: token, method: "GET" })).status, 410);
});
