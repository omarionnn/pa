// The web setup (heyreason.com/start → Messages, src/websetup.js, REASON_WEB_SETUP). Through the real
// router, outbox and database, with the model's reads stated:
//
//   the page's API: a setup + its cookie, names saved, the name line (cached, limited, silent on failure),
//     connects bound to the setup, the setup cookie proving the browser to the connect gate, the .vcf
//   the claim: their first text `hey jarvis, it's kofi · r7k2` → account name + card name, Google grant
//     and Amazon check moved to them, the hello + card + try line, never the name / call-me questions
//     or the Amazon offer, and no model read at all
//   a wrong code, a guessed code without the names, the switch off, no code → the normal intro, unchanged
//   an event joiner keeps the Amazon offer
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-websetup-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_ONBOARDING;
process.env.REASON_INTRO_AMAZON = "on";
process.env.REASON_WEB_SETUP = "on";
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key

const ob = await import("../src/onboarding.js");
const ws = await import("../src/websetup.js");
const store = await import("../src/websetupstore.js");
const gate = await import("../src/connectgate.js");
const amazon = await import("../src/amazonconnect.js");
const remote = await import("../src/signin-remote.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { profilePath } = await import("../src/browser.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415557${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  ws.resetLimits();
  ws.forgetNameLines();
  process.env.REASON_INTRO_AMAZON = "on";
  process.env.REASON_WEB_SETUP = "on";
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  config.publicUrl = "https://reason.example.test";
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM action_ledger; DELETE FROM web_setups; DELETE FROM oauth_tokens; DELETE FROM connected_accounts; DELETE FROM oauth_states;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function harness(reads = {}) {
  const turns = [], asked = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "on it"; } });
  const ask = async ({ prompt }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    asked.push(said);
    const r = reads[said];
    if (!r) return { error: "no stated read" };
    return { value: { name: "", card_name: "", reply: "", name_line: "", amazon: "", ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {}, amazonLink: async () => "https://x.test/s/link" } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns, asked };
}
const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);

// ---------- the page's API ----------

const cookieOf = (res) => /rs_setup=([^;]+)/.exec(String(res.headers["Set-Cookie"] ?? ""))?.[1];
async function api(method, path, { cookie = "", body = null, query = {}, ip = "1.2.3.4", ...seams } = {}) {
  const res = await ws.request({ method, path, query, headers: { cookie: cookie ? `rs_setup=${cookie}` : "", host: "reason.example.test" }, remoteAddress: ip, readBody: async () => body ? JSON.stringify(body) : "", ...seams });
  return { ...res, json: res.body ? JSON.parse(res.body) : null };
}
async function newSetup(names = { user: "kofi", reasonName: "jarvis" }) {
  const made = await api("POST", "/api/new");
  const cookie = cookieOf(made);
  await api("POST", `/api/${made.json.id}`, { cookie, body: names });
  return { ...made.json, cookie };
}

test("a setup: id + four-character code + an HttpOnly cookie; names saved; only its own browser reads it", async () => {
  const made = await api("POST", "/api/new");
  assert.equal(made.status, 201);
  assert.match(made.json.code, /^[a-z2-9]{4}$/);
  assert.match(String(made.headers["Set-Cookie"]), /rs_setup=.+; Path=\/;.*HttpOnly; SameSite=Lax/);
  const cookie = cookieOf(made);
  assert.equal((await api("POST", `/api/${made.json.id}`, { cookie, body: { user: "kofi <b>", reasonName: "a very long name for reason indeed" } })).status, 200);
  const got = await api("GET", `/api/${made.json.id}`, { cookie });
  assert.equal(got.json.user, "kofi b");
  assert.equal(got.json.reasonName.length, 18);
  assert.deepEqual(got.json.connections.amazon, { state: "none", step: 1, of: 3 });
  assert.equal((await api("GET", `/api/${made.json.id}`, { cookie: "someone-else" })).status, 404, "another browser gets nothing");
  assert.equal((await api("GET", `/api/${made.json.id}`)).status, 404);
  clock.skip(store.TTL_MS + 1000);
  assert.equal((await api("GET", `/api/${made.json.id}`, { cookie })).status, 404, "a day later it is gone");
});

test("setups are rate limited per address; a cross-site POST is refused; the switch off answers 404", async () => {
  for (let i = 0; i < 12; i++) assert.equal((await api("POST", "/api/new", { ip: "9.9.9.9" })).status, 201);
  assert.equal((await api("POST", "/api/new", { ip: "9.9.9.9" })).status, 429);
  assert.equal((await api("POST", "/api/new", { ip: "8.8.8.8" })).status, 201, "another address is its own count");
  const cross = await ws.request({ method: "POST", path: "/api/new", headers: { origin: "https://evil.test", host: "reason.example.test" } });
  assert.equal(cross.status, 403);
  process.env.REASON_WEB_SETUP = "off";
  assert.equal((await api("POST", "/api/new")).status, 404);
});

test("the name line: shaped for 'kofi — …', cached per name, rate limited, and silent when the model fails", async () => {
  let calls = 0;
  const nameLineFor = async () => { calls++; return "kofi, it means born on a friday. good start."; };
  const a = await api("GET", "/api/name-line", { query: { name: "Kofi" }, nameLineFor });
  assert.deepEqual(a.json, { line: "it means born on a friday. good start." });
  await api("GET", "/api/name-line", { query: { name: "kofi" }, nameLineFor });
  assert.equal(calls, 1, "one model call per name");
  assert.equal((await api("GET", "/api/name-line", { query: { name: "k" }, nameLineFor })).status, 204, "under two characters: nothing");
  const failed = await api("GET", "/api/name-line", { query: { name: "ama" }, nameLineFor: async () => { throw new Error("cli down"); } });
  assert.equal(failed.status, 204);
  assert.equal(ws.webLine("nice to meet you, zed", "zed"), null, "nothing worth showing → nothing shown");
  for (let i = 0; i < 30; i++) await api("GET", "/api/name-line", { query: { name: `n${i}x` }, ip: "5.5.5.5", nameLineFor });
  assert.equal((await api("GET", "/api/name-line", { query: { name: "fresh" }, ip: "5.5.5.5", nameLineFor })).status, 204, "limited, silently");
});

test("connects are bound to the setup: Amazon via the sign-in link, email via Google, Outlook unavailable", async () => {
  const s = await newSetup();
  const asked = [];
  const amazonLink = (c) => { asked.push(c); return { ok: true, url: "https://heyreason.example/s/tok" }; };
  const googleLink = (c) => { asked.push(c); return { ok: true, url: "https://app.example/connect/start?state=st" }; };
  assert.deepEqual((await api("POST", `/api/${s.id}/connect/amazon`, { cookie: s.cookie, amazonLink })).json, { ok: true, url: "https://heyreason.example/s/tok" });
  assert.deepEqual((await api("POST", `/api/${s.id}/connect/email`, { cookie: s.cookie, body: { provider: "gmail" }, googleLink })).json, { ok: true, url: "https://app.example/connect/start?state=st" });
  assert.deepEqual((await api("POST", `/api/${s.id}/connect/email`, { cookie: s.cookie, body: { provider: "outlook" }, googleLink })).json, { ok: false, why: "unavailable" });
  assert.deepEqual(asked, [`websetup:${s.id}`, `websetup:${s.id}`], "the setup's stand-in, never a real conversation");
  assert.equal((await api("POST", `/api/${s.id}/connect/amazon`, { amazonLink })).status, 404, "not without the setup's cookie");
  assert.equal((await api("GET", "/api/capabilities")).json.outlook, false);
});

test("the real Amazon setup link: a remote sign-in for the stand-in; its end lands on the setup, never a thread timer", async () => {
  const s = await newSetup();
  const c = `websetup:${s.id}`;
  const out = amazon.setupConnectLink(c);
  assert.equal(out.ok, true);
  assert.match(out.url, /\/s\/[A-Za-z0-9_-]{32,64}$/);
  assert.deepEqual(remote.remoteSessionFor(c), { site: "amazon", started: false });
  const live = await api("GET", `/api/${s.id}`, { cookie: s.cookie });
  assert.deepEqual(live.json.connections.amazon, { state: "connecting", step: 1, of: 3 });
  assert.equal(amazon.setupConnectLink("dm:fake:+1415").ok, false, "only a setup's stand-in");
  assert.equal(amazon.available(c), false, "the text intro's offer never covers a stand-in");
  await remote.endAllRemoteSignins("cancelled");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(store.get(s.id).amazon_state, "failed");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE conversation_id = ?").get(c).n, 0, "nothing woken for a thread that does not exist");
});

test("the setup cookie proves the browser to the connect gate, for its own stand-in only, and only with the switch on", async () => {
  const s = await newSetup();
  assert.equal(gate.browserConversation({ cookie: `rs_setup=${s.cookie}` }), `websetup:${s.id}`);
  assert.equal(gate.browserConversation({ cookie: "rs_setup=nope" }), null);
  process.env.REASON_WEB_SETUP = "off";
  assert.equal(gate.browserConversation({ cookie: `rs_setup=${s.cookie}` }), null);
});

test("a Google grant for a setup goes back to the connect screen, says nothing in any thread", async () => {
  const s = await newSetup();
  config.siteUrl = "https://heyreason.example";
  const done = ws.googleCallbackDone({ ok: true, conversationId: `websetup:${s.id}` });
  assert.equal(done.status, 302);
  assert.equal(done.headers.Location, "https://heyreason.example/start/connect?back=email");
  assert.equal(ws.googleCallbackDone({ ok: false, conversationId: `websetup:${s.id}` }).headers.Location, "https://heyreason.example/start/connect?back=email&failed=1");
  assert.equal(store.get(s.id).email_state, "failed");
  assert.equal(ws.googleCallbackDone({ ok: true, conversationId: "dm:fake:+1" }), null, "a thread's own grant is untouched");
  config.siteUrl = "";
});

test("the .vcf: the chosen name on Reason's card with the live line's number and the photo", async () => {
  const h = harness();
  const got = await ws.request({ method: "GET", path: "/contact.vcf", query: { name: "jarvis" }, router: h.router });
  assert.equal(got.status, 200);
  assert.match(got.headers["Content-Disposition"], /attachment; filename="Jarvis.vcf"/);
  assert.match(got.body, /FN:Jarvis/);
  assert.match(got.body, /TEL;TYPE=CELL,VOICE,pref:\+16562167455/);
  assert.match(got.body, /PHOTO;ENCODING=b;TYPE=JPEG:/);
});

// ---------- the first text ----------

test("the first text: lowercase, the code last", () => {
  assert.equal(ws.firstText({ user: "Kofi", reasonName: "Jarvis", code: "r7k2" }), "hey jarvis, it's kofi · r7k2");
  assert.equal(ws.firstText({ user: "kofi", reasonName: "", code: "r7k2" }), "hey reason, it's kofi · r7k2");
  assert.equal(ws.codeInText("hey jarvis, it's kofi · r7k2"), "r7k2");
  assert.equal(ws.codeInText("hey jarvis, it's kofi - R7K2 "), "r7k2");
  assert.equal(ws.codeInText("hey"), null);
  assert.equal(ws.codeInText("call me at 5pm · 1234"), null, "0/1 are never in a code");
});

test("claimed: name + card name set, the hello, the card under the chosen name, the try line; nothing asked, no read, no Amazon offer", async () => {
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  const out = await h.router.deliver(text(num, ws.firstText({ user: "kofi", reasonName: "jarvis", code: s.code })));
  const acct = db.getAccount(conv(num));
  assert.equal(acct.name, "Kofi");
  assert.equal(acct.contact_card_name, "Jarvis");
  assert.equal(acct.onboarding, "complete");
  assert.equal(out.onboarding, "complete");
  const sent = to(h, num);
  assert.deepEqual(sent.map(m => m.text), [ob.WEB_HELLO("kofi"), ob.WEB_CARD, ob.TRY_LINE]);
  assert.ok(sent[1].media, "the card on its own line's message");
  for (const m of sent) {
    assert.notEqual(m.text, ob.NAME_Q);
    assert.notEqual(m.text, ob.CARD_NAME_ASK);
    assert.notEqual(m.text, amazon.OFFER);
  }
  assert.deepEqual(h.asked, [], "no model read of a text the page typed");
  assert.equal(h.turns.length, 0);
  assert.equal(store.get(s.id).claimed_by, conv(num));
  assert.equal(ob.handledOnWeb(conv(num)), true);
  assert.equal(ob.amazonCanOffer(conv(num)), false, "AMAZON HOOK: handled on web, never offered");
});

test("what was connected on the page moves to them: the Google grant, the Amazon check + profile, and Amazon's follow-up", async () => {
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  const c = `websetup:${s.id}`;
  db.saveOauthTokens(c, "google", { accessToken: "a", refreshToken: "r", scope: "gmail", accountLabel: "kofi@example.com" });
  db.connectAccount(c, "gmail", ["gmail"], { account: "kofi@example.com" });
  db.db.prepare("INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, account_label, state, checked_at) VALUES (?, 'amazon', '[]', ?, '', 'signed_in', ?)").run(c, clock.now(), clock.now());
  mkdirSync(profilePath(c), { recursive: true });
  writeFileSync(join(profilePath(c), "Cookies"), "x");
  await h.router.deliver(text(num, `hey jarvis, it's kofi · ${s.code}`));
  const me = conv(num);
  assert.equal(db.listOauthTokens(me, "google").length, 1);
  assert.equal(db.listOauthTokens(c, "google").length, 0);
  assert.equal(amazon.connected(me), true);
  assert.ok(existsSync(join(profilePath(me), "Cookies")), "the signed-in profile is theirs now");
  assert.equal(existsSync(profilePath(c)), false);
  const follow = db.db.prepare("SELECT note FROM timers WHERE conversation_id = ? AND label IS NULL").all(me).map(r => r.note);
  assert.ok(follow.some(n => n === amazon.followUpNote()), "Amazon's order read follows the hello");
});

test("no claim → the normal intro, unchanged: no code, a wrong code, a guessed code without the names, the switch off", async () => {
  const s = await newSetup();
  const cases = [
    "hey",
    "hey jarvis, it's kofi · zzzz",
    `hey there · ${s.code}`,
  ];
  for (const body of cases) {
    const h = harness({ [body]: { kind: "greeting" } });
    const num = newNumber();
    await h.router.deliver(text(num, body));
    assert.deepEqual(to(h, num).map(m => m.text), ob.OPENER, body);
    assert.equal(db.getAccount(conv(num)).onboarding, "awaiting_name");
  }
  assert.equal(store.get(s.id).claimed_by, null, "still open for its own phone");
  process.env.REASON_WEB_SETUP = "off";
  const body = `hey jarvis, it's kofi · ${s.code}`;
  const h = harness({ [body]: { kind: "greeting" } });
  const num = newNumber();
  await h.router.deliver(text(num, body));
  assert.deepEqual(to(h, num).map(m => m.text), ob.OPENER);
  assert.equal(store.get(s.id).claimed_by, null);
});

test("a setup is claimed once: a second phone with the same text gets the normal intro", async () => {
  const s = await newSetup();
  const body = `hey jarvis, it's kofi · ${s.code}`;
  const h = harness({ [body]: { kind: "greeting" } });
  const a = newNumber(), b = newNumber();
  await h.router.deliver(text(a, body));
  await h.router.deliver(text(b, body));
  assert.equal(store.get(s.id).claimed_by, conv(a));
  assert.deepEqual(to(h, b).map(m => m.text), ob.OPENER);
});

test("event joiners (not web-claimed) keep the Amazon offer; an expired setup's connections are swept", async () => {
  const num = newNumber();
  db.upsertAccount({ conversationId: conv(num), channel: "fake", address: num, name: "Ama" });
  assert.equal(ob.handledOnWeb(conv(num)), false);
  assert.equal(ob.amazonCanOffer(conv(num)), true);
  const s = await newSetup();
  const c = `websetup:${s.id}`;
  db.saveOauthTokens(c, "google", { accessToken: "a", refreshToken: "r", scope: "gmail", accountLabel: "x@example.com" });
  mkdirSync(profilePath(c), { recursive: true });
  ws.sweep(clock.now() + store.TTL_MS + 1);
  assert.equal(db.listOauthTokens(c, "google").length, 0);
  assert.equal(existsSync(profilePath(c)), false);
  assert.equal(store.get(s.id, 0), null);
});

// ---------- review fixes (11-10) ----------

test("the code is gone once claimed: not in the stored message, not in what the model reads", async () => {
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  await h.router.deliver(text(num, `hey jarvis, it's kofi · ${s.code}`));
  const rows = db.db.prepare("SELECT text FROM inbound_messages WHERE conversation_id = ?").all(conv(num)).map(r => r.text);
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.ok(!String(r).includes(s.code), `stored: ${r}`);
  assert.equal(rows[0], "hey jarvis, it's kofi");
  // Nowhere else either: every table but the setup's own row (the history the model reads included).
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'web_setups'").all().map(r => r.name);
  for (const t of tables) {
    let rows = [];
    try { rows = db.db.prepare(`SELECT * FROM "${t}"`).all(); } catch { continue; }
    assert.ok(!JSON.stringify(rows).includes(`· ${s.code}`), `the code is in ${t}`);
  }
  assert.ok(to(h, num).length >= 2, "the hello still went out");
  assert.equal(ws.withoutCode("hey jarvis, it's kofi · r7k2"), "hey jarvis, it's kofi");
});

test("a code shuts after five texts with the wrong names; a setup with no name is never claimed", async () => {
  const s = await newSetup();
  for (let i = 0; i < store.MAX_MISSES; i++) {
    const body = `hey there · ${s.code}`;
    const h = harness({ [body]: { kind: "greeting" } });
    await h.router.deliver(text(newNumber(), body));
  }
  const body = `hey jarvis, it's kofi · ${s.code}`;
  const h = harness({ [body]: { kind: "greeting" } });
  const num = newNumber();
  await h.router.deliver(text(num, body));
  assert.equal(store.get(s.id).claimed_by, null, "the right names after five misses: still shut");
  assert.deepEqual(to(h, num).map(m => m.text), ob.OPENER);
  const nameless = await newSetup({ reasonName: "jarvis" });
  const b2 = `hey jarvis, it's · ${nameless.code}`;
  const h2 = harness({ [b2]: { kind: "greeting" } });
  await h2.router.deliver(text(newNumber(), b2));
  assert.equal(store.get(nameless.id).claimed_by, null);
});

test("a late claim (over an hour after the setup) takes the names but drops what was connected", async () => {
  const h = harness();
  const num = newNumber();
  const s = await newSetup();
  const c = `websetup:${s.id}`;
  db.saveOauthTokens(c, "google", { accessToken: "a", refreshToken: "r", scope: "gmail", accountLabel: "someone@example.com" });
  db.db.prepare("INSERT INTO connected_accounts (conversation_id, name, scopes, connected_at, account_label, state, checked_at) VALUES (?, 'amazon', '[]', ?, '', 'signed_in', ?)").run(c, clock.now(), clock.now());
  mkdirSync(profilePath(c), { recursive: true });
  clock.skip(ws.CONNECT_CLAIM_MS + 1000);
  await h.router.deliver(text(num, `hey jarvis, it's kofi · ${s.code}`));
  const me = conv(num);
  assert.equal(db.getAccount(me).name, "Kofi");
  assert.equal(db.listOauthTokens(me, "google").length, 0, "not someone else's Gmail");
  assert.equal(amazon.connected(me), false, "not someone else's Amazon");
  assert.equal(db.listOauthTokens(c, "google").length, 0, "dropped, not left behind");
  assert.equal(existsSync(profilePath(c)), false);
});

test("a setup made on a listed staging site: host-only cookie, Google return and Amazon link to that site", async () => {
  config.siteUrl = "https://heyreason.example";
  process.env.REASON_SETUP_ORIGINS = "https://start--site.netlify.example";
  try {
    const made = await ws.request({ method: "POST", path: "/api/new", headers: { origin: "https://start--site.netlify.example", host: "files.heyreason.example" } });
    assert.equal(made.status, 201);
    assert.doesNotMatch(String(made.headers["Set-Cookie"]), /Domain=/);
    const id = JSON.parse(made.body).id;
    const cookie = cookieOf(made);
    assert.equal(ws.googleCallbackDone({ ok: true, conversationId: `websetup:${id}` }).headers.Location, "https://start--site.netlify.example/start/connect?back=email");
    const amazonLink = () => ({ ok: true, url: "https://heyreason.example/s/tok" });
    const a = await api("POST", `/api/${id}/connect/amazon`, { cookie, amazonLink });
    assert.equal(a.json.url, "https://start--site.netlify.example/s/tok");
    const evil = await ws.request({ method: "POST", path: "/api/new", headers: { origin: "https://start--evil.netlify.example", host: "files.heyreason.example" } });
    assert.equal(evil.status, 403, "an unlisted site is refused");
  } finally {
    config.siteUrl = "";
    delete process.env.REASON_SETUP_ORIGINS;
  }
});
