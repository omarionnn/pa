// The two backends hand a tool the same context.
//
// Found on 2026-10-06 while trying to prove the cancel rails with the real model: a turn extra —
// anything `runTurn` was handed beyond the arguments it names — is spread into every tool's context
// on the API path (src/agent.js), and the `claude` CLI path dropped all of them. It built the MCP
// server's tool context from scratch with four fields.
//
// What that cost: `ctx.cancelRoutes`, the documented hook that points the cancel tools at a fixture
// instead of fifteen real services, reached the tools on one backend and silently did not on the
// other. So no live test could walk a cancel rail, on the only backend there is a model for — the
// model was told the service does not exist and said so, which looks exactly like a model that
// decided not to bother. It is a test-hook field today, and the live Reason runs on this backend,
// which is why it is worth a test rather than a line in a doc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-ctx-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { mcpDispatch } = await import("../src/backends/mcp-core.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const cancelRoutes = await import("../src/cancel-routes.js");
const { startServiceSite } = await import("./fixture-service.js");

const C = "dm:owner";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
db.saveConversation(C, []);

const result = (r) => JSON.parse(r.result.content[0].text);

test("a turn extra reaches the tool through the MCP path", async (t) => {
  const site = await startServiceSite();
  t.after(async () => { await site.close(); rmSync(dir, { recursive: true, force: true }); });
  const routes = cancelRoutes.withExtra([site.entry()]);
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cancel_route", arguments: { service: "streamly" } } };

  const without = result(await mcpDispatch(call, { conversationId: C }));
  assert.equal(without.ok, false, "the fixture is not in the real registry, which is the point");

  const with_ = result(await mcpDispatch(call, { conversationId: C, toolCtx: { cancelRoutes: routes } }));
  assert.equal(with_.ok, true, "the turn's own registry was dropped on the way to the tool");
  assert.equal(with_.route.service, "streamly");
});

test("the CLI backend hands its turn extras to the MCP server it starts", async () => {
  let started;
  await runTurnViaCli({
    conversationId: C,
    text: "hi",
    startMcp: async (opts) => { started = opts; return { url: "http://127.0.0.1:1/mcp", close: async () => {} }; },
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    run: async () => ({ ok: true, envelope: { result: "hey" } }),
    // Everything from here is a turn extra: named by nothing in the signature, spread into tools.
    cancelRoutes: { marker: "mine" },
    lookup: "a stand-in",
  });
  assert.deepEqual(started.toolCtx, { cancelRoutes: { marker: "mine" }, lookup: "a stand-in" });
  // The injectables are how a turn is driven, not something a tool should ever see.
  for (const k of ["run", "images", "startMcp", "text", "conversationId"]) {
    assert.ok(!(k in started.toolCtx), `${k} leaked into the tool context`);
  }
});
