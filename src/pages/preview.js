// The animated link preview for a generated page.
//
// When Reason texts someone a link, iMessage shows a preview card. Until now that was a static
// picture (card.png). This makes it move: the first few lines of the page's own content type
// themselves out in a short loop, inside a Messages-like bubble, so the person sees their own
// result before they tap.
//
// The pattern follows make-og-video.mjs from the Reason site: Playwright screenshots an HTML
// template frame by frame, ffmpeg turns those into a looping mp4. The mp4 is cached on disk
// beside the card.png and served at /p/{id}/preview.mp4 by http.js; render.js adds og:video
// tags pointing there.
//
// Privacy: only the title and the first text block are shown. No names of other people, no
// amounts, no health details. The previewText function decides what is safe to type.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { config } from "../config.js";
import { esc, GROUND } from "./render.js";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { checkAccess, readCookie } from "./access.js";
import { renderNotFound } from "./render.js";

const FFMPEG = existsSync(join(homedir(), ".local/bin/ffmpeg"))
  ? join(homedir(), ".local/bin/ffmpeg") : "ffmpeg";

const W = 1200, H = 630, FPS = 30;
const CHAR_MS = 38;
const HOLD_MS = 2400;
const FADE_MS = 400;
export const RENDER_TIMEOUT_MS = Number(process.env.REASON_PREVIEW_TIMEOUT_MS || 25_000);

export function previewPath(page) {
  return join(config.dataDir, "cards", `${page.id}-r${page.revision ?? 1}-preview.mp4`);
}

export function previewText(page) {
  const title = String(page.title ?? "").trim();
  if (!title) return null;
  const blocks = page.blocks ?? [];
  const sections = [];
  for (let i = 0; i < blocks.length && sections.length < 3; i++) {
    const b = blocks[i];
    if (b.type === "section" && b.title) {
      let snippet = "";
      for (let j = i + 1; j < blocks.length && j < i + 3; j++) {
        const n = blocks[j];
        if (n.type === "text" && n.text) { snippet = n.text; break; }
        if (n.type === "callout" && n.text) { snippet = n.text; break; }
        if (n.type === "steps" && n.items?.length) {
          const s = n.items[0];
          snippet = typeof s === "string" ? s : s?.text ?? "";
          break;
        }
      }
      snippet = snippet.replace(/\s+/g, " ").trim();
      if (snippet.length > 70) snippet = snippet.slice(0, 67).replace(/\s+\S*$/, "") + "…";
      sections.push({ heading: b.title, snippet });
    }
  }
  if (!sections.length) {
    const first = blocks.find(b => b.type === "text" && String(b.text ?? "").trim());
    if (first) {
      let t = first.text.replace(/\s+/g, " ").trim();
      if (t.length > 70) t = t.slice(0, 67).replace(/\s+\S*$/, "") + "…";
      sections.push({ heading: "", snippet: t });
    }
  }
  return { title, sections };
}

function previewHtml(title, sections) {
  const ground = GROUND.light;
  const ink = "#1c1915";
  const dim = "#6f675d";
  const mark = "#ff5a3c";
  const serif = 'ui-serif,"New York","Iowan Old Style",Georgia,serif';
  const sans = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:${ground};overflow:hidden}
.page{width:${W}px;height:${H}px;padding:56px 80px}
.mark{font:500 15px/1 ${sans};color:${dim};margin-bottom:28px;opacity:0}
.mark span{color:${mark};font-size:18px;vertical-align:-1px;margin-right:4px}
h1{font:400 42px/1.08 ${serif};color:${ink};letter-spacing:-.025em;margin-bottom:20px;opacity:0}
.sect{margin-top:18px;opacity:0}
h2{font:400 22px/1.15 ${serif};color:${ink};letter-spacing:-.02em;margin-bottom:4px}
p{font:400 15.5px/1.4 ${sans};color:${dim}}
.cursor{display:inline-block;width:2px;height:1em;background:${ink};vertical-align:text-bottom;animation:blink 1s step-end infinite}
.cursor.dim{background:${dim}}
@keyframes blink{50%{opacity:0}}
</style></head><body>
<div class="page">
<div class="mark" id="mark"><span>●</span> Reason</div>
<h1 id="title"></h1>
${sections.map((_, i) => `<div class="sect" id="s${i}"><h2 id="h${i}"></h2><p id="p${i}"></p></div>`).join("\n")}
</div>
<script>
const TITLE=${JSON.stringify(esc(title))};
const SECTS=${JSON.stringify(sections.map(s => ({ h: esc(s.heading), p: esc(s.snippet) })))};
const CHAR_MS=${CHAR_MS};
const HOLD_MS=${HOLD_MS};
const FADE_MS=${FADE_MS};
const PAUSE=250;

let totalChars=TITLE.length;
SECTS.forEach(s=>{totalChars+=s.h.length+s.p.length});
const TOTAL_MS=200+TITLE.length*CHAR_MS+PAUSE+SECTS.length*(PAUSE)+totalChars*CHAR_MS+HOLD_MS+FADE_MS;
window.PERIOD=TOTAL_MS/1000;

window.setFrame=function(t){
  const ms=((t*1000)%TOTAL_MS+TOTAL_MS)%TOTAL_MS;
  let at=0;
  // mark fades in
  document.getElementById('mark').style.opacity=ms>100?1:0;
  at+=200;
  // title types
  const tc=Math.max(0,Math.min(TITLE.length,Math.floor((ms-at)/CHAR_MS)));
  const titleEl=document.getElementById('title');
  if(ms>=at){titleEl.style.opacity=1;titleEl.innerHTML=TITLE.slice(0,tc)+(tc<TITLE.length?'<span class=cursor></span>':'');}
  else{titleEl.style.opacity=0;}
  at+=TITLE.length*CHAR_MS+PAUSE;
  // sections type in
  for(let i=0;i<SECTS.length;i++){
    const s=SECTS[i];
    const el=document.getElementById('s'+i);
    if(ms<at){el.style.opacity=0;continue;}
    el.style.opacity=1;
    const hEl=document.getElementById('h'+i);
    const pEl=document.getElementById('p'+i);
    const hc=Math.max(0,Math.min(s.h.length,Math.floor((ms-at)/CHAR_MS)));
    hEl.innerHTML=s.h.slice(0,hc)+(hc<s.h.length?'<span class=cursor></span>':'');
    at+=s.h.length*CHAR_MS+PAUSE;
    if(ms>=at&&s.p){
      const pc=Math.max(0,Math.min(s.p.length,Math.floor((ms-at)/CHAR_MS)));
      pEl.innerHTML=s.p.slice(0,pc)+(pc<s.p.length?'<span class="cursor dim"></span>':'');
      at+=s.p.length*CHAR_MS+PAUSE;
    }else if(ms<at){pEl.innerHTML='';}
  }
  // fade out
  const fadeStart=at+HOLD_MS-PAUSE;
  if(ms>=fadeStart){document.body.style.opacity=Math.max(0,1-(ms-fadeStart)/FADE_MS);}
  else{document.body.style.opacity=1;}
};
setFrame(0);
</script></body></html>`;
}

export async function pagePreview(page, { shoot } = {}) {
  const file = previewPath(page);
  if (existsSync(file)) return { file, fresh: false };

  const text = previewText(page);
  if (!text) return null;

  let ffmpegAvailable;
  try { execFileSync(FFMPEG, ["-version"], { stdio: "ignore" }); ffmpegAvailable = true; }
  catch { ffmpegAvailable = false; }
  if (!ffmpegAvailable) return null;

  const html = previewHtml(text.title, text.sections);
  let totalChars = text.title.length;
  text.sections.forEach(s => { totalChars += s.heading.length + s.snippet.length; });
  const totalMs = 200 + text.title.length * CHAR_MS + 250 + text.sections.length * 250 + totalChars * CHAR_MS + HOLD_MS + FADE_MS;
  const totalFrames = Math.ceil((totalMs / 1000) * FPS);

  let playwright;
  try { playwright = await import("playwright"); }
  catch { return null; }

  let browser;
  try { browser = await playwright.chromium.launch({ headless: true }); }
  catch { return null; }

  const framesDir = join(config.dataDir, "cards", `frames-${page.id}-${process.pid}`);
  try {
    mkdirSync(framesDir, { recursive: true });
    const pg = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await pg.setContent(html, { waitUntil: "load" });

    for (let i = 0; i < totalFrames; i++) {
      await pg.evaluate((t) => window.setFrame(t), i / FPS);
      await pg.screenshot({
        path: join(framesDir, `f${String(i).padStart(4, "0")}.png`),
        type: "png",
        clip: { x: 0, y: 0, width: W, height: H },
      });
    }
    await browser.close().catch(() => {});

    mkdirSync(join(config.dataDir, "cards"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp.mp4`;
    execFileSync(FFMPEG, [
      "-y", "-framerate", String(FPS), "-i", join(framesDir, "f%04d.png"),
      "-c:v", "libx264", "-profile:v", "main", "-level", "4.0", "-pix_fmt", "yuv420p",
      "-crf", "22", "-preset", "slow", "-tune", "stillimage", "-movflags", "+faststart", "-an",
      tmp,
    ], { stdio: "ignore", timeout: 20_000 });
    renameSync(tmp, file);

    return { file, fresh: true };
  } finally {
    await browser?.close?.().catch(() => {});
    try {
      for (const f of readdirSync(framesDir)) unlinkSync(join(framesDir, f));
      rmdirSync(framesDir);
    } catch {}
  }
}

const HTML = () => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });

export async function previewRequest({ id, key = null, headers = {}, log = () => {} }) {
  const page = db.getPage(id);
  if (!page) return { status: 404, headers: HTML(), body: renderNotFound() };
  const access = checkAccess({ page, cookie: readCookie(headers?.cookie), key });
  if (!access.allow) return { status: 404, headers: HTML(), body: renderNotFound() };
  try {
    const result = await pagePreview(page);
    if (!result) return { status: 404, headers: HTML(), body: renderNotFound() };
    const bytes = readFileSync(result.file);
    const total = bytes.length;
    const range = String(headers?.range ?? "");
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total) return { status: 416, headers: { "Content-Range": `bytes */${total}` }, body: "" };
      return {
        status: 206,
        headers: {
          "Content-Type": "video/mp4", "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${total}`, "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=86400",
        },
        body: bytes.subarray(start, end + 1),
      };
    }
    return {
      status: 200,
      headers: { "Content-Type": "video/mp4", "Content-Length": total, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" },
      body: bytes,
    };
  } catch (e) {
    log({ page_preview_failed: id, why: (e?.message ?? String(e)).split("\n")[0] });
    return { status: 404, headers: HTML(), body: renderNotFound() };
  }
}
