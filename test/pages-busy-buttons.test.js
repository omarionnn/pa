// Every form button answers the tap (owner, 2026-10-25: "Text me a code" showed nothing but the
// browser's own spinner, and a second tap sent a second request). One component in
// src/pages/render.js (BUSY, riding inside THEME): on submit the button shows a ring and its
// data-busy words at the same width, the form takes no second submit, and the request is the one
// the form sends without script. A sent code says so with a ✓ line and a way to send it again.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
process.env.REASON_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "busy-")), "x.db");

const render = await import("../src/pages/render.js");
const ev = await import("../src/pages/event.js");
const { renderOps } = await import("../src/pages/ops.js");
const spotify = await import("../src/spotify.js");
const remote = await import("../src/signin-remote.js");
const { chromium } = await import("playwright");

const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", guest_list_visible: 1, organizer_token: "x", status: "active", organizer_conversation_id: "console:x" };
const html = (r) => typeof r === "string" ? r : r.body;

test("every form button on every page names what it is doing while it waits", () => {
  const pages = {
    eventGate: ev.renderGate({ ev: e, token: "t" }),
    eventGateSent: ev.renderGate({ ev: e, token: "t", sent: true }),
    signin: ev.renderSignin({ ev: e }),
    signinSent: ev.renderSignin({ ev: e, number: "5551234567", sent: true }),
    join: ev.renderJoin({ ev: e }),
    codeGate: render.renderCodeGate({ canSend: true }),
    codeGateSent: render.renderCodeGate({ canSend: true, sent: true }),
    password: render.renderPasswordGate({}),
    spotify: spotify.joinPage({ token: "t" }),
  };
  for (const [name, page] of Object.entries(pages)) {
    const body = html(page);
    const buttons = body.match(/<button[^>]*type="submit"[^>]*>/g) ?? [];
    assert.ok(buttons.length, `${name}: has a submit button`);
    for (const b of buttons) assert.match(b, /data-busy="[^"]+…"/, `${name}: ${b}`);
    assert.ok(body.includes("busy-ring") && body.includes("aria-busy"), `${name}: carries the busy script`);
  }
  assert.ok(html(renderOps({ report: null })).includes("busy-ring"), "/ops too");
  assert.ok(html(remote.shell("Sign in", "")).includes("busy-ring"), "remote sign-in too");
});

test("a sent code says so, with a way to send it again; an error page doesn't claim it", () => {
  assert.match(html(ev.renderGate({ ev: e, token: "t", sent: true })), /class="sent-ok" role="status">.*✓.*Code sent — check your texts\./);
  assert.match(html(ev.renderGate({ ev: e, token: "t", sent: true })), /name="step" value="send">[^]*?>Text it again<\/button>/);
  assert.doesNotMatch(html(ev.renderGate({ ev: e, token: "t", sent: true, error: "That code isn't right." })), /class="sent-ok"/);
  // Sign-in never says the number uses Reason, sent or not.
  const s = html(ev.renderSignin({ ev: e, number: "5551234567", sent: true }));
  assert.match(s, /Sent\. If that number uses Reason, a code is on its way to it now\./);
  assert.match(s, /name="number" value="5551234567"><button[^>]*>Text it again<\/button>/);
  assert.match(html(render.renderCodeGate({ canSend: true, sent: true })), /class="sent-ok"/);
});

// ---- in a browser ----
let server, base, browser, posts = [];
const forms = {
  gate: () => ev.renderGate({ ev: e, token: "t" }),
  code: () => render.renderCodeGate({ canSend: true }),
};
before(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(html(forms[req.url.slice(1)]())); }
    let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { posts.push(b); setTimeout(() => res.end("ok"), 1500); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

// Forms point at a hidden frame so the page stays to be read (Chromium answers nothing on a page
// whose own POST is in flight); the request is the same bytes to the same address.
const SINK = `addEventListener("DOMContentLoaded",()=>{const i=document.createElement("iframe");i.name="sink";i.hidden=true;document.body.append(i);document.querySelectorAll("form").forEach(f=>{f.target="sink"})})`;
async function tap(name, label, { script = true, times = 3 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: script });
  const page = await ctx.newPage();
  if (script) await page.addInitScript(SINK);
  posts = [];
  await page.goto(base + name);
  const r = await page.locator("button", { hasText: label }).first().boundingBox();
  const xy = [r.x + r.width / 2, r.y + r.height / 2];
  await page.mouse.dblclick(...xy);
  for (let i = 2; i < times; i++) { await page.waitForTimeout(300); await page.mouse.click(...xy); }
  await page.waitForTimeout(script ? 200 : 1800);
  const state = script ? await page.evaluate((w) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.dataset.busyWas === w);
    return b && { text: b.textContent, ring: !!b.querySelector(".busy-ring"), busy: b.getAttribute("aria-busy"), off: b.getAttribute("aria-disabled"), w: b.getBoundingClientRect().width, say: b.form.querySelector("[role=status][aria-live=polite]")?.textContent };
  }, label) : null;
  await ctx.close();
  return { posts: [...posts], state, w: r.width };
}

test("a double-click and a third tap on Text me a code send ONE request, and the button says Sending code…", async () => {
  const { posts: sent, state, w } = await tap("gate", "Text me a code");
  assert.equal(sent.length, 1, "one request");
  assert.equal(sent[0], "t=t&step=send");
  assert.ok(state, "the button is marked busy");
  assert.equal(state.text, "Sending code…");
  assert.ok(state.ring);
  assert.equal(state.busy, "true");
  assert.equal(state.off, "true");
  assert.equal(state.say, "Sending code…", "a polite status line says it to a screen reader");
  assert.ok(Math.abs(state.w - w) <= 1, `same width: ${w} → ${state.w}`);
});

test("the button's own name=value still rides along (not disabled), same as with script off", async () => {
  const on = await tap("code", "Text me the code", { times: 2 });
  const off = await tap("code", "Text me the code", { script: false, times: 1 });
  assert.equal(on.posts.length, 1);
  assert.equal(off.posts.length, 1, "with script off the form still posts");
  assert.equal(on.posts[0], off.posts[0]);
  assert.match(on.posts[0], /send=1/);
});
