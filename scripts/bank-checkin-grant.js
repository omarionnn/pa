// Record that the OWNER said yes to one of their own check-ins reading their bank (owner, 2026-11-14).
//
// Owner-only CLI, run on the server (`/opt/reason`). No tool, page or text reaches it. By default it is
// a DRY RUN: it finds the standing thing, prints what it has now and what would change, and changes
// nothing. It never texts anybody. It refuses for any account that is not the operator's own: everybody
// else gives this permission only with their own typed yes (src/bankgrant.js).
//
//   list:     sudo -u reason node --env-file=.env scripts/bank-checkin-grant.js --list
//   dry run:  sudo -u reason node --env-file=.env scripts/bank-checkin-grant.js --series <id>
//   apply:    sudo -u reason node --env-file=.env scripts/bank-checkin-grant.js --series <id> --apply
//   (or --timer <id> for a one-off timer or a chain Reason keeps going)
//
// What is printed is ids, schedules and states: never a check-in's words or anything from the bank.
import { pathToFileURL } from "node:url";
import * as db from "../src/db.js";
import * as accounts from "../src/accounts.js";
import * as bankgrant from "../src/bankgrant.js";
import { config } from "../src/config.js";

export const NOTE = "owner said yes on 2026-11-14";

const isOperatorsOwn = (c) => {
  if (!c || c !== config.ownerConversation) return false;
  try { return !!accounts.ownerOf(c).isOperator; } catch { return false; }
};
const valueOf = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

export function run(argv) {
  const apply = argv.includes("--apply");
  const owner = config.ownerConversation;
  if (argv.includes("--list")) {
    if (!isOperatorsOwn(owner)) return { ok: false, error: "the owner conversation is not the operator's account on this install" };
    // The money words a check-in's own words carry (e.g. "transactions"), never the words themselves.
    const moneyWords = (w) => [...new Set((String(w ?? "").toLowerCase().match(/\b(bank|banking|spend|spending|spent|transactions?|purchases?|charges?|balances?|budget|expenses?|money|plaid|daily|weekly|monthly|recap|summary)\b/g) ?? []))];
    const series = db.listSeries(owner).map(s => ({ series_id: s.id, state: s.state, rule: s.rule, next_at: s.next_at ? new Date(s.next_at).toISOString() : null, about_money: bankgrant.aboutMoney(s.what), money_words: moneyWords(s.what) }));
    const grants = bankgrant.grantsOf(owner).map(g => ({ standing: g.standing, state: g.state, actions: g.actions, periods: g.periods, note: g.note }));
    return { ok: true, series, grants };
  }
  const sid = valueOf(argv, "--series"), tid = valueOf(argv, "--timer");
  if ((sid == null) === (tid == null)) return { ok: false, error: "usage: bank-checkin-grant.js --list | --series <id> [--apply] | --timer <id> [--apply]" };
  const id = Number(sid ?? tid);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "the id must be a whole number" };
  // Found without the owner's scope first, so a standing thing of somebody else's is refused by name, not "not found".
  const row = sid != null ? db.seriesById(id) : db.db.prepare("SELECT * FROM timers WHERE id = ?").get(id);
  if (!row) return { ok: false, error: `no ${sid != null ? "series" : "timer"} #${id}` };
  if (!isOperatorsOwn(row.conversation_id)) return { ok: false, error: "refused: that check-in is not on the operator's own account. Anyone else says yes themselves." };
  if (sid != null && row.state === "ended") return { ok: false, error: `series #${id} has ended` };
  if (tid != null && (row.cancelled_at || (row.fired_at && row.chained_from == null && row.series_id == null))) return { ok: false, error: `timer #${id} is no longer pending` };
  const s = bankgrant.standingOf(row.conversation_id, sid != null ? (db.pendingSeriesTimers(id)[0] ?? { conversation_id: row.conversation_id, series_id: id }) : row);
  if (!s) return { ok: false, error: "could not tell which check-in that is" };
  const before = bankgrant.grantOf(owner, s.key);
  const out = {
    ok: true, dryRun: !apply, standing: s.key, about_money: bankgrant.aboutMoney(s.words),
    before: before ? { state: before.state, actions: before.actions, periods: before.periods, note: before.note } : null,
    after: { state: "granted", actions: bankgrant.ACTIONS, periods: bankgrant.periodsFor(s.words), note: NOTE },
  };
  if (apply) {
    const g = bankgrant.recordOwnerYes(owner, s.key, { standingWords: s.words, note: NOTE });
    out.after = { state: g.state, actions: g.actions, periods: g.periods, note: g.note };
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = run(process.argv.slice(2));
  console.log(JSON.stringify(out, null, 2));
  if (out.ok && out.dryRun && !process.argv.includes("--list")) console.log("\nDRY RUN — nothing changed. Add --apply to record the grant.");
  process.exit(out.ok ? 0 : 1);
}
