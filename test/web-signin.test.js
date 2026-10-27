// Reason Web, phase W1: signing in (src/pages/websignin.js, routed in src/http.js). Spec §10 as it
// applies to a sign-in with nothing private behind it yet:
//
//   - REASON_WEB off: /web and every sub-path are the same flat 404 as a path nobody was issued
//   - `owner`: only the owner's number is texted a code; anybody else's gets the same page and nothing
//   - a number with no account gets byte-identical words to one with (only the echoed number differs),
//     no text, no account made — and the join block: the live line's sms: link, QR and written number
//   - two people: a session is one person's; one's code never opens the other's number
//   - wrong code, reused code, expired code, a fourth request in the window, a flood of wrong tries
//   - the session cookie is HttpOnly, Secure, SameSite=Lax, on every path; 90 days hard, 30 idle
//   - sign-out ends the session (and only with the session's own secret, from Reason's own page)
//   - CSRF: a sign-in form without its browser's token, or from another site, starts over and texts nobody
//   - a registered-but-dead linq adapter never puts its number on the page
//   - every answer carries the security headers; the code text is never in the per-message history
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-signin-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_AUTO_ADMIT;
// For the linq test below: Sendblue fully configured (live), Linq with a number on file but no keys.
process.env.SENDBLUE_API_KEY_ID = "sb-key";
process.env.SENDBLUE_API_SECRET_KEY = "sb-secret";
process.env.SENDBLUE_FROM_NUMBER = "+16562167455";
process.env.SENDBLUE_WEBHOOK_SECRET = "sb-webhook";
process.env.LINQ_FROM_NUMBER = "+18083199759";
delete process.env.LINQ_API_KEY;
delete process.env.LINQ_WEBHOOK_SECRET;

const { webRequestFor, createServer } = await import("../src/http.js");
const ws = await import("../src/pages/websignin.js");
const { esc } = await import("../src/pages/render.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { LinqChannel } = await import("../src/channels/linq.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876";
const AMA = "+13475550000";
const NOBODY = "+16465550101";
const LINE = "+16562167455";
const OWNER_C = config.ownerConversation;
const KOFI_C = `dm:fake:${KOFI}`;
const AMA_C = `dm:fake:${AMA}`;
const MIN = 60_000, DAY = 24 * 60 * MIN;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  db.db.exec(`DELETE FROM accounts; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations; DELETE FROM inbound_messages;
    DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM event_join_attempts; DELETE FROM messages;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: AMA, name: "Ama" });
  for (const [c, a] of [[OWNER_C, MASTER], [KOFI_C, KOFI], [AMA_C, AMA]]) db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true });
});

function harness() {
  const logs = [];
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async () => "ok" });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  router.runtime = runtime;
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await runtime.deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { runtime, router, channel, logs };
}
const form = (o) => new URLSearchParams(o).toString();
async function req(h, { sub = null, method = "GET", query = {}, body = null, cookie = "", origin = "https://heyreason.test", sfs = null, ip = "203.0.113.9", router = h.router } = {}) {
  const headers = { host: "heyreason.test", cookie, "x-forwarded-for": ip, "x-files-domain": "true" };
  if (origin) headers.origin = origin;
  if (sfs) headers["sec-fetch-site"] = sfs;
  return await webRequestFor({ sub, method, query, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router, log: (e) => h.logs.push(e) });
}
const setCookies = (out) => [].concat(out.headers["Set-Cookie"] ?? []);
const cookieValue = (out, name) => setCookies(out).map(c => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find(Boolean) ?? null;
/** Open the sign-in page as a fresh browser: its form token, and the cookie jar to send back. */
async function fresh(h) {
  const out = await req(h);
  assert.equal(out.status, 200);
  const f = cookieValue(out, ws.FORM_COOKIE);
  assert.ok(f, "a fresh browser is given a form token");
  return { f, jar: `${ws.FORM_COOKIE}=${f}` };
}
const until = async (pred, ms = 2000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return pred(); };
const codesTo = (h, to) => h.channel.sent.filter(m => m.to === to).map(m => /\b(\d{6})\b/.exec(m.text)?.[1]).filter(Boolean);
/** Ask for a code as `number` from a browser holding `b`, wait for the text if one should come. */
async function ask(h, b, number, { expectText = true, ip } = {}) {
  const before = h.channel.sent.length;
  const out = await req(h, { sub: "signin", method: "POST", body: form({ number, f: b.f }), cookie: b.jar, ip });
  if (expectText) assert.ok(await until(() => h.channel.sent.length > before), "the code text went");
  else { await new Promise(r => setTimeout(r, 30)); assert.equal(h.channel.sent.length, before, "no text went"); }
  return out;
}
const typeCode = (h, b, number, code, { ip, t } = {}) => req(h, { sub: "code", method: "POST", body: form({ number, code, f: b.f, ...(t ? { t } : {}) }), cookie: b.jar, ip });
/** The code page's own `t` (when this browser asked), as the page posts it back. */
const askedAt = (body) => /name="t" value="(\d+)"/.exec(body)?.[1] ?? null;
/** Sign Kofi in on a fresh browser and hand back its session cookie. */
async function signedIn(h, number = KOFI, to = KOFI) {
  const b = await fresh(h);
  await ask(h, b, number);
  const code = codesTo(h, to).at(-1);
  const out = await typeCode(h, b, number, code);
  assert.equal(out.status, 303);
  const token = cookieValue(out, "reason_page");
  assert.ok(token, "the session cookie is set");
  return { token, jar: `reason_page=${token}`, out };
}
/** A page with the typed number's echo (written out and masked) taken out, and the moment it was drawn (`t`). */
const withoutNumber = (body, n) => body.replaceAll(n, "N").replaceAll(ws.maskedNumber(n), "M").replace(/name="t" value="\d+"/g, 'name="t" value="T"');
/** The sign-in form's heading, the page everybody signed out sees. */
const SIGNIN = /<h1 id="so-title" class="h1">What(&#39;|')s your number\?<\/h1>/;
const SIGNED_OUT = /<p class="hand tilt" role="status">you(&#39;|')ve been signed out\. everything(&#39;|')s still here\.<\/p>/;
/** The first signed-in GET is the once-only 5C page; this spends it so later GETs show the arrival. */
const firstVisit = async (h, jar) => assert.match((await req(h, { cookie: jar })).body, /One Reason\.<br><em>Pick up anywhere\.<\/em>/);

// ---------- the switch ----------

test("REASON_WEB off: /web and its sub-paths are the same flat 404 as a path nobody was issued", async () => {
  config.web = false;
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ghost = await fetch(`${base}/no-such-thing`);
    const ghostBody = await ghost.text();
    for (const [path, method] of [["/web", "GET"], ["/web/signin", "POST"], ["/web/code", "POST"], ["/web/signout", "POST"]]) {
      const r = await fetch(`${base}${path}`, { method, body: method === "POST" ? "number=1" : undefined, headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {} });
      assert.equal(r.status, ghost.status, path);
      assert.equal(await r.text(), ghostBody, `${path} answers exactly what a made-up path does`);
      assert.equal(r.headers.get("content-type"), ghost.headers.get("content-type"));
    }
    config.web = true;
    const on = await fetch(`${base}/web`);
    assert.equal(on.status, 200);
    assert.match(await on.text(), SIGNIN);
  } finally { await new Promise(r => server.close(r)); }
});

test("`owner`: the owner's number is texted a code; anybody else's gets the same page and no text, and never a session", async () => {
  config.web = "owner";
  const h = harness();
  const b = await fresh(h);
  const mine = await ask(h, b, MASTER);
  assert.equal(codesTo(h, MASTER).length, 1);
  const theirs = await ask(h, b, KOFI, { expectText: false });
  assert.equal(theirs.status, 200);
  assert.equal(withoutNumber(theirs.body, KOFI), withoutNumber(mine.body, MASTER), "identical words for the owner and anybody else");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_codes WHERE page_id = ?").get(ws.signinKey(KOFI_C)).n, 0, "no code was even minted for Kofi");
  // A guess at Kofi's code opens nothing — there is none; and the owner's code typed as Kofi's number is wrong.
  const code = codesTo(h, MASTER)[0];
  assert.equal((await typeCode(h, b, KOFI, code)).status, 200);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 0);
  // The owner's own code signs the owner in.
  const ok = await typeCode(h, b, MASTER, code);
  assert.equal(ok.status, 303);
  const jar = `reason_page=${cookieValue(ok, "reason_page")}`;
  await firstVisit(h, jar);
  assert.match((await req(h, { cookie: jar })).body, /What(&#39;|')s good, Omari\?/);
});

test("a person signed in while `on` is signed out the moment the switch is back to `owner` — not told why, not 404", async () => {
  const h = harness();
  const s = await signedIn(h);
  await firstVisit(h, s.jar);
  assert.match((await req(h, { cookie: s.jar })).body, /What(&#39;|')s good, Kofi\?/);
  config.web = "owner";
  const out = await req(h, { cookie: s.jar });
  assert.equal(out.status, 200);
  assert.match(out.body, SIGNIN);
});

// ---------- enumeration, and the join block ----------

test("a number with no account gets byte-identical words to one with, no text, no account made — plus the join block everybody sees", async () => {
  const h = harness();
  const b = await fresh(h);
  const accountsBefore = db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  const known = await ask(h, b, KOFI);
  const unknown = await ask(h, b, NOBODY, { expectText: false });
  assert.equal(unknown.status, 200);
  assert.equal(withoutNumber(unknown.body, NOBODY), withoutNumber(known.body, KOFI));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, accountsBefore, "typing a number never makes an account");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 1, "one text, to the one real number");
  // The code step (6B): "Check your texts.", the typed number masked to its last four, and the way
  // in for somebody new — the same for a stranger and for Kofi alike.
  for (const [body, n] of [[known.body, KOFI], [unknown.body, NOBODY]]) {
    assert.match(body, /<h1 id="so-title" class="h1">Check your texts\.<\/h1>/);
    assert.ok(body.includes(`Six digits, sent to ${ws.maskedNumber(n)}.`), "masked to the last four typed digits");
    assert.ok(ws.maskedNumber(n).endsWith(n.slice(-4)));
    assert.match(body, /<input type="hidden" name="number" value="[^"]*"><input type="hidden" name="t" value="\d+">/);
    assert.match(body, /<input id="code" type="text" name="code" autocomplete="one-time-code"/);
    assert.match(body, /href="\/web\?join=1"/, "the way in for somebody new");
    assert.doesNotMatch(body, /808/);
  }
  // The join block: the live line's number as an sms: link ("Text Reason →", Messages opens with
  // "Hey" typed) and as a QR of that link — on the sign-in page everybody sees before any number is
  // typed, and on the join page. The number itself is never written on the page (owner 10-26).
  for (const body of [(await req(h)).body, (await req(h, { query: { join: "1" } })).body]) {
    assert.ok(body.includes(`<a class="act" href="sms:${LINE}&amp;body=Hey">Text Reason <span aria-hidden="true">→</span></a>`), "Text Reason → opens Messages to the live line with Hey prefilled");
    assert.match(body, /<figure class="qr"><svg[^>]*aria-label="QR code to text Reason"/, "the QR of that link");
    assert.doesNotMatch(body.replace(/href="sms:[^"]*"/g, ""), /656|216-?7455|so-num/, "no visible number");
    assert.match(body, /then come back here to sign in\./);
    assert.doesNotMatch(body, /808/);
  }
  const signin = (await req(h)).body;
  assert.match(signin, /<section class="so-join"[^>]*><p class="lbl">NEW TO REASON<\/p>/);
  assert.match(signin, /Your first text<br><em>is the sign-up\.<\/em>/);
  // Only the person's own channel address was texted; the stranger's number appears nowhere but the echo.
  assert.deepEqual(h.channel.sent.map(m => m.to), [KOFI]);
});

test("the QR is a real QR of the sms: link", async () => {
  const { qrMatrix, qrSvg } = await import("../src/pages/qr.js");
  const m = qrMatrix(`sms:${LINE}&body=Hey`);
  assert.equal(m.length, 25, "version 2 for a 25-byte link");
  // The three finders, as the camera finds them: dark corner, dark centre, light ring between.
  for (const [r, c] of [[0, 0], [0, 18], [18, 0]]) { assert.equal(m[r][c], true); assert.equal(m[r + 3][c + 3], true); assert.equal(m[r + 1][c + 1], false); }
  assert.match(qrSvg("x"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(qrSvg("<script>"), /<script/);
});

test("no live texting line: the join block says so and shows no number — never a registered-but-dead linq one", async () => {
  const h = harness();
  const dead = new Router();
  dead.register(new ConsoleChannel());
  dead.register(new LinqChannel());
  assert.equal(dead.get("linq").status().status, "not_connected");
  const out = await req(h, { router: dead });
  assert.match(out.body, /We can(&#39;|')t finish joining right now\./);
  assert.doesNotMatch(out.body, /sms:|<figure class="qr"|<svg[^>]*aria-label="QR|8083199759|319-9759/);
  // The join page itself (6E): the same, and the way back to sign in.
  const join = await req(h, { router: dead, query: { join: "1" } });
  assert.match(join.body, /We can(&#39;|')t finish joining right now\./);
  assert.match(join.body, /ALREADY A MEMBER\? SIGN IN →/);
  assert.doesNotMatch(join.body, /sms:|<figure class="qr"|<svg[^>]*aria-label="QR|8083199759|319-9759/);
});

test("linq registered but not live, sendblue live: only the Sendblue number is on the page, in either order", async () => {
  const h = harness();
  for (const order of [[new LinqChannel(), new SendblueChannel()], [new SendblueChannel(), new LinqChannel()]]) {
    const r = new Router();
    r.register(new ConsoleChannel());
    for (const ch of order) r.register(ch);
    const out = await req(h, { router: r });
    assert.ok(out.body.includes(`sms:${LINE}`));
    assert.doesNotMatch(out.body, /808|319-9759|8083199759/);
  }
});

// ---------- the code: wrong, reused, expired, too many, a flood ----------

test("the happy path: the code text is keyed wsign:, bound to the Web host, and never in the per-message history", async () => {
  const h = harness();
  const s = await signedIn(h);
  const text = h.channel.sent[0].text;
  assert.match(text, /^Your Reason code is \d{6}, to open Reason on the web in that browser\./);
  assert.equal(text.split("\n").at(-1), `@heyreason.test #${codesTo(h, KOFI)[0]}`);
  const row = db.db.prepare("SELECT idem_key, conversation_id, state FROM outbox").get();
  assert.equal(row.conversation_id, KOFI_C);
  assert.match(row.idem_key, new RegExp(`^wsign:${KOFI_C.replace(/[+:]/g, "\\$&")}:\\d+$`));
  assert.equal(row.state, "sent");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0, "a code is a secret, not history");
  const sess = db.db.prepare("SELECT * FROM page_sessions WHERE token = ?").get(s.token);
  assert.equal(sess.conversation_id, KOFI_C);
  assert.equal(sess.page_id, ws.signinKey(KOFI_C));
  // The cookie: on every path, shared across heyreason.com (decision 3; test/domains.test.js), HttpOnly,
  // Secure, SameSite=Lax; the form cookie is cleared with it.
  const set = setCookies(s.out);
  assert.match(set.find(c => c.startsWith("reason_page=")), /; Path=\/; Domain=heyreason\.test; Max-Age=7776000; HttpOnly; SameSite=Lax; Secure$/);
  assert.match(set.find(c => c.startsWith(`${ws.FORM_COOKIE}=`)), /Max-Age=0/);
  // Logged: that it went, never the number or the code.
  const mine = h.logs.filter(l => l && typeof l === "object" && Object.keys(l).some(k => k.startsWith("web_sign")));
  assert.ok(mine.some(l => l.web_signin_code_sent) && mine.some(l => l.web_signin_ok), "the sign-in logs that it happened");
  const logged = JSON.stringify(mine);
  assert.ok(!logged.includes(KOFI.slice(2)), "the sign-in log lines name no number");
  assert.ok(!logged.includes(codesTo(h, KOFI)[0]), "the code is in no log line");
});

const WRONG = /that(&#39;|')s not it\. try again\?/;

test("wrong, reused and expired codes are one answer; a new code kills the old; a fourth request in the window texts nothing", async () => {
  const h = harness();
  const b = await fresh(h);
  await ask(h, b, KOFI);
  const first = codesTo(h, KOFI)[0];
  // Wrong.
  const wrong = await typeCode(h, b, KOFI, first === "000000" ? "000001" : "000000");
  assert.equal(wrong.status, 200);
  assert.match(wrong.body, WRONG);
  // A second request: the first code is dead.
  await ask(h, b, KOFI);
  const second = codesTo(h, KOFI)[1];
  assert.notEqual(first, second);
  assert.match((await typeCode(h, b, KOFI, first)).body, WRONG);
  // The third is the last in fifteen minutes; the fourth asks for nothing and says nothing different.
  await ask(h, b, KOFI);
  const fourth = await ask(h, b, KOFI, { expectText: false });
  assert.equal(fourth.status, 200);
  assert.equal(codesTo(h, KOFI).length, 3);
  assert.ok(h.logs.some(l => l.web_signin_code_refused === "too_many_sent"));
  // "Send a new code" from this browser past three in the quarter hour: says so, texts nothing.
  const sentBefore = h.channel.sent.length;
  const resend = await req(h, { sub: "signin", method: "POST", body: form({ number: KOFI, f: b.f, again: "1" }), cookie: b.jar });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(resend.status, 200);
  assert.match(resend.body, /i(&#39;|')ve sent a few\. give it a moment\./);
  assert.equal(h.channel.sent.length, sentBefore, "no text went");
  // The same for a number nobody holds: the limit is the browser's, not the number's.
  const resendNobody = await req(h, { sub: "signin", method: "POST", body: form({ number: NOBODY, f: b.f, again: "1" }), cookie: b.jar });
  assert.equal(withoutNumber(resendNobody.body, NOBODY), withoutNumber(resend.body, KOFI));
  // The live one works once.
  const live = codesTo(h, KOFI)[2];
  const ok = await typeCode(h, b, KOFI, live);
  assert.equal(ok.status, 303);
  const again = await typeCode(h, b, KOFI, live);
  assert.equal(again.status, 200, "a used code is just wrong");
  assert.match(again.body, WRONG);
  // Expired: a fresh code, typed sixteen minutes later. The code is refused; the page says so by this
  // browser's own clock (`t`), and offers a fresh one.
  clock.skip(16 * MIN);
  const asked = await ask(h, b, KOFI);
  const late = codesTo(h, KOFI)[3];
  clock.skip(16 * MIN);
  const expired = await typeCode(h, b, KOFI, late, { t: askedAt(asked.body) });
  assert.equal(expired.status, 200);
  assert.match(expired.body, /that one expired\./);
  assert.match(expired.body, /Send a fresh one/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 1, "only the one live code ever opened anything");
});

test("a flood of wrong codes locks the browser out, says only that, and the person's real code still works elsewhere", async () => {
  const h = harness();
  const b = await fresh(h);
  await ask(h, b, KOFI);
  const code = codesTo(h, KOFI)[0];
  for (let i = 0; i < 5; i++) assert.equal((await typeCode(h, b, KOFI, "111111", { ip: "198.51.100.7" })).status, 200);
  const locked = await typeCode(h, b, KOFI, code, { ip: "198.51.100.7" });
  assert.equal(locked.status, 429, "the right code from a locked browser is refused too");
  assert.match(locked.body, /let(&#39;|')s pause a minute\./);
  assert.match(locked.body, /TRY AGAIN IN <span class="left">\d+:\d\d<\/span>/);
  // The same flood as a stranger's number costs the same and says the same.
  const other = await fresh(h);
  for (let i = 0; i < 5; i++) await typeCode(h, other, NOBODY, "222222", { ip: "198.51.100.8" });
  const lockedToo = await typeCode(h, other, NOBODY, "222222", { ip: "198.51.100.8" });
  assert.equal(lockedToo.status, 429);
  // Two browsers, so two form tokens and two countdowns of their own: the same page otherwise.
  const wait = (body) => body.replace(/data-left="\d+"/g, 'data-left="L"').replace(/<span class="left">\d+:\d\d<\/span>/g, "<span class=\"left\">L</span>");
  assert.equal(wait(withoutNumber(lockedToo.body, NOBODY).replaceAll(other.f, "F")), wait(withoutNumber(locked.body, KOFI).replaceAll(b.f, "F")));
  // Kofi, on his own browser, is fine.
  const mine = await fresh(h);
  assert.equal((await typeCode(h, mine, KOFI, code, { ip: "203.0.113.50" })).status, 303);
});

// ---------- two people ----------

test("two people never cross: a session is one person's, and one's code never opens the other's number", async () => {
  const h = harness();
  const kofi = await signedIn(h, KOFI, KOFI);
  const b = await fresh(h);
  await ask(h, b, AMA);
  const amaCode = codesTo(h, AMA)[0];
  // Ama's code typed under Kofi's number: wrong, and Kofi's session count is unchanged.
  assert.equal((await typeCode(h, b, KOFI, amaCode)).status, 200);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions WHERE conversation_id = ?").get(KOFI_C).n, 1);
  // Ama's code as Ama: in, as Ama.
  const ok = await typeCode(h, b, AMA, amaCode);
  assert.equal(ok.status, 303);
  const ama = `reason_page=${cookieValue(ok, "reason_page")}`;
  await firstVisit(h, ama);
  await firstVisit(h, kofi.jar);
  assert.match((await req(h, { cookie: ama })).body, /What(&#39;|')s good, Ama\?/);
  assert.match((await req(h, { cookie: kofi.jar })).body, /What(&#39;|')s good, Kofi\?/);
  assert.doesNotMatch((await req(h, { cookie: ama })).body, /Kofi/);
  // Signing Ama out leaves Kofi in.
  const csrf = /name="c" value="([^"]+)"/.exec((await req(h, { cookie: ama })).body)[1];
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: ama })).status, 303);
  assert.match((await req(h, { cookie: ama })).body, SIGNIN);
  assert.match((await req(h, { cookie: kofi.jar })).body, /What(&#39;|')s good, Kofi\?/);
});

test("one number, two accounts: the most recently used one gets the code, and the page never mentions either (decision 4)", async () => {
  const h = harness();
  const OLD = "dm:linq:+15105550123", NEW = "dm:sendblue:+15105550123", N = "+15105550123";
  db.upsertAccount({ conversationId: OLD, channel: "linq", address: N, name: "Yaw" });
  db.upsertAccount({ conversationId: NEW, channel: "sendblue", address: N, name: "Yaw" });
  for (const c of [OLD, NEW]) db.upsertThread({ conversationId: c, channel: "fake", address: N, isOwner: true });
  db.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE conversation_id = ?").run(clock.now() - 10 * DAY, OLD);
  db.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE conversation_id = ?").run(clock.now() - 1 * DAY, NEW);
  assert.equal(ws.accountForNumber(N).conversation_id, NEW);
  assert.equal(ws.accountForNumber("(510) 555-0123").conversation_id, NEW, "ten digits typed the way people type them");
  const b = await fresh(h);
  const out = await ask(h, b, N);
  assert.equal(db.db.prepare("SELECT conversation_id FROM outbox").get().conversation_id, NEW);
  assert.doesNotMatch(out.body, /linq|sendblue|Yaw|another account|other account|two accounts/i);
  // The other way round.
  db.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE conversation_id = ?").run(clock.now(), OLD);
  assert.equal(ws.accountForNumber(N).conversation_id, OLD);
});

// ---------- the session: revoked, idle, old ----------

test("sign-out revokes the session: only with the session's own secret, only from Reason's own page", async () => {
  const h = harness();
  const s = await signedIn(h);
  await firstVisit(h, s.jar);
  const csrf = /name="c" value="([^"]+)"/.exec((await req(h, { cookie: s.jar })).body)[1];
  // No secret: refused, still signed in.
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({}), cookie: s.jar })).status, 403);
  // The right secret from another site: refused, still signed in.
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: s.jar, origin: "https://evil.example" })).status, 403);
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: s.jar, sfs: "cross-site" })).status, 403);
  assert.match((await req(h, { cookie: s.jar })).body, /What(&#39;|')s good, Kofi\?/);
  // No cookie at all: nothing to do, nothing touched.
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: "" })).status, 303);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 1);
  // The real thing.
  const out = await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: s.jar });
  assert.equal(out.status, 303);
  assert.equal(out.headers.Location, "/web?out=1");
  assert.match(setCookies(out)[0], /^reason_page=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 0, "the row is gone, so the cookie opens nothing anywhere");
  const gone = (await req(h, { cookie: s.jar })).body;
  assert.match(gone, SIGNIN);
  assert.match(gone, SIGNED_OUT, "a cookie whose session is gone: told it was signed out");
  assert.match((await req(h, { query: { out: "1" } })).body, SIGNED_OUT, "where sign-out lands");
  assert.doesNotMatch((await req(h)).body, SIGNED_OUT, "a fresh browser is told nothing of the kind");
  assert.equal((await req(h, { sub: "signout", method: "GET" })).status, 405);
});

test("a session is over after 30 idle days or 90 days of age, whichever first", async () => {
  const h = harness();
  const s = await signedIn(h);
  await firstVisit(h, s.jar);
  db.db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now() - 29 * DAY, s.token);
  assert.match((await req(h, { cookie: s.jar })).body, /What(&#39;|')s good, /, "29 idle days: still in, and touched");
  db.db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now() - 31 * DAY, s.token);
  assert.match((await req(h, { cookie: s.jar })).body, SIGNIN, "31 idle days: out");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 0);
  const t = await signedIn(h);
  db.db.prepare("UPDATE page_sessions SET created_at = ?, last_seen_at = ? WHERE token = ?").run(clock.now() - 91 * DAY, clock.now(), t.token);
  assert.match((await req(h, { cookie: t.jar })).body, SIGNIN, "91 days old: out however recently used");
});

test("a paused account's browser is signed out, like every private page", async () => {
  const h = harness();
  const s = await signedIn(h);
  db.db.prepare("UPDATE accounts SET state = 'paused' WHERE conversation_id = ?").run(KOFI_C);
  assert.match((await req(h, { cookie: s.jar })).body, SIGNIN);
  // And a paused number asking for a code gets the same page as a stranger, with no text.
  const b = await fresh(h);
  await ask(h, b, KOFI, { expectText: false });
});

// ---------- CSRF, origin, headers ----------

test("a sign-in form without its browser's token, or from another site, starts over and texts nobody", async () => {
  const h = harness();
  const b = await fresh(h);
  // No form cookie at all.
  let out = await req(h, { sub: "signin", method: "POST", body: form({ number: KOFI, f: b.f }), cookie: "" });
  assert.equal(out.status, 403);
  assert.ok(cookieValue(out, ws.FORM_COOKIE), "handed a fresh token to try again with");
  // A token that is not the cookie's.
  out = await req(h, { sub: "signin", method: "POST", body: form({ number: KOFI, f: "stolen" }), cookie: b.jar });
  assert.equal(out.status, 403);
  // The right token, posted from another site.
  out = await req(h, { sub: "signin", method: "POST", body: form({ number: KOFI, f: b.f }), cookie: b.jar, origin: "https://evil.example" });
  assert.equal(out.status, 403);
  out = await req(h, { sub: "code", method: "POST", body: form({ number: KOFI, code: "123456", f: b.f }), cookie: b.jar, sfs: "cross-site" });
  assert.equal(out.status, 403);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.channel.sent.length, 0, "no code went");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_codes").get().n, 0);
  // Our own hosts are fine: the website, the pages host, Reason's own address, and no Origin at all.
  for (const origin of ["https://heyreason.test", "https://files.heyreason.test", "https://reason.example.test", null]) {
    assert.equal((await req(h, { sub: "signin", method: "POST", body: form({ number: NOBODY, f: b.f }), cookie: b.jar, origin })).status, 200, String(origin));
  }
});

// 10-26: the owner's own Safari got "That didn't come from this page" through Caddy. The page said
// `no-referrer`, so the browser posted `Origin: null` (WebKit and Chromium both). This is the request
// exactly as Caddy hands it on for files.heyreason.com.
test("a real browser's post through the files-host proxy is ours: Origin null + same-origin passes; cross-site and unvouched null still fail", async () => {
  const h = harness();
  const b = await fresh(h);
  const proxied = (extra) => webRequestFor({ sub: "signin", method: "POST", query: {}, remoteAddress: "127.0.0.1", readBody: async () => form({ number: NOBODY, f: b.f }), runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e),
    headers: { host: "files.heyreason.test", "x-forwarded-for": "198.51.100.7", "x-forwarded-host": "files.heyreason.test", "x-forwarded-proto": "https", "x-files-domain": "true", "content-type": "application/x-www-form-urlencoded", cookie: b.jar, ...extra } });
  const refused = (out) => out.status === 403 && h.logs.at(-1)?.web_signin_refused === "origin_or_token";
  for (const ok of [{ origin: "null", "sec-fetch-site": "same-origin" }, { origin: "https://files.heyreason.test", "sec-fetch-site": "same-origin" }, {}]) {
    const out = await proxied(ok);
    assert.equal(out.status, 200, JSON.stringify(ok));
    assert.ok(!refused(out), JSON.stringify(ok));
  }
  for (const bad of [{ origin: "null" }, { origin: "null", "sec-fetch-site": "cross-site" }, { origin: "null", "sec-fetch-site": "same-site" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }]) {
    assert.ok(refused(await proxied(bad)), JSON.stringify(bad));
  }
  // The page itself must let the browser name its origin on the post: the header and the shell's
  // <meta> both say same-origin (a <meta> no-referrer would override the header).
  const page = await req(h);
  assert.equal(page.headers["Referrer-Policy"], "same-origin");
  assert.match(page.body, /<meta name="referrer" content="same-origin">/);
  assert.doesNotMatch(page.body, /content="no-referrer"/);
});

// 10-26 owner: Web wears the design handoff's kit (src/pages/webkit.js): Instrument Serif and Caveat
// self-hosted at /web/fonts, typed Courier labels, dashed rules, the reas◯n wordmark.
test("the pages wear the kit: serif and hand faces from /web/fonts only, mono labels, dashed rules, the wordmark", async () => {
  const convo = await import("../src/pages/webconvo.js");
  const pages = {
    signin: ws.renderSignin({ joinNumber: LINE, formToken: "t" }),
    code: ws.renderCode({ number: KOFI, joinNumber: LINE, formToken: "t" }),
    join: ws.renderJoin({ joinNumber: LINE }),
    first: convo.renderFirstVisit({ account: { name: "Kofi" } }),
    home: convo.renderHome({ account: { name: "Kofi" }, csrf: "c", sendId: "s" }),
  };
  for (const [name, page] of Object.entries(pages)) {
    assert.match(page, /@font-face\{font-family:"Reason Serif";font-style:italic;[^}]*src:url\(\/web\/fonts\/serif\.woff2\)/, name);
    assert.match(page, /@font-face\{font-family:"Reason Hand";[^}]*src:url\(\/web\/fonts\/hand\.woff2\)/, name);
    assert.match(page, /--serif:"Reason Serif","Instrument Serif"/, name);
    assert.match(page, /--hand:"Reason Hand",Caveat/, name);
    assert.match(page, /--mono:"Courier New",Courier,monospace/, name);
    assert.match(page, /border-top:1px dashed var\(--hair\)/, `${name}: dashed rules`);
    assert.match(page, /<a class="wm" href="\/web" aria-label="Reason, home">reas<svg class="bub" aria-hidden="true" viewBox="0 0 40 40">/, `${name}: the wordmark`);
    assert.doesNotMatch(page, /fonts\.googleapis|fonts\.gstatic/, `${name}: nothing from Google`);
    for (const url of page.matchAll(/url\(([^)]+)\)/g)) assert.match(url[1], /^\/web\/fonts\/[a-z]+\.woff2$/, `${name}: ${url[1]}`);
  }

  // The fonts: served while on, cached, the right bytes; the CSP lets the page load them and nothing else.
  assert.match(ws.SECURITY_HEADERS["Content-Security-Policy"], /font-src 'self' data:;/);
  config.web = true;
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const name of ["serif", "roman", "hand", "handbold", "sans"]) {
      const r = await fetch(`${base}/web/fonts/${name}.woff2`);
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get("content-type"), "font/woff2");
      assert.match(r.headers.get("cache-control"), /max-age=\d+/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
      assert.ok(bytes.length < 40_000, `${name} is the Latin cut, not the whole face`);
    }
    const ghost = await fetch(`${base}/no-such-thing`);
    const ghostBody = await ghost.text();
    for (const path of ["/web/fonts/nope.woff2", "/web/fonts/constructor.woff2", "/web/fonts/__proto__.woff2", "/web/fonts/%2e%2e/db.woff2", "/web/fonts/%2e%2e%2fserif.woff2"]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, ghost.status, path);
    }
    const head = await fetch(`${base}/web/fonts/serif.woff2`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "font/woff2");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const post = await fetch(`${base}/web/fonts/serif.woff2`, { method: "POST", body: "x" });
    assert.equal(post.status, ghost.status, "a post to a font path is the flat 404");
    config.web = false;
    const off = await fetch(`${base}/web/fonts/serif.woff2`);
    assert.equal(off.status, ghost.status);
    assert.equal(await off.text(), ghostBody, "off, a font path is the same flat 404");
  } finally { config.web = true; await new Promise(r => server.close(r)); }
});

test("every answer carries the security headers; the pages carry no preview tags and no number but the live line's", async () => {
  const h = harness();
  const b = await fresh(h);
  const s = await signedIn(h);
  const answers = [await req(h), await ask(h, b, NOBODY, { expectText: false }), await typeCode(h, b, NOBODY, "000000"), await req(h, { cookie: s.jar }), await req(h, { sub: "signin", method: "GET" })];
  for (const out of answers) {
    for (const [k, v] of Object.entries(ws.SECURITY_HEADERS)) assert.equal(out.headers[k], v, k);
    assert.doesNotMatch(String(out.body), /og:|twitter:/);
    assert.doesNotMatch(String(out.body), /808/);
  }
  assert.equal(answers.at(-1).status, 303, "GET on a POST-only step just goes back to /web");
  // Signed in, a posted sign-in form is a redirect home, not a second code.
  assert.equal((await req(h, { sub: "signin", method: "POST", body: form({ number: AMA, f: b.f }), cookie: `${s.jar}; ${b.jar}` })).status, 303);
});

test("the copy coaches no phrase: intent words only; the sms: body and the three tap-to-fill examples are the only prefilled words", async () => {
  const convo = await import("../src/pages/webconvo.js");
  const html = [
    ws.renderSignin({ joinNumber: LINE, formToken: "t" }),
    ws.renderSignin({ joinNumber: LINE, formToken: "t", out: true }),
    ws.renderSignin({ joinNumber: null, formToken: "t", error: { kind: "origin" } }),
    ws.renderSignin({ joinNumber: LINE, formToken: "t", number: KOFI, error: { kind: "pause", waitMs: 90_000 } }),
    ...[null, { kind: "wrong" }, { kind: "expired" }, { kind: "tries", waitMs: 60_000 }, { kind: "resend", leftMs: 5 * MIN }]
      .map(error => ws.renderCode({ number: KOFI, joinNumber: LINE, formToken: "t", error })),
    ws.renderJoin({ joinNumber: LINE }),
    ws.renderJoin({ joinNumber: null }),
    convo.renderFirstVisit({ account: { name: "Kofi" } }),
    convo.renderHome({ account: { name: "Kofi" }, csrf: "c", sendId: "s" }),
    convo.renderOngoing({ csrf: "c" }),
    convo.renderError(),
    convo.soonPage({ which: "memory", account: { name: "Kofi" }, headers: {} }),
    convo.soonPage({ which: "settings", account: { name: "Kofi" }, headers: {} }),
  ].join("\n");
  // Words a person reads (not the scripts and styles), with the owner's three example requests — which
  // a tap puts in the composer, and nothing sends until they do — taken out first.
  let text = html.replace(/<(script|style)>[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ");
  for (const ex of convo.EXAMPLES) {
    const quoted = `"${esc(ex)}"`;
    assert.ok(text.includes(quoted), `${ex}: on the arrival`);
    text = text.replaceAll(quoted, " ");
  }
  assert.doesNotMatch(text, /["“”]|&quot;/, "no other quoted words anywhere");
  assert.doesNotMatch(text, /\b(say|text|reply|type|send)\s+(&quot;|["“'‘])/i);
  assert.doesNotMatch(text, /\b(reply|say|type)\s+[A-Z]{2,}\b/, "no 'reply YES'-style coaching");
  assert.ok(html.includes(`href="sms:${LINE}&amp;body=Hey"`), "the sms: body is the only prefilled text");
  for (const m of html.matchAll(/href="(sms:[^"]*)"/g)) assert.equal(m[1], `sms:${LINE}&amp;body=Hey`, "every sms: link prefills only the hello");
});
