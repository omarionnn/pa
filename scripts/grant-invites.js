// Turn invites on for ONE person while they stay dark for everybody else (owner, 2026-10-26).
//
// Owner-only CLI, run on the server (`/opt/reason`). No tool, page or text reaches it. By default
// it is a DRY RUN: it finds the account, prints what it has now and what would change, and changes
// nothing about that person (loading src/db.js still runs the same startup migrations the server
// runs on boot). It never texts anybody — telling them is a separate, owner-approved step.
//
//   dry run:  sudo -u reason node --env-file=.env scripts/grant-invites.js <number|conversation> <count>
//   apply:    sudo -u reason node --env-file=.env scripts/grant-invites.js <number|conversation> <count> --apply
//   turn off: sudo -u reason node --env-file=.env scripts/grant-invites.js <number|conversation> --off [--apply]
//
// <count> is how many invites they have left afterwards (not added on top). Turning it off keeps
// the count and every link as they are: a link already sent still works.
import { pathToFileURL } from "node:url";
import * as db from "../src/db.js";
import { config, normalizeNumber } from "../src/config.js";

/**
 * What Reason texts them once invites are on (owner's pick, 2026-10-26). Printed with every run so
 * the owner sees it; this script never sends it — that is its own owner-approved step.
 */
export function grantMessage(count) {
  return [
    `something for you 🎁 you can bring ${count} ${count === 1 ? "friend" : "friends"} into Reason.`,
    "Reason's still early and you're part of that, so it's free for you, and for the friends you bring, for good. whenever you're ready, I'll make you a link to send them.",
  ];
}

/** An account by conversation id, or by phone number on any texting channel. */
export function findAccount(who) {
  const byId = db.getAccount(String(who ?? ""));
  if (byId) return byId;
  const n = normalizeNumber(who);
  if (!n) return null;
  return db.db.prepare("SELECT * FROM accounts WHERE address = ? ORDER BY last_seen_at DESC LIMIT 1").get(n) ?? null;
}

export function grant(argv) {
  const args = argv.filter(a => !a.startsWith("--"));
  const apply = argv.includes("--apply");
  const off = argv.includes("--off");
  const [who, countArg] = args;
  if (!who || (!off && countArg == null)) return { ok: false, error: "usage: grant-invites.js <number|conversation> <count> [--apply] | <number|conversation> --off [--apply]" };
  const count = off ? null : Number(countArg);
  if (!off && !(Number.isInteger(count) && count >= 0 && count <= 100)) return { ok: false, error: "count must be a whole number from 0 to 100" };
  const acct = findAccount(who);
  if (!acct) return { ok: false, error: "no account for that number or conversation" };
  // Read without creating: db.inviteAllowance() inserts a first row, and a dry run writes nothing.
  const row = db.db.prepare("SELECT remaining, enabled FROM invite_allowances WHERE conversation_id = ?").get(acct.conversation_id);
  const before = { enabled: !!row?.enabled, remaining: row ? Number(row.remaining) : (acct.invited_by ? 0 : db.DEFAULT_INVITES) };
  const plan = off ? { enabled: false, remaining: before.remaining } : { enabled: true, remaining: count };
  const out = {
    ok: true, dryRun: !apply,
    account: { conversation: acct.conversation_id, name: acct.name || "(no name yet)", state: acct.state, operator: !!acct.is_operator },
    invitesOpenForAll: !!config.invitesOpen,
    before, after: plan,
    ...(off ? {} : { message_to_send_separately: grantMessage(count) }),
    ...(acct.name ? {} : { note: "No name on the account: their first invite link will ask them what name friends should see." }),
  };
  if (apply) out.after = db.setInvitesEnabled(acct.conversation_id, off ? { enabled: false } : { enabled: true, count });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = grant(process.argv.slice(2));
  console.log(JSON.stringify(out, null, 2));
  if (out.ok && out.dryRun) console.log("\nDRY RUN — nothing changed for them. Add --apply to make this change.");
  process.exit(out.ok ? 0 : 1);
}
