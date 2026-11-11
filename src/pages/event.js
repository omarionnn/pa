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
import { siteClientIp, caddyClientIp } from "./siteproxy.js";
import * as db from "../db.js";
import * as events from "../events.js";
import * as accounts from "../accounts.js";
import { readCookie, readCookies, cookieHeader, clearCookieHeader, requestCode, SESSION_TTL_MS } from "./access.js";
import { shell, esc, renderNotFound, codeInputAttrs, foot, sentLine } from "./render.js";
import { normalizeNumber, clock, config } from "../config.js";
import { prettyNumber } from "../invites.js";
import { coverUrl, coverFile, previewFile, INVITE_LINE, COVER_W, COVER_H } from "../eventcover.js";
import { albumRequest } from "./album.js";
import * as made from "./made.js";
import * as eventpay from "../eventpay.js";
import { renderManage, manageRequest, ownOrigin } from "./eventmanage.js";
import { readPlain } from "../restfiles.js";
import * as questions from "../eventquestions.js";
import * as helpline from "../eventhelpline.js";

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
/* Room for "Sending…" and its ring, so the line does not grow when it is tapped. */
.ev-link[data-busy]{min-width:6.5rem;text-align:left}
.ev-manage{display:block;text-align:center;margin:1rem 0;padding:.85rem;font-weight:600;border-radius:.6rem;border:1px solid var(--ink);color:var(--ink);text-decoration:none}
.ev-form fieldset{border:0;margin:.8rem 0;padding:0}
.ev-form legend{font-weight:600;padding:0;margin-bottom:.3rem}
.ev-form .pick{display:flex;gap:.5rem;align-items:center;font-weight:400;margin:.35rem 0}
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
 * The address a browser's wrong passwords and code requests are counted against. A visitor's own
 * address only when something that cannot be forged vouches for it; otherwise the socket's own, one
 * count every unvouched browser shares, so nobody can pick a fresh address per guess — or fill
 * somebody else's — by writing a header.
 */
export function eventActor(headers = {}, remoteAddress = "") {
  // Through the website's proxy (heyreason.com/web): the visitor's address Netlify signed for, and
  // only with a valid signature (src/pages/siteproxy.js). A forged header without one counts for nothing.
  const site = siteClientIp(headers);
  if (site) return `ip:${site.slice(0, 64)}`;
  // Through Caddy (events., files.): Caddy's X-Forwarded-For, only with the secret Caddy adds — the
  // X-Files-Domain marker alone is writable by anyone on the Funnel, which lands on the same port
  // from the same loopback address. Never the Netlify header, which nothing on that path strips.
  const caddy = caddyClientIp(headers, remoteAddress);
  if (caddy) return `ip:${caddy.slice(0, 64)}`;
  return `ip:${String(remoteAddress || "unknown").slice(0, 64)}`;
}

/**
 * The preview tags — the link's card in Messages, which IS the invitation (spec §14): the event's
 * name, one fixed invitation line, and the event's cover (src/eventcover.js). Never the description,
 * the time, the place or anybody's name: a forwarded link shows this card to anyone. Written into the
 * served HTML because Messages runs no script.
 */
export function headFor(ev, { line = previewLine(ev) } = {}) {
  const image = coverUrl(ev);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(ev.name)}">`,
    `<meta property="og:description" content="${esc(line)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="${COVER_W}">`,
    `<meta property="og:image:height" content="${COVER_H}">`,
    `<meta property="og:image:alt" content="${esc(ev.name)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(ev.name)}">`,
    `<meta name="twitter:description" content="${esc(line)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].map(t => `\n${t}`).join("");
}

/**
 * The card's one line under the name. With a ticket link (src/eventhelpline.js) it says where tickets
 * are and, when the help line is on, that a text gets the address and updates; otherwise the fixed
 * invitation line. Never a time, a place or anybody's name.
 */
export function previewLine(ev) {
  if (ev.status === "active" && ev.ticket_url) {
    return helpline.lineOn(ev) ? "Get tickets, then text for the address and updates." : "Get tickets on the event page.";
  }
  return INVITE_LINE;
}

/**
 * Under the description, for anybody the link reaches (owner request 2026-11-11): "Get tickets" (the
 * organizer's ticket page), "Get the address and updates" (a text to the help line, already written),
 * and that the same thread reaches the host. Each only when there is something behind it. The texts
 * open Messages straight from here, in the shape this phone reads (helpline.smsHref).
 */
export function helpLineBlock(ev, { lineNumber = null, userAgent = "", v2 = true } = {}) {
  if (ev.status !== "active") return "";
  const ticket = ev.ticket_url || "";
  const text = helpline.lineOn(ev) && lineNumber ? helpline.smsHref(lineNumber, helpline.firstText(ev), userAgent) : "";
  if (!ticket && !text) return "";
  const host = helpline.hostName(ev);
  if (!v2) {
    return `<div class="hl">`
      + (ticket ? `<a class="ev-btn" href="${esc(ticket)}" rel="noopener noreferrer" target="_blank">Get tickets</a>` : "")
      + (text ? `<a class="ev-manage" href="${esc(text)}">Get the address and updates</a>`
        + `<div class="t"><p>Questions? <a href="${esc(text)}">Text ${esc(host === "the host" ? "the host" : host)}</a> — the same text thread reaches them.</p></div>` : "")
      + `</div>`;
  }
  return `<section class="hl" aria-label="Tickets and updates">`
    + (ticket ? `<a class="hl-btn" href="${esc(ticket)}" rel="noopener noreferrer" target="_blank">Get tickets →</a>` : "")
    + (text ? `<a class="hl-btn hl-alt" href="${esc(text)}">Get the address and updates →</a>`
      + `<p class="quiet">Questions? <a href="${esc(text)}">Text ${esc(host)}</a> — the same text thread reaches them.</p>` : "")
    + `</section>`;
}
const HL_CSS = `<style>.hl{display:flex;flex-direction:column;gap:10px;margin:4px 0 2px}.hl-btn{display:block;text-align:center;padding:14px 16px;border-radius:12px;background:var(--ink);color:var(--g,#fff);text-decoration:none;font-weight:600;font-size:16px;min-height:48px;box-sizing:border-box}.hl-alt{background:none;color:var(--ink);border:1.5px solid var(--ink)}.hl .quiet a{color:inherit}</style>`;

const p = (s) => `<p>${esc(s)}</p>`;
/** What the organizer deliberately made public to anyone with the link — and only that. */
function publicDetails(ev) {
  const rows = [
    ev.time_public && ev.starts_at != null ? `<p><b>When:</b> ${esc(events.whenLine(ev))}</p>` : "",
    ev.location_public && ev.location ? `<p><b>Where:</b> ${esc(ev.location)}</p>` : "",
    // The price is public (src/eventpay.js): anyone deciding whether to come should see it first.
    eventpay.priced(ev) ? `<p><b>Price:</b> ${esc(eventpay.guestPriceLine(ev))}</p>` : "",
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

// ---------------------------------------------------------------- Pages v2 (P4 / PD4), held
/** The tilted date card's three lines, in the event's own zone: NOV · 14. Only ever drawn when the time may be shown. */
export function dateCard(ev) {
  if (ev.starts_at == null) return null;
  const d = new Date(ev.starts_at);
  return { mon: d.toLocaleString("en-US", { timeZone: ev.tz, month: "short" }).toUpperCase(), day: d.toLocaleString("en-US", { timeZone: ev.tz, day: "numeric" }), to: "" };
}
const timeOnly = (ev) => new Date(ev.starts_at).toLocaleString("en-US", { timeZone: ev.tz, weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * The organizer's questions as form fields (src/eventquestions.js): free text, or one pick from a few
 * choices with nothing picked to start. An optional one: a blank is a skip, and nothing about joining
 * waits on it. A required one (owner decision 2026-11-11) is marked so, and the form does not go
 * through without it — in the browser (`required`) and again when it is read (readForm `missing`).
 * `values` puts back what they typed (`q_<id>`); `qv_<id>` is the version of the words they read, so
 * an answer is never filed under words the organizer changed meanwhile. `v2` draws them in the v2
 * pages' type; otherwise in the classic page's.
 */
export function questionFields(ev, values = {}, { v2 = true, heading = null, own = false } = {}) {
  const list = questions.questionsOf(ev);
  if (!list.length) return "";
  const anyRequired = list.some(q => q.required);
  const head0 = heading ?? (anyRequired ? "THE HOST ASKS" : "THE HOST ASKS · ALL OPTIONAL");
  const tag = (q) => anyRequired ? `<small class="qt">${q.required ? "REQUIRED" : "OPTIONAL"}</small>` : "";
  const field = (q) => {
    const name = `q_${q.question_id}`;
    const have = values[name] == null ? "" : String(values[name]);
    const req = q.required ? " required" : "";
    // On a guest's own answers form, what the page showed: a field left as it was is not touched.
    const ver = `<input type="hidden" name="qv_${q.question_id}" value="${esc(q.version)}">${own ? `<input type="hidden" name="qo_${q.question_id}" value="${esc(have)}">` : ""}`;
    if (q.kind === "choice") {
      const radio = (value, label) => `<label class="${v2 ? "check pick" : "pick"}"><input type="radio" name="${name}" value="${value}"${have === value ? " checked" : ""}${req}> <span>${esc(label)}</span></label>`;
      // Their own form can take an answer back: "No answer" is a pick of its own there — not for one the host asks everyone.
      const picks = q.choices.map((c, i) => radio(String(i), c)).join("") + (own && !q.required ? radio("", "No answer") : "");
      return `<fieldset class="qq"><legend>${esc(q.prompt)}${tag(q)}</legend>${picks}${ver}</fieldset>`;
    }
    return v2
      ? `<label class="qq" for="${name}"><span class="qp">${esc(q.prompt)}${tag(q)}</span><input id="${name}" name="${name}" type="text" maxlength="${questions.LIMITS.answer}" value="${esc(have)}"${req}></label>${ver}`
      : `<label for="${name}">${esc(q.prompt)}${tag(q)}</label><input id="${name}" name="${name}" type="text" maxlength="${questions.LIMITS.answer}" value="${esc(have)}"${req}>${ver}`;
  };
  const head = v2 ? `<p class="lbl qh">${esc(head0)}</p>` : `<p class="ev-note">${esc(head0.charAt(0) + head0.slice(1).toLowerCase())}</p>`;
  return `<div class="qs">${head}${list.map(field).join("")}<p class="quiet">${esc("Only the host sees your answers. Never other guests, and never the guest list.")}</p></div>`;
}

/** What this guest has answered, as form values: what their answers form starts with. */
function ownValues(ev, att) {
  const out = {};
  for (const q of questions.guestQuestions(ev, att)) {
    if (q.your_answer == null) continue;
    out[`q_${q.question_id}`] = q.kind === "choice" ? String(q.your_choice) : q.your_answer;
  }
  return out;
}

/** A joined guest's own answers, on their page, to change any time. Empty when the event asks nothing. */
function answersBlock(ev, att, { v2 = true, saved = false, error = "" } = {}) {
  if (!questions.hasQuestions(ev)) return "";
  const fields = questionFields(ev, ownValues(ev, att), { v2, heading: "YOUR ANSWERS FOR THE HOST", own: true });
  const note = saved ? (v2 ? `<p class="quiet" role="status">Saved.</p>` : `<p class="ev-note" role="status">Saved.</p>`) : "";
  const err = error ? (v2 ? `<p class="err" role="alert">${esc(error)}</p>` : `<p class="ev-err">${esc(error)}</p>`) : "";
  return v2
    ? `<section class="dash" id="answers"><form class="jf" method="POST" action="${esc(`/e/${ev.public_id}/answers`)}">${err}${note}${fields}<button class="go" type="submit" data-busy="Saving…">Save answers →</button></form></section>`
    : `<h2 id="answers">Your answers</h2><form class="ev-form" method="POST" action="${esc(`/e/${ev.public_id}/answers`)}">${err}${note}${fields}<button class="ev-btn" type="submit" data-busy="Saving…">Save answers</button></form>`;
}

/** The join form, in the v2 page's own type. The same fields, the same words and the same POST as renderJoin. */
function joinFormV2(ev, { account, error, values }) {
  const signedIn = !!account;
  const field = (name, label, type = "text", extra = "") =>
    `<label for="${name}">${esc(label.toUpperCase())}<input id="${name}" name="${name}" type="${type}" ${extra} value="${type === "password" ? "" : esc(values[name] ?? "")}"></label>`;
  return `<form class="jf" method="POST" action="${esc(joinPath(ev))}">`
    + (error ? `<p class="err" role="alert">${esc(error)}</p>` : "")
    + field("password", "Event password", "password", `autocomplete="off" required maxlength="200"`)
    + (signedIn ? "" : field("display_name", "Your name (what other guests see)", "text", `required maxlength="40" autocomplete="name"`))
    + field("instagram", "Instagram (optional)", "text", `maxlength="60" autocapitalize="off" placeholder="@yourhandle"`)
    + `<label class="check"><input type="checkbox" name="in_directory" value="1"${(values.in_directory ?? true) ? " checked" : ""}> <span>Show me on the who's-going page (name and Instagram, never your number)</span></label>`
    + questionFields(ev, values)
    + (signedIn
      ? `<p class="quiet">${esc(`You're signed in to Reason${account.name ? ` as ${account.name}` : ""}, so this just adds you to the event — its updates come to your Reason conversation.`)}</p>`
      : `<p class="quiet">Joining gives you access to Reason, your personal concierge, which can help you with everything about this event (and more). Joining starts a text conversation between you and Reason — that's where you'll get the event's updates.</p>`
        + `<a class="typed" href="${esc(signinPath(ev))}">ALREADY USE REASON? SIGN IN WITH YOUR NUMBER</a>`)
    + (eventpay.priced(ev) ? `<p class="quiet">${esc(paidJoinNote(ev, signedIn))}</p>` : "")
    + `<button class="go" type="submit" data-busy="${eventpay.priced(ev) && signedIn ? "Opening payment…" : "Joining…"}">${eventpay.priced(ev) ? "Join and pay →" : "Join →"}</button></form>`;
}

/** What paying looks like from here (src/eventpay.js): a Stripe page now, or by text after the finishing text. */
function paidJoinNote(ev, signedIn) {
  const qt = eventpay.quote(ev.price_cents);
  return signedIn
    ? `This event is ${eventpay.dollars(qt.price)} per person (${eventpay.dollars(qt.total)} with processing). After the password you'll pay on a secure Stripe page — Apple Pay works — and you're in once the payment goes through.`
    : `This event is ${eventpay.dollars(qt.price)} per person (${eventpay.dollars(qt.total)} with processing). After the password and one text to Reason, Reason texts you a secure Stripe payment link; you're in once the payment goes through.`;
}

/** P4 for anybody the link reaches: only what the organizer made public, then "Are you in?". */
function renderJoinV2({ ev, account = null, error = "", values = {}, lineNumber = null, userAgent = "" }) {
  const facts = [
    ["When", ev.time_public && ev.starts_at != null ? timeOnly(ev) : ""],
    ["Where", ev.location_public ? ev.location : ""],
    ...(eventpay.priced(ev) ? [["Price", `${eventpay.dollars(ev.price_cents)} per person`]] : []),
  ];
  // No host name before joining: a forwarded link never shows anybody's name (publicView).
  return made.renderEvent({
    title: ev.name, host: "", description: ev.description,
    date: ev.time_public ? dateCard(ev) : null,
    facts,
    rsvp: { joinHtml: joinFormV2(ev, { account, error, values }), open: !!error },
    afterDesc: helpLineBlock(ev, { lineNumber, userAgent }),
    coming: null, calendarHref: "",
    head: headFor(ev) + HL_CSS,
    url: events.eventUrl(ev),
  });
}

/** P4 for somebody on the event: the released details, who's coming, the calendar. */
function renderJoinedV2({ ev, att, saved = false, error = "" }) {
  const v = events.guestView(ev, att);
  const list = ev.guest_list_visible ? events.directoryEntries(ev).map(e => e.name).filter(Boolean) : null;
  const going = db.joinedCount(ev.id);
  return made.renderEvent({
    title: ev.name, host: events.organizerName(ev) || "", description: ev.description,
    date: v.when ? dateCard(ev) : null,
    facts: [["When", v.when ? timeOnly(ev) : ""], ["Where", v.where ?? ""]],
    rsvp: { joined: true },
    after: answersBlock(ev, att, { saved, error }),
    coming: list,
    calendarHref: v.when ? `/e/${ev.public_id}/calendar.ics` : "",
    head: headFor(ev),
    url: events.eventUrl(ev),
    foot: `Shared with the ${going} ${going === 1 ? "person" : "people"} on this event. Made with Reason.`,
  }).replace(`</aside>`, `<form method="POST" action="${esc(`/e/${ev.public_id}/signout`)}" style="margin:0"><button class="typed mut" type="submit">SIGN OUT OF THIS BROWSER</button></form></aside>`);
}

/** The event as a calendar file, for somebody on it, once its time is out (ADD TO MY CALENDAR →). */
export function calendarFile(ev, att) {
  const v = events.guestView(ev, att);
  if (!v.when || ev.starts_at == null) return null;
  const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const line = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/[,;]/g, (m) => `\\${m}`).replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Reason//Events//EN", "BEGIN:VEVENT",
    `UID:${ev.public_id}@reason`, `DTSTAMP:${t(clock.now())}`, `DTSTART:${t(ev.starts_at)}`, `DTEND:${t(ev.starts_at + 2 * 60 * 60_000)}`,
    `SUMMARY:${line(ev.name)}`, ...(v.where ? [`LOCATION:${line(v.where)}`] : []), `URL:${events.eventUrl(ev)}`,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

export function renderJoin({ ev, account = null, error = "", values = {}, lineNumber = null, userAgent = "" }) {
  if (config.pagesV2) return renderJoinV2({ ev, account, error, values, lineNumber, userAgent });
  const signedIn = !!account;
  const field = (name, label, type = "text", extra = "") =>
    `<label for="${name}">${esc(label)}</label><input id="${name}" name="${name}" type="${type}" ${extra} value="${type === "password" ? "" : esc(values[name] ?? "")}">`;
  const form = `<form class="ev-form" method="POST" action="${esc(joinPath(ev))}">`
    + (error ? `<p class="ev-err">${esc(error)}</p>` : "")
    + field("password", "Event password", "password", `autocomplete="off" required maxlength="200"`)
    + (signedIn ? "" : field("display_name", "Your name (what other guests see)", "text", `required maxlength="40" autocomplete="name"`))
    + field("instagram", "Instagram (optional)", "text", `maxlength="60" autocapitalize="off" placeholder="@yourhandle"`)
    + `<label class="check"><input type="checkbox" name="in_directory" value="1"${(values.in_directory ?? true) ? " checked" : ""}> <span>Show me on the who's-going page (name and Instagram, never your number)</span></label>`
    + questionFields(ev, values, { v2: false })
    + (signedIn
      ? `<div class="t">${p(`You're signed in to Reason${account.name ? ` as ${account.name}` : ""}, so this just adds you to the event — its updates come to your Reason conversation.`)}</div>`
      : `<div class="t">${p("Joining gives you access to Reason, your personal concierge, which can help you with everything about this event (and more).") + p("Joining starts a text conversation between you and Reason — that's where you'll get the event's updates.")}`
        + p("Already use Reason? Same button — it recognizes your number and just adds you to the event.")
        + `<p><a href="${esc(signinPath(ev))}">Already use Reason? Sign in with your number</a></p></div>`)
    + (eventpay.priced(ev) ? `<div class="t">${p(paidJoinNote(ev, signedIn))}</div>` : "")
    + `<button class="ev-btn" type="submit" data-busy="${eventpay.priced(ev) && signedIn ? "Opening payment…" : "Joining…"}">${eventpay.priced(ev) ? "Join and pay" : "Join"}</button></form>`;
  const body = intro(ev) + helpLineBlock(ev, { lineNumber, userAgent, v2: false }) + publicDetails(ev) + `<h2>Join</h2>` + form + foot();
  return shell({ title: ev.name, body, pill: "Event", url: events.eventUrl(ev), head: headFor(ev), css: CSS });
}

/** The last step for anybody without a page session: one text that proves the phone and joins. */
export function finishStep({ ev, claim, lineNumber }) {
  const code = claim.code;
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  if (!lineNumber) {
    return `${intro(ev)}<div class="t">${p("Reason's texting line isn't connected right now, so this can't be finished at the moment. Nothing was used up — try again later.")}</div>`;
  }
  const href = `sms:${normalizeNumber(lineNumber)}?&body=${encodeURIComponent(events.claimText(ev, code))}`;
  const paid = eventpay.priced(ev);
  return `${intro(ev)}<h2>${paid ? "Next step" : "Last step"}</h2><div class="t">`
    + p(paid
      ? `Tap the button. It opens a text to Reason with your code already written in — just press send. That text is how Reason knows the number is really yours. Reason texts you back a secure Stripe payment link (${eventpay.dollars(eventpay.quote(ev.price_cents).total)} with processing); you're in once you've paid.`
      : "Tap the button. It opens a text to Reason with your code already written in — just press send. That text is how Reason knows the number is really yours, and it finishes your join.")
    + `</div><a class="ev-btn" href="${esc(href)}">${paid ? "Text Reason to get the payment link" : "Text Reason to finish"}</a><div class="t">`
    + p(`Not on your phone? From your phone, text ${shown} to ${prettyNumber(lineNumber)}.`)
    + p(paid ? "The code works once, for 24 hours. Nothing is charged until you pay on the Stripe page." : "The code works once, for 24 hours. If you already use Reason, it just adds the event to your account.")
    + `</div>`;
}

/**
 * The help line's own link, the one on a ticket page or a story: it opens Messages to Reason with the
 * first text written, by itself on a phone, and with one button if the browser held that back (an
 * in-app browser often does). Nothing else is on it: no password, no sign-up, nothing about Reason.
 * Its preview card is the event's.
 */
export const HELP_PREVIEW_LINE = "Questions, the address, updates? Text the help line.";
export function renderTextPage({ ev, lineNumber, userAgent = "" }) {
  const host = helpline.hostName(ev);
  if (!lineNumber) {
    return shell({ title: ev.name, body: `${intro(ev)}<div class="t">${p("The help line can't take texts right this minute. Try again soon.")}</div>`, pill: "Event", url: events.eventUrl(ev), head: headFor(ev), css: CSS });
  }
  const href = helpline.smsHref(lineNumber, helpline.firstText(ev), userAgent);
  const phone = /iPhone|iPad|iPod|Android/i.test(userAgent);
  const body = `<div class="hero"><p class="kicker">Help line</p><h1>${esc(ev.name)}</h1></div>`
    + `<div class="t">${p(`Questions, the address, updates? Text the ${ev.name} help line${host === "the host" ? "" : `, run for ${host}`}.`)}</div>`
    + `<a class="ev-btn" id="go" href="${esc(href)}">Open Messages</a>`
    + `<div class="t">${p(`Or text "code ${ev.help_code}" to ${prettyNumber(lineNumber)}.`)}</div>`
    + (ev.ticket_url ? `<a class="ev-manage" href="${esc(ev.ticket_url)}" rel="noopener noreferrer" target="_blank">Get tickets</a>` : "")
    + (phone ? `<script>setTimeout(function(){location.href=document.getElementById("go").href},150)</script>` : "");
  return shell({ title: `${ev.name} — help line`, body, pill: "Event", url: events.eventUrl(ev), head: headFor(ev, { line: HELP_PREVIEW_LINE }), css: CSS });
}

/** Where Stripe sends a guest after paying (/paid) or after changing their mind (/pay-back). Nothing is decided here: the webhook does the join. */
function renderAfterPay({ ev, paid }) {
  const body = intro(ev) + (paid
    ? `<h2>Payment received</h2><div class="t">${p("Thank you. Reason is putting you on the guest list now and will text you the details in a moment — the welcome, and whatever the organizer has shared.")}${p("Nothing else to do here. Head back to your texts.")}</div>`
    : `<h2>Nothing was charged</h2><div class="t">${p("No worries. Your spot wasn't kept, but the link and the password still work whenever you'd like to join.")}</div><a class="ev-btn" href="${esc(`/e/${ev.public_id}`)}">Back to the event</a>`);
  return shell({ title: ev.name, body, pill: "Event", url: events.eventUrl(ev), head: headFor(ev), css: CSS });
}

export function renderJoined({ ev, att, saved = false, error = "" }) {
  if (config.pagesV2) return renderJoinedV2({ ev, att, saved, error });
  const dir = ev.guest_list_visible ? `<a class="ev-btn" href="${esc(whoPath(ev, att.token))}">See who's going</a>` : "";
  const body = `${intro(ev)}<h2>You're in</h2>${detailsBlock(ev, att)}<div class="t">${p("Your welcome is in your texts with Reason, and event updates will come there too.")}</div>${dir}${answersBlock(ev, att, { v2: false, saved, error })}`;
  return shell({ title: ev.name, body, pill: "Event", url: events.eventUrl(ev), head: headFor(ev), css: CSS });
}

/**
 * The organizer's own event link, opened on their own browser: the place to run the event
 * (src/pages/eventmanage.js) — the welcome, a message to everyone, the details, the guests, the
 * password — every change made through the same tool call a text would make.
 */
export function renderOrganizerHome({ ev, query = {} }) {
  return renderManage({ ev, conversationId: ev.organizer_conversation_id, query });
}

/** The who's-going page for one viewer: a joined guest (their own token) or the organizer. */
export function renderWho({ ev, att = null, organizer = false, token, saved = false }) {
  const list = events.directoryEntries(ev, { organizer });
  const items = list.length
    ? `<ul class="ev-list">${list.map(e => `<li><span>${esc(e.name)}${e.organizer ? ` <span class="ev-note">(organizing)</span>` : ""}${organizer && !e.listed ? ` <span class="ev-note">(not listed)</span>` : ""}</span>${e.instagram ? `<a href="${esc(events.instagramUrl(e.instagram))}" rel="noopener noreferrer" target="_blank">@${esc(e.instagram)}</a>` : ""}</li>`).join("")}</ul>`
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
    + `<button class="ev-btn" type="submit" data-busy="Saving…">Save</button></form>` : "";
  const head = organizer ? `<div class="t">${p("Your guest list, with everyone — including people who chose not to be listed. Phone numbers are never shown.")}</div>` : "";
  const details = att ? detailsBlock(ev, att) : `<div class="t">${p(`When: ${events.whenLine(ev) ?? "not set"}`)}${p(`Where: ${ev.location || "not set"}`)}</div>`;
  const paused = ev.status === "paused" ? `<div class="t">${p("This event is paused right now.")}</div>` : "";
  // The organizer's way back to running the event: this page only reads the list (owner, 2026-11-11).
  const manage = organizer ? `<a class="ev-manage" href="${esc(`/e/${ev.public_id}`)}">Manage your event →</a>` : "";
  const body = `<div class="hero"><p class="kicker">${organizer ? "Your event" : "An event"}</p><h1>${esc(ev.name)}</h1></div>${manage}${paused}${details}${head}${listBlock}${mine}`;
  return shell({ title: `${ev.name} — who's going`, body, pill: "Event", url: events.eventUrl(ev), css: CSS });
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
  return `<form class="ev-form" method="POST" action="${esc(`/e/${ev.public_id}/signout`)}"><button class="ev-link" type="submit" data-busy="Signing out…">Sign out of this browser</button></form>`;
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
      ? (error ? "" : sentLine("Code sent — check your texts."))
        + `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="code">`
        + `<label for="code">The code from your texts</label><input id="code" ${codeInputAttrs()} required>`
        + `<button class="ev-btn" type="submit" data-busy="Checking…">Open</button></form>`
        + `<div class="t">${p("The code works once, for 15 minutes. If it doesn't arrive, this link isn't yours.")}</div>`
        + `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="send">`
        + `<button class="ev-link" type="submit" data-busy="Sending…">Text it again</button></form>`
      : `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="step" value="send">`
        + `<button class="ev-btn" type="submit" data-busy="Sending code…">Text me a code</button></form>`);
  return shell({ title: ev.name, body, pill: "Event", url: events.eventUrl(ev), css: CSS });
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
      ? (error ? `<div class="t">${p("If that number uses Reason, a code is on its way to it now.")}</div>` : sentLine("Sent. If that number uses Reason, a code is on its way to it now."))
        + `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="number" value="${esc(number)}">`
        + `<label for="code">The code from your texts</label><input id="code" ${codeInputAttrs()} required>`
        + `<button class="ev-btn" type="submit" data-busy="Checking…">Sign in</button></form>`
        + `<form class="ev-form" method="POST" action="${esc(action)}"><input type="hidden" name="number" value="${esc(number)}"><button class="ev-link" type="submit" data-busy="Sending…">Text it again</button></form>`
        + `<div class="t">${p("No code? You're new to Reason — join with the event password instead.")}</div><a class="ev-btn" href="${esc(`/e/${ev.public_id}`)}">Join as a new guest</a>`
      : `<div class="t">${p("Already use Reason? Put in your number and Reason will text you a code.")}</div>`
        + `<form class="ev-form" method="POST" action="${esc(action)}"><label for="number">Your phone number or Apple ID email</label><input id="number" name="number" type="text" inputmode="email" autocomplete="tel email" placeholder="(555) 123-4567" maxlength="254" required value="${esc(number)}">`
        + `<button class="ev-btn" type="submit" data-busy="Sending code…">Text me a code</button></form>`);
  return shell({ title: ev.name, body, pill: "Event", url: events.eventUrl(ev), head: headFor(ev), css: CSS });
}

/**
 * Text one person a sign-in code, under the same limits as every Reason page code (3 per 15
 * minutes per person). Not waited on: a page that answered slower for a real number than for a
 * made-up one would say which numbers use Reason.
 */
function sendSigninCode({ ev, conversationId, runtime, what, log, actor }) {
  // The line requestCode builds is a page's; this one is the event's own, below, bound to its host.
  // The code belongs to the browser that asked (events.trySigninCode, audit lead 25).
  const asked = requestCode({ id: events.signinKey(conversationId), title: ev.name }, { host: "", bound: events.signinBinding(actor) });
  if (!asked.ok) { log({ event_signin_code_refused: ev.id, why: asked.reason }); return asked; }
  if (!runtime?._tell) return asked;
  // Never the code in a log line: only that one went, or didn't. Keyed on the code's own row, not
  // the time: two taps in one millisecond mint two codes (the second expiring the first), and a
  // time key would let the outbox drop the second text — leaving the person holding a dead code.
  Promise.resolve(runtime._tell(conversationId, events.signinCodeLine(ev, asked.code, { what }), { idempotencyKey: `esign:${conversationId}:${asked.id}` }))
    .then(r => log({ event_signin_code_sent: ev.id, ok: !!(r?.ok || r?.queued) }))
    .catch(e => log({ event_signin_code_sent: ev.id, ok: false, why: (e?.message ?? String(e)).split("\n")[0] }));
  return asked;
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
    try { bytes = file ? readPlain(file) : null; } catch { bytes = null; }
    if (!bytes) return page(404, renderNotFound());
    // The live picture's address carries its version, so it may be kept; a waiting one never is.
    const cache = sub === "cover.jpg" ? "public, max-age=86400" : "private, no-store";
    return { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": bytes.length, "Cache-Control": cache, "X-Robots-Tag": "noindex" }, body: bytes };
  }

  const account = sessionAccount(headers);
  const mine = account ? events.roleIn(account.conversation_id, ev.id) : null;

  // ---- the photo album (src/pages/album.js): the same person and the same role, read the same way ----
  if (sub && /^album(\/|$)/.test(sub)) {
    return await albumRequest({
      ev, sub, method, query, headers, readBody, account, mine, runtime, log,
      // Under the same per-browser ceiling as the sign-in page, so an unknown browser holding a
      // link cannot keep the link's owner's phone buzzing; then the per-person limit inside.
      sendCode: ({ conversationId, what }) => {
        const actor = eventActor(headers, remoteAddress);
        if (!events.signinGate(actor)) return { ok: false, reason: "rate_limited", retry_after_s: 3600 };
        events.noteSigninRequest(actor);
        return sendSigninCode({ ev, conversationId, runtime, what, log, actor });
      },
      tryCode: ({ conversationId, code }) => events.trySigninCode({ conversationId, code, actor: eventActor(headers, remoteAddress) }),
    });
  }

  // ---- the organizer's changes, from their own page (src/pages/eventmanage.js) ----
  if (sub === "manage") {
    if (ev.status === "cancelled") return page(404, renderNotFound());
    return await manageRequest({ ev, method, headers, readBody, account, mine, runtime, log });
  }

  // ---- back from Stripe (src/eventpay.js) ----
  // A guest after paying, or after changing their mind: a plain page, no state read off the address.
  if (sub === "paid" || sub === "pay-back") {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (ev.status === "cancelled") return page(404, renderNotFound());
    return page(200, renderAfterPay({ ev, paid: sub === "paid" }));
  }
  // The organizer back from Stripe's payouts onboarding: their account is read again (the webhook may
  // be late), then their own page. `refresh` is Stripe's "the link expired": a fresh one, straight back.
  if (sub === "payouts") {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (!account || mine?.role !== "organizer" || ev.status === "cancelled") return page(404, renderNotFound());
    const c = account.conversation_id;
    const fresh = await eventpay.refreshAccount(c).catch(() => ({ ok: false }));
    log({ event_payouts_return: ev.id, refresh: query.refresh === "1", ready: !!fresh.row?.charges_enabled });
    if (query.refresh === "1" && !fresh.row?.charges_enabled) {
      const link = await eventpay.onboardingLink(c, ev).catch(() => ({ ok: false }));
      if (link.ok) return redirect(link.url);
    }
    return redirect(`/e/${ev.public_id}?done=${fresh.row?.charges_enabled ? "payouts_ready" : "payouts_pending"}#money`);
  }

  // ---- sign this browser out ----
  if (sub === "signout") {
    if (method !== "POST") return page(405, renderNotFound(), { Allow: "POST" });
    // Only a browser that sent its session signs itself out. A post from another site carries no
    // cookie (SameSite=Lax), and is answered without touching the one this browser holds.
    const presented = readCookie(headers?.cookie);
    if (!presented) return redirect(`/e/${ev.public_id}`);
    for (const t of new Set([presented, ...readCookies(headers?.cookie)])) db.endPageSession(t);
    return redirect(`/e/${ev.public_id}`, { "Set-Cookie": clearCookieHeader({ path: "/", headers }) });
  }

  // ---- sign in by phone number ----
  if (sub === "signin") {
    if (ev.status === "cancelled") return page(404, renderNotFound());
    if (mine) return redirect(`/e/${ev.public_id}`);
    if (method !== "POST") return page(200, renderSignin({ ev }));
    const form = new URLSearchParams((await readBody()) ?? "");
    const number = String(form.get("number") ?? "").slice(0, 254);
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
      return redirect(`/e/${ev.public_id}`, { "Set-Cookie": cookieHeader(tried.token, { path: "/", headers }) });
    }
    if (!events.signinGate(actor)) return page(429, renderSignin({ ev, number, error: "Too many sign-in tries from this browser. Try again in an hour." }));
    events.noteSigninRequest(actor);
    if (who) sendSigninCode({ ev, conversationId: who.conversation_id, runtime, what: "sign in to", log, actor });
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
        // A handle typed here is kept for their next events too, as one sent by text is.
        if (ig && events.instagramHandle(ig)) db.setAccountInstagram(account.conversation_id, events.instagramHandle(ig));
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
      const asked = sendSigninCode({ ev, conversationId: owner.conversationId, runtime, what: owner.organizer ? "open your guest list for" : "open", log, actor: eventActor(headers, remoteAddress) });
      // The link is the owner's own, so saying no code went is no secret — and the page must not
      // say "Code sent ✓" when none did (a fast "Text it again" lands here).
      if (!asked.ok) return page(200, renderGate({ ev, token, sent: true, error: `Reason has already texted this link's code. Use that one, or try again in about ${Math.max(1, Math.ceil((asked.retry_after_s ?? 900) / 60))} minutes.` }));
      return page(200, renderGate({ ev, token, sent: true }));
    }
    if (form?.get("step") === "code") {
      const tried = events.trySigninCode({ conversationId: owner.conversationId, code: form.get("code"), actor: eventActor(headers, remoteAddress) });
      if (!tried.ok) {
        log({ event_signin_failed: ev.id, why: tried.reason });
        return page(tried.reason === "rate_limited" ? 429 : 200, renderGate({ ev, token, sent: true, error: tried.reason === "rate_limited" ? "Too many wrong codes from this browser. Try again in about 15 minutes." : "That code isn't right." }));
      }
      log({ event_signin_ok: ev.id });
      return redirect(whoPath(ev, token), { "Set-Cookie": cookieHeader(tried.token, { path: "/", headers }) });
    }
    return page(200, renderGate({ ev, token }));
  }

  // ---- a joined guest's own answers to the organizer's questions ----
  if (sub === "answers") {
    if (method !== "POST") return page(405, renderNotFound(), { Allow: "POST" });
    if (ev.status !== "active" || mine?.role !== "guest") return page(404, renderNotFound());
    if (!ownOrigin(headers)) return page(403, renderNotFound());
    const body = await readBody();
    if (body != null && String(body).length > 8000) return page(413, renderNotFound());
    const form = new URLSearchParams(body ?? "");
    const read = questions.readForm(ev, (k) => form.get(k), { own: true });
    const shown = (error) => page(200, renderJoined({ ev, att: mine.att, error }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
    if (read.problems.length) return shown(`${read.problems[0].prompt}: ${questions.ANSWER_WHY[read.problems[0].problem] ?? "that answer didn't read."}`);
    // A question reworded since this page was opened: nothing is saved, and the page shows the new words.
    // (One removed meanwhile just has its answer dropped.)
    const now = new Map(db.eventQuestions(ev.id).map(q => [q.id, q.version]));
    if (read.answers.some(a => now.get(a.q) !== a.v)) return shown("The host changed a question since you opened this page. Check it and save again.");
    const filed = questions.saveAnswers(ev, mine.att, read.answers, "page");
    // A clear takes back only the answer the page showed: one given by text since then stays.
    const current = ownValues(ev, mine.att);
    let cleared = 0;
    for (const c of read.cleared) if (current[`q_${c.id}`] === c.was && db.clearEventAnswer(c.id, mine.att.id)) cleared++;
    log({ event_answers_saved: ev.id, filed, cleared });
    return redirect(`/e/${ev.public_id}?saved=answers#answers`);
  }

  // ---- the help line's link (src/eventhelpline.js): /e/{id}/text opens a text to Reason, already written ----
  if (sub === "text") {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    if (ev.status !== "active" || !helpline.lineOn(ev)) return page(404, renderNotFound());
    return page(200, renderTextPage({ ev, lineNumber, userAgent: String(headers["user-agent"] ?? "") }));
  }

  // ---- the join page ----
  if (method !== "GET" && method !== "HEAD" && !(method === "POST" && sub === "join")) {
    return page(405, renderNotFound(), { Allow: "GET, HEAD" });
  }
  // ADD TO MY CALENDAR → (Pages v2): only for somebody on the event, only once its time is out.
  if (sub === "calendar.ics" && !config.pagesV2) return page(404, renderNotFound());
  if (sub === "calendar.ics") {
    if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
    const att = mine?.role === "guest" ? mine.att : null;
    const ics = ev.status !== "cancelled" && att ? calendarFile(ev, att) : null;
    if (!ics) return page(404, renderNotFound());
    return { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="event.ics"`, "Content-Length": Buffer.byteLength(ics), "Cache-Control": "private, no-store" }, body: ics };
  }
  // E2 (Pages v2): a cancelled event's link is turned off, and says only that.
  if (config.pagesV2 && ev.status === "cancelled") return page(410, made.renderTurnedOff({ siteUrl: config.siteUrl }));
  // The organizer opening their own event's link gets their own page, never a guest's — paused too,
  // so they can still see it and read what is held (the page says what pausing stops).
  if (mine?.role === "organizer" && ev.status !== "cancelled" && (method === "GET" || method === "HEAD") && !sub) return page(200, renderOrganizerHome({ ev, query }));
  // Cancelled: nothing but the name and that it is off, in the page and in its preview alike.
  if (ev.status !== "active") return page(200, shell({ title: ev.name, body: closedBody(ev), pill: "Event", url: events.eventUrl(ev), head: ev.status === "cancelled" ? "" : headFor(ev), css: CSS }));
  // The organizer opening their own event's link gets their own page, never a guest's.
  if (mine?.role === "organizer") return page(200, renderOrganizerHome({ ev, query }));
  if (mine?.role === "guest") return page(200, renderJoined({ ev, att: mine.att, saved: query.saved === "answers" }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
  const ua = String(headers["user-agent"] ?? "");
  if (method !== "POST") return page(200, renderJoin({ ev, account, lineNumber, userAgent: ua }));

  const form = new URLSearchParams((await readBody()) ?? "");
  const values = { display_name: form.get("display_name") ?? "", instagram: form.get("instagram") ?? "", in_directory: form.get("in_directory") === "1" };
  for (const q of db.eventQuestions(ev.id)) if (form.get(`q_${q.id}`) != null) values[`q_${q.id}`] = String(form.get(`q_${q.id}`)).slice(0, 600);
  const again = (status, error) => page(status, renderJoin({ ev, account, error, values, lineNumber, userAgent: ua }));
  const actor = eventActor(headers, remoteAddress);
  const found = await events.findForJoin({ actor, link: events.eventUrl(ev), password: form.get("password") ?? "", route: "web" });
  if (!found.ok) {
    log({ event_web_join_refused: ev.id, why: found.reason });
    if (found.reason === "rate_limited") return again(429, `Too many wrong tries. Try again in about ${Math.max(1, Math.ceil(found.retry_after_s / 60))} minutes.`);
    return again(200, "That password isn't right. Check it with whoever invited you.");
  }
  const instagram = values.instagram.trim() ? events.instagramHandle(values.instagram) : null;
  if (values.instagram.trim() && !instagram) return again(200, "That doesn't look like an Instagram handle — just the username, like @yourname.");
  // The host's questions: an answer that can't be read is sent back, and so is a required one left blank.
  const asked = questions.readForm(ev, (k) => form.get(k));
  if (asked.problems.length) return again(200, `${asked.problems[0].prompt}: ${questions.ANSWER_WHY[asked.problems[0].problem] ?? "that answer didn't read."}`);
  if (asked.missing.length) return again(200, `${asked.missing[0]}: the host asks everyone this one before they're in.`);

  // Somebody already on Reason, recognized by their page session (sessionAccount only returns an
  // account Reason still serves): joined now, no signup, no code.
  if (account) {
    const shown = events.cleanDisplayName(values.display_name) || events.cleanDisplayName(account.name) || "Guest";
    const out = events.admitExisting({ ev, conversationId: account.conversation_id, displayName: shown, instagram, inDirectory: values.in_directory, via: "web", actor });
    // A priced event (src/eventpay.js): the password was right; the spot is held and they go to
    // Stripe's page. Nobody is on the event until the webhook says the payment landed.
    if (!out.ok && out.reason === "payment_required") {
      const pay = await eventpay.startCheckout({ ev, conversationId: account.conversation_id, displayName: shown, instagram, inDirectory: values.in_directory, via: "web", answers: asked.answers, log });
      if (!pay.ok) {
        log({ event_web_pay_refused: ev.id, why: pay.reason });
        const why = { full: "This event is full right now (spots being paid for count). If a spot opens up, the same link and password will work.", removed: "The organizer took you off this event.", already: "You're already in.", no_payouts: "The organizer hasn't finished setting up payouts, so nobody can pay to join just yet.", paused: "Joining is paused right now." }[pay.reason]
          ?? "The payment page couldn't be opened just now. Nothing was charged — try again in a minute.";
        return again(200, why);
      }
      log({ event_web_pay_started: ev.id, reused: !!pay.reused });
      return redirect(pay.url);
    }
    if (!out.ok) {
      const why = { organizer: "You're organizing this one.", full: "This event is full right now. If a spot opens up, the same link and password will work.", removed: "The organizer took you off this event.", paused: "Joining is paused right now." }[out.reason] ?? "That didn't work.";
      return again(200, why);
    }
    const att = out.already ? out.attendee : events.afterJoin({ ev, att: out.attendee, typedInstagram: instagram });
    if (!out.already) questions.saveAnswers(ev, att, asked.answers, "join");
    if (!out.already) {
      await events.sendWelcome({ runtime, ev, att });
      events.scheduleListNote({ runtime, ev, att });
    }
    log({ event_web_joined: ev.id, existing: true });
    return page(200, renderJoined({ ev, att }).replace("</div></main>", `${signOutForm(ev)}</div></main>`));
  }

  // Anybody else: everything is on the page; the last step is one text.
  const name = events.cleanDisplayName(values.display_name);
  if (!name) return again(200, "Add the name other guests should see.");
  const claim = events.makeClaim({ ev, displayName: name, instagram, inDirectory: values.in_directory, answers: asked.answers });
  log({ event_web_claim: ev.id });
  return page(200, shell({ title: ev.name, body: finishStep({ ev, claim, lineNumber }), pill: "Event", url: events.eventUrl(ev), head: headFor(ev), css: CSS }));
}
