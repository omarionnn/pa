// The owner's CeraVe ask, 2026-10-31: "Buy me the Cerave face wash" then "Can you show me options"
// came back as a text list (two Ulta sizes had no picture, so the whole set fell back) with a
// "(compared: a seller $18.99, …)" line glued under it. Nothing here reaches a network or a model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cc1031-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CHOICE_GAP_MS = "0";

const cc = await import("../src/choicecards.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const ULTA = (sku) => `https://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=${sku}`;
const okPhoto = async () => ({ ok: true, mediaType: "image/jpeg", base64: Buffer.from("jpegbytes").toString("base64"), bytes: 9 });
const shoot = async (html) => Buffer.from(`JPEG:${html.length}`);
const pagePhotoOf = async (u) => `https://media.ulta.com/i/ulta/${new URL(u).searchParams.get("sku")}?w=500`;
const html = (sku, price) => `<html><head><meta property="og:image" content="https://media.ulta.com/i/ulta/${sku}?w=500"><title>Foaming Facial Cleanser | Ulta</title>
<script type="application/ld+json">{"@type":"Product","name":"Foaming Facial Cleanser","offers":{"price":"${price}","priceCurrency":"USD"}}</script></head></html>`;
const PAGES = { 2541605: "18.99", 2254420: "16.99", 2575575: "15.99" };
const fetchImpl = async (u) => {
  const sku = new URL(u).searchParams.get("sku");
  return { ok: true, status: 200, url: u, headers: { get: () => null }, text: async () => html(sku, PAGES[sku]) };
};
// What he got: three Ulta sizes, page urls only, prices from offer_check.
const asked = () => ({ kind: "shopping", options: [
  { name: "CeraVe Foaming Facial Cleanser 16 oz", brand: "Ulta", price: "$18.99", detail: "16 oz", url: ULTA(2541605), why: "best value" },
  { name: "CeraVe Foaming Facial Cleanser 12 oz", brand: "Ulta", price: "$16.99", detail: "12 oz", url: ULTA(2254420), why: "middle size" },
  { name: "CeraVe Foaming Facial Cleanser 8 oz", brand: "Ulta", price: "$15.99", detail: "8 oz", url: ULTA(2575575), why: "cheapest up front" },
] });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  cc._setPlaceLook(async () => null);
  cc._setPlaceSearch(null);
  cc._setProductLook(async () => null);   // never a real model; the look tests set their own
  process.env.REASON_CHOICE_CARDS = "owner";
  db.db.exec("DELETE FROM choice_sets; DELETE FROM seen_urls; DELETE FROM accounts; DELETE FROM offers;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  cc.takeQueued(C);
});

const router = { async sendMedia() { return { ok: true, delivered: { message_id: "H" } }; } };
const show = () => cc.sendQueued(C, { router, withWords: true, route: { channel: "sendblue", to: "+12025551234" } });
const ctx = (extra = {}) => ({ conversationId: C, fetchPhoto: okPhoto, shoot, findPagePhoto: pagePhotoOf, lookup: async () => ({ ok: false }), ...extra });

test("offer_check remembers the page it read, so a card can use it (never a /blocked wall)", async () => {
  await runTool("offer_check", { url: ULTA(2254420) }, { conversationId: C, fetchImpl });
  assert.ok(db.hasSeenUrl(C, ULTA(2254420)));
  const wall = async (u) => ({ ok: true, status: 200, url: "https://www.walmart.com/blocked?url=abc", headers: { get: () => null }, text: async () => "<html>robot?</html>" });
  await runTool("offer_check", { url: "https://www.walmart.com/ip/x/1" }, { conversationId: C, fetchImpl: wall });
  assert.ok(!db.hasSeenUrl(C, "https://www.walmart.com/blocked?url=abc"));
});

test("his three Ulta sizes: three cards, offer_check's own prices kept, nothing guessed", async () => {
  for (const sku of Object.keys(PAGES)) await runTool("offer_check", { url: ULTA(sku) }, { conversationId: C, fetchImpl });
  const r = await cc.runChoiceTool("show_choices", asked(), ctx());
  assert.equal(r.cards, 3, r.note);
  await show();
  const set = db.openChoiceFor(C);
  assert.deepEqual(set.options.map(o => o.price), ["$18.99", "$16.99", "$15.99"]);
  // No listing read back: no size on any card (the listing-match rule stands).
  assert.ok(set.options.every(o => !/\boz\b/.test(o.detail)));
});

test("a price offer_check did not read off that page is still left off", async () => {
  await runTool("offer_check", { url: ULTA(2541605) }, { conversationId: C, fetchImpl });
  db.rememberSeenUrls(C, [ULTA(2254420)], { kind: "page" });
  const r = await cc.runChoiceTool("show_choices", { kind: "shopping", options: asked().options.slice(0, 2) }, ctx());
  assert.equal(r.cards, 2);
  await show();
  assert.deepEqual(db.openChoiceFor(C).options.map(o => o.price), ["$18.99", ""]);
});

test("one option with no picture is left out; two still go as cards", async () => {
  for (const sku of Object.keys(PAGES)) db.rememberSeenUrls(C, [ULTA(sku)], { kind: "page" });
  const findPagePhoto = async (u) => (u === ULTA(2254420) ? null : pagePhotoOf(u));
  const r = await cc.runChoiceTool("show_choices", asked(), ctx({ findPagePhoto }));
  assert.equal(r.cards, 2);
  assert.match(r.note, /Not in the set.*12 oz/);
  await show();
  assert.deepEqual(db.openChoiceFor(C).options.map(o => o.n), [1, 2]);
});

test("a pick where buying is Crossmint's goes straight to store_checkout with that page", async () => {
  process.env.REASON_SHOP_CONNECT = "owner";
  for (const sku of Object.keys(PAGES)) db.rememberSeenUrls(C, [ULTA(sku)], { kind: "page" });
  await cc.runChoiceTool("show_choices", asked(), ctx());
  await show();
  const line = cc.inboundChoiceLine(C, { text: "2" });
  assert.match(line, /store_checkout/);
  assert.ok(line.includes(`2 = ${ULTA(2254420)}`));
  assert.doesNotMatch(line, /purchase|AgentCard/i);
  delete process.env.REASON_SHOP_CONNECT;
  assert.doesNotMatch(cc.inboundChoiceLine(C, { text: "2" }), /store_checkout/);
});

test("a 'best' line over compared offers gets no '(compared: …)' tail", () => {
  offers.noteOffer(C, { price_cents: 1899, seller: "" });
  offers.noteOffer(C, { price_cents: 1699, seller: "" });
  const g = offers.guardReply(C, "Here are the sizes — the 16 oz is the best value.");
  assert.doesNotMatch(g.text, /compared|a seller/);
  assert.ok(g.flags.some(f => f.rule === "best_compared_listed"));
});

test("a tool's note copied into a reply never reaches the person", () => {
  const g = offers.guardReply("dm:someone", "Pick one:\n1. Foaming 16 oz\n2. Foaming 12 oz\n(compared: a seller $18.99, a seller $16.99, a seller $15.99.)");
  assert.equal(g.text, "Pick one:\n1. Foaming 16 oz\n2. Foaming 12 oz");
  assert.ok(g.changed);
  assert.ok(g.flags.some(f => f.rule === "tool_note_stripped"));
  // Ordinary words with "compared" in them are left alone.
  assert.equal(offers.guardReply("dm:someone", "I compared three stores for you.").text, "I compared three stores for you.");
});

test("a promise to find the cheapest is not a 'best' claim: nothing glued on", () => {
  const said = "Here are the 3 main CeraVe face washes. Which one do you want? Once you pick, I'll find the cheapest total for the 16 oz.";
  assert.equal(offers.guardReply("dm:fresh", said).text, said);
  assert.equal(offers.claimsBest("ulta is the cheapest at $15.99"), true);
  assert.equal(offers.claimsBest("I'll look for the best price"), false);
  assert.equal(offers.claimsBest("I'll find it — this is the best deal I've seen"), true);
  assert.equal(offers.claimsBest("That's not a proven best deal. Amazon's page did not show a price."), false);
  assert.equal(offers.claimsBest("Ulta is the cheapest, not Target"), true);
});

test("review: trailing newline alone is no change; real claims beside 'not'/'want' still caught; a user line starting 'Compared:' stays", () => {
  const g = offers.guardReply("dm:fresh2", "Hello there\n", { asks: false });
  assert.equal(g.changed, false);
  assert.equal(g.text, "Hello there\n");
  assert.equal(offers.claimsBest("Not only is it the cheapest, it ships free."), true);
  assert.equal(offers.claimsBest("If you want the cheapest, it's the Target one."), true);
  assert.equal(offers.claimsBest("It isn't necessarily the cheapest."), false);
  const line = "Compared: the 8 oz is cheaper per ounce.";
  assert.equal(offers.guardReply("dm:fresh2", line, { asks: false }).text, line);
});

test("review: cards that fail to draw fall back to a list of every option, the photo-less one too", async () => {
  for (const sku of Object.keys(PAGES)) db.rememberSeenUrls(C, [ULTA(sku)], { kind: "page" });
  const findPagePhoto = async (u) => (u === ULTA(2254420) ? null : pagePhotoOf(u));
  const fresh = asked(); fresh.options.forEach(o => { o.why += " (draw fails)"; });   // a drawn card is reused by its content
  const r = await cc.runChoiceTool("show_choices", fresh, ctx({ findPagePhoto, shoot: async () => { throw new Error("chromium gone"); } }));
  assert.equal(r.fallback, "text");
  assert.equal(db.openChoiceFor(C).options.length, 3);
  assert.doesNotMatch(r.note, /Not in the set/);
});

test("a retailer page that blocks the plain read: the listing read's own picture is used, its checked price kept", async () => {
  const T = ["https://www.target.com/p/a/-/A-1", "https://www.target.com/p/b/-/A-2"];
  db.rememberSeenUrls(C, T, { kind: "page" });
  const lookup = async (u) => ({ ok: true, title: u.endsWith("1") ? "CeraVe Hydrating Facial Cleanser 16 fl oz" : "CeraVe Foaming Facial Cleanser 12 fl oz", text: u.endsWith("1") ? "$17.99" : "$15.49", images: [`https://target.scene7.com/is/image/Target/${u.slice(-1)}`] });
  const r = await cc.runChoiceTool("show_choices", { kind: "shopping", options: [
    { name: "Hydrating Facial Cleanser 16 fl oz", brand: "CeraVe", price: "$17.99", url: T[0] },
    { name: "Foaming Facial Cleanser 12 fl oz", brand: "CeraVe", price: "$15.49", url: T[1] },
  ] }, ctx({ findPagePhoto: async () => null, lookup }));
  assert.equal(r.cards, 2, r.note);
  await show();
  assert.deepEqual(db.openChoiceFor(C).options.map(o => o.price), ["$17.99", "$15.49"]);
});

test("no listing picture either: a searched photo of the product makes the card, with no price or size on it", async () => {
  const T = ["https://www.meijer.com/p/cerave-hydrating-16", "https://www.target.com/p/cerave-foaming-12"];
  db.rememberSeenUrls(C, T, { kind: "page" });
  const productSearch = { imageSearch: async ({ queries }) => ({ ok: true, results: [
    { image_url: `https://img.example/${queries[0].includes("Hydrating") ? "h" : "f"}.jpg`, page_url: "https://www.cerave.com/x", title: queries[0].replace(" product photo", "") },
    { image_url: "https://img.example/other.jpg", page_url: "https://x.example/y", title: "La Roche-Posay Toleriane" },
  ] }) };
  cc._setProductLook(async ({ photos }) => new Set(photos.map((_, k) => k + 1)));
  const r = await cc.runChoiceTool("show_choices", { kind: "shopping", options: [
    { name: "Hydrating Facial Cleanser", brand: "CeraVe", price: "$17.99", detail: "16 oz", url: T[0] },
    { name: "Foaming Facial Cleanser", brand: "CeraVe", price: "$15.49", detail: "12 oz", url: T[1] },
  ] }, ctx({ findPagePhoto: async () => null, productSearch }));
  assert.equal(r.cards, 2, r.note);
  await show();
  const set = db.openChoiceFor(C);
  assert.deepEqual(set.options.map(o => [o.price, o.detail]), [["", ""], ["", ""]]);
});

test("a searched photo the look says is another variant is never used: below two photos, a list", async () => {
  const T = ["https://www.meijer.com/p/cerave-hydrating-16", "https://www.target.com/p/cerave-ctf-16"];
  db.rememberSeenUrls(C, T, { kind: "page" });
  const productSearch = { imageSearch: async ({ queries }) => ({ ok: true, results: [{ image_url: `https://img.example/${queries[0].length}.jpg`, page_url: "https://x.example/p", title: queries[0] }] }) };
  cc._setProductLook(async () => new Set());   // looked: not it
  const r = await cc.runChoiceTool("show_choices", { kind: "shopping", options: [
    { name: "Hydrating Facial Cleanser", brand: "CeraVe", url: T[0] },
    { name: "Hydrating Cream-to-Foam Cleanser", brand: "CeraVe", url: T[1] },
  ] }, ctx({ findPagePhoto: async () => null, productSearch }));
  assert.equal(r.fallback, "text");
  cc._setProductLook(async () => null);        // the look failed: no searched photo either
  const t = await cc.runChoiceTool("show_choices", { kind: "shopping", options: [
    { name: "Hydrating Facial Cleanser", brand: "CeraVe", url: T[0] },
    { name: "Hydrating Cream-to-Foam Cleanser", brand: "CeraVe", url: T[1] },
  ] }, ctx({ findPagePhoto: async () => null, productSearch }));
  assert.equal(t.fallback, "text");
});

test("lookAtProductPhotos: one side call on the subscription path, numbers of the photos that ARE it", async () => {
  let seen;
  const run = async (a) => { seen = a; return { ok: true, envelope: { structured_output: { photos: [{ n: 1, is_it: false }, { n: 2, is_it: true }] } } }; };
  const yes = await cc.lookAtProductPhotos({ name: "CeraVe Hydrating Cream-to-Foam Cleanser", photos: [{ mediaType: "image/jpeg", base64: "AA" }, { mediaType: "image/jpeg", base64: "BB" }] }, { run });
  assert.deepEqual([...yes], [2]);
  assert.equal(seen.feature, "product_photo");
  assert.equal(seen.images.length, 2);
  assert.equal(await cc.lookAtProductPhotos({ name: "x", photos: [] }, { run: async () => ({ ok: false }) }), null);
});

test("a size in the card's name stays on one line", () => {
  const html = cc.choiceCardHtml({ n: 1, name: "CeraVe Foaming Facial Cleanser 16 oz", photo: "data:image/jpeg;base64,AA" });
  assert.match(html, /16&nbsp;oz<\/h1>/);
});
