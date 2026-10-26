#!/usr/bin/env node
// Drive the event album end to end, in process: the real tools, the real page code, a throwaway
// database, a fake runtime that writes the outbox the way the real one does. No model; nothing can
// leave this machine. Run under the cage's env:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_EVENT_ALBUMS=on REASON_DB_PATH=$(mktemp -d)/albums.db node .agents/skills/verify-reason/bin/album-drive.mjs
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_EVENTS = process.env.REASON_EVENTS || "on";
process.env.REASON_EVENT_ALBUMS = process.env.REASON_EVENT_ALBUMS || "on";
process.env.REASON_PAGES_URL = process.env.REASON_PAGES_URL || "https://files.example.test";
process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
process.env.REASON_CONVERSATION = "dm:owner";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/albums.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { runTool } = await imp("src/tools.js");
const events = await imp("src/events.js");
const albums = await imp("src/albums.js");
const db = await imp("src/db.js");
const { clock } = await imp("src/config.js");
const { eventRequestFor } = await imp("src/http.js");

let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

const sent = [];
const runtime = {
  async _tell(conversationId, text, { idempotencyKey }) {
    const have = db.db.prepare("SELECT id FROM outbox WHERE idem_key = ?").get(idempotencyKey);
    if (have) return { ok: true, duplicate: true };
    sent.push({ conversationId, text });
    const now = clock.now();
    db.db.prepare("INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, created_at, updated_at) VALUES (?, ?, 'fake', 'x', ?, 'sent', ?, ?)").run(idempotencyKey, conversationId, text, now, now);
    return { ok: true };
  },
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fetchImpl = async (url) => { const b = Buffer.concat([PNG, Buffer.from(String(url))]); return new Response(b, { status: 200, headers: { "content-type": "image/png", "content-length": String(b.length) } }); };
const tool = (name, input, c) => runTool(name, input, { conversationId: c, messages: [], events: runtime, fetchImpl });
let n = 0;
const photo = (c) => db.recordMedia({ conversationId: c, channel: "fake", externalId: `x${++n}`, ordinal: 0, kind: "image", filename: `IMG_${n}.jpg`, url: `https://cdn.example.test/${n}.jpg` }).id;
const texted = (c) => { clock.skip(1000); db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('fake', ?, ?, ?)").run(`m${++n}`, c, clock.now()); };
const req = (ev, sub, { cookie = "", query = {} } = {}) => eventRequestFor({ publicId: ev.public_id, sub, method: "GET", query, headers: { cookie }, remoteAddress: "127.0.0.1", readBody: async () => null, runtime, router: null });

const C = { owner: "dm:owner", kofi: "dm:fake:+14155550001", ama: "dm:fake:+14155550002", yaw: "dm:fake:+14155550003", esi: "dm:fake:+14155550004" };
db.upsertAccount({ conversationId: C.owner, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
for (const [k, name] of [["kofi", "Kofi"], ["ama", "Ama"], ["yaw", "Yaw"], ["esi", "Esi"]]) db.upsertAccount({ conversationId: C[k], channel: "fake", address: C[k].slice(8), name });

const made = await tool("event_create", { name: "Game Night", description: "snacks", starts_at: "2026-10-31T20:00", location: "41 Grove St", password: "catan", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.kofi);
step("event made", made.ok);
const ev = db.getEventRow(made.event.event_id);
for (const k of ["ama", "yaw"]) step(`${k} joins`, (await events.joinExisting({ conversationId: C[k], name: "Game Night", password: "catan" })).ok);
// The owner was texted about the new event (the events feature's own line); from here, only album sends count.
sent.length = 0;

const ask = await tool("album_add", { event_id: ev.id, photo_ids: [photo(C.ama), photo(C.ama)] }, C.ama);
step("first contribution: the note, nothing stored", ask.needs_answer === true && albums.filesLeft(ev) === 0, ask.ask);
const tooSoon = await tool("album_add", { event_id: ev.id, photo_ids: [1, 2], agreed: true }, C.ama);
step("agreed in the same turn is refused", tooSoon.ok === false);
texted(C.ama);
const add = await tool("album_add", { event_id: ev.id, photo_ids: [1, 2], agreed: true }, C.ama);
step("agreed in a later text: 2 added, Shared by Ama, 2 files", add.ok && add.added?.length === 2 && add.shared_as === "Ama" && albums.filesLeft(ev) === 2, JSON.stringify(add.note));
const dup = await tool("album_add", { event_id: ev.id, photo_ids: [1, photo(C.ama)] }, C.ama);
step("same picture again is a duplicate, not a photo", dup.added?.length === 1 && dup.duplicates?.length === 1);
texted(C.yaw);
await tool("album_add", { event_id: ev.id, photo_ids: [photo(C.yaw)] }, C.yaw);
texted(C.yaw);
const yaw = await tool("album_add", { event_id: ev.id, photo_ids: [photo(C.yaw)], agreed: true }, C.yaw);
step("yaw's photo in", yaw.ok && yaw.added?.length === 1);

db.startPageSession("p-ama", "tok-ama", { conversationId: C.ama });
db.startPageSession("p-kofi", "tok-kofi", { conversationId: C.kofi });
db.startPageSession("p-esi", "tok-esi", { conversationId: C.esi });
let page = await req(ev, "album", { cookie: "reason_page=tok-ama" });
step("before release a guest sees only their own photos", page.status === 200 && /Your photos/.test(page.body) && !/Shared by Yaw/.test(page.body));
page = await req(ev, "album/manage", { cookie: "reason_page=tok-kofi" });
step("organizer page: release button, check-in list, every photo", /End event and release album/.test(page.body) && /Check-in list/.test(page.body) && /Shared by Yaw/.test(page.body));
page = await req(ev, "album/manage", { query: { t: ev.organizer_token } });
step("organizer link on an unknown browser: the gate only", page.status === 200 && /Text me a code/.test(page.body) && !/Shared by/.test(page.body));
page = await req(ev, "album/manage", { query: { t: ev.organizer_token }, cookie: "reason_page=tok-esi" });
const ghost = await req(ev, "album/manage", { query: { t: "nope" } });
step("a stranger's recognized browser on the organizer's link: not found, same bytes as a dead link", page.status === 404 && page.body === ghost.body);

const ama = db.attendeeRow(ev.id, C.ama);
const ci = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_id: ama.id }, C.kofi);
step("ama checked in; nothing sent before release", ci.guests?.[0]?.checked_in === true && sent.length === 0);
const rel = await tool("album_manage", { event_id: ev.id, action: "release" }, C.kofi);
step("release: one text to the one checked-in guest, link last", rel.released === true && sent.length === 1 && sent[0].conversationId === C.ama && /:\nhttps:\/\/.+\/album\?t=/.test(sent[0].text), rel.expires);
const album = db.albumOf(ev.id);
step("deadline = release + retention", album.expires_at === album.released_at + albums.RETENTION.ms);
await tool("album_add", { event_id: ev.id, photo_ids: [photo(C.ama)] }, C.ama);
const rel2 = await tool("album_manage", { event_id: ev.id, action: "release" }, C.kofi);
step("late upload and a second release send nothing", sent.length === 1 && rel2.already === true);
page = await req(ev, "album", { cookie: "reason_page=tok-ama" });
step("checked-in guest after release: whole album with the exact expiry", /Shared by Yaw/.test(page.body) && page.body.includes(albums.expiryLine(album, ev)) && /Download album/.test(page.body));
const zip = await req(ev, "album/download", { cookie: "reason_page=tok-ama" });
step("whole-album download is a zip", zip.status === 200 && zip.body.readUInt32LE(0) === 0x04034b50);
const yawRow = db.attendeeRow(ev.id, C.yaw);
step("yaw (not checked in) cannot open the album or the zip", (await req(ev, "album", { cookie: (db.startPageSession("p-yaw", "tok-yaw", { conversationId: C.yaw }), "reason_page=tok-yaw") })).body.includes("checked in") && (await req(ev, "album/download", { cookie: "reason_page=tok-yaw" })).status === 404);
step("release reports who is still out, in Reason's words", rel.counts?.joined === 2 && rel.counts?.checked_in === 1 && /1 other who joined isn't checked in/.test(rel.nudge) && /ask who should be let in/.test(rel.note));
const late = await tool("album_manage", { event_id: ev.id, action: "check_in", guest_names: ["yaw"] }, C.kofi);
step("'Yaw came' — checked in late by name: the one announcement, once", late.ok && late.guests?.[0]?.guest === "Yaw" && late.guests[0].told === "sent" && sent.length === 2 && sent[1].conversationId === C.yaw, JSON.stringify(late.note));

clock.skip(albums.RETENTION.ms + 1000);
const swept = await albums.sweep({ runtime });
step("past the deadline the sweep closes it and deletes the files", swept.closed === 1 && albums.filesLeft(ev) === 0 && db.albumOf(ev.id).closed_at != null, JSON.stringify(swept));
page = await req(ev, "album", { cookie: "reason_page=tok-ama" });
step("the page is closed", /This album closed on/.test(page.body) && !/al-tile/.test(page.body.split("<main").pop()));
step("nothing more goes in", (await tool("album_add", { event_id: ev.id, photo_ids: [photo(C.ama)] }, C.ama)).closed === true);
step("still only the two announcements ever", sent.length === 2);

// ---- the nudges and check-in by name (owner, 2026-10-26): a second event, released to nobody ----
const made2 = await tool("event_create", { name: "Brunch", description: "eggs", starts_at: "2026-11-01T11:00", location: "41 Grove St", password: "eggs", show_time_on_join: true, show_location_on_join: true, guest_list_visible: true }, C.kofi);
step("second event made", made2.ok);
const ev2 = db.getEventRow(made2.event.event_id);
for (const k of ["ama", "yaw", "esi"]) await events.joinExisting({ conversationId: C[k], name: "Brunch", password: "eggs" });
sent.length = 0;
texted(C.ama);
const b1 = await tool("album_add", { event_id: ev2.id, event_named: "brunch", photo_ids: [photo(C.ama)] }, C.ama);
step("a photo for brunch goes straight in (the note was answered once, ever)", b1.ok && b1.added?.length === 1);
const sw = await albums.sweep({ runtime, now: ev2.starts_at + albums.END_NUDGE.afterStartMs });
step("around the end with nobody checked in: the organizer is nudged once, plain intent", sw.nudged === 1 && sent.length === 1 && sent[0].conversationId === C.kofi && /nobody's checked in yet/.test(sent[0].text) && /let me know who was actually there/.test(sent[0].text), sent[0]?.text);
const sw2 = await albums.sweep({ runtime, now: ev2.starts_at + albums.END_NUDGE.afterStartMs + 60_000 });
step("never twice", sw2.nudged === 0 && sent.length === 1);
const postRelease = await eventRequestFor({ publicId: ev2.public_id, sub: "album/manage", method: "POST", query: {}, headers: { cookie: "reason_page=tok-kofi" }, remoteAddress: "127.0.0.1", readBody: async () => "action=release", runtime, router: null });
step("released from the page with nobody in: it releases, the organizer is texted why nobody can see it, no guest is texted", postRelease.status === 303 && db.albumOf(ev2.id).released_at != null && sent.length === 2 && sent[1].conversationId === C.kofi && /nobody can see it yet/.test(sent[1].text), sent[1]?.text);
page = await req(ev2, "album/manage", { cookie: "reason_page=tok-kofi" });
step("the page says so and offers 'Check everyone in'", /Nobody can see the album yet/.test(page.body) && /Check everyone in/.test(page.body));
const exc = await tool("album_manage", { event_id: ev2.id, event_named: "brunch", action: "check_in_all", except: ["Esi"] }, C.kofi);
step("'everyone except Esi': Ama and Yaw in and texted the link once each, Esi nothing", exc.ok && exc.counts?.checked_in === 2 && exc.left_out?.[0] === "Esi" && sent.length === 4 && !sent.some(s => s.conversationId === C.esi), exc.note);
const esiIn = await tool("album_manage", { event_id: ev2.id, event_named: "brunch", action: "check_in", guest_names: ["esi"] }, C.kofi);
step("'Esi was there too': in, texted once", esiIn.ok && esiIn.guests?.[0]?.told === "sent" && sent.length === 5 && sent[4].conversationId === C.esi);
const everyone = await tool("album_manage", { event_id: ev2.id, event_named: "brunch", action: "check_in_all" }, C.kofi);
step("'everyone' again: nothing new, nobody texted twice", everyone.newly === 0 && everyone.texted === 0 && sent.length === 5);
const nobody = await tool("album_manage", { event_id: ev2.id, event_named: "brunch", action: "check_in", guest_names: ["Zed"] }, C.kofi);
step("a name not on the list: nothing done, the list offered", nobody.ok === false && nobody.reason === "unknown_guest" && Array.isArray(nobody.guests));

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
