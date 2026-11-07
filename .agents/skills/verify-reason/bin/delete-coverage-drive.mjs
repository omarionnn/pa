#!/usr/bin/env node
// "Delete my data" leaves nothing of theirs behind, proved on a CAGE database, never live.
//
//   eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')"
//   node .agents/skills/verify-reason/bin/delete-coverage-drive.mjs
//
// Seeds one row into EVERY table in the database for a test person (conversation id, number and a
// fixed integer in every column, so CHILD_SCOPE joins line up) and the same for a control person,
// runs the real src/data.js deleteData({ conversation }) with network refused, then scans every
// column of every table for the person's number. Every row left must be in a list data.js names
// (KEPT_ON_DELETE, INSTALL_WIDE, GLOBAL_TABLES); anything else is "unexplained" = a real leak.
// The control person must keep every row (a delete that reaches the wrong person is the other bug).
// Seeded values are synthetic, so an INSTALL_WIDE table "mentioning" the person is expected here.
// Exit 0 = nothing unexplained left and the control untouched.
import { resolve } from "node:path";
if (!process.env.REASON_DB_PATH || !/verify|rv-/.test(process.env.REASON_DB_PATH)) {
  console.error("REASON_DB_PATH is not a cage database — run under `caged.sh env`"); process.exit(2);
}
const repo = resolve(process.cwd());
const { db } = await import(`${repo}/src/db.js`);
const data = await import(`${repo}/src/data.js`);

const P = { addr: "+15550001234", conv: "dm:sendblue:+15550001234", n: 987654 };
const C = { addr: "+15550009999", conv: "dm:sendblue:+15550009999", n: 987655 };
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
db.exec("PRAGMA foreign_keys = OFF");

function seed(who) {
  const failed = {};
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    const names = cols.map(c => `"${c.name}"`);
    try {
      db.prepare(`INSERT OR IGNORE INTO ${t} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...cols.map(c => /INT|REAL|NUM/i.test(c.type) ? who.n : who.conv));
    } catch (e) { failed[t] = e.message.split("\n")[0]; }
  }
  return failed;
}
const mentions = (t, who) => {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  return db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${cols.map(c => `CAST("${c}" AS TEXT) LIKE ?`).join(" OR ")}`)
    .get(...cols.map(() => `%${who.addr}%`)).n;
};

const seedFailures = seed(P), controlFailures = seed(C);
const seeded = tables.filter(t => mentions(t, P) > 0).length;
const res = await data.deleteData({ conversation: P.conv, fetchImpl: async () => { throw new Error("no network in verify"); } });

const why = (t) => data.KEPT_ON_DELETE[t] ? "kept" : data.INSTALL_WIDE[t] ? "install_wide" : data.COVERAGE.global.includes(t) ? "global" : "UNEXPLAINED";
const left = {};
for (const t of tables) if (mentions(t, P)) left[t] = why(t);
const unexplained = Object.keys(left).filter(t => left[t] === "UNEXPLAINED");
const controlLost = tables.filter(t => !controlFailures[t] && mentions(t, C) === 0);
console.log(JSON.stringify({
  tables: tables.length, seeded, seed_failures: seedFailures,
  rows_deleted: Object.values(res.rows).reduce((a, b) => a + Number(b || 0), 0),
  left_by_reason: Object.groupBy ? Object.groupBy(Object.keys(left), t => left[t]) : left,
  unexplained, control_rows_lost: controlLost,
}, null, 2));
process.exit(unexplained.length || controlLost.length ? 1 : 0);
