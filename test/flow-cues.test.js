// Cues, end to end through the real runtime, with a fake model.
//
// test/cues.test.js proves the rules a call at a time. This is the path a person is actually on:
// their text → the model hears a trip and makes one offer in its reply → days pass → the one-off timer
// for a held offer fires → that turn may speak only through notice_send, inside the day's budget.
// The model is played by a function; every tool it calls is the real one.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-cues-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_CUES = "owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const cues = await import("../src/cues.js");
const notice = await import("../src/notice.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:owner";
const MIN = 60_000;
const T0 = Date.parse("2026-11-11T15:00:00-05:00");
/** Search and reminders only: no rides, no calls. What most people have on day one. */
const ENV = { tools: new Set(["browser_open", "timer_set"]), connected: () => false };
const GOOD = { why_now: "check-in opens now", specific_to_them: true, one_word_answerable: true };

beforeEach(() => {
  for (const t of ["cues", "cue_offers", "cue_prefs", "cue_mutes", "notice_seen", "timers", "notice_budget"]) db.db.exec(`DELETE FROM ${t}`);
  clock.reset();
  clock.skip(T0 - Date.now());
});

function harness(answer) {
  const turns = [];
  const sent = [];
  const rt = new Runtime({
    runTurn: async ({ conversationId, text, kind }) => {
      turns.push({ text, kind });
      return await answer({
        text, kind,
        key: /key "([^"]+)"/.exec(String(text))?.[1] ?? null,
        call: (name, input) => runTool(name, input, { conversationId, kind, messages: [], cueEnv: ENV }),
      });
    },
  });
  rt.on("outbound", (m) => sent.push(m));
  return { rt, turns, sent };
}

/** The model's side of "i'm flying to miami on the 20th": hear it, pick one, say it, record it. */
async function hears({ call }) {
  const noted = await call("cue_note", { kind: "trip", what: "the miami trip", said: "i'm flying to miami on the 20th", starts: "2026-11-20T09:30", facts: { mode: "flight" } });
  assert.equal(noted.may_offer_now, true);
  assert.deepEqual(noted.pick_at_most_one.map(o => o.offer), ["stay", "checkin"], "only what this person can get; no ride, no table");
  const line = "nice, miami. want me to find u a place to stay?";
  assert.equal((await call("cue_offer", { cue_id: noted.cue.cue_id, offer: "stay", line })).ok, true);
  return line;
}

test("a trip in a text: one offer in the reply, the rest held, and a held one goes at its moment inside the budget", async () => {
  const { rt, sent, turns } = harness(async (t) => {
    if (t.kind === "user") return hears(t);
    // The timer's turn: the frame names the offer and the key, and the gate is notice_send.
    assert.match(t.text, /offer you were holding/);
    const out = await t.call("notice_send", { ...GOOD, key: t.key, what: "want a nudge when check-in opens for miami?" });
    return out.ok && !out.scheduled ? "want a nudge when check-in opens for miami?" : null;
  });
  try {
    await rt.inbound(C, "i'm flying to miami on the 20th");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /place to stay\?$/);
    const [cue] = cues.listCues(C);
    const rows = Object.fromEntries(cues.listOffers(C).map(o => [o.offer, o]));
    assert.equal(rows.stay.state, "offered");
    assert.equal(rows.checkin.state, "held");
    assert.equal(rows.weather.state, "skipped");
    assert.equal(rows.ride.state, "skipped");
    assert.equal(await rt.tick(), 0, "nothing is due yet, so nothing more is said today");

    // 24 hours before the flight.
    clock.skip(rows.checkin.moment_at - clock.now() + MIN);
    assert.ok(await rt.tick() >= 1);
    assert.equal(sent.length, 2, "the held offer goes, once, at its moment");
    assert.equal(sent[1].fromNotice, `cue:${cue.id}:checkin`);
    const s = notice.settingsFor(C);
    assert.equal(db.noticeBudget(C, notice.localDay(clock.now(), s.timeZone)).sent, 1, "and it cost the day's one unprompted text");
    cues.sync(C);
    assert.equal(cues.listOffers(C).find(o => o.offer === "checkin").state, "offered");
    assert.equal(turns.filter(t => t.kind !== "user").length, 1);
  } finally { await rt.shutdown(); }
});

test("the gate is the only way out: a held offer's turn that skips notice_send sends nothing", async () => {
  const { rt, sent } = harness(async (t) => (t.kind === "user" ? hears(t) : "want a nudge when check-in opens?"));
  try {
    await rt.inbound(C, "i'm flying to miami on the 20th");
    const checkin = cues.listOffers(C).find(o => o.offer === "checkin");
    clock.skip(checkin.moment_at - clock.now() + MIN);
    await rt.tick();
    assert.equal(sent.length, 1, "only the reply they asked for ever went");
  } finally { await rt.shutdown(); }
});

test("a held offer for a trip they called off never gets a turn", async () => {
  const { rt, sent, turns } = harness(async (t) => (t.kind === "user" ? hears(t) : "should not be asked"));
  try {
    await rt.inbound(C, "i'm flying to miami on the 20th");
    const [cue] = cues.listCues(C);
    const checkin = cues.listOffers(C).find(o => o.offer === "checkin");
    cues.end({ conversationId: C, cueId: cue.id, why: "trip cancelled", said: "miami's off" });
    clock.skip(checkin.moment_at - clock.now() + MIN);
    await rt.tick();
    assert.equal(sent.length, 1);
    assert.equal(turns.filter(t => t.kind !== "user").length, 0, "a cancelled timer costs no model turn");
  } finally { await rt.shutdown(); }
});
