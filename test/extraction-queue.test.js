import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-extract-q-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");

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
  db.markExtractionFailed(item.id, "timeout");

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
