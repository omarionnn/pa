// How a call is tuned, by who is on the other end — and which speech model it ran under.
//
// From the 2026-10-07 addendum, sections 2 and 4. Two things that look like per-call settings and
// are not, and the honest shape of each:
//
//   THE TURN PROFILE. A business line wants `patient` turn-taking and a long silence timeout — a
//   receptionist pauses, an `eager` agent talks over her. The owner's own call wants the opposite:
//   quick turns and a short timeout, so a question is answered before it feels ignored. On their
//   platform these are AGENT settings and their per-conversation overrides do not reach them (the
//   override list is the voice id, the prompt, the first message, the language, the LLM, the tools,
//   the speed; read 2026-10-07). So two profiles means two agents, and `agentIdFor` picks the one
//   for the call being placed. With one agent configured, both kinds of call run under it, the row
//   says so, and an inbound owner call — which lands on whichever agent the number is bound to —
//   runs under that agent's profile whatever this file would prefer. That limit is in
//   docs/unverified.md by name rather than papered over here.
//
//   THE SPEECH MODEL. Also agent-level. `ELEVENLABS_TTS_MODEL` is the record of which one the
//   agent is set to, written on every call row, so "first word in 1.4 s" measured on Friday says
//   which model that was under. The two candidates and the vendor's own synthesis figures are below
//   with the caveat that matters: those are synthesis alone, not a phone call end to end.
import { config } from "../config.js";

/**
 * The two profiles. The numbers are defaults for the owner to pick over — they are in the Friday
 * checklist as his to set on each agent, and nothing here is a finding about what works.
 *
 * `turnTimeoutSeconds` is their `turn_timeout` (1–30 s of silence before the agent speaks again);
 * `eagerness` is their `turn_eagerness`. `hesitation` is the rule the owner profile carries into
 * the prompt: the thing that distinguishes a person thinking from a person finished.
 */
export const TURN_PROFILES = {
  owner: {
    name: "owner",
    eagerness: "normal",
    turnTimeoutSeconds: 7,
    softTimeoutSeconds: 3,
    maxDurationSeconds: 30 * 60,
    hesitation: `A short pause with the sentence unfinished — "so I was thinking…", a trailing "um" — is them`
      + ` thinking, not the end of their turn. Wait it out. Only a finished sentence, or a question, is your turn.`,
  },
  third_party: {
    name: "third_party",
    eagerness: "patient",
    turnTimeoutSeconds: 20,
    softTimeoutSeconds: 6,
    maxDurationSeconds: 60 * 60,
    hesitation: `A business line is slower than a person's phone: give them room, never talk over a receptionist,`
      + ` and treat a pause as them checking rather than as your turn.`,
  },
};

/** The profile for a kind of call. Anything that is not the owner's own call is a business line. */
export function turnProfileFor(kind) {
  return kind === "owner" ? TURN_PROFILES.owner : TURN_PROFILES.third_party;
}

/**
 * Which agent a call of this kind is placed through.
 *
 * The owner's own calls go through the owner-tuned agent when one is configured; everything else,
 * and everything when there is only one agent, goes through the main one. Never guessed: with no
 * owner agent set the answer is the main agent, and the call row records which profile that was.
 */
export function agentIdFor(kind, { ownerAgentId = config.elevenOwnerAgentId, agentId = config.elevenAgentId } = {}) {
  if (kind === "owner" && ownerAgentId) return { agentId: ownerAgentId, profile: "owner", separate: true };
  return { agentId, profile: kind === "owner" ? "owner" : "third_party", separate: false };
}

/**
 * The speech models in the trial, and the vendor's synthesis-only figures for each ("Models",
 * read 2026-10-07). NOT end-to-end call latency — those numbers exclude the model turn, the
 * network and the phone leg, and must never be written down as if they were a call's.
 *
 * `expressive` is why the trial starts where it does: their expressive mode (audio tags, laughter,
 * tone) runs on the conversational v3 model and not on Flash.
 */
export const TTS_MODELS = {
  eleven_v3_conversational: { synthesisMs: 280, expressive: true, note: "the naturalness candidate; expressive mode runs on this one" },
  eleven_flash_v2_5: { synthesisMs: 75, expressive: false, note: "the responsiveness candidate; documented limits on number normalization" },
};

/** The model the agent is set to, as Reason records it. The agent's own setting is the truth. */
export function ttsModel({ model = config.elevenTtsModel } = {}) {
  const name = String(model ?? "").trim();
  return { model: name, known: Object.hasOwn(TTS_MODELS, name), ...(TTS_MODELS[name] ?? {}) };
}

/**
 * The one line a profile puts in the prompt. The numbers stay out of it — a model cannot act on
 * "turn_timeout 7" — and the hesitation rule goes in, because that is the half of the profile the
 * model is responsible for.
 */
export function profileNote(kind) {
  return turnProfileFor(kind).hesitation;
}
