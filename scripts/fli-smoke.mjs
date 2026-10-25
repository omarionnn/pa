// The gated live smoke test for flight search. Run BY HAND after installing or upgrading Fli — never
// on a schedule, never in CI. It makes a few real Google Flights searches through the same sidecar
// Reason uses, and prints what came back, how long it took, and any refusal.
//
//   REASON_FLI_SMOKE=1 FLI_PYTHON=/home/reason/fli-venv/bin/python node scripts/fli-smoke.mjs [--save DIR] [--record]
//
// --record writes each outcome into the call ledger like a real search does, so /ops shows the
// smoke run as the last real search. Run it on the server with the service's env and data dir.
//
// About 9 page fetches in all: one one-way search (1), one round trip (1 + top_n 5 = 6), one family
// search (1) and one 30-day date sweep (1). --save writes each raw result as JSON, which is where
// the recorded fixtures under test/fixtures/fli/ come from.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { FliSidecar, FliError } from "../src/fli.js";

if (process.env.REASON_FLI_SMOKE !== "1") {
  console.error("Live Google traffic: set REASON_FLI_SMOKE=1 to run this on purpose.");
  process.exit(2);
}
const saveAt = process.argv.indexOf("--save");
const saveDir = saveAt > -1 ? process.argv[saveAt + 1] : null;
if (saveDir) mkdirSync(saveDir, { recursive: true });

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const record = process.argv.includes("--record");
// onOutcome undefined = the ledger writer Reason itself uses; null = nothing recorded.
const sidecar = new FliSidecar({ onOutcome: record ? undefined : null, log: (...a) => console.error("[fli]", ...a) });

const runs = [
  ["one-way-metro", "searchFlights", { origin: "JFK,EWR,LGA", destination: "LHR,LGW,STN", departure_date: day(30), currency: "USD", top_n: 5 }],
  ["round-trip", "searchFlights", { origin: "JFK", destination: "LAX", departure_date: day(30), return_date: day(35), max_stops: "NON_STOP", currency: "USD", top_n: 5 }],
  ["family", "searchFlights", { origin: "BOS", destination: "MCO", departure_date: day(40), adults: 2, children: 1, infants_on_lap: 1, currency: "USD", top_n: 5 }],
  ["date-sweep", "searchDates", { origin: "JFK", destination: "MIA", start_date: day(20), end_date: day(49), round_trip: true, trip_days: 5, currency: "USD" }],
];

const report = [];
const ping = await sidecar.call("ping");
console.log("fli version:", ping.fli_version);
for (const [name, op, params] of runs) {
  const t0 = Date.now();
  try {
    const r = await sidecar[op](params);
    const ms = Date.now() - t0;
    const prices = (r.itineraries || r.dates || []).map(x => x.price).filter(p => p != null);
    report.push({ name, ok: true, ms, count: r.count, fetches: r.fetches, low: prices.length ? Math.min(...prices) : null, currency: (r.itineraries || r.dates)?.[0]?.currency ?? null });
    if (saveDir) writeFileSync(path.join(saveDir, `${name}.json`), JSON.stringify({ params, result: r }, null, 1));
  } catch (e) {
    report.push({ name, ok: false, ms: Date.now() - t0, kind: e instanceof FliError ? e.kind : "internal", error: e.message });
  }
}
sidecar.stop();
console.log(JSON.stringify(report, null, 1));
