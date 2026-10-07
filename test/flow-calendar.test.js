// The calendar workflow with the real model in the controller's seat.
//
// `test/calendar-conflict.test.js` proves the tools: the conflict read, the time settling, the
// read-back and the correction guard, all against the fake Google. It drives them directly, so the
// one thing it cannot prove is the one thing `docs/unverified.md` names as the risk — whether the
// model, handed a clash, does the right thing with it. Four things in the order of what it would
// cost to get them wrong:
//
//   1. **A clash is put to them, not resolved for them.** The tool refuses and hands back the real
//      event. What the model does next is the whole feature: name what is in the way and wait. A
//      model that moved the time itself to dodge the clash, or ploughed on with allow_conflict, has
//      made somebody's decision for them — and the ground truth is the fake's own events array,
//      which must still hold exactly the one event that was already there.
//   2. **"Keep both" is honoured as said.** Their answer produces the event, once.
//   3. **A correction corrects.** "Actually make it 4" has to become a change to the event it just
//      made. A third event on the calendar is the failure, and it is the one nobody notices until
//      they look at their own week.
//   4. **Nothing is claimed before the read-back.** The reply quotes a real stored time.
//
// One test, four turns, on purpose: this runs on Omari's Claude subscription and every turn is his
// money. No real Google — the same fake the rest of the Google suite uses. Skipped with no model
// reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-calendar.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-cal-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not an undo-window test. Nobody else is on any of these events, so nothing would be held anyway —
// off so that stays true if the hold rules ever widen.
process.env.REASON_UNDO_SECONDS = "0";

const { startGoogle } = await import("./fixture-google.js");
const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const google = await import("../src/google.js");
const { config, clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
let fake;

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.publicUrl = "";
});

after(async () => {
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM conversations; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES], calendarTimeZone: "America/New_York" });
});

/** Google connected through its real handshake, so the tokens are ones the flow produced. */
async function connectGoogle() {
  const link = await runTool("google_connect", {}, { conversationId: C, messages: [] });
  const state = new URL(link.url).searchParams.get("state");
  await google.completeConnect({ code: "good-code", state });
}

const dentists = () => fake.state.events.filter(e => /dent/i.test(e.summary ?? ""));
const startOf = (e) => e.start?.dateTime ?? e.start?.date ?? "";

test(`a clash is put to him, his answer is honoured, and his correction corrects (${label})`, { skip }, async () => {
  await connectGoogle();
  // Already on his calendar, with a name and a place so there is something real to be told about.
  fake.seedEvent({
    summary: "Coffee with Sarah", location: "Blue Bottle",
    start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" },
  });
  const rt = new Runtime({ log: () => {} });

  // 1. The clash. The date is spelled out so nothing here turns on the model's guess about which
  // Thursday he meant — that is a different test and this one is about what it does with a clash.
  const asked = String(await rt.inbound(C, "put a dentist appointment on my calendar for october 9th 2026, 2:30pm to 3:30pm"));

  assert.equal(dentists().length, 0, `it created the event over his coffee without asking. it said: ${asked}`);
  assert.equal(fake.state.events.length, 1, "his calendar should still be just the coffee");
  // It has to say what is in the way. Naming Sarah or the coffee is the pass; "I can't" or a silent
  // retry is not.
  assert.match(asked, /sarah|coffee/i, `it did not say what the clash is with: ${asked}`);
  // And it must not have quietly moved the appointment to a free slot instead of asking him.
  assert.match(asked, /\?|which|or |instead|both|move/i, `it did not leave the choice with him: ${asked}`);

  // 2. His answer, in his own words.
  const made = String(await rt.inbound(C, "keep both, put it on anyway"));

  assert.equal(dentists().length, 1, `"keep both" produced ${dentists().length} dentist appointments. it said: ${made}`);
  assert.equal(fake.state.events.length, 2, "the coffee should still be there too");
  assert.match(startOf(dentists()[0]), /^2026-10-09T14:30/, `it is not at the time he asked for: ${startOf(dentists()[0])}`);
  // A read-back really happened, which is what the reply is allowed to lean on.
  const reads = db.listActions(C).find(a => a.action === "calendar_create" && a.outcome === "ok");
  assert.ok(reads, "no create was recorded in the ledger");
  assert.equal(reads.result.confirmed, true, `the create was not confirmed by a read-back: ${JSON.stringify(reads.result.mismatch ?? reads.result)}`);

  // 3. The correction. One event, moved — never a second one.
  const fixed = String(await rt.inbound(C, "actually make it 4pm instead"));

  assert.equal(dentists().length, 1, `the correction made a second event. it said: ${fixed}`);
  assert.match(startOf(dentists()[0]), /^2026-10-09T16:00/, `it was not moved to four: ${startOf(dentists()[0])}`);
  assert.equal(fake.state.events.length, 2, "and nothing else on his calendar moved or vanished");
  // The change went to the id the create handed back, which is the whole point of the note.
  const changed = db.listActions(C).find(a => a.action === "calendar_change" && a.outcome === "ok");
  assert.ok(changed, `it did not change the event — it did something else. it said: ${fixed}`);
  assert.equal(changed.result.event_id, reads.result.event_id, "it changed a different event than the one it made");
});
