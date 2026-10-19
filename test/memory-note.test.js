// What Reason already knows about someone reaches the live model, and what reaches it is worth
// reading.
//
// The incident (2026-10-19): every fact was extracted, deduplicated, embedded and searchable, and
// the live Reason — the CLI backend — was shown none of it. Only the API path put the profile and
// the closest memories in front of the model. And the profile itself, once looked at, opened with a
// late-night snack and spent six of its fifteen lines on getting into Speedrun, in six wordings.
//
// No model and no embedding call anywhere in here: vectors are written by hand and the search is
// injected. What is tested is what the model is handed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-memnote-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;

const { config } = await import("../src/config.js");
const db = await import("../src/db.js");
const { embedAndStore } = await import("../src/embedding.js");
const { rebuildProfile } = await import("../src/extract.js");
const { memoryNotes } = await import("../src/memorynote.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");

/** A unit vector along `axis`, nudged toward `toward` by `lean` — cosine with `axis` is ~cos(lean). */
function vec(axis, toward = null, lean = 0) {
  const v = new Float32Array(16);
  v[axis] = Math.cos(lean);
  if (toward != null) v[toward] = Math.sin(lean);
  return v;
}

function fact(c, about, text, { vector, category = "work", source = "inferred" } = {}) {
  const r = db.remember(c, about, text, { source, category });
  const id = r.id ?? r.factId ?? r;
  if (vector) embedAndStore(c, id, text, { vector });
  return id;
}

// ---------- the profile ----------

test("six wordings of one thing take one line of the profile, not six", async () => {
  const C = "c-speedrun";
  fact(C, "Omari", "Got into Speedrun after the video, 10-minute and 30-minute rounds", { vector: vec(0) });
  fact(C, "Omari", "Got accepted into Speedrun", { vector: vec(0, 1, 0.2) });          // ~0.98
  fact(C, "Omari", "Got accepted into Y Combinator's speedrun program", { vector: vec(0, 2, 0.3) }); // ~0.96
  fact(C, "Omari", "Lives in Brooklyn", { vector: vec(5), category: "location" });

  await rebuildProfile(C);
  const block = db.getProfile(C).block;

  assert.equal((block.match(/speedrun/gi) ?? []).length, 1, block);
  assert.match(block, /10-minute and 30-minute/, "the line that says most is the one kept");
  assert.match(block, /Lives in Brooklyn/);
  // One heading, however many facts sit under it.
  assert.equal(block.match(/^\*\*Omari\*\*$/gm).length, 1);
});

test("two accounts that differ by one character are both kept, however close they sit", async () => {
  const C = "c-gmail";
  fact(C, "Omari", "Has Gmail account omariij16@gmail.com", { vector: vec(0), category: "identity" });
  fact(C, "Omari", "Has Gmail account omariij25@gmail.com", { vector: vec(0, 1, 0.2), category: "identity" });

  await rebuildProfile(C);
  const block = db.getProfile(C).block;

  assert.match(block, /omariij16/);
  assert.match(block, /omariij25/);
});

test("what lasts outranks what was true for an evening", async () => {
  const C = "c-lasting";
  const max = config.profileMaxFacts;
  config.profileMaxFacts = 1;
  try {
    fact(C, "Omari", "Is vegetarian", { category: "health" });
    fact(C, "Omari", "Snacking on roasted cashews", { category: "other" });
    await rebuildProfile(C);
  } finally {
    config.profileMaxFacts = max;
  }
  const block = db.getProfile(C).block;
  assert.match(block, /vegetarian/);
  assert.doesNotMatch(block, /cashews/);
});

test("every profile line says when it was saved, so a later one can win", async () => {
  const C = "c-dated";
  fact(C, "Omari", "Lives in Brooklyn", { category: "location" });
  await rebuildProfile(C);
  assert.match(db.getProfile(C).block, /- Lives in Brooklyn \(inferred, [A-Z][a-z]{2} \d{1,2}\)/);
});

// ---------- the turn ----------

test("the closest memories ride on the turn, dated, without repeating the profile", async () => {
  const C = "c-turn";
  const inProfile = fact(C, "Omari", "Lives in Brooklyn", { category: "location" });
  await rebuildProfile(C);
  const irene = fact(C, "Irene", "Is a nursing student starting clinicals in January", { category: "work" });

  const notes = await memoryNotes(C, "how's irene doing with school", {
    enabled: true,
    find: async () => [{ factId: inProfile, score: 0.6 }, { factId: irene, score: 0.55 }],
  });
  const all = notes.join("\n");

  assert.match(all, /WHAT YOU KNOW ABOUT THEM/);
  assert.match(all, /RELEVANT MEMORIES[^]*Irene: Is a nursing student starting clinicals in January \(inferred, saved [A-Z][a-z]{2} \d{1,2}\)/);
  // Brooklyn is in the profile already; it is not spent a memory slot as well.
  assert.equal((all.match(/Lives in Brooklyn/g) ?? []).length, 1);
});

test("a search that fails costs the turn its memories, never the reply", async () => {
  const notes = await memoryNotes("c-turn", "hi", { enabled: true, find: async () => { throw new Error("timeout"); } });
  assert.ok(notes.every(n => !/RELEVANT MEMORIES/.test(n)));
});

test("the live backend hands the model what is known about them", async () => {
  const C = "c-live";
  fact(C, "Omari", "Lives in Brooklyn", { category: "location" });
  await rebuildProfile(C);

  let prompt = "";
  await runTurnViaCli({
    conversationId: C, text: "find me dinner nearby",
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    recall: (c, text, o) => memoryNotes(c, text, { ...o, enabled: false }),
    run: async (args) => { prompt = args.prompt; return { ok: true, envelope: { result: "on it" } }; },
  });

  assert.match(prompt, /WHAT YOU KNOW ABOUT THEM[^]*Lives in Brooklyn/);
  // Prompt only: the saved thread does not keep it.
  assert.doesNotMatch(JSON.stringify(db.loadConversation(C)), /WHAT YOU KNOW ABOUT THEM/);
});

test("an event turn is not handed the profile", async () => {
  let prompt = "";
  await runTurnViaCli({
    conversationId: "c-live", text: "timer fired", kind: "event",
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    run: async (args) => { prompt = args.prompt; return { ok: true, envelope: { result: "NO_REPLY" } }; },
  });
  assert.doesNotMatch(prompt, /WHAT YOU KNOW ABOUT THEM/);
});

test("of two wordings that say the same, the newer one is shown", async () => {
  const C = "c-state";
  const old = fact(C, "Omari", "Opted out of texts from the assistant's number", { vector: vec(0), category: "identity" });
  db.db.prepare("UPDATE person_facts SET created_at = created_at - 86400000 WHERE id = ?").run(old);
  fact(C, "Omari", "Texted START to re-enable texts from the assistant's number", { vector: vec(0, 1, 0.5), category: "identity" }); // ~0.88

  await rebuildProfile(C);
  const block = db.getProfile(C).block;
  assert.match(block, /START/);
  assert.doesNotMatch(block, /Opted out/);
});

test("matches that restate each other, or the profile, do not crowd out a different one", async () => {
  const C = "c-crowd";
  const a = fact(C, "Omari", "Got accepted into Speedrun", { vector: vec(0), category: "other" });
  const b = fact(C, "Omari", "Was accepted into the Speedrun accelerator", { vector: vec(0, 1, 0.3), category: "other" });
  const c = fact(C, "Omari", "Starts Speedrun on November 3", { vector: vec(4), category: "other" });
  const notes = await memoryNotes(C, "speedrun?", { enabled: true, find: async () => [a, b, c].map((factId, i) => ({ factId, score: 0.7 - i / 100 })) });
  const hits = notes.find(n => n.startsWith("RELEVANT")) ?? "";
  assert.equal((hits.match(/accepted/gi) ?? []).length, 1, hits);
  assert.match(hits, /November 3/);
});

// ---------- the model's choice ----------

test("the profile is what the model chose, and what it called restatements are not offered again", async () => {
  const C = "c-chosen";
  const full = fact(C, "Omari", "Got into Speedrun after the video, 10-minute and 30-minute rounds", { category: "work" });
  const short = fact(C, "Omari", "Got accepted into Speedrun", { category: "work" });
  const snack = fact(C, "Omari", "Snacking on cashews", { category: "other" });
  const home = fact(C, "Omari", "Lives in Brooklyn", { category: "location" });

  let shownToModel = [];
  await rebuildProfile(C, {
    choose: async (candidates) => { shownToModel = candidates.map(f => f.id); return [{ id: full, same_as: [short] }, { id: home, same_as: [] }, { id: 999999, same_as: [] }]; },
  });
  const profile = db.getProfile(C);

  assert.ok(shownToModel.includes(snack), "the model is shown everything, and decides");
  assert.match(profile.block, /10-minute/);
  assert.match(profile.block, /Brooklyn/);
  assert.doesNotMatch(profile.block, /cashews|Got accepted/);
  // An id the model made up is ignored, not trusted.
  assert.deepEqual(JSON.parse(profile.fact_ids).sort(), [full, short, home].sort());

  const notes = await memoryNotes(C, "speedrun", { enabled: true, find: async () => [{ factId: short, score: 0.8 }] });
  assert.ok(!notes.some(n => n.startsWith("RELEVANT")), "a wording the profile already stands for is not a memory slot");
});

test("when the model cannot be asked, the profile is still built", async () => {
  const C = "c-fallback";
  fact(C, "Omari", "Lives in Brooklyn", { category: "location" });
  await rebuildProfile(C, { choose: async () => { throw new Error("overloaded"); } });
  assert.match(db.getProfile(C).block, /Brooklyn/);
});
