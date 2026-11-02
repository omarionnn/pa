// Reason Web, Saved (v2 handoff, HANDOFF §4 "Saved"; reference sheet-saved S-A / S-B and desk-saved,
// paper + night). What Reason made for the signed-in person, from src/saved.js's index; this file only
// draws it and takes their two marks (pin, remove from Saved).
//
//   GET  /web/saved                        the list: FIND SOMETHING, the kinds with counts, PINNED,
//                                          THIS WEEK / EARLIER IN <MONTH> / IN <MONTH>, "+ N more".
//                                          On a desktop the newest (or pinned) item is opened beside it.
//   GET  /web/saved/<kind>/<id>            the same, with that item opened: its typed line, PIN ·
//                                          OPEN THE PAGE ↗ · FIND IT IN THE CHAT →, the real page on
//                                          paper, REMOVE FROM SAVED. On a phone: the item alone, ← SAVED.
//   GET  /web/saved/page/<id>/frame        the page itself, as files.heyreason.com draws it, for the
//                                          paper card (same origin, framed by this page only)
//   POST /web/saved/pin|remove|restore     their marks. Same origin + the session's secret, like
//                                          /web/send; a plain form that comes back to the page.
//
// Nothing here changes the thing itself: removing hides it from Saved, and "PUT IT BACK" undoes that.
import * as db from "../db.js";
import { timingSafeEqual } from "node:crypto";
import { clock } from "../config.js";
import { readCookie, pageUrl } from "./access.js";
import { esc, renderNotFound, renderPage } from "./render.js";
import { webPage, wordmark, hand, typed, stamp, label } from "./webkit.js";
import { SECURITY_HEADERS, sameOrigin } from "./websignin.js";
import { tabBar } from "./webconvo.js";
import { ongoing } from "../ongoing.js";
import { eventUrl } from "../events.js";
import { manageUrl, whenLine } from "../albums.js";
import { savedItems, findSaved, matches, messageFor, setPinned, removeSaved, restoreSaved, FILTERS, KEY, groupOf, clockTime, monthDay } from "../saved.js";

/** How many rows THIS WEEK shows, and how many each earlier heading shows, before "+ N more" (reference: 4, then 1). */
export const WEEK_TOP = 5;
export const EARLIER_TOP = 1;
/** The Caveat line under an opened item (the reference's quotes a phrase to ask with; per owner rule 10-25 it says the intent). */
export const AGAIN_NOTE = "want this again next time? just ask me for it in the chat.";
export const EMPTY = { title: ["Nothing saved", "yet."], note: ["anything i make for you,", "a list, a call, a receipt, lands here."] };
export const EMPTY_PAGES = { title: ["No pages", "yet."], note: ["when i make you a page,", "a list, a plan, a receipt, it lands here."] };

const KIND_WORD = { page: "PAGE", call: "CALL", receipt: "RECEIPT", event: "EVENT", album: "ALBUM" };
const filterOf = (v) => (FILTERS.some(([k]) => k === v) ? v : "all");
const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString(); return s ? `?${s}` : ""; };
const itemHref = (it, ctx) => `/web/saved/${it.kind}/${encodeURIComponent(it.id)}${qs({ kind: ctx.kind === "all" ? "" : ctx.kind, q: ctx.q })}`;
const stampHtml = (s, i = 0) => `<span class="sv-st sv-st-${s.tone}" style="transform:rotate(${i % 2 ? "2deg" : "-3deg"})">${esc(s.text)}</span>`;

// ---------------------------------------------------------------- the list

function kindsNav(all, ctx) {
  return `<nav class="sv-kinds" aria-label="Kinds">${FILTERS.map(([k, word, kinds]) => {
    const n = all.filter(i => kinds.includes(i.kind)).length;
    const cur = ctx.kind === k;
    return `<a href="/web/saved${qs({ kind: k === "all" ? "" : k, q: ctx.q })}"${cur ? ` aria-current="true"` : ""}>${word}${cur ? ` ${n}` : ""}</a>`;
  }).join("")}</nav>`;
}

function pinnedCard(it, ctx) {
  const at = it.kind === "event" && it.startsAt ? it.startsAt : it.at;
  const [mon, day] = monthDay(at, it.tz).split(" ");
  return `<a class="sv-pin card-like" href="${esc(itemHref(it, ctx))}"><span class="sv-date" aria-hidden="true"><span>${esc(mon)}</span><span>${esc(day)}</span></span>`
    + `<span class="sv-pt"><span class="sv-pm">${esc(it.meta)}</span><span class="sv-ptt">${esc(it.title)}</span></span></a>`;
}

function row(it, ctx, i, open) {
  const cur = open?.key === it.key;
  const right = it.stamp ? stampHtml(it.stamp, i) : `<span class="sv-d">${esc(it.day)}</span>`;
  return `<a class="sv-row${it.stamp ? " st" : ""}" href="${esc(itemHref(it, ctx))}"${cur ? ` aria-current="true"` : ""}><span class="sv-t">${esc(it.title)}</span>${right}<span class="sv-m">${esc(it.meta)}</span><span></span></a>`;
}

/** The list column: header, find, kinds, PINNED, the time groups. */
function listHtml({ all, shown, ctx, open, now, notice }) {
  const pinned = shown.filter(i => i.pinnedAt).sort((a, b) => b.pinnedAt - a.pinnedAt);
  const rest = shown.filter(i => !i.pinnedAt);
  const groups = [];
  for (const it of rest) {
    const g = groupOf(it.at, now, it.tz);
    let cur = groups.find(x => x.key === g.key);
    if (!cur) groups.push(cur = { ...g, rows: [] });
    cur.rows.push(it);
  }
  const folded = !ctx.all && !ctx.q && ctx.kind === "all";
  let n = 0;
  const sections = groups.map((g) => {
    const top = folded ? (g.key === "week" ? WEEK_TOP : EARLIER_TOP) : g.rows.length;
    // The opened item is always drawn, so the row it belongs to is never folded away.
    const vis = g.rows.filter((r, i) => i < top || r.key === open?.key);
    const more = g.rows.length - vis.length;
    const id = `sv-g${++n}`;
    const moreHref = `/web/saved${qs({ all: "1", kind: ctx.kind === "all" ? "" : ctx.kind })}#${id}`;
    const moreDesk = g.earlier ? `+ ${more} earlier in ${g.month[0]}${g.month.slice(1).toLowerCase()}` : `+ ${more} more`;
    return `<section class="sv-g" aria-labelledby="${id}"><h2 id="${id}" class="sv-h">${esc(g.title)}</h2>`
      + vis.map((r, i) => row(r, ctx, i, open)).join("")
      + (more ? `<a class="sv-more" href="${esc(moreHref)}"><span class="ph">+ ${more} more</span><span class="dk">${esc(moreDesk)}</span></a>` : "")
      + `</section>`;
  }).join("");
  const kindWord = FILTERS.find(([k]) => k === ctx.kind)?.[1].toLowerCase() ?? "";
  const none = !shown.length
    ? hand(ctx.q ? "nothing saved matches that. try fewer words." : `no ${kindWord} saved yet.`, { tilt: true, role: "status" })
    : "";
  return `<section class="sv-list" aria-label="Saved list">`
    // Pages only (where the wordmark on every page Reason made brings them): "Your pages".
    + (ctx.kind === "pages"
      ? `<div class="sv-hd"><h1 class="sv-h1">Your pages</h1><p class="sv-sub">Every page Reason made for you, newest first.</p></div>`
      : `<div class="sv-hd"><h1 class="sv-h1">Saved</h1><p class="sv-sub">Everything Reason made for you, kept.</p></div>`)
    + (notice || "")
    + `<form class="sv-find" method="GET" action="/web/saved" role="search"><label for="sv-find">FIND SOMETHING</label>`
    + (ctx.kind !== "all" ? `<input type="hidden" name="kind" value="${esc(ctx.kind)}">` : "")
    + `<input id="sv-find" name="q" type="search" value="${esc(ctx.q)}" placeholder="the dinner list, the dentist call…" autocomplete="off" enterkeyhint="search"></form>`
    + kindsNav(all, ctx)
    + (pinned.length ? `<section class="sv-pinned" aria-labelledby="sv-pinned"><h2 id="sv-pinned" class="sv-h pen">PINNED</h2>`
      + `<div class="ph">${pinned.map(p => pinnedCard(p, ctx)).join("")}</div>`
      + `<div class="dk">${pinned.map(p => `<a class="sv-row sv-prow" href="${esc(itemHref(p, ctx))}"${open?.key === p.key ? ` aria-current="true"` : ""}><span class="sv-ptt">${esc(p.title)}</span><span class="sv-d">${esc(monthDay(p.kind === "event" && p.startsAt ? p.startsAt : p.at, p.tz))}</span></a>`).join("")}</div></section>` : "")
    + sections + none + `</section>`;
}

// ---------------------------------------------------------------- the opened item

const line = (k, v) => (v ? `<div class="op-l"><span class="lbl">${esc(k)}</span><span class="op-v">${esc(v)}</span></div>` : "");
const dur = (s) => (s ? `${Math.floor(s / 60)} MIN ${Math.round(s) % 60} SEC` : "");

/** What each kind draws on the paper. A page is the page itself; the others are what their row really holds. */
function paper(it) {
  const r = it.row ?? {};
  if (it.kind === "page") {
    const src = `/web/saved/page/${encodeURIComponent(it.id)}/frame`;
    return `<div class="op-card framed"><iframe class="op-frame" src="${esc(src)}" title="${esc(it.title)}" loading="lazy" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"></iframe><div class="op-pad">${hand(AGAIN_NOTE, { cls: "op-note" })}</div></div>`;
  }
  let inner = `<h2 class="op-h">${esc(it.title)}</h2>${it.stamp ? stamp(it.stamp.text, it.stamp.tone) : ""}`;
  if (it.kind === "call") {
    const rec = r.recording_state === "stored" ? (/record/i.test(r.announcement || "") ? "RECORDED, AND THEY KNEW" : "RECORDED") : "";
    inner += label([dur(r.duration_s), rec].filter(Boolean).join(" · "))
      + `<div class="op-sec">${label("WHAT HAPPENED")}<p class="op-p">${esc(r.summary)}</p></div>`
      + (r.outcome ? `<div class="op-sec">${label("HOW IT ENDED")}<p class="op-p">${esc(r.outcome)}</p></div>` : "")
      + (String(r.transcript ?? "").trim() ? `<details class="op-tr"><summary class="act2">THE TRANSCRIPT</summary><pre>${esc(r.transcript)}</pre></details>` : "");
  } else if (it.kind === "receipt") {
    inner += `<div class="op-ls">${line("WHAT", r.what)}${line("FROM", r.merchant)}${line("TOTAL", r.amount_cents ? `$${(r.amount_cents / 100).toFixed(2)}` : "")}`
      + `${line("ORDER", r.retailer_order_id || r.order_id)}${line("DELIVERY", r.delivery_window)}</div>`;
  } else if (it.kind === "event") {
    inner += `<div class="op-ls">${line("WHEN", r.starts_at ? whenLine(r.starts_at, r.tz) : "")}${line("WHERE", r.location)}`
      + `${line("GUESTS", String(r.guests ?? 0))}${line("STATUS", String(r.status ?? "").toUpperCase())}</div>`
      + (String(r.description ?? "").trim() ? `<p class="op-p">${esc(r.description)}</p>` : "");
  } else if (it.kind === "album") {
    inner += `<div class="op-ls">${line("PHOTOS", String(r.photos ?? 0))}${line("SHARED", r.released_at ? whenLine(r.released_at, r.tz) : "NOT YET")}`
      + `${line("CLOSES", r.expires_at ? whenLine(r.expires_at, r.tz) : "")}</div>`;
  }
  return `<div class="op-card">${inner}${hand(AGAIN_NOTE, { cls: "op-note" })}</div>`;
}

/** The real page's own address, when the thing has one. */
function openUrl(it) {
  if (it.kind === "page") return pageUrl(it.id);
  if (it.kind === "event") return eventUrl(it.row);
  if (it.kind === "album") return manageUrl({ public_id: it.row.public_id, organizer_token: it.row.organizer_token });
  return "";
}

function openedHtml(it, { csrf, conv, auto, back }) {
  const made = `${KIND_WORD[it.kind]} · MADE ${it.day} ${clockTime(it.at, it.tz)}${it.note && it.kind !== "call" ? ` · ${it.note}` : ""}`;
  const url = openUrl(it);
  const msg = messageFor(conv, it);
  const hidden = (k, v) => `<input type="hidden" name="${k}" value="${esc(v)}">`;
  const pinForm = `<form method="POST" action="/web/saved/pin">${hidden("c", csrf)}${hidden("k", it.key)}${hidden("on", it.pinnedAt ? "0" : "1")}${hidden("back", back)}`
    + `<button class="op-a" type="submit">${it.pinnedAt ? "UNPIN" : "PIN"}</button></form>`;
  return `<section class="sv-open${auto ? " auto" : ""}" aria-label="Opened">`
    + `<a class="act2 sv-back" href="/web/saved">← SAVED</a>`
    + `<div class="op-top"><span class="op-what">${esc(made)}</span><span class="op-acts">${pinForm}`
    + (url ? `<a class="op-a" href="${esc(url)}" target="_blank" rel="noopener">OPEN THE PAGE ↗</a>` : "")
    + (msg ? `<a class="op-a" href="/web?thread&amp;at=${msg}#m-${msg}">FIND IT IN THE CHAT →</a>` : "")
    + `</span></div>${paper(it)}`
    + `<form method="POST" action="/web/saved/remove">${hidden("c", csrf)}${hidden("k", it.key)}<button class="op-rm" type="submit">REMOVE FROM SAVED</button></form>`
    + `</section>`;
}

// ---------------------------------------------------------------- the page

const CSS = `
.sv-top{display:flex;align-items:center;justify-content:space-between;padding:11px var(--gut) 0}
.sv-top nav{display:none}
.sv-wrap{flex-grow:1;width:100%;display:flex;flex-direction:column}
.sv-list{padding:32px var(--gut) 24px;display:flex;flex-direction:column;gap:30px}
.sv-hd{display:flex;flex-direction:column;gap:8px}
.sv-h1{margin:0;font:italic 400 44px/1.05 var(--serif);letter-spacing:-.02em}
.sv-sub{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}
.sv-find{display:flex;flex-direction:column;gap:6px}
.sv-find label{font:400 10.5px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.sv-find input{height:44px;border:0;border-bottom:1px solid var(--ink);border-radius:0;background:transparent;outline:none;font:italic 400 20px/1.2 var(--serif);color:var(--ink);padding:0;width:100%;-webkit-appearance:none;appearance:none}
.sv-find input::placeholder{color:var(--muted)}
.sv-find input:focus-visible{border-bottom-width:2px;caret-color:var(--pen)}
.sv-kinds{display:flex;gap:18px;flex-wrap:wrap}
.sv-kinds a{min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:400 11px/1.3 var(--mono);letter-spacing:.12em;color:var(--muted);border-bottom:1.5px solid transparent}
.sv-kinds a[aria-current]{color:var(--ink);border-bottom-color:var(--ink)}
.sv-h{margin:0 0 4px;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.sv-h.pen{color:var(--pen)}
.sv-pinned{display:flex;flex-direction:column;gap:12px}
.sv-pinned .ph{display:flex;flex-direction:column;gap:12px}
.sv-pin{text-decoration:none;background:var(--lifted);border:1px solid var(--hair);box-shadow:var(--sh);padding:16px 18px;display:flex;gap:14px;align-items:center}
.sv-date{width:54px;height:54px;flex-shrink:0;background:var(--lifted);border:1px solid var(--hair);display:flex;flex-direction:column;align-items:center;justify-content:center;transform:rotate(-3deg)}
.sv-date span:first-child{font:400 9px/1.3 var(--mono);letter-spacing:.12em;color:var(--pen)}
.sv-date span:last-child{font:italic 400 24px/1 var(--serif)}
.sv-pt{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.sv-pm{font:400 10px/1.4 var(--mono);letter-spacing:.12em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv-ptt{font:italic 400 22px/1.1 var(--serif);overflow-wrap:anywhere}
.sv-g{display:flex;flex-direction:column}
.sv-row{text-decoration:none;line-height:normal;padding:14px 0;border-bottom:1px dashed var(--hair);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:baseline}
.sv-row.st{align-items:center}
.sv-t{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-d{font:400 10.5px/normal var(--mono);color:var(--muted);white-space:nowrap}
.sv-m{font:400 10px/normal var(--mono);letter-spacing:.12em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv-st{font:700 9.5px/normal var(--mono);border:1.5px solid currentColor;border-radius:3px;padding:2px 5px;white-space:nowrap}
.sv-st-pen{color:var(--pen)}.sv-st-ink{color:var(--ink)}.sv-st-muted{color:var(--muted)}
.sv-more{text-decoration:none;line-height:normal;padding:14px 0;font-size:16px;font-weight:600;color:var(--muted);min-height:44px;display:flex;align-items:baseline}
.sv-more .dk,.sv-pinned .dk{display:none}
.sv-note{display:flex;flex-direction:column;gap:4px}
.sv-note form{margin:0}
.sv-open{padding:24px var(--gut) 40px;display:flex;flex-direction:column;gap:18px}
.sv-open.auto{display:none}
.sv-has-open .sv-list{display:none}
.sv-back{align-self:flex-start}
.op-top{display:flex;justify-content:space-between;align-items:baseline;gap:4px 16px;flex-wrap:wrap}
.op-what{font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.op-acts{display:flex;gap:4px 22px;flex-wrap:wrap}
.op-acts form{margin:0}
.op-a{min-height:44px;display:inline-flex;align-items:center;border:0;background:transparent;padding:0;cursor:pointer;text-decoration:none;font:400 11px/1.3 var(--mono);letter-spacing:.14em;color:var(--ink)}
.op-a:hover{color:var(--hov)}
.op-card{background:var(--lifted);border:1px solid var(--hair);box-shadow:var(--sh2);padding:28px 22px;display:flex;flex-direction:column;gap:22px;min-width:0}
.op-card.framed{padding:0;gap:0;overflow:hidden}
.op-frame{display:block;width:100%;height:900px;border:0;background:var(--lifted)}
.op-pad{padding:18px 22px 24px}
.op-h{margin:0;font:italic 400 36px/1.05 var(--serif);overflow-wrap:break-word}
.op-card .stamp{margin-top:-6px}
.op-sec{display:flex;flex-direction:column;gap:6px}
.op-p{margin:0;font-size:16px;line-height:1.55;overflow-wrap:anywhere}
.op-ls{display:flex;flex-direction:column}
.op-l{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px;padding:10px 0;border-bottom:1px dashed var(--hair);align-items:baseline}
.op-v{font-size:16px;overflow-wrap:anywhere}
.op-tr pre{white-space:pre-wrap;overflow-wrap:anywhere;font:400 14px/1.55 var(--sans);margin:8px 0 0;color:var(--muted)}
.op-note{font-size:23px}
.op-rm{align-self:flex-start;min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:400 11px/1.3 var(--mono);letter-spacing:.14em;color:var(--muted)}
.op-rm:hover{color:var(--pen)}
.op-rm:focus-visible{outline-color:var(--pen)}
.sv-empty{flex-grow:1;padding:0 32px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center}
.sv-empty h1{margin:0;font:italic 400 42px/1.08 var(--serif)}
.sv-empty .hand{font-size:23px;line-height:1.25;transform:rotate(-1.5deg)}
body.has-tabs{padding-bottom:92px}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:6;background:var(--ground);border-top:1px solid var(--hair);padding:6px 16px calc(22px + env(safe-area-inset-bottom));display:flex;justify-content:space-around}
.tabs a{min-width:96px;min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;font:italic 400 21px/1 var(--serif);color:var(--muted)}
.tabs a[aria-current=page]{color:var(--ink)}
.tabs .n{font:700 11px/1 var(--mono);font-style:normal;color:var(--pen)}
@media (min-width:900px){
.sv-top{padding:13px clamp(20px,4vw,48px)}
.sv-top nav{display:flex;gap:28px}
.sv-top nav a{min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:400 12px/1.3 var(--mono);letter-spacing:.14em;color:var(--muted);border-bottom:1.5px solid transparent}
.sv-top nav a[aria-current]{color:var(--ink);border-bottom-color:var(--ink)}
.sv-wrap{max-width:1160px;margin:0 auto;padding:40px clamp(20px,4vw,48px) 64px;flex-direction:row;flex-wrap:wrap;gap:64px;align-items:flex-start}
.sv-list,.sv-has-open .sv-list{display:flex;flex:1 1 340px;max-width:400px;padding:0;gap:28px}
.sv-h1{font-size:56px;line-height:1.02}
.sv-sub{font-size:16px;line-height:1.55}
.sv-find input{font-size:21px}
.sv-pinned{gap:0}
.sv-pinned .ph,.sv-m,.sv-more .ph,.sv-back{display:none}
.sv-pinned .dk,.sv-more .dk{display:flex;flex-direction:column}
.sv-more .dk{display:inline}
.sv-more{font-weight:400}
.sv-g{margin-top:-6px}
.sv-row{display:flex;justify-content:space-between;gap:12px}
.sv-row>span:empty{display:none}
.sv-prow .sv-ptt{font-size:21px}
.sv-row[aria-current]{padding-left:14px;margin-left:-14px;border-left:2px solid var(--ink)}
.sv-list{gap:28px}
.sv-g,.sv-pinned{gap:0}
.sv-open,.sv-open.auto{display:flex;flex:999 1 460px;min-width:0;padding:0}
.op-card{padding:36px 40px;gap:26px}
.op-card.framed{padding:0}
.op-pad{padding:20px 40px 28px}
.op-h{font-size:44px}
.sv-empty h1{font-size:56px}
.tabs{display:none}
body.has-tabs{padding-bottom:0}
}
@media (max-width:359px){.sv-h1{font-size:38px}.sv-kinds{gap:14px}.tabs a{min-width:84px}}
`;

// The paper card holds the page at its own height; without script it scrolls inside a fixed one.
const FRAME_JS = `(function(){document.querySelectorAll('iframe.op-frame').forEach(function(f){function fit(){try{var d=f.contentDocument,m=d&&(d.querySelector('.sheet .wrap')||d.querySelector('main')||d.body);if(!m)return;var h=Math.ceil(m.getBoundingClientRect().bottom+(d.defaultView.scrollY||0))+8;f.style.height=Math.max(240,h)+'px'}catch(e){}}
f.addEventListener('load',function(){fit();setTimeout(fit,400);setTimeout(fit,1500)});window.addEventListener('resize',fit);fit()})})();`;

function topHtml() {
  const a = (href, t, cur) => `<a href="${href}"${cur ? ` aria-current="page"` : ""}>${t}</a>`;
  return `<header class="sv-top">${wordmark({ href: "/web?home" })}<nav aria-label="Account">${a("/web?thread", "CHAT")}${a("/web/saved", "SAVED", true)}${a("/web/memory", "MEMORY")}${a("/web/settings", "SETTINGS")}</nav></header>`;
}

/**
 * The whole Saved page. `open` is the item asked for (its own address); without one, a desktop opens
 * the first pinned item or the newest, and a phone shows the list alone.
 */
export function renderSaved({ account, csrf, query = {}, openKey = null, now = clock.now(), count = 0 }) {
  const conv = account.conversation_id;
  const all = savedItems(conv, { now });
  const ctx = { kind: filterOf(query.kind), q: String(query.q ?? "").trim().slice(0, 120), all: query.all != null };
  const kinds = FILTERS.find(([k]) => k === ctx.kind)[2];
  const shown = all.filter(i => kinds.includes(i.kind) && matches(i, ctx.q));
  let open = openKey ? all.find(i => i.key === openKey) ?? null : null;
  const asked = !!open;
  if (!open) open = shown.find(i => i.pinnedAt) ?? shown[0] ?? null;
  let notice = "";
  const gone = KEY.test(String(query.removed ?? "")) ? findSaved(conv, query.removed, { now }) : null;
  if (gone && !all.some(i => i.key === gone.key)) {
    notice = `<div class="sv-note" role="status">${hand(`taken out of saved. the ${KIND_WORD[gone.kind].toLowerCase()} itself is still there.`)}`
      + `<form method="POST" action="/web/saved/restore"><input type="hidden" name="c" value="${esc(csrf)}"><input type="hidden" name="k" value="${esc(gone.key)}"><button class="op-a" type="submit">PUT IT BACK</button></form></div>`;
  }
  let main;
  if (!all.length) {
    const e = ctx.kind === "pages" ? EMPTY_PAGES : EMPTY;
    main = `<main class="sv-empty" aria-labelledby="sv-e">${notice}<h1 id="sv-e">${esc(e.title[0])}<br>${esc(e.title[1])}</h1>`
      + `<p class="hand">${esc(e.note[0])}<br>${esc(e.note[1])}</p></main>`;
  } else {
    const back = open ? itemHref(open, ctx) : "/web/saved";
    main = `<main class="sv-wrap${asked ? " sv-has-open" : ""}">${listHtml({ all, shown, ctx, open, now, notice })}`
      + (open ? openedHtml(open, { csrf, conv, auto: !asked, back }) : "") + `</main>`;
  }
  const listName = ctx.kind === "pages" ? "Your pages" : "Saved";
  const title = asked ? `${open.title} · ${listName} · Reason` : `${listName} · Reason`;
  return webPage({ title, body: topHtml() + main + tabBar("saved", count), css: CSS, script: FRAME_JS, bodyClass: "has-tabs", foot: "" });
}

/**
 * The page itself, as its own host draws it, for the paper card. Read-only: no choice buttons, no
 * theme switch, and no script at all — the frame is sandboxed without scripts and served under a CSP
 * that forbids them, so nothing a page carries can reach the signed-in Web page around it. The theme
 * is drawn server-side: the person's Web choice (paper | night), else the phone's.
 */
export function renderFrame(page, { theme = null } = {}) {
  const picked = db.pageChoicesFor(page.id);
  const html = renderPage(page, { interactive: false, picked, printing: true });
  const t = theme === "paper" ? ` data-theme="light"` : theme === "night" ? ` data-theme="dark"` : "";
  return html.replace(/<html lang="en">/, `<html lang="en"${t}>`).replace(/<head[^>]*>/, (m) => `${m}<base target="_top">`);
}
export const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https:; font-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'self'";

// ---------------------------------------------------------------- routes

const PAGE_HEADERS = { ...SECURITY_HEADERS, "Content-Security-Policy": SECURITY_HEADERS["Content-Security-Policy"].replace("frame-ancestors 'none'", "frame-src 'self'; frame-ancestors 'none'") };
const html = (status, body, headers = PAGE_HEADERS) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers, "Content-Length": Buffer.byteLength(body) }, body });
const to = (location) => ({ status: 303, headers: { ...SECURITY_HEADERS, Location: location, "Content-Length": 0 }, body: "" });
function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
const safeBack = (v) => (/^\/web\/saved(\/(page|call|receipt|event|album)\/[A-Za-z0-9_-]{1,40})?(\?[A-Za-z0-9_=&%+.-]*)?$/.test(String(v ?? "")) ? String(v) : "/web/saved");

/**
 * Everything under /web/saved. `path` is what follows /web/saved/ ("" for the list). `account` is the
 * session's; every key is looked up inside its conversation, so another person's is a flat 404.
 */
export async function savedRequest({ account, path = "", method, query = {}, headers = {}, readBody, log = () => {}, now = clock.now() }) {
  const conv = account.conversation_id;
  const csrf = db.pageSessionCsrf(readCookie(headers.cookie));
  const count = () => { const m = ongoing(conv, now); return m.items.length + m.approvals.length + m.back.length; };
  const frame = /^page\/([A-Za-z0-9_-]{1,40})\/frame$/.exec(path);
  const item = /^(page|call|receipt|event|album)\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (method === "GET" || method === "HEAD") {
    if (frame) {
      const page = db.getPageIn(conv, frame[1]);
      if (!page) return html(404, renderNotFound(), SECURITY_HEADERS);
      return html(200, renderFrame(page, { theme: db.webTheme(conv) }), { ...SECURITY_HEADERS, "Content-Security-Policy": FRAME_CSP, "X-Frame-Options": "SAMEORIGIN" });
    }
    if (item) {
      const key = `${item[1]}-${item[2]}`;
      if (!savedItems(conv, { now }).some(i => i.key === key)) return html(404, renderNotFound());
      return html(200, renderSaved({ account, csrf, query, openKey: key, now, count: count() }));
    }
    if (path) return html(404, renderNotFound());
    return html(200, renderSaved({ account, csrf, query, now, count: count() }));
  }
  if (method !== "POST" || !["pin", "remove", "restore"].includes(path)) return html(405, renderNotFound());
  const form = new URLSearchParams((await readBody()) ?? "");
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), csrf)) {
    log({ web_saved_refused: "origin_or_token" });
    return html(403, renderNotFound());
  }
  const key = String(form.get("k") ?? "");
  if (!KEY.test(key)) return html(404, renderNotFound());
  if (path === "pin") {
    if (!setPinned(conv, key, form.get("on") === "1")) return html(404, renderNotFound());
    log({ web_saved_pin: form.get("on") === "1" });
    return to(safeBack(form.get("back")));
  }
  if (path === "remove") {
    if (!removeSaved(conv, key)) return html(404, renderNotFound());
    log({ web_saved_removed: true });
    return to(`/web/saved?removed=${encodeURIComponent(key)}`);
  }
  if (!restoreSaved(conv, key)) return html(404, renderNotFound());
  log({ web_saved_restored: true });
  const m = KEY.exec(key);
  return to(`/web/saved/${m[1]}/${encodeURIComponent(m[2])}`);
}
