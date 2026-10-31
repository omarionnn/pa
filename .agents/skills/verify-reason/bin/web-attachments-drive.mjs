#!/usr/bin/env node
// Drive Reason Web's attachment viewer (src/pages/webviewer.js, src/pages/webcompose.js, the HEIC → JPEG
// view in src/webmedia.js) over REAL HTTP in real browsers: src/http.js createServer on a loopback port,
// history rows stored the way live stores them (photos texted in from a CDN, a HEIC and a JPEG sent from
// Web, a screenshot, a PDF, a .docx, a text file and a video), read back through /web?thread. The CDN is a
// stand-in inside this process. No model is called, nothing is texted.
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/web.db node .agents/skills/verify-reason/bin/web-attachments-drive.mjs [--shots=DIR] [--before]
//
// Runs in WebKit (iPhone, 390 wide, touch) and Google Chrome (desktop 1280, and phone 390), light and
// night. --shots=DIR saves the screenshots. --before only taps a photo and saves what happens (for a
// tree without the viewer). Prints one line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "http://127.0.0.1";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ ||= "America/New_York";
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
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
const shots = process.argv.find(a => a.startsWith("--shots="))?.slice(8) || "";
const before = process.argv.includes("--before");

const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { execFileSync } = await import("node:child_process");
const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Runtime } = await imp("src/runtime.js");
const { Router } = await imp("src/channels/router.js");
const { createServer } = await imp("src/http.js");
const { config } = await imp("src/config.js");
const db = await imp("src/db.js");
const uploads = await imp("src/webuploads.js");

// ---------------------------------------------------------------- real pictures, a PDF, a video
const work = join(process.env.REASON_DATA_DIR, "drive-src");
mkdirSync(work, { recursive: true });
const SRC = "/System/Library/CoreServices/DefaultDesktop.heic";
if (!existsSync("/usr/bin/sips") || !existsSync(SRC)) { console.error("refusing: needs macOS sips and its default wallpaper"); process.exit(2); }
const sips = (...a) => execFileSync("/usr/bin/sips", a, { stdio: "ignore" });
const wide = join(work, "wide.jpg"); sips("-s", "format", "jpeg", "-Z", "1600", SRC, "--out", wide);
const tall = join(work, "tall.jpg"); sips("-s", "format", "jpeg", "-c", "2000", "1300", SRC, "--out", tall); sips("-Z", "1400", tall);
const heic = join(work, "phone.heic"); sips("-s", "format", "heic", "-Z", "1400", "-c", "780", "1040", SRC, "--out", heic);
const shotPng = join(work, "shot.png"); sips("-s", "format", "png", "-Z", "900", "-c", "1600", "1600", SRC, "--out", shotPng);
const pdf = join(work, "lease.pdf"); sips("-s", "format", "pdf", "-Z", "900", wide, "--out", pdf);
let video = null;
try {
  const ff = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", join(process.env.HOME, ".local/bin/ffmpeg"), "/usr/bin/ffmpeg"].find(existsSync);
  if (ff) { video = join(work, "clip.mp4"); execFileSync(ff, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", video], { stdio: "ignore" }); }
} catch { video = null; }
const bytes = { wide: readFileSync(wide), tall: readFileSync(tall), heic: readFileSync(heic) };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith("https://cdn.drive.example/")) {
    const f = u.endsWith("tall.jpg") ? bytes.tall : u.endsWith(".mp4") && video ? readFileSync(video) : bytes.wide;
    return new Response(f, { status: 200, headers: { "content-type": u.endsWith(".mp4") ? "video/mp4" : "image/jpeg", "content-length": String(f.length) } });
  }
  return realFetch(url, opts);
};

// ---------------------------------------------------------------- rows, as live stores them
const KOFI_C = "dm:fake:+14155559876", AMA_C = "dm:fake:+13475550000";
for (const [c, a, n] of [[KOFI_C, "+14155559876", "Kofi"], [AMA_C, "+13475550000", "Ama"]]) {
  db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n });
  db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
}
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1, web_notice_seen_at = 1");
let seq = 0;
const at0 = Date.now() - 40 * 60_000;
const said = (c, role, text, media = [], { channel = "sendblue", outboxId = null } = {}) => db.writeMessage({ conversationId: c, role, channel, externalId: role === "user" ? (channel === "web" ? `${c}:d${++seq}` : `e${++seq}`) : null, outboxId, text, media, at: at0 + (++seq) * 60_000 });
const lastRow = () => db.db.prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get().id;
const sent = (c, file, filename, mime, text) => {
  const dest = join(config.documentRoot, `drv${++seq}-${filename}`);
  mkdirSync(config.documentRoot, { recursive: true });
  writeFileSync(dest, typeof file === "string" ? readFileSync(file) : file);
  const ob = db.enqueueOutbound({ idemKey: `k${++seq}`, conversationId: c, channel: "fake", address: "+1", body: text, media: { file: dest, mimeType: mime, filename } }).row.id;
  said(c, "assistant", text, [{ kind: "file", mimeType: mime, filename }], { outboxId: ob });
  return lastRow();
};
const up = (c, buf, name) => { const m = uploads.store({ conversationId: c, bytes: buf, name }); if (!m.id) throw new Error(JSON.stringify(m)); return { url: uploads.uploadUrl(m.id, m.name), filename: m.name, kind: "image", web_upload: m.id }; };

said(KOFI_C, "user", "found two places near the park, which one", [
  { url: "https://cdn.drive.example/a/wide.jpg", filename: "wide.jpg", kind: "image" },
  { url: "https://cdn.drive.example/a/tall.jpg", filename: "tall.jpg", kind: "image" },
]);
const twoRow = lastRow();
said(KOFI_C, "assistant", "The first one: closer to the subway and the light is better. The second has no laundry in the building.");
said(KOFI_C, "user", "this is the view from the bedroom", [up(KOFI_C, bytes.heic, "IMG_4012.HEIC")], { channel: "web" });
const heicRow = lastRow();
const shotRow = sent(KOFI_C, shotPng, "listing-screenshot.png", "image/png", "Here's the listing as it looks right now.");
const pdfRow = sent(KOFI_C, pdf, "lease-draft.pdf", "application/pdf", "The lease, marked where the fees are.");
const docRow = sent(KOFI_C, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(12511, 7)]), "questions-for-the-broker.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "And the questions to ask the broker, as a doc.");
const txtRow = sent(KOFI_C, Buffer.from("Questions for the broker\n\n1. Is the broker fee negotiable?\n2. When was the boiler last serviced?\n3. Is laundry in the building or nearby?\n"), "broker-questions.txt", "text/plain", "Same list as plain text.");
let vidRow = null;
if (video) { said(KOFI_C, "user", "and a walkthrough", [{ url: "https://cdn.drive.example/v/IMG_0007.mp4", filename: "IMG_0007.mp4", kind: "video" }]); vidRow = lastRow(); }
said(KOFI_C, "user", "and the kitchen", [up(KOFI_C, bytes.wide, "kitchen.jpg")], { channel: "web" });
const kitchenRow = lastRow();

const router = new Router({});
const runtime = new Runtime({ channels: router, deliver: async () => {}, runTurn: async () => "ok" });
router.runtime = runtime;
const server = createServer({ router, runtime });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const signIn = (c) => { const t = `drive-${Math.random().toString(36).slice(2)}`; db.startPageSession(`wsign:${c}`, t, { conversationId: c }); return { cookie: `reason_page=${t}`, token: t }; };
const get = async (b, path) => {
  const r = await realFetch(`${BASE}${path}`, { headers: { origin: BASE, "sec-fetch-site": "same-origin", ...(b ? { cookie: b.cookie } : {}) } });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};
const kofi = signIn(KOFI_C), ama = signIn(AMA_C);

try {
  if (!before) {
    // The addresses themselves, as a download or a direct visit still gets them.
    const d = await get(kofi, `/web/media/m/${twoRow}/0`);
    step("direct visit to /web/media/m/<row>/0 by its owner → 200 image/jpeg, nosniff", d.status === 200 && d.headers.get("content-type") === "image/jpeg" && d.headers.get("x-content-type-options") === "nosniff", `${d.status} ${d.headers.get("content-type")}`);
    const codes = await Promise.all([[null, `/web/media/m/${twoRow}/0`], [ama, `/web/media/m/${twoRow}/0`], [{ cookie: "reason_page=nope" }, `/web/media/m/${docRow}/0`]].map(([b, p]) => get(b, p).then(x => x.status)));
    step("signed out, another person, a made-up cookie → 404", codes.every(s => s === 404), codes.join(","));
    const page = (await get(kofi, "/web?thread")).bytes.toString();
    const heicHref = /<a class="photo" href="([^"]+)"[^>]*data-src="([^"]+)"[^>]*data-name="IMG_4012\.heic"/i.exec(page);
    step("the HEIC's thumbnail and viewer use ?as=jpeg; the link is the original", !!heicHref && heicHref[2] === `${heicHref[1]}?as=jpeg`, heicHref?.[2]);
    const hj = heicHref ? await get(kofi, heicHref[2]) : null;
    step("…?as=jpeg → 200 image/jpeg (converted on this machine)", hj?.status === 200 && hj.headers.get("content-type") === "image/jpeg" && hj.bytes[0] === 0xff && hj.bytes[1] === 0xd8, `${hj?.status} ${hj?.headers.get("content-type")} ${hj?.bytes.length} B`);
    const ho = heicHref ? await get(kofi, heicHref[1]) : null;
    step("…the plain address still gives the HEIC", ho?.headers.get("content-type") === "image/heic", ho?.headers.get("content-type"));
    step("…Ama asking for it → 404", heicHref ? (await get(ama, heicHref[2])).status === 404 : false);
  }

  if (shots) mkdirSync(shots, { recursive: true });
  const { webkit, chromium } = await import("playwright");
  const host = new URL(BASE).hostname;
  const runs = [
    ["iphone", webkit, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: false, hasTouch: true }],
    ["desktop", chromium, { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }, { channel: "chrome" }],
    ["chrome-phone", chromium, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, { channel: "chrome" }],
  ];
  for (const [name, type, ctxOpts, launch = {}] of runs) {
    const browser = await type.launch({ headless: true, ...launch });
    for (const theme of before ? ["light"] : ["light", "night"]) {
      const ctx = await browser.newContext({ ...ctxOpts, colorScheme: theme === "night" ? "dark" : "light" });
      await ctx.addCookies([{ name: "reason_page", value: kofi.token, domain: host, path: "/" }]);
      await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch { /* fine */ } });
      const pg = await ctx.newPage();
      const errs = []; pg.on("pageerror", e => errs.push(String(e))); pg.on("console", m => { if (m.type() === "error" && !/favicon|Failed to load resource|Button failed to load, iconName/.test(m.text())) errs.push(m.text()); });
      await pg.goto(`${BASE}/web?thread`, { waitUntil: "load" });
      const sh = (f) => shots ? pg.screenshot({ path: join(shots, `${before ? "before" : "after"}-${name}-${theme}-${f}.png`) }) : null;
      const first = pg.locator(`#m-${twoRow} .photo`).first();
      await first.scrollIntoViewIfNeeded();
      await pg.waitForTimeout(500);
      if (before) {
        await sh("1-thread");
        await first.click();
        await pg.waitForTimeout(1200);
        const pages = ctx.pages();
        const now = pages[pages.length - 1];
        console.log(`before ${name}: after a tap the ${pages.length > 1 ? "new tab" : "tab"} is at ${now.url().replace(BASE, "")}`);
        if (shots) await now.screenshot({ path: join(shots, `before-${name}-light-2-tapped.png`) });
        await ctx.close();
        continue;
      }
      // ---- the thread: thumbnails loaded, framed to their shape ----
      await pg.evaluate(() => Promise.all([...document.querySelectorAll(".msg .photo img")].map(i => { i.loading = "eager"; return i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }); })));
      await pg.waitForTimeout(300);
      const thumbs = await pg.$$eval(".msg .photo", ps => ps.map(p => ({ w: p.offsetWidth, h: p.offsetHeight, ok: !!p.querySelector("img")?.naturalWidth, cls: p.className })));
      step(`${name}/${theme}: every thumbnail loads (HEIC too)`, thumbs.length >= 5 && thumbs.every(t => t.ok && !/\bbad\b|\bld\b/.test(t.cls)), JSON.stringify(thumbs.map(t => t.ok)));
      const [w0, w1] = thumbs;
      step(`${name}/${theme}: a wide photo's frame is wider than a tall one's, same height`, w0.w > w1.w && w0.h === w1.h, `${w0.w}x${w0.h} vs ${w1.w}x${w1.h}`);
      await pg.evaluate(() => window.scrollBy(0, -120));
      await sh("1-thread");
      // ---- a photo opens in the viewer, the tab stays put ----
      const url0 = pg.url();
      await first.click();
      await pg.waitForSelector(".vw.on:not([hidden])", { timeout: 4000 }).catch(() => {});
      await pg.waitForFunction(() => { const i = document.querySelector(".vw .vw-img"); return i && i.complete && i.naturalWidth > 0 && !document.querySelector(".vw.wait"); }, null, { timeout: 6000 }).catch(() => {});
      const v = await pg.evaluate(() => { const vw = document.querySelector(".vw"); const i = vw?.querySelector(".vw-img"); const r = i?.getBoundingClientRect();
        return { open: !!vw && !vw.hidden, img: i?.naturalWidth || 0, n: vw?.querySelector(".vw-n")?.textContent, what: vw?.querySelector(".vw-what")?.textContent, focus: document.activeElement?.className, dl: vw?.querySelector(".vw-dl")?.getAttribute("href"), inView: r ? r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight : false, cx: r ? Math.abs((r.left + r.right) / 2 - innerWidth / 2) : 99, mainInert: !!document.querySelector("main,.convo")?.closest("[inert]"), role: vw?.getAttribute("role"), modal: vw?.getAttribute("aria-modal") }; });
      await pg.waitForFunction(() => getComputedStyle(document.querySelector(".vw")).opacity === "1", null, { timeout: 3000 }).catch(() => {});
      const op = await pg.evaluate(() => { const vw = document.querySelector(".vw"), r = vw.getBoundingClientRect(); return { o: getComputedStyle(vw).opacity, z: getComputedStyle(vw).zIndex, r: [r.width, r.height], top: document.elementFromPoint(innerWidth / 2, 30)?.className }; });
      step(`${name}/${theme}: the viewer is fully drawn on top of the page`, op.o === "1" && /vw/.test(String(op.top)), JSON.stringify(op));
      step(`${name}/${theme}: tapping a photo opens the viewer, the tab stays on the thread`, v.open && pg.url() === url0 && ctx.pages().length === 1, pg.url().replace(BASE, ""));
      step(`${name}/${theme}: the photo is drawn, whole, centred`, v.img > 0 && v.inView && v.cx < 4, `nw ${v.img}, inView ${v.inView}, off-centre ${v.cx?.toFixed(1)}`);
      step(`${name}/${theme}: dialog, modal, the thread behind it inert, focus on Close`, v.role === "dialog" && v.modal === "true" && v.mainInert && v.focus === "vw-x");
      step(`${name}/${theme}: eyebrow says photo · who · when; counter; download is the original`, /^PHOTO · YOU · /.test(v.what ?? "") && /^1 OF \d+$/.test(v.n ?? "") && v.dl === `/web/media/m/${twoRow}/0`, `${v.what} | ${v.n} | ${v.dl}`);
      const tgt = await pg.$$eval(".vw button:not([hidden]), .vw a:not([hidden])", es => es.filter(e => e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.width), Math.round(r.height)]; }));
      step(`${name}/${theme}: every control is at least 44×44`, tgt.every(([, w, h]) => w >= 44 && h >= 44), JSON.stringify(tgt));
      await sh("2-photo");
      // ---- next, across the message and the thread ----
      if (name === "desktop") await pg.keyboard.press("ArrowRight"); else await pg.locator(".vw-next").click();
      await pg.waitForTimeout(350);
      const n2 = await pg.locator(".vw-n").textContent();
      step(`${name}/${theme}: next goes to the second photo of the message`, /^2 OF /.test(n2), n2);
      if (name !== "desktop") await sh("3-second");
      if (name === "desktop") await pg.keyboard.press("ArrowRight"); else await pg.locator(".vw-next").click();
      await pg.waitForFunction(() => { const i = document.querySelector(".vw .vw-img"); return i && i.naturalWidth > 0 && !document.querySelector(".vw.wait"); }, null, { timeout: 8000 }).catch(() => {});
      const h = await pg.evaluate(() => ({ n: document.querySelector(".vw-n")?.textContent, src: document.querySelector(".vw-img")?.getAttribute("src"), nw: document.querySelector(".vw-img")?.naturalWidth, cap: document.querySelector(".vw-cap")?.textContent }));
      step(`${name}/${theme}: …and on into the next message: the HEIC, drawn (as its JPEG) with its words`, /^3 OF /.test(h.n) && /as=jpeg$/.test(h.src) && h.nw > 0 && h.cap === "this is the view from the bedroom", JSON.stringify(h));
      await sh("4-heic");
      // ---- Esc closes, focus goes back ----
      if (name === "desktop") {
        await pg.keyboard.press("Escape");
        await pg.waitForTimeout(300);
        const c = await pg.evaluate(() => ({ hidden: document.querySelector(".vw").hidden, focus: document.activeElement?.className, inert: !!document.querySelector("[inert]:not(.addsheet)"), viewing: document.body.classList.contains("viewing") }));
        step(`${name}/${theme}: Esc closes; focus is back on the photo; nothing left inert`, c.hidden && /photo/.test(c.focus) && !c.inert && !c.viewing, JSON.stringify(c));
        // Tab stays inside.
        await first.click(); await pg.waitForTimeout(250);
        const seen = new Set(); for (let i = 0; i < 9; i++) { await pg.keyboard.press("Tab"); seen.add(await pg.evaluate(() => !!document.activeElement?.closest(".vw"))); }
        step(`${name}/${theme}: Tab never leaves the viewer`, seen.size === 1 && seen.has(true));
        // A click beside the photo closes it.
        await pg.mouse.click(30, 430); await pg.waitForTimeout(300);
        step(`${name}/${theme}: a click on the backdrop closes it`, await pg.evaluate(() => document.querySelector(".vw").hidden));
      } else {
        // A swipe down closes it (touch pointer events, as a finger makes them).
        await pg.evaluate(async () => {
          const s = document.querySelector(".vw-stage"), r = s.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          const ev = (t, dy) => s.dispatchEvent(new PointerEvent(t, { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, clientX: x, clientY: y + dy }));
          ev("pointerdown", 0); for (let dy = 20; dy <= 180; dy += 20) { ev("pointermove", dy); await new Promise(r => setTimeout(r, 16)); } ev("pointerup", 180);
        });
        await pg.waitForTimeout(350);
        const c = await pg.evaluate(() => ({ hidden: document.querySelector(".vw").hidden, focus: document.activeElement?.className }));
        step(`${name}/${theme}: a swipe down closes it; focus back on the photo`, c.hidden && /photo/.test(c.focus), JSON.stringify(c));
        // A swipe sideways walks.
        await first.click(); await pg.waitForTimeout(300);
        await pg.evaluate(async () => {
          const s = document.querySelector(".vw-stage"), r = s.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          const ev = (t, dx) => s.dispatchEvent(new PointerEvent(t, { pointerId: 8, pointerType: "touch", isPrimary: true, bubbles: true, clientX: x + dx, clientY: y }));
          ev("pointerdown", 0); for (let dx = -20; dx >= -140; dx -= 20) { ev("pointermove", dx); await new Promise(r => setTimeout(r, 16)); } ev("pointerup", -140);
        });
        await pg.waitForTimeout(300);
        step(`${name}/${theme}: a swipe left goes to the next photo`, /^2 OF /.test(await pg.locator(".vw-n").textContent()));
        await pg.locator(".vw-x").click(); await pg.waitForTimeout(300);
        step(`${name}/${theme}: × closes it`, await pg.evaluate(() => document.querySelector(".vw").hidden));
      }
      // ---- the screenshot Reason sent: a photo now, that opens ----
      await pg.locator(`#m-${shotRow} .photo`).click(); await pg.waitForTimeout(500);
      step(`${name}/${theme}: a screenshot Reason sent opens in the viewer`, await pg.evaluate(() => !document.querySelector(".vw").hidden && document.querySelector(".vw-img")?.naturalWidth > 0 && /REASON/.test(document.querySelector(".vw-what").textContent)));
      await pg.keyboard.press("Escape"); await pg.waitForTimeout(250);
      // ---- a PDF previews ----
      await pg.locator(`#m-${pdfRow} a.fchip`).click(); await pg.waitForTimeout(1500);
      const p = await pg.evaluate(() => ({ open: !document.querySelector(".vw").hidden, frame: document.querySelector(".vw-doc")?.getAttribute("src"), openLink: !document.querySelector(".vw-open").hidden, cap: document.querySelector(".vw-cap").textContent, url: location.pathname }));
      step(`${name}/${theme}: a PDF opens in the viewer (framed), with Open in a new tab and Download`, p.open && p.frame === `/web/media/m/${pdfRow}/0` && p.openLink && p.cap === "lease-draft.pdf" && p.url === "/web", JSON.stringify(p));
      await sh("5-pdf");
      await pg.keyboard.press("Escape"); await pg.waitForTimeout(250);
      // ---- a .docx is a card with Download ----
      await pg.locator(`#m-${docRow} a.fchip`).click(); await pg.waitForTimeout(400);
      const dc = await pg.evaluate(() => ({ name: document.querySelector(".vw-cn")?.textContent, facts: document.querySelector(".vw-cf")?.textContent, get: document.querySelector(".vw-get")?.getAttribute("href"), dl: document.querySelector(".vw-get")?.getAttribute("download") }));
      step(`${name}/${theme}: a .docx is a file card: name, DOCX · 12 KB, Download`, dc.name === "questions-for-the-broker.docx" && dc.facts === "DOCX · 12 KB" && dc.get === `/web/media/m/${docRow}/0` && dc.dl === "questions-for-the-broker.docx", JSON.stringify(dc));
      await sh("6-docx");
      await pg.keyboard.press("Escape"); await pg.waitForTimeout(250);
      // ---- a text file reads ----
      await pg.locator(`#m-${txtRow} a.fchip`).click();
      await pg.waitForSelector(".vw-text", { timeout: 4000 }).catch(() => {});
      step(`${name}/${theme}: a text file reads in the viewer`, /broker fee negotiable/.test(await pg.evaluate(() => document.querySelector(".vw-text")?.textContent ?? "")));
      if (name === "iphone") await sh("7-text");
      await pg.keyboard.press("Escape"); await pg.waitForTimeout(250);
      // ---- a video plays ----
      if (vidRow) {
        await pg.locator(`#m-${vidRow} a.fchip`).click();
        await pg.waitForFunction(() => document.querySelector(".vw-video")?.readyState >= 1 || document.querySelector(".vw-card"), null, { timeout: 8000 }).catch(() => {});
        const vv = await pg.evaluate(() => ({ ready: document.querySelector(".vw-video")?.readyState ?? -1, card: !!document.querySelector(".vw-card") }));
        // Headless Chromium-without-codecs shows the card; Chrome and WebKit play H.264.
        step(`${name}/${theme}: a video opens in the viewer and loads (or a card says it can't)`, vv.ready >= 1 || vv.card, JSON.stringify(vv));
        if (name === "desktop") await sh("8-video");
        await pg.keyboard.press("Escape"); await pg.waitForTimeout(250);
      }
      // ---- the browser's back button closes the viewer, not the page ----
      await pg.locator(`#m-${kitchenRow} .photo`).click(); await pg.waitForTimeout(300);
      await pg.goBack(); await pg.waitForTimeout(400);
      step(`${name}/${theme}: Back closes the viewer and stays on the thread`, await pg.evaluate(() => document.querySelector(".vw").hidden && location.pathname === "/web") );
      // ---- ⌘/Ctrl-click still opens the file itself in a new tab ----
      if (name === "desktop" && theme === "light") {
        const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 4000 }).catch(() => null), pg.locator(`#m-${kitchenRow} .photo`).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] })]);
        step(`${name}/${theme}: ⌘-click opens the photo's own address in a new tab`, !!tab && /\/web\/media\/u\//.test(tab.url()), tab?.url().replace(BASE, ""));
        if (tab) await tab.close();
      }
      step(`${name}/${theme}: no script errors`, errs.length === 0, errs.slice(0, 3).join(" | "));
      await ctx.close();
    }
    // Reduced motion: it opens and closes at once.
    if (!before && name === "iphone") {
      const ctx = await browser.newContext({ ...ctxOpts, reducedMotion: "reduce" });
      await ctx.addCookies([{ name: "reason_page", value: kofi.token, domain: host, path: "/" }]);
      await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch { /* fine */ } });
      const pg = await ctx.newPage();
      await pg.goto(`${BASE}/web?thread`, { waitUntil: "load" });
      await pg.locator(`#m-${twoRow} .photo`).first().click();
      const t = await pg.evaluate(() => getComputedStyle(document.querySelector(".vw")).transitionDuration);
      await pg.locator(".vw-x").click();
      step(`${name}: reduced motion — no transition, closes at once`, /^0s/.test(t) && await pg.evaluate(() => document.querySelector(".vw").hidden), t);
      await ctx.close();
    }
    await browser.close();
  }
  if (shots) console.log(`shots in ${shots}`);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
