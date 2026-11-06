#!/usr/bin/env node
// What a NON-OWNER's CLI turn really puts in front of the model, read off the wire, with no model
// and no message to anyone: the real `claude` binary, started by Reason's own runClaudeCli (so the
// sealed cwd / config dir / env of src/backends/cli.js), pointed with ANTHROPIC_BASE_URL at a
// loopback stand-in that records the request and answers "ok". Nothing reaches Anthropic, nothing
// is billed, no subscription limit is spent.
//
//   cd /opt/reason && sudo -u reason -H node --env-file-if-exists=.env \
//     .agents/skills/verify-reason/bin/cli-seal-probe.mjs [--unsealed] [--operator-email-from=<file>]
//
// It checks the request for: any email address, the operator's own email (read from the CLI login
// profile, ~/.claude.json oauthAccount, never printed), AGENTS.md / CLAUDE.md / OpenClaw text, "Is a
// git repository: true", and the repo's own path. `--unsealed` is the control: the same CLI run the
// old way (cwd = here, no sealed env), which must show the leak, so a clean result means something.
// Exit 0 = sealed run clean (or, with --unsealed, the leak reproduced); 1 otherwise.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const unsealed = process.argv.includes("--unsealed");
const repo = resolve(process.cwd());
process.env.REASON_DATA_DIR = mkdtempSync(join(tmpdir(), "seal-probe-data-"));
delete process.env.ANTHROPIC_API_KEY;

let operatorEmail = "";
try { operatorEmail = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).oauthAccount?.emailAddress ?? ""; } catch {}

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

const { systemFor } = await import(join(repo, "src/agent.js"));
const cli = await import(join(repo, "src/backends/cli.js"));
const system = systemFor({ name: "Probe", isOperator: false });
const prompt = "[probe] hey, what can you do?";

let run;
if (unsealed) {
  run = await new Promise((done) => {
    const { args } = cli.cliInvocation({ prompt, system });
    const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    const c = spawn(cli.cliConfig.bin, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", (code) => done({ ok: code === 0, out }));
  });
} else {
  run = await cli.runClaudeCli({ prompt, system, model: "opus", feature: "other" });
}
server.close();

const text = bodies.join("\n");
const emails = new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []);
// The repo's own workspace files (AGENTS.md and friends): a long line out of each, looked for verbatim.
const workspaceLines = ["AGENTS.md", "CLAUDE.md", "SOUL.md", "USER.md", "IDENTITY.md"].flatMap((f) => {
  try { return readFileSync(join(repo, f), "utf8").split("\n").filter((l) => l.trim().length > 40).slice(0, 3).map((l) => JSON.stringify(l.trim()).slice(1, -1)); } catch { return []; }
});
const found = {
  requests: bodies.length,
  any_email: emails.size,
  operator_email: operatorEmail ? text.includes(operatorEmail) : "no login profile to compare",
  user_email_block: /user.s email address is/i.test(text),
  agents_or_claude_md: /AGENTS\.md|CLAUDE\.md|OpenClaw|HEARTBEAT/.test(text) || workspaceLines.some((l) => text.includes(l)),
  git_repository_true: /Is a git repository: true/.test(text),
  repo_path: text.includes(repo),
  working_dir: (text.match(/Primary working directory: ([^\\\n"]+)/) ?? [])[1] ?? null,
};
console.log(JSON.stringify({ mode: unsealed ? "unsealed (control)" : "sealed", run_ok: !!run.ok, ...found }, null, 2));
const leaked = found.any_email > 0 || found.operator_email === true || found.user_email_block || found.agents_or_claude_md || found.git_repository_true || found.repo_path;
if (!bodies.length) { console.log("no request reached the stand-in: nothing proven"); process.exit(1); }
process.exit(unsealed ? (leaked ? 0 : 1) : (leaked ? 1 : 0));
