// Saved places: home, work, gym — and the commute queries the sweep uses.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-places-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const C = "dm:places";

db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => clock.reset());

// ---------- savePlace / getPlace ----------

test("savePlace stores and getPlace retrieves", () => {
  const saved = db.savePlace(C, { name: "home", address: "42 Broadway, New York", lat: 40.7128, lng: -74.006 });
  assert.equal(saved.ok, true);
  assert.equal(saved.name, "home");

  const got = db.getPlace(C, "home");
  assert.ok(got);
  assert.equal(got.name, "home");
  assert.equal(got.name_key, "home");
  assert.equal(got.address, "42 Broadway, New York");
  assert.ok(Math.abs(got.lat - 40.7128) < 0.001);
});

test("savePlace updates on duplicate name", () => {
  db.savePlace(C, { name: "gym", address: "100 First Ave", lat: 40.72, lng: -73.98 });
  db.savePlace(C, { name: "gym", address: "200 Second Ave", lat: 40.73, lng: -73.99 });

  const got = db.getPlace(C, "gym");
  assert.equal(got.address, "200 Second Ave");
});

test("name key is case-insensitive", () => {
  db.savePlace(C, { name: "Work", address: "10 Hudson Yards", lat: 40.75, lng: -74.00 });
  const got = db.getPlace(C, "work");
  assert.ok(got);
  assert.equal(got.name, "Work");
});

test("savePlace with commute data", () => {
  const saved = db.savePlace(C, {
    name: "office", address: "1 Wall St", lat: 40.707, lng: -74.011,
    arriveBy: 540, days: "MTWTF..", mode: "transit", travelMinutes: 45,
    routeDescription: "2 train from Allerton to Chambers",
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.mode, "transit");
  assert.equal(saved.travel_minutes, 45);

  const got = db.getPlace(C, "office");
  assert.equal(got.arrive_by, 540);
  assert.equal(got.days, "MTWTF..");
  assert.equal(got.mode, "transit");
  assert.equal(got.travel_minutes, 45);
  assert.equal(got.route_description, "2 train from Allerton to Chambers");
});

// ---------- listPlaces ----------

test("listPlaces returns all saved places", () => {
  const c2 = "dm:places-list";
  db.upsertAccount({ conversationId: c2, channel: "test", address: "+15559990001", name: "List", isOperator: false });

  db.savePlace(c2, { name: "home", address: "1 Main St", lat: 40.0, lng: -74.0 });
  db.savePlace(c2, { name: "work", address: "2 Office Dr", lat: 40.1, lng: -74.1 });
  db.savePlace(c2, { name: "gym", address: "3 Fitness Ln", lat: 40.2, lng: -74.2 });

  const list = db.listPlaces(c2);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(p => p.name_key), ["gym", "home", "work"]);
});

// ---------- deletePlace ----------

test("deletePlace removes a place", () => {
  const c3 = "dm:places-delete";
  db.upsertAccount({ conversationId: c3, channel: "test", address: "+15559990002", name: "Del", isOperator: false });

  db.savePlace(c3, { name: "old office", address: "1 Old St", lat: 40.0, lng: -74.0 });
  assert.ok(db.getPlace(c3, "old office"));

  const ok = db.deletePlace(c3, "old office");
  assert.equal(ok, true);
  assert.equal(db.getPlace(c3, "old office"), null);
});

test("deletePlace returns false for nonexistent", () => {
  assert.equal(db.deletePlace(C, "moon base"), false);
});

// ---------- placesWithCommute ----------

test("placesWithCommute only returns places with arrive_by", () => {
  const c4 = "dm:places-commute";
  db.upsertAccount({ conversationId: c4, channel: "test", address: "+15559990003", name: "Comm", isOperator: false });

  db.savePlace(c4, { name: "home", address: "1 Home St", lat: 40.0, lng: -74.0 });
  db.savePlace(c4, { name: "work", address: "2 Work Dr", lat: 40.1, lng: -74.1, arriveBy: 540, mode: "drive" });
  db.savePlace(c4, { name: "school", address: "3 School Ave", lat: 40.2, lng: -74.2, arriveBy: 480, mode: "transit", travelMinutes: 30 });

  const commutes = db.placesWithCommute(c4);
  assert.equal(commutes.length, 2);
  assert.ok(commutes.every(p => p.arrive_by != null));
});

// ---------- getHome uses saved_places ----------

test("getHome reads from saved_places, not the old columns", () => {
  const c5 = "dm:places-home";
  db.upsertAccount({ conversationId: c5, channel: "test", address: "+15559990004", name: "Home", isOperator: false });

  assert.equal(db.getHome(c5), null, "no home yet");

  db.savePlace(c5, { name: "home", address: "15 Cantonments Rd, Accra", lat: 5.556, lng: -0.187 });
  const home = db.getHome(c5);
  assert.ok(home);
  assert.ok(Math.abs(home.lat - 5.556) < 0.01);
});

// ---------- isolation between conversations ----------

test("places are isolated between conversations", () => {
  const c6 = "dm:places-iso-a";
  const c7 = "dm:places-iso-b";
  db.upsertAccount({ conversationId: c6, channel: "test", address: "+15559990005", name: "A", isOperator: false });
  db.upsertAccount({ conversationId: c7, channel: "test", address: "+15559990006", name: "B", isOperator: false });

  db.savePlace(c6, { name: "home", address: "Place A", lat: 40.0, lng: -74.0 });
  db.savePlace(c7, { name: "home", address: "Place B", lat: 41.0, lng: -73.0 });

  const a = db.getPlace(c6, "home");
  const b = db.getPlace(c7, "home");
  assert.equal(a.address, "Place A");
  assert.equal(b.address, "Place B");
});

// ---------- edge cases ----------

test("savePlace refuses empty name", () => {
  const result = db.savePlace(C, { name: "", address: "1 Main St", lat: 40.0, lng: -74.0 });
  assert.equal(result, null);
});

test("savePlace refuses invalid coordinates", () => {
  const result = db.savePlace(C, { name: "x", address: "1 Main St", lat: NaN, lng: -74.0 });
  assert.equal(result, null);
});
