#!/usr/bin/env node
// Check the Light · Dark · Auto switch on every kind of page Reason serves, in headless Chromium:
// the same pages as bin/wordmark.mjs (events, files page, gates, not-found, notice, /ops, invite,
// Spotify, remote sign-in). Renders in process from src/ and serves them from a throwaway loopback
// server (localStorage needs an origin) — no Reason server, no database rows, nothing sent anywhere.
//
//   cd ~/Desktop/pa && node .agents/skills/verify-reason/bin/theme-all.mjs [--shots dir]
//
// Per page × width (390, 1280) × state — auto on a light phone, auto on a dark phone, Dark picked on
// a light phone, Light picked on a dark phone — one `ok`/`FAIL` line; exits non-zero on any FAIL.
// Passes when: the switch is visible at the foot with Auto pressed on a fresh browser; tapping a
// choice sets the page to it and survives a reload; the ground matches the state; and every visible
// text (wordmark letters, headings, body, switch, input text) is ≥4.5:1 against what it sits on, the
// wordmark bubble and every input's edge ≥1.3:1 (≥3:1 for a focused input's ring is not checked).
// The kicker is held to 4.5:1 like the rest (brand red #b03030 / #e8765c, src/pages/brand.js), and
// no visible element nor the switch's focus ring is blue (owner, 2026-10-25).
// `--shots dir` saves each page at 390px in all four states.
const { mkdtempSync, mkdirSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createServer } = await import("node:http");
const { createRequire } = await import("node:module");
process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "theme-all-")), "x.db");
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];

const root = new URL("../../../../", import.meta.url);
const mod = (p) => import(new URL(p, root));
const ev = await mod("src/pages/event.js");
const render = await mod("src/pages/render.js");
const ops = await mod("src/pages/ops.js");
const invites = await mod("src/invites.js");
const spotify = await mod("src/spotify.js");
const remote = await mod("src/signin-remote.js");
const { chromium } = createRequire(new URL("package.json", root))("playwright");
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", place: "Somewhere", description: "Board games", guest_list_visible: 1, organizer_token: "x", status: "active", organizer_conversation_id: "console:x" };
const att = { id: 1, display_name: "Ama", instagram: "", in_directory: 1 };
const html = (r) => typeof r === "string" ? r : r.body;
const filesPage = { id: 1, title: "Coffee at home", subtitle: "", created_at: Date.now(), blocks: [{ type: "text", text: "Beans, grind, water." }] };
const pages = {
  "event-join": () => ev.renderJoin({ ev: e }),
  "event-signin": () => ev.renderSignin({ ev: e, number: "+1 555 123 4567" }),
  "event-signin-code": () => ev.renderSignin({ ev: e, number: "+15551234567", sent: true }),
  "event-gate": () => ev.renderGate({ ev: e, token: "t", sent: true }),
  "event-joined": () => ev.renderJoined({ ev: e, att }),
  "event-whos-going": () => ev.renderWho({ ev: e, att, token: "t" }),
  "event-organizer": () => ev.renderOrganizerHome({ ev: e }),
  "files-page": () => render.renderPage(filesPage, { forName: "Omari" }),
  "files-code-gate": () => render.renderCodeGate({ canSend: true }),
  "files-password-gate": () => render.renderPasswordGate({}),
  "not-found": () => render.renderNotFound(),
  "notice": () => render.renderConnected({ title: "Connected", lines: ["Done."] }),
  "ops": () => ops.renderOps({ report: null }),
  "invite": () => invites.renderInvite({ invite: { state: "open", claim_code: "123456" }, name: "Omari", lineNumber: "+16562167455" }),
  "spotify-join": () => spotify.joinPage({ token: "t" }),
  "spotify-callback": () => spotify.callbackPage({ ok: true, message: "Connected." }),
  "remote-signin": () => remote.shell("Sign in to Uber", "<h1>Sign in</h1><p class=\"lead\">Opening Uber…</p>"),
};
const served = Object.fromEntries(Object.entries(pages).map(([k, f]) => [k, html(f())]));
const server = createServer((req, res) => {
  const body = served[req.url.slice(1)];
  res.writeHead(body ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// Contrast of every visible text and mark on the page, against the colour it actually sits on.
const audit = () => {
  const rgb = (s) => { const m = s.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const behind = (n) => { for (let el = n; el; el = el.parentElement) { const c = rgb(getComputedStyle(el).backgroundColor); if ((c[3] ?? 1) > .5) return c; } return rgb(getComputedStyle(document.documentElement).backgroundColor).slice(0, 3).some(Boolean) ? rgb(getComputedStyle(document.documentElement).backgroundColor) : [255, 255, 255]; };
  const visible = (n) => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return r.width && r.height && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > .1 && !n.closest(".intro,[hidden]"); };
  const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    const el = t.parentElement; if (!t.textContent.trim() || !visible(el) || el.closest("script,style,noscript")) continue;
    const r = ratio(rgb(getComputedStyle(el).color), behind(el));
    if (r < 4.5) bad.push(`"${t.textContent.trim().slice(0, 18)}" ${r.toFixed(2)}`);
  }
  for (const i of document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]),textarea")) {
    if (!visible(i)) continue;
    const s = getComputedStyle(i), bg = behind(i), around = behind(i.parentElement);
    if (i.value && ratio(rgb(s.color), bg) < 4.5) bad.push(`input text ${ratio(rgb(s.color), bg).toFixed(2)}`);
    const edge = Math.max(ratio(rgb(s.borderTopColor), around), ratio(bg, around));
    if (edge < 1.3) bad.push(`input #${i.id || i.name} edge ${edge.toFixed(2)}`);
  }
  for (const p of document.querySelectorAll(".wm-bubble path")) {
    if (!visible(p.closest("svg"))) continue;
    const r = ratio(rgb(getComputedStyle(p).stroke), behind(p.closest(".wordmark")));
    if (r < 1.3) bad.push(`bubble ${r.toFixed(2)}`);
  }
  // No blue (owner, 2026-10-25): every visible element's text, fill, edge and outline is off the
  // blue hues — links, buttons, focus rings and highlights take the brand red (src/pages/brand.js).
  const blue = (c) => { const [r, g, b, a = 1] = c.map((v, i) => i < 3 ? v / 255 : v); if (a < .05) return false; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return false; const l = (mx + mn) / 2, sat = d / (1 - Math.abs(2 * l - 1)); let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; return h >= 190 && h <= 260 && sat > .35; };
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    for (const k of ["color", "backgroundColor", "borderTopColor", "outlineColor", "textDecorationColor", "fill", "stroke"]) {
      if ((k === "outlineColor" && s.outlineStyle === "none") || (k.startsWith("border") && !parseFloat(s.borderTopWidth))) continue;
      if (s[k] && s[k] !== "none" && blue(rgb(s[k]))) bad.push(`blue ${k} on <${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}>`);
    }
  }
  return { bad };
};

let fails = 0;
const b = await chromium.launch();
const STATES = [["auto-light", "light", null], ["auto-dark", "dark", null], ["dark-on-light", "light", "dark"], ["light-on-dark", "dark", "light"]];
try {
  for (const name of Object.keys(pages)) for (const w of [390, 1280]) for (const [state, scheme, pick] of STATES) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: w < 1000, hasTouch: w < 1000, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
    const p = await ctx.newPage();
    const why = [];
    try {
      await p.goto(base + name);
      const sw = p.locator(".theme").last();
      if (!(await sw.isVisible())) why.push("no visible switch");
      else {
        if (await sw.locator("[aria-pressed=true]").innerText() !== "Auto") why.push("fresh browser not on Auto");
        if (pick) {
          await sw.locator(`[data-set=${pick}]`).click();
          await p.reload();
          const t = await p.evaluate(() => document.documentElement.dataset.theme ?? "auto");
          if (t !== pick) why.push(`after reload theme=${t}`);
          if (await p.locator(".theme").last().locator("[aria-pressed=true]").innerText() !== pick[0].toUpperCase() + pick.slice(1)) why.push("pressed button wrong after reload");
        }
      }
      const want = (pick ?? scheme) === "dark";
      const ground = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const g = ground.match(/\d+/g).map(Number), isDark = g[0] + g[1] + g[2] < 150;
      if (isDark !== want) why.push(`ground ${ground} for ${pick ?? scheme}`);
      const a = await p.evaluate(audit); why.push(...a.bad);
      if (await sw.isVisible()) {
        await p.keyboard.press("Tab"); // bring keyboard focus mode on, then focus the switch itself
        await sw.locator("[data-set=auto]").focus();
        const ring = await p.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle === "none" ? null : s.outlineColor; });
        if (ring && /rgb\((\d+), (\d+), (\d+)/.test(ring)) { const [, r, g, b2] = ring.match(/(\d+), (\d+), (\d+)/).map(Number); if (b2 > r + 40 && b2 > g) why.push(`switch focus ring blue ${ring}`); }
      }
      if (shots && w === 390) await p.screenshot({ path: join(shots, `${name}-${state}.png`), fullPage: true });
    } catch (err) { why.push(String(err.message).split("\n")[0]); }
    if (why.length) fails++;
    console.log(`${why.length ? "FAIL" : "ok  "} ${name} ${w}px ${state}${why.length ? ` — ${why.slice(0, 4).join(", ")}` : ""}`);
    await ctx.close();
  }
} finally { await b.close(); server.close(); }
process.exit(fails ? 1 : 0);
