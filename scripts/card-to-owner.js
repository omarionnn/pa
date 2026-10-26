// The contact card, once, to the owner's own thread — and nobody else.
//
// Owner-only CLI run on the server (`/opt/reason`), for when the card itself changes (10-25: the
// photo's bubble went brand orange) and the owner wants to see the new one on his phone. Everybody
// else keeps the card they already saved; new people get the new one from offerContactCard.
//
//   sudo -u reason node --env-file=.env scripts/card-to-owner.js --confirm=card-orange-1025
//
// Same send as offerContactCard (router.sendMediaUrl with the live /reason.vcf address). The owner
// is announce.js's ownerRecipient(): exactly one owner number, dm:owner preferred, or it refuses.
// A marker file in the data directory makes a second run send nothing.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { contactCardUrl, lineNumber } from "../src/contact.js";
import { ownerRecipient } from "./announce.js";

export const SEND_ID = "card-orange-1025";
export const LINE = "my contact card has a new look — here it is. save it over the old one if you like.";

export const markerFor = (id, dataDir = config.dataDir) => join(dataDir, `card-to-owner-${id}.sent`);

export async function sendCardToOwner({ id = SEND_ID, router, marker = markerFor(id) }) {
  if (existsSync(marker)) return { outcome: "already" };
  const url = contactCardUrl();
  if (!url) return { outcome: "failed", why: "REASON_PUBLIC_URL is not set" };
  const r = ownerRecipient();
  if (!lineNumber(router, r.channel)) return { outcome: "failed", why: `${r.channel} reports no line number` };
  let res;
  try {
    res = await router.sendMediaUrl({ channel: r.channel, to: r.address, text: LINE, mediaUrl: url });
  } catch (e) {
    res = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
  }
  if (!res?.ok) return { outcome: "failed", why: res?.error ?? "unknown" };
  writeFileSync(marker, `${new Date().toISOString()} ${res.delivered?.message_id ?? ""}\n`);
  return { outcome: "sent", conversationId: r.conversationId, messageId: !!res.delivered?.message_id };
}

async function main() {
  if (!process.argv.includes(`--confirm=${SEND_ID}`)) {
    console.error(`refusing to send: add --confirm=${SEND_ID} to say you mean it`);
    process.exitCode = 2;
    return;
  }
  const { Router } = await import("../src/channels/router.js");
  const { SendblueChannel } = await import("../src/channels/sendblue.js");
  const { LinqChannel } = await import("../src/channels/linq.js");
  const router = new Router({ log: () => {} });
  router.register(new SendblueChannel());
  router.register(new LinqChannel());
  const r = await sendCardToOwner({ router });
  console.log(`card to owner: ${r.outcome}${r.conversationId ? ` (${r.conversationId})` : ""}${r.messageId ? ", Sendblue message id recorded" : ""}${r.why ? ` — ${r.why}` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error((e?.message ?? String(e)).split("\n")[0]); process.exitCode = 1; });
}
