// The event's two pages: the public join page at /e/{id}, and the who's-going page at /e/{id}/who.
//
// The join page is opened by anybody the link reaches — a guest, a friend it was forwarded to, a
// phone drawing a link preview — so before the password it shows the event's name and description
// and nothing else: no time, no place, no guest list, in the page and in its preview tags alike.
//
// After the password, two people arrive at the same button:
//
//   - **somebody already on Reason**, recognized by the page session they already hold (the
//     `reason_page` cookie a page of theirs set). They are joined there and then — no signup, no
//     code — and the welcome goes to their Reason thread.
//   - **anybody else**, who fills in the rest on the page — display name, Instagram if they like,
//     whether to appear on the who's-going page — reads plainly that joining signs them up for
//     Reason, and finishes with one tap: "Text Reason to finish".
//
// Why the last step is a text and not a code sent to them. The live line is on Sendblue's
// inbound-only plan: Reason may only text numbers that texted it first, and a new guest has not. So
// the proof runs the other way round, exactly as invites do (src/invites.js): the page opens a text
// TO Reason with a one-time code in it, they press send, and that text — which only the phone with
// that number can send — proves the number and finishes the join in one transaction
// (db.redeemEventClaim, from src/channels/router.js). It is the LAST step, after everything else is
// done on the page, so nobody is bounced to Messages halfway through. Somebody already on Reason who
// had no page session lands here too, and the same text simply finds their account: no signup.
// If outbound texting ever becomes possible, `finishStep` is the one place to swap for a code sent
// to them.
import * as db from "../db.js";
import * as events from "../events.js";
import * as accounts from "../accounts.js";
import { readCookie, SESSION_TTL_MS } from "./access.js";
import { shell, esc, renderNotFound } from "./render.js";
import { normalizeNumber } from "../config.js";
import { prettyNumber } from "../invites.js";

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });

const CSS = `
.ev-form label{display:block;margin:.8rem 0 .3rem;font-weight:600}
.ev-form input[type=text],.ev-form input[type=password]{width:100%;box-sizing:border-box;padding:.75rem;border-radius:.5rem;border:1px solid var(--line,#ccc);font:inherit;background:transparent;color:inherit}
.ev-form .check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;margin:.8rem 0}
.ev-btn{display:block;width:100%;text-align:center;margin:1rem 0;padding:.95rem;font-weight:600;border-radius:.6rem;background:var(--ink);color:var(--bg);text-decoration:none;border:0;font-size:1rem;cursor:pointer}
.ev-note{opacity:.8;font-size:.95rem}
.ev-err{color:#c0392b;font-weight:600}
.ev-list{list-style:none;padding:0;margin:0}
.ev-list li{padding:.7rem 0;border-bottom:1px solid var(--line,#ddd);display:flex;justify-content:space-between;gap:1rem}
.ev-list a{color:inherit}
`;

/**
 * Who this browser belongs to, when it has a page session for an account Reason already has.
 * Null for anybody else. The session is the one every private page uses (src/pages/access.js).
 */
export function sessionAccount(headers) {
  const token = readCookie(headers?.cookie);
  const owner = token ? db.pageSessionOwner(token, SESSION_TTL_MS) : null;
  return owner ? db.getAccount(owner) : null;
}

/**
 * The address a browser's wrong passwords are counted against. The forwarded address only when the
 * request came through the proxy on this machine (Caddy sets it, and replaces whatever the browser
 * sent); otherwise the socket's own, so nobody can pick a fresh address per guess by writing a header.
 */
export function eventActor(headers = {}, remoteAddress = "") {
  // Through Caddy on the files domain (it marks those requests, and replaces any X-Forwarded-For a
  // browser sent with the real address): the forwarded address, and only that header — never the
  // Netlify one, which nothing on that path strips. Anything else: the socket's own address.
  const local = /^(127\.|::1$|::ffff:127\.)/.test(String(remoteAddress));
  const viaCaddy = local && String(headers["x-files-domain"] ?? "") === "true";
  const xff = viaCaddy ? String(headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  return `ip:${(xff || String(remoteAddress || "unknown")).slice(0, 64)}`;
}

/** The preview tags: the name and the description, which is everything the page shows a stranger. */
function headFor(ev) {
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(ev.name)}">`,
    `<meta property="og:description" content="${esc(ev.description.slice(0, 200))}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(ev.name)}">`,
  ].map(t => `\n${t}`).join("");
}

const p = (s) => `<p>${esc(s)}</p>`;
const intro = (ev) => `<div class="hero"><p class="kicker">An event</p><h1>${esc(ev.name)}</h1></div><div class="t">${p(ev.description)}</div>`;

function closedBody(ev) {
  if (ev.status === "cancelled") return `${`<div class="hero"><p class="kicker">An event</p><h1>${esc(ev.name)}</h1></div>`}<div class="t">${p("This event was cancelled by its organizer.")}</div>`;
  return `${intro(ev)}<div class="t">${p("Joining is paused for this event right now. Try again later.")}</div>`;
}

/** The released details, for somebody who has joined. */
function detailsBlock(ev, att) {
  const v = events.guestView(ev, att);
  const rows = [
    v.when ? `<p><b>When:</b> ${esc(v.when)}</p>` : `<p><b>When:</b> <span class="ev-note">the organizer will share it later</span></p>`,
    v.where ? `<p><b>Where:</b> ${esc(v.where)}</p>` : `<p><b>Where:</b> <span class="ev-note">the organizer will share it later</span></p>`,
  ];
  return `<div class="t">${rows.join("")}</div>`;
}

/** The pages' own addresses, absolute, as the browser sees them (the files domain hides its /p). */
const joinPath = (ev) => `/e/${ev.public_id}/join`;
const whoPath = (ev, token) => `/e/${ev.public_id}/who?t=${encodeURIComponent(token)}`;

export function renderJoin({ ev, account = null, error = "", values = {} }) {
  const signedIn = !!account;
  const field = (name, label, type = "text", extra = "") =>
    `<label for="${name}">${esc(label)}</label><input id="${name}" name="${name}" type="${type}" ${extra} value="${type === "password" ? "" : esc(values[name] ?? "")}">`;
  const form = `<form class="ev-form" method="POST" action="${esc(joinPath(ev))}">`
    + (error ? `<p class="ev-err">${esc(error)}</p>` : "")
    + field("password", "Event password", "password", `autocomplete="off" required maxlength="200"`)
    + (signedIn ? "" : field("display_name", "Your name (what other guests see)", "text", `required maxlength="40" autocomplete="name"`))
    + field("instagram", "Instagram (optional)", "text", `maxlength="60" autocapitalize="off" placeholder="@yourhandle"`)
    + `<label class="check"><input type="checkbox" name="in_directory" value="1"${values.in_directory ? " checked" : ""}> <span>Show me on the who's-going page (name and Instagram, never your number)</span></label>`
    + (signedIn
      ? `<div class="t">${p(`You're signed in to Reason${account.name ? ` as ${account.name}` : ""}, so this just adds you to the event — no signup.`)}</div>`
      : `<div class="t">${p("Joining this event also signs you up for Reason, a free assistant that lives in your texts. It's how you'll get the event's updates, and you can use it for anything else too.")}`
        + p("Already use Reason? Same button — it recognizes your number and just adds you to the event.") + `</div>`)
    + `<button class="ev-btn" type="submit">Join</button></form>`;
  const body = intro(ev) + `<h2>Join</h2>` + form + `<p class="foot"><span class="dot"></span><span>Reason</span></p>`;
  return shell({ title: ev.name, body, pill: "Event", head: headFor(ev), css: CSS });
}

/** The last step for anybody without a page session: one text that proves the phone and joins. */
export function finishStep({ ev, claim, lineNumber }) {
  const code = claim.code;
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  if (!lineNumber) {
    return `${intro(ev)}<div class="t">${p("Reason's texting line isn't connected right now, so this can't be finished at the moment. Nothing was used up — try again later.")}</div>`;
  }
  const href = `sms:${normalizeNumber(lineNumber)}?&body=${encodeURIComponent(events.claimText(ev, code))}`;
  return `${intro(ev)}<h2>Last step</h2><div class="t">`
    + p("Tap the button. It opens a text to Reason with your code already written in — just press send. That text is how Reason knows the number is really yours, and it finishes your join.")
    + `</div><a class="ev-btn" href="${esc(href)}">Text Reason to finish</a><div class="t">`
    + p(`Not on your phone? From your phone, text ${shown} to ${prettyNumber(lineNumber)}.`)
    + p("The code works once, for 24 hours. If you already use Reason, it just adds the event to your account.")
    + `</div>`;
}

export function renderJoined({ ev, att }) {
  const dir = ev.guest_list_visible ? `<a class="ev-btn" href="${esc(whoPath(ev, att.token))}">See who's going</a>` : "";
  const body = `${intro(ev)}<h2>You're in</h2>${detailsBlock(ev, att)}<div class="t">${p("Your welcome is in your texts with Reason, and event updates will come there too.")}</div>${dir}`;
  return shell({ title: ev.name, body, pill: "Event", head: headFor(ev), css: CSS });
}

/** The who's-going page for one viewer: a joined guest (their own token) or the organizer. */
export function renderWho({ ev, att = null, organizer = false, token, saved = false }) {
  const list = events.directoryEntries(ev, { organizer });
  const items = list.length
    ? `<ul class="ev-list">${list.map(e => `<li><span>${esc(e.name)}${organizer && !e.listed ? ` <span class="ev-note">(not listed)</span>` : ""}</span>${e.instagram ? `<a href="${esc(events.instagramUrl(e.instagram))}" rel="noopener noreferrer" target="_blank">@${esc(e.instagram)}</a>` : ""}</li>`).join("")}</ul>`
    : `<div class="t">${p(organizer ? "Nobody has joined yet." : "Nobody has put themselves on the list yet.")}</div>`;
  const listBlock = ev.guest_list_visible || organizer
    ? `<h2>Who's going</h2>${items}`
    : `<div class="t">${p("The organizer is keeping the guest list private.")}</div>`;
  const mine = att ? `<h2>You</h2><form class="ev-form" method="POST" action="${esc(`/e/${ev.public_id}/who`)}">`
    + `<input type="hidden" name="t" value="${esc(token)}">`
    + (saved ? `<p class="ev-note">Saved.</p>` : "")
    + `<label for="display_name">Name other guests see</label><input id="display_name" name="display_name" type="text" maxlength="40" value="${esc(att.display_name)}">`
    + `<label for="instagram">Instagram (optional — leave empty to remove)</label><input id="instagram" name="instagram" type="text" maxlength="60" autocapitalize="off" value="${esc(att.instagram ?? "")}">`
    + `<label class="check"><input type="checkbox" name="in_directory" value="1"${att.in_directory ? " checked" : ""}> <span>Show me on this page</span></label>`
    + `<button class="ev-btn" type="submit">Save</button></form>` : "";
  const head = organizer ? `<div class="t">${p("Your guest list, with everyone — including people who chose not to be listed. Phone numbers are never shown.")}</div>` : "";
  const details = att ? detailsBlock(ev, att) : `<div class="t">${p(`When: ${events.whenLine(ev) ?? "not set"}`)}${p(`Where: ${ev.location || "not set"}`)}</div>`;
  const paused = ev.status === "paused" ? `<div class="t">${p("This event is paused right now.")}</div>` : "";
  const body = `<div class="hero"><p class="kicker">${organizer ? "Your event" : "An event"}</p><h1>${esc(ev.name)}</h1></div>${paused}${details}${head}${listBlock}${mine}`;
  return shell({ title: `${ev.name} — who's going`, body, pill: "Event", css: CSS });
}

/** Whose page this token opens, if anybody's: an attendee still on the event, or the organizer. */
function viewerFor(ev, token) {
  if (!token || typeof token !== "string" || token.length > 80) return null;
  if (ev.organizer_token === token) return { organizer: true, att: null };
  const att = db.attendeeByToken(token);
  if (att && att.event_id === ev.id && att.state === "joined") return { organizer: false, att };
  return null;
}

/**
 * GET/POST /e/{id}[/join|/who]. `lineNumber` is the texting line's number for the sms: link, or null
 * when no line is live. `runtime` sends the welcome to somebody joined on the page.
 */
export async function eventPageRequest({ publicId, sub = null, method, query = {}, headers = {}, remoteAddress = "", readBody, runtime = null, lineNumber = null, log = () => {} }) {
  const ev = db.eventByPublicId(publicId);
  if (!ev || !events.eventsOn()) return page(404, renderNotFound());

  // ---- the who's-going page ----
  if (sub === "who") {
    const form = method === "POST" ? new URLSearchParams((await readBody()) ?? "") : null;
    const token = form ? form.get("t") : query.t;
    const viewer = ev.status === "cancelled" ? null : viewerFor(ev, token);
    if (!viewer) return page(404, renderNotFound());
    if (form) {
      if (!viewer.att) return page(405, renderNotFound());
      const fields = { in_directory: form.get("in_directory") === "1" ? 1 : 0 };
      const name = events.cleanDisplayName(form.get("display_name"));
      if (name) fields.display_name = name;
      const ig = String(form.get("instagram") ?? "").trim();
      fields.instagram = ig ? events.instagramHandle(ig) ?? viewer.att.instagram : null;
      db.updateAttendeeRow(viewer.att.id, fields);
      return { status: 303, headers: HTML({ Location: `${whoPath(ev, token)}&saved=1`, "Content-Length": 0 }), body: "" };
    }
    const att = viewer.att ? db.attendeeRow(ev.id, viewer.att.conversation_id) : null;
    return page(200, renderWho({ ev, att, organizer: viewer.organizer, token, saved: query.saved === "1" }));
  }

  // ---- the join page ----
  if (method !== "GET" && method !== "HEAD" && !(method === "POST" && sub === "join")) {
    return page(405, renderNotFound(), { Allow: "GET, HEAD" });
  }
  // Cancelled: nothing but the name and that it is off, in the page and in its preview alike.
  if (ev.status !== "active") return page(200, shell({ title: ev.name, body: closedBody(ev), pill: "Event", head: ev.status === "cancelled" ? "" : headFor(ev), css: CSS }));
  const account = sessionAccount(headers);
  const mine = account ? db.attendeeRow(ev.id, account.conversation_id) : null;
  if (mine?.state === "joined") return page(200, renderJoined({ ev, att: mine }));
  if (method !== "POST") return page(200, renderJoin({ ev, account }));

  const form = new URLSearchParams((await readBody()) ?? "");
  const values = { display_name: form.get("display_name") ?? "", instagram: form.get("instagram") ?? "", in_directory: form.get("in_directory") === "1" };
  const again = (status, error) => page(status, renderJoin({ ev, account, error, values }));
  const actor = eventActor(headers, remoteAddress);
  const found = await events.findForJoin({ actor, link: events.eventUrl(ev), password: form.get("password") ?? "", route: "web" });
  if (!found.ok) {
    log({ event_web_join_refused: ev.id, why: found.reason });
    if (found.reason === "rate_limited") return again(429, `Too many wrong tries. Try again in about ${Math.max(1, Math.ceil(found.retry_after_s / 60))} minutes.`);
    return again(200, "That password isn't right. Check it with whoever invited you.");
  }
  const instagram = values.instagram.trim() ? events.instagramHandle(values.instagram) : null;
  if (values.instagram.trim() && !instagram) return again(200, "That doesn't look like an Instagram handle — just the username, like @yourname.");

  // Somebody already on Reason, recognized by their page session: joined now, no signup, no code.
  // Only an account Reason still serves: one paused, removed or blocked is not joined (or texted).
  if (account && accounts.admit({ channel: account.channel, address: account.address }).allow) {
    const shown = events.cleanDisplayName(values.display_name) || events.cleanDisplayName(account.name) || "Guest";
    const out = events.admitExisting({ ev, conversationId: account.conversation_id, displayName: shown, instagram, inDirectory: values.in_directory, via: "web", actor });
    if (!out.ok) {
      const why = { organizer: "You're organizing this one.", full: "This event is full.", removed: "The organizer took you off this event.", paused: "Joining is paused right now." }[out.reason] ?? "That didn't work.";
      return again(200, why);
    }
    if (!out.already) await events.sendWelcome({ runtime, ev, att: out.attendee });
    log({ event_web_joined: ev.id, existing: true });
    return page(200, renderJoined({ ev, att: out.attendee }));
  }

  // Anybody else: everything is on the page; the last step is one text.
  const name = events.cleanDisplayName(values.display_name);
  if (!name) return again(200, "Add the name other guests should see.");
  const claim = events.makeClaim({ ev, displayName: name, instagram, inDirectory: values.in_directory });
  log({ event_web_claim: ev.id });
  return page(200, shell({ title: ev.name, body: finishStep({ ev, claim, lineNumber }), pill: "Event", head: headFor(ev), css: CSS }));
}
