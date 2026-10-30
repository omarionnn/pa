// The daily edition (owner's design handoff 2026-10-27, ~/Desktop/reason-daily-handoff-2026-10-27,
// HANDOFF.md §1): Reason Web's Home as a morning paper, behind REASON_WEB_DAILY (src/dailyflag.js).
//
// One edition per person per local day, written overnight in THEIR zone (notice.settingsFor) by the
// runtime's own sweep (Runtime.daily → sweepDaily): no cron, no timer of its own. What it says is read
// from real rows, deterministically:
//
//   overnight  what happened since they last looked, newest first: an approval asked (decision, with
//              the two replies a tap sends into the thread as if typed), a task finished (done) or
//              stopped (update), a message Reason sent on its own (update, linked to that message)
//   linesOut   what Reason is keeping an eye on: open watches, armed reminders/calls, standing series
//   question   at most one a day: an open guess from Memory (Reason's own reading of them), asked
//              plainly. Answered → a fact in their name (the /web/memory guess path); "Ask me later"
//              → not asked again for SKIP_DAYS days
//   pickup     the shared thread's last two lines, and where the last one was said
//
// Only the greeting (and the guess put as a question) is written by a model, once, on the claude-cli
// subscription in the BACKGROUND lane (src/background.js) — never the billed API, never on a request.
// The fixed moments keep fixed words: the first edition, a quiet night, a return after days away.
// When no edition exists yet for today the page draws one from live data with the deterministic
// greeting (editionFor), so Home never waits on a model.
//
// "Since they last looked" is the later of their last message in the thread (any channel) and the
// last time they opened this page on an earlier day (daily_looks). Away for more than a day, the
// greeting names the day they left and Overnight covers the whole gap (capped at GAP_DAYS).
//
// No streaks, no counts of visits: `issue` counts editions WRITTEN for them since they joined, and a
// missed day changes nothing.
import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import { clock, config } from "./config.js";
import * as notice from "./notice.js";
import { ongoing, approvals as pendingApprovals } from "./ongoing.js";
import { askStructuredViaCli } from "./backends/cli.js";
import * as background from "./background.js";
import { dailyAllowedFor } from "./dailyflag.js";
import { WEB, webAllowedFor } from "./web.js";
import { hasOpsKeyLink } from "./opsredact.js";
import { displayText } from "./pages/webnotes.js";

/** The local hour an edition is written from (overnight, before anyone's morning). */
export const EDITION_HOUR = 4;
/** Overnight shows this many, then "N more in the thread". */
export const OVERNIGHT_MAX = 5;
/** Lines out shows at most this many (soonest and most pressing first). */
export const LINES_MAX = 6;
/** A skipped question is not asked again for this long. */
export const SKIP_DAYS = 7;
/** Overnight never reaches further back than this, however long they were away. */
export const GAP_DAYS = 14;
/** A line Reason sends this soon after one of theirs is an answer, not news. */
export const REPLY_MS = 15 * 60_000;
const DAY = 24 * 60 * 60_000;

export const FIRST_GREETING = "first edition. it'll fill up as I do things for you.";
export const FIRST_EMPTY = "Nothing yet. Text me something to start.";
export const QUIET_GREETING = "quiet night. nothing needed you.";
export const SIGN_OFF = "see you tomorrow. or don't, I'll keep the page.";
export const QUESTION_WHY = "That's my guess from what you've told me. Say if it's right and I'll stop guessing.";
export const DECISION = [
  { label: "Yes, go ahead", reply: "Yes, go ahead.", primary: true },
  { label: "Not now", reply: "Not now.", primary: false },
];
export const ANSWERS = [{ label: "Yes, that's right", value: "yes" }, { label: "No", value: "no" }];

db.db.exec(`
  CREATE TABLE IF NOT EXISTS daily_editions (
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,
    issue INTEGER NOT NULL,
    since INTEGER,
    edition TEXT NOT NULL,
    greeting_by TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, day)
  );
  CREATE TABLE IF NOT EXISTS daily_looks (
    conversation_id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    at INTEGER NOT NULL,
    before_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS daily_questions (
    conversation_id TEXT NOT NULL,
    day TEXT NOT NULL,
    question_key TEXT NOT NULL,
    outcome TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS daily_questions_by_conv ON daily_questions (conversation_id, question_key, at);
`);

// ---------------------------------------------------------------- time, in their zone

export const tzOf = (conversationId, now = clock.now()) => {
  try { return notice.settingsFor(conversationId, { now }).timeZone || config.tz; } catch { return config.tz; }
};
const parts = (at, tz) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  .formatToParts(new Date(at)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
export const localDay = (at, tz) => new Date(at).toLocaleDateString("en-CA", { timeZone: tz });
export const localHour = (at, tz) => parts(at, tz).hour % 24;
/** The instant their local day began. */
export function dayStart(at, tz) {
  const p = parts(at, tz);
  let t = at - (((p.hour % 24) * 60 + p.minute) * 60 + p.second) * 1000 - (at % 1000);
  // A day the clocks change is 23 or 25 hours long: step to the real local midnight.
  for (let i = 0; i < 3; i++) {
    const q = parts(t, tz);
    const off = ((q.hour % 24) * 60 + q.minute) * 60_000;
    if (!off) break;
    t += localDay(t, tz) === localDay(at, tz) ? -off : 24 * 60 * 60_000 - off;
  }
  return t;
}
const fmt = (tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o });
export const timeLabel = (at, now, tz) => {
  const t = fmt(tz, { hour: "numeric", minute: "2-digit" }).format(at).toUpperCase();
  return now - at < 20 * 60 * 60_000 ? t : `${fmt(tz, { weekday: "short" }).format(at).toUpperCase()} ${t}`;
};
const dueLabel = (at, now, tz) => {
  const t = fmt(tz, { hour: "numeric", minute: "2-digit" }).format(at).toUpperCase();
  if (localDay(at, tz) === localDay(now, tz)) return `TODAY ${t}`;
  if (at - now < 6 * DAY) return `${fmt(tz, { weekday: "short" }).format(at).toUpperCase()} ${t}`;
  return `${fmt(tz, { month: "short", day: "numeric" }).format(at).toUpperCase()} ${t}`;
};

// ---------------------------------------------------------------- since they last looked

/** Opening the edition is looking. Remembers the last look of an earlier day, which today's edition counts from. */
export function noteLook(conversationId, now = clock.now()) {
  const day = localDay(now, tzOf(conversationId, now));
  const row = db.db.prepare("SELECT day, at, before_at FROM daily_looks WHERE conversation_id = ?").get(conversationId);
  if (!row) db.db.prepare("INSERT INTO daily_looks (conversation_id, day, at, before_at) VALUES (?, ?, ?, NULL)").run(conversationId, day, now);
  else if (row.day === day) db.db.prepare("UPDATE daily_looks SET at = ? WHERE conversation_id = ?").run(now, conversationId);
  else db.db.prepare("UPDATE daily_looks SET day = ?, at = ?, before_at = ? WHERE conversation_id = ?").run(day, now, row.at, conversationId);
}

/** When they last looked before today began: their last message, or their last look at this page on an earlier day. Null: never. */
export function lastLookBefore(conversationId, todayStart) {
  const said = db.db.prepare("SELECT MAX(at) AS at FROM messages WHERE conversation_id = ? AND role = 'user' AND deleted_at IS NULL AND at < ?").get(conversationId, todayStart)?.at ?? null;
  const row = db.db.prepare("SELECT day, at, before_at FROM daily_looks WHERE conversation_id = ?").get(conversationId);
  const looked = row ? (row.at < todayStart ? row.at : row.before_at) : null;
  const best = Math.max(said ?? 0, looked ?? 0);
  return best > 0 ? best : null;
}

/** The window Overnight covers, and whether they were away for more than a day. */
export function windowFor(conversationId, now = clock.now(), tz = tzOf(conversationId, now)) {
  const todayStart = dayStart(now, tz);
  const last = lastLookBefore(conversationId, todayStart);
  const joined = db.getAccount(conversationId)?.created_at ?? null;
  const floor = todayStart - GAP_DAYS * DAY;
  // Never looked: the day before today, or since they joined if that was later.
  const since = last != null ? Math.max(last, floor) : Math.max(todayStart - DAY, Number.isFinite(joined) ? joined : 0);
  return { since, todayStart, away: last != null && last < todayStart - DAY };
}

// ---------------------------------------------------------------- what happened

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).replace(/[\s,;:.]+$/, "")}…` : s);
/** A message as a headline and a detail: its first sentence, then the rest (each cut short). */
export function headlineOf(text) {
  const t = oneLine(text);
  const m = /^(.{12,160}?[.!?])(\s+|$)/.exec(t);
  const head = m ? m[1] : cut(t, 120);
  const rest = m ? t.slice(m[0].length).trim() : "";
  return { headline: cut(head, 120), detail: rest ? cut(rest, 170) : null };
}
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

const LINK = /https?:\/\/[^\s<>"')]+/gi;
/** The words of a message with its links taken out; "" when it was only a link. */
const withoutLinks = (text) => oneLine(String(text ?? "").replace(LINK, " ")).replace(/^[\s:,.-]+$/, "");
/**
 * A message that was only a link: named by what it links to — a page or document Reason made (its
 * title), or the task it was sent for (its label). Null when nothing names it: no item, never a bare URL.
 */
function linkTitle(conversationId, parts) {
  for (const m of parts) {
    for (const url of String(m.text ?? "").match(LINK) ?? []) {
      let id = "";
      try { id = new URL(url).pathname.split("/").filter(Boolean).pop() ?? ""; } catch { continue; }
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) continue;
      const t = db.db.prepare("SELECT title FROM pages WHERE id = ? AND conversation_id = ?").get(id, conversationId)?.title
        ?? db.db.prepare("SELECT title FROM documents WHERE id = ? AND conversation_id = ?").get(id, conversationId)?.title;
      if (oneLine(t)) return cut(oneLine(t), 120);
    }
    const task = db.db.prepare(`SELECT t.label, t.title FROM task_messages l JOIN tasks t ON t.id = l.task_id AND t.conversation_id = l.conversation_id
        JOIN messages mm ON mm.outbox_id = l.outbox_id WHERE l.conversation_id = ? AND mm.id = ? LIMIT 1`).get(conversationId, m.id);
    const name = oneLine(task?.label || task?.title || "");
    if (name) return cut(name, 120);
  }
  return null;
}

/** The messages each of these tasks said, by id (task_messages), so a finished task is told once, as itself. */
function taskMessageIds(conversationId, taskIds) {
  if (!taskIds.length) return new Map();
  const rows = db.db.prepare(`SELECT l.task_id, m.id FROM task_messages l JOIN messages m ON m.conversation_id = l.conversation_id
      AND ((l.outbox_id IS NOT NULL AND m.outbox_id = l.outbox_id) OR (l.external_id IS NOT NULL AND m.role = 'user' AND m.external_id = l.external_id))
    WHERE l.conversation_id = ? AND l.task_id IN (${taskIds.map(() => "?").join(",")})`).all(conversationId, ...taskIds);
  const out = new Map();
  for (const r of rows) out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.id]);
  return out;
}

/** Overnight: everything since `since`, newest first. Each `{ id, at, kind, headline, detail?, threadMessageId?, href?, actions? }`. */
export function overnightFor(conversationId, since, now = clock.now()) {
  const out = [];
  // Approvals asked in the window: the decision, answered by a reply in the one shared thread (owner 10-27 07:08).
  const open = pendingApprovals(conversationId, now);
  const asks = open.filter(a => a.at >= since && a.at <= now);
  for (const a of asks) {
    // A tap sends plain words ("Yes, go ahead."), which answer whatever is waiting in the thread. So the
    // buttons show only when this is the one approval waiting; otherwise it links to where it's answered.
    const alone = open.length === 1;
    const href = "/web?thread";
    out.push(alone
      ? { id: `approval:${a.id}`, at: a.at, kind: "decision", headline: cut(oneLine(a.title), 140), detail: a.detail ?? null,
        threadMessageId: null, href: a.href, actions: DECISION.map(x => ({ ...x })) }
      : { id: `approval:${a.id}`, at: a.at, kind: "update", headline: cut(oneLine(a.title), 140), detail: a.detail ?? null,
        threadMessageId: null, href, linkText: "Answer it in the thread" });
  }
  // Tasks that finished: done (the DONE stamp and its one line) or stopped (an update into the thread).
  const finished = db.tasksFinishedSince(conversationId, since).filter(t => t.finished_at <= now && (t.state === "done" || t.state === "failed"));
  const said = taskMessageIds(conversationId, finished.map(t => t.id));
  const told = new Set([...said.values()].flat());
  for (const t of finished) {
    const res = parseJson(t.result_json) ?? {};
    const title = oneLine(t.label || t.title || t.goal || "");
    const last = (said.get(t.id) ?? []).sort((x, y) => y - x)[0] ?? null;
    if (t.state === "done") {
      const line = oneLine(res.headline || res.note || t.outcome || title);
      if (line) out.push({ id: `task:${t.id}`, at: t.finished_at, kind: "done", headline: cut(line, 160), threadMessageId: last });
    } else if (title) {
      out.push({ id: `task:${t.id}`, at: t.finished_at, kind: "update", headline: cut(`${title.replace(/[.]$/, "")} didn't work.`, 140),
        detail: res.why ? cut(oneLine(res.why), 170) : null, threadMessageId: last, href: last ? null : `/web/ongoing/task/${t.id}` });
    }
  }
  // What Reason said on its own in the shared thread: news, unless it was answering them.
  const theirs = db.db.prepare("SELECT at FROM messages WHERE conversation_id = ? AND role = 'user' AND chat_id IS NULL AND deleted_at IS NULL AND at >= ? AND at <= ? ORDER BY at")
    .all(conversationId, since - REPLY_MS, now).map(r => r.at);
  // Only what Reason did for them: an operator notice (the status check, an alert — tagged by its
  // sender, db.OPS_KEY_PREFIXES) is never news here, and nor is anything carrying the status page's link.
  const rows = db.db.prepare(`SELECT m.id, m.text, m.at, o.idem_key FROM messages m LEFT JOIN outbox o ON o.id = m.outbox_id
      WHERE m.conversation_id = ? AND m.role = 'assistant' AND m.chat_id IS NULL AND m.deleted_at IS NULL AND m.source IS NULL
      AND m.at >= ? AND m.at <= ? AND TRIM(COALESCE(m.text, '')) <> '' ORDER BY m.at DESC, m.id DESC LIMIT 60`).all(conversationId, since, now)
    .filter(m => !hasOpsKeyLink(m.text));
  // A message that left as several bubbles (a link on its own, src/links.js) is one item: its parts
  // share an outbox key up to `#n`. Its headline is the words; a link alone is never the headline.
  const groups = new Map();
  for (const m of rows) {
    const k = /#\d+$/.test(m.idem_key ?? "") ? `k:${m.idem_key.slice(0, m.idem_key.lastIndexOf("#"))}` : `m:${m.id}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.at - b.at || a.id - b.id);
    const first = parts[0];
    if (parts.some(m => told.has(m.id))) continue;
    if (theirs.some(at => at <= first.at && first.at - at < REPLY_MS)) continue;
    if (asks.some(a => Math.abs(a.at - first.at) < 2 * 60_000)) continue;
    const words = parts.map(m => withoutLinks(m.text)).filter(Boolean).join(" ");
    const { headline, detail } = words ? headlineOf(words) : { headline: linkTitle(conversationId, parts), detail: null };
    if (headline) out.push({ id: `message:${first.id}`, at: first.at, kind: "update", headline, detail, threadMessageId: first.id });
  }
  return out.sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));
}

const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const hoursWord = (ms) => {
  const h = Math.round(ms / 3_600_000);
  return h <= 1 ? "an hour" : `${h} hours`;
};
/** Lines out: open watches, armed reminders and calls, standing series. `{ id, name, status, urgent, detail, href? }`. */
export function linesOutFor(conversationId, now = clock.now(), tz = tzOf(conversationId, now)) {
  const lines = [];
  for (const w of db.listWatches(conversationId)) {
    const name = cut(oneLine(w.note || w.looking_for || w.query || ""), 90);
    if (!name) continue;
    const price = w.kind === "price" && Number.isFinite(w.last_price_cents);
    const status = price ? `NOW ${money(w.last_price_cents)}` : w.checks ? "NO CHANGE" : "WATCHING";
    const detail = price && Number.isFinite(w.target_cents) ? `Waiting for ${money(w.target_cents)} or less.`
      : w.last_checked_at ? `Last looked ${hoursWord(now - w.last_checked_at)} ago.` : "I haven't looked yet.";
    lines.push({ id: `watch:${w.id}`, name, status, urgent: false, detail, due: Infinity });
  }
  const { items } = ongoing(conversationId, now);
  for (const x of items) {
    if (x.kind !== "timer" && x.kind !== "series") continue;
    const due = Number.isFinite(x.due) ? x.due : null;
    const status = due ? dueLabel(due, now, tz) : String(x.status || x.every || "").toUpperCase();
    if (!x.title || !status) continue;
    const desc = typeof x.description === "string" ? oneLine(x.description) : "";
    lines.push({ id: `${x.kind}:${x.id}`, name: cut(oneLine(x.title), 90), status, urgent: !!due && due > now && due - now < DAY,
      detail: desc && desc.toLowerCase() !== oneLine(x.title).toLowerCase() ? cut(desc, 140) : (x.everyLong ? `${x.everyLong[0]}${x.everyLong.slice(1).toLowerCase()}.` : null),
      href: x.href, due: due ?? Infinity });
  }
  return lines.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.due - b.due).slice(0, LINES_MAX).map(({ due, ...l }) => l);
}

/** The shared thread's last two lines, and where the last was said. Null before there is any. */
export function pickupFor(conversationId) {
  // The conversation only: an operator notice (the status check, an alert) is not where they left off.
  const rows = db.messagesBefore(conversationId, { limit: 24 })
    .filter(r => String(r.role === "user" ? displayText(r.text) : r.text ?? "").trim() && r.source !== "ops" && !hasOpsKeyLink(r.text)).slice(-2);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const service = db.db.prepare("SELECT service FROM threads WHERE conversation_id = ?").get(conversationId)?.service ?? null;
  return {
    lastAt: last.at, surface: last.channel === WEB ? "web" : "imessage",
    where: last.channel === WEB ? "Web" : String(service ?? "").toUpperCase() === "SMS" ? "SMS" : "iMessage",
    lines: rows.map(r => ({ role: r.role === "user" ? "user" : "reason", text: cut(oneLine(r.role === "user" ? displayText(r.text) : r.text), 220) })),
  };
}

// ---------------------------------------------------------------- one question today

/** Today's question was already answered or put off: nothing more is asked today. */
const askedToday = (conversationId, day) => !!db.db.prepare("SELECT 1 FROM daily_questions WHERE conversation_id = ? AND day = ? LIMIT 1").get(conversationId, day);
const skippedLately = (conversationId, key, now) => !!db.db.prepare("SELECT 1 FROM daily_questions WHERE conversation_id = ? AND question_key = ? AND outcome = 'later' AND at > ? LIMIT 1").get(conversationId, key, now - SKIP_DAYS * DAY);

/** The open guess to ask about today, or null: newest first, never one put off in the last SKIP_DAYS. */
export function questionFor(conversationId, day, now = clock.now()) {
  if (askedToday(conversationId, day)) return null;
  const ownKey = db.personKey(db.getAccount(conversationId)?.name ?? "");
  for (const g of db.listGuesses(conversationId, { limit: 40 })) {
    const key = `guess:${g.id}`;
    if (skippedLately(conversationId, key, now)) continue;
    const own = !!ownKey && db.personKey(g.about) === ownKey;
    const t = oneLine(g.guess);
    if (!t) continue;
    const line = own || !g.about || t.toLowerCase().includes(String(g.about).toLowerCase()) ? t : `${g.about}: ${t[0].toLowerCase()}${t.slice(1)}`;
    return { id: key, guessId: g.id, text: /[.!?]$/.test(line) ? line : `${line}.`, why: QUESTION_WHY, options: ANSWERS.map(a => a.label) };
  }
  return null;
}

/** Is today's stored question still one to ask (the guess open, not answered or put off today)? */
function stillAsking(conversationId, q, day, now) {
  if (!q?.guessId || askedToday(conversationId, day)) return false;
  const g = db.getGuess(conversationId, Number(q.guessId));
  return !!g && !g.confirmed_at && !g.dismissed_at && !skippedLately(conversationId, q.id, now);
}

/** "Ask me later": not again today, and this one not for SKIP_DAYS. */
export function putOff(conversationId, key, now = clock.now()) {
  if (!/^guess:\d{1,12}$/.test(String(key ?? ""))) return false;
  const day = localDay(now, tzOf(conversationId, now));
  db.db.prepare("INSERT INTO daily_questions (conversation_id, day, question_key, outcome, at) VALUES (?, ?, ?, 'later', ?)").run(conversationId, day, key, now);
  return true;
}
/** Answered (the fact is saved by the caller, through the Memory guess path): nothing more asked today. */
export function noteAnswered(conversationId, key, now = clock.now()) {
  const day = localDay(now, tzOf(conversationId, now));
  db.db.prepare("INSERT INTO daily_questions (conversation_id, day, question_key, outcome, at) VALUES (?, ?, ?, 'answered', ?)").run(conversationId, day, String(key), now);
}

// ---------------------------------------------------------------- the greeting

const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const firstName = (conversationId) => String(db.getAccount(conversationId)?.name ?? "").trim().split(/\s+/)[0] ?? "";

/** Which fixed moment today is, if any: "first" | "away" | "quiet" | null (an ordinary morning, a written greeting). */
export function momentOf({ issue, overnight, away, hadAnything }) {
  if (issue === 1 && !overnight.length && !hadAnything) return "first";
  if (away) return "away";
  if (!overnight.length) return "quiet";
  return null;
}

/** The deterministic greeting: the fixed lines, else "morning, Ama. two things moved while you slept." */
export function plainGreeting({ moment, name, overnight, since, tz, now = clock.now() }) {
  if (moment === "first") return FIRST_GREETING;
  if (moment === "away") {
    const when = now - since < 6 * DAY ? fmt(tz, { weekday: "long" }).format(since) : fmt(tz, { month: "long", day: "numeric" }).format(since);
    return `welcome back. here's what happened since ${when}.`;
  }
  if (moment === "quiet") return QUIET_GREETING;
  const n = overnight.length;
  const lead = name ? `morning, ${name}.` : "morning.";
  const needs = overnight.filter(x => x.kind === "decision").length;
  const count = `${NUM[n] ?? n} ${n === 1 ? "thing" : "things"} moved while you slept`;
  return `${lead} ${count}${needs ? `, and ${needs === 1 ? "one needs" : `${NUM[needs] ?? needs} need`} you` : ""}.`;
}

const SYSTEM = `You write the one handwritten line at the top of a person's morning page from Reason, their assistant.
You are given their first name and what happened overnight. Write a greeting in Reason's margin voice:
all lowercase except their name, warm, plain, at most 12 words, one line, no emoji, no exclamation marks.
It names how much happened, never details (no prices, places, people or companies).
Shape: "morning, Ama. two things moved while you slept." Never mention streaks, days in a row, or missing anything.
Reply with the greeting only.`;
const SCHEMA = { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"], additionalProperties: false };

let testAsk = null;
/** For tests: the stand-in for the claude-cli call (null puts the real path back). */
export function setGreetingAsk(f) { testAsk = f; }

/** Keep a written greeting only if it is one plain line in the voice; null otherwise (the plain one is used). */
export function cleanGreeting(text, name = "") {
  let t = oneLine(text).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (!t || t.length > 90 || /[!\n#*_`]|streak|in a row/i.test(t) || /\p{Extended_Pictographic}/u.test(t)) return null;
  t = t.toLowerCase();
  if (name) t = t.replace(new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), name);
  return t;
}

/** The greeting from the claude-cli subscription, or null. Never the billed API. */
async function written({ name, overnight }) {
  const ask = testAsk ?? askStructuredViaCli;
  if (ask === askStructuredViaCli && (process.env.REASON_BACKEND !== "claude-cli" || process.env.NODE_TEST_CONTEXT || process.env.REASON_DAILY_WRITE === "0")) return null;
  const kinds = { decision: "needs their yes or no", update: "news", done: "finished" };
  const { value, error } = await ask({
    prompt: `First name: ${name || "(unknown)"}\nOvernight (${overnight.length}):\n${overnight.slice(0, 8).map(x => `- ${kinds[x.kind]}`).join("\n")}`,
    system: SYSTEM, schema: SCHEMA,
    model: process.env.REASON_DAILY_CLI_MODEL || "sonnet",
    timeoutMs: 45_000,
    feature: "daily_edition",
  });
  if (error || !value) return null;
  return { greeting: cleanGreeting(value.greeting, name) };
}

// ---------------------------------------------------------------- the edition

/** Editions written for them so far (an issue number, never a streak). */
export const editionCount = (conversationId) => db.db.prepare("SELECT COUNT(*) AS n FROM daily_editions WHERE conversation_id = ?").get(conversationId).n;
export const storedEdition = (conversationId, day) => {
  const row = db.db.prepare("SELECT * FROM daily_editions WHERE conversation_id = ? AND day = ?").get(conversationId, day);
  return row ? { ...row, edition: parseJson(row.edition) ?? {} } : null;
};
const hadAnythingEver = (conversationId) => !!db.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND deleted_at IS NULL LIMIT 1").get(conversationId)
  || !!db.db.prepare("SELECT 1 FROM tasks WHERE conversation_id = ? LIMIT 1").get(conversationId);

/** The facts of today's edition, read now. */
function facts(conversationId, { now, tz, since }) {
  return {
    overnight: overnightFor(conversationId, since, now),
    linesOut: linesOutFor(conversationId, now, tz),
    pickup: pickupFor(conversationId),
  };
}

/** Optional: the newest stamp (src/stamps.js, when that build is in), or null. Never invented. */
let stampsModule;
export async function loadStamps() {
  if (stampsModule !== undefined) return stampsModule;
  try { stampsModule = await import("./stamps.js"); } catch { stampsModule = null; }
  return stampsModule;
}
/** src/stamps.js's drawing of one stamp, once loaded; null before (or without) it. */
export const stampMarkupFn = () => (typeof stampsModule?.stampMarkup === "function" ? stampsModule.stampMarkup : null);
/** Is the Stamps page in this build (so the header may link to it)? */
export const stampsReady = () => typeof stampsModule?.newestStamp === "function";
function newestStamp(conversationId) {
  try { stampsModule?.checkAnniversary?.(conversationId); } catch { /* the year is marked by the book too */ }
  try { return stampsModule?.newestStamp ? stampsModule.newestStamp(conversationId, { days: 7 }) ?? null : null; } catch { return null; }
}

/**
 * Today's edition for the page: the written one if the overnight run made it (its greeting, question,
 * issue and window), with every fact read fresh; otherwise drawn now from live data with the plain
 * greeting. Never calls a model.
 */
export function editionFor(conversationId, { now = clock.now() } = {}) {
  const tz = tzOf(conversationId, now);
  const day = localDay(now, tz);
  const stored = storedEdition(conversationId, day);
  const win = stored ? { since: stored.since, away: !!stored.edition.away } : windowFor(conversationId, now, tz);
  const f = facts(conversationId, { now, tz, since: win.since });
  const issue = stored ? stored.issue : editionCount(conversationId) + 1;
  const name = firstName(conversationId);
  let greeting, question;
  if (stored) {
    // The written greeting holds the day while it is still true: the same kind of morning, the same
    // count. Anything new since it was written and the plain greeting says it instead.
    const moment = momentOf({ issue, overnight: f.overnight, away: win.away, hadAnything: hadAnythingEver(conversationId) });
    const wasMoment = stored.edition.moment ?? null;
    const same = moment === wasMoment && (stored.edition.counted == null || stored.edition.counted === f.overnight.length);
    greeting = same ? stored.edition.greeting : plainGreeting({ moment, name, overnight: f.overnight, since: win.since, tz, now });
    const q = stored.edition.question ?? null;
    question = q && stillAsking(conversationId, q, day, now) ? q : null;
  } else {
    const moment = momentOf({ issue, overnight: f.overnight, away: win.away, hadAnything: hadAnythingEver(conversationId) });
    greeting = plainGreeting({ moment, name, overnight: f.overnight, since: win.since, tz, now });
    question = questionFor(conversationId, day, now);
  }
  return {
    issueNumber: issue, date: day, tz, greeting, since: win.since, away: win.away, written: !!stored,
    first: issue === 1 && !f.overnight.length && !hadAnythingEver(conversationId),
    ...f, question: question ?? undefined, newestStamp: newestStamp(conversationId) ?? undefined,
  };
}

/**
 * Write today's edition for one person (the overnight run). Idempotent per local day: a second call
 * finds the row and does nothing. The greeting is written on the claude-cli subscription when the
 * day is an ordinary one; the fixed moments keep their fixed lines; any failure keeps the plain line.
 */
export async function writeEdition(conversationId, { now = clock.now(), log = () => {} } = {}) {
  const tz = tzOf(conversationId, now);
  const day = localDay(now, tz);
  if (storedEdition(conversationId, day)) return { ok: true, already: true };
  await loadStamps();
  const win = windowFor(conversationId, now, tz);
  const f = facts(conversationId, { now, tz, since: win.since });
  const issue = editionCount(conversationId) + 1;
  const name = firstName(conversationId);
  const moment = momentOf({ issue, overnight: f.overnight, away: win.away, hadAnything: hadAnythingEver(conversationId) });
  const question = questionFor(conversationId, day, now);
  let greeting = plainGreeting({ moment, name, overnight: f.overnight, since: win.since, tz, now });
  let by = moment ? "fixed" : "plain";
  if (!moment) {
    let w = null;
    try { w = await written({ name, overnight: f.overnight }); } catch { w = null; }
    if (w?.greeting) { greeting = w.greeting; by = "claude-cli"; }
  }
  const edition = { issueNumber: issue, date: day, greeting, moment, away: win.away, counted: f.overnight.length, ...f, question: question ?? null, newestStamp: newestStamp(conversationId) };
  const r = db.db.prepare(`INSERT OR IGNORE INTO daily_editions (conversation_id, day, issue, since, edition, greeting_by, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conversationId, day, issue, win.since, JSON.stringify(edition), by, now);
  log({ daily_edition: day, conversation: conversationId, issue, greeting_by: by, overnight: f.overnight.length, lines_out: f.linesOut.length, question: !!question });
  return { ok: true, written: r.changes > 0, issue, greeting_by: by };
}

/** Someone who has signed in to Web at least once: nobody else is ever shown an edition, so none is written. */
const usesWeb = (conversationId) => !!db.db.prepare("SELECT 1 FROM page_sessions WHERE conversation_id = ? AND page_id LIKE 'wsign:%' LIMIT 1").get(conversationId);

const writing = new Set();
/**
 * The runtime's daily pass: for everyone the edition is on for, once their local clock has passed
 * EDITION_HOUR and today's isn't written, queue it on the background lane (one at a time, after any
 * reply turn, paused while the subscription is limited). Returns what it queued.
 */
export function sweepDaily({ now = clock.now(), log = () => {} } = {}) {
  const queued = [];
  for (const acct of db.listAccountsOfPeople()) {
    if ((acct.state ?? "active") !== "active") continue;
    const c = acct.conversation_id;
    if (!dailyAllowedFor(c) || !webAllowedFor(c) || !usesWeb(c)) continue;
    const tz = tzOf(c, now);
    const day = localDay(now, tz);
    const key = `daily:${c}:${day}`;
    if (writing.has(key) || localHour(now, tz) < EDITION_HOUR || storedEdition(c, day)) continue;
    writing.add(key);
    queued.push(c);
    background.enqueue(key, () => writeEdition(c, { now: clock.now(), log }))
      .catch(e => log({ daily_edition_failed: (e?.message ?? String(e)).split("\n")[0], conversation: c }))
      .finally(() => writing.delete(key));
  }
  return { queued: queued.length };
}

/** For tests. */
export function resetDaily() { writing.clear(); testAsk = null; stampsModule = undefined; }

/** A fresh id for one decision button's send (so a resent form is one message). */
export const sendIdFor = () => randomUUID();
