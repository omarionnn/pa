// The owner's ops notices, once a day.
//
// Until 2026-11-06 every operator notice landed in the owner's own chat the moment it happened: a
// status check going amber, a text that failed to one number, a reminder given up on, somebody new
// texting, an event made, a held action that failed. The 7-day review counted 38 of them in his
// thread, in between his own conversations. His rule: those go into ONE daily digest, and only real
// emergencies — an outage, a service down, a spending limit near or at its cap — come through live.
//
// Which is which is decided by the code that raises the notice, from what it structurally is (the
// check's group and state, the incident's area), never by reading the words. This file only holds
// the rest and sends them once a day:
//
//   - `hold` writes a line down. A `key` makes it one line per thing: a later line under the same
//     key (a "still failing", then a "resolved") replaces the earlier one, so the digest says where
//     each thing ended up rather than every step it took.
//   - `flush`, run from the ops pass every five minutes, sends the day's lines as one message once
//     it is past DIGEST_HOUR in the install's zone, at most once a day, and only if there is
//     anything to say. Claimed before it is sent, so two passes cannot send it twice.
import * as db from "./db.js";
import { config, clock } from "./config.js";

/** The hour (install zone) the digest goes out at, or after, once a day. */
export const DIGEST_HOUR = Number(process.env.REASON_OPS_DIGEST_HOUR ?? 9);
/** The most lines one digest lists before "and N more". */
export const MAX_LINES = 15;

const LAST_DAY = "ops_digest:last_day";

function oneLine(text, max = 220) {
  const t = String(text ?? "").split("\n").map(l => l.trim()).filter(Boolean).join(" · ").replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Who and what never ride in an operator notice (owner, 2026-11-06): a line that reaches him states the
// system problem only — never a name, a number, an address or what somebody said. Each sender writes
// its line without them; this takes out anything shaped like a phone number, an email address or a
// conversation id that still slipped through (a provider's error text quoting the number, say).
// Structure only — digit runs, @-addresses, ids — never a reading of what the words mean.
const PHONE = /\+\d{10,15}\b|\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONV = /\b(?:dm|group|web):[^\s,;)]+/g;
/** An operator line with every phone number, email address and conversation id taken out. */
export function scrub(text) {
  return String(text ?? "").replace(EMAIL, "[an address]").replace(CONV, "[a conversation]")
    // A phone number's shapes (+14155559876, (415) 555-9876, 415.555.9876); a date or a time is not one.
    .replace(PHONE, "[a number]");
}

const localDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: config.installTz });
const localHour = (ms) => Number(new Date(ms).toLocaleString("en-US", { timeZone: config.installTz, hour: "numeric", hourCycle: "h23" }));

/** Keep a notice for the digest instead of sending it now. Returns the row id. */
export function hold({ text, key = "", at = clock.now() }) {
  const line = oneLine(scrub(text));
  if (!line) return null;
  if (key) {
    const open = db.db.prepare("SELECT id FROM ops_digest WHERE key = ? AND sent_at IS NULL ORDER BY id DESC LIMIT 1").get(key);
    if (open) {
      db.db.prepare("UPDATE ops_digest SET text = ?, at = ? WHERE id = ?").run(line, at, open.id);
      return open.id;
    }
  }
  return Number(db.db.prepare("INSERT INTO ops_digest (key, text, at) VALUES (?, ?, ?)").run(String(key ?? ""), line, at).lastInsertRowid);
}

/** Lines waiting for the next digest, oldest first. */
export function pending() {
  return db.db.prepare("SELECT * FROM ops_digest WHERE sent_at IS NULL ORDER BY at, id").all();
}

/** Is a digest owed right now? */
export function due(now = clock.now()) {
  if (localHour(now) < DIGEST_HOUR) return false;
  if (db.opsGet(LAST_DAY) === localDay(now)) return false;
  return pending().length > 0;
}

/** The one message: a heading, a line each, the status page last. */
export function digestText(rows, { link = "" } = {}) {
  if (!rows.length) return null;
  const lines = [`Reason daily digest — ${rows.length} ${rows.length === 1 ? "thing" : "things"} since the last one, none urgent:`];
  for (const r of rows.slice(0, MAX_LINES)) lines.push(`• ${r.text}`);
  if (rows.length > MAX_LINES) lines.push(`• and ${rows.length - MAX_LINES} more on the status page`);
  if (link) lines.push(link);
  return lines.join("\n");
}

/**
 * Send the digest if one is owed. `send(text, idempotencyKey)` delivers to the owner's thread (the
 * ops pass hands runtime.say). The day is claimed and the rows marked before the send: a crash in
 * between loses one digest, which is the safe direction; sending one twice is not.
 */
export async function flush({ send = null, link = "", now = clock.now(), log = () => {} } = {}) {
  if (!send || !due(now)) return null;
  const rows = pending();
  const day = localDay(now);
  db.opsSet(LAST_DAY, day);
  const mark = db.db.prepare("UPDATE ops_digest SET sent_at = ? WHERE id = ?");
  for (const r of rows) mark.run(now, r.id);
  // A week of sent lines is plenty to answer "what was in yesterday's digest".
  db.db.prepare("DELETE FROM ops_digest WHERE sent_at IS NOT NULL AND sent_at < ?").run(now - 7 * 24 * 3_600_000);
  const text = digestText(rows, { link });
  try {
    await send(text, `ops:digest:${day}`);
    log({ ops_digest_sent: rows.length, day });
  } catch (e) {
    log({ ops_digest_failed: (e?.message ?? String(e)).split("\n")[0].slice(0, 160) });
  }
  return text;
}

// ---------- what is an emergency ----------

/** Status-check groups whose red means Reason itself is down. */
const DOWN_GROUPS = new Set(["alive"]);
/** Status checks about a spending limit being near or at its cap, or the key having run dry. */
const CAP_CHECKS = new Set(["spend", "api_spend", "api_call_cap", "api_fallback",
  // Reason's own subscription window filling up: at 100% Reason stops replying.
  "subscription:reason"]);

/** Is this status check, as it stands, an emergency worth a live text? */
export function checkIsUrgent(check) {
  if (!check) return false;
  if (CAP_CHECKS.has(check.id)) return true;
  // Texts out going red is somebody's text failing — /ops and the digest, never a live text. A
  // channel that is down is the "messaging" incident (src/outbox.js raiseSendFailure).
  if (check.id === "outbox") return false;
  // The owner's own card link dead: buying is down for him (somebody else's is never texted at all).
  if (check.id === "card_connection") return check.state === "bad";
  // A provider Reason runs on that has kept failing past the alert delay is a service down.
  if (check.group === "services") return check.state === "bad" || check.state === "warn";
  return check.state === "bad" && DOWN_GROUPS.has(check.group);
}

/**
 * Incident areas that mean a service is down or money may have moved: texts over a channel failing,
 * the call provider refusing to place calls, a purchase whose outcome nobody knows.
 */
const URGENT_AREAS = new Set(["messaging", "calls", "purchases"]);
export const incidentIsUrgent = (area) => URGENT_AREAS.has(String(area ?? ""));
