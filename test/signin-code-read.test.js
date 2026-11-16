// Reason reads the emailed sign-in code itself (owner decision 2026-11-15), behind
// REASON_SIGNIN_CODE_READ = off | owner | on (src/signinemail.js codeFromMail, src/filler.js).
//
//   U. The reader on its own, against a fake Gmail: which mail may be read (the site's own domain or
//      its listed sibling, DKIM passing, after the ask and within five minutes), what counts as a
//      code, the refusals (reset / account change, a security alert, two codes), the never list,
//      no mailbox, the opt-out, the audit line, the switch and who it covers.
//   I. The saved-login sign-in end to end in a real headless browser against a local site: the code
//      typed into the site's own box, the model's words never holding the code or the mail, the
//      fallbacks, one more look after a rejected code only for a NEW mail, the once-only sentence,
//      and the switch off (or a person it does not cover) leaving everything exactly as on main.
// Nothing reaches the internet or a real mailbox; every value is made up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "signin-code-read-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
for (const k of ["REASON_ENCRYPT_REST", "REASON_ENCRYPT_REST2", "REASON_ENCRYPT_REST3"]) process.env[k] = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "4c".repeat(32);
process.env.REASON_TOKEN_KEY ||= "23".repeat(32);
process.env.REASON_TEST_ALLOW_PRIVATE_FETCH = "1";
delete process.env.REASON_LOGINS_DB_PATH;
delete process.env.REASON_VAULT_KMS;
for (const k of ["REASON_VAULT_KMS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "REASON_REST_KMS_HOST"]) delete process.env[k];
delete process.env.REASON_CONVERSATION;
process.env.REASON_SAVED_LOGINS = "on";
delete process.env.REASON_SIGNIN_CODE_READ;
process.env.SENDBLUE_FROM_NUMBER = "+1 (555) 555-0100";

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "keys"));
const g = await standInGcp({ dir: join(dir, "keys") });
useStandIn(g);

const sl = await import("../src/savedlogins.js");
const { Secret } = await import("../src/secret.js");
const filler = await import("../src/filler.js");
const se = await import("../src/signinemail.js");
const mc = await import("../src/mailcode.js");
const slog = await import("../src/signinlog.js");
const refusing = await import("../src/refusing.js");
const db = await import("../src/db.js");
const tools = await import("../src/tools.js");

let chromium;
try { ({ chromium } = await import("playwright")); } catch { /* no browser */ }
const skip = { skip: chromium ? false : "playwright/chromium not installed" };

const ME = "dm:owner"; // the operator's thread (config.ownerConversation)
const OTHER = "dm:+15550001111"; // somebody else the saved-login switch covers when it is "on"
const USER = "code-tester1@example.test";
const PASS = "Stand-in-code-9Rw!";
const S = (s) => new Secret(Buffer.from(s, "utf8"));
const CODE_OK = "482913";
const SUBJECT = "Your Acme sign-in code";
const BODY_MARK = "Plum-Lantern-Body-Marker";
const trig = (site = "acme.test") => ({ kind: "user", messages: [{ role: "user", content: `[Sun 4:30pm] sign in to ${site} and check my plan` }] });
const setMode = (v) => { if (v == null) delete process.env.REASON_SIGNIN_CODE_READ; else process.env.REASON_SIGNIN_CODE_READ = v; };

// ---------------------------------------------------------------- a fake Gmail
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64url");
const dkimFor = (from) => `mx.google.com; dkim=pass header.i=@${String(from).replace(/.*@/, "").replace(/>.*/, "")} header.s=s1`;
/** mails: { id, from, at (ms or () => ms), subject, text, html, auth } */
function fakeGmail(mails, { connected = true } = {}) {
  const calls = [];
  const box = { mails, calls, tokenCalls: 0 };
  box.tokens = async () => { box.tokenCalls++; return connected ? { ok: true, accounts: [{ account: "me@example.test", token: "tok-1" }] } : { ok: true, accounts: [] }; };
  const atOf = (m) => (typeof m.at === "function" ? (m._at ??= m.at()) : m.at);
  box.api = async (token, method, p, opts = {}) => {
    calls.push({ method, path: p, format: opts?.query?.format ?? null, q: opts?.query?.q ?? null });
    if (method !== "GET") return { ok: false };
    if (p === "/gmail/v1/users/me/messages") { for (const m of box.mails) atOf(m); return { ok: true, body: { messages: box.mails.map((m) => ({ id: m.id })) } }; }
    const id = decodeURIComponent(p.split("/").pop());
    const m = box.mails.find((x) => x.id === id);
    if (!m) return { ok: false };
    const headers = [{ name: "From", value: m.from }, ...[].concat(m.auth ?? dkimFor(m.from)).map((v) => ({ name: "Authentication-Results", value: v })), { name: "Subject", value: m.subject ?? "" }];
    if (opts.query?.format === "metadata") return { ok: true, body: { id, internalDate: String(atOf(m)), payload: { headers } } };
    return { ok: true, body: { id, internalDate: String(atOf(m)), payload: { headers, mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64(m.text ?? "") } }, ...(m.html ? [{ mimeType: "text/html", body: { data: b64(m.html) } }] : []),
    ] } } };
  };
  box.fullReads = () => calls.filter((c) => c.format === "full").map((c) => decodeURIComponent(c.path.split("/").pop()));
  box.opts = { tokens: box.tokens, api: box.api, pollMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  return box;
}
const codeMail = (over = {}) => ({ id: "m-ok", from: "Acme <no-reply@acme.test>", subject: SUBJECT,
  text: `Hi,\nYour verification code is ${CODE_OK}.\nIt expires in 10 minutes. ${BODY_MARK}\nIf this wasn't you, change your password at https://acme.test/settings/password`, ...over });
const ENTRY = { site: "acme.test", label: "acme.test", signin_url: "https://acme.test/login" };
const T0 = 1_800_000_000_000;
const read = (box, over = {}) => se.codeFromMail(ME, ENTRY, { since: T0, waitMs: 60, now: () => Date.now(), ...box.opts, ...over });

after(async () => { setMode(null); });

// ================================================================ U: the reader
test("U: a code mail from the site, after the ask: the code, held as a Secret, and nothing of the mail", async () => {
  const box = fakeGmail([codeMail({ at: T0 + 2_000 })]);
  const got = await read(box);
  assert.equal(got.status, "code");
  assert.ok(got.secret instanceof Secret && got.secret.live);
  const shown = JSON.stringify({ ...got, seen: [...got.seen] });
  assert.ok(!shown.includes(CODE_OK) && !shown.includes(SUBJECT) && !shown.includes(BODY_MARK), shown);
  assert.equal(got.sender, "acme.test");
  assert.match(got.hash, /^[a-f0-9]{16}$/);
  assert.equal(got.secret.use((b) => b.toString("utf8")), CODE_OK);
  assert.equal(got.secret.live, false, "zero-filled after its one use");
  // The narrowest query, server-side; only GETs; the mail is never marked or moved.
  const list = box.calls.find((c) => c.q);
  assert.match(list.q, /^from:\(acme\.test\) after:\d+ before:\d+$/);
  assert.ok(!/newer_than|in:inbox|is:unread/.test(list.q));
  assert.ok(box.calls.every((c) => c.method === "GET" && !/modify|trash|batch/.test(c.path)));
});

test("U: a code from another domain is ignored: not even its body is fetched", async () => {
  const box = fakeGmail([codeMail({ id: "m-other", from: "Other <codes@other.test>", at: T0 + 1_000 })]);
  const got = await read(box);
  assert.equal(got.status, "not_found");
  assert.deepEqual(box.fullReads(), []);
});

test("U: a mail from the site that arrived BEFORE the job asked is ignored (and one after the five minutes)", async () => {
  const box = fakeGmail([codeMail({ id: "m-old", at: T0 - 60_000 }), codeMail({ id: "m-late", at: T0 + se.CODE_READ_WINDOW_MS + 60_000 })]);
  assert.equal((await read(box)).status, "not_found");
  assert.deepEqual(box.fullReads(), []);
});

test("U: look-alike senders are ignored: acme-security.test, acme.test.evil.io, and a From of acme.test signed by someone else", async () => {
  const box = fakeGmail([
    codeMail({ id: "m-la1", from: "Acme <no-reply@acme-security.test>", at: T0 + 1_000 }),
    codeMail({ id: "m-la2", from: "Acme <no-reply@acme.test.evil.io>", at: T0 + 1_000 }),
    codeMail({ id: "m-la3", from: "Acme <no-reply@acme.test>", auth: "mx.google.com; dkim=pass header.i=@evil.io", at: T0 + 1_000 }),
    codeMail({ id: "m-la4", from: "Acme <no-reply@acme.test>", auth: ["evil.example; dkim=pass header.i=@acme.test", "mx.google.com; dkim=fail header.i=@acme.test"], at: T0 + 1_000 }),
  ]);
  assert.equal((await read(box)).status, "not_found");
  assert.deepEqual(box.fullReads(), []);
  // A mail subdomain of the site itself is the site.
  const sub = fakeGmail([codeMail({ id: "m-sub", from: "Acme <x@mail.acme.test>", at: T0 + 1_000 })]);
  assert.equal((await read(sub)).status, "code");
});

test("U: a password-reset or account-change mail from the right domain is refused, never used", async () => {
  for (const m of [
    { subject: "Reset your password", text: `Use this code to reset your password: ${CODE_OK}` },
    { subject: "Confirm your new email address", text: `Your confirmation code is ${CODE_OK}` },
    { subject: "Your Acme account", text: `We received a request to change your payment method.\nConfirmation code: ${CODE_OK}` },
  ]) {
    const got = await read(fakeGmail([codeMail({ ...m, at: T0 + 1_000 })]));
    assert.equal(got.status, "not_signin", m.subject);
    assert.equal(got.secret, undefined);
  }
});

test("U: two codes (in one mail, or two mails) stop: never a guess", async () => {
  assert.equal((await read(fakeGmail([codeMail({ text: "Your code: 111111\nOr use the code: 222222", at: T0 + 1_000 })]))).status, "two");
  assert.equal((await read(fakeGmail([codeMail({ id: "a", at: T0 + 1_000 }), codeMail({ id: "b", text: "Your verification code is 765432.", at: T0 + 2_000 })]))).status, "two");
  // The same code twice (subject and body) is one code.
  assert.equal((await read(fakeGmail([codeMail({ subject: `${CODE_OK} is your Acme code`, at: T0 + 1_000 })]))).status, "code");
});

test("U: a security alert from the site stops and is told", async () => {
  for (const subject of ["Someone tried to sign in to your Acme account", "New sign-in from a new device", "Security alert"]) {
    assert.equal((await read(fakeGmail([codeMail({ subject, at: T0 + 1_000 })]))).status, "alert", subject);
  }
});

test("U: a sign-in link on the site's own domain is taken; one to another domain is not", async () => {
  const own = await read(fakeGmail([{ id: "l1", from: "Acme <no-reply@acme.test>", subject: "Sign in to Acme", at: T0 + 1_000,
    text: "Click to sign in", html: '<a href="https://acme.test/login/magic?token=abc123">Sign in</a> <a href="https://acme.test/settings/unsubscribe">x</a>' }]));
  assert.equal(own.status, "link");
  assert.equal(own.url, "https://acme.test/login/magic?token=abc123");
  for (const href of ["https://evil.io/login/magic?token=abc", "https://acme.test.evil.io/login?t=1", "https://acme-security.test/login?t=1", "http://acme.test/login/magic?t=1"]) {
    const got = await read(fakeGmail([{ id: "l2", from: "Acme <no-reply@acme.test>", subject: "Sign in to Acme", at: T0 + 1_000, text: "Click to sign in", html: `<a href="${href}">Sign in</a>` }]));
    assert.equal(got.status, "not_found", href);
  }
  // A password-reset link on the site's own domain is never a sign-in link.
  assert.equal(se.readSigninMail({ subject: "Sign in", html: '<a href="https://acme.test/password/reset?t=1">here</a>' }, "acme.test").kind, "none");
});

test("U: a never-list site (bank, carrier, Apple, a mailbox, Google) is never fetched for at all", async () => {
  for (const site of ["chase.com", "verizon.com", "appleid.apple.com", "gmail.com", "outlook.com", "accounts.google.com", "1password.com"]) {
    const box = fakeGmail([codeMail({ from: `X <no-reply@${site}>`, at: T0 + 1_000 })]);
    const got = await se.codeFromMail(ME, { site, label: site, signin_url: `https://${site}/login` }, { since: T0, waitMs: 0, ...box.opts });
    assert.equal(got.status, "never", site);
    assert.equal(box.tokenCalls, 0, `${site}: the mailbox was not even opened`);
    assert.equal(box.calls.length, 0);
  }
});

test("U: no mailbox connected, and nothing arriving in time, are their own answers", async () => {
  assert.equal((await read(fakeGmail([], { connected: false }))).status, "no_mailbox");
  let slept = 0;
  const box = fakeGmail([]);
  const got = await read(box, { waitMs: 100, pollMs: 25, sleep: async () => { slept++; } });
  assert.equal(got.status, "not_found");
  assert.ok(slept >= 1, "it waited for the mail");
});

test("U: their \"don't read my mail for codes\" is honoured (the mailbox is not opened) and can be undone", async () => {
  se.setCodeRead(ME, false);
  try {
    const box = fakeGmail([codeMail({ at: T0 + 1_000 })]);
    assert.equal((await read(box)).status, "opted_out");
    assert.equal(box.tokenCalls, 0);
    assert.equal(se.codeReadOptedOut(ME), true);
  } finally { se.setCodeRead(ME, true); }
  assert.equal(se.codeReadOptedOut(ME), false);
});

test("U: the audit row: site, time, sender domain, message-id hash; never the code, subject or body", () => {
  db.db.exec("DELETE FROM login_log");
  slog._resetAttempts();
  const lines = [];
  const old = slog.setSink((l) => lines.push(l));
  try {
    assert.equal(mc.auditMailCode(ME, "acme.test", { sender: "acme.test", hash: "0123456789abcdef" }), true, "first time");
    assert.equal(mc.auditMailCode(ME, "acme.test", { sender: "acme.test", hash: "fedcba9876543210" }), false, "after that, not");
  } finally { slog.setSink(old); }
  const rows = db.db.prepare("SELECT * FROM login_log WHERE event = 'code_from_mail'").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].site, "acme.test");
  assert.equal(rows[0].outcome, "ok");
  assert.ok(Number.isFinite(rows[0].at));
  const line = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(line).sort(), ["at", "msg", "sender", "signin_mail_code"]);
  assert.equal(line.sender, "acme.test");
  assert.equal(line.msg, "0123456789abcdef");
  const all = JSON.stringify(rows) + lines.join("\n") + JSON.stringify(db.db.prepare("SELECT * FROM action_ledger").all());
  assert.ok(!all.includes(CODE_OK) && !all.includes(SUBJECT) && !all.includes(BODY_MARK));
});

test("U: the switch: off by default; owner covers only the operator; on covers whom saved logins cover; never more", () => {
  setMode(null);
  assert.equal(mc.codeReadMode(), "off");
  assert.equal(mc.codeReadAllowedFor(ME), false);
  setMode("owner");
  assert.equal(mc.codeReadAllowedFor(ME), true);
  assert.equal(mc.codeReadAllowedFor(OTHER), false);
  setMode("on");
  assert.equal(mc.codeReadAllowedFor(OTHER), true);
  process.env.REASON_SAVED_LOGINS = "owner";
  try { assert.equal(mc.codeReadAllowedFor(OTHER), false, "not a person the saved-login switch covers"); }
  finally { process.env.REASON_SAVED_LOGINS = "on"; }
  process.env.REASON_SAVED_LOGINS = "off";
  try { assert.equal(mc.codeReadAllowedFor(ME), false); } finally { process.env.REASON_SAVED_LOGINS = "on"; }
  setMode(null);
});

test("U: the opt-out tool is shown only where the switch covers them, and says plain words", async () => {
  setMode(null);
  assert.ok(!tools.toolsFor(ME).some((t) => t.name === "signin_code_mail"), "off: nobody is told it exists");
  setMode("owner");
  try {
    assert.ok(tools.toolsFor(ME).some((t) => t.name === "signin_code_mail"));
    assert.ok(!tools.toolsFor(OTHER).some((t) => t.name === "signin_code_mail"));
    const off = await tools.runTool("signin_code_mail", { read: false }, { conversationId: ME, kind: "user", messages: [] });
    assert.equal(off.ok, true);
    assert.match(off.say_exactly, /won't read your mail for sign-in codes/);
    assert.equal(se.codeReadOptedOut(ME), true);
    const event = await tools.runTool("signin_code_mail", { read: true }, { conversationId: ME, kind: "event", messages: [] });
    assert.equal(event.ok, false, "turned back on only from their own turn");
    assert.equal(se.codeReadOptedOut(ME), true);
    const on = await tools.runTool("signin_code_mail", { read: true }, { conversationId: ME, kind: "user", messages: [] });
    assert.equal(on.ok, true);
    assert.equal(se.codeReadOptedOut(ME), false);
  } finally { se.setCodeRead(ME, true); setMode(null); }
});

// ================================================================ I: the sign-in, end to end
const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
  "-days", "2", "-nodes", "-subj", "/CN=acme.test", "-addext", "subjectAltName=DNS:acme.test"], { stdio: "ignore" });
const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

// #562's page: email first, then "We sent a sign-in code to your email" and a code box, no password.
const EMAIL_THEN_CODE = `<!doctype html><html><head><title>Sign in</title></head><body>
<form id="f"><h1>Enter your info to sign in</h1>
<div id="e"><label for="u">Email or mobile number</label><input id="u" type="text" name="userLoginId" autocomplete="email"></div>
<div id="c" style="display:none"><p>We sent a sign-in code to your email. Enter it below.</p>
<label for="k">Sign-in code</label><input id="k" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></div>
<div id="msg"></div><button type="submit" id="go">Continue</button></form>
<script>
var f=document.getElementById('f'),m=document.getElementById('msg'),step='email';
f.addEventListener('submit',function(e){e.preventDefault();
  if(step==='email'){step='code';document.getElementById('e').style.display='none';document.getElementById('c').style.display='block';return}
  fetch(location.pathname+'/code',{method:'POST',body:new URLSearchParams(new FormData(f))}).then(function(r){return r.json()}).then(function(o){
    if(o.ok){location.href='/browse';return}m.setAttribute('role','alert');m.textContent=o.msg;});});
</script></body></html>`;
// A password page whose second step is an emailed code (the saved row says second_step "email").
const PW_THEN_CODE = `<!doctype html><html><head><title>Sign in</title></head><body>
<form id="f"><h1>Sign in</h1>
<div id="e"><label for="u">Email</label><input id="u" type="email" name="userLoginId" autocomplete="email">
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password"></div>
<div id="c" style="display:none"><p>Enter the code we emailed you.</p>
<label for="k">Verification code</label><input id="k" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></div>
<div id="msg"></div><button type="submit">Continue</button></form>
<script>
var f=document.getElementById('f'),m=document.getElementById('msg'),step='pw';
f.addEventListener('submit',function(e){e.preventDefault();
  if(step==='pw'){step='code';setTimeout(function(){document.getElementById('e').remove();document.getElementById('c').style.display='block';},300);return}
  fetch(location.pathname+'/code',{method:'POST',body:new URLSearchParams(new FormData(f))}).then(function(r){return r.json()}).then(function(o){
    if(o.ok){location.href='/browse';return}m.setAttribute('role','alert');m.textContent=o.msg;});});
</script></body></html>`;

let codeChecks = [];
let magicHits = 0;
function handler(req, res) {
  const u = new URL(req.url, "https://acme.test");
  const send = (code, body, type = "text/html; charset=utf-8") => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (req.method === "POST" && u.pathname.endsWith("/code")) {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const code = new URLSearchParams(raw).get("code");
      codeChecks.push(code);
      send(200, JSON.stringify(code === CODE_OK ? { ok: true } : { ok: false, msg: "That code isn't right." }), "application/json");
    });
    return;
  }
  if (u.pathname === "/login/magic") { magicHits++; res.writeHead(302, { location: "/browse" }); return res.end(); }
  if (u.pathname === "/browse") return send(200, "<!doctype html><html><body><h1>Your plan</h1><a href='/logout'>Sign out</a></body></html>");
  if (u.pathname === "/login/efcode") return send(200, EMAIL_THEN_CODE);
  if (u.pathname === "/login/pwcode") return send(200, PW_THEN_CODE);
  return send(404, "<p>not found</p>");
}

let server, PORT, launch;
before(async () => {
  if (!chromium) return;
  server = createHttps(tls, handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
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
  await new Promise((r) => (server ? server.close(r) : r()));
  await g.close();
  rmSync(dir, { recursive: true, force: true });
});

async function save(who, path, over = {}) {
  refusing._resetRefusals();
  for (const r of sl.listLogins(who)) sl.removeLogin(who, r.id);
  return sl.saveLogin(who, {
    site: "acme.test", label: "acme.test", signinOrigin: `https://acme.test:${PORT}`, signinPath: path, permission: "standing",
    consentVersion: "saved-login-v1", consentAt: Date.now(), consentCredential: "standin-passkey-credential-1", ...over,
  }, { username: S(USER), password: S(PASS), totp: null });
}
const until = async (ok, ms = 30_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return ok(); };

/** One sign-in with everything the person could see captured: the result, the notes, every log line. */
async function run(who, { box = null, readCode = undefined, reply = null, emailCode = undefined } = {}) {
  const notes = [];
  const logs = [];
  const asked = { n: 0 };
  const reads = { n: 0 };
  const oldSink = slog.setSink((l) => logs.push(String(l)));
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(keep)) console[k] = (...a) => { logs.push(a.map(String).join(" ")); };
  let out;
  try {
    out = await filler.signIn(who, "acme.test", {
      trigger: trig(), launch, purpose: "check my plan", waitMs: 400,
      readCode: readCode ?? ((c, e, o) => { reads.n++; return se.codeFromMail(c, e, { ...o, ...(box?.opts ?? {}) }); }),
      ...(emailCode ? { emailCode } : {}),
      awaitReply: async () => { asked.n++; return reply; },
      note: (_c, text) => notes.push(text),
    });
    if (out.result === "needs_code_email" || out.result === "needs_code_sms") await until(() => notes.length === 1);
  } finally {
    slog.setSink(oldSink);
    Object.assign(console, keep);
  }
  return { out, notes, logs, asked: asked.n, reads: reads.n };
}
const nothingShown = (r) => {
  const all = JSON.stringify(r.out) + r.notes.join("\n") + r.logs.join("\n");
  assert.ok(!all.includes(CODE_OK), "the code is never in the words, the notes or the logs");
  assert.ok(!all.includes(SUBJECT) && !all.includes(BODY_MARK), "nothing of the mail is either");
};
const MAIN_INSTEAD = "acme.test emailed you a sign-in code instead of asking for the password. Text me that code and I'll type it into acme.test, once.";
const fresh = (over = {}) => codeMail({ at: () => Date.now(), ...over });

test("I: a matching mail after the job asked: the code is typed into the site's box, once; the model sees only that it was", skip, async () => {
  setMode("owner");
  db.db.exec("DELETE FROM login_log WHERE event = 'code_from_mail'");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const box = fakeGmail([fresh()]);
    const r = await run(ME, { box });
    assert.equal(r.out.result, "signed_in", r.out.say_exactly);
    assert.deepEqual(codeChecks, [CODE_OK], "into the site's own box, once");
    assert.equal(r.asked, 0, "they were not asked");
    assert.equal(r.out.code_from_mail, true);
    assert.match(r.out.say_exactly, /^Signed you in to acme\.test\. I took the code from the email acme\.test just sent you\. I only look at that one email/);
    assert.match(r.out.say_exactly, /If you'd rather I didn't, tell me and I'll ask you for codes instead\.$/);
    nothingShown(r);
    assert.ok(r.logs.some((l) => /"signin_mail_code":"acme\.test"/.test(l)), "the audit line was written");
    assert.deepEqual(box.fullReads(), ["m-ok"], "only that one mail was opened");
  } finally { setMode(null); }
});

test("I: the once-only sentence: the second time it is a few words", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const r = await run(ME, { box: fakeGmail([fresh({ id: "m-2" })]) });
    assert.equal(r.out.result, "signed_in");
    assert.equal(r.out.say_exactly, "Signed you in to acme.test. Got the code from acme.test's email.");
  } finally { setMode(null); }
});

test("I: a code from another domain is ignored: nothing typed, they are asked as today", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const box = fakeGmail([fresh({ id: "m-x", from: "Codes <codes@other.test>" })]);
    const r = await run(ME, { box, reply: null });
    assert.equal(r.out.result, "needs_code_email");
    assert.match(r.out.say_exactly, /nothing from acme\.test reached your email in the last few minutes/);
    assert.equal(r.asked, 1);
    assert.deepEqual(codeChecks, []);
    assert.deepEqual(box.fullReads(), []);
    nothingShown(r);
  } finally { setMode(null); }
});

test("I: a mail from the site from BEFORE the job started is ignored", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const box = fakeGmail([codeMail({ id: "m-early", at: Date.now() - 120_000 })]);
    const r = await run(ME, { box });
    assert.equal(r.out.result, "needs_code_email");
    assert.deepEqual(codeChecks, []);
    assert.deepEqual(box.fullReads(), []);
  } finally { setMode(null); }
});

test("I: a password-reset mail from the site is refused with plain words; nothing typed, nothing asked", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const r = await run(ME, { box: fakeGmail([fresh({ id: "m-reset", subject: "Reset your password", text: `Your password reset code is ${CODE_OK}. ${BODY_MARK}` })]) });
    assert.equal(r.out.result, "mail_not_signin");
    assert.equal(r.out.say_exactly, "The email acme.test just sent wasn't a sign-in code: it was about resetting your password or changing something on your account, so I didn't use it and didn't change anything.");
    assert.deepEqual(codeChecks, []);
    assert.equal(r.asked, 0);
    nothingShown(r);
  } finally { setMode(null); }
});

test("I: a security-alert mail stops and tells them", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const r = await run(ME, { box: fakeGmail([fresh({ id: "m-alert", subject: "Someone tried to sign in to your account" })]) });
    assert.equal(r.out.result, "mail_alert");
    assert.match(r.out.say_exactly, /looks like a security alert .*not a sign-in code, so I stopped/);
    assert.deepEqual(codeChecks, []);
    assert.equal(r.asked, 0);
  } finally { setMode(null); }
});

test("I: two codes: stop and ask them for the newest", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const r = await run(ME, { box: fakeGmail([fresh({ text: "Your code: 111111\nOr use the code: 222222" })]), reply: CODE_OK });
    assert.equal(r.out.result, "needs_code_email");
    assert.equal(r.out.say_exactly, "acme.test sent more than one code, so I didn't guess which one. Text me the newest code from acme.test and I'll type it in, once.");
    assert.equal(r.asked, 1);
    assert.match(r.notes[0], /ended: signed_in/);
    assert.deepEqual(codeChecks, [CODE_OK], "their code, once; neither mail code was typed");
  } finally { setMode(null); }
});

test("I: a sign-in link on the site's own domain is followed in the same browser (REASON_SIGNIN_CODE_LINKS on)", skip, async () => {
  setMode("owner");
  process.env.REASON_SIGNIN_CODE_LINKS = "on";
  try {
    await save(ME, "/login/efcode");
    codeChecks = []; magicHits = 0;
    const r = await run(ME, { readCode: async () => ({ status: "link", url: `https://acme.test:${PORT}/login/magic?token=t0k3n`, sender: "acme.test", hash: "00112233445566aa", seen: new Set() }) });
    assert.equal(r.out.result, "signed_in", r.out.say_exactly);
    assert.equal(magicHits, 1);
    assert.deepEqual(codeChecks, []);
    assert.ok(!JSON.stringify(r.out).includes("t0k3n"), "the link is not in the words");
  } finally { setMode(null); delete process.env.REASON_SIGNIN_CODE_LINKS; }
});

test("I: a link to another domain is not followed: they are asked instead", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = []; magicHits = 0;
    const box = fakeGmail([fresh({ id: "m-link", subject: "Sign in to Acme", text: "Click to sign in", html: '<a href="https://acme.test.evil.io/login/magic?token=x">Sign in</a>' })]);
    const r = await run(ME, { box });
    assert.equal(r.out.result, "needs_code_email");
    assert.equal(magicHits, 0);
    assert.equal(r.asked, 1);
    // And a link the reader somehow handed over that is not on the site: openLink refuses it.
    const page = { goto: async () => { throw new Error("must not navigate"); }, waitForTimeout: async () => {} };
    assert.equal((await se.openLink(page, "https://evil.io/login?t=1", { site: "acme.test", signin_url: "https://acme.test/login" })).ok, false);
  } finally { setMode(null); }
});

test("I: a never-list site: no fetch at all", skip, async () => {
  setMode("owner");
  try {
    let reads = 0;
    const out = await filler.signIn(ME, "chase.com", { trigger: trig("chase.com"), launch, readCode: async () => { reads++; return { status: "never" }; } });
    assert.equal(out.refused, true);
    assert.equal(reads, 0);
  } finally { setMode(null); }
});

test("I: no mailbox connected: asked to read the code out, in today's words", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const r = await run(ME, { box: fakeGmail([], { connected: false }), reply: CODE_OK });
    assert.equal(r.out.result, "needs_code_email");
    assert.equal(r.out.say_exactly, MAIN_INSTEAD);
    assert.equal(r.asked, 1);
    assert.deepEqual(codeChecks, [CODE_OK]);
  } finally { setMode(null); }
});

test("I: nothing arrives in time: said, then asked", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const r = await run(ME, { box: fakeGmail([]), reply: null });
    assert.equal(r.out.result, "needs_code_email");
    assert.equal(r.out.say_exactly, "acme.test said it emailed you a sign-in code, but nothing from acme.test reached your email in the last few minutes. If it's there, text me the code and I'll type it into acme.test, once.");
    assert.equal(r.asked, 1);
    assert.match(r.notes[0], /ended: code_not_found/);
  } finally { setMode(null); }
});

test("I: a rejected code with no NEW mail: stops, never a loop and never the same code twice", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    let reads = 0;
    const box = fakeGmail([fresh({ id: "m-bad", text: "Your verification code is 111999." })]);
    const r = await run(ME, { readCode: (c, e, o) => { reads++; return se.codeFromMail(c, e, { ...o, ...box.opts }); } });
    assert.equal(r.out.result, "wrong_code");
    assert.deepEqual(codeChecks, ["111999"], "typed once");
    assert.equal(reads, 2, "one more look, for a new mail only");
    assert.equal(r.asked, 0);
    assert.match(r.out.say_exactly, /didn't accept the code\. I stopped/);
  } finally { setMode(null); }
});

test("I: a rejected code, then a NEW mail from the site: that one is typed, once, and that is the end", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const box = fakeGmail([fresh({ id: "m-bad2", text: "Your verification code is 111999." })]);
    let reads = 0;
    const readCode = async (c, e, o) => {
      reads++;
      const got = await se.codeFromMail(c, e, { ...o, ...box.opts });
      if (reads === 1) box.mails.push(fresh({ id: "m-good2" })); // the site's new mail lands after the first was taken
      return got;
    };
    const r = await run(ME, { readCode });
    assert.equal(r.out.result, "signed_in", r.out.say_exactly);
    assert.deepEqual(codeChecks, ["111999", CODE_OK]);
    assert.equal(reads, 2);
  } finally { setMode(null); }
});

test("I: opted out: the mailbox is not opened; asked as today", skip, async () => {
  setMode("owner");
  se.setCodeRead(ME, false);
  try {
    await save(ME, "/login/efcode");
    codeChecks = [];
    const box = fakeGmail([fresh()]);
    const r = await run(ME, { box, reply: CODE_OK });
    assert.equal(r.out.result, "needs_code_email");
    assert.equal(r.out.say_exactly, MAIN_INSTEAD);
    assert.equal(box.tokenCalls, 0);
    assert.equal(r.asked, 1);
  } finally { se.setCodeRead(ME, true); setMode(null); }
});

test("I: the second-step emailed code (password, then a code) reads the mail the same narrow way", skip, async () => {
  setMode("owner");
  try {
    await save(ME, "/login/pwcode", { secondStep: "email" });
    codeChecks = [];
    let oldReader = 0;
    const r = await run(ME, { box: fakeGmail([fresh({ id: "m-pw" })]), emailCode: async () => { oldReader++; return { connected: false }; } });
    assert.equal(r.out.result, "signed_in", r.out.say_exactly);
    assert.deepEqual(codeChecks, [CODE_OK]);
    assert.equal(oldReader, 0, "the old reader is not used when the switch covers them");
    nothingShown(r);
  } finally { setMode(null); }
});

test("I: switch off: exactly main (the code-instead step asks by text; the new reader is never called)", skip, async () => {
  setMode(null);
  await save(ME, "/login/efcode");
  codeChecks = [];
  let reads = 0, oldReads = 0;
  const r = await run(ME, { readCode: async () => { reads++; return { status: "code" }; }, emailCode: async () => { oldReads++; return { connected: true, found: true, kind: "code", code: "000000" }; }, reply: CODE_OK });
  assert.equal(r.out.result, "needs_code_email");
  assert.equal(r.out.say_exactly, MAIN_INSTEAD);
  assert.deepEqual(Object.keys(r.out).sort(), ["ok", "result", "say_exactly"]);
  assert.equal(reads, 0);
  assert.equal(oldReads, 0, "main does not read the mailbox for this step");
  assert.equal(r.asked, 1);
  assert.match(r.notes[0], /ended: signed_in/);
  assert.deepEqual(codeChecks, [CODE_OK]);
});

test("I: switch off, the second-step email code: main's own reader, as before", skip, async () => {
  setMode(null);
  await save(ME, "/login/pwcode", { secondStep: "email" });
  codeChecks = [];
  let reads = 0, oldReads = 0;
  const r = await run(ME, { readCode: async () => { reads++; return { status: "never" }; }, emailCode: async () => { oldReads++; return { connected: true, found: true, kind: "code", code: CODE_OK }; } });
  assert.equal(r.out.result, "signed_in");
  assert.equal(r.out.say_exactly, "Signed you in to acme.test.");
  assert.equal(reads, 0);
  assert.equal(oldReads, 1);
});

test("I: a person the switch does not cover (owner mode, somebody else): exactly main", skip, async () => {
  setMode("owner");
  try {
    await save(OTHER, "/login/efcode");
    codeChecks = [];
    let reads = 0;
    const r = await run(OTHER, { readCode: async () => { reads++; return { status: "code" }; }, reply: CODE_OK });
    assert.equal(r.out.result, "needs_code_email", r.out.say_exactly);
    assert.equal(r.out.say_exactly, MAIN_INSTEAD);
    assert.deepEqual(Object.keys(r.out).sort(), ["ok", "result", "say_exactly"]);
    assert.equal(reads, 0);
    assert.equal(r.asked, 1);
  } finally { setMode(null); }
});

// ================================================================ E: the signin_email route, same reader
// With the switch covering them, signin_email reads through codeFromMail too (src/tools.js hands
// strictGmail to startEmailSignin): one reader, the same rules, their opt-out.
function fakeEmailSite(host = "acme.test") {
  const st = { step: "login", typed: [], code: "" };
  const page = {
    url: () => `https://${host}/login`,
    context: () => ({ pages: () => [page] }),
    waitForTimeout: async () => {},
    goto: async () => {},
    evaluate: async (fn, act) => {
      if (fn !== se.emailPage) return "Log in";
      let did = "";
      if (act === "mark_email" && st.step === "login") did = "email";
      if (act === "mark_code" && st.step === "code") did = "code";
      if (act === "submit" && st.step === "login") { st.step = "code"; did = "Continue"; }
      else if (act === "submit" && st.step === "code") { st.step = "done"; did = "Continue"; }
      return { did, email: st.step === "login", code: st.step === "code", split: false, password: false, route: false, instead: false, text: st.step === "code" ? "We sent a code" : "Log in", url: `https://${host}/login` };
    },
    fill: async (sel, v) => { if (/code/.test(sel)) st.code = v; else st.typed.push(v); },
    press: async () => {}, click: async () => {}, keyboard: { type: async () => {} },
  };
  return { st, page };
}
const emailRun = async (gmail) => {
  const { st, page } = fakeEmailSite();
  const notes = [], logs = [];
  const out = se.startEmailSignin({ conversationId: ME, entry: ENTRY, email: "me@example.test", settleMs: 1, replyWaitMs: 50,
    launch: async () => ({ page, close: async () => {} }), gmail,
    check: async () => ({ ok: true, state: "signed_in", why: "the plan page loaded" }),
    log: (l) => logs.push(l), note: (_c, t) => notes.push(t) });
  await out.run;
  return { st, notes, logs };
};
const strictWith = (box) => (c, e, o) => mc.strictGmail(c, e, { ...o, ...box.opts, waitMs: 60 });

test("E: signin_email, covered: the site's code from its one mail, and the once-only sentence for the model to say", async () => {
  db.db.exec("DELETE FROM login_log WHERE event = 'code_from_mail'");
  const r = await emailRun(strictWith(fakeGmail([fresh({ id: "e-1" })])));
  assert.equal(r.st.code, CODE_OK);
  assert.match(r.notes[0], /signed in to acme\.test now/);
  assert.match(r.notes[0], /I took the code from the email acme\.test just sent you/);
  const all = JSON.stringify(r.notes) + JSON.stringify(r.logs);
  assert.ok(!all.includes(CODE_OK) && !all.includes(SUBJECT) && !all.includes(BODY_MARK));
});

test("E: signin_email, covered: a reset mail or an alert stops it in plain words; nothing is typed", async () => {
  const reset = await emailRun(strictWith(fakeGmail([fresh({ id: "e-r", subject: "Reset your password", text: `Your reset code is ${CODE_OK}` })])));
  assert.equal(reset.st.code, "");
  assert.match(reset.notes[0], /wasn't a sign-in code/);
  const alert = await emailRun(strictWith(fakeGmail([fresh({ id: "e-a", subject: "New sign-in from a new device" })])));
  assert.equal(alert.st.code, "");
  assert.match(alert.notes[0], /looks like a security alert/);
});

test("E: signin_email, opted out: the mailbox is not opened and they are asked, with the true reason", async () => {
  se.setCodeRead(ME, false);
  try {
    const box = fakeGmail([fresh({ id: "e-o" })]);
    const r = await emailRun(strictWith(box));
    assert.equal(box.tokenCalls, 0);
    assert.match(r.notes[0], /they asked Reason not to read their mail for codes/);
  } finally { se.setCodeRead(ME, true); }
});

test("E: the signin_email tool hands over the narrow reader only where the switch covers them; off it is main's", async () => {
  const prevSocial = process.env.REASON_SOCIAL_SIGNIN;
  process.env.REASON_SOCIAL_SIGNIN = "owner";
  const started = [];
  const ctx = { conversationId: ME, messages: [], kind: "user", publicUrl: async (url) => ({ ok: true, url }), startEmailSignin: (a) => { started.push(a); return { ok: true, started: true }; } };
  try {
    setMode(null);
    await tools.runTool("signin_email", { site: "https://acme.test/login", email: "me@example.test" }, ctx);
    setMode("owner");
    await tools.runTool("signin_email", { site: "https://acme.test/login", email: "me@example.test" }, ctx);
  } finally { setMode(null); if (prevSocial == null) delete process.env.REASON_SOCIAL_SIGNIN; else process.env.REASON_SOCIAL_SIGNIN = prevSocial; }
  assert.equal(started.length, 2, JSON.stringify(started.map(s => Object.keys(s))));
  assert.equal("gmail" in started[0], false, "off: startEmailSignin's own default reader, as on main");
  assert.equal(started[1].gmail, mc.strictGmail);
});

// ================================================================ R: independent review, 2026-11-15
test("R: Gmail's own header carries words the sender chose (envelope address, ARC comment): never read as a DKIM pass", () => {
  const allowed = ["acme.test"];
  const from = "Acme <no-reply@acme.test>";
  const forged = [
    // A valid dot-atom envelope address on the attacker's domain, quoted back by Gmail in the spf comment and smtp.mailfrom.
    "mx.google.com; dkim=pass header.i=@evil.io header.s=s1 header.b=AbCd; spf=pass (google.com: domain of dkim=pass.header.d=acme.test@evil.io designates 192.0.2.1 as permitted sender) smtp.mailfrom=dkim=pass.header.d=acme.test@evil.io; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=acme.test",
    "mx.google.com; spf=pass (google.com: domain of dkim=pass.header.i=@acme.test@evil.io designates 192.0.2.1 as permitted sender) smtp.mailfrom=dkim=pass.header.i=@acme.test@evil.io; dmarc=fail header.from=acme.test",
    // A quoted local part with its own semicolon.
    'mx.google.com; spf=pass (google.com: domain of "x;dkim=pass header.d=acme.test"@evil.io designates 192.0.2.1 as permitted sender) smtp.mailfrom="x;dkim=pass header.d=acme.test"@evil.io; dmarc=fail header.from=acme.test',
    'mx.google.com; spf=pass smtp.mailfrom="x;dkim=pass header.i=@acme.test header.s=a header.b=b;y"@evil.io',
    // An ARC verdict's comment, and a dkim result after spf.
    "mx.google.com; arc=pass (i=1 dkim=pass header.d=acme.test); spf=pass smtp.mailfrom=a@evil.io",
    "mx.google.com; spf=pass smtp.mailfrom=a@evil.io; dkim=pass header.i=@acme.test header.s=a header.b=b",
    // Unbalanced quote or comment: not Gmail's shape, so not read at all.
    'mx.google.com; dkim=pass header.i=@acme.test header.s=a header.b=b (x',
  ];
  for (const auth of forged) assert.equal(se.senderMatches({ from, auth: [auth] }, allowed), false, auth);
  // Gmail's real shapes still pass.
  for (const auth of [
    "mx.google.com; dkim=pass header.i=@acme.test header.s=s1 header.b=AbC+/d=; spf=pass (google.com: domain of bounce@acme.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@acme.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.test",
    "mx.google.com; dkim=neutral (body hash did not verify) header.i=@other.example header.s=x header.b=y; dkim=pass header.i=@mail.acme.test header.s=s2 header.b=z; spf=pass smtp.mailfrom=x@acme.test",
    "mx.google.com; dkim=pass header.d=acme.test",
  ]) assert.equal(se.senderMatches({ from, auth: [auth] }, allowed), true, auth);
});

test("R: the forged-header mail is never opened past its headers by the reader", async () => {
  const auth = "mx.google.com; spf=pass (google.com: domain of dkim=pass.header.d=acme.test@evil.io designates 192.0.2.1 as permitted sender) smtp.mailfrom=dkim=pass.header.d=acme.test@evil.io; dmarc=fail header.from=acme.test";
  const box = fakeGmail([codeMail({ id: "m-spf", auth, at: T0 + 1_000 })]);
  assert.equal((await read(box)).status, "not_found");
  assert.deepEqual(box.fullReads(), []);
});

test("R: a link that would act for somebody else (approve a device, an invite, a share, a query token alone) is never a sign-in link", () => {
  const html = (href, words = "Click to sign in") => `<p>${words}</p><a href="${href}">Continue</a>`;
  const never = [
    [html("https://acme.test/login/approve?token=1")],
    [html("https://acme.test/device/confirm?token=1")],
    [html("https://acme.test/auth/authorize?token=1")],
    [html("https://acme.test/invite/accept?token=1")],
    [html("https://acme.test/w/team-x?token=1")], // no sign-in word in the path, only token= in the query
    [html("https://acme.test/Login-Plan-page?id=1", "Sam invited you to a page")],
    [html("https://acme.test/login/magic?token=1", "Someone is trying to sign in from another device. Approve it?")],
    [html("https://acme.test/login/magic?token=1", "Is this you? Confirm your login")],
    [html("https://acme.test/verify?token=1", "Sam shared a doc with you")],
  ];
  for (const [h] of never) assert.notEqual(se.readSigninMail({ subject: "Acme", html: h }, "acme.test").kind, "link", h);
  // A plain magic link still is one.
  assert.equal(se.readSigninMail({ subject: "Your Acme sign-in link", html: html("https://acme.test/login/magic?token=1") }, "acme.test").kind, "link");
});

test("R: a mailed link that redirects off the site is not a sign-in (openLink checks where it landed)", async () => {
  let at = "https://acme.test/login";
  const page = { url: () => at, goto: async () => { at = "https://evil.io/landing"; }, waitForTimeout: async () => {} };
  const out = await se.openLink(page, "https://acme.test/login/magic?token=1", { site: "acme.test", signin_url: "https://acme.test/login" }, { settleMs: 0 });
  assert.equal(out.ok, false);
  let at2 = "https://acme.test/login";
  const page2 = { url: () => at2, goto: async () => { at2 = "https://www.acme.test/home"; }, waitForTimeout: async () => {} };
  assert.equal((await se.openLink(page2, "https://acme.test/login/magic?token=1", { site: "acme.test", signin_url: "https://acme.test/login" }, { settleMs: 0 })).ok, true);
});

test("R: a suffix registrableOf does not know, or a tenant of a shared platform, is never read for a code", () => {
  for (const s of ["shop.example.ne.jp", "acme.zendesk.com", "acme.atlassian.net", "acme.myshopify.com", "me.github.io", "x.me.uk"]) assert.equal(se.mailReadRefused(s), true, s);
  for (const s of ["acme.test", "www.notion.so", "zendesk.com", "shop.example.co.uk"]) assert.equal(se.mailReadRefused(s), false, s);
});

test("R: only Gmail's topmost Authentication-Results counts: a pass written lower down (inside the message) is the sender's own", async () => {
  const auth = ["mx.google.com; dkim=none; spf=pass smtp.mailfrom=a@evil.io; dmarc=fail header.from=acme.test", "mx.google.com; dkim=pass header.i=@acme.test header.s=a header.b=b"];
  assert.equal(se.senderMatches({ from: "Acme <no-reply@acme.test>", auth }, ["acme.test"]), false);
  const box = fakeGmail([codeMail({ id: "m-lower", auth, at: T0 + 1_000 })]);
  assert.equal((await read(box)).status, "not_found");
  assert.deepEqual(box.fullReads(), []);
});


// ================================================================ L: codes only (REASON_SIGNIN_CODE_LINKS, default off)
test("L: links sub-switch off (default): a mail with only a sign-in link opens nothing, and they are asked in today's words", skip, async () => {
  setMode("owner");
  delete process.env.REASON_SIGNIN_CODE_LINKS;
  try {
    await save(ME, "/login/efcode");
    codeChecks = []; magicHits = 0;
    const box = fakeGmail([fresh({ id: "m-only-link", subject: "Your Acme sign-in link", text: "Click to sign in", html: '<a href="https://acme.test/login/magic?token=t0k3n">Sign in</a>' })]);
    assert.equal(se.readSigninMail({ subject: "Your Acme sign-in link", html: '<a href="https://acme.test/login/magic?token=t0k3n">Sign in</a>' }, "acme.test").kind, "link", "the mail is a real link mail");
    const r = await run(ME, { box, reply: CODE_OK });
    assert.equal(magicHits, 0, "no link opened");
    assert.equal(r.out.result, "needs_code_email");
    // Today's words for an emailed code (this fixture sends one instead of asking for the password).
    assert.equal(r.out.say_exactly, "acme.test emailed you a sign-in code instead of asking for the password. Text me that code and I'll type it into acme.test, once.");
    assert.equal(r.asked, 1);
    assert.ok(!JSON.stringify(r.out).includes("t0k3n") && !r.logs.join("\n").includes("t0k3n"));
    // The handed-over link shape too (a reader that returns a link): still nothing opened.
    magicHits = 0;
    const r2 = await run(ME, { readCode: async () => ({ status: "link", url: `https://acme.test:${PORT}/login/magic?token=t0k3n`, sender: "acme.test", hash: "00112233445566aa", seen: new Set() }), reply: CODE_OK });
    assert.equal(magicHits, 0);
    assert.equal(r2.out.result, "needs_code_email");
    assert.equal(r2.asked, 1);
  } finally { setMode(null); }
});

test("L: links sub-switch off (default): a code mail still has its code typed", skip, async () => {
  setMode("owner");
  delete process.env.REASON_SIGNIN_CODE_LINKS;
  try {
    await save(ME, "/login/efcode");
    codeChecks = []; magicHits = 0;
    const r = await run(ME, { box: fakeGmail([fresh({ id: "m-code-l" })]) });
    assert.equal(r.out.result, "signed_in", r.out.say_exactly);
    assert.deepEqual(codeChecks, [CODE_OK]);
    assert.equal(r.asked, 0);
    assert.equal(magicHits, 0);
  } finally { setMode(null); }
});

test("L: the sub-switch reads only on/1/true/yes as on", () => {
  for (const [v, want] of [[undefined, false], ["", false], ["off", false], ["owner", false], ["on", true], ["1", true], ["TRUE", true]]) {
    if (v === undefined) delete process.env.REASON_SIGNIN_CODE_LINKS; else process.env.REASON_SIGNIN_CODE_LINKS = v;
    assert.equal(mc.codeLinksOn(), want, String(v));
  }
  delete process.env.REASON_SIGNIN_CODE_LINKS;
});
