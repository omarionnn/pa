// Every purchase-approval screen (src/pages/webapprove.js), the card-saved screen that offers Face ID,
// and Settings → Shopping with it, drawn with sample data into dist/passkey-staging/ (a later step of
// one page opens at #step-<name>). `--deploy` puts it on a Netlify alias of the Web staging site
// (https://passkey--reason-web-staging.netlify.app), never on its production URL.
//
// A passkey is made for heyreason.com only, so it can't run here: the buttons walk through the screens
// (Approve → paying → paid; Decline → declined) without calling Face ID.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const outDir = new URL("dist/passkey-staging/", root).pathname;
const deploy = process.argv.includes("--deploy");
const SITE = process.env.REASON_STAGING_SITE || "c749fa22-03a3-4a51-9b80-1081b789fede";
const dir = mkdtempSync(join(tmpdir(), "reason-passkey-staging-"));
for (const k of Object.keys(process.env)) if (/^(SENDBLUE|LINQ|ANTHROPIC|AGENTCARD|OPENAI|GEMINI|CROSSMINT)_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  TZ: "America/New_York", REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"), REASON_OWNER_NAME: "Ama",
  REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:staging", REASON_WEB: "on", REASON_SHOP_CONNECT: "on", REASON_PASSKEY_PAY: "on",
});
const imp = (p) => import(new URL(p, root));
const cx = await imp("src/pages/webconnect.js");
const pk = await imp("src/pages/webapprove.js");
const st = await imp("src/pages/websettings.js");
const kit = await imp("src/pages/webkit.js");

const html = (o) => o.html;
const v = { amount: "$12.49", store: "Best Buy", item: "A 4-ft USB-C cable", expiresAt: Date.now() + 5 * 60_000, a: {}, row: {} };
const demo = { staging: true, base: "" };
const day = Date.parse("2026-10-31T12:30:00Z");
const shopping = (passkeys) => ({ stores: [{ store: "bestbuy", name: "Best Buy", connectedAt: Date.parse("2026-10-30T17:00:00Z") }], card: { brand: "visa", last4: "4242" }, lastUsed: { store: "Best Buy", at: Date.parse("2026-10-30T19:00:00Z") }, passkeys });
const settings = (passkeys) => st.renderSettings({ csrf: "x", reach: "text", browsers: [], connected: [], shopping: shopping(passkeys) });

// [file, title, html, step to open on]
const S = [
  ["approve", "Approve: Pay $12.49 at Best Buy?", html(pk.renderApprove({ v, staging: true, boot: demo }))],
  ["approve-paying", "Approved, paying", html(pk.renderApprove({ v, staging: true, boot: demo })), "paying"],
  ["approve-paid", "Paid", html(pk.renderApprove({ v, staging: true, boot: demo })), "paid"],
  ["approve-declined", "Declined", html(pk.renderApprove({ v, staging: true, boot: demo })), "declined"],
  ["approve-unsure", "Couldn't tell if it went through", html(pk.renderApprove({ v, staging: true, boot: demo })), "unsure"],
  ["approve-cooling", "A new Face ID still waiting its day", html(pk.renderApprove({ v, staging: true, boot: demo, blocked: "cooling_off" }))],
  ["approve-used", "Link already used", html(pk.renderApproveEnded({ v, state: "used", staging: true }))],
  ["approve-expired", "Link ran out", html(pk.renderApproveEnded({ v, state: "expired", staging: true }))],
  ["setup", "Set up Face ID (first time)", html(pk.renderSetup({ staging: true, boot: demo }))],
  ["setup-done", "Face ID set up", html(pk.renderSetup({ staging: true, boot: demo })), "done"],
  ["setup-again", "Add Face ID on a new phone (waits a day)", html(pk.renderSetup({ staging: true, boot: demo, has: [{ createdAt: day }] }))],
  ["setup-signedout", "Set up, signed out", html(pk.renderSetup({ signedIn: false, staging: true }))],
  ["card-saved", "Card saved, now Face ID", html(cx.renderView({ state: "connected", kind: "card", store: "" }, { staging: true, card: { brand: "visa", last4: "4242" }, faceId: true }))],
  ["settings-shopping", "Settings → Shopping, Face ID on", settings([{ createdAt: day, usableAt: day }])],
  ["settings-shopping-off", "Settings → Shopping, Face ID not set up", settings([])],
];

// The flow, as the person meets it.
const TEXTS = [
  ["Reason", "OK to pay $12.49 at Best Buy for a 4-ft USB-C cable? Approve it with Face ID here:\nheyreason.com/web/approve/…"],
  ["", "→ the page: the exact total → Approve with Face ID → Face ID on the phone → paid"],
  ["You", "yes"],
  ["Reason", "Purchases need Face ID now, so a yes here won't pay. Here's a fresh link:\nheyreason.com/web/approve/…"],
  ["Reason", "Approved with Face ID. Paid $12.49 at Best Buy; the store still has to place it, and I'll tell you when it's through."],
];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const index = kit.webPage({
  title: "Reason — Face ID for purchases (staging)",
  css: `.ix{max-width:760px;margin:0 auto;padding:36px 24px 60px;display:flex;flex-direction:column;gap:22px}.ix ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}.ix li a{display:flex;min-height:44px;align-items:center;font:italic 400 22px/1.2 var(--serif);text-decoration:none}.bub2{max-width:30em;padding:12px 14px;border-radius:14px;font-size:15px;line-height:1.45;white-space:pre-wrap}.r{background:var(--lifted);border:1px solid var(--hair)}.y{align-self:flex-end;background:var(--pen);color:#fff}.n{font:400 12px/1.4 var(--mono);letter-spacing:.06em;color:var(--muted)}.flow{display:flex;flex-direction:column;gap:10px}`,
  body: `<main class="ix"><header>${kit.wordmark()}</header><p class="lbl pen">STAGING · SAMPLE DATA · FACE ID FOR PURCHASES</p><h1 class="h1">Approve a purchase with Face ID.</h1>`
    + `<p class="lbl">THE FLOW, BY TEXT</p><div class="flow">${TEXTS.map(([who, t]) => who ? `<p class="bub2 ${who === "You" ? "y" : "r"}">${esc(t)}</p>` : `<p class="n">${esc(t)}</p>`).join("")}</div>`
    + `<hr class="rule"><p class="lbl">EVERY SCREEN</p><ol>${S.map(([f, t, , step]) => `<li><a href="/${f}.html${step ? `#step-${step}` : ""}">${esc(t)} →</a></li>`).join("")}</ol>`
    + `<p class="n">Theme follows your phone (Auto). Face ID only runs on heyreason.com, so here the buttons just walk the screens.</p></main>`,
});

try {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "web", "fonts"), { recursive: true });
  for (const name of Object.keys(kit.WEB_FONTS)) writeFileSync(join(outDir, "web", "fonts", `${name}.woff2`), kit.WEB_FONTS[name]);
  for (const f of ["favicon.svg", "apple-touch-icon.png"]) copyFileSync(new URL(`assets/${f}`, root), join(outDir, f));
  const fix = (h) => h.replaceAll('href="/web/connect/passkey"', 'href="/setup.html"').replaceAll('href="/web?thread"', 'href="/"').replaceAll('href="/web?home"', 'href="/"').replaceAll('href="/web/settings#shopping"', 'href="/settings-shopping.html#shopping"').replaceAll('href="/web/settings?confirm=card#shopping"', 'href="/settings-card-remove.html#shopping"').replaceAll('href="/web/connect/new-card"', 'href="/card.html"');
  for (const [f, , h] of S) writeFileSync(join(outDir, `${f}.html`), fix(h));
  writeFileSync(join(outDir, "index.html"), index);
  writeFileSync(join(outDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
  writeFileSync(join(outDir, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Cache-Control: no-cache\n");
  console.log(`wrote ${S.length} screens + index.html to ${outDir}`);
  if (deploy) execFileSync("npx", ["-y", "netlify-cli", "deploy", "--no-build", "--alias", "passkey", "--dir", outDir, "--site", SITE, "--message", `passkey staging ${new Date().toISOString()}`], { stdio: "inherit", cwd: dir });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
