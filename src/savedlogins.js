// Saved logins: the vault's safe box (design B2, B3, B10, B12; build brief docs/account-access-build/pr3.md).
//
// A file of its own, data/logins.db, beside reason.db and keys.db, so the copies of reason.db made for
// proofs and debugging never carry a saved login, even sealed. Each login has its own AES-256 data key,
// wrapped by the key service (src/vaultkms.js: Google Cloud KMS, or AWS KMS); only the wrapped form is stored. Each field is AES-256-GCM with a
// fresh 12-byte nonce and associated data "sl1|<id>|<field>|<signin_origin>". The KMS encryption
// context (Google: the additional authenticated data) binds the key to the person (a random handle, never
// a number: the key service's audit log shows it in plain text), the login id and the exact sign-in origin, so a row copied to someone else, an
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
import { db as reasonDb, recordAction } from "./db.js";
import * as restcrypt from "./restcrypt.js";
import * as vaultkms from "./vaultkms.js";
import { Secret, wipeAll } from "./secret.js";
import { classifySite, refusalFor } from "./sitepolicy.js";

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
let saidRest = false;
/**
 * A working key service (vaultkms.configured): Google's key file, or AWS's key and login, and no 127.x
 * stand-in outside a test. No file master, no .env key, no fallback. And encryption at rest fully on
 * (REASON_ENCRYPT_REST, _REST2 and _REST3): the username hint, the reason for each use and the quoted
 * request of a save link are sealed under the person's key only then. Not ready: one log line.
 */
export function vaultReady() {
  if (!restcrypt.flag2On() || !restcrypt.flag3On()) {
    if (!saidRest && savedLoginsMode() !== "off") { saidRest = true; console.log("saved logins: off (encryption at rest not fully on)"); }
    return false;
  }
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
// classifySite(hostOrUrl) -> { policy: "never" | "careful" | "allowed", category, ... } from
// src/sitepolicy.js: code decides, with no override and nothing handed in. A never site refuses with
// refusalFor's fixed words; a careful one never gets a standing permission.

// ---------------------------------------------------------------- the file
export function loginsDbPath() {
  if (process.env.REASON_LOGINS_DB_PATH) return process.env.REASON_LOGINS_DB_PATH;
  if (!config.dbPath || config.dbPath === ":memory:") return ":memory:";
  return join(dirname(config.dbPath), "logins.db");
}

/** The DDL of data/logins.db (exported for test/data-coverage.test.js, which builds the file from it). */
export const LOGINS_SCHEMA = `
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
    UNIQUE (conversation_id, site, label COLLATE NOCASE) -- a second account on a site needs its own name
  );
  -- How a person signs in to a site that has no saved login of its own (owner decision 2026-11-13):
  -- "google" = through the site's own "Continue with Google", with their saved Google login
  -- (src/federated.js). Not a secret: a site name and a word.
  CREATE TABLE IF NOT EXISTS signin_routes (
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('google', 'password')),
    set_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, site)
  );
  -- The one offer to save a login, after a sign-in through a link ended signed in (src/loginintake.js
  -- saveOfferFor): a site is offered once per person, never again, whatever they answered.
  CREATE TABLE IF NOT EXISTS save_offers (
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    offered_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, site)
  );
  -- A person's call passphrase (src/callpass.js, REASON_CALL_TRUST): a salted scrypt hash of the
  -- normalised phrase, never the phrase. pending_* is one set on a call, waiting for a typed yes.
  CREATE TABLE IF NOT EXISTS call_passphrases (
    conversation_id TEXT PRIMARY KEY,
    active_hash TEXT,
    active_set_how TEXT CHECK (active_set_how IN ('text', 'call')),
    active_set_at INTEGER,
    active_words INTEGER,
    pending_hash TEXT,
    pending_set_at INTEGER,
    pending_call_id INTEGER,
    pending_asked_outbox INTEGER,
    removal_asked_outbox INTEGER,
    told_count INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    misses_since INTEGER
  );
  -- The set-up page's one-use links: only a hash of the token.
  CREATE TABLE IF NOT EXISTS call_passphrase_links (
    token_hash TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('set', 'change')),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
`;

/**
 * Every table in data/logins.db, by what an export and a delete do with it, as src/data.js COVERAGE does
 * for reason.db. test/data-coverage.test.js builds the file and holds every table to being listed here,
 * read by exportFor or kept out of an export with a reason, and deleted by deleteAllFor and deleteEveryLogin.
 */
export const LOGINS_COVERAGE = {
  // exportFor (never the login, data.js REDACTED); exportRoutesFor: site + route; callpass.exportFor: set, how, when (never the hash)
  exported: ["saved_logins", "signin_routes", "call_passphrases"],
  notExported: {
    vault_people: "a random handle that goes into the KMS context; it holds nothing of the person",
    call_passphrase_links: "the hash of a one-use set-up link and when it expires; nothing they typed",
    save_offers: "which sites Reason once offered to save a login for, so the offer is never repeated; a site name and a time, nothing they typed",
  },
  deleted: ["saved_logins", "vault_people", "signin_routes", "call_passphrases", "call_passphrase_links", "save_offers"],
};

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
  d.exec(LOGINS_SCHEMA);
  if (onDisk) chmodSync(p, 0o600);
  ldb = d; ldbPath = p;
  return d;
}

/** The logins.db handle for src/callpass.js (the call passphrase lives in this file too). Null when there is no file and `create` is false. */
export function loginsDb({ create = false } = {}) { return open({ create }); }

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
/** The origin exactly as a browser reports it (scheme://host[:port], nothing more), or null. A pinned one is https. */
function exactOrigin(s, { https = true } = {}) {
  if (typeof s !== "string") return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.origin === s && (!https || u.protocol === "https:") ? s : null;
}
const SITE_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PATH_RE = /^\/[^?#\s]{0,300}$/;
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,80}$/;
const CRED_RE = /^[^\u0000-\u001f\u007f\s]{1,1400}$/; // a passkey credential id (base64url, up to 1023 bytes)
const STOPPED = new Set(["refused", "paused"]);

// "a…@example.com" / "a…7": built from the bytes, so the whole username never becomes a JS string.
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

const siteVerdict = (hostOrUrl) => classifySite(hostOrUrl) ?? {};

// ---------------------------------------------------------------- the person's record (hard rule 5)
// Every save, open and removal writes one login_log row (reason.db, `purpose` sealed under the
// person's key) and one action_ledger row, which ledger_list reads back. From fixed lists only:
// never a username, a hint, a code or an address with a query string.
export const LOGIN_EVENTS = ["saved", "opened", "removed", "removed_all", "link_sent", "refused_never_list", "save_failed", "signin", "signed_out", "code_from_mail"];
// The vault's own low-level outcomes (what withLogin's `opened` line carries), then the filler's
// person-facing sign-in outcomes (what its `signin` line carries, vault PR 6). A result word the
// filler returns to the model is in the second group so recordLoginEvent accepts it.
export const LOGIN_OUTCOMES = ["ok", "stopped", "wait", "origin_mismatch", "unwrap_failed", "open_failed", "fill_failed",
  "signed_in", "wrong_password", "blocked", "needs_code_sms", "needs_approval", "not_signin_page", "needs_face_id", "paused",
  "needs_code_email", "needs_authenticator", "code_not_found", "wrong_code", "busy", "not_accepted", "no_answer",
  "needs_google_login", "needs_google_tap", "needs_google_code", "consent_more", "google_property", "no_google_button", "waiting_face_id",
  "site_trouble", "refuses_software", "mail_alert", "mail_not_signin"];
const RECEIPT = {
  saved: (site) => `Saved a login for ${site}, sealed under its own key.`,
  opened: (site, outcome) => outcome === "ok" ? `Opened the saved login for ${site} to sign in.` : `Did not open the saved login for ${site} (${outcome.replace(/_/g, " ")}).`,
  removed: (site) => `Deleted the saved login for ${site}.`,
  removed_all: (_site, _outcome, n) => `Deleted all ${n} saved login${n === 1 ? "" : "s"}.`,
  link_sent: (site) => `Sent a link to save a login for ${site} on Reason's own page.`,
  refused_never_list: (site) => `Did not offer to save a login for ${site}: it is on the never list.`,
  save_failed: (site, outcome) => `Did not save the login for ${site} (${outcome.replace(/_/g, " ")}).`,
  // REASON_SIGNIN_CODE_READ (src/signinemail.js codeFromMail): the one email the site just sent, read for its code.
  code_from_mail: (site) => `Took the sign-in code from the email ${site} just sent, for the sign-in you asked for. Nothing else in your mail was read.`,
  // The filler's person-facing line (vault PR 6, design B10): what the sign-in did, in plain words,
  // never a username. One sentence per sign-in result word.
  // Forgetting a login (design B11, hard rule 6): whether signing out on the site itself was confirmed.
  signed_out: (site, outcome) => outcome === "ok" ? `Signed out of ${site} and cleared its cookies and stored data from my browser.`
    : `Cleared ${site}'s cookies and stored data from my browser; I could not confirm a sign-out on ${site} itself.`,
  signin: (site, outcome) => ({
    signed_in: `Signed in to ${site} with your saved login.`,
    wrong_password: `Could not sign in to ${site}: the saved password was not accepted. I stopped and won't try again until you save it again.`,
    blocked: `${site} blocked the sign-in. I stopped and did not retry.`,
    paused: `Did not sign in to ${site}: it is paused after an earlier refusal.`,
    needs_code_sms: `Signed in to ${site}; it then asked for a texted code.`,
    needs_approval: `Signed in to ${site}; it then asked you to approve in an app.`,
    needs_face_id: `Did not sign in to ${site}: this one needs your Face ID approval.`,
    origin_mismatch: `Did not sign in to ${site}: the page was not its real sign-in page.`,
    not_signin_page: `Did not sign in to ${site}: I could not find its sign-in form.`,
    needs_code_email: `Signed in to ${site}; it then emailed a code, and I could not read it from your email.`,
    needs_authenticator: `Signed in to ${site}; it then asked for an authenticator app code, which I can't do yet. I stopped.`,
    code_not_found: `Signed in to ${site}; it emailed a code that did not arrive in time. I stopped.`,
    wrong_code: `Signed in to ${site}; it did not accept the code. I stopped and did not try another.`,
    busy: `Did not sign in to ${site}: the browser was busy.`,
    not_accepted: `Could not sign in to ${site}: it did not accept the sign-in (not a wrong password). I stopped and paused it for a day.`,
    no_answer: `Could not sign in to ${site}: the page did not answer the sign-in in time. I stopped and paused it for a day.`,
    refuses_software: `Did not sign in to ${site}: it turns away browsers run by software, so nothing was opened.`,
    site_trouble: `Could not sign in to ${site}: it answered with its own error before accepting or turning down the login (not a wrong password; the saved login looks fine).`,
    mail_alert: `Stopped signing in to ${site}: the email it sent looked like a security alert, not a sign-in code, so it was not used.`,
    mail_not_signin: `Stopped signing in to ${site}: the email it sent was about a password reset or an account change, not a sign-in code, so it was not used.`,
  }[outcome] ?? `Did not sign in to ${site} (${String(outcome).replace(/_/g, " ")}).`),
};
/** Words for `purpose`: one line, no control characters, links without their query or fragment. */
function cleanPurpose(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, "$1").trim().slice(0, 160);
}
/** Has a sign-in code ever been taken from their mail? (Their login_log, read for the once-only sentence.) */
export function mailCodeUsedBefore(conversationId) {
  return !!reasonDb.prepare("SELECT 1 FROM login_log WHERE conversation_id = ? AND event = 'code_from_mail' LIMIT 1").get(String(conversationId ?? ""));
}
/**
 * Write the person's record of one vault event: a login_log row and an action_ledger row. Throws on
 * an event or outcome outside the fixed lists, or a site that is not a bare host.
 * entry = { site, event, outcome, purpose?, kmsCalls?, count? }.
 */
export function recordLoginEvent(conversationId, { site = "", event, outcome, purpose = "", kmsCalls = 0, count = 0 } = {}) {
  const c = String(conversationId ?? "");
  if (!c) throw new VaultError("bad_input");
  if (!LOGIN_EVENTS.includes(event) || !LOGIN_OUTCOMES.includes(outcome)) throw new VaultError("bad_event");
  const s = String(site ?? "");
  if (s !== "" && !SITE_RE.test(s)) throw new VaultError("bad_site");
  const why = cleanPurpose(purpose);
  const n = Number.isSafeInteger(kmsCalls) && kmsCalls >= 0 ? kmsCalls : 0;
  reasonDb.prepare("INSERT INTO login_log (conversation_id, site, event, outcome, purpose, kms_calls, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(c, s, event, outcome, restcrypt.sealFor(c, why), n, clock.now());
  recordAction({
    conversationId: c, action: `saved_login_${event}`, target: s,
    attempted: { site: s, event },
    outcome: outcome === "ok" ? "ok" : "refused",
    result: { outcome, kms_calls: n, ...(event === "removed_all" ? { removed: count } : {}) },
    receipt: RECEIPT[event](s, outcome, count),
  });
}
// The vault's own calls: a record that cannot be written is said once in the log, never thrown over
// the result (a removal that happened must not read as one that failed).
function logEvent(conversationId, entry) {
  try { recordLoginEvent(conversationId, entry); }
  catch (e) { console.error(`saved logins: could not write the record (${e?.code ?? e?.name ?? "error"})`); }
}

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
    // The Google login (owner decision 2026-11-13) is kept as site google.com on exactly https://accounts.google.com:
    // only that host is judged (careful); google.com itself, and every other Google host, stays never.
    const googleLogin = site === "google.com" && origin === "https://accounts.google.com";
    for (const v of googleLogin ? [siteVerdict(origin)] : [siteVerdict(site), siteVerdict(origin)]) {
      if (v.policy === "never") throw new VaultError("never_site", { why: refusalFor(v.category, m.label) });
      if (v.policy === "careful" && m.permission === "standing") throw new VaultError("careful_needs_each_time");
      if (!["careful", "allowed"].includes(v.policy)) throw new VaultError("no_site_policy");
    }

    const d = open({ create: true });
    if (d.prepare("SELECT 1 FROM saved_logins WHERE conversation_id = ? AND site = ? AND label = ? COLLATE NOCASE").get(c, site, String(m.label))) throw new VaultError("exists");
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

// ---------------------------------------------------------------- the intake (vault PR 5)
// The save page (src/pages/savelogin.js, src/loginintake.js) seals a login inside the person's browser
// to the intake key's public half. The sealed bytes come here, and only here are they opened: the
// wrapped AES key by the key service (vaultkms.openIntake), the fields by AES-256-GCM, each straight
// into a Secret, then saveLogin re-seals them under the login's own key. Nothing is kept or logged.
//
// The sealed form (built by sealInBrowser in src/loginintake.js; every length big-endian):
//   0x01 | u16 wrapped length | wrapped AES key (RSA-OAEP SHA-256) | 12-byte IV | AES-GCM ciphertext and tag
// AES-GCM's associated data is "sl-intake1|<intake id>", so a blob made for one link opens for no other.
// Inside: three fields, username, password, setup key, each u16 length | UTF-8 bytes (setup key may be empty).
export const SEALED_VERSION = 1;
export const INTAKE_AAD = (intakeId) => Buffer.from(`sl-intake1|${intakeId}`, "utf8");

/** The intake key can be used for this person: the vault is on for them, and the key service has the intake key. */
export function intakeReadyFor(conversationId) {
  return savedLoginsAllowedFor(conversationId) && vaultkms.intakeConfigured();
}
/** The intake key's public half (SPKI DER, base64url) for the page to seal to. Nothing secret. */
export async function intakePublicKey() {
  try { return (await vaultkms.intakePublicKey()).spki.toString("base64url"); }
  catch { throw new VaultError("kms_failed"); }
}

// The three fields, read off the opened bytes into Secrets (never a string). Throws bad_sealed.
function fieldsOf(plain) {
  const out = [];
  let at = 0;
  for (let i = 0; i < 3; i++) {
    if (at + 2 > plain.length) break;
    const n = plain.readUInt16BE(at); at += 2;
    if (at + n > plain.length) break;
    out.push(n ? new Secret(Buffer.from(plain.subarray(at, at + n))) : null);
    at += n;
  }
  if (out.length !== 3 || at !== plain.length) { wipeAll(...out); throw new VaultError("bad_sealed"); }
  return out;
}

/**
 * Open a login sealed on the save page and store it: the intake key opens the wrapped AES key, the AES
 * key opens the fields, saveLogin re-seals them under the login's own key. `sealed` is the bytes as
 * the page sent them; `intakeId` is the link's id (the blob's associated data). Every value is wiped
 * whatever happens. Returns saveLogin's { id, site, state }; throws a VaultError with a fixed code.
 * The caller has already checked the person's Face ID over this blob and claimed the link.
 */
export async function saveFromSealed(conversationId, meta, sealed, intakeId) {
  const c = String(conversationId ?? "");
  if (!intakeReadyFor(c)) throw new VaultError("not_available");
  const b = Buffer.isBuffer(sealed) ? sealed : null;
  if (!b || b.length < 1 + 2 + 12 + 16 || b[0] !== SEALED_VERSION || !/^[A-Za-z0-9_-]{8,128}$/.test(String(intakeId ?? ""))) throw new VaultError("bad_sealed");
  const wl = b.readUInt16BE(1);
  if (wl < 256 || 3 + wl + 12 + 16 > b.length) throw new VaultError("bad_sealed");
  const wrapped = b.subarray(3, 3 + wl), iv = b.subarray(3 + wl, 3 + wl + 12), body = b.subarray(3 + wl + 12);
  let key = null, plain = null, fields = [];
  try {
    try { key = await vaultkms.openIntake(wrapped); }
    catch { throw new VaultError("unwrap_failed"); }
    plain = key.use(k => {
      const d = createDecipheriv("aes-256-gcm", k, iv);
      d.setAAD(INTAKE_AAD(intakeId));
      d.setAuthTag(body.subarray(body.length - 16));
      const head = d.update(body.subarray(0, body.length - 16));
      try {
        const tail = d.final();
        const out = Buffer.alloc(head.length + tail.length);
        head.copy(out); tail.copy(out, head.length); tail.fill(0);
        return out;
      } catch { throw new VaultError("open_failed"); }
      finally { head.fill(0); }
    });
    fields = fieldsOf(plain);
    const [username, password, totp] = fields;
    if (!username || !password) throw new VaultError("bad_fields");
    return await saveLogin(c, meta, { username, password, totp });
  } finally {
    if (plain) plain.fill(0);
    wipeAll(key, ...fields);
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

/**
 * The saved logins for one site, for the filler to find and gate on (src/filler.js, vault PR 6): id,
 * state, next_try_at, permission, the pinned origin and path, second_step and the site. No ciphertext,
 * no wrapped key, nothing secret. `site` is a bare host ("amazon.com"); a login whose site is that host
 * or a parent of it matches (a login saved for "example.test" answers a request for "login.example.test").
 */
export function peekForSignin(conversationId, site) {
  const d = open({ create: false });
  const host = String(site ?? "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (!d || !conversationId || !SITE_RE.test(host)) return [];
  return d.prepare(`SELECT id, site, label, signin_origin, signin_path, permission, second_step, state, next_try_at, fail_count
    FROM saved_logins WHERE conversation_id = ? ORDER BY id`).all(String(conversationId))
    .filter(r => r.site === host || host === r.site || host.endsWith(`.${r.site}`) || r.site.endsWith(`.${host}`));
}

export const SIGNIN_STATES = ["unverified", "working", "wrong_password", "needs_person", "paused", "refused"];
/**
 * Move a saved login's row after a sign-in (src/filler.js, vault PR 6): its state, fail_count and
 * next_try_at. Scoped to the person. Never touches a secret. Returns true when a row changed.
 * `bumpFail` adds one to fail_count; `failCount` sets it outright (0 clears it on a success).
 */
export function setState(conversationId, id, { state = null, failCount = null, bumpFail = false, nextTryAt = null, clearNextTry = false } = {}) {
  const d = open({ create: false });
  const c = String(conversationId ?? "");
  if (!d || !c || !Number.isSafeInteger(Number(id))) return false;
  if (state !== null && !SIGNIN_STATES.includes(state)) throw new VaultError("bad_state");
  const sets = [], args = [];
  if (state !== null) { sets.push("state = ?"); args.push(state); }
  if (bumpFail) sets.push("fail_count = fail_count + 1");
  else if (Number.isSafeInteger(failCount)) { sets.push("fail_count = ?"); args.push(failCount); }
  if (clearNextTry) sets.push("next_try_at = NULL");
  else if (Number.isSafeInteger(nextTryAt)) { sets.push("next_try_at = ?"); args.push(nextTryAt); }
  if (!sets.length) return false;
  args.push(Number(id), c);
  return Number(d.prepare(`UPDATE saved_logins SET ${sets.join(", ")} WHERE id = ? AND conversation_id = ?`).run(...args).changes) > 0;
}

/** Delete one login: the row, its ciphertext and its wrapped key (secure_delete zeroes them). Works with the switch off. */
export function removeLogin(conversationId, id, { purpose = "" } = {}) {
  const d = open({ create: false });
  if (!d || !conversationId) return false;
  const c = String(conversationId);
  const row = d.prepare("SELECT site FROM saved_logins WHERE id = ? AND conversation_id = ?").get(Number(id), c);
  if (!row) return false;
  d.prepare("DELETE FROM saved_logins WHERE id = ? AND conversation_id = ?").run(Number(id), c);
  // The Google login gone (and no other kept): every site they signed in to through it goes with it (review 2026-11-13).
  if (row.site === "google.com" && !d.prepare("SELECT 1 FROM saved_logins WHERE conversation_id = ? AND site = 'google.com'").get(c)) {
    d.prepare("DELETE FROM signin_routes WHERE conversation_id = ? AND route = 'google'").run(c);
  }
  logEvent(c, { site: row.site, event: "removed", outcome: "ok", purpose, kmsCalls: 0 });
  return true;
}

/**
 * Delete every login a person saved, and their vault handle, in one transaction (secure_delete zeroes
 * the pages). One login_log row and one action_ledger row when there was anything to delete. Works
 * with the switch off. src/data.js deleteData calls this before the person's key is destroyed.
 * Returns how many logins went.
 */
export function deleteAllFor(conversationId, { purpose = "" } = {}) {
  const c = String(conversationId ?? "");
  if (!c) throw new VaultError("bad_input"); // never "everyone" by accident: that is deleteEveryLogin
  const d = open({ create: false });
  if (!d) return 0;
  let n = 0, had = false;
  d.exec("BEGIN IMMEDIATE");
  try {
    n = Number(d.prepare("DELETE FROM saved_logins WHERE conversation_id = ?").run(c).changes);
    had = Number(d.prepare("DELETE FROM vault_people WHERE conversation_id = ?").run(c).changes) > 0 || n > 0;
    had = Number(d.prepare("DELETE FROM signin_routes WHERE conversation_id = ?").run(c).changes) > 0 || had;
    had = Number(d.prepare("DELETE FROM call_passphrases WHERE conversation_id = ?").run(c).changes) > 0 || had;
    d.prepare("DELETE FROM call_passphrase_links WHERE conversation_id = ?").run(c);
    d.prepare("DELETE FROM save_offers WHERE conversation_id = ?").run(c);
    d.exec("COMMIT");
  } catch (e) { try { d.exec("ROLLBACK"); } catch {} throw new VaultError("store_failed"); }
  if (had) logEvent(c, { site: "", event: "removed_all", outcome: "ok", purpose, kmsCalls: 0, count: n });
  return n;
}

/** A delete of the whole install (src/data.js deleteData with no scope): every login and handle. No record: nobody is left to read it. */
export function deleteEveryLogin() {
  const d = open({ create: false });
  if (!d) return 0;
  d.exec("BEGIN IMMEDIATE");
  try {
    const n = Number(d.prepare("DELETE FROM saved_logins").run().changes);
    d.prepare("DELETE FROM vault_people").run();
    d.prepare("DELETE FROM signin_routes").run();
    d.prepare("DELETE FROM call_passphrases").run();
    d.prepare("DELETE FROM call_passphrase_links").run();
    d.prepare("DELETE FROM save_offers").run();
    d.exec("COMMIT");
    return n;
  } catch { try { d.exec("ROLLBACK"); } catch {} throw new VaultError("store_failed"); }
}

/**
 * For an export (src/data.js exportData): what was saved, never the login. The site, label, sign-in
 * address, username hint, dates, permission and state; no ciphertext, no wrapped key, no handle.
 * `null` = everyone, as exportData's own scope. Works with the switch off.
 */
export function exportFor(conversationId) {
  const d = open({ create: false });
  if (!d) return [];
  const all = conversationId === null;
  if (!all && !conversationId) return [];
  return d.prepare(`SELECT id, conversation_id, site, label, signin_origin, signin_path, username_hint, permission, second_step, state,
      consent_version, consent_at, fail_count, next_try_at, last_used_at, unused_warned_at, created_at
    FROM saved_logins${all ? "" : " WHERE conversation_id = ?"} ORDER BY conversation_id, site, id`).all(...(all ? [] : [String(conversationId)]))
    .map(r => ({ ...r, username_hint: restcrypt.openAny(r.username_hint) }));
}

// ---------------------------------------------------------------- how they sign in to a site (owner decision 2026-11-13)
export const SIGNIN_ROUTES = ["google", "password"];
const routeSite = (s) => String(s ?? "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0].replace(/^www\./, "");
/** Remember that this person signs in to `site` with Continue with Google (or a password). True when stored. */
export function setSigninRoute(conversationId, site, route) {
  const c = String(conversationId ?? ""), s = routeSite(site);
  if (!savedLoginsAllowedFor(c) || !SITE_RE.test(s) || !SIGNIN_ROUTES.includes(route)) return false;
  const d = open({ create: true });
  d.prepare(`INSERT INTO signin_routes (conversation_id, site, route, set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id, site) DO UPDATE SET route = excluded.route, set_at = excluded.set_at`).run(c, s, route, clock.now());
  return true;
}
/** "google", "password" or "" for this person and site (the site or a parent domain of it). */
export function signinRouteFor(conversationId, site) {
  const d = open({ create: false });
  const s = routeSite(site);
  if (!d || !conversationId || !SITE_RE.test(s)) return "";
  const rows = d.prepare("SELECT site, route FROM signin_routes WHERE conversation_id = ?").all(String(conversationId));
  const hit = rows.find(r => r.site === s) ?? rows.find(r => s.endsWith(`.${r.site}`));
  return hit?.route ?? "";
}
/**
 * The one save offer for a site (owner decision 2026-11-13): true the first time for this person and
 * site, and false every time after, whatever they answered. Atomic: two endings at once offer once.
 */
export function markSaveOffered(conversationId, site) {
  const c = String(conversationId ?? ""), s = routeSite(site);
  if (!c || !savedLoginsAllowedFor(c) || !SITE_RE.test(s)) return false;
  const d = open({ create: true });
  return Number(d.prepare("INSERT OR IGNORE INTO save_offers (conversation_id, site, offered_at) VALUES (?, ?, ?)").run(c, s, clock.now()).changes) > 0;
}
/** For an export: each site and how they sign in to it. `null` = everyone. */
export function exportRoutesFor(conversationId) {
  const d = open({ create: false });
  if (!d) return [];
  const all = conversationId === null;
  if (!all && !conversationId) return [];
  return d.prepare(`SELECT conversation_id, site, route, set_at FROM signin_routes${all ? "" : " WHERE conversation_id = ?"} ORDER BY conversation_id, site`)
    .all(...(all ? [] : [String(conversationId)]));
}

/**
 * The only way in (src/filler.js, vault PR 6). `liveOrigin` is the origin the browser is on now; the KMS
 * context is built from it and from the arguments, never from the row. One Decrypt; fn({ username,
 * password, totp }) gets Secrets, zero-filled when it settles. Whatever fn throws comes back as the fixed
 * code fill_failed: an error message may hold a value, so none is passed on. Every call that finds the
 * row writes the person's record (recordLoginEvent): the outcome, `purpose` (why, in Reason's words,
 * sealed) and kms_calls.
 */
export async function withLogin(conversationId, id, liveOrigin, fn, { purpose = "" } = {}) {
  const c = String(conversationId ?? "");
  if (!savedLoginsAllowedFor(c)) throw new VaultError("not_available");
  if (typeof fn !== "function") throw new VaultError("bad_input");
  const d = open({ create: false });
  const row = d?.prepare(`SELECT id, site, signin_origin, username_ct, password_ct, totp_ct, wrapped_key, state, next_try_at
    FROM saved_logins WHERE id = ? AND conversation_id = ?`).get(Number(id), c);
  if (!row) throw new VaultError("not_found");
  // Hard rule 4: one refusal stops. PR 6 sets these; the door honours them.
  if (STOPPED.has(row.state)) { logEvent(c, { site: row.site, event: "opened", outcome: "stopped", purpose, kmsCalls: 0 }); throw new VaultError("stopped", { detail: row.state }); }
  if (row.next_try_at && clock.now() < row.next_try_at) { logEvent(c, { site: row.site, event: "opened", outcome: "wait", purpose, kmsCalls: 0 }); throw new VaultError("wait"); }
  // Hard rule 1: exact origin only. Checked here, and again by KMS through the context.
  // Any exact origin is compared; the pin was https when saved, and a row edited since is KMS's to refuse.
  const origin = exactOrigin(liveOrigin, { https: false });
  if (!origin || origin !== row.signin_origin) { logEvent(c, { site: row.site, event: "opened", outcome: "origin_mismatch", purpose, kmsCalls: 0 }); throw new VaultError("origin_mismatch"); }
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
    d.prepare("UPDATE saved_logins SET last_used_at = ? WHERE id = ? AND conversation_id = ?").run(clock.now(), itemId, c);
    outcome = "fill_failed";
    let out;
    try { out = await fn({ username, password, totp }); }
    catch (e) { throw new VaultError("fill_failed", { detail: /^[A-Za-z]{1,40}$/.test(e?.name ?? "") ? e.name : "" }); }
    outcome = "ok";
    return out;
  } finally {
    wipeAll(key, username, password, totp);
    logEvent(c, { site: row.site, event: "opened", outcome, purpose, kmsCalls });
  }
}

// At load: with the switch on and no KMS, say so once (the vault then refuses every call).
if (savedLoginsMode() !== "off") vaultReady();
