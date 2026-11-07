// The call audit's numbers: node --env-file-if-exists=.env scripts/call-report.js [--since 2026-10-30] [--json]
//
// Per call: duration, why it ended, cost, p50/p95 of how long the caller waited for the first thing
// said and for the first real words, and how many turns needed the holding line. Then the totals.
// No message content is read or printed.
//
// READ-ONLY: opens config.dbPath (REASON_DB_PATH, else data/reason.db) with readOnly, so no migration
// runs and nothing is written. A database from before call_turns existed still reports, with dashes.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { buildCallReport, formatCallReport } from "../src/calls/report.js";

const DATA_DIR = process.env.REASON_DATA_DIR || "data";
const path = process.env.REASON_DB_PATH || `${DATA_DIR}/reason.db`;
if (!existsSync(path)) {
  console.error(`no database at ${path}`);
  process.exit(1);
}
const at = process.argv.indexOf("--since");
const since = at > -1 ? Date.parse(process.argv[at + 1]) : 0;
if (at > -1 && !Number.isFinite(since)) {
  console.error("--since wants a date, e.g. 2026-10-30");
  process.exit(1);
}

const sqlite = new DatabaseSync(path, { readOnly: true });
// Wait out a writer's lock instead of failing at once (src/db.js BUSY_TIMEOUT_MS).
sqlite.exec("PRAGMA busy_timeout = 5000");
const report = buildCallReport(sqlite, { since });
sqlite.close();
console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatCallReport(report));
