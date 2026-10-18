// Pictures on a page (src/pages/pictures.js), without the model and without the web. A fixture
// server hands out a real PNG and a 404; the page tools are driven straight. What is proved is the
// part code owns: a real picture is copied into Reason's own store and says where it is from, a
// generated picture is labelled and never stands in for an option, a copy that cannot be made
// leaves the original in place and says so, and the whole thing is idempotent across page_update.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reason-page-pictures-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_IMAGEN_OUTPUT = join(dir, "images");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const { runTool } = await import("../src/tools.js");
const { preparePictures, imageBase } = await import("../src/pages/pictures.js");
const { renderPage } = await import("../src/pages/render.js");
const { checkContent } = await import("../src/pages/content.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
// A 1x1 PNG, the smallest real picture there is.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let site;
let hits = 0;
before(async () => {
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/photo.png" || /^\/p\/[\w.-]+\.png$/.test(req.url)) { res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length }); return res.end(PNG); }
    if (req.url === "/gone.jpg") { res.writeHead(404); return res.end("no"); }
    if (req.url === "/words.jpg") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>not a picture</html>"); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  site = { server, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => { site.server.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  hits = 0;
  db.db.exec("DELETE FROM pages; DELETE FROM page_sessions; DELETE FROM page_codes; DELETE FROM seen_urls; DELETE FROM action_ledger;");
});

// The fixture is http; pages demand https. So the url the page names is an https address, and the
// fetch used by the test maps it onto the fixture — the same seam production uses, pointed at a
// server this test owns. Nothing else about the pass is faked.
const PHOTO = "https://photos.example.test/photo.png";
const GONE = "https://photos.example.test/gone.jpg";
const WORDS = "https://photos.example.test/words.jpg";
const { fetchImage } = await import("../src/media.js");
const fetchPicture = (opts) => fetchImage({
  ...opts,
  fetchImpl: (url, init) => fetch(String(url).replace("https://photos.example.test", site.url), init),
});
const pictures = { fetchPicture };
const call = (name, input) => runTool(name, input, { conversationId: C, pictures });

// The image search, as the page tools see it: one picture per thing asked about, on the fixture
// server, plus the page it came off. `asked` is every query code decided to make on its own.
let asked = [];
const searching = (opts = {}) => {
  asked = [];
  return {
    ...pictures,
    search: async ({ queries = [], objective = "", maxResults = 6 }) => {
      asked.push({ query: queries[0] ?? "", objective, maxResults });
      if (opts.fail) throw new Error("search is down");
      if (opts.empty) return { ok: true, results: [] };
      if (opts.notOk) return { ok: false, error: "no key" };
      const slug = String(queries[0] ?? "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return { ok: true, results: [
        { image_url: `https://photos.example.test/p/${slug}-small.png`, page_url: `https://${slug}.example.test/`, title: queries[0], width: 120, height: 90 },
        { image_url: `https://photos.example.test/p/${slug}.png`, page_url: `https://${slug}.example.test/`, title: queries[0], width: 1200, height: 800 },
      ] };
    },
  };
};
const callSearching = (name, input, opts) => runTool(name, input, { conversationId: C, pictures: searching(opts) });
// The tool returns a block COUNT; the blocks themselves are read back off the row, as the renderer does.
const blocksOf = (out) => db.getPage(out.page_id).blocks;

test("a photo from an image search is copied into Reason's store and says where it is from", async () => {
  db.rememberSeenUrls(C, ["https://viacarota.example.test/"], { kind: "page" });
  db.rememberSeenUrls(C, [PHOTO], { kind: "search", from: "https://viacarota.example.test/" });

  const out = await call("page_create", { title: "Dinner", blocks: [{ type: "image", url: PHOTO, caption: "the dining room" }] });
  assert.equal(out.ok, true, out.error);
  const block = blocksOf(out)[0];
  assert.ok(block.url.startsWith(`${imageBase()}m-`), `copied: ${block.url}`);
  assert.ok(block.url.endsWith(".png"), "kept as what the bytes are");
  assert.equal(block.source, "https://viacarota.example.test/", "the page it sits on, not the CDN");
  assert.equal(block.illustration, false);
  assert.equal(hits, 1, "fetched once");
  const files = readdirSync(config.imagenOutputDir);
  assert.equal(files.length, 1);
  assert.ok(existsSync(join(config.imagenOutputDir, files[0])));
  assert.equal(db.seenUrlInfo(C, block.url)?.kind, "mirror", "the copy is a seen address too");

  const html = renderPage(db.getPage(out.page_id));
  assert.match(html, /<img src="https:\/\/reason\.example\.test\/img\/m-[a-f0-9]{32}\.png"/);
  assert.match(html, /<figcaption>the dining room · via <a href="https:\/\/viacarota\.example\.test\/"[^>]*>viacarota\.example\.test<\/a><\/figcaption>/);
  assert.doesNotMatch(html, /Illustration/);
  assert.doesNotMatch(out.note, /could not be copied/);
});

test("page_update with the copied address does not copy again, and keeps the source", async () => {
  db.rememberSeenUrls(C, [PHOTO], { kind: "search", from: "https://viacarota.example.test/" });
  const made = await call("page_create", { title: "Dinner", blocks: [{ type: "image", url: PHOTO }] });
  const copied = blocksOf(made)[0].url;
  hits = 0;
  const changed = await call("page_update", { page_id: made.page_id, blocks: [{ type: "image", url: copied, caption: "now with a caption" }, { type: "text", text: "and words" }] });
  assert.equal(changed.ok, true, changed.error);
  assert.equal(blocksOf(changed)[0].url, copied);
  assert.equal(blocksOf(changed)[0].source, "https://viacarota.example.test/", "the source survives the round trip");
  assert.equal(hits, 0, "nothing re-fetched");
  assert.equal(readdirSync(config.imagenOutputDir).filter(f => f.startsWith("m-")).length, 1);
});

test("a picture that cannot be copied stays as the original address, with its own site as the source, and the note says so", async () => {
  db.rememberSeenUrls(C, [GONE, WORDS], { kind: "page", from: "" });
  const out = await call("page_create", { title: "x", blocks: [
    { type: "image", url: GONE, caption: "gone" },
    { type: "cards", items: [{ title: "A", image: WORDS }, { title: "B" }] },
  ] });
  assert.equal(out.ok, true, out.error);
  assert.equal(blocksOf(out)[0].url, GONE, "the original stays");
  assert.equal(blocksOf(out)[0].source, "https://photos.example.test/");
  assert.equal(blocksOf(out)[1].items[0].image, WORDS);
  assert.match(out.note, /block 1 \(image\): the picture at photos\.example\.test could not be copied \(.*HTTP 404/);
  assert.match(out.note, /block 2 \(cards\) item 1: .*could not be copied \(.*not a picture/);
  const html = renderPage(db.getPage(out.page_id));
  assert.match(html, /via <a href="https:\/\/photos\.example\.test\/"/);
});

test("a generated picture is labelled Illustration on its own, and refused on an option", async () => {
  const generated = `${imageBase()}0f3c2b1a-aaaa-bbbb-cccc-000000000001.png`;
  db.rememberSeenUrls(C, [generated], { kind: "generated" });

  const fine = await call("page_create", { title: "Packing", blocks: [{ type: "image", url: generated, caption: "what to bring" }] });
  assert.equal(fine.ok, true, fine.error);
  assert.equal(blocksOf(fine)[0].illustration, true);
  assert.equal(blocksOf(fine)[0].url, generated, "never copied: it is already ours");
  assert.equal(blocksOf(fine)[0].source, null, "an illustration is from nowhere");
  assert.match(renderPage(db.getPage(fine.page_id)), /<figcaption>Illustration · what to bring<\/figcaption>/);

  const refused = await call("page_create", { title: "Hotels", blocks: [{ type: "cards", items: [{ title: "The Ritz", image: generated }, { title: "The Savoy" }] }] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /generated picture on an option/);
  assert.match(refused.error, /image_search/);
  assert.equal(db.listPages?.(C)?.length ?? 1, 1, "nothing was made");

  // The model cannot un-label it by passing illustration: false — the flag is code's.
  const sneaky = await call("page_create", { title: "Packing", blocks: [{ type: "image", url: generated, illustration: false }] });
  assert.equal(blocksOf(sneaky)[0].illustration, true);
});

test("with no picture search on the machine, a shortlist is made without photos and says why", async () => {
  const plain = await call("page_create", { title: "Where to eat", blocks: [{ type: "cards", items: [{ title: "Via Carota" }, { title: "I Sodi" }] }] });
  assert.equal(plain.ok, true, plain.error);
  assert.match(plain.note, /no picture search on this machine/);
  db.rememberSeenUrls(C, [PHOTO], { kind: "search", from: "https://viacarota.example.test/" });
  const pictured = await call("page_create", { title: "Where to eat", blocks: [{ type: "cards", items: [{ title: "Via Carota", image: PHOTO }, { title: "I Sodi" }] }] });
  assert.doesNotMatch(pictured.note, /no picture search/);
  assert.equal(blocksOf(pictured)[0].items[0].source, "https://viacarota.example.test/");
  assert.match(renderPage(db.getPage(pictured.page_id)), /<div class="via">via <a href="https:\/\/viacarota\.example\.test\/"/);
  const one = await call("page_create", { title: "x", blocks: [{ type: "cards", items: [{ title: "only one" }] }] });
  assert.doesNotMatch(one.note, /no picture search/);
});

test("nobody asks: a shortlist of options gets a real photo of each, copied and sourced", async () => {
  const out = await callSearching("page_create", {
    title: "Saturday dinner: Via Carota, I Sodi or L'Artusi",
    blocks: [
      { type: "text", text: "Pick: I Sodi." },
      { type: "cards", items: [{ title: "I Sodi" }, { title: "Via Carota" }, { title: "L'Artusi" }] },
    ],
  });
  assert.equal(out.ok, true, out.error);
  const items = blocksOf(out)[1].items;
  assert.equal(items.length, 3);
  for (const it of items) {
    assert.ok(it.image.startsWith(`${imageBase()}m-`), `${it.title} has a copy of its own: ${it.image}`);
    assert.equal(it.source, `https://${it.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example.test/`, `${it.title} says where it is from`);
  }
  assert.equal(new Set(items.map(i => i.image)).size, 3, "three different pictures");
  assert.deepEqual(asked.map(a => a.query), ["I Sodi", "Via Carota", "L'Artusi"], "code searched for each option itself");
  assert.match(asked[0].objective, /a real photograph of I Sodi/);
  assert.match(asked[0].objective, /Saturday dinner/, "the page's own words rank the picture");
  assert.match(out.note, /Reason put a real photo on this page itself: I Sodi, Via Carota, L'Artusi/);
  assert.match(renderPage(db.getPage(out.page_id)), /<div class="via">via <a href="https:\/\/i-sodi\.example\.test\/"/);
});

test("the big picture is taken over the thumbnail, and a model's own photo is left alone", async () => {
  db.rememberSeenUrls(C, [PHOTO], { kind: "search", from: "https://viacarota.example.test/" });
  const out = await callSearching("page_create", {
    title: "Where to eat",
    blocks: [{ type: "cards", items: [{ title: "Via Carota", image: PHOTO }, { title: "I Sodi" }] }],
  });
  assert.equal(out.ok, true, out.error);
  const items = blocksOf(out)[0].items;
  assert.equal(items[0].source, "https://viacarota.example.test/", "the model's picture kept its own provenance");
  assert.deepEqual(asked.map(a => a.query), ["I Sodi"], "only the option without one was searched for");
  assert.equal(db.seenUrlInfo(C, "https://photos.example.test/p/i-sodi.png")?.from, "https://i-sodi.example.test/");
  assert.ok(items[1].image.startsWith(`${imageBase()}m-`));
});

test("a comparison of named things gets a photo of each under the table; a table of plain data gets none", async () => {
  const out = await callSearching("page_create", {
    title: "Saturday dinner: Via Carota or I Sodi",
    blocks: [
      { type: "text", text: "Via Carota is the loud one; I Sodi is tiny and quiet." },
      { type: "table", title: "Side by side", columns: ["What", "I Sodi", "Via Carota"], rows: [["Known for", "Lasagna", "Tuscan food"], ["Price", "$$$", "$$"]] },
      { type: "text", text: "I read both pages." },
    ],
  });
  assert.equal(out.ok, true, out.error);
  const blocks = blocksOf(out);
  assert.equal(blocks[1].type, "table", "the comparison is untouched");
  assert.equal(blocks[2].type, "cards", "the photos go in under it");
  assert.deepEqual(blocks[2].items.map(i => i.title), ["I Sodi", "Via Carota"]);
  assert.ok(blocks[2].items.every(i => i.image.startsWith(`${imageBase()}m-`)));
  assert.deepEqual(asked.map(a => a.query), ["I Sodi", "Via Carota"], "'What', 'Known for' and 'Price' are not things");

  const plain = await callSearching("page_create", {
    title: "This week's weather",
    blocks: [
      { type: "text", text: "Rain on Thursday." },
      { type: "table", columns: ["Day", "High", "Chance of rain"], rows: [["Mon", "18", "10%"], ["Tue", "19", "0%"]] },
      { type: "text", text: "Warm all week." },
    ],
  });
  assert.equal(plain.ok, true, plain.error);
  assert.equal(blocksOf(plain).filter(b => b.type === "cards").length, 0, "no photo row on a table of data");
  assert.deepEqual(asked, [], "and nothing was searched for");
});

test("a page about a named place gets one photo at the top; a page about an idea, and a working page, get none", async () => {
  const out = await callSearching("page_create", {
    title: "Packing for a weekend in Lisbon",
    blocks: [
      { type: "text", text: "Two days, hand luggage only." },
      { type: "steps", title: "Before you go", items: ["Check the forecast", "Charge the adapter"] },
      { type: "text", text: "It is warm in the day and cool at night." },
    ],
  });
  assert.equal(out.ok, true, out.error);
  const blocks = blocksOf(out);
  assert.equal(blocks[0].type, "image", "the photo is at the top");
  assert.ok(blocks[0].url.startsWith(`${imageBase()}m-`));
  assert.equal(blocks[0].source, "https://lisbon.example.test/");
  assert.equal(blocks[0].illustration, false, "a real photo is not an illustration");
  assert.deepEqual(asked.map(a => a.query), ["Lisbon"]);
  assert.match(asked[0].objective, /top of a page about Packing for a weekend in Lisbon/);

  const idea = await callSearching("page_create", {
    title: "how to think about it",
    blocks: [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "text", text: "three" }],
  });
  assert.equal(idea.ok, true, idea.error);
  assert.equal(blocksOf(idea).filter(b => b.type === "image").length, 0, "nothing named, nothing searched");
  assert.deepEqual(asked, []);

  const working = await callSearching("page_create", {
    title: "Your table at I Sodi",
    blocks: [{ type: "status", state: "waiting", headline: "Waiting on the restaurant" }, { type: "text", text: "They open at 5." }, { type: "text", text: "I will text you." }],
  });
  assert.equal(working.ok, true, working.error);
  assert.equal(blocksOf(working).filter(b => b.type === "image").length, 0, "a page being watched is not a picture page");
  assert.deepEqual(asked, []);
});

test("a search that fails, or comes back empty, still makes the page and does not let the model claim a picture", async () => {
  for (const opts of [{ fail: true }, { empty: true }, { notOk: true }]) {
    const out = await callSearching("page_create", {
      title: "Where to eat",
      blocks: [{ type: "cards", items: [{ title: "I Sodi" }, { title: "Via Carota" }] }],
    }, opts);
    assert.equal(out.ok, true, `${JSON.stringify(opts)}: ${out.error}`);
    const items = blocksOf(out)[0].items;
    assert.deepEqual(items.map(i => i.image), [null, null], "no picture rather than a broken one");
    assert.match(out.note, /No picture came back for I Sodi, Via Carota/);
    assert.match(out.note, /Do not say the page has a picture of them/);
    assert.doesNotMatch(out.note, /Reason put a real photo/);
  }
});

test("page_update fills in the pictures too, and does not go looking twice", async () => {
  const made = await callSearching("page_create", { title: "Dinner", blocks: [{ type: "text", text: "thinking" }] });
  assert.equal(made.ok, true, made.error);
  const changed = await callSearching("page_update", {
    page_id: made.page_id,
    blocks: [{ type: "text", text: "narrowed it down" }, { type: "cards", items: [{ title: "I Sodi" }, { title: "Via Carota" }] }],
  });
  assert.equal(changed.ok, true, changed.error);
  const items = db.getPage(made.page_id).blocks[1].items;
  assert.ok(items.every(i => i.image.startsWith(`${imageBase()}m-`)), "the page they already have now has photos");
  const copies = items.map(i => i.image);
  hits = 0;
  const again = await callSearching("page_update", {
    page_id: made.page_id,
    blocks: [{ type: "text", text: "booked" }, { type: "cards", items: items.map(i => ({ title: i.title, image: i.image, source: i.source })) }],
  });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(db.getPage(made.page_id).blocks[1].items.map(i => i.image), copies, "the same copies");
  assert.deepEqual(asked, [], "nothing searched for a second time");
  assert.equal(hits, 0, "nothing fetched a second time");
});

test("the model may name a source it knows, and a bad one is refused; an unseen picture is still refused first", async () => {
  db.rememberSeenUrls(C, [PHOTO], { kind: "page" });
  const named = await call("page_create", { title: "x", blocks: [{ type: "image", url: PHOTO, source: "https://listing.example.test/42" }] });
  assert.equal(named.ok, true, named.error);
  assert.equal(blocksOf(named)[0].source, "https://listing.example.test/42", "the model's source wins when it gave one");
  const bad = checkContent([{ type: "image", url: PHOTO, source: "javascript:alert(1)" }], { seenUrl: () => true });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /source that is not an http\(s\) url/);
  const unseen = await call("page_create", { title: "x", blocks: [{ type: "image", url: "https://photos.example.test/never.png" }] });
  assert.equal(unseen.ok, false);
  assert.match(unseen.error, /has not come back from any tool/);
  assert.equal(hits, 1, "only the real one was fetched");
});

test("provenance: a url seen twice keeps where it was first seen, and the helpers answer honestly", () => {
  db.rememberSeenUrls(C, [PHOTO]);
  assert.deepEqual(db.seenUrlInfo(C, PHOTO), { url: PHOTO, kind: "", from: "" });
  db.rememberSeenUrls(C, [PHOTO], { kind: "search", from: "https://a.example.test/" });
  assert.deepEqual(db.seenUrlInfo(C, PHOTO), { url: PHOTO, kind: "search", from: "https://a.example.test/" }, "an empty row is filled in");
  db.rememberSeenUrls(C, [PHOTO], { kind: "page", from: "https://b.example.test/" });
  assert.deepEqual(db.seenUrlInfo(C, PHOTO), { url: PHOTO, kind: "search", from: "https://a.example.test/" }, "a filled row is not overwritten");
  assert.equal(db.seenUrlInfo(C, "https://never.example.test/"), null);
});

test("preparePictures on its own: mirroring off leaves addresses alone but still fills sources and labels", async () => {
  const generated = `${imageBase()}abcdefab-1111-2222-3333-444444444444.png`;
  const info = (u) => u === PHOTO ? { kind: "search", from: "https://x.example.test/p" } : u === generated ? { kind: "generated", from: "" } : null;
  const out = await preparePictures(C, [
    { type: "image", url: PHOTO, caption: null, source: null },
    { type: "image", url: generated, caption: "c", source: null },
    { type: "text", text: "t" },
  ], { info, mirror: false, fetchPicture: async () => { throw new Error("must not fetch"); }, remember: () => {} });
  assert.equal(out.ok, true);
  assert.equal(out.blocks[0].url, PHOTO);
  assert.equal(out.blocks[0].source, "https://x.example.test/p");
  assert.equal(out.blocks[1].illustration, true);
  assert.deepEqual(out.blocks[2], { type: "text", text: "t" });
});
