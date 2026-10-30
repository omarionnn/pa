#!/usr/bin/env node
// The directions page at iPhone size, as Safari shows it: 390 x 844 with the status bar on top and Safari's
// bottom bar (address pill + toolbar) taking the foot of the screen. The page itself gets what is left
// (390 x 664, its 100dvh), which is where "ONLY YOU CAN SEE THIS PAGE" sat on the divider and "Show me the
// route" was cut off (Omari's walk, 10-30). Silent like the drive: --mute-audio and speech is a recorder.
//
//   node .agents/skills/verify-reason/bin/directions-iphone.mjs [outDir]
//
// Checks, at that size: nothing on the choose screen overlaps and all of it is reachable above the bar;
// on Escort the facts line and MORE are separate rows; the ESCORTING ring is centred on its dot and clear
// of the label; the MORE sheet's map is interactive (a drag and a two-finger pinch move it, RECENTRE shows);
// "Okay, new way from here." replaces "turn around". Each screen is saved framed in a phone (status bar +
// Safari's bar) as <outDir>/iphone-*.png.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const { directionsRequest, directionsPage, sampleTrip } = await import(`${REPO}/src/pages/directions.js`);
const outDir = process.argv[2] || join(REPO, ".agents/skills/verify-reason/evidence", `directions-iphone-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

const W = 390, H = 844, STATUS = 59, BAR = 121, VIEW = H - STATUS - BAR; // 664: the page's 100dvh
const config = { directionsOn: true, directionsSample: true, directionsRouting: "" };
// Omari's trip had a two-line address ("430, West 17th Street, Robert Fulton Houses"): the sample, worded so.
const longTrip = { ...sampleTrip(), name: "Work", address: "430, West 17th Street, Robert Fulton Houses", walk: "23 MIN WALK · 1.7 KM" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/d/long") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(directionsPage(longTrip)); }
  const out = await directionsRequest({ method: req.method, pathname: url.pathname, req, config });
  if (!out) { res.writeHead(404).end(); return; }
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

const browser = await chromium.launch({ args: ["--mute-audio", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
async function phone(path, { motion = false, scale = 2 } = {}) {
  const context = await browser.newContext({ viewport: { width: W, height: VIEW }, deviceScaleFactor: scale, isMobile: true, hasTouch: true, reducedMotion: motion ? "no-preference" : "reduce" });
  await context.addInitScript(() => {
    window.__said = [];
    const recorder = { speak: (u) => window.__said.push(u && u.text), cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, "speechSynthesis", { value: recorder, configurable: true });
    window.SpeechSynthesisUtterance = class { constructor(t = "") { this.text = String(t); } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  await page.waitForTimeout(1600);
  return { context, page, errors };
}
const shots = [];
async function shoot(page, name) {
  const raw = join(outDir, `raw-${name}.png`);
  await page.screenshot({ path: raw });
  shots.push([raw, join(outDir, `iphone-${name}.png`)]);
}
/** Boxes of the elements matching each selector that are showing. */
const boxes = (page, sels) => page.evaluate((sels) => sels.map((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed").map((e) => { const r = e.getBoundingClientRect(); return { s, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })).flat(), sels);
const apart = (a, b) => a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5 || a.right <= b.left + 0.5 || b.right <= a.left + 0.5;

// ---------- 5. the choose screen, with a two-line address ----------
for (const [path, name] of [["/d/long", "choose-long-address"], ["/d/sample", "choose"]]) {
  const { context, page, errors } = await phone(path);
  const b = await boxes(page, [".flow nav .choice", ".flow-foot", ".flow-head", ".flow-line"]);
  const foot = b.find((x) => x.s === ".flow-foot");
  const choices = b.filter((x) => x.s === ".flow nav .choice");
  check(`${name}: ONLY YOU CAN SEE THIS PAGE is clear of both choices and their dividers`, foot && choices.every((c) => apart(c, foot)), JSON.stringify({ foot, last: choices.at(-1) }));
  check(`${name}: no two blocks overlap`, b.every((x, i) => b.every((y, j) => j <= i || apart(x, y) || (x.s === y.s && x.s !== ".flow nav .choice"))));
  // Reachable: scrolled to the end, the route choice and the line sit fully above Safari's bar.
  await page.evaluate(() => { const f = document.querySelector(".flow"); f.scrollTop = f.scrollHeight; });
  await page.waitForTimeout(200);
  const after = await boxes(page, [".flow nav .choice", ".flow-foot"]);
  check(`${name}: "Show me the route" and the footer line are fully on screen above the bar (scrolled if needed)`, after.every((x) => x.bottom <= VIEW + 0.5 && x.top >= 0), JSON.stringify(after.map((x) => Math.round(x.bottom))));
  await page.evaluate(() => { document.querySelector(".flow").scrollTop = 0; });
  await shoot(page, name);
  check(`${name}: no page error`, errors.length === 0, errors[0] || "");
  await context.close();
}

// ---------- 6. Escort: facts line and MORE on separate rows; the ring on its dot ----------
{
  const { context, page, errors } = await phone("/d/long#escort/straight");
  await page.waitForTimeout(800);
  const b = await boxes(page, [".cap.on .cap-sub", "#e-more", ".stage", ".caps"]);
  const sub = b.find((x) => x.s === ".cap.on .cap-sub"), more = b.find((x) => x.s === "#e-more");
  check("escort: the facts line and MORE ↑ are separate rows", sub && more && sub.bottom <= more.top, JSON.stringify({ sub: sub && Math.round(sub.bottom), more: more && Math.round(more.top) }));
  check("escort: MORE ↑ is fully above Safari's bar", more && more.bottom <= VIEW);
  const ring = await page.evaluate(() => {
    const dot = document.querySelector(".esc-status .dot").getBoundingClientRect();
    const label = document.querySelector("#e-status-t").getBoundingClientRect();
    const st = getComputedStyle(document.querySelector(".esc-status .dot"), "::after");
    const w = parseFloat(st.width);
    // The ring's centre is the dot's centre (left/top 50%, translate -50%); its widest is w × 1.5.
    return { dotCx: dot.left + dot.width / 2, ringLeft: st.left, ringTop: st.top, ringMaxR: (w * 1.5) / 2, labelLeft: label.left };
  });
  check("escort: the ESCORTING ring is centred on the dot", ring.ringLeft === "3.5px" && ring.ringTop === "3.5px", JSON.stringify(ring));
  check("escort: the ring at its widest stays clear of the E", ring.dotCx + ring.ringMaxR <= ring.labelLeft - 2, JSON.stringify(ring));
  await shoot(page, "escort");
  check("escort: no page error", errors.length === 0, errors[0] || "");
  await context.close();
  // Close-up of the status line at 4x with the pulse running, caught at its widest.
  const live = await phone("/d/long#escort/straight", { motion: true, scale: 4 });
  await live.page.evaluate(() => { for (const a of document.getAnimations()) if (a.animationName === "pulse") { a.pause(); a.currentTime = 1100; } });
  await live.page.screenshot({ path: join(outDir, "iphone-escort-ring-closeup.png"), clip: { x: 16, y: 12, width: 150, height: 34 } });
  await live.context.close();
}

// ---------- 8. the calm new way, in place of "turn around" ----------
{
  const { context, page } = await phone("/d/long#escort/fromhere");
  await page.waitForTimeout(800);
  const t = ((await page.textContent(".cap.on")) || "").replace(/\s+/g, " ");
  check("wrong way kept going: \"Okay, new way from here.\" (not \"turn around\")", /Okay, new way from here\./.test(t) && !/turn around/i.test(t), t);
  await shoot(page, "escort-new-way-from-here");
  await context.close();
}

// ---------- 7. the MORE sheet's map: street context, pinch, pan ----------
{
  const { context, page, errors } = await phone("/d/long#escort/straight/more");
  await page.waitForSelector("#e-map canvas", { timeout: 10000 });
  await page.waitForTimeout(1500);
  const sheet = (await boxes(page, ["#e-sheet"]))[0];
  check("sheet: fully above Safari's bar", sheet && sheet.bottom <= VIEW + 0.5, JSON.stringify(sheet));
  await shoot(page, "more-map");
  const mapBox = (await boxes(page, ["#e-map"]))[0];
  const cx = (mapBox.left + mapBox.right) / 2, cy = (mapBox.top + mapBox.bottom) / 2;
  const recentreShown = () => page.evaluate(() => !document.getElementById("e-recentre").hidden);
  check("sheet map: follows the walk until touched (no RECENTRE yet)", !(await recentreShown()));
  const cdp = await context.newCDPSession(page);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  // Two fingers apart: a pinch out.
  const shotA = await page.screenshot({ clip: { x: mapBox.left, y: mapBox.top, width: mapBox.right - mapBox.left, height: mapBox.bottom - mapBox.top } });
  await touch("touchStart", [[cx - 20, cy], [cx + 20, cy]]);
  for (let k = 1; k <= 8; k++) { await touch("touchMove", [[cx - 20 - k * 8, cy], [cx + 20 + k * 8, cy]]); await page.waitForTimeout(30); }
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const shotB = await page.screenshot({ clip: { x: mapBox.left, y: mapBox.top, width: mapBox.right - mapBox.left, height: mapBox.bottom - mapBox.top } });
  check("sheet map: a two-finger pinch zooms it, and RECENTRE appears", !shotA.equals(shotB) && (await recentreShown()));
  // One finger: a pan, and the page itself does not scroll.
  const scrollBefore = await page.evaluate(() => [window.scrollY, document.getElementById("app").scrollTop]);
  await touch("touchStart", [[cx, cy]]);
  for (let k = 1; k <= 8; k++) { await touch("touchMove", [[cx, cy + k * 10]]); await page.waitForTimeout(30); }
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const shotC = await page.screenshot({ clip: { x: mapBox.left, y: mapBox.top, width: mapBox.right - mapBox.left, height: mapBox.bottom - mapBox.top } });
  const scrollAfter = await page.evaluate(() => [window.scrollY, document.getElementById("app").scrollTop]);
  check("sheet map: one finger pans it; the page does not scroll", !shotB.equals(shotC) && JSON.stringify(scrollBefore) === JSON.stringify(scrollAfter), JSON.stringify({ scrollBefore, scrollAfter }));
  const ta = await page.evaluate(() => getComputedStyle(document.querySelector("#e-map canvas")).touchAction);
  check("sheet map: its canvas takes the touches (touch-action none)", ta === "none", ta);
  await shoot(page, "more-map-zoomed");
  await page.click("#e-recentre");
  await page.waitForTimeout(300);
  check("sheet map: RECENTRE goes back to following", !(await recentreShown()));
  check("sheet map: no page error", errors.length === 0, errors[0] || "");
  await context.close();
}

await browser.close();
server.close();

// Each screen framed as the phone shows it: the status bar above, Safari's bottom bar below.
const py = `
import sys, json
from PIL import Image, ImageDraw
W, H, S, B, V = ${W}, ${H}, ${STATUS}, ${BAR}, ${VIEW}
for raw, out in json.loads(sys.argv[1]):
    page = Image.open(raw).convert("RGB")
    k = page.width / W
    frame = Image.new("RGB", (int(W * k), int(H * k)), page.getpixel((4, 4)))
    frame.paste(page, (0, int(S * k)))
    d = ImageDraw.Draw(frame)
    d.text((int(28 * k), int(18 * k)), "7:29", fill=(20, 20, 20))
    bar_top = int((S + V) * k)
    d.rectangle([0, bar_top, frame.width, frame.height], fill=(72, 72, 70))
    d.rounded_rectangle([int(14 * k), bar_top + int(12 * k), frame.width - int(14 * k), bar_top + int(60 * k)], radius=int(16 * k), fill=(110, 110, 106))
    d.text((int(150 * k), bar_top + int(30 * k)), "files.heyreason.com", fill=(240, 240, 240))
    d.rounded_rectangle([int(130 * k), frame.height - int(12 * k), int(260 * k), frame.height - int(8 * k)], radius=int(2 * k), fill=(240, 240, 240))
    frame.save(out)
`;
try {
  execFileSync("python3", ["-c", py, JSON.stringify(shots)], { stdio: "inherit" });
} catch (e) { console.log(`frames not drawn (${e.message.split("\n")[0]}); the raw screens are in ${outDir}`); }

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok · ${outDir}`);
process.exit(failed.length ? 1 : 0);
