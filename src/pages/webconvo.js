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
import { timingSafeEqual, createHash } from "node:crypto";
import * as db from "../db.js";
import { WEB, webStreamOrigin, siteOrigin } from "../web.js";
import { config, clock } from "../config.js";
import { esc } from "./render.js";
import { readCookie } from "./access.js";
import { cleanTitle, queueTitle } from "../itemtitle.js";
import { SECURITY_HEADERS, sameOrigin, sessionAccount, greeting } from "./websignin.js";
import { webPage, wordmark, label, hand, action, typed, stamp, onIt, approvalCard, themeSwitch, OG_KEY } from "./webkit.js";
import { mediaOut, mediaHtml, ownWords, composerHtml, listeningHtml, composeBoot, COMPOSE_CSS, COMPOSE_JS } from "./webcompose.js";
import { prepareSend } from "../webmedia.js";

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
/** A Web message this recent means they are mid-conversation: /web opens on the thread, not the arrival. */
export const THREAD_RECENT_MS = 30 * 60_000;

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
  return `${lbl}${photos}${files}${words}${play}`;
}

/**
 * One history row as the browser gets it. `cid` is the browser's own id for a line sent from Web
 * (the part after the conversation prefix Router.deliver put on it), so the page can swap its
 * "sending" line for the real one; `html` is the line drawn here; nothing else about the row's
 * bookkeeping leaves the server.
 */
export function rowOut(row, { conversationId, service = null }) {
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
  return m;
}

const serviceOf = (conversationId) => db.getThread(conversationId)?.service ?? null;

function lineHtml(m) {
  return `<li class="msg ${m.role === "user" ? "you" : "re"}" data-id="${m.id}" data-at="${m.at}" data-web="${m.web ? 1 : 0}"${m.cid ? ` data-cid="${esc(m.cid)}"` : ""}>${m.html}</li>`;
}

const dayName = (at, now) => {
  const d = dayKey(at);
  return d === dayKey(now) ? "TODAY" : d === dayKey(now - 864e5) ? "YESTERDAY" : dayFmt().format(at).toUpperCase();
};
const continued = (where) => `<li class="cont" role="separator" aria-label="Continued ${esc(where)}"><span aria-hidden="true"></span><span class="hand">Continued ${esc(where)}</span><span aria-hidden="true"></span></li>`;

/** The lines with a day label where the day changes and a "Continued on Web" mark where the place does. */
export function listHtml(lines, { now = clock.now() } = {}) {
  let out = "", day = null, web = null;
  for (const m of lines) {
    const d = dayKey(m.at);
    if (d !== day) { out += `<li class="day" role="separator">${label(dayName(m.at, now))}</li>`; day = d; }
    if (web !== null && m.web !== web && m.role === "user") out += continued(m.web ? "on Web" : `in ${m.source}`);
    if (m.role === "user") web = m.web;
    out += lineHtml(m);
  }
  return out;
}

// ---------------------------------------------------------------- what Reason holds

const STATE_WORDS = {
  running: ["WORKING", "working on it"],
  waiting: ["WAITING", "waiting to hear back"],
  waiting_on_other: ["WAITING", "waiting to hear back"],
  waiting_on_you: ["NEEDS YOU", "waiting on you"],
  blocked: ["STUCK", "stuck. i'll say why in the chat"],
};
const whenFmt = () => new Intl.DateTimeFormat("en-US", { timeZone: config.tz, weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * What Reason is holding for this conversation right now: its open tasks and its pending timers,
 * nothing invented. Phase 2 draws the full Ongoing; this is what the arrival's ALREADY IN HAND, the
 * Ongoing tab and the desktop margin show until then.
 */
export function inHand(conversationId) {
  const name = db.getAccount(conversationId)?.name || config.ownerName;
  // The row's own short title (src/itemtitle.js); until it has one, Reason's note cleaned up, and a
  // one-time title asked for in the background so the next view reads like the person would say it.
  const titled = (kind, row, text) => {
    const label = String(row.label ?? "").trim();
    if (label) return label;
    // A series' firing is titled through its series (the title then reaches every firing).
    if (kind === "timer" && row.series_id) {
      const s = db.getSeries(conversationId, row.series_id);
      if (s?.label) return s.label;
      if (s) queueTitle("series", conversationId, s.id, s.what, { name });
    } else queueTitle(kind, conversationId, row.id, text, { name });
    return cleanTitle(text, { name }) || String(text ?? "").trim().slice(0, 48);
  };
  const tasks = db.listTasks(conversationId).map(t => {
    const [status, words] = STATE_WORDS[t.state] ?? ["IN HAND", "in hand"];
    return { kind: "task", title: titled("task", t, t.title), status, words, needs: t.state === "waiting_on_you", due: t.next_wake_at ?? null };
  });
  const timers = db.listTimers(conversationId).map(t => ({
    kind: "timer", title: titled("timer", t, t.note) || (t.call_goal ? "A call" : "A reminder"),
    status: t.call_goal ? "CALL" : "REMINDER", when: whenFmt().format(t.fire_at), needs: false, due: t.fire_at,
  }));
  // Needs-you first, then whatever is due soonest; nothing due last.
  const rank = (x) => [x.needs ? 0 : 1, Number.isFinite(x.due) ? x.due : Infinity];
  return [...tasks, ...timers].filter(x => x.title).sort((a, b) => {
    const [an, ad] = rank(a), [bn, bd] = rank(b);
    return an - bn || (ad === bd ? 0 : ad < bd ? -1 : 1);
  });
}

/** Approvals Reason is waiting on (asked, not answered) in the last day: the one loud thing. */
export function waitingApprovals(conversationId, now = clock.now()) {
  return db.pendingConfirmations(conversationId)
    .filter(c => c.granted_at == null && now - c.asked_at < 24 * 60 * 60_000)
    .map(c => ({ title: String(c.summary ?? "").trim(), at: c.asked_at, money: /\$|charge|pay|buy|purchase|order/i.test(`${c.action} ${c.stakes} ${c.summary}`) }))
    .filter(c => c.title)
    .slice(0, 1);
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
.thread{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:26px}
.start{align-self:center;text-align:center}
.start .lbl{white-space:normal}
.day{text-align:center}
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
.og .og-x{display:none}
.og.all .og-x{display:flex}
.og-all{align-self:flex-start;min-height:44px;display:inline-flex;align-items:center;margin-top:-12px;font:400 12px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink);text-decoration:none}
.og-all:hover,.og-hide:hover,.og-back:hover{color:var(--pen)}
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
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:6;background:var(--ground);border-top:1px solid var(--hair);padding:6px 24px calc(14px + env(safe-area-inset-bottom));display:flex;justify-content:space-around}
.tabs a{min-width:120px;min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;font:italic 400 22px/1 var(--serif);color:var(--muted)}
.tabs a[aria-current=page]{color:var(--ink)}
.tabs .n{font:700 12px/1 var(--mono);font-style:normal;color:var(--pen)}
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
.slips{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.slipc{text-decoration:none;color:var(--ink);padding:18px;display:flex;flex-direction:column;gap:10px;min-height:120px}
.slipc .t{font-size:16px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}
.slipc .hand{transform:rotate(-1deg);transform-origin:left}
.slipc .when{font:italic 400 20px/1 var(--serif)}
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
.top{padding:22px clamp(20px,4vw,48px)}
.top nav{display:flex}
.menu-b{display:none}
.wrapc{padding:16px clamp(20px,4vw,48px) 0}
.convo,.thread{gap:36px}
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
.slips{grid-template-columns:repeat(3,minmax(0,1fr))}
.pick{margin-top:64px}
.pick-h .hand{font-size:28px}
.solo .h1{font-size:64px}
.og-m{display:none}
}
@media (max-width:359px){.greet{font-size:34px}.lbl{font-size:10px;letter-spacing:.12em}.rsay p{font-size:15px}}
`;

const MENU_SVG = `<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`;
const SEND_SVG = `<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5"/></svg>`;

const signOutForm = (csrf, cls = "act2") => `<form method="POST" action="/web/signout"><input type="hidden" name="c" value="${esc(csrf)}"><button class="${cls}" type="submit">SIGN OUT OF THIS BROWSER</button></form>`;

/** The top of every signed-in screen: the wordmark home; MEMORY and SETTINGS on desktop; a menu on phones. */
function topBar({ csrf, extra = "" }) {
  return `<header class="top">${wordmark({ href: "/web" })}`
    + `<nav aria-label="Account">${extra}${typed("MEMORY", { href: "/web/memory" })}${typed("SETTINGS", { href: "/web/settings" })}</nav>`
    + `<button class="menu-b" type="button" aria-label="Menu" aria-expanded="false" aria-controls="menu">${MENU_SVG}</button></header>`
    + `<div class="menu" id="menu" hidden role="dialog" aria-modal="true" aria-label="Menu"><div class="menu-h">${wordmark()}<button class="act2 menu-x" type="button">CLOSE</button></div>`
    + `<ul><li>${action("The thread", { href: "/web?thread" })}</li><li>${action("Memory", { href: "/web/memory" })}</li><li>${action("Settings", { href: "/web/settings" })}</li></ul>`
    + `${themeSwitch("th-menu")}${signOutForm(csrf)}</div>`;
}

function tabBar(current, count) {
  return `<nav class="tabs" aria-label="Sections"><a href="/web?thread"${current === "chat" ? ` aria-current="page"` : ""}>Chat</a>`
    + `<a href="/web?tab=ongoing"${current === "ongoing" ? ` aria-current="page"` : ""}>Ongoing${count ? `<span class="n" aria-label="${count} ${count === 1 ? "thing" : "things"}">${count}</span>` : ""}</a></nav>`;
}

/** The one-line composer. `sendId` makes even a no-script post one turn however often it is resent. */
// `+` and the mic (composer 01–04, Listening) are drawn and run by src/pages/webcompose.js.
function composer({ csrf, sendId }) {
  return composerHtml({ csrf, sendId, maxText: MAX_TEXT });
}

/** How many Ongoing rows show before "See all N →" (owner, 10-26): needs-you first, then soonest due. */
export const OG_TOP = 3;

/**
 * The Ongoing list: the desktop margin, or (`tab`) the mobile Ongoing tab's body. The top OG_TOP rows
 * show; the rest are drawn but folded, and "See all N →" opens them in place ("Show fewer" folds them
 * back). Without script it is a link to the same list drawn open (`all`). The margin also carries
 * "HIDE →": the page slides it away and the thread takes the width; a thin vertical typed "ONGOING · N" at the right edge brings it back (handoff §3, sheet 3).
 */
function ongoingMargin(items, approvals, { all = false, tab = false } = {}) {
  const head = tab ? "" : `<div class="og-h"><h2>Ongoing</h2><button class="act2 og-hide" type="button" aria-controls="og" aria-expanded="true">HIDE <span aria-hidden="true">→</span></button></div>`;
  const aside = (inner, cls = "") => `<aside class="og${tab ? " og-tab" : ""}${cls}" id="og" aria-label="Ongoing">${head}${inner}</aside>`;
  if (!items.length && !approvals.length) {
    return aside(`<div class="empty"><p class="h2">Nothing left<br>to chase.</p>${hand("whatever you hand me shows up here while i work.", { tilt: true })}</div>`);
  }
  const needs = items.filter(x => x.needs);
  const rest = items.filter(x => !x.needs);
  const total = approvals.length + items.length;
  let i = 0;
  const fold = () => (i++ >= OG_TOP ? " og-x" : "");
  const row = (x) => `<div class="og-row${fold()}"><b>${esc(x.title)}</b>${x.when ? `<span class="when">${esc(x.when)}</span>` : `<span class="lbl">${esc(x.status)}</span>`}</div>`;
  const appr = (a) => `<div class="card appr${fold()}"><p class="appr-t">${esc(a.title)}</p><p class="lbl">${a.money ? "NOTHING CHARGED YET" : "NOTHING BOOKED YET"}</p></div>`;
  const section = (h, cls, rows) => {
    const from = i;
    const inner = rows();
    return `<section class="og-sec${from >= OG_TOP ? " og-x" : ""}"><h3${cls}>${h}</h3>${inner}</section>`;
  };
  const back = tab ? "/web?tab=ongoing" : "/web?thread";
  const more = total > OG_TOP
    ? `<a class="og-all" href="${back}${all ? "" : "&amp;all=1"}" aria-controls="og" aria-expanded="${all}" data-n="${total}">${all ? "Show fewer" : `See all ${total} <span aria-hidden="true">→</span>`}</a>`
    : "";
  return aside(
    (approvals.length || needs.length ? section("NEEDS YOU", ` class="pen"`, () => approvals.map(appr).join("") + needs.map(row).join("")) : "")
    + (rest.length ? section("IN HAND", "", () => rest.map(row).join("")) : "")
    + more,
    all ? " all" : "",
  );
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
if(og){var hb=og.querySelector('.og-hide'),back=document.querySelector('.og-back'),all=og.querySelector('.og-all'),calm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function keepOff(off){try{if(off)localStorage.setItem('${OG_KEY}','off');else localStorage.removeItem('${OG_KEY}')}catch(e){}}
if(hb)hb.onclick=function(){keepOff(true);if(calm){H.classList.add('og-off');if(back)back.focus();return}og.classList.add('going');setTimeout(function(){H.classList.add('og-off');og.classList.remove('going');if(back)back.focus()},320)};
if(back)back.onclick=function(e){e.preventDefault();keepOff(false);if(!calm)og.classList.add('going');H.classList.remove('og-off');requestAnimationFrame(function(){requestAnimationFrame(function(){og.classList.remove('going')})});if(hb)hb.focus()};
if(all)all.onclick=function(e){e.preventDefault();var open=og.classList.toggle('all');all.setAttribute('aria-expanded',open?'true':'false');all.innerHTML=open?'Show fewer':'See all '+all.dataset.n+' <span aria-hidden="true">\\u2192</span>'}}
document.querySelectorAll('form[action="/web/signout"]').forEach(function(f){f.addEventListener('submit',function(){try{Object.keys(sessionStorage).forEach(function(k){if(k.indexOf('reason-web-pending')===0)sessionStorage.removeItem(k)})}catch(x){}})});
if(mb&&menu){var mx=menu.querySelector('.menu-x');function shut(){menu.hidden=true;mb.setAttribute('aria-expanded','false');mb.focus()}mb.onclick=function(){menu.hidden=false;mb.setAttribute('aria-expanded','true');mx.focus()};mx.onclick=shut;document.addEventListener('keydown',function(e){if(menu.hidden)return;if(e.key==='Escape')shut();else if(e.key==='Tab'){var f=menu.querySelectorAll('a,button,input:not([type=hidden])'),a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}})}
document.querySelectorAll('.start-w[hidden]').forEach(function(s){s.hidden=false});
document.querySelectorAll('.ex').forEach(function(b){b.onclick=function(){box.value=b.dataset.text;box.dispatchEvent(new Event('input'));box.focus()}});
var tf=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});function fmt(at){try{return tf.format(new Date(at)).toUpperCase()}catch(e){return''}}
function times(root){(root||document).querySelectorAll('time[datetime]').forEach(function(t){var d=Date.parse(t.dateTime);if(d)t.textContent=fmt(d)})}times();
if(box){box.addEventListener('focus',function(){body.classList.add('typing')});box.addEventListener('blur',function(){body.classList.remove('typing')})}
if(!form)return;
var KEY='reason-web-pending:'+R.k,waiting=0,until=0,live=false,es=null,lost=0;
function noteLine(t){if(!net)return;if(t){net.textContent=t;net.hidden=false}else net.hidden=true}
function offline(){return navigator.onLine===false}
function near(){return window.innerHeight+window.scrollY>=document.body.scrollHeight-200}
function bottom(){window.scrollTo(0,document.body.scrollHeight)}
function pend(){try{return JSON.parse(sessionStorage.getItem(KEY)||'[]')}catch(e){return[]}}
function keep(a){try{sessionStorage.setItem(KEY,JSON.stringify(a))}catch(e){}}
function forget(cid){keep(pend().filter(function(p){return p.id!==cid}))}
function uid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
function working(on,u){until=on?(u||Date.now()+120000):0;if(onit)onit.hidden=!on;if(on&&near())bottom()}
setInterval(function(){if(until&&Date.now()>until)working(false)},1000);
// From the arrival, a message moves you into the thread once Reason has it.
if(!list){R.api={uid:uid,post:function(p){keep(pend().concat([p]));location.href='/web?thread'},pendingLine:function(){return document.createElement('li')},state:function(){}};
form.addEventListener('submit',function(e){e.preventDefault();var t=box.value.trim(),fs=R.takeFiles?R.takeFiles():[];if(!t&&!fs.length)return;var p={id:uid(),text:t};if(fs.length)p.files=fs;R.api.post(p)});return}
function line(m){var li=document.createElement('li');li.className='msg arrive '+(m.role==='user'?'you':'re');li.dataset.id=m.id;li.dataset.at=m.at;li.dataset.web=m.web?1:0;if(m.cid)li.dataset.cid=m.cid;li.innerHTML=m.html;times(li);return li}
function add(m){if(list.querySelector('.msg[data-id="'+m.id+'"]'))return;unempty();var stick=near(),li=line(m);
if(m.cid){var p=list.querySelector('.msg[data-pending="'+m.cid+'"]');if(p){p.replaceWith(li);forget(m.cid);li.classList.add('just');var s=document.createElement('p');s.className='st';s.textContent='SENT \\u00b7 '+fmt(m.at);li.appendChild(s);setTimeout(function(){s.classList.add('fade');setTimeout(function(){s.remove();li.classList.remove('just')},1100)},1200);if(stick)bottom();return}}
var after=null;list.querySelectorAll('.msg[data-id]').forEach(function(o){var a=Number(o.dataset.at),i=Number(o.dataset.id);if(a<m.at||(a===m.at&&i<m.id))after=o});
var fp=list.querySelector('.msg[data-pending]');
if(after&&after.nextSibling&&!(fp&&after.nextSibling===fp))list.insertBefore(li,after.nextSibling);else if(fp&&(!after||after.nextSibling===fp))list.insertBefore(li,fp);else if(after)list.appendChild(li);else list.insertBefore(li,list.firstChild);
if(m.id>R.last)R.last=m.id;if(m.role==='assistant'){waiting=Math.max(0,waiting-1);if(!waiting)working(false)}if(stick)bottom()}
function unempty(){var e=document.querySelector('.convo>.empty');if(e)e.remove()}
function pendingLine(p){unempty();var li=document.createElement('li');li.className='msg you arrive';li.dataset.pending=p.id;if(p.files&&p.files.length&&R.drawFiles)R.drawFiles(li,p);else{var s=document.createElement('div');s.className='said';s.textContent=p.text;li.appendChild(s)}list.appendChild(li);bottom();return li}
function stored(li){return pend().filter(function(x){return x.id===li.dataset.pending})[0]||{id:li.dataset.pending,text:(li.querySelector('.said')||{}).textContent||''}}
function state(li,st){if(!li)return;li.dataset.state=st;li.querySelectorAll('.st,.retry').forEach(function(x){x.remove()});
if(st==='sending'||st==='waiting'){var s=document.createElement('p');s.className='st';s.textContent=st==='sending'?'SENDING\\u2026':'WAITING TO SEND';li.appendChild(s)}
else if(st==='failed'){var b=document.createElement('button');b.type='button';b.className='retry';b.textContent="didn't go. tap to try again.";b.onclick=function(){if(li.retry)return li.retry();send(stored(li),li)};var n=document.createElement('p');n.className='st';n.textContent="IT WON'T SEND TWICE";li.appendChild(b);li.appendChild(n)}}
function expired(){if(waiting>0||until){var last=list.querySelector('.msg.you:last-of-type .said');var m=document.querySelector('main');var h='<section class="solo" aria-labelledby="ex-h"><h1 id="ex-h" class="h1">Still working on it.<br><em>Sign back in to see.</em></h1><div class="ghost" aria-hidden="true"><span class="lbl">WORKING</span><b></b></div><a class="act" href="/web?out=1">Sign in <span aria-hidden="true">\\u2192</span></a></section>';
m.innerHTML=h;var b=m.querySelector('.ghost b');b.textContent=last?last.textContent:'';document.querySelectorAll('.composer,.tabs,.onit').forEach(function(x){x.remove()})}else location.href='/web?out=1'}
function send(p,li,tries){tries=tries||0;if(offline()){state(li,'waiting');return}state(li,'sending');
fetch('/web/send',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json','X-Reason-Csrf':R.c},body:new URLSearchParams({id:p.id,text:p.text,c:R.c,files:(p.files||[]).map(function(f){return f.id}).filter(Boolean).join(','),voice:p.voice?String(p.voice):''})})
.then(function(r){return r.json().catch(function(){return{ok:false}}).then(function(j){j.status=r.status;return j})})
.then(function(j){if(j.status===401){expired();return}if(j.ok){if(j.duplicate&&li.isConnected&&li.dataset.pending){li.remove();forget(p.id)}if(li.isConnected&&!j.duplicate){state(li,'sent');li.querySelectorAll('.st').forEach(function(x){x.remove()});waiting++;working(true)}poll()}else if(j.status>=500&&tries<2){setTimeout(function(){send(p,li,tries+1)},1500*(tries+1))}else state(li,'failed')})
.catch(function(){if(offline()){state(li,'waiting');return}if(tries<3)setTimeout(function(){send(p,li,tries+1)},1500*(tries+1));else state(li,'failed')})}
function post(p,li){keep(pend().concat([p]));send(p,li||pendingLine(p))}
R.api={uid:uid,post:post,pendingLine:pendingLine,state:state};
form.addEventListener('submit',function(e){e.preventDefault();var t=box.value.replace(/\\s+$/,''),fs=R.takeFiles?R.takeFiles():[];if(!t.trim()&&!fs.length)return;var p={id:uid(),text:t.trim()?t:''};if(fs.length)p.files=fs;box.value='';box.dispatchEvent(new Event('input'));post(p)});
// A tab reloaded mid-send (or arriving from the home screen): whatever it has not yet seen in history
// is shown again and sent again under the SAME id, which the server's claim turns into nothing if it already arrived.
pend().forEach(function(p){if(list.querySelector('.msg[data-cid="'+p.id+'"]')){forget(p.id);return}send(p,pendingLine(p))});
window.addEventListener('offline',function(){noteLine("you're offline. i'll send it when you're back.")});
window.addEventListener('online',function(){noteLine('');list.querySelectorAll('.msg[data-state=waiting]').forEach(function(li){if(li.retry)return li.retry();send(stored(li),li)});poll()});
if(offline())noteLine("you're offline. i'll send it when you're back.");
var polling=false;function poll(){if(polling)return;polling=true;fetch('/web/history?after='+R.last,{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){expired();throw 0}return r.json()}).then(function(j){(j.messages||[]).forEach(add);if(lost){lost=0;if(!offline())noteLine('')}}).catch(function(e){if(e!==0&&!offline()){lost++;if(lost>1)noteLine("lost the line for a sec. nothing's lost.")}}).then(function(){polling=false})}
var beat=0;setInterval(function(){if(!live||Date.now()-beat>40000)poll()},4000);
function stream(){if(!window.EventSource)return;try{es=R.stream.indexOf('http')===0?new EventSource(R.stream+'?after='+R.last,{withCredentials:true}):new EventSource(R.stream+'?after='+R.last)}catch(x){return}es.onopen=function(){live=true;beat=Date.now();if(lost){lost=0;noteLine('')}};
es.addEventListener('ping',function(){beat=Date.now()});
es.addEventListener('message',function(e){beat=Date.now();try{add(JSON.parse(e.data))}catch(x){}});
es.addEventListener('typing',function(e){try{var t=JSON.parse(e.data);working(t.on,t.until)}catch(x){}});
es.addEventListener('signedout',function(){es.close();expired()});
es.onerror=function(){live=false}}
stream();
document.addEventListener('visibilitychange',function(){if(!document.hidden)poll()});
var loading=false;function older(){if(loading||!R.more)return;loading=true;var h=document.body.scrollHeight;
fetch('/web/history?before='+R.first,{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){return r.json()}).then(function(j){var ms=j.messages||[];var anchor=list.firstChild;
ms.forEach(function(m){if(!list.querySelector('.msg[data-id="'+m.id+'"]'))list.insertBefore(line(m),anchor)});
if(ms.length)R.first=ms[0].id;R.more=!!j.more;start.textContent='';if(!R.more&&j.start){var s=document.createElement('p');s.className='lbl';s.textContent=j.start;start.appendChild(s)}
window.scrollBy(0,document.body.scrollHeight-h)}).catch(function(){}).then(function(){loading=false;if(R.more)hook()})}
function hook(){start.textContent='';var b=document.createElement('button');b.type='button';b.className='act2';b.textContent='\\u2191 SHOW EARLIER MESSAGES';b.onclick=older;start.appendChild(b)}
if(R.more)hook();
bottom();
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

function boot({ csrf, lines = [], more = false, conversationId = "" }) {
  // `k` keys this tab's unsent messages to ONE conversation: a tab later signed in as somebody else never resends them.
  const k = createHash("sha256").update(`pending:${conversationId}`).digest("base64url").slice(0, 12);
  const first = lines[0]?.id ?? 0, last = lines.reduce((n, m) => Math.max(n, m.id), 0);
  return `window.REASON_WEB={c:${JSON.stringify(String(csrf ?? ""))},first:${Number(first)},last:${Number(last)},more:${more ? "true" : "false"},k:${JSON.stringify(k)},stream:${JSON.stringify(streamPath())}};`;
}

const NET = `<p class="netline" role="status" hidden></p>`;

/**
 * The thread. `firstVisit` draws 5C in its place (once); `approvals` the one loud thing at the foot.
 */
export function renderConversation({ account, csrf, lines, more, firstVisit = false, sendId, items = [], approvals = [], now = clock.now(), all = false }) {
  if (firstVisit) return renderFirstVisit({ account });
  const startLine = more
    ? `<button class="act2" type="button">↑ SHOW EARLIER MESSAGES</button>`
    : lines.length ? label(`Your conversation before ${dayFmt().format(lines[0].at)} stays in your texts.`) : "";
  const asked = approvals[0]?.at ?? null;
  const askedIn = asked ? [...lines].reverse().find(m => m.role === "assistant" && m.at <= asked + 60_000) : null;
  const apprLbl = asked ? `REASON · ${(askedIn?.source ?? sourceLabel(null, serviceOf(account?.conversation_id))).toUpperCase()} · ${timeFmt().format(asked)}` : "REASON · WAITING ON YOU";
  const appr = approvals.length ? `<div class="msg re approval">${label(apprLbl)}${approvalCard({ title: approvals[0].title, money: approvals[0].money })}</div>` : "";
  const count = items.length + approvals.length;
  const body = topBar({ csrf }) + NET
    + `<main class="wrapc"><section class="convo" aria-labelledby="c-h"><h1 id="c-h" class="sr">Your conversation with Reason</h1>`
    + `<div class="start">${startLine}</div>`
    + `<ol class="thread" role="log" aria-live="polite" aria-relevant="additions">${listHtml(lines, { now })}</ol>`
    + (lines.length ? "" : `<div class="empty">${hand("nothing here yet. whatever you tell me here or by text shows up in this thread.", { tilt: true })}</div>`)
    + appr + onIt(true)
    + composer({ csrf, sendId })
    + `</section>${ongoingMargin(items, approvals, { all })}</main>`
    + `<button class="og-back" type="button" aria-controls="og" aria-expanded="false" aria-label="Show Ongoing${count ? `, ${count} ${count === 1 ? "thing" : "things"}` : ""}"><span aria-hidden="true">ONGOING${count ? ` · ${count}` : ""}</span></button>`
    + tabBar("chat", count) + listeningHtml();
  return webPage({ title: "Reason", body, css: CSS + COMPOSE_CSS, script: boot({ csrf, lines, more, conversationId: account?.conversation_id }) + composeBoot() + CLIENT_JS + COMPOSE_JS, bodyClass: "has-tabs", loader: true });
}

/** B / B2, the arrival: the greeting, the composer, then what's in hand or where to start, then iMessage. */
export function renderHome({ account, csrf, sendId, items = [], approvals = [], pick = "" }) {
  const name = String(account?.name ?? "").trim();
  const slips = items.slice(0, 3).map(x => `<a class="card slipc" href="/web?thread"><span class="lbl">${esc(x.status)}</span><span class="t">${esc(x.title)}</span>${x.when ? `<span class="when">${esc(x.when)}</span>` : hand(x.words, { tag: "span" })}</a>`).join("");
  const middle = items.length
    ? `<section class="inhand" aria-label="Already in hand">${label("ALREADY IN HAND")}<div class="slips">${slips}</div></section>`
    : `<section class="start-w" aria-label="You could start with" hidden>${label("YOU COULD START WITH")}${EXAMPLES.map(t => `<button class="ex" type="button" data-text="${esc(t)}">"${esc(t)}"</button>`).join("")}</section>`;
  const body = topBar({ csrf, extra: typed("THE THREAD →", { href: "/web?thread" }) }) + NET
    + `<main class="home"><h1 class="greet">${esc(greeting(name))}</h1>`
    + composer({ csrf, sendId })
    + (approvals.length ? `<section class="approval" aria-label="Needs you">${approvalCard({ title: approvals[0].title, money: approvals[0].money })}</section>` : "")
    + middle + pick + `</main>`
    + tabBar("chat", items.length + approvals.length) + listeningHtml();
  return webPage({ title: "Reason", body, css: CSS + COMPOSE_CSS, script: boot({ csrf, conversationId: account?.conversation_id }) + composeBoot() + CLIENT_JS + COMPOSE_JS, bodyClass: "has-tabs", loader: true });
}

/** 5C, shown once: the same Reason, and what stays where. */
export function renderFirstVisit() {
  const body = `<header class="top">${wordmark({ href: "/web" })}</header><main class="solo" aria-labelledby="fv-h">`
    + `<h1 id="fv-h" class="h1">${esc(BOUNDARY.title)}<br><em>${esc(BOUNDARY.titleEm)}</em></h1>`
    + `<p class="body">${esc(BOUNDARY.body)}</p>${hand(BOUNDARY.note, { tilt: true })}${action("Got it", { href: "/web" })}</main>`;
  return webPage({ title: "Reason", body, css: CSS });
}

/** The mobile Ongoing tab. Real rows when Reason holds anything; otherwise "Nothing left to chase." */
export function renderOngoing({ csrf, items = [], approvals = [], all = false }) {
  const count = items.length + approvals.length;
  const inner = count
    ? `<main class="og-list"><h1 class="h1">Ongoing</h1>${label(`${count} ${count === 1 ? "THING" : "THINGS"}`)}${ongoingMargin(items, approvals, { all, tab: true })}</main>`
    : `<main class="og-m"><h1 class="h1">Nothing left<br>to chase.</h1>${hand("whatever you hand me shows up here while i work.", { tilt: true })}</main>`;
  const css = `${CSS}.og-tab{display:flex;position:static;max-width:none;padding:0}`;
  return webPage({ title: "Reason — Ongoing", body: topBar({ csrf }) + inner + tabBar("ongoing", count), css, script: CLIENT_JS, bodyClass: "has-tabs" });
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
  const body = `<header class="top">${wordmark({ href: "/web" })}</header><main class="solo" aria-labelledby="er-h">`
    + `<h1 id="er-h" class="h1">Something went wrong.<br><em>Nothing was lost.</em></h1>`
    + `<p class="quiet">Your messages and anything I'm working on are safe.</p>${action("Try again", { href: "/web" })}</main>`;
  return webPage({ title: "Reason", body, css: CSS });
}

/**
 * GET /web signed in. `view`: the thread (?thread), the Ongoing tab (?tab=ongoing), or — by default —
 * the arrival, unless they sent something on Web in the last half hour (then the thread they're in).
 * The first real view ever is 5C instead, once.
 */
export function conversationPage({ account, headers, sendId, method = "GET", query = {}, now = clock.now() }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const csrf = db.pageSessionCsrf(readCookie(headers.cookie));
  // Spent only by a real view (GET); a HEAD carries no body to show it in.
  if (method === "GET" && db.markWebNoticeSeen(conv)) return renderFirstVisit({ account });
  const items = inHand(conv);
  const approvals = waitingApprovals(conv, now);
  const all = query.all != null;
  if (query.tab === "ongoing") return renderOngoing({ csrf, items, approvals, all });
  const rows = db.messagesBefore(conv, { limit: PAGE + 1 });
  const more = rows.length > PAGE;
  const lines = (more ? rows.slice(1) : rows).map(r => rowOut(r, { conversationId: conv, service }));
  const recentWeb = lines.some(m => m.web && m.role === "user" && now - m.at < THREAD_RECENT_MS);
  if (query.thread != null || recentWeb) return renderConversation({ account, csrf, lines, more, sendId, items, approvals, now, all });
  return renderHome({ account, csrf, sendId, items, approvals, pick: pickUp(conv, service) });
}

/**
 * GET /web/history?before=<id> (older page) or ?after=<id> (catch-up). Only the session's own
 * conversation is ever read; an id from somebody else's history simply finds nothing.
 */
export function historyRequest({ account, query = {} }) {
  const conv = account.conversation_id;
  const service = serviceOf(conv);
  const num = (v) => (/^\d{1,15}$/.test(String(v ?? "")) ? Number(v) : null);
  if (query.after != null) {
    const after = num(query.after) ?? 0;
    const rows = db.messagesFor(conv, { after, limit: 200 });
    return json(200, { messages: rows.map(r => rowOut(r, { conversationId: conv, service })) });
  }
  const before = num(query.before);
  const rows = db.messagesBefore(conv, { before, limit: PAGE + 1 });
  const more = rows.length > PAGE;
  const lines = (more ? rows.slice(1) : rows).map(r => rowOut(r, { conversationId: conv, service }));
  const start = !more && lines.length ? `Your conversation before ${dayFmt().format(lines[0].at)} stays in your texts.` : null;
  return json(200, { messages: lines, more, start });
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

/** How long a send waits to hear "refused" or "already had it" before saying "got it" and letting the turn run on. */
export const ACK_WAIT_MS = 1500;

/**
 * POST /web/send: one message into the person's conversation. Same-origin and the session's own
 * secret (header or form field), a browser-made id, words within the cap. Handed to Router.deliver
 * as a web inbound under the SESSION's conversation; nothing in the body can name another. The
 * answer comes back once Reason has the message (or has refused it); the turn runs on server-side
 * whatever happens to the tab.
 */
export async function sendRequest({ account, headers = {}, readBody, router, log = () => {}, ackWaitMs = ACK_WAIT_MS }) {
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  const fail = (status, error) => (wantsJson ? json(status, { ok: false, error }) : { status: 303, headers: { ...SECURITY_HEADERS, Location: "/web?thread", "Content-Length": 0 }, body: "" });
  const form = new URLSearchParams((await readBody()) ?? "");
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
  if (files.length && !(await import("../webuploads.js")).attachmentsFor(conv, files)) return fail(400, "bad_file");
  if (!underLimit(conv)) { log({ web_send_refused: "rate_limited" }); return fail(429, "slow_down"); }

  const delivering = Promise.resolve()
    .then(async () => {
      // A voice note with no words yet is heard first (src/webmedia.js prepareSend), so the words are the message.
      const prep = files.length ? await prepareSend({ conversationId: conv, text, files, log }) : { text, attachments: [] };
      if (!prep) return { ok: false, error: "failed" };
      return router.deliver({ channel: WEB, externalId: id, conversationId: conv, text: prep.text, ...(prep.attachments.length ? { attachments: prep.attachments } : {}), at: clock.now() });
    })
    .catch((e) => { log({ web_send_failed: (e?.message ?? String(e)).split("\n")[0] }); return { ok: false, error: "failed" }; });
  const quick = await Promise.race([delivering, new Promise(r => setTimeout(() => r(null), ackWaitMs).unref?.())]);
  log({ web_send: quick ? (quick.duplicate ? "duplicate" : quick.refused ?? (quick.ok === false ? "failed" : "done")) : "accepted" });
  if (quick && quick.refused) return fail(403, quick.refused);
  if (quick && quick.ok === false && quick.error === "failed") return fail(500, "failed");
  if (!wantsJson) return { status: 303, headers: { ...SECURITY_HEADERS, Location: "/web?thread", "Content-Length": 0 }, body: "" };
  return json(200, { ok: true, id, duplicate: !!quick?.duplicate });
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
        webCh?.events?.off?.("typing", onTyping);
        clearInterval(beat); clearInterval(check); clearTimeout(stop);
        log({ web_stream_end: why });
        try { res.end(); } catch { /* already gone */ }
      };
      const flush = () => {
        if (!stillHers()) { write("event: signedout\ndata: {}\n\n"); return end("signed_out"); }
        for (const r of db.messagesFor(conv, { after: last, limit: 200 })) {
          last = Math.max(last, r.id);
          write(`id: ${r.id}\nevent: message\ndata: ${JSON.stringify(rowOut(r, { conversationId: conv, service }))}\n\n`);
        }
      };
      const onRow = (e) => { if (e?.conversationId !== conv) return; try { flush(); } catch { end("failed"); } };
      const onTyping = (e) => {
        if (e?.to !== account.address || !stillHers()) return;
        write(`event: typing\ndata: ${JSON.stringify({ on: !!e.on, until: e.until || 0 })}\n\n`);
      };
      // Timers first: `end` clears them, and the first flush may already end the stream.
      // A named event, not a comment, so the page can tell a live stream from a silently dead one.
      const beat = setInterval(() => write("event: ping\ndata: {}\n\n"), 15_000);
      const check = setInterval(() => { if (!stillHers()) { write("event: signedout\ndata: {}\n\n"); end("signed_out"); } }, recheckMs);
      const stop = setTimeout(() => end("cycle"), streamMs);
      for (const t of [beat, check, stop]) t.unref?.();
      req?.on?.("close", () => end("closed"));
      res.on?.("close", () => end("closed"));
      write("retry: 1500\n\n");
      db.historyBus.on("row", onRow);
      webCh?.events?.on?.("typing", onTyping);
      try { flush(); } catch (e) { log({ web_stream_failed: (e?.message ?? String(e)).split("\n")[0] }); end("failed"); }
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
