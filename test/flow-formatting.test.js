// The four cases that drove this work, end to end with the real model, through the real delivery
// path, landing on a channel that records what a phone would have received.
//
// The unit tests prove the layout layer cannot be fooled by text that only looks like markdown.
// These prove the other half, which no offline test can reach: that the model, asked an ordinary
// question, writes something this layer turns into a message worth getting — and that the two
// halves agree. The prompt asks for fenced blocks around anything pasteable; if it stopped doing
// that, every unit test would still pass and the feature would be gone. That is what case 3 pins.
//
//   a one-line question          → one bubble, no markers, no page
//   steps in order               → numbered lines that survive, still one message
//   "just text me the prompt"    → no page, and the prompt is its own bubble, whole
//   "a guide i want to keep"     → a page, the link on its own, and the text says something
//
// Asserts on structure only — bubble count, kinds, markers, what is in the database — never on
// wording. Skipped with no model reachable (no API key, no claude-cli backend).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-formatting-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { outgoingParts, COPY } = await import("../src/plain.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
/** Each case gets its own minute so nothing reads as a burst of one message. */
const GAP = 120_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM timers; DELETE FROM pages;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A real runtime on a fake iMessage thread, delivered the way serve.js delivers. */
function harness() {
  const rt = new Runtime();
  const router = new Router();
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async (m) => { await deliver({ ...m, media: null }); });

  async function says(text) {
    clock.skip(GAP);
    const handle = `in-${clock.now()}`;
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    const reply = await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
    return { reply, bubbles: fake.sent.map(m => m.text) };
  }
  return { rt, says, fake };
}

/** The guarantee that applies to every one of these, whatever the model wrote. */
function noMarkersAnywhere(bubbles) {
  for (const b of bubbles) {
    for (const [marker, what] of [["**", "bold"], ["##", "a heading"], ["```", "a fence"]]) {
      assert.ok(!b.includes(marker), `${what} reached the phone: ${JSON.stringify(b.slice(0, 160))}`);
    }
    // A pipe that is a table, not a pipe in a sentence: two of them on one line.
    for (const line of b.split("\n")) {
      assert.ok((line.match(/\|/g) || []).length < 2, `a table row reached the phone: ${JSON.stringify(line)}`);
    }
  }
}

// ---------- 1 ----------

test(`a one-line question gets one bubble with nothing in it a phone cannot draw (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    const { reply, bubbles } = await says("whats the time difference between new york and lisbon rn");
    assert.ok(reply?.length > 0, "it answered");
    noMarkersAnywhere(bubbles);
    assert.equal(bubbles.length, 1, `a short answer is one message, got ${bubbles.length}: ${JSON.stringify(bubbles)}`);
    assert.equal(db.listPages(C).length, 0, "and nothing this small becomes a page");
    // The answer, not a preamble: the number of hours is in there somewhere.
    assert.match(bubbles[0], /\b([45]|four|five)\b/i, `the gap should be in the answer: ${bubbles[0]}`);
  } finally { rt.stop(); }
});

// ---------- 2 ----------

test(`steps in order arrive as numbered lines, in one message (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    const { bubbles } = await says("how do i factory reset a sonos one? give me the steps in order");
    noMarkersAnywhere(bubbles);
    assert.ok(bubbles.length <= config.maxBubbles, `${bubbles.length} bubbles, cap is ${config.maxBubbles}`);
    assert.equal(db.listPages(C).length, 0, "a list of steps is a text, not a page");

    // Numbered lines, and the numbers run upward. The layout layer leaves "1." alone on purpose,
    // so if these are gone it is the prompt that stopped asking for them.
    const all = bubbles.join("\n");
    const numbers = [...all.matchAll(/^\s*(\d+)[.)]\s+\S/gm)].map(m => Number(m[1]));
    assert.ok(numbers.length >= 3, `expected numbered steps, got: ${JSON.stringify(all.slice(0, 400))}`);
    for (let i = 1; i < numbers.length; i++) {
      assert.ok(numbers[i] > numbers[i - 1], `the steps should count up, got ${numbers.join(",")}`);
    }
  } finally { rt.stop(); }
});

// ---------- 3 ----------

test(`asked for a prompt in the thread, it comes as its own bubble and no page (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    const { reply, bubbles } = await says(
      "write me a prompt i can paste into chatgpt for planning a 3 day lisbon trip for me and my partner, "
      + "we like food and small museums. just text it to me here");
    noMarkersAnywhere(bubbles);
    // They said where they wanted it. That is their call, not Reason's.
    assert.equal(db.listPages(C).length, 0, "'just text it to me here' means no page");

    // The model fenced it, which is the thing the prompt asks for and the thing the whole feature
    // rests on. Checked against the raw reply, because by the time it is bubbles the fence is gone.
    const parts = outgoingParts(reply).parts;
    const copy = parts.find(p => p.kind === COPY);
    assert.ok(copy, `the prompt should be in a fenced block; the reply was: ${JSON.stringify(reply.slice(0, 500))}`);
    assert.ok(copy.text.length > 150, `a real prompt, not a one-liner: ${copy.text.length} chars`);
    assert.match(copy.text.toLowerCase(), /lisbon/);

    // And it reached the phone as a bubble of its own, byte for byte — which is what makes
    // press-and-hold copy the prompt and not Reason's lead-in with it.
    assert.ok(bubbles.includes(copy.text), `the pasteable block should be its own bubble, whole`);
    for (const b of bubbles) {
      if (b === copy.text) continue;
      assert.ok(!copy.text.includes(b), `"${b.slice(0, 60)}" ended up inside the thing they paste`);
    }
    assert.ok(bubbles.length >= 2, "Reason's own words are a separate message");
  } finally { rt.stop(); }
});

// ---------- 4 ----------

test(`a guide they want to keep becomes a page, with the link on its own (${label})`, { skip }, async () => {
  const { rt, says } = harness();
  try {
    const { bubbles } = await says(
      "write me a proper guide to brewing better coffee at home - grind, water, ratio, the lot. i want to keep it");
    noMarkersAnywhere(bubbles);

    const pages = db.listPages(C);
    assert.equal(pages.length, 1, `a guide to keep is a page, got ${pages.length}`);
    assert.ok(pages[0].blocks.length >= 4, `a real guide, not one paragraph: ${pages[0].blocks.length} blocks`);

    // The link is its own bubble, so it is tappable rather than buried in a paragraph.
    const links = bubbles.filter(b => /^https?:\/\/\S+$/.test(b.trim()));
    assert.equal(links.length, 1, `exactly one bare link bubble, got ${JSON.stringify(bubbles)}`);
    assert.ok(bubbles.length <= config.maxBubbles, `${bubbles.length} bubbles, cap is ${config.maxBubbles}`);

    // And the message that goes with it says something. "here's the link" and nothing else is the
    // failure the prompt rule is about: if the only way to learn what Reason did is to tap, it failed.
    const words = bubbles.filter(b => !/^https?:\/\/\S+$/.test(b.trim())).join(" ");
    assert.ok(words.length > 40, `the text with the link should carry the answer, got: ${JSON.stringify(words)}`);
    assert.ok(!/\b(link below|see above|this link)\b/i.test(words), `it must not point at the bubble: ${words}`);
  } finally { rt.stop(); }
});
