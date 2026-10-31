// Every Connect screen (src/pages/webconnect.js) and Settings → Shopping, drawn with sample data into
// dist/connect-staging/ (screens that are a later step of one page open at #step-<name>), and
// screens.json beside them: which handoff screen each one matches, for side-by-side review, all for a
// look before anything ships. `--deploy` puts it on a Netlify alias of the
// Web staging site (https://connect--reason-web-staging.netlify.app), never on its production URL.
//
// Crossmint's own fields can't run here (no keys, not heyreason.com), so the sealed fields are drawn
// as stand-ins, masked, exactly where Crossmint's iframe mounts live.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const outDir = new URL("dist/connect-staging/", root).pathname;
const deploy = process.argv.includes("--deploy");
const SITE = process.env.REASON_STAGING_SITE || "c749fa22-03a3-4a51-9b80-1081b789fede";
const dir = mkdtempSync(join(tmpdir(), "reason-connect-staging-"));
for (const k of Object.keys(process.env)) if (/^(SENDBLUE|LINQ|ANTHROPIC|AGENTCARD|OPENAI|GEMINI|CROSSMINT)_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  TZ: "America/New_York", REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"), REASON_OWNER_NAME: "Ama",
  REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:staging", REASON_WEB: "on", REASON_SHOP_CONNECT: "on",
});
const imp = (p) => import(new URL(p, root));
const cx = await imp("src/pages/webconnect.js");
const st = await imp("src/pages/websettings.js");
const kit = await imp("src/pages/webkit.js");

const fields = [
  { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text", autoComplete: "email" } },
  { key: "password", label: "Password", required: true, handling: "protected", input: { kind: "text", display: "masked", autoComplete: "current-password" } },
];
const code = [{ key: "code", label: "Code", required: true, handling: "protected", input: { kind: "text", autoComplete: "one-time-code", inputMode: "numeric" } }];
const rq = (f, question = "") => ({ requestId: "req_sample", question, fields: f });
const v = (state, store, request = null, kind = "signin", extra = {}) => ({ state, store, kind, request, ...extra });
const html = (o) => o.html;
/** The checking page booted as a live one that has already waited `sec` seconds (no poll: `watch` off). */
const checking = (store, sec) => cx.withBoot(html(cx.renderView(v("checking", store, null, "signin", { waited: sec * 1000, stage: "in_progress" }), { staging: true })), { token: "staging", state: "checking", watch: false, waited: sec * 1000 });
const stdCode = [{ key: "code", label: "Code", required: true, handling: "standard", input: { kind: "text", autoComplete: "one-time-code", inputMode: "numeric" } }];
const shopping = { stores: [{ store: "target", name: "Target", connectedAt: Date.parse("2026-10-30T17:00:00Z") }, { store: "bestbuy", name: "Best Buy", connectedAt: Date.parse("2026-10-28T17:00:00Z") }], card: { brand: "visa", last4: "4242" }, lastUsed: { store: "Target", at: Date.parse("2026-10-28T20:00:00Z") } };

// [file, title, html, handoff screen it matches, #step to open on]
const S = [
  ["target-signin", "Sign in to Target", html(cx.renderView(v("signin", "target", rq(fields)), { staging: true })), "StoreSignIn"],
  ["target-noaccount", "No Target account?", html(cx.renderView(v("signin", "target", rq(fields)), { staging: true })), "StoreNoAccount", "noaccount"],
  ["target-signedout", "Target signed me out", html(cx.renderView(v("signin", "target", rq(fields), "signin", { again: true, item: "A 4-ft USB-C cable" }), { staging: true })), "StoreSignedOut"],
  ["target-retry", "Wrong password", html(cx.renderView(v("retry", "target", rq(fields)), { staging: true })), "StoreWrongPassword"],
  ["target-code", "Target sent a code (sealed field)", html(cx.renderView(v("code", "target", rq(code), "signin", { answered: true }), { staging: true })), "StoreCode"],
  ["target-code-cells", "A code we own (six cells)", html(cx.renderView(v("code", "target", rq(stdCode), "signin", { answered: true }), { staging: true })), "StoreCode"],
  ["target-wrongcode", "That code didn't match", html(cx.renderView(v("wrongcode", "target", rq(code), "signin", { answered: true }), { staging: true })), "StoreWrongCode"],
  // Waiting on the store, alive: the page as it reads after that many seconds (the clock keeps going here).
  ...[[0, "just sent"], [12, "12 s: the store is checking"], [45, "45 s: still checking"], [100, "100 s: longer than usual (the owner's wait)"], [200, "200 s: still here, will text"]].map(([sec, t]) =>
    [`walmart-checking-${sec}`, `Signing in to Walmart, ${t}`, checking("walmart", sec), "StoreApprove"]),
  ["target-connected", "Connected", html(cx.renderView(v("connected", "target"), { staging: true })), "StoreConnected"],
  ["walmart-failed-timeout", "Sign-in didn't go through: the store gave up waiting", html(cx.renderView(v("failed", "walmart", null, "signin", { reason: "timeout" }), { staging: true })), "StoreCantConnect"],
  ["walmart-failed-stopped", "Sign-in didn't go through: the store stopped it", html(cx.renderView(v("failed", "walmart", null, "signin", { reason: "stopped" }), { staging: true })), "StoreCantConnect"],
  ["walmart-failed-lost", "Sign-in didn't go through: lost track of it", html(cx.renderView(v("failed", "walmart", null, "signin", { reason: "lost" }), { staging: true })), "StoreCantConnect"],
  ["target-expired", "Link expired", html(cx.renderView(v("expired", "target"), { staging: true })), ""],
  ["walmart-signin", "Same page, Walmart", html(cx.renderView(v("signin", "walmart", rq(fields)), { staging: true })), "StoreSignIn"],
  ["card", "Add a card", html(cx.renderView(v("card", "", null, "card"), { staging: true })), "CardAdd"],
  ["card-saving", "Saving your card", html(cx.renderView(v("card", "", null, "card"), { staging: true })), "CardSaving", "saving"],
  ["card-error", "Card didn't save", html(cx.renderView(v("card", "", null, "card"), { staging: true })), "CardError", "error"],
  ["card-saved", "Card saved", html(cx.renderView(v("connected", "", null, "card"), { staging: true, card: { brand: "visa", last4: "4242" } })), "CardSaved"],
  ["card-expired", "Card link expired", html(cx.renderView(v("expired", "", null, "card"), { staging: true })), ""],
  ["settings-shopping", "Settings → Shopping (stores + card)", st.renderSettings({ csrf: "x", reach: "text", browsers: [], connected: [], shopping }), "CardManage"],
  ["settings-card-remove", "Settings → Shopping, forget the card?", st.renderSettings({ csrf: "x", reach: "text", browsers: [], connected: [], shopping, confirmCard: true }), "CardRemove"],
  ["settings-shopping-empty", "Settings → Shopping, nothing yet", st.renderSettings({ csrf: "x", reach: "text", browsers: [], connected: [], shopping: { stores: [], card: null } }), ""],
];

// The flow, as the person meets it: two texts, and the screens between them.
const TEXTS = [
  ["Reason", "Target needs you signed in before it lets anyone check out. Sign in once here and I'll use it for Target orders from now on. Your password goes straight to Target, not to me.\nheyreason.com/web/connect/…"],
  ["", "→ the page: sign in (1) · waiting (2) · a code if Target sends one (3) · connected ✓ (5)"],
  ["Reason", "OK to pay $9.79 at Best Buy for a 4-ft USB-C cable?"],
  ["You", "(any clear yes)"],
  ["", "→ Reason pays exactly $9.79. No yes, no payment."],
];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const index = kit.webPage({
  title: "Reason — Connect (staging)",
  css: `.ix{max-width:760px;margin:0 auto;padding:36px 24px 60px;display:flex;flex-direction:column;gap:22px}.ix ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}.ix li a{display:flex;min-height:44px;align-items:center;font:italic 400 22px/1.2 var(--serif);text-decoration:none}.bub2{max-width:30em;padding:12px 14px;border-radius:14px;font-size:15px;line-height:1.45;white-space:pre-wrap}.r{background:var(--lifted);border:1px solid var(--hair)}.y{align-self:flex-end;background:var(--pen);color:#fff}.n{font:400 12px/1.4 var(--mono);letter-spacing:.06em;color:var(--muted)}.flow{display:flex;flex-direction:column;gap:10px}`,
  body: `<main class="ix"><header>${kit.wordmark()}</header><p class="lbl pen">STAGING · SAMPLE DATA · SHOPPING ACCOUNTS</p><h1 class="h1">Connect a store, add a card.</h1>`
    + `<p class="lbl">THE FLOW, BY TEXT</p><div class="flow">${TEXTS.map(([who, t]) => who ? `<p class="bub2 ${who === "You" ? "y" : "r"}">${esc(t)}</p>` : `<p class="n">${esc(t)}</p>`).join("")}</div>`
    + `<hr class="rule"><p class="lbl">EVERY SCREEN</p><ol>${S.map(([f, t, , , step]) => `<li><a href="/${f}.html${step ? `#step-${step}` : ""}">${esc(t)} →</a></li>`).join("")}</ol>`
    + `<p class="n">Theme follows your phone (Auto). Sealed fields are stand-ins here; live they are the sealed iframe.</p></main>`,
});

try {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "web", "fonts"), { recursive: true });
  for (const name of Object.keys(kit.WEB_FONTS)) writeFileSync(join(outDir, "web", "fonts", `${name}.woff2`), kit.WEB_FONTS[name]);
  for (const f of ["favicon.svg", "apple-touch-icon.png"]) copyFileSync(new URL(`assets/${f}`, root), join(outDir, f));
  const fix = (h) => h.replaceAll('href="/web?thread"', 'href="/"').replaceAll('href="/web?home"', 'href="/"').replaceAll('href="/web/settings#shopping"', 'href="/settings-shopping.html#shopping"').replaceAll('href="/web/settings?confirm=card#shopping"', 'href="/settings-card-remove.html#shopping"').replaceAll('href="/web/connect/new-card"', 'href="/card.html"');
  for (const [f, , h] of S) writeFileSync(join(outDir, `${f}.html`), fix(h));
  writeFileSync(join(outDir, "index.html"), index);
  writeFileSync(join(outDir, "screens.json"), JSON.stringify(S.map(([file, title, , handoff, step]) => ({ file, title, handoff, step: step || "" })), null, 2));
  writeFileSync(join(outDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
  writeFileSync(join(outDir, "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Cache-Control: no-cache\n");
  console.log(`wrote ${S.length} screens + index.html to ${outDir}`);
  if (deploy) execFileSync("npx", ["-y", "netlify-cli", "deploy", "--no-build", "--alias", "connect", "--dir", outDir, "--site", SITE, "--message", `connect staging ${new Date().toISOString()}`], { stdio: "inherit", cwd: dir });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
