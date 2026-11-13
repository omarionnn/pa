// A stand-in Google Cloud KMS on 127.0.0.1, for tests only. Nothing here reaches Google.
//
// It plays both sides Reason talks to:
//   POST /token  the OAuth token endpoint: checks the RS256 JWT signed with the service-account key it
//                wrote into the key file, its issuer, audience, scope and expiry, and hands out a token.
//   /v1/...      Cloud KMS: encrypt and decrypt (enforcing the additional authenticated data, as Google
//                does: a different AAD is 400 INVALID_ARGUMENT), asymmetricDecrypt (RSA-OAEP SHA-256),
//                getPublicKey, testIamPermissions; every call needs a valid bearer token, and each key
//                has its own grants (a missing grant is 403 PERMISSION_DENIED).
//   /v3/projects/<p>:testIamPermissions  Cloud Resource Manager's check (cloud-platform scope).
// CRC32C fields are checked both ways. `fail` queues answers before the real one, e.g. a throttle.
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createVerify, generateKeyPairSync, privateDecrypt, randomBytes, constants } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { crc32c } from "../../src/gcpkms.js";

const KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";
const PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const crc = b => String(crc32c(b));
let intakePair = null;   // one RSA 4096 pair per test process (slow to make)

export async function standInGcp({ dir, project = "reason-keys-test", location = "us-west1", ring = "reason", file = "reason-google-key.json" } = {}) {
  const sa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = randomBytes(20).toString("hex");
  const email = `reason-server@${project}.iam.gserviceaccount.com`;
  const ringName = `projects/${project}/locations/${location}/keyRings/${ring}`;
  const keys = new Map([
    ["reason-vault", { purpose: "ENCRYPT_DECRYPT", master: randomBytes(32), grants: new Set(["encrypt", "decrypt"]) }],
    ["reason-rest", { purpose: "ENCRYPT_DECRYPT", master: randomBytes(32), grants: new Set(["encrypt", "decrypt"]) }],
    ["reason-vault-intake", { purpose: "ASYMMETRIC_DECRYPT", grants: new Set(["asymmetricDecrypt", "getPublicKey"]) }],
  ]);
  const held = {             // what testIamPermissions answers, per resource kind
    ring: new Set(),
    key: new Set(["cloudkms.cryptoKeyVersions.useToEncrypt", "cloudkms.cryptoKeyVersions.useToDecrypt", "cloudkms.cryptoKeyVersions.viewPublicKey"]),
    project: new Set(),
  };
  const calls = [];          // { op, key, ok, why, aad }
  const fail = [];           // queued KMS answers before the real one: [status, code]
  const tokenFail = [];      // the same, for the token endpoint: [status, oauthError]
  const bodies = [];         // every request body, to prove no field value was ever sent
  const issued = [];         // every plaintext wrapped by encrypt (the vault's data keys), for byte scans
  const tokens = new Map();  // token -> { scope, exp }
  const state = { tokenTtl: 3600, tokensIssued: 0, grantCalls: 0 };

  function intake() {
    intakePair ||= generateKeyPairSync("rsa", { modulusLength: 4096 });
    return intakePair;
  }
  const b64 = b => Buffer.from(b).toString("base64");

  function verifyJwt(assertion) {
    const [h, c, s] = String(assertion ?? "").split(".");
    if (!h || !c || !s) return "malformed";
    let header, claims;
    try { header = JSON.parse(Buffer.from(h, "base64url").toString()); claims = JSON.parse(Buffer.from(c, "base64url").toString()); } catch { return "malformed"; }
    if (header.alg !== "RS256" || header.kid !== keyId) return "header";
    if (!createVerify("RSA-SHA256").update(`${h}.${c}`).verify(sa.publicKey, Buffer.from(s, "base64url"))) return "signature";
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== email || claims.aud !== api.tokenUri) return "claims";
    if (!(claims.exp > now && claims.iat <= now + 60 && claims.exp - claims.iat <= 3600)) return "expiry";
    if (![KMS_SCOPE, PLATFORM_SCOPE].includes(claims.scope)) return "scope";
    return claims;
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", ch => chunks.push(ch));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      bodies.push(raw);
      const url = new URL(req.url, "http://x");
      const send = (code, j) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const gerr = (code, status, message = status) => send(code, { error: { code, status, message } });

      if (url.pathname === "/token") {
        state.grantCalls++;
        if (tokenFail.length) { const [code, error] = tokenFail.shift(); return send(code, { error, error_description: "stand-in" }); }
        const form = new URLSearchParams(raw);
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return send(400, { error: "unsupported_grant_type" });
        const claims = verifyJwt(form.get("assertion"));
        if (typeof claims === "string") return send(400, { error: "invalid_grant", error_description: `stand-in: ${claims}` });
        const token = `ya29.standin-${randomBytes(12).toString("hex")}`;
        tokens.set(token, { scope: claims.scope, exp: Date.now() + state.tokenTtl * 1000 });
        state.tokensIssued++;
        return send(200, { access_token: token, expires_in: state.tokenTtl, token_type: "Bearer" });
      }

      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const t = tokens.get(bearer);
      if (!t || t.exp <= Date.now()) { calls.push({ op: "auth", ok: false, why: "UNAUTHENTICATED" }); return gerr(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."); }

      let j = {};
      if (raw) { try { j = JSON.parse(raw); } catch { return gerr(400, "INVALID_ARGUMENT", "bad json"); } }

      const crm = url.pathname.match(/^\/v3\/projects\/([^/:]+):testIamPermissions$/);
      if (crm) {
        if (t.scope !== PLATFORM_SCOPE) return gerr(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.");
        if (crm[1] !== project) return gerr(403, "PERMISSION_DENIED");
        calls.push({ op: "projectTestIamPermissions", ok: true });
        return send(200, { permissions: (j.permissions ?? []).filter(p => held.project.has(p)) });
      }

      const m = url.pathname.match(/^\/v1\/(.+?)(?::(encrypt|decrypt|asymmetricDecrypt|testIamPermissions)|\/(publicKey))$/);
      if (!m) return gerr(404, "NOT_FOUND", "no such method");
      const resource = m[1], op = m[2] ?? (m[3] === "publicKey" ? "getPublicKey" : "");
      if (t.scope !== KMS_SCOPE && t.scope !== PLATFORM_SCOPE) return gerr(403, "PERMISSION_DENIED", "insufficient scopes");

      if (op === "testIamPermissions") {
        calls.push({ op, key: resource.split("/").pop(), ok: true });
        const kind = resource === ringName ? "ring" : resource.startsWith(`${ringName}/cryptoKeys/`) ? "key" : null;
        if (!kind) return gerr(404, "NOT_FOUND");
        return send(200, { permissions: (j.permissions ?? []).filter(p => held[kind].has(p)) });
      }

      const km = resource.match(/^(.+)\/cryptoKeys\/([A-Za-z0-9_-]+)(\/cryptoKeyVersions\/(\d+))?$/);
      const short = km?.[2] ?? "";
      const rec = { op, key: short, ok: false };
      calls.push(rec);
      if (fail.length) { const [code, status] = fail.shift(); rec.why = status; return gerr(code, status); }
      const key = km && km[1] === ringName ? keys.get(short) : null;
      if (!key) { rec.why = "NOT_FOUND"; return gerr(404, "NOT_FOUND", "key not found"); }
      if (!key.grants.has(op)) { rec.why = "PERMISSION_DENIED"; return gerr(403, "PERMISSION_DENIED", `Permission denied on resource (or it may not exist).`); }
      const keyPath = `${ringName}/cryptoKeys/${short}`;

      if (op === "encrypt" || op === "decrypt") {
        if (km[3]) { rec.why = "INVALID_ARGUMENT"; return gerr(400, "INVALID_ARGUMENT", "use the cryptoKey, not a version"); }
        if (key.purpose !== "ENCRYPT_DECRYPT") { rec.why = "FAILED_PRECONDITION"; return gerr(400, "FAILED_PRECONDITION", "wrong key purpose"); }
        const aad = Buffer.from(String(j.additionalAuthenticatedData ?? ""), "base64");
        rec.aad = aad.toString("utf8");
        if (j.additionalAuthenticatedDataCrc32c !== undefined && String(j.additionalAuthenticatedDataCrc32c) !== crc(aad)) { rec.why = "CRC"; return gerr(400, "INVALID_ARGUMENT", "aad crc"); }
        if (op === "encrypt") {
          const plain = Buffer.from(String(j.plaintext ?? ""), "base64");
          if (String(j.plaintextCrc32c) !== crc(plain)) { rec.why = "CRC"; return gerr(400, "INVALID_ARGUMENT", "plaintext crc"); }
          issued.push(Buffer.from(plain));
          const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key.master, iv);
          c.setAAD(Buffer.concat([Buffer.from(`${keyPath}|`), aad]));
          const ct = Buffer.concat([iv, Buffer.alloc(16), c.update(plain), c.final()]);
          c.getAuthTag().copy(ct, 12);
          rec.ok = true;
          return send(200, { name: `${keyPath}/cryptoKeyVersions/1`, ciphertext: b64(ct), ciphertextCrc32c: crc(ct),
            verifiedPlaintextCrc32c: true, verifiedAdditionalAuthenticatedDataCrc32c: true, protectionLevel: "SOFTWARE" });
        }
        const ct = Buffer.from(String(j.ciphertext ?? ""), "base64");
        if (String(j.ciphertextCrc32c) !== crc(ct)) { rec.why = "CRC"; return gerr(400, "INVALID_ARGUMENT", "ciphertext crc"); }
        try {
          const d = createDecipheriv("aes-256-gcm", key.master, ct.subarray(0, 12));
          d.setAAD(Buffer.concat([Buffer.from(`${keyPath}|`), aad]));
          d.setAuthTag(ct.subarray(12, 28));
          const plain = Buffer.concat([d.update(ct.subarray(28)), d.final()]);
          rec.ok = true; rec.gavePlaintext = true;
          return send(200, { plaintext: b64(plain), plaintextCrc32c: crc(plain), usedPrimary: true, protectionLevel: "SOFTWARE" });
        } catch {
          rec.why = "AAD";
          return gerr(400, "INVALID_ARGUMENT", "Decryption failed: verify that 'name' refers to the correct CryptoKey.");
        }
      }
      if (op === "asymmetricDecrypt" || op === "getPublicKey") {
        if (!km[3] || km[4] !== "1") { rec.why = "INVALID_ARGUMENT"; return gerr(400, "INVALID_ARGUMENT", "a key version is required"); }
        if (key.purpose !== "ASYMMETRIC_DECRYPT") { rec.why = "FAILED_PRECONDITION"; return gerr(400, "FAILED_PRECONDITION", "wrong key purpose"); }
        const pair = intake();
        if (op === "getPublicKey") {
          const pem = pair.publicKey.export({ type: "spki", format: "pem" });
          rec.ok = true;
          return send(200, { pem, algorithm: "RSA_DECRYPT_OAEP_4096_SHA256", pemCrc32c: crc(Buffer.from(pem)), name: resource, protectionLevel: "SOFTWARE" });
        }
        const ct = Buffer.from(String(j.ciphertext ?? ""), "base64");
        if (String(j.ciphertextCrc32c) !== crc(ct)) { rec.why = "CRC"; return gerr(400, "INVALID_ARGUMENT", "ciphertext crc"); }
        try {
          const plain = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, ct);
          rec.ok = true;
          return send(200, { plaintext: b64(plain), plaintextCrc32c: crc(plain), verifiedCiphertextCrc32c: true, protectionLevel: "SOFTWARE" });
        } catch { rec.why = "DECRYPT"; return gerr(400, "INVALID_ARGUMENT", "Decryption failed"); }
      }
      return gerr(404, "NOT_FOUND");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = {
    endpoint: base, tokenUri: `${base}/token`, project, email, keyId, ringName, keys, held, calls, fail, tokenFail, bodies, state, issued, tokens,
    keyFile: null,
    keyName: short => `${ringName}/cryptoKeys/${short}`,
    count: (op, ok) => calls.filter(c => c.op === op && (ok === undefined || c.ok === ok)).length,
    publicKeyPem: () => intake().publicKey.export({ type: "spki", format: "pem" }),
    close: () => new Promise(r => server.close(r)),
  };
  if (dir) {
    api.keyFile = join(dir, file);
    writeFileSync(api.keyFile, JSON.stringify({
      type: "service_account", project_id: project, private_key_id: keyId,
      private_key: sa.privateKey.export({ type: "pkcs8", format: "pem" }), client_email: email, client_id: "100000000000000000001",
      auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: api.tokenUri,
    }, null, 2), { mode: 0o600 });
    chmodSync(api.keyFile, 0o600);
  }
  return api;
}

/** Point this process at a stand-in (the env Reason reads). */
export function useStandIn(g) {
  process.env.REASON_GCP_KEY_FILE = g.keyFile;
  process.env.REASON_GCP_KMS_ENDPOINT = g.endpoint;
  process.env.REASON_GCP_CRM_ENDPOINT = g.endpoint;
  delete process.env.REASON_GCP_PROJECT;
  delete process.env.REASON_GCP_VAULT_KEY;
  delete process.env.REASON_GCP_INTAKE_KEY;
  delete process.env.REASON_GCP_REST_KEY;
  delete process.env.REASON_GCP_KMS_LOCATION;
  delete process.env.REASON_GCP_KMS_RING;
  delete process.env.REASON_GCP_INTAKE_VERSION;
}
