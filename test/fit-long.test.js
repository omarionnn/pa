// A note over its length cap is kept and shortened, never refused (src/fitlong.js). No model, no network.
//
// The incident, 2026-10-31 to 11-07: timer_set's note (at most 500 characters then) was refused three
// times in a week with "Bad input: note: String must contain at most 500 character(s)", and the
// model retried or gave up.
//
//   a 1,200-character timer note                 → saved whole (the cap is now 2000)
//   a 2,500-character timer note                 → saved, cut at a word with "…", and the result says so
//   a too-long field that goes out word for word → still refused (then_call is not a note)
//   the per-turn kept line                       → shows each reminder's first 300, the row keeps it all
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const dir = mkdtempSync(join(tmpdir(), "reason-fit-long-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { runTool } = await import("../src/tools.js");
const { keptNote } = await import("../src/kept.js");
const { shortenAt, fitLongText } = await import("../src/fitlong.js");

const CONV = "dm:owner";
const ctx = () => ({ conversationId: CONV });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM timers;");
});

test("shortenAt: under the cap untouched; over it cut at a word, ellipsis, never over the cap", () => {
  assert.equal(shortenAt("short note", 50), "short note");
  const long = words(100);
  const cut = shortenAt(long, 60);
  assert.ok(cut.length <= 60, `${cut.length} > 60`);
  assert.ok(cut.endsWith("…"));
  assert.ok(long.startsWith(cut.slice(0, -1)), "a prefix of the original");
  assert.match(cut, /word\d+…$/, "ends on a whole word");
  // One enormous word: cut inside it rather than lose everything.
  assert.equal(shortenAt("x".repeat(100), 10), "x".repeat(9) + "…");
});

test("fitLongText: only soft fields are cut, at any depth; a hard field is left for the refusal", () => {
  const schema = z.object({ text: z.string().max(10), items: z.array(z.object({ note: z.string().max(20) })) });
  const soft = fitLongText(schema, { text: "ok", items: [{ note: words(20) }] });
  assert.equal(soft.shortened.length, 1);
  assert.equal(soft.shortened[0].field, "items.0.note");
  assert.ok(schema.safeParse(soft.input).success);
  const hard = fitLongText(schema, { text: "much too long text", items: [] });
  assert.deepEqual(hard.shortened, []);
  assert.equal(hard.input.text, "much too long text", "a hard field is never touched");
});

test("a 1,200-character timer note is saved whole", async () => {
  const note = words(150).slice(0, 1200);
  const out = await runTool("timer_set", { fire_at: inAnHour(), note, relative: true }, ctx());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.input_shortened, undefined);
  assert.equal(db.listTimers(CONV)[0].note, note);
});

test("a 2,500-character timer note is saved shortened, and the result says so", async () => {
  const note = words(400);
  assert.ok(note.length > 2500);
  const out = await runTool("timer_set", { fire_at: inAnHour(), note, relative: true }, ctx());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.input_shortened, /note \(\d+ → \d+ characters/);
  assert.match(out.input_shortened, /not refused/);
  const saved = db.listTimers(CONV)[0].note;
  assert.ok(saved.length <= 2000 && saved.length > 1900, `saved ${saved.length}`);
  assert.ok(saved.endsWith("…"));
  assert.ok(note.startsWith(saved.slice(0, -1)));
});

test("a too-long then_call (said to them word for word) is still refused, not cut", async () => {
  const out = await runTool("timer_set", { fire_at: inAnHour(), note: "wake up", then_call: words(80), relative: true }, ctx());
  assert.equal(out.ok, false);
  assert.match(out.error, /then_call: String must contain at most 300/);
  assert.equal(db.listTimers(CONV).length, 0);
});

test("the kept line on every turn shows each reminder's first 300 characters", async () => {
  const note = words(200);
  await runTool("timer_set", { fire_at: inAnHour(), note, relative: true }, ctx());
  const line = keptNote(CONV);
  const shown = JSON.parse(line.match(/not yet sent: (\[.*?\])\./)[1])[0].note;
  assert.ok(shown.length <= 300 && shown.endsWith("…"));
  assert.equal(db.listTimers(CONV)[0].note, note, "the row keeps every word");
});
