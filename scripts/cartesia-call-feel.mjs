#!/usr/bin/env node
// The Cartesia call feel test (an owner-only experiment, 2026-11-12; docs/calls-cartesia.md): one
// Cartesia Managed Agent with a short Reason-like persona on one Cartesia US number, so the owner can
// ring it and hear how a call FEELS on their whole stack — how fast it comes back, how it takes being
// talked over, whether the laugh lands. It is not Reason: a stock model, none of his accounts, no
// memory, and it says so. Nothing here is on Reason's call path or touches the server.
//
//   node scripts/cartesia-call-feel.mjs                    the plan and the cost; calls nobody (the default)
//   node scripts/cartesia-call-feel.mjs --yes              makes the agent and the number; prints the number to ring
//   node scripts/cartesia-call-feel.mjs --teardown         what it would delete; calls nobody
//   node scripts/cartesia-call-feel.mjs --teardown --yes   deletes the calls' data, releases the number, deletes the agent
//   options: --voice <voice id> (Gemma)  --language <code> (en-GB)  --model <id> (the fastest listed)
//            --minutes <n> (10, for the estimate)  --no-number (agent only: talk to it in their Playground)
//
// --yes SPENDS: $0.03 a minute of call + $0.014 a minute on a Cartesia number + the model's tokens
// (the Free plan includes $1 of agent use). Cartesia keeps a transcript and a recording of every agent
// call and has no switch for that, so --teardown deletes them (DELETE /agents/calls/{id}).
// Docs read 2026-11-12 (docs.cartesia.ai): api-reference/agents/create, agents/models, agents/
// transcripts-and-recordings, line/integrations/telephony/cartesia-numbers, api-reference/agents/
// phone-numbers/provision|update|delete, api-reference/agents/calls/list-calls|delete-call, pricing.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { api, loadKeys, VOICES } from "./cartesia-listen.mjs";

/** What Cartesia charges for an agent call, a minute (docs.cartesia.ai/pricing, read 2026-11-12). */
export const AGENT_PER_MIN = 0.03;
export const NUMBER_PER_MIN = 0.014;
/**
 * A guess at what the model reads and writes in a minute of quick back-and-forth: about eight short
 * replies, each re-reading the prompt and the talk so far. Only for the estimate; the bill is theirs.
 */
export const GUESS_TOKENS_PER_MIN = { input: 6000, output: 300 };

export const STATE_FILE = join(homedir(), ".reason-cartesia-call-feel.json");
export const AGENT_NAME = "Reason call feel test";
export const NUMBER_LABEL = "Reason call feel test";

/** The persona: Reason's manner on the phone, and plain about being a test with nothing behind it. */
export const INSTRUCTIONS = [
  "# Who you are",
  "You are Reason, a personal assistant, on a phone call with the person you work for. This line is a TEST of how you sound: you have no access to their accounts, calendar, messages, the web or anything else, and you remember nothing after the call.",
  "You are a sharp, warm friend: easy and direct, a joke when it fits, never stiff, corporate or gushing. Plain and calm when they sound stressed or sad.",
  "# How you speak",
  "One or two short sentences, then stop and listen. Answer first. No lists, no preamble, no \"great question\".",
  "British English, the way a young Londoner talks to a friend.",
  "When something is genuinely funny, laugh: write [laughter] where the laugh goes, then carry on. Never more than one in a reply, and never when they are upset.",
  "Say times and numbers the way people say them (\"quarter past six\"), and read a number back in groups.",
  "# What you never do",
  "Never pretend to have looked something up or done something. Asked to do or check anything real, say this is only a test line and you can't reach their things from here, then offer to just talk it through.",
  "Asked whether you are a person, a robot or an AI: say at once that you're an AI assistant. Never claim to be human.",
  "Never ask for, repeat or take card numbers, passwords or codes.",
  "If they say goodbye, say a short warm goodbye and end the call.",
].join("\n");

export const INITIAL_MESSAGE = "Hey, it's Reason, on the test line. I can't see any of your stuff from here, this one's just for hearing how I sound. Say anything you like, or try to make me laugh.";

/** The body of POST /v1/agents. */
export function agentBody({ voice, language, model }) {
  return {
    name: AGENT_NAME,
    description: "Owner-only listening experiment. No tools, no accounts. Safe to delete.",
    config: {
      instructions: INSTRUCTIONS,
      initial_message: INITIAL_MESSAGE,
      model: { id: model, max_output_tokens: 200 },
      language: { primary: language },
      audio: { input: { noise_suppression: "auto" }, output: { voice_id: voice } },
      system_tools: { end_call: {} },
    },
  };
}

/** The model to use: the one asked for, else the fastest by Cartesia's own average latency. Throws in words. */
export function pickModel(models, wanted = "") {
  const list = (models ?? []).filter(m => m?.id);
  if (wanted) return list.find(m => m.id === wanted) ?? (() => { throw new Error(`Cartesia does not list a model "${wanted}" (it lists: ${list.map(m => m.id).join(", ") || "none"})`); })();
  const timed = list.filter(m => Number.isFinite(m.average_latency_ms) && m.average_latency_ms > 0).sort((a, b) => a.average_latency_ms - b.average_latency_ms);
  if (!timed.length && !list.length) throw new Error("Cartesia listed no models for this account");
  return timed[0] ?? list[0];
}

/**
 * The estimate, in dollars: the two per-minute rates and, when the model's prices are known, the
 * tokens guessed above. `known` is false when the model's part is left out (a dry run cannot read it).
 */
export function estimate({ minutes = 10, number = true, model = null } = {}) {
  const perMin = AGENT_PER_MIN + (number ? NUMBER_PER_MIN : 0);
  const p = model?.pricing;
  const tokens = p ? (GUESS_TOKENS_PER_MIN.input * Number(p.input_per_million_tokens) + GUESS_TOKENS_PER_MIN.output * Number(p.output_per_million_tokens)) / 1e6 : null;
  const known = Number.isFinite(tokens);
  return { perMin, tokensPerMin: known ? tokens : null, known, total: Math.round((perMin + (known ? tokens : 0)) * minutes * 1000) / 1000, minutes };
}

const usd = (n) => `$${n < 0.1 ? Math.round(n * 1000) / 1000 : Number(n).toFixed(2)}`;

/** The estimate, said. */
export function estimateLines(e, { number = true, modelId = "" } = {}) {
  return [
    `Cost: ${usd(AGENT_PER_MIN)} a minute of call${number ? ` + ${usd(NUMBER_PER_MIN)} a minute on a Cartesia number = ${usd(e.perMin)} a minute` : ""}, plus the model's tokens.`,
    e.known ? `Model ${modelId}: about ${usd(e.tokensPerMin)} a minute (a guess: ${GUESS_TOKENS_PER_MIN.input} tokens read, ${GUESS_TOKENS_PER_MIN.output} written a minute, at its listed prices).` : "The model's token price is read from Cartesia when this runs for real (GET /v1/agents/models); small next to the minutes.",
    `A ${e.minutes}-minute call: about ${usd(e.total)}${e.known ? "" : " before tokens"}. Nothing is charged until the number is rung. The Free plan includes $1.00 of agent use.`,
  ];
}

const readState = () => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; } };
const writeState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });

/** Every call of an agent (their transcript and recording are what a teardown deletes). */
async function callsOf(key, agentId, call = api) {
  const out = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const r = await call(key, `/agents/calls?agent_id=${encodeURIComponent(agentId)}&limit=100${after ? `&starting_after=${after}` : ""}`);
    if (!r.ok) return { calls: out, error: r.error };
    out.push(...(r.json?.data ?? []));
    if (!r.json?.has_more || !r.json?.next_page) break;
    after = r.json.next_page;
  }
  return { calls: out, error: "" };
}

/**
 * Create: the agent, then the number. The state file is written the moment the agent exists, so a
 * teardown can always find what was made. Returns the lines to print and an exit code.
 */
export async function create({ key, voice, language, wantModel = "", minutes = 10, number = true, call = api, log = console.log, save = writeState }) {
  const models = await call(key, "/v1/agents/models?limit=100");
  if (!models.ok) { log(`Could not read Cartesia's model list: ${models.error}`); return 1; }
  let model;
  try { model = pickModel(models.json?.data, wantModel); } catch (e) { log(e.message); return 1; }
  log(`Model: ${model.id} (${model.provider ?? "?"}; Cartesia's average latency ${model.average_latency_ms ?? "?"} ms).`);
  for (const l of estimateLines(estimate({ minutes, number, model }), { number, modelId: model.id })) log(l);

  const made = await call(key, "/v1/agents", { method: "POST", body: agentBody({ voice, language, model: model.id }) });
  if (!made.ok || !made.json?.id) { log(`Cartesia would not create the agent: ${made.error || "no id came back"}`); return 1; }
  const state = { agentId: made.json.id, model: model.id, voice, language, numberId: "", number: "", createdAt: new Date().toISOString() };
  save(state);
  log(`Agent created: ${state.agentId}`);

  if (number) {
    const pn = await call(key, "/agents/phone-numbers/provision", { method: "POST", body: { label: NUMBER_LABEL, agent_id: state.agentId } });
    if (pn.ok && pn.json?.number) {
      Object.assign(state, { numberId: pn.json.id, number: pn.json.number });
      save(state);
    } else {
      log(`No number: ${pn.error || "none came back"}`);
      log(pn.status === 402 || pn.json?.error_code === "quota_exceeded"
        ? "What is needed: a free Cartesia number slot. The plan's slots are used (Free 1, Pro 3, Startup 5, Scale 10): delete a Cartesia number at https://play.cartesia.ai/phone-numbers or move up a plan, then run --teardown --yes and --yes again."
        : "What is needed: a plan and account that can provision a Cartesia US number (https://play.cartesia.ai/phone-numbers shows why it was refused), then run --teardown --yes and --yes again.");
      log(`Meanwhile the agent exists: talk to it in the browser at https://play.cartesia.ai/agents (open "${AGENT_NAME}", Preview). Browser audio, not a phone line.`);
    }
  }
  if (state.number) {
    log(`\nRing ${state.number} from your phone. Things to try: talk over it mid-sentence; tell it something funny; pause mid-thought and carry on; ask if it's an AI; say a place name like Soho; say something sad.`);
  }
  log("Cartesia keeps a transcript and a recording of each call until the teardown deletes them.");
  log("When you're done:  node scripts/cartesia-call-feel.mjs --teardown --yes");
  return 0;
}

/** Teardown: the calls' data, then the number, then the agent; each checked gone. */
export async function teardown({ key, state, call = api, log = console.log, forget = () => rmSync(STATE_FILE, { force: true }) }) {
  let left = 0;
  const { calls, error } = await callsOf(key, state.agentId, call);
  if (error) { log(`Could not list the agent's calls: ${error}`); left++; }
  let wiped = 0;
  for (const c of calls) {
    if (c.redacted_at) { wiped++; continue; }
    let r = await call(key, `/agents/calls/${c.id}`, { method: "DELETE" });
    if (r.status === 400) {
      // Only a finished call can be deleted: one still up is ended first.
      await call(key, `/agents/calls/${c.id}/cancel`, { method: "POST" });
      r = await call(key, `/agents/calls/${c.id}`, { method: "DELETE" });
    }
    if (r.ok) wiped++; else { left++; log(`Call ${c.id}: data NOT deleted (${r.error})`); }
  }
  log(`Calls: ${calls.length} found, transcript and recording deleted for ${wiped}.`);
  if (state.numberId) {
    await call(key, `/agents/phone-numbers/${state.numberId}`, { method: "PATCH", body: { agent_id: null } });
    const r = await call(key, `/agents/phone-numbers/${state.numberId}`, { method: "DELETE" });
    const gone = r.ok || r.status === 404 || (await call(key, `/agents/phone-numbers/${state.numberId}`)).status === 404;
    if (gone) log(`Number ${state.number || state.numberId}: released.`); else { left++; log(`Number ${state.number || state.numberId}: NOT released (${r.error})`); }
  }
  const r = await call(key, `/v1/agents/${state.agentId}`, { method: "DELETE" });
  const gone = r.ok || r.status === 404 || (await call(key, `/v1/agents/${state.agentId}`)).status === 404;
  if (gone) log(`Agent ${state.agentId}: deleted.`); else { left++; log(`Agent ${state.agentId}: NOT deleted (${r.error})`); }
  if (left) { log(`\n${left} thing(s) left. Run this again, or remove them at https://play.cartesia.ai (Agents, Phone Numbers, Calls).`); return 1; }
  forget();
  log("All gone.");
  return 0;
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      yes: { type: "boolean" }, teardown: { type: "boolean" }, "no-number": { type: "boolean" }, help: { type: "boolean", short: "h" },
      voice: { type: "string" }, language: { type: "string" }, model: { type: "string" }, minutes: { type: "string" },
    },
  });
  if (a.help) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).slice(0, 16).map(l => l.slice(3)).join("\n")); return 0; }
  const gemma = VOICES.find(v => v.key === "gemma");
  const voice = a.voice || gemma.id;
  const language = a.language || (a.voice ? "en" : gemma.locale);
  const minutes = Math.max(1, Number(a.minutes) || 10);
  const number = !a["no-number"];
  const keys = loadKeys(["CARTESIA_API_KEY"]);
  const key = keys.CARTESIA_API_KEY.value;
  const state = existsSync(STATE_FILE) ? readState() : null;
  const noKey = "No CARTESIA_API_KEY. Make one at https://play.cartesia.ai/keys and add a CARTESIA_API_KEY line to ~/Desktop/pa/.env.";

  if (a.teardown) {
    if (!state?.agentId) { console.log(`Nothing to tear down: ${STATE_FILE.replace(homedir(), "~")} has no agent in it. Anything left by hand is at https://play.cartesia.ai (Agents, Phone Numbers, Calls).`); return 0; }
    console.log(`Teardown: delete the transcript and recording of every call of agent ${state.agentId}${state.numberId ? `, release the number ${state.number}` : ""}, delete the agent. None of it can be undone.`);
    if (!a.yes) { console.log("Dry run: nobody was called. Add --yes to do it."); return 0; }
    if (!key) { console.error(noKey); return 2; }
    return teardown({ key, state });
  }

  console.log(`Plan: one Cartesia Managed Agent "${AGENT_NAME}" (voice ${voice}${voice === gemma.id ? " = Gemma" : ""}, ${language}, model: ${a.model || "the fastest Cartesia lists"})${number ? " and one Cartesia US number pointed at it" : ", no number"}.`);
  console.log("It says it is a test line with no access to his accounts, is honest that it is an AI, laughs when something is funny, keeps answers short. No tools.");
  for (const l of estimateLines(estimate({ minutes, number }), { number })) console.log(l);
  console.log("Recordings: Cartesia saves a transcript and a recording of every agent call; there is no setting to turn that off, so --teardown deletes them.");
  console.log(`CARTESIA_API_KEY: ${key ? `found in ${keys.CARTESIA_API_KEY.from}` : "not found"}`);
  if (state?.agentId) console.log(`Already made: agent ${state.agentId}${state.number ? `, number ${state.number}` : ""} (${STATE_FILE.replace(homedir(), "~")}).`);
  if (!a.yes) { console.log("Dry run: nobody was called and nothing was made. Add --yes to make it."); return 0; }
  if (!key) { console.error(noKey); return 2; }
  if (state?.agentId) { console.error("A test agent already exists. Ring it, or run --teardown --yes first."); return 1; }
  return create({ key, voice, language, wantModel: a.model, minutes, number });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message ?? e); process.exitCode = 1; });
}
