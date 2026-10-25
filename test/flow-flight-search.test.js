// Flight search, read by the real model (the opt-in live lane). A handful of cases, because the
// intent is the model's and only a real model can show it reads it:
//
//   1. "nyc to london" becomes the metro airport lists, with the dates, and the reply is a short
//      "from $X" list with links — never "the cheapest flight".
//   2. "no layovers" is a refinement of THAT search: nonstop, with the route and dates kept.
//   3. "cheapest time to go … for 5 days" is one date sweep with trip_days 5 — not a loop of sweeps.
//   4. Google refusing is said as "couldn't check", never "no flights".
//
// No Google: the Fli sidecar is a fake on `rt.turnExtras.fli` answering from test/fixtures/fli/.
// Skipped with no model reachable.
//
//   REASON_BACKEND=claude-cli node --test test/flow-flight-search.test.js
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-flightsearch-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = process.env.REASON_PUBLIC_URL || "https://reason.example.test";

const { Runtime } = await import("../src/runtime.js");
const db = await import("../src/db.js");
const { FliError } = await import("../src/fli.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fli");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM flight_searches; DELETE FROM accounts; DELETE FROM conversations; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

function harness(answers) {
  const calls = [];
  const answer = async (op, p) => {
    calls.push({ op, params: p });
    const v = answers[op];
    if (v instanceof Error) throw v;
    return structuredClone(typeof v === "function" ? v(p) : v);
  };
  const rt = new Runtime({ log: () => {} });
  rt.turnExtras.fli = { searchFlights: (p) => answer("searchFlights", p), searchDates: (p) => answer("searchDates", p) };
  return { rt, calls };
}
const codes = (s) => String(s).split(",");

test(`nyc → london reads as metro airports, and "no layovers" refines that same search (${label})`, { skip }, async () => {
  const { rt, calls } = harness({ searchFlights: fixture("one-way.json") });
  const reply = String(await rt.inbound(C, "can you find me flights from nyc to london leaving nov 24, one way"));
  const first = calls.find(c => c.op === "searchFlights");
  assert.ok(first, `no flight search ran. it said: ${reply}`);
  for (const a of ["JFK", "EWR", "LGA"]) assert.ok(codes(first.params.origin).includes(a), `origin missing ${a}: ${first.params.origin}`);
  for (const a of ["LHR", "LGW"]) assert.ok(codes(first.params.destination).includes(a), `destination missing ${a}: ${first.params.destination}`);
  assert.match(first.params.departure_date, /-11-24$/);
  assert.match(reply, /\$\d/, `no prices in the reply: ${reply}`);
  assert.doesNotMatch(reply, /\bthe cheapest flight\b/i, `it claimed the cheapest flight: ${reply}`);
  assert.doesNotMatch(reply, /\b(i booked|booked it|i('ve| have) booked)\b/i);

  const n = calls.length;
  const again = String(await rt.inbound(C, "no layovers pls"));
  const second = calls.slice(n).find(c => c.op === "searchFlights");
  assert.ok(second, `the refinement didn't search again. it said: ${again}`);
  assert.equal(second.params.max_stops, "NON_STOP");
  assert.deepEqual(codes(second.params.origin).sort(), codes(first.params.origin).sort(), "the route was kept");
  assert.equal(second.params.departure_date, first.params.departure_date, "the date was kept");
});

test(`"cheapest time to go" is one sweep with the trip length (${label})`, { skip }, async () => {
  const { rt, calls } = harness({ searchDates: fixture("date-sweep.json"), searchFlights: fixture("round-trip.json") });
  const reply = String(await rt.inbound(C, "when's the cheapest time to fly jfk to miami in december? like a 5 day trip"));
  const sweeps = calls.filter(c => c.op === "searchDates");
  assert.equal(sweeps.length, 1, `expected exactly one sweep, got ${sweeps.length}. it said: ${reply}`);
  assert.equal(sweeps[0].params.trip_days, 5);
  assert.match(sweeps[0].params.start_date, /-12-0\d$|-11-\d\d$/);
  assert.match(reply, /\$223/, `the lowest date's price isn't in the reply: ${reply}`);
});

test(`Google refusing is "couldn't check", never "no flights" (${label})`, { skip }, async () => {
  const { rt, calls } = harness({ searchFlights: new FliError("blocked", "Google returned an RPC error [13] with no data") });
  const reply = String(await rt.inbound(C, "flights bos to chicago dec 3?"));
  assert.match(reply, /couldn'?t (check|get|reach|look)|can'?t (check|get) .*right now|not able to check/i, `it didn't say it couldn't check: ${reply}`);
  // "That doesn't mean there are no flights" is the right answer; only a bare claim of none is wrong.
  const claims = reply.replace(/(doesn'?t|does not|isn'?t|is not|not) (mean|saying|that) (that )?there (are|were)n?'?t? (no|any) flights/gi, "");
  assert.doesNotMatch(claims, /\bno flights\b|\bthere are none\b|nothing (is )?available/i, `it read a refusal as no flights: ${reply}`);
  assert.equal(calls.length, 1, `it searched again after being told Google refused: ${calls.length} searches`);
});
