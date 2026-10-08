// Financial intelligence: spending_summary tool.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-spending-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => { try { rmSync(dir, { recursive: true }); } catch {} });

test("spending_summary returns ok with empty data", async () => {
  const out = await runTool("spending_summary", {}, { conversationId: C });
  assert.equal(out.ok, true);
  assert.equal(out.subscriptions.count, 0);
  assert.equal(out.subscriptions.monthly_total, "none on record");
  assert.equal(out.today.commits, 0);
  assert.equal(out.caps, null);
});

test("spending_summary includes subscription data", async () => {
  db.recordSubscription(C, {
    merchant: "Netflix",
    amountCents: 1599,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    source: "gmail",
  });
  db.recordSubscription(C, {
    merchant: "Spotify",
    amountCents: 1099,
    currency: "USD",
    cadence: "monthly",
    status: "active",
    source: "gmail",
  });

  const out = await runTool("spending_summary", {}, { conversationId: C });
  assert.equal(out.ok, true);
  assert.equal(out.subscriptions.count, 2);
  assert.ok(out.subscriptions.monthly_total.includes("$"));
  assert.equal(out.subscriptions.top.length, 2);
  assert.equal(out.subscriptions.top[0].name, "Netflix");
});

test("spending_summary includes cancelling subscriptions", async () => {
  db.recordSubscription(C, {
    merchant: "Hulu",
    amountCents: 1799,
    currency: "USD",
    cadence: "monthly",
    status: "cancelling",
    source: "gmail",
  });

  const out = await runTool("spending_summary", {}, { conversationId: C });
  assert.ok(out.subscriptions.cancelling);
  assert.ok(out.subscriptions.cancelling.includes("Hulu"));
});

test("spending_summary shows today spending", async () => {
  const out = await runTool("spending_summary", {}, { conversationId: C });
  assert.equal(out.ok, true);
  assert.ok("spent" in out.today);
  assert.ok("commits" in out.today);
  assert.ok("cap" in out.today);
});

test("spending_summary shows caps when set", async () => {
  db.setSpendCaps(C, { perPurchaseCents: 5000, monthlyCents: 30000 });

  const out = await runTool("spending_summary", {}, { conversationId: C });
  assert.ok(out.caps);
  assert.ok(out.caps.per_purchase.includes("$50"));
  assert.ok(out.caps.monthly.includes("$300"));
});

test("financial_overview capability is live", () => {
  const caps = capabilitiesNow({});
  const fin = caps.find(c => c.name === "financial_overview");
  assert.ok(fin);
  assert.equal(fin.status, "live");
});
