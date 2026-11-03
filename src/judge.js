// The gate's reader. When the owner answers a confirmation, something has to decide what their
// words mean. Word lists cannot: "no problem, book it" is a go-ahead, "ok but make it 9 instead"
// is not, and substring matching gets both backwards — the second one dangerously, by booking the
// 8:00 they just rejected. So meaning is read by the model, in one narrow call that sees nothing
// but the action Reason described and the owner's reply.
//
// Everything a model cannot be trusted to guarantee stays in code, in trust.js: that a real new
// message arrived after the ask, that one yes covers one action, that it is single use, that it
// expires, and that the owner's exact words go on the record.
import Anthropic from "@anthropic-ai/sdk";
import { tracked } from "./spend.js";
import { config } from "./config.js";
import { judgeViaCli } from "./backends/cli.js";
import { oneToolCall } from "./backends/side.js";

export const VERDICTS = ["yes", "no", "change", "unclear"];

const VERDICT_TOOL = {
  name: "verdict",
  description: "Record what the owner's reply does to the action that was described to them.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: VERDICTS,
        description:
          "yes: an unambiguous go-ahead for exactly the action as described. " +
          "no: they decline it. " +
          "change: they are willing in principle but want some detail different from the description. " +
          "unclear: anything else — a question, a remark, an answer to something else, or a reply you cannot place.",
      },
      note: {
        type: "string",
        description: "Only when the verdict is 'change': what they want different, one short phrase, in their own terms.",
      },
    },
    required: ["verdict"],
  },
};

const INSTRUCTIONS = `You are the guard on a single confirmation. An assistant has described exactly one action it is about to take for its owner — something that spends their money or acts on someone else. The owner has replied. Decide only what that reply does to that action.

- 'yes' means an unambiguous go-ahead for the action exactly as described. If it needs weighing up, it is not 'yes'.
- If they approve but change ANY detail — time, date, place, party size, price, the name on it, anything at all — that is 'change', never 'yes'. Going ahead with the description as written would do the very thing they just corrected.
- Read what the words mean, not which words appear. "no problem, book it" is a go-ahead. "don't wait, do it now" is a go-ahead. "perfect, lock it in" is a go-ahead. "ok but make it 9 instead" is a change.
- A question about the action, a reply to some other topic, or anything you cannot confidently place is 'unclear'.
- Judge only the reply you are given. Do not imagine surrounding conversation.`;

let client = null;
const anthropic = () => (client ??= tracked(new Anthropic(), "judge"));

/**
 * Read one reply against one described action. Never throws and never guesses upward: a network
 * error, a timeout, or a malformed answer all come back 'unclear', which authorizes nothing.
 */
export async function judgeReply({ summary, reply }) {
  // The owner's local, no-credit path. Same contract, same fail-closed behaviour, same words;
  // only where the call goes is different. The API path below is untouched.
  if (process.env.REASON_BACKEND === "claude-cli") {
    return await judgeViaCli({ summary, reply, instructions: INSTRUCTIONS });
  }
  try {
    // On Opus 5.5 (the live REASON_MODEL) forced tool use is a 400 and thinking cannot be turned
    // off, so the tool is steered rather than forced and the answer has room after the thinking.
    const one = oneToolCall(config.judgeModel, "verdict", INSTRUCTIONS);
    const res = await anthropic().messages.create(
      {
        model: config.judgeModel,
        max_tokens: 4000,
        system: one.system,
        tools: [VERDICT_TOOL],
        tool_choice: one.tool_choice,
        messages: [{
          role: "user",
          content: `The action, exactly as the assistant described it:\n${summary}\n\nThe owner's reply, verbatim:\n${reply}`,
        }],
      },
      { timeout: config.judgeTimeoutMs, maxRetries: 1 },
    );
    const block = res.content.find(b => b.type === "tool_use" && b.name === "verdict");
    const verdict = block?.input?.verdict;
    if (!VERDICTS.includes(verdict)) {
      return { verdict: "unclear", error: `the judge returned ${JSON.stringify(verdict ?? null)}` };
    }
    const note = typeof block.input.note === "string" ? block.input.note.trim().slice(0, 200) : "";
    return { verdict, note: verdict === "change" ? note : "" };
  } catch (e) {
    return { verdict: "unclear", error: (e?.message ?? String(e)).split("\n")[0] };
  }
}
