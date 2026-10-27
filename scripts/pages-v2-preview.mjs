// Pages Reason makes, v2: draw every page and edge screen through Reason's own routes, on sample
// data in a throwaway database, and screenshot them Paper + Night at 390 and 1280 (plus the two
// link-preview cards). SAMPLE DATA ONLY: a temp directory, a fake channel, nothing is sent anywhere.
//
//   node scripts/pages-v2-preview.mjs <out-dir>
//
// Writes <out-dir>/pages-<screen>-<390|1280>-<paper|night>.png, og-private.png, og-event.png and an
// index.json of what it drew. scripts/pages-v2-compare.py puts each beside its reference page.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] || "./pages-v2-preview");
mkdirSync(OUT, { recursive: true });
const PORT = 47000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "reason-pages-v2-preview-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: join(dir, "data"),
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner",
  REASON_MASTER_NUMBER: "+12025550142", REASON_OWNER_NUMBER: "+12025550142",
  REASON_PUBLIC_URL: BASE, REASON_PAGES_URL: `${BASE}/p`, REASON_EVENTS_URL: `${BASE}/e`,
  REASON_SITE_URL: "https://heyreason.com", REASON_WEB: "owner",
  REASON_EVENTS: "on", REASON_EVENT_ALBUMS: "on", REASON_PAGES_V2: "1",
  REASON_RECORDING_ROOT: join(dir, "data", "recordings"),
});
delete process.env.REASON_BACKEND;
delete process.env.ANTHROPIC_API_KEY;

const { chromium } = await import("playwright");
const db = await import("../src/db.js");
const events = await import("../src/events.js");
const albums = await import("../src/albums.js");
const { createServer } = await import("../src/http.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "dm:owner";
const KOFI = "dm:fake:+14155559876";
const AMA = "dm:fake:+13475550000";
const YAW = "dm:fake:+16465550111";
db.upsertAccount({ conversationId: OWNER, channel: "fake", address: "+12025550142", name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: KOFI, channel: "fake", address: "+14155559876", name: "Kofi" });
db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama" });
db.upsertAccount({ conversationId: YAW, channel: "fake", address: "+16465550111", name: "Yaw" });

const browser = await chromium.launch();

// ---- sample photos: drawn scenes, not stand-in boxes ----
const SCENES = [
  ["#c98b5a", "#5b3a2a", "#f3d2a2"], ["#7f9a7a", "#33452f", "#e8e0c8"], ["#d9a35f", "#7a4b2c", "#fbe8c4"], ["#8aa0b8", "#2f3d52", "#e6e0d4"],
  ["#b4744d", "#3f2a20", "#f0c99a"], ["#9cae8e", "#41503a", "#efe7cf"], ["#c7b08a", "#5e4a33", "#f6ecd5"], ["#a07c6a", "#3a2a24", "#ead6c2"],
];
async function photo(i, w = 900, h = 700) {
  const [a, b, c] = SCENES[i % SCENES.length];
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<body style="margin:0;width:${w}px;height:${h}px;background:linear-gradient(160deg,${c} 0%,${a} 55%,${b} 100%);position:relative;overflow:hidden">
    <div style="position:absolute;left:${10 + i * 7}%;bottom:-12%;width:60%;height:55%;border-radius:50%;background:${b};opacity:.55;filter:blur(8px)"></div>
    <div style="position:absolute;right:${8 + i * 3}%;top:14%;width:22%;height:28%;border-radius:50%;background:${c};opacity:.8;filter:blur(2px)"></div>
    <div style="position:absolute;left:12%;top:${30 + i * 2}%;width:36%;height:40%;background:${a};opacity:.5;transform:rotate(${i * 9 - 20}deg);filter:blur(1px)"></div></body>`);
  const jpg = await p.screenshot({ type: "jpeg", quality: 82 });
  await p.close();
  return jpg;
}
const imgDir = config.imagenOutputDir; mkdirSync(imgDir, { recursive: true });
for (const [i, name] of ["peaches", "olmsted", "lilia"].entries()) writeFileSync(join(imgDir, `${name}-sample01.jpg`), await photo(i));

const T = (iso) => new Date(iso).getTime();
const setNow = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };
const page = (title, blocks, { subtitle = null, at = "2026-10-26T16:16:00-04:00" } = {}) => {
  setNow(T(at));
  const p = db.createPage(OWNER, { title, blocks, subtitle });
  db.db.prepare("UPDATE pages SET created_at = ?, updated_at = ? WHERE id = ?").run(T(at), T(at), p.id);
  return db.getPage(p.id);
};

// ---- P1 shortlist: cards + the choice of them ----
const shortlist = page("Dinner, Friday, three that fit.", [
  { type: "cards", items: [
    { title: "Peaches", image: `${BASE}/img/peaches-sample01.jpg`, note: "Closest to everyone.", at: "7:30 PM", pick: true, opinion: "closest to everyone.",
      facts: [{ label: "Open", value: "7:30 PM" }, { label: "From everyone", value: "12–18 min" }, { label: "Per person", value: "$$" }] },
    { title: "Olmsted", image: `${BASE}/img/olmsted-sample01.jpg`, note: "Quieter, a longer ride for two of you.", at: "8:15 PM",
      facts: [{ label: "Open", value: "8:15" }, { label: "From all", value: "25 min" }, { label: "Each", value: "$$" }] },
    { title: "Lilia", image: `${BASE}/img/lilia-sample01.jpg`, note: "Best food, latest table.", at: "9:00 PM",
      facts: [{ label: "Open", value: "9:00" }, { label: "From all", value: "20 min" }, { label: "Each", value: "$$$" }] },
  ] },
  { type: "choice", key: "dinner", question: "Which one?", options: [{ label: "Peaches" }, { label: "Olmsted" }, { label: "Lilia" }] },
], { subtitle: "Brooklyn · 4 people · Fri 7–9 pm" });

// ---- P3 a call: a real calls row, its recording on disk ----
const call = db.createCall(OWNER, { provider: "fake", toNumber: "+17185550188", isOwner: false, goal: "book a dentist appointment this week",
  announcement: "Hi, I'm an AI assistant calling on behalf of Omari. This call is recorded." });
mkdirSync(config.recordingRoot, { recursive: true });
const wav = join(config.recordingRoot, `call-${call.id}.wav`);
copyFileSync(new URL("../src/calls/fixture-recording.wav", import.meta.url), wav);
db.db.prepare(`UPDATE calls SET state = 'completed', outcome_kind = 'confirmed', duration_s = 102, recording_state = 'stored', recording_file = ?, recording_format = 'wav',
  recording_seconds = 102, summary = 'Asked for this week. They had Thursday 3pm or Friday 9am. Took Thursday, since your Friday morning is a flight.',
  transcript = ?, created_at = ?, updated_at = ? WHERE id = ?`).run(wav,
  "Reason: Hi, I'm an AI assistant calling on behalf of Omari. This call is recorded.\nThem: Dr. Patel's office, how can I help?\nReason: Do you have anything this week for a cleaning?\nThem: Thursday at three or Friday at nine.\nReason: Thursday at three, please.\nThem: You're all set. Bring the new insurance card, we don't have it on file.",
  T("2026-10-27T14:04:00-04:00"), T("2026-10-27T14:06:00-04:00"), call.id);
const callPage = page("Dr. Patel's office", [{ type: "call", call_id: call.id, points: ["Asked for this week. They had Thursday 3pm or Friday 9am.", "Took Thursday, since your Friday morning is a flight."], worth_knowing: "bring your new insurance card. they don't have it on file." }], { at: "2026-10-27T14:07:00-04:00" });

// ---- P6 a receipt: a purchase that went through, the owner's yes, the card ----
const conf = db.askConfirmation({ conversationId: OWNER, action: "agentcard_buy", summary: "Pay the Con Edison October bill, $87.40", stakes: "money", askedAfterMsgs: 0 });
setNow(T("2026-10-27T17:31:00-04:00"));
db.grantConfirmation(conf.id, "yes pay it");
db.recordAgentcardPurchase({ conversationId: OWNER, buyConversationId: "buy:coned-oct", status: "placed", amountCents: 8740, merchant: "Con Edison", what: "October bill" });
db.markAgentcardPurchase("buy:coned-oct", { status: "placed", retailerOrderId: "CE-48213907", confirmationId: conf.id });
db.db.prepare("UPDATE agentcard_purchases SET confirmation_id = ?, updated_at = ? WHERE buy_conversation_id = 'buy:coned-oct'").run(conf.id, T("2026-10-27T17:31:00-04:00"));
db.db.prepare(`INSERT INTO agentcard_users (conversation_id, user_id, card_brand, card_last4, created_at, updated_at) VALUES (?, 'u_sample', 'Visa', '4417', ?, ?)`).run(OWNER, Date.now(), Date.now());
const purchase = db.getAgentcardPurchase("buy:coned-oct");
const receiptPage = page("Con Ed, paid.", [{ type: "receipt", purchase_id: purchase.id, note: "due friday, paid tuesday. you're good." }], { at: "2026-10-27T17:32:00-04:00" });

// ---- P2 the day ----
const dayPage = page("Today, in five things.", [{ type: "day", note: "a good one.", tomorrow: "Nothing open. I'll check your flight at 6.", items: [
  { at: "7:00", title: "Flight moved, car pushed", detail: "8:40 from gate B12, pickup 6:30", stamp: "done" },
  { at: "12:30", title: "1,890 calories", detail: "310 under your goal" },
  { at: "2:00", title: "Dentist, Thursday 3pm", stamp: "done", link: { label: "Hear the call · 1:42", url: `${BASE}/p/${callPage.id}` } },
  { at: "4:15", title: "Peaches, Friday 7:30", detail: "Party of four", stamp: "done" },
  { at: "5:30", title: "Con Ed paid, $87.40", stamp: "paid", link: { label: "Receipt", url: `${BASE}/p/${receiptPage.id}` } },
] }], { at: "2026-10-26T21:30:00-04:00" });

// ---- E4: an archived page ----
const oldPage = page("Dinner, Friday, three that fit.", shortlist.blocks, { subtitle: shortlist.subtitle });
db.archivePage(OWNER, oldPage.id);

// ---- P4 / P5: an event with guests, and its album ----
setNow(T("2026-11-01T12:00:00-05:00"));
const created = events.create(OWNER, { name: "A weekend upstate", description: "Two nights at the farmhouse. Bring boots.", starts_at: "2026-11-14T16:00", location: "Farmhouse Inn, Hudson",
  password: "woodstove", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, timezone: "America/New_York" });
if (!created.ok) throw new Error(`event: ${JSON.stringify(created)}`);
const ev0 = db.getEventRow(created.event?.event_id ?? created.event?.id ?? created.id);
db.db.prepare("UPDATE events SET time_public = 1, location_public = 1, time_released = 1, location_released = 1 WHERE id = ?").run(ev0.id);
for (const [c, name] of [[KOFI, "Kofi"], [AMA, "Ama"], [YAW, "Yaw"]]) {
  const r = await events.joinExisting({ conversationId: c, name: "A weekend upstate", password: "woodstove", displayName: name });
  if (!r.ok) throw new Error(`join ${name}: ${JSON.stringify(r)}`);
}
const ev = db.getEventRow(ev0.id);
const rt = { async _tell() { return { ok: true }; }, async say() {} };
let k = 0;
const fetchImpl = async () => new Response(await photo(k++, 800, 1000), { status: 200, headers: { "content-type": "image/jpeg" } });
const mediaFor = (c, n) => Array.from({ length: n }, (_, i) => db.recordMedia({ conversationId: c, channel: "fake", externalId: `m${c}${i}`, ordinal: 0, kind: "image", filename: "p.jpg", url: `https://cdn.example.test/${c}/${i}.jpg` }).id);
for (const [c, n] of [[KOFI, 4], [AMA, 3], [YAW, 3]]) {
  const out = await albums.contribute({ ev, conversationId: c, mediaIds: mediaFor(c, n), fetchImpl });
  if (!out.ok) throw new Error(`album: ${JSON.stringify(out)}`);
}
const album = db.albumOf(ev.id);
db.releaseAlbum(album.id, { releasedAt: clock.now(), expiresAt: clock.now() + 14 * 86400_000 });
for (const c of [KOFI, AMA, YAW]) {
  const att = db.attendeeRow(ev.id, c);
  await albums.checkIn({ runtime: rt, ev, conversationId: OWNER, guestId: att.id, present: true });
}
// A second event, cancelled: E2.
const off = events.create(OWNER, { name: "Rooftop, Saturday", description: "Called off.", starts_at: "2026-11-21T19:00", location: "Bushwick", password: "roofroof", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, timezone: "America/New_York" });
if (!off.ok) throw new Error(`off: ${JSON.stringify(off)}`);
const offEv = db.getEventRow(off.event?.event_id ?? off.event?.id ?? off.id);
db.db.prepare("UPDATE events SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(clock.now(), offEv.id);

// ---- sessions: the owner's browser, and a guest's ----
const sess = (c, pageId) => { const t = `t-${c.replace(/\W/g, "")}-${Math.random().toString(36).slice(2)}`; db.startPageSession(pageId, t, { conversationId: c }); return t; };
const ownerT = sess(OWNER, shortlist.id);
const kofiPage = db.createPage(KOFI, { title: "Kofi's list", blocks: [{ type: "text", text: "Kofi's own page." }] });
const kofiT = sess(KOFI, kofiPage.id);
clock.reset();

const server = createServer({ router: { webhook: async () => ({ status: 404, body: {} }), statuses: () => [], list: () => [] }, runtime: rt });
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const SHOTS = [
  ["shortlist", `/p/${shortlist.id}`, ownerT],
  ["day", `/p/${dayPage.id}`, ownerT],
  ["call", `/p/${callPage.id}`, ownerT],
  ["event", `/e/${ev.public_id}`, kofiT],
  ["event-public", `/e/${ev.public_id}`, ""],
  ["album", `/e/${ev.public_id}/album`, kofiT],
  ["receipt", `/p/${receiptPage.id}`, ownerT],
  ["edge-turned-off", `/e/${offEv.public_id}`, ""],
  ["edge-not-yours", `/p/${shortlist.id}`, kofiT],
  ["edge-archived", `/p/${oldPage.id}`, ownerT],
];
const index = [];
for (const [name, path, token] of SHOTS) {
  for (const [w, h] of [[390, 844], [1280, 900]]) {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme });
      if (token) await ctx.addCookies([{ name: "reason_page", value: token, url: BASE }]);
      const p = await ctx.newPage();
      const res = await p.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await p.evaluate(() => document.fonts.ready);
      const file = join(OUT, `pages-${name}-${w}-${scheme === "light" ? "paper" : "night"}.png`);
      await p.screenshot({ path: file, fullPage: true });
      index.push({ name, w, scheme, status: res.status(), file });
      await ctx.close();
    }
  }
}
// The two link-preview cards, as a phone fetches them.
for (const [name, path] of [["og-private", "/p/og/private.png"], ["og-event", `/e/${ev.public_id}/cover.jpg`]]) {
  const r = await fetch(`${BASE}${path}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(OUT, `${name}.${path.endsWith(".png") ? "png" : "jpg"}`), bytes);
  index.push({ name, status: r.status, bytes: bytes.length });
}
// And what each private page tells a link preview.
const head = await (await fetch(`${BASE}/p/${shortlist.id}?k=${shortlist.owner_key}`)).text();
index.push({ name: "gate-og", tags: [...head.matchAll(/<meta property="og:[^>]+>/g)].map(m => m[0]) });
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2));
await browser.close();
server.close();
console.log(JSON.stringify(index.map(i => [i.name, i.w ?? "", i.scheme ?? "", i.status]), null, 0));
