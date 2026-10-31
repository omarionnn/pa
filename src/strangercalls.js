// Calls from people who are not Reason users yet, and the one moment they come back as one.
//
// Omari (2026-10-31): "if that same person gets their Reason, it should recognise that and say
// something to the effect of them reconnecting, so we keep track of that as well."
//
// What is kept, per call, keyed by the number the CALL came from (never anything typed): when, how
// long, and what THEY said or asked, with a short summary. Nothing about any user is ever in a row:
// the pitch they talked to knows nobody (src/calls/stranger.js).
//
// When an account's own verified number (the address its channel delivers from, e.g. Sendblue) matches
// a row, that account's first turn gets a one-time note — "good to reconnect, we spoke on the phone
// <when>" — and the call is written into THEIR memory as their own history. Marked used at once, so it
// is said once. A different number, or a typed claim, matches nothing.
//
// Retention follows Reason's keep policy (src/privacy.js): their words and the summary go after
// REASON_KEEP_CONTENT_DAYS, the row (number, time, length) after REASON_KEEP_RECORDS_DAYS.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import { config, clock, normalizeNumber } from "./config.js";

db.db.exec(`CREATE TABLE IF NOT EXISTS stranger_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_at INTEGER,
  duration_s INTEGER,
  said TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  content_dropped_at INTEGER,
  matched_conversation_id TEXT,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS stranger_calls_phone ON stranger_calls (phone, used_at);
CREATE INDEX IF NOT EXISTS stranger_calls_external ON stranger_calls (external_id);`);

const q = (sql) => db.db.prepare(sql);
const MAX_LINES = 30;
const MAX_LINE = 300;

/** A new call from an unknown number. Null for a withheld one: there is nothing to match it to later. */
export function open({ phone, externalId = "", now = clock.now() }) {
  const e164 = normalizeNumber(phone);
  if (!e164 || !/^\+\d{8,15}$/.test(e164)) return null;
  const token = randomBytes(12).toString("hex");
  const r = q("INSERT INTO stranger_calls (phone, external_id, token, started_at, last_at) VALUES (?, ?, ?, ?, ?)")
    .run(e164, String(externalId ?? ""), token, now, now);
  return { id: Number(r.lastInsertRowid), token };
}

function rowFor(id, token) {
  const row = q("SELECT * FROM stranger_calls WHERE id = ?").get(Number(id));
  if (!row || !token) return null;
  const a = Buffer.from(String(row.token)), b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}

/** "They asked: how do I sign up; how much is it." From their own lines, by code — no model. */
export function summaryOf(lines = []) {
  const said = lines.map(l => String(l).replace(/\s+/g, " ").trim()).filter(l => l.length > 2);
  if (!said.length) return "";
  const asked = said.filter(l => /\?\s*$/.test(l) || /^(how|what|who|can|do|does|is|are|where|when|why)\b/i.test(l));
  const pick = (asked.length ? asked : said).slice(0, 3).map(l => l.replace(/[?.!]+$/, "").slice(0, 80));
  return `${asked.length ? "They asked" : "They said"}: ${pick.join("; ")}`.slice(0, 220);
}

function theirLines(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => m?.role === "user")
    .map(m => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(c => c?.type === "text").map(c => c.text).join(" ") : ""))
    .map(s => s.trim().slice(0, MAX_LINE)).filter(Boolean).slice(-MAX_LINES);
}

/** One turn of the call: what they have said so far (the whole call's words, as the platform sends them). */
export function noteTurn({ id, token, messages, now = clock.now() }) {
  const row = rowFor(id, token);
  if (!row || row.content_dropped_at) return false;
  const lines = theirLines(messages);
  q("UPDATE stranger_calls SET said = ?, summary = ?, last_at = ?, duration_s = ? WHERE id = ?")
    .run(JSON.stringify(lines), summaryOf(lines), now, Math.max(0, Math.round((now - row.started_at) / 1000)), row.id);
  return true;
}

/** The platform's post-call delivery for a call with no call row: the real length and transcript. */
export function settleFromPostCall({ externalId, live, now = clock.now() }) {
  if (!externalId) return false;
  const row = q("SELECT * FROM stranger_calls WHERE external_id = ? ORDER BY id DESC LIMIT 1").get(String(externalId));
  if (!row) return false;
  const turns = Array.isArray(live?.turns) ? live.turns : [];
  const lines = turns.filter(t => t?.who === "them" || t?.role === "user").map(t => String(t.text ?? t.message ?? "").trim().slice(0, MAX_LINE)).filter(Boolean).slice(-MAX_LINES);
  const duration = Number.isFinite(live?.durationS) ? Math.round(live.durationS) : row.duration_s;
  if (row.content_dropped_at || !lines.length) {
    q("UPDATE stranger_calls SET duration_s = ? WHERE id = ?").run(duration, row.id);
  } else {
    q("UPDATE stranger_calls SET said = ?, summary = ?, duration_s = ? WHERE id = ?").run(JSON.stringify(lines), summaryOf(lines), duration, row.id);
  }
  return true;
}

/** The account's own verified number, as the channel delivers from it. "" when its address is not a phone. */
function verifiedPhone(conversationId) {
  const acct = db.getAccount(conversationId);
  if (!acct || acct.is_operator) return "";
  const addr = String(acct.address ?? "");
  if (!/^\+?\d[\d\s().-]{6,}$/.test(addr)) return "";
  return normalizeNumber(addr) || "";
}

/** The latest unused call from this account's own number, or null. Reads only; claims nothing. */
export function pendingFor(conversationId) {
  const phone = verifiedPhone(conversationId);
  if (!phone) return null;
  return q("SELECT * FROM stranger_calls WHERE phone = ? AND used_at IS NULL ORDER BY started_at DESC LIMIT 1").get(phone) ?? null;
}

/** "earlier today", "yesterday", "on Tuesday", "on October 3". */
export function whenSaid(at, now = clock.now(), tz = config.installTz) {
  const day = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const days = Math.round((Date.parse(day(now)) - Date.parse(day(at))) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `on ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date(at))}`;
  return `on ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(new Date(at))}`;
}

/**
 * Claim this account's call, once: mark it used, attach it to them, and write it into their memory as
 * their own history. Returns what to say, or null when there is nothing (or it was already said).
 */
export function claim(conversationId, { now = clock.now() } = {}) {
  const row = pendingFor(conversationId);
  if (!row) return null;
  const won = q("UPDATE stranger_calls SET used_at = ?, matched_conversation_id = ? WHERE id = ? AND used_at IS NULL").run(now, conversationId, row.id);
  if (!won.changes) return null;
  const when = whenSaid(row.started_at, now);
  const about = row.content_dropped_at ? "" : String(row.summary ?? "");
  const date = new Date(row.started_at).toISOString().slice(0, 10);
  try {
    db.remember(conversationId, "me", `Called Reason's number on ${date} before signing up${about ? ` (${about.replace(/^They /, "they ").replace(/\.$/, "")})` : ""}`, { source: "user_stated" });
  } catch { /* the greeting still stands without the memory row */ }
  return { when, about, at: row.started_at, id: row.id };
}

/** The turn note for their first turn after the call (texts, Web — any turn they start). Once. */
export function reconnectNote(conversationId, { now = clock.now() } = {}) {
  const got = claim(conversationId, { now });
  if (!got) return "";
  return `This person rang Reason's number ${got.when}, before they had their own Reason, and spoke to you on the phone`
    + `${got.about ? ` (${got.about.replace(/^They /, "they ")})` : ""}. In this reply, and only this once, say warmly in a few words that it's good to reconnect —`
    + ` you spoke on the phone ${got.when}${got.about ? " — and you may mention what they asked about if it fits" : ""}. Then answer what they said. Never mention it again.`;
}

/** The same moment in the first-chat onboarding, which speaks in fixed lines rather than a model turn. */
export function reconnectLine(conversationId, { now = clock.now() } = {}) {
  const got = claim(conversationId, { now });
  if (!got) return "";
  return `oh hey, good to reconnect, we spoke on the phone ${got.when}!`;
}

/** Retention (called from src/privacy.js sweepRetention): words after `content`, rows after `records`. */
export function prune({ content = 0, records = 0, now = clock.now() } = {}) {
  let dropped = 0, deleted = 0;
  if (content) dropped = q("UPDATE stranger_calls SET said = '[]', summary = '', content_dropped_at = ? WHERE content_dropped_at IS NULL AND started_at < ?").run(now, content).changes;
  if (records) deleted = q("DELETE FROM stranger_calls WHERE started_at < ?").run(records).changes;
  return { dropped, deleted };
}
