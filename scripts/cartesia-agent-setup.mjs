#!/usr/bin/env node
// Makes, once, the Cartesia Managed Agent that people's own calls with Reason use when they are on the
// Cartesia voice (src/calls/cartesia.js, docs/calls-cartesia.md section 5). One agent carries every
// account's calls: nothing saved on it may be about one person (each call's own words, names and clock
// come in as that call's dynamic variables). It prints the agent's id for
// REASON_CARTESIA_AGENT_ID in the server's .env. Nothing here is on a call's path.
//
//   node scripts/cartesia-agent-setup.mjs           the plan: what it would make; calls nobody (the default)
//   node scripts/cartesia-agent-setup.mjs --yes     makes the ask_reason client tool and the agent; prints the id
//   options: --voice <voice id> (Gemma, en-GB)  --language <code> (en-GB)  --model <id> (the fastest listed)
//            --keyterms "a,b,c" (extra words the recognizer should favour on EVERY account's calls, besides
//            the per-call ones: product words only, never a person's places or people)
//
//   node scripts/cartesia-agent-setup.mjs --update <agent id> [--voice <id>] [--skip-turn] [--call-feel] [--clear-keyterms]          the plan only
//   node scripts/cartesia-agent-setup.mjs --update <agent id> [--voice <id>] [--skip-turn] [--call-feel] [--clear-keyterms] --yes    PATCHes it
//            --call-feel: `CALL_FEEL` below (the check-in timing and a silent skip_turn that holds check-ins off).
//            --instructions: the saved instructions to INSTRUCTIONS below; --instructions-file <file>: to a saved
//            agent's own (a --save file, or plain text), to put them back.
//   node scripts/cartesia-agent-setup.mjs --show <agent id> [--save <file>]   reads it (no secrets); --save keeps it
//            --clear-keyterms: the saved keyterms back to "Reason" and the per-call slots only, so words
//            given with --keyterms when it was one person's agent are not on everyone's calls.
//            changes only what is named: the voice (e.g. Lucy, en-GB, tagged Emotive) and/or Cartesia's
//            skip_turn tool (stay quiet when their sentence is plainly unfinished, instead of a "Yeah," that
//            gets cut off). A PATCH makes a new agent version; calls already running keep theirs
//            (docs.cartesia.ai/agents/configuration, "Versions"). An earlier version can be restored.
//
// --yes makes two things on the account and spends nothing by itself: an agent costs only when a call
// uses it. Every call it carries is deleted on Cartesia's side when the call ends (DELETE /agents/calls).
// The key is read from CARTESIA_API_KEY (the environment, ./.env or ~/Desktop/pa/.env) and never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

export const VERSION = "2026-08-14";
export const API_BASE = (process.env.CARTESIA_API_BASE || "https://api.cartesia.ai").replace(/\/+$/, "");
/** Gemma (en-GB), the voice the owner chose on the call feel test line. */
export const GEMMA = "62ae83ad-4f6a-430b-af41-a9bede9286ca";
/** Lucy (en-GB), named emotive in Cartesia's "Choosing a Voice" page: the option to hear, never set by default. */
export const LUCY = "2f251ac3-89a9-4a77-a452-704b474ccd01";
/** Cartesia's skip_turn system tool, described for this line (its description field, up to 2000 chars). */
export const SKIP_TURN_DESCRIPTION = "Say nothing this turn, not even a word about skipping. Use it when their words are plainly unfinished: they trailed off mid-sentence (\"and...\", \"so the thing is...\"), stopped on a filler (\"um\", \"so\", \"like\", \"because\") or paused mid-thought, and anything you said would talk over them. Use it too when they ask you to wait (\"give me a second\", \"hold on\", \"one sec\"), and stay quiet until they speak. Never when they asked something or finished a thought.";
/**
 * The agent settings for how a call feels (call 113), as one sparse PATCH (`--call-feel`). Cartesia's
 * names, from docs.cartesia.ai/agents/configuration ("Turn settings") and /agents/system-tools (read
 * 2026-11-13):
 *   turn.inactivity_check_in_secs  8 (their default) made "You still there?" come about 8 s after any
 *     pause of his, four times in call 113. 20 s: a real dead line still gets one check-in.
 *   turn.inactivity_end_call_secs  240, unchanged (the field is required beside the other).
 *   skip_turn.wait_timeout_secs    -1: after a skip ("give me a second", a trailing "um") no check-in at
 *     all until he speaks again; the end-call timer still runs.
 *   skip_turn.pre_tool_speech      off: no words with a skip.
 * Their config has no interruption or end-of-turn sensitivity for a managed agent (only
 * initial_message_interruptions and speculative_generation, which never speaks before the turn ends).
 */
export const CALL_FEEL = {
  turn: { inactivity_check_in_secs: 20, inactivity_end_call_secs: 240 },
  skip_turn: { description: SKIP_TURN_DESCRIPTION, pre_tool_speech: "off", wait_timeout_secs: -1 },
};
export const AGENT_NAME = "Reason (people's own calls)";
/** How many per-call keyterm slots the agent has (filled by `sessionVariables` in src/calls/cartesia.js). */
export const KEYTERM_SLOTS = 8;

/**
 * The agent's saved instructions: a short frame around `{{reason_call}}`, which is, per call, the exact
 * instructions a GPT-Live own call is given (src/calls/gptlive.js `voiceInstructionsFor`: his name, the
 * one identity, the persona, carryover and his brief). Wherever those say "Reason" or "the backend",
 * that is the ask_reason tool here. No second persona is written.
 */
export const INSTRUCTIONS = [
  "{{reason_call}}",
  "",
  "# On this line",
  "Reason's backend is the ask_reason tool. Wherever the lines above say to hand something to Reason or the backend, call ask_reason with what they asked, in full, in their words.",
  "Say Reason's answer in your own voice, briefly, keeping every fact, number and name exactly as it came back. Never add a fact of your own.",
  "Before a lookup, one short line naming exactly what you're getting (\"Checking your Thursday.\"), then call ask_reason. Before an action, the line says you're asking Reason (\"Asking Reason to book that.\"), never that it is happening (\"Booking it.\"). Never \"let me check\" on its own.",
  "Only an ask_reason answer from this call can say something is done, booked, sent or submitted. If they ask whether it is, call ask_reason; never answer that yourself.",
  "Never state a price, time, distance, opening hour or limit that an ask_reason answer in this call did not give you.",
  "If ask_reason says it could not answer, say so plainly and offer to try again.",
  "When something is genuinely funny, you may laugh: write [laughter] where the laugh goes. Never more than one in a reply, and never when they are upset.",
  "When you have both said goodbye, end the call.",
].join("\n");

/** The client tool Reason's brain sits behind. Waited for: a turn of Reason's can take several seconds. */
export function toolBody() {
  return {
    type: "client",
    name: "ask_reason",
    description: "Ask Reason, the backend: their messages, calendar, memory, reminders, tasks, the web, sending things, and anything you cannot answer from what you were told. Use it for every lookup, action or live fact.",
    pre_tool_speech: "auto",
    execution_mode: "immediate",
    expects_response: true,
    response_timeout_secs: 60,
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "What they asked or want done, in full, in their words." } },
      required: ["request"],
    },
  };
}

/** The agent's saved keyterms: "Reason", any shared words, then the per-call slots each call fills with its own. */
export function sharedKeyterms(extra = []) {
  return ["Reason", ...extra, ...Array.from({ length: KEYTERM_SLOTS }, (_, i) => `{{keyterm_${i + 1}}}`)];
}

/** The body of POST /v1/agents. */
export function agentBody({ voice = GEMMA, language = "en-GB", model, toolId, keyterms = [] }) {
  return {
    name: AGENT_NAME,
    description: "People's own calls with Reason, on the Cartesia voice. Reason's brain is the ask_reason client tool. Each call is deleted when it ends. Nothing here is about one person.",
    config: {
      instructions: INSTRUCTIONS,
      initial_message: "{{greeting}}",
      model: { id: model, max_output_tokens: 300 },
      language: { primary: language },
      timezone: process.env.REASON_TZ || "America/New_York",
      audio: {
        input: { noise_suppression: "auto", keyterms: sharedKeyterms(keyterms) },
        output: { voice_id: voice },
      },
      system_tools: { end_call: {}, skip_turn: { ...CALL_FEEL.skip_turn } },
      turn: { ...CALL_FEEL.turn },
      tools: toolId ? [{ id: toolId }] : [],
    },
  };
}

/** The model: the one asked for, else the fastest by Cartesia's own average latency. Throws in words. */
export function pickModel(models, wanted = "") {
  const list = (models ?? []).filter(m => m?.id);
  if (wanted) return list.find(m => m.id === wanted) ?? (() => { throw new Error(`Cartesia does not list a model "${wanted}"`); })();
  const timed = list.filter(m => Number.isFinite(m.average_latency_ms) && m.average_latency_ms > 0).sort((a, b) => a.average_latency_ms - b.average_latency_ms);
  if (!timed.length && !list.length) throw new Error("Cartesia listed no models for this account");
  return timed[0] ?? list[0];
}

/** The key from the environment or a .env file; its value never leaves this function but in the return. */
export function loadKey(name = "CARTESIA_API_KEY", { env = process.env, files = [resolve(".env"), join(homedir(), "Desktop", "pa", ".env")] } = {}) {
  if (String(env[name] ?? "").trim()) return String(env[name]).trim();
  for (const f of files) {
    try { const v = String(parseEnv(readFileSync(f, "utf8"))[name] ?? "").trim(); if (v) return v; } catch { /* no file */ }
  }
  return "";
}

/** One REST call. `{ ok, status, json, error }`; the error in their words, never the key. */
export async function api(key, path, { method = "GET", body = null, fetchImpl = globalThis.fetch } = {}) {
  let r;
  try {
    r = await fetchImpl(API_BASE + path, {
      method,
      headers: { "X-API-Key": key, "Cartesia-Version": VERSION, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, status: 0, json: null, error: `could not reach Cartesia: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }
  const text = await r.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { ok: r.ok, status: r.status, json, error: r.ok ? "" : `${r.status} ${json?.message ?? text.slice(0, 200)}` };
}

/**
 * The body of PATCH /v1/agents/{id}: only what was asked for (an update is sparse: "Omitting the field
 * from an update preserves the agent's current setting", docs.cartesia.ai/agents/configuration).
 */
export function updateBody({ voice = "", skipTurn = false, clearKeyterms = false, callFeel = false, instructions = "" } = {}) {
  const config = {};
  if (instructions) config.instructions = instructions;
  if (voice) config.audio = { output: { voice_id: voice } };
  if (clearKeyterms) config.audio = { ...(config.audio ?? {}), input: { keyterms: sharedKeyterms() } };
  if (skipTurn) config.system_tools = { skip_turn: { description: SKIP_TURN_DESCRIPTION, pre_tool_speech: "off" } };
  if (callFeel) {
    config.system_tools = { skip_turn: { ...CALL_FEEL.skip_turn } };
    config.turn = { ...CALL_FEEL.turn };
  }
  const what = [voice ? `voice ${voice}` : "", clearKeyterms ? "keyterms cleared to Reason and the per-call slots" : "", skipTurn && !callFeel ? "skip_turn on" : "",
    callFeel ? `check-in after ${CALL_FEEL.turn.inactivity_check_in_secs} s (was Cartesia's 8), none after a skip, skip_turn silent` : "",
    instructions ? `instructions (${instructions.length} chars)` : ""].filter(Boolean).join(", ");
  return Object.keys(config).length ? { config, version_description: `Reason: ${what}` } : null;
}

/** The agent as read, with anything secret-shaped taken out (keyterms and ids stay). */
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (/secret|token|password|api_?key|authorization|credential/i.test(k)) continue;
    out[k] = scrub(x);
  }
  return out;
}

/** One line about the agent: its version, voice, tools and a fingerprint of its instructions. */
export function agentSummary(a) {
  const c = a?.config ?? a ?? {};
  const text = String(c.instructions ?? "");
  return {
    id: a?.id ?? null, version: a?.version_id ?? a?.version ?? a?.current_version_id ?? a?.active_version_id ?? null,
    voice: c.audio?.output?.voice_id ?? null, tools: (c.tools ?? []).map(t => t?.id ?? t?.name ?? null),
    system_tools: Object.keys(c.system_tools ?? {}), instructions_chars: text.length,
    instructions_sha256: text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null,
  };
}

export async function main(argv = process.argv.slice(2), { log = console.log, call = api, key = null } = {}) {
  const { values: o } = parseArgs({ args: argv, options: {
    yes: { type: "boolean", default: false }, voice: { type: "string", default: GEMMA }, language: { type: "string", default: "en-GB" },
    model: { type: "string", default: "" }, keyterms: { type: "string", default: "" },
    update: { type: "string", default: "" }, "skip-turn": { type: "boolean", default: false }, "clear-keyterms": { type: "boolean", default: false },
    "call-feel": { type: "boolean", default: false },
    instructions: { type: "boolean", default: false }, "instructions-file": { type: "string", default: "" },
    show: { type: "string", default: "" }, save: { type: "string", default: "" },
  } });
  if (o.show) {
    // Read only: what the agent is now (no key, no secrets), and with --save <file> the whole of it as JSON,
    // so a later --update --instructions-file <file> can put its instructions back.
    const k = key ?? loadKey();
    if (!k) { log("No CARTESIA_API_KEY in the environment, ./.env or ~/Desktop/pa/.env."); return 1; }
    const r = await call(k, `/v1/agents/${encodeURIComponent(o.show)}`);
    if (!r.ok || !r.json) { log(`Could not read the agent: ${r.error || "nothing came back"}`); return 1; }
    const a = scrub(r.json);
    if (o.save) writeFileSync(o.save, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
    log(JSON.stringify(agentSummary(a)));
    return 0;
  }
  if (o.update) {
    let instructions = "";
    if (o["instructions-file"]) {
      const raw = readFileSync(o["instructions-file"], "utf8");
      let saved = null;
      try { saved = JSON.parse(raw); } catch { /* plain text */ }
      instructions = saved ? String(saved?.config?.instructions ?? saved?.instructions ?? "") : raw;
      if (!instructions.trim()) { log(`No instructions in ${o["instructions-file"]}.`); return 1; }
    } else if (o.instructions) instructions = INSTRUCTIONS;
    const body = updateBody({ voice: argv.includes("--voice") ? o.voice : "", skipTurn: o["skip-turn"], clearKeyterms: o["clear-keyterms"], callFeel: o["call-feel"], instructions });
    if (!body) { log("Nothing to change: name --voice <id>, --skip-turn, --call-feel, --clear-keyterms, --instructions and/or --instructions-file <file>."); return 1; }
    log(`The plan: PATCH agent ${o.update}: ${body.version_description.replace(/^Reason: /, "")}. Nothing else on it changes; a new version is made.`);
    if (!o.yes) { log("Nothing was changed. Run again with --yes to change it."); return 0; }
    const k = key ?? loadKey();
    if (!k) { log("No CARTESIA_API_KEY in the environment, ./.env or ~/Desktop/pa/.env."); return 1; }
    const r = await call(k, `/v1/agents/${encodeURIComponent(o.update)}`, { method: "PATCH", body });
    if (!r.ok) { log(`Could not update the agent: ${r.error}`); return 1; }
    log("Updated. New calls use the new version; a call already running keeps the one it started on.");
    return 0;
  }
  const keyterms = o.keyterms.split(",").map(s => s.trim()).filter(Boolean).slice(0, 40);
  log(`The plan: one client tool (ask_reason, waited for up to 60 s) and one agent "${AGENT_NAME}" in voice ${o.voice} (${o.language}), with end_call, keyterms "Reason"${keyterms.length ? ` + ${keyterms.length} shared by every account's calls` : ""} + ${KEYTERM_SLOTS} per-call slots.`);
  log("Its instructions are, per call, the same words a GPT-Live own call gets ({{reason_call}}), and its first line is the call's own opening line ({{greeting}}).");
  if (!o.yes) { log("Nothing was made. Run again with --yes to make them."); return 0; }
  const k = key ?? loadKey();
  if (!k) { log("No CARTESIA_API_KEY in the environment, ./.env or ~/Desktop/pa/.env."); return 1; }
  const models = await call(k, "/v1/agents/models?limit=100");
  if (!models.ok) { log(`Could not read Cartesia's model list: ${models.error}`); return 1; }
  let model;
  try { model = pickModel(models.json?.data, o.model); } catch (e) { log(e.message); return 1; }
  const tool = await call(k, "/v1/agents/tools", { method: "POST", body: toolBody() });
  if (!tool.ok || !tool.json?.id) { log(`Could not make the ask_reason tool: ${tool.error || "no id came back"}`); return 1; }
  const made = await call(k, "/v1/agents", { method: "POST", body: agentBody({ voice: o.voice, language: o.language, model: model.id, toolId: tool.json.id, keyterms }) });
  if (!made.ok || !made.json?.id) { log(`Could not make the agent: ${made.error || "no id came back"} (the tool ${tool.json.id} was made; delete it in the Playground or keep it for a second try).`); return 1; }
  log(`Made. Model ${model.id}. Put this in the server's .env:\nREASON_CARTESIA_AGENT_ID=${made.json.id}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().then((c) => { process.exitCode = c; });
