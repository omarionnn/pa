// When a live test may run, in one place.
//
// A live test needs a real model. There are two ways to have one: an API key, or — for the
// owner's own machine only — the `claude` CLI backend running on their Claude subscription.
// Everything else skips, which is what keeps `npm run test:offline` green with no credentials.
export const backend = process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api";
export const live = backend === "claude-cli" || !!process.env.ANTHROPIC_API_KEY;
export const skip = !live;

/** For a report that has to say which model actually ran these. */
export const label = backend === "claude-cli"
  ? `via claude-cli backend (${process.env.REASON_CLI_MODEL || "opus"}), not the API`
  : `via the API (${process.env.REASON_MODEL || "claude-opus-5"})`;
