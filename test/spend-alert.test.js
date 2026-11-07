// Warnings before the wall (2026-11-07).
//
// The incident: 2026-11-05 22:05 UTC the Anthropic workspace usage limit was hit with no warning. Every
// paid call came back "400 … You have reached your specified workspace API usage limits. You will
// regain access on 2026-12-01 at 00:00 UTC.", a taxi request waited 15 minutes, the harm screen failed
// open four times, and the owner heard nothing. What has to stay true now:
//
//   - at 80% of the daily and of the monthly cap the owner gets ONE text per day / month;
//   - the provider's usage-limit refusal texts him the moment it is first seen, ONCE per episode,
//     with the system problem only (never who was talking or what about); a paid call that goes
//     through ends the episode;
//   - both are on /ops, and the five-minute pass never texts either a second time;
//   - the daily ops digest (#340) goes out once, after 9:00 in the install's zone, only with lines held.
//
// No API key, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-spend-alert-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_CALL_PROVIDER = "fake";

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const spend = await import("../src/spend.js");
const ops = await import("../src/ops.js");
const digest = await import("../src/opsdigest.js");

after(() => rmSync(dir, { recursive: true, force: true }));

// The refusal exactly as the API sent it on 11-05 (journal, 22:05:10 UTC), request id changed.
const LIMIT = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."},"request_id":"req_test"}'), { status: 400 });
const RATE = Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), { status: 429 });

const sent = [];
const send = (text, key) => { sent.push({ text, key }); };
const at = (iso) => { clock.reset(); clock.skip(Date.parse(iso) - Date.now()); return clock.now(); };
// $4 per million input tokens on Opus 5.5: `usd` dollars of reply.
const spendUsd = (usd, feature = "reply", when = clock.now()) =>
  spend.recordApi({ feature, model: "claude-opus-5-5", usage: { input_tokens: Math.round(usd / 4 * 1e6) }, at: when });

const caps = { day: config.apiDailyCapUsd, month: config.apiMonthlyCapUsd, call: config.apiCallDailyCapUsd };
beforeEach(() => {
  clock.reset();
  sent.length = 0;
  spend.stopAlerts();
  spend.resetApiOut();
  db.db.exec("DELETE FROM model_usage; DELETE FROM ops_state; DELETE FROM ops_checks; DELETE FROM ops_digest;");
  config.apiDailyCapUsd = 60;
  config.apiMonthlyCapUsd = 1200;
  config.apiCallDailyCapUsd = 6;
});
after(() => { config.apiDailyCapUsd = caps.day; config.apiMonthlyCapUsd = caps.month; config.apiCallDailyCapUsd = caps.call; clock.reset(); });

// ---------- 80% of a cap ----------

test("80% of the daily cap: one heads-up, not again that day, again the next day", () => {
  const now = at("2026-11-07T15:00:00Z");
  spendUsd(47, "reply", now);
  assert.deepEqual(spend.capWarnings({ send, now }), [], "78% is not yet 80%");
  spendUsd(2, "reply", now);
  spend.capWarnings({ send, now });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Reason heads-up: API spend is at 81% of the daily cap, $49.00 of $60.00 today (phone calls not counted).");
  assert.match(sent[0].key, /^ops:api_warn:daily:2026-11-07$/, "an ops: key, so it is an operator notice and the outbox sends it once");
  spendUsd(5, "reply", now);
  spend.capWarnings({ send, now: now + 60_000 });
  assert.equal(sent.length, 1, "once per day");
  // The next day starts at zero: nothing until it reaches 80% again.
  const tomorrow = at("2026-11-08T15:00:00Z");
  spend.capWarnings({ send, now: tomorrow });
  assert.equal(sent.length, 1);
  spendUsd(50, "reply", tomorrow);
  spend.capWarnings({ send, now: tomorrow });
  assert.equal(sent.length, 2);
  assert.match(sent[1].key, /2026-11-08$/);
});

test("80% of the monthly cap: one heads-up per month, calls counted (the month is the bill)", () => {
  config.apiDailyCapUsd = 0; // only the month in play
  let now = at("2026-11-02T15:00:00Z");
  spendUsd(500, "reply", now);
  now = at("2026-11-03T15:00:00Z");
  spendUsd(400, "reply", now);
  spendUsd(70, "call", now);
  spend.capWarnings({ send, now });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Reason heads-up: API spend is at 80% of the monthly cap, $970.00 of $1200.00 this month.");
  now = at("2026-11-20T15:00:00Z");
  spendUsd(10, "reply", now);
  spend.capWarnings({ send, now });
  assert.equal(sent.length, 1, "once per month, whatever the day");
});

test("already past the cap: no 80% line (the cap's own alert speaks), and a cap of 0 is off", () => {
  const now = at("2026-11-07T15:00:00Z");
  spendUsd(61, "reply", now);
  assert.deepEqual(spend.capWarningsDue({ now }).map(w => w.which), []);
  config.apiDailyCapUsd = 0;
  config.apiMonthlyCapUsd = 0;
  assert.deepEqual(spend.capWarningsDue({ now }), []);
});

test("the API spend row on /ops says the heads-up went", () => {
  const now = at("2026-11-07T15:00:00Z");
  spendUsd(50, "reply", now);
  spend.capWarnings({ send, now });
  assert.match(spend.spendCheck({ now }).detail, /daily 80% warning sent 2026-11-07 15:00 UTC/);
  assert.equal(spend.spendCheck({ now }).state, "ok", "a heads-up is not the cap: the row stays green");
});

// ---------- the provider's usage limit ----------

test("the 11-05 refusal is a usage limit; a per-minute 429 and a credit refusal are not", () => {
  assert.equal(spend.isUsageLimit(LIMIT), true);
  assert.equal(spend.isUsageLimit(Object.assign(new Error("429 usage limit exceeded for this workspace"), { status: 429 })), true);
  assert.equal(spend.isUsageLimit(RATE), false);
  assert.equal(spend.isUsageLimit(new Error("Your credit balance is too low to access the Anthropic API.")), false);
  assert.equal(spend.isUsageLimit(new Error("overloaded")), false);
});

test("usage limit: the owner is texted at the first refusal, once, with the system problem only", () => {
  spend.startAlerts({ send });
  const now = at("2026-11-05T22:05:03Z");
  spend.recordApi({ feature: "said_record", model: "claude-haiku-5-5", error: LIMIT, at: now });
  assert.equal(sent.length, 1, "the moment it is seen, not on the next pass");
  assert.equal(sent[0].text, "Reason alert: the Anthropic API workspace usage limit is reached, so every paid API call is being refused until 2026-12-01 at 00:00 UTC (the API's words). Raise the limit in the Anthropic Console, or move replies to the subscription.");
  assert.doesNotMatch(sent[0].text, /req_|said_record|dm:|\+1/, "no request id, lane or person");
  // The harm screen, the reply and three more: the same episode, no more texts.
  for (const feature of ["harm", "reply", "harm", "harm", "harm"]) spend.recordApi({ feature, model: "claude-opus-5-5", error: LIMIT, at: now + 7000 });
  assert.equal(sent.length, 1);
  assert.equal(spend.limitHit().count, 6);
  // A per-minute rate limit in between is not this, and does not end it.
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: RATE, at: now + 8000 });
  assert.equal(spend.limitHit().count, 6);
});

test("usage limit: a call that goes through ends the episode; the next refusal texts again", () => {
  spend.startAlerts({ send });
  const now = at("2026-11-05T22:05:03Z");
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT, at: now });
  spendUsd(0.1, "reply", now + 3_600_000);
  assert.equal(spend.limitHit(), null);
  assert.match(spend.limitCheck().detail, /^not hit now · last hit 2026-11-05 22:05 UTC, over 2026-11-05 23:05 UTC \(1 refused\)$/);
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT, at: now + 7_200_000 });
  assert.equal(sent.length, 2);
});

test("usage limit: a success seconds after a refusal (a call begun before it) does not end the episode or text twice", () => {
  spend.startAlerts({ send });
  const now = at("2026-11-05T22:05:03Z");
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT, at: now });
  spendUsd(0.1, "voice", now + 5000);
  assert.ok(spend.limitHit());
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT, at: now + 9000 });
  assert.equal(sent.length, 1);
});

test("usage limit seen before the texts are wired (boot): told once the wiring is up, not lost, not twice", () => {
  const now = at("2026-11-05T22:05:03Z");
  spend.recordApi({ feature: "harm", model: "claude-haiku-5-5", error: LIMIT, at: now });
  assert.equal(sent.length, 0);
  assert.match(spend.limitCheck().detail, /owner not texted yet/);
  spend.startAlerts({ send });
  assert.equal(sent.length, 1);
  spend.startAlerts({ send }); // a second wiring (restart in the same DB): already told
  spend.recordApi({ feature: "harm", model: "claude-haiku-5-5", error: LIMIT, at: now + 1000 });
  assert.equal(sent.length, 1);
});

test("/ops shows the usage-limit row red while it holds, and the five-minute pass never texts it again", async () => {
  spend.startAlerts({ send });
  at("2026-11-05T22:05:03Z");
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT });
  const said = [];
  const runtime = { say: (c, text) => { said.push(text); return text; }, interval: {}, lastSweepAt: clock.now(), on() {} };
  const report = await ops.runChecks({ runtime, probe: async () => ({ ok: true, status: 200 }) });
  const row = report.checks.find(c => c.id === "api_limit");
  assert.equal(row.state, "bad");
  assert.equal(row.quiet, true);
  assert.match(row.detail, /workspace usage limit reached since 2026-11-05 22:05 UTC · 1 refused · access back 2026-12-01 at 00:00 UTC per the API · owner texted 2026-11-05 22:05 UTC/);
  assert.notEqual(report.verdict, "ok", "the page's top is not green while the provider refuses");
  // Two passes ten minutes apart: past the sustained-alert delay, and still nothing texted from here.
  ops.settle({ report, runtime });
  clock.skip(11 * 60_000);
  ops.settle({ report: { ...report, at: clock.now() }, runtime });
  assert.deepEqual(said.filter(t => /usage limit|API/i.test(t)), [], said.join("\n"));
  assert.equal(digest.pending().filter(r => /usage limit/i.test(r.text)).length, 0, "and not held for the digest either");
});

// ---------- the ops pass wiring (startOps) ----------

test("startOps wires both: the 80% line goes out from the pass, live, to the owner's thread", async () => {
  const said = [];
  const runtime = { say: (c, text, meta) => { said.push({ c, text, meta }); return text; }, interval: {}, lastSweepAt: clock.now(), on() {} };
  const handle = ops.startOps({ runtime, everyMs: 3_600_000, firstAfterMs: 3_600_000 });
  try {
    spendUsd(50);
    await handle.run();
    const line = said.find(s => /heads-up/.test(s.text));
    assert.ok(line, JSON.stringify(said));
    assert.equal(line.c, "dm:owner");
    assert.equal(line.meta.toMaster, true);
    spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT });
    assert.equal(said.filter(s => /usage limit is reached/.test(s.text)).length, 1);
  } finally { handle.stop(); ops.unwatchFetch(); }
});

// ---------- the daily digest (#340) ----------

test("digest: nothing held, nothing sent; one held line goes once, after 9:00 New York, and not again that day", async () => {
  const out = [];
  const dsend = (text, key) => { out.push({ text, key }); };
  // 9:05am New York on 11-08 is 14:05 UTC (EST since 11-01).
  assert.equal(await digest.flush({ send: dsend, now: Date.parse("2026-11-08T14:05:00Z") }), null, "an empty day sends nothing");
  digest.hold({ text: "A new number texted Reason for the first time and was let in (auto-admit is on).", key: "new-contact:x", at: Date.parse("2026-11-08T03:00:00Z") });
  assert.equal(await digest.flush({ send: dsend, now: Date.parse("2026-11-08T13:55:00Z") }), null, "8:55am: not yet");
  await digest.flush({ send: dsend, link: "https://x.test/ops", now: Date.parse("2026-11-08T14:05:00Z") });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "ops:digest:2026-11-08");
  assert.match(out[0].text, /^Reason daily digest — 1 thing since the last one, none urgent:\n• A new number texted Reason/);
  digest.hold({ text: "Something later.", key: "k2", at: Date.parse("2026-11-08T15:00:00Z") });
  await digest.flush({ send: dsend, now: Date.parse("2026-11-08T16:00:00Z") });
  assert.equal(out.length, 1, "once a day");
  await digest.flush({ send: dsend, now: Date.parse("2026-11-09T14:01:00Z") });
  assert.equal(out.length, 2);
  assert.match(out[1].text, /1 thing since the last one[\s\S]*Something later\./);
});
