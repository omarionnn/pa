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
async function req(h, { sub = null, method = "GET", body = null, cookie = "", origin = "https://heyreason.test", sfs = null, ip = "203.0.113.9", router = h.router } = {}) {
  const headers = { host: "heyreason.test", cookie, "x-forwarded-for": ip, "x-files-domain": "true" };
  if (origin) headers.origin = origin;
  if (sfs) headers["sec-fetch-site"] = sfs;
  return await webRequestFor({ sub, method, query: {}, headers, remoteAddress: "127.0.0.1", readBody: async () => body, runtime: h.runtime, router, log: (e) => h.logs.push(e) });
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
const typeCode = (h, b, number, code, { ip } = {}) => req(h, { sub: "code", method: "POST", body: form({ number, code, f: b.f }), cookie: b.jar, ip });
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
const withoutNumber = (body, n) => body.replaceAll(n, "N");

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
    assert.match(await on.text(), /Sign in with the number you text Reason from/);
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
  const landing = await req(h, { cookie: `reason_page=${cookieValue(ok, "reason_page")}` });
  assert.match(landing.body, /You(&#39;|')re in, Omari\./);
});

test("a person signed in while `on` is signed out the moment the switch is back to `owner` — not told why, not 404", async () => {
  const h = harness();
  const s = await signedIn(h);
  assert.match((await req(h, { cookie: s.jar })).body, /You(&#39;|')re in, Kofi/);
  config.web = "owner";
  const out = await req(h, { cookie: s.jar });
  assert.equal(out.status, 200);
  assert.match(out.body, /Sign in with the number you text Reason from/);
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
  // The join block: the live line's number, as an sms: link, as a QR, and written out — on the page
  // for a stranger and for Kofi alike, and on the first page before any number is typed.
  for (const body of [known.body, unknown.body, (await req(h)).body]) {
    assert.match(body, /New to Reason\?/);
    assert.ok(body.includes(`href="sms:${LINE}?&amp;body=Hi"`), "the sms: link to the live line, with a hello prefilled");
    assert.match(body, /<svg[^>]*aria-label="Text Reason at \+1 \(656\) 216-7455"/, "the QR of that link");
    assert.match(body, /text Reason at <b class="w-num">\+1 \(656\) 216-7455<\/b>/, "the number written out");
    assert.doesNotMatch(body, /808/);
  }
  // Only the person's own channel address was texted; the stranger's number appears nowhere but the echo.
  assert.deepEqual(h.channel.sent.map(m => m.to), [KOFI]);
});

test("the QR is a real QR of the sms: link", async () => {
  const { qrMatrix, qrSvg } = await import("../src/pages/qr.js");
  const m = qrMatrix(`sms:${LINE}?&body=Hi`);
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
  assert.match(out.body, /texting line isn(&#39;|')t connected right now/);
  assert.doesNotMatch(out.body, /sms:|<figure class="w-qr"|<a class="w-btn"|8083199759|319-9759/);
});

test("linq registered but not live, sendblue live: only the Sendblue number is on the page, in either order", async () => {
  const h = harness();
  for (const order of [[new LinqChannel(), new SendblueChannel()], [new SendblueChannel(), new LinqChannel()]]) {
    const r = new Router();
    r.register(new ConsoleChannel());
    for (const ch of order) r.register(ch);
    const out = await req(h, { router: r });
    assert.ok(out.body.includes(`sms:${LINE}`));
    assert.match(out.body, /\+1 \(656\) 216-7455/);
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
  // The cookie: on every path, HttpOnly, Secure, SameSite=Lax; the form cookie is cleared with it.
  const set = setCookies(s.out);
  assert.match(set.find(c => c.startsWith("reason_page=")), /; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax; Secure$/);
  assert.match(set.find(c => c.startsWith(`${ws.FORM_COOKIE}=`)), /Max-Age=0/);
  // Logged: that it went, never the number or the code.
  const mine = h.logs.filter(l => l && typeof l === "object" && Object.keys(l).some(k => k.startsWith("web_sign")));
  assert.ok(mine.some(l => l.web_signin_code_sent) && mine.some(l => l.web_signin_ok), "the sign-in logs that it happened");
  const logged = JSON.stringify(mine);
  assert.ok(!logged.includes(KOFI.slice(2)), "the sign-in log lines name no number");
  assert.ok(!logged.includes(codesTo(h, KOFI)[0]), "the code is in no log line");
});

test("wrong, reused and expired codes are one answer; a new code kills the old; a fourth request in the window texts nothing", async () => {
  const h = harness();
  const b = await fresh(h);
  await ask(h, b, KOFI);
  const first = codesTo(h, KOFI)[0];
  // Wrong.
  const wrong = await typeCode(h, b, KOFI, first === "000000" ? "000001" : "000000");
  assert.equal(wrong.status, 200);
  assert.match(wrong.body, /That code isn(&#39;|')t right\./);
  // A second request: the first code is dead.
  await ask(h, b, KOFI);
  const second = codesTo(h, KOFI)[1];
  assert.notEqual(first, second);
  assert.match((await typeCode(h, b, KOFI, first)).body, /That code isn(&#39;|')t right\./);
  // The third is the last in fifteen minutes; the fourth asks for nothing and says nothing different.
  await ask(h, b, KOFI);
  const fourth = await ask(h, b, KOFI, { expectText: false });
  assert.equal(fourth.status, 200);
  assert.equal(codesTo(h, KOFI).length, 3);
  assert.ok(h.logs.some(l => l.web_signin_code_refused === "too_many_sent"));
  // The live one works once.
  const live = codesTo(h, KOFI)[2];
  const ok = await typeCode(h, b, KOFI, live);
  assert.equal(ok.status, 303);
  const again = await typeCode(h, b, KOFI, live);
  assert.equal(again.status, 200, "a used code is just wrong");
  assert.match(again.body, /That code isn(&#39;|')t right\./);
  // Expired: a fresh code, sixteen minutes later.
  clock.skip(16 * MIN);
  await ask(h, b, KOFI);
  const late = codesTo(h, KOFI)[3];
  clock.skip(16 * MIN);
  assert.match((await typeCode(h, b, KOFI, late)).body, /That code isn(&#39;|')t right\./);
});

test("a flood of wrong codes locks the browser out, says only that, and the person's real code still works elsewhere", async () => {
  const h = harness();
  const b = await fresh(h);
  await ask(h, b, KOFI);
  const code = codesTo(h, KOFI)[0];
  for (let i = 0; i < 5; i++) assert.equal((await typeCode(h, b, KOFI, "111111", { ip: "198.51.100.7" })).status, 200);
  const locked = await typeCode(h, b, KOFI, code, { ip: "198.51.100.7" });
  assert.equal(locked.status, 429, "the right code from a locked browser is refused too");
  assert.match(locked.body, /Too many wrong codes from this browser/);
  // The same flood as a stranger's number costs the same and says the same.
  const other = await fresh(h);
  for (let i = 0; i < 5; i++) await typeCode(h, other, NOBODY, "222222", { ip: "198.51.100.8" });
  const lockedToo = await typeCode(h, other, NOBODY, "222222", { ip: "198.51.100.8" });
  assert.equal(lockedToo.status, 429);
  // Two browsers, so two form tokens: the same page otherwise.
  assert.equal(withoutNumber(lockedToo.body, NOBODY).replaceAll(other.f, "F"), withoutNumber(locked.body, KOFI).replaceAll(b.f, "F"));
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
  assert.match((await req(h, { cookie: ama })).body, /You(&#39;|')re in, Ama\./);
  assert.match((await req(h, { cookie: kofi.jar })).body, /You(&#39;|')re in, Kofi\./);
  assert.doesNotMatch((await req(h, { cookie: ama })).body, /Kofi/);
  // Signing Ama out leaves Kofi in.
  const csrf = /name="c" value="([^"]+)"/.exec((await req(h, { cookie: ama })).body)[1];
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: ama })).status, 303);
  assert.match((await req(h, { cookie: ama })).body, /Sign in with the number/);
  assert.match((await req(h, { cookie: kofi.jar })).body, /You(&#39;|')re in, Kofi\./);
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
  const csrf = /name="c" value="([^"]+)"/.exec((await req(h, { cookie: s.jar })).body)[1];
  // No secret: refused, still signed in.
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({}), cookie: s.jar })).status, 403);
  // The right secret from another site: refused, still signed in.
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: s.jar, origin: "https://evil.example" })).status, 403);
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: s.jar, sfs: "cross-site" })).status, 403);
  assert.match((await req(h, { cookie: s.jar })).body, /You(&#39;|')re in, Kofi/);
  // No cookie at all: nothing to do, nothing touched.
  assert.equal((await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: "" })).status, 303);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 1);
  // The real thing.
  const out = await req(h, { sub: "signout", method: "POST", body: form({ c: csrf }), cookie: s.jar });
  assert.equal(out.status, 303);
  assert.match(setCookies(out)[0], /^reason_page=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 0, "the row is gone, so the cookie opens nothing anywhere");
  assert.match((await req(h, { cookie: s.jar })).body, /Sign in with the number/);
  assert.equal((await req(h, { sub: "signout", method: "GET" })).status, 405);
});

test("a session is over after 30 idle days or 90 days of age, whichever first", async () => {
  const h = harness();
  const s = await signedIn(h);
  db.db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now() - 29 * DAY, s.token);
  assert.match((await req(h, { cookie: s.jar })).body, /You(&#39;|')re in/, "29 idle days: still in, and touched");
  db.db.prepare("UPDATE page_sessions SET last_seen_at = ? WHERE token = ?").run(clock.now() - 31 * DAY, s.token);
  assert.match((await req(h, { cookie: s.jar })).body, /Sign in with the number/, "31 idle days: out");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM page_sessions").get().n, 0);
  const t = await signedIn(h);
  db.db.prepare("UPDATE page_sessions SET created_at = ?, last_seen_at = ? WHERE token = ?").run(clock.now() - 91 * DAY, clock.now(), t.token);
  assert.match((await req(h, { cookie: t.jar })).body, /Sign in with the number/, "91 days old: out however recently used");
});

test("a paused account's browser is signed out, like every private page", async () => {
  const h = harness();
  const s = await signedIn(h);
  db.db.prepare("UPDATE accounts SET state = 'paused' WHERE conversation_id = ?").run(KOFI_C);
  assert.match((await req(h, { cookie: s.jar })).body, /Sign in with the number/);
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
    assert.equal((await ask(h, b, NOBODY, { expectText: false })).status, 200, String(origin));
  }
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

test("the copy coaches no phrase: intent words only, and the sms: body is the only prefilled text", () => {
  const html = ws.renderSignin({ joinNumber: LINE, formToken: "t", sent: true, number: KOFI }) + ws.renderLanding({ account: { name: "Kofi" }, csrf: "c" });
  const text = html.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(text, /\b(say|text|reply|type|send)\s+["“]/i);
  assert.match(text, /text Reason at\s+\+1 \(656\) 216-7455\s*, or point its camera at this code/);
});
