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
//     whether to appear on the who's-going page — reads plainly that joining gives them access to
//     Reason and starts a text conversation with it, and finishes with one tap: "Text Reason to finish".
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
import { readFileSync } from "node:fs";
import * as db from "../db.js";
import * as events from "../events.js";
import * as accounts from "../accounts.js";
import { readCookie, cookieHeader, clearCookieHeader, requestCode, SESSION_TTL_MS } from "./access.js";
import { shell, esc, renderNotFound, codeInputAttrs, foot } from "./render.js";
import { normalizeNumber, clock } from "../config.js";
import { prettyNumber } from "../invites.js";
import { coverUrl, coverFile, previewFile, INVITE_LINE, COVER_W, COVER_H } from "../eventcover.js";

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });

const CSS = `
.ev-form label{display:block;margin:.8rem 0 .3rem;font-weight:600}
.ev-form input[type=text],.ev-form input[type=password],.ev-form input[type=tel]{display:block;width:100%;box-sizing:border-box;min-height:3rem;padding:.8rem .95rem;border-radius:.6rem;border:1px solid var(--edge,#ccc);font:inherit;background:var(--card);color:var(--ink)}
.ev-form input[type=text]:focus,.ev-form input[type=password]:focus,.ev-form input[type=tel]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}
.ev-form input::placeholder{color:var(--dim);opacity:1}
.ev-form input[type=text]:not([name=code]){letter-spacing:normal;text-transform:none;text-align:left}
.ev-form .check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;margin:.8rem 0}
.ev-btn{display:block;width:100%;text-align:center;margin:1rem 0;padding:.95rem;font-weight:600;border-radius:.6rem;background:var(--ink);color:var(--bg);text-decoration:none;border:0;font-size:1rem;cursor:pointer}
.ev-note{opacity:.8;font-size:.95rem}
.ev-err{color:#c0392b;font-weight:600}
.ev-list{list-style:none;padding:0;margin:0}
.ev-list li{padding:.7rem 0;border-bottom:1px solid var(--line,#ddd);display:flex;justify-content:space-between;gap:1rem}
.ev-list a{color:inherit}
.ev-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;opacity:.8}
`;

/**
 * Who this browser belongs to, when it has a page session for an account Reason already has.
 * Null for anybody else. The session is the one every private page uses (src/pages/access.js).
 */
export function sessionAccount(headers) {
  const token = readCookie(headers?.cookie);
  const owner = token ? db.pageSessionOwner(token, SESSION_TTL_MS) : null;
  const acct = owner ? db.getAccount(owner) : null;
  // Only an account Reason still serves counts as signed in: one paused, removed or blocked gets the
  // ordinary page, and its text is turned away at the door like any other.
  return acct && accounts.admit({ channel: acct.channel, address: acct.address }).allow ? acct : null;
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

/**
 * The preview tags — the link's card in Messages, which IS the invitation (spec §14): the event's
 * name, one fixed invitation line, and the event's cover (src/eventcover.js). Never the description,
 * the time, the place or anybody's name: a forwarded link shows this card to anyone. Written into the
 * served HTML because Messages runs no script.
 */
export function headFor(ev) {
  const image = coverUrl(ev);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(ev.name)}">`,
    `<meta property="og:description" content="${esc(INVITE_LINE)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="${COVER_W}">`,
    `<meta property="og:image:height" content="${COVER_H}">`,
    `<meta property="og:image:alt" content="${esc(ev.name)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(ev.name)}">`,
    `<meta name="twitter:description" content="${esc(INVITE_LINE)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].map(t => `\n${t}`).join("");
}

const p = (s) => `<p>${esc(s)}</p>`;
/** What the organizer deliberately made public to anyone with the link — and only that. */
function publicDetails(ev) {
  const rows = [
    ev.time_public && ev.starts_at != null ? `<p><b>When:</b> ${esc(events.whenLine(ev))}</p>` : "",
    ev.location_public && ev.location ? `<p><b>Where:</b> ${esc(ev.location)}</p>` : "",
  ].filter(Boolean);
  return rows.length ? `<div class="t">${rows.join("")}</div>` : "";
}
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
      ? `<div class="t">${p(`You're signed in to Reason${account.name ? ` as ${account.name}` : ""}, so this just adds you to the event — its updates come to your Reason conversation.`)}</div>`
      : `<div class="t">${p("Joining gives you access to Reason, an assistant you text that can help you with everything about this event (and more).") + p("Joining starts a text conversation between you and Reason — that's where you'll get the event's updates.")}`
        + p("Already use Reason? Same button — it recognizes your number and just adds you to the event.")
        + `<p><a href="${esc(signinPath(ev))}">Already use Reason? Sign in with your number</a></p></div>`)
    + `<button class="ev-btn" type="submit">Join</button></form>`;
  const body = intro(ev) + publicDetails(ev) + `<h2>Join</h2>` + form + foot();
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

/** The organizer's own event link, opened on their own browser: what guests see, and their guest list. */
export function renderOrganizerHome({ ev }) {
  const v = events.organizerView(ev);
  const body = `<div class="hero"><p class="kicker">Your event</p><h1>${esc(ev.name)}</h1></div><div class="t">${p(ev.description)}</div>`
    + `<div class="t">${p(`When: ${v.when ?? "not set"}${v.time_shown_to_guests ? "" : " (not shared with guests yet)"}`)}${p(`Where: ${v.where ?? "not set"}${v.location_shown_to_guests ? "" : " (not shared with guests yet)"}`)}${p(`Going: ${v.going}${v.capacity ? ` of ${v.capacity}` : ""}`)}</div>`
    + `<a class="ev-btn" href="${esc(whoPath(ev, ev.organizer_token))}">Your guest list</a>`
    + `<div class="t">${p("To change anything or message your guests, text Reason.")}</div>`;
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
function tokenOwner(ev, token) {
  if (!token || typeof token !== "string" || token.length > 80) return null;
  if (ev.organizer_token === token) return { conversationId: ev.organizer_conversation_id, organizer: true };
  const att = db.attendeeByToken(token);
  if (att && att.event_id === ev.id && att.state === "joined") return { conversationId: att.conversation_id, organizer: false };
  return null;
}

const redirect = (location, extra = {}) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0, ...extra }), body: "" });
const signinPath = (ev) => `/e/${ev.public_id}/signin`;

/** "Sign out of this browser", on every private event page. */
function signOutForm(ev) {
  return `<form class="ev-form" method="POST" action="${esc(`/e/${ev.public_id}/signout`)}"><button class="ev-link" type="submit">Sign out of this browser</button></form>`;
}

/**
 * The gate in front of a private page, for a browser Reason does not recognize as the person the
 * link belongs to (spec v3 §12). It shows the event's name and nothing else, and offers to text a
 * code to the phone of the person whose link it is — so a forwarded link makes a code go to its
 * owner, never to whoever forwarded it on.
 */
export function renderGate({ ev, token, sent = false, error = "" }) {
  const action = `/e/${ev.public_id}/who`;
  const body = `<div class="hero"><p class="kicker">An event</p><h1>${esc(ev.name)}</h1></div>`
    + `<div class="t">${p("This page is private. To open it on this browser, confirm it's you: Reason will text a code to the phone this link belongs to.")}</div>`
    + (error ? `<p class="ev-err">${esc(error)}</p>` : "")
    + (sent
      ? `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="code">`
        + `<label for="code">The code from your texts</label><input id="code" ${codeInputAttrs()} required>`
        + `<button class="ev-btn" type="submit">Open</button></form>`
        + `<div class="t">${p("The code works once, for 15 minutes. If it doesn't arrive, this link isn't yours.")}</div>`
      : `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="send">`
        + `<button class="ev-btn" type="submit">Text me a code</button></form>`);
  return shell({ title: ev.name, body, pill: "Event", css: CSS });
}

/**
 * Sign in by phone number, for somebody already on Reason who opened the link in a browser Reason
 * doesn't know. A number with an account gets a code texted to it (it has texted Reason before, so
 * the inbound-only line can reach it); a number without one gets the same words back, and the new
 * guest join — so the page never says which numbers use Reason.
 */
export function renderSignin({ ev, number = "", sent = false, error = "" }) {
  const action = signinPath(ev);
  const body = intro(ev) + `<h2>Sign in</h2>`
    + (error ? `<p class="ev-err">${esc(error)}</p>` : "")
    + (sent
      ? `<div class="t">${p("If that number uses Reason, a code is on its way to it now.")}</div>`
        + `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="number" value="${esc(number)}">`
        + `<label for="code">The code from your texts</label><input id="code" ${codeInputAttrs()} required>`
        + `<button class="ev-btn" type="submit">Sign in</button></form>`
        + `<div class="t">${p("No code? You're new to Reason — join with the event password instead.")}</div><a class="ev-btn" href="${esc(`/e/${ev.public_id}`)}">Join as a new guest</a>`
      : `<div class="t">${p("Already use Reason? Put in your number and Reason will text you a code.")}</div>`
        + `<form class="ev-form" method="POST" action="${esc(action)}"><label for="number">Your phone number</label><input id="number" name="number" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 123-4567" maxlength="24" required value="${esc(number)}">`
        + `<button class="ev-btn" type="submit">Text me a code</button></form>`);
  return shell({ title: ev.name, body, pill: "Event", head: headFor(ev), css: CSS });
}

/**
 * Text one person a sign-in code, under the same limits as every Reason page code (3 per 15
 * minutes per person). Not waited on: a page that answered slower for a real number than for a
 * made-up one would say which numbers use Reason.
 */
function sendSigninCode({ ev, conversationId, runtime, what, log }) {
  // The line requestCode builds is a page's; this one is the event's own, below, bound to its host.
  const asked = requestCode({ id: events.signinKey(conversationId), title: ev.name }, { host: "" });
  if (!asked.ok) { log({ event_signin_code_refused: ev.id, why: asked.reason }); return; }
  if (!runtime?._tell) return;
  // Never the code in a log line: only that one went, or didn't. Keyed on the code's own row, not
  // the time: two taps in one millisecond mint two codes (the second expiring the first), and a
  // time key would let the outbox drop the second text — leaving the person holding a dead code.
  Promise.resolve(runtime._tell(conversationId, events.signinCodeLine(ev, asked.code, { what }), { idempotencyKey: `esign:${conversationId}:${asked.id}` }))
    .then(r => log({ event_signin_code_sent: ev.id, ok: !!(r?.ok || r?.queued) }))
    .catch(e => log({ event_signin_code_sent: ev.id, ok: false, why: (e?.message ?? String(e)).split("\n")[0] }));
}

/**
 * GET/POST /e/{id}[/join|/who|/signin|/signout]. `lineNumber` is the texting line's number for the
 * sms: link, or null when no line is live. `runtime` sends the welcome to somebody joined on the
 * page, and the sign-in codes.
 *
 * Every private view is decided here, on the server, for every request (spec v3 §14): which person
 * this browser is (`sessionAccount`, from the page session), then their role in THIS event
 * (`events.roleIn`). A link — a guest's or the organizer's — only ever says whom to text a code to.
 */
export async function eventPageRequest({ publicId, sub = null, method, query = {}, headers = {}, remoteAddress = "", readBody, runtime = null, lineNumber = null, log = () => {} }) {
  const ev = db.eventByPublicId(publicId);
  if (!ev || !events.eventsOn()) return page(404, renderNotFound());
  // ---- the card's picture, and the organizer's private look at a waiting one ----
  if (sub === "cover.jpg" || sub === "cover-preview.jpg") {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (ev.status === "cancelled") return page(404, renderNotFound());
    let file = null;
    try { file = sub === "cover.jpg" ? await coverFile(ev) : previewFile(ev, query.k); }
    catch (e) { log({ event_cover_failed: ev.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
    let bytes = null;
    // A waiting picture can be turned down between finding it and reading it: then it is simply gone.
    try { bytes = file ? readFileSync(file) : null; } catch { bytes = null; }
    if (!bytes) return page(404, renderNotFound());
    // The live picture's address carries its version, so it may be kept; a waiting one never is.
    const cache = sub === "cover.jpg" ? "public, max-age=86400" : "private, no-store";
    return { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": bytes.length, "Cache-Control": cache, "X-Robots-Tag": "noindex" }, body: bytes };
  }

  const account = sessionAccount(headers);
  const mine = account ? events.roleIn(account.conversation_id, ev.id) : null;

  // ---- sign this browser out ----
  if (sub === "signout") {
    if (method !== "POST") return page(405, renderNotFound(), { Allow: "POST" });
    // Only a browser that sent its session signs itself out. A post from another site carries no
    // cookie (SameSite=Lax), and is answered without touching the one this browser holds.
    const presented = readCookie(headers?.cookie);
    if (!presented) return redirect(`/e/${ev.public_id}`);
    db.endPageSession(presented);
    return redirect(`/e/${ev.public_id}`, { "Set-Cookie": clearCookieHeader({ path: "/" }) });
  }

  // ---- sign in by phone number ----
  if (sub === "signin") {
    if (ev.status === "cancelled") return page(404, renderNotFound());
    if (mine) return redirect(`/e/${ev.public_id}`);
    if (method !== "POST") return page(200, renderSignin({ ev }));
    const form = new URLSearchParams((await readBody()) ?? "");
    const number = String(form.get("number") ?? "").slice(0, 24);
    const code = form.get("code");
    // Only somebody already ON this event has a private page here to sign in to; everybody else —
    // no account, or an account that isn't on it — gets the same words and no text, and joins with
    // the password like anyone. So a typed number can only ever buzz a member of an event whose link
    // the typer already holds, and the page never says which numbers use Reason.
    const acct = events.accountForNumber(number);
    const who = acct && events.roleIn(acct.conversation_id, ev.id) ? acct : null;
    const actor = eventActor(headers, remoteAddress);
    if (code != null) {
      // One answer for every miss — no account, not a member, wrong, expired — and the only limit
      // ever said is this browser's own, so codes teach nothing about whose number it was.
      const tried = events.trySigninCode({ conversationId: who?.conversation_id ?? null, code, actor });
      if (!tried.ok) {
        log({ event_signin_failed: ev.id, why: tried.reason });
        return page(tried.reason === "rate_limited" ? 429 : 200, renderSignin({ ev, number, sent: true, error: tried.reason === "rate_limited" ? "Too many wrong codes from this browser. Try again in about 15 minutes." : "That code isn't right." }));
      }
      log({ event_signin_ok: ev.id });
      return redirect(`/e/${ev.public_id}`, { "Set-Cookie": cookieHeader(tried.token, { path: "/" }) });
    }
    if (!events.signinGate(actor)) return page(429, renderSignin({ ev, number, error: "Too many sign-in tries from this browser. Try again in an hour." }));
    events.noteSigninRequest(actor);
    if (who) sendSigninCode({ ev, conversationId: who.conversation_id, runtime, what: "sign in to", log });
    return page(200, renderSignin({ ev, number, sent: true }));
  }

  // ---- the who's-going page ----
  if (sub === "who") {
    if (ev.status === "cancelled") return page(404, renderNotFound());
    const form = method === "POST" ? new URLSearchParams((await readBody()) ?? "") : null;
    const token = form ? form.get("t") : query.t;
    // A browser recognized as somebody on this event sees their own view, whatever link it opened.
    if (mine) {
      if (form && form.get("step") == null) {
        if (mine.role !== "guest") return redirect(whoPath(ev, token ?? ""));
        const fields = { in_directory: form.get("in_directory") === "1" ? 1 : 0 };
        const name = events.cleanDisplayName(form.get("display_name"));
        if (name) fields.display_name = name;
        const ig = String(form.get("instagram") ?? "").trim();
        fields.instagram = ig ? events.instagramHandle(ig) ?? mine.att.instagram : null;
        db.updateAttendeeRow(mine.att.id, fields);
        return redirect(`${whoPath(ev, mine.att.token)}&saved=1`);
      }
      if (form) return redirect(whoPath(ev, token ?? ""));
      const att = mine.role === "guest" ? db.attendeeRow(ev.id, account.conversation_id) : null;
      return page(200, renderWho({ ev, att, organizer: mine.role === "organizer", token: att?.token ?? ev.organizer_token, saved: query.saved === "1" }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
    }
    // Anybody else: the link says whose page it is, and that person is texted a code.
    const owner = tokenOwner(ev, token);
    if (!owner) return page(404, renderNotFound());
    if (form?.get("step") === "send") {
      sendSigninCode({ ev, conversationId: owner.conversationId, runtime, what: owner.organizer ? "open your guest list for" : "open", log });
      return page(200, renderGate({ ev, token, sent: true }));
    }
    if (form?.get("step") === "code") {
      const tried = events.trySigninCode({ conversationId: owner.conversationId, code: form.get("code"), actor: eventActor(headers, remoteAddress) });
      if (!tried.ok) {
        log({ event_signin_failed: ev.id, why: tried.reason });
        return page(tried.reason === "rate_limited" ? 429 : 200, renderGate({ ev, token, sent: true, error: tried.reason === "rate_limited" ? "Too many wrong codes from this browser. Try again in about 15 minutes." : "That code isn't right." }));
      }
      log({ event_signin_ok: ev.id });
      return redirect(whoPath(ev, token), { "Set-Cookie": cookieHeader(tried.token, { path: "/" }) });
    }
    return page(200, renderGate({ ev, token }));
  }

  // ---- the join page ----
  if (method !== "GET" && method !== "HEAD" && !(method === "POST" && sub === "join")) {
    return page(405, renderNotFound(), { Allow: "GET, HEAD" });
  }
  // Cancelled: nothing but the name and that it is off, in the page and in its preview alike.
  if (ev.status !== "active") return page(200, shell({ title: ev.name, body: closedBody(ev), pill: "Event", head: ev.status === "cancelled" ? "" : headFor(ev), css: CSS }));
  // The organizer opening their own event's link gets their own page, never a guest's.
  if (mine?.role === "organizer") return page(200, renderOrganizerHome({ ev }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
  if (mine?.role === "guest") return page(200, renderJoined({ ev, att: mine.att }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
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

  // Somebody already on Reason, recognized by their page session (sessionAccount only returns an
  // account Reason still serves): joined now, no signup, no code.
  if (account) {
    const shown = events.cleanDisplayName(values.display_name) || events.cleanDisplayName(account.name) || "Guest";
    const out = events.admitExisting({ ev, conversationId: account.conversation_id, displayName: shown, instagram, inDirectory: values.in_directory, via: "web", actor });
    if (!out.ok) {
      const why = { organizer: "You're organizing this one.", full: "This event is full.", removed: "The organizer took you off this event.", paused: "Joining is paused right now." }[out.reason] ?? "That didn't work.";
      return again(200, why);
    }
    if (!out.already) await events.sendWelcome({ runtime, ev, att: out.attendee });
    log({ event_web_joined: ev.id, existing: true });
    return page(200, renderJoined({ ev, att: out.attendee }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
  }

  // Anybody else: everything is on the page; the last step is one text.
  const name = events.cleanDisplayName(values.display_name);
  if (!name) return again(200, "Add the name other guests should see.");
  const claim = events.makeClaim({ ev, displayName: name, instagram, inDirectory: values.in_directory });
  log({ event_web_claim: ev.id });
  return page(200, shell({ title: ev.name, body: finishStep({ ev, claim, lineNumber }), pill: "Event", head: headFor(ev), css: CSS }));
}
