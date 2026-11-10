// "make me a picture of X" — the model's own choice, through whatever backend is live.
//
// The intent lane for generated pictures: asked for a picture, Reason draws it and sends it into
// the thread as an attachment. Not a page, and not a link. The image model is a stand-in that writes
// a real PNG (no Google spend); the model, the prompt and the tool loop are real.
//
// Run it:  REASON_BACKEND=api node --env-file-if-exists=.env --test test/flow-pictures.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-pictures-"));
const imgDir = join(dir, "images");
mkdirSync(imgDir, { recursive: true });
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_IMAGEN_OUTPUT = imgDir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PUBLIC_URL = "https://reason.example.ts.net";
// The capability row reads this to say pictures are possible (OpenAI is the one picture model since
// 2026-11-09); the provider below is what draws. The base is a closed loopback port, so nothing else
// that reads the key (embeddings) can reach OpenAI with it.
process.env.GEMINI_API_KEY = "";
process.env.OPENAI_API_KEY = "flow-test-not-a-real-key";
process.env.OPENAI_API_BASE = "http://127.0.0.1:9";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const C = "dm:owner";
const OWNER = "+12025551234";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e2b1a60000000049454e44ae426082", "hex");

let rt, router, fake;
const drawn = [];

before(() => {
  clock.reset();
  rt = new Runtime();
  router = new Router({ runtime: rt });
  fake = router.register(new FakeChannel({ media: true }));
  const imagenProvider = {
    name: "imagen", model: "imagen-test",
    async generate(prompt, { count = 1 } = {}) {
      const images = [];
      for (let i = 0; i < count; i++) {
        const path = join(imgDir, "flow-" + (drawn.length + 1) + ".png");
        writeFileSync(path, PNG);
        drawn.push({ prompt, path });
        images.push({ path, mime: "image/png", bytes: PNG.length });
      }
      return { ok: true, images, model: "imagen-test", count: images.length };
    },
  };
  rt.turnExtras = { ...(rt.turnExtras ?? {}), channels: router, imagenProvider };
  db.upsertThread({ conversationId: C, channel: fake.name, address: OWNER, chatId: "chat-1", service: "iMessage" });
});
after(() => { rt.stop(); rmSync(dir, { recursive: true, force: true }); });

test("asked for a picture, Reason sends the image into the thread instead of building a page (" + label + ")", { skip }, async () => {
  const reply = await rt.inbound(C, "make me a picture of a fox curled up asleep in the snow");

  assert.ok(drawn.length >= 1, "it drew something");
  assert.match(drawn[0].prompt, /fox/i);

  const withImage = fake.sent.filter(m => m.media?.file && drawn.some(d => d.path === m.media.file));
  assert.ok(withImage.length >= 1, "the picture went into the thread as an attachment; sent: " + JSON.stringify(fake.sent.map(m => ({ text: m.text, file: m.media?.file ?? null }))));
  assert.equal(withImage[0].media.mimeType, "image/png");
  assert.equal(withImage[0].to, OWNER);

  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM pages").get().n, 0, "no page was built for a picture request");
  const words = [String(reply ?? ""), ...fake.sent.map(m => m.text ?? "")].join("\n");
  assert.doesNotMatch(words, /\/img\/|reason\.example\.ts\.net|\/p\//, "no link to the image or a page in what they read");
});

test("asked for a page with an illustration, the picture goes on the page and nothing is sent as an image (" + label + ")", { skip }, async () => {
  const before = { drawn: drawn.length, files: fake.sent.filter(m => m.media?.file).length };
  await rt.inbound(C, "make me a page for a weekend in lisbon — a short guide with a header illustration at the top");

  assert.ok(db.db.prepare("SELECT COUNT(*) AS n FROM pages").get().n >= 1, "a page was built");
  if (drawn.length > before.drawn) {
    assert.equal(fake.sent.filter(m => m.media?.file).length, before.files, "an illustration made for a page was not also texted as an image");
  }
});
