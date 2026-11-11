// The welcome gallery, once, to the owner's own thread — and nobody else — so he sees the real thing
// on his phone before REASON_WELCOME_CARDS goes on for everyone (src/welcome.js).
//
//   sudo -u reason node --env-file=.env scripts/welcome-to-owner.js --confirm=welcome-1110
//
// The same delivery new people get: the intro line, the seven cards each its own picture message,
// the question, queued as ONE ordered outbox chain (a card that cannot go goes as its text line in
// its place; a restart mid-way is finished by the live service's outbox sweep, never repeated), then
// tried in turn here. Refuses under REASON_WELCOME_CARDS=off. The owner is announce.js's
// ownerRecipient(). A marker file in the data directory makes a second run send nothing.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import * as welcome from "../src/welcome.js";
import { ownerRecipient } from "./announce.js";

export const SEND_ID = "welcome-1111"; // 11-11: the carousel; 11-10 "welcome-1110" was the one-by-one pictures
export const markerFor = (id, dataDir = config.dataDir) => join(dataDir, `welcome-to-owner-${id}.sent`);

export async function sendWelcomeToOwner({ id = SEND_ID, router, marker = markerFor(id), sleep = (ms) => new Promise(r => setTimeout(r, ms)), log = () => {} }) {
  if (welcome.mode() === "off") return { outcome: "refused", why: "REASON_WELCOME_CARDS is off" };
  if (existsSync(marker)) return { outcome: "already" };
  try { writeFileSync(marker, "pending\n", { flag: "wx" }); } catch (e) {
    return e?.code === "EEXIST" ? { outcome: "already" } : { outcome: "failed", why: `cannot write ${marker}: ${e?.code ?? e}` };
  }
  const db = await import("../src/db.js");
  const outbox = await import("../src/outbox.js");
  let r, account;
  try { r = ownerRecipient(); account = db.getAccount(r.conversationId); }
  catch (e) { rmSync(marker, { force: true }); return { outcome: "failed", why: (e?.message ?? String(e)).split("\n")[0] }; }
  const bubbles = [
    welcome.WEB_INTRO({ user: account?.name || config.ownerName, reasonName: "Reason" }),
    ...welcome.bubbles(router, r.channel),
    welcome.HELP_FIRST,
  ];
  // One chain, written before anything is tried: each row waits for the one before it.
  const rows = [];
  try { db.atomically(() => {
    let previous = null;
    for (const [i, b] of bubbles.entries()) {
      const { row } = db.enqueueOutbound({
        idemKey: `welcome-owner:${id}#${i + 1}`, conversationId: r.conversationId, channel: r.channel, address: r.address,
        body: typeof b === "string" ? b : b.text, media: b?.media ?? null, afterId: previous, toOwner: true, maxAttempts: config.outboxMaxAttempts,
      });
      rows.push(row);
      previous = row.id;
    }
  }); } catch (e) { rmSync(marker, { force: true }); return { outcome: "failed", why: (e?.message ?? String(e)).split("\n")[0] }; }
  const results = [];
  for (const [i, row] of rows.entries()) {
    if (i) await sleep(bubbles[i]?.welcome && bubbles[i - 1]?.welcome ? config.onboardingCardGapMs : config.onboardingGapMs);
    const res = await outbox.attempt({ id: row.id, router, log });
    results.push({ n: i + 1, ok: !!res.ok, ...(res.ok ? {} : { why: res.error ?? res.skipped ?? "unknown" }) });
    if (!res.ok) break; // the live outbox sweep finishes the chain in order
  }
  const sentRows = db.db.prepare("SELECT media FROM outbox WHERE conversation_id = ? AND idem_key LIKE ? AND state = 'sent'").all(r.conversationId, `welcome-owner:${id}#%`).map(x => JSON.parse(x.media || "null"));
  const pictures = sentRows.filter(m => m?.file).length;
  const carousel = sentRows.some(m => Array.isArray(m?.carousel));
  writeFileSync(marker, `${new Date().toISOString()} ${results.filter(x => x.ok).length}/${rows.length} sent, ${carousel ? "as ONE carousel" : `${pictures} as pictures`}\n`);
  return { outcome: results.every(x => x.ok) && results.length === rows.length ? "sent" : "partly", sent: results.filter(x => x.ok).length, of: rows.length, pictures, carousel, results };
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
  const r = await sendWelcomeToOwner({ router, log: (x) => { if (x.sent_as_text || x.failed) console.log(JSON.stringify(x)); } });
  console.log(`welcome to owner: ${r.outcome}${r.of ? ` ${r.sent}/${r.of} messages, ${r.carousel ? "cards as ONE carousel" : `${r.pictures} cards as single pictures`}` : ""}${r.why ? ` — ${r.why}` : ""}`);
  for (const x of r.results ?? []) if (!x.ok) console.log(`  #${x.n} held: ${String(x.why).slice(0, 160)}`);
  process.exit(process.exitCode ?? 0); // the database and channel keep handles open
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error((e?.message ?? String(e)).split("\n")[0]); process.exitCode = 1; });
}
