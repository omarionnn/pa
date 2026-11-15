// A picture is only "sent" when it arrived (owner, 2026-11-14: "let's confirm texts always arrive
// before we say sent").
//
// What went wrong: send_picture handed a shop's own image address (a third-party CDN link with a query
// string) straight to the texting provider, which answered QUEUED; Reason said "it should come through
// in a second", and the picture never arrived. Nothing checked: that send skipped the outbox.
//
// Now, in this order, all of it code's:
//
//   1. FETCHED HERE FIRST. The address goes through the same guard every link somebody else chose goes
//      through (src/netguard.js guardedFetch: https only, every name resolved and refused unless public,
//      the connection pinned to those addresses, each redirect a new checked hop), with a timeout, a
//      size cap, an image content type, and bytes that really are a JPEG, PNG, GIF or WebP
//      (src/pictures.js sniff).
//   2. KEPT ON REASON'S OWN HOST. Stored like a table picture (src/webuploads.js, `public: "picture"`,
//      a 128-bit random address, gone after 30 days), so the provider fetches OUR copy, not a CDN link
//      that may refuse it, expire, or need a cookie.
//   3. THROUGH THE OUTBOX. A row before an attempt, retried like any text, its delivery reported back.
//      QUEUED is "on its way", never "sent".
//   4. WATCHED. ~75 seconds later (the next sweep after WATCH_MS): DELIVERED (or SENT) on the row, or
//      from the provider's own status lookup, and nothing more is said. Anything else (an error, a
//      failed row, no word at all) gets ONE line from code with the link: never a claim it was sent.
//
// If the fetch fails the picture is not sent at all: the link goes as text with an honest line.
import * as db from "./db.js";
import { clock } from "./config.js";
import { guardedFetch } from "./netguard.js";
import { sniff, READABLE } from "./pictures.js";
import * as uploads from "./webuploads.js";
import { DELIVERED_STATUSES } from "./outbox.js";

export const MAX_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const WATCH_MS = 75_000;

export const FETCH_FAILED_LINE = (link) => `I couldn't send that picture here, so here's the link:\n${link}`;
export const DIDNT_ARRIVE_LINE = (link) => `That picture didn't go through, here's the link:\n${link}`;
/** What the model is told once the picture is handed over: on its way, not delivered. */
export const ON_ITS_WAY_NOTE = "The picture is on its way: the texting service has taken it but has NOT confirmed it arrived."
  + " If you mention it, say you're sending it. Never say it was sent, delivered, or that it should come through."
  + " Reason checks it arrived and, if it didn't, texts them the link by itself.";

db.db.exec(`
  -- A picture send_picture handed to the outbox, watched until it is known to have arrived (src/pictureout.js).
  -- link is the address the picture came from (what they are texted if it didn't arrive); status is the
  -- provider's last word; outcome is delivered | told | dropped once settled.
  CREATE TABLE IF NOT EXISTS picture_watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    outbox_id INTEGER,
    link TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    outcome TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS picture_watches_due ON picture_watches (settled_at, due_at);
`);
const q = (sql) => db.db.prepare(sql);

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

async function readCapped(res, max) {
  const len = Number(res.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(len) && len > max) return { over: true };
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > max ? { over: true } : { bytes: buf };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch { /* gone anyway */ } return { over: true }; }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks) };
}

/**
 * Fetch a picture somebody else hosts and keep it on Reason's own host. → { ok: true, url, file, mime,
 * filename, bytes } or { ok: false, why, refused? } (`refused`: an address the guard will not fetch at all).
 */
export async function rehost({ url, conversationId, fetchImpl = null, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES, store = uploads.store }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer?.unref?.();
  try {
    let got;
    try {
      got = await guardedFetch(url, { httpsOnly: true, signal: ac.signal, fetchImpl, headers: { accept: "image/*" } });
    } catch (e) {
      return { ok: false, why: e?.name === "AbortError" ? "it took too long to load" : "it could not be loaded" };
    }
    if (!got.ok) return { ok: false, refused: true, why: got.why };
    const res = got.res;
    if (!res.ok) return { ok: false, why: `the site answered ${res.status}` };
    const type = String(res.headers?.get?.("content-type") ?? "").toLowerCase();
    if (!type.startsWith("image/")) return { ok: false, why: "that address is not a picture" };
    let body;
    try { body = await readCapped(res, maxBytes); } catch (e) { return { ok: false, why: e?.name === "AbortError" ? "it took too long to load" : "it could not be loaded" }; }
    if (body.over) return { ok: false, why: `the picture is bigger than ${Math.round(maxBytes / 1048576)} MB` };
    const mime = sniff(body.bytes);
    if (!READABLE.has(mime)) return { ok: false, why: "that address is not a picture" };
    const m = store({ conversationId, bytes: body.bytes, name: `picture.${EXT[mime]}`, extra: { public: "picture" } });
    if (!m || m.error) return { ok: false, why: `it could not be kept (${m?.error ?? "no record"})` };
    return { ok: true, url: uploads.uploadUrl(m.id, m.name), file: uploads.filePath(m), id: m.id, mime, filename: m.name, bytes: body.bytes.length };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the watch
export function watch({ conversationId, outboxId, link, now = clock.now() }) {
  const r = q("INSERT INTO picture_watches (conversation_id, outbox_id, link, due_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, outboxId ?? null, String(link), now + WATCH_MS, now);
  return Number(r.lastInsertRowid);
}
export const watchesOf = (c) => q("SELECT * FROM picture_watches WHERE conversation_id = ? ORDER BY id").all(c);

/** The provider's callback on a watched picture's row (src/outbox.js noteDelivery). An error settles it on the next pass. */
export function noteStatus(conversationId, outboxId, status) {
  const s = String(status ?? "").toUpperCase();
  if (!conversationId || !outboxId || !s) return;
  q(`UPDATE picture_watches SET status = ?, due_at = CASE WHEN ? = 'ERROR' THEN MIN(due_at, ?) ELSE due_at END WHERE conversation_id = ? AND outbox_id = ? AND settled_at IS NULL`)
    .run(s, s, clock.now(), conversationId, outboxId);
}

const arrived = (s) => DELIVERED_STATUSES.has(String(s ?? "").toUpperCase());

/**
 * Settle every watch that is due. `tell(conversationId, text, meta)` is the runtime's code line
 * (Runtime._tell). Never throws. → { delivered, told }
 */
export async function pass({ router, tell, now = clock.now(), log = () => {} }) {
  const out = { delivered: 0, told: 0 };
  let due = [];
  try { due = q("SELECT * FROM picture_watches WHERE settled_at IS NULL AND due_at <= ? ORDER BY id LIMIT 50").all(now); } catch { return out; }
  for (const w of due) {
    try {
      const row = w.outbox_id ? db.getOutbound(w.outbox_id) : null;
      let status = String(row?.delivery_status || w.status || "").toUpperCase();
      // No word yet on a row the provider took: ask it (Sendblue GET /api/status), once, now.
      if (!arrived(status) && status !== "ERROR" && row?.state === "sent" && row.message_id) {
        const ch = router?.get?.(row.channel);
        if (typeof ch?.messageStatus === "function") {
          const asked = await ch.messageStatus(row.message_id).catch(() => null);
          if (asked?.ok && asked.status) status = String(asked.status).toUpperCase();
        }
      }
      if (row?.state === "sent" && arrived(status)) {
        q("UPDATE picture_watches SET settled_at = ?, outcome = 'delivered', status = ? WHERE id = ? AND conversation_id = ?").run(now, status, w.id, w.conversation_id);
        out.delivered++;
        continue;
      }
      // Claimed before the line, so a crash between the two never texts the link twice.
      if (q("UPDATE picture_watches SET settled_at = ?, outcome = 'told', status = ? WHERE id = ? AND conversation_id = ? AND settled_at IS NULL").run(now, status, w.id, w.conversation_id).changes !== 1) continue;
      // Their next turn would otherwise open with the same failure: they have been told.
      if (row && (row.state === "failed")) { try { db.markUndeliveredTold(row.id); } catch { /* the notice is a nicety */ } }
      const r = await tell(w.conversation_id, DIDNT_ARRIVE_LINE(w.link), { idempotencyKey: `picture-missed:${w.id}` });
      if (r?.ok === false && !r.queued) log({ picture_watch: w.id, could_not_tell: r.error ?? "no reason given" });
      else out.told++;
      log({ picture_watch: w.id, outcome: "told", status: status || "none", state: row?.state ?? "no row" });
    } catch (e) {
      log({ picture_watch: w.id, error: (e?.message ?? String(e)).split("\n")[0] });
    }
  }
  return out;
}

/** Tests only. */
export function _reset() { /* tests clear the table themselves */ }
