// The win rule (src/plan.js; owner, 2026-11-01, the pricing page's words): "Pay once it's done
// something real for you. First 25 conversations free. No win by conversation 25? The trial keeps going,
// up to 5 more."
//
//   a win = any finished errand on the record for that conversation (stamps.completions: a done task,
//   a call that got somewhere, an order placed)
//   25th session with a win: the three bubbles, as before
//   25th with no win: nothing said; the trial runs on a session at a time, up to the 30th
//   a win lands between the 25th and the 30th: the bubbles go on the very next inbound (same session or not)
//   30th with no win: the bubbles go anyway, with a softer first line
//   grandfathered people, owner mode and lapsing are untouched
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-paywall-win-"));
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
process.env.REASON_TOKEN_KEY = "45".repeat(32);
process.env.REASON_PAYWALL = "on";
process.env.REASON_PAYWALL_SHIP_TS = "2026-10-31T00:00:00Z";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_secret_for_tests";
process.env.STRIPE_PRICE_ID = "price_test_2499";
process.env.STRIPE_PAYMENT_LINK_URL = "";

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/checkout/sessions") return res.end(JSON.stringify({ id: "cs_w", url: `https://checkout.stripe.test/c/pay/cs_w#${form.client_reference_id}` }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise(r => fake.listen(0, "127.0.0.1", r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;

const plan = await import("../src/plan.js");
const accounts = await import("../src/accounts.js");
await import("../src/shopconnect.js"); // the shop_runs table (an order placed there is a win)
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OMARI = "dm:owner";
const MASTER = "+12025551234";
const TESTER = "+14155550100";
const MIN = 60_000;
let n = 0;
const newNumber = () => `+1646555${String(1000 + (n++)).slice(-4)}`;

after(() => { fake.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  config.autoAdmit = true;
  db.db.exec("DELETE FROM accounts; DELETE FROM plan; DELETE FROM stripe_events; DELETE FROM usage; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM tasks; DELETE FROM calls; DELETE FROM shop_runs; DELETE FROM ops_state WHERE k = 'paywall_ship_ts';");
  db.upsertAccount({ conversationId: OMARI, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function newcomer(name = "Ama") {
  const num = newNumber();
  const c = `dm:fake:${num}`;
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name, isOperator: false });
  return { c, num };
}
/** `k` sessions, 31 minutes apart, through the real countUse path. */
function sessions(c, k) {
  for (let i = 0; i < k; i++) { if (i) clock.skip(31 * MIN); accounts.countUse(c, "turn"); }
}
/** A text 2 minutes after the last: the same session. */
const sameSession = (c) => { clock.skip(2 * MIN); accounts.countUse(c, "turn"); };
/** A win: one finished task on the record (what stamps.completions counts). */
function taskDone(c) {
  db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at, finished_at) VALUES (?, 'w', 'w', 'done', 3, ?, ?, ?)").run(c, clock.now(), clock.now(), clock.now());
}
/** A win of another kind: a call that got what it was for. */
function callAnswered(c) {
  db.db.prepare("INSERT INTO calls (conversation_id, provider, to_number, goal, state, outcome_kind, created_at, updated_at, ended_at) VALUES (?, 'fake', '+12125551212', 'book a table', 'ended', 'confirmed', ?, ?, ?)").run(c, clock.now(), clock.now(), clock.now());
}
function fakeRouter() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { ok: true }; } };
}
const noSleep = async () => {};
const after_ = (c, router) => plan.afterTurn({ conversationId: c, router, sleep: noSleep });

test("what counts as a win: nothing on the record is no win; a done task or an answered call is one", () => {
  const { c } = newcomer();
  assert.equal(plan.hasWin(c), false);
  db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at) VALUES (?, 'open', 'open', 'running', 3, ?, ?)").run(c, clock.now(), clock.now());
  assert.equal(plan.hasWin(c), false, "a task still running is not a win");
  callAnswered(c);
  assert.equal(plan.hasWin(c), true);
  const other = newcomer().c;
  taskDone(other);
  assert.equal(plan.hasWin(other), true);
  assert.equal(plan.hasWin(newcomer().c), false, "somebody else's win is not theirs");
  // An order placed through a store checkout (shop_runs, the live buy path) is a win too — and one
  // still running is not.
  const shopper = newcomer().c;
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, stage, stage_at, created_at, updated_at) VALUES ('run_open', ?, 'ulta', 'cerave', 'buy', 'running', 'in_progress', ?, ?, ?)").run(shopper, clock.now(), clock.now(), clock.now());
  assert.equal(plan.hasWin(shopper), false);
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, stage, stage_at, created_at, updated_at) VALUES ('run_done', ?, 'ulta', 'cerave', 'buy', 'succeeded', 'placed', ?, ?, ?)").run(shopper, clock.now(), clock.now(), clock.now());
  assert.equal(plan.hasWin(shopper), true);
  assert.deepEqual(plan.wins(shopper).map(w => w.kind), ["purchase"]);
});

test("an order placed through a store checkout is the win that brings the ask at the 25th, and the first bubble says so", async () => {
  const { c } = newcomer("Ama");
  db.db.prepare("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, stage, stage_at, created_at, updated_at) VALUES ('run_a', ?, 'ulta', 'cerave', 'buy', 'succeeded', 'placed', ?, ?, ?)").run(c, clock.now(), clock.now(), clock.now());
  sessions(c, 25);
  const router = fakeRouter();
  assert.equal((await after_(c, router)).did, "asked");
  assert.equal(router.sent[0].text, "that's 25 chats between us, Ama. so far i've placed an order.");
});

test("a backlog past the 30th before any text under the switch: the label does not read as extended", () => {
  process.env.REASON_PAYWALL = "off";
  try {
    const { c } = newcomer();
    sessions(c, 40);
    process.env.REASON_PAYWALL = "on";
    assert.equal(plan.status(c).extended, false);
    assert.equal(plan.opsLabel(c), "trial 40/25");
  } finally { process.env.REASON_PAYWALL = "on"; }
});

test("a win before the 25th: the ask goes at the 25th, as before, counting 25 chats", async () => {
  const { c } = newcomer("Ama");
  taskDone(c);
  sessions(c, 24);
  const router = fakeRouter();
  assert.equal((await after_(c, router)).did, "nothing");
  assert.equal(plan.opsLabel(c), "trial 24/25");
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).ask_due, 1);
  assert.equal(plan.status(c).extended, false);
  assert.equal((await after_(c, router)).did, "asked");
  assert.equal(router.sent.length, 3);
  assert.match(router.sent[0].text, /^that's 25 chats between us, Ama\. so far i've finished 1 thing you asked for\.$/);
  assert.match(router.sent[2].text, /^https:\/\/checkout\.stripe\.test\//);
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).status, "lapsed", "the session after the ask lapses, as before");
});

test("no win at the 25th: nothing is said and the trial runs on, a session at a time", async () => {
  const { c } = newcomer();
  sessions(c, 25);
  const router = fakeRouter();
  assert.equal(plan.row(c).ask_due, 0, "no ask owed");
  assert.equal((await after_(c, router)).did, "nothing");
  assert.equal(router.sent.length, 0);
  const st = plan.status(c);
  assert.equal(st.status, "trial");
  assert.equal(st.extended, true);
  assert.equal(st.left, 5);
  assert.equal(st.trial_sessions, 30);
  assert.equal(plan.opsLabel(c), "trial 25/30 (no win yet)");
  assert.match(plan.note(c), /trial is running on, up to 30/);
  assert.match(plan.note(c), /Nothing has been said to them about paying/);
  assert.ok(!/just told/.test(plan.note(c)));
  assert.equal(plan.view(c).extended, true);
  assert.equal(plan.view(c).sessions_left, 5);
  // The 26th and 27th: still nothing, still free, never lapsed (no ask has gone).
  for (const k of [26, 27]) {
    clock.skip(31 * MIN); accounts.countUse(c, "turn");
    assert.equal(plan.row(c).sessions_used, k);
    assert.equal(plan.row(c).ask_due, 0, `no ask at ${k}`);
    assert.equal((await after_(c, router)).did, "nothing");
    assert.equal(plan.status(c).status, "trial");
    assert.ok(!plan.blocked(c));
    assert.equal(plan.opsLabel(c), `trial ${k}/30 (no win yet)`);
  }
  assert.equal(router.sent.length, 0);
});

test("a win lands at the 27th: the ask goes on the very next text, in the same session, counting 27 chats", async () => {
  const { c } = newcomer("Kofi");
  sessions(c, 27);
  const router = fakeRouter();
  assert.equal((await after_(c, router)).did, "nothing");
  // Reason finishes something for them mid-session; the turn that finished it does not pitch...
  callAnswered(c);
  assert.equal(plan.row(c).ask_due, 0, "the ask is owed by the NEXT inbound, not by the finishing itself");
  assert.equal((await after_(c, router)).did, "nothing");
  // ...their next text does, 2 minutes later, still the 27th session.
  sameSession(c);
  assert.equal(plan.row(c).sessions_used, 27);
  assert.equal(plan.row(c).ask_due, 1);
  assert.equal(plan.status(c).extended, false, "owed now, not extended");
  assert.match(plan.note(c), /just told/);
  const out = await after_(c, router);
  assert.equal(out.did, "asked");
  assert.equal(router.sent.length, 3);
  assert.match(router.sent[0].text, /^that's 27 chats between us, Kofi\. so far i've made 1 call that got an answer\.$/);
  assert.match(router.sent[1].text, /\$24\.99 a month/);
  // Once; a later text in the same session says nothing more; the next SESSION lapses them.
  sameSession(c);
  assert.equal((await after_(c, router)).did, "nothing");
  assert.equal(plan.status(c).status, "trial", "the 27th stays free after the ask");
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 28);
  assert.equal(plan.status(c).status, "lapsed");
  assert.ok(plan.blocked(c));
  assert.equal(plan.opsLabel(c), "lapsed");
});

test("no win through the 30th: the ask goes at the 30th anyway, with the softer first line; the 31st lapses", async () => {
  const { c } = newcomer("Ama");
  sessions(c, 29);
  const router = fakeRouter();
  assert.equal((await after_(c, router)).did, "nothing");
  assert.equal(plan.opsLabel(c), "trial 29/30 (no win yet)");
  assert.equal(plan.status(c).left, 1);
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 30);
  assert.equal(plan.row(c).ask_due, 1, "the 30th owes the ask whatever the record says");
  assert.equal((await after_(c, router)).did, "asked");
  assert.equal(router.sent.length, 3);
  assert.equal(router.sent[0].text, "that's 30 chats between us, Ama. i haven't pulled off something real for you yet, and i'd like the chance to.");
  assert.match(router.sent[1].text, /\$24\.99 a month/);
  assert.match(router.sent[1].text, /cancel any time/);
  assert.ok(!/unlock|upgrade/i.test(router.sent[0].text + router.sent[1].text));
  assert.match(router.sent[2].text, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(plan.status(c).status, "trial", "the 30th is still free");
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).status, "lapsed");
});

test("a bigger backlog: counted while the switch was off, 40 sessions and no win — asked on the first session under the paywall", async () => {
  process.env.REASON_PAYWALL = "off";
  try {
    const { c } = newcomer();
    sessions(c, 40);
    process.env.REASON_PAYWALL = "on";
    clock.skip(31 * MIN); accounts.countUse(c, "turn");
    assert.equal(plan.row(c).ask_due, 1);
    assert.equal((await after_(c, fakeRouter())).did, "asked");
  } finally { process.env.REASON_PAYWALL = "on"; }
});

test("grandfathered people are untouched by the rule: 30 sessions and no win, still free, nothing said, no extension shown", async () => {
  const tester = `dm:fake:${TESTER}`;
  db.upsertAccount({ conversationId: tester, channel: "fake", address: TESTER, name: "Kofi", isOperator: false });
  const old = `dm:fake:${newNumber()}`;
  db.upsertAccount({ conversationId: old, channel: "fake", address: "+13475559999", name: "Old", isOperator: false });
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(Date.parse("2026-10-20T00:00:00Z"), old);
  for (const c of [OMARI, tester, old]) {
    sessions(c, 30);
    const router = fakeRouter();
    assert.equal((await after_(c, router)).did, "nothing", c);
    assert.equal(router.sent.length, 0, c);
    assert.equal(plan.status(c).status, "free", c);
    assert.equal(plan.status(c).extended, false, c);
    assert.equal(plan.row(c).ask_due, 0, c);
    assert.equal(plan.opsLabel(c), "free", c);
    assert.equal(plan.note(c), "", c);
    clock.skip(31 * MIN); accounts.countUse(c, "turn");
    assert.equal(plan.status(c).status, "free", `${c}: a 31st session lapses nobody who is free`);
  }
});

test("REASON_PAYWALL=owner: the operator's own thread follows the rule (no win → runs on; a win → asked), nobody else is reached", async () => {
  process.env.REASON_PAYWALL = "owner";
  try {
    const { c } = newcomer();
    sessions(c, 30);
    assert.equal(plan.status(c).status, "off");
    assert.equal(plan.opsLabel(c), null);
    sessions(OMARI, 25);
    const router = fakeRouter();
    assert.equal((await after_(OMARI, router)).did, "nothing");
    assert.equal(plan.opsLabel(OMARI), "trial 25/30 (no win yet)");
    taskDone(OMARI);
    sameSession(OMARI);
    assert.equal((await after_(OMARI, router)).did, "asked");
    assert.match(router.sent[0].text, /^that's 25 chats between us, Omari\./);
  } finally { process.env.REASON_PAYWALL = "on"; }
});

test("scripts/plan-set.js: --last-inbound none puts the next text in a new session; the output says whether they have a win", async () => {
  const { run } = await import("../scripts/plan-set.js");
  const { c, num } = newcomer();
  sessions(c, 3);
  const shown = run([num]);
  assert.equal(shown.plan.win, false);
  const set = run([num, "trial", "--sessions", "24", "--last-inbound", "none", "--apply"]);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.after.row.sessions_used, 24);
  assert.equal(set.after.row.last_inbound_at, null);
  assert.equal(set.after.win, false);
  // The very next text (no 31-minute wait needed) is the 25th: no win, so nothing is owed.
  accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 25);
  assert.equal(plan.row(c).ask_due, 0);
  assert.equal(plan.opsLabel(c), "trial 25/30 (no win yet)");
  // Set back to 24 with a win on the record: the next text owes the ask.
  taskDone(c);
  const again = run([c, "trial", "--sessions", "24", "--last-inbound", "none", "--apply"]);
  assert.equal(again.after.win, true);
  accounts.countUse(c, "turn");
  assert.equal(plan.row(c).sessions_used, 25);
  assert.equal(plan.row(c).ask_due, 1);
  // A time is accepted too; nonsense is refused; the dry run changes nothing.
  const at = run([c, "trial", "--sessions", "10", "--last-inbound", "2026-11-01T17:00:00Z", "--apply"]);
  assert.equal(at.after.row.last_inbound_at, Date.parse("2026-11-01T17:00:00Z"));
  assert.equal(run([c, "trial", "--last-inbound", "yesterday-ish"]).ok, false);
  const dry = run([c, "trial", "--sessions", "0", "--last-inbound", "none"]);
  assert.equal(dry.dryRun, true);
  assert.equal(plan.row(c).sessions_used, 10);
});
