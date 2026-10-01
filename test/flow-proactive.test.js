// Proactive behaviour with the real model: does it set a watcher instead of promising one, does it
// pick a dropped thread back up in one useful line, and does it keep quiet when there is nothing
// worth saying. The schedule and the rate limit are proved offline in proactive.test.js; what needs
// the model is the judgement. Asserts DB state and whether a message went out, never wording.
// Skipped without ANTHROPIC_API_KEY.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-proactive-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const skip = !process.env.ANTHROPIC_API_KEY;
const HOUR = 3_600_000;

// A tiny local page whose contents the test controls. Nothing live is ever fetched.
let site, page;
before(async () => {
  page = "<h1>Carbone</h1><p>No tables available on Fri Oct 9.</p>";
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Carbone — tables</title></head><body>${page}</body></html>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  site = { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) };
});
after(async () => { await site.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM plans; DELETE FROM timers; DELETE FROM watches; DELETE FROM nudges; DELETE FROM conversations;");
});

test("asked to keep an eye on a page, it sets a real watcher", { skip }, async () => {
  const C = "dm:watch-set";
  const rt = new Runtime();
  try {
    const reply = await rt.inbound(C,
      `keep an eye on ${site.url} and tell me if a table opens up for 2 on friday oct 9 around 8`);
    assert.ok(reply, "it answered");
    const watches = db.listWatches(C);
    assert.equal(watches.length, 1, "a watcher actually exists, not just a promise");
    assert.equal(watches[0].url.replace(/\/$/, ""), site.url.replace(/\/$/, ""));
    assert.ok(watches[0].looking_for.length > 0, "and it wrote down what counts as the thing");
    assert.equal(watches[0].met_at, null, "nothing is claimed found yet");
  } finally { await rt.shutdown(); }
});

test("a watcher fires only once the page really changes", { skip }, async () => {
  const C = "dm:watch-fire";
  const rt = new Runtime();
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  try {
    page = "<h1>Carbone</h1><p>No tables available on Fri Oct 9.</p>";
    await rt.inbound(C, `watch ${site.url} and tell me when a table opens up for 2 on friday oct 9 around 8pm`);
    const w = db.listWatches(C)[0];
    assert.ok(w, "a watcher exists");
    const before = sent.length;

    // Nothing has opened up. The model must not claim it has.
    await rt.checkWatches();
    assert.equal(db.getWatch(C, w.id).met_at, null, "an unchanged page is not a hit");
    assert.equal(sent.length, before, "and nobody was told anything");
    assert.ok(db.getWatch(C, w.id).checks >= 1, "but it did look");

    // Now it really opens up.
    page = "<h1>Carbone</h1><p>Fri Oct 9: <strong>8:00 PM</strong> available, party of 2.</p>";
    clock.skip(2 * HOUR);
    await rt.checkWatches();
    const after = db.getWatch(C, w.id);
    assert.ok(after.met_at, "now it is a hit");
    assert.ok(after.met_why, "with a reason read off the page");
    assert.equal(sent.length, before + 1, "and they were told, once");
    assert.equal(sent.at(-1).fromWatch, w.id);

    // Done is done.
    clock.skip(2 * HOUR);
    await rt.checkWatches();
    assert.equal(sent.length, before + 1, "it does not keep telling them");
  } finally { await rt.shutdown(); }
});

test("a dropped thread is picked back up with one message about something open", { skip }, async () => {
  const C = "dm:dropped";
  const rt = new Runtime();
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  try {
    await rt.inbound(C, "i wanna do dinner with kofi next week, somewhere in the village");
    const plan = db.listPlans(C)[0];
    assert.ok(plan, "there is a plan");
    assert.ok(plan.open_questions.length, "with something still open");

    // Hours pass with nothing said.
    const ago = clock.now() - 5 * HOUR;
    db.db.exec(`UPDATE plans SET updated_at = ${ago} WHERE id = ${plan.id}`);
    db.db.exec(`UPDATE conversations SET updated_at = ${ago} WHERE id = '${C}'`);
    const before = sent.length;

    const out = await rt.followUp();
    assert.equal(out.candidates, 1);
    assert.equal(out.asked, 1);
    if (out.sent) {
      assert.equal(sent.length, before + 1, "exactly one message, not a burst");
      assert.equal(sent.at(-1).fromFollowUp, plan.id);
      assert.ok(db.listNudges(C).some(n => n.sent_at), "recorded as sent, so it will not repeat today");
    } else {
      assert.equal(sent.length, before, "it chose silence, and said nothing");
      assert.ok(db.listNudges(C).every(n => !n.sent_at), "and silence did not spend the daily cap");
    }

    // Either way it will not be raised again inside the gap.
    const second = await rt.followUp();
    assert.equal(second.asked, 0, "the same thread is not raised twice in a row");
  } finally { await rt.shutdown(); }
});

test("a day-of reminder and a morning-after check-in both arrive", { skip }, async () => {
  const C = "dm:reminders";
  const rt = new Runtime();
  const sent = [];
  rt.on("outbound", (m) => sent.push(m));
  try {
    await rt.inbound(C, "locking it in: dinner at carbone this friday oct 9 2026, 8pm, me and kofi. remind me that afternoon and ask me how it went the next morning");
    const timers = db.listTimers(C);
    assert.ok(timers.length >= 2, `it set both timers; got ${timers.length}`);

    // Jump to the first one.
    clock.skip(timers[0].fire_at - clock.now() + 60_000);
    const before = sent.length;
    assert.ok(await rt.tick() >= 1, "the day-of timer fired");
    assert.equal(sent.length, before + 1, "and it said something");
    assert.ok(sent.at(-1).fromTimer, "as a timer message");

    // Jump to the last one.
    const rest = db.listTimers(C);
    assert.ok(rest.length >= 1, "the morning-after one is still pending");
    clock.skip(rest.at(-1).fire_at - clock.now() + 60_000);
    await rt.tick();
    assert.ok(sent.length >= before + 2, "the morning-after check-in arrived too");
    assert.equal(db.listTimers(C).length, 0, "both are spent");
  } finally { await rt.shutdown(); }
});
