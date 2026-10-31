#!/usr/bin/env node
// Drive Reason Web's /web?draft=<text>&from=<where> (src/pages/webprefill.js — the /updates tear-off
// pad) over REAL HTTP in real browsers: src/http.js createServer on a loopback port, a fake texting
// channel that only records (the sign-in code is read from it), a model stand-in that answers "re: …".
// Nothing leaves the machine.
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/web.db node .agents/skills/verify-reason/bin/web-draft-drive.mjs [--shots=DIR] [--video] [--before]
//
// WebKit (iPhone 390, touch) and Google Chrome (desktop 1280), motion on and reduced. Per run:
// signed in the words land in the thread's composer (typed in, or whole), focused, cursor at the end,
// the address cleaned, nothing sent; words already in the composer are kept (the draft goes under
// them); signed out the draft survives the real sign-in (number → texted code → code) and lands in
// the thread. Desktop reduced also presses send once (draft_sent). --before: what a tree without this
// does (the words are nowhere). Prints `ok` / `FAIL` per step; exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_WEB_STREAM = "off";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ ||= "America/New_York";
delete process.env.REASON_SITE_URL;
delete process.env.REASON_PAGES_URL;
delete process.env.REASON_PUBLIC_URL;
delete process.env.REASON_SITE_PROXY_SECRET;
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dbp = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = dbp && existsSync(dirname(dbp)) ? realpathSync(dirname(dbp)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  const data = process.env.REASON_DATA_DIR && existsSync(process.env.REASON_DATA_DIR) ? realpathSync(process.env.REASON_DATA_DIR) + "/" : "";
  if (!dbp || existsSync(dbp) || !parent || !roots.some(r => parent.startsWith(r)) || !data || !roots.some(r => data.startsWith(r))) {
    console.error("refusing: set REASON_DATA_DIR to a temp directory and REASON_DB_PATH to a new file in it");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET", "ELEVENLABS_API_KEY"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
const shots = process.argv.find(a => a.startsWith("--shots="))?.slice(8) || "";
const video = process.argv.includes("--video");
const before = process.argv.includes("--before");

const { mkdirSync } = await import("node:fs");
const { join } = await import("node:path");
const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { WebChannel } = await imp("src/channels/web.js");
const { makeDeliver } = await imp("src/deliver.js");
const { createServer } = await imp("src/http.js");
const { config } = await imp("src/config.js");
const db = await imp("src/db.js");
config.web = true;

const KOFI = "+14155559876", KOFI_C = `dm:fake:${KOFI}`;
db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: KOFI, isOwner: true, service: "iMessage" });
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
db.markWebNoticeSeen(KOFI_C);
const at0 = Date.now() - 3 * 60 * 60_000;
db.writeMessage({ conversationId: KOFI_C, role: "user", channel: "sendblue", externalId: "d1", text: "can you check if the Saturday brunch place takes reservations", at: at0 });
db.writeMessage({ conversationId: KOFI_C, role: "assistant", channel: "sendblue", text: "They do — I held 11:30 for two under Kofi. Want me to add it to your calendar?", at: at0 + 60_000 });

const logs = [];
const router = new Router({ log: () => {} });
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const runtime = new Runtime({ log: () => {}, channels: router, deliver, runTurn: async (a) => `re: ${a.text}` });
router.runtime = runtime;
router.register(consoleChannel);
const fake = router.register(new FakeChannel({ number: "+16562167455" }));
router.register(new WebChannel());
runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
  await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
});
const server = createServer({ router, runtime, log: (e) => logs.push(e) });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const userRows = () => db.messagesFor(KOFI_C).filter(r => r.role === "user").length;
const EVENTS = "Make an event for my birthday dinner on Nov 14 and invite Ama and Kofi";
const CALLS = "Call the dentist and move my cleaning to next week, any morning works";
const url = (t, from) => `${base}/web?draft=${encodeURIComponent(t)}&from=${from}`;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `web-draft-${name}.png`) }); };

const { webkit, chromium } = await import("playwright");
const runs = [
  ["iphone", webkit, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true }, {}],
  ["desktop", chromium, { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }, { channel: "chrome" }],
];
for (const [name, type, ctxOpts, launch] of runs) {
  const browser = await type.launch({ headless: true, ...launch });
  for (const motion of before ? ["reduce"] : ["motion", "reduce"]) {
    const tag = `${before ? "before-" : ""}${name}-${motion === "reduce" ? "reduced" : "motion"}`;
    const ctxFor = async (signedIn) => {
      const ctx = await browser.newContext({ ...ctxOpts, reducedMotion: motion === "reduce" ? "reduce" : "no-preference", ...(video && name === "desktop" && motion === "motion" && shots ? { recordVideo: { dir: join(shots, "video"), size: { width: 1280, height: 860 } } } : {}) });
      if (signedIn) {
        const t = `drive-${Math.random().toString(36).slice(2)}`;
        db.startPageSession(`wsign:${KOFI_C}`, t, { conversationId: KOFI_C });
        await ctx.addCookies([{ name: "reason_page", value: t, url: base }]);
      }
      const page = await ctx.newPage();
      const errors = [], sends = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/web/send") sends.push(1); });
      return { ctx, page, errors, sends };
    };
    const value = (page) => page.locator("#c-input").inputValue().catch(() => null);

    // 1. Signed in: the words land in the thread's composer.
    {
      const { ctx, page, errors, sends } = await ctxFor(true);
      const n0 = userRows();
      await page.goto(url(EVENTS, "updates-events"));
      if (before) {
        await page.waitForTimeout(1500);
        await shot(page, `${tag}-landed`);
        step(`${tag}: on this tree the words are nowhere (composer "${await value(page)}", address ${new URL(page.url()).search.slice(0, 30)}…)`, true);
        await ctx.close();
        continue;
      }
      if (motion === "motion") {
        await page.waitForFunction(() => { const v = document.getElementById("c-input")?.value ?? ""; return v.length > 8; }, null, { timeout: 6000 });
        const mid = await value(page);
        await shot(page, `${tag}-typing`);
        step(`${tag}: typed in, a few characters at a time`, mid.length > 0 && mid.length < EVENTS.length && EVENTS.startsWith(mid), `${mid.length}/${EVENTS.length} mid-way`);
      }
      await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, EVENTS, { timeout: 8000 }).catch(() => {});
      step(`${tag}: the composer holds the draft`, (await value(page)) === EVENTS);
      step(`${tag}: the thread, not the arrival`, (await page.locator("ol.thread").count()) === 1);
      step(`${tag}: address cleaned`, new URL(page.url()).search === "", page.url());
      step(`${tag}: focused, cursor at the end`, await page.evaluate((n) => { const b = document.getElementById("c-input"); return document.activeElement === b && b.selectionStart === n && b.selectionEnd === n; }, EVENTS.length));
      await page.waitForTimeout(600);
      await shot(page, `${tag}-landed`);
      step(`${tag}: nothing sent`, sends.length === 0 && userRows() === n0);
      if (name === "desktop" && motion === "reduce") {
        const sentBefore = logs.filter(e => "draft_sent" in e).length;
        await page.press("#c-input", "Enter");
        await page.locator(".msg.re .rsay", { hasText: `re: ${EVENTS}` }).waitFor({ timeout: 8000 }).catch(() => {});
        await shot(page, `${tag}-sent`);
        step(`${tag}: pressing send sends it once, draft_sent {from} logged`, userRows() === n0 + 1 && logs.filter(e => "draft_sent" in e).length === sentBefore + 1 && logs.filter(e => "draft_sent" in e).at(-1).draft_sent === "updates-events");
      }
      step(`${tag}: no page errors`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }

    // 2. Words already in the composer are kept: the draft goes under them on a new line.
    {
      const { ctx, page, errors, sends } = await ctxFor(true);
      await page.route(/\/web\?/, async (route) => {
        const res = await route.fetch();
        const html = await res.text();
        const i = html.lastIndexOf("<script>");
        await route.fulfill({ response: res, body: `${html.slice(0, i)}<script>document.getElementById('c-input').value='also remind me to pick up the cake';</script>${html.slice(i)}` });
      });
      await page.goto(url(CALLS, "updates-calls"));
      const want = `also remind me to pick up the cake\n${CALLS}`;
      await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, want, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, `${tag}-append`);
      step(`${tag}: existing words kept, draft on a new line`, (await value(page)) === want, JSON.stringify(await value(page)));
      step(`${tag}: append sends nothing`, sends.length === 0 && errors.length === 0, errors.join(" | "));
      await ctx.close();
    }

    // 3. Signed out: through the real sign-in, into the thread.
    {
      // Each run signs in afresh: the drive's own code limits (3 per person per 15 min) start over, not the product's.
      db.db.exec("DELETE FROM page_codes; DELETE FROM page_attempts; DELETE FROM event_join_attempts;");
      const { ctx, page, errors, sends } = await ctxFor(false);
      await page.goto(url(CALLS, "updates-calls"));
      step(`${tag}: signed out, address cleaned on the sign-in page`, new URL(page.url()).search === "");
      step(`${tag}: sign-in form carries next=thread`, (await page.locator('form[action="/web/signin"] input[name="next"]').getAttribute("value").catch(() => null)) === "thread");
      await shot(page, `${tag}-signedout`);
      const sent = fake.sent.length;
      await page.fill("#number", KOFI);
      await page.locator('form[action="/web/signin"] .act, form[action="/web/signin"] button').first().click();
      await page.locator("#code").waitFor();
      const until = Date.now() + 4000;
      while (fake.sent.length === sent && Date.now() < until) await new Promise(r => setTimeout(r, 25));
      const code = /\b(\d{6})\b/.exec(fake.sent.at(-1)?.text ?? "")?.[1];
      step(`${tag}: a code was texted to the fake line`, !!code);
      await page.fill("#code", code ?? "000000");
      await page.waitForURL(/\/web\?thread$/, { timeout: 8000 }).catch(() => {});
      await page.waitForFunction((w) => document.getElementById("c-input")?.value === w, CALLS, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, `${tag}-after-signin`);
      step(`${tag}: after sign-in the draft is in the thread's composer`, new URL(page.url()).search === "?thread" && (await value(page)) === CALLS, page.url());
      step(`${tag}: signed-out path sends nothing`, sends.length === 0 && errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
  }
  await browser.close();
}
const pre = logs.filter(e => "draft_prefilled" in e);
if (!before) step(`draft_prefilled logged per arrival, from only, never the words`, pre.length >= 8 && pre.every(e => /^updates-(events|calls)$/.test(e.draft_prefilled)) && !JSON.stringify(logs).includes("dentist"), `${pre.length} arrivals`);
server.close();
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
