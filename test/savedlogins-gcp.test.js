// The vault (src/savedlogins.js) on Google Cloud KMS (src/vaultkms.js provider "gcp", src/gcpkms.js).
// The stand-in Google KMS on 127.0.0.1 (test/helpers/gcpkms-standin.js) checks the service-account JWT
// and, like Google, refuses a decrypt whose additional authenticated data differs from the one the key
// was wrapped with. test/savedlogins.test.js runs the same rules on the AWS provider. Nothing here
// reaches Google; the key file and every value below are made up for this run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { format } from "node:util";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "savedlogins-gcp-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "45".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;                 // Google is the default once the key file is set
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "off";
after(() => rmSync(dir, { recursive: true, force: true }));

// Retries wait 0.5 s to 4 s: cut to 1 ms in this file.
const realSetTimeout = globalThis.setTimeout;
const BACKOFF = new Set([500, 1000, 2000, 4000]);
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, BACKOFF.has(ms) ? 1 : ms, ...a);

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
const { Secret } = await import("../src/secret.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
after(() => g.close());
useStandIn(g);

const sl = await import("../src/savedlogins.js");
const { saveLogin, listLogins, removeLogin, withLogin, savedLoginsAllowedFor, vaultReady, loginsDbPath } = sl;

const ME = "dm:owner";
const OTHER = "dm:vault-other";
const ORIGIN = "https://login.example.test";
const PLAIN = { username: "vault-tester@example.test", password: "Stand-in-pass-7Qx!", totp: "STANDINTOTPKEYJBSWY3DPEHPK3PXP" };
const S = s => new Secret(Buffer.from(s, "utf8"));
const fields = (p = PLAIN) => ({ username: S(p.username), password: S(p.password), totp: p.totp ? S(p.totp) : null });
const meta = (over = {}) => ({ site: "example.test", label: "Example", signinOrigin: ORIGIN, signinPath: "/signin", permission: "standing",
  consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1", ...over });
const fileBytes = () => {
  const p = loginsDbPath();
  return Buffer.concat([p, `${p}-journal`, `${p}-wal`].filter(f => existsSync(f)).map(f => readFileSync(f)));
};
const leaks = (buf, values) => values.filter(v => buf.includes(Buffer.from(v)) || buf.includes(Buffer.from(Buffer.from(v).toString("base64"))));
function editRow(sql, ...args) {
  const d = new DatabaseSync(loginsDbPath());
  d.exec("PRAGMA secure_delete = ON");
  try { return d.prepare(sql).run(...args); } finally { d.close(); }
}
const rowOf = id => { const d = new DatabaseSync(loginsDbPath()); try { return d.prepare("SELECT * FROM saved_logins WHERE id = ?").get(id); } finally { d.close(); } };
async function captured(fn) {
  const out = [];
  const saved = Object.fromEntries(["log", "info", "warn", "error", "debug"].map(k => [k, console[k]]));
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(format(...a));
  let value, error;
  try { value = await fn(); } catch (e) { error = e; }
  finally { Object.assign(console, saved); }
  return { value, error, text: out.join("\n") };
}
const allValues = () => [PLAIN.username, PLAIN.password, PLAIN.totp];
const kmsOps = () => g.calls.filter(c => ["encrypt", "decrypt"].includes(c.op));
let LOGIN;

// ---------------------------------------------------------------- the provider and the switch
test("switch off: nothing allowed, nothing created, Google not asked", async () => {
  assert.equal(savedLoginsAllowedFor(ME), false);
  await assert.rejects(saveLogin(ME, meta(), fields()), { code: "not_available" });
  assert.equal(existsSync(loginsDbPath()), false);
  assert.equal(g.calls.length, 0);
});

test("no working provider, no vault: no key file, a world-readable file, an unknown provider, a stand-in outside a test, or AWS named with no AWS key", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  const { provider } = await import("../src/vaultkms.js");
  assert.equal(provider(), "gcp", "Google is the default when the key file is set");
  assert.equal(vaultReady(), true);

  const file = process.env.REASON_GCP_KEY_FILE;
  const r = await captured(async () => {
    delete process.env.REASON_GCP_KEY_FILE;
    process.env.REASON_VAULT_KMS = "gcp";
    // An AWS login lying around is not a fallback when Google is chosen.
    process.env.AWS_ACCESS_KEY_ID = "STANDINACCESSKEY0001"; process.env.AWS_SECRET_ACCESS_KEY = "x"; process.env.REASON_VAULT_KMS_KEY = "alias/reason-vault";
    assert.equal(vaultReady(), false, "gcp chosen, no key file");
    await assert.rejects(saveLogin(ME, meta(), fields()), { code: "not_available" });
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "REASON_VAULT_KMS_KEY"]) delete process.env[k];
  });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.text.split("saved logins: off (no KMS key)").length - 1, 1, "exactly one log line");

  process.env.REASON_GCP_KEY_FILE = file;
  process.env.REASON_VAULT_KMS = "aws";
  assert.equal(vaultReady(), false, "aws chosen: Google's file is not a fallback either");
  process.env.REASON_VAULT_KMS = "file";
  assert.equal(vaultReady(), false, "no such provider");
  process.env.REASON_VAULT_KMS = "gcp";
  assert.equal(vaultReady(), true);
  delete process.env.REASON_VAULT_KMS;

  chmodSync(file, 0o644);
  assert.equal(vaultReady(), false, "a key file others can read");
  chmodSync(file, 0o600);
  assert.equal(vaultReady(), true);

  const ctx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  assert.equal(vaultReady(), false, "a 127.x stand-in is refused outside a test run");
  process.env.NODE_TEST_CONTEXT = ctx;
  assert.equal(vaultReady(), true);
  assert.equal(existsSync(loginsDbPath()), false);
  assert.equal(g.calls.length, 0);
});

// ---------------------------------------------------------------- seal and open
test("seal and open: one encrypt, one decrypt, the AAD is the context's canonical JSON, the values only inside fn", async () => {
  const sealed = await captured(() => saveLogin(ME, meta(), fields()));
  assert.equal(sealed.error, undefined, sealed.error?.message);
  LOGIN = sealed.value.id;
  const enc = kmsOps();
  assert.deepEqual(enc.map(c => [c.op, c.key, c.ok]), [["encrypt", "reason-vault", true]]);
  const aad = JSON.parse(enc[0].aad);
  assert.deepEqual(Object.keys(aad), ["app", "item", "origin", "person", "purpose"], "keys sorted");
  assert.equal(aad.app, "reason"); assert.equal(aad.purpose, "saved-login"); assert.equal(aad.item, String(LOGIN)); assert.equal(aad.origin, ORIGIN);
  assert.ok(aad.person.length >= 20 && !aad.person.includes("owner"));
  const row = rowOf(LOGIN);
  assert.equal(row.kms_key, `${g.keyName("reason-vault")}/cryptoKeyVersions/1`);
  assert.equal(g.issued.length, 1);
  assert.equal(g.issued[0].length, 32, "a 32-byte data key, made locally, wrapped by Google");

  let seen;
  const opened = await captured(() => withLogin(ME, LOGIN, ORIGIN, ({ username, password, totp }) => {
    seen = { username: username.use(b => b.toString("utf8")), password: password.use(b => b.toString("utf8")), totp: totp.use(b => b.toString("utf8")) };
    return "filled";
  }));
  assert.equal(opened.error, undefined, opened.error?.message);
  assert.equal(opened.value, "filled");
  assert.deepEqual(seen, PLAIN);
  assert.deepEqual(kmsOps().slice(1).map(c => [c.op, c.ok]), [["decrypt", true]], "exactly one decrypt");
  assert.deepEqual(leaks(Buffer.from(sealed.text + opened.text), allValues()), []);
  assert.deepEqual(leaks(Buffer.from(g.bodies.join("\n")), allValues()), [], "no field value ever went to Google");
});

// ---------------------------------------------------------------- hard rule 1: exact origin only
const MISMATCHES = { scheme: "http://login.example.test", host: "https://login2.example.test", port: "https://login.example.test:8443" };

test("rule 1: a live origin that differs by scheme, host or port is refused before Google is asked", async () => {
  const before = g.calls.length;
  for (const [why, live] of Object.entries(MISMATCHES)) {
    let ran = false;
    await assert.rejects(withLogin(ME, LOGIN, live, () => { ran = true; }), { code: "origin_mismatch" }, why);
    assert.equal(ran, false, why);
  }
  assert.equal(g.calls.length - before, 0);
});

test("rule 1: a row whose origin was edited fails at the stand-in: exactly 1 decrypt each, zero plaintext", async () => {
  for (const [why, edited] of Object.entries(MISMATCHES)) {
    editRow("UPDATE saved_logins SET signin_origin = ? WHERE id = ?", edited, LOGIN);
    const before = g.calls.length;
    let ran = false;
    await assert.rejects(withLogin(ME, LOGIN, edited, () => { ran = true; }), { code: "unwrap_failed" }, why);
    const these = g.calls.slice(before);
    assert.equal(these.length, 1, `${why}: a refused unwrap is asked exactly once, never retried`);
    assert.ok(these.every(c => c.op === "decrypt" && !c.ok && !c.gavePlaintext && c.why === "AAD" && JSON.parse(c.aad).origin === edited), why);
    assert.equal(ran, false, why);
  }
  editRow("UPDATE saved_logins SET signin_origin = ? WHERE id = ?", ORIGIN, LOGIN);
  await withLogin(ME, LOGIN, ORIGIN, () => {});
});

test("rule 1: a row copied to another person, or moved to another login's id, does not unwrap", async () => {
  const theirs = await saveLogin(OTHER, meta({ site: "other.test", label: "Other", signinOrigin: "https://other.test" }), fields());
  editRow("UPDATE saved_logins SET conversation_id = ? WHERE id = ?", OTHER, LOGIN);
  let before = g.calls.length;
  await assert.rejects(withLogin(OTHER, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
  assert.equal(g.calls.length - before, 1);
  editRow("UPDATE saved_logins SET conversation_id = ? WHERE id = ?", ME, LOGIN);
  const mine = rowOf(LOGIN), saved = rowOf(theirs.id);
  editRow("UPDATE saved_logins SET signin_origin = ?, username_ct = ?, password_ct = ?, totp_ct = ?, wrapped_key = ? WHERE id = ?",
    ORIGIN, mine.username_ct, mine.password_ct, mine.totp_ct, mine.wrapped_key, theirs.id);
  before = g.calls.length;
  await assert.rejects(withLogin(OTHER, theirs.id, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
  assert.equal(g.calls.length - before, 1);
  editRow("UPDATE saved_logins SET signin_origin = ?, username_ct = ?, password_ct = ?, totp_ct = ?, wrapped_key = ? WHERE id = ?",
    saved.signin_origin, saved.username_ct, saved.password_ct, saved.totp_ct, saved.wrapped_key, theirs.id);
  assert.ok(g.calls.every(c => c.ok || !c.gavePlaintext));
  assert.ok(removeLogin(OTHER, theirs.id));
});

// ---------------------------------------------------------------- retries
test("retries: a throttle (429) and a Google-side failure (503) are retried, then the login opens; a permission refusal is asked once", async () => {
  let before = g.calls.length;
  g.fail.push([429, "RESOURCE_EXHAUSTED"], [503, "UNAVAILABLE"]);
  let opened = false;
  await withLogin(ME, LOGIN, ORIGIN, ({ password }) => { opened = password instanceof Secret; });
  assert.equal(opened, true);
  assert.deepEqual(g.calls.slice(before).map(c => [c.op, c.ok, c.why ?? ""]),
    [["decrypt", false, "RESOURCE_EXHAUSTED"], ["decrypt", false, "UNAVAILABLE"], ["decrypt", true, ""]]);
  for (const [code, status] of [[403, "PERMISSION_DENIED"], [400, "FAILED_PRECONDITION"]]) {
    before = g.calls.length;
    g.fail.push([code, status]);
    await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
    assert.equal(g.calls.length - before, 1, `${status}: one call`);
  }
  // A key with its decrypt grant taken away (the kill switch, short of disabling the key).
  g.keys.get("reason-vault").grants.delete("decrypt");
  before = g.calls.length;
  await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
  assert.equal(g.calls.length - before, 1);
  g.keys.get("reason-vault").grants.add("decrypt");
  assert.equal(g.fail.length, 0);
});

// ---------------------------------------------------------------- hard rule 2
test("rule 2: the file's bytes hold no value or data key; a copied logins.db with no key file, or with someone else's Google, opens nothing", async () => {
  const bytes = fileBytes();
  assert.ok(bytes.length > 0);
  assert.deepEqual(leaks(bytes, allValues()), []);
  for (const k of g.issued) assert.ok(!bytes.includes(k) && !bytes.includes(Buffer.from(k.toString("base64"))), "no data key in clear");

  const copy = join(dir, "stolen", "logins.db");
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(loginsDbPath(), copy);
  process.env.REASON_LOGINS_DB_PATH = copy;
  const file = process.env.REASON_GCP_KEY_FILE;
  try {
    assert.equal(listLogins(ME).length, 1);
    delete process.env.REASON_GCP_KEY_FILE;
    const before = g.calls.length;
    await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "not_available" });
    assert.equal(g.calls.length, before, "no key service: not even asked");
    mkdirSync(join(dir, "theirs"));
    const theirs = await standInGcp({ dir: join(dir, "theirs") });
    useStandIn(theirs);
    try {
      await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
      assert.ok(theirs.calls.length >= 1 && theirs.calls.every(c => !c.gavePlaintext));
    } finally { await theirs.close(); }
  } finally {
    useStandIn(g);
    process.env.REASON_GCP_KEY_FILE = file;
    delete process.env.REASON_LOGINS_DB_PATH;
  }
  await withLogin(ME, LOGIN, ORIGIN, () => {});
});

// ---------------------------------------------------------------- hard rule 4
test("rule 4: a refused or paused row, or one before next_try_at, is not opened and Google is not asked", async () => {
  const before = g.calls.length;
  for (const state of ["refused", "paused"]) {
    editRow("UPDATE saved_logins SET state = ? WHERE id = ?", state, LOGIN);
    await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), e => e.code === "stopped" && e.message.includes(state));
  }
  editRow("UPDATE saved_logins SET state = 'working', next_try_at = ? WHERE id = ?", Date.now() + 3600_000, LOGIN);
  await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "wait" });
  assert.equal(g.calls.length - before, 0);
  editRow("UPDATE saved_logins SET next_try_at = NULL WHERE id = ?", LOGIN);
  await withLogin(ME, LOGIN, ORIGIN, () => {});
  assert.ok(removeLogin(ME, LOGIN));
  assert.deepEqual(listLogins(ME), []);
});
