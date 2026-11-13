// Saved logins: the vault's safe box (design B2, B3, B10, B12; build brief docs/account-access-build/pr3.md).
//
// A file of its own, data/logins.db, beside reason.db and keys.db, so the copies of reason.db made for
// proofs and debugging never carry a saved login, even sealed. Each login has its own AES-256 data key
// from AWS KMS (src/vaultkms.js); only the KMS-wrapped form is stored. Each field is AES-256-GCM with a
// fresh 12-byte nonce and associated data "sl1|<id>|<field>|<signin_origin>". The KMS encryption
// context binds the key to the person (a random handle, never a number: CloudTrail shows the context
// in plain text), the login id and the exact sign-in origin, so a row copied to someone else, an
// origin edited in the file, or a tab on any other origin fails to unwrap at KMS, not only here.
//
// Nothing here types, shows or returns a login. withLogin is the only way in, and only src/filler.js
// may import it (test/savedlogins.test.js checks). Errors carry fixed codes, never a value.
//
// REASON_SAVED_LOGINS = off | owner | on (default off), read at call time. With it on and no KMS the
// vault does not start: one log line, every call refused. No file key, no .env key, no fallback.
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, clock } from "./config.js";
import * as accounts from "./accounts.js";
import * as restcrypt from "./restcrypt.js";
import * as vaultkms from "./vaultkms.js";
import { Secret, wipeAll } from "./secret.js";

// ---------------------------------------------------------------- the switch
export function savedLoginsMode() {
  const v = String(process.env.REASON_SAVED_LOGINS ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}
/** On for this person: the switch, and a real key service behind it (vaultReady). */
export function savedLoginsAllowedFor(conversationId) {
  if (!conversationId) return false;
  const mode = savedLoginsMode();
  if (mode === "off") return false;
  if (mode === "owner" && !accounts.featureOwner(conversationId)) return false;
  return vaultReady();
}

let saidOff = false;
/** REASON_VAULT_KMS_KEY set, AWS login set, no 127.x KMS host outside a test. Not ready: one log line. */
export function vaultReady() {
  if (vaultkms.configured()) return true;
  if (!saidOff && savedLoginsMode() !== "off") { saidOff = true; console.log("saved logins: off (no KMS key)"); }
  return false;
}

/** A refusal with a fixed code (and, for the never list, fixed words in `why`). Never a value. */
export class VaultError extends Error {
  constructor(code, { why = "", detail = "" } = {}) {
    super(`saved logins: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "VaultError";
    this.code = code;
    if (why) this.why = why;
  }
}

// ---------------------------------------------------------------- the never list (vault PR 4)
// classifySite(hostOrUrl) -> { policy: "never" | "careful" | "allowed", category, reason, ... } lives in
// src/sitepolicy.js (vault PR 4, not merged yet). Until it is, the policy is handed in; with none,
// nothing can be saved. Once PR 4 merges: import { classifySite, refusalFor } from "./sitepolicy.js"
// here, use refusalFor(category, label) for `why`, and drop useSitePolicy.
let sitePolicy = null;
export function useSitePolicy(p) { sitePolicy = p; }

// ---------------------------------------------------------------- the file
export function loginsDbPath() {
  if (process.env.REASON_LOGINS_DB_PATH) return process.env.REASON_LOGINS_DB_PATH;
  if (!config.dbPath || config.dbPath === ":memory:") return ":memory:";
  return join(dirname(config.dbPath), "logins.db");
}

const SCHEMA = `
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = DELETE; -- no WAL: a removed login must not linger in a -wal file
  PRAGMA secure_delete = ON;    -- a deleted row is zeroed in the file, not just unlinked
  CREATE TABLE IF NOT EXISTS vault_people (
    conversation_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS saved_logins (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    label TEXT NOT NULL,
    signin_origin TEXT NOT NULL,
    signin_path TEXT NOT NULL,
    username_ct BLOB NOT NULL,
    password_ct BLOB NOT NULL,
    totp_ct BLOB,
    wrapped_key TEXT NOT NULL,
    kms_key TEXT NOT NULL,
    username_hint TEXT NOT NULL DEFAULT '',
    permission TEXT NOT NULL CHECK (permission IN ('standing', 'each_time')),
    second_step TEXT CHECK (second_step IN ('none', 'email', 'sms', 'totp', 'push')),
    state TEXT NOT NULL DEFAULT 'unverified'
      CHECK (state IN ('unverified', 'working', 'wrong_password', 'needs_person', 'paused', 'refused')),
    consent_version TEXT NOT NULL,
    consent_at INTEGER NOT NULL,
    consent_credential TEXT NOT NULL,
    fail_count INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER,
    last_used_at INTEGER,
    unused_warned_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (conversation_id, site, signin_origin)
  );
`;

// Opened on first use, not at load: loading this module with the switch off must not create the file.
let ldb = null, ldbPath = null;
function open({ create }) {
  const p = loginsDbPath();
  if (ldb && ldbPath === p) return ldb;
  if (ldb) { try { ldb.close(); } catch {} ldb = null; ldbPath = null; }
  const onDisk = p !== ":memory:";
  if (onDisk && !existsSync(p)) {
    if (!create) return null;
    mkdirSync(dirname(p), { recursive: true });
  }
  const d = new DatabaseSync(p);
  d.exec(SCHEMA);
  if (onDisk) chmodSync(p, 0o600);
  ldb = d; ldbPath = p;
  return d;
}

function handleFor(d, c, create) {
  const get = () => d.prepare("SELECT handle FROM vault_people WHERE conversation_id = ?").get(c)?.handle ?? null;
  const h = get();
  if (h || !create) return h;
  d.prepare("INSERT OR IGNORE INTO vault_people (conversation_id, handle) VALUES (?, ?)").run(c, randomBytes(18).toString("base64url"));
  return get();
}

// ---------------------------------------------------------------- sealing
const contextFor = (person, id, origin) => ({ app: "reason", purpose: "saved-login", person, item: String(id), origin });
const aad = (id, field, origin) => Buffer.from(`sl1|${id}|${field}|${origin}`, "utf8");

/** nonce (12) | tag (16) | ciphertext */
function sealField(key, id, field, origin, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(id, field, origin));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function openField(key, id, field, origin, blob) {
  const b = Buffer.from(blob);
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(aad(id, field, origin));
  d.setAuthTag(b.subarray(12, 28));
  const head = d.update(b.subarray(28)); // not yet authenticated: wiped whatever happens
  try {
    const tail = d.final();
    const out = Buffer.alloc(head.length + tail.length);
    head.copy(out); tail.copy(out, head.length); tail.fill(0);
    return new Secret(out);
  } finally { head.fill(0); }
}

// ---------------------------------------------------------------- checks
/** The origin exactly as a browser reports it (https://host[:port], nothing more), or null. */
function exactOrigin(s) {
  if (typeof s !== "string") return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === "https:" && u.origin === s ? s : null;
}
const SITE_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PATH_RE = /^\/[^?#\s]{0,300}$/;
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,80}$/;
const CRED_RE = /^[^\u0000-\u001f\u007f\s]{1,1400}$/; // a passkey credential id (base64url, up to 1023 bytes)
const STOPPED = new Set(["refused", "paused"]);

// "o…@gmail.com" / "o…7": built from the bytes, so the whole username never becomes a JS string.
function charAt(buf, start) {
  const b = buf[start], n = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
  return buf.subarray(start, start + n).toString("utf8");
}
function hintOf(u) {
  if (!u.length) return "";
  const first = charAt(u, 0);
  const at = u.lastIndexOf(0x40);
  if (at > 0 && at < u.length - 1) return `${first}…@${u.subarray(at + 1, at + 81).toString("utf8")}`;
  if (u.length < 6) return `${first}…`;
  let i = u.length - 1;
  while (i > 0 && (u[i] & 0xc0) === 0x80) i--;
  return `${first}…${charAt(u, i)}`;
}

function siteVerdict(hostOrUrl) {
  if (!sitePolicy?.classifySite) throw new VaultError("no_site_policy");
  return sitePolicy.classifySite(hostOrUrl) ?? {};
}

// ---------------------------------------------------------------- slice 2 fills this in
// Every save, open and removal will write one login_log row (reason.db) and one recordAction row
// (rule 5). Never a username, a code or an address with a query string.
function logEvent(_conversationId, _entry) {}

// ---------------------------------------------------------------- the box
/**
 * Seal and store a login. `fields` = { username: Secret, password: Secret, totp?: Secret | null }; they
 * are consumed (zero-filled) whatever happens. Returns { id, site, state } and nothing secret.
 * meta = { site, label, signinOrigin, signinPath, permission, consentVersion, consentAt, consentCredential }.
 */
export async function saveLogin(conversationId, meta, fields) {
  const c = String(conversationId ?? "");
  const { username, password, totp = null } = fields ?? {};
  let key = null;
  try {
    if (!savedLoginsAllowedFor(c)) throw new VaultError("not_available");
    const m = meta ?? {};
    const site = String(m.site ?? "").toLowerCase();
    const origin = exactOrigin(m.signinOrigin);
    const host = origin ? new URL(origin).hostname : "";
    if (!SITE_RE.test(site) || !origin || (host !== site && !host.endsWith(`.${site}`))) throw new VaultError("bad_site");
    if (!PATH_RE.test(String(m.signinPath ?? ""))) throw new VaultError("bad_path");
    if (!TEXT_RE.test(String(m.label ?? ""))) throw new VaultError("bad_label");
    if (!["standing", "each_time"].includes(m.permission)) throw new VaultError("bad_permission");
    if (!TEXT_RE.test(String(m.consentVersion ?? "")) || !Number.isSafeInteger(m.consentAt) || !CRED_RE.test(String(m.consentCredential ?? ""))) throw new VaultError("no_consent");
    if (!(username instanceof Secret) || !username.live || !(password instanceof Secret) || !password.live) throw new VaultError("bad_fields");
    if (totp !== null && (!(totp instanceof Secret) || !totp.live)) throw new VaultError("bad_fields");

    // Hard rule 3: the never list refuses, and says why; a careful site never gets a standing permission.
    for (const v of [siteVerdict(site), siteVerdict(origin)]) {
      if (v.policy === "never") throw new VaultError("never_site", { why: String(v.reason ?? "") });
      if (v.policy === "careful" && m.permission === "standing") throw new VaultError("careful_needs_each_time");
      if (!["careful", "allowed"].includes(v.policy)) throw new VaultError("no_site_policy");
    }

    const d = open({ create: true });
    if (d.prepare("SELECT 1 FROM saved_logins WHERE conversation_id = ? AND site = ? AND signin_origin = ?").get(c, site, origin)) throw new VaultError("exists");
    const person = handleFor(d, c, true);
    const id = randomBytes(6).readUIntBE(0, 6); // random, never a counter (src/restcrypt.js newKeyRow)

    let dk;
    try { dk = await vaultkms.generateDataKey(contextFor(person, id, origin)); }
    catch { throw new VaultError("kms_failed"); }
    key = dk.plaintext;
    let hint = "", uct, pct, tct = null;
    key.use(k => {
      username.use(u => { hint = hintOf(u); uct = sealField(k, id, "username", origin, u); });
      pct = password.use(p => sealField(k, id, "password", origin, p));
      if (totp) tct = totp.use(t => sealField(k, id, "totp", origin, t));
    });
    const now = clock.now();
    try {
      d.prepare(`INSERT INTO saved_logins (id, conversation_id, site, label, signin_origin, signin_path, username_ct, password_ct, totp_ct,
          wrapped_key, kms_key, username_hint, permission, state, consent_version, consent_at, consent_credential, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?)`)
        .run(id, c, site, String(m.label), origin, String(m.signinPath), uct, pct, tct, dk.wrapped, dk.keyId,
          restcrypt.sealFor(c, hint), m.permission, String(m.consentVersion), m.consentAt, String(m.consentCredential), now);
    } catch (e) {
      // Another save for the same site won the race, or (1 in 2^48) the random id was taken.
      throw new VaultError(/saved_logins\.id/.test(e?.message) ? "try_again" : /UNIQUE/.test(e?.message) ? "exists" : "store_failed");
    }
    logEvent(c, { site, event: "saved", outcome: "ok", kmsCalls: 1 });
    return { id, site, state: "unverified" };
  } finally {
    wipeAll(key, username, password, totp);
  }
}

/** The person's saved logins, for lists: no ciphertext, no wrapped key, nothing secret. Works with the switch off. */
export function listLogins(conversationId) {
  const d = open({ create: false });
  if (!d || !conversationId) return [];
  return d.prepare(`SELECT id, site, label, signin_origin, signin_path, username_hint, permission, second_step, state,
      consent_version, consent_at, fail_count, next_try_at, last_used_at, created_at
    FROM saved_logins WHERE conversation_id = ? ORDER BY site, id`).all(String(conversationId))
    .map(r => ({ ...r, username_hint: restcrypt.openAny(r.username_hint) }));
}

/** Delete one login: the row, its ciphertext and its wrapped key (secure_delete zeroes them). Works with the switch off. */
export function removeLogin(conversationId, id) {
  const d = open({ create: false });
  if (!d || !conversationId) return false;
  const c = String(conversationId);
  const row = d.prepare("SELECT site FROM saved_logins WHERE id = ? AND conversation_id = ?").get(Number(id), c);
  if (!row) return false;
  d.prepare("DELETE FROM saved_logins WHERE id = ? AND conversation_id = ?").run(Number(id), c);
  logEvent(c, { site: row.site, event: "removed", outcome: "ok", kmsCalls: 0 });
  return true;
}

/**
 * The only way in (src/filler.js, vault PR 6). `liveOrigin` is the origin the browser is on now; the KMS
 * context is built from it and from the arguments, never from the row. One Decrypt; fn({ username,
 * password, totp }) gets Secrets, zero-filled when it settles. Whatever fn throws comes back as the fixed
 * code fill_failed: an error message may hold a value, so none is passed on.
 */
export async function withLogin(conversationId, id, liveOrigin, fn) {
  const c = String(conversationId ?? "");
  if (!savedLoginsAllowedFor(c)) throw new VaultError("not_available");
  if (typeof fn !== "function") throw new VaultError("bad_input");
  const d = open({ create: false });
  const row = d?.prepare(`SELECT id, site, signin_origin, username_ct, password_ct, totp_ct, wrapped_key, state, next_try_at
    FROM saved_logins WHERE id = ? AND conversation_id = ?`).get(Number(id), c);
  if (!row) throw new VaultError("not_found");
  // Hard rule 4: one refusal stops. PR 6 sets these; the door honours them.
  if (STOPPED.has(row.state)) throw new VaultError("stopped", { detail: row.state });
  if (row.next_try_at && clock.now() < row.next_try_at) throw new VaultError("wait");
  // Hard rule 1: exact origin only. Checked here, and again by KMS through the context.
  const origin = exactOrigin(liveOrigin);
  if (!origin || origin !== row.signin_origin) { logEvent(c, { site: row.site, event: "opened", outcome: "origin_mismatch", kmsCalls: 0 }); throw new VaultError("origin_mismatch"); }
  const person = handleFor(d, c, false);
  if (!person) throw new VaultError("not_found");

  const itemId = Number(id);
  let key = null, username = null, password = null, totp = null, kmsCalls = 0, outcome = "unwrap_failed";
  try {
    kmsCalls++;
    try { key = await vaultkms.unwrap(row.wrapped_key, contextFor(person, itemId, origin)); }
    catch { throw new VaultError("unwrap_failed"); }
    outcome = "open_failed";
    try {
      key.use(k => {
        username = openField(k, itemId, "username", origin, row.username_ct);
        password = openField(k, itemId, "password", origin, row.password_ct);
        if (row.totp_ct) totp = openField(k, itemId, "totp", origin, row.totp_ct);
      });
    } catch { throw new VaultError("open_failed"); }
    d.prepare("UPDATE saved_logins SET last_used_at = ? WHERE id = ?").run(clock.now(), itemId);
    outcome = "fill_failed";
    let out;
    try { out = await fn({ username, password, totp }); }
    catch (e) { throw new VaultError("fill_failed", { detail: /^[A-Za-z]{1,40}$/.test(e?.name ?? "") ? e.name : "" }); }
    outcome = "ok";
    return out;
  } finally {
    wipeAll(key, username, password, totp);
    logEvent(c, { site: row.site, event: "opened", outcome, kmsCalls });
  }
}

// At load: with the switch on and no KMS, say so once (the vault then refuses every call).
if (savedLoginsMode() !== "off") vaultReady();
