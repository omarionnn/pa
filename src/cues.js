// "i'm flying to miami on the 20th." — and then the thing a good friend would think of next.
//
// Owner, 2026-11-11: when something in somebody's life comes up — a trip, a move, a birthday, an
// interview, a guest — Reason should think one step ahead the way a friend does. Not a menu of what
// it can do. ONE offer, in the reply they are already reading, and then the rest at the moment each
// one is useful: the ride the evening before the flight, the check-in reminder a day out.
//
// The split is the one the rest of Reason is built on (src/notice.js, src/goals.js):
//
//   The MODEL's half. Hearing the cue at all — there is no word list over anything anybody said in
//   this file or near it; `cue_note` is where the model's read gets written down, with their own
//   sentence on the row. Which ONE of the offers open right now suits the moment, or none. The words.
//
//   CODE's half, and none of it is asked of the model:
//     WHAT MAY BE OFFERED   only offers whose tools this person really has (`availability`). A feature
//                           that is off for them is never offered. An account they have not connected
//                           is offered as a connect at most once, ever, and only in a reply.
//     HOW MANY, AND WHEN    one offer in the reply (`offer` refuses a second while the first is
//                           unanswered). Everything else is a ROW with a moment (`plan`), and it goes
//                           out through the unprompted path that already exists: a `notice_seen` row
//                           on a one-off timer, said only through `notice_send`. So the daily budget,
//                           the hard cap, quiet hours, digest, snooze, "off", the daily proactive
//                           ceiling and one-nudge-per-thing all apply with no second copy of any of
//                           them here. Every offer of one cue shares one `thing`, so a cue whose last
//                           offer went unanswered sends nothing more until they speak.
//     A NO IS A NO          an offer turned down is never made again for that cue; "never" mutes that
//                           offer for them on every later cue. Two noes on one cue drop what is left.
//     IT ENDS               when its date passes, when they say it is off, or — with no date — after
//                           a few weeks. Checked when a cue is read and again at the moment a held
//                           offer comes due (`recheck`).
//     THEY CAN TURN IT OFF  by text (`cues_setting`) or in Settings. Off deletes what was held.
//     NOTHING SENSITIVE     the kinds are a closed list (CUES), and a cue that rests on their health,
//                           money trouble, a relationship, a loss or anything legal is refused.
//
// The cues and their offers are DATA (CUES below). Adding "a wedding" or "a new baby" is an entry in
// that object; no code here names a kind.
//
// Behind REASON_CUES (off | owner | on), off by default. Off: the tools are not shown to anybody's
// model and are refused if named, nothing is noted, and a held offer that comes due is let go.
import { z } from "zod";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import * as notice from "./notice.js";
import * as trust from "./trust.js";
import { atLocal } from "./series.js";
import { clock, config, stamp } from "./config.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The notice kind a held offer travels as (src/notice.js recheck / momentFrame hand these back here). */
export const NOTICE_KIND = "cue_offer";
export const MINE = new Set([NOTICE_KIND]);
/** The label on the one-off timer that carries a held offer to its moment. */
export const LABEL = "cue:offer";

// ---------- the catalogue ----------
//
// One entry per cue. `hear` is for the model (what counts), never matched against anything.
// `facts` are the few things about the cue an offer can depend on, each a closed list the model
// picks from. Every offer:
//
//   what    what Reason would do, as the model is told it
//   tools   groups of tool names; the person needs at least one tool of EVERY group (visible to them
//           right now, src/tools.js toolsFor). [] means nothing special is needed.
//   connect an account the offer needs connected ("uber", "google"); not connected = a connect offer,
//           once, in a reply only
//   only    facts the cue must have for the offer to make sense ({ mode: ["flight"] })
//   now     may be the one offer made in the reply that hears the cue
//   when    its moment when held: { days_before, hour } on their clock, { hours_before } (needs a
//           real time, not just a date), or { days_after_noticed, hour }
//
// Offers are in priority order: when a cue holds more than `holdAtMost`, the first ones win.
export const CUES = {
  trip: {
    what: "a trip: they are flying, taking a train or driving somewhere away from home",
    hear: `"i'm flying to miami on the 20th", "taking the train up to boston friday", "driving to my parents for thanksgiving"`,
    facts: { mode: ["flight", "train", "drive", "other"] },
    undatedDays: 30,
    offers: [
      { key: "stay", what: "find them a place to stay there: a short list to pick from", tools: [["web_search", "research", "browser_open"]], now: true, when: { days_after_noticed: 2, hour: 11 } },
      { key: "checkin", what: "a reminder when check-in opens, 24 hours before the flight", tools: [["timer_set"]], only: { mode: ["flight"] }, now: true, when: { hours_before: 24 } },
      { key: "ride", what: "a ride to the airport or the station", tools: [["uber_request"]], connect: "uber", only: { mode: ["flight", "train"] }, when: { days_before: 1, hour: 18 } },
      { key: "weather", what: "the weather where they are going and what that means for packing", tools: [["weather", "web_search"]], when: { days_before: 2, hour: 18 } },
      { key: "table", what: "book a table for their first night there", tools: [["call_place"]], when: { days_before: 3, hour: 12 } },
    ],
  },
  move: {
    what: "a move: they are moving home",
    hear: `"we're moving to austin in january", "i move into the new place on the 1st"`,
    facts: {},
    undatedDays: 45,
    offers: [
      { key: "address_list", what: "a checklist of everywhere their address needs changing (bank, mail forwarding, licence, subscriptions)", tools: [], now: true, when: { days_after_noticed: 2, hour: 11 } },
      { key: "movers", what: "look up a few movers they could get quotes from", tools: [["web_search", "research", "nearby_places"]], now: true, when: { days_before: 21, hour: 11 } },
      { key: "utilities", what: "reminders to move the utilities and internet over before the day", tools: [["timer_set"]], when: { days_before: 10, hour: 10 } },
    ],
  },
  birthday: {
    what: "a birthday coming up: theirs, or somebody's they care about",
    hear: `"my mom's birthday is the 3rd", "it's my birthday next saturday", "dana turns 30 in two weeks"`,
    facts: { whose: ["theirs", "someone_else"] },
    undatedDays: 30,
    offers: [
      { key: "reminder", what: "a reminder a few days before, so it does not sneak up on them", tools: [["timer_set"]], only: { whose: ["someone_else"] }, now: true, when: { days_before: 7, hour: 10 } },
      { key: "gift", what: "a gift idea or two, and ordering it if they like one", tools: [["store_checkout", "purchase"]], only: { whose: ["someone_else"] }, now: true, when: { days_before: 10, hour: 12 } },
      { key: "table", what: "book a table for a birthday dinner", tools: [["call_place"]], now: true, when: { days_before: 5, hour: 12 } },
      { key: "event_page", what: "an event page people can RSVP on, if there is a party", tools: [["event_create"]], now: true, when: { days_before: 14, hour: 12 } },
    ],
  },
  interview: {
    what: "a job interview they have coming up",
    hear: `"i have an interview at stripe on thursday at 2", "second round with them next week"`,
    facts: { where: ["in_person", "remote", "unknown"] },
    undatedDays: 21,
    offers: [
      { key: "calendar_hold", what: "put a hold on their calendar for it", tools: [["calendar_create"]], connect: "google", now: true, when: { days_after_noticed: 1, hour: 10 } },
      { key: "prep", what: "a reminder the evening before to prep", tools: [["timer_set"]], now: true, when: { days_before: 1, hour: 18 } },
      { key: "directions", what: "directions and the time to leave by", tools: [["directions"]], only: { where: ["in_person"] }, when: { hours_before: 3 } },
    ],
  },
  guest: {
    what: "a guest coming to stay with them or visit",
    hear: `"my sister's visiting next weekend", "my parents fly in on the 12th"`,
    facts: {},
    undatedDays: 30,
    offers: [
      { key: "plan", what: "a loose plan for the days they are here", tools: [["plan_create", "page_create", "web_search"]], now: true, when: { days_before: 4, hour: 12 } },
      { key: "table", what: "book a table for one of the nights", tools: [["call_place"]], now: true, when: { days_before: 3, hour: 12 } },
      { key: "pickup", what: "a reminder of when to leave to pick them up", tools: [["timer_set"]], when: { days_before: 1, hour: 18 } },
    ],
  },
};

/** How many of one cue's offers are ever held for later. The rest are only ever said in the reply. */
const holdAtMost = (kind) => Number(CUES[kind]?.holdAtMost ?? 3);
/** How many cues one person may have open at once. */
const openCap = () => Number(process.env.REASON_CUES_MAX_OPEN ?? 5);
/** Noes on one cue before whatever is still held for it is let go. */
const NOES_END_IT = 2;

/** What the model must never build a cue on. Said in the tool, and enforced by `sensitive` in note(). */
export const SENSITIVE_RULE = "Never when it rests on their health or somebody's (a hospital, a procedure, a diagnosis), money trouble,"
  + " a relationship starting, ending or going badly, a death or a funeral, or anything legal. Answer those like a person"
  + " would and write nothing down here.";

// ---------- the switch ----------

export function mode() {
  const v = String(process.env.REASON_CUES ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

/** Does the switch reach this conversation at all (whatever they themselves chose)? */
export function covers(conversationId) {
  if (!conversationId) return false;
  const m = mode();
  if (m === "off") return false;
  return m === "on" || accounts.featureOwner(conversationId);
}

// ---------- the rows ----------

db.db.exec(`
  -- Something coming up in their life that they SAID, in their words ('said'). See src/cues.js.
  CREATE TABLE IF NOT EXISTS cues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    what TEXT NOT NULL,
    key TEXT NOT NULL,
    said TEXT NOT NULL,
    facts TEXT NOT NULL DEFAULT '{}',
    starts_at INTEGER,
    time_known INTEGER NOT NULL DEFAULT 0,
    ends_at INTEGER,
    heard_on TEXT NOT NULL DEFAULT 'text',
    -- open | ended
    state TEXT NOT NULL DEFAULT 'open',
    ended_why TEXT,
    -- 'date' (it passed, or went stale with no date) | 'them' (they said so)
    ended_by TEXT,
    ended_said TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE(conversation_id, kind, key)
  );
  CREATE INDEX IF NOT EXISTS cues_thread ON cues (conversation_id, state);

  -- One offer a cue sets up. 'state': held (a moment, a notice row and a timer) | waiting (no date yet)
  -- | reply_only (may only be said in a reply; never scheduled) | offered | accepted | declined
  -- | skipped | dropped.
  CREATE TABLE IF NOT EXISTS cue_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cue_id INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    offer TEXT NOT NULL,
    state TEXT NOT NULL,
    why TEXT,
    needs_connect TEXT,
    moment_at INTEGER,
    notice_id INTEGER,
    timer_id INTEGER,
    line TEXT,
    offered_at INTEGER,
    unprompted INTEGER NOT NULL DEFAULT 0,
    answer_said TEXT,
    answered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(cue_id, offer)
  );
  CREATE INDEX IF NOT EXISTS cue_offers_thread ON cue_offers (conversation_id, state);

  -- Their own switch, in their words. No row means on.
  CREATE TABLE IF NOT EXISTS cue_prefs (
    conversation_id TEXT PRIMARY KEY,
    off INTEGER NOT NULL DEFAULT 0,
    said TEXT,
    via TEXT,
    set_at INTEGER NOT NULL
  );

  -- An offer they never want ('kind' + 'offer'), and a connect already offered once ('connect' + provider).
  CREATE TABLE IF NOT EXISTS cue_mutes (
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    offer TEXT NOT NULL,
    said TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, kind, offer)
  );
`);
const q = (sql) => db.db.prepare(sql);

const cueById = (conversationId, id) => q("SELECT * FROM cues WHERE conversation_id = ? AND id = ?").get(conversationId, Number(id)) ?? null;
/** A cue's offers. Takes the cue row, so every read names whose it is. */
const offersOf = (cue) => q("SELECT * FROM cue_offers WHERE conversation_id = ? AND cue_id = ? ORDER BY id").all(cue.conversation_id, cue.id);
const offerRow = (cue, offer) => q("SELECT * FROM cue_offers WHERE conversation_id = ? AND cue_id = ? AND offer = ?").get(cue.conversation_id, cue.id, String(offer)) ?? null;
export const openCues = (conversationId) => q("SELECT * FROM cues WHERE conversation_id = ? AND state = 'open' ORDER BY COALESCE(starts_at, created_at)").all(conversationId);
export const listCues = (conversationId) => q("SELECT * FROM cues WHERE conversation_id = ? ORDER BY id").all(conversationId);
export const listOffers = (conversationId) => q("SELECT * FROM cue_offers WHERE conversation_id = ? ORDER BY id").all(conversationId);
const muted = (conversationId, kind, offer) => !!q("SELECT 1 FROM cue_mutes WHERE conversation_id = ? AND kind = ? AND offer = ?").get(conversationId, kind, offer);
const mute = (conversationId, kind, offer, said, at) => q("INSERT OR IGNORE INTO cue_mutes (conversation_id, kind, offer, said, at) VALUES (?, ?, ?, ?, ?)").run(conversationId, kind, offer, said || null, at);

function setOffer(o, cols, now = clock.now()) {
  const all = { ...cols, updated_at: now };
  const keys = Object.keys(all);
  q(`UPDATE cue_offers SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE conversation_id = ? AND id = ?`).run(...keys.map(k => all[k]), o.conversation_id, o.id);
}

const factsOf = (cue) => { try { const f = JSON.parse(cue?.facts || "{}"); return f && typeof f === "object" && !Array.isArray(f) ? f : {}; } catch { return {}; } };
const cueKey = (what) => String(what ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
const specOf = (kind, offer) => CUES[kind]?.offers.find(o => o.key === offer) ?? null;

// ---------- their own switch ----------

/** Have they turned cues off for themselves? */
export function optedOut(conversationId) {
  return !!q("SELECT off FROM cue_prefs WHERE conversation_id = ?").get(conversationId)?.off;
}

/** The switch reaches them AND they have not turned it off. Everything that notes or offers asks this. */
export function active(conversationId) {
  return covers(conversationId) && !optedOut(conversationId);
}

/**
 * Their yes or no to the whole thing, from a text (`said`, their words) or the Settings page (`via`
 * "settings"). Off deletes what was held: keeping the rows and merely not adding more would leave
 * the thing they said no to still knowing about their trip.
 */
export function setOn({ conversationId, on, said = "", via = "text", now = clock.now() }) {
  const verbatim = String(said ?? "").trim();
  if (via === "text" && !verbatim) {
    return { ok: false, error: "Say what they actually said, word for word, in `said`. This is only ever set from their own answer." };
  }
  q(`INSERT INTO cue_prefs (conversation_id, off, said, via, set_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET off = excluded.off, said = excluded.said, via = excluded.via, set_at = excluded.set_at`)
    .run(conversationId, on ? 0 : 1, verbatim || null, via, now);
  let deleted = 0;
  if (!on) {
    for (const o of listOffers(conversationId)) letGo(o, "they turned this off", now);
    deleted = Number(q("DELETE FROM cues WHERE conversation_id = ?").run(conversationId).changes);
    q("DELETE FROM cue_offers WHERE conversation_id = ?").run(conversationId);
  }
  return {
    ok: true, cues: on ? "on" : "off", ...(deleted ? { deleted } : {}),
    say: on
      ? "One short line: you will think a step ahead again when something comes up, one offer at a time."
      : "One short line confirming it, plainly: you will stop offering things when a trip or a birthday comes up, and what you were holding is gone. Do not talk them out of it. Anything they ASK for you still do.",
  };
}

// ---------- what this person can really get ----------

/**
 * What the availability check reads: the tools this person's model may be shown right now, and
 * which accounts they have connected. Built lazily because src/tools.js imports this file.
 */
export async function envFor(conversationId) {
  const { toolsFor } = await import("./tools.js");
  return {
    tools: new Set(toolsFor(conversationId).map(t => t.name)),
    connected: (provider) => db.listOauthTokens(conversationId, provider).length > 0,
  };
}

/**
 * Can this person get this offer? "ok", "connect" (the feature is theirs but the account is not
 * connected), or "no". Pure: `env` is { tools: Set, connected(provider) }.
 */
export function availability(spec, env) {
  if (!spec) return "no";
  for (const group of spec.tools ?? []) {
    if (!group.some(name => env.tools.has(name))) return "no";
  }
  if (spec.connect && !env.connected(spec.connect)) return "connect";
  return "ok";
}

/** Does the offer make sense for this cue's facts? An `only` fact the cue does not have yet is a no. */
function fits(spec, facts) {
  for (const [name, allowed] of Object.entries(spec.only ?? {})) {
    if (!allowed.includes(facts[name])) return false;
  }
  return true;
}

// ---------- time ----------

const tzOf = (conversationId) => notice.settingsFor(conversationId).timeZone || config.tz;

/**
 * A date or a date and time they named, as a real instant on THEIR clock. A bare date is the day
 * (noon, `timeKnown` false); a time with no offset is read in their zone. Format only: nothing here
 * reads a sentence.
 */
export function parseWhen(value, timeZone) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, off] = m;
  if (h == null) return { at: atLocal({ year: +y, month: +mo, day: +d, hour: 12 }, timeZone), timeKnown: false };
  if (off) { const at = Date.parse(s.replace(" ", "T")); return Number.isFinite(at) ? { at, timeKnown: true } : null; }
  return { at: atLocal({ year: +y, month: +mo, day: +d, hour: +h, minute: +mi }, timeZone), timeKnown: true };
}

/** `hour` o'clock on the local day `days` away from the day `at` falls on. */
function localHourOn(at, days, hour, timeZone) {
  const [y, m, d] = new Date(at).toLocaleDateString("en-CA", { timeZone }).split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return atLocal({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour }, timeZone);
}

/**
 * When a held offer should go, or why it cannot be given a moment yet. Never inside their quiet
 * hours: a moment that lands there moves to their morning.
 */
export function momentFor(spec, cue, { timeZone, quietStart, quietEnd } = {}) {
  const w = spec.when ?? {};
  let at;
  if (w.days_after_noticed != null) at = localHourOn(cue.created_at, w.days_after_noticed, w.hour ?? 11, timeZone);
  else if (cue.starts_at == null) return { waiting: "no date yet" };
  else if (w.hours_before != null) {
    if (!cue.time_known) return { waiting: "needs the time, not just the day" };
    at = cue.starts_at - w.hours_before * HOUR;
  } else at = localHourOn(cue.starts_at, -(w.days_before ?? 1), w.hour ?? 12, timeZone);
  if (notice.inQuietHours(at, timeZone, { start: quietStart, end: quietEnd })) {
    at = notice.quietEndsAt(at, timeZone, { start: quietStart, end: quietEnd });
  }
  return { at };
}

/** When a cue is over: its end, else the end of its day (or three hours after a known time), else a few weeks. */
function endOf(cue, timeZone) {
  if (cue.ends_at != null) return cue.ends_at;
  if (cue.starts_at != null) return cue.time_known ? cue.starts_at + 3 * HOUR : localHourOn(cue.starts_at, 1, 0, timeZone);
  return cue.created_at + Number(CUES[cue.kind]?.undatedDays ?? 30) * DAY;
}

// ---------- holding and letting go ----------

/** Take a held offer off the unprompted path: its timer is cancelled and its notice row is settled. */
function letGo(o, why, now = clock.now()) {
  if (o.timer_id) { try { db.cancelTimer(o.conversation_id, o.timer_id); } catch { /* already fired or gone */ } }
  if (o.notice_id) {
    const n = db.noticeById(o.notice_id);
    if (n && !n.said_at && !n.resolved_at) db.resolveNotice(o.notice_id, why, now);
  }
}

/** Put one offer on the unprompted path for `at`: a notice row every offer of this cue shares a `thing` with, on a one-off timer. */
function hold(cue, o, spec, at, { now = clock.now(), ride = false } = {}) {
  // A row for this offer that was settled without being said (its moment moved, it waited for a date)
  // would be handed back as it was; the offer gets a fresh one.
  q("DELETE FROM notice_seen WHERE conversation_id = ? AND kind = ? AND key = ? AND said_at IS NULL").run(cue.conversation_id, NOTICE_KIND, `cue:${cue.id}:${o.offer}`);
  const written = db.recordNotice(cue.conversation_id, {
    kind: NOTICE_KIND, key: `cue:${cue.id}:${o.offer}`, thing: `cue:${cue.id}`,
    what: `for ${cue.what}, you could offer to ${spec.what}`,
    detail: `they said: "${cue.said}"`,
    momentAt: at, at: now,
  });
  let timerId = null;
  if (ride) {
    // Heard on a call or on a turn that was not theirs: nothing is texted about it. It waits, and
    // rides out on the end of the next reply to something they say (notice.heldNote).
    db.holdNotice(written.id, now);
  } else {
    const timer = db.createTimer(cue.conversation_id, { fireAt: at, note: `the moment for an offer about ${cue.what}`.slice(0, 500), label: LABEL });
    db.scheduleNotice(written.id, timer.id, at);
    timerId = timer.id;
  }
  setOffer(o, { state: "held", why: null, needs_connect: null, moment_at: at, notice_id: written.id, timer_id: timerId }, now);
}

/**
 * Bring what the rows say in line with what happened elsewhere: a held offer the unprompted path
 * really sent is `offered`; one it settled or dropped is let go; a cue past its end is ended.
 * Cheap, and called before anything here reads a cue — so nothing in the runtime has to tell this
 * file that a text went out.
 */
export function sync(conversationId, { now = clock.now() } = {}) {
  const timeZone = tzOf(conversationId);
  for (const cue of openCues(conversationId)) {
    if (endOf(cue, timeZone) <= now) { end({ conversationId, cueId: cue.id, why: "its date passed", now, synced: true }); continue; }
    for (const o of offersOf(cue)) {
      if (o.state !== "held" || !o.notice_id) continue;
      const n = db.noticeById(o.notice_id);
      if (!n) { setOffer(o, { state: "dropped", why: "its row is gone" }, now); continue; }
      if (n.said_at) setOffer(o, { state: "offered", offered_at: n.said_at, line: n.what, unprompted: 1 }, now);
      else if (n.resolved_at || n.dropped_at) setOffer(o, { state: "dropped", why: n.resolved_why || "passed over" }, now);
    }
  }
}

/**
 * Lay out a cue's offers as rows. Run when a cue is first noted and again whenever what is known
 * about it changes (a date arrives, the flight turns out to be a train).
 *
 * `turnKind` "user" means a reply is about to go: offers whose moment is already here may only be
 * said in that reply (`reply_only`), never sent after it. Any other turn (a call that just ended):
 * one of them is kept to ride on their next reply and the rest are skipped.
 */
export function plan({ cue, env, turnKind = "user", now = clock.now() }) {
  const c = cue.conversation_id;
  const s = notice.settingsFor(c, { now });
  const facts = factsOf(cue);
  const over = endOf(cue, s.timeZone);

  // First, where each offer SHOULD be, in catalogue order (which is priority order).
  const wants = [];
  for (const spec of CUES[cue.kind].offers) {
    let o = offerRow(cue, spec.key);
    // Settled one way or another: said, answered, or let go for good. Never laid out again.
    if (o && ["offered", "accepted", "declined", "dropped"].includes(o.state)) continue;
    if (!o) {
      q("INSERT INTO cue_offers (cue_id, conversation_id, offer, state, created_at, updated_at) VALUES (?, ?, ?, 'skipped', ?, ?)").run(cue.id, c, spec.key, now, now);
      o = offerRow(cue, spec.key);
    }
    const can = !fits(spec, facts) ? "no" : muted(c, cue.kind, spec.key) ? "no" : availability(spec, env);
    let want;
    if (can === "no") want = { state: "skipped", why: "not something they can get, or not for this one" };
    else if (can === "connect") {
      // A connect is only ever offered in a reply they started, and only once per person (see offer()).
      want = muted(c, "connect", spec.connect)
        ? { state: "skipped", why: `they were already offered the ${spec.connect} connect once` }
        : { state: turnKind === "user" ? "reply_only" : "skipped", why: `needs ${spec.connect} connected`, connect: spec.connect };
    } else {
      const m = momentFor(spec, cue, { timeZone: s.timeZone, quietStart: s.quietStart, quietEnd: s.quietEnd });
      if (m.waiting) want = { state: "waiting", why: m.waiting };
      else if (m.at >= over) want = { state: "skipped", why: "its moment would be after the thing itself" };
      // Its moment is already here. In a reply it may be said there and nowhere else; on any other
      // turn it may ride on their next reply (one of them: see below).
      else if (m.at <= now + MIN) want = turnKind === "user" ? { state: "reply_only", why: "its moment is already here" } : { state: "ride" };
      else want = { state: "held", at: m.at };
    }
    wants.push({ spec, o, want });
  }

  // Then the two limits that are about the cue as a whole: only so many are held for later (the
  // first in the catalogue win, so a better one that only now has a moment displaces a lesser one),
  // and only one waits to ride on their next reply.
  let held = 0;
  let riding = false;
  for (const w of wants) {
    const already = w.o.state === "held" && !w.o.timer_id;       // already riding from an earlier turn
    if (w.want.state === "ride" || already) {
      if (riding) w.want = { state: "skipped", why: "one offer is already waiting for their next reply" };
      else { riding = true; if (already) w.want = { state: "keep" }; }
    } else if (w.want.state === "held") {
      if (held >= holdAtMost(cue.kind)) w.want = { state: w.spec.now && turnKind === "user" ? "reply_only" : "skipped", why: "enough is held for this one already" };
      else held++;
    }
  }

  // And make the rows say so.
  for (const { spec, o, want } of wants) {
    const wasHeld = o.state === "held";
    if (want.state === "keep") continue;
    if (want.state === "held" && wasHeld && o.timer_id && o.moment_at === want.at) continue;   // already where it should be
    if (wasHeld) letGo(o, want.why || "its moment moved", now);
    if (want.state === "held") hold(cue, o, spec, want.at, { now });
    else if (want.state === "ride") hold(cue, o, spec, now, { now, ride: true });
    else setOffer(o, { state: want.state, why: want.why ?? null, needs_connect: want.connect ?? null, moment_at: null, notice_id: null, timer_id: null }, now);
  }
  return offersOf(cue);
}

// ---------- what the model is shown ----------

/** One cue as the model sees it: their words, real times, and where each offer stands. */
export function view(cue) {
  if (!cue) return null;
  const rows = offersOf(cue);
  const pick = (states) => rows.filter(o => states.includes(o.state));
  return {
    cue_id: cue.id, kind: cue.kind, what: cue.what, their_words: cue.said,
    ...(cue.starts_at != null ? { when: stamp(cue.starts_at) + (cue.time_known ? "" : " (the day; no time given)") } : { when: null }),
    ...(Object.keys(factsOf(cue)).length ? { facts: factsOf(cue) } : {}),
    state: cue.state,
    ...(cue.ended_why ? { ended_why: cue.ended_why } : {}),
    offered_waiting_on_them: pick(["offered"]).map(o => ({ offer: o.offer, line: o.line, when: stamp(o.offered_at) })),
    held_for_later: pick(["held"]).map(o => ({ offer: o.offer, ...(o.timer_id ? { goes: stamp(o.moment_at) } : { goes: "on your next reply to them" }) })),
    said_yes: pick(["accepted"]).map(o => o.offer),
    said_no: pick(["declined"]).map(o => o.offer),
  };
}

/**
 * May ONE offer be made for this cue in the reply being written, and which are open?
 *
 * Open means: theirs to get, not already said or answered, and either sensible to say straight away
 * (`now`) or at its moment already. The noes are facts: an offer on this cue is still unanswered, or
 * this is not a turn they started.
 */
export function openNow({ cue, turnKind = "user" }) {
  if (cue.state !== "open") return { ok: false, why: "That one is over.", options: [] };
  if (turnKind !== "user") {
    return { ok: false, why: "This is not a reply to something they just said, so nothing is offered now. What can wait is held and will go at its moment, inside their daily limit.", options: [] };
  }
  const rows = offersOf(cue);
  const pending = rows.find(o => o.state === "offered");
  if (pending) {
    return { ok: false, why: `You already offered "${pending.line || pending.offer}" for this one and they have not answered it. One offer, then it waits for them.`, options: [] };
  }
  const options = rows.filter(o => {
    const spec = specOf(cue.kind, o.offer);
    if (!spec) return false;
    if (o.state === "reply_only") return true;
    return (o.state === "held" || o.state === "waiting") && !!spec.now;
  }).map(o => {
    const spec = specOf(cue.kind, o.offer);
    return o.needs_connect
      ? { offer: o.offer, what: spec.what, needs_connect: o.needs_connect, note: `They have not connected ${o.needs_connect}, so the most you may offer is to connect it — once, ever. Only if it is clearly the most useful thing here.` }
      : { offer: o.offer, what: spec.what };
  });
  return options.length ? { ok: true, options } : { ok: false, why: "Nothing fits right now. Whatever can wait is held for its moment.", options: [] };
}

// ---------- noting one ----------

/**
 * `cue_note`, in full: write down something coming up that they said, lay out its offers, and say
 * which ONE may be made now.
 *
 * `said` is required and theirs, for the reason it is everywhere else in Reason: it is the only
 * thing that can later show the cue was something they told Reason and not something Reason worked
 * out. `sensitive` is the model's own honest read, and a true there writes nothing at all.
 */
export function note({ conversationId, kind, what, said, starts = "", ends = "", facts = {}, sensitive = false, cueId = null, backOn = false, env, turnKind = "user", heardOn = "text", now = clock.now() }) {
  if (!active(conversationId)) return { ok: false, blocked: "not_available", error: "That isn't something Reason does here. Do not mention it." };
  const def = CUES[kind];
  if (!def) return { ok: false, error: `There is no cue called '${kind}'. The ones there are: ${Object.keys(CUES).join(", ")}. If it is none of those, there is nothing to note.` };
  if (sensitive) {
    return { ok: false, status: "sensitive", written: false, error: `Nothing is written down and nothing is offered off this. ${SENSITIVE_RULE}` };
  }
  const verbatim = String(said ?? "").trim();
  if (!verbatim) {
    return { ok: false, error: "`said` is required and must be their own words, word for word. A cue is only ever something THEY told you is coming up — never one you worked out from their calendar, their mail, or what you think is likely." };
  }
  const subject = String(what ?? "").trim();
  if (!subject) return { ok: false, error: "Say what it is in `what`, short and in their terms: \"the miami trip\", \"mom's birthday\"." };
  sync(conversationId, { now });

  const timeZone = tzOf(conversationId);
  const start = String(starts ?? "").trim() ? parseWhen(starts, timeZone) : null;
  const finish = String(ends ?? "").trim() ? parseWhen(ends, timeZone) : null;
  if (String(starts ?? "").trim() && !start) return { ok: false, error: "`starts` is a date (2026-11-20) or a date and time (2026-11-20T14:30). Leave it out if they did not say when — never guess one." };
  const cleanFacts = {};
  for (const [name, allowed] of Object.entries(def.facts ?? {})) if (allowed.includes(facts?.[name])) cleanFacts[name] = facts[name];

  let cue = cueId != null ? cueById(conversationId, cueId) : q("SELECT * FROM cues WHERE conversation_id = ? AND kind = ? AND key = ?").get(conversationId, kind, cueKey(subject)) ?? null;
  if (cueId != null && !cue) return { ok: false, error: `There is no cue #${cueId} of theirs.` };
  if (cue && cue.kind !== kind) return { ok: false, error: `Cue #${cue.id} is a ${cue.kind}, not a ${kind}.` };
  const startsLater = !!start && (finish?.at ?? (start.timeKnown ? start.at + 3 * HOUR : localHourOn(start.at, 1, 0, timeZone))) > now;
  if (cue?.state === "ended") {
    // One that ran out on its own and is coming round again (next year's birthday, another trip to
    // the same place) starts afresh. One THEY called off stays off until they say it is back on.
    if ((cue.ended_by === "date" && (startsLater || !start)) || (backOn && cue.ended_by !== "date")) {
      q("DELETE FROM cue_offers WHERE conversation_id = ? AND cue_id = ?").run(conversationId, cue.id);
      q("DELETE FROM cues WHERE conversation_id = ? AND id = ?").run(conversationId, cue.id);
      cue = null;
    } else if (cue.ended_by !== "date") {
      return { ok: false, status: "ended", cue: view(cue), error: `They called that one off (${cue.ended_why || "ended"}), so nothing is offered for it. Only if they have now said it is back on: cue_note again with back_on true.` };
    }
  }
  if (start && (finish?.at ?? (start.timeKnown ? start.at + 3 * HOUR : localHourOn(start.at, 1, 0, timeZone))) <= now) {
    return { ok: false, status: "already_past", error: "That date has already passed, so there is nothing to think ahead about. Write nothing down." };
  }
  const already = !!cue;
  if (!cue) {
    if (openCues(conversationId).length >= openCap()) {
      return { ok: false, status: "enough_open", error: `They already have ${openCap()} things coming up that you are holding offers for. That is enough; answer what they said and leave this one.` };
    }
    q(`INSERT INTO cues (conversation_id, kind, what, key, said, facts, starts_at, time_known, ends_at, heard_on, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(conversationId, kind, subject, cueKey(subject), verbatim, JSON.stringify(cleanFacts), start?.at ?? null, start?.timeKnown ? 1 : 0, finish?.at ?? null, heardOn === "call" ? "call" : "text", now, now);
    cue = q("SELECT * FROM cues WHERE conversation_id = ? AND kind = ? AND key = ?").get(conversationId, kind, cueKey(subject));
  } else {
    // Mentioned again: what is newly known is added, and nothing they already said is lost.
    const merged = { ...factsOf(cue), ...cleanFacts };
    q("UPDATE cues SET facts = ?, starts_at = ?, time_known = ?, ends_at = ?, updated_at = ? WHERE conversation_id = ? AND id = ?")
      .run(JSON.stringify(merged), start?.at ?? cue.starts_at, start ? (start.timeKnown ? 1 : 0) : cue.time_known, finish?.at ?? cue.ends_at, now, conversationId, cue.id);
    cue = cueById(conversationId, cue.id);
  }
  plan({ cue, env, turnKind, now });
  const can = openNow({ cue, turnKind });
  return {
    ok: true, cue: view(cue), already_knew: already,
    may_offer_now: can.ok,
    ...(can.ok ? { pick_at_most_one: can.options } : { why_not: can.why }),
    say: can.ok
      ? `Answer what they actually said first. Then, if ONE of pick_at_most_one would really help with THIS ${kind}, offer it at the`
        + ` end of the same reply: one short line in your own voice that they can answer with a word — "want me to find u a`
        + ` place to stay?" is the shape. One offer. Never two, never a list of what you could do, and nothing that is not`
        + ` in pick_at_most_one. Then call cue_offer with the offer and the line you sent. If none of them fits, offer`
        + ` nothing: the rest is held for its moment.${cue.starts_at == null ? " You do not know when it is; if it comes up naturally you may ask, and cue_note again with `starts`." : ""}`
      : `Do NOT offer anything now. ${can.why} Answer what they said and leave it there.`,
    note: "Written down. Nothing here does anything for them: an offer is a question, and the yes it gets is still subject to every confirmation the thing itself needs.",
  };
}

/**
 * `cue_offer`, in full: record the ONE offer just made in this reply.
 *
 * Refuses on facts: not a turn they started, an offer on this cue still unanswered, an offer that
 * is not open to them, one they already answered. An offer that was held for later and is said now
 * comes off the unprompted path, so it cannot arrive a second time.
 */
export function offer({ conversationId, cueId, offer: key, line, turnKind = "user", now = clock.now() }) {
  if (!active(conversationId)) return { ok: false, blocked: "not_available", error: "That isn't something Reason does here. Do not mention it." };
  sync(conversationId, { now });
  const cue = cueById(conversationId, cueId);
  if (!cue) return { ok: false, error: `There is no cue #${cueId} of theirs.` };
  const said = String(line ?? "").trim();
  if (!said) return { ok: false, error: "Give the line you sent in `line`, as you sent it." };
  const can = openNow({ cue, turnKind });
  if (!can.ok) return { ok: false, status: "not_now", error: `${can.why} Take the offer out of your reply.` };
  const option = can.options.find(o => o.offer === key);
  if (!option) {
    return { ok: false, status: "not_open", open: can.options.map(o => o.offer), error: `'${key}' is not something you may offer them for this one. Take it out of your reply. What is open: ${can.options.map(o => o.offer).join(", ")}.` };
  }
  const o = offerRow(cue, key);
  if (o.state === "held") letGo(o, "said in a reply instead", now);
  setOffer(o, { state: "offered", line: said.slice(0, 500), offered_at: now, unprompted: 0, why: null }, now);
  // A connect is offered once per person, ever: the next cue that needs it finds this and stays quiet.
  if (o.needs_connect) mute(conversationId, "connect", o.needs_connect, null, now);
  // What could only have been said in this reply is not said later.
  for (const other of offersOf(cue)) {
    if (other.id !== o.id && other.state === "reply_only") setOffer(other, { state: "skipped", why: "another offer was made in that reply" }, now);
  }
  return {
    ok: true, cue: view(cueById(conversationId, cue.id)),
    note: "Recorded. That was this cue's one offer for now: nothing else is offered for it until they answer. When they do, cue_answer with their words — and a yes is only a yes to the offer: do the thing with its own tools and its own confirmations.",
  };
}

/**
 * `cue_answer`, in full: what they said back to an offer.
 *
 * "no" ends that offer for this cue. "never" also mutes it for them on every later cue. Two noes on
 * one cue and whatever is still held for it is let go: somebody who has turned down two things
 * about a trip does not want a third.
 */
export function answer({ conversationId, cueId, offer: key, answer: verdict, said, now = clock.now() }) {
  sync(conversationId, { now });
  const cue = cueById(conversationId, cueId);
  if (!cue) return { ok: false, error: `There is no cue #${cueId} of theirs.` };
  const o = offerRow(cue, key);
  if (!o || !specOf(cue.kind, key)) return { ok: false, error: `Cue #${cueId} has no offer called '${key}'.` };
  const verbatim = String(said ?? "").trim();
  if (!verbatim) return { ok: false, error: "`said` is required: their answer, word for word." };
  if (!["yes", "no", "never"].includes(verdict)) return { ok: false, error: "`answer` is yes, no, or never." };
  letGo(o, verdict === "yes" ? "they said yes" : "they said no", now);
  setOffer(o, { state: verdict === "yes" ? "accepted" : "declined", answer_said: verbatim.slice(0, 500), answered_at: now, why: null }, now);
  if (verdict === "never") mute(conversationId, cue.kind, key, verbatim.slice(0, 500), now);
  let dropped = 0;
  if (verdict !== "yes" && offersOf(cue).filter(x => x.state === "declined").length >= NOES_END_IT) {
    for (const other of offersOf(cue)) {
      if (!["held", "waiting", "reply_only"].includes(other.state)) continue;
      letGo(other, "they turned down two offers about this", now);
      setOffer(other, { state: "dropped", why: "they turned down two offers about this" }, now);
      dropped++;
    }
  }
  return {
    ok: true, cue: view(cueById(conversationId, cue.id)), ...(dropped ? { let_go: dropped } : {}),
    say: verdict === "yes"
      ? "Do it now with the tools it needs. Their yes was to the offer; anything that spends money, books, or reaches somebody else still needs the confirmation it always needed."
      : `That answer stands: this offer is never made again for this one${verdict === "never" ? ", or for any later one" : ""}. Do not reword it, do not offer a different thing in its place right now, and do not make anything of it.`,
  };
}

/** `cue_end`, in full: it is off, it happened, or it moved on. Everything held for it is let go. */
export function end({ conversationId, cueId, why = "", said = "", now = clock.now(), synced = false }) {
  if (!synced) sync(conversationId, { now });
  const cue = cueById(conversationId, cueId);
  if (!cue) return { ok: false, error: `There is no cue #${cueId} of theirs.` };
  if (cue.state === "ended") return { ok: true, cue: view(cue), already: true };
  for (const o of offersOf(cue)) {
    if (!["held", "waiting", "reply_only"].includes(o.state)) continue;
    letGo(o, why || "it is over", now);
    setOffer(o, { state: "dropped", why: (why || "it is over").slice(0, 200) }, now);
  }
  q("UPDATE cues SET state = 'ended', ended_why = ?, ended_by = ?, ended_said = ?, ended_at = ?, updated_at = ? WHERE conversation_id = ? AND id = ?")
    .run(String(why || "ended").slice(0, 200), synced ? "date" : "them", String(said ?? "").trim().slice(0, 500) || null, now, now, conversationId, cue.id);
  return { ok: true, cue: view(cueById(conversationId, cue.id)), say: "Nothing more is offered for it. Do not mention that you were holding anything." };
}

// ---------- the unprompted path's two questions (src/notice.js) ----------

/**
 * Is a held offer still worth raising? Asked by the sweep and again when its timer fires, which can
 * be weeks after the cue was heard. `handled` settles the row for good and no turn is spent.
 */
export async function recheck(conversationId, row, now = clock.now(), env = null) {
  if (!covers(conversationId)) return { handled: "cues are switched off" };
  if (optedOut(conversationId)) return { handled: "they turned this off" };
  sync(conversationId, { now });
  const o = q("SELECT * FROM cue_offers WHERE conversation_id = ? AND notice_id = ?").get(conversationId, row.id);
  if (!o) return { handled: "the offer it was for is gone" };
  const cue = cueById(conversationId, o.cue_id);
  if (!cue || cue.state !== "open") return { handled: cue?.ended_why || "what it was about is over" };
  if (o.state !== "held") return { handled: `already ${o.state}` };
  const spec = specOf(cue.kind, o.offer);
  if (!spec || muted(conversationId, cue.kind, o.offer)) return { handled: "they do not want this offered" };
  // What they can get is read again here: a feature switched off since, or an account disconnected,
  // and the offer would be one Reason cannot keep.
  if (availability(spec, env ?? await envFor(conversationId)) !== "ok") {
    setOffer(o, { state: "dropped", why: "no longer something they can get" }, now);
    return { handled: "no longer something they can get" };
  }
  return { ok: true };
}

/** The turn a held offer's moment runs. The gate is notice_send, like anything unprompted. */
export function momentFrame({ conversationId, row }) {
  const who = accounts.ownerOf(conversationId).name;
  const o = q("SELECT * FROM cue_offers WHERE conversation_id = ? AND notice_id = ?").get(conversationId, row.id);
  const cue = o ? cueById(conversationId, o.cue_id) : null;
  const spec = cue ? specOf(cue.kind, o.offer) : null;
  return `[the moment for an offer you were holding] ${who} told you about ${cue?.what ?? "something coming up"}`
    + (cue?.said ? ` ("${cue.said}")` : "") + (cue?.starts_at != null ? `, which is ${stamp(cue.starts_at)}` : "") + `.`
    + ` You held ONE thing to offer at the point it would be useful, and that is now: ${spec?.what ?? row.what}.`
    + `\n\nIt is ${stamp()}. Look at the conversation above first. If they have already sorted this out, asked you for it,`
    + ` said the plan changed or said they do not want it, reply with exactly NO_REPLY (and cue_answer or cue_end if they said so).`
    + `\n\nOtherwise OFFER it in one short line they can answer with one word, in your own voice. Never do it. Never do it`
    + ` and tell them after. Never offer two things, and never add what else you could do. Call notice_send with key`
    + ` "${row.key}" first — it counts against their day like anything you start, and code will refuse it if the day is`
    + ` spent or it is their night. If it refuses, reply NO_REPLY. ${notice.SILENCE_RULE}`
    + `\n\n${notice.NO_PERMISSION_RULE}`
    + `\n\n${notice.HEALTH_RULE}`;
}

// ---------- the note on a turn ----------

/**
 * What a turn THEY started is told: the cues still open and where each offer stands — including what
 * they turned down, so an offer somebody refused is not made again on a turn where the thread no
 * longer carries the no. Empty unless something is open: hearing a new cue is cue_note's own
 * description, and costs nobody a line.
 */
export function turnNote(conversationId, { now = clock.now() } = {}) {
  if (!active(conversationId)) return "";
  sync(conversationId, { now });
  const open = openCues(conversationId);
  if (!open.length) return "";
  const who = accounts.ownerOf(conversationId).name;
  return `things coming up that ${who} told you about, and where your offers for each stand: ${JSON.stringify(open.map(view))}.`
    + ` Part of the moment, not a list to read out. An offer in offered_waiting_on_them that they just answered: cue_answer,`
    + ` with their words. Anything in said_no is never offered again. If they say one of these is off or done, cue_end.`
    + ` If they tell you more about one (the date, how they are getting there), cue_note again with its cue_id.`
    + ` Do not bring up what is held_for_later unless another note on this turn hands it to you.`;
}

// ---------- the tools ----------

export const CUE_TOOLS = new Set(["cue_note", "cue_offer", "cue_answer", "cue_end", "cues_setting"]);

/** Shown only where the switch reaches; `cues_setting` stays for somebody who turned cues off, so they can turn them back on. */
export function cueToolVisible(name, conversationId) {
  if (!CUE_TOOLS.has(name)) return true;
  return name === "cues_setting" ? covers(conversationId) : active(conversationId);
}

const kindsLine = () => Object.entries(CUES).map(([k, d]) => `${k} (${d.what}; e.g. ${d.hear})`).join("; ");

export const CUE_TOOL_DEFS = [
  {
    name: "cue_note",
    description: "Something is COMING UP in their life and they just told you so, in a text or on a call whose words are above. Write it down the moment they say it, even in passing inside a message about something else: "
      + kindsLine() + "."
      + " Hearing it is yours — read what they meant; there is no word list anywhere. It must be something THEY said is happening, with their sentence in `said`: never something you worked out from their calendar, their mail, a booking, or a guess, and never somebody else's plans they merely mentioned."
      + ` ${SENSITIVE_RULE} If it does, set sensitive true and nothing is written.`
      + " It comes back saying whether you may make ONE offer in this reply and which offers are open to this person. Offer only from that list: it already leaves out what is switched off for them or not connected."
      + " After a call, or on any turn they did not start, nothing is offered now: it is held for the right moment.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: Object.keys(CUES) },
        what: { type: "string", description: "Short, in their terms: \"the miami trip\", \"mom's birthday\", \"the stripe interview\". The same thing mentioned again is the same row, so keep the wording stable." },
        said: { type: "string", description: "Their own words, word for word. Required." },
        starts: { type: "string", description: "When it is, only if they said: a date (2026-11-20) or date and time on their clock (2026-11-20T14:30). Leave out if they did not say. Never guess." },
        ends: { type: "string", description: "When it is over, if they said (the day they fly back, the day the guest leaves). Same format." },
        facts: {
          type: "object",
          description: "Only what they said. trip: mode = flight | train | drive | other. birthday: whose = theirs | someone_else. interview: where = in_person | remote | unknown.",
          properties: { mode: { type: "string" }, whose: { type: "string" }, where: { type: "string" } },
        },
        sensitive: { type: "boolean", description: "True if this rests on health, money trouble, a relationship, a loss or anything legal. Be honest: true writes nothing and offers nothing." },
        cue_id: { type: "integer", description: "When adding to one you already noted (a date, how they are travelling)." },
        back_on: { type: "boolean", description: "True only when they have just said something they called off is back on." },
        heard_on: { type: "string", enum: ["text", "call"], description: "Where they said it." },
      },
      required: ["kind", "what", "said"],
    },
  },
  {
    name: "cue_offer",
    description: "Record the ONE offer you have just made for a cue, with the line you sent. Call it in the SAME turn as the offer, which rides at the end of a reply they are already reading."
      + " It REFUSES when the offer is not one cue_note said was open, when an offer for this cue is still unanswered, and on a turn they did not start. Those are facts in the database: do not argue with one, and take the offer out of your reply."
      + " A good offer is one short line they can answer with a word. Never a menu, never two.",
    input_schema: {
      type: "object",
      properties: {
        cue_id: { type: "integer" },
        offer: { type: "string", description: "The `offer` key from pick_at_most_one." },
        line: { type: "string", description: "The line as you sent it." },
      },
      required: ["cue_id", "offer", "line"],
    },
  },
  {
    name: "cue_answer",
    description: "What they said back to an offer you made for a cue. yes: then do the thing with its own tools and its own confirmations — the yes was to the offer, not to spending or booking. no: that offer is never made again for this cue. never: they do not want that kind of offer at all (\"i always drive myself\"), so it is never made on any later one either."
      + " Read which it was from what they meant. Silence is not an answer and is never recorded as one.",
    input_schema: {
      type: "object",
      properties: {
        cue_id: { type: "integer" },
        offer: { type: "string" },
        answer: { type: "string", enum: ["yes", "no", "never"] },
        said: { type: "string", description: "Their answer, word for word." },
      },
      required: ["cue_id", "offer", "answer", "said"],
    },
  },
  {
    name: "cue_end",
    description: "Something you noted is off, done, or no longer theirs to plan: the trip was cancelled, the interview moved to a different process, the guest is not coming. Everything you were holding to offer for it is let go and nothing more is said about it. It also ends on its own once its date passes.",
    input_schema: {
      type: "object",
      properties: {
        cue_id: { type: "integer" },
        why: { type: "string", description: "Short: \"trip cancelled\"." },
        said: { type: "string", description: "Their words, if they said it." },
      },
      required: ["cue_id"],
    },
  },
  {
    name: "cues_setting",
    description: "They want you to stop — or start again — offering things when something like a trip, a move, a birthday, an interview or a guest comes up (\"stop offering me stuff every time i mention a trip\"). Off deletes everything you were holding and you never offer off one again until they say otherwise; what they ASK for you still do. This is not the same question as how often you may text them unprompted (that is notice settings), so never answer one with the other.",
    input_schema: {
      type: "object",
      properties: {
        on: { type: "boolean" },
        said: { type: "string", description: "Their words, word for word." },
      },
      required: ["on", "said"],
    },
  },
];

const FACTS = z.object({ mode: z.string().optional(), whose: z.string().optional(), where: z.string().optional() }).passthrough();
export const CUE_SCHEMAS = {
  cue_note: z.object({
    kind: z.string().min(1), what: z.string().trim().min(1).max(120), said: z.string().min(1).max(1000),
    starts: z.string().max(40).optional(), ends: z.string().max(40).optional(), facts: FACTS.optional(),
    sensitive: z.boolean().optional(), cue_id: z.number().int().optional(), back_on: z.boolean().optional(), heard_on: z.enum(["text", "call"]).optional(),
  }),
  cue_offer: z.object({ cue_id: z.number().int(), offer: z.string().min(1).max(40), line: z.string().min(1).max(500) }),
  cue_answer: z.object({ cue_id: z.number().int(), offer: z.string().min(1).max(40), answer: z.enum(["yes", "no", "never"]), said: z.string().min(1).max(500) }),
  cue_end: z.object({ cue_id: z.number().int(), why: z.string().max(200).optional(), said: z.string().max(500).optional() }),
  cues_setting: z.object({ on: z.boolean(), said: z.string().min(1).max(500) }),
};

/** The dispatch for the five tools. `ctx.kind` is the turn's own kind: only a turn they started may carry an offer. */
export async function runCueTool(name, input, ctx = {}) {
  const c = ctx.conversationId;
  const turnKind = (ctx.kind ?? "event") === "user" ? "user" : "event";
  const ledger = (out, target) => { if (out?.ok) trust.ledgerWrite({ conversationId: c, action: name, input, out, target }); return out; };
  switch (name) {
    case "cue_note": {
      const out = note({
        conversationId: c, kind: input.kind, what: input.what, said: input.said, starts: input.starts ?? "", ends: input.ends ?? "",
        facts: input.facts ?? {}, sensitive: !!input.sensitive, cueId: input.cue_id ?? null, backOn: !!input.back_on,
        env: ctx.cueEnv ?? await envFor(c), turnKind, heardOn: input.heard_on ?? "text",
      });
      return ledger(out, out.ok ? `cue:${out.cue.cue_id}` : "");
    }
    case "cue_offer":
      return ledger(offer({ conversationId: c, cueId: input.cue_id, offer: input.offer, line: input.line, turnKind }), `cue:${input.cue_id}`);
    case "cue_answer":
      return ledger(answer({ conversationId: c, cueId: input.cue_id, offer: input.offer, answer: input.answer, said: input.said }), `cue:${input.cue_id}`);
    case "cue_end":
      return ledger(end({ conversationId: c, cueId: input.cue_id, why: input.why ?? "", said: input.said ?? "" }), `cue:${input.cue_id}`);
    case "cues_setting":
      return ledger(setOn({ conversationId: c, on: !!input.on, said: input.said, via: "text" }), "cues");
    default:
      return { ok: false, error: `No such tool: ${name}` };
  }
}
