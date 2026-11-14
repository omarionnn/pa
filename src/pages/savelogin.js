// Save a site's login once, on Reason's own page (vault PR 5; design A "The one Reason screen", B4, B8,
// B9; src/loginintake.js is the link and the signature, src/savedlogins.js the vault).
//
//   GET  /web/save-login/{token}           their request quoted, the site, the sign-in host, two boxes,
//                                          the wording, the choice, Save with Face ID
//   POST /web/save-login/{token}/save      { sealed, permission, assertion }: ciphertext and a signature only
//   POST /web/save-login/{token}/code      no passkey yet: text a code to their thread / type it (the
//                                          connect gate's browser proof, src/connectgate.js)
//   POST /web/save-login/{token}/passkey   no passkey yet, browser proved: the new passkey
//
// A real Reason page in Reason's paper look, never a picture of the site or of Reason's own browser.
// The boxes are sealed inside the browser as they are typed (sealInBrowser, the same function the tests
// run), to the intake key's public half; the passkey call runs inside the tap (Safari), over a challenge
// the page completes with the hash of what it sealed. No third-party script or frame at all, scripts
// by nonce only, framed by nobody, nothing cached, no referrer. Nothing typed is ever in the HTML.
//
// With the switch off for the link's person, or the vault not ready, every path here answers null:
// the caller's flat 404, the same as an address nobody was issued.
import { randomBytes } from "node:crypto";
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, go, two, actions, paper, field, sealed as sealedTag, STEP_JS } from "./paperkit.js";
import { sameOrigin } from "./websignin.js";
import * as intake from "../loginintake.js";
import * as passkey from "../passkey.js";
import { browserConversation, proofPage } from "../connectgate.js";
import { trySubmittedCode, issueCode, cookieHeader, codeHost, boundTo, ATTEMPT_WINDOW_MS, MAX_CODES_SENT, MAX_FAILED_ATTEMPTS, CODE_TTL_MS } from "./access.js";
import * as db from "../db.js";
import { backToMessages, BACK_JS, BACK_CSS } from "./backlink.js";
import { grantAfterSave } from "../loginuse.js";
import { afterSave } from "../resume.js";

/**
 * The two vault pages' phone layout (this page and src/pages/loginuse.js), on top of the paper kit: a
 * headline sized to the phone, the request quoted on paper, one primary action with room around it,
 * and the handwritten trust note in its own space under it at every width (owner 2026-11-13: on a
 * 390-px iPhone the note was drawn over "Approve with Face ID"). Safe-area insets for a notched phone.
 */
export const VAULT_CSS = `
.pf.vt{padding-left:max(clamp(var(--gutter),4vw,var(--gutter-wide)),env(safe-area-inset-left));padding-right:max(clamp(var(--gutter),4vw,var(--gutter-wide)),env(safe-area-inset-right));padding-bottom:calc(72px + env(safe-area-inset-bottom))}
.vt .h1{font-size:clamp(2.15rem,9.2vw,4rem);line-height:1.06;overflow-wrap:anywhere}
.vt .pf-col>.pf-l:first-child{margin-bottom:16px}
.vt .pf-lede{margin-top:20px;font-size:1.08rem;line-height:1.55}
.vt .pf-paper{margin-top:32px;padding:22px 22px 24px}
.vt .pf-big{font-size:clamp(18px,5.4vw,26px);overflow-wrap:anywhere}
.vt-q{margin:8px 0 0;font:italic 400 21px/1.4 var(--serif);color:var(--ink);overflow-wrap:anywhere}
.vt-host{margin:14px 0 0;padding-top:14px;border-top:1px dashed var(--hair)}
.vt-host p{margin:6px 0 0;font:400 15px/1.4 var(--mono);overflow-wrap:anywhere}
.vt-act{margin-top:36px}
.vt-go{width:100%;max-width:440px;min-height:64px;padding:8px 2px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);font-size:clamp(24px,7.2vw,32px);gap:.4em}
.vt-go>[aria-hidden=true]:last-child{margin-left:auto}
.vt-go .sl-face{flex:none;width:.8em;height:.8em;margin:0}
.vt-go .vt-t{flex:0 1 auto;min-width:0;line-height:1.12;text-wrap:balance}
.vt-go[disabled]{opacity:.5;cursor:default}
.vt-go[aria-busy=true]{opacity:.75;cursor:progress}
.vt-err{margin-top:16px}
.vt-trust{margin-top:36px;max-width:21em;font-size:1.22rem}
.vt-small{margin:14px 0 0}
@media (max-width:700px){.vt .pf-mn{padding-top:20px;gap:44px}.vt .pf-as{padding-top:28px}}
`;

const CSS = `${PAPER_CSS}${BACK_CSS}${VAULT_CSS}
.sl-q{margin:6px 0 0;font:italic 400 20px/1.4 var(--serif);color:var(--ink)}
.sl-host{font-family:var(--mono);letter-spacing:.02em}
.sl-ul{margin:10px 0 0;padding-left:18px;font-size:16px;line-height:1.5;color:var(--ink)}
.sl-ul li{margin:6px 0}
.sl-ch{margin:18px 0 0;border:0;padding:0}
.sl-ch label{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-size:17px;line-height:1.4;color:var(--ink)}
.sl-ch input{margin-top:4px;width:18px;height:18px;accent-color:var(--pen)}
.sl-warn{margin:16px 0 0;padding:10px 12px;border-left:3px solid var(--pen);font-size:16px;line-height:1.45;color:var(--ink)}
.sl-go{margin-top:36px}
.sl-form{margin-top:40px;display:flex;flex-direction:column;gap:32px}
.sl-form+.pf-l{margin-top:14px}
`;
export const FACE = `<svg class="sl-face" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M9 9v1.5M15 9v1.5M12 9v4h-1M9 16.5c1.8 1.4 4.2 1.4 6 0"/></svg>`;
const shell = (main, home = "") => `${header({ home })}<main class="pf vt" id="sl-main">${main}</main>`;
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const FOOT = `<p class="pf-note vt-trust">This page is heyreason.com. Reason only sends this link in your own thread, right after you ask for something.</p>`;

/** What saving means (the consent, CONSENT_VERSION): fixed words, the site's name only filled in. */
export function wording(name) {
  const n = esc(name);
  return `<ul class="sl-ul">`
    + `<li>Reason signs in to ${n} for jobs you ask for, and signs back in when ${n} logs it out.</li>`
    + `<li>Your login is locked with a key kept outside Reason's server. The AI never sees it. You can't read it back here either. You can only replace it or remove it.</li>`
    + `<li>The company that runs Reason could technically reach it. Every use is written down for you to read.</li>`
    + `<li>${n}'s rules may not allow an assistant to sign in for you. ${n} could lock or close the account.</li>`
    + `<li>Remove it any time: text &ldquo;forget my ${n} login&rdquo;.</li></ul>`;
}

function page(title, body, { nonce, boot = null, status = 200 }) {
  const script = `${STEP_JS}${BACK_JS}${boot ? JS(boot) : ""}`;
  const html = webPage({ title, body, css: CSS, script }).replace(/<script>/g, `<script nonce="${nonce}">`);
  return { status, html };
}

// ---------------------------------------------------------------- the screens
// One lifted paper: what they asked (their own words, when the link came in the middle of a job) and
// the exact sign-in page the login is for.
const theSite = (v) => paper({
  label: v.quoted ? "YOU ASKED" : "SIGN-IN PAGE",
  extra: (v.quoted ? `<p class="vt-q">&ldquo;${esc(v.quoted)}&rdquo;</p><div class="vt-host">${label("SIGN-IN PAGE")}` : `<div>`)
    + `<p class="pf-big">${esc(v.host)}</p><p class="sl-host">${esc(v.host)}${esc(v.path === "/" ? "" : v.path)}</p></div>`,
});
const asked = (v) => v.quoted ? paper({ label: "YOU ASKED", extra: `<p class="vt-q">&ldquo;${esc(v.quoted)}&rdquo;</p>` }) : "";
const eyebrow = () => label("SAVE A LOGIN", { pen: true });
const margin = () => label("I NEVER SEE", { pen: true }) + para("Your login. It is sealed on this phone before it leaves, and only the vault can open it.")
  + label("THE LINK", { sp: true }) + para("Works once, and runs out in thirty minutes.")
  + label("FACE ID SIGNS", { sp: true }) + para("This login, for this site, under these words. Nothing else.");

/** The open link: the form, then each screen the script moves to. `blocked`: no_passkey | cooling_off. */
export function renderSave({ v, nonce, boot = null, blocked = "", proved = false, sent = false, error = "" }) {
  const name = v.label;
  if (blocked === "cooling_off") {
    const main = headline("Your new Face ID isn't ready yet.", "Nothing was saved.") + lede("A Face ID added after the first one waits a day before it can approve anything, so nobody can add one and use it before you hear.") + FOOT;
    return page("Reason — save a login", shell(frame({ main, margin: margin() }), v.conversationId), { nonce });
  }
  if (blocked === "no_passkey" && !proved) {
    const main = eyebrow() + headline(`Save your ${name} login in Reason.`, "First, prove this is your phone.") + asked(v)
      + lede("I'll text a code to the thread this link came from. Type it here, then set up Face ID.")
      + `<form method="post" action="/web/save-login/${esc(boot.token)}/code">`
      + (sent ? field({ id: "sl-code", label: "Code from your texts", attrs: ` name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required`, error, mono: true })
        + actions(go("Check the code", { type: "submit" }))
        : (error ? para(esc(error)) : "") + actions(`<button class="act pf-go" type="submit" name="send" value="1">Text me a code <span aria-hidden="true">→</span></button>`))
      + `</form>` + FOOT;
    return page("Reason — save a login", shell(frame({ main, margin: margin() }), v.conversationId), { nonce, status: error ? 400 : 200 });
  }
  if (blocked === "no_passkey") {
    const add = frame({
      step: "add",
      main: eyebrow() + headline(`Save your ${name} login in Reason.`, "Set up Face ID first.") + asked(v)
        + lede("Saving a login needs Face ID on this phone, so only you can say yes.")
        + `<div class="vt-act"><button class="act pf-go vt-go" type="button" id="sl-add">${FACE}<span class="vt-t">Set up Face ID</span> <span aria-hidden="true">→</span></button></div>`
        + `<p class="pf-note vt-err" id="sl-err" role="alert" hidden></p>` + FOOT,
      margin: margin(),
    });
    return page("Reason — save a login", shell(add, v.conversationId), { nonce, boot });
  }
  const careful = v.careful;
  const choice = `<fieldset class="sl-ch"><legend class="pf-l">WHEN I MAY SIGN IN</legend>`
    + (careful ? "" : `<label><input type="radio" name="sl-perm" value="standing" checked> Sign in whenever a job I ask for needs it</label>`)
    + `<label><input type="radio" name="sl-perm" value="each_time"${careful ? " checked" : ""}> Ask me with Face ID every time</label></fieldset>`;
  const ask = frame({
    step: "ask",
    main: eyebrow() + headline(`Save your ${name} login in Reason.`, "Type it once, here.", "sl-h")
      + theSite(v)
      + `<form id="sl-form" class="sl-form" autocomplete="on" novalidate>`
      + field({ id: "sl-user", label: "Email or username", attrs: ` name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required` })
      + field({ id: "sl-pass", label: "Password", attrs: ` name="password" type="password" autocomplete="current-password" required` })
      + `</form>` + `<p class="pf-l">${sealedTag("SEALED ON THIS PHONE")}</p>`
      + label("WHAT SAVING MEANS", { sp: true }) + wording(name)
      + choice
      + (v.google ? `<p class="sl-warn" id="sl-google-warn">${esc(v.warning)}</p>`
        : careful && v.warning ? `<p class="sl-warn">${esc(v.warning)} So I'll ask you with Face ID every time.</p>` : "")
      // What saving here starts, said before they save (review 2026-11-13): with their request quoted
      // above, this page and their Face ID are the confirmation the save grant stands on (src/resume.js).
      + (v.quoted && !v.google ? para(`Once it's saved, I'll sign in to ${esc(v.host)} for that and carry on${careful ? ", after you say yes with Face ID" : ""}. You don't need to tell me to go ahead.`) : "")
      + `<div class="vt-act"><button class="act pf-go vt-go" type="button" id="sl-go" disabled>${FACE}<span class="vt-t">Save with Face ID</span> <span aria-hidden="true">→</span></button></div>`
      + `<p class="pf-l vt-small">RUNS OUT IN ${minutes(v.expiresAt - Date.now())} MIN · NOTHING SAVED YET</p>`
      + `<p class="pf-note vt-err" id="sl-err" role="alert" hidden></p>` + FOOT,
    margin: margin(),
  });
  const saving = frame({ step: "saving", off: true, main: headline("Approved.", "Locking it away.") + lede("One moment."), margin: label("SAVING") + para(`Your ${esc(name)} login, sealed.`) });
  // The ending (src/pages/backlink.js). `saved`: Reason already knows and texts them by itself (it
  // carries on with their request, or confirms the save), so the button types nothing. `savedq`:
  // nothing could tell Reason, so the button types "saved it, go ahead" for them.
  const savedMain = (knows) => label("SAVED", { pen: true }) + headline(`Your ${name} login is locked away.`, knows ? "Reason has it from here." : "Tell me to go ahead.")
    + lede(knows ? (v.quoted ? "I'm carrying on with what you asked, and I'll text you in Messages how it went." : "I've texted you in Messages. I'll sign in with it when a job you ask for needs it.")
      : "Send the reply that's typed for you and I'll carry on. Nobody, me included, can read your login back.")
    + paper({ stamp: "SAVED", label: name.toUpperCase(), big: "Locked.", mono: false })
    + backToMessages(v.conversationId, { reply: knows ? "" : "saved" });
  const savedMargin = label("THIS LINK") + para("Is used up.") + label("TO REMOVE IT", { sp: true }) + para(`Text &ldquo;forget my ${esc(name)} login&rdquo;.`);
  const saved = frame({ step: "saved", off: true, main: savedMain(true), margin: savedMargin })
    + frame({ step: "savedq", off: true, main: savedMain(false), margin: savedMargin });
  return page("Reason — save a login", shell(ask + saving + saved, v.conversationId), { nonce, boot });
}

/** A used or expired link: plain words, nothing to type. 410 so a guess at an old link reads as gone. */
export function renderEnded({ v, nonce }) {
  const used = v.state === "used";
  const main = headline(used ? "This link has been used." : "This link ran out.", used ? "Nothing to type here." : "Nothing was saved.")
    + lede(used ? "Save links work once. If your login didn't save, ask me again and I'll send a fresh one." : "Save links last thirty minutes. Send the reply that's typed for you and I'll text a fresh one.")
    + backToMessages(v.conversationId, { reply: used ? "" : "fresh" }) + FOOT;
  return page("Reason — save a login", shell(frame({ main, margin: label("WHY") + para("A link that runs out can't be used by anyone who sees it later.") }), v.conversationId), { nonce, status: 410 });
}

// ---------------------------------------------------------------- the script
// The sealing runs as they type (debounced), so the tap goes straight to the passkey call. A value
// changed after the last sealing waits for the next one before the button works again.
const JS = (boot) => `(function(){var B=${JSON.stringify(boot).replace(/</g, "\\u003c")};
var sealInBrowser=${intake.sealInBrowser.toString()};
function b2u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function u2b(x){var u=new Uint8Array(x),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function el(id){return document.getElementById(id)}
function oops(t){var e=el('sl-err');if(e){e.textContent=t;e.hidden=false}}
function show(n){if(window.pfShow)window.pfShow(n)}
function post(p,body){return fetch(B.base+p,{method:'POST',credentials:'same-origin',referrerPolicy:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return{ok:false,error:'http_'+r.status}})})}
var S=crypto.subtle,WHY={unknown_passkey:"That Face ID isn't the one set up for Reason. Nothing was saved.",cooling_off:"This Face ID was added less than a day ago. Nothing was saved.",exists:"You already have a login saved for this site. Text me to forget it first, then ask again.",no_user_verification:"Face ID didn't check you. Nothing was saved."};
var FAIL="Face ID didn't go through. Nothing was saved. Try again.";
var add=el('sl-add');
if(add)add.onclick=function(){var o=B.reg;if(!o||!window.PublicKeyCredential){oops("This browser can't set up Face ID. Open the link in Safari or Chrome.");return}add.disabled=true;
  navigator.credentials.create({publicKey:{rp:o.rp,user:{id:b2u(o.user.id),name:o.user.name,displayName:o.user.displayName},challenge:b2u(o.challenge),pubKeyCredParams:o.pubKeyCredParams,timeout:o.timeout,attestation:'none',authenticatorSelection:o.authenticatorSelection,excludeCredentials:(o.excludeCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;return post('/passkey',{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),attestationObject:u2b(r.attestationObject),transports:r.getTransports?r.getTransports():[]},clientExtensionResults:{}})})
  .then(function(out){if(out&&out.ok)return location.reload();add.disabled=false;oops("Face ID wasn't set up. Try again.")},function(){add.disabled=false;oops("Face ID wasn't set up. Try again when you're ready.")})};
var go=el('sl-go'),u=el('sl-user'),pw=el('sl-pass');if(!go||!u||!pw)return;
var turn=0,ready=null,timer=null;
function perm(){var r=document.querySelector('input[name="sl-perm"]:checked');return r?r.value:'each_time'}
function seal(){var mine=++turn;ready=null;go.disabled=true;if(!u.value||!pw.value)return;
  sealInBrowser(S,b2u(B.publicKey),B.intakeId,u.value,pw.value,'').then(function(blob){return S.digest('SHA-256',blob).then(function(h){
    var ps=Object.keys(B.parts),ch={};return Promise.all(ps.map(function(p){var a=b2u(B.parts[p]),m=new Uint8Array(64);m.set(a,0);m.set(new Uint8Array(h),32);return S.digest('SHA-256',m).then(function(d){ch[p]=u2b(d)})})).then(function(){if(mine===turn){ready={blob:u2b(blob),ch:ch};go.disabled=false}})})})
  .catch(function(){oops("This browser couldn't seal your login. Nothing was sent. Try Safari or Chrome.")})}
function later(){clearTimeout(timer);ready=null;go.disabled=true;timer=setTimeout(seal,150)}
u.addEventListener('input',later);pw.addEventListener('input',later);
addEventListener('pagehide',function(){u.value='';pw.value=''});
go.onclick=function(){if(!ready)return;var o=B.options,p=perm(),r0=ready;if(!o){oops(FAIL);return}go.disabled=true;el('sl-err').hidden=true;
  navigator.credentials.get({publicKey:{challenge:b2u(r0.ch[p]),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:(o.allowCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;show('saving');return post('/save',{sealed:r0.blob,permission:p,assertion:{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),authenticatorData:u2b(r.authenticatorData),signature:u2b(r.signature),userHandle:r.userHandle?u2b(r.userHandle):undefined},clientExtensionResults:{}}})})
  .then(function(out){if(!out)return;if(out.ok){u.value='';pw.value='';return show(out.carried?'saved':'savedq')}if(/^link_/.test(out.error||''))return location.reload();show('ask');oops((WHY[out.error]||FAIL)+(/^link_|^http_/.test(out.error||'')?'':' Ask me for a fresh link.'));u.value='';pw.value=''},
    function(){show('ask');go.disabled=false;oops(FAIL)})};
})();`;

// ---------------------------------------------------------------- routes
const headersFor = (nonce) => ({
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});
export const SAVE_HEADERS = headersFor("NONCE");
const send = ({ status, html }, nonce, extra = {}) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...headersFor(nonce), ...extra, "Content-Length": Buffer.byteLength(html) }, body: html });
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headersFor("none"), "Content-Length": Buffer.byteLength(body) }, body }; };
const BODY_MAX = 16_000;
async function bodyOf(readBody) {
  const raw = (await readBody()) || "{}";
  if (raw.length > BODY_MAX) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
/** The save and passkey POSTs: from heyreason.com itself, said by the browser (Origin), never a page elsewhere. */
export function fromReason(headers = {}) {
  const site = String(headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site && site !== "same-origin") return false;
  return passkey.ORIGINS().includes(String(headers.origin ?? "").trim());
}
const proofOf = (c) => proofPage(c, "Save a login");

/** Everything under /web/save-login. `sub` is the path after it. null: the caller's flat 404. */
export async function saveLoginRequest({ sub = "", method = "GET", headers = {}, readBody, runtime = null, log = () => {} }) {
  const [token, verb = "", extra] = String(sub).split("/");
  if (extra !== undefined || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const v = await intake.viewFor(token);
  if (!v) return null;
  const nonce = randomBytes(16).toString("base64");
  const base = `/web/save-login/${token}`;
  if (!verb) {
    if (method !== "GET" && method !== "HEAD") return json(405, { ok: false });
    if (v.state !== "open") return send(renderEnded({ v, nonce }), nonce);
    const pk = v.passkey;
    if (!pk.ok && pk.error === "no_passkey") {
      if (browserConversation(headers) !== v.conversationId) return send(renderSave({ v, nonce, blocked: "no_passkey", boot: { token } }), nonce);
      const reg = await passkey.registrationOptions(v.conversationId, { allowed: true });
      return send(renderSave({ v, nonce, blocked: "no_passkey", proved: true, boot: { base, reg: reg.ok ? reg.options : null } }), nonce);
    }
    if (!pk.ok) return send(renderSave({ v, nonce, blocked: pk.error }), nonce);
    return send(renderSave({ v, nonce, boot: { base, publicKey: v.publicKey, intakeId: v.intakeId, parts: v.parts, options: pk.options } }), nonce);
  }
  if (!["save", "code", "passkey"].includes(verb)) return null;
  if (method !== "POST") return json(405, { ok: false });
  if (verb === "code") return codeStep({ v, token, nonce, headers, readBody, runtime, log });
  if (!fromReason(headers)) { log({ save_login: verb, ok: false, error: "origin" }); return json(403, { ok: false, error: "origin" }); }
  const body = await bodyOf(readBody);
  if (!body) return json(400, { ok: false, error: "bad_json" });
  if (verb === "passkey") {
    if (v.state !== "open" || browserConversation(headers) !== v.conversationId) return json(403, { ok: false, error: "not_proved" });
    const out = await passkey.register(v.conversationId, body, { allowed: true, for: "login" });
    log({ save_login: "passkey", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
    return json(out.ok ? 200 : 400, { ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  }
  const out = await intake.storeFromIntake(token, body);
  if (!out) return null;
  // Which link's save and how it went: never the body, the blob or the assertion.
  log({ save_login: "save", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  if (!out.ok) return json(400, { ok: false, error: out.error });
  // Reason hears about it by itself (src/resume.js): it carries on with the request the save link was
  // made for (a one-use grant bound to this person, site and request), or texts a short confirmation.
  // The answer says only whether Reason knows: never the grant or the request.
  const grant = v.quoted ? grantAfterSave(v.conversationId, out.site, v.quoted) : "";
  const carried = afterSave(runtime, { conversationId: v.conversationId, site: out.site, label: out.label, request: v.quoted, grant }, { log });
  return json(200, { ok: true, carried: !!carried });
}

// No passkey yet: the browser is proved the way a connect link proves it (a code texted to the thread
// the link came from), then the page sets up Face ID. A right code leaves the `connect:` session.
async function codeStep({ v, token, nonce, headers, readBody, runtime, log }) {
  const again = (opts) => send(renderSave({ v, nonce, blocked: "no_passkey", boot: { token }, ...opts }), nonce);
  if (v.state !== "open") return send(renderEnded({ v, nonce }), nonce);
  if (!sameOrigin(headers)) return again({ error: "This page has to be used directly. Open the link Reason texted again." });
  const pg = proofOf(v.conversationId);
  const locked = db.failedPageAttempts(pg.id, ATTEMPT_WINDOW_MS) >= MAX_FAILED_ATTEMPTS;
  const lockedWords = `Too many wrong codes. Try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60000)} minutes.`;
  const form = new URLSearchParams(String((await readBody?.()) ?? ""));
  if (form.has("send")) {
    if (locked) return again({ error: lockedWords });
    if (db.pageCodesIssued(pg.id, ATTEMPT_WINDOW_MS) >= MAX_CODES_SENT) return again({ sent: true, error: "I've already texted a code. Use that one." });
    const { id, code } = issueCode(pg.id);
    const line = `Your Reason code is ${code}, to save a login on that browser. Good for ${Math.round(CODE_TTL_MS / 60000)} minutes. If that wasn't you, ignore this.${boundTo(codeHost(`http://${String(headers?.host ?? "")}`), code)}`;
    try {
      if (runtime?._tell) await runtime._tell(v.conversationId, line, { idempotencyKey: `pcode:${pg.id}:${id}` });
      else await runtime?.say?.(v.conversationId, line);
    } catch (e) { log({ save_login: "code", ok: false, error: "text_failed" }); }
    return again({ sent: true });
  }
  const tried = trySubmittedCode({ page: pg, code: form.get("code") ?? "" });
  if (tried.ok) {
    log({ save_login: "code", ok: true });
    return { status: 303, headers: { ...headersFor(nonce), Location: `/web/save-login/${token}`, "Set-Cookie": cookieHeader(tried.token, { path: "/", headers }), "Content-Length": 0 }, body: "" };
  }
  if (tried.reason === "rate_limited") return again({ sent: true, error: lockedWords });
  return again({ sent: true, error: `That code is not right.${tried.tries_left ? ` ${tried.tries_left} ${tried.tries_left === 1 ? "try" : "tries"} left.` : ""}` });
}
