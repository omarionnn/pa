// The trust line through the REAL tool loop, with the model's part scripted.
//
// Everything else here is real: the real `runTurn`, the real tool dispatch, the real confirm gate,
// the real database, and a real Chromium on a local fixture shop. What is faked is the one thing a
// test cannot have offline — the model's choice of tool on each round — and each step is handed the
// actual tool result from the step before, so a result that does not lead anywhere fails the test.
//
// Two things are checked end to end, because both are about what happens on the NEXT grocery order
// rather than about a function returning the right object:
//
//   they said "you can reorder groceries without asking" → the next one goes through with no yes,
//                                                          and the receipt says that is why
//   the first thing that would ever spend money          → Reason asks for their two limits once,
//                                                          saves them, and the purchase then goes
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSiteFixtures, COMMIT_LABELS } from "./fixture-sites.js";

const dir = mkdtempSync(join(tmpdir(), "reason-trustline-loop-"));
// This suite's fixtures live on 127.0.0.1; outside a test, nothing may fetch there (src/netguard.js).
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const agent = await import("../src/agent.js");
const browser = await import("../src/browser.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:owner";
let fx;
let realCreate;

before(async () => {
  fx = await startSiteFixtures();
  realCreate = agent.model.create;
});
after(async () => {
  agent.model.create = realCreate;
  await browser.closeAllBrowsers();
  await fx.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM permissions; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend; DELETE FROM conversations; DELETE FROM spend_caps; DELETE FROM unknown_outcomes;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fx.orders.length = 0;
  for (const s of Object.keys(COMMIT_LABELS)) fx.setTotal(s, 58.4);
  config.maxSpendPerDay = 300;
  // Limits already set, the way somebody who has used Reason before has them. The second test below
  // deletes them, because being asked the first time is the thing it is about.
  db.setSpendCaps(C, { perPurchaseCents: 200_00, monthlyCents: 1_500_00, said: "$200 a thing, $1500 a month" });
});

let nextId = 0;
const use = (name, input) => ({ content: [{ type: "tool_use", id: `t${++nextId}`, name, input }], stop_reason: "tool_use", usage: {} });
const say = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} });

/**
 * One turn's worth of model. Each step is a function of the previous tool's real result, so a step
 * that needs a ref off a page snapshot has to actually read it out of the snapshot.
 */
function script(steps) {
  let i = 0;
  const seen = [];
  agent.model.create = async (params) => {
    const last = params.messages.at(-1);
    const result = Array.isArray(last?.content) && last.content[0]?.type === "tool_result"
      ? JSON.parse(last.content[0].content)
      : null;
    if (result) seen.push(result);
    const step = steps[i++];
    assert.ok(step, `the fake model ran out of script after ${i - 1} round(s)`);
    return step(result);
  };
  return { results: seen, rounds: () => i };
}

const refFor = (snap, site) => snap.elements.find(e => e.name === COMMIT_LABELS[site])?.ref;
const fieldFor = (snap, label) => snap.elements.find(e => e.tag === "input" && label.test(e.name))?.ref;
/**
 * One real turn. `siteHosts` is the documented hook that says the fixture IS amazon, and `judge`
 * states what their reply meant — reading meaning is the one other thing a model does here, and it
 * is a separate narrow call (src/judge.js) with its own live tests. Everything the gate decides from
 * that verdict is real: that a new message arrived, single use, expiry, one action per yes.
 */
const turn = (text) => agent.runTurn({
  conversationId: C, text,
  siteHosts: { [fx.host]: "amazon" },
  judge: async () => ({ verdict: "yes" }),
});

test("they said to reorder groceries without asking, so the next one goes through and says why", async () => {
  // Turn one: they say it, and Reason writes it down in their own words.
  const first = script([
    () => use("permission_grant", {
      text: "you can reorder groceries without asking, up to $80",
      scope: { action: "purchases", target: "groceries", max_amount: 80 },
    }),
    (saved) => {
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(saved.permission.said, "you can reorder groceries without asking, up to $80");
      return say("got it — groceries under $80, i'll just do it. anything over that or anything else, i'll check");
    },
  ]);
  const said = await turn("you can reorder groceries without asking, up to $80");
  assert.equal(first.rounds(), 2);
  assert.match(said, /groceries/i);
  assert.equal(db.listPermissions(C).length, 1);

  // Turn two: the actual order. Nothing in this turn asks them anything.
  const order = script([
    () => use("browser_open", { url: `${fx.url}/amazon/checkout?pick=second` }),
    (page) => {
      assert.equal(page.ok, true, JSON.stringify(page).slice(0, 200));
      return use("browser_type", { ref: fieldFor(page, /name/i), text: "Omari" });
    },
    (named) => use("browser_type", { ref: fieldFor(named, /mobile/i), text: "+12025551234" }),
    (filled) => {
      // Filling a form commits nothing, so none of the above needed anything from anybody.
      assert.equal(filled.ok, true, JSON.stringify(filled).slice(0, 200));
      return use("browser_submit", { ref: refFor(filled, "amazon"), what: "Amazon, the usual groceries, total $58.40" });
    },
    (out) => {
      assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
      assert.equal(out.under_permission.said, "you can reorder groceries without asking, up to $80");
      return say("reordered the groceries, $58.40 — didn't check since u said i don't have to");
    },
  ]);
  await turn("we're out of coffee, reorder the groceries");

  assert.equal(order.rounds(), 5);
  assert.equal(fx.orders.length, 1, "the order really went through");
  assert.equal(db.pendingConfirmations(C).length, 0, "nobody was asked anything");

  const row = db.listActions(C).find(a => a.action === "browser_submit" && a.outcome === "ok");
  assert.match(row.receipt, /No yes was asked for — under: "you can reorder groceries without asking, up to \$80"/);
  assert.equal(row.confirmation_id, null);
  assert.equal(trust.spendToday(C).spent_cents, 5840, "and it counts against the day like any other commit");
});

test("the first thing that would ever spend money asks for their limits, then goes", async () => {
  // Nothing saved: this person has never had Reason spend anything.
  db.db.exec("DELETE FROM spend_caps");

  const asked = script([
    () => use("browser_open", { url: `${fx.url}/amazon/checkout?pick=second` }),
    (page) => use("browser_type", { ref: fieldFor(page, /name/i), text: "Omari" }),
    (named) => use("browser_type", { ref: fieldFor(named, /mobile/i), text: "+12025551234" }),
    (filled) => use("confirm_request", {
      action: "browser_submit", stakes: "both",
      summary: "Amazon, a desk chair, total $58.40",
      target: "Amazon, a desk chair, total $58.40",
    }),
    // The yes has not been given yet, so the turn ends with the question. This is the shape a real
    // turn has: ask, then stop.
    () => say("gonna order the chair — $58.40 on amazon. ok?"),
  ]);
  await turn("order me that desk chair off amazon");
  assert.equal(asked.rounds(), 5);
  const pending = db.pendingConfirmations(C).filter(x => x.action === "browser_submit");
  assert.equal(pending.length, 1);

  // They say yes. The submit now stops for the limits instead — before the yes is spent, and before
  // anything is bought — and the turn asks them for both numbers in one line.
  const limits = script([
    () => use("confirm_record", { confirmation_id: pending[0].id }),
    (rec) => {
      assert.equal(rec.state, "granted", JSON.stringify(rec));
      return use("browser_read", {});
    },
    (page) => use("browser_submit", { ref: refFor(page, "amazon"), what: "Amazon, a desk chair, total $58.40", confirmation_id: pending[0].id }),
    (out) => {
      assert.equal(out.blocked, "needs_caps", JSON.stringify(out).slice(0, 300));
      return say("before i spend anything — what's the most i should ever spend on one thing without checking, and the max per month?");
    },
  ]);
  const question = await turn("yeah go for it");
  assert.equal(limits.rounds(), 4);
  assert.match(question, /most i should ever spend/i);
  assert.equal(fx.orders.length, 0, "nothing was bought while the question was open");
  assert.equal(db.getSpendCaps(C), null);

  // They answer. caps_set saves both, and the same purchase then goes through on the yes they
  // already gave — they are not asked about the chair twice.
  const bought = script([
    () => use("caps_set", { per_purchase: 200, monthly: 1500, text: "200 a thing, 1500 a month" }),
    (saved) => {
      assert.equal(saved.caps.per_purchase, "$200.00");
      return use("browser_open", { url: `${fx.url}/amazon/checkout?pick=second` });
    },
    (page) => use("browser_type", { ref: fieldFor(page, /name/i), text: "Omari" }),
    (named) => use("browser_type", { ref: fieldFor(named, /mobile/i), text: "+12025551234" }),
    (filled) => use("browser_submit", { ref: refFor(filled, "amazon"), what: "Amazon, a desk chair, total $58.40", confirmation_id: pending[0].id }),
    (out) => {
      assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
      return say("ordered — $58.40. limits saved: $200 a go, $1500 a month");
    },
  ]);
  await turn("$200 a thing and keep it under 1500 a month");

  assert.equal(bought.rounds(), 6);
  assert.equal(fx.orders.length, 1, "the chair really got bought");
  assert.equal(db.getSpendCaps(C).per_purchase_cents, 200_00);
  assert.equal(db.getSpendCaps(C).monthly_cents, 1500_00);
  assert.equal(trust.spendToday(C).spent_cents, 5840);
});
