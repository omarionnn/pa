// The plan meter on /ops (src/planmeter.js): the Cartesia plan's cycle, how much of it is used, the
// projection from the pace, and one text each at 50%, 80% and 100% per cycle — never twice, not
// after a restart, and again in the next cycle. The provider's figure when an admin key can read it,
// Reason's own count from its call rows always, and a provider that fails never breaks the pass.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-planmeter-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.CARTESIA_API_KEY = "sk_car_test_agent";
process.env.REASON_CARTESIA_AGENT_ID = "agent_test";
delete process.env.CARTESIA_ADMIN_API_KEY;
delete process.env.REASON_CARTESIA_PLAN_USD;
delete process.env.REASON_CARTESIA_RATE_USD_PER_MIN;
delete process.env.REASON_CARTESIA_CYCLE_DAY;

const pm = await import("../src/planmeter.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { metersSection } = await import("../src/pages/ops.js");

after(() => { try { db.db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

const C = "dm:owner";
const at = (s) => Date.parse(s);
const meter = pm.METERS.find(m => m.id === "cartesia");

/** A Cartesia call on the row, the way the relay leaves it: seconds, cents and whether it fell back. */
function call({ when, seconds, fellBack = false }) {
  const row = db.createCall(C, { provider: "gptlive", toNumber: "+15550000000", isOwner: true, goal: "Book the dentist", facts: [] });
  db.updateCall(C, row.id, { cartesia_seconds: seconds, cartesia_cents: Math.round(seconds / 60 * 3), cartesia_fell_back: fellBack ? 1 : 0 });
  db.db.prepare("UPDATE calls SET created_at = ? WHERE id = ?").run(when, row.id);
  return row;
}

beforeEach(() => {
  db.db.exec("DELETE FROM calls; DELETE FROM ops_state;");
  config.cartesiaAdminKey = "";
  config.cartesiaPlanUsd = 5;
  config.cartesiaRateUsdPerMin = 0.03;
  config.cartesiaCycleDay = 30;
});

// ---------- settings ----------

test("the settings default to the Pro plan: $5 of agent credit, 3¢ a minute, refreshing on the 30th", () => {
  assert.equal(config.cartesiaPlanUsd, 5);
  assert.equal(config.cartesiaRateUsdPerMin, 0.03);
  assert.equal(config.cartesiaCycleDay, 30);
  assert.equal(meter.allowanceCents, 500);
  assert.equal(meter.centsPerMinute, 3);
  assert.equal(config.cartesiaAdminKey, "", "the agent key cannot read usage: no provider figure without an admin key");
});

// ---------- the cycle ----------

test("the cycle runs from the 30th to the 30th, and on the refresh day itself the new one has begun", () => {
  const w = pm.cycleWindow(at("2026-11-13T16:00:00Z"), 30);
  assert.equal(w.startDay, "2026-10-30");
  assert.equal(w.endDay, "2026-11-30");
  const on = pm.cycleWindow(at("2026-11-30T00:00:00Z"), 30);
  assert.equal(on.startDay, "2026-11-30");
  assert.equal(on.endDay, "2026-12-30");
  const before = pm.cycleWindow(at("2026-11-29T23:59:59Z"), 30);
  assert.equal(before.startDay, "2026-10-30");
});

test("a refresh day past the end of a short month is that month's last day (February, a leap year, the 31st)", () => {
  assert.deepEqual([pm.cycleWindow(at("2027-02-15T12:00:00Z"), 30).startDay, pm.cycleWindow(at("2027-02-15T12:00:00Z"), 30).endDay], ["2027-01-30", "2027-02-28"]);
  assert.deepEqual([pm.cycleWindow(at("2027-02-28T00:00:00Z"), 30).startDay, pm.cycleWindow(at("2027-02-28T00:00:00Z"), 30).endDay], ["2027-02-28", "2027-03-30"]);
  assert.equal(pm.cycleWindow(at("2027-03-10T00:00:00Z"), 30).startDay, "2027-02-28");
  assert.equal(pm.cycleWindow(at("2028-02-29T08:00:00Z"), 30).startDay, "2028-02-29");
  assert.equal(pm.cycleWindow(at("2026-12-31T08:00:00Z"), 30).endDay, "2027-01-30", "across the year");
  const w31 = pm.cycleWindow(at("2026-11-15T00:00:00Z"), 31);
  assert.deepEqual([w31.startDay, w31.endDay], ["2026-10-31", "2026-11-30"]);
});

// ---------- the reading ----------

test("percentage, minutes left and the projection from the pace so far", () => {
  // Day 15 of a 31-day cycle, 2 dollars used: 40%, 100 of 166 minutes left, on pace for about $4.13.
  const now = at("2026-11-14T00:00:00Z");
  const r = pm.reading(meter, { now, own: { cents: 200, seconds: 4000, calls: 3, fellBack: 1 } });
  assert.equal(r.cycle.startDay, "2026-10-30");
  assert.equal(r.days_in_cycle, 31);
  assert.equal(r.day_of_cycle, 16);
  assert.equal(r.pct, 40);
  assert.equal(r.allowance_minutes, 167);
  assert.equal(r.left_minutes, 100);
  assert.equal(r.projected_cents, Math.round(200 * 31 / 15));
  assert.equal(r.runs_out_at, null, "on pace for 83%: it lasts until the refresh");
  assert.equal(r.source, "own");
  // Faster: $4 in 10 days runs out around day 12.5.
  const fast = pm.reading(meter, { now: at("2026-11-09T00:00:00Z"), own: { cents: 400, seconds: 8000, calls: 9 } });
  assert.equal(new Date(fast.runs_out_at).toISOString().slice(0, 10), "2026-11-11");
  assert.ok(fast.projected_pct > 100);
  const out = pm.reading(meter, { now, own: { cents: 520, seconds: 10400, calls: 20 } });
  assert.equal(out.out, true);
  assert.equal(out.left_minutes, 0);
});

test("own-count source: Reason's call rows this cycle, fall-backs counted, other cycles and other voices left out", () => {
  const now = at("2026-11-13T16:00:00Z");
  call({ when: at("2026-11-01T10:00:00Z"), seconds: 600 });
  call({ when: at("2026-11-12T10:00:00Z"), seconds: 2 , fellBack: true });
  call({ when: at("2026-10-29T10:00:00Z"), seconds: 6000 }); // last cycle
  db.createCall(C, { provider: "gptlive", toNumber: "+15550000001", isOwner: true, goal: "no cartesia", facts: [] });
  const r = pm.readMeter(meter, { now });
  assert.equal(r.source, "own");
  assert.equal(r.own.calls, 2);
  assert.equal(r.own.fell_back, 1);
  assert.equal(r.used_minutes, Math.round(602 / 60 * 10) / 10);
  assert.equal(r.used_cents, Math.round(602 / 60 * 3 * 100) / 100);
  assert.match(pm.detailOf(r), /Reason's estimate/);
  assert.match(pm.detailOf(r), /1 fell back to the old voice/);
});

test("the relay writes the Cartesia seconds on the call row when it ends and when it falls back", async () => {
  const { CartesiaAgentCall } = await import("../src/calls/cartesia.js");
  const row = db.createCall(C, { provider: "gptlive", toNumber: "+15550000002", isOwner: true, goal: "x", facts: [] });
  let t = 1_000_000;
  const relay = Object.create(CartesiaAgentCall.prototype);
  Object.assign(relay, { call: row, startedAt: t, now: () => t });
  t += 90_000;
  relay.noteMinutes(true);
  const got = db.db.prepare("SELECT cartesia_seconds AS s, cartesia_cents AS c, cartesia_fell_back AS f FROM calls WHERE id = ?").get(row.id);
  assert.deepEqual({ ...got }, { s: 90, c: 5, f: 1 });
  relay.noteMinutes(false, 120);
  assert.deepEqual({ ...db.db.prepare("SELECT cartesia_seconds AS s, cartesia_fell_back AS f FROM calls WHERE id = ?").get(row.id) }, { s: 120, f: 0 });
});

// ---------- Cartesia's own figure ----------

test("API source: with an admin key, Cartesia's figure is read-only GET /usage/agents, cached 15 minutes, and both are shown", async () => {
  config.cartesiaAdminKey = "sk_car_admin_test";
  const now = at("2026-11-13T16:00:00Z");
  call({ when: at("2026-11-02T10:00:00Z"), seconds: 1200 });
  const asks = [];
  const fetchImpl = async (url, init) => {
    asks.push({ url: String(url), method: init.method, auth: init.headers.Authorization, version: init.headers["Cartesia-Version"] });
    return { ok: true, status: 200, json: async () => ({ data: [{ start_ts: "2026-10-30T00:00:00.000Z", end_ts: "2026-11-14T00:00:00.000Z", cents: 410, minutes: 136.5, calls: 12 }] }) };
  };
  const all = await pm.readAll({ now, fetchImpl });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].method, "GET");
  assert.match(asks[0].url, /^https:\/\/api\.cartesia\.ai\/usage\/agents\?start_ts=2026-10-30T00%3A00%3A00\.000Z&end_ts=/);
  assert.equal(asks[0].auth, "Bearer sk_car_admin_test");
  assert.equal(asks[0].version, "2026-08-14");
  const r = all[0];
  assert.equal(r.source, "provider");
  assert.equal(r.used_cents, 410);
  assert.equal(r.used_minutes, 136.5);
  assert.equal(r.pct, 82);
  assert.equal(r.own.minutes, 20, "Reason's own count is kept beside it");
  assert.match(pm.detailOf(r), /Cartesia's figure/);
  // Ten minutes later: the cached figure, no second ask. Sixteen: asked again.
  await pm.readAll({ now: now + 10 * 60_000, fetchImpl });
  assert.equal(asks.length, 1);
  await pm.readAll({ now: now + 16 * 60_000, fetchImpl });
  assert.equal(asks.length, 2);
});

test("the API failing never breaks the pass: the last good figure stays with the error, or Reason's count stands alone", async () => {
  config.cartesiaAdminKey = "sk_car_admin_test";
  const now = at("2026-11-13T16:00:00Z");
  call({ when: at("2026-11-02T10:00:00Z"), seconds: 600 });
  const failing = async () => { throw new Error("connect ECONNREFUSED"); };
  const first = await pm.readAll({ now, fetchImpl: failing });
  assert.equal(first.length, 1);
  assert.equal(first[0].source, "own");
  assert.match(first[0].remote.error, /ECONNREFUSED/);
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ cents: 300, minutes: 100, calls: 4 }] }) });
  await pm.readAll({ now: now + 16 * 60_000, fetchImpl: ok });
  const later = await pm.readAll({ now: now + 32 * 60_000, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(later[0].source, "provider", "the last good figure is kept");
  assert.equal(later[0].used_cents, 300);
  assert.equal(later[0].remote.error, "HTTP 401");
  const garbage = await pm.readAll({ now: now + 48 * 60_000, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }) });
  assert.equal(garbage.length, 1);

  // And the whole ops pass, with that provider down, still runs and still has the row.
  const ops = await import("../src/ops.js");
  ops.serverStats.statfs = () => ({ blocks: 1000, bsize: 1e8, bavail: 500 });
  db.db.exec("DELETE FROM ops_state;");
  const report = await ops.runChecks({ probe: async () => ({ ok: true, status: 200 }), usageFetch: failing });
  const row = report.checks.find(c => c.id === "plan:cartesia");
  assert.ok(row, "the plan row is on the page");
  assert.equal(row.quiet, true, "texted by the meter, never by the five-minute pass");
  assert.equal(report.meters.length, 1);
});

// ---------- the texts ----------

function sendTo(list) { return (text, key) => { list.push({ text, key }); }; }

test("50%, 80% and 100% are each texted once per cycle, in plain words; a jump says only the highest", () => {
  const texts = [];
  const send = sendTo(texts);
  const now = at("2026-11-13T16:00:00Z");
  const read = (cents) => pm.reading(meter, { now, own: { cents, seconds: cents / 3 * 60, calls: 5 } });
  pm.warnings({ readings: [read(240)], send, now });
  assert.equal(texts.length, 0, "below 50% says nothing");
  pm.warnings({ readings: [read(260)], send, now });
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /^Cartesia: 50% of this month's \$5 call credit used \(87 of 167 minutes\)\. At this pace it /);
  assert.match(texts[0].text, /Calls fall back to the old voice when it does\.$/);
  assert.equal(texts[0].key, "ops:plan_warn:cartesia:2026-10-30:50");
  pm.warnings({ readings: [read(300)], send, now });
  assert.equal(texts.length, 1, "50% again: nothing new");
  pm.warnings({ readings: [read(410)], send, now });
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /^Cartesia: 80% of this month's \$5 call credit used \(137 of 167 minutes\)\. At this pace it runs out around the \d+(st|nd|rd|th)\. Calls fall back to the old voice when it does\.$/);
  pm.warnings({ readings: [read(505)], send, now });
  assert.equal(texts.length, 3);
  assert.equal(texts[2].text, "Cartesia: 100% of this month's $5 call credit used (168 of 167 minutes). Calls are falling back to the old voice until the credits refresh. Credits refresh on the 30th.");
  pm.warnings({ readings: [read(600)], send, now });
  assert.equal(texts.length, 3);

  // Straight from 30% to 90% in a new cycle: one text, the 80% one, and 50% is not sent after it.
  const dec = at("2026-12-05T12:00:00Z");
  const r = (cents) => pm.reading(meter, { now: dec, own: { cents, seconds: cents * 20, calls: 1 } });
  pm.warnings({ readings: [r(450)], send, now: dec });
  assert.equal(texts.length, 4);
  assert.match(texts[3].text, /^Cartesia: 80%/);
  assert.equal(texts[3].key, "ops:plan_warn:cartesia:2026-11-30:80");
  pm.warnings({ readings: [r(460)], send, now: dec });
  assert.equal(texts.length, 4);
});

test("a restart does not send again (what was sent is in the database), and a new cycle starts over", () => {
  const texts = [];
  const now = at("2026-11-13T16:00:00Z");
  const r = pm.reading(meter, { now, own: { cents: 260, seconds: 5200, calls: 3 } });
  pm.warnings({ readings: [r], send: sendTo(texts), now });
  assert.equal(texts.length, 1);
  // A restart: nothing in memory survives, the ops_state row does.
  const again = [];
  pm.warnings({ readings: [pm.reading(meter, { now: now + 60_000, own: { cents: 260, seconds: 5200, calls: 3 } })], send: sendTo(again), now: now + 60_000 });
  assert.equal(again.length, 0);
  assert.match(pm.warnedWords(meter, r), /^50% text sent Nov 13$/);
  // The next cycle, the same share: told again.
  const next = at("2026-12-20T12:00:00Z");
  pm.warnings({ readings: [pm.reading(meter, { now: next, own: { cents: 260, seconds: 5200, calls: 3 } })], send: sendTo(again), now: next });
  assert.equal(again.length, 1);
  // A reading from a cycle that has ended (an old saved report) is never texted.
  const stale = [];
  db.db.exec("DELETE FROM ops_state;");
  pm.warnings({ readings: [r], send: sendTo(stale), now: next });
  assert.equal(stale.length, 0);
});

test("the plan size is one setting: a $20 plan meters against $20", () => {
  config.cartesiaPlanUsd = 20;
  const r = pm.reading(meter, { now: at("2026-11-13T16:00:00Z"), own: { cents: 500, seconds: 10000, calls: 2 } });
  assert.equal(r.pct, 25);
  assert.equal(r.allowance_minutes, 667);
});

// ---------- the page ----------

test("the panel shows the cycle, minutes, dollars, the bar, minutes left, the projection and the fall-backs — numbers only", () => {
  const now = at("2026-11-13T16:00:00Z");
  call({ when: at("2026-11-02T10:00:00Z"), seconds: 3000, fellBack: false });
  call({ when: at("2026-11-03T10:00:00Z"), seconds: 1, fellBack: true });
  const r = pm.readMeter(meter, { now });
  const html = metersSection([r], now);
  assert.match(html, /Cartesia calls/);
  assert.match(html, /Oct 30 – Nov 30/);
  assert.match(html, /50 of 167 min · \$1\.50 of \$5\.00 · 30%/);
  assert.match(html, /class="pm ok"[^>]*><span style="width:30\.0%">/);
  assert.match(html, /116 min at \$0\.03\/min/);
  assert.match(html, /by the refresh/);
  assert.match(html, /1 call this cycle went to the old voice/);
  assert.match(html, /Reason&#39;s own estimate|Reason's own estimate/);
  assert.doesNotMatch(html, /\+1555|dentist|dm:owner|Omari/, "no numbers, names or call content");
  assert.equal(metersSection([], now), "");
  assert.equal(metersSection(undefined, now), "");
});
