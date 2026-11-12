// Shopping status said from the run record, not from the model's memory (Reason audit 11-11, rank 2).
// What went out before: "nothing's charged" after Walmart had charged (10-31 14:10), "I've started the
// checkout" about a run that had failed (10-31 10:58), and "declined" about a payment Reason had called
// off itself (10-30 20:00). What these hold:
//   1. shop_status gives the true state for a run that charged, failed, was cancelled by Reason, or placed:
//      whether money went out, who stopped it, and the placed order's result (its delivery estimate).
//   2. A draft that says the opposite of the record is caught by the reply guard and corrected from it.
//   3. A payment Reason called off itself is recorded as Reason's, and is never worded as a decline.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-shop-truth-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const offers = await import("../src/offers.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const q = (sql) => db.db.prepare(sql);
const calls = [];
const reply = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body ?? {}) });
before(() => { shop._setFetch(async (url, init = {}) => { calls.push({ path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined }); return reply(202, { ok: true }); }); shop.attach({ say: () => {}, wake: () => {} }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset(); calls.length = 0;
  for (const t of ["shop_runs", "shop_payments"]) db.db.exec(`DELETE FROM ${t}`);
});

let n = 0;
/** A run of theirs, `minsAgo` minutes old, in a given state, with its payment (if any) in a given status. */
function run({ store = "walmart", item = "CeraVe PM Lotion 3 oz", status, stage, result = "", minsAgo = 5, pay = null, stoppedBy = null }) {
  const id = `run_${++n}`;
  const at = clock.now() - minsAgo * 60_000;
  q("INSERT INTO shop_runs (run_id, conversation_id, store, mode, item, status, stage, stage_at, result, created_at, updated_at, progress_at, paid_at) VALUES (?, ?, ?, 'guest', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, OMARI, store, item, status, stage, at + 60_000, result, at, at, at, pay === "paid" ? at + 60_000 : null);
  if (pay) {
    q("INSERT INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, merchant_name, item, status, created_at, answered_at) VALUES (?, ?, ?, '14.83', 'USD', 'exact', 'Walmart', ?, ?, ?, ?)")
      .run(OMARI, id, `req_${id}`, item, pay, at, at + 60_000);
    if (stoppedBy) q("UPDATE shop_payments SET stopped_by = ? WHERE run_id = ?").run(stoppedBy, id);
  }
  return id;
}
const status = async () => (await runTool("shop_status", {}, { conversationId: OMARI })).runs[0];

// ---------------------------------------------------------------- 1. shop_status is the record
test("shop_status gives the true state: charged, failed, cancelled by Reason, placed (with its delivery estimate)", async () => {
  run({ status: "running", stage: "paid", pay: "paid" });
  let s = await status();
  assert.equal(s.stage, "paid");
  assert.match(s.charged, /^yes: \$14\.83 at Walmart/);

  db.db.exec("DELETE FROM shop_runs"); db.db.exec("DELETE FROM shop_payments");
  run({ store: "ulta", status: "failed", stage: "failed", result: "blocked by the store" });
  s = await status();
  assert.equal(s.stage, "failed");
  assert.equal(s.charged, "no");

  db.db.exec("DELETE FROM shop_runs"); db.db.exec("DELETE FROM shop_payments");
  run({ store: "ulta", status: "cancelled", stage: "cancelled", result: "superseded", pay: "declined", stoppedBy: "reason" });
  s = await status();
  assert.equal(s.stage, "cancelled");
  assert.equal(s.charged, "no");
  assert.equal(s.stopped_by, "reason");
  assert.doesNotMatch(JSON.stringify(s), /declin/i, "a cancel Reason made itself is never called a decline");
  assert.match(s.where, /called it off myself/);

  db.db.exec("DELETE FROM shop_runs"); db.db.exec("DELETE FROM shop_payments");
  run({ store: "amazon", status: "succeeded", stage: "placed", result: "Order placed. Estimated delivery Wednesday, Nov. 11.", pay: "paid" });
  s = await status();
  assert.equal(s.stage, "placed");
  assert.match(s.charged, /^yes: \$14\.83/);
  assert.match(s.result, /Estimated delivery Wednesday, Nov\. 11/);
});

// ---------------------------------------------------------------- 2. the reply guard, against the record
test("pinned 10-31 14:10: 'nothing's charged' after a charge is caught and corrected from the record", () => {
  run({ status: "running", stage: "paid", pay: "paid" });
  const draft = "All good on Walmart. Nothing's charged yet: nothing goes through until you say yes.";
  const g = offers.guardReply(OMARI, draft);
  assert.ok(g.flags.some((f) => f.rule === "charged_contradicts_record"), JSON.stringify(g.flags));
  assert.doesNotMatch(g.text, /nothing'?s charged|nothing goes through/i);
  assert.match(g.text, /^Actually, checking my record: the Walmart checkout for CeraVe PM Lotion 3 oz: paid \$14\.83 at Walmart/);
  // A placed order the same.
  db.db.exec("DELETE FROM shop_runs"); db.db.exec("DELETE FROM shop_payments");
  run({ store: "amazon", status: "succeeded", stage: "placed", result: "Order placed.", pay: "paid" });
  assert.ok(offers.guardReply(OMARI, "You haven't been charged for the Amazon order.").flags.some((f) => f.rule === "charged_contradicts_record"));
  // True when nothing went out: untouched.
  db.db.exec("DELETE FROM shop_runs"); db.db.exec("DELETE FROM shop_payments");
  run({ status: "running", stage: "needs_approval", pay: "asked" });
  const ok = "It's waiting on your approval of $14.83 at Walmart; nothing's charged yet.";
  assert.equal(offers.guardReply(OMARI, ok).text, ok);
});

test("pinned 10-31 10:58: 'started / running' about a run that failed is caught and corrected", () => {
  run({ store: "ulta", item: "CeraVe Foaming Facial Cleanser 16 oz", status: "failed", stage: "failed", result: "blocked by the store", minsAgo: 2 });
  for (const draft of ["I've started the Ulta checkout for the 16 oz. I'll text you the total.", "Your Ulta checkout is running now."]) {
    const g = offers.guardReply(OMARI, draft);
    assert.ok(g.flags.some((f) => f.rule === "running_contradicts_record"), `${draft} ${JSON.stringify(g.flags)}`);
    assert.doesNotMatch(g.text, /I've started|is running/);
    assert.match(g.text, /^Actually, checking my record: the Ulta checkout for CeraVe Foaming Facial Cleanser 16 oz: failed/);
  }
});

test("pinned 10-30 20:00: 'declined' about a payment Reason called off itself is caught; the correction never says declined", () => {
  run({ store: "ulta", status: "cancelled", stage: "cancelled", result: "superseded", pay: "declined", stoppedBy: "reason" });
  const g = offers.guardReply(OMARI, "Heads up: the card was declined on their end, not your card.");
  assert.ok(g.flags.some((f) => f.rule === "declined_contradicts_record"), JSON.stringify(g.flags));
  assert.doesNotMatch(g.text, /declin/i);
  assert.match(g.text, /called it off myself/);
  // A decline they made themselves is a decline: untouched.
  q("UPDATE shop_payments SET stopped_by = 'them'").run();
  const theirs = "You declined it, so nothing was charged.";
  assert.equal(offers.guardReply(OMARI, theirs).text, theirs);
});

// ---------------------------------------------------------------- 3. who stopped it, on the row
test("a payment Reason calls off is recorded as Reason's; one they decline is theirs", async () => {
  const a = run({ status: "running", stage: "needs_approval", pay: "asked" });
  const pa = q("SELECT id FROM shop_payments WHERE run_id = ?").get(a).id;
  assert.equal((await shop.declinePayment({ conversationId: OMARI, paymentId: pa, by: "reason" })).ok, true);
  assert.equal(q("SELECT stopped_by FROM shop_payments WHERE id = ?").get(pa).stopped_by, "reason");
  const b = run({ status: "running", stage: "needs_approval", pay: "asked" });
  const pb = q("SELECT id FROM shop_payments WHERE run_id = ?").get(b).id;
  await runTool("shop_decline", { payment_id: pb }, { conversationId: OMARI });
  assert.equal(q("SELECT stopped_by FROM shop_payments WHERE id = ?").get(pb).stopped_by, "them");
});
