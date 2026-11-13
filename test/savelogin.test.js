// The save-login link and screen (vault PR 5, docs/account-access-build/pr5.md): a link made by code
// after Reason's own visit to the site's sign-in page, the login sealed in the browser to the intake
// key (here by the page's own sealing function, run in Node's WebCrypto), Face ID over exactly this
// login, site and wording, and the vault opening it only to re-seal it. The stand-in Google KMS on
// 127.0.0.1 (test/helpers/gcpkms-standin.js) holds the intake key's private half; a software
// authenticator stands in for Face ID. Nothing here reaches Google; every value is made up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { generateKeyPairSync, createHash, createSign, randomBytes, webcrypto } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "savelogin-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_REST3 = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "46".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_SITE_URL = "https://heyreason.com";
delete process.env.REASON_PASSKEY_ORIGIN;
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "off";
after(() => rmSync(dir, { recursive: true, force: true }));

const realSetTimeout = globalThis.setTimeout;
const BACKOFF = new Set([500, 1000, 2000, 4000]);
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, BACKOFF.has(ms) ? 1 : ms, ...a);

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
after(() => g.close());
useStandIn(g);

const intake = await import("../src/loginintake.js");
const sl = await import("../src/savedlogins.js");
const passkey = await import("../src/passkey.js");
const rdb = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { classifySite, refusalFor } = await import("../src/sitepolicy.js");

// ---------------------------------------------------------------- fixtures (made up, nobody's)
const ME = "dm:owner";
const ORIGIN = "https://login.example.test";
const PLAIN = { username: "intake-tester@example.test", password: "Stand-in-intake-9Zr!", totp: "STANDININTAKEKEYJBSWY3DPEH" };
const ASKED = "pay my example bill";
const sha = (b) => createHash("sha256").update(b).digest();
const at = (url) => async () => ({ found: true, url, form: "password", followed: false, ms: 5 });
const valuesIn = (s) => [PLAIN.username, PLAIN.password, PLAIN.totp].filter(v => s.includes(v) || s.includes(Buffer.from(v).toString("base64")));

class Authenticator {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.key = privateKey;
    this.rawId = randomBytes(16);
    this.id = this.rawId.toString("base64url");
    this.cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
    this.counter = 0;
  }
  authData({ uv = true, attested = false } = {}) {
    const c = Buffer.alloc(4); c.writeUInt32BE(this.counter);
    const parts = [sha("heyreason.com"), Buffer.from([0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0)]), c];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length); parts.push(Buffer.alloc(16), len, this.rawId, this.cose); }
    return Buffer.concat(parts);
  }
  create(options) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: "https://heyreason.com", crossOrigin: false }));
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
  }
  get(challenge, { uv = true, origin = "https://heyreason.com" } = {}) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData({ uv });
    const sig = createSign("SHA256").update(Buffer.concat([authenticatorData, sha(clientDataJSON)])).sign(this.key);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: sig.toString("base64url") }, clientExtensionResults: {} };
  }
}
const face = new Authenticator();
async function setUpFaceId(c = ME, a = face) {
  const o = await passkey.registrationOptions(c, { allowed: true });
  assert.equal(o.ok, true);
  const r = await passkey.register(c, a.create(o.options), { allowed: true, for: "login" });
  assert.equal(r.ok, true, r.error);
}
const tokenOf = (link) => link.split("/").pop();
async function offer(site = "example.test", url = `${ORIGIN}/signin`, c = ME) {
  const out = await intake.offerSaveLink(c, site, ASKED, { locate: at(url) });
  assert.equal(out.ok, true, out.error);
  return tokenOf(out.link);
}
/** What the page does: seal the boxes to the intake key (its own function), then Face ID over the challenge. */
async function pageSave(token, { permission = "standing", plain = PLAIN, a = face, tamper = null } = {}) {
  const v = await intake.viewFor(token);
  const sealed = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, plain.username, plain.password, plain.totp));
  const part = Buffer.from(v.parts[permission] ?? v.parts.each_time, "base64url");
  const body = { sealed: sealed.toString("base64url"), permission, assertion: a.get(intake.challengeOf(part, sealed)) };
  if (tamper) tamper(body);
  return { body, out: await intake.storeFromIntake(token, body) };
}
const rawIntake = () => rdb.rawPrepare("SELECT * FROM login_intake").all();
async function captured(fn) {
  const out = [];
  const saved = Object.fromEntries(["log", "info", "warn", "error", "debug"].map(k => [k, console[k]]));
  const so = process.stdout.write, se = process.stderr.write;
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(format(...a));
  process.stdout.write = function (ch, ...r) { out.push(String(ch)); return so.call(this, ch, ...r); };
  process.stderr.write = function (ch, ...r) { out.push(String(ch)); return se.call(this, ch, ...r); };
  let value, error;
  try { value = await fn(); } catch (e) { error = e; }
  finally { Object.assign(console, saved); process.stdout.write = so; process.stderr.write = se; }
  return { value, error, text: out.join("\n") };
}

// ---------------------------------------------------------------- the switch
test("switch off, or rest encryption not fully on: no link, no page data, no save, no tool", async () => {
  assert.equal((await intake.offerSaveLink(ME, "example.test", ASKED, { locate: at(`${ORIGIN}/signin`) })).error, "not_available");
  const { toolsFor } = await import("../src/tools.js");
  assert.equal(toolsFor(ME).some(t => t.name === "saved_login_offer"), false, "the tool is absent with the switch off");
  process.env.REASON_SAVED_LOGINS = "owner";
  assert.equal(toolsFor(ME).some(t => t.name === "saved_login_offer"), true);
  assert.equal(toolsFor("dm:not-the-owner").some(t => t.name === "saved_login_offer"), false, "owner mode: the operator only");
  const token = await offer();
  process.env.REASON_ENCRYPT_REST3 = "off";
  assert.equal(await intake.viewFor(token), null, "no REST3: the page is a 404");
  assert.equal(await intake.storeFromIntake(token, {}), null);
  process.env.REASON_ENCRYPT_REST3 = "on";
  process.env.REASON_SAVED_LOGINS = "off";
  assert.equal(await intake.viewFor(token), null, "switch off: the page is a 404");
  process.env.REASON_SAVED_LOGINS = "owner";
  assert.ok(await intake.viewFor(token));
  process.env.REASON_VAULT_KMS = "aws";
  assert.equal(await intake.viewFor(token), null, "the AWS provider has no intake key here");
  delete process.env.REASON_VAULT_KMS;
});

// ---------------------------------------------------------------- the offer
test("rule 3: a bank, gmail.com or uber.com gets no link and refusalFor's words; the record says so", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const before = rawIntake().length;
  for (const site of ["chase.com", "gmail.com", "uber.com"]) {
    let visited = false;
    const out = await intake.offerSaveLink(ME, site, ASKED, { locate: async () => { visited = true; return { found: true, url: `https://${site}/login`, form: "password" }; } });
    const v = classifySite(site);
    assert.equal(v.policy, "never", site);
    assert.equal(out.ok, false);
    assert.equal(out.say, refusalFor(v.category, site), site);
    assert.equal(visited, false, `${site}: the site is not even visited`);
  }
  assert.equal(rawIntake().length, before, "no link row");
  const log = rdb.db.prepare("SELECT event, outcome FROM login_log WHERE conversation_id = ? AND event = 'refused_never_list'").all(ME);
  assert.equal(log.length, 3);
  const { runTool } = await import("../src/tools.js");
  const r = await runTool("saved_login_offer", { site: "chase.com" }, { conversationId: ME, messages: [], kind: "user" });
  assert.equal(r.ok, false);
  assert.equal(r.say_exactly, refusalFor(classifySite("chase.com").category, "chase.com"));
  assert.equal(r.link, undefined);
});

test("rule 1: the origin is pinned from Reason's own visit; a sign-in page on another domain, a missed page or plain http gets no link", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const before = rawIntake().length;
  for (const [url, why] of [["https://accounts.other-idp.test/login", "off_site"], ["http://login.example.test/signin", "off_site"],
    ["https://user:pw@login.example.test/signin", "off_site"]]) {
    const out = await intake.offerSaveLink(ME, "example.test", ASKED, { locate: at(url) });
    assert.equal(out.error, why, url);
  }
  // A form page whose path cannot be kept is never pinned as the front page instead (ship review 2026-11-13).
  const long = await intake.offerSaveLink(ME, "example.test", ASKED, { locate: async () => ({ found: true, form: "password", url: `https://login.example.test/${"a".repeat(320)}` }) });
  assert.equal(long.error, "no_signin_form");
  // Reason's visit found no sign-in form: no link, and fixed words say so (2026-11-13, Netflix's home page).
  const none = await intake.offerSaveLink(ME, "example.test", ASKED, { locate: async () => ({ found: false, why: "no_form" }) });
  assert.equal(none.error, "no_signin_form");
  assert.match(none.say, /couldn't find example\.test's sign-in page/);
  // Each on a site of its own: a wall is remembered for its site, and example.test is used below.
  for (const [why, error] of [["wall", "walled"], ["off_site", "off_site"], ["not_loaded", "not_reached"]]) {
    const out = await intake.offerSaveLink(ME, `${why.replace("_", "-")}-example.test`, ASKED, { locate: async () => ({ found: false, why }) });
    assert.equal(out.ok, false); assert.equal(out.error, error); assert.equal(typeof out.say, "string");
  }
  // A page reached but with no form the filler can type into is never pinned, whatever "found" says.
  for (const form of [undefined, "", "signin_form", "challenge"]) {
    const out = await intake.offerSaveLink(ME, "example.test", ASKED, { locate: async () => ({ found: true, url: `${ORIGIN}/`, form }) });
    assert.equal(out.ok, false, `form ${form} is not a pin`);
    assert.equal(out.error, "no_signin_form");
  }
  assert.equal((await intake.offerSaveLink(ME, "example.test", ASKED, { locate: async () => { throw new Error("timeout"); } })).error, "not_reached");
  assert.equal((await intake.offerSaveLink(ME, "example.test", ASKED)).error, "not_reached", "no visit under test: no link");
  assert.equal(rawIntake().length, before);

  const out = await intake.offerSaveLink(ME, "https://www.example.test/home", ASKED, { locate: at(`${ORIGIN}/signin?next=/bill`) });
  assert.equal(out.ok, true);
  assert.match(out.link, /^https:\/\/heyreason\.com\/web\/save-login\/[A-Za-z0-9_-]{32}$/);
  const row = rawIntake().at(-1);
  assert.equal(row.signin_origin, ORIGIN);
  assert.equal(row.signin_path, "/signin", "no query kept");
  assert.equal(row.site, "example.test");
  assert.notEqual(row.token_hash, tokenOf(out.link), "only the hash of the token is kept");
  assert.ok(!JSON.stringify(row).includes(tokenOf(out.link)));
  assert.ok(row.quoted_request.startsWith("enc:u1:"), "their quoted request is sealed under their key");
  assert.equal(row.expires_at - row.created_at, 30 * 60_000);
  const v = await intake.viewFor(tokenOf(out.link));
  assert.equal(v.quoted, ASKED);
  assert.equal(v.host, "login.example.test");
});

test("the tool returns one fixed sentence and the link on its own line, quoting their own last words", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const { runTool } = await import("../src/tools.js");
  const r = await runTool("saved_login_offer", { site: "example.test" }, {
    conversationId: ME, messages: [{ role: "user", content: "pay my example bill please" }], locateSigninPage: at(`${ORIGIN}/signin`), kind: "user",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const [sentence, link, ...rest] = r.say_exactly.split("\n");
  assert.equal(sentence, intake.OFFER_SENTENCE);
  assert.match(link, /^https:\/\/heyreason\.com\/web\/save-login\/[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(rest, []);
  const { linkParts } = await import("../src/links.js");
  assert.deepEqual(linkParts(r.say_exactly), [sentence, link], "the link goes as its own bubble");
  assert.deepEqual(Object.keys(r).sort(), ["note", "ok", "say_exactly"]);
});

// Review 2026-11-13 (H2): an email, a page, a timer or the nightly review never makes Reason text a save
// link. Only a turn the person started with their own message; a missing kind counts as an event.
test("the live ask: an event turn (or no turn kind) gets no save link and no row", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const { runTool } = await import("../src/tools.js");
  const rows = () => rdb.db.prepare("SELECT COUNT(*) AS n FROM login_intake WHERE conversation_id = ?").get(ME).n;
  const n0 = rows();
  let located = 0;
  for (const kind of ["event", undefined]) {
    const r = await runTool("saved_login_offer", { site: "amaz0n-account.test" }, {
      conversationId: ME, messages: [{ role: "user", content: "summarise my email" }], kind,
      locateSigninPage: async () => { located++; return { found: true, url: "https://amaz0n-account.test/signin", form: "password" }; },
    });
    assert.equal(r.ok, false, `kind ${kind}`);
    assert.equal(r.error, "not_asked");
    assert.equal(JSON.stringify(r).includes("/web/save-login/"), false, "no link in the result");
  }
  assert.equal(located, 0, "Reason's browser was not even sent to the site");
  assert.equal(rows(), n0, "no link row was made");
});

// ---------------------------------------------------------------- the save
test("a save: sealed in the page, Face ID over it, one asymmetricDecrypt, stored unverified, opens to the same values", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const v0 = await intake.viewFor(await offer());
  assert.equal(v0.passkey.ok, false);
  assert.equal(v0.passkey.error, "no_passkey");
  await setUpFaceId();
  const token = await offer();
  const v = await intake.viewFor(token);
  assert.equal(v.state, "open");
  assert.equal(v.passkey.ok, true);
  assert.deepEqual(v.permissions, ["standing", "each_time"]);
  assert.equal(v.careful, false);
  const n0 = g.count("asymmetricDecrypt", true);
  const r = await captured(() => pageSave(token));
  assert.equal(r.error, undefined, r.error?.stack);
  const { body, out } = r.value;
  assert.deepEqual(out, { ok: true, site: "example.test", label: "example.test", state: "unverified" });
  assert.equal(g.count("asymmetricDecrypt", true), n0 + 1, "the intake key opened it once, inside the vault");
  assert.deepEqual(valuesIn(JSON.stringify(body)), [], "the POST body is ciphertext only");
  assert.deepEqual(valuesIn(r.text), [], "nothing typed reaches a log");
  assert.deepEqual(valuesIn(JSON.stringify(rawIntake())), [], "login_intake holds no secret");
  assert.deepEqual(valuesIn(JSON.stringify(g.bodies ?? [])), [], "the key service's request bodies hold no field");
  const row = sl.listLogins(ME).find(l => l.site === "example.test");
  assert.equal(row.state, "unverified");
  assert.equal(row.permission, "standing");
  assert.equal(row.signin_origin, ORIGIN);
  assert.equal(row.consent_version, intake.CONSENT_VERSION);
  const seen = await sl.withLogin(ME, row.id, ORIGIN, (f) => ({
    u: f.username.use(b => b.toString("utf8")), p: f.password.use(b => b.toString("utf8")), t: f.totp?.use(b => b.toString("utf8")),
  }));
  assert.deepEqual(seen, { u: PLAIN.username, p: PLAIN.password, t: PLAIN.totp });
  assert.equal(intake.forgetSite(ME, "example.test"), 1);
});

test("rule 4: a replayed, expired or used link is refused once and never retried", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const token = await offer();
  const first = await pageSave(token);
  assert.equal(first.out.ok, true);
  const n = g.count("asymmetricDecrypt");
  assert.deepEqual(await intake.storeFromIntake(token, first.body), { ok: false, error: "link_used" }, "the same POST again");
  assert.equal(g.count("asymmetricDecrypt"), n, "the key service is not asked again");
  assert.equal((await intake.viewFor(token)).state, "used");
  intake.forgetSite(ME, "example.test");

  const late = await offer();
  const v = await intake.viewFor(late);
  clock.skip(30 * 60_000 + 1000);
  try {
    assert.equal((await intake.viewFor(late)).state, "expired");
    const sealed = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, "a", "b", ""));
    const body = { sealed: sealed.toString("base64url"), permission: "standing", assertion: face.get(intake.challengeOf(Buffer.from(v.parts.standing, "base64url"), sealed)) };
    assert.deepEqual(await intake.storeFromIntake(late, body), { ok: false, error: "link_expired" });
    assert.equal(g.count("asymmetricDecrypt"), n);
  } finally { clock.reset(); }
  assert.equal((await intake.viewFor(late)).state, "used", "closed for good once refused");
  assert.equal(await intake.storeFromIntake("x".repeat(32), {}), null, "a token never made: the plain 404");
});

test("rule 1 and 4: an edited origin, another permission, a swapped blob or no Face ID fails the signature; the link closes", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const cases = [
    ["origin edited after the link was made", async (token) => {
      const v = await intake.viewFor(token);
      const sealed = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, PLAIN.username, PLAIN.password, ""));
      const body = { sealed: sealed.toString("base64url"), permission: "standing", assertion: face.get(intake.challengeOf(Buffer.from(v.parts.standing, "base64url"), sealed)) };
      rdb.db.prepare("UPDATE login_intake SET signin_origin = 'https://login.example-evil.test' WHERE claimed_at IS NULL").run();
      return intake.storeFromIntake(token, body);
    }],
    ["permission changed after signing", (token) => pageSave(token, { tamper: (b) => { b.permission = "each_time"; } }).then(r => r.out)],
    ["sealed blob swapped after signing", async (token) => {
      const v = await intake.viewFor(token);
      const other = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, "attacker@example.test", "attacker-pass", ""));
      return (await pageSave(token, { tamper: (b) => { b.sealed = other.toString("base64url"); } })).out;
    }],
    ["no user verification", async (token) => {
      const v = await intake.viewFor(token);
      const sealed = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, "a", "b", ""));
      return intake.storeFromIntake(token, { sealed: sealed.toString("base64url"), permission: "standing", assertion: face.get(intake.challengeOf(Buffer.from(v.parts.standing, "base64url"), sealed), { uv: false }) });
    }],
    ["signed on another origin", async (token) => {
      const v = await intake.viewFor(token);
      const sealed = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, "a", "b", ""));
      return intake.storeFromIntake(token, { sealed: sealed.toString("base64url"), permission: "standing", assertion: face.get(intake.challengeOf(Buffer.from(v.parts.standing, "base64url"), sealed), { origin: "https://heyreason.com.evil.test" }) });
    }],
  ];
  for (const [what, run] of cases) {
    const token = await offer();
    const n = g.count("asymmetricDecrypt");
    const out = await run(token);
    assert.equal(out.ok, false, what);
    assert.equal(g.count("asymmetricDecrypt"), n, `${what}: the key service is never asked`);
    assert.equal(sl.listLogins(ME).filter(l => l.site === "example.test").length, 0, `${what}: nothing stored`);
    assert.equal((await intake.viewFor(token))?.state ?? "used", "used", `${what}: refused once, the link is closed`);
  }
});

test("a blob made for one link does not open under another (its associated data names the link)", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const a = await offer();
  const va = await intake.viewFor(a);
  const b = await offer("example.test", `${ORIGIN}/signin`, ME); // closes a (one open per site), so make b, then reuse a's blob on b
  const vb = await intake.viewFor(b);
  const sealedForA = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(va.publicKey, "base64url"), va.intakeId, PLAIN.username, PLAIN.password, ""));
  const out = await intake.storeFromIntake(b, { sealed: sealedForA.toString("base64url"), permission: "standing", assertion: face.get(intake.challengeOf(Buffer.from(vb.parts.standing, "base64url"), sealedForA)) });
  assert.deepEqual(out, { ok: false, error: "open_failed" }, "signed, claimed, but the vault refuses to open it");
  assert.equal(sl.listLogins(ME).filter(l => l.site === "example.test").length, 0);
});

test("careful sites: each time only, with the site's warning line; a standing save is refused", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const token = await offer("delta.com", "https://www.delta.com/login/loginPage");
  const v = await intake.viewFor(token);
  assert.equal(v.careful, true);
  assert.deepEqual(v.permissions, ["each_time"]);
  assert.deepEqual(Object.keys(v.parts), ["each_time"]);
  assert.equal(v.warning, classifySite("delta.com").reason);
  assert.ok(v.warning.length > 10);
  const { out } = await pageSave(token, { permission: "standing" });
  assert.deepEqual(out, { ok: false, error: "bad_permission" });
  const ok = await pageSave(await offer("delta.com", "https://www.delta.com/login/loginPage"), { permission: "each_time" });
  assert.equal(ok.out.ok, true, ok.out.error);
  assert.equal(sl.listLogins(ME).find(l => l.site === "delta.com").permission, "each_time");
  assert.equal(intake.forgetSite(ME, "delta.com"), 1);
});

test("rule 2: a forced failure inside the vault during the POST leaks nothing to logs or the answer", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const token = await offer();
  g.fail.push([400, "INVALID_ARGUMENT"]);
  const r = await captured(() => pageSave(token));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value.out, { ok: false, error: "unwrap_failed" });
  assert.deepEqual(valuesIn(r.text + JSON.stringify(r.value.out)), []);
  assert.equal(sl.listLogins(ME).filter(l => l.site === "example.test").length, 0);
});

test("rule 5: link_sent, saved, refused_never_list, save_failed and removed are each a login_log row and a ledger row, with no username", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  const P = "dm:intake-ledger";
  const pf = new Authenticator();
  await setUpFaceId(P, pf);
  await intake.offerSaveLink(P, "gmail.com", ASKED, { locate: at("https://accounts.google.com/") });
  const t1 = await offer("example.test", `${ORIGIN}/signin`, P);
  await pageSave(t1, { a: pf, tamper: (b) => { b.permission = "each_time"; } });
  const t2 = await offer("example.test", `${ORIGIN}/signin`, P);
  assert.equal((await pageSave(t2, { a: pf })).out.ok, true);
  assert.equal(intake.forgetSite(P, "example.test"), 1);
  const log = rdb.db.prepare("SELECT event, outcome FROM login_log WHERE conversation_id = ? ORDER BY id").all(P).map(r => `${r.event}:${r.outcome}`);
  assert.deepEqual(log, ["refused_never_list:stopped", "link_sent:ok", "save_failed:stopped", "link_sent:ok", "saved:ok", "removed:ok"]);
  const { runTool } = await import("../src/tools.js");
  const out = await runTool("ledger_list", { limit: 50 }, { conversationId: P });
  const actions = out.actions.map(a => `${a.action}:${a.outcome}`).reverse();
  assert.deepEqual(actions, ["saved_login_refused_never_list:refused", "saved_login_link_sent:ok", "saved_login_save_failed:refused",
    "saved_login_link_sent:ok", "saved_login_saved:ok", "saved_login_removed:ok"]);
  const shown = JSON.stringify(out);
  assert.deepEqual(valuesIn(shown), []);
  assert.ok(!shown.includes("intake-tester") && !shown.includes("i…@example.test"), "no username or hint");
  process.env.REASON_SAVED_LOGINS = "owner";
});

test("rule 6: forget deletes the row and its wrapped key with no Face ID; a passkey is removed with none either", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  const P = "dm:intake-forget";
  const pf = new Authenticator();
  await setUpFaceId(P, pf);
  assert.equal((await pageSave(await offer("example.test", `${ORIGIN}/signin`, P), { a: pf })).out.ok, true);
  const wrapped = (() => {
    const d = new DatabaseSync(sl.loginsDbPath());
    try { return d.prepare("SELECT wrapped_key FROM saved_logins WHERE conversation_id = ?").get(P).wrapped_key; } finally { d.close(); }
  })();
  const { runTool } = await import("../src/tools.js");
  // An open save link for the same site (review 2026-11-13, M2): forget takes it too.
  const open = await offer("example.test", `${ORIGIN}/signin`, P);
  assert.ok(await intake.viewFor(open), "the second link is open before the forget");
  const r = await runTool("saved_login_forget", { site: "example.test" }, { conversationId: P });
  assert.equal(r.removed, 1);
  assert.equal(await intake.viewFor(open), null, "the open save link is gone with the login");
  assert.equal(await intake.storeFromIntake(open, {}), null);
  assert.equal(rdb.db.prepare("SELECT COUNT(*) AS n FROM login_intake WHERE conversation_id = ?").get(P).n, 0, "no intake row, used or open");
  assert.equal(sl.listLogins(P).length, 0);
  const p = sl.loginsDbPath();
  const bytes = Buffer.concat([p, `${p}-journal`, `${p}-wal`].filter(f => existsSync(f)).map(f => readFileSync(f)));
  assert.equal(bytes.includes(Buffer.from(wrapped)), false, "the wrapped key is gone from the file");

  const keys = passkey.passkeysOf(P);
  assert.equal(keys.length, 1);
  // No code path takes a passkey off (review 2026-11-13, L2): removing the last one would bring back a
  // texted yes for purchases. A future removal would have to be built behind a fresh Face ID.
  assert.equal(passkey.removePasskey, undefined, "removePasskey does not exist");
  assert.deepEqual(Object.keys(passkey).filter(k => /remove|delete|drop/i.test(k)), [], "no export takes a passkey off");
  // A passkey marked removed (as an operator would, by hand) signs nothing.
  rdb.db.prepare("UPDATE pay_passkeys SET removed_at = ? WHERE conversation_id = ?").run(Date.now(), P);
  assert.deepEqual(passkey.passkeysOf(P), []);
  assert.equal(passkey.loginAssertionOptions(P).error, "no_passkey");
  const t = await offer("example.test", `${ORIGIN}/signin`, P);
  assert.deepEqual((await pageSave(t, { a: pf })).out, { ok: false, error: "unknown_passkey" }, "a removed passkey signs nothing");
  process.env.REASON_SAVED_LOGINS = "owner";
});

// ---------------------------------------------------------------- the page, over HTTP
const { request: httpRequest } = await import("node:http");
const { createServer } = await import("../src/http.js");
const told = [];
const serverLog = [];
const server = createServer({
  router: { webhook: async () => ({ status: 404, body: {} }), statuses: () => [] },
  runtime: { _tell: async (c, text) => { told.push({ c, text }); return { ok: true }; } },
  log: (e) => serverLog.push(e),
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
after(() => new Promise(r => server.close(r)));
const PORT = server.address().port;
function hit(path, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, method, headers: { ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body || undefined);
  });
}
const FROM_REASON = { origin: "https://heyreason.com", "sec-fetch-site": "same-origin", "content-type": "application/json" };

test("switch off: /web/save-login/<anything> is the same 404 as an unknown path; with it on, an unknown token is too", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const live = await offer();
  process.env.REASON_SAVED_LOGINS = "off";
  const unknown = await hit("/web/no-such-page-anywhere");
  for (const p of [`/web/save-login/${live}`, `/web/save-login/${"A".repeat(32)}`, `/web/save-login/${live}/save`]) {
    const r = await hit(p);
    assert.equal(r.status, unknown.status, p);
    assert.equal(r.body, unknown.body, `${p}: byte for byte`);
  }
  const post = await hit(`/web/save-login/${live}/save`, { method: "POST", headers: FROM_REASON, body: "{}" });
  const postUnknown = await hit("/web/no-such-page-anywhere", { method: "POST", headers: FROM_REASON, body: "{}" });
  assert.equal(post.status, postUnknown.status);
  assert.equal(post.body, postUnknown.body);
  process.env.REASON_SAVED_LOGINS = "owner";
  const r = await hit(`/web/save-login/${"B".repeat(32)}`);
  assert.equal(r.status, unknown.status);
  assert.equal(r.body, unknown.body, "an unknown token: the same 404");
});

test("the page: their request quoted, the sign-in host, the wording; nonce scripts only, no frame, no-store, no-referrer; no typed value", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const token = await offer();
  const r = await hit(`/web/save-login/${token}`);
  assert.equal(r.status, 200);
  const csp = r.headers["content-security-policy"];
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.doesNotMatch(csp.split(";").find(d => d.includes("script-src")), /unsafe-inline|https?:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  const scripts = [...r.body.matchAll(/<script([^>]*)>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 2);
  assert.ok(scripts.every(a => a === ` nonce="${nonce}"`), "every script carries the nonce, none has a src");
  assert.doesNotMatch(r.body, /<iframe|<img[^>]+src="https?:|<link[^>]+href="https?:/i, "no third-party frame, picture or style");
  assert.match(r.body, /&ldquo;pay my example bill&rdquo;/);
  assert.match(r.body, /login\.example\.test/);
  assert.match(r.body, /Save with Face ID/);
  assert.match(r.body, /The AI never sees it/);
  assert.match(r.body, /Sign in whenever a job I ask for needs it/);
  assert.match(r.body, /Ask me with Face ID every time/);
  assert.match(r.body, /This page is heyreason\.com/);
  const boxes = [...r.body.matchAll(/<input[^>]*id="sl-(?:user|pass)"[^>]*>/g)].map(m => m[0]);
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every(b => !/\svalue=/.test(b)), "no login box is ever filled by the server");
  const save = await pageSave(token);
  assert.equal(save.out.ok, true);
  const after = await hit(`/web/save-login/${token}`);
  assert.equal(after.status, 410);
  assert.deepEqual(valuesIn(r.body + after.body), [], "the HTML never holds a typed value");
  intake.forgetSite(ME, "example.test");
});

test("careful site page: Face ID every time only, and the site's warning line above the button", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const token = await offer("delta.com", "https://www.delta.com/login/loginPage");
  const r = await hit(`/web/save-login/${token}`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /value="standing"/);
  assert.match(r.body, /value="each_time" checked/);
  const warn = /<p class="sl-warn">([^<]+)<\/p>/.exec(r.body)?.[1] ?? "";
  assert.ok(warn.startsWith("Delta"), warn);
  assert.ok(r.body.indexOf("sl-warn") < r.body.indexOf('id="sl-go"'), "above the button");
});

test("rule 4 over HTTP: a POST without Origin https://heyreason.com is refused and changes nothing; the right one saves; the log holds no value", async () => {
  process.env.REASON_SAVED_LOGINS = "owner";
  const token = await offer();
  const v = await intake.viewFor(token);
  const sealed = Buffer.from(await intake.sealInBrowser(webcrypto.subtle, Buffer.from(v.publicKey, "base64url"), v.intakeId, PLAIN.username, PLAIN.password, ""));
  const body = JSON.stringify({ sealed: sealed.toString("base64url"), permission: "standing", assertion: face.get(intake.challengeOf(Buffer.from(v.parts.standing, "base64url"), sealed)) });
  for (const headers of [{ "content-type": "application/json" }, { ...FROM_REASON, origin: "https://evil.example" }, { ...FROM_REASON, origin: "null" },
    { ...FROM_REASON, "sec-fetch-site": "cross-site" }, { ...FROM_REASON, origin: "http://heyreason.com" }]) {
    const r = await hit(`/web/save-login/${token}/save`, { method: "POST", headers, body });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal((await intake.viewFor(token)).state, "open", "a refused origin never reaches the link");
  serverLog.length = 0;
  const r = await captured(() => hit(`/web/save-login/${token}/save`, { method: "POST", headers: FROM_REASON, body }));
  assert.equal(r.value.status, 200, r.value.body);
  // `carried`: whether Reason heard about it by itself (src/resume.js); never the request or a grant.
  assert.deepEqual(Object.keys(JSON.parse(r.value.body)).sort(), ["carried", "ok"]);
  assert.equal(JSON.parse(r.value.body).ok, true);
  assert.deepEqual(valuesIn(body), [], "the request carries ciphertext only");
  assert.deepEqual(valuesIn(r.text + JSON.stringify(serverLog)), [], "nothing typed in the server's log");
  assert.ok(serverLog.some(e => e.save_login === "save" && e.ok === true));
  assert.ok(!JSON.stringify(serverLog).includes(sealed.toString("base64url").slice(0, 40)), "not even the sealed blob is logged");
  intake.forgetSite(ME, "example.test");
});

test("no passkey yet: the link proves the browser with a code texted to their thread, then sets up Face ID named Reason, then saves", async () => {
  process.env.REASON_SAVED_LOGINS = "on";
  const P = "dm:intake-newcomer";
  const token = await offer("example.test", `${ORIGIN}/signin`, P);
  const first = await hit(`/web/save-login/${token}`);
  assert.equal(first.status, 200);
  assert.match(first.body, /Text me a code/);
  assert.doesNotMatch(first.body, /id="sl-user"/, "no boxes before Face ID exists");
  const same = { origin: "https://heyreason.com", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
  told.length = 0;
  const sent = await hit(`/web/save-login/${token}/code`, { method: "POST", headers: same, body: "send=1" });
  assert.equal(sent.status, 200);
  assert.equal(told.length, 1);
  assert.equal(told[0].c, P, "the code goes to the thread the link came from");
  const code = /code is (\d{6})/.exec(told[0].text)?.[1];
  assert.ok(code);
  const wrong = await hit(`/web/save-login/${token}/code`, { method: "POST", headers: same, body: "code=000000" });
  assert.equal(wrong.status, 400);
  const ok = await hit(`/web/save-login/${token}/code`, { method: "POST", headers: same, body: `code=${code}` });
  assert.equal(ok.status, 303);
  const cookie = String(ok.headers["set-cookie"]).split(";")[0];
  const setup = await hit(`/web/save-login/${token}`, { headers: { cookie } });
  assert.match(setup.body, /Set up Face ID/);
  const boot = JSON.parse(/var B=(\{.*?\});\n/.exec(setup.body)[1].replace(/\\u003c/g, "<"));
  assert.equal(boot.reg.user.name, "Reason");
  assert.equal(boot.reg.user.displayName, "Reason");
  const a = new Authenticator();
  const noCookie = await hit(`/web/save-login/${token}/passkey`, { method: "POST", headers: FROM_REASON, body: JSON.stringify(a.create(boot.reg)) });
  assert.equal(noCookie.status, 403, "another browser can't add the passkey");
  const reg = await hit(`/web/save-login/${token}/passkey`, { method: "POST", headers: { ...FROM_REASON, cookie }, body: JSON.stringify(a.create(boot.reg)) });
  assert.equal(reg.status, 200, reg.body);
  const form = await hit(`/web/save-login/${token}`, { headers: { cookie } });
  assert.match(form.body, /id="sl-user"/);
  assert.equal((await pageSave(token, { a })).out.ok, true);
  assert.equal(intake.forgetSite(P, "example.test"), 1);
  process.env.REASON_SAVED_LOGINS = "owner";
});

// Review 2026-11-13 (L1): the purchase page's passkey keeps its old names, so with the vault off nothing a
// person sees changes; only the save-login page (which passes its own switch) names it "Reason".
test("passkey names: the purchase page is unchanged; the save-login page names it Reason", async () => {
  const prev = process.env.REASON_PASSKEY_PAY;
  process.env.REASON_PASSKEY_PAY = "on";
  try {
    const pay = await passkey.registrationOptions("dm:names-probe");
    if (pay.ok) {
      assert.equal(pay.options.user.name, "Purchases");
      assert.equal(pay.options.user.displayName, "Reason purchases");
    }
    const login = await passkey.registrationOptions("dm:names-probe", { allowed: true });
    assert.equal(login.ok, true);
    assert.equal(login.options.user.name, "Reason");
    assert.equal(login.options.user.displayName, "Reason");
  } finally { if (prev === undefined) delete process.env.REASON_PASSKEY_PAY; else process.env.REASON_PASSKEY_PAY = prev; }
});
