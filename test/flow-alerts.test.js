// "The meeting moved to 3. Your calendar still says 2." — with the real model doing the reading.
//
// test/alerts.test.js proves the plumbing: the four candidates, their keys, the rechecks, the
// grounding. All of it against code, and so none of it touches the thing the card is actually
// about. Code never knows a meeting moved. It knows two sources disagree — somebody on the meeting
// wrote after the invite was last touched — and hands both over. Everything after that is the
// model's:
//
//   1. **It opens the thread before it says anything.** The candidate says so in words and a real
//      gmail_read is the proof. A line stating a new time with no read behind it is the one failure
//      that would make this feature worse than silence.
//   2. **The line is the card.** The old time, the new time, and the offer — not "something may
//      have changed about your 2pm".
//   3. **It does NOT move the event.** The calendar is still wrong when the turn ends, because
//      changing somebody's calendar off a mail they have not seen is not Reason's call. The ground
//      truth is the fake's own events array.
//   4. **A thread about something else gets silence.** The common case, and the one that decides
//      whether this reads as watchful or as noise.
//
// Two tests, because every turn here runs on his subscription. No real Google — the same fake the
// rest of the Google suite uses. Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-alerts.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-alerts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_UNDO_SECONDS = "0";

const { startGoogle, fakeMessage } = await import("./fixture-google.js");
const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const google = await import("../src/google.js");

const { config, clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const ME = "me@example.com";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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
after(async () => { await fake?.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  clock.reset();
  // A fixed instant, so nothing in here turns on the hour the suite happens to be run at: ten in
  // the morning where he is, on a Friday.
  clock.skip(Date.parse("2026-10-09T14:00:00Z") - clock.now());
  db.db.exec(`DELETE FROM notice_seen; DELETE FROM notice_events; DELETE FROM notice_budget; DELETE FROM notice_sweeps;
    DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts;
    DELETE FROM action_ledger; DELETE FROM confirmations; DELETE FROM timers; DELETE FROM outbox;
    DELETE FROM conversations;`);
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  fake.reset();
  fake.set({ email: ME, grantScopes: [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES], calendarTimeZone: "America/New_York" });
  fake.setAccount(ME, { mail: [] });
  // `state` is the fixture's running log across the whole file, so it has to be emptied between
  // tests — otherwise `sync()` finds the PREVIOUS test's event and the assertion is about nothing.
  for (const k of ["authHeaders", "events", "eventWrites", "searches", "sent"]) fake.state[k].length = 0;
});

/** Google connected through its real handshake, with the opt-in question already settled. */
async function connectGoogle() {
  const link = await runTool("google_connect", {}, { conversationId: C, messages: [] });
  await google.completeConnect({ code: "good-code", state: new URL(link.url).searchParams.get("state") });
  db.setNoticeWindow(C, { askedAt: clock.now(), answeredAt: clock.now() });
}

/**
 * Two o'clock tomorrow, untouched for four days, and already in the snapshot so the calendar diff
 * raises nothing about it — which is the whole state this catch exists for: nothing has CHANGED on
 * the calendar, and the calendar is nonetheless wrong.
 *
 * Tomorrow rather than this afternoon on purpose. Inside 24h a meeting would also be the brief
 * offer (`meeting_prep`), and the sweep picks ONE thing — so the test would sometimes be about a
 * different catch. A day out, with mail to Dana already in his sent folder so she is not somebody
 * new either, leaves exactly one thing in front of the model.
 */
const SYNC_START = "2026-10-10T14:00:00-04:00";
function seedTheSync() {
  const end = "2026-10-10T15:00:00-04:00";
  fake.seedEvent({
    id: "sync", summary: "Sync with Dana",
    updated: new Date(clock.now() - 4 * DAY).toISOString(),
    start: { dateTime: SYNC_START }, end: { dateTime: end },
    attendees: [{ email: "dana@example.com", responseStatus: "accepted" }, { email: ME, self: true, responseStatus: "accepted" }],
  });
  db.putNoticeEvents(C, ME, [{
    id: "sync", summary: "Sync with Dana", start: SYNC_START, end, status: "confirmed",
    attendees: ["dana@example.com", ME], time_zone: "America/New_York",
  }], clock.now());
  return { start: SYNC_START, end };
}

/** He has written to Dana before, so the new-person brief is not also in front of the model. */
const historyWithDana = () => fakeMessage({
  id: "s0", threadId: "old", from: `Omari <${ME}>`, to: "dana@example.com", subject: "last week",
  date: new Date(clock.now() - 9 * DAY).toUTCString(), text: "works for me", labels: ["SENT"],
});

const sync = () => fake.state.events.find(e => e.id === "sync");
const startOf = (e) => e?.start?.dateTime ?? e?.start?.date ?? "";

test(`a thread that moves a meeting gets the card's own line, and the calendar is not touched (${label})`, { skip }, async () => {
  await connectGoogle();
  const { start } = seedTheSync();
  // Dana wrote half an hour ago, after the invite was last touched four days ago. The new time is
  // ONLY in the body — the subject says nothing and the sweep's frame carries only the subject —
  // so a line with "4" in it is itself the proof that the thread was opened and read.
  fake.setAccount(ME, {
    mail: [
      historyWithDana(),
      fakeMessage({
        id: "d1", threadId: "sync-thread", from: "Dana Okafor <dana@example.com>", to: ME,
        subject: "Re: Sync", date: new Date(clock.now() - 30 * 60_000).toUTCString(),
        text: "Hey — something came up so I've moved our sync to 4pm tomorrow. Same link. Sorry for the shuffle!",
      }),
    ],
  });

  const sent = [];
  const rt = new Runtime({ log: () => {} });
  rt.on("outbound", (m) => sent.push(m));
  try {
    await rt.notice();
    const line = sent.map(m => m.text).join("\n");

    // Something went out, and it went through the gate rather than round it.
    assert.ok(line.length > 0, "it noticed the disagreement and said nothing at all");
    const told = db.noticesSaid(C, { limit: 5 });
    assert.ok(told.some(r => r.kind === "calendar_stale"),
      `what went out was not the stale-calendar catch: ${JSON.stringify(told.map(r => r.kind))}`);

    // It read the thread before saying anything, and this is the proof rather than a ledger row:
    // "4pm" is in the message BODY and nowhere else. The candidate carries the subject ("Re: Sync")
    // and the invite's own 2pm, so a line naming four o'clock cannot have come from anywhere but a
    // real read of the thread.
    assert.match(line, /4\s?(pm|p\.m\.|:\d\d)|\b4\b|\bfour\b/i,
      `the new time is not in the line, so it never opened the thread: ${JSON.stringify(line)}`);
    // And the card says the old time too, because that is the half that makes it actionable.
    assert.match(line, /2\s?(pm|p\.m\.|:\d\d)|\b2\b|\btwo\b/i,
      `it did not say what his calendar still thinks: ${JSON.stringify(line)}`);
    assert.match(line, /\?|want me|shall i|should i/i, `it did not offer to fix it: ${JSON.stringify(line)}`);
    // And it is one line, not a report.
    assert.ok(line.split("\n").filter(Boolean).length <= 3, `that is a report, not one line: ${JSON.stringify(line)}`);

    // The calendar is untouched. Changing it off a mail he has not read is his call, not Reason's.
    assert.equal(startOf(sync()), start, `it moved his meeting without asking: ${JSON.stringify(line)}`);
    assert.ok(!db.listActions(C).some(a => a.action === "calendar_change" && a.outcome === "ok"),
      "it changed the event on its own");
  } finally { rt.stop(); }
});

test(`a thread about something else gets silence, and the calendar stays as it is (${label})`, { skip }, async () => {
  await connectGoogle();
  const { start } = seedTheSync();
  // Dana wrote after the invite was touched — so code raises the same candidate — but she is
  // talking about something else entirely. This is the common case, and silence is the answer.
  fake.setAccount(ME, {
    mail: [
      historyWithDana(),
      fakeMessage({
        id: "d1", threadId: "sync-thread", from: "Dana Okafor <dana@example.com>", to: ME,
        subject: "that deck", date: new Date(clock.now() - 30 * 60_000).toUTCString(),
        text: "No rush at all — just wanted to say the deck you sent round looked great. Nice work on the second half.",
      }),
    ],
  });

  const sent = [];
  const rt = new Runtime({ log: () => {} });
  rt.on("outbound", (m) => sent.push(m));
  try {
    await rt.notice();
    const line = sent.map(m => m.text).join("\n");
    // It may genuinely say nothing, which is the right answer. What it must never do is tell him a
    // time changed off a mail that says no such thing.
    assert.doesNotMatch(line, /moved|pushed|changed .*(time|to \d)|now at \d/i,
      `it invented a time change out of a compliment: ${JSON.stringify(line)}`);
    assert.equal(startOf(sync()), start, "and nothing on his calendar moved");
    const told = db.noticesSaid(C, { limit: 5 });
    assert.ok(!told.some(r => r.kind === "calendar_stale"),
      `it spent his one unprompted text on a thread about a deck: ${JSON.stringify(told.map(r => r.what))}`);
  } finally { rt.stop(); }
});
