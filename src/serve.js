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
import { chooseCallProvider } from "./calls/choose.js";
import { createServer } from "./http.js";
import { makeDeliver } from "./deliver.js";
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
// Whichever call provider REASON_CALL_PROVIDER names. `bland` is the real one and is live only
// with a BLAND_API_KEY; the default `fake` dials nothing and is registered switched OFF, because a
// provider that reported itself live would make `capabilities` tell people Reason can ring a
// restaurant, which it cannot. Tests switch it on themselves.
const calls = chooseCallProvider();

// How a message leaves — a reply back the way it came, and anything Reason starts itself (a
// reminder, a task's news, a watcher) to the thread that conversation lives in. See src/deliver.js.
const consoleChannel = new ConsoleChannel();
const deliver = makeDeliver({ router, consoleChannel, log });

const runtime = new Runtime({ log, channels: router, calls, deliver });

router.runtime = runtime;
router.register(consoleChannel);
// Both texting adapters are registered; each reports not_connected without its own credentials, so
// a Sendblue-only install behaves exactly as a Linq-only install did, and neither is special.
router.register(new SendblueChannel());
router.register(new LinqChannel());

// `say()` still goes out as an event — those are code-written lines with nothing attached.
runtime.on("outbound", async ({ conversationId, text, channel, to, chatId, fromOwner, replyTo }) => {
  await deliver({ conversationId, text, media: null, channel, to, chatId, fromOwner, replyTo });
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
  console.log(`  calls: ${cs.name} — ${cs.status}${cs.missing?.length ? ` (needs ${cs.missing.join(", ")})` : ""}`);
  if (cs.status === "live") {
    console.log(`    ${config.publicUrl
      ? `call-finished webhook → POST ${config.publicUrl}/calls/${cs.name}/webhook/<per-call token>`
      : `no REASON_PUBLIC_URL, so outcomes are polled by call_status rather than pushed`}`);
    if (cs.name === "bland" && !config.blandWebhookSecret) {
      console.log(`    no BLAND_WEBHOOK_SECRET: a call-finished webhook is accepted on its per-call token alone, not a signature`);
    }
    console.log(`    per person per day: ${config.maxCallsPerDay || "unlimited"} calls, ${config.maxCallMinutesPerDay || "unlimited"} minutes`);
  } else {
    console.log(`    Reason cannot ring anyone and will say so`);
  }
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
