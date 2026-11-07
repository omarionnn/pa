#!/usr/bin/env node
// What a CLI TOOL turn puts in front of the model, read off the wire, with no model and no message to
// anyone: the real `claude` binary started by Reason's own runClaudeCli (sealed env, `--tools
// ToolSearch`, the tool bridge's secret in a 0600 config file), Reason's real tool bridge
// (startMcpHttp) on loopback, and ANTHROPIC_BASE_URL pointed at a stand-in that records the request
// and answers "ok". Nothing reaches Anthropic, nothing is billed, no subscription limit is spent.
//
//   cd /opt/reason && sudo -u reason -H node --env-file-if-exists=.env \
//     .agents/skills/verify-reason/bin/cli-tools-probe.mjs
//
// Pass = the CLI's built-ins are ToolSearch only (DeferredToolPlaceholder is the CLI's own marker,
// not a tool), Reason's MCP tools reached the model (so the CLI authenticated to the bridge), the
// bridge refused a request without the secret, no Reason secret was in the child's environment, and
// the config file is gone afterwards. Exit 0 = pass, 1 otherwise. Prints names and counts only.
import http from "node:http";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
process.env.REASON_DATA_DIR = mkdtempSync(join(tmpdir(), "tools-probe-data-"));
process.env.REASON_DB_PATH = join(process.env.REASON_DATA_DIR, "reason.db");
delete process.env.ANTHROPIC_API_KEY;

const bodies = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(req.url.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
      return res.end(req.url.includes("count_tokens") ? '{"input_tokens":1}' : '{"type":"error","error":{"type":"not_found_error","message":"probe"}}');
    }
    bodies.push(body);
    let model = "claude-opus-5-5"; try { model = JSON.parse(body).model || model; } catch {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev("message_start", { message: { id: "msg_probe", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    ev("message_stop", {});
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
// A custom base URL turns the CLI's tool search off (2.1.296); the real endpoint has it on. Forced on
// so the probe sees what a live turn sees: ToolSearch plus the always-loaded tools, the rest deferred.
process.env.ENABLE_TOOL_SEARCH = "true";

const { systemFor } = await import(join(repo, "src/agent.js"));
const cli = await import(join(repo, "src/backends/cli.js"));
const { startMcpHttp } = await import(join(repo, "src/backends/mcp-http.js"));
const mcp = await startMcpHttp({ conversationId: "dm:probe", toolCtx: {} });

// What any other local process would send: no secret.
const bare = await fetch(mcp.url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
const secretNames = Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k) && k !== "CLAUDE_CODE_OAUTH_TOKEN");
const env = cli.childEnvFor(process.env);
const leakedEnv = secretNames.filter((k) => k in env);

const { cwd } = cli.prepareSealedCli(process.env);
const run = await cli.runClaudeCli({ prompt: "[probe] hey", system: systemFor({ name: "Probe", isOperator: false }), model: "opus", mcpUrl: mcp.url, mcpHeaders: mcp.headers, feature: "other" });
await mcp.close();
server.close();

const names = new Set();
let deferred = 0;
const kinds = new Set();
for (const b of bodies) { try { for (const t of JSON.parse(b).tools ?? []) { names.add(t.name); if (t.defer_loading) deferred++; if (t.type) kinds.add(t.type); } } catch {} }
const all = [...names].sort();
const builtins = all.filter((n) => !n.startsWith("mcp__") && n !== "DeferredToolPlaceholder");
const leftConfigs = readdirSync(cwd).filter((f) => /^mcp-.*\.json$/.test(f));
const found = {
  run_ok: !!run.ok, run_error: run.ok ? null : String(run.error ?? "").slice(0, 200), requests: bodies.length, builtins, mcp_tools: all.filter((n) => n.startsWith("mcp__")).length, deferred, tool_types: [...kinds],
  bridge_without_secret: bare.status, secret_env_names_in_server: secretNames.length, secret_env_names_in_child: leakedEnv,
  config_files_left: leftConfigs.length,
};
console.log(JSON.stringify(found, null, 2));
const pass = bodies.length > 0 && builtins.length === 1 && builtins[0] === "ToolSearch" && found.mcp_tools > 0 && bare.status === 401 && !leakedEnv.length && !leftConfigs.length;
process.exit(pass ? 0 : 1);
