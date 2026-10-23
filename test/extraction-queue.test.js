import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-extract-q-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

test("enqueueExtraction and claimExtractions lifecycle", () => {
  const evId = db.writeEvent({ conversationId: "conv-q", role: "user", content: "test", at: 1000 });
  db.enqueueExtraction("conv-q", evId);

  const claimed = db.claimExtractions({ limit: 10 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].event_log_id, evId);
  assert.equal(claimed[0].conversation_id, "conv-q");

  db.markExtractionDone(claimed[0].id);
  const again = db.claimExtractions({ limit: 10 });
  assert.equal(again.length, 0, "already done items should not be claimed again");
});

test("enqueueExtraction is idempotent (UNIQUE event_log_id)", () => {
  const evId = db.writeEvent({ conversationId: "conv-q2", role: "user", content: "test", at: 2000 });
  db.enqueueExtraction("conv-q2", evId);
  db.enqueueExtraction("conv-q2", evId); // should not throw
  db.enqueueExtraction("conv-q2", evId); // still fine

  const claimed = db.claimExtractions({ limit: 10 });
  const matching = claimed.filter(r => r.event_log_id === evId);
  assert.equal(matching.length, 1);
});

test("markExtractionFailed puts item back to pending", () => {
  const evId = db.writeEvent({ conversationId: "conv-q3", role: "user", content: "test", at: 3000 });
  db.enqueueExtraction("conv-q3", evId);

  const claimed1 = db.claimExtractions({ limit: 10 });
  const item = claimed1.find(r => r.event_log_id === evId);
  db.markExtractionFailed(item.id, "the model returned something that was not the schema");

  const claimed2 = db.claimExtractions({ limit: 10 });
  const retry = claimed2.find(r => r.event_log_id === evId);
  assert.ok(retry, "failed item should be claimable again");
});

test("extraction stops after 3 attempts", () => {
  const evId = db.writeEvent({ conversationId: "conv-q4", role: "user", content: "test", at: 4000 });
  db.enqueueExtraction("conv-q4", evId);

  for (let i = 0; i < 3; i++) {
    const claimed = db.claimExtractions({ limit: 10 });
    const item = claimed.find(r => r.event_log_id === evId);
    if (item) db.markExtractionFailed(item.id, `attempt ${i + 1}`);
  }

  const claimed = db.claimExtractions({ limit: 10 });
  const item = claimed.find(r => r.event_log_id === evId);
  assert.equal(item, undefined, "should not be claimable after 3 attempts");
});

// ---------- an outage does not spend a message's tries (2026-10-22/23) ----------

const CREDIT = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

test("a failure from an outage gives the try back and waits a few minutes, however long the outage", () => {
  clock.reset();
  const evId = db.writeEvent({ conversationId: "conv-out", role: "user", content: "my sister is visiting friday", at: 5000 });
  db.enqueueExtraction("conv-out", evId);
  for (let i = 0; i < 10; i++) {
    const item = db.claimExtractions({ limit: 50 }).find(r => r.event_log_id === evId);
    assert.ok(item, `still claimable on try ${i + 1}, ten tries into an outage`);
    assert.equal(db.markExtractionFailed(item.id, CREDIT).outage, true);
    assert.equal(db.claimExtractions({ limit: 50 }).find(r => r.event_log_id === evId), undefined, "not straight away");
    clock.skip(5 * 60_000);
  }
  const row = db.db.prepare("SELECT attempts FROM extraction_queue WHERE event_log_id = ?").get(evId);
  assert.equal(row.attempts, 0, "no tries were spent");
  clock.reset();
});

test("rows already exhausted by an outage are revived; rows a bad message exhausted are not", () => {
  const out = db.writeEvent({ conversationId: "conv-rev", role: "user", content: "a", at: 6000 });
  const bad = db.writeEvent({ conversationId: "conv-rev", role: "user", content: "b", at: 6001 });
  db.enqueueExtraction("conv-rev", out);
  db.enqueueExtraction("conv-rev", bad);
  // The state the 30 live rows were left in: pending, three tries, the credit error.
  db.db.prepare("UPDATE extraction_queue SET attempts = 3, last_error = ? WHERE event_log_id = ?").run(CREDIT, out);
  db.db.prepare("UPDATE extraction_queue SET attempts = 3, last_error = 'not the schema' WHERE event_log_id = ?").run(bad);
  assert.equal(db.reviveOutageExtractions(), 1);
  const claimed = db.claimExtractions({ limit: 50 }).map(r => r.event_log_id);
  assert.ok(claimed.includes(out), "the outage row is back in line");
  assert.ok(!claimed.includes(bad), "a message that really failed three times stays stopped");
});

test("the outage check reads the errors the live box actually saw, and not a bad message", () => {
  for (const e of [CREDIT, "429 rate_limit_error", "529 overloaded_error", "502 Bad Gateway", "fetch failed", "Request timed out.", "Connection error.", "ECONNRESET"]) {
    assert.ok(db.EXTRACTION_OUTAGE.test(e), e);
  }
  for (const e of ["the model returned something that was not the schema", "Unexpected token in JSON", "400 messages: text content blocks must be non-empty"]) {
    assert.ok(!db.EXTRACTION_OUTAGE.test(e), e);
  }
});
