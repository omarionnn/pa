#!/usr/bin/env node
// Check the top-left "reason" wordmark on every kind of page Reason serves, in headless Chromium:
// event pages (join, sign-in, code gate, joined, who's going, organizer), a files page (with its
// opening moment), the private-page code and password gates, not-found, a notice, /ops, an invite,
// the Spotify join + callback pages and the remote sign-in page — at 390 and 1280 wide, dark and
// light. Renders in process from src/ — no server, no database rows, nothing sent anywhere.
//
//   cd ~/Desktop/pa && node .agents/skills/verify-reason/bin/wordmark.mjs [--shot out.png] [--site]
//
// One line per page × width × scheme, `ok` or `FAIL`; exits non-zero on any FAIL. A page passes when
// its first visible thing is the wordmark (reas + brand-red bubble + n, text "reason": the o rides hidden), at the start of the top line, in the inline Instrument
// Serif italic at 21.6px, the site's #2a2520 in light / the page's light ink in dark, bubble brand red #9c3b2e (dark: #d46a5c),
// with no old dot-and-"Reason" left in the top line. `--site` also measures the live marketing
// site's nav mark (`a.wordmark`) at 1280 and requires the same width, type size and bubble size (needs the network,
// reads only). `--shot` saves the 390px light event join page.
// 2026-10-27: since Site v4 the site's mark is 64px wide, 24px type, bubble 16.5×14; every page's is
// still 52px, 21.6px, 10.1×10.8, so `--site` FAILs at 1280 on all of them. That is the pages not
// following the redesign (an owner call), not a broken page; the 390px rows and the no-flag run pass.
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createRequire } = await import("node:module");
process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "wordmark-")), "x.db");
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
const arg = (f) => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] ?? "" : null;
const shot = arg("--shot");
const site = process.argv.includes("--site");

const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", place: "Somewhere", description: "Board games", guest_list_visible: 1, organizer_token: "x", status: "active", tz: "America/New_York", organizer_conversation_id: "console:x" };
const att = { id: 1, display_name: "Ama", instagram: "", in_directory: 1 };
const html = (r) => typeof r === "string" ? r : r.body;
const filesPage = { id: 1, title: "Coffee at home", subtitle: "", created_at: Date.now(), blocks: [{ type: "text", text: "Beans, grind, water." }] };
const pages = [
  ["event join", () => ev.renderJoin({ ev: e })],
  ["event signin", () => ev.renderSignin({ ev: e })],
  ["event gate", () => ev.renderGate({ ev: e, token: "t", sent: true })],
  ["event joined", () => ev.renderJoined({ ev: e, att })],
  ["event who's going", () => ev.renderWho({ ev: e, att, token: "t" })],
  ["event organizer", () => ev.renderOrganizerHome({ ev: e })],
  ["files page", () => render.renderPage(filesPage, { forName: "Omari" }), true],
  ["files code gate", () => render.renderCodeGate({ canSend: true })],
  ["files password gate", () => render.renderPasswordGate({})],
  ["not found", () => render.renderNotFound()],
  ["notice", () => render.renderConnected({ title: "Connected", lines: ["Done."] })],
  ["ops", () => ops.renderOps({ report: null })],
  ["invite", () => invites.renderInvite({ invite: { state: "open", claim_code: "123456" }, name: "Omari", lineNumber: "+16562167455" })],
  ["spotify join", () => spotify.joinPage({ token: "t" })],
  ["spotify callback", () => spotify.callbackPage({ ok: true, message: "Connected." })],
  ["remote sign-in", () => remote.shell("Sign in to Uber", "<h1>Sign in</h1>")],
];

let fails = 0;
const b = await chromium.launch();
const measure = () => {
  const w = [...document.querySelectorAll(".wordmark")].find(n => !n.closest(".intro"));
  if (!w) return { missing: true };
  const r = w.getBoundingClientRect(), cs = getComputedStyle(w), p = w.querySelector("svg path"), o = w.querySelector("svg").getBoundingClientRect();
  // The first painted thing on the page, in reading order, has to be inside the wordmark.
  const first = [...document.body.querySelectorAll("*")].find(n => {
    const q = n.getBoundingClientRect(), s = getComputedStyle(n);
    return q.width && q.height && s.visibility !== "hidden" && s.opacity !== "0" && n.children.length === 0 && !n.closest(".intro") && (n.textContent.trim() || n.tagName === "path" || n.tagName === "SPAN");
  });
  const bar = w.closest(".bar,header") ?? w.parentElement;
  // Top left of the top line: on a wide screen the line is the page column, so that is where it starts.
  const bs = getComputedStyle(bar), inL = Math.round(bar.getBoundingClientRect().left + parseFloat(bs.paddingLeft));
  return {
    l: Math.round(r.left), inL, o: Math.round(o.width * 10) / 10 + "×" + Math.round(o.height * 10) / 10, t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    text: w.textContent, fs: cs.fontSize, color: cs.color, stroke: p && getComputedStyle(p).stroke,
    font: document.fonts.check(`italic 400 ${cs.fontSize} "Reason Wordmark"`) && [...document.fonts].some(f => f.family.includes("Reason Wordmark") && f.status === "loaded"),
    firstIn: !!first && w.contains(first),
    oldDot: !!bar.querySelector(":scope > .dot, .brand > .dot"),
  };
};
try {
  let ref = null;
  if (site) {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await p.goto("https://heyreason.com/", { waitUntil: "networkidle" });
    await p.evaluate(() => document.fonts.ready);
    // Site v4 (10-27) renamed the nav mark `.nav-mark` → `a.wordmark` (href="#top"); try both.
    ref = await p.evaluate(() => { const m = document.querySelector("a.wordmark, .nav-mark"); if (!m) return null; const r = m.getBoundingClientRect(), o = m.querySelector("svg").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(o.width * 10) / 10 + "×" + Math.round(o.height * 10) / 10, fs: getComputedStyle(m).fontSize }; });
    if (!ref) throw new Error("no a.wordmark (or .nav-mark) on https://heyreason.com/ — the site's nav mark moved again");
    console.log(`site wordmark at 1280: ${ref.w}px wide, bubble ${ref.h}px, ${ref.fs} type`);
    await p.close();
  }
  for (const scheme of ["light", "dark"]) for (const [name, make, intro] of pages) for (const w of [390, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: w < 1000, hasTouch: w < 1000, deviceScaleFactor: 2, colorScheme: scheme });
    const p = await ctx.newPage();
    await p.setContent(html(make()));
    if (intro) await p.waitForFunction(() => !document.documentElement.dataset.intro, null, { timeout: 6000 });
    await p.evaluate(() => document.fonts.ready);
    const m = await p.evaluate(measure);
    const ink = scheme === "light" ? "rgb(42, 37, 32)" : "rgb(243, 239, 232)";
    const why = m.missing ? ["no .wordmark"] : [
      m.text !== "reason" && `text "${m.text}"`, Math.abs(m.l - m.inL) > 1 && `left ${m.l}, line starts ${m.inL}`, m.t > 60 && `top ${m.t}`, m.fs !== "21.6px" && `size ${m.fs}`,
      m.color !== ink && `colour ${m.color}`, m.stroke !== (scheme === "light" ? "rgb(156, 59, 46)" : "rgb(212, 106, 92)") && `bubble ${m.stroke}`, !m.font && "font not loaded",
      !m.firstIn && "not the first thing", m.oldDot && "old dot still there",
      ref && w === 1280 && (m.w !== ref.w || m.o !== ref.h || m.fs !== ref.fs) && `${m.w}px wide, bubble ${m.o} vs site ${ref.w}px, ${ref.h}`,
    ].filter(Boolean);
    if (why.length) fails++;
    console.log(`${why.length ? "FAIL" : "ok  "} ${scheme} ${name} ${w}px${m.missing ? "" : ` — at ${m.l},${m.t} ${m.w}×${m.h}`}${why.length ? ` — ${why.join(", ")}` : ""}`);
    if (shot && scheme === "light" && name === "event join" && w === 390) await p.screenshot({ path: shot });
    await ctx.close();
  }
} finally { await b.close(); }
process.exit(fails ? 1 : 0);
