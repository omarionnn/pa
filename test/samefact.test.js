import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-samefact-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.OPENAI_API_KEY = "test-key";

const db = await import("../src/db.js");
const { restates, hardTokens, rememberOnce, RESTATES_SCORE } = await import("../src/samefact.js");

// ---------- the judgement, without an embedding in sight ----------
//
// Every pair below is a real pair out of the live data, with the score it really scored.

test("the same sentence reworded is one fact", () => {
  assert.ok(restates("Pays for ElevenLabs at $6 per month", "Pays for ElevenLabs at $6/month", 0.9957));
  assert.ok(restates("Irene is a BSN nursing student", "Irene is a nursing BSN student", 0.9885));
  assert.ok(restates("Has a seminar at 4 PM next Monday", "Has a seminar at 4pm next Monday", 0.9870));
  assert.ok(restates("Has not yet started clinicals", "has not started clinicals yet", 0.96));
});

test("two accounts that differ by one digit are two facts, however alike they read", () => {
  // 0.9743 in the live data — above fifteen pairs that ARE the same fact twice. Similarity alone
  // would have thrown away one of Omari's two real email accounts.
  assert.ok(!restates(
    "Has Gmail account omariij16@gmail.com",
    "Has Gmail account omariij25@gmail.com",
    0.9743,
  ));
  assert.ok(!restates("Pays for Spotify at $12.99 a month", "Pays for Spotify at $14 a month", 0.99));
  assert.ok(!restates("Has a seminar at 4pm", "Has a seminar at 5pm", 0.99));
});

test("a negation is not a wording", () => {
  assert.ok(!restates("Is allergic to peanuts", "Is not allergic to peanuts", 0.995));
  assert.ok(!restates(
    "Luma appears inactive: last successful charge July 18",
    "Luma appears inactive: last successful charge July 18, and no emails since",
    0.9551,
  ));
});

test("sentences that merely sit near each other are left alone", () => {
  assert.ok(!restates("Is a nursing student", "Is a medical student", RESTATES_SCORE - 0.01));
});

test("hard tokens read money, times, emails, handles and domains", () => {
  assert.deepEqual([...hardTokens("Pays $12.99/month, renews Oct 19")].sort(), ["n:12.99", "n:19"]);
  assert.deepEqual([...hardTokens("4 PM")], [...hardTokens("4pm")]);
  assert.deepEqual([...hardTokens("$81,530")], [...hardTokens("$81530")]);
  assert.ok(hardTokens("mail to a@b.com").has("e:a@b.com"));
  assert.ok(hardTokens("follow @reason").has("h:@reason"));
  assert.ok(hardTokens("the site is reason.dev").has("d:reason.dev"));
});

// ---------- the write path, with the embedding stubbed ----------
//
// Vectors are two-dimensional and set at a chosen angle, so "how alike" is exact and the test says
// what it means. The real model's 1536 dimensions change nothing about the arithmetic.

const vectors = new Map();
const at = deg => {
  const r = (deg * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r)]);
};
let fetchCalls = 0;
let failNext = false;

global.fetch = async (_url, init) => {
  fetchCalls++;
  if (failNext) {
    failNext = false;
    throw new Error("embeddings unreachable");
  }
  const { input } = JSON.parse(init.body);
  const data = input.map((text, index) => {
    const v = vectors.get(text);
    assert.ok(v, `test did not define a vector for ${JSON.stringify(text)}`);
    return { index, embedding: [...v] };
  });
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
};

const C = "conv-samefact";
const save = (about, fact) => rememberOnce(C, about, fact, { source: "inferred", confidence: 0.9 });
const activeFacts = about => db.personFacts(db.findPerson(C, about).id).map(f => f.fact);

test("a paraphrase of a fact already known is not saved again", async () => {
  vectors.set("Irene: Irene is a BSN nursing student", at(0));
  vectors.set("Irene: Irene is a nursing BSN student", at(8));   // cos 8° = 0.990
  vectors.set("Irene: Is a nursing BSN student", at(12));         // cos 12° = 0.978

  const first = await save("Irene", "Irene is a BSN nursing student");
  assert.equal(first.already_knew, false);

  const second = await save("Irene", "Irene is a nursing BSN student");
  assert.equal(second.restated, first.factId, "should point at the fact it restates");
  const third = await save("Irene", "Is a nursing BSN student");
  assert.equal(third.restated, first.factId);

  assert.deepEqual(activeFacts("Irene"), ["Irene is a BSN nursing student"]);
});

test("two facts that read alike but say different things are both kept", async () => {
  vectors.set("Omari: Has Gmail account omariij16@gmail.com", at(0));
  vectors.set("Omari: Has Gmail account omariij25@gmail.com", at(9)); // cos 9° = 0.988

  await save("Omari", "Has Gmail account omariij16@gmail.com");
  const second = await save("Omari", "Has Gmail account omariij25@gmail.com");

  assert.equal(second.restated, undefined);
  assert.equal(activeFacts("Omari").length, 2, "both accounts must survive");
});

test("a fact about someone else is never read as a restatement", async () => {
  vectors.set("Kofi: is a student at Calvin", at(0));
  vectors.set("Ama: is a student at Calvin", at(0)); // identical meaning, different subject

  await save("Kofi", "is a student at Calvin");
  const ama = await save("Ama", "is a student at Calvin");

  assert.equal(ama.restated, undefined);
  assert.deepEqual(activeFacts("Ama"), ["is a student at Calvin"]);
});

test("a distant fact about the same person is saved", async () => {
  vectors.set("Irene: Exams land every week", at(70));

  const saved = await save("Irene", "Exams land every week");
  assert.equal(saved.restated, undefined);
  assert.equal(activeFacts("Irene").length, 2);
});

test("one embedding is paid for per fact, not two", async () => {
  vectors.set("Kwesi: Has a seminar at 4pm", at(0));
  fetchCalls = 0;
  await save("Kwesi", "Has a seminar at 4pm");
  assert.equal(fetchCalls, 1, "the vector used to compare is the one that gets stored");
});

test("a fact is never lost to an embedding outage", async () => {
  failNext = true;
  const saved = await save("Yaa", "Works nights at the hospital");
  assert.equal(saved.already_knew, false);
  assert.deepEqual(activeFacts("Yaa"), ["Works nights at the hospital"]);
});

test("the subject is not created by a check that saves nothing", async () => {
  vectors.set("Nobody: something", at(0));
  assert.equal(db.findPerson(C, "Nobody"), null);
});
