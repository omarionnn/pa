// Events: an organizer makes one by texting their Reason, and guests join with its name and a
// password — including people who have no Reason yet, for whom an event is their way in.
//
// This file is the only reader of the event tables (src/db.js), because an event is the first thing
// in Reason that belongs to more than one person. Everything else is keyed by the conversation it
// belongs to, and that key is the isolation. Here it cannot be, so every rule about who may see or
// change what is written here, once, and pinned by test/events.test.js:
//
//   - **only the organizer manages an event.** `managed()` is the one door, and it answers a
//     stranger exactly as it answers a made-up id, so trying ids teaches nothing.
//   - **only a joined guest reads it**, and only what the organizer released. `guestView()` is the
//     one shape a guest is ever given; an unreleased time or address is not in it to leak.
//   - **before the password, nothing but the name and the description**, on the page, in its link
//     preview and in `event_lookup` alike (`publicView()`).
//   - **the password is a scrypt hash and nothing else.** It is never stored, logged or returned.
//     Tool inputs carrying one are sealed on the way into every log (src/privacy.js).
//
// Who may make an event is REASON_EVENTS (off | owner | on), like REASON_FLIGHT_BOOKING. Joining is
// open to anybody whenever events are not off — `owner` is "only the owner creates", not "only the
// owner's friends join".
import { scrypt as scryptCb, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { atLocal, tzFor } from "./series.js";
import { config, clock } from "./config.js";

// ---------- the switch ----------

/** Events exist at all: anybody may join one, any route. */
export function eventsOn() {
  return config.events === "owner" || config.events === true;
}

/** May this conversation make an event? `owner`: the owner alone. On: anybody with a Reason. */
export function canCreate(conversationId) {
  if (config.events === "owner") return !!conversationId && accounts.ownerOf(conversationId).isOperator;
  return config.events === true;
}

// ---------- passwords ----------

const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = promisify(scryptCb);
/** Longer than this is not a password anybody typed at a party; refused before it is hashed. */
export const MAX_PASSWORD = 200;

/**
 * The password as it is compared. Case and spacing do not count: it is read out at a party and typed
 * on a phone, and "Pumpkin " and "pumpkin" are the same word to the person who said it.
 */
export function normalPassword(pw) {
  return String(pw ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function passwordProblem(pw) {
  const p = normalPassword(pw);
  if (p.length < 4) return "too_short";
  if (p.length > 100) return "too_long";
  return null;
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(normalPassword(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Does this password open this hash? Asynchronous on purpose: scrypt is deliberately slow, and run
 * on the event loop a few guesses at once would stall every conversation on this one process.
 */
export async function checkPassword(pw, stored) {
  if (String(pw ?? "").length > MAX_PASSWORD) return false;
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const want = Buffer.from(hashB64, "base64");
  if (!want.length) return false;
  const got = await scrypt(normalPassword(pw), Buffer.from(saltB64, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------- names, links, times ----------

/** How names are matched: case, accents, spaces and punctuation do not count. */
export function nameKey(name) {
  return String(name ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export const EVENT_PATH = "/e";

function base() {
  if (config.pagesUrl) return config.pagesUrl;
  return (config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
}

/** The event's public link: its join page. Carries the random id, never the name. */
export function eventUrl(ev) {
  return `${base()}${EVENT_PATH}/${ev.public_id}`;
}

/** A guest's own way into the who's-going page. Dies when they leave or are removed. */
export function directoryUrl(ev, att) {
  return `${eventUrl(ev)}/who?t=${att.token}`;
}

/** The organizer's view of the same page: every guest, whatever they chose about the directory. */
export function organizerPageUrl(ev) {
  return `${eventUrl(ev)}/who?t=${ev.organizer_token}`;
}

/**
 * The event id in a pasted link, or null. This reads a URL's shape, which is a lookup key and not a
 * meaning: deciding that somebody pasted a link because they want to join is the model's, off the
 * tool descriptions.
 */
export function publicIdFromLink(text) {
  const m = /\/e\/([A-Za-z0-9_-]{16})(?=$|[/?#\s])/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/**
 * "2026-10-31T21:00" in a zone, as an instant. The model hands over the wall-clock time the organizer
 * said; the zone is theirs unless they named another.
 */
export function parseStartsAt(text, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  try {
    const ms = atLocal({ year, month, day, hour, minute }, tz);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

export function validZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** "Sat, Oct 31, 9:00 PM EDT" in the event's own zone. */
export function whenLine(ev) {
  if (ev.starts_at == null) return null;
  return new Date(ev.starts_at).toLocaleString("en-US", {
    timeZone: ev.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

/** An Instagram handle, or null when what they gave is not one. Untrusted text, so shape only. */
export function instagramHandle(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  const u = /instagram\.com\/([A-Za-z0-9._]{1,30})/i.exec(s);
  if (u) s = u[1];
  s = s.replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(s) && !/^\.|\.\.|\.$/.test(s) ? s : null;
}

export function instagramUrl(handle) {
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}

/** A display name a guest typed: untrusted, so trimmed, flattened to one line and capped. */
export function cleanDisplayName(raw) {
  const s = String(raw ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

/** Who is organizing, as a guest sees it: the name on their account, or the owner's. */
export function organizerName(ev) {
  const acct = db.getAccount(ev.organizer_conversation_id);
  if (acct?.name) return acct.name;
  if (acct?.is_operator || ev.organizer_conversation_id === config.ownerConversation) return config.ownerName;
  return null;
}

// ---------- who may see what ----------

/**
 * Everything anybody may know about an event without the password: its name and description, and
 * whether it can be joined. Nothing about who is going, when or where.
 */
export function publicView(ev) {
  return { name: ev.name, description: ev.description, status: ev.status, link: eventUrl(ev) };
}

/** What a joined guest may know: the released details, and nothing that is still the organizer's. */
export function guestView(ev, att) {
  const timeOut = !!ev.time_released && ev.starts_at != null;
  const placeOut = !!ev.location_released && !!ev.location;
  return {
    event_id: ev.id,
    name: ev.name,
    description: ev.description,
    organizer: organizerName(ev),
    status: ev.status,
    when: timeOut ? whenLine(ev) : null,
    ...(timeOut ? {} : { when_hidden: "the organizer hasn't shared the time yet" }),
    where: placeOut ? ev.location : null,
    ...(placeOut ? {} : { where_hidden: "the organizer hasn't shared the location yet" }),
    guest_list: ev.guest_list_visible ? "visible to guests" : "kept private by the organizer",
    ...(ev.guest_list_visible && att ? { directory_link: directoryUrl(ev, att) } : {}),
    ...(att ? { you: { display_name: att.display_name, in_directory: !!att.in_directory, instagram: att.instagram || null, muted: !!att.muted } } : {}),
  };
}

/** The organizer's view: all of it, except the password, which nobody can read back. */
export function organizerView(ev) {
  const going = db.joinedCount(ev.id);
  return {
    event_id: ev.id,
    name: ev.name,
    description: ev.description,
    when: whenLine(ev),
    starts_at_local: ev.starts_at != null ? localIso(ev.starts_at, ev.tz) : null,
    timezone: ev.tz,
    where: ev.location || null,
    welcome: ev.welcome || null,
    time_shown_to_guests: !!ev.time_released,
    location_shown_to_guests: !!ev.location_released,
    guest_list_visible: !!ev.guest_list_visible,
    capacity: ev.capacity ?? null,
    going,
    status: ev.status,
    link: eventUrl(ev),
    guest_list_page: organizerPageUrl(ev),
  };
}

function localIso(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * The one door to managing an event. The event, when this conversation organizes it; otherwise null —
 * the same null for somebody else's event as for an id that does not exist.
 */
export function managed(conversationId, eventId) {
  const ev = db.getEventRow(eventId);
  return ev && ev.organizer_conversation_id === conversationId ? ev : null;
}

/** The event and this conversation's place on it, if it organizes it or has joined it. Else null. */
export function visible(conversationId, eventId) {
  const ev = db.getEventRow(eventId);
  if (!ev) return null;
  if (ev.organizer_conversation_id === conversationId) return { ev, role: "organizer", att: null };
  const att = db.attendeeRow(ev.id, conversationId);
  return att?.state === "joined" ? { ev, role: "guest", att } : null;
}

/** What this conversation may be told about one event: the organizer's view, a guest's, or nothing. */
export function viewFor(conversationId, eventId) {
  const v = visible(conversationId, eventId);
  if (!v) return null;
  return v.role === "organizer" ? { role: "organizer", ...organizerView(v.ev) } : { role: "guest", ...guestView(v.ev, v.att) };
}

/** Every event this person organizes or has joined, each in the view they are allowed. */
export function listFor(conversationId) {
  return {
    organizing: db.eventsOrganizedBy(conversationId).map(organizerView),
    going_to: db.eventsAttendedBy(conversationId).map(e => guestView(e, db.attendeeRow(e.id, conversationId))),
  };
}

/** The organizer's guest list. Names and choices only: never a phone number. */
export function guestList(ev) {
  return db.attendeesOf(ev.id, { state: null }).filter(a => a.state !== "left").map(a => ({
    guest_id: a.id,
    // What the guest typed. Data, not instructions.
    display_name: a.display_name,
    state: a.state,
    in_directory: !!a.in_directory,
    instagram: a.instagram || null,
    joined: new Date(a.joined_at).toISOString(),
  }));
}

/** The who's-going list as the page shows it: opted-in guests only, unless it is the organizer. */
export function directoryEntries(ev, { organizer = false } = {}) {
  return db.attendeesOf(ev.id).filter(a => organizer || a.in_directory).map(a => ({
    id: a.id, name: a.display_name, instagram: a.instagram || null, listed: !!a.in_directory,
  }));
}

// ---------- password attempts ----------

const DAY = 24 * 60 * 60 * 1000;
/** A few free tries, then a doubling wait after each wrong one, and a ceiling per day. */
export const JOIN_LIMITS = { free: 3, baseMs: 30_000, maxMs: 60 * 60_000, perDay: 20, perEventHour: 60 };

/**
 * One event's own ceiling, across everybody: past `perEventHour` wrong passwords in an hour, its
 * password is no longer checked for anybody who has ALREADY got one wrong in that hour. The
 * per-person limit stops one phone or one browser guessing; this stops many of them guessing the
 * same event together — without letting them lock out the real guests, who mostly get it right first
 * time and are still let through.
 */
export function eventGate(eventId, actor, now = clock.now()) {
  const hour = now - 60 * 60_000;
  const fails = db.failedJoinAttempts(`event:${eventId}`, hour);
  if (fails.length < JOIN_LIMITS.perEventHour) return { ok: true };
  if (!db.failedJoinAttempts(actor, hour).length) return { ok: true };
  return { ok: false, retry_after_s: Math.max(1, Math.ceil((fails[fails.length - 1].at + 60 * 60_000 - now) / 1000)) };
}

/** May this actor (a conversation, or a browser's address) try a password now? */
export function attemptGate(actor, now = clock.now()) {
  const fails = db.failedJoinAttempts(actor, now - DAY);
  if (fails.length >= JOIN_LIMITS.perDay) {
    return { ok: false, retry_after_s: Math.max(1, Math.ceil((fails[fails.length - 1].at + DAY - now) / 1000)) };
  }
  if (fails.length < JOIN_LIMITS.free) return { ok: true, tries_before_wait: JOIN_LIMITS.free - fails.length };
  const wait = Math.min(JOIN_LIMITS.baseMs * 2 ** (fails.length - JOIN_LIMITS.free), JOIN_LIMITS.maxMs);
  const until = fails[0].at + wait;
  return now < until ? { ok: false, retry_after_s: Math.ceil((until - now) / 1000) } : { ok: true, tries_before_wait: 0 };
}

// ---------- making one ----------

/**
 * Make an event from the organizer's answers. Every setup question has to have been answered — the
 * model gathers them, this refuses a missing one — so an abandoned setup leaves no row behind.
 *
 * `{ ok: true, event }` or `{ ok: false, missing | problem }`.
 */
export function create(conversationId, input) {
  if (!canCreate(conversationId)) return { ok: false, problem: "not_available" };
  const name = String(input.name ?? "").trim().slice(0, 120);
  const description = String(input.description ?? "").trim().slice(0, 2000);
  const location = String(input.location ?? "").trim().slice(0, 500);
  const welcome = String(input.welcome_message ?? "").trim().slice(0, 1000);
  const missing = [];
  if (!name || !nameKey(name)) missing.push("name");
  if (!description) missing.push("description");
  if (!input.starts_at) missing.push("starts_at");
  if (!location) missing.push("location");
  if (!input.password) missing.push("password");
  for (const k of ["show_time_on_join", "show_location_on_join", "guest_list_visible"]) if (typeof input[k] !== "boolean") missing.push(k);
  if (missing.length) return { ok: false, missing };
  const tz = input.timezone && validZone(input.timezone) ? input.timezone : tzFor(conversationId);
  const startsAt = parseStartsAt(input.starts_at, tz);
  if (startsAt == null) return { ok: false, problem: "bad_time" };
  const pwProblem = passwordProblem(input.password);
  if (pwProblem) return { ok: false, problem: `password_${pwProblem}` };
  const capacity = input.capacity == null ? null : Math.floor(Number(input.capacity));
  if (capacity != null && !(capacity >= 1)) return { ok: false, problem: "bad_capacity" };
  const event = db.insertEvent({
    organizer: conversationId, name, nameKey: nameKey(name), description, startsAt, tz, location, welcome,
    passwordHash: hashPassword(input.password),
    timeReleased: input.show_time_on_join, locationReleased: input.show_location_on_join,
    guestListVisible: input.guest_list_visible, capacity,
  });
  return { ok: true, event };
}

/**
 * The text the owner gets about a finished creation: who, what, and where to look at it. The link is
 * the event's public page and, when there is one, the status page — never the organizer's own key,
 * which would show the owner every guest's choices on somebody else's event.
 */
export function ownerCreationLine(ev, { opsLink = null } = {}) {
  const acct = db.getAccount(ev.organizer_conversation_id);
  const who = [acct?.name || null, acct?.address || null].filter(Boolean).join(", ") || ev.organizer_conversation_id;
  return [`new event: "${ev.name}", made by ${who}.`, `its page: ${eventUrl(ev)}`, ...(opsLink ? [`on the status page: ${opsLink}`] : [])].join("\n");
}

// ---------- joining ----------

/**
 * Find the event somebody means, by its link or its name, and check the password against it.
 *
 * By name, two events can share one, so the password is checked against each and the one it opens
 * is the one they mean; if it opens more than one (same name, same password), they are asked who is
 * organizing. A loose match (one name containing the other) is only used when it finds exactly one
 * event, so a short word cannot sweep a guess across every event with it in the name. A link names
 * one event directly. The link never stands in for the password.
 *
 * By name, "no such event" and "wrong password" are one answer (`no_match`), so the name route
 * cannot be used to learn which events exist. By link the event is already named, so a wrong
 * password is said as such.
 *
 * Every wrong try is written down twice: once against the person or browser that made it (their
 * own limit), and once against each event it was checked against (that event's ceiling, and the
 * status page's failed-join count). Never with the password.
 *
 * `{ ok: true, event }` or `{ ok: false, reason, ... }` — `rate_limited`, `bad_link`, `no_match`,
 * `wrong_password`, `ambiguous` (with `organizers`), `cancelled`, `too_long`.
 */
export async function findForJoin({ actor, name = null, link = null, password, organizer = null, route }) {
  const gate = attemptGate(actor);
  if (!gate.ok) return { ok: false, reason: "rate_limited", retry_after_s: gate.retry_after_s };
  if (String(password ?? "").length > MAX_PASSWORD) return { ok: false, reason: "too_long" };
  let candidates;
  if (link) {
    const ev = db.eventByPublicId(publicIdFromLink(link));
    if (!ev) return { ok: false, reason: "bad_link" };
    if (ev.status === "cancelled") return { ok: false, reason: "cancelled", event: publicView(ev) };
    candidates = [ev];
  } else {
    const key = nameKey(name);
    candidates = db.eventsNamed(key);
    if (candidates.length > 1 && candidates.some(e => e.name_key !== key)) candidates = [];
    if (organizer && candidates.length > 1) {
      const want = nameKey(organizer);
      const narrowed = candidates.filter(e => { const o = nameKey(organizerName(e) ?? ""); return o && want && (o.includes(want) || want.includes(o)); });
      if (narrowed.length) candidates = narrowed;
    }
  }
  const open = candidates.filter(e => eventGate(e.id, actor).ok);
  if (candidates.length && !open.length) return { ok: false, reason: "rate_limited", retry_after_s: Math.max(...candidates.map(e => eventGate(e.id, actor).retry_after_s ?? 1)) };
  // Written down as wrong BEFORE the slow check, and taken back if it turns out right: otherwise a
  // burst of guesses sent at once would all pass the limit above while the first was still hashing.
  const held = [
    db.recordJoinAttempt({ actor, route, ok: false, reason: link ? "wrong_password" : "no_match" }),
    ...open.map(e => db.recordJoinAttempt({ eventId: e.id, actor: `event:${e.id}`, route, ok: false, reason: "wrong_password" })),
  ];
  const results = await Promise.all(open.map(e => checkPassword(password, e.password_hash)));
  const opened = open.filter((_, i) => results[i]);
  if (opened.length) db.deleteJoinAttempts(held);
  if (!opened.length) {
    const after = attemptGate(actor);
    const left = after.ok ? { tries_before_wait: after.tries_before_wait } : { retry_after_s: after.retry_after_s };
    return { ok: false, reason: link ? "wrong_password" : "no_match", ...left };
  }
  if (opened.length > 1) {
    return { ok: false, reason: "ambiguous", organizers: opened.map(e => organizerName(e) || "someone").slice(0, 5) };
  }
  return { ok: true, event: opened[0] };
}

/**
 * Put somebody who already has a Reason on an event. Every refusal that is about the event rather
 * than the password lives here, so every route — text, pasted link, the page — says the same.
 *
 * `{ ok: true, event, attendee, already }` or `{ ok: false, reason }`.
 */
export function admitExisting({ ev, conversationId, displayName, instagram = null, inDirectory = false, via, actor }) {
  if (ev.status === "paused") return { ok: false, reason: "paused" };
  if (ev.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (ev.organizer_conversation_id === conversationId) return { ok: false, reason: "organizer" };
  const added = db.addAttendee({ eventId: ev.id, conversationId, displayName, instagram, inDirectory, via });
  if (!added.ok) return { ok: false, reason: added.reason };
  db.recordJoinAttempt({ eventId: ev.id, actor, route: via, ok: true });
  return { ok: true, event: ev, attendee: added.attendee, already: added.already };
}

/**
 * The text and pasted-link routes for somebody already on Reason: password checked, then admitted.
 * Their account is the one they are texting from, and nothing about onboarding runs.
 */
export async function joinExisting({ conversationId, name = null, link = null, password, organizer = null, displayName = null, instagram = null, inDirectory = false }) {
  if (!eventsOn()) return { ok: false, reason: "not_available" };
  const via = link ? "link" : "text";
  const actor = `conv:${conversationId}`;
  const found = await findForJoin({ actor, name, link, password, organizer, route: via });
  if (!found.ok) return found;
  const shown = cleanDisplayName(displayName) || cleanDisplayName(db.getAccount(conversationId)?.name);
  if (!shown) return { ok: false, reason: "needs_display_name", event: publicView(found.event) };
  return admitExisting({ ev: found.event, conversationId, displayName: shown, instagram: instagramHandle(instagram), inDirectory, via, actor });
}

// ---------- the web join (src/pages/event.js) ----------

export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The page's join, after the password: a claim, holding what the page collected and the code the
 * guest's own text will carry. Nothing is joined yet — a phone has not been proved.
 */
export function makeClaim({ ev, displayName, instagram = null, inDirectory = false }) {
  return db.insertEventClaim({ eventId: ev.id, passwordVersion: ev.password_version, displayName, instagram: instagramHandle(instagram), inDirectory, ttlMs: CLAIM_TTL_MS });
}

/** The text the page's button prefills. Says what it is, with the code a lookup key in it. */
export function claimText(ev, code) {
  const c = String(code).toUpperCase();
  return `Hi Reason, I'm joining ${ev.name.slice(0, 60)} with code ${c.slice(0, 4)}-${c.slice(4)}`;
}

// ---------- telling guests ----------

/**
 * The welcome a guest gets on joining: the organizer's own message if they wrote one, then the
 * details they have released, then the who's-going page if the guest list is visible.
 */
export function welcomeText(ev, att) {
  const v = guestView(ev, att);
  const lines = [];
  if (ev.welcome) lines.push(ev.welcome);
  lines.push(`you're in for ${ev.name}${v.organizer ? ` (${v.organizer}'s event)` : ""}.`);
  if (v.when) lines.push(`when: ${v.when}`);
  if (v.where) lines.push(`where: ${v.where}`);
  const hidden = [!v.when && "the time", !v.where && "the location"].filter(Boolean);
  if (hidden.length) lines.push(`${hidden.join(" and ")} will come from the organizer later — i'll text you when it's out.`);
  if (v.directory_link) lines.push(`who's going (you choose whether you show up on it):\n${v.directory_link}`);
  return lines.join("\n\n");
}

/** A delivery still `pending` this long after its last change never reached the outbox: a crash mid-send. */
export const STUCK_MS = 5 * 60_000;

/** Whether one delivery reached its guest, read off the outbox rows it became. */
export function deliveryState(d, now = clock.now()) {
  const rows = db.outboxRowsForKey(d.idem_key);
  if (!rows.length) {
    if (d.state === "pending") return now - d.updated_at > STUCK_MS ? "failed" : "pending";
    return d.state === "error" ? "failed" : "sent";
  }
  if (rows.some(r => r.state === "failed")) return "failed";
  if (rows.every(r => r.state === "sent")) return "sent";
  return "sending";
}

/**
 * One message to one guest, once. The delivery row is made first and carries the outbox key, so
 * asking again finds the outbox row it already made and never sends a second copy.
 */
export async function deliver({ runtime, message, conversationId }) {
  const d = db.ensureDelivery({ messageId: message.id, eventId: message.event_id, conversationId });
  if (d.state !== "pending") return { delivery: d.id, state: deliveryState(d) };
  return await attemptDelivery({ runtime, message, d });
}

async function attemptDelivery({ runtime, message, d, body = message.body }) {
  let r;
  try {
    r = runtime?._tell ? await runtime._tell(d.conversation_id, body, { idempotencyKey: d.idem_key }) : { ok: false, error: "no way to send" };
  } catch (e) {
    r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
  }
  // Whatever the outbox now holds under this key is the truth from here on; with no outbox at all
  // (the console), a send that said ok is as delivered as it gets.
  const handed = db.outboxRowsForKey(d.idem_key).length > 0 || !!r?.ok;
  db.markDelivery(d.id, { state: handed ? "handed" : "error", error: r?.ok ? null : (r?.error ?? null) });
  const after = db.deliveryById(d.id);
  return { delivery: d.id, state: deliveryState(after) };
}

/**
 * One message to every joined guest. Muted guests get only what they cannot do without: the
 * cancellation. Returns the message and how each delivery went.
 */
export const SAME_MESSAGE_MS = 10 * 60_000;

export async function broadcast({ runtime, ev, kind, body }) {
  // The same words to the same event inside a few minutes is one message asked for twice (a turn
  // retried, a tool called again): it reuses the first, whose deliveries are already one per guest.
  const message = db.recentEventMessage(ev.id, kind, body, clock.now() - SAME_MESSAGE_MS) ?? db.insertEventMessage(ev.id, kind, body);
  const guests = db.attendeesOf(ev.id).filter(a => kind === "cancel" || !a.muted);
  const out = { sent: 0, sending: 0, failed: 0, pending: 0 };
  for (const g of guests) {
    const r = await deliver({ runtime, message, conversationId: g.conversation_id });
    out[r.state] = (out[r.state] ?? 0) + 1;
  }
  return { message_id: message.id, guests: guests.length, skipped_muted: db.attendeesOf(ev.id).length - guests.length, ...out };
}

/** The welcome, to one guest, as its own tracked message. */
export async function sendWelcome({ runtime, ev, att }) {
  const message = db.insertEventMessage(ev.id, "welcome", welcomeText(ev, att));
  return await deliver({ runtime, message, conversationId: att.conversation_id });
}

/**
 * Try one failed delivery again, without ever making a second copy: only a delivery whose outbox
 * rows say failed (so nothing reached them) moves to its next attempt, and the move is a
 * compare-and-set, so a second press finds it already moved.
 */
export async function retryDelivery({ runtime, deliveryId }) {
  const d = db.deliveryById(deliveryId);
  if (!d) return { ok: false, reason: "not_found" };
  const ev = db.getEventRow(d.event_id);
  const message = db.eventMessage(d.message_id);
  if (!ev || !message) return { ok: false, reason: "not_found" };
  if (ev.status === "paused") return { ok: false, reason: "paused" };
  // Only to somebody still entitled to it: a guest who left or was removed since gets nothing more
  // about the event (the one exception is the line telling them they were removed), and once the
  // event is cancelled the cancellation is the only thing still worth sending.
  const att = db.attendeeRow(ev.id, d.conversation_id);
  const entitled = message.kind === "removed" ? att?.state === "removed" : att?.state === "joined";
  if (!entitled) return { ok: false, reason: "no_longer_a_guest" };
  if (ev.status === "cancelled" && message.kind !== "cancel") return { ok: false, reason: "cancelled" };
  if (deliveryState(d) !== "failed") return { ok: false, reason: "not_failed", state: deliveryState(d) };
  // A message that went out in parts and broke partway: only the parts that never arrived go again.
  const rows = db.outboxRowsForKey(d.idem_key);
  // A part the outbox is still asking the provider about may have arrived: that is the outbox's to
  // settle, and a retry now could be a second copy of it.
  if (rows.some(r => r.state !== "sent" && r.state !== "failed")) return { ok: false, reason: "not_settled" };
  const unsent = rows.filter(r => r.state === "failed");
  const body = rows.length > 1 && unsent.length < rows.length ? unsent.map(r => r.body).join("\n\n") : message.body;
  const moved = db.bumpDeliveryAttempt(d.id, d.attempt);
  if (!moved) return { ok: false, reason: "already_retried" };
  const r = await attemptDelivery({ runtime, message, d: moved, body });
  return { ok: true, ...r };
}

/** Every failed delivery of one event, tried again once each. */
export async function retryFailed({ runtime, ev }) {
  const out = { retried: 0, skipped: 0 };
  for (const d of db.deliveriesForEvent(ev.id)) {
    if (deliveryState(d) !== "failed") continue;
    const r = await retryDelivery({ runtime, deliveryId: d.id });
    if (r.ok) out.retried++; else out.skipped++;
  }
  return out;
}

/** How one event's messages went, per message: for the ops page. */
export function deliveryReport(ev, { limit = 10 } = {}) {
  return db.eventMessages(ev.id, { limit }).map(m => {
    const ds = db.deliveriesFor(m.id).map(d => ({ id: d.id, state: deliveryState(d), attempt: d.attempt }));
    const count = (s) => ds.filter(d => d.state === s).length;
    return { id: m.id, kind: m.kind, at: m.created_at, total: ds.length, sent: count("sent"), sending: count("sending") + count("pending"), failed: count("failed"), failed_ids: ds.filter(d => d.state === "failed").map(d => d.id) };
  });
}

// ---------- the password, out of every copy ----------

/**
 * Take a password out of everything Reason keeps of one conversation since `since`: its history, the
 * memory log the extractor reads, the stored inbound text and the outbox. The organizer typed it, a
 * guest typed it, Reason may have said it back — and none of those may keep it in plaintext.
 *
 * Whole words only, in any case (the password itself is compared case-insensitively), so "Pumpkin"
 * goes and "pumpkins" stays. Run when the
 * tool that took the password finishes and again after the turn has written its own rows
 * (`scrubSoon`). Only the last few messages of the history and rows from the last few minutes are
touched, so a password that is also an ordinary word costs nothing older; and only outbox rows that
have gone, never one still waiting to go or to be retried. What it cannot reach — a memory fact the extractor
wrote before the later pass, the CLI's own session files — is listed in the verification skill's
features/events.md.
 */
export function scrubPassword(conversationId, password, since) {
  const word = String(password ?? "").trim();
  if (word.length < 4) return 0;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu");
  return db.scrubConversationText(conversationId, since, (t) => t.replace(re, "[event password]"));
}

/** Now, and twice more once the turn's own rows (its reply, the memory log) have been written. */
export function scrubSoon(conversationId, password, since = clock.now() - 10 * 60_000) {
  const n = scrubPassword(conversationId, password, since);
  for (const ms of [45_000, 5 * 60_000]) {
    const t = setTimeout(() => { try { scrubPassword(conversationId, password, since); } catch { /* best-effort */ } }, ms);
    t?.unref?.();
  }
  return n;
}
