// How a call is tuned, by who is on the other end (2026-10-07 addendum, section 4).
//
// A business line wants patient turn-taking — a receptionist pauses, an eager voice talks over her.
// The owner's own call wants the opposite: quick turns, so a question is answered before it feels
// ignored. The half of that the model is responsible for is the hesitation rule in its prompt.
/**
 * The two profiles. The numbers are defaults, and nothing here is a finding about what works.
 * `hesitation` is the rule each profile carries into the prompt: the thing that distinguishes a
 * person thinking from a person finished.
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
 * The one line a profile puts in the prompt. The numbers stay out of it — a model cannot act on
 * "turn_timeout 7" — and the hesitation rule goes in, because that is the half of the profile the
 * model is responsible for.
 */
export function profileNote(kind) {
  return turnProfileFor(kind).hesitation;
}
