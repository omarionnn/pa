// The ready screen's way in (first-text, 11-17), through the real router, outbox and database.
//
// A first text typed by heyreason.com/start can leave an iPhone as a plain SMS (green) when the phone
// has not yet learned the number does iMessage, and that never reached Reason. So:
//   /status    the page asks whether its text arrived (claimed or not), on the setup's own cookie
//   /tapped    the page says its text button was tapped (the inviter's clock, the ops counts)
//   /text-me   behind REASON_TEXT_ME_FIRST: Reason texts their number first; their reply, any words,
//              claims the setup and spends the invite exactly as the coded first text would
//   the inviter hears once, ten minutes after the tap, never in their night
//   an SMS-service webhook claims like an iMessage one
//   the ops counts: setups finished vs first texts received
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-first-text-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_TOKEN_KEY = "44".repeat(32);
delete process.env.REASON_ONBOARDING;
delete process.env.REASON_TEST_NUMBERS;

const ws = await import("../src/websetup.js");
const store = await import("../src/websetupstore.js");
const invites = await import("../src/invites.js");
const ops = await import("../src/ops.js");
const digest = await import("../src/opsdigest.js");
const notice = await import("../src/notice.js");
const remote = await import("../src/signin-remote.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415559${String(2000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;
const ENV = ["REASON_INVITE_START", "REASON_INVITE_START_URL", "REASON_WEB_SETUP", "REASON_WELCOME_CARDS", "REASON_INTRO_AMAZON", "REASON_PAYWALL", "REASON_FREE_TIER",
  "REASON_TEXT_ME_FIRST", "REASON_TEXT_ME_IP_HOURLY", "REASON_TEXT_ME_HOURLY"];
const MIN = 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  for (const k of ENV) delete process.env[k];
  process.env.REASON_INVITE_START = "on";
  process.env.REASON_INVITE_START_URL = "https://start--textreason.netlify.app";
  process.env.REASON_WEB_SETUP = "on";
  process.env.REASON_TEXT_ME_FIRST = "on";
  ws.resetLimits();
  ws.forgetNameLines();
  config.autoAdmit = true;
  config.testNumbers = [];
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  config.onboardingCardGapMs = 0;
  config.publicUrl = "https://reason.example.test";
  db.db.exec(`DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages;
    DELETE FROM outbox; DELETE FROM timers; DELETE FROM web_setups; DELETE FROM web_setup_marks; DELETE FROM invites; DELETE FROM invite_allowances;
    DELETE FROM plan; DELETE FROM blocked_numbers; DELETE FROM ops_digest;`);
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.backfillInviteAllowances();
});
after(() => { for (const k of ENV) delete process.env[k]; });

function harness({ channel: chOpts = {} } = {}) {
  const turns = [], said = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "on it"; } });
  const realSay = runtime.say.bind(runtime);
  runtime.say = (c, t, m) => { said.push({ c, t }); return realSay(c, t, m); };
  const ask = async () => ({ error: "no stated read" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {}, amazonLink: async () => "https://x.test/s/link" } });
  const channel = router.register(new FakeChannel({ number: LINE, ...chOpts }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns, said };
}
const text = (from, body, extra = {}) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now(), ...extra });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);

async function api(method, path, { cookie = "", body = null, router = null, ip = "1.2.3.4", log = () => {} } = {}) {
  const res = await ws.request({ method, path, query: {}, headers: { cookie: cookie ? `rs_setup=${cookie}` : "", host: "reason.example.test" }, remoteAddress: ip, readBody: async () => body ? JSON.stringify(body) : "", router, log });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
async function newSetup({ invite = null, user = "kofi", reasonName = "jarvis" } = {}) {
  const made = await api("POST", "/api/new", { body: invite ? { invite } : null });
  const cookie = /rs_setup=([^;]+)/.exec(String(made.headers["Set-Cookie"] ?? ""))?.[1];
  await api("POST", `/api/${made.json.id}`, { cookie, body: { user, reasonName } });
  return { ...made.json, cookie };
}
const moreLinks = () => db.db.prepare("UPDATE invite_allowances SET remaining = 10 WHERE conversation_id = ?").run(config.ownerConversation);
const ownerLink = () => {
  const out = db.createInvite(config.ownerConversation);
  assert.ok(out.ok, "owner can make a link");
  return out.invite;
};
const inviteRow = (id) => db.db.prepare("SELECT * FROM invites WHERE id = ?").get(id);
const setupRow = (id) => db.db.prepare("SELECT * FROM web_setups WHERE id = ?").get(id);
const status = (s) => api("GET", `/api/${s.id}/status`, { cookie: s.cookie });
const textMe = (h, s, number, opts = {}) => api("POST", `/api/${s.id}/text-me`, { cookie: s.cookie, body: { number }, router: h.router, ...opts });
/** Move the fake clock to a daytime (or night-time) quarter hour for the owner. */
const toDay = () => { for (let i = 0; i < 200 && (notice.inTheirNight(config.ownerConversation) || notice.inTheirNight(config.ownerConversation, clock.now() + 30 * MIN)); i++) clock.skip(15 * MIN); };
const toNight = () => { for (let i = 0; i < 200 && !(notice.inTheirNight(config.ownerConversation) && notice.inTheirNight(config.ownerConversation, clock.now() + 30 * MIN)); i++) clock.skip(15 * MIN); };

// ---------- did it arrive ----------

test("status: not arrived, then arrived once their coded first text claims the setup; only on the setup's own cookie", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  assert.deepEqual((await status(s)).json, { claimed: false, tapped: false, textMe: { available: true, sent: false, left: 2, canChange: true } });
  assert.equal((await api("POST", `/api/${s.id}/tapped`, { cookie: s.cookie })).status, 200);
  assert.equal((await status(s)).json.tapped, true);
  assert.equal((await api("GET", `/api/${s.id}/status`)).status, 404, "no cookie, nothing");
  assert.equal((await api("GET", `/api/${s.id}/status`, { cookie: "x".repeat(32) })).status, 404, "somebody else's cookie, nothing");
  const num = newNumber();
  await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  const after = await status(s);
  assert.equal(after.status, 200, "a claimed setup still answers its own browser");
  assert.equal(after.json.claimed, true);
  assert.deepEqual(after.json.textMe, { available: false });
  assert.equal((await api("GET", `/api/${s.id}`, { cookie: s.cookie })).status, 404, "the setup itself is closed, as before");
});

test("the tap counts once; a tap on a claimed setup is refused", async () => {
  const h = harness();
  const s = await newSetup();
  await api("POST", `/api/${s.id}/tapped`, { cookie: s.cookie });
  const at = setupRow(s.id).tapped_at;
  clock.skip(5_000);
  await api("POST", `/api/${s.id}/tapped`, { cookie: s.cookie });
  assert.equal(setupRow(s.id).tapped_at, at, "the first tap is the one that counts");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM web_setup_marks WHERE kind = 'tapped'").get().n, 1);
  await h.router.deliver(text(newNumber(), ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  assert.equal((await api("POST", `/api/${s.id}/tapped`, { cookie: s.cookie })).status, 404);
});

// ---------- an SMS reaches Reason like an iMessage ----------

test("an SMS-service webhook (a green first text) passes the Sendblue adapter and claims the setup like an iMessage", async () => {
  const SECRET = "whsec_first_text";
  Object.assign(config, { sendblueKeyId: "k", sendblueSecretKey: "s", sendblueFrom: LINE, sendblueWebhookSecret: SECRET, sendblueWebhookSecretHeader: "sb-signing-secret" });
  try {
    const h = harness();
    const inv = ownerLink();
    const s = await newSetup({ invite: inv.token });
    const num = newNumber();
    const sb = new SendblueChannel({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
    for (const service of ["SMS", "RCS"]) {
      const got = await sb.receive({ rawBody: JSON.stringify({ content: "x", is_outbound: false, status: "RECEIVED", message_handle: `H-${service}`, from_number: num, number: num, to_number: LINE, sendblue_number: LINE, service, group_id: "", media_url: "", message_type: "message", date_sent: new Date(clock.now()).toISOString() }), headers: { "sb-signing-secret": SECRET, "content-type": "application/json" } });
      assert.equal(got.status, 200);
      assert.equal(got.inbound.length, 1, `${service}: kept, not dropped`);
      assert.equal(got.inbound[0].service, service);
    }
    const first = await sb.receive({ rawBody: JSON.stringify({ content: ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code }), is_outbound: false, status: "RECEIVED", message_handle: "H-FIRST", from_number: num, number: num, to_number: LINE, service: "SMS", group_id: "", media_url: "", date_sent: new Date(clock.now()).toISOString() }), headers: { "sb-signing-secret": SECRET, "content-type": "application/json" } });
    await h.router.deliver({ ...first.inbound[0], channel: "fake" });
    const acct = db.getAccount(conv(num));
    assert.ok(acct, "account made from an SMS first text");
    assert.equal(acct.name, "Kofi");
    assert.equal(acct.contact_card_name, "Jarvis");
    assert.equal(inviteRow(inv.id).state, "redeemed");
    assert.equal((await status(s)).json.claimed, true);
  } finally {
    Object.assign(config, { sendblueKeyId: "", sendblueSecretKey: "", sendblueFrom: "", sendblueWebhookSecret: "", sendblueWebhookSecretHeader: "sb-signing-secret" });
  }
});

// ---------- i can text you first ----------

test("text-me-first end to end: one text from Reason's number, nothing spent; their reply claims, spends the invite once, makes the account with their names", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  const logs = [];
  const out = await textMe(h, s, `(${num.slice(2, 5)}) ${num.slice(5, 8)}-${num.slice(8)}`, { log: (l) => logs.push(l) });
  assert.equal(out.json.ok, true);
  assert.deepEqual(to(h, num).map(m => m.text), ["hey kofi, Jarvis here. Omari got you in. say anything back and we're off"]);
  assert.ok(!JSON.stringify(logs).includes(num.slice(-7)), "the number is never logged");
  assert.ok(!JSON.stringify(setupRow(s.id)).includes(num.slice(-7)), "the number is never stored");
  assert.equal(inviteRow(inv.id).state, "unused", "nothing spent before their reply");
  assert.equal(db.inviteAllowance(config.ownerConversation), 2);
  assert.equal(db.getAccount(conv(num)), null, "no account before their reply");
  // Their reply, any words.
  await h.router.deliver(text(num, "who's this?"));
  const acct = db.getAccount(conv(num));
  assert.ok(acct, "account made");
  assert.equal(acct.invited_by, config.ownerConversation);
  assert.equal(acct.name, "Kofi");
  assert.equal(acct.contact_card_name, "Jarvis");
  assert.equal(inviteRow(inv.id).state, "redeemed");
  assert.equal(inviteRow(inv.id).redeemed_by, conv(num));
  assert.equal(db.inviteAllowance(config.ownerConversation), 1, "one invite spent");
  assert.deepEqual(h.said.filter(x => x.c === config.ownerConversation).map(x => x.t), ["Kofi just joined with your invite 🎉"]);
  assert.equal((await status(s)).json.claimed, true);
  // A second reply is an ordinary turn: nothing is spent again.
  await h.router.deliver(text(num, "book a table friday"));
  assert.equal(db.inviteAllowance(config.ownerConversation), 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE state = 'redeemed'").get().n, 1);
});

test("text-me: the losing side of a race is told; the invite is spent once", async () => {
  const h = harness();
  const inv = ownerLink();
  const a = await newSetup({ invite: inv.token });
  const b = await newSetup({ invite: inv.token, user: "ama" });
  const numA = newNumber(), numB = newNumber();
  assert.equal((await textMe(h, a, numA)).json.ok, true);
  await h.router.deliver(text(numB, ws.firstText({ user: "ama", reasonName: "jarvis", code: b.code })));
  assert.ok(db.getAccount(conv(numB)));
  await h.router.deliver(text(numA, "hi"));
  assert.equal(db.getAccount(conv(numA)), null, "not let in on a spent invite");
  assert.ok(to(h, numA).some(m => /already|claimed|used/i.test(m.text ?? "")), "told it was claimed");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE state = 'redeemed'").get().n, 1);
});

test("text-me limits: switch off, no invite, no cookie, bad number, one number changed once, 2 per setup, 3 per invite", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  delete process.env.REASON_TEXT_ME_FIRST;
  assert.equal((await textMe(h, s, newNumber())).status, 404, "switch off: no such thing");
  assert.deepEqual((await status(s)).json.textMe, { available: false });
  process.env.REASON_TEXT_ME_FIRST = "on";
  const plain = await newSetup();
  assert.equal((await textMe(h, plain, newNumber())).json.why, "no_invite");
  assert.equal((await api("POST", `/api/${s.id}/text-me`, { body: { number: newNumber() }, router: h.router })).status, 404, "no cookie");
  for (const bad of ["+44 20 7946 0958", "12345", "+4155551234", "0155551234", "not a number", ""]) assert.equal((await textMe(h, s, bad)).json.why, "bad_number", bad);
  const first = newNumber(), second = newNumber(), third = newNumber();
  assert.equal((await textMe(h, s, first)).json.ok, true);
  assert.equal((await textMe(h, s, third.replace("+1", ""))).json.ok, true, "changed once");
  assert.equal((await textMe(h, s, second)).json.why, "no_more_changes");
  assert.equal(h.channel.sent.length, 2);
  assert.equal((await textMe(h, s, third)).json.why, "no_more_sends", "two per setup");
  const s2 = await newSetup({ invite: inv.token });
  assert.equal((await textMe(h, s2, newNumber())).json.ok, true, "third for the invite");
  const s3 = await newSetup({ invite: inv.token });
  assert.equal((await textMe(h, s3, newNumber())).json.why, "no_more_sends", "three per invite");
  assert.equal((await status(s3)).json.textMe.available, false);
  assert.equal(h.channel.sent.length, 3);
});

test("text-me caps: per address and for everybody, hourly, from env", async () => {
  process.env.REASON_TEXT_ME_IP_HOURLY = "1";
  process.env.REASON_TEXT_ME_HOURLY = "2";
  ws.resetLimits();
  moreLinks();
  const h = harness();
  const a = await newSetup({ invite: ownerLink().token });
  const b = await newSetup({ invite: ownerLink().token });
  const c = await newSetup({ invite: ownerLink().token });
  assert.equal((await textMe(h, a, newNumber(), { ip: "9.9.9.1" })).json.ok, true);
  const slow = await textMe(h, b, newNumber(), { ip: "9.9.9.1" });
  assert.equal(slow.status, 429);
  assert.equal(slow.json.why, "slow_down");
  assert.equal((await textMe(h, b, newNumber(), { ip: "9.9.9.2" })).json.ok, true);
  const busy = await textMe(h, c, newNumber(), { ip: "9.9.9.3" });
  assert.equal(busy.status, 429);
  assert.equal(busy.json.why, "busy");
  assert.equal(h.channel.sent.length, 2);
  clock.skip(61 * MIN);
  assert.equal((await textMe(h, c, newNumber(), { ip: "9.9.9.3" })).json.ok, true, "an hour later");
});

test("text-me: an existing account gets nothing (told to just text), a blocked number gets nothing; neither is linked", async () => {
  const h = harness();
  const s = await newSetup({ invite: ownerLink().token });
  const member = newNumber();
  db.upsertAccount({ conversationId: conv(member), channel: "fake", address: member, name: "Ama", isOperator: false });
  assert.equal((await textMe(h, s, member)).json.why, "has_account");
  const blocked = newNumber();
  db.db.prepare("INSERT INTO blocked_numbers (address, blocked_at) VALUES (?, ?)").run(blocked, clock.now());
  assert.equal((await textMe(h, s, blocked)).json.why, "cant_reach");
  assert.equal(h.channel.sent.length, 0);
  assert.equal(setupRow(s.id).textme_hash, null);
});

test("text-me on an inbound-only line: Sendblue's INBOUND_ONLY_PLAN refusal is said plainly, the number is not linked, it still counts", async () => {
  const h = harness({ channel: { failWith: "Sendblue refused it (HTTP 402): INBOUND_ONLY_PLAN" } });
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  const out = await textMe(h, s, num);
  assert.deepEqual(out.json, { ok: false, why: "cant_text_first" });
  assert.equal(setupRow(s.id).textme_hash, null, "not linked: nothing reached that number");
  assert.equal(setupRow(s.id).textme_sends, 1, "the try counts");
  config.autoAdmit = false;
  await h.router.deliver(text(num, "hi"));
  assert.equal(db.getAccount(conv(num)), null, "a later text from that number is a stranger's");
  assert.equal(inviteRow(inv.id).state, "unused");
});

test("text-me expiry: a reply after the setup's day gets today's stranger behaviour", async () => {
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const num = newNumber();
  assert.equal((await textMe(h, s, num)).json.ok, true);
  clock.skip(store.TTL_MS + 1000);
  config.autoAdmit = false;
  await h.router.deliver(text(num, "hey"));
  assert.equal(db.getAccount(conv(num)), null);
  assert.equal(inviteRow(inv.id).state, "unused", "nothing spent");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM access_requests").get().n, 1, "asked for access like any stranger");
});

// ---------- the inviter hears ----------

test("inviter: one line ten minutes after the tap with no first text; once per setup; never for a claimed one", async () => {
  toDay();
  moreLinks();
  const h = harness();
  const inv = ownerLink();
  const s = await newSetup({ invite: inv.token });
  const say = (c, t) => h.said.push({ c, t });
  await api("POST", `/api/${s.id}/tapped`, { cookie: s.cookie });
  clock.skip(9 * MIN);
  assert.equal(ws.nudgeInviters({ say }), 0, "not yet");
  clock.skip(MIN + 1000);
  assert.equal(ws.nudgeInviters({ say }), 1);
  assert.deepEqual(h.said.map(x => [x.c, x.t]), [[config.ownerConversation,
    "Kofi got to the last step, but their first text hasn't reached me yet. if it went as a green bubble it won't get to me, so tell them to tap the text button on that page again, or to ask me to text them first from the same page."]]);
  clock.skip(30 * MIN);
  assert.equal(ws.nudgeInviters({ say }), 0, "once per setup");
  // Claimed in time: nothing.
  const s2 = await newSetup({ invite: ownerLink().token });
  await api("POST", `/api/${s2.id}/tapped`, { cookie: s2.cookie });
  await h.router.deliver(text(newNumber(), ws.firstText({ user: "kofi", reasonName: "jarvis", code: s2.code })));
  clock.skip(11 * MIN);
  const before = h.said.length;
  assert.equal(ws.nudgeInviters({ say }), 0);
  assert.equal(h.said.filter(x => /last step/.test(x.t)).length, h.said.slice(0, before).filter(x => /last step/.test(x.t)).length);
  // Not an invite setup: nobody to tell. Switch off: nothing at all.
  const plain = await newSetup();
  await api("POST", `/api/${plain.id}/tapped`, { cookie: plain.cookie });
  clock.skip(11 * MIN);
  assert.equal(ws.nudgeInviters({ say }), 0);
  delete process.env.REASON_TEXT_ME_FIRST;
  const s3 = await newSetup({ invite: ownerLink().token });
  await api("POST", `/api/${s3.id}/tapped`, { cookie: s3.cookie });
  clock.skip(11 * MIN);
  toDay();
  assert.equal(ws.nudgeInviters({ say }), 1);
  assert.match(h.said.at(-1).t, /tap the text button on that page again\.$/, "without text-me-first, only the first way");
  process.env.REASON_WEB_SETUP = "off";
  const count = h.said.length;
  db.db.prepare("UPDATE web_setups SET nudged_at = NULL").run();
  assert.equal(ws.nudgeInviters({ say }), 0);
  assert.equal(h.said.length, count);
});

test("inviter: not in their night; their morning, if the text still has not come", async () => {
  toNight();
  const h = harness();
  const s = await newSetup({ invite: ownerLink().token });
  const say = (c, t) => h.said.push({ c, t });
  await api("POST", `/api/${s.id}/tapped`, { cookie: s.cookie });
  clock.skip(11 * MIN);
  assert.equal(ws.nudgeInviters({ say }), 0, "night");
  toDay();
  assert.equal(ws.nudgeInviters({ say }), 1, "morning");
});

// ---------- ops ----------

test("ops: setups finished vs first texts received, on the page and held for the digest; amber when none arrived", async () => {
  const h = harness();
  assert.equal(ops.holdFirstTexts(), null, "nothing finished: no digest line");
  const a = await newSetup(), b = await newSetup();
  await api("POST", `/api/${a.id}/tapped`, { cookie: a.cookie });
  await api("POST", `/api/${b.id}/tapped`, { cookie: b.cookie });
  assert.deepEqual(ops.firstTextCounts(), { day: { tapped: 2, arrived: 0 }, week: { tapped: 2, arrived: 0 } });
  let report = await ops.runChecks({ probe: async () => ({ ok: true }), usageFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  let row = report.checks.find(c => c.id === "first_texts");
  assert.equal(row.state, "warn");
  assert.equal(row.detail, "setups finished vs first texts received: 2 / 0 in the last day · 2 / 0 this week");
  await h.router.deliver(text(newNumber(), ws.firstText({ user: "kofi", reasonName: "jarvis", code: a.code })));
  report = await ops.runChecks({ probe: async () => ({ ok: true }), usageFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  row = report.checks.find(c => c.id === "first_texts");
  assert.equal(row.state, "ok");
  assert.equal(row.detail, "setups finished vs first texts received: 2 / 1 in the last day · 2 / 1 this week");
  ops.holdFirstTexts();
  ops.holdFirstTexts();
  const held = digest.pending().filter(r => r.key.startsWith("first_texts:"));
  assert.equal(held.length, 1, "one line a day, kept current");
  assert.match(held[0].text, /^Web setup: setups finished vs first texts received: 2 \/ 1/);
  clock.skip(2 * 24 * 60 * MIN);
  assert.deepEqual(ops.firstTextCounts(), { day: { tapped: 0, arrived: 0 }, week: { tapped: 2, arrived: 1 } });
  process.env.REASON_WEB_SETUP = "off";
  assert.equal(ops.firstTextCounts(), null, "switch off: no row");
  report = await ops.runChecks({ probe: async () => ({ ok: true }), usageFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(report.checks.find(c => c.id === "first_texts"), undefined);
});

// ---------- switch off ----------

test("web setup switch off: the new endpoints are not there, a code-less first text claims nothing, no inviter line", async () => {
  const h = harness();
  const s = await newSetup({ invite: ownerLink().token });
  const num = newNumber();
  assert.equal((await textMe(h, s, num)).json.ok, true);
  process.env.REASON_WEB_SETUP = "off";
  for (const p of ["status", "tapped", "text-me"]) assert.equal((await api(p === "status" ? "GET" : "POST", `/api/${s.id}/${p}`, { cookie: s.cookie, router: h.router })).status, 404, p);
  assert.equal(ws.claimFromText({ conversationId: conv(num), text: "hi", address: num }), null);
  assert.equal(ws.claimInviteFromText({ channel: "fake", address: num, text: "hi" }), null);
  config.autoAdmit = false;
  await h.router.deliver(text(num, "hi"));
  assert.equal(db.getAccount(conv(num)), null);
});

test("the words: no phrase handed to anybody to type, no link or number in Reason's first text, short", () => {
  const line = ws.textMeLine({ user: "kofi", reasonName: "jarvis", inviter: "Omari" });
  assert.ok(line.length <= 300);
  assert.ok(!/https?:|www\.|\d{3}/.test(line), "Sendblue's pre-reply rules: no links or numbers");
  assert.ok(!/\btype\b|"|“|reply with|text back the/i.test(line), "never a phrase to type");
  assert.equal(ws.textMeLine({ user: "k0fi http://x", reasonName: "<b>", inviter: "" }), "hey, Reason here. a friend got you in. say anything back and we're off", "names that are not names are left out");
  const nudge = ws.nudgeLine({ who: "Kofi", textMe: true });
  assert.ok(!/\btype\b|"|“/i.test(nudge), "the inviter is not handed a phrase either");
});
