// A picture is only "sent" when it arrived (src/pictureout.js).
//
//   a shop's CDN link: fetched here, kept on Reason's own host, sent from there?   (yes, through the outbox)
//   the fetch fails: is a picture claimed?                                          (no: the link, with a line saying so)
//   too big, not a picture, a private address?                                      (refused; a private one sends nothing)
//   QUEUED then DELIVERED?                                                          (nothing more is said)
//   QUEUED then ERROR, or no word in ~75 s?                                         (one line with the link, once)
//   what is the model told?                                                         (on its way; never "sent")
//
// No model and no network: every fetch is a stub, the provider is the fake channel.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-pictureout-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_DELIVERY_GATED = "off";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { runTool } = await import("../src/tools.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { Runtime } = await import("../src/runtime.js");
const pictureout = await import("../src/pictureout.js");
const outbox = await import("../src/outbox.js");
const { webMediaRoute } = await import("../src/webmedia.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const CDN = "https://cdn.shop.example/products/blue-mug.png?v=1731600000&width=1200";
after(() => rmSync(dir, { recursive: true, force: true }));

// A real 1x1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2b4cd2a0000000049454e44ae426082", "hex");

function fetchWith({ status = 200, type = "image/png", body = PNG, length = null, throws = null } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (throws) throw throws;
    const headers = new Headers({ "content-type": type, ...(length != null ? { "content-length": String(length) } : {}) });
    return new Response(status === 204 ? null : body, { status, headers });
  };
  fn.calls = calls;
  return fn;
}

let n = 0;
function harness({ status = "QUEUED" } = {}) {
  const router = new Router({ log: () => {} });
  const fake = router.register(new FakeChannel({ media: true, reportsDelivery: true }));
  // The provider's answer carries a message handle and its first status, as Sendblue's does.
  const real = fake.sendMediaUrl.bind(fake);
  fake.sendMediaUrl = async (args) => { const r = await real(args); if (r.ok) r.delivered = { ...r.delivered, message_id: `out-${++n}`, status }; return r; };
  fake.lookups = [];
  fake.statusAs = "QUEUED";
  fake.messageStatus = async (id) => { fake.lookups.push(id); return { ok: true, status: fake.statusAs }; };
  const told = [];
  const tell = async (c, text, meta) => { told.push({ c, text, meta }); return { ok: true }; };
  return { router, fake, told, tell };
}

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM picture_watches;");
  pictureout._reset();
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
});

const send = (h, url, fetchImpl, more = {}) => runTool("send_picture", { url, ...more }, { conversationId: C, channels: h.router, messages: [], kind: "user", fetchImpl });

test("a shop's CDN link is fetched here, kept on Reason's own host, and sent from there through the outbox; the model hears 'on its way'", async () => {
  const h = harness();
  const f = fetchWith();
  const out = await send(h, CDN, f, { caption: "this one" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(f.calls, [CDN], "fetched once, from the address given");
  assert.equal(h.fake.sent.length, 1);
  const sentUrl = h.fake.sent[0].media.url;
  assert.match(sentUrl, /^https:\/\/files\.example\.test\/web\/media\/u\/[A-Za-z0-9_-]{22}\/picture\.png$/, "our host, never the CDN");
  assert.equal(sentUrl.includes("cdn.shop.example"), false);
  assert.equal(h.fake.sent[0].text, "this one");
  const rows = db.outboundUnder(`picture:${C}:`);
  assert.equal(rows.length, 1, "a row in the outbox like any text");
  // What the model is told: on its way, and never that it was sent.
  assert.equal(out.delivery, "pending");
  assert.equal(out.note, pictureout.ON_ITS_WAY_NOTE);
  assert.doesNotMatch(out.note, /you may say you sent it/i);
  assert.match(out.note, /Never say it was sent, delivered, or that it should come through/);
  // The provider can fetch our copy without a session: the random address is the secret, like a table picture.
  const path = new URL(sentUrl).pathname;
  const served = await webMediaRoute({ path, method: "GET", headers: {} });
  assert.equal(served.status, 200);
  assert.equal(pictureout.watchesOf(C).length, 1, "and it is watched");
});

test("the fetch fails: no picture is claimed, the link goes as text with an honest line", async () => {
  for (const [why, f] of [
    ["a 404", fetchWith({ status: 404, type: "text/html", body: "nope" })],
    ["a timeout", fetchWith({ throws: Object.assign(new Error("aborted"), { name: "AbortError" }) })],
    ["not a picture", fetchWith({ type: "text/html", body: "<html>a product page</html>" })],
    ["a picture's type on bytes that aren't one", fetchWith({ type: "image/png", body: Buffer.from("<html>not really a png at all</html>") })],
    ["too big (said up front)", fetchWith({ length: 50 * 1024 * 1024 })],
  ]) {
    const h = harness();
    const out = await send(h, CDN, f);
    assert.equal(out.ok, false, why);
    assert.equal(out.picture_sent, false, why);
    assert.equal(out.link_sent, true, why);
    assert.match(out.note, /Do not say a picture was sent/, why);
    assert.deepEqual(h.fake.sent.map(s => s.text), [pictureout.FETCH_FAILED_LINE(CDN)], why);
    assert.ok(!h.fake.sent[0].media, `${why}: no picture went`);
  }
});

test("too big while it streams: refused at the cap, not read to the end", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(pictureout.MAX_BYTES)]);
  const r = await pictureout.rehost({ url: CDN, conversationId: C, fetchImpl: fetchWith({ body: big }) });
  assert.equal(r.ok, false);
  assert.match(r.why, /bigger than/);
});

test("a private address is refused and nothing at all is sent; nor is anything fetched", async () => {
  for (const url of ["https://127.0.0.1/a.png", "https://169.254.169.254/latest/meta-data/x.png", "https://localhost/a.png", "https://10.0.0.5/a.png"]) {
    const h = harness();
    const f = fetchWith();
    const out = await send(h, url, f);
    assert.equal(out.ok, false, url);
    assert.equal(out.refused, true, url);
    assert.equal(h.fake.sent.length, 0, `${url}: nothing sent, not even the link`);
    assert.deepEqual(f.calls, [], `${url}: never fetched`);
  }
  // A redirect into the private network is a new hop and is refused the same way.
  const h = harness();
  const hop = async (url) => (url === CDN ? new Response(null, { status: 302, headers: { location: "https://192.168.1.1/x.png" } }) : new Response(PNG, { headers: { "content-type": "image/png" } }));
  const out = await send(h, CDN, hop);
  assert.equal(out.refused, true);
  assert.equal(h.fake.sent.length, 0);
});

test("QUEUED, then the provider says DELIVERED: nothing more is said", async () => {
  const h = harness();
  await send(h, CDN, fetchWith());
  const row = db.outboundUnder(`picture:${C}:`)[0];
  assert.equal(row.state, "sent");
  outbox.noteDelivery({ channel: "fake", messageId: row.message_id, status: "DELIVERED" });
  clock.skip(pictureout.WATCH_MS + 1000);
  const r = await pictureout.pass({ router: h.router, tell: h.tell });
  assert.equal(r.delivered, 1);
  assert.deepEqual(h.told, []);
  assert.deepEqual(h.fake.lookups, [], "the callback was enough; nobody had to ask");
});

test("QUEUED, then ERROR: one line with the link, at once, and never twice", async () => {
  const h = harness();
  await send(h, CDN, fetchWith());
  const row = db.outboundUnder(`picture:${C}:`)[0];
  outbox.noteDelivery({ channel: "fake", messageId: row.message_id, status: "ERROR", error: "not delivered" });
  const r = await pictureout.pass({ router: h.router, tell: h.tell });
  assert.equal(r.told, 1);
  assert.deepEqual(h.told.map(t => t.text), [pictureout.DIDNT_ARRIVE_LINE(CDN)]);
  assert.equal(pictureout.DIDNT_ARRIVE_LINE(CDN), `That picture didn't go through, here's the link:\n${CDN}`);
  clock.skip(5 * 60_000);
  await pictureout.pass({ router: h.router, tell: h.tell });
  assert.equal(h.told.length, 1, "said once");
});

test("QUEUED and no word at all: nothing before its minute; then the provider is asked, and anything but delivered gets the one line", async () => {
  const h = harness();
  await send(h, CDN, fetchWith());
  clock.skip(30_000);
  await pictureout.pass({ router: h.router, tell: h.tell });
  assert.deepEqual(h.told, [], "still within its minute");
  clock.skip(pictureout.WATCH_MS);
  const r = await pictureout.pass({ router: h.router, tell: h.tell });
  assert.equal(h.fake.lookups.length, 1, "asked once (GET /api/status)");
  assert.equal(r.told, 1);
  assert.deepEqual(h.told.map(t => t.text), [pictureout.DIDNT_ARRIVE_LINE(CDN)]);

  // The same, but the lookup says it did arrive: nothing.
  const h2 = harness();
  await send(h2, CDN, fetchWith());
  h2.fake.statusAs = "DELIVERED";
  clock.skip(pictureout.WATCH_MS + 1000);
  const r2 = await pictureout.pass({ router: h2.router, tell: h2.tell });
  assert.equal(r2.delivered, 1);
  assert.deepEqual(h2.told, []);
});

test("the runtime's sweep runs the watch and says the line in code's words", async () => {
  const h = harness();
  const said = [];
  const runtime = new Runtime({ log: () => {}, runTurn: async () => "ok", channels: h.router, deliver: async (m) => { said.push(m.text); return { ok: true }; } });
  await send(h, CDN, fetchWith());
  clock.skip(pictureout.WATCH_MS + 1000);
  const out = await runtime.pictureWatches();
  assert.equal(out.told, 1);
  assert.deepEqual(said, [pictureout.DIDNT_ARRIVE_LINE(CDN)]);
});

test("Sendblue's status lookup is GET /api/status?handle=, read without throwing", async () => {
  const was = { k: config.sendblueKeyId, s: config.sendblueSecretKey, f: config.sendblueFrom, w: config.sendblueWebhookSecret };
  Object.assign(config, { sendblueKeyId: "k", sendblueSecretKey: "s", sendblueFrom: "+15122164639", sendblueWebhookSecret: "w" });
  try {
    const asked = [];
    const ch = new SendblueChannel({ fetchImpl: async (url, init) => { asked.push({ url, method: init?.method }); return new Response(JSON.stringify({ status: "DELIVERED", message_handle: "out-1" }), { status: 200 }); } });
    const r = await ch.messageStatus("out-1");
    assert.deepEqual(r, { ok: true, status: "DELIVERED", error: null });
    assert.match(asked[0].url, /\/api\/status\?handle=out-1$/);
    assert.equal(asked[0].method, "GET");
    const down = new SendblueChannel({ fetchImpl: async () => { throw new Error("socket hang up"); } });
    assert.equal((await down.messageStatus("out-1")).ok, false);
  } finally {
    Object.assign(config, { sendblueKeyId: was.k, sendblueSecretKey: was.s, sendblueFrom: was.f, sendblueWebhookSecret: was.w });
  }
});

// ---------------------------------------------------------------- review holes (security review, 2026-11-14)
test("iMessage: SENT is not arrived (DELIVERED is its last word); SMS: SENT is its last word", async () => {
  // Sendblue: SENT is terminal for SMS (or a phone not on iMessage); DELIVERED is terminal for iMessage.
  const h = harness();
  await send(h, CDN, fetchWith());
  const row = db.outboundUnder(`picture:${C}:`)[0];
  outbox.noteDelivery({ channel: "fake", messageId: row.message_id, status: "SENT" });
  h.fake.messageStatus = async (id) => { h.fake.lookups.push(id); return { ok: true, status: "SENT", service: "iMessage" }; };
  clock.skip(pictureout.WATCH_MS + 1000);
  const r = await pictureout.pass({ router: h.router, tell: h.tell });
  assert.equal(h.fake.lookups.length, 1, "SENT alone: the provider is asked which service it went by");
  assert.equal(r.told, 1, "an iMessage picture still only SENT after its minute gets the link");
  assert.deepEqual(h.told.map(t => t.text), [pictureout.DIDNT_ARRIVE_LINE(CDN)]);

  const h2 = harness();
  await send(h2, CDN, fetchWith());
  const row2 = db.outboundUnder(`picture:${C}:`).at(-1);
  outbox.noteDelivery({ channel: "fake", messageId: row2.message_id, status: "SENT" });
  h2.fake.messageStatus = async (id) => { h2.fake.lookups.push(id); return { ok: true, status: "SENT", service: "SMS" }; };
  clock.skip(pictureout.WATCH_MS + 1000);
  const r2 = await pictureout.pass({ router: h2.router, tell: h2.tell });
  assert.equal(r2.delivered, 1, "SMS: SENT is as far as it goes");
  assert.deepEqual(h2.told, []);
});

test("a kept copy is gone with their data, and is not served past its 30 days", async () => {
  const uploads = await import("../src/webuploads.js");
  const { deleteData } = await import("../src/data.js");
  const mine = await pictureout.rehost({ url: CDN, conversationId: C, fetchImpl: fetchWith() });
  const theirs = await pictureout.rehost({ url: CDN, conversationId: "dm:someone-else", fetchImpl: fetchWith() });
  assert.equal(mine.ok && theirs.ok, true);
  const path = (k) => new URL(k.url).pathname;
  assert.equal((await webMediaRoute({ path: path(mine), method: "GET", headers: {} })).status, 200);
  const served = await webMediaRoute({ path: path(mine), method: "GET", headers: {} });
  assert.equal(served.headers["Content-Type"], "image/png");
  assert.equal(served.headers["X-Content-Type-Options"], "nosniff");
  const out = await deleteData({ conversation: C, fetchImpl: async () => new Response("{}") });
  assert.equal(uploads.meta(mine.id), null, "their kept picture's record is gone");
  assert.equal((await webMediaRoute({ path: path(mine), method: "GET", headers: {} })).status, 404, "and it is no longer served");
  assert.ok(out.uploads?.files_deleted >= 1, JSON.stringify(out.uploads));
  assert.notEqual(uploads.meta(theirs.id), null, "somebody else's is untouched");
  // Past its 30 days it is not served, whether or not the hourly prune has run yet.
  clock.skip(uploads.KEEP_MS + 60_000);
  assert.equal((await webMediaRoute({ path: path(theirs), method: "GET", headers: {} })).status, 404);
});

test("at most PICTURES_PER_DAY kept per person in a day; past that nothing is fetched", async () => {
  const other = "dm:bulk";
  for (let i = 0; i < pictureout.PICTURES_PER_DAY; i++) {
    const r = await pictureout.rehost({ url: CDN, conversationId: other, fetchImpl: fetchWith() });
    assert.equal(r.ok, true, `picture ${i + 1}`);
  }
  const f = fetchWith();
  const over = await pictureout.rehost({ url: CDN, conversationId: other, fetchImpl: f });
  assert.equal(over.ok, false);
  assert.equal(over.limited, true);
  assert.deepEqual(f.calls, [], "not even fetched");
  assert.equal((await pictureout.rehost({ url: CDN, conversationId: "dm:another", fetchImpl: fetchWith() })).ok, true, "somebody else is unaffected");
  clock.skip(24 * 60 * 60_000 + 1000);
  assert.equal((await pictureout.rehost({ url: CDN, conversationId: other, fetchImpl: fetchWith() })).ok, true, "a day later, again");
});

test("an SVG, or HTML served as an image, is never kept", async () => {
  for (const [why, f] of [
    ["svg", fetchWith({ type: "image/svg+xml", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') })],
    ["html as jpeg", fetchWith({ type: "image/jpeg", body: Buffer.from("<!doctype html><script>alert(1)</script>") })],
  ]) {
    const r = await pictureout.rehost({ url: CDN, conversationId: C, fetchImpl: f });
    assert.equal(r.ok, false, why);
  }
});

test("address forms that reach a private machine are refused (decimal, octal, hex, IPv6-mapped, a name resolving private)", async () => {
  const { publicAddresses } = await import("../src/netguard.js");
  for (const url of ["https://2130706433/a.png", "https://0177.0.0.1/a.png", "https://0x7f.1/a.png", "https://[::ffff:127.0.0.1]/a.png", "https://[::ffff:a9fe:a9fe]/a.png", "https://[fd00:ec2::254]/a.png", "https://[::1]/a.png", "https://0/a.png", "https://user:pw@cdn.shop.example/a.png", "http://cdn.shop.example/a.png"]) {
    const f = fetchWith();
    const r = await pictureout.rehost({ url, conversationId: C, fetchImpl: f });
    assert.equal(r.ok, false, url);
    assert.equal(r.refused, true, url);
    assert.deepEqual(f.calls, [], `${url}: never fetched`);
  }
  // A public-looking name whose DNS answer is private (rebinding) is refused; the fetch is pinned to what was checked.
  assert.equal(await publicAddresses("rebind.example", { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }] }), null);
});
