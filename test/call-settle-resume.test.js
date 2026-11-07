// A restart between the end of a call and the owner's turn about it (call 57, 2026-10-31: end_call at
// 19:33:54, a deploy restarted the service at 19:34:06, the turn sending the summary and the audio died,
// and nothing ever went). The boot picks up exactly that turn, once: the thread is not written twice,
// no second recording or note goes out, and a timer the turn set is not set again.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-settle-resume-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";

const { resumeSettles } = await import("../src/calls/postcall.js");
const { settleGptLive } = await import("../src/calls/gptlive.js");
const { settleCall } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM timers;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
});

/** The owner's turn: dies like a CLI under SIGTERM, or answers and sets the timer it was asked for. */
function runtime({ dies = false } = {}) {
  const events = [];
  return {
    events,
    mayInterrupt: () => true,
    event: async (conversationId, text, meta) => {
      events.push({ conversationId, text, meta });
      if (dies) throw new Error("the CLI was stopped by SIGTERM before it finished");
      db.createTimer(conversationId, { fireAt: clock.now() + 3600_000, note: "check the trains before Omari leaves" });
      return "set the train check for 5:40";
    },
  };
}

const callWords = (c) => db.loadConversation(c).filter(m => /on the call|on a phone call/.test(String(m.content))).length;
const timers = () => db.db.prepare("SELECT COUNT(*) n FROM timers").get().n;

const gptliveLive = {
  state: "completed", outcome: "", summary: "",
  transcript: "Them: check the trains before I go?\nReason: want me to check right before you leave?\nThem: yeah",
  turns: [
    { who: "them", text: "check the trains before I go?" },
    { who: "reason", text: "want me to check right before you leave?" },
    { who: "them", text: "yeah" },
  ],
  durationS: 574, costCents: 0, termination: "end_call", cutOff: null, recording: null, recordingWhy: "",
};

const gptliveCall = () => db.createCall(C, {
  provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "Omari called Reason", facts: [],
  direction: "in", externalId: "gptlive:CA57", state: "in_progress", announcement: "",
});

test("GPT-Live: settle killed at the owner's turn → the boot finishes it once, nothing doubled", async () => {
  const row = gptliveCall();
  const dying = runtime({ dies: true });
  await assert.rejects(settleGptLive({ row, live: gptliveLive, settle: settleCall, runtime: dying }));
  let r = db.getCall(C, row.id);
  assert.ok(r.settle_started_at, "begun");
  assert.equal(r.settled_at, null, "not finished");
  assert.equal(r.told_at, null);
  assert.equal(callWords(C), 3, "the thread has the call once");

  // The restart.
  const after = runtime();
  assert.deepEqual(await resumeSettles({ runtime: after }), [row.id]);
  assert.equal(after.events.length, 1, "one owner turn");
  assert.match(after.events[0].text, /said yes to something you offered to do later/, "the GPT-Live follow-up ask rides along");
  assert.equal(after.events[0].meta.forCall, row.id, "the audio rides on it");
  r = db.getCall(C, row.id);
  assert.ok(r.told_at && r.settled_at);
  assert.equal(callWords(C), 3, "not written into the thread again");
  assert.equal(timers(), 1);

  // A second restart: nothing.
  const again = runtime();
  assert.deepEqual(await resumeSettles({ runtime: again }), []);
  assert.equal(again.events.length, 0);
  assert.equal(timers(), 1, "the timer is not set twice");
});

test("a settle that finished is never resumed, and neither is one older than a day or already tried", async () => {
  const done = gptliveCall();
  await settleGptLive({ row: done, live: gptliveLive, settle: settleCall, runtime: runtime() });
  assert.ok(db.getCall(C, done.id).settled_at);

  const old = gptliveCall();
  await assert.rejects(settleGptLive({ row: old, live: gptliveLive, settle: settleCall, runtime: runtime({ dies: true }) }));
  const rt = runtime();
  assert.deepEqual(await resumeSettles({ runtime: rt, now: clock.now() + 25 * 3600_000 }), [], "too old to text about now");

  const tried = gptliveCall();
  await assert.rejects(settleGptLive({ row: tried, live: gptliveLive, settle: settleCall, runtime: runtime({ dies: true }) }));
  db.updateCall(C, tried.id, { settle_resumes: 1 });
  assert.deepEqual(await resumeSettles({ runtime: rt }), [old.id], "the in-window, untried one; once only for one a resume already died on");
  assert.equal(rt.events.length, 1);
});

test("an older call the new marks never touched is left alone", async () => {
  const row = gptliveCall();
  db.updateCall(C, row.id, { state: "completed" });
  const rt = runtime();
  assert.deepEqual(await resumeSettles({ runtime: rt }), []);
  assert.equal(rt.events.length, 0);
});

test("a call whose owner was already told is only marked finished", async () => {
  const row = gptliveCall();
  await assert.rejects(settleGptLive({ row, live: gptliveLive, settle: settleCall, runtime: runtime({ dies: true }) }));
  db.updateCall(C, row.id, { told_at: clock.now() });
  const rt = runtime();
  assert.deepEqual(await resumeSettles({ runtime: rt }), [row.id]);
  assert.equal(rt.events.length, 0);
  assert.ok(db.getCall(C, row.id).settled_at);
});

