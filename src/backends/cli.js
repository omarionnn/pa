// Spawning the `claude` CLI. Kept apart from the turn itself so the confirm gate's judge can
// use it too without importing half the codebase.
//
// This runs the official CLI in headless mode against the Claude subscription already logged in
// on this Mac. For a Reason turn it also points the CLI at Reason's own tools, served over
// loopback by the running process (src/backends/mcp-http.js), so the same tools, the same gate
// and the same ledger are exercised. For the judge there are no tools at all — only a verdict.
//
// Owner-local only. See the README section on REASON_BACKEND.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export const cliConfig = {
  bin: process.env.REASON_CLI_BIN || "claude",
  // Opus by default, to match the API path. Sonnet works and is faster, but it is a different
  // model: the gate tests in particular pass on opus and not reliably on sonnet, and a live test
  // that passes on a model Reason does not actually run has proved nothing.
  model: process.env.REASON_CLI_MODEL || "opus",
  maxTurns: Number(process.env.REASON_CLI_MAX_TURNS || 30),
  timeoutMs: Number(process.env.REASON_CLI_TIMEOUT_MS || 300_000),
};

// Claude Code's own tools are not Reason's. They are denied so a turn cannot quietly succeed by
// shelling out or reading a file — if Reason can only do a thing through its own tools, then a
// test of Reason has to be a test of those tools.
const BUILT_INS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch",
  "Task", "TodoWrite", "KillShell", "BashOutput", "SlashCommand", "Skill",
];

/**
 * Run `claude -p` once and return its parsed result envelope. Never throws on a non-zero exit:
 * what the CLI said about why it failed is more useful than a stack trace.
 *
 * With `conversationId`, Reason's MCP server is attached and the turn may use its tools. With
 * `jsonSchema`, the CLI is asked for structured output and given no tools at all.
 */
export function runClaudeCli({ prompt, system, mcpUrl = null, jsonSchema = null, log = () => {} }) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", cliConfig.model,
    "--system-prompt", system,
    "--strict-mcp-config",
    "--permission-mode", "bypassPermissions",
    "--permission-prompts", "none",
    "--disallowedTools", ...BUILT_INS,
    "--max-turns", String(mcpUrl ? cliConfig.maxTurns : 1),
  ];

  // The tools are served over loopback HTTP by the Reason process itself (mcp-http.js), so the
  // browser, the database connection and the ledger stay where the turn is rather than in a
  // child that dies with it.
  if (mcpUrl) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: { reason: { type: "http", url: mcpUrl } } }));
  }
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));

  return new Promise((resolve) => {
    // The subscription login is an OAuth credential, not an API key. An empty ANTHROPIC_API_KEY
    // in the environment (which is how the offline suite runs) would make the CLI try to use it
    // and fail, so it is removed rather than blanked.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;

    let child;
    try {
      child = spawn(cliConfig.bin, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: `could not run '${cliConfig.bin}': ${e.message}` });
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, cliConfig.timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `could not run '${cliConfig.bin}': ${e.message}`, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, error: `the CLI did not finish inside ${cliConfig.timeoutMs}ms`, stderr });
      let envelope = null;
      try { envelope = JSON.parse(stdout); } catch { /* reported below */ }
      if (!envelope) {
        return resolve({ ok: false, error: `the CLI returned no JSON (exit ${code}): ${(stderr || stdout).slice(0, 400)}`, stderr });
      }
      log({ cli: { stop: envelope.stop_reason, turns: envelope.num_turns, denials: envelope.permission_denials?.length ?? 0, cost: envelope.total_cost_usd } });
      // Debugging a turn that went nowhere means seeing what the CLI said about it, and a test
      // runner swallows stdout. REASON_CLI_DEBUG names a file to append the whole envelope to.
      if (process.env.REASON_CLI_DEBUG) {
        try {
          appendFileSync(process.env.REASON_CLI_DEBUG,
            JSON.stringify({ at: new Date().toISOString(), envelope, stderr: stderr.slice(-2000) }) + "\n");
        } catch { /* a debug log is never worth failing a turn over */ }
      }
      resolve({ ok: !envelope.is_error, envelope, stderr });
    });
  });
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["yes", "no", "change", "unclear"] },
    note: { type: "string" },
  },
  required: ["verdict"],
  additionalProperties: false,
};

const WATCH_SCHEMA = {
  type: "object",
  properties: { met: { type: "boolean" }, why: { type: "string" } },
  required: ["met", "why"],
  additionalProperties: false,
};

/** Structured output from one no-tools CLI call, or null if anything at all went wrong. */
async function structured({ prompt, system, schema }) {
  const r = await runClaudeCli({ prompt, system, jsonSchema: schema });
  if (!r.ok) return { error: r.error ?? "the CLI reported an error" };
  try { return { value: JSON.parse(String(r.envelope.result ?? "")) }; }
  catch { return { error: `the answer was not JSON: ${String(r.envelope.result ?? "").slice(0, 120)}` }; }
}

/**
 * The confirm gate's reader, run through the CLI instead of the API. Same contract as
 * `judgeReply` in src/judge.js, including the one that matters: it never guesses upward. A
 * crash, a timeout or an answer off the schema all come back 'unclear', which authorizes nothing.
 */
export async function judgeViaCli({ summary, reply, instructions }) {
  const { value, error } = await structured({
    prompt: `The action, exactly as the assistant described it:\n${summary}\n\nThe owner's reply, verbatim:\n${reply}`,
    system: instructions,
    schema: VERDICT_SCHEMA,
  });
  if (error) return { verdict: "unclear", error };
  if (!["yes", "no", "change", "unclear"].includes(value?.verdict)) {
    return { verdict: "unclear", error: `the judge returned ${JSON.stringify(value?.verdict ?? null)}` };
  }
  const note = typeof value.note === "string" ? value.note.trim().slice(0, 200) : "";
  return { verdict: value.verdict, note: value.verdict === "change" ? note : "" };
}

/**
 * The watcher's eye, same deal. Fails closed the same way src/watch.js does: anything other than
 * a clean `met: true` is not a hit, so a watch never fires on a shrug.
 */
export async function checkWatchViaCli({ lookingFor, text, previousText, instructions }) {
  const before = previousText == null
    ? "This is the first check, so there is nothing to compare against."
    : `What the page said at the last check:\n${String(previousText).slice(0, 4000)}`;
  const { value, error } = await structured({
    prompt: `What they are waiting for:\n${lookingFor}\n\nThe page as it reads now:\n${String(text ?? "").slice(0, 8000)}\n\n${before}`,
    system: instructions,
    schema: WATCH_SCHEMA,
  });
  if (error) return { met: false, why: "the page could not be checked this time", error };
  if (typeof value?.met !== "boolean") return { met: false, why: "the check returned nothing usable", error: "off-schema" };
  return { met: value.met, why: String(value.why ?? "").trim().slice(0, 300) };
}
