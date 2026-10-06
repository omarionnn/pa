// Send ONE iMessage screen effect on purpose, to see it land on a real phone.
//
// Why this exists: `mark_moment` is the model's judgement, and a real moment cannot be summoned to
// order — so the effect half of the feature could sit unproved for weeks while tapbacks were
// confirmed in minutes. This fires one deliberately, down the SAME path a reply takes, so what it
// proves is the real thing and not a shortcut:
//
//   - the real outbox (`sendDurable`), so the row survives a restart and a failure is retried;
//   - the real Sendblue adapter, so `send_style` is sent exactly as the docs spell it;
//   - the real hour limit, read off the outbox — this REFUSES inside the hour rather than
//     overriding, because an ops tool that quietly breaks the product's own rule proves nothing
//     about the product. Pass --force only when deliberately testing the limit itself.
//
// It is not a feature and the model cannot reach it: no tool, no route, operator's terminal only.
//
//   node --env-file=.env scripts/fire-effect.js                      # confetti, default words
//   node --env-file=.env scripts/fire-effect.js fireworks "we live"  # pick the effect and the text
//   node --env-file=.env scripts/fire-effect.js --list
//
// REASON_DATA_DIR must point at the live data directory, or this writes to a database nobody reads.
import { config, clock } from "../src/config.js";
import * as db from "../src/db.js";
import * as outbox from "../src/outbox.js";
import { Router } from "../src/channels/router.js";
import { SendblueChannel } from "../src/channels/sendblue.js";
import { SEND_STYLES, checkSendStyle, effectAllowed } from "../src/expressive.js";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const args = argv.filter(a => a !== "--force");

if (args.includes("--list")) {
  console.log(`The 13 effects Sendblue documents:\n  ${SEND_STYLES.join(", ")}`);
  process.exit(0);
}

const style = args[0] || "confetti";
// Deliberately not "watch this" or anything pointing at the animation: the effect plays on OPEN, so
// the words have to read fine on their own. That rule is in the system prompt and it applies here.
const text = args[1] || "testing one of these — it should play when you open it";

const check = checkSendStyle(style);
if (!check.ok) {
  console.error(`✖ ${check.error}`);
  process.exit(1);
}

const conversationId = config.ownerConversation;
const thread = db.getThread(conversationId);
if (!thread) {
  console.error(`✖ no thread on record for ${conversationId} — nothing has arrived on it yet, so there is nowhere to send.`);
  process.exit(1);
}
if (thread.service && !/^imessage$/i.test(thread.service)) {
  console.error(`✖ that thread is ${thread.service}, and screen effects are iMessage only.`);
  process.exit(1);
}

const lastAt = db.lastEffectAt(conversationId);
const allowed = effectAllowed({ lastAt, now: clock.now() });
if (!allowed.ok && !force) {
  console.error(
    `✖ this conversation had an effect ${Math.round((clock.now() - lastAt) / 60_000)} min ago, so the next is in about ${allowed.minutes} min.\n`
    + `  That is the product's own one-an-hour rule, read off the outbox. Wait, or --force to test the limit.`,
  );
  process.exit(1);
}

const router = new Router({ runtime: null });
router.register(new SendblueChannel());
const sendblue = router.get("sendblue");
const missing = sendblue?.missing?.() ?? ["sendblue"];
if (missing.length) {
  console.error(`✖ Sendblue is not configured here: missing ${missing.join(", ")}. Run with --env-file=.env.`);
  process.exit(1);
}

console.log(`→ ${style} on "${text}"`);
console.log(`  to ${thread.address} on ${thread.channel}${lastAt ? "" : "  (first effect ever sent from this install)"}`);

const r = await outbox.sendDurable({
  channel: thread.channel, router, conversationId,
  to: thread.address, chatId: thread.chat_id ?? null,
  text, sendStyle: check.value, toOwner: true,
  idempotencyKey: `fire-effect:${check.value}:${clock.now()}`,
  log: (l) => console.log("  ", JSON.stringify(l)),
});

// On the record like any effect, so "why did it do confetti" has an answer that does not depend on
// somebody remembering they ran a script.
db.recordAction({
  conversationId, action: "mark_moment", target: `effect:${check.value}`,
  attempted: { effect: check.value, moment: "fired by hand from scripts/fire-effect.js", text },
  outcome: r.ok ? "ok" : "failed",
  result: { outbox_id: r.outbox_id ?? null, message_id: r.delivered?.message_id ?? null, error: r.error ?? null },
  receipt: r.ok
    ? `Sent a '${check.value}' screen effect on a message, fired by hand to check the rail — not a moment the model judged.`
    : `Tried to send a '${check.value}' screen effect by hand and it did not go: ${r.error}`,
});

if (r.ok) {
  console.log(`✔ sent — outbox ${r.outbox_id}, message ${r.delivered?.message_id ?? "(no id returned)"}`);
  console.log("  Open the thread on the phone to see it: effects play on OPEN, not on arrival.");
  console.log("  If the message arrives with no animation, Sendblue accepted send_style and the device ignored it — say so rather than calling the feature working.");
} else {
  console.error(`✖ did not send: ${r.error}`);
  if (r.queued) console.error(`  Row ${r.outbox_id} is still in the outbox and the live server will retry it.`);
  process.exit(1);
}
