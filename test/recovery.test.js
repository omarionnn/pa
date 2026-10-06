// Graceful recovery, without changing the ask.
//
// Two halves, and the second is the one with teeth. The first is bookkeeping: a route that failed is
// written down with why, so the same dead end is not tried twice and "what did you try" can be
// answered off the log weeks later. The second is a refusal: the easy way out of a hard search is to
// quietly move what they asked for — a later date, a different place, more money — and that is
// refused with status needs_them, because those are theirs to decide and the honest move is one
// question with the tradeoff on it.
// No API key needed.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-recovery-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const C = "dm:recovery";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log;");
});

const call = (name, input = {}) => runTool(name, input, { conversationId: C });

const start = () => call("task_start", {
  title: "find a place", goal: "a place under 2k incl fees, in by nov 1, near the L",
  sheet: {
    constraints: {
      budget: { value: "under $2000 a month", source: "them", said: "under $2k a month" },
      move_in: { value: "2026-11-01", source: "them", said: "move in nov 1" },
      place: { value: "near the L", source: "them", said: "near the L" },
      who: { value: "just Omari", source: "them", said: "just me" },
    },
  },
});

test("a route that failed is written down, on the sheet and in the log, with what to do next", async () => {
  const { id } = (await start()).task;

  const out = await call("task_update", {
    task_id: id,
    sheet: { routes: [{ tried: "streeteasy", failed_because: "answers 403 to an automated browser" }] },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.task.sheet.routes_that_failed.map(r => [r.tried, r.failed_because]),
    [["streeteasy", "answers 403 to an automated browser"]],
  );
  // And in the progress log, written from the sheet so the two cannot disagree.
  assert.match(out.task.done_so_far.at(-1), /tried streeteasy — did not work: answers 403/);

  // The instruction that comes back is "next safe route to the same goal", not "stop".
  assert.match(out.note, /next SAFE route to the same goal/);
  assert.match(out.note, /Do not stop at the first obstacle/);
  assert.match(out.note, /theirs to decide/);
  assert.match(out.note, /out of safe routes, say so and name the ones you tried/);
  assert.match(out.note, /No stealth/);
});

test("the routes already tried are in front of the model, so a dead end is not tried twice", async () => {
  const { id } = (await start()).task;
  await call("task_update", { task_id: id, sheet: { routes: [{ tried: "streeteasy", failed_because: "403" }] } });
  const second = await call("task_update", { task_id: id, sheet: { routes: [{ tried: "renthop", failed_because: "the page is all javascript, nothing readable came back" }] } });
  assert.equal(second.task.sheet.routes_that_failed.length, 2);
  assert.match(second.note, /2 route\(s\) that have not worked/);
  assert.match(second.note, /so you do not try one twice/);

  // Two days later, on a wake, they are still there.
  clock.skip(2 * 24 * 60 * 60_000);
  const fresh = db.getTask(C, id);
  assert.deepEqual(fresh.sheet.routes.map(r => r.tried), ["streeteasy", "renthop"]);
});

test("recovery refuses a goal change: the date, the place, the money and the people are all theirs", async () => {
  const { id } = (await start()).task;
  const moves = [
    ["budget", "under $2400 a month"],
    ["move_in", "2026-12-01"],
    ["place", "anywhere in brooklyn"],
    ["who", "Omari plus a roommate"],
  ];
  for (const [key, value] of moves) {
    for (const source of ["found", "assumed"]) {
      const out = await call("task_update", {
        task_id: id,
        progress: "nothing under 2k near the L today",
        sheet: { constraints: { [key]: { value, source } } },
      });
      assert.equal(out.ok, false, `${key} must not move from a ${source} value`);
      assert.equal(out.status, "needs_them");
      assert.equal(out.constraint, key);
      assert.match(out.error, /theirs to change, not yours/i);
      assert.match(out.error, /Keep looking within what they asked for/);
      assert.match(out.error, /waiting_on_you/);
      assert.match(out.error, /tradeoff/i);
    }
  }
  // Nothing moved, and the progress line that rode along did not land either.
  const row = db.getTask(C, id);
  assert.equal(row.sheet.constraints.budget.value, "under $2000 a month");
  assert.equal(row.sheet.constraints.move_in.value, "2026-11-01");
  assert.equal(row.sheet.constraints.place.value, "near the L");
  assert.equal(row.sheet.constraints.who.value, "just Omari");
  assert.deepEqual(row.log.filter(l => l.kind === "progress"), []);
});

test("the honest move after a refusal is one question with the tradeoff, and that is allowed", async () => {
  const { id } = (await start()).task;
  const refused = await call("task_update", {
    task_id: id, sheet: { constraints: { budget: { value: "under $2300 a month", source: "found" } } },
  });
  assert.equal(refused.status, "needs_them");

  // The route the refusal points at.
  const asked = await call("task_update", {
    task_id: id,
    progress: "17 listings read near the L; cheapest all-in was $2,180",
    state: "waiting_on_you",
    sheet: {
      needs: {
        question: "stretch to about $2,200 all in, or go a couple stops further from the L?",
        tradeoff: "$2,200 gets you 441 graham on friday; further out there were three under $2k but it's a 12 min walk to the train",
      },
    },
  });
  assert.equal(asked.ok, true);
  assert.equal(asked.task.state, "waiting_on_you");
  assert.match(asked.task.needs_from_you, /2,200 all in, or go a couple stops/);
  assert.match(asked.task.needs_from_you, /12 min walk/);
  // And the thing they said is still exactly what they said. Nothing was substituted.
  assert.equal(db.getTask(C, id).sheet.constraints.budget.value, "under $2000 a month");
});

test("something Reason found about the world is not a goal change and goes straight on", async () => {
  const { id } = (await start()).task;
  const out = await call("task_update", {
    task_id: id,
    sheet: {
      constraints: {
        broker_fee_norm: { value: "one month's rent is standard in this area", source: "found" },
        train_walk: { value: "441 graham is 4 min from the Graham Ave L", source: "found" },
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.task.sheet.constraints.broker_fee_norm.from, "you found it");
  assert.equal(out.task.sheet.constraints.train_walk.from, "you found it");
});

test("blocked is only for when the routes have run out, and it has to say what would unblock it", async () => {
  const { id } = (await start()).task;
  const early = await call("task_update", { task_id: id, state: "blocked" });
  assert.equal(early.ok, false);
  assert.match(early.error, /If there is another safe route to the same goal, take it instead/);

  const real = await call("task_update", {
    task_id: id, state: "blocked",
    sheet: {
      routes: [
        { tried: "streeteasy", failed_because: "403 to an automated browser" },
        { tried: "renthop", failed_because: "nothing readable came back" },
        { tried: "zillow", failed_because: "403" },
      ],
      blocked: { what: "all three listing sites refuse an automated browser", unblock: "you pasting a link to one you're looking at, or a number I can ring" },
    },
  });
  assert.equal(real.ok, true);
  assert.match(real.task.blocked_by, /all three listing sites refuse/);
  assert.match(real.task.blocked_by, /would need: you pasting a link/);
  assert.equal(real.task.sheet.routes_that_failed.length, 3, "and the three it tried are named");
});
