// The use-case index in the README is generated from docs/usecases.json. These tests are what stops
// the two drifting apart, and what stops an index line pointing at a section that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render, splice, slug, sortKey, START, END } from "../scripts/usecases.mjs";

const data = JSON.parse(readFileSync(new URL("../docs/usecases.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("the README matches docs/usecases.json", () => {
  assert.equal(
    readme,
    splice(readme, render(data)),
    "README.md has drifted from docs/usecases.json — run `node scripts/usecases.mjs`",
  );
});

test("every use case has a name, a hook, a status and a date from the record", () => {
  const statuses = new Set(data.sections.map((s) => s.status));
  for (const u of data.usecases) {
    assert.ok(u.name, "a use case with no name");
    assert.ok(u.detail, `${u.name} has no detail`);
    assert.ok(statuses.has(u.status), `${u.name} has an unknown status: ${u.status}`);
    // A guess is worse than an admitted unknown, so the only two shapes are a date and "before".
    assert.match(u.landed, /^(before )?\d{4}-\d{2}-\d{2}$/, `${u.name} has a made-up date`);
    const words = u.hook.split(/\s+/).length;
    assert.ok(words >= 6 && words <= 14, `${u.name}'s hook is ${words} words, not a one-liner`);
  }
});

test("every section an index line links to is a real heading in this README", () => {
  const headings = readme
    .split("\n")
    .filter((l) => l.startsWith("## ") || l.startsWith("### "))
    .map((l) => slug(l.replace(/^#+ /, "")));
  for (const u of data.usecases) {
    if (!u.section) continue;
    assert.ok(headings.includes(slug(u.section)), `${u.name} points at a missing section: ${u.section}`);
  }
});

test("each bucket is newest first, and nothing lost its limits", () => {
  // Wrapped at 100 columns, so a phrase check has to ignore where the lines happen to break.
  const body = readme.slice(readme.indexOf(START), readme.indexOf(END)).replace(/\s+/g, " ");
  for (const section of data.sections) {
    const rendered = render({ sections: [section], usecases: data.usecases });
    const order = [...rendered.matchAll(/· landed ((?:before )?\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    assert.ok(order.length, `${section.heading} has no use cases`);
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        sortKey(order[i - 1]) >= sortKey(order[i]),
        `${section.heading} is out of order: ${order[i - 1]} before ${order[i]}`,
      );
    }
  }
  // The honest sentences are the point of the buckets; a reflow must not swallow one.
  for (const phrase of [
    "**Reddit is never fetched**",
    "has never been sent to Tavily",
    "no phone has ever rung",
    "nothing has ever been sent to Google",
    "not one of those flows has been walked",
    "No key has ever sent a real text.",
  ]) {
    assert.ok(body.includes(phrase), `the README no longer says: ${phrase}`);
  }
});
