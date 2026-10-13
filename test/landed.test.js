// The night of 2026-10-12, replayed, and the four things that were missing that night.
//
//   1. **The sweep wakes the job.** A watcher waiting on Petra; Josh's invite lands on the calendar
//      between its wakes; the sweep sees it, holds it up against the open job, wakes the job NOW
//      and hands the finding to it. The job, not the sweep, is what speaks — one text.
//   2. **A wait cannot sleep ten hours.** The model asks for 8am; code comes back every couple of
//      hours, peeks at what landed, and pays for no turn when nothing did.
//   3. **The ride-along offers the newest held thing**, not a webinar mail from days ago.
//   4. **Something found in their night, for tomorrow, is for the morning** — not two hours before.
//
// Same rig as test/notice.test.js: fake Google, fake model, no API key.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-landed-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const notice = await import("../src/notice.js");
const landed = await import("../src/landed.js");
const google = await import("../src/google.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
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
  config.taskWaitingFloorMin = 120;
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: EVERYTHING });
  fake.setAccount("me@example.com", { mail: [] });
  for (const k of ["tokenCalls", "authHeaders", "sent", "events", "eventWrites", "searches"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
});

async function connect() {
  fake.set({ grantScopes: EVERYTHING });
  const link = await call("google_connect", {});
  assert.equal(link.ok, true, JSON.stringify(link));
  const done = await google.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });
  assert.equal(done.ok, true, JSON.stringify(done));
  db.setNoticeWindow(OMARI, { askedAt: clock.now(), answeredAt: clock.now() });
}

function harness(answer) {
  const turns = [];
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ conversationId, text, kind });
      return await answer({ conversationId, text, kind, n: turns.length, call: (name, input) => runTool(name, input, { conversationId, kind, messages: [] }) });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

const at = (ms) => new Date(clock.now() + ms).toISOString();

function seed({ id, summary, startsIn, attendees = [] }) {
  return fake.seedEvent({
    id, summary, status: "confirmed",
    start: { dateTime: at(startsIn) }, end: { dateTime: at(startsIn + HOUR) },
    ...(attendees.length ? { attendees: attendees.map(e => ({ email: e, responseStatus: "accepted" })) } : {}),
  });
}

function skipToLocalHour(hour) {
  for (let i = 0; i < 48; i++) {
    if (notice.localHour(clock.now(), TZ) === hour) return;
    clock.skip(HOUR);
  }
  throw new Error(`never reached ${hour}:00 local`);
}

/** The task from that night, word for word, as the model wrote it. */
async function petraWatcher({ wakeInMs }) {
  const { id } = (await call("task_start", { title: "tell omari when petra confirms the josh call", goal: "Petra replies", wake_in_minutes: 0 })).task;
  const r = await call("task_update", {
    task_id: id, state: "waiting_on_other", progress: "checked mail from petra, nothing yet",
    sheet: { waiting: [{ on: "Petra", for: "a reply confirming the time for the Josh call" }] },
    wake_at: new Date(clock.now() + wakeInMs).toISOString(),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { id, r };
}

// ---------- matching, with nothing else anywhere near it ----------

test("the watcher's own words match Josh's invite and nothing else", () => {
  const task = { title: "tell omari when petra confirms the josh call", goal: "Petra replies", sheet: { waiting: [{ on: "Petra", for: "a reply" }] } };
  const words = landed.taskWords(task);
  assert.ok(words.includes("petra") && words.includes("josh"), `the names: ${words}`);
  assert.ok(!words.includes("omari"), "the owner's name is in half the titles and names nobody");
  assert.ok(!words.includes("call") && !words.includes("confirms"), `the noise is out: ${words}`);

  const invite = { kind: "calendar_new", what: "Reference on John Amhanesi: Omari <> Josh Lu at 2026-10-13T14:45:00-04:00 is new on their calendar" };
  assert.deepEqual(landed.matchWords(task, invite), ["josh"]);
  const webinar = { kind: "mail_waiting", what: `NVIDIA emailed "GTC webinar: what's new" about 3 days ago, still unread` };
  assert.deepEqual(landed.matchWords(task, webinar), []);
  const dentist = { kind: "calendar_new", what: "Omari's dentist is new on their calendar" };
  assert.deepEqual(landed.matchWords(task, dentist), [], "the owner's name alone matches nothing");
  const reply = { kind: "mail_waiting", what: `Petra Garrett emailed "Re: Josh Lu intro" under an hour ago, still unread`, from: "pgarrett@a16z.com" };
  assert.deepEqual(landed.matchWords(task, reply), ["petra", "josh"]);
});

// ---------- the night, replayed ----------

test("the invite from Josh wakes the job waiting on Petra, and the job is what speaks — once", async () => {
  await connect();
  const { rt, turns, sent } = harness(async ({ text, call }) => {
    // The task's wake: code has put what landed at the top. The fake model reads it, closes the
    // job, and says the one line. (The sweep never gets a turn in this test — asserted below.)
    assert.match(text, /SINCE YOU LAST LOOKED/);
    assert.match(text, /Josh Lu/);
    assert.match(text, /A time confirmed by ANYONE/);
    const id = Number(text.match(/task #(\d+)/)[1]);
    await call("task_finish", { task_id: id, state: "done", outcome: "josh sent the zoom invite for 2:45pm, it's on the calendar" });
    return "josh sent a zoom invite for 2:45 — it's locked, petra didn't need to reply";
  });
  try {
    // A calendar with something already on it, so the first look leaves a real snapshot behind:
    // an empty first look is treated as never having looked, and the next sweep would be "first".
    seed({ id: "standup", summary: "Standup", startsIn: 30 * HOUR });
    await rt.notice();                                   // first look: the snapshot, nothing is news
    const { id } = await petraWatcher({ wakeInMs: 10 * HOUR }); // "next check 8am"
    assert.equal(db.getTask(OMARI, id).state, "waiting_on_other");

    // 10:53pm: the invite lands. Not from Petra, not in the Petra thread.
    skipToLocalHour(23);
    seed({ id: "josh", summary: "Reference on John Amhanesi: Omari <> Josh Lu", startsIn: 16 * HOUR, attendees: ["me@example.com", "josh@example.com"] });

    // 12:51am: the sweep. Their night, so on its own it would hold everything for the morning.
    skipToLocalHour(1);
    const out = await rt.notice();
    assert.ok(out.bridged >= 1 && out.bridged === out.candidates, `everything about that meeting went to the job: ${JSON.stringify(out)}`);
    assert.equal(out.turns, 0, "the sweep itself pays for no turn and says nothing");
    const row = db.db.prepare("SELECT * FROM notice_seen WHERE kind = 'calendar_new'").get();
    assert.equal(row.resolved_why, `task:${id}`, "the candidate is the job's now, not the sweep's");
    assert.equal(db.heldNotices(OMARI).length, 0, "and it is not sitting held for a morning nobody asked for");
    const task = db.getTask(OMARI, id);
    assert.ok(task.next_wake_at <= clock.now(), "the job is due now, not at 8am");
    assert.ok(task.log.some(l => l.kind === "landed" && /Josh Lu/.test(l.note)), "and it has been told what landed");

    // 1am, nobody has texted: the job rests until their morning. The step keeps with it.
    const rested = await rt.runTasks();
    assert.equal(rested.resting, 1);
    assert.equal(turns.length, 0);

    // 8am. One wake, one text, and the job is closed.
    skipToLocalHour(8);
    const woke = await rt.runTasks();
    assert.equal(woke.woke, 1);
    assert.equal(woke.reported, 1);
    assert.equal(turns.length, 1, "exactly one model turn for the whole night");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /zoom invite/);
    assert.equal(sent[0].fromTask, id);
    assert.equal(db.getTask(OMARI, id).state, "done");

    // The next sweep does not raise the invite again as "new on your calendar".
    skipToLocalHour(10);
    const again = await rt.notice();
    assert.equal(again.turns, 0);
    assert.equal(sent.length, 1, "said once");
  } finally { await rt.shutdown(); }
});

test("a job waiting on them is not woken by the sweep", async () => {
  await connect();
  const { rt, turns } = harness(async () => null);
  try {
    seed({ id: "standup", summary: "Standup", startsIn: 30 * HOUR });
    await rt.notice();
    const { id } = (await call("task_start", { title: "book the josh dinner", goal: "a table for 4", wake_in_minutes: 600 })).task;
    await call("task_update", { task_id: id, state: "waiting_on_you", sheet: { needs: { question: "7 or 8pm?", tradeoff: "8 is quieter" } } });
    seed({ id: "josh", summary: "Dinner with Josh", startsIn: 30 * HOUR });
    clock.skip(2 * HOUR);
    const out = await rt.notice();
    assert.equal(out.bridged, 0, "nothing to do on it until they answer");
    assert.equal(turns.length, 1, `so the sweep raises it itself, as it always did: ${JSON.stringify(out)}`);
  } finally { await rt.shutdown(); }
});

// ---------- the floor ----------

test("a wait cannot sleep ten hours: code peeks every couple of hours and pays for no turn when nothing landed", async () => {
  const { rt, turns } = harness(async () => null);
  try {
    const { id, r } = await petraWatcher({ wakeInMs: 10 * HOUR });
    const t = db.getTask(OMARI, id);
    assert.ok(Math.abs(t.next_wake_at - (clock.now() + 2 * HOUR)) < 2000, "pulled in to the floor");
    assert.ok(Math.abs(t.wanted_wake_at - (clock.now() + 10 * HOUR)) < 2000, "the model's own time is kept");
    assert.match(r.wake_note, /kept/);

    // Four peeks, nothing landed, no model turn, and the job is not counted as having woken.
    for (let i = 0; i < 4; i++) {
      clock.skip(2 * HOUR);
      const out = await rt.runTasks();
      assert.equal(out.peeked, 1, `peek ${i + 1}`);
      assert.equal(out.woke, 0);
    }
    assert.equal(turns.length, 0);
    assert.equal(db.getTask(OMARI, id).wakes, 0);

    // The model's own time: a real wake.
    clock.skip(2 * HOUR);
    const out = await rt.runTasks();
    assert.equal(out.woke, 1);
    assert.equal(out.peeked, 0);
    assert.equal(turns.length, 1);
  } finally { await rt.shutdown(); }
});

test("a peek that finds something landed is a real wake, with the finding on top", async () => {
  const { rt, turns } = harness(async ({ text }) => { assert.match(text, /SINCE YOU LAST LOOKED/); return null; });
  try {
    const { id } = await petraWatcher({ wakeInMs: 10 * HOUR });
    clock.skip(2 * HOUR);
    // What the sweep's bridge writes, without a Google anywhere near it.
    const got = landed.bridge(OMARI, [{ kind: "calendar_new", key: "josh@new", what: "Omari <> Josh Lu is new on their calendar", event_id: "josh" }], { now: clock.now() });
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].words, ["josh"]);
    const out = await rt.runTasks();
    assert.equal(out.woke, 1);
    assert.equal(out.peeked, 0);
    assert.equal(turns.length, 1);
    assert.match(turns[0].text, /matched on "josh"/);
    assert.equal(db.getTask(OMARI, id).wakes, 1);
  } finally { await rt.shutdown(); }
});

test("a running job's wake is not floored, and a short wait is left where the model put it", async () => {
  const { id } = (await call("task_start", { title: "find a table for 4 saturday", goal: "a booking", wake_in_minutes: 0 })).task;
  await call("task_update", { task_id: id, progress: "looking", wake_in_minutes: 600 });
  let t = db.getTask(OMARI, id);
  assert.ok(Math.abs(t.next_wake_at - (clock.now() + 10 * HOUR)) < 2000, "running: the model's time stands");
  assert.equal(t.wanted_wake_at, null);
  await call("task_update", { task_id: id, state: "waiting_on_other", sheet: { waiting: [{ on: "the restaurant", for: "a callback" }] }, wake_in_minutes: 30 });
  t = db.getTask(OMARI, id);
  assert.ok(Math.abs(t.next_wake_at - (clock.now() + 30 * MIN)) < 2000, "inside the floor: untouched");
  assert.equal(t.wanted_wake_at, null);
});

// ---------- the ride-along, and the morning ----------

test("the ride-along offers the newest held thing, not the oldest", () => {
  const old = db.recordNotice(OMARI, { kind: "mail_waiting", key: "webinar", what: "NVIDIA webinar mail", momentAt: clock.now(), at: clock.now() - 3 * 24 * HOUR });
  db.holdNotice(old.id, clock.now() - 3 * 24 * HOUR);
  const fresh = db.recordNotice(OMARI, { kind: "calendar_new", key: "josh", what: "Omari <> Josh Lu is new on their calendar", momentAt: clock.now(), at: clock.now() });
  db.holdNotice(fresh.id, clock.now());
  const held = db.heldNotices(OMARI, { limit: 1 });
  assert.equal(held[0].key, "josh");
  assert.match(notice.heldNote({ conversationId: OMARI, held }), /Josh Lu/);
});

test("something found in their night, for tomorrow, is for the morning — not two hours before", () => {
  const opts = { timeZone: TZ, quietStart: 22, quietEnd: 8 };
  skipToLocalHour(1);
  const now = clock.now();
  const morning = notice.quietEndsAt(now, TZ, { start: 22, end: 8 });
  assert.equal(notice.localHour(morning, TZ), 8);
  // 2:45pm today, found at 1am: the morning, not 12:45pm.
  assert.equal(notice.momentFor({ starts: new Date(now + 13.75 * HOUR).toISOString() }, now, opts), morning);
  // 9am today, found at 1am: the lead (7am) comes before the morning and stands, as before.
  assert.equal(notice.momentFor({ starts: new Date(now + 8 * HOUR).toISOString() }, now, opts), now + 8 * HOUR - config.noticeLeadMin * MIN);
  // Without their zone nothing changes: the lead, as it always was.
  assert.equal(notice.momentFor({ starts: new Date(now + 13.75 * HOUR).toISOString() }, now), now + 13.75 * HOUR - config.noticeLeadMin * MIN);
  // By day the lead stands.
  skipToLocalHour(10);
  const day = clock.now();
  assert.equal(notice.momentFor({ starts: new Date(day + 10 * HOUR).toISOString() }, day, opts), day + 10 * HOUR - config.noticeLeadMin * MIN);
});
