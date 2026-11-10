// Context first, then ask (src/contextfirst.js, REASON_CONTEXT_FIRST): the prompt block that tells
// Reason to find an answer itself before asking, and to ask with the likely answer inside. Offline:
// what is asserted is the system prompt text the model would read, and where the flag reaches.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-contextfirst-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";

const cf = await import("../src/contextfirst.js");
const { systemFor } = await import("../src/agent.js");
const { tools } = await import("../src/tools.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { delete process.env.REASON_CONTEXT_FIRST; });

const OWNER = { name: "Omari", isOperator: true };
const OTHER = { name: "Sam", isOperator: false };
const MARK = /Context first, then ask/;

test("the flag: off by default, owner means the operator's thread only, on means everyone", () => {
  assert.equal(cf.contextFirstMode(), "off");
  assert.equal(cf.contextFirstOn({ isOperator: true }), false);
  process.env.REASON_CONTEXT_FIRST = "owner";
  assert.equal(cf.contextFirstOn({ isOperator: true }), true);
  assert.equal(cf.contextFirstOn({ isOperator: false }), false);
  process.env.REASON_CONTEXT_FIRST = "on";
  assert.equal(cf.contextFirstOn({ isOperator: false }), true);
  process.env.REASON_CONTEXT_FIRST = "banana";
  assert.equal(cf.contextFirstOn({ isOperator: true }), false);
  process.env.REASON_CONTEXT_FIRST = " ON ";
  assert.equal(cf.contextFirstMode(), "on");
});

test("flag off: the rules are an empty string and nothing of them is in the prompt", () => {
  assert.equal(cf.contextFirstRules(OWNER), "");
  assert.equal(cf.contextFirstRules(OTHER), "");
  assert.equal(cf.contextFirstRules("Omari"), "");
  const p = systemFor(OWNER);
  assert.doesNotMatch(p, MARK);
  assert.doesNotMatch(p, /numbered menu/);
  assert.doesNotMatch(p, /your usual/);
});

test("owner: present for the owner's thread, absent for everybody else and on a call", () => {
  process.env.REASON_CONTEXT_FIRST = "owner";
  assert.match(systemFor(OWNER), MARK);
  assert.doesNotMatch(systemFor(OTHER), MARK, "somebody else's thread is untouched");
  assert.doesNotMatch(systemFor({ ...OWNER, onCall: true }), MARK, "a phone call gets none of it");
  assert.equal(cf.contextFirstRules("Omari"), "", "a bare name is not the operator");
});

test("on: everyone's text prompt carries it", () => {
  process.env.REASON_CONTEXT_FIRST = "on";
  assert.match(systemFor(OWNER), MARK);
  assert.match(systemFor(OTHER), MARK);
  assert.doesNotMatch(systemFor({ ...OTHER, onCall: true }), MARK);
});

test("the rules carry every part of the spec, in the prompt's own voice", () => {
  process.env.REASON_CONTEXT_FIRST = "on";
  const r = cf.contextFirstRules(OWNER);
  // Self-serve order and the concrete examples.
  assert.match(r, /what they said in this chat; what you remember about them .*; their connected email and calendar .*; then the web/);
  assert.match(r, /last 3 food receipts/);
  assert.match(r, /last 2 orders/);
  assert.match(r, /welcome or receipt emails/);
  assert.match(r, /Where a business is: search it/);
  // Ask with the answer inside.
  assert.match(r, /combo over rice from habibi again, or something new\?/);
  assert.match(r, /home on bruner ave\?/);
  assert.match(r, /live progress or the sign-in prompt first\?/);
  assert.match(r, /Two or three choices at most/);
  assert.match(r, /never a numbered menu/);
  assert.match(r, /One question per text/);
  assert.match(r, /never more than two questions in a row/);
  // Use it quietly.
  assert.match(r, /"your usual", never "your nov 3 uber eats receipt says"/);
  assert.match(r, /Never say where you learned it/);
  assert.match(r, /at most one thing you found per reply/);
  // Confirm what is inferred.
  assert.match(r, /still at bruner ave\?/);
  assert.match(r, /Recent beats old/);
  assert.match(r, /two sources disagree, ask, naming both/);
  assert.match(r, /Never act on an inference for money, a message sent as them, or anything permanent without a yes/);
  // Remember what you learn, and tone.
  assert.match(r, /home address, for food delivery/);
  assert.match(r, /a signal for next time, not a rule, unless they say never/);
  assert.match(r, /best concierge/);
  // It sits with the other flagged blocks: a "- " line block, no markdown, no numbered list of its own.
  assert.ok(r.startsWith("\n- "));
  assert.doesNotMatch(r, /\n\d+\. /);
  assert.doesNotMatch(r, /\*\*/);
});

test("every tool the rules name exists", () => {
  process.env.REASON_CONTEXT_FIRST = "on";
  const r = cf.contextFirstRules(OWNER);
  const named = ["memory_search", "gmail_search", "calendar_events", "web_search", "remember"];
  const have = new Set(tools.map(t => t.name));
  for (const n of named) {
    assert.match(r, new RegExp(`\\b${n}\\b`), `rules name ${n}`);
    assert.ok(have.has(n), `${n} is a real tool`);
  }
});
