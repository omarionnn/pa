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
    if (req.url === "/photo.png") { res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length }); return res.end(PNG); }
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

test("a shortlist with no pictures gets a nudge; one with pictures does not; a shortlist of one is left alone", async () => {
  const plain = await call("page_create", { title: "Where to eat", blocks: [{ type: "cards", items: [{ title: "Via Carota" }, { title: "I Sodi" }] }] });
  assert.match(plain.note, /shortlist with no pictures/);
  db.rememberSeenUrls(C, [PHOTO], { kind: "search", from: "https://viacarota.example.test/" });
  const pictured = await call("page_create", { title: "Where to eat", blocks: [{ type: "cards", items: [{ title: "Via Carota", image: PHOTO }, { title: "I Sodi" }] }] });
  assert.doesNotMatch(pictured.note, /shortlist with no pictures/);
  assert.equal(blocksOf(pictured)[0].items[0].source, "https://viacarota.example.test/");
  assert.match(renderPage(db.getPage(pictured.page_id)), /<div class="via">via <a href="https:\/\/viacarota\.example\.test\/"/);
  const one = await call("page_create", { title: "x", blocks: [{ type: "cards", items: [{ title: "only one" }] }] });
  assert.doesNotMatch(one.note, /shortlist with no pictures/);
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
