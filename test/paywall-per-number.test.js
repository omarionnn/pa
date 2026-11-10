// One phone number = one trial and one grandfather decision across every texting line (security,
// 2026-11-08; audit leads src/plan.js:noteTurn:trial-counter-per-channel-conversation and
// src/plan.js:grandfathered:address-wide-invite-event-flag-from-second-channel-account).
// Same setup as test/paywall.test.js; a second line is the "other" channel on the same number.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-paywall-num-"));
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
/** One win on the record: a finished task (stamps.completions), so the ask goes at the 25th. */
function win(c) {
  db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at, finished_at) VALUES (?, 'w', 'w', 'done', 3, ?, ?, ?)").run(c, clock.now(), clock.now(), clock.now());
}
function fakeRouter() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { ok: true }; } };
}
const noSleep = async () => {};
/** 25 sessions, the ask gone after the 25th, then a 26th: lapsed. The way it really happens. */
async function lapse(c, router = fakeRouter()) {
  win(c);
  sessions(c, 25);
  const out = await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.equal(out.did, "asked");
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).status, "lapsed");
  return router;
}
const ctx = (c) => ({ conversationId: c, messages: [] });
const sign = (raw, { t = Math.floor(clock.now() / 1000), secret = process.env.STRIPE_WEBHOOK_SECRET } = {}) => ({ "stripe-signature": stripe.sign(raw, secret, t), "content-type": "application/json" });
const deliver = (event, opts = {}) => { const raw = JSON.stringify(event); return stripeWebhookRequest({ rawBody: raw, headers: opts.headers ?? sign(raw, opts), runtime: opts.runtime ?? null }); };
const otherLine = (num, name = "Ama") => { const c = `dm:other:${num}`; db.upsertAccount({ conversationId: c, channel: "other", address: num, name, isOperator: false }); return c; };

test("a lapsed walk-in texting the other line from the same number gets no fresh trial", async () => {
  const { c, num } = newcomer();
  const router = await lapse(c);
  await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  clock.skip(31 * MIN);
  const b = otherLine(num);
  accounts.countUse(b, "turn");
  assert.equal(plan.status(b).status, "lapsed", "the number's trial is over on every line");
  assert.ok(plan.blocked(b));
  assert.equal((await plan.gate(b, "timer_set"))?.blocked, "trial_over");
  assert.equal(plan.status(c).status, "lapsed");
});

test("the trial is counted once per number, whichever line the text comes in on", () => {
  const { c, num } = newcomer();
  sessions(c, 10);
  clock.skip(31 * MIN);
  const b = otherLine(num);
  sessions(b, 3);
  assert.equal(plan.status(b).sessions_used, 13);
  assert.equal(plan.status(c).sessions_used, 13);
  // Texts on both lines inside 30 minutes are one session.
  clock.skip(31 * MIN); accounts.countUse(c, "turn"); clock.skip(2 * MIN); accounts.countUse(b, "turn");
  assert.equal(plan.status(c).sessions_used, 14);
});

test("paid on one line is paid on every line of the number, and the hold and release reach both", async () => {
  const { c, num } = newcomer();
  const b = otherLine(num);
  const router = await lapse(c);
  await plan.afterTurn({ conversationId: c, router, sleep: noSleep });
  assert.ok(pause.isPaused(c), "held");
  assert.ok(pause.isPaused(b), "the other line is held too");
  const raw = JSON.stringify({ id: "evt_pn_1", type: "checkout.session.completed", data: { object: { client_reference_id: plan.refFor(b), customer: "cus_pn", subscription: "sub_pn" } } });
  assert.equal((await stripeWebhookRequest({ rawBody: raw, headers: sign(raw) })).status, 200);
  assert.equal(plan.status(c).status, "paid");
  assert.equal(plan.status(b).status, "paid");
  assert.ok(!pause.isPaused(c) && !pause.isPaused(b), "both released");
});

test("an invite redeemed on the other line by a number that already walked in does not make it free", () => {
  const { c: inviter } = newcomer("Inviter");
  db.db.prepare("UPDATE accounts SET created_at = 1 WHERE conversation_id = ?").run(inviter); // a member from before the flip
  const { c, num } = newcomer("Walk");
  sessions(c, 3);
  const made = db.createInvite(inviter);
  assert.ok(made.ok, JSON.stringify(made));
  const out = db.redeemInvite({ claimCode: made.invite.claim_code, channel: "other", address: num, name: "Walk" });
  assert.ok(out.ok, JSON.stringify(out));
  const b = out.account.conversation_id;
  assert.equal(plan.status(c).status, "trial", "still on the trial");
  assert.equal(plan.status(b).status, "trial", "the new line too");
  assert.equal(plan.status(b).sessions_used, 3);
});

test("an event join on the other line by a number that already walked in does not make it free", () => {
  const { c, num } = newcomer("Guesty");
  sessions(c, 3);
  const b = otherLine(num, "Guesty");
  db.db.prepare("UPDATE accounts SET joined_via_event = 1 WHERE conversation_id = ?").run(b);
  assert.equal(plan.status(c).status, "trial");
  assert.equal(plan.status(b).status, "trial");
});

test("unchanged: a number that came in by invite stays free on a line it adds later; a single-line walk-in is on the trial", () => {
  // The inviter is free for good (owner, 2026-11-09: a trial user's invite makes nobody free).
  const { c: inviter } = newcomer("Inviter2");
  db.db.prepare("UPDATE accounts SET created_at = 1 WHERE conversation_id = ?").run(inviter); // here before the flip: free for good
  const made = db.createInvite(inviter);
  const num = newNumber();
  const out = db.redeemInvite({ claimCode: made.invite.claim_code, channel: "fake", address: num, name: "Inv" });
  assert.ok(out.ok, JSON.stringify(out));
  clock.skip(MIN);
  const b = otherLine(num, "Inv");
  assert.equal(plan.status(out.account.conversation_id).status, "free");
  assert.equal(plan.status(b).status, "free");
  const { c: solo } = newcomer("Solo");
  sessions(solo, 2);
  assert.equal(plan.status(solo).status, "trial");
  assert.equal(plan.status(solo).sessions_used, 2);
});
