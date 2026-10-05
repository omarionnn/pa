// Signing in from a phone: a link that shows somebody Reason's own browser. No browser is started
// here — the browser is a stand-in that records what it was asked to do — and no site is touched.
//
//   does a link preview, or a second person with the link, get the session?   (no — first Start, one device)
//   is anything that was typed kept anywhere?                                  (no — not the log, the database, or the session)
//   is "signed in" ever what the person said rather than what the site said?   (no — the site is asked at every ending)
//   does an unopened link hold the saved profile?                              (no — nothing launches before Start)
//   can a page be driven to arbitrary keys, coordinates or sizes?              (no — a short list, clamped)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-remote-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const remote = await import("../src/signin-remote.js");
const signin = await import("../src/signin.js");
const sites = await import("../src/sites.js");
const { runTool } = await import("../src/tools.js");
const { createServer } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const amazon = sites.site("amazon");
const SECRET_TYPED = "hunter2-correct-horse";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM connected_accounts; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.publicUrl = "https://reason.example";
  config.remoteSigninSettleMs = 0;
});

/** A browser that does nothing but write down what it was asked. */
function fakeBrowser() {
  const did = [];
  const page = {
    screenshot: async (o) => { did.push(["screenshot", o]); return Buffer.from([0xff, 0xd8, 0xff, 0xe0]); },
    mouse: { click: async (x, y) => { did.push(["click", x, y]); }, wheel: async (dx, dy) => { did.push(["wheel", dx, dy]); } },
    keyboard: { type: async (t) => { did.push(["type", t]); }, press: async (k) => { did.push(["press", k]); } },
    goBack: async () => { did.push(["back"]); },
  };
  const b = { did, launched: [], closed: 0 };
  b.launch = async (a) => { b.launched.push(a); return { page, close: async () => { b.closed++; } }; };
  return b;
}

function make({ conversationId = CONV, entry = amazon, said = { ok: true, state: "signed_in", why: "the order history page loaded" }, busy = () => null, launch = null } = {}) {
  const b = fakeBrowser();
  const logs = [];
  const booked = [];
  const released = [];
  const timers = { set: (fn, ms) => { const h = { fn, ms, cleared: false }; booked.push(h); return h; }, clear: (h) => { if (h) h.cleared = true; } };
  const checks = [];
  const out = remote.createRemoteSignin({
    conversationId, entry, launch: launch ?? b.launch, timers, busy, log: (e) => logs.push(e),
    closeBrowser: async (c) => { released.push(c); },
    check: async (page, c, site) => { checks.push([c, site]); return said; },
  });
  const token = out.url.split("/").pop();
  return { out, token, b, logs, booked, released, checks };
}

const req = (token, action = "", { method = "GET", cookie = "", body = null } = {}) =>
  remote.remoteRequest({ token, action, method, headers: cookie ? { cookie } : {}, readBody: async () => (body === null ? "" : JSON.stringify(body)) });

/** Tap Start, and come back with the cookie that browser was given. */
async function start(token) {
  const r = await req(token, "start", { method: "POST" });
  const cookie = String(r.headers["Set-Cookie"] ?? "").split(";")[0];
  return { r, cookie };
}
const notes = (c = CONV) => db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? ORDER BY id").all(c).map(r => r.note);

// ---------- the link ----------

test("a link is an address under the public URL, and making one launches nothing", () => {
  const { out, token, b, released } = make();
  assert.equal(out.ok, true);
  assert.equal(out.url, `https://reason.example/s/${token}`);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, "24 random bytes: not guessable, not enumerable");
  assert.equal(out.good_for_minutes, 10);
  assert.equal(out.reachable_from_a_phone, true);
  assert.equal(b.launched.length, 0, "an unopened link never holds the saved profile");
  assert.deepEqual(released, []);
  assert.deepEqual(remote.remoteSessionFor(CONV), { site: "amazon", started: false });
});

test("with no public address the link is made, and says it only opens on the machine", () => {
  config.publicUrl = "";
  const { out } = make();
  assert.equal(out.reachable_from_a_phone, false);
  assert.match(out.url, /^http:\/\/127\.0\.0\.1:\d+\/s\//);
  assert.match(out.why, /only opens on the machine/);
});

test("opening the link shows what it is and waits for a tap — a link preview takes nothing", async () => {
  const { token, b } = make();
  // What a preview fetcher, a crawler, or the person themselves sees first.
  for (let i = 0; i < 3; i++) {
    const page = await req(token);
    assert.equal(page.status, 200);
    assert.match(page.body, /Sign in to Amazon/);
    assert.match(page.body, /It is not saved, logged, or shown to the assistant/);
    assert.match(page.body, /Face ID and passkeys do not/);
    assert.match(page.body, new RegExp(`action="/s/${token}/start"`));
    assert.equal(page.headers["Cache-Control"], "no-store");
  }
  assert.equal(b.launched.length, 0, "three fetches and still no browser, and nobody owns the session");
  assert.equal((await req(token, "shot")).status, 404, "and nothing can be driven before Start");
});

test("Start launches the person's own profile on the site's sign-in page and hands that device the session", async () => {
  const { token, b, released, booked, logs } = make();
  const { r, cookie } = await start(token);
  assert.equal(r.status, 303);
  assert.equal(r.headers.Location, `/s/${token}`);
  assert.deepEqual(released, [CONV], "Reason's own browser let go of the profile first");
  assert.deepEqual(b.launched, [{ conversationId: CONV, url: amazon.signin_url }]);

  const set = r.headers["Set-Cookie"];
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /; Secure/, "over https, so it is never sent in the clear");
  assert.match(set, new RegExp(`Path=/s/${token}`), "and to no other address");
  assert.doesNotMatch(set, new RegExp(token.slice(0, 8) + "="), "the cookie's name does not give the link away");

  assert.equal(booked.at(-1).ms, config.remoteSigninSessionMs, "the session clock starts now");
  assert.ok(logs.some(l => l.signin_remote === "started" && l.site === "amazon"));

  const live = await req(token, "", { cookie });
  assert.equal(live.status, 200);
  assert.match(live.body, /id="v"/);
  assert.match(live.body, /type="password"/, "what is typed is hidden on their own screen by default");
  assert.deepEqual(remote.remoteSessionFor(CONV), { site: "amazon", started: true });
});

test("a second device with the same link gets nothing at all", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  // Forwarded, screenshotted, or lifted from a log: the link without the cookie.
  for (const [action, opts] of [["", {}], ["shot", {}], ["start", { method: "POST" }], ["tap", { method: "POST", body: { x: 0.5, y: 0.5 } }], ["type", { method: "POST", body: { text: "x" } }], ["done", { method: "POST" }]]) {
    const r = await req(token, action, opts);
    assert.equal(r.status, 404, `${action || "page"} is a plain 404`);
  }
  for (const wrong of ["rs_x=y", cookie.replace(/=.*/, "=not-the-secret"), cookie.slice(0, -2) + "zz"]) {
    assert.equal((await req(token, "shot", { cookie: wrong })).status, 404);
  }
  assert.equal(b.did.length, 0, "and the browser was never touched");
  assert.equal(b.launched.length, 1, "nor started a second time");
  assert.equal((await req(token, "shot", { cookie })).status, 200, "while the first device carries on");
});

test("a link that does not exist and one that is malformed are the same 404", async () => {
  for (const t of ["A".repeat(32), "short", "../../etc/passwd", "", "a".repeat(200)]) {
    const r = await req(t);
    assert.equal(r.status, 404);
    assert.match(r.body, /no longer good/);
  }
});

// ---------- driving it ----------

test("a tap lands where they tapped, a picture comes back as a picture", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);

  const shot = await req(token, "shot", { cookie });
  assert.equal(shot.status, 200);
  assert.equal(shot.headers["Content-Type"], "image/jpeg");
  assert.equal(shot.headers["Cache-Control"], "no-store");
  assert.ok(Buffer.isBuffer(shot.body));

  await req(token, "tap", { method: "POST", cookie, body: { x: 0.5, y: 0.25 } });
  assert.deepEqual(b.did.at(-1), ["click", Math.round(0.5 * remote.VIEW.width), Math.round(0.25 * remote.VIEW.height)]);

  await req(token, "scroll", { method: "POST", cookie, body: { dy: 420 } });
  assert.deepEqual(b.did.at(-1), ["wheel", 0, 420]);
  await req(token, "back", { method: "POST", cookie });
  assert.deepEqual(b.did.at(-1), ["back"]);
  await req(token, "key", { method: "POST", cookie, body: { key: "Enter" } });
  assert.deepEqual(b.did.at(-1), ["press", "Enter"]);
});

test("what cannot be a tap, a key or a scroll is refused before the browser hears of it", async () => {
  const { token, b } = make();
  const { cookie } = await start(token);
  const before = b.did.length;
  const post = (action, body) => req(token, action, { method: "POST", cookie, body });
  assert.equal((await post("tap", { x: 1.2, y: 0.5 })).status, 400);
  assert.equal((await post("tap", { x: "left", y: 0.5 })).status, 400);
  assert.equal((await post("tap", {})).status, 400);
  assert.equal((await post("key", { key: "Meta+Q" })).status, 400);
  assert.equal((await post("key", { key: "F12" })).status, 400);
  assert.equal((await post("type", { text: "" })).status, 400);
  assert.equal((await post("type", { text: "x".repeat(501) })).status, 400);
  assert.equal((await post("type", { text: ["a"] })).status, 400);
  assert.equal((await post("navigate", { url: "https://evil.example" })).status, 404, "there is no way to send it somewhere by address");
  assert.equal(b.did.length, before);

  await post("scroll", { dy: 999_999, dx: -999_999 });
  assert.deepEqual(b.did.at(-1), ["wheel", -2000, 2000], "a scroll is clamped, not trusted");
  const bad = await remote.remoteRequest({ token, action: "tap", method: "POST", headers: { cookie }, readBody: async () => "{not json" });
  assert.equal(bad.status, 400);
});

test("what they type reaches the page and is kept nowhere else", async () => {
  const { token, b, logs } = make();
  const { cookie } = await start(token);
  const typed = await req(token, "type", { method: "POST", cookie, body: { text: SECRET_TYPED } });
  assert.equal(typed.status, 200);
  assert.deepEqual(b.did.at(-1), ["type", SECRET_TYPED], "the site's own page got it");
  assert.doesNotMatch(typed.body, new RegExp(SECRET_TYPED), "it is not echoed back");

  const done = await req(token, "done", { method: "POST", cookie });
  assert.equal(JSON.parse(done.body).state, "signed_in");

  // Everything this process keeps: its log lines, every row of every table, the result page.
  const everywhere = [
    JSON.stringify(logs),
    ...db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => JSON.stringify(db.db.prepare(`SELECT * FROM "${t.name}"`).all())),
    (await req(token)).body,
    JSON.stringify(remote.remoteSessionFor(CONV)),
  ].join("\n");
  assert.doesNotMatch(everywhere, new RegExp(SECRET_TYPED), "not in the log, not in the database, not on the page");
  assert.equal(/password|hunter/i.test(JSON.stringify(logs)), false);
});

// ---------- how it ends ----------

test("Done asks the SITE, records what it says, frees the profile and tells Reason", async () => {
  const { token, b, checks } = make();
  const { cookie } = await start(token);
  const done = await req(token, "done", { method: "POST", cookie });
  assert.deepEqual(JSON.parse(done.body), { ok: true, ended: true, state: "signed_in" });
  assert.deepEqual(checks, [[CONV, "amazon"]]);
  assert.equal(b.closed, 1, "the browser is closed, so the profile is free for errands again");
  assert.equal(remote.remoteSessionFor(CONV), null);

  assert.equal(notes().length, 1);
  assert.match(notes()[0], /Amazon says they ARE signed in now \(the order history page loaded\)/);

  const page = await req(token, "", { cookie });
  assert.match(page.body, /You&#39;re signed in to Amazon|You're signed in to Amazon/);
  assert.equal((await req(token, "shot", { cookie })).status, 410, "and the session is over");
  assert.equal((await req(token, "start", { method: "POST" })).status, 404, "for good — it cannot be started again");
});

test("tapping Done without signing in is 'not signed in', whatever the button was called", async () => {
  const { token } = make({ said: { ok: true, state: "signed_out", why: "the account page redirected to sign-in" } });
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  assert.match(notes()[0], /still NOT signed in \(the account page redirected to sign-in\)/);
  assert.match(notes()[0], /offer a fresh link/);
  assert.match((await req(token, "", { cookie })).body, /Not signed in to Amazon/);
});

test("a page that could not be read is 'could not tell', and nothing is claimed", async () => {
  const { token } = make({ said: { ok: false, error: "the page did not load" } });
  const { cookie } = await start(token);
  await req(token, "done", { method: "POST", cookie });
  assert.match(notes()[0], /could not be read \(the page did not load\)\. Nothing is recorded either way/);
  assert.doesNotMatch(notes()[0], /ARE signed in/);
});

test("a session nobody finishes is ended by the clock — and the site is still asked", async () => {
  const { token, b, booked, checks } = make();
  const { cookie } = await start(token);
  booked.at(-1).fn(); // ten minutes are up
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(checks, [[CONV, "amazon"]], "they may have signed in and put the phone down");
  assert.equal(b.closed, 1);
  assert.match(notes()[0], /timed out before they tapped Done/);
  assert.equal((await req(token, "tap", { method: "POST", cookie, body: { x: 0.5, y: 0.5 } })).status, 410);
});

test("a link nobody opens just lapses: no browser, no message", async () => {
  const { token, b, booked } = make();
  assert.equal(booked[0].ms, config.remoteSigninLinkTtlMs);
  booked[0].fn();
  await new Promise(r => setImmediate(r));
  assert.equal(b.launched.length, 0);
  assert.deepEqual(notes(), [], "not worth a text");
  assert.equal(remote.remoteSessionFor(CONV), null);
  assert.equal((await req(token, "start", { method: "POST" })).status, 404, "and it cannot be started late");
});

test("a new link cancels the old one", async () => {
  const first = make();
  const { cookie } = await start(first.token);
  const second = make();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(first.b.closed, 1, "the old browser is closed");
  assert.equal((await req(first.token, "shot", { cookie })).status, 410);
  assert.notEqual(second.token, first.token);
  assert.deepEqual(remote.remoteSessionFor(CONV), { site: "amazon", started: false });
});

test("while the window on the Mac has the profile, Start says so and takes nothing", async () => {
  const { token, b } = make({ busy: () => "A sign-in window is already open on the Mac for this account." });
  const r = await req(token, "start", { method: "POST" });
  assert.equal(r.status, 409);
  assert.match(r.body, /already open on the Mac/);
  assert.equal(b.launched.length, 0);
  assert.equal(r.headers["Set-Cookie"], undefined, "and the link is still theirs to start once it is free");
});

test("a browser that will not start ends the link cleanly", async () => {
  const { token, logs } = make({ launch: async () => { throw new Error("Executable doesn't exist"); } });
  const r = await req(token, "start", { method: "POST" });
  assert.equal(r.status, 500);
  assert.match(r.body, /The browser would not open\. Nothing was changed/);
  assert.ok(logs.some(l => l.signin_remote === "launch_failed"));
  assert.equal(remote.remoteSessionFor(CONV), null);
});

test("two people's links are two browsers on two profiles", async () => {
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  const mine = make();
  const theirs = make({ conversationId: THEIRS });
  const a = await start(mine.token);
  const b = await start(theirs.token);
  assert.deepEqual(mine.b.launched[0].conversationId, CONV);
  assert.deepEqual(theirs.b.launched[0].conversationId, THEIRS);
  // One person's cookie does nothing on the other's link.
  assert.equal((await req(theirs.token, "shot", { cookie: a.cookie })).status, 404);
  assert.equal((await req(mine.token, "shot", { cookie: b.cookie })).status, 404);
  await req(theirs.token, "done", { method: "POST", cookie: b.cookie });
  assert.equal(notes(THEIRS).length, 1);
  assert.equal(notes(CONV).length, 0, "and the news goes to the person who signed in");
});

// ---------- the tool, and the server ----------

test("signin_link hands the model a link and the exact truth about it", async () => {
  const made = [];
  const out = await runTool("signin_link", { site: "amazon" }, {
    conversationId: CONV, channels: null,
    createRemoteSignin: (a) => { made.push(a); return { ok: true, url: "https://reason.example/s/TOKEN", site: "amazon", good_for_minutes: 10, reachable_from_a_phone: true }; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.link, "https://reason.example/s/TOKEN");
  assert.equal(made[0].conversationId, CONV);
  assert.match(out.what_passes_through, /relayed to the site through you and is never saved, logged or shown to you/);
  assert.match(out.what_passes_through, /not that it never passes through anything/);
  assert.match(out.limits, /Face ID, passkeys and security keys do not/);
  assert.match(out.next, /do not say they are/);
  assert.equal(out.warning, undefined);

  // The receipt says a link was made. It does not hold the link, which is a way in.
  const row = db.db.prepare("SELECT * FROM action_ledger WHERE conversation_id = ?").get(CONV);
  assert.equal(row.action, "signin_link");
  assert.doesNotMatch(JSON.stringify(row), /TOKEN/);
});

test("signin_link works for somebody who is not at the machine, which is the point of it", async () => {
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  const out = await runTool("signin_link", { site: "fandango" }, { conversationId: THEIRS, channels: null });
  assert.equal(out.ok, true);
  assert.match(out.link, /^https:\/\/reason\.example\/s\/[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(remote.remoteSessionFor(THEIRS), { site: "fandango", started: false });

  // And asked for the window instead, they are pointed at the link.
  const win = await runTool("signin_open", { site: "fandango" }, { conversationId: THEIRS, channels: null });
  assert.equal(win.ok, false);
  assert.match(win.use_instead, /signin_link/);
});

test("the honest warnings: no public address, a site that refuses the browser, nobody's conversation", async () => {
  config.publicUrl = "";
  const local = await runTool("signin_link", { site: "doordash" }, { conversationId: CONV, channels: null });
  assert.equal(local.ok, true);
  assert.match(local.warning, /from their phone this link will not open/);
  assert.match(local.site_warning, /DoorDash refuses an automated browser/);
  assert.equal(signin.linkSignin().available, false);

  const nobody = await runTool("signin_link", { site: "amazon" }, { conversationId: "dm:fake:+19990001111", channels: null });
  assert.equal(nobody.ok, false);
  assert.match(nobody.error, /does not belong to anybody/);
  assert.match((await runTool("signin_link", { site: "netflix" }, { conversationId: CONV, channels: null })).error, /No site called/);
});

test("over real HTTP: the page is served, a wrong address is a 404, and nothing answers outside /s/<token>", async () => {
  const { token } = make();
  const server = createServer({ router: { statuses: () => [] }, runtime: null });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/s/${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sign in to Amazon/);
    assert.equal((await fetch(`${base}/s/${"B".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${base}/s/`)).status, 404);
    assert.equal((await fetch(`${base}/s/${token}/shot`)).status, 404, "no cookie, no picture");
    assert.equal((await fetch(`${base}/s/${token}/../../health`)).status, 200, "and the path cannot be walked out of");
  } finally { await new Promise(r => server.close(r)); }
});
