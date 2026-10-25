// Cutting Reason's paid API spend (2026-10-25) — one pinned test per item the owner approved.
//
// The incident: $10 put on the key at 21:08 UTC on 10-24 was gone by 04:00 UTC on 10-25, almost
// all of it builders' real-model tests on the paid key; from then on every paid call failed (162
// extraction tries on five messages by mid-morning) and nothing said so. See src/spend.js for where
// each feature now runs and why.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-api-spend-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const spend = await import("../src/spend.js");
const extract = await import("../src/extract.js");
const background = await import("../src/background.js");
const harm = await import("../src/harm.js");
const said = await import("../src/said.js");
const { askJson } = await import("../src/onethought.js");
const purchases = await import("../src/purchasesnote.js");
const ops = await import("../src/ops.js");
const voice = await import("../src/calls/voice.js");
const { cliConfig } = await import("../src/backends/cli.js");
// No test here may start the real CLI: anything that reaches it finds no binary and fails at once.
cliConfig.bin = join(dir, "no-claude-here");

after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:owner";
const env = (vars, fn) => async () => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const LOW_CREDIT = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
const usageRows = () => db.db.prepare("SELECT * FROM model_usage ORDER BY id").all();

beforeEach(() => {
  spend.resetApiOut();
  background.resetLane({ gapMs: 0 });
  db.db.exec("DELETE FROM model_usage; DELETE FROM extraction_queue; DELETE FROM event_log;");
  extract.setExtractReader(null);
});

// ---------- 1. tests never use the paid key ----------

test("1: a test process started with the paid key has it taken away and runs live lanes on the subscription", () => {
  const child = spawnSync(process.execPath, ["--import", "./test/paid-key-guard.js", "-e",
    "import('./test/live.js').then(l => console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, backend: l.backend, live: l.live })))"],
    { env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-paid", REASON_BACKEND: "", REASON_TEST_ALLOW_API: "" }, encoding: "utf8" });
  const out = JSON.parse(child.stdout.trim());
  assert.equal(out.key, null, "the key must not reach any test");
  assert.equal(out.backend, "claude-cli");
  assert.equal(out.live, true);
});

test("1: only REASON_TEST_ALLOW_API=1 keeps the key, and then it says so", () => {
  const child = spawnSync(process.execPath, ["--import", "./test/paid-key-guard.js", "-e",
    "import('./test/live.js').then(l => console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, label: l.label })))"],
    { env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-paid", REASON_BACKEND: "", REASON_TEST_ALLOW_API: "1" }, encoding: "utf8" });
  const out = JSON.parse(child.stdout.trim());
  assert.equal(out.key, "sk-ant-paid");
  assert.match(out.label, /REASON_TEST_ALLOW_API=1/);
});

test("1: both npm test scripts load the guard before any test file", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const s of ["test", "test:offline"]) assert.match(pkg.scripts[s], /--import \.\/test\/paid-key-guard\.js/, s);
});

test("1: no test lane gates itself on the API key directly — they all go through test/live.js", () => {
  const files = spawnSync("sh", ["-c", "grep -l 'skip = .*ANTHROPIC_API_KEY' test/*.test.js | grep -v api-spend || true"], { encoding: "utf8" }).stdout.trim();
  assert.equal(files, "");
});

// ---------- 2 + 3. extraction on the subscription, cheaper ----------

const ev = (role, content, at) => db.writeEvent({ conversationId: C, channel: "test", role, content, at });

test("3: a message with nothing to remember is marked done with no model call — by its shape, not its words", async () => {
  let asked = 0;
  extract.setExtractReader(async () => { asked++; return { facts: [], entities: [], relations: [], shown: new Set() }; });
  const t = clock.now();
  for (const [i, text] of ["ok", "thanks", "lol", "❤️", "!!", "[they sent this as an inline reply in the thread]"].entries()) {
    db.enqueueExtraction(C, ev("user", text, t + i));
  }
  const n = await extract.processQueue();
  assert.equal(n, 6);
  assert.equal(asked, 0, "no read for filler");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM extraction_queue WHERE state = 'done'").get().n, 6);
});

test("3: a one-word answer to a question is still read — 'Ama' after 'what's your sister's name?'", () => {
  assert.equal(extract.worthReading({ content: "Ama" }, { previous: "what's your sister's name?" }), true);
  assert.equal(extract.worthReading({ content: "Ama" }, { previous: "booked it for 8" }), false);
  assert.equal(extract.worthReading({ content: "I'm vegan" }, { previous: "" }), true);
  assert.equal(extract.worthReading({ content: "😂😂" }, { previous: "what's up?" }), false);
});

test("3: several queued messages from one conversation are read in ONE call, other conversations wait", async () => {
  const calls = [];
  extract.setExtractReader(async (conversationId, events) => { calls.push({ conversationId, n: events.length }); return { facts: [], entities: [], relations: [], shown: new Set() }; });
  const t = clock.now();
  db.enqueueExtraction(C, ev("user", "my sister Ama lives in Accra", t));
  db.enqueueExtraction(C, ev("assistant", "noted — Ama in Accra", t + 1));
  db.enqueueExtraction(C, ev("user", "and she's a nurse at Korle Bu", t + 2));
  db.enqueueExtraction("dm:other", db.writeEvent({ conversationId: "dm:other", channel: "test", role: "user", content: "I work at Stripe now", at: t + 3 }));
  await extract.processQueue();
  assert.deepEqual(calls, [{ conversationId: C, n: 3 }]);
  const other = { ...db.db.prepare("SELECT state, attempts FROM extraction_queue WHERE conversation_id = 'dm:other'").get() };
  assert.deepEqual(other, { state: "pending", attempts: 0 }, "released with its try given back");
  await extract.processQueue();
  assert.deepEqual(calls.at(-1), { conversationId: "dm:other", n: 1 });
});

test("3: the batch prompt numbers the messages, oldest first", () => {
  const t = clock.now();
  const a = { role: "user", content: "I moved to Brooklyn", conversation_id: C, at: t };
  const b = { role: "user", content: "actually Queens", conversation_id: C, at: t + 1 };
  const { prompt } = extract.batchPrompt(C, [a, b], "");
  assert.ok(prompt.indexOf("[1] (user):\nI moved to Brooklyn") < prompt.indexOf("[2] (user):\nactually Queens"));
});

test("3: rows the outage exhausted on the paid key are revived and drained by the next pass", async () => {
  const t = clock.now();
  const id = ev("user", "I start at Stripe on Monday", t);
  db.enqueueExtraction(C, id);
  db.db.prepare("UPDATE extraction_queue SET attempts = 3, last_error = ? WHERE event_log_id = ?").run(LOW_CREDIT.message, id);
  let read = 0;
  extract.setExtractReader(async () => { read++; return { facts: [], entities: [], relations: [], shown: new Set() }; });
  await extract.processQueue();
  assert.equal(read, 1);
  assert.equal(db.db.prepare("SELECT state FROM extraction_queue WHERE event_log_id = ?").get(id).state, "done");
});

test("3: a CLI limit on a batch gives every row its try back (an outage, not a bad message)", async () => {
  const t = clock.now();
  db.enqueueExtraction(C, ev("user", "my brother Kofi studies at Calvin", t));
  db.enqueueExtraction(C, ev("user", "he's in his second year", t + 1));
  extract.setExtractReader(async () => { throw new Error("You've hit your session limit · resets 7:10pm (UTC)"); });
  await extract.processQueue();
  const rows = db.db.prepare("SELECT state, attempts, retry_at FROM extraction_queue").all();
  assert.ok(rows.every(r => r.state === "pending" && r.attempts === 0 && r.retry_at > t), JSON.stringify(rows));
});

test("2: on the claude-cli backend extraction never constructs a paid call, even with a key in the environment", env({ REASON_BACKEND: "claude-cli", ANTHROPIC_API_KEY: "sk-test" }, async () => {
  assert.equal(extract.onSubscription(), true);
  const src = readFileSync("src/extract.js", "utf8");
  // The CLI branch returns before the API one; the API branch is reached only off the subscription.
  assert.ok(src.indexOf("if (onSubscription())") < src.indexOf('feature: "extraction", client: anthropic()'));
}));

// ---------- the guardrail: background work never crowds out a reply ----------

test("guardrail: background jobs run one at a time, never while a reply is in flight, and wait out a limit", async () => {
  let now = 1_000_000;
  background.resetLane({ now: () => now, gapMs: 0 });
  const order = [];
  let releaseTurn;
  const turn = background.whileTurn(() => new Promise(r => { releaseTurn = r; }));
  const job = background.enqueue("extract", async () => { order.push("extract"); return 7; });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(order, [], "nothing runs during a reply");
  assert.equal(background.status(now).blocked, "reply_in_flight");
  releaseTurn("reply");
  assert.equal(await turn, "reply");
  assert.equal(await job, 7);
  assert.deepEqual(order, ["extract"]);

  // A reply that hit the subscription's limit parks the lane until the reset; the job waits, and
  // nothing falls back to anything.
  await assert.rejects(background.whileTurn(async () => { throw new Error("You've hit your usage limit · resets 7:10pm (UTC)"); }));
  assert.equal(background.status(now).blocked, "subscription_limited");
  let ran = false;
  background.enqueue("profile:dm:owner", async () => { ran = true; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(ran, false);
});

test("guardrail: the same job asked for twice while waiting is queued once", async () => {
  background.resetLane({ gapMs: 0 });
  let n = 0;
  const turn = background.whileTurn(() => new Promise(r => setTimeout(r, 20)));
  const a = background.enqueue("extract", async () => ++n);
  const b = background.enqueue("extract", async () => ++n);
  assert.equal(a, b);
  await turn;
  await a;
  assert.equal(n, 1);
});

test("guardrail: background jobs keep the gap between them", async () => {
  let now = 1_000_000;
  background.resetLane({ now: () => now, gapMs: 15_000 });
  await background.enqueue("one", async () => {});
  assert.equal(background.status(now).blocked, "gap");
  now += 15_001;
  assert.equal(background.status(now).blocked, null);
});

test("guardrail: background CLI work has no API fallback anywhere — extraction, profile and the lane", () => {
  const lane = readFileSync("src/background.js", "utf8");
  assert.doesNotMatch(lane, /Anthropic|messages\.create|callApi/);
  const src = readFileSync("src/extract.js", "utf8");
  const cliChoose = src.slice(src.indexOf("async function chooseViaCli"), src.indexOf("/** Who chooses the profile"));
  assert.doesNotMatch(cliChoose, /callApi|anthropic\(\)/);
});

// ---------- 4. the latency-critical checks: Haiku, cached, CLI fallback ----------

test("4: the per-message checks are on claude-haiku-5-5 with small max_tokens", () => {
  assert.equal(config.harmModel, "claude-haiku-5-5");
  assert.equal(config.purchaseTopicModel, "claude-haiku-5-5");
  assert.equal(config.midTurnModel, "claude-haiku-5-5");
  assert.ok(purchases.TOPIC_MAX_TOKENS <= 32);
});

test("4: the harm screen sends its instructions cached, and counts the call", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: null }, async () => {
  let seen;
  harm.setScreenClient({ messages: { create: async (p) => { seen = p; return { content: [{ type: "tool_use", name: "verdict", input: { verdict: "clear" } }], usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }; } } });
  try {
    const r = await harm.screen({ text: "book me a table friday" });
    assert.equal(r.verdict, "clear");
    assert.equal(seen.system[0].cache_control.type, "ephemeral");
    assert.equal(seen.model, "claude-haiku-5-5");
    const u = usageRows().at(-1);
    assert.equal(u.feature, "harm");
    assert.equal(u.via, "api");
    assert.equal(u.cache_read_tokens, 900);
    assert.ok(u.cost_usd > 0 && u.cost_usd < 0.0001, String(u.cost_usd));
  } finally { harm.setScreenClient(null); }
}));

test("4: out of credit, the harm screen falls back to the CLI — and the next message skips the API", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: "claude-cli" }, async () => {
  let apiAsks = 0, cliAsks = 0;
  harm.setScreenClient({ messages: { create: async () => { apiAsks++; throw LOW_CREDIT; } } });
  harm.setCliScreen(async () => { cliAsks++; return { verdict: "clear" }; });
  try {
    assert.equal((await harm.screen({ text: "hey" })).via, "cli_fallback");
    assert.equal(apiAsks, 1, "no credit is not re-asked");
    assert.equal((await harm.screen({ text: "and again" })).via, "cli_fallback");
    assert.equal(apiAsks, 1, "known out of credit: straight to the CLI");
    assert.equal(cliAsks, 2);
    assert.equal(usageRows().filter(r => r.low_credit).length, 1);
  } finally { harm.setScreenClient(null); harm.setCliScreen(null); }
}));

test("4: the pre-send check (said ledger) falls back to the CLI when the API cannot answer", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: "claude-cli" }, async () => {
  const src = readFileSync("src/said.js", "utf8");
  const check = src.slice(src.indexOf("export async function checkDraft"));
  assert.doesNotMatch(check, /cli: false/);
  assert.match(check, /feature: "said_check"/);
}));

test("4: askJson out of credit goes to the CLI, and a subscription-only ask never touches the API", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: "claude-cli" }, async () => {
  let apiAsks = 0;
  const sdk = { messages: { create: async () => { apiAsks++; throw LOW_CREDIT; } } };
  await assert.rejects(askJson({ system: "s", prompt: "p", schema: { type: "object" }, client: sdk }), /credit balance.*cli: could not run/);
  assert.equal(apiAsks, 1);
  apiAsks = 0;
  await assert.rejects(askJson({ system: "s", prompt: "p", schema: { type: "object" }, client: sdk, api: false }), /kept to the subscription/);
  assert.equal(apiAsks, 0);
}));

test("4: the said-ledger's record (after the reply) is kept to the subscription on the claude-cli backend", () => {
  const src = readFileSync("src/said.js", "utf8");
  assert.match(src, /feature: "said_record", api: process\.env\.REASON_BACKEND !== "claude-cli"/);
});

test("4: purchase-topic falls back to the CLI on its own budget", env({ ANTHROPIC_API_KEY: "", REASON_BACKEND: "claude-cli" }, async () => {
  const r = await purchases.askTopicCli({ text: "any update on the order?", ask: async (a) => { assert.equal(a.feature, "purchase_topic"); assert.equal(a.timeoutMs, config.purchaseTopicCliTimeoutMs); return { value: { answer: "yes" } }; } });
  assert.deepEqual(r, { about: true, via: "cli" });
  await assert.rejects(purchases.askTopicCli({ text: "x", ask: async () => ({ error: "boom" }) }), /cli: boom/);
}));

// ---------- 5. cost per feature ----------

test("5: the price table turns a response's usage into dollars, cache reads at their own rate", () => {
  const c = spend.costOf("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 });
  assert.equal(c.toFixed(3), (0.10 + 0.50 + 0.01 + 0.125).toFixed(3));
  assert.equal(spend.costOf("claude-sonnet-5-5-20261001", { output_tokens: 1_000_000 }), 10);
  assert.equal(spend.costOf("some-unknown-model", { input_tokens: 5 }), 0);
});

test("5: the status page row says today and 7d by feature, and counts subscription runs without $", () => {
  const now = clock.now();
  spend.recordApi({ feature: "harm", model: "claude-haiku-5-5", usage: { input_tokens: 2000, output_tokens: 50 }, at: now });
  spend.recordApi({ feature: "call", model: "claude-sonnet-5-5", usage: { input_tokens: 10_000, output_tokens: 300 }, at: now });
  spend.recordCli({ feature: "extraction", model: "haiku", at: now });
  spend.recordCli({ feature: "reply", model: "opus", at: now });
  const row = spend.spendCheck({ now });
  assert.equal(row.state, "ok");
  assert.match(row.detail, /^\$0\.023 today — call \$0\.023 \(1\), harm \$0\.0002 \(1\)/);
  assert.match(row.detail, /7d/);
  assert.match(row.detail, /subscription: 2 runs today \(extraction 1, reply 1\)/);
});

test("5: a paid call refused for want of credit is on the row and turns the pre-reply row red, past the cap amber — both on ops' alert path", async () => {
  const now = clock.now();
  spend.recordApi({ feature: "said_check", model: "claude-haiku-5-5", error: LOW_CREDIT, at: now });
  // Said on the spend row, and texted by the pre-reply checks' own row (fallbackCheck), not twice.
  assert.equal(spend.spendCheck({ now }).state, "ok");
  assert.match(spend.spendCheck({ now }).detail, /1 paid call refused for credit in the last hour/);
  assert.equal(spend.fallbackCheck().state, "bad");
  db.db.exec("DELETE FROM model_usage");
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", usage: { input_tokens: 300_000 }, at: now });
  assert.equal(spend.spendCheck({ now, cap: 1 }).state, "warn");
  const report = await ops.runChecks({ now, probe: async () => ({ ok: true, status: 200 }) });
  const r = report.checks.find(c => c.id === "api_spend");
  assert.equal(r.label, "API spend today / 7d by feature");
  assert.equal(r.state, "warn");
});

test("5: every CLI run is counted by feature, at the one place they all end", () => {
  const src = readFileSync("src/backends/cli.js", "utf8");
  assert.match(src, /export function runClaudeCli\(\{ feature = "other", \.\.\.args \}\)/);
  assert.match(readFileSync("src/spend.js", "utf8"), /onCliRun\(r => recordCli/);
});

// ---------- 6. phone calls untouched ----------

test("6: phone calls keep their own backend and model — the API, on whatever REASON_CALL_MODEL says", () => {
  const src = readFileSync("src/config.js", "utf8");
  assert.match(src, /callBackend: process\.env\.REASON_CALL_BACKEND \|\| "",/);
  assert.match(src, /callModel: process\.env\.REASON_CALL_MODEL \|\| "",/);
  const v = readFileSync("src/calls/voice.js", "utf8");
  assert.match(v, /model: config\.callModel \|\| config\.model,/);
  // A call is never skipped or rerouted for the out-of-credit pause the side checks use.
  assert.doesNotMatch(v, /apiOut|callApi|cachedSystem/);
  assert.equal(typeof voice.callBackendName, "function");
});

test("owner: the pre-reply checks on the subscription for want of credit text the owner ONCE, and once 'back on the API'", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: "claude-cli" }, async () => {
  db.db.exec("DELETE FROM ops_checks WHERE id = 'api_fallback'");
  db.opsDelete("alerted:api_fallback");
  const sent = [];
  const runtime = { say: (c, text) => sent.push({ c, text }) };
  const report = (at) => ({ at, checks: [{ id: "api_fallback", group: "money", label: "Pre-reply checks", ...spend.fallbackCheck() }], verdict: spend.fallbackCheck().state === "ok" ? "ok" : "bad" });
  let dry = true;
  harm.setScreenClient({ messages: { create: async () => { if (dry) throw LOW_CREDIT; return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "verdict", input: { verdict: "clear", reason: "fine" } }], usage: { input_tokens: 10, output_tokens: 5 } }; } } });
  harm.setCliScreen(async () => ({ verdict: "clear" }));
  try {
    const t0 = clock.now();
    assert.equal(spend.fallbackCheck().state, "ok", "no paid call on record: nothing to say");
    // Many messages while the key is dry, across many ops passes.
    for (let i = 0; i < 6; i++) {
      assert.equal((await harm.screen({ text: `message ${i}` })).via, "cli_fallback");
      spend.resetApiOut(); // the pause lapsing: the next message asks the API again and is refused again
      ops.settle({ report: report(t0 + i * ops.ALERT_AFTER_MS), runtime });
    }
    assert.equal(sent.length, 1, "one text for the whole episode, not one per message");
    assert.equal(sent[0].c, config.ownerConversation, "only ever the owner");
    assert.match(sent[0].text, /The API key ran dry, so the pre-reply checks switched to the subscription; replies may be a few seconds slower until you top up\./);
    assert.match(sent[0].text, /Status page: \S+/, "with the /ops link");
    assert.doesNotMatch(sent[0].text, /API spend/, "the spend row does not text the same thing twice");
    // A quiet night with no messages is not a recovery.
    ops.settle({ report: report(t0 + 20 * ops.ALERT_AFTER_MS), runtime });
    assert.equal(sent.length, 1);
    // Topped up: the next paid check works, and the owner hears it once.
    dry = false;
    const back = await harm.screen({ text: "after the top-up" });
    assert.equal(back.verdict, "clear");
    assert.notEqual(back.via, "cli_fallback", "answered by the API");
    ops.settle({ report: report(t0 + 21 * ops.ALERT_AFTER_MS), runtime });
    ops.settle({ report: report(t0 + 22 * ops.ALERT_AFTER_MS), runtime });
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /^Back on the API: the pre-reply checks are using the API key again/);
    assert.ok(sent.every(s => s.c === config.ownerConversation));
  } finally { harm.setScreenClient(null); harm.setCliScreen(null); }
}));

test("owner: a single failed check is a blip; three in a row is 'failing' and says so in the same one text", () => {
  const now = clock.now();
  spend.recordApi({ feature: "said_check", model: "claude-haiku-5-5", error: new Error("timeout"), at: now });
  assert.equal(spend.fallbackCheck().state, "ok");
  spend.recordApi({ feature: "harm", model: "claude-haiku-5-5", error: new Error("500 overloaded"), at: now + 1 });
  spend.recordApi({ feature: "onethought", model: "claude-haiku-5-5", error: new Error("500 overloaded"), at: now + 2 });
  const fb = spend.fallbackCheck();
  assert.equal(fb.state, "bad");
  assert.match(fb.alert, /^The API key is failing, so the pre-reply checks switched to the subscription/);
  // A reply's own paid call is not a pre-reply check and does not count either way.
  spend.recordApi({ feature: "reply", model: "claude-opus-5-5", usage: { input_tokens: 5 }, at: now + 3 });
  assert.equal(spend.fallbackCheck().state, "bad");
});
