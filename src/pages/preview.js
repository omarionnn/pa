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
  const first = blocks.find(b => b.type === "text" && String(b.text ?? "").trim());
  let body = first ? String(first.text).replace(/\s+/g, " ").trim() : "";
  if (body.length > 120) body = body.slice(0, 117).replace(/\s+\S*$/, "") + "…";
  return { title, body };
}

function previewHtml(title, body) {
  const ground = GROUND.light;
  const ink = "#15140f";
  const muted = "#7a756a";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:${ground};overflow:hidden}
.frame{width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center}
.pane{width:540px;background:#fff;border-radius:24px;padding:28px 32px 32px;box-shadow:0 2px 24px rgba(0,0,0,.08)}
.top{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.avatar{width:44px;height:44px;border-radius:50%;background:${ink};color:${ground};display:flex;align-items:center;justify-content:center;font:600 20px/1 ui-sans-serif,system-ui,sans-serif}
.who{font:600 17px/1.2 ui-sans-serif,system-ui,sans-serif;color:${ink}}
.sub{font:400 13px/1.2 ui-sans-serif,system-ui,sans-serif;color:${muted}}
.thread{min-height:90px}
.msg{display:inline-block;max-width:420px;padding:10px 16px;border-radius:18px;font:400 16.5px/1.38 ui-sans-serif,system-ui,sans-serif;color:#fff;background:#3478F6;margin-bottom:6px;word-break:break-word}
.msg.them{color:${ink};background:#e9e9eb}
.cursor{display:inline-block;width:2px;height:1.1em;background:#3478F6;vertical-align:text-bottom;animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
.title-line{font:600 16.5px/1.38 ui-sans-serif,system-ui,sans-serif;color:${ink};margin-bottom:8px}
.badge{display:inline-block;font:500 11px/1 ui-sans-serif,system-ui,sans-serif;color:${muted};background:${ground};border-radius:6px;padding:3px 8px;margin-bottom:12px}
</style></head><body>
<div class="frame"><div class="pane">
<div class="top"><div class="avatar">R</div><div><div class="who">Reason</div><div class="sub">iMessage</div></div></div>
<div class="badge" id="badge"></div>
<div class="thread">
<div class="msg them" id="title" style="visibility:hidden"></div>
<div class="msg" id="body" style="visibility:hidden"></div>
</div>
</div></div>
<script>
const TITLE=${JSON.stringify(esc(title))};
const BODY=${JSON.stringify(esc(body))};
const CHAR_MS=${CHAR_MS};
const HOLD_MS=${HOLD_MS};
const FADE_MS=${FADE_MS};
const titleEl=document.getElementById('title');
const bodyEl=document.getElementById('body');
const badgeEl=document.getElementById('badge');
const TOTAL_MS=300+TITLE.length*CHAR_MS+400+BODY.length*CHAR_MS+HOLD_MS+FADE_MS;
window.PERIOD=TOTAL_MS/1000;
window.setFrame=function(t){
  const ms=((t*1000)%TOTAL_MS+TOTAL_MS)%TOTAL_MS;
  let at=0;
  // phase 1: badge appears
  badgeEl.textContent=ms>150?'New page':'';
  at+=300;
  // phase 2: title types
  const titleChars=Math.max(0,Math.min(TITLE.length,Math.floor((ms-at)/CHAR_MS)));
  if(ms>=at){titleEl.style.visibility='visible';titleEl.innerHTML=TITLE.slice(0,titleChars)+(titleChars<TITLE.length?'<span class=cursor></span>':'');}
  else{titleEl.style.visibility='hidden';}
  at+=TITLE.length*CHAR_MS+400;
  // phase 3: body types
  const bodyChars=Math.max(0,Math.min(BODY.length,Math.floor((ms-at)/CHAR_MS)));
  if(ms>=at&&BODY){bodyEl.style.visibility='visible';bodyEl.innerHTML=BODY.slice(0,bodyChars)+(bodyChars<BODY.length?'<span class=cursor></span>':'');}
  else if(ms<at){bodyEl.style.visibility='hidden';}
  at+=BODY.length*CHAR_MS;
  // phase 4: hold
  // phase 5: fade
  const fadeStart=at+HOLD_MS;
  if(ms>=fadeStart){
    const p=Math.min(1,(ms-fadeStart)/FADE_MS);
    document.body.style.opacity=1-p;
  }else{document.body.style.opacity=1;}
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

  const html = previewHtml(text.title, text.body);
  const totalMs = 300 + text.title.length * CHAR_MS + 400 + (text.body.length * CHAR_MS) + HOLD_MS + FADE_MS;
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
