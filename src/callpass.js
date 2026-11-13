// A person's call passphrase (owner decision 2026-11-13): asked for on a call only at the moment
// something needs it, like Face ID before a payment, never at the start of a call.
//
// What is kept: a salted scrypt hash of the normalised phrase, per person, in data/logins.db beside the
// saved logins (src/savedlogins.js LOGINS_SCHEMA, call_passphrases), so a copy of reason.db never
// carries it and an export and a delete cover it the same way. Never the phrase, never a word of it;
// the number of words is kept (the hash needs it to know which tolerance applies).
//
// Normalised: lower case, punctuation gone, numbers as words ("7" and "seven" are the same word,
// "twenty-one" and "21" too), one space between words.
//
// The tolerance, for speech-to-text slips: the same number of words, and
//   3 or 4 words  every word must match;
//   5 or more     every word, or all but one (one misheard word, "heron" heard as "herring").
// Held as one hash of the whole phrase plus, for five or more words, one hash per word position of the
// phrase with that word blanked. Each of those still needs four or more words guessed together, so the
// tolerance never makes a single word guessable on its own (a hash per word would). A dropped or an
// added word is not tolerated: that would need many more hashes, and the count staying the same is
// what keeps a guesser from trying shorter phrases. A few words of filler in front ("it's", "my
// passphrase is") are taken off before the compare.
//
// Set two ways. On a call (src/calls/calltrust.js): kept as PENDING until a typed yes in their own
// thread, because caller ID alone is not proof; no yes within 24 h and it is gone. By text: "set my call
// passphrase" gets a link to Reason's own page (src/pages/callpassphrase.js); the phrase is typed there,
// never in the thread, and is active at once. Changed by text only (the same page); removed by text
// only, after a typed yes.
//
// REASON_CALL_TRUST = off | owner | on (default off), read at call time like REASON_SAVED_LOGINS.
// Off: nothing in this file is reached by anybody.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config, clock } from "./config.js";
import * as accounts from "./accounts.js";
import { loginsDb } from "./savedlogins.js";
import { typedOnly } from "./trust.js";

// ---------------------------------------------------------------- the switch
export function callTrustMode() {
  const v = String(process.env.REASON_CALL_TRUST ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
/** On for this person: on for everyone, or owner and this is the operator's account. */
export function callTrustFor(conversationId) {
  if (!conversationId) return false;
  const mode = callTrustMode();
  if (mode === "off") return false;
  if (mode === "owner") { try { return accounts.featureOwner(conversationId); } catch { return false; } }
  return true;
}

// ---------------------------------------------------------------- fixed words
/** Texts and page words. Short, plain, fixed; nothing here is written by the model. */
export const WORDS = {
  link: "Here's a link to set your call passphrase on Reason's own page. Type it there, not here: I never see it.",
  linkChange: "Here's a link to change your call passphrase on Reason's own page. Type the new one there, not here.",
  activateAsk: "You set a call passphrase on our call just now. Reply yes to turn it on.",
  activated: "Your call passphrase is on. I'll only ask for it on a call when something needs it.",
  removeAsk: "Reply yes to remove your call passphrase.",
  removed: "Your call passphrase is removed.",
  noneSet: "You don't have a call passphrase set. Text me 'set my call passphrase' to set one.",
  off: "Call passphrases aren't on for your account yet.",
};

/** The words that ask for a set-up by text, a change, and a removal. Only the whole message counts. */
const SET_TEXT = /^\s*(?:please\s+)?(?:set|create|make)\s+(?:up\s+)?(?:my|a)\s+call\s+pass\s?phrase\s*[.!]?\s*$/i;
const CHANGE_TEXT = /^\s*(?:please\s+)?(?:change|reset|update)\s+my\s+call\s+pass\s?phrase\s*[.!]?\s*$/i;
const REMOVE_TEXT = /^\s*(?:please\s+)?(?:remove|delete|turn\s+off)\s+my\s+call\s+pass\s?phrase\s*[.!]?\s*$/i;
/** A typed yes and nothing else: "yes", "Yes.", "yes!" */
export const TYPED_YES = /^\s*yes\s*[.!]?\s*$/i;

// ---------------------------------------------------------------- normalising
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function under100(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function under1000(n) {
  if (n < 100) return under100(n);
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${under100(n % 100)}` : ""}`;
}
/** Digits as a speech-to-text writes them out: up to 9999 as a number, longer runs digit by digit. */
export function numberWords(digits) {
  const s = String(digits);
  if (s.length > 4 || (s.length > 1 && s.startsWith("0"))) return [...s].map(d => ONES[Number(d)]).join(" ");
  const n = Number(s);
  if (n < 1000) return under1000(n);
  return `${ONES[Math.floor(n / 1000)]} thousand${n % 1000 ? ` ${under1000(n % 1000)}` : ""}`;
}

/** The phrase as compared: words, lower case, numbers as words, no punctuation. */
export function normalWords(s) {
  const t = String(s ?? "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/(\d)[,](\d)/g, "$1$2")
    .replace(/\d+/g, (d) => ` ${numberWords(d)} `)
    .replace(/['’]/g, "")
    .replace(/[^a-z\s]+/g, " ");
  return t.split(/\s+/).filter(Boolean);
}

/** Filler a person may say in front of it. Taken off only when what is left is the right length. */
const LEADS = [["its"], ["it", "is"], ["my", "passphrase", "is"], ["the", "passphrase", "is"], ["passphrase"], ["my", "passphrase"],
  ["ok"], ["okay"], ["um"], ["uh"], ["so"], ["yes"], ["yeah"]];
function candidates(words, n) {
  const out = [words];
  let w = words;
  for (let k = 0; k < 3 && w.length > n; k++) {
    const lead = LEADS.find(l => l.every((x, i) => w[i] === x));
    if (!lead) break;
    w = w.slice(lead.length);
    if (w.length === n) { out.push(w); break; }
  }
  return out.filter(c => c.length === n).slice(0, 2);
}

// ---------------------------------------------------------------- hashing
/**
 * scrypt N=2^13, r=8 (8 MiB, ~15-25 ms a hash here). A check runs on the call's own thread: one hash when
 * it matches; on a miss with 5+ words, one per word position for each of at most two readings, so at most
 * 18 (8 words) — a few hundred ms, once, after the caller has finished speaking.
 */
const SCRYPT = { N: 1 << 13, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
export const MIN_WORDS = 3;
export const MAX_WORDS = 8;
/** From this many words up, one word may be misheard. */
export const TOLERANT_FROM = 5;
const BLANK = "\u0000";
const hashOf = (salt, words, tag) => scryptSync(`call-passphrase-v1|${tag}|${words.join(" ")}`, salt, 32, SCRYPT).toString("base64url");

/** The stored form of a phrase: { v, salt, n, full, loo }. Never the phrase. */
export function hashPhrase(phrase) {
  const words = normalWords(phrase);
  if (words.length < MIN_WORDS || words.length > MAX_WORDS) return null;
  const salt = randomBytes(16).toString("base64url");
  const rec = { v: 1, salt, n: words.length, full: hashOf(salt, words, "full") };
  if (words.length >= TOLERANT_FROM) rec.loo = words.map((_, i) => hashOf(salt, words.map((w, j) => (j === i ? BLANK : w)), `blank${i}`));
  return rec;
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Does what was said match the stored phrase? "exact" | "near" (one word off, 5+ words) | null. */
export function phraseMatches(spoken, rec) {
  if (!rec?.salt || !rec?.full || !rec?.n) return null;
  const tries = candidates(normalWords(spoken), rec.n);
  // A wrong length still costs one hash, so the time taken does not say the count was wrong.
  if (!tries.length) { hashOf(rec.salt, ["x"], "full"); return null; }
  for (const w of tries) if (same(hashOf(rec.salt, w, "full"), rec.full)) return "exact";
  if (rec.n >= TOLERANT_FROM && Array.isArray(rec.loo)) {
    for (const w of tries) {
      for (let i = 0; i < rec.n; i++) {
        if (same(hashOf(rec.salt, w.map((x, j) => (j === i ? BLANK : x)), `blank${i}`), rec.loo[i])) return "near";
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- the store (data/logins.db)
const PENDING_MS = 24 * 3600_000;
const LINK_MS = 30 * 60_000;
/** Wrong passphrases across all of a person's calls in a day before voice is off for the rest of it. */
export const DAILY_MISSES = 6;
const DAY_MS = 24 * 3600_000;

const d = (create = false) => loginsDb({ create });
const rowOf = (c) => d()?.prepare("SELECT * FROM call_passphrases WHERE conversation_id = ?").get(String(c)) ?? null;
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
function upsert(c, fields) {
  const db = d(true);
  db.prepare("INSERT OR IGNORE INTO call_passphrases (conversation_id) VALUES (?)").run(String(c));
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE call_passphrases SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE conversation_id = ?`).run(...keys.map(k => fields[k]), String(c));
}

/** The active phrase's stored form, or null. A pending one past its day is dropped on the way. */
export function activeFor(c, now = clock.now()) {
  const r = rowOf(c);
  if (r?.pending_hash && Number(r.pending_set_at ?? 0) + PENDING_MS < now) dropPending(c);
  return r?.active_hash ? parse(r.active_hash) : null;
}
export const hasPassphrase = (c, now) => Boolean(activeFor(c, now));

/** Set and active at once (the page, from their own thread's link). False when the phrase is too short or long. */
export function setActive(c, phrase, { how = "text", now = clock.now() } = {}) {
  const rec = hashPhrase(phrase);
  if (!rec) return false;
  upsert(c, { active_hash: JSON.stringify(rec), active_set_how: how, active_set_at: now, active_words: rec.n, misses: 0, misses_since: null });
  return true;
}

/** Set on a call: kept pending until a typed yes. Returns { words, first } for the read-back, or null. */
export function setPending(c, phrase, { callId = null, now = clock.now() } = {}) {
  const words = normalWords(phrase);
  const rec = hashPhrase(phrase);
  if (!rec) return null;
  upsert(c, { pending_hash: JSON.stringify(rec), pending_set_at: now, pending_call_id: callId, pending_asked_outbox: null });
  return { words: words.length, first: words[0] };
}
export function pendingFor(c, now = clock.now()) {
  const r = rowOf(c);
  if (!r?.pending_hash) return null;
  if (Number(r.pending_set_at ?? 0) + PENDING_MS < now) { dropPending(c); return null; }
  return { callId: r.pending_call_id, setAt: r.pending_set_at, askedOutbox: r.pending_asked_outbox };
}
export function dropPending(c) {
  d()?.prepare("UPDATE call_passphrases SET pending_hash = NULL, pending_set_at = NULL, pending_call_id = NULL, pending_asked_outbox = NULL WHERE conversation_id = ?").run(String(c));
}
export function notePendingAsked(c, outboxId) { upsert(c, { pending_asked_outbox: outboxId ?? null }); }

/** Pending → active, after their typed yes. */
export function activatePending(c, now = clock.now()) {
  const r = rowOf(c);
  if (!r?.pending_hash || Number(r.pending_set_at ?? 0) + PENDING_MS < now) return false;
  const rec = parse(r.pending_hash);
  upsert(c, { active_hash: r.pending_hash, active_set_how: "call", active_set_at: now, active_words: rec?.n ?? null, misses: 0, misses_since: null });
  dropPending(c);
  return true;
}

export function removeActive(c) {
  d()?.prepare("UPDATE call_passphrases SET active_hash = NULL, active_set_how = NULL, active_set_at = NULL, active_words = NULL, removal_asked_outbox = NULL WHERE conversation_id = ?").run(String(c));
}

/** How many times this person has been told about call passphrases (said at most twice, ever). */
export function toldCount(c) { return Number(rowOf(c)?.told_count ?? 0); }
export function noteTold(c) { upsert(c, { told_count: toldCount(c) + 1 }); }

/** A wrong passphrase, counted across their calls; true once voice is off for the rest of the day. */
export function noteMiss(c, now = clock.now()) {
  const r = rowOf(c);
  const fresh = !r?.misses_since || now - Number(r.misses_since) > DAY_MS;
  upsert(c, { misses: fresh ? 1 : Number(r.misses ?? 0) + 1, misses_since: fresh ? now : r.misses_since });
  return lockedOut(c, now);
}
export function lockedOut(c, now = clock.now()) {
  const r = rowOf(c);
  return Boolean(r?.misses_since) && now - Number(r.misses_since) <= DAY_MS && Number(r.misses ?? 0) >= DAILY_MISSES;
}

/** Check a spoken phrase against their active one: "exact" | "near" | null. */
export function check(c, spoken, now = clock.now()) {
  const rec = activeFor(c, now);
  return rec ? phraseMatches(spoken, rec) : null;
}

// ---------------------------------------------------------------- the page's link
const tokenHash = (t) => createHash("sha256").update(`call-passphrase|${t}`).digest("hex");
export const LINK_PATH = "/web/call-passphrase/";
/** A one-use link for 30 minutes; only its hash is kept. */
export function makeLink(c, purpose = "set", { now = clock.now(), base = config.publicUrl } = {}) {
  const token = randomBytes(24).toString("base64url");
  d(true).prepare("INSERT INTO call_passphrase_links (token_hash, conversation_id, purpose, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), String(c), purpose, now + LINK_MS);
  return `${String(base ?? "").replace(/\/+$/, "")}${LINK_PATH}${token}`;
}
/** The link's row while it is usable, else null. */
export function linkFor(token, now = clock.now()) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ""))) return null;
  const r = d()?.prepare("SELECT * FROM call_passphrase_links WHERE token_hash = ?").get(tokenHash(token));
  if (!r || r.used_at || Number(r.expires_at) < now) return null;
  return r;
}
/** The page's POST: the phrase is hashed here and the link spent. Never logged, never returned. */
export function saveFromLink(token, phrase, { now = clock.now() } = {}) {
  const r = linkFor(token, now);
  if (!r || !callTrustFor(r.conversation_id)) return { ok: false, error: "link" };
  const words = normalWords(phrase);
  if (words.length < MIN_WORDS) return { ok: false, error: "short" };
  if (words.length > MAX_WORDS) return { ok: false, error: "long" };
  const spent = d(true).prepare("UPDATE call_passphrase_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(now, r.token_hash);
  if (!Number(spent.changes)) return { ok: false, error: "link" };
  setActive(r.conversation_id, phrase, { how: "text", now });
  dropPending(r.conversation_id);
  return { ok: true, conversationId: r.conversation_id };
}

// ---------------------------------------------------------------- their own text thread
/** The newest message queued to this person; a typed yes answers ours only when ours is still the last. */
function lastOutboxId(c, reasonDb) {
  try { return reasonDb.prepare("SELECT id FROM outbox WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(String(c))?.id ?? null; } catch { return null; }
}

/**
 * A text from their own thread (src/channels/router.js, at intake, before the turn): the set-up, change
 * and removal words, and a typed yes to a pending phrase or a removal. Returns { reply, kind } when code
 * answers it and no turn runs, else null. Only the whole message counts, only what they TYPED
 * (trust.typedOnly: never an attachment's text, a card or a page), and a yes only while the question it
 * answers is the last thing Reason sent them.
 */
export function fromText({ conversationId, text, channel = "", reasonDb, now = clock.now() } = {}) {
  const c = String(conversationId ?? "");
  if (!c || !callTrustFor(c) || typeof text !== "string") return null;
  const typed = typedOnly(text).trim();
  if (!typed || typed.length > 80) return null;
  if (SET_TEXT.test(typed)) {
    if (hasPassphrase(c, now)) return { kind: "change_link", reply: WORDS.linkChange, link: makeLink(c, "change", { now }) };
    return { kind: "set_link", reply: WORDS.link, link: makeLink(c, "set", { now }) };
  }
  if (CHANGE_TEXT.test(typed)) {
    if (!hasPassphrase(c, now)) return { kind: "none_set", reply: WORDS.noneSet };
    return { kind: "change_link", reply: WORDS.linkChange, link: makeLink(c, "change", { now }) };
  }
  if (REMOVE_TEXT.test(typed)) {
    if (!hasPassphrase(c, now)) return { kind: "none_set", reply: WORDS.noneSet };
    upsert(c, { removal_asked_outbox: -1 });
    return { kind: "remove_ask", reply: WORDS.removeAsk, noteOutbox: (id) => upsert(c, { removal_asked_outbox: id ?? null }) };
  }
  if (TYPED_YES.test(typed) && channel !== "web") {
    const r = rowOf(c);
    const last = reasonDb ? lastOutboxId(c, reasonDb) : null;
    if (r?.removal_asked_outbox && r.removal_asked_outbox !== -1 && last != null && Number(last) === Number(r.removal_asked_outbox)) {
      removeActive(c);
      return { kind: "removed", reply: WORDS.removed };
    }
    const p = pendingFor(c, now);
    if (p?.askedOutbox && last != null && Number(last) === Number(p.askedOutbox)) {
      if (activatePending(c, now)) return { kind: "activated", reply: WORDS.activated };
    }
  }
  return null;
}

/** For an export: that a phrase is set, how and when. Never the hash, the salt or a word. */
export function exportFor(conversationId) {
  const db = d();
  if (!db) return [];
  const all = conversationId === null;
  if (!all && !conversationId) return [];
  return db.prepare(`SELECT conversation_id, active_set_how AS set_how, active_set_at AS set_at, active_words AS words,
      CASE WHEN pending_hash IS NULL THEN 0 ELSE 1 END AS pending, pending_set_at, told_count
    FROM call_passphrases${all ? "" : " WHERE conversation_id = ?"} ORDER BY conversation_id`).all(...(all ? [] : [String(conversationId)]));
}
