// The moment-aware rules, against the real model: does Reason shape the answer for where they will
// be when they act on it, reuse what they told it (and say so), and add nothing on a plain turn?
//
// Anonymised from the replay eval of 2026-10-25, which ran 20 real past turns through the old and
// the new prompt on a read-only snapshot (the transcripts stayed on the server). Names, addresses
// and times are changed; the shape of each moment is the real one:
//   - "get me a ride home" mid-afternoon on a shift day: the pickup is work, and it says so
//   - "remind me tomorrow at 6am" about a bill: the reminder lands right before they leave, and
//     the first draft of the rule pushed "your line might get cut off, pay now?" — the bug pinned
//   - a seminar reminder at 11pm: "an hour before", because that is what they asked for last time
//   - "my sister lives in Lisbon": the first draft added the time there — the nag pinned
//
// Each case is one model call with the system prompt and the turn's notes, as the eval ran them.
// Opt-in: REASON_PROACTIVE_EVAL=1. Always through `claude -p` (the subscription), never Reason's
// paid key (test/paid-key-guard.js takes the key out of the process as well).
//   REASON_PROACTIVE_EVAL=1 node --import ./test/paid-key-guard.js --test test/flow-moment-aware.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "reason-flow-moment-")), "reason.db");
process.env.REASON_OWNER_NAME = "Sam";
process.env.REASON_TZ = "America/New_York";

const { systemFor } = await import("../src/agent.js");
const { runClaudeCli } = await import("../src/backends/cli.js");
const skip = process.env.REASON_PROACTIVE_EVAL !== "1";
const KNOWN = "What you know about them (they told you): lives at 18 Elm St, Queens NY. Works at 220 W 30th St, Manhattan, Thursday to Sunday, 8am to 8pm; takes the train from home and wants to arrive by 7:50am.";

async function reply({ history = [], said, notes = [] }) {
  const content = (history.length ? `The conversation so far:\n${history.join("\n")}\n\n` : "")
    + `The new message:\n${said}\n\n`
    + notes.map(n => `[${n}]\n\n`).join("")
    + "[The tools for this turn have already run and what they returned is in the notes above; you cannot call tools now.]\n"
    + "Reply as Reason, in one short text. If nothing is worth sending, reply with exactly NO_REPLY.";
  const r = await runClaudeCli({ prompt: content, system: systemFor({ name: "Sam", isOperator: true, known: true }), feature: "test" });
  assert.ok(r.ok, `the CLI failed: ${r.error || r.envelope?.result}`);
  const text = String(r.envelope.result || "").trim();
  console.log(`reply: ${text}`);
  return text;
}

test("a ride home on a shift day picks up at work and says so", { skip }, async () => {
  const link = "https://m.uber.com/go/looking?pickup=220+W+30th+St+New+York+NY&drop=18+Elm+St+Queens+NY";
  const text = await reply({
    said: "[Fri, Oct 23, 2026, 2:41 PM] Sam: Get me a ride home",
    notes: [KNOWN, `Tool results this turn: Uber web booking link built — pickup 220 W 30th St, drop-off 18 Elm St; it opens Uber's booking page with the trip filled in: ${link} . No live location shared this turn.`],
  });
  assert.ok(text.includes(link), text);
  assert.match(text, /work|30th/i, text);
});

test("a reminder they timed for themselves is set, with no push to act now", { skip }, async () => {
  const text = await reply({
    history: ["Reason: the phone company says your autopay didn't go through this morning. they want a one-time payment and the email doesn't give an amount. want a reminder?"],
    said: "[Thu, Oct 22, 2026, 9:03 AM] Sam: Remind me tomorrow at 6am",
    notes: [KNOWN, "Tool results this turn: timer set — Fri Oct 23, 6:00am: 'phone bill: autopay failed, make the one-time payment'. The email gives no amount and no payment link."],
  });
  assert.match(text, /6/, text);
  assert.doesNotMatch(text, /cut off|shut off|suspend|pay (it )?now|right now|today instead/i, text);
});

test("what they asked for last time is reused and named", { skip }, async () => {
  const text = await reply({
    said: "[Mon, Oct 19, 2026, 11:00 PM] Sam: got a seminar tomorrow at 7pm, remind me of it tomorrow ok?",
    notes: ["What you know about them (they told you): last week, for their 4pm seminar, they wanted the reminder an hour before ('I think 1 hour should be good').",
      "Tool results this turn: none ran. Say the time you will set the reminder for; the timer is set to exactly what you say."],
  });
  assert.match(text, /\b6\s?(pm|:00|\b)/i, text);
  assert.match(text, /hour before|last time|like before|same as/i, text);
});

test("a plain fact about family gets no time-zone aside", { skip }, async () => {
  const text = await reply({
    said: "[Thu, Oct 15, 2026, 3:32 PM] Sam: My sister Ana works at a bank and lives in Lisbon",
    notes: [],
  });
  assert.doesNotMatch(text, /ahead|behind|time there|(am|pm) there|time zone|timezone/i, text);
});
