// A standing check-in walked end to end against the real model.
//
// test/series.test.js proves the plumbing: the maths, the rows, the collapse, the chain from one
// firing to the next. What it cannot prove is the part Omari actually asked for — that "check in with
// me every monday at 9 about the job search" becomes ONE series with the right rule instead of a
// single Monday reminder, that the check-in when it fires is about the job search in Reason's own
// words, that "two applications out" comes back the following week as something it remembers, and
// that "stop checking in about that" stops it.
//
// Asserts on facts rather than wording: which rule is on the row, which words the check-in contains,
// what is in last_report, and the state after the stop. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-series.test.js
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-series-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "https://reason.example.test";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const series = await import("../src/series.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM series; DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts;"
    + " DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;"
    + " DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function harness() {
  const rt = new Runtime();
  const router = new Router();
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });

  async function says(text) {
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const before = fake.sent.length;
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, said: fake.sent.slice(before).map(m => m.text).join("\n") };
  }
  /** Move the clock to the next firing and run one sweep, the way the live server would. */
  async function reachNextFiring() {
    const next = db.listTimers(C)[0];
    assert.ok(next, "nothing was armed, so nothing can fire");
    const before = fake.sent.length;
    clock.skip(Math.max(0, next.fire_at - clock.now()) + HOUR);
    await rt.sweep();
    return fake.sent.slice(before).map(m => m.text).join("\n");
  }
  return { rt, says, fake, reachNextFiring };
}

test(`"check in with me every monday at 9 about the job search" is one series, and it keeps its thread (${label})`, { skip }, async () => {
  const { rt, says, reachNextFiring } = harness();
  try {
    // Wednesday afternoon.
    clock.skip(Date.parse("2026-10-07T20:00:00Z") - clock.now());

    const asked = await says("check in with me every monday at 9 about the job search");
    assert.ok(asked.said.length > 0, "it answered");

    // One series, not a one-off Monday reminder — which is the whole difference this commit makes.
    const rows = db.listSeries(C);
    assert.equal(rows.length, 1, `it did not set a standing series: ${JSON.stringify(asked.said)}`);
    const rule = series.parseRule(rows[0].rule);
    assert.equal(rule.kind, "weekly", JSON.stringify(rule));
    assert.deepEqual(rule.weekdays, [1], "monday");
    assert.equal(rule.hour, 9, JSON.stringify(rule));
    assert.equal(rule.their_time, true, "he named the time, so it is not moved");
    assert.match(rows[0].what, /job|search|applic/i, `the note says nothing about the job search: ${rows[0].what}`);
    // And it said the schedule back once, in plain words.
    assert.match(asked.said, /monday/i, `it never said the schedule back: ${JSON.stringify(asked.said)}`);

    // Monday. The check-in has to be about the job search, not a generic "morning!".
    const first = await reachNextFiring();
    assert.ok(first.length > 0, "the check-in never went out");
    assert.match(first, /job|search|applic|interview|hear(d)? back|any (luck|news)/i,
      `the first check-in is not about the job search: ${JSON.stringify(first)}`);
    assert.equal(db.getSeries(C, rows[0].id).fired_count, 1);

    // He answers. Code files it against the series; nothing here depends on the model doing that.
    clock.skip(2 * HOUR);
    await says("two applications out, waiting to hear");
    assert.equal(db.getSeries(C, rows[0].id).last_report, "two applications out, waiting to hear");

    // Next Monday: it has to pick up where that left off rather than ask the same thing again.
    const second = await reachNextFiring();
    assert.ok(second.length > 0, "the second check-in never went out");
    assert.match(second, /two|applicat|those|them|hear|repl|back/i,
      `the second check-in does not reference what he said last week: ${JSON.stringify(second)}`);
    assert.notEqual(second.trim(), first.trim(), "a canned repeat is the failure this exists to avoid");
    assert.equal(db.getSeries(C, rows[0].id).fired_count, 2);

    // And stop means stop.
    clock.skip(HOUR);
    const stopped = await says("stop checking in about that");
    const ended = db.getSeries(C, rows[0].id);
    assert.equal(ended.state, "ended", `it did not stop the series: ${JSON.stringify(stopped.said)}`);
    assert.equal(db.listTimers(C).length, 0, "and nothing is left armed");
    assert.ok(db.listActions(C).some(a => a.action === "series_end" && a.outcome === "ok"), "with a receipt");

    // One more week: silence. Nothing is scheduled and nothing comes round again.
    clock.skip(8 * DAY);
    await rt.sweep();
    assert.equal(db.listTimers(C).length, 0);
  } finally { rt.stop(); }
});

test(`"pause the workout reminders" pauses that one and leaves the other running (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    clock.skip(Date.parse("2026-10-07T20:00:00Z") - clock.now());
    await says("remind me every day at 7pm to work out");
    await says("and check in with me every monday about the job search");
    assert.equal(db.listSeries(C).length, 2, "two standing arrangements");

    const paused = await says("pause the workout reminders");
    const rows = db.listSeries(C, { includeEnded: true });
    const workout = rows.find(r => /work ?out|gym|train/i.test(r.what));
    const search = rows.find(r => /job|search/i.test(r.what));
    assert.ok(workout && search, `could not tell the two apart: ${JSON.stringify(rows.map(r => r.what))}`);
    assert.equal(workout.state, "paused", `it did not pause the workout one: ${JSON.stringify(paused.said)}`);
    assert.equal(search.state, "active", `it touched the job search one too: ${JSON.stringify(paused.said)}`);
  } finally { rt.stop(); }
});
