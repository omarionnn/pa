// Uber, against a fake Uber that answers the routes their docs document.
//
// What these tests prove:
//   1. Not connected = honest refusal with uber_link as the alternative.
//   2. The handshake works: authorize URL, callback with code, token stored with scopes.
//   3. Identity-only (no `request` scope) cannot quote or book — and says so.
//   4. The full ride flow: options → quote row → request (with re-pricing) → status → cancel.
//   5. One person's token is never reachable from another person's thread.
//   6. A price change between quote and booking blocks the request.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUber } from "./fixture-uber.js";

const dir = mkdtempSync(join(tmpdir(), "reason-uber-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32); // stored login tokens are sealed (src/secretbox.js); a throwaway key
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool } = await import("../src/tools.js");
const uber = await import("../src/uber.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const readsYes = async () => ({ verdict: "yes" });

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";

let fake;
const call = (name, input, conversationId = OMARI) => runTool(name, input, { conversationId, messages: [] });

before(async () => {
  fake = await startUber();
  config.uberClientId = "test-client-id";
  config.uberClientSecret = "test-client-secret";
  config.uberAuthBase = fake.base;
  config.uberApiBase = fake.base;
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM spend; DELETE FROM conversations; DELETE FROM uber_rides;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  fake.state.tokenCalls.length = 0;
  fake.state.authHeaders.length = 0;
  fake.state.rides.length = 0;
  fake.state.cancels.length = 0;
});

async function connect(conversationId = OMARI, { scopes, code = "good-code" } = {}) {
  const link = await call("uber_connect", { they_asked_to_connect: true, ...(scopes ? { scopes } : {}) }, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await uber.completeConnect({ code, state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return done;
}

const owner = (text) => ({ role: "user", content: text });

async function confirmRide(quoteId, conversationId = OMARI) {
  // First attempt without confirmation — the gate hands back the target string.
  const refused = await call("uber_request", { quote_id: quoteId }, conversationId);
  assert.equal(refused.ok, false, "should need confirmation");
  assert.ok(refused.use_target, "refusal should carry use_target");
  const req = await call("confirm_request", {
    action: "uber_request",
    summary: `Request the ride (${quoteId})?`,
    stakes: "money",
    target: refused.use_target,
  }, conversationId);
  assert.ok(req.confirmation_id, JSON.stringify(req));
  const messages = [owner("yes book it")];
  const granted = await runTool("confirm_record", { confirmation_id: req.confirmation_id }, { conversationId, messages, judge: readsYes });
  assert.equal(granted.state, "granted", JSON.stringify(granted));
  return req.confirmation_id;
}

// ---------- not connected ----------

test("uber_connect when there are no credentials says so honestly", async () => {
  const saved = { id: config.uberClientId, secret: config.uberClientSecret };
  config.uberClientId = "";
  config.uberClientSecret = "";
  try {
    const out = await call("uber_connect", { they_asked_to_connect: true });
    assert.equal(out.ok, false);
    assert.ok(out.missing.length > 0);
    assert.ok(out.error.includes("not connected"));
  } finally {
    config.uberClientId = saved.id;
    config.uberClientSecret = saved.secret;
  }
});

test("uber_options when not connected says so", async () => {
  const out = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes("not connected"));
});

// ---------- the handshake ----------

test("connect stores scopes and names the account", async () => {
  const done = await connect();
  assert.equal(done.account, "Omari");
  assert.ok(done.scopes.includes("request"));
  assert.equal(done.can_book, true);
});

test("connect with identity-only scopes reports can_book false", async () => {
  const identityFake = await startUber({ grantScopes: ["profile", "places", "offline_access"] });
  config.uberAuthBase = identityFake.base;
  config.uberApiBase = identityFake.base;
  try {
    const link = await call("uber_connect", { they_asked_to_connect: true });
    assert.equal(link.ok, true);
    const state = new URL(link.url).searchParams.get("state");
    const done = await uber.completeConnect({ code: "good-code", state });
    assert.equal(done.ok, true);
    assert.equal(done.can_book, false);
    assert.ok(done.missing_privileged.includes("request"));
  } finally {
    config.uberAuthBase = fake.base;
    config.uberApiBase = fake.base;
    await identityFake.close();
  }
});

// ---------- identity-only cannot quote ----------

test("uber_options with identity-only grant is refused", async () => {
  const identityFake = await startUber({ grantScopes: ["profile", "places", "offline_access"] });
  config.uberAuthBase = identityFake.base;
  config.uberApiBase = identityFake.base;
  try {
    const link = await call("uber_connect", { they_asked_to_connect: true });
    const state = new URL(link.url).searchParams.get("state");
    await uber.completeConnect({ code: "good-code", state });
    const out = await call("uber_options", { start_latitude: 40.7128, start_longitude: -74.006, end_latitude: 40.758, end_longitude: -73.9855 });
    assert.equal(out.ok, false);
    assert.ok(out.error.includes("request"));
  } finally {
    config.uberAuthBase = fake.base;
    config.uberApiBase = fake.base;
    await identityFake.close();
  }
});

// ---------- the ride flow ----------

test("uber_options returns products with quote_ids", async () => {
  await connect();
  const out = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
    start_label: "Downtown", end_label: "Times Square",
  });
  assert.equal(out.ok, true);
  assert.ok(out.count >= 1);
  assert.ok(out.options[0].quote_id);
  assert.ok(out.options[0].fare_id);
  assert.equal(out.options[0].display, "$14.32");
});

test("uber_request books a ride and returns a request_id", async () => {
  await connect();
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId);
  const out = await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  assert.equal(out.ok, true);
  assert.ok(out.request_id);
  assert.equal(out.status, "processing");
  assert.equal(fake.state.rides.length, 1);
});

test("uber_request refuses a duplicate booking", async () => {
  await connect();
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId);
  const first = await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  assert.equal(first.ok, true, "first booking should succeed");
  // A spent confirmation cannot be reused — the gate blocks it before the handler runs, which is
  // the same protection against double-booking: you cannot book twice with one yes.
  const dup = await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  assert.equal(dup.ok, false);
  assert.ok(dup.error.includes("already used"), `expected gate to block reused confirmation, got: ${dup.error}`);
});

test("uber_ride shows the driver and car", async () => {
  await connect();
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId);
  await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  const out = await call("uber_ride", {});
  assert.equal(out.ok, true);
  assert.equal(out.status, "accepted");
  assert.equal(out.driver.name, "Marcus");
  assert.equal(out.plate, "ABC 1234");
});

test("uber_cancel cancels the ride", async () => {
  await connect();
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId);
  await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  const out = await call("uber_cancel", {});
  assert.equal(out.ok, true);
  assert.equal(out.status, "cancelled");
  assert.equal(fake.state.cancels.length, 1);
});

test("uber_receipt returns receipt data", async () => {
  await connect();
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId);
  await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  const out = await call("uber_receipt", {});
  assert.equal(out.ok, true);
  assert.ok(out.total_charged);
});

// ---------- isolation ----------

test("one person's ride is not reachable from another's thread", async () => {
  await connect(OMARI);
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  }, OMARI);
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId, OMARI);
  await call("uber_request", { quote_id: quoteId, confirmation_id: confId }, OMARI);
  const other = await call("uber_ride", {}, AMA);
  assert.equal(other.ok, false);
});

// ---------- price change ----------

test("uber_request blocks when the fare changes", async () => {
  await connect();
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  });
  const quoteId = opts.options[0].quote_id;
  const confId = await confirmRide(quoteId);
  // Manually set a different fare_cents to simulate a price change on re-quote
  db.markUberRide(quoteId, { fareCents: 999, status: "quoted" });
  const out = await call("uber_request", { quote_id: quoteId, confirmation_id: confId });
  assert.equal(out.ok, false);
  assert.equal(out.status, "price_changed");
  assert.ok(out.error.includes("changed"));
});

// ---------- disconnect ----------

test("disconnect drops the tokens", async () => {
  await connect();
  const st1 = uber.stateOf(OMARI);
  assert.equal(st1.state, "ride_access");
  uber.disconnect(OMARI);
  const st2 = uber.stateOf(OMARI);
  assert.equal(st2.state, "not_connected");
});

// ---------- the confirm gate never describes someone else's quote (audit lead 21) ----------

test("the uber_request gate does not show another person's quote: route and fare stay theirs", async () => {
  db.recordUberQuote({
    conversationId: OMARI, quoteId: "q_1_abcdefgh", productName: "UberX",
    start: { label: "Victim Home" }, end: { label: "Clinic" }, fareCents: 1432, fareDisplay: "$14.32",
  });
  const out = await call("uber_request", { quote_id: "q_1_abcdefgh" }, AMA);
  assert.equal(out.ok, false);
  const seen = JSON.stringify(out);
  for (const secret of ["Victim Home", "Clinic", "$14.32", "UberX"]) assert.ok(!seen.includes(secret), `leaked ${secret}: ${seen}`);
  assert.equal(out.blocked, "needs_confirmation");
  assert.equal(out.use_target, "unknown uber quote q_1_abcdefgh");
  // The owner's own gate still describes the ride, so their yes is pinned to the real route and fare.
  const mine = await call("uber_request", { quote_id: "q_1_abcdefgh" }, OMARI);
  assert.match(mine.use_target, /Victim Home.*Clinic.*\$14\.32/);
});

test("a quote id from one thread cannot overwrite another thread's quote row", async () => {
  db.recordUberQuote({ conversationId: OMARI, quoteId: "q_2_abcdefgh", productName: "UberX", fareCents: 1432, fareDisplay: "$14.32" });
  db.markUberRide("q_2_abcdefgh", { status: "accepted" });
  const before = db.getUberRide("q_2_abcdefgh");
  db.recordUberQuote({ conversationId: AMA, quoteId: "q_2_abcdefgh", productName: "UberX", fareCents: 1, fareDisplay: "$0.01" });
  const after = db.getUberRide("q_2_abcdefgh");
  assert.equal(after.conversation_id, OMARI);
  assert.equal(after.fare_display, "$14.32");
  assert.equal(after.status, before.status);
});

test("uber quote ids are not guessable from the clock and a product prefix", async () => {
  await connect(OMARI);
  const opts = await call("uber_options", {
    start_latitude: 40.7128, start_longitude: -74.006,
    end_latitude: 40.758, end_longitude: -73.9855,
  }, OMARI);
  const quoteId = opts.options[0].quote_id;
  assert.doesNotMatch(quoteId, /^q_\d{10,}_/, `quote id is clock-shaped: ${quoteId}`);
  assert.match(quoteId, /^q_[0-9a-f-]{32,}$/);
});
