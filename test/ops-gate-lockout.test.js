// Audit lead 23 (2026-11-07): a stranger with no key and no cookie could keep both /ops sign-in
// methods refusing the owner's right code and right password. Wrong codes were counted under the
// one shared page id "ops" from any request, and wrong passwords under the one shared "ops:pw"
// total; both limits are checked before the credential is compared, so five junk codes and thirty
// junk passwords per fifteen minutes answered 429 to everyone.
//
// What has to stay true:
//
//   - **a code is only taken from a request carrying the owner's key**, the same key that sends
//     one. The form posts back to the keyed address, so the owner's browser always has it. A
//     keyless code is refused without being counted, so nobody can spend the owner's five tries.
//   - **the owner's keyed link is never locked out of the password** by other people's wrong
//     guesses (the key already opens the page through a code).
//   - **without the key the shared password cap still holds**: it is what bounds a guesser who
//     forges the address header.
//
// The hash here is a throwaway made in this file.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-opslockout-"));
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
delete process.env.REASON_OPS_URL;
delete process.env.REASON_OPS_PASSWORD_HASH;

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const opspw = await import("../src/opspassword.js");
const { MAX_FAILED_ATTEMPTS } = await import("../src/pages/access.js");
const { opsRequest } = await import("../src/http.js");
const { clock, config } = await import("../src/config.js");

const PASSWORD = "right-pw for the lockout test";
const salt = randomBytes(16);
const HASH = `scrypt:${salt.toString("hex")}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;

const sent = [];
const runtime = { say: (c, text) => { sent.push({ c, text }); return text; }, interval: {}, lastSweepAt: clock.now(), on() {} };
const log = () => {};

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  sent.length = 0;
  config.opsPasswordHash = HASH;
  db.db.exec(`DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM page_attempts;`);
});

const GET = ({ key = null, via = null } = {}) =>
  opsRequest({ key, via, method: "GET", headers: {}, readBody: async () => "", runtime, log });
const POST = (body, { headers = {}, key = null, via = null } = {}) =>
  opsRequest({ key, via, method: "POST", headers, readBody: async () => body, runtime, log });
const pw = (p) => `username=Reason+status&password=${encodeURIComponent(p)}`;

test("a stranger's junk codes, with no key, cannot lock the owner out of the right code", async () => {
  for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++) {
    const out = await POST("code=000000", { via: "code" });
    assert.notEqual(out.status, 303);
    assert.equal(out.headers["Set-Cookie"], undefined);
  }
  assert.equal(db.failedPageAttempts("ops", opspw.WINDOW_MS), 0, "a keyless code is not counted against the owner");

  await POST("send=1", { key: ops.opsKey(), via: "code" });
  const code = /code is ([0-9]{6}),/.exec(sent[0].text)[1];
  const opened = await POST(`code=${code}`, { key: ops.opsKey(), via: "code" });
  assert.equal(opened.status, 303, "the owner's right code still opens the page");
  assert.match(opened.headers["Set-Cookie"], /^reason_page=/);
});

test("a keyless right code opens nothing either: a code is only taken with the key", async () => {
  await POST("send=1", { key: ops.opsKey(), via: "code" });
  const code = /code is ([0-9]{6}),/.exec(sent[0].text)[1];
  const out = await POST(`code=${code}`, { via: "code" });
  assert.equal(out.headers["Set-Cookie"], undefined);
  assert.equal((await POST(`code=${code}`, { key: ops.opsKey(), via: "code" })).status, 303, "and the code is still good for the owner");
});

test("in code-only mode the owner's keyed gate is not answered 429 after a stranger's junk codes", async () => {
  config.opsPasswordHash = "";
  for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++) await POST("code=000000");
  const out = await GET({ key: ops.opsKey() });
  assert.equal(out.status, 401);
  assert.match(out.body, /Text me the code/);
});

test("a stranger's thirty wrong passwords from forged addresses cannot lock out the owner's keyed link", async () => {
  for (let i = 0; i < opspw.MAX_TOTAL; i++) await POST(pw("nope"), { headers: { "x-forwarded-for": `9.9.${Math.floor(i / 4)}.${i}` } });
  const keyed = await POST(pw(PASSWORD), { key: ops.opsKey(), headers: { "x-forwarded-for": "8.8.8.8" } });
  assert.equal(keyed.status, 303, "the owner's right password, on the keyed link, still opens the page");
  assert.match(keyed.headers["Set-Cookie"], /^reason_page=/);
  // Without the key the shared cap still holds: it is the bound on a header-forging guesser.
  const keyless = await POST(pw(PASSWORD), { headers: { "x-forwarded-for": "8.8.8.7" } });
  assert.equal(keyless.status, 429);
  assert.equal(keyless.headers["Set-Cookie"], undefined);
  // And the window passing still frees the keyless path.
  clock.skip(opspw.WINDOW_MS + 1000);
  assert.equal((await POST(pw(PASSWORD), { headers: { "x-forwarded-for": "8.8.8.7" } })).status, 303);
});

test("a wrong key is no key", async () => {
  for (let i = 0; i < opspw.MAX_TOTAL; i++) await POST(pw("nope"), { headers: { "x-forwarded-for": `9.8.${i}.1` } });
  const out = await POST(pw(PASSWORD), { key: "not-the-key", headers: { "x-forwarded-for": "8.8.8.8" } });
  assert.equal(out.status, 429);
  for (let i = 0; i < MAX_FAILED_ATTEMPTS + 1; i++) await POST("code=000000", { key: "not-the-key" });
  assert.equal(db.failedPageAttempts("ops", opspw.WINDOW_MS), 0);
});
