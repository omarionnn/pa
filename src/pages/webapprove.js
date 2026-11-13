// Approve a purchase with Face ID, and set Face ID up for purchases (src/passkey.js).
//
//   GET  /web/approve/{token}             the payment: store, item, exact total, Approve with Face ID, Decline
//   POST /web/approve/{token}/verify      the passkey assertion → verified, link claimed, then paid
//   POST /web/approve/{token}/decline     no: Crossmint is told to decline, nothing is charged
//   POST /web/approve/{token}/cvc         after Face ID, Crossmint's CVC field said complete: read the intent again, then pay
//
// The CVC step (2026-11-08): Crossmint keeps a saved card's security code only for a while. When it has
// lapsed, the order intent's card rail reads pending_cvc_recollection and the checkout can't fill the
// card, so /verify answers needs_cvc with what Crossmint's own field needs (the client key, the person's
// ten-minute JWT, the card's id) and the page mounts that field (CrossmintCvcRecollection, from
// /web/connect/island.js) right there. The code is typed into Crossmint's iframe and stored by Crossmint;
// it never reaches this page's script, our server, or a log. Then /cvc finishes the payment.
//   GET  /web/connect/passkey             signed in to Web: set up Face ID for purchases
//   POST /web/connect/passkey/verify      the new passkey (saved only if it verifies with Face ID or PIN)
//
// The WebAuthn options are drawn into the page, not fetched on the tap: Safari wants the passkey call
// inside the tap itself, and a fetch in between can cost it. The approval's options carry the link's
// bound challenge (src/passkey.js says what it binds); the page sends back only the assertion.
// Paper look, from the Connect pages (src/pages/webconnect.js, paperkit.js). Copy says what happens,
// never words to type.
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { securedCardTags } from "./securedcard.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, note, go, two, actions, paper, steps, live, STEP_JS, LIVE_JS } from "./paperkit.js";
import { SECURITY_HEADERS, sameOrigin } from "./websignin.js";
import * as shop from "../shopconnect.js";
import * as passkey from "../passkey.js";
import { backToMessages, BACK_JS, BACK_CSS } from "./backlink.js";

const CSS = `${PAPER_CSS}${BACK_CSS}
.pk-item{margin:10px 0 0;font-size:17px;line-height:1.45;color:var(--ink)}
.pk-note{margin-top:22px}
.pk-go .pf-go{font-size:28px}
.pk-no{min-height:52px;padding:8px 22px;border:1.5px solid var(--ink);border-radius:999px;font-size:24px;color:var(--ink)}
.pk-no:hover{border-color:var(--hov)}
.pk-go+.pf-l{margin-top:22px}
.pk-face{display:inline-block;width:22px;height:22px;margin-right:10px;vertical-align:-3px}
.pk-bd{width:100%;margin:14px 0 0;border-collapse:collapse;font-size:16px;color:var(--ink)}
.pk-bd th{text-align:left;font-weight:400;padding:5px 0}
.pk-bd td{text-align:right;padding:5px 0;font-variant-numeric:tabular-nums}
.pk-bd .pk-sum th,.pk-bd .pk-sum td{border-top:1px solid var(--ink);font-weight:600;padding-top:8px}
.pk-bd-note{margin:8px 0 0;font-size:14px;opacity:.75}
.pk-cvc{margin:18px 0 0;min-height:64px;max-width:320px}
`;
const BACK = "/web?thread";
const FACE = `<svg class="pk-face" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M9 9v1.5M15 9v1.5M12 9v4h-1M9 16.5c1.8 1.4 4.2 1.4 6 0"/></svg>`;
// Saying no is as plain as saying yes: a full-size, full-ink button, not small grey caps.
const NO = (text) => `<button class="act pk-no" type="button" id="pk-no" data-busy="1">${esc(text)}</button>`;
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
/** After Face ID: the payment on its way, as the wait grows (never a dead page, owner 2026-10-31). */
export const payingLines = (store, amount) => [
  [0, `Paying ${amount} at ${store}.`],
  [8, `${store} is taking the payment.`],
  [30, "Still paying. Stores can take a minute."],
  [75, "Taking longer than usual. Still on it, and I never pay twice."],
  [180, `${store} hasn't answered yet. If this page closes, I'll text you what happened.`],
];

function page(title, body, { staging = false, status = 200, boot = null, card = null } = {}) {
  const script = `${STEP_JS}${LIVE_JS}${BACK_JS}${boot ? JS(boot) : ""}`;
  // The link card a phone draws for the texted link (src/pages/securedcard.js): the action only.
  const head = card ? securedCardTags(card) : "";
  return { status, html: webPage({ title, body: body + (staging ? `<p class="stg">STAGING · SAMPLE</p>` : ""), css: CSS, script, head }) };
}
/** Which "Secured by Reason" card a payment link shows: a limit change or a purchase. */
const cardOf = (v) => (v?.kind === "cap" ? "limit" : "approve");
const shell = (main) => `${header()}<main class="pf" id="pk-main">${main}</main>`;
const LABELS = { item: "Item", shipping: "Shipping", tax: "Tax", fees: "Fees", discount: "Discount" };
/**
 * What the total is made of (2026-11-07: the page showed one number and no breakdown): item, shipping,
 * tax, then the total, from the store's own figures. When the store gave one number, that is said
 * plainly instead of inventing parts.
 */
export function breakdownRows(v) {
  if (v.kind === "cap") return "";
  const parts = Array.isArray(v.breakdown) ? v.breakdown : [];
  const row = (l, n, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><th scope="row">${esc(l)}</th><td>${esc(n)}</td></tr>`;
  if (!parts.length) {
    return `<table class="pk-bd" aria-label="What the total covers">${row("Item, shipping and tax", "all in the total")}${row("Total", v.amount, "pk-sum")}</table>`
      + `<p class="pk-bd-note">${esc(v.store)} gave one number, with shipping and tax in it.</p>`;
  }
  const has = new Set(parts.map(([l]) => l));
  const rows = parts.map(([l, n]) => row(LABELS[l] ?? l, l === "discount" ? `−${n}` : n));
  if (!has.has("shipping")) rows.splice(1, 0, row("Shipping", "none listed"));
  if (!has.has("tax")) rows.push(row("Tax", "none listed"));
  return `<table class="pk-bd" aria-label="What the total covers">${rows.join("")}${row("Total", v.amount, "pk-sum")}</table>`;
}
const theTotal = (v) => paper({ stamp: v.stampText || "", label: v.store.toUpperCase(), big: v.amount, extra: (v.item ? `<p class="pk-item">${esc(v.item)}</p>` : "") + breakdownRows(v) });

// ---------------------------------------------------------------- the approval
const WHAT_IT_COVERS = (v) => label("FACE ID APPROVES") + para(v.kind === "cap"
  ? `This one change: your daily limit to <b>${esc(v.to)}</b>. Not a payment, not another number.`
  : `This one payment: <b>${esc(v.amount)}</b> at ${esc(v.store)}. Not another amount, not another store.`)
  + label("THE LINK", { sp: true }) + para(v.kind === "cap" ? "Works once, and runs out in thirty minutes." : "Works once, and runs out in thirty minutes. I text you once before it does.")
  + label("I NEVER SEE", { pen: true, sp: true }) + para("Your face or fingerprint. It stays on your phone.");

/**
 * A raise of the daily spending limit (src/spendcap.js, kind 'cap'): the same page shape as a payment,
 * with the new number where the total goes and the old one under it. Nothing is paid here; the step
 * names stay the ones the script moves between (paying → paid, declined, failed).
 */
function renderApproveCap({ v, staging = false, boot = null, blocked = "" }) {
  const left = Math.max(0, v.expiresAt - Date.now());
  const theNumber = paper({ label: "DAILY LIMIT", big: v.to, extra: `<p class="pk-item">From ${esc(v.from)} a day</p>` });
  if (blocked) {
    const cooling = blocked === "cooling_off";
    const main = headline(cooling ? "Your new Face ID isn't ready yet." : "Face ID isn't set up here.", "Your limit hasn't changed.", "pk-h")
      + lede(cooling ? "A Face ID added after the first one waits a day before it can approve anything, so nobody can add one and raise your limit before you hear." : "Set up Face ID in Settings, then ask me again.")
      + theNumber + `<div class="pk-note">${actions(NO("Leave it"), go("Settings", { href: "/web/settings#shopping" }))}</div>`;
    return page("Reason — approve", shell(frame({ main, margin: WHAT_IT_COVERS(v) })), { staging, boot, card: cardOf(v) });
  }
  const ask = frame({
    step: "ask",
    main: headline(`Raise your daily limit to ${v.to}?`, "Approve it with Face ID.", "pk-h")
      + lede(`The most I'll spend for you in a day, across every store. It's ${v.from} now.`)
      + theNumber
      + `<div class="pk-note pk-go">${actions(`<button class="act pf-go" type="button" id="pk-go" data-busy="1">${FACE}Approve with Face ID <span aria-hidden="true">→</span></button>`, NO("Leave it"))}</div>`
      + label(`RUNS OUT IN ${minutes(left)} MIN · NOTHING CHANGED YET`)
      + `<p class="pf-note" id="pk-err" role="alert" hidden></p>`,
    margin: WHAT_IT_COVERS(v),
  });
  const paying = frame({ step: "paying", off: true, main: headline("Approved.", "Saving it now.") + lede("One moment."), margin: label("CHANGING") + para(`Your daily limit, to ${esc(v.to)}.`) });
  const paid = frame({
    step: "paid", off: true,
    main: headline(`Done. ${v.to} a day.`, "Your new daily limit.") + lede(`It was ${v.from}. You can change it again any time in Settings, or by telling me.`)
      + paper({ stamp: "APPROVED", label: "DAILY LIMIT", big: v.to })
      + `<div class="pk-note">${actions(go("Back to Settings", { href: "/web/settings#shopping" }))}</div>`,
    margin: label("APPROVED WITH") + para("Face ID, on this device.") + label("THIS LINK", { sp: true }) + para("Is used up."),
  });
  const declined = frame({
    step: "declined", off: true,
    main: headline("Left as it was.", `${v.from} a day.`) + lede("Nothing changed. Tell me if you want a different number.")
      + `<div class="pk-note">${actions(go("Back to Settings", { href: "/web/settings#shopping" }))}</div>`,
    margin: label("THIS LINK") + para("Is closed."),
  });
  const failed = frame({
    step: "failed", off: true,
    main: headline("Face ID worked. The change didn't save.", "Your limit hasn't changed.") + lede("That's on my side, not yours. Try again here, or text me the number.")
      + theNumber + `<div class="pk-note">${actions(`<button class="act pf-go" type="button" id="pk-retry" data-busy="1">Try again <span aria-hidden="true">→</span></button>`, go("Back to Settings", { href: "/web/settings#shopping" }))}</div>`,
    margin: label("THIS LINK") + para("Still works, once, until it runs out."),
  });
  return page("Reason — approve", shell(ask + paying + paid + declined + failed), { staging, boot, card: cardOf(v) });
}

/** The open payment and every screen its script moves to. `blocked` is cooling_off / no_passkey. */
export function renderApprove({ v, staging = false, boot = null, blocked = "" }) {
  if (v.kind === "cap") return renderApproveCap({ v, staging, boot, blocked });
  const left = Math.max(0, v.expiresAt - Date.now());
  if (blocked) {
    const cooling = blocked === "cooling_off";
    const main = headline(cooling ? "Your new Face ID isn't ready yet." : "Face ID isn't set up here.", "Nothing was charged.", "pk-h")
      + lede(cooling ? "A Face ID added after the first one waits a day before it can pay, so nobody can add one and pay with it before you hear. Use the phone you set it up on, or decline." : "Set up Face ID in Settings, then ask me for a fresh link.")
      + theTotal(v) + `<div class="pk-note">${actions(NO("Decline it"), go("Settings", { href: "/web/settings#shopping" }))}</div>`;
    return page("Reason — approve", shell(frame({ main, margin: WHAT_IT_COVERS(v) })), { staging, boot, card: cardOf(v) });
  }
  const ask = frame({
    step: "ask",
    main: headline(`Pay ${v.amount} at ${v.store}?`, "Approve it with Face ID.", "pk-h")
      + lede(v.breakdown?.length ? "The store's own figures, from its checkout. The total is exactly what's paid." : "This is the exact total, with tax and shipping, from the store's checkout.")
      + theTotal(v)
      + `<div class="pk-note pk-go">${actions(`<button class="act pf-go" type="button" id="pk-go" data-busy="1">${FACE}Approve with Face ID <span aria-hidden="true">→</span></button>`, NO("Decline"))}</div>`
      + label(`RUNS OUT IN ${minutes(left)} MIN · NOTHING CHARGED YET`)
      + `<p class="pf-note" id="pk-err" role="alert" hidden></p>`,
    margin: WHAT_IT_COVERS(v),
  });
  const paying = frame({
    step: "paying", off: true,
    main: headline("Approved.", "Paying the store now.") + lede("Keep this open until it's through. However it goes, I'll text you too.")
      + steps([["Face ID checked", "done"], [`Paying ${v.amount}`, "now"], ["Store places the order", "todo"]], { id: "pk-steps", live: true })
      + live({ id: "pk-live", lines: payingLines(v.store, v.amount) }),
    margin: label("SO FAR") + para(`Only ${esc(v.amount)}, only at ${esc(v.store)}.`),
  });
  const paid = frame({
    step: "paid", off: true,
    main: headline(`Paid ${v.amount}.`, "Back to the chat.") + lede(`${v.store} still has to place the order. I'll text you when it's through.`)
      + paper({ stamp: "APPROVED", label: v.store.toUpperCase(), big: v.amount, extra: v.item ? `<p class="pk-item">${esc(v.item)}</p>` : "" })
      + backToMessages(v.a?.conversation_id),
    margin: label("APPROVED WITH") + para("Face ID, on this device.") + label("THIS LINK", { sp: true }) + para("Is used up. It can't pay again."),
  });
  const declined = frame({
    step: "declined", off: true,
    main: headline("Declined.", "Nothing was charged.") + lede(`I told ${v.store} no. Text me if you want something else.`)
      + backToMessages(v.a?.conversation_id),
    margin: label("THIS LINK") + para("Is closed. It can't pay."),
  });
  const unsure = frame({
    step: "unsure", off: true,
    main: headline("I couldn't tell if it went through.", "I won't pay twice.") + lede(`The store didn't answer in time. I'll check with ${v.store} and text you what happened.`)
      + backToMessages(v.a?.conversation_id),
    margin: label("NOT RETRIED") + para("A payment that might have gone through is never paid again by itself."),
  });
  // Face ID passed and nothing was charged, but the payment did not start on Reason's side (Crossmint
  // refused the order intent — 2026-10-31 at CVS). The link is open again (src/passkey.js reopenApproval);
  // Try again reloads for the fresh challenge. Never "Face ID didn't go through": it did.
  // Face ID passed; the card's 3-digit code has to be typed again before the store can take the card.
  const cvc = frame({
    step: "cvc", off: true,
    main: headline("Face ID worked.", "Enter your card's 3-digit code to finish.", "pk-h")
      + lede(`Your card needs its security code once more before ${v.store} can take it. It's the 3 digits on the back of the card.`)
      + `<div class="pk-cvc" id="pk-cvc" aria-label="Card security code"></div>`
      + `<div class="pk-note pk-go">${actions(`<button class="act pf-go" type="button" id="pk-cvc-go" data-busy="1">Finish paying ${esc(v.amount)} <span aria-hidden="true">→</span></button>`)}</div>`
      + label("NOTHING CHARGED YET")
      + `<p class="pf-note" id="pk-cvc-err" role="alert" hidden></p>`,
    margin: label("WHY AGAIN") + para("A saved card's code is only kept for a while. Type it once and this payment goes through.")
      + label("I NEVER SEE", { pen: true, sp: true }) + para("The code. You type it into the secure box of the service that holds your card, not into Reason."),
  });
  const failed = frame({
    step: "failed", off: true,
    main: headline("Face ID worked. The payment didn't start.", "Nothing was charged.") + lede(`Setting up the ${v.amount} payment to ${v.store} failed on my side, not yours. Try again here, or text me and I'll sort it out.`)
      + theTotal(v) + `<div class="pk-note">${actions(`<button class="act pf-go" type="button" id="pk-retry" data-busy="1">Try again <span aria-hidden="true">→</span></button>`, go("Back to Reason", { href: BACK }))}</div>`,
    margin: label("THIS LINK") + para("Still works, once, until it runs out.") + label("NOT CHARGED", { sp: true }) + para("The store never got a payment to take."),
  });
  return page("Reason — approve", shell(ask + cvc + paying + paid + declined + unsure + failed), { staging, boot, card: cardOf(v) });
}

/** A link that can't pay anymore: used, declined, run out, replaced by a newer one, or the payment closed. */
export function renderApproveEnded({ v = null, state = "expired", staging = false }) {
  const cap = v?.kind === "cap";
  const none = cap ? "Your limit hasn't changed." : "Nothing was charged.";
  const was = { used: ["Already approved.", cap ? "This link is used up." : "This link can't pay again."], declined: [cap ? "Left as it was." : "Declined.", none], renewed: ["The store let go of the cart.", none] }[state]
    ?? ["This link has run out.", none];
  const main = headline(was[0], was[1], "pk-h")
    + lede(state === "used" ? (cap ? "Each link works once. Settings shows your limit as it is now." : "Each approval link pays once. Check the chat for how it went.")
      : state === "declined" ? (cap ? "Tell me if you want a different number." : "Text me if you want something else.")
      : state === "renewed" ? "Stores hold a payment for ten minutes. I asked again for the same thing, and a fresh link comes by text with the total."
      : `Approval links last thirty minutes and work once. If you still want it, ${cap ? "set the number again in Settings or tell me" : "tell me and I'll send a fresh one"}.`)
    + (v ? (cap ? paper({ label: "DAILY LIMIT", big: v.to, extra: `<p class="pk-item">From ${esc(v.from)} a day</p>` }) : theTotal(v)) : "") + (cap || !v ? `<div class="pk-note">${actions(go(cap ? "Back to Settings" : "Back to Reason", { href: cap ? "/web/settings#shopping" : BACK }))}</div>` : backToMessages(v.a?.conversation_id));
  const margin = label("WHY") + para("A link that runs out can't be used by anyone who sees it later.");
  return page("Reason — approve", shell(frame({ main, margin })), { staging, status: state === "used" || state === "declined" ? 200 : 410, card: cardOf(v) });
}

// ---------------------------------------------------------------- setting it up
export function renderSetup({ signedIn = true, has = [], staging = false, boot = null }) {
  if (!signedIn) {
    const main = headline("Sign in to Reason first.", "Then set up Face ID.", "pk-h")
      + lede("Face ID for purchases is set up from your own Reason, signed in. Sign in, then open Settings → Shopping.")
      + `<div class="pk-note">${actions(go("Sign in", { href: "/web" }))}</div>`;
    return page("Reason — Face ID", shell(frame({ main, margin: label("WHY") + para("So only you can add a way to approve your payments.") })), { staging, status: 401 });
  }
  const again = has.length > 0;
  const add = frame({
    step: "add",
    main: headline(again ? "Add Face ID on this device." : "Approve purchases with Face ID.", again ? "It works from tomorrow." : "A yes alone won't pay anymore.", "pk-h")
      + lede(again ? "You already have Face ID set up. One added now waits a day before it can pay, and I'll text you that it was added."
        : "When I'm about to pay a store, I'll text you a link with the exact total. It pays only after Face ID on your phone.")
      + `<div class="pk-note pk-go">${actions(`<button class="act pf-go" type="button" id="pk-add" data-busy="1">${FACE}Set up Face ID <span aria-hidden="true">→</span></button>`, two("NOT NOW", { href: "/web/settings#shopping" }))}</div>`
      + `<p class="pf-note" id="pk-err" role="alert" hidden></p>`,
    margin: label("WHAT CHANGES") + para("Every purchase needs Face ID, Touch ID or your device passcode.")
      + label("I NEVER SEE", { pen: true, sp: true }) + para("Your face or fingerprint. It stays on your device.")
      + label("LOST YOUR PHONE?", { sp: true }) + para("Sign in here on the new one and set it up again. A new one waits a day, and I tell you."),
  });
  const done = frame({
    step: "done", off: true,
    main: headline("Face ID is set up.", again ? "It can pay from tomorrow." : "Back to the chat.")
      + lede("Next time I'm about to pay, I'll text you a link. Approve there, and only that exact total is paid.")
      + paper({ stamp: "SET UP", label: "PURCHASES", big: "Face ID.", mono: false })
      + `<div class="pk-note">${actions(go("Back to Reason", { href: BACK }), two("SEE IT IN SETTINGS", { href: "/web/settings#shopping" }))}</div>`,
    margin: label("A YES IN THE CHAT") + para("Won't pay anymore. Only the link does."),
  });
  return page("Reason — Face ID", shell(add + done), { staging, boot });
}

// ---------------------------------------------------------------- the script
// b2u/u2b: base64url ⇄ bytes (the JSON form SimpleWebAuthn reads). No library: it's twelve lines.
const JS = (boot) => `(function(){var B=${JSON.stringify(boot).replace(/</g, "\\u003c")};
function b2u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer}
function u2b(x){var u=new Uint8Array(x),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function el(id){return document.getElementById(id)}
function oops(t){var e=el('pk-err');if(e){e.textContent=t;e.hidden=false}}
function busy(b,on){if(!b)return;b.setAttribute('aria-busy',on?'true':'false');b.disabled=on}
var liv=null;function show(n){if(window.pfShow)window.pfShow(n);var lv=el('pk-live');if(n==='paying'&&lv&&window.pfLive&&!liv)liv=pfLive(lv,{});else if(n!=='paying'&&liv){liv.stop();liv=null}}
function post(p,body){return fetch(B.base+p,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return{ok:false,error:'http_'+r.status}})})}
function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}
var FAIL="Face ID didn't go through. Nothing was charged. Try again.";
var WHY={counter:"This passkey's record doesn't match. Nothing was charged. Ask me for a fresh link, or use the phone you set Face ID up on.",unknown_passkey:"That passkey isn't the one set up for your purchases. Nothing was charged.",cooling_off:"This Face ID was added less than a day ago and can't pay yet. Nothing was charged.",no_user_verification:"Face ID didn't check you. Nothing was charged. Try again.",details_changed:"The payment changed since this link was sent. Nothing was charged. Ask me for a fresh link.",no_such_payment:"This payment isn't open anymore. Nothing was charged.",over_daily_cap:"This is past your daily spending limit. Nothing was charged. You can raise it in Settings → Shopping, or text me a new limit.",change_expired:"This question ran out. Your limit hasn't changed. Set the number again in Settings or tell me.",change_applied:"Already done. Your limit is set.",change_declined:"You left it as it was. Nothing changed.",no_such_change:"This change isn't open anymore. Nothing changed.",bad_amount:"The payment's amount could not be read. Nothing was charged. Ask me for a fresh link."};
var OFFLINE="Couldn't reach Reason. Nothing was charged. Check your connection and try again.";
var go=el('pk-go'),no=el('pk-no'),add=el('pk-add'),retry=el('pk-retry');
if(retry)retry.onclick=function(){busy(retry,true);location.reload()};
if(go)go.onclick=function(){
  if(B.staging){busy(go,true);show('paying');wait(1400).then(function(){show('paid')});return}
  if(!window.PublicKeyCredential||!navigator.credentials){oops('This browser can\\'t use Face ID. Open the link in Safari or Chrome.');return}
  var o=B.options;busy(go,true);el('pk-err').hidden=true;
  navigator.credentials.get({publicKey:{challenge:b2u(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:(o.allowCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;show('paying');return post('/verify',{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),authenticatorData:u2b(r.authenticatorData),signature:u2b(r.signature),userHandle:r.userHandle?u2b(r.userHandle):undefined},clientExtensionResults:{},authenticatorAttachment:c.authenticatorAttachment||undefined})})
  .then(done,function(err){show('ask');busy(go,false);oops(err&&err.name==='TypeError'?OFFLINE:FAIL)})};
function done(out){if(!out)return;if(out.ok)return show('paid');if(out.unknown_outcome)return show('unsure');var e=out.error||'';
  if(out.needs_cvc){if(out.cvc)return cvcStep(out.cvc);show('cvc');busy(cgo,false);return cvcOops("Your card company hasn't confirmed the code yet. Tap Finish again in a moment.")}
  if(out.retry)return show('failed');
  if(/^link_|^payment_|^not_found$|^not_open$|^cvc_window_closed$/.test(e))return location.reload();
  show('ask');busy(go,false);oops(WHY[e]||(/^http_/.test(e)?"Reason had a problem. Nothing was charged. Try again.":FAIL))}
// The CVC: Crossmint's hosted field (island.js), mounted only once Face ID passed. Its submit() hands back
// a status and never the code; only after "complete" does the page ask Reason to finish the payment.
var cgo=el('pk-cvc-go'),cvcF=null;
function cvcOops(t){var e=el('pk-cvc-err');if(e){e.textContent=t;e.hidden=false}}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
function cvcLook(){var g=css('--ground'),i=css('--ink'),m=css('--muted'),p=css('--pen'),M='"Courier New",Courier,monospace';
  return{variables:{fontFamily:M,fontSizeUnit:'5px',borderRadius:'0px',colors:{backgroundPrimary:g,textPrimary:i,textSecondary:m,borderPrimary:css('--hair'),accent:p,danger:p,warning:p}},
  rules:{Label:{font:{family:M,size:'11px',weight:'400'},colors:{text:m}},Input:{borderRadius:'0px',font:{family:M,size:'22px',weight:'400'},colors:{text:i,background:g,border:g,boxShadow:'inset 0 -1.5px 0 '+i,placeholder:m},focus:{colors:{background:g,border:g,boxShadow:'inset 0 -2px 0 '+p}}}}}}
function cvcStep(c){show('cvc');busy(cgo,false);el('pk-cvc-err').hidden=true;if(cvcF)return;
  function mount(){try{cvcF=window.ReasonCrossmint.cvcField(el('pk-cvc'),{apiKey:c.apiKey,jwt:c.jwt,paymentMethodId:c.paymentMethodId,appearance:cvcLook()})}catch(x){cvcOops("The code box didn't load. Nothing was charged. Reload this page to try again.")}}
  if(window.ReasonCrossmint)return mount();
  var s=document.createElement('script');s.src='/web/connect/island.js';s.onload=mount;s.onerror=function(){cvcOops("The code box didn't load. Nothing was charged. Check your connection and reload.")};document.head.appendChild(s)}
var CVCWHY={invalid:"Check the code: it's the 3 digits on the back of your card.",failed:"That code didn't go through. Nothing was charged. Try again.",refused:"Your card company didn't take the code. Nothing was charged. Text me and I'll sort it out.",unavailable:"The code box is still loading. Try again in a moment."};
if(cgo)cgo.onclick=function(){
  if(B.staging){busy(cgo,true);show('paying');wait(1400).then(function(){show('paid')});return}
  if(!cvcF)return cvcOops(CVCWHY.unavailable);
  busy(cgo,true);el('pk-cvc-err').hidden=true;
  cvcF.submit().then(function(r){var st=r&&r.status;
    if(st==='complete'){show('paying');return post('/cvc').then(done,function(){show('cvc');busy(cgo,false);cvcOops(OFFLINE)})}
    if(st==='superseded')return busy(cgo,false);
    busy(cgo,false);cvcOops(CVCWHY[st]||CVCWHY.failed)})};
if(no)no.onclick=function(){busy(no,true);if(B.staging){show('declined');return}post('/decline').then(function(out){if(out.ok)show('declined');else location.reload()})};
if(add)add.onclick=function(){
  if(B.staging){busy(add,true);wait(900).then(function(){show('done')});return}
  if(!window.PublicKeyCredential||!navigator.credentials){oops('This browser can\\'t set up Face ID. Open it in Safari or Chrome.');return}
  var o=B.options;busy(add,true);el('pk-err').hidden=true;
  navigator.credentials.create({publicKey:{rp:o.rp,user:{id:b2u(o.user.id),name:o.user.name,displayName:o.user.displayName},challenge:b2u(o.challenge),pubKeyCredParams:o.pubKeyCredParams,timeout:o.timeout,attestation:'none',authenticatorSelection:o.authenticatorSelection,hints:o.hints,excludeCredentials:(o.excludeCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;return post('/verify',{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),attestationObject:u2b(r.attestationObject),transports:r.getTransports?r.getTransports():[]},clientExtensionResults:{},authenticatorAttachment:c.authenticatorAttachment||undefined})})
  .then(function(out){if(out&&out.ok)return show('done');if(out&&out.error==='expired')return location.reload();busy(add,false);oops("That didn't save. Try again.")},
    function(){busy(add,false);oops("Face ID wasn't set up. Try again when you're ready.")})};
})();`;

// ---------------------------------------------------------------- routes
// Only this site, and Crossmint for the CVC step: our own island script, Crossmint's iframe (the code
// field) and its SDK's calls. Nothing else is framed or called, the page is framed by nobody, nothing cached.
const CROSSMINT = "https://www.crossmint.com https://*.crossmint.com";
export const APPROVE_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${CROSSMINT}; frame-src ${CROSSMINT}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const send = ({ status, html }) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...APPROVE_HEADERS, "Content-Length": Buffer.byteLength(html) }, body: html });
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...APPROVE_HEADERS, "Content-Length": Buffer.byteLength(body) }, body }; };
const BODY_MAX = 16_000;
async function bodyOf(readBody) {
  const raw = (await readBody()) || "{}";
  if (raw.length > BODY_MAX) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Everything under /web/approve. `sub` is the path after it. */
export async function approveRequest({ sub = "", method = "GET", headers = {}, readBody, log = () => {} }) {
  const [token, verb = ""] = String(sub).split("/");
  const v = shop.approvalView(token);
  // A token we never made, or one for an account the flag leaves out: the plain 404, like any other unknown path.
  if (!v) return null;
  if (!verb) {
    if (method !== "GET" && method !== "HEAD") return json(405, { ok: false });
    if (v.state !== "open") return send(renderApproveEnded({ v, state: v.state }));
    const opts = await passkey.approvalOptions(v.a);
    if (!opts.ok) return send(renderApprove({ v, blocked: opts.error, boot: { base: `/web/approve/${token}` } }));
    return send(renderApprove({ v, boot: { base: `/web/approve/${token}`, options: opts.options } }));
  }
  if (verb !== "verify" && verb !== "decline" && verb !== "cvc") return null;
  if (method !== "POST") return json(405, { ok: false });
  if (!sameOrigin(headers)) return json(403, { ok: false, error: "origin" });
  if (verb === "decline") {
    const out = await shop.declineByLink(token);
    log({ pay_approve: "decline", ok: !!out.ok });
    return json(out.ok ? 200 : 400, { ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  }
  if (verb === "cvc") {
    const out = await shop.payAfterCvc(token);
    log({ pay_approve: "cvc", ok: !!out.ok, ...(out.error ? { error: out.error } : {}), ...(out.status ? { status: out.status } : {}), ...(out.retry ? { retry: true } : {}) });
    return json(out.ok ? 200 : 400, answerOf(out));
  }
  const body = await bodyOf(readBody);
  if (!body) return json(400, { ok: false, error: "bad_json" });
  const out = await shop.payByPasskey(token, body);
  // Which link and how it went: never the assertion, never a card detail.
  log({ pay_approve: "verify", ok: !!out.ok, ...(out.error ? { error: out.error } : {}), ...(out.status ? { status: out.status } : {}), ...(out.detail ? { detail: out.detail } : {}), ...(out.retry ? { retry: true } : {}) });
  return json(out.ok ? 200 : 400, answerOf(out));
}
/** What the page is told: the outcome, and for the CVC step only what Crossmint's field needs. Never logged. */
const answerOf = (out) => ({
  ok: !!out.ok, ...(out.error ? { error: out.error } : {}), ...(out.unknown_outcome ? { unknown_outcome: true } : {}), ...(out.retry ? { retry: true } : {}),
  ...(out.needs_cvc ? { needs_cvc: true } : {}),
  ...(out.cvc ? { cvc: { apiKey: out.cvc.apiKey, jwt: out.cvc.jwt, paymentMethodId: out.cvc.paymentMethodId } } : {}),
});

/** /web/connect/passkey[/verify]: signed in to Web, and only where the flag allows. */
export async function passkeySetupRequest({ verb = "", method = "GET", headers = {}, account = null, readBody, log = () => {} }) {
  const c = account?.conversation_id;
  // Signed out, or not an account the flag allows: the plain 404, so the page doesn't say it exists.
  if (!account || !(shop.connectAllowedFor(c) && passkey.passkeyAllowedFor(c))) return null;
  if (!verb) {
    const opts = await passkey.registrationOptions(c);
    if (!opts.ok) return null;
    return send(renderSetup({ has: passkey.passkeysOf(c), boot: { base: "/web/connect/passkey", options: opts.options } }));
  }
  if (verb !== "verify") return null;
  if (method !== "POST") return json(405, { ok: false });
  if (!sameOrigin(headers)) return json(403, { ok: false, error: "origin" });
  const body = await bodyOf(readBody);
  if (!body) return json(400, { ok: false, error: "bad_json" });
  const out = await passkey.register(c, body);
  log({ pay_passkey: "register", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  return json(out.ok ? 200 : 400, out);
}
