#!/usr/bin/env node
// Check that every form button on Reason's pages answers a tap (owner, 2026-10-25): in headless
// Chromium at 390px, each page's form is served from a throwaway loopback server whose POSTs answer
// slowly, the button is double-clicked and tapped once more, and the check reads what the reader sees while it waits.
// Renders in process from src/ — no Reason server, no database rows, nothing sent anywhere.
//
//   cd ~/Desktop/pa && node .agents/skills/verify-reason/bin/buttons.mjs [--shots dir] [--root path]
//
// One `ok`/`FAIL` line per form; exits non-zero on any FAIL. Passes when: a double-click and a third tap
// send ONE request; while it waits the button shows the ring + its data-busy words, is aria-busy and
// aria-disabled, keeps its width (±1px), and a role=status line says the same; the request body is
// byte-for-byte the one the same click sends with script off (so a button's own name=value rides
// along); with script off the form still posts. Then, once: a POST that never answers puts the
// button back after 20 s with a visible line, and a page brought back by Back is not stuck busy.
// `--shots dir` saves the event "Text me a code" button idle, pending and sent, light and dark.
// `--root path` renders from another checkout (a before shot of the same flow on old code).
const { mkdirSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join, resolve } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "buttons-")), "x.db");
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];

const arg = (n) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null;
const root = arg("--root") ? pathToFileURL(resolve(arg("--root")) + "/") : new URL("../../../../", import.meta.url);
const mod = (p) => import(new URL(p, root));
const ev = await mod("src/pages/event.js");
const render = await mod("src/pages/render.js");
const ops = await mod("src/pages/ops.js");
const spotify = await mod("src/spotify.js");
const { chromium } = createRequire(new URL("../../../../package.json", import.meta.url))("playwright");
const shots = arg("--shots");
if (shots) mkdirSync(shots, { recursive: true });

const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", place: "Somewhere", description: "Board games", guest_list_visible: 1, organizer_token: "x", status: "active", organizer_conversation_id: "console:x" };
const att = { id: 1, display_name: "Ama", instagram: "", in_directory: 1, token: "t" };
const html = (r) => typeof r === "string" ? r : r.body;
// name → [page, button to press (text), what to fill first, the page the POST answers with]
const forms = {
  "event-gate-send": [() => ev.renderGate({ ev: e, token: "t" }), "Text me a code", {}, () => ev.renderGate({ ev: e, token: "t", sent: true })],
  "event-gate-code": [() => ev.renderGate({ ev: e, token: "t", sent: true }), "Open", { "#code": "123456" }],
  "event-gate-resend": [() => ev.renderGate({ ev: e, token: "t", sent: true }), "Text it again", {}],
  "event-signin-send": [() => ev.renderSignin({ ev: e }), "Text me a code", { "#number": "5551234567" }, () => ev.renderSignin({ ev: e, number: "5551234567", sent: true })],
  "event-signin-code": [() => ev.renderSignin({ ev: e, number: "5551234567", sent: true }), "Sign in", { "#code": "123456" }],
  "event-signin-resend": [() => ev.renderSignin({ ev: e, number: "5551234567", sent: true }), "Text it again", {}],
  "event-join": [() => ev.renderJoin({ ev: e }), "Join", { "#password": "pw", "#display_name": "Ama" }],
  "event-who-save": [() => ev.renderWho({ ev: e, att, token: "t" }), "Save", {}],
  "files-code-send": [() => render.renderCodeGate({ canSend: true }), "Text me the code", {}, () => render.renderCodeGate({ canSend: true, sent: true })],
  "files-code-open": [() => render.renderCodeGate({ canSend: true, sent: true }), "Open", { "input[name=code]": "123456" }],
  "files-code-resend": [() => render.renderCodeGate({ canSend: true, sent: true }), "Text it again", {}],
  "ops-password": [() => render.renderPasswordGate({}), "Open", { "input[type=password]": "pw" }],
  "spotify-join": [() => spotify.joinPage({ token: "t" }), "Submit", { "input[type=email]": "a@b.co" }],
};
const has = (name) => { try { return html(forms[name][0]()).includes(`>${forms[name][1]}</button>`); } catch { return false; } };

let posts = [], hang = false, answer = "";
const server = createServer((req, res) => {
  if (req.method === "GET") {
    const f = forms[req.url.slice(1).split("?")[0]];
    res.writeHead(f ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(f ? html(f[0]()) : "");
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    posts.push(body);
    if (hang) return; // never answers
    setTimeout(() => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(answer); }, 1500);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
// Every form posts back to this server: absolute actions ("/e/…/who") and "" both land here.

const browser = await chromium.launch();
let fails = 0;
const say = (ok, line) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };
const ctx = (opts = {}) => browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
async function open(c, name, sink = false) {
  const page = await c.newPage();
  if (sink) await page.addInitScript(SINK);
  await page.goto(base + name);
  await page.waitForTimeout(150);
  for (const [sel, v] of Object.entries(forms[name][2])) await page.fill(sel, v);
  return page;
}
// The page a POST answered with, as the reader lands on it.
async function c2page(c, body) { const p = await c.newPage(); await p.route("**/*", (r) => r.fulfill({ contentType: "text/html", body })); await p.goto(base + "sent"); await p.waitForTimeout(150); return p; }
const button = (page, name) => page.locator("button", { hasText: forms[name][1] }).first();
// The mouse, not locator.click(), so Playwright does not wait on a navigation. And while a POST is
// in flight Chromium answers no evaluate or screenshot on the page that sent it, so to look at the
// waiting page every form is pointed at a hidden frame (`sink`): the request is the same bytes to
// the same address, the page stays put, and what it shows while it waits can be read and shot.
const at = async (page, name) => { await button(page, name).scrollIntoViewIfNeeded(); const r = await button(page, name).boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
const SINK = `addEventListener("DOMContentLoaded",()=>{const i=document.createElement("iframe");i.name="sink";i.hidden=true;document.body.append(i);document.querySelectorAll("form").forEach(f=>{f.target="sink"})})`;
const BTN = (label) => [...document.querySelectorAll("button")].find((x) => x.dataset.busyWas ? x.dataset.busyWas === label : x.textContent === label);

for (const name of Object.keys(forms)) {
  if (!has(name)) { say(!!arg("--root"), `${name}: no "${forms[name][1]}" button on this page`); continue; }
  answer = html((forms[name][3] ?? forms[name][0])());
  // Script off: what one click sends, and that it still posts at all.
  const off = await ctx({ javaScriptEnabled: false });
  posts = [];
  let page = await open(off, name);
  await page.mouse.click(...await at(page, name));
  await page.waitForTimeout(1900);
  const bare = posts[0];
  say(posts.length === 1, `${name}: posts with script off (${posts.length})`);
  await off.close();

  // Script on: double-click, then read the waiting state.
  const on = await ctx();
  posts = [];
  page = await open(on, name, true);
  const w0 = (await button(page, name).boundingBox()).width;
  // A double-click, then the impatient second tap 300 ms later.
  const xy = await at(page, name);
  await page.mouse.dblclick(...xy);
  await page.waitForTimeout(300);
  await page.mouse.click(...xy);
  await page.waitForTimeout(100);
  const busy = await page.evaluate(([label, find]) => { const el = eval(find)(label); return {
    text: el.textContent, label: el.dataset.busy, ring: !!el.querySelector(".busy-ring"), aria: el.getAttribute("aria-busy"),
    dis: el.getAttribute("aria-disabled"), w: el.getBoundingClientRect().width, status: el.form.querySelector(".busy-say")?.textContent ?? "",
  }; }, [forms[name][1], BTN.toString()]);
  if (shots && name === "event-gate-send") await page.screenshot({ path: join(shots, "pending-light.png") });
  await page.waitForTimeout(400);
  const n = posts.length;
  say(n === 1, `${name}: a double-click and a third tap send ONE request (${n})`);
  if (!arg("--root")) {
    say(!!busy.label && busy.text === busy.label && busy.ring, `${name}: shows "${busy.label}" with a ring (got "${busy.text}")`);
    say(busy.aria === "true" && busy.dis === "true" && busy.status === busy.label, `${name}: aria-busy, aria-disabled, status line`);
    say(Math.abs(busy.w - w0) <= 1, `${name}: same width (${w0.toFixed(1)} → ${busy.w.toFixed(1)})`);
    say(posts[0] === bare, `${name}: same request as with script off (${posts[0]})`);
  }
  if (shots && name === "event-gate-send") { const s = await c2page(on, answer); await s.screenshot({ path: join(shots, "sent-light.png") }); }
  await on.close();
}

if (shots) {
  // Idle and pending, dark too.
  const name = "event-gate-send";
  answer = html(forms[name][3]());
  for (const scheme of ["light", "dark"]) {
    const c = await ctx({ colorScheme: scheme });
    const page = await open(c, name, true);
    await page.screenshot({ path: join(shots, `idle-${scheme}.png`) });
    if (scheme === "dark") {
      await page.mouse.click(...await at(page, name)); await page.waitForTimeout(250);
      await page.screenshot({ path: join(shots, "pending-dark.png") });
      await (await c2page(c, answer)).screenshot({ path: join(shots, "sent-dark.png") });
    }
    await c.close();
  }
}

if (!arg("--root")) {
  // A POST that never answers: the button comes back after 20 s, with a line saying so.
  hang = true;
  const c = await ctx();
  const page = await open(c, "event-signin-send", true);
  await page.mouse.click(...await at(page, "event-signin-send"));
  await page.waitForTimeout(20600);
  const back = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Text me a code");
    const s = b?.form.querySelector(".busy-say");
    return { b: !!b, busy: b?.getAttribute("aria-busy"), say: s?.textContent ?? "", shown: s ? getComputedStyle(s).display !== "none" : false };
  });
  say(back.b && !back.busy && back.shown && /try again/i.test(back.say), `no answer: button back after 20 s with "${back.say}"`);
  posts = [];
  await page.mouse.click(...await at(page, "event-signin-send"));
  await page.waitForTimeout(200);
  say(posts.length === 1, "no answer: the button works again (1 more request)");
  await c.close();
  hang = false;

  // Back from the next page: not stuck busy (the back/forward cache keeps the page as it was left).
  answer = "<!doctype html><title>next</title><p>next</p>";
  const c2 = await ctx();
  const p2 = await open(c2, "event-gate-send");
  await p2.mouse.click(...await at(p2, "event-gate-send"));
  await p2.waitForTimeout(1900);
  await p2.goBack();
  await p2.waitForTimeout(300);
  const stuck = await p2.evaluate(() => [...document.querySelectorAll("button[aria-busy=true],form[data-busy]")].length);
  say(stuck === 0, `back to the page: nothing left busy (${stuck})`);
  await c2.close();
}

await browser.close();
server.close();
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
