// The call's record of its lookups (src/calls/lookuprecord.js), after call 119 (2026-11-15): every
// result kept compact with the fields a later turn needs, a budget that trims low-value fields and
// trailing unspoken results but never the spoken one, the weather in their unit with its name, the
// retract rule in the brain's frame in classic and current modes, and the after-call text's rule.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-lookuprecord-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Pat";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const rec = await import("../src/calls/lookuprecord.js");
const weather = await import("../src/weather.js");
const voice = await import("../src/calls/voice.js");
const postcall = await import("../src/calls/postcall.js");
const tools = await import("../src/tools.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const C = config.ownerConversation;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM threads; DELETE FROM accounts; DELETE FROM saved_places;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Pat", isOperator: true });
  await voice.prime();
});

const place = (i, extra = {}) => ({
  name: `Shop Number ${i}`, address: `${100 + i} Main St`, city: "New York", full_address: `${100 + i} Main St, New York, NY 10001, USA`,
  opening_hours: "Monday: 9:00 AM – 9:00 PM; Tuesday: 9:00 AM – 9:00 PM; Wednesday: 9:00 AM – 9:00 PM; Thursday: 9:00 AM – 9:00 PM; Friday: 9:00 AM – 9:00 PM; Saturday: 9:00 AM – 9:00 PM; Sunday: 10:00 AM – 7:00 PM",
  website: `https://shop-number-${i}.example/locations/new-york/main-street/store-details-page`, rating: 4.4, rating_count: 120, type: "store",
  phone: `+1 212-555-01${String(i).padStart(2, "0")}`, google_maps_url: `https://maps.google.com/?cid=${i}${i}${i}${i}`, distance_m: 100 * i, open_now: true, ...extra,
});

test("budget: over it, low-value fields go, then trailing unspoken results; the spoken one is whole even near the end", () => {
  const out = { ok: true, results: Array.from({ length: 15 }, (_, i) => place(i + 1)) };
  const e = rec.lookupEntry({ name: "nearby_places", input: { type: "shop" }, out, turn: 0 });
  assert.ok(JSON.stringify(e).length < rec.STORE_BUDGET + 2_500, "the stored entry is bounded");
  const said = "Shop Number 14 at 114 Main St is open now.";
  const lines = rec.recordLines(e, { said });
  const shown = lines.join("\n");
  const spoken = lines.find(l => /Shop Number 14 \|/.test(l));
  assert.ok(spoken, "the spoken result is shown");
  for (const f of ["114 Main St, New York, NY 10001, USA", "1.4 km", "open now", "+1 212-555-0114", "https://maps.google.com/?cid=14141414"]) assert.ok(spoken.includes(f), `the spoken result keeps ${f}`);
  assert.match(spoken, /← the one you said/);
  assert.doesNotMatch(shown, /shop-number-\d+\.example/, "websites (low value) went first");
  assert.match(shown, /\+\d+ more results? not shown; run the lookup again/);
  assert.ok(shown.length < rec.SHOW_BUDGET + 900, `bounded (${shown.length})`);
  assert.match(lines[1], /1\. Shop Number 1 \|/, "results kept in the tool's own order");
});

test("a small lookup is shown whole; an old-format entry still reads", () => {
  const e = rec.lookupEntry({ name: "nearby_places", input: {}, out: { ok: true, results: [place(1), place(2)] } });
  const shown = rec.recordLines(e).join("\n");
  assert.match(shown, /shop-number-1\.example/);
  assert.match(shown, /2\. Shop Number 2/);
  assert.deepEqual(rec.recordLines({ at: clock.now(), name: "web_search", input: "{}", ok: true, got: "{\"ok\":true}" }).length, 1);
});

test("other tools: a compact structured summary, never a blind character cut", () => {
  const out = { ok: true, query: "gold price today", results: [{ title: "Gold price | Kitco", url: "https://kitco.example", text: "x".repeat(2000) }, { title: "Gold | Reuters", url: "https://reuters.example", text: "y".repeat(2000) }] };
  const e = rec.lookupEntry({ name: "web_search", input: { query: "gold" }, out });
  const shown = rec.recordLines(e).join("\n");
  assert.match(shown, /Gold price \| Kitco/);
  assert.match(shown, /Gold \| Reuters/, "the second result is there too");
  assert.ok(shown.length < 1_200);
  assert.match(rec.recordLines(rec.lookupEntry({ name: "x", out: { ok: false, error: "the service answered 503" } }))[0], /error: the service answered 503/);
});

const OM = { utc_offset_seconds: -18000, current: { time: "2026-11-15T13:00", temperature_2m: 43.2, apparent_temperature: 39.6, weather_code: 0, wind_speed_10m: 6, precipitation: 0 }, daily: { temperature_2m_max: [48], temperature_2m_min: [37.4], precipitation_probability_max: [10], weather_code: [1] } };
const fx = async () => ({ ok: true, json: async () => OM });

test("weather unit: a US caller gets Fahrenheit only, named; elsewhere Celsius; the record names it too", async () => {
  assert.equal(weather.unitForZone("America/New_York"), "F");
  assert.equal(weather.unitForZone("America/Toronto"), "C");
  assert.equal(weather.unitForZone("Europe/London"), "C");
  assert.equal(weather.unitForZone(""), "F");
  db.upsertThread({ conversationId: C, channel: "sendblue", address: "+12025551234", isOwner: true });
  const w = await tools.runTool("weather", { latitude: 40.74, longitude: -74 }, { conversationId: C, kind: "user", fetchImpl: fx });
  assert.equal(w.temperature_unit, "F");
  assert.equal(w.now.temp_f, 43);
  assert.equal(w.now.temp_c, undefined, "no Celsius figure to pick by mistake");
  assert.equal(w.today.high_c, undefined);
  assert.equal(w.say.now, "43°F");
  assert.match(w.note, /"43 degrees Fahrenheit" out loud on a call, "43°F" in a text\. Never a bare number/);
  const line = rec.recordLines(rec.lookupEntry({ name: "weather", input: {}, out: w })).join("\n");
  assert.match(line, /now 43°F \(degrees Fahrenheit\)/);
  assert.match(line, /today high 48°F, low 37°F/);
  assert.doesNotMatch(line, /°C/);
  const uk = weather.inTheirUnit(await weather.weatherAt(51.5, -0.1, { fetchImpl: fx }), "C");
  assert.equal(uk.now.temp_c, 6);
  assert.equal(uk.now.temp_f, undefined);
  assert.match(uk.note, /"6 degrees Celsius" out loud/);
  assert.match(rec.recordLines(rec.lookupEntry({ name: "weather", out: uk })).join(" "), /now 6°C \(degrees Celsius\)/);
});

test("the retract rule is in the brain's call frame in classic and current modes, and in the after-call text's event", () => {
  const call = db.createCall(C, { provider: "cartesia", toNumber: "+12025551234", isOwner: true, goal: "Pat called Reason", facts: [], direction: "in", externalId: "c_x", state: "in_progress" });
  const was = config.callFeel;
  try {
    for (const feel of ["classic", "current"]) {
      config.callFeel = feel;
      assert.ok(voice.ownerContext({ call }).system.includes(rec.CALL_RECORD_FRAME), feel);
    }
  } finally { config.callFeel = was; }
  const ev = postcall.ownerEvent({ row: { id: call.id, conversation_id: C, duration_s: 60, recording_state: "stored", provider: "cartesia" } });
  assert.match(ev, /Never contradict or "correct" what you said on the call unless a tool result you have in hand now says otherwise/);
});

test("after the call, the thread note carries what each lookup returned", () => {
  const call = db.createCall(C, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "x", facts: [], direction: "in", externalId: "c_y", state: "in_progress" });
  db.addCallLookup(C, call.id, rec.lookupEntry({ name: "nearby_places", input: { type: "shop" }, out: { ok: true, results: [place(1), place(2)] } }));
  postcall.writeCallIntoThread({ row: { ...db.getCall(C, call.id), state: "completed" }, live: { turns: [{ who: "them", text: "nearest shop?" }, { who: "agent", text: "Shop Number 2 on Main." }] } });
  const note = db.loadConversation(C).map(m => String(m.content)).find(t => /lookups you really ran on it/.test(t));
  assert.match(note, /2\. Shop Number 2 \| 102 Main St/);
  assert.match(note, /do not contradict it without a new tool result/);
});

test("the whole record is bounded: older lookups past the total show only their head and what was spoken", () => {
  const big = { ok: true, results: Array.from({ length: 12 }, (_, i) => place(i + 1)) };
  const lookups = Array.from({ length: 20 }, (_, k) => rec.lookupEntry({ name: "nearby_places", input: { k }, out: big, turn: k }));
  const answers = Array.from({ length: 20 }, (_, k) => ({ role: "assistant", content: `Shop Number ${(k % 12) + 1} is the one.` }));
  const msgs = [{ role: "user", content: "and now?" }];
  const text = rec.withCallRecord(msgs, lookups, { callMessages: answers }).at(-1).content[0].text;
  assert.ok(text.length < rec.TOTAL_BUDGET + 20 * 600, `bounded (${text.length})`);
  for (let k = 0; k < 20; k++) assert.match(text, new RegExp(`${(k % 12) + 1}\\. Shop Number ${(k % 12) + 1} \\|[^\\n]*← the one you said`), `lookup ${k}: the spoken result is always there`);
});
