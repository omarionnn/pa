// The code a person texts back for the hosted browser's DoorDash sign-in (src/signinemail.js takeCodeReply,
// review of #605): only DoorDash's own numeric code is typed; anything shaped like a password is never
// typed and never kept; nothing is taken when no code was asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "dd-code-")), "reason.db");
const sie = await import("../src/signinemail.js");
const HOSTED = { site: "doordash", label: "DoorDash", browser: "remote", signin_url: "https://identity.doordash.com" };
const C = "dm:code-reply";

test("hosted DoorDash sign-in: the six digits are taken and typed once; the thread keeps a placeholder", async () => {
  const waiting = sie.awaitCodeReply(C, HOSTED, { waitMs: 5_000 });
  const placeholder = sie.takeCodeReply(C, "482 913");
  assert.match(placeholder, /sign-in code\. Reason passed it straight to DoorDash; it is not shown here/);
  assert.doesNotMatch(placeholder, /482|913/);
  assert.equal(await waiting, "482913");
  assert.equal(sie.takeCodeReply(C, "482913"), null, "used once: nothing waits any more");
});

test("hosted DoorDash sign-in: a password texted instead is never typed and never kept; the wait goes on", async () => {
  const waiting = sie.awaitCodeReply(C, HOSTED, { waitMs: 5_000 });
  for (const pw of ["Summer2024", "hunter22!", "P@ssw0rd"]) {
    const out = sie.takeCodeReply(C, pw);
    assert.ok(out, `${pw}: taken out of the thread`);
    assert.match(out, /not DoorDash's code \(it may have been a password\)\. It was not used, not typed anywhere and not kept/);
    assert.ok(!out.includes(pw));
  }
  assert.equal(sie.takeCodeReply(C, "ok thanks, one sec"), null, "ordinary words go through as words");
  // Still waiting: the real code is taken after all that.
  assert.ok(sie.takeCodeReply(C, "771204"));
  assert.equal(await waiting, "771204");
});

test("no code asked for: a message with digits is just a message", () => {
  assert.equal(sie.takeCodeReply("dm:nobody-asked", "123456"), null);
});
