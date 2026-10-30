// The onboarding column reaching a database that already has people in it (the accounts.state
// lesson, 2026-10-25: a column only in CREATE TABLE never reaches live). Open src/db.js on an
// accounts table shaped like live's, and every person already there must read as 'complete', so
// nobody who existed before the first-chat onboarding is ever walked through it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-onboarding-migration-"));
const path = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = path;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_ONBOARDING = "on";

const A = "dm:sendblue:+12125550101", B = "dm:sendblue:+12125550102";
{
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE accounts (
    conversation_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    address TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    is_operator INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    UNIQUE(channel, address)
  )`);
  const ins = old.prepare("INSERT INTO accounts (conversation_id, channel, address, name, created_at, last_seen_at) VALUES (?, 'sendblue', ?, ?, 1000, 2000)");
  ins.run(A, "+12125550101", "Ama");
  ins.run(B, "+12125550102", ""); // no name yet: still exempt
  old.close();
}

const db = await import("../src/db.js");
const ob = await import("../src/onboarding.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("everybody already there when the column lands is complete, and cannot be started", () => {
  const cols = db.db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map(c => c.name);
  for (const c of ["onboarding", "onboarding_at", "onboarding_steers", "onboarding_name_asked_at", "onboarding_nudged_at"]) assert.ok(cols.includes(c), c);
  for (const c of [A, B]) {
    assert.equal(db.getAccount(c).onboarding, "complete");
    assert.equal(ob.begin(c), false);
    assert.equal(ob.active(c), false);
  }
  assert.equal(db.getAccount(A).name, "Ama", "nothing else touched");
});

test("an account made after the migration is exempt until code starts it, and only then", () => {
  const C = "dm:sendblue:+12125550103";
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12125550103" });
  assert.equal(db.getAccount(C).onboarding, null);
  assert.equal(ob.active(C), false);
  assert.equal(ob.begin(C), true);
  assert.equal(db.getAccount(C).onboarding, "not_started");
});
