// Scheduled descriptions for rows that already have a title (owner 10-27 01:20, follow-up to #211).
// #211 writes a row's description with its title, so a row the model titled itself (timer_set / a series
// with `title`) and every row made before #211 had none. Pinned:
//
//   1. a titled scheduled row with no description asks for one in the background; only `blurb` is written
//   2. the backfill writes only `blurb`, only where it is empty, and a dry run writes nothing
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-blurb-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
delete process.env.REASON_BACKEND;

const db = await import("../src/db.js");
const og = await import("../src/ongoing.js");
const it = await import("../src/itemtitle.js");
const { seedOngoing } = await import("./fixture-ongoing.js");
const { clock } = await import("../src/config.js");
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  it.resetTitleQueue();
  db.db.exec("DELETE FROM tasks; DELETE FROM timers; DELETE FROM series; DELETE FROM confirmations; DELETE FROM agentcard_purchases; DELETE FROM accounts;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
});

test("1. a titled scheduled row gets its description alone; its title is never replaced", async () => {
  const t = db.createTimer(C, { fireAt: clock.now() + 3_600_000, note: "Daily midnight recap of what you WORKED ON that day on github (omarionnn).", label: "Midnight GitHub recap" });
  assert.equal(og.findItem(C, "timer", t.id).description, "Daily midnight recap of what you worked on that day on GitHub.", "the tidied note meanwhile");
  // Without the CLI (and under the runner) nothing is asked.
  assert.equal(it.queueBlurb("timer", C, t.id, "x"), null);
  await it.queueBlurb("timer", C, t.id, "x", { name: "Omari", ask: async () => ({ value: { title: "Something else", line: "A recap of what you worked on that day on GitHub." } }) });
  const row = db.getTimer(C, t.id);
  assert.equal(row.label, "Midnight GitHub recap");
  assert.equal(row.blurb, "A recap of what you worked on that day on GitHub.");
  assert.equal(og.findItem(C, "timer", t.id).description, "A recap of what you worked on that day on GitHub.");
  // Once per row per process; a task is never asked.
  let calls = 0;
  assert.equal(it.queueBlurb("timer", C, t.id, "x", { ask: async () => { calls++; return { value: {} }; } }), null);
  assert.equal(it.queueBlurb("task", C, 1, "x", { ask: async () => { calls++; return { value: {} }; } }), null);
  assert.equal(calls, 0);
  // A line with their name or a handle is never stored.
  const s = db.createTimer(C, { fireAt: clock.now() + 3_600_000, note: "n", label: "N" });
  await it.queueBlurb("timer", C, s.id, "n", { name: "Omari", ask: async () => ({ value: { title: "N", line: "Omari's recap for @omarionnn." } }) });
  assert.equal(db.getTimer(C, s.id).blurb, null);
});

test("2. the backfill writes only the description, only where there is none; a dry run writes nothing", async () => {
  const ids = seedOngoing(C);
  const done = db.createTimer(C, { fireAt: clock.now() + 3_600_000, note: "already described", label: "Done" });
  db.setItemBlurb("timer", C, done.id, "Already has one.");
  const rest = (t, id) => JSON.stringify({ ...db.db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id), blurb: null });
  const snap = [["timers", ids.timer], ["series", ids.series]].map(([t, id]) => rest(t, id));
  assert.deepEqual(it.rowsWithoutBlurb().map(r => `${r.kind}:${r.id}`).sort(), [`series:${ids.series}`, `timer:${ids.timer}`].sort());
  const ask = async ({ prompt }) => ({ value: { title: "Not used", line: /gym/.test(prompt) ? "A Monday check on the gym class." : "A call to your landlord." } });
  assert.deepEqual(await it.backfillBlurbs({ write: false, log: () => {}, ask }), { rows: 2, wrote: 0 });
  assert.equal(db.getTimer(C, ids.timer).blurb, null, "a dry run writes nothing");
  assert.deepEqual(await it.backfillBlurbs({ write: true, log: () => {}, ask }), { rows: 2, wrote: 2 });
  assert.equal(db.getSeries(C, ids.series).blurb, "A Monday check on the gym class.");
  assert.equal(db.getTimer(C, ids.timer).blurb, "A call to your landlord.");
  assert.equal(db.getTimer(C, done.id).blurb, "Already has one.");
  assert.deepEqual([["timers", ids.timer], ["series", ids.series]].map(([t, id]) => rest(t, id)), snap, "titles, notes and every other column untouched");
  assert.deepEqual(it.rowsWithoutBlurb(), []);
});
