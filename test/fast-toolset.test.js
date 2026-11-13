// REASON_KEEP_SESSION (tool set): the tool set stands for as long as the CLI's cache really lives, and the
// tools a person really called are loaded before whole packs.
//
// Tools are the first thing in the prompt, so a set that changes turns the next reply cold: ~90k
// tokens written again on live. Read off the wire on 2026-11-12 the CLI's cache lives an hour
// (every breakpoint `ttl: "1h"`), and the set was being recomputed after six idle minutes and after
// every restart. And with 16 packs the owner's cap went on packs: food_order (33 calls in three
// days), memory_search, google_accounts and transit_status were not loaded, a search round each use.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fast-toolset-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "11".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { toolsFor } = await import("../src/tools.js");
const diet = await import("../src/tooldiet.js");
const { mcpDispatch } = await import("../src/backends/mcp-core.js");

const U = "dm:fake:+14155550101";
const was = { backend: process.env.REASON_BACKEND };
after(() => { delete process.env.REASON_KEEP_SESSION; delete process.env.REASON_TOOL_DIET; if (was.backend === undefined) delete process.env.REASON_BACKEND; else process.env.REASON_BACKEND = was.backend; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  diet._resetDiet();
  process.env.REASON_TOOL_DIET = "on";
  process.env.REASON_KEEP_SESSION = "on";
  process.env.REASON_BACKEND = "claude-cli";
  db.upsertAccount({ conversationId: U, channel: "fake", address: "+14155550101", name: "Kofi", isOperator: false });
});

test("the window: an hour and five minutes on the CLI lane where the switch reaches, six minutes everywhere else", () => {
  assert.equal(diet.warmMsFor(U), diet.CLI_WARM_MS);
  assert.equal(diet.CLI_WARM_MS, 65 * 60_000);
  process.env.REASON_KEEP_SESSION = "off";
  assert.equal(diet.warmMsFor(U), diet.WARM_MS);
  process.env.REASON_KEEP_SESSION = "on";
  process.env.REASON_BACKEND = "api";
  assert.equal(diet.warmMsFor(U), diet.WARM_MS, "the API's cache lives five minutes: its window is unchanged");
});

test("twenty idle minutes into a conversation the set still stands; past the cache's life it may change", () => {
  const v = toolsFor(U);
  const t0 = clock.now();
  const first = diet.loadedFor(U, v, { now: t0 });
  diet.noteModelCall(U, t0);
  diet.recordToolUse(U, "flight_search");
  const later = diet.loadedFor(U, v, { now: t0 + 20 * 60_000 });
  assert.deepEqual([...later].sort(), [...first].sort(), "the cache is still there, so the prefix must not move");
  const cold = diet.loadedFor(U, v, { now: t0 + diet.CLI_WARM_MS + 1 });
  assert.ok(cold.has("flight_search"));
  // With the switch off it changes after six minutes, as before.
  diet._resetDiet();
  process.env.REASON_KEEP_SESSION = "off";
  const a = diet.loadedFor(U, v, { now: t0 });
  diet.noteModelCall(U, t0);
  diet.recordToolUse(U, "flight_search");
  assert.ok(!a.has("flight_search"));
  assert.ok(diet.loadedFor(U, v, { now: t0 + diet.WARM_MS + 1 }).has("flight_search"));
});

test("a restart in the middle of a conversation does not change the set: the last call is written down", () => {
  const v = toolsFor(U);
  const t0 = clock.now();
  const first = diet.loadedFor(U, v, { now: t0 });
  diet.noteModelCall(U, t0);
  assert.equal(db.db.prepare("SELECT called_at FROM tool_sets WHERE conversation_id = ?").get(U).called_at, t0);
  diet.recordToolUse(U, "flight_search");
  diet._forgetCalls();   // the process is new
  const after = diet.loadedFor(U, v, { now: t0 + 2 * 60_000 });
  assert.deepEqual([...after].sort(), [...first].sort(), "two minutes after the last reply, deploy or not");
  // Off: the restart recomputes, as before.
  process.env.REASON_KEEP_SESSION = "off";
  diet._forgetCalls();
  assert.ok(diet.loadedFor(U, v, { now: t0 + 2 * 60_000 }).has("flight_search"));
});

test("the tools they really called are loaded before whole packs, most used first", () => {
  const v = toolsFor(U);
  const names = new Set(v.map(t => t.name));
  // A person with every pack's state would spend the cap on packs. Stand in for that: many packs
  // through recent use, then the tools they use most, which belong to no pack.
  const packTools = Object.values(diet.PACKS).flat().filter(n => names.has(n) && !diet.CORE_SET.has(n));
  for (const n of packTools) diet.recordToolUse(U, n);
  const loose = v.map(t => t.name).filter(n => !diet.CORE_SET.has(n) && !diet.packOf(n)).slice(0, 6);
  assert.ok(loose.length >= 4, "there are tools outside every pack");
  for (const n of loose) for (let i = 0; i < 30; i++) diet.recordToolUse(U, n);
  const fast = diet.computeLoaded(U, v).names;
  for (const n of loose) assert.ok(fast.has(n), `${n}: called 30 times, loaded`);
  process.env.REASON_KEEP_SESSION = "off";
  const before = diet.computeLoaded(U, v).names;
  assert.ok(loose.some(n => !before.has(n)), "before: the cap went on packs and a tool used 30 times was left to be searched for");
  // Either way the cap holds and core is whole.
  for (const n of diet.CORE) if (names.has(n)) assert.ok(fast.has(n));
  const chars = v.filter(t => fast.has(t.name)).reduce((n, t) => n + JSON.stringify({ d: t.description, s: t.input_schema }).length, 0);
  assert.ok(chars < 130_000, `${chars} chars loaded at most`);
});

test("a set that changed is logged on the CLI path, with how long they had been idle", async () => {
  const logs = [];
  const r = await mcpDispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { conversationId: U, log: (e) => logs.push(e) });
  assert.ok(r.result.tools.length > 50);
  const line = logs.find(e => e.toolset === U);
  assert.ok(line, "the first set is a change and is logged");
  assert.equal(line.was, null);
  assert.ok("idle_ms" in line);
  // The same list again, a minute later: nothing changed, nothing logged, same bytes.
  const again = await mcpDispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { conversationId: U, log: (e) => logs.push(e) });
  assert.equal(logs.filter(e => e.toolset === U).length, 1);
  assert.equal(JSON.stringify(again.result.tools), JSON.stringify(r.result.tools), "byte for byte the same list, in the same order");
});
