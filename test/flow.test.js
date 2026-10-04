// Flow test against the real model: asserts on DB state after each step, never on wording.
// Runs when a real model is reachable: an API key, or the owner's claude-cli backend. Uses a throwaway DB.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-test-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";

const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const { skip } = await import("./live.js");
const C = "dm:test";
const rt = new Runtime();
const said = [];
rt.on("outbound", (m) => said.push(m));

before(() => { clock.reset(); });
after(() => { rt.stop(); rmSync(dir, { recursive: true, force: true }); });

const live = (plans = db.listPlans(C)) => plans.filter(p => ["planning", "locked"].includes(p.status));

test("dinner with a named place, time and person → one plan, nothing re-asked", { skip }, async () => {
  const reply = await rt.inbound(C, "dinner at carbone friday 8pm w/ kofi");
  const plans = live();
  assert.equal(plans.length, 1, "exactly one live plan");
  const p = plans[0];
  assert.match(p.where.toLowerCase(), /carbone/);
  assert.match(p.when.toLowerCase(), /fri/);
  assert.match(p.when, /8/);
  assert.ok(p.who.some(n => /kofi/i.test(n)), "kofi is in who");
  assert.ok(typeof reply === "string" && reply.length > 0);
  // Nothing it was already told should be re-asked.
  assert.doesNotMatch(reply.toLowerCase(), /where (do|would|should)|what time|which day|who('s| is| else)/);
});

test("change one detail from the DM → same plan updated, no new plan", { skip }, async () => {
  const before = live()[0];
  await rt.inbound(C, "actually make it 9");
  const plans = live();
  assert.equal(plans.length, 1, "still one live plan");
  assert.equal(plans[0].id, before.id);
  assert.match(plans[0].when, /9/);
  assert.match(plans[0].where.toLowerCase(), /carbone/, "place untouched");
});

test("owner's own question answered with a bare 'no' is not dropped", { skip }, async () => {
  const reply = await rt.inbound(C, "no");
  // Whatever Reason asked last, 'no' must be acknowledged, not answered with a fresh unrelated question.
  assert.ok(typeof reply === "string");
  assert.equal(live().length, 1);
});

test("'never mind' is acknowledged and does not cancel", { skip }, async () => {
  const reply = await rt.inbound(C, "never mind about that");
  assert.ok(reply && reply.length > 0, "never mind gets words, not silence");
  assert.equal(live().length, 1, "plan still live");
});

test("lock, then a day-of reminder timer exists and fires as a message", { skip }, async () => {
  await rt.inbound(C, "ok lock it in and remind me the morning of");
  const p = db.listPlans(C)[0];
  assert.equal(p.status, "locked");
  const timers = db.listTimers(C);
  assert.ok(timers.length >= 1, "a reminder timer was set");
  const t = timers[0];
  clock.skip(t.fire_at - clock.now() + 1000);
  const before = said.length;
  const fired = await rt.tick();
  assert.equal(fired, 1);
  await rt.idle();
  assert.ok(db.listTimers(C).every(x => x.id !== t.id), "timer consumed");
  assert.ok(said.length > before, "reminder produced an outbound message");
  assert.equal(said.at(-1).fromTimer, t.id);
});

test("clear cancel → cancelled, and its timers are gone", { skip }, async () => {
  await rt.inbound(C, "cancel the carbone thing, kofi bailed");
  const p = db.listPlans(C, { includeClosed: true })[0];
  assert.equal(p.status, "cancelled");
  assert.equal(db.listTimers(C).length, 0);
  assert.equal(live().length, 0);
});

test("asks for something Reason can't do → honest, no fake link, no fake venue", { skip }, async () => {
  const reply = await rt.inbound(C, "send kofi a pay link for his half");
  assert.ok(reply);
  assert.doesNotMatch(reply, /https?:\/\//, "no invented link");
  assert.match(reply.toLowerCase(), /can'?t|not (yet|connected|able)|don'?t have|no way/, "says it can't");
});
