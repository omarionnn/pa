// The Action Cards engine for one account, by hand (src/actionengine.js).
//
//   node --env-file-if-exists=.env scripts/action-cards-run.js --account=dm:owner --dry
//
// --dry (the default, and the only mode this script has): gather, Stage 1 and Stage 2 run for real
// — their Google is read, the model is asked once on the subscription — and NOTHING is written or
// sent: no digest, no day row, no text. It prints counts and the card titles that WOULD be on the
// page, never a mail body, a subject, an address or a candidate line. Run it on the server, as the
// service user, where the tokens and the CLI are.
import { config } from "../src/config.js";
import * as cards from "../src/actioncards.js";
import * as engine from "../src/actionengine.js";
import { dreamZone } from "../src/dream.js";

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const account = arg("account", config.ownerConversation);
if (!process.argv.includes("--dry")) { console.error("This script only runs dry: add --dry. The scheduled 7:30 run is the one that writes and texts."); process.exit(2); }
if (cards.mode() === "off") console.error("note: REASON_ACTION_CARDS is off; a dry run still shows what would be carded");
const why = engine.whyNot();
if (why) { console.error(`cannot ask the model: ${why} (the engine runs on the claude-cli backend only)`); process.exit(3); }

const tz = dreamZone(account);
const now = Date.now();
const logs = [];
const out = await engine.runMorning(account, { now, tz, dry: true, log: (l) => logs.push(l) });
console.log(`account ${account} · zone ${tz} · ${new Date(now).toISOString()} · model ${engine.MODEL()} · DRY RUN (nothing written, nothing sent)`);
console.log(`outcome: ${out.outcome ?? out.skipped}${out.why ? ` (${out.why})` : ""}`);
const c = out.counts ?? {};
console.log(`candidates ${c.candidates ?? 0} (by source ${JSON.stringify(out.bundle?.by_source ?? {})}) · after stage 1: ${c.after_stage1 ?? 0} · stage 2 cards ${c.stage2_cards ?? 0}, skipped ${c.stage2_skipped ?? 0} · after dedupe: ${c.cards ?? 0}`);
if (out.stage1?.dropped) console.log(`stage 1 dropped: ${JSON.stringify(out.stage1.dropped)}`);
if (out.bundle?.failed?.length) console.log(`sources that failed: ${out.bundle.failed.map(f => f.what).join(", ")}`);
if (out.stage2?.cost) console.log(`model ${out.stage2.cost.model} · tokens in ${out.stage2.cost.usage?.input_tokens ?? "?"} / out ${out.stage2.cost.usage?.output_tokens ?? "?"} · ~$${(out.stage2.cost.costUsd ?? 0).toFixed(4)} API-equivalent (billed $0 on the subscription)`);
for (const [i, k] of (out.ranked?.cards ?? []).entries()) {
  console.log(`  ${String(i + 1).padStart(2, "0")} ${k.verb.padEnd(9)} ${k.title}  [${k.drawing}, urgency ${k.urgency}, effort ${k.effort}, from ${k.candidate?.source ?? "?"}]`);
  console.log(`     why: ${k.whyNow}`);
  console.log(`     prefill: ${k.prefill}`);
  console.log(`     route: ${k.routed?.route ?? "?"}${k.routed?.site ? ` @ ${k.routed.site}` : ""} · job: ${k.routed?.job ?? ""}`);
}
// What code's gate (src/cardroutes.js) dropped, by reason word, and what is only worth knowing.
if (out.gate) console.log(`gate: ${out.gate.cards.length} finishable of ${out.stage2?.cards?.length ?? 0} · not finishable: ${JSON.stringify(out.gate.why)}`);
for (const k of out.known ?? []) console.log(`  also worth knowing: ${k.line}`);
if (out.text) console.log(`text that would go: ${out.text}`);
process.exit(0);
