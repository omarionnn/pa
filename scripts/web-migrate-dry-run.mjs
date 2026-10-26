#!/usr/bin/env node
// Reason Web W0: prove the schema change on a COPY of a database before any live box sees it.
//
//   node scripts/web-migrate-dry-run.mjs path/to/reason.db.copy
//
// What W0 adds on load (src/db.js): the `messages` table and its indexes, and `threads.last_channel`.
// Nothing else is touched, and this script is how that is shown rather than asserted:
//
//   1. the file you name is COPIED to a temp dir; the original is never opened for writing
//   2. before: PRAGMA integrity_check, every table name, every account id, every thread row
//   3. src/db.js is loaded against the copy, which runs every CREATE TABLE IF NOT EXISTS and
//      addColumnIfMissing exactly as `npm run serve` would
//   4. after: the same snapshot, plus the new table and column
//   5. the report: what changed, and a non-zero exit if anything that must not change did
//
// Never point it at the live file (/opt/reason/data/reason.db) — copy that first with sqlite3's
// `.backup`, then run this on the copy. It refuses a path under /opt/reason outright.
import { copyFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/web-migrate-dry-run.mjs <copy-of-reason.db>");
  process.exit(2);
}
const abs = resolve(src);
if (abs.startsWith("/opt/reason/")) {
  console.error("refusing: that looks like the live database. Copy it first (sqlite3 reason.db \".backup copy.db\") and run this on the copy.");
  process.exit(2);
}
if (!existsSync(abs)) {
  console.error(`no such file: ${abs}`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "reason-web-dryrun-"));
const copy = join(dir, "reason.db");
copyFileSync(abs, copy);
// WAL/SHM sidecars, if the copy was taken while the database was open.
for (const ext of ["-wal", "-shm"]) if (existsSync(abs + ext)) copyFileSync(abs + ext, copy + ext);

function snapshot(path) {
  const d = new DatabaseSync(path);
  try {
    const integrity = d.prepare("PRAGMA integrity_check").all().map(r => Object.values(r)[0]);
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
    const has = (t) => tables.includes(t);
    const accounts = has("accounts") ? d.prepare("SELECT conversation_id, channel, address, state FROM accounts ORDER BY conversation_id").all() : [];
    const threads = has("threads") ? d.prepare("SELECT conversation_id, channel, address FROM threads ORDER BY conversation_id").all() : [];
    const threadCols = has("threads") ? d.prepare("PRAGMA table_info(threads)").all().map(c => c.name) : [];
    const conversations = has("conversations") ? d.prepare("SELECT COUNT(*) AS n FROM conversations").get().n : 0;
    const messages = has("messages") ? d.prepare("SELECT COUNT(*) AS n FROM messages").get().n : null;
    return { integrity, tables, accounts, threads, threadCols, conversations, messages };
  } finally { d.close(); }
}

const before = snapshot(copy);
if (before.integrity.join(",") !== "ok") {
  console.error(`before: integrity_check says ${before.integrity.join("; ")} — not migrating a broken copy`);
  process.exit(1);
}

// The real schema pass: loading src/db.js against the copy is exactly what serve does on boot.
process.env.REASON_DB_PATH = copy;
process.env.REASON_DATA_DIR = dir;
await import("../src/db.js");

const after = snapshot(copy);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const problems = [];
if (after.integrity.join(",") !== "ok") problems.push(`integrity_check after: ${after.integrity.join("; ")}`);
if (!same(before.accounts, after.accounts)) problems.push("accounts changed (ids, channel, address or state)");
if (!same(before.threads, after.threads)) problems.push("threads changed (route channel or address)");
if (before.conversations !== after.conversations) problems.push("conversations count changed");
if (!after.tables.includes("messages")) problems.push("messages table missing after load");
if (!after.threadCols.includes("last_channel")) problems.push("threads.last_channel missing after load");
if (after.messages !== 0 && after.messages !== before.messages) problems.push(`messages table not empty after load: ${after.messages}`);

const added = after.tables.filter(t => !before.tables.includes(t));
console.log(`dry run on a copy of ${abs}`);
console.log(`  integrity: before ${before.integrity.join(",")} · after ${after.integrity.join(",")}`);
console.log(`  accounts:  ${before.accounts.length} → ${after.accounts.length} (${same(before.accounts, after.accounts) ? "unchanged" : "CHANGED"})`);
console.log(`  threads:   ${before.threads.length} → ${after.threads.length} (${same(before.threads, after.threads) ? "unchanged" : "CHANGED"}); last_channel ${before.threadCols.includes("last_channel") ? "already there" : after.threadCols.includes("last_channel") ? "added" : "MISSING"}`);
console.log(`  tables:    ${before.tables.length} → ${after.tables.length}; added: ${added.join(", ") || "none"}`);
console.log(`  messages:  ${after.messages ?? "no table"} row(s)`);
console.log(problems.length ? `  PROBLEMS:\n    - ${problems.join("\n    - ")}` : "  ok — nothing that must not change changed");
rmSync(dir, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
