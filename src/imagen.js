// Image generation via the Gemini API's Imagen model.
//
// Written from Google's Gemini API docs (ai.google.dev/gemini-api/docs/image-generation, read
// 2026-10-08):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predict
//   key in an `x-goog-api-key` header
//   body: { instances: [{ prompt }], parameters: { sampleCount, aspectRatio } }
//   response: { predictions: [{ bytesBase64Encoded, mimeType }] }
//
// Uses the same GEMINI_API_KEY and base URL as src/gemini.js. The model is `imagen-3.0-generate-002`
// by default — configurable via REASON_IMAGEN_MODEL.
//
// Nothing here has ever run against Google. There is no GEMINI_API_KEY in the test process's
// environment, so every path below has only ever answered an injected fetch. docs/unverified.md
// records what has and has not been tested.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export function imagenStatus({ apiKey = config.geminiKey, model = config.imagenModel } = {}) {
  if (apiKey) return { connected: true, provider: "imagen", what: "Google Imagen (image generation)", model };
  return {
    connected: false,
    provider: "imagen",
    missing: ["GEMINI_API_KEY"],
    why: "No image model is connected, so pictures cannot be generated. Connecting it needs GEMINI_API_KEY.",
  };
}

const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];

export function imagenProvider({
  apiKey = config.geminiKey,
  model = config.imagenModel,
  base = config.geminiBase,
  fetchImpl = fetch,
  timeoutMs = config.imagenTimeoutMs,
  outputDir = config.imagenOutputDir,
} = {}) {
  const headers = { "x-goog-api-key": apiKey };

  return {
    name: "imagen",
    model,

    async generate(prompt, { aspectRatio = "1:1", count = 1 } = {}) {
      if (!apiKey) return { ok: false, ...imagenStatus({ apiKey, model }) };
      if (!ASPECT_RATIOS.includes(aspectRatio)) {
        return { ok: false, error: `Aspect ratio must be one of ${ASPECT_RATIOS.join(", ")}, got "${aspectRatio}".` };
      }
      if (count < 1 || count > 4) {
        return { ok: false, error: "Count must be between 1 and 4." };
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(
          `${base}/v1beta/models/${encodeURIComponent(model)}:predict`,
          {
            method: "POST",
            signal: ac.signal,
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              instances: [{ prompt }],
              parameters: {
                sampleCount: count,
                aspectRatio,
                addWatermark: true,
              },
            }),
          },
        );
        const body = await res.text();
        if (!res.ok) {
          if (res.status === 400 && body.includes("SAFETY")) {
            return { ok: false, error: "The image was blocked by Google's safety filter. Try rephrasing the description." };
          }
          return { ok: false, error: `Imagen refused: ${res.status} ${res.statusText}. ${body.slice(0, 300)}` };
        }

        let json;
        try { json = JSON.parse(body); } catch {
          return { ok: false, error: "Imagen answered with something that was not JSON." };
        }

        const predictions = json?.predictions ?? [];
        if (!predictions.length) {
          return { ok: false, error: "Imagen came back with no images. The prompt may have been blocked by the safety filter." };
        }

        mkdirSync(outputDir, { recursive: true });
        const images = [];
        for (const p of predictions) {
          const bytes = Buffer.from(p.bytesBase64Encoded, "base64");
          const mime = p.mimeType || "image/png";
          const ext = mime === "image/jpeg" ? ".jpg" : ".png";
          const name = `${randomUUID()}${ext}`;
          const path = join(outputDir, name);
          writeFileSync(path, bytes);
          images.push({ path, mime, bytes: bytes.length });
        }

        return { ok: true, images, model, count: images.length };
      } catch (e) {
        const why = e.name === "AbortError"
          ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
          : e.message;
        return { ok: false, error: `Could not reach Imagen: ${why}.` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function imageModelFor({ status = imagenStatus(), ...rest } = {}) {
  return status.connected ? imagenProvider({ model: status.model, ...rest }) : null;
}
