// Owner rule (2026-10-26): Reason texts over Sendblue only, and nobody is ever shown a Linq number.
//
// On the live install the Linq adapter is registered but `not_connected` (no LINQ_* keys). Any
// surface that tells a person a number to text (the Reason Web join page, its QR, "not on your
// phone?", plus the event and invite pages that already exist) must take that number from the
// channel that is LIVE, never from a registered-but-dead adapter and never from a string in code.
// Pinned here with the real LinqChannel and SendblueChannel classes, not fakes, so a change to
// either adapter's status() shows up.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_WEB = "on";
// Sendblue fully configured; Linq has a from-number on file but no keys, i.e. registered, not live.
process.env.SENDBLUE_API_KEY_ID = "sb-key";
process.env.SENDBLUE_API_SECRET_KEY = "sb-secret";
process.env.SENDBLUE_FROM_NUMBER = "+16562167455";
process.env.SENDBLUE_WEBHOOK_SECRET = "sb-webhook";
process.env.LINQ_FROM_NUMBER = "+18083199759";
delete process.env.LINQ_API_KEY;
delete process.env.LINQ_WEBHOOK_SECRET;

const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { LinqChannel } = await import("../src/channels/linq.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { liveLine, liveLineNumber } = await import("../src/contact.js");
const { joinNumber } = await import("../src/web.js");

const SENDBLUE = "+16562167455";
const LINQ = "+18083199759";

function routerWith(...channels) {
  const router = new Router();
  for (const ch of channels) router.register(ch);
  return router;
}

test("the fixture is honest: linq registered but not_connected, sendblue live", () => {
  const linq = new LinqChannel();
  const sb = new SendblueChannel();
  assert.equal(linq.status().status, "not_connected");
  assert.equal(linq.status().number, LINQ, "linq knows a number it must never hand out");
  assert.equal(sb.status().status, "live");
  assert.equal(sb.status().number, SENDBLUE);
});

test("the Web join surface shows only the Sendblue number with linq registered first", () => {
  const router = routerWith(new ConsoleChannel(), new LinqChannel(), new SendblueChannel());
  assert.equal(joinNumber(router), SENDBLUE);
  assert.equal(liveLine(router).name, "sendblue");
  assert.notEqual(joinNumber(router), LINQ);
});

test("… and with linq registered last", () => {
  const router = routerWith(new SendblueChannel(), new LinqChannel(), new ConsoleChannel());
  assert.equal(joinNumber(router), SENDBLUE);
});

test("no live texting line means no number at all, never the registered linq one", () => {
  const router = routerWith(new ConsoleChannel(), new LinqChannel());
  assert.equal(joinNumber(router), null);
  assert.equal(liveLineNumber(router), null);
  assert.equal(liveLine(router), null);
});

test("the console is never the line, even when it is the only live channel", () => {
  const router = routerWith(new ConsoleChannel());
  assert.equal(joinNumber(router), null);
});

test("the event and invite pages take their number through the same helper", async () => {
  const { eventRequestFor, inviteRequestFor } = await import("../src/http.js");
  const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../src/http.js", import.meta.url), "utf8"));
  // Pinned on the source so a future route that rebuilds its own "first live channel" lookup, or
  // hardcodes a number, fails here rather than in someone's text thread.
  assert.equal((src.match(/liveLineNumber\(router\)/g) ?? []).length >= 2, true, "event + invite routes use liveLineNumber");
  assert.doesNotMatch(src, /6562167455|8083199759/, "no line number is hardcoded in http.js");
  assert.equal(typeof eventRequestFor, "function");
  assert.equal(typeof inviteRequestFor, "function");
});

test("no texting number is hardcoded anywhere in the web layer", async () => {
  const fs = await import("node:fs");
  for (const f of ["../src/web.js", "../src/channels/web.js"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\+?1?\s?\(?656\)?[\s-]?216[\s-]?7455|8083199759|linqFrom/, `${f} names no number and never reads the linq adapter's`);
  }
});
