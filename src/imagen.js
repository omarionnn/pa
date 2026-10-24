// Image generation via Google Imagen or OpenAI gpt-image-2.
//
// Google Imagen (primary when GEMINI_API_KEY is set):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predict
//   key in an `x-goog-api-key` header
//   body: { instances: [{ prompt }], parameters: { sampleCount, aspectRatio } }
//   response: { predictions: [{ bytesBase64Encoded, mimeType }] }
//
// OpenAI gpt-image-2 (fallback when OPENAI_API_KEY is set):
//   POST https://api.openai.com/v1/images/generations
//   Authorization: Bearer {key}
//   body: { model, prompt, n, size }
//   response: { data: [{ b64_json }] }
//
// Tries Imagen first; falls back to OpenAI when Imagen is not configured or fails.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export function imagenStatus({ apiKey = config.geminiKey, model = config.imagenModel, openaiKey = config.openaiKey } = {}) {
  if (apiKey) return { connected: true, provider: "imagen", what: "Google Imagen (image generation)", model };
  if (openaiKey) return { connected: true, provider: "openai", what: "OpenAI gpt-image-2 (image generation)", model: "gpt-image-2" };
  return {
    connected: false,
    provider: "imagen",
    missing: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
    why: "No image model is connected, so pictures cannot be generated. Connecting it needs GEMINI_API_KEY or OPENAI_API_KEY.",
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

const OPENAI_SIZE = { "1:1": "1024x1024", "3:4": "1024x1536", "4:3": "1536x1024", "16:9": "1536x1024", "9:16": "1024x1536" };

export function openaiImageProvider({
  apiKey = config.openaiKey,
  model = "gpt-image-2",
  base = config.openaiBase,
  fetchImpl = fetch,
  timeoutMs = config.imagenTimeoutMs,
  outputDir = config.imagenOutputDir,
} = {}) {
  return {
    name: "openai",
    model,

    async generate(prompt, { aspectRatio = "1:1", count = 1 } = {}) {
      if (!apiKey) return { ok: false, error: "No OPENAI_API_KEY configured." };
      if (!ASPECT_RATIOS.includes(aspectRatio)) {
        return { ok: false, error: `Aspect ratio must be one of ${ASPECT_RATIOS.join(", ")}, got "${aspectRatio}".` };
      }
      if (count < 1 || count > 4) {
        return { ok: false, error: "Count must be between 1 and 4." };
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/v1/images/generations`, {
          method: "POST",
          signal: ac.signal,
          headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            n: count,
            size: OPENAI_SIZE[aspectRatio] || "1024x1024",
            // No response_format: gpt-image-* always answers with b64_json and refuses the
            // parameter outright ("Unknown parameter: 'response_format'", a 400 — seen live
            // 2026-10-24), which made every OpenAI fallback a failure.
          }),
        });
        const body = await res.text();
        if (!res.ok) {
          return { ok: false, error: `OpenAI image generation refused: ${res.status}. ${body.slice(0, 300)}` };
        }

        let json;
        try { json = JSON.parse(body); } catch {
          return { ok: false, error: "OpenAI answered with something that was not JSON." };
        }

        const items = json?.data ?? [];
        if (!items.length) {
          return { ok: false, error: "OpenAI came back with no images." };
        }

        mkdirSync(outputDir, { recursive: true });
        const images = [];
        for (const item of items) {
          const bytes = Buffer.from(item.b64_json, "base64");
          const name = `${randomUUID()}.png`;
          const path = join(outputDir, name);
          writeFileSync(path, bytes);
          images.push({ path, mime: "image/png", bytes: bytes.length });
        }

        return { ok: true, images, model, count: images.length };
      } catch (e) {
        const why = e.name === "AbortError"
          ? `it did not answer within ${Math.round(timeoutMs / 1000)}s`
          : e.message;
        return { ok: false, error: `Could not reach OpenAI: ${why}.` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function imageModelFor({ status = imagenStatus(), ...rest } = {}) {
  if (status.connected && status.provider === "imagen") return imagenProvider({ model: status.model, ...rest });
  if (status.connected && status.provider === "openai") return openaiImageProvider({ ...rest });
  return null;
}
