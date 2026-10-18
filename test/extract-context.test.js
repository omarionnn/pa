import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-extract-ctx-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");

const db = await import("../src/db.js");
const { knownAlready } = await import("../src/extract.js");

// The extractor was told "do not extract the same thing twice" and never shown what it had already
// saved, so it reworded the same four things into twelve rows in one conversation. What it is shown
// is the fix, so what it is shown is what is tested.

test("a conversation with nothing on record says nothing", () => {
  assert.equal(knownAlready("c-empty"), "");
});

test("what is already known is listed under the person it is about", () => {
  db.remember("c-irene", "Irene", "nursing BSN student", { source: "inferred" });
  db.remember("c-irene", "Irene", "Has not yet started clinicals", { source: "inferred" });
  db.remember("c-irene", "Kofi", "Works at a startup", { source: "inferred" });

  const known = knownAlready("c-irene");

  assert.match(known, /^Irene:$/m);
  assert.match(known, /^- nursing BSN student$/m);
  assert.match(known, /^- Has not yet started clinicals$/m);
  assert.match(known, /^Kofi:$/m);
  assert.match(known, /^- Works at a startup$/m);
  // One heading per subject, not one per fact.
  assert.equal(known.match(/^Irene:$/gm).length, 1);
});

test("another conversation's memory is not shown", () => {
  db.remember("c-other", "Ama", "Lives in Accra", { source: "inferred" });

  assert.doesNotMatch(knownAlready("c-irene"), /Ama|Accra/);
  assert.match(knownAlready("c-other"), /Lives in Accra/);
});

test("a fact that has been retired is not offered back as known", () => {
  const saved = db.remember("c-retire", "Yaw", "Drives a Civic", { source: "inferred" });
  assert.match(knownAlready("c-retire"), /Drives a Civic/);

  db.dropFact("c-retire", saved.factId);
  assert.doesNotMatch(knownAlready("c-retire"), /Drives a Civic/);
});
