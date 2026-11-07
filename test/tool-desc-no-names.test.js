// Tool descriptions and the standing prompt go to the model on every turn for every person. An
// example in them must never carry a person's name (the maker's or anyone's): the model copies
// examples, and a name in one lands on somebody else's card or text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";
import { systemFor } from "../src/agent.js";
import { ALERT_RULES } from "../src/alerts.js";

const NAMES = /\b(kofi|ama|omari|omarion|nyarko|yaw|esi|kwame|irene|omariij\d*)\b/i;

test("task_finish result example names nobody", () => {
  const d = tools.find(x => x.name === "task_finish").input_schema.properties.result.description;
  assert.match(d, /UNDER <THEIR NAME>/);
  assert.doesNotMatch(d, NAMES);
});

test("no tool description carries a person's name", () => {
  const hits = [];
  const walk = (v, path) => {
    if (typeof v === "string") { if (NAMES.test(v)) hits.push(`${path}: ${v.match(new RegExp(".{0,40}" + NAMES.source + ".{0,20}", "i"))[0]}`); }
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const t of tools) walk(t, t.name);
  assert.deepEqual(hits, []);
});

test("the standing prompt and alert rules name nobody", () => {
  assert.doesNotMatch(systemFor({ name: "Pat", isOperator: false }), NAMES);
  assert.doesNotMatch(ALERT_RULES, NAMES);
});

// Side prompts (daily greeting, fact extraction, chat naming, memory recall, the call voice) are
// built from string literals; any line of code (comments aside) naming a person is an example the
// model reads.
test("side prompts name nobody", async () => {
  const { readFileSync } = await import("node:fs");
  const hits = [];
  for (const f of ["daily.js", "extract.js", "webchats.js", "memory.js", "calls/voice-prompt.js", "agent.js", "alerts.js"]) {
    readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (NAMES.test(line.replace(/\/\/.*$/, ""))) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
