// Cues against the real model: does it HEAR one, and is the first offer one line and not a menu?
//
// test/cues.test.js and test/flow-cues.test.js prove code's half with the model played by a function.
// This is the model's half, which no fake can stand in for: reading a cue out of a casual text (typos,
// loose dates, buried in a longer message), NOT reading one into a near-miss (somebody else's past
// trip, a film about a move, "happy birthday!" said to Reason, a hypothetical), and writing nothing
// down when it rests on health, a breakup, a death or money trouble.
//
// Each message is its own fresh conversation. Asserts on rows, never on wording. Skipped with no model.
//
//   REASON_BACKEND=claude-cli node --test test/flow-cues-live.test.js
//   CUES_LIVE_SHARD=0/4 … to split the list across processes; CUES_LIVE_REPORT=<file> appends one JSON line per message.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-cues-live-"));
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
process.env.REASON_CUES = "on";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const cues = await import("../src/cues.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));

/** [id, what they text, the cue it should become — or "none" (a near-miss) or "sensitive" (never written)]. */
export const CASES = [
  ["trip-flight", "im flying to miami on the 20th", "trip"],
  ["trip-train", "takin the train up to boston fri for the wknd", "trip"],
  ["trip-drive", "ugh gotta drive to my parents for thanksgivng next week", "trip"],
  ["move-far", "we're moving to austin in january!!", "move"],
  ["move-lease", "so i finally signed the lease, moving into the new place dec 1", "move"],
  ["bday-mom", "my moms bday is on the 3rd and i have nothing planned", "birthday"],
  ["bday-own", "its my birthday next saturday lol", "birthday"],
  ["bday-friend", "dana turns 30 in like two weeks", "birthday"],
  ["interview-time", "got an interview at stripe thursday at 2!!", "interview"],
  ["interview-loose", "second round w/ figma next week sometime, in person at their sf office", "interview"],
  ["guest-sister", "my sister's visiting next weekend", "guest"],
  ["guest-parents", "my parents fly in on the 22nd, staying w me for a few days", "guest"],
  ["buried-trip", "today was so long. standup ran 40 min and then my manager moved the deadline up again. anyway whats a good quick pasta i can make w whats in a normal fridge? also flying to chicago on the 18th for the offsite so i need to not be dead by then", "trip"],
  ["buried-guest", "can u remind me to call the dentist tmrw at 10. also my college roommate is coming to stay w us the weekend of the 21st so i need to clean lol", "guest"],
  ["buried-interview", "whats 15% of 86? btw i have that interview w datadog on monday 11am, kinda nervous", "interview"],
  ["miss-coworker-trip", "my coworker went to tokyo last month and wont shut up about it", "none"],
  ["miss-movie-move", "have u seen that movie about the family that moves into the haunted house", "none"],
  ["miss-bday-to-reason", "happy birthday reason!!", "none"],
  ["miss-hypothetical", "if i ever fly to japan what should i see", "none"],
  ["miss-brother-back", "my brother just got back from his trip to lisbon, said it was amazing", "none"],
  ["miss-general-q", "whats the cheapest month to fly to europe generally", "none"],
  ["miss-i-interviewed", "i interviewed a candidate today and she was great", "none"],
  ["sens-surgery", "flying to houston on the 20th for my moms surgery", "sensitive"],
  ["sens-breakup", "i have to move out by the end of the month, me and jess broke up", "sensitive"],
  ["sens-funeral", "flying home friday for my grandpas funeral", "sensitive"],
  ["sens-evicted", "we're getting evicted, have to be out of the apartment by dec 1", "sensitive"],
];

const [shard, of] = String(process.env.CUES_LIVE_SHARD ?? "0/1").split("/").map(Number);
const mine = CASES.filter((_, i) => i % of === shard);

function harness() {
  // CUES_LIVE_DEBUG=1 prints why a turn broke (a CLI that would not start, a login that lapsed).
  const rt = new Runtime(process.env.CUES_LIVE_DEBUG ? { log: (o) => { if (o?.turn_failed || o?.error || o?.cli_error) console.error(JSON.stringify(o).slice(0, 1500)); } } : {});
  const router = new Router();
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });
  async function says(text) {
    const handle = `in-${clock.now()}-${Math.random().toString(36).slice(2, 7)}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const before = fake.sent.length;
    await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return fake.sent.slice(before).map(m => m.text).join("\n");
  }
  return { rt, says };
}

for (const [id, text, want] of mine) {
  test(`${id}: ${want === "none" ? "is not a cue" : want === "sensitive" ? "is never written down" : `is heard as a ${want}`} (${label})`, { skip, timeout: 300_000 }, async () => {
    clock.reset();
    // Wednesday 2026-11-11, mid-afternoon in New York.
    clock.skip(Date.parse("2026-11-11T15:00:00-05:00") - Date.now());
    db.db.exec("DELETE FROM cues; DELETE FROM cue_offers; DELETE FROM cue_prefs; DELETE FROM cue_mutes; DELETE FROM notice_seen;"
      + " DELETE FROM goals; DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;"
      + " DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM action_ledger;");
    db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
    const { rt, says } = harness();
    let said = "";
    try { said = await says(text); } finally { await rt.shutdown(); }
    const rows = cues.listCues(C);
    const offered = cues.listOffers(C).filter(o => o.state === "offered");
    const hit = want === "none" || want === "sensitive" ? rows.length === 0 : rows.length === 1 && rows[0].kind === want;
    if (process.env.CUES_LIVE_REPORT) {
      appendFileSync(process.env.CUES_LIVE_REPORT, JSON.stringify({
        id, text, want, hit, noted: rows.map(r => ({ kind: r.kind, what: r.what, said: r.said, starts: r.starts_at ? new Date(r.starts_at).toISOString() : null, facts: r.facts })),
        offered: offered.map(o => ({ offer: o.offer, line: o.line })), reply: said,
      }) + "\n");
    }
    assert.ok(said.length > 0, "it answered");
    if (want === "none" || want === "sensitive") {
      assert.equal(rows.length, 0, `it wrote a cue down for ${JSON.stringify(text)}: ${JSON.stringify(rows.map(r => [r.kind, r.what]))}`);
      return;
    }
    assert.equal(rows.length, 1, `it did not hear the ${want}: ${JSON.stringify(said)}`);
    assert.equal(rows[0].kind, want);
    assert.ok(rows[0].said.trim().length > 0, "their own words are on the row");
    // The first offer: at most one. (Whether the reply reads like a menu is for a person to judge off
    // CUES_LIVE_REPORT; a recipe they asked for in the same message is a list and is not one.)
    assert.ok(offered.length <= 1, "never two offers");
  });
}

// A cue said out loud. The call's words are in the thread by the time the after-call turn runs
// (src/calls/postcall.js writeCallIntoThread); here they ride in the same event, which is the same read.
if (shard === 0) {
  test(`a trip mentioned on a call is noted by the turn after it, and nothing is texted (${label})`, { skip, timeout: 300_000 }, async () => {
    const { ownerEvent } = await import("../src/calls/postcall.js");
    clock.reset();
    clock.skip(Date.parse("2026-11-11T15:00:00-05:00") - Date.now());
    db.db.exec("DELETE FROM cues; DELETE FROM cue_offers; DELETE FROM cue_prefs; DELETE FROM cue_mutes; DELETE FROM notice_seen;"
      + " DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM action_ledger;");
    db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
    const { rt } = harness();
    const call = { id: 1, conversation_id: C, duration_s: 95, provider: "gptlive", recording_state: "none" };
    const words = `[your call with Omari, just now]\nOmari: hey, what's the score of the knicks game\nyou: knicks are up 6 at the half\n`
      + `Omari: nice. oh and i'm flying out to denver on the 3rd of december for my cousin's wedding, should be fun\nyou: that sounds great\nOmari: alright talk later\n\n`;
    let reply;
    try { reply = await rt.event(C, words + ownerEvent({ row: call })); } finally { await rt.shutdown(); }
    const rows = cues.listCues(C);
    if (process.env.CUES_LIVE_REPORT) appendFileSync(process.env.CUES_LIVE_REPORT, JSON.stringify({ id: "call-trip", want: "trip", hit: rows.length === 1 && rows[0].kind === "trip", noted: rows.map(r => ({ kind: r.kind, what: r.what, said: r.said, heard_on: r.heard_on, starts: r.starts_at ? new Date(r.starts_at).toISOString() : null, facts: r.facts })), offered: [], reply: reply ?? "" }) + "\n");
    assert.equal(rows.length, 1, `the trip said on the call was not noted (it replied ${JSON.stringify(reply)})`);
    assert.equal(rows[0].kind, "trip");
    assert.equal(rows[0].heard_on, "call");
    assert.ok(!reply, `nothing was owed, so nothing is texted: ${JSON.stringify(reply)}`);
    assert.equal(cues.listOffers(C).filter(o => o.state === "offered").length, 0, "no offer is made on a turn they did not start");
  });
}
