// Credentials at rest, sealed with AES-256-GCM (node:crypto). Added 2026-10-23 for the AgentCard
// bearer tokens in agentcard_users, which until then sat in the database as plain text: anybody
// with a copy of reason.db (a backup, an scp, an export) could spend as the person.
//
// The key is REASON_TOKEN_KEY — 32 bytes, as 64 hex characters or base64. It lives in .env (gitignored)
// on each machine and nowhere else. There is no fallback: with no key, seal() throws rather than
// write plain text, and the server refuses to start (requireKey, called from src/serve.js).
//
// A sealed value reads "enc:v1:<iv>:<tag>:<ciphertext>", each part base64url. open() passes a value
// without that prefix straight through, which is only so the one-time migration can tell a row it
// has not sealed yet from one it has; nothing writes plain text any more.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function parseKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length === 32 ? buf : "bad";
}

function key() {
  const k = parseKey(process.env.REASON_TOKEN_KEY);
  if (k === null) throw new Error("REASON_TOKEN_KEY is not set. It encrypts stored login tokens (AgentCard, Google, Spotify, Uber, X, GitHub, iCloud); without it Reason will not store or read them. Put a 32-byte key (64 hex characters) in .env.");
  if (k === "bad") throw new Error("REASON_TOKEN_KEY is not a 32-byte key (64 hex characters or base64 of 32 bytes).");
  return k;
}

/** Throws, with words a person can act on, unless a usable key is configured. */
export function requireKey() { key(); }

export function hasKey() {
  const k = parseKey(process.env.REASON_TOKEN_KEY);
  return k !== null && k !== "bad";
}

export function isSealed(v) { return typeof v === "string" && v.startsWith(PREFIX); }

/** Seal a secret. Empty stays empty (no token is not a secret). Never returns plain text. */
export function seal(plain) {
  if (plain === null || plain === undefined || plain === "") return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map(b => b.toString("base64url")).join(":");
}

/** Open a sealed value. A value that was tampered with, or sealed under another key, throws. */
export function open(stored) {
  if (!isSealed(stored)) return stored ?? "";
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(":").map(p => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
