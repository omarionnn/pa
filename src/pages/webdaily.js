// Reason Web Home as the daily edition (owner's design handoff 2026-10-27, reference/home.html, drawn
// exactly; HANDOFF.md §1). Shown in place of today's Home when REASON_WEB_DAILY allows the session's
// conversation (src/dailyflag.js); the data is src/daily.js.
//
//   header      wordmark; HOME · THE THREAD · STAMPS (HOME current, a 1.5px pen underline)
//   masthead    NO. n · THE {WEEKDAY} EDITION, the full date, Reason's Caveat greeting, a double rule
//   Overnight   newest first, at most 5 then "N more in the thread": decision (two replies a tap sends
//               into the thread through /web/send, as if typed), update (into the thread at that
//               message), done (the DONE stamp and one line). First day: "Nothing yet. Text me…"
//   Lines out   name, typed status at the right (pen when it's within a day), muted detail; hidden when none
//   aside       One question today (an open guess; the answer goes to Memory; "Ask me later") and New in
//               your book (the newest stamp of the last 7 days); each hidden when there is none
//   pick up     the thread's last two lines, the last one's time, "Continue the thread →"
//   sign-off    "see you tomorrow. or don't, I'll keep the page."
//
// No composer (Home's fresh Web chat lives on the thread page while this is on: webconvo NEW_CHAT,
// SCOPE-v2 Q-v2-54). Every action is a real form: it works without script and lands back here.
import { esc } from "./render.js";
import { webPage, wordmark } from "./webkit.js";
import { DECISION, ANSWERS, FIRST_EMPTY, SIGN_OFF, OVERNIGHT_MAX, timeLabel, sendIdFor } from "../daily.js";
import { clock } from "../config.js";

const hidden = (n, v) => `<input type="hidden" name="${n}" value="${esc(v)}">`;

/** The shared top of the daily screens: HOME · THE THREAD · STAMPS (STAMPS only when that page exists). */
export function dailyHead(active = "home", { stamps = false } = {}) {
  const link = (key, text, href) => `<a href="${href}"${active === key ? ` aria-current="page"` : ""}>${text}</a>`;
  return `<header class="dh">${wordmark({ href: "/web?home" })}<nav class="dh-n" aria-label="Reason">`
    + link("home", "HOME", "/web?home") + link("thread", "THE THREAD", "/web?thread") + (stamps ? link("stamps", "STAMPS", "/web/stamps") : "")
    + `</nav></header>`;
}

const weekday = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const fullDate = (day) => `${new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}.`;

function overnightItem(x, { csrf, now, tz, last }) {
  const time = `<span class="dd-t"><time datetime="${new Date(x.at).toISOString()}">${esc(timeLabel(x.at, now, tz))}</time></span>`;
  const cls = `dd-i${last ? " last" : ""}`;
  if (x.kind === "done") {
    return `<article class="${cls}">${time}<div class="dd-done"><span class="dd-stamp">DONE</span><p>${esc(x.headline)}</p></div></article>`;
  }
  let foot = "";
  if (x.kind === "decision") {
    const acts = (x.actions?.length ? x.actions : DECISION);
    foot = `<form class="dd-acts" method="POST" action="/web/send">${hidden("c", csrf)}${hidden("id", sendIdFor())}${x.chat ? hidden("chat", x.chat) : ""}`
      + acts.map(a => `<button class="${a.primary ? "dd-p" : "dd-s"}" type="submit" name="text" value="${esc(a.reply)}">${esc(a.label)}</button>`).join("")
      + `</form>`;
  } else {
    const href = x.threadMessageId ? `/web?at=${Number(x.threadMessageId)}` : (x.href || "/web?thread");
    foot = `<a class="dd-l" href="${esc(href)}">${esc(x.linkText || "Read it in the thread")}</a>`;
  }
  return `<article class="${cls}">${time}<div class="dd-b"><h2 class="dd-h">${esc(x.headline)}</h2>`
    + (x.detail ? `<p class="dd-d">${esc(x.detail)}</p>` : "") + foot + `</div></article>`;
}

function overnightHtml(ed, { csrf, now }) {
  const shown = ed.overnight.slice(0, OVERNIGHT_MAX);
  const more = ed.overnight.length - shown.length;
  let inner;
  if (!shown.length) inner = `<p class="dd-none">${esc(ed.first ? FIRST_EMPTY : "Nothing new since you last looked.")}</p>`;
  else inner = shown.map((x, i) => overnightItem(x, { csrf, now, tz: ed.tz, last: i === shown.length - 1 && !more })).join("")
    + (more ? `<a class="dd-l dd-more" href="/web?thread">${more} more in the thread</a>` : "");
  return `<section class="dd-on" aria-label="Overnight"><p class="dd-lbl">OVERNIGHT</p>${inner}</section>`;
}

function linesHtml(lines) {
  if (!lines.length) return "";
  return `<section class="dd-lo" aria-label="Still watching"><div class="dd-loh"><p class="dd-lbl">LINES OUT</p><span class="dd-hand">I check these every few hours</span></div>`
    + `<ul class="dd-card dd-ul">${lines.map(l => `<li><span class="dd-ln">${esc(l.name)}</span><span class="dd-ls${l.urgent ? " urgent" : ""}">${esc(l.status)}</span>`
      + (l.detail ? `<span class="dd-ld">${esc(l.detail)}</span>` : "") + `</li>`).join("")}</ul></section>`;
}

function questionHtml(q, csrf) {
  if (!q) return "";
  return `<section class="dd-card dd-q" aria-label="One question today"><p class="dd-lbl sm">ONE QUESTION TODAY</p>`
    + `<h2 class="dd-qh">${esc(q.text)}</h2><p class="dd-why">${esc(q.why)}</p>`
    + `<form class="dd-qa" method="POST" action="/web/daily/answer">${hidden("c", csrf)}${hidden("q", q.id)}`
    + ANSWERS.map(a => `<button class="dd-o" type="submit" name="answer" value="${a.value}">${esc(a.label)}</button>`).join("")
    + `<button class="dd-later" type="submit" formaction="/web/daily/later">Ask me later</button></form>`
    + `<a class="dd-mem" href="/web/memory">YOUR ANSWER GOES TO MEMORY →</a></section>`;
}

/** New in your book: the newest stamp of the last 7 days, drawn by src/stamps.js (`markup`), linking to Stamps. */
function stampHtml(stamp, markup) {
  if (!stamp || !markup) return "";
  return `<a class="dd-nb" href="/web/stamps"><span class="dd-nbs">${markup}</span><span class="dd-nbt"><span class="dd-lbl sm">NEW IN YOUR BOOK</span>`
    + `<span class="dd-nbl">${esc(stamp.story || stamp.name)}</span></span></a>`;
}

function pickupHtml(p, { now, tz }) {
  if (!p) return "";
  const head = p.surface === "web" ? "pick up where you left off" : `pick up from ${p.where}`;
  const when = `${p.surface === "web" ? "LAST MESSAGE" : "LAST TEXT"} · <time datetime="${new Date(p.lastAt).toISOString()}">${esc(timeLabel(p.lastAt, now, tz))}</time>`;
  return `<a class="dd-pk" href="/web?thread" aria-label="${esc(head[0].toUpperCase() + head.slice(1))}: continue the thread">`
    + `<span class="dd-pkh"><span class="dd-hand lg">${esc(head)}</span><span class="dd-dash" aria-hidden="true"></span><span class="dd-lbl xs">${when}</span></span>`
    + `<span class="dd-pkl">${p.lines.map(l => `<span class="${l.role === "user" ? "dd-you" : "dd-re"}">${esc(l.text)}</span>`).join("")}</span>`
    + `<span class="dd-go">Continue the thread →</span></a>`;
}

/**
 * The edition page. `edition` is src/daily.js editionFor's; `stampMarkup` draws the newest stamp
 * (src/stamps.js) when that build is in; `stamps` says whether /web/stamps exists for the header.
 */
export function renderDaily({ edition: ed, csrf, now = clock.now(), stampMarkup = null, stamps = false }) {
  const aside = questionHtml(ed.question, csrf) + stampHtml(ed.newestStamp, ed.newestStamp && stampMarkup ? stampMarkup(ed.newestStamp, { size: 96 }) : "");
  const body = dailyHead("home", { stamps })
    + `<main class="dd" id="edition"><div class="dd-mast"><p class="dd-lbl">NO. ${Number(ed.issueNumber)} · THE ${esc(weekday(ed.date).toUpperCase())} EDITION</p>`
    + `<h1 class="dd-date">${esc(fullDate(ed.date))}</h1><p class="dd-greet">${esc(ed.greeting)}</p>`
    + `<div class="dd-rule" aria-hidden="true"><span></span><span></span></div></div>`
    + `<div class="dd-cols"><div class="dd-main">${overnightHtml(ed, { csrf, now })}${linesHtml(ed.linesOut)}</div>`
    + (aside ? `<aside class="dd-aside">${aside}</aside>` : "") + `</div></main>`
    + `<div class="dd-foot">${pickupHtml(ed.pickup, { now, tz: ed.tz })}<p class="dd-off">${esc(SIGN_OFF)}</p></div>`;
  return webPage({ title: "Reason", body, css: CSS, loader: true });
}

// Every size, colour and space from reference/home.html, on the kit's tokens (Paper and Night).
export const CSS = `
body{min-height:100vh}
.dh{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 24px;padding:22px clamp(20px,4vw,48px)}
.dh .wm{font-size:26px}.dh .wm .bub{width:.577em;height:.577em}
.dh-n{display:flex;flex-wrap:wrap;gap:4px 28px;font:400 12px/1.2 var(--mono);letter-spacing:.14em}
.dh-n a{text-decoration:none;padding:14px 0;min-height:44px;display:inline-flex;align-items:center;box-sizing:border-box;border-bottom:1.5px solid transparent}
.dh-n a[aria-current=page]{border-bottom-color:var(--pen)}
.dd{flex-grow:1;width:100%;max-width:1080px;margin:0 auto;padding:56px 24px 48px;display:flex;flex-direction:column;gap:48px}
.dd-lbl{margin:0;font:400 12px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.dd-lbl.sm{font-size:11px}.dd-lbl.xs{font-size:11.5px}
.dd-mast{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.dd-date{margin:0;font:italic 400 clamp(44px,7vw,72px)/1.02 var(--serif);letter-spacing:-.02em}
.dd-greet{margin:0;font:400 30px/1.15 var(--hand);color:var(--pen);transform:rotate(-1.2deg)}
.dd-rule{width:100%;display:flex;flex-direction:column;gap:3px;margin-top:18px}.dd-rule span{border-top:1px solid var(--ink)}
.dd-cols{display:flex;flex-wrap:wrap;gap:56px}
.dd-main{flex:1 1 540px;min-width:0;display:flex;flex-direction:column;gap:48px}
.dd-on{display:flex;flex-direction:column}.dd-on>.dd-lbl{margin:0 0 6px}
.dd-i{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 20px;padding:22px 0;border-bottom:1px dashed var(--hair)}
.dd-i.last{border-bottom:0}
.dd-t{font:400 12px/1.4 var(--mono);letter-spacing:.08em;color:var(--muted);padding-top:6px}
.dd-b{display:flex;flex-direction:column;gap:8px;min-width:0}
.dd-h{margin:0;font:italic 400 30px/1.15 var(--serif);overflow-wrap:break-word}
.dd-d{margin:0;font-size:16px;line-height:1.55;color:var(--muted)}
.dd-acts{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0 0}
.dd-p{height:44px;padding:0 20px;border:0;border-radius:3px;background:var(--ink);color:var(--ground);font:500 15px/1 var(--sans);cursor:pointer}
.dd-s{height:44px;padding:0 16px;border:1px solid var(--hair);border-radius:3px;background:transparent;color:var(--ink);font:400 15px/1 var(--sans);cursor:pointer}
.dd-l{align-self:flex-start;font-size:15px;padding:12px 0;text-underline-offset:4px}
.dd-more{margin-top:6px}
.dd-done{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.dd-done p{margin:0;font-size:17px;line-height:1.5}
.dd-stamp{font:700 11px/1.3 var(--mono);letter-spacing:.12em;color:var(--pen);border:1.5px solid var(--pen);border-radius:3px;padding:3px 8px;transform:rotate(-3deg)}
.dd-none{margin:0;padding:22px 0;font-size:17px;line-height:1.5}
.dd-lo{display:flex;flex-direction:column;gap:6px}
.dd-loh{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.dd-hand{font:400 22px/1.2 var(--hand);color:var(--pen)}.dd-hand.lg{font-size:28px}
.dd-card{background:var(--lifted);border:1px solid var(--hair);border-radius:4px;box-shadow:var(--sh)}
.dd-ul{margin:0;list-style:none;padding:4px 24px}
.dd-ul li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;padding:18px 0;border-bottom:1px dashed var(--hair);align-items:baseline}
.dd-ul li:last-child{border-bottom:0}
.dd-ln{font-size:17px;font-weight:500}
.dd-ls{font:400 12px/1.4 var(--mono);letter-spacing:.1em;color:var(--muted);text-align:right}.dd-ls.urgent{color:var(--pen)}
.dd-ld{font-size:15px;color:var(--muted)}
.dd-aside{flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:40px;padding-left:clamp(0px,3vw,36px);border-left:1px dashed var(--hair)}
.dd-q{padding:24px;display:flex;flex-direction:column;gap:14px}
.dd-qh{margin:0;font:italic 400 34px/1.1 var(--serif);overflow-wrap:break-word}
.dd-why{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}
.dd-qa{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.dd-o{height:44px;padding:0 18px;border:1px solid var(--ink);border-radius:3px;background:transparent;color:var(--ink);font:400 15px/1 var(--sans);cursor:pointer}
.dd-later{height:44px;padding:0 12px;border:0;background:transparent;color:var(--muted);font:400 15px/1 var(--sans);cursor:pointer;text-decoration:underline;text-underline-offset:4px}
.dd-mem{font:400 11px/1.4 var(--mono);letter-spacing:.12em;text-decoration:none;padding:10px 0 0;color:var(--muted);min-height:44px;display:inline-flex;align-items:center;align-self:flex-start}
.dd-nb{text-decoration:none;display:flex;align-items:center;gap:20px}
.dd-nbs{flex-shrink:0;display:inline-flex}
.dd-nbt{display:flex;flex-direction:column;gap:6px}
.dd-nbl{font-size:16px;line-height:1.45;color:var(--ink)}
.dd-foot{width:100%;max-width:1080px;margin:0 auto;padding:8px 24px 64px;display:flex;flex-direction:column;gap:28px}
.dd-pk{text-decoration:none;display:flex;flex-direction:column;gap:12px}
.dd-pkh{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.dd-dash{flex-grow:1;border-top:1px dashed var(--hair);min-width:40px}
.dd-pkl{display:flex;flex-direction:column;gap:10px;padding-left:20px;border-left:1px solid var(--hair)}
.dd-you{align-self:flex-end;text-align:right;font:italic 400 22px/1.3 var(--serif);color:var(--muted)}
.dd-re{font-size:17px;line-height:1.5;color:var(--ink)}
.dd-go{align-self:flex-end;font:italic 400 26px/1.2 var(--serif);min-height:48px;display:inline-flex;align-items:center;color:var(--ink)}
.dd-off{margin:0;align-self:flex-end;font:400 26px/1.2 var(--hand);color:var(--pen);transform:rotate(-1deg)}
.dd-p:hover{opacity:.9}.dd-s:hover,.dd-o:hover{border-color:var(--ink)}
.dd-pk:focus-visible{outline-offset:4px}
`;
