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
import { LinqChannel } from "./channels/linq.js";
import { FakeCallProvider } from "./calls/fake.js";
import { createServer } from "./http.js";
import { config, stamp } from "./config.js";

const verbose = process.argv.includes("--log");
const log = (e) => { if (verbose) console.log("   ·", JSON.stringify(e)); };

const router = new Router({ log });
// No paid telephony account exists, so the only provider is one that dials nothing.
const calls = new FakeCallProvider();
const runtime = new Runtime({ log, channels: router, calls });

router.runtime = runtime;
router.register(new ConsoleChannel());
router.register(new LinqChannel());

// Outbound goes back out the way it came in. The console prints; a channel thread texts.
runtime.on("outbound", async ({ conversationId, text, channel, to, chatId }) => {
  const name = channel ?? (conversationId === config.ownerConversation ? "console" : null);
  if (!name || name === "console") {
    console.log(`reason> ${text}\n`);
    return;
  }
  const r = await router.send({ channel: name, to, text, chatId });
  if (!r.ok) console.error(`could not send over ${name}: ${r.error}`);
});
runtime.on("error", (e) => console.error("runtime error:", e?.message ?? e));

runtime.start(config.sweepEveryMs);

const server = createServer({ router, runtime, log });
server.listen(config.port, config.host, () => {
  console.log(`Reason is up · ${stamp()}`);
  console.log(`  sweeping every ${Math.round(config.sweepEveryMs / 1000)}s (timers, tasks, watchers, dropped threads)`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  for (const s of router.statuses()) {
    console.log(`  ${s.name}: ${s.status}${s.missing?.length ? ` (needs ${s.missing.join(", ")})` : ""}`);
    if (s.status === "live" && s.name !== "console") console.log(`    webhook → POST http://${config.host}:${config.port}/channels/${s.name}/webhook`);
  }
  const cs = calls.status();
  console.log(`  calls: ${cs.name} (${cs.status}) — places no real calls`);
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
