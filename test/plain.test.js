// What a message looks like by the time it reaches a phone: src/plain.js on its own.
//
// Two halves, and the second one is the one that matters more. Taking `**` off a word is easy; the
// hard part is NOT taking the underscore out of report_final_v2.txt, not reading `2 * 3` as
// italics, and not touching a single character of a prompt somebody is about to paste into another
// AI. So every rule here is tested twice — once on text that is markdown, once on text that only
// looks like it.
//
// No model, no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";

const { plainText, outgoingParts, outgoingTexts, capped, TEXT, COPY, LINK } = await import("../src/plain.js");

const kinds = (s, opts) => outgoingParts(s, opts).parts.map(p => p.kind);
const texts = (s, opts) => outgoingParts(s, opts).parts.map(p => p.text);

// ---------- markers off ----------

test("the markers a text thread cannot draw come off", () => {
  for (const [wrote, reads] of [
    ["**grind finer** then bloom", "grind finer then bloom"],
    ["__thirty seconds__ of bloom", "thirty seconds of bloom"],
    ["it was *really* good", "it was really good"],
    ["it was _really_ good", "it was really good"],
    ["***both of them***", "both of them"],
    ["## Grind\nmedium-fine", "Grind\nmedium-fine"],
    ["###### deep heading here", "deep heading here"],
    ["run `brew install sonos` first", "run brew install sonos first"],
    ["* one\n* two", "- one\n- two"],
    ["see [the shortlist](https://x.com/a)", "see the shortlist https://x.com/a"],
    ["see <https://x.com/a>", "see https://x.com/a"],
  ]) {
    assert.equal(plainText(wrote), reads, `wrote: ${wrote}`);
  }
});

test("a markdown table becomes something readable in one hand", () => {
  const table = "| phone | price | battery |\n|---|---|---|\n| Pixel 9a | $499 | 2 days |\n| iPhone 16e | $599 | 1.5 days |";
  assert.equal(
    plainText(table),
    "Pixel 9a\nprice: $499\nbattery: 2 days\n\niPhone 16e\nprice: $599\nbattery: 1.5 days",
  );
  // The words around it survive, and so does their spacing.
  const mixed = `i'd take the pixel\n\n${table}\n\nboth are fine though`;
  assert.match(plainText(mixed), /^i'd take the pixel\n\nPixel 9a\n/);
  assert.match(plainText(mixed), /both are fine though$/);
  assert.ok(!plainText(mixed).includes("|"), "no pipes left");
});

test("text that only looks like markdown is left exactly as it was", () => {
  for (const s of [
    "that's in report_final_v2.txt",
    "2 * 3 = 6, so 6 bags",
    "it's 3*4*5 cm",
    "a*b is not a*b",
    "snake_case_name and __dunder_ish",
    "it cost $5*2",
    "C# or F#, not #1 and not #teamwork",
    "nothing special here 🔥🫡",
    "price | quantity, in a sentence",
    "yeah 8 works, i'll sort it",
    "5 - 3 = 2",
    "the file is a_b_c.json",
    "https://en.wikipedia.org/wiki/Trip_hop is the one",
    "https://x.com/a_b_c?q=1_2",
  ]) {
    assert.equal(plainText(s), s, `changed: ${s}`);
  }
});

test("a lone fence, and three backticks written inline, leave nothing behind", () => {
  assert.equal(plainText("here you go\n```js\nconst a = 1"), "here you go\n\nconst a = 1");
  assert.ok(!plainText("he wrote ``` in the middle").includes("`"), "no backticks reach a phone");
});

test("an ordinary reply comes back byte for byte", () => {
  const reply = "lisbon's 5 hours ahead, so it's 2:37am tuesday there right now\n\nthe gap stays 5 hours all year";
  assert.equal(plainText(reply), reply);
  assert.deepEqual(texts(reply), [reply], "and it is one bubble");
});

// ---------- room between the steps ----------

test("numbered steps get a line of space between them", () => {
  // The jollof recipe Omari read on his phone on 2026-10-05: eight steps run together read as one
  // paragraph with digits in it.
  const wrote = "here's the order:\n1. unplug the power cable\n2. press and hold play/pause\n3. plug it back in";
  assert.equal(
    plainText(wrote),
    "here's the order:\n\n1. unplug the power cable\n\n2. press and hold play/pause\n\n3. plug it back in",
  );
});

test("a step that wraps keeps its own continuation lines, and the space goes before the next number", () => {
  const wrote = "1. blend the peppers\n   until completely smooth\n2. rinse the rice";
  assert.equal(plainText(wrote), "1. blend the peppers\n   until completely smooth\n\n2. rinse the rice");
});

test("a list already written with space is left exactly as it was", () => {
  const spaced = "1. one\n\n2. two\n\n3. three";
  assert.equal(plainText(spaced), spaced, "no second blank line gets added");
});

test("the space goes between steps and never before the first one", () => {
  // The lead-in belongs with the list it introduces, so nothing is inserted inside "the steps:".
  assert.equal(plainText("the steps:\n1. go"), "the steps:\n\n1. go");
  assert.equal(plainText("do this:\n1. a\n2. b"), "do this:\n\n1. a\n\n2. b");
});

test("prose after a list ends it, and prose that counts is not a list at all", () => {
  assert.equal(plainText("1. a\n2. b\nthat's it, enjoy"), "1. a\n\n2. b\nthat's it, enjoy");
  // Years and prices start lines in ordinary sentences; three digits or more is never a step.
  for (const s of ["i paid 1999. then i left", "2026. what a year"]) {
    assert.equal(plainText(s), s, `left alone: ${s}`);
  }
});

test("bullets are deliberately left tight", () => {
  // A three-item bullet list reads fine as it is; spacing it out makes a short answer look long.
  const bullets = "- eggs\n- milk\n- bread";
  assert.equal(plainText(bullets), bullets);
});

test("steps inside something to paste are never respaced", () => {
  // Somebody pasting a numbered prompt into another AI gets back exactly what Reason wrote.
  const inner = "1. read the brief\n2. write the draft\n3. check the tone";
  const parts = outgoingParts(`try this:\n\n\`\`\`\n${inner}\n\`\`\``).parts;
  assert.deepEqual(parts.map(p => p.kind), [TEXT, COPY]);
  assert.equal(parts[1].text, inner, "byte for byte, no blank lines inserted");
});

// ---------- the bubbles ----------

test("a fenced block leaves as its own bubble, whole, with the words either side as their own", () => {
  const prompt = "I'm planning a 3-day trip to Lisbon.\n  Keep the indentation.\nWe like **food**.";
  const wrote = `here you go, just fill in the brackets:\n\n\`\`\`\n${prompt}\n\`\`\`\n\npaste that into chatgpt`;
  const parts = outgoingParts(wrote).parts;
  assert.deepEqual(parts.map(p => p.kind), [TEXT, COPY, TEXT]);
  assert.equal(parts[0].text, "here you go, just fill in the brackets:");
  assert.equal(parts[1].text, prompt, "exactly the inner text: no fences, nothing stripped, indentation kept");
  assert.equal(parts[2].text, "paste that into chatgpt");
});

test("the info string after the opening fence is fence, not content", () => {
  const parts = outgoingParts("here:\n```python\nprint('hi')\n```").parts;
  assert.deepEqual(parts.map(p => p.kind), [TEXT, COPY]);
  assert.equal(parts[1].text, "print('hi')");
});

test("a fence that is empty, or one that never closes, does not split a sentence in two", () => {
  assert.deepEqual(texts("hey\n```\n\n```\nthere"), ["hey\n\nthere"]);
  assert.deepEqual(kinds("hey\n```js\nconst a = 1"), [TEXT]);
  // Nothing is guessed at: an unclosed fence is prose, because taking everything after it as
  // paste-able would put Reason's own words inside what somebody copies.
  assert.deepEqual(texts("hey\n```js\nconst a = 1"), ["hey\n\nconst a = 1"]);
});

test("a link is still its own bubble, and the stripping does not break the address", () => {
  const parts = outgoingParts("made you a **page** with the shortlist [here](https://x.com/p) have a look").parts;
  assert.deepEqual(parts.map(p => p.kind), [LINK, TEXT]);
  assert.equal(parts[0].text, "https://x.com/p");
  assert.equal(parts[1].text, "made you a page with the shortlist here have a look");
});

// ---------- the cap ----------

test("over the cap, neighbours are joined — and the joined text is all of it", () => {
  const { parts, over } = capped([
    { kind: TEXT, text: "one" }, { kind: TEXT, text: "two" }, { kind: TEXT, text: "three" }, { kind: TEXT, text: "four" }, { kind: TEXT, text: "five" },
  ], 2);
  assert.equal(parts.length, 2);
  assert.equal(over, false);
  assert.equal(`${parts[0].text}\n\n${parts[1].text}`.replace(/\n+/g, " "), "one two three four five");
});

test("the cap never buries a link and never opens a block somebody is about to paste", () => {
  const wrote = "a\n\n```\nONE\n```\n\nb\n\n```\nTWO\n```\n\nc\n\n```\nTHREE\n```\n\nd";
  const { parts, over } = outgoingParts(wrote);
  assert.equal(over, true, "it says out loud that the cap did not hold");
  assert.deepEqual(parts.map(p => p.kind), [TEXT, COPY, TEXT, COPY, TEXT, COPY, TEXT]);
  // The point: it yields rather than losing or mangling anything.
  assert.deepEqual(parts.filter(p => p.kind === COPY).map(p => p.text), ["ONE", "TWO", "THREE"]);
});

test("nothing is ever lost, whatever the cap is set to", () => {
  const wrote = "first line\n\n**second** idea\n\n```\nPASTE ME\n```\n\nthird idea https://x.com/p fourth idea";
  const everything = (n) => outgoingTexts(wrote, { maxBubbles: n }).join("\n").replace(/\s+/g, " ").trim();
  const full = everything(99);
  for (const n of [0, 1, 2, 3, 4, 5, 10]) {
    const got = everything(n);
    for (const piece of ["first line", "second idea", "PASTE ME", "third idea", "fourth idea", "https://x.com/p"]) {
      assert.ok(got.includes(piece), `cap ${n} lost "${piece}"`);
    }
    assert.equal(got.length, full.length, `cap ${n} changed how much text there is`);
  }
});

test("asked not to touch markdown, the bubbles are still split but the markers stay", () => {
  const parts = outgoingParts("look at **this** https://x.com/p", { plain: false }).parts;
  assert.deepEqual(parts.map(p => p.kind), [LINK, TEXT]);
  assert.equal(parts[1].text, "look at **this**");
});

test("an empty message is no bubbles rather than one empty one", () => {
  assert.deepEqual(texts(""), []);
  assert.deepEqual(texts("   \n\n  "), []);
  assert.deepEqual(texts(null), []);
});
