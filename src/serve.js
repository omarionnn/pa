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
import "./logmask-install.js"; // first: phone numbers out of every printed line (src/logmask.js)
import { Runtime } from "./runtime.js";
import { socialMode as socialSigninMode } from "./socialsignin.js";
import { requireKey as requireTokenKey } from "./secretbox.js";
import { Router } from "./channels/router.js";
import { ConsoleChannel } from "./channels/console.js";
import { SendblueChannel } from "./channels/sendblue.js";
import { LinqChannel } from "./channels/linq.js";
import { WebChannel } from "./channels/web.js";
import { webOn } from "./web.js";
import { chooseCallProvider } from "./calls/choose.js";
import { createServer } from "./http.js";
import { withGptLive } from "./calls/gptlive.js";
import { makeDeliver } from "./deliver.js";
import { backfillContactCards } from "./contact.js";
import { endAllRemoteSignins } from "./signin-remote.js";
import { subscriptionBackendBlock } from "./backends/guard.js";
import { retentionSays } from "./privacy.js";
import { startOps, watchFetch } from "./ops.js";
import { config, stamp } from "./config.js";
import { preconfirmOperator } from "./zone.js";

// Before any adapter is built: the channels take `globalThis.fetch` in their constructors, so the
// status page's count of outbound calls has to be in place first or it would miss every text.
watchFetch();

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

// Stored AgentCard tokens are sealed under REASON_TOKEN_KEY (src/secretbox.js). A server without the
// key would either refuse every purchase or, worse, be tempted to store plain text — so it does not
// start, and says why.
try { requireTokenKey(); } catch (e) {
  console.error(e.message);
  process.exit(1);
}

const router = new Router({ log });
// Whichever call provider REASON_CALL_PROVIDER names. `gptlive` is Reason's own voice over Twilio
// (src/calls/gptlive.js); `bland` is live only with a BLAND_API_KEY; the default `fake` dials nothing and is registered switched OFF, because a
// provider that reported itself live would make `capabilities` tell people Reason can ring a
// restaurant, which it cannot. Tests switch it on themselves.
// With REASON_CALL_VOICE=gptlive in front of another provider, every account's own calls go out on GPT-Live
// instead (=owner: the operator's); unset, or with gptlive as the provider, this is the provider itself.
const calls = withGptLive(chooseCallProvider());

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
// Reason Web's channel, only while REASON_WEB is `owner` or `on`. Off, the name `web` is not a
// channel at all, so nothing can be routed to it and the install runs exactly as it did (src/web.js).
if (webOn()) router.register(new WebChannel());

// `say()` still goes out as an event — those are code-written lines with nothing attached.
runtime.on("outbound", async ({ conversationId, text, channel, to, chatId, fromOwner, replyTo, sendStyle, toMaster, idempotencyKey }) => {
  await deliver({ conversationId, text, media: null, channel, to, chatId, fromOwner, replyTo, sendStyle, toMaster: !!toMaster, idempotencyKey: idempotencyKey ?? null });
});
runtime.on("error", (e) => console.error("runtime error:", e?.message ?? e));

// The operator's own zone is known (owner, 2026-10-30): never asked, never guessed.
{ const n = preconfirmOperator(); if (n) console.log(`time zone: operator account confirmed on ${config.installTz}`); }
runtime.start(config.sweepEveryMs);
// The status page's checks, every five minutes, texting the owner when something changes state.
startOps({ runtime, router, log });
// Crossmint checkouts (src/shopconnect.js, REASON_SHOP_CONNECT): how to text a sign-in link or a payment
// ask, and the runs a restart interrupted, followed again.
{
  const shop = await import("./shopconnect.js");
  if (shop.connectMode() !== "off") {
    shop.attach({
      say: (c, text) => runtime.say(c, text),
      // A plain question from the store, or the confirmation email: an event turn, keyed so a restart
      // cannot raise the same one twice.
      wake: (c, text, { key } = {}) => runtime.event(c, text, { idempotencyKey: key }),
      log,
    });
    const resumed = shop.resumeFollowing();
    if (resumed.runs.length || resumed.mail.length) log({ checkouts_resumed: resumed.runs.length, mail_watches_resumed: resumed.mail.length });
  }
}

const server = createServer({ router, runtime, log });
server.listen(config.port, config.host, () => {
  console.log(`Reason is up · ${stamp()}`);
  // Encryption at rest (REASON_ENCRYPT_REST=on): old plain rows are sealed in the background, small batches.
  import("./db.js").then((d) => d.startRestMigration({ log })).catch((e) => console.error("encrypt-rest migration:", e?.message ?? e));
  // A call whose summary and audio a restart cut off (call 57, 2026-10-31): sent now, once.
  import("./calls/postcall.js")
    .then(({ resumeSettles }) => resumeSettles({ runtime, log }))
    .then((ids) => { if (ids.length) console.log(`  after-call: finished ${ids.length} call(s) a restart cut off (${ids.join(", ")})`); })
    .catch((e) => console.error("after-call resume:", e?.message ?? e));
  // Reason's contact card, once, to everybody who has an account and has not had it. After the
  // port is open, because Sendblue fetches the card from this process the moment it is asked to.
  backfillContactCards({ router, log })
    .then((r) => { if (r.sent || r.failed) console.log(`  contact card: sent to ${r.sent}${r.failed ? `, failed for ${r.failed} (see --log)` : ""}`); })
    .catch((e) => console.error("contact card:", e?.message ?? e));
  // A message that hit the restart gap is gone — Sendblue retries on 5xx but gives up if the
  // server is down for all attempts. Poll once for anything in the last 90 seconds that this
  // process never saw. The router's claimInbound dedupe means already-processed messages are free.
  // Only the install the channel actually delivers to may do this (see SendblueChannel.ownsWebhook):
  // a skip for any other reason than "not connected" is said out loud, because a second install
  // quietly holding the same keys is exactly the thing the guard exists for.
  for (const ch of router.list()) {
    if (typeof ch.catchUp !== "function") continue;
    ch.catchUp().then(async (r) => {
      if (r.skipped && r.why !== "not connected") {
        console.log(`  catch-up: skipped for ${ch.name} — ${r.why}`);
        log({ catch_up_skipped: ch.name, why: r.why });
        return;
      }
      if (!r.ok || !r.messages?.length) return;
      let recovered = 0;
      for (const msg of r.messages) {
        const result = await router.deliver({ ...msg, channel: ch.name });
        if (result.ok && !result.duplicate) recovered++;
      }
      if (recovered) console.log(`  catch-up: recovered ${recovered} message(s) from ${ch.name} restart gap`);
    }).catch((e) => log({ catch_up_error: ch.name, error: (e?.message ?? String(e)).split("\n")[0] }));
  }
  if (config.backend === "claude-cli") {
    console.log(`  model: the claude CLI on ${config.ownerName}'s subscription — ${config.ownerName}'s own testing only.`);
    console.log(`         ONLY these numbers get answers: ${config.testNumbers.join(", ") || "(none — serve would have refused to start)"}`);
    console.log(`         Every other number gets one "not available yet" line and no model turn.`);
    console.log(`         An Anthropic API key with credit is required before anybody else is served.`);
  } else {
    console.log(`  model: the Anthropic API (${config.model})${process.env.ANTHROPIC_API_KEY ? "" : " — NO ANTHROPIC_API_KEY set, so no turn can run"}`);
  }
  console.log(`  sweeping every ${Math.round(config.sweepEveryMs / 1000)}s (timers, tasks, watchers, dropped threads, retention)`);
  // Said at startup rather than left in a doc. Whoever runs this is answerable for how long other
  // people's voice notes sit on their disk, and should not have to read the source to find out.
  console.log(`  keeping: ${retentionSays()}`);
  if (verbose && process.env.REASON_LOG_CONTENT === "1") {
    console.log(`    --log with REASON_LOG_CONTENT=1: tool results are logged IN FULL, page text and transcripts included`);
  }
  // The GPT-Live pre-open while it rings / from the inbound webhook (PR #407): the armed mode, once.
  if (config.gptlivePrering || config.gptliveInboundPreopen) {
    const who = (v) => v === "owner" ? "owner only" : v ? "everyone" : "off";
    console.log(`  call pre-open: outbound ${who(config.gptlivePrering)} · inbound ${who(config.gptliveInboundPreopen)} · greet ${config.gptlivePreringGreet} · inbound wait ${config.gptliveInboundWaitMs} ms`);
  }
  // Signing in through a Google/Apple/Facebook/Microsoft account (src/socialsignin.js): said once, armed or not.
  if (socialSigninMode() !== "off") console.log(`  social sign-in: ${socialSigninMode() === "owner" ? "owner only" : "everyone"} (REASON_SOCIAL_SIGNIN)`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  for (const s of router.statuses()) {
    console.log(`  ${s.name}: ${s.status}${s.missing?.length ? ` (needs ${s.missing.join(", ")})` : ""}`);
    if (s.status === "live" && s.name !== "console") console.log(`    webhook → POST http://${config.host}:${config.port}/channels/${s.name}/webhook`);
  }
  if (config.parallelKey) {
    console.log(`  parallel: extract ${config.lookupProvider === "parallel" ? "first" : "fallback"}, deep research ${config.researchDeepProvider}, quick answers ${config.researchAnswerProvider}, monitors, pictures, lists`);
    console.log(`    ${config.publicUrl && config.parallelWebhookSecret
      ? `webhook → POST ${config.publicUrl}/parallel/webhook`
      : `no ${config.publicUrl ? "PARALLEL_WEBHOOK_SECRET" : "REASON_PUBLIC_URL"}, so deep runs and monitors are polled on the task schedule rather than pushed`}`);
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
  // Set before anything is awaited. `systemctl restart` signals every process in the unit's cgroup,
  // so the model's CLI is dying at this same moment and the turn riding on it is about to fail.
  // From here that failure reads as unfinished rather than broken: nobody is told it broke, and
  // whatever it was answering goes back on the pile for the next process. See Runtime.inbound.
  runtime.stopping = true;
  server.close();
  // A sign-in somebody is in the middle of: ask the site what it thinks and let go of their
  // profile, rather than leaving a browser holding it.
  await endAllRemoteSignins("shutdown").catch(() => {});
  await runtime.idle().catch(() => {});
  // After the turns, because putting the messages back happens once the turn holding them has
  // failed. Without this the process could exit in the gap between the two and lose them.
  await router.idle().catch(() => {});
  await runtime.shutdown().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
