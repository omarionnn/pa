// The filler in a real browser (vault PR 6): Chromium from node_modules signs in on local fixture
// sites served over HTTPS on 127.0.0.1 under several names (--host-resolver-rules MAP * 127.0.0.1),
// with the stand-in Google KMS holding the vault key. Nothing reaches the internet; every value is
// made up. These prove hard rules 1 (exact origin only), 2 (the secret never leaks), 4 (one refusal
// stops), 5 (a readable line per use) and 9 (off = nothing).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "filler-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "49".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1"; // the browser guard lets 127.0.0.1 through, tests only
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
process.env.REASON_SAVED_LOGINS = "on";

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
useStandIn(g);

const sl = await import("../src/savedlogins.js");
const { Secret } = await import("../src/secret.js");
const filler = await import("../src/filler.js");
const db = await import("../src/db.js");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { /* no browser on this machine */ }

const ME = "dm:owner";
const USER = "filler-tester@example.test";
const PASS = "Stand-in-filler-9Zq!";
const TRIGGER = { kind: "user" }; // a live ask: the person's own message this turn (hard rule 8)

// A self-signed cert for the fixture hosts. Chromium loads it with ignoreHTTPSErrors in the test
// launcher only; the filler's own launch never ignores a certificate error (design B5 step 4).
const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
  "-days", "2", "-nodes", "-subj", "/CN=acme.test", "-addext", "subjectAltName=DNS:acme.test,DNS:acme-login.test,DNS:evil.test"], { stdio: "ignore" });
const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

// ---------------------------------------------------------------- the fixture sites
const FORM = (action) => `<!doctype html><html><head><title>Acme sign in</title></head><body><h1>Sign in to Acme</h1>
  <form method="post" action="${action}">
    <label>Email <input type="email" name="email" autocomplete="username"></label>
    <label>Password <input type="password" name="password" autocomplete="current-password"></label>
    <label><input type="checkbox" name="remember"> Remember this device</label>
    <button type="submit">Sign in</button>
  </form></body></html>`;
const PAGES = {
  ok: () => FORM("/signin"),
  welcome: () => `<!doctype html><html><head><title>Acme</title></head><body><h1>Welcome back</h1><p>You are signed in.</p><a href="/logout">Sign out</a></body></html>`,
  wrongpw: () => FORM("/wrongpw"),
  wrongpw_post: () => `<!doctype html><html><head><title>Acme sign in</title></head><body><h1>Sign in to Acme</h1><p role="alert">Your password was incorrect. Please try again.</p>${FORM("/wrongpw")}</body></html>`,
  wall: () => `<!doctype html><html><head><title>Just a moment…</title></head><body><h1>Checking your browser before you access acme.test</h1><p>This process is automatic. Unusual traffic from your network. Please press and hold to confirm you are a human.</p></body></html>`,
  secondstep: () => FORM("/secondstep"),
  secondstep_post: () => `<!doctype html><html><head><title>Acme</title></head><body><h1>One more step</h1><p>Enter the code we texted you.</p><form method="post"><input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="Verification code"><button type="submit">Verify</button></form></body></html>`,
  crossframe: (origin2) => `<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1><iframe src="${origin2}/pwframe" width="400" height="300"></iframe></body></html>`,
  pwframe: () => `<!doctype html><html><body><form method="post" action="/pwframe"><input type="password" name="password"><button type="submit">Go</button></form></body></html>`,
};

function handler(host) {
  return (req, res) => {
    const u = new URL(req.url, `https://${host}`);
    const send = (code, html, headers = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
    if (req.method === "POST") {
      if (u.pathname === "/signin") return send(200, PAGES.welcome());
      if (u.pathname === "/wrongpw") return send(200, PAGES.wrongpw_post());
      if (u.pathname === "/secondstep") return send(200, PAGES.secondstep_post());
      return send(200, PAGES.welcome());
    }
    switch (u.pathname) {
      case "/signin": return send(200, PAGES.ok());
      case "/welcome": return send(200, PAGES.welcome());
      case "/wrongpw": return send(200, PAGES.wrongpw());
      case "/wall": return send(403, PAGES.wall());
      case "/secondstep": return send(200, PAGES.secondstep());
      case "/crossframe": return send(200, PAGES.crossframe(`https://evil.test:${PORT}`));
      case "/pwframe": return send(200, PAGES.pwframe());
      case "/redir-origin": return redirect(`https://evil.test:${PORT}/signin`);
      case "/redir-look": return redirect(`https://acme-login.test:${PORT}/signin`);
      case "/redir-path": return redirect(`https://acme.test:${PORT}/welcome`);
      case "/redir-port": return redirect(`https://acme.test:${PORT2}/signin`);
      case "/redir-http": return redirect(`http://acme.test:${HTTP_PORT}/signin`);
      default: return send(404, "<p>not found</p>");
    }
  };
}

let server, server2, httpServer, PORT, PORT2, HTTP_PORT, launch;
const skip = { skip: chromium ? false : "playwright/chromium not installed" };

before(async () => {
  if (!chromium) return;
  server = createHttps(tls, handler("acme.test"));
  server2 = createHttps(tls, handler("acme.test"));
  httpServer = createHttp(handler("acme.test"));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  await new Promise(r => server2.listen(0, "127.0.0.1", r));
  await new Promise(r => httpServer.listen(0, "127.0.0.1", r));
  PORT = server.address().port; PORT2 = server2.address().port; HTTP_PORT = httpServer.address().port;
  // The test launcher: the person's own profile dir, but with the fixture cert trusted and every
  // name resolved to loopback. The production launch (src/filler.js realLaunch) has neither.
  const { profileDirFor } = await import("../src/browser.js");
  launch = async ({ conversationId }) => {
    const context = await chromium.launchPersistentContext(profileDirFor(conversationId), {
      headless: true, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true,
      args: ["--host-resolver-rules=MAP * 127.0.0.1", "--disable-smooth-scrolling"],
    });
    return { context, close: async () => { await context.close().catch(() => {}); } };
  };
});
after(async () => {
  await new Promise(r => server ? server.close(r) : r());
  await new Promise(r => server2 ? server2.close(r) : r());
  await new Promise(r => httpServer ? httpServer.close(r) : r());
  await g.close();
  rmSync(dir, { recursive: true, force: true });
});

const S = s => new Secret(Buffer.from(s, "utf8"));
async function save(label, path, over = {}) {
  return sl.saveLogin(ME, {
    site: "acme.test", label, signinOrigin: `https://acme.test:${PORT}`, signinPath: path, permission: "standing",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1", ...over,
  }, { username: S(USER), password: S(PASS), totp: null });
}
const signIn = (over = {}) => filler.signIn(ME, over.site ?? "acme.test", { trigger: TRIGGER, launch, purpose: "check the Acme bill", ...over });
const rowState = (id) => sl.listLogins(ME).find(r => r.id === id)?.state;
const logFor = () => db.db.prepare("SELECT event, outcome, site, kms_calls FROM login_log WHERE conversation_id = ? ORDER BY id").all(ME);

// ---------------------------------------------------------------- rule 9: off is off
test("rule 9: with the switch off the filler signs in to nothing and types nothing", async () => {
  const prev = process.env.REASON_SAVED_LOGINS;
  process.env.REASON_SAVED_LOGINS = "off";
  try {
    const out = await filler.signIn(ME, "acme.test", { trigger: TRIGGER, launch });
    assert.equal(out.ok, false);
    assert.equal(out.result, "no_login");
  } finally { process.env.REASON_SAVED_LOGINS = prev; }
});

// ---------------------------------------------------------------- rule 1: exact origin only
test("rule 1: a login is typed only on its exact pinned origin; six wrong-origin cases each type nothing and call KMS zero times", skip, async () => {
  const cases = [
    ["redirect to another origin", "/redir-origin", "origin_mismatch"],
    ["a look-alike host", "/redir-look", "origin_mismatch"],
    ["the same origin but another path", "/redir-path", "not_signin_page"],
    ["another port", "/redir-port", "origin_mismatch"],
    ["http instead of https", "/redir-http", "origin_mismatch"],
    ["a password box in a cross-origin frame", "/crossframe", "not_signin_page"],
  ];
  const before = g.count("decrypt");
  for (const [why, path, want] of cases) {
    const { id } = await save(`case ${path}`, path);
    const out = await signIn();
    assert.equal(out.result, want, `${why}: expected ${want}, got ${out.result}`);
    assert.equal(out.ok, false, why);
    assert.equal(rowState(id), "unverified", `${why}: the row was not moved`);
    sl.removeLogin(ME, id);
  }
  assert.equal(g.count("decrypt"), before, "no KMS unwrap on any wrong-origin case");
});

// ---------------------------------------------------------------- success, and rule 2 (no leak)
test("a saved login signs in on its exact origin; the row flips unverified -> working; the secret is nowhere to be read (rule 2)", skip, async () => {
  const { id } = await save("Acme", "/signin");
  const beforeDecrypts = g.count("decrypt");
  const out = await signIn();
  assert.equal(out.result, "signed_in", JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(rowState(id), "working", "a success flips the row to working");
  assert.equal(g.count("decrypt"), beforeDecrypts + 1, "exactly one KMS unwrap for one sign-in");

  // Rule 2: the password is in no request body the stand-in saw, no login_log row, and not in the
  // result the model gets. The result sentence names the site, never the login.
  const bodies = g.bodies.join("\n");
  assert.ok(!bodies.includes(PASS) && !bodies.includes(USER), "no field value was ever sent to KMS");
  assert.ok(!JSON.stringify(out).includes(PASS), "the tool result carries no password");
  const logs = logFor();
  assert.ok(!JSON.stringify(logs).includes(PASS) && !JSON.stringify(logs).includes(USER), "the activity log carries no login");
  sl.removeLogin(ME, id);
});

// ---------------------------------------------------------------- rule 5: a readable line per use
test("rule 5: every use writes a readable login_log + ledger line, with no username", skip, async () => {
  const { id } = await save("Acme", "/signin");
  await signIn();
  const mine = db.db.prepare("SELECT event, outcome FROM login_log WHERE conversation_id = ? AND event = 'signin' ORDER BY id DESC LIMIT 1").get(ME);
  assert.equal(mine.outcome, "signed_in");
  const led = db.listActions(ME, { limit: 5 });
  const signinAction = led.find(a => a.action === "saved_login_signin");
  assert.ok(signinAction, "the ledger has a sign-in action");
  assert.equal(signinAction.target, "acme.test", "it names the site");
  assert.ok(!JSON.stringify(signinAction).includes(USER), "the ledger row holds no username");
  sl.removeLogin(ME, id);
});

// ---------------------------------------------------------------- rule 4: one refusal stops
test("rule 4: a wall refuses once and the site is paused; a second call does not load or type (zero KMS)", skip, async () => {
  const { id } = await save("Acme", "/wall");
  const out1 = await signIn();
  assert.equal(out1.result, "blocked");
  assert.equal(rowState(id), "refused", "one refusal marks the row refused");
  const decryptsAfterFirst = g.count("decrypt");
  const out2 = await signIn();
  assert.equal(out2.result, "paused", "a refused site is paused on the next call");
  assert.equal(g.count("decrypt"), decryptsAfterFirst, "the second call does no KMS unwrap");
  sl.removeLogin(ME, id);
});

test("rule 4: a wrong password stops; a second call types nothing until it is saved again", skip, async () => {
  const { id } = await save("Acme", "/wrongpw");
  const out1 = await signIn();
  assert.equal(out1.result, "wrong_password");
  assert.equal(rowState(id), "wrong_password");
  const decryptsAfterFirst = g.count("decrypt");
  const out2 = await signIn();
  assert.equal(out2.result, "wrong_password");
  assert.equal(g.count("decrypt"), decryptsAfterFirst, "no second unwrap once a password was wrong");
  sl.removeLogin(ME, id);
});

// ---------------------------------------------------------------- a second step is reported, never guessed
test("a texted-code step is reported and stops here (PR 7 handles the code)", skip, async () => {
  const { id } = await save("Acme", "/secondstep");
  const out = await signIn();
  assert.equal(out.result, "needs_code_sms");
  assert.equal(out.ok, false);
  sl.removeLogin(ME, id);
});
