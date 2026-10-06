// Noticing things first, offline: the watchful sweep, the budget and the three-question test.
//
// What is being proved here is the half that is code's, because that is the half that has to be
// right whatever the model does:
//
//   1. **The sweep cannot text.** It runs one event turn and the reply is held unless `notice_send`
//      claimed something. A fake model that writes a lovely line and skips the tool sends nothing.
//   2. **Nothing is said twice.** A moved meeting is news once, not on every sweep for two days,
//      and the key carries the state so moving AGAIN is a new thing to say.
//   3. **One a day means one a day.** Counted in the database, spent only when the text really went
//      out, reset at THEIR local midnight, with a ceiling urgent cannot argue past. A second catch
//      the same day is held, not lost: it folds into the next reply they are already reading.
//   4. **Quiet hours are theirs, not this machine's.**
//   5. **The three questions are a bar.** A false flag refuses, and so does a key that was already
//      said and a key nobody handed over.
//   6. **A sent catch leaves a receipt**, so "what have you been up to" includes the things nobody
//      asked for.
//   7. **Not connected is said plainly** rather than dressed up as keeping an eye out.
//   8. **An export is a copy and a delete is a delete**, including the new tables.
//
// The model is faked and Google is the fixture in test/fixture-google.js — the same rig the Gmail,
// calendar and Drive tests use. Nothing here has ever been sent to Google, and no API key is
// needed. What a fake cannot settle is in docs/unverified.md: whether the model's judgement of
// "worth interrupting somebody for" is any good is not a thing a test can assert.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle, fakeMessage } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-notice-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { userMessageFor } = await import("../src/agent.js");
const notice = await import("../src/notice.js");
const google = await import("../src/google.js");
const db = await import("../src/db.js");
const { exportData, deleteData } = await import("../src/data.js");
const { config, clock } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OMARI = "dm:owner";
const TZ = "America/New_York";
const EVERYTHING = [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES];

let fake;
const call = (name, input, { conversationId = OMARI, kind = "event" } = {}) =>
  runTool(name, input, { conversationId, kind, messages: [] });

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.googleDriveBase = fake.url;
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  // Every one of these tests is about whether something unprompted goes out, and one of the rules
  // that decides it is the hour where the person is. So each test starts at ten in the morning
  // their time rather than at whatever o'clock the suite happens to be run at — otherwise the whole
  // file passes by day and fails at midnight, which is the one time you would want to trust it.
  skipToLocalHour(10);
  db.db.exec(`DELETE FROM notice_seen; DELETE FROM notice_events; DELETE FROM notice_budget; DELETE FROM notice_sweeps;
    DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts;
    DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM timers; DELETE FROM tasks; DELETE FROM task_log;
    DELETE FROM plans; DELETE FROM usage; DELETE FROM conversations;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  config.noticePerDay = 1;
  config.noticeHardCap = 3;
  config.noticeEveryMs = 2 * HOUR;
  config.noticeQuietStart = 22;
  config.noticeQuietEnd = 8;
  config.noticeWaitingHours = 24;
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: EVERYTHING });
  // An empty mailbox by default, so a test about the calendar is only about the calendar. The
  // fixture's own mail is dated the 3rd of October, which is days ago by the time this runs, so
  // leaving it in place would make "somebody is waiting on a reply" a candidate in every single
  // test. The mail tests below seed exactly the mail they are about.
  fake.setAccount("me@example.com", { mail: [] });
  for (const k of ["tokenCalls", "authHeaders", "sent", "events", "eventWrites", "searches"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
});

/** The real handshake, so the grant under test is one Google really issued to this conversation. */
async function connect({ conversationId = OMARI, grants = EVERYTHING } = {}) {
  fake.set({ grantScopes: grants });
  const link = await call("google_connect", {}, { conversationId });
  assert.equal(link.ok, true, JSON.stringify(link));
  const done = await google.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });
  assert.equal(done.ok, true, JSON.stringify(done));
}

/**
 * A runtime whose turns are a fake model.
 *
 * `answer` is handed the frame the real model would read and a `call` that runs a real tool on a
 * turn of the right kind — so what is being tested is the gate and the plumbing, with the
 * judgement stubbed out. Returning a string is "it said this"; returning null is NO_REPLY.
 */
function harness(answer) {
  const turns = [];
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind });
      return await answer({
        conversationId, text, kind, n: turns.length,
        keys: keysIn(text),
        call: (name, input) => runTool(name, input, { conversationId, kind, messages: [] }),
      });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

/**
 * The keys a frame put in front of the model, in order. How the fake model "reads" the bundle.
 *
 * Both shapes: the sweep lists candidates as "- [key] what", and the follow-on and the parked-moment
 * frames name one key in quotes. A fake model that could only read the first would pass the sweep
 * tests and silently never exercise the other two turns.
 */
const keysIn = (text) => {
  const listed = [...String(text).matchAll(/^- \[([^\]]+)\]/gm)].map(m => m[1]);
  return listed.length ? listed : [...String(text).matchAll(/key "([^"]+)"/g)].map(m => m[1]);
};

/** An ISO time `ms` from now, which is what a seeded event and a parsed start both use. */
const at = (ms) => new Date(clock.now() + ms).toISOString();

/** One event on the fake calendar, in Google's own shape. */
function seed({ id, summary, startsIn, attendees = [], status = "confirmed" }) {
  return fake.seedEvent({
    id, summary, status,
    start: { dateTime: at(startsIn) }, end: { dateTime: at(startsIn + HOUR) },
    ...(attendees.length ? { attendees: attendees.map(e => ({ email: e, responseStatus: "accepted" })) } : {}),
  });
}

/** Move an event already on the fake calendar, the way somebody moving a meeting would. */
function move(id, startsIn) {
  const e = fake.state.events.find(x => x.id === id);
  e.start = { dateTime: at(startsIn) };
  e.end = { dateTime: at(startsIn + HOUR) };
  return e;
}

/** Forward to the next moment it is `hour`:00 where they are, keeping the minutes. */
function skipToLocalHour(hour) {
  for (let i = 0; i < 48; i++) {
    if (notice.localHour(clock.now(), TZ) === hour) return;
    clock.skip(HOUR);
  }
  throw new Error(`never reached ${hour}:00 local`);
}

/** Claim and settle one, the way a turn that really sent its line does. */
function told(key, { day = null, free = false } = {}) {
  const row = db.getNotice(OMARI, key);
  assert.ok(db.claimNotice(row.id, { what: row.what }), `claimed ${key}`);
  return db.markNoticeSaid(OMARI, { day: day ?? notice.localDay(clock.now(), TZ), free });
}

/** A candidate written down the way a sweep writes one, for the gate tests. */
function candidate({ key, kind = "calendar_moved", what = "your 2pm with dana moved to 3", momentAt = null } = {}) {
  return db.recordNotice(OMARI, { kind, key, what, momentAt: momentAt ?? clock.now() });
}

const GOOD = { what: "your 2pm with dana moved to 3, it was buried in the thread", why_now: "it is today", specific_to_them: true, one_word_answerable: true };

// ---------- what counts as a change, with no calendar anywhere near it ----------

test("a meeting that moved is one change, and the key carries the time it moved to", () => {
  // Each time taken once and reused: `at()` reads the clock, so calling it twice for "the same"
  // time gives two strings a millisecond apart and the assertion would be about nothing.
  const [five, six, seven] = [at(5 * HOUR), at(6 * HOUR), at(7 * HOUR)];
  const before = [{ account: "me@x", event_id: "e1", summary: "Dana", start: five, attendees: [] }];
  const after = [{ account: "me@x", id: "e1", summary: "Dana", start: six, attendees: [] }];
  const got = notice.calendarChanges(before, after, { now: clock.now() });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "calendar_moved");
  assert.match(got[0].what, /moved from/);
  assert.ok(got[0].key.endsWith(six), "the key is the event AND the time it moved to");

  // Found again, unchanged: not a change at all.
  assert.deepEqual(notice.calendarChanges(
    [{ account: "me@x", event_id: "e1", summary: "Dana", start: six, attendees: [] }], after, { now: clock.now() }), []);

  // Moved again: a different key, so it is a second thing to say rather than the same one.
  const moved = notice.calendarChanges(
    [{ account: "me@x", event_id: "e1", summary: "Dana", start: six, attendees: [] }],
    [{ account: "me@x", id: "e1", summary: "Dana", start: seven, attendees: [] }],
    { now: clock.now() });
  assert.equal(moved.length, 1);
  assert.notEqual(moved[0].key, got[0].key);
});

test("cancelled, new, and somebody new on it are each their own change", () => {
  const now = clock.now();
  // Standup's time is taken ONCE and used on both sides. Calling at() twice would give two strings
  // a millisecond apart, and the test would be asserting that a meeting moved.
  const [three, four, five] = [at(3 * HOUR), at(4 * HOUR), at(5 * HOUR)];
  const before = [
    { account: "a", event_id: "keep", summary: "Standup", start: three, attendees: ["kofi@example.com"] },
    { account: "a", event_id: "gone", summary: "Dentist", start: four, attendees: [] },
  ];
  const after = [
    { account: "a", id: "keep", summary: "Standup", start: three, attendees: [{ email: "kofi@example.com" }, { email: "dana@example.com" }] },
    { account: "a", id: "fresh", summary: "Coffee with Sam", start: five, attendees: [] },
  ];
  const got = notice.calendarChanges(before, after, { now });
  const kinds = got.map(g => g.kind).sort();
  assert.deepEqual(kinds, ["calendar_attendee", "calendar_cancelled", "calendar_new"]);
  assert.match(got.find(g => g.kind === "calendar_attendee").what, /dana@example\.com/);
  assert.match(got.find(g => g.kind === "calendar_cancelled").what, /Dentist/);
});

test("nothing outside the window, and nothing that has already started, is news", () => {
  const now = clock.now();
  const changes = notice.calendarChanges(
    [{ account: "a", event_id: "e1", summary: "Far off", start: at(10 * DAY), attendees: [] }],
    [
      { account: "a", id: "e1", summary: "Far off", start: at(11 * DAY), attendees: [] },   // beyond 48h
      { account: "a", id: "e2", summary: "Happening now", start: at(-30 * MIN), attendees: [] }, // already begun
    ],
    { now });
  assert.deepEqual(changes, [], "a meeting next month moving is not news today, and neither is the one you are in");
});

test("the moment is two hours before the thing, now when it is nearly here, and now with no time at all", () => {
  // The instant and the string it becomes are taken from the same reading of the clock: `at()` reads
  // it again, so `now` and `at(10 * HOUR)` can be a millisecond apart and the arithmetic would be
  // off by exactly that.
  const now = clock.now();
  const isoIn = (ms) => new Date(now + ms).toISOString();
  assert.equal(notice.momentFor({ starts: isoIn(10 * HOUR) }, now), now + 10 * HOUR - config.noticeLeadMin * MIN);
  assert.equal(notice.momentFor({ starts: isoIn(3 * HOUR) }, now), now, "inside the next few hours is too soon to sit on");
  assert.equal(notice.momentFor({ starts: isoIn(-1 * HOUR) }, now), now);
  assert.equal(notice.momentFor({ what: "a bill" }, now), now, "a bill has no moment to wait for");
});

test("quiet hours are read where they are, and wrap midnight", () => {
  const night = Date.parse("2026-10-07T02:30:00-04:00");
  const morning = Date.parse("2026-10-07T09:30:00-04:00");
  assert.equal(notice.inQuietHours(night, TZ), true);
  assert.equal(notice.inQuietHours(morning, TZ), false);
  // The same instant, somewhere it is the afternoon.
  assert.equal(notice.inQuietHours(night, "Asia/Tokyo"), false, "their night is their zone's, not this machine's");
  assert.equal(notice.localDay(night, TZ), "2026-10-07");
});

// ---------- the three questions, and the keys ----------

test("a flag answered false refuses, names which, and sends nothing", () => {
  candidate({ key: "k1" });
  const a = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k1", specific_to_them: false } });
  assert.equal(a.ok, false);
  assert.deepEqual(a.failed, ["specific_to_them"]);
  assert.match(a.error, /Silence is better than noise/);

  const b = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k1", one_word_answerable: false } });
  assert.equal(b.ok, false);
  assert.deepEqual(b.failed, ["one_word_answerable"]);

  const both = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k1", specific_to_them: false, one_word_answerable: false } });
  assert.deepEqual(both.failed, ["specific_to_them", "one_word_answerable"]);

  assert.equal(db.pendingNotice(OMARI), null, "nothing was claimed by any of them");
  assert.equal(db.noticeBudget(OMARI, notice.localDay(clock.now(), TZ)).sent, 0, "and their day is untouched");
});

test("a key nobody handed over is refused, and so is one already said", () => {
  const made = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "invented-by-the-model" } });
  assert.equal(made.ok, false);
  assert.match(made.error, /nothing in front of you/);

  const row = candidate({ key: "k2" });
  assert.equal(notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k2" } }).ok, true);
  db.markNoticeSaid(OMARI, { day: notice.localDay(clock.now(), TZ) });
  const again = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k2" } });
  assert.equal(again.ok, false);
  assert.equal(again.status, "already_said");
  assert.ok(db.noticeById(row.id).said_at, "the row still says it went");
});

test("urgent needs a reason on it", () => {
  candidate({ key: "k3" });
  const no = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k3", urgent: true } });
  assert.equal(no.ok, false);
  assert.equal(no.status, "no_urgent_reason");
  const yes = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "k3", urgent: true, urgent_why: "it starts in 40 minutes" } });
  assert.equal(yes.ok, true);
  assert.equal(yes.urgent, true);
});

test("the second catch of the day is held, not sent — and urgent gets through to the ceiling", () => {
  const day = notice.localDay(clock.now(), TZ);
  const spend = (key, extra = {}) => {
    candidate({ key });
    const v = notice.send({ conversationId: OMARI, input: { ...GOOD, key, ...extra } });
    if (v.ok) db.markNoticeSaid(OMARI, { day });
    return v;
  };

  assert.equal(spend("a").ok, true);
  assert.equal(db.noticeBudget(OMARI, day).sent, 1);

  // Their one a day is gone. An ordinary second catch is refused and HELD.
  const second = spend("b");
  assert.equal(second.ok, false);
  assert.equal(second.status, "budget_spent");
  assert.match(second.error, /held, not lost/);
  assert.ok(db.getNotice(OMARI, "b").held_at, "it is written down as held");
  assert.ok(db.heldNotices(OMARI).some(r => r.key === "b"), "so it goes first next time");

  // Urgent gets past the ordinary allowance, twice, and then hits the ceiling.
  assert.equal(spend("c", { urgent: true, urgent_why: "it starts in 30 minutes" }).ok, true);
  assert.equal(spend("d", { urgent: true, urgent_why: "the flight is now" }).ok, true);
  assert.equal(db.noticeBudget(OMARI, day).sent, 3);
  const over = spend("e", { urgent: true, urgent_why: "really, truly urgent" });
  assert.equal(over.ok, false);
  assert.equal(over.status, "hard_cap");
  assert.match(over.error, /ceiling/);
});

test("the budget resets at their local midnight, not this machine's and not 24h later", () => {
  const day = notice.localDay(clock.now(), TZ);
  candidate({ key: "x" });
  assert.equal(notice.send({ conversationId: OMARI, input: { ...GOOD, key: "x" } }).ok, true);
  db.markNoticeSaid(OMARI, { day });
  assert.equal(notice.budgetFor(OMARI, { timeZone: TZ }).spent, true);

  // Forward to one in the morning, their time: a new day, so a new allowance.
  skipToLocalHour(1);
  const tomorrow = notice.localDay(clock.now(), TZ);
  assert.notEqual(tomorrow, day, "it is a different day where they are");
  assert.equal(notice.budgetFor(OMARI, { timeZone: TZ }).spent, false);
  assert.equal(notice.budgetFor(OMARI, { timeZone: TZ }).sent, 0);
  // Yesterday's count is still there, untouched — a reset is a new row, not an erasure.
  assert.equal(db.noticeBudget(OMARI, day).sent, 1);
});

test("in the middle of their night nothing ordinary goes out, and urgent still does", () => {
  skipToLocalHour(2);
  candidate({ key: "night" });
  const held = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "night" } });
  assert.equal(held.ok, false);
  assert.equal(held.status, "quiet_hours");
  assert.equal(held.time_zone, TZ);
  assert.ok(db.getNotice(OMARI, "night").held_at);

  candidate({ key: "night-urgent" });
  const woke = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "night-urgent", urgent: true, urgent_why: "their 6am flight was cancelled" } });
  assert.equal(woke.ok, true);
});

test("somebody who asked for nothing unprompted gets nothing unprompted", async () => {
  const saved = await call("notice_settings", { per_day: 0 });
  assert.equal(saved.ok, true);
  assert.equal(saved.per_day, 0);
  assert.match(saved.note, /nothing unprompted/);

  candidate({ key: "none" });
  const no = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "none" } });
  assert.equal(no.ok, false);
  assert.equal(no.status, "they_asked_for_none");
  assert.ok(db.getNotice(OMARI, "none").held_at, "still noticed, just never sent on its own");

  // And it is their setting, not a default anybody can read as one.
  assert.equal(notice.settingsFor(OMARI).perDay, 0);
  assert.match(notice.status({ conversationId: OMARI, connected: true }).their_own_setting, /nothing unprompted/);
});

test("a line riding on a reply they are already reading costs them nothing", () => {
  const day = notice.localDay(clock.now(), TZ);
  candidate({ key: "ride" });
  const out = notice.send({ conversationId: OMARI, input: { ...GOOD, key: "ride" }, kind: "user" });
  assert.equal(out.ok, true);
  assert.equal(out.free, true);
  db.markNoticeSaid(OMARI, { day, free: true });
  assert.equal(db.noticeBudget(OMARI, day).sent, 0, "it interrupted nobody, so it is not counted");
  assert.ok(db.getNotice(OMARI, "ride").said_at, "and it is still down as told, so it is not said twice");
});

test("a catch about something later is scheduled for the moment, not sent now", async () => {
  await connect();
  candidate({ key: "later", momentAt: clock.now() + 6 * HOUR });
  const out = await call("notice_send", { ...GOOD, key: "later" });
  assert.equal(out.ok, true);
  assert.equal(out.scheduled, true);
  assert.match(out.note, /NO_REPLY/);
  const row = db.getNotice(OMARI, "later");
  assert.ok(row.timer_id, "a one-off timer carries it");
  assert.equal(row.said_at, null, "and nothing has been said");
  assert.equal(db.pendingNotice(OMARI), null, "nothing is claimed either");
  const timer = db.getTimer(OMARI, row.timer_id);
  assert.equal(timer.fire_at, row.moment_at, "for the moment the sweep worked out, not for whenever");
  assert.ok(Math.abs(timer.fire_at - (clock.now() + 6 * HOUR)) < MIN, "which is about six hours off");
  assert.equal(db.noticeByTimer(timer.id).key, "later", "the timer knows which catch it belongs to");
});

// ---------- gathering, against the fixture Google ----------

test("the first look writes the calendar down and raises nothing from it", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 5 * HOUR });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now() });
  assert.equal(bundle.ok, true);
  assert.deepEqual(bundle.candidates.filter(c => c.kind.startsWith("calendar_")), [], "nothing has changed — Reason has simply never looked");
  assert.match(bundle.context.join(" "), /first look/);
  assert.equal(db.noticeEvents(OMARI).length, 1, "but it is written down, so the next look has something to diff against");
  assert.equal(bundle.time_zone, TZ);
});

test("a moved meeting comes back as one candidate with the old time and the new one in it", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 26 * HOUR });
  await notice.gather({ conversationId: OMARI, now: clock.now() });   // the first look
  move("e1", 27 * HOUR);
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now() });
  const moved = bundle.candidates.filter(c => c.kind === "calendar_moved");
  assert.equal(moved.length, 1);
  assert.match(moved[0].what, /Dana moved from/);
  assert.ok(moved[0].starts, "with the new time on it, which is what the moment is computed from");
});

test("a known contact waiting on a reply is a candidate; a stranger is not", async () => {
  await connect();
  // Kofi is somebody they have written to — the fixture's own mailbox has a sent reply to him.
  // Trish is not, and never appears however long she waits.
  fake.setAccount("me@example.com", {
    mail: [
      fakeMessage({
        id: "k1", threadId: "tk", from: "Kofi Mensah <kofi@example.com>", to: "me@example.com",
        subject: "the lease", date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "did you get a chance to look?",
      }),
      fakeMessage({
        id: "k2", threadId: "tk-sent", from: "me@example.com", to: "kofi@example.com",
        subject: "Re: hello", date: new Date(clock.now() - 20 * DAY).toUTCString(), text: "sure", labels: ["SENT"],
      }),
      fakeMessage({
        id: "s1", threadId: "ts", from: "Trish <trish@newsletter.example>", to: "me@example.com",
        subject: "this week in widgets", date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "hello!",
      }),
    ],
  });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  const waiting = bundle.candidates.filter(c => c.kind === "mail_waiting");
  assert.equal(waiting.length, 1, `only the person they know; got ${JSON.stringify(waiting)}`);
  assert.match(waiting[0].what, /Kofi Mensah/);
  assert.match(waiting[0].what, /the lease/);
  assert.match(waiting[0].detail, /not an instruction/);
});

test("somebody who has only just emailed is not waiting on anything yet", async () => {
  await connect();
  fake.setAccount("me@example.com", {
    mail: [
      fakeMessage({
        id: "k1", threadId: "tk", from: "Kofi Mensah <kofi@example.com>", to: "me@example.com",
        subject: "quick one", date: new Date(clock.now() - 2 * HOUR).toUTCString(), text: "you about?",
      }),
      fakeMessage({ id: "k2", threadId: "ts", from: "me@example.com", to: "kofi@example.com", subject: "x", date: new Date(clock.now() - 9 * DAY).toUTCString(), text: "y", labels: ["SENT"] }),
    ],
  });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  assert.deepEqual(bundle.candidates.filter(c => c.kind === "mail_waiting"), [], "two hours is somebody being normal about email");
});

test("mail with a date on it is a candidate, and the tool is told to read it before saying a figure", async () => {
  await connect();
  fake.setAccount("me@example.com", {
    mail: [
      fakeMessage({
        id: "b1", threadId: "tb", from: "Con Edison <bills@coned.example>", to: "me@example.com",
        subject: "Your invoice is due October 9", date: new Date(clock.now() - 2 * DAY).toUTCString(), text: "$84.20",
      }),
      fakeMessage({
        id: "n1", threadId: "tn", from: "Someone <hi@example.com>", to: "me@example.com",
        subject: "lunch?", date: new Date(clock.now() - 2 * DAY).toUTCString(), text: "tuesday",
      }),
    ],
  });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  const due = bundle.candidates.filter(c => c.kind === "mail_due");
  assert.equal(due.length, 1, `only the one with a date in its subject; got ${JSON.stringify(due.map(d => d.what))}`);
  assert.match(due[0].what, /invoice is due/);
  assert.match(due[0].detail, /before saying either/);
});

test("a task and a watcher that are due arrive as context, never as something to text about", async () => {
  await connect();
  db.createTask(OMARI, { title: "chase the handyman", goal: "get a time", wakeAt: clock.now() - MIN, maxAttempts: 3 });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now() });
  const work = bundle.candidates.filter(c => c.kind === "work_due");
  assert.equal(work.length, 1);
  assert.equal(notice.KINDS.work_due.speakable, false, "its own pass reports it better than this one could");
  const frame = notice.sweepFrame({
    conversationId: OMARI, candidates: bundle.candidates, budget: notice.budgetFor(OMARI, { timeZone: TZ }), timeZone: TZ,
  });
  assert.match(frame, /do NOT text about these/);
});

test("with nothing connected there is nothing to gather and nothing is claimed", async () => {
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now() });
  assert.equal(bundle.ok, false);
  assert.ok(bundle.error, "and it says why rather than coming back empty and cheerful");
  assert.equal(db.noticeEvents(OMARI).length, 0);
});

// ---------- the sweep, end to end ----------

test("a moved meeting: one event turn, one text, and the real thing in front of the model", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  const { rt, turns, sent } = harness(async ({ keys, call: t }) => {
    const out = await t("notice_send", { ...GOOD, key: keys[0] });
    return out.ok ? "your dana thing moved to 3, it was buried in the thread" : null;
  });
  try {
    await rt.notice();                       // the first look: writes it down, says nothing
    assert.equal(turns.length, 0, "a first look is not news");
    assert.equal(sent.length, 0);

    move("e1", 5 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    const out = await rt.notice();
    assert.equal(out.turns, 1, "exactly one event turn");
    assert.equal(out.told, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, "event");
    assert.match(turns[0].text, /watchful sweep/);
    assert.match(turns[0].text, /Dana moved from/, "the frame points at the real thing, not at 'something changed'");
    assert.match(turns[0].text, /Silence is better than noise\./);
    assert.equal(sent.length, 1, "one text, not a burst");
    assert.equal(sent[0].fromNotice, true);
    assert.match(sent[0].text, /moved to 3/);

    // Spent, told, and never news again.
    const day = notice.localDay(clock.now(), TZ);
    assert.equal(db.noticeBudget(OMARI, day).sent, 1, "it costs them their one text a day, now that it really went");
    assert.ok(db.noticesSaid(OMARI).length === 1);

    clock.skip(config.noticeEveryMs + MIN);
    const third = await rt.notice();
    assert.equal(third.turns, 0, "the same moved meeting is not news a second time");
    assert.equal(sent.length, 1);
  } finally { await rt.shutdown(); }
});

test("the sweep cannot text: a model that skips the tool sends nothing", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  const { rt, turns, sent } = harness(async () => "your dana thing moved, thought you'd want to know");
  try {
    await rt.notice();
    move("e1", 5 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    const out = await rt.notice();
    assert.equal(out.turns, 1, "it got its turn");
    assert.equal(turns.length, 1);
    assert.equal(sent.length, 0, "and its line was held back, because it never went through the gate");
    assert.equal(db.noticeBudget(OMARI, notice.localDay(clock.now(), TZ)).sent, 0, "so it cost them nothing");
    assert.ok(db.heldNotices(OMARI).length >= 1, "and the thing is still there to be raised again");
  } finally { await rt.shutdown(); }
});

test("a second change the same day is held, and folds into the next reply instead", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  seed({ id: "e2", summary: "Standup", startsIn: 30 * HOUR });
  const { rt, turns, sent } = harness(async ({ keys, call: t }) => {
    const out = await t("notice_send", { ...GOOD, key: keys[0] });
    return out.ok && !out.scheduled ? "your dana thing moved to 3" : null;
  });
  try {
    await rt.notice();
    move("e1", 5 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    assert.equal((await rt.notice()).told, 1);
    assert.equal(sent.length, 1);
    const turnsAfterFirst = turns.length;

    // Something else changes the same day. Their one text is spent, so it is not sent and not lost.
    move("e2", 31 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    const second = await rt.notice();
    assert.equal(second.turns, 0, "no turn at all: code knew before paying for one");
    assert.equal(turns.length, turnsAfterFirst);
    assert.equal(sent.length, 1, "and no second text");
    assert.deepEqual(second.skipped.map(s => s.why), ["budget_spent"]);

    const held = db.heldNotices(OMARI);
    assert.ok(held.some(r => r.kind === "calendar_moved" && /Standup/.test(r.what)), "it is held, with the real words still on it");

    // Now THEY text. It rides out on the end of that reply, which interrupts nobody.
    const note = notice.heldNote({ conversationId: OMARI, held });
    assert.match(note, /Standup/);
    assert.match(note, /very END of your reply/);
    assert.match(note, /costs them nothing/);
    const { forModel, forHistory } = userMessageFor({ prefix: "[x] Omari:", text: "hey", turnNote: [note, ""] });
    assert.match(forModel.content, /Standup/, "the model really sees it on a turn they started");
    assert.doesNotMatch(forHistory.content, /Standup/, "and it does not go into the thread's history");
  } finally { await rt.shutdown(); }
});

test("in their night the sweep holds everything and pays for no turn", async () => {
  await connect();
  seed({ id: "e1", summary: "Standup", startsIn: 30 * HOUR });
  const { rt, turns, sent } = harness(async () => "hello at 3am");
  try {
    await rt.notice();
    skipToLocalHour(3);
    move("e1", 31 * HOUR);
    const out = await rt.notice();
    assert.equal(out.turns, 0);
    assert.equal(turns.length, 0, "nobody pays for a model call in the middle of their night");
    assert.equal(sent.length, 0);
    assert.deepEqual(out.skipped.map(s => s.why), ["quiet_hours"]);
    assert.ok(db.heldNotices(OMARI).length >= 1, "held for the morning");
  } finally { await rt.shutdown(); }
});

test("nothing is looked at before its cadence is up", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  const { rt } = harness(async () => null);
  try {
    await rt.notice();
    const reads = fake.state.eventWrites.length;
    const again = await rt.notice();
    assert.deepEqual(again.skipped.map(s => s.why), ["not due"]);
    assert.equal(fake.state.eventWrites.length, reads, "and nothing was asked of Google either");

    // Their own "check more often" moves it.
    await call("notice_settings", { every_minutes: 15 });
    clock.skip(16 * MIN);
    const sooner = await rt.notice();
    assert.equal(sooner.looked, 1);
  } finally { await rt.shutdown(); }
});

test("a sent catch leaves a receipt, so 'what have you been up to' includes it", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  const { rt } = harness(async ({ keys, call: t }) => {
    const out = await t("notice_send", { ...GOOD, key: keys[0], why_now: "it is in four hours" });
    return out.ok ? "your dana thing moved to 3" : null;
  });
  try {
    await rt.notice();
    move("e1", 5 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    await rt.notice();
    const ledger = await call("ledger_list", {});
    const row = ledger.actions.find(a => a.action === "notice_send");
    assert.ok(row, `the catch is in the ledger; got ${JSON.stringify(ledger.actions.map(a => a.action))}`);
    assert.equal(row.outcome, "ok");
    assert.match(row.receipt, /Told Omari, unprompted/);
    assert.match(row.receipt, /moved to 3/);
    assert.match(row.receipt, /why then: it is in four hours/);
  } finally { await rt.shutdown(); }
});

test("a catch whose moment is hours off is scheduled, and the timer's turn is held to the same gate", async () => {
  await connect();
  seed({ id: "e1", summary: "Dinner", startsIn: 30 * HOUR });
  const { rt, sent } = harness(async ({ keys, call: t }) => {
    const out = await t("notice_send", { ...GOOD, key: keys[0] });
    return out.ok && !out.scheduled ? "your dinner moved to 8" : null;
  });
  try {
    await rt.notice();
    move("e1", 31 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    await rt.notice();
    assert.equal(sent.length, 0, "it is about tomorrow night, so nothing is said now");
    const row = db.heldNotices(OMARI).find(r => r.kind === "calendar_moved")
      ?? db.db.prepare("SELECT * FROM notice_seen WHERE conversation_id = ? AND timer_id IS NOT NULL").get(OMARI);
    assert.ok(row?.timer_id, "a one-off timer is carrying it");

    // The moment comes. The timer's turn goes through notice_send like any other.
    clock.skip(db.getTimer(OMARI, row.timer_id).fire_at - clock.now() + MIN);
    assert.ok(await rt.tick() >= 1);
    assert.equal(sent.length, 1, "now it goes, at the moment it is useful");
    assert.equal(sent[0].fromNotice, row.key);
    assert.equal(db.noticeBudget(OMARI, notice.localDay(clock.now(), TZ)).sent, 1, "and only now does it cost them anything");
  } finally { await rt.shutdown(); }
});

test("the timer for a scheduled catch sends nothing on its own if the gate is not called", async () => {
  await connect();
  seed({ id: "e1", summary: "Dinner", startsIn: 30 * HOUR });
  let armed = false;
  const { rt, sent } = harness(async ({ keys, call: t }) => {
    if (!armed) { armed = true; const out = await t("notice_send", { ...GOOD, key: keys[0] }); assert.equal(out.scheduled, true); return null; }
    return "your dinner moved to 8";   // the moment came, and the model skipped the gate
  });
  try {
    await rt.notice();
    move("e1", 31 * HOUR);
    clock.skip(config.noticeEveryMs + MIN);
    await rt.notice();
    const row = db.db.prepare("SELECT * FROM notice_seen WHERE conversation_id = ? AND timer_id IS NOT NULL").get(OMARI);
    clock.skip(db.getTimer(OMARI, row.timer_id).fire_at - clock.now() + MIN);
    await rt.tick();
    assert.equal(sent.length, 0, "the gate is the only way out, on the timer's turn as much as the sweep's");
  } finally { await rt.shutdown(); }
});

// ---------- what finishing something sets in motion ----------

test("a task finishing gets one offer, in one line, counted against the same budget", async () => {
  await connect();
  const { rt, turns, sent } = harness(async ({ text, call: t }) => {
    assert.match(text, /what does this set in motion/);
    const key = /key "([^"]+)"/.exec(text)[1];
    const out = await t("notice_send", {
      key, what: "want me to sort a ride to the airport?", why_now: "the flight is booked for friday",
      specific_to_them: true, one_word_answerable: true,
    });
    return out.ok ? "want me to sort a ride to the airport?" : null;
  });
  try {
    const task = db.createTask(OMARI, { title: "book the flight", goal: "a seat on friday", maxAttempts: 3 });
    await rt.followOn();                       // first run: records the mark, raises nothing
    assert.equal(turns.length, 0);

    db.finishTask(OMARI, task.id, { state: "done", outcome: "booked, friday 6:40am, confirmation XJ22" });
    clock.skip(MIN);
    const out = await rt.followOn();
    assert.equal(out.turns, 1);
    assert.equal(out.offered, 1);
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /book the flight/);
    assert.match(turns[0].text, /ride to\n? ?the airport|ride to the airport/);
    assert.match(turns[0].text, /Never do it\./, "it offers, it does not act");
    assert.match(turns[0].text, /Silence is better than noise\./);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].fromFollowOn, `after:task:${task.id}`);
    assert.equal(db.noticeBudget(OMARI, notice.localDay(clock.now(), TZ)).sent, 1, "an offer nobody asked for costs the same as any other");

    // And only once, however many sweeps go by.
    clock.skip(MIN);
    assert.equal((await rt.followOn()).turns, 0);
    assert.equal(sent.length, 1);
  } finally { await rt.shutdown(); }
});

test("a task that failed sets nothing in motion, and a spent day holds the offer", async () => {
  await connect();
  const { rt, turns } = harness(async () => "something");
  try {
    const dead = db.createTask(OMARI, { title: "chase the plumber", goal: "a time", maxAttempts: 3 });
    await rt.followOn();
    db.finishTask(OMARI, dead.id, { state: "failed", outcome: "never answered" });
    clock.skip(MIN);
    assert.equal((await rt.followOn()).turns, 0, "nothing good follows from a thing that did not happen");
    assert.equal(turns.length, 0);

    // Their day already spent: the offer is held rather than squeezed in.
    db.bumpNoticeBudget(OMARI, notice.localDay(clock.now(), TZ));
    const ok = db.createTask(OMARI, { title: "book the table", goal: "a table", maxAttempts: 3 });
    db.finishTask(OMARI, ok.id, { state: "done", outcome: "8pm friday, 4 people" });
    clock.skip(MIN);
    const out = await rt.followOn();
    assert.equal(out.turns, 0);
    assert.deepEqual(out.skipped.map(s => s.why), ["budget_spent"]);
    assert.ok(db.heldNotices(OMARI).some(r => r.kind === "follow_on"));
  } finally { await rt.shutdown(); }
});

// ---------- saying so honestly ----------

test("with nothing connected, the honest answer is that nothing is being watched", async () => {
  const st = await call("notice_status", {});
  assert.equal(st.watching, false);
  assert.match(st.why_not, /not watching mail or calendar for you/);
  assert.match(st.why_not, /google_connect/);
  const cap = capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "notice");
  assert.equal(cap.status, "not connected");
  assert.match(cap.what, /NOT watching anything/);
  assert.match(cap.what, /Never say you will keep an eye out/);
});

test("connected, the capability says the real cadence, the real budget and the real quiet hours", async () => {
  await connect();
  const cap = capabilitiesNow({ conversationId: OMARI }).find(c => c.name === "notice");
  assert.equal(cap.status, "live");
  assert.match(cap.what, /120 minutes/);
  assert.match(cap.what, /1 unprompted text a day/);
  assert.match(cap.what, /22:00 and 8:00/);
  assert.match(cap.what, /notice_status/);
});

test("'why haven't you told me anything' has a real answer in it", async () => {
  await connect();
  const day = notice.localDay(clock.now(), TZ);
  candidate({ key: "told" , what: "your 2pm with dana moved to 3" });
  assert.equal(notice.send({ conversationId: OMARI, input: { ...GOOD, key: "told" } }).ok, true);
  db.markNoticeSaid(OMARI, { day });
  candidate({ key: "held", what: "con edison's invoice is due friday" });
  notice.send({ conversationId: OMARI, input: { ...GOOD, key: "held" } });   // refused: day spent
  db.markNoticeSwept(OMARI, { at: clock.now(), timeZone: TZ });

  const st = await call("notice_status", {});
  assert.equal(st.watching, true);
  assert.equal(st.budget.used_today, 1);
  assert.equal(st.budget.per_day, 1);
  assert.equal(st.budget.left_today, 0);
  assert.equal(st.told_them.length, 1);
  assert.match(st.told_them[0].what, /dana moved to 3/);
  assert.equal(st.noticed_and_not_said.length, 1);
  assert.match(st.noticed_and_not_said[0].what, /invoice is due friday/);
  assert.notEqual(st.last_looked, "never");
  assert.equal(st.looks_so_far, 1);
});

test("'text me less' and 'check more often' are saved and honoured", async () => {
  await connect();
  const less = await call("notice_settings", { per_day: 2, every_minutes: 360 });
  assert.equal(less.ok, true);
  assert.equal(less.per_day, 2);
  assert.equal(less.every_minutes, 360);
  // Survives being read back from the account rather than kept in memory.
  assert.deepEqual(db.noticePrefs(OMARI), { perDay: 2, everyMin: 360 });
  assert.equal(notice.settingsFor(OMARI).everyMs, 360 * MIN);
  assert.equal(notice.budgetFor(OMARI, { timeZone: TZ }).per_day, 2);
  const nothing = await call("notice_settings", {});
  assert.equal(nothing.ok, false);
});

// ---------- their data ----------

test("an export carries what was noticed, and a delete takes all of it", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  await notice.gather({ conversationId: OMARI, now: clock.now() });
  candidate({ key: "told", what: "your 2pm with dana moved to 3" });
  notice.send({ conversationId: OMARI, input: { ...GOOD, key: "told" } });
  db.markNoticeSaid(OMARI, { day: notice.localDay(clock.now(), TZ) });
  db.markNoticeSwept(OMARI, { at: clock.now(), timeZone: TZ });

  const out = exportData({ conversation: OMARI, audio: false });
  for (const t of ["notice_seen", "notice_events", "notice_budget", "notice_sweeps"]) {
    assert.ok(out.tables[t]?.length, `${t} is in the export`);
  }
  assert.match(JSON.stringify(out.tables.notice_seen), /dana moved to 3/, "their own words come with them");
  assert.match(JSON.stringify(out.tables.notice_events), /Dana/);

  await deleteData({ conversation: OMARI });
  for (const t of ["notice_seen", "notice_events", "notice_budget", "notice_sweeps"]) {
    assert.equal(db.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE conversation_id = ?`).get(OMARI).n, 0, `${t} is gone`);
  }
});

test("the retention sweep drops the words and keeps the key spent", async () => {
  const { sweepRetention } = await import("../src/privacy.js");
  candidate({ key: "old", what: "your 2pm with dana moved to 3" });
  told("old");
  db.db.exec(`UPDATE notice_seen SET first_seen = ${clock.now() - 400 * DAY} WHERE key = 'old'`);
  db.putNoticeEvents(OMARI, "me@example.com", [{ id: "e9", summary: "Dana", start: at(0), attendees: [] }], clock.now() - 400 * DAY);

  sweepRetention({ now: clock.now() });
  assert.equal(db.noticeEvents(OMARI).length, 0, "an old snapshot is one nothing will ever be compared to");
  // A record this old is past the records window too, so the row itself has gone — which is the
  // honest end state: nothing left to say it twice from, and nothing of theirs kept forever.
  assert.equal(db.getNotice(OMARI, "old"), null);

  // Inside the records window but past the content one: the words go, the row stays spent.
  candidate({ key: "middle", what: "con edison's invoice is due friday" });
  told("middle");
  db.db.exec(`UPDATE notice_seen SET first_seen = ${clock.now() - 60 * DAY} WHERE key = 'middle'`);
  sweepRetention({ now: clock.now() });
  const row = db.getNotice(OMARI, "middle");
  assert.ok(row, "the row is still there");
  assert.equal(row.what, "", "its words are not");
  assert.ok(row.said_at, "and it is still down as told, so it can never be raised again as news");
});
