// Memory quality, 2026-10-19. Six ways what Reason remembered drifted from what is true, one pinned
// test (or a small group) each:
//
//   a changed fact retires the one it replaces, and only that one                        (extract.js)
//   something they dropped or corrected is not brought back by the extractor              (db.remember)
//   a reply that was never sent is not mined for facts                                    (runtime.js)
//   "no" to meal logging stays no, and "stop the numbers" never falls off a list          (tools.js)
//   the extractor is shown what is known about the people in the messages, at any age    (extract.js)
//   a fact whose embedding failed gets one on a later pass                                (extract.js)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-memq-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const db = await import("../src/db.js");
const extract = await import("../src/extract.js");
const { runTool } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { clock } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const status = id => db.db.prepare("SELECT status, superseded_by FROM person_facts WHERE id = ?").get(id);

// ---------- 1. a changed fact retires the old one ----------
//
// The extractor was asked for "the new state in full" when something changed, and the new state was
// saved beside the old: "Gmail being reconnected" and "Gmail now connected" both active, both read
// back as true. Only a manual memory_fix ever retired anything.

test("a fact the extractor says replaces a shown one retires it, pointing at the new one", async () => {
  const C = "c-replace";
  const old = db.remember(C, "Ama", "Lives in Accra", { source: "inferred" });
  await extract.validateAndInsert(C, [
    { about: "Ama", fact: "Lives in Kumasi now", category: "location", confidence: 0.9, replaces: old.factId },
  ], [], [], [], { shown: new Set([old.factId]) });

  const now = db.activeFacts(C).map(f => f.fact);
  assert.deepEqual(now, ["Lives in Kumasi now"]);
  const was = status(old.factId);
  assert.equal(was.status, "superseded");
  assert.equal(db.getFact(C, was.superseded_by)?.fact, "Lives in Kumasi now");
});

test("a replaces number the extractor was not shown, or about someone else, retires nothing", async () => {
  const C = "c-replace-guard";
  const ama = db.remember(C, "Ama", "Lives in Accra", { source: "inferred" });
  const kofi = db.remember(C, "Kofi", "Works at Google", { source: "inferred" });
  const other = db.remember("c-someone-else", "Yaw", "Drives a Civic", { source: "inferred" });

  await extract.validateAndInsert(C, [
    // Not among the rows shown this turn.
    { about: "Ama", fact: "Has a dog", category: "other", confidence: 0.9, replaces: ama.factId },
    // Shown, but about a different person than the new fact.
    { about: "Ama", fact: "Works at Stripe", category: "work", confidence: 0.9, replaces: kofi.factId },
    // Another conversation's row.
    { about: "Ama", fact: "Rides a bike", category: "other", confidence: 0.9, replaces: other.factId },
  ], [], [], [], { shown: new Set([kofi.factId, other.factId]) });

  assert.equal(status(ama.factId).status, "active");
  assert.equal(status(kofi.factId).status, "active");
  assert.equal(status(other.factId).status, "active");
  assert.equal(db.activeFacts(C).length, 5);
});

test("the extractor is shown each known fact with its number, so it can say which one changed", () => {
  const C = "c-ids";
  const saved = db.remember(C, "Irene", "nursing BSN student", { source: "inferred" });
  assert.match(extract.knownAlready(C), new RegExp(`^- #${saved.factId} nursing BSN student$`, "m"));
});

// ---------- 2. what they took back stays taken back ----------

test("an inferred restatement of a fact they dropped or corrected does not bring it back", () => {
  const C = "c-takenback";
  const dropped = db.remember(C, "Kwesi", "Is vegetarian");
  db.dropFact(C, dropped.factId);
  const corrected = db.remember(C, "Kwesi", "Lives in Brooklyn");
  db.correctFact(C, corrected.factId, { fact: "Lives in Queens" });

  const again = db.remember(C, "Kwesi", "Is vegetarian", { source: "inferred" });
  assert.equal(again.factId, null);
  assert.equal(again.refused, "taken_back");
  assert.equal(status(dropped.factId).status, "deleted");

  const back = db.remember(C, "Kwesi", "lives in brooklyn.", { source: "inferred" });
  assert.equal(back.refused, "taken_back");
  assert.equal(status(corrected.factId).status, "corrected");

  assert.deepEqual(db.activeFacts(C).map(f => f.fact), ["Lives in Queens"]);
});

test("they can still bring back something they dropped by saying it themselves", () => {
  const C = "c-takenback-said";
  const dropped = db.remember(C, "Kwesi", "Is vegetarian");
  db.dropFact(C, dropped.factId);
  const said = db.remember(C, "Kwesi", "Is vegetarian", { source: "user_stated" });
  assert.equal(said.factId, dropped.factId);
  assert.equal(status(dropped.factId).status, "active");
});

// ---------- 3. a draft nobody read is not a memory ----------

test("a reply that was held back is logged but not sent for extraction; a sent one is", async () => {
  const C = "dm:owner";
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  const replies = ["DRAFT: Omari is moving to Lisbon", "SENT: your train is on time"];
  const rt = new Runtime({ runTurn: async () => replies.shift(), deliver: async () => ({ ok: true }) });
  try {
    await rt._turn({ conversationId: C, text: "sweep", kind: "event", shouldSend: () => false });
    await rt._turn({ conversationId: C, text: "sweep", kind: "event", shouldSend: () => true });
  } finally {
    rt.stop?.();
  }
  const queued = db.db.prepare(`SELECT e.content FROM extraction_queue q JOIN event_log e ON e.id = q.event_log_id
    WHERE q.conversation_id = ? AND e.role = 'assistant'`).all(C).map(r => r.content);
  assert.deepEqual(queued, ["SENT: your train is on time"]);
  const logged = db.db.prepare("SELECT content FROM event_log WHERE conversation_id = ? AND role = 'assistant'").all(C).map(r => r.content);
  assert.ok(logged.includes("DRAFT: Omari is moving to Lisbon"), "the draft is still on the event log");
});

// ---------- 4. meal logging: the latest answer is the answer ----------

const MEAL = {
  type: "plate", items: ["jollof rice"], kcal_low: 400, kcal_likely: 550, kcal_high: 700,
  protein_g: 12, carbs_g: 80, fat_g: 18, confidence: "medium",
};

test("say no to meal logging after a yes and it stays off; yes again turns it back on", async () => {
  const conversationId = "c-meals";
  const ctx = { conversationId };
  await runTool("meal_log_consent", { consent: "yes" }, ctx);
  assert.equal((await runTool("meal_estimate", MEAL, ctx)).logged, true);

  await runTool("meal_log_consent", { consent: "no" }, ctx);
  assert.equal((await runTool("meal_estimate", MEAL, ctx)).logged, false);

  clock.skip(60_000);
  await runTool("meal_log_consent", { consent: "yes" }, ctx);
  assert.equal((await runTool("meal_estimate", MEAL, ctx)).logged, true);
  clock.reset();

  // One row for the setting, not one per answer.
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE conversation_id = ? AND category = 'meal_logging'").get(conversationId).n, 1);
});

test("stop showing calorie numbers holds after thirty newer preferences", async () => {
  const conversationId = "c-meal-numbers";
  const ctx = { conversationId };
  await runTool("meal_log_consent", { consent: "stop_numbers" }, ctx);
  for (let i = 0; i < 35; i++) {
    db.learnPreference(conversationId, { category: "price", words: `too pricey ${i}`, turnedDown: `place ${i}` });
  }
  const out = await runTool("meal_estimate", MEAL, ctx);
  assert.equal(out.ok, false);
  assert.match(out.error, /stop giving calorie numbers/);
});

// ---------- 5. the extractor sees what is known about the people in front of it ----------

test("an old fact about someone named in the messages is shown as known, past the newest forty", () => {
  const C = "c-long";
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+15550009999", name: "Esi" });
  db.remember(C, "Kofi Mensah", "Plays the trumpet", { source: "inferred" });
  db.remember(C, "Esi", "Grew up in Takoradi", { source: "inferred" });
  clock.skip(90 * 86_400_000);
  for (let i = 0; i < 50; i++) db.remember(C, "Yaa", `Likes song number ${i}`, { source: "inferred" });

  // Before: only the newest 40, so neither old fact was on the list.
  const quiet = extract.knownAlready(C, { text: "user: what time is it" });
  assert.doesNotMatch(quiet, /trumpet/);
  // The account holder's facts are always there.
  assert.match(quiet, /Grew up in Takoradi/);

  const named = extract.knownAlready(C, { text: "user: going to see Kofi tonight" });
  assert.match(named, /Plays the trumpet/);
  clock.reset();
});

// ---------- 6. a fact with no embedding gets one ----------

test("an active fact with no embedding is embedded on the next pass; a dropped one is not", async () => {
  const C = "c-embed";
  const a = db.remember(C, "Abena", "Runs marathons");
  const b = db.remember(C, "Abena", "Has a cat");
  db.dropFact(C, b.factId);
  const asked = [];
  const embedFn = async texts => { asked.push(...texts); return texts.map(() => new Float32Array([1, 0, 0])); };

  const n = await extract.backfillEmbeddings({ embedFn, limit: 500 });
  assert.ok(n >= 1);
  assert.ok(asked.includes("Abena: Runs marathons"));
  assert.ok(!asked.includes("Abena: Has a cat"));
  assert.ok(db.db.prepare("SELECT 1 FROM fact_embeddings WHERE fact_id = ?").get(a.factId));

  // Nothing left to do: no call at all.
  asked.length = 0;
  assert.equal(await extract.backfillEmbeddings({ embedFn, limit: 500 }), 0);
  assert.equal(asked.length, 0);
});
