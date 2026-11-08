// The nightly review and what they asked Reason to forget (R2-H), driven in process against the
// CAGED database (no model: the review's answer is scripted through `ask`, nothing reaches claude
// or the API).
//
//   eval "$(bin/caged.sh env | sed 's/^/export /')" && node bin/dream-forget-drive.mjs
//
// Proves on the real db + the `forget` tool + reviewOne: after "forget Yaw", no line naming Yaw is in
// the review prompt (period message or a fact's source); a rule citing a forgotten line is refused;
// a standing rule naming Yaw is retired by the forget ('deleted') and not re-added; and a rule forgotten
// on the Web memory page is not re-learned, reworded, off its source message. Throwaway conversation,
// deleted after.
if (!process.env.REASON_DB_PATH || !/rv-|verify/.test(process.env.REASON_DB_PATH)) {
  console.error("refusing: run under caged.sh env (REASON_DB_PATH must be the cage's)"); process.exit(2);
}
const db = await import("../../../../src/db.js");
const { clock } = await import("../../../../src/config.js");
const dream = await import("../../../../src/dream.js");
const { runTool } = await import("../../../../src/tools.js");
const webmemory = await import("../../../../src/pages/webmemory.js");

const C = `dm:dream-forget-drive-${Date.now()}`;
const wipe = () => {
  try { db.db.prepare("DELETE FROM extraction_queue WHERE event_log_id IN (SELECT id FROM event_log WHERE conversation_id = ?)").run(C); } catch {}
  try { db.db.prepare("DELETE FROM person_facts WHERE person_id IN (SELECT id FROM people WHERE conversation_id = ?)").run(C); } catch {}
  for (const t of ["treat_rules", "event_log", "memory_reviews", "memory_review_passes", "recall_forgotten", "recall_reindex", "people", "fact_embeddings", "conversations"]) {
    try { db.db.prepare(`DELETE FROM ${t} WHERE conversation_id = ?`).run(C); } catch {}
  }
};
const empty = { facts: [], rules_new: [], rules_merge: [], rules_retire: [] };
const out = {};
let ok = false;
try {
  const t0 = clock.now() - 3600_000;
  const src = db.writeEvent({ conversationId: C, role: "user", content: "Kofi drove Yaw to the airport, Kofi lives in Tema", at: t0 });
  db.remember(C, "Kofi", "Lives in Tema", { source: "inferred", confidence: 0.8, sourceMessageIds: [src] });
  db.remember(C, "Yaw", "Is my ex", { source: "user_stated" });
  const m1 = db.writeEvent({ conversationId: C, role: "user", content: "always cc Yaw on dinner plans", at: t0 + 1000 });
  const m2 = db.writeEvent({ conversationId: C, role: "user", content: "stop sending me three options, just pick one", at: t0 + 2000 });
  db.writeEvent({ conversationId: C, role: "user", content: "what's the weather tomorrow", at: t0 + 3000 });
  db.addRule(C, { rule: "Always cc Yaw on dinner plans", sourceMessageId: m1, source: "they_said" });
  const pick = db.addRule(C, { rule: "Pick one option instead of three", sourceMessageId: m2, source: "they_said" }).rule.id;

  const gone = await runTool("forget", { about: "Yaw" }, { conversationId: C, messages: [] });
  out.forget = { ok: gone.ok, rules_dropped: gone.rules_dropped };
  out.web_forget = (await webmemory.forgetRow(C, `rule-${pick}`)).ok;
  let prompt = "";
  const r = await dream.reviewOne(C, {
    rebuild: async () => {},
    ask: async (a) => { prompt = a.prompt; return { value: { ...empty, rules_new: [
      { rule: "Always cc Yaw on dinner plans", why: "x", message: m1 },
      { rule: "Only ever suggest a single option", why: "x", message: m2 },
    ] } }; },
  });
  out.prompt_names_forgotten = /Yaw/.test(prompt);
  out.prompt_has_rest = /weather tomorrow/.test(prompt) && /Lives in Tema/.test(prompt);
  out.result = { rules_added: r.rules_added, refused: r.refused };
  out.active_rules = db.activeRules(C).length;
  ok = gone.ok && gone.rules_dropped === 1 && out.web_forget && !out.prompt_names_forgotten && out.prompt_has_rest
    && r.rules_added === 0 && r.refused === 2 && out.active_rules === 0;
} finally { wipe(); }
console.log(JSON.stringify({ drive: "dream-forget", ok, ...out }));
process.exit(ok ? 0 : 1);
