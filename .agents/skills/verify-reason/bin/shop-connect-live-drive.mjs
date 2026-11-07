#!/usr/bin/env node
// Drive the live sign-in page (never a dead page, 2026-10-31) against the caged Reason (muted): the record moves, the open
// page follows. Run from the worktree under `caged.sh env`:
//   cd /private/tmp/pa-signinprog && eval "$(REASON_VERIFY_RUN=/tmp/reason-verify-signinprog REASON_VERIFY_PORT=8809 .agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" && node .agents/skills/verify-reason/bin/shop-connect-live-drive.mjs
import { createRequire } from "node:module";
for (const k of ["SENDBLUE_API_KEY_ID", "LINQ_API_KEY", "TWILIO_AUTH_TOKEN", "CROSSMINT_SERVER_KEY"]) if (process.env[k]) { console.error(`refusing: ${k} is set`); process.exit(2); }
process.env.REASON_WEB = "on"; process.env.REASON_CONVERSATION = "dm:owner"; process.env.REASON_SHOP_CONNECT = "owner";
process.env.REASON_MASTER_NUMBER ||= "+12025551234"; process.env.REASON_OWNER_NAME ||= "Omari"; process.env.REASON_TZ ||= "America/New_York";
process.env.CROSSMINT_JWT_KEY_FILE ||= `${process.env.HOME}/.openclaw/secrets/crossmint-jwt-private.pem`; process.env.CROSSMINT_JWT_KID ||= "reason-1";
const root = new URL("../../../../", import.meta.url).href;
const imp = (p) => import(new URL(p, root));
const shop = await imp("src/shopconnect.js");
const db = await imp("src/db.js");
const { chromium } = createRequire(new URL("package.json", root))("playwright");
const BASE = `http://127.0.0.1:${process.env.REASON_PORT || 8809}`;
const OWNER = "dm:owner";
const q = (s) => db.db.prepare(s);
const res = [];
const ok = (name, cond, detail = "") => { res.push({ name, ok: !!cond, detail }); console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const get = async (p, h = {}) => { const r = await fetch(BASE + p, { headers: h, redirect: "manual" }); return { status: r.status, body: await r.text() }; };
const vis = (html) => html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "").replaceAll("&#39;", "'");

// a sign-in run at Walmart, at its first question, like step() leaves it
const runId = `drive-${Date.now()}`;
const now = Date.now();
q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at, stage, stage_at, progress_at, last_request_id) VALUES (?, ?, 'walmart', 'CeraVe Hydrating Facial Cleanser', 'sign_in', 'running', ?, ?, 'needs_input', ?, ?, 'req_1')").run(runId, OWNER, now, now, now, now);
const rq = { requestId: "req_1", request: { question: "Enter your Walmart email and password.", interaction: { kind: "form", fields: [
  { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text", autoComplete: "email" } },
  { key: "password", label: "Password", required: true, handling: "protected", input: { kind: "text", display: "masked", autoComplete: "current-password" } } ] } } };
const token = shop.createLink({ conversationId: OWNER, kind: "signin", store: "walmart", runId, request: rq });
const p1 = await get(`/web/connect/${token}`);
ok("sign-in page 200 with the form and the hidden 'sending' live block", p1.status === 200 && /id="cx-form"/.test(p1.body) && /id="cx-wait" data-lines="[^"]*Sending to Walmart, sealed[^"]*" hidden>/.test(p1.body), `status ${p1.status}`);
ok("nothing says Crossmint", !/crossmint/i.test(vis(p1.body)));

// the answer went in (recorded as answerLink does, without reaching Crossmint — no server key in the cage)
const link = shop.linkFor(token);
q("UPDATE shop_links SET answered_keys = 'email,password', answered_request_id = 'req_1', answered_at = ? WHERE id = ?").run(Date.now() - 95_000, link.id);
q("UPDATE shop_runs SET stage = 'in_progress', stage_at = ?, progress_at = ? WHERE run_id = ?").run(Date.now(), Date.now(), runId);
const p2 = await get(`/web/connect/${token}`);
ok("checking page: live block, first line drawn, boot waited ≈95 s", p2.status === 200 && /id="cx-live"/.test(p2.body) && /Sent to Walmart, sealed\.<\/p>/.test(p2.body) && /"waited":9[4-7]\d{3}/.test(p2.body), (p2.body.match(/"waited":\d+/) || [""])[0]);
const s1 = JSON.parse((await get(`/web/connect/${token}/state`)).body);
ok("/state carries waited + stage", s1.state === "checking" && s1.waited >= 95_000 && s1.stage === "in_progress", JSON.stringify(s1));

// the real page in Chromium: the words are already at "taking longer" (95 s), the clock ticks, the sweep moves,
// a pageshow (coming back from the background) polls at once, and the run dying redraws it as the end screen.
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
let polls = 0; page.on("request", (r) => { if (r.url().endsWith("/state")) polls++; });
await page.goto(`${BASE}/web/connect/${token}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1300);
const line = await page.locator("#cx-live .pf-live-t").textContent();
const clockA = await page.locator("#cx-live .pf-live-e").textContent();
ok("after 95 s the line reads 'Taking longer than usual. Still on it.'", line === "Taking longer than usual. Still on it.", line);
ok("the clock shows ≈1:35", /^1:3[5-7]$/.test(clockA), clockA);
const sweep1 = await page.locator("#cx-live .pf-pulse").screenshot(); await page.waitForTimeout(450); const sweep2 = await page.locator("#cx-live .pf-pulse").screenshot();
ok("the sweep moves", !sweep1.equals(sweep2));
await page.waitForTimeout(1100);
ok("the clock ticks", (await page.locator("#cx-live .pf-live-e").textContent()) !== clockA);
await page.screenshot({ path: `${process.env.HOME}/Desktop/signin-progress-1031/cage-checking-95s.png` });
const before = polls; await page.evaluate(() => window.dispatchEvent(new Event("pageshow"))); await page.waitForTimeout(400);
ok("coming back (pageshow) polls at once", polls > before, `${before} → ${polls}`);
// the record moves on: a code question lands → the page redraws to the code screen
q("UPDATE shop_links SET request_id = 'req_2', request_json = ? WHERE id = ?").run(JSON.stringify({ requestId: "req_2", kind: "form", question: "Enter the code Walmart sent.", expiresAt: null, fields: [{ key: "code", label: "Code", handling: "protected", input: { kind: "text", autoComplete: "one-time-code", inputMode: "numeric" }, required: true }] }), link.id);
await page.waitForFunction(() => /sent a code/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
ok("a new question redraws the open page to 'Walmart sent a code.' within a poll", /Walmart sent a code\./.test(await page.locator("h1").first().textContent()));
await page.screenshot({ path: `${process.env.HOME}/Desktop/signin-progress-1031/cage-code.png` });
// the run dies while the link still says open (what happened live at 18:06 UTC) → the end screen, not a dead page
q("UPDATE shop_links SET answered_keys = 'email,password,code', answered_request_id = 'req_2', answered_at = ? WHERE id = ?").run(Date.now(), link.id);
await page.waitForFunction(() => /Signing in to Walmart/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
ok("the code answered → checking again, from 0:00", /Signing in to Walmart\./.test(await page.locator("h1").first().textContent()));
q("UPDATE shop_runs SET status = 'failed', result = 'input_expired', stage = 'failed' WHERE run_id = ?").run(runId);
await page.waitForFunction(() => /didn't go through/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
const h1 = await page.locator("h1").first().textContent();
ok("the run dying redraws the open page to the end screen", /That sign-in didn't go through\./.test(h1), h1);
const endText = await page.locator("main").textContent();
ok("…with the reason and the next step", /gave up on this sign-in/.test(endText) && /Text me and I'll send a fresh one/.test(endText) && /CHECK YOUR WALMART ACCOUNT/.test(endText));
ok("no live block on the end screen; no page errors", (await page.locator(".pf-live").count()) === 0 && errors.length === 0, errors.join(" | "));
await page.screenshot({ path: `${process.env.HOME}/Desktop/signin-progress-1031/cage-failed.png` });
const s2 = JSON.parse((await get(`/web/connect/${token}/state`)).body);
ok("/state says failed", s2.state === "failed" && s2.waited === undefined, JSON.stringify(s2));
await browser.close();

// expired + made-up tokens
const made = await get(`/web/connect/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
ok("a made-up token → 410 'This link has expired. Ask me for a new one.'", made.status === 410 && /This link has expired\./.test(vis(made.body)) && /Ask me for a new one\./.test(vis(made.body)), `status ${made.status}`);
const cardTok = shop.cardLink(OWNER);
q("UPDATE shop_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, shop.linkFor(cardTok).id);
const old = await get(`/web/connect/${cardTok}`);
ok("an old card link → 410 expired, no form", old.status === 410 && /This link has expired\./.test(vis(old.body)) && !/<form/.test(old.body));
const fresh = await get(`/web/connect/${shop.cardLink(OWNER)}`);
ok("a fresh card link → 200 with the saving live blocks", fresh.status === 200 && /id="cx-wait"/.test(fresh.body) && /id="cx-save-live"/.test(fresh.body));
q("DELETE FROM shop_runs WHERE run_id = ?").run(runId);
const fails = res.filter((r) => !r.ok).length;
console.log(`\n${res.length - fails} ok / ${fails} fail`);
process.exit(fails ? 1 : 0);
