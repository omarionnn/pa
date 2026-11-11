// What Reason is doing right now in a turn, as one short line the iPhone app can show under the message
// it is answering (docs/ios-api.md, `progress` on /live; 2026-11-09). Said when a tool starts
// (src/tools.js runToolInner, after the harm screen and the input check), built from that tool and its
// real arguments — "Checking Ulta and Target for CeraVe", "Looking at Thursday's calendar" — never a
// filler. A tool with nothing honest to say says nothing.
//
// Privacy: the line goes to this person's own devices only, and it never carries anyone else's details.
// Any tool whose arguments can name or reach another person — a text or email to someone, a call, a
// contact or memory lookup, a guest list, a calendar entry's title or attendees, a mail or Drive search,
// an address — gets a fixed neutral line for that tool, never its arguments. Free text that does go in
// (a search's words, a store, a product) loses anything shaped like a phone number, an email address or a
// web address, and is cut short.
//
// In-process like the typing event it replaces: nothing is stored, a restart forgets it.
import { EventEmitter } from "node:events";
import { clock, config } from "./config.js";
import * as db from "./db.js";

/** `say` events: { conversationId, handle, tool, text, at } (src/ios/live.js listens). */
export const progressEvents = new EventEmitter();
progressEvents.setMaxListeners(0);

const MAX = 60;

/** Free text safe to show: no phone numbers, emails or web addresses; one line; short. "" when nothing is left. */
export function clean(v, max = 40) {
  let s = String(Array.isArray(v) ? v.filter(x => typeof x === "string").join(", ") : v ?? "");
  s = s.replace(/\S+@\S+/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
    .replace(/["“”`]/g, "").replace(/\s+/g, " ").trim().replace(/[.,;:!?-]+$/, "");
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") || s.slice(0, max);
  return s.trim();
}

// A street address inside free text ("218 Halsey St", "40 west 12th street"): the words are dropped whole.
const ADDRESS = /\b\d{1,6}\s+(?:[\w.'-]+\s+){0,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|pkwy|parkway|hwy|highway|sq|square|cir|circle|apt|suite)\b/i;
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * True when free text names someone this person's Reason knows (`names`: the names it keeps, src/db.js
 * `people`), whole or by a first name of three letters or more, or holds a street address.
 */
export function namesSomeone(text, names = []) {
  const t = ` ${norm(text)} `;
  if (!t.trim()) return false;
  if (ADDRESS.test(String(text))) return true;
  for (const n of names) {
    const k = norm(n);
    if (!k) continue;
    if (t.includes(` ${k} `)) return true;
    const first = k.split(" ")[0];
    if (first.length >= 3 && t.includes(` ${first} `)) return true;
  }
  return false;
}

/** "https://www.ulta.com/p/x" or "ulta.com" → "Ulta"; null when it isn't a site. */
export function siteName(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  let host;
  try { host = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname; } catch { return null; }
  host = host.replace(/^(www|m|shop|store)\./i, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const stem = parts.length > 2 && parts.at(-2).length <= 3 ? parts.at(-3) : parts.at(-2); // bbc.co.uk → bbc
  if (!/^[a-z0-9-]{2,30}$/i.test(stem)) return null;
  return stem.length <= 3 ? stem.toUpperCase() : stem[0].toUpperCase() + stem.slice(1);
}

const joinAnd = (xs) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const dayKey = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** A date argument as a day word in their zone: "today", "tomorrow", "Thursday", "Nov 20"; null when unreadable. */
export function dayWord(v, { now = clock.now(), tz = config.tz } = {}) {
  if (v == null || v === "") return null;
  const s = String(v);
  // A bare date is that day, not midnight UTC (which is the day before in New York).
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T12:00:00Z`) : typeof v === "number" ? v : Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  let zone = tz;
  try { dayKey(0, zone); } catch { zone = "UTC"; }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : dayKey(ms, zone);
  const today = dayKey(now, zone);
  const diff = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  const at = new Date(`${day}T12:00:00Z`);
  if (diff > 1 && diff < 7) return at.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const possessive = (w) => w === "today" || w === "tomorrow" || w === "yesterday" ? `${w}'s` : /^[A-Z][a-z]+day$/.test(w) ? `${w}'s` : null;

/** Sent to the person themselves (no `to`, or "owner"/"me"): the message is the reply, nothing to narrate. */
const toThem = (to) => to == null || /^(owner|me|self|you|)$/i.test(String(to).trim());

/**
 * Tools whose arguments can carry someone else's details: the line is fixed, never built from the input.
 * A tool listed with null says nothing (the thing itself shows up on its own).
 */
export const NEUTRAL = {
  gmail_search: "Going through your email", gmail_read: "Reading the email", gmail_attachment: "Opening the attachment",
  gmail_draft: "Drafting the email", gmail_send: "Sending the email",
  drive_search: "Looking through your Drive", drive_read: "Reading the file", drive_send: "Getting the file ready",
  calendar_event: "Checking the event", calendar_create: "Adding it to your calendar", calendar_change: "Updating your calendar",
  calendar_delete: "Updating your calendar", apple_calendar_event: "Checking the event", apple_calendar_create: "Adding it to your calendar",
  apple_calendar_change: "Updating your calendar", apple_calendar_delete: "Updating your calendar",
  call_place: "Getting the call ready", call_errand_start: "Setting up the call", call_status: "Checking on the call", call_errand_status: "Checking on the call",
  recall: "Checking what I know", memory_search: "Checking what I know", graph_lookup: "Checking what I know",
  get_location: "Checking where you are", directions: "Working out the route",
  uber_options: "Checking ride prices", uber_request: "Booking the ride", uber_ride: "Checking on the ride",
  purchase: "Placing the order", purchase_confirm: "Placing the order", purchase_track: "Checking on the order",
  shop_pay: "Getting the payment ready", shop_status: "Checking on the checkout",
  event_guests: "Checking the guest list", event_blast: "Messaging the guests", event_guest_remove: "Updating the guest list",
  x_dm: "Writing the message", x_dm_list: "Checking your messages on X", x_mentions: "Checking your mentions on X",
  timer_set: "Setting the reminder", image_generate: "Making the picture", photo_look: "Looking at the photo",
  video_understand: "Watching the video", meal_estimate: "Working out the nutrition", subscriptions_scan: "Looking through your subscriptions",
  flight_book: "Booking the flight", flight_checkin_start: "Checking you in", boarding_pass: "Getting your boarding pass",
  browser_read: "Reading the page", browser_click: "Working through the page", browser_type: "Filling in the page",
  browser_submit: "Submitting the form", browser_screenshot: "Looking at the page",
  deal_watch_set: "Setting up the price watch", watch_set: "Setting up the watch",
};

/** The line for one tool call, or null when it has nothing honest to say. Never throws. */
export function phraseFor(name, input = {}, opts = {}) {
  try {
    const p = phrase(String(name ?? ""), input && typeof input === "object" ? input : {}, opts);
    if (!p) return null;
    const line = p.replace(/\s+/g, " ").trim();
    return line.length > MAX ? line.slice(0, MAX).replace(/\s+\S*$/, "").replace(/[\s,;:.-]+(?:and|for|to|from|at|in|on|of|the)?$/i, "").trim() : line; // the contract: no trailing ellipsis
  } catch { return null; }
}

function phrase(name, i, opts) {
  // Words to someone: to them it's the reply itself; to anybody else, nothing about who or what.
  if (name === "message_send") return toThem(i.to) ? null : "Writing the message";
  if (name === "voice_note_send" || name === "voice_note_say") return toThem(i.to) ? null : "Sending the voice note";
  if (name === "send_picture") return toThem(i.to) ? null : "Sending the picture";
  if (Object.hasOwn(NEUTRAL, name)) return NEUTRAL[name];

  // Free text that goes in, unless it names someone they know or an address: then null, and the step gets
  // its plain line instead ("Searching the web"), never the words.
  const free = (v, max) => { const s = clean(v, max); return s && namesSomeone(s, opts.names) ? null : s; };
  switch (name) {
    case "web_search": {
      const q = free(i.query);
      const sites = [...new Set((Array.isArray(i.sites) ? i.sites : []).map(siteName).filter(Boolean))].slice(0, 3);
      if (sites.length && q) return `Checking ${joinAnd(sites)} for ${q}`;
      if (sites.length) return `Checking ${joinAnd(sites)}`;
      return q ? `Searching for ${q}` : q === null ? "Searching the web" : null;
    }
    case "research": { const q = free(i.question ?? i.queries?.[0], 45); return q ? `Looking into ${q}` : "Looking into it"; }
    case "find_all": { const q = free(i.objective, 45); return q ? `Finding ${q}` : q === null ? "Searching the web" : null; }
    case "web_lookup": case "browser_open": { const s = siteName(i.url); return s ? `Reading ${s}` : "Reading the page"; }
    case "offer_check": { const s = siteName(i.url); return s ? `Checking the price on ${s}` : "Checking the price"; }
    case "store_checkout": {
      const store = free(i.store, 25) || siteName(i.start_url), item = free(i.item ?? i.what, 30);
      if (store && item) return `Checking out ${item} at ${store}`;
      return store ? `Checking out at ${store}` : "Working on the checkout";
    }
    case "show_choices": return "Putting the options together";
    case "image_search": { const q = free(Array.isArray(i.queries) ? i.queries[0] : i.queries, 35); return q ? `Finding pictures of ${q}` : "Finding pictures"; }
    case "calendar_events": case "apple_calendar_events": {
      const from = dayWord(i.from, opts), to = dayWord(i.to, opts);
      const one = from && (!to || to === from || isNextDayEnd(i.from, i.to));
      const pos = one ? possessive(from) : null;
      if (pos) return `Looking at ${pos} calendar`;
      if (one) return `Looking at your calendar for ${from}`;
      if (from && to) return `Looking at your calendar, ${from} to ${to}`;
      return "Looking at your calendar";
    }
    case "flight_search": case "flight_dates": {
      const o = free(i.origin, 20), d = free(i.destination, 20);
      const when = dayWord(i.depart_date ?? i.from_date, opts);
      const route = o && d ? ` from ${o} to ${d}` : d ? ` to ${d}` : "";
      if (name === "flight_dates") return `Comparing dates for flights${route}`;
      return `Searching flights${route}${when ? (possessive(when) || /day$/.test(when) ? ` for ${when}` : ` on ${when}`) : ""}`;
    }
    case "flight_list": return "Checking your flights";
    case "weather": { const p = free(i.place, 30); return p ? `Checking the weather in ${p}` : "Checking the weather"; }
    case "nearby_places": { const w = free(i.cuisine || i.type || i.name, 30); return w ? `Looking for ${w} nearby` : "Looking at what's nearby"; }
    case "transit_status": { const l = free(i.lines, 25); return l ? `Checking the ${l} line` : "Checking the trains"; }
    case "spotify_search": { const q = free(i.query); return q ? `Searching Spotify for ${q}` : "Searching Spotify"; }
    case "spotify_control": case "spotify_queue": return "Changing what's playing";
    case "spotify_now_playing": return "Checking what's playing";
    case "spotify_playlist_create": case "spotify_playlist_add": return "Working on the playlist";
    case "x_search": { const q = free(i.query); return q ? `Searching X for ${q}` : "Searching X"; }
    case "x_post": case "x_reply": return "Posting to X";
    case "x_timeline": return "Reading your timeline on X";
    case "github_issues": case "github_pulls": { const r = free(i.repo, 30); return r ? `Checking ${r} on GitHub` : "Checking GitHub"; }
    case "github_code_search": case "github_file_read": return "Reading the code";
    case "page_create": case "document_create": { const t = free(i.title, 35); return t ? `Writing up ${t}` : "Writing it up"; }
    case "event_create": { const n = free(i.name, 35); return n ? `Setting up ${n}` : "Setting up the event"; }
    case "event_update": case "event_settings": return "Updating the event";
    case "flight_save": return "Saving the flight";
    case "spend_today": case "purchases_recent": return "Checking your spending";
    default: return null;
  }
}

/** A `to` that is just the end of the `from` day (a day's window, given as two instants). */
function isNextDayEnd(from, to) {
  const a = Date.parse(String(from ?? "")), b = Date.parse(String(to ?? ""));
  return Number.isFinite(a) && Number.isFinite(b) && b > a && b - a <= 86_400_000;
}

/**
 * Say the line for a tool that is starting inside `turn` (src/turnlink.js). Only inside an open turn: work
 * outside one (a reminder, a sweep) answers nobody and narrates nothing. The same line twice in a row in one
 * turn is said once. Never throws.
 */
export function say(turn, name, input, { answering = null, at = clock.now(), namesOf = db.knownNamesOf } = {}) {
  try {
    if (!turn?.open || !turn.conversationId) return null;
    // Nobody listening (no iPhone app stream open: REASON_IOS_API off, or the app closed): no work at all.
    if (!progressEvents.listenerCount("say")) return null;
    if (!turn.names) { try { turn.names = namesOf(turn.conversationId); } catch { turn.names = []; } }
    const text = phraseFor(name, input, { names: turn.names });
    if (!text || text === turn.said) return null;
    turn.said = text;
    const event = { conversationId: turn.conversationId, handle: answering, tool: String(name), text, at };
    progressEvents.emit("say", event);
    return event;
  } catch { return null; }
}
