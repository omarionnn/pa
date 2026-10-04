// The subscription backend is the owner's local test rig. These tests pin the one rule that
// keeps it that way: with a channel other people can text, `npm run serve` does not start.
//
// Offline on purpose — the decision is a pure function, so proving it needs no model, no port and
// no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionBackendBlock, servesOnThisBackend } from "../src/backends/guard.js";

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

test("claude-cli with Linq connected and NO test numbers refuses to start", () => {
  const r = subscriptionBackendBlock({ backend: "claude-cli", channels: [CONSOLE_LIVE, LINQ_LIVE], testNumbers: [], ownerName: "Omari" });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.channels, ["linq"]);
  // There is nobody it may answer, so running would be serving a service nobody can use.
  assert.match(r.message, /REASON_TEST_NUMBERS/);
  assert.match(r.message, /ANTHROPIC_API_KEY/);
  assert.match(r.message, /credit/i);
  assert.match(r.message, /required before anybody but/i);
  assert.match(r.message, /npm run chat/);
});

test("claude-cli with Linq connected AND a test number starts, restricted", () => {
  const r = subscriptionBackendBlock({
    backend: "claude-cli", channels: [CONSOLE_LIVE, LINQ_LIVE],
    testNumbers: ["+12025551234"], ownerName: "Omari",
  });
  assert.equal(r.blocked, false, "the operator can test over their own phone");
  assert.equal(r.restricted, true);
  assert.deepEqual(r.testNumbers, ["+12025551234"]);
});

test("on claude-cli only the operator's test numbers are served", () => {
  const opts = { backend: "claude-cli", testNumbers: ["+12025551234", "+1 (202) 555-9999"], ownerName: "Omari" };
  assert.equal(servesOnThisBackend("+12025551234", opts).serves, true);
  assert.equal(servesOnThisBackend("+12025559999", opts).serves, true, "formatting is not identity");
  assert.equal(servesOnThisBackend("console", opts).serves, true, "the operator typing on the machine itself");

  const other = servesOnThisBackend("+14155559876", opts);
  assert.equal(other.serves, false);
  assert.equal(other.reason, "subscription_backend_test_only");
  assert.match(other.line, /isn't available yet/i);
  assert.match(other.line, /nothing you've sent has gone anywhere/i);
});

test("on the API backend everybody admitted is served", () => {
  for (const backend of ["api", undefined]) {
    assert.equal(servesOnThisBackend("+14155559876", { backend, testNumbers: [] }).serves, true);
  }
});

test("a half-configured Linq still blocks: configured counts, not just live", () => {
  const halfway = { name: "linq", status: "not_connected", missing: ["LINQ_WEBHOOK_SECRET"], configured: true };
  const r = subscriptionBackendBlock({ backend: "claude-cli", channels: [CONSOLE_LIVE, halfway], testNumbers: [] });
  assert.equal(r.blocked, true, "a Linq key in .env is somebody on their way to letting others text it");
});

test("an unknown channel is treated as external by default", () => {
  // The guard allowlists the owner-only channels rather than listing the risky ones, so an
  // adapter added later blocks until somebody decides otherwise.
  const r = subscriptionBackendBlock({
    backend: "claude-cli",
    channels: [CONSOLE_LIVE, { name: "whatsapp-someday", status: "live", missing: [] }],
    testNumbers: [],
  });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.channels, ["whatsapp-someday"]);
});

test("no channels at all is not blocked", () => {
  assert.equal(subscriptionBackendBlock({ backend: "claude-cli", channels: [] }).blocked, false);
  assert.equal(subscriptionBackendBlock({ backend: "claude-cli" }).blocked, false);
});
