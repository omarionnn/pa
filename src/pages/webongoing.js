// Reason Web's Ongoing, drawn (owner's design handoff 2026-10-26: HANDOFF.md "3 · Ongoing", reference
// ongoing-mobile, sheet-desktop-panel, sheet-details 2A–2E, ongoing-detail, sheet-global 9D). The rows
// are src/ongoing.js's; this file only draws them.
//
//   ogMargin        the list: the desktop margin, or the mobile Ongoing tab's body. NEEDS YOU (every
//                   approval: the first on a paper card), IN HAND, BACK TO YOU, each heading with its
//                   count; a typed status at the right of every row; each group's top three, then a
//                   serif "See all N →" (handoff v2, sheet 2A/2C, §4c item 2)
//   renderSeeAll    2B: one group's full list at /web/ongoing/{hand|back}, newest first, filter words
//                   with counts, a typed meta line on every row
//   homeRows        the arrival's "already in hand" as quiet rows between dashed rules (STAGING-REVIEW 7)
//   renderDetail    one row's own page at /web/ongoing/<kind>/<id>: ← ONGOING, a typed status, a serif
//                   headline, then what that kind of row really carries
//   ongoingRequest  GET /web/ongoing/… (src/http.js), signed in, the session's own rows only
//   NINE_D_JS       9D: the session ran out while something is in flight — "Still working on it. Sign
//                   back in to see." over the real card, faded, read off the page they were looking at
//
// Approving stays in the chat (no approve button, per the handoff); every nudge says so as intent,
// never as words to type (owner rule 10-25).
import { esc, renderNotFound } from "./render.js";
import { webPage, label, hand, action, typed, stamp, APPROVAL_NUDGE } from "./webkit.js";
import { SECURITY_HEADERS, sessionAccount } from "./websignin.js";
import { renderWebNotFound } from "./webedge.js";
import { findItem, ongoing, clockOf, periodOf } from "../ongoing.js";
import { clock, config } from "../config.js";

/** How many rows show before "See all N →" (PR #179, owner 10-26): needs-you first, then soonest due. */
export const OG_TOP = 3;
/** What the reference's NEEDS YOU card says under its link (mobile). */
export const OR_REPLY = "or just reply in the chat";

/** A description that only repeats the title says nothing. */
const same = (a, b) => String(a).toLowerCase().replace(/[^a-z0-9]/g, "") === String(b).toLowerCase().replace(/[^a-z0-9]/g, "");
const st = (text, pen = false) => `<span class="lbl${pen ? " pen" : ""}">${esc(text)}</span>`;
const top = (x, right) => `<span class="og-top"><b>${esc(x.title)}</b>${right}</span>`;
const GLYPH = { done: ["✓", "Done"], doing: ["○", "In progress"], todo: ["○", "Not started"] };
const glyph = (state) => `<span class="og-g" role="img" aria-label="${GLYPH[state][1]}">${GLYPH[state][0]}</span>`;
/** The 9D card's status for a row still in flight; nothing for one that isn't. */
const flight = (x) => (x.state === "working" || x.state === "waiting" || x.state === "stuck" ? ` data-flight="${esc(x.status)}"` : "");
const timeBig = (x, cls) => (x.time ? `<span class="${cls}">${esc(x.time)}${x.period ? `<span class="ampm">${esc(x.period)}</span>` : ""}</span>` : "");

/** The mobile checklist inside a working row: ✓ done, ○ pen in hand (with its live words), ○ muted not started. */
function checklist(steps) {
  if (!steps.length) return "";
  return `<span class="og-steps">${steps.slice(-6).map(s => `<span class="og-st og-st-${s.state}">${glyph(s.state)}<span class="og-tx">${esc(s.text)}${s.state === "doing" && s.live ? ` <span class="hand">${esc(s.live)}</span>` : ""}</span></span>`).join("")}</span>`;
}

/** One row of the list. `tab` draws the mobile tab's fuller row; otherwise the margin's. */
function row(x, { tab, fold }) {
  const a = (inner, cls = "") => `<a class="og-row${cls}${fold}" href="${esc(x.href)}" data-state="${x.state}"${flight(x)}>${inner}</a>`;
  const muted = (t) => (t ? `<span class="og-d">${esc(t)}</span>` : "");
  switch (x.state) {
    case "working":
      return tab
        ? a(top(x, st("WORKING")) + (x.steps.length ? checklist(x.steps) : muted(x.detail)))
        : a(top(x, st(x.of ?? "WORKING")) + (x.live ? `<span class="hand">${esc(x.live)}</span>` : ""));
    case "waiting": case "stuck":
      return a(top(x, st(x.status)) + (tab ? muted(x.detail) : ""));
    case "needs":
      return a(top(x, st("NEEDS YOU", true)) + (tab ? muted(x.detail) : ""));
    case "scheduled":
      return tab
        ? a(`<span class="og-top"><b>${esc(x.title)}</b>${timeBig(x, "og-time")}</span><span class="og-sub">${x.description && !same(x.description, x.title) ? `<span class="og-d">${esc(x.description)}</span>` : "<span></span>"}${st(x.every || x.date || "")}</span>`, " og-s")
        : a(top(x, `<span class="when">${esc(x.when)}</span>`));
    case "ready":
      return tab
        ? `<div class="og-row${fold}" data-state="ready">${top(x, st("READY"))}<a class="og-go" href="${esc(x.href)}">View result <span aria-hidden="true">→</span></a></div>`
        : a(top(x, `<span class="og-v">View <span aria-hidden="true">→</span></span>`));
    case "failed":
      return tab
        ? a(top(x, st("DIDN'T WORK", true)) + (x.why ? `<span class="hand">${esc(x.why)}</span>` : "") + muted(x.next))
        : a(top(x, st("DIDN'T WORK", true)) + muted(x.next));
    default:
      return a(top(x, st(x.status ?? "")));
  }
}

/** The approval, on its paper card: the one loud thing. "Review details →"; on the tab, the Caveat line beside it. */
function apprCard(x, { tab, fold }) {
  return `<div class="card appr og-appr${fold}"><p class="appr-t">${esc(x.title)}</p>${x.detail ? `<p class="appr-d">${esc(x.detail)}</p>` : ""}`
    + `<p class="lbl">${x.money ? "NOTHING CHARGED YET" : "NOTHING BOOKED YET"}</p>`
    + `<div class="appr-f"><a class="appr-go" href="${esc(x.href)}">Review details <span aria-hidden="true">→</span></a>${tab ? hand(OR_REPLY, { tag: "span", cls: "tilt15" }) : ""}</div></div>`;
}

/** Everything on the list, counted the way the tab and its heading count it. */
export const countOf = ({ approvals = [], items = [], back = [] }) => approvals.length + items.length + back.length;
export const needsOf = ({ approvals = [], items = [] }) => approvals.length + items.filter(x => x.needs).length;
/** "6 THINGS · 1 NEEDS YOU" */
export function countLine(model) {
  const n = countOf(model), k = needsOf(model);
  return `${n} ${n === 1 ? "THING" : "THINGS"}${k ? ` · ${k} ${k === 1 ? "NEEDS" : "NEED"} YOU` : ""}`;
}

// ---------------------------------------------------------------- Ongoing at volume (handoff v2, sheet 2A/2B/2C, §4c item 2)
/**
 * One quiet row at volume: the title (two lines, then …), its status at the right (never wraps), and,
 * where the sheet draws one, its typed meta line under the title ("WORKING · STARTED 2:55 PM").
 * `typedWhen`: the margin types a scheduled row's day ("MON"); the phone sets it in serif ("Mon 9:00").
 */
export function vRow(x, { meta = false, typedWhen = false } = {}) {
  let right;
  switch (x.state) {
    case "approval": right = st("APPROVE", true); break;
    case "working": right = st(x.of ?? "WORKING"); break;
    case "needs": right = st("NEEDS YOU", true); break;
    case "failed": right = st("DIDN'T WORK", true); break;
    case "scheduled": {
      const w = x.next_ ?? {};
      right = typedWhen ? st(w.typed ?? x.every ?? "") : w.serif ? `<span class="ogv-w">${esc(w.serif)}</span>` : st(x.every ?? "");
      break;
    }
    default: right = st(x.status ?? "");
  }
  return `<a class="ogv" href="${esc(x.href)}" data-state="${x.state}"${flight(x)}><span class="ogv-t">${esc(x.title)}</span><span class="ogv-r">${right}</span>`
    + `${meta && x.meta ? `<span class="ogv-m">${esc(x.meta)}</span>` : ""}</a>`;
}

/** The approval at volume: 2A's card on the phone (Review details →), 2C's smaller card in the margin (the card is the link). */
function vCard(x, { tab }) {
  const nothing = `<span class="lbl">${x.money ? "NOTHING CHARGED YET" : "NOTHING BOOKED YET"}</span>`;
  return tab
    ? `<div class="card og-vc"><span class="lbl pen">NEEDS YOUR APPROVAL</span><span class="ogv-t">${esc(x.title)}</span>${nothing}<a class="appr-go" href="${esc(x.href)}">Review details <span aria-hidden="true">→</span></a></div>`
    : `<a class="card og-vc m" href="${esc(x.href)}"><span class="ogv-t">${esc(x.title)}</span>${nothing}</a>`;
}

/** Where a group's "See all N →" goes: its own page, newest first, with filter words (2B). */
export const SEE_ALL = { hand: "/web/ongoing/hand", back: "/web/ongoing/back" };
const seeAllLink = (n, which) => `<a class="og-more" href="${SEE_ALL[which]}">See all ${n} <span aria-hidden="true">→</span></a>`;

/**
 * The Ongoing list: the desktop margin, or (`tab`) the mobile Ongoing tab's body. Each group's heading
 * carries its count (`IN HAND · 9`). NEEDS YOU shows every approval (they are the point): the first on
 * its paper card, the rest as rows. IN HAND and BACK TO YOU show their top OG_TOP and "See all N →"
 * (serif) to their own page. At volume (a group runs past OG_TOP) every row is 2A/2C's quiet row; with
 * fewer, the tab keeps ongoing-mobile's fuller rows. The margin also carries "HIDE →".
 */
export function ogMargin({ approvals = [], items = [], back = [] }, { tab = false } = {}) {
  const head = tab ? "" : `<div class="og-h"><h2>Ongoing</h2><button class="act2 og-hide" type="button" aria-controls="og" aria-expanded="true">HIDE <span aria-hidden="true">→</span></button></div>`;
  const needs = items.filter(x => x.needs);
  const rest = items.filter(x => !x.needs);
  const volume = rest.length > OG_TOP || back.length > OG_TOP;
  const aside = (inner) => `<aside class="og${tab ? " og-tab" : ""}${volume ? " og-vol" : ""}" id="og" aria-label="Ongoing">${head}${inner}</aside>`;
  if (!items.length && !approvals.length && !back.length) {
    return aside(`<div class="empty"><p class="h2">Nothing left<br>to chase.</p>${hand("whatever you hand me shows up here while i work.", { tilt: true })}</div>`);
  }
  const H = tab ? "h2" : "h3";
  const one = (x) => (volume ? vRow(x, { typedWhen: !tab }) : row(x, { tab, fold: "" }));
  const section = (h, n, cls, inner, more = "") => `<section class="og-sec"><${H}${cls}>${h} · ${n}</${H}>${inner}${more}</section>`;
  const needsN = approvals.length + needs.length;
  const [first, ...others] = approvals;
  const needsInner = (first ? (volume ? vCard(first, { tab }) : apprCard(first, { tab, fold: "" })) : "")
    + (first && (others.length || needs.length) ? `<div class="og-sp" aria-hidden="true"></div>` : "")
    + (others.length || needs.length ? `<div class="ogv-l">${others.map(x => vRow(x, { meta: tab })).join("")}${needs.map(one).join("")}</div>` : "");
  return aside(
    (needsN ? section("NEEDS YOU", needsN, ` class="pen"`, needsInner) : "")
    + (rest.length ? section("IN HAND", rest.length, "", `<div class="ogv-l">${rest.slice(0, OG_TOP).map(one).join("")}</div>`, rest.length > OG_TOP ? seeAllLink(rest.length, "hand") : "") : "")
    + (back.length ? section("BACK TO YOU", back.length, "", `<div class="ogv-l">${back.slice(0, OG_TOP).map(one).join("")}</div>`, back.length > OG_TOP ? seeAllLink(back.length, "back") : "") : ""),
  );
}

/**
 * The arrival's "already in hand" (STAGING-REVIEW item 7): quiet rows between dashed rules, as on
 * Ongoing, under the approval that stays on paper. The top OG_TOP, then "See all N →" to Ongoing.
 */
export function homeRows(items = []) {
  if (!items.length) return "";
  return `<div class="ogv-l home-l">${items.slice(0, OG_TOP).map(x => vRow(x)).join("")}</div>`
    + (items.length > OG_TOP ? `<a class="og-more" href="/web?tab=ongoing">See all ${items.length} <span aria-hidden="true">→</span></a>` : "");
}

// ---------------------------------------------------------------- 2B, See all
/** The filter words for a group's See all, in the sheet's order. Only kinds it really has are drawn. */
const FILTERS = {
  hand: [["working", "WORKING", (x) => x.state === "working"], ["waiting", "WAITING", (x) => x.state === "waiting"], ["stuck", "STUCK", (x) => x.state === "stuck"], ["scheduled", "SCHEDULED", (x) => x.state === "scheduled"]],
  back: [["ready", "READY", (x) => x.state === "ready"], ["failed", "DIDN'T WORK", (x) => x.state === "failed"]],
};
const TITLES = { hand: "In hand", back: "Back to you" };
/** A group's rows, newest first: what was started or set most recently on top; undated ones last. */
export function groupRows({ items = [], back = [] }, which) {
  if (which === "back") return back.slice();
  return items.filter(x => !x.needs).map((x, i) => [x, i])
    .sort(([a, ai], [b, bi]) => (Number.isFinite(b.started) ? b.started : -Infinity) - (Number.isFinite(a.started) ? a.started : -Infinity) || ai - bi)
    .map(([x]) => x);
}

/** 2B: ← ONGOING, the group's name, `9 THINGS · NEWEST FIRST`, the filter words with counts, every row with its meta line. */
export function renderSeeAll(model, which, { filter = "", tabBar = "", css = "" } = {}) {
  const rows = groupRows(model, which);
  const kinds = FILTERS[which].map(([key, word, test]) => [key, word, rows.filter(test)]).filter(([, , r]) => r.length);
  const on = kinds.find(([key]) => key === filter) ?? null;
  const shown = on ? on[2] : rows;
  const link = (key, text, current) => `<a href="${SEE_ALL[which]}${key ? `?f=${key}` : ""}"${current ? ` aria-current="true"` : ""}>${esc(text)}</a>`;
  const nav = kinds.length > 1
    ? `<nav class="ogf" aria-label="Filter">${link("", `ALL ${rows.length}`, !on)}${kinds.map(([key, word, r]) => link(key, `${word} ${r.length}`, on?.[0] === key)).join("")}</nav>` : "";
  const body = `<header class="ogd-h">${typed("← ONGOING", { href: "/web?tab=ongoing" })}</header>`
    + `<main class="oga"><div class="oga-h"><h1 class="h1">${TITLES[which]}</h1><span class="lbl">${shown.length} ${shown.length === 1 ? "THING" : "THINGS"} · NEWEST FIRST</span></div>`
    + nav + `<div class="ogv-l">${shown.map(x => vRow(x, { meta: true })).join("")}</div></main>` + tabBar;
  return webPage({ title: `Reason — ${TITLES[which]}`, body, css: css + DETAIL_CSS + SEE_ALL_CSS + NINE_D_CSS, script: NINE_D_JS + OG_POLL_JS, bodyClass: tabBar ? "has-tabs" : "" });
}

/** Mobile, above the composer: "the Target order needs a yes →", straight to the approval's detail. */
export const needsYes = (approvals = []) => (approvals.length
  ? `<a class="needs-yes" href="${esc(approvals[0].href)}">${esc(approvals[0].nudge)} <span aria-hidden="true">→</span></a>` : "");

// ---------------------------------------------------------------- the look (on top of webconvo's)
export const OG_CSS = `
.og-h h2{font-size:30px}
.og-list .h1{font-size:40px;line-height:1.06;letter-spacing:-.02em}
.og-vol{gap:26px}
.og-tab.og-vol{gap:30px}
.og-sec>h2,.og-sec>h3{margin:0 0 4px;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.og-sec>h2.pen,.og-sec>h3.pen{color:var(--pen)}
.ogv-l{display:flex;flex-direction:column}
.ogv{text-decoration:none;color:var(--ink);padding:14px 0;border-bottom:1px dashed var(--hair);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center}
.ogv:last-child{border-bottom:0}
.ogv-t{font-size:16px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.ogv-r{white-space:nowrap}
.ogv-r .lbl,.og-vc .lbl{font-size:10px;letter-spacing:.14em;white-space:nowrap}
.ogv-w{font:italic 400 18px/1 var(--serif);white-space:nowrap}
.ogv-m{font:400 10px/1.4 var(--mono);letter-spacing:.12em;color:var(--muted);text-transform:uppercase;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ogv:hover .ogv-t{color:var(--hov)}
.og-vc{padding:18px 20px;display:flex;flex-direction:column;gap:8px;max-width:none}
.og-vc .appr-go{font-size:15px;font-weight:500;min-height:44px;display:inline-flex;align-items:center;align-self:flex-start;margin:-10px 0 -12px}
.og-vc.m{padding:14px 16px;gap:6px;text-decoration:none;color:var(--ink)}
.og-vc.m .ogv-t{font-size:15px}
.og-sp{height:10px}
.og .og-sp{height:8px}
.og-tab .og-sp{height:10px}
.og-more{align-self:flex-start;min-height:44px;display:inline-flex;align-items:center;gap:.3em;padding-top:6px;text-decoration:none;color:var(--ink);font:italic 400 20px/1 var(--serif)}
.og-more:hover{color:var(--hov)}
.home-l{border-top:1px dashed var(--hair);border-bottom:1px dashed var(--hair)}
.inhand .og-more{margin-top:4px}
.og-row{flex-direction:column;justify-content:flex-start;align-items:stretch;gap:6px;text-decoration:none;color:var(--ink)}
.og-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline;min-width:0}
.og-top b{font-size:15px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.og-top .lbl{flex:none;font-size:11px;letter-spacing:.1em}
.og-top .when{flex:none;font:italic 400 20px/1 var(--serif)}
.og-v{flex:none;font-size:14px;font-weight:500}
.og-row .hand{font-size:19px;line-height:1.2}
.og-d{font-size:14px;line-height:1.45;color:var(--muted)}
.og-appr{padding:20px;gap:10px;max-width:none}
.og-appr .appr-t{font-size:16px;font-weight:600;line-height:1.35}
.appr-d{margin:0;font-size:14px;line-height:1.45;color:var(--muted)}
.og-appr .lbl{font-size:11px;letter-spacing:.1em}
.appr-f{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.og-appr .appr-go{font-size:15px}
.appr-go,.og-go{gap:.3em}
.og-sec .og-d{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.og-tab .og-sec .og-d{white-space:normal}
.hand.tilt15{display:inline-block;font-size:20px;transform:rotate(-1.5deg)}
.og-tab{gap:48px}
.og-tab .og-sec:first-child>h2.pen{margin-bottom:14px}
.og-tab .og-row{padding:18px 0;gap:6px}
.og-tab .og-top b{font-size:17px}
.og-tab .og-d{font-size:15px}
.og-tab .og-appr .appr-t{font-size:17px}
.og-tab .og-appr .appr-d{font-size:15px}
.og-tab .og-appr .appr-go{font-size:16px}
.og-tab .og-row .hand{font-size:21px}
.og-steps{display:flex;flex-direction:column;gap:6px;font-size:15px;line-height:1.4;margin-top:6px}
.og-steps .og-st{display:flex;gap:.6em;align-items:baseline;min-width:0}
.og-steps .og-tx{min-width:0;overflow-wrap:anywhere}
.og-steps .og-st-doing .og-g{color:var(--pen)}
.og-steps .og-st-todo{color:var(--muted)}
.og-steps .hand{font-size:19px}
.og-s .og-sub{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
.og-s .og-sub .og-d{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.og-s .og-sub .lbl{flex:none;font-size:11px;letter-spacing:.1em}
.og-time{flex:none;font:italic 400 24px/1 var(--serif)}
.ampm{font:400 10px/1 var(--mono);font-style:normal;letter-spacing:.1em;margin-left:3px;color:var(--muted)}
.og-go{font-size:15px;font-weight:500;text-decoration:none;min-height:44px;display:inline-flex;align-items:center;align-self:flex-start}
.og-list>.lbl{margin-top:-20px;font-size:11px;letter-spacing:.14em}
.needs-yes{min-height:44px;display:flex;align-items:center;justify-content:flex-end;gap:6px;text-decoration:none;font:400 22px/1.1 var(--hand);color:var(--pen)}
.needs-yes span{font:400 16px/1 var(--sans)}
@media (min-width:900px){.needs-yes{display:none}}
`;

// ---------------------------------------------------------------- 9D, signed out mid-task
/**
 * The session ran out while something is in flight. Drawn from the page they are already looking at
 * — the first row on it that is still working or waiting (a row or detail carries data-flight), or
 * the message they just sent — so nothing private is ever drawn for a browser that is signed out.
 * `force`: something of theirs is mid-send even if no row says so. False when there is nothing in
 * flight: the caller goes to the plain signed-out sign-in (6F) instead.
 */
export const NINE_D_JS = `window.reasonMidTask=function(force){var f=document.querySelector('[data-flight]'),last=document.querySelector('.thread .msg.you:last-of-type .said');if(!f&&!(force&&last))return false;
var m=document.querySelector('main');if(!m)return false;var s='WORKING',t='';if(f){s=f.getAttribute('data-flight')||s;var b=f.getAttribute('data-title')?null:f.querySelector('b,h1');t=f.getAttribute('data-title')||(b?b.textContent:'')}else t=last.textContent;
m.className='nined';m.removeAttribute('data-flight');m.innerHTML='<h1 class="h1">Still working on it.<br><em>Sign back in to see.</em></h1><div class="ghost" aria-hidden="true"><span class="lbl"></span><b></b></div><a class="act" href="/web?out=1">Sign in <span aria-hidden="true">\\u2192</span></a>';
m.querySelector('.ghost .lbl').textContent=s;m.querySelector('.ghost b').textContent=t;document.querySelectorAll('.composer,.tabs,.onit,.og,.ogd-foot,.top nav,.menu-b').forEach(function(x){x.remove()});document.body.classList.remove('has-tabs');return true};`;
/** On the Ongoing tab and the detail pages: notice a session that ran out (no thread poll there). */
export const OG_POLL_JS = `(function(){var gone=false;function look(){if(gone||document.hidden)return;fetch('/web/ongoing/state',{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(r.status===401){gone=true;if(!window.reasonMidTask(false))location.href='/web?out=1'}}).catch(function(){})}setInterval(look,60000);document.addEventListener('visibilitychange',look)})();`;
export const NINE_D_CSS = `
.nined{flex:1 0 auto;width:100%;max-width:640px;margin:0 auto;padding:40px 28px;display:flex;flex-direction:column;justify-content:center;gap:24px}
.nined .h1{font-size:42px;line-height:1.08}
.nined .ghost{background:var(--lifted);border:1px solid var(--hair);border-radius:4px;padding:18px;opacity:.5;display:flex;flex-direction:column;gap:6px}
.nined .ghost .lbl{font-size:10.5px;letter-spacing:.1em}
.nined .ghost b{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nined .act{font-size:28px}
@media (min-width:900px){.nined .h1{font-size:64px}}
`;

// ---------------------------------------------------------------- the detail pages
const SEE_ALL_CSS = `
.oga{flex:1 0 auto;width:100%;max-width:720px;margin:0 auto;padding:28px var(--gut) 20px;display:flex;flex-direction:column;gap:26px}
.oga-h{display:flex;flex-direction:column;gap:6px}
.oga .h1{font-size:40px;line-height:1.06;letter-spacing:-.02em}
.oga-h .lbl{font-size:11px;letter-spacing:.14em}
.ogf{display:flex;gap:16px;flex-wrap:wrap}
.ogf a{min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:400 11px/1 var(--mono);letter-spacing:.12em;color:var(--muted);border-bottom:1.5px solid transparent}
.ogf a[aria-current=true]{color:var(--ink);border-bottom-color:var(--ink)}
.ogf a:hover{color:var(--ink)}
@media (min-width:900px){.oga .h1{font-size:56px}}
`;
const DETAIL_CSS = `
.ogd-h{padding:16px var(--gut) 0;max-width:720px;width:100%;margin:0 auto}
.ogd-h .act2{font-size:12px}
.ogd{flex:1 0 auto;width:100%;max-width:720px;margin:0 auto;padding:36px var(--gut);display:flex;flex-direction:column;gap:32px}
.ogd-top{display:flex;flex-direction:column;gap:10px}
.ogd-top .lbl{font-size:12px;white-space:normal}
.ogd .h1{font-size:40px;line-height:1.08}
.ogd-sub{margin:0;font-size:16px;line-height:1.5;color:var(--muted)}
.steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.steps li{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;padding:16px 0;border-bottom:1px dashed var(--hair);align-items:baseline;font-size:16px}
.steps li:last-child{border-bottom:0}
.steps .t{overflow-wrap:anywhere}
.steps .at{font:600 12px/1 var(--mono);color:var(--pen)}
.steps .doing .og-g{color:var(--pen)}
.steps .todo{color:var(--muted)}
.steps .hand{font-size:20px}
.small{margin:0;font:400 11px/1.4 var(--mono);letter-spacing:.1em;color:var(--muted);text-transform:uppercase}
.rcpt{margin:0;display:flex;flex-direction:column;gap:14px;font:400 13px/1.4 var(--mono);letter-spacing:.04em}
.rcpt div{display:flex;align-items:baseline;gap:8px}
.rcpt dt{color:var(--muted);flex:none}
.rcpt .dots{flex:1 1 12px;min-width:12px;border-bottom:1px dotted var(--hair)}
.rcpt dd{margin:0;text-align:right;min-width:0;overflow-wrap:anywhere;max-width:70%}
.rcpt .tot{padding-top:10px;border-top:1px dashed var(--hair)}
.rcpt .tot dt{color:var(--ink);font-weight:700}
.rcpt .tot .dots{border:0}
.rcpt .tot dd{font-weight:700;font-size:15px}
.ogd .hand.big{font-size:26px;line-height:1.2;transform:rotate(-1deg);transform-origin:left center}
.ogd .hand.huge{font-size:30px;line-height:1.15;transform:rotate(-1deg);transform-origin:left center}
.bigcard{position:relative;background:var(--lifted);border:1px solid var(--hair);border-radius:4px;box-shadow:var(--sh2);padding:24px 22px;display:flex;flex-direction:column;gap:12px}
.bigcard .stamp{position:absolute;background:var(--ground);font-size:11px;padding:4px 8px}
.bigcard .stamp.below{right:16px;bottom:-14px}
.bigcard .stamp.above{right:18px;top:-14px;font-size:12px;padding:4px 10px;transform:rotate(-4deg)}
.res-h{margin:0;font-size:18px;font-weight:600}
.res-f{margin:0;font:400 13px/1.7 var(--mono);letter-spacing:.04em;text-transform:uppercase}
.res-n{margin:0;font-size:15px;line-height:1.45;color:var(--muted)}
.res-b{margin:0;font-size:16px;line-height:1.55;overflow-wrap:anywhere}
.next{display:flex;flex-direction:column;gap:10px}
.next .lbl{font-size:12px}
.next p.b{margin:0;font-size:17px;line-height:1.55}
.ogd.sched{justify-content:center;align-items:center;text-align:center;gap:18px}
.ogd.sched .lbl{font-size:12px}
.huge-t{margin:0;font:italic 400 120px/1 var(--serif);letter-spacing:-.03em;display:inline-flex;align-items:flex-start}
.huge-t .ampm{font-size:14px;margin:14px 0 0 6px}
.every{margin:0;font:400 14px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase}
.sched .desc{margin:18px 0 0;font-size:17px;line-height:1.5;max-width:16em}
.after{display:flex;flex-direction:column;gap:6px;padding-top:12px}
.after p.q{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}
.ogd-foot{padding:0 var(--gut) 28px;display:flex;justify-content:center;text-align:center}
.ogd-foot .act{align-self:center;font-size:26px}
.ogd-foot .act.reply{font-size:28px}
.ogd .ask{margin:0;font-size:17px;line-height:1.55}
@media (min-width:900px){.ogd .h1{font-size:56px}.ogd-top .lbl{font-size:12px}}
@media (max-width:359px){.huge-t{font-size:96px}}
`;

const rcpt = (rows, total = null) => `<dl class="rcpt">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><span class="dots" aria-hidden="true"></span><dd>${esc(v)}</dd></div>`).join("")}`
  + (total ? `<div class="tot"><dt>TOTAL</dt><span class="dots" aria-hidden="true"></span><dd>${esc(total)}</dd></div>` : "") + `</dl>`;
const headBlock = (status, title, { pen = false, sub = "" } = {}) => `<div class="ogd-top">${label(status, pen ? "pen" : "")}<h1 class="h1">${esc(title)}</h1>${sub ? `<p class="ogd-sub">${esc(sub)}</p>` : ""}</div>`;

/** The detail page's body, by what the row is. Everything on it is a field the row really has. */
function detailBody(x, tz) {
  switch (x.state) {
    case "approval": {
      // The receipt has only what this approval's own record holds; TOTAL only when it has a figure.
      const rows = x.rows.filter(([k]) => k !== "TOTAL");
      return {
        main: `<div class="ogd-top">${label("NEEDS YOUR APPROVAL", "pen")}<h1 class="h1">${esc(x.title)}</h1></div>`
          + `<div class="bigcard">${rcpt(rows, x.total)}${stamp(x.money ? "NOTHING CHARGED YET" : "NOTHING BOOKED YET").replace('class="stamp ', 'class="stamp below ')}</div>`
          + `<div class="after">${hand(APPROVAL_NUDGE, { cls: "big" })}${x.faceId ? `<p class="q">You'll get a Face ID prompt before anything is charged.</p>` : ""}</div>`,
        foot: action("Reply in the chat", { href: "/web?thread", cls: "reply" }),
        gap: 36,
      };
    }
    case "working": {
      const items = x.steps.map(s => `<li class="${s.state}">${glyph(s.state)}<span class="t">${esc(s.text)}${s.state === "doing" && s.live ? ` <span class="hand">${esc(s.live)}</span>` : ""}</span>`
        + `<span class="at">${s.state === "done" && s.at ? `<time datetime="${new Date(s.at).toISOString()}">${esc(clockOf(s.at, tz))}</time>` : ""}</span></li>`).join("");
      return {
        main: headBlock("WORKING ON IT", x.title, { sub: x.goalLine })
          + (items ? `<ul class="steps" aria-label="Steps">${items}</ul>` : (x.detail ? `<p class="ask">${esc(x.detail)}</p>` : ""))
          + (x.nothingBooked ? `<p class="small">NOTHING BOOKED YET</p>` : ""),
        foot: action("Talk about it in the chat", { href: "/web?thread" }),
      };
    }
    case "waiting": {
      const rows = [];
      if (x.since) rows.push(["ASKED", x.sinceLine]);
      if (x.waitingFor) rows.push(["FOR", x.waitingFor.toUpperCase()]);
      return {
        main: headBlock(x.waitingOn ? `WAITING ON ${x.waitingOn.toUpperCase()}` : "WAITING", x.title)
          + (rows.length ? rcpt(rows) : "")
          + (x.checkLine ? hand(x.checkLine, { cls: "big" }) : ""),
        foot: action("Talk about it in the chat", { href: "/web?thread" }),
      };
    }
    case "needs":
      return {
        main: headBlock("WAITING ON YOU", x.title, { pen: true })
          + (x.question ? `<p class="ask">${esc(x.question)}</p>` : "") + (x.tradeoff ? `<p class="ogd-sub">${esc(x.tradeoff)}</p>` : ""),
        foot: action("Reply in the chat", { href: "/web?thread", cls: "reply" }),
      };
    case "stuck":
      return {
        main: headBlock("STUCK", x.title)
          + (x.blocked?.what ? `<p class="hand huge">${esc(x.blocked.what)}</p>` : "")
          + (x.blocked?.unblock ? `<div class="next">${label("WHAT WOULD GET IT GOING")}<p class="b">${esc(x.blocked.unblock)}</p></div>` : ""),
        foot: action("Talk about it in the chat", { href: "/web?thread" }),
      };
    case "scheduled":
      return {
        cls: " sched",
        main: label(x.call ? "SCHEDULED CALL" : "SCHEDULED")
          + (x.time ? `<p class="huge-t">${esc(x.time)}${x.period ? `<span class="ampm">${esc(x.period)}</span>` : ""}</p>` : "")
          + `<p class="every">${esc(x.everyLong || x.dateLong || "")}</p>`
          + (x.description && !same(x.description, x.title) ? `<p class="desc">${esc(x.description)}</p>` : "")
          + (x.everyLong && x.date ? `<p class="small">NEXT · ${esc(x.date)}</p>` : ""),
        foot: action("Change it in the chat", { href: "/web?thread" }),
      };
    case "ready": {
      const r = x.result ?? {};
      return {
        main: headBlock("READY", x.title)
          + `<div class="bigcard">${r.headline ? `<p class="res-h">${esc(r.headline)}</p>` : ""}`
          + (r.facts?.length ? `<p class="res-f">${r.facts.map(esc).join("<br>")}</p>` : "")
          + (r.note ? `<p class="${r.headline || r.facts?.length ? "res-n" : "res-b"}">${esc(r.note)}</p>` : "")
          + stamp("DONE").replace('class="stamp ', 'class="stamp above ') + `</div>`,
        foot: action("See it in the chat", { href: "/web?thread" }),
      };
    }
    case "failed":
      return {
        main: headBlock("DIDN'T WORK", x.title)
          + (x.why ? `<p class="hand huge">${esc(x.why)}</p>` : "")
          + (x.next ? `<div class="next">${label("WHAT HAPPENS NEXT")}<p class="b">${esc(x.next)}</p></div>` : "")
          + (x.nothingCharged ? `<p class="small">NOTHING CHARGED</p>` : ""),
        foot: action("Talk about it in the chat", { href: "/web?thread" }),
      };
    default:
      return { main: headBlock(x.status ?? "", x.title), foot: action("Talk about it in the chat", { href: "/web?thread" }) };
  }
}

const dayLong = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, weekday: "long", month: "short", day: "numeric" }).format(ms).replace(/,/g, "").toUpperCase();
const dayTimeOf = (ms, tz) => `${new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, weekday: "short" }).format(ms).toUpperCase()} · ${new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, hour: "numeric", minute: "2-digit" }).format(ms).toUpperCase()}`;
const weekdayLower = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz || config.tz, weekday: "long" }).format(ms).toLowerCase();

/** The words a detail adds to its row, from the row's own fields. */
function enrich(x, now) {
  const tz = config.tz;
  const out = { ...x };
  if (x.state === "working" && x.goal) out.goalLine = plainGoal(x.goal);
  if (x.state === "waiting") {
    out.sinceLine = x.since ? dayTimeOf(x.since, tz) : null;
    // When Reason really comes back to it: its next check, said as a day.
    out.checkLine = x.check && x.check > now ? `i'll check again ${x.check - now < 20 * 60 * 60_000 ? `at ${clockOf(x.check, tz)}${periodOf(x.check, tz).toLowerCase()}` : weekdayLower(x.check, tz)}.` : null;
  }
  if (x.state === "scheduled" && !x.everyLong && x.next) out.dateLong = dayLong(x.next, tz);
  return out;
}
/** A task's goal is Reason's own line; one sentence of it, in second person. */
function plainGoal(goal) {
  const name = String(config.ownerName ?? "").split(/\s+/)[0];
  let t = String(goal).replace(/\s+/g, " ").trim();
  const first = /^(.{12,200}?[.!?])(\s|$)/.exec(t);
  t = first ? first[1] : t.slice(0, 200);
  // Written about them in the third person ("Omari knows…"): not a line to show them as it is.
  if (name && new RegExp(`\\b${name}\\b`, "i").test(t)) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** One row's own page. */
export function renderDetail(item, { now = clock.now() } = {}) {
  const x = enrich(item, now);
  const b = detailBody(x, config.tz);
  const inFlight = x.state === "working" || x.state === "waiting" || x.state === "stuck";
  const body = `<header class="ogd-h">${typed("← ONGOING", { href: "/web?tab=ongoing" })}</header>`
    + `<main class="ogd${b.cls ?? ""}"${b.gap ? ` style="gap:${b.gap}px"` : ""}${inFlight ? ` data-flight="${esc(x.status)}" data-title="${esc(x.title)}"` : ""}>${b.main}</main>`
    + `<div class="ogd-foot">${b.foot}</div>`;
  return webPage({ title: `Reason — ${x.title}`, body, css: DETAIL_CSS + NINE_D_CSS, script: NINE_D_JS + OG_POLL_JS });
}

// ---------------------------------------------------------------- the routes
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra });
const page = (status, body, extra = {}) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(body), ...extra }), body });
const redirect = (location) => ({ status: 303, headers: HTML({ Location: location, "Content-Length": 0 }), body: "" });
const json = (status, obj) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
};

/**
 * GET /web/ongoing/hand and /web/ongoing/back (?f=<filter>): a group's See all (2B). A promise: the
 * phone's tab bar and the page's look are the conversation's (src/pages/webconvo.js), which imports
 * this file, so it is loaded here when asked for rather than at the top.
 */
async function seeAllPage(account, which, query, now) {
  const m = ongoing(account.conversation_id, now);
  if (!groupRows(m, which).length) return redirect("/web?tab=ongoing");
  const wc = await import("./webconvo.js");
  return page(200, renderSeeAll(m, which, { filter: String(query.f ?? ""), tabBar: wc.tabBar("ongoing", countOf(m)), css: wc.CONVO_CSS }));
}

/**
 * GET /web/ongoing/<kind>/<id> — one row's page — and GET /web/ongoing/state, the small answer the
 * Ongoing pages use to notice a session that ran out. Signed in only; a row is looked up in the
 * session's own conversation, so somebody else's id is the same flat 404 as one that never existed.
 */
export function ongoingRequest({ kind = null, id = null, method = "GET", headers = {}, query = {}, now = clock.now() }) {
  if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
  const account = sessionAccount(headers);
  if (kind === "state") {
    if (!account) return json(401, { ok: false, error: "signed_out" });
    const m = ongoing(account.conversation_id, now);
    return json(200, { ok: true, count: countOf(m), needs: needsOf(m) });
  }
  if (!account) return redirect("/web");
  if (!kind) return redirect("/web?tab=ongoing");
  if (kind === "hand" || kind === "back") return seeAllPage(account, kind, query, now);
  const item = id ? findItem(account.conversation_id, kind, id, now) : null;
  // A row that's gone (finished and cleared, or never this person's): E1, with the way back (src/pages/webedge.js).
  if (!item) return page(404, renderWebNotFound({ signedIn: true }));
  return page(200, renderDetail(item, { now }));
}
