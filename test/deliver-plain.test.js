// The layout guarantees where they actually have to hold: on the way out, through the real
// deliver function, over a channel that records what it was handed.
//
// test/plain.test.js proves the rules on strings. This proves they are WIRED — that the thing a
// phone receives went through them, that the bubble split survived the outbox, and that the one
// path which does not split (a summary arriving with its recording) still gets the markers taken
// off. Every assertion here is on `fake.sent`, which is the last place the text exists before a
// real adapter would put it on the wire.
//
//   does a reply with markdown in it reach the channel without the markers?   (yes)
//   does something to paste arrive as its own message, whole?                 (yes — and alone)
//   does a reply over the cap arrive as fewer, longer messages?               (yes — merged, not cut)
//   does the summary on a recording get stripped too?                         (yes — one message)
//   is the stripping assumed, or asked of the adapter?                        (asked)
//
// No model, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-deliver-plain-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const CONV = "dm:owner";

/** A real file, because the fake channel reads the bytes rather than trusting the path. */
const RECORDING = join(dir, "call-7.wav");
writeFileSync(RECORDING, Buffer.alloc(2048, 1));

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

/** The server's own wiring: a router, the registered fake, and the deliver function serve.js uses. */
function harness({ channel = {} } = {}) {
  const logs = [];
  const warned = [];
  const printed = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: (s) => printed.push(s) });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: (l) => warned.push(l) });
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+15122164639", ...channel }));
  const send = (text, extra = {}) => deliver({ conversationId: CONV, text, media: null, fromOwner: true, ...extra });
  return { router, fake, deliver, send, logs, warned, printed };
}

/** What the phone got, in order. */
const bubbles = (fake) => fake.sent.map(m => m.text);

// ---------- 1. the markers are off by the time it leaves ----------

test("a reply written with markdown in it reaches the channel with none of it", async () => {
  const { fake, send } = harness();
  const r = await send("**grind finer** and use `brew install`\n\n## Why\nit's _the_ main thing");
  assert.equal(r.ok, true);

  // One message, because none of this changes the bubble structure — only the characters.
  assert.equal(fake.sent.length, 1, `one bubble, got ${fake.sent.length}`);
  assert.equal(bubbles(fake)[0], "grind finer and use brew install\n\nWhy\nit's the main thing");
  for (const c of ["**", "##", "`", "_the_"]) {
    assert.ok(!fake.sent[0].text.includes(c), `no ${c} should survive`);
  }
});

test("a markdown table never leaves as pipes", async () => {
  const { fake, send } = harness();
  await send("the two i'd look at:\n\n| phone | price |\n|---|---|\n| Pixel 9a | $499 |\n| iPhone 16e | $599 |");
  assert.equal(fake.sent.length, 1);
  assert.ok(!fake.sent[0].text.includes("|"), `pipes reached the phone: ${fake.sent[0].text}`);
  assert.match(fake.sent[0].text, /Pixel 9a\nprice: \$499/);
});

test("a reply with nothing in it to strip is byte for byte the one the model wrote", async () => {
  const { fake, send } = harness();
  const wrote = "lisbon's 5 hours ahead, so it's 2:37am there\n\nthe gap stays 5 hours all year";
  await send(wrote);
  assert.deepEqual(bubbles(fake), [wrote]);
});

test("the stripping is asked of the adapter, not assumed: one that draws markdown keeps it", async () => {
  const plainFake = harness();
  await plainFake.send("**bold**");
  assert.deepEqual(bubbles(plainFake.fake), ["bold"]);

  // No real channel answers true. The flag exists so the claim has to be made somewhere.
  const richFake = harness({ channel: { rendersMarkdown: true } });
  await richFake.send("**bold**");
  assert.deepEqual(bubbles(richFake.fake), ["**bold**"], "a channel that renders them should get them");
});

// ---------- 2. something to paste arrives on its own, whole ----------

test("a fenced block is its own message, exactly as written, with the words around it separate", async () => {
  const { fake, send, logs } = harness();
  const prompt = "I'm planning a 3-day trip to Lisbon.\n\nBudget: [budget]. Keep it to **small** museums_only.";
  await send(`here you go, just fill in the brackets:\n\n\`\`\`\n${prompt}\n\`\`\`\n\nwant it as a page too?`);

  assert.deepEqual(bubbles(fake), [
    "here you go, just fill in the brackets:",
    prompt,
    "want it as a page too?",
  ]);
  // The thing they press and hold is the prompt and nothing else — not a word of Reason's around
  // it, and not one character of it changed, markdown-looking or not.
  assert.equal(fake.sent[1].text, prompt, "the block is untouched inside the fences");
  assert.ok(logs.some(l => l.parts?.join() === "text,copy,text"), `the kinds should be logged: ${JSON.stringify(logs)}`);
});

test("the pasteable block arrives in order, and the outbox has a row for each bubble", async () => {
  const { fake, send } = harness();
  await send("try this:\n\n```js\nconst x = 1;\n```");
  assert.deepEqual(bubbles(fake), ["try this:", "const x = 1;"]);
  const rows = db.db.prepare("SELECT state FROM outbox WHERE conversation_id = ?").all(CONV);
  assert.equal(rows.length, 2, "two durable rows, so neither bubble can be quietly lost");
  assert.ok(rows.every(r => r.state === "sent"));
});

test("a link is still its own bubble and the address is not touched on the way", async () => {
  const { fake, send } = harness();
  await send("your coffee guide, **saved**: https://reason.tail3753c7.ts.net/p/utagn27s0h?k=RU8hxbDh2qwl");
  assert.equal(fake.sent.length, 2);
  // Words that end on a colon point at the link, so they land first and the link under them. This
  // used to assert the other order, which is the bubble ending on a colon that 2026-10-06 showed.
  assert.equal(fake.sent[0].text, "your coffee guide, saved:");
  assert.equal(fake.sent[1].text, "https://reason.tail3753c7.ts.net/p/utagn27s0h?k=RU8hxbDh2qwl", "the link, whole and alone");
});

// ---------- 3. the cap merges, and loses nothing ----------

test("a long answer is still one message: paragraphs are not bubbles", async () => {
  const { fake, send, logs } = harness();
  const paragraphs = ["one", "two", "three", "four", "five", "six"];
  await send(paragraphs.join("\n\n"));
  // The cap is about bubbles, and a blank line between two ideas has never made a second one. Six
  // paragraphs is a long message, not a thread of fragments, and it arrives as the owner wrote it.
  assert.deepEqual(bubbles(fake), [paragraphs.join("\n\n")]);
  assert.ok(!logs.some(l => l.bubbles_over_cap), "nothing here is over the cap");
});

test("five pieces become four, by joining neighbours, with every word still there", async () => {
  const { fake, send } = harness();
  const a = "first thing";
  const b = "second thing";
  const link = "https://reason.tail3753c7.ts.net/p/abc123";
  // link, words, paste, words → the link split and a fenced block make four on their own; one more
  // paragraph takes it to five, and the only legal join is the two bits of prose next to each other.
  await send(`${a}\n\n${b} ${link}\n\n\`\`\`\nPASTE ME\n\`\`\`\n\nlast word`);

  assert.ok(fake.sent.length <= config.maxBubbles, `${fake.sent.length} bubbles, cap is ${config.maxBubbles}`);
  const all = bubbles(fake).join("\n");
  for (const piece of [a, b, link, "PASTE ME", "last word"]) {
    assert.ok(all.includes(piece), `"${piece}" should still have arrived`);
  }
  // Merging never puts commentary inside the thing they paste, and never buries the link.
  assert.ok(fake.sent.some(m => m.text === "PASTE ME"), "the pasteable bubble is still only the paste");
  assert.ok(fake.sent.some(m => m.text === link), "the link is still a bubble of its own");
});

test("a reply the cap cannot fix still goes out whole, and says so in the log", async () => {
  const { fake, send, logs } = harness();
  // Three things to paste: four bubbles minimum with nothing joinable between them, plus prose.
  await send("a\n\n```\nONE\n```\n\nb\n\n```\nTWO\n```\n\nc\n\n```\nTHREE\n```");

  const all = bubbles(fake);
  for (const piece of ["ONE", "TWO", "THREE"]) {
    assert.ok(all.includes(piece), `${piece} is still its own bubble`);
  }
  assert.ok(all.join("\n").includes("a"), "the prose arrived too");
  assert.ok(fake.sent.length > config.maxBubbles, "this is the case the cap yields on");
  const over = logs.find(l => l.bubbles_over_cap);
  assert.ok(over, "and it is logged rather than passing silently");
  assert.equal(over.cap, config.maxBubbles);
  assert.equal(over.bubbles_over_cap, fake.sent.length);
});

// ---------- 4. the summary that travels with a recording ----------

test("the summary arriving with a call recording is one message, with the markers off it", async () => {
  const { fake, deliver } = harness();
  const r = await deliver({
    conversationId: CONV,
    text: "she said **yes** to friday — the `7:40` one",
    media: { file: RECORDING, mimeType: "audio/wav", filename: "call-7.wav", call_id: 7 },
    fromOwner: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.mediaOk, true);

  // One message carrying both, which is the whole point of this path — so it is never split, and
  // the stripping has to happen without splitting it.
  assert.equal(fake.sent.length, 1, "the summary and the audio are one message");
  assert.equal(fake.sent[0].text, "she said yes to friday — the 7:40 one");
  assert.equal(fake.sent[0].media.filename, "call-7.wav");
  assert.ok(fake.sent[0].media.bytes > 0, "the audio really went with it");
});

test("when the recording cannot go, the text that falls back is stripped too", async () => {
  const { fake, deliver, warned } = harness({ channel: { mediaFailWith: "that number can't take attachments" } });
  const r = await deliver({
    conversationId: CONV,
    text: "she said **yes** to friday",
    media: { file: RECORDING, mimeType: "audio/wav", filename: "call-7.wav", call_id: 7 },
    fromOwner: true,
  });
  assert.equal(r.mediaOk, false, "the audio did not go and nobody pretends it did");
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0].text, /^she said yes to friday/, "no asterisks in the fallback either");
  assert.match(fake.sent[0].text, /couldn't get you the recording/);
  assert.ok(warned.some(l => /recording of call #7/.test(l)));
});

// ---------- the floor under all of it ----------

test("a message that was nothing but markers still sends something rather than an empty text", async () => {
  const { fake, send } = harness();
  await send("```\n```");
  assert.equal(fake.sent.length, 1, "one message, not zero");
  assert.ok(fake.sent[0].text.length > 0, "and not an empty one");
});
