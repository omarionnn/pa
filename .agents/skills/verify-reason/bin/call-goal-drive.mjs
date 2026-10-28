#!/usr/bin/env node
// Drive the call goal read (src/calls/goalmet.js judgeGoal) on the REAL claude-cli, over real call
// rows (a JSON array of {id, goal, transcript, is_owner, direction, outcome_kind} — e.g. a read-only
// `sqlite3 -json` of the live calls table) plus two built-in cases. Prints one line per call: the
// verdict and the model's why. Sends nothing, places nothing, writes nothing.
//   REASON_BACKEND=claude-cli node .agents/skills/verify-reason/bin/call-goal-drive.mjs [calls.json]
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "goal-drive-")), "reason.db");
process.env.REASON_BACKEND = "claude-cli";
delete process.env.NODE_TEST_CONTEXT;
const { judgeGoal, judgeable } = await import("../../../../src/calls/goalmet.js");

const rows = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : [];
rows.push(
  { id: "built-in: wrong number", goal: "Reach Jeffrey and ask him to call Omari back.", is_owner: 0, direction: "out", outcome_kind: "dropped_before_confirmation",
    transcript: "Reason: Hi, this is an AI assistant calling for Omari. Is Jeffrey there?\nThem: No Jeffrey here, wrong number.\nReason: Sorry about that, bye." },
  { id: "built-in: answered", goal: "Ask Joe's Pizza on Carmine St what time they close tonight.", is_owner: 0, direction: "out", outcome_kind: "dropped_before_confirmation",
    transcript: "Reason: Hi, this is an AI assistant calling for Omari. What time do you close tonight?\nThem: We close at 11 tonight.\nReason: Great, thank you!" },
  { id: "built-in: booking, no read-back", goal: "Book a table for two at 8pm Friday under Omari.", is_owner: 0, direction: "out", outcome_kind: "dropped_before_confirmation",
    transcript: "Reason: Hi, I'd like to book a table for two at 8 on Friday for Omari.\nThem: Sure, let me check—\nReason: Hello?" },
);
let bad = 0;
for (const r of rows) {
  const asked = judgeable({ ...r, outcome_kind: "dropped_before_confirmation" });
  const t0 = Date.now();
  const v = asked ? await judgeGoal(r) : null;
  console.log(JSON.stringify({ call: r.id, stored: r.outcome_kind, asked, met: v?.met ?? null, why: v?.why ?? "", ms: Date.now() - t0 }));
  if (asked && !v) bad++;
}
process.exit(bad ? 1 : 0);
