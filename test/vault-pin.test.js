// The save link's pin and the filler, in a real browser (2026-11-13: the first real saved-login sign-in,
// Netflix, failed with not_signin_page because the offer pinned the site's HOME page: its one box is a
// sign-up email box, which read as a sign-in form, so the site's own "Sign In" link was never followed).
// Fixture sites are served over HTTPS on 127.0.0.1 through a local CONNECT proxy, so the browser sees
// real port-less https origins (https://acme.test) exactly as on the internet. Every value is made up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "vault-pin-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "4a".repeat(32);
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
process.env.REASON_SIGNIN_FORM_WAIT_MS = "4000";
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
const browser = await import("../src/browser.js");
const sp = await import("../src/signinpage.js");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { /* no browser on this machine */ }

const ME = "dm:owner";
const USER = "pin-tester@example.test";
const PASS = "Stand-in-pin-7Wq!";
const TRIGGER = (site) => ({ kind: "user", messages: [{ role: "user", content: `[Fri 9:02am] sign in to ${site} and check my plan` }] });

const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
  "-days", "2", "-nodes", "-subj", "/CN=acme.test", "-addext", "subjectAltName=DNS:*.test,DNS:acme.test"], { stdio: "ignore" });
const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

// ---------------------------------------------------------------- the fixture sites
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
// A streaming site's home page: a sign-UP email box, and the site's own "Sign In" link. No password box.
const HOME = (to) => page("Watch anything", `<header><a href="${to}">Sign In</a></header>
  <h1>Unlimited films and more</h1><p>Ready to watch? Enter your email to create or restart your membership.</p>
  <form action="/signup"><label>Email address <input type="email" name="email" autocomplete="email"></label><button type="submit">Get Started</button></form>`);
const FORM = (action) => page("Sign In", `<h1>Sign In</h1><form method="post" action="${action}">
  <label>Email or mobile number <input type="text" name="userLoginId" autocomplete="username"></label>
  <label>Password <input type="password" name="password" autocomplete="current-password"></label>
  <button type="submit">Sign In</button></form>`);
const EMAIL_STEP = (action, script = "") => page("Sign in", `<h1>Sign in</h1><form method="post" action="${action}">
  <label>Email <input type="email" name="email" autocomplete="username"></label><button type="submit">Continue</button></form>${script}`);
const PASSWORD_STEP = (action, ac = "current-password") => page("Enter your password", `<h1>Enter your password</h1><form method="post" action="${action}">
  <label>Password <input type="password" name="password" autocomplete="${ac}"></label><button type="submit">Sign in</button></form>`);
const WELCOME = page("Your account", `<h1>Who's watching?</h1><a href="/logout">Sign out</a>`);

const posted = []; // { host, path, field } for every POST carrying a username or a password
function handler(scheme) {
  return (req, res) => {
    const host = String(req.headers.host ?? "").toLowerCase();
    const u = new URL(req.url, `${scheme}://${host}`);
    const send = (code, html) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
    const site = host.replace(/:\d+$/, "");
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        const f = new URLSearchParams(raw);
        for (const k of ["password", "email", "userLoginId"]) if (f.get(k) != null) posted.push({ scheme, host, path: u.pathname, field: k });
        if (u.pathname === "/signin" && site.startsWith("ef")) {
          const next = { "ef.test": "/signin/password", "ef-port.test": "https://ef-port.test:8443/signin/password",
            "ef-http.test": "http://ef-http.test/signin/password", "ef-other.test": "https://evil.test/signin/password",
            "ef-new.test": "/signin/create" }[site];
          return redirect(next);
        }
        return send(200, WELCOME);
      });
      return;
    }
    const routes = {
      "acme.test": { "/": () => send(200, HOME("/login")), "/login": () => send(200, FORM("/login")) },
      "locale.test": { "/": () => send(200, HOME("/login")), "/login": () => redirect("/us/login"), "/us/login": () => send(200, FORM("/us/login")) },
      "nolink.test": { "/": () => send(200, HOME("#").replace(/<header>.*?<\/header>/s, "")) },
      "offsite.test": { "/": () => send(200, HOME("https://idp-elsewhere.test/login")) },
      "wall.test": { "/": () => send(403, page("Just a moment…", "<h1>Checking your browser before you access wall.test</h1><p>Unusual traffic from your network.</p>")) },
      "evil.test": { "/signin/password": () => send(200, PASSWORD_STEP("/steal")) },
      "ef-early.test": { "/": () => send(200, HOME("/signin")), "/signin/password": () => send(200, PASSWORD_STEP("/signin/password")),
        // The page sends the tab to its own password step the moment the email is typed: a navigation
        // the filler did not cause (it has not submitted anything yet).
        "/signin": () => send(200, EMAIL_STEP("/signin", `<script>document.querySelector('input[name=email]').addEventListener('input', function () { location.href = '/signin/password'; }, { once: true });</script>`)) },
    };
    for (const s of ["ef.test", "ef-port.test", "ef-http.test", "ef-other.test", "ef-new.test"]) {
      routes[s] = { "/": () => send(200, HOME("/signin")), "/signin": () => send(200, EMAIL_STEP("/signin")),
        "/signin/password": () => send(200, PASSWORD_STEP("/signin/password")), "/signin/create": () => send(200, PASSWORD_STEP("/signin/create", "new-password")) };
    }
    const fn = routes[site]?.[u.pathname];
    return fn ? fn() : send(404, "<p>not found</p>");
  };
}

let https1, https2, http1, proxy, launch, findLaunch;
const skip = { skip: chromium ? false : "playwright/chromium not installed" };
const listen = (s) => new Promise(r => s.listen(0, "127.0.0.1", () => r(s.address().port)));

before(async () => {
  if (!chromium) return;
  https1 = createHttps(tls, handler("https")); https2 = createHttps(tls, handler("https")); http1 = createHttp(handler("http"));
  const [P1, P2, PH] = [await listen(https1), await listen(https2), await listen(http1)];
  // The CONNECT proxy: any host's :443 is the first https server, :8443 the second (another origin of
  // the same host), and a plain http request goes to the http server.
  proxy = createHttp(handler("http")); // a plain http request through the proxy: the http site
  proxy.on("connect", (req, sock, head) => {
    const port = String(req.url).split(":").pop() === "8443" ? P2 : P1;
    const t = connect(port, "127.0.0.1", () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); t.write(head); t.pipe(sock); sock.pipe(t); });
    t.on("error", () => sock.destroy()); sock.on("error", () => t.destroy());
  });
  const PP = await listen(proxy);
  const opts = { headless: true, proxy: { server: `http://127.0.0.1:${PP}` } };
  // The filler's launcher: the person's own profile dir, the fixture cert trusted. Production has neither.
  launch = async ({ conversationId }) => {
    const context = await chromium.launchPersistentContext(browser.profileDirFor(conversationId), { ...opts, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
    return { context, close: async () => { await context.close().catch(() => {}); } };
  };
  // The offer's look-up: a throwaway browser, as in production.
  findLaunch = async () => {
    const b = await chromium.launch(opts);
    const context = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    return { context, close: () => b.close() };
  };
});
after(async () => {
  for (const s of [https1, https2, http1, proxy]) if (s) { s.closeAllConnections?.(); await new Promise(r => s.close(r)); }
  await g.close();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (site) => ({ site, label: site, signin_url: `https://${site}/`, generic: true });
const find = (site) => browser.findLoginForm(entry(site), { launch: findLaunch, waitMs: 4000 });
const S = s => new Secret(Buffer.from(s, "utf8"));
async function save(site, url) {
  for (const r of sl.listLogins(ME)) sl.removeLogin(ME, r.id);
  const u = new URL(url);
  return sl.saveLogin(ME, {
    site, label: site, signinOrigin: u.origin, signinPath: u.pathname, permission: "standing",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1",
  }, { username: S(USER), password: S(PASS), totp: null });
}
const signIn = (site) => filler.signIn(ME, site, { trigger: TRIGGER(site), launch, purpose: "check the plan" });
const passwordsTo = () => posted.filter(p => p.field === "password");

// ---------------------------------------------------------------- the pure rule
test("loginFormOf: a sign-up email box on a home page is not a sign-in form; a password box is; email-first only on a sign-in path", () => {
  const f = (type, extra = {}) => ({ type, ac: "", name: "", id: "", label: "", ...extra });
  const home = { url: "https://www.netflix.example/", text: "Enter your email to create or restart your membership.", fields: [f("email", { label: "Email address" })] };
  assert.equal(sp.pageKind(home), "signin_form", "pageKind (the emailed-code route's reading) still calls it a form");
  assert.equal(sp.loginFormOf(home), null, "but no saved login is ever pinned to it");
  assert.equal(sp.loginFormOf({ ...home, url: "https://www.netflix.example/us/" }), null, "not a sign-in path either");
  assert.equal(sp.loginFormOf({ url: "https://a.test/login", fields: [f("text", { label: "Email or mobile number" }), f("password")] }), "password");
  assert.equal(sp.loginFormOf({ url: "https://a.test/", fields: [f("email"), f("password")] }), "password", "a home page that carries the real form is fine");
  assert.equal(sp.loginFormOf({ url: "https://a.test/signin", fields: [f("email")] }), "email_first");
  assert.equal(sp.loginFormOf({ url: "https://a.test/us/login", fields: [f("text", { ac: "username" })] }), "email_first");
  assert.equal(sp.loginFormOf({ url: "https://a.test/join", fields: [f("password", { ac: "new-password" })] }), null, "making an account");
  assert.equal(sp.loginFormOf({ url: "https://a.test/login", fields: [f("password", { ac: "new-password" })] }), null);
  assert.equal(sp.loginFormOf({ url: "https://a.test/login", fields: [f("password"), f("password")] }), null, "two password boxes");
  assert.equal(sp.loginFormOf({ url: "https://a.test/login", fields: [f("email"), f("tel")] }), null);
  assert.equal(sp.loginFormOf({ url: "https://a.test/login", fields: [] }), null);
});

// ---------------------------------------------------------------- the pin, in a real browser
test("the pin: the home page's sign-up box is passed by; the site's own Sign In link is followed to the page that has the form", skip, async () => {
  const at = await find("acme.test");
  assert.equal(at.found, true, JSON.stringify(at));
  assert.equal(at.url, "https://acme.test/login");
  assert.equal(at.form, "password");
  assert.equal(at.followed, true);
});

test("the pin: a sign-in link that redirects to a locale path pins the final page", skip, async () => {
  const at = await find("locale.test");
  assert.equal(at.found, true, JSON.stringify(at));
  assert.equal(at.url, "https://locale.test/us/login");
  assert.equal(at.form, "password");
});

test("the pin: an email-first sign-in page is pinned as one", skip, async () => {
  const at = await find("ef.test");
  assert.deepEqual([at.found, at.url, at.form], [true, "https://ef.test/signin", "email_first"]);
});

test("no form, no pin: no sign-in link, a link to another company's site, a wall: each says why and pins nothing", skip, async () => {
  for (const [site, why] of [["nolink.test", "no_form"], ["offsite.test", "off_site"], ["wall.test", "wall"]]) {
    const at = await find(site);
    assert.equal(at.found, false, site);
    assert.equal(at.url, "", site);
    assert.equal(at.why, why, site);
  }
});

// ---------------------------------------------------------------- the filler at the pinned page
test("the filler signs in on the page the pin found (the home page passed by, the link followed)", skip, async () => {
  posted.length = 0;
  for (const site of ["acme.test", "locale.test"]) {
    const at = await find(site);
    await save(site, at.url);
    const out = await signIn(site);
    assert.equal(out.result, "signed_in", `${site}: ${out.say_exactly}`);
  }
  assert.deepEqual(passwordsTo().map(p => `${p.scheme}://${p.host}${p.path}`), ["https://acme.test/login", "https://locale.test/us/login"]);
});

test("repair: a login pinned to a home page with no sign-in form types nothing and says it needs saving again", skip, async () => {
  posted.length = 0;
  await save("acme.test", "https://acme.test/");
  const out = await signIn("acme.test");
  assert.equal(out.result, "not_signin_page");
  assert.equal(out.resave, true);
  assert.match(out.say_exactly, /needs saving again: I can forget the saved one and send you a new link/);
  assert.equal(posted.length, 0, "nothing typed, nothing posted");
  assert.equal(sl.listLogins(ME).length, 1, "the saved login is left as it is: never re-pinned behind their back");
});

test("email-first: the password is typed after OUR submit, on the same exact origin, into a real password box", skip, async () => {
  posted.length = 0;
  await save("ef.test", "https://ef.test/signin");
  const out = await signIn("ef.test");
  assert.equal(out.result, "signed_in", out.say_exactly);
  assert.deepEqual(posted.map(p => `${p.host}${p.path}:${p.field}`), ["ef.test/signin:email", "ef.test/signin/password:password"]);
});

test("email-first refused: another port, http, another origin, a new-password box, a navigation we did not cause: the password is never typed", skip, async () => {
  for (const site of ["ef-port.test", "ef-http.test", "ef-other.test", "ef-new.test", "ef-early.test"]) {
    posted.length = 0;
    await save(site, `https://${site}/signin`);
    const out = await signIn(site);
    assert.notEqual(out.result, "signed_in", site);
    assert.ok(["not_signin_page", "origin_mismatch"].includes(out.result), `${site}: ${out.result}`);
    assert.deepEqual(passwordsTo(), [], `${site}: no password reached any server`);
  }
});
