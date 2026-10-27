// Reason Web drafts (REASON_WEB_DRAFTS): one REAL claude-cli Web turn on a scratch instance on this Mac,
// watched in Chromium. A screenshot each time the page changes and a video; prints the timeline:
// working line → first words → each piece → the saved reply in its place, draft gone.
//
// Needs a scratch instance (never Hetzner, never .env): see features/web-drafts.md for the env file
// and the throwaway session. Usage:
//   node bin/web-drafts-drive.mjs <base-url> <session-token> <out-dir> "<message>"
// Exit 1 unless: a draft showed, it showed BEFORE the saved reply, and the draft was gone after it.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(new URL("../../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const [base, token, out, msg] = process.argv.slice(2);
if (!base || !token || !out || !msg) { console.error("usage: web-drafts-drive.mjs <base> <token> <out> <message>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2, recordVideo: { dir: out, size: { width: 430, height: 860 } } });
await ctx.addCookies([{ name: "reason_page", value: token, url: base }]);
const p = await ctx.newPage();
await p.goto(`${base}/web?thread`, { waitUntil: "networkidle" });
const base0 = await p.evaluate(() => document.querySelectorAll(".thread .msg.re:not([data-draft])").length);
await p.fill("#c-input", msg);
await p.keyboard.press("Enter");
const t0 = Date.now(), seen = [];
for (let i = 0; i < 600; i++) {
  await p.waitForTimeout(150);
  const st = await p.evaluate(() => {
    const d = document.querySelector(".msg[data-draft]"), o = document.querySelector(".onit");
    const re = [...document.querySelectorAll(".thread .msg.re:not([data-draft])")];
    return { draft: d ? (d.querySelector(".rsay")?.innerText ?? "").replace(/\s+/g, " ") : null, onit: o ? !o.hidden : null, finals: re.length };
  });
  const key = JSON.stringify([st.draft, st.onit, st.finals]);
  if (seen.at(-1)?.key !== key) {
    await p.screenshot({ path: `${out}/${String(seen.length + 1).padStart(2, "0")}-${((Date.now() - t0) / 1000).toFixed(1)}s.png` });
    seen.push({ key, t: Date.now() - t0, ...st });
  }
  if (st.finals > base0 && !st.draft && Date.now() - t0 - seen.at(-1).t > 1500) break;
}
await ctx.close(); await b.close();
for (const s of seen) console.log(`${(s.t / 1000).toFixed(1)}s  working:${s.onit}  draft:${s.draft ? s.draft.slice(0, 70) + (s.draft.length > 70 ? "…" : "") : "-"}  saved:${s.finals > base0 ? "yes" : "no"}`);
const firstDraft = seen.find(s => s.draft), saved = seen.find(s => s.finals > base0);
const ok = !!firstDraft && !!saved && firstDraft.t < saved.t && !seen.at(-1).draft;
console.log(ok ? `ok — first words ${(firstDraft.t / 1000).toFixed(1)}s, saved reply ${(saved.t / 1000).toFixed(1)}s, ${seen.filter(s => s.draft).length} draft states` : "FAILED — no draft before the saved reply, or a draft left behind");
process.exit(ok ? 0 : 1);
