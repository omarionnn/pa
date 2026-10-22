// The subway status is only said as live when the feed says it is fresh (src/transit.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "reason-transit-")), "reason.db");
const { transitStatus, lineStatus } = await import("../src/transit.js");
const { runTool } = await import("../src/tools.js");
const { config } = await import("../src/config.js");

const NOW = Date.UTC(2026, 9, 22, 9, 45);
const route = (line, ageMin, extra = {}) => ({
  id: line, status: "Delay", timestamp: Math.floor((NOW - ageMin * 60_000) / 1000),
  direction_statuses: { north: "Good Service", south: "Delay" },
  delay_summaries: { north: null, south: "Southbound trains are delayed while crews respond to a signal problem." },
  service_irregularity_summaries: { north: null, south: null },
  service_change_summaries: { both: [], north: [], south: [] },
  ...extra,
});
const serving = (map, calls = []) => async (url) => {
  calls.push(url);
  const line = url.split("/").pop();
  const r = map[line];
  if (r instanceof Error) throw r;
  if (typeof r === "number") return { ok: false, status: r, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => r };
};

test("a fresh feed is trusted and its delays come through", async () => {
  const r = await lineStatus("5", { fetchImpl: serving({ 5: route("5", 2) }), now: NOW });
  assert.equal(r.trust, true);
  assert.equal(r.updated_minutes_ago, 2);
  assert.match(r.delays.south[0], /signal problem/);
});

test("a day-old feed is not trusted, and the result says what to say instead", async () => {
  const out = await transitStatus(["5", "2"], { fetchImpl: serving({ 5: route("5", 24 * 60), 2: route("2", 1) }), now: NOW });
  const five = out.lines.find(l => l.line === "5");
  assert.equal(five.trust, false);
  assert.match(five.why, /1440 minutes ago/);
  assert.equal(out.all_live, false);
  assert.match(out.say, /could not get live status for the 5/);
  assert.match(out.say, /Never say a line is running fine/);
  assert.equal(out.lines.find(l => l.line === "2").trust, true);
});

test("a feed that fails is tried twice, then reported, never guessed", async () => {
  const calls = [];
  const out = await transitStatus(["2"], { fetchImpl: serving({ 2: 503 }, calls), now: NOW });
  assert.equal(calls.length, 2);
  assert.equal(out.lines[0].trust, false);
  assert.match(out.lines[0].why, /tried twice/);
  assert.ok(out.say);
});

test("a feed with no timestamp is not trusted", async () => {
  const out = await transitStatus(["2"], { fetchImpl: serving({ 2: route("2", 0, { timestamp: null }) }), now: NOW });
  assert.equal(out.lines[0].trust, false);
});

test("web_lookup on the subway feed goes through the freshness check", async () => {
  const out = await runTool("web_lookup", { url: "https://api.subwaynow.app/routes/5" },
    { conversationId: config.ownerConversation, fetchImpl: serving({ 5: route("5", 24 * 60) }) });
  assert.ok(Array.isArray(out.lines), "answered as transit_status, not as a page");
  assert.equal(out.lines[0].trust, false);
});
