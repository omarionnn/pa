#!/usr/bin/env node
// The event link's card in Messages (spec §14), checked the way a preview fetcher sees it: a real
// HTTP server (src/http.js createServer) on a throwaway database, one event with its time and place
// hidden and a guest joined, then headless Chromium with JAVASCRIPT OFF reading the join page's
// og tags and fetching og:image. Nothing is sent anywhere; no model runs.
//
//   cd ~/Desktop/pa && node .agents/skills/verify-reason/bin/event-card.mjs [--shot out.jpg]
//
// One line per check, `ok` or `FAIL`; exits non-zero on any FAIL. `--shot` saves the card picture.
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createRequire } = await import("node:module");
const dir = mkdtempSync(join(tmpdir(), "ev-card-"));
process.env.REASON_DB_PATH = join(dir, "x.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_EVENTS = "on";
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "REASON_PAGES_URL"]) delete process.env[k];

const root = new URL("../../../../", import.meta.url);
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] ?? "" : "";
if (process.argv.includes("--shot") && !shot) { console.error("usage: event-card.mjs [--shot out.jpg]"); process.exit(2); }

const { createServer } = await import(new URL("src/http.js", root));
const { config } = await import(new URL("src/config.js", root));
const db = await import(new URL("src/db.js", root));
const events = await import(new URL("src/events.js", root));
const { INVITE_LINE } = await import(new URL("src/eventcover.js", root));
const { chromium } = createRequire(new URL("package.json", root))("playwright");

const server = createServer({ router: null, runtime: null });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
config.publicUrl = base; config.pagesUrl = ""; config.events = true;

db.upsertAccount({ conversationId: "dm:org", channel: "fake", address: "+15550000001", name: "Kofi" });
db.upsertAccount({ conversationId: "dm:ama", channel: "fake", address: "+15550000002", name: "Ama" });
const made = events.create("dm:org", {
  name: "Rooftop Halloween", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
  password: "pumpkin", show_time_on_join: false, show_location_on_join: false, guest_list_visible: true,
});
if (!made.ok) { console.error("could not make the event", made); process.exit(1); }
await events.joinExisting({ conversationId: "dm:ama", name: "Rooftop Halloween", password: "pumpkin", displayName: "Ama Mensah" });
const ev = made.event;

let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  const res = await page.goto(`${base}/e/${ev.public_id}`);
  check("join page loads with JavaScript off", res.status() === 200, String(res.status()));
  const og = await page.$$eval("meta[property^='og:'],meta[name^='twitter:']", ms => Object.fromEntries(ms.map(m => [m.getAttribute("property") ?? m.getAttribute("name"), m.getAttribute("content")])));
  check("og:title is the event name", og["og:title"] === "Rooftop Halloween", og["og:title"]);
  check("og:description is the invitation line", og["og:description"] === INVITE_LINE, og["og:description"]);
  check("og:image is absolute", /^http:\/\/127\.0\.0\.1:\d+\/e\/[A-Za-z0-9_-]{16}\/cover\.jpg\?v=/.test(og["og:image"] ?? ""), og["og:image"]);
  check("large-image card", og["twitter:card"] === "summary_large_image");
  const tags = JSON.stringify(og);
  for (const bad of ["pumpkin", "Ama", "Elm", "Oct 31", "9:00", "costumes"]) check(`card has no "${bad}"`, !tags.includes(bad));
  const html = await (await fetch(`${base}/e/${ev.public_id}`)).text();
  check("tags are in the served HTML (no script on the page)", html.includes('property="og:image"') && !/<script/i.test(html));
  const img = await fetch(og["og:image"]);
  const bytes = Buffer.from(await img.arrayBuffer());
  check("og:image is served as a JPEG", img.status === 200 && img.headers.get("content-type") === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8, `${img.status} ${img.headers.get("content-type")}`);
  let w = 0, h = 0;
  for (let i = 2; i < bytes.length - 8;) { const m = bytes[i + 1]; const len = bytes.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) { h = bytes.readUInt16BE(i + 5); w = bytes.readUInt16BE(i + 7); break; } i += 2 + len; }
  check("1200×630, under 1 MB", w === 1200 && h === 630 && bytes.length < 1_000_000, `${w}×${h}, ${bytes.length} bytes`);
  if (shot) writeFileSync(shot, bytes);
} finally {
  await b.close();
  server.close();
}
process.exit(fails ? 1 : 0);
