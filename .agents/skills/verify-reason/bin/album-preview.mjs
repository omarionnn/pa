#!/usr/bin/env node
// Draw the event album's pages and its sample chat with made-up data, as PNGs, for looking at before
// shipping. Nothing leaves this machine: a throwaway database in a temp directory, every photo a
// coloured square drawn by Chromium, every request served to Chromium through a Playwright route
// that calls the real page code (src/http.js eventRequestFor) with a real page session.
//
//   node .agents/skills/verify-reason/bin/album-preview.mjs [outDir]     (default ~/Desktop)
//
// Writes reason-album-attendee.png, reason-album-organizer.png, reason-album-chat.png (three panels:
// the note before a first contribution, the release text, the organizer's nudge + "let everyone in").
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const outDir = process.argv[2] || join(homedir(), "Desktop");
const dir = mkdtempSync(join(tmpdir(), "reason-album-preview-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_CADDY_SECRET = process.env.REASON_CADDY_SECRET || "verify-caddy"; // what Caddy adds beside its marker
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_EVENT_ALBUMS = "on";
process.env.SENDBLUE_FROM_NUMBER = process.env.SENDBLUE_FROM_NUMBER || "+16562167455";
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) delete process.env[k];

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const db = await imp("src/db.js");
const events = await imp("src/events.js");
const albums = await imp("src/albums.js");
const { eventRequestFor } = await imp("src/http.js");
const { clock } = await imp("src/config.js");
const playwright = await import("playwright");

const browser = await playwright.chromium.launch({ headless: true });
const W = 390;

/** A coloured, lightly textured JPEG, as a stand-in for a photo. */
async function swatch(a, b, w = 900, h = 900) {
  const pg = await browser.newPage({ viewport: { width: w, height: h } });
  await pg.setContent(`<body style="margin:0;width:${w}px;height:${h}px;background:linear-gradient(135deg,${a},${b})"><div style="position:absolute;inset:0;background:radial-gradient(circle at 30% 30%,rgba(255,255,255,.25),transparent 60%)"></div></body>`);
  const bytes = await pg.screenshot({ type: "jpeg", quality: 80 });
  await pg.close();
  return bytes;
}

// ---- the sample event: Nana organizes Game Night; eight friends joined; some are checked in ----
const C = (n) => `dm:fake:+1212555${String(n).padStart(4, "0")}`;
const people = ["Nana", "Maya", "Daniel", "Priya", "Tomas", "Aisha", "Kwame", "Lina", "Jonah"];
people.forEach((name, i) => db.upsertAccount({ conversationId: C(i), channel: "fake", address: `+1212555${String(i).padStart(4, "0")}`, name }));
const made = events.create(C(0), { name: "Game Night", description: "bring snacks", starts_at: "2026-10-24T20:00", location: "41 Grove St", password: "catan", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true });
const ev = made.event;
for (let i = 1; i < people.length; i++) await events.joinExisting({ conversationId: C(i), name: "Game Night", password: "catan" });

const palette = [["#c0785f", "#8a4b3a"], ["#6f8fb0", "#3f5f80"], ["#d9b85a", "#a98a2e"], ["#7fa86f", "#4f7a45"], ["#9c7fb5", "#6b4f8a"], ["#6fa89c", "#3f7a70"], ["#c47a7a", "#8f4b4b"], ["#8a8fc4", "#55598f"], ["#b59a6f", "#7f6a45"], ["#6fb0a0", "#3a7a6c"], ["#c4906f", "#8f5f3f"], ["#7f9cb5", "#4f6c85"]];
const photos = new Map();
let n = 0;
const by = [1, 2, 0, 3, 2, 4, 5, 1, 6, 7, 8, 3];
for (const [i, who] of by.entries()) {
  const bytes = await swatch(...palette[i % palette.length]);
  const url = `https://cdn.example.test/${++n}.jpg`;
  photos.set(url, bytes);
  const mid = db.recordMedia({ conversationId: C(who), channel: "fake", externalId: `x${n}`, ordinal: 0, kind: "image", filename: `IMG_${1000 + n}.jpg`, url }).id;
  db.agreeAlbumConsent(C(who), clock.now());
  const r = await albums.contribute({ ev, conversationId: C(who), mediaIds: [mid], fetchImpl: async (u) => new Response(photos.get(u), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(photos.get(u).length) } }) });
  if (!r.ok || !r.added.length) throw new Error(`photo ${n} not stored: ${JSON.stringify(r)}`);
  clock.skip(60_000);
}
const all = db.photosOf(db.albumOf(ev.id).id);
for (const idx of [2, 0, 4]) albums.pin({ ev, conversationId: C(0), photoId: all[idx].id });
const guests = db.attendeesOf(ev.id);
for (const g of guests.slice(0, 6)) db.checkIn(ev.id, g.conversation_id, C(0));
const released = await albums.release({ runtime: { _tell: async () => ({ ok: true }) }, ev, conversationId: C(0) });
if (!released.ok) throw new Error("release failed");
const cover = await swatch("#4a3b31", "#1d1915", 1200, 630);

db.startPageSession("p-nana", "tok-nana", { conversationId: C(0) });
db.startPageSession("p-maya", "tok-maya", { conversationId: C(1) });

/** Serve one path to Chromium through the real page code, as the given browser. */
async function serve(route, cookie) {
  const url = new URL(route.request().url());
  const m = /^\/e\/([A-Za-z0-9_-]{16})(?:\/(.*))?$/.exec(url.pathname);
  if (!m) return route.fulfill({ status: 404, body: "" });
  if (m[2] === "cover.jpg") return route.fulfill({ status: 200, contentType: "image/jpeg", body: cover });
  const out = await eventRequestFor({
    publicId: m[1], sub: m[2] || null, method: "GET", query: Object.fromEntries(url.searchParams),
    headers: { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": process.env.REASON_CADDY_SECRET }, remoteAddress: "127.0.0.1", readBody: async () => null, runtime: null, router: null,
  });
  const headers = Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, String(v)]));
  return route.fulfill({ status: out.status, headers, body: Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body)) });
}

async function shoot(path, cookie, file) {
  const pg = await browser.newPage({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" });
  await pg.route("**/*", (route) => serve(route, cookie));
  await pg.goto(`https://files.example.test${path}`, { waitUntil: "networkidle" });
  await pg.screenshot({ path: join(outDir, file), fullPage: true });
  await pg.close();
  console.log(`wrote ${join(outDir, file)}`);
}

await shoot(`/e/${ev.public_id}/album`, "reason_page=tok-maya", "reason-album-attendee.png");
await shoot(`/e/${ev.public_id}/album/manage`, "reason_page=tok-nana", "reason-album-organizer.png");

// ---- the sample chat: the note before a first contribution, the confirmation, the release text ----
const album = db.albumOf(ev.id);
const maya = db.attendeeRow(ev.id, C(1));
const note = albums.consentNote(ev, 12);
const releaseText = albums.releaseText(ev, album, maya);
const [words, link] = releaseText.split("\n");
// ---- the organizer's side: a second event Nana releases with nobody checked in, then lets everyone in ----
const made2 = events.create(C(0), { name: "Rooftop Party", description: "sunset", starts_at: "2026-10-25T18:00", location: "roof", password: "sunset", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true });
const ev2 = made2.event;
for (let i = 1; i <= 8; i++) await events.joinExisting({ conversationId: C(i), name: "Rooftop Party", password: "sunset" });
{
  const bytes = await swatch("#c0785f", "#3f5f80");
  const url = `https://cdn.example.test/${++n}.jpg`;
  photos.set(url, bytes);
  const mid = db.recordMedia({ conversationId: C(2), channel: "fake", externalId: `x${n}`, ordinal: 0, kind: "image", filename: `IMG_${1000 + n}.jpg`, url }).id;
  const r = await albums.contribute({ ev: ev2, conversationId: C(2), mediaIds: [mid], fetchImpl: async (u) => new Response(photos.get(u), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(photos.get(u).length) } }) });
  if (!r.ok) throw new Error("rooftop photo not stored");
}
const quiet = { _tell: async () => ({ ok: true }) };
const rel2 = await albums.release({ runtime: quiet, ev: ev2, conversationId: C(0) });
if (!rel2.nudge) throw new Error("expected the zero-check-in nudge");
const letIn = await albums.checkInAll({ runtime: quiet, ev: ev2, conversationId: C(0) });
const letInReply = `done — all ${letIn.checked_in} of them are checked in, and each just got their own link to the album.`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const bub = (side, text, cls = "") => `<div class="bub ${side} ${cls}">${esc(text)}</div>`;
const chat = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f2ebe0;font:16px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:#2a2520;padding:20px 14px 28px}
h2{font:600 .72rem/1 -apple-system,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:#6a6253;margin:22px 4px 10px}
.phone{background:#fff;border-radius:22px;padding:14px 12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 1px 0 rgba(0,0,0,.05)}
.bub{max-width:82%;padding:9px 13px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.me{align-self:flex-end;background:#1f8cff;color:#fff;border-bottom-right-radius:5px}
.them{align-self:flex-start;background:#e9e9eb;color:#111;border-bottom-left-radius:5px}
.link{color:#1f8cff;text-decoration:underline;background:#e9e9eb}
.cap{font-size:.78rem;color:#6a6253;margin:6px 4px 0}
</style></head><body>
<h2>1 · Sending photos</h2><div class="phone">
${bub("me", "[12 photos] for Game Night")}
${bub("them", note)}
${bub("me", "yes")}
${bub("them", `done. all 12 are in — they'll show as "Shared by Maya". the organizer releases the album when the night's over.`)}
</div><p class="cap">The note goes once, before a person's first contribution. After that, photos named for an event go straight in.</p>
<h2>2 · When the organizer ends the event</h2><div class="phone">
${bub("them", words)}
${bub("them", link, "link")}
</div><p class="cap">One message to each checked-in guest, with their own link. Nothing per new photo; late uploads stay open until the expiry.</p>
<h2>3 · The organizer ends it with nobody checked in</h2><div class="phone">
${bub("me", "end the rooftop party and release the album")}
${bub("them", rel2.nudge)}
${bub("me", "let everyone in")}
${bub("them", letInReply)}
</div><p class="cap">A release to nobody is never silent: Reason says how many of the guests who joined are checked in, that only checked-in guests get the album, and asks who was there. Plain intent, never a phrase to type. "Everyone", "everyone except Lina" or a few names check them in; each newly checked-in guest is texted the link once.</p>
</body></html>`;
const pg = await browser.newPage({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2 });
await pg.setContent(chat);
await pg.screenshot({ path: join(outDir, "reason-album-chat.png"), fullPage: true });
await pg.close();
console.log(`wrote ${join(outDir, "reason-album-chat.png")}`);
writeFileSync(join(dir, "note.txt"), note);

await browser.close();
rmSync(dir, { recursive: true, force: true });
