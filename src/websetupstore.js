// The web setup's rows (src/websetup.js owns the flow). Kept apart from the flow so the connect gate
// (src/connectgate.js) can ask "whose setup is this browser's?" without importing the flow's own
// imports (onboarding, Amazon, sign-in) back into itself.
//
// A setup is what a visitor on heyreason.com/start builds before they have texted Reason: their name,
// the name they gave Reason, and anything they connected. It has no phone number and no conversation
// yet, so it is held under a stand-in conversation id, `websetup:<id>`, that no account ever has. Its
// connections (a Google grant, an Amazon sign-in in Reason's browser) are saved under that stand-in,
// and move to the real conversation when their first text carries the setup's code (claim, below).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import { clock } from "./config.js";

export const PREFIX = "websetup:";
export const COOKIE = "rs_setup";
export const TTL_MS = 24 * 3_600_000;
/** Four characters people can read off a text without mixing them up: no 0/o, 1/l/i. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS web_setups (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    code TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    reason_name TEXT NOT NULL DEFAULT '',
    email_state TEXT NOT NULL DEFAULT '',
    amazon_state TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_by TEXT,
    claimed_at INTEGER,
    origin TEXT NOT NULL DEFAULT '',
    misses INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS web_setups_code ON web_setups (code);
  CREATE INDEX IF NOT EXISTS web_setups_claimed ON web_setups (claimed_by);
`);
// Columns added after the table first shipped to a test DB (harmless when already there).
// The ready screen's way in (first-text, 11-17): tapped_at is when the page reported its text button
// was tapped; nudged_at when the inviter was told the first text had not come; textme_* is "i can
// text you first": the number they gave, as a hash salted with this setup's own secret hash (never
// the number), how many times it was set, how many first texts were tried, and when.
for (const col of ["origin TEXT NOT NULL DEFAULT ''", "misses INTEGER NOT NULL DEFAULT 0", "uber_state TEXT NOT NULL DEFAULT ''", "card_state TEXT NOT NULL DEFAULT ''", "invite_id INTEGER",
  "tapped_at INTEGER", "nudged_at INTEGER", "textme_hash TEXT", "textme_sets INTEGER NOT NULL DEFAULT 0", "textme_sends INTEGER NOT NULL DEFAULT 0", "textme_at INTEGER"]) {
  try { db.db.exec(`ALTER TABLE web_setups ADD COLUMN ${col}`); } catch { /* exists */ }
}
// Counts that outlive the setups (a setup row is deleted a day after it was made, unclaimed): when a
// ready screen's text button was tapped, when a first text arrived, when Reason tried to text first.
// No names, no numbers, no setup ids: a time, a kind and (for the per-invite cap) the invite.
db.db.exec(`
  CREATE TABLE IF NOT EXISTS web_setup_marks (
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    invite_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS web_setup_marks_kind ON web_setup_marks (kind, at);
`);
// Once claimed, a setup keeps no name and no phone (encryption at rest, #425/#438): both names are
// blanked (the account holds its own copies) and `claimed_by` is the conversation's keyed blind index
// (restcrypt.blindIndex, phase 2; the plain id when phase 2 is off), matched, never read back.
const owner = (conversationId) => db.restcrypt.blindIndex("conversation", String(conversationId ?? ""));
const ownerForms = (conversationId) => db.restcrypt.blindIndexes("conversation", String(conversationId ?? ""));
// The export/delete scope (src/data.js CHILD_SCOPE) matches a conversation id against this column.
// Hashed whenever the index key exists (blindIndexes), so rows hashed before REASON_ENCRYPT_REST2 was
// turned off are still reached; the plain form is matched by the `?` beside it.
try { db.db.function("websetup_owner", { deterministic: true }, (c) => { const f = ownerForms(c); return f[f.length - 1]; }); } catch { /* registered */ }
/** Rows claimed before this: names blanked, owners hashed (idempotent, every boot). */
export function scrubClaimed() {
  db.atomically(() => scrubRows());
}
function scrubRows() {
  db.db.prepare("UPDATE web_setups SET user_name = '', reason_name = '' WHERE claimed_by IS NOT NULL AND (user_name != '' OR reason_name != '')").run();
  for (const r of db.db.prepare("SELECT id, claimed_by FROM web_setups WHERE claimed_by IS NOT NULL AND claimed_by NOT LIKE 'bi1:%'").all()) {
    const h = owner(r.claimed_by);
    if (h !== r.claimed_by) db.db.prepare("UPDATE web_setups SET claimed_by = ? WHERE id = ?").run(h, r.id);
  }
}
// Never in the way of a boot: a missing index key is reported by restcrypt.ensureIndexKey on its own.
try { scrubClaimed(); } catch (e) { console.error("websetup scrub:", (e?.message ?? String(e)).split("\n")[0]); }

/** A code whose text came with the wrong names this many times is shut: guessing a code is not enough. */
export const MAX_MISSES = 5;

const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
export const conversationOf = (id) => `${PREFIX}${id}`;
export const isSetupConversation = (c) => String(c ?? "").startsWith(PREFIX);
export const idOf = (c) => isSetupConversation(c) ? String(c).slice(PREFIX.length) : null;

function newCode() {
  for (let i = 0; i < 20; i++) {
    const b = randomBytes(4);
    const code = [...b].map(x => ALPHABET[x % ALPHABET.length]).join("");
    // Unique among setups still open, so a code names one setup.
    if (!db.db.prepare("SELECT 1 FROM web_setups WHERE code = ? AND claimed_by IS NULL AND expires_at > ?").get(code, clock.now())) return code;
  }
  throw new Error("no free setup code");
}

/** A new setup: its id (in the page's address), its secret (the browser's cookie, stored hashed) and its code. */
// invite_id: the invite a setup was started from (REASON_INVITE_START, src/websetup.js). A reference
// only: the invite is spent when the setup's first text makes the account, never when the page opens.
export function create(now = clock.now(), { origin = "", inviteId = null } = {}) {
  const id = randomBytes(12).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const code = newCode();
  db.db.prepare("INSERT INTO web_setups (id, secret_hash, code, created_at, expires_at, origin, invite_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, hash(secret), code, now, now + TTL_MS, String(origin ?? ""), inviteId == null ? null : Number(inviteId));
  return { id, secret, code, expiresAt: now + TTL_MS };
}

export function get(id, now = clock.now()) {
  const row = db.db.prepare("SELECT * FROM web_setups WHERE id = ?").get(String(id ?? ""));
  if (!row || row.expires_at <= now) return null;
  return row;
}

/** The setup this browser holds (its cookie), if it is this id's and still open. */
export function owned(id, secret, now = clock.now()) {
  const row = get(id, now);
  if (!row || row.claimed_by || !secret) return null;
  const a = Buffer.from(row.secret_hash, "hex"), b = Buffer.from(hash(secret), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}

/** Whose stand-in conversation this browser's setup cookie is, or null (any cookie, any open setup). */
export function conversationForSecret(secret, now = clock.now()) {
  if (!secret) return null;
  const row = db.db.prepare("SELECT id FROM web_setups WHERE secret_hash = ? AND claimed_by IS NULL AND expires_at > ?").get(hash(secret), now);
  return row ? conversationOf(row.id) : null;
}

export function readSecret(cookieHeader) {
  for (const part of String(cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE && v.join("=")) return v.join("=");
  }
  return null;
}

export function save(id, { user, reasonName } = {}) {
  if (user !== undefined) db.db.prepare("UPDATE web_setups SET user_name = ? WHERE id = ?").run(String(user), id);
  if (reasonName !== undefined) db.db.prepare("UPDATE web_setups SET reason_name = ? WHERE id = ?").run(String(reasonName), id);
}

const STATE_COL = { email: "email_state", amazon: "amazon_state", uber: "uber_state", card: "card_state" };
export function setConnectState(id, which, state) {
  const col = STATE_COL[which];
  if (!col) throw new Error(`unknown connect: ${which}`);
  db.db.prepare(`UPDATE web_setups SET ${col} = ? WHERE id = ?`).run(String(state ?? ""), id);
}

/** An open setup by its code, for the claim. */
export function byCode(code, now = clock.now()) {
  if (!CODE_RE.test(String(code ?? ""))) return null;
  return db.db.prepare("SELECT * FROM web_setups WHERE code = ? AND claimed_by IS NULL AND expires_at > ? AND misses < ? ORDER BY created_at DESC LIMIT 1").get(code, now, MAX_MISSES) ?? null;
}

/** A text carried this setup's code but not its names. */
export function miss(id) {
  db.db.prepare("UPDATE web_setups SET misses = misses + 1 WHERE id = ?").run(id);
}

export function markClaimed(id, conversationId, now = clock.now()) {
  const won = db.db.prepare("UPDATE web_setups SET claimed_by = ?, claimed_at = ?, user_name = '', reason_name = '', textme_hash = NULL WHERE id = ? AND claimed_by IS NULL").run(owner(conversationId), now, id).changes === 1;
  if (won) mark("claimed", null, now);
  return won;
}

// ---------- the ready screen's way in ----------

/** The setup this browser holds, claimed or not (the ready screen asks whether its text arrived). */
export function ownedAny(id, secret, now = clock.now()) {
  const row = get(id, now);
  if (!row || !secret) return null;
  const a = Buffer.from(row.secret_hash, "hex"), b = Buffer.from(hash(secret), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}

export function mark(kind, inviteId = null, now = clock.now()) {
  db.db.prepare("INSERT INTO web_setup_marks (at, kind, invite_id) VALUES (?, ?, ?)").run(now, String(kind), inviteId == null ? null : Number(inviteId));
}
export function marksSince(kind, since) {
  return db.db.prepare("SELECT COUNT(*) AS n FROM web_setup_marks WHERE kind = ? AND at > ?").get(String(kind), since).n;
}
/** First texts Reason tried for this invite, ever (the per-invite cap outlives its setups). */
export function inviteSends(inviteId) {
  return db.db.prepare("SELECT COUNT(*) AS n FROM web_setup_marks WHERE kind = 'textme_send' AND invite_id = ?").get(Number(inviteId)).n;
}
/** Older than this, a mark is let go (the ops page reads a week). */
export const MARKS_KEEP_MS = 30 * 24 * 3_600_000;
export function pruneMarks(now = clock.now()) {
  db.db.prepare("DELETE FROM web_setup_marks WHERE at <= ?").run(now - MARKS_KEEP_MS);
}

/** The page's text button was tapped. The first tap is the one that counts (and starts the inviter's clock). */
export function markTapped(id, now = clock.now()) {
  const first = db.db.prepare("UPDATE web_setups SET tapped_at = ? WHERE id = ? AND tapped_at IS NULL AND claimed_by IS NULL").run(now, id).changes === 1;
  if (first) mark("tapped", null, now);
  return first;
}

const numberHash = (row, e164) => hash(`${row.secret_hash}:${e164}`);
/** Is this the number already set on the setup? */
export const textMeIs = (row, e164) => !!row.textme_hash && row.textme_hash === numberHash(row, e164);
export function setTextMe(id, e164, now = clock.now()) {
  const row = get(id, now);
  if (!row) return false;
  if (textMeIs(row, e164)) return true;
  return db.db.prepare("UPDATE web_setups SET textme_hash = ?, textme_sets = textme_sets + 1 WHERE id = ? AND claimed_by IS NULL").run(numberHash(row, e164), id).changes === 1;
}
export function noteTextMeSend(id, inviteId, now = clock.now()) {
  db.db.prepare("UPDATE web_setups SET textme_sends = textme_sends + 1, textme_at = ? WHERE id = ?").run(now, id);
  mark("textme_send", inviteId, now);
}
/**
 * The open setup that asked Reason to text this number first, or null. Only open ones (unclaimed, not
 * past their day): a reply after that is a stranger's text like any other. The number is matched
 * against each open setup's salted hash; there are only ever a handful.
 */
export function byTextMe(e164, now = clock.now()) {
  if (!e164) return null;
  const rows = db.db.prepare("SELECT * FROM web_setups WHERE textme_hash IS NOT NULL AND textme_sends > 0 AND claimed_by IS NULL AND expires_at > ? ORDER BY textme_at DESC").all(now);
  return rows.find(r => r.textme_hash === numberHash(r, e164)) ?? null;
}

/** Invite setups whose text button was tapped `afterMs` ago with no first text since, and the inviter not yet told. */
export function dueNudges(afterMs, now = clock.now()) {
  return db.db.prepare("SELECT * FROM web_setups WHERE invite_id IS NOT NULL AND tapped_at IS NOT NULL AND tapped_at <= ? AND nudged_at IS NULL AND claimed_by IS NULL AND expires_at > ?").all(now - afterMs, now);
}
export function markNudged(id, now = clock.now()) {
  return db.db.prepare("UPDATE web_setups SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL").run(now, id).changes === 1;
}

/** The setup this conversation claimed, if any. */
export function claimedBy(conversationId) {
  if (!conversationId) return null;
  const forms = ownerForms(conversationId);
  return db.db.prepare(`SELECT * FROM web_setups WHERE claimed_by IN (${forms.map(() => "?").join(", ")}) ORDER BY claimed_at DESC LIMIT 1`).get(...forms) ?? null;
}

/** Setups past their day that nobody claimed: their ids, for the sweep to drop what they hold. */
export function expiredUnclaimed(now = clock.now()) {
  return db.db.prepare("SELECT id FROM web_setups WHERE claimed_by IS NULL AND expires_at <= ?").all(now).map(r => r.id);
}

export function remove(id) {
  db.db.prepare("DELETE FROM web_setups WHERE id = ?").run(id);
}
