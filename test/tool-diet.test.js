// The tool diet (src/tooldiet.js): a reply call carries core + the person's likely tools whole and
// defers the rest behind tool search; the loaded set never changes while their cache is warm.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-tooldiet-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "11".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ = "America/New_York";
delete process.env.REASON_TOOL_DIET;

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { toolsFor, tools } = await import("../src/tools.js");
const diet = await import("../src/tooldiet.js");
const { mcpToolsFor } = await import("../src/backends/mcp-core.js");
const { model, runTurn } = await import("../src/agent.js");

const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
const U = "dm:+12025550111";
db.upsertAccount({ conversationId: U, channel: "test", address: "+12025550111", name: "Ama", isOperator: false });

beforeEach(() => { diet._resetDiet(); process.env.REASON_TOOL_DIET = "on"; });

test("unset or unknown is off: a deploy that forgets the line changes nothing", () => {
  for (const v of [undefined, "", "yes", "maybe"]) {
    if (v === undefined) delete process.env.REASON_TOOL_DIET; else process.env.REASON_TOOL_DIET = v;
    assert.equal(diet.dietMode(), "off", String(v));
    const vis = toolsFor(C);
    assert.deepEqual(diet.apiTools(C, vis), { tools: vis, note: "" });
  }
});

const chars = (list) => list.reduce((n, t) => n + JSON.stringify(t).length, 0);

test("every CORE and PACKS name is a real tool (a typo would silently load nothing)", () => {
  const names = new Set(tools.map(t => t.name));
  for (const n of diet.CORE) assert.ok(names.has(n), `core ${n}`);
  for (const [k, list] of Object.entries(diet.PACKS)) for (const n of list) assert.ok(names.has(n), `${k}: ${n}`);
});

test("an API call carries core whole, the search tool, and every other visible tool deferred", () => {
  const visible = toolsFor(C);
  const { tools: sent, note } = diet.apiTools(C, visible);
  const loaded = sent.filter(t => !t.defer_loading && !t.type);
  const deferred = sent.filter(t => t.defer_loading);
  assert.equal(sent.filter(t => t.type === diet.SEARCH_TOOL.type).length, 1, "one search tool, never deferred");
  assert.equal(loaded.length + deferred.length, visible.length, "nothing visible is dropped");
  for (const n of diet.CORE) if (visible.some(t => t.name === n)) assert.ok(loaded.some(t => t.name === n), `${n} loaded`);
  assert.ok(deferred.length > visible.length * 0.75, `${deferred.length} of ${visible.length} deferred`);
  // What the model reads up front shrinks by far more than half.
  assert.ok(chars(loaded) < chars(visible) / 4, `${chars(loaded)} vs ${chars(visible)} chars loaded`);
  // The model is told the names of what it does not hold, and to search before saying it can't.
  for (const t of deferred.slice(0, 20)) assert.ok(note.includes(t.name), `${t.name} named`);
  assert.match(note, /tool_search_tool_bm25/);
  assert.match(note, /Never tell them you can't/);
  // No deferred tool carries a cache breakpoint (the API refuses that) — none carries one at all.
  assert.ok(sent.every(t => !t.cache_control));
});

test("the tools array is byte-identical call after call (the prefix stays cacheable)", () => {
  const a = JSON.stringify(diet.apiTools(C, toolsFor(C)));
  const b = JSON.stringify(diet.apiTools(C, toolsFor(C)));
  assert.equal(a, b);
});

test("owner mode: everyone else's API request, CLI tools/list and stored use are exactly as with the diet off", async () => {
  const { mcpToolsFor: mcp, ALWAYS_LOAD } = await import("../src/backends/mcp-core.js");
  const { runTool } = await import("../src/tools.js");
  const capture = async () => {
    const saved = model.create; const seen = [];
    model.create = async (p) => { seen.push(JSON.parse(JSON.stringify(p))); return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "ok" }] }; };
    try { await runTurn({ conversationId: U, text: "what's on today", kind: "user", events: { emit() {} }, log: () => {} }); } finally { model.create = saved; }
    return seen[0];
  };
  process.env.REASON_TOOL_DIET = "off";
  const offReq = await capture(); const offList = JSON.stringify(mcp(U));
  db.saveConversation(U, []); diet._resetDiet();
  process.env.REASON_TOOL_DIET = "owner";
  const ownerReq = await capture(); const ownerList = JSON.stringify(mcp(U));
  assert.deepEqual(ownerReq.tools, offReq.tools);
  assert.deepEqual(ownerReq.system, offReq.system);
  assert.ok(!ownerReq.tools.some(t => t.defer_loading || t.type));
  assert.equal(ownerList, offList);
  assert.ok(JSON.parse(ownerList).filter(t => t._meta?.["anthropic/alwaysLoad"]).every(t => ALWAYS_LOAD.has(t.name)));
  await runTool("timer_list", {}, { conversationId: U });
  assert.equal(diet.recentToolUse(U).length, 0, "nothing of theirs is kept");
  db.saveConversation(U, []);
});

test("a refused diet request: the turn goes on with every tool loaded and no search blocks", async () => {
  const saved = model.create; const seen = [];
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  model.create = async (p) => {
    seen.push(p);
    if (seen.length === 1) throw new Anthropic.BadRequestError(400, { error: { message: "bad tool" } }, "bad tool", new Headers());
    return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "fine" }] };
  };
  db.saveConversation(C, [{ role: "user", content: "earlier" }, { role: "assistant", content: [
    { type: "server_tool_use", id: "s9", name: "tool_search_tool_bm25", input: { query: "x" } },
    { type: "tool_search_tool_result", tool_use_id: "s9", content: { type: "tool_search_tool_search_result", tool_references: [] } },
    { type: "text", text: "done" } ] }]);
  try {
    const reply = await runTurn({ conversationId: C, text: "hi", kind: "user", events: { emit() {} }, log: () => {} });
    assert.equal(reply, "fine");
    assert.ok(seen[0].tools.some(t => t.defer_loading));
    assert.ok(!seen[1].tools.some(t => t.defer_loading || t.type));
    assert.equal(seen[1].system.length, 1);
    assert.ok(!JSON.stringify(seen[1].messages).includes("server_tool_use"));
  } finally { model.create = saved; db.saveConversation(C, []); }
});

test("off: every tool loaded, as before; owner: only the owner's thread is on the diet", () => {
  process.env.REASON_TOOL_DIET = "off";
  const v = toolsFor(C);
  assert.deepEqual(diet.apiTools(C, v), { tools: v, note: "" });
  process.env.REASON_TOOL_DIET = "owner";
  assert.ok(diet.apiTools(C, v).tools.some(t => t.defer_loading));
  const vu = toolsFor(U);
  assert.deepEqual(diet.apiTools(U, vu).tools, vu);
});

test("state brings its pack: an organized event, a checkout, a ride, a flight", () => {
  const now = clock.now();
  const V = "dm:+12025550122";
  db.upsertAccount({ conversationId: V, channel: "test", address: "+12025550122", name: "Kofi", isOperator: false });
  assert.deepEqual(diet.statePacks(V), []);
  db.db.prepare(`INSERT INTO uber_rides (conversation_id, quote_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(V, "q-1", "requested", now, now);
  assert.ok(diet.statePacks(V).includes("rides"));
  db.db.prepare(`INSERT INTO shop_runs (run_id, conversation_id, store, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("run-1", V, "ulta.com", "buy", "running", now, now);
  assert.ok(diet.statePacks(V).includes("shopping"));
  db.insertEvent({ organizer: V, name: "Kofi's party", nameKey: "kofis party", description: "", startsAt: now + 86_400_000, tz: "America/New_York", location: "", welcome: "", passwordHash: "x", organizerName: "Kofi" });
  assert.ok(diet.statePacks(V).includes("events_host"));
  const f = db.recordFlight(V, { airline: "Delta", flightNumber: "DL1", departsLocal: "2026-12-01T09:00", timeZone: "America/New_York", departsAt: now + 20 * 86_400_000 });
  assert.notEqual(f?.ok, false, JSON.stringify(f));
  assert.ok(diet.statePacks(V).includes("flights"));
  const v = toolsFor(V);
  const names = diet.computeLoaded(V, v).names;
  for (const n of ["uber_request", "event_blast", "flight_list", "shop_pay"]) if (v.some(t => t.name === n)) assert.ok(names.has(n), `${n} loaded`);
});

test("a connected Apple Calendar brings its pack; nobody else carries it", () => {
  const V = "dm:+12025550177";
  db.upsertAccount({ conversationId: V, channel: "test", address: "+12025550177", name: "Kofi", isOperator: false });
  assert.ok(!diet.statePacks(V).includes("apple_calendar"));
  assert.ok(!diet.CORE_SET.has("apple_calendar_events"));
  db.saveOauthTokens(V, "apple_calendar", { accessToken: "x", accountLabel: "k@icloud.com" });
  assert.ok(diet.statePacks(V).includes("apple_calendar"));
  const loaded = diet.loadedFor(V, toolsFor(V));
  assert.ok(loaded.has("apple_calendar_events"));
});

test("their own recent tools come in, with the pack they belong to", () => {
  diet.recordToolUse(U, "spotify_search");
  const { names, packs } = diet.computeLoaded(U, toolsFor(U));
  assert.ok(packs.includes("spotify"));
  for (const n of diet.PACKS.spotify) if (toolsFor(U).some(t => t.name === n)) assert.ok(names.has(n), n);
});

test("a tool the thread already called stays loaded", () => {
  const messages = [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "flight_search", input: {} }] }];
  assert.ok(diet.computeLoaded(U, toolsFor(U), { messages }).names.has("flight_search"));
});

test("the likely set is capped: a heavy user never drifts back to everything", () => {
  for (const t of tools) diet.recordToolUse(C, t.name);
  const v = toolsFor(C);
  const { names } = diet.computeLoaded(C, v);
  const loadedChars = v.filter(t => names.has(t.name)).reduce((n, t) => n + JSON.stringify({ d: t.description, s: t.input_schema }).length, 0);
  assert.ok(loadedChars < 130_000, `${loadedChars} chars loaded at most`);
  assert.ok(names.size < v.length / 2);
});

test("warm: the set never changes, whatever happens; cold: it is recomputed", () => {
  const v = toolsFor(U);
  const t0 = clock.now();
  const first = diet.loadedFor(U, v, { now: t0 });
  diet.noteModelCall(U, t0);
  // They start using flights mid-burst: the set stands while the cache is warm.
  diet.recordToolUse(U, "flight_search");
  const warm = diet.loadedFor(U, v, { now: t0 + 60_000 });
  assert.deepEqual([...warm].sort(), [...first].sort());
  // Past WARM_MS with no call: the cache is gone, the set may change for free.
  const cold = diet.loadedFor(U, v, { now: t0 + diet.WARM_MS + 1 });
  assert.ok(cold.has("flight_search"));
  assert.ok(!first.has("flight_search"));
});

test("a restart reuses the stored set (the server's cache outlives the process)", () => {
  const v = toolsFor(U);
  diet.recordToolUse(U, "weather");
  const a = diet.loadedFor(U, v);
  const row = db.db.prepare("SELECT names FROM tool_sets WHERE conversation_id = ?").get(U);
  assert.deepEqual(JSON.parse(row.names), [...a].sort());
});

test("runTool counts a call for the likely set", async () => {
  const { runTool } = await import("../src/tools.js");
  await runTool("timer_list", {}, { conversationId: U });
  assert.ok(diet.recentToolUse(U).some(r => r.name === "timer_list"));
});

test("the CLI's tools/list marks the same loaded set always-load", () => {
  const listed = mcpToolsFor(C);
  const flagged = new Set(listed.filter(t => t._meta?.["anthropic/alwaysLoad"]).map(t => t.name));
  const api = diet.apiTools(C, toolsFor(C)).tools.filter(t => !t.defer_loading && !t.type).map(t => t.name);
  assert.deepEqual([...flagged].sort(), api.sort());
  process.env.REASON_TOOL_DIET = "off";
  const old = mcpToolsFor(C).filter(t => t._meta).length;
  assert.ok(old <= 16);
});

test("the real API loop: deferred tools sent, the search's blocks kept, a found tool runs, pause_turn goes on", async () => {
  const saved = model.create;
  const seen = [];
  let round = 0;
  model.create = async (params) => {
    seen.push(params);
    round++;
    if (round === 1) return { stop_reason: "pause_turn", usage: {}, content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "list my timers" } },
    ] };
    if (round === 2) return { stop_reason: "tool_use", usage: {}, content: [
      { type: "tool_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "series_list" }] } },
      { type: "tool_use", id: "toolu_1", name: "series_list", input: {} },
    ] };
    return { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: "no repeating reminders right now" }] };
  };
  try {
    const reply = await runTurn({ conversationId: U, text: "what repeating reminders do i have", kind: "user", events: { emit() {} }, log: () => {} });
    assert.equal(reply, "no repeating reminders right now");
    assert.equal(seen.length, 3);
    const p = seen[0];
    assert.ok(p.tools.some(t => t.type === "tool_search_tool_bm25_20251119"));
    assert.ok(p.tools.find(t => t.name === "series_list")?.defer_loading, "series_list deferred");
    assert.ok(!p.tools.find(t => t.name === "message_send")?.defer_loading, "message_send loaded");
    assert.equal(p.system.length, 2);
    assert.match(p.system[1].text, /series_list/);
    assert.ok(p.system[1].cache_control);
    // The same tools and system on every round of the turn.
    assert.equal(JSON.stringify(seen[2].tools), JSON.stringify(p.tools));
    assert.equal(JSON.stringify(seen[2].system), JSON.stringify(p.system));
    // The paused round went back as it was, and the search result was replayed untouched.
    const msgs = seen[2].messages;
    assert.ok(msgs.some(m => m.role === "assistant" && m.content.some?.(b => b.type === "server_tool_use")));
    assert.ok(msgs.some(m => m.role === "assistant" && m.content.some?.(b => b.type === "tool_search_tool_result")));
    assert.ok(msgs.some(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_result" && b.tool_use_id === "toolu_1")));
  } finally { model.create = saved; }
});

test("a search naming a tool they can no longer see leaves the request; everything else is untouched", () => {
  const visible = [{ name: "weather" }];
  const fine = { role: "assistant", content: [
    { type: "server_tool_use", id: "s1", name: "tool_search_tool_bm25", input: {} },
    { type: "tool_search_tool_result", tool_use_id: "s1", content: { tool_references: [{ type: "tool_reference", tool_name: "weather" }] } },
  ] };
  const stale = { role: "assistant", content: [
    { type: "server_tool_use", id: "s2", name: "tool_search_tool_bm25", input: {} },
    { type: "tool_search_tool_result", tool_use_id: "s2", content: { tool_references: [{ type: "tool_reference", tool_name: "gone_tool" }] } },
    { type: "text", text: "done" },
  ] };
  const out = diet.withoutStaleSearches([fine, stale], visible);
  assert.equal(out[0], fine, "an untouched message is the same object");
  assert.deepEqual(out[1].content, [{ type: "text", text: "done" }]);
  assert.equal(stale.content.length, 3, "the saved thread is not changed");
});

test("a thread's own tools stay loaded even past the cap", () => {
  for (const t of tools) diet.recordToolUse(C, t.name);
  const v = toolsFor(C);
  const big = v.filter(t => !diet.CORE_SET.has(t.name)).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length).slice(0, 12);
  const messages = [{ role: "assistant", content: big.map((t, i) => ({ type: "tool_use", id: `t${i}`, name: t.name, input: {} })) }];
  const { names } = diet.computeLoaded(C, v, { messages });
  for (const t of big) assert.ok(names.has(t.name), t.name);
});
