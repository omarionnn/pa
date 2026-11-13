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
  secondstep_post: (how = "we texted you", bad = false) => `<!doctype html><html><head><title>Acme</title></head><body><h1>One more step</h1>${bad ? `<p role="alert">That code is wrong or expired.</p>` : ""}<p>Enter the code ${how}.</p><form method="post"><input type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="Verification code"><button type="submit">Verify</button></form></body></html>`,
  home: (signedIn) => signedIn
    ? `<!doctype html><html><head><title>Acme</title></head><body><h1>Your Acme account</h1><a href="/logout">Sign out</a></body></html>`
    : `<!doctype html><html><head><title>Acme</title></head><body><h1>Acme</h1><a href="/signin">Sign in</a></body></html>`,
  crossframe: (origin2) => `<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1><iframe src="${origin2}/pwframe" width="400" height="300"></iframe></body></html>`,
  pwframe: () => `<!doctype html><html><body><form method="post" action="/pwframe"><input type="password" name="password"><button type="submit">Go</button></form></body></html>`,
};

function handler(host) {
  return (req, res) => {
    const u = new URL(req.url, `https://${host}`);
    const send = (code, html, headers = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(html); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
    const SESSION = { "set-cookie": "acme_sid=s3ss10n; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax" };
    const signedIn = /(?:^|;\s*)acme_sid=s3ss10n/.test(String(req.headers.cookie ?? ""));
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        if (form.get("password") != null) posted.push({ port: req.socket.localPort, path: u.pathname, password: form.get("password") });
        const code = form.get("code");
        const how = { "/secondstep": "we texted you", "/emailstep": "we emailed you", "/authstep": "from your authenticator app" }[u.pathname];
        if (how && code == null) return send(200, PAGES.secondstep_post(how));
        if (how) { codesTyped.push(code); return code === GOOD_CODE ? send(200, PAGES.welcome(), SESSION) : send(200, PAGES.secondstep_post(how, true)); }
        if (u.pathname === "/wrongpw") return send(200, PAGES.wrongpw_post());
        return send(200, PAGES.welcome(), SESSION);
      });
      return;
    }
    switch (u.pathname) {
      case "/": return send(200, PAGES.home(signedIn));
      case "/logout": return send(200, PAGES.home(false), { "set-cookie": "acme_sid=; Path=/; Secure; Max-Age=0" });
      case "/emailstep": case "/authstep": return send(200, FORM(u.pathname));
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
      // Review 2026-11-13 (H1): the page passes the origin check, then, as the username is typed, takes its
      // password box away and sends the tab to another origin of the same site (another port, or http).
      // If that load is allowed, the filler's next box is the other origin's. If refused, the box comes back here.
      case "/hop-port": case "/hop-http": {
        const to = u.pathname === "/hop-port" ? `https://acme.test:${PORT2}/signin` : `http://acme.test:${HTTP_PORT}/signin`;
        return send(200, FORM("/signin").replace("</body>", `<script>
          var e = document.querySelector('input[name=email]'), done = false;
          e.addEventListener('input', function () { if (done) return; done = true;
            var p = document.querySelector('input[type=password]'), parent = p.parentNode; p.remove();
            location.href = ${JSON.stringify(to)};
            setTimeout(function () { parent.appendChild(p); }, 700); });
        </script></body>`));
      }
      default: return send(404, "<p>not found</p>");
    }
  };
}

let server, server2, httpServer, PORT, PORT2, HTTP_PORT, launch;
const GOOD_CODE = "482913";
const codesTyped = [];
const posted = []; // every password a fixture server received: { port, path, password }
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
  // One login per test: whatever an earlier test left (a failure before its cleanup) goes first.
  for (const r of sl.listLogins(ME)) sl.removeLogin(ME, r.id);
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

// Review 2026-11-13 (H1): the check right before the keystroke. A navigation to another origin of the
// same site between the check and the password box must never get the password typed or sent there.
test("rule 1 at the keystroke: a page that hops to another port or to http after the check never gets the password", skip, async () => {
  for (const [why, path, other] of [["another port", "/hop-port", () => PORT2], ["http", "/hop-http", () => HTTP_PORT]]) {
    const { id } = await save(`hop ${path}`, path);
    posted.length = 0;
    const out = await signIn();
    const elsewhere = posted.filter(p => p.port === other());
    assert.deepEqual(elsewhere.map(p => p.path), [], `${why}: the password reached the other origin`);
    assert.ok(posted.every(p => p.port === PORT), `${why}: only the pinned origin ever received a password`);
    assert.equal(out.ok, out.result === "signed_in");
    sl.removeLogin(ME, id);
  }
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

// ---------------------------------------------------------------- slice 2: the second step, never guessed
// A promise the test settles: the person's texted reply, taken at intake (src/signinemail.js).
function replyLater() {
  let give; const asked = [];
  const awaitReply = (c, entry) => { asked.push(entry.site); return new Promise(r => { give = r; }); };
  return { awaitReply, asked, give: (v) => give(v) };
}
function noted() {
  const lines = []; let done; const end = new Promise(r => { done = r; });
  return { note: (c, text) => { lines.push(text); done(text); }, lines, end };
}

test("a texted code: asked once, their reply typed once, and the end told in the thread", skip, async () => {
  const { id } = await save("Acme", "/secondstep");
  const r = replyLater(), n = noted();
  codesTyped.length = 0;
  const out = await signIn({ awaitReply: r.awaitReply, note: n.note });
  assert.equal(out.result, "needs_code_sms");
  assert.equal(out.ok, false);
  assert.match(out.say_exactly, /texted a code/);
  assert.deepEqual(r.asked, ["acme.test"], "asked once");
  r.give(GOOD_CODE);
  const said = await n.end;
  assert.deepEqual(codesTyped, [GOOD_CODE], "the code was typed once");
  assert.match(said, /ended: signed_in/);
  assert.ok(!said.includes(GOOD_CODE) && !JSON.stringify(out).includes(GOOD_CODE), "the code is in no result and no note");
  assert.equal(rowState(id), "working");
  sl.removeLogin(ME, id);
});

test("a texted code that is wrong: one attempt, then it stops (wrong_code), never a second guess", skip, async () => {
  const { id } = await save("Acme", "/secondstep");
  const r = replyLater(), n = noted();
  codesTyped.length = 0;
  await signIn({ awaitReply: r.awaitReply, note: n.note });
  r.give("000000");
  const said = await n.end;
  assert.match(said, /ended: wrong_code/);
  assert.deepEqual(codesTyped, ["000000"], "exactly one attempt");
  assert.equal(rowState(id), "unverified", "a wrong code does not mark the login bad");
  // Review 2026-11-13 (M1): the login was typed and the sign-in did not finish, so it rests a day. A
  // re-call by the model is paused: no page load, no unwrap, no second password, no second code.
  const decrypts = g.count("decrypt");
  let launched = 0;
  const again = await signIn({ launch: async (a) => { launched++; return launch(a); }, awaitReply: r.awaitReply, note: n.note });
  assert.equal(again.result, "paused");
  assert.equal(launched, 0, "no browser was opened");
  assert.equal(g.count("decrypt"), decrypts, "no second unwrap");
  assert.ok(sl.peekForSignin(ME, "acme.test")[0].next_try_at > Date.now() + 23 * 3600_000, "rests about a day");
  sl.removeLogin(ME, id);
});

test("forget while a texted code is on its way: the code is never typed and the login does not finish signing in (M2)", skip, async () => {
  const br = await import("../src/browser.js");
  const { id } = await save("Acme", "/secondstep");
  const r = replyLater(), n = noted();
  codesTyped.length = 0;
  const out = await signIn({ awaitReply: r.awaitReply, note: n.note });
  assert.equal(out.result, "needs_code_sms");
  const gone = await filler.forgetLogin(ME, "acme.test", { launch });
  assert.equal(gone.removed, 1);
  r.give(GOOD_CODE);
  for (let i = 0; i < 100 && br.profileBusy(ME); i++) await new Promise(res => setTimeout(res, 50));
  assert.equal(br.profileBusy(ME), null, "the wait closed its browser");
  assert.deepEqual(codesTyped, [], "the code was not typed after the forget");
  assert.deepEqual(n.lines, [], "no 'ended' line about a login they deleted");
  assert.equal(br.pinnedSite(ME), null);
  assert.equal(sl.listLogins(ME).some(l => l.id === id), false);
});

test("an emailed code is read by the existing emailed-code reader and typed once; not found stops", skip, async () => {
  const { id } = await save("Acme", "/emailstep");
  const reads = [];
  codesTyped.length = 0;
  const found = async (c, entry) => { reads.push(entry.signin_url); return { connected: true, found: true, kind: "code", code: GOOD_CODE }; };
  const out = await signIn({ emailCode: found });
  assert.equal(out.result, "signed_in", JSON.stringify(out));
  assert.equal(reads.length, 1, "the reader is asked once");
  assert.ok(reads[0].startsWith(`https://acme.test:${PORT}/emailstep`), "for the pinned site only");
  assert.deepEqual(codesTyped, [GOOD_CODE]);
  sl.removeLogin(ME, id);

  const { id: id2 } = await save("Acme", "/emailstep");
  codesTyped.length = 0;
  const out2 = await signIn({ emailCode: async () => ({ connected: true, found: false }) });
  assert.equal(out2.result, "code_not_found");
  assert.deepEqual(codesTyped, [], "nothing guessed");
  sl.removeLogin(ME, id2);
});

test("an authenticator code is not supported yet: it says so and types nothing", skip, async () => {
  const { id } = await save("Acme", "/authstep");
  codesTyped.length = 0;
  let entered = 0;
  const out = await signIn({ enter: async () => { entered++; return { ok: true }; }, awaitReply: async () => { entered++; return null; } });
  assert.equal(out.result, "needs_authenticator");
  assert.match(out.say_exactly, /authenticator app/);
  assert.equal(entered, 0);
  assert.deepEqual(codesTyped, []);
  sl.removeLogin(ME, id);
});

// ---------------------------------------------------------------- slice 2: Face ID before every use
test("each-time and careful logins need a fresh Face ID before every use; one approval is one sign-in", skip, async () => {
  const use = await import("../src/loginuse.js");
  const { id } = await save("Acme", "/signin", { permission: "each_time" });
  let launches = 0;
  const counted = async (a) => { launches++; return launch(a); };
  const before = g.count("decrypt");
  const out1 = await signIn({ launch: counted });
  assert.equal(out1.result, "needs_face_id");
  const link = /\/web\/login-use\/([A-Za-z0-9_-]{32})/.exec(out1.say_exactly);
  assert.ok(link, "say_exactly carries the approval link");
  assert.equal(launches, 0, "nothing opened before Face ID");
  assert.equal(g.count("decrypt"), before, "no KMS before Face ID");
  // A failed Face ID approves nothing.
  assert.equal((await use.approveUse(link[1], {}, { verify: async () => ({ ok: false, error: "not_verified" }) })).ok, false);
  assert.equal((await signIn({ launch: counted })).result, "needs_face_id");
  // Approve the newest link, then one sign-in goes through; the next needs Face ID again.
  const fresh = /\/web\/login-use\/([A-Za-z0-9_-]{32})/.exec((await signIn({ launch: counted })).say_exactly)[1];
  const seen = [];
  assert.equal((await use.approveUse(fresh, {}, { verify: async (c, ch) => { seen.push([c, ch]); return { ok: true }; } })).ok, true);
  assert.equal(seen[0][0], ME);
  assert.match(seen[0][1], /^[A-Za-z0-9_-]{43}$/, "Face ID signs a challenge bound to this login");
  const out2 = await signIn({ launch: counted });
  assert.equal(out2.result, "signed_in", JSON.stringify(out2));
  assert.equal(launches, 1);
  assert.equal((await signIn({ launch: counted })).result, "needs_face_id", "no standing permission: the next use asks again");
  sl.removeLogin(ME, id);

  // A careful site asks for Face ID even on a standing login, before anything opens.
  const { id: cid } = await sl.saveLogin(ME, {
    site: "united.com", label: "United", signinOrigin: "https://www.united.com", signinPath: "/login", permission: "each_time",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1",
  }, { username: S(USER), password: S(PASS), totp: null });
  const out3 = await filler.signIn(ME, "united.com", { trigger: TRIGGER, launch: counted });
  assert.equal(out3.result, "needs_face_id");
  assert.equal(launches, 1, "a careful site opens nothing without Face ID");
  sl.removeLogin(ME, cid);
});

// ---------------------------------------------------------------- slice 2: the live-ask gate
test("an event turn (email, page, timer, nightly) never uses a saved login: refused, nothing opened, zero KMS", skip, async () => {
  const { id } = await save("Acme", "/signin");
  let launches = 0;
  const before = g.count("decrypt");
  for (const trigger of [{ kind: "event" }, null, {}, { kind: "nightly" }]) {
    const out = await filler.signIn(ME, "acme.test", { trigger, launch: async (a) => { launches++; return launch(a); } });
    assert.equal(out.ok, false);
    assert.match(out.say_exactly, /when you ask me in the moment/);
  }
  assert.equal(launches, 0);
  assert.equal(g.count("decrypt"), before);
  sl.removeLogin(ME, id);
});

test("a tapped Action Card counts as a live ask: the tap types its prefill and the turn runs as the person's own message", async () => {
  // The page's tap opens Messages with the card's prefill typed in (src/pages/actioncards.js); the
  // person sends it, the router matches the card and runs the turn through runtime.inbound, which
  // is a kind "user" turn. No turn-origin marker is needed and the gate is not widened.
  const page = readFileSync(new URL("../src/pages/actioncards.js", import.meta.url), "utf8");
  assert.match(page, /A tap opens Messages with the request typed in/);
  const router = readFileSync(new URL("../src/channels/router.js", import.meta.url), "utf8");
  const hit = router.indexOf("cardHit = actioncards.matchInbound(");
  const turn = router.indexOf("reply = await this.runtime.inbound(conversationId, userText", hit);
  assert.ok(hit > 0 && turn > hit, "a matched card's text runs as an inbound turn");
  const { Runtime } = await import("../src/runtime.js");
  const seen = [];
  const rt = Object.create(Runtime.prototype);
  rt._turn = async (args) => { seen.push(args.kind); return null; };
  rt.log = () => {};
  await rt.inbound(ME, "Pay my Acme bill", {}).catch(() => {});
  assert.deepEqual(seen, ["user"], "runtime.inbound is a user turn");
  assert.equal(filler.liveAskOk({ kind: seen[0] }), true, "and the gate lets it through");
  assert.equal(filler.liveAskOk({ kind: "event" }), false);
});

// ---------------------------------------------------------------- slice 2: the same-site lock
test("during a signed-in job the browser stays on the pinned site; the profile lock is held and released", skip, async () => {
  const br = await import("../src/browser.js");
  const { id } = await save("Acme", "/signin");
  let heldDuring = null;
  const out = await signIn({ launch: async (a) => { heldDuring = br.profileBusy(ME); return launch(a); } });
  assert.equal(out.result, "signed_in");
  assert.equal(heldDuring?.busy, "signing_in", "the profile lock is held during the sealed step");
  assert.equal(br.profileBusy(ME), null, "and released after (finally)");
  assert.equal(br.pinnedSite(ME), "acme.test");
  assert.equal(br.offPinnedSite(ME, `https://evil.test:${PORT}/`), true);
  assert.equal(br.offPinnedSite(ME, `https://acme-login.test:${PORT}/`), true, "a look-alike is off the site");
  assert.equal(br.offPinnedSite(ME, `https://acme.test:${PORT}/welcome`), false);
  // In a real browser guarded for this person: the other site's page load is refused by the browser.
  const s = await launch({ conversationId: "dm:pin-probe" });
  try {
    br.pinSite("dm:pin-probe", "acme.test");
    await br.guardContext(s.context, { conversationId: "dm:pin-probe" });
    const p = s.context.pages()[0] ?? await s.context.newPage();
    await p.goto(`https://acme.test:${PORT}/welcome`);
    assert.match(await p.textContent("h1"), /Welcome back/);
    await assert.rejects(p.goto(`https://evil.test:${PORT}/signin`), /ERR_BLOCKED_BY_CLIENT/);
  } finally { br.unpinSite("dm:pin-probe"); await s.close(); }
  // browser_open says so in fixed words, before any page is touched.
  assert.match(br.OFF_SITE_WORDS("acme.test"), /stay on acme\.test/);
  br.unpinSite(ME);
  sl.removeLogin(ME, id);
});

// ---------------------------------------------------------------- slice 2: forget really signs out and deletes
test("forget: signs out on the site, clears its cookies, deletes the row and key from the file's bytes, and writes the line", skip, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { id } = await save("Acme Forget Me", "/signin");
  assert.equal((await signIn()).result, "signed_in");
  // The session cookie is in the person's profile now.
  const cookiesNow = async () => { const b = await launch({ conversationId: ME }); try { return await b.context.cookies(); } finally { await b.close(); } };
  assert.ok((await cookiesNow()).some(k => k.name === "acme_sid"), "signed in: the site's cookie is there");
  const file = sl.loginsDbPath();
  const ro = new DatabaseSync(file, { readOnly: true });
  const { wrapped_key: wrapped } = ro.prepare("SELECT wrapped_key FROM saved_logins WHERE id = ?").get(id);
  ro.close();
  assert.ok(readFileSync(file).includes(Buffer.from(wrapped)), "the wrapped key is in the file before");

  const out = await filler.forgetLogin(ME, "acme.test", { launch });
  assert.equal(out.removed, 1);
  assert.equal(out.signed_out, true, "the site's own Sign out link was used and it took");
  assert.equal(out.cleared, true);
  assert.match(out.say_exactly, /deleted your saved login for acme\.test/);
  assert.match(out.say_exactly, /signed out on acme\.test/);
  assert.ok(!(await cookiesNow()).some(k => /acme\.test$/.test(k.domain.replace(/^\./, ""))), "no cookie for the site is left in the profile");
  assert.equal(sl.listLogins(ME).some(r => r.id === id), false, "the row is gone");
  const bytes = readFileSync(file);
  assert.ok(!bytes.includes(Buffer.from(wrapped)), "the wrapped key is gone from the file's bytes");
  assert.ok(!bytes.includes(Buffer.from("Acme Forget Me")), "and the row's label");
  const lines = db.db.prepare("SELECT event, outcome FROM login_log WHERE conversation_id = ? AND event IN ('removed', 'signed_out') ORDER BY id DESC LIMIT 2").all(ME);
  assert.deepEqual(lines.map(l => `${l.event}:${l.outcome}`).sort(), ["removed:ok", "signed_out:ok"]);
  assert.ok(db.listActions(ME, { limit: 5 }).some(a => a.action === "saved_login_signed_out"), "the activity line is in the ledger");
});

test("forget says plainly what it could not confirm when the site shows no sign-out link", skip, async () => {
  const { id } = await save("Acme", "/signin");
  const out = await filler.forgetLogin(ME, "acme.test", { launch }); // never signed in: no Sign out link on /
  assert.equal(out.removed, 1);
  assert.equal(out.signed_out, false);
  assert.match(out.say_exactly, /couldn't confirm a sign-out on acme\.test itself/);
  assert.equal(sl.listLogins(ME).some(r => r.id === id), false);
});

// ---------------------------------------------------------------- slice 2: the attempt log names the route
test("signinlog: the attempt log names the saved-login routes", skip, async () => {
  const log = await import("../src/signinlog.js");
  assert.ok(log.ROUTES.includes("saved_login") && log.ROUTES.includes("saved_login_again"));
  log._resetAttempts();
  const { id } = await save("Acme", "/signin");
  await signIn();
  await signIn();
  const routes = log.recentAttempts().map(l => `${l.route}:${l.outcome}`);
  assert.deepEqual(routes, ["saved_login:signed_in", "saved_login_again:signed_in"]);
  assert.ok(!JSON.stringify(log.recentAttempts()).includes(USER));
  sl.removeLogin(ME, id);
});
