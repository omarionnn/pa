// Option pictures as ONE swipeable stack, like the welcome cards (src/stack.js, src/choicecards.js).
//
// No network, no model, no browser: the renderer is injected, the channel is the fake one with a
// carousel bolted on the way test/welcome-cards.test.js does it, and Linq's HTTP is a recorded fetch.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stack-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PAGES_URL = "https://pages.example";
process.env.REASON_CHOICE_GAP_MS = "0";
process.env.REASON_WELCOME_CARD_GAP_MS = "0";

const stack = await import("../src/stack.js");
const cc = await import("../src/choicecards.js");
const db = await import("../src/db.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { LinqChannel } = await import("../src/channels/linq.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const OWNER = "+12025551234";
const PHOTOS = ["https://shop.example/a.jpg", "https://shop.example/b.jpg", "https://shop.example/c.jpg", "https://shop.example/d.jpg"];
const okPhoto = async ({ url } = {}) => ({ ok: true, mediaType: "image/jpeg", base64: Buffer.from(`jpeg:${url}`).toString("base64"), bytes: 9 });
const shot = [];
const shoot = async (html) => { shot.push(html); return Buffer.from(`JPEG:${html.length}:${Math.random()}`); };
let stored = 0;
const store = ({ name }) => ({ id: `id${String(++stored).padStart(20, "0")}`, name });
const places = (n = 3) => ({
  kind: "places",
  options: ["Joe Coffee", "Abraço", "Ten Bells", "Devoción"].slice(0, n).map((name, i) => ({ name, detail: `${i + 2} min walk`, image_url: PHOTOS[i] })),
});

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  shot.length = 0;
  rmSync(join(dir, "data", "choice-cards"), { recursive: true, force: true }); // drawn fresh, so every test sees its own drawing
  delete process.env.REASON_PICTURE_STACKS;
  cc._setPlaceLook(async () => null);
  cc._setPlaceSearch(null);
  cc._setProductLook(async () => null);
  process.env.REASON_CHOICE_CARDS = "on";
  db.db.exec("DELETE FROM outbox; DELETE FROM choice_sets; DELETE FROM seen_urls; DELETE FROM accounts; DELETE FROM threads; DELETE FROM place_photos;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Owner", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, chatId: null, isOwner: true });
  db.rememberSeenUrls(C, PHOTOS, { kind: "search" });
  cc.takeQueued(C);
});

/** The real router and outbox over the fake channel; `carousel` bolts a stack call on, as Sendblue has. */
function harness({ carousel = true, fail = () => null, max = null } = {}) {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => null });
  const logs = [];
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel());
  const tries = [];
  if (carousel) {
    fake.sendCarousel = async ({ to, mediaUrls }) => {
      tries.push(mediaUrls);
      const f = fail(tries.length);
      if (f) return { ok: false, supported: true, ...f };
      const delivered = { channel: "fake", to, text: "", carousel: mediaUrls, message_id: `STACK-${tries.length}`, media: { renders_as: "carousel" }, at: clock.now() };
      fake.sent.push(delivered);
      return { ok: true, supported: true, delivered };
    };
    if (max) fake.stackMax = max;
  }
  runtime.turnExtras.channels = router;
  return { router, fake, tries, logs };
}

const files = (n) => Array.from({ length: n }, (_, i) => {
  const file = join(dir, `pic-${i + 1}.jpg`);
  writeFileSync(file, Buffer.from(`picture ${i + 1}`));
  return { file, url: `https://pages.example/web/media/u/x${i + 1}/reason-${i + 1}.jpg`, mimeType: "image/jpeg", filename: `reason-${i + 1}.jpg` };
});
const route = { channel: "fake", to: OWNER };

// ---------- the shared sender ----------

test("sizes: one stack when it fits; past the ceiling, as few stacks as fit, as even as they can be", () => {
  assert.deepEqual(stack.stackSizes(5, 20), [5]);
  assert.deepEqual(stack.stackSizes(20, 20), [20]);
  assert.deepEqual(stack.stackSizes(21, 20), [11, 10]);
  assert.deepEqual(stack.stackSizes(45, 20), [15, 15, 15]);
  assert.deepEqual(stack.stackSizes(41, 40), [21, 20]);
  assert.deepEqual(stack.stackSizes(0, 20), []);
  assert.equal(stack.ofLabel(2, 5), "2 of 5");
});

test("a set goes as ONE stack call with every picture, in order", async () => {
  const { router, fake, tries } = harness();
  const pics = files(5);
  const out = await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:1", pictures: pics });
  assert.deepEqual(out, { sent: 5, of: 5, stacked: true, handles: Array(5).fill("STACK-1") });
  assert.deepEqual(tries, [pics.map(p => p.url)]);
  assert.equal(fake.sent.length, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 1);
});

test("over the line's ceiling: split into even stacks, in order, each one call", async () => {
  const { router, tries } = harness({ max: 3 });
  const pics = files(5);
  const out = await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:2", pictures: pics });
  assert.equal(out.sent, 5);
  assert.deepEqual(tries, [pics.slice(0, 3).map(p => p.url), pics.slice(3).map(p => p.url)]);
});

test("a single picture is left alone: its own picture message, no stack", async () => {
  const { router, fake, tries } = harness();
  const out = await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:3", pictures: files(1) });
  assert.equal(out.stacked, false);
  assert.equal(tries.length, 0);
  assert.equal(fake.sent.length, 1);
  assert.ok(fake.sent[0].media?.file);
});

test("a line with no stack (Web, console, an adapter without one): one by one, exactly as before", async () => {
  const { router, fake } = harness({ carousel: false });
  const out = await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:4", pictures: files(3) });
  assert.equal(out.stacked, false);
  assert.equal(out.sent, 3);
  assert.deepEqual(fake.sent.map(s => s.media?.filename), ["reason-1.jpg", "reason-2.jpg", "reason-3.jpg"]);
});

test("REASON_PICTURE_STACKS=off: one by one", async () => {
  process.env.REASON_PICTURE_STACKS = "off";
  const { router, tries, fake } = harness();
  await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:5", pictures: files(3) });
  assert.equal(tries.length, 0);
  assert.equal(fake.sent.length, 3);
});

test("the stack refused for good (a V1 line): the same pictures one by one, in order, in its place", async () => {
  const { router, fake, tries } = harness({ fail: () => ({ retryable: false, error: "Carousel messaging is only available on V2 lines" }) });
  const out = await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:6", pictures: files(4) });
  assert.equal(tries.length, 1);
  assert.equal(out.sent, 4);
  assert.deepEqual(fake.sent.map(s => s.media?.filename), ["reason-1.jpg", "reason-2.jpg", "reason-3.jpg", "reason-4.jpg"]);
  assert.ok(out.handles.every(h => h === null), "pictures one by one share no stack handle");
});

test("a picture without a public address: the set goes one by one rather than a stack missing one", async () => {
  const { router, fake, tries } = harness();
  const pics = files(3);
  pics[1].url = null;
  await stack.sendPictureSet({ router, ...route, conversationId: C, idempotencyKey: "t:7", pictures: pics });
  assert.equal(tries.length, 0);
  assert.equal(fake.sent.length, 3);
});

// ---------- choice cards ----------

test("choice cards: each card says 'N of X', the set goes as ONE stack after the line", async () => {
  const { router, tries } = harness();
  const r = await cc.runChoiceTool("show_choices", places(3), { conversationId: C, fetchPhoto: okPhoto, shoot, channels: router, store });
  assert.equal(r.cards, 3, JSON.stringify(r));
  assert.deepEqual(shot.map(h => />(\d)<span class="of">OF (\d)</.exec(h)?.slice(1).join(" of ")), ["1 of 3", "2 of 3", "3 of 3"]);
  const out = await cc.sendQueued(C, { router, withWords: true, route });
  assert.equal(out.sent, 3);
  assert.equal(out.stacked, true);
  assert.equal(tries.length, 1);
  assert.equal(tries[0].length, 3);
  assert.ok(tries[0].every(u => u.startsWith("https://pages.example/web/media/u/")));
  const set = db.openChoiceFor(C);
  assert.deepEqual(set.options.map(o => [o.n, o.name]), [[1, "Joe Coffee"], [2, "Abraço"], [3, "Ten Bells"]]);
  assert.equal(set.state, "shown");
  // The words that name the options still match the numbers on the cards.
  assert.match(cc.inboundChoiceLine(C, { text: "2" }), /1 = Joe Coffee, 2 min walk; 2 = Abraço, 3 min walk; 3 = Ten Bells/);
});

test("choice cards: a card that cannot be drawn is left out and the rest are drawn again as 1 of 2, 2 of 2", async () => {
  const { router, tries } = harness();
  let calls = 0;
  const flaky = async (html) => { calls++; if (/Abraço/.test(html) && calls < 3) throw new Error("renderer crashed"); return shoot(html); };
  const r = await cc.runChoiceTool("show_choices", places(3), { conversationId: C, fetchPhoto: okPhoto, shoot: flaky, channels: router, store });
  assert.equal(r.cards, 2);
  assert.match(r.note, /Not in the set .*Abraço/);
  const labels = shot.map(h => [/<h1>([^<]+)</.exec(h)[1], />(\d)<span class="of">OF (\d)</.exec(h).slice(1).join(" of ")]);
  // First pass drew 1 of 3 and 3 of 3; the kept set is drawn again, numbered as it really goes.
  assert.deepEqual(labels.slice(-2), [["Joe Coffee", "1 of 2"], ["Ten Bells", "2 of 2"]]);
  await cc.sendQueued(C, { router, withWords: true, route });
  assert.equal(tries[0].length, 2);
  assert.deepEqual(db.openChoiceFor(C).options.map(o => [o.n, o.name]), [[1, "Joe Coffee"], [2, "Ten Bells"]]);
});

test("choice cards: a card that cannot be kept at its address is left out the same way", async () => {
  const { router, tries } = harness();
  let n = 0;
  const bad = (a) => (++n === 2 ? { error: "too_big" } : store(a));
  const r = await cc.runChoiceTool("show_choices", places(3), { conversationId: C, fetchPhoto: okPhoto, shoot, channels: router, store: bad });
  assert.equal(r.cards, 2);
  await cc.sendQueued(C, { router, withWords: true, route });
  assert.equal(tries[0].length, 2);
});

test("choice cards on a line with no stack: no public copies, each card its own message, labels still 'N of X'", async () => {
  const { router, fake } = harness({ carousel: false });
  let kept = 0;
  const r = await cc.runChoiceTool("show_choices", places(2), { conversationId: C, fetchPhoto: okPhoto, shoot, channels: router, store: (a) => { kept++; return store(a); } });
  assert.equal(r.cards, 2);
  assert.equal(kept, 0);
  assert.match(shot[1], />2<span class="of">OF 2</);
  const out = await cc.sendQueued(C, { router, withWords: true, route });
  assert.equal(out.stacked, false);
  assert.deepEqual(fake.sent.map(s => s.media?.filename), ["reason-1.jpg", "reason-2.jpg"]);
  assert.deepEqual(db.openChoiceFor(C).handles.length, 2);
});

test("choice cards: the stack refused, the cards go one by one in order (today's way)", async () => {
  const { router, fake } = harness({ fail: () => ({ retryable: false, error: "Carousel messaging is only available on V2 lines" }) });
  await cc.runChoiceTool("show_choices", places(3), { conversationId: C, fetchPhoto: okPhoto, shoot, channels: router, store });
  const out = await cc.sendQueued(C, { router, withWords: true, route });
  assert.equal(out.sent, 3);
  assert.deepEqual(fake.sent.map(s => s.media?.filename), ["reason-1.jpg", "reason-2.jpg", "reason-3.jpg"]);
  assert.equal(db.openChoiceFor(C).state, "shown");
});

test("an inline reply on a stack is not read as card 1: it asks which unless the message says", async () => {
  const { router } = harness();
  await cc.runChoiceTool("show_choices", places(3), { conversationId: C, fetchPhoto: okPhoto, shoot, channels: router, store });
  await cc.sendQueued(C, { router, withWords: true, route });
  const line = cc.inboundChoiceLine(C, { text: "this one", replyTo: "STACK-1" });
  assert.match(line, /went as one swipeable set/);
  assert.doesNotMatch(line, /inline reply on card 1/);
  assert.match(cc.inboundChoiceLine(C, { text: "Loved an image" }), /ONE of the cards/);
});

test("Web history draws a stacked set as its cards, in order", async () => {
  const { router } = harness();
  await cc.runChoiceTool("show_choices", places(3), { conversationId: C, fetchPhoto: okPhoto, shoot, channels: router, store });
  await cc.sendQueued(C, { router, withWords: true, route });
  const row = db.db.prepare("SELECT * FROM outbox ORDER BY id DESC LIMIT 1").get();
  const media = JSON.parse(row.media);
  assert.equal(media.carousel.length, 3);
  assert.ok(media.pictures.every(p => /choice-cards/.test(p.file)));
  assert.match(media.historyText, /1\. Joe Coffee · 2\. Abraço · 3\. Ten Bells/);
});

// ---------- Linq ----------

test("Linq: a set is one message whose parts are the pictures by address, in order; 2 to 40", async () => {
  const calls = [];
  let answer = { status: 200, json: { chat_id: "chat-1", message: { id: "msg-1" } } };
  const linq = new LinqChannel({ fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(answer.json), { status: answer.status }); } });
  linq.missing = () => [];
  const urls = ["https://pages.example/a.jpg", "https://pages.example/b.jpg", "https://pages.example/c.jpg"];
  const ok = await linq.sendCarousel({ to: "+14155550123", mediaUrls: urls, chatId: "chat-1", idempotencyKey: "k1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.delivered.message_id, "msg-1");
  assert.match(calls[0].url, /\/v3\/chats\/chat-1\/messages$/);
  assert.deepEqual(calls[0].body.message.parts, urls.map(url => ({ type: "media", url })));
  assert.equal(linq.stackMax, 40);
  assert.equal((await linq.sendCarousel({ to: "+14155550123", mediaUrls: urls.slice(0, 1) })).ok, false);
  answer = { status: 400, json: { error: { message: "bad media" } } };
  const no = await linq.sendCarousel({ to: "+14155550123", mediaUrls: urls });
  assert.equal(no.ok, false);
  assert.equal(no.retryable, false);
});
