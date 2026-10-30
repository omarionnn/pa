#!/usr/bin/env node
// Drive the walking directions page (/d/sample, src/pages/directions.js) in headless Chromium over real HTTP,
// and prove what it claims. The harness serves the page through Reason's own directionsRequest with the flags
// on, and answers the reroute's routing call itself (a stand-in OSRM router on the same loopback port), so a
// reroute really comes back and the page really takes the new way.
//
//   1. all 24 hand-off states render in Paper and Night, screenshots written and compared with the hand-off's
//      screens/*.png (pixel difference reported, not asserted: the map is MapLibre, the prototype's is SVG);
//   2. location is never requested on load; the one tap on "Share my location" starts it, once;
//   3. no console error, no CSP violation;
//   4. a fake-GPS walk reads Just start walking → Yes, this way ✓ → Keep going → Left, soon → Left here, in
//      order; three readings 60 m off the route ask for one reroute, "No worries, here's a new way." shows, and
//      the walk carries on along the new way; at the gate, after the event's start, "You made it." and the
//      ARRIVED stamp, the escort ends and stops reading location;
//   5. MORE shows the map (and only MORE does); END ESCORT ends; Switch to Route keeps the place;
//   6. reduced motion: the drift and the status pulse are off.
//
//   node .agents/skills/verify-reason/bin/directions-drive.mjs [outDir] [--reference <hand-off screens dir>]
//
// Not covered: a real iPhone or Android phone outdoors at walking pace. Say so wherever this is quoted.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const { directionsRequest, sampleTrip } = await import(`${REPO}/src/pages/directions.js`);
const { lineOf, project } = await import(`${REPO}/src/pages/directionsclient.js`);

const args = process.argv.slice(2);
const refIdx = args.indexOf("--reference");
const REFERENCE = refIdx >= 0 ? args[refIdx + 1] : null;
const outDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--reference")
  || join(REPO, ".agents/skills/verify-reason/evidence", `directions-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
const PIL_SITE = process.env.DIRECTIONS_PIL_SITE || "/Users/omarinyarko/Library/Python/3.9/lib/python/site-packages";

const trip = sampleTrip();
const route = lineOf(trip.route);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- the server: Reason's own handler, flags on, plus a stand-in router ----------
const routed = [];
/** The stand-in router: back to the nearest point of the sample route, then the rest of it, as OSRM answers. */
function osrmAnswer(from) {
  const pr = project(from, route);
  const rest = route.points.slice(pr.seg + 1);
  const coords = [from, pr.at, ...rest].map((p) => [p.lng, p.lat]);
  const step = (type, modifier, at, name, distance) => ({ maneuver: { type, modifier, location: [at.lng, at.lat] }, name, distance });
  const steps = [step("depart", undefined, from, "", 60), step("turn", "left", pr.at, "Oxford St", Math.round(route.cum[pr.seg + 1] - pr.along))];
  const turns = trip.steps.filter((s) => project(s, route).along > pr.along + 1);
  for (const s of turns) steps.push(step(s === trip.steps.at(-1) ? "arrive" : s.turn === "roundabout" ? "roundabout" : "turn", s.turn === "roundabout" ? undefined : s.turn, s, "", 100));
  return { code: "Ok", routes: [{ geometry: { type: "LineString", coordinates: coords }, legs: [{ steps }] }] };
}
let BASE = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const osrm = /^\/osrm\/route\/v1\/foot\/([-\d.]+),([-\d.]+);/.exec(url.pathname);
  if (osrm) {
    routed.push(url.pathname);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(osrmAnswer({ lng: Number(osrm[1]), lat: Number(osrm[2]) })));
  }
  const config = { directionsOn: true, directionsSample: true, directionsRouting: `${BASE}/osrm` };
  const out = await directionsRequest({ method: req.method, pathname: url.pathname, req, config });
  if (!out) { res.writeHead(404).end("not found"); return; }
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
BASE = `http://127.0.0.1:${server.address().port}`;
const PAGE = `${BASE}/d/sample`;

// ---------- helpers ----------
const STATES = [
  ["01-choose", ""], ["02-location-ask", "#ask"], ["03-route", "#route"],
  ["04-route-one-step", "#route/step3"], ["05-route-all-steps", "#route/steps"], ["06-route-location-denied", "#route/denied"],
  ["07-too-far", "#toofar"], ["08-finding-you", "#escort/finding"], ["09-direction-unknown", "#escort/unknown"],
  ["10-direction-confirmed", "#escort/confirmed"], ["11-turn-around", "#escort/around"], ["12-walking-straight", "#escort/straight"],
  ["13-turn-coming", "#escort/soon"], ["14-turn-here", "#escort/here"], ["15-long-stretch", "#escort/reassure"],
  ["16-new-way", "#escort/reroute"], ["17-waiting", "#escort/wait"], ["18-welcome-back", "#escort/welcome"],
  ["19-low-battery", "#escort/battery"], ["20-signal-lost", "#escort/lost"], ["21-more-sheet", "#escort/straight/more"],
  ["22-last-50m", "#escort/arrive"], ["23-arrived", "#escort/arrived"], ["24-early", "#escort/early"],
];
// The sample event starts at 19:00 UTC (7 PM in Accra) on the server's day; the walk ends five minutes after.
const startsAt = trip.startsAt;

async function newPage(browser, { theme = "light", reduced = false, geo = true, clock = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference", permissions: geo ? ["geolocation"] : [], timezoneId: "Africa/Accra" });
  if (geo) await context.setGeolocation({ latitude: route.points[0].lat, longitude: route.points[0].lng, accuracy: 6 });
  await context.addInitScript((t) => {
    try { localStorage.setItem("reason-theme", t); } catch { /* no storage */ }
    window.__geo = { watch: 0, get: 0, clear: 0 };
    if (navigator.geolocation) {
      const g = navigator.geolocation;
      const w = g.watchPosition.bind(g);
      g.watchPosition = (...a) => { window.__geo.watch += 1; return w(...a); };
      const cur = g.getCurrentPosition.bind(g);
      g.getCurrentPosition = (...a) => { window.__geo.get += 1; return cur(...a); };
      const clr = g.clearWatch.bind(g);
      g.clearWatch = (...a) => { window.__geo.clear += 1; return clr(...a); };
    }
  }, theme === "dark" ? "dark" : "light");
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(`console: ${m.text()}`); });
  // install, not setFixedTime: a frozen Date.now never ages the escort's timed moments.
  if (clock) await page.clock.install({ time: new Date(clock) });
  return { context, page };
}

/** The point at `along` metres on the sample route. */
function pointAt(along) {
  let i = 0;
  while (i < route.cum.length - 2 && route.cum[i + 1] < along) i += 1;
  const a = route.points[i];
  const b = route.points[i + 1];
  const seg = route.cum[i + 1] - route.cum[i] || 1;
  const t = Math.min(1, Math.max(0, (along - route.cum[i]) / seg));
  return { latitude: a.lat + (b.lat - a.lat) * t, longitude: a.lng + (b.lng - a.lng) * t };
}

function diffAgainstReference(name, shotPath, theme) {
  if (!REFERENCE) return null;
  const ref = join(REFERENCE, `${name}-${theme}.png`);
  if (!existsSync(ref)) return null;
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
print(f"{sum(px) / total:.2f} {over / total * 100:.2f}")
`;
  const out = execFileSync("python3", ["-I", "-c", script, shotPath, ref], { encoding: "utf8", env: { ...process.env, PIL_SITE } }).trim();
  const [mean, pct] = out.split(" ");
  return { mean: Number(mean), pct: Number(pct) };
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

// ---------- 1. every state, both themes ----------
const diffs = [];
for (const [themeName, themeValue] of [["paper", "light"], ["night", "dark"]]) {
  for (const [name, hash] of STATES) {
    const { context, page } = await newPage(browser, { theme: themeValue, geo: false });
    await page.goto(`${PAGE}${hash}`, { waitUntil: "load" });
    await page.waitForSelector("#app > *", { timeout: 8000 });
    await page.waitForTimeout(3600);
    const shot = join(outDir, `${name}-${themeName}.png`);
    await page.screenshot({ path: shot });
    const geoCalls = await page.evaluate(() => window.__geo.watch + window.__geo.get);
    check(`${name} ${themeName}: no location requested on load`, geoCalls === 0, `calls=${geoCalls}`);
    const bad = page.errors.filter((e) => !/favicon/i.test(e));
    check(`${name} ${themeName}: no console error or CSP violation`, bad.length === 0, bad.slice(0, 2).join(" | "));
    if (/^0[3-6]-|^21-/.test(name)) {
      const canvas = await page.$(name.startsWith("21") ? "#e-map canvas" : "#r-map canvas");
      check(`${name} ${themeName}: the map is drawn (MapLibre, no tiles, no key)`, canvas !== null);
    }
    const d = (() => { try { return diffAgainstReference(name, shot, themeName); } catch (e) { return { error: e.message }; } })();
    if (d && !d.error) diffs.push({ name, theme: themeName, ...d });
    await context.close();
  }
}
if (diffs.length) {
  const worst = [...diffs].sort((a, b) => b.pct - a.pct).slice(0, 6);
  const avg = diffs.reduce((a, d) => a + d.pct, 0) / diffs.length;
  console.log(`reference diff: ${diffs.length} screens, mean ${avg.toFixed(2)}% of pixels over threshold; worst: ${worst.map((w) => `${w.name} ${w.theme} ${w.pct}%`).join(", ")}`);
  writeFileSync(join(outDir, "reference-diff.json"), JSON.stringify(diffs, null, 2));
}

// ---------- 2. the share tap starts location, once ----------
{
  const { context, page } = await newPage(browser, { geo: true });
  await page.goto(`${PAGE}#ask`, { waitUntil: "load" });
  await page.waitForSelector("#a-share");
  check("ask: still no location before the tap", (await page.evaluate(() => window.__geo.watch)) === 0);
  await page.click("#a-share");
  await page.waitForFunction(() => location.hash === "#escort", null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const watched = await page.evaluate(() => window.__geo.watch);
  check("share tap: location watch started exactly once", watched === 1, `watch=${watched}`);
  await context.close();
}

// ---------- 3. a walk with fake GPS: the escort's moments in order ----------
{
  const { context, page } = await newPage(browser, { geo: true, clock: startsAt + 5 * 60000 });
  await page.goto(`${PAGE}#ask`, { waitUntil: "load" });
  await page.click("#a-share");
  await page.waitForSelector("#e-status");
  const caption = async () => ((await page.textContent(".cap.on").catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const seen = [];
  const note = async (label) => { const t = await caption(); if (!seen.length || seen.at(-1)[1] !== t) seen.push([label, t]); };
  const feedAt = async (p, wait = 1000) => {
    await context.setGeolocation({ ...p, accuracy: 6 });
    for (let k = 0; k < wait; k += 250) { await page.waitForTimeout(250); await note(""); }
  };
  let at = 0;
  const walkTo = async (to, stepM = 10) => { while (at < to) { at = Math.min(to, at + stepM); await feedAt(pointAt(at)); } };
  await feedAt(pointAt(0), 1500);
  await walkTo(215);
  const order = (re) => seen.findIndex(([, t]) => re.test(t));
  const iStart = order(/Just start walking/), iYes = order(/Yes, this way/), iKeep = seen.findIndex(([, t], i) => i > iYes && /Keep going/.test(t));
  const iSoon = order(/Left, soon/), iHere = order(/Left here/);
  check("walk: Just start walking → Yes, this way ✓ → Keep going → Left, soon → Left here, in order",
    iStart >= 0 && iYes > iStart && iKeep > iYes && iSoon > iKeep && iHere > iSoon, JSON.stringify(seen.map(([, t]) => t.slice(0, 24))));
  check("walk: status shows ESCORTING while walking", (await page.textContent("#e-status-t")).trim() === "ESCORTING");
  const soonSub = seen.find(([, t]) => /Left, soon/.test(t));
  check("walk: the turn's facts line reads metres and the landmark", !!soonSub && /\d+ M · AT THE TRAFFIC LIGHTS/.test(soonSub[1]), soonSub ? soonSub[1] : "");

  // MORE: the sheet opens with the map; the main escort screen has no map.
  check("escort: no map on the main screen", (await page.$$eval("#e-map canvas", (c) => c.length)) === 0);
  await page.click("#e-more");
  await page.waitForTimeout(1500);
  check("more: the map sits behind MORE", (await page.$("#e-map canvas")) !== null);
  await page.screenshot({ path: join(outDir, "walk-more-sheet.png") });
  await page.click("#e-close");
  await page.waitForTimeout(500);

  // Off the route: on along Oxford St to 260 m, then a wrong turn north up a side street, a step a second,
  // out to 75 m. One reroute, the note, and the new way is taken.
  await walkTo(260);
  const off = pointAt(260);
  seen.length = 0;
  for (let n = 10; n <= 75; n += 10) await feedAt({ latitude: off.latitude + n / 111195, longitude: off.longitude }, 1000);
  await feedAt({ latitude: off.latitude + 80 / 111195, longitude: off.longitude }, 2500);
  await page.waitForTimeout(800);
  await note("");
  check("off route: one reroute asked of Reason's router", routed.length === 1, `routed=${routed.length}`);
  check("off route: \"No worries, here's a new way.\" (never 'Recalculating')", seen.some(([, t]) => /No worries, here.s a new way/.test(t)) && !seen.some(([, t]) => /Recalculat/i.test(t)), JSON.stringify(seen.map(([, t]) => t.slice(0, 30))));
  await page.screenshot({ path: join(outDir, "walk-new-way.png") });
  // Back onto the way: the walk carries on along the new route.
  at = 260;
  await feedAt(pointAt(at), 1500);
  await walkTo(330, 15);
  const after = await caption();
  check("after the reroute: the escort carries on (no stuck note)", !/No worries/.test(after) && after.length > 0, after.slice(0, 50));

  // Arrival: walked on to the gate, five minutes after the event began: "You made it.", not "You're early."
  seen.length = 0;
  await walkTo(route.total - 1, 30);
  await feedAt(pointAt(route.total - 1), 4500);
  const finalCaption = await caption();
  check("last 50 m: the gate note showed on the way in", seen.some(([, t]) => /Look for the gate/.test(t)), JSON.stringify(seen.map(([, t]) => t.slice(0, 24))));
  check("arrival: 'You made it.' with the ARRIVED stamp (not early)", /You made it/.test(finalCaption) && /ARRIVED/.test(finalCaption) && !/early/.test(finalCaption), finalCaption.slice(0, 80));
  check("arrival: the escort is over", (await page.textContent("#e-status-t")).trim() === "ESCORT ENDED");
  check("arrival: the footer says location has stopped, and it has", /stopped using your location/.test(await page.textContent("#e-foot")) && (await page.evaluate(() => window.__geo.clear)) >= 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "walk-arrived.png") });
  await context.close();
}

// ---------- 3b. arriving before the event: "You're early." ----------
{
  const { context, page } = await newPage(browser, { geo: true, clock: startsAt - 40 * 60000 });
  await page.goto(`${PAGE}#ask`, { waitUntil: "load" });
  await page.click("#a-share");
  await page.waitForSelector("#e-status");
  for (let a = 0; a <= route.total; a += 15) { await context.setGeolocation({ ...pointAt(Math.min(a, route.total - 1)), accuracy: 6 }); await page.waitForTimeout(400); }
  await context.setGeolocation({ ...pointAt(route.total - 1), accuracy: 6 });
  await page.waitForTimeout(4500);
  const t = ((await page.textContent(".cap.on")) || "").replace(/\s+/g, " ");
  check("early arrival: \"You're early. It starts at 7.\"", /You.re early\. It starts at 7/.test(t), t.slice(0, 60));
  await context.close();
}

// ---------- 4. END ESCORT, and Switch to Route keeps the place ----------
{
  const { context, page } = await newPage(browser, { geo: true });
  await page.goto(`${PAGE}#ask`, { waitUntil: "load" });
  await page.click("#a-share");
  await page.waitForSelector("#e-status");
  await context.setGeolocation({ ...pointAt(30), accuracy: 6 });
  await page.waitForTimeout(1200);
  await page.click("#e-more");
  await page.waitForTimeout(500);
  await page.click("#e-end");
  await page.waitForTimeout(700);
  check("END ESCORT: status is ESCORT ENDED", (await page.textContent("#e-status-t")).trim() === "ESCORT ENDED");
  await context.close();
}
{
  const { context, page } = await newPage(browser, { geo: true });
  await page.goto(`${PAGE}#ask`, { waitUntil: "load" });
  await page.click("#a-share");
  await page.waitForSelector("#e-status");
  for (let a = 0; a <= 230; a += 10) { await context.setGeolocation({ ...pointAt(a), accuracy: 6 }); await page.waitForTimeout(350); }
  await page.waitForTimeout(800);
  await page.click("#e-more");
  await page.waitForTimeout(400);
  await page.click("#e-sheet a[href^='#route']");
  await page.waitForTimeout(1200);
  const hash = await page.evaluate(() => location.hash);
  check("Switch to Route: keeps the place (opens on the turn ahead)", /^#route\/step\d+$/.test(hash) && hash !== "#route/step1", hash);
  await page.screenshot({ path: join(outDir, "switch-to-route.png") });
  await context.close();
}

// ---------- 5. reduced motion: everything still ----------
{
  const { context, page } = await newPage(browser, { reduced: true, geo: false });
  await page.goto(`${PAGE}#escort/soon`, { waitUntil: "load" });
  await page.waitForSelector("#e-stem", { state: "attached" });
  const anim = await page.evaluate(() => ({
    drift: getComputedStyle(document.querySelector(".drift")).animationName,
    dot: getComputedStyle(document.querySelector(".esc-status .dot"), "::after").animationName,
  }));
  check("reduced motion: the drift and the status pulse are off", anim.drift === "none" && anim.dot === "none", JSON.stringify(anim));
  await context.close();
}

await browser.close();
server.close();
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok · evidence ${outDir}`);
process.exit(failed.length ? 1 : 0);
