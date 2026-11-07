// A tool description goes to the model on every turn for every person. An example in it must
// never carry a real person's name (the maker's or anyone's): the model copies examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

test("task_finish result example names nobody", () => {
  const t = tools.find(x => x.name === "task_finish");
  const d = t.input_schema.properties.result.description;
  assert.doesNotMatch(d, /\bUNDER (?!THEIR NAME|YOUR NAME)[A-Z]+/, "the party-name example uses no person's name");
  assert.doesNotMatch(d, /kofi|omari/i);
});
