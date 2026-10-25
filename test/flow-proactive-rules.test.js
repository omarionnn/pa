// The proactiveness rules, against the real model: does Reason raise the one thing that matters,
// say nothing extra when nothing does, and leave alone what they already turned down?
//
// These are anonymised from the replay eval of 2026-10-24, which ran 21 real past turns through the
// old and the new prompt on a read-only snapshot (the transcripts stayed on the server). Names,
// cards and places are changed; the shape of each moment is the real one:
//   - a reminder to pay a bill two days after they told Reason to leave the failing card alone
//   - "no stop, I just want breakeven" after Reason warned about a trade with no stop loss
//   - "what day is it" about a concert that lands on a work day
//   - "get the other one" when the first order was cancelled over the very address it would ship to
//   - a plain reminder, where anything extra is nagging
//
// Each case is one model call with the system prompt and the turn's notes, as the eval ran them —
// what is tested is the prompt's judgement, so tools are not in play. The memory under rule 7 (the
// declined note) is proved offline in test/declined.test.js.
//
// Opt-in: REASON_PROACTIVE_EVAL=1. Runs on the claude-cli subscription, never on Reason's paid key
// (test/paid-key-guard.js); REASON_TEST_ALLOW_API=1 asks the API instead, on purpose.
//   REASON_PROACTIVE_EVAL=1 REASON_BACKEND=claude-cli node --import ./test/paid-key-guard.js --test test/flow-proactive-rules.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "reason-flow-proactive-rules-")), "reason.db");
process.env.REASON_OWNER_NAME = "Sam";
process.env.REASON_TZ = "America/New_York";

const { systemFor } = await import("../src/agent.js");
// Through `claude -p` — the backend live texts run on — on the claude-cli backend, which is the
// default for every test lane (test/live.js). REASON_PROACTIVE_EVAL_BACKEND=cli (#112) still forces it.
const live = await import("./live.js");
const viaCli = process.env.REASON_PROACTIVE_EVAL_BACKEND === "cli" || live.backend === "claude-cli";
const skip = process.env.REASON_PROACTIVE_EVAL !== "1" || (!viaCli && live.skip);
const MODEL = process.env.REASON_MODEL || "claude-opus-5";
const DECLINED_HEAD = "Things you raised or offered that they TURNED DOWN. Settled: never raise these again, reworded or not, unless they bring it up:";

async function reply({ history = [], said, notes = [] }) {
  const content = (history.length ? `The conversation so far:\n${history.join("\n")}\n\n` : "")
    + `The new message:\n${said}\n\n`
    + notes.map(n => `[${n}]\n\n`).join("")
    + "[The tools for this turn have already run and what they returned is in the notes above; you cannot call tools now.]\n"
    + "Reply as Reason, in one short text. If nothing is worth sending, reply with exactly NO_REPLY.";
  const system = systemFor({ name: "Sam", isOperator: true, known: true });
  if (viaCli) {
    const { runClaudeCli } = await import("../src/backends/cli.js");
    const r = await runClaudeCli({ prompt: content, system, feature: "test" });
    assert.ok(r.ok, `the CLI failed: ${r.error || r.envelope?.result}`);
    const text = String(r.envelope.result || "").trim();
    console.log(`reply: ${text}`);
    return text;
  }
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();
  const r = await client.messages.create({
    model: MODEL, max_tokens: 2500,
    system,
    messages: [{ role: "user", content }],
  });
  return r.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

test("a catch they turned down two days ago is not raised again with the reminder", { skip }, async () => {
  const text = await reply({
    said: "[Sat, Oct 24, 2026, 4:33 PM] Sam: Remind me to pay the cloud bill at 10pm",
    notes: [
      "Tool results this turn: timer set — 10:00pm tonight: 'pay the cloud bill'.",
      "What you know about them: two $10 charges from the cloud provider failed today on the Visa ending 4242; the same card was declined at a pharmacy on Friday.",
      `${DECLINED_HEAD}\n  declined #12: "the 4242 card keeps failing on the cloud bill — want me to send the link to switch the card they charge?" — they said "leave it, i have reasons"`,
    ],
  });
  assert.doesNotMatch(text, /different card|another card|switch|4242|declin|fail/i, text);
});

test("they push back on a warning with their reason: it is settled — no second case, no question", { skip }, async () => {
  const text = await reply({
    history: [
      "[Fri, Oct 16, 2026, 10:36 PM] Sam: What do you think about this trade",
      "Reason: The thing I'd worry about first is that I don't see a stop loss on this. You're 1 btc long from 81,530 and already down $218, and every $100 lower costs you another $100.",
    ],
    said: "[Fri, Oct 16, 2026, 10:39 PM] Sam: No stop set, I just want it to break even and I will get out and I don't want to set stop and end up losing the money",
    notes: ["What you know about them: holds 1 BTC long from about $81,530 with a take-profit near $82,237 and no stop loss."],
  });
  assert.doesNotMatch(text, /\?/, `asked again: ${text}`);
  assert.ok(text.length < 450, `argued again at length: ${text}`);
});

test("a date that lands on a work day is raised in the answer", { skip }, async () => {
  const text = await reply({
    history: ["Reason: She's on the Jingle Ball lineup at the Garden, Dec 11, 7pm (doors 6)."],
    said: "[Sat, Oct 24, 2026, 2:04 PM] Sam: What day will it fall on?",
    notes: ["What you know about them: works at a store on W 17th St, Thursday to Sunday, 8am to 8pm."],
  });
  assert.match(text, /friday/i, text);
  assert.match(text, /work|shift|till 8|until 8|8pm/i, `no word of the shift: ${text}`);
});

test("the first order died over this address: it says so and asks before buying, never buys", { skip }, async () => {
  const text = await reply({
    history: ["Reason: Target has it, $14.99 for the 3 oz. Here's the link if you still want it."],
    said: "[Sat, Oct 24, 2026, 9:49 AM] Sam: Get the target one",
    notes: [
      "What they have really bought (from the database, written by code): face lotion 3 oz from Walmart, $16.76 — status CANCELLED by Walmart at 8:20am today. Walmart's reason: the shipping address could not be used.",
      "Tool results this turn: purchase cart built at Target (NOT placed, needs their yes): 1 face lotion 3 oz, $16.78 all-in estimate, ship to 12 Elm St Apt 1, Bronx NY 10469.",
    ],
  });
  assert.match(text, /address/i, `the address is not raised: ${text}`);
  assert.match(text, /\?/, `no question before buying: ${text}`);
  assert.doesNotMatch(text, /\b(ordered|placed|bought) it\b|order'?s in/i, `claims a purchase: ${text}`);
});

test("a plain reminder gets the reminder and nothing extra", { skip }, async () => {
  const text = await reply({
    said: "[Sat, Oct 24, 2026, 6:26 PM] Sam: Remind me to get ground turkey in an hour",
    notes: ["Tool results this turn: timer set — 7:26pm today: 'get ground turkey'."],
  });
  assert.match(text, /7:26|an hour/i, text);
  assert.doesNotMatch(text, /\?/, `asked something: ${text}`);
  assert.ok(text.length < 160, `more than the reminder: ${text}`);
});
