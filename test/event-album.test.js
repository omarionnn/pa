// The event photo album (src/albums.js, src/albumtools.js, src/pages/album.js), pinned to the
// album spec's "done when": a batch "for <event>" lands in the right album under the contributor's
// display name and attendees cannot see it until release; an unnamed batch with two matching events
// gets a question, not a guess; release sends exactly one announcement to checked-in guests and later
// uploads send none; a forwarded link does nothing for the wrong person and a non-attendee opens
// nothing; the album shows the exact expiry and after it the page is closed and the files are gone;
// and the events feature and its prompt are exactly as they were.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-album-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_CADDY_SECRET = "caddy-test"; // what Caddy adds beside its marker (src/pages/siteproxy.js caddyClientIp)
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_EVENTS = "on";
process.env.REASON_EVENT_ALBUMS = "on";

const { runTool, toolsFor } = await import("../src/tools.js");
const { EVENT_TOOL_DEFS } = await import("../src/eventtools.js");
const { SYSTEM } = await import("../src/agent.js");
const events = await import("../src/events.js");
const albums = await import("../src/albums.js");
const db = await import("../src/db.js");
const { eventRequestFor } = await import("../src/http.js");
const { Runtime } = await import("../src/runtime.js");
const { clock, config } = await import("../src/config.js");

const OWNER_C = "dm:owner";
const KOFI_C = "dm:fake:+14155559876";
const AMA_C = "dm:fake:+13475550000";
const YAW_C = "dm:fake:+16465550111";
const ESI_C = "dm:fake:+12125550123";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.events = true;
  config.eventAlbums = true;
  config.albumRetentionDays = 3;
  db.db.exec(`DELETE FROM accounts; DELETE FROM events; DELETE FROM event_attendees; DELETE FROM event_messages; DELETE FROM event_deliveries;
    DELETE FROM event_join_attempts; DELETE FROM event_claims; DELETE FROM outbox; DELETE FROM media_items; DELETE FROM inbound_messages;
    DELETE FROM page_sessions; DELETE FROM event_albums; DELETE FROM event_photos; DELETE FROM event_checkins; DELETE FROM album_consents;`);
  rmSync(join(dir, "data", "event-albums"), { recursive: true, force: true });
  db.upsertAccount({ conversationId: OWNER_C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: "+14155559876", name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: "+13475550000", name: "Ama" });
  db.upsertAccount({ conversationId: YAW_C, channel: "fake", address: "+16465550111", name: "Yaw" });
  db.upsertAccount({ conversationId: ESI_C, channel: "fake", address: "+12125550123", name: "Esi" });
});

/** Sends the way the runtime does, with the outbox's one-row-per-key rule. */
function fakeRuntime() {
  const sent = [];
  return {
    sent,
    async _tell(conversationId, text, { idempotencyKey }) {
      const have = db.db.prepare("SELECT * FROM outbox WHERE idem_key = ?").get(idempotencyKey);
      if (have) return { ok: true, outbox_id: have.id, duplicate: true };
      sent.push({ conversationId, text });
      const now = clock.now();
      const id = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at)
        VALUES (?, ?, 'fake', 'x', ?, 'sent', ?, ?)`).run(idempotencyKey, conversationId, text, now, now).lastInsertRowid;
      return { ok: true, outbox_id: Number(id) };
    },
  };
}
// A valid 1×1 PNG; each photo gets its own trailing bytes so two photos are never the same picture.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fetchImpl = async (url) => {
  const body = Buffer.concat([PNG, Buffer.from(String(url))]);
  return new Response(body, { status: 200, headers: { "content-type": "image/png", "content-length": String(body.length) } });
};
const tool = (name, input, c, rt = fakeRuntime()) => runTool(name, input, { conversationId: c, messages: [], events: rt, fetchImpl });

let n = 0;
/** A photo arrived in this conversation: its media row, as the router writes one. */
const photo = (c, name = "img.jpg") => db.recordMedia({ conversationId: c, channel: "fake", externalId: `x${++n}`, ordinal: 0, kind: "image", filename: name, url: `https://cdn.example.test/${n}.jpg` }).id;
/** They texted something (what, the model reads): the inbound row `lastInboundAt` counts. */
const texted = (c) => { clock.skip(1000); db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('fake', ?, ?, ?)").run(`m${++n}`, c, clock.now()); };

const answers = (over = {}) => ({
  name: "Game Night", description: "bring snacks", starts_at: "2026-10-31T20:00", location: "41 Grove St",
  password: "catan", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true, ...over,
});
async function made(c = KOFI_C, over = {}) {
  const out = await tool("event_create", answers(over), c);
  assert.equal(out.ok, true, JSON.stringify(out));
  return db.getEventRow(out.event.event_id);
}
async function joinAs(c, name = "Game Night", password = "catan", displayName = null) {
  const r = await events.joinExisting({ conversationId: c, name, password, displayName });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.attendee;
}
/** First contribution: the note, their yes in a later text, then the add. Returns the add result. */
async function addFirst(c, ev, ids, rt) {
  const ask = await tool("album_add", { event_id: ev.id, event_named: ev.name, photo_ids: ids }, c, rt);
  if (ask.ok && !ask.needs_answer) return ask; // the note was answered before (another event of theirs): straight in
  assert.equal(ask.needs_answer, true, JSON.stringify(ask));
  texted(c);
  return await tool("album_add", { event_id: ev.id, event_named: ev.name, photo_ids: ids, agreed: true }, c, rt);
}
const files = (ev) => albums.filesLeft(ev);

async function req(ev, { sub = "album", method = "GET", body = null, query = {}, cookie = "", rt = fakeRuntime() } = {}) {
  const out = await eventRequestFor({
    publicId: ev.public_id, sub, method, query, headers: { cookie, "x-forwarded-for": "203.0.113.9", "x-files-domain": "true", "x-reason-caddy": "caddy-test" }, remoteAddress: "127.0.0.1",
    readBody: async () => body, runtime: rt, router: null,
  });
  // The page's words, for matching: the part after the stylesheet, with entities read back.
  if (typeof out.body === "string") out.text = String(out.body).split("<main").pop().replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return out;
}
const asBrowser = (c, tok) => { db.startPageSession(`p-${tok}`, tok, { conversationId: c }); return `reason_page=${tok}`; };
const form = (o) => new URLSearchParams(o).toString();

// ---------- contributing ----------

test("a batch 'for <event>' lands in that album under the contributor's display name; nothing is stored before the note is answered in a later text", async () => {
  const ev = await made();
  await joinAs(AMA_C, "Game Night", "catan", "Ama B");
  const ids = [photo(AMA_C), photo(AMA_C)];
  const ask = await tool("album_add", { event_id: ev.id, photo_ids: ids }, AMA_C);
  assert.equal(ask.needs_answer, true);
  assert.match(ask.ask, /shared with checked-in attendees after the organizer releases the album/);
  assert.match(ask.ask, /save or screenshot/);
  assert.match(ask.ask, /three days after it's released, then the photos are deleted/, "the retention rule is in the note");
  assert.equal(db.albumOf(ev.id) == null || db.photoCount(db.albumOf(ev.id).id) === 0, true, "nothing stored on the ask");
  // The same turn cannot be the yes.
  const early = await tool("album_add", { event_id: ev.id, photo_ids: ids, agreed: true }, AMA_C);
  assert.equal(early.ok, false);
  assert.match(early.error, /haven't answered/);
  texted(AMA_C);
  const out = await tool("album_add", { event_id: ev.id, photo_ids: ids, agreed: true }, AMA_C);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.added.length, 2);
  assert.equal(out.shared_as, "Ama B");
  assert.equal(out.released, false);
  assert.equal(files(ev), 2, "two files on disk under the event's directory");
  // The second batch goes straight in, and the same picture twice is not a second photo.
  const again = await tool("album_add", { event_id: ev.id, photo_ids: [ids[0], photo(AMA_C)] }, AMA_C);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual([again.added.length, again.duplicates], [1, [ids[0]]]);
  assert.equal(files(ev), 3);
  // A photo that is not theirs, or not a photo, is said as such — never counted as added.
  const bad = await tool("album_add", { event_id: ev.id, photo_ids: [photo(YAW_C), 99999] }, AMA_C);
  assert.equal(bad.ok, true);
  assert.equal(bad.added.length, 0);
  assert.equal(bad.failed.length, 2);
  assert.match(bad.note, /NOT added/);
  // No phone number anywhere in what the model or a page gets.
  const page = await req(ev, { sub: "album/manage", cookie: asBrowser(KOFI_C, "tok-kofi-1") });
  assert.equal(page.status, 200);
  assert.match(page.text, /Shared by Ama B/);
  assert.ok(!/\+1\d{10}|3475550000/.test(page.text), "never a number");
});

test("an unnamed batch with two events it could be for is asked about, not guessed", async () => {
  const a = await made(KOFI_C, { name: "Game Night" });
  const b = await made(YAW_C, { name: "Rooftop Party", password: "sunset" });
  await joinAs(AMA_C, "Game Night", "catan");
  await joinAs(AMA_C, "Rooftop Party", "sunset");
  db.agreeAlbumConsent(AMA_C, clock.now());
  const out = await tool("album_add", { event_id: a.id, photo_ids: [photo(AMA_C)] }, AMA_C);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "which_event");
  assert.deepEqual(out.choices.map(c => c.name).sort(), ["Game Night", "Rooftop Party"]);
  assert.equal(files(a) + files(b), 0, "nothing was stored");
  const named = await tool("album_add", { event_id: a.id, event_named: "game night", photo_ids: [photo(AMA_C)] }, AMA_C);
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.equal(named.added.length, 1);
  assert.equal(files(a), 1);
});

test("the contributor removes their own, the organizer any, nobody else's — and removing deletes the file", async () => {
  const ev = await made();
  await joinAs(AMA_C); await joinAs(YAW_C);
  const ama = await addFirst(AMA_C, ev, [photo(AMA_C)]);
  const yaw = await addFirst(YAW_C, ev, [photo(YAW_C)]);
  assert.equal(files(ev), 2);
  const wrong = await tool("album_remove", { event_id: ev.id, photo_ids: [yaw.added[0]] }, AMA_C);
  assert.deepEqual([wrong.removed, wrong.refused], [[], [yaw.added[0]]]);
  assert.equal(files(ev), 2);
  const own = await tool("album_remove", { event_id: ev.id, photo_ids: [ama.added[0]] }, AMA_C);
  assert.deepEqual(own.removed, [ama.added[0]]);
  assert.equal(files(ev), 1);
  const org = await tool("album_manage", { event_id: ev.id, action: "remove", photo_ids: [yaw.added[0]] }, KOFI_C);
  assert.deepEqual(org.removed, [yaw.added[0]]);
  assert.equal(files(ev), 0);
  assert.equal(db.photoCount(db.albumOf(ev.id).id), 0);
});

// ---------- access and release ----------

test("attendees cannot see the album before release; release sends exactly one announcement to checked-in guests; later uploads send none", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C); await joinAs(YAW_C); await joinAs(ESI_C);
  await addFirst(AMA_C, ev, [photo(AMA_C), photo(AMA_C)], rt);
  await addFirst(YAW_C, ev, [photo(YAW_C)], rt);
  // Before release: a guest's page shows their own photos only; the organizer's shows everything.
  let page = await req(ev, { cookie: asBrowser(AMA_C, "tok-ama-1") });
  assert.equal(page.status, 200);
  assert.match(page.text, /hasn't released the album yet/);
  assert.match(page.text, /Your photos/);
  assert.ok(!/Everyone's photos|Download album|Shared by Yaw/.test(page.text), "nothing of anybody else's before release");
  assert.ok(!/Check in|End event and release/.test(page.text), "a guest never gets organizer controls");
  page = await req(ev, { sub: "album/manage", cookie: asBrowser(KOFI_C, "tok-kofi-1") });
  assert.match(page.text, /End event and release album/);
  assert.match(page.text, /Shared by Ama/); assert.match(page.text, /Shared by Yaw/);
  assert.match(page.text, /0 of 3 checked in/);
  // Check Ama and Yaw in; Esi stays out. Nothing is sent by checking in before release.
  const guests = db.attendeesOf(ev.id);
  for (const g of guests.filter(a => a.conversation_id !== ESI_C)) {
    const r = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: g.id }, KOFI_C, rt);
    assert.equal(r.guests[0].checked_in, true, JSON.stringify(r));
  }
  assert.equal(rt.sent.length, 0);
  // A checked-in guest still sees nothing of others' until release.
  page = await req(ev, { cookie: "reason_page=tok-ama-1" });
  assert.ok(!/Shared by Yaw/.test(page.text));
  // Release: one message each to Ama and Yaw, with the link and the exact expiry; none to Esi.
  const rel = await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  assert.equal(rel.released, true, JSON.stringify(rel));
  assert.equal(rel.sent.guests, 2);
  assert.deepEqual(rt.sent.map(s => s.conversationId).sort(), [AMA_C, YAW_C].sort());
  const album = db.albumOf(ev.id);
  assert.equal(album.expires_at, album.released_at + 3 * 24 * 60 * 60_000, "three days from release, one deadline");
  const expiry = albums.expiryLine(album, ev);
  for (const s of rt.sent) {
    assert.match(s.text, /the Game Night album is ready/);
    assert.ok(s.text.includes(expiry), "the exact expiry is in the announcement");
    assert.match(s.text, /:\nhttps:\/\/files\.example\.test\/e\/[A-Za-z0-9_-]{16}\/album\?t=[A-Za-z0-9_-]+$/, "the link last, on its own line");
  }
  const amaLink = rt.sent.find(s => s.conversationId === AMA_C).text.split("\n").pop();
  assert.ok(amaLink.includes(db.attendeeRow(ev.id, AMA_C).token), "each guest gets their own link");
  // A later upload sends nothing; a second release sends nothing; checking in late sends that person their one message.
  const late = await tool("album_add", { event_id: ev.id, photo_ids: [photo(AMA_C)] }, AMA_C, rt);
  assert.equal(late.added.length, 1);
  assert.equal(late.released, true);
  assert.equal(rt.sent.length, 2, "no text per new photo");
  const again = await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  assert.equal(again.already, true);
  assert.equal(rt.sent.length, 2);
  assert.equal(db.albumOf(ev.id).expires_at, album.expires_at, "a late upload does not move the deadline");
  const esi = guests.find(a => a.conversation_id === ESI_C);
  const r = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: esi.id }, KOFI_C, rt);
  assert.equal(r.guests[0].told, "sent");
  assert.equal(rt.sent.length, 3);
  assert.equal(rt.sent[2].conversationId, ESI_C);
  // Each announcement is its own message row carrying the real words, so the status page's retry
  // (events.retryDelivery resends message.body) can only ever resend those words — never a placeholder.
  const rows = db.eventMessages(ev.id).filter(m => m.kind === "album");
  assert.equal(rows.length, 3);
  for (const m of rows) { assert.match(m.body, /the Game Night album is ready/); assert.match(m.body, /\/album\?t=/); }
  assert.equal(db.deliveriesFor(rows[0].id).length, 1, "one delivery per message row");
  // Checked in and released: the whole album, the exact expiry, highlights on top once pinned, the download.
  const org = await tool("album_manage", { event_id: ev.id, action: "pin", photo_ids: [db.photosOf(album.id)[2].id] }, KOFI_C, rt);
  assert.equal(org.pinned.length, 1);
  page = await req(ev, { cookie: "reason_page=tok-ama-1" });
  assert.match(page.text, /Everyone's photos/);
  assert.match(page.text, /Shared by Yaw/);
  assert.match(page.text, /Highlights/);
  assert.ok(page.text.includes(expiry), "the album shows the exact expiry");
  assert.match(page.text, /Download album/);
  assert.ok(!/Pin<|Check in|End event and release/.test(page.text), "attendees never get organizer controls");
  const zip = await req(ev, { sub: "album/download", cookie: "reason_page=tok-ama-1" });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers["Content-Type"], "application/zip");
  assert.equal(zip.body.readUInt32LE(0), 0x04034b50, "a real ZIP");
  assert.equal(zip.body.readUInt32LE(zip.body.length - 22), 0x06054b50);
  assert.equal(zip.body.readUInt16LE(zip.body.length - 12), 4, "all four photos");
  // One photo, saved: the bytes, with a download name.
  const one = await req(ev, { sub: `album/photo/${db.photosOf(album.id)[0].id}`, query: { dl: "1" }, cookie: "reason_page=tok-ama-1" });
  assert.equal(one.status, 200);
  assert.match(one.headers["Content-Disposition"], /^attachment; filename="Game-Night-\d+\.png"$/);
  assert.equal(one.body.readUInt32BE(0), 0x89504e47);
});

test("a forwarded link does nothing for the wrong person: the gate texts the link's owner only; a non-attendee opens nothing; a guest not checked in sees only their own", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  const ama = await joinAs(AMA_C); await joinAs(YAW_C);
  const yaw = await addFirst(YAW_C, ev, [photo(YAW_C)], rt);
  await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: db.attendeeRow(ev.id, YAW_C).id }, KOFI_C, rt);
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  const organizerLink = { t: ev.organizer_token };
  // An unknown browser holding the organizer's link: the gate, nothing of the album, and "text me a code" buzzes the organizer, not the holder.
  let out = await req(ev, { sub: "album/manage", query: organizerLink });
  assert.equal(out.status, 200);
  assert.match(out.text, /Text me a code/);
  assert.ok(!/Shared by|Check in|End event and release|al-tile/.test(out.text), "the gate shows nothing of the album");
  const before = rt.sent.length;
  out = await req(ev, { sub: "album/manage", method: "POST", body: form({ t: ev.organizer_token, step: "send" }), rt });
  assert.equal(rt.sent.length, before + 1);
  assert.equal(rt.sent[before].conversationId, KOFI_C, "the code goes to the organizer, whose link it is");
  assert.match(rt.sent[before].text, /open the album page for "Game Night"/);
  // The gate's button is under the same per-browser ceiling as the sign-in page: past it, no text goes.
  for (let i = 0; i < 12; i++) await req(ev, { sub: "album/manage", method: "POST", body: form({ t: ev.organizer_token, step: "send" }), rt });
  const capped = await req(ev, { sub: "album/manage", method: "POST", body: form({ t: ev.organizer_token, step: "send" }), rt });
  assert.equal(capped.status, 429);
  assert.ok(rt.sent.length <= before + events.SIGNIN_PER_BROWSER_HOUR, "a browser cannot keep the organizer's phone buzzing");
  // A made-up or dead link: not found, byte for byte.
  const ghost = await req(ev, { sub: "album/manage", query: { t: "nope" } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body, (await req(ev, { sub: "album", query: { t: "x".repeat(32) } })).body);
  // A stranger whose browser Reason knows, holding either link: nothing — the same bytes as not found.
  const stranger = await req(ev, { sub: "album/manage", query: organizerLink, cookie: asBrowser(ESI_C, "tok-esi-1") });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body, ghost.body);
  assert.equal((await req(ev, { sub: "album", query: { t: ama.token }, cookie: "reason_page=tok-esi-1" })).status, 404);
  assert.equal((await req(ev, { sub: `album/photo/${yaw.added[0]}`, cookie: "reason_page=tok-esi-1" })).status, 404);
  assert.equal((await req(ev, { sub: "album/download", cookie: "reason_page=tok-esi-1" })).status, 404);
  // Ama, a guest the organizer never checked in, opening the organizer's forwarded link: her own role, her own photos, no controls, no album.
  out = await req(ev, { sub: "album/manage", query: organizerLink, cookie: asBrowser(AMA_C, "tok-ama-2") });
  assert.equal(out.status, 200);
  assert.match(out.text, /shared with the guests the organizer checked in/);
  assert.ok(!/Shared by Yaw|Everyone's photos|Download album|Check in|End event and release/.test(out.text));
  assert.equal((await req(ev, { sub: `album/photo/${yaw.added[0]}`, cookie: "reason_page=tok-ama-2" })).status, 404, "another guest's photo bytes: nothing");
  assert.equal((await req(ev, { sub: "album/download", cookie: "reason_page=tok-ama-2" })).status, 404);
  // Posting the organizer's actions from her browser does nothing.
  await req(ev, { sub: "album/manage", method: "POST", body: form({ action: "remove", photo: String(yaw.added[0]) }), cookie: "reason_page=tok-ama-2" });
  assert.equal(db.photoCount(db.albumOf(ev.id).id), 1, "a guest cannot remove another's photo through the organizer's form");
  // And the organizer, on a recognized browser, gets their page from the attendee's link just the same.
  out = await req(ev, { sub: "album", query: { t: ama.token }, cookie: asBrowser(KOFI_C, "tok-kofi-2") });
  assert.match(out.text, /Check-in list/);
  // Checking Ama in through the organizer's page opens the album to her, and texts her the one announcement.
  const sends = rt.sent.length;
  const post = await req(ev, { sub: "album/manage", method: "POST", body: form({ action: "checkin", guest: String(db.attendeeRow(ev.id, AMA_C).id) }), cookie: "reason_page=tok-kofi-2", rt });
  assert.equal(post.status, 303);
  assert.equal(rt.sent.length, sends + 1);
  assert.equal(rt.sent[sends].conversationId, AMA_C);
  out = await req(ev, { sub: "album", cookie: "reason_page=tok-ama-2" });
  assert.match(out.text, /Shared by Yaw/);
  assert.equal((await req(ev, { sub: `album/photo/${yaw.added[0]}`, cookie: "reason_page=tok-ama-2" })).status, 200);
});

// ---------- expiry ----------

test("the album shows the exact expiry; past it the sweep closes the page and the stored files are gone", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C);
  await addFirst(AMA_C, ev, [photo(AMA_C), photo(AMA_C)], rt);
  await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: db.attendeeRow(ev.id, AMA_C).id }, KOFI_C, rt);
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  const album = db.albumOf(ev.id);
  assert.equal(files(ev), 2);
  const runtime = new Runtime({ runTurn: async () => "ok" });
  // Just before the deadline: nothing happens.
  clock.skip(3 * 24 * 60 * 60_000 - 60_000);
  assert.deepEqual(await runtime.eventAlbums(), { closed: 0, deleted: 0, nudged: 0 });
  assert.equal(files(ev), 2);
  // Past it: closed, files deleted, the page says so, nothing more can be added, no second announcement.
  clock.skip(2 * 60_000);
  assert.deepEqual(await runtime.eventAlbums(), { closed: 1, deleted: 2, nudged: 0 });
  assert.equal(files(ev), 0);
  assert.ok(!existsSync(join(dir, "data", "event-albums", ev.public_id)), "the event's directory is gone");
  assert.equal(db.photoCount(album.id), 0);
  assert.ok(db.albumOf(ev.id).closed_at);
  const page = await req(ev, { cookie: asBrowser(AMA_C, "tok-ama-3") });
  assert.equal(page.status, 200);
  assert.match(page.text, /This album closed on/);
  assert.ok(!/al-tile|Download album/.test(page.text));
  assert.equal((await req(ev, { sub: "album/download", cookie: "reason_page=tok-ama-3" })).status, 404);
  const more = await tool("album_add", { event_id: ev.id, photo_ids: [photo(AMA_C)] }, AMA_C, rt);
  assert.equal(more.closed, true);
  assert.equal(rt.sent.length, 1, "only ever the one announcement");
  assert.deepEqual(await runtime.eventAlbums(), { closed: 0, deleted: 0, nudged: 0 }, "closed once");
});

test("retention is one setting: the note, the deadline and the page all read it", async () => {
  config.albumRetentionDays = 5;
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C);
  const ask = await tool("album_add", { event_id: ev.id, photo_ids: [photo(AMA_C)] }, AMA_C, rt);
  assert.match(ask.ask, /5 days after it's released/);
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  const album = db.albumOf(ev.id);
  assert.equal(album.expires_at - album.released_at, 5 * 24 * 60 * 60_000);
  assert.equal(albums.PHOTO_ORDER, "upload time", "photo order is upload time (decided), one setting");
});

test("a never-released album runs no timer, deletes nothing, and is listed as waiting; the scheduled end time releases nothing", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C);
  await addFirst(AMA_C, ev, [photo(AMA_C)], rt);
  await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: db.attendeeRow(ev.id, AMA_C).id }, KOFI_C, rt);
  clock.skip(30 * 24 * 60 * 60_000);
  // Ama is checked in, so the end-of-event nudge has nothing to say; a month on, nothing is closed either.
  assert.deepEqual(await albums.sweep({ runtime: rt }), { closed: 0, deleted: 0, nudged: 0 });
  assert.equal(files(ev), 1);
  assert.equal(db.albumOf(ev.id).expires_at, null);
  assert.deepEqual(albums.waiting().map(w => [w.name, w.photos]), [["Game Night", 1]]);
  assert.equal(rt.sent.length, 0, "a month past the event's start, nobody was texted an album");
  const page = await req(ev, { cookie: asBrowser(AMA_C, "tok-ama-4") });
  assert.match(page.text, /hasn't released the album yet/);
  assert.ok(!/people/.test(page.text.split("Highlights")[0].split("al-sub")[1] ?? ""), "before release the counts are their own, not the album's");
  // An event the operator paused sends nothing to guests, so its album cannot be released either.
  db.updateEventRow(ev.id, { status: "paused" });
  const held = await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  assert.equal(held.ok, false);
  assert.match(held.error, /paused/);
  assert.equal(db.albumOf(ev.id).released_at, null);
  assert.equal(rt.sent.length, 0);
});

// ---------- the organizer is nudged to check people in; checks them in by name (decided 2026-10-26) ----------

const H = 60 * 60_000;
const organizerTexts = (rt) => rt.sent.filter(s => s.conversationId === KOFI_C);
/** No "say/text/reply X" coaching in anything the organizer is told: plain intent only. */
const COACH = /\b(say|text|reply|type|send)\s+(back\s+)?(with\s+)?(just\s+)?(["“][a-z#][^"”]{0,40}["”]|\b(YES|NO|STOP|HELP|START|UNDO)\b)/;

test("a release with nobody checked in is never silent: it releases, then the organizer is told nobody can see it and asked who to let in — by the tool's result, or by text from the page", async () => {
  // Through Reason: the result carries the counts and the nudge for the model to put in its own words.
  let rt = fakeRuntime();
  let ev = await made();
  await joinAs(AMA_C); await joinAs(YAW_C);
  await addFirst(AMA_C, ev, [photo(AMA_C)], rt);
  const rel = await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  assert.equal(rel.released, true, JSON.stringify(rel));
  assert.ok(db.albumOf(ev.id).released_at, "it still releases — the organizer's tap is honoured");
  assert.deepEqual([rel.counts.joined, rel.counts.checked_in, rel.sent.guests], [2, 0, 0]);
  assert.match(rel.nudge, /none of the 2 guests who joined are checked in, so nobody can see it yet/);
  assert.match(rel.nudge, /only checked-in guests get the album/);
  assert.match(rel.nudge, /let me know who was actually there/);
  assert.ok(!COACH.test(rel.nudge), "plain intent, never a phrase to type");
  assert.match(rel.note, /ask who should be let in/);
  assert.equal(rt.sent.length, 0, "nothing is texted to anybody: no guest is in, and the organizer is in this very turn");
  // Partial: what went out, who is still out, and the offer to let them in.
  rt = fakeRuntime();
  ev = await made(KOFI_C, { name: "Brunch", password: "eggs" });
  await joinAs(AMA_C, "Brunch", "eggs"); await joinAs(YAW_C, "Brunch", "eggs"); await joinAs(ESI_C, "Brunch", "eggs");
  await tool("album_manage", { event_id: ev.id, event_named: "brunch", action: "check_in", guest_names: ["Ama"] }, KOFI_C, rt);
  const part = await tool("album_manage", { event_id: ev.id, event_named: "brunch", action: "release" }, KOFI_C, rt);
  assert.deepEqual([part.counts.joined, part.counts.checked_in, part.sent.guests], [3, 1, 1]);
  assert.match(part.nudge, /went out to the 1 guest you checked in\. 2 others who joined aren't checked in, so they can't see it/);
  assert.ok(!COACH.test(part.nudge));
  // Everyone in: nothing to nudge about.
  rt = fakeRuntime();
  ev = await made(KOFI_C, { name: "Hike", password: "boots" });
  await joinAs(AMA_C, "Hike", "boots");
  await tool("album_manage", { event_id: ev.id, event_named: "hike", action: "check_in", guest_names: ["Ama"] }, KOFI_C, rt);
  const full = await tool("album_manage", { event_id: ev.id, event_named: "hike", action: "release" }, KOFI_C, rt);
  assert.equal(full.nudge, undefined);
  assert.ok(!/let in/.test(full.note));
  // From the page button, with nobody checked in: released, the page says nobody can see it, and the organizer is TEXTED the nudge, once.
  rt = fakeRuntime();
  ev = await made(KOFI_C, { name: "Movie Night", password: "popcorn" });
  await joinAs(AMA_C, "Movie Night", "popcorn"); await joinAs(YAW_C, "Movie Night", "popcorn");
  await addFirst(AMA_C, ev, [photo(AMA_C)], rt);
  const cookie = asBrowser(KOFI_C, "tok-kofi-n1");
  const post = await req(ev, { sub: "album/manage", method: "POST", body: form({ action: "release" }), cookie, rt });
  assert.equal(post.status, 303);
  assert.match(decodeURIComponent(post.headers.Location), /Nobody is checked in, so nobody can see it yet/);
  assert.ok(db.albumOf(ev.id).released_at);
  assert.equal(organizerTexts(rt).length, 1, "the organizer is told by text");
  assert.match(organizerTexts(rt)[0].text, /Movie Night album is released, but none of the 2 guests who joined are checked in/);
  assert.ok(!COACH.test(organizerTexts(rt)[0].text));
  assert.equal(rt.sent.length, 1, "no guest was texted: nobody is in");
  const page = await req(ev, { sub: "album/manage", cookie });
  assert.match(page.text, /Nobody can see the album yet/);
  assert.match(page.text, /Check everyone in/);
  // A second tap: already released, no second text.
  await req(ev, { sub: "album/manage", method: "POST", body: form({ action: "release" }), cookie, rt });
  assert.equal(organizerTexts(rt).length, 1);
  // And the words Reason sent are in its thread with the organizer, as its own.
  const thread = db.loadConversation(KOFI_C);
  assert.ok(thread.some(m => m.role === "assistant" && /Movie Night album is released/.test(m.content)), "the nudge is the last thing Reason said, so the next text reads as the answer");
});

test("\"everyone\" checks every joined guest in and texts each the announcement once; a second \"everyone\" and the page's button send nothing again", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C); await joinAs(YAW_C); await joinAs(ESI_C);
  await addFirst(AMA_C, ev, [photo(AMA_C)], rt);
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  assert.equal(rt.sent.length, 0, "released to nobody");
  const all = await tool("album_manage", { event_id: ev.id, action: "check_in_all" }, KOFI_C, rt);
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.deepEqual([all.counts.checked_in, all.counts.joined, all.newly, all.texted], [3, 3, 3, 3]);
  assert.deepEqual(rt.sent.map(s => s.conversationId).sort(), [AMA_C, ESI_C, YAW_C].sort(), "each newly checked-in guest, once");
  for (const s of rt.sent) assert.match(s.text, /the Game Night album is ready[\s\S]*\/album\?t=/);
  assert.ok(all.guests.every(g => g.checked_in), "the list in the result shows them all in");
  const again = await tool("album_manage", { event_id: ev.id, action: "check_in_all" }, KOFI_C, rt);
  assert.deepEqual([again.newly, again.texted, rt.sent.length], [0, 0, 3]);
  // The page's button is the same thing: nothing goes twice.
  const cookie = asBrowser(KOFI_C, "tok-kofi-e1");
  const post = await req(ev, { sub: "album/manage", method: "POST", body: form({ action: "checkin_all" }), cookie, rt });
  assert.equal(post.status, 303);
  assert.equal(rt.sent.length, 3);
  assert.ok(!/Check everyone in/.test((await req(ev, { sub: "album/manage", cookie })).text), "with everyone in, the button is gone");
  assert.equal(db.eventMessages(ev.id).filter(m => m.kind === "album").length, 3, "one message row per guest, the one dedupe");
  // Before release, "everyone" checks in and texts nobody; the release then texts them all.
  const rt2 = fakeRuntime();
  const ev2 = await made(KOFI_C, { name: "Brunch", password: "eggs" });
  await joinAs(AMA_C, "Brunch", "eggs"); await joinAs(YAW_C, "Brunch", "eggs");
  const early = await tool("album_manage", { event_id: ev2.id, event_named: "brunch", action: "check_in_all" }, KOFI_C, rt2);
  assert.deepEqual([early.counts.checked_in, early.texted, rt2.sent.length], [2, 0, 0]);
  const rel = await tool("album_manage", { event_id: ev2.id, event_named: "brunch", action: "release" }, KOFI_C, rt2);
  assert.deepEqual([rel.sent.guests, rt2.sent.length, rel.nudge], [2, 2, undefined]);
});

test("\"all except Lina\" leaves her out; \"Maya and Daniel came\" checks in exactly those two by name; names come off the guest list, never a number", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C, "Game Night", "catan", "Maya"); await joinAs(YAW_C, "Game Night", "catan", "Daniel"); await joinAs(ESI_C, "Game Night", "catan", "Lina");
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  const exc = await tool("album_manage", { event_id: ev.id, action: "check_in_all", except: ["Lina"] }, KOFI_C, rt);
  assert.equal(exc.ok, true, JSON.stringify(exc));
  assert.deepEqual([exc.counts.checked_in, exc.counts.joined, exc.left_out], [2, 3, ["Lina"]]);
  assert.deepEqual(rt.sent.map(s => s.conversationId).sort(), [AMA_C, YAW_C].sort(), "Lina is texted nothing");
  assert.equal(db.checkedIn(ev.id, ESI_C), false);
  // Take them back off, then by name: "Maya and Daniel came".
  const off = await tool("album_manage", { event_id: ev.id, action: "undo_check_in", guest_names: ["Maya", "Daniel"] }, KOFI_C, rt);
  assert.deepEqual([off.counts.checked_in, off.guests.map(g => g.guest).sort()], [0, ["Daniel", "Maya"]]);
  const came = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_names: ["maya", "Dan"] }, KOFI_C, rt);
  assert.equal(came.ok, true, JSON.stringify(came));
  assert.deepEqual(came.guests.map(g => g.guest).sort(), ["Daniel", "Maya"], "a name said whole, or the start of one, is enough when it fits one guest");
  assert.deepEqual([came.counts.checked_in, came.counts.joined], [2, 3]);
  assert.equal(rt.sent.length, 2, "they already had their announcement: the same message row, nothing twice");
  assert.equal(db.checkedIn(ev.id, ESI_C), false, "Lina was never named in");
  // A name nobody on the list has: nothing done, said so, with the list to pick from.
  const nobody = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_names: ["Zed"] }, KOFI_C, rt);
  assert.equal(nobody.ok, false);
  assert.equal(nobody.reason, "unknown_guest");
  assert.deepEqual(nobody.unknown, ["Zed"]);
  assert.ok(nobody.guests.every(g => !/\+1\d{10}|\d{10}/.test(JSON.stringify(g))), "never a phone number");
  assert.equal(db.checkedIn(ev.id, ESI_C), false);
});

test("a name two guests answer to is asked about, never guessed: nothing is checked in until the organizer says which", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C, "Game Night", "catan", "Ama B"); await joinAs(ESI_C, "Game Night", "catan", "Ama K"); await joinAs(YAW_C, "Game Night", "catan", "Yaw");
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  const asked = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_names: ["Ama"] }, KOFI_C, rt);
  assert.equal(asked.ok, false, JSON.stringify(asked));
  assert.equal(asked.reason, "which_guest");
  assert.deepEqual(asked.ambiguous[0].choices.map(c => c.display_name).sort(), ["Ama B", "Ama K"]);
  assert.equal(db.checkinsOf(ev.id).length, 0, "nobody checked in on a guess");
  assert.equal(rt.sent.length, 0);
  // "Everyone except Ama" with two Amas: nobody at all is checked in until it's clear.
  const exc = await tool("album_manage", { event_id: ev.id, action: "check_in_all", except: ["Ama"] }, KOFI_C, rt);
  assert.equal(exc.ok, false);
  assert.equal(exc.reason, "which_guest");
  assert.equal(db.checkinsOf(ev.id).length, 0);
  assert.equal(rt.sent.length, 0);
  // Said whole, it is one person; a clear name alongside an unclear one does the clear one and asks about the other.
  const whole = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_names: ["Ama K"] }, KOFI_C, rt);
  assert.deepEqual(whole.guests.map(g => g.guest), ["Ama K"]);
  assert.equal(rt.sent.length, 1);
  assert.equal(rt.sent[0].conversationId, ESI_C);
  const mixed = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_names: ["Yaw", "Ama"] }, KOFI_C, rt);
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.guests.map(g => g.guest), ["Yaw"]);
  assert.equal(mixed.which_guest.reason, "which_guest");
  assert.match(mixed.note, /ask which/);
  // The answer, by number: in, and texted once.
  const amaB = db.attendeeRow(ev.id, AMA_C);
  const picked = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: amaB.id }, KOFI_C, rt);
  assert.deepEqual(picked.guests.map(g => g.guest), ["Ama B"]);
  assert.equal(rt.sent.length, 3);
});

test("around the event's end, an unreleased album with nobody checked in earns the organizer one nudge from the sweep — once, never with somebody checked in, never a day late", async () => {
  const rt = fakeRuntime();
  const ev = await made();
  await joinAs(AMA_C); await joinAs(YAW_C);
  await addFirst(AMA_C, ev, [photo(AMA_C), photo(AMA_C)], rt);
  // A second event the same night where one guest IS checked in: never nudged.
  const ev2 = await made(YAW_C, { name: "Rooftop Party", password: "sunset" });
  await joinAs(AMA_C, "Rooftop Party", "sunset");
  await addFirst(AMA_C, ev2, [photo(AMA_C)], rt);
  await tool("album_manage", { event_id: ev2.id, action: "check_in", guest_names: ["Ama"] }, YAW_C, rt);
  rt.sent.length = 0;
  const at = (ms) => albums.sweep({ runtime: rt, now: ms });
  // Before the end: nothing. (Events carry a start and no end; "around the end" is END_NUDGE.afterStartMs past the start.)
  assert.deepEqual(await at(ev.starts_at + albums.END_NUDGE.afterStartMs - 60_000), { closed: 0, deleted: 0, nudged: 0 });
  assert.equal(rt.sent.length, 0);
  // At it: the organizer of the one with nobody in gets the nudge, in Reason's words; the other organizer nothing.
  assert.deepEqual(await at(ev.starts_at + albums.END_NUDGE.afterStartMs), { closed: 0, deleted: 0, nudged: 1 });
  assert.equal(rt.sent.length, 1);
  assert.equal(rt.sent[0].conversationId, KOFI_C);
  assert.match(rt.sent[0].text, /Game Night album has 2 photos in it and nobody's checked in yet, so when you release it nobody will be able to see it/);
  assert.match(rt.sent[0].text, /let me know who was actually there/);
  assert.ok(!COACH.test(rt.sent[0].text), "plain intent, never a phrase to type");
  assert.ok(!/Rooftop/.test(rt.sent[0].text));
  assert.ok(db.albumOf(ev.id).nudged_at, "written on the album");
  assert.ok(db.albumOf(ev2.id).nudged_at, "the one with somebody in is marked done too — never nudged later either");
  // Again, and an hour on, and after the organizer answers: nothing more, ever.
  assert.deepEqual(await at(ev.starts_at + albums.END_NUDGE.afterStartMs + 1), { closed: 0, deleted: 0, nudged: 0 });
  assert.deepEqual(await at(ev.starts_at + albums.END_NUDGE.afterStartMs + H), { closed: 0, deleted: 0, nudged: 0 });
  assert.equal(rt.sent.length, 1);
  assert.equal(db.eventMessages(ev.id).filter(m => m.kind === "album_end_nudge").length, 1);
  // The organizer answers "everyone who came": both in, nothing texted (not released yet); then the release texts them, and nudges nothing.
  const all = await tool("album_manage", { event_id: ev.id, action: "check_in_all" }, KOFI_C, rt);
  assert.deepEqual([all.counts.checked_in, rt.sent.length], [2, 1]);
  const rel = await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C, rt);
  assert.deepEqual([rel.sent.guests, rel.nudge, rt.sent.length], [2, undefined, 3]);
  assert.equal(db.albumOf(ev.id).released_at > 0, true);
  // Released albums, albums with no photos, and a moment more than a day gone are never nudged.
  const ev3 = await made(ESI_C, { name: "Late One", password: "late" });
  await joinAs(AMA_C, "Late One", "late");
  await addFirst(AMA_C, ev3, [photo(AMA_C)], rt);
  const before = rt.sent.length;
  // (By then Game Night's released album is past its own deadline and closes — the same pass, its own business.)
  assert.equal((await at(ev3.starts_at + albums.END_NUDGE.staleAfterStartMs + 60_000)).nudged, 0);
  assert.equal(rt.sent.length, before, "a day late is dropped unsent");
  assert.ok(db.albumOf(ev3.id).nudged_at, "and marked, so it never comes later");
});

// ---------- the events feature, untouched ----------

test("the events feature and its prompt are as they were: no event tool or prompt line mentions albums; with albums off nothing is shown or done", async () => {
  assert.ok(!/album/i.test(JSON.stringify(EVENT_TOOL_DEFS)), "event tool descriptions are unchanged");
  assert.ok(!/album/i.test(SYSTEM), "the prompt is unchanged");
  const ev = await made();
  await joinAs(AMA_C);
  const names = (c) => toolsFor(c).map(t => t.name);
  assert.ok(names(AMA_C).includes("album_add") && !names(AMA_C).includes("album_manage"));
  assert.ok(names(KOFI_C).includes("album_manage"));
  assert.ok(!names(ESI_C).some(x => x.startsWith("album_")), "somebody in no event is shown no album tool");
  config.eventAlbums = false;
  assert.ok(!names(AMA_C).some(x => x.startsWith("album_")) && !names(KOFI_C).some(x => x.startsWith("album_")));
  assert.equal((await tool("album_add", { event_id: ev.id, photo_ids: [photo(AMA_C)] }, AMA_C)).blocked, "not_available");
  assert.equal((await req(ev, { cookie: asBrowser(AMA_C, "tok-ama-5") })).status, 404);
  const eventTools = names(KOFI_C).filter(x => x.startsWith("event_"));
  config.eventAlbums = true;
  assert.deepEqual(names(KOFI_C).filter(x => x.startsWith("event_")), eventTools, "the event tools shown do not depend on albums");
  // Event tables carry nothing new: an album is its own rows.
  for (const t of ["events", "event_attendees"]) assert.ok(!db.db.prepare(`PRAGMA table_info(${t})`).all().some(c => /album|photo|check/.test(c.name)));
  // A checked-in guest after release is still, to the events feature, a plain guest.
  await addFirst(AMA_C, ev, [photo(AMA_C)]);
  await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: db.attendeeRow(ev.id, AMA_C).id }, KOFI_C);
  await tool("album_manage", { event_id: ev.id, action: "release" }, KOFI_C);
  assert.equal(db.getEventRow(ev.id).status, "active", "releasing the album changes nothing on the event row");
  assert.equal(events.roleIn(AMA_C, ev.id).role, "guest");
  assert.deepEqual(readdirSync(join(dir, "data", "event-albums")), [ev.public_id]);
});
