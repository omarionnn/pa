// The card, replayed against the real model.
//
// test/commitment.test.js proves the plumbing: the grace window, one nudge per occurrence, the zone on
// the row, the numbers coming off real logs and nowhere else. What it cannot prove is the thing the
// card is actually about, because none of it is a fact code can check:
//
//   "It notices when you skip"
//   "It won't shame you. It will make going very easy."
//     Reason: "leg day. you said 7am and it's 7:10 👀"
//     Omari:  "omw"
//     Reason: "squats 4x8, rdl 3x10, lunges 3x12."
//     Reason: "you hit 185 last week. go 190."
//
// Four things have to be true of a real model reading a real frame: the nudge names the real thing
// and the real time rather than being a generic poke; "omw" is read as going and answered with the
// session rather than with a question; the progression line moves UP from a number that was really
// logged; and none of it has shame in it. The last one is the point of the feature and is the one
// thing a fake model can never test, because the fake writes the line.
//
// Asserts on facts rather than on wording. Skipped with no model reachable.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-habit-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "https://reason.example.test";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { runTool } = await import("../src/tools.js");
const commitment = await import("../src/commitment.js");
const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const TZ = "America/New_York";
const TUE = 2;
const FRI = 5;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Anything in these is a line that made the person the subject rather than the session. */
const SHAME = /you said you(?:'| wou)?ld|that's \d+ (?:this|in a)|no excuses|disappoint|slacking|lazy|you keep|again\?|third time|you promised|what happened\?|why didn't you|skipped again/i;

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;
    DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM tasks; DELETE FROM task_log; DELETE FROM pages;
    DELETE FROM timers; DELETE FROM commitments; DELETE FROM commitment_logs; DELETE FROM notice_seen;
    DELETE FROM notice_budget; DELETE FROM notice_sweeps; DELETE FROM action_ledger;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.setNoticeWindow(C, { timeZone: TZ, start: 8, end: 22, askedAt: clock.now(), answeredAt: clock.now() });
  config.habitGraceMin = 10;
  config.habitWindowMin = 180;
  config.habitRunOfSkips = 3;
  skipTo({ weekday: 1, hour: 12 });
});

/** Forward to the next moment it is this weekday at this wall-clock time where they are. */
function skipTo({ weekday, hour, minute = 0, zone = TZ }) {
  for (let ahead = 0; ahead < 16; ahead++) {
    const day = notice.localDay(clock.now() + ahead * DAY, zone);
    if (commitment.weekdayIn(commitment.instantOf(day, 12 * 60, zone), zone) !== weekday) continue;
    const target = commitment.instantOf(day, hour * 60 + minute, zone);
    if (target <= clock.now()) continue;
    clock.skip(target - clock.now());
    return clock.now();
  }
  throw new Error(`never reached weekday ${weekday} at ${hour}:${minute}`);
}

function harness() {
  const rt = new Runtime();
  const router = new Router();
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });

  async function says(text) {
    clock.skip(MIN);
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const before = fake.sent.length;
    await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return fake.sent.slice(before).map(m => m.text).join("\n");
  }
  /** Run the pass that notices a skip, and hand back whatever really reached the phone. */
  async function sweepStanding() {
    const before = fake.sent.length;
    const out = await rt.commitments();
    await rt.outbox();
    return { out, said: fake.sent.slice(before).map(m => m.text).join("\n") };
  }
  return { rt, says, sweepStanding, fake };
}

test(`the whole card: it notices, hands over the session, and asks for one more than they really hit (${label})`, { skip }, async () => {
  const { rt, says, sweepStanding } = harness();
  // Written as the run goes and printed whatever happens, the way test/flow-documents.test.js
  // prints its file. On a pass it is the evidence the use-case entry is quoted from; on a failure it
  // is the only thing that explains which line went wrong, so it is not inside the try.
  const script = [];
  const him = (text) => { script.push(`  him:    ${text}`); return says(text); };
  const heard = (what, said) => {
    script.push(...String(said || "(nothing)").split("\n").map(l => `  Reason: ${l}`), ...(what ? [`          — ${what}`] : []));
    return said;
  };
  try {
    // ---------- 1. he sets it in plain words ----------
    const set = await him("leg day tuesdays and fridays 7am");
    heard("", set);
    assert.ok(set.length > 0, "it answered");
    const rows = db.listCommitments(C, { state: null });
    assert.equal(rows.length, 1, `it did not save the commitment. it said: ${JSON.stringify(set)}`);
    const row = rows[0];
    assert.deepEqual(commitment.daysOf(row), [TUE, FRI], `wrong days: ${row.days}`);
    assert.equal(row.at_min, 7 * 60, `wrong time: ${row.at_min}`);
    assert.equal(row.time_zone, TZ, "the zone is stamped on the row at save time, not read off the install later");

    // Last Friday, before any of this: a real session, which is where the plan and the number come
    // from. Seeded as a row rather than typed, because what is under test is the nudge.
    db.logSession(C, {
      commitmentId: row.id, day: notice.localDay(clock.now() - 3 * DAY, TZ), kind: "went",
      said: "squats 175x8, rdl 135, lunges", at: clock.now() - 3 * DAY,
      items: [
        { what: "squats", weight: "175", sets: 4, reps: 8 },
        { what: "rdl", weight: "135", sets: 3, reps: 10 },
        { what: "lunges", sets: 3, reps: 12 },
      ],
    });

    // ---------- 2. the time goes past ----------
    skipTo({ weekday: FRI, hour: 7, minute: 5 });
    const early = await sweepStanding();
    assert.equal(early.said, "", `it nudged at 7:05, before the grace window closed: ${JSON.stringify(early.said)}`);

    clock.skip(7 * MIN);                                  // 7:12
    const { said: nudge } = await sweepStanding();
    script.push("  (7:12, nothing from him)");
    heard("the nudge", nudge);
    assert.ok(nudge.length > 0, "the time went past and it said nothing at all");
    assert.match(nudge, /leg day/i, `the nudge does not name the real thing: ${JSON.stringify(nudge)}`);
    assert.match(nudge, /7|seven/, `the nudge does not name the real time: ${JSON.stringify(nudge)}`);
    assert.doesNotMatch(nudge, SHAME, `the nudge has shame in it: ${JSON.stringify(nudge)}`);

    // ---------- 3. "omw", and the session with nothing left to decide ----------
    const plan = await him("omw");
    heard("the session, with nothing left to decide", plan);
    assert.ok(plan.length > 0, "it said nothing back to omw");
    assert.doesNotMatch(plan, SHAME, `shame in the reply to omw: ${JSON.stringify(plan)}`);
    assert.match(plan, /squat/i, `it did not hand over the session it had: ${JSON.stringify(plan)}`);
    assert.match(plan, /rdl|romanian|lunge/i, `only one exercise of the three it had: ${JSON.stringify(plan)}`);

    // The number it has, and up rather than level — asserted across the nudge and the answer to
    // "omw" together, because which of the two carries it is not the feature. The frame hands the
    // model the nudge AND the session in one turn, so a run where "you hit 175, go 185" is already
    // in the 7:12 text and the "omw" reply moves a second lift on is the card, not a miss of it.
    // Pinning it to the second message alone failed a run that did everything the card asks.
    const exchange = `${nudge}\n${plan}`;
    assert.match(exchange, /175/, `it never said the number they really hit: ${JSON.stringify(exchange)}`);
    const asked = [...exchange.matchAll(/\b(1[7-9]\d|2[0-4]\d)\b/g)].map(m => Number(m[1]));
    assert.ok(asked.some(n => n > 175), `it did not ask for more than the 175 they hit: ${JSON.stringify(exchange)}`);
    // Whether every weight in it came off a row is pinned offline instead, in test/commitment.test.js:
    // the frame lists `their_numbers` and nothing else, and a live text cannot be told apart from
    // its own sets and reps by a regex ("3x10" and "145 lb" are the same shape).

    // ---------- 4. the numbers he did today ----------
    heard("", await him("squats 185x8"));
    const today = db.sessionOn(row.id, notice.localDay(clock.now(), TZ));
    assert.ok(today, "it did not log the session at all");
    assert.equal(today.kind, "went");
    const items = commitment.itemsOf(today);
    assert.ok(items.some(i => String(i.weight ?? "").includes("185")),
      `it did not log the 185: ${JSON.stringify(items)}`);

    // ---------- 5. next week, off the real log ----------
    skipTo({ weekday: TUE, hour: 7, minute: 12 });
    const { said: next } = await sweepStanding();
    script.push("  --- the next one, read off that log ---");
    heard("", next);
    assert.ok(next.length > 0, "nothing next week");
    assert.doesNotMatch(next, SHAME, `shame in next week's nudge: ${JSON.stringify(next)}`);
    const after = await him("omw");
    heard("", after);
    const both = `${next}\n${after}`;
    assert.match(both, /185/, `next week does not know about the 185: ${JSON.stringify(both)}`);
    const beat = [...both.matchAll(/\b(18[6-9]|19\d|2[0-4]\d)\b/g)].map(m => Number(m[1]));
    assert.ok(beat.length > 0, `it did not ask for more than 185: ${JSON.stringify(both)}`);

    // What it really said, printed the way test/flow-documents.test.js prints its file. The asserts
    // above are about facts; the thing a person wants to read before believing any of this is the
    // transcript. It is also what the use-case entry is quoted from, so it has to come out of a run
    // rather than out of anybody's memory of one.
  } finally {
    rt.stop();
    console.log(["", "  --- the card, as it really ran ---", ...script, ""].join("\n"));
  }
});

test(`"cant today" is the end of it: no guilt, no second nudge (${label})`, { skip }, async () => {
  const { rt, says, sweepStanding } = harness();
  try {
    await says("leg day tuesdays and fridays 7am");
    const row = db.listCommitments(C, { state: null })[0];
    assert.ok(row, "it did not save the commitment");

    skipTo({ weekday: FRI, hour: 7, minute: 12 });
    const { said: nudge } = await sweepStanding();
    assert.ok(nudge.length > 0, "it did not notice");

    const answer = await says("cant today");
    assert.ok(answer.length > 0, "it said nothing back");
    assert.doesNotMatch(answer, SHAME, `guilt in the answer to a no: ${JSON.stringify(answer)}`);
    assert.doesNotMatch(answer, /tomorrow\?|instead\?|later\?|move it to|reschedul|how about/i,
      `it tried to re-book a session they just declined: ${JSON.stringify(answer)}`);
    const logged = db.sessionOn(row.id, notice.localDay(clock.now(), TZ));
    assert.ok(logged, "a no is still something that happened, and it was not written down");
    assert.ok(["missed", "hurt"].includes(logged.kind), `logged as ${logged.kind}`);

    // And the rest of the morning is silent, however many sweeps run.
    for (const mins of [20, 45, 60]) {
      clock.skip(mins * MIN);
      const again = await sweepStanding();
      assert.equal(again.said, "", `it came back after a no: ${JSON.stringify(again.said)}`);
    }
  } finally { rt.stop(); }
});

test(`something hurting gets no plan and no push (${label})`, { skip }, async () => {
  const { rt, says, sweepStanding } = harness();
  try {
    await says("leg day tuesdays and fridays 7am");
    const row = db.listCommitments(C, { state: null })[0];
    assert.ok(row, "it did not save the commitment");
    db.logSession(C, {
      commitmentId: row.id, day: notice.localDay(clock.now() - 3 * DAY, TZ), kind: "went",
      said: "squats 185x8", at: clock.now() - 3 * DAY,
      items: [{ what: "squats", weight: "185", sets: 4, reps: 8 }],
    });

    skipTo({ weekday: FRI, hour: 7, minute: 12 });
    await sweepStanding();
    const answer = await says("my knee hurts");
    assert.ok(answer.length > 0, "it said nothing");
    assert.doesNotMatch(answer, /squat|rdl|lunge|185|sets|reps/i,
      `it handed somebody with a hurt knee a leg session: ${JSON.stringify(answer)}`);
    assert.doesNotMatch(answer, /ice it|rest it|stretch|physio|probably just|take a (?:rest|day)|see a doctor|strain|sprain/i,
      `it gave advice about an injury: ${JSON.stringify(answer)}`);
    assert.doesNotMatch(answer, SHAME, `shame in it: ${JSON.stringify(answer)}`);
    const logged = db.sessionOn(row.id, notice.localDay(clock.now(), TZ));
    assert.ok(logged && ["hurt", "missed"].includes(logged.kind), `logged as ${logged?.kind}`);
  } finally { rt.stop(); }
});
