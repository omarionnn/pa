// The directions page: one HTML document with its route embedded as JSON, plus the static files it
// loads (the client, the logic, the stylesheet, MapLibre, suncalc, the fonts). The page is built
// from parseDirectionsPayload's output and nothing else: no key, no secret, no request to a routing
// service from the phone.
//
// Not routed by the live server yet. A directions page needs a stored payload and a route to read
// it from (remaining work, listed in the PR). Until then, directionsPage() is what the page is, and
// directionsAsset() serves the files it names.

import { readFileSync } from "node:fs";
import { esc } from "../pages/render.js";
import { wordmark, WORDMARK_CSS } from "../pages/wordmark.js";
import { parseDirectionsPayload } from "./payload.js";

const here = (p) => new URL(p, import.meta.url);

/** Every file the page loads, by the path the browser asks for. */
const FILES = Object.freeze({
  "/directions/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/directions/logic.js": { file: "logic.js", type: "text/javascript; charset=utf-8" },
  "/directions/tokens.js": { file: "tokens.js", type: "text/javascript; charset=utf-8" },
  "/directions/demo.js": { file: "demo.js", type: "text/javascript; charset=utf-8" },
  "/directions/directions.css": { file: "directions.css", type: "text/css; charset=utf-8" },
  "/directions/vendor/maplibre-gl.mjs": { file: "../../node_modules/maplibre-gl/dist/maplibre-gl.mjs", type: "text/javascript; charset=utf-8" },
  "/directions/vendor/maplibre-gl-worker.mjs": { file: "../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", type: "text/javascript; charset=utf-8" },
  "/directions/vendor/maplibre-gl.css": { file: "../../node_modules/maplibre-gl/dist/maplibre-gl.css", type: "text/css; charset=utf-8" },
  "/directions/vendor/suncalc.js": { file: "../../node_modules/suncalc/index.js", type: "text/javascript; charset=utf-8" },
  "/directions/fonts/instrument-serif-italic.woff2": { file: "../../assets/fonts/instrument-serif-italic-web.woff2", type: "font/woff2" },
  "/directions/fonts/instrument-serif-regular.woff2": { file: "../../assets/fonts/instrument-serif-regular-web.woff2", type: "font/woff2" },
  "/directions/fonts/inter.woff2": { file: "../../assets/fonts/inter-web.woff2", type: "font/woff2" },
  "/directions/fonts/caveat-400.woff2": { file: "../../assets/fonts/caveat-400-web.woff2", type: "font/woff2" },
  "/directions/fonts/caveat-600.woff2": { file: "../../assets/fonts/caveat-600-web.woff2", type: "font/woff2" },
});

const FONT_FACES = `
@font-face{font-family:"Caveat";font-weight:400;font-display:swap;src:url(/directions/fonts/caveat-400.woff2) format("woff2")}
@font-face{font-family:"Caveat";font-weight:600;font-display:swap;src:url(/directions/fonts/caveat-600.woff2) format("woff2")}
@font-face{font-family:"Instrument Serif";font-style:italic;font-weight:400;font-display:swap;src:url(/directions/fonts/instrument-serif-italic.woff2) format("woff2")}
@font-face{font-family:"Instrument Serif";font-style:normal;font-weight:400;font-display:swap;src:url(/directions/fonts/instrument-serif-regular.woff2) format("woff2")}
@font-face{font-family:"Inter";font-weight:400 600;font-display:swap;src:url(/directions/fonts/inter.woff2) format("woff2")}`;

/** Locked down: nothing loads from anywhere but this server, no inline script, no framing. */
export const DIRECTIONS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const DIRECTIONS_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": DIRECTIONS_CSP,
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
});

/** The route as JSON inside a script tag: `<` escaped so nothing in the data can close the tag. */
export function embedJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * The page for one trip. `payload` is validated again here (the page is only as safe as what it is
 * given). `choice` is the saved Reason theme ("light", "dark" or null), read by the page before paint
 * so there is no flash of the wrong theme.
 */
export function directionsPage(payload) {
  const trip = parseDirectionsPayload(payload);
  const title = `${trip.destination.name} · Directions`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f2ebe0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1814" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${FONT_FACES}
${WORDMARK_CSS}</style>
<link rel="stylesheet" href="/directions/vendor/maplibre-gl.css">
<link rel="stylesheet" href="/directions/directions.css">
</head>
<body>
<template id="wordmark-tpl">${wordmark()}</template>
<div id="app" aria-live="polite"></div>
<noscript><main class="screen paper" style="padding:24px;height:auto;min-height:100vh"><p class="serif" style="font-size:34px;margin:0 0 16px">${esc(trip.destination.name)}</p><p>${esc(trip.destination.address)}</p><p>Walk ${esc(String(trip.walk.minutes))} minutes, ${esc(String(Math.round(trip.walk.meters)))} metres. Turn by turn needs JavaScript; the steps are below.</p><ol>${trip.steps.map((s) => `<li>${esc(s.instr)}${s.mark ? `. ${esc(s.mark)}` : ""} (${esc(String(Math.round(s.distanceM)))} m)</li>`).join("")}</ol></main></noscript>
<script id="directions-data" type="application/json">${embedJson(trip)}</script>
<script type="module" src="/directions/app.js"></script>
</body>
</html>
`;
}

/**
 * The static files a directions page loads. Returns { status, headers, body } or null when the
 * path is not one of them, so the server carries on to its other routes.
 */
export function directionsAsset(pathname) {
  const entry = FILES[pathname];
  if (!entry) return null;
  let body;
  try {
    body = readFileSync(here(entry.file));
  } catch {
    return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "not found" };
  }
  return {
    status: 200,
    headers: {
      "Content-Type": entry.type,
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
    body,
  };
}
