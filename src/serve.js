// `npm run serve` — Reason as a process that stays up.
//
// This is the thing that makes Reason work between messages rather than only when someone is
// typing at it. It owns one runtime, sweeps on an interval (timers, tasks, watchers, dropped
// threads), and listens for inbound webhooks. Nothing here holds state: everything a restart
// needs is already a row, so this process can be killed at any moment and the next one carries on.
//
// It starts cleanly with no credentials at all. A channel with no key reports not_connected, the
// capabilities tool says texting is not available, and Reason tells people so instead of
// pretending. That is the point: an install with nothing configured should still run.
import { Runtime } from "./runtime.js";
import { Router } from "./channels/router.js";
import { ConsoleChannel } from "./channels/console.js";
import { SendblueChannel } from "./channels/sendblue.js";
import { LinqChannel } from "./channels/linq.js";
import { FakeCallProvider } from "./calls/fake.js";
import { createServer } from "./http.js";
import { subscriptionBackendBlock } from "./backends/guard.js";
import { config, stamp } from "./config.js";

const verbose = process.argv.includes("--log");
const log = (e) => { if (verbose) console.log("   ·", JSON.stringify(e)); };

// Before anything binds a port or opens the database: the subscription backend may not be the
// thing answering other people's texts. One person's Claude plan is not a service.
const block = subscriptionBackendBlock({
  backend: config.backend,
  channels: [new ConsoleChannel().status(), new SendblueChannel().status(), new LinqChannel().status()],
  ownerName: config.ownerName,
});
if (block.blocked) {
  console.error(block.message);
  process.exit(1);
}

const router = new Router({ log });
// No paid telephony account exists. The fake provider dials nothing, and is deliberately
// registered switched OFF: a provider that reported itself live would make `capabilities` tell
// people Reason can ring a restaurant, which it cannot. Tests switch it on themselves.
const calls = new FakeCallProvider({ live: false });

/**
 * Outbound goes back out the way it came in. The console prints; a channel thread texts.
 *
 * When `media` is set, the runtime has a call recording waiting and wants it on this message. It
 * is one `sendMedia` rather than a text followed by a file, so the owner gets a single message
 * carrying the summary and the audio. `mediaOk: false` tells the runtime the audio did NOT go, so
 * it stays queued rather than being written down as sent — then the text is sent on its own with
 * a line saying the recording could not be delivered, because the alternative is Reason claiming
 * to have sent something it did not.
 */
const consoleChannel = new ConsoleChannel();
async function deliver({ conversationId, text, media, channel, to, chatId, fromOwner, isOperator }) {
  const name = channel ?? (conversationId === config.ownerConversation ? "console" : null);
  const target = !name || name === "console" ? consoleChannel : null;
  // Which thread owes this message, and whether a failure to deliver it is news for somebody else.
  // `fromOwner` is set by the router when this reply is going back to the person whose Reason this
  // is; without it the owner would be told about failing to reach themselves, which is noise.
  const durable = { conversationId, toOwner: fromOwner ?? (conversationId === config.ownerConversation) };
  void isOperator;

  if (media) {
    const r = target
      ? await target.sendMedia({ to, text, file: media.file, mimeType: media.mimeType, filename: media.filename })
      : await router.sendMedia({ channel: name, to, text, chatId, file: media.file, mimeType: media.mimeType, filename: media.filename, ...durable });
    if (r.ok && !r.queued) return { ok: true, mediaOk: true };
    // Still trying. The audio stays queued on the call row too, because it has not arrived.
    if (r.queued) return { ok: true, mediaOk: false, queued: true, error: r.error };

    console.error(`could not send the recording of call #${media.call_id} over ${name ?? "console"}: ${r.error}`);
    const fallback = `${text}\n\n(i couldn't get you the recording of that call here — ${r.error})`;
    const t = target ? await target.send({ to, text: fallback }) : await router.send({ channel: name, to, text: fallback, chatId, ...durable });
    if (!t.ok && !t.queued) console.error(`could not send over ${name}: ${t.error}`);
    return { ok: t.ok || !!t.queued, mediaOk: false, error: r.error };
  }

  const r = target ? await target.send({ to, text }) : await router.send({ channel: name, to, text, chatId, ...durable });
  // A queued message is not a failure to report to stderr and forget — it is a row that will either
  // arrive or be reported. Only a dead one is worth shouting about here.
  if (!r.ok && !r.queued) console.error(`could not send over ${name}: ${r.error}`);
  if (r.queued) log({ outbound_queued: conversationId, to, why: r.error });
  return { ok: r.ok || !!r.queued, mediaOk: true, error: r.error };
}

const runtime = new Runtime({ log, channels: router, calls, deliver });

router.runtime = runtime;
router.register(consoleChannel);
// Both texting adapters are registered; each reports not_connected without its own credentials, so
// a Sendblue-only install behaves exactly as a Linq-only install did, and neither is special.
router.register(new SendblueChannel());
router.register(new LinqChannel());

// `say()` still goes out as an event — those are code-written lines with nothing attached.
runtime.on("outbound", async ({ conversationId, text, channel, to, chatId, fromOwner }) => {
  await deliver({ conversationId, text, media: null, channel, to, chatId, fromOwner });
});
runtime.on("error", (e) => console.error("runtime error:", e?.message ?? e));

runtime.start(config.sweepEveryMs);

const server = createServer({ router, runtime, log });
server.listen(config.port, config.host, () => {
  console.log(`Reason is up · ${stamp()}`);
  if (config.backend === "claude-cli") {
    console.log(`  model: the claude CLI on ${config.ownerName}'s subscription — ${config.ownerName}'s own testing only.`);
    console.log(`         ONLY these numbers get answers: ${config.testNumbers.join(", ") || "(none — serve would have refused to start)"}`);
    console.log(`         Every other number gets one "not available yet" line and no model turn.`);
    console.log(`         An Anthropic API key with credit is required before anybody else is served.`);
  } else {
    console.log(`  model: the Anthropic API (${config.model})${process.env.ANTHROPIC_API_KEY ? "" : " — NO ANTHROPIC_API_KEY set, so no turn can run"}`);
  }
  console.log(`  sweeping every ${Math.round(config.sweepEveryMs / 1000)}s (timers, tasks, watchers, dropped threads)`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  for (const s of router.statuses()) {
    console.log(`  ${s.name}: ${s.status}${s.missing?.length ? ` (needs ${s.missing.join(", ")})` : ""}`);
    if (s.status === "live" && s.name !== "console") console.log(`    webhook → POST http://${config.host}:${config.port}/channels/${s.name}/webhook`);
  }
  const cs = calls.status();
  console.log(`  calls: ${cs.status} — no telephony provider is wired up; Reason will say so`);
  console.log(`  pages: ${config.publicUrl ? `${config.publicUrl}/p/<id>` : `http://${config.host}:${config.port}/p/<id>  (REASON_PUBLIC_URL not set, so links only open on this machine)`}`);
  console.log(`  call recording: always on — every call announces it, and the audio goes to ${config.ownerName} with the summary`);
  if (!config.ownerNumbers.length) {
    console.log(`  note: REASON_OWNER_NUMBER is not set, so no inbound number counts as ${config.ownerName}.`);
    console.log(`        Every inbound text lands in a stranger's thread and can authorize nothing.`);
  }
  console.log("");
});

async function shutdown(signal) {
  console.log(`\n${signal} — finishing what's in flight…`);
  server.close();
  await runtime.idle().catch(() => {});
  await runtime.shutdown().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
