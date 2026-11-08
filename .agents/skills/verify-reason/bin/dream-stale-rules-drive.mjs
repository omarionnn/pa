// The nightly review's rule merge against a rule the person took back WHILE the model was thinking
// (R2-J), driven in process against the CAGED database (no model: the answer is scripted through
// `ask`, which first does what the person would do mid-pass).
//
//   eval "$(bin/caged.sh env | sed 's/^/export /')" && node bin/dream-stale-rules-drive.mjs
//
// Proves on the real db + webmemory.forgetRow + reviewOne: a merge naming a rule forgotten mid-pass is
// refused, the forgotten rule stays 'deleted' (never re-activated, never superseded_by anything), and
// the other rule stays active. Throwaway conversation, deleted after.
if (!process.env.REASON_DB_PATH || !/rv-|verify/.test(process.env.REASON_DB_PATH)) {
  console.error("refusing: run under caged.sh env (REASON_DB_PATH must be the cage's)"); process.exit(2);
}
const db = await import("../../../../src/db.js");
const { clock } = await import("../../../../src/config.js");
const dream = await import("../../../../src/dream.js");
const webmemory = await import("../../../../src/pages/webmemory.js");

const C = `dm:dream-stale-drive-${Date.now()}`;
const wipe = () => {
  try { db.db.prepare("DELETE FROM extraction_queue WHERE event_log_id IN (SELECT id FROM event_log WHERE conversation_id = ?)").run(C); } catch {}
  for (const t of ["treat_rules", "event_log", "memory_reviews", "memory_review_passes", "conversations"]) {
    try { db.db.prepare(`DELETE FROM ${t} WHERE conversation_id = ?`).run(C); } catch {}
  }
};
const empty = { facts: [], rules_new: [], rules_merge: [], rules_retire: [] };
const statusOf = (id) => ({ ...db.db.prepare("SELECT status, superseded_by FROM treat_rules WHERE id = ?").get(id) });
const out = {};
let ok = false;
try {
  const t0 = clock.now() - 3600_000;
  const m0 = db.writeEvent({ conversationId: C, role: "user", content: "that was way too long", at: t0 - 60_000 });
  const m = db.writeEvent({ conversationId: C, role: "user", content: "keep it short please", at: t0 });
  const a = db.addRule(C, { rule: "Keep replies brief", sourceMessageId: m0, source: "review", at: t0 - 2000 }).rule.id;
  const b = db.addRule(C, { rule: "Short replies", sourceMessageId: m0, source: "review", at: t0 - 1000 }).rule.id;
  const runs = [];
  for (const wording of ["Keep replies brief", "Keep every reply brief"]) {
    // Fresh pair each round; the first round's `a` is the one forgotten.
    const [x, y] = runs.length ? [db.addRule(C, { rule: "Be brief", sourceMessageId: m0, source: "review" }).rule.id, b] : [a, b];
    const r = await dream.reviewOne(C, {
      rebuild: async () => {}, day: `d${runs.length}`,
      ask: async () => { await webmemory.forgetRow(C, `rule-${x}`); return { value: { ...empty, rules_merge: [{ ids: [x, y], rule: wording, why: "overlap", message: m }] } }; },
    });
    db.db.prepare("UPDATE memory_reviews SET last_event_id = 0 WHERE conversation_id = ?").run(C);
    runs.push({ merged: r.rules_merged, refused: r.refused, forgotten: statusOf(x), other: statusOf(y).status });
  }
  out.runs = runs;
  out.active = db.activeRules(C).map(r => r.id);
  ok = runs.every(r => r.merged === 0 && r.refused === 1 && r.forgotten.status === "deleted" && r.forgotten.superseded_by == null && r.other === "active")
    && out.active.length === 1 && out.active[0] === b;
} finally { wipe(); }
console.log(JSON.stringify({ drive: "dream-stale-rules", ok, ...out }));
process.exit(ok ? 0 : 1);
