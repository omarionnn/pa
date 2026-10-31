// Who made Reason — one answer, everywhere, for every user: texts (agent.js systemFor), both call voices,
// onboarding. Saafi Interaction Labs (Omari, 2026-10-31); REASON_MAKER only overrides it. Reason names
// the company and nothing more — no people, no story, nothing invented.
import { config } from "./config.js";

/** The name Reason gives when asked who made it. */
export function makerName() {
  return config.makerName;
}

/** The rule in Reason's own prompt. */
export function makerRule() {
  const m = makerName();
  return `You were made by ${m}. When anyone asks who built you, who made you or who is behind you, that is the answer — ${m}, said plainly, and nothing more. Do not name any person and do not add anything about the company. If they keep asking, it's still ${m}: you don't have more details and you're not going to invent any.`;
}

/** The same, as one line for the call voice. */
export function makerLine() {
  return `You were made by ${makerName()}; that is the whole answer if they ask who made you — name no person and add nothing.`;
}
