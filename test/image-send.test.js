// Generated pictures, handed over: a picture somebody asked for arrives in their thread as an
// image attachment, never as a page they did not ask for and never as a bare link.
//
// Pinned here, through the real Sendblue adapter with a recording fetch (no network):
//
//   - a picture request is ONE upload (POST /api/upload-file) followed by ONE send-message carrying
//     that media_url, and no URL is in the words that go with it or in what the model gets back;
//   - count 2 is two attachments;
//   - a failed upload is an honest failure: ok false, sent false, nothing sent, no link offered;
//   - send: false still gives a URL that a page can use, and sends nothing.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-image-send-"));
const imgDir = join(dir, "images");
mkdirSync(imgDir, { recursive: true });
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_IMAGEN_OUTPUT = imgDir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.ts.net";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.GEMINI_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const { runTool, tools: TOOLS, IMAGE_GENERATE_DESC } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const LINE = "+15122164639";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2b1a60000000049454e44ae426082", "hex");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pages; DELETE FROM seen_urls; DELETE FROM action_ledger; DELETE FROM conversations; DELETE FROM threads; DELETE FROM outbox;");
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = "a-secret";
});

/** An image model that writes real (tiny) PNGs, so the upload reads real bytes off disk. */
function drawer() {
  let k = 0;
  return {
    name: "imagen", model: "imagen-test",
    async generate(_prompt, { count = 1 } = {}) {
      const images = [];
      for (let i = 0; i < count; i++) {
        const path = join(imgDir, "gen-" + (++k) + ".png");
        writeFileSync(path, PNG);
        images.push({ path, mime: "image/png", bytes: PNG.length });
      }
      return { ok: true, images, model: "imagen-test", count: images.length };
    },
  };
}

/** The real Sendblue adapter on a fetch that records every call and answers like Sendblue. */
function sendblueHarness({ uploadFails = false } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path, body, form: init.body instanceof FormData ? init.body : null });
    if (path === "/api/upload-file") {
      if (uploadFails) return new Response(JSON.stringify({ message: "upload service unavailable" }), { status: 503 });
      n++;
      return new Response(JSON.stringify({ media_url: "https://storage.googleapis.com/inbound-file-store/up-" + n + ".png" }), { status: 200 });
    }
    if (path === "/api/send-message") {
      return new Response(JSON.stringify({ status: "QUEUED", message_handle: "h-" + calls.length, from_number: LINE, number: body?.number }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const sb = router.register(new SendblueChannel({ fetchImpl }));
  db.upsertThread({ conversationId: C, channel: sb.name, address: OWNER, chatId: null, service: "iMessage" });
  return { router, calls };
}

const ctx = (router) => ({ conversationId: C, channels: router, imagenProvider: drawer() });
const URLISH = /https?:\/\//;

test("a picture request uploads the file, then sends a message with that media_url — and no URL in the words", async () => {
  const { router, calls } = sendblueHarness();
  const out = await runTool("image_generate", { prompt: "a fox asleep in the snow", say: "here's your fox https://reason.example.ts.net/img/x.png" }, ctx(router));

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent, true);
  assert.equal(out.sent_count, 1);
  assert.deepEqual(calls.map(c => c.path), ["/api/upload-file", "/api/send-message"], "upload first, then the send");
  assert.ok(calls[0].form?.get("file"), "the file went up as multipart field 'file'");
  const send = calls[1].body;
  assert.equal(send.media_url, "https://storage.googleapis.com/inbound-file-store/up-1.png", "the send carries the uploaded media_url");
  assert.equal(send.number, OWNER);
  assert.equal(send.content, "here's your fox", "the one line rides along, with the link taken out");
  assert.doesNotMatch(send.content, URLISH, "no URL in the text that goes to them");
  assert.doesNotMatch(JSON.stringify(out), URLISH, "nothing the model gets back is a link it could text instead");
  assert.match(out.note, /You may say you sent it/);
});

test("count 2 sends 2 attachments", async () => {
  const { router, calls } = sendblueHarness();
  const out = await runTool("image_generate", { prompt: "two takes on a lighthouse", count: 2, say: "pick one" }, ctx(router));

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent_count, 2);
  assert.deepEqual(calls.map(c => c.path), ["/api/upload-file", "/api/send-message", "/api/upload-file", "/api/send-message"]);
  const sends = calls.filter(c => c.path === "/api/send-message").map(c => c.body);
  assert.deepEqual(sends.map(s => s.media_url), [
    "https://storage.googleapis.com/inbound-file-store/up-1.png",
    "https://storage.googleapis.com/inbound-file-store/up-2.png",
  ], "two different attachments");
  assert.equal(sends[0].content, "pick one", "the line is on the first picture");
  assert.equal(sends[1].content, undefined, "and not repeated on the second");
});

test("a failed upload is an honest failure: nothing sent, no claim it was, no link instead", async () => {
  const { router, calls } = sendblueHarness({ uploadFails: true });
  const out = await runTool("image_generate", { prompt: "a fox asleep in the snow" }, ctx(router));

  assert.equal(out.ok, false);
  assert.equal(out.sent, false);
  assert.equal(out.sent_count, 0);
  assert.deepEqual(calls.map(c => c.path), ["/api/upload-file"], "no send-message after a failed upload");
  assert.match(out.error, /would not take the file/);
  assert.match(out.note, /could not be sent/);
  assert.match(out.note, /Do not say you sent it/);
  assert.doesNotMatch(out.note, /You may say you sent/);
  assert.doesNotMatch(JSON.stringify(out), /reason\.example\.ts\.net|\/img\//, "no server link handed over as a fallback");
});

test("page use still works: send:false returns a URL a page accepts, and sends nothing", async () => {
  const { router, calls } = sendblueHarness();
  const out = await runTool("image_generate", { prompt: "a calm header of Lisbon rooftops", send: false, aspect_ratio: "16:9" }, ctx(router));

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent, false);
  assert.equal(calls.length, 0, "nothing went to the channel");
  const url = out.images[0].url;
  assert.match(url, /^https:\/\/reason\.example\.ts\.net\/img\/gen-\d+\.png$/);
  assert.match(out.note, /page block/);

  const page = await runTool("page_create", { title: "Lisbon, 3 days", blocks: [{ type: "image", url }, { type: "text", text: "Start in Alfama." }] }, { conversationId: C });
  assert.equal(page.ok, true, JSON.stringify(page));
});

test("a thread that cannot carry a file says so, and still hands over no link", async () => {
  const runtime = new Runtime({ runTurn: async () => "ok" });
  const router = new Router({ runtime });
  const fake = router.register(new FakeChannel({ media: false }));
  db.upsertThread({ conversationId: C, channel: fake.name, address: OWNER, chatId: null, service: "SMS" });
  const out = await runTool("image_generate", { prompt: "a fox" }, ctx(router));
  assert.equal(out.ok, false);
  assert.equal(out.supported, false);
  assert.equal(fake.sent.length, 0);
  assert.doesNotMatch(JSON.stringify(out), URLISH);
});

test("the tool description sends by default, keeps pages for pages, and never a bare link", () => {
  const tool = TOOLS.find(t => t.name === "image_generate");
  assert.equal(tool.description, IMAGE_GENERATE_DESC);
  assert.match(IMAGE_GENERATE_DESC, /picture, an image or a drawing/);
  assert.match(IMAGE_GENERATE_DESC, /send: false ONLY when the picture belongs inside a page/);
  assert.match(IMAGE_GENERATE_DESC, /Never send a bare link to a generated image/);
  assert.match(IMAGE_GENERATE_DESC, /always a generated picture, never a photo/);
  assert.ok(tool.input_schema.properties.send && tool.input_schema.properties.say);
});
