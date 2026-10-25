// Incident 2026-10-25: live's accounts table had no `state` column. CREATE TABLE IF NOT EXISTS
// had it, but an older database never got it, so every write (admin_pause/resume/remove, the harm
// pause) would have thrown "no such column: state". Pinned here: open src/db.js on a database
// whose accounts table looks like live's did, and
//
//   is the column added, with every existing person reading as active?
//   are their other fields untouched?
//   do pause / resume / remove now write and read back?
//   does the announcement script still count active people in and paused ones out?
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-accounts-state-"));
const path = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = path;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.REASON_NOTICE_QUIET_START;
delete process.env.REASON_NOTICE_QUIET_END;

// Live's accounts table as it was: the original columns, no `state`.
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
  ins.run(B, "+12125550102", "Kofi");
  old.close();
}

const db = await import("../src/db.js");
const accounts = await import("../src/accounts.js");
const { clock } = await import("../src/config.js");
const announce = await import("../scripts/announce.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("an accounts table without `state` gets it, and everybody already there is active", () => {
  const col = db.db.prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = 'state'").get();
  assert.ok(col, "state column added");
  assert.equal(col.notnull, 1);
  assert.equal(col.dflt_value, "'active'");
  for (const [c, name] of [[A, "Ama"], [B, "Kofi"]]) {
    const row = db.getAccount(c);
    assert.equal(row.state, "active");
    assert.equal(row.name, name);
    assert.equal(row.created_at, 1000);
    assert.equal(row.last_seen_at, 2000);
  }
  assert.equal(accounts.accountState("sendblue", "+12125550101"), "active");
});

test("pause, resume and remove write now, where they used to throw", () => {
  assert.equal(db.setAccountState(A, "paused").state, "paused");
  assert.equal(accounts.accountState("sendblue", "+12125550101"), "paused");
  assert.equal(db.setAccountState(A, "active").state, "active");
  assert.equal(db.setAccountState(A, "removed").state, "removed");
  assert.equal(db.getAccount(B).state, "active", "nobody else moved");
  db.setAccountState(A, "active");
});

test("the announcement still counts active people in and a paused one out", () => {
  const now = clock.now();
  let ext = 0;
  for (const c of [A, B]) {
    db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at, text) VALUES ('sendblue', ?, ?, ?, '')")
      .run(`m${++ext}`, c, now - 60_000);
  }
  const before = announce.audience({ now: Date.parse("2026-10-26T16:00:00Z") });
  assert.equal(before.excluded.optedOut, 0);
  db.setAccountState(B, "paused");
  const afterPause = announce.audience({ now: Date.parse("2026-10-26T16:00:00Z") });
  assert.equal(afterPause.excluded.optedOut, 1);
  assert.equal(afterPause.recipients.length, before.recipients.length - 1);
});
