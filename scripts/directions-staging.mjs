#!/usr/bin/env node
// The walking directions page as a static staging copy, for walking it on a phone before it ships.
//
//   node scripts/directions-staging.mjs            → writes dist/directions-staging/
//   node scripts/directions-staging.mjs --deploy   → also deploys it as a draft deploy ("directions") of the
//                                                    reason-web-staging Netlify site: its own URL, never
//                                                    the published staging copy, never the marketing site
//
// Every file is what Reason's own server answers (directionsRequest, flags on, the made-up sample trip), so
// the copy is the page byte for byte. Static means no reroute: the page asks, gets nothing, keeps its saved
// route, exactly as it does when the server is unreachable. An index lists every hand-off state.
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { directionsRequest } from "../src/pages/directions.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repo, "dist", "directions-staging");
const SITE = "c749fa22-03a3-4a51-9b80-1081b789fede"; // reason-web-staging
const ALIAS = "directions";
const config = { directionsOn: true, directionsSample: true, directionsRouting: "" };

const get = async (pathname) => {
  const out = await directionsRequest({ method: "GET", pathname, config });
  if (!out || out.status !== 200) throw new Error(`${pathname}: ${out ? out.status : "no answer"}`);
  return out;
};

rmSync(outDir, { recursive: true, force: true });
const files = {
  "d/sample/index.html": "/d/sample",
  "d/app.js": "/d/app.js",
  "d/vendor/maplibre-gl.mjs": "/d/vendor/maplibre-gl.mjs",
  "d/vendor/maplibre-gl-worker.mjs": "/d/vendor/maplibre-gl-worker.mjs",
  "d/vendor/maplibre-gl.css": "/d/vendor/maplibre-gl.css",
  "d/vendor/suncalc.js": "/d/vendor/suncalc.js",
  ...Object.fromEntries(["serif", "roman", "sans", "hand", "handbold"].map((f) => [`d/fonts/${f}.woff2`, `/d/fonts/${f}.woff2`])),
};
let csp = "";
for (const [file, path] of Object.entries(files)) {
  const out = await get(path);
  if (path === "/d/sample") csp = out.headers["Content-Security-Policy"];
  mkdirSync(dirname(join(outDir, file)), { recursive: true });
  writeFileSync(join(outDir, file), out.body);
}

const STATES = [
  ["Choose how to go", ""], ["Location ask", "#ask"], ["Route", "#route"], ["Route, one step", "#route/step3"],
  ["Route, all steps", "#route/steps"], ["Route, location denied", "#route/denied"], ["Too far to walk", "#toofar"],
  ["Escort, a whole trip on a loop", "#escort"], ["Finding you", "#escort/finding"], ["Direction unknown", "#escort/unknown"],
  ["Direction confirmed", "#escort/confirmed"], ["Turn around", "#escort/around"], ["Walking straight", "#escort/straight"],
  ["Turn coming", "#escort/soon"], ["Turn here", "#escort/here"], ["Long stretch", "#escort/reassure"],
  ["New way", "#escort/reroute"], ["Waiting", "#escort/wait"], ["Welcome back", "#escort/welcome"],
  ["Low battery", "#escort/battery"], ["Signal lost", "#escort/lost"], ["MORE sheet", "#escort/straight/more"],
  ["Last 50 m", "#escort/arrive"], ["Arrived", "#escort/arrived"], ["Early", "#escort/early"],
];
const li = STATES.map(([name, hash]) => `<li><a href="/d/sample/${hash}">${name}</a> · <a href="/d/sample/?theme=night${hash}">Night</a></li>`).join("\n");
writeFileSync(join(outDir, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Directions — staging</title>
<style>body{font:17px/1.6 system-ui,sans-serif;margin:24px;background:#f2ebe0;color:#2a2520}a{color:#9c3b2e}li{margin:6px 0}</style></head><body>
<h1 style="font-weight:400;font-style:italic;font-family:Georgia,serif">Directions page · staging</h1>
<p>Made-up sample trip (The Garden Room, Osu, Accra). The Escort walk with your own location needs a real trip near you, which Reason does not make yet; the states below are the hand-off's previews.</p>
<ol>${li}</ol></body></html>`);
writeFileSync(join(outDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
writeFileSync(join(outDir, "_headers"), `/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n/d/sample/*\n  Content-Security-Policy: ${csp}\n  Cache-Control: no-store\n/d/app.js\n  Cache-Control: no-cache\n/d/vendor/maplibre-gl.mjs\n  Content-Type: text/javascript; charset=utf-8\n/d/vendor/maplibre-gl-worker.mjs\n  Content-Type: text/javascript; charset=utf-8\n`);
console.log(`wrote ${outDir}`);

if (process.argv.includes("--deploy")) {
  // A draft deploy on the staging site: its own URL, the published staging copy untouched. The Netlify CLI's
  // saved login is used (~/Library/Preferences/netlify/config.json); the token is never printed.
  const conf = JSON.parse(readFileSync(join(homedir(), "Library/Preferences/netlify/config.json"), "utf8"));
  const token = Object.values(conf.users || {}).map((u) => u.auth && u.auth.token).find(Boolean);
  if (!token) throw new Error("no Netlify login on this Mac");
  const zip = join(repo, "dist", "directions-staging.zip");
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, "."], { cwd: outDir });
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${SITE}/deploys?draft=true&branch=${ALIAS}&title=${encodeURIComponent("directions staging")}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" }, body: readFileSync(zip),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`netlify ${res.status}: ${body.message || ""}`);
  console.log(JSON.stringify({ id: body.id, state: body.state, url: body.deploy_ssl_url, branch: body.branch, alias: body.links && body.links.alias }));
}
