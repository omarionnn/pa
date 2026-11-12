#!/usr/bin/env node
// Text contrast against the pixels it actually sits on, for pages with a gradient ground (the paper
// glow, src/pages/brand.js PAPER_GLOW / NIGHT_GLOW). theme-all.mjs reads backgroundColor only, so it
// cannot see a glow; this one paints the page with every text made transparent, screenshots it, and
// samples a grid of points under each visible text box. It does this at several scroll positions
// (the site's glow is fixed to the screen, so text moves through it) and reports the worst ratio.
//
//   node .agents/skills/verify-reason/bin/glow-contrast.mjs <url> [<url>…] [--min 4.5] [--widths 390,1440]
//   (url may be http(s):// or a local file; both colour schemes are checked; --pages checks Reason's
//    event, sign-in, files and spotify pages rendered in process.)
//
// One `ok`/`FAIL` line per url × width × scheme; FAIL lists the worst offenders. Exits non-zero on any FAIL.
const { createRequire } = await import("node:module");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createServer } = await import("node:http");
const root = new URL("../../../../", import.meta.url);
const { chromium } = createRequire(new URL("package.json", root))("playwright");

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MIN = Number(opt("--min", "4.5"));
const widths = opt("--widths", "390,1440").split(",").map(Number);
const urls = args.filter((a, i) => !a.startsWith("--") && !["--min", "--widths", "--schemes"].includes(args[i - 1]));

let server;
if (args.includes("--pages")) {
  process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "glow-")), "x.db");
  for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];
  const mod = (p) => import(new URL(p, root));
  const ev = await mod("src/pages/event.js"), render = await mod("src/pages/render.js");
  const spotify = await mod("src/spotify.js"), remote = await mod("src/signin-remote.js");
  const e = { id: 1, public_id: "abcdEFGH12345678", name: "Game Night", place: "Somewhere", description: "Board games", guest_list_visible: 1, organizer_token: "x", status: "active", organizer_conversation_id: "console:x" };
  const body = (r) => (typeof r === "string" ? r : r.body);
  const pages = {
    "event-join": () => ev.renderJoin({ ev: e }),
    "event-signin": () => ev.renderSignin({ ev: e, number: "+1 555 123 4567" }),
    "files-page": () => render.renderPage({ id: 1, title: "Coffee at home", subtitle: "", created_at: Date.now(), blocks: [{ type: "text", text: "Beans, grind, water." }] }, { forName: "Omari" }),
    "not-found": () => render.renderNotFound(),
    "spotify-join": () => spotify.joinPage({ token: "t" }),
    "remote-signin": () => remote.shell("Sign in to Uber", '<h1>Sign in</h1><p class="lead">Opening Uber…</p>'),
  };
  const served = Object.fromEntries(Object.entries(pages).map(([k, f]) => [k, body(f())]));
  server = createServer((req, res) => { const b = served[req.url.slice(1)]; res.writeHead(b ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" }); res.end(b ?? ""); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  for (const k of Object.keys(pages)) urls.push(`http://127.0.0.1:${server.address().port}/${k}`);
}

// In the page: every visible text box with its colour, then (after the text is hidden) the worst pixel under it.
const boxes = () => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement, s = getComputedStyle(el);
    if (s.visibility !== "visible" || +s.opacity === 0 || el.closest("[hidden],[aria-hidden=true],svg")) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const b of r.getClientRects()) {
      if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
      out.push({ t: n.textContent.trim().slice(0, 40), c: s.color, x: b.left, y: b.top, w: b.width, h: b.height });
    }
  }
  return out;
};
const worst = async ({ png, list, min }) => {
  const img = new Image(); img.src = "data:image/png;base64," + png; await img.decode();
  const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
  const k = img.width / innerWidth;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, gg, b]) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
  const bad = []; let low = 99;
  for (const b of list) {
    const m = b.c.match(/[\d.]+/g).map(Number); if ((m[3] ?? 1) < 0.2) continue;
    let r = 99;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) {
      const x = Math.min(img.width - 1, Math.max(0, Math.round((b.x + (b.w * (i + 0.5)) / 5) * k)));
      const y = Math.min(img.height - 1, Math.max(0, Math.round((b.y + (b.h * (j + 0.5)) / 3) * k)));
      const p = g.getImageData(x, y, 1, 1).data;
      const a = m[3] ?? 1, fg = [m[0] * a + p[0] * (1 - a), m[1] * a + p[1] * (1 - a), m[2] * a + p[2] * (1 - a)];
      const [hi, lo] = [lum(fg), lum(p)].sort((q, z) => z - q); r = Math.min(r, (hi + 0.05) / (lo + 0.05));
    }
    low = Math.min(low, r);
    if (r < min) bad.push(`"${b.t}" ${r.toFixed(2)}`);
  }
  return { bad, low };
};

let fails = 0;
const br = await chromium.launch();
try {
  for (const url of urls) for (const width of widths) for (const scheme of (opt("--schemes", "light,dark")).split(",")) {
    const ctx = await br.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: "networkidle" }).catch(() => p.goto(url));
    await p.evaluate(() => document.documentElement.removeAttribute("data-intro"));
    await p.waitForTimeout(400);
    const H = await p.evaluate(() => document.documentElement.scrollHeight), vh = width < 700 ? 844 : 900;
    const bad = new Set(); let low = 99;
    for (let y = 0; y < H; y += Math.round(vh / 2)) {
      await p.evaluate((yy) => scrollTo(0, yy), y); await p.waitForTimeout(80);
      const list = await p.evaluate(boxes);
      const st = await p.addStyleTag({ content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;text-decoration-color:transparent!important}" });
      const png = (await p.screenshot()).toString("base64");
      await st.evaluate((n) => n.remove());
      const r = await p.evaluate(worst, { png, list, min: MIN });
      r.bad.forEach((x) => bad.add(x)); low = Math.min(low, r.low);
      if (y + vh >= H) break;
    }
    if (bad.size) fails++;
    console.log(`${bad.size ? "FAIL" : "ok  "} ${url.replace(/^https?:\/\/[^/]+/, "")} ${width}px ${scheme} worst ${low.toFixed(2)}${bad.size ? ` — ${[...bad].slice(0, args.includes("--all") ? 1e9 : 6).join(" | ")}` : ""}`);
    await ctx.close();
  }
} finally { await br.close(); server?.close(); }
process.exit(fails ? 1 : 0);
