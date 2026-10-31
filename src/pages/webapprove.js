// Approve a purchase with Face ID, and set Face ID up for purchases (src/passkey.js).
//
//   GET  /web/approve/{token}             the payment: store, item, exact total, Approve with Face ID, Decline
//   POST /web/approve/{token}/verify      the passkey assertion → verified, link claimed, then paid
//   POST /web/approve/{token}/decline     no: Crossmint is told to decline, nothing is charged
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
import { PAPER_CSS, header, frame, headline, lede, label, para, note, go, two, actions, paper, steps, STEP_JS } from "./paperkit.js";
import { SECURITY_HEADERS, sameOrigin } from "./websignin.js";
import * as shop from "../shopconnect.js";
import * as passkey from "../passkey.js";

const CSS = `${PAPER_CSS}
.pk-item{margin:10px 0 0;font-size:17px;line-height:1.45;color:var(--ink)}
.pk-note{margin-top:22px}
.pk-go .pf-go{font-size:28px}
.pk-face{display:inline-block;width:22px;height:22px;margin-right:10px;vertical-align:-3px}
`;
const BACK = "/web?thread";
const FACE = `<svg class="pk-face" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M9 9v1.5M15 9v1.5M12 9v4h-1M9 16.5c1.8 1.4 4.2 1.4 6 0"/></svg>`;
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

function page(title, body, { staging = false, status = 200, boot = null } = {}) {
  const script = `${STEP_JS}${boot ? JS(boot) : ""}`;
  return { status, html: webPage({ title, body: body + (staging ? `<p class="stg">STAGING · SAMPLE</p>` : ""), css: CSS, script }) };
}
const shell = (main) => `${header()}<main class="pf" id="pk-main">${main}</main>`;
const theTotal = (v) => paper({ stamp: v.stampText || "", label: v.store.toUpperCase(), big: v.amount, extra: v.item ? `<p class="pk-item">${esc(v.item)}</p>` : "" });

// ---------------------------------------------------------------- the approval
const WHAT_IT_COVERS = (v) => label("FACE ID APPROVES") + para(`This one payment: <b>${esc(v.amount)}</b> at ${esc(v.store)}. Not another amount, not another store.`)
  + label("THE LINK", { sp: true }) + para("Works once, and runs out in five minutes.")
  + label("I NEVER SEE", { pen: true, sp: true }) + para("Your face or fingerprint. It stays on your phone.");

/** The open payment and every screen its script moves to. `blocked` is cooling_off / no_passkey. */
export function renderApprove({ v, staging = false, boot = null, blocked = "" }) {
  const left = Math.max(0, v.expiresAt - Date.now());
  if (blocked) {
    const cooling = blocked === "cooling_off";
    const main = headline(cooling ? "Your new Face ID isn't ready yet." : "Face ID isn't set up here.", "Nothing was charged.", "pk-h")
      + lede(cooling ? "A Face ID added after the first one waits a day before it can pay, so nobody can add one and pay with it before you hear. Use the phone you set it up on, or decline." : "Set up Face ID in Settings, then ask me for a fresh link.")
      + theTotal(v) + `<div class="pk-note">${actions(two("DECLINE IT", { attrs: ` id="pk-no"` }), go("Settings", { href: "/web/settings#shopping" }))}</div>`;
    return page("Reason — approve", shell(frame({ main, margin: WHAT_IT_COVERS(v) })), { staging, boot });
  }
  const ask = frame({
    step: "ask",
    main: headline(`Pay ${v.amount} at ${v.store}?`, "Approve it with Face ID.", "pk-h")
      + lede("This is the exact total, with tax and shipping, from the store's checkout.")
      + theTotal(v)
      + `<div class="pk-note pk-go">${actions(`<button class="act pf-go" type="button" id="pk-go" data-busy="1">${FACE}Approve with Face ID <span aria-hidden="true">→</span></button>`, two("DECLINE", { attrs: ` id="pk-no"` }))}</div>`
      + label(`RUNS OUT IN ${minutes(left)} MIN · NOTHING CHARGED YET`)
      + `<p class="pf-note" id="pk-err" role="alert" hidden></p>`,
    margin: WHAT_IT_COVERS(v),
  });
  const paying = frame({
    step: "paying", off: true,
    main: headline("Approved.", "Paying the store now.") + lede("Keep this open for a second.")
      + steps([["Face ID checked", "done"], [`Paying ${v.amount}`, "now"], ["Store places the order", "todo"]], { id: "pk-steps", live: true }),
    margin: label("SO FAR") + para(`Only ${esc(v.amount)}, only at ${esc(v.store)}.`),
  });
  const paid = frame({
    step: "paid", off: true,
    main: headline(`Paid ${v.amount}.`, "Back to the chat.") + lede(`${v.store} still has to place the order. I'll text you when it's through.`)
      + paper({ stamp: "APPROVED", label: v.store.toUpperCase(), big: v.amount, extra: v.item ? `<p class="pk-item">${esc(v.item)}</p>` : "" })
      + `<div class="pk-note">${actions(go("Back to Reason", { href: BACK }))}</div>`,
    margin: label("APPROVED WITH") + para("Face ID, on this device.") + label("THIS LINK", { sp: true }) + para("Is used up. It can't pay again."),
  });
  const declined = frame({
    step: "declined", off: true,
    main: headline("Declined.", "Nothing was charged.") + lede(`I told ${v.store} no. Text me if you want something else.`)
      + `<div class="pk-note">${actions(go("Back to Reason", { href: BACK }))}</div>`,
    margin: label("THIS LINK") + para("Is closed. It can't pay."),
  });
  const unsure = frame({
    step: "unsure", off: true,
    main: headline("I couldn't tell if it went through.", "I won't pay twice.") + lede(`The store didn't answer in time. I'll check with ${v.store} and text you what happened.`)
      + `<div class="pk-note">${actions(go("Back to Reason", { href: BACK }))}</div>`,
    margin: label("NOT RETRIED") + para("A payment that might have gone through is never paid again by itself."),
  });
  return page("Reason — approve", shell(ask + paying + paid + declined + unsure), { staging, boot });
}

/** A link that can't pay anymore: used, declined, run out, replaced by a newer one, or the payment closed. */
export function renderApproveEnded({ v = null, state = "expired", staging = false }) {
  const was = { used: ["Already approved.", "This link can't pay again."], declined: ["Declined.", "Nothing was charged."] }[state]
    ?? ["This link has run out.", "Nothing was charged."];
  const main = headline(was[0], was[1], "pk-h")
    + lede(state === "used" ? "Each approval link pays once. Check the chat for how it went."
      : state === "declined" ? "Text me if you want something else." : "Approval links last five minutes and work once. If you still want it, tell me and I'll send a fresh one.")
    + (v ? theTotal(v) : "") + `<div class="pk-note">${actions(go("Back to Reason", { href: BACK }))}</div>`;
  const margin = label("WHY") + para("A link that runs out can't be used by anyone who sees it later.");
  return page("Reason — approve", shell(frame({ main, margin })), { staging, status: state === "used" || state === "declined" ? 200 : 410 });
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
function show(n){if(window.pfShow)window.pfShow(n)}
function post(p,body){return fetch(B.base+p,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return{ok:false}})})}
function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}
var FAIL="Face ID didn't go through. Nothing was charged. Try again.";
var go=el('pk-go'),no=el('pk-no'),add=el('pk-add');
if(go)go.onclick=function(){
  if(B.staging){busy(go,true);show('paying');wait(1400).then(function(){show('paid')});return}
  if(!window.PublicKeyCredential||!navigator.credentials){oops('This browser can\\'t use Face ID. Open the link in Safari or Chrome.');return}
  var o=B.options;busy(go,true);el('pk-err').hidden=true;
  navigator.credentials.get({publicKey:{challenge:b2u(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:(o.allowCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;show('paying');return post('/verify',{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),authenticatorData:u2b(r.authenticatorData),signature:u2b(r.signature),userHandle:r.userHandle?u2b(r.userHandle):undefined},clientExtensionResults:{},authenticatorAttachment:c.authenticatorAttachment||undefined})})
  .then(function(out){if(!out)return;if(out.ok)return show('paid');if(out.unknown_outcome)return show('unsure');if(/^link_|^payment_/.test(out.error||''))return location.reload();show('ask');busy(go,false);oops(FAIL)},
    function(){show('ask');busy(go,false);oops(FAIL)})};
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
// Only this site: no frames, no third-party scripts or calls, nothing cached.
export const APPROVE_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  if (!verb) {
    if (method !== "GET" && method !== "HEAD") return json(405, { ok: false });
    if (!v) return send(renderApproveEnded({}));
    if (v.state !== "open") return send(renderApproveEnded({ v, state: v.state }));
    const opts = await passkey.approvalOptions(v.a);
    if (!opts.ok) return send(renderApprove({ v, blocked: opts.error, boot: { base: `/web/approve/${token}` } }));
    return send(renderApprove({ v, boot: { base: `/web/approve/${token}`, options: opts.options } }));
  }
  if (verb !== "verify" && verb !== "decline") return null;
  if (method !== "POST") return json(405, { ok: false });
  if (!sameOrigin(headers)) return json(403, { ok: false, error: "origin" });
  if (verb === "decline") {
    const out = await shop.declineByLink(token);
    log({ pay_approve: "decline", ok: !!out.ok });
    return json(out.ok ? 200 : 400, { ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  }
  const body = await bodyOf(readBody);
  if (!body) return json(400, { ok: false, error: "bad_json" });
  const out = await shop.payByPasskey(token, body);
  // Which link and how it went: never the assertion, never a card detail.
  log({ pay_approve: "verify", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  return json(out.ok ? 200 : 400, { ok: !!out.ok, ...(out.error ? { error: out.error } : {}), ...(out.unknown_outcome ? { unknown_outcome: true } : {}) });
}

/** /web/connect/passkey[/verify]: signed in to Web, and only where the flag allows. */
export async function passkeySetupRequest({ verb = "", method = "GET", headers = {}, account = null, readBody, log = () => {} }) {
  const c = account?.conversation_id;
  if (account && !(shop.connectAllowedFor(c) && passkey.passkeyAllowedFor(c))) return null;
  if (!verb) {
    if (!account) return send(renderSetup({ signedIn: false }));
    const opts = await passkey.registrationOptions(c);
    if (!opts.ok) return null;
    return send(renderSetup({ has: passkey.passkeysOf(c), boot: { base: "/web/connect/passkey", options: opts.options } }));
  }
  if (verb !== "verify") return null;
  if (method !== "POST") return json(405, { ok: false });
  if (!account) return json(401, { ok: false, error: "signed_out" });
  if (!sameOrigin(headers)) return json(403, { ok: false, error: "origin" });
  const body = await bodyOf(readBody);
  if (!body) return json(400, { ok: false, error: "bad_json" });
  const out = await passkey.register(c, body);
  log({ pay_passkey: "register", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  return json(out.ok ? 200 : 400, out);
}
