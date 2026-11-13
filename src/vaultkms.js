// The saved-login key source (vault, design B3). Two providers, chosen by REASON_VAULT_KMS:
//   gcp  Google Cloud KMS key "reason-vault" (symmetric; the key never leaves Google), through
//        src/gcpkms.js with the service-account file REASON_GCP_KEY_FILE. The default when that is set.
//   aws  AWS KMS key REASON_VAULT_KMS_KEY, through restcrypt's signed kmsCall. The default otherwise.
// Any other value is no provider. There is no other implementation: no file key, no .env key, no
// fallback from one provider to the other. Tests point the endpoints at stand-ins on 127.x, which are
// refused outside a test run.
//
// The binding is the same on both: the context { app, purpose, person, item, origin }. AWS checks it as
// the encryption context; Google checks it as additional authenticated data (its canonical JSON, keys
// sorted). Either refuses an unwrap whose context differs from the one the key was wrapped with, so a
// moved row or a tab on another origin fails at the key service, not only here.
// Only src/savedlogins.js may import this file (test/savedlogins.test.js checks).
import { randomBytes, createPublicKey } from "node:crypto";
import { kmsCall } from "./restcrypt.js";
import * as gcpkms from "./gcpkms.js";
import { Secret } from "./secret.js";

/** "gcp" | "aws" | anything else (no provider). */
export function provider() {
  const v = String(process.env.REASON_VAULT_KMS ?? "").trim().toLowerCase();
  if (v) return v;
  return gcpkms.keyFilePath() ? "gcp" : "aws";
}

export function vaultKeyId() {
  if (provider() === "gcp") { try { return gcpkms.keyName("vault"); } catch { return ""; } }
  return String(process.env.REASON_VAULT_KMS_KEY ?? "").trim();
}

function awsConfigured() {
  if (!String(process.env.REASON_VAULT_KMS_KEY ?? "").trim()) return false;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return false;
  const host = String(process.env.REASON_REST_KMS_HOST ?? "");
  if (host.startsWith("127.") && !process.env.NODE_TEST_CONTEXT) return false;
  return true;
}

/**
 * The chosen provider can be asked. gcp: the key file present, private to its owner and valid, and no
 * 127.x stand-in outside a test. aws: key named, AWS login present, no 127.x stand-in outside a test.
 */
export function configured() {
  const p = provider();
  if (p === "gcp") return gcpkms.configured("vault");
  if (p === "aws") return awsConfigured();
  return false;
}

function need() {
  if (!configured()) throw new Error("vault KMS is not configured.");
  return { p: provider(), KeyId: vaultKeyId() };
}

// Which AWS failures the vault tries again. A refusal (wrong context, wrong key, key off, bad request) is
// final: retrying it only repeats the refusal in CloudTrail and makes the person wait. Decided on the
// exception name first, because AWS sends ThrottlingException as HTTP 400. (Google: gcpkms.gcpRetry.)
const NO_RETRY = new Set(["InvalidCiphertextException", "AccessDeniedException", "IncorrectKeyException", "NotFoundException",
  "DisabledException", "KMSInvalidStateException", "ValidationException"]);
const RETRY = new Set(["ThrottlingException", "KMSInternalException", "DependencyTimeoutException"]);
/** The vault's retry decision for kmsCall. Exported for its test. */
export function vaultRetry(err) {
  const type = String(err?.kmsType ?? ""), status = Number(err?.kmsStatus ?? 0);
  if (!status) return true;                     // network error or timeout: no answer from KMS
  if (NO_RETRY.has(type)) return false;
  if (RETRY.has(type)) return true;
  return status >= 500 || status === 429;       // any other 4xx is a refusal
}

// A string -> string map. An empty or non-string value would weaken the binding: refuse it.
function contextOf(context) {
  const entries = Object.entries(context ?? {});
  if (!entries.length) throw new Error("vault KMS: an encryption context is required.");
  for (const [k, v] of entries) if (typeof v !== "string" || !v) throw new Error(`vault KMS: context "${k}" must be a non-empty string.`);
  return Object.fromEntries(entries);
}
/** Google's AAD for a context: its canonical JSON (keys sorted). Exported for its test. */
export function aadOf(context) {
  const c = contextOf(context);
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(c).sort().map(k => [k, c[k]]))), "utf8");
}

// The 32 key bytes arrive as base64 inside the JSON answer: that string cannot be wiped (the AWS SDK
// has the same limit). The Buffer made from it is the only copy this code keeps, inside a Secret.
function keyBytes(j, op) {
  const b = Buffer.from(String(j?.Plaintext ?? ""), "base64");
  if (j) j.Plaintext = undefined;
  if (b.length !== 32) { b.fill(0); throw new Error(`vault KMS: ${op} did not return a 32-byte key.`); }
  return b;
}

/** A fresh AES-256 data key: { plaintext: Secret, wrapped (base64, store this), keyId (the KMS key used) }. */
export async function generateDataKey(context) {
  const { p, KeyId } = need();
  if (p === "gcp") {
    // Google has no GenerateDataKey: the 32 bytes are made here and wrapped by Google, bound by the AAD.
    // The base64 copy inside the request body is a string and cannot be wiped (as with AWS's answer).
    const aad = aadOf(context);
    const plain = randomBytes(32);
    let r;
    try { r = await gcpkms.encrypt(KeyId, plain, aad); }
    catch (e) { plain.fill(0); throw e; }
    if (typeof r.ciphertext !== "string" || !r.ciphertext) { plain.fill(0); throw new Error("vault KMS: encrypt returned no wrapped key."); }
    return { plaintext: new Secret(plain), wrapped: r.ciphertext, keyId: r.name || KeyId };
  }
  const j = await kmsCall("GenerateDataKey", { KeyId, KeySpec: "AES_256", EncryptionContext: contextOf(context) }, { retry: vaultRetry });
  const plain = keyBytes(j, "GenerateDataKey");
  if (typeof j.CiphertextBlob !== "string" || !j.CiphertextBlob) { plain.fill(0); throw new Error("vault KMS: GenerateDataKey returned no wrapped key."); }
  return { plaintext: new Secret(plain), wrapped: j.CiphertextBlob, keyId: String(j.KeyId || KeyId) };
}

/** Unwrap a stored data key. The key service checks the context; the key used is the configured one, never the row's. */
export async function unwrap(wrapped, context) {
  const { p, KeyId } = need();
  if (p === "gcp") {
    const b = await gcpkms.decrypt(KeyId, String(wrapped ?? ""), aadOf(context));
    if (b.length !== 32) { b.fill(0); throw new Error("vault KMS: decrypt did not return a 32-byte key."); }
    return new Secret(b);
  }
  const j = await kmsCall("Decrypt", { CiphertextBlob: String(wrapped ?? ""), EncryptionContext: contextOf(context), KeyId }, { retry: vaultRetry });
  return new Secret(keyBytes(j, "Decrypt"));
}

// ---------------------------------------------------------------- the intake key (vault PR 5)
// The save page seals a login inside the person's browser to the intake key's public half (RSA-OAEP
// 4096, SHA-256, wrapping a fresh AES-256-GCM key). The private half never leaves the key service.
// Google only: reason-vault-intake, ASYMMETRIC_DECRYPT, RSA_DECRYPT_OAEP_4096_SHA256, used by version
// (gcpkms.intakeVersionName). Under the AWS provider there is no intake key here, so no save page.

/** The intake key can be asked: the Google provider, its key file valid. Never throws. */
export function intakeConfigured() {
  if (provider() !== "gcp") return false;
  try { gcpkms.intakeVersionName(); } catch { return false; }
  return gcpkms.configured("intake");
}

let intakeCache = null; // { name, spki } — the public half only, by version
/** The intake key's public half as DER (SPKI) bytes, and the version it is: { spki: Buffer, name }. Cached per version. */
export async function intakePublicKey() {
  if (!intakeConfigured()) throw new Error("vault KMS: the intake key is not configured.");
  const name = gcpkms.intakeVersionName();
  if (intakeCache?.name === name) return { spki: Buffer.from(intakeCache.spki), name };
  const r = await gcpkms.getPublicKey(name);
  if (r.algorithm && r.algorithm !== "RSA_DECRYPT_OAEP_4096_SHA256") throw new Error("vault KMS: the intake key is not RSA-OAEP 4096 SHA-256.");
  const der = createPublicKey(r.pem).export({ type: "spki", format: "der" });
  intakeCache = { name, spki: Buffer.from(der) };
  return { spki: Buffer.from(der), name };
}
/** For tests: forget the cached public half. */
export function _forgetIntakeKey() { intakeCache = null; }

/**
 * Open a key the browser wrapped to the intake key (RSA-OAEP SHA-256): the 32 AES bytes, in a Secret.
 * The only call that can, and only src/savedlogins.js makes it, inside its intake step.
 */
export async function openIntake(wrapped) {
  if (!intakeConfigured()) throw new Error("vault KMS: the intake key is not configured.");
  const b = await gcpkms.asymmetricDecrypt(gcpkms.intakeVersionName(), Buffer.from(wrapped));
  if (b.length !== 32) { b.fill(0); throw new Error("vault KMS: the intake key did not open a 32-byte key."); }
  return new Secret(b);
}
