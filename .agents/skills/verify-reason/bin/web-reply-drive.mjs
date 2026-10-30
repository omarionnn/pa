#!/usr/bin/env node
// Drive Reason Web's reply-to-one-message (REASON_WEB_REPLY, src/pages/webreply.js) end to end over REAL
// HTTP, then in a real Chromium against the same server. Harness copied from web-convo-drive.mjs: the
// real Router, Runtime, outbox, WebChannel and a FakeChannel for the phone line, a scripted model.
//
// Below: the original header of web-convo-drive.mjs, which this shares.
// Drive Reason Web's conversation (W2) end to end over REAL HTTP: src/http.js createServer on a
// loopback port, the real Router, Runtime, outbox, WebChannel and a FakeChannel for the phone line,
// a scripted model (no model is called). Every request is one a browser makes — the page, the
// stream (read as a real text/event-stream), /web/send, /web/history — and every text is one a phone
// would receive, captured by the fake. Run under the cage's env so it gets its own database and
// every texting credential blanked:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/web.db node .agents/skills/verify-reason/bin/web-reply-drive.mjs [shotsDir]
//
// Prints one line per step, `ok` or `FAIL`, and exits non-zero on any FAIL. Signing in is W1's drive
// (bin/web-drive.mjs); here a browser starts already signed in (a page_sessions row, as the code step leaves it).
process.env.REASON_WEB = "on";
process.env.REASON_WEB_REPLY = process.env.REASON_WEB_REPLY || "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_SITE_PROXY_SECRET;
delete process.env.REASON_AUTO_ADMIT;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/web.db");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { WebChannel } = await imp("src/channels/web.js");
const { makeDeliver, WEB_HINT } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const db = await imp("src/db.js");

const KOFI = "+14155559876", AMA = "+13475550000", LINE = "+16562167455";
const KOFI_C = `dm:fake:${KOFI}`, AMA_C = `dm:fake:${AMA}`;
for (const [c, a, n] of [[KOFI_C, KOFI, "Kofi"], [AMA_C, AMA, "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");

// The model: answers at once, except a message with "slow" in it, which waits to be let go.
let release = null;
const gate = new Promise(r => { release = r; });
const turns = [];
const router = new Router({});
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ channels: router, deliver, runTurn: async ({ text }) => { turns.push(text); if (/slow/.test(text)) await gate; return `re: ${String(text).split("\n").at(-1).replace(/^.*?: /, "")}`; } });
router.runtime = runtime;
router.register(consoleChannel);
const phone = router.register(new FakeChannel({ number: LINE }));
const web = router.register(new WebChannel());
runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
  await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
});
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!(await pred()) && Date.now() < end) await new Promise(r => setTimeout(r, 15)); return pred(); };
const signIn = (conv) => { const t = `drive-${conv.length}-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${conv}`, t, { conversationId: conv }); return { cookie: `reason_page=${t}`, token: t }; };
const H = (b, extra = {}) => ({ cookie: b.cookie, origin: BASE, "sec-fetch-site": "same-origin", ...extra });
const page = async (b, q = "") => { const r = await fetch(`${BASE}/web${q}`, { headers: H(b) }); return { status: r.status, body: await r.text(), headers: r.headers }; };
const csrfOf = (body) => /name="c" value="([^"]+)"/.exec(body)?.[1];
const post = async (b, csrf, id, text, extra = {}) => {
  const r = await fetch(`${BASE}/web/send`, { method: "POST", headers: H(b, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": csrf, ...extra }), body: new URLSearchParams({ id, text, c: csrf }) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const hist = async (b, q) => (await (await fetch(`${BASE}/web/history?${q}`, { headers: H(b, { accept: "application/json" }) })).json());
/** A real EventSource-shaped reader over fetch: collects `event:` blocks until closed. */
function listen(b, after = 0) {
  const ctl = new AbortController(), events = [];
  const done = fetch(`${BASE}/web/stream?after=${after}`, { headers: H(b, { accept: "text/event-stream" }), signal: ctl.signal }).then(async (r) => {
    events.status = r.status; events.type = r.headers.get("content-type");
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
      }
    }
  }).catch(() => {});
  return { events, close: () => ctl.abort(), done };
}


const shots = process.argv[2] || null;
const { webReplyMode } = await imp("src/dailyflag.js");
step("REASON_WEB_REPLY is on for this drive", webReplyMode() === "on", webReplyMode());

// 1. History from both places: a text from the phone, then two Web messages.
await router.deliver({ channel: "fake", externalId: "k-sb-1", from: KOFI, text: "remind me to call mum", chatId: null, at: Date.now() });
const kofi = signIn(KOFI_C);
await page(kofi); // the once-only 5C
const p1 = await page(kofi, "?thread");
const csrf = csrfOf(p1.body);
step("GET /web?thread: the composer's reply line is there, hidden, with the page's part", /class="rchip" hidden/.test(p1.body) && /R\.rp=function/.test(p1.body));
await post(kofi, csrf, "rd-w-0001", "table for two at 8?");
await until(() => web.recent.length >= 1);
await post(kofi, csrf, "rd-w-0002", "also the weather");
await until(() => web.recent.length >= 2);
const lines = (await hist(kofi, "after=0")).messages;
step("every line in the thread carries a Reply button", lines.length >= 6 && lines.every(m => m.canReply && /class="rp"/.test(m.html)), `${lines.length} lines`);

// 2. A reply to Reason's answer, over the wire: the turn reads it as an inline reply to THAT message.
const answer = lines.find(m => m.role === "assistant" && /table for two at 8/.test(m.html));
const r = await fetch(`${BASE}/web/send`, { method: "POST", headers: H(kofi, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": csrf }), body: new URLSearchParams({ id: "rd-w-0003", text: "yeah do it", c: csrf, re: String(answer.id) }) });
step("POST /web/send with re=<row>: 200", r.status === 200);
await until(() => turns.some(t => /yeah do it/.test(t)));
const t3 = turns.find(t => /yeah do it/.test(t)) ?? "";
step("the turn read: inline reply in the thread under Reason's \"re: table for two at 8?\"", /\[they sent this as an inline reply in the thread under your message: "re: table for two at 8\?"/.test(t3), t3.split("\n")[0]);
const ib = db.db.prepare("SELECT reply_to, thread_root FROM inbound_messages WHERE external_id = ?").get(`${KOFI_C}:rd-w-0003`);
step("the inbound row keeps parent + thread root (the outbox handle of that answer)", !!ib?.reply_to && ib.reply_to === ib.thread_root && /^web-/.test(ib.reply_to), JSON.stringify(ib));
await until(() => web.recent.length >= 3);
const mine = (await hist(kofi, "after=0")).messages.find(m => m.cid === "rd-w-0003");
step("the reply draws a quote line of the parent, linked to it, and not the stored note", mine?.quote?.id === answer.id && new RegExp(`class="rq" href="/web\\?thread&amp;at=${answer.id}#m-${answer.id}"`).test(mine.html) && !/inline reply/.test(mine.html));
// 3. A reply to their own iMessage text, from Web.
const textRow = lines.find(m => m.role === "user" && m.source === "iMessage");
await post(kofi, csrf, "rd-w-0004", "make it 6pm", { });
const r4 = await fetch(`${BASE}/web/send`, { method: "POST", headers: H(kofi, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": csrf }), body: new URLSearchParams({ id: "rd-w-0005", text: "actually 7", c: csrf, re: String(textRow.id) }) });
await until(() => turns.some(t => /actually 7/.test(t)));
step("a Web reply to their iMessage text names it; nothing texted", r4.status === 200 && /under their message: "remind me to call mum"/.test(turns.find(t => /actually 7/.test(t)) ?? "") && phone.sent.length === 1);
// 4. Someone else's row is no reply; a malformed one is refused.
const ama = signIn(AMA_C);
await page(ama);
const acsrf = csrfOf((await page(ama, "?thread")).body);
const forged = await fetch(`${BASE}/web/send`, { method: "POST", headers: H(ama, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": acsrf }), body: new URLSearchParams({ id: "rd-a-0001", text: "hi", c: acsrf, re: String(answer.id) }) });
await until(() => turns.some(t => /^hi$/m.test(t)));
step("Ama naming Kofi's row: her message goes, as an ordinary one", forged.status === 200 && !turns.some(t => /inline reply/.test(t) && /^hi$/m.test(t.split("\n").at(-1))));
const bad = await fetch(`${BASE}/web/send`, { method: "POST", headers: H(ama, { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-reason-csrf": acsrf }), body: new URLSearchParams({ id: "rd-a-0002", text: "x", c: acsrf, re: "k-sb-1" }) });
step("a handle in `re` is refused 400 bad_reply", bad.status === 400 && (await bad.json()).error === "bad_reply");

// 5. In a real browser: hover → REPLY → the composer line → Esc cancels → REPLY again → send → quote line.
let pw = null;
try { pw = await imp("node_modules/playwright/index.mjs"); } catch { /* below */ }
if (!pw) step("Chromium part", false, "playwright not installed in this checkout (npm ci)");
else {
  const browser = await pw.chromium.launch();
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const b2 = signIn(KOFI_C);
    await ctx.addCookies([{ name: "reason_page", value: b2.token, url: BASE }]);
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/web?thread`);
    await pg.waitForSelector(".thread .msg.re .rp", { state: "attached" });
    const target = pg.locator(".thread .msg.re").filter({ hasText: "re: also the weather" }).first();
    const hidden = await target.locator(".rp").evaluate(e => getComputedStyle(e).opacity);
    await target.hover(); await pg.waitForTimeout(250);
    const shown = await target.locator(".rp").evaluate(e => getComputedStyle(e).opacity);
    step(`[${scheme}] REPLY is hidden at rest and shown on hover`, hidden === "0" && shown === "1", `${hidden} → ${shown}`);
    if (shots) await pg.screenshot({ path: `${shots}/drive-hover-${scheme}.png` });
    await target.locator(".rp").click();
    const chip = pg.locator(".rchip");
    step(`[${scheme}] pressed: the composer says REPLYING TO REASON + the words, and has focus`, await chip.isVisible() && /REPLYING TO REASON/.test(await chip.innerText()) && /re: also the weather/.test(await chip.innerText()) && await pg.evaluate(() => document.activeElement?.id === "c-input"));
    await pg.keyboard.press("Escape");
    step(`[${scheme}] Esc cancels it`, !(await chip.isVisible()));
    await target.hover(); await target.locator(".rp").click();
    if (shots) await pg.screenshot({ path: `${shots}/drive-replying-${scheme}.png` });
    const n = turns.length;
    await pg.fill("#c-input", `sunny is fine (${scheme})`);
    await pg.keyboard.press("Enter");
    await until(() => turns.length > n && /inline reply/.test(turns.at(-1)), 5000);
    step(`[${scheme}] sent from the page: the turn read it as a reply to "re: also the weather"`, /under your message: "re: also the weather"/.test(turns.at(-1)));
    step(`[${scheme}] the line clears once sent`, !(await chip.isVisible()));
    const q = pg.locator(".thread .msg.you").filter({ hasText: `sunny is fine (${scheme})` }).locator(".rq");
    await q.first().waitFor({ timeout: 8000 }).catch(() => {});
    step(`[${scheme}] the sent line shows the quote line`, (await q.count()) >= 1 && /re: also the weather/.test(await q.first().innerText()));
    await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const before = await pg.evaluate(() => window.scrollY);
    await q.first().click(); await pg.waitForTimeout(900);
    const lit = await target.evaluate(e => e.classList.contains("lit"));
    step(`[${scheme}] clicking the quote goes to the parent and marks it`, lit, `scrollY ${before} → ${await pg.evaluate(() => window.scrollY)}`);
    if (shots) await pg.screenshot({ path: `${shots}/drive-quote-${scheme}.png` });
    await ctx.close();
  }
  // Touch: no hover. A tap shows REPLY; a long press replies at once.
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const b3 = signIn(KOFI_C);
  await m.addCookies([{ name: "reason_page", value: b3.token, url: BASE }]);
  const mp = await m.newPage();
  await mp.goto(`${BASE}/web?thread`);
  await mp.waitForSelector(".thread .msg.re .rp", { state: "attached" });
  const mt = mp.locator(".thread .msg.re").filter({ hasText: "re: also the weather" }).first();
  const hoverNone = await mp.evaluate(() => matchMedia("(hover: none)").matches);
  await mt.locator(".rsay").tap(); await mp.waitForTimeout(300);
  const on = await mt.evaluate(e => e.classList.contains("rp-on")), op = await mt.locator(".rp").evaluate(e => getComputedStyle(e).opacity);
  step("[touch] a tap on a message shows its REPLY", on && op === "1", `hover:none=${hoverNone} rp-on=${on} opacity=${op}`);
  if (shots) await mp.screenshot({ path: `${shots}/drive-touch-${"shown"}.png` });
  await mt.locator(".rp").tap();
  step("[touch] tapping REPLY opens the composer line", await mp.locator(".rchip").isVisible());
  await mp.locator(".rc-x").tap();
  const other = mp.locator(".thread .msg.you").filter({ hasText: "also the weather" }).first();
  await other.locator(".said").dispatchEvent("touchstart"); await mp.waitForTimeout(650); await other.locator(".said").dispatchEvent("touchend");
  step("[touch] a long press replies at once (to their own line)", await mp.locator(".rchip").isVisible() && /REPLYING TO YOU/.test(await mp.locator(".rchip").innerText()) && /also the weather/.test(await mp.locator(".rc-t").innerText()));
  if (shots) await mp.screenshot({ path: `${shots}/drive-touch-replying.png` });
  await m.close();
  await browser.close();
}

server.close();
process.exit(fails ? 1 : 0);
