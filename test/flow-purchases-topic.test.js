// The purchase block's meaning gate (src/purchasesnote.js) asking the REAL small model whether a
// message is about buying. Nothing here asserts wording — only yes or no, and the time each ask took
// against the hard budget. Runs on the claude-cli subscription (askTopicCli, the same instructions
// the API ask uses) — never on Reason's paid key unless REASON_TEST_ALLOW_API=1, when it asks the API
// path itself (test/paid-key-guard.js). Skipped with neither, so the offline suite skips it.
//
// The four that must come back yes are the incident (2026-10-24) and the follow-ups that only make
// sense next to an order; the off-topic ones must come back no even though purchases are on record.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-purchases-topic-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TZ = "America/New_York";

const { askTopicApi, askTopicCli, previousAssistant } = await import("../src/purchasesnote.js");
const { config } = await import("../src/config.js");
const { skip, backend } = await import("./live.js");
const askTopic = backend === "claude-cli" ? askTopicCli : askTopicApi;
after(() => rmSync(dir, { recursive: true, force: true }));

const ORDERED = "done, the cerave's ordered from walmart. $16.76";
const YES = [
  { text: "can you check to see if target has it and if they ship to my address", previous: ORDERED },
  { text: "any updates on the order?", previous: "" },
  { text: "any update?", previous: ORDERED },
  { text: "can i send it back if it doesn't work for my skin", previous: ORDERED },
];
const NO = [
  { text: "what's the weather", previous: ORDERED },
  { text: "remind me to call my mom at 6", previous: ORDERED },
  { text: "lol that's hilarious", previous: "haha you'd love that show" },
];

const times = [];
async function ask({ text, previous }) {
  const t0 = Date.now();
  const r = await askTopic({ text, previous: previousAssistant([{ role: "assistant", content: previous }]) });
  const ms = Date.now() - t0;
  times.push(ms);
  console.log(JSON.stringify({ text, about: r.about, ms, via: backend, model: backend === "claude-cli" ? config.midTurnCliModel : config.purchaseTopicModel, usage: r.usage }));
  return r;
}

for (const c of YES) test(`about buying: ${JSON.stringify(c.text)}`, { skip }, async () => {
  assert.equal((await ask(c)).about, true);
});
for (const c of NO) test(`not about buying: ${JSON.stringify(c.text)}`, { skip }, async () => {
  assert.equal((await ask(c)).about, false);
});

test("latency against the hard budget", { skip }, () => {
  const sorted = [...times].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)], max = sorted.at(-1);
  console.log(JSON.stringify({ asks: times.length, p50_ms: p50, max_ms: max, budget_ms: backend === "claude-cli" ? config.purchaseTopicCliTimeoutMs : config.purchaseTopicTimeoutMs }));
  assert.equal(times.length, YES.length + NO.length);
});
