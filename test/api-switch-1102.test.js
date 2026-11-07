// Moving every model call onto the API key (owner, 2026-11-02): REASON_BACKEND=api.
//
// Before this, eleven side lanes ran only through the `claude` CLI and on the API backend quietly
// did nothing (or, for extraction and the photo looks, still went to the CLI). Each test below runs
// one lane on REASON_BACKEND=api with a stand-in for the API (never the real key) and checks it
// asks the same question on the same model tier, and that its answer is used. Then the history
// cache on the main API turn: breakpoints on the request, never in the thread, and a start that
// does not slide.
//
//   1. side.js: model tiers, forced vs steered tool, refusal, no key = no call, CLI untouched
//   2. web chat title        3. item title + line      4. the morning greeting
//   5. onboarding read       6. a call's goal          7. mid-turn read (onethought)
//   8. said: the record and the send-time check        9. the ticket read; the sweep never waits
//  10. extraction + profile choice + fact filing      11. harm screen + reply screen on the API
//  12. judge + watch steer the tool on Opus 5.5 (forced tool use is a 400 there)
//  13. history cache: breakpoints, ≤4, thread stays clean; anchor holds then moves
//  14. a real API turn: second round reads the first round's cache marker
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-api-switch-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_DAILY = "owner";
process.env.REASON_BACKGROUND_CLI_GAP_MS = "0";
delete process.env.REASON_BACKEND;

const side = await import("../src/backends/side.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { resetApiOut } = await import("../src/spend.js");

const C = "dm:owner", OWNER = "+12025551234";
const H = 3_600_000;

/** A stand-in API: answers each create with `answer(params)` (an object = the `answer` tool's input). */
function fakeApi(answer = () => ({})) {
  const asks = [];
  side.setSideApiClient({
    messages: {
      create: async (params, opts) => {
        asks.push({ params, opts });
        const a = await answer(params);
        if (a instanceof Error) throw a;
        if (a?.stop_reason) return a;
        const name = params.tools?.[0]?.name ?? "answer";
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name, input: a }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  });
  return asks;
}

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  resetApiOut();
  delete process.env.REASON_BACKEND;
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages; DELETE FROM web_chats; DELETE FROM model_usage;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari Nyarko", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});
afterEach(() => side.setSideApiClient(null));

const settle = () => new Promise(r => setTimeout(r, 30));

test("1. side calls: tiers, forced vs steered, refusal, no key, and the CLI backend untouched", async () => {
  assert.equal(side.apiModelFor("haiku"), "claude-haiku-5-5");
  assert.equal(side.apiModelFor("sonnet"), "claude-sonnet-5-5");
  assert.equal(side.apiModelFor("opus"), config.model, "opus is the turn's own model");
  assert.equal(side.apiModelFor("claude-haiku-5-5"), "claude-haiku-5-5");

  // Under the test runner with no stand-in: the API is never reached; the CLI backend is as it was
  // (its lanes run, against a fake `claude` in the tests that want one; the titles and the like do not).
  assert.equal(side.sideModelOn(), false);
  process.env.REASON_BACKEND = "claude-cli";
  assert.equal(side.sideModelOn(), true);
  assert.equal(side.sideAskAllowed(), false);
  delete process.env.REASON_BACKEND;

  const asks = fakeApi(() => ({ title: "Saturday plans" }));
  assert.equal(side.sideModelOn(), true);
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
  const h = await side.askStructuredViaApi({ prompt: "p", system: "S", schema, model: "haiku", feature: "t" });
  assert.deepEqual(h.value, { title: "Saturday plans" });
  assert.deepEqual(asks[0].params.tool_choice, { type: "tool", name: "answer" }, "Haiku: forced");
  assert.deepEqual(asks[0].params.tools[0].input_schema, schema, "the CLI's own schema");
  assert.equal(asks[0].params.system[0].text, "S");
  assert.deepEqual(asks[0].params.system[0].cache_control, { type: "ephemeral" });
  const s = await side.askStructuredViaApi({ prompt: "p", system: "S", schema, model: "sonnet", feature: "t" });
  assert.ok(s.value);
  assert.deepEqual(asks[1].params.tool_choice, { type: "auto" }, "Sonnet 5.5 refuses forced tool use: steered");
  assert.match(asks[1].params.system[0].text, /^S\n\nAnswer only by calling the answer tool, once\.$/);
  // Counted as a paid call under its feature.
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM model_usage WHERE feature = 't' AND via = 'api'").get().n, 2);

  fakeApi(() => ({ stop_reason: "refusal", content: [] }));
  assert.equal((await side.askStructuredViaApi({ prompt: "p", system: "S", schema })).refusal, true);
  fakeApi(() => new Error("529 overloaded"));
  assert.match((await side.askStructuredViaApi({ prompt: "p", system: "S", schema })).error, /overloaded/);
  fakeApi(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "sure!" }] }));
  assert.match((await side.askStructuredViaApi({ prompt: "p", system: "S", schema })).error, /no answer/);

  // runStructured: the CLI envelope shape, from the API.
  fakeApi(() => ({ title: "x" }));
  const r = await side.runStructured({ prompt: "p", system: "S", jsonSchema: schema, model: "haiku", feature: "t" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.envelope.structured_output, { title: "x" });
  assert.equal(r.envelope.via, "api");

  // With a stand-in installed but the claude-cli backend on, the titles and the like stay off under test.
  process.env.REASON_BACKEND = "claude-cli";
  assert.equal(side.sideAskAllowed(), false, "the CLI under the test runner: off, exactly as before");
  delete process.env.REASON_BACKEND;
});

test("2. a Web chat's title, on the API (sonnet tier, as on the CLI)", async () => {
  const chats = await import("../src/webchats.js");
  chats.resetChatTitles();
  const asks = fakeApi(() => ({ title: "Saturday plans" }));
  const chat = "A".repeat(22);
  const T = Date.now() + 365 * 24 * H;
  db.claimWebChat(C, chat);
  db.writeMessage({ conversationId: C, role: "user", channel: "web", text: "plan my saturday please", at: T, chatId: db.webChatRoute(chat) });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "web", text: "Try the High Line.", at: T + 1000, chatId: db.webChatRoute(chat) });
  await settle();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].params.model, "claude-sonnet-5-5");
  assert.match(asks[0].params.messages[0].content, /plan my saturday/);
  assert.equal(db.db.prepare("SELECT title FROM web_chats WHERE id = ?").get(chat).title, "Saturday plans");
});

test("3. an item's title and line, on the API", async () => {
  const it = await import("../src/itemtitle.js");
  const asks = fakeApi(() => ({ title: "Call the landlord", line: "A reminder to call your landlord about the lease." }));
  const got = await it.summariseItem("remind me to call the landlord about the lease", { name: "Omari" });
  assert.equal(got.title, "Call the landlord");
  assert.match(got.line, /landlord/);
  assert.equal(asks[0].params.model, "claude-sonnet-5-5");
  assert.equal(asks[0].params.tool_choice.type, "auto");
});

test("4. the morning greeting, on the API", async () => {
  const daily = await import("../src/daily.js");
  daily.resetDaily();
  db.db.exec("DELETE FROM daily_editions;");
  const TUE_9AM = Date.UTC(2026, 9, 27, 13, 0, 0);
  const at = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };
  at(TUE_9AM - 30 * 24 * H);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari Nyarko", isOperator: true });
  db.markWebNoticeSeen(C);
  db.writeMessage({ conversationId: C, role: "user", channel: "fake", text: "watch it", at: TUE_9AM - 15 * H });
  db.writeMessage({ conversationId: C, role: "assistant", channel: "fake", text: "The hotel dropped its price overnight.", at: TUE_9AM - 4 * H });
  const asks = fakeApi(() => ({ greeting: "Morning, Omari. One thing moved while you slept." }));
  at(TUE_9AM - 4 * H + 60_000);
  const w = await daily.writeEdition(C);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].params.model, "claude-sonnet-5-5");
  assert.ok(!/hotel/i.test(asks[0].params.messages[0].content), "kinds only, never details");
  assert.equal(w.written, true);
  const row = db.db.prepare("SELECT edition FROM daily_editions WHERE conversation_id = ? ORDER BY generated_at DESC LIMIT 1").get(C);
  assert.equal(JSON.parse(row.edition).greeting, "morning, Omari. one thing moved while you slept.");
  clock.reset();
});

test("5. onboarding reads a first text on the API (haiku tier)", async () => {
  const ob = await import("../src/onboarding.js");
  const asks = fakeApi(() => ({ kind: "answer", name: "Kojo", occupation: "", reply: "", ideas: [] }));
  const r = await ob.readText({ state: "asked_name", text: "call me kojo" });
  assert.equal(r.kind, "answer");
  assert.equal(r.name, "Kojo");
  assert.equal(asks[0].params.model, "claude-haiku-5-5");
});

test("6. a call's goal is judged on the API", async () => {
  const gm = await import("../src/calls/goalmet.js");
  const asks = fakeApi(() => ({ met: true, why: "they confirmed the table for 8" }));
  const r = await gm.judgeGoal({ goal: "book a table for 2 at 8", transcript: "Reason: hi, a table for 2 at 8?\nThem: yes, you're booked." });
  // `how` is the read of what kind of call it was (2026-11-07); a model that leaves it out is "unsure".
  assert.deepEqual(r, { met: true, how: "unsure", why: "they confirmed the table for 8" });
  assert.equal(asks[0].params.model, "claude-sonnet-5-5");
});

test("7. the mid-turn read (onethought) on the API", async () => {
  const ot = await import("../src/onethought.js");
  const asks = fakeApi(() => ({ kind: "new" }));
  const r = await ot.classify({ request: "find me a flight to accra", text: "also what's the weather tomorrow" });
  assert.equal(r.kind, "new");
  assert.equal(asks[0].params.model, "claude-haiku-5-5");
  const j = await ot.askJson({ system: "S", prompt: "p", schema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] } });
  assert.equal(j.via, "api");
});

test("8. the said ledger: the record after a reply, and the check before one, on the API", async () => {
  const said = await import("../src/said.js");
  const asks = fakeApi((p) => p.system[0].text.startsWith(said.CHECK_INSTRUCTIONS)
    ? { changed_silently: [], asks_closed: [] }
    : { claims: [{ subject: "dinner time", value: "8pm", certain: true }], supersedes: [], closes: [], declined: [], questions: ["want me to book it?"] });
  const out = await said.record({ conversationId: C, userText: "what time is dinner", reply: "dinner's at 8pm. want me to book it?" });
  assert.equal(out.counts.claims, 1);
  assert.equal(out.counts.questions, 1);
  assert.equal(asks[0].params.messages.length, 1);
  const chk = await said.checkDraft({ conversationId: C, draft: "dinner's at 9pm" });
  assert.equal(chk.ok, true);
  assert.equal(asks.length, 2, "the check ran: a claim is standing");
  assert.deepEqual(asks[1].params.output_config, { effort: "low" }, "low effort, as the CLI's warm check");
  assert.equal(said.warmCheck(C), null, "no CLI to warm on the API backend");
});

test("9. the ticket read runs on the API, and the sweep never waits on its pass", async () => {
  const tc = await import("../src/ticketcheck.js");
  const asks = fakeApi(() => ({ is_ticket_email: false, tickets: [], passengers: [], record_locator: "", carrier: "", origin: "", destination: "", depart_date: "" }));
  const v = await tc.readEmail({ subject: "Your receipt", text: "thanks for shopping" });
  assert.equal(v.is_ticket_email, false);
  assert.equal(asks[0].params.messages.length, 1);
  const { Runtime } = await import("../src/runtime.js");
  const rt = new Runtime({ runTurn: async () => null });
  rt._ticketPass = null;
  const r = await rt.ticketChecks();
  assert.deepEqual(r, { started: true }, "in the background, as on the CLI");
});

test("10. extraction, the profile's choice and fact filing on the API", async () => {
  const ex = await import("../src/extract.js");
  const fg = await import("../src/factgroups.js");
  const asks = fakeApi((p) => p.system[0].text.includes("memory page") ? { filed: [] } : p.system[0].text.includes("in front of it") ? { picks: [] } : { facts: [], entities: [], relations: [] });
  const ev = db.writeEvent({ conversationId: C, role: "user", content: "my sister Ama lives in Accra and works as a nurse", at: clock.now() });
  db.enqueueExtraction(C, ev);
  const logs = [];
  const n = await ex.processQueue({ log: (x) => logs.push(x) });
  assert.equal(n, 1);
  assert.equal(asks[0].params.model, config.extractionModel);
  assert.ok(logs.some(l => l?.extracted === 1 && l.via === "api"), JSON.stringify(logs));
  // Fact filing has a model to read with now (it filed nothing on the API backend before).
  await fg.fileFacts();
  assert.ok(asks.every(a => !a.params.model.includes("opus")), "no side call on the turn's model");
});

test("11. the harm screen and the reply screen run on the API on the API backend", async () => {
  const harm = await import("../src/harm.js");
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try {
    assert.equal(harm.screenBackend(), "api");
    const asks = [];
    harm.setScreenClient({ messages: { create: async (p) => { asks.push(p); return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "verdict", input: { verdict: "clear" } }] }; } } });
    let cli = 0;
    harm.setCliScreen(async () => { cli++; return { verdict: "harm" }; });
    assert.equal((await harm.screen({ text: "book me a table friday", messages: [] })).verdict, "clear");
    assert.equal((await harm.screenReply({ text: "booked.", asked: "book it" })).verdict, "clear");
    assert.equal(asks.length, 2);
    assert.equal(asks[0].model, config.harmModel);
    assert.match(asks[1].system[0].text, /way OUT/);
    assert.equal(cli, 0, "no CLI on the API backend");
    process.env.REASON_BACKEND = "claude-cli";
    assert.equal(harm.screenBackend(), "claude-cli", "the CLI backend is as it was");
  } finally {
    delete process.env.ANTHROPIC_API_KEY; delete process.env.REASON_BACKEND;
    harm.setScreenClient(null); harm.setCliScreen(null);
  }
});

test("12. Opus 5.5 refuses forced tool use: the judge and the watcher steer it instead", () => {
  assert.equal(side.forcedToolOk("claude-opus-5-5"), false);
  assert.equal(side.forcedToolOk("claude-sonnet-5-5"), false);
  assert.equal(side.forcedToolOk("claude-haiku-5-5"), true);
  assert.equal(side.forcedToolOk("claude-opus-5"), true);
  const o = side.oneToolCall("claude-opus-5-5", "verdict", "S");
  assert.deepEqual(o.tool_choice, { type: "auto" });
  assert.match(o.system, /calling the verdict tool/);
  assert.deepEqual(side.oneToolCall("claude-opus-5", "verdict", "S"), { tool_choice: { type: "tool", name: "verdict" }, system: "S" });
});

test("13. history cache: two breakpoints on the request, none in the thread; the start holds, then moves", async () => {
  const agent = await import("../src/agent.js");
  const thread = [];
  for (let i = 0; i < 30; i++) thread.push({ role: "user", content: `u${i}` }, { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: `a${i}` }] });
  agent.resetHistoryAnchors();
  const start = agent.historyStart("h", thread);
  assert.equal(start, 20, "a full thread opens at the newest 40");
  assert.equal(thread[start].content, "u10");
  const req = agent.cachedMessages([...thread, { role: "user", content: "new" }], { start, historyEnd: thread.length });
  const marked = req.filter(m => JSON.stringify(m).includes("cache_control"));
  assert.equal(marked.length, 2);
  assert.deepEqual(req.at(-2).content.at(-1).cache_control, { type: "ephemeral" }, "end of the history");
  assert.equal(req.at(-2).content[0].cache_control, undefined, "never on a thinking block");
  assert.deepEqual(req.at(-1).content, [{ type: "text", text: "new", cache_control: { type: "ephemeral" } }]);
  assert.ok(!JSON.stringify(thread).includes("cache_control"), "the thread itself is never marked");
  // Next turn: the thread is saved cut to 60, the oldest four messages gone. Same start message.
  const next = [...thread.slice(4), { role: "user", content: "u30" }, { role: "assistant", content: "a30" }, { role: "user", content: "u31" }, { role: "assistant", content: "a31" }];
  const s2 = agent.historyStart("h", next);
  assert.equal(next[s2].content, "u10", "the request opens on the same message: its prefix is a cache hit");
  // Twenty messages later the anchor falls out of the window: it moves to the newest 40.
  const later = [...next.slice(20)];
  for (let i = 32; i < 42; i++) later.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
  const s3 = agent.historyStart("h", later);
  assert.equal(later.length - s3, 40);
  // A short thread opens at its first message.
  assert.equal(agent.historyStart("short", thread.slice(0, 6)), 0);
});

test("14. a turn on the API sends the cached history; its second round reads the first round's marker", async () => {
  const agent = await import("../src/agent.js");
  const realCreate = agent.model.create;
  const seen = [];
  agent.resetHistoryAnchors();
  db.saveConversation(C, [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hey" }] }]);
  agent.model.create = async (p) => {
    seen.push(JSON.parse(JSON.stringify(p)));
    return seen.length === 1
      ? { content: [{ type: "tool_use", id: "t1", name: "no_such_tool", input: {} }], stop_reason: "tool_use", usage: {} }
      : { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: {} };
  };
  try {
    const reply = await agent.runTurn({ conversationId: C, text: "what's up", images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }), capture: async () => ({ ok: false }) });
    assert.equal(reply, "done");
  } finally { agent.model.create = realCreate; }
  assert.equal(seen.length, 2);
  for (const p of seen) {
    const n = JSON.stringify(p.system).split("cache_control").length - 1 + JSON.stringify(p.messages).split("cache_control").length - 1
      + JSON.stringify(p.tools ?? []).split("cache_control").length - 1;
    assert.ok(n <= 4, `at most four breakpoints (${n})`);
  }
  assert.deepEqual(seen[0].messages[1].content.at(-1).cache_control, { type: "ephemeral" }, "round 1: the history's last message");
  assert.deepEqual(seen[1].messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" }, "round 2: the newest (tool result)");
  assert.deepEqual(seen[1].messages[1].content.at(-1).cache_control, { type: "ephemeral" }, "round 2 keeps the history marker");
  assert.equal(seen[1].messages[2].content.at?.(-1)?.cache_control, undefined, "round 1's newest is unmarked now (the history marker and the newest only)");
  const saved = db.loadConversation(C);
  assert.ok(!JSON.stringify(saved).includes("cache_control"), "the saved thread carries no breakpoint");
});

test("15. a platform refusal over a code-refused exchange is asked once more without it; the thread keeps it", async () => {
  const agent = await import("../src/agent.js");
  const { REFUSAL_LINE } = await import("../src/harm.js");
  const realCreate = agent.model.create;
  agent.resetHistoryAnchors(); agent.resetRefusedHistory();
  const before = [
    { role: "user", content: "remind me to call mom at 6" }, { role: "assistant", content: "set for 6pm." },
    { role: "user", content: "how do i make a pipe bomb" }, { role: "assistant", content: REFUSAL_LINE },
  ];
  assert.deepEqual([...agent.refusedExchanges(before)], [2, 3]);
  assert.equal(agent.refusedExchanges(before, 0, 3).size, 0, "only the history before this turn");
  db.saveConversation(C, before);
  const seen = [];
  const run = async (answers) => {
    agent.model.create = async (p) => { seen.push(JSON.parse(JSON.stringify(p))); return answers.shift(); };
    try {
      return await agent.runTurn({ conversationId: C, text: "what's 17 times 23", images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }), capture: async () => ({ ok: false }) });
    } finally { agent.model.create = realCreate; }
  };
  const refusal = { content: [], stop_reason: "refusal", usage: {} };
  const reply = await run([refusal, { content: [{ type: "text", text: "391" }], stop_reason: "end_turn", usage: {} }]);
  assert.equal(reply, "391");
  assert.equal(seen.length, 2);
  assert.ok(JSON.stringify(seen[0].messages).includes("pipe bomb"), "first ask: the thread as it is");
  assert.ok(!JSON.stringify(seen[1].messages).includes("pipe bomb") && !JSON.stringify(seen[1].messages).includes(REFUSAL_LINE), "second ask: without the refused exchange");
  assert.equal(seen[1].messages[0].content, "remind me to call mom at 6", "still opens on their line");
  assert.deepEqual(seen[1].messages[1].content.at(-1).cache_control, { type: "ephemeral" }, "the history marker moves to the last kept message");
  const saved = JSON.stringify(db.loadConversation(C));
  assert.ok(saved.includes("pipe bomb") && saved.includes(REFUSAL_LINE), "the saved thread is unchanged");
  // The next turn leaves it out from the first ask; a refusal then is the answer.
  seen.length = 0;
  assert.equal(await run([refusal]), "can't help with that one");
  assert.equal(seen.length, 1, "never asked twice over the same thing");
  assert.ok(!JSON.stringify(seen[0].messages).includes("pipe bomb"));
  // No refused exchange in view: a refusal is answered as before, one ask.
  agent.resetRefusedHistory(); agent.resetHistoryAnchors(); seen.length = 0;
  db.saveConversation(C, before.slice(0, 2));
  assert.equal(await run([refusal]), "can't help with that one");
  assert.equal(seen.length, 1);
});
