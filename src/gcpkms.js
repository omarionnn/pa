// Google Cloud KMS client (vault keys, design B3; optional master for encryption at rest).
// No SDK: Node crypto and fetch only.
//
// Login: a service-account JSON key file named by REASON_GCP_KEY_FILE. Its private key is turned into a
// KeyObject and held in this module's memory only. It is never logged, never put in an error and
// never sent anywhere: it only signs a short RS256 JWT, exchanged at oauth2.googleapis.com for an
// access token with the cloudkms scope. The token is cached until 5 minutes before it expires.
//
// Key names: projects/<project_id from the file>/locations/us-west1/keyRings/reason/cryptoKeys/<name>,
// names reason-vault (symmetric), reason-vault-intake (RSA_DECRYPT_OAEP_4096_SHA256) and reason-rest
// (symmetric). Each part can be overridden by env (keyName below).
//
// Retries: only throttling (429, RESOURCE_EXHAUSTED), Google-side failures (5xx, UNAVAILABLE, INTERNAL,
// DEADLINE_EXCEEDED, ABORTED) and network errors or timeouts, 5 tries in all. A refusal (permission,
// invalid argument, failed precondition, not found, a wrong AAD) is thrown at once: retrying it only
// repeats the refusal in Google's audit log and makes the person wait.
//
// Tests point REASON_GCP_KMS_ENDPOINT (and the key file's token_uri) at a stand-in on 127.x; that is
// refused outside a test run (NODE_TEST_CONTEXT). Every request carries CRC32C checks, as Google advises.
import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";
export const PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_KMS = "https://cloudkms.googleapis.com";
const GOOGLE_CRM = "https://cloudresourcemanager.googleapis.com";
const DEFAULT_KEYS = { vault: "reason-vault", intake: "reason-vault-intake", rest: "reason-rest" };
const KEY_ENV = { vault: "REASON_GCP_VAULT_KEY", intake: "REASON_GCP_INTAKE_KEY", rest: "REASON_GCP_REST_KEY" };

const inTest = () => !!process.env.NODE_TEST_CONTEXT;
const loopback = u => /^http:\/\/127\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/|$)/.test(String(u));
/** A Google https address, or a 127.x stand-in during a test run only. */
function allowedBase(u, google) {
  if (u === google) return true;
  return loopback(u) && inTest();
}

export function keyFilePath() { return String(process.env.REASON_GCP_KEY_FILE ?? "").trim(); }

// ---------------------------------------------------------------- CRC32C (Castagnoli)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82F63B78 : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32c(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const crcStr = buf => String(crc32c(buf));

// ---------------------------------------------------------------- the key file
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,63}$/;

/**
 * Check a service-account key file without keeping or showing anything from it. Every field is a
 * boolean; `creds` (internal) holds the parsed login when everything passed.
 */
function inspectKeyFile(file) {
  const out = { set: !!file, readable: false, privateToOwner: false, json: false, serviceAccount: false, projectId: false,
    clientEmail: false, privateKeyId: false, privateKey: false, tokenUri: false };
  if (!file) return { out, creds: null };
  let st, raw;
  try { st = statSync(file); raw = readFileSync(file); out.readable = st.isFile(); } catch { return { out, creds: null }; }
  out.privateToOwner = (st.mode & 0o007) === 0;   // no rights for "other"; 0600 or 0640 root:reason
  let j;
  try { j = JSON.parse(raw.toString("utf8")); out.json = !!j && typeof j === "object"; }
  catch { /* the parser's message can quote the file: never pass it on */ }
  finally { raw.fill(0); }
  if (!out.json) return { out, creds: null };
  out.serviceAccount = j.type === "service_account";
  out.projectId = typeof j.project_id === "string" && PROJECT_RE.test(j.project_id);
  out.clientEmail = typeof j.client_email === "string" && /^[a-z0-9-]{6,30}@[a-z0-9-]{6,30}\.iam\.gserviceaccount\.com$/.test(j.client_email)
    && (!out.projectId || j.client_email.endsWith(`@${j.project_id}.iam.gserviceaccount.com`));
  out.privateKeyId = typeof j.private_key_id === "string" && /^[0-9a-f]{40}$/.test(j.private_key_id);
  let key = null;
  if (typeof j.private_key === "string" && j.private_key.includes("-----BEGIN PRIVATE KEY-----")) {
    try { key = createPrivateKey({ key: j.private_key, format: "pem" }); out.privateKey = key.asymmetricKeyType === "rsa"; }
    catch { key = null; }
  }
  j.private_key = undefined;
  const tokenUri = j.token_uri ?? GOOGLE_TOKEN_URI;
  out.tokenUri = typeof tokenUri === "string" && allowedBase(tokenUri, GOOGLE_TOKEN_URI);
  const ok = Object.values(out).every(Boolean);
  const identity = Object.entries(out).every(([k, v]) => v || k === "privateToOwner") ? { projectId: j.project_id, email: j.client_email } : null;
  const creds = ok ? { file, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, mode: st.mode, projectId: j.project_id, email: j.client_email,
    keyId: j.private_key_id, tokenUri, key } : null;
  return { out, creds, identity };
}

/**
 * The project id and account email of a well-formed key file, even one others can read (the check
 * script's dry run on a fresh download). Neither is a secret; the private key is not kept.
 */
export function fileIdentity(file = keyFilePath()) { return inspectKeyFile(file).identity; }

/** Booleans only: is the key file there, private, and shaped like a Google service-account key. */
export function checkKeyFile(file = keyFilePath()) { return inspectKeyFile(file).out; }

let creds = null;
function credentials() {
  const file = keyFilePath();
  if (!file) throw kmsError("credentials", 0, "NO_KEY_FILE", "REASON_GCP_KEY_FILE is not set.");
  if (creds && creds.file === file) {
    try {
      const st = statSync(file);
      if (st.mtimeMs === creds.mtimeMs && st.size === creds.size && st.ino === creds.ino && st.mode === creds.mode) return creds;
    } catch { /* gone: re-check below */ }
  }
  const { out, creds: c } = inspectKeyFile(file);
  if (!c) {
    creds = null;
    const failed = Object.entries(out).filter(([, v]) => !v).map(([k]) => k).join(", ");
    throw kmsError("credentials", 0, "BAD_KEY_FILE", `the Google key file failed: ${failed}.`);
  }
  if (creds?.file !== c.file || creds?.keyId !== c.keyId) tokens.clear();
  creds = c;
  return creds;
}

/** The project the keys live in: REASON_GCP_PROJECT, else the key file's project_id. */
export function projectId() {
  const p = String(process.env.REASON_GCP_PROJECT ?? "").trim();
  if (p) { if (!PROJECT_RE.test(p)) throw new Error("REASON_GCP_PROJECT is not a project id."); return p; }
  return credentials().projectId;
}

/**
 * The full resource name of one of Reason's keys: which = vault | intake | rest. REASON_GCP_<WHICH>_KEY
 * may be a short name or a full "projects/..." name; REASON_GCP_KMS_LOCATION (us-west1) and
 * REASON_GCP_KMS_RING (reason) override the rest.
 */
export function keyName(which) {
  if (!DEFAULT_KEYS[which]) throw new Error(`unknown key "${which}".`);
  const over = String(process.env[KEY_ENV[which]] ?? "").trim();
  if (over.startsWith("projects/")) {
    if (!/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,63}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}$/.test(over)) {
      throw new Error(`${KEY_ENV[which]} is not a cryptoKey resource name.`);
    }
    return over;
  }
  const name = over || DEFAULT_KEYS[which];
  const location = String(process.env.REASON_GCP_KMS_LOCATION ?? "").trim() || "us-west1";
  const ring = String(process.env.REASON_GCP_KMS_RING ?? "").trim() || "reason";
  for (const [k, v] of [["key", name], ["location", location], ["key ring", ring]]) if (!SEGMENT_RE.test(v)) throw new Error(`Google KMS ${k} name is not valid.`);
  return `projects/${projectId()}/locations/${location}/keyRings/${ring}/cryptoKeys/${name}`;
}
/** The intake key's version (asymmetric keys are used by version): REASON_GCP_INTAKE_VERSION, default 1. */
export function intakeVersionName() {
  const v = String(process.env.REASON_GCP_INTAKE_VERSION ?? "").trim() || "1";
  if (!/^[0-9]{1,9}$/.test(v)) throw new Error("REASON_GCP_INTAKE_VERSION must be a version number.");
  return `${keyName("intake")}/cryptoKeyVersions/${v}`;
}

function kmsBase() {
  const b = String(process.env.REASON_GCP_KMS_ENDPOINT ?? "").trim().replace(/\/+$/, "") || GOOGLE_KMS;
  if (!allowedBase(b, GOOGLE_KMS)) throw kmsError("endpoint", 0, "BAD_ENDPOINT", "REASON_GCP_KMS_ENDPOINT must be Google's (a 127.x stand-in only in a test run).");
  return b;
}
function crmBase() {
  const b = String(process.env.REASON_GCP_CRM_ENDPOINT ?? "").trim().replace(/\/+$/, "") || GOOGLE_CRM;
  if (!allowedBase(b, GOOGLE_CRM)) throw kmsError("endpoint", 0, "BAD_ENDPOINT", "REASON_GCP_CRM_ENDPOINT must be Google's (a 127.x stand-in only in a test run).");
  return b;
}

/** Key file present, private, valid; the endpoint allowed; the named key buildable. Never throws. */
export function configured(which = "vault") {
  try {
    if (!keyFilePath()) return false;
    credentials();
    kmsBase();
    keyName(which);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- errors and retries
function kmsError(op, status, code, detail = "") {
  const err = new Error(`Google KMS ${op}${status ? ` ${status}` : ""}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`);
  err.gcpStatus = status;
  err.gcpCode = code;
  return err;
}
const NO_RETRY = new Set(["PERMISSION_DENIED", "INVALID_ARGUMENT", "FAILED_PRECONDITION", "NOT_FOUND", "UNAUTHENTICATED",
  "ALREADY_EXISTS", "OUT_OF_RANGE", "UNIMPLEMENTED", "CANCELLED",
  // the token endpoint's OAuth errors
  "invalid_grant", "invalid_client", "unauthorized_client", "invalid_request", "invalid_scope", "access_denied",
  // this module's own checks
  "NO_KEY_FILE", "BAD_KEY_FILE", "BAD_ENDPOINT", "BAD_ANSWER", "INTEGRITY"]);
const RETRY = new Set(["RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED", "ABORTED"]);
/** Google KMS retry decision: throttling, Google-side and network failures only. Exported for its test. */
export function gcpRetry(err) {
  const code = String(err?.gcpCode ?? ""), status = Number(err?.gcpStatus ?? 0);
  if (NO_RETRY.has(code)) return false;
  if (!status) return !code;                    // network error or timeout: no answer from Google
  if (RETRY.has(code)) return true;
  return status >= 500 || status === 429;       // any other 4xx is a refusal
}

// One HTTP exchange, up to 5 tries, waiting 0.5 s, 1 s, 2 s, 4 s between them (the same steps as
// restcrypt's kmsCall). The request body may hold a base64 key; it is never put in an error.
async function send(op, url, init, retry = gcpRetry) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = j?.error;
        const code = typeof e === "string" ? e : String(e?.status ?? "");
        const msg = typeof e === "string" ? String(j.error_description ?? "") : String(e?.message ?? "");
        throw kmsError(op, r.status, code, msg.replace(/\s+/g, " ").slice(0, 200));
      }
      return j;
    } catch (e) {
      last = e;
      if (!retry(e)) throw e;
      if (i < 4) await new Promise(res => setTimeout(res, 500 * 2 ** i));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- the access token
const tokens = new Map();   // scope -> { token, until } | { pending: Promise }
/** An OAuth access token for `scope`, from a self-signed RS256 JWT. Cached until 5 minutes before expiry. */
export async function accessToken(scope = KMS_SCOPE) {
  const c = credentials();
  const hit = tokens.get(scope);
  if (hit?.token && hit.keyId === c.keyId && hit.until > Date.now()) return hit.token;
  if (hit?.pending && hit.keyId === c.keyId) return hit.pending;
  const pending = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const part = o => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT", kid: c.keyId })}.${part({ iss: c.email, scope, aud: c.tokenUri, iat: now, exp: now + 3600 })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(c.key).toString("base64url");
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString();
    const j = await send("token", c.tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const token = typeof j.access_token === "string" ? j.access_token : "";
    const ttl = Number(j.expires_in);
    if (!token || !Number.isFinite(ttl) || ttl <= 0) throw kmsError("token", 0, "BAD_ANSWER", "no access token in the answer.");
    tokens.set(scope, { token, keyId: c.keyId, until: Date.now() + Math.max(30, ttl - 300) * 1000 });
    return token;
  })();
  tokens.set(scope, { pending, keyId: c.keyId });
  try { return await pending; }
  catch (e) { if (tokens.get(scope)?.pending === pending) tokens.delete(scope); throw e; }
}
/** Forget every cached token (tests; a rotated key file is noticed on its own). */
export function forgetTokens() { tokens.clear(); }

// A KMS call with a bearer token. A 401 (a token Google no longer takes) gets one fresh token and one
// more try; every other refusal is final.
async function kmsCall(op, resource, verb, body, { method = "POST", scope = KMS_SCOPE, base = kmsBase(), api = "v1" } = {}) {
  const url = `${base}/${api}/${resource}${verb}`;
  for (let fresh = 0; ; fresh++) {
    const token = await accessToken(scope);
    const init = { method, headers: { authorization: `Bearer ${token}` } };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    try { return await send(op, url, init); }
    catch (e) {
      if (e.gcpStatus === 401 && fresh === 0) { tokens.delete(scope); continue; }
      throw e;
    }
  }
}

function b64(buf) { return Buffer.from(buf).toString("base64"); }
function integrity(op, ok) { if (!ok) throw kmsError(op, 0, "INTEGRITY", "a CRC32C check failed."); }

// ---------------------------------------------------------------- the operations
/** Symmetric encrypt under `keyName` with additional authenticated data. Gives { ciphertext (base64), name (the key version used) }. */
export async function encrypt(keyName, plaintext, aad) {
  if (!Buffer.isBuffer(plaintext) || !plaintext.length) throw kmsError("encrypt", 0, "INVALID_ARGUMENT", "plaintext must be a non-empty Buffer.");
  const a = Buffer.from(aad ?? "");
  if (!a.length) throw kmsError("encrypt", 0, "INVALID_ARGUMENT", "additional authenticated data is required.");
  const body = { plaintext: b64(plaintext), plaintextCrc32c: crcStr(plaintext), additionalAuthenticatedData: b64(a), additionalAuthenticatedDataCrc32c: crcStr(a) };
  const j = await kmsCall("encrypt", keyName, ":encrypt", body);
  body.plaintext = undefined;
  const ct = Buffer.from(String(j.ciphertext ?? ""), "base64");
  integrity("encrypt", j.verifiedPlaintextCrc32c === true && j.verifiedAdditionalAuthenticatedDataCrc32c === true
    && ct.length > 0 && String(j.ciphertextCrc32c) === crcStr(ct));
  return { ciphertext: j.ciphertext, name: String(j.name || keyName) };
}

/** Symmetric decrypt; the AAD must equal the one given at encrypt, or Google refuses (INVALID_ARGUMENT). Gives a Buffer. */
export async function decrypt(keyName, ciphertext, aad) {
  const ct = Buffer.from(String(ciphertext ?? ""), "base64");
  const a = Buffer.from(aad ?? "");
  if (!ct.length || !a.length) throw kmsError("decrypt", 0, "INVALID_ARGUMENT", "ciphertext and additional authenticated data are required.");
  const j = await kmsCall("decrypt", keyName, ":decrypt", { ciphertext: b64(ct), ciphertextCrc32c: crcStr(ct),
    additionalAuthenticatedData: b64(a), additionalAuthenticatedDataCrc32c: crcStr(a) });
  const plain = Buffer.from(String(j.plaintext ?? ""), "base64");
  j.plaintext = undefined;
  if (String(j.plaintextCrc32c) !== crcStr(plain)) { plain.fill(0); integrity("decrypt", false); }
  return plain;
}

/** RSA-OAEP decrypt with an asymmetric key version (the intake key). Gives a Buffer. */
export async function asymmetricDecrypt(versionName, ciphertext) {
  const ct = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(String(ciphertext ?? ""), "base64");
  if (!ct.length) throw kmsError("asymmetricDecrypt", 0, "INVALID_ARGUMENT", "ciphertext is required.");
  const j = await kmsCall("asymmetricDecrypt", versionName, ":asymmetricDecrypt", { ciphertext: b64(ct), ciphertextCrc32c: crcStr(ct) });
  const plain = Buffer.from(String(j.plaintext ?? ""), "base64");
  j.plaintext = undefined;
  if (j.verifiedCiphertextCrc32c !== true || String(j.plaintextCrc32c) !== crcStr(plain)) { plain.fill(0); integrity("asymmetricDecrypt", false); }
  return plain;
}

/** The public half of an asymmetric key version: { pem, algorithm, name }. */
export async function getPublicKey(versionName) {
  const j = await kmsCall("getPublicKey", versionName, "/publicKey", undefined, { method: "GET" });
  const pem = String(j.pem ?? "");
  integrity("getPublicKey", pem.includes("-----BEGIN PUBLIC KEY-----") && String(j.pemCrc32c) === crcStr(Buffer.from(pem, "utf8")));
  return { pem, algorithm: String(j.algorithm ?? ""), name: String(j.name ?? versionName) };
}

/** Which of `permissions` this login holds on a KMS resource (key ring or key). */
export async function testKmsPermissions(resource, permissions) {
  const j = await kmsCall("testIamPermissions", resource, ":testIamPermissions", { permissions });
  return Array.isArray(j.permissions) ? j.permissions.map(String) : [];
}
/** Which of `permissions` this login holds on the whole project (Cloud Resource Manager; cloud-platform scope). */
export async function testProjectPermissions(project, permissions) {
  const j = await kmsCall("testIamPermissions", `projects/${project}`, ":testIamPermissions", { permissions },
    { scope: PLATFORM_SCOPE, base: crmBase(), api: "v3" });
  return Array.isArray(j.permissions) ? j.permissions.map(String) : [];
}
