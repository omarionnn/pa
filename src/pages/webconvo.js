// Reason Web: the conversation (W2, docs/plans/reason-web-phase1.md §4.3–4.4), in the design handoff's
// look (~/Desktop/reason-web-handoff-2026-10-26: "Chat · mobile", "Desktop · conversation", B / B2
// arrival, sheets 4, 5 and 9). The kit it is drawn with is src/pages/webkit.js.
//
// Signed in, /web is the person's ONE conversation with Reason: their lines and Reason's from the
// per-message history W0 writes (db `messages`), each labelled with where it was said (iMessage or
// Web) and when, newest at the bottom, older pages fetched on request. Under it a one-line composer
// that posts into the SAME conversation through the web channel (Router.deliver, `channel: "web"`):
// the conversation id is the session's, never anything the browser names.
//
// Screens here:
//   home      the arrival (B / B2): the greeting, the composer, what's already in hand (only real
//             open tasks and timers) or three example requests, then "pick up from iMessage"
//   thread    the conversation itself (?thread, or straight after a Web message)
//   first     5C, once (`accounts.web_notice_seen_at`): "One Reason. Pick up anywhere."
//   ongoing   the mobile Ongoing tab: what Reason holds, or "Nothing left to chase."
//   soon      MEMORY and SETTINGS, which arrive in later phases: a calm page, not a dead link
//
// The rules this file keeps, each pinned in test/web-convo.test.js and test/web-design.test.js:
//   - one conversation per session: history, the stream and the send resolve it from the cookie
//   - a reply goes where the person is chatting: a Web message is answered in the browser, never texted too
//   - one message, one turn: every message carries a browser-made id; Router.deliver's claim on
//     `<conversation>:<id>` swallows a retry, a refresh resending, a second tab, a lost answer
//   - the work is the server's: a send is acknowledged as soon as Reason has the message
//   - safe rendering: every word is escaped; a line's markup is made HERE, from escaped text — a link
//     only for http(s), a list only from lines that start like one, a card only for Reason's own hosts.
//     The browser inserts that server-made markup; it never builds markup from a message itself.
//
// Live updates are Server-Sent Events. The website's proxy (heyreason.com/web, Netlify) buffers a
// stream until it ends, so when src/web.js webStreamOrigin names the pages host the page listens there
// (/web/live, CORS for the website's origin only, the shared cookie); otherwise at /web/stream. Either
// way the stream is the path a reply takes (owner 10-26: replies must feel instant). The 4 s poll of
// /web/history is only the fallback: it runs while the stream is not open, or once it has been silent
// past two of its 15 s `ping` events (a stream dead without an error), never alongside a live one.
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { renderWebNotFound } from "./webedge.js";
import * as db from "../db.js";
import { WEB, webStreamOrigin, siteOrigin } from "../web.js";
import { config, clock } from "../config.js";
import { esc } from "./render.js";
import { readCookie } from "./access.js";
import { ongoing, findItem, itemRecord, speakFirstPrompt, approvals as pendingApprovals } from "../ongoing.js";
import { ogMargin, ogVersion, ogTabMain, OG_TAB_LIVE_JS, homeRows, needsYes, countLine, OG_CSS, NINE_D_JS, NINE_D_CSS, OG_POLL_JS } from "./webongoing.js";
import { SECURITY_HEADERS, sameOrigin, sessionAccount, greeting, WEB_AWAY_MS } from "./websignin.js";
import { webPage, wordmark, label, hand, action, typed, stamp, onIt, approvalCard, themeSwitch, bubble, OG_KEY } from "./webkit.js";
import { mediaOut, mediaHtml, ownWords, composerHtml, listeningHtml, composeBoot, COMPOSE_CSS, COMPOSE_JS } from "./webcompose.js";
import { prepareSend } from "../webmedia.js";
import * as settle from "../settle.js";
import { doingFor, doingEvents } from "../doing.js";

/** How many lines a page of history holds, first load and each "show earlier". */
export const PAGE = 40;
/** The longest message the composer takes; the same cap is held on the server. */
export const MAX_TEXT = 4000;
/** Sends per conversation per minute: generous for a person, a wall for a runaway script. */
export const SEND_LIMIT = 20;
/** How long one stream response runs before the browser is asked to reconnect (under Netlify's proxy limit). */
export const STREAM_MS = 20_000;
/** The same, on the pages host, which nothing in between cuts short. */
export const LIVE_STREAM_MS = 5 * 60_000;
/** How often an open stream re-checks that the browser is still signed in. */
export const STREAM_RECHECK_MS = 10_000;
/** A Web message this recent means they are mid-conversation: /web opens on the thread, not the arrival.
 * Never right after signing in: sign-in lands on /web?home, which is always the arrival (owner, 10-27). */
export const THREAD_RECENT_MS = 30 * 60_000;
/** §4h "take it back": how long the page offers it after a send (and only until Reason starts on it). */
export const TAKE_BACK_MS = 5000;

// The first-visit note, 5C (owner copy in the handoff).
export const BOUNDARY = {
  title: "One Reason.",
  titleEm: "Pick up anywhere.",
  body: "This is the same Reason you text. What you send here stays here; it won't show up in your iMessage thread.",
  note: "either place works. i'll keep up.",
};
/** B2: three requests to start with. Tapping one fills the composer; nothing is sent until they send it. */
export const EXAMPLES = [
  "Call health services and book a checkup for me.",
  "Find a plumber who can come this week.",
  "Every Sunday, remind me to call home.",
];

const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

/** Where a line was said, as a person would name it. A text is iMessage unless the thread knows it was SMS. */
export function sourceLabel(channel, service = null) {
  if (channel === WEB) return "Web";
  if (channel === "console") return "Console";
  return String(service ?? "").toUpperCase() === "SMS" ? "SMS" : "iMessage";
}

const timeFmt = () => new Intl.DateTimeFormat("en-US", { timeZone: config.tz, hour: "numeric", minute: "2-digit" });
const dayFmt = () => new Intl.DateTimeFormat("en-US", { timeZone: config.tz, weekday: "short", month: "short", day: "numeric" });
const dayKey = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

// ---------------------------------------------------------------- what a line is made of

/** Text with its links made tappable, everything else escaped. http(s) only; trailing punctuation stays text. */
export function linkify(text) {
  const s = String(text ?? "");
  let out = "", last = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    let url = m[0];
    const trail = /[.,!?;:)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    out += esc(s.slice(last, m.index));
    out += `<a href="${esc(url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  return out + esc(s.slice(last));
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const monthFmt = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, month: "short" });
const dateFmt = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, day: "numeric" });

/**
 * A link to one of Reason's own hosts, as a paper card: the typed domain, a serif title, "Open →".
 * An event link with a known date gets the date block. Titles come from this conversation's own
 * rows only (a page it made, an event it organises or was let into); anything else is a plain card
 * with a plain title, so a pasted link never reads somebody else's page title out.
 */
export function linkCard(url, conversationId) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const pages = hostOf(config.pagesUrl), events = hostOf(config.eventsUrl) || pages;
  if (!host || (host !== pages && host !== events)) return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (/^\/web(?:\/|$)/.test(path)) return null; // Web's own addresses (a file, the thread) are links, not page cards
  let title = "A page Reason made", date = null, m;
  if ((m = /^\/e\/([A-Za-z0-9_-]{4,64})(?:\/|$)/.exec(path))) {
    title = "An event";
    const ev = db.eventByPublicId(m[1]);
    const mine = ev && (ev.organizer_conversation_id === conversationId || db.attendeeRow(ev.id, conversationId)?.state === "joined");
    if (mine) {
      title = ev.name;
      if (ev.starts_at) date = { mon: monthFmt(ev.tz).format(ev.starts_at).toUpperCase(), day: dateFmt(ev.tz).format(ev.starts_at) };
    }
  } else if (/^(?:\/p)?\/i\/[A-Za-z0-9_-]{8,64}$/.test(path)) {
    title = "An invite to Reason";
  } else if ((m = /^(?:\/p)?\/([A-Za-z0-9_-]{6,64})$/.exec(path))) {
    const page = db.getPageIn(conversationId, m[1]);
    if (page?.title) title = page.title;
  }
  const domain = esc(host.toUpperCase());
  const attrs = `href="${esc(url)}" rel="noopener noreferrer nofollow" target="_blank"`;
  if (date) {
    return `<a class="card lcard ev" ${attrs}><span class="ev-date"><span class="ev-mon">${esc(date.mon)}</span><span class="ev-day">${esc(date.day)}</span></span>`
      + `<span class="ev-txt"><span class="lc-dom">${domain}</span><span class="ev-t">${esc(title)}</span><span class="lc-go">Open <span aria-hidden="true">→</span></span></span></a>`;
  }
  return `<a class="card lcard" ${attrs}><span class="lc-dom">${domain}</span><span class="lc-t">${esc(title)}</span><span class="lc-go">Open <span aria-hidden="true">→</span></span></a>`;
}

const LIST_ITEM = /^\s*(?:(\d{1,2})[.)]|[-•*])\s+(\S.*)$/;
const PRICE = /^(.*?\S)\s*(?:[—–-]|:)?\s+(\$[\d,]+(?:\.\d{2})?)$/;

/**
 * Reason's words as blocks: paragraphs (blank-line separated), and lists — consecutive lines that
 * start "1." / "1)" / "-" / "•" — drawn as typed 01 02 03 in pen between dashed rules. A link to
 * one of Reason's own hosts becomes a card under the words (and leaves the sentence when it stood
 * alone on its line). Everything is escaped first; only those shapes ever become markup.
 */
export function reasonBody(text, conversationId) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const cards = [];
  const seen = new Set();
  const cardFor = (url) => { if (seen.has(url)) return true; const c = linkCard(url, conversationId); if (c) { seen.add(url); cards.push(c); } return !!c; };
  // Cards first, so a link that is the whole line can leave it.
  const kept = lines.map((l) => {
    const urls = [...l.matchAll(/https?:\/\/[^\s<>"'`]+/g)].map(m => m[0].replace(/[.,!?;:)\]]+$/, ""));
    let out = l;
    for (const url of urls) if (cardFor(url) && l.trim().replace(/[.,!?;:)\]]+$/, "") === url) out = "";
    return out;
  });
  let html = "", para = [], list = [];
  const flushPara = () => { if (para.length) { html += `<p>${linkify(para.join("\n"))}</p>`; para = []; } };
  const flushList = () => {
    if (!list.length) return;
    // A numbered item keeps its own number (a reply split across texts still reads 01, 02, 03).
    html += `<ol class="rl">${list.map(({ n: own, text: item }, i) => {
      const p = PRICE.exec(item);
      const n = String(own ?? (list[0].n ?? 1) + i).padStart(2, "0");
      return `<li><span class="rl-n" aria-hidden="true">${n}</span><span class="rl-t">${linkify(p ? p[1] : item)}</span>${p ? `<span class="rl-p">${esc(p[2])}</span>` : ""}</li>`;
    }).join("")}</ol>`;
    list = [];
  };
  for (let i = 0; i < kept.length; i++) {
    const l = kept[i], orig = lines[i];
    const item = LIST_ITEM.exec(orig);
    if (item && l.trim()) { flushPara(); list.push({ n: item[1] ? Number(item[1]) : null, text: item[2] }); continue; }
    if (!l.trim()) { flushList(); flushPara(); continue; }
    flushList();
    para.push(l);
  }
  flushList(); flushPara();
  return html + cards.join("");
}

/** One line's inside, server-made from escaped text (also sent to the page for lines that arrive live). */
function lineInner(m, conversationId) {
  const who = m.role === "user" ? "YOU" : "REASON";
  const voice = m.media.some(x => x.kind === "voice");
  const lbl = `<p class="lbl"><span>${who}${voice ? " · VOICE" : ""} · ${esc(m.source.toUpperCase())} · </span><time datetime="${new Date(m.at).toISOString()}">${esc(timeFmt().format(m.at))}</time></p>`;
  // 4B: photos in their paper frames, file slips, a voice note's words then ▶ (src/pages/webcompose.js).
  const { photos, files, play, voice: note } = mediaHtml(m);
  const said = m.role === "user" ? (voice && note?.transcript ? note.transcript : ownWords(m.text, m.media)) : m.text;
  let words = "";
  if (said.trim()) {
    if (m.role === "user") words = voice ? `<p class="said hand">${esc(said)}</p>` : `<div class="said">${linkify(said)}</div>`;
    else words = `<div class="rsay">${reasonBody(said, conversationId)}</div>`;
  }
  m.plain = said.trim() ? said : [...m.media.filter(x => x.kind === "file").map(x => x.name), ...m.media.filter(x => x.kind === "image").map(() => "a photo")].filter(Boolean).join(" · ");
  return `${lbl}${photos}${files}${words}${play}`;
}

/**
 * One history row as the browser gets it. `cid` is the browser's own id for a line sent from Web
 * (the part after the conversation prefix Router.deliver put on it), so the page can swap its
 * "sending" line for the real one; `html` is the line drawn here; nothing else about the row's
 * bookkeeping leaves the server.
 */
export function rowOut(row, { conversationId, service = null, now = clock.now() }) {
  const prefix = `${conversationId}:`;
  const ext = String(row.external_id ?? "");
  const m = {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    source: sourceLabel(row.channel, service),
    web: row.channel === WEB,
    text: String(row.text ?? ""),
    media: mediaOut(row, conversationId),
    at: row.at,
    cid: row.role === "user" && row.channel === WEB && ext.startsWith(prefix) ? ext.slice(prefix.length) : null,
  };
  m.files = m.media.filter(x => x.kind === "file").map(x => x.name);
  m.html = lineInner(m, conversationId);
  // S2: the day and the device, for the "where you are" note (src/settle.js); never guessed.
  m.day = dayKey(m.at);
  m.dayLabel = dayName(m.at, now);
  m.where = settle.whereWords({ at: m.at, device: settle.deviceOf(row, conversationId), now });
  return m;
}

const serviceOf = (conversationId) => db.getThread(conversationId)?.service ?? null;

const placeAttrs = (m) => ` data-day="${esc(m.day ?? dayKey(m.at))}"${m.where ? ` data-where="${esc(m.where)}"` : ""}`;
function lineHtml(m) {
  return `<li class="msg ${m.role === "user" ? "you" : "re"}" id="m-${m.id}" data-id="${m.id}" data-at="${m.at}" data-web="${m.web ? 1 : 0}"${m.cid ? ` data-cid="${esc(m.cid)}"` : ""}${placeAttrs(m)}>${m.html}</li>`;
}

const dayName = (at, now) => {
  const d = dayKey(at);
  return d === dayKey(now) ? "TODAY" : d === dayKey(now - 864e5) ? "YESTERDAY" : dayFmt().format(at).toUpperCase();
};
const continued = (where) => `<li class="cont" role="separator" aria-label="Continued ${esc(where)}"><span aria-hidden="true"></span><span class="hand">Continued ${esc(where)}</span><span aria-hidden="true"></span></li>`;

/**
 * S3, a finished task settled into one line between dashed rules: a DONE stamp, the title, the typed
 * meta and the count, a real button that unfolds the original messages (quoted, muted, a thin rule on
 * the left). Just finished: JUST NOW and the Caveat line until it is opened. Without script the fold
 * simply stays open. `data-ids` names every message folded into it, so a live copy is never added twice.
 */
export function doneHtml(fold, { conversationId, service = null, now = clock.now() }) {
  const ms = fold.rows.map(r => rowOut(r, { conversationId, service, now }));
  const last = ms.at(-1);
  const d = settle.doneLine(fold, { now, sourceOf: (r) => sourceLabel(r.channel, service) });
  const quotes = ms.filter(m => m.plain).map(m => `<p class="${m.role === "user" ? "q-you" : "q-re"}">${esc(m.plain)}</p>`).join("");
  const tilt = d.taskId % 2 ? -3 : 2;
  return `<li class="msg done" data-task="${d.taskId}" data-id="${last.id}" data-ids="${ms.map(m => m.id).join(" ")}" data-at="${last.at}" data-web="${last.web ? 1 : 0}" data-n="${d.count}"${d.fresh ? ` data-fresh="1"` : ""}${placeAttrs(last)}>`
    + `<button class="dl" type="button" aria-expanded="false" aria-controls="fold-${d.taskId}"><span class="dl-st" style="transform:rotate(${tilt}deg)">DONE</span>`
    + `<span class="dl-t"><span class="dl-title">${esc(d.title)}</span><span class="dl-meta">${esc(d.meta)}</span></span><span class="dl-n">${d.count} ↓</span></button>`
    + `<div class="fold" id="fold-${d.taskId}">${quotes}</div>`
    + (d.fresh ? `<p class="hand dl-fresh">just wrapped this one up. tap to see how.</p>` : "")
    + `</li>`;
}

/**
 * The lines with a day label where the day changes and a "Continued on Web" mark where the place does.
 * `folds` (src/settle.js foldsFor) settles each finished task at its last message: the DONE line goes
 * there and its other messages are not drawn on their own. A day label carries the day and the
 * "where you are" words of the first thing under it.
 */
export function listHtml(lines, { now = clock.now(), folds = null, conversationId = "", service = null } = {}) {
  let out = "", day = null, web = null;
  for (const m of lines) {
    const tid = folds?.owner.get(m.id);
    const fold = tid != null ? folds.folds.get(tid) : null;
    if (fold && fold.lastId !== m.id) continue;
    const d = dayKey(m.at);
    if (d !== day) { out += `<li class="day" role="separator" data-day="${esc(d)}"${m.where ? ` data-where="${esc(m.where)}"` : ""}>${label(dayName(m.at, now))}</li>`; day = d; }
    if (fold) {
      // Where the person was when this work began and ended counts for "Continued on Web" as if unfolded.
      const theirs = fold.rows.filter(r => r.role === "user");
      const firstWeb = theirs.length ? theirs[0].channel === WEB : null;
      if (web !== null && firstWeb !== null && firstWeb !== web) out += continued(firstWeb ? "on Web" : `in ${sourceLabel(theirs[0].channel, service)}`);
      if (theirs.length) web = theirs.at(-1).channel === WEB;
      out += doneHtml(fold, { conversationId, service, now });
      continue;
    }
    if (web !== null && m.web !== web && m.role === "user") out += continued(m.web ? "on Web" : `in ${m.source}`);
    if (m.role === "user") web = m.web;
    out += lineHtml(m);
  }
  return out;
}

/** One page of history drawn: its lines with finished tasks settled (src/settle.js), as the thread shows it. */
export function pageHtml(lines, { conversationId, service = null, now = clock.now(), keep = null, chat = "" }) {
  const folds = settle.foldsFor(conversationId, lines.map(m => m.id), { chat });
  // A window that ends before a task's last message (Saved's ?at=) draws that task's lines as they are,
  // and the message somebody came to find is never folded away.
  const here = new Set(lines.map(m => m.id));
  for (const [tid, f] of [...folds.folds]) {
    if (here.has(f.lastId) && !(keep != null && f.rows.some(r => r.id === keep))) continue;
    folds.folds.delete(tid);
    for (const [mid, t] of [...folds.owner]) if (t === tid) folds.owner.delete(mid);
  }
  return listHtml(lines, { now, folds, conversationId, service });
}

// ---------------------------------------------------------------- what Reason holds

/**
 * What Reason is holding for this conversation right now — its open tasks, its pending reminders and
 * its standing ones, nothing invented (src/ongoing.js): needs-you first, then whatever is due soonest.
 * What the arrival's ALREADY IN HAND, the Ongoing tab and the desktop margin show.
 */
export function inHand(conversationId) {
  return ongoing(conversationId).items;
}

/** Approvals Reason is waiting on (asked, not answered) in the last day: the one loud thing. */
export function waitingApprovals(conversationId, now = clock.now()) {
  return pendingApprovals(conversationId, now);
}

// ---------------------------------------------------------------- the look
const CSS = `
.top{position:sticky;top:0;z-index:20;background:var(--ground);padding:20px var(--gut) 12px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px dashed transparent;transition:border-color .2s}
.top.stuck{border-bottom-color:var(--hair)}
.top nav{display:none;align-items:center;gap:28px}
.menu-b{width:44px;height:44px;margin-right:-10px;border:0;background:transparent;display:grid;place-items:center;cursor:pointer;color:var(--ink)}
.menu-b svg{width:20px;height:20px;fill:currentColor}
.menu{position:fixed;inset:0;z-index:40;background:var(--ground);padding:20px var(--gut) 32px;display:flex;flex-direction:column;gap:24px;overflow:auto}
.menu[hidden]{display:none}
.menu-h{display:flex;justify-content:space-between;align-items:center}
.menu ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.menu li{border-bottom:1px dashed var(--hair)}
.menu li .act{min-height:60px}
.menu form{margin:0}
.wrapc{flex:1 0 auto;width:100%;max-width:1200px;margin:0 auto;padding:8px var(--gut) 0;display:flex;flex-wrap:wrap;gap:72px;align-items:flex-start}
.convo{flex:999 1 540px;min-width:0;display:flex;flex-direction:column;gap:26px}
.thread{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:40px}
.start{align-self:center;text-align:center}
.start .lbl{white-space:normal}
.day{text-align:center;margin-top:12px}
.thread>.day:first-child{margin-top:0}
.where{position:relative;display:block;flex:0 1 230px;min-width:0;height:30px;margin-left:auto}
.where[hidden]{display:none}
.wn-s{position:absolute;right:0;top:0;white-space:nowrap;font:400 22px/30px var(--hand);color:var(--pen);opacity:0;transform:rotate(-2deg) translateY(-10px);transition:opacity .5s ease,transform .6s cubic-bezier(.2,.8,.2,1)}
.wn-s.on{opacity:1;transform:rotate(-2deg) translateY(0)}
.done{display:flex;flex-direction:column;gap:12px;align-self:stretch}
.dl{min-height:52px;width:100%;border:0;background:transparent;padding:12px 0;border-top:1px dashed var(--hair);border-bottom:1px dashed var(--hair);display:flex;align-items:center;gap:12px;cursor:pointer;text-align:left;color:var(--ink);font:inherit}
.dl-st{flex-shrink:0;font:700 10px/1.3 var(--mono);letter-spacing:.12em;color:var(--pen);border:1.5px solid var(--pen);border-radius:3px;padding:2px 7px}
.dl-t{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dl-title{font-size:15px;line-height:1.35;overflow-wrap:anywhere}
.dl-meta{font:400 10px/1.4 var(--mono);letter-spacing:.12em;color:var(--muted)}
.dl-n{font:400 10.5px/1.3 var(--mono);letter-spacing:.1em;color:var(--muted);white-space:nowrap}
.fold{padding-left:16px;border-left:1px solid var(--hair);display:flex;flex-direction:column;gap:12px}
html.js .done:not(.open) .fold{display:none}
.fold p{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.q-you{align-self:flex-end;font:italic 400 18px/1.3 var(--serif);color:var(--muted);text-align:right}
.q-re{font-size:14px;line-height:1.5;color:var(--muted)}
.dl-fresh{font-size:20px;margin-top:-4px}
.done.open .dl-fresh{display:none}
.l1{display:flex;flex-direction:column;gap:30px;min-height:calc(100vh - 340px);min-height:calc(100dvh - 340px)}
.l1~.longwork,.l1~.approval,.l1~.empty{display:none}
.l1[hidden],.l1 [hidden]{display:none}
.l1-sp{flex:1}
html:not(.js) .l1,html:not(.js) .thread[aria-busy]{display:none}
.gh{display:flex;flex-direction:column;gap:10px;width:100%}
.gh-l{display:block;width:90px;height:1px;background:var(--hair);opacity:.7}
.gh-w{display:flex;flex-direction:column;gap:12px;width:100%}
.gh-w span{display:block;height:2px;background:var(--hair);animation:ghost 1.6s ease-in-out infinite}
.gh-re .gh-l,.gh-re .gh-w{align-self:flex-start;align-items:flex-start}
.gh-you .gh-l{align-self:flex-end}.gh-you .gh-w{align-items:flex-end}
@keyframes ghost{50%{opacity:.5}}
.start.finding{align-self:stretch;text-align:left}
.start .gh{margin-top:26px}
.l2-rule{border-top:1px dashed var(--hair);margin-top:26px}
.longwork{display:flex;flex-direction:column;gap:26px}
.longwork[hidden],.onit:not([hidden])~.longwork{display:none}
.lw-on{display:flex;align-items:center;gap:12px}
.lw-on .ring{width:36px;height:36px;border-radius:50%;border:1px solid var(--hair);display:grid;place-items:center;flex:none;animation:breathe 3.2s ease-in-out infinite}
.lw-on .bub{width:15px;height:15px;color:var(--pen);transform:skewX(-10deg)}
.lw-on .hand{font-size:23px}
.lw-note{margin:0;font-size:15px;line-height:1.55;color:var(--muted)}
.today{flex-shrink:0;min-height:44px;padding:0 4px;border:0;background:transparent;cursor:pointer;font:400 11px/1 var(--mono);letter-spacing:.14em;color:var(--ink);white-space:nowrap}
.today[hidden]{display:none}
.cont{display:flex;align-items:center;gap:14px;margin-top:-14px}
.cont>span:not(.hand){flex:1;border-top:1px dashed var(--hair)}
.cont .hand{font-size:23px}
.msg{display:flex;flex-direction:column;gap:8px;min-width:0}
.msg .lbl time{font:inherit}
.you{align-self:flex-end;align-items:flex-end;max-width:85%}
.said{margin:0;text-align:right;font:italic 400 23px/1.25 var(--serif);white-space:pre-wrap;overflow-wrap:anywhere}
.said.hand{font:400 26px/1.15 var(--hand);color:var(--pen)}
.said a,.rsay a{color:inherit;text-decoration-color:var(--pen);text-underline-offset:3px}
.re{align-self:stretch}
.rsay{display:flex;flex-direction:column;gap:12px;max-width:34em}
.rsay p{margin:0;font-size:16px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.rl{margin:2px 0;padding:0;list-style:none}
.rl li{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:0 8px;padding:12px 0;border-top:1px dashed var(--hair);font-size:16px;line-height:1.5;align-items:baseline}
.rl li:last-child{border-bottom:1px dashed var(--hair)}
.rl-n{font:400 13px/1 var(--mono);color:var(--pen)}
.rl-t{overflow-wrap:anywhere}
.rl-p{font:400 14px/1 var(--mono)}
.lcard{text-decoration:none;color:var(--ink);padding:18px;display:flex;flex-direction:column;gap:8px;align-self:flex-start;min-width:min(320px,100%);max-width:100%}
.lc-dom{font:400 10.5px/1.3 var(--mono);letter-spacing:.1em;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lc-t{font:italic 400 24px/1.15 var(--serif);overflow-wrap:anywhere}
.lc-go{font-size:14px;font-weight:500}
.ev{flex-direction:row;padding:0;gap:0;overflow:hidden}
.ev-date{width:92px;flex:none;background:var(--deep);border-right:1px solid var(--hair);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:12px 0}
.ev-mon{font:400 11px/1 var(--mono);letter-spacing:.1em;color:var(--pen)}
.ev-day{font:italic 400 36px/1 var(--serif)}
.ev-txt{padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0}
.ev-t{font-size:15px;font-weight:600}
.ev .lc-go{font-size:13px}
.photo{width:220px;max-width:100%;height:160px;background:var(--photo);border:6px solid var(--lifted);box-shadow:var(--shp);transform:rotate(2deg);display:grid;place-items:center}
.re .photo{transform:rotate(-1.5deg)}
.slip{display:inline-flex;align-items:center;background:var(--lifted);border:1px solid var(--hair);border-radius:2px;box-shadow:var(--sh);padding:12px 14px;transform:rotate(-.6deg);font:400 12px/1.2 var(--mono);letter-spacing:.04em;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg[data-state=sending],.msg[data-state=waiting]{opacity:.6}
.st{margin:0;font:400 10.5px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.msg[data-state=sending] .st,.msg[data-state=waiting] .st{color:var(--ink)}
.st.fade{transition:opacity .6s ease .4s;opacity:0}
.retry{min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:400 22px/1.1 var(--hand);color:var(--pen)}
.retry+.st{font-size:10px;letter-spacing:.12em}
.away{margin:-32px 0 -14px}
.away .hand{font-size:25px;line-height:1.2;transform:rotate(-1deg)}
.tb{display:flex;flex-direction:column;align-items:flex-end}
.tb-b{min-height:44px;min-width:44px;border:0;background:transparent;padding:0;cursor:pointer;font:400 23px/1 var(--hand);color:var(--pen)}
.tb-l{display:block;width:100px;height:1px;margin-top:-9px;background:var(--pen);transform-origin:left;animation:tb-drain 5s linear forwards}
@keyframes tb-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.tb-gone{font-size:23px}
.msg[data-state=sending]:has(.tb){opacity:1}
.msg[data-state=sending]:has(.tb)>:not(.tb){opacity:.6}
@media (prefers-reduced-motion:reduce){.tb-l{display:none}}
.approval{display:flex;flex-direction:column;gap:10px}
.onit .hand{font-size:23px}
.netline{position:sticky;top:0;z-index:7;background:var(--ground);margin:0;padding:18px var(--gut);text-align:center;font:400 22px/1.2 var(--hand);color:var(--pen);border-bottom:1px dashed var(--hair)}
.netline[hidden]{display:none}
.composer{position:sticky;bottom:0;z-index:5;background:var(--ground);padding:8px 0 calc(16px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:6px}
.cform{display:flex;align-items:center;gap:10px;border-top:1px solid var(--ink);padding:6px 0 0;margin:0}
.cform input[type=text]{flex:1;min-width:0;height:44px;border:0;border-radius:0;background:transparent;font:italic 400 21px/1 var(--serif);color:var(--ink);padding:0;-webkit-appearance:none;appearance:none}
.cform input[type=text]::placeholder{color:var(--muted);opacity:1}
.cform input[type=text]:focus-visible{outline:none}
.cform:focus-within{border-top-width:2px;padding-top:5px}
.send{width:44px;height:44px;flex:none;border:0;border-radius:2px;background:var(--ink);color:var(--ground);display:grid;place-items:center;cursor:pointer}
.send svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.cform input:placeholder-shown~.send{display:none}
.under{margin:0;font-size:13px;color:var(--muted)}
.og{display:none;flex:1 1 300px;max-width:340px;flex-direction:column;gap:28px;padding-top:8px;position:sticky;top:104px;transition:transform .32s ease,opacity .32s ease}
.og.going{transform:translateX(48px);opacity:0}
.og h2{margin:0;font:italic 400 32px/1.1 var(--serif)}
.og-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.og-hide:hover,.og-back:hover{color:var(--pen)}
.og-back{display:none;position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:15;min-width:44px;min-height:44px;padding:20px 12px;border:0;border-left:1px dashed var(--hair);background:var(--ground);cursor:pointer;color:var(--ink);font:400 12px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;writing-mode:vertical-rl}
html.og-off .wrapc>.og{display:none}
.og-sec{display:flex;flex-direction:column}
.og-sec h3{margin:0 0 4px;font:400 12px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.og-sec h3.pen{color:var(--pen)}
.og-row{padding:14px 0;border-bottom:1px dashed var(--hair);display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.og-row:last-child{border-bottom:0}
.og-row b{font-size:15px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.og-row .lbl{flex:none;font-size:11px;letter-spacing:.1em}
.og-row .when{flex:none;font:italic 400 20px/1 var(--serif)}
.empty{display:flex;flex-direction:column;gap:20px}
.empty .h2{margin:0;font:italic 400 32px/1.1 var(--serif)}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:6;background:var(--ground);border-top:1px solid var(--hair);padding:6px 16px calc(22px + env(safe-area-inset-bottom));display:flex;justify-content:space-around}
.tabs a{min-width:96px;min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;font:italic 400 21px/1 var(--serif);color:var(--muted)}
.tabs a[aria-current=page]{color:var(--ink)}
.tabs .n{font:700 11px/1 var(--mono);font-style:normal;color:var(--pen)}
body.has-tabs{padding-bottom:84px}
body.has-tabs .composer{bottom:76px}
body.typing .tabs{display:none}
body.typing.has-tabs .composer{bottom:0}
body.has-tabs .foot{display:none}
.home{flex:1 0 auto;width:100%;max-width:760px;margin:0 auto;padding:48px var(--gut) 64px;display:flex;flex-direction:column;gap:40px}
.greet{margin:0;text-align:center;font:italic 400 42px/1.08 var(--serif);letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.home .composer{position:static;padding:0;background:transparent}
.home .cform{margin-top:-8px;padding:8px 0;border-bottom:1px solid var(--hair)}
.home .under{display:none}
.home .cform input[type=text]{height:52px;font-size:24px}
.start-w,.inhand{display:flex;flex-direction:column;gap:6px;margin-top:24px}
.start-w[hidden]{display:none}
.start-w .lbl,.inhand>.lbl{font-size:12px;margin:0 0 8px}
.ex{align-self:flex-start;min-height:48px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 24px/1.2 var(--serif);color:var(--ink);text-align:left}
.ex:hover{color:var(--hov)}
.pick{text-decoration:none;color:var(--ink);display:flex;flex-direction:column;gap:12px;margin-top:24px}
.pick-h{display:flex;align-items:center;gap:16px}
.pick-h .hand{font-size:26px;flex:none}
.pick-h .dash{flex:1;border-top:1px dashed var(--hair)}
.pick-q{display:flex;flex-direction:column;gap:10px;padding-left:20px;border-left:1px solid var(--hair)}
.pick-q .y{align-self:flex-end;font:italic 400 22px/1.25 var(--serif);color:var(--muted);text-align:right;overflow-wrap:anywhere}
.pick-q .r{font-size:17px;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.pick-go{align-self:flex-end;font:italic 400 26px/1 var(--serif);min-height:48px;display:inline-flex;align-items:center}
.pick-n{font-size:14px;color:var(--muted)}
.pick:hover .pick-go{color:var(--hov)}
.solo{flex:1 0 auto;width:100%;max-width:640px;margin:0 auto;padding:40px 32px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.solo p.body{margin:0;font-size:17px;line-height:1.6}
.solo p.quiet{margin:0;font-size:16px;line-height:1.55;color:var(--muted)}
.ghost{background:var(--lifted);border:1px solid var(--hair);border-radius:4px;padding:18px;opacity:.5;display:flex;flex-direction:column;gap:6px}
.ghost b{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.og-m{flex:1 0 auto;padding:0 32px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center}
.og-m .h1{font-size:44px;line-height:1.08}
.og-m .hand{font-size:24px;line-height:1.25;transform:rotate(-1.5deg)}
.og-list{flex:1 0 auto;padding:24px var(--gut);display:flex;flex-direction:column;gap:28px}
.og-list .h1{font-size:44px}
.soon form{margin:0}
.soon .themes{margin-top:8px}
@media (min-width:900px){
.l1{min-height:calc(100vh - 290px);min-height:calc(100dvh - 290px)}
.top{padding:22px clamp(20px,4vw,48px)}
.top nav{display:flex}
.menu-b{display:none}
.wrapc{padding:16px clamp(20px,4vw,48px) 0}
.convo{gap:36px}
.lbl{font-size:11px}
.said{font-size:26px;line-height:1.3}
.said.hand{font-size:30px}
.rsay p{font-size:18px;line-height:1.6}
.rl li{grid-template-columns:40px minmax(0,1fr) auto;font-size:17px;padding:14px 0}
.lc-t{font-size:26px}
.lcard{padding:18px 22px}
.photo{width:280px;height:200px;border-width:8px;transform:rotate(1.5deg)}
.you{max-width:75%}
.cont .hand{font-size:26px}
.cform input[type=text]{height:48px;font-size:24px}
.cform{padding-top:10px}
.composer{padding:12px 0 24px;margin-top:12px}
.og{display:flex}
html.og-off .og-back{display:flex;align-items:center;justify-content:center}
html.og-off .wrapc{padding-right:max(64px,4vw)}
.og-back:focus-visible{outline-offset:-4px}
.tabs{display:none}
body.has-tabs{padding-bottom:0}
body.has-tabs .composer{bottom:0}
body.has-tabs .foot{display:flex}
.home{padding:110px 24px 64px;gap:48px}
.greet{font-size:64px}
.home .cform input[type=text]{font-size:26px}
.start-w,.inhand,.pick{margin-top:56px}
.ex{font-size:26px}
.pick{margin-top:64px}
.pick-h .hand{font-size:28px}
.solo .h1{font-size:64px}
.og-m{display:none}
}
@media (max-width:420px){.wn-s{font-size:20px}}
@media (max-width:359px){.greet{font-size:34px}.lbl{font-size:10px;letter-spacing:.12em}.rsay p{font-size:15px}}
${OG_CSS}${NINE_D_CSS}`;

/** The conversation's look, for Ongoing's See all page (src/pages/webongoing.js) that shares its tab bar. */
export const CONVO_CSS = CSS;

const MENU_SVG = `<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`;
const SEND_SVG = `<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5"/></svg>`;

const signOutForm = (csrf, cls = "act2") => `<form method="POST" action="/web/signout"><input type="hidden" name="c" value="${esc(csrf)}"><button class="${cls}" type="submit">SIGN OUT OF THIS BROWSER</button></form>`;

/** The top of every signed-in screen: the wordmark home; MEMORY and SETTINGS on desktop; a menu on phones. */
function topBar({ csrf, extra = "", where = "" }) {
  return `<header class="top">${wordmark({ href: "/web?home" })}${where}`
    + `<nav aria-label="Account">${extra}${typed("SAVED", { href: "/web/saved" })}${typed("MEMORY", { href: "/web/memory" })}${typed("SETTINGS", { href: "/web/settings" })}</nav>`
    + `<button class="menu-b" type="button" aria-label="Menu" aria-expanded="false" aria-controls="menu">${MENU_SVG}</button></header>`
    + `<div class="menu" id="menu" hidden role="dialog" aria-modal="true" aria-label="Menu"><div class="menu-h">${wordmark()}<button class="act2 menu-x" type="button">CLOSE</button></div>`
    + `<ul><li>${action("The thread", { href: "/web?thread" })}</li><li>${action("Memory", { href: "/web/memory" })}</li><li>${action("Settings", { href: "/web/settings" })}</li></ul>`
    + `${signOutForm(csrf)}</div>`;
}

/** The phone's three tabs (v2 handoff): Chat · Ongoing (its count in pen) · Saved, the current one in ink. */
export function tabBar(current, count) {
  return `<nav class="tabs" aria-label="Sections"><a href="/web?thread"${current === "chat" ? ` aria-current="page"` : ""}>Chat</a>`
    + `<a href="/web?tab=ongoing"${current === "ongoing" ? ` aria-current="page"` : ""}>Ongoing${count ? `<span class="n" aria-label="${count} ${count === 1 ? "thing" : "things"}">${count}</span>` : ""}</a>`
    + `<a href="/web/saved"${current === "saved" ? ` aria-current="page"` : ""}>Saved</a></nav>`;
}

/** The one-line composer. `sendId` makes even a no-script post one turn however often it is resent. */
// `+` and the mic (composer 01–04, Listening) are drawn and run by src/pages/webcompose.js.
function composer({ csrf, sendId, slot = "", chat = "" }) {
  return composerHtml({ csrf, sendId, maxText: MAX_TEXT, slot, chat });
}

/** How many Ongoing rows show before "See all N →" (owner, 10-26): needs-you first, then soonest due. */
export { OG_TOP } from "./webongoing.js";

/**
 * The Ongoing list: the desktop margin, or (`tab`) the mobile Ongoing tab's body (src/pages/webongoing.js):
 * counts on every heading, each group's top OG_TOP, then "See all N →" to the group's own page (handoff
 * v2, sheet 2). The margin also carries "HIDE →": the page slides it away and the thread takes the
 * width; a thin vertical typed "ONGOING · N" at the right edge brings it back (handoff §3, sheet 3).
 */
function ongoingMargin(items, approvals, { tab = false, back = [] } = {}) {
  return ogMargin({ items, approvals, back }, { tab });
}

/** "pick up from iMessage": the last two texts, quoted, the whole block one link into the thread. */
function pickUp(conversationId, service) {
  const recent = db.messagesBefore(conversationId, { limit: 80 }).filter(r => r.channel !== WEB && String(r.text ?? "").trim());
  const two = recent.slice(-2);
  if (!two.length) return "";
  const last = two[two.length - 1];
  const where = sourceLabel(last.channel, service);
  return `<a class="pick" href="/web?thread" aria-label="Pick up from ${esc(where)}: continue the thread"><span class="pick-h">${hand(`pick up from ${where}`, { tag: "span" })}<span class="dash" aria-hidden="true"></span>`
    + `<span class="lbl">LAST TEXT · <time datetime="${new Date(last.at).toISOString()}">${esc(timeFmt().format(last.at))}</time></span></span>`
    + `<span class="pick-q">${two.map(r => `<span class="${r.role === "user" ? "y" : "r"}">${esc(String(r.text).slice(0, 400))}</span>`).join("")}</span>`
    + `<span class="pick-go">Continue the thread <span aria-hidden="true">→</span></span><span class="pick-n">Same Reason, same thread. What you send here stays on Web.</span></a>`;
}

// ---------------------------------------------------------------- the page's script
// DOM only for anything the person typed (textContent); a line Reason's server drew arrives as `html`
// it made from escaped text, the same markup as the page's own. Same ids, claims and retries as W2.
const CLIENT_JS = `(function(){
var R=window.REASON_WEB,list=document.querySelector('.thread'),onit=document.querySelector('.onit'),form=document.querySelector('.cform'),box=document.getElementById('c-input'),start=document.querySelector('.start'),net=document.querySelector('.netline'),body=document.body;
var mb=document.querySelector('.menu-b'),menu=document.getElementById('menu');
var bar=document.querySelector('.top'),og=document.getElementById('og'),H=document.documentElement;
function stuck(){if(bar)bar.classList.toggle('stuck',window.scrollY>4)}window.addEventListener('scroll',stuck,{passive:true});stuck();
var calm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches,back=document.querySelector('.og-back'),tabN=document.querySelector('.tabs a[href="/web?tab=ongoing"]');
function ogEl(){return document.getElementById('og')}
function keepOff(off){try{if(off)localStorage.setItem('${OG_KEY}','off');else localStorage.removeItem('${OG_KEY}')}catch(e){}}
// Delegated, so a margin redrawn live (below) keeps HIDE working.
document.addEventListener('click',function(e){var o=ogEl(),t=o&&e.target&&e.target.closest?e.target.closest('.og-hide'):null;if(!t||!o.contains(t))return;
keepOff(true);if(calm){H.classList.add('og-off');if(back)back.focus();return}o.classList.add('going');setTimeout(function(){H.classList.add('og-off');o.classList.remove('going');if(back)back.focus()},320)});
if(back)back.onclick=function(e){var o=ogEl();e.preventDefault();keepOff(false);if(o&&!calm)o.classList.add('going');H.classList.remove('og-off');requestAnimationFrame(function(){requestAnimationFrame(function(){if(o)o.classList.remove('going')})});var hb=o&&o.querySelector('.og-hide');if(hb)hb.focus()};
// The margin, the rail's ONGOING · N and the tab's count follow the list live (owner 10-26 D5): asked
// for beside every poll and stream event; the html comes back only when the list really changed.
function ogCount(n){var w=n===1?' thing':' things';if(back){back.setAttribute('aria-label','Show Ongoing'+(n?', '+n+w:''));var s=back.querySelector('span');if(s)s.textContent='ONGOING'+(n?' \\u00b7 '+n:'')}
if(tabN){var b=tabN.querySelector('.n');if(!n){if(b)b.remove()}else{if(!b){b=document.createElement('span');b.className='n';tabN.appendChild(b)}b.textContent=n;b.setAttribute('aria-label',n+w)}}}
var ogBusy=false;function ogLook(){var o=ogEl();if(ogBusy||!o||!R||R.ogv==null||document.hidden)return;ogBusy=true;
fetch('/web/ongoing/state?draw=margin&v='+encodeURIComponent(R.ogv),{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401)throw 0;return r.json()}).then(function(j){if(!j||!j.ok)return;
if(j.html!=null){var o2=ogEl();if(o2&&o2.contains(document.activeElement))return;var t=document.createElement('div');t.innerHTML=j.html;var n=t.firstElementChild;if(!n||!o2)return;o2.replaceWith(n);times(n)}
R.ogv=j.v;ogCount(j.count)}).catch(function(){}).then(function(){ogBusy=false})}
setInterval(ogLook,15000);document.addEventListener('visibilitychange',ogLook);
document.querySelectorAll('form[action="/web/signout"]').forEach(function(f){f.addEventListener('submit',function(){try{Object.keys(sessionStorage).forEach(function(k){if(k.indexOf('reason-web-pending')===0)sessionStorage.removeItem(k)})}catch(x){}})});
if(mb&&menu){var mx=menu.querySelector('.menu-x');function shut(){menu.hidden=true;mb.setAttribute('aria-expanded','false');mb.focus()}mb.onclick=function(){menu.hidden=false;mb.setAttribute('aria-expanded','true');mx.focus()};mx.onclick=shut;document.addEventListener('keydown',function(e){if(menu.hidden)return;if(e.key==='Escape')shut();else if(e.key==='Tab'){var f=menu.querySelectorAll('a,button,input:not([type=hidden])'),a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}})}
document.querySelectorAll('.start-w[hidden]').forEach(function(s){s.hidden=false});
document.querySelectorAll('.ex').forEach(function(b){b.onclick=function(){box.value=b.dataset.text;box.dispatchEvent(new Event('input'));box.focus()}});
var tf=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});function fmt(at){try{return tf.format(new Date(at)).toUpperCase()}catch(e){return''}}
function times(root){(root||document).querySelectorAll('time[datetime]').forEach(function(t){var d=Date.parse(t.dateTime);if(d)t.textContent=fmt(d)})}times();
if(box){box.addEventListener('focus',function(){body.classList.add('typing')});box.addEventListener('blur',function(){body.classList.remove('typing')})}
if(!form)return;
var CQ=R.chat?'&chat='+encodeURIComponent(R.chat):'',KEY='reason-web-pending:'+R.k,waiting=0,until=0,live=false,es=null,lost=0;
function noteLine(t){if(!net)return;if(t){net.textContent=t;net.hidden=false}else net.hidden=true}
function offline(){return navigator.onLine===false}
function near(){return window.innerHeight+window.scrollY>=document.body.scrollHeight-200}
function bottom(){window.scrollTo(0,document.body.scrollHeight)}
function pend(){try{return JSON.parse(sessionStorage.getItem(KEY)||'[]')}catch(e){return[]}}
function keep(a){try{sessionStorage.setItem(KEY,JSON.stringify(a))}catch(e){}}
function forget(cid){keep(pend().filter(function(p){return p.id!==cid}))}
function uid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
function working(on,u){until=on?(u||Date.now()+120000):0;if(onit){if(on&&onit.hidden&&window.reasonInk)reasonInk(onit.querySelector('.hand'),'pen-in');onit.hidden=!on}if(on&&near())bottom()}
setInterval(function(){if(until&&Date.now()>until)working(false)},1000);
// From the arrival, a message moves you into the thread once Reason has it.
if(!list){R.api={uid:uid,post:function(p){p.at=p.at||Date.now();keep(pend().filter(function(x){return x.id!==p.id}).concat([p]));location.href=R.chat?'/web?chat='+R.chat:'/web?thread'},pendingLine:function(){return document.createElement('li')},state:function(li,st){if(st==='failed'&&R.say)R.say("that didn't go. try it again?")}};
form.addEventListener('submit',function(e){e.preventDefault();var t=box.value.trim(),fs=R.takeFiles?R.takeFiles():[];if(!t&&!fs.length)return;var p={id:uid(),text:t};if(fs.length)p.files=fs;R.api.post(p)});return}
var loaded=!R.defer,lastPoll=0,calm2=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function line(m){var li=document.createElement('li');li.className='msg arrive '+(m.role==='user'?'you':'re');li.dataset.id=m.id;li.dataset.at=m.at;li.dataset.web=m.web?1:0;if(m.cid)li.dataset.cid=m.cid;if(m.day)li.dataset.day=m.day;if(m.where)li.dataset.where=m.where;li.innerHTML=m.html;times(li);return li}
function has(id){return list.querySelector('.msg[data-id="'+id+'"]')||list.querySelector('.done[data-ids~="'+id+'"]')}
function dayCheck(li,m){if(!m.day)return;var p=li.previousElementSibling;while(p&&!p.dataset.day)p=p.previousElementSibling;if(p&&p.dataset.day===m.day)return;var d=document.createElement('li');d.className='day';d.setAttribute('role','separator');d.dataset.day=m.day;if(m.where)d.dataset.where=m.where;var l=document.createElement('p');l.className='lbl';l.textContent=m.dayLabel||'';d.appendChild(l);li.parentNode.insertBefore(d,li)}
function add(m){if(has(m.id))return;unempty();var stick=near(),li=line(m);
if(m.cid){var p=list.querySelector('.msg[data-pending="'+m.cid+'"]');if(p){p.replaceWith(li);dayCheck(li,m);forget(m.cid);li.classList.add('just');var s=document.createElement('p');s.className='st';s.textContent='SENT \\u00b7 '+fmt(m.at);li.appendChild(s);setTimeout(function(){s.classList.add('fade');setTimeout(function(){s.remove();li.classList.remove('just')},1100)},1200);if(stick)bottom();where();return}}
var after=null;list.querySelectorAll('.msg[data-id]').forEach(function(o){var a=Number(o.dataset.at),i=Number(o.dataset.id);if(a<m.at||(a===m.at&&i<m.id))after=o});
var fp=list.querySelector('.msg[data-pending]');
if(after&&after.nextSibling&&!(fp&&after.nextSibling===fp))list.insertBefore(li,after.nextSibling);else if(fp&&(!after||after.nextSibling===fp))list.insertBefore(li,fp);else if(after)list.appendChild(li);else list.insertBefore(li,list.firstChild);
dayCheck(li,m);
if(m.id>R.last)R.last=m.id;if(m.role==='assistant'){waiting=Math.max(0,waiting-1);if(!waiting)working(false)}if(stick)bottom();where()}
function unempty(){var e=document.querySelector('.convo>.empty');if(e)e.remove()}
function pendingLine(p){unempty();var li=document.createElement('li');li.className='msg you arrive';li.dataset.pending=p.id;if(p.files&&p.files.length&&R.drawFiles)R.drawFiles(li,p);else{var s=document.createElement('div');s.className='said';s.textContent=p.text;li.appendChild(s)}list.appendChild(li);bottom();return li}
function stored(li){return pend().filter(function(x){return x.id===li.dataset.pending})[0]||{id:li.dataset.pending,text:(li.querySelector('.said')||{}).textContent||''}}
function state(li,st){if(!li)return;li.dataset.state=st;li.querySelectorAll('.st,.retry').forEach(function(x){x.remove()});
if(st==='failed'||st==='waiting')li.querySelectorAll('.tb').forEach(function(x){x.remove()});
if((st==='sending'&&!li.querySelector('.tb'))||st==='waiting'){var s=document.createElement('p');s.className='st';s.textContent=st==='sending'?'SENDING\\u2026':'WAITING TO SEND';li.appendChild(s)}
else if(st==='failed'){var b=document.createElement('button');b.type='button';b.className='retry';b.textContent="didn't go. tap to try again.";b.onclick=function(){if(li.retry)return li.retry();send(stored(li),li)};var n=document.createElement('p');n.className='st';n.textContent="IT WON'T SEND TWICE";li.appendChild(b);li.appendChild(n)}}
function expired(){if(!window.reasonMidTask||!window.reasonMidTask(waiting>0||!!until))location.href='/web?out=1'}
function send(p,li,tries){tries=tries||0;if(offline()){state(li,'waiting');return}state(li,'sending');
fetch('/web/send',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json','X-Reason-Csrf':R.c},body:new URLSearchParams({id:p.id,text:p.text,c:R.c,chat:R.chat||'',files:(p.files||[]).map(function(f){return f.id}).filter(Boolean).join(','),voice:p.voice?String(p.voice):''})})
.then(function(r){return r.json().catch(function(){return{ok:false}}).then(function(j){j.status=r.status;return j})})
.then(function(j){if(li.taken)return;if(j.status===401){expired();return}if(j.ok){if(j.duplicate&&li.isConnected&&li.dataset.pending){li.remove();forget(p.id)}if(li.isConnected&&!j.duplicate){state(li,'sent');li.querySelectorAll('.st').forEach(function(x){x.remove()});waiting++;li.counted=1;working(true)}poll()}else if(j.status>=500&&tries<2){setTimeout(function(){send(p,li,tries+1)},1500*(tries+1))}else state(li,'failed')})
.catch(function(){if(li.taken)return;if(offline()){state(li,'waiting');return}if(tries<3)setTimeout(function(){send(p,li,tries+1)},1500*(tries+1));else state(li,'failed')})}
function post(p,li){p.at=p.at||Date.now();keep(pend().filter(function(x){return x.id!==p.id}).concat([p]));var l=li||pendingLine(p);takeBack(l,p);send(p,l)}
// §4h "take it back": for 5 s after a send, and only until Reason starts on it (its own line arrives
// in place of this one), a real button under the message, a pen line draining under it. Tapped, the
// server takes it back if the turn has not taken it (POST /web/send/cancel); too late, it is SENT.
// The send is never held for it: it went at once, and this only races the turn's own start.
var TB=${TAKE_BACK_MS};
function sentAt(li,at){li.querySelectorAll('.tb').forEach(function(x){x.remove()});if(li.dataset.state==='sending'){state(li,'sending');return}if(!li.isConnected||!li.dataset.pending||li.querySelector('.st,.retry'))return;var s=document.createElement('p');s.className='st';s.textContent='SENT \\u00b7 '+fmt(at||Date.now());li.appendChild(s)}
function takeBack(li,p){if(!li||!p.at||offline())return;var left=TB-(Date.now()-p.at);if(left<300)return;
var w=document.createElement('span');w.className='tb';var b=document.createElement('button');b.type='button';b.className='tb-b';b.textContent='take it back';w.appendChild(b);
var l=document.createElement('span');l.className='tb-l';l.setAttribute('aria-hidden','true');l.style.animationDelay=(left-TB)+'ms';w.appendChild(l);li.appendChild(w);
var t=setTimeout(function(){if(li.querySelector('.tb'))sentAt(li,p.at)},left);
b.onclick=function(){if(b.disabled)return;b.disabled=true;clearTimeout(t);
fetch('/web/send/cancel',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json','X-Reason-Csrf':R.c},body:new URLSearchParams({id:p.id,c:R.c})})
.then(function(r){if(r.status===401){expired();throw 0}return r.json()}).then(function(j){if(!j||!j.ok){sentAt(li,p.at);return}
li.taken=true;forget(p.id);delete li.dataset.pending;li.removeAttribute('data-state');li.textContent='';var g=document.createElement('p');g.className='hand tb-gone';g.setAttribute('role','status');g.textContent='taken back. nothing sent.';li.appendChild(g);
if(li.counted&&waiting){waiting--;if(!waiting)working(false)}setTimeout(function(){li.remove()},2000)}).catch(function(){sentAt(li,p.at)})}}
R.api={uid:uid,post:post,pendingLine:pendingLine,state:state};
// Which Web chat this tab is in, for an Ongoing detail opened from it (src/pages/webongoing.js); the shared thread clears it.
try{if(R.chat)sessionStorage.setItem('reason-web-chat',R.chat);else sessionStorage.removeItem('reason-web-chat')}catch(x){}
// An Ongoing detail's "… in the chat →": Reason speaks first about that row. The click id rides with it, so a
// refresh before this line ran or a second tap is the same message (the server's claim), never two.
if(R.ab&&R.ak){try{history.replaceState(null,'',R.chat?'/web?chat='+encodeURIComponent(R.chat):'/web?thread')}catch(x){}
fetch('/web/about',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json','X-Reason-Csrf':R.c},body:new URLSearchParams({about:R.ab,k:R.ak,c:R.c,chat:R.chat||''})}).then(function(r){return r.json()}).then(function(j){if(j&&j.ok&&!j.duplicate){waiting++;working(true)}poll()}).catch(function(){})}
// Whatever this tab had not yet seen sent when it was opened (a reload mid-send, or a message from the
// arrival) is shown at once and sent again under the SAME id once the thread is here, which the
// server's claim turns into nothing if it already arrived.
var carried=pend().map(function(p){return{p:p,li:pendingLine(p)}});
form.addEventListener('submit',function(e){e.preventDefault();var t=box.value.replace(/\\s+$/,''),fs=R.takeFiles?R.takeFiles():[];if(!t.trim()&&!fs.length)return;var p={id:uid(),text:t.trim()?t:''};if(fs.length)p.files=fs;box.value='';box.dispatchEvent(new Event('input'));post(p)});
window.addEventListener('offline',function(){noteLine("you're offline. i'll send it when you're back.")});
window.addEventListener('online',function(){noteLine('');list.querySelectorAll('.msg[data-state=waiting]').forEach(function(li){if(li.retry)return li.retry();send(stored(li),li)});poll()});
if(offline())noteLine("you're offline. i'll send it when you're back.");
// L10: what Reason is still working on at length, from the server's own record of the task.
function workIs(w){var lw=document.querySelector('.longwork');if(!lw)return;if(!w){lw.hidden=true;return}lw.dataset.task=w.taskId;lw.querySelector('.lw-line').textContent=w.line;lw.querySelector('.lw-note').textContent=w.note;if(lw.hidden){if(loaded&&window.reasonInk)reasonInk(lw.querySelector('.lw-line'),'pen-in');lw.hidden=false;if(near())bottom()}}
// S3: a task that finished while this page was open settles in place: its lines become one DONE line.
function tidyDays(){list.querySelectorAll('li.day').forEach(function(d){var n=d.nextElementSibling;if(!n||n.classList.contains('day'))d.remove()})}
function settleIn(a){(a||[]).forEach(function(s){var was=list.querySelector('.done[data-task="'+s.task+'"]');if(was&&was.dataset.ids===s.ids.join(' '))return;var at=list.querySelector('.msg:not(.done)[data-id="'+s.ids[s.ids.length-1]+'"]')||was;if(!at)return;if(was&&at!==was)was.remove();var t=document.createElement('ol');t.innerHTML=s.html;var li=t.firstElementChild;if(!li)return;times(li);at.replaceWith(li);if(!was&&window.reasonInk){reasonInk(li.querySelector('.dl-st'),'stamp-in');reasonInk(li.querySelector('.dl-fresh'),'pen-in')}s.ids.forEach(function(id){var o=list.querySelector('.msg:not(.done)[data-id="'+id+'"]');if(o)o.remove()});doneInit(li.parentNode)});tidyDays();where()}
var polling=false;function poll(){if(polling||!loaded)return;polling=true;lastPoll=Date.now();fetch('/web/history?after='+R.last+CQ,{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){expired();throw 0}return r.json()}).then(function(j){(j.messages||[]).forEach(add);settleIn(j.settled);ogLook();if('work' in j)workIs(j.work);if(R.doing)R.doing(j.doing);if(lost){lost=0;if(!offline())noteLine('')}}).catch(function(e){if(e!==0&&!offline()){lost++;if(lost>1)noteLine("lost the line for a sec. nothing's lost.")}}).then(function(){polling=false})}
var beat=0;setInterval(function(){if(!live||Date.now()-beat>40000)poll()},4000);
function stream(){if(!window.EventSource)return;try{es=R.stream.indexOf('http')===0?new EventSource(R.stream+'?after='+R.last+(R.chat?'&chat='+encodeURIComponent(R.chat):''),{withCredentials:true}):new EventSource(R.stream+'?after='+R.last+(R.chat?'&chat='+encodeURIComponent(R.chat):''))}catch(x){return}es.onopen=function(){live=true;beat=Date.now();if(lost){lost=0;noteLine('')}};
es.addEventListener('ping',function(){beat=Date.now()});
es.addEventListener('message',function(e){beat=Date.now();try{add(JSON.parse(e.data))}catch(x){}ogLook()});
es.addEventListener('typing',function(e){try{var t=JSON.parse(e.data);working(t.on,t.until);if(R.doing)R.doing(t.on?t.doing:null)}catch(x){}ogLook()});
es.addEventListener('doing',function(e){try{if(R.doing)R.doing(JSON.parse(e.data).doing)}catch(x){}});
es.addEventListener('state',function(e){beat=Date.now();try{var j=JSON.parse(e.data);settleIn(j.settled);workIs(j.work)}catch(x){}ogLook()});
es.addEventListener('signedout',function(){es.close();expired()});
es.onerror=function(){live=false}}
document.addEventListener('visibilitychange',function(){if(!document.hidden)poll()});
// L2: ↑ FINDING EARLIER MESSAGES… where the button was, a ghost above the day it lands on; the page
// stays where it is while the earlier day arrives above it.
var loading=false;function older(){if(loading||!R.more)return;loading=true;start.innerHTML=R.finding;start.classList.add('finding');var a=list.querySelector('.msg'),top=a?a.getBoundingClientRect().top:0;
fetch('/web/history?before='+R.first+(R.chat?'&chat='+encodeURIComponent(R.chat):''),{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){expired();throw 0}return r.json()}).then(function(j){var t=document.createElement('ol');t.innerHTML=j.html||'';
var fd=list.firstElementChild;if(fd&&fd.classList.contains('day')&&t.querySelector('li.day[data-day="'+fd.dataset.day+'"]'))fd.remove();
t.querySelectorAll('.msg[data-id]').forEach(function(li){if(has(li.dataset.id))li.remove()});
var anchor=list.firstChild;times(t);while(t.firstChild)list.insertBefore(t.firstChild,anchor);tidyDays();doneInit();
if(j.first)R.first=j.first;R.more=!!j.more;start.classList.remove('finding');start.textContent='';if(!R.more&&j.start){var s=document.createElement('p');s.className='lbl';s.textContent=j.start;start.appendChild(s)}
if(a)window.scrollBy(0,a.getBoundingClientRect().top-top);where()}).catch(function(){}).then(function(){loading=false;start.classList.remove('finding');if(R.more)hook()})}
function hook(){start.textContent='';var b=document.createElement('button');b.type='button';b.className='act2';b.textContent='\\u2191 SHOW EARLIER MESSAGES';b.onclick=older;start.appendChild(b)}
// S2: the "where you are" note names the day and device of what is at the top of the screen. A day
// is current once it passes 90px under the top bar; at the very bottom it is the latest. Two slots
// crossfade (none under reduced motion). Scrolled back into an earlier day, TODAY ↓ shows inside the
// composer line and the placeholder says "Reply from here".
var wn=document.querySelector('.where'),ws=wn?wn.querySelectorAll('.wn-s'):[],wnow=wn?wn.querySelector('.wn-now'):null,cur=null,tb=document.querySelector('.today');
function note(t){if(t===cur)return;var on=wn.querySelector('.wn-s.on')||ws[0];if(cur===null){on.textContent=t;on.classList.add('on')}else{var off=on===ws[0]?ws[1]:ws[0];off.textContent=t;on.classList.remove('on');off.classList.add('on')}cur=t;wn.setAttribute('aria-label',t);if(wnow)wnow.textContent=t}
function backTo(on){if(!tb)return;tb.hidden=!on;if(box&&R.ph)box.placeholder=on?R.ph.back:R.ph.rest}
function where(){if(!wn||!loaded)return;var ms=list.querySelectorAll('li[data-where]');if(!ms.length){wn.hidden=true;backTo(false);return}wn.hidden=false;
var line=(bar?bar.getBoundingClientRect().bottom:0)+90,end=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-40,pick=ms[0];
if(end)pick=ms[ms.length-1];else for(var i=0;i<ms.length;i++){if(ms[i].getBoundingClientRect().top<=line)pick=ms[i];else break}
note(pick.dataset.where);backTo(!end&&pick.dataset.day!==ms[ms.length-1].dataset.day)}
var ticking=false;window.addEventListener('scroll',function(){if(ticking)return;ticking=true;requestAnimationFrame(function(){ticking=false;where()})},{passive:true});window.addEventListener('resize',where);
if(tb)tb.onclick=function(){window.scrollTo({top:document.documentElement.scrollHeight,behavior:calm2?'auto':'smooth'})};
// S3: a DONE line opens and folds its messages; the Caveat line under a just-finished one goes once it has been opened (remembered here).
var OPK='reason-web-opened';function opened(){try{return JSON.parse(localStorage.getItem(OPK)||'[]')}catch(e){return[]}}
function doneInit(root){var o=opened();(root||list).querySelectorAll('.done[data-fresh]').forEach(function(li){if(o.indexOf(li.dataset.task)>=0){var f=li.querySelector('.dl-fresh');if(f)f.remove()}})}
list.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.dl');if(!b||!list.contains(b))return;var li=b.parentNode,open=li.classList.toggle('open');b.setAttribute('aria-expanded',open?'true':'false');b.querySelector('.dl-n').textContent=open?'FOLD ↑':li.dataset.n+' ↓';
if(open){var f=li.querySelector('.dl-fresh');if(f)f.remove();try{var o=opened();if(o.indexOf(li.dataset.task)<0){o.push(li.dataset.task);localStorage.setItem(OPK,JSON.stringify(o.slice(-50)))}}catch(x){}}where()});
// §4h "while you were out": the server's one line for this return, put under TODAY (or a TODAY of its own at the end).
function awayIn(){var a=R.away;R.away=null;if(!a||list.querySelector('li.away'))return;var li=document.createElement('li');li.className='away';var p=document.createElement('p');p.className='hand';p.textContent=a.text;li.appendChild(p);
var d=list.querySelector('li.day[data-day="'+a.day+'"]');if(d){d.parentNode.insertBefore(li,d.nextSibling);return}
d=document.createElement('li');d.className='day';d.setAttribute('role','separator');d.dataset.day=a.day;var l=document.createElement('p');l.className='lbl';l.textContent='TODAY';d.appendChild(l);list.appendChild(d);list.appendChild(li)}
function ready(){loaded=true;times(list);doneInit();awayIn();
carried.forEach(function(c){if(list.querySelector('.msg[data-cid="'+c.p.id+'"]')){c.li.remove();forget(c.p.id);return}takeBack(c.li,c.p);send(c.p,c.li)});
stream();if(R.more)hook();bottom();where()}
// L1: the thread opens with its composer and tabs already live; the newest page comes from the server.
// Slow (over 8 s) or failed, it says so in the same place, with a way to try again.
function opening(){var l1=document.querySelector('.l1');function slow(){if(!l1)return;var s=l1.querySelector('[role=status]');if(s)s.textContent='STILL LOOKING…';l1.querySelector('.l1-slow').hidden=false;l1.querySelector('.l1-again').hidden=false}var tm=setTimeout(slow,8000);
fetch('/web/history'+(R.chat?'?chat='+encodeURIComponent(R.chat):''),{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){expired();throw 0}if(!r.ok)throw 1;return r.json()}).then(function(j){clearTimeout(tm);var t=document.createElement('ol');t.innerHTML=j.html||'';t.querySelectorAll('.msg[data-id]').forEach(function(li){if(has(li.dataset.id))li.remove()});
t.querySelectorAll('.msg[data-cid]').forEach(function(li){var p=list.querySelector('.msg[data-pending="'+li.dataset.cid+'"]');if(p){p.remove();forget(li.dataset.cid)}});
var anchor=list.firstChild;while(t.firstChild)list.insertBefore(t.firstChild,anchor);
R.first=j.first||0;R.last=Math.max(R.last,j.last||0);R.more=!!j.more;if(l1)l1.remove();list.removeAttribute('aria-busy');
start.textContent='';if(!R.more&&j.start){var s=document.createElement('p');s.className='lbl';s.textContent=j.start;start.appendChild(s)}
if('work' in j)workIs(j.work);ready()}).catch(function(e){if(e!==0){clearTimeout(tm);slow()}})}
if(R.defer)opening();else ready();
})();`;

const json = (status, obj, extra = {}) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body), ...extra }, body };
};

/** Where the page listens for new lines: the pages host when it qualifies (src/web.js), else here. */
export function streamPath() {
  const origin = webStreamOrigin();
  return origin ? `${origin}/web/live` : "/web/stream";
}

function boot({ csrf, lines = [], more = false, conversationId = "", deferred = false, og = "", chat = "", about = null, away = null }) {
  // `k` keys this tab's unsent messages to ONE conversation (and one Web chat): a tab later signed in as somebody else never resends them.
  const k = createHash("sha256").update(`pending:${conversationId}${chat ? `#${chat}` : ""}`).digest("base64url").slice(0, 12);
  // A deferred page (L1) learns first/last from its first /web/history; until then it polls nothing.
  const first = deferred ? 0 : lines[0]?.id ?? 0, last = deferred ? 0 : lines.reduce((n, m) => Math.max(n, m.id), 0);
  return `window.REASON_WEB={c:${JSON.stringify(String(csrf ?? ""))},first:${Number(first)},last:${Number(last)},more:${more ? "true" : "false"},k:${JSON.stringify(k)},stream:${JSON.stringify(streamPath())},defer:${deferred ? "true" : "false"},ph:${JSON.stringify(PLACEHOLDER)},finding:${JSON.stringify(FINDING)},ogv:${JSON.stringify(String(og))},chat:${JSON.stringify(String(chat))},ab:${JSON.stringify(about?.key ?? "")},ak:${JSON.stringify(about?.k ?? "")},away:${away ? JSON.stringify(away).replace(/</g, "\\u003c") : "null"}};`;
}

const NET = `<p class="netline" role="status" hidden></p>`;

/**
 * §4h "while you were out": "while you were out: 2 done, 1 needs you." Parts that are zero are left
 * out; nothing at all is no line (null).
 */
export function awayWords({ done = 0, needs = 0 } = {}) {
  const parts = [];
  if (done > 0) parts.push(`${done} done`);
  if (needs > 0) parts.push(`${needs} ${needs === 1 ? "needs" : "need"} you`);
  return parts.length ? `while you were out: ${parts.join(", ")}.` : null;
}

/**
 * The line for one return (`{ from, to }`, db.takeWebAway), counted from the same rows Ongoing and
 * the DONE lines are drawn from (src/ongoing.js): tasks that finished done in that time, and what
 * started needing them in it and still does (a task's question, an approval). Null for no return
 * or nothing changed.
 */
export function awayFor(conversationId, ret, held = null) {
  if (!ret) return null;
  const { items, approvals, back } = held ?? ongoing(conversationId);
  const within = (t) => Number.isFinite(t) && t > ret.from && t <= ret.to;
  const done = back.filter(x => x.state === "ready" && within(x.task?.finished_at)).length;
  const needs = items.filter(x => x.needs && within(x.asked)).length + approvals.filter(a => within(a.at)).length;
  return awayWords({ done, needs });
}

/** The line as the thread draws it: one Caveat line in pen, under TODAY. */
export const awayHtml = (text) => `<li class="away"><p class="hand">${esc(text)}</p></li>`;

/** A drawn page with the line put under its TODAY label, or a TODAY label of its own at the end when today has no lines yet. */
export function withAway(html, away, now = clock.now()) {
  if (!away) return html;
  const day = dayKey(now);
  const at = new RegExp(`<li class="day" role="separator" data-day="${day}"[^>]*>.*?</li>`).exec(html);
  if (at) return html.slice(0, at.index + at[0].length) + awayHtml(away) + html.slice(at.index + at[0].length);
  return `${html}<li class="day" role="separator" data-day="${day}">${label("TODAY")}</li>${awayHtml(away)}`;
}

/**
 * The thread. `firstVisit` draws 5C in its place (once); `approvals` the one loud thing at the foot.
 */
export function renderConversation({ account, csrf, lines, more, firstVisit = false, sendId, items = [], approvals = [], back = [], now = clock.now(), found = null, deferred = false, work = null, chat = "", about = null, away = null }) {
  if (firstVisit) return renderFirstVisit({ account });
  const conv = account?.conversation_id ?? "";
  const service = serviceOf(conv);
  // A Web-only chat (owner 10-27) starts here: nothing before it lives in the texts.
  const startLine = more
    ? `<button class="act2" type="button">↑ SHOW EARLIER MESSAGES</button>`
    : lines.length && !chat ? label(`Your conversation before ${dayFmt().format(lines[0].at)} stays in your texts.`) : "";
  // SR4: a label is always who · where · when; what the card is waiting for is said inside the card.
  const asked = approvals[0]?.at ?? approvals[0]?.asked_at ?? null;
  const askedIn = asked ? [...lines].reverse().find(m => m.role === "assistant" && m.at <= asked + 60_000) : null;
  const apprLbl = `REASON · ${(askedIn?.source ?? sourceLabel(null, service)).toUpperCase()} · ${timeFmt().format(asked ?? askedIn?.at ?? now)}`;
  // A Web-only chat is only that exchange: a pending approval stays in Ongoing (the margin, the tab's count), not in its lines.
  const appr = approvals.length && !chat ? `<div class="msg re approval">${label(apprLbl)}${approvalCard({ title: approvals[0].title, money: approvals[0].money, href: approvals[0].href })}</div>` : "";
  const count = items.length + approvals.length + back.length;
  const drawn = withAway(pageHtml(lines, { conversationId: conv, service, now, keep: found, chat }), away, now);
  // L1: with script, the page opens with its composer and tabs live and the thread's place held by
  // ruled lines; the newest page arrives from /web/history. Without script it is all here at once.
  const thread = deferred
    ? `${OPENING}<ol class="thread" role="log" aria-live="polite" aria-relevant="additions" aria-busy="true"></ol>`
      + `<noscript><div class="start">${startLine}</div><ol class="thread" role="log">${drawn}</ol></noscript>`
    : `<div class="start">${startLine}</div><ol class="thread" role="log" aria-live="polite" aria-relevant="additions">${drawn}</ol>`;
  const body = topBar({ csrf, where: WHERE_NOTE }) + NET
    + `<main class="wrapc"><section class="convo" aria-labelledby="c-h"><h1 id="c-h" class="sr">Your conversation with Reason</h1>`
    + (deferred ? `<div class="start"></div>` : "") + thread
    + (lines.length || chat ? "" : `<div class="empty">${hand("nothing here yet. whatever you tell me here or by text shows up in this thread.", { tilt: true })}</div>`)
    + appr + onIt(true) + longWorkHtml(work)
    + (chat ? "" : needsYes(approvals))
    + composer({ csrf, sendId, slot: TODAY_SLOT, chat })
    + `</section>${ongoingMargin(items, approvals, { back })}</main>`
    + `<button class="og-back" type="button" aria-controls="og" aria-expanded="false" aria-label="Show Ongoing${count ? `, ${count} ${count === 1 ? "thing" : "things"}` : ""}"><span aria-hidden="true">ONGOING${count ? ` · ${count}` : ""}</span></button>`
    + tabBar("chat", count) + listeningHtml();
  // Saved's FIND IT IN THE CHAT → (src/pages/websaved.js): the thread opened at that message, scrolled to it.
  const toFound = found ? `(function(){var e=document.getElementById('m-${Number(found)}');if(e)e.scrollIntoView({block:'center'})})();` : "";
  return webPage({ title: "Reason", body, css: CSS + COMPOSE_CSS, script: boot({ csrf, lines, more, conversationId: conv, deferred, og: ogVersion(ogMargin({ items, approvals, back })), chat, about, away: away ? { text: away, day: dayKey(now) } : null }) + composeBoot() + NINE_D_JS + CLIENT_JS + COMPOSE_JS + toFound, bodyClass: "has-tabs", loader: !found });
}

/** S2: the "where you are" note, two slots that crossfade. Filled and shown by the page's script. */
export const WHERE_NOTE = `<span class="where" role="status" aria-live="polite" hidden><span class="wn-s on" aria-hidden="true"></span><span class="wn-s" aria-hidden="true"></span><span class="sr wn-now"></span></span>`;
/** S2: back to today, inside the composer line (src/pages/webcompose.js `slot`), never over the thread. */
export const TODAY_SLOT = `<button class="today" type="button" hidden>TODAY <span aria-hidden="true">↓</span></button>`;
/** The composer's words at rest, and while scrolled back into an earlier day. */
export const PLACEHOLDER = { rest: "Tell Reason what you need", back: "Reply from here" };

const ghost = (side, widths) => `<div class="gh gh-${side}" aria-hidden="true"><span class="gh-l"></span><span class="gh-w">${widths.map(w => `<span style="width:${w}%"></span>`).join("")}</span></div>`;
/** L1, sheet "Loading · app screens": OPENING YOUR THREAD… and ghost messages, yours right, Reason's left. */
const OPENING = `<div class="l1"><p class="lbl" role="status">OPENING YOUR THREAD…</p><div class="l1-sp"></div>${ghost("re", [80, 55])}${ghost("you", [60])}${ghost("re", [75, 70, 30])}<p class="hand l1-slow" hidden>taking a little longer than usual. still here.</p><a class="act l1-again" href="/web?thread" hidden>Try again <span aria-hidden="true">→</span></a></div>`;
/** L2: ↑ FINDING EARLIER MESSAGES… with a ghost above the day it will land on. Drawn by the page's script. */
export const FINDING = `<p class="lbl" role="status">↑ FINDING EARLIER MESSAGES…</p>${ghost("re", [70, 40])}<div class="l2-rule" aria-hidden="true"></div>`;

/** L10's state for this conversation, with the honest line it carries (src/settle.js longWork), or null. */
export function workOf(conversationId) {
  const w = settle.longWork(conversationId);
  return w ? { ...w, note: w.texted ? settle.LONG_NOTE : settle.LONG_NOTE_WEB } : null;
}

/** L10, sheet "Loading · actions": "on it." with what it's doing, and the honest line. Null work draws a hidden block. */
export function longWorkHtml(work) {
  const note = work?.note ?? "";
  return `<div class="longwork"${work ? ` data-task="${work.taskId}"` : " hidden"}><div class="lw-on" role="status"><span class="ring">${bubble(4)}</span><span class="hand lw-line">${esc(work?.line ?? "on it.")}</span></div><p class="lw-note">${esc(note)}</p></div>`;
}

/** B / B2, the arrival: the greeting, the composer, then what's in hand or where to start, then iMessage. */
export function renderHome({ account, csrf, sendId, items = [], approvals = [], back = [], pick = "", chat = newWebChatId() }) {
  const name = String(account?.name ?? "").trim();
  // The approval stays on paper; what's already in hand is quiet rows between dashed rules, as on Ongoing (STAGING-REVIEW 7).
  const middle = items.length
    ? `<section class="inhand" aria-label="Already in hand">${label("ALREADY IN HAND")}${homeRows(items)}</section>`
    : `<section class="start-w" aria-label="You could start with" hidden>${label("YOU COULD START WITH")}${EXAMPLES.map(t => `<button class="ex" type="button" data-text="${esc(t)}">"${esc(t)}"</button>`).join("")}</section>`;
  const body = topBar({ csrf, extra: typed("THE THREAD →", { href: "/web?thread" }) }) + NET
    + `<main class="home"><h1 class="greet">${esc(greeting(name))}</h1>`
    // Home's composer starts a fresh Web-only chat (owner 10-27); "Continue the thread →", the Chat
    // tab and "The thread" still open the one shared conversation.
    + composer({ csrf, sendId, chat })
    + (approvals.length ? `<section class="approval" aria-label="Needs you">${approvalCard({ title: approvals[0].title, money: approvals[0].money, href: approvals[0].href })}</section>` : "")
    + middle + pick + `</main>`
    + tabBar("chat", items.length + approvals.length + back.length) + listeningHtml();
  return webPage({ title: "Reason", body, css: CSS + COMPOSE_CSS, script: boot({ csrf, conversationId: account?.conversation_id, chat }) + composeBoot() + NINE_D_JS + CLIENT_JS + COMPOSE_JS, bodyClass: "has-tabs", loader: true });
}

const ABOUT_RE = /^(task|timer|series|approval):(\d{1,15})$/;
const CLICK_RE = /^[A-Za-z0-9_-]{16,40}$/;
/** `?about=<kind>:<id>&k=<click id>` from a detail's chat link, or null. Only the shape is read here; the row is looked up on the POST. */
const aboutOf = (query) => (ABOUT_RE.test(String(query.about ?? "")) && CLICK_RE.test(String(query.k ?? "")) ? { key: String(query.about), k: String(query.k) } : null);

/** A new Web chat's id, minted by the page that may start it (claimed by its first send). */
export const newWebChatId = () => randomBytes(16).toString("base64url");
/**
 * The Web chat a request names (`?chat=` or the form's `chat`): "" for the shared thread, the id
 * for one of THIS conversation's chats (or one not claimed yet), null for anything else — another
 * account's chat or a malformed id, which every caller answers as not found.
 */
export function chatFrom(conv, raw) {
  const v = String(raw ?? "");
  if (!v) return "";
  if (!db.WEB_CHAT_RE.test(v)) return null;
  const owner = db.webChatOwner(v);
  return owner && owner !== conv ? null : v;
}

/** 5C, shown once: the same Reason, and what stays where. */
export function renderFirstVisit() {
  const body = `<header class="top">${wordmark({ href: "/web?home" })}</header><main class="solo" aria-labelledby="fv-h">`
    + `<h1 id="fv-h" class="h1">${esc(BOUNDARY.title)}<br><em>${esc(BOUNDARY.titleEm)}</em></h1>`
    + `<p class="body">${esc(BOUNDARY.body)}</p>${hand(BOUNDARY.note, { tilt: true })}${action("Got it", { href: "/web?home" })}</main>`;
  return webPage({ title: "Reason", body, css: CSS });
}

/** The mobile Ongoing tab. Real rows when Reason holds anything; otherwise "Nothing left to chase." Kept current live (OG_TAB_LIVE_JS). */
export function renderOngoing({ csrf, items = [], approvals = [], back = [] }) {
  const count = items.length + approvals.length + back.length;
  const inner = ogTabMain({ items, approvals, back });
  const css = `${CSS}.og-tab{display:flex;position:static;max-width:none;padding:0}`;
  const live = `window.REASON_OG={v:${JSON.stringify(ogVersion(inner))}};`;
  return webPage({ title: "Reason — Ongoing", body: topBar({ csrf }) + inner + tabBar("ongoing", count), css, script: live + NINE_D_JS + OG_POLL_JS + CLIENT_JS + OG_TAB_LIVE_JS, bodyClass: "has-tabs" });
}

/** MEMORY and SETTINGS before their phases: a calm page in the same voice, with the two settings that already work. */
export function soonPage({ which, account, headers }) {
  const csrf = db.pageSessionCsrf(readCookie(headers?.cookie));
  const memory = which === "memory";
  const body = topBar({ csrf }) + `<main class="solo soon" aria-labelledby="soon-h">`
    + label(memory ? "MEMORY" : "SETTINGS")
    + `<h1 id="soon-h" class="h1">${memory ? "What Reason <em>remembers</em>" : "Settings"}</h1>`
    + `<p class="quiet">${memory ? "Seeing, correcting and forgetting what Reason knows about you is coming to this page." : "Choosing how Reason reaches you, your browsers and your invites are coming to this page."}</p>`
    + hand(memory ? "until then, just ask me in the chat what i remember." : "until then, just ask me in the chat.", { tilt: true })
    + (memory ? "" : `<hr class="rule">${label("THEME")}${themeSwitch("th-set")}<hr class="rule">${signOutForm(csrf)}`)
    + action("Back to the thread", { href: "/web?thread" })
    + `</main>`;
  void account;
  return webPage({ title: memory ? "Reason — Memory" : "Reason — Settings", body, css: CSS, script: CLIENT_JS });
}

/** 9B: something went wrong. Nothing was lost. Drawn by src/http.js when a Web request throws. */
export function renderError() {
  const body = `<header class="top">${wordmark({ href: "/web?home" })}</header><main class="solo" aria-labelledby="er-h">`
    + `<h1 id="er-h" class="h1">Something went wrong.<br><em>Nothing was lost.</em></h1>`
    + `<p class="quiet">Your messages and anything I'm working on are safe.</p>${action("Try again", { href: "/web" })}</main>`;
  return webPage({ title: "Reason", body, css: CSS });
}

/**
 * GET /web signed in. `view`: the thread (?thread), the Ongoing tab (?tab=ongoing), or — by default —
 * the arrival, unless they sent something on Web in the last half hour (then the thread they're in).
 * ?home is always the arrival: where sign-in (and 5C's "Got it") lands, whatever was sent lately.
 * The first real view ever is 5C instead, once.
 */
export function conversationPage({ account, headers, sendId, method = "GET", query = {}, now = clock.now() }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const csrf = db.pageSessionCsrf(readCookie(headers.cookie));
  // Spent only by a real view (GET); a HEAD carries no body to show it in.
  if (method === "GET" && db.markWebNoticeSeen(conv)) return renderFirstVisit({ account });
  const { items, approvals, back } = ongoing(conv, now);
  if (query.tab === "ongoing") return renderOngoing({ csrf, items, approvals, back });
  // ?chat=<id>: one Web-only chat, only its own lines (owner 10-27). Somebody else's is E1.
  if (query.chat != null) {
    const chat = chatFrom(conv, query.chat);
    if (!chat) return { status: 404, body: renderWebNotFound({ signedIn: true }) };
    return renderConversation({ account, csrf, lines: [], more: false, sendId, items, approvals, back, now, deferred: true, work: workOf(conv), chat, about: aboutOf(query) });
  }
  // ?at=<id> (Saved's FIND IT IN THE CHAT →): the thread around one of this conversation's own messages, drawn at once (no L1).
  const at = /^\d{1,15}$/.test(String(query.at ?? "")) ? Number(query.at) : null;
  const from = at ? db.messagesFor(conv, { after: at - 1, limit: PAGE }) : [];
  const found = from[0]?.id === at ? at : null;
  const rows = found ? [...db.messagesBefore(conv, { before: found, limit: 11 }), ...from] : db.messagesBefore(conv, { limit: PAGE + 1 });
  const more = found ? rows.length - from.length > 10 : rows.length > PAGE;
  const lines = (more ? rows.slice(1) : rows).map(r => rowOut(r, { conversationId: conv, service, now }));
  if (found) return renderConversation({ account, csrf, lines, more, sendId, items, approvals, back, now, found, work: workOf(conv) });
  const recentWeb = query.home == null && lines.some(m => m.web && m.role === "user" && now - m.at < THREAD_RECENT_MS);
  // ?about=<kind>:<id>&k=<click> (an Ongoing detail's "… in the chat →"): the thread, whose script asks
  // Reason to speak first about that row (POST /web/about, aboutRequest below).
  const about = aboutOf(query);
  if (query.thread != null || recentWeb || about) {
    // §4h: the return this browser has not been shown, spent now (a GET only): once per return.
    const away = method === "GET" ? awayFor(conv, db.takeWebAway(readCookie(headers.cookie), conv, { within: WEB_AWAY_MS, now }), { items, approvals, back }) : null;
    return renderConversation({ account, csrf, lines, more, sendId, items, approvals, back, now, deferred: true, work: workOf(conv), about, away });
  }
  return renderHome({ account, csrf, sendId, items, approvals, back, pick: pickUp(conv, service) });
}

/**
 * GET /web/history?before=<id> (older page) or ?after=<id> (catch-up). Only the session's own
 * conversation is ever read; an id from somebody else's history simply finds nothing.
 */
export function historyRequest({ account, query = {}, now = clock.now() }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  // A Web-only chat's own lines, or the shared thread's (chat_id IS NULL). Another account's chat: 404.
  const chat = chatFrom(conv, query.chat);
  if (chat == null) return json(404, { ok: false, error: "not_found" });
  const num = (v) => (/^\d{1,15}$/.test(String(v ?? "")) ? Number(v) : null);
  if (query.after != null) {
    const after = num(query.after) ?? 0;
    const rows = db.messagesFor(conv, { after, limit: 200, chat });
    // What is still being worked at length (L10), finished tasks to settle in place (S3), and `doing`:
    // what Reason is doing on this conversation's turn right now (src/doing.js), or null.
    return json(200, { messages: rows.map(r => rowOut(r, { conversationId: conv, service, now })), work: workOf(conv), settled: settledLately(conv, { service, now, chat }), doing: doingFor(conv) });
  }
  // A page: the newest (the thread opening, L1) or the one before row `before` (L2). `html` is the
  // page drawn as the thread draws it — day labels, "Continued on Web", finished tasks settled.
  const before = num(query.before);
  const rows = db.messagesBefore(conv, { before, limit: PAGE + 1, chat });
  const more = rows.length > PAGE;
  const lines = (more ? rows.slice(1) : rows).map(r => rowOut(r, { conversationId: conv, service, now }));
  const start = !more && lines.length && !chat ? `Your conversation before ${dayFmt().format(lines[0].at)} stays in your texts.` : null;
  const html = pageHtml(lines, { conversationId: conv, service, now, chat });
  const first = lines[0]?.id ?? 0, last = lines.reduce((n, m) => Math.max(n, m.id), 0);
  return json(200, { messages: lines, html, more, start, first, last, ...(before == null ? { work: workOf(conv) } : {}) });
}

/**
 * Tasks that finished in the last few minutes, settled: what a page that showed their messages one by
 * one swaps in (the DONE line, JUST NOW). `ids` are every message folded into it.
 */
export function settledLately(conversationId, { service = serviceOf(conversationId), now = clock.now(), chat = "" } = {}) {
  const done = db.db.prepare("SELECT id FROM tasks WHERE conversation_id = ? AND state = 'done' AND finished_at >= ?").all(conversationId, now - settle.JUST_NOW_MS).map(r => r.id);
  if (!done.length) return [];
  const ids = db.db.prepare(`SELECT DISTINCT m.id FROM task_messages l JOIN messages m ON m.conversation_id = l.conversation_id
      AND ((l.outbox_id IS NOT NULL AND m.outbox_id = l.outbox_id) OR (l.external_id IS NOT NULL AND m.role = 'user' AND m.external_id = l.external_id))
    WHERE l.conversation_id = ? AND l.task_id IN (${done.map(() => "?").join(",")})`).all(conversationId, ...done).map(r => r.id);
  const { folds } = settle.foldsFor(conversationId, ids, { chat });
  return [...folds.values()].filter(f => done.includes(f.task.id))
    .map(f => ({ task: f.task.id, ids: f.rows.map(r => r.id), html: doneHtml(f, { conversationId, service, now }) }));
}

const sends = new Map(); // conversation → recent send times, for SEND_LIMIT
function underLimit(conv, now = clock.now()) {
  const recent = (sends.get(conv) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= SEND_LIMIT) { sends.set(conv, recent); return false; }
  recent.push(now);
  sends.set(conv, recent);
  return true;
}
/** For tests. */
export function resetSendLimits() { sends.clear(); }

/**
 * POST /web/about (owner 10-27 01:20): they tapped an Ongoing detail's "… in the chat →", and Reason
 * speaks first about that row — one turn on the claude-cli path, its record in the prompt, the answer
 * on Web only (the shared thread, or the Web chat it was opened from). Same-origin + the session's
 * secret; the row is looked up in the session's own conversation (anybody else's is a 404). The click
 * id is claimed with the row (db.claimInbound), so a refresh or a double tap posts once.
 */
export async function aboutRequest({ account, headers = {}, readBody, runtime, log = () => {} }) {
  const form = new URLSearchParams((await readBody()) ?? "");
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(readCookie(headers.cookie)))) {
    log({ web_about_refused: "origin_or_token" });
    return json(403, { ok: false, error: "not_from_this_page" });
  }
  const m = ABOUT_RE.exec(String(form.get("about") ?? ""));
  const k = String(form.get("k") ?? "");
  if (!m || !CLICK_RE.test(k)) return json(400, { ok: false, error: "bad_request" });
  const conv = account.conversation_id;
  const chat = chatFrom(conv, form.get("chat"));
  // A chat it speaks in must already be theirs: this never starts one.
  if (chat == null || (chat && db.webChatOwner(chat) !== conv)) return json(404, { ok: false, error: "not_found" });
  const item = findItem(conv, m[1], m[2]);
  if (!item) return json(404, { ok: false, error: "not_found" });
  if (!runtime?.event) return json(503, { ok: false, error: "unavailable" });
  // The limit first, so a slowed-down tap is not spent: the same click can still speak once.
  if (!underLimit(conv)) return json(429, { ok: false, error: "slow_down" });
  if (!db.claimInbound({ channel: WEB, externalId: `${conv}:about:${m[1]}:${m[2]}:${k}`, conversationId: conv })) {
    log({ web_about: "duplicate" });
    return json(200, { ok: true, duplicate: true });
  }
  const { talkWords } = await import("./webongoing.js");
  const text = speakFirstPrompt(itemRecord(conv, item), { link: talkWords(item.state) });
  // The turn runs on server-side whatever happens to the tab; its one message arrives over /web/live.
  // `fromOwner`: it is said to the person themselves, so it is their history (src/deliver.js toOwner) — for every account, not only the operator's.
  Promise.resolve().then(() => runtime.event(conv, text, { channel: WEB, to: account.address, fromOwner: true, ...(chat ? { chatId: db.webChatRoute(chat) } : {}) }))
    .catch((e) => log({ web_about_failed: (e?.message ?? String(e)).split("\n")[0] }));
  log({ web_about: `${m[1]}:${m[2]}` });
  return json(200, { ok: true });
}

/** How long a send waits to hear "refused" or "already had it" before saying "got it" and letting the turn run on. */
export const ACK_WAIT_MS = 1500;
/** Sends still on their way to Router.deliver's claim, `<conversation>:<browser id>`: a take-back that lands first is written down so the claim finds it. */
const inFlight = new Set();
/** How long a take-back for an id not seen yet waits for its send to arrive before it is "not found". */
export const CANCEL_WAIT_MS = 1500;

/**
 * POST /web/send: one message into the person's conversation. Same-origin and the session's own
 * secret (header or form field), a browser-made id, words within the cap. Handed to Router.deliver
 * as a web inbound under the SESSION's conversation; nothing in the body can name another. The
 * answer comes back once Reason has the message (or has refused it); the turn runs on server-side
 * whatever happens to the tab.
 */
export async function sendRequest({ account, headers = {}, readBody, router, log = () => {}, ackWaitMs = ACK_WAIT_MS }) {
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  const form = new URLSearchParams((await readBody()) ?? "");
  // A Web-only chat (Home's composer, owner 10-27): the id the page minted, claimed for THIS
  // conversation by its first send. Malformed, or somebody else's: refused, never answered there.
  const chatRaw = String(form.get("chat") ?? "");
  const back = chatRaw && db.WEB_CHAT_RE.test(chatRaw) ? `/web?chat=${chatRaw}` : "/web?thread";
  const fail = (status, error) => (wantsJson ? json(status, { ok: false, error }) : { status: 303, headers: { ...SECURITY_HEADERS, Location: back, "Content-Length": 0 }, body: "" });
  const token = readCookie(headers.cookie);
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(token))) {
    log({ web_send_refused: "origin_or_token" });
    return wantsJson ? json(403, { ok: false, error: "not_from_this_page" }) : { status: 403, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }, body: "That didn't come from this page." };
  }
  const id = String(form.get("id") ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail(400, "bad_id");
  const text = String(form.get("text") ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  // Photos, PDFs, a voice note: uploads this conversation made (src/webmedia.js), named by id.
  const files = String(form.get("files") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!text.trim() && !files.length) return fail(400, "empty");
  if (text.length > MAX_TEXT) return fail(413, "too_long");
  if (files.length > 6 || files.some(f => !/^[A-Za-z0-9_-]{22}$/.test(f))) return fail(400, "bad_file");
  if (!router) return fail(503, "unavailable");
  const conv = account.conversation_id;
  if (chatRaw && !db.claimWebChat(conv, chatRaw)) { log({ web_send_refused: "chat" }); return fail(404, "not_found"); }
  if (files.length && !(await import("../webuploads.js")).attachmentsFor(conv, files)) return fail(400, "bad_file");
  if (!underLimit(conv)) { log({ web_send_refused: "rate_limited" }); return fail(429, "slow_down"); }
  // §4h: sending is being here — this browser's last-seen moves on (never starts a return).
  try { db.webPresent(token); } catch { /* never costs a send */ }
  // S2: what kind of device this was typed on, for "today, on your laptop". Kept by the message's own id.
  try { settle.noteWebDevice(conv, id, settle.deviceClass(headers["user-agent"])); } catch { /* never costs a send */ }

  const key = `${conv}:${id}`;
  inFlight.add(key);
  const delivering = Promise.resolve()
    .then(async () => {
      // A voice note with no words yet is heard first (src/webmedia.js prepareSend), so the words are the message.
      const prep = files.length ? await prepareSend({ conversationId: conv, text, files, log }) : { text, attachments: [] };
      if (!prep) return { ok: false, error: "failed" };
      // §4h: taken back while it was still on its way here. Nothing is delivered (the claim would refuse it anyway).
      if (db.inboundCancelled(WEB, key)) return { ok: true, duplicate: true, cancelled: true };
      return router.deliver({ channel: WEB, externalId: id, conversationId: conv, text: prep.text, ...(prep.attachments.length ? { attachments: prep.attachments } : {}), ...(chatRaw ? { chatId: db.webChatRoute(chatRaw) } : {}), at: clock.now() });
    })
    .catch((e) => { log({ web_send_failed: (e?.message ?? String(e)).split("\n")[0] }); return { ok: false, error: "failed" }; });
  // Kept until the delivery settles; once Router.deliver has claimed the id, the claim's own row decides a take-back instead.
  void delivering.finally(() => inFlight.delete(key));
  const quick = await Promise.race([delivering, new Promise(r => setTimeout(() => r(null), ackWaitMs).unref?.())]);
  log({ web_send: quick ? (quick.duplicate ? "duplicate" : quick.refused ?? (quick.ok === false ? "failed" : "done")) : "accepted" });
  if (quick && quick.refused) return fail(403, quick.refused);
  if (quick && quick.ok === false && quick.error === "failed") return fail(500, "failed");
  if (!wantsJson) return { status: 303, headers: { ...SECURITY_HEADERS, Location: back, "Content-Length": 0 }, body: "" };
  return json(200, { ok: true, id, duplicate: !!quick?.duplicate, ...(chatRaw ? { chat: chatRaw } : {}) });
}

/**
 * POST /web/send/cancel (§4h "take it back"): the person takes back a message they just sent, before
 * Reason starts on it. Same-origin and the session's own secret, like /web/send; the browser's id
 * is put under the SESSION's conversation (Router.takeBack), so nobody can take back anyone else's.
 * Never delays a send: it races the turn's own start, and exactly one of the two wins
 * (db.cancelHeldInbound). Idempotent: a second tap says taken back again. Too late: 409 `too_late`.
 */
export async function cancelRequest({ account, headers = {}, readBody, router, log = () => {} }) {
  const form = new URLSearchParams((await readBody()) ?? "");
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(readCookie(headers.cookie)))) {
    log({ web_cancel_refused: "origin_or_token" });
    return json(403, { ok: false, error: "not_from_this_page" });
  }
  const id = String(form.get("id") ?? "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return json(400, { ok: false, error: "bad_id" });
  if (!router?.takeBack) return json(503, { ok: false, error: "unavailable" });
  const conv = account.conversation_id;
  const key = `${conv}:${id}`;
  let out = router.takeBack({ conversationId: conv, id, inFlight: inFlight.has(key) });
  // Tapped before this browser's /web/send has even been read (two connections race): give that send
  // a moment to arrive, so a tap in time is never answered "not found" while the message goes out.
  for (let waited = 0; !out.ok && out.why === "not_found" && waited < CANCEL_WAIT_MS; waited += 50) {
    await new Promise(r => setTimeout(r, 50));
    out = router.takeBack({ conversationId: conv, id, inFlight: inFlight.has(key) });
  }
  if (out.ok) return json(200, { ok: true, cancelled: true, ...(out.already ? { already: true } : {}) });
  if (out.why === "started") return json(409, { ok: false, error: "too_late" });
  return json(404, { ok: false, error: "not_found" });
}

/**
 * GET /web/stream: Server-Sent Events for the session's own conversation. `message` for every new
 * history row (theirs, from any channel, and Reason's), `typing` while Reason works on a Web turn,
 * `signedout` when the session stops being good. Resumes after `Last-Event-ID` (or `?after=`). The
 * session is re-read every STREAM_RECHECK_MS and before every push, so a sign-out elsewhere ends it.
 */
export function streamRequest({ account, headers = {}, query = {}, router = null, log = () => {}, streamMs = STREAM_MS, recheckMs = STREAM_RECHECK_MS, extraHeaders = {} }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const startAfter = Number(/^\d{1,15}$/.test(String(headers["last-event-id"] ?? "")) ? headers["last-event-id"] : (/^\d{1,15}$/.test(String(query.after ?? "")) ? query.after : 0));
  // One Web-only chat's rows, or the shared thread's; another account's chat is refused outright.
  const chat = chatFrom(conv, query.chat);
  if (chat == null) return json(404, { ok: false, error: "not_found" });
  return {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive", ...extraHeaders },
    stream(res, req) {
      let last = startAfter, closed = false;
      const webCh = router?.get?.(WEB) ?? null;
      const write = (s) => { if (!closed) res.write(s); };
      const stillHers = () => sessionAccount(headers)?.conversation_id === conv;
      const end = (why) => {
        if (closed) return;
        closed = true;
        db.historyBus.off("row", onRow);
        db.historyBus.off("state", onRow);
        webCh?.events?.off?.("typing", onTyping);
        doingEvents.off("change", onDoing);
        clearInterval(beat); clearInterval(check); clearTimeout(stop);
        log({ web_stream_end: why });
        try { res.end(); } catch { /* already gone */ }
      };
      const flush = () => {
        if (!stillHers()) { write("event: signedout\ndata: {}\n\n"); return end("signed_out"); }
        for (const r of db.messagesFor(conv, { after: last, limit: 200, chat })) {
          last = Math.max(last, r.id);
          write(`id: ${r.id}\nevent: message\ndata: ${JSON.stringify(rowOut(r, { conversationId: conv, service }))}\n\n`);
        }
      };
      // L10 and S3 ride the stream too: what is being worked at length, and tasks that just settled.
      // Sent when it changes — after a new row, when a turn writes down its task's messages
      // (historyBus `state`, src/settle.js), and on the 15 s ping — never on a poll beside the stream.
      let lastState = null;
      const pushState = () => {
        if (closed) return;
        const s = JSON.stringify({ work: workOf(conv), settled: settledLately(conv, { service, chat }) });
        if (s !== lastState) { lastState = s; write(`event: state\ndata: ${s}\n\n`); }
      };
      const onRow = (e) => { if (e?.conversationId !== conv) return; try { flush(); pushState(); } catch { end("failed"); } };
      const onTyping = (e) => {
        if (e?.to !== account.address || !stillHers()) return;
        write(`event: typing\ndata: ${JSON.stringify({ on: !!e.on, until: e.until || 0, doing: e.on ? doingFor(conv) : null })}\n\n`);
      };
      const onDoing = (c) => { if (c !== conv || !stillHers()) return; write(`event: doing\ndata: ${JSON.stringify({ doing: doingFor(conv) })}\n\n`); };
      // Timers first: `end` clears them, and the first flush may already end the stream.
      // A named event, not a comment, so the page can tell a live stream from a silently dead one.
      const beat = setInterval(() => { write("event: ping\ndata: {}\n\n"); try { pushState(); } catch { /* the ping still goes */ } }, 15_000);
      const check = setInterval(() => { if (!stillHers()) { write("event: signedout\ndata: {}\n\n"); end("signed_out"); } }, recheckMs);
      const stop = setTimeout(() => end("cycle"), streamMs);
      for (const t of [beat, check, stop]) t.unref?.();
      req?.on?.("close", () => end("closed"));
      res.on?.("close", () => end("closed"));
      write("retry: 1500\n\n");
      db.historyBus.on("row", onRow);
      db.historyBus.on("state", onRow);
      webCh?.events?.on?.("typing", onTyping);
      doingEvents.on("change", onDoing);
      // A tab that opens (or comes back) mid-turn hears what Reason is doing now, not only at the next change.
      if (doingFor(conv)) onDoing(conv);
      try { flush(); pushState(); } catch (e) { log({ web_stream_failed: (e?.message ?? String(e)).split("\n")[0] }); end("failed"); }
    },
  };
}

/**
 * GET /web/live: the same stream, asked for from the pages host (files.heyreason.com), which reaches
 * Reason without the website's buffering proxy. A browser asking across hosts must be the website's
 * own page (Origin = REASON_SITE_URL's origin, exactly); it gets CORS with credentials for that one
 * origin and nothing else. With no Origin it is a same-host request and needs no CORS. Anything
 * else — another site, another subdomain — is refused before the session is even looked at again.
 */
export function liveStreamRequest({ account, headers = {}, query = {}, router = null, log = () => {} }) {
  const origin = String(headers.origin ?? "").trim();
  const site = siteOrigin();
  if (origin && origin !== site) {
    log({ web_live_refused: "origin" });
    return json(403, { ok: false, error: "not_from_this_page" });
  }
  const cors = origin ? { "Access-Control-Allow-Origin": site, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {};
  return streamRequest({ account, headers, query, router, log, streamMs: LIVE_STREAM_MS, extraHeaders: cors });
}
