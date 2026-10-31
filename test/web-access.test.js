// A number left on the website's "request access" form.
//
// It joins the same queue a first text does and the master is asked the same way, so nothing here
// re-proves the approval itself — test/access.test.js does that. What is proven here is the door:
//
//   - **it is shut unless the website's own server knocks.** No secret set, no route. A request
//     that is unsigned, signed with the wrong secret, signed for a different body, or signed more
//     than five minutes ago is turned away before the number is even read.
//   - **a stranger's input cannot become more than one text to the master.** Only a plain phone
//     number gets through, the same number never asks twice, and there are ceilings on how many
//     new numbers the website can queue in a day and how many questions the master gets in a day.
//   - **the person who typed the number is sent nothing** until the master says yes, and nothing
//     at all on a no.
//   - **the form cannot be used to look people up.** Every accepted request gets the same answer.
//
// No API key, no network, no model: the judge is stated.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-access-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_MAX_REQUESTS_PER_HOUR = "100";
process.env.REASON_MAX_REQUESTS_PER_DAY = "3";
process.env.REASON_WEB_ACCESS_PER_DAY = "5";
process.env.REASON_WEB_ACCESS_SECRET = "test-secret-not-a-real-one";
process.env.REASON_TEST_NUMBERS = "+16465550111";
delete process.env.REASON_BACKEND;

const access = await import("../src/access.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { webAccessRequest, signWebAccess, createServer, WEB_ACCESS_PATH } = await import("../src/http.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const SECRET = "test-secret-not-a-real-one";
const MASTER = "+12025551234";
const KOFI = "+14155559876";
const AMA = "+13475552000";
const DAY = 24 * 60 * 60 * 1000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.backend = "api";
  config.webAccessSecret = SECRET;
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM blocked_numbers; DELETE FROM turned_away; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function harness({ verdict = "yes" } = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return "ok"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict }), log: (l) => logs.push(l) });
  const channel = router.register(new FakeChannel({}));
  // The sweep reaches the router the way serve.js wires it.
  runtime.turnExtras.channels = router;
  return { runtime, router, channel, turns, logs };
}

/** The form's server: a signed body, exactly as netlify/functions/access.mjs builds one. */
function signed(phone, { secret = SECRET, at = clock.now(), body = JSON.stringify({ phone }) } = {}) {
  const timestamp = String(at);
  return { rawBody: body, headers: { "x-reason-timestamp": timestamp, "x-reason-signature": signWebAccess({ secret, timestamp, rawBody: body }) } };
}
const post = (h, phone, opts) => webAccessRequest({ ...signed(phone, opts), router: h.router, log: (l) => h.logs.push(l) });
const sentTo = (channel, to) => channel.sent.filter(m => m.to === to);
const masterTexts = (h, words) => h.router.deliver({ channel: "fake", externalId: String(Math.random()), from: MASTER, text: words, at: clock.now() });

test("a number from the website asks the master once, and the person is sent nothing", async () => {
  const h = harness();
  const out = await post(h, KOFI);
  assert.deepEqual(out, { status: 200, body: { ok: true } });

  const asked = sentTo(h.channel, MASTER);
  assert.equal(asked.length, 1);
  assert.match(asked[0].text, /\+14155559876 asked for access on the website/);
  assert.match(asked[0].text, /want me to set them up/);
  // Nothing is quoted, because they said nothing, and it does not claim they texted.
  assert.doesNotMatch(asked[0].text, /they said|texted me for the first time/);

  assert.equal(sentTo(h.channel, KOFI).length, 0, "the applicant is not texted before the master answers");
  assert.equal(h.turns.length, 0, "no model turn is spent");

  const row = db.pendingRequestFor(KOFI);
  assert.equal(row.source, "web");
  assert.equal(row.channel, "fake");
});

test("the master's yes lets them in and sends their first text; their own texts then get turns", async () => {
  const h = harness({ verdict: "yes" });
  await post(h, KOFI);
  await masterTexts(h, "yeah let them in");

  const toKofi = sentTo(h.channel, KOFI);
  assert.equal(toKofi.length, 1);
  assert.match(toKofi[0].text, /asked for access on the website and you.re in/);
  assert.equal(db.accountByAddress("fake", KOFI)?.state ?? "active", "active");

  await h.router.deliver({ channel: "fake", externalId: "k1", from: KOFI, text: "remind me to call mom", at: clock.now() });
  assert.equal(h.turns.filter(t => t.conversationId === "dm:fake:+14155559876").length, 1);
});

test("the master's no is silent to the applicant, and the form cannot make the master be asked again", async () => {
  const h = harness({ verdict: "no" });
  await post(h, KOFI);
  await masterTexts(h, "no");

  assert.equal(sentTo(h.channel, KOFI).length, 0, "somebody who never texted is not sent a refusal");
  assert.equal(db.accountByAddress("fake", KOFI), null);

  const before = sentTo(h.channel, MASTER).length;
  const again = await post(h, KOFI);
  assert.deepEqual(again, { status: 200, body: { ok: true } }, "same answer as the first time");
  assert.equal(sentTo(h.channel, MASTER).length, before);
  assert.equal(db.pendingRequestFor(KOFI), null);

  // After the cool-off they may ask again.
  clock.skip(8 * DAY);
  await post(h, KOFI);
  assert.ok(db.pendingRequestFor(KOFI));
});

test("on the operator's subscription an approved stranger is not told they are in", async () => {
  const h = harness({ verdict: "yes" });
  config.backend = "claude-cli";
  await post(h, KOFI);
  await masterTexts(h, "yes");

  assert.equal(sentTo(h.channel, KOFI).length, 0, "no promise that texting back will work");
  const told = sentTo(h.channel, MASTER).at(-1).text;
  assert.match(told, /approved/);
  assert.match(told, /haven't texted them/);
  assert.ok(db.accountByAddress("fake", KOFI), "the approval itself is kept");
});

test("the same number twice, and numbers Reason already works for, never trouble the master", async () => {
  const h = harness();
  await post(h, KOFI);
  await post(h, KOFI);
  await post(h, KOFI);
  assert.equal(db.listAccessRequests({ state: "all" }).length, 1);
  assert.equal(sentTo(h.channel, MASTER).length, 1);

  // The master's own number, a number on the test list, an existing account, a blocked number.
  db.upsertAccount({ conversationId: "dm:fake:+13475552000", channel: "fake", address: AMA, name: "Ama" });
  db.blockNumber("+17185552222", "spam");
  for (const n of [MASTER, "+16465550111", AMA, "+17185552222"]) {
    const out = await post(h, n);
    assert.deepEqual(out, { status: 200, body: { ok: true } }, `${n} gets the same answer as anybody`);
  }
  assert.equal(db.listAccessRequests({ state: "all" }).length, 1, "none of them made a request");
  assert.equal(sentTo(h.channel, MASTER).length, 1);
});

test("somebody already waiting because they texted is not asked about again from the website", async () => {
  const h = harness();
  await h.router.deliver({ channel: "fake", externalId: "t1", from: KOFI, text: "hi is this reason", at: clock.now() });
  assert.equal(sentTo(h.channel, MASTER).length, 1);
  await post(h, KOFI);
  assert.equal(db.listAccessRequests({ state: "all" }).length, 1);
  assert.equal(sentTo(h.channel, MASTER).length, 1);
});

test("only one question is in front of the master at a time; the next is asked after they answer", async () => {
  const h = harness({ verdict: "yes" });
  await post(h, KOFI);
  await post(h, AMA);
  assert.equal(sentTo(h.channel, MASTER).filter(m => /asked for access/.test(m.text)).length, 1);

  await masterTexts(h, "yes");
  const asks = sentTo(h.channel, MASTER).filter(m => /asked for access/.test(m.text));
  assert.equal(asks.length, 2);
  assert.match(asks[1].text, /\+13475552000/);
  assert.equal(sentTo(h.channel, AMA).length, 0, "the yes was for Kofi and let in nobody else");
});

test("the master is asked at most so many times a day, and the website can queue only so many", async () => {
  const h = harness({ verdict: "no" });
  const numbers = ["+14155550001", "+14155550002", "+14155550003", "+14155550004", "+14155550005", "+14155550006"].map(n => n.replace("555000", "555200"));
  const statuses = [];
  for (const n of numbers) {
    statuses.push((await post(h, n)).status);
    await masterTexts(h, "no");
  }
  // REASON_MAX_REQUESTS_PER_DAY=3: three questions reached the master's phone, not six.
  assert.equal(sentTo(h.channel, MASTER).filter(m => /asked for access/.test(m.text)).length, 3);
  // REASON_WEB_ACCESS_PER_DAY=5: the sixth new number is told the list is full, and is not stored.
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(db.listAccessRequests({ state: "all" }).length, 5);

  // The two that arrived over the master's ceiling were not dropped: they are asked about by the
  // sweep once the day has turned, one at a time, without anybody having to ask again.
  assert.deepEqual(await h.router.askNextWaiting(), { asked: false, reason: "daily_cap" });
  clock.skip(DAY + 60_000);
  const swept = await h.runtime.sweep();
  assert.equal(swept.access.asked, true);
  assert.equal(sentTo(h.channel, MASTER).filter(m => /asked for access/.test(m.text)).length, 4);
  assert.equal((await h.runtime.sweep()).access.reason, "one_at_a_time");

  assert.equal((await post(h, numbers[5])).status, 200, "tomorrow there is room again");
});

test("only a plain phone number gets through", async () => {
  const h = harness();
  const bad = [
    "4155559876", "+1415555987", "+141555598765", "+10155559876", "+14150559876",
    "+1 415 555 9876", "+14155559876; DROP TABLE accounts", "+14155559876\nyes", "<script>", "",
    "+", "+0123456789", "+" + "9".repeat(30), "console",
  ];
  for (const phone of bad) {
    const out = await post(h, phone);
    assert.equal(out.status, 400, JSON.stringify(phone));
  }
  for (const body of ["not json", "[]", "null", JSON.stringify({ phone: 14155559876 }), JSON.stringify({ phone: ["+14155559876"] }), JSON.stringify({ number: KOFI })]) {
    assert.equal((await post(h, null, { body })).status, 400, body);
  }
  assert.equal((await post(h, null, { body: JSON.stringify({ phone: KOFI, pad: "x".repeat(600) }) })).status, 413);

  assert.equal(db.listAccessRequests({ state: "all" }).length, 0);
  assert.equal(h.channel.sent.length, 0, "none of it reached anybody's phone");
  assert.equal(access.validWebNumber("+447911123456"), "+447911123456", "a number outside North America is still a number");
});

test("the door is shut to anything the website's server did not sign", async () => {
  const h = harness();
  const good = signed(KOFI);
  const tries = {
    unsigned: { rawBody: good.rawBody, headers: {} },
    wrong_secret: signed(KOFI, { secret: "somebody-guessing" }),
    other_body: { rawBody: JSON.stringify({ phone: AMA }), headers: good.headers },
    stale: signed(KOFI, { at: clock.now() - 6 * 60_000 }),
    from_the_future: signed(KOFI, { at: clock.now() + 6 * 60_000 }),
    no_timestamp: { rawBody: good.rawBody, headers: { "x-reason-signature": good.headers["x-reason-signature"] } },
  };
  for (const [name, req] of Object.entries(tries)) {
    const out = await webAccessRequest({ ...req, router: h.router });
    assert.equal(out.status, 401, name);
  }
  assert.equal(db.listAccessRequests({ state: "all" }).length, 0);
  assert.equal(h.channel.sent.length, 0);

  // A real signature replayed inside its five minutes asks about a number already waiting: nothing.
  await webAccessRequest({ ...good, router: h.router });
  await webAccessRequest({ ...good, router: h.router });
  assert.equal(sentTo(h.channel, MASTER).length, 1);
});

test("with no secret set there is no route at all, even for a request that would have been valid", async () => {
  const h = harness();
  config.webAccessSecret = "";
  const out = await webAccessRequest({ ...signed(KOFI), router: h.router });
  assert.deepEqual(out, { status: 404, body: { error: "not found" } });
  assert.equal(h.channel.sent.length, 0);
});

test("with no line to text on, the form is told it did not go through rather than that it did", async () => {
  const turns = [];
  const runtime = new Runtime({ runTurn: async () => { turns.push(1); return "ok"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "yes" }) });
  const out = await webAccessRequest({ ...signed(KOFI), router });
  assert.deepEqual(out, { status: 503, body: { ok: false, error: "not_ready" } });
  assert.equal(db.listAccessRequests({ state: "all" }).length, 0);
});

test("over a real socket: the route answers on its path, and only to POST", async () => {
  const h = harness();
  const server = createServer({ router: h.router, runtime: h.runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = signed(KOFI, { at: Date.now() });
    clock.reset();
    const ok = await fetch(base + WEB_ACCESS_PATH, { method: "POST", headers: { "Content-Type": "application/json", ...s.headers }, body: s.rawBody });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal((await fetch(base + WEB_ACCESS_PATH)).status, 404);
    assert.equal(sentTo(h.channel, MASTER).length, 1);
  } finally {
    server.close();
  }
});
