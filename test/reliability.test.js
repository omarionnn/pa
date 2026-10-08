// Reliability: process crash handlers, SQLite busy_timeout, and outbox pacing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-reliability-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const outbox = await import("../src/outbox.js");

import { after } from "node:test";
after(() => { try { rmSync(dir, { recursive: true }); } catch {} });

test("busy_timeout pragma is set", () => {
  const row = db.db.prepare("PRAGMA busy_timeout").get();
  assert.equal(row.timeout, 5000);
});

test("WAL journal mode is active", () => {
  const row = db.db.prepare("PRAGMA journal_mode").get();
  assert.equal(row.journal_mode, "wal");
});

test("outbox pass paces sends with a delay", async () => {
  const timestamps = [];
  const fakeRouter = {
    sendNow: async () => {
      timestamps.push(Date.now());
      return { ok: true, delivered: { message_id: `msg-${timestamps.length}` } };
    },
  };

  const conv = "dm:owner";
  db.db.exec("DELETE FROM outbox");
  for (let i = 0; i < 3; i++) {
    db.enqueueOutbound({
      idemKey: `pace-${i}`,
      conversationId: conv,
      channel: "fake",
      address: "+10000000000",
      body: `test ${i}`,
      toOwner: false,
    });
  }

  const result = await outbox.pass({ router: fakeRouter, paceMs: 50 });
  assert.equal(result.sent, 3);
  assert.equal(timestamps.length, 3);
  const gap1 = timestamps[1] - timestamps[0];
  const gap2 = timestamps[2] - timestamps[1];
  assert.ok(gap1 >= 40, `first gap was ${gap1}ms, expected >= 40`);
  assert.ok(gap2 >= 40, `second gap was ${gap2}ms, expected >= 40`);
});

test("outbox pass with paceMs=0 sends without delay", async () => {
  const fakeRouter = {
    sendNow: async () => ({ ok: true, delivered: { message_id: "fast" } }),
  };

  db.db.exec("DELETE FROM outbox");
  for (let i = 0; i < 3; i++) {
    db.enqueueOutbound({
      idemKey: `nopace-${i}`,
      conversationId: "dm:owner",
      channel: "fake",
      address: "+10000000000",
      body: `fast ${i}`,
      toOwner: false,
    });
  }

  const result = await outbox.pass({ router: fakeRouter, paceMs: 0 });
  assert.equal(result.sent, 3);
});

test("backoff grows exponentially with a ceiling", () => {
  const b1 = outbox.backoffMs(1);
  const b2 = outbox.backoffMs(2);
  const b3 = outbox.backoffMs(3);
  assert.ok(b2 > b1, "second attempt should be longer than first");
  assert.ok(b3 > b2, "third attempt should be longer than second");
  const bMax = outbox.backoffMs(100);
  assert.ok(bMax <= 300_000, "backoff should not exceed 5 minutes");
});
