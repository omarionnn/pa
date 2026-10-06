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
  db.db.exec("DELETE FROM permissions; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM spend; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  for (const s of Object.keys(COMMIT_LABELS)) fx.setTotal(s, 58.4);
  config.maxSpendPerDay = 300;
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
/** The turn drives a real Chromium, and `siteHosts` is the documented hook that says the fixture IS amazon. */
const turn = (text) => agent.runTurn({ conversationId: C, text, siteHosts: { [fx.host]: "amazon" } });

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
