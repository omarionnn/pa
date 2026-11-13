// When the nearby-places servers are down, nearby_places says so at once instead of spending a
// minute or two on them. Before: 2 servers, 3 tries of 8 s each, and the model called the tool
// again 2–4 times a turn, so a reply took 67–135 s and still had no places in it.
//
// Every fetch here is a stub (global fetch included), so nothing reaches the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-places-breaker-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const tools = await import("../src/tools.js");
const { clock } = await import("../src/config.js");
const C = "dm:owner";

// A server that never answers: the request only ends when its timeout aborts it.
const calls = [];
const hanging = async (url, opts = {}) => {
  calls.push(String(url));
  return new Promise((_, reject) => {
    opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
};
const refused = async (url) => { calls.push(String(url)); throw new Error("ECONNREFUSED"); };

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; clock.reset(); rmSync(dir, { recursive: true, force: true }); });

const nearby = (fetchImpl) => {
  globalThis.fetch = fetchImpl;
  return tools.runTool("nearby_places", { latitude: 40.7429, longitude: -74.0061, type: "cafe" }, { conversationId: C, kind: "user", fetchImpl });
};

test("every server hanging: nearby_places says it couldn't load places, in under 10 s", async () => {
  const t0 = Date.now();
  const out = await nearby(hanging);
  const took = Date.now() - t0;
  assert.ok(took < 10_000, `took ${took} ms`);
  assert.equal(out.ok, false);
  assert.equal(out.down, true);
  assert.match(out.error, /couldn't load nearby places/i);
  // The model is told not to go round again, and where to go instead.
  assert.match(out.next, /do not call nearby_places again/i);
  assert.match(out.next, /web_search/);
});

test("right after a failure, the next ask skips the servers and answers at once", async () => {
  calls.length = 0;
  const t0 = Date.now();
  const out = await nearby(hanging);
  const took = Date.now() - t0;
  assert.ok(took < 50, `took ${took} ms`);
  assert.equal(calls.length, 0, "no server was asked");
  assert.equal(out.ok, false);
  assert.equal(out.down, true);
  assert.match(out.error, /couldn't load nearby places/i);
});

test("a few minutes later it tries again, across all four servers", async () => {
  clock.skip(6 * 60_000);
  calls.length = 0;
  const out = await nearby(refused);
  assert.equal(out.down, true);
  assert.ok(new Set(calls).size >= 4, `servers tried: ${[...new Set(calls)].join(", ")}`);
});

test("a server that answers clears the way: places come back as before", async () => {
  clock.skip(6 * 60_000);
  const ok = async (url) => ({ ok: true, status: 200, json: async () => ({ elements: [{ lat: 40.74, lon: -74.0, tags: { name: "Joe Coffee", amenity: "cafe" } }] }) });
  const out = await nearby(ok);
  assert.equal(out.ok, true);
  assert.equal(out.results[0].name, "Joe Coffee");
});
