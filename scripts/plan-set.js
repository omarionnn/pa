// Set one person's plan by hand (support; owner, 2026-10-31). Owner-only CLI, run on the server.
// By default a DRY RUN: it finds the account, prints the row as it is and as it would be, and changes
// nothing (loading src/db.js still runs the server's own startup migrations). It never texts anybody.
//
//   show:     sudo -u reason node --env-file=.env scripts/plan-set.js <number|conversation>
//   set:      sudo -u reason node --env-file=.env scripts/plan-set.js <number|conversation> <trial|free|paid|lapsed|cancelled> [--sessions N] [--until YYYY-MM-DD] --apply
//   list:     sudo -u reason node --env-file=.env scripts/plan-set.js --list
//
// `free` is the grandfather status by hand (a friend let in after the ship date). `trial --sessions 0`
// starts somebody over. `paid --until <date>` marks a payment taken outside Stripe. Lapsed / paid set
// here do NOT hold or release their standing things — that follows on their next turn (plan.afterTurn)
// or on the next Stripe event; say so to whoever asked.
import { pathToFileURL } from "node:url";
import * as db from "../src/db.js";
import * as plan from "../src/plan.js";
import { normalizeNumber } from "../src/config.js";

export function findAccount(who) {
  const byId = db.getAccount(String(who ?? ""));
  if (byId) return byId;
  const n = normalizeNumber(who);
  if (!n) return null;
  return db.db.prepare("SELECT * FROM accounts WHERE address = ? ORDER BY last_seen_at DESC LIMIT 1").get(n) ?? null;
}

const viewOf = (c) => ({ ...plan.view(c), row: plan.row(c), label: plan.opsLabel(c), mode: plan.mode() });

export function run(argv) {
  const apply = argv.includes("--apply");
  if (argv.includes("--list")) {
    return { ok: true, mode: plan.mode(), people: db.listAccountsOfPeople().map(a => ({ conversation: a.conversation_id, name: a.name, plan: plan.opsLabel(a.conversation_id) ?? plan.status(a.conversation_id).status, sessions: plan.row(a.conversation_id)?.sessions_used ?? 0 })) };
  }
  const args = argv.filter(a => !a.startsWith("--"));
  const opt = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
  const [who, status] = args;
  if (!who) return { ok: false, error: "usage: plan-set.js <number|conversation> [trial|free|paid|lapsed|cancelled] [--sessions N] [--until YYYY-MM-DD] [--apply] | --list" };
  const acct = findAccount(who);
  if (!acct) return { ok: false, error: "no account for that number or conversation" };
  const c = acct.conversation_id;
  const before = viewOf(c);
  if (!status) return { ok: true, account: { conversation: c, name: acct.name || "(no name yet)", operator: !!acct.is_operator }, plan: before };
  const sessions = opt("--sessions");
  const until = opt("--until");
  const paidUntil = until ? Date.parse(until) : null;
  if (until && !Number.isFinite(paidUntil)) return { ok: false, error: "--until must be a date, e.g. 2026-11-30" };
  if (sessions != null && !/^\d+$/.test(String(sessions))) return { ok: false, error: "--sessions must be a whole number" };
  const out = { ok: true, dryRun: !apply, account: { conversation: c, name: acct.name || "(no name yet)", operator: !!acct.is_operator }, before, after: { status, sessions: sessions != null ? Number(sessions) : before.row?.sessions_used ?? 0, paid_until: paidUntil } };
  if (apply) {
    try { plan.setManually(c, { status, sessions: sessions != null ? Number(sessions) : null, paidUntil }); }
    catch (e) { return { ok: false, error: e.message }; }
    out.after = viewOf(c);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = run(process.argv.slice(2));
  console.log(JSON.stringify(out, null, 2));
  if (out.ok && out.dryRun) console.log("\nDRY RUN — nothing changed for them. Add --apply to make this change.");
  process.exit(out.ok ? 0 : 1);
}
