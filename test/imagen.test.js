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
// A Gemini key is set on purpose: pictures must still never go to Google (owner, 2026-11-09).
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_API_BASE = "https://openai.test";
process.env.REASON_IMAGEN_OUTPUT = imgDir;

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { imageRequest } = await import("../src/http.js");
const { imagenStatus, imageModelFor } = await import("../src/imagen.js");
const { generateIllustration } = await import("../src/pages/card.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;

after(() => { try { rmSync(dir, { recursive: true }); } catch {} });

function fakeProvider({ images = null, error = null } = {}) {
  return {
    name: "openai",
    model: "gpt-image-2",
    async generate(prompt, opts) {
      if (error) return { ok: false, error };
      const out = images ?? [{ path: join(imgDir, "fake-img.png"), mime: "image/png", bytes: 1024 }];
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(imgDir, { recursive: true });
      for (const img of out) writeFileSync(img.path, Buffer.alloc(img.bytes));
      return { ok: true, images: out, model: "gpt-image-2", count: out.length };
    },
  };
}

test("imagenStatus: OpenAI is the one picture model", () => {
  const s = imagenStatus({ openaiKey: "test" });
  assert.equal(s.connected, true);
  assert.equal(s.provider, "openai");
  assert.equal(s.model, "gpt-image-2");
});

test("imagenStatus reports not connected without an OpenAI key, whatever Gemini has", () => {
  const s = imagenStatus({ openaiKey: "" });
  assert.equal(s.connected, false);
  assert.deepEqual(s.missing, ["OPENAI_API_KEY"]);
  assert.equal(imageModelFor({ status: s }), null);
});

/** Swap the real fetch for one that records every host asked and answers like gpt-image-2. */
async function withFetch(fn) {
  const hosts = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    hosts.push(new URL(String(url)).host);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.alloc(64).toString("base64") }] }) };
  };
  try { return { out: await fn(), hosts }; } finally { globalThis.fetch = real; }
}

test("image_generate makes the picture with one OpenAI call and never asks Google first", async () => {
  const { out, hosts } = await withFetch(() => runTool("image_generate", { prompt: "a quiet harbour", send: false }, { conversationId: C }));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.model, "gpt-image-2");
  assert.deepEqual(hosts, ["openai.test"]);
});

test("a page's share-card illustration is one OpenAI call, never Google", async () => {
  const { out, hosts } = await withFetch(() => generateIllustration({ id: "pg_test", title: "Weekend in Lisbon", blocks: [] }));
  assert.ok(out && existsSync(out), "the illustration was written");
  assert.deepEqual(hosts, ["openai.test"]);
});

test("image_generate says plainly when no picture model is connected", async () => {
  const before = config.openaiKey;
  config.openaiKey = "";
  try {
    const out = await runTool("image_generate", { prompt: "a quiet harbour" }, { conversationId: C });
    assert.equal(out.ok, false);
    assert.ok(out.missing.includes("OPENAI_API_KEY"));
  } finally { config.openaiKey = before; }
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
    name: "openai",
    model: "gpt-image-2",
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
      return { ok: true, images: imgs, model: "gpt-image-2", count: imgs.length };
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

test("openaiImageProvider turns a moderation refusal into a plain sentence", async () => {
  const { openaiImageProvider } = await import("../src/imagen.js");
  const provider = openaiImageProvider({
    apiKey: "test-key", base: "https://test.api", outputDir: imgDir,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: "moderation_blocked", message: "Your request was rejected by the safety system." } }) }),
  });
  const out = await provider.generate("something");
  assert.equal(out.ok, false);
  assert.match(out.error, /safety filter/);
});

test("openaiImageProvider does not send response_format — gpt-image models refuse it with a 400", async () => {
  const { openaiImageProvider } = await import("../src/imagen.js");
  let captured;
  const provider = openaiImageProvider({
    apiKey: "test-key", base: "https://test.api", outputDir: imgDir,
    fetchImpl: async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.alloc(64).toString("base64") }] }) };
    },
  });
  const out = await provider.generate("a paper boat", { aspectRatio: "1:1" });
  assert.equal(out.ok, true, out.error);
  assert.equal("response_format" in captured, false, "gpt-image-* always answers b64_json and rejects the parameter");
  assert.equal(captured.model, "gpt-image-2");
});
