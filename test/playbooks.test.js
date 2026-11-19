// The feature rules that left the system prompt (src/playbooks.js) still reach the model, and the
// prompt stays small. On the live CLI backend tools are deferred, so a rule on a tool costs nothing
// until that tool is loaded; the API backend sends every description every turn, so there each rule
// must appear exactly once or the move would have made the API path dearer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAYBOOKS } from "../src/playbooks.js";
import { tools } from "../src/tools.js";
import { MCP_TOOLS } from "../src/backends/mcp-core.js";
import { systemFor } from "../src/agent.js";

test("on the CLI, every tool in a group carries its group's rule", () => {
  for (const p of PLAYBOOKS) {
    for (const name of p.tools) {
      const t = MCP_TOOLS.find(x => x.name === name);
      assert.ok(t, `${name} is not served`);
      assert.ok(t.description.includes(p.text), `${name} is missing the ${p.name} rule`);
    }
  }
});

test("on the API, each rule is sent once, not once per tool", () => {
  const all = tools.map(t => t.description).join("\n");
  for (const p of PLAYBOOKS) {
    assert.equal(all.split(p.text).length - 1, 1, `${p.name} appears more than once on the API path`);
  }
});

test("no moved rule is still in the prompt, and the prompt stays under budget", () => {
  const prompt = systemFor({ name: "Omari", isOperator: true });
  for (const p of PLAYBOOKS) assert.ok(!prompt.includes(p.text), `${p.name} is in the prompt twice over`);
  // 113,802 chars before the first move, 83,530 after it, 69,912 after the second. Growing past this means a feature rule went back in the prompt. Raised to 72,300 for the one-line answer-the-word-they-wrote rule (a core rule, not a feature rule), then to 72,500 (the same ceiling test/declined.test.js holds) for the waiting_on_you wording in the two task rules, also core.
  assert.ok(prompt.length < 72_500, `the system prompt is ${prompt.length} chars`);
});
