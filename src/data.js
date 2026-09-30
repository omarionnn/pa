// Your data, in one command.
//   npm run data:export              everything, as JSON, to stdout
//   npm run data:export -- dm:owner  one conversation only
//   npm run data:delete -- --yes             wipe everything
//   npm run data:delete -- dm:owner --yes    wipe one conversation
//
// Deletion is real and immediate. It refuses to run without --yes.
import { db } from "./db.js";
import { config } from "./config.js";

const TABLES = ["conversations", "plans", "timers", "memories", "action_ledger", "confirmations"];
// connected_accounts is not per-conversation; it is scoped to the install.
const GLOBAL_TABLES = ["connected_accounts"];

const args = process.argv.slice(2);
const mode = args[0] === "delete" ? "delete" : "export";
const rest = args.slice(1).filter(a => a !== "--yes");
const yes = args.includes("--yes");
const conversation = rest[0] ?? null;

function keyColumn(table) {
  return table === "conversations" ? "id" : "conversation_id";
}

if (mode === "export") {
  const out = { install: { db: config.dbPath, owner: config.ownerName, exported_at: new Date().toISOString() }, scope: conversation ?? "all", tables: {} };
  for (const t of TABLES) {
    out.tables[t] = conversation
      ? db.prepare(`SELECT * FROM ${t} WHERE ${keyColumn(t)} = ?`).all(conversation)
      : db.prepare(`SELECT * FROM ${t}`).all();
  }
  for (const t of GLOBAL_TABLES) out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(0);
}

if (!yes) {
  console.error(`This deletes ${conversation ? `conversation '${conversation}'` : "EVERYTHING"} from ${config.dbPath}. It cannot be undone.`);
  console.error(`Export first:  npm run data:export${conversation ? ` -- ${conversation}` : ""} > reason-export.json`);
  console.error(`Then re-run with --yes.`);
  process.exit(1);
}

const deleted = {};
for (const t of TABLES) {
  const r = conversation
    ? db.prepare(`DELETE FROM ${t} WHERE ${keyColumn(t)} = ?`).run(conversation)
    : db.prepare(`DELETE FROM ${t}`).run();
  deleted[t] = Number(r.changes);
}
if (!conversation) {
  for (const t of GLOBAL_TABLES) deleted[t] = Number(db.prepare(`DELETE FROM ${t}`).run().changes);
}
console.log(JSON.stringify({ deleted_from: config.dbPath, scope: conversation ?? "all", rows: deleted }, null, 2));
