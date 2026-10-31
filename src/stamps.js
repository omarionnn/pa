// Stamps (handoff 2026-10-27 "Coming back daily" §2): a passport-style book of things Reason did that
// are worth remembering. Earned by Reason's work, never by the person's attendance: nothing resets,
// nothing expires, nothing is counted against a day. Behind REASON_WEB_DAILY (src/dailyflag.js).
//
// Where a stamp comes from — the real completion points, told by src/db.js `completionBus`:
//   task      finishTask(…, { state: "done" })          → first, night_shift, three_in_one
//   call      updateCall(…, { outcome_kind })           → long_hold, human, first, night_shift
//   purchase  markAgentcardPurchase placed / issued     → price_drop, early, first, night_shift
// The same rules run over old rows in scripts/stamps-backfill.mjs (`backfill` below), so a book
// built after the fact and one built live are the same book.
//
// Not awarded, because nothing on record says it (2026-10-27): `abroad` (no country for an airport
// and no home country for a person), `whole_trip` (no stay/hotel bookings, and flights/rides carry no
// task to tie them to one thread). Their blank spots still show the hint.
//
// Idempotent: one row per (conversation, type, ref) — `ref` names the thing that earned it (task:12,
// call:7, purchase:3, first, night:2026-10-27, origin:<inbound handle>) — so a task is never stamped
// twice for the same reason, however often its completion is told or the backfill is run.
//
// Telling: a new stamp is mentioned once in the thread, one line, no confetti — an outbound message,
// so ONLY while REASON_WEB_DAILY is `on` (never at `owner`, never from the backfill, never without a
// teller installed by the server).
import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { dailyMode, dailyAllowedFor, stampsOpen, stampsAllowedFor, waxLook, everydaySeals, sealTiers } from "./dailyflag.js";
import { WAX, words, fullDate, postmarkDate } from "./seal.js";
import { holdSeconds } from "./calls/hold.js";
import { isSuccess } from "./calls/outcome.js";

// ---------------------------------------------------------------- the catalog
/**
 * Every stamp type: its name, shape (round | rect | oval | ring), ink (rust | ink), the three tiers
 * of its face, the blank spot's hint, and whether it can be earned on this install today.
 */
export const CATALOG = {
  long_hold: { name: "The long hold", shape: "round", ink: "rust", eyebrow: "THE", main: "LONG HOLD", hint: "an hour-long hold, sat through for you", earnable: true },
  night_shift: { name: "Night shift", shape: "rect", ink: "ink", eyebrow: "", main: "NIGHT SHIFT", hint: "something finished while you slept", earnable: true },
  price_drop: { name: "Price drop", shape: "oval", ink: "rust", eyebrow: "", main: "PRICE DROP", hint: "a watched price that fell, and I bought", earnable: true },
  human: { name: "Got through to a human", shape: "rect", ink: "ink", eyebrow: "GOT THROUGH TO", main: "A HUMAN", hint: "a phone menu, beaten to a real person", earnable: true },
  early: { name: "Early", shape: "ring", ink: "rust", eyebrow: "", main: "EARLY", hint: "a booking done a week ahead", earnable: true },
  abroad: { name: "Booked abroad", shape: "rect", ink: "rust", eyebrow: "BOOKED", main: "ABROAD", hint: "a booking in another country", earnable: false },
  first: { name: "First errand", shape: "round", ink: "ink", eyebrow: "THE", main: "FIRST ERRAND", hint: "the first thing I finish for you", earnable: true },
  whole_trip: { name: "A whole trip", shape: "ring", ink: "ink", eyebrow: "A WHOLE", main: "TRIP", hint: "a whole trip, start to finish", earnable: false },
  three_in_one: { name: "Three in one", shape: "oval", ink: "ink", eyebrow: "", main: "THREE IN ONE", hint: "three errands in one text", earnable: true },
  // Wax book only (REASON_STAMPS_WAX): one-offs kept outside the book. Never drawn by the typed look.
  anniversary: { name: "A year of things handled", shape: "round", ink: "ink", eyebrow: "", main: "ONE YEAR", hint: "a year together", earnable: true, waxOnly: true },
  suite_key: { name: "The suite key", shape: "round", ink: "ink", eyebrow: "", main: "SUITE KEY", hint: "a call, research, a purchase and one more, inside two hours", earnable: true, waxOnly: true },
  // Everyday seals (REASON_STAMPS_EVERYDAY, wax book only): ordinary errands, so the book isn't empty
  // until something rare happens.
  rang: { name: "Rang on your behalf", shape: "round", ink: "ink", eyebrow: "", main: "RANG", hint: "a call that got what it was for", earnable: true, waxOnly: true, everyday: true },
  looked_into: { name: "Looked into, thoroughly", shape: "round", ink: "ink", eyebrow: "", main: "LOOKED INTO", hint: "a question, researched properly", earnable: true, waxOnly: true, everyday: true },
  // An order placed through a store checkout (src/shopconnect.js, 2026-10-31: the first real one, Walmart).
  orders: { name: "First order", shape: "round", ink: "rust", eyebrow: "THE", main: "FIRST ORDER", hint: "an order placed and paid on your behalf", earnable: true, waxOnly: true, everyday: true },
};
export const TYPES = Object.keys(CATALOG);
/** The order blank spots offer their hints in: the most within reach first. */
export const HINT_ORDER = ["first", "night_shift", "three_in_one", "whole_trip", "long_hold", "human", "early", "price_drop", "abroad"];

/** Minutes on hold before a call earns The long hold (handoff: "≥ 30 min"). */
export const LONG_HOLD_S = 30 * 60;
/** Days between booking and the trip before it is Early (handoff: "≥ 7 days ahead"). */
export const EARLY_DAYS = 7;
/** Night shift: finished between midnight and 6 in the morning on their clock, with no word from them in the hour before. */
export const NIGHT_FROM = 0, NIGHT_TO = 6, NIGHT_QUIET_MS = 60 * 60_000;
/** A new stamp is never mentioned before 7 in the morning on their clock (the stamp itself is kept). */
export const QUIET_UNTIL = 7;
/** A call outcome that was a real conversation with somebody (src/calls/outcome.js). */
const TALKED = new Set(["confirmed", "goal_met", "answered", "needs_owner"]);

// ---------------------------------------------------------------- tables
db.db.exec(`
  CREATE TABLE IF NOT EXISTS stamps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    ref TEXT NOT NULL,
    earned_at INTEGER NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    task_id INTEGER,
    message_id INTEGER,
    rotation INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'live',
    told_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, type, ref)
  );
  CREATE INDEX IF NOT EXISTS stamps_by_conversation ON stamps(conversation_id, earned_at);
  CREATE TABLE IF NOT EXISTS stamp_shares (
    share_id TEXT PRIMARY KEY,
    stamp_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    show_name INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    opens INTEGER NOT NULL DEFAULT 0,
    signups INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS stamp_shares_by_stamp ON stamp_shares(stamp_id);
`);

const ONE = (sql, ...a) => db.db.prepare(sql).get(...a);
const ALL = (sql, ...a) => db.db.prepare(sql).all(...a);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** A stamp's fixed tilt, -8°..+7°, from its own identity: the same on every reload and every machine. */
export function rotationFor(conversationId, type, ref) {
  const h = createHash("sha256").update(`${conversationId}\u0000${type}\u0000${ref}`).digest();
  return (h[0] % 16) - 8;
}

// ---------------------------------------------------------------- time
/** Their clock: the zone they said, else the one read off their calendar, else the install's (as src/notice.js). */
export function tzFor(conversationId) {
  try {
    return db.noticePrefs(conversationId)?.tz || db.noticeSweep(conversationId)?.time_zone || config.tz;
  } catch { return config.tz; }
}
const hourIn = (ms, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(ms)) % 24;
const dayIn = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
/** "OCT 26" on their clock. */
export const monthDay = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(ms).toUpperCase();
/** "3:12 AM" on their clock. */
const clockTime = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);

/** Was this conversation quiet (nothing from them) in the hour before `at`? Asleep, as far as anything on record says. */
function quietBefore(conversationId, at) {
  const from = at - NIGHT_QUIET_MS;
  const sms = ONE("SELECT 1 AS x FROM inbound_messages WHERE conversation_id = ? AND received_at BETWEEN ? AND ? LIMIT 1", conversationId, from, at);
  if (sms) return false;
  try {
    const web = ONE("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND role = 'user' AND at BETWEEN ? AND ? LIMIT 1", conversationId, from, at);
    if (web) return false;
  } catch { /* no history table on an old install: SMS is the record */ }
  return true;
}

/** Night shift, if `at` was in the small hours on their clock and they were quiet: one per night. */
function nightShift(conversationId, at, extra = {}) {
  const tz = tzFor(conversationId);
  const h = hourIn(at, tz);
  if (h < NIGHT_FROM || h >= NIGHT_TO || !quietBefore(conversationId, at)) return null;
  return { type: "night_shift", ref: `night:${dayIn(at, tz)}`, at, detail: { time: at }, ...extra };
}

// ---------------------------------------------------------------- what counts as finished
/** Every finished errand in a conversation, oldest first: `{ kind, id, at }` (done tasks, calls that got somewhere, orders placed). */
function completions(conversationId) {
  const out = [];
  for (const t of ALL("SELECT id, finished_at AS at FROM tasks WHERE conversation_id = ? AND state = 'done' AND finished_at IS NOT NULL", conversationId)) out.push({ kind: "task", id: t.id, at: t.at });
  for (const c of ALL("SELECT id, outcome_kind, COALESCE(ended_at, updated_at) AS at FROM calls WHERE conversation_id = ? AND outcome_kind <> ''", conversationId)) {
    if (isSuccess(c.outcome_kind)) out.push({ kind: "call", id: c.id, at: c.at });
  }
  for (const p of purchasesDone(conversationId)) out.push({ kind: "purchase", id: p.id, at: p.updated_at });
  return out.sort((a, b) => a.at - b.at || a.id - b.id);
}
function purchasesDone(conversationId) {
  try {
    return ALL("SELECT * FROM agentcard_purchases WHERE conversation_id = ? AND (status IN ('placed','partially_placed') OR ticketing_state = 'issued')", conversationId);
  } catch { return []; }
}
/** Is this the conversation's first finished errand? */
function isFirst(conversationId, kind, id) {
  const all = completions(conversationId);
  return all.length > 0 && all[0].kind === kind && all[0].id === id;
}

/** The stamps one done task earns. */
export function candidatesForTask(task) {
  if (!task || task.state !== "done" || !task.finished_at) return [];
  const c = task.conversation_id, at = task.finished_at, out = [];
  if (isFirst(c, "task", task.id)) out.push({ type: "first", ref: "first", at, taskId: task.id, detail: {} });
  const night = nightShift(c, at, { taskId: task.id });
  if (night) out.push(night);
  const handle = String(task.origin_handle ?? "");
  if (handle) {
    const same = ALL("SELECT id, finished_at FROM tasks WHERE conversation_id = ? AND origin_handle = ? AND state = 'done' AND finished_at IS NOT NULL ORDER BY finished_at, id", c, handle);
    // On the third one done (or later, for a backfill that sees them all at once): the moment all three were.
    const third = same[2];
    if (third && at >= third.finished_at) {
      out.push({ type: "three_in_one", ref: `origin:${createHash("sha256").update(handle).digest("hex").slice(0, 16)}`, at: third.finished_at, taskId: third.id, detail: { count: same.length } });
    }
  }
  return out;
}

/** The stamps one ended call earns. */
export function candidatesForCall(call) {
  if (!call || !call.outcome_kind) return [];
  const c = call.conversation_id, at = call.ended_at ?? call.updated_at ?? clock.now(), out = [];
  const talked = TALKED.has(call.outcome_kind);
  const brief = parse(call.brief, {});
  const place = String(brief?.place ?? "").trim();
  const held = holdSeconds({ ...call, hold_since: 0 });
  if (talked && held >= LONG_HOLD_S) out.push({ type: "long_hold", ref: `call:${call.id}`, at, taskId: call.task_id ?? null, detail: { minutes: Math.round(held / 60), place } });
  const presses = parse(call.menu_presses, []);
  if (talked && Array.isArray(presses) && presses.length > 0) out.push({ type: "human", ref: `call:${call.id}`, at, taskId: call.task_id ?? null, detail: { place, presses: presses.length } });
  // Rang on your behalf: a call Reason placed to someone else that got what it was for, unless a rarer seal
  // marks it — judged only once the call is over, when its hold and menu presses are all in.
  if (everydaySeals() && isSuccess(call.outcome_kind) && call.ended_at && !Number(call.is_owner) && call.direction !== "in" && !out.length) {
    out.push({ type: "rang", ref: `call:${call.id}`, at, taskId: call.task_id ?? null, detail: { place } });
  }
  if (isSuccess(call.outcome_kind)) {
    if (isFirst(c, "call", call.id)) out.push({ type: "first", ref: "first", at, taskId: call.task_id ?? null, detail: {} });
    const night = nightShift(c, at, { taskId: call.task_id ?? null });
    if (night) out.push(night);
  }
  return out;
}

/** The Monday a moment's week began, on their clock ("2026-10-26"). */
function weekOf(ms, tz) {
  const day = Date.parse(`${dayIn(ms, tz)}T00:00:00Z`);
  const back = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - back * 86_400_000).toISOString().slice(0, 10);
}
/** A question as it counts: case, punctuation and spacing don't make it a different one. */
const questionKey = (q) => createHash("sha256").update(String(q ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()).digest("hex").slice(0, 16);
/**
 * The seal finished research earns: Looked into, thoroughly. Two rows, so either book reads right:
 *   research:week:<Monday>        one a week (the #251 book, REASON_STAMPS_TIERS off)
 *   research:q:<day>:<question>   one per question per day on their clock (the tiered book counts these:
 *                                 the same question asked again that day counts once)
 * Each book hides the other's rows (hiddenRef).
 */
export function candidatesForResearch(r) {
  if (!everydaySeals() || !r || r.state !== "done" || !r.finished_at) return [];
  const tz = tzFor(r.conversation_id), at = r.finished_at, taskId = r.task_id ?? null;
  return [
    { type: "looked_into", ref: `research:week:${weekOf(at, tz)}`, at, taskId, detail: {} },
    { type: "looked_into", ref: `research:q:${dayIn(at, tz)}:${questionKey(r.question)}`, at, taskId, detail: {} },
  ];
}

/**
 * The seal an order placed through a store checkout earns (shop_runs: succeeded, placed): one row per
 * order, so the tiered book counts them — the plain seal at the first, upgraded at TIERS.orders.
 */
export function candidatesForOrder(run, { place = "" } = {}) {
  if (!everydaySeals() || !run || run.status !== "succeeded" || run.stage !== "placed") return [];
  const at = run.stage_at ?? run.updated_at ?? clock.now();
  // The store as it is named to them (the event carries it); the backfill has only the key.
  const store = String(place || run.store || "");
  return [{ type: "orders", ref: `order:${run.run_id}`, at, detail: { place: store ? (store[0].toUpperCase() + store.slice(1)) : "" } }];
}

/** The stamps one placed order (or issued ticket) earns. */
export function candidatesForPurchase(p) {
  if (!p) return [];
  const done = ["placed", "partially_placed"].includes(p.status) || p.ticketing_state === "issued";
  if (!done) return [];
  const c = p.conversation_id, at = p.updated_at ?? clock.now(), out = [];
  // Price drop: the order is the very offer a price watch proved lower than where it started.
  if (p.offer_id) {
    const w = ONE("SELECT w.baseline_cents, o.price_cents FROM watches w JOIN offers o ON o.id = w.alert_offer_id WHERE w.kind = 'price' AND w.conversation_id = ? AND w.alert_offer_id = ? LIMIT 1", c, p.offer_id);
    const saved = w && w.baseline_cents != null && w.price_cents != null ? w.baseline_cents - w.price_cents : 0;
    if (saved >= 100) out.push({ type: "price_drop", ref: `purchase:${p.id}`, at, detail: { savedCents: saved, merchant: p.merchant ?? "" } });
  }
  // Early: a flight booked a week or more before it leaves (the first leg, its own wall clock).
  if (p.kind === "flight") {
    const legs = parse(p.flight_json, {})?.legs ?? [];
    const dep = legs[0]?.departureAt ? Date.parse(`${String(legs[0].departureAt).slice(0, 19)}Z`) : NaN;
    const days = Number.isFinite(dep) ? Math.floor((dep - p.created_at) / 86_400_000) : -1;
    if (days >= EARLY_DAYS) out.push({ type: "early", ref: `purchase:${p.id}`, at, detail: { days, what: "booking" } });
  }
  if (isFirst(c, "purchase", p.id)) out.push({ type: "first", ref: "first", at, detail: {} });
  const night = nightShift(c, at);
  if (night) out.push(night);
  return out;
}

// ---------------------------------------------------------------- awarding
/** Write one stamp unless it is already there. Returns the new row's id, or null when it existed. */
export function award(conversationId, { type, ref, at, detail = {}, taskId = null }, { source = "live" } = {}) {
  if (!CATALOG[type] || !CATALOG[type].earnable || !conversationId || !ref) return null;
  if (CATALOG[type].everyday && !everydaySeals()) return null;
  const r = db.db.prepare(`INSERT OR IGNORE INTO stamps (conversation_id, type, ref, earned_at, detail_json, task_id, rotation, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, type, ref, Math.round(at ?? clock.now()), JSON.stringify(detail ?? {}), taskId, rotationFor(conversationId, type, ref), source, clock.now());
  return r.changes ? Number(r.lastInsertRowid) : null;
}

let teller = null;
let tellDelayMs = 4000;
let logger = () => {};

/** The line a new stamp is mentioned with in the thread: one line, no confetti. */
export function tellLine(types) {
  if (waxLook()) {
    // A kind once, however many rows it came with; a tier says its count ("…, ten times now").
    const seals = [...new Set(types.map(t => typeof t === "string" ? SEALS[t]?.name
      : SEALS[t.type] ? `${SEALS[t.type].name}, ${W(t.count)} times now` : null).filter(Boolean))];
    if (!seals.length) return "";
    const said = seals.length === 1 ? seals[0] : `${seals.slice(0, -1).join(", ")} and ${seals.at(-1)}`;
    return `That one went into your book: ${said}.`;
  }
  const names = types.filter(t => !CATALOG[t]?.waxOnly).map(t => CATALOG[t]?.name).filter(Boolean);
  if (!names.length) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `That one earned a stamp for your book: ${list}.`;
}

/**
 * Is this new row news for the book? A row the book hides never is. With tiers on, a kind already in the
 * book is news only when the count reaches a tier (an everyday seal) — never for a rare seal earned again.
 * Returns the count it brings the kind to (truthy) or 0.
 */
function bookNews(row) {
  if (hiddenRef(row)) return 0;
  if (!sealTiers()) return 1;
  const n = ONE("SELECT COUNT(*) AS n FROM stamps WHERE conversation_id = ? AND type = ? AND id <= ? AND ref NOT LIKE 'research:week:%'", row.conversation_id, row.type, row.id).n;
  if (n === 1) return 1;
  return CATALOG[row.type]?.everyday && tiersFor(row.type).includes(n) ? n : 0;
}

function tellNew(conversationId, ids) {
  // Outbound: only when the flag is fully on, only for a conversation it allows, only with a server teller.
  if (!ids.length || dailyMode() !== "on" || !dailyAllowedFor(conversationId) || typeof teller !== "function") return;
  // Never in the small hours on their clock: the book shows it either way, the text simply isn't sent.
  if (hourIn(clock.now(), tzFor(conversationId)) < QUIET_UNTIL) return;
  const rows = ids.map(id => ONE("SELECT id, conversation_id, type, ref, told_at FROM stamps WHERE id = ?", id)).filter(r => r && !r.told_at)
    .map(r => ({ ...r, count: bookNews(r) })).filter(r => r.count);
  if (!rows.length) return;
  const line = tellLine(rows.map(r => r.count > 1 ? { type: r.type, count: r.count } : r.type));
  if (!line) return;
  const send = () => {
    try {
      for (const r of rows) db.db.prepare("UPDATE stamps SET told_at = ? WHERE id = ? AND told_at IS NULL").run(clock.now(), r.id);
      Promise.resolve(teller(conversationId, line, { idempotencyKey: `stamp:${rows.map(r => r.id).join(",")}` }))
        .catch(e => logger({ stamp_tell_failed: (e?.message ?? String(e)).split("\n")[0] }));
    } catch (e) { logger({ stamp_tell_failed: (e?.message ?? String(e)).split("\n")[0] }); }
  };
  if (tellDelayMs > 0) { const t = setTimeout(send, tellDelayMs); t.unref?.(); } else send();
}

/** Award what one completion earned, live. Only for a person's own conversation (an account) that Stamps allows (REASON_WEB_DAILY or REASON_STAMPS_ALL). */
export function awardLive(conversationId, candidates) {
  if (!stampsAllowedFor(conversationId) || !db.getAccount(conversationId)) return [];
  const ids = [];
  for (const c of candidates) {
    const id = award(conversationId, c);
    if (id) { ids.push(id); logger({ stamp_awarded: c.type }); }
  }
  tellNew(conversationId, ids);
  return ids;
}

const onTask = ({ conversationId, id }) => {
  try { awardLive(conversationId, candidatesForTask(db.getTask(conversationId, id))); } catch (e) { logger({ stamp_award_failed: (e?.message ?? String(e)).split("\n")[0] }); }
};
const onCall = ({ conversationId, id }) => {
  try { awardLive(conversationId, candidatesForCall(db.getCall(conversationId, id))); } catch (e) { logger({ stamp_award_failed: (e?.message ?? String(e)).split("\n")[0] }); }
};
const onPurchase = ({ buyConversationId }) => {
  try {
    const p = db.getAgentcardPurchase(buyConversationId);
    if (p) awardLive(p.conversation_id, candidatesForPurchase(p));
  } catch (e) { logger({ stamp_award_failed: (e?.message ?? String(e)).split("\n")[0] }); }
};
const onResearch = ({ conversationId, id }) => {
  try { if (everydaySeals()) awardLive(conversationId, candidatesForResearch(db.getResearch(conversationId, id))); } catch (e) { logger({ stamp_award_failed: (e?.message ?? String(e)).split("\n")[0] }); }
};
const orderRow = (runId) => db.db.prepare("SELECT run_id, conversation_id, store, item, status, stage, stage_at, updated_at, created_at FROM shop_runs WHERE run_id = ?").get(runId);
const onOrder = ({ conversationId, runId, store = "" }) => {
  try { if (everydaySeals()) awardLive(conversationId, candidatesForOrder(orderRow(runId), { place: store })); } catch (e) { logger({ stamp_award_failed: (e?.message ?? String(e)).split("\n")[0] }); }
};
/** After any finished errand (research included): the suite key and the anniversary, if this one completed them. */
const onAny = (conversationId) => {
  try {
    if (!waxLook() || !conversationId || !stampsAllowedFor(conversationId) || !db.getAccount(conversationId)) return;
    awardLive(conversationId, [...suiteCandidates(conversationId), ...anniversaryCandidates(conversationId)]);
  } catch (e) { logger({ stamp_award_failed: (e?.message ?? String(e)).split("\n")[0] }); }
};
db.completionBus.on("task", onTask);
db.completionBus.on("call", onCall);
db.completionBus.on("purchase", onPurchase);
db.completionBus.on("research", onResearch);
db.completionBus.on("order", onOrder);
db.completionBus.on("task", ({ conversationId }) => onAny(conversationId));
db.completionBus.on("call", ({ conversationId }) => onAny(conversationId));
db.completionBus.on("order", ({ conversationId }) => onAny(conversationId));
db.completionBus.on("research", ({ conversationId }) => onAny(conversationId));
db.completionBus.on("purchase", ({ buyConversationId }) => {
  try {
    const p = db.getAgentcardPurchase(buyConversationId);
    if (!p) return;
    // When it was placed: updated_at moves on with every later write (a cancel reason, a told-at), so the
    // moment is kept here, once.
    if (waxLook()) db.db.prepare("INSERT OR IGNORE INTO stamp_step_times (conversation_id, kind, ref_id, finished_at) VALUES (?, 'purchase', ?, ?)").run(p.conversation_id, p.id, clock.now());
    onAny(p.conversation_id);
  } catch { /* never costs the write */ }
});

/**
 * The server's half: how a stamp is mentioned (runtime._tell) and where its log lines go. Without it
 * nothing is ever sent. `delayMs` lets the errand's own reply land first.
 */
export function installStamps({ tell = null, log = null, delayMs = 4000 } = {}) {
  teller = tell;
  if (typeof log === "function") logger = log;
  tellDelayMs = delayMs;
}

/**
 * Every stamp the record already earns, for one conversation: the same rules, run over old rows, in
 * the order they happened. Only INSERTs into `stamps`; reads everything else. Never tells anyone.
 * `dryRun` counts without writing. Returns { [type]: n }.
 */
export function backfill(conversationId, { dryRun = false } = {}) {
  const found = [];
  for (const t of ALL("SELECT * FROM tasks WHERE conversation_id = ? AND state = 'done' AND finished_at IS NOT NULL ORDER BY finished_at, id", conversationId)) found.push(...candidatesForTask(t));
  for (const c of ALL("SELECT * FROM calls WHERE conversation_id = ? AND outcome_kind <> '' ORDER BY id", conversationId)) found.push(...candidatesForCall(c));
  for (const p of purchasesDone(conversationId)) found.push(...candidatesForPurchase(p));
  if (everydaySeals()) {
    try {
      for (const r of ALL("SELECT * FROM research WHERE conversation_id = ? AND state = 'done' AND finished_at IS NOT NULL ORDER BY finished_at, id", conversationId)) found.push(...candidatesForResearch(r));
    } catch { /* no research table on an old install */ }
    try {
      for (const r of ALL("SELECT run_id, conversation_id, store, item, status, stage, stage_at, updated_at, created_at FROM shop_runs WHERE conversation_id = ? AND status = 'succeeded' AND stage = 'placed' ORDER BY stage_at, created_at", conversationId)) found.push(...candidatesForOrder(r));
    } catch { /* no checkouts on this install */ }
  }
  if (waxLook()) found.push(...suiteCandidates(conversationId, { all: true, dryRun }), ...anniversaryCandidates(conversationId));
  const seen = new Set(), counts = {};
  for (const c of found.sort((a, b) => a.at - b.at)) {
    const key = `${c.type}\u0000${c.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exists = ONE("SELECT 1 AS x FROM stamps WHERE conversation_id = ? AND type = ? AND ref = ?", conversationId, c.type, c.ref);
    if (exists) continue;
    if (!dryRun && !award(conversationId, c, { source: "backfill" })) continue;
    // Counted as the book draws them: research's other row (weekly or per question) is written, not counted.
    if (hiddenRef(c)) continue;
    counts[c.type] = (counts[c.type] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------- reading
/** "52 MIN" and friends: the third tier, as the owner sees it in their own book. */
function privateDetail(type, d) {
  switch (type) {
    case "long_hold": return d.minutes ? `${d.minutes} MIN` : "";
    case "night_shift": return "DONE WHILE YOU SLEPT";
    case "price_drop": return d.savedCents ? `SAVED $${Math.round(d.savedCents / 100)}` : "";
    case "human": return d.place ? cutUpper(d.place, 18) : "";
    case "early": return d.days ? `${d.days} DAYS AHEAD` : "";
    case "abroad": return d.city ? cutUpper(d.city, 14) : "";
    case "three_in_one": return d.count ? `${d.count} ERRANDS, ONE TEXT` : "ONE TEXT";
    default: return "";
  }
}
const cutUpper = (s, n) => { const t = String(s).replace(/\s+/g, " ").trim().toUpperCase(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** The full label a screen reader hears, owner's view ("Stamp: The long hold, 52 minutes"). */
function privateAria(type, d) {
  const name = CATALOG[type].name;
  switch (type) {
    case "long_hold": return d.minutes ? `Stamp: ${name}, ${d.minutes} minutes` : `Stamp: ${name}`;
    case "night_shift": return `Stamp: ${name}, done while you slept`;
    case "price_drop": return d.savedCents ? `Stamp: ${name}, saved ${Math.round(d.savedCents / 100)} dollars` : `Stamp: ${name}`;
    case "human": return d.place ? `Stamp: ${name}, ${d.place}` : `Stamp: ${name}`;
    case "early": return d.days ? `Stamp: ${name}, ${d.days} days ahead` : `Stamp: ${name}`;
    case "three_in_one": return d.count ? `Stamp: ${name}, ${d.count} errands from one text` : `Stamp: ${name}`;
    default: return `Stamp: ${name}`;
  }
}

/** Two or three sentences in Reason's voice, for the owner's own book (never shared). */
function storyFor(type, d, earnedAt, tz) {
  const where = d.place ? ` with ${d.place}` : "";
  switch (type) {
    case "long_hold": return `I sat on hold for ${d.minutes} minutes${where} so you didn't have to. When somebody finally picked up, I took it from there.`;
    case "human": return `${d.place ? `${d.place}'s line` : "The line"} started with a phone menu. I pressed my way through it and got a real person to talk to.`;
    case "night_shift": return `I finished this one at ${clockTime(d.time ?? earnedAt, tz)}, while you were asleep. It was done before your morning started.`;
    case "price_drop": return `I kept an eye on the price, and it fell by $${Math.round((d.savedCents ?? 0) / 100)}. I bought it at the lower one.`;
    case "early": return `I had this booked ${d.days} days ahead, well before it could turn into a rush.`;
    case "first": return "The first thing you asked me to do, done. This is where the book starts.";
    case "three_in_one": return `One text, ${d.count ?? 3} errands. I took each of them from there to done.`;
    default: return "";
  }
}

/** A message in the thread near the moment it was earned, for "See it in the thread" (null: the thread itself). */
function messageNear(conversationId, at) {
  try {
    const r = ONE(`SELECT id FROM messages WHERE conversation_id = ? AND chat_id IS NULL AND deleted_at IS NULL AND role = 'assistant' AND at BETWEEN ? AND ? ORDER BY at, id LIMIT 1`, conversationId, at - 5_000, at + 15 * 60_000);
    return r?.id ?? null;
  } catch { return null; }
}

/** One row → the summary every screen draws from. */
export function summarize(row) {
  if (!row || !CATALOG[row.type]) return null;
  if (CATALOG[row.type].waxOnly && !waxLook()) return null;
  if (waxLook()) return waxSummary(row);
  const k = CATALOG[row.type];
  const d = parse(row.detail_json, {});
  const tz = tzFor(row.conversation_id);
  let messageId = row.message_id ?? null;
  if (messageId == null) {
    messageId = messageNear(row.conversation_id, row.earned_at);
    if (messageId != null) { try { db.db.prepare("UPDATE stamps SET message_id = ? WHERE id = ?").run(messageId, row.id); } catch { /* read-only is fine */ } }
  }
  return {
    id: row.id,
    type: row.type,
    name: k.name,
    detail: privateDetail(row.type, d),
    story: storyFor(row.type, d, row.earned_at, tz),
    earnedAt: row.earned_at,
    shape: k.shape,
    ink: k.ink,
    rotation: row.rotation,
    ariaLabel: privateAria(row.type, d),
    // Beyond the handoff's StampSummary, for the book itself:
    date: monthDay(row.earned_at, tz),
    href: messageId != null ? `/web?at=${messageId}` : "/web?thread",
  };
}

// ---------------------------------------------------------------- one seal per kind (REASON_STAMPS_TIERS)
/**
 * The counts at which an everyday seal is upgraded in place, per kind, scaled to how often the kind really
 * happens (live 10-30: the busiest book had 66 researches in 25 days, the only call that got what it was for
 * was one), so nobody fills a kind in a fortnight. The plain seal is tier 1; these are tiers 2, 3 and 4.
 *   looked_into  500 / 1000 / 2000   research is the commonest thing done: ~2–3 a day at most, 500 is months
 *   rang          25 /  100 /  250   a call that got what it was for is rare: a handful a month at most
 */
export const TIERS = { looked_into: [500, 1000, 2000], rang: [25, 100, 250], orders: [10, 50, 100] };
const tiersFor = (type) => TIERS[type] ?? [];
/** The count of the tier a count has reached for a kind: 1 (the plain seal) or one of its TIERS. */
export const tierOf = (n, type) => tiersFor(type).reduce((t, x) => (n >= x ? x : t), 1);
/** Which tier that is: 1 (plain) to 4 (the last), what the drawing goes by (seal.js tierArt). */
export const levelOf = (n, type) => 1 + tiersFor(type).filter(x => n >= x).length;
/** The next tier's count after a count for a kind, or null past the last. */
export const nextTier = (n, type) => tiersFor(type).find(x => x > n) ?? null;
/** A row the current book doesn't draw: research is stored both weekly and per question (candidatesForResearch). */
export function hiddenRef(row) {
  if (row?.type !== "looked_into") return false;
  const ref = String(row.ref ?? "");
  return sealTiers() ? ref.startsWith("research:week:") : ref.startsWith("research:q:");
}
/** "Once · next at 25", "62 times · next at 500", "2400 times": the line under a tiered seal's name. */
export function countLine(n, type) {
  const next = nextTier(n, type);
  return `${n === 1 ? "Once" : `${n} times`}${next ? ` · next at ${next}` : ""}`;
}

/**
 * The book as it is drawn: summaries (oldest first, each with `.row`) → the hidden rows dropped and, with
 * tiers on, one seal per kind. An everyday kind keeps its first row's identity (id, tilt, share) and gains
 * `count`, `tier`, `next`, `firstDate`; its date, postmark and place in the order are the moment its tier
 * was reached, so an upgrade lands as the newest. A rare kind earned again shows its first one only.
 */
export function foldBook(items) {
  const shown = items.filter(s => s && !hiddenRef(s.row));
  if (!sealTiers()) return shown;
  const by = new Map();
  for (const s of shown) by.set(s.type, [...(by.get(s.type) ?? []), s]);
  const out = [];
  for (const [type, list] of by) {
    const first = list[0];
    if (!CATALOG[type]?.everyday || !SEALS[type]) { out.push(first); continue; }
    const n = list.length, tier = tierOf(n, type), reached = list[tier - 1], last = list.at(-1);
    const tz = tzFor(first.row.conversation_id), d = parse(last.row.detail_json, {});
    out.push({
      ...first, count: n, tier, level: levelOf(n, type), next: nextTier(n, type), countLine: countLine(n, type),
      firstAt: first.earnedAt, firstDate: first.date,
      earnedAt: reached.earnedAt, date: reached.date, postmarkDate: reached.postmarkDate,
      story: n > 1 ? tierStory(type, d, n, last.earnedAt, tz) : first.story, href: last.href,
      ariaLabel: `${first.ariaLabel}, ${n === 1 ? "once" : `${W(n)} times`}`,
    });
  }
  return out.sort((a, b) => a.earnedAt - b.earnedAt || a.id - b.id);
}

/** Every stamp in this conversation's book, oldest first (each with its `.row`). */
export function listStamps(conversationId) {
  if (!conversationId) return [];
  return foldBook(ALL("SELECT * FROM stamps WHERE conversation_id = ? ORDER BY earned_at, id", conversationId)
    .map(r => { const s = summarize(r); return s ? { ...s, row: r } : null; }));
}

/** One stamp, only from this conversation's own book. */
export function stampFor(conversationId, id) {
  if (!conversationId || !/^\d{1,12}$/.test(String(id ?? ""))) return null;
  return summarize(ONE("SELECT * FROM stamps WHERE id = ? AND conversation_id = ?", Number(id), conversationId));
}

/**
 * The newest stamp if it was earned in the last `days` days, else null (Home's "New in your book").
 * Data only: the caller gates on REASON_WEB_DAILY.
 */
export function newestStamp(conversationId, { days = 7, now = clock.now() } = {}) {
  if (!conversationId) return null;
  if (everydaySeals()) {
    // The book as drawn: an everyday seal earned again is new only when it reached a tier.
    // Without its row: the daily edition stores this, and the row carries the place and the ref.
    const s = listStamps(conversationId).filter(s => !OUTSIDE.includes(s.type) && s.earnedAt >= now - days * 86_400_000).at(-1);
    if (!s) return null;
    const { row, ...summary } = s;
    return summary;
  }
  const outside = waxLook() ? OUTSIDE.map(t => `'${t}'`).join(",") : "'anniversary','suite_key'";
  const row = ONE(`SELECT * FROM stamps WHERE conversation_id = ? AND earned_at >= ? AND type NOT IN (${outside}) ORDER BY earned_at DESC, id DESC LIMIT 1`, conversationId, now - days * 86_400_000);
  return summarize(row);
}

// ---------------------------------------------------------------- what may leave the book
/**
 * The stamp as a stranger may see it: name, a duration or a count, nothing else. No merchant, no
 * company, no city, no price, no person, nothing from the thread. [COMPANY] → "A HUMAN" (already the
 * name; no detail), [CITY] → "ABROAD", SAVED $n → no amount.
 */
export function publicFace(stamp) {
  const k = CATALOG[stamp.type];
  const d = typeof stamp.detail_json === "string" ? parse(stamp.detail_json, {}) : (stamp.values ?? {});
  let detail = "", aria = `Stamp: ${k.name}`;
  if (stamp.type === "long_hold" && Number.isFinite(d.minutes)) { detail = `${d.minutes} MIN`; aria += `, ${d.minutes} minutes`; }
  if (stamp.type === "night_shift") { detail = "DONE WHILE YOU SLEPT"; aria += ", done while you slept"; }
  if (stamp.type === "early" && Number.isFinite(d.days)) { detail = `${d.days} DAYS AHEAD`; aria += `, ${d.days} days ahead`; }
  if (stamp.type === "three_in_one" && Number.isFinite(d.count)) { detail = `${d.count} ERRANDS`; aria += `, ${d.count} errands`; }
  return { type: stamp.type, name: k.name, shape: k.shape, ink: k.ink, eyebrow: k.eyebrow, main: k.main, detail, rotation: stamp.rotation ?? 0, ariaLabel: aria };
}

/** A first name fit to print: one word of letters, at most 20. Anything else is left off. */
export function firstNameOf(name) {
  const w = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}][\p{L}'’-]{0,19}$/u.test(w) ? w : "";
}

/** The one line a share carries: "Reason sat on hold for 52 minutes so Omari didn't have to." */
export function publicLine(stamp, first = "") {
  const d = typeof stamp.detail_json === "string" ? parse(stamp.detail_json, {}) : (stamp.values ?? {});
  const who = first ? `${first} didn't` : "I didn't";
  const did = {
    long_hold: Number.isFinite(d.minutes) ? `sat on hold for ${d.minutes} minutes` : "sat through a long hold",
    night_shift: "worked the night shift",
    price_drop: "caught a price drop",
    human: "got through to a human",
    early: Number.isFinite(d.days) ? `got it done ${d.days} days ahead` : "got it done early",
    abroad: "booked a trip abroad",
    first: "ran a first errand",
    whole_trip: "booked a whole trip",
    three_in_one: Number.isFinite(d.count) ? `handled ${d.count} errands from one text` : "handled three errands from one text",
  }[stamp.type] ?? "did something worth remembering";
  return `Reason ${did} so ${who} have to.`;
}

// ---------------------------------------------------------------- shares
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * A share's id: 12 characters of base62 from crypto (~71 bits), never derived from the stamp. Twelve on
 * purpose: a ride-along sign-in link under the same /s/ is 32–64 characters of base64url
 * (src/signin-remote.js TOKEN), so the two can never be mistaken for each other.
 */
export const SHARE_ID = /^[0-9A-Za-z]{12}$/;
export function newShareId() {
  let out = "";
  while (out.length < 12) {
    for (const b of randomBytes(16)) { if (b < 248 && out.length < 12) out += B62[b % 62]; }
  }
  return out;
}

/** The public address of one share. */
export const shareUrl = (shareId) => `${(config.siteUrl || "https://heyreason.com").replace(/\/+$/, "")}/s/${shareId}`;

/** This stamp's live share (not revoked), or null. */
export function activeShare(stampId) {
  return ONE("SELECT * FROM stamp_shares WHERE stamp_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", stampId) ?? null;
}

/**
 * Share one of this conversation's stamps: its live link if it has one (the name choice updated),
 * else a new one. Null when the stamp is not theirs.
 */
export function shareStamp(conversationId, stampId, { showName = true, log = () => {} } = {}) {
  const s = stampFor(conversationId, stampId);
  if (!s) return null;
  const live = activeShare(s.id);
  if (live) {
    if (!!live.show_name !== !!showName) db.db.prepare("UPDATE stamp_shares SET show_name = ? WHERE share_id = ?").run(showName ? 1 : 0, live.share_id);
    return { shareId: live.share_id, url: shareUrl(live.share_id), created: false };
  }
  let id = newShareId();
  while (ONE("SELECT 1 AS x FROM stamp_shares WHERE share_id = ?", id)) id = newShareId();
  db.db.prepare("INSERT INTO stamp_shares (share_id, stamp_id, conversation_id, show_name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, s.id, conversationId, showName ? 1 : 0, clock.now());
  log({ stamp_share_created: true, type: s.type });
  return { shareId: id, url: shareUrl(id), created: true };
}

/** Stop sharing this stamp: every live link to it is turned off. True when one was. */
export function revokeShares(conversationId, stampId, { log = () => {} } = {}) {
  const s = stampFor(conversationId, stampId);
  if (!s) return false;
  const r = db.db.prepare("UPDATE stamp_shares SET revoked_at = ? WHERE stamp_id = ? AND conversation_id = ? AND revoked_at IS NULL").run(clock.now(), s.id, conversationId);
  if (r.changes) log({ stamp_share_revoked: true, type: s.type });
  return r.changes > 0;
}

/**
 * A share as the public page needs it: the share row, its stamp row, and the first name when the owner
 * chose to show it. Null for an id that was never issued (or malformed), so the caller falls through.
 */
export function shareView(shareId) {
  if (!SHARE_ID.test(String(shareId ?? ""))) return null;
  const share = ONE("SELECT * FROM stamp_shares WHERE share_id = ?", shareId);
  if (!share) return null;
  const stamp = ONE("SELECT * FROM stamps WHERE id = ? AND conversation_id = ?", share.stamp_id, share.conversation_id);
  const acct = share.show_name ? db.getAccount(share.conversation_id) : null;
  return { share, stamp, revoked: !!share.revoked_at || !stamp, first: firstNameOf(acct?.name ?? "") };
}

/** Someone opened a share's page (not its picture). Counted on the row and logged by event name. */
export function noteShareOpened(shareId, { log = () => {} } = {}) {
  db.db.prepare("UPDATE stamp_shares SET opens = opens + 1 WHERE share_id = ?").run(shareId);
  log({ stamp_share_opened: true });
}

/**
 * A sign-up that came from a share: the website's join form carried `ref=s_<shareId>` (the public
 * page's CTA puts it on the homepage link). Counted against that share; anything else is ignored.
 */
export function noteShareSignup(ref, { log = () => {} } = {}) {
  if (dailyMode() === "off" && !stampsOpen()) return false;
  const m = /^s_([0-9A-Za-z]{12})$/.exec(String(ref ?? ""));
  if (!m) return false;
  const r = db.db.prepare("UPDATE stamp_shares SET signups = signups + 1 WHERE share_id = ?").run(m[1]);
  if (r.changes) log({ stamp_share_signup: true });
  return r.changes > 0;
}

// ---------------------------------------------------------------- the stamp, drawn
const SHAPES = {
  // [width, height, vertical margin, css], at the book's size (reference/stamps.html).
  round: [120, 120, 0, (s, c) => `border-radius:50%;border:${4 * s}px double ${c}`],
  rect: [140, 96, 12, (s, c) => `border:${2 * s}px solid ${c};outline:${Math.max(1, s)}px dashed ${c};outline-offset:${-8 * s}px;border-radius:${4 * s}px`],
  oval: [148, 100, 10, (s, c) => `border-radius:50%;border:${2.5 * s}px solid ${c}`],
  ring: [116, 116, 2, (s, c) => `border-radius:50%;border:${2 * s}px solid ${c};outline:${Math.max(1, s)}px solid ${c};outline-offset:${4 * s}px`],
};
const INK = { rust: "var(--pen,#9c3b2e)", ink: "var(--ink,#2a2520)" };
const SIZES = { sm: 100 / 120, md: 1, lg: 1.75 };
const escHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const px = (n) => `${Math.round(n * 10) / 10}px`;

/**
 * One stamp as HTML: CSS borders, typed capitals in three tiers, its fixed tilt. role="img" with the full
 * label. Self-contained (inline styles, the page's own --pen/--ink when it has them), so any page can
 * draw it. `summary`: a StampSummary (newestStamp, listStamps) or a publicFace. `size`: sm | md | lg,
 * or a number (1 = the book's size). `tilt: false` draws it straight.
 */
export function stampMarkup(summary, { size = "md", tilt = true, cls = "" } = {}) {
  if (!summary || !CATALOG[summary.type]) return "";
  const k = CATALOG[summary.type];
  const s = typeof size === "number" ? size : (SIZES[size] ?? 1);
  const [w, h, m, border] = SHAPES[k.shape];
  const c = INK[k.ink];
  const eyebrow = summary.eyebrow ?? k.eyebrow;
  const main = summary.main ?? k.main;
  const detail = summary.detail ?? "";
  // Tier sizes per shape, from the reference's own stamps.
  const t = k.shape === "rect" ? { e: 9, m: 15, d: 9, gap: 4, ml: ".08em" } : k.shape === "oval" ? { e: 9, m: 14, d: 10, gap: 2, ml: ".08em" } : k.shape === "ring" ? { e: 9, m: 16, d: 9, gap: 3, ml: ".1em" } : { e: 10, m: 15, d: 10, gap: 3, ml: ".04em" };
  const mainSize = main.length > 10 ? t.m * 0.8 : t.m;
  const tier = (text, fs, ls) => (text ? `<span style="font-size:${px(fs * s)};letter-spacing:${ls};white-space:nowrap">${escHtml(text)}</span>` : "");
  const style = `width:${px(w * s)};height:${px(h * s)};margin:${px(m * s)} 0;${border(s, c)};color:${c};display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:${px(t.gap * s)};`
    + `transform:rotate(${tilt ? summary.rotation ?? 0 : 0}deg);font-family:var(--mono,'Courier New',Courier,monospace);font-weight:700;line-height:1.15;text-align:center;box-sizing:border-box;flex-shrink:0;padding:0`;
  return `<span class="stp${cls ? ` ${cls}` : ""}" role="img" aria-label="${escHtml(summary.ariaLabel ?? `Stamp: ${summary.name ?? k.name}`)}" style="${style}">`
    + tier(eyebrow, t.e, ".14em") + tier(main, mainSize, t.ml) + tier(detail, t.d, ".12em") + `</span>`;
}

/** A blank spot: the dashed outline of a stamp not earned yet, a serif "?" inside. */
export function blankMarkup(type, { size = 1 } = {}) {
  const k = CATALOG[type] ?? CATALOG.first;
  const [w, h, m] = SHAPES[k.shape];
  const round = k.shape === "round" || k.shape === "ring" || k.shape === "oval";
  return `<span class="stp-blank" role="img" aria-label="Blank spot, not earned yet" style="width:${px(w * size)};height:${px(h * size)};margin:${px(m * size)} 0;border-radius:${round ? "50%" : "4px"};`
    + `border:1.5px dashed color-mix(in srgb,var(--muted,#78705f) 40%,var(--hair,#d4c9b5));color:var(--muted,#78705f);display:grid;place-items:center;font:italic 400 34px/1 var(--serif,'Instrument Serif',Georgia,serif);box-sizing:border-box">?</span>`;
}

// ---------------------------------------------------------------- the suite key (a job) and the anniversary
// The suite key (handoff "Kept outside the book", board S2): a call, the research, an online purchase and
// one more errand, all finished within two hours of the first step's start. Those steps are logged as
// one job, with its start time, in `stamp_jobs`; the key's ref is that job. One errand never counts twice:
// a task a call or a research run belongs to is the same errand as that call or run.
export const SUITE_WINDOW_MS = 2 * 60 * 60_000;
db.db.exec(`
  CREATE TABLE IF NOT EXISTS stamp_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'suite',
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    steps_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, kind, started_at)
  );
  CREATE TABLE IF NOT EXISTS stamp_step_times (
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    PRIMARY KEY (kind, ref_id)
  );
`);

/** Every finished errand with when it started and when it finished: `{ kind, id, start, end }`. */
function steps(conversationId) {
  const out = [], tied = new Set();
  for (const c of ALL("SELECT id, task_id, outcome_kind, created_at, COALESCE(ended_at, updated_at) AS e FROM calls WHERE conversation_id = ? AND outcome_kind <> ''", conversationId)) {
    if (!isSuccess(c.outcome_kind)) continue;
    out.push({ kind: "call", id: c.id, start: c.created_at, end: c.e });
    if (c.task_id != null) tied.add(c.task_id);
  }
  try {
    for (const r of ALL("SELECT id, task_id, created_at, finished_at FROM research WHERE conversation_id = ? AND state = 'done' AND finished_at IS NOT NULL", conversationId)) {
      out.push({ kind: "research", id: r.id, start: r.created_at, end: r.finished_at });
      if (r.task_id != null) tied.add(r.task_id);
    }
  } catch { /* no research table on an old install */ }
  const placed = new Map(ALL("SELECT ref_id, finished_at FROM stamp_step_times WHERE conversation_id = ? AND kind = 'purchase'", conversationId).map(x => [x.ref_id, x.finished_at]));
  for (const p of purchasesDone(conversationId)) out.push({ kind: "purchase", id: p.id, start: p.created_at, end: placed.get(p.id) ?? p.updated_at });
  for (const t of ALL("SELECT id, created_at, finished_at FROM tasks WHERE conversation_id = ? AND state = 'done' AND finished_at IS NOT NULL", conversationId)) {
    if (!tied.has(t.id)) out.push({ kind: "task", id: t.id, start: t.created_at, end: t.finished_at });
  }
  return out.filter(x => Number.isFinite(x.start) && Number.isFinite(x.end)).sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The steps from `first` on that make a suite: one call, one research, one purchase, one more; null when they don't. */
function suiteFrom(all, first) {
  const inside = all.filter(x => x.start >= first.start && x.end <= first.start + SUITE_WINDOW_MS);
  const pick = (k) => inside.find(x => x.kind === k);
  const call = pick("call"), research = pick("research"), purchase = pick("purchase");
  if (!call || !research || !purchase) return null;
  const more = inside.find(x => x !== call && x !== research && x !== purchase);
  if (!more) return null;
  const four = [call, research, purchase, more].sort((a, b) => a.start - b.start);
  return { startedAt: four[0].start, finishedAt: Math.max(...four.map(x => x.end)), steps: four };
}

/**
 * The suite key, if the errands on record now make one: the job is logged (once per start) and the key
 * is the candidate. `all`: look at every window (backfill), not only ones that end with the newest step.
 */
export function suiteCandidates(conversationId, { all = false, dryRun = false } = {}) {
  let list = steps(conversationId);
  if (list.length < 4) return [];
  const newestEnd = Math.max(...list.map(x => x.end));
  // Live, only the steps that could share a window with the one that just finished.
  if (!all) list = list.filter(x => x.end >= newestEnd - SUITE_WINDOW_MS);
  // A step already in a logged job is never part of another.
  const used = new Set();
  for (const j of ALL("SELECT steps_json FROM stamp_jobs WHERE conversation_id = ? AND kind = 'suite'", conversationId)) {
    for (const x of parse(j.steps_json, [])) used.add(`${x.kind}:${x.id}`);
  }
  list = list.filter(x => !used.has(`${x.kind}:${x.id}`));
  const out = [];
  for (const first of list) {
    const job = suiteFrom(list, first);
    if (!job || job.steps.some(x => used.has(`${x.kind}:${x.id}`))) continue;
    if (!all && job.finishedAt !== newestEnd) continue;
    job.steps.forEach(x => used.add(`${x.kind}:${x.id}`));
    let jobId = ONE("SELECT id FROM stamp_jobs WHERE conversation_id = ? AND kind = 'suite' AND started_at = ?", conversationId, job.startedAt)?.id ?? null;
    if (jobId == null && !dryRun) {
      jobId = Number(db.db.prepare("INSERT OR IGNORE INTO stamp_jobs (conversation_id, kind, started_at, finished_at, steps_json, created_at) VALUES (?, 'suite', ?, ?, ?, ?)")
        .run(conversationId, job.startedAt, job.finishedAt, JSON.stringify(job.steps.map(({ kind, id, start, end }) => ({ kind, id, start, end }))), clock.now()).lastInsertRowid) || null;
    }
    out.push({ type: "suite_key", ref: `job:${jobId ?? job.startedAt}`, at: job.finishedAt, detail: { startedAt: job.startedAt, minutes: Math.round((job.finishedAt - job.startedAt) / 60_000), steps: job.steps.length } });
  }
  return out;
}

/** The anniversary ticket: a year after the account began. Its serial is the place among everyone who reached a year (the order accounts began). */
export function anniversaryCandidates(conversationId, { now = clock.now() } = {}) {
  const acct = db.getAccount(conversationId);
  if (!acct?.created_at) return [];
  const at = acct.created_at + 365 * 86_400_000;
  if (at > now) return [];
  if (ONE("SELECT 1 AS x FROM stamps WHERE conversation_id = ? AND type = 'anniversary'", conversationId)) return [];
  // Everyone who began before them reached a year before them: their place is their place in line.
  const before = ONE("SELECT COUNT(*) AS n FROM accounts WHERE created_at < ? OR (created_at = ? AND conversation_id < ?)", acct.created_at, acct.created_at, conversationId)?.n ?? 0;
  return [{ type: "anniversary", ref: "anniversary", at, detail: { serial: before + 1, from: acct.created_at } }];
}

/** Award the anniversary if a year has passed (the book and Home ask; nothing else marks a date). */
export function checkAnniversary(conversationId) {
  if (!waxLook()) return [];
  try { return awardLive(conversationId, anniversaryCandidates(conversationId)); } catch { return []; }
}

// ---------------------------------------------------------------- the wax book (REASON_STAMPS_WAX)
// Every kind of seal: its wax (the kind of errand), its name, the ring text, the line a stranger may see.
// Stored types stay as they were (the typed look still draws the same rows); this is how each reads in wax.
// Numbers are spelled out, the ring ends " ·", and nothing here may name a place, a price or a person
// unless it is the owner's own (`ring`, `story`, `line`); `pub*` are what leaves the book.
const W = (n) => words(n);
const U = (s) => String(s).toUpperCase();
/** Kept outside the book: not a seal, never on a page. */
export const OUTSIDE = ["first", "anniversary", "suite_key"];
export const SEALS = {
  long_hold: {
    wax: "oxblood", name: "Held on your behalf", hint: "a long hold, sat through for you",
    ring: d => Number.isFinite(d.minutes) ? `HELD ON YOUR BEHALF · ${U(W(d.minutes))} MINUTES ·` : "HELD ON YOUR BEHALF · ON YOUR BEHALF ·",
    aria: d => Number.isFinite(d.minutes) ? `${W(d.minutes)} minutes` : "",
    who: d => Number.isFinite(d.minutes) ? `held for ${W(d.minutes)} minutes` : "held the line",
  },
  night_shift: {
    wax: "green", name: "Attended to overnight", hint: "something finished while you slept",
    ring: () => "ATTENDED TO OVERNIGHT · WHILE YOU SLEPT ·", aria: () => "while you slept",
    who: () => "attended to it overnight",
  },
  price_drop: {
    wax: "oxblood", name: "A better rate, secured", hint: "a watched price that fell",
    ring: d => d.savedCents >= 100 ? `A BETTER RATE, SECURED · ${U(W(Math.round(d.savedCents / 100)))} DOLLARS ·` : "A BETTER RATE, SECURED · ON YOUR BEHALF ·",
    pubRing: () => "A BETTER RATE, SECURED · ON YOUR BEHALF ·",
    aria: d => d.savedCents >= 100 ? `${W(Math.round(d.savedCents / 100))} dollars` : "", pubAria: () => "",
    who: () => "secured a better rate",
  },
  human: {
    wax: "black", name: "Spoke to the manager", hint: "a phone menu, beaten to a person",
    ring: () => "SPOKE TO THE MANAGER · ON YOUR BEHALF ·", aria: () => "",
    who: () => "spoke to the manager",
  },
  early: {
    wax: "green", name: "Well ahead of the occasion", hint: "a booking made a week ahead",
    ring: d => Number.isFinite(d.days) ? `WELL AHEAD OF THE OCCASION · ${U(W(d.days))} DAYS ·` : "WELL AHEAD OF THE OCCASION ·",
    aria: d => Number.isFinite(d.days) ? `${W(d.days)} days ahead` : "",
    who: d => Number.isFinite(d.days) ? `saw to it ${W(d.days)} days ahead` : "saw to it well ahead",
  },
  abroad: {
    wax: "navy", name: "Arrangements abroad", hint: "arrangements in another country",
    ring: d => Number.isFinite(d.nights) ? `ARRANGEMENTS ABROAD · ${U(W(d.nights))} NIGHTS ·` : "ARRANGEMENTS ABROAD · ON YOUR BEHALF ·",
    aria: d => Number.isFinite(d.nights) ? `${W(d.nights)} nights` : "",
    who: d => Number.isFinite(d.nights) ? `made arrangements abroad for ${W(d.nights)} nights` : "made arrangements abroad",
  },
  whole_trip: {
    wax: "navy", name: "A whole trip", hint: "a whole trip, start to finish",
    ring: () => "A WHOLE TRIP · START TO FINISH ·", aria: () => "start to finish",
    who: () => "arranged a whole trip, start to finish,",
  },
  three_in_one: {
    wax: "black", name: "Three in one", hint: "three errands in one text",
    ring: () => "THREE IN ONE · A SINGLE TEXT ·",
    aria: d => `${W(Number.isFinite(d.count) ? d.count : 3)} errands from a single text`,
    who: d => `handled ${W(Number.isFinite(d.count) ? d.count : 3)} errands from a single text`,
  },
  // Everyday (REASON_STAMPS_EVERYDAY).
  rang: {
    wax: "black", name: "Rang on your behalf", hint: "a call that got what it was for",
    ring: () => "RANG ON YOUR BEHALF · A CALL SEEN THROUGH ·", aria: () => "a call seen through",
    who: () => "made a call",
  },
  looked_into: {
    wax: "green", name: "Looked into, thoroughly", hint: "a question, researched properly",
    ring: () => "LOOKED INTO, THOROUGHLY · ON YOUR BEHALF ·", aria: () => "",
    who: () => "looked into a question thoroughly",
  },
  orders: {
    wax: "oxblood", name: "First order", hint: "an order placed and paid on your behalf",
    ring: () => "FIRST ORDER · PLACED ON YOUR BEHALF ·", aria: () => "an order placed",
    who: () => "placed an order",
  },
  // Outside the book. `first` shared under the typed look keeps a page: it reads in the patch's green.
  first: { wax: "green", name: "The first errand", hint: "the first thing I finish for you", ring: () => "THE FIRST ERRAND · ON YOUR BEHALF ·", aria: () => "", who: () => "ran a first errand" },
  anniversary: { wax: "green", name: "A year of things handled", hint: "a year together", ring: () => "A YEAR OF THINGS HANDLED ·", aria: () => "", who: () => "handled a year of things" },
  suite_key: { wax: "black", name: "The suite key", hint: "a call, research, a purchase and one more, inside two hours", ring: () => "THE SUITE KEY ·", aria: () => "", who: () => "saw four errands through inside two hours" },
};
/** The order not-yet spots offer their hints in: the most within reach first. */
export const SEAL_HINT_ORDER = ["three_in_one", "night_shift", "whole_trip", "long_hold", "human", "early", "price_drop", "abroad"];
/** The hint order the book uses now: with everyday seals on, those come first (they're the nearest). */
export function sealHintOrder() {
  return everydaySeals() ? ["rang", "looked_into", "orders", ...SEAL_HINT_ORDER] : SEAL_HINT_ORDER;
}

const sealAria = (type, d, pub = false) => {
  const k = SEALS[type];
  const extra = (pub && k.pubAria ? k.pubAria(d) : k.aria(d)) || "";
  return `${WAX[k.wax].label} seal: ${k.name.toLowerCase()}${extra ? `, ${extra}` : ""}`;
};
const sentenceCase = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

/** "Today", "Yesterday", or "On Monday, the twenty-sixth of October": how the story begins. */
function whenSaid(at, tz, now = clock.now()) {
  const day = (ms) => dayIn(ms, tz);
  if (day(at) === day(now)) return "Today";
  if (day(at) === day(now - 86_400_000)) return "Yesterday";
  return `On ${fullDate(at, tz)},`;
}

/** Two or three sentences in Reason's voice, ending "It was no trouble." The owner's own book only. */
function waxStory(type, d, at, tz) {
  const when = whenSaid(at, tz);
  const place = d.place ? String(d.place) : "";
  switch (type) {
    case "long_hold": return `${when} I held for ${Number.isFinite(d.minutes) ? `${W(d.minutes)} minutes` : "a long while"}${place ? ` with ${place}` : ""} on your behalf. When someone picked up, I took it from there. It was no trouble.`;
    case "human": return `${place ? `${place}'s line` : "The line"} began with a phone menu. I worked my way through it and spoke to a person on your behalf. It was no trouble.`;
    case "night_shift": return `I finished this at ${clockTime(d.time ?? at, tz).toLowerCase()}, while you slept. It was done before your morning began. It was no trouble.`;
    case "price_drop": return `I kept an eye on the price, and it fell by ${W(Math.round((d.savedCents ?? 0) / 100))} dollars. I bought it at the lower one. It was no trouble.`;
    case "early": return `I had this booked ${Number.isFinite(d.days) ? `${W(d.days)} days` : "well"} ahead, before it could become a rush. It was no trouble.`;
    case "three_in_one": return `One text, ${W(d.count ?? 3)} errands. I saw each of them through. It was no trouble.`;
    case "rang": return `${when} I made the call${place ? ` to ${place}` : ""} on your behalf, and it got what it was for. It was no trouble.`;
    case "looked_into": return `${when} I looked into it properly for you and brought back what I found. It was no trouble.`;
    case "orders": return `${when} I placed your first order${place ? ` at ${place}` : ""} and paid it on your behalf, and the store confirmed it. It was no trouble.`;
    case "first": return "The first thing you asked of me, done. This is where the book begins. It was no trouble.";
    case "anniversary": return "A year of things handled. It was no trouble.";
    case "suite_key": return `A call, the research, a purchase online and one more besides, all inside ${W(d.minutes ?? 120)} minutes. It was no trouble.`;
    default: return "It was no trouble.";
  }
}

/** The story of an everyday seal earned more than once: the latest, and how many now. */
function tierStory(type, d, n, at, tz) {
  const when = whenSaid(at, tz);
  const place = d.place ? String(d.place) : "";
  if (type === "rang") return `${when} I made another call${place ? ` to ${place}` : ""} on your behalf, and it got what it was for. That makes ${W(n)}. It was no trouble.`;
  if (type === "looked_into") return `${when} I looked into another question for you. That makes ${W(n)}, each one done properly. It was no trouble.`;
  if (type === "orders") return `${when} I placed another order${place ? ` at ${place}` : ""} on your behalf, paid and confirmed. That makes ${W(n)}. It was no trouble.`;
  return waxStory(type, d, at, tz);
}

/** Home's one line under the name ("Fifty-two minutes with [airline]. It was no trouble."). */
function waxLine(type, d) {
  const place = d.place ? String(d.place) : "";
  switch (type) {
    case "long_hold": return `${sentenceCase(Number.isFinite(d.minutes) ? `${W(d.minutes)} minutes` : "A long hold")}${place ? ` with ${place}` : ""}. It was no trouble.`;
    case "human": return `A person on the line${place ? ` at ${place}` : ""}. It was no trouble.`;
    case "night_shift": return "Done while you slept. It was no trouble.";
    case "price_drop": return d.savedCents >= 100 ? `${sentenceCase(W(Math.round(d.savedCents / 100)))} dollars less than it was. It was no trouble.` : "A lower price than it was. It was no trouble.";
    case "early": return Number.isFinite(d.days) ? `${sentenceCase(W(d.days))} days ahead. It was no trouble.` : "Well ahead. It was no trouble.";
    case "three_in_one": return `${sentenceCase(W(d.count ?? 3))} errands from a single text. It was no trouble.`;
    case "rang": return `A call${place ? ` to ${place}` : ""}, seen through. It was no trouble.`;
    case "looked_into": return "A question, looked into properly. It was no trouble.";
    case "orders": return `An order${place ? ` at ${place}` : ""}, placed and paid. It was no trouble.`;
    default: return "It was no trouble.";
  }
}

/** One row → the wax book's summary (also everything the typed look's StampSummary had). */
function waxSummary(row) {
  const k = SEALS[row.type];
  if (!k) return null;
  const d = parse(row.detail_json, {});
  const tz = tzFor(row.conversation_id);
  let messageId = row.message_id ?? null;
  if (messageId == null) {
    messageId = messageNear(row.conversation_id, row.earned_at);
    if (messageId != null) { try { db.db.prepare("UPDATE stamps SET message_id = ? WHERE id = ?").run(messageId, row.id); } catch { /* read-only is fine */ } }
  }
  return {
    id: row.id, type: row.type, name: k.name, wax: k.wax,
    ring: k.ring(d), postmarkDate: postmarkDate(row.earned_at, tz),
    detail: "", story: waxStory(row.type, d, row.earned_at, tz), line: waxLine(row.type, d),
    earnedAt: row.earned_at, rotation: row.rotation, ariaLabel: sealAria(row.type, d),
    outside: OUTSIDE.includes(row.type), values: d,
    date: monthDay(row.earned_at, tz),
    href: messageId != null ? `/web?at=${messageId}` : "/web?thread",
  };
}

/**
 * A seal as a stranger may see it: its wax, its name, the public ring and label, the duration or count,
 * the date in full, and — only when the owner leaves it on — the first name. Nothing else.
 */
export function publicSeal(row, first = "") {
  const k = SEALS[row.type] ?? SEALS.first;
  const d = typeof row.detail_json === "string" ? parse(row.detail_json, {}) : (row.values ?? {});
  const tz = tzFor(row.conversation_id);
  const whose = first ? `${first}'s` : "my";
  const did = k.who(d);
  return {
    type: row.type, wax: k.wax, name: k.name, rotation: row.rotation ?? 0,
    ring: (k.pubRing ?? k.ring)(d),
    postmarkDate: postmarkDate(row.earned_at, tz),
    ariaLabel: sealAria(row.type, d, true),
    who: `who ${did} on ${whose} behalf`,
    whoWith: (name) => `who ${did} on ${name ? `${name}'s` : "my"} behalf`,
    said: `Reason ${did} on ${whose} behalf.`,
    story: `My concierge ${did.replace(/,$/, "")} so I didn't have to.`,
    when: U(fullDate(row.earned_at, tz)),
  };
}
