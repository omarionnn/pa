// Saved (Reason Web v2, HANDOFF §4 "Saved"; reference sheet-saved S-A/S-B, desk-saved): everything
// Reason made for one person, kept, with nothing to manage. The index is READ from what exists —
// never a copy that could drift:
//
//   page     the `pages` Reason made (files.heyreason.com/<id>), with the pick made on it, if any
//   call     calls Reason placed to somebody else for them that reached a person or a machine
//            (`calls`, is_owner = 0), with the summary it wrote; BOOKED when the outcome was confirmed
//   receipt  AgentCard purchases that were really placed (`agentcard_purchases`): PAID, or CANCELED
//            when the shop's record later said it is not coming. A cart that was only shown is not one.
//   event    events they organised (`events`), and
//   album    the photo album of one of those events (`event_albums`)
//
// The person's only marks are their own: PIN and REMOVE FROM SAVED, one row per item in
// `saved_marks`. Removing hides the item from Saved and nothing else — the page, the call, the
// receipt and the event are untouched and stay wherever else they show. Every read is scoped to the
// session's conversation, so another person's id is simply not found.
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { tzFor } from "./series.js";
import { cleanTitle, queueTitle } from "./itemtitle.js";

export const KINDS = ["page", "call", "receipt", "event", "album"];
/** The filter words, in the page's order, and which kinds each one shows. */
export const FILTERS = [
  ["all", "ALL", KINDS], ["pages", "PAGES", ["page"]], ["calls", "CALLS", ["call"]],
  ["receipts", "RECEIPTS", ["receipt"]], ["events", "EVENTS", ["event", "album"]],
];
export const KEY = /^(page|call|receipt|event|album)-([A-Za-z0-9_-]{1,40})$/;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS saved_marks (
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    pinned_at INTEGER,
    removed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, kind, item_id)
  );
`);

const ONE = (sql, ...a) => db.db.prepare(sql).get(...a);
const ALL = (sql, ...a) => db.db.prepare(sql).all(...a);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------------------------------------------------------------- dates
const fmt = (tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, ...o });
const ymd = (ms, tz) => fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
export const weekday = (ms, tz) => fmt(tz, { weekday: "short" }).format(ms).toUpperCase();
export const monthDay = (ms, tz) => fmt(tz, { month: "short", day: "numeric" }).format(ms).toUpperCase();
const monthName = (ms, tz) => fmt(tz, { month: "long" }).format(ms).toUpperCase();
const yearOf = (ms, tz) => fmt(tz, { year: "numeric" }).format(ms);
export const clockTime = (ms, tz) => fmt(tz, { hour: "numeric", minute: "2-digit" }).format(ms).toUpperCase();
/** Within the last seven days (today included): the weekday. Otherwise the date. */
export function dayWord(ms, now, tz) {
  return inWeek(ms, now, tz) ? weekday(ms, tz) : monthDay(ms, tz);
}
function inWeek(ms, now, tz) {
  const days = (Date.parse(ymd(now, tz).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")) - Date.parse(ymd(ms, tz).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2"))) / 86_400_000;
  return days >= 0 && days < 7;
}
/** The time heading an item sits under: THIS WEEK, EARLIER IN <this month>, then each older month. */
export function groupOf(ms, now, tz) {
  if (inWeek(ms, now, tz) || ms > now) return { key: "week", title: "THIS WEEK" };
  const m = monthName(ms, tz), y = yearOf(ms, tz);
  if (m === monthName(now, tz) && y === yearOf(now, tz)) return { key: `m-${y}-${m}`, title: `EARLIER IN ${m}`, month: m, earlier: true };
  return { key: `m-${y}-${m}`, title: y === yearOf(now, tz) ? `IN ${m}` : `IN ${m} ${y}`, month: m };
}
const mmss = (s) => `${Math.floor(Number(s) / 60)}:${String(Math.round(Number(s)) % 60).padStart(2, "0")}`;
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

// ---------------------------------------------------------------- the five sources

function pageItems(conv) {
  return ALL("SELECT id, title, content, revision, role, created_at, updated_at, owner_key FROM pages WHERE conversation_id = ?", conv).map((p) => {
    const picks = ALL("SELECT picked FROM page_choices WHERE page_id = ? AND conversation_id = ? ORDER BY id", p.id, conv);
    const picked = picks.length ? String(picks[picks.length - 1].picked ?? "").trim() : "";
    return {
      kind: "page", id: p.id, title: p.title, at: p.created_at, updatedAt: p.updated_at,
      what: "PAGE", note: picked ? `YOU PICKED ${picked.toUpperCase()}` : "",
      words: textOf(parse(p.content, [])), stamp: null,
    };
  });
}
/** Every string in a page's block list, for FIND SOMETHING. */
function textOf(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join(" ");
  if (v && typeof v === "object") return Object.entries(v).filter(([k]) => !/^(url|src|href|type)$/.test(k)).map(([, x]) => textOf(x)).join(" ");
  return "";
}

/** Calls placed to somebody else that reached a person or a machine. A call to the owner themselves is a conversation, not a thing made. */
function callItems(conv, name) {
  return ALL(`SELECT id, goal, label, state, outcome, outcome_kind, summary, transcript, duration_s, recording_state, announcement, created_at, ended_at, updated_at, to_number
    FROM calls WHERE conversation_id = ? AND is_owner = 0 AND state IN ('completed', 'voicemail') AND summary != ''`, conv).map((c) => {
    const label = String(c.label ?? "").trim();
    if (!label) queueTitle("call", conv, c.id, c.goal, { name });
    return {
      kind: "call", id: String(c.id), title: label || cleanTitle(c.goal, { name }) || "A call", at: c.created_at,
      what: "CALL", note: c.duration_s ? mmss(c.duration_s) : "", dayInMeta: true,
      stamp: c.outcome_kind === "confirmed" ? { text: "BOOKED", tone: "pen" } : null,
      words: `${c.goal} ${c.summary} ${c.outcome}`, endedAt: c.ended_at ?? c.updated_at, row: c,
    };
  });
}

/** Purchases that were really placed. Everything before that (a cart, a pause for the passkey) is Ongoing's, not a receipt. */
function receiptItems(conv) {
  return ALL(`SELECT id, status, amount_cents, merchant, what, order_id, retailer_order_id, delivery_window, charge_status, created_at, updated_at
    FROM agentcard_purchases WHERE conversation_id = ? AND status IN ('placed', 'partially_placed', 'cancelled')`, conv).map((r) => ({
    kind: "receipt", id: String(r.id), title: `${r.merchant || "A purchase"}${r.amount_cents ? `, ${money(r.amount_cents)}` : ""}`, at: r.created_at,
    what: "RECEIPT", note: "", dayInMeta: true,
    stamp: r.status === "cancelled" ? { text: "CANCELED", tone: "muted" } : { text: "PAID", tone: "pen" },
    words: `${r.merchant} ${r.what}`, endedAt: r.updated_at, row: r,
  }));
}

function eventItems(conv) {
  return ALL(`SELECT e.*, (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id AND a.state = 'joined' AND a.conversation_id != e.organizer_conversation_id) AS guests
    FROM events e WHERE e.organizer_conversation_id = ?`, conv).map((e) => ({
    kind: "event", id: String(e.id), title: e.name, at: e.created_at, startsAt: e.starts_at, tz: e.tz,
    what: "EVENT", note: e.guests ? `SHARED WITH ${e.guests}` : "NO GUESTS YET",
    stamp: e.status === "cancelled" ? { text: "CANCELED", tone: "muted" } : null,
    words: `${e.name} ${e.description} ${e.location}`, row: e,
  }));
}

function albumItems(conv) {
  return ALL(`SELECT a.*, e.name, e.public_id, e.tz, e.organizer_token, (SELECT COUNT(*) FROM event_photos p WHERE p.album_id = a.id) AS photos
    FROM event_albums a JOIN events e ON e.id = a.event_id WHERE a.conversation_id = ? AND e.organizer_conversation_id = ?`, conv, conv).map((a) => ({
    kind: "album", id: String(a.id), title: `Photos from ${a.name}`, at: a.created_at,
    what: "ALBUM", note: `${a.photos} ${a.photos === 1 ? "PHOTO" : "PHOTOS"}`, stamp: null,
    words: `${a.name} album photos`, row: a,
  }));
}

// ---------------------------------------------------------------- the index

function marksFor(conv) {
  const m = new Map();
  for (const r of ALL("SELECT kind, item_id, pinned_at, removed_at FROM saved_marks WHERE conversation_id = ?", conv)) m.set(`${r.kind}-${r.item_id}`, r);
  return m;
}

/**
 * Everything Reason made for this conversation, newest first, each with its typed meta line.
 * `removed: true` lists only what they took out of Saved (for "put it back"); otherwise those are left out.
 */
export function savedItems(conv, { now = clock.now(), removed = false } = {}) {
  const account = db.getAccount(conv);
  const name = account?.name || config.ownerName;
  const tz = tzFor(conv);
  const marks = marksFor(conv);
  const all = [...pageItems(conv), ...callItems(conv, name), ...receiptItems(conv), ...eventItems(conv), ...albumItems(conv)];
  const out = [];
  for (const it of all) {
    it.key = `${it.kind}-${it.id}`;
    const mark = marks.get(it.key);
    if (!!mark?.removed_at !== removed) continue;
    it.pinnedAt = mark?.pinned_at ?? null;
    it.day = dayWord(it.at, now, tz);
    it.meta = [it.what, it.note, it.dayInMeta ? it.day : ""].filter(Boolean).join(" · ");
    it.tz = it.tz || tz;
    out.push(it);
  }
  return out.sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));
}

/** One item of theirs by key, removed or not; null when it is not theirs or does not exist. */
export function findSaved(conv, key, { now = clock.now() } = {}) {
  if (!KEY.test(String(key ?? ""))) return null;
  return savedItems(conv, { now }).find(i => i.key === key) ?? savedItems(conv, { now, removed: true }).find(i => i.key === key) ?? null;
}

/** FIND SOMETHING: every word of the query somewhere in the title, the meta line or what the thing says. */
export function matches(item, q) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item.title} ${item.meta} ${item.words ?? ""}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

function mark(conv, key, patch) {
  const m = KEY.exec(key);
  const now = clock.now();
  db.db.prepare(`INSERT INTO saved_marks (conversation_id, kind, item_id, pinned_at, removed_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)
    ON CONFLICT (conversation_id, kind, item_id) DO NOTHING`).run(conv, m[1], m[2], now);
  const sets = Object.keys(patch).map(k => `${k} = ?`).join(", ");
  db.db.prepare(`UPDATE saved_marks SET ${sets}, updated_at = ? WHERE conversation_id = ? AND kind = ? AND item_id = ?`).run(...Object.values(patch), now, conv, m[1], m[2]);
}
/** PIN / unpin. Only an item that is theirs. */
export function setPinned(conv, key, on) {
  if (!findSaved(conv, key)) return false;
  mark(conv, key, { pinned_at: on ? clock.now() : null });
  return true;
}
/** REMOVE FROM SAVED: hidden from Saved, the thing itself untouched. Unpinned too, so it never comes back pinned by surprise. */
export function removeSaved(conv, key) {
  if (!findSaved(conv, key)) return false;
  mark(conv, key, { removed_at: clock.now(), pinned_at: null });
  return true;
}
/** Back into Saved, as it was before (unpinned). */
export function restoreSaved(conv, key) {
  if (!findSaved(conv, key)) return false;
  mark(conv, key, { removed_at: null });
  return true;
}

/**
 * Where the thing is in the chat, as a message id in their own history, or null. A page or an event
 * is the message that carries its link; a call or a receipt is Reason's first line after it ended,
 * within half an hour. History on Web starts when Web did, so older things have nowhere to point.
 */
export function messageFor(conv, item) {
  const q = (sql, ...a) => ONE(`SELECT id FROM messages WHERE conversation_id = ? AND deleted_at IS NULL AND role = 'assistant' AND ${sql} ORDER BY at, id LIMIT 1`, conv, ...a)?.id ?? null;
  if (item.kind === "page") return q("instr(text, ?) > 0", item.id);
  if (item.kind === "event") return q("instr(text, ?) > 0", item.row.public_id);
  if (item.kind === "album") return q("instr(text, ?) > 0", `${item.row.public_id}/album`);
  const t = Number(item.endedAt ?? item.at);
  return q("at >= ? AND at <= ?", t - 60_000, t + 30 * 60_000);
}
