// A read of one private Google Doc came back 404 not_found ("this account cannot see that file").
// The call ledger counted it as a failed Google call, the Google row went amber, and the owner got
// "1 thing needs you: Google … 3 of 551 failed" and then "back to normal". Google was fine and
// there was nothing to do.
//
// What has to stay true:
//   - a 404 on a GET of one Drive file / export / Docs document is a call that worked;
//   - any other Google 404 (a list, a write) still counts as failed;
//   - a 5xx, a 401/403 and a network error from Google still count, and still turn the row bad/amber.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-ops404-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Owner";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SEARCH_PROVIDER = "parallel";
process.env.PARALLEL_API_KEY = "test-parallel";
process.env.OPENAI_API_KEY = "test-openai";
process.env.REASON_CALL_PROVIDER = "fake";
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-secret";
delete process.env.GOOGLE_DRIVE_BASE;

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OK = async () => ({ ok: true, status: 200 });
const runtime = { say: () => {}, interval: {}, lastSweepAt: clock.now(), on() {} };
const googleRow = async () => (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "provider:google");
const NOT_FOUND = () => new Response(JSON.stringify({ error: { code: 404, message: "File not found: abc.", errors: [{ reason: "notFound" }] } }), { status: 404 });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM provider_calls; DELETE FROM provider_state;");
  runtime.lastSweepAt = clock.now();
});

/** Run `calls` through the watcher with `answer` standing in for Google. */
async function through(answer, calls) {
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => answer(input, init);
  try {
    ops.watchFetch();
    for (const [url, init] of calls) { try { await fetch(url, init); } catch { /* the error is the point */ } clock.skip(1000); }
  } finally {
    ops.unwatchFetch();
    globalThis.fetch = before;
  }
}

test("a 404 on reading one private Drive file or Doc is not a Google failure, and the row stays green", async () => {
  const base = config.googleDriveBase;
  await through(async (input) => String(input).includes("ok") ? new Response("{}", { status: 200 }) : NOT_FOUND(), [
    [`${base}/drive/v3/files?q=ok`],
    [`${base}/drive/v3/files/1AbCprivate?fields=id,name,mimeType`],
    [`${base}/drive/v3/files/1AbCprivate/export?mimeType=text/plain`],
    [`${base}/drive/v3/files/1AbCprivate?alt=media`, { method: "GET" }],
    ["https://docs.googleapis.com/v1/documents/1AbCprivate"],
  ]);
  const calls = db.providerCalls("google", accountsDay());
  assert.equal(calls.calls, 5);
  assert.equal(calls.failures, 0);
  const row = await googleRow();
  assert.equal(row.state, "ok");
  assert.doesNotMatch(row.detail, /failed/);
});

test("other Google 404s still count as failed", async () => {
  const base = config.googleDriveBase;
  await through(async () => NOT_FOUND(), [
    [`${base}/drive/v3/files?q=x`],
    [`${base}/drive/v3/files/abc`, { method: "PATCH", body: "{}" }],
    [`${base}/gmail/v1/users/me/messages/abc`],
  ]);
  assert.equal(db.providerCalls("google", accountsDay()).failures, 3);
  assert.notEqual((await googleRow()).state, "ok");
});

test("a 5xx, an auth refusal or a timeout from Google still counts, even on a single-file read", async () => {
  const base = config.googleDriveBase;
  for (const [answer, want] of [
    [async () => new Response("{}", { status: 503 }), "warn"],
    [async () => new Response("{}", { status: 500 }), "warn"],
    [async () => new Response("{}", { status: 401 }), "bad"],
    [async () => new Response("{}", { status: 403 }), "bad"],
    [async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, "warn"],
  ]) {
    db.db.exec("DELETE FROM provider_calls; DELETE FROM provider_state;");
    await through(answer, [[`${base}/drive/v3/files/1AbCprivate?fields=id`]]);
    assert.equal(db.providerCalls("google", accountsDay()).failures, 1, `counted: ${want}`);
    assert.equal((await googleRow()).state, want);
  }
});

test("isExpectedMiss only answers for Google, 404, GET and one item", () => {
  const u = "https://www.googleapis.com/drive/v3/files/abc";
  assert.equal(ops.isExpectedMiss("google", u, undefined, 404), true);
  assert.equal(ops.isExpectedMiss("google", new URL(u), { method: "get" }, 404), true);
  assert.equal(ops.isExpectedMiss("google", new Request(u), undefined, 404), true);
  assert.equal(ops.isExpectedMiss("google", u, { method: "DELETE" }, 404), false);
  assert.equal(ops.isExpectedMiss("google", u, undefined, 500), false);
  assert.equal(ops.isExpectedMiss("google", u, undefined, 403), false);
  assert.equal(ops.isExpectedMiss("github", "https://api.github.com/repos/a/b", undefined, 404), false);
  assert.equal(ops.isExpectedMiss("google", "https://www.googleapis.com/drive/v3/files", undefined, 404), false);
});

function accountsDay() {
  return db.db.prepare("SELECT day FROM provider_calls WHERE provider = 'google' ORDER BY day DESC LIMIT 1").get()?.day ?? "";
}
