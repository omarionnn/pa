// "How am i doing on food today" is THEIR today, not the server's (2026-11-11).
//
// meal_query worked out "today" with setHours(0,0,0,0), which is midnight on the machine. Live runs in
// UTC, so for somebody in New York "today" began at 7pm the evening before: at 8:30pm their lunch had
// dropped out of today's total, and last night's late dinner was counted into this morning's.
// The day is the person's own: the zone they confirmed, else the install's (zone.zoneFor).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-mealzone-"));
process.env.TZ = "UTC"; // the live machine's clock
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const db = await import("../src/db.js");
const zone = await import("../src/zone.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

after(() => { clock.reset(); rmSync(dir, { recursive: true, force: true }); });

const at = (iso) => { clock.reset(); clock.skip(Date.parse(iso) - Date.now()); };
const meal = (name, kcal) => ({
  type: "description", items: [name], kcal_low: kcal - 100, kcal_likely: kcal, kcal_high: kcal + 100,
  protein_g: 30, carbs_g: 50, fat_g: 20, confidence: "medium",
});
const names = (out) => out.entries.map(e => e.items[0]);

test("today is the person's own day: an evening total still has lunch, and not last night's dinner", async () => {
  const ctx = { conversationId: "c-meal-ny" }; // no confirmed zone: the install's, New York
  await runTool("meal_log_consent", { consent: "yes" }, ctx);

  at("2026-11-11T01:30:00Z"); // Tuesday 8:30pm in New York
  assert.equal((await runTool("meal_estimate", meal("tuesday dinner", 800), ctx)).logged, true);
  at("2026-11-11T17:30:00Z"); // Wednesday 12:30pm
  assert.equal((await runTool("meal_estimate", meal("wednesday lunch", 620), ctx)).logged, true);

  at("2026-11-11T18:00:00Z"); // Wednesday 1pm
  assert.deepEqual(names(await runTool("meal_query", { period: "today" }, ctx)), ["wednesday lunch"], "last night's dinner is yesterday's");
  assert.deepEqual(names(await runTool("meal_query", { period: "yesterday" }, ctx)), ["tuesday dinner"]);

  at("2026-11-12T01:30:00Z"); // Wednesday 8:30pm — past midnight UTC
  assert.equal((await runTool("meal_estimate", meal("wednesday dinner", 700), ctx)).logged, true);
  const today = await runTool("meal_query", { period: "today" }, ctx);
  assert.deepEqual(names(today), ["wednesday lunch", "wednesday dinner"], "lunch is still today at 8:30pm");
  assert.equal(today.totals.kcal_likely, 1320);
  assert.deepEqual(names(await runTool("meal_query", { period: "yesterday" }, ctx)), ["tuesday dinner"]);
  assert.equal((await runTool("meal_query", { period: "week" }, ctx)).count, 3);
});

test("a confirmed zone is the one that counts", async () => {
  const ctx = { conversationId: "c-meal-la" };
  db.upsertAccount({ conversationId: ctx.conversationId, channel: "fake", address: "+13105550142", name: "Ama" });
  assert.equal(zone.confirm(ctx.conversationId, "America/Los_Angeles").ok, true);
  await runTool("meal_log_consent", { consent: "yes" }, ctx);

  at("2026-11-12T06:30:00Z"); // Wednesday 10:30pm in Los Angeles, already Thursday in New York and UTC
  assert.equal((await runTool("meal_estimate", meal("late snack", 300), ctx)).logged, true);
  at("2026-11-12T07:30:00Z"); // Wednesday 11:30pm
  assert.deepEqual(names(await runTool("meal_query", { period: "today" }, ctx)), ["late snack"]);
  at("2026-11-12T16:00:00Z"); // Thursday 8am
  assert.deepEqual(names(await runTool("meal_query", { period: "today" }, ctx)), []);
  assert.deepEqual(names(await runTool("meal_query", { period: "yesterday" }, ctx)), ["late snack"]);
});
