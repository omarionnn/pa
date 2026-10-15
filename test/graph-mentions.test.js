import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-graph-mention-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const C = "conv-graph-mention";

const ama = db.upsertEntity({ conversationId: C, type: "person", name: "Ama", at: 1000 });
const evtId = db.writeEvent({ conversationId: C, role: "user", content: "Ama says hi", at: 2000 });

test("addMention creates a mention row", () => {
  db.addMention({ conversationId: C, eventLogId: evtId, entityId: ama.id, at: 2000 });
  const mentions = db.mentionsForEntity(C, ama.id);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].event_log_id, evtId);
});

test("addMention is idempotent (UNIQUE constraint)", () => {
  db.addMention({ conversationId: C, eventLogId: evtId, entityId: ama.id, at: 3000 });
  const mentions = db.mentionsForEntity(C, ama.id);
  assert.equal(mentions.length, 1);
});

test("mentionsForEntity returns empty for unknown entity", () => {
  const mentions = db.mentionsForEntity(C, 99999);
  assert.equal(mentions.length, 0);
});

test("mentionsForEntity respects limit", () => {
  const c2 = "conv-mention-limit";
  const e = db.upsertEntity({ conversationId: c2, type: "topic", name: "Weather", at: 1000 });
  for (let i = 0; i < 5; i++) {
    const eid = db.writeEvent({ conversationId: c2, role: "user", content: `Weather msg ${i}`, at: 1000 + i * 100 });
    db.addMention({ conversationId: c2, eventLogId: eid, entityId: e.id, at: 1000 + i * 100 });
  }
  const limited = db.mentionsForEntity(c2, e.id, { limit: 3 });
  assert.equal(limited.length, 3);
});
