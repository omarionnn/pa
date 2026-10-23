// Where they are, when a task needs it. A location they sent in a message is kept and still known on a
// later turn; get_location answers with the best it has — a live share, else that last location with
// its age, else nothing — and sends a Share My Location card only when asked to.
//
// 2026-10-16: a pin found cafés at 23:24; at 23:44 get_location said "not sharing", because it only
// asked Sendblue's live-location API, which 422s on a shared line, and nothing kept the pin.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-location-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const C = "dm:owner";
const noGeo = async () => null;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM conversations;");
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = "secret"; config.sendblueWebhookSecretHeader = "sb-signing-secret";
});

/** A channel that can say whether there is a live share, and records any card it is asked to send. */
function fakeChannel({ live = null, readFails = false } = {}) {
  const asked = [];
  return {
    asked,
    get: () => ({
      readLocation: async () => readFails
        ? { ok: false, supported: true, http_status: 422, error: "Location sharing is not supported on shared lines." }
        : live ? { ok: true, sharing: true, ...live } : { ok: true, sharing: false },
      requestLocation: async ({ number }) => { asked.push(number); return { ok: true }; },
    }),
  };
}

function ownerThread() {
  db.upsertThread({ conversationId: C, channel: "sendblue", address: OWNER, chatId: null, isOwner: true });
}

test("a pin that arrives on the webhook is kept on the thread", async () => {
  const turns = [];
  const router = new Router({ runtime: new Runtime({ runTurn: async (t) => { turns.push(t); return "ok"; } }) });
  router.register(new SendblueChannel({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); }; // describe() reverse-geocodes; no network here
  try {
    const out = await router.webhook({
      channel: "sendblue",
      headers: { "sb-signing-secret": "secret", "content-type": "application/json" },
      rawBody: JSON.stringify({
        content: "", message_type: "location", message_handle: "LOC-1", number: OWNER, from_number: OWNER,
        to_number: LINE, is_outbound: false, status: "RECEIVED",
        location: { latitude: 40.7432, longitude: -74.006, accuracy: 12.5, duration: "1 hour" },
      }),
    });
    assert.equal(out.status, 200);
  } finally { globalThis.fetch = realFetch; }
  const kept = db.lastSharedLocation(C);
  assert.equal(kept.latitude, 40.7432);
  assert.equal(kept.longitude, -74.006);
  assert.equal(kept.duration, "1 hour");
  assert.match(turns[0]?.text ?? "", /they shared their location/, "the turn still reads the share as before");
});

test("twenty minutes later, with the live read refused on a shared line, the pin is still where they are", async () => {
  ownerThread();
  db.recordSharedLocation(C, { latitude: 40.7432, longitude: -74.006, accuracy: 12, at: clock.now() });
  clock.skip(20 * 60_000);
  const channels = fakeChannel({ readFails: true });
  const r = await runTool("get_location", { action: "read" }, { conversationId: C, messages: [], channels, reverseGeocode: noGeo });
  assert.equal(r.ok, true);
  assert.equal(r.source, "sent_in_a_message");
  assert.equal(r.latitude, 40.7432);
  assert.equal(r.minutes_ago, 20);
  assert.match(r.note, /not a live position/);
  assert.deepEqual(channels.asked, [], "nothing is sent to them for a read");
});

test("a live share wins over an older pin", async () => {
  ownerThread();
  db.recordSharedLocation(C, { latitude: 1, longitude: 2, at: clock.now() - 60_000 });
  const channels = fakeChannel({ live: { latitude: 40.75, longitude: -73.98, accuracy: 5, address: "Midtown" } });
  const r = await runTool("get_location", {}, { conversationId: C, messages: [], channels, reverseGeocode: noGeo });
  assert.equal(r.source, "live");
  assert.equal(r.latitude, 40.75);
});

test("nothing known: auto says so and sends NO card; request sends the card", async () => {
  ownerThread();
  const channels = fakeChannel();
  const r = await runTool("get_location", {}, { conversationId: C, messages: [], channels, reverseGeocode: noGeo });
  assert.equal(r.source, "none");
  assert.match(r.note, /ask them in one short line/);
  assert.deepEqual(channels.asked, [], "checking is not asking — the card goes only when Reason decides to ask");

  const req = await runTool("get_location", { action: "request" }, { conversationId: C, messages: [], channels, reverseGeocode: noGeo });
  assert.equal(req.requested, true);
  assert.deepEqual(channels.asked, [OWNER]);
});

test("a pin over a day old is not offered as where they are", async () => {
  ownerThread();
  db.recordSharedLocation(C, { latitude: 40.7, longitude: -74, at: clock.now() - 25 * 60 * 60_000 });
  const r = await runTool("get_location", { action: "read" }, { conversationId: C, messages: [], channels: fakeChannel(), reverseGeocode: noGeo });
  assert.equal(r.source, "none");
});

test("no channel on this turn still answers from the kept pin", async () => {
  ownerThread();
  db.recordSharedLocation(C, { latitude: 40.7432, longitude: -74.006, at: clock.now() - 5 * 60_000 });
  const r = await runTool("get_location", {}, { conversationId: C, messages: [], reverseGeocode: noGeo });
  assert.equal(r.source, "sent_in_a_message");
  assert.equal(r.minutes_ago, 5);
});
