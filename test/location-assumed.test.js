// A place-dependent answer says where its position came from (src/whereabouts.js, 2026-11-14).
// A person asked for the weather "where I'm at" on a call and was given it for their work address,
// never told; a "nearest store" was answered from work after their shift had ended. The tools now put
// a note on their result (weather, nearby_places, directions) when the position is a saved place and
// there is no fresh location:
//   fresh location            -> no note, the result exactly as before
//   stale + a saved place     -> say which place was assumed and why, and send the card in the same reply
//   off shift (work)          -> ask in one short line instead, with the card
//   on a call                 -> say the assumption in a few words; the text after the call sends the card
// Fixture data only.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-whereabouts-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Pat";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const tools = await import("../src/tools.js");
const weather = await import("../src/weather.js");
const whereabouts = await import("../src/whereabouts.js");
const postcall = await import("../src/calls/postcall.js");

const C = config.ownerConversation;
const WORK = { name: "work", address: "1 Depot Way", lat: 40.7429, lng: -74.0061 };
const OPEN_METEO = {
  utc_offset_seconds: -18000,
  current: { time: "2026-11-10T13:00", temperature_2m: 59.4, apparent_temperature: 57.1, weather_code: 0, wind_speed_10m: 6.2, precipitation: 0 },
  daily: { temperature_2m_max: [62.2], temperature_2m_min: [48.9], precipitation_probability_max: [5], weather_code: [1] },
};
const ctx = (extra = {}) => ({ conversationId: C, kind: "user", fetchImpl: async () => ({ ok: true, json: async () => OPEN_METEO }), ...extra });
// Tuesday 2026-11-10, in New York.
const at = (hhmm) => Date.parse(`2026-11-10T${hhmm}:00-05:00`);

clock.set = (ms) => { clock.reset(); clock.skip(ms - clock.now()); };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  weather.resetWeatherState();
  db.db.exec("DELETE FROM saved_places; DELETE FROM person_facts; DELETE FROM people;");
  db.upsertThread({ conversationId: C, channel: "sendblue", address: "+12025551234", isOwner: true });
  db.db.prepare("UPDATE threads SET last_location = NULL, location_sharing_until = NULL WHERE conversation_id = ?").run(C);
  db.savePlace(C, WORK);
  db.remember(C, "Pat", "Works at the depot Mon-Fri 7am to 3pm");
});

test("a fresh location: no note, the result exactly as before", async () => {
  clock.set(at("13:00"));
  db.recordSharedLocation(C, { latitude: 40.75, longitude: -73.99, at: at("12:30") });
  const w = await tools.runTool("weather", { latitude: WORK.lat, longitude: WORK.lng }, ctx());
  assert.equal(w.ok, true);
  assert.equal(w.where_from, undefined);
  const byName = await tools.runTool("weather", { place: "work" }, ctx());
  assert.equal(byName.where_from, undefined);
  // A live share still running counts the same.
  db.db.prepare("UPDATE threads SET last_location = NULL, location_sharing_until = ? WHERE conversation_id = ?").run(at("14:00"), C);
  assert.equal((await tools.runTool("weather", { latitude: WORK.lat, longitude: WORK.lng }, ctx())).where_from, undefined);
});

test("no fresh location and a saved place: say which place and why, and send the card in the same reply", async () => {
  clock.set(at("13:00")); // on shift: work is a fair guess
  db.recordSharedLocation(C, { latitude: 40.75, longitude: -73.99, at: at("13:00") - 2 * 86_400_000 }); // two days old
  const w = await tools.runTool("weather", { latitude: WORK.lat + 0.001, longitude: WORK.lng }, ctx());
  assert.equal(w.ok, true);
  assert.match(w.where_from, /no live or recent location/);
  assert.match(w.where_from, /saved place "work"/);
  assert.match(w.where_from, /first sentence that you went by "work" and why/);
  assert.match(w.where_from, /get_location with action 'request' in this same turn/);
  assert.equal(Object.keys(w)[0], "where_from", "read before the answer");
  // The same by the saved place's name.
  assert.match((await tools.runTool("weather", { place: "work" }, ctx())).where_from, /went by "work"/);
});

test("off shift: work is not where they are, so it asks in one short line, with the card", async () => {
  clock.set(at("18:40"));
  const w = await tools.runTool("weather", { latitude: WORK.lat, longitude: WORK.lng }, ctx());
  assert.match(w.where_from, /their shift, as they told you, 7am to 3pm on weekdays, and it is 6:40pm there now, so they are probably not at "work"/);
  assert.match(w.where_from, /Do not answer from it: ask in one short line where they are, and call get_location with action 'request'/);
  assert.doesNotMatch(w.where_from, /went by/);
  // A Saturday at noon is off too.
  clock.set(Date.parse("2026-11-14T12:00:00-05:00"));
  assert.match((await tools.runTool("weather", { place: "work" }, ctx())).where_from, /probably not at "work"/);
});

test("on a call: the assumption said in a few words, no card mid-call; the text after the call sends it", async () => {
  clock.set(at("13:00"));
  const w = await tools.runTool("weather", { latitude: WORK.lat, longitude: WORK.lng }, ctx({ onCall: 4242 }));
  assert.match(w.where_from, /Say the assumption in a few words as you answer \("going by your work address…"\)/);
  assert.match(w.where_from, /No card can be shown on a call/);
  assert.doesNotMatch(w.where_from, /action 'request'/);
  assert.equal(whereabouts.assumedOnCall(4242), "work");
  const after = postcall.ownerEvent({ row: { id: 4242, conversation_id: C, duration_s: 60, recording_state: "stored", provider: "cartesia" } });
  assert.match(after, /went by their saved place "work" for where they were/);
  assert.match(after, /get_location with action 'request' to send the Share My Location card/);
  // A call that assumed nothing owes no card.
  assert.doesNotMatch(postcall.ownerEvent({ row: { id: 4343, conversation_id: C, duration_s: 60, recording_state: "stored", provider: "cartesia" } }), /Share My Location/);
});

test("coordinates that are neither shared nor saved: never answered as where they are", () => {
  clock.set(at("13:00"));
  const note = whereabouts.whereNote(C, { latitude: 41.9, longitude: -87.6 });
  assert.match(note, /not a position they shared or a place they saved/);
  assert.match(note, /Never guess coordinates/);
  assert.equal(whereabouts.whereNote(C, {}), "", "nothing given: nothing to say");
  assert.equal(whereabouts.whereNote(C, { place: "5th and Main" }), "", "a place they named themselves is their word");
  // Off shift on a call: asked out loud, nothing assumed, no card owed after.
  clock.set(at("18:40"));
  assert.match(whereabouts.whereNote(C, { place: "work" }, { onCall: 5151 }), /ask them in a few words where they are/);
  assert.equal(whereabouts.assumedOnCall(5151), "");
});

test("shift hours read from a saved fact", () => {
  db.db.exec("DELETE FROM person_facts;");
  assert.equal(whereabouts.shiftOf(C), null);
  db.remember(C, "Pat", "Shift is 9-5 at the clinic");
  const s = whereabouts.shiftOf(C);
  assert.deepEqual({ from: s.from, to: s.to, weekdays: s.weekdays }, { from: 540, to: 1020, weekdays: false });
});
