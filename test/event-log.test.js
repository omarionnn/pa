import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-eventlog-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");

test("writeEvent returns an id and eventsSince retrieves it", () => {
  const id = db.writeEvent({
    conversationId: "conv-1", channel: "sendblue", messageId: "msg-1",
    role: "user", content: "hello there", at: 1000,
  });
  assert.ok(id > 0);

  const rows = db.eventsSince("conv-1", 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "user");
  assert.equal(rows[0].content, "hello there");
  assert.equal(rows[0].channel, "sendblue");
});

test("recentEvents returns in descending order", () => {
  db.writeEvent({ conversationId: "conv-2", role: "user", content: "first", at: 100 });
  db.writeEvent({ conversationId: "conv-2", role: "assistant", content: "second", at: 200 });
  db.writeEvent({ conversationId: "conv-2", role: "user", content: "third", at: 300 });

  const rows = db.recentEvents("conv-2", { limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, "third");
  assert.equal(rows[1].content, "second");
});

test("event_log scoped by conversation_id", () => {
  db.writeEvent({ conversationId: "conv-a", role: "user", content: "a's message", at: 500 });
  db.writeEvent({ conversationId: "conv-b", role: "user", content: "b's message", at: 500 });

  const a = db.eventsSince("conv-a", 0);
  const b = db.eventsSince("conv-b", 0);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].content, "a's message");
  assert.equal(b[0].content, "b's message");
});
