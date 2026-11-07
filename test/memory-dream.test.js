// The nightly memory review ("dreaming", src/dream.js) and the how-to-treat-me rules it keeps.
//
// Replays: each test writes a short thread into event_log the way the router does, saves the facts
// the extractor would have saved off it (with their source_message_ids), and answers the review with
// a scripted model — a function that reads the prompt it was really handed and answers on the schema,
// the way the CLI would. So what is tested is the prompt (did it see the source words, the ids) and
// what code does with an answer (cites checked, status machinery, nothing taken back revived).
//
//   (a) a wrong fact is corrected overnight, citing its source
//   (b) a paraphrase duplicate is merged
//   (c) a stale fact is retired by a later message
//   (d) a fact they took back never comes back
//   (e) a behaviour correction becomes a rule, and the next turn's prompt carries it
//   (f) past the 8-rule cap the review consolidates
//   (g) the CLI unavailable: the pass skips, and the billed API is never called
//   (h) the logs carry counts, never fact text
//
// No model, no network, no API key.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-dream-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Ama";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_BACKEND = "claude-cli";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const dream = await import("../src/dream.js");
const side = await import("../src/backends/side.js");
const { runTool } = await import("../src/tools.js");
const { memoryNotes } = await import("../src/memorynote.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const memory = await import("../src/memory.js");
const webmemory = await import("../src/pages/webmemory.js");
const { cliConfig, resetSideCalls, askStructuredViaCli } = await import("../src/backends/cli.js");
// Nothing in here may reach a real `claude`: a profile rebuild that tries gets a missing binary and scores instead.
cliConfig.bin = join(dir, "no-claude-here");

const C = "dm:dream-ama";
const OTHER = "dm:dream-kojo";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025550101", name: "Ama", isOperator: false });
db.upsertAccount({ conversationId: OTHER, channel: "test", address: "+12025550102", name: "Kojo", isOperator: false });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  process.env.REASON_BACKEND = "claude-cli";
  dream.resetDreams();
  side.setSideApiClient(null);
  db.db.exec(`DELETE FROM person_facts; DELETE FROM people; DELETE FROM event_log; DELETE FROM treat_rules;
    DELETE FROM memory_reviews; DELETE FROM memory_review_passes; DELETE FROM profile_blocks; DELETE FROM fact_embeddings; DELETE FROM conversations;`);
});

/** A thread, oldest first, as the router writes it. Returns the event ids. */
function thread(c, lines, { start = clock.now() - 3600_000 } = {}) {
  return lines.map(([role, content], i) => db.writeEvent({ conversationId: c, role, content, at: start + i * 60_000 }));
}
/** A fact as the extractor saves it, off message `from`. */
function saved(c, about, fact, from, { source = "inferred" } = {}) {
  return db.remember(c, about, fact, { source, confidence: 0.8, sourceMessageIds: [from] }).factId;
}
const status = (id) => db.db.prepare("SELECT status, superseded_by, source_message_ids FROM person_facts WHERE id = ?").get(id);
const active = (c) => db.activeFacts(c).map(f => f.fact);
/** The id in the prompt next to some words: `#12 [Ama] (...) words`. */
const idOf = (prompt, words) => Number(new RegExp(`#(\\d+) \\[[^\\]]*\\] \\([^)]*\\) ${words}`).exec(prompt)?.[1]);
const msgOf = (prompt, words) => Number(new RegExp(`\\[m(\\d+)\\] \\([^)]*\\): [^\\n]*${words}`).exec(prompt)?.[1]);
const empty = { facts: [], rules_new: [], rules_merge: [], rules_retire: [] };
const noRebuild = async () => {};

test("(a) a wrong fact is corrected overnight, citing the message it came from", async () => {
  const [m1, , m3] = thread(C, [
    ["user", "my sister Efua is coming down from Accra on friday"],
    ["assistant", "nice, want me to sort a pickup?"],
    ["user", "sorry typo — she's flying in from Kumasi not Accra"],
  ]);
  const wrong = saved(C, "Efua", "Flying in from Accra on Friday", m1);
  let seen = "";
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async ({ prompt }) => {
      seen = prompt;
      return { value: { ...empty, facts: [{ id: idOf(prompt, "Flying in from Accra"), action: "correct", wording: "Flying in from Kumasi on Friday", message: msgOf(prompt, "Kumasi") }] } };
    },
  });
  // The model was shown the fact with the words it was saved from.
  assert.match(seen, new RegExp(`#${wrong} \\[Efua\\][^\\n]*Accra[^]*from m${m1} \\(user\\): "my sister Efua is coming down from Accra`));
  assert.equal(out.corrected, 1);
  const old = status(wrong);
  assert.equal(old.status, "corrected", "the old row is kept, marked corrected");
  assert.ok(old.superseded_by, "and points at its replacement");
  assert.deepEqual(active(C), ["Flying in from Kumasi on Friday"]);
  assert.deepEqual(JSON.parse(status(old.superseded_by).source_message_ids), [m3], "the new row cites the message that justified it");
});

test("a change with no citation, or citing the assistant, is refused and the fact kept", async () => {
  const [m1, m2] = thread(C, [["user", "i live in harlem"], ["assistant", "you live in the bronx, right?"]]);
  const f = saved(C, "Ama", "Lives in Harlem", m1);
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => ({ value: { ...empty, facts: [
      { id: f, action: "correct", wording: "Lives in the Bronx", message: m2 },
      { id: f, action: "retire" },
    ] } }),
  });
  assert.equal(out.corrected, 0);
  assert.equal(out.retired, 0);
  assert.deepEqual(active(C), ["Lives in Harlem"]);
});

test("(b) a paraphrase duplicate is merged into the one that says it best", async () => {
  const [m1, m2] = thread(C, [["user", "i'm a nurse at mount sinai"], ["user", "night shifts at sinai this week, ugh"]]);
  const a = saved(C, "Ama", "Works as a nurse at Mount Sinai", m1);
  const b = saved(C, "Ama", "Is a Mount Sinai nurse", m2);
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async ({ prompt }) => ({ value: { ...empty, facts: [{ id: idOf(prompt, "Is a Mount Sinai nurse"), action: "merge", into: idOf(prompt, "Works as a nurse"), message: msgOf(prompt, "nurse at mount sinai") }] } }),
  });
  assert.equal(out.merged, 1);
  assert.deepEqual({ ...status(b), source_message_ids: undefined }, { status: "superseded", superseded_by: a, source_message_ids: undefined });
  assert.deepEqual(active(C), ["Works as a nurse at Mount Sinai"]);
});

test("a merge across two different people is refused", async () => {
  const [m1, m2] = thread(C, [["user", "kofi is a nurse"], ["user", "i'm a nurse too"]]);
  const k = saved(C, "Kofi", "Is a nurse", m1);
  const me = saved(C, "Ama", "Is a nurse", m2);
  const out = await dream.reviewOne(C, { rebuild: noRebuild, ask: async () => ({ value: { ...empty, facts: [{ id: k, action: "merge", into: me, message: m1 }] } }) });
  assert.equal(out.merged, 0);
  assert.equal(status(k).status, "active");
});

test("(c) a stale fact is retired by a later message", async () => {
  const [m1] = thread(C, [["user", "training for the brooklyn half in april"]], { start: clock.now() - 20 * 86400_000 });
  const stale = saved(C, "Ama", "Training for the Brooklyn Half in April", m1);
  db.markMemoryReview(C, { day: "2026-10-01", lastEventId: m1 });
  thread(C, [["user", "ran the half on sunday!! 2:04, done with races for a while"]]);
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async ({ prompt }) => ({ value: { ...empty, facts: [{ id: idOf(prompt, "Training for the Brooklyn Half"), action: "retire", message: msgOf(prompt, "ran the half") }] } }),
  });
  assert.equal(out.retired, 1);
  assert.equal(status(stale).status, "superseded", "retired, not deleted");
  assert.deepEqual(active(C), []);
  assert.ok(db.db.prepare("SELECT 1 FROM person_facts WHERE id = ?").get(stale), "never hard-deleted");
});

test("(d) a fact they took back never comes back — not from the review, not from the extractor", async () => {
  const [m1, m2] = thread(C, [["user", "i'm vegetarian"], ["user", "actually forget that, i eat fish"]]);
  const veg = saved(C, "Ama", "Is vegetarian", m1);
  const fish = saved(C, "Ama", "Eats fish", m2);
  await runTool("memory_drop", { row: "fact", id: veg }, { conversationId: C, messages: [] });
  assert.equal(status(veg).status, "deleted");
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async ({ prompt }) => {
      assert.doesNotMatch(prompt, /#\d+ \[Ama\][^\n]*Is vegetarian/, "a taken-back row is not even shown as a fact");
      return { value: { ...empty, facts: [{ id: fish, action: "correct", wording: "Is vegetarian", message: m1 }] } };
    },
  });
  assert.equal(out.corrected, 0);
  assert.equal(out.refused, 1);
  assert.equal(status(veg).status, "deleted");
  assert.deepEqual(active(C), ["Eats fish"]);
  // The extractor restating it is refused too (db.remember), as before.
  assert.equal(db.remember(C, "Ama", "Is vegetarian", { source: "inferred" }).refused, "taken_back");
});

test("(d) a rule they deleted is never brought back by the review", async () => {
  const [m1] = thread(C, [["user", "stop sending me 3 options, just pick one"]]);
  const made = await runTool("remember", { about: "Ama", fact: "Pick one option instead of sending three", kind: "how_to_treat_me", why: "said three was too many" }, { conversationId: C, messages: [] });
  assert.equal(made.ok, true);
  await runTool("memory_drop", { row: "rule", id: made.rule_id }, { conversationId: C, messages: [] });
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => ({ value: { ...empty, rules_new: [{ rule: "Pick one option instead of sending three", why: "transcript", message: m1 }] } }),
  });
  assert.equal(out.rules_added, 0);
  assert.equal(db.activeRules(C).length, 0);
});

test("(e) a behaviour correction becomes a rule in-turn, and the next turn's prompt carries it", async () => {
  thread(C, [["assistant", "morning! 3 picks for dinner tonight: ..."], ["user", "pls don't text me before 9, i'm asleep. and just give me the price first"]]);
  const r = await runTool("remember", { about: "Ama", fact: "Don't text before 9am", kind: "how_to_treat_me", why: "was asleep when a morning text came" }, { conversationId: C, messages: [] });
  assert.equal(r.ok, true);
  const row = db.getRule(C, r.rule_id);
  assert.equal(row.source_message_id, db.latestUserEventId(C), "it cites the message it came from");
  assert.ok(row.created_at && row.why);
  assert.equal(active(C).length, 0, "a rule is not a fact");

  let prompt = "";
  await runTurnViaCli({
    conversationId: C, text: "any good ramen near me?",
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    recall: (c, text, o) => memoryNotes(c, text, { ...o, enabled: false }),
    run: async (args) => { prompt = args.prompt; return { ok: true, envelope: { result: "on it" } }; },
  });
  assert.match(prompt, /HOW THEY WANT YOU TO TREAT THEM[^]*- Don't text before 9am/);
  // Sealed: another person's turn never sees it.
  const theirs = await memoryNotes(OTHER, "hi", { enabled: false });
  assert.doesNotMatch(theirs.join("\n"), /text before 9am/);
});

test("(e) the review turns a correction in the transcript into a rule, shown on the memory page with delete", async () => {
  thread(C, [["assistant", "here's a long breakdown of all 6 flights..."], ["user", "too long. lead with the cheapest one and the price"]]);
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async ({ prompt }) => ({ value: { ...empty, rules_new: [{ rule: "Lead with the cheapest option and its price", why: "said a long flight breakdown was too long", message: msgOf(prompt, "lead with the cheapest") }] } }),
  });
  assert.equal(out.rules_added, 1);
  const notes = await memoryNotes(C, "flights to accra?", { enabled: false });
  assert.match(notes.join("\n"), /Lead with the cheapest option and its price/);
  // The memory page (text) lists it with its number; the Web page draws it with CORRECT/FORGET.
  const page = await runTool("memory_page", {}, { conversationId: C, messages: [] });
  assert.equal(page.counts.rules, 1);
  assert.match(JSON.stringify(page.page_blocks), /How you want me to treat you[^]*Lead with the cheapest/);
  const view = webmemory.memoryView({ conversation_id: C, name: "Ama" });
  const g = view.groups.find(x => x.key === "rules");
  assert.equal(g.rows.length, 1);
  assert.match(webmemory.rowHtml(g.rows[0]), /forget=rule-\d+/);
  assert.equal((await webmemory.forgetRow(C, g.rows[0].key)).ok, true);
  assert.equal(db.activeRules(C).length, 0);
  // Another person cannot reach it by its key.
  assert.equal(webmemory.findRow(OTHER, g.rows[0].key), null);
});

test("(f) past the 8-rule cap the review consolidates", async () => {
  const ids = thread(C, Array.from({ length: 10 }, (_, i) => ["user", `rule ask number ${i}`]));
  for (let i = 0; i < 10; i++) {
    const r = db.addRule(C, { rule: `Rule ${i}`, why: "asked", sourceMessageId: ids[i], at: clock.now() - (10 - i) * 1000 });
    assert.equal(r.ok, true);
  }
  let seen = "";
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async ({ prompt, system }) => {
      seen = `${system}\n${prompt}`;
      const r = (n) => Number(new RegExp(`R(\\d+) \\([^)]*\\) Rule ${n}\\b`).exec(prompt)[1]);
      return { value: { ...empty, rules_merge: [{ ids: [r(0), r(1), r(2)], rule: "Rules 0-2 together", why: "they overlap", message: ids[2] }] } };
    },
  });
  assert.match(seen, /at most 8/);
  assert.equal(out.rules_merged, 3);
  const live = db.activeRules(C);
  assert.equal(live.length, 8);
  assert.ok(live.some(r => r.rule === "Rules 0-2 together"));
  const folded = db.db.prepare("SELECT status, superseded_by FROM treat_rules WHERE conversation_id = ? AND rule = 'Rule 0'").get(C);
  assert.equal(folded.status, "superseded");
  assert.equal(folded.superseded_by, live.find(r => r.rule === "Rules 0-2 together").id);
});

test("(f) when the model does not consolidate, code still holds the cap (oldest go first)", async () => {
  thread(C, [["user", "hi"]]);
  for (let i = 0; i < 11; i++) db.addRule(C, { rule: `Rule ${i}`, at: clock.now() - (11 - i) * 1000 });
  const out = await dream.reviewOne(C, { rebuild: noRebuild, ask: async () => ({ value: empty }) });
  assert.equal(out.rules_capped, 3);
  assert.equal(db.activeRules(C).length, 8);
  assert.ok(!db.activeRules(C).some(r => ["Rule 0", "Rule 1", "Rule 2"].includes(r.rule)));
  // In-turn, the ceiling holds too.
  for (let i = 0; i < 4; i++) db.addRule(C, { rule: `More ${i}` });
  const over = await runTool("remember", { about: "Ama", fact: "One more", kind: "how_to_treat_me" }, { conversationId: C, messages: [] });
  assert.equal(over.ok, false);
  assert.equal(over.refused, "too_many");
});

test("(g) the CLI unavailable: the pass skips quietly and never calls the API", async () => {
  let apiCalls = 0;
  side.setSideApiClient({ messages: { create: async () => { apiCalls++; return { content: [] }; } } });
  const [m1] = thread(C, [["user", "i moved to denver"]]);
  saved(C, "Ama", "Lives in Boston", m1);

  // On the API backend there is no review at all: not swept, not asked.
  process.env.REASON_BACKEND = "api";
  dream.setDreamAsk(async () => { throw new Error("must not be asked"); });
  assert.equal(dream.sweepDreams({ now: Date.parse("2026-11-07T09:30:00Z") }).skipped, "not_on_cli");
  assert.equal((await dream.reviewOne(C)).skipped, "not_on_cli");

  // On the CLI backend with the CLI signed out: skipped, the night marked, the watermark unmoved.
  process.env.REASON_BACKEND = "claude-cli";
  const logs = [];
  const out = await dream.reviewOne(C, { rebuild: noRebuild, log: (l) => logs.push(l), ask: async () => ({ error: "the CLI reported an error: Not logged in · Please run /login" }) });
  assert.equal(out.skipped, "cli_unavailable");
  assert.equal(db.memoryReviewState(C).last_event_id, 0, "the same messages are read the next night");
  assert.deepEqual(active(C), ["Lives in Boston"]);
  assert.equal(apiCalls, 0, "the billed API was never called");
});

test("the sweep queues one review per person at their quiet hour, once a night, never two at once", async () => {
  thread(C, [["user", "hello"]]);
  thread(OTHER, [["user", "hey"]]);
  db.setNoticeWindow(OTHER, { tz: "Asia/Tokyo" });
  assert.equal(dream.dreamZone(OTHER), "Asia/Tokyo");
  assert.equal(dream.dreamZone(C), "America/New_York");
  const queued = [];
  const hold = [];
  const queue = (key, fn) => { queued.push(key); return new Promise(res => hold.push(() => res(fn()))); };
  dream.setDreamAsk(async () => ({ value: empty }));
  // 4:30am in New York.
  const at = Date.parse("2026-11-07T09:30:00Z");
  const first = dream.sweepDreams({ now: at, queue });
  assert.ok(queued.includes(`dream:${C}`));
  assert.ok(!queued.includes(`dream:${OTHER}`), "6:30pm in Tokyo is not their quiet hour");
  assert.ok(first.queued >= 1);
  // While it is in flight, a second sweep does not queue it again.
  const n = queued.length;
  dream.sweepDreams({ now: at + 15_000, queue });
  assert.equal(queued.length, n, "never overlaps itself");
  for (const go of hold) go();
  await new Promise(r => setTimeout(r, 20));
  // Done for tonight.
  assert.equal(dream.sweepDreams({ now: at + 60_000, queue }).queued, 0);
  // Midday is not the quiet hour.
  db.db.exec("DELETE FROM memory_reviews");
  assert.equal(dream.sweepDreams({ now: Date.parse("2026-11-07T17:00:00Z"), queue: () => Promise.resolve() }).queued, 0);
});

test("the input is capped per person", async () => {
  thread(C, Array.from({ length: 400 }, (_, i) => ["user", `message ${i} `.repeat(40)]));
  let size = 0;
  const out = await dream.reviewOne(C, { rebuild: noRebuild, ask: async ({ prompt }) => { size = prompt.length; return { value: empty }; } });
  assert.ok(out.messages <= dream.MAX_MESSAGES);
  assert.ok(size < dream.MAX_TRANSCRIPT_CHARS + 20_000, `${size} chars`);
  assert.equal(out.more, true, "the rest waits for the next night");
});

test("(h) logs carry counts and outcomes, never a fact, a rule or a message", async () => {
  const [m1, , m3] = thread(C, [
    ["user", "my therapist dr. okafor moved my session to thursdays"],
    ["assistant", "noted"],
    ["user", "never call me before noon, i work nights"],
  ]);
  saved(C, "Ama", "Sees Dr. Okafor on Tuesdays", m1);
  const logs = [];
  await dream.reviewOne(C, {
    rebuild: noRebuild, log: (l) => logs.push(l),
    ask: async ({ prompt }) => ({ value: { ...empty,
      facts: [{ id: idOf(prompt, "Sees Dr. Okafor"), action: "correct", wording: "Sees Dr. Okafor on Thursdays", message: m1 }],
      rules_new: [{ rule: "Never call before noon", why: "works nights", message: m3 }] } }),
  });
  await dream.reviewOne(C, { rebuild: noRebuild, log: (l) => logs.push(l), ask: async () => ({ error: "could not run 'claude': spawn claude ENOENT — Sees Dr. Okafor" }) });
  const all = JSON.stringify(logs);
  assert.match(all, /"memory_review":"done"/);
  for (const words of ["Okafor", "Thursdays", "Tuesdays", "therapist", "noon", "nights"]) {
    assert.ok(!all.includes(words), `"${words}" reached the log`);
  }
});

test("every pass records, per person: model, tokens, API-equivalent $, and counts (CLI envelope, end to end)", async () => {
  const [m1, , m3] = thread(C, [
    ["user", "my therapist dr. okafor moved my session to thursdays"],
    ["assistant", "noted"],
    ["user", "never call me before noon, i work nights"],
  ]);
  const f = saved(C, "Ama", "Sees Dr. Okafor on Tuesdays", m1);
  // A stand-in `claude` that answers the way the real one does with --output-format json.
  const answer = { ...empty, facts: [{ id: f, action: "correct", wording: "Sees Dr. Okafor on Thursdays", message: m1 }],
    rules_new: [{ rule: "Never call before noon", why: "works nights", message: m3 }] };
  const envelope = { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", num_turns: 1, result: "",
    structured_output: answer, total_cost_usd: 0.0731,
    usage: { input_tokens: 12, output_tokens: 840, cache_read_input_tokens: 9000, cache_creation_input_tokens: 4100 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 12, outputTokens: 840, costUSD: 0.0731 } } };
  const fake = join(dir, "claude-dream.sh");
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho '${JSON.stringify(envelope).replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
  const savedBin = cliConfig.bin;
  cliConfig.bin = fake;
  resetSideCalls();
  process.env.REASON_DREAM_CLI_MODEL = "claude-opus-5-5";
  const asked = [];
  dream.setDreamAsk((args) => { asked.push(args.model); return askStructuredViaCli(args); });
  const logs = [];
  try {
    const out = await dream.reviewOne(C, { rebuild: noRebuild, log: (l) => logs.push(l) });
    assert.equal(out.corrected, 1);
    assert.equal(out.rules_added, 1);
  } finally { cliConfig.bin = savedBin; delete process.env.REASON_DREAM_CLI_MODEL; }
  assert.deepEqual(asked, ["claude-opus-5-5"], "the model env is read on the pass");

  const [pass] = db.memoryReviewPasses(C);
  assert.equal(pass.model, "claude-opus-5-5");
  assert.equal(pass.outcome, "reviewed");
  assert.deepEqual([pass.input_tokens, pass.output_tokens, pass.cache_read_tokens, pass.cache_write_tokens], [12, 840, 9000, 4100]);
  assert.equal(pass.cost_usd, 0.0731);
  assert.equal(pass.cost_from, "cli");
  assert.deepEqual([pass.messages, pass.facts, pass.corrected, pass.merged, pass.retired, pass.rules_added, pass.rules_retired], [3, 1, 1, 0, 0, 1, 0]);
  const state = db.memoryReviewState(C);
  assert.equal(state.last_model, "claude-opus-5-5");
  assert.equal(state.last_cost_usd, 0.0731);

  const done = logs.find(l => l.memory_review === "done");
  assert.equal(done.model, "claude-opus-5-5");
  assert.equal(done.cost_usd, 0.0731);
  assert.deepEqual([done.input_tokens, done.output_tokens, done.cache_read_tokens, done.cache_write_tokens], [12, 840, 9000, 4100]);
  assert.equal(done.corrected, 1);
  // Counts only, in the log and in the table.
  const all = JSON.stringify(logs) + JSON.stringify(db.memoryReviewPasses(C));
  for (const words of ["Okafor", "Thursdays", "Tuesdays", "therapist", "noon", "nights"]) assert.ok(!all.includes(words), `"${words}" was recorded`);
});

test("the boot line says the review is armed, its model and the next 4am New York window", () => {
  process.env.REASON_DREAM_CLI_MODEL = "claude-opus-5-5";
  try {
    const l = dream.armedLine({ now: Date.parse("2026-11-07T23:00:00Z") });
    assert.equal(l.memory_review, "armed");
    assert.equal(l.model, "claude-opus-5-5");
    assert.equal(l.next_default_window, "2026-11-08T09:00:00.000Z", "4am EST on Nov 8");
  } finally { delete process.env.REASON_DREAM_CLI_MODEL; }
});

test("with no $ from the CLI, the pass is priced off its tokens; a skipped pass is still a row", async () => {
  const [m1] = thread(C, [["user", "hello"]]);
  saved(C, "Ama", "Says hello", m1);
  await dream.reviewOne(C, { rebuild: noRebuild, ask: async () => ({ value: empty, models: ["claude-sonnet-5-5"],
    usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) });
  const [p] = db.memoryReviewPasses(C);
  assert.equal(p.model, "claude-sonnet-5-5");
  assert.equal(p.cost_from, "tokens");
  assert.ok(Math.abs(p.cost_usd - 3) < 1e-9, `${p.cost_usd}: $2/M in + $10/M out`);
  thread(C, [["user", "again"]]);
  await dream.reviewOne(C, { rebuild: noRebuild, ask: async () => ({ error: "Not logged in · Please run /login" }) });
  const rows = db.memoryReviewPasses(C);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].outcome, "skipped:cli_unavailable");
  assert.equal(rows[1].cost_usd, null);
});

test("the review only ever reads one person's own thread and facts", async () => {
  const [mine] = thread(C, [["user", "my dog is called Biscuit"]]);
  const [theirs] = thread(OTHER, [["user", "my cat is called Pepper"]]);
  saved(C, "Ama", "Has a dog called Biscuit", mine);
  const other = saved(OTHER, "Kojo", "Has a cat called Pepper", theirs);
  let prompt = "";
  const out = await dream.reviewOne(C, { rebuild: noRebuild, ask: async (a) => { prompt = a.prompt; return { value: { ...empty, facts: [{ id: other, action: "retire", message: theirs }] } }; } });
  assert.doesNotMatch(prompt, /Pepper|Kojo/);
  assert.equal(out.retired, 0);
  assert.equal(status(other).status, "active");
});

test("the memory page answer counts rules as something known", () => {
  db.addRule(C, { rule: "Keep it short", why: "asked" });
  const got = memory.remembered({ conversationId: C });
  assert.equal(got.counts.rules, 1);
  assert.match(memory.answerNote(got), /treat them/);
});
