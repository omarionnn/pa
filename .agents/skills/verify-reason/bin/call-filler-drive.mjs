#!/usr/bin/env node
// Replay stored owner calls through the REAL call turn (`llmRequest` in src/calls/voice.js) with a fake
// model seam, and count what the caller would have heard: fillers, apologies, presence checks, the
// same filler twice on a call, and the silence before the first word of each turn. No model, no
// ElevenLabs, no Sendblue, no phone: the model is a script that waits each turn's RECORDED latency
// (journal `voice_turn` first_word_ms / turn_ms / rounds) and then says the model's own words from the
// stored transcript (the code's canned lines stripped out, since the code under test adds its own).
//
// Inputs are private and never committed: a JSON export of the calls (id, is_owner, transcript) and
// the journal's voice_turn lines. Run under the cage's env against a throwaway database, once per
// checkout you want to compare (REASON_FILLER_ROOT = that checkout; default: this one):
//
//   eval "$(bin/caged.sh env | sed 's/^/export /')" && REASON_DB_PATH=$(mktemp -d)/filler.db \
//     REASON_FILLER_CALLS=/tmp/x/calls.json REASON_FILLER_JOURNAL=/tmp/x/journal.txt \
//     node bin/call-filler-drive.mjs > /tmp/x/after.json
//
// Prints one JSON object: totals and per-call counts. Counts only — no transcript text.
process.env.REASON_CONVERSATION ||= "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025550100";
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_UNDO_SECONDS = "0";
const { resolve, dirname } = await import("node:path");
const { existsSync, realpathSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { pathToFileURL } = await import("node:url");
{
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  process.env.REASON_RECORDING_ROOT ||= dirname(db) + "/recordings";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
if (!process.env.REASON_FILLER_CALLS || !process.env.REASON_FILLER_JOURNAL) {
  console.error("set REASON_FILLER_CALLS (calls JSON) and REASON_FILLER_JOURNAL (journal voice_turn lines)");
  process.exit(2);
}

const root = process.env.REASON_FILLER_ROOT
  ? pathToFileURL(resolve(process.env.REASON_FILLER_ROOT) + "/")
  : new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const voice = await imp("src/calls/voice.js");
const db = await imp("src/db.js");
const { EXTRA_BODY_KEYS } = await imp("src/calls/elevenlabs.js");
const { countCall, addCounts, ZERO, gapStats, transcriptLines } = await import("./call-filler-count.mjs");

const CONV = process.env.REASON_CONVERSATION;
// The code's canned lines in THIS checkout, so a line the code adds is counted as filler whatever its
// words (a new "Mm-hm." would slip past the phrase rules otherwise).
const M = voice.METER_KINDS ?? {};
const CODE_LINES = new Set([M.holdingLine, ...(M.holdingLines ?? []), ...(M.fillers ?? []), ...(M.fallbacks ?? [])]
  .filter(Boolean).map(x => String(x).trim()).filter(x => x.length > 3));
const SECRET = "filler-drive-secret";
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
// Round 2 after a tool: how long the model takes to its first word once the result is in. The journal
// has the whole turn, not the split; 1.5 s is the owner no-tool first-word p50 rounded down.
const ROUND_TWO_MS = 1_500;

// The code's own canned lines, as they appear in the stored transcripts: the model never said these.
const CANNED = [
  /One sec\.\.\.\s*/g, /Sorry — something broke on my end\. Say that again\?\s*/g, /Sorry, something broke on my end there\.\s*/g,
  /Mm-hm, one moment\.\s*/g, /Still working on it\.\s*/g, /\s*Sorry — bear with me one moment\.\s*/g,
];
const modelWords = (line) => CANNED.reduce((s, re) => s.replace(re, ""), String(line)).trim();

const calls = JSON.parse(readFileSync(process.env.REASON_FILLER_CALLS, "utf8"));
const turns = new Map();
for (const l of readFileSync(process.env.REASON_FILLER_JOURNAL, "utf8").split("\n")) {
  const i = l.indexOf("{");
  if (i < 0) continue;
  let j; try { j = JSON.parse(l.slice(i)); } catch { continue; }
  if (j.voice_turn == null || j.turn_ms == null) continue;
  if (!turns.has(j.voice_turn)) turns.set(j.voice_turn, []);
  turns.get(j.voice_turn).push(j);
}

db.upsertAccount({ conversationId: CONV, channel: "fake", address: process.env.REASON_OWNER_NUMBER, name: "Omari", isOperator: true });
await voice.prime();
voice.contextDeps.runTool = async (name, input) => {
  await sleep(toolMs.get(input?.query) ?? 0);
  return { ok: true, memories: [] };
};
const toolMs = new Map();

/** The fake model for one recorded turn. */
function modelFor(ev, words, tag) {
  return (() => {
    let round = 0;
    const started = Date.now();
    return async function* () {
      round++;
      if (ev.system_tool) {
        await sleep(ev.turn_ms - (Date.now() - started));
        yield { type: "tool_use", name: ev.system_tool, id: `tu_${tag}`, input: {} };
        return;
      }
      const rounds = ev.rounds ?? 0;
      if (round <= rounds) {
        // Old code said "One sec..." at every tool start, so the recorded first word is the tool start.
        const toolTotal = Math.max(0, ev.turn_ms - (ev.first_word_ms ?? 0) - ROUND_TWO_MS);
        if (round === 1) await sleep((ev.first_word_ms ?? 0) - (Date.now() - started));
        const q = `${tag}-${round}`;
        toolMs.set(q, toolTotal / rounds);
        yield { type: "tool_start", name: "memory_search" };
        yield { type: "tool_use", name: "memory_search", id: `tu_${tag}_${round}`, input: { query: q } };
        return;
      }
      if (!ev.said || !words) {
        await sleep(ev.turn_ms - (Date.now() - started));
        return;
      }
      await sleep(rounds ? ROUND_TWO_MS : (ev.first_word_ms ?? 0) - (Date.now() - started));
      const cut = words.search(/[.!?](\s|$)/);
      const head = cut > 0 ? words.slice(0, cut + 1) : words;
      yield { type: "text", text: head };
      const rest = words.slice(head.length);
      if (rest.trim()) {
        if (!rounds) await sleep(ev.turn_ms - (Date.now() - started));
        yield { type: "text", text: rest };
      }
    };
  })();
}

/** countCall over the model's words, plus every code line as a filler keyed by its exact words. */
function countHeard(heard) {
  const k = countCall(heard.map(h => h.model));
  const seen = new Map();
  heard.forEach((h, i) => {
    if (!h.code.length) return;
    if (!countCall([h.model]).filler_lines) k.filler_lines++;
    for (const line of h.code) {
      k.filler_phrases++;
      const key = `code:${line}`;
      k.by[key] = (k.by[key] ?? 0) + 1;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (/\bsorry\b/i.test(line)) k.apologies++;
    }
  });
  for (const n of seen.values()) if (n > 1) k.repeats += n - 1;
  return k;
}

async function replay(stored) {
  const evs = turns.get(stored.id) ?? [];
  const { agent, them } = transcriptLines(stored.transcript);
  const call = db.createCall(CONV, {
    provider: "elevenlabs", toNumber: process.env.REASON_OWNER_NUMBER, isOwner: true,
    goal: "Omari called Reason", facts: [], direction: "in", externalId: `conv_replay_${stored.id}`, state: "in_progress",
  });
  const history = [];
  const heard = agent.length ? [{ model: agent[0], code: [] }] : []; // the opening is code-side first_message: same both sides
  if (agent.length) history.push({ role: "assistant", content: agent[0] });
  const firstWord = [];
  const longest = [];
  const perTurn = [];
  let a = 1, u = 0;
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    const words = ev.said ? modelWords(agent[a++] ?? "Okay.") : "";
    history.push({ role: "user", content: them[u++] ?? `mm-hm (${i})` });
    const logs = [];
    const out = await voice.llmRequest({
      log: (l) => logs.push(Object.keys(l)[0] + (l.ms != null ? `@${l.ms}` : "") + (l.first_word_ms != null ? `@fw${l.first_word_ms}` : "")),
      rawBody: JSON.stringify({
        model: "reason", stream: true,
        messages: [{ role: "system", content: "replay" }, ...history],
        elevenlabs_extra_body: { [EXTRA_BODY_KEYS.callId]: call.id, [EXTRA_BODY_KEYS.conversationId]: call.conversation_id },
      }),
      headers: { authorization: `Bearer ${SECRET}` }, secret: SECRET,
      screen: async () => ({ verdict: "safe" }),
      generate: modelFor(ev, words, `${stored.id}-${i}`),
    });
    const t0 = Date.now();
    let said = "", modelSaid = "", first = null, last = t0, gapMax = 0;
    const codeKeys = [];
    for await (const s of out.stream) {
      if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
      const c = JSON.parse(s.slice(6)).choices?.[0]?.delta?.content;
      if (!c) continue;
      const now = Date.now();
      if (first == null) first = now - t0;
      gapMax = Math.max(gapMax, now - last);
      last = now;
      said += c;
      if (CODE_LINES.has(c.trim())) codeKeys.push(c.trim());
      else modelSaid += c;
    }
    if (said.trim()) {
      heard.push({ model: modelSaid.trim(), code: codeKeys });
      history.push({ role: "assistant", content: said.trim() });
      firstWord.push(first);
      longest.push(gapMax);
    }
    const kinds = countCall([modelSaid]).by;
    perTurn.push({ i, rounds: ev.rounds ?? 0, sys: ev.system_tool ?? null, rec_fw: ev.first_word_ms, rec_ms: ev.turn_ms, first, gap: gapMax, fillers: [...Object.keys(kinds), ...codeKeys.map(k => `code:${k}`)], ...(process.env.REASON_FILLER_LOGS ? { logs } : {}) });
  }
  return { id: stored.id, counts: countHeard(heard), firstWord, longest, perTurn };
}

const only = process.env.REASON_FILLER_ONLY ? new Set(process.env.REASON_FILLER_ONLY.split(",").map(Number)) : null;
const owner = calls.filter(c => c.is_owner && turns.has(c.id) && (!only || only.has(c.id)));
const results = await Promise.all(owner.map(replay));
let tot = { ...ZERO };
const fw = [], lg = [];
for (const r of results) { tot = addCounts(tot, r.counts); fw.push(...r.firstWord); lg.push(...r.longest); }
console.log(JSON.stringify({
  calls: results.length,
  totals: { ...tot, filler_pct: +(100 * tot.filler_lines / Math.max(1, tot.lines)).toFixed(1) },
  first_word: gapStats(fw), longest_silence: gapStats(lg),
  per_call: results.map(r => ({ id: r.id, ...r.counts, first_word: gapStats(r.firstWord), ...(process.env.REASON_FILLER_TURNS ? { turns: r.perTurn } : {}) })),
}, null, 1));
process.exit(0);
