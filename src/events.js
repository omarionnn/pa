// Events: an organizer makes one by texting their Reason, and guests join with its name and a
// password — including people who have no Reason yet, for whom an event is their way in.
//
// This file is the only reader of the event tables (src/db.js), because an event is the first thing
// in Reason that belongs to more than one person. Everything else is keyed by the conversation it
// belongs to, and that key is the isolation. Here it cannot be, so every rule about who may see or
// change what is written here, once, and pinned by test/events.test.js:
//
//   - **a role is per event, never per person** (spec v3 §11). One account can organize Friday's
//     party and be a plain guest at Saturday's dinner. `roleIn()` is the one place a role is read:
//     the person's own membership row of THAT event, and for `organizer` the event's maker as well.
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
import { scrypt as scryptCb, scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import * as db from "./db.js";
import * as questions from "./eventquestions.js";
import * as accounts from "./accounts.js";
import { boundTo, codeHost, typedCode } from "./pages/access.js";
import { atLocal, tzFor } from "./series.js";
import * as eventpay from "./eventpay.js";
import { config, clock, normalizeNumber, normalizeHandle, stamp } from "./config.js";

// ---------- the switch ----------

/** Events exist at all: anybody may join one, any route. */
export function eventsOn() {
  return config.events === "owner" || config.events === true;
}

/** May this conversation make an event? `owner`: the owner alone. On: anybody with a Reason. */
export function canCreate(conversationId) {
  if (config.events === "owner") return accounts.featureOwner(conversationId);
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

/** Where event links start: the events domain, else the pages domain, else this server. */
function base() {
  if (config.eventsUrl) return config.eventsUrl;
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

/**
 * Is this event's organizer stopped — paused or removed by the master, on any line? null when not.
 * A stop is per number (db.stoppedStateOf, #351) and every sweep that speaks for a person skips a
 * stopped one. What Reason sends on its own for an event (a scheduled message, a reminder, a ride
 * ask, a list note, a nudge) is sent for its organizer, so it holds while they are stopped. Held,
 * not dropped: it goes if they are let go while it is still on time, the way a paused event's do.
 * The master's own events never are.
 */
export function organizerStopped(ev) {
  const acct = ev ? db.getAccount(ev.organizer_conversation_id) : null;
  if (!acct || acct.is_operator) return null;
  const own = acct.state ?? "active";
  if (own !== "active") return own;
  return db.stoppedStateOf(acct.address);
}

// ---------- who may see what ----------

/**
 * Everything anybody may know about an event without the password: its name and description, and
 * whether it can be joined. Nothing about who is going, when or where.
 */
export function publicView(ev) {
  // The price is public: anyone deciding whether to come should know it before typing a password.
  return { name: ev.name, description: ev.description, status: ev.status, link: eventUrl(ev), ...priceView(ev) };
}

/** The price as anybody may see it (src/eventpay.js), or nothing for a free event. */
export function priceView(ev) {
  if (!eventpay.priced(ev)) return {};
  return { price_per_person: eventpay.dollars(ev.price_cents), price: eventpay.guestPriceLine(ev), refund_policy: eventpay.policyWithMoney(eventpay.policyOf(ev), eventpay.ticketAt(ev)), paid_event: true };
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
    ...priceView(ev),
    ...(att ? { you: { display_name: att.display_name, in_directory: !!att.in_directory, instagram: att.instagram || null, muted: !!att.muted, ...paidLine(ev, att) } } : {}),
  };
}

/** What this guest paid, when the event costs something. */
function paidLine(ev, att) {
  if (!att?.conversation_id) return {};
  const row = eventpay.paidRow(ev.id, att.conversation_id);
  // Tickets they got for friends (src/eventpay.js seats): each link, and who claimed which.
  const friends = eventpay.seatsView(ev, att.conversation_id);
  const seats = friends.length ? { tickets_for_friends: friends } : {};
  if (!row) return seats;
  // Their own ticket's policy (the one bought under, or looser now), and whether they can ask now.
  const w = eventpay.refundWindow(ev, row);
  const gift = row.buyer_conversation_id && row.buyer_conversation_id !== att.conversation_id;
  // Whether they can ask now is left out while the time is hidden: watched over time it would tell the start.
  return {
    ...(gift ? { ticket_from: eventpay.buyerName(ev, { conversation_id: row.buyer_conversation_id }), ticket_value: eventpay.dollars(row.total_cents) } : { paid: eventpay.dollars(row.total_cents) }),
    your_refund_policy: eventpay.refundPolicyLine(w.policy), if_you_cancel: eventpay.selfRefundWords(row), ...(ev.time_released ? { can_ask_for_refund_now: w.allowed } : {}), ...seats,
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
    // The organizer's own page to run the event (src/pages/eventmanage.js): the same link, which opens
    // as the manage page on a browser signed in as them and offers a texted-code sign-in otherwise.
    manage_page: eventUrl(ev),
    guest_list_page: organizerPageUrl(ev),
    // Counts only, never who rides with whom (spec v3 §13); read off src/eventrides.js's tables.
    ...(ev.rides_enabled && (config.eventRides === true || config.eventRides === "owner") ? { rides: rideCounts(ev) } : {}),
    // Tickets (src/eventpay.js): the price, how many paid, what it comes to; and whether payouts are set up.
    ...(eventpay.priced(ev) ? { price_per_person: eventpay.dollars(ev.price_cents), tickets: ticketView(ev) } : {}),
    ...(eventpay.paidEventsOn() && (eventpay.canPrice(ev.organizer_conversation_id) || eventpay.priced(ev)) ? { payouts_ready: eventpay.payoutsReady(ev.organizer_conversation_id) } : {}),
  };
}

/** The money on one event, in words and numbers the organizer can read. */
export function ticketView(ev) {
  const s = eventpay.summary(ev);
  return {
    price_per_person: eventpay.dollars(ev.price_cents), sold: s.sold_count, paid: s.paid_count, gross: eventpay.dollars(s.gross_cents),
    refunded: s.refunded_count, refunded_amount: eventpay.dollars(s.refunded_cents), reason_fee: eventpay.dollars(s.reason_fee_cents), you_get: eventpay.dollars(s.organizer_net_cents),
    spots_held_for_payment: s.open_holds, ...(s.failed_refunds ? { refunds_that_failed: s.failed_refunds } : {}),
    ...(s.unclaimed_count ? { bought_for_friends_not_claimed_yet: s.unclaimed_count } : {}), max_tickets_per_buyer: eventpay.ticketMax(ev),
    ...(ev.price_cents ? { per_person: eventpay.organizerPriceLine(ev.price_cents) } : {}), refund_policy: eventpay.policyLabel(eventpay.policyOf(ev)),
  };
}

/** Rides on one event as the organizer may see them: matched / still looking, counts only (src/eventrides.js). */
export function rideCounts(ev) {
  const inAgreed = new Set();
  for (const m of db.rideMatchesFor(ev.id, ["agreed"])) for (const id of [m.driver_offer_id, m.rider_offer_id]) inAgreed.add(db.rideOffer(id)?.conversation_id);
  const looking = new Set(db.rideOffersFor(ev.id).filter(o => o.status === "open" && !inAgreed.has(o.conversation_id) && roleIn(o.conversation_id, ev.id)?.role === "guest").map(o => o.conversation_id));
  return { matched: inAgreed.size, still_looking: looking.size };
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
  const r = roleIn(conversationId, eventId);
  return r?.role === "organizer" ? r.ev : null;
}

/**
 * This person's role in this one event: `{ ev, role: "organizer" | "guest", att }`, or null when they
 * hold no live membership of it. Read off their own membership row of that event and nothing else —
 * not from what else they organize, and never from how a message sounds. An organizer row only
 * counts when the event's maker agrees, so a row written by mistake can never hand out the keys.
 * `att` is the guest's row (null for the organizer, who has no guest entry).
 */
export function roleIn(conversationId, eventId) {
  if (!conversationId) return null;
  const ev = db.getEventRow(eventId);
  if (!ev) return null;
  const row = db.attendeeRow(ev.id, conversationId);
  if (!row || row.state !== "joined") return null;
  if (row.role === "organizer") return ev.organizer_conversation_id === conversationId ? { ev, role: "organizer", att: null } : null;
  if (ev.organizer_conversation_id === conversationId) return null;
  return { ev, role: "guest", att: row };
}

/** The event and this conversation's place on it, if it organizes it or has joined it. Else null. */
export function visible(conversationId, eventId) {
  return roleIn(conversationId, eventId);
}

/**
 * "Which event does this message mean?" (spec v3 §11). Never the newest one silently: when the person
 * holds more than one membership a request could be about, the tool call has to say which event they
 * (or the conversation) named, and that has to pick out exactly the event acted on. `forOrganizer`
 * narrows to events they organize (for an organizer command), `forGuest` to events they're a guest at
 * (leave, mute, their directory entry); otherwise every event they're in.
 *
 * Matching a name or a link to an event is a lookup, not reading meaning: the model reads which
 * event the person means and hands over their words; this only checks those words point at one
 * (`eventsNamedBy`). It cannot stop a model that writes down the name of the event it guessed —
 * the tool description forbids that; this makes sure an unnamed or vague call never acts.
 *
 * `{ ok: true }` or `{ ok: false, choices }` — `choices` being the events it could be, each as the
 * person is allowed to see it, for one short question.
 */
export function whichEvent(conversationId, eventId, named, { forOrganizer = false, forGuest = false } = {}) {
  const live = db.membershipsOf(conversationId).filter(e => e.status !== "cancelled"
    && (!forOrganizer || e.role === "organizer") && (!forGuest || e.role === "guest"));
  if (live.length <= 1 || !live.some(e => e.id === Number(eventId))) return { ok: true };
  const hits = eventsNamedBy(live, named);
  if (hits.length === 1 && hits[0].id === Number(eventId)) return { ok: true };
  return {
    ok: false,
    choices: live.slice(0, 6).map(e => ({
      event_id: e.id, name: e.name, role: e.role,
      ...(e.role === "organizer" ? {} : { organizer: organizerName(e) || "someone" }),
      ...((e.role === "organizer" || e.time_released) && e.starts_at != null ? { when: whenLine(e) } : {}),
    })),
  };
}

/** Words that never tell one event from another. */
const FILLER = new Set(["the", "a", "an", "my", "our", "your", "his", "her", "their", "its", "one", "that", "this", "event", "s", "for", "of", "at", "to", "on"]);
/** A name as words: lowercased, accents and apostrophes gone ("Kofi's" → "kofi", "s"), filler dropped. */
function words(text) {
  return new Set(String(text ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(w => w && !FILLER.has(w)));
}

/**
 * Which of `live` the words `named` point at: a link → its event; a name said exactly → that event
 * (or those, when two share it); otherwise the events sharing the most words with what was said.
 * A tie is a tie, so "the party" with a "Party" and a "Rooftop Party" is both — and is asked about.
 * Among same-named events, the organizer's name said alongside ("Ama's halloween party") narrows.
 */
function eventsNamedBy(live, named) {
  const said = String(named ?? "").trim();
  if (!said) return [];
  const linked = publicIdFromLink(said);
  if (linked) return live.filter(e => e.public_id === linked);
  const key = nameKey(said);
  let hits = key ? live.filter(e => e.name_key === key) : [];
  const saidWords = words(said);
  if (!hits.length) {
    const score = (e) => [...words(e.name)].filter(w => saidWords.has(w)).length;
    const best = Math.max(0, ...live.map(score));
    hits = best ? live.filter(e => score(e) === best) : [];
  }
  if (hits.length > 1) {
    const narrowed = hits.filter(e => [...words(organizerName(e) ?? "")].some(w => saidWords.has(w)));
    if (narrowed.length) hits = narrowed;
  }
  return hits;
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
    // On the list by their own choice, not only by the default a join while it was private ticks.
    list_chosen: !!a.list_chosen,
    instagram: a.instagram || null,
    // When they first joined: "guests who joined since …" reads this same time.
    joined: new Date(a.first_joined_at ?? a.joined_at).toISOString(),
    via: a.via,
  }));
}

/**
 * The who's-going list as the page shows it: opted-in guests only, unless it is the organizer. The
 * organizer is on it too when they put themselves there (the same rules as a guest), first.
 */
export function directoryEntries(ev, { organizer = false } = {}) {
  const host = db.organizerListing(ev.id);
  return [
    ...(host ? [{ id: host.id, name: host.display_name, instagram: host.instagram || null, listed: true, organizer: true }] : []),
    ...db.attendeesOf(ev.id).filter(a => organizer || a.in_directory).map(a => ({
      id: a.id, name: a.display_name, instagram: a.instagram || null, listed: !!a.in_directory,
    })),
  ];
}

// ---------- recognizing a browser (spec v3 §12) ----------
//
// Every private event page — the who's-going page, a joined guest's details, the organizer's guest
// list — opens only on a browser Reason recognizes for that person: the page session (the
// `reason_page` cookie and its `page_sessions` row, the same one every Reason page uses). A browser
// is recognized by typing a one-time code Reason texted to that person, minted, hashed, expired,
// counted and compared by src/pages/access.js exactly as the page code gate does — one system, not
// two. The code proves who they are; their role in THIS event (`roleIn`) is still checked before
// anything is shown, and the event password is still what lets anybody join.

/** The key a person's event sign-in codes are counted under: one per person, whichever event. */
export function signinKey(conversationId) {
  return `esign:${conversationId}`;
}

/** What the code text says. Names the event and says it can be ignored. */
export function signinCodeLine(ev, code, { what = "sign in to" } = {}) {
  return `Your Reason code is ${code}, to ${what} "${String(ev.name).slice(0, 60)}" on that browser. Good for 15 minutes. If that wasn't you, ignore this — nothing was shown.${boundTo(codeHost(eventUrl(ev)), code)}`;
}

/**
 * The account a phone number typed into a page belongs to, if Reason still serves it and has a
 * texting line to reach it on. Null for anybody else — who is then a new guest. Ten digits with no
 * "+" is a US number typed the way people type it ("(718) 306-2726"): the line is +1, and without
 * the 1 it matched nobody and the page still said a code was on its way.
 */
export function accountForNumber(number) {
  const raw = String(number ?? "").trim();
  let n = normalizeHandle(raw);
  if (n.length === 11 && !n.includes("@") && !raw.startsWith("+")) n = `+1${n.slice(1)}`;
  if (!n) return null;
  for (const acct of db.accountsByAddress(n)) {
    if (!acct.channel || acct.channel === "console") continue;
    if (accounts.admit({ channel: acct.channel, address: acct.address }).allow) return acct;
  }
  return null;
}

/**
 * Try a sign-in code: the page code gate's code (`page_codes` under `signinKey`, hashed, once, 15
 * minutes) with the wrong tries counted twice. Per BROWSER, 5 per 15 minutes — the only count whose
 * limit is ever said out loud, so the answer never depends on whose number it was. And per PERSON, a
 * quiet ceiling of 20 across all browsers in 15 minutes and 40 a day (a distributed guess at a
 * six-digit code that anybody can have texted by typing a number).
 *
 * The ceiling bounds the GUESSING, never the person (audit lead 25): a stranger who only knows a
 * number used to be able to fill it and so make the person's own right code "wrong" for a day.
 * Past it, a code opens only on the browser that asked for it (`bound`, see `signinBinding`), and
 * gets one try there — a wrong one ends it. A stranger's guesses then reach only codes their own
 * browser asked for, one guess per code texted to the person, and the person's own fresh code still
 * works on the browser they asked from. Under the ceiling nothing changes: the newest code works in
 * any browser, as does the one this browser asked for. `conversationId` null — a number with no
 * account — is the same path with nothing to match. `{ ok: true, token }` or `{ ok: false, reason:
 * "wrong" | "rate_limited" }`.
 */
export const SIGNIN_WRONG = { perBrowser: 5, perPerson: 20, windowMs: 15 * 60_000, perPersonDay: 40, dayMs: 24 * 60 * 60_000 };
export function trySigninCode({ conversationId, code, actor }) {
  return tryKeyedCode({ conversationId, code, personKey: conversationId ? signinKey(conversationId) : null, browserKey: `esignb:${actor}`, bound: signinBinding(actor) });
}

/**
 * What a sign-in code is bound to: a hash of what identifies the asking browser (its address for an
 * event page, its sign-in form secret for Web), so the table holds neither. Never null: a sign-in
 * code always belongs to some browser.
 */
export function signinBinding(what) {
  return createHash("sha256").update(`signin-bound:${String(what ?? "")}`).digest("base64url").slice(0, 32);
}

/**
 * The same check under other keys: Reason Web signs in with `wsign:<conversation>` codes and counts
 * its browsers under `wsignb:<actor>` (src/pages/websignin.js), with exactly these ceilings. One
 * function, so a limit tightened here is tightened everywhere a texted code opens something.
 * `bound` is the asking browser's `signinBinding`, the same one its code was minted with.
 */
export function tryKeyedCode({ conversationId, code, personKey, browserKey, bound }) {
  if (db.failedPageAttempts(browserKey, SIGNIN_WRONG.windowMs) >= SIGNIN_WRONG.perBrowser) return { ok: false, reason: "rate_limited" };
  const typed = typedCode(code);
  const mine = personKey ? db.livePageCode(personKey, { bound: bound ?? "" }) : null;
  const crowded = !!personKey
    && (db.failedPageAttempts(personKey, SIGNIN_WRONG.windowMs) >= SIGNIN_WRONG.perPerson
      || db.failedPageAttempts(personKey, SIGNIN_WRONG.dayMs) >= SIGNIN_WRONG.perPersonDay);
  const newest = personKey && !crowded ? db.livePageCode(personKey) : null;
  const live = [mine, newest].find(c => c && db.pageCodeIs(c.code, typed)) ?? null;
  if (!live) {
    db.recordPageAttempt(browserKey, false);
    if (personKey) db.recordPageAttempt(personKey, false);
    // Past the ceiling a code has one try: a wrong one, from its own browser, ends it.
    if (crowded && mine) db.expirePageCode(mine.id);
    return { ok: false, reason: "wrong" };
  }
  db.recordPageAttempt(personKey, true);
  db.usePageCode(live.id);
  const token = randomBytes(32).toString("base64url");
  db.startPageSession(personKey, token, { conversationId });
  return { ok: true, token };
}

/** Sign-in codes one browser may ask for in an hour, whoever's number it types. */
export const SIGNIN_PER_BROWSER_HOUR = 10;
export function signinGate(actor, now = clock.now()) {
  return db.signinRequestsSince(actor, now - 60 * 60_000) < SIGNIN_PER_BROWSER_HOUR;
}
export function noteSigninRequest(actor) {
  db.recordJoinAttempt({ actor, route: "signin", ok: true, reason: "signin_request" });
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
  // A browser's address is only as good as the header it came with, and one path in (the Tailscale
  // funnel) cannot prove its headers. So past the ceiling every browser waits — a fresh address is
  // not a fresh person — while a phone, which has to text from a real number, keeps its first try.
  // Guests held at the page can still join by texting Reason the name and password.
  const browser = String(actor).startsWith("ip:");
  if (!browser && !db.failedJoinAttempts(actor, hour).length) return { ok: true };
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
    organizer: conversationId, organizerName: db.getAccount(conversationId)?.name ?? "", name, nameKey: nameKey(name), description, startsAt, tz, location, welcome,
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

/**
 * The words an organizer forwards: the name and the password, and never the link — the link goes as
 * a message of its own, so the phone draws it as the event's card (spec §14).
 */
export function shareText(ev, password) {
  return `You're invited to ${ev.name}. The password to join is: ${password}\nOpen this link and enter it:`;
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
    return { ok: false, reason: "ambiguous", organizers: opened.map(e => organizerName(e) || "someone").slice(0, 5), event_ids: opened.map(e => e.id) };
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
  // A priced event (src/eventpay.js): the password opens the page, but the spot is paid for first.
  // Nobody is admitted here; the caller starts a Checkout and the webhook does the join (settlePaid).
  if (eventpay.priced(ev) && !eventpay.paidRow(ev.id, conversationId)) {
    const prior = db.attendeeRow(ev.id, conversationId);
    if (prior?.state === "joined") return { ok: true, event: ev, attendee: prior, already: true };
    if (prior?.state === "removed") return { ok: false, reason: "removed" };
    return { ok: false, reason: "payment_required", event: ev, displayName, instagram, inDirectory, via, actor };
  }
  const added = db.addAttendee({ eventId: ev.id, conversationId, displayName, instagram, inDirectory, via });
  if (!added.ok) return { ok: false, reason: added.reason };
  db.recordJoinAttempt({ eventId: ev.id, actor, route: via, ok: true });
  return { ok: true, event: ev, attendee: added.attendee, already: added.already };
}

/**
 * The text and pasted-link routes for somebody already on Reason: password checked, then admitted.
 * Their account is the one they are texting from, and nothing about onboarding runs.
 */
export async function joinExisting({ conversationId, name = null, link = null, password, organizer = null, displayName = null, instagram = null, inDirectory = true, answers = null }) {
  if (!eventsOn()) return { ok: false, reason: "not_available" };
  const via = link ? "link" : "text";
  const actor = `conv:${conversationId}`;
  const found = await findForJoin({ actor, name, link, password, organizer, route: via });
  if (!found.ok) return found;
  const shown = cleanDisplayName(displayName) || cleanDisplayName(db.getAccount(conversationId)?.name);
  if (!shown) return { ok: false, reason: "needs_display_name", event: publicView(found.event), event_ids: [found.event.id] };
  const asked = requiredAnswers(found.event, conversationId, answers);
  if (!asked.ok) return asked;
  return withAnswers(admitExisting({ ev: found.event, conversationId, displayName: shown, instagram: instagramHandle(instagram), inDirectory, via, actor }), asked.answers);
}

/**
 * A text join is not finished while a required question has no answer (owner decision 2026-11-11):
 * `{ ok: false, reason: "needs_answers", questions }` names the ones still to ask, for the model to
 * ask gently, one at a time. Somebody already in is never held: their row stands as it is.
 */
function requiredAnswers(ev, conversationId, answers) {
  const read = questions.readTextAnswers(ev, answers);
  if (read.missing.length && db.attendeeRow(ev.id, conversationId)?.state !== "joined") {
    return { ok: false, reason: "needs_answers", event: publicView(ev), event_ids: [ev.id], questions: read.missing };
  }
  return { ok: true, answers: read.answers };
}
/** The answers given with the join, filed onto the new guest (never onto somebody who was already in). */
function withAnswers(out, answers) {
  if (out.ok && !out.already && answers?.length) questions.saveAnswers(out.event, out.attendee, answers, "text");
  // A priced event: the answers ride on the payment (src/eventpay.js startCheckout) and are filed when it lands.
  if (!out.ok && out.reason === "payment_required" && answers?.length) out.answers = answers;
  return out;
}

/**
 * The follow-up to "which one?" or "what name?": events the password was ALREADY right for (the
 * caller kept their ids, briefly — src/eventtools.js), narrowed by who is organizing, then admitted.
 * Never a way in without a password: only ids a right password produced reach here.
 */
export function joinVerified({ conversationId, eventIds, organizer = null, displayName = null, answers = null }) {
  if (!eventsOn()) return { ok: false, reason: "not_available" };
  let candidates = (eventIds ?? []).map(id => db.getEventRow(id)).filter(e => e && e.status !== "cancelled");
  if (organizer && candidates.length > 1) {
    const want = nameKey(organizer);
    const narrowed = candidates.filter(e => { const o = nameKey(organizerName(e) ?? ""); return o && want && (o.includes(want) || want.includes(o)); });
    if (narrowed.length) candidates = narrowed;
  }
  if (!candidates.length) return { ok: false, reason: "not_verified" };
  if (candidates.length > 1) return { ok: false, reason: "ambiguous", organizers: candidates.map(e => organizerName(e) || "someone").slice(0, 5), event_ids: candidates.map(e => e.id) };
  const ev = candidates[0];
  const shown = cleanDisplayName(displayName) || cleanDisplayName(db.getAccount(conversationId)?.name);
  if (!shown) return { ok: false, reason: "needs_display_name", event: publicView(ev), event_ids: [ev.id] };
  const asked = requiredAnswers(ev, conversationId, answers);
  if (!asked.ok) return asked;
  return withAnswers(admitExisting({ ev, conversationId, displayName: shown, inDirectory: true, via: "text", actor: `conv:${conversationId}` }), asked.answers);
}

// ---------- the guest-list note (owner decision 2026-10-25) ----------
//
// Somebody who already had Reason joins (by text, pasted link or the page): right after the welcome,
// ONE follow-up says the name they show under on the who's-going list and that they can change it,
// and either asks once whether they want their Instagram on it, or — when they shared one before —
// says it will show here too. Nothing when the organizer keeps the list private, nothing at night in
// the event's zone (it waits for the morning), never a second time for the same event, never chased.
// Their answer is read by the model off the thread (the note is written into it), never by pattern.
// The organizer, on their own event's list, gets the same note when they make it.

/** Nothing unprompted between these hours in the event's zone (as for rides, src/eventrides.js). */
export const LIST_NOTE = { quietFrom: 21, quietUntil: 9, backstopMs: 10 * 60_000, staleAfterStartMs: 12 * 60 * 60_000 };

export function listNoteQuiet(ev, now = clock.now()) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: ev.tz, hour: "numeric", hourCycle: "h23" }).format(new Date(now)));
  return h >= LIST_NOTE.quietFrom || h < LIST_NOTE.quietUntil;
}

/**
 * The note's words, or null when nothing should be said: the list is private, they are not on it,
 * they are off the event, or the ask is moot because they already gave a handle.
 */
export function listNoteText(ev, att, kind) {
  if (kind === "opened") return openedNoteText(ev, att);
  if (!ev?.guest_list_visible || !att || att.state !== "joined" || !att.in_directory) return null;
  const name = cleanDisplayName(att.display_name);
  // Plain intent, never a phrase to type (owner copy rule 2026-10-25): they answer in their own
  // words and the model reads what they meant.
  const change = "if you'd like a different name, or would rather not be on it, just let me know";
  if (!name) return kind === "ask" ? "what name should show for you on the who's-going list? and if you'd like your instagram on it too, send your handle — totally optional." : null;
  if (kind === "ask") return att.instagram ? null : `you're on the who's-going list as ${name} — ${change}. want your instagram on the guest list too? send your handle if so, no worries if not.`;
  if (!att.instagram) return null;
  if (kind === "carried") return `you're on the who's-going list as ${name} — ${change}. i'll show your instagram @${att.instagram} on this guest list too; tell me anytime if you'd rather it not show.`;
  return `you're on the who's-going list as ${name}, with your instagram @${att.instagram} — ${change}, or if you'd rather your instagram not show.`;
}

/** Every kind of list note that can be owed. `opened` is the one asked when the organizer shows a list that was private. */
const LIST_NOTE_KINDS = ["ask", "carried", "shown", "opened"];

/**
 * The one note to a guest who joined while the list was private, once the organizer shows it: they
 * are not on it, and it is theirs to say if they want to be. Plain intent, never a phrase to type.
 * Null once it is moot — the list is private again, they put themselves on it, they are off the
 * event, or they muted it.
 */
export function openedNoteText(ev, att) {
  if (!ev?.guest_list_visible || !att || att.state !== "joined" || att.in_directory || att.muted || att.role === "organizer") return null;
  const who = organizerName(ev);
  const name = cleanDisplayName(att.display_name);
  return `${who ? `${who} turned on` : "the organizer turned on"} a who's-going list for ${ev.name}, so guests can see who else is coming. you're not on it — if you'd like to be, just let me know${name ? ` (you'd show as ${name})` : ", and what name to show"}.`;
}

/**
 * Who showing the list would ask, before anything changes: the joined guests on it only by default
 * (they joined while it was private), the ones of them who would be texted (not muted), and the text.
 */
export function listOpenPlan(ev) {
  const off = ev.guest_list_visible ? [] : db.unchosenListed(ev.id);
  const asked = off.filter(a => !a.muted && a.list_note !== "sent");
  const sample = asked[0] ?? { display_name: "", state: "joined", in_directory: 0, muted: 0 };
  return { off: off.length, asked: asked.length, names: asked.map(guestName), ids: asked.map(a => a.id), body: openedNoteText({ ...ev, guest_list_visible: 1 }, { ...sample, in_directory: 0 }) };
}

/**
 * The name the organizer goes on their own list under when they show it, or null: they are put on it
 * the way creating a shown list does, unless they already took themselves off it.
 */
export function hostWouldList(ev) {
  const row = db.attendeeRow(ev.id, ev.organizer_conversation_id);
  if (row?.role !== "organizer" || row.in_directory || row.list_chosen) return null;
  return cleanDisplayName(row.display_name) ?? cleanDisplayName(db.getAccount(ev.organizer_conversation_id)?.name);
}

/**
 * Show or hide the who's-going list after the event was made (owner request 2026-11-08).
 *
 * Hiding is quiet: nobody is texted, the who's-going page closes for guests, and every guest's own
 * choice is kept for if it is shown again. Showing never puts anybody on it who did not choose it:
 * guests who joined while it was private come off it (their join only ticked the default) and each
 * is owed one note asking if they want to be on it — sent by the sweep, never at night, never to a
 * guest who muted the event. Guests who chose it while it was shown before are on it again. The
 * organizer is put on their own list the way creating a shown list does. All of it one transaction.
 */
export function setListVisible(ev, visible, { now = clock.now() } = {}) {
  if (!!ev.guest_list_visible === !!visible) return { ok: true, changed: false, visible: !!visible, off: 0, asked: 0 };
  db.db.exec("BEGIN IMMEDIATE");
  let out;
  try {
    const cur = db.getEventRow(ev.id);
    db.updateEventRow(ev.id, { guest_list_visible: visible ? 1 : 0 });
    let opened = { off: 0, owed: 0 };
    let host = false;
    if (visible && !cur.guest_list_visible) {
      opened = db.openListFor(ev.id, now);
      const name = hostWouldList(ev);
      if (name) { db.updateAttendeeRow(db.attendeeRow(ev.id, ev.organizer_conversation_id).id, { in_directory: 1, display_name: name }); host = name; }
    }
    db.db.exec("COMMIT");
    const after = db.getEventRow(ev.id);
    out = { ok: true, changed: true, visible: !!after.guest_list_visible, off: opened.off, asked: opened.owed, ...(host ? { you_listed_as: host } : {}), ev: after };
  } catch (e) {
    try { db.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  return out;
}

/**
 * Change the cap after the event was made, or take it off (null). Nobody already in is ever taken
 * off: a cap at or under the number in closes new joins — the join check is "fewer than the cap are
 * in" (db.addAttendeeTx) — and they open again only if enough guests leave. Guests are never told:
 * no guest sees the cap. `{ ok, capacity, going, full, over }`; `bad_capacity` for anything that
 * isn't a whole number from 1 to 100000.
 */
export function setCapacity(ev, capacity) {
  const cap = capacity == null ? null : Number(capacity);
  if (cap != null && !(Number.isInteger(cap) && cap >= 1 && cap <= 100000)) return { ok: false, problem: "bad_capacity" };
  const after = (ev.capacity ?? null) === cap ? ev : db.updateEventRow(ev.id, { capacity: cap });
  return { ok: true, changed: after !== ev, ...capacityState(after) };
}

/** The cap as it stands: how many are in, whether new joins are closed, and by how many it is over. */
export function capacityState(ev) {
  const going = db.joinedCount(ev.id);
  const cap = ev.capacity ?? null;
  // Tickets bought for friends and not claimed yet hold their places (src/eventpay.js seats).
  const held = db.reservedPlaces(ev.id);
  return { capacity: cap, going, ...(held ? { held_for_friends: held } : {}), full: cap != null && going + held >= cap, over: cap != null && going > cap ? going - cap : 0 };
}

/**
 * After a join or a creation: the handle they typed is kept on their profile; with none typed, the
 * one they shared before is carried onto this list; and, for somebody who already had Reason, the
 * note is owed. Returns the row as it now stands.
 */
export function afterJoin({ ev, att, typedInstagram = null, newAccount = false, now = clock.now() }) {
  if (!att) return att;
  const conv = att.conversation_id;
  const typed = instagramHandle(typedInstagram);
  let kind = "ask";
  if (typed) { db.setAccountInstagram(conv, typed); kind = "shown"; }
  else if (att.instagram) kind = "shown";
  else {
    const kept = instagramHandle(db.getAccount(conv)?.instagram);
    if (kept) { att = db.updateAttendeeRow(att.id, { instagram: kept }); kind = "carried"; }
  }
  if (!newAccount && ev.guest_list_visible) db.oweListNote(att.id, kind, now + LIST_NOTE.backstopMs);
  return db.attendeeRow(ev.id, conv) ?? att;
}

/** The organizer's own row on a new event: on their list under their name, same rules as a guest. */
export function afterCreate(ev) {
  const row = db.attendeeRow(ev.id, ev.organizer_conversation_id);
  if (!row || row.role !== "organizer" || !ev.guest_list_visible) return row;
  const name = cleanDisplayName(row.display_name) ?? cleanDisplayName(db.getAccount(ev.organizer_conversation_id)?.name);
  const att = db.updateAttendeeRow(row.id, { in_directory: 1, ...(name ? { display_name: name } : {}) });
  return afterJoin({ ev, att });
}

/**
 * Send the owed note now if it may go. Compare-and-set on the row, so the turn's own send and the
 * sweep can never both send it. `{ state }`: sent | dropped | later | none.
 */
export async function sendListNote({ runtime, eventId, conversationId, now = clock.now() }) {
  const ev = db.getEventRow(eventId);
  const att = ev ? db.attendeeRow(ev.id, conversationId) : null;
  const kind = att?.list_note;
  if (!LIST_NOTE_KINDS.includes(kind)) return { state: "none" };
  const text = ev.status === "cancelled" || (ev.starts_at != null && now > ev.starts_at + LIST_NOTE.staleAfterStartMs) ? null : listNoteText(ev, att, kind);
  // A moot "opened" ask is marked as such, so showing the list again asks them after all (db.unchosenListed).
  if (!text) { db.settleListNote(att.id, kind, kind === "opened" ? "opened_dropped" : "dropped"); return { state: "dropped" }; }
  if (ev.status === "paused" || organizerStopped(ev) || listNoteQuiet(ev, now)) return { state: "later" };
  if (!db.settleListNote(att.id, kind, "sent")) return { state: "none" };
  const message = db.insertEventMessage(ev.id, "list_note", text);
  const r = await deliver({ runtime, message, conversationId });
  if (r.state !== "failed") intoThread({ runtime, conversationId, about: `the who's-going list for ${String(ev.name).slice(0, 80)}`, body: text });
  return { state: "sent", delivery: r.state };
}

/**
 * The note, after whatever turn is running for them now (Runtime.enqueue): so it lands after
 * Reason's "you're in", as the last thing said, and their next text reads as the answer to it.
 */
export function scheduleListNote({ runtime, ev, att }) {
  if (!att?.list_note || !LIST_NOTE_KINDS.includes(att.list_note)) return;
  // With no queue to wait behind, the sweep's backstop sends it instead, minutes later, rather than
  // landing ahead of the reply this note is meant to follow.
  if (typeof runtime?.enqueue !== "function") return;
  const go = () => sendListNote({ runtime, eventId: ev.id, conversationId: att.conversation_id }).catch(() => {});
  Promise.resolve(runtime.enqueue(att.conversation_id, go)).catch(() => {});
}

/** Sweep sends already waiting behind a turn, so a pass every few seconds never piles up copies. */
const queuedNotes = new Set();

/**
 * The sweep's pass: notes held for the morning, or whose send after the join never happened. Each
 * that may go now waits behind whatever turn of theirs is running (Runtime.enqueue), as the first
 * send does, so a slow turn's reply still comes first; at night it is not even queued.
 */
export async function sweepListNotes({ runtime, now = clock.now() }) {
  const out = { sent: 0, dropped: 0, later: 0, queued: 0 };
  for (const row of db.owedListNotes(now)) {
    if (queuedNotes.has(row.id)) { out.queued++; continue; }
    const ev = db.getEventRow(row.event_id);
    if (ev && ev.status === "active" && listNoteQuiet(ev, now)) { out.later++; continue; }
    // Read the clock when it actually goes: a long turn ahead of it may have run past 21:00.
    const go = () => sendListNote({ runtime, eventId: row.event_id, conversationId: row.conversation_id });
    if (typeof runtime?.enqueue !== "function") {
      const r = await go();
      if (out[r.state] != null) out[r.state]++;
      continue;
    }
    queuedNotes.add(row.id);
    out.queued++;
    Promise.resolve(runtime.enqueue(row.conversation_id, go)).catch(() => {}).finally(() => queuedNotes.delete(row.id));
  }
  return out;
}

// ---------- "the organizer added a question": the one text to guests already in (owner decision 2026-11-11) ----------
//
// Adding a question texts nobody by itself. Right after, the organizer is offered one text to the
// guests already in who have not answered it (event_questions ask_guests; the manage page's confirm
// step after adding): their yes covers exactly those words and those guests. Each is owed once, ever
// (event_question_asks), and goes by the list note's rules — not at night in the event's zone, never
// to a guest who muted the event, dropped once it is moot (they answered, left, the question changed
// or went, the event was cancelled). Their answer is read by the model off the thread, never by pattern.

/** The text, or null once it is moot. Plain intent, never a phrase to type. */
export function questionAskText(ev, q, att) {
  if (!ev || ev.status === "cancelled" || !q || !att || att.state !== "joined" || att.muted || att.role === "organizer") return null;
  const who = organizerName(ev);
  const shaped = questions.shape(q);
  const words = shaped.kind === "choice" ? `"${shaped.prompt}" — ${shaped.choices.join(", ")}` : `"${shaped.prompt}"`;
  return `${who ? who : "the organizer"} added a question for everyone going to ${ev.name}: ${words}. `
    + (shaped.required ? "they're asking everyone, so when you get a sec, just text me your answer." : "totally optional — if you'd like to answer, just text me, and i'll pass it on.");
}

/** Who asking would text, and the text, before anything changes. */
export function questionAskPlan(ev, q) {
  const plan = questions.askPlan(ev, q);
  const sample = plan.guests[0] ?? { state: "joined", muted: 0, role: "guest" };
  return { ...plan, body: questionAskText({ ...ev, status: ev.status === "cancelled" ? ev.status : "active" }, q, sample) };
}

/** Owe the text to exactly the guests the plan named, due after the backstop (the sweep sends it). How many are owed. */
export function oweQuestionAsks(ev, q, { now = clock.now() } = {}) {
  const plan = questions.askPlan(ev, q);
  return { asked: db.oweQuestionAsks(ev.id, q, plan.guests, now + LIST_NOTE.backstopMs), names: plan.names, muted_not_asked: plan.muted_not_asked };
}

/** Send one owed ask now if it may go; compare-and-set, so two passes never both send it. `{ state }`: sent | dropped | later | none. */
export async function sendQuestionAsk({ runtime, ask, now = clock.now() }) {
  const row = db.questionAsk(ask.id);
  if (!row || row.state !== "owed") return { state: "none" };
  const ev = db.getEventRow(row.event_id);
  const q = ev ? db.eventQuestion(ev.id, row.question_id) : null;
  const att = ev ? db.attendeeRow(ev.id, row.conversation_id) : null;
  const answered = q && att ? db.answersOf(ev.id, att.id).some(a => a.question_id === q.id) : false;
  const stale = ev?.starts_at != null && now > ev.starts_at + LIST_NOTE.staleAfterStartMs;
  const text = !q || q.version !== row.version || answered || stale ? null : questionAskText(ev, q, att);
  if (!text) { db.settleQuestionAsk(row.id, "dropped"); return { state: "dropped" }; }
  if (ev.status === "paused" || organizerStopped(ev) || listNoteQuiet(ev, now)) return { state: "later" };
  if (!db.settleQuestionAsk(row.id, "sent")) return { state: "none" };
  const message = db.insertEventMessage(ev.id, "question_ask", text);
  const r = await deliver({ runtime, message, conversationId: row.conversation_id });
  if (r.state !== "failed") intoThread({ runtime, conversationId: row.conversation_id, about: `a question the organizer of ${String(ev.name).slice(0, 80)} added for guests`, body: text });
  return { state: "sent", delivery: r.state };
}

const queuedAsks = new Set();
/** The sweep's pass over owed asks, the way list notes go: behind any running turn, not at night. */
export async function sweepQuestionAsks({ runtime, now = clock.now() }) {
  const out = { sent: 0, dropped: 0, later: 0, queued: 0 };
  for (const row of db.owedQuestionAsks(now)) {
    if (queuedAsks.has(row.id)) { out.queued++; continue; }
    const ev = db.getEventRow(row.event_id);
    if (ev && ev.status === "active" && listNoteQuiet(ev, now)) { out.later++; continue; }
    const go = () => sendQuestionAsk({ runtime, ask: row });
    if (typeof runtime?.enqueue !== "function") {
      const r = await go();
      if (out[r.state] != null) out[r.state]++;
      continue;
    }
    queuedAsks.add(row.id);
    out.queued++;
    Promise.resolve(runtime.enqueue(row.conversation_id, go)).catch(() => {}).finally(() => queuedAsks.delete(row.id));
  }
  return out;
}

/**
 * A text Reason sent on its own goes into their thread as the last thing it said, marked as
 * Reason's own, queued behind any running turn and skipped when the thread already ends with it.
 */
export function intoThread({ runtime, conversationId, about, body }) {
  const write = () => {
    const msgs = db.loadConversation(conversationId);
    if (msgs.slice(-6).some(m => m.role === "assistant" && m.content === body)) return;
    db.saveConversation(conversationId, [...msgs,
      { role: "user", content: `[${stamp()}] (nothing from them — Reason texted them on its own, about ${about})` },
      { role: "assistant", content: body }]);
  };
  if (typeof runtime?.enqueue === "function") Promise.resolve(runtime.enqueue(conversationId, async () => write())).catch(() => {});
  else write();
}

// ---------- the web join (src/pages/event.js) ----------

export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The page's join, after the password: a claim, holding what the page collected and the code the
 * guest's own text will carry. Nothing is joined yet — a phone has not been proved.
 */
export function makeClaim({ ev, displayName, instagram = null, inDirectory = false, answers = null, tickets = null, seat = null }) {
  return db.insertEventClaim({ eventId: ev.id, passwordVersion: ev.password_version, displayName, instagram: instagramHandle(instagram), inDirectory, answers, ttlMs: CLAIM_TTL_MS,
    tickets: tickets && tickets > 1 ? tickets : null, seatId: seat?.id ?? null, seatVersion: seat?.version ?? null });
}

/** The text the page's button prefills. Says what it is, with the code a lookup key in it. */
export function claimText(ev, code, { ticket = false } = {}) {
  const c = String(code).toUpperCase();
  return `Hi Reason, I'm ${ticket ? "claiming my ticket to" : "joining"} ${ev.name.slice(0, 60)} with code ${c.slice(0, 4)}-${c.slice(4)}`;
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

/**
 * The organizer's words to every guest, as they go out — now (event_blast) or at the time they chose
 * (src/eventschedule.js): "{name} — from {organizer}:\n{message}".
 */
export function blastBody(ev, message) {
  const who = organizerName(ev);
  return `${ev.name}${who ? ` — from ${who}` : ""}:\n${String(message ?? "").trim()}`;
}

/** A delivery still `pending` this long after its last change never reached the outbox: a crash mid-send. */
export const STUCK_MS = 5 * 60_000;

/** Whether one delivery reached its guest, read off the outbox rows it became. */
export function deliveryState(d, now = clock.now()) {
  if (d.state === "held") return "held";
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
export async function deliver({ runtime, message, conversationId, hold = false }) {
  const d = db.ensureDelivery({ messageId: message.id, eventId: message.event_id, conversationId });
  // Paused from the status page: written down, owed, and sent when the event is resumed.
  if (hold && d.state === "pending") { db.markDelivery(d.id, { state: "held" }); return { delivery: d.id, state: "held" }; }
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

// ---------- who a message is for: everyone, or only some guests (owner request 2026-11-08) ----------
//
// An organizer's own message (a blast, or one they scheduled) can go to only some of their guests:
// the ones they picked by name, or the ones who joined since a time. Which guests the organizer MEANT
// is the model's to read, against the guest list (event_guests), or the organizer's own ticks on the
// page; code only ever sees guest ids and a time. Whatever was picked, the floor is the same as for
// everyone: only joined guests, never one who muted the event (the cancellation is the one thing a
// muted guest still gets, and it always goes to everyone).
//
// The pick is kept as `audience` — null for everyone, `{ guests: [attendee ids] }`, or
// `{ joined_since: ms }` — and written on the message (and the scheduled row) as `audienceKey`'s
// canonical JSON, so a confirm target, a dedupe and a restart all see the same thing.

/** The canonical stored form of an audience: null for everyone. */
export function audienceKey(aud) {
  if (!aud) return null;
  if (Array.isArray(aud.guests)) return JSON.stringify({ guests: [...new Set(aud.guests.map(Number))].filter(Number.isInteger).sort((a, b) => a - b) });
  if (Number.isFinite(aud.joined_since)) return JSON.stringify({ joined_since: Math.floor(aud.joined_since) });
  return null;
}

/** The stored form back as an audience (null for everyone, and for anything that doesn't read). */
export function parseAudience(key) {
  if (!key) return null;
  if (typeof key === "object") return key;
  try {
    const a = JSON.parse(key);
    if (Array.isArray(a?.guests)) return { guests: a.guests.map(Number).filter(Number.isInteger) };
    if (Number.isFinite(a?.joined_since)) return { joined_since: a.joined_since };
  } catch { /* fall through */ }
  // Never "everyone" by accident: a key that no longer reads reaches nobody.
  return { guests: [] };
}

/** When a guest first joined the event: a return after leaving does not move it. */
const firstJoined = (a) => a.first_joined_at ?? a.joined_at;

/** Whether a joined guest is in this audience (muting aside). */
function inAudience(a, aud) {
  if (!aud) return true;
  if (aud.guests) return aud.guests.includes(a.id);
  // First join, so somebody who left and came back is not new (owner decision 2026-11-08).
  if (aud.joined_since != null) return firstJoined(a) >= aud.joined_since;
  return false;
}

/**
 * Who a broadcast of this kind goes to: every joined guest (or, for an organizer's message to only
 * some of them, the joined guests in `audience`), less the muted ones unless it is the cancellation.
 */
export function recipients(ev, kind, audience = null) {
  const aud = kind === "cancel" ? null : parseAudience(audience);
  return db.attendeesOf(ev.id).filter(a => (kind === "cancel" || !a.muted) && inAudience(a, aud));
}

/**
 * How many guests a broadcast of this kind would reach now, and how many it skips as muted. For the
 * organizer's page. With an audience, `muted` counts only the picked guests who muted the event, and
 * `names` is who gets it, as each guest chose to be shown.
 */
export function audience(ev, kind, aud = null) {
  const a = kind === "cancel" ? null : parseAudience(aud);
  const reached = recipients(ev, kind, a);
  const picked = db.attendeesOf(ev.id).filter(x => inAudience(x, a));
  return { guests: reached.length, muted: picked.length - reached.length, names: reached.map(guestName), ids: reached.map(x => x.id) };
}

/** A guest's name as the organizer reads it: what they typed, or a placeholder. Data, not instructions. */
export function guestName(a) {
  return String(a?.display_name ?? "").trim() || "A guest";
}

/**
 * Check an organizer's pick before anything is asked or sent: guest ids that are this event's joined
 * guests, or a join time that reads. `{ ok: true, audience }` (null for everyone), or
 * `{ ok: false, reason }` — both | not_guests (with `ids`) | none_picked | bad_time.
 */
export function pickAudience(ev, { guestIds = null, joinedAfter = null } = {}) {
  const hasIds = Array.isArray(guestIds) && guestIds.length > 0;
  const hasSince = joinedAfter != null && String(joinedAfter).trim() !== "";
  if (hasIds && hasSince) return { ok: false, reason: "both" };
  if (Array.isArray(guestIds) && !guestIds.length && !hasSince) return { ok: false, reason: "none_picked" };
  if (hasIds) {
    const joined = new Set(db.attendeesOf(ev.id).map(a => a.id));
    const ids = [...new Set(guestIds.map(Number))];
    const strangers = ids.filter(id => !joined.has(id));
    if (strangers.length) return { ok: false, reason: "not_guests", ids: strangers };
    return { ok: true, audience: { guests: ids.sort((a, b) => a - b) } };
  }
  if (hasSince) {
    const since = parseStartsAt(joinedAfter, ev.tz);
    if (since == null) return { ok: false, reason: "bad_time" };
    return { ok: true, audience: { joined_since: since } };
  }
  return { ok: true, audience: null };
}

/** Who a message is for, in a few words: "everyone", "3 guests you picked", "guests who joined since Nov 5, 6:00 PM". */
export function audienceLabel(ev, aud) {
  const a = parseAudience(aud);
  if (!a) return "everyone";
  if (a.guests) return `${a.guests.length} ${a.guests.length === 1 ? "guest" : "guests"} you picked`;
  const t = new Date(a.joined_since).toLocaleString("en-US", { timeZone: ev.tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `guests who joined since ${t}`;
}

export async function broadcast({ runtime, ev, kind, body, hold = false, audience = null }) {
  const key = kind === "cancel" ? null : audienceKey(parseAudience(audience));
  // The same words to the same guests of the same event inside a few minutes is one message asked for
  // twice (a turn retried, a tool called again): it reuses the first, whose deliveries are already one
  // per guest.
  const message = db.recentEventMessage(ev.id, kind, body, clock.now() - SAME_MESSAGE_MS, key) ?? db.insertEventMessage(ev.id, kind, body, key);
  const guests = recipients(ev, kind, key);
  const out = { sent: 0, sending: 0, failed: 0, pending: 0, held: 0 };
  for (const g of guests) {
    const r = await deliver({ runtime, message, conversationId: g.conversation_id, hold });
    out[r.state] = (out[r.state] ?? 0) + 1;
  }
  const picked = key ? db.attendeesOf(ev.id).filter(a => inAudience(a, parseAudience(key))).length : db.attendeesOf(ev.id).length;
  return { message_id: message.id, guests: guests.length, skipped_muted: picked - guests.length, ...(key ? { to: audienceLabel(ev, key) } : {}), ...out };
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
  if (rows.some(r => r.state !== "sent" && r.state !== "failed" && r.state !== "skipped")) return { ok: false, reason: "not_settled" };
  const unsent = rows.filter(r => r.state === "failed");
  const body = rows.length > 1 && unsent.length < rows.length ? unsent.map(r => r.body).join("\n\n") : message.body;
  const moved = db.bumpDeliveryAttempt(d.id, d.attempt);
  if (!moved) return { ok: false, reason: "already_retried" };
  const r = await attemptDelivery({ runtime, message, d: moved, body });
  return { ok: true, ...r };
}

/**
 * Send everything held while the event was paused, once each, to whoever is still entitled to it
 * (the same rule a retry follows). Run when the event is resumed.
 */
export async function releaseHeld({ runtime, ev }) {
  const out = { sent: 0, dropped: 0 };
  for (const d of db.deliveriesForEvent(ev.id)) {
    if (d.state !== "held") continue;
    const message = db.eventMessage(d.message_id);
    const att = db.attendeeRow(ev.id, d.conversation_id);
    const entitled = message?.kind === "removed" ? att?.state === "removed" : att?.state === "joined";
    if (!entitled || (ev.status === "cancelled" && message.kind !== "cancel")) { db.markDelivery(d.id, { state: "error", error: "no longer owed" }); out.dropped++; continue; }
    db.markDelivery(d.id, { state: "pending" });
    await attemptDelivery({ runtime, message, d: db.deliveryById(d.id) });
    out.sent++;
  }
  return out;
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

/**
 * What the organizer has sent their guests, newest first, for their own page: the messages that went
 * to everyone (blasts, updates, shared details, the cancellation) with their words and how delivery
 * went. Per-guest texts (welcomes, list notes, a removal) are left out: they were never the
 * organizer's words to everyone. Only for the event's organizer — the caller has checked `managed`.
 */
export const ORGANIZER_MESSAGE_KINDS = new Set(["blast", "update", "release", "cancel", "scheduled", "reminder", "refund"]);
export function sentMessages(ev, { limit = 10 } = {}) {
  const out = [];
  for (const m of db.eventMessages(ev.id, { limit: 200 })) {
    if (!ORGANIZER_MESSAGE_KINDS.has(m.kind)) continue;
    const ds = db.deliveriesFor(m.id).map(d => deliveryState(d));
    const count = (s) => ds.filter(x => x === s).length;
    out.push({ id: m.id, kind: m.kind, body: m.body, at: m.created_at, audience: m.audience ?? null, total: ds.length, sent: count("sent"), sending: count("sending") + count("pending"), held: count("held"), failed: count("failed") });
    if (out.length >= limit) break;
  }
  return out;
}

/** How one event's messages went, per message: for the ops page. */
export function deliveryReport(ev, { limit = 10 } = {}) {
  return db.eventMessages(ev.id, { limit }).map(m => {
    const ds = db.deliveriesFor(m.id).map(d => ({ id: d.id, state: deliveryState(d), attempt: d.attempt }));
    const count = (s) => ds.filter(d => d.state === s).length;
    return { id: m.id, kind: m.kind, at: m.created_at, total: ds.length, sent: count("sent"), sending: count("sending") + count("pending"), held: count("held"), failed: count("failed"), failed_ids: ds.filter(d => d.state === "failed").map(d => d.id) };
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
  if (!String(password ?? "").trim()) return 0;
  const n = scrubPassword(conversationId, password, since);
  for (const ms of [45_000, 5 * 60_000]) {
    const t = setTimeout(() => { try { scrubPassword(conversationId, password, since); } catch { /* best-effort */ } }, ms);
    t?.unref?.();
  }
  return n;
}

// ---------- the status page (src/pages/ops.js) ----------

/**
 * What the owner's status page shows about events: creations and joins this week, wrong passwords
 * today, and per event its state, its joins and failed joins, and whether each message actually
 * reached its guests. Fields named one by one — no row is passed through, so no hash is either.
 */
export function opsSummary({ now = clock.now(), limit = 20 } = {}) {
  const WEEK = 7 * DAY;
  const all = db.allEvents({ limit: 200 });
  // Failed deliveries a retry could still send: to somebody still owed it, on an event not paused.
  const retryable = (ev) => {
    if (ev.status === "paused") return 0;
    let n = 0;
    for (const d of db.deliveriesForEvent(ev.id)) {
      if (deliveryState(d, now) !== "failed") continue;
      const kind = db.eventMessage(d.message_id)?.kind;
      const att = db.attendeeRow(ev.id, d.conversation_id);
      const owed = kind === "removed" ? att?.state === "removed" : att?.state === "joined";
      if (owed && (ev.status !== "cancelled" || kind === "cancel")) n++;
    }
    return n;
  };
  const counted = all.map((ev, i) => ({ ev, i, failing: i < limit || ev.status === "paused" ? null : retryable(ev) }));
  const shown = counted.filter(x => x.i < limit || x.ev.status === "paused" || x.failing > 0);
  return {
    created_7d: all.filter(e => e.created_at >= now - WEEK).length,
    joins_7d: db.joinsSince(now - WEEK),
    failed_joins_24h: db.failedJoinsSince(now - DAY),
    events: shown.map(({ ev, failing }) => {
      const day = db.joinAttemptCounts(ev.id, now - DAY);
      const ever = db.joinAttemptCounts(ev.id, 0);
      return {
        id: ev.id,
        name: ev.name,
        organizer: organizerName(ev) || "someone",
        status: ev.status,
        created_at: ev.created_at,
        going: db.joinedCount(ev.id),
        capacity: ev.capacity ?? null,
        joins_24h: day.ok, failed_joins_24h: day.failed, joins_total: ever.ok, failed_joins_total: ever.failed,
        failed_deliveries: failing ?? retryable(ev),
        messages: deliveryReport(ev, { limit: 5 }),
        link: eventUrl(ev),
      };
    }),
  };
}

/** The owner pauses one event from the status page: joining and blasts stop, pages say so. */
export function pause(eventId) {
  const ev = db.getEventRow(eventId);
  if (!ev || ev.status !== "active") return { ok: false, reason: ev ? ev.status : "not_found" };
  db.updateEventRow(ev.id, { status: "paused", paused_at: clock.now() });
  return { ok: true };
}

/** And resumes it: everything held while it was paused goes out once, to whoever is still owed it. */
export async function resume({ runtime, eventId }) {
  const ev = db.getEventRow(eventId);
  if (!ev || ev.status !== "paused") return { ok: false, reason: ev ? ev.status : "not_found" };
  const after = db.updateEventRow(ev.id, { status: "active", paused_at: null });
  const held = await releaseHeld({ runtime, ev: after });
  return { ok: true, ...held };
}
