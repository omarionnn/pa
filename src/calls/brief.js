// What the call is for, what it may say, and — the new part — what it is allowed to agree to.
//
// Until now `place()` took a goal, some facts, the standing rules and the announcement. That is
// enough to ask a question. It is not enough to hold a conversation up to the point of an agreement,
// because an agreement needs a boundary, and a boundary that lives in a prompt is a suggestion.
//
// The owner's sentence this file exists for, 2026-10-06: "Asking about availability is not permission
// to book. A new fee or term outside what Omari approved pauses the commitment and comes back to him."
//
// So `approved` is a structure, and `approved.book` is false unless somebody deliberately made it
// true. An inquiry call physically cannot commit to anything — not because it is told not to, but
// because `./commit.js` is handed a brief that says no and refuses. Same reasoning as
// `requireAnnouncement` and `requireCallRules` next door in ./provider.js: the parts of a call that
// keep it honest are built in code, passed as their own arguments, and a provider or a refactor that
// loses one gets a refused call rather than a loose one.
//
// The other thing a brief carries is everything the call might otherwise have to go back and ask the
// owner for. His words: "Keep the appointment requirements ready so it never has to ask him again
// once someone answers." After eight minutes on hold, the moment a human finally speaks is the worst
// possible moment to discover nobody knows what name to put the booking under.
import { config, clock } from "../config.js";
import { exactMoney } from "./readback.js";
import * as db from "../db.js";

// ---------- a person's own call: today so far ----------

/**
 * Call 79 (2026-11-08, Omari's own): asked about "the three spots" Reason had recommended by text at
 * 12:08 that day, the line garbled it to "three sub events" and Reason said "I don't have anything
 * saved" — Bo Peep, its own recommendation three hours earlier, was in the thread all along. So a call
 * to a person's own Reason starts with what happened between them today: what Reason recommended or
 * promised, what they said they'd do, and the names in it, so a garbled word can be matched against them.
 *
 * Only this conversation's own messages, by the call row's conversation, up to when the call was made
 * (so the note is the same on every turn of the call and the prompt cache holds). Never anyone else's.
 */
export const TODAY_MAX_CHARS = 1600;
const TODAY_MIN_HOURS = 6;
const LINE_CHARS = { assistant: 240, user: 150 };

/** Midnight where they are, as ms, for the day `now` falls in. */
function startOfDay(now, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(now));
  const n = (k) => Number(p.find(x => x.type === k)?.value ?? 0) % (k === "hour" ? 24 : 60);
  return now - ((n("hour") * 60 + n("minute")) * 60 + n("second")) * 1000;
}

const clipped = (t, n) => {
  const x = String(t ?? "").replace(/^\s*\[[^\]]*\]\s*[^:\n]{1,40}:\s*/, "").replace(/```/g, "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x;
};

// Words that start capitalised without being a name: sentence openers, days, months.
const NOT_NAMES = new Set(("I I'm I'll I've I'd A An The This That These Those It It's Its You You're Your Yours We He She They My Me Our"
  + " If So And But Or Yes No Not Ok Okay Sure Thanks Hey Hi Oh Nice Done Good Great Want Do Does Did Is Are Was Were Will Would Can Could"
  + " Should Here There What When Where Which Who Why How Just Also Then Now Today Tonight Tomorrow Yesterday Let Got Have Has Had"
  + " Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mon Tue Wed Thu Fri Sat Sun"
  + " January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec"
  + " AM PM St Ave Rd").split(" "));

/** The names in a few messages (places, people, things), in order, each once: "Bo Peep", "The Ragtrader". */
export function namesIn(texts, { max = 10 } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of texts) {
    for (const m of String(t ?? "").matchAll(/\b[A-Z][\p{L}'’&-]*(?:\s+(?:(?:of|de|the|and|&)\s+)?[A-Z][\p{L}'’&-]*)*/gu)) {
      const words = m[0].trim().split(/\s+/);
      while (words.length && NOT_NAMES.has(words[0]) && !(words[0] === "The" && words.length > 1)) words.shift();
      const name = words.join(" ").replace(/['’]s$/, "");
      if (name.length < 3 || NOT_NAMES.has(name)) continue;
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Today so far in this person's own thread, for their own call: `{ lines, names }` (newest last), or
 * null when nothing was said today. `until` is when the call was made.
 */
export function todaySoFar(conversationId, { until = clock.now(), tz = config.tz, maxChars = TODAY_MAX_CHARS, call = null } = {}) {
  if (!conversationId) return null;
  // Read once per call: every turn of it sends the same words (the prompt cache), even on an install
  // whose only record of today is the thread itself, which the call goes on writing to.
  const key = call == null ? null : `${call}#${conversationId}#${until}#${tz}#${maxChars}`;
  if (key && todayKept.has(key)) return todayKept.get(key);
  const got = readToday(conversationId, { until, tz, maxChars });
  if (key) {
    todayKept.set(key, got);
    if (todayKept.size > 200) todayKept.delete(todayKept.keys().next().value);
  }
  return got;
}
const todayKept = new Map();

function readToday(conversationId, { until, tz, maxChars }) {
  let rows = [];
  try {
    const since = Math.min(startOfDay(until, tz), until - TODAY_MIN_HOURS * 3600_000);
    rows = messagesBetween(conversationId, since, until, { limit: 40 });
    // No message history kept on this install (REASON_WEB off): the thread itself, back to the first
    // of their lines stamped with another day (their lines carry "[Sun, Nov 8, 2026, 10:04 AM] Name:").
    if (!rows.length) rows = todayFromThread(conversationId, { until, tz });
  } catch { return null; }
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const picked = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    const who = r.role === "assistant" ? "you" : r.role === "user" ? "them" : "";
    if (!who) continue;
    const text = clipped(r.text, LINE_CHARS[r.role] ?? 150);
    if (!text || /NO_REPLY/.test(text)) continue;
    const line = `${r.untimed ? "" : `${fmt.format(new Date(r.at))} `}${who}: ${text}`;
    if (used + line.length > maxChars) break;
    picked.unshift(line);
    used += line.length;
  }
  if (!picked.length) return null;
  // Names from everything said today: Reason's own words first (its recommendations), newest first.
  const newest = [...rows].reverse();
  const names = namesIn([...newest.filter(r => r.role === "assistant"), ...newest.filter(r => r.role === "user")].map(r => r.text));
  return { lines: picked, names };
}

/**
 * This conversation's own messages from `since` up to `until` (ms), oldest first, the newest `limit`:
 * text only, never deleted ones. Scoped by conversation — never anybody else's.
 */
function messagesBetween(conversationId, since, until, { limit = 40 } = {}) {
  return db.db.prepare(`SELECT role, text, at FROM messages WHERE conversation_id = ? AND at >= ? AND at <= ?
    AND deleted_at IS NULL AND text != '' ORDER BY at DESC, id DESC LIMIT ?`).all(conversationId, since, until, limit).reverse();
}

/** Today's end of the thread, as `{ role, text, at }` rows (at: the day's stamp, or `until`). */
function todayFromThread(conversationId, { until, tz }) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(new Date(until));
  const out = [];
  for (const m of db.loadConversation(conversationId).slice(-40).reverse()) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "";
    if (m.role === "user") {
      const stamp = /^\s*\[(?:[A-Za-z]{3}, )?([A-Za-z]{3} \d{1,2}, \d{4})/.exec(text);
      if (!stamp) continue;
      if (stamp[1] !== day) break;
    }
    if (text.trim()) out.push({ role: m.role, text, at: until, untimed: true });
  }
  // Only what follows a line of theirs stamped today counts.
  while (out.length && out.at(-1).role === "assistant") out.pop();
  return out.reverse();
}

/** The "today so far" block for Reason's own turns on a person's own call, or "". */
export function todaySoFarNote(conversationId, opts = {}) {
  const t = todaySoFar(conversationId, opts);
  if (!t) return "";
  return "TODAY SO FAR in your chats with them (before this call), newest last — what you recommended or promised, and what they said they'd do:\n"
    + t.lines.join("\n")
    + (t.names.length ? `\nNames from today: ${t.names.join(", ")}.` : "");
}

/**
 * The questions every provider on a comparison errand is asked, so the answers actually compare.
 *
 * The owner's list, 2026-10-06: "Ask every provider the same core questions so quotes compare: full
 * price, fees, availability, what is included, exclusions, how long the quote holds."
 *
 * They live here rather than being written per call because the failure mode is the sixth call asking
 * a thinner version than the first and the comparison quietly becoming apples and oranges. "How long
 * does the quote hold" is the one most likely to be dropped and the one that decides whether the
 * cheapest option still exists by the time the owner has made up his mind.
 */
export const CORE_QUESTIONS = [
  "the full price, including every fee and tax — the number they would actually charge",
  "anything extra that is not in that price",
  "what is included at that price",
  "what is specifically not included",
  "the earliest they could do it, and what other times they have",
  "how long that price is good for — and whether it is a firm quote or an estimate",
];

/** How long an answer is good for. The owner's distinction, kept as a value and never as an adjective. */
export const QUOTE_KINDS = ["firm", "estimate", "unknown"];

/**
 * What this call may agree to. The default is nothing, in every field.
 *
 * `book: false` is the important one and it is the default on purpose: the natural shape of this
 * object would have been "no limits unless somebody sets limits", and that is backwards for the one
 * structure that decides whether the owner's money gets spent.
 *
 * @param {{book?: boolean, maxCents?: number|null, terms?: string[], upTo?: string}} _
 */
export function approval({ book = false, maxCents = null, terms = [], upTo = "" } = {}) {
  // `exactMoney` rather than `Number()`, because `Number(null)` is 0: the obvious version turns "he
  // approved booking without naming a ceiling" into "the ceiling is zero dollars", which pauses every
  // call for approval and makes booking unusable while looking like caution.
  const ceiling = exactMoney(maxCents);
  return {
    book: book === true,
    maxCents: ceiling !== null && ceiling >= 0 ? ceiling : null,
    terms: (Array.isArray(terms) ? terms : []).map(t => String(t).trim()).filter(Boolean),
    // Free text, for the thing a ceiling cannot express: "up to $200 and only if they can do Saturday".
    upTo: String(upTo ?? "").trim(),
  };
}

/** An inquiry call: asks the questions, agrees to nothing, and cannot be talked into it. */
export const askOnly = () => approval({ book: false });

/**
 * Build a brief. Everything optional has a default that is the cautious direction.
 *
 * @param {{goal: string, facts?: string[], cannotAgree?: string[], approved?: object,
 *          questions?: string[], readBack?: string[], maxHoldSeconds?: number,
 *          returnNumber?: string, requirements?: object, place?: string,
 *          language?: string}} _
 */
export function buildBrief({
  goal,
  facts = [],
  cannotAgree = [],
  approved = askOnly(),
  questions = [],
  readBack = [],
  maxHoldSeconds = config.callMaxHoldSeconds,
  returnNumber = "",
  requirements = {},
  place = "",
  language = "en",
} = {}) {
  const hold = Number(maxHoldSeconds);
  return {
    goal: String(goal ?? "").trim(),
    facts: (Array.isArray(facts) ? facts : []).map(f => String(f).trim()).filter(Boolean),
    // The hard limits, always including the standing ones below, so a caller cannot produce a brief
    // that forgot them.
    cannotAgree: dedupe([...NEVER_AGREE, ...(Array.isArray(cannotAgree) ? cannotAgree : []).map(String)]),
    approved: approval(approved ?? {}),
    questions: (Array.isArray(questions) ? questions : []).map(q => String(q).trim()).filter(Boolean),
    // Which kinds of detail have to be said back before anything counts. Names from
    // ./readback.js's DETAIL_KINDS; a booking brief gets date/time at minimum.
    readBack: dedupe((Array.isArray(readBack) ? readBack : []).map(k => String(k).trim().toLowerCase()).filter(Boolean)),
    maxHoldSeconds: Number.isFinite(hold) && hold >= 0 ? Math.round(hold) : config.callMaxHoldSeconds,
    // The number to give out when they offer to ring back — the Twilio line, so a callback comes home
    // to Reason instead of to a number nobody answers. See the callback path in ./inbound.js.
    returnNumber: String(returnNumber ?? "").trim(),
    // Everything the call might otherwise have to go back to the owner for: the name, the party size,
    // a contact number to hold it under, whatever this kind of booking needs. Free-shaped because an
    // appointment at a garage and a table at a restaurant need different things, and a fixed schema
    // here would be a guess at every kind of errand at once.
    requirements: requirements && typeof requirements === "object" ? { ...requirements } : {},
    place: String(place ?? "").trim(),
    language: String(language ?? "en").trim().toLowerCase() || "en",
  };
}

const dedupe = (list) => [...new Set(list.map(s => String(s).trim()).filter(Boolean))];

/**
 * The things no call ever agrees to, whoever built the brief and whatever they passed.
 *
 * These overlap the standing `callRulesFor` rules by design — those are what the call is TOLD, these
 * are what `./commit.js` physically refuses. A model that is talked past the first still hits the
 * second, which is the only reason both exist.
 */
export const NEVER_AGREE = [
  "any payment, deposit or card detail, by any route, for any reason",
  "anything that signs the owner up to something recurring",
  "anything presented as needing a decision right now, this second, or the price goes away",
  "speaking or acting as if you are the owner rather than their assistant",
];

/**
 * A brief is a precondition. Same shape as `requireAnnouncement`/`requireCallRules` and called from
 * the same place for the same reason.
 *
 * Checks the things whose absence would make the call quietly worse rather than loudly broken: a
 * brief with no goal (a call with nothing to achieve), a booking brief with no read-back (an
 * agreement nobody repeated), and a ceiling that was set to something that is not a number, which is
 * the one that would otherwise let every price through.
 */
export function requireBrief({ brief }) {
  if (!brief || typeof brief !== "object") {
    return { ok: false, error: "refused: a call needs a brief and none was given." };
  }
  if (!String(brief.goal ?? "").trim()) {
    return { ok: false, error: "refused: a call needs a goal — something the result can settle." };
  }
  if (!Array.isArray(brief.cannotAgree) || !brief.cannotAgree.some(t => /payment|deposit|card/i.test(t))) {
    return { ok: false, error: "refused: the brief does not rule out agreeing to a payment, and no call ever does." };
  }
  const a = brief.approved;
  if (!a || typeof a !== "object" || typeof a.book !== "boolean") {
    return { ok: false, error: "refused: the brief does not say whether this call may agree to anything." };
  }
  if (a.maxCents !== null && !Number.isFinite(Number(a.maxCents))) {
    return { ok: false, error: "refused: the approved ceiling on this call is not a number." };
  }
  if (a.book && !brief.readBack.length) {
    // A call allowed to book with nothing to read back is the exact shape of "they said yes to
    // something and nobody knows what".
    return { ok: false, error: "refused: a call that may book has to name what gets read back before it agrees." };
  }
  return { ok: true, brief };
}

/**
 * The brief as lines in the voice prompt — the part the model has to actually know.
 *
 * `approved` is stated as what it MAY do rather than as a list of prohibitions, because a model told
 * only what it cannot do spends the call apologising. The enforcement is elsewhere; this is so the
 * conversation goes the right way on its own most of the time, and the enforcement is the floor
 * rather than the mechanism.
 */
export function briefLines(brief, { ownerName = config.ownerName } = {}) {
  const b = brief ?? {};
  const out = [];
  if (b.approved?.book) {
    const ceiling = b.approved.maxCents !== null
      ? ` up to ${(b.approved.maxCents / 100).toFixed(2).replace(/\.00$/, "")} dollars`
      : "";
    out.push(`You MAY agree to this on ${ownerName}'s behalf${ceiling}. You may not agree to anything beyond it.`);
    if (b.approved.terms.length) out.push(`Also approved: ${b.approved.terms.join("; ")}.`);
    if (b.approved.upTo) out.push(`${ownerName}'s exact words on what is approved: "${b.approved.upTo}".`);
    out.push(
      `If a price, a fee or a condition comes up that is NOT in what is approved — a deposit, a`
      + ` cancellation rule, a higher number, anything — do not agree and do not refuse. Say you need to`
      + ` check with ${ownerName} and that you will have an answer in a moment, and keep them talking.`,
      // From the 2026-10-07 rehearsal: told about a fifty dollar deposit nobody had approved, it said
      // all the right things out loud — cannot take payment details, will check with Omari, can you
      // send a link — and never called the tool. So no row was written and no text was sent, and the
      // call had promised somebody a check that was never going to happen. Saying it and doing it are
      // different, which is the standing rule everywhere else in Reason too.
      `Call propose_commitment the moment that happens, with the price and every condition they named.`
      + ` That tool is HOW ${ownerName} gets told — it texts them while you are still on the line. Telling`
      + ` the person on the phone that you will check with ${ownerName} does not check with them. If you`
      + ` say you are checking and do not call it, nobody is checking and you have made a promise that`
      + ` will not be kept.`,
    );
  } else {
    out.push(
      `You are ASKING on this call, not agreeing. You may not book, hold, reserve, order or commit to`
      + ` anything at all, even if they offer, even if it is free, and even if it would obviously be`
      + ` what ${ownerName} wants. If they are ready to book, say that sounds good and you will confirm`
      + ` with ${ownerName} and come straight back.`,
    );
  }
  if (b.questions?.length) {
    out.push(`Find out all of these before the call ends, and ask them plainly:\n${b.questions.map(q => `- ${q}`).join("\n")}`);
    out.push(
      `Ask every one of them even if some feel obvious, and get an actual answer rather than an`
      + ` impression. These same questions are being asked everywhere else, so the answers get compared.`,
    );
  }
  const req = Object.entries(b.requirements ?? {}).filter(([, v]) => String(v ?? "").trim());
  if (req.length) {
    out.push(
      `You already have everything they are going to ask you for, so never say you will have to check`
      + ` on any of it:\n${req.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
    );
  }
  if (b.returnNumber) {
    out.push(`If they offer to call back, or ask for a number, give them this one: ${b.returnNumber}. It reaches you.`);
  }
  out.push(`Never agree to any of these, whatever you are asked:\n${(b.cannotAgree ?? []).map(t => `- ${t}`).join("\n")}`);
  return out.join("\n\n");
}

/**
 * A brief for the second call about something that may already have happened.
 *
 * The owner's safe-recovery rule turned into an object. After a call that dropped right after
 * somebody said yes, the next call is NOT the same call again — that is how a booking happens twice.
 * It is a different goal (find out whether it went through) with booking switched off, and it is
 * built here so no caller has to remember to switch it off.
 */
/** The opening of every "did it go through" check's goal; see isWentThroughCheck. */
const CHECK_GOAL = "Find out whether this already went through, and change nothing:";
/** Was this brief one of askWhetherItWentThrough's ask-only checks? */
export const isWentThroughCheck = (brief) => String(brief?.goal ?? "").startsWith(CHECK_GOAL);

export function askWhetherItWentThrough(brief, { what = "", then = null } = {}) {
  const thing = String(what || brief?.goal || "the booking").trim().replace(/[.!?\s]+$/, "");
  // What this call was asked to do NOW, when it is something other than the old errand. It rides
  // along after the check instead of being dropped: the 2026-11-05 call to Yaw lost a brand-new
  // message to the old call's script because only the old brief survived this rewrite.
  const next = then && String(then.goal ?? "").trim() && String(then.goal).trim() !== String(brief?.goal ?? "").trim() ? then : null;
  const base = brief ?? next ?? {};
  return buildBrief({
    ...base,
    goal: `${CHECK_GOAL} ${thing}.`
      + ` The last call dropped before it was confirmed, so it may or may not exist on their side.`
      + ` Ask them to check. If it IS there, read back what they have and confirm those details.`
      + ` If it is NOT there, say you will come back to them — do NOT make it now.`
      + (next ? ` Once that is settled, this call is also for this, asking only: ${String(next.goal).trim()}` : ""),
    facts: next ? [...new Set([...(next.facts ?? []), ...(base.facts ?? [])])] : (base.facts ?? []),
    // The whole point. Even though the original brief may have been allowed to book, this one is not:
    // the one thing that must not happen is a second booking made while checking for the first.
    approved: askOnly(),
    questions: next ? [...(next.questions ?? [])] : [],
  });
}

/**
 * Whether a call is inside the quiet window, and the line to tell the owner when it is not.
 *
 * Third-party calls only; a call to the owner's own phone is never blocked by this, because it is
 * their assistant and a call they asked for at midnight is a call they asked for.
 *
 * Returns `{ok: true}` or `{ok: false, error}` — never a silent skip. His standing rule is that a
 * thing not done is said out loud, and "I didn't ring them because it's half eleven at night" is a
 * useful sentence that a dropped call is not.
 */
export function withinCallingHours({ now = clock.now(), toOwner = false, window: w = config.callQuietHours, tz = config.tz } = {}) {
  if (toOwner) return { ok: true };
  const spec = String(w ?? "").trim();
  if (!spec) return { ok: true };
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec);
  if (!m) return { ok: true }; // an unparseable window blocks nothing rather than blocking everything
  const mins = (h, mi) => Number(h) * 60 + Number(mi);
  const from = mins(m[1], m[2]);
  const to = mins(m[3], m[4]);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(now));
  const hour = Number(p.find(x => x.type === "hour")?.value ?? 0) % 24;
  const minute = Number(p.find(x => x.type === "minute")?.value ?? 0);
  const at = hour * 60 + minute;
  // A window that crosses midnight (21:00-08:00) is the normal case, so the wrap is the main path.
  const inside = from <= to ? at >= from && at < to : at >= from || at < to;
  if (!inside) return { ok: true };
  const pretty = (x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  return {
    ok: false,
    error: `It is ${pretty(at)} where ${config.ownerName} is, and calls to other people are held between`
      + ` ${pretty(from)} and ${pretty(to)} (REASON_CALL_QUIET_HOURS). Nobody's phone rang. Say that plainly —`
      + ` it is the hour, not a failure — and offer to ring them when the window opens, or to do something that is not a call.`,
  };
}
