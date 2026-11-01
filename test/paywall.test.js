// The free trial and the subscription (src/plan.js, src/stripe.js, REASON_PAYWALL; owner's decisions
// 2026-10-31 23:09 ET): 25 sessions free, then $24.99 a month through Stripe.
//
//   a session starts 30 minutes after the last inbound (29 min is the same session, 31 is a new one)
//   the 25th session's reply still answers; then three bubbles, once, ever; the link last, on its own
//   grandfathered: the operator, REASON_TEST_NUMBERS, accounts from before the ship time — never asked
//   lapsed: questions answered, acting tools refused with the line + link once a session, things held
//   Stripe webhook: bad / stale signature 401; a good one acts once per event id; paid resumes + one line
//   cancel by text: at period end through Stripe, the end date said back
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-paywall-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TEST_NUMBERS = "+14155550100";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_PAYWALL = "on";
// Everybody made before this is free; the test's clock runs after it.
process.env.REASON_PAYWALL_SHIP_TS = "2026-10-31T00:00:00Z";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_secret_for_tests";
process.env.STRIPE_PRICE_ID = "price_test_2499";
process.env.STRIPE_PAYMENT_LINK_URL = "";

// ---------------------------------------------------------------- a fake Stripe on this machine
const stripeCalls = [];
let periodEnd = 1_800_000_000; // unix seconds, far enough ahead
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    stripeCalls.push({ method: req.method, path: req.url, auth: req.headers.authorization, form });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
      return res.end(JSON.stringify({ id: "cs_test_1", object: "checkout.session", url: `https://checkout.stripe.test/c/pay/cs_test_1#${form.client_reference_id}` }));
    }
    const sub = /^\/v1\/subscriptions\/([^/?]+)/.exec(req.url);
    if (sub && req.method === "POST") {
      return res.end(JSON.stringify({ id: decodeURIComponent(sub[1]), object: "subscription", status: "active", cancel_at_period_end: form.cancel_at_period_end === "true", current_period_end: periodEnd }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "no such route in the fake" } }));
  });
});
await new Promise(r => fake.listen(0, "127.0.0.1", r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;

const plan = await import("../src/plan.js");
const stripe = await import("../src/stripe.js");
const pause = await import("../src/pause.js");
const accounts = await import("../src/accounts.js");
const { runTool, toolsFor, lapsedBlocked } = await import("../src/tools.js");
const { stripeWebhookRequest } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OMARI = "dm:owner";
const MASTER = "+12025551234";
const TESTER = "+14155550100";
const MIN = 60_000;
let n = 0;
const newNumber = () => `+1347555${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => { fake.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  config.autoAdmit = true;
  stripeCalls.length = 0;
  db.db.exec("DELETE FROM accounts; DELETE FROM plan; DELETE FROM stripe_events; DELETE FROM usage; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM series; DELETE FROM ops_state WHERE k = 'paywall_ship_ts';");
  db.upsertAccount({ conversationId: OMARI, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

/** A person made now (after the ship time), with a thread so bubbles have an address. */
function newcomer(name = "Ama") {
  const num = newNumber();
  const c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name, isOperator: false });
  return { c, num };
}
/** `k` sessions, 31 minutes apart, through the real countUse path. */
function sessions(c, k) {
  for (let i = 0; i < k; i++) { if (i) clock.skip(31 * MIN); accounts.countUse(c, "turn"); }
}
function fakeRouter() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { ok: true }; } };
}
const noSleep = async () => {};
const ctx = (c) => ({ conversationId: c, messages: [] });
const sign = (raw, { t = Math.floor(clock.now() / 1000), secret = process.env.STRIPE_WEBHOOK_SECRET } = {}) => ({ "stripe-signature": stripe.sign(raw, secret, t), "content-type": "application/json" });
const deliver = (event, opts = {}) => { const raw = JSON.stringify(event); return stripeWebhookRequest({ rawBody: raw, headers: opts.headers ?? sign(raw, opts), runtime: opts.runtime ?? null }); };
const said = () => { const s = []; return { s, runtime: { say: (c, text) => s.push({ c, text }) } }; };

// ---------------------------------------------------------------- sessions

test("a session is a stretch of chat: 29 minutes later is the same one, 31 minutes later is a new one", () => {
  const { c } = newcomer();
  accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 1);
  clock.skip(29 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 1, "29 minutes on: still the first session");
  clock.skip(2 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 1, "the gap is from the LAST inbound, and 2 minutes is not 30");
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 2, "31 quiet minutes: a new session");
  // Three texts in a burst are one turn and one session; a refund is not a visit.
  accounts.countUse(c, "turn"); accounts.countUse(c, "turn", -1);
  assert.equal(plan.row(c).sessions_used, 2);
  assert.deepEqual(plan.status(c), { status: "trial", applies: true, sessions_used: 2, left: 23, paid_until: null, trial_sessions: 25 });
});

test("the 25th session owes the ask, exactly once; the 26th lapses", () => {
  const { c } = newcomer();
  sessions(c, 24);
  assert.equal(plan.row(c).ask_due, 0);
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 25);
  assert.equal(plan.row(c).ask_due, 1);
  assert.equal(plan.status(c).status, "trial", "the 25th session is still free");
  assert.match(plan.note(c), /last free session/);
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).status, "lapsed");
  assert.ok(plan.blocked(c));
});

// ---------------------------------------------------------------- the bubbles

test("after the 25th session's reply: what Reason did, the ask, the link — three bubbles, in order, once", async () => {
  const { c } = newcomer("Ama");
  // Something real on the record: two finished tasks, one reminder that fired, one call that got through.
  db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at, finished_at) VALUES (?, 'a', 'a', 'done', 3, ?, ?, ?), (?, 'b', 'b', 'done', 3, ?, ?, ?)").run(c, clock.now(), clock.now(), clock.now(), c, clock.now(), clock.now(), clock.now());
  db.db.prepare("INSERT INTO timers (conversation_id, fire_at, note, fired_at, created_at) VALUES (?, ?, 'water the plants', ?, ?)").run(c, clock.now(), clock.now(), clock.now());
  sessions(c, 25);
  const router = fakeRouter();
  const out = await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.equal(out.did, "asked");
  assert.equal(router.sent.length, 3, JSON.stringify(router.sent.map(m => m.text)));
  const [did, ask, link] = router.sent.map(m => m.text);
  assert.match(did, /^that's 25 chats between us, Ama\. so far i've /);
  assert.match(did, /finished 2 things you asked for/);
  assert.match(did, /sent 1 reminder on time/);
  assert.ok(!/0 /.test(did), "no zero is listed: " + did);
  assert.ok(!/call/.test(did), "no call got an answer, so calls are not mentioned: " + did);
  assert.match(ask, /\$24\.99 a month/);
  assert.match(ask, /cancel any time/);
  assert.ok(!/unlock|upgrade/i.test(ask + did), "no marketing words");
  assert.match(link, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1#/);
  assert.equal(router.sent[0].to, db.getAccount(c).address);
  assert.deepEqual(router.sent.map(m => m.idempotencyKey), [1, 2, 3].map(i => `paywall:ask:${c}#${i}`));
  // The Checkout Session was made for THIS person, in subscription mode, with the price.
  const made = stripeCalls.find(x => x.path === "/v1/checkout/sessions");
  assert.equal(made.form.mode, "subscription");
  assert.equal(made.form["line_items[0][price]"], "price_test_2499");
  assert.equal(made.form.client_reference_id, plan.refFor(c));
  assert.equal(plan.conversationOfRef(made.form.client_reference_id), c);
  assert.equal(made.form.success_url, "https://reason.example.test/pay/done");
  // The model's history carries what was said, so the next turn knows.
  assert.match(db.loadConversation(c).at(-1).content, /\$24\.99/);
  // Once, ever.
  const again = await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.equal(again.did, "nothing");
  assert.equal(router.sent.length, 3);
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.equal(router.sent.filter(m => /25 chats/.test(m.text)).length, 1);
});

test("nothing done yet: the first bubble still thanks them and lists nothing", () => {
  const [first] = plan.askBubbles({ counts: { calls: 0, orders: 0, tasks: 0, reminders: 0, events: 0 }, url: "https://x" });
  assert.equal(first, "that's 25 chats between us. thanks for giving me a real go.");
  assert.equal(plan.recapLine({ calls: 1, orders: 2, tasks: 0, reminders: 0, events: 1 }), "made 1 call that got an answer, placed 2 orders and set up an event");
});

test("the 25th session's own reply goes first, then the bubbles, down the real router", async () => {
  const num = newNumber();
  const c = conv(num);
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ text: t }) => { turns.push({ t, sentSoFar: channel.sent.length }); return "on it"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  const channel = router.register(new FakeChannel({ number: "+16562167455" }));
  runtime.turnExtras.channels = router;
  const text = (body) => ({ channel: "fake", externalId: `m${Math.random()}`, from: num, text: body, at: clock.now() });
  await router.deliver(text("hey"));
  assert.equal(plan.row(c).sessions_used, 1);
  for (let i = 1; i < 25; i++) { clock.skip(31 * MIN); await router.deliver(text(`msg ${i}`)); }
  // The contact-card offer after a first reply is its own feature (src/contact.js); not what this proves.
  const mine = channel.sent.filter(m => m.to === num && !/save me as a contact/.test(m.text)).map(m => m.text);
  assert.equal(plan.row(c).sessions_used, 25);
  assert.equal(turns.length, 25, "every session got its real turn, the 25th included");
  // The bubbles are the last three things sent, and none of them existed when the 25th turn ran.
  assert.equal(mine.filter(t => /25 chats/.test(t)).length, 1);
  assert.equal(turns.at(-1).sentSoFar, channel.sent.length - 3, "the 25th turn ran before the three bubbles went");
  assert.match(mine.at(-3), /25 chats/);
  assert.match(mine.at(-2), /\$24\.99/);
  assert.match(mine.at(-1), /^https:\/\//);
  assert.ok(plan.row(c).asked_at);
});

// ---------------------------------------------------------------- grandfather

test("the operator, a test number and anybody from before the ship time are free: never asked, never lapsed", () => {
  const tester = conv(TESTER);
  db.upsertAccount({ conversationId: tester, channel: "fake", address: TESTER, name: "Kofi", isOperator: false });
  const old = conv(newNumber());
  db.upsertAccount({ conversationId: old, channel: "fake", address: "+13475559999", name: "Old", isOperator: false });
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(Date.parse("2026-10-20T00:00:00Z"), old);
  for (const c of [OMARI, tester, old]) {
    sessions(c, 27);
    assert.equal(plan.status(c).status, "free", c);
    assert.equal(plan.row(c).ask_due, 0, c);
    assert.ok(!plan.blocked(c), c);
    assert.equal(plan.note(c), "", c);
    assert.ok(!toolsFor(c).some(t => t.name === "subscription_show"), `${c} is not shown a plan tool`);
    assert.equal(plan.opsLabel(c), "free");
  }
  const { c: fresh } = newcomer();
  sessions(fresh, 3);
  assert.ok(toolsFor(fresh).some(t => t.name === "subscription_show"), "a newcomer sees the plan tools");
  assert.equal(plan.opsLabel(fresh), "trial 3/25");
});

test("REASON_PAYWALL=owner reaches only the operator, and skips his grandfather rules so he can try it", async () => {
  process.env.REASON_PAYWALL = "owner";
  try {
    const { c } = newcomer();
    sessions(c, 27);
    assert.equal(plan.status(c).status, "off", "everyone else is untouched");
    assert.ok(!plan.blocked(c));
    assert.equal(plan.opsLabel(c), null);
    sessions(OMARI, 26);
    assert.equal(plan.status(OMARI).status, "lapsed");
    assert.ok(toolsFor(OMARI).some(t => t.name === "subscription_show"));
  } finally { process.env.REASON_PAYWALL = "on"; }
});

test("REASON_PAYWALL=off: sessions are counted, nothing else", async () => {
  process.env.REASON_PAYWALL = "off";
  try {
    const { c } = newcomer();
    sessions(c, 27);
    assert.equal(plan.row(c).sessions_used, 27);
    assert.equal(plan.row(c).status, "trial");
    assert.equal(plan.status(c).status, "off");
    assert.ok(!plan.blocked(c));
    const router = fakeRouter();
    assert.equal((await plan.afterTurn({ conversationId: c, router, sleep: noSleep })).did, "nothing");
    assert.equal(router.sent.length, 0);
    assert.equal(await plan.gate(c, "timer_set"), null);
    assert.ok(!toolsFor(c).some(t => t.name === "subscription_show"));
    assert.equal(plan.note(c), "");
    assert.equal(plan.opsLabel(c), null);
    assert.equal(db.opsGet("paywall_ship_ts"), null, "the ship time is not written while off");
  } finally { process.env.REASON_PAYWALL = "on"; }
});

test("the ship time: the env wins; otherwise it is written once, the first time the switch is seen on", () => {
  const saved = process.env.REASON_PAYWALL_SHIP_TS;
  try {
    assert.equal(plan.shipTs(), Date.parse("2026-10-31T00:00:00Z"));
    process.env.REASON_PAYWALL_SHIP_TS = "";
    const first = plan.shipTs();
    assert.ok(Math.abs(first - clock.now()) < 2_000, "written now");
    clock.skip(5 * MIN);
    assert.equal(plan.shipTs(), first, "kept, not moved");
  } finally { process.env.REASON_PAYWALL_SHIP_TS = saved; }
});

// ---------------------------------------------------------------- lapsed

test("lapsed: plain tools still run; acting tools are refused with the line and the link once a session, then only 'can't'", async () => {
  const { c } = newcomer();
  sessions(c, 26);
  assert.ok(plan.blocked(c));
  assert.match(plan.note(c), /PLAN: their 25 free sessions are used up/);
  // Reading and talking stay.
  const show = await runTool("subscription_show", {}, ctx(c));
  assert.equal(show.ok, true);
  assert.equal(show.status, "lapsed");
  assert.equal((await runTool("caps_show", {}, ctx(c))).ok, true);
  assert.notEqual((await runTool("timer_list", {}, ctx(c))).ok, false);
  // Acting is refused, before any yes is asked for.
  const first = await runTool("timer_set", { note: "water the plants", fire_at: new Date(clock.now() + 3_600_000).toISOString() }, ctx(c));
  assert.equal(first.ok, false);
  assert.equal(first.blocked, "trial_over");
  assert.match(first.error, /25 free sessions are used up/);
  assert.match(first.error, /\$24\.99 a month/);
  assert.match(first.pay_url, /^https:\/\/checkout\.stripe\.test\//);
  assert.ok(first.error.includes(first.pay_url), "the link is in what the model is told to say");
  assert.equal(db.listTimers(c).length, 0, "nothing was set");
  // The second refusal in the same session: no price, no link, no repeat.
  const second = await runTool("call_place", { to: "+12125551212", goal: "book a table" }, ctx(c));
  assert.equal(second.blocked, "trial_over");
  assert.equal(second.pay_url, null);
  assert.match(second.error, /ALREADY told this session/);
  assert.ok(!/\$24\.99/.test(second.error));
  // A new session: told once more.
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  const third = await runTool("research", { question: "best hiking boots" }, ctx(c));
  assert.equal(third.blocked, "trial_over");
  assert.match(third.error, /\$24\.99 a month/);
  // Which tools the gate covers.
  for (const name of ["call_place", "timer_set", "research", "directions", "store_checkout", "shop_pay", "event_create", "message_send", "browser_open", "purchase", "page_create", "todo_approve", "resume_everything"]) assert.ok(lapsedBlocked(name), name);
  for (const name of ["recall", "subscription_show", "subscription_cancel", "timer_list", "caps_show", "event_list", "shop_status", "memory_search", "my_name"]) assert.ok(!lapsedBlocked(name), name);
});

test("lapsed: their standing things are held after the turn, reminders wait unfired, nothing proactive goes", async () => {
  const { c } = newcomer();
  db.createTimer(c, { fireAt: clock.now() + 60 * MIN, note: "gym" });
  db.createSeries(c, { what: "check-in", rule: { every: "day" }, tz: "America/New_York", nextAt: clock.now() + 3_600_000 });
  sessions(c, 25);
  const router = fakeRouter();
  assert.equal((await plan.afterTurn({ conversationId: c, router, sleep: noSleep })).did, "asked");
  assert.ok(!pause.isPaused(c), "the ask holds nothing: the 25th session is still free");
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  const out = await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.equal(out.did, "nothing", "no bubbles on a lapse: the tool's one line does the asking");
  assert.equal(router.sent.length, 3);
  assert.ok(pause.isPaused(c), "held");
  assert.ok(plan.row(c).held_at > 0);
  assert.equal(db.listSeries(c)[0].state, "paused");
  // Held once, not again.
  await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE conversation_id = ? AND action = 'pause_everything'").get(c).n, 1);
  // The reminder comes due and stays due: not fired, not dropped.
  clock.skip(61 * MIN);
  const runtime = new Runtime({ runTurn: async () => "reminder!" });
  assert.equal(await runtime.tick(), 0);
  const t = db.listTimers(c)[0];
  assert.equal(t.fired_at, null);
  assert.equal(t.cancelled_at, null);
  assert.equal(runtime.mayInterrupt(c), false);
});

test("a pause they asked for themselves before lapsing is left alone by the hold and by the payment", async () => {
  const { c } = newcomer();
  sessions(c, 3);
  pause.pauseAll({ conversationId: c, said: "pause everything" });
  clock.skip(31 * MIN); sessions(c, 23); // 26 sessions in all
  assert.ok(plan.blocked(c));
  await plan.afterTurn({ conversationId: c, router: fakeRouter(), sleep: noSleep });
  assert.equal(plan.row(c).held_at, -1, "noted: not ours to release");
  await plan.markPaid(c, { subscriptionId: "sub_x" });
  assert.ok(pause.isPaused(c), "their own pause stands");
  assert.equal(plan.row(c).held_at, null);
});

// ---------------------------------------------------------------- the webhook

const checkoutDone = (c, { id = "evt_1", customer = "cus_1", subscription = "sub_1" } = {}) => ({
  id, object: "event", type: "checkout.session.completed",
  data: { object: { id: "cs_test_1", object: "checkout.session", client_reference_id: plan.refFor(c), customer, subscription, mode: "subscription" } },
});

test("the webhook refuses a missing, wrong or stale signature, and a body that will not read", async () => {
  const { c } = newcomer();
  const raw = JSON.stringify(checkoutDone(c));
  assert.equal((await stripeWebhookRequest({ rawBody: raw, headers: {} })).status, 401);
  assert.equal((await stripeWebhookRequest({ rawBody: raw, headers: sign(raw, { secret: "whsec_wrong" }) })).status, 401);
  assert.equal((await stripeWebhookRequest({ rawBody: raw, headers: sign(raw, { t: Math.floor(clock.now() / 1000) - 10 * 60 }) })).status, 401, "ten minutes old");
  const tampered = raw.replace("sub_1", "sub_2");
  assert.equal((await stripeWebhookRequest({ rawBody: tampered, headers: sign(raw) })).status, 401, "signed over a different body");
  assert.equal((await stripeWebhookRequest({ rawBody: "{nope", headers: sign("{nope") })).status, 400);
  assert.equal(plan.status(c).status, "trial", "nothing changed");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").get().n, 0);
  // Stripe rolls secrets with two v1s in one header: either matching is enough.
  const two = { "stripe-signature": `${stripe.sign(raw, "whsec_old")},v1=${stripe.sign(raw, process.env.STRIPE_WEBHOOK_SECRET).split("v1=")[1]}` };
  assert.equal((await stripeWebhookRequest({ rawBody: raw, headers: two })).status, 200);
});

test("paid: checkout.session.completed marks them paid, releases what was held, says one line — and a redelivery does nothing twice", async () => {
  const { c } = newcomer();
  sessions(c, 26);
  await plan.afterTurn({ conversationId: c, router: fakeRouter(), sleep: noSleep });
  assert.ok(pause.isPaused(c));
  const { s, runtime } = said();
  const r = await deliver(checkoutDone(c), { runtime });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(plan.status(c).status, "paid");
  assert.equal(plan.row(c).stripe_customer_id, "cus_1");
  assert.equal(plan.row(c).stripe_subscription_id, "sub_1");
  assert.ok(!pause.isPaused(c), "released");
  assert.equal(plan.row(c).held_at, null);
  assert.equal(s.length, 1);
  assert.equal(s[0].c, c);
  assert.match(s[0].text, /you're all set/);
  assert.ok(!plan.blocked(c));
  assert.equal(await plan.gate(c, "timer_set"), null);
  assert.ok((await runTool("timer_set", { note: "gym", fire_at: new Date(clock.now() + 3_600_000).toISOString() }, ctx(c))).ok);
  // The same event id again: 200, duplicate, nothing said, nothing changed.
  const again = await deliver(checkoutDone(c), { runtime });
  assert.deepEqual(again.body, { ok: true, duplicate: true });
  assert.equal(s.length, 1);
  assert.equal(plan.opsLabel(c), "paid");
  // The paid period comes with the invoice.
  await deliver({ id: "evt_2", type: "invoice.paid", data: { object: { object: "invoice", customer: "cus_1", subscription: "sub_1", lines: { data: [{ period: { end: periodEnd } }] } } } }, { runtime });
  assert.equal(plan.row(c).paid_until, periodEnd * 1000);
  assert.equal(s.length, 1, "a renewal is not announced");
  const view = await runTool("subscription_show", {}, ctx(c));
  assert.equal(view.status, "paid");
  assert.equal(view.next_bill, plan.when(periodEnd * 1000, c));
});

test("an event for nobody we know is taken (200) and does nothing", async () => {
  const r = await deliver({ id: "evt_x", type: "checkout.session.completed", data: { object: { client_reference_id: plan.refFor("dm:fake:+10000000000"), customer: "cus_z", subscription: "sub_z" } } });
  assert.deepEqual(r.body, { ok: true, matched: false });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM plan WHERE stripe_customer_id = 'cus_z'").get().n, 0);
});

test("subscription.updated with cancel_at_period_end keeps access until the date; deleted lapses and holds again", async () => {
  const { c } = newcomer();
  sessions(c, 2);
  const { s, runtime } = said();
  await deliver(checkoutDone(c), { runtime });
  await deliver({ id: "evt_u", type: "customer.subscription.updated", data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: true, current_period_end: periodEnd } } }, { runtime });
  assert.equal(plan.status(c).status, "cancelled");
  assert.ok(!plan.blocked(c), "still has access");
  assert.equal(plan.opsLabel(c), `cancelled · until ${plan.when(periodEnd * 1000, c)}`);
  assert.match(plan.note(c), /cancelled; everything keeps working until/);
  await deliver({ id: "evt_d", type: "customer.subscription.deleted", data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "canceled", current_period_end: periodEnd } } }, { runtime });
  assert.equal(plan.status(c).status, "lapsed");
  assert.ok(pause.isPaused(c), "held again");
  assert.equal(s.length, 2);
  assert.match(s[1].text, /plan's ended/);
  // Paying again brings it all back, and says so.
  await deliver(checkoutDone(c, { id: "evt_again", subscription: "sub_2" }), { runtime });
  assert.equal(plan.status(c).status, "paid");
  assert.ok(!pause.isPaused(c));
  assert.equal(s.length, 3);
});

// ---------------------------------------------------------------- cancel by text

test("subscription_cancel stops the renewal at the period's end through Stripe and says when access ends", async () => {
  const { c } = newcomer();
  sessions(c, 2);
  await deliver(checkoutDone(c));
  const out = await runTool("subscription_cancel", {}, ctx(c));
  assert.equal(out.ok, true, JSON.stringify(out));
  const call = stripeCalls.find(x => /^\/v1\/subscriptions\/sub_1/.test(x.path));
  assert.equal(call.method, "POST");
  assert.equal(call.form.cancel_at_period_end, "true");
  assert.equal(call.auth, "Bearer sk_test_fake");
  assert.equal(out.access_until, plan.when(periodEnd * 1000, c));
  assert.match(out.note, /nothing more is charged/);
  assert.equal(plan.status(c).status, "cancelled");
  assert.equal(plan.row(c).paid_until, periodEnd * 1000);
  const show = await runTool("subscription_show", {}, ctx(c));
  assert.equal(show.status, "cancelled");
  assert.equal(show.access_until, out.access_until);
  // Twice: already cancelled, no second call to Stripe.
  const before = stripeCalls.length;
  const twice = await runTool("subscription_cancel", {}, ctx(c));
  assert.equal(twice.already, true);
  assert.equal(stripeCalls.length, before);
});

test("cancelling on the trial, or as somebody Reason is free for, changes nothing and says why", async () => {
  const { c } = newcomer();
  sessions(c, 4);
  const out = await runTool("subscription_cancel", {}, ctx(c));
  assert.equal(out.ok, false);
  assert.match(out.error, /free trial \(4 of 25 sessions used\)/);
  assert.equal(stripeCalls.filter(x => /subscriptions/.test(x.path)).length, 0);
  const free = await runTool("subscription_cancel", {}, ctx(OMARI));
  assert.equal(free.ok, false);
  assert.equal(free.blocked, "not_available");
});

test("a payment link set by the owner is the pay link, carrying who it is for; no Checkout Session is made", async () => {
  process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/test_abc";
  try {
    const { c } = newcomer();
    const url = await plan.payLink(c);
    assert.equal(url, `https://buy.stripe.com/test_abc?client_reference_id=${plan.refFor(c)}`);
    assert.equal(stripeCalls.length, 0);
    assert.match(plan.refFor(c), /^[A-Za-z0-9_-]+$/, "a Payment Link's client_reference_id allows only these");
  } finally { process.env.STRIPE_PAYMENT_LINK_URL = ""; }
});

test("with no Stripe set up the ask is held for a later turn rather than sent without a link", async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "";
  try {
    const { c } = newcomer();
    sessions(c, 25);
    const router = fakeRouter();
    const out = await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
    assert.equal(out.did, "ask_held");
    assert.equal(router.sent.length, 0);
    assert.equal(plan.row(c).ask_due, 1, "still owed");
    assert.equal(plan.row(c).asked_at, null);
  } finally { process.env.STRIPE_SECRET_KEY = key; }
});

test("scripts/plan-set.js sets a plan by hand, dry run first", async () => {
  const { run } = await import("../scripts/plan-set.js");
  const { c, num } = newcomer();
  sessions(c, 26);
  assert.equal(plan.status(c).status, "lapsed");
  const dry = run([num, "free"]);
  assert.equal(dry.dryRun, true);
  assert.equal(plan.status(c).status, "lapsed", "a dry run changes nothing");
  const done = run([num, "free", "--apply"]);
  assert.equal(done.dryRun, false);
  assert.equal(plan.status(c).status, "free");
  assert.ok(!plan.blocked(c));
  run([c, "trial", "--sessions", "0", "--apply"]);
  assert.equal(plan.row(c).sessions_used, 0);
  assert.equal(plan.status(c).status, "trial");
  assert.equal(run(["+19999999999", "free"]).ok, false);
  assert.ok(run(["--list"]).people.some(p => p.conversation === c));
});
