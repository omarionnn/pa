// Somebody new who came in through an EVENT link (owner, 2026-11-11). REASON_EVENT_ONBOARDING:
//
//   off    exactly as before: the organizer's welcome, then the first-chat onboarding (src/onboarding.js
//          startAfterEvent) or the old card + try line
//   owner  only the owner's own number, the operator, and REASON_TEST_NUMBERS — even though their
//          accounts exist (so the owner can test it); everybody else as under off
//   on     every NEW account made by an event join, plus the owner's numbers as under owner
//
// The flow, for somebody it covers:
//   join          the organizer's welcome and released details (unchanged), then ONE line from Reason
//                 (JOIN_LINE): no question, no contact card, no cards. A name typed on the page is kept;
//                 the name question is never asked.
//   the event     event things only. Each turn is told they are an event guest and not to pitch Reason.
//                 No contact card goes while this lasts (router #offerCardIfNamed waits).
//   morning after 10:00 their time (the event's zone when theirs is unknown) the day after the event,
//                 on the timer system (label LABEL, so it survives restarts): "how was {event}?" (A),
//                 only if they are still a guest, not stopped, paused, muted or opted out, the event is
//                 not cancelled, and they have not become a Reason user some other way.
//   their reply   the normal turn answers it (told what it answers, and not to pitch), THEN one chain:
//                 "i can do more than events…" (B), the seven welcome cards exactly as new people get
//                 them (src/welcome.js: one carousel, its fall-backs), and the surprise-call line (C).
//   after C       their next text is the normal turn, told what C asked: a yes goes through the normal
//                 call flow (who and what for, then every call rule as it stands). Anything else ends
//                 it. Never a nudge. No reply to A: nothing more, ever.
//   the card      once past B/C (state done), the usual name-then-card logic (router #offerCardIfNamed).
//
// Once per person, ever, across every event: one row per conversation (event_onboarding). Never somebody
// already on Reason before the join, never somebody who already got the welcome cards or texted Reason
// about something other than the event (the model's read of their texts since the join, never a regex).
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as welcome from "./welcome.js";
import * as restcrypt from "./restcrypt.js";
import { config, clock, isOwnerNumber } from "./config.js";
import { askStructured, sideAskAllowed } from "./backends/side.js";
import { confirmedZone } from "./zone.js";
import { atLocal } from "./series.js";
import { commitStep } from "./onboarding.js";

export const LABEL = "event:after";

// ---------- the words (owner, 2026-11-11) ----------

/** The one line after the organizer's welcome. The host's first name only when the welcome already shows it. */
export const JOIN_LINE = (eventName, hostFirst = null) =>
  `i'm Reason, i'll keep you posted on ${eventName}. need the address, a ride, or to message ${hostFirst || "the host"}? just text me.`;
/** Step A, the morning after. */
export const ASK_LINE = (eventName) => `how was ${eventName}?`;
/** Step B, before the seven cards. */
export const MORE_LINE = "i can do more than events, here's some of what i do";
/** Step C, right after the cards. */
export const CALL_LINE = "want to start with a surprise call from me to a friend?";

// ---------- the switch ----------

export function mode() {
  const v = String(process.env.REASON_EVENT_ONBOARDING ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

/** The owner's own thread or one of his test numbers: covered under owner and on, account or not. */
export function ownerTest(conversationId, address = null) {
  const addr = address ?? db.getAccount(conversationId)?.address ?? null;
  return (!!conversationId && accounts.featureOwner(conversationId)) || (!!addr && (isOwnerNumber(addr) || accounts.isPreApproved(addr)));
}

/** Does the flow cover this join? `newAccount`: the join itself just made their account. */
export function covers({ conversationId, address = null, newAccount = false }) {
  const m = mode();
  if (m === "off" || !conversationId) return false;
  if (ownerTest(conversationId, address)) return true;
  return m === "on" && !!newAccount;
}

// ---------- the row ----------

db.db.exec(`
  CREATE TABLE IF NOT EXISTS event_onboarding (
    conversation_id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL,
    -- pending_pay | joined | asked | offered | done | skipped
    state TEXT NOT NULL,
    forced INTEGER NOT NULL DEFAULT 0,
    tries INTEGER NOT NULL DEFAULT 0,
    why TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    asked_at INTEGER,
    cards_at INTEGER,
    done_at INTEGER
  );
`);
const q = (sql) => db.db.prepare(sql);

export const rowOf = (conversationId) => conversationId ? q("SELECT * FROM event_onboarding WHERE conversation_id = ?").get(conversationId) ?? null : null;
function setState(conversationId, state, extra = {}) {
  const now = clock.now();
  const cols = { state, updated_at: now, ...extra };
  if (state === "asked") cols.asked_at = now;
  if (state === "done" || state === "skipped") cols.done_at = now;
  const keys = Object.keys(cols);
  q(`UPDATE event_onboarding SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE conversation_id = ?`).run(...keys.map(k => cols[k]), conversationId);
  return rowOf(conversationId);
}
const skip = (conversationId, why) => { cancelTimers(conversationId); return setState(conversationId, "skipped", { why: String(why).slice(0, 120) }); };

/**
 * Start (or, for the owner's tests, restart) the row for this join. Once per person ever: a row that
 * exists stays as it is, except an owner-test row still waiting for its morning after, which follows
 * the latest event joined.
 */
export function register({ conversationId, eventId, state = "joined", forced = false }) {
  const now = clock.now();
  const had = rowOf(conversationId);
  if (had) {
    if (!(ownerTest(conversationId) && (had.state === "joined" || had.state === "pending_pay" || forced))) return { row: had, fresh: false };
    q("UPDATE event_onboarding SET event_id = ?, state = ?, forced = ?, tries = 0, why = NULL, asked_at = NULL, cards_at = NULL, done_at = NULL, updated_at = ? WHERE conversation_id = ?")
      .run(eventId, state, forced ? 1 : 0, now, conversationId);
    return { row: rowOf(conversationId), fresh: true };
  }
  q("INSERT INTO event_onboarding (conversation_id, event_id, state, forced, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(conversationId, eventId, state, forced ? 1 : 0, now, now);
  return { row: rowOf(conversationId), fresh: true };
}

/** Is the row live under the switch as it now stands (the owner's tests only, under owner)? */
function inPlay(row) {
  if (!row) return false;
  const m = mode();
  if (m === "off") return false;
  return m === "on" || ownerTest(row.conversation_id);
}

/** While the event lasts, and until they have answered the call offer: no contact card, no pitch. */
export function holdsCard(conversationId) {
  const row = rowOf(conversationId);
  return inPlay(row) && ["pending_pay", "joined", "asked", "offered"].includes(row.state);
}

/** The call offer is read as just asked for this long; a text after that is not an answer to it. */
export const OFFER_FRESH_MS = 2 * 24 * 3_600_000;

// ---------- when ----------

const ymd = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms).split("-").map(Number);
const hourIn = (ms, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(ms));

/**
 * 10:00 their time the day after the event, or null while the event has no time. Their zone when it
 * is confirmed, else the event's. An event that starts in the small hours (before 5) belongs to the
 * night before, so its morning after is the same calendar day.
 */
export function morningAfter(ev, conversationId) {
  if (!ev || ev.starts_at == null) return null;
  const evTz = ev.tz || config.installTz;
  const [y, m, d] = ymd(ev.starts_at, evTz);
  const next = hourIn(ev.starts_at, evTz) < 5 ? 0 : 1;
  const day = new Date(Date.UTC(y, m - 1, d + next));
  const zone = confirmedZone(conversationId) || evTz;
  return atLocal({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 10, minute: 0 }, zone);
}

/** No time on the event yet: look again this often. */
export const RECHECK_MS = 24 * 3_600_000;
/** Past its morning after by more than this (the process was down, the event moved back), it is let go. */
export const LATE_MS = 10 * 3_600_000;
/** A row waiting on an event with no time this long is let go. */
export const GIVE_UP_MS = 120 * 24 * 3_600_000;

export function cancelTimers(conversationId) {
  return q("UPDATE timers SET cancelled_at = ? WHERE conversation_id = ? AND label = ? AND fired_at IS NULL AND cancelled_at IS NULL").run(clock.now(), conversationId, LABEL).changes;
}

/** The morning-after timer for this row (one at a time), at `at` or its computed moment. */
export function schedule(conversationId, { at = null } = {}) {
  const row = rowOf(conversationId);
  if (!row || row.state !== "joined") return null;
  cancelTimers(conversationId);
  const ev = db.getEventRow(row.event_id);
  let fireAt = at ?? morningAfter(ev, conversationId);
  if (fireAt == null) fireAt = clock.now() + RECHECK_MS;
  return db.createTimer(conversationId, { fireAt, note: "event morning-after", label: LABEL });
}

// ---------- on join ----------

/** The host's first name, only when the welcome shows the organizer to guests (events.organizerName). */
export function hostFirst(organizer) {
  const first = String(organizer ?? "").trim().split(/\s+/)[0] ?? "";
  return first || null;
}

/**
 * A join this flow covers (router #claimEvent, after the welcome): the row, the timer, and the one
 * line to send. Null when it does not cover them, or the line is not owed (a row from before).
 */
export function onJoin({ conversationId, address, ev, newAccount, organizer = null }) {
  if (!covers({ conversationId, address, newAccount })) return null;
  const { fresh } = register({ conversationId, eventId: ev.id });
  if (!fresh) return null;
  const at = morningAfter(ev, conversationId);
  // Joined after the event's morning after already went by: nothing to ask about later.
  if (at != null && at < clock.now() - LATE_MS) skip(conversationId, "joined_after_the_event");
  else schedule(conversationId);
  return { line: JOIN_LINE(ev.name, hostFirst(organizer)) };
}

/** A priced event's join (router #claimEvent, before the payment): the row now, the line once they are in. */
export function onPendingPay({ conversationId, address, ev, newAccount }) {
  if (!covers({ conversationId, address, newAccount })) return false;
  return register({ conversationId, eventId: ev.id, state: "pending_pay" }).fresh;
}

/** The payment went through (src/eventpay.js settlePaid, after the welcome): the line, and the timer. */
export async function afterPaid({ runtime, ev, conversationId, organizer = null, log = () => {} }) {
  const row = rowOf(conversationId);
  if (!inPlay(row) || row.state !== "pending_pay" || row.event_id !== ev.id) return null;
  setState(conversationId, "joined");
  schedule(conversationId);
  const router = runtime?.turnExtras?.channels ?? null;
  const acct = db.getAccount(conversationId);
  if (!router || !acct) return null;
  const thread = db.getThread?.(conversationId) ?? null;
  const text = JOIN_LINE(ev.name, hostFirst(organizer));
  const r = await router.send({ channel: acct.channel, to: acct.address, chatId: thread?.chat_id ?? null, text, conversationId, toOwner: true, idempotencyKey: `eventonb:join:${conversationId}:${ev.id}` })
    .catch(e => ({ ok: false, error: e?.message }));
  db.saveConversation(conversationId, [...db.loadConversation(conversationId), { role: "assistant", content: text }]);
  log({ event_onboarding_join: conversationId, event: ev.id, paid: true, ok: r?.ok !== false });
  return r;
}

// ---------- the morning after ----------

/** Has this person become a Reason user some other way since the join? The model's read of their texts. */
const OTHER_SCHEMA = { type: "object", properties: { other: { type: "boolean" } }, required: ["other"] };
function theirTexts(conversationId, since) {
  // Their own words as written to the history (src/db.js writeMessage, REASON_WEB), after the code
  // text that joined them; without that history, the model's own (its first user entry is the code text).
  const rows = db.messagesFor(conversationId, { limit: 500 })
    .filter(m => m.role === "user" && m.at > since)
    .map(m => String(restcrypt.openAny(m.text) ?? "").trim());
  const fromModel = () => db.loadConversation(conversationId).filter(m => m?.role === "user")
    .map(m => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("\n") : "")
    .slice(1).map(t => t.trim());
  return (rows.length ? rows : fromModel()).filter(Boolean).slice(-30);
}
export async function usedForOtherThings({ conversationId, ev, since = 0, ask = askStructured }) {
  const texts = theirTexts(conversationId, since);
  if (!texts.length) return false;
  if (ask === askStructured && !sideAskAllowed()) throw new Error("no side read");
  const r = await ask({
    prompt: `The event: ${String(ev?.name ?? "").slice(0, 80)}\n\nTheir texts to Reason since joining, oldest first:\n${texts.map(t => `- ${t.slice(0, 300)}`).join("\n").slice(0, 4_000)}`,
    system: `Reason is an assistant people text. This person joined Reason only to be a guest at one event. Read their texts and decide, by meaning: did they ask Reason for anything NOT about that event (a reminder, a search, a call, shopping, a plan, a question unrelated to the event, anything else)? Questions about the event itself (time, address, rides, the host, the guest list, what to bring, running late) and small talk or thanks do not count. "other": true only when at least one text is clearly about something else.`,
    schema: OTHER_SCHEMA,
    model: process.env.REASON_ONBOARDING_CLI_MODEL || "haiku",
    timeoutMs: Number(process.env.REASON_ONBOARDING_CLI_TIMEOUT_MS || 25_000),
    feature: "onboarding",
  });
  if (typeof r?.value?.other !== "boolean") throw new Error(r?.error || "no read");
  return r.value.other;
}

/** Still opted in: not stopped by the master, not paused, not opted out, not muted on the event. */
function stoppedWhy(acct, att) {
  if (!acct) return "no_account";
  if (acct.state === "paused" || acct.state === "removed") return `account_${acct.state}`;
  if (db.stoppedStateOf(acct.address)) return "stopped";
  if (acct.paused_at) return "paused";
  if (db.unreachable(acct.conversation_id)?.optedOut) return "opted_out";
  if (att?.muted) return "muted";
  return null;
}

/**
 * The timer firing (Runtime._runTimer). Step A once, if everything still holds; otherwise nothing, a
 * later timer (the event has no time yet, or moved), or the row let go. Returns the send's result, or
 * null when nothing was sent.
 */
export async function fire({ timer, router, key, ask = router?.onboard?.ask ?? askStructured, mayInterrupt = () => true, log = () => {} }) {
  const conv = timer.conversation_id;
  const row = rowOf(conv);
  if (!row || row.state !== "joined" || !inPlay(row)) return null;
  const ev = db.getEventRow(row.event_id);
  const acct = db.getAccount(conv);
  if (!ev || ev.status === "cancelled") { skip(conv, ev ? "event_cancelled" : "no_event"); return null; }
  const att = db.attendeeRow(ev.id, conv);
  const forced = !!row.forced;
  const now = clock.now();
  if (!forced) {
    if (att?.state !== "joined") { skip(conv, "not_a_guest"); return null; }
    const at = morningAfter(ev, conv);
    if (at == null) {
      if (now - row.created_at > GIVE_UP_MS) { skip(conv, "event_never_timed"); return null; }
      schedule(conv, { at: now + RECHECK_MS });
      return null;
    }
    if (at > now + 5 * 60_000) { schedule(conv, { at }); return null; }
    if (now - at > LATE_MS) { skip(conv, "too_late"); return null; }
    // Quiet hours or the day's unprompted texts used up: an hour later, inside LATE_MS.
    if (!mayInterrupt(conv)) { schedule(conv, { at: now + 3_600_000 }); return null; }
  }
  const stopped = stoppedWhy(acct, forced ? null : att);
  if (stopped) { skip(conv, stopped); return null; }
  // The owner's tests are the owner's account: already a Reason user by design.
  if (!ownerTest(conv, acct.address)) {
    if (acct.welcome_cards) { skip(conv, "had_welcome_cards"); return null; }
    if (acct.onboarding && acct.onboarding !== "complete") { skip(conv, "in_first_chat"); return null; }
    let other;
    try { other = await usedForOtherThings({ conversationId: conv, ev, since: row.created_at, ask }); }
    catch (e) {
      // No read: tried again in an hour, three times, then let go — never sent on a guess.
      if (row.tries >= 2) { skip(conv, "no_read"); return null; }
      q("UPDATE event_onboarding SET tries = tries + 1, updated_at = ? WHERE conversation_id = ?").run(now, conv);
      schedule(conv, { at: now + 3_600_000 });
      log({ event_onboarding_read_failed: conv, why: (e?.message ?? String(e)).split("\n")[0] });
      return null;
    }
    if (other) { skip(conv, "already_using_reason"); return null; }
  }
  if (!router) return null;
  // Written as asked first, so a retried firing can never ask twice.
  setState(conv, "asked");
  const thread = db.getThread?.(conv) ?? null;
  const text = ASK_LINE(ev.name);
  const r = await router.send({ channel: acct.channel, to: acct.address, chatId: thread?.chat_id ?? null, text, conversationId: conv, toOwner: true, idempotencyKey: key })
    .catch(e => ({ ok: false, error: e?.message }));
  db.saveConversation(conv, [...db.loadConversation(conv), { role: "assistant", content: text }]);
  log({ event_onboarding_asked: conv, event: ev.id, forced, ok: r?.ok !== false });
  return r;
}

// ---------- their texts, while the row is live ----------

/**
 * One drained message from somebody this flow covers (router, before the turn). Returns the frame the
 * turn reads, and `after: true` when step B/C is owed once the turn has answered. `screen`: the harm
 * screen; anything it does not call clear ends the flow before B.
 */
export async function beforeTurn({ conversationId, text = "", screen = null, log = () => {} }) {
  const row = rowOf(conversationId);
  if (!inPlay(row)) return null;
  const ev = db.getEventRow(row.event_id);
  const name = String(ev?.name ?? "the event").slice(0, 80);
  if (row.state === "joined" || row.state === "pending_pay") {
    // The owner's own tests: his thread is his everyday Reason, never framed as a guest's.
    if (ownerTest(conversationId)) return null;
    return { frame: `[They joined Reason through the event "${name}" and are a guest. Help with whatever they ask. Do not pitch Reason, list what else it can do, offer a contact card or ask about them.]` };
  }
  if (row.state === "asked") {
    let verdict = "clear";
    if (screen) verdict = (await Promise.resolve().then(() => screen({ text })).catch(() => ({ verdict: "unscreened" })))?.verdict ?? "clear";
    if (verdict !== "clear" && verdict !== "unscreened") {
      setState(conversationId, "done", { why: `screen_${verdict}` });
      log({ event_onboarding: conversationId, to: "done", why: `screen_${verdict}` });
      return null;
    }
    return {
      frame: `[Reason texted them "how was ${name}?" the morning after the event; this is their reply. Answer it naturally and briefly: a short warm line, or a real answer if they asked something. Do not say what else Reason can do and do not ask them anything: Reason follows with that itself right after your reply.]`,
      after: true,
    };
  }
  if (row.state === "offered") {
    setState(conversationId, "done");
    if (clock.now() - (row.cards_at ?? 0) > OFFER_FRESH_MS) return null;
    return { frame: `[Reason just asked them "${CALL_LINE}". If they say yes: ask who to call and what it is for, then follow every usual call rule exactly. If they say no, or say anything else, let it go and never bring it up again.]` };
  }
  return null;
}

/**
 * After the turn answered their reply to A: B, the seven cards, C — one ordered outbox chain, once.
 * The cards are marked on the account (welcome_cards), so nothing else ever sends them again.
 */
export async function afterReply({ router, conversationId, route, sleep, log = () => {} }) {
  const row = rowOf(conversationId);
  if (!inPlay(row) || row.state !== "asked") return null;
  const cards = welcome.bubbles(router, route.channel);
  const bubbles = [MORE_LINE, ...cards, CALL_LINE];
  const said = await commitStep({
    router, conversationId, route, bubbles, key: `eventonb:${conversationId}:${row.event_id}:${row.asked_at ?? 0}`,
    write: () => { db.setWelcomeCards(conversationId, "direct"); setState(conversationId, "offered", { cards_at: clock.now() }); },
    historyLines: (s) => s.length ? [{ role: "assistant", content: s.join("\n\n") }] : [],
    sleep: sleep ?? ((ms) => new Promise(r => setTimeout(r, ms).unref?.())), log,
  });
  log({ event_onboarding_cards: conversationId, sent: said.length });
  return { said };
}
