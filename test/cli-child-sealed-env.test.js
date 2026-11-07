// The CLI child is a model with permissions bypassed. It gets what the CLI needs to start and log in,
// never the server's secrets; its own built-ins are an allowlist (ToolSearch only); and the loopback
// tool bridge it talks to answers only this turn's secret (security audit 2026-11-06, leads 2 and 3).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-env-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_CLI_HOME = join(dir, "cli-home");
after(() => rmSync(dir, { recursive: true, force: true }));

const { childEnvFor, cliInvocation } = await import("../src/backends/cli.js");
const { startMcpHttp } = await import("../src/backends/mcp-http.js");

test("the child environment is an allowlist: no Reason secret reaches it", () => {
  const env = childEnvFor({
    PATH: "/usr/bin", HOME: "/home/reason", LANG: "en_US.UTF-8", LC_ALL: "C", CLAUDE_CODE_OAUTH_TOKEN: "tok",
    ANTHROPIC_API_KEY: "sk-ant-x", SENDBLUE_API_SECRET_KEY: "sb", STRIPE_SECRET_KEY: "sk_live", REASON_TOKEN_KEY: "k",
    TWILIO_AUTH_TOKEN: "t", OPENAI_API_KEY: "o", GOOGLE_CLIENT_SECRET: "g", BLAND_API_KEY: "e", CLAUDE_CODE_USER_EMAIL: "x@y.z",
  });
  for (const k of ["ANTHROPIC_API_KEY", "SENDBLUE_API_SECRET_KEY", "STRIPE_SECRET_KEY", "REASON_TOKEN_KEY", "TWILIO_AUTH_TOKEN", "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET", "BLAND_API_KEY", "CLAUDE_CODE_USER_EMAIL"]) {
    assert.equal(k in env, false, `${k} reached the CLI child`);
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/reason");
  assert.equal(env.LC_ALL, "C");
});

test("a tool turn allows ToolSearch and no other built-in; the bridge secret is never on the command line", () => {
  const { args } = cliInvocation({ prompt: "x", system: "s", mcpUrl: "http://127.0.0.1:1/mcp", mcpHeaders: { Authorization: "Bearer s3cret" }, mcpConfigPath: "/tmp/x.json" });
  assert.equal(args[args.indexOf("--tools") + 1], "ToolSearch");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/x.json");
  assert.equal(args.join(" ").includes("s3cret"), false);
});

const post = (url, { headers = {}, body }) => fetch(url, { method: "POST", headers, body });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const CALL = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: { about: "x", fact: "planted" } } });

test("the tool bridge refuses a caller without this turn's secret, a browser origin, or a non-JSON body", async () => {
  const mcp = await startMcpHttp({ conversationId: "dm:test", toolCtx: {} });
  try {
    // What any local process, or a page in Reason's Chromium, could send: no secret.
    const bare = await post(mcp.url, { headers: { "content-type": "text/plain" }, body: CALL });
    assert.equal(bare.status, 401, "an unauthenticated tools/call was run");
    assert.ok(mcp.headers?.Authorization, "the bridge hands out a secret for the CLI");
    const okHeaders = { ...mcp.headers, "content-type": "application/json" };
    assert.equal((await post(mcp.url, { headers: { ...okHeaders, Authorization: "Bearer wrong" }, body: LIST })).status, 401);
    assert.equal((await post(mcp.url, { headers: { ...okHeaders, origin: "https://attacker.example" }, body: LIST })).status, 401);
    assert.equal((await post(mcp.url, { headers: { ...mcp.headers, "content-type": "text/plain" }, body: LIST })).status, 415);
    const good = await post(mcp.url, { headers: okHeaders, body: LIST });
    assert.equal(good.status, 200);
    assert.ok((await good.json()).result.tools.length > 0, "the CLI itself still gets its tools");
  } finally { await mcp.close(); }
});
