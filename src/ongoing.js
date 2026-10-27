// What Reason is holding for one person, as Reason Web's Ongoing shows it (owner's design handoff,
// 2026-10-26, HANDOFF.md "3 · Ongoing", sheets 2 and 3). Read off the rows that ARE the work — never
// a summary the model wrote for the page:
//
//   NEEDS YOU    approvals Reason asked for and has no answer to (confirmations), and tasks that are
//                waiting on one answer from them (waiting_on_you + sheet.needs)
//   IN HAND      tasks being worked (their real steps: sheet.steps, else the progress log and what is
//                left), tasks waiting on somebody (sheet.waiting: who, for what, since), stuck ones
//                (sheet.blocked), one-off reminders and calls (timers), standing ones (series)
//   BACK TO YOU  tasks closed in the last few days: done (READY, the result task_finish handed back)
//                and failed (DIDN'T WORK, why in Reason's words and what happens next)
//
// Every read is scoped to the one conversation it is asked for, so an id from somebody else's list
// finds nothing. Nothing here writes, except the one background title a row with none is owed
// (src/itemtitle.js), the same as the margin has always done.
import * as db from "./db.js";
import { clock, config } from "./config.js";
import { parseRule } from "./series.js";
import { cleanTitle, queueTitle } from "./itemtitle.js";

/** How long a closed task stays under BACK TO YOU. */
export const BACK_WINDOW_MS = 72 * 60 * 60_000;
/** How long an unanswered approval counts as one that needs them (the same day as the chat's card). */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------- clocks and words
const fmt = (tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, ...o });
/** "9:00" — the reference's time, no period (the period goes beside it, typed). */
export const clockOf = (ms, tz) => fmt(tz, { hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(ms)
  .filter(p => p.type === "hour" || p.type === "minute" || p.type === "literal").map(p => p.value).join("").replace(/\s+$/, "").replace(/^\s+/, "");
export const periodOf = (ms, tz) => (fmt(tz, { hour: "numeric", hour12: true }).formatToParts(ms).find(p => p.type === "dayPeriod")?.value ?? "").toUpperCase();
/** "MON NOV 2" */
export const dayShort = (ms, tz) => fmt(tz, { weekday: "short", month: "short", day: "numeric" }).format(ms).replace(/,/g, "").toUpperCase();
/** "TUE · 2:40 PM" */
export const dayTime = (ms, tz) => `${fmt(tz, { weekday: "short" }).format(ms).toUpperCase()} · ${fmt(tz, { hour: "numeric", minute: "2-digit" }).format(ms).toUpperCase()}`;
/** "Tuesday, 2:40 PM" for a sentence. */
const daySentence = (ms, tz) => `${fmt(tz, { weekday: "long" }).format(ms)}, ${fmt(tz, { hour: "numeric", minute: "2-digit" }).format(ms)}`;
/**
 * When something happened, as a row's typed meta line says it (handoff v2, sheet 2B): "2:55 PM" today,
 * "YESTERDAY", the weekday within the week ("TUE"), else the date ("NOV 1").
 */
export function whenWord(ms, now = clock.now(), tz = config.tz) {
  if (!Number.isFinite(ms)) return null;
  const day = (x) => fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  if (day(ms) === day(now)) return fmt(tz, { hour: "numeric", minute: "2-digit" }).format(ms).toUpperCase();
  if (day(ms) === day(now - 24 * 60 * 60_000)) return "YESTERDAY";
  if (ms < now && now - ms < 6 * 24 * 60 * 60_000) return fmt(tz, { weekday: "short" }).format(ms).toUpperCase();
  return fmt(tz, { month: "short", day: "numeric" }).format(ms).toUpperCase();
}
/**
 * When a scheduled row next goes off, for a row's right side (sheet 2A/2B/2C): within the week the
 * weekday and time in serif ("Mon 9:00") or typed in the margin ("MON"); further out the date ("Nov 1" / "NOV 1").
 */
export function nextWords(ms, tz = config.tz, now = clock.now()) {
  if (!Number.isFinite(ms)) return { serif: null, typed: null };
  if (ms - now < 6 * 24 * 60 * 60_000) {
    const wd = fmt(tz, { weekday: "short" }).format(ms);
    return { serif: `${wd} ${clockOf(ms, tz)}`, typed: wd.toUpperCase() };
  }
  const d = fmt(tz, { month: "short", day: "numeric" }).format(ms);
  return { serif: d, typed: d.toUpperCase() };
}
const money = (cents) => `$${(Math.round(cents) / 100).toFixed(2).replace(/\.00$/, "")}`;

const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
/** A standing schedule as the reference types it: `short` "EVERY MON" for a row, `long` "EVERY MONDAY" for the detail. */
export function everyWords(rule) {
  if (!rule) return { short: "", long: "" };
  switch (rule.kind) {
    case "daily": return { short: "EVERY DAY", long: "EVERY DAY" };
    case "weekdays": return { short: "WEEKDAYS", long: "EVERY WEEKDAY" };
    case "weekly": {
      const d = rule.weekdays ?? [];
      if (d.length === 7) return { short: "EVERY DAY", long: "EVERY DAY" };
      const long = d.map(i => DAYS[i]);
      return {
        short: `EVERY ${d.map(i => DAYS[i].slice(0, 3)).join(" · ")}`,
        long: `EVERY ${long.length <= 1 ? long[0] ?? "" : `${long.slice(0, -1).join(", ")} AND ${long.at(-1)}`}`,
      };
    }
    case "monthly": {
      const n = rule.day_of_month;
      const th = ["TH", "ST", "ND", "RD"][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10];
      return { short: "MONTHLY", long: `EVERY MONTH · THE ${n}${th}` };
    }
    case "every_n_days":
      if (rule.n === 1) return { short: "EVERY DAY", long: "EVERY DAY" };
      if (rule.n === 7) return { short: "EVERY WEEK", long: "EVERY WEEK" };
      if (rule.n % 7 === 0) return { short: `EVERY ${rule.n / 7} WKS`, long: `EVERY ${rule.n / 7} WEEKS` };
      return { short: `EVERY ${rule.n} DAYS`, long: `EVERY ${rule.n} DAYS` };
    default: return { short: "", long: "" };
  }
}

/**
 * Reason's note to itself, as a sentence for the person's own page: its prefixes off and their name
 * turned into "you". Formatting only — what the note says is untouched — and one sentence of it.
 */
export function plainNote(text, { name = config.ownerName } = {}) {
  const n = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  const who = n ? n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\S+";
  let t = String(text ?? "").replace(/\s+/g, " ").trim()
    .replace(/^standing (check-in|call):\s*/i, "")
    .replace(/^(daily|weekly) challenge:\s*/i, "")
    .replace(new RegExp(`^${who} asked(\\s*\\([^)]*\\))?(,[^,]*,)?\\s+(to\\s+)?(be reminded\\s+(to|about|that)\\s+)?`, "i"), "")
    .replace(new RegExp(`^(remind|nudge|ask|tell|text)\\s+${who}\\s+(to|about|that|if|whether)\\s+`, "i"), "");
  const first = /^(.{12,220}?[.!?])(\s|$)/.exec(t);
  t = first ? first[1] : t.length > 220 ? `${t.slice(0, 219).trimEnd()}…` : t;
  if (n) t = t.replace(new RegExp(`\\b${who}'s\\b`, "gi"), "your").replace(new RegExp(`\\b${who}\\b`, "gi"), "you");
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
}

// ---------------------------------------------------------------- what task_finish hands back
const line = (v, max) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
/**
 * The BACK TO YOU record task_finish stores (tasks.result_json): for `done` the result card
 * (headline, a few typed facts, a note), for `failed` why and what happens next. Null for anything
 * else, or when nothing usable was given.
 */
export function resultFor(state, raw) {
  if (!raw || typeof raw !== "object") return null;
  if (state === "done") {
    const facts = (Array.isArray(raw.facts) ? raw.facts : []).map(f => line(f, 80)).filter(Boolean).slice(0, 4);
    const r = { headline: line(raw.headline, 120), facts, note: line(raw.note, 300) };
    return r.headline || facts.length || r.note ? r : null;
  }
  if (state === "failed") {
    const r = { why: line(raw.why, 160), next: line(raw.next, 400) };
    return r.why || r.next ? r : null;
  }
  return null;
}
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ---------------------------------------------------------------- the rows
const nameOf = (conversationId) => db.getAccount(conversationId)?.name || config.ownerName;

/** The row's own short title (src/itemtitle.js); until it has one, the note cleaned up, and one title asked for. */
function titled(kind, conversationId, row, text, name) {
  const label = String(row.label ?? "").trim();
  if (label) return label;
  queueTitle(kind, conversationId, row.id, text, { name });
  return cleanTitle(text, { name }) || String(text ?? "").trim().slice(0, 48);
}

/**
 * A working task's checklist. The steps the model keeps on the sheet when it has them; otherwise
 * what the record already says — each progress line it wrote, done at the time it wrote it, then
 * what it said is left, not started. Never a made-up step, never a percentage.
 */
export function stepsOf(task) {
  const sheet = task.sheet ?? {};
  if (sheet.steps?.length) return { real: true, steps: sheet.steps.map(s => ({ text: s.text, state: s.state, live: s.live ?? null, at: s.at ?? null })) };
  // Reason's own log lines: their name turned into "you", the words otherwise as written.
  const n = String(nameOf(task.conversation_id) ?? "").trim().split(/\s+/)[0];
  const you = (t) => (n ? String(t).replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'s\\b`, "gi"), "your").replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "you") : t);
  const done = db.taskLog(task.id, 40).filter(l => l.kind === "progress").map(l => ({ text: you(l.note), state: "done", live: null, at: l.at }));
  const left = (sheet.left ?? []).map(t => ({ text: t, state: "todo", live: null, at: null }));
  return { real: false, steps: [...done.slice(-6), ...left] };
}

/** Did anything this task was asked about actually go through? Then "nothing booked yet" is not true. */
function committedOn(conversationId, task) {
  return !!db.db.prepare("SELECT 1 FROM confirmations WHERE conversation_id = ? AND task_id = ? AND consumed_at IS NOT NULL LIMIT 1").get(conversationId, task.id);
}
/**
 * A purchase row that certainly took no money: no order, no authorization or hold, nothing charged,
 * and not one whose outcome nobody knows. Anything less certain counts as maybe charged.
 */
const surelyUncharged = (p) => !String(p.order_id ?? "") && !String(p.authorization_id ?? "") && !String(p.authorization_state ?? "")
  && ["", "none"].includes(String(p.charge_status ?? "").trim().toLowerCase()) && p.status !== "outcome_unknown";
/** Was any card purchase live while this task was open that might have charged? Then "nothing charged" is not said. */
function chargedDuring(conversationId, from, to) {
  return db.listAgentcardPurchases(conversationId, 50).some(p => p.created_at <= to && Math.max(p.created_at, p.updated_at ?? 0) >= from && !surelyUncharged(p));
}

function taskItem(conversationId, t, name, now) {
  const tz = config.tz;
  const base = { kind: "task", id: t.id, href: `/web/ongoing/task/${t.id}`, title: titled("task", conversationId, t, t.title, name), drafts: parseJson(t.drafts), task: t };
  const sheet = t.sheet ?? {};
  if (t.state === "waiting_on_you") {
    const asked = sheet.needs?.asked_at ?? null;
    return { ...base, group: "needs", state: "needs", status: "NEEDS YOU", words: "waiting on you", needs: true, due: t.next_wake_at ?? null, started: t.created_at,
      meta: asked ? `ASKED ${whenWord(asked, now, tz)}` : null,
      detail: sheet.needs?.question ?? null, question: sheet.needs?.question ?? null, tradeoff: sheet.needs?.tradeoff ?? null, asked: sheet.needs?.asked_at ?? null };
  }
  if (t.state === "waiting" || t.state === "waiting_on_other") {
    const w = sheet.waiting?.[0] ?? null;
    const since = w?.since ?? null;
    const check = w?.next_check ?? t.wanted_wake_at ?? t.next_wake_at ?? null;
    const detail = w ? `On ${w.on}${w.for ? `: ${w.for.replace(/[.]$/, "")}` : ""}.${since ? ` Asked ${daySentence(since, tz)}.` : ""}` : null;
    return { ...base, group: "hand", state: "waiting", status: "WAITING", words: "waiting to hear back", needs: false, due: check, started: t.created_at,
      meta: w ? `ON ${w.on.toUpperCase()}${since ? ` · SINCE ${whenWord(since, now, tz)}` : ""}` : null,
      detail, waitingOn: w?.on ?? null, waitingFor: w?.for ?? null, since, check: check && check > now ? check : null };
  }
  if (t.state === "blocked") {
    return { ...base, group: "hand", state: "stuck", status: "STUCK", words: "stuck. i'll say why in the chat", needs: false, due: t.next_wake_at ?? null, started: t.created_at,
      meta: sheet.blocked?.at ? `SINCE ${whenWord(sheet.blocked.at, now, tz)}` : null,
      detail: sheet.blocked?.what ?? null, blocked: sheet.blocked ?? null };
  }
  // running: a real checklist
  const { real, steps } = stepsOf(t);
  const doing = steps.find(s => s.state === "doing") ?? null;
  const doneN = steps.filter(s => s.state === "done").length;
  const lastLog = db.taskLog(t.id, 1)[0] ?? null;
  const of = real && steps.length > 1 ? `${Math.min(steps.length, doing ? doneN + 1 : doneN)} OF ${steps.length}` : null;
  // "2 OF 3" at the right says how far; the meta line says it's working and since when, or that a call for it is on the line now.
  const calling = db.taskCallLive(conversationId, t.id, { now });
  const meta = `${of ? "WORKING · " : ""}${calling ? "CALLING NOW" : `STARTED ${whenWord(t.created_at, now, tz)}`}`;
  return { ...base, group: "hand", state: "working", status: "WORKING", words: "working on it", needs: false, due: t.next_wake_at ?? null, started: t.created_at,
    steps, realSteps: real, of, calling, meta, live: doing?.live ?? null,
    detail: steps.length ? null : (lastLog && lastLog.kind !== "state" ? lastLog.note : null), goal: t.goal, nothingBooked: !committedOn(conversationId, t) };
}

function backItem(conversationId, t, name, now = clock.now()) {
  const res = parseJson(t.result_json) ?? {};
  const at = t.finished_at ? whenWord(t.finished_at, now) : null;
  const base = { kind: "task", id: t.id, href: `/web/ongoing/task/${t.id}`, title: titled("task", conversationId, t, t.title, name), drafts: parseJson(t.drafts), group: "back", needs: false, due: t.finished_at, started: t.finished_at, task: t };
  if (t.state === "done") {
    return { ...base, state: "ready", status: "READY", words: "done", meta: at ? `DONE · ${at}` : null,
      result: { headline: res.headline ?? null, facts: res.facts ?? [], note: res.note ?? (res.headline || res.facts?.length ? null : t.outcome || null) } };
  }
  const point = (t.sheet?.furthest ?? []).at(-1) ?? null;
  return { ...base, state: "failed", status: "DIDN'T WORK", words: "didn't work", meta: at ? `STOPPED · ${at}` : null,
    why: res.why ?? point?.because ?? t.sheet?.blocked?.what ?? (t.outcome || null),
    next: res.next ?? point?.one_action ?? null,
    nothingCharged: !chargedDuring(conversationId, t.created_at, t.finished_at ?? clock.now()) };
}

function timerItem(conversationId, t, name) {
  const tz = config.tz;
  return { kind: "timer", id: t.id, href: `/web/ongoing/timer/${t.id}`, group: "hand", state: "scheduled", needs: false, due: t.fire_at,
    started: t.created_at ?? null, meta: "ONCE", next_: nextWords(t.fire_at, tz),
    title: titled("timer", conversationId, t, t.note, name) || (t.call_goal ? "A call" : "A reminder"),
    drafts: parseJson(t.drafts),
    status: t.call_goal ? "CALL" : "REMINDER", call: !!t.call_goal,
    when: `${fmt(tz, { weekday: "short" }).format(t.fire_at)} ${clockOf(t.fire_at, tz)}`,
    time: clockOf(t.fire_at, tz), period: periodOf(t.fire_at, tz), date: dayShort(t.fire_at, tz), every: null, everyLong: null,
    description: plainNote(t.call_goal || t.note, { name }), next: t.fire_at };
}

function seriesItem(conversationId, s, name) {
  const rule = parseRule(s.rule);
  const armed = db.pendingSeriesTimer(s.id);
  const next = armed?.fire_at ?? s.next_at ?? null;
  const tz = s.tz || config.tz;
  const every = everyWords(rule);
  return { kind: "series", id: s.id, href: `/web/ongoing/series/${s.id}`, group: "hand", state: "scheduled", needs: false, due: next,
    started: s.created_at ?? null, meta: every.long || null, next_: nextWords(next, tz),
    title: titled("series", conversationId, s, s.what, name), status: every.short, call: !!s.call_goal,
    drafts: parseJson(s.drafts),
    when: next ? `${fmt(tz, { weekday: "short" }).format(next)} ${clockOf(next, tz)}` : every.short,
    time: next ? clockOf(next, tz) : null, period: next ? periodOf(next, tz) : "", date: next ? dayShort(next, tz) : null,
    every: every.short, everyLong: every.long, description: plainNote(s.call_goal || s.what, { name }), next };
}

// ---------------------------------------------------------------- approvals
const ACTION_WORDS = { purchase_confirm: "PURCHASE", browser_submit: "BOOKING", call_place: "CALL", message_send: "TEXT", voice_note_send: "VOICE NOTE",
  gmail_send: "EMAIL", uber_request: "RIDE", document_send: "DOCUMENT", drive_share: "SHARE", subscription_cancel_commit: "CANCEL A SUBSCRIPTION",
  flight_checkin_commit: "CHECK IN", account_connect: "CONNECT AN ACCOUNT", github_pr_merge: "MERGE A PULL REQUEST", access_grant: "ACCESS" };
const TO_ACTIONS = new Set(["call_place", "message_send", "voice_note_send", "gmail_send", "document_send", "drive_share"]);

/** The purchase a purchase_confirm ask is about: the row that spent this yes, or the cart its target is pinned to. */
function purchaseFor(conversationId, c) {
  const rows = db.listAgentcardPurchases(conversationId, 50);
  const byId = rows.find(r => r.confirmation_id === c.id);
  if (byId) return byId;
  const pinned = /\[([^\]]+)\](?:\s+in\s+(\S+))?\s*$/.exec(String(c.target ?? ""));
  return pinned ? rows.find(r => r.cart_hash === pinned[1] && (!pinned[2] || r.buy_conversation_id === pinned[2])) ?? null : null;
}

function flightFacts(conversationId, row) {
  const flight = parseJson(row.flight_json) ?? {};
  const search = flight.search_id != null && db.getFlightSearch ? db.getFlightSearch(conversationId, flight.search_id) : null;
  const opt = search?.options?.find(o => o.option === flight.option) ?? null;
  const legs = opt?.legs?.length ? opt.legs : (Array.isArray(flight.legs) ? flight.legs : []);
  const first = legs[0] ?? {}, last = legs.at(-1) ?? {};
  const ids = parseJson(row.traveler_ids) ?? [];
  const travelers = (Array.isArray(ids) ? ids : []).map(id => db.getFlightTraveler(conversationId, id)).filter(Boolean)
    .map(t => `${t.given_name} ${t.family_name}`.trim()).filter(Boolean);
  return {
    from: String(first.from ?? first.origin ?? "").toUpperCase(), to: String(last.to ?? last.destination ?? "").toUpperCase(),
    day: String(first.depart ?? first.departureAt ?? "").slice(0, 10), carrier: String(flight.carrier || first.airline || ""), travelers,
  };
}

/** One approval Reason is waiting on, with only the fields its own record really has. */
export function approvalItem(conversationId, c, now = clock.now()) {
  const tz = config.tz;
  const row = c.action === "purchase_confirm" ? purchaseFor(conversationId, c) : null;
  const rows = [];
  let total = c.amount_cents != null ? money(c.amount_cents) : null;
  let detail = null, nudge = null, about = null;
  if (row) {
    const cart = parseJson(row.cart_json) ?? {};
    total = money(row.amount_cents);
    if (row.kind === "flight") {
      const f = flightFacts(conversationId, row);
      if (f.from && f.to) rows.push(["FLIGHT", `${f.from} → ${f.to}`]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.day)) rows.push(["DATE", dayShort(Date.parse(`${f.day}T12:00:00Z`), "UTC")]);
      if (f.carrier) rows.push(["AIRLINE", f.carrier.toUpperCase()]);
      if (f.travelers.length) rows.push([f.travelers.length > 1 ? "TRAVELERS" : "TRAVELER", f.travelers.join(", ").toUpperCase()]);
      detail = `${total}${f.from && f.to ? `, ${f.from} to ${f.to}` : ""}.`;
      nudge = f.from && f.to ? `the ${f.from}–${f.to} flight needs a yes` : null;
      about = f.from && f.to ? `the ${f.from}–${f.to} flight` : null;
    } else {
      if (row.merchant) rows.push(["SHOP", row.merchant.toUpperCase()]);
      const items = Array.isArray(cart.items) && cart.items.length
        ? cart.items.map(i => `${i.qty > 1 ? `${i.qty}× ` : ""}${i.name}`).join("; ") : row.what;
      if (items) rows.push([Array.isArray(cart.items) && cart.items.length > 1 ? "ITEMS" : "ITEM", String(items).toUpperCase()]);
      const a = parseJson(row.address_json);
      const where = a ? [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
      if (where) rows.push(["SHIPS TO", where.toUpperCase()]);
      const offer = row.offer_id ? db.getOffer(conversationId, row.offer_id) : null;
      if (offer?.shipping_time) rows.push(["DELIVERY", String(offer.shipping_time).toUpperCase()]);
      if (cart.ceiling_cents && cart.ceiling_cents > row.amount_cents) rows.push(["HOLD UP TO", money(cart.ceiling_cents)]);
      detail = `${total} all-in${row.merchant ? ` from ${row.merchant}` : ""}.`;
      nudge = row.merchant ? `the ${row.merchant} order needs a yes` : null;
      about = row.merchant ? `the ${row.merchant} order` : null;
    }
  } else {
    rows.push(["WHAT", ACTION_WORDS[c.action] ?? String(c.action).replace(/_/g, " ").toUpperCase()]);
    if (TO_ACTIONS.has(c.action) && c.target) rows.push(["TO", String(c.target).toUpperCase()]);
    if (total) detail = `${total}.`;
  }
  rows.push(["ASKED", dayTime(c.asked_at, tz)]);
  const money_ = !!row || c.amount_cents != null || /money|both/i.test(String(c.stakes ?? "")) || /\$|charge|pay|buy|purchase|order/i.test(`${c.action} ${c.summary}`);
  return {
    kind: "approval", id: c.id, href: `/web/ongoing/approval/${c.id}`, group: "needs", state: "approval", status: "NEEDS YOU", needs: true, due: c.asked_at, at: c.asked_at,
    started: c.asked_at, meta: `ASKED ${whenWord(c.asked_at, now, tz)}`,
    title: String(c.summary ?? "").trim(), detail, money: money_, rows, total, about,
    // No Face ID promise here (owner 10-26 D2: only when the card flow really will prompt). Reason
    // can't know that while the yes is still open: AgentCard decides at the confirm, which runs only
    // after the yes, whether to pause for the passkey ("a confirm MAY pause", vault_approval_required +
    // approval_url, src/agentcard.js isApprovalPause; it also offers auto-approval), and the person
    // may approve with Touch ID, a fingerprint or a master password. When it does pause, that real
    // signal is recorded on the purchase row (status awaiting_approval, authorization_id,
    // approval_expires_at; src/tools.js purchase_confirm), by which time this ask is answered and gone.
    nudge: nudge ?? "one thing needs a yes",
  };
}

/** Approvals asked and not answered, in the last day, newest first. */
export function approvals(conversationId, now = clock.now()) {
  return db.pendingConfirmations(conversationId)
    .filter(c => c.granted_at == null && now - c.asked_at < APPROVAL_WINDOW_MS && String(c.summary ?? "").trim())
    .map(c => approvalItem(conversationId, c, now));
}

/**
 * Everything on this person's Ongoing, grouped. `items` is what Reason holds (needs-you tasks first,
 * then whatever is due soonest) — the rows the arrival and the margin have always shown; `approvals`
 * the one loud thing; `back` what came back to them, newest first.
 */
export function ongoing(conversationId, now = clock.now()) {
  const name = nameOf(conversationId);
  const tasks = db.listTasks(conversationId).map(t => taskItem(conversationId, t, name, now));
  const timers = db.listTimers(conversationId).filter(t => !t.series_id).map(t => timerItem(conversationId, t, name));
  const standing = db.listSeries(conversationId).filter(s => s.state === "active").map(s => seriesItem(conversationId, s, name));
  // A time already passed (a waiting check that came and went) isn't "soonest": it goes after what's upcoming.
  const rank = (x) => [x.needs ? 0 : 1, Number.isFinite(x.due) && (x.needs || x.due > now) ? x.due : Infinity];
  const items = [...tasks, ...timers, ...standing].filter(x => x.title).sort((a, b) => {
    const [an, ad] = rank(a), [bn, bd] = rank(b);
    return an - bn || (ad === bd ? 0 : ad < bd ? -1 : 1);
  });
  const back = db.listTasks(conversationId, { includeClosed: true })
    .filter(t => (t.state === "done" || t.state === "failed") && t.finished_at && now - t.finished_at < BACK_WINDOW_MS)
    .sort((a, b) => b.finished_at - a.finished_at || a.id - b.id)
    .map(t => backItem(conversationId, t, name, now)).filter(x => x.title);
  return { approvals: approvals(conversationId, now), items, back };
}

/**
 * What "Talk about it in the chat →" puts in the composer for one row (owner 10-27): a short message in
 * the person's own voice that fits the row's state. The draft the title summarise wrote for that state
 * when there is one (src/itemtitle.js); otherwise a plain one built from the row's own title. Never
 * sent for them; empty for a row that only wants their answer (NEEDS YOU: the question is theirs to answer).
 */
export function draftFor(x) {
  if (!x || x.state === "needs") return "";
  const own = x.drafts?.[x.state];
  if (typeof own === "string" && own.trim()) return own.trim();
  const t = String(x.title ?? "").trim();
  switch (x.state) {
    case "waiting": return x.waitingOn ? `Any word back from ${x.waitingOn} yet?` : t ? `Any news on ${t}?` : "Any news?";
    case "working": return t ? `How's ${t} going?` : "How's it going?";
    case "stuck": return t ? `What would get ${t} going again?` : "What would get it going again?";
    case "scheduled": return t ? `Can we change ${t}?` : "Can we change it?";
    case "ready": return t ? `Can I see ${t}?` : "Can I see it?";
    case "failed": return t ? `What's next for ${t}?` : "What's next?";
    case "approval": return x.about ? `Can I see the details of ${x.about}?` : "Can I see the details first?";
    default: return "";
  }
}

/** One row for a detail page, by kind and id, in this conversation only. Null when it isn't theirs or isn't there. */
export function findItem(conversationId, kind, id, now = clock.now()) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const name = nameOf(conversationId);
  if (kind === "approval") {
    const c = db.getConfirmation(conversationId, n);
    return c && c.granted_at == null && c.refused_at == null && c.consumed_at == null && now - c.asked_at < APPROVAL_WINDOW_MS ? approvalItem(conversationId, c, now) : null;
  }
  if (kind === "task") {
    const t = db.getTask(conversationId, n);
    if (!t) return null;
    if (t.open) return taskItem(conversationId, t, name, now);
    return t.state === "done" || t.state === "failed" ? backItem(conversationId, t, name, now) : null;
  }
  if (kind === "timer") {
    const t = db.getTimer(conversationId, n);
    return t && t.fired_at == null && t.cancelled_at == null ? timerItem(conversationId, t, name) : null;
  }
  if (kind === "series") {
    const s = db.getSeries(conversationId, n);
    return s && s.state === "active" ? seriesItem(conversationId, s, name) : null;
  }
  return null;
}
