// One private photo album per event (album spec, 2026-10-26). Attendees text Reason photos naming
// the event, the organizer ends the event and releases the album, and the guests the organizer
// checked in open it. Built on the events feature (src/events.js) without changing it: the event, its
// organizer, its guests and their roles are read through events.js; everything about photos lives
// in this file and the three tables under src/db.js "the event photo album".
//
// The rules, each written once here and pinned by test/event-album.test.js:
//
//   - **contributing is deliberate.** A batch goes into an album only when the person named the
//     event; with more than one event it could be, events.whichEvent asks (never the newest one).
//     Nothing Reason is sent is collected on its own.
//   - **the note first.** Before anybody's first contribution they are told, once, that photos they
//     add are shared with checked-in attendees after the organizer releases the album, that those
//     can be saved or screenshotted, and how long the photos are kept (`consentNote`). The yes has
//     to come in a LATER message of theirs (`db.lastInboundAt`), never the turn that asked.
//   - **in automatically, out by the right hands.** A submitted photo is in the album at once;
//     nothing waits for review. The contributor removes their own, the organizer removes any, and
//     removing one unlinks the file before the row goes (`removePhoto`).
//   - **"Shared by <display name>", never a number.** The name is the one on their event membership.
//   - **only checked-in guests see it, and only after release.** `viewFor` is the one place that
//     decides what a person may see: the organizer everything, any time; a checked-in guest the whole
//     album once released; a contributor their own photos (so a never-released album, or a guest the
//     organizer never checked in, exposes nothing of anybody else's). A link only ever says whom to
//     text a code to; the role is read server-side on every request (src/pages/album.js).
//   - **release is the organizer's tap**, never the scheduled end time. It sends the checked-in
//     guests ONE message with the link (`release`); late uploads send nothing, and are open until expiry.
//   - **highlights are the organizer's pins**, on top, optional, never in the way of release.
//   - **one deadline.** `RETENTION` after release, for the whole album, late uploads included. The
//     exact expiry is on the album; at expiry the sweep closes it and deletes the files (`sweep`).
//   - **never-released albums** (open decision): kept, no timer, nothing deleted, visible only as
//     above; `waiting()` lists them for the owner to decide.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import * as db from "./db.js";
import * as events from "./events.js";
import * as accounts from "./accounts.js";
import { fetchImage } from "./media.js";
import { sniff, READABLE } from "./pictures.js";
import { config, clock } from "./config.js";

// ---------- the switch, and the one retention setting ----------

/** Albums exist at all (REASON_EVENT_ALBUMS, on top of REASON_EVENTS). */
export function albumsOn() {
  return events.eventsOn() && (config.eventAlbums === "owner" || config.eventAlbums === true);
}

/** May THIS event have an album? `owner`: only the owner's events. */
export function albumFor(ev) {
  if (!albumsOn() || !ev) return false;
  if (config.eventAlbums === "owner") return accounts.ownerOf(ev.organizer_conversation_id).isOperator;
  return true;
}

/**
 * How long photos are kept after release. The ONE place the length is written: the deadline, the
 * consent note, the announcement and the album page all read it from here.
 */
export const RETENTION = Object.freeze({
  get days() { return Math.max(1, Number(config.albumRetentionDays) || 3); },
  get ms() { return this.days * 24 * 60 * 60_000; },
  get words() { return this.days === 1 ? "one day" : this.days === 2 ? "two days" : this.days === 3 ? "three days" : `${this.days} days`; },
});

/**
 * OPEN DECISION — photo order. Capture time was suggested and never approved. Until the owner
 * decides, every list reads upload time (db.photosOf: created_at, id), and this is the one flag.
 */
export const PHOTO_ORDER = "upload time";

/** What the album takes: the image types the rest of Reason reads, up to the same size (a HEIC is converted first). */
export const LIMITS = Object.freeze({
  get maxBytes() { return config.imageMaxBytes; },
  types: ["JPEG", "PNG", "GIF", "WebP"],
  get line() { return `${this.types.join(", ")} or an iPhone photo, up to ${Math.round(this.maxBytes / (1024 * 1024))} MB each`; },
});

// ---------- where files live ----------

const ROOT = () => join(config.dataDir, "event-albums");
const dirOf = (ev) => join(ROOT(), ev.public_id);
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

function writeAtomic(dir, name, bytes) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  return file;
}

/** A photo's file on disk, or null when it is gone. The name is its own; the directory the event's. */
export function photoFile(ev, photo) {
  const f = join(dirOf(ev), basename(photo.file));
  return existsSync(f) ? f : null;
}

function unlinkPhoto(ev, photo) {
  try { unlinkSync(join(dirOf(ev), basename(photo.file))); } catch { /* already gone */ }
}

// ---------- links, names, lines ----------

/** A guest's own way into the album. Dies with their membership. */
export function albumUrl(ev, att) {
  return `${events.eventUrl(ev)}/album?t=${att.token}`;
}
/** The organizer's page: the check-in list, highlights, removals, the release button. */
export function manageUrl(ev) {
  return `${events.eventUrl(ev)}/album/manage?t=${ev.organizer_token}`;
}

/** "Thu, Oct 29, 9:12 PM EDT", in the event's zone. */
export function whenLine(ms, tz) {
  return new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
export function expiryLine(album, ev) {
  return album?.expires_at ? whenLine(album.expires_at, ev.tz) : null;
}

/** "Shared by <name>": the name on their membership of THIS event, never a phone number. */
export function sharedAs(ev, conversationId) {
  const row = db.attendeeRow(ev.id, conversationId);
  const name = events.cleanDisplayName(row?.display_name)
    ?? (conversationId === ev.organizer_conversation_id ? events.cleanDisplayName(events.organizerName(ev)) : null)
    ?? events.cleanDisplayName(db.getAccount(conversationId)?.name);
  return name ?? "a guest";
}

/**
 * The note before a person's first contribution: the agreed core text, then the retention rule,
 * since both were agreed to be disclosed before upload. In Reason's own voice, for the model to put
 * to them in substance; the yes is theirs to give in a later message.
 */
export function consentNote(ev, count) {
  const these = count === 1 ? "this one" : `these ${count}`;
  return `add ${these} to the ${ev.name} album? photos you add will be shared with checked-in attendees after the organizer releases the album. they can save or screenshot them. the album stays up for ${RETENTION.words} after it's released, then the photos are deleted.`;
}

/** The one announcement, on release: the link last, on its own line, so it goes as its own bubble. */
export function releaseText(ev, album, att) {
  return `the ${ev.name} album is ready. it's up until ${expiryLine(album, ev)} — save what you want before then:\n${albumUrl(ev, att)}`;
}

// ---------- who may see what ----------

/**
 * This person's standing on this event's album, read server-side from their membership (events.roleIn)
 * and the check-in list, never from a link: `{ role, album, released, closed, checkedIn, all, own }`.
 *   role       organizer | guest | null (nothing: not on the event, or no album here)
 *   all        may see every photo (the organizer any time; a checked-in guest once released)
 *   own        may see their own photos (any member who contributed)
 */
export function viewFor(conversationId, ev) {
  const none = { role: null, album: null, released: false, closed: false, checkedIn: false, all: false, own: false };
  if (!ev || !albumFor(ev)) return none;
  const r = events.roleIn(conversationId, ev.id);
  if (!r) return none;
  const album = db.albumOf(ev.id);
  const released = !!album?.released_at;
  const closed = !!album?.closed_at;
  const checkedIn = r.role === "guest" && db.checkedIn(ev.id, conversationId);
  const all = !closed && (r.role === "organizer" || (checkedIn && released));
  return { role: r.role, att: r.att, album, released, closed, checkedIn, all, own: !closed };
}

/** May this person see this one photo's bytes? */
export function canSeePhoto(conversationId, ev, photo) {
  const v = viewFor(conversationId, ev);
  if (!photo || !v.album || photo.album_id !== v.album.id) return false;
  return v.all || (v.own && photo.conversation_id === conversationId);
}

/** Photos as one viewer may see them: all, or only their own. Highlights (pinned) first. */
export function photosFor(conversationId, ev) {
  const v = viewFor(conversationId, ev);
  if (!v.album || v.closed) return { highlights: [], photos: [], view: v };
  const rows = v.all ? db.photosOf(v.album.id) : v.own ? db.photosBy(v.album.id, conversationId) : [];
  const shaped = rows.map(p => ({ ...p, shared_by: sharedAs(ev, p.conversation_id), mine: p.conversation_id === conversationId }));
  // PHOTO_ORDER: rows arrive by upload time. Pins are shown on top, in the order the organizer pinned them.
  const highlights = v.all ? shaped.filter(p => p.pinned_at).sort((a, b) => a.pinned_at - b.pinned_at || a.id - b.id) : [];
  return { highlights, photos: shaped, view: v };
}

// ---------- contributing ----------

/**
 * Store a batch for one member of the event. Each picture is fetched from where it arrived
 * (`db.mediaItem` — this conversation's only), checked by its bytes, written under the event's
 * directory and recorded. Honest about every one: `added`, `duplicates` (the same bytes from the
 * same person already in this album), `failed` with why — never "added" for a batch that partly was not.
 */
export async function contribute({ ev, conversationId, mediaIds, fetchImpl = null }) {
  if (!albumFor(ev)) return { ok: false, reason: "not_available" };
  const role = events.roleIn(conversationId, ev.id);
  if (!role) return { ok: false, reason: "not_a_member" };
  if (ev.status === "cancelled") return { ok: false, reason: "cancelled" };
  const existing = db.albumOf(ev.id);
  if (existing?.closed_at) return { ok: false, reason: "closed" };
  if (existing?.expires_at && existing.expires_at <= clock.now()) return { ok: false, reason: "closed" };
  const album = db.ensureAlbum(ev.id, ev.organizer_conversation_id);
  const out = { ok: true, album, added: [], duplicates: [], failed: [] };
  for (const mid of [...new Set((mediaIds ?? []).map(Number))]) {
    const row = db.mediaItem(conversationId, mid);
    if (!row) { out.failed.push({ photo_id: mid, why: "there's no photo with that number in this conversation" }); continue; }
    if (row.kind !== "image") { out.failed.push({ photo_id: mid, why: "that isn't a photo" }); continue; }
    if (!row.url) { out.failed.push({ photo_id: mid, why: "it arrived with no link to it" }); continue; }
    const got = await fetchImage({ url: row.url, filename: row.filename, ...(fetchImpl ? { fetchImpl } : {}) });
    if (!got.ok) { out.failed.push({ photo_id: mid, why: got.why }); continue; }
    const bytes = Buffer.from(got.base64, "base64");
    const type = sniff(bytes);
    if (!READABLE.has(type)) { out.failed.push({ photo_id: mid, why: `that isn't an image the album takes (${LIMITS.line})` }); continue; }
    if (bytes.length > LIMITS.maxBytes) { out.failed.push({ photo_id: mid, why: `it's bigger than ${Math.round(LIMITS.maxBytes / (1024 * 1024))} MB` }); continue; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dup = db.photoByHash(album.id, conversationId, sha256);
    if (dup) { out.duplicates.push({ photo_id: mid, photo: dup.id }); continue; }
    const name = `${randomBytes(9).toString("base64url")}.${EXT[type]}`;
    try { writeAtomic(dirOf(ev), name, bytes); }
    catch (e) { out.failed.push({ photo_id: mid, why: `it couldn't be stored (${(e?.message ?? String(e)).split("\n")[0]})` }); continue; }
    out.added.push(db.insertPhoto({ albumId: album.id, eventId: ev.id, conversationId, mediaId: mid, file: name, mediaType: type, bytes: bytes.length, sha256 }));
  }
  out.shared_as = sharedAs(ev, conversationId);
  return out;
}

/**
 * Take one photo out: its contributor may, the organizer may, nobody else. The file goes first, so
 * a row can never outlive its bytes the other way round. `{ ok }` or `{ ok: false, reason }`.
 */
export function removePhoto({ ev, conversationId, photoId }) {
  const photo = db.photoById(photoId);
  if (!photo || photo.event_id !== ev.id) return { ok: false, reason: "not_found" };
  const role = events.roleIn(conversationId, ev.id);
  const allowed = role && (role.role === "organizer" || photo.conversation_id === conversationId);
  if (!allowed) return { ok: false, reason: "not_yours" };
  unlinkPhoto(ev, photo);
  db.deletePhotoRow(photo.id);
  return { ok: true, photo };
}

// ---------- the organizer's controls ----------

/** Pin (or unpin) one photo as a highlight. Organizer only; optional; never gates anything. */
export function pin({ ev, conversationId, photoId, pinned = true }) {
  if (!events.managed(conversationId, ev.id)) return { ok: false, reason: "not_organizer" };
  const photo = db.photoById(photoId);
  if (!photo || photo.event_id !== ev.id) return { ok: false, reason: "not_found" };
  return { ok: true, photo: db.pinPhoto(photo.id, pinned ? clock.now() : null) };
}

/**
 * The check-in list: the organizer marks a joined guest as actually there (or takes it back). This
 * is the only way a guest gets the album. After release, somebody checked in late is sent the one
 * announcement they would have had — once, under the same message, so it can never be a second copy.
 */
export async function checkIn({ runtime = null, ev, conversationId, guestId, present = true }) {
  if (!events.managed(conversationId, ev.id)) return { ok: false, reason: "not_organizer" };
  const att = db.attendeeById(ev.id, guestId);
  if (!att || att.state !== "joined") return { ok: false, reason: "no_such_guest" };
  if (!present) return { ok: true, guest: att.display_name, checked_in: false, changed: db.undoCheckIn(ev.id, att.conversation_id) };
  const changed = db.checkIn(ev.id, att.conversation_id, conversationId);
  const album = db.albumOf(ev.id);
  let told = null;
  if (changed && album?.released_at && !album.closed_at) told = await announceTo({ runtime, ev, album, att });
  return { ok: true, guest: att.display_name, checked_in: true, changed, ...(told ? { told: told.state } : {}) };
}

/** The organizer's list as the page and the tool show it: every joined guest, checked in or not. Never a number. */
export function checkinList(ev) {
  return db.attendeesOf(ev.id).map(a => ({ guest_id: a.id, display_name: a.display_name, checked_in: db.checkedIn(ev.id, a.conversation_id) }));
}

/**
 * The release announcement, to one guest, once. The words are per guest (their own link), so each
 * guest gets a message row of their own carrying the REAL text: the events feature's retry from the
 * status page resends `message.body`, and must resend these words, never a placeholder. The text is
 * stable per guest (the deadline is fixed at release), so asking again finds the same row and
 * `ensureDelivery` the same delivery — one message, however many times this runs.
 */
async function announceTo({ runtime, ev, album, att }) {
  const body = releaseText(ev, album, att);
  const message = db.recentEventMessage(ev.id, "album", body, 0) ?? db.insertEventMessage(ev.id, "album", body);
  return await events.deliver({ runtime, message, conversationId: att.conversation_id });
}

/**
 * "End event and release album": the organizer's tap, and nothing else. Sets the one deadline
 * (RETENTION from now) and sends every checked-in guest the album link, once. A second tap finds it
 * released and sends nothing. The event's own rows are not touched — the events feature stays as it is.
 */
export async function release({ runtime = null, ev, conversationId }) {
  if (!albumFor(ev)) return { ok: false, reason: "not_available" };
  if (!events.managed(conversationId, ev.id)) return { ok: false, reason: "not_organizer" };
  if (ev.status === "cancelled") return { ok: false, reason: "cancelled" };
  // Paused from the status page: nothing goes out to guests (as blasts and releases are held), so
  // the album is not released either — releasing is the one text it sends.
  if (ev.status !== "active") return { ok: false, reason: ev.status };
  const album = db.ensureAlbum(ev.id, ev.organizer_conversation_id);
  if (album.closed_at) return { ok: false, reason: "closed" };
  const now = clock.now();
  if (!db.releaseAlbum(album.id, { releasedAt: now, expiresAt: now + RETENTION.ms })) {
    return { ok: true, already: true, album: db.albumById(album.id), sent: { guests: 0, sent: 0, failed: 0 } };
  }
  const after = db.albumById(album.id);
  const out = { guests: 0, sent: 0, sending: 0, failed: 0, pending: 0 };
  for (const a of db.attendeesOf(ev.id)) {
    if (!db.checkedIn(ev.id, a.conversation_id)) continue;
    out.guests++;
    const r = await announceTo({ runtime, ev, album: after, att: a });
    out[r.state] = (out[r.state] ?? 0) + 1;
  }
  return { ok: true, album: after, sent: out };
}

// ---------- status ----------

/** One event's album as its organizer (or the status page) may read it. Counts and times, no files. */
export function status(ev) {
  const album = db.albumOf(ev.id);
  const list = checkinList(ev);
  return {
    photos: album ? db.photoCount(album.id) : 0,
    contributors: album ? db.contributorCount(album.id) : 0,
    highlights: album ? db.photosOf(album.id).filter(p => p.pinned_at).length : 0,
    checked_in: list.filter(g => g.checked_in).length,
    guests: list.length,
    released: !!album?.released_at,
    released_at: album?.released_at ?? null,
    expires_at: album?.expires_at ?? null,
    expires: album ? expiryLine(album, ev) : null,
    closed: !!album?.closed_at,
    retention_days: RETENTION.days,
    photo_order: PHOTO_ORDER,
  };
}

/** Albums holding photos the organizer never released: no timer runs on them (open decision). */
export function waiting() {
  return db.albumsWaiting().map(a => {
    const ev = db.getEventRow(a.event_id);
    return { event_id: a.event_id, name: ev?.name ?? "?", organizer: ev ? events.organizerName(ev) || "someone" : "?", photos: a.photos, since: a.created_at };
  });
}

// ---------- expiry ----------

/**
 * The sweep's pass: every album past its deadline is closed and its files deleted — the bytes, not
 * only the rows. A page opened after this says the album closed and when. Nothing here reads the
 * switch: an album released while albums were on still closes on time if they are turned off.
 */
export function sweep({ now = clock.now(), log = () => {} } = {}) {
  const out = { closed: 0, deleted: 0 };
  for (const album of db.albumsToClose(now)) {
    const ev = db.getEventRow(album.event_id);
    for (const p of db.photosOf(album.id)) {
      if (ev) unlinkPhoto(ev, p);
      db.deletePhotoRow(p.id);
      out.deleted++;
    }
    if (ev) { try { rmSync(dirOf(ev), { recursive: true, force: true }); } catch { /* nothing left */ } }
    db.updateAlbum(album.id, { closed_at: now });
    out.closed++;
    log({ album_closed: album.event_id, photos_deleted: out.deleted });
  }
  return out;
}

/** Is anything of this event's album still on disk? For tests and the status page. */
export function filesLeft(ev) {
  try { return readdirSync(dirOf(ev)).length; } catch { return 0; }
}

// ---------- the whole album, as one file ----------

/**
 * A ZIP of the photos one viewer may see, built here with nothing but node:zlib: stored entries
 * (a JPEG does not compress) with CRC-32s, a central directory, and the end record. Enough for
 * Files on an iPhone and for any unzip.
 */
export function zipOf(ev, photos) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Map();
  photos.forEach((p, i) => {
    const file = photoFile(ev, p);
    if (!file) return;
    const data = readFileSync(file);
    const base = `${String(i + 1).padStart(3, "0")}-shared-by-${String(p.shared_by ?? "guest").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "guest"}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const name = Buffer.from(`${base}${n > 1 ? `-${n}` : ""}.${EXT[p.media_type] ?? "jpg"}`);
    const crc = crc32(data);
    const [time, date] = dosTime(p.created_at);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt32LE(0, 36); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

function dosTime(ms) {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return [time, date];
}
