// Reason Web's Ongoing, drawn (owner's design handoff 2026-10-26: HANDOFF.md "3 · Ongoing", reference
// ongoing-mobile, sheet-desktop-panel, sheet-details 2A–2E, ongoing-detail, sheet-global 9D). The rows
// are src/ongoing.js's; this file only draws them.
//
//   ogMargin        the list: the desktop margin, or the mobile Ongoing tab's body. NEEDS YOU (the
//                   approval on a paper card), IN HAND, BACK TO YOU; a typed status at the right of
//                   every row; the top three shown and "See all N →" for the rest (PR #179's tidy)
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

/**
 * The Ongoing list: the desktop margin, or (`tab`) the mobile Ongoing tab's body. PR #179's tidy is
 * kept whole: the top OG_TOP rows show, the rest are drawn but folded, "See all N →" opens them in
 * place (no script: a link to the list drawn open, `all`), and the margin carries "HIDE →".
 */
export function ogMargin({ approvals = [], items = [], back = [] }, { all = false, tab = false } = {}) {
  const head = tab ? "" : `<div class="og-h"><h2>Ongoing</h2><button class="act2 og-hide" type="button" aria-controls="og">HIDE <span aria-hidden="true">→</span></button></div>`;
  const aside = (inner, cls = "") => `<aside class="og${tab ? " og-tab" : ""}${cls}" id="og" aria-label="Ongoing">${head}${inner}</aside>`;
  if (!items.length && !approvals.length && !back.length) {
    return aside(`<div class="empty"><p class="h2">Nothing left<br>to chase.</p>${hand("whatever you hand me shows up here while i work.", { tilt: true })}</div>`);
  }
  const needs = items.filter(x => x.needs);
  const rest = items.filter(x => !x.needs);
  const total = approvals.length + items.length + back.length;
  const H = tab ? "h2" : "h3";
  let i = 0;
  const fold = () => (i++ >= OG_TOP ? " og-x" : "");
  const section = (h, cls, rows) => {
    const from = i;
    const inner = rows();
    return `<section class="og-sec${from >= OG_TOP ? " og-x" : ""}"><${H}${cls}>${h}</${H}>${inner}</section>`;
  };
  const back_ = tab ? "/web?tab=ongoing" : "/web?thread";
  const more = total > OG_TOP
    ? `<a class="og-all" href="${back_}${all ? "" : "&amp;all=1"}" aria-controls="og" aria-expanded="${all}" data-n="${total}">${all ? "Show fewer" : `See all ${total} <span aria-hidden="true">→</span>`}</a>`
    : "";
  return aside(
    (approvals.length || needs.length ? section("NEEDS YOU", ` class="pen"`, () => approvals.map(x => apprCard(x, { tab, fold: fold() })).join("") + needs.map(x => row(x, { tab, fold: fold() })).join("")) : "")
    + (rest.length ? section("IN HAND", "", () => rest.map(x => row(x, { tab, fold: fold() })).join("")) : "")
    + (back.length ? section("BACK TO YOU", "", () => back.map(x => row(x, { tab, fold: fold() })).join("")) : "")
    + more,
    all ? " all" : "",
  );
}

/** Mobile, above the composer: "the Target order needs a yes →", straight to the approval's detail. */
export const needsYes = (approvals = []) => (approvals.length
  ? `<a class="needs-yes" href="${esc(approvals[0].href)}">${esc(approvals[0].nudge)} <span aria-hidden="true">→</span></a>` : "");

// ---------------------------------------------------------------- the look (on top of webconvo's)
export const OG_CSS = `
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
.og-sec>h2{margin:0 0 6px;font:400 12px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.og-sec>h2.pen{color:var(--pen)}
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
.og-list>.lbl{margin-top:-20px;font-size:12px}
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
 * GET /web/ongoing/<kind>/<id> — one row's page — and GET /web/ongoing/state, the small answer the
 * Ongoing pages use to notice a session that ran out. Signed in only; a row is looked up in the
 * session's own conversation, so somebody else's id is the same flat 404 as one that never existed.
 */
export function ongoingRequest({ kind = null, id = null, method = "GET", headers = {}, now = clock.now() }) {
  if (method !== "GET" && method !== "HEAD") return page(405, renderNotFound(), { Allow: "GET, HEAD" });
  const account = sessionAccount(headers);
  if (kind === "state") {
    if (!account) return json(401, { ok: false, error: "signed_out" });
    const m = ongoing(account.conversation_id, now);
    return json(200, { ok: true, count: countOf(m), needs: needsOf(m) });
  }
  if (!account) return redirect("/web");
  if (!kind) return redirect("/web?tab=ongoing");
  const item = id ? findItem(account.conversation_id, kind, id, now) : null;
  if (!item) return page(404, renderNotFound());
  return page(200, renderDetail(item, { now }));
}
