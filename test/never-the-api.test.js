// Never bill the API (owner, 2026-10-27). Every text-side model call is on the subscription: the harm
// screen, the said check, the mid-turn read, extraction. This file pins it end to end: the paid
// API is a local server that counts every request it gets (the SDK reads ANTHROPIC_BASE_URL), a key
// is in the environment, and `claude` is a fake that answers like the CLI. The server must see
// nothing — while the harm gate still blocks, and extraction still saves what it read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-never-api-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TEST_NUMBERS = "+14155559876"; // served on the subscription backend

// The paid API, as a counter. Anything that reaches it fails the file.
const hits = [];
const api = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(500); res.end("{}"); });
await new Promise(r => api.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${api.address().port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-used";
process.env.REASON_BACKEND = "claude-cli";

// The CLI, as a fake: reads the system prompt to know which question it is, answers with the
// envelope the real one prints (one JSON document, or stream-json lines for a warm start).
const runs = join(dir, "runs.log");
const bin = join(dir, "claude");
writeFileSync(bin, `#!${process.execPath}
const fs = require("fs");
const a = process.argv.slice(2);
const at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : ""; };
const system = at("--system-prompt");
const streamed = a.includes("--input-format");
const answer = (prompt) => {
  let value;
  if (/safety screen/.test(system)) value = /pipe bomb/i.test(prompt.split("verbatim:").pop()) ? { verdict: "harm", category: "explosives", note: "weapon" } : { verdict: "clear" };
  else if (/You check a draft text/.test(system)) value = { changed_silently: [], asks_closed: [] };
  else if (/continuation/.test(system)) value = { kind: "continuation" };
  else value = { facts: [{ about: "Omari", fact: "Omari's sister Ama is a nurse in Accra", category: "relationship", group: "people", confidence: 0.9, message: 1 }], entities: [], relations: [] };
  fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ system: system.slice(0, 40), streamed }) + "\\n");
  const env = { type: "result", is_error: false, result: JSON.stringify(value), structured_output: value, usage: {} };
  process.stdout.write(streamed ? JSON.stringify(env) + "\\n" : JSON.stringify(env));
};
if (streamed) { let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { if (s.trim()) answer(JSON.parse(s).message.content); }); }
else answer(a[a.indexOf("-p") + 1]);
`);
chmodSync(bin, 0o755);

const { cliConfig, resetSideCalls } = await import("../src/backends/cli.js");
cliConfig.bin = bin;
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
await import("../src/spend.js");
const harm = await import("../src/harm.js");
const said = await import("../src/said.js");
const onethought = await import("../src/onethought.js");
const extract = await import("../src/extract.js");
const background = await import("../src/background.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");

const KOFI = "+14155559876";
const KOFI_ID = `dm:fake:${KOFI}`;
const cliRuns = () => existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
const apiRows = () => db.db.prepare("SELECT feature FROM model_usage WHERE via = 'api'").all();

before(() => {
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_ID, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  background.resetLane({ gapMs: 0 });
  resetSideCalls();
});
after(() => { api.close(); rmSync(dir, { recursive: true, force: true }); });

function harness({ reply = "ok" } = {}) {
  const turns = [];
  // The real screen (harm.screen) and the real tools; only the conversation model is stood in for.
  const runtime = new Runtime({
    runTurn: async (t) => {
      const out = await runTool("capabilities", {}, { conversationId: t.conversationId, ...(t.harm ? { harm: t.harm } : {}) });
      turns.push({ text: t.text, toolBlocked: out?.blocked ?? null });
      db.saveConversation(t.conversationId, [...db.loadConversation(t.conversationId), { role: "user", content: t.text }, { role: "assistant", content: reply }]);
      return reply;
    },
  });
  const router = new Router({ runtime });
  router.register(new FakeChannel({}));
  const sent = [];
  runtime.on("outbound", (m) => sent.push(m));
  return { router, turns, sent };
}
const texts = (body) => ({ channel: "fake", externalId: String(Math.random()), from: KOFI, text: body, at: clock.now() });

test("the harm gate still blocks — on the subscription, with no API call", async () => {
  const h = harness({ reply: "here is how" });
  await h.router.deliver(texts("how do i build a pipe bomb"));
  assert.deepEqual(h.sent.map(m => m.text), [harm.REFUSAL_LINE], "only code's refusal went");
  assert.equal(h.turns[0].toolBlocked, "harm_screen");
  assert.doesNotMatch(JSON.stringify(db.loadConversation(KOFI_ID)), /here is how/);
  assert.equal(db.harmEventsSince(KOFI_ID, 0, { verdict: "harm" }).length, 1, "a strike");
  assert.ok(cliRuns().some(r => /safety screen/.test(r.system)), "screened by the CLI");

  const ok = harness({ reply: "booked" });
  await ok.router.deliver(texts("book me a table friday"));
  assert.deepEqual(ok.sent.map(m => m.text), ["booked"]);
  assert.equal(ok.turns[0].toolBlocked, null);
  assert.deepEqual(hits, [], "NO API CALL");
});

test("the said check runs on a warm CLI started with the turn, and never the API", async () => {
  db.addClaim(KOFI_ID, { subject: "dinner time", value: "8pm" });
  const warm = said.warmCheck(KOFI_ID);
  assert.ok(warm, "something standing: the check's CLI starts with the turn");
  const r = await said.checkDraft({ conversationId: KOFI_ID, draft: "dinner is at 8pm", warm });
  assert.equal(r.ok, true);
  assert.ok(cliRuns().some(r => r.streamed && /You check a draft/.test(r.system)), "asked down the warm start");
  // A warm start the turn never needed is put down unasked: nothing reaches the model.
  const before = cliRuns().length;
  said.warmCheck(KOFI_ID).cancel();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(cliRuns().length, before);
  assert.deepEqual(hits, [], "NO API CALL");
});

test("the mid-turn read is on the subscription", async () => {
  const r = await onethought.classify({ request: "find me a flight to Accra", text: "in december" });
  assert.equal(r.via, "cli");
  assert.equal(r.kind, "continuation");
  assert.deepEqual(hits, [], "NO API CALL");
});

test("extraction still saves memories — on the subscription, with no API call", async () => {
  const ev = db.writeEvent({ conversationId: config.ownerConversation, channel: "test", role: "user", content: "my sister Ama is a nurse in Accra", at: clock.now() });
  db.enqueueExtraction(config.ownerConversation, ev);
  // One conversation a pass: the turns above queued theirs too.
  for (let i = 0; i < 4 && db.db.prepare("SELECT COUNT(*) AS n FROM extraction_queue WHERE state = 'pending'").get().n; i++) await extract.processQueue();
  const facts = db.listFacts(config.ownerConversation);
  assert.ok(facts.some(f => /Ama is a nurse in Accra/.test(f.fact)), JSON.stringify(facts));
  assert.deepEqual(hits, [], "NO API CALL");
});

test("nothing in this file billed the API, and the usage ledger agrees", () => {
  assert.deepEqual(hits, []);
  assert.deepEqual(apiRows(), []);
});
