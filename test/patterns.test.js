// Patterns consent: the one question, patterns_set, pattern_note, pattern_still.
// The tools, the gate, and the DB, without a model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-patterns-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const notice = await import("../src/notice.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

const C = "dm:patterns";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => clock.reset());

const call = (name, input = {}, ctx = {}) =>
  runTool(name, input, { conversationId: C, kind: ctx.kind ?? "human", messages: [], ...ctx });

// ---------- patterns_set ----------

test("patterns_set on=true with their words stores the setting", async () => {
  const out = await call("patterns_set", { on: true, said: "yeah go for it" });
  assert.equal(out.ok, true);
  assert.equal(out.patterns, "on");
  const s = notice.settingsFor(C);
  assert.equal(s.patterns, "on");
  assert.equal(s.patternsSaid, "yeah go for it");
});

test("patterns_set on=false deletes existing patterns", async () => {
  db.noteGuess(C, { about: "mornings", guess: "not a morning person", how: db.PATTERN_SOURCE, evidence: ["m1"], use: "no morning nudges" });
  assert.ok(db.listPatterns(C).length > 0, "has a pattern");

  const out = await call("patterns_set", { on: false, said: "nah don't do that" });
  assert.equal(out.ok, true);
  assert.equal(out.patterns, "off");
  assert.equal(db.listPatterns(C).length, 0, "patterns deleted");
});

test("patterns_set refuses without their sentence", async () => {
  const out = await call("patterns_set", { on: true, said: "" });
  assert.equal(out.ok, false);
  assert.match(out.error, /said/i);
});

// ---------- patterns_ask ----------

test("patterns_ask is refused outside the rhythm turn", async () => {
  const out = await call("patterns_ask", {
    about: "evenings", inference: "busy after 9pm", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things"
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /not the turn/i);
});

test("patterns_ask is refused when already asked", async () => {
  db.setPatterns(C, { askedAt: clock.now() });

  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base }, { ref: "m2", at: base + 7 * DAY }, { ref: "m3", at: base + 14 * DAY },
  ], count: 3, span_days: 14 };

  const out = await call("patterns_ask", {
    about: "evenings", inference: "busy after 9pm", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things"
  }, { kind: "event", rhythmEvidence: evidence });
  assert.equal(out.ok, false);
  assert.match(out.error, /already been asked/i);
});

// ---------- pattern_note ----------

test("pattern_note is refused outside the rhythm turn", async () => {
  const out = await call("pattern_note", {
    about: "evenings", inference: "busy after 9pm", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things"
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /reflection turn/i);
});

test("pattern_note is refused when patterns are off", async () => {
  db.setPatterns(C, { patterns: "off" });

  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base }, { ref: "m2", at: base + 7 * DAY }, { ref: "m3", at: base + 14 * DAY },
  ], count: 3, span_days: 14 };

  const out = await call("pattern_note", {
    about: "evenings", inference: "busy after 9pm", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things"
  }, { kind: "event", rhythmEvidence: evidence });
  assert.equal(out.ok, false);
  assert.match(out.error, /said no/i);
});

test("pattern_note stores a rhythm when patterns are on and evidence is valid", async () => {
  db.setPatterns(C, { patterns: "on", said: "yeah go for it" });

  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base }, { ref: "m2", at: base + 7 * DAY }, { ref: "m3", at: base + 14 * DAY },
  ], count: 3, span_days: 14 };

  const out = await call("pattern_note", {
    about: "evenings", inference: "deals with work after 9pm", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things till the evening"
  }, { kind: "event", rhythmEvidence: evidence });
  assert.equal(out.ok, true);
  assert.ok(out.id > 0);
});

test("pattern_note refuses weak evidence", async () => {
  db.setPatterns(C, { patterns: "on", said: "yeah" });

  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base }, { ref: "m2", at: base + 2 * DAY },
  ], count: 2, span_days: 2 };

  const out = await call("pattern_note", {
    about: "evenings", inference: "busy", evidence: ["m1", "m2"], use: "hold stuff"
  }, { kind: "event", rhythmEvidence: evidence });
  assert.equal(out.ok, false);
});

// ---------- pattern_still ----------

test("pattern_still refreshes last_supported_at on named rows", async () => {
  db.setPatterns(C, { patterns: "on", said: "yes" });

  const base = Date.parse("2026-10-01T21:00:00-04:00");
  const evidence = { points: [
    { ref: "m1", at: base }, { ref: "m2", at: base + 7 * DAY }, { ref: "m3", at: base + 14 * DAY },
  ], count: 3, span_days: 14 };

  const noted = await call("pattern_note", {
    about: "evenings", inference: "stays up past 10", evidence: ["m1", "m2", "m3"], use: "hold non-urgent things"
  }, { kind: "event", rhythmEvidence: evidence });

  clock.skip(5 * DAY);
  const out = await call("pattern_still", { ids: [noted.id] }, { kind: "event", rhythmEvidence: evidence });
  assert.equal(out.ok, true);
  assert.equal(out.still_holds.length, 1);
  assert.equal(out.still_holds[0].id, noted.id);
});

test("pattern_still reports missing IDs honestly", async () => {
  const evidence = { points: [], count: 0, span_days: 0 };
  const out = await call("pattern_still", { ids: [99999] }, { kind: "event", rhythmEvidence: evidence });
  assert.equal(out.ok, true);
  assert.equal(out.still_holds.length, 0);
  assert.ok(out.no_such_pattern.includes(99999));
});

// ---------- DB layer: holdPatternAsk / takePatternAsk ----------

test("holdPatternAsk holds then take removes it", () => {
  const c2 = "dm:pattern-ask-db";
  db.upsertAccount({ conversationId: c2, channel: "test", address: "+15559998888", name: "Ask", isOperator: false });

  const held = db.holdPatternAsk(c2, { about: "pace", inference: "replies within 10 min", evidence: ["m1", "m2", "m3"], use: "expect fast" });
  assert.ok(held);
  assert.equal(held.already_asked, false);

  const again = db.holdPatternAsk(c2, { about: "pace", inference: "something else", evidence: ["m4"], use: "x" });
  assert.equal(again.already_asked, true);

  const taken = db.takePatternAsk(c2);
  assert.ok(taken);
  assert.equal(taken.about, "pace");

  const gone = db.patternAsk(c2);
  assert.equal(gone, null);
});

// ---------- memory page includes patterns ----------

test("memory_page lists patterns in the page blocks", async () => {
  const c3 = "dm:pattern-page";
  db.upsertAccount({ conversationId: c3, channel: "test", address: "+15559997777", name: "Page", isOperator: true });
  db.setPatterns(c3, { patterns: "on", said: "sure" });
  db.noteGuess(c3, { about: "pace", guess: "comes back fast", how: db.PATTERN_SOURCE, evidence: ["m1", "m2", "m3"], use: "can ask follow-ups quickly" });

  const out = await runTool("memory_page", {}, { conversationId: c3, kind: "human", messages: [] });
  assert.ok(out.page_blocks?.some(b => b.title?.includes("rhythm")), "has rhythms section");
});

// ---------- dropPatterns on forget ----------

test("forgetPerson removes pattern rows", () => {
  const c4 = "dm:pattern-forget";
  db.upsertAccount({ conversationId: c4, channel: "test", address: "+15559996666", name: "Forget", isOperator: true });
  db.noteGuess(c4, { about: "mornings", guess: "sleeps in", how: db.PATTERN_SOURCE, evidence: ["m1", "m2", "m3"], use: "no 7am texts" });
  assert.equal(db.listPatterns(c4).length, 1);

  db.dropPatterns(c4);
  assert.equal(db.listPatterns(c4).length, 0);
});
