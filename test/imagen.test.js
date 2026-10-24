// Image generation: the tool, the provider, and the HTTP route that serves the output.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-imagen-"));
const imgDir = join(dir, "images");
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.GEMINI_API_KEY = "test-key";
process.env.REASON_IMAGEN_OUTPUT = imgDir;

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { imageRequest } = await import("../src/http.js");
const { imagenStatus, imagenProvider } = await import("../src/imagen.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => { try { rmSync(dir, { recursive: true }); } catch {} });

function fakeProvider({ images = null, error = null } = {}) {
  return {
    name: "imagen",
    model: "imagen-3.0-generate-002",
    async generate(prompt, opts) {
      if (error) return { ok: false, error };
      const out = images ?? [{ path: join(imgDir, "fake-img.png"), mime: "image/png", bytes: 1024 }];
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(imgDir, { recursive: true });
      for (const img of out) writeFileSync(img.path, Buffer.alloc(img.bytes));
      return { ok: true, images: out, model: "imagen-3.0-generate-002", count: out.length };
    },
  };
}

test("imagenStatus reports connected when key is set", () => {
  const s = imagenStatus({ apiKey: "test" });
  assert.equal(s.connected, true);
  assert.equal(s.provider, "imagen");
});

test("imagenStatus reports not connected when key is empty", () => {
  const s = imagenStatus({ apiKey: "" });
  assert.equal(s.connected, false);
  assert.ok(s.missing.includes("GEMINI_API_KEY"));
});

test("capabilitiesNow shows image_generation as live when key is set", () => {
  const caps = capabilitiesNow({});
  const img = caps.find(c => c.name === "image_generation");
  assert.ok(img);
  assert.equal(img.status, "live");
  assert.ok(img.what.includes("generate a picture"));
});

test("image_generate tool returns image URLs", async () => {
  const out = await runTool("image_generate", { prompt: "a cozy cafe interior", send: false }, { conversationId: C, imagenProvider: fakeProvider() });
  assert.equal(out.ok, true);
  assert.equal(out.images.length, 1);
  assert.ok(out.images[0].url.includes("/img/"));
  assert.ok(out.note.includes("generated"));
});

test("image_generate tool passes aspect ratio and count", async () => {
  let captured = {};
  const provider = {
    name: "imagen",
    model: "imagen-3.0-generate-002",
    async generate(prompt, opts) {
      captured = { prompt, ...opts };
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(imgDir, { recursive: true });
      const imgs = [];
      for (let i = 0; i < (opts.count ?? 1); i++) {
        const path = join(imgDir, `cap-${i}.png`);
        writeFileSync(path, Buffer.alloc(512));
        imgs.push({ path, mime: "image/png", bytes: 512 });
      }
      return { ok: true, images: imgs, model: "imagen-3.0-generate-002", count: imgs.length };
    },
  };
  const out = await runTool("image_generate", { prompt: "a banner", aspect_ratio: "16:9", count: 2, send: false }, { conversationId: C, imagenProvider: provider });
  assert.equal(out.ok, true);
  assert.equal(out.images.length, 2);
  assert.equal(captured.aspectRatio, "16:9");
  assert.equal(captured.count, 2);
});

test("image_generate tool forwards provider errors", async () => {
  const out = await runTool("image_generate", { prompt: "something dangerous" }, { conversationId: C, imagenProvider: fakeProvider({ error: "Safety filter blocked the request" }) });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes("Safety"));
});

test("generated image URLs are remembered as seen", async () => {
  const out = await runTool("image_generate", { prompt: "gift guide header", send: false }, { conversationId: C, imagenProvider: fakeProvider() });
  assert.equal(out.ok, true);
  const url = out.images[0].url;
  assert.ok(db.hasSeenUrl(C, url));
});

test("imageRequest serves a generated image file", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(imgDir, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  writeFileSync(join(imgDir, "test-img.png"), png);

  const out = imageRequest("test-img.png", { dir: imgDir, read: readFileSync });
  assert.equal(out.status, 200);
  assert.equal(out.headers["Content-Type"], "image/png");
  assert.deepEqual(out.body, png);
});

test("imageRequest returns 404 for missing file", () => {
  const out = imageRequest("nonexistent.png", { dir: imgDir, read: readFileSync });
  assert.equal(out.status, 404);
});

test("imageRequest rejects path traversal", () => {
  const out = imageRequest("../etc/passwd.png", { dir: imgDir, read: readFileSync });
  assert.equal(out.status, 404);
});

test("imagenProvider builds the correct request", async () => {
  let capturedUrl, capturedOpts;
  const provider = imagenProvider({
    apiKey: "test-key",
    model: "imagen-3.0-generate-002",
    base: "https://test.api",
    outputDir: imgDir,
    fetchImpl: async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      const img = Buffer.alloc(100);
      return {
        ok: true,
        text: async () => JSON.stringify({
          predictions: [{ bytesBase64Encoded: img.toString("base64"), mimeType: "image/png" }],
        }),
      };
    },
  });

  const out = await provider.generate("a sunset", { aspectRatio: "16:9" });
  assert.equal(out.ok, true);
  assert.ok(capturedUrl.includes("imagen-3.0-generate-002:predict"));
  const body = JSON.parse(capturedOpts.body);
  assert.equal(body.instances[0].prompt, "a sunset");
  assert.equal(body.parameters.aspectRatio, "16:9");
  assert.equal(body.parameters.addWatermark, true);
});

test("imagenProvider returns not_connected without a key", async () => {
  const provider = imagenProvider({ apiKey: "" });
  const out = await provider.generate("test");
  assert.equal(out.ok, false);
  assert.ok(out.missing?.includes("GEMINI_API_KEY"));
});
