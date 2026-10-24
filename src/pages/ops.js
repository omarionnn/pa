// How the status page looks. The verdicts come from src/ops.js; nothing here decides anything.
//
// Redesigned 2026-10-24, every piece of it approved by the owner:
//
//   - **One glance.** A bar at the top says "All good" or "2 things need you", and each of those
//     things is a line that jumps to its row.
//   - **Problems first, the rest folded.** Anything amber or red is a card pinned at the top, open,
//     with whatever can be done about it right there (Clear, the provider's dashboard). Everything
//     healthy folds into one line — "38 checks fine ▸" — that opens to the grouped list.
//   - **Alive.** The page re-reads itself every 30 seconds without a reload, says how long ago it
//     did, and flashes a row whose state changed. "Check again" answers the moment it is
//     pressed: the button says "Checking…", the rows dim, and each fills back in from /ops.json as
//     its check is decided.
//   - **Trends.** A 24-hour line beside the busy counts — texts in and out, each provider's calls
//     with failures in red — from hourly counts (db.opsTrends).
//   - **People** get room of their own: most recently active first, each with a 7-day bar.
//   - **Phone first.** One column, tap targets a thumb can hit. A link from an alert carries
//     ?focus=<check>, and that check is pinned first and outlined — or, if it is already fine
//     again, a line at the top says so.
//
// Without script every button is a plain form post and the page refreshes itself with a
// <noscript> meta; nothing here needs script to be read.
import { shell, esc } from "./render.js";
import { STALE_AFTER_MS, CLEARABLE, ago } from "../ops.js";

export const GROUPS = [
  ["alive", "Is it alive"],
  ["people", "People"],
  ["memory", "Memory"],
  ["money", "Money"],
  ["quality", "How it is behaving"],
  ["services", "Services and credit"],
];
const GROUP_NAME = Object.fromEntries(GROUPS);

const RANK = { bad: 0, warn: 1, ok: 2, off: 3 };
export const REFRESH_MS = 30_000;

const CSS = `
.wrap{max-width:72rem;padding-top:.9rem;padding-bottom:2rem}
.btn{font:inherit;font-size:.9rem;font-weight:600;min-height:2.75rem;padding:.55rem 1rem;border-radius:.6rem;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;box-sizing:border-box}
.btn:hover{border-color:var(--ink)}
.btn.sm{min-height:2.5rem;font-size:.84rem;padding:.4rem .85rem}
.btn:disabled{cursor:progress;opacity:.75}
.btn:disabled:hover{border-color:var(--line)}
form.act{margin:0}
/* The bar at the top */
.sb{border:1px solid var(--line);border-left:.28rem solid var(--sc);border-radius:.8rem;background:var(--card);padding:.9rem 1rem;margin:0 0 1rem;--sc:var(--dim)}
.sb.s-ok{--sc:#17794a}.sb.s-warn{--sc:#b25f00}.sb.s-bad{--sc:#b4232a}
.sb-head{display:flex;align-items:center;gap:.9rem;justify-content:space-between}
.sb h1{font:500 1.45rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.015em;margin:0;display:flex;align-items:center;gap:.55rem}
.sb h1 .sd{width:.62rem;height:.62rem;border-radius:50%;background:var(--sc);flex:none}
.sb .sx{margin:.3rem 0 0;color:var(--dim);font-size:.84rem;font-variant-numeric:tabular-nums}
.issues{list-style:none;margin:.75rem 0 0;padding:0;border-top:1px solid var(--line)}
.issues a{display:flex;align-items:center;gap:.55rem;padding:.6rem 0;min-height:2.75rem;box-sizing:border-box;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line);font-size:.92rem}
.issues li:last-child a{border-bottom:0;padding-bottom:0}
.issues a:hover .il{text-decoration:underline}
.issues .il{font-weight:600;flex:none}
.issues .id{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.issues .go{color:var(--dim);flex:none}
.issues .led{margin-top:0}
/* Layout: one column on a phone; on a laptop the checks on the left and people on the right */
.cols{display:grid;grid-template-columns:minmax(0,1fr);gap:0 1rem}
@media(min-width:62rem){.cols{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);align-items:start}}
.sec{margin:0 0 1rem}
.sec>h2{margin:0 0 .5rem;font-size:1.05rem}
/* The lights */
.led{flex:none;width:.6rem;height:.6rem;border-radius:50%;background:var(--dim);margin-top:.42rem}
.ck-ok .led{background:#17794a}.ck-warn .led{background:#b25f00}.ck-bad .led{background:#b4232a}
/* A problem: open, with its actions */
.pc{border:1px solid var(--line);border-radius:.8rem;background:var(--card);padding:.85rem 1rem;margin:0 0 .7rem;scroll-margin-top:1rem}
.pc .ph{display:flex;gap:.6rem;align-items:flex-start}
.pc .rm{flex:1;min-width:0}
.pc .rn{font-weight:600;font-size:1rem}
.pc .rg{color:var(--dim);font-size:.78rem;margin-top:.05rem}
.pc .rd{margin-top:.35rem;font-size:.92rem;line-height:1.4}
.pc .acts{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.7rem}
.pc .trend{margin-top:.5rem}
.pc.focused{outline:2px solid var(--accent);outline-offset:2px}
.okline{border:1px solid var(--line);border-radius:.8rem;padding:.75rem 1rem;margin:0 0 .7rem;font-size:.9rem;color:var(--dim)}
.okline b{color:var(--ink)}
/* Healthy: folded */
.fine{border:1px solid var(--line);border-radius:.8rem;background:var(--card);margin:0 0 1rem}
.fine>summary{cursor:pointer;list-style:none;padding:.85rem 1rem;min-height:2.75rem;box-sizing:border-box;display:flex;align-items:center;gap:.55rem;font-weight:600;font-size:.95rem}
.fine>summary::-webkit-details-marker{display:none}
.fine>summary .led{margin-top:0;background:#17794a}
.fine>summary .chev{margin-left:auto;color:var(--dim);transition:transform .15s}
.fine[open]>summary .chev{transform:rotate(90deg)}
.fine[open]>summary{border-bottom:1px solid var(--line)}
.fg{padding:.35rem 1rem .5rem}
.fg h3{margin:.55rem 0 .15rem;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.r{display:flex;gap:.55rem;align-items:flex-start;padding:.42rem 0;border-bottom:1px solid var(--line);scroll-margin-top:1rem}
.fg .r:last-child{border-bottom:0}
.r .rm{flex:1;min-width:0;font-size:.88rem;line-height:1.35}
.r .rn{font-weight:600;margin-right:.4rem}
.r .rd{color:var(--dim)}
.r .rv{flex:none;display:flex;align-items:center;gap:.6rem;font-size:.8rem}
.r .rv a{color:var(--dim);text-decoration:none;padding:.3rem 0}
.r .rv a:hover{color:var(--ink)}
.r.focused{background:color-mix(in srgb,var(--accent) 10%,transparent);border-radius:.4rem}
.off{color:var(--dim);font-size:.8rem;margin:.2rem 1rem .8rem;opacity:.8}
/* Trend lines */
.spark{display:block;width:4.5rem;height:1.15rem;color:var(--dim);overflow:visible}
.spark .ln{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.spark .ar{fill:currentColor;opacity:.12}
.spark .fl{fill:none;stroke:#e5484d;stroke-width:1.4;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.trend{display:flex;align-items:center;gap:.45rem;color:var(--dim);font-size:.74rem;font-variant-numeric:tabular-nums}
/* People */
.people{border:1px solid var(--line);border-radius:.8rem;background:var(--card);padding:.3rem 1rem .4rem}
.pp{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.1rem .8rem;align-items:center;padding:.6rem 0;border-bottom:1px solid var(--line)}
.pp:last-child{border-bottom:0}
.pp .who{font-weight:600;font-size:.95rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp .tag{color:var(--dim);font-weight:400;font-size:.76rem;margin-left:.35rem}
.pp .meta{grid-column:1;color:var(--dim);font-size:.8rem;font-variant-numeric:tabular-nums}
.pp .meta .owed{color:var(--warn)}
.pp .wk{grid-column:2;grid-row:1/span 2;display:flex;flex-direction:column;align-items:flex-end;gap:.15rem}
.pp .wk small{color:var(--dim);font-size:.68rem}
.bars{display:block;width:5.6rem;height:1.6rem;color:var(--ink)}
.bars rect{fill:currentColor;opacity:.75}
.bars rect.z{opacity:.18}
.ppsum{color:var(--dim);font-size:.84rem;margin:.55rem 0 .2rem}
/* While a pass runs, and after */
.spin{display:inline-block;width:.8em;height:.8em;margin-right:.5em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.refreshing{opacity:.4;transition:opacity .25s}
.refreshing .led{background:var(--dim)!important;animation:breathe 1.1s ease-in-out infinite}
@keyframes breathe{50%{opacity:.3}}
.flash{animation:flash 1.6s ease-out}
@keyframes flash{0%{background-color:color-mix(in srgb,var(--accent) 28%,transparent)}100%{background-color:transparent}}
@media(prefers-reduced-motion:reduce){.spin,.refreshing .led,.flash{animation:none}}
@media(max-width:34rem){.sb-head{flex-direction:column;align-items:stretch}.sb-head .btn{width:100%}.sb h1{font-size:1.3rem}}
`;

// Plain ES5, no framework, nothing fetched but this page's own two addresses (relative, so it works
// on whichever domain serves it). Any surprise — a signed-out browser, a network error — falls back
// to an ordinary reload, which is never wrong.
const JS = `(function(){
if(!window.fetch||!window.URLSearchParams||!window.DOMParser||!window.FormData)return;
var busy=false,fetchedAt=Date.now(),REFRESH=${REFRESH_MS};
function q(s,r){return (r||document).querySelector(s);}
function qa(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
function bail(){location.reload();}
function secs(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+'s';var m=Math.round(s/60);if(m<60)return m+'m';return Math.round(m/60)+'h';}
function tick(){
  var o=q('[data-at]');if(!o)return;
  var at=+o.getAttribute('data-at'),skew=+o.getAttribute('data-now')-(+o.getAttribute('data-loaded'));
  var c=q('[data-checked]');if(c&&!busy)c.textContent='Checked '+secs(Date.now()+skew-at)+' ago';
  var u=q('[data-upd]');if(u)u.textContent='updated '+secs(Date.now()-fetchedAt)+' ago';
}
function stamp(){var o=q('[data-at]');if(o)o.setAttribute('data-loaded',Date.now());}
function seen(){var m={};qa('[data-ck]').forEach(function(el){m[el.getAttribute('data-ck')]=el.getAttribute('data-sig');});return m;}
function swap(html){
  var d=new DOMParser().parseFromString(html,'text/html'),w=q('.wrap',d),p=q('.pill',d);
  if(!w||!q('[data-at]',d))return bail();
  var before=seen(),f0=q('details.fine'),open=f0?f0.open:null;
  q('.wrap').innerHTML=w.innerHTML;
  if(p&&q('.pill'))q('.pill').textContent=p.textContent;
  var f=q('details.fine');if(f&&open!==null)f.open=open;
  qa('[data-ck]').forEach(function(el){var id=el.getAttribute('data-ck');if(id in before&&before[id]!==el.getAttribute('data-sig'))el.classList.add('flash');});
  fetchedAt=Date.now();stamp();tick();
}
function fresh(){
  return fetch(location.pathname+location.search,{credentials:'same-origin',cache:'no-store',headers:{accept:'text/html'}})
    .then(function(r){if(r.status!==200)throw r.status;return r.text();}).then(swap);
}
function paint(c){
  qa('[data-ck]').forEach(function(row){
    if(row.getAttribute('data-ck')!==c.id)return;
    row.classList.remove('refreshing','ck-ok','ck-warn','ck-bad','ck-off');
    row.classList.add('ck-'+c.state);
    var rd=q('.rd',row),led=q('.led',row);
    if(rd)rd.textContent=c.detail;
    if(led)led.setAttribute('aria-label',c.state);
  });
}
function say(t){var c=q('[data-checked]');if(c)c.textContent=t;}
function poll(){
  fetch('/ops.json',{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'}})
    .then(function(r){if(r.status!==200)throw r.status;return r.json();})
    .then(function(j){
      if(!j.running){return fresh().then(function(){busy=false;});}
      j.running.checks.forEach(paint);
      say('Checking now · '+j.running.checks.length+(j.running.total?' of '+j.running.total:'')+' done');
      setTimeout(poll,450);
    }).catch(bail);
}
document.addEventListener('submit',function(e){
  var f=e.target;
  if(!f.classList||!f.classList.contains('act'))return;
  e.preventDefault();
  if(busy)return;
  busy=true;
  var btn=e.submitter||q('button',f),body=new URLSearchParams(new FormData(f));
  if(btn&&btn.name)body.set(btn.name,btn.value);
  var clearing=body.get('action')==='clear';
  qa('button.btn').forEach(function(b){b.disabled=true;});
  if(btn)btn.innerHTML='<span class="spin" aria-hidden="true"></span>'+(clearing?'Clearing…':'Checking…');
  qa('[data-ck]').forEach(function(el){el.classList.add('refreshing');});
  say('Checking now…');
  fetch(f.getAttribute('action')||location.pathname,{method:'POST',credentials:'same-origin',
    headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:body.toString()})
    .then(function(r){if(r.status!==200&&r.status!==202)throw r.status;return r.json();})
    .then(function(j){if(j.running)return poll();return fresh().then(function(){busy=false;});})
    .catch(bail);
});
stamp();
var fx=q('.focused');if(fx&&fx.scrollIntoView&&!location.hash)fx.scrollIntoView({block:'start'});
setInterval(tick,1000);
setInterval(function(){if(!busy&&!document.hidden)fresh().catch(function(){});},REFRESH);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&!busy&&Date.now()-fetchedAt>REFRESH)fresh().catch(function(){});});
})();`;

/** Does a ?focus= value name this check? `agentcard` finds `provider:agentcard`. */
function focusMatches(id, focus) {
  return !!focus && (id === focus || id.split(":").pop() === focus);
}

/**
 * The page. `report` is the last saved pass (or null before the first); `now` decides whether it
 * is stale, which is itself a red: a green from forty minutes ago is not a green. `focus` is the
 * check an alert link named.
 */
export function renderOps({ report, now = Date.now(), focus = null }) {
  const head = `<noscript><meta http-equiv="refresh" content="${REFRESH_MS / 1000}"></noscript>`;
  const checkAgain = `<form class="act" method="POST" action="/ops"><button class="btn" name="action" value="check">Check again</button></form>`;
  if (!report) {
    const body = `<section class="sb s-warn" data-at="${now}" data-now="${now}"><div class="sb-head"><div><h1><span class="sd"></span>Checking</h1>`
      + `<p class="sx"><span data-checked>The first check runs a few seconds after start.</span> · <span data-upd>updated just now</span></p></div>${checkAgain}</div></section>`;
    return shell({ title: "Reason status", body, pill: "Checking", css: CSS, head, script: JS });
  }
  const age = now - report.at;
  const stale = age > STALE_AFTER_MS;
  const checks = report.checks ?? [];
  const wrong = checks.filter(c => c.state === "bad" || c.state === "warn")
    .sort((a, b) => (focusMatches(b.id, focus) - focusMatches(a.id, focus)) || (RANK[a.state] - RANK[b.state]));
  const fine = checks.filter(c => c.state === "ok");
  const off = checks.filter(c => c.state === "off");
  const verdict = stale ? "bad" : report.verdict;
  const trends = report.trends ?? null;

  // ---- the bar ----
  const headline = stale ? "The checks have stopped"
    : !wrong.length ? "All good"
      : `${wrong.length} ${wrong.length === 1 ? "thing needs" : "things need"} you`;
  const kind = stale || wrong.some(c => c.state === "bad") ? "bad" : wrong.length ? "warn" : "ok";
  const meta = `<span data-checked>Checked ${esc(ago(age))} ago</span> · ${checks.length} checks · <span data-upd>updated just now</span>`;
  const staleLine = stale ? `<p class="sx">The last pass was ${esc(ago(age))} ago — Reason may be down or stuck. The rows below are from that pass.</p>` : "";
  const issues = wrong.length
    ? `<ul class="issues">${wrong.map(c => `<li><a class="ck-${esc(c.state)}" href="#ck-${esc(anchor(c.id))}"><span class="led"></span><span class="il">${esc(c.label)}</span><span class="id">${esc(c.detail)}</span><span class="go" aria-hidden="true">›</span></a></li>`).join("")}</ul>`
    : "";
  const bar = `<section class="sb s-${kind}" data-at="${report.at}" data-now="${now}"><div class="sb-head"><div><h1><span class="sd"></span>${esc(headline)}</h1>`
    + `<p class="sx">${meta}</p>${staleLine}</div>${checkAgain}</div>${issues}</section>`;

  // ---- what needs them ----
  const focusedFine = focus ? fine.find(c => focusMatches(c.id, focus)) : null;
  const okLine = focusedFine
    ? `<p class="okline">You were sent here about <b>${esc(focusedFine.label)}</b>. It is fine now: ${esc(focusedFine.detail)}</p>` : "";
  const problems = wrong.length ? `<section class="sec"><h2>Needs you</h2>${wrong.map(c => problemCard(c, now, trends, focusMatches(c.id, focus))).join("")}</section>` : "";

  // ---- what is fine, folded ----
  const groups = GROUPS.map(([key, title]) => {
    const rows = fine.filter(c => c.group === key);
    return rows.length ? `<div class="fg"><h3>${esc(title)}</h3>${rows.map(c => fineRow(c, trends, focusMatches(c.id, focus))).join("")}</div>` : "";
  }).join("");
  const offLine = off.length ? `<p class="off">Not set up: ${off.map(c => esc(c.label)).join(", ")}</p>` : "";
  const fold = `<details class="fine"><summary><span class="led"></span>${fine.length} ${fine.length === 1 ? "check" : "checks"} fine<span class="chev" aria-hidden="true">▸</span></summary>${groups}${offLine}</details>`;

  const people = peopleSection(report.people ?? [], now);
  const body = `${bar}<div class="cols"><div>${okLine}${problems}${fold}</div>${people}</div>`;
  return shell({ title: "Reason status", body, pill: pillFor(verdict), css: CSS, head, script: JS });
}

/** A check id as an anchor: `provider:openai` → `provider-openai`. */
function anchor(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, "-"); }

/**
 * What makes a row "changed" for the flash: its state. Not its line — "up 29s", "last pass 14s
 * ago" change every refresh, and a page that flashes every 30 seconds is not calm.
 */
function sig(c) { return c.state; }

function problemCard(c, now, trends, focused) {
  const since = c.since ? ` · for ${esc(ago(now - c.since))}` : "";
  const clear = CLEARABLE.has(c.id)
    ? `<form class="act" method="POST" action="/ops"><input type="hidden" name="action" value="clear"><button class="btn sm" name="id" value="${esc(c.id)}">Clear</button></form>`
    : "";
  const dash = c.link ? `<a class="btn sm" href="${esc(c.link)}" rel="noopener" target="_blank">Open dashboard ↗</a>` : "";
  const acts = clear || dash ? `<div class="acts">${clear}${dash}</div>` : "";
  const tr = trendFor(c.id, trends);
  return `<article class="pc ck-${esc(c.state)}${focused ? " focused" : ""}" id="ck-${esc(anchor(c.id))}" data-ck="${esc(c.id)}" data-sig="${esc(sig(c))}">`
    + `<div class="ph"><span class="led" aria-label="${esc(c.state)}"></span><div class="rm"><div class="rn">${esc(c.label)}</div>`
    + `<div class="rg">${esc(GROUP_NAME[c.group] ?? c.group)}${since}</div><div class="rd">${esc(c.detail)}</div>`
    + `${tr ? `<div class="trend">${tr}<span>last 24h</span></div>` : ""}${acts}</div></div></article>`;
}

function fineRow(c, trends, focused) {
  const tr = trendFor(c.id, trends);
  const link = c.link ? `<a href="${esc(c.link)}" rel="noopener" target="_blank">Dashboard ›</a>` : "";
  const side = tr || link ? `<div class="rv">${tr}${link}</div>` : "";
  return `<div class="r ck-${esc(c.state)}${focused ? " focused" : ""}" id="ck-${esc(anchor(c.id))}" data-ck="${esc(c.id)}" data-sig="${esc(sig(c))}">`
    + `<span class="led" aria-label="${esc(c.state)}"></span><div class="rm"><span class="rn">${esc(c.label)}</span><span class="rd">${esc(c.detail)}</span></div>${side}</div>`;
}

/** The 24-hour line for a check, if it has one and anything happened. */
function trendFor(id, trends) {
  if (!trends) return "";
  let calls = null, fails = null, what = "";
  if (id === "inbound") { calls = trends.inbound; what = "texts in"; }
  else if (id === "outbox") { calls = trends.sent; fails = trends.failed; what = "texts out"; }
  else if (id.startsWith("provider:")) {
    const p = trends.providers?.[id.slice(9)];
    if (p) { calls = p.calls; fails = p.failures; what = "calls"; }
  }
  return Array.isArray(calls) ? sparkline(calls, fails, what) : "";
}

/**
 * A tiny line: hourly counts, oldest on the left, failures as a red line on the same scale.
 * Nothing drawn for a day with nothing in it.
 */
export function sparkline(series, fails = null, what = "") {
  const nums = (a) => (Array.isArray(a) ? a.map(v => Number(v) || 0) : null);
  series = nums(series);
  fails = nums(fails);
  if (!series || series.length < 2) return "";
  const total = series.reduce((s, v) => s + v, 0);
  const failed = fails ? fails.reduce((s, v) => s + v, 0) : 0;
  if (!total && !failed) return "";
  const W = 72, H = 18;
  const max = Math.max(1, ...series, ...(fails ?? []));
  const pts = (a) => a.map((v, i) => `${(i * W / (a.length - 1)).toFixed(1)},${(H - 1 - (v / max) * (H - 2)).toFixed(1)}`).join(" ");
  const line = pts(series);
  const label = `${total} ${what} in 24h${failed ? `, ${failed} failed` : ""}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>`
    + `<polygon class="ar" points="0,${H} ${line} ${W},${H}"/><polyline class="ln" points="${line}"/>`
    + (failed ? `<polyline class="fl" points="${pts(fails)}"/>` : "") + `</svg>`;
}

/** Seven bars, oldest first, today on the right. */
function weekBars(week) {
  const w = Array.isArray(week) && week.length === 7 ? week.map(v => Number(v) || 0) : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...w);
  const total = w.reduce((s, v) => s + v, 0);
  const bars = w.map((v, i) => {
    const h = v ? Math.max(3, Math.round((v / max) * 22)) : 2;
    return `<rect${v ? "" : ` class="z"`} x="${i * 12}" y="${24 - h}" width="9" height="${h}" rx="1.5"/>`;
  }).join("");
  return `<svg class="bars" viewBox="0 0 81 24" role="img" aria-label="${total} texts in 7 days"><title>${w.join(", ")} texts, last 7 days</title>${bars}</svg>`;
}

function peopleSection(people, now) {
  if (!people.length) return "";
  const sorted = [...people].sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0));
  const day = 24 * 60 * 60 * 1000;
  const today = sorted.filter(p => p.last_seen_at && now - p.last_seen_at < day).length;
  const rows = sorted.map(p => {
    const tags = `${p.operator ? `<span class="tag">you</span>` : ""}${p.state && p.state !== "active" ? `<span class="tag">${esc(p.state)}</span>` : ""}`;
    const bits = [p.last_seen_at ? `active ${esc(ago(now - p.last_seen_at))} ago` : "never texted"];
    if (p.turns_today) bits.push(`${Number(p.turns_today)} turns today`);
    if (p.open_tasks) bits.push(`${Number(p.open_tasks)} open tasks`);
    if (p.texts_owed) bits.push(`<span class="owed">${Number(p.texts_owed)} owed</span>`);
    return `<div class="pp"><div class="who">${esc(p.name || p.address || p.conversation)}${tags}</div>`
      + `<div class="wk">${weekBars(p.week)}<small>7 days</small></div><div class="meta">${bits.join(" · ")}</div></div>`;
  }).join("");
  return `<section class="sec"><h2>People</h2><div class="people"><p class="ppsum">${sorted.length} on the line · ${today} active today</p>${rows}</div></section>`;
}

function pillFor(verdict) {
  return verdict === "ok" ? "Healthy" : verdict === "bad" ? "Needs you" : "Look";
}
