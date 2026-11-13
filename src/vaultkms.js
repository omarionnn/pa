// The saved-login key source (vault, design B3). One AWS KMS key, REASON_VAULT_KMS_KEY ("reason-vault",
// symmetric; the key itself never leaves KMS), reached only through restcrypt's signed kmsCall.
// There is no other implementation: no file key, no .env key, no fallback. Tests point
// REASON_REST_KMS_HOST at a stand-in on 127.x, which is refused outside a test run.
//
// Every call carries an encryption context; KMS refuses a Decrypt whose context differs from the one
// the key was made with, so the context is the binding (who, which login, which exact origin).
// Only src/savedlogins.js may import this file (test/savedlogins.test.js checks).
import { kmsCall } from "./restcrypt.js";
import { Secret } from "./secret.js";

export function vaultKeyId() { return String(process.env.REASON_VAULT_KMS_KEY ?? "").trim(); }

/** Key named, AWS login present, and no 127.x stand-in outside a test run. */
export function configured() {
  if (!vaultKeyId()) return false;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return false;
  const host = String(process.env.REASON_REST_KMS_HOST ?? "");
  if (host.startsWith("127.") && !process.env.NODE_TEST_CONTEXT) return false;
  return true;
}

function need() {
  if (!configured()) throw new Error("vault KMS is not configured.");
  return vaultKeyId();
}

// Which failures the vault tries again. A refusal (wrong context, wrong key, key off, bad request) is
// final: retrying it only repeats the refusal in CloudTrail and makes the person wait. Decided on the
// exception name first, because AWS sends ThrottlingException as HTTP 400.
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

// AWS wants a string -> string map. An empty or non-string value would weaken the binding: refuse it.
function contextOf(context) {
  const entries = Object.entries(context ?? {});
  if (!entries.length) throw new Error("vault KMS: an encryption context is required.");
  for (const [k, v] of entries) if (typeof v !== "string" || !v) throw new Error(`vault KMS: context "${k}" must be a non-empty string.`);
  return Object.fromEntries(entries);
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
  const KeyId = need();
  const j = await kmsCall("GenerateDataKey", { KeyId, KeySpec: "AES_256", EncryptionContext: contextOf(context) }, { retry: vaultRetry });
  const plain = keyBytes(j, "GenerateDataKey");
  if (typeof j.CiphertextBlob !== "string" || !j.CiphertextBlob) { plain.fill(0); throw new Error("vault KMS: GenerateDataKey returned no wrapped key."); }
  return { plaintext: new Secret(plain), wrapped: j.CiphertextBlob, keyId: String(j.KeyId || KeyId) };
}

/** Unwrap a stored data key. KMS checks the context; the key used is the configured one, never the row's. */
export async function unwrap(wrapped, context) {
  const KeyId = need();
  const j = await kmsCall("Decrypt", { CiphertextBlob: String(wrapped ?? ""), EncryptionContext: contextOf(context), KeyId }, { retry: vaultRetry });
  return new Secret(keyBytes(j, "Decrypt"));
}
