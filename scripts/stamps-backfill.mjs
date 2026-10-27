#!/usr/bin/env node
// Stamps backfill (src/stamps.js `backfill`): the stamps the record already earns, from REAL finished
// errands — done tasks, calls that got somewhere, orders placed — by the same rules that award them live.
// It only INSERTs into `stamps`; it reads tasks, calls, purchases, watches and messages and never
// changes them. It never tells anyone (no message is sent, whatever REASON_WEB_DAILY says).
//
// Which conversations: the ones REASON_WEB_DAILY allows (owner: the operator's; on: everybody with an
// account), or one named with --conversation=<id>.
//
//   node --env-file-if-exists=.env scripts/stamps-backfill.mjs            # dry run: counts only
//   node --env-file-if-exists=.env scripts/stamps-backfill.mjs --run      # write them
//   REASON_DB_PATH=/tmp/copy.db node scripts/stamps-backfill.mjs --run    # against a copy first
const args = process.argv.slice(2);
const run = args.includes("--run");
const only = args.find(a => a.startsWith("--conversation="))?.slice("--conversation=".length) ?? null;

const db = await import("../src/db.js");
const stamps = await import("../src/stamps.js");
const { dailyMode, dailyAllowedFor } = await import("../src/dailyflag.js");
const { config } = await import("../src/config.js");

const convs = only ? [only] : db.db.prepare("SELECT DISTINCT conversation_id FROM accounts").all().map(r => r.conversation_id).filter(dailyAllowedFor);
console.log(`db: ${config.dbPath} · REASON_WEB_DAILY=${dailyMode()} · ${run ? "RUN (inserts into stamps only)" : "dry run"} · ${convs.length} conversation(s)`);
if (!only && dailyMode() === "off") console.log("REASON_WEB_DAILY is off: nothing is allowed, nothing to do (name one with --conversation=)");
const before = db.db.prepare("SELECT COUNT(*) AS n FROM stamps").get().n;
const total = {};
for (const c of convs) {
  const counts = stamps.backfill(c, { dryRun: !run });
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const [t, k] of Object.entries(counts)) total[t] = (total[t] ?? 0) + k;
  // The conversation is named by its kind only, never its number.
  console.log(`  ${c.startsWith("dm:owner") ? "owner" : "a conversation"}: ${n ? JSON.stringify(counts) : "nothing new"}`);
}
const after = db.db.prepare("SELECT COUNT(*) AS n FROM stamps").get().n;
console.log(`total ${run ? "inserted" : "would insert"}: ${JSON.stringify(total)} · stamps rows ${before} → ${after}`);
