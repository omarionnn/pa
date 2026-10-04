// The watcher's eye. A watch says "tell me when X" about a page; something has to decide, each
// time the page is re-read, whether X has happened. Same shape as the confirm gate's judge: one
// narrow call, no conversation history, a forced structured answer, and it fails closed — if the
// check cannot be made, the condition is NOT met, so a watch never fires on a shrug.
//
// Deciding is the model's job because "a table opened up" or "the price dropped" is a reading of
// the page, not a string comparison. What code owns is the schedule, the attempt count, and the
// fact that a watch fires once: see the watches table in db.js.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { checkWatchViaCli } from "./backends/cli.js";

const CHECK_TOOL = {
  name: "watch_check",
  description: "Say whether what the owner is waiting for has happened on this page.",
  input_schema: {
    type: "object",
    properties: {
      met: {
        type: "boolean",
        description: "True only if the page now shows what they are waiting for. If you are unsure, false.",
      },
      why: {
        type: "string",
        description: "One short line quoting or naming the part of the page that decided it, either way.",
      },
    },
    required: ["met", "why"],
  },
};

const INSTRUCTIONS = `You are checking one page on someone's behalf. They asked to be told when a specific thing happens on it. You are given what they are waiting for, the page as it reads now, and what it said at the last check.

- 'met' is true only when the page itself now shows the thing they are waiting for. Read the page, do not infer from the absence of information.
- A page that is unchanged, empty, an error, a sign-in wall or a cookie notice has not met anything. That is 'met': false.
- Do not treat your own uncertainty as a yes. If you cannot tell, 'met' is false and the watch simply checks again later.
- 'why' is one short line naming what decided it, whether met is true or false.`;

let client = null;
const anthropic = () => (client ??= new Anthropic());

/**
 * Has the thing happened? Never throws and never guesses upward: any failure is { met: false },
 * which costs one wasted check and never a false alarm.
 */
export async function checkWatch({ lookingFor, text, previousText = null }) {
  // The owner's local, no-credit path. Same contract, same fail-closed behaviour; only where
  // the call goes is different. The API path below is untouched.
  if (process.env.REASON_BACKEND === "claude-cli") {
    return await checkWatchViaCli({ lookingFor, text, previousText, instructions: INSTRUCTIONS });
  }
  try {
    const before = previousText == null
      ? "This is the first check, so there is nothing to compare against."
      : `What the page said at the last check:\n${String(previousText).slice(0, 4000)}`;
    const res = await anthropic().messages.create(
      {
        model: config.judgeModel,
        max_tokens: 300,
        system: INSTRUCTIONS,
        tools: [CHECK_TOOL],
        tool_choice: { type: "tool", name: "watch_check" },
        messages: [{
          role: "user",
          content: `What they are waiting for:\n${lookingFor}\n\nThe page as it reads now:\n${String(text ?? "").slice(0, 8000)}\n\n${before}`,
        }],
      },
      { timeout: config.judgeTimeoutMs, maxRetries: 1 },
    );
    const block = res.content.find(b => b.type === "tool_use" && b.name === "watch_check");
    if (typeof block?.input?.met !== "boolean") {
      return { met: false, why: `the check returned nothing usable`, error: "off-schema" };
    }
    return { met: block.input.met, why: String(block.input.why ?? "").trim().slice(0, 300) };
  } catch (e) {
    return { met: false, why: "the page could not be checked this time", error: (e?.message ?? String(e)).split("\n")[0] };
  }
}
