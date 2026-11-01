// Set one person's plan by hand (support; owner, 2026-10-31). Owner-only CLI, run on the server.
// By default a DRY RUN: it finds the account, prints the row as it is and as it would be, and changes
// nothing (loading src/db.js still runs the server's own startup migrations). It never texts anybody.
//
//   show:     sudo -u reason node --env-file=.env scripts/plan-set.js <number|conversation>
//   set:      sudo -u reason node --env-file=.env scripts/plan-set.js <number|conversation> <trial|free|paid|lapsed|cancelled> [--sessions N] [--until YYYY-MM-DD] [--last-inbound none|<ISO time>] --apply
//   list:     sudo -u reason node --env-file=.env scripts/plan-set.js --list
//
// `free` is the grandfather status by hand (a friend let in after the ship date). `trial --sessions 0`
// starts somebody over. `--last-inbound none` forgets when they last texted, so their very next text
// starts a new session (`trial --sessions 24 --last-inbound none` puts the 25th on their next text; the
// output's `win` says whether the ask will go then or the trial runs on — src/plan.js, the win rule). `paid --until <date>` marks a payment taken outside Stripe. Lapsed / paid set
// here do NOT hold or release their standing things on the spot — that follows on their next turn
// (plan.afterTurn releases what the paywall held once they are no longer lapsed, and holds on a lapse)
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

const viewOf = (c) => ({ ...plan.view(c), win: plan.hasWin(c), row: plan.row(c), label: plan.opsLabel(c), mode: plan.mode() });

export function run(argv) {
  const apply = argv.includes("--apply");
  if (argv.includes("--list")) {
    return { ok: true, mode: plan.mode(), people: db.listAccountsOfPeople().map(a => ({ conversation: a.conversation_id, name: a.name, plan: plan.opsLabel(a.conversation_id) ?? plan.status(a.conversation_id).status, sessions: plan.row(a.conversation_id)?.sessions_used ?? 0 })) };
  }
  const args = argv.filter(a => !a.startsWith("--"));
  const opt = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
  const [who, status] = args;
  if (!who) return { ok: false, error: "usage: plan-set.js <number|conversation> [trial|free|paid|lapsed|cancelled] [--sessions N] [--until YYYY-MM-DD] [--last-inbound none|<ISO time>] [--apply] | --list" };
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
  const lastRaw = opt("--last-inbound");
  let lastInboundAt;
  if (lastRaw != null) {
    if (lastRaw === "none" || lastRaw === "null") lastInboundAt = null;
    else { lastInboundAt = Date.parse(lastRaw); if (!Number.isFinite(lastInboundAt)) return { ok: false, error: "--last-inbound must be none or a time, e.g. 2026-11-01T17:00:00Z" }; }
  }
  const out = { ok: true, dryRun: !apply, account: { conversation: c, name: acct.name || "(no name yet)", operator: !!acct.is_operator }, before, after: { status, sessions: sessions != null ? Number(sessions) : before.row?.sessions_used ?? 0, paid_until: paidUntil, ...(lastRaw != null ? { last_inbound_at: lastInboundAt } : {}) } };
  if (apply) {
    try { plan.setManually(c, { status, sessions: sessions != null ? Number(sessions) : null, paidUntil, lastInboundAt }); }
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
