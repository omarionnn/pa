// The Connect pages: sign in to a store, and add a card, for Crossmint agent checkouts (src/shopconnect.js).
//
//   GET  /web/connect/{token}            the page for that link, drawn in its current state
//   GET  /web/connect/{token}/state      { state } for the open page to notice a change and redraw
//   POST /web/connect/{token}/answer     { requestId, answers }: the sign-in answer (secrets as references only)
//   POST /web/connect/{token}/card       { paymentMethodId, brand, last4 } after Crossmint saved the card
//   GET  /web/connect/island.js          Crossmint's two fields (web-island/, built and committed)
//   GET  /web/connect/jwks.json          the public key Crossmint checks the person's JWT against
//   GET  /web/connect/new-card           signed in (and allowed): a fresh "Add a card" link, then there
//
// One thing per screen (owner 10-30): the store's sign-in, a code, "that didn't work", checking,
// connected, run out; for the card, the form and saved. Every screen says plainly what Reason can and
// can't see. The secret fields are Crossmint's own iframe: what is typed there never reaches this page's
// script or this server, and the field is drawn masked. Copy says what to do, never words to type.
import { readFileSync } from "node:fs";
import { esc } from "./render.js";
import { webPage, wordmark, label, hand, action, typed, stamp, onIt, rule } from "./webkit.js";
import { SECURITY_HEADERS } from "./websignin.js";
import * as shop from "../shopconnect.js";

// ---------------------------------------------------------------- store marks
// Drawn, not the stores' artwork: a plain mark in each store's colour, so the page says whose sign-in
// this is at a glance. Unknown stores get the first letter on a hairline ring.
const MARKS = {
  target: `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#cc0000"/><circle cx="20" cy="20" r="12" fill="#fff"/><circle cx="20" cy="20" r="6.5" fill="#cc0000"/></svg>`,
  walmart: `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" fill="#0071ce"/><g fill="#ffc220">${[0, 60, 120, 180, 240, 300].map((a) => `<rect x="18.4" y="6.5" width="3.2" height="9" rx="1.6" transform="rotate(${a} 20 20)"/>`).join("")}</g></svg>`,
  bestbuy: `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="2" y="2" width="36" height="36" rx="4" fill="#0046be"/><path d="M8 12h20l5 8-5 8H8z" fill="#fff200"/><circle cx="27" cy="20" r="1.8" fill="#0046be"/></svg>`,
};
export function storeMark(store) {
  if (MARKS[store]) return `<span class="cx-mark">${MARKS[store]}</span>`;
  const n = shop.storeName(store) || "?";
  return `<span class="cx-mark cx-mark-x" aria-hidden="true">${esc(n.slice(0, 1).toUpperCase())}</span>`;
}

// ---------------------------------------------------------------- the stylesheet
const CSS = `
.cx-head{padding:20px 28px 0;display:flex;align-items:center;justify-content:space-between;gap:16px}
.cx-head .lbl{display:inline-flex;align-items:center;gap:8px}
.cx{flex:1 0 auto;width:100%;max-width:1080px;margin:0 auto;padding:20px 28px 36px;display:flex;flex-direction:column}
.cx-cols{display:flex;flex-wrap:wrap;gap:40px 96px;align-items:flex-start}
.cx-in{flex:1 1 420px;min-width:0;max-width:560px;display:flex;flex-direction:column;gap:26px}
.cx-who{display:flex;align-items:center;gap:12px}
.cx-mark{width:44px;height:44px;flex:none;display:grid;place-items:center}
.cx-mark svg{width:44px;height:44px;display:block}
.cx-mark-x{border:1px solid var(--hair);border-radius:50%;font:italic 400 24px/1 var(--serif);color:var(--ink)}
.cx-lead{display:flex;flex-direction:column;gap:12px}
.cx-sub{margin:0;font-size:17px;line-height:1.5;color:var(--muted);max-width:30em}
.cx-sub b{color:var(--ink);font-weight:600}
.cx-form{display:flex;flex-direction:column;gap:26px;margin:0}
.cx-sheet{padding:22px 20px 18px;display:flex;flex-direction:column;gap:22px}
.cx-field{display:flex;flex-direction:column;gap:8px}
.cx-field>label,.cx-field>.cx-l{font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted);text-transform:uppercase;display:flex;align-items:center;gap:8px;justify-content:space-between}
.cx-seal{display:inline-flex;align-items:center;gap:5px;color:var(--pen);letter-spacing:.12em}
.cx-seal svg{width:11px;height:11px}
.cx-in input.ul{width:100%;height:50px;border:0;border-bottom:1px solid var(--ink);border-radius:0;background:transparent;font:400 19px/1 var(--mono);letter-spacing:.03em;color:var(--ink);padding:0;-webkit-appearance:none;appearance:none}
.cx-in input.ul::placeholder{color:var(--muted);opacity:1}
.cx-in input.ul:focus{box-shadow:0 1px 0 0 var(--ink)}
.cm-slot{min-height:50px;border-bottom:1px solid var(--ink);display:flex;align-items:center}
.cm-slot iframe{width:100%!important}
.cm-slot.bad{border-bottom-color:var(--pen)}
.cm-slot input.ul{border-bottom:0}
.cm-code{border-bottom-width:1.5px}
.cm-code input.ul{font-size:28px;letter-spacing:.5em}
.cx-field .hand{font-size:19px}
.cx-note{min-height:1.2em}
.cx-acts{display:flex;align-items:center;gap:16px 36px;flex-wrap:wrap}
.cx-can{flex:1 1 300px;max-width:400px;display:flex;flex-direction:column;gap:18px}
.cx-can ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.cx-can li{display:flex;gap:10px;font-size:15px;line-height:1.45}
.cx-can li::before{content:"";flex:none;width:14px;height:1px;background:var(--hair);margin-top:.75em}
.cx-can .no li{color:var(--muted)}
.cx-can .no li::before{background:var(--pen)}
.cx-who-h{margin:0;font:400 10.5px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.cx-who-h.pen{color:var(--pen)}
.cx-foot{margin-top:auto;padding-top:28px;display:flex;gap:10px 28px;flex-wrap:wrap}
.cx-done{gap:22px}
.cx-done .stamp{font-size:13px;padding:5px 10px}
.cx-wait{display:flex;flex-direction:column;gap:22px}
.cx-card .cm-slot{border:0;display:block;min-height:260px}
.cx-cardnum{font:400 15px/1.5 var(--mono);letter-spacing:.08em}
.cx-stand{display:flex;flex-direction:column;gap:14px}
.cx-stand .row{display:flex;gap:18px}.cx-stand .row>*{flex:1}
.cx-stand .cx-l{font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.cx-stand .v{height:44px;border-bottom:1px solid var(--hair);font:400 18px/44px var(--mono);color:var(--muted);letter-spacing:.06em}
.stg{position:fixed;right:12px;bottom:12px;z-index:60;font:700 10px/1 var(--mono);letter-spacing:.12em;padding:6px 8px;border:1px solid var(--pen);color:var(--pen);background:var(--lifted)}
@media (max-width:359px){.cx-head,.cx{padding-left:20px;padding-right:20px}}
@media (max-width:899px){.cx-can{padding-top:22px;border-top:1px dashed var(--hair);max-width:none}}
@media (min-width:900px){
.cx-head{padding:22px clamp(20px,4vw,48px)}
.cx{padding:56px clamp(20px,4vw,48px) 64px}
.cx-can{padding-left:48px;border-left:1px dashed var(--hair);margin-top:8px}
.cx-sub{font-size:18px}
.cx-sheet{padding:26px 26px 22px}
}
`;

// ---------------------------------------------------------------- pieces
const LOCK = `<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.2" width="8" height="5.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
const seal = `<span class="cx-seal">${LOCK}SEALED</span>`;
const head = (store) => `<header class="cx-head">${wordmark({ href: "/web?home" })}${store ? `<p class="lbl">${esc(shop.storeName(store).toUpperCase())} · VIA CROSSMINT</p>` : `<p class="lbl">VIA CROSSMINT</p>`}</header>`;

/** What Reason can and can't see, said once, beside every sign-in screen. */
function canCant(store) {
  const n = esc(shop.storeName(store) || "the store");
  return `<aside class="cx-can" aria-label="What Reason can and can't see">`
    + `<p class="cx-who-h">WHAT I CAN SEE</p><ul><li>That you're signed in to ${n}.</li><li>Your cart, and the orders I place for you.</li></ul>`
    + `<p class="cx-who-h pen">WHAT I NEVER SEE</p><ul class="no"><li>Your password, or the codes ${n} sends you. They're typed into Crossmint's sealed field and go straight to ${n}.</li><li>Your card number.</li></ul>`
    + `<p class="cx-who-h">AND</p><ul><li>I still ask you by text before paying for anything, with the exact total.</li><li>Remove ${n} any time in Settings.</li></ul>`
    + `</aside>`;
}

/**
 * One field of the store's question. A protected one is a slot Crossmint's iframe mounts into (or, on
 * staging, a stand-in drawn masked); a standard one is our own underline input.
 */
function field(f, { staging = false, bad = false }) {
  const id = `f-${esc(f.key)}`;
  const lbl = esc(String(f.label || f.key).toUpperCase());
  if (f.handling === "protected") {
    const code = f.input?.autoComplete === "one-time-code" || f.input?.inputMode === "numeric";
    const inner = staging
      ? `<input class="ul" id="${id}" type="password" value="${code ? "482913" : "correcthorse"}" readonly tabindex="-1" aria-label="${lbl} (sealed)">`
      : "";
    return `<div class="cx-field"><span class="cx-l" id="${id}-l">${lbl}${seal}</span>`
      + `<div class="cm-slot${code ? " cm-code" : ""}${bad ? " bad" : ""}" data-protected="${esc(f.key)}" aria-labelledby="${id}-l">${inner}</div></div>`;
  }
  const kind = f.input?.kind ?? "text";
  const auto = f.input?.autoComplete ? ` autocomplete="${esc(f.input.autoComplete)}"` : "";
  const mode = f.input?.inputMode ? ` inputmode="${esc(f.input.inputMode)}"` : "";
  const type = f.input?.autoComplete === "email" || f.input?.inputMode === "email" ? "email" : kind === "number" || kind === "integer" ? "text" : f.input?.display === "masked" ? "password" : "text";
  const val = staging && type === "email" ? ` value="ama.owusu@example.com"` : "";
  return `<div class="cx-field"><label for="${id}">${lbl}</label><input class="ul" id="${id}" name="${esc(f.key)}" type="${type}"${auto}${mode}${f.required ? " required" : ""}${val} spellcheck="false" autocapitalize="off"></div>`;
}

/** The store's own question, when it says more than "sign in". Shown as theirs, in muted type. */
const storeSays = (rq, store) => rq?.question
  ? `<p class="cx-sub">${esc(shop.storeName(store))} says: <b>${esc(rq.question)}</b></p>` : "";

// ---------------------------------------------------------------- the screens
export function renderSignin({ view, staging = false }) {
  const { store, request: rq, state } = view;
  const n = shop.storeName(store) || "the store";
  const retry = state === "retry";
  const code = state === "code";
  const h1 = code ? `${n} sent you a code.` : `Sign in to ${n}.`;
  const sub = code
    ? `<p class="cx-sub">It's the code ${esc(n)} just texted or emailed you. It goes into the sealed field below, straight to ${esc(n)}.</p>${storeSays(rq, store)}`
    : retry
      ? `<p class="cx-sub">${esc(n)} didn't accept that. Check your email and password and give it another go.</p>`
      : `<p class="cx-sub">${esc(n)} only lets people with an account check out. Sign in once and I'll use it for your ${esc(n)} orders from now on.</p>`;
  const note = retry ? hand(`${n.toLowerCase()} said no to that one.`, { role: "alert", cls: "cx-note" })
    : code ? hand("it only works for a few minutes.", { cls: "cx-note" })
      : hand("the password field is crossmint's, not mine.", { cls: "cx-note" });
  const form = `<form class="cx-form" id="cx-form" data-request="${esc(rq?.requestId ?? "")}" novalidate>`
    + `<div class="card cx-sheet">${(rq?.fields ?? []).map((f) => field(f, { staging, bad: retry && f.handling === "protected" })).join("")}${note}</div>`
    + `<div class="cx-acts">${action(code ? "Continue" : "Sign in", { attrs: ` data-busy="1"` })}<p class="lbl" id="cx-left"></p></div>`
    + `<p class="hand" id="cx-err" role="alert" hidden></p></form>`;
  const body = `${head(store)}<main class="cx" id="cx-main"><div class="cx-cols"><section class="cx-in" aria-labelledby="cx-h">`
    + `<div class="cx-lead"><div class="cx-who">${storeMark(store)}</div><h1 class="h1" id="cx-h">${esc(h1)}</h1>${sub}</div>${form}</section>`
    + `${canCant(store)}</div></main>`;
  return page(`Reason — sign in to ${n}`, body, { staging });
}

export function renderChecking({ view, staging = false }) {
  const n = shop.storeName(view.store) || "the store";
  const body = `${head(view.store)}<main class="cx"><section class="cx-in cx-wait" aria-labelledby="cx-h">`
    + `<div class="cx-who">${storeMark(view.store)}</div>${onIt()}<h1 class="h1" id="cx-h">Signing in to ${esc(n)}…</h1>`
    + `<p class="cx-sub">This takes a few seconds. Keep this page open; if ${esc(n)} sends you a code, it'll ask for it right here.</p>`
    + `</section></main>`;
  return page(`Reason — signing in`, body, { staging });
}

export function renderConnected({ view, staging = false }) {
  const n = shop.storeName(view.store) || "the store";
  const body = `${head(view.store)}<main class="cx"><section class="cx-in cx-done" aria-labelledby="cx-h">`
    + `<div class="cx-who">${storeMark(view.store)}${stamp("Connected ✓")}</div>`
    + `<h1 class="h1" id="cx-h">You're signed in to ${esc(n)}.</h1>`
    + `<p class="cx-sub">I'll use it for ${esc(n)} orders from now on, so I won't need to ask again. Before I pay for anything, I'll still text you the exact total and wait for your yes.</p>`
    + `${action("Back to Reason", { href: "/web?thread" })}${rule()}<p class="cx-sub">Changed your mind? Remove ${esc(n)} any time in ${`<a href="/web/settings#shopping">Settings</a>`}.</p>`
    + `</section></main>`;
  return page(`Reason — ${n} connected`, body, { staging });
}

export function renderEnded({ view, staging = false }) {
  const n = shop.storeName(view.store) || "";
  const card = view.kind === "card";
  const failed = view.state === "failed";
  const h1 = failed ? "That sign-in didn't go through." : "This link has run out.";
  const sub = failed
    ? `${esc(n || "The store")} stopped it before it finished. Nothing was bought. I'll tell you in the chat what happened.`
    : card
      ? "Links to add a card only last half an hour. Nothing was saved. Ask me for a fresh one whenever you're ready."
      : `Links to sign in only last half an hour. Nothing was signed in. Next time ${esc(n || "a store")} needs you, I'll send a fresh one.`;
  const body = `${head(view.store)}<main class="cx"><section class="cx-in" aria-labelledby="cx-h">`
    + `${view.store ? `<div class="cx-who">${storeMark(view.store)}</div>` : ""}${stamp(failed ? "Not signed in" : "Expired", "muted")}`
    + `<h1 class="h1" id="cx-h">${h1}</h1><p class="cx-sub">${sub}</p>${typed("BACK TO REASON →", { href: "/web?thread" })}</section></main>`;
  return page("Reason — link", body, { staging, status: failed ? 200 : 410 });
}

export function renderCard({ staging = false, card = null }) {
  if (card) {
    const brand = card.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : "Card";
    const body = `${head("")}<main class="cx"><section class="cx-in cx-done" aria-labelledby="cx-h">`
      + `${stamp("Saved ✓")}<h1 class="h1" id="cx-h">${esc(brand)} ending ${esc(card.last4 || "····")} is on file.</h1>`
      + `<p class="cx-sub">It's kept by Crossmint. Next time I check out for you, I'll text you the store and the exact total first. Nothing is paid until you say yes.</p>`
      + `${action("Back to Reason", { href: "/web?thread" })}${rule()}<p class="cx-sub">Remove it any time in <a href="/web/settings#shopping">Settings</a>.</p></section></main>`;
    return page("Reason — card saved", body, { staging });
  }
  const form = staging
    ? `<div class="cx-stand" aria-label="Crossmint's card form (staging stand-in)"><div><p class="cx-l">CARD NUMBER</p><p class="v">4242 4242 4242 4242</p></div><div class="row"><div><p class="cx-l">EXPIRES</p><p class="v">12 / 29</p></div><div><p class="cx-l">CVC</p><p class="v">•••</p></div></div><div><p class="cx-l">ZIP</p><p class="v">10010</p></div></div>`
    : "";
  const body = `${head("")}<main class="cx"><div class="cx-cols"><section class="cx-in" aria-labelledby="cx-h">`
    + `<div class="cx-lead"><h1 class="h1" id="cx-h">Add a card.</h1><p class="cx-sub">So I can pay when you say yes. It goes straight to Crossmint, who keeps it. I only ever see the brand and the last four digits.</p></div>`
    + `<form class="cx-form" id="cx-card" novalidate><div class="card cx-sheet cx-card"><span class="cx-l lbl">CARD ${seal}</span><div class="cm-slot" data-card="1">${form}</div></div>`
    + `<div class="cx-acts">${action("Save card", { attrs: ` data-busy="1"` })}</div><p class="hand" id="cx-err" role="alert" hidden></p></form></section>`
    + `<aside class="cx-can" aria-label="What saving a card does"><p class="cx-who-h">SAVING IT</p><ul><li>Spends nothing.</li><li>Lets me pay at a store's checkout, only after you say yes by text to the exact total.</li></ul>`
    + `<p class="cx-who-h pen">I NEVER SEE</p><ul class="no"><li>The card number, the expiry or the security code.</li></ul><p class="cx-who-h">AND</p><ul><li>Remove it any time in Settings.</li></ul></aside></div></main>`;
  return page("Reason — add a card", body, { staging });
}

/** The right screen for a link's view. */
export function renderView(view, opts = {}) {
  if (view.state === "signin" || view.state === "code" || view.state === "retry") return renderSignin({ view, ...opts });
  if (view.state === "checking") return renderChecking({ view, ...opts });
  if (view.state === "connected") return view.kind === "card" ? renderCard({ ...opts, card: opts.card ?? { brand: "", last4: "" } }) : renderConnected({ view, ...opts });
  if (view.state === "card") return renderCard(opts);
  return renderEnded({ view, ...opts });
}

// ---------------------------------------------------------------- the page and its script
// The script: mount Crossmint's fields (island.js), collect the references, post the answer, then
// watch /state and redraw when the record moves on. It never reads a secret: there is none to read.
const JS = (boot) => `(function(){var B=${JSON.stringify(boot).replace(/</g, "\\u003c")};if(!B.token)return;
var base='/web/connect/'+B.token,form=document.getElementById('cx-form')||document.getElementById('cx-card'),err=document.getElementById('cx-err');
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
function look(){return{variables:{fontFamily:'"Courier New",Courier,monospace',fontSizeUnit:'4.6px',borderRadius:'0px',colors:{backgroundPrimary:css('--lifted'),textPrimary:css('--ink'),textSecondary:css('--muted'),borderPrimary:css('--lifted'),accent:css('--pen'),danger:css('--pen')}}}}
function oops(t){if(!err)return;err.textContent=t;err.hidden=false}
function busy(on){var b=form&&form.querySelector('button.act');if(!b)return;b.setAttribute('aria-busy',on?'true':'false');b.disabled=on}
var fields={},card=null;
function mount(){if(!window.ReasonCrossmint||!form)return;
form.querySelectorAll('[data-protected]').forEach(function(el){var f=(B.fields||[]).filter(function(x){return x.key===el.getAttribute('data-protected')})[0];if(f)fields[f.key]=ReasonCrossmint.protectedField(el,{apiKey:B.apiKey,jwt:B.jwt,field:f,appearance:look()})});
var c=form.querySelector('[data-card]');if(c)card=ReasonCrossmint.cardForm(c,{apiKey:B.apiKey,jwt:B.jwt,appearance:look()})}
function post(path,body){return fetch(base+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{ok:false}})})}
if(form)form.addEventListener('submit',function(e){e.preventDefault();if(err)err.hidden=true;busy(true);
if(card){card.submit().then(function(r){if(r.status!=='saved'){busy(false);return oops(r.message||'That card didn\\u2019t save. Check it and try again.')}return post('/card',r.card).then(function(o){if(o.ok)location.reload();else{busy(false);oops('Saved at Crossmint, but I couldn\\u2019t note it. Reload this page.')}})});return}
var answers={},keys=Object.keys(fields);
form.querySelectorAll('input[name]').forEach(function(i){if(i.value!=='')answers[i.name]=i.value});
Promise.all(keys.map(function(k){return fields[k].collect()})).then(function(rs){for(var i=0;i<rs.length;i++){if(rs[i].status!=='collected'){fields[keys[i]].setInvalid(true);busy(false);return oops(rs[i].message||'That field needs another look.')}answers[keys[i]]=rs[i].input}
return post('/answer',{requestId:form.getAttribute('data-request'),answers:answers}).then(function(o){if(o.ok||o.state)location.reload();else{busy(false);oops('That didn\\u2019t go through. Try once more.')}})}).catch(function(){busy(false);oops('That didn\\u2019t go through. Try once more.')})});
if(B.watch){var was=B.state;setInterval(function(){fetch(base+'/state',{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){return r.json()}).then(function(o){if(o&&o.state&&o.state!==was)location.reload()}).catch(function(){})},2500)}
if(form&&B.apiKey){var s=document.createElement('script');s.src='/web/connect/island.js';s.onload=mount;document.head.appendChild(s)}})();`;

function page(title, body, { staging = false, status = 200 } = {}) {
  const html = webPage({ title, body: body + (staging ? `<p class="stg">STAGING · SAMPLE</p>` : ""), css: CSS });
  return { status, html };
}

// ---------------------------------------------------------------- routes
// Web's own headers, with room for Crossmint and nothing else: its iframe (the sealed fields and the
// card form), its SDK's calls, and our own island script. Still no framing of this page by anybody.
const CROSSMINT = "https://www.crossmint.com https://*.crossmint.com";
export const CONNECT_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${CROSSMINT}; frame-src ${CROSSMINT}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
};
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...CONNECT_HEADERS, ...extra });
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body }; };
const send = ({ status, html }) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(html) }), body: html });
let ISLAND = null;
const island = () => (ISLAND ??= readFileSync(new URL("../../assets/connect/crossmint-island.js", import.meta.url)));

/**
 * Everything under /web/connect. `sub` is the path after it. `account` is the signed-in Web account
 * or null (a texted link works on its own: the token is the key, it lasts 30 minutes, one run).
 */
export async function connectRequest({ sub = "", method = "GET", account = null, readBody, log = () => {} }) {
  if (sub === "island.js") {
    const body = island();
    return { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": body.length, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }, body };
  }
  if (sub === "jwks.json") {
    let keys;
    try { keys = shop.jwks(); } catch { return json(404, { error: "not configured" }); }
    const out = json(200, keys);
    return { ...out, headers: { ...out.headers, "Cache-Control": "public, max-age=300" } };
  }
  if (sub === "new-card") {
    if (!account || !shop.connectAllowedFor(account.conversation_id)) return null;
    const token = shop.cardLink(account.conversation_id);
    return { status: 303, headers: HTML({ Location: `/web/connect/${token}`, "Content-Length": 0 }), body: "" };
  }
  const [token, verb = ""] = String(sub).split("/");
  const link = shop.linkFor(token);
  if (!link || !shop.connectAllowedFor(link.conversation_id)) return send(renderEnded({ view: { state: "expired" } }));
  const view = shop.linkView(link);
  if (verb === "state") return json(200, { state: view.state });
  if (verb === "answer" || verb === "card") {
    if (method !== "POST") return json(405, { ok: false });
    let body = {};
    try { body = JSON.parse((await readBody()) || "{}"); } catch { return json(400, { ok: false, error: "bad_json" }); }
    // Only which link and which field keys: never a value (src/shopconnect.js says why).
    const out = verb === "answer" ? await shop.answerLink(token, body) : await shop.saveCard(token, body);
    log({ shop_connect: verb, ok: !!out.ok, ...(out.error ? { error: out.error } : {}), ...(verb === "answer" && body?.answers && typeof body.answers === "object" ? { keys: Object.keys(body.answers) } : {}) });
    return json(out.ok ? 200 : 400, out);
  }
  if (verb) return null;
  const card = view.kind === "card" && view.state === "connected" ? shop.cardOf(link.conversation_id) : null;
  const live = ["signin", "code", "retry", "card"].includes(view.state);
  const boot = live || view.state === "checking"
    ? {
      token, state: view.state, watch: view.state !== "card",
      ...(live ? { apiKey: process.env.CROSSMINT_CLIENT_KEY || "", jwt: shop.mintJwt(link.conversation_id), fields: (view.request?.fields ?? []).filter((f) => f.handling === "protected") } : {}),
    } : null;
  const drawn = renderView(view, { card });
  return send(boot ? { ...drawn, html: withBoot(drawn.html, boot) } : drawn);
}
/** The screen is drawn once; a live page's boot data and script ride in their own tag at the end. */
export const withBoot = (html, boot) => html.replace("</body></html>", `<script>${JS(boot)}</script></body></html>`);
