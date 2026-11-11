// One rule, enforced in code: the subscription backend is the operator's own test rig, and it may
// not be what answers other people.
//
// `REASON_BACKEND=claude-cli` runs every turn through the `claude` CLI against a personal Claude
// subscription (see src/backends/claude-cli.js and the README). That is a fine way to prove the
// live behaviour works — all 25 live tests pass on it. It is not a way to run a service: it is one
// person's subscription, with no per-install billing, no rate limit anyone else is entitled to and
// no prompt cache.
//
// It used to refuse to start at all with a real channel connected. That was too blunt: the
// operator wants to test over their own phone, which needs the channel up. So the rule is now
// narrower and stricter at the same time — the channel may run, and **only the operator's own test
// numbers get answers.** Every other number gets a single "not available yet" line and no model
// turn, whether they are invited or not.
//
// With no test numbers set there is nobody it could legitimately answer, so it still refuses to
// start rather than running a service nobody can use.
import { config, normalizeNumber, normalizeHandle } from "../config.js";

// Channels that only ever reach the operator. An ALLOWLIST, so a channel adapter added later is
// treated as external by default instead of needing to be remembered here.
const OWNER_ONLY = new Set(["console", "fake"]);

/**
 * Should this process refuse to start? Pure, so the decision is testable without a server, a
 * model, or credentials.
 *
 * @param {{backend: string, channels: Array<{name: string, status?: string, configured?: boolean}>,
 *          testNumbers?: string[], ownerName?: string}} _
 * @returns {{blocked: boolean, channels?: string[], message?: string}}
 */
export function subscriptionBackendBlock({ backend, channels = [], testNumbers = null, ownerName = "the owner" } = {}) {
  if (backend !== "claude-cli") return { blocked: false };
  if (config.autoAdmit) return { blocked: false };

  const external = channels
    .filter(s => s && !OWNER_ONLY.has(s.name))
    .filter(s => s.status === "live" || s.configured === true);
  if (!external.length) return { blocked: false };

  const numbers = (testNumbers ?? config.testNumbers).map(normalizeNumber).filter(Boolean);
  if (numbers.length) {
    // The channel is up and there is somebody it is allowed to answer. Serving is restricted to
    // those numbers by `servesOnThisBackend` below, checked per message.
    return { blocked: false, restricted: true, channels: external.map(s => s.name), testNumbers: numbers };
  }

  const names = external.map(s => s.name);
  return {
    blocked: true,
    channels: names,
    message: [
      `Refusing to start: REASON_BACKEND=claude-cli with ${names.join(", ")} set up and no test numbers.`,
      ``,
      `The claude-cli backend runs every turn through the \`claude\` CLI on ${ownerName}'s Claude`,
      `subscription. It is for ${ownerName}'s own testing, so it will only ever answer ${ownerName}'s own`,
      `numbers — and REASON_TEST_NUMBERS is empty, so there is nobody it may answer at all.`,
      ``,
      `Either set REASON_TEST_NUMBERS to ${ownerName}'s own number(s) to test over ${names.join(", ")},`,
      `or serve other people properly: set ANTHROPIC_API_KEY to a key with credit and either drop`,
      `REASON_BACKEND or set REASON_BACKEND=api. An API key is required before anybody but`,
      `${ownerName} is served.`,
      ``,
      `\`npm run chat\` and \`REASON_BACKEND=claude-cli npm test\` are unaffected.`,
    ].join("\n"),
  };
}

/**
 * What `serve` prints under "model:" on the subscription backend. Pure, so the words can be checked.
 *
 * Until 2026-11-11 it said "ONLY these numbers get answers" even with REASON_AUTO_ADMIT=1, under
 * which servesOnThisBackend answers everybody and the test-number list decides nothing — a banner
 * that reads as a promise the process is not keeping.
 */
export function modelBannerLines({ ownerName = config.ownerName, testNumbers = config.testNumbers, autoAdmit = config.autoAdmit } = {}) {
  const lines = [`  model: the claude CLI on ${ownerName}'s subscription — ${ownerName}'s own testing only.`];
  if (autoAdmit) {
    lines.push(`         REASON_AUTO_ADMIT=1: EVERYBODY who texts is admitted and answered on this subscription.`);
    lines.push(`         The test-number list (${testNumbers.join(", ") || "none"}) restricts nothing while that is set.`);
  } else {
    lines.push(`         ONLY these numbers get answers: ${testNumbers.join(", ") || "(none — serve would have refused to start)"}`);
    lines.push(`         Every other number gets one "not available yet" line and no model turn.`);
  }
  lines.push(`         An Anthropic API key with credit is required before anybody else is served.`);
  return lines;
}

/**
 * May this number be served on the backend that is running?
 *
 * On the API backend everybody who is admitted is served — that is what an API key with credit
 * buys. On the subscription backend only the operator's own test numbers are, because every turn
 * is spent out of one person's personal plan. A number that is refused here gets one line and no
 * model turn: the point is that it costs nothing.
 *
 * @returns {{serves: true} | {serves: false, reason: string, line: string}}
 */
export function servesOnThisBackend(address, { backend = config.backend, testNumbers = null, ownerName = config.ownerName } = {}) {
  if (backend !== "claude-cli") return { serves: true };
  // Auto-admit means everyone with the number was given it by the owner — they are all testers.
  if (config.autoAdmit) return { serves: true };

  const addr = normalizeHandle(address) || String(address ?? "").trim();
  // The console is the operator typing on the machine the subscription belongs to.
  if (addr === "console" || !addr) return { serves: true };

  const allowed = (testNumbers ?? config.testNumbers).map(normalizeNumber).filter(Boolean);
  if (allowed.includes(addr)) return { serves: true };

  return {
    serves: false,
    reason: "subscription_backend_test_only",
    line: `hey — ${ownerName}'s assistant isn't available yet. nothing you've sent has gone anywhere. try again once ${ownerName} has it properly set up.`,
  };
}
