// Per-person encryption at rest (11-09). Behind REASON_ENCRYPT_REST=off|on.
//
// What it is for: a copy of reason.db (a backup, the rolling .bak, an scp, a provider disk image)
// must be useless on its own, and "delete me" must also kill a person's words in every old backup.
//
// Key hierarchy (design: ~/Desktop/reason-encrypt-rest-1109.md):
//   master key   lives OUTSIDE the box (AWS KMS, REASON_REST_KEK_SOURCE=aws-kms). It never leaves KMS.
//     └ install key (IK)   32 random bytes, stored only wrapped by the master key, in the keystore.
//                           Unwrapped once at boot (one KMS call) and held in memory.
//         └ person key (DEK)  32 random bytes per conversation, stored wrapped by the IK in the
//                             keystore's user_keys. Deleting that row is crypto-shredding.
//   The keystore is its own file (data/keys.db), NOT inside reason.db, and is backed up to its own
//   short-retention repo. So an old reason.db backup holds ciphertext whose key is gone once the
//   person is deleted and the keystore backup has rolled over.
//
// A sealed value reads "enc:u1:<keyId>:<iv>:<tag>:<ct>" (base64url). The key id is in the value, so
// reading needs no context: every statement on a sensitive table opens sealed strings in its rows
// (wrapDatabase). Writing needs the owner: sealFor(conversationId, text). Empty values and the empty
// JSON list "[]" stay as they are: they say nothing, and existing SQL compares against them.
//
// REASON_REST_KEK_SOURCE=local (REASON_REST_KEK, 64 hex in env) exists for tests and development
// only: with it the master key sits beside the data, which defeats the point on a real box.
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, createSecretKey } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, readdirSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";

export const PREFIX = "enc:u1:";

/** Tables and columns phase 1 seals. The owner is found by `owner` (SQL giving conversation_id). */
export const SENSITIVE = [
  { table: "conversations", cols: ["messages"], owner: "id" },
  { table: "event_log", cols: ["content", "tool_calls"], owner: "conversation_id" },
  { table: "messages", cols: ["text"], owner: "conversation_id" },
  { table: "memories", cols: ["fact"], owner: "conversation_id" },
  { table: "person_facts", cols: ["fact"], owner: "(SELECT p.conversation_id FROM people p WHERE p.id = person_facts.person_id)" },
  { table: "calls", cols: ["transcript", "summary", "turn_log"], owner: "conversation_id" },
];
/**
 * Phase 2 (11-10), behind REASON_ENCRYPT_REST2=on, which needs phase 1 on. Message copies, call
 * details, saved addresses, rules and preferences, pages and documents. Same keys, same format.
 * Ids, times, channels, phone numbers and conversation ids stay plain (design doc: why).
 * A stranger who rings with no Reason of their own gets a key of their own, "stranger:<row id>".
 */
export const SENSITIVE2 = [
  { table: "inbound_messages", cols: ["text"], owner: "conversation_id" },
  { table: "inbound_parts", cols: ["text"], owner: "conversation_id" },
  { table: "pending_inbound", cols: ["text"], owner: "conversation_id" },
  { table: "outbox", cols: ["body"], owner: "conversation_id" },
  { table: "stranger_calls", cols: ["said", "summary"], owner: "('stranger:' || stranger_calls.id)" },
  { table: "calls", cols: ["goal", "facts"], owner: "conversation_id" },
  { table: "shop_shipping", cols: ["first_name", "last_name", "address1", "address2", "city", "state", "zip", "phone", "email"], owner: "conversation_id" },
  { table: "saved_places", cols: ["address", "route_description"], owner: "conversation_id" },
  { table: "treat_rules", cols: ["rule", "rule_key", "why"], owner: "conversation_id" },
  { table: "preferences", cols: ["words", "note", "turned_down"], owner: "conversation_id" },
  { table: "guesses", cols: ["about", "guess", "confirmed_said", "evidence", "use"], owner: "conversation_id" },
  { table: "whys", cols: ["about", "why", "said"], owner: "conversation_id" },
  { table: "pages", cols: ["title", "content", "subtitle", "closing"], owner: "conversation_id" },
  { table: "documents", cols: ["title", "subtitle", "closing", "content"], owner: "conversation_id" },
  // Search vectors: inversion attacks recover part of a short text from its embedding. Sealed as the
  // base64 of the float32 bytes; embedding.js blobToFloat32 reads either form. `blob`: --open writes
  // the bytes back, not the base64.
  { table: "fact_embeddings", cols: ["embedding"], owner: "conversation_id", blob: true },
];
/** Every sealed column of both phases, each entry tagged with its phase. */
export const ALL_SENSITIVE = [...SENSITIVE.map(s => ({ ...s, phase: 1 })), ...SENSITIVE2.map(s => ({ ...s, phase: 2 }))];
const TABLE_RE = new RegExp(`\\b(${[...new Set(ALL_SENSITIVE.map(s => s.table))].join("|")})\\b`, "i");
/** A column name as SQL: quoted, because guesses."use" is a keyword. */
const qc = c => `"${c}"`;

export function flagOn() { return String(process.env.REASON_ENCRYPT_REST ?? "off").trim().toLowerCase() === "on"; }
/** Phase 2 seals only on top of phase 1. */
export function flag2On() { return flagOn() && String(process.env.REASON_ENCRYPT_REST2 ?? "off").trim().toLowerCase() === "on"; }
function phaseOn(phase) { return phase === 1 ? flagOn() : flag2On(); }
export function isSealed(v) { return typeof v === "string" && v.startsWith(PREFIX); }
const passThrough = v => v === null || v === undefined || v === "" || v === "[]";

// ---------- keystore ----------
let ks = null;          // DatabaseSync of keys.db
let ik = null;          // install key, Buffer(32), in memory only
const deks = new Map(); // keyId -> Buffer, and "c:"+conversationId -> keyId

export function keystorePath(dbPath) {
  if (process.env.REASON_KEYSTORE_PATH) return process.env.REASON_KEYSTORE_PATH;
  if (!dbPath || dbPath === ":memory:") return ":memory:";
  return join(dirname(dbPath), "keys.db");
}

function openKeystore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const k = new DatabaseSync(path);
  k.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL; -- the server and scripts/encrypt-rest.mjs may both write
    PRAGMA secure_delete = ON; -- a destroyed person key does not linger in free pages
    CREATE TABLE IF NOT EXISTS install_key (
      version INTEGER PRIMARY KEY, source TEXT NOT NULL, wrapped TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER);
    CREATE TABLE IF NOT EXISTS user_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL UNIQUE,
      wrapped TEXT NOT NULL, ik_version INTEGER NOT NULL, created_at INTEGER NOT NULL);
    -- One line per crypto-shred, no content: when a person's key was destroyed.
    CREATE TABLE IF NOT EXISTS shredded (key_id INTEGER PRIMARY KEY, conv_hash TEXT NOT NULL, at INTEGER NOT NULL);
  `);
  return k;
}

// ---------- AES-GCM ----------
function gcmSeal(key, plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString("base64url")).join(":");
}
function gcmOpen(key, packed, aad) {
  const [iv, tag, ct] = packed.split(":").map(p => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---------- master key sources ----------
function localKek() {
  const s = String(process.env.REASON_REST_KEK ?? "").trim();
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error("REASON_REST_KEK must be 64 hex characters (local key source, tests/dev only).");
  return Buffer.from(s, "hex");
}

/** AWS Signature V4 for a JSON-protocol POST. Exported for the test vector. */
export function sigv4({ method = "POST", host, path = "/", query = "", headers, body, region, service, accessKeyId, secretAccessKey, sessionToken, amzDate }) {
  const date = amzDate.slice(0, 8);
  const h = { ...headers, host, "x-amz-date": amzDate };
  if (sessionToken) h["x-amz-security-token"] = sessionToken;
  const names = Object.keys(h).map(n => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonHeaders = names.map(n => `${n}:${lower[n]}\n`).join("");
  const signed = names.join(";");
  const payloadHash = createHash("sha256").update(body ?? "").digest("hex");
  const canon = [method, path, query, canonHeaders, signed, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canon).digest("hex")].join("\n");
  const hm = (k, d) => createHmac("sha256", k).update(d).digest();
  const kSign = hm(hm(hm(hm("AWS4" + secretAccessKey, date), region), service), "aws4_request");
  const signature = createHmac("sha256", kSign).update(toSign).digest("hex");
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`, signature };
}

async function kmsCall(target, payload) {
  const region = process.env.REASON_REST_KMS_REGION || process.env.AWS_REGION || "us-west-2";
  const host = process.env.REASON_REST_KMS_HOST || `kms.${region}.amazonaws.com`;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID, secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS KMS key source needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
  const body = JSON.stringify(payload);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const headers = sigv4({ host, body, region, service: "kms", accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN, amzDate,
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${target}` } });
  delete headers.signature; delete headers.host;
  const scheme = process.env.REASON_REST_KMS_HOST?.startsWith("127.") ? "http" : "https";
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${scheme}://${host}/`, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`KMS ${target} ${r.status} ${j.__type ?? ""} ${j.message ?? ""}`.trim());
      return j;
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 500 * 2 ** i)); }
  }
  throw last;
}
const KMS_CONTEXT = { app: "reason", purpose: "install-key" };

// ---------- "file": the master key in its own root-owned file, outside .env and every backup ----------
// REASON_REST_KEK_FILE (default /etc/reason/rest/master.key): 64 hex characters, mode 0640, in a directory of
// its own (2770 root:reason) so Reason can rotate it without touching anything else in /etc/reason.
// Rotation (rotateFileMaster) writes "<file>.next" first, then the keystore, then renames: a crash at
// any point leaves a pair that opens (boot tries <file>, then <file>.next).
export function kekFilePath() { return process.env.REASON_REST_KEK_FILE || "/etc/reason/rest/master.key"; }
function readKekFile(path) {
  const s = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error(`${path} must hold 64 hex characters (the master key).`);
  return Buffer.from(s, "hex");
}
function fileKeks() {
  const p = kekFilePath(), out = [];
  if (existsSync(p)) out.push(readKekFile(p));
  // A half-written <file>.next (power cut during a rotation) is skipped, never fatal.
  if (existsSync(p + ".next")) { try { out.push(readKekFile(p + ".next")); } catch { /* torn write */ } }
  if (!out.length) throw new Error(`Master key file ${p} is missing. Encryption at rest cannot unlock without it.`);
  return out;
}

async function wrapIK(source, raw, { fileKey = null } = {}) {
  if (source === "local") return gcmSeal(localKek(), raw, "reason-ik");
  if (source === "file") return gcmSeal(fileKey ?? fileKeks()[0], raw, "reason-ik");
  if (source === "aws-kms") {
    const keyId = process.env.REASON_REST_KMS_KEY_ID;
    if (!keyId) throw new Error("REASON_REST_KMS_KEY_ID is not set.");
    const j = await kmsCall("Encrypt", { KeyId: keyId, Plaintext: raw.toString("base64"), EncryptionContext: KMS_CONTEXT });
    return j.CiphertextBlob;
  }
  throw new Error(`Unknown REASON_REST_KEK_SOURCE "${source}" (file, aws-kms or local).`);
}
async function unwrapIK(source, wrapped) {
  if (source === "local") return gcmOpen(localKek(), wrapped, "reason-ik");
  if (source === "file") {
    let last;
    for (const k of fileKeks()) { try { return gcmOpen(k, wrapped, "reason-ik"); } catch (e) { last = e; } }
    throw new Error(`The master key file ${kekFilePath()} does not open this keystore (${last?.message ?? "no key"}).`);
  }
  if (source === "aws-kms") {
    const j = await kmsCall("Decrypt", { CiphertextBlob: wrapped, EncryptionContext: KMS_CONTEXT, KeyId: process.env.REASON_REST_KMS_KEY_ID });
    return Buffer.from(j.Plaintext, "base64");
  }
  throw new Error(`Unknown key source "${source}".`);
}

function sourceName() { return String(process.env.REASON_REST_KEK_SOURCE || "file").trim(); }

/**
 * Re-wrap every install key under the master key source now configured (REASON_REST_KEK_SOURCE),
 * e.g. file -> aws-kms. No data row and no person key changes. Run with Reason stopped.
 */
export async function moveMaster() {
  if (!ks || !iks.size) throw new Error("Not active.");
  const source = sourceName();
  const rows = ks.prepare("SELECT version FROM install_key").all();
  const next = [];
  for (const r of rows) next.push([r.version, await wrapIK(source, iks.get(r.version))]);
  ks.exec("BEGIN IMMEDIATE");
  try { for (const [v, w] of next) ks.prepare("UPDATE install_key SET source = ?, wrapped = ? WHERE version = ?").run(source, w, v); ks.exec("COMMIT"); }
  catch (e) { ks.exec("ROLLBACK"); throw e; }
  return { source, versions: rows.length };
}

/**
 * New master key file. Every keystore copy taken before (every old backup's keys.db) is then sealed
 * under a key that no longer exists anywhere: a person deleted before this rotation is unreadable in
 * every backup, even to someone who later gets root on the box. Run with Reason stopped, after the
 * day's backup has run (so the newest backup is already under the new key by the next run).
 * Keeps the old file as <file>.prev-<ms> for `graceMs`, then removes it (pruneOldMasters).
 */
function durableWrite(path, text) {
  const fd = openSync(path, "w", 0o640);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(path));
}
function syncDir(d) { const fd = openSync(d, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** After the keystore commits to <file>.next: retire <file>, promote .next. Each step fsynced. */
function promoteNext(p) {
  if (existsSync(p)) renameSync(p, `${p}.prev-${Date.now()}`);
  renameSync(p + ".next", p);
  if (existsSync(p + ".next.age")) renameSync(p + ".next.age", p + ".age");
  syncDir(dirname(p));
}

/** Which master opens the keystore's current install key: "main", "next" or null. */
function keystoreOpensWith(p) {
  const row = ks.prepare("SELECT wrapped FROM install_key WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1").get();
  if (!row) return null;
  for (const [name, f] of [["main", p], ["next", p + ".next"]]) {
    try { if (existsSync(f)) { gcmOpen(readKekFile(f), row.wrapped, "reason-ik"); return name; } } catch { /* not this one */ }
  }
  return null;
}

/**
 * Finishes a rotation a crash interrupted, or clears a stale <file>.next. Safe to run any time;
 * rotateFileMaster calls it first, so a retry never overwrites the only key that opens the keystore.
 */
export function finishRotation() {
  const p = kekFilePath();
  if (!existsSync(p + ".next")) return "clean";
  const w = keystoreOpensWith(p);
  if (w === "next") { promoteNext(p); return "finished"; }
  if (w === "main") { rmSync(p + ".next", { force: true }); rmSync(p + ".next.age", { force: true }); syncDir(dirname(p)); return "stale-next-removed"; }
  throw new Error(`Neither ${p} nor ${p}.next opens the keystore: restore the master from the age recovery copy.`);
}

/**
 * Order, so that every crash or power cut leaves a pair that opens:
 *   1. finish any earlier rotation
 *   2. new master -> <file>.next, fsynced; its age recovery copy -> <file>.next.age (sealRecovery)
 *   3. keystore re-wrapped under it, one transaction (SQLite makes it durable)
 *   4. promote: <file> -> .prev-<ms>, .next -> <file>, .next.age -> .age, directory fsynced
 *   5. checkpoint + VACUUM (best effort; failure here changes nothing above)
 */
export async function rotateFileMaster({ sealRecovery = null } = {}) {
  if (!ks || !iks.size) throw new Error("Not active.");
  const p = kekFilePath();
  finishRotation();
  const freshMaster = randomBytes(32), freshIK = randomBytes(32);
  durableWrite(p + ".next", freshMaster.toString("hex") + "\n");
  if (sealRecovery) sealRecovery(p + ".next", p + ".next.age");
  const next = Math.max(...iks.keys()) + 1;
  ks.exec("BEGIN IMMEDIATE");
  try {
    for (const r of ks.prepare("SELECT id, wrapped, ik_version FROM user_keys").all()) {
      const dek = gcmOpen(ikFor(r.ik_version), r.wrapped, `dek:${r.id}`);
      ks.prepare("UPDATE user_keys SET wrapped = ?, ik_version = ? WHERE id = ?").run(gcmSeal(freshIK, dek, `dek:${r.id}`), next, r.id);
    }
    // A new master AND a new install key, and every older install key dropped: today's keys open
    // nothing in an older keys.db, and the old master file is pruned 3 days later.
    ks.prepare("DELETE FROM install_key").run();
    ks.prepare("INSERT INTO install_key (version, source, wrapped, created_at) VALUES (?, 'file', ?, ?)")
      .run(next, await wrapIK("file", freshIK, { fileKey: freshMaster }), Date.now());
    ks.exec("COMMIT");
  } catch (e) {
    ks.exec("ROLLBACK");
    rmSync(p + ".next", { force: true }); rmSync(p + ".next.age", { force: true });
    throw e;
  }
  promoteNext(p);
  iks.clear(); iks.set(next, freshIK); ik = freshIK; ikVersion = next; deks.clear(); opened.clear();
  try { ks.exec("PRAGMA wal_checkpoint(TRUNCATE)"); ks.exec("VACUUM"); } catch { /* free pages are zeroed by secure_delete anyway */ }
  return { file: p, installKeyVersion: next };
}

/** Remove retired master files older than graceMs (default 3 days). Returns how many. */
export function pruneOldMasters(graceMs = 3 * 86400_000, now = Date.now()) {
  const p = kekFilePath(), dir = dirname(p), base = p.slice(dir.length + 1) + ".prev-";
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(base)) continue;
    if (now - Number(f.slice(base.length)) > graceMs) { rmSync(join(dir, f), { force: true }); n++; }
  }
  return n;
}

/**
 * Opens the keystore and, when there is anything to read or the flag is on, unwraps the install key
 * (one KMS call). Called with top-level await from db.js before any query, so every read after it can
 * stay synchronous. With the flag off and no key ever made, it does nothing at all.
 */
export async function init(dbPath, { hasSealed = () => false } = {}) {
  const path = keystorePath(dbPath);
  // With the flag off, nothing is created: no keys.db, no KMS call, unless sealed rows exist to read.
  const sealedRows = hasSealed();
  if (!flagOn() && !sealedRows) return { active: false };
  if (path !== ":memory:" && !existsSync(path) && sealedRows) {
    throw new Error(`reason.db holds sealed rows but the keystore ${path} is missing. Restore keys.db (latest backup) before starting; starting without it would read everyone as blank.`);
  }
  ks = openKeystore(path);
  const all = ks.prepare("SELECT version, source, wrapped, retired_at FROM install_key ORDER BY version DESC").all();
  const cur = all.find(r => r.retired_at == null);
  if (!cur && sealedRows) throw new Error("reason.db holds sealed rows but the keystore has no install key: wrong or empty keys.db.");
  if (cur) {
    // Retired install keys stay usable: a person key wrapped under one (a process that had not seen a
    // rotation yet) still opens. One KMS call per version, at boot only.
    for (const r of all) iks.set(r.version, await unwrapIK(r.source, r.wrapped));
    ik = iks.get(cur.version); ikVersion = cur.version;
  } else {
    const raw = randomBytes(32);
    const source = sourceName();
    const wrapped = await wrapIK(source, raw);
    ks.prepare("INSERT INTO install_key (version, source, wrapped, created_at) VALUES (1, ?, ?, ?)").run(source, wrapped, Date.now());
    ik = raw; ikVersion = 1; iks.set(1, raw);
  }
  if (flag2On()) ensureIndexKey();
  return { active: true };
}
let ikVersion = 0;
const iks = new Map(); // install key version -> Buffer
export function active() { return !!ik; }

function ikFor(version) {
  if (iks.has(version)) return iks.get(version);
  throw new Error(`Person key wrapped under install key v${version}, which this process has not unlocked (rotated by another process?). Restart Reason.`);
}

function loadDek(keyId) {
  if (deks.has(keyId)) return deks.get(keyId);
  if (!ik) throw new Error("Sealed data found but the install key is not unlocked (REASON_REST_KEK_SOURCE / KMS unreachable at boot?).");
  const row = ks.prepare("SELECT id, conversation_id, wrapped, ik_version FROM user_keys WHERE id = ?").get(keyId);
  if (!row) {
    if (ks.prepare("SELECT 1 FROM shredded WHERE key_id = ?").get(keyId)) return null; // destroyed on purpose
    throw new Error(`Person key ${keyId} is not in the keystore and was never destroyed: keys.db is older than reason.db or from another install. Restore the matching keys.db.`);
  }
  // A KeyObject, made once: handing node:crypto a raw Buffer re-imports the key on every call (~5x slower).
  const k = createSecretKey(gcmOpen(ikFor(row.ik_version), row.wrapped, `dek:${row.id}`));
  deks.set(keyId, k); deks.set("c:" + row.conversation_id, row.id);
  return k;
}

function keyIdFor(conversationId, create) {
  const c = String(conversationId ?? "");
  if (!c) throw new Error("sealFor needs the owner's conversation id.");
  // Always asked of the keystore, never only the cache: another process (data:delete, forget run from
  // a script) may have destroyed or replaced this person's key, and a write sealed under a destroyed
  // key would read as blank after the next restart. One indexed lookup per write.
  const row = ks.prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(c);
  const cached = deks.get("c:" + c);
  if (cached !== undefined && (!row || row.id !== cached)) { deks.delete(cached); deks.delete("c:" + c); opened.clear(); }
  if (row) { loadDek(row.id); return row.id; }
  if (!create) return null;
  if (!ik) throw new Error("Encryption at rest is on but the install key is not unlocked.");
  return newKeyRow(c);
}

/**
 * A new person key, in one keystore write. Ids are random (48-bit), never a counter: a keystore
 * restored from an older backup then lacks a key (a loud error) instead of handing an old id to
 * someone else (silent wrong key). Another process making the same person's key at the same moment
 * loses the race quietly and uses the winner's.
 */
function newKeyRow(c) {
  const raw = randomBytes(32);
  const id = randomBytes(6).readUIntBE(0, 6);
  const r = ks.prepare("INSERT OR IGNORE INTO user_keys (id, conversation_id, wrapped, ik_version, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, c, gcmSeal(ik, raw, `dek:${id}`), ikVersion, Date.now());
  if (Number(r.changes) === 1) { deks.set(id, createSecretKey(raw)); deks.set("c:" + c, id); return id; }
  const won = ks.prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(c);
  if (!won) throw new Error("Could not make a person key (id clash); try again.");
  loadDek(won.id);
  return won.id;
}

const SEALED_CELLS = new Map(ALL_SENSITIVE.flatMap(s => s.cols.map(c => [`${s.table}.${c}`, s.phase])));
/** For code that writes a table/column chosen at run time: seals only if that column is sealed now. */
export function sealCell(table, col, conversationId, plain) {
  const phase = SEALED_CELLS.get(`${table}.${col}`);
  if (!phase) return plain;
  return phase === 1 ? sealFor(conversationId, plain) : sealFor2(conversationId, plain);
}

/** Phase 2 columns (SENSITIVE2): seals only with REASON_ENCRYPT_REST2=on (and phase 1 on). */
export function sealFor2(conversationId, plain) {
  if (!flag2On() || passThrough(plain) || isSealed(plain)) return plain;
  return forceSeal(conversationId, plain);
}

/** Seal text for its owner. With the flag off it returns the text unchanged. */
export function sealFor(conversationId, plain) {
  if (!flagOn() || passThrough(plain) || isSealed(plain)) return plain;
  return forceSeal(conversationId, plain);
}
export function forceSeal(conversationId, plain) {
  if (passThrough(plain) || isSealed(plain)) return plain;
  // Bytes (a search vector) are sealed as their base64; they open as that base64 string.
  if (plain instanceof Uint8Array) plain = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength).toString("base64");
  const id = keyIdFor(conversationId, true);
  return `${PREFIX}${id}:${gcmSeal(deks.get(id), Buffer.from(String(plain), "utf8"), `u:${id}`)}`;
}

/** What a shredded person's value reads as: their key is gone, so is the text. */
export const SHREDDED = "";

/** Open any value. Plain text passes through; a sealed value whose key was destroyed reads empty. */
const opened = new Map(); // ciphertext -> plain, small LRU: one query that names a value twice opens it once
const OPENED_MAX = 4000;
export function openAny(v) {
  if (!isSealed(v)) return v;
  const hit = opened.get(v);
  if (hit !== undefined) return hit;
  const plain = openUncached(v);
  if (v.length < 8192) { if (opened.size >= OPENED_MAX) opened.delete(opened.keys().next().value); opened.set(v, plain); }
  return plain;
}
function openUncached(v) {
  const rest = v.slice(PREFIX.length);
  const cut = rest.indexOf(":");
  const id = Number(rest.slice(0, cut));
  const k = loadDek(id);
  if (!k) return SHREDDED;
  return gcmOpen(k, rest.slice(cut + 1), `u:${id}`).toString("utf8");
}

/** Crypto-shred: destroy the person's key. Every sealed copy of their data, in any backup, is dead. */
export function destroyKey(conversationId) {
  if (!ks) return false;
  const c = String(conversationId ?? "");
  const row = ks.prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(c);
  if (!row) return false;
  ks.prepare("DELETE FROM user_keys WHERE id = ?").run(row.id);
  ks.prepare("INSERT OR REPLACE INTO shredded (key_id, conv_hash, at) VALUES (?, ?, ?)").run(row.id, createHash("sha256").update(c).digest("hex").slice(0, 16), Date.now());
  deks.delete(row.id); deks.delete("c:" + c); opened.clear();
  return true;
}

/**
 * "Forget everything" without losing the rows that stay (call records, receipts): give the person a
 * new key, re-seal what is left under it, then destroy the old one. Every backup taken before holds
 * only old-key ciphertext, so what was deleted is unreadable there too. Crash-safe: the new key is
 * made under a holding name first, and the old one goes only after every row is moved; a re-run
 * finishes the job. Returns { resealed, shredded }.
 */
export function rotatePersonKey(rawPrepare, conversationId) {
  if (!ks || !ik) return { resealed: 0, shredded: false };
  const c = String(conversationId ?? "");
  const old = ks.prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(c);
  if (!old) return { resealed: 0, shredded: false };
  const hold = c + "\u0000next";
  let nid = ks.prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(hold)?.id;
  if (!nid) nid = newKeyRow(hold);
  const newKey = loadDek(nid);
  const oldTag = `${PREFIX}${old.id}:`;
  let resealed = 0;
  for (const s of ALL_SENSITIVE) {
    if (!tableExists(rawPrepare, s.table)) continue;
    const pk = s.table === "conversations" ? "id" : "rowid";
    for (const c of s.cols) {
      if (!hasCol(rawPrepare, s.table, c)) continue;
      const col = qc(c);
      const upd = rawPrepare(`UPDATE ${s.table} SET ${col} = ? WHERE ${pk} = ? AND ${col} = ?`);
      for (const r of rawPrepare(`SELECT ${pk} AS k, ${col} AS v FROM ${s.table} WHERE substr(${col}, 1, ${oldTag.length}) = ?`).all(oldTag)) {
        const plain = openAny(r.v);
        resealed += Number(upd.run(`${PREFIX}${nid}:${gcmSeal(newKey, Buffer.from(plain, "utf8"), `u:${nid}`)}`, r.k, r.v).changes);
      }
    }
  }
  ks.exec("BEGIN IMMEDIATE");
  try {
    ks.prepare("DELETE FROM user_keys WHERE id = ?").run(old.id);
    ks.prepare("UPDATE user_keys SET conversation_id = ? WHERE id = ?").run(c, nid);
    ks.prepare("INSERT OR REPLACE INTO shredded (key_id, conv_hash, at) VALUES (?, ?, ?)").run(old.id, createHash("sha256").update(c).digest("hex").slice(0, 16), Date.now());
    ks.exec("COMMIT");
  } catch (e) { ks.exec("ROLLBACK"); throw e; }
  deks.delete(old.id); deks.set("c:" + c, nid); opened.clear();
  return { resealed, shredded: true };
}

/** Whole-install delete: every person key destroyed. Returns how many. */
export function destroyAllKeys() {
  if (!ks) return 0;
  const ids = ks.prepare("SELECT id, conversation_id FROM user_keys").all();
  for (const r of ids) destroyKey(r.conversation_id);
  return ids.length;
}

/** Rotate the install key: new IK, every person key re-wrapped. No data row is touched. */
export async function rotateInstallKey() {
  if (!ik) throw new Error("Not active.");
  const raw = randomBytes(32), source = sourceName();
  const wrapped = await wrapIK(source, raw);
  const next = ikVersion + 1;
  ks.exec("BEGIN IMMEDIATE");
  try {
    for (const r of ks.prepare("SELECT id, wrapped, ik_version FROM user_keys").all()) {
      const dek = gcmOpen(ikFor(r.ik_version), r.wrapped, `dek:${r.id}`);
      ks.prepare("UPDATE user_keys SET wrapped = ?, ik_version = ? WHERE id = ?").run(gcmSeal(raw, dek, `dek:${r.id}`), next, r.id);
    }
    ks.prepare("UPDATE install_key SET retired_at = ? WHERE retired_at IS NULL").run(Date.now());
    ks.prepare("INSERT INTO install_key (version, source, wrapped, created_at) VALUES (?, ?, ?, ?)").run(next, source, wrapped, Date.now());
    ks.exec("COMMIT");
  } catch (e) { ks.exec("ROLLBACK"); throw e; }
  ik = raw; ikVersion = next; iks.set(next, raw);
  return next;
}

export function keystore() { return ks; }

// ---------- blind index: exact match on a value that is never stored ----------
// A keyed HMAC-SHA256 of a phone number (or email), "bi1:<base64url>", for a column that is only ever
// matched and never read back (stranger_calls.phone). The index key is its own file beside the master
// (/etc/reason/rest/index.key), never in reason.db, .env or a backup: the off-site backup carries only
// its age-sealed copy (index.key.age, --seal-recovery-copy). Without the key a stolen copy holds hashes
// that can't be checked against guesses; brute-forcing ~10^10 numbers needs the key.
// Rotation (not built; plan in the design doc): write index.key.next, look up with both keys
// (blindIndexes returns every form), write with the new one; once the rows written under the old key
// are past their retention (privacy.js prune), drop the old key. No plaintext is needed to rotate.
export const BI_PREFIX = "bi1:";
export function indexKeyPath() { return process.env.REASON_REST_INDEX_KEY_FILE || join(dirname(kekFilePath()), "index.key"); }
let idxKey = null;
function readIndexKey({ create }) {
  if (idxKey) return idxKey;
  let hex;
  if (sourceName() === "local") {
    // Tests and development only, like REASON_REST_KEK itself.
    hex = String(process.env.REASON_REST_INDEX_KEY ?? "").trim() || createHash("sha256").update("reason-index:" + String(process.env.REASON_REST_KEK ?? "")).digest("hex");
  } else {
    const p = indexKeyPath();
    if (!existsSync(p)) {
      if (!create) return null;
      durableWrite(p, randomBytes(32).toString("hex") + "\n");
    }
    hex = readFileSync(p, "utf8").trim();
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${indexKeyPath()} must hold 64 hex characters (the blind-index key).`);
  idxKey = createSecretKey(Buffer.from(hex, "hex"));
  return idxKey;
}
/** Made at boot when phase 2 is on, so a missing or unwritable key fails loudly then, not mid-call. */
export function ensureIndexKey() { return !!readIndexKey({ create: true }); }
function hmacOf(key, kind, value) { return BI_PREFIX + createHmac("sha256", key).update(`${kind}:${value}`).digest("base64url"); }
/** What to store: the blind index with phase 2 on, else the value itself. "" stays "". */
export function blindIndex(kind, value) {
  const v = String(value ?? "");
  if (!v || !flag2On()) return v;
  return hmacOf(readIndexKey({ create: true }), kind, v);
}
/** Every stored form a lookup must match: the plain value (rows from before) and its blind index. */
export function blindIndexes(kind, value) {
  const v = String(value ?? "");
  if (!v) return [v];
  const k = readIndexKey({ create: false });
  return k ? [v, hmacOf(k, kind, v)] : [v];
}

// ---------- transparent reads ----------
function openRow(row) {
  if (!row || typeof row !== "object") return row;
  for (const k in row) if (isSealed(row[k])) row[k] = openAny(row[k]);
  return row;
}

/**
 * Every statement whose SQL names a sensitive table opens sealed strings in its result rows. Also
 * registers pt(x) so SQL that must look inside text (the ops LIKE filter) can: `pt(text) LIKE ...`.
 * Returns the raw prepare, for the migration and the plaintext-write test.
 */
export function wrapDatabase(db) {
  const rawPrepare = db.prepare.bind(db);
  db.function("pt", { deterministic: true }, v => (isSealed(v) ? openAny(v) : v));
  db.prepare = sql => {
    const st = rawPrepare(sql);
    if (!TABLE_RE.test(sql)) return st;
    const get = st.get.bind(st), all = st.all.bind(st);
    st.get = (...a) => openRow(get(...a));
    st.all = (...a) => { const rows = all(...a); for (const r of rows) openRow(r); return rows; };
    return st;
  };
  return rawPrepare;
}

/**
 * Strict mode (tests, and a shadow check on a copy): SQLite triggers refuse any plaintext write to a
 * sensitive column. This is what catches a write path nobody wired to sealFor.
 */
export function installStrictTriggers(db) {
  for (const s of ALL_SENSITIVE) for (const col of s.cols) {
    if (!phaseOn(s.phase)) { dropTriggersFor(db, s.table, col); continue; }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(s.table)) continue;
    const n = `NEW.${qc(col)}`;
    const cond = `${n} IS NOT NULL AND ${n} <> '' AND ${n} <> '[]' AND substr(${n}, 1, ${PREFIX.length}) <> '${PREFIX}'`;
    const msg = `plaintext write to ${s.table}.${col} with REASON_ENCRYPT_REST${s.phase === 2 ? "2" : ""}=on`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS rest_strict_${s.table}_${col}_i BEFORE INSERT ON ${s.table} WHEN ${cond} BEGIN SELECT RAISE(ABORT, '${msg}'); END;
      CREATE TRIGGER IF NOT EXISTS rest_strict_${s.table}_${col}_u BEFORE UPDATE OF ${qc(col)} ON ${s.table} WHEN ${cond} BEGIN SELECT RAISE(ABORT, '${msg}'); END;`);
  }
}
function dropTriggersFor(db, table, col) { db.exec(`DROP TRIGGER IF EXISTS rest_strict_${table}_${col}_i; DROP TRIGGER IF EXISTS rest_strict_${table}_${col}_u;`); }
export function dropStrictTriggers(db) {
  for (const s of ALL_SENSITIVE) for (const col of s.cols) dropTriggersFor(db, s.table, col);
}

// ---------- online migration ----------
function tableExists(rawPrepare, t) { return !!rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t); }
function hasCol(rawPrepare, t, c) { return rawPrepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c); }

/**
 * One small batch of the online migration. direction "seal" seals plain rows (flag on);
 * "open" writes sealed rows back as plain text (rollback, flag off). Each row is updated only if it
 * still holds the value we read (`AND col = ?`), so a write that lands meanwhile is never clobbered.
 * Returns how many rows it changed (at least 1 while there is work left); 0 means that direction is
 * finished. Keeps a cursor per column, so each call reads only the next rows, never the whole table.
 */
const shape = new Map();
function colsOf(rawPrepare, t) {
  // A table another module makes later (stranger_calls, shop_shipping) is not cached as missing.
  if (!shape.has(t)) {
    if (!rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t)) return null;
    shape.set(t, new Set(rawPrepare(`PRAGMA table_info(${t})`).all().map(r => r.name)));
  }
  return shape.get(t);
}
const cursors = new Map(); // "dir:table.col" -> last primary key done, so a batch never rescans

export function migrateBatch(rawPrepare, direction = "seal", batch = 200, phases = null) {
  let changed = 0;
  // Seal: only what its flag says is sealed now. Open (rollback): every phase, or only `phases`,
  // so phase 2 rolls back on its own (REASON_ENCRYPT_REST2=off, --open) while phase 1 stays sealed.
  for (const s of ALL_SENSITIVE) {
    if (direction === "seal" ? !phaseOn(s.phase) : (phases && !phases.includes(s.phase))) continue;
    const cols = colsOf(rawPrepare, s.table);
    if (!cols) continue;
    const pk = s.table === "conversations" ? "id" : "rowid";
    // A thread is one JSON value that can run to hundreds of KB: a few at a time keeps a batch short.
    const limit = s.table === "conversations" ? Math.max(1, Math.ceil(batch / 50)) : batch;
    for (const c of s.cols) {
      if (!cols.has(c)) continue;
      const col = qc(c);
      const where = direction === "seal"
        ? `${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]' AND substr(${col}, 1, ${PREFIX.length}) <> '${PREFIX}'`
        : `substr(${col}, 1, ${PREFIX.length}) = '${PREFIX}'`;
      const ck = `${direction}:${s.table}.${c}`;
      const from = cursors.get(ck) ?? (pk === "id" ? "" : -1);
      const rows = rawPrepare(`SELECT ${pk} AS k, ${col} AS v, ${s.owner} AS owner FROM ${s.table} WHERE ${pk} > ? AND ${where} ORDER BY ${pk} LIMIT ${limit}`).all(from);
      if (!rows.length) continue;
      cursors.set(ck, rows[rows.length - 1].k);
      const upd = rawPrepare(`UPDATE OR IGNORE ${s.table} SET ${col} = ? WHERE ${pk} = ? AND ${col} = ?`);
      rawPrepare("SAVEPOINT rest_mig").run();
      try {
        for (const r of rows) {
          if (direction === "seal" && !r.owner) continue; // orphan fact with no person: left for --status
          const next = direction === "seal" ? forceSeal(r.owner, r.v) : (s.blob ? Buffer.from(openAny(r.v), "base64") : openAny(r.v));
          changed += Number(upd.run(next, r.k, r.v).changes);
        }
        rawPrepare("RELEASE rest_mig").run();
      } catch (e) { rawPrepare("ROLLBACK TO rest_mig").run(); rawPrepare("RELEASE rest_mig").run(); throw e; }
      // One column's batch per call keeps each call short. Rows skipped (orphans, unique clashes)
      // still advance the cursor, so they are reported by --status and never spun on.
      return Math.max(changed, 1);
    }
  }
  // A full pass found nothing left: reset cursors so a later run (new plain rows) starts again.
  for (const k of [...cursors.keys()]) if (k.startsWith(direction + ":")) cursors.delete(k);
  return 0;
}

/** Counts for --status and /ops: how much is sealed vs plain, per column. */
export function status(rawPrepare) {
  const out = [];
  for (const s of ALL_SENSITIVE) {
    if (!tableExists(rawPrepare, s.table)) continue;
    for (const c of s.cols) {
      if (!hasCol(rawPrepare, s.table, c)) continue;
      const col = qc(c);
      const r = rawPrepare(`SELECT
        SUM(CASE WHEN substr(${col},1,${PREFIX.length}) = '${PREFIX}' THEN 1 ELSE 0 END) AS sealed,
        SUM(CASE WHEN ${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]' AND substr(${col},1,${PREFIX.length}) <> '${PREFIX}' THEN 1 ELSE 0 END) AS plain
        FROM ${s.table}`).get();
      out.push({ column: `${s.table}.${c}`, phase: s.phase, sealed: Number(r.sealed ?? 0), plain: Number(r.plain ?? 0) });
    }
  }
  return out;
}

/** Test hook: forget in-memory keys (simulates a fresh process). */
export function _resetForTests() { idxKey = null; ks = null; ik = null; ikVersion = 0; deks.clear(); iks.clear(); opened.clear(); cursors.clear(); shape.clear(); }

/** For db.js: does reason.db already hold any sealed value? Cheap: one indexed-free LIMIT 1 per column. */
export function anySealed(rawPrepare) {
  for (const s of ALL_SENSITIVE) {
    if (!rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(s.table)) continue;
    const cols = new Set(rawPrepare(`PRAGMA table_info(${s.table})`).all().map(r => r.name));
    for (const col of s.cols) if (cols.has(col) && rawPrepare(`SELECT 1 FROM ${s.table} WHERE substr(${qc(col)}, 1, ${PREFIX.length}) = '${PREFIX}' LIMIT 1`).get()) return true;
  }
  return false;
}
