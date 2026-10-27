// Reason Web Settings' schema change, proven on a database shaped like live's BEFORE it:
//
//   - accounts gets web_reach and web_theme, NULL for every existing row (texted as ever; no theme chosen)
//   - page_sessions gets user_agent, NULL for every existing row; every session still opens what it did
//   - nothing else about an account or a session moves, and integrity_check stays ok
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-web-settings-mig-"));
const path = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = path;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_WEB = "owner";

const OWNER = "dm:owner", A = "dm:sendblue:+12125550101";
const now = Date.now();
{
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE accounts (conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', is_operator INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, last_seen_at INTEGER, web_notice_seen_at INTEGER, UNIQUE(channel, address));
    CREATE TABLE page_sessions (token TEXT PRIMARY KEY, page_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, conversation_id TEXT, csrf TEXT);
  `);
  old.prepare("INSERT INTO accounts (conversation_id, channel, address, name, is_operator, created_at) VALUES (?, 'sendblue', ?, ?, ?, 1000)").run(OWNER, "+12025551234", "Omari", 1);
  old.prepare("INSERT INTO accounts (conversation_id, channel, address, name, is_operator, created_at) VALUES (?, 'sendblue', ?, ?, ?, 1000)").run(A, "+12125550101", "Ama", 0);
  const s = old.prepare("INSERT INTO page_sessions (token, page_id, created_at, last_seen_at, conversation_id, csrf) VALUES (?, ?, ?, ?, ?, ?)");
  s.run("t-web", `wsign:${OWNER}`, now - 1000, now - 1000, OWNER, "c1");
  s.run("t-page", "p123", now - 5000, now - 5000, OWNER, null);
  s.run("t-ama", `esign:${A}`, now - 2000, now - 2000, A, null);
  old.close();
}

const db = await import("../src/db.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("accounts get web_reach and web_theme, NULL for old rows: texted as ever, no theme chosen", () => {
  for (const name of ["web_reach", "web_theme"]) {
    const col = db.db.prepare("SELECT * FROM pragma_table_info('accounts') WHERE name = ?").get(name);
    assert.ok(col, name);
    assert.equal(col.notnull, 0);
  }
  for (const c of [OWNER, A]) {
    assert.equal(db.webReach(c), "text");
    assert.equal(db.webTheme(c), null);
    assert.equal(db.getAccount(c).created_at, 1000);
  }
});

test("page_sessions gets user_agent, NULL for old rows; every session still opens what it did", () => {
  assert.ok(db.db.prepare("SELECT * FROM pragma_table_info('page_sessions') WHERE name = 'user_agent'").get());
  assert.deepEqual(db.pageSessionsFor(OWNER).map(s => [s.token, s.user_agent]), [["t-web", null], ["t-page", null]]);
  assert.equal(db.pageSessionOwner("t-web", 90 * 86_400_000), OWNER);
  assert.equal(db.pageSessionCsrf("t-web"), "c1", "the form secret is kept");
  assert.equal(db.pageSessionOwner("t-ama", 90 * 86_400_000), A);
  assert.equal(db.notePageSessionAgent("t-web", "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36"), true);
  assert.equal(db.notePageSessionAgent("t-web", "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36"), false, "unchanged: no write");
  assert.equal(Object.values(db.db.prepare("PRAGMA integrity_check").get())[0], "ok");
});
