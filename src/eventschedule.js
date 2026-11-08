// Messages an organizer schedules for later, and the two automatic reminders (owner request 2026-11-07).
//
// A scheduled message is a blast with a time on it: the organizer's own words, built by the same
// `events.blastBody` the blast uses, to the same guests a blast reaches (every joined guest, less the
// ones who muted the event), through the same tracked deliveries. The organizer sees it, its time and
// its reach before it is set, by text (event_schedule, behind the confirm gate like event_blast) or
// on their page (src/pages/eventmanage.js, with its own confirm step), and can change or cancel it
// until it goes.
//
// The reminders are Reason's own words, built from what guests can already see: the day before at
// 6 PM, and about two hours before the start, in the event's own zone. Each is a switch per event,
// on for every event made from now on and off for the events made before (nobody's guests start
// getting texts their organizer was never told about). A reminder never gives away a hidden time:
// none goes until guests can see the time, and the place is in it only once it is shared. The
// two-hours one is skipped when it would land in the night (22:00–08:00 there) — the day-before one
// has already said it.
//
// What is code's to guarantee here, and pinned by test/event-scheduled.test.js:
//
//   - **Once.** A row is claimed (pending → sending) and its event message made in one transaction
//     (src/db.js claimScheduledMessage / claimReminder); a reminder is unique per event, kind and
//     start time. Two passes cannot both claim it, and deliveries are one per guest per message.
//   - **Survives a restart.** Everything is in the database. The sweep (Runtime._sweep, every 15 s
//     from boot) picks up whatever is due, and a row a stopped process left `sending` is finished,
//     not started again — guests who already have it are skipped by their delivery row.
//   - **Never to the wrong people or at the wrong time.** Nothing goes for a cancelled event (its
//     waiting messages are cancelled with it), nothing while the operator has it paused, nothing to a
//     guest who left or was removed (only joined guests are recipients), nothing for a time in the
//     past (refused when set), and a message whose time went by while Reason could not send it — the
//     event paused, the server down — is dropped as missed after LATE_MS rather than sent stale.
import * as db from "./db.js";
import * as events from "./events.js";
import { atLocal } from "./series.js";
import { clock } from "./config.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export const SCHEDULE = {
  /** The earliest a message can be set for: a little ahead, so "now" is a blast, not a schedule. */
  minAheadMs: 2 * 60_000,
  /** The latest: a year out. */
  maxAheadMs: 365 * DAY,
  /** Messages waiting on one event at once. */
  maxPending: 20,
  /** A message this late (Reason was down, the event was paused) is dropped as missed, never sent stale. */
  lateMs: 2 * HOUR,
  /** The longest message, as for a blast. */
  maxLength: 1500,
};

export const REMINDERS = {
  /** The day-before one: this local hour, the day before the start; it may go for this long after. */
  dayBeforeHour: 18, dayBeforeWindowMs: 3 * HOUR,
  /** The soon one: this long before the start, unless that falls in the night. */
  soonMs: 2 * HOUR, quietFrom: 22, quietUntil: 8,
};

/** The two reminders, by the name the tools and the page use. */
export const WHICH = {
  day_before: { kind: "reminder_day", column: "remind_day_before", label: "The day before", at: "6 PM the day before" },
  two_hours: { kind: "reminder_soon", column: "remind_soon", label: "Two hours before", at: "about 2 hours before it starts" },
};
const BY_KIND = Object.fromEntries(Object.entries(WHICH).map(([k, v]) => [v.kind, k]));

function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}

/** "Fri, Nov 13, 6:00 PM EST", in the event's zone. */
export function whenText(ev, ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: ev.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/** "2026-11-13T18:00" in the event's zone, for a form's datetime-local. */
export function localInput(ev, ms) {
  const p = localParts(ms, ev.tz);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// ---------- the reminders ----------

/** When this reminder goes for the event's current start, or null when it has no start. */
export function reminderAt(ev, which) {
  if (ev?.starts_at == null) return null;
  if (which === "two_hours") return ev.starts_at - REMINDERS.soonMs;
  const s = localParts(ev.starts_at, ev.tz);
  const before = new Date(Date.UTC(s.year, s.month - 1, s.day - 1));
  return atLocal({ year: before.getUTCFullYear(), month: before.getUTCMonth() + 1, day: before.getUTCDate(), hour: REMINDERS.dayBeforeHour, minute: 0 }, ev.tz);
}

/** Until when it may still go: the day-before one for a few hours, the soon one until the start. */
function windowEnd(ev, which, at) {
  return which === "two_hours" ? ev.starts_at : Math.min(at + REMINDERS.dayBeforeWindowMs, ev.starts_at);
}

function inTheNight(ev, ms) {
  const h = localParts(ms, ev.tz).hour;
  return h >= REMINDERS.quietFrom || h < REMINDERS.quietUntil;
}

/** The reminder's words, from what guests can see: the time (it never goes while that is hidden), and the place once it's shared. */
export function reminderBody(ev, which) {
  const where = ev.location_released && ev.location ? `\nwhere: ${ev.location}` : "";
  if (which === "two_hours") {
    const time = new Date(ev.starts_at).toLocaleString("en-US", { timeZone: ev.tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return `reminder: ${ev.name} starts in about 2 hours, at ${time}.${where}`;
  }
  return `reminder: ${ev.name} is tomorrow — ${events.whenLine(ev)}.${where}`;
}

/**
 * Where one reminder stands for the event as it is now, for the organizer's page and the tool:
 * `state` is one of
 *   off          switched off
 *   no_time      the event has no start time
 *   time_hidden  guests can't see the time yet, so it can't go (it will, if the time is shared in time)
 *   night        the soon one would land in the night, so it's skipped
 *   sent         it went for this start time (with how it went)
 *   too_late     its time has gone by for this start (or the event was made after it)
 *   upcoming     it will go at `at`
 */
export function reminderStatus(ev, which, now = clock.now()) {
  const w = WHICH[which];
  const on = !!ev[w.column];
  const at = reminderAt(ev, which);
  const base = { which, label: w.label, on, at, when: at != null ? whenText(ev, at) : null, preview: ev.starts_at != null ? reminderBody(ev, which) : null };
  if (at == null) return { ...base, state: "no_time" };
  const row = db.reminderRow(ev.id, w.kind, ev.starts_at);
  if (row) return { ...base, state: "sent", sent: row.message_id ? deliveryCounts(row.message_id) : null, sent_at: row.created_at };
  if (!on) return { ...base, state: "off" };
  if (which === "two_hours" && inTheNight(ev, at)) return { ...base, state: "night" };
  if (now >= windowEnd(ev, which, at) || ev.created_at > at) return { ...base, state: "too_late" };
  if (!ev.time_released) return { ...base, state: "time_hidden" };
  return { ...base, state: "upcoming" };
}

export function reminders(ev, now = clock.now()) {
  return Object.keys(WHICH).map(which => reminderStatus(ev, which, now));
}

/** Turn one reminder on or off. The caller has checked this is the organizer's event. */
export function setReminder(ev, which, enabled) {
  const w = WHICH[which];
  if (!w) return { ok: false, reason: "bad_which" };
  const after = !!ev[w.column] === !!enabled ? ev : db.updateEventRow(ev.id, { [w.column]: enabled ? 1 : 0 });
  return { ok: true, ev: after, status: reminderStatus(after, which) };
}

function deliveryCounts(messageId) {
  const ds = db.deliveriesFor(messageId).map(d => events.deliveryState(d));
  const n = (s) => ds.filter(x => x === s).length;
  return { total: ds.length, sent: n("sent"), sending: n("sending") + n("pending"), held: n("held"), failed: n("failed") };
}

// ---------- the organizer's scheduled messages ----------

/**
 * Check a message and a time before anything is written: the exact text guests would get, when it
 * goes (an instant, read as wall-clock time in the event's zone), and how many guests it would reach
 * today. `{ ok: false, reason }` — empty | too_long | bad_time | past | too_far | too_many | cancelled
 * | paused | not_found.
 */
export function plan(ev, { message, sendAt: wall, replacing = null }, now = clock.now()) {
  if (!ev) return { ok: false, reason: "not_found" };
  if (ev.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (ev.status === "paused") return { ok: false, reason: "paused" };
  const words = String(message ?? "").trim();
  if (!words) return { ok: false, reason: "empty" };
  if (words.length > SCHEDULE.maxLength) return { ok: false, reason: "too_long" };
  const sendAt = events.parseStartsAt(wall, ev.tz);
  if (sendAt == null) return { ok: false, reason: "bad_time" };
  if (sendAt < now + SCHEDULE.minAheadMs) return { ok: false, reason: "past" };
  if (sendAt > now + SCHEDULE.maxAheadMs) return { ok: false, reason: "too_far" };
  if (replacing != null) {
    const row = db.scheduledRow(replacing);
    if (!row || row.event_id !== ev.id || row.kind !== "message" || row.state !== "pending") return { ok: false, reason: "not_found" };
  } else if (db.scheduledFor(ev.id, ["pending"]).filter(r => r.kind === "message").length >= SCHEDULE.maxPending) {
    return { ok: false, reason: "too_many" };
  }
  return { ok: true, message: words, sendAt, when: whenText(ev, sendAt), local: localInput(ev, sendAt), body: events.blastBody(ev, words), reach: events.audience(ev, "scheduled") };
}

/** Plain words for a refusal from `plan`, for the page and the model alike. */
export const WHY = {
  not_found: "That scheduled message isn't waiting any more — it may have gone out or been cancelled.",
  cancelled: "The event is cancelled, so nothing can be scheduled for it.",
  paused: "Reason's operator has paused this event, so nothing can be scheduled for guests right now.",
  empty: "Write the message first.",
  too_long: `A message can be up to ${SCHEDULE.maxLength} characters.`,
  bad_time: "Pick a date and time for it to go.",
  past: "That time has already passed (or is only moments away). Pick a time at least a few minutes from now, or send it now instead.",
  too_far: "That's more than a year away. Pick a time within the next year.",
  too_many: `There are already ${SCHEDULE.maxPending} messages waiting on this event. Cancel one first.`,
};

/** Schedule one message, or change one still waiting (`replacing`). The caller has checked this is the organizer's event. */
export function schedule({ ev, conversationId, message, sendAt, replacing = null, now = clock.now() }) {
  const p = plan(ev, { message, sendAt, replacing }, now);
  if (!p.ok) return p;
  if (replacing != null) {
    if (!db.updatePendingScheduled(replacing, { body: p.message, sendAt: p.sendAt })) return { ok: false, reason: "not_found" };
    return { ok: true, changed: true, row: db.scheduledRow(replacing), ...p };
  }
  return { ok: true, row: db.insertScheduledMessage({ eventId: ev.id, conversationId, body: p.message, sendAt: p.sendAt }), ...p };
}

/** Cancel one message still waiting. Nothing is sent. */
export function cancel({ ev, id }) {
  const row = db.scheduledRow(id);
  if (!row || row.event_id !== ev.id || row.kind !== "message") return { ok: false, reason: "not_found" };
  if (!db.settlePendingScheduled(row.id, "cancelled", "cancelled by the organizer")) return { ok: false, reason: "not_found" };
  return { ok: true, cancelled: row.id };
}

/** The event was cancelled: everything still waiting on it is too. */
export function cancelAllFor(ev) {
  return db.cancelPendingScheduledFor(ev.id, "the event was cancelled");
}

/** One waiting message, as the organizer sees it. */
function viewOf(ev, row) {
  return { id: row.id, message: row.body, at: row.send_at, when: whenText(ev, row.send_at), local: localInput(ev, row.send_at), preview: events.blastBody(ev, row.body) };
}

/** What is waiting to go, soonest first, and what didn't go out lately (missed or cancelled with the event). */
export function pendingFor(ev) {
  return db.scheduledFor(ev.id, ["pending"]).filter(r => r.kind === "message").map(r => viewOf(ev, r));
}
export function missedFor(ev, now = clock.now()) {
  return db.scheduledFor(ev.id, ["missed"]).filter(r => r.kind === "message" && now - r.updated_at < 7 * DAY).map(r => ({ ...viewOf(ev, r), why: r.note }));
}

// ---------- the sweep ----------

/** Rows this process is sending right now: a slow pass is never overlapped by the next one on the same row. */
const inFlight = new Set();

async function sendClaimed({ runtime, row, ev }) {
  const message = row.message_id ? db.eventMessage(row.message_id) : null;
  if (!message) { db.finishScheduled(row.id, "cancelled", "nothing to send"); return { state: "dropped" }; }
  if (ev?.status === "cancelled" || !ev) { db.finishScheduled(row.id, "cancelled", "the event was cancelled"); return { state: "dropped" }; }
  // Paused partway (or before it began): it waits, still `sending`, and is finished once resumed.
  if (ev.status === "paused") return { state: "waiting" };
  const out = { sent: 0, failed: 0, other: 0 };
  for (const g of events.recipients(ev, message.kind)) {
    const r = await events.deliver({ runtime, message, conversationId: g.conversation_id });
    if (r.state === "sent") out.sent++; else if (r.state === "failed") out.failed++; else out.other++;
  }
  db.finishScheduled(row.id, "sent");
  return { state: "sent", ...out };
}

/** The latest a claimed row may still be sent: a message up to LATE_MS after its time, a reminder never after the start. */
function sendDeadline(row) {
  const late = row.send_at + SCHEDULE.lateMs;
  return row.kind === "message" || row.for_starts_at == null ? late : Math.min(late, row.for_starts_at);
}

async function guarded(id, fn) {
  if (inFlight.has(id)) return { state: "busy" };
  inFlight.add(id);
  try { return await fn(); } finally { inFlight.delete(id); }
}

/**
 * One pass: messages whose time has come, rows left mid-send by a process that stopped, and each
 * live event's reminders. Each row on its own — one that throws is logged and the rest go on.
 */
export async function sweep({ runtime, now = clock.now(), log = () => {} } = {}) {
  if (!events.eventsOn()) return { messages: 0, reminders: 0 };
  const out = { messages: 0, reminders: 0, resumed: 0, missed: 0, dropped: 0, failed: 0 };
  for (const due of db.dueScheduled(now)) {
    try {
      const ev = db.getEventRow(due.event_id);
      if (due.state === "sending") {
        // Left mid-send and found too late (Reason was down, or the event was paused under it): the
        // rest is dropped, never sent stale — a "starts in about 2 hours" after the start is wrong.
        if (now > sendDeadline(due)) { db.finishScheduled(due.id, "missed", "Reason couldn't finish sending it on time"); out.missed++; continue; }
        const r = await guarded(due.id, () => sendClaimed({ runtime, row: due, ev }));
        if (r.state === "sent") { out.resumed++; if (due.kind === "message") out.messages++; else out.reminders++; }
        continue;
      }
      if (!ev || ev.status === "cancelled") { db.settlePendingScheduled(due.id, "cancelled", "the event was cancelled"); out.dropped++; continue; }
      if (now - due.send_at > SCHEDULE.lateMs) {
        db.settlePendingScheduled(due.id, "missed", ev.status === "paused" ? "the event was paused when it was due" : "Reason couldn't send it on time");
        out.missed++;
        continue;
      }
      if (ev.status === "paused") continue;
      const claimed = db.claimScheduledMessage(due.id, (row) => events.blastBody(ev, row.body), "scheduled");
      if (!claimed) continue;
      const r = await guarded(claimed.id, () => sendClaimed({ runtime, row: claimed, ev }));
      if (r.state === "sent") out.messages++;
    } catch (e) {
      out.failed++;
      log({ event_scheduled_failed: due.id, error: String(e?.name ?? typeof e).slice(0, 40) });
    }
  }
  for (const ev of db.eventsWithReminders()) {
    for (const which of Object.keys(WHICH)) {
      try {
        if (reminderStatus(ev, which, now).state !== "upcoming" || now < reminderAt(ev, which)) continue;
        // Nobody to remind yet: nothing is claimed, so a guest who joins inside the window still gets it.
        if (!events.recipients(ev, "reminder").length) continue;
        const claimed = db.claimReminder({ eventId: ev.id, conversationId: ev.organizer_conversation_id, kind: WHICH[which].kind, sendAt: reminderAt(ev, which), forStartsAt: ev.starts_at, body: reminderBody(ev, which), messageKind: "reminder" });
        if (!claimed) continue;
        const r = await guarded(claimed.id, () => sendClaimed({ runtime, row: claimed, ev }));
        if (r.state === "sent") out.reminders++;
      } catch (e) {
        out.failed++;
        log({ event_reminder_failed: ev.id, which, error: String(e?.name ?? typeof e).slice(0, 40) });
      }
    }
  }
  return out;
}

/** For a log line: which reminder a row is. */
export function whichOf(kind) { return BY_KIND[kind] ?? null; }
