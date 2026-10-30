// Close every ask for a yes that has run out, as a no: node --env-file-if-exists=.env scripts/expire-stale-asks.js [--dry-run]
//
// Run once on deploy (2026-10-30): before then an ask never ran out, and the live database had call
// asks from Oct 10 still open. After that the app closes overdue asks itself whenever it reads them
// (src/db.js expireStaleAsks); this is the same function across every conversation, with a log.
//
// Uses the app's own db module, so its migrations (expired_at, expiry_told_at) run first, against
// config.dbPath (REASON_DB_PATH, else data/reason.db). Sends nothing to anybody. An ask older than
// seven days is closed with expiry_told_at set too: too old to bring up, so it closes quietly.
// --dry-run lists what would close and writes nothing.
import * as db from "../src/db.js";
import { config } from "../src/config.js";

const dryRun = process.argv.includes("--dry-run");
const QUIET_AFTER_MS = 7 * 24 * 3_600_000;

const closed = db.expireStaleAsks({ dryRun, quietOlderThanMs: QUIET_AFTER_MS });
for (const r of closed) {
  console.log(JSON.stringify({
    id: r.id, action: r.action, summary: String(r.summary ?? "").slice(0, 80),
    age_h: Math.round(r.age_ms / 3_600_000), why: r.why, quiet: r.quiet,
  }));
}
console.log(JSON.stringify({ expire_stale_asks: dryRun ? "dry_run" : "done", db: config.dbPath, count: closed.length }));
