// Reason Web v2, the composer's + and mic wired to the designed flows, driven in a real browser over
// real HTTP (Chromium from node_modules, a fake microphone, a stand-in for the browser's speech
// recognition). Every state the references draw, end to end:
//
//   sheet-uploads 3A  + opens a sheet: Photo or video · Take a photo · A file or PDF · NEVER MIND
//                 3B  slips READY / UPLOADING… (faded, no bars)
//                 3C  a failed slip: the Caveat "the lease didn’t upload. tap to try again." + the typed
//                     limits; send still goes and leaves it out; tapping retries
//                 3D  sent: the file slip TAP TO OPEN; "on it." says what Reason is doing (reading the lease…)
//                 3E  dragging in: the whole page, "let go. i’ll read it."
//   sheet-voice   4A  Listening · 4B PAUSED, SENDING IN 3… 2…, KEEP TALKING / Edit it first / Send now →
//                 4C  Edit it first: the words in the box, FROM YOUR VOICE · EDIT ANYTHING; sent as a voice note
//                 4D  YOU · VOICE · WEB, Caveat, ▶ and the length
//                 4E  the mic blocked: "I can’t hear you yet.", Try again →, "or just type it."
//   loading       L9  "writing it down…" with ruled lines, while the words are being written
// Nothing here texts anybody: the person is on Web and the fake channel's outbox is checked empty.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-uploads-voice-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_WEB = "on";
process.env.REASON_WEB_STREAM = "off";
delete process.env.REASON_PAGES_URL;
delete process.env.REASON_SITE_URL;
delete process.env.REASON_PUBLIC_URL;
delete process.env.GEMINI_API_KEY;

const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { chromium } = await import("playwright");

const KOFI = "+14155559876", KOFI_C = `dm:fake:${KOFI}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let server, base, browserApp, h;
const turns = [];
const gate = { p: Promise.resolve(), open() {} };
function hold() { gate.p = new Promise(r => { gate.open = r; }); }

// The browser's speech recognition, stood in for: the page drives it exactly as it would the real one.
const FAKE_SR = `(() => {
  window.__sr = []; window.__srDelay = 0;
  class FakeSR { constructor() { window.__sr.push(this); } start() { this.on = true; } stop() { this.on = false; setTimeout(() => this.onend && this.onend(), window.__srDelay); } abort() {} }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  window.__say = (fin, int) => { const s = window.__sr[window.__sr.length - 1]; const results = [];
    if (fin) results.push(Object.assign([{ transcript: fin }], { isFinal: true }));
    if (int) results.push(Object.assign([{ transcript: int }], { isFinal: false }));
    s.onresult({ resultIndex: 0, results }); };
})();`;
const NO_SR = `delete window.SpeechRecognition; delete window.webkitSpeechRecognition; window.webkitSpeechRecognition = undefined;`;

before(async () => {
  config.web = true;
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
  db.markWebNoticeSeen(KOFI_C);
  const router = new Router({ log: () => {} });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
  const runtime = new Runtime({ log: () => {}, channels: router, deliver, runTurn: async (args) => { turns.push(args); if (/slow/.test(args.text)) await gate.p; return `re: ${args.text}`; } });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: "+16562167455" }));
  router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  h = { router, runtime, fake };
  server = createServer({ router, runtime });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browserApp = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
});
after(async () => {
  await browserApp?.close();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function open({ width = 1280, height = 900, sr = true, mobile = false } = {}) {
  const token = `tok-browser-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${KOFI_C}`, token, { conversationId: KOFI_C });
  const ctx = await browserApp.newContext({ viewport: { width, height }, permissions: ["microphone"], reducedMotion: "reduce", isMobile: mobile, hasTouch: mobile });
  await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  await ctx.addInitScript(sr ? FAKE_SR : NO_SR);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/web?thread`);
  return { ctx, page, errors };
}
const userRows = () => db.messagesFor(KOFI_C).filter(r => r.role === "user");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n");

async function holdMic(page) {
  const box = await page.locator(".c-mic").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
  await page.locator(".listen").waitFor({ state: "visible" });
  await page.waitForFunction(() => window.__sr && window.__sr.length > 0 && window.__sr.at(-1).on);
}

test("3A: + opens the sheet of three, each opens its own picker; NEVER MIND, Escape and a tap outside close it", async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844, mobile: true });
  try {
    const add = page.locator(".c-add");
    await add.waitFor({ state: "visible" });
    await add.click();
    const sheet = page.locator('.addsheet[role="dialog"]');
    await sheet.waitFor({ state: "visible" });
    assert.equal(await add.getAttribute("aria-expanded"), "true");
    assert.deepEqual(await sheet.locator("button").allTextContents(), ["Photo or video", "Take a photo", "A file or PDF", "NEVER MIND"]);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Photo or video", "focus goes into the sheet");
    const sb = await sheet.boundingBox();
    assert.equal(Math.round(sb.x), 0); assert.equal(Math.round(sb.width), 390); assert.ok(Math.abs(sb.y + sb.height - 844) < 2, "a bottom sheet, edge to edge");
    await page.locator(".as-never").click();
    for (const [label, accept] of [["Photo or video", "image/*,video/*"], ["Take a photo", "image/*"], ["A file or PDF", /application\/pdf.*\.docx/]]) {
      await add.click();
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator(".as-pick", { hasText: label }).click()]);
      const acc = await chooser.element().getAttribute("accept");
      if (typeof accept === "string") assert.equal(acc, accept); else assert.match(acc, accept);
      if (label === "Take a photo") assert.equal(await chooser.element().getAttribute("capture"), "environment");
      assert.ok(await sheet.isHidden(), "picking closes the sheet");
    }
    await add.click(); await page.locator(".as-never").click(); assert.ok(await sheet.isHidden());
    await add.click(); await page.keyboard.press("Escape"); assert.ok(await sheet.isHidden());
    assert.equal(await page.evaluate(() => document.activeElement.className), "ic c-add", "focus back on +");
    await add.click(); await page.mouse.click(200, 200); assert.ok(await sheet.isHidden());
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("3B + 3C + 3D: UPLOADING… then READY; a failed slip with the Caveat + limits; send leaves it out; TAP TO OPEN; 'reading the lease…' while Reason reads it", async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844, mobile: true });
  try {
    await page.locator(".c-add").waitFor({ state: "visible" });
    // Hold the PDF's upload so UPLOADING… can be seen; fail the listing's first try.
    let release, firstListing = true;
    const held = new Promise(r => { release = r; });
    await page.route("**/web/upload", async (route) => {
      const name = decodeURIComponent(route.request().headers()["x-reason-name"] || "");
      if (name === "lease.pdf") { await held; return route.continue(); }
      if (name === "listing.png" && firstListing) { firstListing = false; return route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false,"error":"failed"}' }); }
      return route.continue();
    });
    await page.setInputFiles('.c-file[data-pick="file"]', { name: "lease.pdf", mimeType: "application/pdf", buffer: PDF });
    const lease = page.locator(".on-line li", { hasText: "LEASE.PDF" });
    await lease.locator(".st2", { hasText: "UPLOADING…" }).waitFor();
    assert.equal(await lease.getAttribute("data-state"), "up");
    assert.equal(await lease.evaluate(e => getComputedStyle(e).opacity), "0.55", "faded");
    assert.equal(await page.locator("progress, [role=progressbar]").count(), 0, "no progress bars");
    await page.setInputFiles('.c-file[data-pick="media"]', { name: "listing.png", mimeType: "image/png", buffer: PNG });
    // 3C: the listing failed.
    const retry = page.locator(".uf-retry", { hasText: "the listing didn’t upload. tap to try again." });
    await retry.waitFor();
    assert.equal(await retry.evaluate(e => e.tagName), "BUTTON");
    assert.equal(await page.locator(".uf-lim").textContent(), "PHOTOS, PDFS, DOCS · UP TO 20 MB EACH");
    const failed = page.locator(".on-line li", { hasText: "LISTING.PNG" });
    assert.equal(await failed.getAttribute("data-state"), "failed");
    assert.equal(await failed.locator(".st2").count(), 0, "a failed slip has no status line");
    // Tap to try again: it goes this time.
    await retry.click();
    await failed.locator(".st2", { hasText: "READY" }).waitFor();
    assert.ok(await page.locator(".upfail").isHidden());
    release();
    await lease.locator(".st2", { hasText: "READY" }).waitFor();
    // A third that fails for good, then send: the failed one is left out, the rest go.
    await page.unroute("**/web/upload");
    await page.route("**/web/upload", (route) => (decodeURIComponent(route.request().headers()["x-reason-name"] || "") === "floorplan.png" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false}' }) : route.continue()));
    await page.setInputFiles('.c-file[data-pick="media"]', { name: "floorplan.png", mimeType: "image/png", buffer: PNG });
    await page.locator(".uf-retry", { hasText: "the floorplan didn’t upload. tap to try again." }).waitFor();
    assert.ok(await page.locator(".cform .send").isVisible(), "send stays available");
    hold();
    await page.fill("#c-input", "slow: is this the same place?");
    await page.press("#c-input", "Enter");
    const mine = page.locator(".msg.you[data-cid]").last();
    await mine.locator("a.slip.fslip", { hasText: "LEASE.PDF" }).waitFor();
    assert.match(await mine.locator("a.slip.fslip .fs").textContent(), /^PDF · .* · OPEN$/);
    assert.match(await mine.locator("a.slip.fslip").getAttribute("href"), /^\/web\/media\/u\/[A-Za-z0-9_-]{22}\/lease\.pdf$/);
    assert.equal(await mine.locator('img[alt="Photo you sent"]').count(), 1);
    const last = userRows().at(-1);
    assert.deepEqual(last.media.map(m => m.filename).sort(), ["lease.pdf", "listing.png"], "the failed floorplan was left out");
    assert.ok(await page.locator(".upl").isHidden(), "the line is clear again");
    // 3D: "on it." says what it's doing, from the server's record of the turn.
    await page.locator(".onit .hand", { hasText: "reading the lease…" }).waitFor({ timeout: 8000 });
    assert.equal(await page.locator(".onit").getAttribute("role"), "status");
    gate.open();
    await page.locator(".msg.re .rsay", { hasText: "re: slow: is this the same place?" }).waitFor();
    await page.locator(".onit").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".onit .hand").textContent(), "on it.", "back to plain words for the next one");
    assert.equal(h.fake.sent.length, 0, "nothing texted");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("3E: dragging a file in covers the page, 'let go. i’ll read it.', ON DESKTOP, DROP ANYWHERE", async () => {
  const { ctx, page, errors } = await open();
  try {
    await page.locator(".c-add").waitFor({ state: "visible" });
    await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "a.png", { type: "image/png" })); document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); });
    const drop = page.locator(".cdrop");
    await drop.waitFor({ state: "visible" });
    const b = await drop.boundingBox();
    assert.deepEqual([b.x, b.y, b.width, b.height].map(Math.round), [12, 12, 1280 - 24, 900 - 24], "inset 12px, the whole page");
    assert.equal((await drop.locator(".hand").textContent()).trim(), "let go. i’ll read it.");
    assert.equal(await drop.locator(".lbl").textContent(), "ON DESKTOP, DROP ANYWHERE");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("4A → 4B → KEEP TALKING → 4B → Edit it first → 4C → sent as a voice note (4D); and 4B's countdown sends by itself", async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844, mobile: true });
  try {
    await page.locator(".c-mic").waitFor({ state: "visible" });
    await holdMic(page);
    assert.equal(await page.locator(".ls-hint").innerText(), "PAUSE AND IT SENDS", "the phone's hint");
    await page.evaluate(() => window.__say("actually, if the Hudson one is open, just hold it for me.", ""));
    // 4B after a pause.
    await page.locator('.listen[data-mode="paused"]').waitFor({ timeout: 6000 });
    assert.ok(await page.locator(".ls-paused").isVisible());
    assert.ok(await page.locator(".ls-on").isHidden());
    assert.match(await page.locator(".ls-cn").textContent(), /^SENDING IN [23]…$/);
    await page.locator(".ls-cn", { hasText: "SENDING IN 2…" }).waitFor();
    assert.deepEqual(await page.locator(".ls-dots i").evaluateAll(is => is.map(i => i.className)), ["", "", "off"], "two dots left of three");
    assert.deepEqual(await page.locator(".ls-pacts button").allInnerTexts(), ["KEEP TALKING", "Edit it first", "Send now →"]);
    // KEEP TALKING: listening again, the words kept, nothing sent.
    const before = userRows().length;
    await page.locator(".ls-keep").click();
    await page.locator('.listen[data-mode="listening"]').waitFor();
    await page.waitForFunction(() => window.__sr.at(-1).on);
    await page.waitForTimeout(3500);
    assert.equal(userRows().length, before, "the countdown stopped");
    await page.evaluate(() => window.__say("and see if they take dogs.", ""));
    await page.locator('.listen[data-mode="paused"]').waitFor({ timeout: 6000 });
    assert.equal((await page.locator(".ls-words").innerText()).trim(), "actually, if the Hudson one is open, just hold it for me. and see if they take dogs.");
    // Edit it first (4C).
    await page.locator(".ls-edit").click();
    await page.locator(".listen").waitFor({ state: "hidden" });
    await page.locator(".fromvoice").waitFor({ state: "visible" });
    assert.equal(await page.locator(".fromvoice").textContent(), "FROM YOUR VOICE · EDIT ANYTHING");
    assert.equal(await page.inputValue("#c-input"), "actually, if the Hudson one is open, just hold it for me. and see if they take dogs.");
    assert.ok((await page.locator("#c-input").boundingBox()).height > 50, "the words wrap in the box");
    await page.waitForTimeout(3500);
    assert.equal(userRows().length, before, "editing never sends by itself");
    await page.fill("#c-input", "if the Hudson one is open, hold it. and ask about dogs.");
    await page.press("#c-input", "Enter");
    const row = page.locator(".msg.you[data-cid]").last();
    await row.locator(".said.hand", { hasText: "if the Hudson one is open, hold it. and ask about dogs." }).waitFor({ timeout: 8000 });
    assert.match(await row.locator(".lbl").first().textContent(), /^YOU · VOICE · WEB · /);
    assert.match(await row.locator(".vplay").getAttribute("aria-label"), /^Play voice note, \d+ seconds?$/);
    assert.match(await row.locator(".achip .vt").textContent(), /^0:\d\d$/);
    assert.ok(await page.locator(".fromvoice").isHidden(), "the label goes with the send");
    const last = userRows().at(-1);
    assert.equal(last.text, "if the Hudson one is open, hold it. and ask about dogs.");
    assert.equal(last.media[0].kind, "voice");
    // The countdown on its own: 4B, then sent.
    await holdMic(page);
    await page.evaluate(() => window.__say("table for four at eight", ""));
    await page.locator('.listen[data-mode="paused"]').waitFor({ timeout: 6000 });
    await page.locator(".listen").waitFor({ state: "hidden", timeout: 6000 });
    await page.locator(".msg.you[data-cid] .said.hand", { hasText: "table for four at eight" }).waitFor({ timeout: 8000 });
    // Send now →: no waiting.
    await holdMic(page);
    await page.evaluate(() => window.__say("and a high chair", ""));
    await page.locator('.listen[data-mode="paused"]').waitFor({ timeout: 6000 });
    await page.locator(".ls-now").click();
    await page.locator(".msg.you[data-cid] .said.hand", { hasText: "and a high chair" }).waitFor({ timeout: 8000 });
    assert.equal(h.fake.sent.length, 0, "nothing texted");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("L9: 'writing it down…' with ruled lines while the last words are written, then it sends", async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844, mobile: true });
  try {
    await page.locator(".c-mic").waitFor({ state: "visible" });
    await holdMic(page);
    await page.evaluate(() => { window.__srDelay = 900; window.__say("book the", "four o'clock"); });
    await page.locator(".ls-send").click();
    await page.locator('.listen[data-mode="writing"]').waitFor();
    assert.equal(await page.locator(".ls-writing").textContent(), "writing it down…");
    assert.equal(await page.locator(".ls-writing").getAttribute("role"), "status");
    assert.equal(await page.locator(".ls-ruled span").count(), 3);
    assert.ok(await page.locator(".ls-wring").isVisible());
    assert.ok(await page.locator(".ls-words").isHidden(), "the words aren't shown until they're written");
    await page.locator(".msg.you[data-cid] .said.hand", { hasText: "book the four o'clock" }).waitFor({ timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("4E: the mic blocked — 'I can’t hear you yet.', Try again →, 'or just type it.'; typing takes it away", async () => {
  // A browser that says no to the microphone, as one does when it hasn't been allowed.
  const denied = await chromium.launch();
  const token = `tok-denied-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${KOFI_C}`, token, { conversationId: KOFI_C });
  const ctx = await denied.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  await ctx.addInitScript(FAKE_SR + `;navigator.mediaDevices.getUserMedia = () => { window.__asked = (window.__asked || 0) + 1; return Promise.reject(new DOMException("Permission denied", "NotAllowedError")); };`);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(`${base}/web?thread`);
    await page.locator(".c-mic").waitFor({ state: "visible" });
    await page.locator(".c-mic").click();
    const off = page.locator(".micoff");
    await off.waitFor({ state: "visible" });
    assert.equal(await off.locator("h2").textContent(), "I can’t hear you yet.");
    assert.equal(await off.locator(".mo-p").textContent(), "Your browser hasn’t allowed the microphone. Allow it next to the address bar, then try again.");
    assert.equal(await off.locator(".mo-or").textContent(), "or just type it. that works too.");
    assert.equal(await page.evaluate(() => document.activeElement.id), "mo-h", "focus moves to what happened");
    assert.ok(await page.locator(".thread").isHidden(), "the screen is the message");
    assert.ok(await page.locator("#c-input").isVisible(), "the line stays live");
    await off.locator(".mo-try").click();
    await off.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.__asked), 2, "Try again really asks again");
    await page.locator("#c-input").focus();
    await off.waitFor({ state: "hidden" });
    assert.ok(await page.locator(".thread").isVisible());
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await denied.close(); }
});
