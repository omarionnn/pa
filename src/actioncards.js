// Action Cards (owner, 2026-11-11): once a day Reason leaves a short note in the thread with a link to
// a page of one-tap offers, each one a thing it noticed it could take off the person's plate
// ("Replace your Anthropic key before it expires Nov 18"). A tap opens Messages with the request
// already typed in the person's own voice; their text comes back here, is matched to the open card
// by its words (no card id travels in the body), runs as the normal turn, and the card is marked
// done when that turn finishes.
//
// This module owns the storage, the signed link, the match and the per-card log. The ENGINE that
// decides which cards exist (what is scooped from Gmail and the calendar, the skip rules, the 7:30
// text) is another build; it writes cards through `createDigest` and asks `wasDismissed` /
// `dismissedTitles` so a thing the person struck out is never offered again.
//
//   REASON_ACTION_CARDS=off     nobody (default): no page, no match, every /a/ address is a plain 404
//   REASON_ACTION_CARDS=owner   only digests belonging to an operator account are served and matched
//   REASON_ACTION_CARDS=on      everybody
//
// The link: heyreason.com/a/<token>. The token is the digest id and an HMAC of it under
// REASON_TOKEN_KEY, so a made-up or altered address is refused before the database is read. A digest
// lives DIGEST_TTL_MS (7 days) or until every card on it is handled, whichever comes first; after
// that the address shows the paper "gone" page (src/pages/actioncards.js). Nothing is ever shown
// without a good token: there is no index, no account page, no cookie.
//
// Encryption at rest: title, why_now and prefill are sealed per person like the rest of a person's
// words (restcrypt SENSITIVE2, phase 2), as is the remembered title of a dismissed card.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import { clock, config } from "./config.js";

export const DIGEST_TTL_MS = 7 * 24 * 3_600_000;
export const STATUSES = Object.freeze(["open", "done", "dismissed"]);
export const EVENTS = Object.freeze(["view", "tap", "reply", "dismiss", "done"]);
/** The most cards one digest carries (the page and its picture are drawn for up to this many). */
export const MAX_CARDS = 4;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS action_digests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    -- set the moment the last open card is handled: the link is gone from then on
    closed_at INTEGER,
    -- the last time any card on it changed state: part of the picture's address, so a phone
    -- fetches a fresh preview after a dismiss or a done
    changed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS action_digests_conv ON action_digests (conversation_id, expires_at);
  CREATE TABLE IF NOT EXISTS action_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    digest_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    -- the short code the page posts back (dismiss, tap): never the row id
    code TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    verb TEXT NOT NULL,
    title TEXT NOT NULL,
    why_now TEXT NOT NULL DEFAULT '',
    -- the first-person request the tap types into Messages, and what a reply is matched against
    prefill TEXT NOT NULL,
    drawing TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS action_cards_digest ON action_cards (digest_id, position);
  CREATE INDEX IF NOT EXISTS action_cards_open ON action_cards (conversation_id, status);
  -- Titles this person struck out, so the engine never offers the same thing again. title_key is the
  -- normalised title's blind index (restcrypt.blindIndex; the plain form with phase 2 off).
  CREATE TABLE IF NOT EXISTS action_card_dismissed (
    conversation_id TEXT NOT NULL,
    title_key TEXT NOT NULL,
    title TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, title_key)
  );
  CREATE TABLE IF NOT EXISTS action_card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER,
    digest_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS action_card_events_card ON action_card_events (card_id, kind);
`);
db.restStrictRefresh();

// ---------------------------------------------------------------- the switch

export function mode() {
  const v = String(process.env.REASON_ACTION_CARDS ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

/** Is this person's digest served and matched under the current switch? */
export function allowedFor(conversationId) {
  const m = mode();
  if (m === "on") return true;
  if (m === "off") return false;
  if (conversationId === config.ownerConversation) return true;
  const a = db.getAccount(conversationId);
  return !!a?.is_operator;
}

// ---------------------------------------------------------------- the token

const ID_RE = /^[A-Za-z0-9_-]{12}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{28}$/;
let bootKey = null;
function key() {
  const k = String(process.env.REASON_TOKEN_KEY ?? "").trim();
  if (k) return k;
  // No key set: links are signed under a key this process made up, so they die with it rather than
  // being unsigned. secretbox.js refuses outright; here a missing key costs links, not safety.
  bootKey ??= randomBytes(32).toString("hex");
  return bootKey;
}
const sigOf = (id) => createHmac("sha256", key()).update(`action-cards:${id}`).digest("base64url").slice(0, 16);
export const tokenOf = (id) => `${id}${sigOf(id)}`;

/** The digest id a token names, or null when the token is not one of ours (shape or signature). */
export function readToken(token) {
  const t = String(token ?? "");
  if (!TOKEN_RE.test(t)) return null;
  const id = t.slice(0, 12), sig = Buffer.from(t.slice(12));
  const want = Buffer.from(sigOf(id));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  return id;
}

/** Where a digest lives: the website's own address, never this install's (owner's domain rule). */
export const siteOrigin = () => (config.siteUrl || process.env.REASON_SITE_URL || "https://heyreason.com").replace(/\/+$/, "");
export const urlOf = (token) => `${siteOrigin()}/a/${token}`;

// ---------------------------------------------------------------- writing

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
function newCode() {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A new digest for one person: up to MAX_CARDS cards, in the order given. Each card: `verb` (the
 * eyebrow word, REPLACE / PLAN / DIAGNOSE), `title` (second person, what Reason noticed), `whyNow`
 * (the margin note), `prefill` (first person, what the tap types), `drawing` (a key in
 * src/pages/actionart.js). Returns the digest with its token and link.
 */
export function createDigest(conversationId, cards, { now = clock.now(), ttlMs = DIGEST_TTL_MS } = {}) {
  const list = (Array.isArray(cards) ? cards : []).slice(0, MAX_CARDS).map(c => ({
    verb: clean(c.verb, 24).toUpperCase() || "DO",
    title: clean(c.title, 140),
    whyNow: clean(c.whyNow ?? c.why_now ?? c.why, 200),
    prefill: clean(c.prefill ?? c.reply, 200),
    drawing: clean(c.drawing ?? c.art, 32).toLowerCase(),
  })).filter(c => c.title && c.prefill);
  if (!list.length) throw new Error("a digest needs at least one card with a title and a prefill");
  const id = randomBytes(9).toString("base64url");
  db.atomically(() => {
    db.db.prepare("INSERT INTO action_digests (id, conversation_id, created_at, expires_at, changed_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, conversationId, now, now + ttlMs, now);
    const ins = db.db.prepare("INSERT INTO action_cards (digest_id, conversation_id, code, position, verb, title, why_now, prefill, drawing, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)");
    list.forEach((c, i) => {
      for (let tries = 0; ; tries++) {
        try { ins.run(id, conversationId, newCode(), i + 1, c.verb, db.seal2(conversationId, c.title), db.seal2(conversationId, c.whyNow), db.seal2(conversationId, c.prefill), c.drawing, now); return; }
        catch (e) { if (tries > 4 || !/UNIQUE/.test(e?.message ?? "")) throw e; }
      }
    });
  });
  return digestById(id, { now });
}

const cardRows = (digestId, conversationId) => db.db.prepare("SELECT * FROM action_cards WHERE digest_id = ? AND conversation_id = ? ORDER BY position").all(digestId, conversationId);
// The one lookup with no owner in it: the digest id IS the identity (it only arrives inside a signed
// token, readToken), and every statement after it names the owner the row gave. On the scope baseline.
const digestRow = (id) => db.db.prepare("SELECT * FROM action_digests WHERE id = ?").get(id) ?? null;

/** One digest with its cards (every status), or null. `gone` says the link no longer opens. */
export function digestById(id, { now = clock.now() } = {}) {
  if (!ID_RE.test(String(id ?? ""))) return null;
  const d = digestRow(id);
  if (!d) return null;
  const cards = cardRows(id, d.conversation_id);
  return {
    id: d.id, token: tokenOf(d.id), url: urlOf(tokenOf(d.id)),
    conversationId: d.conversation_id, createdAt: d.created_at, expiresAt: d.expires_at, closedAt: d.closed_at ?? null, changedAt: d.changed_at,
    gone: now >= d.expires_at || d.closed_at != null,
    cards: cards.map(c => ({
      id: c.id, code: c.code, position: c.position, verb: c.verb, title: c.title, whyNow: c.why_now, prefill: c.prefill,
      drawing: c.drawing, status: c.status, createdAt: c.created_at, resolvedAt: c.resolved_at ?? null,
    })),
  };
}

/**
 * What a token opens: null for a token that is not ours or names nothing; a digest with `gone` for
 * one that has run out; otherwise the digest. The switch is applied here, so a digest the switch
 * leaves out reads as nothing at all.
 */
export function viewByToken(token, { now = clock.now() } = {}) {
  const id = readToken(token);
  if (!id) return null;
  const d = digestById(id, { now });
  if (!d || !allowedFor(d.conversationId)) return null;
  return d;
}

/** A short word for the digest's state, part of the picture's address so a change refetches it. */
export const stateVersion = (d) => `${d.changedAt.toString(36)}${d.cards.map(c => c.status[0]).join("")}`;

function touch(digestId, conversationId, now) {
  const open = db.db.prepare("SELECT COUNT(*) AS n FROM action_cards WHERE digest_id = ? AND conversation_id = ? AND status = 'open'").get(digestId, conversationId)?.n ?? 0;
  db.db.prepare("UPDATE action_digests SET changed_at = ?, closed_at = CASE WHEN ? = 0 AND closed_at IS NULL THEN ? ELSE closed_at END WHERE id = ? AND conversation_id = ?").run(now, open, now, digestId, conversationId);
}

function event(kind, card, now = clock.now()) {
  db.db.prepare("INSERT INTO action_card_events (card_id, digest_id, conversation_id, kind, at) VALUES (?, ?, ?, ?, ?)")
    .run(card.id ?? null, card.digest_id ?? card.digestId, card.conversation_id ?? card.conversationId, kind, now);
}

/** The page was opened. */
export function viewed(digest, now = clock.now()) {
  event("view", { id: null, digestId: digest.id, conversationId: digest.conversationId }, now);
}

/** The person tapped a card (the page tells us just before it opens Messages). */
export function tapped(digestId, code, now = clock.now()) {
  const c = cardByCode(digestId, code);
  if (!c) return false;
  event("tap", c, now);
  return true;
}

function cardByCode(digestId, code) {
  if (!CODE_RE.test(String(code ?? ""))) return null;
  const d = digestRow(digestId);
  if (!d) return null;
  return db.db.prepare("SELECT * FROM action_cards WHERE digest_id = ? AND conversation_id = ? AND code = ?").get(digestId, d.conversation_id, code) ?? null;
}

/**
 * The person struck a card out. Recorded at once (there is no confirm), and its title is remembered
 * for this person so the engine never offers it again. Idempotent: striking a card twice is one strike.
 */
export function dismiss(digestId, code, { now = clock.now() } = {}) {
  const c = cardByCode(digestId, code);
  if (!c) return null;
  if (c.status === "open") {
    db.atomically(() => {
      db.db.prepare("UPDATE action_cards SET status = 'dismissed', resolved_at = ? WHERE id = ? AND conversation_id = ? AND status = 'open'").run(now, c.id, c.conversation_id);
      rememberDismissed(c.conversation_id, c.title, now);
      event("dismiss", c, now);
      touch(digestId, c.conversation_id, now);
    });
  }
  return { ...c, status: "dismissed" };
}

/** A card's task finished (its reply came back and ran): checked off. The card must be this person's. */
export function markDone(cardId, conversationId, { now = clock.now() } = {}) {
  const c = db.db.prepare("SELECT * FROM action_cards WHERE id = ? AND conversation_id = ?").get(cardId, conversationId);
  if (!c) return null;
  if (c.status === "open") {
    db.atomically(() => {
      db.db.prepare("UPDATE action_cards SET status = 'done', resolved_at = ? WHERE id = ? AND conversation_id = ? AND status = 'open'").run(now, c.id, conversationId);
      event("done", c, now);
      touch(c.digest_id, conversationId, now);
    });
  }
  return { ...c, status: "done" };
}

/** A text matched this card and is running as its task. */
export function replied(card, now = clock.now()) {
  event("reply", { id: card.id, digestId: card.digestId ?? card.digest_id, conversationId: card.conversationId ?? card.conversation_id }, now);
}

/** The log for one of this person's cards: how many of each kind. */
export function counts(cardId, conversationId) {
  const out = Object.fromEntries(EVENTS.map(k => [k, 0]));
  for (const r of db.db.prepare("SELECT kind, COUNT(*) AS n FROM action_card_events WHERE card_id = ? AND conversation_id = ? GROUP BY kind").all(cardId, conversationId)) out[r.kind] = r.n;
  return out;
}

// ---------------------------------------------------------------- what the engine asks

const titleKey = (conversationId, title) => db.restcrypt.blindIndex("action_title", normalize(title));
function rememberDismissed(conversationId, title, now) {
  db.db.prepare("INSERT OR REPLACE INTO action_card_dismissed (conversation_id, title_key, title, at) VALUES (?, ?, ?, ?)")
    .run(conversationId, titleKey(conversationId, title), db.seal2(conversationId, title), now);
}

/** Has this person struck out a card with (as good as) this title before? Exact after normalising. */
export function wasDismissed(conversationId, title) {
  const forms = db.restcrypt.blindIndexes("action_title", normalize(title));
  const row = db.db.prepare(`SELECT 1 FROM action_card_dismissed WHERE conversation_id = ? AND title_key IN (${forms.map(() => "?").join(",")})`).get(conversationId, ...forms);
  return !!row;
}

/** Every title this person has struck out, newest first (plain words, for the engine's skip rules). */
export function dismissedTitles(conversationId) {
  return db.db.prepare("SELECT title FROM action_card_dismissed WHERE conversation_id = ? ORDER BY at DESC").all(conversationId).map(r => r.title);
}

/** This person's open cards on digests that still open, newest digest first. */
export function openCards(conversationId, { now = clock.now() } = {}) {
  return db.db.prepare(`SELECT c.*, d.expires_at FROM action_cards c JOIN action_digests d ON d.id = c.digest_id
    WHERE c.conversation_id = ? AND c.status = 'open' AND d.closed_at IS NULL AND d.expires_at > ? ORDER BY d.created_at DESC, c.position`).all(conversationId, now)
    .map(c => ({ id: c.id, digestId: c.digest_id, conversationId: c.conversation_id, code: c.code, position: c.position, verb: c.verb, title: c.title, whyNow: c.why_now, prefill: c.prefill, drawing: c.drawing, status: c.status }));
}

// ---------------------------------------------------------------- matching a text to a card

/**
 * The match: a text is the card's request when its words are (nearly) the prefill's. Both sides are
 * normalised (lower case, curly quotes straightened, punctuation dropped, "you/your" read as
 * "I/my" so the title matches too) and compared as word sets with Sørensen–Dice:
 * 2·|A∩B| / (|A|+|B|). At or above MATCH_THRESHOLD (0.75) it is the card: an unedited prefill
 * scores 1; one with "please" on the end ~0.95; the title retyped as the person would say it
 * ~0.85; a one-word change in a nine-word line ~0.89. A text that merely shares a subject
 * ("what about my key") lands near 0.3 and runs as itself. A text that contains the whole prefill
 * ("hey, replace my Anthropic key before it expires Nov 18") is the card too.
 */
export const MATCH_THRESHOLD = 0.75;

const SWAP = { you: "i", your: "my", yours: "mine", youre: "im", yourself: "myself" };
export function normalize(text, { firstPerson = false } = {}) {
  let s = String(text ?? "").toLowerCase().replace(/[‘’“”]/g, "'").replace(/'/g, "");
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!firstPerson) return s;
  return s.split(" ").map(w => SWAP[w] ?? w).join(" ");
}
const words = (s) => new Set(s.split(" ").filter(Boolean));
export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}
export function scoreAgainst(text, card) {
  const t = normalize(text);
  if (!t) return 0;
  const p = normalize(card.prefill), ti = normalize(card.title, { firstPerson: true });
  if (p && (t === p || t.includes(p))) return 1;
  return Math.max(similarity(t, p), similarity(t, ti));
}

/**
 * The open card a text is answering, for this person, or null. `texts` is what arrived this turn
 * (joined). Nothing is read when the switch leaves them out, so a turn costs nothing extra.
 */
export function matchInbound(conversationId, texts, { now = clock.now() } = {}) {
  if (!allowedFor(conversationId)) return null;
  const text = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join(" ");
  if (!text.trim()) return null;
  let best = null;
  for (const c of openCards(conversationId, { now })) {
    const score = scoreAgainst(text, c);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { card: c, score };
  }
  return best;
}

// ---------------------------------------------------------------- the way back to Messages

/**
 * The sms: address a tap opens. iOS reads `sms:NUMBER&body=` (Apple's own form; `?body=` is dropped
 * by Messages on some versions), Android reads `sms:NUMBER?body=`. The page is drawn with the
 * Apple form and swaps in `?` for a non-Apple browser (src/pages/actioncards.js). "" when Reason has
 * no number to text from.
 */
export function smsHref(body, { apple = true, number = reasonNumber() } = {}) {
  if (!number) return "";
  return `sms:${number}${apple ? "&" : "?"}body=${encodeURIComponent(String(body ?? ""))}`;
}
export function reasonNumber() {
  const raw = String(config.sendblueFrom || config.linqFrom || "").replace(/[^\d+]/g, "");
  if (!raw) return "";
  return raw.startsWith("+") ? raw : `+${raw}`;
}
