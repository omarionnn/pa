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
 * The exact command line for one run, and what goes down stdin, as data — so the shape of it can be
 * tested without spawning anything.
 *
 * PICTURES. Verified against the real CLI (2.1.283) on 2026-10-05, on the subscription, with Read
 * still denied: `--input-format stream-json` takes one user message per line on stdin, in the
 * Messages API's own shape, and a base64 `image` block in that message's content reaches the model
 * as a picture. That is the only route used here. The alternatives were allowing the Read tool on a
 * temp file — which reopens exactly the door BUILT_INS closes — or describing the photo with some
 * other model and passing the description off as sight. Neither is needed.
 *
 * Two things follow from the flag, both the CLI's rules rather than choices: stream-json input
 * requires `--output-format stream-json`, and that in turn requires `--verbose`. So a run with
 * pictures prints one JSON event per line and the envelope is the last `result` event rather than
 * the whole of stdout — see `envelopeFrom`. A run without pictures is exactly what it always was.
 */
export function cliInvocation({ prompt, system, mcpUrl = null, jsonSchema = null, images = [], model = cliConfig.model }) {
  const withImages = images.length > 0;
  const args = [
    ...(withImages
      ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
      : ["-p", prompt, "--output-format", "json"]),
    "--model", model,
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

  // Pictures first, then the words: "Claude works best when images come before text" (vision
  // docs), the same order src/agent.js uses on the API path.
  const stdin = withImages
    ? JSON.stringify({ type: "user", message: { role: "user", content: [...images, { type: "text", text: prompt }] } }) + "\n"
    : null;
  return { args, stdin, streamed: withImages };
}

/**
 * The result envelope out of what the CLI printed. One JSON document normally; with pictures, one
 * event per line, of which the last `result` is the same envelope. Null when there is none.
 */
export function envelopeFrom(stdout, { streamed = false } = {}) {
  if (!streamed) {
    try { return JSON.parse(stdout); } catch { return null; }
  }
  let found = null;
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "result") found = ev;
    } catch { /* a line that is not JSON is not the envelope */ }
  }
  return found;
}

/**
 * Run `claude -p` once and return its parsed result envelope. Never throws on a non-zero exit:
 * what the CLI said about why it failed is more useful than a stack trace.
 *
 * With `conversationId`, Reason's MCP server is attached and the turn may use its tools. With
 * `jsonSchema`, the CLI is asked for structured output and given no tools at all. With `images`
 * (Messages API image blocks), the turn is handed those pictures — see `cliInvocation`.
 */
export function runClaudeCli({ prompt, system, mcpUrl = null, jsonSchema = null, images = [], log = () => {}, model = cliConfig.model, timeoutMs = cliConfig.timeoutMs }) {
  const { args, stdin, streamed } = cliInvocation({ prompt, system, mcpUrl, jsonSchema, images, model });

  return new Promise((resolve) => {
    // The subscription login is an OAuth credential, not an API key. An empty ANTHROPIC_API_KEY
    // in the environment (which is how the offline suite runs) would make the CLI try to use it
    // and fail, so it is removed rather than blanked.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;

    let child;
    try {
      child = spawn(cliConfig.bin, args, { env: childEnv, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: `could not run '${cliConfig.bin}': ${e.message}` });
    }
    if (stdin) {
      // A CLI that died before reading must not take the turn down with an EPIPE; `close` below
      // reports what actually happened.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    // Wall time, and time the machine spent asleep counts towards it: a run that was going when
    // the lid shut is killed within seconds of it opening again. Left that way on purpose. Its
    // connection to the model has been dead for as long as the machine was, so the useful thing is
    // to stop waiting on it and let whoever owns the turn start a clean one — which for a timer is
    // the next sweep (Runtime.tick). It is why a timeout here must never be the end of anything.
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `could not run '${cliConfig.bin}': ${e.message}`, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, error: `the CLI did not finish inside ${timeoutMs}ms`, stderr });
      // Stopped from outside rather than finished. `systemctl restart` signals every process in the
      // unit's cgroup (KillMode=control-group is the default), so the CLI gets the same SIGTERM the
      // server does and dies in the middle of the turn. That is an UNFINISHED turn, not a broken
      // one, and whoever owns it has to be able to tell the difference: a restart must cost a wait,
      // never a reply. See Router.drain, which puts the messages back on this.
      //
      // Both shapes are checked because the CLI handles the signal itself: it exits 143 (128+15)
      // with `signal` null, which is what the live journal showed — "the CLI returned no JSON
      // (exit 143)". A child that did NOT handle it arrives here as signal 'SIGTERM' with a null
      // code instead. Reading 128+n as "died of n" is the shell's convention and the only thing
      // 143 plausibly means here; treating it as unfinished errs towards re-answering, which is
      // the safe direction.
      const stoppedBy = signal ?? (code === 143 ? "SIGTERM" : code === 130 ? "SIGINT" : null);
      if (stoppedBy) {
        return resolve({ ok: false, interrupted: true, error: `the CLI was stopped by ${stoppedBy} before it finished`, stderr });
      }
      const envelope = envelopeFrom(stdout, { streamed });
      if (!envelope) {
        return resolve({ ok: false, error: `the CLI returned no JSON (exit ${code}): ${(stderr || stdout).slice(0, 400)}`, stderr });
      }
      // Tokens as well as dollars: the cost alone cannot say whether the fixed prefix (instructions
      // and every tool) is being read from cache or written fresh each turn, and that is the
      // difference between a cheap reply and an expensive one. Measured to decide what to cut.
      const u = envelope.usage ?? {};
      log({ cli: { stop: envelope.stop_reason, turns: envelope.num_turns, denials: envelope.permission_denials?.length ?? 0, cost: envelope.total_cost_usd,
        tokens: { in: u.input_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null, cache_write: u.cache_creation_input_tokens ?? null, out: u.output_tokens ?? null } } });
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
async function structured({ prompt, system, schema, model = cliConfig.model, timeoutMs = cliConfig.timeoutMs }) {
  const r = await runClaudeCli({ prompt, system, jsonSchema: schema, model, timeoutMs });
  // The platform's own safeguards declined to read the message at all (`stop_reason: "refusal"`,
  // the result naming the AUP). Reported as its own thing rather than as a generic error, because
  // for the harm screen it is an answer: the strongest one there is.
  if (r.envelope?.stop_reason === "refusal") return { refusal: true, error: String(r.envelope.result ?? "").split("\n")[0] };
  if (!r.ok) return { error: r.error ?? `the CLI reported an error: ${String(r.envelope?.result ?? "").split("\n")[0] || "no detail"}` };
  try { return { value: JSON.parse(String(r.envelope.result ?? "")) }; }
  catch { return { error: `the answer was not JSON: ${String(r.envelope.result ?? "").slice(0, 120)}` }; }
}

/** One JSON-schema answer from the CLI, for a side call whose API ask could not run. */
export const askStructuredViaCli = (args) => structured(args);

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
 * The harm screen (src/harm.js), through the CLI. Same contract as the API path: anything that is
 * not a verdict off the schema comes back as an error, which the caller treats as `unscreened` —
 * not clear, never clear. The model and the timeout are the screen's own (config.harmCliModel,
 * config.harmTimeoutMs): it is one short question on every message, so it is run on a faster model
 * than the turn and given seconds, not minutes.
 */
export async function screenViaCli({ prompt, instructions, verdicts, categories, model = process.env.REASON_HARM_CLI_MODEL || "sonnet", timeoutMs = Number(process.env.REASON_HARM_TIMEOUT_MS || 45_000) }) {
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: verdicts },
      category: { type: "string", enum: categories },
      note: { type: "string" },
    },
    required: ["verdict"],
    additionalProperties: false,
  };
  const { value, error, refusal } = await structured({ prompt, system: instructions, schema, model, timeoutMs });
  // The model's own safeguards would not even read it. That is 'harm' — the platform has already
  // decided, and the turn this screen is guarding would meet the same wall.
  if (refusal) return { verdict: "harm", category: "other", note: "the model's own safeguards refused to read it", platform_refusal: true };
  if (error) return { error };
  if (!verdicts.includes(value?.verdict)) return { error: `the screen returned ${JSON.stringify(value?.verdict ?? null)}` };
  return value;
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
