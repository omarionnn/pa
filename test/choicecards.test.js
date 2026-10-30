// Choice cards (src/choicecards.js): a few real options as numbered pictures, one bubble each.
//
// Nothing here reaches a network, a model or a browser: the photo fetch and the renderer are
// injected, and the "router" is a list that remembers what it was handed and in what order.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-choice-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CHOICE_GAP_MS = "0";

const cc = await import("../src/choicecards.js");
const db = await import("../src/db.js");
const { toolsFor } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const PHOTOS = ["https://shop.example/a.jpg", "https://shop.example/b.jpg", "https://shop.example/c.jpg"];
// The store listing each photo came from, as webLookup would read it.
const PAGES = ["https://shop.example/p/a", "https://shop.example/p/b", "https://shop.example/p/c"];
const LISTINGS = {
  [PAGES[0]]: { ok: true, title: "CeraVe Hydrating Facial Cleanser, 16 fl oz", text: "Hydrating Facial Cleanser. $15.99. Ships free.", images: [PHOTOS[0]] },
  [PAGES[1]]: { ok: true, title: "CeraVe Foaming Facial Cleanser 16 oz", text: "Price $17.49", images: [PHOTOS[1]] },
  [PAGES[2]]: { ok: true, title: "CeraVe Hydrating Cream-to-Foam Cleanser", text: "Now $16.99", images: [PHOTOS[2]] },
};
const lookup = async (u) => LISTINGS[u] ?? { ok: false };
const okPhoto = async () => ({ ok: true, mediaType: "image/jpeg", base64: Buffer.from("jpegbytes").toString("base64"), bytes: 9 });
const shoot = async (html) => Buffer.from(`JPEG:${html.length}`);
const input = () => ({
  kind: "shopping",
  options: [
    { name: "Hydrating Facial Cleanser", brand: "CeraVe", price: "$15.99", detail: "16 oz", why: "cheapest", image_url: PHOTOS[0] },
    { name: "Foaming Facial Cleanser", brand: "CeraVe", price: "$17.49", detail: "16 oz", image_url: PHOTOS[1] },
    { name: "Hydrating Cream-to-Foam Cleanser", brand: "CeraVe", price: "$16.99", image_url: PHOTOS[2] },
  ],
});
const ctx = (extra = {}) => ({ conversationId: C, fetchPhoto: okPhoto, shoot, lookup, ...extra });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  cc._setPlaceLook(async () => null);   // never a real model in the suite; the look tests set their own
  cc._setPlaceSearch(null);             // and never the paid picture search, whatever .env holds
  process.env.REASON_CHOICE_CARDS = "on";
  db.db.exec("DELETE FROM choice_sets; DELETE FROM seen_urls; DELETE FROM accounts; DELETE FROM place_photos;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.rememberSeenUrls(C, PAGES, { kind: "page" });
  PHOTOS.forEach((u, i) => db.rememberSeenUrls(C, [u], { kind: "search", from: PAGES[i] }));
  cc.takeQueued(C);
});

function fakeRouter({ failAt = null } = {}) {
  const sent = [];
  return {
    sent,
    async sendMedia(m) {
      if (failAt === sent.length + 1) return { ok: false, error: "provider said no" };
      sent.push(m);
      return { ok: true, delivered: { message_id: `H-${sent.length}` } };
    },
  };
}

test("off by default: nobody's model is told the tool exists, and the dispatch refuses", async () => {
  delete process.env.REASON_CHOICE_CARDS;
  assert.ok(!toolsFor(C).some(t => t.name === "show_choices"));
  const r = await cc.runChoiceTool("show_choices", input(), ctx());
  assert.equal(r.ok, false);
  process.env.REASON_CHOICE_CARDS = "on";
  assert.ok(toolsFor(C).some(t => t.name === "show_choices"));
});

test("owner: only the operator's conversation sees it", async () => {
  process.env.REASON_CHOICE_CARDS = "owner";
  assert.ok(toolsFor(C).some(t => t.name === "show_choices"));
  db.upsertAccount({ conversationId: "dm:sendblue:+13035550000", channel: "sendblue", address: "+13035550000", name: "Kofi", isOperator: false });
  assert.ok(!toolsFor("dm:sendblue:+13035550000").some(t => t.name === "show_choices"));
});

test("draws one card per option and sends them after the line, in order, each its own message", async () => {
  const r = await cc.runChoiceTool("show_choices", input(), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.cards, 3);
  assert.match(r.note, /one short line/);
  const router = fakeRouter();
  const out = await cc.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
  assert.equal(out.sent, 3);
  assert.deepEqual(router.sent.map(m => m.idempotencyKey), [1, 2, 3].map(n => `choice:${r.set_id}:${n}`));
  assert.ok(router.sent.every(m => m.text === "" && m.mimeType === "image/jpeg" && existsSync(m.file)));
  const set = db.openChoiceFor(C);
  assert.deepEqual(set.handles, ["H-1", "H-2", "H-3"]);
  assert.equal(set.state, "shown");
});

test("no words went out: no cards, and the set is not left open", async () => {
  await cc.runChoiceTool("show_choices", input(), ctx());
  const router = fakeRouter();
  await cc.sendQueued(C, { router, withWords: false, route: { channel: "sendblue", to: "+1" } });
  assert.equal(router.sent.length, 0);
  assert.equal(db.openChoiceFor(C), null);
});

test("a card that fails stops the rest, so the numbers never arrive out of order", async () => {
  await cc.runChoiceTool("show_choices", input(), ctx());
  const router = fakeRouter({ failAt: 2 });
  const out = await cc.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+1" } });
  assert.equal(out.sent, 1);
  assert.equal(db.openChoiceFor(C).state, "partial");
});

test("one photo missing: no cards at all, a numbered text list instead, numbers kept", async () => {
  const fetchPhoto = async ({ url }) => (url === PHOTOS[1] ? { ok: false, why: "404" } : okPhoto());
  const r = await cc.runChoiceTool("show_choices", input(), ctx({ fetchPhoto }));
  assert.equal(r.fallback, "text");
  assert.match(r.note, /1\. Hydrating Facial Cleanser — \$15\.99 — 16 oz \(cheapest\)\n2\. Foaming/);
  assert.equal(cc.takeQueued(C), null);
  assert.equal(db.openChoiceFor(C).state, "text");
});

test("an image address no tool returned is refused (never a picture typed from memory)", async () => {
  const bad = input();
  bad.options[2].image_url = "https://made.up/guess.jpg";
  const r = await cc.runChoiceTool("show_choices", bad, ctx());
  assert.equal(r.fallback, "text");
  assert.match(r.note, /did not come from a tool/);
});

test("the card: big number, name, price, the why, the wordmark; Night when they chose Night", () => {
  const html = cc.choiceCardHtml({ n: 3, name: "Joe <Coffee>", price: "$$", detail: "4 min", why: "closest", photo: "data:image/jpeg;base64,AA", kind: "places", theme: "night" });
  assert.match(html, /<div class="num">3<\/div>/);
  assert.match(html, /Joe &lt;Coffee&gt;/);
  assert.match(html, /#d46a5c/);
  assert.match(html, /closest/);
  assert.match(html, /wordmark/);
  assert.equal(cc.themeFor(C), "paper");
  db.setWebTheme(C, "night");
  assert.equal(cc.themeFor(C), "night");
});

// A real inbound tapback, as Sendblue delivered it to Omari's thread in October 2026: an ordinary
// text with the reaction written out, quoting the message it was on.
const REAL = "Loved “got it. i’ll remind you tuesday at 8pm, the night before the instalily onsite.”";

test("tapbacks arrive as words and are read as tapbacks", () => {
  assert.deepEqual(cc.readTapback(REAL), { verb: "Loved", image: false, quoted: "got it. i’ll remind you tuesday at 8pm, the night before the instalily onsite." });
  assert.deepEqual(cc.readTapback("Liked an image"), { verb: "Liked", image: true, quoted: null });
  assert.equal(cc.readTapback("Reacted 🔥 to an image").image, true);
  assert.equal(cc.readTapback("2"), null);
  assert.equal(cc.readTapback("I loved the second one"), null);
});

async function shown() {
  await cc.runChoiceTool("show_choices", input(), ctx());
  await cc.sendQueued(C, { router: fakeRouter(), withWords: true, route: { channel: "sendblue", to: "+1" } });
}

test("their next message is read with the numbers in front of the model", async () => {
  await shown();
  const line = cc.inboundChoiceLine(C, { text: "2" });
  assert.match(line, /1 = Hydrating Facial Cleanser, \$15\.99, 16 oz; 2 = Foaming Facial Cleanser/);
  assert.match(line, /by number, by how it looks, by name/);
});

test("an inline reply on card 3 is card 3, exactly", async () => {
  await shown();
  assert.match(cc.inboundChoiceLine(C, { text: "this one", replyTo: "H-3" }), /inline reply on card 3 \(Hydrating Cream-to-Foam Cleanser\)/);
  // A multi-part handle (_1) is the same message (test/parts.test.js).
  assert.match(cc.inboundChoiceLine(C, { text: "ok", replyTo: "H-2_1" }), /card 2/);
});

test("a tapback on a picture with several cards up: one of them, ask which — never a guess", async () => {
  await shown();
  const line = cc.inboundChoiceLine(C, { text: "Loved an image" });
  assert.match(line, /tapback on ONE of the cards, and the phone does not say which/);
  assert.doesNotMatch(line, /that is their pick/);
});

test("a tapback quoting an option's name is that option", async () => {
  await cc.runChoiceTool("show_choices", { ...input() }, ctx({ fetchPhoto: async () => ({ ok: false, why: "x" }) }));
  assert.match(cc.inboundChoiceLine(C, { text: "Loved “2. Foaming Facial Cleanser — $17.49 — 16 oz”" }), /naming option 2/);
});

test("the set lets go: after 12 hours, after three messages, or when a new set opens", async () => {
  await shown();
  for (let i = 0; i < db.CHOICE_READS; i++) assert.notEqual(cc.inboundChoiceLine(C, { text: "hm" }), "");
  assert.equal(cc.inboundChoiceLine(C, { text: "hm" }), "");
  await shown();
  assert.equal(cc.inboundChoiceLine(C, { text: "x", now: clock.now() + cc.CHOICE_TTL_MS + 1 }), "");
  await shown();
  const first = db.openChoiceFor(C).id;
  await shown();
  assert.notEqual(db.openChoiceFor(C).id, first);
});

test("nothing open, nothing said", () => {
  assert.equal(cc.inboundChoiceLine(C, { text: "2" }), "");
});

test("a kept card's address is its file name and nothing else", () => {
  assert.equal(cc.cardFile("../../etc/passwd"), null);
  assert.equal(cc.cardFile("0123456789abcdef0123.jpg"), join(process.env.REASON_DATA_DIR, "choice-cards", "0123456789abcdef0123.jpg"));
  assert.equal(cc.isCardFile("/etc/0123456789abcdef0123.jpg"), false);
});

test("on Reason Web the card is a picture in the thread, served from this machine", async () => {
  await cc.runChoiceTool("show_choices", input(), ctx());
  const q = cc.takeQueued(C);
  const { WebChannel } = await import("../src/channels/web.js");
  const w = new WebChannel();
  assert.equal(w.carriesFiles, false);
  process.env.REASON_WEB = "on";
  const { webOn } = await import("../src/web.js");
  if (webOn()) {
    assert.equal((await w.sendMedia({ to: "+1", file: "/tmp/deck.pdf" })).ok, false);
    assert.equal((await w.sendMedia({ to: "+1", file: q.cards[0].file })).ok, true);
  }
  assert.ok(readFileSync(q.cards[0].file).length);
});

test("no picture address, only the page: the page's own preview picture, if a tool found that page", async () => {
  const PAGE = "https://www.cerave.com/skincare/cleansers/hydrating-facial-cleanser";
  db.rememberSeenUrls(C, [PAGE], { kind: "page" });
  const html = `<html><head><meta property="og:image" content="/-/media/front.jpg?a=1&amp;b=2"></head></html>`;
  const fetchImpl = async (u) => ({ ok: true, url: u, text: async () => html });
  assert.equal(await cc.pagePhoto(PAGE, { fetchImpl }), "https://www.cerave.com/-/media/front.jpg?a=1&b=2");
  assert.equal(await cc.pagePhoto("http://10.0.0.1/x", { fetchImpl }), null);
  const seen = [];
  const fetchPhoto = async ({ url }) => { seen.push(url); return okPhoto(); };
  const one = input();
  delete one.options[0].image_url;
  one.options[0].url = PAGE;
  const r = await cc.runChoiceTool("show_choices", one, ctx({ fetchPhoto, fetchImpl }));
  assert.equal(r.cards, 3);
  assert.ok(seen.includes("https://www.cerave.com/-/media/front.jpg?a=1&b=2"));
});

// ---------- the listing check (owner, 2026-10-30: "16 oz" was drawn over the 12 oz bottle) ----------

test("listing check: the CeraVe sample — 16 oz over a photo of the 12 oz bottle is left off, never shown", () => {
  const photo = "https://www.cerave.com/-/media/cleansers/cerave_daily_hydrating-cleanser_12oz_front-700x700-v2.jpg";
  const listing = { title: "Hydrating Facial Cleanser 12 fl oz | CeraVe", text: "$15.99", images: [photo] };
  const { option, dropped } = cc.checkAgainstListing({ name: "Hydrating Facial Cleanser", price: "$15.99", detail: "16 oz · normal to dry" }, listing, { photoUrl: photo });
  assert.equal(option.detail, "normal to dry");
  assert.equal(option.price, "$15.99");
  assert.match(dropped.join(";"), /size 16 oz \(the listing says 12 fl oz\)/);
});

test("listing check: a size the title agrees with but the photo's file name contradicts is left off too", () => {
  const photo = "https://shop.example/img/cleanser_12oz_front.jpg";
  const { option, dropped } = cc.checkAgainstListing({ name: "Hydrating Facial Cleanser", detail: "16 oz" }, { title: "Hydrating Facial Cleanser 16 oz", text: "" }, { photoUrl: photo });
  assert.equal(option.detail, "");
  assert.match(dropped[0], /the photo is the 12oz/);
});

test("listing check: matching price and size stay; a price the listing never shows goes", () => {
  const listing = { title: "CeraVe Foaming Facial Cleanser, 16 Fl Oz (473 mL)", text: "List $19.99 · Now $17.49" };
  const ok = cc.checkAgainstListing({ name: "Foaming Facial Cleanser", price: "$17.49", detail: "16 oz" }, listing, { photoUrl: "https://shop.example/x.jpg" });
  assert.deepEqual([ok.option.price, ok.option.detail, ok.dropped.length], ["$17.49", "16 oz", 0]);
  const bad = cc.checkAgainstListing({ name: "Foaming Facial Cleanser", price: "$14.99", detail: "473 ml" }, listing);
  assert.deepEqual([bad.option.price, bad.option.detail], ["", "473 ml"]);
  assert.match(bad.dropped[0], /price \$14\.99 \(not on the listing\)/);
});

test("listing check: no listing, a photo from elsewhere, or a different product — price and size both left off", () => {
  const o = { name: "Hydrating Facial Cleanser 16 oz", price: "$15.99", detail: "16 oz · gentle" };
  for (const [listing, opts, why] of [
    [null, {}, /no store listing/],
    [{ title: "Hydrating Facial Cleanser 16 oz", text: "$15.99" }, { photoFromListing: false }, /photo is not from its listing/],
    [{ title: "Neutrogena Hydro Boost Water Gel 16 oz", text: "$15.99" }, {}, /different product/],
  ]) {
    const r = cc.checkAgainstListing(o, listing, opts);
    assert.deepEqual([r.option.name, r.option.price, r.option.detail], ["Hydrating Facial Cleanser", "", "gentle"]);
    assert.match(r.dropped.join(";"), why);
  }
  // A price level like "$$" is not an amount and is never checked.
  assert.equal(cc.checkAgainstListing({ name: "Joe", price: "$$" }, null).option.price, "$$");
});

test("listing check runs on the real path: the listing the PHOTO came from is read, and the card never shows what it does not back", async () => {
  LISTINGS[PAGES[1]] = { ok: true, title: "CeraVe Foaming Facial Cleanser 12 oz", text: "$13.99", images: [PHOTOS[1]] };
  const read = [];
  const htmls = [];
  rmSync(join(process.env.REASON_DATA_DIR, "choice-cards"), { recursive: true, force: true });
  try {
    const r = await cc.runChoiceTool("show_choices", input(), ctx({ lookup: async (u) => { read.push(u); return lookup(u); }, shoot: async (h) => { htmls.push(h); return Buffer.from("JPEG"); } }));
    assert.equal(r.ok, true);
    assert.deepEqual(read.sort(), [...PAGES].sort());
    assert.match(r.note, /option 2: price \$17\.49 \(not on the listing\); option 2: size 16 oz \(the listing says 12 oz\)/);
    assert.ok(!/\$17\.49|16 oz/.test(htmls[1]) && /\$15\.99/.test(htmls[0]) && /16 oz/.test(htmls[0]));
    db.setChoiceShown(r.set_id, { handles: [] });
    const set = db.openChoiceFor(C, clock.now());
    assert.deepEqual([set.options[1].price, set.options[1].detail], ["", ""]);
  } finally {
    LISTINGS[PAGES[1]] = { ok: true, title: "CeraVe Foaming Facial Cleanser 16 oz", text: "Price $17.49", images: [PHOTOS[1]] };
  }
});

test("listing check is for products only: a place's rating and walk are never held up against a page", async () => {
  let looked = 0;
  const places = { kind: "places", options: input().options.map(o => ({ ...o, price: "$$", detail: "4.6 ★ · 3 min walk" })) };
  // The venue page may be read for its pictures (placePhoto) — never to judge the words on the card.
  const r = await cc.runChoiceTool("show_choices", places, ctx({ lookup: async () => { looked++; return { ok: true, title: "Nothing alike", text: "$1", images: [] }; } }));
  assert.equal(r.ok, true);
  assert.ok(!/Left off/.test(r.note));
  db.setChoiceShown(r.set_id, { handles: [] });
  assert.equal(db.openChoiceFor(C, clock.now()).options[0].detail, "4.6 ★ · 3 min walk");
});

test("listing check (review): a price with no $ is still checked, other currencies count, and a size in the price or why is held up too", () => {
  const listing = { title: "Hydrating Facial Cleanser 12 fl oz", text: "Our price: 15.99 USD · was £19" };
  const a = cc.checkAgainstListing({ name: "Hydrating Facial Cleanser", price: "15.99 (16-fl-oz)", why: "16 oz value" }, listing);
  assert.deepEqual([a.option.price, a.option.why], ["15.99", "value"]);
  const b = cc.checkAgainstListing({ name: "Hydrating Facial Cleanser", price: "USD 14" }, listing);
  assert.equal(b.option.price, "");
  assert.equal(cc.checkAgainstListing({ name: "Hydrating Facial Cleanser", price: "17.49" }, null).option.price, "");
  assert.deepEqual(cc.pricesIn("$1,299.00 or £12 or 15.99 € or USD 7"), [1299, 12, 15.99, 7]);
});

// ---------- a place's photo: the room, not the cup (owner, 2026-10-30) ----------

const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
const photosBy = (dims) => async ({ url }) => dims[url] ? { ok: true, mediaType: "image/png", base64: png(...dims[url]).toString("base64") } : { ok: false, why: "404" };

test("imageDims reads PNG and JPEG sizes from their first bytes; garbage is null", () => {
  assert.deepEqual(cc.imageDims(png(1600, 900)), { w: 1600, h: 900 });
  assert.deepEqual(cc.imageDims(jpeg(1200, 800)), { w: 1200, h: 800 });
  assert.equal(cc.imageDims(Buffer.from("hello")), null);
});

test("roomHint: an interior beats a storefront beats unknown beats a cup, logo or menu", () => {
  const h = (u) => cc.roomHint(`https://joe.example/img/${u}.jpg`);
  assert.deepEqual([h("flatiron-interior-seating"), h("storefront-23rd"), h("IMG_4411"), h("latte-art-cup"), h("logo"), h("fall-menu")], [3, 1, 0, -3, -3, -3]);
  assert.equal(cc.roomHint("https://lc.example/LC_BARISTA_COUNTER_DSC5164.jpg"), 3);
});

test("places: the interior on the venue's page is chosen over the cup the model passed", async () => {
  const page = "https://joe.example/locations/flatiron";
  const cup = "https://joe.example/img/latte-cup.jpg";
  const inside = "https://joe.example/img/flatiron-interior.jpg";
  const logo = "https://joe.example/img/logo.png";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [cup, logo, inside], { kind: "page", from: page });
  const r = await cc.placePhoto(C, { name: "Joe Coffee", image_url: cup, url: page }, { fetchPhoto: photosBy({ [cup]: [800, 1000], [inside]: [1600, 1000], [logo]: [200, 200] }), lookup: async () => null });
  assert.equal(r.ok, true);
  assert.equal(r.url, inside);
});

test("places: no interior — the storefront wins; with no hints at all, the wide big shot beats the tall and the tiny", async () => {
  const page = "https://cafe.example/";
  const front = "https://cafe.example/storefront.jpg", cup = "https://cafe.example/cappuccino.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [cup, front], { kind: "page", from: page });
  const a = await cc.placePhoto(C, { name: "Cafe", url: page }, { fetchPhoto: photosBy({ [front]: [1200, 900], [cup]: [1200, 900] }), lookup: async () => null });
  assert.equal(a.url, front);
  const p2 = "https://b.example/", tall = "https://b.example/a1.jpg", wide = "https://b.example/a2.jpg", tiny = "https://b.example/a3.jpg";
  db.rememberSeenUrls(C, [p2], { kind: "page" });
  db.rememberSeenUrls(C, [tall, tiny, wide], { kind: "page", from: p2 });
  const b = await cc.placePhoto(C, { name: "B", url: p2 }, { fetchPhoto: photosBy({ [tall]: [800, 1200], [wide]: [1500, 900], [tiny]: [120, 80] }), lookup: async () => null });
  assert.equal(b.url, wide);
});

test("places: few pictures known — the venue page is read once for its own; a broken one is skipped, never drawn", async () => {
  const page = "https://lc.example/nomad";
  const inside = "https://lc.example/img/nomad-inside.jpg", broken = "https://lc.example/img/bar-dead.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  let reads = 0;
  const r = await cc.placePhoto(C, { name: "La Colombe", url: page }, {
    fetchPhoto: photosBy({ [inside]: [1400, 900] }),
    lookup: async () => { reads++; return { ok: true, images: [broken, inside] }; },
  });
  assert.equal(reads, 1);
  assert.equal(r.url, inside);
  assert.ok(db.hasSeenUrl(C, inside));
  const none = await cc.placePhoto(C, { name: "Nowhere", url: "https://never.example/" }, { fetchPhoto: photosBy({}), lookup: async () => null });
  assert.equal(none.ok, false);
});

test("places on the real path: the card is drawn with the interior, and a place with nothing usable falls back to its passed photo", async () => {
  const page = "https://joe.example/loc";
  const cup = "https://joe.example/c/latte.jpg", inside = "https://joe.example/c/interior.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [cup, inside], { kind: "page", from: page });
  const drawn = [];
  const fetchPhoto = async ({ url }) => ({ ok: true, mediaType: "image/png", base64: png(url === inside ? 1600 : 700, 900).toString("base64") + (url === inside ? "" : "") , tag: url });
  const places = { kind: "places", options: [
    { name: "Joe", image_url: cup, url: page, price: "$$" },
    { name: "Other", image_url: PHOTOS[1], price: "$$" },
  ] };
  const r = await cc.runChoiceTool("show_choices", places, ctx({ fetchPhoto, lookup: async () => null, shoot: async (h) => { drawn.push(h); return Buffer.from("J"); } }));
  assert.equal(r.ok, true);
  assert.equal(r.fallback, undefined);
  assert.equal(drawn.length, 2);
  assert.ok(drawn[0].includes(png(1600, 900).toString("base64")));
});

test("a CDN's width copies of one photo are one candidate (the biggest); banners and coffee bags are not rooms", () => {
  assert.deepEqual(cc.biggestCopies(["https://j.example/a.jpg?v=1&width=165", "https://j.example/b.jpg", "https://j.example/a.jpg?v=1&width=360"]), ["https://j.example/a.jpg?v=1&width=360", "https://j.example/b.jpg"]);
  assert.equal(cc.roomHint("https://b.example/BL_Scrubs-Campaign_Homepage-Banner_1600x810.jpg"), -3);
  assert.equal(cc.roomHint("https://b.example/BL_2022RetailBags_105466.jpg"), -3);
});

test("places: a chain's or directory's page lists the neighbours — even one named 'interior' far down the page is not this place", async () => {
  const page = "https://chain.example/flatiron";
  const og = "https://chain.example/flatiron-hero.jpg";
  const filler = [1, 2, 3, 4, 5].map(n => `https://chain.example/nav-${n}.jpg`);
  const otherBranch = "https://chain.example/Dumbo_2.jpg", theirRoom = "https://chain.example/bluestone-interior.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [og, ...filler, otherBranch, theirRoom], { kind: "page", from: page });
  const dims = { [og]: [1000, 1000], [otherBranch]: [2000, 1000], [theirRoom]: [1600, 1000], ...Object.fromEntries(filler.map(u => [u, [900, 1200]])) };
  const a = await cc.placePhoto(C, { name: "Chain Flatiron", url: page }, { fetchPhoto: photosBy(dims), lookup: async () => null });
  assert.equal(a.url, og);
});

test("size copies in the path collapse too; a Street View frame is an outside look, not a thumbnail to skip", () => {
  const m = (w) => `https://media.example/media/w/${w}/abc123.webp`;
  assert.deepEqual(cc.biggestCopies([m(400), m(1600), m(800), "https://media.example/media/w/800/def.webp"]), [m(1600), "https://media.example/media/w/800/def.webp"]);
  assert.equal(cc.roomHint("https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=x&w=1024&h=602"), 1);
});

test("places: when the only picture that loads is the logo, the selector gives up — never a logo card", async () => {
  const page = "https://dir.example/shop/1";
  const logo = "https://dir.example/images/logo.png", photo = "https://cdn-down.example/shops/1/0.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [photo, logo], { kind: "page", from: page });
  const r = await cc.placePhoto(C, { name: "Shop", url: page }, { fetchPhoto: photosBy({ [logo]: [1200, 600] }), lookup: async () => null });
  assert.equal(r.ok, false);
});

test("places: two branches whose pages lead with the same chain photo get different photos — never the same picture twice in a set", async () => {
  const pa = "https://dir.example/joe-flatiron", pb = "https://dir.example/joe-union-square";
  const chain = (w) => `https://media.dir.example/media/w/${w}/chain.webp`;
  const a2 = "https://media.dir.example/media/w/800/flatiron-2.webp", b2 = "https://media.dir.example/media/w/800/union-2.webp";
  db.rememberSeenUrls(C, [pa, pb], { kind: "page" });
  db.rememberSeenUrls(C, [chain(1600), a2], { kind: "page", from: pa });
  const pages = { [pa]: { ok: true, images: [chain(1600), a2] }, [pb]: { ok: true, images: [chain(1600), chain(800), b2] } };
  const fetchPhoto = photosBy({ [chain(1600)]: [1600, 1000], [chain(800)]: [800, 500], [a2]: [800, 600], [b2]: [800, 600] });
  const taken = new Set();
  const a = await cc.placePhoto(C, { name: "Joe Flatiron", url: pa }, { fetchPhoto, lookup: async (u) => pages[u], taken });
  const b = await cc.placePhoto(C, { name: "Joe Union Square", url: pb }, { fetchPhoto, lookup: async (u) => pages[u], taken });
  assert.equal(a.url, chain(1600));
  assert.equal(b.url, b2);
});

test("places, looked at: the inside wins over a cup and a storefront; another business's sign and a logo are never used", async () => {
  const page = "https://dir.example/joe-us";
  const [cup, front, inside, irving] = ["a", "b", "c", "d"].map(x => `https://media.dir.example/${x}.webp`);
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [cup, irving, front, inside], { kind: "page", from: page });
  const dims = { [cup]: [1600, 1000], [front]: [1200, 900], [inside]: [1000, 1000], [irving]: [1600, 1000] };
  const said = { [cup]: "product_or_food", [front]: "outside", [inside]: "inside", [irving]: "outside" };
  let asked = null;
  const look = async ({ name, photos }) => { asked = { name, n: photos.length }; return new Map(photos.map((p, k) => [k + 1, { shows: said[p.u], other: p.u === irving }])); };
  const ranked = await cc.rankPlacePhotos(C, { name: "Joe Coffee", url: page }, { fetchPhoto: photosBy(dims), lookup: async () => null, look });
  assert.deepEqual(asked, { name: "Joe Coffee", n: 4 });
  assert.deepEqual(ranked.map(x => x.u), [inside, front, cup]);
  // No inside photo: the storefront, still never the other cafe or the cup.
  const r2 = await cc.rankPlacePhotos(C, { name: "Joe Coffee", url: page }, { fetchPhoto: photosBy({ [cup]: dims[cup], [front]: dims[front], [irving]: dims[irving] }), lookup: async () => null, look });
  assert.deepEqual(r2.map(x => x.u), [front, cup]);
  // Only its own coffee: that, as the last resort — never the other cafe.
  const r3 = await cc.rankPlacePhotos(C, { name: "Joe Coffee", url: page }, { fetchPhoto: photosBy({ [cup]: dims[cup], [irving]: dims[irving] }), lookup: async () => null, look });
  assert.deepEqual(r3.map(x => x.u), [cup]);
});

test("places: the ordinary fallback never repeats a photo already on a card — the set goes to a numbered list instead", async () => {
  const shared = "https://chain.example/og.jpg";
  db.rememberSeenUrls(C, [shared], { kind: "search" });
  const places = { kind: "places", options: [{ name: "A", image_url: shared }, { name: "B", image_url: shared }] };
  const r = await cc.runChoiceTool("show_choices", places, ctx({ fetchPhoto: async ({ url }) => url === shared ? { ok: true, mediaType: "image/png", base64: png(1200, 900).toString("base64") } : { ok: false }, lookup: async () => null }));
  assert.equal(r.fallback, "text");
  assert.match(r.note, /already on another card/);
});

test("places: a look that fails keeps the address-and-shape order (never worse than before), and the real path logs what the photo shows", async () => {
  const page = "https://dir.example/p";
  const a = "https://dir.example/x1.jpg", b = "https://dir.example/x2.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [a, b], { kind: "page", from: page });
  const ranked = await cc.rankPlacePhotos(C, { name: "P", url: page }, { fetchPhoto: photosBy({ [a]: [800, 1200], [b]: [1600, 900] }), lookup: async () => null, look: async () => null });
  assert.deepEqual(ranked.map(x => x.u), [b, a]);
  const logs = [];
  const places = { kind: "places", options: [{ name: "P", url: page }, { name: "Q", image_url: PHOTOS[1] }] };
  const r = await cc.runChoiceTool("show_choices", places, ctx({ fetchPhoto: photosBy({ [a]: [800, 1200], [b]: [1600, 900], [PHOTOS[1]]: [900, 900] }), lookup: async () => null, log: (x) => logs.push(x),
    lookPlace: async ({ photos }) => new Map(photos.map((p, k) => [k + 1, { shows: p.u === a ? "inside" : "outside", other: false }])) }));
  assert.equal(r.ok, true);
  assert.equal(logs.find(x => x.choice_place_photo && x.n === 1).shows, "inside");
});

test("lookAtPlacePhotos: one CLI call with every photo as an image block, on the subscription's side-call path; a bad answer is null", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { ok: true, envelope: { structured_output: { photos: [{ n: 1, shows: "inside", room: 3, other_business: false, own_name: false }, { n: 2, shows: "logo_or_menu", room: 0, other_business: false, own_name: false }, { n: 3, shows: "inside", room: 1, other_business: false, own_name: false }, { n: 4, shows: "outside", room: 3, other_business: false, own_name: false }, { n: 5, shows: "outside", room: 3, other_business: false, own_name: true }] } } }; };
  const seen = await cc.lookAtPlacePhotos({ name: "Joe", photos: [{ mediaType: "image/jpeg", base64: "AA" }, { mediaType: "image/png", base64: "BB" }] }, { run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].images.length, 2);
  assert.equal(calls[0].images[1].source.media_type, "image/png");
  assert.equal(calls[0].feature, "place_photo");
  assert.ok(calls[0].jsonSchema);
  // An "inside" with only a sliver of room in view (cups on a window ledge) is not counted as a room.
  // A front without this place's name on it can't be shown as this place (a directory's neighbours).
  assert.deepEqual([...seen.entries()], [[1, { shows: "inside", room: 3, other: false }], [2, { shows: "logo_or_menu", room: 0, other: false }], [3, { shows: "other", room: 1, other: false }], [4, { shows: "outside", room: 3, other: true }], [5, { shows: "outside", room: 3, other: false }]]);
  assert.equal(await cc.lookAtPlacePhotos({ name: "J", photos: [{ mediaType: "image/jpeg", base64: "A" }] }, { run: async () => ({ ok: false }) }), null);
});

test("places: a directory's strip of Street View frames further down is the neighbours — never this place's photo", async () => {
  const page = "https://dir.example/cafes/joe";
  const sv = (id) => `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=${id}&w=1024&h=602`;
  const own = sv("JOE"), [n1, n2, n3, n4] = ["BLUESTONE", "DEVOCION", "X", "Y"].map(sv);
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, ["https://dir.example/logo.png", own, "https://dir.example/a.jpg", "https://dir.example/b.jpg", n1, n2, n3, n4], { kind: "page", from: page });
  const fetched = [];
  const fetchPhoto = async ({ url }) => { fetched.push(url); return { ok: true, mediaType: "image/png", base64: png(1024, 602 + fetched.length).toString("base64") }; };
  await cc.rankPlacePhotos(C, { name: "Joe", url: page }, { fetchPhoto, lookup: async () => null });
  assert.ok(fetched.includes(own));
  assert.ok(![n1, n2, n3, n4].some(u => fetched.includes(u)));
});

test("review: the fallback never draws a photo the look rejected; a photo left out of the answer is not trusted; two street views are two photos", async () => {
  const page = "https://dir.example/x";
  const sign = "https://dir.example/other-cafe.jpg";
  db.rememberSeenUrls(C, [page, sign], { kind: "page" });
  db.rememberSeenUrls(C, [sign], { kind: "page", from: page });
  const fetchPhoto = photosBy({ [sign]: [1600, 1000], [PHOTOS[1]]: [900, 700] });
  const look = async ({ photos }) => new Map(photos.map((p, k) => [k + 1, { shows: "outside", room: 3, other: true }]));
  const places = { kind: "places", options: [{ name: "X", image_url: sign, url: page }, { name: "Q", image_url: PHOTOS[1] }] };
  const r = await cc.runChoiceTool("show_choices", places, ctx({ fetchPhoto, lookup: async () => null, lookPlace: look }));
  assert.equal(r.fallback, "text");
  assert.match(r.note, /another business or a logo/);
  const a = "https://dir.example/a.jpg", b = "https://dir.example/b.jpg", p2 = "https://dir.example/y";
  db.rememberSeenUrls(C, [p2], { kind: "page" });
  db.rememberSeenUrls(C, [a, b], { kind: "page", from: p2 });
  const ranked = await cc.rankPlacePhotos(C, { name: "Y", url: p2 }, { fetchPhoto: photosBy({ [a]: [1600, 900], [b]: [800, 800] }), lookup: async () => null, look: async () => new Map([[2, { shows: "inside", room: 3, other: false }]]) });
  assert.deepEqual(ranked.map(x => x.u), [b]);
  const sv = (id) => `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=${id}&w=1024`;
  const taken = new Set();
  assert.equal(cc.pickPlacePhoto([{ u: sv("A"), sum: "1", uri: "u1" }], taken).ok, true);
  assert.equal(cc.pickPlacePhoto([{ u: sv("B"), sum: "2", uri: "u2" }], taken).ok, true);
});

test("a place page read that comes back with no pictures (Parallel Extract on live) is read again plainly for them", async () => {
  const plainCalls = [];
  const words = { ok: true, title: "Bluestone", text: "words", images: [], provider: "parallel" };
  const html = { ok: true, title: "Bluestone", text: "words", images: ["https://cdn.example/counter.jpg"] };
  const r = await cc.readPlacePage("https://dir.example/b", { read: async () => words, plain: async (u) => { plainCalls.push(u); return html; } });
  assert.deepEqual(r.images, ["https://cdn.example/counter.jpg"]);
  assert.deepEqual(plainCalls, ["https://dir.example/b"]);
  const withPics = { ok: true, images: ["https://cdn.example/a.jpg"] };
  assert.equal(await cc.readPlacePage("https://dir.example/c", { read: async () => withPics, plain: async () => { throw new Error("not called"); } }), withPics);
  assert.equal((await cc.readPlacePage("https://dir.example/d", { read: async () => words, plain: async () => ({ ok: false }) })).text, "words");
  // A read that already WAS the plain one, or an http page, is not fetched again.
  const no = async () => { throw new Error("not called"); };
  assert.equal((await cc.readPlacePage("https://dir.example/e", { read: async () => ({ ok: true, images: [] }), plain: no })).ok, true);
  assert.equal((await cc.readPlacePage("http://dir.example/f", { read: async () => words, plain: no })).text, "words");
});

// ---------- "<name> interior" search + the per-place cache ----------

test("interior search: asks for '<name> <area> interior', keeps only results naming THIS place and its area, and marks them seen", async () => {
  let asked = null;
  const client = { imageSearch: async (a) => { asked = a; return { ok: true, results: [
    { image_url: "https://img.example/1.jpg", page_url: "https://yelp.example/biz/devocion-new-york-flatiron", title: "Devoción Flatiron interior" },
    { image_url: "https://img.example/2.jpg", page_url: "https://yelp.example/biz/devocion-brooklyn", title: "Devoción Williamsburg" },
    { image_url: "https://img.example/3.jpg", page_url: "https://x.example/blue-bottle", title: "Blue Bottle Flatiron" },
  ] }; } };
  const keep = await cc.interiorSearch(C, { name: "Devoción", brand: "Flatiron" }, client);
  assert.deepEqual(asked.queries, ["Devoción Flatiron interior"]);
  assert.deepEqual(keep, ["https://img.example/1.jpg"]);
  assert.ok(db.hasSeenUrl(C, "https://img.example/1.jpg"));
  assert.deepEqual(await cc.interiorSearch(C, { name: "X" }, null), []);
});

test("interior search runs only when the place's own pictures have no inside shot, and its inside photo then leads", async () => {
  const page = "https://dir.example/dev";
  const front = "https://dir.example/front.jpg", inside = "https://img.example/dev-room.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [front], { kind: "page", from: page });
  let searches = 0;
  const client = { imageSearch: async () => { searches++; return { ok: true, results: [{ image_url: inside, page_url: "https://yelp.example/devocion-flatiron", title: "Devoción Flatiron" }] }; } };
  const look = async ({ photos }) => new Map(photos.map((p, k) => [k + 1, p.u === inside ? { shows: "inside", room: 3, other: false } : { shows: "outside", room: 3, other: false }]));
  const fetchPhoto = photosBy({ [front]: [1200, 900], [inside]: [1600, 1000] });
  const r = await cc.rankPlacePhotos(C, { name: "Devoción", brand: "Flatiron", url: page }, { fetchPhoto, lookup: async () => null, look, search: client });
  assert.deepEqual(r.map(x => x.u), [inside, front]);
  assert.equal(searches, 1);
  const look2 = async ({ photos }) => new Map(photos.map((p, k) => [k + 1, { shows: "inside", room: 3, other: false }]));
  await cc.rankPlacePhotos(C, { name: "Devoción", brand: "Flatiron", url: page }, { fetchPhoto, lookup: async () => null, look: look2, search: client });
  assert.equal(searches, 1);
});

test("the chosen place photo is kept per place: the next set reuses it with no page read, search or look", async () => {
  const page = "https://dir.example/blue";
  const room = "https://dir.example/room.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [room], { kind: "page", from: page });
  const looked = [];
  const lookPlace = async ({ photos }) => { looked.push(...photos.map(p => p.u)); return new Map(photos.map((p, k) => [k + 1, { shows: "inside", room: 3, other: false }])); };
  const fetchPhoto = photosBy({ [room]: [1600, 1000], [PHOTOS[1]]: [900, 900] });
  const places = { kind: "places", options: [{ name: "Blue", url: page }, { name: "Q", image_url: PHOTOS[1] }] };
  const logs = [];
  await cc.runChoiceTool("show_choices", places, ctx({ fetchPhoto, lookup: async () => null, lookPlace, log: (x) => logs.push(x) }));
  assert.equal(db.placePhotoFor(cc.placeKey(C, { url: page }), 0).url, room);
  looked.length = 0;
  cc.takeQueued(C);
  await cc.runChoiceTool("show_choices", places, ctx({ fetchPhoto, lookup: async () => { throw new Error("no read"); }, lookPlace, log: (x) => logs.push(x) }));
  assert.ok(!looked.includes(room));   // the cached place is not read or looked at again
  assert.ok(logs.some(x => x.choice_place_photo && x.n === 1 && x.cached === true));
  // Older than the keep: looked at again.
  clock.skip(cc.PLACE_PHOTO_TTL_MS + 1);
  assert.equal(db.placePhotoFor(cc.placeKey(C, { url: page }), clock.now() - cc.PLACE_PHOTO_TTL_MS), null);
});

test("review: no area → no search; a name must match as a word; cache keys are per person and never a bare homepage or an area-less name; an unlooked photo is not kept", async () => {
  let calls = 0;
  const client = { imageSearch: async () => { calls++; return { ok: true, results: [{ image_url: "https://i.example/j.jpg", page_url: "https://y.example/joes-pizza-flatiron", title: "Joe's Pizza Flatiron" }, { image_url: "https://i.example/k.jpg", page_url: "https://y.example/x", title: "Joey Flatiron cafe" }] }; } };
  assert.deepEqual(await cc.interiorSearch(C, { name: "Joe" }, client), []);
  assert.equal(calls, 0);
  assert.deepEqual(await cc.interiorSearch(C, { name: "Joey", brand: "Flatiron" }, client), ["https://i.example/k.jpg"]);
  assert.notEqual(cc.placeKey(C, { url: "https://dir.example/joe" }), cc.placeKey("dm:someone", { url: "https://dir.example/joe" }));
  assert.equal(cc.placeKey(C, { url: "https://bluebottlecoffee.com/", name: "Blue Bottle" }), null);
  assert.equal(cc.placeKey(C, { name: "Blue Bottle" }), null);
  assert.ok(cc.placeKey(C, { url: "https://bluebottlecoffee.com/", name: "Blue Bottle", brand: "Flatiron" }));
  const page = "https://dir.example/unlooked", pic = "https://dir.example/u.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [pic], { kind: "page", from: page });
  await cc.runChoiceTool("show_choices", { kind: "places", options: [{ name: "U", url: page }, { name: "Q", image_url: PHOTOS[1] }] }, ctx({ fetchPhoto: photosBy({ [pic]: [1600, 900], [PHOTOS[1]]: [900, 900] }), lookup: async () => null }));
  assert.equal(db.placePhotoFor(cc.placeKey(C, { url: page }), 0), null);
});

test("review: a look that failed is not followed by a search (no second wait)", async () => {
  let calls = 0;
  const client = { imageSearch: async () => { calls++; return { ok: true, results: [] }; } };
  const page = "https://dir.example/lf", pic = "https://dir.example/lf.jpg";
  db.rememberSeenUrls(C, [page], { kind: "page" });
  db.rememberSeenUrls(C, [pic], { kind: "page", from: page });
  const r = await cc.rankPlacePhotos(C, { name: "LF", brand: "Flatiron", url: page }, { fetchPhoto: photosBy({ [pic]: [1600, 900] }), lookup: async () => null, look: async () => null, search: client });
  assert.equal(r.length, 1);
  assert.equal(calls, 0);
});
