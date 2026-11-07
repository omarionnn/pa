// The daily spending limit, per person (2026-10-31, the owner's decision at 16:35 ET).
//
// Until now the day's cap was one number for the whole install — REASON_MAX_SPEND_PER_DAY, the
// operator's safety net in src/config.js, checked by src/trust.js checkSpendCap before any payment. It
// still is the DEFAULT: the live .env sets it to $100 a day. What is new is that each person can set
// their own number, and theirs wins:
//
//   - `daily_caps` is one row per conversation: the person's own daily limit in cents, the words they
//     set it with, and when. No row means the default.
//   - Lowering is immediate, and so is any change that stays at or under the default: a smaller number
//     can only protect them.
//   - Raising ABOVE the default is a money control, so it is confirmed first. With a passkey on file it
//     is approved with Face ID on the same kind of link a payment uses (src/passkey.js, kind 'cap');
//     without one it is a plain yes to a question that expires like any other ask about money
//     (config.askTtlMoneyH). Either way the change waits in `cap_changes` until then.
//   - The most anyone can set for themselves is SELF_MAX_CENTS ($1,000 a day). Above that only the
//     operator can go, by raising the default in .env — never a row here.
//
// The amounts counted against the cap are the `spend` table's (src/trust.js noteSpend), the same for
// every way of paying. This module never talks to a model or a store: it keeps the number and says
// what it is.
import * as db from "./db.js";
import { config, clock } from "./config.js";
import * as passkey from "./passkey.js";

/** The most a person can set for themselves, a day. Above this is the operator's call (.env). */
export const SELF_MAX_CENTS = 100_000;
/** How long a raise waits for its yes, like every other ask about money. */
export const changeTtlMs = () => Math.round((config.askTtlMoneyH || 24) * 3600_000);

db.db.exec(`
  CREATE TABLE IF NOT EXISTS daily_caps (
    conversation_id TEXT PRIMARY KEY,
    cents INTEGER NOT NULL,
    said TEXT NOT NULL DEFAULT '',
    set_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cap_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    from_cents INTEGER NOT NULL,
    to_cents INTEGER NOT NULL,
    said TEXT NOT NULL DEFAULT '',
    via TEXT NOT NULL DEFAULT 'text',
    status TEXT NOT NULL DEFAULT 'asked',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS cap_changes_open ON cap_changes (conversation_id, status);
`);
// How many of their own messages there were when a raise was asked about by text: a yes has to be a
// message of theirs that came AFTER it (src/shoptools.js spend_limit_confirm), the same rule as the gate.
try { db.db.exec("ALTER TABLE cap_changes ADD COLUMN asked_after_msgs INTEGER"); } catch { /* there already */ }
const q = (sql) => db.db.prepare(sql);

/** "$100", "$1,000", "$82.50": whole when whole, thousands marked, as a person writes money. */
export const money = (cents) => `$${(Math.round(cents) / 100).toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const dollars = (cents) => (Math.round(cents) / 100).toFixed(2);

/** The install's default, in cents: REASON_MAX_SPEND_PER_DAY. 0 means no cap at all. */
export const defaultCents = () => Math.round((config.maxSpendPerDay || 0) * 100);

/** The person's own row, or null when they have never set one. */
export const ownCap = (conversationId) => q("SELECT * FROM daily_caps WHERE conversation_id = ?").get(conversationId) ?? null;

/** The number that holds for this person today: theirs if they set one, else the default. */
export function capFor(conversationId) {
  const own = ownCap(conversationId);
  return { cents: own ? own.cents : defaultCents(), own: !!own, default_cents: defaultCents(), ceiling_cents: SELF_MAX_CENTS, ...(own ? { set_at: own.set_at, said: own.said } : {}) };
}

/** The day a cap is counted against, in the install's timezone (the same as src/trust.js spendDay). */
export const spendDay = (nowMs = clock.now()) => new Date(nowMs).toLocaleDateString("en-CA", { timeZone: config.installTz });

/** Today's real figures for one person: spent, cap, left — the record, never a guess. */
export function view(conversationId) {
  const cap = capFor(conversationId);
  const used = db.spentToday(conversationId, spendDay());
  const left = cap.cents ? Math.max(0, cap.cents - used.cents) : null;
  const open = openChange(conversationId);
  return {
    day: spendDay(), spent_cents: used.cents, spent: money(used.cents), commits_today: used.count,
    cap_cents: cap.cents, cap: cap.cents ? money(cap.cents) : "no cap",
    left_cents: left, left: left == null ? null : money(left),
    own: cap.own, default_cents: cap.default_cents, default: money(cap.default_cents),
    ceiling_cents: SELF_MAX_CENTS, ceiling: money(SELF_MAX_CENTS),
    ...(open ? { pending: { id: open.id, to: money(open.to_cents), to_cents: open.to_cents, via: open.via, needs: passkey.requiredFor(conversationId) ? "face_id" : "yes", expires_at: open.expires_at } } : {}),
  };
}

/** Where they change it, said the same way everywhere. Never a phrase to type. */
export const HOW_TO_CHANGE = "You can raise it in Settings → Shopping, or tell me a new limit.";

/**
 * The sentence for a payment that does not fit, in the person's terms: the limit, where it would take
 * them, and how to change it. `spent` and `amount` in cents.
 */
export function overCapLine(conversationId, { spent, amount }) {
  const cap = capFor(conversationId);
  return `Your daily limit is ${money(cap.cents)} and this would take you to ${money(spent + amount)}. ${HOW_TO_CHANGE}`;
}

// ---------------------------------------------------------------- changing it

function write(conversationId, cents, said = "") {
  q(`INSERT INTO daily_caps (conversation_id, cents, said, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET cents = excluded.cents, said = excluded.said, set_at = excluded.set_at`)
    .run(conversationId, Math.round(cents), String(said ?? "").slice(0, 300), clock.now());
}

/** Dollars from the person (a number, or "250", "$1,000", "1000.50") → whole cents, or null. */
export function toCents(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  const s = String(v ?? "").trim().replace(/^\$/, "").replace(/,/g, "").replace(/\s*(a|per)?\s*day$/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

/** The raise still waiting for its yes, if there is one and it has not run out. */
export function openChange(conversationId) {
  const row = q("SELECT * FROM cap_changes WHERE conversation_id = ? AND status = 'asked' ORDER BY id DESC LIMIT 1").get(conversationId) ?? null;
  if (row && row.expires_at < clock.now()) { q("UPDATE cap_changes SET status = 'expired', ended_at = ? WHERE id = ? AND status = 'asked'").run(clock.now(), row.id); return null; }
  return row;
}
export const changeRow = (id) => q("SELECT * FROM cap_changes WHERE id = ?").get(Number(id)) ?? null;

/**
 * Ask for a new daily limit. Applied at once when it lowers the number or stays at or under the default;
 * refused above the ceiling; otherwise parked as an open change and the caller is told what it needs —
 * `face_id` with a link, or `yes` to a question. Any older open change is replaced.
 */
export function requestChange(conversationId, cents, { said = "", via = "text", askedAfterMsgs = null } = {}) {
  const now = capFor(conversationId);
  if (!Number.isInteger(cents) || cents <= 0) return { ok: false, error: "bad_amount", cap: money(now.cents) };
  if (cents > SELF_MAX_CENTS) return { ok: false, error: "over_ceiling", ceiling: money(SELF_MAX_CENTS), ceiling_cents: SELF_MAX_CENTS, cap: money(now.cents) };
  // No cap at all (0) is the loosest there is: any number is a lowering. Otherwise at or under what
  // holds now, or at or under the default, is applied at once.
  if (!now.cents || !now.default_cents || cents <= now.cents || cents <= now.default_cents) {
    q("UPDATE cap_changes SET status = 'replaced', ended_at = ? WHERE conversation_id = ? AND status = 'asked'").run(clock.now(), conversationId);
    write(conversationId, cents, said);
    return { ok: true, applied: true, from: money(now.cents), to: money(cents), from_cents: now.cents, to_cents: cents, lowered: cents < now.cents };
  }
  q("UPDATE cap_changes SET status = 'replaced', ended_at = ? WHERE conversation_id = ? AND status = 'asked'").run(clock.now(), conversationId);
  const r = q("INSERT INTO cap_changes (conversation_id, from_cents, to_cents, said, via, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'asked', ?, ?)")
    .run(conversationId, now.cents, cents, String(said ?? "").slice(0, 300), via, clock.now(), clock.now() + changeTtlMs());
  const id = Number(r.lastInsertRowid);
  if (askedAfterMsgs != null) q("UPDATE cap_changes SET asked_after_msgs = ? WHERE id = ?").run(Number(askedAfterMsgs), id);
  const base = { ok: false, pending: true, change_id: id, from: money(now.cents), to: money(cents), from_cents: now.cents, to_cents: cents, expires_at: clock.now() + changeTtlMs() };
  if (passkey.requiredFor(conversationId)) {
    const token = passkey.createApproval(approvalRow(id));
    return { ...base, needs: "face_id", url: `${siteBase()}/web/approve/${token}`, token };
  }
  return { ...base, needs: "yes" };
}

/** Their yes, for an open change of theirs: applied, or why not (expired, not open, not theirs). */
export function confirmChange(conversationId, id, { via = "text" } = {}) {
  const row = changeRow(id);
  if (!row || row.conversation_id !== conversationId) return { ok: false, error: "no_such_change" };
  if (row.status !== "asked") return { ok: false, error: `change_${row.status}`, cap: money(capFor(conversationId).cents) };
  if (row.expires_at < clock.now()) {
    q("UPDATE cap_changes SET status = 'expired', ended_at = ? WHERE id = ? AND status = 'asked'").run(clock.now(), row.id);
    return { ok: false, error: "change_expired", cap: money(capFor(conversationId).cents) };
  }
  if (row.to_cents > SELF_MAX_CENTS) return { ok: false, error: "over_ceiling", ceiling: money(SELF_MAX_CENTS) };
  // A passkey on file makes a raise a Face ID matter in code, not only in the prompt: a texted yes or the
  // Settings button cannot apply it. They get a fresh link instead (any older open link is replaced).
  if (via !== "face_id" && passkey.requiredFor(conversationId)) {
    const token = passkey.createApproval(approvalRow(row.id));
    return { ok: false, error: "needs_face_id", needs: "face_id", change_id: row.id, from: money(row.from_cents), to: money(row.to_cents), url: `${siteBase()}/web/approve/${token}`, token, cap: money(capFor(conversationId).cents) };
  }
  if (q("UPDATE cap_changes SET status = 'applied', ended_at = ?, via = ? WHERE id = ? AND status = 'asked'").run(clock.now(), via, row.id).changes !== 1) return { ok: false, error: "change_closed" };
  write(conversationId, row.to_cents, row.said);
  return { ok: true, applied: true, from: money(row.from_cents), to: money(row.to_cents), from_cents: row.from_cents, to_cents: row.to_cents };
}

/** A no, or a change of mind: the number stays as it was. */
export function declineChange(conversationId, id) {
  const row = changeRow(id);
  if (!row || row.conversation_id !== conversationId || row.status !== "asked") return { ok: false, error: "not_open" };
  q("UPDATE cap_changes SET status = 'declined', ended_at = ? WHERE id = ? AND status = 'asked'").run(clock.now(), row.id);
  return { ok: true, cap: money(capFor(conversationId).cents) };
}

// ---------------------------------------------------------------- the Face ID link
//
// A raise rides the same approval link a payment does (src/passkey.js pay_approvals, kind 'cap'): the
// challenge is bound to THIS change — its id, whose it is, and the number — so a tap approves exactly
// the raise that was asked for and nothing else. The row below is the shape passkey.js reads.

const siteBase = () => (process.env.REASON_SITE_URL || process.env.REASON_PUBLIC_URL || "https://heyreason.com").replace(/\/+$/, "");

/** The change as src/passkey.js and src/shopconnect.js approvalView read a row: kind 'cap'. */
export function approvalRow(id) {
  const row = changeRow(id);
  if (!row) return null;
  const expired = row.status === "asked" && row.expires_at < clock.now();
  return {
    kind: "cap", id: row.id, conversation_id: row.conversation_id,
    status: expired ? "expired" : row.status, amount_kind: "exact", amount: dollars(row.to_cents), currency: "USD",
    from_cents: row.from_cents, to_cents: row.to_cents, from: money(row.from_cents), to: money(row.to_cents),
    merchant_name: "Daily spending limit", merchant_url: "", merchant_country: "", item: `from ${money(row.from_cents)} a day`,
    run_id: "", request_id: `cap_${row.id}`, expires_at: new Date(row.expires_at).toISOString(),
  };
}

/** The one line texted when it is done or left alone (no model turn runs on the page). */
export const appliedLine = (out) => `Done. Your daily spending limit is ${out.to} a day${out.from !== out.to ? ` (it was ${out.from})` : ""}.`;
export const keptLine = (cap) => `Left as it was: your daily spending limit stays ${cap}.`;
