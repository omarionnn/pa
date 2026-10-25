// When a live test may run, in one place.
//
// A live test needs a real model, and it runs on the `claude` CLI on a Claude subscription — never
// on Reason's paid API key (test/paid-key-guard.js takes the key out of every test process unless
// REASON_TEST_ALLOW_API=1). Everything else skips, which is what keeps `npm run test:offline` green
// with no credentials.
import { apiAllowed } from "./paid-key-guard.js";

export const backend = process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api";
export const live = backend === "claude-cli" || (apiAllowed && !!process.env.ANTHROPIC_API_KEY);
export const skip = !live;

/** For a report that has to say which model actually ran these. */
export const label = backend === "claude-cli"
  ? `via claude-cli backend (${process.env.REASON_CLI_MODEL || "opus"}), not the API`
  : `via the API (${process.env.REASON_MODEL || "claude-opus-5"}) — REASON_TEST_ALLOW_API=1`;
