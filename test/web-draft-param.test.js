// /web?draft=<text>&from=<where> (src/pages/webprefill.js), for the /updates "tear-off pad" on
// heyreason.com (owner handoff 10-31), driven in a real browser over real HTTP:
//
//   - signed in: the words land in the thread's composer, focused, cursor at the end — typed in, or
//     whole under reduced motion — and are NEVER sent; the address loses draft/from
//   - words already in the composer are kept: the draft goes under them on a new line
//   - plain text: markup stays text (never HTML), control characters out, 500 characters at most
//   - signed out: the draft survives the real sign-in (number → texted code → code) and lands in the thread
//   - logged: draft_prefilled {from} on arrival, draft_sent {from} when it is sent; never the words
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-draft-"));
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
delete process.env.REASON_AUTO_ADMIT;

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
let server, base, browserApp, h;
const turns = [], logs = [];

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
  server = createServer({ router, runtime, log: (e) => logs.push(e) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browserApp = await chromium.launch();
});
after(async () => {
  await browserApp?.close();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function open({ signedIn = true, reduced = true } = {}) {
  const ctx = await browserApp.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  if (signedIn) {
    const token = `tok-draft-${++n}-${Math.random().toString(36).slice(2)}`;
    db.startPageSession(`wsign:${KOFI_C}`, token, { conversationId: KOFI_C });
    await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
  }
  const page = await ctx.newPage();
  const errors = [], sends = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/web/send") sends.push(r.postData()); });
  return { ctx, page, errors, sends };
}
const userRows = () => db.messagesFor(KOFI_C).filter(r => r.role === "user");
const draftUrl = (text, from = "updates-events", extra = "") => `${base}/web?${extra}draft=${encodeURIComponent(text)}&from=${encodeURIComponent(from)}`;
const value = (page) => page.locator("#c-input").inputValue();

test("signed in: ?draft= lands in the thread's composer, focused, cursor at the end, URL cleaned; nothing is sent", async () => {
  const { ctx, page, errors, sends } = await open();
  try {
    const before = userRows().length;
    logs.length = 0;
    const words = "Remind me about the Ghana trip event on Friday";
    await page.goto(draftUrl(words));
    await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, words);
    assert.ok(await page.locator("ol.thread").count(), "a draft opens the thread, not the arrival");
    assert.equal(new URL(page.url()).search, "", "draft and from are gone from the address");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "c-input", "the composer has focus");
    assert.deepEqual(await page.evaluate(() => { const b = document.getElementById("c-input"); return [b.selectionStart, b.selectionEnd, b.value.length]; }), [words.length, words.length, words.length]);
    await page.waitForTimeout(800);
    assert.equal(userRows().length, before, "nothing was sent");
    assert.deepEqual(sends, [], "no /web/send");
    assert.equal(turns.length, 0, "Reason was never asked");
    const landed = logs.filter(e => "draft_prefilled" in e);
    assert.deepEqual(landed, [{ draft_prefilled: "updates-events", signed_in: true, chars: words.length }]);
    assert.ok(!JSON.stringify(logs).includes("Ghana"), "the words are never logged");
    // The person presses send: it goes once, as typed, and draft_sent says where it came from.
    await page.press("#c-input", "Enter");
    await page.locator(".msg.re .rsay", { hasText: `re: ${words}` }).waitFor();
    assert.equal(userRows().at(-1).text, words);
    assert.deepEqual(logs.filter(e => "draft_sent" in e), [{ draft_sent: "updates-events" }]);
    // A later ordinary message is not counted as a draft.
    await page.fill("#c-input", "and thanks");
    await page.press("#c-input", "Enter");
    await page.locator(".msg.re .rsay", { hasText: "re: and thanks" }).waitFor();
    assert.equal(logs.filter(e => "draft_sent" in e).length, 1);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("motion on: the words are typed in a couple of characters at a time; reduced motion puts them in whole", async () => {
  const words = "Call the venue and ask if they still have the 7pm table for four";
  {
    const { ctx, page, errors } = await open({ reduced: false });
    try {
      await page.addInitScript(() => { window.__seen = []; document.addEventListener("input", (e) => { if (e.target.id === "c-input") window.__seen.push(e.target.value.length); }, true); });
      await page.goto(draftUrl(words, "updates-calls", "thread&"));
      await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, words, { timeout: 8000 });
      const seen = await page.evaluate(() => window.__seen);
      assert.ok(seen.length >= Math.floor(words.length / 2) - 1, `typed in steps (${seen.length} steps)`);
      assert.ok(seen.every((v, i) => i === 0 || v - seen[i - 1] <= 2), "two characters a step at most");
      assert.equal(new URL(page.url()).search, "?thread", "only draft/from are taken off the address");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "c-input");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
  {
    const { ctx, page } = await open({ reduced: true });
    try {
      await page.addInitScript(() => { window.__seen = []; document.addEventListener("input", (e) => { if (e.target.id === "c-input") window.__seen.push(e.target.value.length); }, true); });
      await page.goto(draftUrl(words, "updates-calls"));
      await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, words);
      assert.deepEqual(await page.evaluate(() => window.__seen), [words.length], "one step, whole");
    } finally { await ctx.close(); }
  }
});

test("words already in the composer are kept: the draft goes under them on a new line", async () => {
  const { ctx, page, errors, sends } = await open();
  try {
    // The composer already holds unsent words when the page's own scripts run (a restored form, typing during load).
    await page.route(/\/web\?/, async (route) => {
      const res = await route.fetch();
      const html = await res.text();
      const at = html.lastIndexOf("<script>");
      const body = `${html.slice(0, at)}<script>document.getElementById('c-input').value='book the dentist  ';</script>${html.slice(at)}`;
      await route.fulfill({ response: res, body });
    });
    await page.goto(draftUrl("ask Ama about Saturday"));
    await page.waitForFunction(() => document.getElementById("c-input")?.value.includes("Ama"));
    assert.equal(await value(page), "book the dentist\nask Ama about Saturday");
    assert.deepEqual(sends, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("plain text: markup stays words, control characters go, 500 characters at most", async () => {
  const { ctx, page, errors, sends } = await open();
  try {
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; d.dismiss(); });
    const nasty = `<img src=x onerror=alert(1)>\u0000hi\u0007 there\u202E\r\nline two\t!`;
    await page.goto(draftUrl(nasty, "<script>"));
    await page.waitForFunction(() => document.getElementById("c-input")?.value.length > 0);
    assert.equal(await value(page), "<img src=x onerror=alert(1)>hi there\nline two !");
    assert.equal(await page.locator("img[src=x]").count(), 0, "never drawn as HTML");
    assert.equal(dialogs, 0);
    // An unsafe `from` is not kept: logged as none.
    assert.equal(logs.filter(e => "draft_prefilled" in e).at(-1).draft_prefilled, "none");
    // The cap.
    await page.goto(draftUrl("x".repeat(2000)));
    await page.waitForFunction(() => document.getElementById("c-input")?.value.length > 0);
    assert.equal((await value(page)).length, 500);
    assert.deepEqual(sends, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("signed out: the draft survives the real sign-in (number, texted code, code) and lands in the thread's composer", async () => {
  const { ctx, page, errors, sends } = await open({ signedIn: false });
  try {
    logs.length = 0;
    const words = "Find me a table for two near Union Square tonight";
    await page.goto(draftUrl(words, "updates-events"));
    assert.equal(new URL(page.url()).search, "", "the address is cleaned on the sign-in page too");
    assert.equal(await page.locator('form[action="/web/signin"] input[name="next"]').getAttribute("value"), "thread");
    assert.deepEqual(logs.filter(e => "draft_prefilled" in e), [{ draft_prefilled: "updates-events", signed_in: false, chars: words.length }]);
    const sent = h.fake.sent.length;
    await page.fill("#number", KOFI);
    await page.locator('form[action="/web/signin"] button, form[action="/web/signin"] [type=submit]').first().click();
    await page.locator("#code").waitFor();
    const until = Date.now() + 3000;
    while (h.fake.sent.length === sent && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    const code = /\b(\d{6})\b/.exec(h.fake.sent.at(-1).text)?.[1];
    assert.ok(code, "a code was texted");
    assert.equal(await page.locator('form[action="/web/code"] input[name="next"]').getAttribute("value"), "thread");
    await page.fill("#code", code); // six digits submit the code by themselves
    await page.waitForURL(/\/web\?thread$/);
    await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, words);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("reason-web-draft")), null, "taken once");
    assert.deepEqual(sends, [], "never sent");
    // Reloading does not put it in again.
    await page.reload();
    await page.locator("#c-input").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await value(page), "");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("a draft wiped out and replaced is not counted as sent from the link; an encoded parameter name is cleaned too", async () => {
  const { ctx, page, errors } = await open();
  try {
    await page.goto(`${base}/web?dr%61ft=${encodeURIComponent("try this")}&from=updates-calls`);
    await page.waitForFunction(() => document.getElementById("c-input")?.value === "try this");
    assert.equal(new URL(page.url()).search, "");
    const before = logs.filter(e => "draft_sent" in e).length;
    await page.fill("#c-input", "");
    await page.fill("#c-input", "something else entirely");
    await page.press("#c-input", "Enter");
    await page.locator(".msg.re .rsay", { hasText: "re: something else entirely" }).waitFor();
    assert.equal(logs.filter(e => "draft_sent" in e).length, before);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
