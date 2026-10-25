// The event link's card in Messages (events spec §14, test 18): the og tags are in the served HTML
// (no script needed), the card never carries the password, a guest's name or a hidden detail, the
// organizer sees the exact public card before an uploaded cover goes live, a flyer showing a hidden
// time or address is flagged and BLOCKED until it is replaced or the detail is deliberately made
// public in a later text, a turned-down flyer leaves the previous cover alone, and Reason's own
// cover shows the name large. Pictures are read by a stand-in here; test/event-cover-live.test.js
// (opt-in) reads a real flyer with the model on the subscription.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-cover-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_EVENTS = "on";

const { runTool } = await import("../src/tools.js");
const events = await import("../src/events.js");
const cover = await import("../src/eventcover.js");
const db = await import("../src/db.js");
const { eventRequestFor } = await import("../src/http.js");
const { linkParts } = await import("../src/links.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const AMA_C = "dm:fake:+13475550000";

// A real 1×1 PNG: fetchImage sniffs the bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fetchImpl = async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } });

let shots = 0;
cover._setShoot(async (html) => { shots++; return Buffer.from(`JPEG:${html.length}:${shots}`); });
/** What the stand-in reader says each photo shows, by media id. */
const readings = new Map();
let lastMedia = 0;
cover._setReader(async () => readings.get(lastMedia) ?? { ok: true, words: "", shows_time: false, time_shown: "", shows_place: false, place_shown: "", names_shown: [] });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  readings.clear();
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM media_items; DELETE FROM inbound_messages; DELETE FROM threads;`);
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertThread({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", isOwner: false });
});

function fakeRuntime() {
  return {
    say: (c, t) => t,
    async _tell(conversationId, text, { idempotencyKey }) {
      const now = clock.now();
      db.db.prepare(`INSERT OR IGNORE INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at) VALUES (?, ?, 'fake', 'x', ?, 'sent', ?, ?)`).run(idempotencyKey, conversationId, text, now, now);
      return { ok: true };
    },
  };
}
const pictures = [];
const channels = { sendMediaUrl: async (m) => { pictures.push(m); return { ok: true }; } };
const tool = (name, input, c = KOFI_C) => runTool(name, input, { conversationId: c, messages: [], events: fakeRuntime(), channels, fetchImpl });
let n = 0;
/** The organizer texts something: a later inbound message, a moment later. */
function theyText(c = KOFI_C) {
  clock.skip(1000);
  db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('fake', ?, ?, ?)").run(`m${++n}`, c, clock.now());
  clock.skip(1000);
}
function photo(reading, c = KOFI_C) {
  const id = db.recordMedia({ conversationId: c, channel: "fake", externalId: `x${++n}`, ordinal: 0, kind: "image", filename: "flyer.png", url: "https://cdn.example.test/flyer.png" });
  const mid = Number(id?.id ?? id);
  if (reading) readings.set(mid, { ok: true, words: "", shows_time: false, time_shown: "", shows_place: false, place_shown: "", names_shown: [], ...reading });
  return mid;
}
async function useP(ev, mid) { lastMedia = mid; return await tool("event_cover", { event_id: ev.id, action: "use_photo", photo_id: mid }); }

async function made(over = {}) {
  const out = await tool("event_create", {
    name: "Halloween Party", description: "costumes mandatory", starts_at: "2026-10-31T21:00", location: "12 Elm St, Apt 4",
    welcome_message: "", password: "pumpkin", show_time_on_join: false, show_location_on_join: false, guest_list_visible: true, ...over,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return { ev: db.getEventRow(out.event.event_id), out };
}
const fresh = (ev) => db.getEventRow(ev.id);
const getPage = async (ev, sub = null, query = {}) => eventRequestFor({ publicId: ev.public_id, sub, method: "GET", query, headers: {}, remoteAddress: "127.0.0.1", readBody: async () => "" });
const metas = (html) => [...html.matchAll(/<meta [^>]*>/g)].map(m => m[0]).join("\n");
const ogImage = (html) => /og:image" content="([^"]+)"/.exec(html)?.[1];

test("og tags are in the served HTML — name, invitation line, absolute cover — no script needed", async () => {
  const { ev } = await made();
  const r = await getPage(ev);
  assert.equal(r.status, 200);
  const head = r.body.slice(0, r.body.indexOf("</head>"));
  assert.match(head, /og:title" content="Halloween Party"/);
  assert.match(head, new RegExp(`og:description" content="${cover.INVITE_LINE.replace(/'/g, "&#39;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(head, new RegExp(`og:image" content="https://files\\.example\\.test/e/${ev.public_id}/cover\\.jpg\\?v=g[0-9a-f]{10}"`));
  assert.match(head, /og:image:width" content="1200"/);
  assert.match(head, /twitter:card" content="summary_large_image"/);
  // Nothing on the page is put there by a script: Messages runs none.
  assert.doesNotMatch(r.body, /<script/i);
  // The picture itself is served, publicly, as a JPEG.
  const img = await getPage(ev, "cover.jpg");
  assert.equal(img.status, 200);
  assert.equal(img.headers["Content-Type"], "image/jpeg");
});

test("the card never carries the password, a guest's name, or a hidden time or place", async () => {
  const { ev } = await made({ description: "Kofi's party at 12 Elm St" });
  await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin", displayName: "Ama Mensah" });
  for (const r of [await getPage(ev), await getPage(ev, "signin")]) {
    const m = metas(r.body);
    for (const bad of ["pumpkin", "Ama", "Elm", "12 Elm", "9:00", "Oct 31", "costumes"]) assert.ok(!m.includes(bad), `card carries ${bad}`);
  }
  // A paused event still shows its card, the same safe one.
  db.updateEventRow(ev.id, { status: "paused" });
  assert.ok(!metas((await getPage(ev)).body).includes("Elm"));
});

test("an uploaded cover: the organizer is shown the exact public card first, and only a later yes makes it live", async () => {
  const { ev } = await made();
  const before = ogImage((await getPage(ev)).body);
  pictures.length = 0;
  const out = await useP(ev, photo({}));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.waiting, true);
  assert.equal(out.card_picture_sent_to_them, true);
  assert.equal(out.card.title, "Halloween Party");
  assert.equal(out.card.line, cover.INVITE_LINE);
  // The picture sent to them is the waiting card, by its private address — to them, nobody else.
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].to, "+14155559876");
  assert.match(pictures[0].mediaUrl, new RegExp(`/e/${ev.public_id}/cover-preview\\.jpg\\?k=`));
  const k = new URL(pictures[0].mediaUrl).searchParams.get("k");
  assert.equal((await getPage(fresh(ev), "cover-preview.jpg", { k })).status, 200);
  assert.equal((await getPage(fresh(ev), "cover-preview.jpg", { k: "x".repeat(k.length) })).status, 404);
  // Not live yet: the public card still uses Reason's drawn cover.
  assert.equal(ogImage((await getPage(fresh(ev))).body), before);
  // The same turn cannot approve it: they have to answer after seeing it.
  const early = await tool("event_cover", { event_id: ev.id, action: "approve" });
  assert.equal(early.ok, false);
  assert.match(early.error, /haven't answered/);
  theyText();
  const ok = await tool("event_cover", { event_id: ev.id, action: "approve" });
  assert.equal(ok.live, true, JSON.stringify(ok));
  const row = fresh(ev);
  assert.equal(row.cover_approved_by, KOFI_C);
  assert.ok(row.cover_approved_at > 0);
  assert.match(ogImage((await getPage(row)).body), /cover\.jpg\?v=u1$/);
});

test("a flyer showing the hidden address is flagged and blocked; only an explicit make-public in a later text clears it", async () => {
  const { ev } = await made();
  const out = await useP(ev, photo({ shows_place: true, place_shown: "12 Elm St" }));
  assert.equal(out.blocked, true);
  assert.deepEqual(out.flagged, ['Your flyer shows a location ("12 Elm St"), but the location is hidden.']);
  assert.match(out.say, /Never offer to use it anyway/);
  theyText();
  const no = await tool("event_cover", { event_id: ev.id, action: "approve" });
  assert.equal(no.blocked, true);
  assert.equal(fresh(ev).cover_file, "");
  // Making it public is two steps: a question, then their answer in a later text.
  const ask = await tool("event_detail_public", { event_id: ev.id, detail: "location" });
  assert.equal(ask.needs_answer, true);
  assert.match(ask.ask, /ANYONE with the link/);
  assert.equal(fresh(ev).location_public, 0);
  const sameTurn = await tool("event_detail_public", { event_id: ev.id, detail: "location", confirm: true });
  assert.equal(sameTurn.ok, false);
  assert.equal(fresh(ev).location_public, 0);
  // Confirming without having been asked about THIS detail does nothing either.
  theyText();
  assert.equal((await tool("event_detail_public", { event_id: ev.id, detail: "time", confirm: true })).ok, false);
  const yes = await tool("event_detail_public", { event_id: ev.id, detail: "location", confirm: true });
  assert.equal(yes.public, true, JSON.stringify(yes));
  assert.equal(yes.waiting_cover.clear, true);
  const row = fresh(ev);
  assert.equal(row.location_public, 1);
  assert.equal(row.location_released, 1, "public to anyone includes joined guests");
  assert.equal((await tool("event_cover", { event_id: ev.id, action: "approve" })).live, true);
  // The join page now shows the place to anyone; the time is still hidden.
  const page = (await getPage(fresh(ev))).body;
  assert.match(page, /Where:<\/b> 12 Elm St, Apt 4/);
  assert.doesNotMatch(page, /When:/);
  // And it cannot be hidden again while the live cover shows it.
  assert.equal((await tool("event_detail_public", { event_id: ev.id, detail: "location", public: false })).ok, false);
});

test("a flyer showing the hidden time is blocked until it is replaced with a clean picture", async () => {
  const { ev } = await made();
  const out = await useP(ev, photo({ shows_time: true, time_shown: "SAT 10.31 9PM" }));
  assert.equal(out.blocked, true);
  assert.match(out.flagged[0], /shows a time \("SAT 10\.31 9PM"\), but the time is hidden/);
  const cropped = await useP(ev, photo({}));
  assert.equal(cropped.blocked, undefined);
  theyText();
  assert.equal((await tool("event_cover", { event_id: ev.id, action: "approve" })).live, true);
});

test("the password and guests' names in a flyer always block, and can't be made public", async () => {
  const { ev } = await made();
  await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin", displayName: "Ama Mensah" });
  const out = await useP(ev, photo({ words: "HALLOWEEN\npassword: pumpkin", names_shown: ["ama mensah", "DJ Spinz"] }));
  assert.equal(out.blocked, true);
  assert.ok(out.flagged.some(f => /event password/.test(f)));
  assert.ok(out.flagged.some(f => /a guest's name \(Ama Mensah\)/.test(f)));
  assert.ok(!out.flagged.some(f => /DJ Spinz/.test(f)), "a performer is not a guest");
});

test("a picture that can't be read is blocked, never passed", async () => {
  const { ev } = await made();
  const mid = photo();
  readings.set(mid, { ok: false, error: "cli down" });
  const out = await useP(ev, mid);
  assert.equal(out.blocked, true);
  assert.match(out.flagged[0], /couldn't read the picture/);
});

test("a rejected flyer keeps the previous cover", async () => {
  const { ev } = await made();
  await useP(ev, photo({}));
  theyText();
  await tool("event_cover", { event_id: ev.id, action: "approve" });
  const live = fresh(ev);
  const liveImg = ogImage((await getPage(live)).body);
  const liveBytes = (await getPage(live, "cover.jpg")).body;
  const flagged = await useP(live, photo({ shows_place: true, place_shown: "Elm St" }));
  assert.equal(flagged.blocked, true);
  theyText();
  assert.equal((await tool("event_cover", { event_id: ev.id, action: "approve" })).blocked, true);
  assert.equal((await tool("event_cover", { event_id: ev.id, action: "discard" })).discarded, true);
  const after = fresh(ev);
  assert.equal(after.cover_file, live.cover_file);
  assert.equal(after.cover_pending, "");
  assert.equal(ogImage((await getPage(after)).body), liveImg);
  assert.deepEqual((await getPage(after, "cover.jpg")).body, liveBytes);
});

test("guests can't touch the cover; remove goes back to Reason's drawn cover", async () => {
  const { ev } = await made();
  await events.joinExisting({ conversationId: AMA_C, name: "Halloween Party", password: "pumpkin", displayName: "Ama" });
  const g = await tool("event_cover", { event_id: ev.id, action: "status" }, AMA_C);
  assert.equal(g.ok, false);
  await useP(ev, photo({}));
  theyText();
  await tool("event_cover", { event_id: ev.id, action: "approve" });
  const r = await tool("event_cover", { event_id: ev.id, action: "remove" });
  assert.match(r.note, /drawn cover/);
  assert.match(ogImage((await getPage(fresh(ev))).body), /v=g[0-9a-f]{10}$/);
});

test("Reason's drawn cover: the name large and the mark small", () => {
  const html = cover.generatedHtml("Ama's 30th — Rooftop");
  assert.match(html, /Ama&#39;s 30th — Rooftop|Ama's 30th — Rooftop/);
  const size = Number(/font:500 (\d+)px/.exec(html)[1]);
  assert.ok(size >= 64, `name at ${size}px`);
  assert.match(html, /class="mark"/);
  assert.match(cover.generatedHtml("x".repeat(110)), /font:500 64px/);
});

test("the share text never holds the link; the link goes as its own bubble", async () => {
  const { out, ev } = await made();
  assert.ok(!out.share.share_text.includes("http"));
  assert.match(out.share.share_text, /pumpkin/);
  assert.match(out.say, /OWN message/);
  // As Reason sends it: share text, then the link alone — the link is a bubble by itself.
  const parts = linkParts(`${out.share.share_text}\n\n${out.share.link}`);
  assert.ok(parts.includes(events.eventUrl(ev)), JSON.stringify(parts));
  // The share text carries the password, so no log line keeps it.
  const { sealTravelers } = await import("../src/privacy.js");
  assert.ok(!JSON.stringify(sealTravelers("event_create", { out })).includes("pumpkin"));
});

test("the real renderer draws a 1200×630 JPEG of the drawn cover (skipped without Chromium)", async (t) => {
  const was = cover._setShoot(null);
  try {
    const { ev } = await made({ name: "Rooftop Halloween" });
    let file;
    try { file = await cover.coverFile(fresh(ev)); }
    catch (e) { t.skip(`no Chromium here: ${e.message.split("\n")[0]}`); return; }
    const b = readFileSync(file);
    assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8);
    // Width and height from the JPEG's frame header.
    let i = 2, w = 0, h = 0;
    while (i < b.length) { const m = b[i + 1]; const len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + len; }
    assert.deepEqual([w, h], [1200, 630]);
    assert.ok(b.length < 1_000_000);
    assert.ok(existsSync(file));
  } finally { cover._setShoot(was); }
});
