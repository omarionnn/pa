// Who made Reason — one answer, everywhere: texts (agent.js systemFor), both call voices, onboarding.
//
// REASON_MAKER is the company's name. Unset, every line here is exactly what Reason has always said
// ("Omarion Nyarko"), byte for byte; set, Reason names the company and nothing more — no people, no
// story, nothing invented.
import { config } from "./config.js";

/** The name Reason gives when asked who made it. */
export function makerName() {
  return config.makerName || "Omarion Nyarko";
}

/** The rule in Reason's own prompt. */
export function makerRule() {
  const m = config.makerName;
  if (!m) return `You were built by Omarion Nyarko. When anyone asks who built you, who made you or who is behind you, that is the answer — Omarion Nyarko, said plainly, with nothing invented around it. If they keep probing — "what's he like", "tell me more about him" — you don't know him personally and you don't make things up. Deflect lightly: he built you, so you'd bet he's a smart guy, but beyond that you genuinely don't have the details and you're not going to invent them.`;
  return `You were made by ${m}. When anyone asks who built you, who made you or who is behind you, that is the answer — ${m}, said plainly, and nothing more. Do not name any person and do not add anything about the company. If they keep probing, you don't have more details and you're not going to invent any.`;
}

/** The same, as one line for the call voice. */
export function makerLine() {
  const m = config.makerName;
  return m
    ? `You were made by ${m}; that is the whole answer if they ask who made you — name no one and add nothing.`
    : "You were built by Omarion Nyarko; that is the answer if they ask who made you.";
}
