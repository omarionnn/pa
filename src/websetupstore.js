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
for (const col of ["origin TEXT NOT NULL DEFAULT ''", "misses INTEGER NOT NULL DEFAULT 0"]) {
  try { db.db.exec(`ALTER TABLE web_setups ADD COLUMN ${col}`); } catch { /* exists */ }
}
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
export function create(now = clock.now(), { origin = "" } = {}) {
  const id = randomBytes(12).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const code = newCode();
  db.db.prepare("INSERT INTO web_setups (id, secret_hash, code, created_at, expires_at, origin) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, hash(secret), code, now, now + TTL_MS, String(origin ?? ""));
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

export function setConnectState(id, which, state) {
  const col = which === "email" ? "email_state" : "amazon_state";
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
  return db.db.prepare("UPDATE web_setups SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL").run(conversationId, now, id).changes === 1;
}

/** The setup this conversation claimed, if any. */
export function claimedBy(conversationId) {
  if (!conversationId) return null;
  return db.db.prepare("SELECT * FROM web_setups WHERE claimed_by = ? ORDER BY claimed_at DESC LIMIT 1").get(conversationId) ?? null;
}

/** Setups past their day that nobody claimed: their ids, for the sweep to drop what they hold. */
export function expiredUnclaimed(now = clock.now()) {
  return db.db.prepare("SELECT id FROM web_setups WHERE claimed_by IS NULL AND expires_at <= ?").all(now).map(r => r.id);
}

export function remove(id) {
  db.db.prepare("DELETE FROM web_setups WHERE id = ?").run(id);
}
