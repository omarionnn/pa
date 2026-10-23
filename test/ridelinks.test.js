// Every Uber ride link that leaves is today's (src/ridelinks.js). On 2026-10-23 "send it again" was
// answered by copying a link out of the thread verbatim — the very first one, built before that
// day's fixes — and it went out byte for byte. These pin that no ride link reaches the outbox in an
// old shape, wherever the words came from.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-ridelinks-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { freshRideLinks, readRideLink, setRideGeocoder } = await import("../src/ridelinks.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { config } = await import("../src/config.js");

const GEO = {
  "430 W 17th St, New York, NY": { lat: 40.7433148, lng: -74.0053556 },
  "3247 Bruner Ave, Bronx, NY": { lat: 40.8759189, lng: -73.8401355 },
};
before(() => { setRideGeocoder(async (q) => GEO[q] ?? null); config.uberClientId = "test-client"; });

// The exact link from outbox rows 1309 and 1313, sent at 18:42 and replayed at 19:27.
const STALE = "https://m.uber.com/looking?pickup=%7B%22addressLine1%22%3A%22430%20W%2017th%20St%2C%20New%20York%2C%20NY%22%7D&drop%5B0%5D=%7B%22addressLine1%22%3A%223247%20Bruner%20Ave%2C%20Bronx%2C%20NY%22%7D";

function isToday(url) {
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://m.uber.com/go/looking");
  assert.equal(u.searchParams.get("client_id"), "test-client");
  const p = JSON.parse(u.searchParams.get("pickup"));
  const d = JSON.parse(u.searchParams.get("drop[0]"));
  assert.deepEqual([p.latitude, p.longitude, p.addressLine1], [40.7433148, -74.0053556, "430 W 17th St, New York, NY"]);
  assert.deepEqual([d.latitude, d.longitude, d.addressLine1], [40.8759189, -73.8401355, "3247 Bruner Ave, Bronx, NY"]);
}

test("the stale link from the thread is rebuilt: /go/looking, client_id, coordinates on both ends", async () => {
  const out = await freshRideLinks(`same trip, here it is again:\n${STALE}`);
  assert.ok(out.startsWith("same trip, here it is again:\n"), "the words around it are kept");
  isToday(out.split("\n")[1]);
});

test("every shape a ride link has ever had is read back to the same trip", () => {
  const bracketed = "https://m.uber.com/looking?client_id=x&action=setPickup&pickup%5Blatitude%5D=40.7&pickup%5Blongitude%5D=-74&pickup%5Bformatted_address%5D=A&dropoff%5Bformatted_address%5D=B";
  assert.deepEqual(readRideLink(bracketed), { pickup_latitude: 40.7, pickup_longitude: -74, pickup_address: "A", address: "B" });
  assert.deepEqual(readRideLink(STALE), { pickup_address: "430 W 17th St, New York, NY", address: "3247 Bruner Ave, Bronx, NY" });
  assert.equal(readRideLink("https://m.uber.com/looking?client_id=x"), null);
});

test("a message with no ride link is untouched, and a link already current is left byte for byte", async () => {
  assert.equal(await freshRideLinks("see https://uber.com/careers and https://example.com"), "see https://uber.com/careers and https://example.com");
  const now = await freshRideLinks(STALE);
  assert.equal(await freshRideLinks(now), now);
});

test("through the real send path: a stale link handed to the outbox goes out as today's", async () => {
  const OWNER = "+12025551234";
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  const router = new Router({});
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  const r = await router.send({ channel: "fake", to: OWNER, text: STALE, conversationId: "dm:owner", toOwner: true });
  assert.equal(r.ok, true);
  const sent = fake.sent.at(-1).text;
  isToday(sent);
  const row = db.db.prepare("SELECT body FROM outbox ORDER BY id DESC LIMIT 1").get();
  isToday(row.body);
});
