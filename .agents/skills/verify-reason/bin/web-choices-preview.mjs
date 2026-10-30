#!/usr/bin/env node
// Choice cards on Reason Web (src/choicecards.js): three cards Reason texted sit side by side in one
// thread line, under the line that asked. Throwaway database, real HTTP on loopback, real page in
// Chromium; nothing leaves this machine.
//
//   node .agents/skills/verify-reason/bin/web-choices-preview.mjs <outDir> <card1.jpg> <card2.jpg> <card3.jpg>
//
// Writes web-choices-<390|1280>-<paper|night>.png; prints ok/FAIL lines, exits non-zero on a failure.
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [outDir, ...cards] = process.argv.slice(2);
if (!outDir || cards.length < 2) { console.error("usage: web-choices-preview.mjs <outDir> <card.jpg>…"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "reason-choices-preview-"));
Object.assign(process.env, { REASON_DB_PATH: join(dir, "r.db"), REASON_DATA_DIR: dir, REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_WEB: "on" });
for (const k of ["ANTHROPIC_API_KEY", "REASON_BACKEND", "SENDBLUE_API_KEY_ID"]) delete process.env[k];
const root = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const db = await import(`${root}/src/db.js`);
const { config } = await import(`${root}/src/config.js`);
config.web = true;
const C = "dm:fake:+14155559876", ADDR = "+14155559876";
db.upsertAccount({ conversationId: C, channel: "fake", address: ADDR, name: "Kofi", isOperator: false });
db.upsertThread({ conversationId: C, channel: "fake", address: ADDR, isOwner: true, service: "iMessage" });
db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
db.markWebNoticeSeen(C);
mkdirSync(join(dir, "choice-cards"), { recursive: true });
const now = Date.now();
db.writeMessage({ conversationId: C, role: "user", channel: "fake", externalId: "in-1", text: "find me a cerave cleanser, not too pricey", at: now - 120_000 });
db.writeMessage({ conversationId: C, role: "assistant", channel: "fake", externalId: "out-1", outboxId: 9001, text: "Three CeraVe cleansers, all 16 oz. Which one?", at: now - 100_000 });
cards.forEach((f, i) => {
  const name = `${String(i).repeat(20).slice(0, 20)}.jpg`;
  copyFileSync(f, join(dir, "choice-cards", name));
  db.writeMessage({ conversationId: C, role: "assistant", channel: "fake", externalId: `out-c${i}`, outboxId: 9002 + i, text: "", media: [{ kind: "image", mimeType: "image/jpeg", filename: `reason-${i + 1}.jpg`, url: `card:${name}`, choice: true }], at: now - 99_000 + i * 1000 });
});
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const { createServer } = await import(`${root}/src/http.js`);
const { Router } = await import(`${root}/src/channels/router.js`);
const { WebChannel } = await import(`${root}/src/channels/web.js`);
const { chromium } = await import(`${root}/node_modules/playwright/index.mjs`);
const router = new Router({ log: () => {} }); router.register(new WebChannel());
const server = createServer({ router, runtime: null });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
db.startPageSession(`wsign:${C}`, "tok-choices-preview", { conversationId: C });
const b = await chromium.launch({ args: ["--mute-audio"] }); // drives are silent: nothing may play sound
for (const w of [390, 1280]) for (const t of ["paper", "night"]) {
  const ctx = await b.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: t === "night" ? "dark" : "light", timezoneId: "America/New_York" });
  await ctx.addCookies([{ name: "reason_page", value: "tok-choices-preview", url: base }]);
  await ctx.addInitScript(() => { try { sessionStorage.setItem("reason-web-loaded", "1"); } catch {} });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(String(e)));
  await p.goto(`${base}/web?thread`);
  await p.waitForSelector(".thread .msg"); await p.waitForTimeout(900);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(outDir, `web-choices-${w}-${t}.png`) });
  check(await p.locator(".msg.choices .crow .photo.choice").count() === cards.length, `${w} ${t}: ${cards.length} cards in one row`);
  check(await p.locator(".msg.choices .photo.choice img").evaluateAll(xs => xs.every(x => x.complete && x.naturalWidth > 0)), `${w} ${t}: every card picture loads (no broken image)`);
  check(!errs.length, `${w} ${t}: no page errors ${errs.join(" | ")}`);
  await ctx.close();
}
await b.close(); server.close();
process.exit(fails ? 1 : 0);
