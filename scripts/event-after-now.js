// The event onboarding's morning after, NOW, on the owner's own thread (src/eventonboarding.js), so
// the owner can test it without waiting for the day after an event:
//
//   sudo -u reason node --env-file=.env scripts/event-after-now.js --event=<id or page id> --confirm=event-after
//   (optional --guest=<conversation id>: the owner's own or a REASON_TEST_NUMBERS thread; default the owner's)
//
// Sends nothing itself. It (re)starts that person's row for the event, marked forced (no waiting for
// the event's time, no guest-list check), and arms the morning-after timer for right now. The live
// service's timer sweep fires it within a few seconds through the real path: "how was {event}?";
// their reply then gets the normal answer, "i can do more than events…", the seven cards, and the
// surprise-call offer. Refuses under REASON_EVENT_ONBOARDING=off and for anybody but the owner's numbers.
// Run again to start over (once-per-person is reset for the owner's own thread only).
import { pathToFileURL } from "node:url";

export async function armNow({ event, guest = null }) {
  const db = await import("../src/db.js");
  const eo = await import("../src/eventonboarding.js");
  const { ownerRecipient } = await import("./announce.js");
  if (eo.mode() === "off") return { outcome: "refused", why: "REASON_EVENT_ONBOARDING is off" };
  const ev = /^\d+$/.test(String(event ?? "")) ? db.getEventRow(Number(event)) : db.eventByPublicId(String(event ?? ""));
  if (!ev) return { outcome: "refused", why: `no event ${event}` };
  if (ev.status === "cancelled") return { outcome: "refused", why: "that event is cancelled" };
  const { config } = await import("../src/config.js");
  // The owner's texting thread (announce.js), else the configured owner conversation.
  const conv = guest || (() => { try { return ownerRecipient().conversationId; } catch { return config.ownerConversation; } })();
  const acct = db.getAccount(conv);
  if (!acct) return { outcome: "refused", why: `no account ${conv}` };
  if (!eo.ownerTest(conv, acct.address)) return { outcome: "refused", why: "only the owner's own thread or a REASON_TEST_NUMBERS number" };
  eo.register({ conversationId: conv, eventId: ev.id, forced: true });
  const t = eo.schedule(conv, { at: Date.now() });
  return { outcome: "armed", conversationId: conv, event: { id: ev.id, name: ev.name }, timer: t?.id ?? null };
}

async function main() {
  if (!process.argv.includes("--confirm=event-after")) {
    console.log("usage: node --env-file=.env scripts/event-after-now.js --event=<id or page id> [--guest=<conversation id>] --confirm=event-after");
    process.exitCode = 2;
    return;
  }
  const event = process.argv.find(a => a.startsWith("--event="))?.slice(8);
  const guest = process.argv.find(a => a.startsWith("--guest="))?.slice(8) || null;
  const out = await armNow({ event, guest });
  console.log(JSON.stringify(out));
  if (out.outcome !== "armed") process.exitCode = 1;
  else console.log("the live service sends \"how was …?\" within a few seconds; reply to it to get the cards and the call offer");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error((e?.message ?? String(e)).split("\n")[0]); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 50));
}
