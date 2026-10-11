// Global pause: "pause everything" stops all outbound activity — reminders, proactive
// notifications, recurring check-ins, commitment nudges, and uncommitted external actions —
// until the user explicitly resumes. Direct questions are still answered.
//
// This is broader than a snooze (which expires at end of day and does not touch series or
// commitments) and narrower than admin_pause (which blocks all interaction). It persists
// across restarts because the state is a column on the account row, not in memory.
import * as db from "./db.js";
import { stamp, clock } from "./config.js";
import * as notice from "./notice.js";

export function isPaused(conversationId) {
  const acct = db.getAccount(conversationId);
  return !!(acct?.paused_at);
}

export function pausedAt(conversationId) {
  const acct = db.getAccount(conversationId);
  return acct?.paused_at ?? null;
}

export function pauseAll({ conversationId, said, now = clock.now() }) {
  const verbatim = String(said ?? "").trim();
  if (!verbatim) return { ok: false, error: `Say what they actually said, word for word, in 'said'.` };
  if (isPaused(conversationId)) {
    return {
      ok: false, error: "Already paused. Everything is already held — say that rather than pausing again.",
      paused_since: stamp(pausedAt(conversationId)),
    };
  }

  const settings = notice.settingsFor(conversationId, { now });
  const priorMode = settings.mode ?? "timely";

  db.setPaused(conversationId, { at: now, priorMode });
  db.setNoticePrefs(conversationId, { mode: "off", snoozeUntil: null });

  // Pause all active series.
  const seriesList = db.listSeries(conversationId);
  const pausedSeries = [];
  for (const s of seriesList) {
    if (s.state !== "active") continue;
    const r = db.setSeriesState(conversationId, s.id, "paused");
    if (r.ok) pausedSeries.push({ id: s.id, what: s.what || s.topic || `series #${s.id}` });
  }

  // Pause all active commitments.
  const commitments = db.listCommitments(conversationId, { state: "active" });
  const pausedCommitments = [];
  for (const c of commitments) {
    db.setCommitmentState(c.id, { state: "paused", why: "pause everything", at: now });
    pausedCommitments.push({ id: c.id, what: c.what || `commitment #${c.id}` });
  }

  // Cancel parked notices and their timers.
  const parked = db.parkedNotices(conversationId);
  for (const row of parked) {
    if (row.timer_id) db.cancelTimer(conversationId, row.timer_id);
    db.unparkNotice(row.id, now);
  }

  const wentOut = notice.alreadyWentOut(conversationId, { now });
  const ownReminders = ownedByThem(conversationId, now);

  db.recordAction({
    conversationId, action: "pause_everything", target: "",
    attempted: { said: verbatim },
    outcome: "ok",
    result: { series: pausedSeries.length, commitments: pausedCommitments.length, notices_dropped: parked.length },
    receipt: `Paused everything: ${pausedSeries.length} check-in(s), ${pausedCommitments.length} habit(s), initiative off.`,
  });

  return {
    ok: true, their_words: verbatim, paused_at: stamp(now),
    stopped: [
      ...pausedSeries.map(s => ({ kind: "check-in", what: s.what })),
      ...pausedCommitments.map(c => ({ kind: "habit", what: c.what })),
      ...(priorMode !== "off" ? [{ kind: "initiative", what: `was on "${priorMode}", now off` }] : []),
      ...parked.map(r => ({ kind: "heads-up", what: r.what || r.key })),
    ],
    still_coming: ownReminders,
    already_went_out: wentOut,
    say: `Confirm in ONE short line that everything is paused. Nothing unprompted until they resume.`
      + (wentOut.length ? ` ${wentOut.length} text(s) already went out today and cannot be unsent — say so honestly.` : "")
      + (ownReminders.length
        ? ` Their own reminders (${ownReminders.map(x => x.what).join("; ")}) are ALSO paused — a global pause stops everything.`
          + ` Say that, and say they come back on resume.`
        : "")
      + ` If they ask for something new while paused, ask in one line whether it is a one-off or whether they want to resume.`
      + ` Do not silently restart anything.`,
  };
}

export function resumeAll({ conversationId, now = clock.now() }) {
  if (!isPaused(conversationId)) {
    return { ok: false, error: "Not paused. There is nothing to resume — say that." };
  }

  const acct = db.getAccount(conversationId);
  const priorMode = acct.pause_prior_mode || "timely";
  const pausedSince = acct.paused_at;

  db.clearPaused(conversationId);
  db.setNoticePrefs(conversationId, { mode: priorMode, snoozeUntil: null });

  // Resume series that were paused.
  const seriesList = db.listSeries(conversationId);
  const resumed = [];
  for (const s of seriesList) {
    if (s.state !== "paused") continue;
    const r = db.setSeriesState(conversationId, s.id, "active");
    if (r.ok) {
      // Schedule the next occurrence, skipping any that would have fired during the pause.
      const next = s.next_at && s.next_at > now ? s.next_at : null;
      resumed.push({ kind: "check-in", what: s.what || s.topic || `series #${s.id}`, next: next ? stamp(next) : "needs scheduling" });
    }
  }

  // Resume commitments that were paused.
  const commitments = db.listCommitments(conversationId, { state: "paused" });
  for (const c of commitments) {
    db.setCommitmentState(c.id, { state: "active", why: "resumed", at: now });
    resumed.push({ kind: "habit", what: c.what || `commitment #${c.id}` });
  }

  db.recordAction({
    conversationId, action: "resume_everything", target: "",
    attempted: {},
    outcome: "ok",
    result: { resumed: resumed.length, was_paused_since: pausedSince },
    receipt: `Resumed: ${resumed.length} thing(s) restored, initiative back to "${priorMode}".`,
  });

  return {
    ok: true,
    paused_since: stamp(pausedSince), resumed_at: stamp(now),
    mode_restored: priorMode,
    restored: resumed,
    say: `Tell them what is back on, in a short list. Initiative is back to "${priorMode}".`
      + (resumed.length
        ? ` ${resumed.length} thing(s) restored: ${resumed.map(r => `${r.what} (${r.kind})`).join(", ")}.`
        : ` Nothing was waiting — say that.`)
      + ` Do not flood them with missed reminders. If anything time-sensitive expired during the pause, say what was missed`
      + ` rather than firing it late. Things that are still in the future pick up normally.`,
  };
}

export function pauseNote(conversationId) {
  const at = pausedAt(conversationId);
  if (!at) return "";
  return `PAUSED since ${stamp(at)}. Everything is held — no reminders, no check-ins, no proactive texts.`
    + ` You can still answer their questions. If they ask you to DO something (a task, a search, a send),`
    + ` ask in one line: "you're paused — is this a one-off, or are you resuming?" Do not silently restart`
    + ` anything. "Resume", "unpause", "start again" → resume_everything.`;
}

function ownedByThem(conversationId, now = clock.now()) {
  const out = [];
  for (const t of db.listTimers(conversationId)) {
    if (db.noticeByTimer(t.id)) continue;
    out.push({ what: `reminder: ${t.note || "something"}${t.fire_at ? ` (${stamp(t.fire_at)})` : ""}`, kind: "timer", id: t.id });
  }
  for (const t of db.listTasks(conversationId)) {
    out.push({ what: `"${t.title}"`, kind: "task", id: t.id });
  }
  return out.slice(0, 10);
}
