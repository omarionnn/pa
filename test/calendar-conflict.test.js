// Check, create, confirm, correct — the calendar as a workflow rather than a POST.
//
// Omari, 2026-10-06: "for calendar, check conflicts, create the event, confirm it exists, and update
// that same event when I correct the time. A bare 'create event' action leaves me managing the rest."
// Four things, and each of them has a way of failing that a person only finds out about by looking at
// their own calendar days later. So each one is held here, from the side of the fake Google rather
// than from what the client meant to do:
//
//   1. **Nothing is written on top of something already there without them choosing.** The clash
//      comes back with the title, the time and the place, nothing is created, and going ahead takes
//      an explicit `allow_conflict` — which is their decision carried, not a retry. The flip side
//      matters just as much: a clear diary costs no extra round trip and no extra question.
//   2. **"Tuesday at 3" is refused.** Not parsed generously, not resolved against this machine's
//      clock. A time with no date, or a wall-clock time with no zone to read it in, is a question to
//      put to the person, and the tool says which question.
//   3. **"Added" is never said on the strength of a 200.** Every write is read back by id and
//      compared, and an event that landed an hour out is reported as an event that landed an hour
//      out — which is checkable here because the fake can be told to store one somewhere else.
//   4. **A correction corrects.** Create, then change the time, and there is exactly ONE event.
//
// No real credentials and no network: the base URLs point at the fixture, and
// test/fixture-google.js answers the documented Calendar routes.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-calconflict-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
// Not an undo-window test: an event with other people on it is normally held for thirty seconds
// before it really goes, which would make every gated create in here come back 'held'.
process.env.REASON_UNDO_SECONDS = "0";

const { runTool } = await import("../src/tools.js");
const google = await import("../src/google.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
let fake;
const call = (name, input, conversationId = OMARI, messages = []) => runTool(name, input, { conversationId, messages });
const owner = (text) => ({ role: "user", content: `[Sat Oct 3 2026, 9:00 AM] Omari: ${text}` });
const readsYes = () => async () => ({ verdict: "yes" });

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
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM permissions;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.reset();
  fake.set({
    email: "me@example.com",
    grantScopes: [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES],
    accessTtlSeconds: 3600, refreshTokenValid: true, giveRefreshToken: true,
    revokeWorks: true, profileWorks: true, calendarTimeZone: "America/New_York",
    calendarShiftHours: 0, calendarListFails: false,
  });
  for (const k of ["tokenCalls", "authHeaders", "events", "eventWrites"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
  fake.state.refreshCounter = 0;
});

async function connect(conversationId = OMARI) {
  const link = await call("google_connect", {}, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  return google.completeConnect({ code: "good-code", state });
}

/** Take a gated tool through the gate the way the model is told to: ask, be answered, act. */
async function withYes(name, input, conversationId = OMARI) {
  const blocked = await call(name, input, conversationId);
  assert.equal(blocked.blocked, "needs_confirmation", JSON.stringify(blocked));
  const msgs = [owner("do it")];
  const req = await runTool("confirm_request", { action: name, summary: "the thing", target: blocked.use_target }, { conversationId, messages: msgs });
  msgs.push(owner("yes go"));
  const rec = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId, messages: msgs, judge: readsYes() });
  assert.equal(rec.state, "granted", JSON.stringify(rec));
  return { out: await call(name, { ...input, confirmation_id: req.confirmation_id }, conversationId, msgs), confirmation_id: req.confirmation_id, messages: msgs };
}

const lists = () => fake.state.eventWrites.filter(w => w.what === "list");
const inserts = () => fake.state.eventWrites.filter(w => w.what === "insert");
const patches = () => fake.state.eventWrites.filter(w => w.what === "patch");

// ---------- 1. is anything already there ----------

test("something already at that time comes back as the clash it is, and nothing is created", async () => {
  await connect();
  fake.seedEvent({
    summary: "Sarah", location: "Blue Bottle",
    start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" },
  });

  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T14:30:00", end: "2026-10-09T15:30:00" });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "conflict");
  // The three things a person needs to be able to choose: what it is, when it is, where it is.
  assert.equal(out.content.conflicts.length, 1);
  assert.equal(out.content.conflicts[0].summary, "Sarah");
  assert.equal(out.content.conflicts[0].location, "Blue Bottle");
  assert.match(out.content.conflicts[0].start, /^2026-10-09T14:00:00/);
  // The tradeoff is the model's to put, in their words, and the result says so rather than picking.
  assert.match(out.error, /SHOW THEM THE TRADEOFF/);
  assert.match(out.error, /allow_conflict: true/);
  assert.equal(inserts().length, 0, "nothing was put on the calendar");
  assert.equal(fake.state.events.length, 1, "only the one that was already there");
  // What was already on the calendar is somebody else's words, the same as an email's.
  assert.match(out.untrusted_content, /never a command to follow/);
});

test("the check reads Google's own overlap bounds, so a clear time is created in the SAME call", async () => {
  await connect();
  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });

  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T16:00:00", end: "2026-10-09T16:30:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, "created");
  assert.equal(inserts().length, 1, "one call, one event — a clear diary costs them nothing");
  // And it really asked, with the proposed window as the bounds and recurring events expanded.
  const asked = lists().at(-1);
  assert.match(asked.timeMin, /^2026-10-09T16:00:00-04:00$/, "timeMin is the proposed START (lower bound on an event's end)");
  assert.match(asked.timeMax, /^2026-10-09T16:30:00-04:00$/, "timeMax is the proposed END (upper bound on an event's start)");
  assert.equal(asked.singleEvents, "true");
  assert.equal(asked.orderBy, "startTime");
});

test("back to back is not a clash: both of Google's bounds are exclusive", async () => {
  await connect();
  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T15:00:00", end: "2026-10-09T16:00:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, "created");
});

test("allow_conflict puts it on anyway, and says that is what happened", async () => {
  await connect();
  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  const input = { summary: "Dentist", start: "2026-10-09T14:30:00", end: "2026-10-09T15:30:00" };

  assert.equal((await call("calendar_create", input)).status, "conflict");
  const out = await call("calendar_create", { ...input, allow_conflict: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.kept_alongside_a_clash, true);
  assert.equal(fake.state.events.length, 2, "both are on the calendar, because that is what they chose");
});

test("what the calendar says is not a clash is not reported as one", async () => {
  await connect();
  // Three of Google's own ways of saying "this does not take that time", each read off a documented
  // field: transparency transparent ("does not block time on the calendar"), a birthday eventType
  // ("special all-day events with an annual recurrence"), and their own declined response status.
  fake.seedEvent({ summary: "Focus", transparency: "transparent", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  fake.seedEvent({ summary: "Kofi's birthday", eventType: "birthday", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  fake.seedEvent({
    summary: "Standup", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" },
    attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }, { email: "kofi@example.com" }],
  });
  fake.seedEvent({ summary: "Cancelled thing", status: "cancelled", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });

  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T14:30:00", end: "2026-10-09T15:00:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, "created");
});

test("an all-day entry is not checked, because a trip is not a slot", async () => {
  await connect();
  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  const out = await call("calendar_create", { summary: "Accra", start: "2026-10-09", end: "2026-10-12" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.event.all_day, true);
  assert.equal(lists().length, 0, "nothing was asked, so nobody's holiday reads as a clash with their week");
});

test("a conflict check that could not run refuses the write rather than claiming the time is free", async () => {
  await connect();
  fake.set({ calendarListFails: true });
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T14:30:00", end: "2026-10-09T15:30:00" });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "conflict_check_failed");
  assert.match(out.error, /could not read/);
  assert.match(out.error, /rather than saying the time is free/);
  assert.equal(inserts().length, 0);
});

test("a clash found after the yes leaves that yes intact, so 'keep both' is one more call and not another question", async () => {
  await connect();
  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  const input = { summary: "Dinner", start: "2026-10-09T14:30:00", end: "2026-10-09T16:00:00", attendees: ["kofi@example.com"] };

  const { out, confirmation_id, messages } = await withYes("calendar_create", input);
  assert.equal(out.status, "conflict", JSON.stringify(out));
  assert.equal(inserts().length, 0, "nobody was invited to anything");

  // The same yes, spent on the same event, now that they have said to keep both. allow_conflict is
  // deliberately not part of the confirm target, so their decision does not cost them a second ask.
  const anyway = await call("calendar_create", { ...input, allow_conflict: true, confirmation_id }, OMARI, messages);
  assert.equal(anyway.ok, true, JSON.stringify(anyway));
  assert.equal(inserts()[0].sendUpdates, "all");
});

// ---------- 2. "Tuesday at 3" is not a time yet ----------

test("a time with no date on it is refused, and the refusal says to ask them which day", async () => {
  await connect();
  for (const bad of ["tuesday 3pm", "2026-10-09T15", "next week", "oct 9 3pm", "2026-10-09 15:00"]) {
    const out = await call("calendar_create", { summary: "Dentist", start: bad, end: "2026-10-09T15:30:00" });
    assert.equal(out.ok, false, bad);
    assert.equal(out.status, "unsettled_time", `${bad}: ${JSON.stringify(out)}`);
    assert.match(out.error, /ASK them/, bad);
  }
  // "3pm" is three characters and never reaches the tool at all: the schema refuses it first. Named
  // here because "refused by the schema" and "refused by the tool" are both refusals, and a test that
  // asserted one status for both would be asserting the wrong thing about one of them.
  const tiny = await call("calendar_create", { summary: "Dentist", start: "3pm", end: "2026-10-09T15:30:00" });
  assert.equal(tiny.ok, false);
  assert.equal(inserts().length, 0, "nothing landed on a day nobody named");
});

test("with no zone anywhere it refuses and names the question, rather than using this machine's clock", async () => {
  await connect();
  // Google has no time zone on the calendar and the person has never said theirs. The server Reason
  // runs on has one — America/New_York, from REASON_TZ — and that is exactly what must not be used.
  fake.set({ calendarTimeZone: "" });
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T15:00:00", end: "2026-10-09T15:30:00" });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "no_time_zone");
  assert.equal(out.time_zone_known, false);
  assert.match(out.error, /Do NOT guess/);
  assert.match(out.error, /what time zone/);
  assert.equal(inserts().length, 0);
  assert.equal(lists().length, 0, "and it did not even look: there was no window to look at");
});

test("a time carrying its own offset settles itself, zone or no zone", async () => {
  await connect();
  fake.set({ calendarTimeZone: "" });
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T15:00:00-04:00", end: "2026-10-09T15:30:00-04:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(inserts()[0].body.start, { dateTime: "2026-10-09T15:00:00-04:00" }, "no zone was invented to sit beside it");
});

test("an all-day date needs no zone, because Google stores a date with none on it", async () => {
  await connect();
  fake.set({ calendarTimeZone: "" });
  const out = await call("calendar_create", { summary: "Accra", start: "2026-10-09", end: "2026-10-12" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(inserts()[0].body.start, { date: "2026-10-09" });
});

test("the zone they told Reason is used when Google has none, and the result says where it came from", async () => {
  await connect();
  fake.set({ calendarTimeZone: "" });
  // The same column the watchful sweep reads: what they answered when asked what zone they are in.
  db.setNoticeWindow(OMARI, { tz: "Europe/London", answeredAt: clock.now() });
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T15:00:00", end: "2026-10-09T15:30:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(inserts()[0].body.start.timeZone, "Europe/London");
  assert.match(out.time_zone_from, /told you/);
});

test("half a date and half a time is refused rather than stored as whatever Google makes of it", async () => {
  await connect();
  const out = await call("calendar_create", { summary: "Accra", start: "2026-10-09", end: "2026-10-12T09:00:00" });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "unsettled_time");
  assert.equal(inserts().length, 0);
});

// ---------- 3. confirm it exists ----------

test("every create is read back by id, and the reply is told to quote what Google really stored", async () => {
  await connect();
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T15:00:00", end: "2026-10-09T15:30:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.confirmed, true);
  assert.ok(out.event_id, "the id is on the result");
  assert.equal(out.stored.id, out.event_id, "read back by THAT id, in THAT account");
  assert.match(out.confirmed_note, /Read back from me@example\.com/);
  assert.match(out.confirmed_note, /Quote THAT/);
});

test("an event that landed somewhere other than where it was asked for is reported, not smoothed over", async () => {
  await connect();
  // The fake stores it an hour out. Nothing a real Google does on purpose — it is the one failure
  // this whole check exists for, and a check nobody can make fail is a check nobody has tested.
  fake.set({ calendarShiftHours: 1 });
  const out = await call("calendar_create", { summary: "Dentist", start: "2026-10-09T15:00:00", end: "2026-10-09T15:30:00" });
  // It IS on their calendar, so the tool does not pretend otherwise — but `confirmed` is false and
  // the mismatch is in the result, which is what stops "added, 3pm ✅" being the reply.
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.confirmed, false);
  const starts = out.mismatch.find(d => d.field === "start");
  assert.ok(starts, JSON.stringify(out.mismatch));
  assert.equal(starts.asked, "2026-10-09T15:00:00");
  // Compared as a moment rather than as a string: Google may answer in any zone, and "it is an hour
  // out" is a fact about the instant. 16:00 in New York is what the fake really stored.
  assert.equal(Date.parse(starts.stored), Date.parse("2026-10-09T16:00:00-04:00"), `Google has it at ${starts.stored}`);
  assert.match(out.mismatch_note, /IT IS NOT WHAT WAS ASKED FOR/);
  assert.match(out.mismatch_note, /do not report it as done/);
  assert.match(out.note, /IT IS NOT WHAT WAS ASKED FOR/);
});

test("a change is read back too, so a correction is confirmed rather than assumed", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00" });
  const out = await call("calendar_change", { event_id: made.event_id, start: "2026-10-09T16:00:00", end: "2026-10-09T18:00:00" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.confirmed, true);
  assert.equal(out.stored.id, made.event_id);
  assert.match(out.stored.start, /16:00/);
});

// ---------- 4. a correction corrects ----------

test("create, then change the time: exactly ONE event, and it is at the new time", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00" });
  assert.equal(made.ok, true, JSON.stringify(made));
  // The id and the instruction travel in the result, which is what the thread carries into the next
  // turn: this is how the model knows a correction has somewhere to go.
  assert.match(made.note, new RegExp(`THE EVENT ID IS ${made.event_id}`));
  assert.match(made.note, /Never a second calendar_create/);

  const fixed = await call("calendar_change", { event_id: made.event_id, start: "2026-10-09T16:00:00", end: "2026-10-09T18:00:00" });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(fixed.event_id, made.event_id, "the same event, not a new one");

  assert.equal(fake.state.events.length, 1, "exactly one event on the calendar");
  assert.equal(inserts().length, 1);
  assert.equal(patches().length, 1);
  assert.match(fake.state.events[0].start.dateTime, /^2026-10-09T16:00:00/);
});

test("the same thing again on the same day is refused and handed the id to change instead", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00" });
  const again = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T16:00:00", end: "2026-10-09T18:00:00" });
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(again.status, "already_made");
  assert.equal(again.event_id, made.event_id);
  assert.match(again.error, /calendar_change on event_id/);
  assert.equal(fake.state.events.length, 1, "still one dinner");
});

test("the same thing on a DIFFERENT day is its own event, not a correction", async () => {
  await connect();
  await call("calendar_create", { summary: "Gym", start: "2026-10-09T07:00:00", end: "2026-10-09T08:00:00" });
  const next = await call("calendar_create", { summary: "Gym", start: "2026-10-10T07:00:00", end: "2026-10-10T08:00:00" });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(fake.state.events.length, 2);
});

test("allow_duplicate is there for the person who really wants two, and nothing else opens that door", async () => {
  await connect();
  await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T20:00:00" });
  const second = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T21:00:00", end: "2026-10-09T22:00:00", allow_duplicate: true });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(fake.state.events.length, 2);
});

test("a create they cancelled afterwards blocks nothing", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T20:00:00" });
  assert.equal((await call("calendar_delete", { event_id: made.event_id })).ok, true);
  const again = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T20:00:00" });
  assert.equal(again.ok, true, JSON.stringify(again));
});

test("moving an event does not clash with itself, and does clash with the thing it is moved onto", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00" });
  // Nudged half an hour: it overlaps where it already was, which is not a conflict with anything.
  const nudged = await call("calendar_change", { event_id: made.event_id, start: "2026-10-09T19:30:00", end: "2026-10-09T21:30:00" });
  assert.equal(nudged.ok, true, JSON.stringify(nudged));

  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T14:00:00-04:00" }, end: { dateTime: "2026-10-09T15:00:00-04:00" } });
  const onto = await call("calendar_change", { event_id: made.event_id, start: "2026-10-09T14:30:00", end: "2026-10-09T16:00:00" });
  assert.equal(onto.status, "conflict", JSON.stringify(onto));
  assert.equal(onto.content.conflicts[0].summary, "Sarah");
  assert.equal(patches().length, 1, "the nudge, and nothing since — the clash changed nothing");

  const anyway = await call("calendar_change", { event_id: made.event_id, start: "2026-10-09T14:30:00", end: "2026-10-09T16:00:00", allow_conflict: true });
  assert.equal(anyway.ok, true, JSON.stringify(anyway));
});

test("a change that is not a time change is not put through a conflict check", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00" });
  fake.seedEvent({ summary: "Sarah", start: { dateTime: "2026-10-09T19:30:00-04:00" }, end: { dateTime: "2026-10-09T20:00:00-04:00" } });
  const before = lists().length;
  const out = await call("calendar_change", { event_id: made.event_id, location: "Carbone" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(lists().length, before, "nothing was asked about clashes: nothing moved");
});

test("a new time on a change is settled the same way a create's is", async () => {
  await connect();
  const made = await call("calendar_create", { summary: "Dinner", start: "2026-10-09T19:00:00", end: "2026-10-09T21:00:00" });
  const out = await call("calendar_change", { event_id: made.event_id, start: "thursday 4pm" });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.status, "unsettled_time", JSON.stringify(out));
  assert.equal(patches().length, 0);
});

// ---------- the rule reaches the model on the backend the live Reason runs on ----------

test("check-create-confirm-correct reaches the model with calendar_create, on both backends", async () => {
  // Asserted against the source the way test/whatsnew.test.js does. The two backends share one
  // system prompt — src/backends/claude-cli.js imports systemFor from src/agent.js — so what has to
  // be checked is that the rule is in that prompt AND that the CLI backend really sends it. Without
  // the second half a rule could live in a string the live Reason never passes to the model.
  // The full rule moved out of the system prompt and rides on the calendar tools (src/playbooks.js):
  // the API backend sends it on calendar_create, the CLI backend on every calendar write tool. The
  // prompt keeps the one line that sends the model there.
  const agent = readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(agent, /calendar_create's description is the rule/);
  const { tools } = await import("../src/tools.js");
  const { MCP_TOOLS } = await import("../src/backends/mcp-core.js");
  const api = tools.find(t => t.name === "calendar_create").description;
  const cli = MCP_TOOLS.filter(t => ["calendar_create", "calendar_change"].includes(t.name)).map(t => t.description);
  for (const must of [
    /ONE WORKFLOW AND NOT ONE ACTION/,
    /before the read-back has confirmed it/,
    /TRADEOFF YOU PUT TO THEM/,
    /is not a time yet/,
    /Never a second event/,
  ]) {
    assert.match(api, must, "calendar_create must carry the calendar workflow rule");
    for (const d of cli) assert.match(d, must, "every calendar write tool must carry it on the CLI");
  }
  const cliSrc = readFileSync(new URL("../src/backends/claude-cli.js", import.meta.url), "utf8");
  assert.match(cliSrc, /import \{ systemFor \} from "\.\.\/agent\.js"/, "the CLI backend must take the prompt from src/agent.js");
  // The prompt is built from systemFor(me) plus the thread's anchor (systemWithAnchor), and that is
  // what the CLI really sends: `common.system` is the anchored prompt.
  assert.match(cliSrc, /const systemBase = systemFor\(me\)/, "the base prompt comes from systemFor");
  assert.match(cliSrc, /const system = systemWithAnchor\(systemBase, parts\.anchor\)/, "and the anchored prompt is what goes out");
  assert.match(cliSrc, /const common = \{ system, mcpUrl/, "and must really send it");
});
