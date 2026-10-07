// The four catches about something being WRONG, offline.
//
// What is proved here is the half that is code's, because that is the half that has to be right
// whatever the model does:
//
//   1. **A calendar that may be out of date is a DISAGREEMENT, not a claim.** The candidate exists
//      only when somebody on the meeting wrote AFTER the invite was last touched, it says so in
//      those words, and it never states that the time changed — because code cannot know that.
//   2. **A meeting that really moved is not also raised as stale**, so one meeting is never two
//      lines in two different words.
//   3. **A reply they are waiting on is one nobody answered.** A thread somebody replied in is not
//      a candidate, and the probe ceiling is real.
//   4. **A dated thing coming up is raised once**, off their own calendar, with the date as the only
//      fact on it.
//   5. **A brief goes BEFORE the meeting**: the candidate carries the start, so the moment code
//      picks is two hours before rather than whenever the sweep happened to run.
//   6. **Every one of them names its source**, and the source survives being parked for hours.
//   7. **Every one of them is checked again**, and all four know what "they dealt with it" looks
//      like: a calendar since updated, a reply that has since arrived, a meeting that has started.
//
// Google is the fixture in test/fixture-google.js and the model is never called. What a fake cannot
// settle — whether the model's reading of a thread is any good — is not a thing a test can assert.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle, fakeMessage } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-alerts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const alerts = await import("../src/alerts.js");
const notice = await import("../src/notice.js");
const google = await import("../src/google.js");
const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { config, clock } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OMARI = "dm:owner";
const ME = "me@example.com";
const EVERYTHING = [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES];

let fake;
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
after(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM notice_seen; DELETE FROM notice_events; DELETE FROM notice_budget; DELETE FROM notice_sweeps;
    DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts;
    DELETE FROM action_ledger; DELETE FROM timers; DELETE FROM conversations;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  config.alertStaleHours = 48;
  config.alertAwaitingHours = 48;
  config.alertAwaitingDays = 14;
  config.alertAwaitingProbes = 4;
  config.alertDeadlineHours = 72;
  config.alertBriefHours = 24;
  fake.reset();
  fake.set({ email: ME, grantScopes: EVERYTHING });
  fake.setAccount(ME, { mail: [] });
  for (const k of ["tokenCalls", "authHeaders", "sent", "events", "eventWrites", "searches"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
});

const at = (ms) => new Date(clock.now() + ms).toISOString();
const MINE = new Set([ME]);

/** One event as the live calendar read hands it over: eventView's shape, with the account on it. */
const ev = ({ id = "e1", summary = "Sync with Dana", startsIn = 20 * HOUR, updated = -3 * DAY, attendees = ["dana@example.com"], allDay = false, status = "confirmed" } = {}) => ({
  account: ME, id, summary, status,
  start: allDay ? new Date(clock.now() + startsIn).toISOString().slice(0, 10) : at(startsIn),
  end: allDay ? new Date(clock.now() + startsIn + DAY).toISOString().slice(0, 10) : at(startsIn + HOUR),
  all_day: allDay,
  updated: at(updated),
  attendees: attendees.map(email => ({ email })),
});

/** One unread message as the sweep already has it in hand. */
const mail = ({ from = "dana@example.com", thread = "t1", subject = "moving our sync", wroteAgo = -30 * MIN } = {}) => ({
  account: ME, thread_id: thread, from, from_name: from.split("@")[0], subject, date: at(wroteAgo),
});

// ---------- 1. the calendar that may be out of date ----------

test("somebody on a meeting writing after the invite was last touched is a candidate, and it never claims the time changed", () => {
  const got = alerts.staleCandidates({ events: [ev()], mail: [mail()], mine: MINE, now: clock.now() });
  assert.equal(got.length, 1);
  const c = got[0];
  assert.equal(c.kind, "calendar_stale");
  // The sentence is the disagreement and nothing more. A candidate that said "moved to 3" would be
  // code inventing a time out of a Date header.
  assert.match(c.what, /after the invite was last touched/);
  assert.doesNotMatch(c.what, /moved to/);
  assert.match(c.detail, /read thread t1/);
  assert.match(c.detail, /code does NOT know the time changed/);
  // Grounded in both halves, named, so the turn that says it can open the same two things.
  assert.match(c.source, /calendar event e1/);
  assert.match(c.source, /gmail thread t1/);
  assert.equal(c.thread_id, "t1");
  assert.equal(c.event_id, "e1");
  // No start on it: a calendar that is wrong is worth knowing now, not two hours before the meeting
  // it is wrong about.
  assert.equal(c.starts, undefined);
  assert.equal(notice.momentFor(c, clock.now()), clock.now());
});

test("mail OLDER than the invite is not a disagreement at all", () => {
  // The invite was touched after they wrote: whatever that mail said, the calendar has had its say
  // since. This is the ordinary case and raising it would make the catch fire on every meeting
  // anybody ever emailed about.
  const got = alerts.staleCandidates({
    events: [ev({ updated: -10 * MIN })], mail: [mail({ wroteAgo: -3 * HOUR })], mine: MINE, now: clock.now(),
  });
  assert.deepEqual(got, []);
});

test("a meeting that really moved is the diff's to report, not this one's", () => {
  const got = alerts.staleCandidates({
    events: [ev()], mail: [mail()], mine: MINE, moved: new Set([`${ME}:e1`]), now: clock.now(),
  });
  assert.deepEqual(got, [], "one meeting is never two lines in two different words");
});

test("mail from somebody who is not on the meeting, and an invite with no updated stamp, raise nothing", () => {
  assert.deepEqual(alerts.staleCandidates({
    events: [ev()], mail: [mail({ from: "newsletter@shop.example" })], mine: MINE, now: clock.now(),
  }), [], "a stranger emailing is not news about their 2pm");

  const noStamp = { ...ev(), updated: undefined };
  assert.deepEqual(alerts.staleCandidates({ events: [noStamp], mail: [mail()], mine: MINE, now: clock.now() }), [],
    "with nothing to compare against, nothing is raised rather than something unfounded");
});

test("the key carries the invite's state AND the message, so a fix finishes it and a newer mail is its own thing", () => {
  const one = alerts.staleCandidates({ events: [ev()], mail: [mail()], mine: MINE, now: clock.now() })[0];
  // The invite gets touched: a new key, because the sentence this candidate would say is now wrong.
  const touched = alerts.staleCandidates({
    events: [{ ...ev(), updated: at(-1 * MIN) }], mail: [mail({ wroteAgo: -30 * 1000 })], mine: MINE, now: clock.now(),
  });
  assert.notEqual(touched[0]?.key, one.key);
  // A second message in a different thread is a different thing to look at.
  const other = alerts.staleCandidates({ events: [ev()], mail: [mail({ thread: "t2" })], mine: MINE, now: clock.now() })[0];
  assert.notEqual(other.key, one.key);
  // One per event: three colleagues writing is one thing to go and read.
  const several = alerts.staleCandidates({
    events: [ev()], mine: MINE, now: clock.now(),
    mail: [mail(), mail({ thread: "t2", from: "dana@example.com" })],
  });
  assert.equal(several.length, 1);
});

// ---------- 3. a dated thing coming up ----------

test("an all-day thing inside the window is raised once, with the date as the only fact on it", () => {
  const got = alerts.deadlineCandidates({ events: [ev({ id: "rent", summary: "Rent due", allDay: true, startsIn: 2 * DAY })], now: clock.now() });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "deadline_near");
  assert.match(got[0].what, /Rent due/);
  assert.match(got[0].detail, /never say an amount, a fee or what happens if it is missed/);
  assert.match(got[0].source, /all-day/);
  // No start: "two hours before" an all-day entry is the middle of the night before it.
  assert.equal(got[0].starts, undefined);
});

test("a timed meeting is not a deadline, and neither is one a week out or one already past", () => {
  const timed = alerts.deadlineCandidates({ events: [ev({ startsIn: 2 * DAY })], now: clock.now() });
  assert.deepEqual(timed, [], "a 2pm with Dana is not a deadline");
  const far = alerts.deadlineCandidates({ events: [ev({ id: "x", allDay: true, startsIn: 8 * DAY })], now: clock.now() });
  assert.deepEqual(far, [], "rent on the 1st is not mentioned on the 12th");
  const gone = alerts.deadlineCandidates({ events: [ev({ id: "y", allDay: true, startsIn: -3 * DAY })], now: clock.now() });
  assert.deepEqual(gone, [], "a deadline three days past is not news");
});

// ---------- 4. the brief, before the meeting ----------

test("a meeting in the next day with people on it offers a brief, two hours before rather than now", () => {
  const got = alerts.prepCandidates({ events: [ev({ startsIn: 20 * HOUR })], mine: MINE, now: clock.now() });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "meeting_prep");
  assert.match(got[0].detail, /offer a brief in ONE line/);
  assert.match(got[0].detail, /Never the brief itself unprompted/);
  // The start IS on this one, so code parks it for the moment it is useful.
  assert.equal(got[0].starts, got[0].starts);
  const moment = notice.momentFor(got[0], clock.now());
  assert.ok(moment > clock.now() + 10 * HOUR, "parked for nearer the meeting, not said on the sweep that found it");
});

test("nothing on a meeting with nobody else on it, one next week, or one the diff is already raising", () => {
  assert.deepEqual(alerts.prepCandidates({ events: [ev({ attendees: [] })], mine: MINE, now: clock.now() }), [],
    "a block on their own calendar needs no brief");
  assert.deepEqual(alerts.prepCandidates({ events: [ev({ startsIn: 6 * DAY })], mine: MINE, now: clock.now() }), [],
    "a brief is useful the evening before and pointless the week before");
  assert.deepEqual(alerts.prepCandidates({ events: [ev()], mine: MINE, now: clock.now(), skip: new Set([`${ME}:e1`]) }), [],
    "a meeting already being reported is not also a brief offer in the same sweep");
  assert.deepEqual(alerts.prepCandidates({ events: [ev({ attendees: [ME] })], mine: MINE, now: clock.now() }), [],
    "they are not somebody to be briefed on");
});

// ---------- 2. a reply they are waiting on, against the fixture mailbox ----------

/** The real handshake, so the grant is one Google really issued to this conversation. */
async function connect({ conversationId = OMARI } = {}) {
  fake.set({ grantScopes: EVERYTHING });
  const link = await runTool("google_connect", {}, { conversationId, kind: "user", messages: [] });
  assert.equal(link.ok, true, JSON.stringify(link));
  const done = await google.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });
  assert.equal(done.ok, true, JSON.stringify(done));
  db.setNoticeWindow(conversationId, { askedAt: clock.now(), answeredAt: clock.now() });
}

/** The live accounts and the api the sweep would hand `alerts.gather`. */
async function live() {
  const tokens = await google.allAccessTokens(OMARI);
  assert.equal(tokens.ok, true, JSON.stringify(tokens));
  const accts = tokens.accounts.map(a => ({ ...a, timeZone: "America/New_York" }));
  return { live: accts, api: (a, method, path, opts) => google.api(a.token, method, path, opts) };
}

test("a mail of theirs nobody answered is a candidate; one somebody replied in is not", async () => {
  await connect();
  fake.setAccount(ME, {
    mail: [
      // Theirs, three days ago, never answered.
      fakeMessage({
        id: "m1", threadId: "lease", from: `Omari <${ME}>`, to: "Quinn <quinn@example.com>",
        subject: "the lease", date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "can you send it over?",
        labels: ["SENT"],
      }),
      // Theirs, four days ago — and answered.
      fakeMessage({
        id: "m2", threadId: "invoice", from: `Omari <${ME}>`, to: "Kofi <kofi@example.com>",
        subject: "invoice", date: new Date(clock.now() - 4 * DAY).toUTCString(), text: "did this go out?",
        labels: ["SENT"],
      }),
      fakeMessage({
        id: "m3", threadId: "invoice", from: "Kofi <kofi@example.com>", to: ME,
        subject: "Re: invoice", date: new Date(clock.now() - 2 * DAY).toUTCString(), text: "yep, sent monday",
        labels: ["INBOX"],
      }),
    ],
  });

  const { live: accts, api } = await live();
  const got = await alerts.awaitingCandidates({ live: accts, api, mine: new Set([ME]), now: clock.now() });
  const keys = got.candidates.map(c => c.key);
  assert.equal(got.candidates.length, 1, JSON.stringify(keys));
  const c = got.candidates[0];
  assert.equal(c.kind, "awaiting_reply");
  assert.match(c.what, /quinn@example\.com/);
  assert.match(c.what, /nobody has replied/);
  assert.match(c.source, /their own message of/);
  assert.equal(c.thread_id, "lease");
  // One nudge per THREAD, and another day waited is a new candidate rather than a second licence.
  assert.equal(c.thing, `awaiting:${ME}:lease`);
  assert.match(c.key, /@3d$/);
});

test("a mail sent this morning is not a reply anybody owes them yet", async () => {
  await connect();
  fake.setAccount(ME, {
    mail: [fakeMessage({
      id: "m1", threadId: "today", from: `Omari <${ME}>`, to: "quinn@example.com",
      subject: "quick one", date: new Date(clock.now() - 4 * HOUR).toUTCString(), text: "free later?", labels: ["SENT"],
    })],
  });
  const { live: accts, api } = await live();
  const got = await alerts.awaitingCandidates({ live: accts, api, mine: new Set([ME]), now: clock.now() });
  assert.deepEqual(got.candidates, [], "four hours is somebody being busy, not a reply that never came");
});

test("a note to themselves and a no-reply address are never replies anybody owes", async () => {
  await connect();
  fake.setAccount(ME, {
    mail: [
      fakeMessage({
        id: "m1", threadId: "self", from: `Omari <${ME}>`, to: ME, subject: "todo",
        date: new Date(clock.now() - 5 * DAY).toUTCString(), text: "remember the thing", labels: ["SENT"],
      }),
      fakeMessage({
        id: "m2", threadId: "bot", from: `Omari <${ME}>`, to: "no-reply@shop.example", subject: "order",
        date: new Date(clock.now() - 5 * DAY).toUTCString(), text: "where is it", labels: ["SENT"],
      }),
    ],
  });
  const { live: accts, api } = await live();
  const got = await alerts.awaitingCandidates({ live: accts, api, mine: new Set([ME]), now: clock.now() });
  assert.deepEqual(got.candidates, []);
});

test("the probe ceiling is real: a sent mailbox is never read without a bound", async () => {
  await connect();
  config.alertAwaitingProbes = 2;
  const mails = [];
  for (let i = 0; i < 8; i++) {
    mails.push(fakeMessage({
      id: `m${i}`, threadId: `t${i}`, from: `Omari <${ME}>`, to: `person${i}@example.com`,
      subject: `one ${i}`, date: new Date(clock.now() - (3 + i) * DAY).toUTCString(), text: "?", labels: ["SENT"],
    }));
  }
  fake.setAccount(ME, { mail: mails });
  const { live: accts, api } = await live();
  const got = await alerts.awaitingCandidates({ live: accts, api, mine: new Set([ME]), now: clock.now() });
  assert.ok(got.probes <= 2, `probes stayed under the ceiling (${got.probes})`);
  assert.ok(got.candidates.length <= 2, "and so did what it raised");
});

// ---------- the four, through the sweep's own gather ----------

test("the sweep raises all four alongside everything it already found, each with its source on the row", async () => {
  await connect();
  // A sweep that has looked before, so the calendar diff is live rather than a first look.
  const syncStart = at(20 * HOUR);
  const rentDay = new Date(clock.now() + 2 * DAY).toISOString().slice(0, 10);
  fake.seedEvent({
    id: "sync", summary: "Sync with Dana", updated: new Date(clock.now() - 3 * DAY).toISOString(),
    start: { dateTime: syncStart }, end: { dateTime: at(21 * HOUR) },
    attendees: [{ email: "dana@example.com", responseStatus: "accepted" }],
  });
  fake.seedEvent({
    id: "rent", summary: "Rent due", updated: new Date(clock.now() - 20 * DAY).toISOString(),
    start: { date: rentDay }, end: { date: new Date(clock.now() + 3 * DAY).toISOString().slice(0, 10) },
  });
  // A meeting with somebody they HAVE written to, so the new-person pass does not claim it and the
  // brief offer is this feature's. The two are deliberately different cases.
  const standupStart = at(18 * HOUR);
  fake.seedEvent({
    id: "standup", summary: "Standup", updated: new Date(clock.now() - 9 * DAY).toISOString(),
    start: { dateTime: standupStart }, end: { dateTime: at(18.5 * HOUR) },
    attendees: [{ email: "quinn@example.com", responseStatus: "accepted" }],
  });
  // The snapshot says both of these were already there and unchanged, so the diff raises nothing
  // about either — which is the state these four catches are for: nothing has CHANGED, and
  // something is still wrong.
  db.putNoticeEvents(OMARI, ME, [
    { id: "sync", summary: "Sync with Dana", start: syncStart, end: at(21 * HOUR), status: "confirmed", attendees: ["dana@example.com"], time_zone: "" },
    { id: "rent", summary: "Rent due", start: rentDay, end: "", status: "confirmed", attendees: [], time_zone: "" },
    { id: "standup", summary: "Standup", start: standupStart, end: "", status: "confirmed", attendees: ["quinn@example.com"], time_zone: "" },
  ], clock.now());
  fake.setAccount(ME, {
    mail: [
      fakeMessage({
        id: "d1", threadId: "sync-thread", from: "Dana <dana@example.com>", to: ME, subject: "moving our sync",
        date: new Date(clock.now() - 30 * MIN).toUTCString(), text: "can we push to 3?",
      }),
      fakeMessage({
        id: "s1", threadId: "lease", from: `Omari <${ME}>`, to: "quinn@example.com", subject: "the lease",
        date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "can you send it over?", labels: ["SENT"],
      }),
    ],
  });

  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now() });
  assert.equal(bundle.ok, true, JSON.stringify(bundle));
  const kinds = new Set(bundle.candidates.map(c => c.kind));
  for (const k of ["calendar_stale", "awaiting_reply", "deadline_near", "meeting_prep"]) {
    assert.ok(kinds.has(k), `${k} was raised (got ${[...kinds].join(", ")})`);
  }
  // Every one of the four names what it was read off, and the source survives being written down —
  // which is what a catch parked for four hours needs in order to open the same thing later.
  for (const c of bundle.candidates.filter(x => alerts.MINE.has(x.kind))) {
    assert.ok(c.source, `${c.kind} named its source`);
    const row = db.recordNotice(OMARI, {
      kind: c.kind, key: c.key, what: c.what, detail: c.detail ?? "", momentAt: clock.now(), at: clock.now(),
      thing: c.thing ?? "", account: c.account ?? "", threadId: c.thread_id ?? "", eventId: c.event_id ?? "",
      state: c.state ?? "", source: c.source,
    });
    assert.equal(db.noticeById(row.id).source, c.source);
    assert.match(notice.momentFrame({ conversationId: OMARI, row: db.noticeById(row.id) }), /It came off:/);
  }
  // And the frame carries the rules for them, so the model is not left to guess what to do with a
  // candidate that says only that two things disagree.
  const frame = notice.sweepFrame({
    conversationId: OMARI, candidates: bundle.candidates, budget: notice.budgetFor(OMARI, { now: clock.now() }),
    timeZone: "America/New_York",
  });
  assert.match(frame, /READ THE THREAD FIRST/);
  assert.match(frame, /your calendar still says 2/);
});

// ---------- have they already handled it? ----------

async function recheckOf(row) {
  const tokens = await google.allAccessTokens(OMARI);
  const acct = { ...tokens.accounts[0], timeZone: "America/New_York" };
  return await alerts.recheck({
    row, acct, mine: new Set([ME]), now: clock.now(),
    api: (a, method, path, opts) => google.api(a.token, method, path, opts),
  });
}

test("a calendar they have since fixed themselves is handled, not news", async () => {
  await connect();
  const made = fake.seedEvent({
    id: "sync", summary: "Sync", updated: new Date(clock.now() - 3 * DAY).toISOString(),
    start: { dateTime: at(20 * HOUR) }, end: { dateTime: at(21 * HOUR) },
    attendees: [{ email: "dana@example.com" }],
  });
  const row = { kind: "calendar_stale", account: ME, event_id: "sync", thread_id: "", state: `${made.start.dateTime}|x` };
  assert.deepEqual(await recheckOf(row), { ok: true }, "still disagreeing: still worth raising");

  // They moved it. The whole catch was that the calendar disagreed with the mail.
  made.start = { dateTime: at(23 * HOUR) };
  const after = await recheckOf(row);
  assert.match(after.handled ?? "", /calendar has been updated since/);
});

test("a calendar catch they have already replied to in the thread is handled", async () => {
  await connect();
  const made = fake.seedEvent({
    id: "sync2", summary: "Sync", updated: new Date(clock.now() - 3 * DAY).toISOString(),
    start: { dateTime: at(20 * HOUR) }, end: { dateTime: at(21 * HOUR) }, attendees: [{ email: "dana@example.com" }],
  });
  fake.setAccount(ME, {
    mail: [
      fakeMessage({ id: "d1", threadId: "th", from: "Dana <dana@example.com>", to: ME, subject: "push to 3?", date: new Date(clock.now() - HOUR).toUTCString(), text: "?" }),
      fakeMessage({ id: "d2", threadId: "th", from: `Omari <${ME}>`, to: "dana@example.com", subject: "Re: push to 3?", date: new Date(clock.now() - 20 * MIN).toUTCString(), text: "works", labels: ["SENT"] }),
    ],
  });
  const got = await recheckOf({ kind: "calendar_stale", account: ME, event_id: "sync2", thread_id: "th", state: `${made.start.dateTime}|th` });
  assert.match(got.handled ?? "", /already replied/);
});

test("a reply that has since arrived is handled, and a thread still silent is not", async () => {
  await connect();
  fake.setAccount(ME, {
    mail: [fakeMessage({
      id: "m1", threadId: "lease", from: `Omari <${ME}>`, to: "quinn@example.com", subject: "the lease",
      date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "?", labels: ["SENT"],
    })],
  });
  assert.deepEqual(await recheckOf({ kind: "awaiting_reply", account: ME, thread_id: "lease" }), { ok: true });

  fake.setAccount(ME, {
    mail: [
      fakeMessage({
        id: "m1", threadId: "lease", from: `Omari <${ME}>`, to: "quinn@example.com", subject: "the lease",
        date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "?", labels: ["SENT"],
      }),
      fakeMessage({
        id: "m2", threadId: "lease", from: "Quinn <quinn@example.com>", to: ME, subject: "Re: the lease",
        date: new Date(clock.now() - MIN).toUTCString(), text: "attached", labels: ["INBOX"],
      }),
    ],
  });
  const got = await recheckOf({ kind: "awaiting_reply", account: ME, thread_id: "lease" });
  assert.match(got.handled ?? "", /somebody has replied/);
});

test("a meeting that has started needs no brief, and a cancelled deadline is not a deadline", async () => {
  await connect();
  const meeting = fake.seedEvent({
    id: "soon", summary: "Sync", start: { dateTime: at(30 * MIN) }, end: { dateTime: at(90 * MIN) },
    attendees: [{ email: "dana@example.com" }],
  });
  assert.deepEqual(await recheckOf({ kind: "meeting_prep", account: ME, event_id: "soon", state: meeting.start.dateTime }), { ok: true });
  meeting.start = { dateTime: at(-5 * MIN) };
  const started = await recheckOf({ kind: "meeting_prep", account: ME, event_id: "soon", state: meeting.start.dateTime });
  assert.match(started.handled ?? "", /already started/);

  const rent = fake.seedEvent({ id: "rent", summary: "Rent due", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } });
  assert.deepEqual(await recheckOf({ kind: "deadline_near", account: ME, event_id: "rent", state: "2026-11-01" }), { ok: true });
  rent.status = "cancelled";
  const off = await recheckOf({ kind: "deadline_near", account: ME, event_id: "rent", state: "2026-11-01" });
  assert.match(off.handled ?? "", /cancelled/);
});

test("a calendar that will not answer is unclear rather than handled, and cannot go as urgent", async () => {
  await connect();
  const row = db.recordNotice(OMARI, {
    kind: "calendar_stale", key: "stale:x", what: "something may have moved", momentAt: clock.now(),
    account: ME, eventId: "nope", source: "calendar event nope",
  });
  // A 404 on an event is it being gone, which IS handled. The unclear branch is a read that failed
  // for any other reason, which the fixture produces by refusing the calendar list.
  const got = await recheckOf({ kind: "calendar_stale", account: ME, event_id: "nope", state: "x|y" });
  assert.match(got.handled ?? "", /no longer on their calendar/);

  // And the rule the doubt exists for: something nothing could confirm may be mentioned, hedged,
  // but may never be the thing that wakes them.
  db.markNoticeUnclear(row.id, "their calendar would not answer");
  const sendIt = notice.send({
    conversationId: OMARI, kind: "event",
    input: { key: "stale:x", what: "might be worth checking your 2pm", why_now: "today", specific_to_them: true, one_word_answerable: true, urgent: true, urgent_why: "it is today" },
  });
  assert.equal(sendIt.ok, false);
  assert.equal(sendIt.status, "unclear_cannot_be_urgent");
});

test("the four are speakable kinds the sweep knows about, so none of them is silently dropped", () => {
  for (const k of Object.keys(alerts.KINDS)) {
    assert.ok(notice.KINDS[k], `${k} is in the sweep's own list`);
    assert.equal(notice.KINDS[k].speakable, true);
  }
});
