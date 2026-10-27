// Reason Web's composer, driven in a real browser over real HTTP (Chromium from node_modules, a fake
// microphone, and a stand-in for the browser's speech recognition, which needs Google's servers).
// The page's own script, end to end, for every state the references draw:
//
//   composer 02  a photo picked with + sits on the line as a slip; send shows; it goes with words
//   composer 04  dragging a file over the page shows "let go. i'll read it."; dropping puts it on the line
//   errors       a file Reason can't read is one Caveat line, nothing sent
//   composer 03  a tap on the mic dictates on the line (pen rule, clock); send makes a voice note
//   board D      holding the mic opens Listening: words in Caveat, not-final ones muted; pausing sends;
//                NEVER MIND sends nothing
//   5A           SENDING… → SENT · time; a send that didn't go offers "tap to try again", which never sends twice
//   9C           offline: the line, WAITING TO SEND, and it goes by itself when the line is back
//   mic hidden   a browser that can neither hear nor be heard on the server never shows the mic
//   9E           at 320px nothing runs off the side; a long code wraps
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-compose-browser-"));
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

// The browser's speech recognition, stood in for: the page drives it exactly as it would the real one.
const FAKE_SR = `(() => {
  window.__sr = [];
  class FakeSR { constructor() { window.__sr.push(this); } start() { this.on = true; } stop() { this.on = false; setTimeout(() => this.onend && this.onend(), 0); } abort() {} }
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
  const runtime = new Runtime({ log: () => {}, channels: router, deliver, runTurn: async (args) => { turns.push(args); return `re: ${args.text}`; } });
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

test("composer 02 + 04: + puts a slip on the line, a drop anywhere does too, and the photo goes with the words", async () => {
  const { ctx, page, errors } = await open();
  try {
    await page.locator(".c-add").waitFor({ state: "visible" });
    assert.equal(await page.locator(".c-add").getAttribute("aria-label"), "Add a photo or file");
    await page.setInputFiles('.c-file[data-pick="media"]', { name: "listing.png", mimeType: "image/png", buffer: PNG });
    await page.locator(".on-line li:not([data-busy]) .nm", { hasText: "LISTING.PNG" }).waitFor();
    assert.ok(await page.locator(".cform .send").isVisible(), "send shows once something is attached");
    // 04: drag over the page.
    await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "a.png", { type: "image/png" })); document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); });
    await page.locator(".cdrop").waitFor({ state: "visible" });
    assert.equal((await page.locator(".cdrop .hand").textContent()).trim(), "let go. i’ll read it.");
    await page.evaluate((b64) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], "second.png", { type: "image/png" })); document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); }, PNG.toString("base64"));
    await page.locator(".on-line li:not([data-busy]) .nm", { hasText: "SECOND.PNG" }).waitFor();
    assert.ok(!(await page.locator(".cdrop").isVisible()), "the outline goes once dropped");
    // Remove one; send the other with words.
    await page.locator('.on-line .rm[aria-label="Remove second.png"]').click();
    await page.fill("#c-input", "Is this the same place?");
    await page.press("#c-input", "Enter");
    await page.locator('.msg.you[data-cid] img[alt="Photo you sent"]').waitFor();
    await page.locator(".msg.re .rsay", { hasText: "re: Is this the same place?" }).waitFor();
    const last = userRows().at(-1);
    assert.equal(last.text, "Is this the same place?");
    assert.equal(JSON.parse(JSON.stringify(last.media)).length, 1);
    assert.equal(turns.at(-1).attachments[0].kind, "image");
    assert.ok(await page.locator(".on-line").isHidden(), "the line is clear again");
    // A file Reason can't read: the slip stays, failed, with the Caveat line and the limits (3C); nothing sent.
    const before = userRows().length;
    await page.setInputFiles('.c-file[data-pick="file"]', { name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]) });
    // Refused for what it is (415): no "tap to try again", since trying again can't help.
    await page.locator("p.uf-retry", { hasText: /^the setup didn’t upload\.$/ }).waitFor();
    assert.equal(await page.locator(".uf-lim").textContent(), "PHOTOS, PDFS, DOCS · UP TO 20 MB EACH");
    assert.equal(userRows().length, before);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("composer 03: a tap on the mic dictates on the line; send makes a voice note row (YOU · VOICE · WEB, Caveat, ▶)", async () => {
  const { ctx, page, errors } = await open();
  try {
    const mic = page.locator(".c-mic");
    await mic.waitFor({ state: "visible" });
    assert.equal(await mic.getAttribute("aria-label"), "Speak instead");
    await mic.click();
    await page.locator(".dict").waitFor({ state: "visible" });
    assert.ok(await page.locator(".cform").isHidden(), "the line becomes the recording");
    await page.waitForFunction(() => window.__sr.length > 0 && window.__sr.at(-1).on);
    await page.waitForTimeout(1200);
    assert.notEqual(await page.locator(".d-clock").textContent(), "0:00", "the clock runs");
    await page.evaluate(() => window.__say("also see if they take dogs", ""));
    await page.locator('.d-send[aria-label="Stop and send"]').click();
    await page.locator(".msg.you[data-cid] .said.hand", { hasText: "also see if they take dogs" }).waitFor({ timeout: 8000 });
    const row = page.locator(".msg.you[data-cid]").last();
    assert.match(await row.locator(".lbl").first().textContent(), /^YOU · VOICE · WEB · /);
    assert.match(await row.locator(".vplay").getAttribute("aria-label"), /^Play voice note, \d+ seconds?$/);
    const last = userRows().at(-1);
    assert.equal(last.text, "also see if they take dogs");
    assert.equal(last.media[0].kind, "voice");
    assert.equal(turns.at(-1).text, "also see if they take dogs");
    assert.equal(h.fake.sent.length, 0, "nothing texted");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("board D: holding the mic opens Listening; words in Caveat, not-final ones muted; pausing sends; NEVER MIND sends nothing", async () => {
  const { ctx, page, errors } = await open();
  try {
    const mic = page.locator(".c-mic");
    await mic.waitFor({ state: "visible" });
    const box = await mic.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    await page.locator(".listen").waitFor({ state: "visible" });
    assert.match(await page.locator(".ls-on").textContent(), /^LISTENING · \d:\d\d$/);
    await page.waitForFunction(() => window.__sr.length > 0 && window.__sr.at(-1).on);
    await page.evaluate(() => window.__say("actually, if the Hudson one is open, just hold it for me.", "and see if they"));
    assert.equal(await page.locator(".ls-fin").textContent(), "actually, if the Hudson one is open, just hold it for me.");
    assert.equal(await page.locator(".ls-int").textContent(), "and see if they");
    assert.equal(await page.locator(".ls-int").evaluate(e => getComputedStyle(e).color), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim()).then(hex => { const v = parseInt(hex.slice(1), 16); return `rgb(${v >> 16}, ${(v >> 8) & 255}, ${v & 255})`; }));
    // NEVER MIND.
    const before = userRows().length;
    await page.locator(".ls-never").click();
    await page.locator(".listen").waitFor({ state: "hidden" });
    await page.waitForTimeout(400);
    assert.equal(userRows().length, before, "nothing was sent");
    // Space keeps it open (focus starts on Send it, and Space must not press it).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    await page.locator(".listen").waitFor({ state: "visible" });
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".listen").isVisible(), "Space did not send");
    assert.equal(userRows().length, before);
    await page.locator(".ls-never").click();
    await page.locator(".listen").waitFor({ state: "hidden" });
    // Again, and this time pause: it sends by itself.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    await page.locator(".listen").waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__sr.at(-1).on);
    await page.evaluate(() => window.__say("hold it for me", ""));
    // 4B: paused, about to send by itself.
    await page.locator('.listen[data-mode="paused"]').waitFor({ timeout: 6000 });
    await page.locator(".listen").waitFor({ state: "hidden", timeout: 8000 });
    await page.locator(".msg.you[data-cid] .said.hand", { hasText: "hold it for me" }).waitFor({ timeout: 8000 });
    assert.equal(userRows().at(-1).text, "hold it for me");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("5A + 9C: SENDING… then SENT · time; offline is WAITING TO SEND and goes when back; a failed send retries once, never twice", async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844, mobile: true });
  try {
    await page.fill("#c-input", "Can you move dinner to 8?");
    await page.press("#c-input", "Enter");
    await page.locator(".msg.you[data-cid] .st", { hasText: /^SENT · \d{1,2}:\d\d [AP]M$/ }).waitFor();
    // Offline.
    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.locator(".netline", { hasText: "you're offline. i'll send it when you're back." }).waitFor();
    await page.fill("#c-input", "Remind me to call the vet at 4.");
    await page.press("#c-input", "Enter");
    await page.locator(".msg[data-state=waiting] .st", { hasText: "WAITING TO SEND" }).waitFor();
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.locator(".msg.you[data-cid] .said", { hasText: "Remind me to call the vet at 4." }).waitFor();
    assert.ok(await page.locator(".netline").isHidden(), "the line goes away by itself");
    // Didn't go.
    let fails = 1;
    await page.route("**/web/send", (route) => (fails-- > 0 ? route.fulfill({ status: 400, contentType: "application/json", body: '{"ok":false,"error":"x"}' }) : route.continue()));
    await page.fill("#c-input", "Oh and a window table if they can.");
    await page.press("#c-input", "Enter");
    const retry = page.locator(".retry", { hasText: "didn't go. tap to try again." });
    await retry.waitFor();
    assert.ok(await page.locator(".st", { hasText: "IT WON'T SEND TWICE" }).isVisible());
    await retry.click();
    await page.locator(".msg.you[data-cid] .said", { hasText: "Oh and a window table if they can." }).waitFor();
    await retry.click({ trial: true, timeout: 300 }).catch(() => {});
    assert.equal(userRows().filter(r => r.text === "Oh and a window table if they can.").length, 1, "one message, once");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("no speech recognition and no server listening: the mic is never shown; at 320px nothing runs off the side", async () => {
  const { ctx, page, errors } = await open({ width: 320, height: 700, sr: false, mobile: true });
  try {
    await page.locator(".c-add").waitFor({ state: "visible" });
    assert.ok(await page.locator(".c-mic").isHidden(), "Firefox-like, with no GEMINI_API_KEY: no mic");
    db.writeMessage({ conversationId: KOFI_C, role: "assistant", channel: "web", text: "Booked under Alexandria-Josephine Okonkwo-Whitfield, confirmation HDSN-2026-11-14-0042-XXXXXXXXXXXXXXXXXXXX." });
    await page.reload();
    await page.locator(".rsay", { hasText: "HDSN-2026" }).waitFor();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `no sideways scroll (${over}px over)`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
