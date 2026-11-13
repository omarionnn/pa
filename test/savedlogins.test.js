// The vault's safe box (src/savedlogins.js, src/vaultkms.js; brief docs/account-access-build/pr3.md).
// A stand-in KMS on 127.0.0.1 checks the SigV4 signature and, like AWS, refuses a Decrypt whose
// encryption context differs from the one the key was made with. Nothing here reaches the internet;
// every AWS value below is a dummy for the stand-in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format, inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "savedlogins-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;                       // deleteData (rule 6) touches nothing outside this dir
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_STRICT = "1";                 // SQLite itself refuses a plaintext login_log.purpose
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "44".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.AWS_SESSION_TOKEN;
delete process.env.REASON_REST_KMS_KEY_ID;
process.env.REASON_REST_KMS_REGION = "us-west-2";
process.env.AWS_ACCESS_KEY_ID = "STANDINACCESSKEY0001";
process.env.AWS_SECRET_ACCESS_KEY = "stand-in-secret-for-tests-only";
process.env.REASON_VAULT_KMS_KEY = "alias/reason-vault";
process.env.REASON_SAVED_LOGINS = "off";
after(() => rmSync(dir, { recursive: true, force: true }));

// kmsCall (src/restcrypt.js) tries 5 times, waiting 0.5 s to 8 s; the vault does not retry a refusal
// (src/vaultkms.js vaultRetry), only throttling, KMS-side and network failures. Those waits are cut to
// 1 ms in this file.
const realSetTimeout = globalThis.setTimeout;
const BACKOFF = new Set([500, 1000, 2000, 4000, 8000]);
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, BACKOFF.has(ms) ? 1 : ms, ...a);

const { sigv4 } = await import("../src/restcrypt.js");
const { Secret } = await import("../src/secret.js");

// ---------------------------------------------------------------- the stand-in KMS
async function standInKms() {
  const arn = "arn:aws:kms:us-west-2:000000000000:key/stand-in-vault";
  const master = randomBytes(32);
  const names = new Set(["alias/reason-vault", arn]);
  const calls = [];          // { target, context, ok, gavePlaintext }
  const fail = [];           // queued answers before the real one: [status, __type], e.g. a throttle
  const issued = [];         // every data key handed out, for the byte scans
  const bodies = [];         // every request body, to prove no field value was ever sent
  const canon = ctx => JSON.stringify(Object.keys(ctx).sort().map(k => [k, ctx[k]]));
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      const target = String(req.headers["x-amz-target"] ?? "").replace(/^TrentService\./, "");
      const send = (code, j) => { res.writeHead(code, { "content-type": "application/x-amz-json-1.1" }); res.end(JSON.stringify(j)); };
      const want = sigv4({ host: req.headers.host, body, region: "us-west-2", service: "kms", accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, amzDate: String(req.headers["x-amz-date"] ?? ""),
        headers: { "content-type": req.headers["content-type"], "x-amz-target": req.headers["x-amz-target"] } });
      if (req.headers.authorization !== want.authorization) { calls.push({ target, ok: false, why: "signature" }); return send(400, { __type: "InvalidSignatureException" }); }
      let j;
      try { j = JSON.parse(body); } catch { return send(400, { __type: "SerializationException" }); }
      const context = j.EncryptionContext ?? {};
      if (fail.length) { const [code, type] = fail.shift(); calls.push({ target, context, ok: false, gavePlaintext: false, why: type }); return send(code, { __type: type }); }
      if (!names.has(j.KeyId)) { calls.push({ target, context, ok: false, why: "key" }); return send(400, { __type: "NotFoundException" }); }
      if (target === "GenerateDataKey") {
        if (j.KeySpec !== "AES_256") return send(400, { __type: "ValidationException" });
        const dk = randomBytes(32), iv = randomBytes(12);
        issued.push(Buffer.from(dk));
        const c = createCipheriv("aes-256-gcm", master, iv);
        c.setAAD(Buffer.from(`${arn}|${canon(context)}`));
        const ct = Buffer.concat([c.update(dk), c.final()]);
        calls.push({ target, context, ok: true, gavePlaintext: true });
        return send(200, { KeyId: arn, Plaintext: dk.toString("base64"), CiphertextBlob: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") });
      }
      if (target === "Decrypt") {
        try {
          const b = Buffer.from(String(j.CiphertextBlob ?? ""), "base64");
          const d = createDecipheriv("aes-256-gcm", master, b.subarray(0, 12));
          d.setAAD(Buffer.from(`${arn}|${canon(context)}`));
          d.setAuthTag(b.subarray(12, 28));
          const dk = Buffer.concat([d.update(b.subarray(28)), d.final()]);
          calls.push({ target, context, ok: true, gavePlaintext: true });
          return send(200, { KeyId: arn, Plaintext: dk.toString("base64"), EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
        } catch {
          calls.push({ target, context, ok: false, gavePlaintext: false, why: "context" });
          return send(400, { __type: "InvalidCiphertextException" });
        }
      }
      return send(400, { __type: "UnknownOperationException" });
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { host: `127.0.0.1:${server.address().port}`, calls, issued, bodies, fail, close: () => server.close(),
    count: (target, ok) => calls.filter(c => c.target === target && (ok === undefined || c.ok === ok)).length };
}
const kms = await standInKms();
after(() => kms.close());
process.env.REASON_REST_KMS_HOST = kms.host;

const sl = await import("../src/savedlogins.js");
const { saveLogin, listLogins, removeLogin, withLogin, savedLoginsAllowedFor, savedLoginsMode, vaultReady, loginsDbPath } = sl;
const { classifySite, refusalFor } = await import("../src/sitepolicy.js");

// ---------------------------------------------------------------- fixtures (made up, nobody's)
const ME = "dm:owner";      // the operator's thread with no account row (src/accounts.js ownerOf)
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
  const so = process.stdout.write, se = process.stderr.write;
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(format(...a));
  process.stdout.write = function (c, ...r) { out.push(String(c)); return so.call(this, c, ...r); };
  process.stderr.write = function (c, ...r) { out.push(String(c)); return se.call(this, c, ...r); };
  let value, error;
  try { value = await fn(); } catch (e) { error = e; }
  finally { Object.assign(console, saved); process.stdout.write = so; process.stderr.write = se; }
  return { value, error, text: out.join("\n") };
}
const allValues = () => [PLAIN.username, PLAIN.password, PLAIN.totp];

// ---------------------------------------------------------------- the switch
test("switch off: nothing allowed, nothing created, the module loads without making logins.db", async () => {
  assert.equal(savedLoginsMode(), "off");
  assert.equal(savedLoginsAllowedFor(ME), false);
  await assert.rejects(saveLogin(ME, meta(), fields()), { code: "not_available" });
  await assert.rejects(withLogin(ME, 1, ORIGIN, () => {}), { code: "not_available" });
  assert.deepEqual(listLogins(ME), []);
  assert.equal(removeLogin(ME, 1), false);
  assert.equal(existsSync(loginsDbPath()), false, "data/logins.db does not exist with the switch off");
  assert.equal(dirname(loginsDbPath()), dir, "beside reason.db and keys.db");
  assert.equal(kms.calls.length, 0);
});

test("switch on with no KMS: one log line, the vault refuses every call; owner mode is the operator only", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  const key = process.env.REASON_VAULT_KMS_KEY;
  delete process.env.REASON_VAULT_KMS_KEY;
  const r = await captured(async () => {
    assert.equal(vaultReady(), false);
    assert.equal(savedLoginsAllowedFor(ME), false);
    await assert.rejects(saveLogin(ME, meta(), fields()), { code: "not_available" });
    await assert.rejects(withLogin(ME, 1, ORIGIN, () => {}), { code: "not_available" });
  });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.text.split("saved logins: off (no KMS key)").length - 1, 1, "exactly one log line");
  process.env.REASON_VAULT_KMS_KEY = key;

  for (const drop of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    const v = process.env[drop]; delete process.env[drop];
    assert.equal(vaultReady(), false, `no ${drop}`);
    process.env[drop] = v;
  }
  const ctx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  assert.equal(vaultReady(), false, "a 127.x KMS host is refused outside a test run");
  process.env.NODE_TEST_CONTEXT = ctx;
  assert.ok(ctx, "node --test sets NODE_TEST_CONTEXT");
  assert.equal(vaultReady(), true);

  process.env.REASON_SAVED_LOGINS = "owner";
  assert.equal(savedLoginsAllowedFor(ME), true);
  assert.equal(savedLoginsAllowedFor(OTHER), false);
  process.env.REASON_SAVED_LOGINS = "on";
  assert.equal(savedLoginsAllowedFor(OTHER), true);
  assert.equal(existsSync(loginsDbPath()), false);
  assert.equal(kms.calls.length, 0);
});

// ---------------------------------------------------------------- hard rule 3 (stub until vault PR 4)
test("rule 3: the real never list (src/sitepolicy.js) refuses a never site and says why; careful means each time", async () => {
  // Real hosts from PR 4's reviewed list; the stand-in KMS is the only thing ever asked, nothing is fetched.
  assert.equal(classifySite("chase.com").policy, "never");
  assert.equal(classifySite("https://www.amazon.com").policy, "careful");
  assert.equal(classifySite("example.test").policy, "allowed");
  assert.match(readFileSync(new URL("../src/savedlogins.js", import.meta.url), "utf8"), /import \{ classifySite, refusalFor \} from "\.\/sitepolicy\.js";/, "code decides: nothing handed in");
  const f = fields();
  await assert.rejects(saveLogin(ME, meta({ site: "chase.com", label: "Chase", signinOrigin: "https://secure.chase.com" }), f),
    e => e.code === "never_site" && e.why === refusalFor("bank", "Chase") && e.why.length > 10);
  assert.ok(!f.username.live && !f.password.live && !f.totp.live, "handed-in secrets are wiped on a refusal too");
  await assert.rejects(saveLogin(ME, meta({ site: "chase.com", label: "Chase", signinOrigin: "https://secure.chase.com", permission: "each_time" }), fields()),
    { code: "never_site" }, "never is never, whatever the permission");
  await assert.rejects(saveLogin(ME, meta({ site: "amazon.com", signinOrigin: "https://www.amazon.com" }), fields()), { code: "careful_needs_each_time" });
  assert.equal(kms.count("GenerateDataKey"), 0, "refused before any key was made");
  const ok = await saveLogin(ME, meta({ site: "amazon.com", label: "Amazon", signinOrigin: "https://www.amazon.com", permission: "each_time" }), fields());
  assert.equal(ok.state, "unverified");
  assert.equal(kms.count("GenerateDataKey", true), 1);
  assert.ok(removeLogin(ME, ok.id));
});

test("bad input is refused before KMS: non-https or non-canonical origin, a host off the site, a query in the path, no consent, a duplicate", async () => {
  const before = kms.calls.length;
  for (const [over, code] of [
    [{ signinOrigin: "http://login.example.test" }, "bad_site"],
    [{ signinOrigin: "https://login.example.test/signin" }, "bad_site"],
    [{ signinOrigin: "https://login.example.test:443" }, "bad_site"],
    [{ signinOrigin: "https://login.example.test.evil.test" }, "bad_site"],
    [{ signinPath: "/signin?next=/x" }, "bad_path"],
    [{ consentCredential: "" }, "no_consent"],
    [{ permission: "always" }, "bad_permission"],
  ]) await assert.rejects(saveLogin(ME, meta(over), fields()), { code }, JSON.stringify(over));
  await assert.rejects(saveLogin(ME, meta(), { username: S("x"), password: "plain string" }), { code: "bad_fields" });
  assert.equal(kms.calls.length, before);
});

// ---------------------------------------------------------------- seal and open
let LOGIN; // the example.test login the rest of the file uses
test("seal and open: one GenerateDataKey, one Decrypt, the values only inside fn, wiped after", async () => {
  const sealed = await captured(() => saveLogin(ME, meta(), fields()));
  assert.equal(sealed.error, undefined, sealed.error?.message);
  LOGIN = sealed.value.id;
  assert.ok(Number.isSafeInteger(LOGIN) && LOGIN > 0 && LOGIN < 2 ** 48);
  assert.deepEqual(Object.keys(sealed.value).sort(), ["id", "site", "state"]);

  const gen = kms.calls.filter(c => c.target === "GenerateDataKey").at(-1);
  assert.deepEqual(Object.keys(gen.context).sort(), ["app", "item", "origin", "person", "purpose"]);
  assert.equal(gen.context.app, "reason");
  assert.equal(gen.context.purpose, "saved-login");
  assert.equal(gen.context.item, String(LOGIN));
  assert.equal(gen.context.origin, ORIGIN);
  assert.ok(gen.context.person.length >= 20 && !gen.context.person.includes("owner"), "a random handle, never the conversation id");

  const row = rowOf(LOGIN);
  assert.ok(row.username_hint.startsWith("enc:u1:"), "the hint is sealed under the person's key");
  assert.equal(row.state, "unverified");
  assert.equal(row.kms_key, "arn:aws:kms:us-west-2:000000000000:key/stand-in-vault");
  assert.equal(statSync(loginsDbPath()).mode & 0o777, 0o600);

  const list = listLogins(ME);
  assert.equal(list.length, 1);
  assert.equal(list[0].username_hint, "v…@example.test");
  for (const k of ["username_ct", "password_ct", "totp_ct", "wrapped_key", "kms_key"]) assert.ok(!(k in list[0]), `listLogins never returns ${k}`);
  assert.deepEqual(leaks(Buffer.from(JSON.stringify(list)), allValues()), []);

  const decrypts = kms.count("Decrypt");
  let seen, lent;
  const opened = await captured(() => withLogin(ME, LOGIN, ORIGIN, async ({ username, password, totp }) => {
    lent = { username, password, totp };
    seen = { username: username.use(b => b.toString("utf8")), password: password.use(b => b.toString("utf8")), totp: totp.use(b => b.toString("utf8")) };
    return "filled";
  }));
  assert.equal(opened.error, undefined, opened.error?.message);
  assert.equal(opened.value, "filled");
  assert.deepEqual(seen, PLAIN);
  assert.equal(kms.count("Decrypt") - decrypts, 1, "exactly one Decrypt");
  assert.ok(!lent.username.live && !lent.password.live && !lent.totp.live, "wiped after fn");
  assert.ok(rowOf(LOGIN).last_used_at > 0);

  // Rule 2: nothing printed while sealing or opening holds a value, and no field value ever went to KMS.
  assert.deepEqual(leaks(Buffer.from(sealed.text + opened.text), allValues()), []);
  assert.deepEqual(leaks(Buffer.from(kms.bodies.join("\n")), allValues()), []);
});

test("an unused field is still wiped, and fn sees only Secrets that print [secret]", async () => {
  let got;
  await withLogin(ME, LOGIN, ORIGIN, ({ username, password, totp }) => { got = { username, password, totp }; });
  assert.ok(!got.username.live && !got.password.live && !got.totp.live);
  assert.equal(`${got.password}`, "[secret]");
  assert.equal(JSON.stringify(got), '{"username":"[secret]","password":"[secret]","totp":"[secret]"}');
});

// ---------------------------------------------------------------- hard rule 1: exact origin only
const MISMATCHES = { scheme: "http://login.example.test", host: "https://login2.example.test", port: "https://login.example.test:8443" };

test("rule 1: a live origin that differs by scheme, host or port is refused, and fn never runs", async () => {
  const decrypts = kms.count("Decrypt");
  for (const [why, live] of Object.entries(MISMATCHES)) {
    let ran = false;
    await assert.rejects(withLogin(ME, LOGIN, live, () => { ran = true; }), { code: "origin_mismatch" }, why);
    assert.equal(ran, false, why);
  }
  assert.equal(kms.count("Decrypt") - decrypts, 0, "refused before KMS was asked");
});

test("rule 1: a row whose origin was edited fails to unwrap at the stand-in: three mismatches, three failures, zero plaintext", async () => {
  for (const [why, edited] of Object.entries(MISMATCHES)) {
    editRow("UPDATE saved_logins SET signin_origin = ? WHERE id = ?", edited, LOGIN);
    const before = kms.calls.length;
    let ran = false;
    await assert.rejects(withLogin(ME, LOGIN, edited, () => { ran = true; }), { code: "unwrap_failed" }, why);
    const these = kms.calls.slice(before);
    assert.equal(these.length, 1, `${why}: a refused unwrap is asked exactly once, never retried`);
    assert.ok(these.every(c => c.target === "Decrypt" && !c.ok && !c.gavePlaintext && c.context.origin === edited), why);
    assert.equal(ran, false, why);
  }
  editRow("UPDATE saved_logins SET signin_origin = ? WHERE id = ?", ORIGIN, LOGIN);
  await withLogin(ME, LOGIN, ORIGIN, () => {}); // and the true origin still opens
});

test("KMS retries: a throttle (HTTP 400) and a KMS-side failure are retried, then the login opens; a refusal is asked once", async () => {
  const before = kms.calls.length;
  kms.fail.push([400, "ThrottlingException"], [500, "KMSInternalException"]);
  let opened = false;
  await withLogin(ME, LOGIN, ORIGIN, ({ password }) => { opened = password instanceof Secret; });
  assert.equal(opened, true);
  assert.deepEqual(kms.calls.slice(before).map(c => [c.target, c.ok, c.why ?? ""]),
    [["Decrypt", false, "ThrottlingException"], ["Decrypt", false, "KMSInternalException"], ["Decrypt", true, ""]]);
  const b2 = kms.calls.length;
  kms.fail.push([400, "AccessDeniedException"]);
  await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
  assert.equal(kms.calls.length - b2, 1, "AccessDenied: one call");
  assert.equal(kms.fail.length, 0);
});

test("KMS retries: vaultRetry decides on the exception name, not the status alone", async () => {
  const { vaultRetry } = await import("../src/vaultkms.js");
  const e = (kmsStatus, kmsType) => Object.assign(new Error("KMS"), { kmsStatus, kmsType });
  for (const t of ["InvalidCiphertextException", "AccessDeniedException", "IncorrectKeyException", "NotFoundException",
    "DisabledException", "KMSInvalidStateException", "ValidationException"]) assert.equal(vaultRetry(e(400, t)), false, t);
  for (const [s, t] of [[400, "ThrottlingException"], [500, "KMSInternalException"], [500, "DependencyTimeoutException"],
    [503, ""], [502, "ServiceUnavailable"], [429, ""]]) assert.equal(vaultRetry(e(s, t)), true, `${s} ${t}`);
  assert.equal(vaultRetry(new TypeError("fetch failed")), true, "network error");
  assert.equal(vaultRetry(Object.assign(new Error("timeout"), { name: "TimeoutError" })), true, "timeout");
  assert.equal(vaultRetry(e(400, "SomeOtherException")), false, "an unknown 4xx is a refusal");
});

test("rule 1: a row copied to another person, or moved to another login's id, does not unwrap; swapped fields do not open", async () => {
  const theirs = await saveLogin(OTHER, meta({ site: "other.test", label: "Other", signinOrigin: "https://other.test" }), fields());
  // to another person
  editRow("UPDATE saved_logins SET conversation_id = ? WHERE id = ?", OTHER, LOGIN);
  await assert.rejects(withLogin(OTHER, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
  editRow("UPDATE saved_logins SET conversation_id = ? WHERE id = ?", ME, LOGIN);
  // my sealed login moved onto their row (same origin, so only the person and the id differ)
  const mine = rowOf(LOGIN), saved = rowOf(theirs.id);
  editRow("UPDATE saved_logins SET signin_origin = ?, username_ct = ?, password_ct = ?, totp_ct = ?, wrapped_key = ? WHERE id = ?",
    ORIGIN, mine.username_ct, mine.password_ct, mine.totp_ct, mine.wrapped_key, theirs.id);
  await assert.rejects(withLogin(OTHER, theirs.id, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
  editRow("UPDATE saved_logins SET signin_origin = ?, username_ct = ?, password_ct = ?, totp_ct = ?, wrapped_key = ? WHERE id = ?",
    saved.signin_origin, saved.username_ct, saved.password_ct, saved.totp_ct, saved.wrapped_key, theirs.id);
  // fields swapped inside my own row: the key unwraps, the associated data does not match
  editRow("UPDATE saved_logins SET username_ct = ?, password_ct = ? WHERE id = ?", mine.password_ct, mine.username_ct, LOGIN);
  await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "open_failed" });
  editRow("UPDATE saved_logins SET username_ct = ?, password_ct = ? WHERE id = ?", mine.username_ct, mine.password_ct, LOGIN);
  assert.ok(kms.calls.every(c => c.ok || !c.gavePlaintext));
  assert.ok(removeLogin(OTHER, theirs.id));
});

// ---------------------------------------------------------------- hard rule 2: never out of the fill step
test("rule 2: only src/filler.js may import withLogin; tools, the nightly review and recall import nothing that opens a login", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  const walk = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (rel && e.name !== "node_modules") walk(p); }
      else if (/\.(m?js|cjs)$/.test(e.name)) files.push(p);
    }
  };
  walk("");
  for (const d of ["src", "scripts", "deploy", "bin", "web"]) if (existsSync(join(root, d))) walk(d);
  assert.ok(files.includes("src/savedlogins.js") && files.includes("src/tools.js") && files.length > 100);
  const bad = [];
  for (const f of files) {
    const t = readFileSync(join(root, f), "utf8");
    if (f !== "src/savedlogins.js" && f !== "src/filler.js" && /\bwithLogin\b/.test(t)) bad.push(`${f}: names withLogin`);
    if (f !== "src/savedlogins.js" && /["'`][^"'`]*vaultkms(\.js)?["'`]/.test(t)) bad.push(`${f}: imports vaultkms.js`);
    if (f !== "src/filler.js" && (/import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*savedlogins\.js["']/.test(t) || /export\s*\*[^;]*from\s*["'][^"']*savedlogins\.js["']/.test(t)
      || /import\s*\(\s*["'`][^"'`]*savedlogins/.test(t) || /require\s*\(\s*["'`][^"'`]*savedlogins/.test(t))) bad.push(`${f}: takes the whole of savedlogins.js`);
  }
  for (const f of ["src/tools.js", "src/dream.js", "src/recallindex.js", "src/memory.js", "src/memorynote.js"]) {
    const t = readFileSync(join(root, f), "utf8");
    if (/from\s*["'][^"']*\b(savedlogins|vaultkms|filler)\.js["']/.test(t) || /import\s*\(\s*["'`][^"'`]*(savedlogins|vaultkms|filler)/.test(t)) bad.push(`${f}: imports the vault`);
  }
  assert.deepEqual(bad, []);
});

test("rule 2: whatever fn throws comes back as fill_failed; an error built from a Secret shows [secret]", async () => {
  let inside;
  const r = await captured(() => withLogin(ME, LOGIN, ORIGIN, ({ password }) => {
    inside = new Error(`typing ${password} into the box failed`);
    throw inside;
  }));
  assert.equal(inside.message, "typing [secret] into the box failed");
  assert.equal(r.error?.code, "fill_failed");
  assert.equal(r.error.message, "saved logins: fill_failed (Error)");
  const raw = await withLogin(ME, LOGIN, ORIGIN, ({ password }) => { throw new Error(password.use(b => b.toString("utf8"))); }).catch(e => e);
  assert.equal(raw.code, "fill_failed", "even a message that holds the value is not passed on");
  assert.equal(raw.cause, undefined);
  const shown = [r.error.message, r.error.stack, inspect(r.error), r.text, raw.message, raw.stack, inspect(raw)].join("\n");
  assert.deepEqual(leaks(Buffer.from(shown), allValues()), []);
});

test("rule 2: the file's bytes never hold a field value or a data key, and a copied logins.db with no KMS opens nothing", async () => {
  const bytes = fileBytes();
  assert.ok(bytes.length > 0);
  assert.deepEqual(leaks(bytes, allValues()), []);
  assert.deepEqual(leaks(bytes, ["vault-tester", "Stand-in-pass", "STANDINTOTP"]), []);
  for (const k of kms.issued) assert.ok(!bytes.includes(k) && !bytes.includes(Buffer.from(k.toString("base64"))), "no data key in clear");

  const copy = join(dir, "stolen", "logins.db");
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(loginsDbPath(), copy);
  process.env.REASON_LOGINS_DB_PATH = copy;
  try {
    assert.equal(listLogins(ME).length, 1, "the copy is the same file");
    const key = process.env.REASON_VAULT_KMS_KEY;
    delete process.env.REASON_VAULT_KMS_KEY;
    const before = kms.calls.length;
    await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "not_available" });
    assert.equal(kms.calls.length, before, "no key service: not even asked");
    process.env.REASON_VAULT_KMS_KEY = key;
    // Someone else's key service (a second stand-in with its own master key) cannot unwrap it either.
    const theirs = await standInKms();
    process.env.REASON_REST_KMS_HOST = theirs.host;
    try {
      await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "unwrap_failed" });
      assert.ok(theirs.calls.length >= 1 && theirs.calls.every(c => !c.gavePlaintext));
    } finally { theirs.close(); }
  } finally {
    process.env.REASON_REST_KMS_HOST = kms.host;
    delete process.env.REASON_LOGINS_DB_PATH;
  }
  assert.equal(dirname(loginsDbPath()), dir);
  await withLogin(ME, LOGIN, ORIGIN, () => {});
});

// ---------------------------------------------------------------- hard rule 4: one refusal stops
test("rule 4: a refused or paused row, or one before next_try_at, is not opened and KMS is not asked", async () => {
  const before = kms.count("Decrypt");
  for (const state of ["refused", "paused"]) {
    editRow("UPDATE saved_logins SET state = ? WHERE id = ?", state, LOGIN);
    await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), e => e.code === "stopped" && e.message.includes(state));
  }
  editRow("UPDATE saved_logins SET state = 'working', next_try_at = ? WHERE id = ?", Date.now() + 3600_000, LOGIN);
  await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "wait" });
  assert.equal(kms.count("Decrypt") - before, 0);
  assert.throws(() => editRow("UPDATE saved_logins SET state = 'locked' WHERE id = ?", LOGIN), /CHECK constraint/);
  editRow("UPDATE saved_logins SET next_try_at = NULL WHERE id = ?", LOGIN);
  await withLogin(ME, LOGIN, ORIGIN, () => {});
  assert.equal(listLogins(ME)[0].state, "working");
});

// ---------------------------------------------------------------- rule 6, the part in this slice
test("removeLogin deletes the row and its wrapped key from the file's bytes; only the owner can remove it", async () => {
  await assert.rejects(saveLogin(ME, meta(), fields()), { code: "exists" });
  const row = rowOf(LOGIN);
  const wrapped = Buffer.from(row.wrapped_key);
  assert.ok(fileBytes().includes(wrapped));
  assert.equal(removeLogin(OTHER, LOGIN), false, "someone else cannot remove it");
  assert.equal(removeLogin(ME, LOGIN), true);
  assert.equal(removeLogin(ME, LOGIN), false);
  assert.deepEqual(listLogins(ME), []);
  const bytes = fileBytes();
  assert.ok(!bytes.includes(wrapped), "the wrapped key is gone from the file");
  for (const col of ["username_ct", "password_ct", "totp_ct"]) assert.ok(!bytes.includes(Buffer.from(row[col])), `${col} is gone from the file`);
  await assert.rejects(withLogin(ME, LOGIN, ORIGIN, () => assert.fail("opened")), { code: "not_found" });
});

// ---------------------------------------------------------------- rule 5: the person's record
const rdb = await import("../src/db.js");
const countFor = (table, c) => Number(rdb.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?`).get(c).n);
const SECOND = "https://www.example.test"; // a second sign-in origin on the same site
const hidden = () => [...allValues(), "vault-tester", "v…@example.test", "?order=", "4471"];

test("rule 5: withLogin, removeLogin and deleteAllFor each write one login_log row and one ledger row; ledger_list shows them, no username", async () => {
  const P = "dm:vault-ledger";
  const both = () => [countFor("login_log", P), countFor("action_ledger", P)];
  const step = async (what, fn) => {
    const [l0, a0] = both();
    await fn();
    assert.deepEqual(both(), [l0 + 1, a0 + 1], `${what}: one login_log row and one ledger row`);
  };
  let id;
  await step("save", async () => { ({ id } = await saveLogin(P, meta(), fields())); });
  await step("open", () => withLogin(P, id, ORIGIN, () => "ok", { purpose: "sign in to check an order https://login.example.test/orders?order=4471" }));
  await step("open on the wrong origin", () => assert.rejects(withLogin(P, id, MISMATCHES.host, () => assert.fail("opened")), { code: "origin_mismatch" }));
  await step("open a paused row", async () => {
    editRow("UPDATE saved_logins SET state = 'paused' WHERE id = ?", id);
    try { await assert.rejects(withLogin(P, id, ORIGIN, () => assert.fail("opened")), { code: "stopped" }); }
    finally { editRow("UPDATE saved_logins SET state = 'working' WHERE id = ?", id); }
  });
  await step("remove", () => assert.equal(removeLogin(P, id), true));
  await saveLogin(P, meta(), fields());
  await saveLogin(P, meta({ signinOrigin: SECOND }), fields());
  await step("delete all", () => assert.equal(sl.deleteAllFor(P), 2));
  assert.equal(sl.deleteAllFor(P), 0, "nothing left: no second record");
  assert.throws(() => sl.deleteAllFor(""), { code: "bad_input" }, "never everyone by accident");

  const { runTool } = await import("../src/tools.js");
  const out = await runTool("ledger_list", { limit: 50 }, { conversationId: P });
  const actions = out.actions.map(a => `${a.action}:${a.outcome}`).reverse();
  assert.deepEqual(actions, ["saved_login_saved:ok", "saved_login_opened:ok", "saved_login_opened:refused", "saved_login_opened:refused",
    "saved_login_removed:ok", "saved_login_saved:ok", "saved_login_saved:ok", "saved_login_removed_all:ok"]);
  assert.ok(out.actions.every(a => typeof a.receipt === "string" && a.receipt.length > 10));
  assert.match(out.actions[0].receipt, /^Deleted all 2 saved logins\.$/);
  const shown = JSON.stringify(out);
  assert.deepEqual(hidden().filter(v => shown.includes(v)), [], "no username, hint, value or query in ledger_list");

  const log = rdb.db.prepare("SELECT site, event, outcome, purpose, kms_calls FROM login_log WHERE conversation_id = ? ORDER BY id").all(P);
  assert.deepEqual(log.map(r => [r.event, r.outcome, r.kms_calls]), [["saved", "ok", 1], ["opened", "ok", 1], ["opened", "origin_mismatch", 0],
    ["opened", "stopped", 0], ["removed", "ok", 0], ["saved", "ok", 1], ["saved", "ok", 1], ["removed_all", "ok", 0]]);
  assert.equal(log[1].purpose, "sign in to check an order https://login.example.test/orders", "the purpose opens for its person, without the query");
  const raw = rdb.rawPrepare("SELECT purpose FROM login_log WHERE conversation_id = ? AND purpose <> ''").all(P);
  assert.ok(raw.length >= 1 && raw.every(r => r.purpose.startsWith("enc:u1:")), "purpose is sealed under the person's key in the file");
  const rows = JSON.stringify(rdb.rawPrepare("SELECT * FROM login_log WHERE conversation_id = ?").all(P));
  assert.deepEqual(hidden().filter(v => rows.includes(v)), [], "no username, hint, value or query in login_log");
  assert.throws(() => sl.recordLoginEvent(P, { site: "example.test", event: "peeked", outcome: "ok" }), { code: "bad_event" });
  assert.throws(() => sl.recordLoginEvent(P, { site: "https://example.test/?u=x", event: "opened", outcome: "ok" }), { code: "bad_site" });
});

// ---------------------------------------------------------------- rule 6 (rest) and the export
test("rule 6: deleteData leaves no row for the person, in logins.db or reason.db; the export lists sites with the login REDACTED", async () => {
  const Q = "dm:vault-delete";
  const keep = await saveLogin(OTHER, meta(), fields());
  const a = await saveLogin(Q, meta(), fields());
  const b = await saveLogin(Q, meta({ signinOrigin: SECOND, permission: "each_time" }), fields());
  await withLogin(Q, a.id, ORIGIN, () => "ok", { purpose: "sign in for them" });
  const gone = [rowOf(a.id), rowOf(b.id)];
  const data = await import("../src/data.js");

  const ex = data.exportData({ conversation: Q, audio: false, files: false });
  assert.equal(ex.saved_logins.length, 2);
  for (const r of ex.saved_logins) {
    assert.equal(r.login, "[not exported: this is a live credential]");
    assert.equal(r.username_hint, "v…@example.test", "the hint is in the export, opened");
    for (const k of ["username_ct", "password_ct", "totp_ct", "wrapped_key", "kms_key", "handle"]) assert.ok(!(k in r), `no ${k} in the export`);
  }
  assert.deepEqual(ex.saved_logins.map(r => [r.signin_origin, r.permission, r.state]).sort(), [[ORIGIN, "standing", "unverified"], [SECOND, "each_time", "unverified"]].sort());
  assert.ok(ex.tables.login_log.some(r => r.event === "opened" && r.purpose === "sign in for them"), "login_log is in the export, opened");
  const exported = JSON.stringify(ex);
  assert.deepEqual([...allValues(), ...gone.map(r => r.wrapped_key)].filter(v => exported.includes(v)), [], "no value and no wrapped key in the export");

  const res = await data.deleteData({ conversation: Q });
  assert.deepEqual(res.saved_logins, { deleted: 2 });
  assert.equal(res.rows.login_log >= 4, true, "the record went with the rest of theirs");
  const d = new DatabaseSync(loginsDbPath());
  try {
    assert.equal(Number(d.prepare("SELECT COUNT(*) AS n FROM saved_logins WHERE conversation_id = ?").get(Q).n), 0);
    assert.equal(Number(d.prepare("SELECT COUNT(*) AS n FROM vault_people WHERE conversation_id = ?").get(Q).n), 0, "their vault handle is gone too");
  } finally { d.close(); }
  assert.equal(countFor("login_log", Q), 0);
  assert.equal(countFor("action_ledger", Q), 0, "deleteAllFor ran before the rows went: its own record is gone too");
  const bytes = fileBytes();
  for (const r of gone) for (const col of ["wrapped_key", "username_ct", "password_ct", "totp_ct"]) assert.ok(!bytes.includes(Buffer.from(r[col])), `${col} is gone from the file`);
  assert.deepEqual(listLogins(Q), []);

  // Somebody else's login is untouched, and still opens.
  assert.equal(listLogins(OTHER).length, 1);
  assert.equal(await withLogin(OTHER, keep.id, ORIGIN, ({ password }) => password.use(p => p.length)), PLAIN.password.length);
});
