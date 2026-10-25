// One announcement, to the people actively texting Reason, sent later and only by the owner.
//
// This is an owner-only CLI run on the server (`/opt/reason`). No tool, page or text reaches it.
// By default it is a DRY RUN: it reads the database, prints how many people would get the text,
// how many were left out and why, and the bubbles themselves. It never prints a phone number or a
// name, and it writes nothing.
//
//   dry run:   sudo -u reason node --env-file=.env scripts/announce.js
//   real send: sudo -u reason node --env-file=.env scripts/announce.js --send --confirm=events-1025
//
// Who gets it: an account on a texting channel with an inbound message in the last 30 days.
// Left out:
//   opted-out     account paused/removed, "pause everything", unprompted texts turned off (or
//                 snoozed), a blocked number, or Sendblue saying they opted out since they last texted
//   duplicate     extra conversations for a number already counted (an opt-out on any of them
//                 covers the number)
//   already-sent  this announcement already has an outbox row for that number (any state). The
//                 outbox's unique idem_key is the ledger, so a rerun never texts anybody twice
//   quiet-hours   it is their night by the same rule unprompted texts use (src/notice.js
//                 inTheirNight: their zone, their window, 22:00-08:00 by default). Nothing is
//                 recorded for them, so a rerun in the morning picks them up
//   owner         only with --skip-owner
//
// Sending is paced (--gap-seconds, default 5) and goes through the outbox like every other text:
// both bubbles are rows before either is attempted, the second is chained behind the first, and a
// retryable failure is finished by the running service's own outbox sweep.
import { pathToFileURL } from "node:url";
import * as db from "../src/db.js";
import { inQuietHours, MODES } from "../src/notice.js";
import { attempt } from "../src/outbox.js";
import { clock, config } from "../src/config.js";

export const ANNOUNCEMENTS = {
  "events-1025": {
    bubbles: [
      "got a birthday, game night or kickback coming up? I can host it for you now: invites, updates, who's coming, and rides.\n\nread more here 👇",
      "reason.omarinyarko.com/updates",
    ],
  },
};
export const DEFAULT_ID = "events-1025";
export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TEXTING = new Set(["sendblue", "linq"]);

const digits = (address) => String(address ?? "").replace(/\D/g, "");
/** The ledger key for one recipient. The number's digits alone, so two conversations or two
 *  channels for one phone are one person, on this run and every later one. */
export const keyFor = (id, address) => `announce:${id}:${digits(address)}`;

let blocked = null;
const blockedDigits = () => blocked ??= new Set(db.db.prepare("SELECT address FROM blocked_numbers").all().map(r => digits(r.address)));

// src/notice.js settingsFor/inTheirNight, read-only: settingsFor creates a notice_sweeps row for
// anybody who has none, and a dry run must write nothing. Same precedence: their stated zone, then
// their calendar's, then the install's; their waking window, else the install's quiet hours.
function theirSettings(conversationId, now) {
  const p = db.noticePrefs(conversationId);
  const sweep = db.db.prepare("SELECT time_zone FROM notice_sweeps WHERE conversation_id = ?").get(conversationId);
  const snoozed = !!p.snoozeUntil && p.snoozeUntil > now;
  return {
    mode: snoozed ? "off" : (p.mode && MODES[p.mode] ? p.mode : "timely"),
    timeZone: p.tz || sweep?.time_zone || config.tz,
    quietStart: p.windowEnd ?? config.noticeQuietStart,
    quietEnd: p.windowStart ?? config.noticeQuietEnd,
  };
}
function inTheirNight(conversationId, now) {
  const s = theirSettings(conversationId, now);
  return inQuietHours(now, s.timeZone, { start: s.quietStart, end: s.quietEnd });
}

function optedOut(account, now) {
  // Live's accounts table predates the `state` column (CREATE TABLE IF NOT EXISTS never added it,
  // and there is no migration), so a missing column means nobody was ever paused or removed by it.
  if ((account.state ?? "active") !== "active") return true;
  if (account.paused_at) return true;
  if (blockedDigits().has(digits(account.address))) return true;
  if (theirSettings(account.conversation_id, now).mode === "off") return true;
  // Sendblue refused a text because they opted out, and they have not texted since.
  const out = db.db.prepare(`SELECT MAX(failed_at) at FROM outbox
    WHERE (conversation_id = ? OR address = ?) AND last_error_key = 'OPTED_OUT'`).get(account.conversation_id, account.address);
  if (out?.at) {
    const back = db.db.prepare("SELECT 1 FROM inbound_messages WHERE conversation_id = ? AND received_at > ? LIMIT 1")
      .get(account.conversation_id, out.at);
    if (!back) return true;
  }
  return false;
}

function alreadySent(id, address) {
  const k = keyFor(id, address);
  return !!db.db.prepare("SELECT 1 FROM outbox WHERE idem_key IN (?, ?) LIMIT 1").get(`${k}#1`, `${k}#2`);
}

/** Read-only. Who would get announcement `id` right now, and how many were left out, by reason. */
export function audience({ id = DEFAULT_ID, now = clock.now(), skipOwner = false } = {}) {
  if (!ANNOUNCEMENTS[id]) throw new Error(`no announcement called '${id}'`);
  const rows = db.db.prepare(`SELECT a.*, r.last_in FROM accounts a
    JOIN (SELECT conversation_id, MAX(received_at) last_in FROM inbound_messages
          WHERE received_at >= ? GROUP BY conversation_id) r ON r.conversation_id = a.conversation_id
    ORDER BY r.last_in DESC`).all(now - WINDOW_MS);
  blocked = null;
  // One phone, one decision: every conversation for the number is grouped first, so an opt-out (or
  // the owner) on any of them covers all of them. The most recently active one is who gets it.
  const byNumber = new Map();
  for (const a of rows) {
    if (!TEXTING.has(a.channel) || !digits(a.address)) continue;
    const who = digits(a.address);
    if (!byNumber.has(who)) byNumber.set(who, []);
    byNumber.get(who).push(a);
  }
  const excluded = { optedOut: 0, duplicate: 0, alreadySent: 0, quietHours: 0, owner: 0 };
  const recipients = [];
  for (const group of byNumber.values()) {
    const a = group[0];
    excluded.duplicate += group.length - 1;
    if (skipOwner && group.some(g => g.is_operator)) { excluded.owner++; continue; }
    if (group.some(g => optedOut(g, now))) { excluded.optedOut++; continue; }
    if (alreadySent(id, a.address)) { excluded.alreadySent++; continue; }
    if (inTheirNight(a.conversation_id, now)) { excluded.quietHours++; continue; }
    recipients.push({ conversationId: a.conversation_id, channel: a.channel, address: a.address });
  }
  return { id, recipients, excluded };
}

/**
 * The two bubbles to one person, through the outbox. The rows are written first (so the ledger
 * holds even if the process dies mid-send), marked told so a failure is never read back to them as
 * "a message of mine didn't go", then attempted in order.
 */
async function sendOne({ id, router, r }) {
  const k = keyFor(id, r.address);
  const rows = [];
  let previous = null;
  for (const [i, body] of ANNOUNCEMENTS[id].bubbles.entries()) {
    const { fresh, row } = db.enqueueOutbound({
      idemKey: `${k}#${i + 1}`, conversationId: r.conversationId, channel: r.channel, address: r.address,
      body, afterId: previous, toOwner: true, maxAttempts: config.outboxMaxAttempts,
    });
    if (fresh) db.db.prepare("UPDATE outbox SET told_at = ? WHERE id = ?").run(clock.now(), row.id);
    rows.push(row);
    previous = row.id;
  }
  let ok = true;
  for (const row of rows) {
    const res = await attempt({ id: row.id, router, log: () => {} });
    if (!res.ok) { ok = false; break; }
  }
  return ok;
}

export { inTheirNight, theirSettings };

/** The real send. Re-reads the audience, then paces through it. Never prints a number or a name. */
export async function sendAll({ id = DEFAULT_ID, router, gapMs = 5000, skipOwner = false, sleep = (ms) => new Promise(r => setTimeout(r, ms)), say = () => {} }) {
  const { recipients, excluded } = audience({ id, skipOwner });
  let sent = 0, failed = 0, deferred = 0, skipped = 0;
  for (const [i, r] of recipients.entries()) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    // Time passes while pacing: check their night and the ledger again right before each one.
    if (inTheirNight(r.conversationId, clock.now())) { deferred++; continue; }
    if (alreadySent(id, r.address)) { skipped++; continue; }
    if (await sendOne({ id, router, r })) sent++; else failed++;
    say(`${i + 1}/${recipients.length} done (sent ${sent}, not yet delivered ${failed})`);
  }
  return { sent, failed, deferred, skipped, excluded };
}

export function renderDryRun({ id, recipients, excluded }) {
  const b = ANNOUNCEMENTS[id].bubbles;
  return [
    `announcement ${id}: DRY RUN, nothing sent`,
    `recipients: ${recipients.length}`,
    `excluded: opted-out ${excluded.optedOut}, already-sent ${excluded.alreadySent}, quiet-hours ${excluded.quietHours}, duplicate ${excluded.duplicate}${excluded.owner ? `, owner ${excluded.owner}` : ""}`,
    "",
    "bubble 1:", b[0], "",
    "bubble 2:", b[1],
  ].join("\n");
}

export function parseArgs(argv) {
  const o = { id: DEFAULT_ID, send: false, confirm: null, gapSeconds: 5, skipOwner: false };
  for (const a of argv) {
    if (a === "--send") o.send = true;
    else if (a === "--skip-owner") o.skipOwner = true;
    else if (a.startsWith("--id=")) o.id = a.slice(5);
    else if (a.startsWith("--confirm=")) o.confirm = a.slice(10);
    else if (a.startsWith("--gap-seconds=")) o.gapSeconds = Number(a.slice(14));
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!ANNOUNCEMENTS[o.id]) throw new Error(`no announcement called '${o.id}'`);
  if (!(o.gapSeconds >= 1)) throw new Error("--gap-seconds must be at least 1");
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.send) {
    console.log(renderDryRun(audience({ id: o.id, skipOwner: o.skipOwner })));
    const wrote = db.db.prepare("SELECT total_changes() n").get().n;
    if (wrote) console.error(`warning: this process changed ${wrote} rows (schema upkeep on import), none by the dry run`);
    return;
  }
  if (o.confirm !== o.id) {
    console.error(`refusing to send: add --confirm=${o.id} to say you mean it`);
    process.exitCode = 2;
    return;
  }
  const { Router } = await import("../src/channels/router.js");
  const { SendblueChannel } = await import("../src/channels/sendblue.js");
  const { LinqChannel } = await import("../src/channels/linq.js");
  const router = new Router({ log: () => {} });
  router.register(new SendblueChannel());
  router.register(new LinqChannel());
  const r = await sendAll({ id: o.id, router, gapMs: o.gapSeconds * 1000, skipOwner: o.skipOwner, say: (l) => console.log(l) });
  console.log(`done: sent ${r.sent}, not yet delivered ${r.failed} (the outbox retries what it can), deferred to quiet hours ${r.deferred}, already sent ${r.skipped}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error((e?.message ?? String(e)).split("\n")[0]); process.exitCode = 1; });
}
