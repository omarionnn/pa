// The nightly review reads the rules, then waits minutes on the model. If the person forgets or
// rewords a rule in that window (/web/memory, memory_drop), the answer is about a rule that is gone:
// a review that started before must never re-activate it, fold it, or point anything at it. Only what
// the pass itself changed is rolled back. (R2-J)
//
// No model, no network, no API key: the review is answered by a scripted function that does what the
// person would do mid-pass before it answers.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-dream-stale-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Ama";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_BACKEND = "claude-cli";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const dream = await import("../src/dream.js");
const webmemory = await import("../src/pages/webmemory.js");
const { cliConfig } = await import("../src/backends/cli.js");
cliConfig.bin = join(dir, "no-claude-here");

const C = "dm:dream-stale-ama";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025550121", name: "Ama", isOperator: false });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  dream.resetDreams();
  db.db.exec(`DELETE FROM person_facts; DELETE FROM people; DELETE FROM event_log; DELETE FROM treat_rules; DELETE FROM recall_forgotten;
    DELETE FROM memory_reviews; DELETE FROM memory_review_passes; DELETE FROM fact_embeddings; DELETE FROM conversations;`);
});

const empty = { facts: [], rules_new: [], rules_merge: [], rules_retire: [] };
const noRebuild = async () => {};
const statusOf = (id) => db.db.prepare("SELECT status, superseded_by FROM treat_rules WHERE id = ?").get(id);
function setup() {
  const t0 = clock.now() - 3600_000;
  // The rules came from an earlier line; the merge cites a later one (so only the stale snapshot is tested).
  const m0 = db.writeEvent({ conversationId: C, role: "user", content: "that was way too long", at: t0 - 60_000 });
  const m = db.writeEvent({ conversationId: C, role: "user", content: "keep it short please", at: t0 });
  const a = db.addRule(C, { rule: "Keep replies brief", sourceMessageId: m0, source: "review", at: t0 - 2000 }).rule.id;
  const b = db.addRule(C, { rule: "Short replies", sourceMessageId: m0, source: "review", at: t0 - 1000 }).rule.id;
  return { m, a, b };
}

test("a rule forgotten on the Web page while the model thinks is not revived when the merge is refused", async () => {
  const { m, a, b } = setup();
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => {
      assert.equal((await webmemory.forgetRow(C, `rule-${a}`)).ok, true);
      // The merged wording is the one they just took back: addRule refuses it (taken_back).
      return { value: { ...empty, rules_merge: [{ ids: [a, b], rule: "Keep replies brief", why: "overlap", message: m }] } };
    },
  });
  assert.equal(out.rules_merged, 0);
  assert.equal(statusOf(a).status, "deleted", "what they forgot stays forgotten");
  assert.equal(statusOf(b).status, "active", "the other rule is put back as it was");
  assert.deepEqual(db.activeRules(C).map(r => r.id), [b]);
});

test("a rule dropped mid-pass is never folded into a merged rule", async () => {
  const { m, a, b } = setup();
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => {
      assert.equal(db.dropRule(C, a).ok, true);
      return { value: { ...empty, rules_merge: [{ ids: [a, b], rule: "Keep every reply brief", why: "overlap", message: m }] } };
    },
  });
  assert.equal(out.rules_merged, 0);
  assert.equal(out.refused, 1);
  assert.deepEqual({ ...statusOf(a) }, { status: "deleted", superseded_by: null });
  assert.deepEqual(db.activeRules(C).map(r => r.id), [b]);
});

test("a rule reworded on the Web page mid-pass: the old wording stays deleted, the new one active", async () => {
  const { m, a, b } = setup();
  let fresh = null;
  await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => {
      const r = await webmemory.correctRow(C, `rule-${a}`, "One line answers unless I ask for more");
      fresh = Number(r.key.split("-")[1]);
      return { value: { ...empty, rules_merge: [{ ids: [a, b], rule: "Keep replies brief", why: "overlap", message: m }] } };
    },
  });
  assert.equal(statusOf(a).status, "deleted");
  assert.equal(statusOf(fresh).status, "active");
  assert.equal(statusOf(b).status, "active");
});

test("a merge of rules still active works as before", async () => {
  const { m, a, b } = setup();
  const out = await dream.reviewOne(C, {
    rebuild: noRebuild,
    ask: async () => ({ value: { ...empty, rules_merge: [{ ids: [a, b], rule: "Keep every reply brief", why: "overlap", message: m }] } }),
  });
  assert.equal(out.rules_merged, 2);
  const live = db.activeRules(C);
  assert.deepEqual(live.map(r => r.rule), ["Keep every reply brief"]);
  assert.equal(statusOf(a).superseded_by, live[0].id);
});
