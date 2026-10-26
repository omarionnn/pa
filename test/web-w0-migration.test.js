// Reason Web W0's schema change, proven on a database shaped like live's BEFORE the change
// (docs/plans/reason-web-phase1.md §3 "test on a copy first"):
//
//   - `threads` without `last_channel` gets the column, every existing route untouched
//   - the `messages` table appears, empty — no backfill, ever
//   - accounts: same count, same ids, same channel and address, same state
//   - integrity_check stays ok
//   - upsertThread still works on the old rows, and a web upsert still leaves the route alone
//   - scripts/web-migrate-dry-run.mjs says the same thing about a copy, and leaves the original alone
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-web-w0-mig-"));
const path = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = path;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_WEB = "on";

// Live's shape before W0: accounts with state, threads with every column but last_channel, a
// conversation blob, an outbox row, an inbound row — real-shaped data for three people.
const OWNER = "dm:owner", A = "dm:sendblue:+12125550101", B = "dm:linq:+12125550102";
const PEOPLE = [[OWNER, "sendblue", "+12025551234", "Omari", 1], [A, "sendblue", "+12125550101", "Ama", 0], [B, "linq", "+12125550102", "Kofi", 0]];
function buildOld(p) {
  const old = new DatabaseSync(p);
  old.exec(`
    CREATE TABLE accounts (conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', is_operator INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, last_seen_at INTEGER, UNIQUE(channel, address));
    CREATE TABLE threads (conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, chat_id TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      service TEXT, last_inbound_id TEXT, reply_target TEXT, held_reaction TEXT, pending_style TEXT,
      location_sharing_until INTEGER, last_location TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE inbound_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, external_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE(channel, external_id));
  `);
  const acc = old.prepare("INSERT INTO accounts (conversation_id, channel, address, name, is_operator, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1000, 2000)");
  const thr = old.prepare("INSERT INTO threads (conversation_id, channel, address, chat_id, is_owner, created_at, updated_at, service, last_inbound_id) VALUES (?, ?, ?, NULL, 1, 1000, 2000, 'iMessage', ?)");
  const conv = old.prepare("INSERT INTO conversations (id, messages, updated_at) VALUES (?, ?, 2000)");
  let n = 0;
  for (const [c, ch, addr, name, op] of PEOPLE) {
    acc.run(c, ch, addr, name, op);
    thr.run(c, ch, addr, `h${++n}`);
    conv.run(c, JSON.stringify([{ role: "user", content: `[Mon 1 Jan 09:00] ${name}: hi` }, { role: "assistant", content: "hey" }]));
    old.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES (?, ?, ?, 1500)").run(ch, `h${n}`, c);
  }
  old.exec("UPDATE accounts SET state = 'paused' WHERE conversation_id = '" + B + "'");
  old.close();
}
buildOld(path);
// A second, untouched copy for the dry-run script, so the script's "never writes the original" is checkable.
const copyForScript = join(dir, "copy.db");
buildOld(copyForScript);
const copyBytesBefore = readFileSync(copyForScript);

const snapshotAccounts = (p) => {
  const d = new DatabaseSync(p);
  try { return d.prepare("SELECT conversation_id, channel, address, name, state FROM accounts ORDER BY conversation_id").all(); } finally { d.close(); }
};
const accountsBefore = snapshotAccounts(path);

const db = await import("../src/db.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("threads gets last_channel; every existing route is exactly as it was", () => {
  const col = db.db.prepare("SELECT * FROM pragma_table_info('threads') WHERE name = 'last_channel'").get();
  assert.ok(col, "column added");
  assert.equal(col.notnull, 0);
  for (const [c, ch, addr] of PEOPLE) {
    const t = db.getThread(c);
    assert.equal(t.channel, ch);
    assert.equal(t.address, addr);
    assert.equal(t.last_channel, null, "nothing invented for old rows");
    assert.equal(t.service, "iMessage");
    assert.equal(t.created_at, 1000);
  }
});

test("the messages table exists and is empty: no backfill", () => {
  assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get());
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  for (const idx of ["messages_conv_at", "messages_inbound_once", "messages_outbox_once"]) {
    assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx), idx);
  }
  for (const [c] of PEOPLE) assert.deepEqual(db.messagesFor(c), []);
});

test("accounts and conversations are untouched, and the file is sound", () => {
  assert.deepEqual(snapshotAccounts(path), accountsBefore);
  assert.equal(db.getAccount(B).state, "paused", "a paused person is still paused");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM conversations").get().n, 3);
  assert.equal(db.loadConversation(A).length, 2);
  assert.equal(Object.values(db.db.prepare("PRAGMA integrity_check").get())[0], "ok");
});

test("upsertThread still works on the old rows, and a web upsert leaves their route alone", () => {
  const t = db.upsertThread({ conversationId: A, channel: "sendblue", address: "+12125550101", isOwner: true, lastInboundId: "h9" });
  assert.equal(t.last_channel, "sendblue");
  assert.equal(t.last_inbound_id, "h9");
  const w = db.upsertThread({ conversationId: A, channel: "web", address: "ignored", isOwner: true, lastInboundId: "w1" });
  assert.equal(w.channel, "sendblue");
  assert.equal(w.address, "+12125550101");
  assert.equal(w.last_channel, "web");
  assert.equal(w.last_inbound_id, "w1");
});

test("scripts/web-migrate-dry-run.mjs proves the same on a copy and never writes the file it was given", () => {
  const r = spawnSync(process.execPath, ["scripts/web-migrate-dry-run.mjs", copyForScript], {
    cwd: join(import.meta.dirname, ".."), encoding: "utf8",
    env: { ...process.env, REASON_DB_PATH: "", REASON_DATA_DIR: "" },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /accounts:\s+3 → 3 \(unchanged\)/);
  assert.match(r.stdout, /threads:\s+3 → 3 \(unchanged\); last_channel added/);
  assert.match(r.stdout, /added: .*messages/);
  assert.match(r.stdout, /ok — nothing that must not change changed/);
  assert.ok(copyBytesBefore.equals(readFileSync(copyForScript)), "the original file is byte-identical");
  assert.equal(statSync(copyForScript + "-wal", { throwIfNoEntry: false }), undefined, "no WAL opened on the original");

  const refused = spawnSync(process.execPath, ["scripts/web-migrate-dry-run.mjs", "/opt/reason/data/reason.db"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refusing/);
});
