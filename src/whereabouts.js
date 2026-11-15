// Where a place-dependent answer came from, said on the tool's result (2026-11-14).
//
// On a call a person asked for the weather "where I'm at" and was given it for their work address,
// never told that was assumed; later a "nearest store" was answered from work after their shift had
// ended. Only when they asked "where do you think I am?" did Reason say it didn't know and send the
// Share My Location card. The tools already had what they needed to say so: no live share and no
// recent pin, and the coordinates were a saved place's.
//
// So weather, nearby_places and directions put one note on their result (`whereNote`) when the
// position they were given is a saved place (or nothing they shared) and there is no fresh location:
//   - by text: say in the first sentence which place was assumed and why, and send the card in the
//     same reply (get_location action 'request'); or, when their schedule says they are probably not
//     there (off shift, so not at work), ask in one short line instead, with the card.
//   - on a call: say the assumption in a few words; no card can be shown mid-call, so the text after
//     the call (src/calls/postcall.js ownerEvent) sends it if the answer depended on where they are.
// Nothing here changes who can see a location or how long it is kept, and nothing invents one.
import * as db from "./db.js";
import { clock } from "./config.js";
import { zoneFor } from "./zone.js";

/** A pin they sent counts as where they are for this long — get_location's own rule (src/tools.js). */
export const RECENT_PIN_MIN = 24 * 60;
/** Coordinates this close to a saved place are that place. */
const SAME_PLACE_M = 400;

/** Is there a fresh position for them: a live share still running, or a pin sent within RECENT_PIN_MIN? */
export function knownNow(conversationId, now = clock.now()) {
  try {
    const until = Number(db.getThread(conversationId)?.location_sharing_until);
    if (Number.isFinite(until) && until > now) return true;
    const last = db.lastSharedLocation(conversationId);
    return !!last && (now - Number(last.at)) / 60_000 <= RECENT_PIN_MIN;
  } catch { return false; }
}

function metres(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180, R = 6_371_000;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The saved place these are: by name, else the saved place within SAME_PLACE_M of the coordinates. */
export function savedPlaceAt(conversationId, { latitude, longitude, place } = {}) {
  try {
    if (place) { const p = db.getPlace(conversationId, place); if (p) return p; }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    let best = null;
    for (const p of db.listPlaces(conversationId)) {
      if (p.lat == null || p.lng == null) continue;
      const d = metres(latitude, longitude, Number(p.lat), Number(p.lng));
      if (d <= SAME_PLACE_M && (!best || d < best.d)) best = { p, d };
    }
    return best?.p ?? null;
  } catch { return null; }
}

const WORKISH = /\b(?:work|job|office|shift|workplace)\b/i;
const HOMEISH = /\b(?:home|house|apartment|apt|flat)\b/i;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const SHIFT = new RegExp(String.raw`\b(?:work(?:s|ing)?|shifts?|job)\b[^.\n]{0,60}?\b${TIME}\s*(?:-|–|—|to|until|till)\s*${TIME}`, "i");

/**
 * Their working hours, as a saved fact states them ("works at the depot Mon–Fri 7am to 3pm", "shift
 * is 9-5"): { from, to } in minutes after midnight, `weekdays` when the fact says Monday to Friday,
 * and the words it came from. null when no fact says one. Only the hours ever reach a model.
 */
export function shiftOf(conversationId) {
  let facts = [];
  try { facts = db.activeFacts(conversationId, { limit: 200 }); } catch { return null; }
  for (const f of facts) {
    const text = String(f.fact ?? "");
    const m = SHIFT.exec(text);
    if (!m) continue;
    const mins = (h, mm, ap) => {
      let x = Number(h) % 12 + (/^p/i.test(ap ?? "") ? 12 : 0);
      if (!ap && Number(h) === 12) x = 12;
      return x * 60 + Number(mm ?? 0);
    };
    // "7 to 3pm": a start with no am/pm later on the clock than the end is the other half of the day.
    const fromAp = m[3] ?? (m[6] ? (Number(m[1]) % 12 > Number(m[4]) % 12 ? (/^p/i.test(m[6]) ? "am" : "pm") : m[6]) : undefined);
    const from = mins(m[1], m[2], fromAp);
    let to = mins(m[4], m[5], m[6]);
    // "9-5": no am/pm, and the end before the start is the afternoon.
    if (!m[3] && !m[6] && to <= from) to += 12 * 60;
    if (to > 24 * 60) to -= 24 * 60;
    const weekdays = /\b(?:mon(?:day)?\s*(?:-|–|to|through|thru)\s*fri(?:day)?|weekdays)\b/i.test(text);
    return { from, to, weekdays, words: `${m[0].slice(m[0].search(/\d/)).trim()}${weekdays ? " on weekdays" : ""}` };
  }
  return null;
}

/** Their local clock now: minutes after midnight, the weekday, and how to say the time. */
function localNow(conversationId, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zoneFor(conversationId), hour: "numeric", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const h = Number(parts.hour) % 24, m = Number(parts.minute);
  return { mins: h * 60 + m, day: DAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase()), said: `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}` };
}

/** On shift right now by the shift they told you? true / false, or null when unknown. */
function onShift(shift, local) {
  if (!shift) return null;
  if (shift.weekdays && (local.day === 0 || local.day === 6)) return false;
  return shift.from <= shift.to ? local.mins >= shift.from && local.mins < shift.to : local.mins >= shift.from || local.mins < shift.to;
}

// What a call assumed, for the text after it (src/calls/postcall.js). In memory: a restart between the
// call and its after-call note loses one line, never a location.
const ASSUMED_ON_CALL = new Map();
/** The saved place a call's answer went by, or "". */
export function assumedOnCall(callId) { return ASSUMED_ON_CALL.get(String(callId)) ?? ""; }

/**
 * The note a place-dependent tool result carries, or "" (a fresh position, or nothing to say).
 * `at`: the coordinates or saved place name the tool was given. `onCall`: the call id when on a call.
 */
export function whereNote(conversationId, at = {}, { onCall = null, now = clock.now() } = {}) {
  if (!conversationId || knownNow(conversationId, now)) return "";
  const given = at.place || (Number.isFinite(at.latitude) && Number.isFinite(at.longitude));
  if (!given) return "";
  const p = savedPlaceAt(conversationId, at);
  // A place they named that is not a saved one ("from 5th and Main") is their word, not a guess.
  if (!p && at.place) return "";
  const ifHere = "Only if what they asked depends on where they are now (\"near me\", \"where I'm at\", \"closest\", the weather \"here\")";
  if (!p) {
    return `${ifHere}: these coordinates are not a position they shared or a place they saved, and there is no live or recent location for them.`
      + ` Do not answer as if they were where they are; ${onCall ? "ask them in a few words where they are" : "ask in one short line where they are, and call get_location with action 'request' in this same turn so the Share My Location card goes with it"}. Never guess coordinates.`;
  }
  const name = String(p.name ?? "a saved place");
  const local = localNow(conversationId, now);
  const shift = WORKISH.test(name) || HOMEISH.test(name) ? shiftOf(conversationId) : null;
  const on = onShift(shift, local);
  const unlikely = (WORKISH.test(name) && on === false) || (HOMEISH.test(name) && on === true);
  const why = `there is no live or recent location for them, and this is their saved place "${name}"`;
  if (unlikely) {
    const reason = `their ${WORKISH.test(name) ? "shift" : "work hours"}, as they told you, ${shift.words}, and it is ${local.said} there now, so they are probably not at "${name}"`;
    // Asked out loud on a call: nothing was assumed, so the text after it owes no card for this.
    if (onCall) return `${ifHere}: ${why} — but ${reason}. Do not answer from it: ask them in a few words where they are.`;
    return `${ifHere}: ${why} — but ${reason}. Do not answer from it: ask in one short line where they are, and call get_location with action 'request' in this same turn so the Share My Location card goes with that line.`;
  }
  if (onCall) {
    ASSUMED_ON_CALL.set(String(onCall), name);
    if (ASSUMED_ON_CALL.size > 200) ASSUMED_ON_CALL.delete(ASSUMED_ON_CALL.keys().next().value);
    return `${ifHere}: ${why}. Say the assumption in a few words as you answer ("going by your ${name.toLowerCase()} address…"), so a wrong guess costs them one word. No card can be shown on a call.`;
  }
  return `${ifHere}: ${why}. Say in your first sentence that you went by "${name}" and why ("going by your ${name.toLowerCase()} address, since I don't have your location"), and call get_location with action 'request' in this same turn so the Share My Location card goes with your reply.`;
}
