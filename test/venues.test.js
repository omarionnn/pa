// Venue search: the tool, the provider, and the capability.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-venues-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.GOOGLE_PLACES_API_KEY = "test-key";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { venueStatus, venueProvider } = await import("../src/venues.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => { try { rmSync(dir, { recursive: true }); } catch {} });

function fakeProvider(places = null) {
  return venueProvider({
    apiKey: "test-key",
    base: "https://test.places",
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        places: places ?? [
          {
            id: "ChIJ1",
            displayName: { text: "Carbone" },
            formattedAddress: "181 Thompson St, New York, NY 10012",
            shortFormattedAddress: "181 Thompson St",
            primaryType: "italian_restaurant",
            primaryTypeDisplayName: { text: "Italian Restaurant" },
            types: ["italian_restaurant", "restaurant", "food"],
            rating: 4.6,
            userRatingCount: 3200,
            priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE",
            currentOpeningHours: { openNow: true },
            regularOpeningHours: {
              periods: [
                { open: { day: 1, hour: 17, minute: 0 }, close: { day: 1, hour: 23, minute: 0 } },
              ],
            },
            googleMapsUri: "https://maps.google.com/?cid=123",
            location: { latitude: 40.7268, longitude: -73.9997 },
          },
          {
            id: "ChIJ2",
            displayName: { text: "I Sodi" },
            formattedAddress: "105 Christopher St, New York, NY 10014",
            shortFormattedAddress: "105 Christopher St",
            primaryType: "italian_restaurant",
            primaryTypeDisplayName: { text: "Italian Restaurant" },
            rating: 4.7,
            userRatingCount: 1800,
            priceLevel: "PRICE_LEVEL_EXPENSIVE",
            currentOpeningHours: { openNow: false },
            googleMapsUri: "https://maps.google.com/?cid=456",
            location: { latitude: 40.7335, longitude: -74.0032 },
          },
        ],
      }),
    }),
  });
}

test("venueStatus reports connected when key is set", () => {
  const s = venueStatus({ apiKey: "test" });
  assert.equal(s.connected, true);
  assert.equal(s.provider, "google_places");
});

test("venueStatus reports not connected when key is empty", () => {
  const s = venueStatus({ apiKey: "" });
  assert.equal(s.connected, false);
  assert.ok(s.missing.includes("GOOGLE_PLACES_API_KEY"));
});

test("capabilitiesNow shows venue_search as live when key is set", () => {
  const caps = capabilitiesNow({});
  const v = caps.find(c => c.name === "venue_search");
  assert.ok(v);
  assert.equal(v.status, "live");
  assert.ok(v.what.includes("restaurant"));
});

test("venue_search tool returns structured places", async () => {
  const out = await runTool("venue_search", { query: "Italian restaurants West Village" }, { conversationId: C, venueProvider: fakeProvider() });
  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.places[0].name, "Carbone");
  assert.equal(out.places[0].rating, 4.6);
  assert.equal(out.places[0].price_level, "$$$$");
  assert.equal(out.places[0].open_now, true);
  assert.ok(out.places[0].maps_url.includes("maps.google"));
  assert.equal(out.places[1].name, "I Sodi");
  assert.equal(out.places[1].price_level, "$$$");
});

test("venue_search remembers Google Maps URLs as seen", async () => {
  const out = await runTool("venue_search", { query: "sushi" }, { conversationId: C, venueProvider: fakeProvider() });
  assert.equal(out.ok, true);
  assert.ok(db.hasSeenUrl(C, "https://maps.google.com/?cid=123"));
});

test("venue_search passes location bias when coordinates given", async () => {
  let captured;
  const provider = venueProvider({
    apiKey: "test-key",
    base: "https://test.places",
    fetchImpl: async (url, opts) => {
      captured = JSON.parse(opts.body);
      return {
        ok: true,
        text: async () => JSON.stringify({ places: [] }),
      };
    },
  });
  await runTool("venue_search", { query: "coffee", near_lat: 40.73, near_lng: -73.99 }, { conversationId: C, venueProvider: provider });
  assert.ok(captured.locationBias);
  assert.equal(captured.locationBias.circle.center.latitude, 40.73);
  assert.equal(captured.locationBias.circle.center.longitude, -73.99);
  assert.equal(captured.locationBias.circle.radius, 5000);
});

test("venue_search handles custom radius", async () => {
  let captured;
  const provider = venueProvider({
    apiKey: "test-key",
    base: "https://test.places",
    fetchImpl: async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, text: async () => JSON.stringify({ places: [] }) };
    },
  });
  await runTool("venue_search", { query: "gym", near_lat: 40.73, near_lng: -73.99, radius: 1000 }, { conversationId: C, venueProvider: provider });
  assert.equal(captured.locationBias.circle.radius, 1000);
});

test("provider builds correct request headers", async () => {
  let capturedHeaders;
  const provider = venueProvider({
    apiKey: "my-key",
    base: "https://test.places",
    fetchImpl: async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, text: async () => JSON.stringify({ places: [] }) };
    },
  });
  await provider.search("pizza");
  assert.equal(capturedHeaders["X-Goog-Api-Key"], "my-key");
  assert.ok(capturedHeaders["X-Goog-FieldMask"].includes("places.displayName"));
  assert.ok(capturedHeaders["X-Goog-FieldMask"].includes("places.rating"));
});

test("provider returns not_connected without a key", async () => {
  const provider = venueProvider({ apiKey: "" });
  const out = await provider.search("test");
  assert.equal(out.ok, false);
  assert.ok(out.missing?.includes("GOOGLE_PLACES_API_KEY"));
});

test("provider handles API errors gracefully", async () => {
  const provider = venueProvider({
    apiKey: "test-key",
    base: "https://test.places",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "API key not valid",
    }),
  });
  const out = await provider.search("sushi");
  assert.equal(out.ok, false);
  assert.ok(out.error.includes("403"));
});

test("provider formats hours correctly", async () => {
  const out = await runTool("venue_search", { query: "Italian" }, { conversationId: C, venueProvider: fakeProvider() });
  assert.ok(out.places[0].hours);
  assert.ok(out.places[0].hours.includes("Mon"));
  assert.ok(out.places[0].hours.includes("17:00"));
});
