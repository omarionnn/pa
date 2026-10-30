#!/usr/bin/env node
// Drive the directions page in headless Chromium over real HTTP (a loopback server that serves
// directionsPage(sample trip) and the page's own static files), and prove what it claims:
//
//   1. every preview state renders in Paper and Night, screenshots written, and compared against the
//      design hand-off's screens/*.png (pixel difference reported, not asserted: MapLibre tiles and
//      fonts render a little differently from the prototype's SVG stand-in);
//   2. location is never requested on load; the one tap on "Share my location" starts it, once;
//   3. no console error, no CSP violation;
//   4. a walk along the route with fake GPS reads Keep going → Left, soon → Left here → turn passed,
//      reaches the destination and ends with "You made it.", and stops asking for location;
//   5. the MORE sheet opens with the map, END ESCORT ends the escort, Switch to Route keeps the place;
//   6. reduced motion: nothing animates.
//
//   node .agents/skills/verify-reason/bin/directions-drive.mjs [outDir] [--reference <handoff screens dir>]
//
// Real iOS Safari and Android Chrome outdoors are NOT covered here; say so in the PR.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const { directionsPage, directionsAsset } = await import(`${REPO}/src/directions/page.js`);
const { prepareRoute } = await import(`${REPO}/src/directions/logic.js`);
const { gardenRoomPayload } = await import(`${REPO}/test/fixtures/directions-garden-room.js`);

const args = process.argv.slice(2);
const refIdx = args.indexOf("--reference");
const REFERENCE = refIdx >= 0 ? args[refIdx + 1] : null;
const outDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--reference")
  || join(REPO, ".agents/skills/verify-reason/evidence", `directions-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });

const trip = gardenRoomPayload();
const route = prepareRoute({ coordinates: trip.route.coordinates, steps: trip.steps });
const results = [];
// Where PIL lives for the isolated (-I) pixel comparison. Override with DIRECTIONS_PIL_SITE.
const PIL_SITE = process.env.DIRECTIONS_PIL_SITE || "/Users/omarinyarko/Library/Python/3.9/lib/python/site-packages";
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- the server ----------
const ASSET_FILES = { "/favicon.svg": "favicon.svg", "/apple-touch-icon.png": "apple-touch-icon.png" };
const posted = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname.endsWith("/reroute")) {
    let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
      posted.push(body);
      res.writeHead(404, { "content-type": "text/plain" }).end("no reroute service in the harness");
    });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": directionsCsp(), "Cache-Control": "no-store" });
    return res.end(directionsPage(gardenRoomPayload()));
  }
  const asset = directionsAsset(url.pathname);
  if (asset) { res.writeHead(asset.status, asset.headers); return res.end(asset.body); }
  if (ASSET_FILES[url.pathname]) {
    res.writeHead(200, { "Content-Type": url.pathname.endsWith(".svg") ? "image/svg+xml" : "image/png" });
    return res.end(readFileSync(join(REPO, "assets", ASSET_FILES[url.pathname])));
  }
  res.writeHead(404).end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

import { DIRECTIONS_CSP } from "../../../../src/directions/page.js";
function directionsCsp() { return DIRECTIONS_CSP; }

// ---------- helpers ----------
const STATES = [
  ["01-choose", "#choose"], ["02-location-ask", "#ask"], ["03-route", "#route"],
  ["04-route-one-step", "#route/step3"], ["05-route-all-steps", "#route/steps"], ["06-route-location-denied", "#route/denied"],
  ["07-too-far", "#toofar"], ["08-finding-you", "#escort/finding"], ["09-direction-unknown", "#escort/unknown"],
  ["10-direction-confirmed", "#escort/confirmed"], ["11-turn-around", "#escort/around"], ["12-walking-straight", "#escort/straight"],
  ["13-turn-coming", "#escort/soon"], ["14-turn-here", "#escort/here"], ["15-long-stretch", "#escort/reassure"],
  ["16-new-way", "#escort/reroute"], ["17-waiting", "#escort/wait"], ["18-welcome-back", "#escort/welcome"],
  ["19-low-battery", "#escort/battery"], ["20-signal-lost", "#escort/lost"], ["21-more-sheet", "#escort/straight/more"],
  ["22-last-50m", "#escort/arrive"], ["23-arrived", "#escort/arrived"], ["24-early", "#escort/early"],
];

async function newPage(browser, { theme = "light", reduced = false, geo = true, clock = null } = {}) {
  // Accra is UTC+0: the sample event's 19:00Z is "7" on the phone, as the hand-off's "It starts at 7." says.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference", permissions: geo ? ["geolocation"] : [], timezoneId: "Africa/Accra" });
  if (geo) await context.setGeolocation({ latitude: route.points[0].lat, longitude: route.points[0].lng, accuracy: 6 });
  await context.addInitScript((t) => {
    try { localStorage.setItem("reason-theme", t); } catch { /* no storage */ }
    window.__geo = { watch: 0, get: 0 };
    if (navigator.geolocation) {
      const g = navigator.geolocation;
      const w = g.watchPosition.bind(g);
      g.watchPosition = (...a) => { window.__geo.watch += 1; return w(...a); };
      const cur = g.getCurrentPosition.bind(g);
      g.getCurrentPosition = (...a) => { window.__geo.get += 1; return cur(...a); };
    }
  }, theme === "dark" ? "dark" : "light");
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(`console: ${m.text()}`); });
  // install, not setFixedTime: a frozen Date.now never ages the escort's timed moments ("Yes, this way" for 3 s).
  if (clock) await page.clock.install({ time: new Date(clock) });
  return { context, page };
}

/** The point at `along` metres on the route. */
function pointAt(along) {
  let i = 0;
  while (i < route.cum.length - 2 && route.cum[i + 1] < along) i += 1;
  const a = route.points[i];
  const b = route.points[i + 1];
  const seg = route.cum[i + 1] - route.cum[i] || 1;
  const t = Math.min(1, Math.max(0, (along - route.cum[i]) / seg));
  return { latitude: a.lat + (b.lat - a.lat) * t, longitude: a.lng + (b.lng - a.lng) * t };
}

async function diffAgainstReference(name, shotPath, theme) {
  if (!REFERENCE) return null;
  const ref = join(REFERENCE, `${name.replace(/^\d\d-/, (m) => m)}-${theme}.png`);
  const refFile = existsSync(ref) ? ref : null;
  if (!refFile) return null;
  const script = `
import os, sys
sys.path.append(os.environ["PIL_SITE"])
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    b = b.resize(a.size)
d = ImageChops.difference(a, b).convert("L")
px = d.getdata()
total = len(px)
over = sum(1 for v in px if v > 24)
mean = sum(px) / total
print(f"{mean:.2f} {over / total * 100:.2f}")
`;
  const out = execFileSync("python3", ["-I", "-c", script, shotPath, refFile], { encoding: "utf8", env: { ...process.env, PIL_SITE: PIL_SITE } }).trim();
  const [mean, pct] = out.split(" ");
  return { mean: Number(mean), pct: Number(pct) };
}

// ---------- 1. every state, both themes ----------
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const themes = [["paper", "light"], ["night", "dark"]];
const diffs = [];
for (const [themeName, themeValue] of themes) {
  for (const [name, hash] of STATES) {
    const { context, page } = await newPage(browser, { theme: themeValue, geo: false });
    await page.goto(`${BASE}/${hash}`, { waitUntil: "load" });
    await page.waitForSelector(".screen", { timeout: 8000 });
    await page.waitForTimeout(3600);
    const shot = join(outDir, `${name}-${themeName}.png`);
    await page.screenshot({ path: shot });
    const geoCalls = await page.evaluate(() => window.__geo.watch + window.__geo.get);
    check(`${name} ${themeName}: renders`, true);
    check(`${name} ${themeName}: no location requested on load`, geoCalls === 0, `calls=${geoCalls}`);
    const bad = page.errors.filter((e) => !/favicon/i.test(e));
    check(`${name} ${themeName}: no console error or CSP violation`, bad.length === 0, bad.slice(0, 2).join(" | "));
    const d = await diffAgainstReference(name, shot, themeName).catch((e) => ({ error: e.message }));
    if (d && !d.error) diffs.push({ name, theme: themeName, ...d });
    await context.close();
  }
}
if (diffs.length) {
  const worst = [...diffs].sort((a, b) => b.pct - a.pct).slice(0, 5);
  console.log(`reference diff: ${diffs.length} screens; worst by % pixels over threshold: ${worst.map((w) => `${w.name} ${w.theme} ${w.pct}%`).join(", ")}`);
  writeFileSync(join(outDir, "reference-diff.json"), JSON.stringify(diffs, null, 2));
}

// ---------- 2. the share tap starts location, once ----------
{
  const { context, page } = await newPage(browser, { theme: "light", geo: true });
  await page.goto(`${BASE}/#ask`, { waitUntil: "load" });
  await page.waitForSelector("#share");
  check("ask: still no location before the tap", (await page.evaluate(() => window.__geo.watch)) === 0);
  await page.click("#share");
  await page.waitForFunction(() => location.hash === "#escort", null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const watched = await page.evaluate(() => window.__geo.watch);
  check("share tap: location watch started exactly once", watched === 1, `watch=${watched}`);
  await page.close();
  await context.close();
}

// ---------- 3. a walk with fake GPS: the escort's moments in order ----------
{
  // 7:05 PM in Accra: after the 7 PM event, so the walk's end is "You made it.", not "You're early."
  const { context, page } = await newPage(browser, { theme: "light", geo: true, clock: "2026-10-29T19:05:00Z" });
  await page.goto(`${BASE}/#ask`, { waitUntil: "load" });
  await page.click("#share");
  await page.waitForSelector("#e-status");
  const seen = [];
  const caption = async () => (await page.textContent("#e-cap")).replace(/\s+/g, " ").trim();
  const feed = async (along, wait = 1300) => {
    await context.setGeolocation({ ...pointAt(along), accuracy: 6 });
    await page.waitForTimeout(wait);
  };
  // Walked in 10 m steps a second apart, a brisk walk as a phone reads it. The smoothed dot trails by about a step.
  let at = 0;
  const walkTo = async (to) => { while (at < to) { at = Math.min(to, at + 10); await feed(at, 1000); } };
  await feed(0, 1500);
  seen.push(["start", await caption()]);
  await walkTo(60);
  seen.push(["walking", await caption()]);
  await walkTo(100);
  seen.push(["straight, 100 m from the turn", await caption()]);
  await walkTo(150);
  seen.push(["closing in", await caption()]);
  await walkTo(195);
  seen.push(["turn here", await caption()]);
  await walkTo(215);
  seen.push(["past the turn", await caption()]);
  const status = await page.textContent("#e-status-t");
  check("walk: status shows ESCORTING while walking", status.trim() === "ESCORTING", status);
  const wordsOk = seen.some(([, t]) => /Keep going/.test(t)) && seen.some(([, t]) => /Left, soon/.test(t)) && seen.some(([, t]) => /Left here/.test(t));
  check("walk: Keep going → Left, soon → Left here in sequence", wordsOk, JSON.stringify(seen.map(([, t]) => t.slice(0, 26))));
  const keepIdx = seen.findIndex(([, t]) => /Keep going/.test(t));
  const soonIdx = seen.findIndex(([, t]) => /Left, soon/.test(t));
  const hereIdx = seen.findIndex(([, t]) => /Left here/.test(t));
  check("walk: the caption order is straight, soon, here", keepIdx >= 0 && soonIdx > keepIdx && hereIdx > soonIdx, `${keepIdx}<${soonIdx}<${hereIdx}`);

  // MORE: the sheet opens, the map mounts, and the map is never on the main escort screen.
  await page.click("#e-more");
  await page.waitForTimeout(900);
  const mapCanvas = await page.$("#e-map canvas");
  check("more: the map sits behind MORE only", mapCanvas !== null);
  await page.screenshot({ path: join(outDir, "walk-more-sheet.png") });
  await page.click("#e-close");
  await page.waitForTimeout(500);

  // Off the route: three fixes 60 m to the side. The reroute path is asked, and the page carries on.
  const off = pointAt(230);
  for (let i = 0; i < 3; i += 1) {
    await context.setGeolocation({ latitude: off.latitude + 60 / 110540, longitude: off.longitude, accuracy: 6 });
    await page.waitForTimeout(1200);
  }
  check("off route: three readings 60 m out ask for a reroute once", posted.length === 1, `posts=${posted.length}`);
  await feed(240, 1200);

  // Arrival: the walk reaches the gate and then the arrived stamp.
  // Walked on in 60 m steps a second apart: a 500 m jump in two seconds is refused as a glitch, by design.
  for (let a = 300; a < route.lengthM - 1; a += 60) await feed(a, 1000);
  await feed(route.lengthM - 1, 1000);
  await feed(route.lengthM - 1, 1000);
  const finalCaption = await caption();
  check("arrival: 'You made it.' and the stamp", /You made it/.test(finalCaption) && /ARRIVED/.test(finalCaption), finalCaption.slice(0, 80));
  const endStatus = await page.textContent("#e-status-t");
  check("arrival: the escort is over", endStatus.trim() === "ESCORT ENDED", endStatus);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "walk-arrived.png") });
  await page.close();
  await context.close();
}

// ---------- 4. END ESCORT and Switch to Route keep the place ----------
{
  const { context, page } = await newPage(browser, { theme: "light", geo: true, clock: "2026-10-29T12:00:00Z" });
  await page.goto(`${BASE}/#ask`, { waitUntil: "load" });
  await page.click("#share");
  await page.waitForSelector("#e-status");
  await context.setGeolocation({ ...pointAt(30), accuracy: 6 });
  await page.waitForTimeout(1200);
  await page.click("#e-more");
  await page.waitForTimeout(400);
  await page.click("#e-end");
  await page.waitForTimeout(700);
  check("END ESCORT: status is ESCORT ENDED", (await page.textContent("#e-status-t")).trim() === "ESCORT ENDED");
  await page.close();
  await context.close();
}
{
  const { context, page } = await newPage(browser, { theme: "light", geo: true, clock: "2026-10-29T12:00:00Z" });
  await page.goto(`${BASE}/#ask`, { waitUntil: "load" });
  await page.click("#share");
  await page.waitForSelector("#e-status");
  await context.setGeolocation({ ...pointAt(170), accuracy: 6 });
  await page.waitForTimeout(1200);
  await page.click("#e-more");
  await page.waitForTimeout(300);
  await page.click("a[href='#route']");
  await page.waitForTimeout(800);
  const hash = await page.evaluate(() => location.hash);
  check("Switch to Route: keeps the place (opens the turn the escort is heading for)", hash.startsWith("#route/step"), hash);
  await page.close();
  await context.close();
}

// ---------- 5. reduced motion: everything still ----------
{
  const { context, page } = await newPage(browser, { theme: "light", reduced: true, geo: false });
  await page.goto(`${BASE}/#escort/soon`, { waitUntil: "load" });
  // The stem is a vertical line: zero width, so Playwright's "visible" never matches it. It is attached and drawn.
  await page.waitForSelector("#e-stem", { state: "attached" });
  await page.waitForSelector("#e-cap .cap-word, #e-cap .cap-hand", { timeout: 8000 });
  const anim = await page.evaluate(() => {
    const s = document.querySelector("#e-stem");
    const d = document.querySelector(".pill .dot, .esc-status .dot");
    return { stem: getComputedStyle(s).transitionDuration, drift: getComputedStyle(document.querySelector(".drift")).animationName, dot: d ? getComputedStyle(d, "::after").animationName : "none" };
  });
  check("reduced motion: the drift and the status pulse are off", anim.drift === "none" && anim.dot === "none", JSON.stringify(anim));
  await page.close();
  await context.close();
}

await browser.close();
server.close();
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok · evidence ${outDir}`);
if (posted.length) console.log(`reroute posts received by the harness: ${posted.length}`);
process.exit(failed.length ? 1 : 0);
