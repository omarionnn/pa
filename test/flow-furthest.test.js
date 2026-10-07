// A booking walked to the last button, with the real model, and what gets said about it.
//
// The one thing in the furthest-point commit that no offline test can reach: the reply. Code writes
// the record, refuses the bare close and hands the point back in the tool result — but a reply is
// words, and words are the model's. So this is the only check that "sorry, I couldn't book it" has
// become "the form's filled in, your name and number are on it, it just needs your tap".
//
// The site is a local fixture, so no reservation is ever made anywhere real. Ground truth is the
// sheet, the fixture's booking list and the DB; the only thing asserted about the wording is the
// order of three facts in it. Skipped with no model reachable (no API key, no claude-cli backend).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBookingSite } from "./fixture-booking.js";

const dir = mkdtempSync(join(tmpdir(), "reason-furthest-live-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { latestFurthest } = await import("../src/sheet.js");
const { skip, label } = await import("./live.js");

const C = "dm:furthest-live";
const called = [];
const outs = [];
const rt = new Runtime({ log: (e) => { if (e.tool) { called.push(e.tool); outs.push(e); } } });
let site;

before(async () => {
  clock.reset();
  site = await startBookingSite();
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  // His limits, already set. Without them the first thing that would spend money is told to stop
  // and ask for both numbers — correct, and a different stop than the one under test. On the first
  // live run (2026-10-06) that is exactly where the walk went: it filled the form, read the $25
  // hold, and stopped to ask about limits instead of reaching the last button. Set here so this
  // test is about the commit and not about a precondition.
  db.setSpendCaps(C, { perPurchaseCents: 50_000, monthlyCents: 200_000, said: "up to $500 on one thing, $2000 a month" });
});
after(async () => { await rt.shutdown(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

test(`a booking that stops at the commit hands back the filled form and the one tap (${label})`, { skip }, async () => {
  const reply = await rt.inbound(C,
    `book me a table for 4 at carbone on 2026-10-09 at 8pm. the site is ${site.url} — name on it is Omari, number 555-0100.`
    + ` start a task for it so you don't lose it`);

  assert.equal(site.bookings.length, 0, "NOTHING was booked: it stopped at the last button");
  assert.ok(called.includes("browser_open"), `it used the browser; called: ${called.join(",")}`);

  // ---------- what code wrote down ----------
  // Whichever route it took to the last button — trying the click and being refused, or asking for
  // the yes the way the prompt tells it to — the walk is recorded. That is code's half.
  const stopped = outs.find(e => e.out?.furthest);
  assert.ok(stopped, `the stopped walk was recorded in a tool result; tools called: ${called.join(",")}`);
  const point = stopped.out.furthest;
  assert.equal(point.form, "filled_form", `it got as far as a filled form: ${JSON.stringify(point)}`);
  assert.match(point.where, /\/reserve\?/, "the address the browser really reached");
  assert.equal(point.where_known, "browser_reached");
  assert.equal(point.stopped, "needed_a_yes");
  assert.match(point.one_action, /Confirm reservation/i, "the one action is the page's own label for its last button");
  const values = point.filled.map(f => f.value).join(" | ");
  assert.match(values, /Omari/, `the name it typed is on the record: ${values}`);
  assert.match(values, /555-?0100/, `and the number: ${values}`);

  // On the sheet too, when there is one job it could belong to — which is what makes the hand-back
  // survive a restart rather than living in one turn's tool result. With more than one open job
  // code deliberately writes it nowhere (a filled checkout on the wrong errand is worse than one on
  // none), and on the second live run the model did start two, so that case is tolerated here.
  const open = db.listTasks(C);
  if (open.length === 1) {
    const onSheet = latestFurthest(open[0].sheet);
    assert.ok(onSheet, `the point is on task #${open[0].id}'s sheet, not just in a tool result`);
    assert.match(onSheet.one_action, /Confirm reservation/i);
    assert.equal(stopped.out.written_on_task, open[0].id);
  }

  // ---------- what it actually said ----------
  assert.ok(reply && reply.trim().length, "it said something");
  const said = reply.toLowerCase();

  // The three facts that make this a hand-back rather than a status update.
  const at = (re, what) => {
    const m = said.match(re);
    assert.ok(m, `${what} is not in the reply at all: ${JSON.stringify(reply)}`);
    return m.index;
  };
  const filled = at(/fill|filled|your name|name and number|555-?0100|typed in|on the form/, "that the form is already filled in");
  at(/confirm|tap|press|hit|click|say the word|go ahead|yes/, "the one thing left for him to do");

  // And the apology, if there is one at all, is not the first thing he reads. This is the whole
  // point of the commit: the same facts arranged the other way round are useless to him.
  const sorry = said.search(/\b(sorry|apolog|unfortunately|i could ?n'?t|couldn't|can'?t book|unable)\b/);
  if (sorry !== -1) {
    assert.ok(sorry > filled,
      `the apology comes before what exists, which is the failure this commit is about: ${JSON.stringify(reply)}`);
  }

  // It must not claim the booking happened, and it must not claim the link carries the filled form.
  assert.doesNotMatch(said, /\b(booked|reserved it|all set|you'?re booked|confirmed)\b/,
    `nothing was booked, so nothing may say it was: ${JSON.stringify(reply)}`);
});
