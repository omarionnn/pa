// The subscription backend is the owner's local test rig. These tests pin the one rule that
// keeps it that way: with a channel other people can text, `npm run serve` does not start.
//
// Offline on purpose — the decision is a pure function, so proving it needs no model, no port and
// no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionBackendBlock } from "../src/backends/guard.js";

const CONSOLE_LIVE = { name: "console", status: "live", missing: [] };
const LINQ_LIVE = { name: "linq", status: "live", missing: [], configured: true };
const LINQ_OFF = { name: "linq", status: "not_connected", missing: ["LINQ_API_KEY", "LINQ_WEBHOOK_SECRET"], configured: false };

test("the API backend is never blocked, whatever is connected", () => {
  for (const backend of ["api", undefined, "something-else"]) {
    const r = subscriptionBackendBlock({ backend, channels: [CONSOLE_LIVE, LINQ_LIVE] });
    assert.equal(r.blocked, false, `backend ${backend} should start`);
  }
});

test("claude-cli with only the console is fine", () => {
  const r = subscriptionBackendBlock({ backend: "claude-cli", channels: [CONSOLE_LIVE, LINQ_OFF] });
  assert.equal(r.blocked, false);
});

test("claude-cli with the fake channel is fine", () => {
  const r = subscriptionBackendBlock({
    backend: "claude-cli",
    channels: [CONSOLE_LIVE, { name: "fake", status: "live", missing: [] }],
  });
  assert.equal(r.blocked, false);
});

test("claude-cli with Linq connected refuses to start, and says why", () => {
  const r = subscriptionBackendBlock({ backend: "claude-cli", channels: [CONSOLE_LIVE, LINQ_LIVE], ownerName: "Omari" });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.channels, ["linq"]);
  // The message has to name the real requirement, not just complain.
  assert.match(r.message, /ANTHROPIC_API_KEY/);
  assert.match(r.message, /credit/i);
  assert.match(r.message, /linq/);
  assert.match(r.message, /Omari/);
  // And it has to leave the owner a way to carry on testing.
  assert.match(r.message, /npm run chat/);
});

test("a half-configured Linq still blocks: configured counts, not just live", () => {
  const halfway = { name: "linq", status: "not_connected", missing: ["LINQ_WEBHOOK_SECRET"], configured: true };
  const r = subscriptionBackendBlock({ backend: "claude-cli", channels: [CONSOLE_LIVE, halfway] });
  assert.equal(r.blocked, true, "a Linq key in .env is somebody on their way to letting others text it");
});

test("an unknown channel is treated as external by default", () => {
  // The guard allowlists the owner-only channels rather than listing the risky ones, so an
  // adapter added later blocks until somebody decides otherwise.
  const r = subscriptionBackendBlock({
    backend: "claude-cli",
    channels: [CONSOLE_LIVE, { name: "whatsapp-someday", status: "live", missing: [] }],
  });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.channels, ["whatsapp-someday"]);
});

test("no channels at all is not blocked", () => {
  assert.equal(subscriptionBackendBlock({ backend: "claude-cli", channels: [] }).blocked, false);
  assert.equal(subscriptionBackendBlock({ backend: "claude-cli" }).blocked, false);
});
