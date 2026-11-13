// src/gcpkms.js, the Google Cloud KMS client, against the stand-in in test/helpers/gcpkms-standin.js.
// Nothing here reaches Google; the key file is made up by the stand-in for this run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publicEncrypt, constants, randomBytes } from "node:crypto";
import { inspect, format } from "node:util";

// Retries wait 0.5 s to 4 s: cut to 1 ms in this file.
const realSetTimeout = globalThis.setTimeout;
const BACKOFF = new Set([500, 1000, 2000, 4000]);
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, BACKOFF.has(ms) ? 1 : ms, ...a);

const dir = mkdtempSync(join(tmpdir(), "gcpkms-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
const g = await standInGcp({ dir });
after(() => g.close());
useStandIn(g);
const kms = await import("../src/gcpkms.js");
const KEY_TEXT = readFileSync(g.keyFile, "utf8");
const PEM_LINES = JSON.parse(KEY_TEXT).private_key.split("\n").filter(l => l.length > 40);
const leaksKey = s => PEM_LINES.some(l => String(s).includes(l) || String(s).includes(l.slice(0, 24)));
const AAD = Buffer.from('{"app":"reason","purpose":"test"}');

test("crc32c matches the Castagnoli check value", () => {
  assert.equal(kms.crc32c(Buffer.from("123456789")), 0xE3069283);
  assert.equal(kms.crc32c(Buffer.alloc(0)), 0);
});

test("the key file: booleans only; a world-readable, wrong-shaped or off-Google file is refused", () => {
  assert.ok(Object.values(kms.checkKeyFile()).every(v => v === true), JSON.stringify(kms.checkKeyFile()));
  assert.equal(kms.configured("vault"), true);
  const j = JSON.parse(KEY_TEXT);
  const variant = (name, over, mode = 0o600) => {
    const f = join(dir, name);
    writeFileSync(f, typeof over === "string" ? over : JSON.stringify({ ...j, ...over }), { mode });
    chmodSync(f, mode);
    return f;
  };
  const cases = [
    ["world-readable", variant("open.json", {}, 0o644), "privateToOwner"],
    ["not json", variant("bad.json", KEY_TEXT.slice(0, 400)), "json"],
    ["not a service account", variant("user.json", { type: "authorized_user" }), "serviceAccount"],
    ["token_uri elsewhere", variant("elsewhere.json", { token_uri: "https://example.test/token" }), "tokenUri"],
    ["no private key", variant("nokey.json", { private_key: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n" }), "privateKey"],
    ["email of another project", variant("email.json", { client_email: "reason-server@other-project.iam.gserviceaccount.com" }), "clientEmail"],
    ["missing", join(dir, "nothing.json"), "readable"],
  ];
  for (const [why, f, field] of cases) {
    const r = kms.checkKeyFile(f);
    assert.ok(Object.values(r).every(v => typeof v === "boolean"), why);
    assert.equal(r[field], false, why);
    process.env.REASON_GCP_KEY_FILE = f;
    assert.equal(kms.configured("vault"), false, why);
  }
  // A truncated file: the JSON parser's message (which can quote the file) is never passed on.
  process.env.REASON_GCP_KEY_FILE = join(dir, "bad.json");
  assert.throws(() => kms.keyName("vault"), e => !leaksKey(e.message) && !leaksKey(e.stack) && /json/.test(e.message));
  process.env.REASON_GCP_KEY_FILE = g.keyFile;
  assert.equal(kms.configured("vault"), true);
});

test("key names come from the file's project_id and the fixed names; env overrides each part", () => {
  const ring = `projects/${g.project}/locations/us-west1/keyRings/reason`;
  assert.equal(kms.keyName("vault"), `${ring}/cryptoKeys/reason-vault`);
  assert.equal(kms.keyName("rest"), `${ring}/cryptoKeys/reason-rest`);
  assert.equal(kms.intakeVersionName(), `${ring}/cryptoKeys/reason-vault-intake/cryptoKeyVersions/1`);
  process.env.REASON_GCP_PROJECT = "other-proj-1";
  process.env.REASON_GCP_KMS_LOCATION = "us-east1";
  process.env.REASON_GCP_KMS_RING = "ring2";
  process.env.REASON_GCP_VAULT_KEY = "vault2";
  assert.equal(kms.keyName("vault"), "projects/other-proj-1/locations/us-east1/keyRings/ring2/cryptoKeys/vault2");
  process.env.REASON_GCP_VAULT_KEY = "projects/p-full-1/locations/l1/keyRings/r1/cryptoKeys/k1";
  assert.equal(kms.keyName("vault"), "projects/p-full-1/locations/l1/keyRings/r1/cryptoKeys/k1");
  process.env.REASON_GCP_VAULT_KEY = "../../evil";
  assert.throws(() => kms.keyName("vault"));
  assert.equal(kms.configured("vault"), false);
  process.env.REASON_GCP_INTAKE_VERSION = "1/../2";
  assert.throws(() => kms.intakeVersionName());
  useStandIn(g);
  assert.throws(() => kms.keyName("other"));
});

test("a 127.x stand-in (endpoint or token_uri) is refused outside a test run; any other endpoint always", () => {
  const ctx = process.env.NODE_TEST_CONTEXT;
  assert.ok(ctx);
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(kms.configured("vault"), false);
    assert.equal(kms.checkKeyFile().tokenUri, false);
  } finally { process.env.NODE_TEST_CONTEXT = ctx; }
  process.env.REASON_GCP_KMS_ENDPOINT = "https://kms.example.test";
  assert.equal(kms.configured("vault"), false);
  useStandIn(g);
  assert.equal(kms.configured("vault"), true);
});

test("the login: a signed JWT for the cloudkms scope; the token is cached, renewed near expiry, and a 401 gets one fresh token", async () => {
  kms.forgetTokens();
  const t0 = g.state.tokensIssued;
  const ct = await kms.encrypt(kms.keyName("vault"), Buffer.from("hello"), AAD);
  await kms.decrypt(kms.keyName("vault"), ct.ciphertext, AAD);
  assert.equal(g.state.tokensIssued - t0, 1, "one token for two calls");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3400_000;   // inside the last 5 minutes of the hour
    await kms.decrypt(kms.keyName("vault"), ct.ciphertext, AAD);
    assert.equal(g.state.tokensIssued - t0, 2, "renewed before it expired");
  } finally { Date.now = realNow; }

  kms.forgetTokens();
  await Promise.all([1, 2, 3].map(() => kms.decrypt(kms.keyName("vault"), ct.ciphertext, AAD)));
  assert.equal(g.state.tokensIssued - t0, 3, "parallel calls share one token request");

  g.tokens.clear();                           // Google no longer takes the cached token
  const before = g.calls.length;
  assert.equal((await kms.decrypt(kms.keyName("vault"), ct.ciphertext, AAD)).toString(), "hello");
  assert.deepEqual(g.calls.slice(before).map(c => [c.op, c.ok]), [["auth", false], ["decrypt", true]]);
  assert.equal(g.state.tokensIssued - t0, 4);
});

test("encrypt and decrypt with AAD: a different AAD is refused, asked once, never retried", async () => {
  const name = kms.keyName("vault");
  const ct = await kms.encrypt(name, Buffer.from("a data key"), AAD);
  assert.equal(ct.name, `${name}/cryptoKeyVersions/1`);
  assert.equal((await kms.decrypt(name, ct.ciphertext, AAD)).toString(), "a data key");
  const before = g.calls.length;
  await assert.rejects(kms.decrypt(name, ct.ciphertext, Buffer.from('{"app":"reason","purpose":"other"}')),
    e => e.gcpStatus === 400 && e.gcpCode === "INVALID_ARGUMENT");
  assert.equal(g.calls.length - before, 1);
  await assert.rejects(kms.decrypt(kms.keyName("rest"), ct.ciphertext, AAD), { gcpCode: "INVALID_ARGUMENT" }, "another key does not open it");
  await assert.rejects(kms.encrypt(name, Buffer.from("x"), Buffer.alloc(0)), { gcpCode: "INVALID_ARGUMENT" }, "AAD is required");
  await assert.rejects(kms.decrypt(name, ct.ciphertext, ""), { gcpCode: "INVALID_ARGUMENT" });
});

test("retries: throttling, Google-side and network failures only; permission, invalid argument and failed precondition are asked once", async () => {
  const name = kms.keyName("vault");
  const ct = await kms.encrypt(name, Buffer.from("k"), AAD);
  let before = g.calls.length;
  g.fail.push([429, "RESOURCE_EXHAUSTED"], [503, "UNAVAILABLE"], [500, "INTERNAL"]);
  assert.equal((await kms.decrypt(name, ct.ciphertext, AAD)).toString(), "k");
  assert.deepEqual(g.calls.slice(before).map(c => c.why ?? "ok"), ["RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "ok"]);

  for (const [code, status] of [[403, "PERMISSION_DENIED"], [400, "INVALID_ARGUMENT"], [400, "FAILED_PRECONDITION"], [404, "NOT_FOUND"]]) {
    before = g.calls.length;
    g.fail.push([code, status]);
    await assert.rejects(kms.decrypt(name, ct.ciphertext, AAD), { gcpCode: status });
    assert.equal(g.calls.length - before, 1, status);
  }
  before = g.calls.length;
  g.fail.push(...Array(5).fill([503, "UNAVAILABLE"]));
  await assert.rejects(kms.decrypt(name, ct.ciphertext, AAD), { gcpCode: "UNAVAILABLE" });
  assert.equal(g.calls.length - before, 5, "5 tries in all");

  // Real refusals from the stand-in, not queued ones.
  g.keys.get("reason-vault").grants.delete("decrypt");
  before = g.calls.length;
  await assert.rejects(kms.decrypt(name, ct.ciphertext, AAD), { gcpCode: "PERMISSION_DENIED", gcpStatus: 403 });
  assert.equal(g.calls.length - before, 1);
  g.keys.get("reason-vault").grants.add("decrypt");
  before = g.calls.length;
  await assert.rejects(kms.encrypt(kms.keyName("intake"), Buffer.from("k"), AAD), { gcpCode: "PERMISSION_DENIED" });
  g.keys.get("reason-vault-intake").grants.add("encrypt");
  await assert.rejects(kms.encrypt(kms.keyName("intake"), Buffer.from("k"), AAD), { gcpCode: "FAILED_PRECONDITION" });
  g.keys.get("reason-vault-intake").grants.delete("encrypt");
  assert.equal(g.calls.length - before, 2);

  const e = (gcpStatus, gcpCode) => Object.assign(new Error("x"), { gcpStatus, gcpCode });
  for (const [s, c] of [[429, "RESOURCE_EXHAUSTED"], [503, "UNAVAILABLE"], [500, "INTERNAL"], [504, "DEADLINE_EXCEEDED"], [409, "ABORTED"], [502, ""], [429, ""]]) {
    assert.equal(kms.gcpRetry(e(s, c)), true, `${s} ${c}`);
  }
  for (const [s, c] of [[403, "PERMISSION_DENIED"], [400, "INVALID_ARGUMENT"], [400, "FAILED_PRECONDITION"], [404, "NOT_FOUND"],
    [401, "UNAUTHENTICATED"], [400, "invalid_grant"], [400, "SOMETHING_ELSE"], [0, "INTEGRITY"], [0, "BAD_KEY_FILE"]]) {
    assert.equal(kms.gcpRetry(e(s, c)), false, `${s} ${c}`);
  }
  assert.equal(kms.gcpRetry(new TypeError("fetch failed")), true, "network error");
  assert.equal(kms.gcpRetry(Object.assign(new Error("t"), { name: "TimeoutError" })), true, "timeout");
});

test("the token endpoint: a throttle is retried, a refused grant is not", async () => {
  kms.forgetTokens();
  let before = g.state.grantCalls;
  g.tokenFail.push([429, "rate_limit_exceeded"], [503, "temporarily_unavailable"]);
  await kms.accessToken();
  assert.equal(g.state.grantCalls - before, 3);
  kms.forgetTokens();
  before = g.state.grantCalls;
  g.tokenFail.push([400, "invalid_grant"]);
  await assert.rejects(kms.accessToken(), { gcpCode: "invalid_grant" });
  assert.equal(g.state.grantCalls - before, 1);
});

test("asymmetricDecrypt and getPublicKey on the intake key (RSA-OAEP 4096, SHA-256)", async () => {
  const pub = await kms.getPublicKey(kms.intakeVersionName());
  assert.equal(pub.algorithm, "RSA_DECRYPT_OAEP_4096_SHA256");
  assert.match(pub.pem, /BEGIN PUBLIC KEY/);
  const msg = randomBytes(32);
  const ct = publicEncrypt({ key: pub.pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, msg);
  assert.deepEqual(await kms.asymmetricDecrypt(kms.intakeVersionName(), ct), msg);
  assert.deepEqual(await kms.asymmetricDecrypt(kms.intakeVersionName(), ct.toString("base64")), msg);
  const bad = Buffer.from(ct); bad[10] ^= 1;
  await assert.rejects(kms.asymmetricDecrypt(kms.intakeVersionName(), bad), { gcpCode: "INVALID_ARGUMENT" });
  await assert.rejects(kms.getPublicKey(`${kms.keyName("vault")}/cryptoKeyVersions/1`), { gcpCode: "PERMISSION_DENIED" });
});

test("testIamPermissions: on the key ring and keys (cloudkms scope) and on the project (cloud-platform scope)", async () => {
  assert.deepEqual(await kms.testKmsPermissions(g.ringName, ["cloudkms.cryptoKeys.create"]), []);
  assert.deepEqual(await kms.testKmsPermissions(kms.keyName("vault"), ["cloudkms.cryptoKeyVersions.useToDecrypt", "cloudkms.cryptoKeys.setIamPolicy"]),
    ["cloudkms.cryptoKeyVersions.useToDecrypt"]);
  assert.deepEqual(await kms.testProjectPermissions(g.project, ["resourcemanager.projects.setIamPolicy"]), []);
  g.held.project.add("resourcemanager.projects.setIamPolicy");
  assert.deepEqual(await kms.testProjectPermissions(g.project, ["resourcemanager.projects.setIamPolicy"]), ["resourcemanager.projects.setIamPolicy"]);
  g.held.project.clear();
});

test("the private key never appears in a log, an error or a request after the login", async () => {
  const out = [];
  const saved = Object.fromEntries(["log", "info", "warn", "error", "debug"].map(k => [k, console[k]]));
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(format(...a));
  const errors = [];
  const vault = kms.keyName("vault");
  try {
    kms.forgetTokens();
    g.tokenFail.push([400, "invalid_grant"]);
    errors.push(await kms.accessToken().catch(e => e));
    errors.push(await kms.decrypt(vault, "AAAA", AAD).catch(e => e));
    process.env.REASON_GCP_KEY_FILE = join(dir, "bad.json");
    errors.push(await kms.decrypt(vault, "AAAA", AAD).catch(e => e));
    process.env.REASON_GCP_KEY_FILE = join(dir, "open.json");
    errors.push(await kms.accessToken().catch(e => e));
  } finally { Object.assign(console, saved); useStandIn(g); }
  assert.ok(errors.every(e => e instanceof Error));
  const shown = [...errors.flatMap(e => [e.message, e.stack, inspect(e)]), ...out].join("\n");
  assert.equal(leaksKey(shown), false);
  assert.equal(leaksKey(g.bodies.join("\n")), false, "only the signed JWT goes to the token endpoint");
  assert.equal(out.length, 0, "the client logs nothing");
});

test("only the vault's key source, restcrypt and the check script import gcpkms.js", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const bad = [];
  for (const d of ["src", "scripts", "deploy", "bin", "web"]) {
    if (!existsSync(join(root, d))) continue;
    const walk = rel => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
        if (!/\.(m?js|cjs)$/.test(e.name)) continue;
        if (["src/gcpkms.js", "src/vaultkms.js", "src/restcrypt.js", "scripts/gcp-kms-check.mjs"].includes(p)) continue;
        if (/["'`][^"'`]*gcpkms(\.js)?["'`]/.test(readFileSync(join(root, p), "utf8"))) bad.push(p);
      }
    };
    walk(d);
  }
  assert.deepEqual(bad, []);
});
