#!/usr/bin/env node
// Reason Web STAGING: every Web screen and state, drawn by the real current code (src/pages/websignin.js,
// webconvo.js, webkit.js) with made-up data, written out as a static site a designer can open without
// signing in. Nothing here reads the live database, .env, or any real person: a throwaway database in a
// temp directory, one fictional person (Ama Owusu, +1 555 numbers), and Reason's public line on the join
// screen. No server, no texts, no model calls.
//
//   npm run web:staging                  → writes dist/web-staging/ (index.html + one page per screen)
//   npm run web:staging -- --deploy      → also deploys it to the reason-web-staging Netlify site
//
// Each page keeps its real markup, CSS and script; only the links are rewritten so they move between
// the static pages (MEMORY, SETTINGS, Ongoing, the thread, sign-in → code → home), forms submit with GET
// to the next screen, and a small stand-in answers /web/send and /web/history so sending works on the page
// (Reason "replies" with one sample line). Every page carries noindex and a fixed STAGING · sample data tag.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const outDir = process.argv.find(a => a.startsWith("--out="))?.slice(6) || new URL("dist/web-staging/", root).pathname;
// The folder is wiped and rewritten each run: only ever one named web-staging.
if (!/\/web-staging\/?$/.test(outDir)) { console.error(`--out must end in /web-staging (got ${outDir})`); process.exit(1); }
const deploy = process.argv.includes("--deploy");
// reason-web-staging.netlify.app: its own Netlify site, never the marketing site.
const SITE = process.env.REASON_STAGING_SITE || "c749fa22-03a3-4a51-9b80-1081b789fede";

const dir = mkdtempSync(join(tmpdir(), "reason-web-staging-"));
for (const k of Object.keys(process.env)) if (/^(SENDBLUE|LINQ|ANTHROPIC|AGENTCARD|OPENAI|GEMINI|ELEVENLABS|TWILIO|BLAND)_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"), REASON_OWNER_NAME: "Ama", REASON_TZ: "America/New_York",
  REASON_CONVERSATION: "dm:staging", REASON_MASTER_NUMBER: "+15550100100", REASON_PAGES_URL: "https://files.heyreason.com",
  REASON_EVENTS_URL: "https://events.heyreason.com", REASON_PUBLIC_URL: "https://reason.example.test", REASON_SITE_URL: "https://heyreason.com", REASON_WEB: "on",
});

const imp = (p) => import(new URL(p, root));
const ws = await imp("src/pages/websignin.js");
const wc = await imp("src/pages/webconvo.js");
const kit = await imp("src/pages/webkit.js");
const db = await imp("src/db.js");

// Reason's public line (on the marketing site too); the person and everyone in the thread are made up.
const LINE = "+16562167455";
const CONV = "dm:staging";
const YOU = "+1 (555) 010-0142";
db.upsertAccount({ conversationId: CONV, channel: "fake", address: "+15550100142", name: "Ama Owusu", isOperator: false });
db.db.prepare("INSERT INTO pages (id, conversation_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("lisbon4", CONV, "Four days in Lisbon", "[]", Date.now(), Date.now());
const account = db.getAccount(CONV);

const now = Date.now();
const day = 864e5;
const at = (d, h, m) => { const x = new Date(now - d * day); x.setHours(h, m, 0, 0); return x.getTime(); };
let id = 0;
const row = (role, channel, text, when, media = []) => ({ id: ++id, role, channel, text, media, at: when, external_id: null });
const rows = [
  row("user", "fake", "Something like this for my sister's birthday?", at(2, 18, 40), [{ mimeType: "image/jpeg", filename: "IMG_3307.JPG" }]),
  row("assistant", "fake", "Lovely. I'll find a few like it under $80 that arrive before Saturday.", at(2, 18, 41)),
  row("user", "fake", "also flights to lisbon in march, nothing before 9am", at(1, 8, 2), [{ mimeType: "audio/x-caf", filename: "Audio Message.caf" }]),
  row("assistant", "fake", "On it. I'll keep the early ones out and hold the best two for you to look at.", at(1, 8, 3)),
  row("user", "web", "What did you find for Lisbon?", at(0, 10, 15)),
  row("assistant", "web", "Two that fit, both after 9:\n1. Tue Mar 10, 10:40 AM nonstop, back Sat — $612\n2. Wed Mar 11, 1:15 PM nonstop, back Sun — $574\nI put the hotel shortlist here too:\nhttps://files.heyreason.com/lisbon4", at(0, 10, 17)),
  row("user", "web", "Hold the Wednesday one.", at(0, 10, 19)),
];
const lines = rows.map(r => wc.rowOut(r, { conversationId: CONV, service: "iMessage" }));
const reply = wc.rowOut({ id: 9999, role: "assistant", channel: "web", text: "Got it. (Staging: this is a sample reply, nothing was sent.)", media: [], at: now, external_id: null }, { conversationId: CONV });

const items = [
  { kind: "task", title: "Choose a Lisbon hotel", status: "WAITING ON YOU", words: "two to pick from", needs: true },
  { kind: "task", title: "Flights to Lisbon in March", status: "WORKING", words: "checking fares", needs: false },
  { kind: "timer", title: "Call the dentist", status: "REMINDER", when: "Thu 9:00 AM", needs: false },
  { kind: "task", title: "Birthday gift for Esi", status: "WORKING", words: "comparing three", needs: false },
  { kind: "timer", title: "Weekly grocery order", status: "REMINDER", when: "Mon 8:00 AM", needs: false },
  { kind: "timer", title: "A call about the lease", status: "CALL", when: "Fri 2:30 PM", needs: false },
];
const approvals = [{ title: "Hold the Wed Mar 11 flight, $574", money: true }];
const pick = `<a class="pick" href="/web?thread" aria-label="Pick up from iMessage: continue the thread"><span class="pick-h"><span class="hand">pick up from iMessage</span><span class="dash" aria-hidden="true"></span><span class="lbl">LAST TEXT · 8:03 AM</span></span><span class="pick-q"><span class="y">also flights to lisbon in march, nothing before 9am</span><span class="r">On it. I'll keep the early ones out and hold the best two for you to look at.</span></span><span class="pick-go">Continue the thread <span aria-hidden="true">→</span></span><span class="pick-n">Same Reason, same thread. What you send here stays on Web.</span></a>`;
const soon = (which) => wc.soonPage({ which, account, headers: {} });
const convo = (o = {}) => wc.renderConversation({ account, csrf: "staging", lines, more: true, sendId: "staging", items, approvals, ...o });

// [file, group, title, note, html, signedOut?]
const S = [
  ["signin", "Signed out", "Sign-in", "Phone number, join column with QR.", ws.renderSignin({ joinNumber: LINE, formToken: "staging" }), true],
  ["signin-pause", "Signed out", "Sign-in · pause", "Too many codes asked for: counts down live.", ws.renderSignin({ joinNumber: LINE, formToken: "staging", number: YOU, error: { kind: "pause", waitMs: 59_000 } }), true],
  ["signin-origin", "Signed out", "Sign-in · form came from elsewhere", "", ws.renderSignin({ joinNumber: LINE, formToken: "staging", number: YOU, error: { kind: "origin" } }), true],
  ["code", "Signed out", "Code", "Six digits sent by text.", ws.renderCode({ number: YOU, joinNumber: LINE, formToken: "staging" }), true],
  ["code-wrong", "Signed out", "Code · wrong", "", ws.renderCode({ number: YOU, joinNumber: LINE, formToken: "staging", error: { kind: "wrong" } }), true],
  ["code-expired", "Signed out", "Code · expired", "", ws.renderCode({ number: YOU, formToken: "staging", error: { kind: "expired" } }), true],
  ["code-tries", "Signed out", "Code · too many tries", "Counts down live.", ws.renderCode({ number: YOU, formToken: "staging", error: { kind: "tries", waitMs: 299_000 } }), true],
  ["code-resend", "Signed out", "Code · resend limit", "", ws.renderCode({ number: YOU, formToken: "staging", error: { kind: "resend", leftMs: 600_000 } }), true],
  ["join", "Signed out", "New to Reason", "", ws.renderJoin({ joinNumber: LINE }), true],
  ["line-not-connected", "Signed out", "Line not connected", "", ws.renderJoin({ joinNumber: null }), true],
  ["signed-out", "Signed out", "Signed out", "", ws.renderSignin({ joinNumber: LINE, formToken: "staging", out: true }), true],
  ["first-visit", "Signed in", "First visit", "Shown once.", wc.renderFirstVisit({ account }), false],
  ["home", "Signed in", "Home · in hand", "Greeting, composer, approval, slips, pick up from iMessage.", wc.renderHome({ account, csrf: "staging", sendId: "staging", items, approvals, pick }), false],
  ["home-new", "Signed in", "Home · new", "Nothing in hand yet: start-with examples.", wc.renderHome({ account, csrf: "staging", sendId: "staging", items: [], pick: "" }), false],
  ["conversation", "Signed in", "Conversation", "Thread with photo, voice note, list, page card, approval, Ongoing margin (top 3, See all, HIDE →). Sending works here.", convo(), false],
  ["conversation-all", "Signed in", "Conversation · Ongoing open", "See all, drawn open.", convo({ all: true }), false],
  ["conversation-empty", "Signed in", "Conversation · empty", "No messages, nothing in hand.", wc.renderConversation({ account, csrf: "staging", lines: [], more: false, sendId: "staging", items: [], approvals: [] }), false],
  ["ongoing", "Signed in", "Ongoing · list", "Mobile tab: NEEDS YOU, IN HAND.", wc.renderOngoing({ csrf: "staging", items, approvals }), false],
  ["ongoing-all", "Signed in", "Ongoing · all", "", wc.renderOngoing({ csrf: "staging", items, approvals, all: true }), false],
  ["ongoing-empty", "Signed in", "Ongoing · empty", "Nothing left to chase.", wc.renderOngoing({ csrf: "staging", items: [] }), false],
  ["memory", "Signed in", "Memory", "As it is on main today.", soon("memory"), false],
  ["settings", "Signed in", "Settings", "As it is on main today.", soon("settings"), false],
  ["loader", "Global", "Loader", "The reas◯n·ing loader (plays on every load here).", wc.renderHome({ account, csrf: "staging", sendId: "staging", items, approvals, pick }), false],
  ["error", "Global", "Something went wrong", "", wc.renderError(), false],
];
const MISSING = [
  "Ongoing details (working / waiting / scheduled / ready / didn't work, approval detail): not built on main yet.",
  "Signed out mid-task: drawn by the page script only when a session expires mid-send.",
  "Offline + WAITING TO SEND: turn the network off in the browser on the Conversation page.",
  "Menu (phones): the ··· button on any signed-in page at phone width.",
];

// ---------------------------------------------------------------- static rewrites
function local(url, signedOut) {
  const [p, q = ""] = url.replace(/&amp;/g, "&").split("?");
  const qs = new URLSearchParams(q);
  if (p === "/web") {
    if (qs.has("out")) return "signed-out.html";
    if (qs.has("join")) return "join.html";
    if (qs.get("tab") === "ongoing") return qs.has("all") ? "ongoing-all.html" : "ongoing.html";
    if (qs.has("thread")) return qs.has("all") ? "conversation-all.html" : "conversation.html";
    return signedOut ? "signin.html" : "home.html";
  }
  return { "/web/memory": "memory.html", "/web/settings": "settings.html", "/web/signin": "code.html", "/web/code": "home.html", "/web/signout": "signed-out.html", "/web/send": "conversation.html" }[p] ?? null;
}
const SHIM = `<script>(function(){var f=window.fetch,sent=0,R=${JSON.stringify(reply)};window.fetch=function(u,o){u=String(u);if(u.indexOf('/web/')!==0)return f.apply(this,arguments);var b;if(u.indexOf('/web/send')===0){sent++;b={ok:true}}else{b={messages:[],more:false};if(sent){sent--;var m=Object.assign({},R,{id:R.id+Math.floor(Math.random()*1e6),at:Date.now()});b.messages=[m]}}return new Promise(function(r){setTimeout(function(){r(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}))},700)})};try{window.EventSource=undefined}catch(e){}})();</script>`;
const LOADER = `<script>try{sessionStorage.removeItem('reason-web-loaded')}catch(e){}</script>`;
const TAG = `<style>.stg-tag{position:fixed;right:10px;bottom:10px;z-index:9999;font:11px/1 "Courier New",Courier,monospace;letter-spacing:.12em;text-transform:uppercase;background:#9c3b2e;color:#fff;padding:7px 9px;text-decoration:none;opacity:.9}.stg-tag:hover{color:#fff;opacity:1}</style><a class="stg-tag" href="index.html">STAGING · sample data · all screens</a>`;

function stage(html, { signedOut = false, loader = false } = {}) {
  let out = html
    .replace(/(href|action)="(\/web(?:\/[a-z]+)?(?:\?[^"#]*)?)(#[^"]*)?"/g, (m, attr, url, hash = "") => { const to = local(url, signedOut); return to ? `${attr}="${to}${hash}"` : m; })
    .replace(/location\.href='(\/web[^']*)'/g, (m, url) => { const to = local(url, signedOut); return to ? `location.href='${to}'` : m; })
    .replace(/<form method="POST"/g, `<form method="GET"`);
  if (!/<meta name="robots" content="[^"]*noindex/.test(out)) out = out.replace("<head>", `<head>\n<meta name="robots" content="noindex">`);
  out = out.replace("<head>", `<head>\n${loader ? LOADER : ""}${SHIM}`);
  return out.replace(/<\/body>/, `${TAG}</body>`);
}

// ---------------------------------------------------------------- write
try {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "web", "fonts"), { recursive: true });
  for (const name of Object.keys(kit.WEB_FONTS)) writeFileSync(join(outDir, "web", "fonts", `${name}.woff2`), kit.WEB_FONTS[name]);
  for (const f of ["favicon.svg", "apple-touch-icon.png"]) copyFileSync(new URL(`assets/${f}`, root), join(outDir, f));
  for (const [file, , , , html, signedOut] of S) writeFileSync(join(outDir, `${file}.html`), stage(html, { signedOut, loader: file === "loader" }));

  const groups = [...new Set(S.map(s => s[1]))];
  const list = groups.map(g => `<section class="g">${kit.label(g.toUpperCase())}<ul>${S.filter(s => s[1] === g).map(([file, , title, note]) =>
    `<li><a href="${file}.html">${title}</a>${note ? `<span>${note}</span>` : ""}</li>`).join("")}</ul></section>`).join("");
  const body = `<main class="ix"><p class="lbl">STAGING · SAMPLE DATA</p><h1>Reason <em>Web</em> — every screen</h1>`
    + `<p class="q">Drawn by the real code on main with a made-up person (Ama Owusu, +1 555 numbers). Nothing here is signed in or connected: forms move to the next screen, sending gets one sample reply. Paper · Night · Auto at the foot of every page.</p>`
    + list + `<section class="g">${kit.label("NOT HERE YET")}<ul>${MISSING.map(m => `<li><span>${m}</span></li>`).join("")}</ul></section>`
    + `<p class="q">Built ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.</p></main>`;
  const css = `.ix{max-width:760px;margin:0 auto;padding:48px var(--gut) 80px}.ix h1{font:italic 44px/1.05 var(--serif);margin:8px 0 16px}.ix h1 em{color:var(--pen)}.q{color:var(--muted);font:15px/1.5 var(--sans)}.g{margin:32px 0 0}.g ul{list-style:none;padding:0;margin:8px 0 0}.g li{padding:10px 0;border-bottom:1px dashed var(--hair);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}.g a{font:italic 22px/1.2 var(--serif);color:var(--ink)}.g span{color:var(--muted);font:14px/1.4 var(--sans)}`;
  writeFileSync(join(outDir, "index.html"), stage(kit.webPage({ title: "Reason Web — staging", body, css }), {}));

  writeFileSync(join(outDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
  // The real security headers, minus the framing ban (a design tool may embed a page) and no-store.
  const csp = ws.SECURITY_HEADERS["Content-Security-Policy"].replace(/; frame-ancestors 'none'/, "");
  writeFileSync(join(outDir, "_headers"), `/*\n  X-Robots-Tag: noindex, nofollow\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Cache-Control: no-cache\n`);
  console.log(`wrote ${S.length} screens + index.html to ${outDir}`);

  if (deploy) {
    execFileSync("npx", ["--no-install", "netlify", "deploy", "--prod", "--no-build", "--dir", outDir, "--site", SITE, "--message", `web:staging ${new Date().toISOString()}`], { stdio: "inherit", cwd: dir });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
