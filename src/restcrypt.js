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
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

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
const TABLE_RE = new RegExp(`\\b(${SENSITIVE.map(s => s.table).join("|")})\\b`, "i");

export function flagOn() { return String(process.env.REASON_ENCRYPT_REST ?? "off").trim().toLowerCase() === "on"; }
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

async function wrapIK(source, raw) {
  if (source === "local") return gcmSeal(localKek(), raw, "reason-ik");
  if (source === "aws-kms") {
    const keyId = process.env.REASON_REST_KMS_KEY_ID;
    if (!keyId) throw new Error("REASON_REST_KMS_KEY_ID is not set.");
    const j = await kmsCall("Encrypt", { KeyId: keyId, Plaintext: raw.toString("base64"), EncryptionContext: KMS_CONTEXT });
    return j.CiphertextBlob;
  }
  throw new Error(`Unknown REASON_REST_KEK_SOURCE "${source}" (aws-kms or local).`);
}
async function unwrapIK(source, wrapped) {
  if (source === "local") return gcmOpen(localKek(), wrapped, "reason-ik");
  if (source === "aws-kms") {
    const j = await kmsCall("Decrypt", { CiphertextBlob: wrapped, EncryptionContext: KMS_CONTEXT, KeyId: process.env.REASON_REST_KMS_KEY_ID });
    return Buffer.from(j.Plaintext, "base64");
  }
  throw new Error(`Unknown key source "${source}".`);
}

function sourceName() { return String(process.env.REASON_REST_KEK_SOURCE || "aws-kms").trim(); }

/**
 * Opens the keystore and, when there is anything to read or the flag is on, unwraps the install key
 * (one KMS call). Called with top-level await from db.js before any query, so every read after it can
 * stay synchronous. With the flag off and no key ever made, it does nothing at all.
 */
export async function init(dbPath) {
  ks = openKeystore(keystorePath(dbPath));
  const cur = ks.prepare("SELECT version, source, wrapped FROM install_key WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1").get();
  if (!cur && !flagOn()) return { active: false };
  if (cur) { ik = await unwrapIK(cur.source, cur.wrapped); ikVersion = cur.version; }
  else {
    const raw = randomBytes(32);
    const source = sourceName();
    const wrapped = await wrapIK(source, raw);
    ks.prepare("INSERT INTO install_key (version, source, wrapped, created_at) VALUES (1, ?, ?, ?)").run(source, wrapped, Date.now());
    ik = raw; ikVersion = 1;
  }
  return { active: true };
}
let ikVersion = 0;
export function active() { return !!ik; }

function ikFor(version) {
  if (version === ikVersion) return ik;
  throw new Error(`Person key wrapped under install key v${version}, current is v${ikVersion}: run scripts/encrypt-rest.mjs --rewrap.`);
}

function loadDek(keyId) {
  if (deks.has(keyId)) return deks.get(keyId);
  if (!ik) throw new Error("Sealed data found but the install key is not unlocked (REASON_REST_KEK_SOURCE / KMS unreachable at boot?).");
  const row = ks.prepare("SELECT id, conversation_id, wrapped, ik_version FROM user_keys WHERE id = ?").get(keyId);
  if (!row) return null; // shredded
  const k = gcmOpen(ikFor(row.ik_version), row.wrapped, `dek:${row.id}`);
  deks.set(keyId, k); deks.set("c:" + row.conversation_id, row.id);
  return k;
}

function keyIdFor(conversationId, create) {
  const c = String(conversationId ?? "");
  if (!c) throw new Error("sealFor needs the owner's conversation id.");
  if (deks.has("c:" + c)) return deks.get("c:" + c);
  const row = ks.prepare("SELECT id FROM user_keys WHERE conversation_id = ?").get(c);
  if (row) { loadDek(row.id); return row.id; }
  if (!create) return null;
  if (!ik) throw new Error("Encryption at rest is on but the install key is not unlocked.");
  const raw = randomBytes(32);
  const id = Number(ks.prepare("INSERT INTO user_keys (conversation_id, wrapped, ik_version, created_at) VALUES (?, '', ?, ?)").run(c, ikVersion, Date.now()).lastInsertRowid);
  ks.prepare("UPDATE user_keys SET wrapped = ? WHERE id = ?").run(gcmSeal(ik, raw, `dek:${id}`), id);
  deks.set(id, raw); deks.set("c:" + c, id);
  return id;
}

/** Seal text for its owner. With the flag off it returns the text unchanged. */
export function sealFor(conversationId, plain) {
  if (!flagOn() || passThrough(plain) || isSealed(plain)) return plain;
  return forceSeal(conversationId, plain);
}
export function forceSeal(conversationId, plain) {
  if (passThrough(plain) || isSealed(plain)) return plain;
  const id = keyIdFor(conversationId, true);
  return `${PREFIX}${id}:${gcmSeal(deks.get(id), Buffer.from(String(plain), "utf8"), `u:${id}`)}`;
}

/** What a shredded person's value reads as: their key is gone, so is the text. */
export const SHREDDED = "";

/** Open any value. Plain text passes through; a sealed value whose key was destroyed reads empty. */
export function openAny(v) {
  if (!isSealed(v)) return v;
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
  deks.delete(row.id); deks.delete("c:" + c);
  return true;
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
  ik = raw; ikVersion = next;
  return next;
}

export function keystore() { return ks; }

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
  for (const s of SENSITIVE) for (const col of s.cols) {
    const cond = `NEW.${col} IS NOT NULL AND NEW.${col} <> '' AND NEW.${col} <> '[]' AND substr(NEW.${col}, 1, ${PREFIX.length}) <> '${PREFIX}'`;
    const msg = `plaintext write to ${s.table}.${col} with REASON_ENCRYPT_REST=on`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS rest_strict_${s.table}_${col}_i BEFORE INSERT ON ${s.table} WHEN ${cond} BEGIN SELECT RAISE(ABORT, '${msg}'); END;
      CREATE TRIGGER IF NOT EXISTS rest_strict_${s.table}_${col}_u BEFORE UPDATE OF ${col} ON ${s.table} WHEN ${cond} BEGIN SELECT RAISE(ABORT, '${msg}'); END;`);
  }
}
export function dropStrictTriggers(db) {
  for (const s of SENSITIVE) for (const col of s.cols) db.exec(`DROP TRIGGER IF EXISTS rest_strict_${s.table}_${col}_i; DROP TRIGGER IF EXISTS rest_strict_${s.table}_${col}_u;`);
}

// ---------- online migration ----------
function tableExists(rawPrepare, t) { return !!rawPrepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t); }
function hasCol(rawPrepare, t, c) { return rawPrepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c); }

/**
 * One small batch of the online migration. direction "seal" seals plain rows (flag on);
 * "open" writes sealed rows back as plain text (rollback, flag off). Each row is updated only if it
 * still holds the value we read (`AND col = ?`), so a write that lands meanwhile is never clobbered.
 * Returns how many rows it changed; 0 means that direction is finished.
 */
export function migrateBatch(rawPrepare, direction = "seal", batch = 200) {
  let changed = 0;
  for (const s of SENSITIVE) {
    if (!tableExists(rawPrepare, s.table)) continue;
    const pk = s.table === "conversations" ? "id" : "rowid";
    for (const col of s.cols) {
      if (!hasCol(rawPrepare, s.table, col)) continue;
      const where = direction === "seal"
        ? `${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]' AND substr(${col}, 1, ${PREFIX.length}) <> '${PREFIX}'`
        : `substr(${col}, 1, ${PREFIX.length}) = '${PREFIX}'`;
      const rows = rawPrepare(`SELECT ${pk} AS k, ${col} AS v, ${s.owner} AS owner FROM ${s.table} WHERE ${where} LIMIT ${batch}`).all();
      const upd = rawPrepare(`UPDATE OR IGNORE ${s.table} SET ${col} = ? WHERE ${pk} = ? AND ${col} = ?`);
      for (const r of rows) {
        if (direction === "seal" && !r.owner) continue; // orphan fact with no person: left for the report
        const next = direction === "seal" ? forceSeal(r.owner, r.v) : openAny(r.v);
        changed += Number(upd.run(next, r.k, r.v).changes);
      }
    }
  }
  return changed;
}

/** Counts for --status and /ops: how much is sealed vs plain, per column. */
export function status(rawPrepare) {
  const out = [];
  for (const s of SENSITIVE) {
    if (!tableExists(rawPrepare, s.table)) continue;
    for (const col of s.cols) {
      if (!hasCol(rawPrepare, s.table, col)) continue;
      const r = rawPrepare(`SELECT
        SUM(CASE WHEN substr(${col},1,${PREFIX.length}) = '${PREFIX}' THEN 1 ELSE 0 END) AS sealed,
        SUM(CASE WHEN ${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]' AND substr(${col},1,${PREFIX.length}) <> '${PREFIX}' THEN 1 ELSE 0 END) AS plain
        FROM ${s.table}`).get();
      out.push({ column: `${s.table}.${col}`, sealed: Number(r.sealed ?? 0), plain: Number(r.plain ?? 0) });
    }
  }
  return out;
}

/** Test hook: forget in-memory keys (simulates a fresh process). */
export function _resetForTests() { ks = null; ik = null; ikVersion = 0; deks.clear(); }
