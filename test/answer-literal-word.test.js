// Answer the word they wrote: when a word names a real thing (a product, an app, a place), the
// answer is about that thing, not a similarly spelled different one. A "did you mean" is only for
// a word that names nothing real, and then the guess is said out loud. Offline: asserts the system
// prompt text for each variant, and that the act-on-the-sensible-guess rules are still there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-literal-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Alex";
process.env.REASON_TZ = "America/New_York";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";

const { systemFor, SYSTEM } = await import("../src/agent.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const RULE = /Answer the word they wrote/;
const VARIANTS = {
  default: SYSTEM,
  owner: systemFor({ name: "Alex", isOperator: true }),
  other: systemFor({ name: "Sam", isOperator: false }),
  unnamed: systemFor({ name: "the person I work for", isOperator: false }),
  call: systemFor({ name: "Alex", isOperator: true, onCall: true }),
};

for (const [label, p] of Object.entries(VARIANTS)) {
  test(`${label} prompt: a real word is answered literally, a guess only for a word that names nothing`, () => {
    assert.match(p, RULE);
    assert.match(p, /names a real thing/);
    assert.match(p, /names nothing real/);
    assert.match(p, /say the guess/);
  });
}

test("the rule narrows guessing about words only: act-on-context guidance is untouched", () => {
  const p = VARIANTS.owner;
  assert.match(p, /no asking which of three things they meant when one of them is obviously it/);
  assert.match(p, /name it in passing so they can correct you/);
  assert.equal(p.match(RULE).length, 1);
});
