// The dozen-odd tools the model is handed whole, so a tool turn skips the deferred-tool lookup.
//
// Speed audit 2026-10-27: Claude Code defers Reason's ~290 tools and the model spent a 2.3 s round on
// `ToolSearch` before its first real call on 43 of 58 tool-using turns. The most-used tools carry
// `_meta["anthropic/alwaysLoad"]`; everything else is still deferred, because loading all of them
// would put ~107k tokens of schema into every call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-mcp-always-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { MCP_TOOLS, ALWAYS_LOAD, mcpToolsFor, mcpDispatch } = await import("../src/backends/mcp-core.js");

const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

test("the most-used tools are marked always-load and nothing else is", () => {
  const flagged = MCP_TOOLS.filter(t => t._meta?.["anthropic/alwaysLoad"] === true).map(t => t.name).sort();
  assert.deepEqual(flagged, [...ALWAYS_LOAD].sort());
  for (const name of ["web_search", "web_lookup", "gmail_search", "task_update", "timer_set", "remember", "recall", "message_send"]) {
    assert.ok(ALWAYS_LOAD.has(name), `${name} is one of the common tools`);
  }
  // Every always-load name is a real tool: a typo here would silently load nothing.
  const names = new Set(MCP_TOOLS.map(t => t.name));
  for (const name of ALWAYS_LOAD) assert.ok(names.has(name), `${name} exists`);
  // Never all of them, and never close to it.
  assert.ok(flagged.length <= 16, `${flagged.length} always-load tools`);
  assert.ok(MCP_TOOLS.length > 100 && flagged.length < MCP_TOOLS.length / 10, "the rest stay deferred");
  // Loading them whole must stay cheap: ~35k chars of schema (≈9k tokens, cached) is the budget.
  const chars = MCP_TOOLS.filter(t => t._meta).reduce((n, t) => n + JSON.stringify({ d: t.description, s: t.inputSchema }).length, 0);
  assert.ok(chars < 45_000, `${chars} chars of always-load schema`);
  // A tool that is not flagged carries no _meta at all, so the list the CLI reads is unchanged for it.
  const pageCreate = MCP_TOOLS.find(t => t.name === "page_create");
  assert.ok(pageCreate, "page_create exists");
  assert.equal(pageCreate._meta, undefined);
});

test("tools/list for a conversation carries the flag through", async () => {
  const listed = mcpToolsFor(C);
  assert.equal(listed.find(t => t.name === "web_search")?._meta?.["anthropic/alwaysLoad"], true);
  const r = await mcpDispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { conversationId: C });
  assert.equal(r.result.tools.find(t => t.name === "remember")?._meta?.["anthropic/alwaysLoad"], true);
  const research = r.result.tools.find(t => t.name === "research");
  assert.ok(research, "research exists");
  assert.equal(research._meta, undefined);
});
