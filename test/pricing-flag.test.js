// Reason is free for everyone for now (owner, 2026-11-05). ONE switch, REASON_PAYWALL, off:
//   off  — nobody sees a price, a trial, a session count or a way to pay: not in the tools the model is
//          given, not in what it is told it can do, not in its per-turn note; /pay/* sends people home;
//          Stripe's webhook acts on nothing; nothing is counted.
//   on   — the cut-off is the flip moment: an account made before it is free for good, one made after
//          it gets the trial, whatever stale REASON_PAYWALL_SHIP_TS is in .env.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pricing-flag-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_TOKEN_KEY = "55".repeat(32);
process.env.REASON_PAYWALL = "off";
process.env.REASON_PAYWALL_SHIP_TS = "1793500000000"; // what live .env still carries (Oct 31)
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake_pricing_flag";
process.env.STRIPE_PRICE_ID = "price_test_2499";

const plan = await import("../src/plan.js");
const stripe = await import("../src/stripe.js");
const accounts = await import("../src/accounts.js");
const { toolsFor, capabilitiesNow, runTool } = await import("../src/tools.js");
const { createServer, stripeWebhookRequest } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
let n = 0;
function person(name) {
  const num = `+1347666${String(1000 + n++).slice(-4)}`;
  const c = `dm:fake:${num}`;
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name, isOperator: false });
  return c;
}
function sessions(c, k) { for (let i = 0; i < k; i++) { clock.skip(31 * MIN); accounts.countUse(c, "turn"); } }

// Words that would tell somebody Reason costs money. Merchant-subscription tools (subscription_list,
// subscription_cancel_start…) talk about THEIR subscriptions and are fine; Reason's own plan is not.
const PRICE_WORDS = /\$24\.99|24\.99|free sessions|free trial|25 (free )?(sessions|conversations)|reason subscription|reason'?s own plan|subscription_show|\bsubscription_cancel\b(?!_)/i;

test("off: the model is given no plan tool, no price, no trial — in tools, capabilities and the turn note", async () => {
  const c = person("Ama");
  sessions(c, 30);
  const tools = toolsFor(c);
  assert.ok(!tools.some(t => t.name === "subscription_show" || t.name === "subscription_cancel"));
  const hits = tools.filter(t => PRICE_WORDS.test(JSON.stringify(t))).map(t => t.name);
  assert.deepEqual(hits, [], "tool descriptions mention Reason's price or trial");
  const caps = JSON.stringify(capabilitiesNow({ conversationId: c }));
  assert.ok(!PRICE_WORDS.test(caps), "capabilities mention Reason's price or trial");
  assert.equal(plan.note(c), "");
  assert.equal(plan.row(c), null, "nothing counted");
  assert.equal(plan.opsLabel(c), null);
  const named = await runTool("subscription_show", {}, { conversationId: c, messages: [] });
  assert.ok(!/24\.99|trial/i.test(JSON.stringify(named)), "naming the tool anyway says nothing about a price");
});

test("off: /pay/done and /pay/back send people to the home page, no page about paying", async () => {
  const server = createServer({ router: null, runtime: null, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    for (const p of ["/pay/done", "/pay/back"]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: "manual" });
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.get("location"), "https://heyreason.com/", p);
      const body = await res.text();
      assert.ok(!/charged|all set|link/i.test(body), p);
    }
  } finally { server.close(); }
});

test("off: a real Stripe event (an old test subscription) marks nobody paid and texts nobody", async () => {
  const c = person("Kojo");
  const event = { id: "evt_off_1", type: "checkout.session.completed", data: { object: { client_reference_id: plan.refFor(c), customer: "cus_1", subscription: "sub_1" } } };
  const raw = JSON.stringify(event);
  const said = [];
  const out = await stripeWebhookRequest({ rawBody: raw, headers: { "stripe-signature": stripe.sign(raw, process.env.STRIPE_WEBHOOK_SECRET, Math.floor(clock.now() / 1000)) }, runtime: { say: (to, text) => said.push({ to, text }) } });
  assert.equal(out.status, 200);
  assert.equal(said.length, 0);
  assert.equal(plan.row(c), null);
});

test("flip on: accounts from before the flip stay free for good; an account made after it gets the trial", async () => {
  const before = person("Before");          // joined while Reason was free
  sessions(before, 3);
  clock.skip(MIN);
  process.env.REASON_PAYWALL = "on";
  try {
    const flip = plan.onSince();             // boot with the switch on records it
    assert.ok(Math.abs(flip - clock.now()) < 2_000);
    assert.equal(plan.shipTs(), flip, "the Oct 31 value in .env cannot pull the cut-off back");
    clock.skip(MIN);
    const after_ = person("After");
    sessions(before, 30); sessions(after_, 2);
    assert.equal(plan.status(before).status, "free");
    assert.ok(!toolsFor(before).some(t => t.name === "subscription_show"));
    assert.equal(plan.status(after_).status, "trial");
    assert.equal(plan.status(after_).sessions_used, 2, "counted from the flip, not before");
    assert.ok(toolsFor(after_).some(t => t.name === "subscription_show"), "the newcomer is shown the plan");
  } finally { process.env.REASON_PAYWALL = "off"; }
});

test("flip on: a pre-flip person whose number moves to another channel after the flip stays free", async () => {
  const old = person("Mover");               // account on channel `fake`, dated before the flip recorded above
  const num = db.getAccount(old).address;
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(plan.onSince() - 60 * MIN, old);
  process.env.REASON_PAYWALL = "on";
  try {
    clock.skip(MIN);
    const moved = `dm:other:${num}`;
    db.upsertAccount({ conversationId: moved, channel: "other", address: num, name: "Mover", isOperator: false });
    assert.ok(db.getAccount(moved).created_at > plan.shipTs(), "the new channel's account is after the flip");
    sessions(moved, 2);
    assert.equal(plan.status(moved).status, "free");
    assert.ok(!toolsFor(moved).some(t => t.name === "subscription_show"));
  } finally { process.env.REASON_PAYWALL = "off"; }
});

// Owner, 2026-11-05: anybody who joins through an invite is free for good, whenever they join; only
// people who come in on their own (ads, website, texting the number) get the trial after the flip.
// Owner, 2026-11-09: only when the inviter / organizer is free for good themselves (test/free-tier-monthly.test.js
// has the trial inviter's case).
test("flip on: invited after the flip → free; joined via a member's event after the flip → free; uninvited after the flip → trial", async () => {
  const inviter = person("Inviter");
  db.db.prepare("UPDATE accounts SET created_at = 1 WHERE conversation_id = ?").run(inviter); // here before the flip: free for good
  process.env.REASON_PAYWALL = "on";
  try {
    clock.skip(MIN);
    const flip = plan.shipTs();
    const made = db.createInvite(inviter);
    assert.ok(made.ok, JSON.stringify(made));
    const inv = made.invite;
    const invitedNum = `+1347666${String(1000 + n++).slice(-4)}`;
    const out = db.redeemInvite({ claimCode: inv.claim_code, channel: "fake", address: invitedNum, name: "Invited" });
    assert.ok(out.ok, JSON.stringify(out));
    const invited = out.account.conversation_id;
    assert.ok(db.getAccount(invited).created_at > flip, "joined after the flip");
    sessions(invited, 30);
    assert.equal(plan.status(invited).status, "free");
    assert.ok(!toolsFor(invited).some(t => t.name === "subscription_show"));
    assert.equal(plan.note(invited), "");
    // Same invitee's number on another channel later: still free.
    const moved = `dm:other:${invitedNum}`;
    db.upsertAccount({ conversationId: moved, channel: "other", address: invitedNum, name: "Invited", isOperator: false });
    assert.equal(plan.status(moved).status, "free");

    // An event made by somebody free for good (the inviter, here before the flip): its guests are free.
    const evAt = Date.now();
    const evId = db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, tz, password_hash, organizer_token, created_at, updated_at)
      VALUES (?, ?, 'Party', 'party', 'America/New_York', 'x', ?, ?, ?)`).run(`pf-${evAt}`, inviter, `tok-${evAt}`, evAt, evAt).lastInsertRowid;
    const guest = person("Guest");
    db.db.prepare("UPDATE accounts SET joined_via_event = ? WHERE conversation_id = ?").run(evId, guest);
    assert.equal(plan.status(guest).status, "free");

    const walkIn = person("WalkIn");         // texted the number from an ad: no invite, no event
    assert.ok(db.getAccount(walkIn).created_at > flip);
    sessions(walkIn, 2);
    assert.equal(plan.status(walkIn).status, "trial");
    assert.ok(toolsFor(walkIn).some(t => t.name === "subscription_show"));
  } finally { process.env.REASON_PAYWALL = "off"; }
});

// Review 2026-11-05: Stripe events reach only people the paywall reaches and who are not free for good.
test("Stripe: under owner a non-operator, and under on a free-for-good person, are never lapsed, held or texted by an old subscription", async () => {
  const walker = person("OldSub");
  const pre = person("PreFlipSub");
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(plan.onSince() - 60 * MIN, pre);
  const said = [];
  const say = (to, text) => said.push({ to, text });
  let k = 0;
  const deleted = (c) => ({ id: `evt_rev_${k++}`, type: "customer.subscription.deleted", data: { object: { id: "sub_old", metadata: { conversation_id: c }, client_reference_id: plan.refFor(c), current_period_end: 1 } } });
  for (const [mode, c] of [["owner", walker], ["on", pre]]) {
    process.env.REASON_PAYWALL = mode;
    try {
      db.db.prepare("INSERT OR REPLACE INTO plan (conversation_id, sessions_used, first_seen_at, status, stripe_subscription_id, updated_at) VALUES (?, 3, 1, 'paid', 'sub_old', 1)").run(c);
      const out = await plan.handleStripeEvent(deleted(c), { say });
      assert.equal(out.ignored, true, mode);
      assert.equal(plan.row(c).status, "paid", `${mode}: not lapsed`);
      assert.equal(plan.row(c).held_at ?? null, null, `${mode}: not held`);
    } finally { process.env.REASON_PAYWALL = "off"; }
  }
  assert.equal(said.length, 0);
});
