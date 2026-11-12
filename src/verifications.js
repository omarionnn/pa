// Self-verification after an action that reached the outside world (REASON_QUICK_CORRECTION).
//
// A tool coming back `ok` is the provider taking the request, not the thing holding up: an email
// Gmail accepts can bounce a minute later, an event Google wrote can be gone, a text the outbox
// handed over can fail on retry. Today the person hears about the first two never and the third
// only at the top of their next turn. So an outward action leaves a row here with a due time, the
// sweep checks it against the provider when it comes due, and if it did not hold the person gets
// ONE unprompted line starting "quick correction:" with the fix or the next step.
//
// What is checked (and nothing else yet — see docs in the PR for what was skipped):
//   email      the sent message's thread, for a bounce from mailer-daemon / postmaster
//   calendar   the event by id: still there, not cancelled
//   text       the outbox row for a text to somebody else: failed, or reported undelivered
//
// The line respects the same two things every unprompted text does: their quiet hours (deferred to
// their morning, src/notice.js) and the daily proactive cap (runtime.mayInterrupt; deferred an hour,
// and dropped after the row's tries run out). Everything in here is off unless the switch is on.
import * as db from "./db.js";
import * as google from "./google.js";
import * as notice from "./notice.js";
import * as accounts from "./accounts.js";
import { clock } from "./config.js";
import { quickCorrectionOn } from "./trustflags.js";

const MIN = 60_000;

/** When each kind is first checked, and how many checks it gets before it is left alone. */
export const SCHEDULE = Object.freeze({
  email: { afterMs: 3 * MIN, retryMs: 20 * MIN, tries: 3 },
  calendar: { afterMs: 2 * MIN, retryMs: 10 * MIN, tries: 2 },
  text: { afterMs: 2 * MIN, retryMs: 10 * MIN, tries: 3 },
});

export const KINDS = Object.keys(SCHEDULE);

db.db.exec(`
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- JSON: what to check, in the provider's own ids (message_id, event_id, outbox_id) plus the words
    -- the correction line needs (to, subject, summary).
    ref TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    max_tries INTEGER NOT NULL,
    -- due | verified | told | dropped
    state TEXT NOT NULL DEFAULT 'due',
    last_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    told_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS verifications_due ON verifications (state, due_at);
`);

const row = (r) => (r ? { ...r, ref: JSON.parse(r.ref || "{}") } : null);

/**
 * Leave a check for later. Null when the switch is off for this person or the kind is unknown —
 * so a caller can always call it and never has to know about the switch.
 */
export function schedule(conversationId, kind, ref, { now = clock.now() } = {}) {
  if (!quickCorrectionOn(conversationId)) return null;
  const s = SCHEDULE[kind];
  if (!s) return null;
  const r = db.db.prepare(`INSERT INTO verifications (conversation_id, kind, ref, due_at, max_tries, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conversationId, kind, JSON.stringify(ref ?? {}), now + s.afterMs, s.tries, now, now);
  return get(Number(r.lastInsertRowid));
}

export function get(id) {
  return row(db.db.prepare("SELECT * FROM verifications WHERE id = ?").get(id));
}

export function due(now = clock.now(), { limit = 20 } = {}) {
  return db.db.prepare("SELECT * FROM verifications WHERE state = 'due' AND due_at <= ? ORDER BY due_at LIMIT ?").all(now, limit).map(row);
}

export function listFor(conversationId) {
  return db.db.prepare("SELECT * FROM verifications WHERE conversation_id = ? ORDER BY id").all(conversationId).map(row);
}

/** Change one row, named with its person: a row id alone never changes anybody else's check. */
function set(v, fields) {
  const keys = Object.keys(fields);
  db.db.prepare(`UPDATE verifications SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND conversation_id = ?`)
    .run(...keys.map(k => fields[k]), clock.now(), v.id, v.conversation_id);
}

// ---------- the checks ----------
//
// Each returns one of:
//   { ok: true }                      it held
//   { ok: false, why }                it did not; `why` is the words for the correction line
//   { pending: true, why? }           cannot tell yet — checked again later, up to max_tries

const BOUNCER = /mailer-daemon|postmaster|mail delivery (?:subsystem|system)|delivery status notification/i;

async function checkEmail(v) {
  const ref = v.ref;
  const tok = await google.accessTokenFor(v.conversation_id, ref.account ? { account: ref.account } : {});
  if (!tok.ok) return { pending: true, why: tok.error ?? "no Google token" };
  if (!ref.thread_id) return { pending: true, why: "no thread id to look in" };
  const got = await google.api(tok.token, "GET", `/gmail/v1/users/me/threads/${encodeURIComponent(ref.thread_id)}`, {
    query: { format: "metadata", metadataHeaders: ["From", "Subject"] },
  });
  if (!got.ok) return { pending: true, why: got.error ?? `HTTP ${got.status}` };
  const messages = got.body?.messages ?? [];
  const bounce = messages.find(m => m.id !== ref.message_id && (m.payload?.headers ?? []).some(h => /^from$/i.test(h.name) && BOUNCER.test(String(h.value ?? ""))));
  if (bounce) {
    const subject = (bounce.payload?.headers ?? []).find(h => /^subject$/i.test(h.name))?.value ?? "";
    return { ok: false, why: subject ? `it bounced (${String(subject).slice(0, 80)})` : "it bounced" };
  }
  return { ok: true };
}

async function checkCalendar(v) {
  const ref = v.ref;
  const tok = await google.accessTokenFor(v.conversation_id, ref.account ? { account: ref.account } : {});
  if (!tok.ok) return { pending: true, why: tok.error ?? "no Google token" };
  if (!ref.event_id) return { pending: true, why: "no event id" };
  const got = await google.api(tok.token, "GET", `/calendar/v3/calendars/primary/events/${encodeURIComponent(ref.event_id)}`);
  if (!got.ok && (got.status === 404 || got.status === 410)) return { ok: false, why: "it isn't on the calendar any more" };
  if (!got.ok) return { pending: true, why: got.error ?? `HTTP ${got.status}` };
  if (got.body?.status === "cancelled") return { ok: false, why: "it shows as cancelled" };
  return { ok: true };
}

async function checkText(v) {
  const ref = v.ref;
  const out = ref.outbox_id != null ? db.getOutbound(ref.outbox_id) : null;
  if (!out) return { pending: true, why: "no outbox row" };
  // The outbox pass may already have told them (ownerFailureLine); then there is nothing to add.
  if (out.state === "failed") return out.owner_told_at ? { ok: true, already_told: true } : { ok: false, why: out.last_error || "it never went out", outbox: out };
  if (out.state === "sent") {
    if (String(out.delivery_status ?? "").toUpperCase() === "ERROR") return { ok: false, why: out.last_error || "the carrier reported it was not delivered", outbox: out };
    return { ok: true };
  }
  return { pending: true, why: `still ${out.state}` };
}

const CHECKERS = { email: checkEmail, calendar: checkCalendar, text: checkText };

/** For tests: what checks one kind. `null` puts the real one back. */
const stubs = new Map();
export function setChecker(kind, fn) { if (fn) stubs.set(kind, fn); else stubs.delete(kind); }

// ---------- the line ----------

const who = (ref) => {
  const to = Array.isArray(ref.to) ? ref.to.filter(Boolean).join(", ") : String(ref.to ?? "").trim();
  return to || "them";
};

/** Code's words, so a correction about Reason's own plumbing is never the model's to soften. */
export function correctionLine(v, why) {
  const ref = v.ref ?? {};
  const w = String(why ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  switch (v.kind) {
    case "email":
      return `quick correction: the email${ref.subject ? ` "${ref.subject}"` : ""} to ${who(ref)} didn't get through — ${w}. want me to try another address, or will you send it yourself?`;
    case "calendar":
      return `quick correction: "${ref.summary ?? "that event"}" isn't on your calendar after all — ${w}. want me to put it back on?`;
    case "text":
      return `quick correction: that text to ${who(ref)} didn't go through — ${w}. want me to try again, or will you reach them yourself?`;
    default:
      return `quick correction: ${w}.`;
  }
}

// ---------- the sweep step ----------

/**
 * One pass over what is due. `runtime` supplies the line to them (`_tell`), the cap (`mayInterrupt`)
 * and the log. Returns counts, which is what the tests assert on.
 */
export async function pass({ runtime, now = clock.now(), log = runtime?.log ?? (() => {}) } = {}) {
  const out = { due: 0, verified: 0, told: 0, retried: 0, deferred: 0, dropped: 0 };
  for (const v of due(now)) {
    const c = v.conversation_id;
    if (!quickCorrectionOn(c)) { set(v, { state: "dropped", last_note: "switch off" }); out.dropped++; continue; }
    out.due++;
    const s = SCHEDULE[v.kind];
    const check = stubs.get(v.kind) ?? CHECKERS[v.kind];
    let r;
    try { r = await check(v); } catch (e) { r = { pending: true, why: (e?.message ?? String(e)).split("\n")[0] }; }

    if (r?.ok) { set(v, { state: "verified", last_note: r.already_told ? "already told" : "held" }); out.verified++; continue; }
    if (r?.pending || !r) {
      const tries = v.tries + 1;
      if (tries >= v.max_tries) { set(v, { state: "dropped", tries, last_note: `could not tell: ${r?.why ?? ""}`.trim() }); out.dropped++; }
      else { set(v, { tries, due_at: now + s.retryMs, last_note: `not yet: ${r?.why ?? ""}`.trim() }); out.retried++; }
      continue;
    }

    // It did not hold. Their night, then their day's allowance, decide WHEN — never whether.
    if (notice.inTheirNight(c, now)) {
      const st = notice.settingsFor(c, { now });
      const at = notice.quietEndsAt(now, st.timeZone, { start: st.quietStart, end: st.quietEnd });
      set(v, { due_at: at, last_note: `failed: ${r.why}; waiting for their morning` });
      out.deferred++;
      continue;
    }
    if (typeof runtime?.mayInterrupt === "function" && !runtime.mayInterrupt(c)) {
      const tries = v.tries + 1;
      if (tries >= v.max_tries) { set(v, { state: "dropped", tries, last_note: `failed: ${r.why}; over the day's proactive cap` }); out.dropped++; }
      else { set(v, { tries, due_at: now + 60 * MIN, last_note: `failed: ${r.why}; over the day's proactive cap` }); out.deferred++; }
      continue;
    }

    const line = correctionLine(v, r.why);
    let sent;
    try { sent = await runtime._tell(c, line, { idempotencyKey: `quickfix:${v.id}` }); }
    catch (e) { sent = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    if (sent?.ok || sent?.queued) {
      set(v, { state: "told", told_at: now, last_note: `failed: ${r.why}` });
      // The outbox's own owner line about this row would now say it twice.
      if (r.outbox?.id != null) db.markOwnerTold(r.outbox.id);
      try { accounts.countUse(c, "proactive"); } catch { /* the line went; the count is best-effort */ }
      log({ quick_correction: v.id, kind: v.kind, conversation: c });
      out.told++;
    } else {
      const tries = v.tries + 1;
      log({ quick_correction_failed: v.id, kind: v.kind, conversation: c, why: sent?.error ?? "no reason given" });
      if (tries >= v.max_tries) { set(v, { state: "dropped", tries, last_note: `failed: ${r.why}; could not tell them` }); out.dropped++; }
      else { set(v, { tries, due_at: now + s.retryMs, last_note: `failed: ${r.why}; could not tell them yet` }); out.retried++; }
    }
  }
  return out;
}
