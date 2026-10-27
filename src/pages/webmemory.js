// Reason Web, Memory (owner's design handoff 2026-10-26, HANDOFF.md §5; reference desk-memory-* and
// sheet-memory-* 7A/7B/7C). What Reason remembers about the signed-in person, from the same store
// every turn reads, and every line theirs to correct or take back.
//
//   list       every active fact on their Reason (src/db.js `memoryFacts`) and the reasons they gave
//              (`whys`), one per line between dashed rules, under PREFERENCES · PEOPLE · PLACES ·
//              ROUTINES · WHY. The heading is the row's `memory_group`, chosen by a model when the
//              fact was written or by the background filer (src/factgroups.js); until a row has one,
//              the extractor's own category stands in. An empty heading is not drawn.
//   correct    in place: the line becomes an underline input (CORRECTING, Save →, CANCEL); saving
//              replaces that one row the way the memory_fix tool does — the old wording out of the
//              saved thread, a new embedding, the profile rebuilt — and "got it." sits beside it, fading.
//   forget     the 7C card; "Forget it" retires the row the way memory_drop does, so nothing that
//              builds a turn reads it again (recall, search, the profile). The visible chat history,
//              their own words included, is not touched.
//   guesses    REASON THINKS…, from the `guesses` table (Reason's own readings, patterns included),
//              in Caveat and pen because they are unconfirmed. "Yes, that's right" saves it as a fact
//              in their name; "No" dismisses it for good. Nothing here invents one.
//
// Every action is a plain form or link first (works without script) and the script only keeps the
// page where it is. Every POST: the session's secret + same origin, like /web/send. Every id is
// looked up inside the session's own conversation, so another person's row is simply not found.
import * as db from "../db.js";
import { timingSafeEqual } from "node:crypto";
import { readCookie } from "./access.js";
import { esc, renderNotFound } from "./render.js";
import { webPage, wordmark, hand, typed } from "./webkit.js";
import { SECURITY_HEADERS, sameOrigin } from "./websignin.js";

/** The five headings, in the page's order, as the page writes them. */
export const GROUPS = [
  ["preferences", "PREFERENCES"], ["people", "PEOPLE"], ["places", "PLACES"], ["routines", "ROUTINES"], ["why", "WHY"],
];
/** Until a fact is filed, the extractor's category (a model's reading too) stands in where it says the same thing. */
const FROM_CATEGORY = { preference: "preferences", interest: "preferences", relationship: "people", location: "places", routine: "routines", goal: "why", belief: "why" };
export const MAX_TEXT = 500;

/** The heading one fact is drawn under. */
export function groupOf(f, ownKey) {
  if (db.MEMORY_GROUPS.includes(f.memory_group)) return f.memory_group;
  return FROM_CATEGORY[f.category] ?? (f.about_key && f.about_key !== ownKey ? "people" : "preferences");
}

/**
 * The line as read. Their own facts as saved; a fact about somebody else names who it is about unless
 * it already does ("Kofi: is a nurse", but "Kofi's birthday is May 2" as it is).
 */
export function lineFor(about, text, { own = false } = {}) {
  const t = String(text ?? "").trim();
  if (own || !about) return t;
  if (t.toLowerCase().includes(String(about).toLowerCase())) return t;
  const lower = /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
  return `${about}: ${lower}`;
}

/** Everything the page draws, as data: `{ groups: [{ key, title, rows }], guesses, empty }`. */
export function memoryView(account) {
  const conv = account.conversation_id;
  const ownKey = db.personKey(account.name ?? "");
  const by = new Map(GROUPS.map(([k]) => [k, []]));
  for (const f of db.memoryFacts(conv)) {
    const own = !!ownKey && f.about_key === ownKey;
    by.get(groupOf(f, ownKey)).push({ key: `fact-${f.id}`, kind: "fact", id: f.id, raw: f.fact, line: lineFor(f.about, f.fact, { own }), at: f.created_at });
  }
  for (const w of db.listWhys(conv, { limit: 200 })) {
    const own = !!ownKey && db.personKey(w.about) === ownKey;
    by.get("why").push({ key: `why-${w.id}`, kind: "why", id: w.id, raw: w.why, line: lineFor(w.about, w.why, { own }), at: w.stated_at });
  }
  const groups = GROUPS.map(([key, title]) => ({ key, title, rows: by.get(key).sort((a, b) => b.at - a.at) })).filter(g => g.rows.length);
  const guesses = [...db.listGuesses(conv, { includePatterns: true, limit: 40 })]
    .map(g => ({ id: g.id, text: lineFor(g.about, g.guess, { own: !!ownKey && db.personKey(g.about) === ownKey }) }));
  return { groups, guesses, empty: !groups.length };
}

/** One saved row by its page key ("fact-12", "why-3"), inside this conversation only. */
export function findRow(conv, key) {
  const m = /^(fact|why)-(\d{1,12})$/.exec(String(key ?? ""));
  if (!m) return null;
  const id = Number(m[2]);
  if (m[1] === "fact") {
    const f = db.getFact(conv, id);
    return f ? { kind: "fact", id, raw: f.fact, about: f.about } : null;
  }
  const w = db.getWhy(conv, id);
  return w && !w.superseded_at ? { kind: "why", id, raw: w.why, about: w.about } : null;
}

// ---------------------------------------------------------------- drawing

const withStop = (t) => (/[.!?…]$/.test(t) ? t : `${t}.`);
const hidden = (n, v) => `<input type="hidden" name="${n}" value="${esc(v)}">`;

/** One line between dashed rules, CORRECT and FORGET beside it (they show on hover, focus or a tap). */
export function rowHtml(r, { gotIt = false } = {}) {
  const what = `<span class="sr"> “${esc(r.line)}”</span>`;
  return `<div class="fr" id="f-${r.key}" tabindex="-1" data-k="${r.key}" data-raw="${esc(r.raw)}"><p class="ft">${esc(r.line)}</p>`
    + (gotIt ? `<span class="got" role="status">got it.</span>` : "")
    + `<span class="fa"><a class="fx fc" href="/web/memory?correct=${r.key}#f-${r.key}">CORRECT${what}</a>`
    + `<a class="fx ff" href="/web/memory?forget=${r.key}">FORGET${what}</a></span></div>`;
}

/** 7B: the line as an underline input. `error` is a note under it when the last save didn't take. */
export function editHtml(r, { csrf, error = "" } = {}) {
  return `<form class="fr fe" id="f-${r.key}" method="POST" action="/web/memory/correct">${hidden("c", csrf)}${hidden("k", r.key)}`
    + `<label class="lbl" for="mem-edit">CORRECTING</label>`
    + `<input class="fe-in" id="mem-edit" name="text" type="text" value="${esc(r.raw)}" maxlength="${MAX_TEXT}" required autocomplete="off" autofocus>`
    + (error ? hand(error, { role: "alert" }) : "")
    + `<div class="fe-a"><button class="fe-save" type="submit">Save <span aria-hidden="true">→</span></button>`
    + `<a class="fx fe-x" href="/web/memory#f-${r.key}">CANCEL</a></div></form>`;
}

/** 7C: the forget card, with what it does and what it leaves. */
export function forgetHtml(r, { csrf }) {
  return `<div class="fg-wrap"><div class="card fg" role="dialog" aria-modal="true" aria-labelledby="fg-title" aria-describedby="fg-what">`
    + `<p class="lbl pen">FORGET THIS?</p><h2 id="fg-title" class="fg-t">"${esc(r.line ?? r.raw)}"</h2>`
    + `<p id="fg-what" class="fg-p">I'll stop recalling this. The message where you said it stays in your chat history.</p>`
    + `<form class="fg-a" method="POST" action="/web/memory/forget">${hidden("c", csrf)}${hidden("k", r.key)}`
    + `<button class="fg-go" type="submit">Forget it</button><a class="fx fg-keep" href="/web/memory#f-${r.key}">KEEP IT</a></form></div></div>`;
}

function guessHtml(g, csrf) {
  return `<div class="gs" id="g-${g.id}"><p class="gs-t">${esc(withStop(g.text))}</p>`
    + `<form class="gs-a" method="POST" action="/web/memory/guess">${hidden("c", csrf)}${hidden("id", String(g.id))}`
    + `<button class="gs-y" type="submit" name="answer" value="yes">Yes, that's right</button>`
    + `<button class="gs-n" type="submit" name="answer" value="no">No</button></form></div>`;
}

const CSS = `
.mh{padding:20px 24px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}
.back{min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:400 11.5px/1.3 var(--mono);letter-spacing:.14em}
.mem{flex:1 0 auto;width:100%;max-width:1160px;margin:0 auto;padding:32px 24px 40px;display:flex;flex-direction:column;gap:22px}
.mem-lead{display:flex;flex-direction:column;gap:8px}
.mem .h1{font-size:38px}
.mem-sub{margin:0;font-size:14px;line-height:1.5;color:var(--muted)}
.mem-cols{display:flex;flex-direction:column;gap:22px}
.mem-groups{display:flex;flex-direction:column;gap:22px;min-width:0}
.grp{display:flex;flex-direction:column;min-width:0}
.gh{margin:0 0 2px;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.gh.pen{color:var(--pen)}
.fr{padding:10px 0;border-bottom:1px dashed var(--hair);display:flex;flex-direction:column;gap:2px;outline-offset:2px}
.fr:focus{outline:none}
.ft{margin:0;font-size:15px;line-height:1.3;overflow-wrap:anywhere}
.fa{display:flex;gap:20px;flex-shrink:0;position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fr:hover .fa,.fr:focus .fa,.fr:focus-within .fa,.fr:target .fa{position:static;width:auto;height:auto;overflow:visible;clip:auto}
.fx{min-height:44px;margin:-4px 0;display:inline-flex;align-items:center;border:0;background:transparent;padding:0;cursor:pointer;text-decoration:none;font:400 11px/1.3 var(--mono);letter-spacing:.14em;color:var(--ink)}
.ff{color:var(--pen)}
.got{font:400 22px/1 var(--hand);color:var(--pen);white-space:nowrap;animation:fade 3.2s ease-in 1.2s forwards}
@keyframes fade{to{opacity:0}}
.fr:has(.got):not(:hover):not(:has(.fx:focus)) .fa{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.fr:has(.got){flex-direction:row;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.fe{padding:14px 0;gap:10px}
.fe .lbl{font-size:11px}
.fe-in{height:44px;border:0;border-bottom:1px solid var(--ink);border-radius:0;background:transparent;font:italic 400 21px/1 var(--serif);color:var(--ink);padding:0;width:100%;-webkit-appearance:none;appearance:none}
.fe-in:focus{box-shadow:0 1px 0 0 var(--ink)}
.fe-a{display:flex;gap:24px;align-items:center}
.fe-save,.fg-go,.gs-y,.gs-n{min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 21px/1.15 var(--serif);color:var(--ink);text-align:left}
.fe-x{color:var(--muted)}
.gs-aside{display:flex;flex-direction:column;gap:6px}
.gs-list{display:flex;flex-direction:column;gap:14px}
.gs{display:flex;flex-direction:column;gap:6px}
.gs-t{margin:0;font:400 23px/1.15 var(--hand);color:var(--pen);overflow-wrap:anywhere}
.gs-a{display:flex;gap:24px;margin:0}
.gs-y,.gs-n{font-size:19px}
.gs-n{color:var(--muted)}
.gs-y:hover,.gs-n:hover,.fe-save:hover{color:var(--hov)}
.mem-manage{align-self:flex-start;margin-top:auto;min-height:44px;display:inline-flex;align-items:center;font:400 11.5px/1.3 var(--mono);letter-spacing:.14em;text-decoration:none}
.mem-empty{padding:40px 0 8px;display:flex;flex-direction:column;gap:10px;text-align:center}
.mem-empty .e1{margin:0;font:italic 400 30px/1.15 var(--serif)}
.mem-empty .hand{font-size:21px}
.fg-wrap{position:fixed;inset:0;z-index:40;background:var(--ground);display:flex;align-items:center;justify-content:center;padding:32px 24px;overflow:auto}
.fg{width:100%;max-width:440px;box-shadow:var(--sh2);padding:28px 24px;display:flex;flex-direction:column;gap:18px}
.fg .lbl{font-size:11px;white-space:normal}
.fg-t{margin:0;font:italic 400 28px/1.15 var(--serif);overflow-wrap:anywhere}
.fg-p{margin:0;font-size:15px;line-height:1.55}
.fg-a{display:flex;gap:28px;align-items:center;padding-top:4px;margin:0}
.fg-go{min-height:48px;font-size:24px;color:var(--pen)}
.fg-go:hover{color:var(--pen);text-decoration:underline;text-underline-offset:4px}
.fg-keep{min-height:48px;font-size:12px}
html.fg-open body{overflow:hidden}
@media (max-width:359px){.mh,.mem{padding-left:20px;padding-right:20px}}
@media (min-width:900px){
.mh{padding:22px clamp(20px,4vw,48px)}
.back{font-size:12px}
.mem{padding:48px clamp(20px,4vw,48px) 64px;gap:56px}
.mem-lead{gap:12px}
.mem .h1{font-size:64px}
.mem-sub{font-size:18px}
.mem-cols{flex-direction:row;flex-wrap:wrap;gap:72px;align-items:flex-start}
.mem-groups{flex:999 1 560px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px 56px}
.grp.wide{grid-column:span 2}
.gh{font-size:12px;margin-bottom:4px}
.fr{padding:12px 0;flex-direction:row;justify-content:space-between;align-items:center;gap:12px}
.ft{font-size:16px}
.fa{gap:16px}
.fx{margin:-10px 0}
.fe{flex-direction:column;align-items:stretch;padding:14px 0}
.fr:has(.got){flex-wrap:nowrap}
.gs-aside{box-sizing:content-box;flex:1 1 280px;max-width:320px;display:flex;flex-direction:column;gap:28px;padding-left:40px;border-left:1px dashed var(--hair)}
.gs-aside .gh{margin:0}
.gs-list{gap:28px}
.gs-t{font-size:26px}
.gs-a{gap:22px}
.gs-y,.gs-n{font-size:20px}
.mem-manage{font-size:12px;margin-top:0}
.mem-empty{text-align:left;padding-top:0}
}
@media (hover:hover){.fr:hover{cursor:default}}
@media (prefers-reduced-motion:reduce){.got{animation:none!important;opacity:1}}
`;

// Keeps the page where it is: CORRECT and FORGET open in place, and each save is a fetch that swaps
// in the server's own line. Without script every one of these is the link or form it already is.
const JS = `(function(){var C=(window.REASON_MEM||{}).c||'';var live=document.getElementById('mem-live');
function say(t){if(live){live.textContent='';setTimeout(function(){live.textContent=t},30)}}
function post(url,data){data.c=C;return fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json','X-Reason-Csrf':C},body:new URLSearchParams(data)}).then(function(r){return r.json().catch(function(){return{ok:false}}).then(function(j){if(!r.ok||!j.ok)throw j;return j})})}
function el(html){var d=document.createElement('div');d.innerHTML=html;return d.firstElementChild}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function tidy(sec){if(sec&&!sec.querySelector('.fr')){sec.remove();if(!document.querySelector('.grp'))location.replace('/web/memory')}}
function edit(row){var k=row.dataset.k,raw=row.dataset.raw;
var f=el('<form class="fr fe" id="f-'+k+'" method="POST" action="/web/memory/correct"><label class="lbl" for="mem-edit">CORRECTING</label><input class="fe-in" id="mem-edit" name="text" type="text" maxlength="${MAX_TEXT}" required autocomplete="off"><p class="hand" role="alert" hidden></p><div class="fe-a"><button class="fe-save" type="submit">Save <span aria-hidden="true">→</span></button><button class="fx fe-x" type="button">CANCEL</button></div></form>');
var inp=f.querySelector('input'),err=f.querySelector('[role=alert]');inp.value=raw;row.replaceWith(f);inp.focus();inp.setSelectionRange(raw.length,raw.length);
function back(){f.replaceWith(row);var a=row.querySelector('.fc');if(a)a.focus()}
f.querySelector('.fe-x').addEventListener('click',back);inp.addEventListener('keydown',function(e){if(e.key==='Escape')back()});
f.addEventListener('submit',function(e){e.preventDefault();var b=f.querySelector('.fe-save');if(b.getAttribute('aria-busy'))return;b.setAttribute('aria-busy','true');
post('/web/memory/correct',{k:k,text:inp.value}).then(function(j){var n=el(j.html);f.replaceWith(n);n.focus();say('Got it.')}).catch(function(j){b.removeAttribute('aria-busy');err.textContent=(j&&j.say)||"that didn't save. try again?";err.hidden=false})})}
function forget(row){var k=row.dataset.k,line=row.querySelector('.ft').textContent,opener=document.activeElement;
var w=el('<div class="fg-wrap"><div class="card fg" role="dialog" aria-modal="true" aria-labelledby="fg-title" aria-describedby="fg-what"><p class="lbl pen">FORGET THIS?</p><h2 id="fg-title" class="fg-t" tabindex="-1">&quot;'+esc(line)+'&quot;</h2><p id="fg-what" class="fg-p">I\\'ll stop recalling this. The message where you said it stays in your chat history.</p><p class="hand" role="alert" hidden></p><div class="fg-a"><button class="fg-go" type="button">Forget it</button><button class="fx fg-keep" type="button">KEEP IT</button></div></div></div>');
document.body.appendChild(w);document.documentElement.classList.add('fg-open');var go=w.querySelector('.fg-go'),keep=w.querySelector('.fg-keep');go.focus();
function close(){w.remove();document.documentElement.classList.remove('fg-open');document.removeEventListener('keydown',key);if(opener&&opener.focus)opener.focus()}
function key(e){if(e.key==='Escape')close();if(e.key==='Tab'){var a=[go,keep],i=a.indexOf(document.activeElement);e.preventDefault();a[(i+(e.shiftKey?a.length-1:1))%a.length].focus()}}
document.addEventListener('keydown',key);keep.addEventListener('click',close);
go.addEventListener('click',function(){if(go.getAttribute('aria-busy'))return;go.setAttribute('aria-busy','true');post('/web/memory/forget',{k:k}).then(function(){var sec=row.closest('.grp'),next=row.nextElementSibling;opener=next&&next.classList.contains('fr')?next:(sec&&sec.querySelector('.gh'));row.remove();close();say('Forgotten.');tidy(sec)}).catch(function(j){go.removeAttribute('aria-busy');var e=w.querySelector('[role=alert]');e.textContent=(j&&j.say)||"that didn't go through. try again?";e.hidden=false})})}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a.fc,a.ff');if(!a)return;var row=a.closest('.fr');if(!row||!row.dataset.k)return;e.preventDefault();if(a.classList.contains('fc'))edit(row);else forget(row)});
document.querySelectorAll('form.gs-a').forEach(function(f){f.addEventListener('submit',function(){f.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-busy','true')})})});
document.addEventListener('animationend',function(e){if(e.target.classList&&e.target.classList.contains('got'))e.target.remove()});
var got=document.querySelector('.got');if(got){var r=got.closest('.fr');if(r)r.focus({preventScroll:true})}
})();`;

/**
 * The whole page. `state` is what a no-script visit asked for: `{ correct: key, error }`,
 * `{ forget: key }`, or `{ fixed: key }` (a line just corrected, "got it." beside it).
 */
export function renderMemory({ account, csrf, state = {} }) {
  const view = memoryView(account);
  let card = "";
  const groupsHtml = view.groups.map((g, i, all) => {
    const wide = all.length % 2 === 1 && i === all.length - 1;
    const rows = g.rows.map(r => {
      if (state.correct === r.key) return editHtml(r, { csrf, error: state.error });
      if (state.forget === r.key) card = forgetHtml(r, { csrf });
      return rowHtml(r, { gotIt: state.fixed === r.key });
    }).join("");
    return `<section class="grp${wide ? " wide" : ""}" aria-labelledby="gh-${g.key}"><h2 class="gh" id="gh-${g.key}">${g.title}</h2>${rows}</section>`;
  }).join("");
  const empty = view.empty
    ? `<div class="mem-empty"><p class="e1">Nothing saved yet.</p>${hand("i'll jot things down as i learn them.")}</div>` : "";
  const guesses = view.guesses.length
    ? `<aside class="gs-aside" aria-labelledby="gh-guess"><h2 class="gh pen" id="gh-guess">REASON THINKS…</h2><div class="gs-list">${view.guesses.map(g => guessHtml(g, csrf)).join("")}</div></aside>` : "";
  const body = `<header class="mh">${typed("← BACK TO THE CHAT", { href: "/web?thread", cls: "back" })}${wordmark({ href: "/web" })}</header>`
    + `<main class="mem" aria-labelledby="mem-h"><div class="mem-lead"><h1 id="mem-h" class="h1">What Reason <em>remembers</em></h1>`
    + `<p class="mem-sub">See it, correct it, or ask Reason to forget it.</p></div>`
    + `<p class="sr" role="status" id="mem-live">${state.gone ? "Forgotten." : state.answered ? "Got it." : ""}</p>`
    + `<div class="mem-cols">${empty || `<div class="mem-groups">${groupsHtml}</div>`}${guesses}</div>`
    + `<a class="mem-manage" href="/web?thread">MANAGE CHAT HISTORY →</a>`
    + `</main>${card}`;
  return webPage({ title: "Reason — Memory", body, css: CSS, script: `window.REASON_MEM={c:${JSON.stringify(String(csrf ?? ""))}};${card ? "document.documentElement.classList.add('fg-open');" : ""}` + JS });
}

// ---------------------------------------------------------------- changing it

/** Correct one row in place. Returns `{ ok, key }` (the line's key now) or `{ ok: false, error, status }`. */
export async function correctRow(conv, key, text, { log = () => {} } = {}) {
  const row = findRow(conv, key);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, status: 400, error: "empty", say: "it needs some words." };
  if (clean.length > MAX_TEXT) return { ok: false, status: 413, error: "too_long", say: "that's a bit long for one line." };
  if (clean === row.raw) return { ok: true, key, unchanged: true };
  let newKey;
  if (row.kind === "fact") {
    const out = db.correctFact(conv, row.id, { fact: clean });
    if (!out.ok) return { ok: false, status: 409, error: "same_as_another", say: "that's already saved as its own line." };
    newKey = `fact-${out.newId}`;
    import("../embedding.js").then(m => { m.removeEmbedding(row.id); return m.embedAndStore(conv, out.newId, `${row.about}: ${clean}`); }).catch(() => {});
    import("../extract.js").then(m => m.scheduleProfile(conv, { log })).catch(() => {});
  } else {
    const out = db.correctWhy(conv, row.id, { why: clean, said: "(corrected on Reason Web)" });
    if (!out.ok) return { ok: false, status: 409, error: "not_corrected" };
    newKey = `why-${out.why.id}`;
  }
  // The old wording out of everything the next turn reads, as memory_fix does (src/tools.js).
  db.scrubToolResults(conv, { tools: db.MEMORY_TOOL_NAMES, mentioning: [row.raw] });
  db.redactFromReplies(conv, [row.raw]);
  log({ web_memory: "corrected", kind: row.kind });
  return { ok: true, key: newKey };
}

/** Take one row back: it stops being recalled. Their messages stay. */
export async function forgetRow(conv, key, { log = () => {} } = {}) {
  const row = findRow(conv, key);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  const out = row.kind === "fact" ? db.dropFact(conv, row.id) : db.dropWhy(conv, row.id);
  if (!out.ok) return { ok: false, status: 404, error: "not_found" };
  db.scrubToolResults(conv, { tools: db.MEMORY_TOOL_NAMES, mentioning: [row.raw] });
  db.redactFromReplies(conv, [row.raw]);
  if (row.kind === "fact") {
    import("../embedding.js").then(m => m.removeEmbedding(row.id)).catch(() => {});
    import("../extract.js").then(m => m.scheduleProfile(conv, { log })).catch(() => {});
  }
  log({ web_memory: "forgotten", kind: row.kind });
  return { ok: true };
}

/** "Yes, that's right": the guess becomes a fact in their name. "No": it is dismissed and never suggested again. */
export async function answerGuess(conv, id, answer, { log = () => {} } = {}) {
  const g = /^\d{1,12}$/.test(String(id ?? "")) ? db.getGuess(conv, Number(id)) : null;
  if (!g || g.confirmed_at || g.dismissed_at) return { ok: false, status: 404, error: "not_found" };
  if (answer === "yes") {
    const saved = db.remember(conv, g.about, g.guess, { source: "user_stated" });
    db.confirmGuess(conv, { about: g.about, guess: g.guess, said: "Yes, that's right (Reason Web)" });
    if (saved?.factId) import("../extract.js").then(m => m.scheduleProfile(conv, { log })).catch(() => {});
    log({ web_memory: "guess_confirmed" });
    return { ok: true, factKey: saved?.factId ? `fact-${saved.factId}` : null };
  }
  if (answer === "no") {
    db.dismissGuess(conv, g.id);
    log({ web_memory: "guess_dismissed" });
    return { ok: true };
  }
  return { ok: false, status: 400, error: "bad_answer" };
}

// ---------------------------------------------------------------- routes

const json = (status, obj) => {
  const body = JSON.stringify(obj);
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body };
};
const html = (status, body) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body });
const to = (location) => ({ status: 303, headers: { ...SECURITY_HEADERS, Location: location, "Content-Length": 0 }, body: "" });
const KEY = /^(fact|why)-\d{1,12}$/;
function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** A row's line as the page draws it, for the script to swap in after a save. */
function rowFor(account, key, opts) {
  for (const g of memoryView(account).groups) for (const r of g.rows) if (r.key === key) return rowHtml(r, opts);
  return "";
}

/**
 * GET /web/memory, POST /web/memory/correct|forget|guess. `account` is the session's (never the
 * form's); a post answers JSON to the page's script and a 303 back to the page to a plain form.
 */
export async function memoryRequest({ account, action = null, method, query = {}, headers = {}, readBody, log = () => {} }) {
  const conv = account.conversation_id;
  const csrf = db.pageSessionCsrf(readCookie(headers.cookie));
  if (!action) {
    if (method !== "GET" && method !== "HEAD") return html(405, renderNotFound());
    const pick = (v) => (KEY.test(String(v ?? "")) && findRow(conv, v) ? String(v) : "");
    const errors = { empty: "it needs some words.", too_long: "that's a bit long for one line.", same_as_another: "that's already saved as its own line." };
    const state = {
      correct: pick(query.correct), forget: pick(query.forget), fixed: pick(query.fixed),
      error: errors[query.err] ?? "", gone: query.gone != null, answered: query.answered != null,
    };
    return html(200, renderMemory({ account, csrf, state }));
  }
  if (method !== "POST") return html(405, renderNotFound());
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  const form = new URLSearchParams((await readBody()) ?? "");
  const given = headers["x-reason-csrf"] || form.get("c");
  if (!sameOrigin(headers) || !same(given, csrf)) {
    log({ web_memory_refused: "origin_or_token" });
    return wantsJson ? json(403, { ok: false, error: "not_from_this_page" }) : html(403, renderNotFound());
  }
  const miss = (out, back) => {
    if (wantsJson) return json(out.status ?? 400, { ok: false, error: out.error, ...(out.say ? { say: out.say } : {}) });
    if (out.status === 404) return html(404, renderNotFound());
    return to(back);
  };
  if (action === "correct") {
    const key = String(form.get("k") ?? "");
    const out = await correctRow(conv, key, form.get("text"), { log });
    if (!out.ok) return miss(out, `/web/memory?correct=${encodeURIComponent(key)}&err=${out.error}#f-${encodeURIComponent(key)}`);
    if (wantsJson) return json(200, { ok: true, key: out.key, html: rowFor(account, out.key, { gotIt: true }) });
    return to(`/web/memory?fixed=${out.key}#f-${out.key}`);
  }
  if (action === "forget") {
    const out = await forgetRow(conv, String(form.get("k") ?? ""), { log });
    if (!out.ok) return miss(out, "/web/memory");
    return wantsJson ? json(200, { ok: true }) : to("/web/memory?gone=1");
  }
  if (action === "guess") {
    const out = await answerGuess(conv, form.get("id"), String(form.get("answer") ?? ""), { log });
    if (!out.ok) return miss(out, "/web/memory");
    if (wantsJson) return json(200, { ok: true, key: out.factKey ?? null });
    return to(out.factKey ? `/web/memory?answered=1&fixed=${out.factKey}#f-${out.factKey}` : "/web/memory?answered=1");
  }
  return html(404, renderNotFound());
}

