// One rule, enforced in code: the subscription backend is the owner's local test rig, and it may
// not be the thing answering other people's texts.
//
// `REASON_BACKEND=claude-cli` runs every turn through the `claude` CLI against a personal Claude
// subscription (see src/backends/claude-cli.js and the README). That is a fine way to prove the
// live behaviour works on this machine. It is not a way to run a service: it is one person's
// subscription, it has no per-install billing, no rate limit anyone else is entitled to, and no
// prompt cache. So the moment a channel exists that could put Reason in front of somebody who is
// not the owner, `npm run serve` refuses to start rather than quietly serving strangers off a
// personal plan.
//
// The list below is an ALLOWLIST of channels that only ever reach the owner. Anything not on it
// counts as external, so a channel adapter added later blocks by default instead of needing to be
// remembered here. Failing closed is the whole point.
const OWNER_ONLY = new Set(["console", "fake"]);

/**
 * Should this process refuse to start? Pure, so the decision is testable without a server, a
 * model, or credentials.
 *
 * @param {{backend: string, channels: Array<{name: string, status?: string, configured?: boolean}>}} _
 * @returns {{blocked: boolean, channels?: string[], message?: string}}
 */
export function subscriptionBackendBlock({ backend, channels = [], ownerName = "the owner" } = {}) {
  if (backend !== "claude-cli") return { blocked: false };

  // "live" is connected; "configured" catches a half-set-up adapter, because someone who has put
  // a Linq key in .env is on their way to letting other people text it, not testing locally.
  const external = channels
    .filter(s => s && !OWNER_ONLY.has(s.name))
    .filter(s => s.status === "live" || s.configured === true);

  if (!external.length) return { blocked: false };
  const names = external.map(s => s.name);

  return {
    blocked: true,
    channels: names,
    message: [
      `Refusing to start: REASON_BACKEND=claude-cli with ${names.join(", ")} set up.`,
      ``,
      `The claude-cli backend runs every turn through the \`claude\` CLI on ${ownerName}'s Claude`,
      `subscription. It is for ${ownerName}'s own local testing and nothing else. These channels can`,
      `put Reason in front of other people: ${names.join(", ")}.`,
      ``,
      `Before anyone but ${ownerName} can text this, an Anthropic API key with credit has to be in`,
      `place: set ANTHROPIC_API_KEY and either drop REASON_BACKEND or set REASON_BACKEND=api.`,
      ``,
      `To keep testing on the subscription right now, leave the channel credentials out of .env and`,
      `use \`npm run chat\`, or \`REASON_BACKEND=claude-cli npm test\`. The console is always allowed.`,
    ].join("\n"),
  };
}
