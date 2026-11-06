// Global pause: "pause everything" stops all outbound activity — reminders, proactive
// notifications, recurring check-ins, commitment nudges, and uncommitted external actions —
// until the user explicitly resumes. Direct questions are still answered.
//
// This is broader than a snooze (which expires at end of day and does not touch series or
// commitments) and narrower than admin_pause (which blocks all interaction). It persists
// across restarts because the state is a column on the account row, not in memory.
import * as db from "./db.js";
import { stamp, clock, config } from "./config.js";
import * as notice from "./notice.js";
import * as series from "./series.js";

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
    // series.pause, not the bare state change: it also calls off the firing already armed, which
    // would otherwise sit due through the pause and go out the moment it lifted.
    const r = series.pause({ conversationId, seriesId: s.id });
    if (r.ok) pausedSeries.push({ id: s.id, what: s.what || s.topic || `series #${s.id}` });
  }

  // Pause all active commitments.
  const commitments = db.listCommitments(conversationId, { state: "active" });
  const pausedCommitments = [];
  for (const c of commitments) {
    db.setCommitmentState(c.id, { state: "paused", why: "pause everything", at: now });
    pausedCommitments.push({ id: c.id, what: c.what || `commitment #${c.id}` });
  }

  // Repeating checks Reason kept going itself (a timer set from a timer) are called off, not held:
  // a chain has nothing to resume, and a stopped scan must not restart on "resume" or START.
  const chains = db.pendingChainedTimers(conversationId).map(t => ({ id: t.id, what: t.label || t.note }));
  series.stopChains(conversationId);

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
      ...chains.map(c => ({ kind: "repeating check (stopped for good)", what: c.what })),
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

/**
 * Lift the pause.
 *
 * What it does NOT do by default is bring back the standing check-ins and scans: "Stop" then
 * "Start" (or the carrier's STOP/START) brought back a scan somebody had stopped (2026-11). Their
 * check-ins stay paused unless their words asked for them — `checkins: "all"` when they said to turn
 * everything back on, or the ids they named. The rest are listed so the model can ask once.
 *
 * Reminders whose time passed during the pause are not fired late: they are finished with here and
 * listed as missed, so the reply can say what was missed once instead of a burst of stale texts.
 */
export function resumeAll({ conversationId, now = clock.now(), checkins = null }) {
  if (!isPaused(conversationId)) {
    return { ok: false, error: "Not paused. There is nothing to resume — say that." };
  }

  const acct = db.getAccount(conversationId);
  const priorMode = acct.pause_prior_mode || "timely";
  const pausedSince = acct.paused_at;

  db.clearPaused(conversationId);
  db.setNoticePrefs(conversationId, { mode: priorMode, snoozeUntil: null });

  // Missed while paused: held, never fired, and long past their moment now (config.timerLateMs).
  // Not sent late. One that is only just due still fires on the next sweep.
  const missed = [];
  for (const t of db.listTimers(conversationId)) {
    if (!(now - t.fire_at > config.timerLateMs)) continue; // still on time, or only just due: it fires
    if (t.created_at != null && Math.abs(t.fire_at - t.created_at) <= 1_000) continue; // a "do this now" event: it runs
    db.markTimerSkipped(t.id, { why: "missed while paused" });
    if (!t.series_id && t.chained_from == null && !db.noticeByTimer(t.id)) missed.push({ what: t.label || t.note, was_for: stamp(t.fire_at) });
  }

  // Series that were paused come back only when their words asked for them.
  const want = checkins === "all" ? "all" : new Set((Array.isArray(checkins) ? checkins : []).map(Number));
  const seriesList = db.listSeries(conversationId);
  const resumed = [];
  const stillPaused = [];
  for (const s of seriesList) {
    if (s.state !== "paused") continue;
    if (want !== "all" && !want.has(Number(s.id))) {
      stillPaused.push({ series_id: s.id, what: s.what || `series #${s.id}` });
      continue;
    }
    const r = series.resume({ conversationId, seriesId: s.id, now });
    if (r.ok) resumed.push({ kind: "check-in", what: s.what || `series #${s.id}`, next: r.series?.next ?? "needs scheduling" });
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
    result: { resumed: resumed.length, still_paused: stillPaused.length, missed: missed.length, was_paused_since: pausedSince },
    receipt: `Resumed: ${resumed.length} thing(s) restored, initiative back to "${priorMode}".`,
  });

  return {
    ok: true,
    paused_since: stamp(pausedSince), resumed_at: stamp(now),
    mode_restored: priorMode,
    restored: resumed,
    ...(stillPaused.length ? { still_paused: stillPaused } : {}),
    ...(missed.length ? { missed_while_paused: missed } : {}),
    say: `Tell them what is back on, in a short list. Initiative is back to "${priorMode}".`
      + (resumed.length
        ? ` ${resumed.length} thing(s) restored: ${resumed.map(r => `${r.what} (${r.kind})`).join(", ")}.`
        : ` Nothing was waiting — say that.`)
      + (stillPaused.length
        ? ` Their standing check-ins are STILL STOPPED (${stillPaused.map(x => x.what).join("; ")}): a resume does not bring back what they stopped.`
          + ` Ask once, in one line, whether they want any of them back; series_resume only the ones they name.`
        : "")
      + (missed.length ? ` ${missed.length} reminder(s) came due while paused and were NOT sent late: say so in one line.` : "")
      + ` Never fire anything late. Things that are still in the future pick up normally.`,
  };
}

export function pauseNote(conversationId) {
  const at = pausedAt(conversationId);
  if (!at) return "";
  return `PAUSED since ${stamp(at)}. Everything is held — no reminders, no check-ins, no proactive texts.`
    + ` You can still answer their questions. If they ask you to DO something (a task, a search, a send),`
    + ` ask in one line: "you're paused — is this a one-off, or are you resuming?" Do not silently restart`
    + ` anything. "Resume", "unpause", "start again" → resume_everything; it brings back their check-ins only when they ask for those too.`;
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
