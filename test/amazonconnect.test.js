// Connect Amazon as a step of its own (src/amazonconnect.js), callable from the text intro or a web
// onboarding: when it is offered, the link it makes, the card that link unfurls as, and the follow-up.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-amazonconnect-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const amazon = await import("../src/amazonconnect.js");
const remote = await import("../src/signin-remote.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const ME = "dm:fake:+14155550111";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  config.publicUrl = "https://reason.example.test";
  db.db.exec("DELETE FROM accounts; DELETE FROM timers; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: ME, channel: "fake", address: "+14155550111", name: "Kofi" });
});

test("connectLink: Reason's sign-in link for Amazon, nothing launched, on the ledger with the surface that asked", () => {
  assert.equal(amazon.available(ME), true);
  const r = amazon.connectLink(ME, { via: "web_onboarding" });
  assert.equal(r.ok, true);
  assert.match(r.url, /\/s\/[A-Za-z0-9_-]{32,64}$/);
  assert.ok(r.goodForMinutes > 0);
  assert.deepEqual(remote.remoteSessionFor(ME), { site: "amazon", started: false });
  const row = db.db.prepare("SELECT action, attempted, target FROM action_ledger WHERE conversation_id = ?").get(ME);
  assert.equal(row.action, "signin_link");
  assert.equal(row.target, "site:amazon");
  assert.match(row.attempted, /web_onboarding/);
});

test("the link's page unfurls as \"Connect Amazon\", naming nobody", async () => {
  const r = amazon.connectLink(ME);
  const page = await remote.remoteRequest({ token: r.url.split("/").pop(), method: "GET", headers: {}, query: {}, readBody: async () => "" });
  const head = String(page.body).split("</head>")[0];
  assert.match(head, /<meta property="og:title" content="Connect Amazon">/);
  assert.match(head, /Secured by Reason/);
  assert.doesNotMatch(head, /Kofi|4155550111|og:url/);
});

test("the follow-up rides the link: signed in → read the order history, only what is there, never buy", () => {
  let got = null;
  amazon.connectLink(ME, { create: (a) => { got = a; return { ok: true, url: "https://x.test/s/" + "a".repeat(32), reachable_from_a_phone: true, good_for_minutes: 10 }; } });
  assert.equal(got.entry.site, "amazon");
  const note = got.afterSignedIn;
  assert.ok(note.includes("https://www.amazon.com/gp/css/order-history"));
  assert.match(note, /browser_open/);
  assert.match(note, /never invent one/);
  assert.match(note, /never buy or add anything to a cart/);
  assert.match(note, /If the page will not read or shows no orders, just say it worked/);
});

test("not offered when it cannot be kept: no public address, the operator, nobody's account, already signed in", () => {
  config.publicUrl = "";
  assert.equal(amazon.available(ME), false);
  assert.deepEqual(amazon.connectLink(ME), { ok: false, why: "unavailable" });
  config.publicUrl = "https://reason.example.test";
  assert.equal(amazon.available("dm:owner"), false);
  assert.equal(amazon.available("dm:fake:+19999999999"), false);
  db.recordSiteSignin(ME, "amazon", { state: "signed_in", evidence: "order history loaded" });
  assert.equal(amazon.connected(ME), true);
  assert.equal(amazon.available(ME), false, "already connected: nothing to offer");
});

test("the texts: Amazon, never email; one question; no words for them to type", () => {
  for (const line of [amazon.OFFER, amazon.LINK_LINE, amazon.NO_LINE, amazon.FAILED_LINE]) {
    assert.doesNotMatch(line, /email|gmail|outlook|inbox/i);
    assert.doesNotMatch(line, /["“”]|\b(say|type|reply)\b/i);
  }
  assert.equal((amazon.OFFER.match(/\?/g) ?? []).length, 1);
});
