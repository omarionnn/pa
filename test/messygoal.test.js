// "Give me a messy goal rather than a perfect prompt."
//
// Omari's line, 2026-10-07. It is three things at once and all three have to be true together, or it
// is worse than not saying it at all:
//
//   1. **A new person is told.** The cost of not saying it is paid immediately and invisibly:
//      somebody who thinks they are texting a prompt box writes a careful paragraph, gets a careful
//      answer, and never learns they could have said "sort my drive out". So it rides on the one
//      message every new person is guaranteed to read — the hello.
//   2. **"What can you do" says it.** A feature list with no line about how to hand work over is
//      what teaches people to write briefs. It is in the result the model is holding when it writes
//      that answer, not left to be remembered.
//   3. **The model actually behaves that way.** A promise about how Reason works that only lives in
//      a welcome text is a promise the next turn breaks. So it is a rule in the system prompt, which
//      both backends build their turn from — asserted against the source for the one Reason really
//      runs on, the way test/whatsnew.test.js does.
//
// No model, no network: what is under test is the wording that leaves this machine and the rule that
// goes in front of whichever model is there. test/flow-driveorg.test.js is where a real model is
// watched doing it on a half-formed Drive ask.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-messy-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const access = await import("../src/access.js");
const { runTool } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const KOFI = "+14155559876";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

/** What the idea has to carry, however it is worded: the messy half, and who the questions are for. */
const MESSY = /messy/i;
const THEIRS = /actually yours|genuinely theirs|really theirs/i;

// ---------- the first message a person ever gets ----------

/** The real path: a stranger's number is written down, then put in front of the master. */
function putInFrontOfTheMaster({ source = "text", address = KOFI, name = "Kofi" } = {}) {
  const request = db.createAccessRequest({
    channel: "fake", address, displayName: name,
    firstMessage: source === "web" ? "" : "yo is this omari's thing", source,
  });
  const asked = access.askMaster({ request, masterConversationId: config.ownerConversation, messages: [] });
  assert.equal(asked.asked, true, JSON.stringify(asked));
  return request;
}

test("the line a brand-new person gets tells them a messy ask is enough", async () => {
  putInFrontOfTheMaster();

  const out = await access.readMasterReply({
    messages: [{ role: "user", content: "[Wed, Oct 7 2026, 3:00 PM] Omari: yeah let him in" }],
    masterConversationId: config.ownerConversation,
    judge: async () => ({ verdict: "yes" }),
  });

  assert.equal(out.granted, true, JSON.stringify(out));
  assert.ok(out.toThem, "nobody was texted, so there was no opening line at all");
  assert.match(out.toThem, MESSY, `the opening line does not say a messy ask is fine: ${out.toThem}`);
  assert.match(out.toThem, THEIRS, `it does not say what it will come back to them about: ${out.toThem}`);
  // It is still a hello. A tip that replaces the welcome is a worse welcome.
  assert.match(out.toThem, /you're in|said yes/i, `it stopped being a hello: ${out.toThem}`);
});

test("the same idea reaches somebody who came in from the website", async () => {
  putInFrontOfTheMaster({ source: "web", name: "" });

  const out = await access.readMasterReply({
    messages: [{ role: "user", content: "[Wed, Oct 7 2026, 3:00 PM] Omari: go on then" }],
    masterConversationId: config.ownerConversation,
    judge: async () => ({ verdict: "yes" }),
  });

  assert.equal(out.granted, true, JSON.stringify(out));
  assert.match(out.toThem, MESSY, `the website welcome is missing it: ${out.toThem}`);
  assert.match(out.toThem, /website/i, "it stopped saying where they came from");
});

test("it is one sentence, in Reason's voice, and not a wall", () => {
  const line = access.MESSY_GOAL_LINE;
  assert.ok(line.length < 220, `too long for a welcome text (${line.length} chars)`);
  assert.doesNotMatch(line, /[*#|`]/, "no markdown reaches a phone");
  assert.doesNotMatch(line, /prompt/i, "Reason does not talk about prompts; that is a word about the tool, not the person");
});

// ---------- "what can you do" ----------

test("the capabilities answer carries how to hand work over, not only what exists", async () => {
  const out = await runTool("capabilities", {}, { conversationId: config.ownerConversation, messages: [] });

  assert.ok(out.how_to_ask, "the capabilities result says nothing about how to ask");
  assert.match(out.how_to_ask, MESSY, `it does not say a messy goal is enough: ${out.how_to_ask}`);
  assert.match(out.how_to_ask, /ONE short question|one short question/, "it does not say to bundle the real decisions into one question");
  // The failure this is really against: a model that reads the list and asks four questions back.
  assert.match(out.how_to_ask, /[Nn]ever a list of questions/, "it does not forbid the list of questions");
  assert.match(out.note, /how_to_ask/, "the note does not tell the model that field belongs in the answer");
});

// ---------- and the model is told to behave that way ----------

test("the system prompt makes it a rule, not a promise in a welcome text", () => {
  const prompt = systemFor({ name: "Omari", isOperator: true });
  assert.match(prompt, /messy goal/i, "the rule is not in the prompt, so only the welcome text believes it");
  assert.match(prompt, /one short question/i, "the prompt does not say to bundle the decisions into one question");
  assert.match(prompt, /word something better|word it better/i, "the prompt does not forbid handing a vague ask back");
});

test("the backend the live Reason runs on builds its turn from that prompt", () => {
  // Asserted against the source the way test/whatsnew.test.js does: the claude-cli backend writes
  // its own prompt and cannot be driven without the CLI, so this is what stands between "it works on
  // the API path" and the backend Omari's phone is actually talking to.
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /systemFor\(/, `${file} must build its turn from systemFor`);
  }
});
