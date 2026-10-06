// How much initiative they asked for, and what it checks before it opens its mouth.
//
// test/notice.test.js proves the watchful sweep itself: the cadence, the budget, the three
// questions, the gate the sweep cannot get past. This file proves the half that is about THEM
// rather than about the mechanism — every one of these is a rule somebody would ask for out loud:
//
//   1. **"Did you not see I already did that?"** A reply they already sent, a bill they already
//      opened, a meeting that moved again — each is checked against the LIVE mailbox or calendar
//      before anything is raised, and a handled thing produces no text and costs no model turn.
//      When the check cannot settle it, the doubt travels with the candidate and code refuses to
//      let it be called urgent.
//   2. **"Only answer when asked."** `off` stops the texting AND the looking. `digest` keeps
//      everything for one batched line at an hour they chose. `timely` is the default.
//   3. **"Snooze for today."** Off until tomorrow, and back on by itself.
//   4. **"Stop"** is honest about what it cannot take back: parked catches are cancelled, and the
//      reminders THEY set are named and left alone, because turning initiative off was never a
//      request to cancel their own alarms.
//   5. **Nobody is assumed.** The first sweep for somebody who has never been asked spends itself
//      on one question — their zone and their hours — and never asks again.
//   6. **One nudge per thing.** Raised once, then it waits for them. What lifts the wait is them
//      saying something, never another sweep.
//   7. **A brief is from authorised material**: their own threads and their own calendar, with the
//      sources named, and public research that bears on the meeting rather than on the person.
//
// Same rig as the sweep tests: the fake Google in test/fixture-google.js and a fake model. Nothing
// here has ever reached Google and no API key is needed. What a fake model cannot settle — whether
// its sense of "worth interrupting somebody for" is any good — is in docs/unverified.md.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle, fakeMessage } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-initiative-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const notice = await import("../src/notice.js");
const google = await import("../src/google.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OMARI = "dm:owner";
const TZ = "America/New_York";
const EVERYTHING = [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES];

let fake;
const call = (name, input, { conversationId = OMARI, kind = "event", ...rest } = {}) =>
  runTool(name, input, { conversationId, kind, messages: [], ...rest });

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
    DELETE FROM plans; DELETE FROM usage; DELETE FROM conversations; DELETE FROM inbound_messages;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  config.noticePerDay = 1;
  config.noticeHardCap = 3;
  config.noticeEveryMs = 2 * HOUR;
  config.noticeQuietStart = 22;
  config.noticeQuietEnd = 8;
  config.noticeWaitingHours = 24;
  config.noticeDigestHour = 18;
  config.noticeSnoozeHours = 24;
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: EVERYTHING });
  fake.setAccount("me@example.com", { mail: [] });
  for (const k of ["tokenCalls", "authHeaders", "sent", "events", "eventWrites", "searches"]) fake.state[k].length = 0;
  fake.state.liveTokens.clear();
});

/** The real handshake. `settled` is the opt-in question treated as already asked and answered. */
async function connect({ conversationId = OMARI, grants = EVERYTHING, settled = true } = {}) {
  fake.set({ grantScopes: grants });
  const link = await call("google_connect", {}, { conversationId });
  assert.equal(link.ok, true, JSON.stringify(link));
  const done = await google.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });
  assert.equal(done.ok, true, JSON.stringify(done));
  if (settled) db.setNoticeWindow(conversationId, { askedAt: clock.now(), answeredAt: clock.now() });
}

function harness(answer) {
  const turns = [];
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind, ...ctx }) => {
      turns.push({ conversationId, text, kind, ctx });
      return await answer({
        conversationId, text, kind, n: turns.length, keys: keysIn(text),
        // The tool ctx of the real turn is forwarded, which is what makes the digest test able to
        // prove that `notice_send` knows this turn IS the batched line.
        call: (name, input) => runTool(name, input, { conversationId, kind, messages: [], ...ctx }),
      });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

const keysIn = (text) => {
  const listed = [...String(text).matchAll(/^- \[([^\]]+)\]/gm)].map(m => m[1]);
  return listed.length ? listed : [...String(text).matchAll(/key "([^"]+)"/g)].map(m => m[1]);
};

const at = (ms) => new Date(clock.now() + ms).toISOString();

function seed({ id, summary, startsIn, attendees = [], status = "confirmed" }) {
  return fake.seedEvent({
    id, summary, status,
    start: { dateTime: at(startsIn) }, end: { dateTime: at(startsIn + HOUR) },
    ...(attendees.length ? { attendees: attendees.map(e => ({ email: e, responseStatus: "accepted" })) } : {}),
  });
}

function move(id, startsIn) {
  const e = fake.state.events.find(x => x.id === id);
  e.start = { dateTime: at(startsIn) };
  e.end = { dateTime: at(startsIn + HOUR) };
  return e;
}

/** Put mail on the fake mailbox, replacing whatever was there. */
const mail = (...msgs) => fake.setAccount("me@example.com", { mail: msgs.map(m => fakeMessage(m)) });

function skipToLocalHour(hour) {
  for (let i = 0; i < 48; i++) {
    if (notice.localHour(clock.now(), TZ) === hour) return;
    clock.skip(HOUR);
  }
  throw new Error(`never reached ${hour}:00 local`);
}

/** Claim and settle one, the way a turn that really sent its line does. */
function told(key, { free = false } = {}) {
  const row = db.getNotice(OMARI, key);
  assert.ok(db.claimNotice(row.id, { what: row.what }), `claimed ${key}`);
  return db.markNoticeSaid(OMARI, { day: notice.localDay(clock.now(), TZ), free });
}

/** A text from them, which is what lifts the one-nudge wait. */
const theySaid = (text = "ok") => db.claimInbound({
  channel: "test", externalId: `in-${Math.random()}`, conversationId: OMARI, text,
});

const GOOD = { what: "your 2pm with dana moved to 3", why_now: "it is today", specific_to_them: true, one_word_answerable: true };

// ---------- 1. did they already handle it? ----------

test("a reply they already sent is not news: no text, no turn, and the row says why", async () => {
  await connect();
  // Somebody wrote two days ago, and they have since answered in the same thread. The sweep is
  // what finds the first half; the recheck is what finds the second.
  mail(
    { id: "m1", threadId: "t1", from: "Dana <dana@example.com>", to: "me@example.com", subject: "the deck", date: new Date(clock.now() - 2 * DAY).toUTCString(), text: "thoughts?" },
    { id: "m2", threadId: "t1", from: "me@example.com", to: "dana@example.com", subject: "Re: the deck", date: new Date(clock.now() - 1 * HOUR).toUTCString(), text: "sent it over", labels: ["SENT"] },
  );
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  const waiting = bundle.candidates.find(c => c.kind === "mail_waiting");
  assert.ok(waiting, "the gather half still finds it: the unread mail is genuinely two days old");

  const row = db.recordNotice(OMARI, {
    kind: waiting.kind, key: waiting.key, what: waiting.what, thing: waiting.thing,
    account: waiting.account, threadId: waiting.thread_id, state: waiting.state ?? "",
  });
  const verdict = await notice.recheck({ conversationId: OMARI, row: db.noticeById(row.id) });
  assert.match(verdict.handled ?? "", /already replied/);

  const sifted = await notice.siftHandled({ conversationId: OMARI, candidates: [{ ...waiting, id: row.id }] });
  assert.equal(sifted.keep.length, 0, "nothing goes in front of the model");
  assert.equal(sifted.handled.length, 1);
  const after = db.noticeById(row.id);
  assert.ok(after.resolved_at, "resolved: a fourth outcome next to said, held and claimed");
  assert.equal(after.said_at, null);
  assert.equal(db.heldNotices(OMARI).length, 0, "and it is not held either — there is nothing left to say");
});

test("a bill they have opened is not sitting unread, so nothing is said about it", async () => {
  await connect();
  mail({
    id: "m1", threadId: "t1", from: "ConEd <bills@example.com>", to: "me@example.com",
    subject: "Your invoice is due Friday", date: new Date(clock.now() - 2 * HOUR).toUTCString(), text: "$84",
  });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  const due = bundle.candidates.find(c => c.kind === "mail_due");
  assert.ok(due, "unread, with a date word in the subject");
  const row = db.recordNotice(OMARI, {
    kind: due.kind, key: due.key, what: due.what, thing: due.thing, account: due.account, threadId: due.thread_id,
  });
  assert.equal((await notice.recheck({ conversationId: OMARI, row: db.noticeById(row.id) })).ok, true, "still unread: still worth raising");

  // They open it. Whether it is PAID is not something a mailbox can say and nothing here claims it
  // is — what is claimed is that they have seen it, which is enough to make telling them noise.
  const m = fake.state.mail?.find?.(x => x.id === "m1") ?? null;
  fake.setAccount("me@example.com", {
    mail: [fakeMessage({
      id: "m1", threadId: "t1", from: "ConEd <bills@example.com>", to: "me@example.com",
      subject: "Your invoice is due Friday", date: new Date(clock.now() - 2 * HOUR).toUTCString(), text: "$84",
      labels: ["INBOX"],
    })],
  });
  assert.equal(m, null, "(the fixture keeps mail per account, not on state)");
  const verdict = await notice.recheck({ conversationId: OMARI, row: db.noticeById(row.id) });
  assert.match(verdict.handled ?? "", /opened it since/);
});

test("a meeting that moved again is finished with, so the wrong time is never said", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 6 * HOUR });
  const { rt, turns, sent } = harness(async () => null);
  await rt.notice();                                    // the first look writes the calendar down
  move("e1", 8 * HOUR);
  clock.skip(config.noticeEveryMs + MIN);
  await rt.notice();                                    // found: it moved to +8h, and nothing was said
  const row = db.heldNotices(OMARI).find(r => r.kind === "calendar_moved");
  assert.ok(row, "held, because the fake model said nothing");
  // The state it was raised in, kept as a value rather than as something to parse out of the key.
  assert.equal(row.state, fake.state.events.find(e => e.id === "e1").start.dateTime);
  assert.equal(row.event_id, "e1");
  assert.equal(row.thing, "cal:me@example.com:e1");

  // It moves a third time. The sentence this row would say is now wrong, so it is resolved rather
  // than spoken, and the next sweep raises the new time under its own key.
  move("e1", 10 * HOUR);
  const verdict = await notice.recheck({ conversationId: OMARI, row });
  assert.match(verdict.handled ?? "", /moved again/);
  assert.match(verdict.handled, /it now says/, "and it says what the calendar says now");

  // So the next sweep raises the NEW time under its own key, and the stale row is resolved rather
  // than spoken: the one thing that must never happen is "+8h" going out when it is now "+10h".
  clock.skip(config.noticeEveryMs + MIN);
  await rt.notice();
  assert.ok(db.noticeById(row.id).resolved_at, "the stale one is finished with, not held");
  assert.equal(sent.length, 0, "and the wrong time was never said");
  const fresh = db.heldNotices(OMARI).filter(r => r.kind === "calendar_moved");
  assert.equal(fresh.length, 1, "one live candidate, carrying the time the calendar actually says");
  assert.equal(fresh[0].state, fake.state.events.find(e => e.id === "e1").start.dateTime);
});

test("a cancelled meeting that comes back is not a cancellation any more", async () => {
  await connect();
  seed({ id: "e1", summary: "Dana", startsIn: 6 * HOUR });
  const row = db.recordNotice(OMARI, {
    kind: "calendar_cancelled", key: "me@example.com:e1@cancelled", what: "Dana was cancelled",
    thing: "cal:me@example.com:e1", account: "me@example.com", eventId: "e1",
  });
  const verdict = await notice.recheck({ conversationId: OMARI, row: db.noticeById(row.id) });
  assert.match(verdict.handled ?? "", /back on their calendar/);
});

test("when the check cannot settle it the doubt travels, and urgent is refused", async () => {
  await connect();
  const row = db.recordNotice(OMARI, {
    kind: "calendar_moved", key: "me@example.com:ghost@x", what: "something moved",
    thing: "cal:me@example.com:ghost", account: "me@example.com", eventId: "ghost", state: "whenever",
  });
  // A read that FAILS is not evidence of anything. A 404 is an answer (it is gone); a 500 is not.
  const verdict = await notice.recheck({
    conversationId: OMARI, row: db.noticeById(row.id),
    read: async () => ({ ok: false, status: 503, error: "backendError" }),
  });
  assert.ok(verdict.unclear, "not handled, and not confirmed either");
  assert.match(verdict.unclear, /would not answer/);

  const sifted = await notice.siftHandled({
    conversationId: OMARI, candidates: [{ id: row.id, kind: row.kind, key: row.key, what: row.what }],
    read: async () => ({ ok: false, status: 503, error: "backendError" }),
  });
  assert.equal(sifted.keep.length, 1, "it still goes up — it may well be true");
  assert.ok(db.noticeById(row.id).unclear, "with the doubt written on it");

  // The frame says so in words, so a model reading it knows to hedge.
  const frame = notice.sweepFrame({
    conversationId: OMARI, candidates: sifted.keep, budget: notice.budgetFor(OMARI, { timeZone: TZ }), timeZone: TZ,
  });
  assert.match(frame, /NOT CONFIRMED/);
  assert.match(frame, /never state a time or an amount as fact/);

  // And the gate refuses to let it be the thing that wakes them.
  const urgent = await call("notice_send", { ...GOOD, key: row.key, urgent: true, urgent_why: "it is in an hour" });
  assert.equal(urgent.ok, false);
  assert.equal(urgent.status, "unclear_cannot_be_urgent");
  assert.match(urgent.error, /cannot go as urgent/);
  // Hedged, inside the ordinary budget, is still allowed.
  const ordinary = await call("notice_send", { ...GOOD, key: row.key, what: "think your dana thing moved, might be worth checking" });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
});

test("a handled thing can never be sent, even if the model asks for it by key", async () => {
  await connect();
  const row = db.recordNotice(OMARI, { kind: "mail_due", key: "due:x", what: "a bill" });
  db.resolveNotice(row.id, "they have opened it since");
  const out = await call("notice_send", { ...GOOD, key: "due:x" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "already_handled");
  assert.match(out.error, /opened it since/);
  assert.match(out.error, /NO_REPLY/);
});

// ---------- 2. the three modes ----------

test("'only answer when asked' stops the texting AND the looking", async () => {
  await connect();
  const set = await call("notice_mode", { mode: "off", said: "only answer when asked" });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.mode, "off");
  assert.equal(set.their_words, "only answer when asked");
  assert.match(set.sweep, /cancelled/);
  assert.match(set.note, /not permission/, "initiative is not permission to act");

  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  const { rt, turns, sent } = harness(async () => "something");
  const out = await rt.notice();
  assert.equal(out.looked, 0, "nothing was read: reading their mail to say nothing is not what they agreed to");
  assert.equal(turns.length, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(out.skipped, [{ conversation: OMARI, why: "initiative_off" }]);
  assert.equal(notice.settingsFor(OMARI).mode, "off");
});

test("off survives a restart, because it is on the account and not in memory", async () => {
  await connect();
  await call("notice_mode", { mode: "off", said: "stop texting me unless i ask" });
  assert.equal(db.noticePrefs(OMARI).mode, "off");
  assert.equal(notice.settingsFor(OMARI).mode, "off");
  // And back on, in their words, which also clears any snooze.
  const back = await call("notice_mode", { mode: "timely", said: "ok you can tell me stuff again" });
  assert.equal(back.ok, true);
  assert.equal(back.mode, "timely");
  assert.equal(back.was, "off");
  assert.equal(db.noticePrefs(OMARI).snoozeUntil, null);
});

test("a mode set from nothing they said is refused", async () => {
  await connect();
  for (const said of [undefined, "", "   "]) {
    const out = await notice.setMode({ conversationId: OMARI, mode: "off", said });
    assert.equal(out.ok, false, `said=${JSON.stringify(said)}`);
    assert.match(out.error, /word for word/);
  }
  assert.equal(notice.settingsFor(OMARI).mode, "timely", "and nothing was changed");
  const nonsense = await notice.setMode({ conversationId: OMARI, mode: "whenever", said: "do what you like" });
  assert.equal(nonsense.ok, false);
});

test("'once in the evening': everything is held, and one batched line goes at their hour", async () => {
  await connect();
  const set = await call("notice_mode", { mode: "digest", said: "just text me once in the evening", digest_hour: 18 });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.mode, "digest");
  assert.equal(notice.settingsFor(OMARI).digestHour, 18);

  seed({ id: "e1", summary: "Dana", startsIn: 30 * HOUR });
  const { rt, turns, sent } = harness(async ({ text, keys, call: t }) => {
    if (!/their digest/.test(text)) return "this should never be sent";
    const out = await t("notice_send", { ...GOOD, key: keys[0], what: "dana moved, and that invoice is due friday" });
    return out.ok ? "dana moved, and that invoice is due friday" : null;
  });

  // Morning: the sweep finds it and says nothing at all, because they asked for a batch.
  await rt.notice();
  move("e1", 32 * HOUR);
  clock.skip(config.noticeEveryMs + MIN);
  const swept = await rt.notice();
  assert.equal(swept.turns, 0, "a digest sweep costs no model turn");
  assert.equal(sent.length, 0);
  assert.ok(swept.skipped.some(s => s.why === "held_for_digest"));
  assert.ok(db.heldNotices(OMARI).length >= 1, "written down, waiting for the batch");

  // Before their hour: still nothing.
  const early = await rt.digest();
  assert.ok(early.skipped.some(s => s.why === "not their hour yet"), JSON.stringify(early));
  assert.equal(sent.length, 0);

  // At their hour: exactly one message.
  skipToLocalHour(18);
  const out = await rt.digest();
  assert.equal(out.turns, 1);
  assert.equal(out.sent, 1, JSON.stringify(out));
  assert.equal(sent.length, 1, "one message, not one per thing");
  assert.match(turns.at(-1).text, /their digest/);
  assert.match(turns.at(-1).text, /ONE message/);
  assert.match(turns.at(-1).text, /Silence is better than noise\./);

  // And not twice in a day, however many times the pass runs.
  const again = await rt.digest();
  assert.ok(again.skipped.some(s => s.why === "already today"), JSON.stringify(again));
  assert.equal(sent.length, 1);
});

test("on digest, a catch that is not the digest is held rather than sent", async () => {
  await connect();
  await call("notice_mode", { mode: "digest", said: "one message a day please" });
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "dana moved", momentAt: clock.now() });
  // An ordinary event turn: held for the batch.
  const held = await call("notice_send", { ...GOOD, key: "k1" });
  assert.equal(held.ok, false);
  assert.equal(held.status, "held_for_digest");
  assert.equal(held.digest_hour, 18);
  // The digest turn itself: allowed, because ctx says this turn IS the batched line.
  const sent = await call("notice_send", { ...GOOD, key: "k1" }, { noticeTurn: "digest" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
});

test("timely is the default: nobody has to ask for it", async () => {
  await connect();
  assert.equal(db.noticePrefs(OMARI).mode, null, "nothing stored");
  const s = notice.settingsFor(OMARI);
  assert.equal(s.mode, "timely");
  assert.equal(notice.MODES[s.mode].unprompted, true);
  assert.equal(s.ownSetting, false, "and status must not claim they chose it");
});

// ---------- 3. snooze ----------

test("'not today' is off until tomorrow and comes back on by itself", async () => {
  await connect();
  const snoozed = await call("notice_mode", { mode: "snooze", said: "not today man" });
  assert.equal(snoozed.ok, true, JSON.stringify(snoozed));
  assert.ok(snoozed.snoozed_until);
  assert.match(snoozed.note, /comes back on by itself/);

  const s = notice.settingsFor(OMARI);
  assert.equal(s.mode, "off", "a snooze reads as off while it lasts");
  assert.equal(s.setMode, "timely", "without overwriting what they actually chose");
  assert.equal(s.snoozed, true);

  db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "dana moved", momentAt: clock.now() });
  const out = await call("notice_send", { ...GOOD, key: "k1" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "snoozed");
  assert.ok(db.heldNotices(OMARI).length, "held, not lost");

  // Tomorrow, with nobody turning anything back on.
  clock.skip(config.noticeSnoozeHours * HOUR + MIN);
  const after = notice.settingsFor(OMARI);
  assert.equal(after.mode, "timely");
  assert.equal(after.snoozed, false);
});

test("a snooze does not reach a catch parked for a later day", async () => {
  await connect();
  const near = db.recordNotice(OMARI, { kind: "calendar_moved", key: "near", what: "today's thing", momentAt: clock.now() + 2 * HOUR });
  const far = db.recordNotice(OMARI, { kind: "calendar_moved", key: "far", what: "thursday's thing", momentAt: clock.now() + 4 * DAY });
  const t1 = db.createTimer(OMARI, { fireAt: clock.now() + 2 * HOUR, note: "say the near thing" });
  const t2 = db.createTimer(OMARI, { fireAt: clock.now() + 4 * DAY, note: "say the far thing" });
  db.scheduleNotice(near.id, t1.id, clock.now() + 2 * HOUR);
  db.scheduleNotice(far.id, t2.id, clock.now() + 4 * DAY);

  await call("notice_mode", { mode: "snooze", said: "snooze for today" });
  assert.equal(db.noticeById(near.id).timer_id, null, "the one inside the snooze is taken back");
  assert.equal(db.noticeById(far.id).timer_id, t2.id, "thursday's is not: 'not today' is not 'cancel everything'");
});

// ---------- 4. stop is honest about what it cannot take back ----------

test("stop cancels the parked catches and names what stays because they asked for it", async () => {
  await connect();
  // One of Reason's own catches, parked on a timer. And one reminder THEY set.
  const parked = db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "dana moved to 3", momentAt: clock.now() + 3 * HOUR });
  const ours = db.createTimer(OMARI, { fireAt: clock.now() + 3 * HOUR, note: "say the thing you noticed: dana moved to 3" });
  db.scheduleNotice(parked.id, ours.id, clock.now() + 3 * HOUR);
  const theirs = db.createTimer(OMARI, { fireAt: clock.now() + 5 * HOUR, note: "call mum" });
  db.createTask(OMARI, { title: "chase the handyman", goal: "get a time", wakeAt: clock.now() + DAY, maxAttempts: 3 });

  const out = await call("notice_mode", { mode: "off", said: "stop" });
  assert.equal(out.ok, true, JSON.stringify(out));

  // Ours is cancelled, really, in the timers table.
  assert.ok(db.getTimer(OMARI, ours.id).cancelled_at, "the parked catch is taken back");
  assert.equal(db.noticeById(parked.id).timer_id, null);
  assert.deepEqual(out.took_back, ["dana moved to 3"]);

  // Theirs is not, and is named, because turning initiative off is not cancelling their alarms.
  assert.equal(db.getTimer(OMARI, theirs.id).cancelled_at, null);
  const still = out.still_coming.map(x => x.what).join(" | ");
  assert.match(still, /call mum/);
  assert.match(still, /chase the handyman/);
  assert.match(out.say, /BECAUSE THEY ASKED FOR IT/);
  assert.match(out.say, /not "cancel my reminders"/);
});

test("stop with nothing scheduled says there is nothing left to come", async () => {
  await connect();
  const out = await call("notice_mode", { mode: "off", said: "stop texting me" });
  assert.deepEqual(out.took_back, []);
  assert.deepEqual(out.still_coming, []);
  assert.deepEqual(out.already_went_out, []);
  assert.match(out.say, /nothing left to come/);
  assert.match(out.say, /Nothing unprompted has gone out today/);
});

test("stop names what already went out today, because that cannot be unsent", async () => {
  await connect();
  const day = notice.localDay(clock.now(), TZ);
  // One text that really landed this morning, their time.
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "sent1", what: "dana moved to 3", momentAt: clock.now() });
  assert.equal(notice.send({ conversationId: OMARI, input: { ...GOOD, key: "sent1", what: "dana moved to 3" } }).ok, true);
  db.markNoticeSaid(OMARI, { day });
  // And one still parked for later, which CAN be taken back.
  const parked = db.recordNotice(OMARI, { kind: "mail_due", key: "later1", what: "the con ed bill is due friday", momentAt: clock.now() + 4 * HOUR });
  const timer = db.createTimer(OMARI, { fireAt: clock.now() + 4 * HOUR, note: "say the thing you noticed" });
  db.scheduleNotice(parked.id, timer.id, clock.now() + 4 * HOUR);

  const out = await call("notice_mode", { mode: "off", said: "stop texting me" });
  assert.equal(out.ok, true, JSON.stringify(out));
  // The one that has not gone is taken back; the one that has is named rather than pretended about.
  assert.deepEqual(out.took_back, ["the con ed bill is due friday"]);
  assert.deepEqual(out.already_went_out.map(x => x.what), ["dana moved to 3"]);
  assert.match(out.say, /cannot be unsent/);
  assert.match(out.say, /dana moved to 3/);
});

test("a snooze is honest the same way: what it took back, and what had already landed", async () => {
  await connect();
  const day = notice.localDay(clock.now(), TZ);
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "s1", what: "your 2pm moved to 4", momentAt: clock.now() });
  assert.equal(notice.send({ conversationId: OMARI, input: { ...GOOD, key: "s1", what: "your 2pm moved to 4" } }).ok, true);
  db.markNoticeSaid(OMARI, { day });

  const out = await call("notice_mode", { mode: "snooze", said: "not today" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.already_went_out.map(x => x.what), ["your 2pm moved to 4"]);
  assert.match(out.say, /cannot be unsent/);
});

test("yesterday's text is not today's: what already went out is counted in their own day", async () => {
  await connect();
  const day = notice.localDay(clock.now(), TZ);
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "y1", what: "yesterday's news", momentAt: clock.now() });
  assert.equal(notice.send({ conversationId: OMARI, input: { ...GOOD, key: "y1", what: "yesterday's news" } }).ok, true);
  db.markNoticeSaid(OMARI, { day });

  clock.skip(DAY);
  const out = await call("notice_mode", { mode: "off", said: "stop" });
  assert.deepEqual(out.already_went_out, [], "a text from yesterday is not something that went out today");
  assert.match(out.say, /Nothing unprompted has gone out today/);
});

test("asking for ten a day does not move the ceiling, and the tool says the real number", async () => {
  await connect();
  const day = notice.localDay(clock.now(), TZ);
  const more = await call("notice_settings", { per_day: 10 });
  assert.equal(more.ok, true);
  assert.equal(more.per_day, 10, "their own setting is theirs");
  assert.equal(more.hard_cap, 3);
  assert.equal(more.really_at_most, 3, "and the honest number comes back with it");
  assert.match(more.note, /real number is 3/);

  // Three go out on the ordinary allowance, because they asked for ten. The fourth does not, and
  // calling it urgent does not help: the ceiling is code's and nobody's to argue with.
  const spend = (key, extra = {}) => {
    db.recordNotice(OMARI, { kind: "calendar_moved", key, what: `thing ${key}`, momentAt: clock.now() });
    const v = notice.send({ conversationId: OMARI, input: { ...GOOD, key, ...extra } });
    if (v.ok) db.markNoticeSaid(OMARI, { day });
    return v;
  };
  for (const k of ["m1", "m2", "m3"]) assert.equal(spend(k).ok, true, `${k} should have gone out`);
  assert.equal(db.noticeBudget(OMARI, day).sent, 3);

  assert.equal(spend("m4").status, "hard_cap");
  const urgent = spend("m5", { urgent: true, urgent_why: "their flight leaves in an hour" });
  assert.equal(urgent.ok, false, "a fourth does not get through by being called urgent");
  assert.equal(urgent.status, "hard_cap");
  assert.match(urgent.error, /ceiling/);
});

test("'less often' lowers the number, and code holds the lower one from the next text on", async () => {
  await connect();
  const day = notice.localDay(clock.now(), TZ);
  const spend = (key, extra = {}) => {
    db.recordNotice(OMARI, { kind: "calendar_moved", key, what: `thing ${key}`, momentAt: clock.now() });
    const v = notice.send({ conversationId: OMARI, input: { ...GOOD, key, ...extra } });
    if (v.ok) db.markNoticeSaid(OMARI, { day });
    return v;
  };

  // They had asked for three a day, and two of those have gone.
  assert.equal((await call("notice_settings", { per_day: 3 })).per_day, 3);
  for (const k of ["l1", "l2"]) assert.equal(spend(k).ok, true, `${k} should have gone out`);
  assert.equal(db.noticeBudget(OMARI, day).sent, 2);

  // Then: "text me less". The model reads that and lowers the number. Nothing else moves — fewer a
  // day is not a mode, so initiative is still on and they have not been switched off by accident.
  const less = await call("notice_settings", { per_day: 1 });
  assert.equal(less.ok, true, JSON.stringify(less));
  assert.equal(less.per_day, 1);
  assert.equal(less.really_at_most, undefined, "one a day is under the ceiling, so there is nothing to correct");
  assert.equal(db.noticePrefs(OMARI).perDay, 1, "on their account, so it survives a restart");
  assert.equal(db.noticePrefs(OMARI).mode, null);
  assert.equal(notice.settingsFor(OMARI).mode, "timely");

  // This is the half worth a test: the lower number binds the texts that have ALREADY happened.
  // Two went out and they now want one, so today is over — and it is code that says so, not the
  // model remembering a number it was told.
  const b = notice.budgetFor(OMARI, { timeZone: TZ });
  assert.equal(b.per_day, 1);
  assert.equal(b.left, 0);
  assert.equal(b.spent, true);
  const no = spend("l3");
  assert.equal(no.ok, false, "the next unprompted text is refused, however good it is");
  assert.equal(no.status, "budget_spent");
  assert.match(no.error, /\(2 of 1\)/, "and it says the real numbers rather than scolding");
  assert.ok(db.getNotice(OMARI, "l3").held_at, "still noticed, just never sent on its own");

  // Asking for fewer is not asking for a lower ceiling, so what is genuinely urgent still has its
  // room — and the ceiling is still the ceiling under it.
  assert.equal(spend("l4", { urgent: true, urgent_why: "their flight leaves in an hour" }).ok, true);
  assert.equal(db.noticeBudget(OMARI, day).sent, 3);
  assert.equal(spend("l5", { urgent: true, urgent_why: "the other flight too" }).status, "hard_cap");
});

test("stop is a stop: not even urgent gets through it", async () => {
  await connect();
  await call("notice_mode", { mode: "off", said: "stop" });
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "your flight is in 2h", momentAt: clock.now() });
  const out = await call("notice_send", { ...GOOD, key: "k1", urgent: true, urgent_why: "their flight is in two hours" });
  assert.equal(out.ok, false, "a stop an emergency can override is not a stop");
  assert.equal(out.status, "initiative_off");
});

test("what they asked for still folds into a reply they started", async () => {
  await connect();
  await call("notice_mode", { mode: "off", said: "only when i ask" });
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "dana moved to 3", momentAt: clock.now() });
  // kind "user" is a turn THEY started: it rides along on a reply they are already reading, which
  // interrupts nobody, so "nothing unprompted" is not violated by it.
  const out = await call("notice_send", { ...GOOD, key: "k1" }, { kind: "user" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.free, true);
  assert.match(out.note, /rides along/);
});

// ---------- 5. nobody is assumed ----------

test("the first sweep asks one question — their zone and their hours — and never asks again", async () => {
  await connect({ settled: false });
  seed({ id: "e1", summary: "Dana", startsIn: 4 * HOUR });
  const { rt, turns, sent } = harness(async ({ text, keys, call: t }) => {
    if (!/the one question/.test(text)) return null;
    const out = await t("notice_send", { ...GOOD, key: keys[0], one_word_answerable: false, what: "gonna start watching ur mail. got u as America/New_York, 9-9 — right?" });
    return out.ok ? "gonna start watching ur mail. got u as America/New_York, 9-9 — right?" : null;
  });

  const first = await rt.notice();
  assert.equal(first.asked, 1);
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /the one question before you start watching/);
  assert.match(turns[0].text, /America\/New_York/, "it says the guess out loud rather than hiding it");
  assert.match(turns[0].text, /read off their calendar, not something they told you/);
  assert.equal(sent.length, 1, "and it is a real text, through the same gate as anything else");

  // Asked once. A second sweep is an ordinary sweep, question or no question.
  clock.skip(config.noticeEveryMs + MIN);
  const second = await rt.notice();
  assert.equal(second.asked, 0, "never twice");
  assert.ok(db.noticePrefs(OMARI).windowAskedAt, "stamped on the account, so a restart cannot re-ask");
});

test("the opt-in question is the one thing allowed to need more than a one-word answer", async () => {
  await connect({ settled: false });
  db.recordNotice(OMARI, { kind: "opt_in", key: notice.OPT_IN_KEY, what: "nobody has asked them", momentAt: clock.now() });
  const out = await call("notice_send", { ...GOOD, key: notice.OPT_IN_KEY, one_word_answerable: false });
  assert.equal(out.ok, true, JSON.stringify(out));
  // Every other kind still has to clear that bar.
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "dana moved", momentAt: clock.now() });
  const refused = await call("notice_send", { ...GOOD, key: "k1", one_word_answerable: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "failed_the_test");
});

test("until they answer, the default runs — and their answer is what runs after", async () => {
  await connect({ settled: false });
  const before = notice.settingsFor(OMARI);
  assert.equal(before.quietStart, 22);
  assert.equal(before.quietEnd, 8);
  assert.equal(before.toldUsTheirZone, false, "a guess, and status has to say so");
  assert.equal(notice.status({ conversationId: OMARI, connected: true }).hours_are, "a default nobody has confirmed with them yet");

  const saved = await call("notice_window", { time_zone: "Europe/London", awake_from: 9, awake_until: 21, said: "i'm in london, and not before 9" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.time_zone, "Europe/London");
  assert.equal(saved.awake, "9:00-21:00");

  const after = notice.settingsFor(OMARI);
  assert.equal(after.timeZone, "Europe/London");
  assert.equal(after.quietEnd, 9);
  assert.equal(after.quietStart, 21);
  assert.equal(after.toldUsTheirZone, true);
  assert.equal(notice.status({ conversationId: OMARI, connected: true }).hours_are, "what they told you");
});

test("their stated hours are what quiet hours mean, not the install's", async () => {
  await connect();
  // 08:00 their own clock. The install says that is awake; they said they are not.
  await call("notice_window", { time_zone: TZ, awake_from: 10, awake_until: 20, said: "not before 10, not after 8" });
  skipToLocalHour(8);
  db.recordNotice(OMARI, { kind: "calendar_moved", key: "k1", what: "dana moved to 3", momentAt: clock.now() });
  const out = await call("notice_send", { ...GOOD, key: "k1" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "quiet_hours");
  assert.match(out.error, /10:00-20:00/);
  assert.match(out.error, /their own/);

  skipToLocalHour(11);
  assert.equal((await call("notice_send", { ...GOOD, key: "k1" })).ok, true, "inside their hours it goes");
});

test("a zone this machine has never heard of is refused rather than stored", async () => {
  await connect();
  const bad = await call("notice_window", { time_zone: "Mars/Olympus", said: "i'm on mars" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a zone this machine knows/);
  assert.equal(db.noticePrefs(OMARI).tz, "", "and nothing was written");
  for (const input of [{ awake_from: 25 }, { awake_from: 9, awake_until: 9 }]) {
    const out = await call("notice_window", { ...input, said: "whatever" });
    assert.equal(out.ok, false, JSON.stringify(input));
  }
  // `said` is required by the schema as well as by the code, so there are two refusals behind it.
  assert.equal((await call("notice_window", { time_zone: TZ })).ok, false, "said is required");
});

// ---------- 6. one nudge per thing ----------

test("one nudge per thing: another day waiting is not another licence to text", async () => {
  await connect();
  // The same thread, raised on two different days. The key carries the state, so these are two
  // candidates — which is right. The THING is the same, which is what decides whether it may go.
  const day1 = db.recordNotice(OMARI, {
    kind: "mail_waiting", key: "mail:me@example.com:t1@1d", thing: "mail:me@example.com:t1",
    what: "Dana has been waiting a day", momentAt: clock.now(),
  });
  assert.ok(day1.fresh);
  told("mail:me@example.com:t1@1d");

  clock.skip(DAY);
  db.recordNotice(OMARI, {
    kind: "mail_waiting", key: "mail:me@example.com:t1@2d", thing: "mail:me@example.com:t1",
    what: "Dana has been waiting two days", momentAt: clock.now(),
  });
  const out = await call("notice_send", { ...GOOD, key: "mail:me@example.com:t1@2d" });
  assert.equal(out.ok, false, "chasing it again is nagging");
  assert.equal(out.status, "already_nudged");
  assert.match(out.error, /One nudge per thing/);
  assert.ok(db.heldNotices(OMARI).some(r => r.key === "mail:me@example.com:t1@2d"), "held, so it can ride along later");

  // What lifts it is THEM saying something — never another sweep, and never a day passing.
  theySaid("ugh ok i'll reply to her");
  const now = await call("notice_send", { ...GOOD, key: "mail:me@example.com:t1@2d" });
  assert.equal(now.ok, true, JSON.stringify(now));
});

test("a different thing is not the same thing, so the first nudge never blocks the second", async () => {
  await connect();
  db.recordNotice(OMARI, { kind: "mail_waiting", key: "mail:a@1d", thing: "mail:a", what: "A is waiting", momentAt: clock.now() });
  told("mail:a@1d");
  config.noticePerDay = 2;
  db.recordNotice(OMARI, { kind: "mail_waiting", key: "mail:b@1d", thing: "mail:b", what: "B is waiting", momentAt: clock.now() });
  const out = await call("notice_send", { ...GOOD, key: "mail:b@1d" });
  assert.equal(out.ok, true, JSON.stringify(out));
});

test("a line riding along on their own reply is not a nudge, so it is never blocked as one", async () => {
  await connect();
  db.recordNotice(OMARI, { kind: "mail_waiting", key: "mail:a@1d", thing: "mail:a", what: "A is waiting", momentAt: clock.now() });
  told("mail:a@1d");
  db.recordNotice(OMARI, { kind: "mail_waiting", key: "mail:a@2d", thing: "mail:a", what: "A is still waiting", momentAt: clock.now() });
  const out = await call("notice_send", { ...GOOD, key: "mail:a@2d" }, { kind: "user" });
  assert.equal(out.ok, true, "they are already reading a reply; this costs them nothing");
  assert.equal(out.free, true);
});

// ---------- 7. the brief ----------

test("a meeting with somebody they have never emailed is raised as an offer, not a brief", async () => {
  await connect();
  seed({ id: "e1", summary: "intro call", startsIn: 20 * HOUR, attendees: ["me@example.com", "newperson@acme.com"] });
  const bundle = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  const found = bundle.candidates.find(c => c.kind === "meeting_new_person");
  assert.ok(found, `expected a new-person candidate; got ${JSON.stringify(bundle.candidates.map(c => c.kind))}`);
  assert.equal(found.who, "newperson@acme.com");
  assert.match(found.what, /never emailed them/);
  assert.match(found.detail, /offer a brief in one line/);
  assert.equal(notice.KINDS.meeting_new_person.speakable, true);

  // Somebody they DO email is not somebody new.
  mail({ id: "m1", threadId: "t1", from: "me@example.com", to: "newperson@acme.com", subject: "hey", date: new Date(clock.now() - DAY).toUTCString(), text: "see you thursday", labels: ["SENT"] });
  const again = await notice.gather({ conversationId: OMARI, now: clock.now(), since: clock.now() - 7 * DAY });
  assert.equal(again.candidates.filter(c => c.kind === "meeting_new_person").length, 0);
});

test("the brief comes back with its sources named, and the rules for writing from them", async () => {
  await connect();
  seed({ id: "e1", summary: "intro call", startsIn: 20 * HOUR, attendees: ["me@example.com", "dana@acme.com"] });
  mail(
    { id: "m1", threadId: "t1", from: "Dana <dana@acme.com>", to: "me@example.com", subject: "pricing", date: new Date(clock.now() - 3 * DAY).toUTCString(), text: "we settled on the annual plan" },
    { id: "m2", threadId: "t2", from: "me@example.com", to: "dana@acme.com", subject: "re: scope", date: new Date(clock.now() - DAY).toUTCString(), text: "still open: who signs", labels: ["SENT"] },
  );
  const out = await call("meeting_brief", { event_id: "e1" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.person, "dana@acme.com");
  assert.equal(out.meeting.summary, "intro call");
  const threads = out.authorized_sources.map(s => s.thread_id).sort();
  assert.deepEqual(threads, ["t1", "t2"], "both threads with her, with ids to read them by");
  for (const s of out.authorized_sources) assert.ok(s.account, "and which account each came from");

  assert.match(out.write, /who they are/);
  assert.match(out.write, /what is still open/);
  assert.match(out.write, /Every claim carries its source/);
  assert.match(out.only_from_here, /authorised material/);
  assert.match(out.only_from_here, /never act on them/);
  // Public research has to bear on the meeting. A profile of the person is the thing it must not be.
  assert.match(out.public_research, /bear on THIS meeting/);
  assert.match(out.public_research, /Never a profile of the person/);
  assert.match(out.public_research, /health/);
});

test("with nothing connected there is nothing to write a brief from, and it says so", async () => {
  const out = await call("meeting_brief", { person: "dana@acme.com" });
  assert.equal(out.ok, false);
  assert.match(JSON.stringify(out), /Never write one from the open web alone/);
});

test("a brief about a meeting that is not there is refused rather than invented", async () => {
  await connect();
  const out = await call("meeting_brief", { event_id: "nope" });
  assert.equal(out.ok, false);
  assert.match(out.error, /No event nope/);
  const nobody = await call("meeting_brief", {});
  assert.equal(nobody.ok, false);
});

// ---------- health, which is the one place being helpful unasked is dangerous ----------

test("every unprompted frame carries the health rule and the not-permission rule", async () => {
  await connect();
  const budget = notice.budgetFor(OMARI, { timeZone: TZ });
  const frames = {
    sweep: notice.sweepFrame({ conversationId: OMARI, candidates: [], budget, timeZone: TZ }),
    follow_on: notice.followOnFrame({ conversationId: OMARI, thing: "a flight is booked", key: "after:task:1", budget }),
    moment: notice.momentFrame({ conversationId: OMARI, row: { key: "k1", what: "dana moved to 3" } }),
    digest: notice.digestFrame({ conversationId: OMARI, candidates: [], budget, timeZone: TZ, hour: 18 }),
  };
  for (const [name, frame] of Object.entries(frames)) {
    assert.match(frame, /a schedule THEY told you or confirmed/, `${name}: a reminder is only ever theirs`);
    assert.match(frame, /Never book it/, `${name}: an overdue visit may be asked about, never booked`);
    assert.match(frame, /never name a dose or a medicine/, `${name}`);
    assert.match(frame, /not permission to act for them/, `${name}: initiative is not permission`);
    assert.match(frame, /spend their money/, `${name}`);
  }
});

// ---------- what it says about itself ----------

test("notice_status tells the truth about the mode, the hours and what was already handled", async () => {
  await connect();
  const row = db.recordNotice(OMARI, { kind: "mail_due", key: "due:t1", what: "a bill from ConEd" });
  db.resolveNotice(row.id, "they have opened it since");

  const st = await call("notice_status", {});
  assert.equal(st.initiative, "timely");
  assert.equal(st.initiative_means, "at the moment it matters");
  assert.equal(st.noticed_already_handled.length, 1);
  assert.match(st.noticed_already_handled[0].how, /opened it since/);
  assert.match(st.note, /they had already handled it/);

  await call("notice_mode", { mode: "off", said: "only answer when asked" });
  const off = await call("notice_status", {});
  assert.equal(off.watching, false, "connected, but not watching — and the difference is said out loud");
  assert.match(off.why_not, /asked you not to text them unprompted/);
  assert.match(off.why_not, /do not talk them out of it/);

  await call("notice_mode", { mode: "snooze", said: "not today" });
  const snoozed = await call("notice_status", {});
  assert.match(snoozed.why_not, /snoozed/);
  assert.match(snoozed.why_not, /comes back on by itself/);
});

test("the capability line says the mode, the real hours, and that none of it is permission", async () => {
  await connect();
  await call("notice_window", { time_zone: "Europe/London", awake_from: 9, awake_until: 21, said: "london, 9 to 9" });
  const live = capabilitiesNow({ conversationId: OMARI, ownerName: "Omari" }).find(c => c.name === "notice");
  assert.equal(live.status, "live");
  assert.match(live.what, /already dealt with/, "the handled check is part of what it honestly does");
  assert.match(live.what, /one nudge per thing/);
  assert.match(live.what, /9:00 and 21:00|21:00 and 9:00/);
  assert.match(live.what, /which they told you/);
  assert.match(live.what, /None of those is permission to spend their money/);

  await call("notice_mode", { mode: "off", said: "stop" });
  const off = capabilitiesNow({ conversationId: OMARI, ownerName: "Omari" }).find(c => c.name === "notice");
  assert.match(off.what, /NOT looking/);
  assert.match(off.what, /do not argue with it/);
});

test("an export carries the new columns and a delete takes them", async () => {
  await connect();
  await call("notice_mode", { mode: "digest", said: "one a day", digest_hour: 19 });
  await call("notice_window", { time_zone: TZ, awake_from: 9, awake_until: 21, said: "9 to 9" });
  const row = db.recordNotice(OMARI, {
    kind: "mail_due", key: "due:t1", what: "a bill", thing: "mail:t1", account: "me@example.com", threadId: "t1",
  });
  db.resolveNotice(row.id, "they opened it");
  const { exportData, deleteData } = await import("../src/data.js");
  const dump = JSON.stringify(await exportData(OMARI));
  assert.match(dump, /they opened it/, "what was noticed and resolved is theirs to have");
  assert.match(dump, /mail:t1/);
  await deleteData(OMARI);
  assert.equal(db.noticeById(row.id), null);
  assert.equal(db.resolvedNotices(OMARI).length, 0);
});
