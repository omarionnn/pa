// What a CLI child is started with, for a side call and for a turn (speed audit 2026-10-27, items 3–4).
//
// A run with no MCP server — the harm screen, the said check, extraction, the judge, a photo note,
// a call turn — has no tools to call, so it runs with `--tools ""` and Claude Code's 12.7k-token
// built-in tool prefix stays out of its prompt. A turn WITH Reason's tools never gets that flag: it
// would remove `ToolSearch` and with it the deferral that keeps ~107k tokens of schema out of every
// call. Every child also has the CLI's non-essential traffic (update check, telemetry) switched off.
import { test } from "node:test";
import assert from "node:assert/strict";

const { cliInvocation, childEnvFor } = await import("../src/backends/cli.js");

const toolsFlag = (args) => {
  const i = args.indexOf("--tools");
  return i < 0 ? null : args[i + 1];
};

test("a run with no MCP server is given no tools at all", () => {
  const plain = cliInvocation({ prompt: "is this fine?", system: "s" });
  assert.equal(toolsFlag(plain.args), "");
  const schemad = cliInvocation({ prompt: "q", system: "s", jsonSchema: { type: "object" } });
  assert.equal(toolsFlag(schemad.args), "");
  const pictured = cliInvocation({ prompt: "q", system: "s", images: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] });
  assert.equal(toolsFlag(pictured.args), "");
  const warm = cliInvocation({ system: "s", jsonSchema: { type: "object" }, streamIn: true, effort: "low" });
  assert.equal(toolsFlag(warm.args), "");
  // The built-ins stay denied as well: belt and braces, and the list is what the photo test pins.
  assert.ok(plain.args.includes("--disallowedTools"));
  assert.equal(plain.args[plain.args.indexOf("--max-turns") + 1], "1");
});

test("a turn with Reason's tools is never given --tools: that would undo tool deferral", () => {
  const turn = cliInvocation({ prompt: "what's on today", system: "s", mcpUrl: "http://127.0.0.1:9/mcp" });
  assert.equal(toolsFlag(turn.args), null);
  assert.ok(turn.args.includes("--mcp-config"));
  const drafted = cliInvocation({ prompt: "hi", system: "s", mcpUrl: "http://127.0.0.1:9/mcp", partial: true });
  assert.equal(toolsFlag(drafted.args), null);
});

test("every CLI child runs with non-essential traffic off and no empty API key", () => {
  const env = childEnvFor({ PATH: "/bin", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok");
  assert.equal(env.PATH, "/bin");
  // The caller's environment is not written to.
  const mine = { A: "1" };
  childEnvFor(mine);
  assert.deepEqual(mine, { A: "1" });
});
