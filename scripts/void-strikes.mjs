// Void strikes the harm screen got wrong, by row id: node --env-file-if-exists=.env scripts/void-strikes.mjs <conversationId> <id>... [--why "..."]
//
// The rows stay in harm_events with verdict 'void' (see db.voidHarmEvent), so they stop counting
// toward a pause and the ops tally, and one 'harm_void' ledger row says it was done and why.
// First used 2026-10-24 for the owner's shared link and the "??" after it (rows 13 and 14).
import { voidStrikes, strikesFor } from "../src/harm.js";
import { ledgerWrite } from "../src/trust.js";

const args = process.argv.slice(2);
const at = args.indexOf("--why");
const why = at >= 0 ? args.splice(at, 2)[1] : "false positive";
const [conversationId, ...ids] = args;
if (!conversationId || !ids.length) {
  console.error("usage: scripts/void-strikes.mjs <conversationId> <id>... [--why \"...\"]");
  process.exit(2);
}
const voided = voidStrikes(conversationId, ids, { why });
if (voided.length) {
  ledgerWrite({ conversationId, action: "harm_void", input: { ids: voided, why }, out: { ok: true, voided }, target: "harm:void" });
}
console.log(JSON.stringify({ conversationId, asked: ids.map(Number), voided, strikes_now: strikesFor(conversationId).count }));
