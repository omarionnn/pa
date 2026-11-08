// The nightly memory review (src/dream.js) and what the person asked Reason to forget.
//
// A forget (src/db.js forgetPerson) marks every line naming the subject in recall_forgotten and tells
// them it is "deleted and not coming back". The review is a model pass over their thread that can
// write standing rules and correct facts, so it must never read those lines, never cite them, and a
// rule naming the subject must not outlive the forget. A rule they forgot on the Web memory page stays
// gone too: the review cannot re-learn it, not even reworded, off the message it came from.
//
// No model, no network, no API key: the review is answered by a scripted function.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-dream-forgotten-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Ama";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_BACKEND = "claude-cli";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const dream = await import("../src/dream.js");
const { runTool } = await import("../src/tools.js");
const webmemory = await import("../src/pages/webmemory.js");
const { cliConfig } = await import("../src/backends/cli.js");
cliConfig.bin = join(dir, "no-claude-here");

const C = "dm:dream-forget-ama";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025550111", name: "Ama", isOperator: false });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  dream.resetDreams();
  db.db.exec(`DELETE FROM person_facts; DELETE FROM people; DELETE FROM event_log; DELETE FROM treat_rules; DELETE FROM recall_forgotten;
    DELETE FROM memory_reviews; DELETE FROM memory_review_passes; DELETE FROM fact_embeddings; DELETE FROM conversations;`);
});

function thread(lines, { start = clock.now() - 3600_000 } = {}) {
  return lines.map(([role, content], i) => db.writeEvent({ conversationId: C, role, content, at: start + i * 60_000 }));
}
const empty = { facts: [], rules_new: [], rules_merge: [], rules_retire: [] };
const noRebuild = async () => {};

test("a forgotten line is never in the review's prompt, as a period message or as a fact's source", async () => {
  const [src] = thread([["user", "my brother Kofi drove Yaw to the airport, Kofi lives in Tema"]], { start: clock.now() - 7200_000 });
  db.remember(C, "Kofi", "Lives in Tema", { source: "inferred", confidence: 0.8, sourceMessageIds: [src] });
  db.remember(C, "Yaw", "Is my ex", { source: "user_stated" });
  db.markMemoryReview(C, { day: "", lastEventId: src, outcome: "reviewed" });
  const [m1, , m3] = thread([
    ["user", "never text Yaw for me, and stop mentioning Yaw at all"],
    ["assistant", "understood"],
    ["user", "what's the weather tomorrow"],
  ]);
  const gone = await runTool("forget", { about: "Yaw" }, { conversationId: C, messages: [] });
  assert.equal(gone.ok, true);

  let prompt = "";
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async (a) => {
      prompt = a.prompt;
      const kofi = Number(/#(\d+) \[Kofi\]/.exec(prompt)?.[1]);
      return { value: { ...empty,
        facts: [{ id: kofi, action: "correct", wording: "Drove Yaw to the airport", message: src }],
        rules_new: [{ rule: "Never text Yaw", why: "asked", message: m1 }] } };
    },
  });
  assert.ok(prompt, "the review ran");
  assert.doesNotMatch(prompt, /Yaw/, "nothing they forgot is read by the review");
  assert.match(prompt, new RegExp(`\\[m${m3}\\]`), "the rest of the period is still read");
  assert.match(prompt, /Lives in Tema/);
  assert.equal(out.rules_added, 0);
  assert.equal(out.corrected, 0);
  assert.equal(db.activeRules(C).length, 0);
  assert.deepEqual(db.activeFacts(C).map(f => f.fact), ["Lives in Tema"]);
});

test("a forget retires a standing rule that names the subject; the review cannot bring it back", async () => {
  const [m1] = thread([["user", "always cc Yaw on dinner plans"]]);
  db.remember(C, "Yaw", "Is my ex", { source: "user_stated" });
  const named = db.addRule(C, { rule: "Always cc Yaw on dinner plans", sourceMessageId: m1, source: "they_said" }).rule.id;
  const other = db.addRule(C, { rule: "Lead with the price", source: "they_said" }).rule.id;
  const gone = db.forgetPerson(C, "yaw");
  assert.equal(gone.ok, true);
  assert.equal(gone.rules_dropped, 1);
  assert.deepEqual(db.activeRules(C).map(r => r.id), [other], "only the rule naming Yaw goes");
  assert.equal(db.db.prepare("SELECT status FROM treat_rules WHERE id = ?").get(named).status, "deleted");
  // Not even a later review citing an unforgotten line can restore that wording.
  const [m2] = thread([["user", "ok thanks"]], { start: clock.now() - 60_000 });
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => ({ value: { ...empty, rules_new: [{ rule: "Always cc Yaw on dinner plans", why: "x", message: m2 }] } }),
  });
  assert.equal(out.rules_added, 0);
  assert.deepEqual(db.activeRules(C).map(r => r.id), [other]);
});

test("a forget with nobody saved still retires a rule naming the subject", () => {
  thread([["user", "text Yaw when I land"]]);
  db.addRule(C, { rule: "Text Yaw when I land", source: "they_said" });
  const gone = db.forgetPerson(C, "Yaw");
  assert.equal(gone.ok, true);
  assert.equal(gone.rules_dropped, 1);
  assert.equal(db.activeRules(C).length, 0);
});

test("a rule forgotten on the Web memory page is not re-learned by the review, not even reworded", async () => {
  const [m1] = thread([["user", "stop sending me three options, just pick one"]]);
  const r = db.addRule(C, { rule: "Pick one option instead of three", sourceMessageId: m1, source: "they_said" }).rule.id;
  assert.equal((await webmemory.forgetRow(C, `rule-${r}`)).ok, true);
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => ({ value: { ...empty, rules_new: [{ rule: "Only ever suggest a single option", why: "said three was too many", message: m1 }] } }),
  });
  assert.equal(out.rules_added, 0);
  assert.equal(db.activeRules(C).length, 0);
});
