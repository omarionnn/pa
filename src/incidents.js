// Failures raised where they happen, rather than found on the next five-minute pass.
//
// src/ops.js looks every five minutes and texts on what has STAYED wrong (#85). That is the right
// net for something nobody reported — a key that quietly stopped working, a sweep that stalled —
// but a text that never arrived, a call that could not be placed or a purchase whose result is
// unknown are known the moment they happen, by the code that just watched them fail. Waiting up to
// ten minutes to find them again by query is waiting for no reason. So the code that failed says so
// here, with what it knows: what failed, for whom, the error, and what was already tried.
//
// Four rules, and each is a piece of this file:
//
//   - **Final failures only.** A text the outbox will retry, a provider call that is about to be
//     tried again — those are not failures yet, and saying them would be the blip texts the owner
//     asked to stop getting (2026-10-23). Callers raise once the retrying is over. Something that
//     fails without a retry of its own (a runtime error) sets a `threshold`: it texts on the Nth
//     repeat in one episode, not the first.
//   - **One alert per failure.** The row is keyed by the KIND of failure (texts over sendblue failing
//     with the same error), so the fourteenth repeat updates the row the first one opened. The page
//     shows the live count; the owner's phone gets the first text, at most one "still failing, 14
//     times since 3:40pm" an hour while it keeps happening, and one "resolved".
//   - **Resolved when it stops.** A success of the same kind (the next text out over the same
//     channel to the same number) closes it at once; otherwise it closes itself after a quiet spell
//     with no repeat — and a repeat inside that spell is the same alert, never a new one.
//   - **Never about itself.** An alert text that fails to send is not raised again, or a dead
//     channel would be a loop of alerts about failing to send alerts.
//
// Whatever the hour, like the rest of ops: "your assistant is broken" is not a nudge. But only the
// alerts that ARE that — texts failing over a channel, calls that cannot be placed, a purchase whose
// outcome is unknown — are texted as they happen; every other area goes into the one daily digest
// (src/opsdigest.js, owner 2026-11-06).
import * as db from "./db.js";
import { config, clock } from "./config.js";
import * as digest from "./opsdigest.js";

const MIN = 60_000;
/** A repeat this long after the last one is a new episode, and an open one this quiet is over. */
export const QUIET_MS = 30 * MIN;
/** At most one "still failing" text per open alert in this long. */
export const REMIND_MS = 60 * MIN;
/** Idempotency-key prefix on every alert text, so the outbox can tell its own alerts apart. */
export const KEY_PREFIX = "incident:";

let sender = null;
let linker = () => "";
let logger = () => {};

/**
 * Wire the texts up. `send(text, idemKey)` hands a line to the owner's thread (through the outbox,
 * src/serve.js); `link(focus)` is the status page link. Before this, raising still records the row
 * and the page still shows it — nothing is texted, which is what the suite wants.
 */
export function start({ send = null, link = null, log = null } = {}) {
  sender = send;
  if (link) linker = link;
  if (log) logger = log;
  if (!sender) return;
  // Anything raised before this — a held action stranded by the restart, found while the runtime
  // was starting — is texted now rather than lost.
  for (const r of db.db.prepare("SELECT * FROM incidents WHERE owed = 1 AND resolved_at IS NULL").all()) {
    db.db.prepare("UPDATE incidents SET owed = 0, texted_at = ? WHERE key = ?").run(clock.now(), r.key);
    deliver(openText(r), `${r.key}@${r.first_at}:open`, r);
  }
}
export function stop() { sender = null; }

/**
 * A one-line notice to the owner on the same path the alerts use (their thread, through the outbox),
 * for a heads-up that is not a failure with a lifecycle (src/remotebrowser.js minutesAlert: the
 * month's hosted-browser minutes running low). No row, no "resolved" after it. → true once handed to
 * the outbox; false when there is nobody to tell yet (startup), so the caller can try again.
 */
export function notice(text, idem) {
  if (!sender || !text) return false;
  try {
    Promise.resolve(sender(digest.scrub(text), `${KEY_PREFIX}notice:${idem}`)).catch((e) => logger({ incident_text_failed: one(e?.message ?? e, 120) }));
    return true;
  } catch (e) { logger({ incident_text_failed: one(e?.message ?? e, 120) }); return false; }
}

const one = (s, max = 240) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** "3:40pm", or "Sat 3:40pm" when it was not today. */
export function clockWords(ms, now = clock.now()) {
  const tz = config.installTz;
  const day = (x) => new Date(x).toLocaleDateString("en-US", { timeZone: tz });
  const t = new Date(ms).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
  return day(ms) === day(now) ? t : `${new Date(ms).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${t}`;
}

const get = (key) => db.db.prepare("SELECT * FROM incidents WHERE key = ?").get(key) ?? null;

function deliver(text, idem, row = null) {
  if (!sender) return;
  // Only a service down or money that may have moved is texted as it happens; the rest is one line
  // in the daily digest, the latest word on this episode replacing the earlier one (src/opsdigest.js).
  if (row && !digest.incidentIsUrgent(row.area)) {
    try { digest.hold({ text, key: `incident:${row.key}@${row.first_at}` }); } catch (e) { logger({ incident_hold_failed: one(e?.message ?? e, 120) }); }
    return;
  }
  try {
    Promise.resolve(sender(digest.scrub(text), `${KEY_PREFIX}${idem}`)).catch((e) => logger({ incident_text_failed: one(e?.message ?? e, 120) }));
  } catch (e) { logger({ incident_text_failed: one(e?.message ?? e, 120) }); }
}

/**
 * A failure, at the point it happened.
 *
 * `key` is the kind of failure, and the whole of "one alert, not a flood" rests on it: two texts
 * failing to two people for the same reason are one key. `covers` names the ops check the same
 * failure will turn red on the next pass, so that pass does not text it a second time.
 * Returns the row as it now stands, and `texted` when this call sent something.
 */
export function raise({ key, area, what, who = "", addr = "", error = "", tried = "", next = "", covers = "", threshold = 1, at = clock.now() }) {
  if (!key || !what) return null;
  let row = get(key);
  // Over, or quiet long enough to be: this is a new episode, counted from one. One that went quiet
  // without a pass closing it is closed here WITHOUT a "resolved" text — it is failing again, and
  // "resolved" followed by "alert" in the same second would be two texts saying nothing.
  if (row && (row.resolved_at != null || at - row.last_at > QUIET_MS)) {
    db.db.prepare("DELETE FROM incidents WHERE key = ?").run(key);
    row = null;
  }
  if (!row) {
    db.db.prepare(`INSERT INTO incidents (key, area, what, who, last_addr, error, tried, next, covers, first_at, last_at, count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(key, area ?? "", one(what), one(who), String(addr ?? ""), one(error, 400), one(tried), one(next), covers, at, at);
  } else {
    db.db.prepare(`UPDATE incidents SET count = count + 1, last_at = ?, who = ?, last_addr = ?, error = ?,
      tried = CASE WHEN ? = '' THEN tried ELSE ? END WHERE key = ?`)
      .run(at, one(who) || row.who, String(addr ?? ""), one(error, 400) || row.error, one(tried), one(tried), key);
  }
  row = get(key);
  let texted = null;
  if (row.texted_at == null && row.count >= Math.max(1, threshold)) {
    // Nobody to tell yet (startup): owed, and sent by start(). Never marked told before it is.
    if (!sender) {
      db.db.prepare("UPDATE incidents SET owed = 1 WHERE key = ?").run(key);
    } else {
      db.db.prepare("UPDATE incidents SET texted_at = ?, owed = 0 WHERE key = ?").run(at, key);
      texted = openText(row);
      deliver(texted, `${key}@${row.first_at}:open`, row);
    }
  } else if (row.texted_at != null && at - (row.reminded_at ?? row.texted_at) >= REMIND_MS) {
    db.db.prepare("UPDATE incidents SET reminded_at = ? WHERE key = ?").run(at, key);
    texted = stillText(row, at);
    deliver(texted, `${key}@${row.first_at}:still:${row.count}`, row);
  }
  logger({ incident: key, count: row.count, texted: !!texted });
  return { ...get(key), texted };
}

/**
 * It is working again. `key` closes one; `prefix` closes every open one starting with it (the next
 * text out over sendblue closes "texts over sendblue failing", whatever the error was). Only an
 * alert the owner was texted about gets a "resolved" text; one that never reached its threshold
 * closes without a word.
 */
export function resolve({ key = null, prefix = null, addr = null, how = "it is working again", at = clock.now() } = {}) {
  let rows = key
    ? db.db.prepare("SELECT * FROM incidents WHERE key = ? AND resolved_at IS NULL").all(key)
    : prefix
      ? db.db.prepare("SELECT * FROM incidents WHERE resolved_at IS NULL AND substr(key, 1, ?) = ?").all(prefix.length, prefix)
      : [];
  // `addr`: only a success for the same address proves the failure is over. A text reaching
  // somebody else says nothing about a number that keeps failing; the quiet spell closes that one.
  if (addr != null) rows = rows.filter(r => !r.last_addr || r.last_addr === String(addr));
  for (const r of rows) {
    db.db.prepare("UPDATE incidents SET resolved_at = ?, resolved_how = ? WHERE key = ?").run(at, one(how, 120), r.key);
    if (r.texted_at != null) {
      deliver(`Resolved: ${r.what} — ${how}. It failed ${times(r.count)}, ${clockWords(r.first_at, at)}–${clockWords(r.last_at, at)}.`, `${r.key}@${r.first_at}:resolved`, r);
    }
    logger({ incident_resolved: r.key, how });
  }
  return rows.length;
}

/** Close everything that has gone quiet. Run from each ops pass, so a failure that just stops is still marked resolved. */
// Not `webhook:` ones: refused webhooks going quiet means nothing came in, not that one got through,
// so those close only on an accepted delivery (src/webhookalert.js resolve on a 2xx).
export function sweep(at = clock.now()) {
  const quiet = db.db.prepare("SELECT key FROM incidents WHERE resolved_at IS NULL AND last_at < ? AND substr(key, 1, 8) != 'webhook:'").all(at - QUIET_MS);
  for (const r of quiet) resolve({ key: r.key, how: `no repeat in ${Math.round(QUIET_MS / MIN)} minutes`, at });
  // Two days of closed ones is plenty for the page; the rest is history nobody reads.
  db.db.prepare("DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(at - 2 * 24 * 60 * MIN);
  return quiet.length;
}

/** The ops check ids an open alert speaks for. The ops pass stays quiet about those. */
export function coveredIds() {
  // Open ones whether texted yet or not: one under its threshold (two errors of the same kind) is
  // a thing this file decided is not news yet, and the pass texting it anyway would undo that.
  return new Set(db.db.prepare("SELECT covers FROM incidents WHERE resolved_at IS NULL AND covers != ''").all().map(r => r.covers));
}

export function open() {
  return db.db.prepare("SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY last_at DESC").all();
}

/**
 * The page's rows: one per open alert, then the ones closed in the last day. `quiet`, because the
 * text for each of these is sent from here when it happens — the five-minute pass texting it as
 * well would be the second text for one failure.
 */
export function checks(now = clock.now()) {
  const rows = db.db.prepare("SELECT * FROM incidents WHERE resolved_at IS NULL OR resolved_at >= ? ORDER BY resolved_at IS NOT NULL, last_at DESC LIMIT 20").all(now - 24 * 60 * MIN);
  return rows.map(r => {
    const live = r.resolved_at == null;
    const body = live
      ? `${r.count > 1 ? `still failing, ${times(r.count)} since ${clockWords(r.first_at, now)}` : `failed at ${clockWords(r.first_at, now)}`}`
        + `${r.error ? ` — ${digest.scrub(r.error)}` : ""}${r.tried ? ` · tried: ${r.tried}` : ""}${r.next ? ` · check next: ${r.next}` : ""}`
        + `${r.texted_at == null ? " · not texted yet (under its threshold)" : ""}`
      : `resolved ${clockWords(r.resolved_at, now)} (${r.resolved_how}) · failed ${times(r.count)} from ${clockWords(r.first_at, now)}`;
    return {
      id: `incident:${r.key}`, group: "alive", label: `Alert · ${r.what}`,
      state: live ? (r.texted_at != null ? "bad" : "warn") : "ok",
      detail: body, quiet: true,
    };
  });
}

function openText(r) {
  return [
    `Reason alert: ${r.what}.`,
    r.error ? `Error: ${r.error}` : null,
    r.tried ? `Already tried: ${r.tried}` : null,
    r.next ? `Check next: ${r.next}` : null,
    r.count > 1 ? `(${times(r.count)} since ${clockWords(r.first_at)})` : null,
    linker(`incident:${r.key}`) || null,
  ].filter(Boolean).join("\n");
}

function stillText(r, at) {
  return `Still failing: ${r.what} — ${times(r.count)} since ${clockWords(r.first_at, at)}.${r.error ? ` Last error: ${r.error}` : ""}${linker(`incident:${r.key}`) ? `\n${linker(`incident:${r.key}`)}` : ""}`;
}

function times(n) { return `${n} ${n === 1 ? "time" : "times"}`; }
