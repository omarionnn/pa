// The save page in a real browser (vault PR 5): Chromium from node_modules, a CDP virtual
// authenticator for Face ID (WebAuthn.addVirtualAuthenticator, user verification on), the page's own
// script sealing the boxes with the browser's WebCrypto, and the stand-in Google KMS on 127.0.0.1
// holding the intake key. The passkey's origin is this loopback server's (localhost is a secure
// context), set the way REASON_PASSKEY_ORIGIN sets it live. Nothing reaches Google; values are made up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "savelogin-browser-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "47".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
delete process.env.REASON_PUBLIC_URL;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "owner";

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
useStandIn(g);

const intake = await import("../src/loginintake.js");
const sl = await import("../src/savedlogins.js");
const passkey = await import("../src/passkey.js");
const { createServer } = await import("../src/http.js");
const { chromium } = await import("playwright");

const ME = "dm:owner";
const PLAIN = { username: "browser-tester@example.test", password: "Stand-in-browser-4Kp!" };
const serverLog = [];
let server, base, browser;

before(async () => {
  server = createServer({ router: { webhook: async () => ({ status: 404, body: {} }), statuses: () => [] }, runtime: null, log: (e) => serverLog.push(e) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}`;
  process.env.REASON_PASSKEY_ORIGIN = base;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise(r => server.close(r));
  await g.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a person types a login on the page, taps Save with Face ID, and one unverified login is stored; the requests carry ciphertext only", async () => {
  const out = await intake.offerSaveLink(ME, "example.test", "pay my example bill", { locate: async () => ({ found: true, url: "https://login.example.test/signin", form: "password" }) });
  assert.equal(out.ok, true, out.error);
  const path = new URL(out.link).pathname;

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const posted = [];
  page.on("request", (r) => { if (r.method() === "POST") posted.push(r.postData() ?? ""); });

  // Face ID set up first (the page's own setup step needs the texted-code proof, covered in test/savelogin.test.js).
  await page.goto(`${base}${path}`);
  const reg = await passkey.registrationOptions(ME, { allowed: true });
  const made = await page.evaluate(async (o) => {
    const b2u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const u2b = (x) => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const c = await navigator.credentials.create({ publicKey: { rp: o.rp, user: { id: b2u(o.user.id), name: o.user.name, displayName: o.user.displayName }, challenge: b2u(o.challenge), pubKeyCredParams: o.pubKeyCredParams, authenticatorSelection: o.authenticatorSelection, attestation: "none" } });
    return { id: c.id, rawId: u2b(c.rawId), type: c.type, response: { clientDataJSON: u2b(c.response.clientDataJSON), attestationObject: u2b(c.response.attestationObject), transports: c.response.getTransports() }, clientExtensionResults: {} };
  }, reg.options);
  assert.equal((await passkey.register(ME, made, { allowed: true, for: "login" })).ok, true);

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}${path}`);
  await page.getByText("“pay my example bill”").waitFor();
  const go = page.locator("#sl-go");
  assert.equal(await go.isDisabled(), true, "nothing to save until both boxes are filled");
  await page.fill("#sl-user", PLAIN.username);
  await page.fill("#sl-pass", PLAIN.password);
  await page.waitForFunction(() => !document.getElementById("sl-go").disabled);
  await go.click();
  // `saved` when Reason heard by itself, `savedq` (the button types "saved it, go ahead") when it couldn't.
  await page.locator('[data-step^="saved"]:not(.pf-off)').waitFor({ timeout: 15_000 });
  assert.deepEqual(errors.filter(e => !/Failed to load resource: .* 404/.test(e)), [], "no script error (icons and fonts 404 with Web off here)");

  const saved = sl.listLogins(ME);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, "unverified");
  assert.equal(saved[0].signin_origin, "https://login.example.test");
  assert.equal(g.count("asymmetricDecrypt", true), 1);
  const seen = await sl.withLogin(ME, saved[0].id, "https://login.example.test", (f) => [f.username.use(b => b.toString()), f.password.use(b => b.toString())]);
  assert.deepEqual(seen, [PLAIN.username, PLAIN.password], "what was typed is what the vault holds");
  const wire = posted.join("\n") + JSON.stringify(serverLog);
  for (const v of Object.values(PLAIN)) assert.equal(wire.includes(v) || wire.includes(Buffer.from(v).toString("base64")), false, "the requests and the server log carry ciphertext only");
  assert.equal(await page.inputValue("#sl-pass"), "", "the boxes are emptied after the save");
  await ctx.close();
});
