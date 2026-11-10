// Image generation: OpenAI gpt-image-2, the one picture model Reason uses (owner, 2026-11-09).
//
//   POST https://api.openai.com/v1/images/generations
//   Authorization: Bearer {key}
//   body: { model, prompt, n, size }
//   response: { data: [{ b64_json }] }
//
// Google Imagen used to go first, but Google retired imagen-3.0-generate-002 (every call 404'd from
// 2026-11-06), so every picture paid a wasted call before falling back to OpenAI and the status
// page's Gemini row went amber. The owner's call: OpenAI only, no first try anywhere else.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export function imagenStatus({ openaiKey = config.openaiKey } = {}) {
  if (openaiKey) return { connected: true, provider: "openai", what: "OpenAI gpt-image-2 (image generation)", model: OPENAI_IMAGE_MODEL };
  return {
    connected: false,
    provider: "openai",
    missing: ["OPENAI_API_KEY"],
    why: "No image model is connected, so pictures cannot be generated. Connecting it needs OPENAI_API_KEY.",
  };
}

const OPENAI_IMAGE_MODEL = "gpt-image-2";

const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];

const OPENAI_SIZE = { "1:1": "1024x1024", "3:4": "1024x1536", "4:3": "1536x1024", "16:9": "1536x1024", "9:16": "1024x1536" };

export function openaiImageProvider({
  apiKey = config.openaiKey,
  model = OPENAI_IMAGE_MODEL,
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
          if (res.status === 400 && /moderation_blocked|safety/i.test(body)) {
            return { ok: false, error: "The image was blocked by the image model's safety filter. Try rephrasing the description." };
          }
          return { ok: false, error: `The image model refused: ${res.status}. ${body.slice(0, 300)}` };
        }

        let json;
        try { json = JSON.parse(body); } catch {
          return { ok: false, error: "The image model answered with something that was not JSON." };
        }

        const items = json?.data ?? [];
        if (!items.length) {
          return { ok: false, error: "The image model came back with no images." };
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
        return { ok: false, error: `Could not reach the image model: ${why}.` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The picture model, or null when none is connected. Every caller that makes a picture comes here. */
export function imageModelFor({ status = imagenStatus(), ...rest } = {}) {
  return status.connected ? openaiImageProvider({ ...rest }) : null;
}
