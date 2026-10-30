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
  process.env.REASON_CHOICE_CARDS = "on";
  db.db.exec("DELETE FROM choice_sets; DELETE FROM seen_urls; DELETE FROM accounts;");
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
  const r = await cc.runChoiceTool("show_choices", places, ctx({ lookup: async () => { looked++; return null; } }));
  assert.equal(r.ok, true);
  assert.equal(looked, 0);
  db.setChoiceShown(r.set_id, { handles: [] });
  assert.equal(db.openChoiceFor(C, clock.now()).options[0].detail, "4.6 ★ · 3 min walk");
});
