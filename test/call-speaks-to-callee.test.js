// Call 74 (2026-11-06, to Yaw): the goal was Reason's note from Omari's side — "Ask Yaw whether he has
// heard how badly Manchester United are doing lately" — and the voice said it down the line as it
// stood, to Yaw: "Has Yaw heard how badly Manchester United are doing lately?". The fix is in the
// framing both third-party voices get (src/calls/voice-prompt.js speakToThem): the person who answers is
// the one the errand is about, the goal is not words to read out, and they are "you". These read the
// prompts that are built; whether a model then follows them is what the live drive shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-callee-you-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";

const vp = await import("../src/calls/voice-prompt.js");
const gl = await import("../src/calls/gptlive.js");
const { buildBrief, askWhetherItWentThrough } = await import("../src/calls/brief.js");

// Call 74's own brief, as it was rung: a redial of a dropped call carrying the new message after it.
const YAW_GOAL = "Ask Yaw whether he has heard how badly Manchester United are doing lately, tell him Omari says he will call him tonight, and ask whether tonight works for him.";
const yawBrief = () => askWhetherItWentThrough(
  buildBrief({ goal: "Tell Yaw that Omari needs him to text his Reason assistant and ask it to call him." }),
  { then: buildBrief({ goal: YAW_GOAL, facts: ["Omari says he will call Yaw tonight."] }) },
);

/** The paragraph that frames who is being spoken to, out of a whole prompt. */
const framing = (prompt) => prompt.split("\n").find(l => l.startsWith("Who you are talking to:")) ?? "";

function assertSecondPerson(prompt, owner) {
  const line = framing(prompt);
  assert.ok(line, "the prompt says who the voice is talking to");
  assert.match(line, /speaking TO them/, "the person who answers is spoken to, not about");
  assert.match(line, /"you" and "your"/, "they are addressed as you");
  assert.match(line, new RegExp(`on ${owner}'s behalf`), "and it is on the owner's behalf");
  assert.match(line, /not words to\s+read out/, "the goal is an errand, not a script");
  // The exact failure is named as the thing not to say, so a model reading it knows the shape.
  assert.match(line, /not "has Yaw heard…\?"/);
}

test("GPT-Live talking for itself (line talk): a call to Yaw is framed so Yaw is 'you'", () => {
  const b = yawBrief();
  const p = gl.lineTalkInstructions({ name: "Omari Nyarko", named: true, brief: b, goal: b.goal, facts: b.facts, notice: true });
  assertSecondPerson(p, "Omari");
  // The goal still rides as the errand — the voice needs to know it — and the framing sits right after it.
  const lines = p.split("\n");
  const at = lines.findIndex(l => l.startsWith("What the call is for:"));
  assert.ok(at >= 0 && lines[at].includes("Ask Yaw whether he has heard"));
  assert.ok(lines[at + 1].startsWith("Who you are talking to:"), "the framing reads straight after the goal");
});

test("Reason's own third-party call turn (thirdPartyFrame) carries the same framing", () => {
  const b = yawBrief();
  const p = vp.thirdPartyFrame({ ownerName: "Omari", goal: b.goal, facts: b.facts, rules: ["r"], announcement: "", openingOwed: false });
  const parts = p.split("\n\n");
  const at = parts.findIndex(x => x.startsWith("What this call is for:"));
  assert.ok(at >= 0);
  assert.ok(parts[at + 1].startsWith("Who you are talking to:"));
  assertSecondPerson(parts[at + 1], "Omari");
});

test("a business call gets it too, in the owner's name, and nothing about the owner leaks into it", () => {
  const b = buildBrief({ goal: "Ask Joe's Pizza what time they close tonight." });
  const p = gl.lineTalkInstructions({ name: "Ama Mensah", named: true, brief: b, goal: b.goal });
  const line = framing(p);
  assert.match(line, /on Ama's behalf/);
  assert.match(line, /"Ama will call you\s+tonight", not "Ama will call him"/);
  assert.doesNotMatch(line, /Omari/, "the framing is built from this call's owner, never another person's name");
});

test("a call to the owner's own phone is not framed as a call about somebody else", () => {
  const p = vp.ownerCallFrame({ name: "Omari" });
  assert.equal(framing(p), "");
});
