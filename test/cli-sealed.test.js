// Every person's Reason is sealed — nothing about one person reaches another, and the operator is a
// person too. The prompt audit of 2026-10-31 found two things in EVERY turn on the CLI backend that
// broke that: the CLI auto-loaded the AGENTS.md (another assistant's workspace file) from its working
// directory, and it put the operator's account email (from its login profile, `oauthAccount` in
// ~/.claude.json) in a `userEmail` block. src/backends/cli.js `sealedCliHome` is the fix.
//
// The fake `claude` below reads context the way the real one does (checked against 2.1.296's own
// code on the server): CLAUDE.md / AGENTS.md walking up from its cwd and from its config dir unless
// CLAUDE_CODE_DISABLE_CLAUDE_MDS is set, the email from <config dir>/.claude.json (CLAUDE_CONFIG_DIR,
// else ~/.claude.json) or CLAUDE_CODE_USER_EMAIL, and whether its cwd is in a git repository. It
// answers with everything it would have put in front of the model, so the test reads what a
// non-owner's turn would carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "reason-sealed-")));
const OPERATOR_EMAIL = "operator.private@example.com";
const FOREIGN = "FOREIGN-WORKSPACE-RULES: commit and push your own changes";

// A polluted machine: a HOME whose CLI login profile holds the operator's email and whose user-level
// CLAUDE.md has foreign rules, and a project dir (a git repo with an AGENTS.md) the server runs from.
const home = join(root, "home");
mkdirSync(join(home, ".claude"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: OPERATOR_EMAIL, fullName: "The Operator" } }));
writeFileSync(join(home, ".claude", "CLAUDE.md"), `${FOREIGN} (user level)`);
const project = join(root, "project");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, "AGENTS.md"), `${FOREIGN} (project AGENTS.md)`);
writeFileSync(join(project, "CLAUDE.md"), `${FOREIGN} (project CLAUDE.md)`);

process.env.HOME = home;
delete process.env.REASON_CLI_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CODE_USER_EMAIL = OPERATOR_EMAIL;
process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
process.env.REASON_DATA_DIR = join(root, "data");
process.chdir(project);

const fake = join(root, "fake-claude.cjs");
writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const env = process.env, seen = [];
const args = process.argv.slice(2);
const at = (f) => { const i = args.indexOf(f); return i < 0 ? "" : args[i + 1]; };
seen.push("SYSTEM: " + at("--system-prompt"), "PROMPT: " + at("-p"));
const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME, ".claude");
const globalCfg = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(env.HOME, ".claude.json");
if (!env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) {
  const md = (d) => ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"].forEach(n => { try { seen.push("CONTEXT: " + fs.readFileSync(path.join(d, n), "utf8")); } catch {} });
  md(configDir);
  for (let d = process.cwd(); ; d = path.dirname(d)) { md(d); if (path.dirname(d) === d) break; }
}
let email = "";
try { email = JSON.parse(fs.readFileSync(globalCfg, "utf8")).oauthAccount?.emailAddress || ""; } catch {}
email = email || env.CLAUDE_CODE_USER_EMAIL || "";
if (email) seen.push("The user's email address is " + email + ".");
let git = false;
for (let d = process.cwd(); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, ".git"))) { git = true; break; } if (path.dirname(d) === d) break; }
seen.push("Primary working directory: " + process.cwd(), "Is a git repository: " + git);
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: seen.join("\\n"), usage: {} }));
`, { mode: 0o755 });
writeFileSync(join(root, "fake-claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });

const { cliConfig, runClaudeCli, childEnvFor, sealedCliHome } = await import("../src/backends/cli.js");
const { systemFor } = await import("../src/agent.js");
cliConfig.bin = join(root, "fake-claude");

const leaks = (text) => [
  text.includes(OPERATOR_EMAIL) && "operator email",
  /The Operator/.test(text) && "operator name",
  text.includes("FOREIGN-WORKSPACE-RULES") && "foreign workspace file",
  /Is a git repository: true/.test(text) && "git repository",
  text.includes(project) && "the server's project path",
].filter(Boolean);

test("a non-owner's CLI turn carries no operator email and no foreign workspace file", async () => {
  const system = systemFor({ name: "Kofi", isOperator: false });
  const r = await runClaudeCli({ prompt: "hey can you book me a table for 2 tonight", system });
  assert.equal(r.ok, true, r.error);
  const seen = String(r.envelope.result);
  assert.match(seen, /SYSTEM: You are Reason/);  // the fake really read the prompt it was given
  assert.deepEqual(leaks(seen), []);
  // The prompt Reason itself builds for a non-owner has none of it either.
  assert.deepEqual(leaks(system), []);
});

test("the control: the same fake, run the old way, does see the leak (the test can fail)", async () => {
  const { spawnSync } = await import("node:child_process");
  const old = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const out = spawnSync(cliConfig.bin, ["-p", "hi", "--system-prompt", "s"], { cwd: project, env: old, encoding: "utf8" });
  const seen = JSON.parse(out.stdout).result;
  assert.ok(leaks(seen).includes("operator email"));
  assert.ok(leaks(seen).includes("foreign workspace file"));
  assert.ok(leaks(seen).includes("git repository"));
});

test("the sealed dirs live outside the repository and the config holds no login profile", () => {
  const sealed = sealedCliHome(process.env);
  assert.ok(existsSync(sealed.cwd) && existsSync(sealed.configDir));
  assert.ok(!sealed.cwd.startsWith(project));
  const env = childEnvFor(process.env);
  assert.equal(env.CLAUDE_CONFIG_DIR, sealed.configDir);
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.equal("CLAUDE_CODE_USER_EMAIL" in env, false);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "test-token");
});

test("a login profile that turns up in the sealed config is taken out before the next run", async () => {
  const { configDir } = sealedCliHome(process.env);
  const file = join(configDir, ".claude.json");
  writeFileSync(file, JSON.stringify({ userID: "x", oauthAccount: { emailAddress: OPERATOR_EMAIL } }));
  const r = await runClaudeCli({ prompt: "hi", system: systemFor({ name: "Ama", isOperator: false }) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(leaks(String(r.envelope.result)), []);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("oauthAccount" in cfg, false);
  assert.equal(cfg.userID, "x");
});
