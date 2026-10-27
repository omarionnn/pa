// Reason Web's thread, the parts that need the server to know more than the words (design handoff
// v2, §4b "Scrolling", Prototype S2 + S3; sheet "Loading · actions" L10):
//
//   WHERE  the "where you are" note names the day and the device of the messages at the top of the
//          screen: "yesterday, on your phone", "today, on your laptop". The device is never guessed.
//          A text (iMessage / SMS) was on their phone. A Web message was on whatever kind of device
//          the browser that sent it said it was (its User-Agent, read when it was sent and kept in
//          `web_devices`); Reason's own Web lines take the device of their last Web message before
//          it. Nothing known: "on the web".
//   SETTLE a finished task folds into one DONE line. Which messages belong to which task is written
//          down by the runtime at the end of every turn that worked on a task (task_start,
//          task_update, task_finish, or the task's own wake): that turn's texts by their handle and
//          what it sent by outbox row (`task_messages`). Only `done` tasks fold; a message that also
//          belongs to a task still open never folds, so work in progress never collapses.
//   LONG   "on it. calling three places." and the honest line, while a task started from (or
//          worked on in answer to) their latest message is still being worked (`running`).
//
// Every read is scoped to one conversation.
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { cleanTitle } from "./itemtitle.js";

/** How long a finished task reads `JUST NOW` with "just wrapped this one up. tap to see how." */
export const JUST_NOW_MS = 15 * 60_000;
const DAY_MS = 864e5;

// ---------------------------------------------------------------- devices
/** The kind of device a browser is on, from its User-Agent: phone | tablet | computer, or null. */
export function deviceClass(ua) {
  const s = String(ua ?? "");
  if (!s.trim()) return null;
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(s)) return "tablet";
  if (/iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone|IEMobile|BlackBerry|Opera Mini|\bMobile\b/i.test(s)) return "phone";
  if (/Macintosh|Windows NT|X11|Linux|CrOS/i.test(s)) return "computer";
  return null;
}

/** Keep the device a Web message was sent from. Idempotent: a resent message keeps its first device. */
export function noteWebDevice(conversationId, clientId, device) {
  if (!conversationId || !clientId || !["phone", "tablet", "computer"].includes(device)) return false;
  return db.db.prepare("INSERT OR IGNORE INTO web_devices (conversation_id, client_id, device, at) VALUES (?, ?, ?, ?)")
    .run(conversationId, String(clientId), device, clock.now()).changes === 1;
}

/** The device behind one history row: phone for a text, the sending browser's kind for Web, else null. */
export function deviceOf(row, conversationId) {
  const ch = String(row?.channel ?? "");
  if (!ch || ch === "console") return null;
  if (ch !== "web") return "phone";
  const prefix = `${conversationId}:`;
  if (row.role === "user") {
    const ext = String(row.external_id ?? "");
    if (!ext.startsWith(prefix)) return null;
    return db.db.prepare("SELECT device FROM web_devices WHERE conversation_id = ? AND client_id = ?").get(conversationId, ext.slice(prefix.length))?.device ?? null;
  }
  // Reason's line on Web answers the browser that last wrote: that device.
  return db.db.prepare(`SELECT d.device FROM messages m JOIN web_devices d
      ON d.conversation_id = m.conversation_id AND d.client_id = substr(m.external_id, length(m.conversation_id) + 2)
    WHERE m.conversation_id = ? AND m.channel = 'web' AND m.role = 'user' AND m.deleted_at IS NULL AND m.at <= ?
    ORDER BY m.at DESC, m.id DESC LIMIT 1`).get(conversationId, row.at ?? clock.now())?.device ?? null;
}

const DEVICE_WORDS = { phone: "on your phone", tablet: "on your tablet", computer: "on your laptop" };
const NUM = ["", "", "two", "three"];
const dayKey = (at, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const daysApart = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

/**
 * The note's words for a message said at `at` on `device`: "today, on your laptop", "yesterday, on
 * your phone", "tuesday, on your phone", "two weeks ago, on your phone". Lowercase: it is the
 * margin's own handwriting. Older than four weeks names the month ("in september").
 */
export function whereWords({ at, device = null, now = clock.now(), tz = config.tz } = {}) {
  const n = daysApart(dayKey(now, tz), dayKey(at, tz));
  let day;
  if (n <= 0) day = "today";
  else if (n === 1) day = "yesterday";
  else if (n < 7) day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(at).toLowerCase();
  else if (n < 14) day = "last week";
  else if (n < 28) day = `${NUM[Math.floor(n / 7)]} weeks ago`;
  else {
    const sameYear = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(at) === new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now);
    day = `in ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", ...(sameYear ? {} : { year: "numeric" }) }).format(at).toLowerCase()}`;
  }
  return `${day}, ${DEVICE_WORDS[device] ?? "on the web"}`;
}

// ---------------------------------------------------------------- which messages belong to a task
/** Tools whose call means "this turn worked on that task". */
export const TASK_TOOLS = new Set(["task_start", "task_update", "task_finish"]);

/** The task a task tool call was about, from its input or its result; null when it did not take. */
export function taskOfCall(name, input, out) {
  if (!TASK_TOOLS.has(String(name)) || !out || out.ok === false) return null;
  const id = Number(input?.task_id ?? out?.task?.id ?? out?.task_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Write down that a turn's own messages belong to these tasks: the texts it answered (their handles)
 * and everything it sent to them (outbox rows of this conversation after `outboxAfter`, to the person
 * whose Reason it is). Scoped: a task id from another conversation links nothing.
 */
export function linkTurn({ conversationId, taskIds = [], handles = [], outboxAfter = null }) {
  const ids = [...new Set(taskIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    .filter(id => db.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND conversation_id = ?").get(id, conversationId));
  if (!ids.length) return 0;
  const hs = [...new Set(handles.map(h => String(h ?? "").trim()).filter(Boolean))];
  const sent = outboxAfter == null ? [] : db.db.prepare("SELECT id FROM outbox WHERE conversation_id = ? AND id > ? AND to_owner = 1").all(conversationId, outboxAfter).map(r => r.id);
  const now = clock.now();
  const inH = db.db.prepare("INSERT OR IGNORE INTO task_messages (conversation_id, task_id, external_id, created_at) VALUES (?, ?, ?, ?)");
  const inO = db.db.prepare("INSERT OR IGNORE INTO task_messages (conversation_id, task_id, outbox_id, created_at) VALUES (?, ?, ?, ?)");
  let n = 0;
  for (const t of ids) {
    for (const h of hs) n += inH.run(conversationId, t, h, now).changes;
    for (const o of sent) n += inO.run(conversationId, t, o, now).changes;
  }
  // An open Web tab settles a task that just finished without waiting for its next look (the stream).
  if (n) { try { db.historyBus.emit("state", { conversationId }); } catch { /* a listener never costs a write */ } }
  return n;
}

const parse = (r) => ({ ...r, media: (() => { try { return JSON.parse(r.media || "[]"); } catch { return []; } })() });

/** [{ task_id, message_id }] for these history rows (or, with `taskIds`, for every row of those tasks). */
function links(conversationId, { messageIds = null, taskIds = null }) {
  const by = messageIds ? ["m.id", messageIds] : ["l.task_id", taskIds];
  if (!by[1]?.length) return [];
  const q = by[1].map(() => "?").join(",");
  const viaOut = db.db.prepare(`SELECT l.task_id, m.id AS message_id FROM task_messages l
    JOIN messages m ON m.conversation_id = l.conversation_id AND m.outbox_id = l.outbox_id
    WHERE l.conversation_id = ? AND l.outbox_id IS NOT NULL AND m.deleted_at IS NULL AND ${by[0]} IN (${q})`).all(conversationId, ...by[1]);
  const viaIn = db.db.prepare(`SELECT l.task_id, m.id AS message_id FROM task_messages l
    JOIN messages m ON m.conversation_id = l.conversation_id AND m.external_id = l.external_id AND m.role = 'user'
    WHERE l.conversation_id = ? AND l.external_id IS NOT NULL AND m.deleted_at IS NULL AND ${by[0]} IN (${q})`).all(conversationId, ...by[1]);
  return [...viaOut, ...viaIn];
}

/**
 * The folds for a page of history. For each done task with a message on this page: every message
 * that belongs to it (from any page), and which one it settles at (its last). A message is one
 * task's: the lowest done task it belongs to, and none at all when it also belongs to an open task.
 *
 * Returns { owner: Map(messageId → taskId), folds: Map(taskId → { task, rows, lastId }) }.
 */
export function foldsFor(conversationId, messageIds = []) {
  const owner = new Map(), folds = new Map();
  const ids = [...new Set(messageIds.map(Number).filter(Boolean))];
  if (!ids.length) return { owner, folds };
  const first = links(conversationId, { messageIds: ids });
  if (!first.length) return { owner, folds };
  // Every message of the tasks seen here, then every task those messages belong to as well.
  const all = links(conversationId, { taskIds: [...new Set(first.map(l => l.task_id))] });
  const more = links(conversationId, { messageIds: [...new Set(all.map(l => l.message_id))] });
  const byMsg = new Map();
  for (const l of [...all, ...more]) {
    if (!byMsg.has(l.message_id)) byMsg.set(l.message_id, new Set());
    byMsg.get(l.message_id).add(l.task_id);
  }
  const taskIds = [...new Set([...byMsg.values()].flatMap(s => [...s]))];
  const tasks = new Map(taskIds.map(id => [id, db.db.prepare("SELECT * FROM tasks WHERE id = ? AND conversation_id = ?").get(id, conversationId)]).filter(([, t]) => t));
  for (const [mid, ts] of byMsg) {
    const list = [...ts].map(id => tasks.get(id)).filter(Boolean);
    if (!list.length || list.some(t => t.state !== "done" && t.state !== "failed" && t.state !== "cancelled")) continue; // open work never folds
    const done = list.filter(t => t.state === "done").sort((a, b) => a.id - b.id)[0];
    if (done) owner.set(mid, done.id);
  }
  const rowsOf = new Map();
  for (const [mid, tid] of owner) { if (!rowsOf.has(tid)) rowsOf.set(tid, []); rowsOf.get(tid).push(mid); }
  for (const [tid, mids] of rowsOf) {
    const rows = db.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND id IN (${mids.map(() => "?").join(",")}) ORDER BY at ASC, id ASC`)
      .all(conversationId, ...mids).map(parse);
    if (!rows.length) continue;
    folds.set(tid, { task: tasks.get(tid), rows, lastId: rows.at(-1).id });
  }
  for (const [mid, tid] of [...owner]) if (!folds.has(tid)) owner.delete(mid);
  return { owner, folds };
}

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const fmt = (tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, ...o });
const MONEY = /^\$\s?\d[\d,]*(?:\.\d{2})?$/;

/**
 * What the DONE line says: the title (the result's own headline when task_finish gave one, else the
 * task's short title), the typed meta and the count. `JUST NOW · $540 · WEB` for a task that finished
 * in the last JUST_NOW_MS (with its money when the result names it), else `TUE · IMESSAGE · 9:20 AM`,
 * or `OCT 12 · IMESSAGE` past a week. Where = where it finished (its last message).
 */
export function doneLine({ task, rows }, { now = clock.now(), tz = config.tz, sourceOf = (r) => r.channel } = {}) {
  const res = parseJson(task.result_json) ?? {};
  const name = db.getAccount?.(task.conversation_id)?.name || config.ownerName;
  const title = String(res.headline ?? "").trim() || String(task.label ?? "").trim() || cleanTitle(task.title, { name }) || String(task.title ?? "").slice(0, 60);
  const last = rows.at(-1);
  const where = String(sourceOf(last) ?? "").toUpperCase();
  const finished = task.finished_at ?? last.at;
  const fresh = now - finished >= 0 && now - finished < JUST_NOW_MS;
  let meta;
  if (fresh) {
    const money = (Array.isArray(res.facts) ? res.facts : []).map(f => String(f ?? "").trim()).find(f => MONEY.test(f));
    meta = ["JUST NOW", money, where].filter(Boolean).join(" · ");
  } else {
    const n = daysApart(dayKey(now, tz), dayKey(last.at, tz));
    const time = fmt(tz, { hour: "numeric", minute: "2-digit" }).format(last.at).toUpperCase();
    if (n <= 0) meta = `TODAY · ${where} · ${time}`;
    else if (n < 7) meta = `${fmt(tz, { weekday: "short" }).format(last.at).toUpperCase()} · ${where} · ${time}`;
    else meta = `${fmt(tz, { month: "short", day: "numeric" }).format(last.at).toUpperCase()} · ${where}`;
  }
  return { taskId: task.id, title, meta, count: rows.length, fresh };
}

// ---------------------------------------------------------------- long work (L10)
/**
 * Is Reason still working, at length, on what they last asked? Their latest message belongs to a task
 * that is `running` (not waiting on anyone, not finished). Then: what it is doing now, in the task's
 * own live words for the step in hand ("on the phone now"), and whether the result will be texted
 * (it is unless they keep results on Web, src/deliver.js keptOnWeb). Null otherwise.
 */
export function longWork(conversationId) {
  const last = db.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND deleted_at IS NULL ORDER BY at DESC, id DESC LIMIT 1").get(conversationId);
  if (!last) return null;
  const tids = [...new Set(links(conversationId, { messageIds: [last.id] }).map(l => l.task_id))];
  const t = tids.map(id => db.getTask(conversationId, id)).filter(x => x && x.state === "running").sort((a, b) => b.id - a.id)[0];
  if (!t) return null;
  const steps = t.sheet?.steps ?? [];
  const doing = steps.find(s => s.state === "doing");
  const live = String(doing?.live ?? "").replace(/\s+/g, " ").trim().replace(/[.…]+$/, "").toLowerCase().slice(0, 80);
  const texted = db.webReach(conversationId) !== "web";
  return { taskId: t.id, line: live ? `on it. ${live}.` : "on it.", texted };
}

/** The honest line under L10: it can be closed, it's in Ongoing, and where the result will come. */
export const LONG_NOTE = "This one takes a few minutes. You can close this; it's in Ongoing, and I'll text you.";
export const LONG_NOTE_WEB = "This one takes a few minutes. You can close this; it's in Ongoing, and the result will be here.";
