#!/usr/bin/env node
// Mockups of Reason's OWN native sign-in page, one still per step state, light + dark (owner,
// 2026-11-10: "mockups first — render each step state and open them"). Renders in process from src/,
// no server, no database, nothing sent. A placeholder PNG stands in for the streamed page behind.
//
//   node .agents/skills/verify-reason/bin/native-signin-shots.mjs [--shots dir]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
process.env.REASON_DB_PATH = join(mkdtempSync(join(tmpdir(), "native-shots-")), "x.db");
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];

const arg = (n) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null;
const outDir = arg("--shots") || join(process.env.HOME, "Desktop", "reason-signin-native-1110");
mkdirSync(outDir, { recursive: true });
const { setupNativePage } = await import(new URL("../../../../src/pages/setupsignin.js", import.meta.url));
const { chromium } = createRequire(new URL("../../../../package.json", import.meta.url))("playwright");

// A 1x1 grey PNG as the placeholder streamed page (the real one is the site's own page, live).
const GREY = "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='430' height='700'><rect width='430' height='700' fill='#efe9df'/><text x='215' y='350' font-family='monospace' font-size='15' fill='#b3a894' text-anchor='middle'>the real Notion / Google page, live</text></svg>`);

const notion = { site: "notion", label: "Notion", signin_url: "https://www.notion.so/login", signin_blocked: false };
const STEPS = [
  ["01-chooser", { step: "chooser", provider: "", number: "", say: "Pick how you sign in." }],
  ["02-email", { step: "email", provider: "google", number: "", say: "Google wants your email." }],
  ["03-password", { step: "password", provider: "google", number: "", say: "Google wants your password. Type it here on Google's own page — it never reaches me." }],
  ["04-phone-tap", { step: "phone_tap", provider: "google", number: "", say: "Google is pinging your phone. Tap Yes there." }],
  ["05-number-match", { step: "number_match", provider: "google", number: "47", say: "Google sent a prompt to your phone. Tap the number 47 there." }],
  ["06-code", { step: "code", provider: "google", number: "", say: "Google sent a code. Send it to me as it came — I'll clean it up." }],
  ["07-account", { step: "account", provider: "google", number: "", say: "Google is asking which account. Pick yours." }],
  ["08-consent", { step: "consent", provider: "google", number: "", say: "Google is asking if you allow access. Read it and tap to allow — I won't grant it for you." }],
  ["09-signed-in", { step: "signed_in", provider: "google", number: "", say: "Signed in." }],
  ["10-refused", { step: "refused", provider: "google", number: "", say: "Google refused my browser." }],
  ["11-captcha", { step: "captcha", provider: "google", number: "", say: "Notion wants to check you're human." }],
  ["12-fallback-page", { step: "unknown", provider: "google", number: "", say: "Working on the Google page…" }],
];

const browser = await chromium.launch();
const index = [];
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  for (const [name, step] of STEPS) {
    const html = setupNativePage({ entry: notion, step, shot: GREY });
    const page = await ctx.newPage();
    await page.setContent(typeof html === "string" ? html : html.body, { waitUntil: "networkidle" });
    const file = `${name}.${scheme}.png`;
    await page.screenshot({ path: join(outDir, file), fullPage: true });
    await page.close();
    if (scheme === "light") index.push([name, step.step]);
  }
  await ctx.close();
}
await browser.close();
// A contact sheet page linking every shot, for a quick scroll.
const sheet = `<!doctype html><meta charset=utf-8><title>Reason native sign-in — step mockups</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;background:#141210;color:#f3efe8;margin:0;padding:28px}
h1{font:italic 400 30px/1 ui-serif,Georgia,serif}p{color:#a39c91}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:22px;margin-top:22px}
figure{margin:0}img{width:100%;border:1px solid #2c2924;border-radius:12px}figcaption{font:400 12px/1.4 ui-monospace,monospace;color:#a39c91;margin-top:7px}</style>
<h1>Reason's own sign-in page — every step</h1><p>Notion → Google, each screen Reason drives behind. Light shots; dark versions saved beside each.</p>
<div class=g>${index.map(([n, s]) => `<figure><img src="${n}.light.png" alt="${s}"><figcaption>${n.replace(/^\d+-/, "")} — step: ${s}</figcaption></figure>`).join("")}</div>`;
writeFileSync(join(outDir, "index.html"), sheet);
console.log(`wrote ${STEPS.length * 2} shots + index.html to ${outDir}`);
