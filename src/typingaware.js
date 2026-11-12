// REASON_TYPING_AWARE (off | owner | on; default off): wait for somebody only while they are typing.
//
// Until now a text waited a fixed pause before its turn (config.burstQuietMs: 1.0 s live), on the
// chance that a second bubble was coming. In ~180 turns that pause caught one burst; everybody
// else paid it for nothing. Sendblue can say when a contact starts and stops typing (a
// `typing_indicator` webhook: `{ number, is_typing, from_number, timestamp }`,
// api-v2/typing-indicators), so the wait can be for the people who are actually still writing:
//
//   - not typing            → the turn starts now. No fixed pause.
//   - typing                → the reply is held for their next text, which joins the same turn,
//                             and the question is asked again.
//   - typing stops, no text → they deleted the draft. Reply to what there is.
//   - 15 s, whatever the events say → reply. An event can be dropped or stuck on.
//   - no events at all for this person (webhook not registered, down, unsigned) → "not typing".
//     Events are a hint and never a requirement, so nothing in here can hang a reply.
//
// One thing the docs do not say is whether a "stopped" event is sent when a text is SENT. So a
// "typing" that was heard BEFORE a text arrived is taken to be that text being written and is never
// a reason to wait; only a "typing" heard after the newest text counts as the next one. That costs a
// short window after each text for such an event to arrive (GRACE_MS), and only for somebody whose
// typing events have been arriving at all: with no recent event from them the window is zero.
//
// PRIVACY. Whether somebody is typing is kept in this process's memory and nowhere else:
//   - never written to the database, a file, the journal with a number, or any analytics;
//   - the map is keyed by a keyed hash of the address (the key is random per process), so the
//     memory holds no phone number, and an entry is gone STATE_TTL_MS (30 s) after its last event;
//   - the only thing that leaves this file is one line an hour of counts and medians (`hourly`).
//
// OBSERVE-ONLY. With the switch off, a verified typing webhook is still counted (and nothing else
// is done with it): how many arrived, and how long before/after a text. That line is how the real
// phone check is read before the switch is turned on for anybody.
import { createHmac, randomBytes } from "node:crypto";
import { config, clock } from "./config.js";

/** How long "is typing" may be believed, and how long anything about a person is kept at all. */
export const STATE_TTL_MS = 30_000;
/** The longest a reply waits for a typing person's next text. Fixed: it is the promise, not a knob. */
export const CAP_MS = 15_000;
/** The longest one held turn waits in all, however many texts joined it while it waited. */
export const TOTAL_CAP_MS = 30_000;
/** The window after a text for a "typing" to arrive. Never more than a second, whatever is set. */
export const GRACE_MAX_MS = 1_000;
const GRACE_DEFAULT_MS = 300;
const SAMPLES_MAX = 500;

/** off | owner | on. Read on every call, so a restart is all a flip needs. */
export function typingAwareMode() {
  const v = String(process.env.REASON_TYPING_AWARE ?? "off").trim().toLowerCase();
  return v === "on" || v === "owner" ? v : "off";
}

/** Is it on for this conversation? "owner" is the operator's own thread, as src/fastreply.js reads it. */
export function typingAwareOn({ isOperator = false, conversationId = null } = {}) {
  const m = typingAwareMode();
  if (m === "on") return true;
  if (m !== "owner") return false;
  return !!isOperator || (conversationId != null && conversationId === config.ownerConversation);
}

/** REASON_TYPING_GRACE_MS, held between 0 and one second. */
export function graceMs() {
  const raw = process.env.REASON_TYPING_GRACE_MS;
  const n = raw == null || String(raw).trim() === "" ? GRACE_DEFAULT_MS : Number(raw);
  if (!Number.isFinite(n)) return GRACE_DEFAULT_MS;
  return Math.min(GRACE_MAX_MS, Math.max(0, Math.round(n)));
}

// ---------- the transient state ----------

const salt = randomBytes(32);
const keyOf = (address) => createHmac("sha256", salt).update(String(address ?? "").trim().toLowerCase()).digest("base64");

/** keyed hash of an address → { typing, typingAt, eventAt, msgAt, wake: Set<fn> }. Memory only. */
const people = new Map();

function prune(now) {
  for (const [k, s] of people) {
    if (s.wake.size) continue; // a reply is waiting on it; its own caps end that wait
    if (now - Math.max(s.eventAt ?? 0, s.msgAt ?? 0) >= STATE_TTL_MS) people.delete(k);
  }
}

function entry(address, now) {
  const k = keyOf(address);
  let s = people.get(k);
  if (!s) { s = { typing: false, typingAt: null, eventAt: null, msgAt: null, wake: new Set() }; people.set(k, s); }
  return s;
}

const wakeAll = (s) => { for (const fn of [...s.wake]) fn(); };

/** Is this person typing right now, as far as anything recent says? False past the TTL. */
export function isTyping(address, { now = clock.now() } = {}) {
  const s = people.get(keyOf(address));
  if (!s || !s.typing || s.typingAt == null) return false;
  return now - s.typingAt < STATE_TTL_MS;
}

/** How many people anything is remembered about. For tests and nothing else. */
export const remembered = ({ now = clock.now() } = {}) => { prune(now); return people.size; };

// ---------- counts: the only thing that is ever written anywhere ----------

const fresh = (now) => ({
  since: now, events: 0, starts: 0, stops: 0, refused: 0,
  messages: 0, messagesAfterTyping: 0, typingStillOnAtMessage: 0,
  typingToMessage: [], messageToTyping: [], eventLag: [],
  holds: 0, held: [], folded: 0, stopped: 0, capped: 0,
});
let counts = fresh(clock.now());

const sample = (list, ms) => { if (Number.isFinite(ms) && ms >= 0 && list.length < SAMPLES_MAX) list.push(Math.round(ms)); };
const median = (list) => {
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
};

/**
 * The hour's line: counts and medians, no address, no conversation, no time of any single event.
 * Null when nothing typing-related happened, so a machine with no typing webhook logs nothing.
 */
export function summary({ now = clock.now() } = {}) {
  const c = counts;
  if (!c.events && !c.refused && !c.holds) return null;
  return {
    typing_aware: typingAwareMode(),
    window_ms: Math.max(0, now - c.since),
    events: c.events, starts: c.starts, stops: c.stops, refused: c.refused,
    messages: c.messages, messages_after_typing: c.messagesAfterTyping, typing_still_on_at_message: c.typingStillOnAtMessage,
    median_typing_to_message_ms: median(c.typingToMessage),
    median_message_to_typing_ms: median(c.messageToTyping),
    median_event_lag_ms: median(c.eventLag),
    holds: c.holds, median_hold_ms: median(c.held), folded: c.folded, stopped: c.stopped, capped: c.capped,
  };
}

/** Write the line if an hour has gone by and there is anything to say, then start over. Never throws. */
export function hourly(log = () => {}, { now = clock.now(), everyMs = 60 * 60_000 } = {}) {
  if (now - counts.since < everyMs) return null;
  const line = summary({ now });
  counts = fresh(now);
  if (line) { try { log(line); } catch { /* a count is never worth a webhook */ } }
  return line;
}

// ---------- what the webhook and the router tell it ----------

/**
 * One VERIFIED typing webhook. The caller has checked the signature; an unverified one never gets
 * here (see `noteRefused`). `sentAt` is Sendblue's own timestamp on the event, used for one thing:
 * how far behind the event arrived.
 */
export function noteEvent({ address, isTyping: typing, sentAt = null, now = clock.now(), log = null } = {}) {
  if (log) hourly(log, { now });
  if (!address || typeof typing !== "boolean") return;
  prune(now);
  const s = entry(address, now);
  counts.events++;
  if (typing) counts.starts++; else counts.stops++;
  if (Number.isFinite(sentAt) && Math.abs(now - sentAt) < 60_000) sample(counts.eventLag, Math.max(0, now - sentAt));
  // The first "typing" after a text: how soon the next bubble is begun. This is what GRACE_MS is set from.
  if (typing && s.msgAt != null && !(s.typing && s.typingAt >= s.msgAt) && now - s.msgAt <= 10_000) sample(counts.messageToTyping, now - s.msgAt);
  s.typing = typing;
  s.eventAt = now;
  if (typing) s.typingAt = now;
  wakeAll(s);
}

/** A typing webhook that did not verify. Counted, and nothing else: it changes nobody's state. */
export function noteRefused({ now = clock.now(), log = null } = {}) {
  if (log) hourly(log, { now });
  counts.refused++;
}

/** A text arrived from this person. Wakes a reply that was waiting for exactly this. */
export function noteMessage({ address, now = clock.now(), log = null } = {}) {
  if (log) hourly(log, { now });
  if (!address) return;
  prune(now);
  // Remembered for the same 30 s as anything else: a "typing" that follows is measured against it.
  const s = entry(address, now);
  if (s.eventAt != null && now - s.eventAt < STATE_TTL_MS) {
    counts.messages++;
    counts.messagesAfterTyping++;
    if (s.typing) counts.typingStillOnAtMessage++;
    if (s.typingAt != null) sample(counts.typingToMessage, now - s.typingAt);
  }
  s.msgAt = now;
  wakeAll(s);
}

// ---------- the decision ----------

/**
 * Hold a reply while this person is typing their next text. The one question the router asks.
 *
 * Resolves `{ waited, why, more }` (`waited` is 0 unless a wait was actually taken):
 *   more: true   another text arrived while this waited; it is held like any other, so the caller
 *                looks at what is held again and asks again.
 *   more: false  run the turn now. `why` is one of:
 *                  no_events   nothing heard from this person lately (or ever): today's "not typing"
 *                  not_typing  the short window passed with no "typing"
 *                  stopped     they were typing and stopped without sending
 *                  cap         15 s (or 30 s in all) is up, whatever the events say
 *
 * `after(ms)` is the caller's timer, so a test spends no real seconds. `firstAt` is when the oldest
 * text this turn holds arrived; `lastAt` the newest. Never throws and never waits past a cap.
 */
export async function hold({ address, firstAt = null, lastAt = null, after, now = () => clock.now() } = {}) {
  const began = now();
  let slept = false;
  const done = (why, more = false) => {
    // Only a wait that was actually taken has a length: a "no" answered on the spot is 0, not the
    // millisecond the clock happened to tick over while it was being answered.
    const waited = slept ? Math.max(0, now() - began) : 0;
    if (slept) {
      counts.holds++;
      sample(counts.held, waited);
      if (more) counts.folded++;
      else if (why === "stopped") counts.stopped++;
      else if (why === "cap") counts.capped++;
    }
    return { waited, why, more };
  };
  if (!address || typeof after !== "function") return done("no_events");
  const s = people.get(keyOf(address));
  if (!s) return done("no_events");
  const seenMsgAt = s.msgAt;
  const anchor = s.msgAt ?? lastAt ?? began;
  const first = firstAt ?? anchor;
  let wasTyping = false;
  for (;;) {
    const t = now();
    if (s.msgAt !== seenMsgAt) return done("more", true);
    // Nothing heard from them within the TTL: events are not flowing for this person, so there is
    // nothing to wait for. This is also what a webhook that went down mid-wait turns into.
    if (s.eventAt == null || t - s.eventAt >= STATE_TTL_MS) return done(wasTyping ? "stopped" : "no_events");
    const capLeft = Math.min(anchor + CAP_MS, first + TOTAL_CAP_MS) - t;
    const typingNext = s.typing && s.typingAt != null && s.typingAt >= anchor && t - s.typingAt < STATE_TTL_MS;
    let wait;
    if (typingNext) {
      wasTyping = true;
      if (capLeft <= 0) return done("cap");
      wait = Math.min(capLeft, s.typingAt + STATE_TTL_MS - t);
    } else {
      if (wasTyping) return done("stopped");
      wait = Math.min(anchor + graceMs() - t, capLeft);
      if (wait <= 0) return done("not_typing");
    }
    let wake;
    const woken = new Promise(resolve => { wake = resolve; });
    s.wake.add(wake);
    slept = true;
    try { await Promise.race([woken, after(Math.max(1, wait))]); }
    finally { s.wake.delete(wake); }
  }
}

/** For tests: forget everybody and every count. */
export function resetTypingAware({ now = clock.now() } = {}) {
  for (const s of people.values()) wakeAll(s);
  people.clear();
  counts = fresh(now);
}
