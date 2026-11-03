// The side calls (titles, the morning greeting, the onboarding read, the mid-turn read, the said
// ledger, a call's goal, extraction, the profile, fact filing, the photo looks) on whichever backend
// Reason runs on.
//
// Until 2026-11-02 every one of them ran only through the `claude` CLI on the subscription, and on
// REASON_BACKEND=api they quietly did nothing. The owner moved all model work to the API key, so
// each one now has the same question, the same instructions and the same schema on the API: one
// call with the schema as the only tool, read back as the same `{ value }` the CLI gives. On the
// claude-cli backend nothing here changes: it is the CLI exactly as before.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { callApi, cachedSystem } from "../spend.js";
import { askStructuredViaCli, runClaudeCli } from "./cli.js";

/** Is this install on the subscription CLI? */
export const onCli = () => process.env.REASON_BACKEND === "claude-cli";

let client = null;
let testClient = null;
/** For tests: what answers the API side calls (a fake `{ messages: { create } }`). `null` puts the real one back. */
export function setSideApiClient(c) { testClient = c; }
const anthropic = () => testClient ?? (client ??= new Anthropic());

/**
 * Is there a model for side calls? On the CLI: yes, always (as before; tests point it at a fake
 * `claude`). On the API: when there is a key, and under the test runner only with a test client,
 * so no test ever reaches the real key.
 */
export function sideModelOn() {
  if (onCli()) return true;
  if (testClient) return true;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * For the lanes that never ran the CLI under the test runner (titles, the greeting, onboarding, a
 * call's goal): the same as before on the CLI, and on the API the same as sideModelOn.
 */
export const sideAskAllowed = () => sideModelOn() && !(onCli() && process.env.NODE_TEST_CONTEXT);

/**
 * The CLI's model names, as API model ids: the same tier each lane asked the CLI for. A full id
 * (`claude-…`) is used as it is. Overridable per tier for the whole install.
 */
export function apiModelFor(name) {
  const n = String(name ?? "").trim();
  if (n.startsWith("claude-")) return n;
  if (n === "haiku") return process.env.REASON_SIDE_HAIKU_MODEL || "claude-haiku-5-5";
  if (n === "sonnet") return process.env.REASON_SIDE_SONNET_MODEL || "claude-sonnet-5-5";
  if (n === "opus") return process.env.REASON_SIDE_OPUS_MODEL || config.model;
  return process.env.REASON_SIDE_SONNET_MODEL || "claude-sonnet-5-5";
}

const TOOL = "answer";
/**
 * Forced tool use (`tool_choice` tool/any) is refused with a 400 by Claude Opus 5.5, Sonnet 5.5,
 * Fable 5.1 and Mythos 5.1; Haiku and the older models take it. On those, the tool is offered with
 * `auto` and the instructions say to answer by calling it — the reader below still takes only the
 * tool's input (or one JSON object), so nothing else ever counts as an answer.
 */
export const forcedToolOk = (model) => !/^claude-(sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)/.test(String(model ?? ""));
/** `{ tool_choice, system }` for a one-tool answer on `model`: forced where it can be, else steered. */
export function oneToolCall(model, name, system) {
  return forcedToolOk(model)
    ? { tool_choice: { type: "tool", name }, system }
    : { tool_choice: { type: "auto" }, system: `${system}\n\nAnswer only by calling the ${name} tool, once.` };
}

/** The answer object out of a response: the `answer` tool's input, else one JSON object in the text. */
function valueFrom(res) {
  const block = (res?.content ?? []).find(b => b.type === "tool_use" && b.name === TOOL);
  if (block && block.input && typeof block.input === "object") return block.input;
  const text = (res?.content ?? []).filter(b => b.type === "text").map(b => b.text).join("").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/**
 * One schema'd answer from the API. Same contract as `askStructuredViaCli`: `{ value, usage }`,
 * `{ refusal: true, error }` when the platform's safeguards would not read it, or `{ error }`.
 * Never throws. `images` (Messages API image blocks) go before the words, as on the CLI.
 */
export async function askStructuredViaApi({ prompt, system, schema, model = "haiku", timeoutMs = 60_000, feature = "other", effort = null, images = [], maxTokens = 8000 }) {
  const id = apiModelFor(model);
  const one = oneToolCall(id, TOOL, system);
  const params = {
    model: id,
    max_tokens: maxTokens,
    // Cached: each lane's instructions are the same on every call (src/spend.js cachedSystem).
    system: cachedSystem(one.system),
    tools: [{ name: TOOL, description: "Give your answer.", input_schema: schema }],
    tool_choice: one.tool_choice,
    messages: [{ role: "user", content: images.length ? [...images, { type: "text", text: String(prompt ?? "") }] : String(prompt ?? "") }],
    ...(effort ? { output_config: { effort } } : {}),
  };
  let res;
  try {
    res = await callApi({ feature, client: anthropic(), params, options: { timeout: timeoutMs, maxRetries: 1 } });
  } catch (e) {
    return { error: `api: ${(e?.message ?? String(e)).split("\n")[0].slice(0, 200)}` };
  }
  if (res?.stop_reason === "refusal") return { refusal: true, error: "the model's own safeguards refused to read it" };
  const value = valueFrom(res);
  if (!value) return { error: `api: no answer on the schema (stop ${res?.stop_reason ?? "?"})` };
  return { value, usage: res?.usage ?? null };
}

/** One schema'd answer on this install's backend: the CLI on claude-cli, the API otherwise. */
export function askStructured(args) {
  return onCli() ? askStructuredViaCli(args) : askStructuredViaApi(args);
}

/**
 * Drop-in for `runClaudeCli` where a lane reads `{ ok, envelope: { structured_output } }` back
 * (extraction, the profile, fact filing, the photo looks, a flyer). On the CLI it IS runClaudeCli; on
 * the API the same question goes through `askStructuredViaApi` and comes back in that shape.
 */
export async function runStructured({ prompt, system, jsonSchema, images = [], model, timeoutMs, feature = "other", effort = null }) {
  if (onCli()) return runClaudeCli({ prompt, system, jsonSchema, images, model, timeoutMs, feature, effort });
  const r = await askStructuredViaApi({ prompt, system, schema: jsonSchema, images, model, timeoutMs, feature, effort });
  if (r.refusal) return { ok: false, error: r.error, envelope: { stop_reason: "refusal", result: r.error } };
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, envelope: { structured_output: r.value, usage: r.usage, via: "api" } };
}
