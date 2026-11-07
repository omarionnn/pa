// Alerts raised where the failure happened (src/incidents.js), and the watchdog outside the process
// (scripts/watchdog.mjs). Test 17 of the events spec, offline:
//
//   - a forced send failure texts the owner at once — no five-minute pass in between;
//   - the same failure again updates ONE alert ("still failing, N times since …"), never a flood;
//   - a transient failure the retry fixes raises nothing;
//   - it is marked resolved when the failure stops, and says what to check next while it is open;
//   - the five-minute pass still runs, and does not text the same failure a second time;
//   - a dead or hung process is caught by the watchdog, which texts on its own.
//
// No network: the channel is the fake one, and the watchdog's Sendblue is a local server.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-incidents-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const outbox = await import("../src/outbox.js");
const incidents = await import("../src/incidents.js");
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const MIN = 60_000;

let texts = [];
after(() => { incidents.stop(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  texts = [];
  db.db.exec("DELETE FROM outbox; DELETE FROM incidents; DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM ops_digest;");
  incidents.start({ send: (text, key) => { texts.push({ text, key }); return { ok: true }; }, link: (f) => `https://reason.example.test/ops?focus=${f}` });
});

function harness(opts = {}) {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => null });
  const router = new Router({ runtime, log: () => {} });
  const fake = router.register(new FakeChannel(opts));
  return { router, fake };
}
const sendTo = (router, to = FRIEND, over = {}) => router.send({ channel: "fake", to, text: "hi", conversationId: `dm:${to}`, toOwner: false, ...over });

test("a forced send failure texts the owner at once, with what failed, for whom, the error, what was tried and what to check", async () => {
  const { router } = harness({ failWith: "account suspended", retryable: false });
  const r = await sendTo(router);
  assert.equal(r.ok, false);
  assert.equal(texts.length, 1, "texted at the failure, not on the next pass");
  const t = texts[0].text;
  assert.match(t, /Reason alert: texts over fake are failing/);
  assert.match(t, /Who: dm:\+14155559876/);
  assert.match(t, /Error: account suspended/);
  assert.match(t, /Already tried: not retried/);
  assert.match(t, /Check next: /);
  assert.match(t, /focus=incident:send:fake:/);
  assert.ok(texts[0].key.startsWith(incidents.KEY_PREFIX));
});

test("the same failure again is ONE alert that counts — one text, then at most one 'still failing' an hour", async () => {
  const { router } = harness({ failWith: "account suspended", retryable: false });
  for (let i = 0; i < 14; i++) { await sendTo(router); clock.skip(2 * MIN); }
  assert.equal(texts.length, 1, "fourteen failures in 28 minutes, one text");
  const row = incidents.open()[0];
  assert.equal(row.count, 14);
  const page = incidents.checks().find(c => c.id === row.key.replace(/^/, "incident:"));
  assert.match(page.detail, /still failing, 14 times since/);
  assert.equal(page.quiet, true, "the page row never texts on its own");
  // Past the hour, still failing: one reminder carrying the count.
  for (let i = 0; i < 20; i++) { await sendTo(router); clock.skip(2 * MIN); }
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /^Still failing: texts over fake are failing — \d+ times since/);
});

test("a transient failure the retry fixes raises nothing at all", async () => {
  const { router, fake } = harness({ failTimes: 2 });
  const r = await sendTo(router);
  assert.equal(r.queued, true);
  for (let i = 0; i < 3; i++) { clock.skip(10 * MIN); await outbox.pass({ router }); }
  assert.equal(fake.sent.length, 1, "it went in the end");
  assert.equal(texts.length, 0, "no alert for a blip");
  assert.equal(incidents.open().length, 0);
});

test("a retryable failure that never clears alerts once, when the retrying is over", async () => {
  const { router } = harness({ failWith: "502 from upstream", retryable: true });
  await sendTo(router);
  assert.equal(texts.length, 0, "the first failure is a retry, not an alert");
  for (let i = 0; i < 10; i++) { clock.skip(10 * MIN); await outbox.pass({ router }); }
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /Already tried: sent \d+ times with backoff, then gave up/);
});

test("it is marked resolved when the failure stops: the next text out closes it, and says so once", async () => {
  const { router, fake } = harness({ failWith: "account suspended", retryable: false });
  await sendTo(router);
  fake.failWith = null;
  clock.skip(5 * MIN);
  const ok = await sendTo(router);
  assert.equal(ok.ok, true);
  assert.equal(incidents.open().length, 0);
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /^Resolved: texts over fake are failing — texts are going out again\. It failed 1 time/);
  const row = incidents.checks().find(c => c.id.startsWith("incident:send:fake"));
  assert.equal(row.state, "ok");
  assert.match(row.detail, /^resolved /);
});

test("a failure that just stops is resolved by the quiet spell, on the five-minute pass", async () => {
  const { router } = harness({ failWith: "account suspended", retryable: false });
  await sendTo(router);
  clock.skip(incidents.QUIET_MS + MIN);
  await ops.runOnce({ probe: () => ({ ok: true }) });
  assert.equal(incidents.open().length, 0);
  assert.match(texts.at(-1).text, /^Resolved: .* no repeat in 30 minutes/);
});

test("the five-minute pass still runs, and does not text the outbox row the alert already spoke for", async () => {
  const { router } = harness({ failWith: "account suspended", retryable: false });
  await sendTo(router);
  const said = [];
  const runtime = { say: (_c, text) => said.push(text) };
  const first = await ops.runOnce({ runtime, probe: () => ({ ok: true }) });
  assert.ok(first, "the pass ran");
  assert.equal(first.report?.checks?.find?.(c => c.id === "outbox")?.state ?? db.db.prepare("SELECT state FROM ops_checks WHERE id = 'outbox'").get().state, "bad", "the row is still red on the page");
  clock.skip(6 * MIN);
  await ops.runOnce({ runtime, probe: () => ({ ok: true }) });
  assert.ok(!said.some(t => /Texts out/.test(t)), `the pass did not text the failed send again: ${said.join(" | ")}`);
  // Even once the alert has resolved, the day-long red count on the outbox row stays its.
  incidents.resolve({ prefix: "send:fake:" });
  clock.skip(6 * MIN);
  await ops.runOnce({ runtime, probe: () => ({ ok: true }) });
  assert.ok(!said.some(t => /Texts out/.test(t)), `still no second text after resolve: ${said.join(" | ")}`);
});

test("an alert text that itself fails is not raised again — no loop over a dead channel", async () => {
  const { router } = harness({ failWith: "line down", retryable: false });
  await sendTo(router, OWNER, { conversationId: "dm:owner", toOwner: true, idempotencyKey: `${incidents.KEY_PREFIX}send:x@1:open` });
  assert.equal(texts.length, 0);
  assert.equal(incidents.open().length, 0);
});

test("a person who opted out, or has not texted the line yet, is not Reason broken", async () => {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => null });
  const router = new Router({ runtime, log: () => {} });
  const fake = router.register(new FakeChannel({ failWith: "opted out", retryable: false }));
  const orig = fake.send.bind(fake);
  fake.send = async (a) => ({ ...(await orig(a)), error_key: "OPTED_OUT" });
  const r = await sendTo(router);
  assert.equal(db.getOutbound(r.outbox_id).last_error_key, "OPTED_OUT", "the key reached the outbox");
  fake.send = async (a) => ({ ...(await orig(a)), error_key: "PRE_REPLY_LIMIT_REACHED" });
  await sendTo(router);
  assert.equal(texts.length, 0);
});

test("a runtime error goes to the daily digest on its third repeat in a spell, not its first — never a live text", async () => {
  const digest = await import("../src/opsdigest.js");
  ops.noteError(new Error("cannot read row 41"));
  ops.noteError(new Error("cannot read row 42"));
  assert.equal(digest.pending().length, 0, "two is under the threshold");
  assert.equal(incidents.checks()[0].state, "warn", "but it is on the page already");
  ops.noteError(new Error("cannot read row 43"));
  // Not an outage, a service down or a cap: the owner's chat stays quiet (owner, 2026-11-06).
  assert.equal(texts.length, 0);
  assert.equal(digest.pending().length, 1);
  assert.match(digest.pending()[0].text, /Reason alert: Reason keeps hitting the same error/);
  assert.match(digest.pending()[0].text, /\(3 times since/);
});

test("an unknown purchase outcome alerts at once", async () => {
  const trust = await import("../src/trust.js");
  trust.noteUnknownOutcome({ conversationId: "dm:+14155559876", action: "purchase_confirm", target: "acme", why: "timed out", cents: 1299 });
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /purchase_confirm ended with an unknown outcome/);
  assert.match(texts[0].text, /\$12\.99/);
});

test("/alive is cheap and says whether the sweep is stuck", () => {
  const a = ops.alive({ runtime: { interval: 1, lastSweepDoneAt: clock.now() - 60 * MIN } });
  assert.equal(a.ok, true);
  assert.equal(a.sweep_stuck, true);
  assert.equal(typeof a.loop_lag_ms, "number");
  assert.equal(ops.alive({ runtime: { interval: 1, lastSweepDoneAt: clock.now() } }).sweep_stuck, false);
});

test("the watchdog row: off when not installed, quiet-ok when running, warn when it has stopped", () => {
  const f = join(dir, "wd-test.json");
  assert.equal(ops.watchdogCheck(clock.now(), f).state, "off");
  writeFileSync(f, JSON.stringify({ at: clock.now() - MIN, problems: {} }));
  const ok = ops.watchdogCheck(clock.now(), f);
  assert.equal(ok.state, "ok"); assert.equal(ok.quiet, true);
  writeFileSync(f, JSON.stringify({ at: clock.now() - 20 * MIN, problems: {} }));
  assert.equal(ops.watchdogCheck(clock.now(), f).state, "warn");
});

test("a text reaching somebody else does not close a failure about one number; the same number does", async () => {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => null });
  const router = new Router({ runtime, log: () => {} });
  router.register(new FakeChannel({ failWith: "bad number", retryable: false, failFor: FRIEND }));
  await sendTo(router, FRIEND);
  await sendTo(router, "+13125550000");
  assert.equal(incidents.open().length, 1, "another person's text is not proof");
  assert.equal(texts.length, 1);
});

test("the alert's own text, through the real outbox, never closes the alert it announced", async () => {
  const { router, fake } = harness({ failWith: "bad number", retryable: false, failFor: FRIEND });
  // The sender as serve wires it: the owner's thread, through the outbox, under the incident key.
  incidents.start({ send: (text, idempotencyKey) => { texts.push({ text }); return router.send({ channel: "fake", to: OWNER, text, conversationId: "dm:owner", toOwner: true, idempotencyKey }); } });
  for (let i = 0; i < 5; i++) { await sendTo(router, FRIEND); await new Promise(r => setImmediate(r)); clock.skip(MIN); }
  assert.equal(fake.sent.filter(m => m.to === OWNER).length, 1, `one alert reached the owner, not open/resolved pairs: ${texts.map(t => t.text.split("\n")[0]).join(" | ")}`);
  assert.equal(incidents.open()[0].count, 5);
});

test("an alert raised before the sender is wired (a restart's own recovery) is owed, then sent by start()", () => {
  incidents.stop();
  incidents.raise({ key: "call:place:x", area: "calls", covers: "", what: "a phone call could not be placed after a restart" });
  assert.equal(texts.length, 0);
  assert.equal(incidents.open()[0].texted_at, null, "never marked told before it is");
  incidents.start({ send: (text, key) => { texts.push({ text, key }); } });
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /could not be placed after a restart/);
  incidents.start({ send: (text, key) => { texts.push({ text, key }); } });
  assert.equal(texts.length, 1, "owed once, sent once");
});

test("one runtime error is on the page, and the five-minute pass does not text it either", async () => {
  ops.noteError(new Error("odd input 7"));
  const said = [];
  const runtime = { say: (_c, text) => said.push(text) };
  await ops.runOnce({ runtime, probe: () => ({ ok: true }) });
  clock.skip(6 * MIN);
  await ops.runOnce({ runtime, probe: () => ({ ok: true }) });
  assert.ok(!said.some(t => /Errors since restart/.test(t)), said.join(" | "));
  assert.equal(texts.length, 0);
});

test("failing again after it went quiet is a fresh alert, without a 'resolved' in the same breath", () => {
  incidents.raise({ key: "k1", area: "messaging", what: "thing broke" });
  clock.skip(incidents.QUIET_MS + MIN);
  incidents.raise({ key: "k1", area: "messaging", what: "thing broke" });
  assert.deepEqual(texts.map(t => t.text.split("\n")[0]), ["Reason alert: thing broke.", "Reason alert: thing broke."]);
});

// ---------- the watchdog, as a process ----------

function runWatchdog(envOver) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["scripts/watchdog.mjs", "--print"], {
      env: { PATH: process.env.PATH, REASON_DATA_DIR: dir, REASON_TZ: "America/New_York", REASON_MASTER_NUMBER: OWNER, SENDBLUE_FROM_NUMBER: "+16562167455", SENDBLUE_API_KEY_ID: "k", SENDBLUE_API_SECRET_KEY: "s", ...envOver },
      timeout: 20_000,
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

test("watchdog: a dead process texts after two runs; a hung one too; it resolves when it is back; a crash texts once", async () => {
  const got = [];
  const sb = createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => { got.push(JSON.parse(b)); res.end("{}"); }); });
  // A /alive that hangs, like a stuck event loop.
  const hung = createServer(() => { /* never answers */ });
  const healthy = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, loop_lag_ms: 3, sweep_stuck: false, sweep_age_ms: 1000 })); });
  await Promise.all([sb, hung, healthy].map(s => new Promise(r => s.listen(0, "127.0.0.1", r))));
  const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;
  const base = { REASON_WATCHDOG_SEND_URL: url(sb, "/api/send-message") };
  try {
    const dead = { ...base, REASON_WATCHDOG_FAKE_SYSTEMD: JSON.stringify({ ActiveState: "failed", SubState: "failed", NRestarts: "0" }) };
    await runWatchdog(dead);
    assert.equal(got.length, 0, "one sighting is a restart in progress, not news");
    await runWatchdog(dead);
    assert.equal(got.length, 1);
    assert.equal(got[0].number, OWNER);
    assert.match(got[0].content, /Reason is not running/);
    await runWatchdog(dead);
    assert.equal(got.length, 1, "still down on the third run: no second text inside the hour");

    const up = { ...base, REASON_WATCHDOG_FAKE_SYSTEMD: JSON.stringify({ ActiveState: "active", SubState: "running", NRestarts: "0" }), REASON_WATCHDOG_ALIVE_URL: url(healthy, "/alive") };
    await runWatchdog(up);
    await runWatchdog(up);
    assert.equal(got.length, 1, "two clean runs are not yet resolved — a flap is not news");
    await runWatchdog(up);
    assert.equal(got.length, 2);
    assert.match(got[1].content, /resolved:[\s\S]*Reason is not running.*fine again/);
    const st = JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf8"));
    assert.equal(st.ok, true);

    const hang = { ...up, REASON_WATCHDOG_ALIVE_URL: url(hung, "/alive") };
    await runWatchdog(hang);
    await runWatchdog(hang);
    assert.equal(got.length, 3);
    assert.match(got[2].content, /running but not answering.*no answer in 5s/);
    for (let i = 0; i < 3; i++) await runWatchdog(up);
    assert.equal(got.length, 4);

    // A crash loop: NRestarts climbing on every run is ONE crash alert, not a text a minute.
    for (let n = 1; n <= 5; n++) await runWatchdog({ ...up, REASON_WATCHDOG_FAKE_SYSTEMD: JSON.stringify({ ActiveState: "active", SubState: "running", NRestarts: String(n) }) });
    assert.equal(got.length, 5);
    assert.match(got[4].content, /crashed and systemd restarted it \(1 time/);
    const st2 = JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf8"));
    assert.equal(st2.crashes, 5, "the count keeps going on the one alert");
    assert.equal(st2.problems.crash.resolved_at, undefined);

    // A text that fails is not marked sent: the next run tries again.
    const dead2 = { ...up, REASON_WATCHDOG_FAKE_SYSTEMD: JSON.stringify({ ActiveState: "failed", SubState: "failed", NRestarts: "5" }), REASON_WATCHDOG_SEND_URL: "http://127.0.0.1:1/nothing" };
    await runWatchdog(dead2); await runWatchdog(dead2);
    const st3 = JSON.parse(readFileSync(join(dir, "watchdog.json"), "utf8"));
    assert.equal(st3.problems.service.texted_at, undefined, "never marked texted when the send failed");
    await runWatchdog({ ...dead2, REASON_WATCHDOG_SEND_URL: url(sb, "/api/send-message") });
    assert.match(got.at(-1).content, /Reason is not running/);
  } finally {
    for (const s of [sb, hung, healthy]) { s.closeAllConnections?.(); s.close(); }
  }
});

test("a non-urgent alert's whole episode is ONE digest line, ending where it ended — never a live text", async () => {
  const digest = await import("../src/opsdigest.js");
  // Repeats inside the quiet spell, long enough for a "still failing": one episode throughout.
  for (let i = 0; i < 4; i++) {
    incidents.raise({ key: "action:unknown", area: "actions", covers: "unknown", what: "a held action was cut off by a restart" });
    clock.skip(20 * MIN);
  }
  incidents.resolve({ key: "action:unknown", how: "checked by hand" });
  assert.equal(texts.length, 0);
  const lines = digest.pending();
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Resolved: a held action was cut off by a restart — checked by hand/);
});
