// The status page showed Uber amber from 2026-11-10: "last call failed 40h ago: HTTP 302".
//
// Nothing had failed. The Uber connect check (src/uber.js `connectReady`) asks Uber's authorize
// page where it would send a person and reads the redirect itself (`redirect: "manual"`); a 302 is
// the answer, good or bad. The ledger counted it as a failed call because `res.ok` is false for a
// 3xx, and with nobody connected no good call ever came after it, so the row stayed amber.
//
// What has to stay true:
//   - a 3xx handed back to a caller that asked for it is a call that worked;
//   - a row already written down as "failed, HTTP 302" reads green, not amber, with no restart of
//     the ledger needed;
//   - a real refusal (403) is still red, and a real failure after a redirect still shows.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-opsredir-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SEARCH_PROVIDER = "parallel";
process.env.PARALLEL_API_KEY = "test-parallel";
process.env.OPENAI_API_KEY = "test-openai";
process.env.REASON_CALL_PROVIDER = "fake";
process.env.UBER_CLIENT_ID = "test-uber-id";
process.env.UBER_CLIENT_SECRET = "test-uber-secret";
delete process.env.UBER_AUTH_BASE;
delete process.env.UBER_API_BASE;

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const uber = await import("../src/uber.js");
const { clock } = await import("../src/config.js");

const OK = async () => ({ ok: true, status: 200 });
const runtime = { say: () => {}, interval: {}, lastSweepAt: clock.now(), on() {} };
const H = 60 * 60_000;
const uberRow = async () => (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "provider:uber");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  uber._resetReady();
  db.db.exec("DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM provider_calls; DELETE FROM provider_state;");
  runtime.lastSweepAt = clock.now();
});

test("the Uber connect check's 302 is counted as a call that worked, and the row is green", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://auth.uber.com/v2/?next_url=x" } });
  try {
    ops.watchFetch();
    const ready = await uber.connectReady();
    assert.deepEqual(ready, { ready: true, why: "" });
  } finally {
    ops.unwatchFetch();
    globalThis.fetch = before;
  }
  const st = db.providerState("uber");
  assert.ok(st.last_ok_at, "the redirect is the last good call");
  assert.equal(st.last_fail_at, null);
  assert.equal(st.last_error, "");
  const row = await uberRow();
  assert.equal(row.state, "ok");
  assert.match(row.detail, /^working · last call .* · 1 call today$/);
  assert.doesNotMatch(row.detail, /failed/);
});

test("a redirect already written down as a failure reads green, not 'last call failed: HTTP 302'", async () => {
  // The row as it stood on the live server on 2026-11-12.
  db.db.prepare("INSERT INTO provider_state (provider, last_ok_at, last_fail_at, last_status, last_error, last_ms) VALUES ('uber', NULL, ?, 302, 'HTTP 302', 80)")
    .run(clock.now() - 40 * H);
  const row = await uberRow();
  assert.equal(row.state, "ok");
  assert.match(row.detail, /^working · last call 40h ago · 0 calls today$/);
});

test("a real refusal from Uber is still red, and one after a redirect still shows", async () => {
  const before = globalThis.fetch;
  let status = 302;
  globalThis.fetch = async () => new Response(status === 302 ? null : "{}", { status, headers: status === 302 ? { location: "https://auth.uber.com/v2/" } : {} });
  try {
    ops.watchFetch();
    await fetch("https://auth.uber.com/oauth/v2/authorize?x=1", { redirect: "manual" });
    clock.skip(60_000);
    status = 403;
    await fetch("https://api.uber.com/v1.2/me");
  } finally {
    ops.unwatchFetch();
    globalThis.fetch = before;
  }
  const row = await uberRow();
  assert.equal(row.state, "bad");
  assert.match(row.detail, /last call failed .* key rejected \(HTTP 403\) · 2 calls today, 1 failed/);
});
