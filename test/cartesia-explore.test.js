// The Cartesia experiment's two owner scripts (scripts/cartesia-listen.mjs, scripts/cartesia-call-feel.mjs;
// docs/calls-cartesia.md): the parts that can be wrong without a key. The line set, the .wav a phone
// clip is wrapped in, the timing sums, the cost estimate, and that the call feel test makes and
// removes things in the right order — against a stand-in, never Cartesia.
//
//   node --test test/cartesia-explore.test.js
//
// No key, no network: the API base points at a closed local port, so a call that slipped through
// would fail rather than spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.CARTESIA_API_BASE = "http://127.0.0.1:9";
const L = await import("../scripts/cartesia-listen.mjs");
const F = await import("../scripts/cartesia-call-feel.mjs");
const { pcmToUlaw } = await import("../src/calls/ulaw.js");
const root = fileURLToPath(new URL("..", import.meta.url));

test("the lines: eight short ones, each kind asked for, one with a real laugh", () => {
  assert.deepEqual(L.LINES.map(l => l.id), ["greeting", "time", "bad-news", "laugh", "mm-hm", "number", "heavy", "goodbye"]);
  for (const l of L.LINES) assert.ok(l.text.length > 5 && l.text.length <= 140 && l.what, l.id);
  assert.match(L.LINES.find(l => l.id === "laugh").text, /\[laughter\]/);
  assert.equal(L.LINES.filter(l => l.text.includes("[laughter]")).length, 1);
  // The number is one kept for fiction, written plain for their normalizer.
  assert.match(L.LINES.find(l => l.id === "number").text, /\b212-555-01\d\d\b/);
  // Emotions asked for by --emotion are ones Cartesia lists (volume-speed-emotion, read 2026-11-12).
  for (const l of L.LINES) assert.ok(["", "happy", "apologetic", "calm", "sympathetic", "affectionate"].includes(l.emotion), l.id);
  assert.equal(L.plain("Ha? [laughter] Oh, <emotion value=\"sad\"/> right."), "Ha? Oh, right.");
});

test("the voices: two for agents, two emotive, and British women among them", () => {
  assert.deepEqual(L.VOICES.map(v => v.kind), ["agent", "agent", "emotive", "emotive", "persona"]);
  assert.deepEqual([L.VOICES[0].name, L.VOICES[0].locale], ["Gemma", "en-GB"]);
  assert.deepEqual(L.VOICES.filter(v => v.locale === "en-GB").map(v => v.key), ["gemma", "lucy", "fiona"]);
  const all = [...L.VOICES, ...L.MORE_VOICES];
  assert.equal(new Set(all.map(v => v.id)).size, all.length);
  assert.equal(new Set(all.map(v => v.key)).size, all.length);
  for (const v of all) assert.match(v.id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  const p = L.pick({ voices: "gemma,Pippa,62ae83ad-4f6a-430b-af41-a9bede9286ca,Someone New", lines: "laugh" });
  assert.deepEqual(p.voices.map(v => [v.name, !!v.id]), [["Gemma", true], ["Pippa", true], ["", true], ["Someone New", false]]);
  assert.deepEqual(L.pick().voices, L.VOICES);
  assert.throws(() => L.pick({ lines: "nope" }), /no line "nope"/);
});

test("a phone clip's .wav: μ-law at 8 kHz, the line's own bytes untouched", () => {
  const body = Buffer.from([0xff, 0x7f, 0x00, 0x80, 0x55]);
  const w = L.wav(body, { rate: 8000, ulaw: true });
  assert.equal(w.toString("latin1", 0, 4) + w.toString("latin1", 8, 16), "RIFFWAVEfmt ");
  assert.equal(w.readUInt32LE(4), w.length - 8);
  assert.deepEqual([w.readUInt32LE(16), w.readUInt16LE(20), w.readUInt16LE(22), w.readUInt32LE(24), w.readUInt32LE(28), w.readUInt16LE(32), w.readUInt16LE(34)], [18, 7, 1, 8000, 8000, 1, 8]);
  assert.equal(w.toString("latin1", 38, 42), "fact");
  assert.equal(w.readUInt32LE(46), 5);
  assert.equal(w.toString("latin1", 50, 54), "data");
  assert.equal(w.readUInt32LE(54), 5);
  assert.deepEqual(w.subarray(58, 63), body);
  assert.equal(w.length, 58 + 5 + 1, "an odd length is padded to a word");
  const pcm = L.wav(Buffer.alloc(8), { rate: 44100 });
  assert.deepEqual([pcm.length, pcm.readUInt16LE(20), pcm.readUInt32LE(24), pcm.readUInt32LE(28), pcm.readUInt16LE(34), pcm.readUInt32LE(40)], [52, 1, 44100, 88200, 16, 8]);
});

test("timing: median and worst, and the quiet a clip opens with", () => {
  assert.deepEqual(L.stats([300, 100, 200]), { n: 3, median: 200, worst: 300 });
  assert.deepEqual(L.stats([100, 200, 400, 1000, null, undefined]), { n: 4, median: 300, worst: 1000 });
  assert.deepEqual(L.stats([]), { n: 0, median: null, worst: null });
  const clip = Buffer.concat([Buffer.alloc(800, 0xff), Buffer.alloc(400, pcmToUlaw(8000))]);
  assert.equal(L.leadMs(clip), 100);
  assert.equal(L.leadMs(Buffer.alloc(160, 0xff)), 20, "all quiet: its whole length");
  const rows = [
    { voice: "gemma", format: "phone", firstMs: 120, serverMs: 30, leadMs: 100, error: "" },
    { voice: "gemma", format: "phone", firstMs: 180, serverMs: 40, leadMs: 140, error: "" },
    { voice: "gemma", format: "full", firstMs: 500, error: "" },
    { voice: "gemma", format: "phone", firstMs: null, error: "quota" },
    { voice: "today-marin", format: "phone", firstMs: 900, error: "" },
  ];
  assert.deepEqual(L.summarize(rows), [
    "First audio, phone: median 150 ms, worst 180 ms (2 clips).",
    "First audio, full: median 500 ms, worst 500 ms (1 clips).",
    "Quiet before the first sound (phone): median 120 ms, worst 140 ms.",
    "Cartesia's own time for the first piece: median 35 ms.",
  ]);
});

test("the plan: clips and credits counted from the lines", () => {
  const chars = L.LINES.reduce((n, l) => n + l.text.length, 0);
  assert.deepEqual(L.plan({ lines: L.LINES, voices: L.VOICES }), { clips: 80, credits: chars * 10, todayChars: 0 });
  const felt = L.LINES.filter(l => l.emotion);
  const p = L.plan({ lines: L.LINES, voices: L.VOICES.slice(0, 1), emotion: true, today: true });
  assert.equal(p.clips, (8 + felt.length) * 2 + 16);
  assert.equal(p.credits, (chars + felt.reduce((n, l) => n + l.text.length, 0)) * 2);
  assert.ok(p.todayChars > 0 && p.todayChars < chars);
});

test("the key: the environment first, then a .env file, and where it came from", () => {
  const dir = mkdtempSync(join(tmpdir(), "cartesia-keys-"));
  try {
    writeFileSync(join(dir, ".env"), "CARTESIA_API_KEY=from-file\nOTHER=x\n");
    const files = [join(dir, "missing.env"), join(dir, ".env")];
    const from = join(dir, ".env").replace(homedir(), "~");
    assert.deepEqual(L.loadKeys(["CARTESIA_API_KEY", "NOPE"], { env: {}, files }), { CARTESIA_API_KEY: { value: "from-file", from }, NOPE: { value: "", from: "" } });
    assert.equal(L.loadKeys(["CARTESIA_API_KEY"], { env: { CARTESIA_API_KEY: " from-env " }, files }).CARTESIA_API_KEY.value, "from-env");
    // An empty variable is not a key: the file is still read (how a test run once reached the real one).
    assert.equal(L.loadKeys(["CARTESIA_API_KEY"], { env: { CARTESIA_API_KEY: "" }, files }).CARTESIA_API_KEY.from, from);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("today's persona is the one the call's opener asks for", () => {
  assert.ok(readFileSync(join(root, "src/calls/opener.js"), "utf8").includes(L.TODAY_PERSONA));
});

test("neither script spends without being told to", () => {
  const home = mkdtempSync(join(tmpdir(), "cartesia-home-"));
  const env = { PATH: process.env.PATH, HOME: home, CARTESIA_API_KEY: "sk_test_not_a_key", CARTESIA_API_BASE: "http://127.0.0.1:9" };
  const run = (...args) => spawnSync(process.execPath, args, { cwd: home, env, encoding: "utf8" });
  try {
    const dry = run(join(root, "scripts/cartesia-listen.mjs"), "--dry-run");
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /Makes 80 clips[\s\S]*Dry run: nobody was called/);
    assert.ok(!dry.stdout.includes("sk_test_not_a_key"));
    // No terminal attached (as here) and no --yes: a key being there is not enough.
    const bare = run(join(root, "scripts/cartesia-listen.mjs"), "--out", join(home, "out"));
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /Not run: this spends Cartesia credits/);
    const feel = run(join(root, "scripts/cartesia-call-feel.mjs"));
    assert.equal(feel.status, 0);
    assert.match(feel.stdout, /\$0\.03 a minute of call \+ \$0\.014 a minute on a Cartesia number = \$0\.044 a minute[\s\S]*Dry run: nobody was called and nothing was made/);
    const down = run(join(root, "scripts/cartesia-call-feel.mjs"), "--teardown");
    assert.match(down.stdout, /Nothing to tear down/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the call feel estimate and the model it picks", () => {
  const models = [
    { id: "slow", provider: "a", average_latency_ms: 900, pricing: { input_per_million_tokens: "3", output_per_million_tokens: "15" } },
    { id: "quick", provider: "b", average_latency_ms: 310, pricing: { input_per_million_tokens: "0.50", output_per_million_tokens: "2.00" } },
    { id: "untimed", provider: "c", average_latency_ms: null, pricing: { input_per_million_tokens: "1", output_per_million_tokens: "1" } },
  ];
  assert.equal(F.pickModel(models).id, "quick");
  assert.equal(F.pickModel(models, "slow").id, "slow");
  assert.throws(() => F.pickModel(models, "gone"), /does not list a model "gone"/);
  assert.equal(F.pickModel([models[2]]).id, "untimed");
  assert.deepEqual(F.estimate({ minutes: 10 }), { perMin: 0.044, tokensPerMin: null, known: false, total: 0.44, minutes: 10 });
  const e = F.estimate({ minutes: 10, number: false, model: models[1] });
  assert.equal(e.perMin, 0.03);
  assert.ok(Math.abs(e.tokensPerMin - (6000 * 0.5 + 300 * 2) / 1e6) < 1e-12);
  assert.equal(e.total, 0.336);
  const body = F.agentBody({ voice: "v1", language: "en-GB", model: "quick" });
  assert.deepEqual([body.config.audio.output.voice_id, body.config.language.primary, body.config.model.id, Object.keys(body.config.system_tools)], ["v1", "en-GB", "quick", ["end_call"]]);
  assert.match(body.config.instructions, /TEST[\s\S]*no access to their accounts[\s\S]*\[laughter\][\s\S]*you're an AI assistant/);
  assert.ok(!("tools" in body.config));
});

/** A stand-in for Cartesia's REST API: records each request, answers from a table. */
function standIn(answers) {
  const seen = [];
  const call = async (key, path, { method = "GET", body = null } = {}) => {
    seen.push(`${method} ${path}`);
    const a = answers[`${method} ${path.split("?")[0]}`] ?? { status: 404 };
    const r = typeof a === "function" ? a(body, seen) : a;
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: r.json ?? null, error: status < 300 ? "" : `${status} ${r.json?.error_code ?? ""}`.trim() };
  };
  return { call, seen };
}

test("create makes the agent, then the number, and keeps what it made for the teardown", async () => {
  const saved = [];
  const out = [];
  const { call, seen } = standIn({
    "GET /v1/agents/models": { json: { data: [{ id: "quick", provider: "b", average_latency_ms: 310, pricing: { input_per_million_tokens: "0.5", output_per_million_tokens: "2" } }] } },
    "POST /v1/agents": (body) => ({ status: 201, json: { id: "agent_1", name: body.name } }),
    "POST /agents/phone-numbers/provision": (body) => ({ status: 201, json: { id: "pn_1", number: "+12125550147", agent: { id: body.agent_id } } }),
  });
  const code = await F.create({ key: "k", voice: "v1", language: "en-GB", call, log: (l) => out.push(l), save: (s) => saved.push({ ...s }) });
  assert.equal(code, 0);
  assert.deepEqual(seen, ["GET /v1/agents/models?limit=100", "POST /v1/agents", "POST /agents/phone-numbers/provision"]);
  assert.deepEqual(saved.map(s => [s.agentId, s.numberId, s.number]), [["agent_1", "", ""], ["agent_1", "pn_1", "+12125550147"]]);
  const text = out.join("\n");
  // The cost is said before anything is made.
  assert.ok(text.indexOf("$0.044 a minute") < text.indexOf("Agent created"));
  assert.match(text, /Ring \+12125550147[\s\S]*--teardown --yes/);
});

test("no number slot: the agent is kept, and what is needed is said", async () => {
  const saved = [];
  const out = [];
  const { call } = standIn({
    "GET /v1/agents/models": { json: { data: [{ id: "quick", average_latency_ms: 310 }] } },
    "POST /v1/agents": { status: 201, json: { id: "agent_1" } },
    "POST /agents/phone-numbers/provision": { status: 402, json: { error_code: "quota_exceeded" } },
  });
  assert.equal(await F.create({ key: "k", voice: "v1", language: "en", call, log: (l) => out.push(l), save: (s) => saved.push({ ...s }) }), 0);
  assert.deepEqual(saved.map(s => s.numberId), [""]);
  assert.match(out.join("\n"), /What is needed: a free Cartesia number slot[\s\S]*play\.cartesia\.ai\/agents/);
  assert.ok(!out.join("\n").includes("Ring "));
});

test("teardown deletes the calls' data, then the number, then the agent, and says what is left", async () => {
  const out = [];
  let forgotten = 0;
  const live = { ac_2: true };
  const { call, seen } = standIn({
    "GET /agents/calls": { json: { data: [{ id: "ac_1", status: "completed" }, { id: "ac_2", status: "started" }, { id: "ac_3", status: "completed", redacted_at: "2026-11-12T00:00:00Z" }], has_more: false } },
    "DELETE /agents/calls/ac_1": { json: { id: "ac_1" } },
    "DELETE /agents/calls/ac_2": () => (live.ac_2 ? { status: 400 } : { json: { id: "ac_2" } }),
    "POST /agents/calls/ac_2/cancel": () => { live.ac_2 = false; return { json: {} }; },
    "PATCH /agents/phone-numbers/pn_1": { json: {} },
    "DELETE /agents/phone-numbers/pn_1": { status: 204 },
    "DELETE /v1/agents/agent_1": { status: 204 },
  });
  const state = { agentId: "agent_1", numberId: "pn_1", number: "+12125550147" };
  assert.equal(await F.teardown({ key: "k", state, call, log: (l) => out.push(l), forget: () => forgotten++ }), 0);
  assert.deepEqual(seen, [
    "GET /agents/calls?agent_id=agent_1&limit=100",
    "DELETE /agents/calls/ac_1", "DELETE /agents/calls/ac_2", "POST /agents/calls/ac_2/cancel", "DELETE /agents/calls/ac_2",
    "PATCH /agents/phone-numbers/pn_1", "DELETE /agents/phone-numbers/pn_1", "DELETE /v1/agents/agent_1",
  ]);
  assert.equal(forgotten, 1);
  assert.match(out.join("\n"), /3 found, transcript and recording deleted for 3[\s\S]*released[\s\S]*deleted[\s\S]*All gone/);

  // A number Cartesia will not release: said, counted, and the record of what was made is kept.
  const stuck = standIn({ "GET /agents/calls": { json: { data: [] } }, "PATCH /agents/phone-numbers/pn_1": { json: {} }, "DELETE /agents/phone-numbers/pn_1": { status: 400 }, "GET /agents/phone-numbers/pn_1": { json: { id: "pn_1" } }, "DELETE /v1/agents/agent_1": { status: 204 } });
  const said = [];
  assert.equal(await F.teardown({ key: "k", state, call: stuck.call, log: (l) => said.push(l), forget: () => forgotten++ }), 1);
  assert.equal(forgotten, 1);
  assert.match(said.join("\n"), /NOT released[\s\S]*1 thing\(s\) left/);
});
