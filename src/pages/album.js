// The album's pages: the attendee album at /e/{id}/album and the organizer's page at
// /e/{id}/album/manage, plus one photo's bytes and the whole album as a ZIP.
//
// Every view is decided here, on the server, for every request, exactly as the event's own pages
// do it (src/pages/event.js): which person this browser is (the page session), then their standing
// on THIS event's album (src/albums.js viewFor). A link — a guest's or the organizer's — only ever
// says whom to text a code to. So a forwarded organizer link opened by a guest shows that guest
// their own album (or their own photos), and opened by a stranger shows the gate and texts the
// organizer, never the stranger; and an attendee link on an unknown browser does the same for its
// own guest. Nobody is ever shown anything on the strength of holding a link.
import { readFileSync } from "node:fs";
import * as db from "../db.js";
import * as albums from "../albums.js";
import { cookieHeader } from "./access.js";
import { shell, esc, renderNotFound, codeInputAttrs, sentLine } from "./render.js";
import { coverUrl } from "../eventcover.js";
import { normalizeNumber, config } from "../config.js";
import * as made from "./made.js";
import * as events from "../events.js";

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });
const redirect = (location, extra = {}) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0, ...extra }), body: "" });
const p = (s) => `<p>${esc(s)}</p>`;

const CSS = `
.al-cover{position:relative;margin:0 0 1.2rem;border-radius:.9rem;overflow:hidden;aspect-ratio:1200/630;background:#2c2520}
.al-cover img{display:block;width:100%;height:100%;object-fit:cover}
.al-cover .al-title{position:absolute;left:0;right:0;bottom:0;padding:1.1rem 1.2rem;background:linear-gradient(transparent,rgba(20,17,14,.75));color:#fff}
.al-cover h1{margin:0;color:#fff;font-size:2rem;line-height:1.1}
.al-cover .al-sub{margin:.3rem 0 0;font-size:.9rem;opacity:.9}
.al-row{display:flex;gap:.6rem;margin:0 0 1.4rem}
.al-btn{display:block;flex:1;text-align:center;padding:.9rem;font-weight:600;border-radius:.6rem;background:var(--ink);color:var(--bg);text-decoration:none;border:0;font:inherit;font-weight:600;cursor:pointer}
.al-btn.al-alt{background:var(--card);color:var(--ink);border:1px solid var(--line)}
.al-h{font-size:.74rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin:1.6rem 0 .6rem}
.al-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem}
.al-grid.al-hi{grid-template-columns:repeat(2,1fr)}
.al-grid.al-hi .al-tile:first-child{grid-column:1/-1;aspect-ratio:16/10}
.al-tile{position:relative;aspect-ratio:1;border-radius:.6rem;overflow:hidden;background:var(--soft)}
.al-tile img{display:block;width:100%;height:100%;object-fit:cover}
.al-tile .al-by{position:absolute;left:0;right:0;bottom:0;padding:.35rem .5rem;font-size:.7rem;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.6))}
.al-tile .al-acts{position:absolute;top:.3rem;right:.3rem;display:flex;gap:.25rem}
.al-tile .al-acts form{margin:0}
.al-act{font:inherit;font-size:.68rem;font-weight:600;padding:.25rem .5rem;border-radius:99px;border:0;background:rgba(255,255,255,.92);color:#2a2520;cursor:pointer;text-decoration:none}
.al-note{opacity:.8;font-size:.92rem;margin:.5rem 0 0}
.al-list{list-style:none;padding:0;margin:0}
.al-list li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.65rem 0;border-bottom:1px solid var(--line)}
.al-list form{margin:0}
.al-pill{font-size:.72rem;font-weight:600;padding:.25rem .6rem;border-radius:99px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-family:inherit;cursor:pointer}
.al-pill.al-on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.al-release{display:block;width:100%;padding:1rem;margin:0 0 .4rem;font:inherit;font-weight:600;font-size:1.05rem;border-radius:.6rem;border:0;background:var(--ink);color:var(--bg);cursor:pointer}
.al-kv{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--line);font-size:.95rem}
.al-kv b{text-align:right}
.ev-form input[type=text]{display:block;width:100%;box-sizing:border-box;min-height:3rem;padding:.8rem .95rem;border-radius:.6rem;border:1px solid var(--line);font:inherit;background:var(--card);color:var(--ink)}
.ev-btn{display:block;width:100%;text-align:center;margin:1rem 0;padding:.95rem;font-weight:600;border-radius:.6rem;background:var(--ink);color:var(--bg);text-decoration:none;border:0;font-size:1rem;cursor:pointer}
.ev-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;opacity:.8}
.ev-err{color:#c0392b;font-weight:600}
`;

const base = (ev) => `/e/${ev.public_id}/album`;
const photoPath = (ev, photo, dl = false) => `${base(ev)}/photo/${photo.id}${dl ? "?dl=1" : ""}`;

/** The event's cover (the link card's picture, public already) over the title and counts. */
function hero(ev, { photos, people }) {
  const sub = [`${photos} photo${photos === 1 ? "" : "s"}`, `${people} ${people === 1 ? "person" : "people"}`].join(" · ");
  return `<div class="al-cover"><img src="${esc(coverUrl(ev))}" alt=""><div class="al-title"><h1>${esc(ev.name)}</h1><p class="al-sub">${esc(sub)}</p></div></div>`;
}

function tile(ev, photo, { organizer = false, viewer = null }) {
  const acts = [];
  if (organizer) {
    acts.push(`<form method="POST" action="${esc(`${base(ev)}/manage`)}"><input type="hidden" name="action" value="${photo.pinned_at ? "unpin" : "pin"}"><input type="hidden" name="photo" value="${photo.id}"><button class="al-act" type="submit">${photo.pinned_at ? "Unpin" : "Pin"}</button></form>`);
  }
  if (organizer || (viewer && photo.conversation_id === viewer)) {
    acts.push(`<form method="POST" action="${esc(organizer ? `${base(ev)}/manage` : base(ev))}"><input type="hidden" name="action" value="remove"><input type="hidden" name="photo" value="${photo.id}"><button class="al-act" type="submit" data-busy="…">Remove</button></form>`);
  }
  acts.push(`<a class="al-act" href="${esc(photoPath(ev, photo, true))}" download>Save</a>`);
  return `<figure class="al-tile"><a href="${esc(photoPath(ev, photo))}"><img src="${esc(photoPath(ev, photo))}" alt="" loading="lazy"></a>`
    + `<div class="al-acts">${acts.join("")}</div><figcaption class="al-by">Shared by ${esc(photo.shared_by)}</figcaption></figure>`;
}

function grid(ev, photos, cls, opts) {
  return `<div class="al-grid${cls ? ` ${cls}` : ""}">${photos.map(ph => tile(ev, ph, opts)).join("")}</div>`;
}

/** The expiry, exactly, so people know when to save. */
function expiryBlock(album, ev) {
  if (!album?.released_at) return "";
  return `<p class="al-note">Up until <b>${esc(albums.expiryLine(album, ev))}</b>. Save what you want before then — after that the photos are deleted.</p>`;
}

/** "Add photos": opens Messages to Reason. The photos go to Reason with the event named. */
function addButton() {
  const number = normalizeNumber(config.sendblueFrom || config.linqFrom);
  if (!number) return "";
  return `<a class="al-btn al-alt" href="${esc(`sms:${number}`)}">+ Add photos</a>`;
}

function closedPage(ev, album, { organizer = false }) {
  const body = `<div class="hero"><p class="kicker">${organizer ? "Your event" : "An event"}</p><h1>${esc(ev.name)}</h1></div>`
    + `<div class="t">${p(`This album closed on ${albums.expiryLine(album, ev)}, ${albums.RETENTION.words} after it was released, and its photos were deleted — as the note before uploading said. Anything already saved to a phone is still there.`)}</div>`;
  return shell({ title: `${ev.name} — album`, body, pill: "Album", css: CSS });
}

/** The attendee album, for one guest: everything once released and checked in; otherwise their own. */
export function renderAlbum({ ev, conversationId, seeAll = false }) {
  if (config.pagesV2) return renderAlbumV2({ ev, conversationId, all: seeAll });
  const { highlights, photos, view } = albums.photosFor(conversationId, ev);
  if (view.closed) return closedPage(ev, view.album, {});
  const all = view.all;
  const album = view.album;
  // Before they may see the album, the counts are their own: how many others added is theirs to learn on release.
  let body = hero(ev, { photos: photos.length, people: all && album ? db.contributorCount(album.id) : (photos.length ? 1 : 0) });
  if (all) {
    body += `<div class="al-row"><a class="al-btn" href="${esc(`${base(ev)}/download`)}">Download album</a>${addButton()}</div>` + expiryBlock(album, ev);
    if (highlights.length) body += `<p class="al-h">Highlights</p>${grid(ev, highlights, "al-hi", { viewer: conversationId })}<p class="al-note">Picked by the organizer.</p>`;
    body += `<p class="al-h">Everyone's photos</p>`;
    body += photos.length ? grid(ev, photos, "", { viewer: conversationId }) : `<div class="t">${p("Nothing here yet.")}</div>`;
  } else {
    const why = !view.released
      ? "The organizer hasn't released the album yet. Once they end the event and release it, checked-in guests get the link."
      : "The album is shared with the guests the organizer checked in. Until then this page shows only the photos you added.";
    body += `<div class="t">${p(why)}</div>` + expiryBlock(album, ev);
    if (photos.length) body += `<p class="al-h">Your photos</p>${grid(ev, photos, "", { viewer: conversationId })}<p class="al-note">Yours to remove any time.</p>`;
    body += `<div class="al-row">${addButton()}</div>`;
  }
  return shell({ title: `${ev.name} — album`, body, pill: "Album", css: CSS });
}

/**
 * The album as Pages v2 draws it (P5 / PD5): photos taped at angles, Caveat captions, "See all N →",
 * DOWNLOAD ALL, and who it's shared with. Same view, same rules as renderAlbum: decided by albums.viewFor.
 */
function renderAlbumV2({ ev, conversationId, all = false }) {
  const { highlights, photos, view } = albums.photosFor(conversationId, ev);
  if (view.closed) return made.renderTurnedOff({ siteUrl: config.siteUrl });
  const ordered = [...highlights, ...photos.filter(p => !highlights.some(h => h.id === p.id))];
  const people = view.all && view.album ? db.contributorCount(view.album.id) : (photos.length ? 1 : 0);
  // The handwritten line under a photo is who sent it in, once per person: a real fact, never a caption made up.
  const named = new Set();
  const shown = ordered.map(ph => {
    const caption = view.all && !named.has(ph.conversation_id) ? (named.add(ph.conversation_id), ph.mine ? "yours" : `from ${ph.shared_by}’s phone`) : "";
    const removeHtml = all && ph.mine
      ? `<form method="POST" action="${esc(base(ev))}" style="margin:0"><input type="hidden" name="action" value="remove"><input type="hidden" name="photo" value="${ph.id}"><input type="hidden" name="all" value="1"><button class="typed rm" type="submit">REMOVE</button></form>`
      : "";
    return { src: photoPath(ev, ph), href: photoPath(ev, ph), alt: `Photo from ${ph.shared_by}`, caption, removeHtml };
  });
  const g = events.guestView(ev, view.att ?? null);
  const dates = g.when && ev.starts_at != null
    ? new Date(ev.starts_at).toLocaleString("en-US", { timeZone: ev.tz, month: "short", day: "numeric" }).toUpperCase()
    : "";
  const n = shown.length;
  const counts = `${n} PHOTO${n === 1 ? "" : "S"}`;
  const checked = albums.counts(ev).checked_in;
  const why = view.all ? "" : !view.released
    ? "The organizer hasn't released the album yet. Once they end the event and release it, checked-in guests get the link."
    : "The album is shared with the guests the organizer checked in. Until then this page shows only the photos you added.";
  return made.renderAlbum({
    title: ev.name,
    kicker: view.all ? `${counts} · ${people} OF YOU` : counts,
    deskKicker: view.all ? `${counts} · FROM ${people} OF YOU` : counts,
    meta: [dates, view.all && people ? `SENT IN BY ${people} ${people === 1 ? "PERSON" : "PEOPLE"}` : ""].filter(Boolean).join(" · "),
    deskMeta: dates,
    photos: shown, total: n, all,
    seeAllHref: `${base(ev)}?all=1`,
    downloadHref: view.all && n ? `${base(ev)}/download` : "",
    addLine: "Text Reason a photo to add it.",
    why,
    // LP3: the album's link previews as its event's own card, under the album's name.
    head: [
      `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="Reason">`,
      `<meta property="og:title" content="${esc(`${ev.name} — album`)}">`,
      `<meta property="og:image" content="${esc(coverUrl(ev))}">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].join(""),
    foot: view.all && checked ? `Shared with the ${checked} ${checked === 1 ? "person" : "people"} at this event. Made with Reason.` : "Shared with the organizer. Made with Reason.",
  });
}

/** The organizer's page: release, the check-in list, highlights, every photo with pin and remove. */
export function renderManage({ ev, conversationId, done = "" }) {
  const { highlights, photos, view } = albums.photosFor(conversationId, ev);
  if (view.closed) return closedPage(ev, view.album, { organizer: true });
  const album = view.album;
  const list = albums.checkinList(ev);
  const inCount = list.filter(g => g.checked_in).length;
  const act = `${base(ev)}/manage`;
  let body = `<div class="hero"><p class="kicker">Your event's album</p></div>` + hero(ev, { photos: photos.length, people: album ? db.contributorCount(album.id) : 0 });
  if (done) body += `<p class="al-note">${esc(done)}</p>`;
  if (album?.released_at) {
    body += `<div class="t">${p(`Released ${albums.whenLine(album.released_at, ev.tz)}. ${inCount} checked-in guest${inCount === 1 ? "" : "s"} got the link, once.`)}</div>` + expiryBlock(album, ev);
  } else {
    body += `<form method="POST" action="${esc(act)}"><input type="hidden" name="action" value="release"><button class="al-release" type="submit" data-busy="Releasing…">End event and release album</button></form>`
      + `<p class="al-note">Sends one message to checked-in guests with the album link. Late uploads stay open after release. Photos are kept for ${albums.RETENTION.words} after release, then deleted. The scheduled end time releases nothing — only this does.</p>`;
  }
  body += `<div class="al-row" style="margin-top:1rem"><a class="al-btn al-alt" href="${esc(`${base(ev)}/download`)}">Download album</a></div>`;
  body += `<p class="al-h">Check-in list · ${inCount} of ${list.length} checked in</p>`;
  if (album?.released_at && list.length && !inCount) body += `<p class="al-note"><b>Nobody can see the album yet.</b> Only checked-in guests get it — check in the people who were there.</p>`;
  body += list.length
    ? `<ul class="al-list">${list.map(g => `<li><span>${esc(g.display_name || "a guest")}</span><form method="POST" action="${esc(act)}"><input type="hidden" name="action" value="${g.checked_in ? "undo" : "checkin"}"><input type="hidden" name="guest" value="${g.guest_id}"><button class="al-pill${g.checked_in ? " al-on" : ""}" type="submit">${g.checked_in ? "Checked in" : "Check in"}</button></form></li>`).join("")}</ul>`
    : `<div class="t">${p("Nobody has joined yet.")}</div>`;
  if (list.length > inCount) body += `<form method="POST" action="${esc(act)}" style="margin-top:.8rem"><input type="hidden" name="action" value="checkin_all"><button class="al-btn al-alt" type="submit" data-busy="Checking in…" style="width:100%">Check everyone in</button></form>`;
  body += `<p class="al-note">Only checked-in guests can open the album. Nobody is checked in on their own.${album?.released_at ? " Anyone checked in now is texted the link, once." : ""}</p>`;
  body += `<p class="al-h">Highlights</p>`;
  body += highlights.length ? grid(ev, highlights, "al-hi", { organizer: true }) : `<div class="t">${p("None pinned. Pin any photo below to put it on top — optional, any time.")}</div>`;
  body += `<p class="al-h">Everyone's photos</p>`;
  body += photos.length ? grid(ev, photos, "", { organizer: true }) : `<div class="t">${p("Nothing yet. Photos guests send Reason for this event land here.")}</div>`;
  return shell({ title: `${ev.name} — album`, body, pill: "Album", css: CSS });
}

/** The gate for a browser Reason does not recognize: the event's name, and a code to the link's owner. */
export function renderGate({ ev, action, token, sent = false, error = "" }) {
  const body = `<div class="hero"><p class="kicker">An event</p><h1>${esc(ev.name)}</h1></div>`
    + `<div class="t">${p("This album is private. To open it on this browser, confirm it's you: Reason will text a code to the phone this link belongs to.")}</div>`
    + (error ? `<p class="ev-err">${esc(error)}</p>` : "")
    + (sent
      ? (error ? "" : sentLine("Code sent — check your texts."))
        + `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="code">`
        + `<label for="code">The code from your texts</label><input id="code" ${codeInputAttrs()} required>`
        + `<button class="ev-btn" type="submit" data-busy="Checking…">Open</button></form>`
        + `<div class="t">${p("The code works once, for 15 minutes. If it doesn't arrive, this link isn't yours.")}</div>`
      : `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="send">`
        + `<button class="ev-btn" type="submit" data-busy="Sending code…">Text me a code</button></form>`);
  return shell({ title: ev.name, body, pill: "Album", css: CSS });
}

/** Whose link this is: the organizer's, or a joined guest's. Null for anything else. */
function tokenOwner(ev, token) {
  if (!token || typeof token !== "string" || token.length > 80) return null;
  if (ev.organizer_token === token) return { conversationId: ev.organizer_conversation_id, organizer: true };
  const att = db.attendeeByToken(token);
  if (att && att.event_id === ev.id && att.state === "joined") return { conversationId: att.conversation_id, organizer: false };
  return null;
}

/**
 * GET/POST under /e/{id}/album. `account` and `mine` are what src/pages/event.js already read off the
 * browser's page session (whom this browser belongs to, and their role in this event); `sendCode`
 * texts that person a sign-in code the way the who's-going gate does; `tryCode` checks one.
 */
export async function albumRequest({ ev, sub, method, query = {}, headers = {}, readBody, account = null, mine = null, runtime = null, sendCode, tryCode, log = () => {} }) {
  if (!albums.albumFor(ev) || ev.status === "cancelled") return page(404, renderNotFound());
  const rest = String(sub).replace(/^album\/?/, "");
  const c = account?.conversation_id ?? null;
  // A browser Reason knows, belonging to somebody with no place on this event: nothing — the same
  // bytes as a link that was never real. The gate below is only for a browser nobody has proved,
  // where the link's owner is the one person who can be texted.
  if (account && !mine) return page(404, renderNotFound());
  const view = mine ? albums.viewFor(c, ev) : null;

  // ---- one photo's bytes ----
  const photoRoute = /^photo\/(\d+)$/.exec(rest);
  if (photoRoute) {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    const photo = db.photoById(photoRoute[1]);
    if (!c || !albums.canSeePhoto(c, ev, photo)) return page(404, renderNotFound());
    const file = albums.photoFile(ev, photo);
    let bytes = null;
    try { bytes = file ? readFileSync(file) : null; } catch { bytes = null; }
    if (!bytes) return page(404, renderNotFound());
    const name = `${ev.name.replace(/[^\w-]+/g, "-").slice(0, 40)}-${photo.id}.${{ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[photo.media_type] ?? "jpg"}`;
    return { status: 200, headers: { "Content-Type": photo.media_type, "Content-Length": bytes.length, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Content-Disposition": `${query.dl === "1" ? "attachment" : "inline"}; filename="${name}"` }, body: bytes };
  }

  // ---- the whole album ----
  if (rest === "download") {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (!view?.all) return page(404, renderNotFound());
    const { photos } = albums.photosFor(c, ev);
    const zip = albums.zipOf(ev, photos);
    log({ album_download: ev.id, photos: photos.length });
    return { status: 200, headers: { "Content-Type": "application/zip", "Content-Length": zip.length, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Content-Disposition": `attachment; filename="${ev.name.replace(/[^\w-]+/g, "-").slice(0, 40)}-album.zip"` }, body: zip };
  }

  if (rest !== "" && rest !== "manage") return page(404, renderNotFound());
  const manage = rest === "manage";
  const action = `${base(ev)}${manage ? "/manage" : ""}`;
  const form = method === "POST" ? new URLSearchParams((await readBody()) ?? "") : null;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return page(405, renderNotFound(), { Allow: "GET, HEAD, POST" });

  // ---- a browser recognized as somebody on this event: their own view, whatever link they opened ----
  if (view?.role) {
    if (form && form.get("step") == null) {
      const op = form.get("action");
      let done = "";
      if (view.role === "organizer") {
        if (op === "release") {
          const r = await albums.release({ runtime, ev, conversationId: c });
          done = r.ok ? (r.already ? "Already released." : r.nudge && !r.checked_in ? (r.joined ? "Released. Nobody is checked in, so nobody can see it yet." : "Released. Nobody joined through Reason, so there's no one to send it to.") : "Released.") : "Couldn't release.";
          // Released from the page, to fewer than everyone who joined: the organizer is told by text,
          // in Reason's words, so a release to nobody is never silent (the tool's turn says it itself).
          if (r.ok && !r.already && r.nudge) await albums.nudgeOrganizer({ runtime, ev, text: r.nudge });
          log({ album_release: ev.id, ok: r.ok, already: !!r.already, joined: r.joined, checked_in: r.checked_in });
        }
        else if (op === "checkin" || op === "undo") { const r = await albums.checkIn({ runtime, ev, conversationId: c, guestId: Number(form.get("guest")), present: op === "checkin" }); done = r.ok ? "" : "No such guest."; }
        else if (op === "checkin_all") { const r = await albums.checkInAll({ runtime, ev, conversationId: c }); done = r.changed ? `${r.checked_in} of ${r.joined} checked in${r.told ? `; ${r.told} texted the link` : ""}.` : ""; log({ album_checkin_all: ev.id, newly: r.changed, told: r.told }); }
        else if (op === "pin" || op === "unpin") albums.pin({ ev, conversationId: c, photoId: Number(form.get("photo")), pinned: op === "pin" });
        else if (op === "remove") albums.removePhoto({ ev, conversationId: c, photoId: Number(form.get("photo")) });
        return redirect(`${base(ev)}/manage${done ? `?done=${encodeURIComponent(done)}` : ""}`);
      }
      if (op === "remove") albums.removePhoto({ ev, conversationId: c, photoId: Number(form.get("photo")) });
      return redirect(config.pagesV2 && form.get("all") === "1" ? `${base(ev)}?all=1` : base(ev));
    }
    if (form) return redirect(action);
    if (view.role === "organizer") return page(200, renderManage({ ev, conversationId: c, done: String(query.done ?? "").slice(0, 80) }));
    return page(200, renderAlbum({ ev, conversationId: c, seeAll: query.all === "1" }));
  }

  // ---- anybody else: the link says whose page it is, and that person — only — is texted a code ----
  const token = form ? form.get("t") : query.t;
  const owner = tokenOwner(ev, token);
  if (!owner) return page(404, renderNotFound());
  if (form?.get("step") === "send") {
    const asked = sendCode({ conversationId: owner.conversationId, what: owner.organizer ? "open the album page for" : "open the album for" });
    if (!asked.ok) {
      const mins = Math.max(1, Math.ceil((asked.retry_after_s ?? 900) / 60));
      const why = asked.reason === "rate_limited" && asked.retry_after_s >= 3600 ? `Too many code requests from this browser. Try again in about ${Math.round(mins / 60)} hour${mins >= 90 ? "s" : ""}.` : `Reason has already texted this link's code. Use that one, or try again in about ${mins} minutes.`;
      return page(asked.retry_after_s >= 3600 ? 429 : 200, renderGate({ ev, action, token, sent: true, error: why }));
    }
    return page(200, renderGate({ ev, action, token, sent: true }));
  }
  if (form?.get("step") === "code") {
    const tried = tryCode({ conversationId: owner.conversationId, code: form.get("code") });
    if (!tried.ok) {
      log({ album_signin_failed: ev.id, why: tried.reason });
      return page(tried.reason === "rate_limited" ? 429 : 200, renderGate({ ev, action, token, sent: true, error: tried.reason === "rate_limited" ? "Too many wrong codes from this browser. Try again in about 15 minutes." : "That code isn't right." }));
    }
    log({ album_signin_ok: ev.id });
    return redirect(action, { "Set-Cookie": cookieHeader(tried.token, { path: "/", headers }) });
  }
  return page(200, renderGate({ ev, action, token }));
}
