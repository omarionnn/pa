// Three sample Action Cards for one account, so the page (src/pages/actioncards.js) can be opened and
// exercised without the engine. The cards are the approved mockups' (~/Desktop/reason-action-cards-1111):
// fictional, the same for every run.
//
//   node --env-file-if-exists=.env scripts/action-cards-seed.js [--account=dm:owner] [--ttl-hours=168]
//
// Prints the link. Refuses under REASON_ACTION_CARDS=off (the page would be a 404 anyway). Nothing is
// texted: the engine's morning text is another build; open the link yourself.
import { config } from "../src/config.js";
import * as cards from "../src/actioncards.js";

export const SAMPLE_CARDS = Object.freeze([
  { verb: "REPLACE", title: "Replace your Anthropic key before it expires Nov 18", whyNow: "It stops working Tuesday and three things you use depend on it.", prefill: "Replace my Anthropic key before it expires Nov 18", drawing: "key" },
  { verb: "PLAN", title: "Plan your birthday dinner for Tue, Nov 24", whyNow: "Your calendar shows the day and nothing is booked yet.", prefill: "Plan my birthday dinner for Tue, Nov 24", drawing: "cake" },
  { verb: "DIAGNOSE", title: "Find out why your server went down 6 times last night", whyNow: "The same alert fired 6 times between 1 and 4 am.", prefill: "Find out why my server went down 6 times last night", drawing: "server" },
]);

/** Make the three sample cards for `conversationId`; returns the digest (token, url, cards). */
export function seed(conversationId, { ttlMs } = {}) {
  return cards.createDigest(conversationId, SAMPLE_CARDS, ttlMs ? { ttlMs } : {});
}

if (process.argv[1] && /action-cards-seed\.js$/.test(process.argv[1])) {
  const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  if (cards.mode() === "off") { console.error("REASON_ACTION_CARDS is off: set it to owner or on first, or the link is a 404."); process.exit(2); }
  const account = arg("account", config.ownerConversation);
  const hours = Number(arg("ttl-hours", "168")) || 168;
  const d = seed(account, { ttlMs: hours * 3_600_000 });
  console.log(`digest ${d.id} for ${account}, ${d.cards.length} cards, good until ${new Date(d.expiresAt).toISOString()}`);
  console.log(d.url);
  for (const c of d.cards) console.log(`  ${String(c.position).padStart(2, "0")} ${c.verb.padEnd(9)} ${c.code}  ${c.title}`);
}
