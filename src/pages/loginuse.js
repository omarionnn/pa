// Approve one sign-in with a saved login, with Face ID (vault PR 6; src/loginuse.js holds the ask).
//
//   GET  /web/login-use/{token}           the site's name and one button: Approve with Face ID
//   POST /web/login-use/{token}/approve   { assertion }: a signature only
//
// A careful site, or a login saved "ask me each time", is never signed in to on a standing yes: each
// use needs this tap. The page shows the site's name and the request they typed (src/loginuse.js keeps
// it with the ask); nothing typed here, nothing read from the site. Once approved, Reason carries on
// with that job by itself (src/resume.js) and the page ends with one button back to Messages
// (src/pages/backlink.js). Scripts by nonce only, framed by nobody, nothing cached, no referrer. With the switch
// off, or an unknown token, every path answers null (the caller's flat 404).
import { randomBytes } from "node:crypto";
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, paper, STEP_JS } from "./paperkit.js";
import { backToMessages, BACK_JS, BACK_CSS } from "./backlink.js";
import { fromReason, FACE, VAULT_CSS } from "./savelogin.js";
import * as use from "../loginuse.js";
import { afterApproval } from "../resume.js";

const TITLE = "Reason — approve a sign-in";
const CSS = `${PAPER_CSS}${BACK_CSS}${VAULT_CSS}`;
const shell = (main, home = "", via = "") => `${header({ home, via })}<main class="pf vt" id="lu-main">${main}</main>`;
const margin = () => label("FACE ID SAYS YES TO", { pen: true }) + para("One sign-in to this site, in the next few minutes. Nothing else.")
  + label("I NEVER SEE", { sp: true }) + para("Your login. It goes straight from the vault into the site's own page.");
const TRUST = `<p class="pf-note vt-trust">This page is heyreason.com. Reason sends this link only in your own thread.</p>`;
const asked = (request) => request ? paper({ label: "YOU ASKED", extra: `<p class="vt-q">&ldquo;${esc(request)}&rdquo;</p>` }) : "";

const headersFor = (nonce) => ({
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
});
const html = (status, body, nonce, boot = null) => {
  const script = `${STEP_JS}${BACK_JS}${boot ? JS(boot) : ""}`;
  const text = webPage({ title: TITLE, body, css: CSS, script }).replace(/<script>/g, `<script nonce="${nonce}">`);
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headersFor(nonce), "Content-Length": Buffer.byteLength(text) }, body: text };
};
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headersFor("none"), "Content-Length": Buffer.byteLength(body) }, body }; };

// Tap → Face ID → POST. The answer picks the ending: `done` (Reason carries on by itself), `held`
// (approved, but nothing could pick the job up: the button types "done, go ahead"), `gone` (the link
// ended or the server restarted and forgot it). A 404/410 answer is the same as link_ended.
const JS = (boot) => `(function(){var B=${JSON.stringify(boot).replace(/</g, "\\u003c")};
function b2u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function u2b(x){var u=new Uint8Array(x),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
var go=document.getElementById('lu-go'),err=document.getElementById('lu-err');if(!go)return;var t=go.querySelector('.vt-t'),t0=t?t.textContent:'';
function busy(on,w){go.disabled=!!on;if(on)go.setAttribute('aria-busy','true');else go.removeAttribute('aria-busy');if(t)t.textContent=on?w:t0}
window.luBusy=function(on){busy(on,'Waiting for Face ID…')};
function oops(m){busy(false);if(err){err.textContent=m;err.hidden=false}}
function show(n){if(window.pfShow)window.pfShow(n)}
go.onclick=function(){var o=B.options;if(!o||!window.PublicKeyCredential){oops("This browser can't use Face ID. Open the link in Safari or Chrome.");return}if(err)err.hidden=true;busy(true,'Waiting for Face ID…');
  navigator.credentials.get({publicKey:{challenge:b2u(B.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:(o.allowCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;busy(true,'Approving…');return fetch(B.base+'/approve',{method:'POST',credentials:'same-origin',referrerPolicy:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({assertion:{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),authenticatorData:u2b(r.authenticatorData),signature:u2b(r.signature),userHandle:r.userHandle?u2b(r.userHandle):null},clientExtensionResults:c.getClientExtensionResults?c.getClientExtensionResults():{}}})})
    .then(function(x){if(x.status===404||x.status===410)return{ok:false,error:'link_ended'};return x.json().catch(function(){return{ok:false,error:'http_'+x.status}})})})
  .then(function(out){if(!out)return;if(out.ok)return show(out.resumed?'done':'held');if(out.error==='link_ended')return show('gone');oops("Face ID didn't go through. Nothing was signed in to. Try again.")},function(){oops("Face ID didn't go through. Nothing was signed in to. Try again.")})};
})();`;

const afterMargin = () => label("THIS APPROVAL") + para("Covers one sign-in, in the next five minutes. Then it's used up.")
  + label("I NEVER SEE", { sp: true, pen: true }) + para("Your login. It goes straight from the vault into the site's own page.");
/** The endings, shared by the live page (steps) and a reopened link. */
function ending(kind, v, { step = "", off = false } = {}) {
  const site = v.site, c = v.conversationId;
  const E = {
    done: [label("APPROVED", { pen: true }) + headline("Done.", "Reason has it from here.")
      + lede(`I'm signing in to ${site} now, for what you asked. I'll text you in Messages when it's done. Nothing to type.`), ""],
    held: [label("APPROVED", { pen: true }) + headline("Approved.", "Tell me to go ahead.")
      + lede(`I couldn't pick the job back up by myself this time. Send the reply that's typed for you and I'll sign in to ${site}.`), "go"],
    gone: [headline("This link isn't open any more.", "Nothing was signed in to.")
      + lede("It ran out, or Reason restarted and forgot it. Send the reply that's typed for you and I'll text a fresh one."), "again"],
    expired: [headline("This link ran out.", "Nothing was signed in to.")
      + lede("Approval links last ten minutes. Send the reply that's typed for you and I'll text a fresh one."), "again"],
  }[kind];
  return frame({ step, off, main: E[0] + backToMessages(c, { reply: E[1], via: v?.via ?? "" }) + TRUST, margin: afterMargin() });
}

export function renderUse({ v, nonce, base }) {
  const site = v.site;
  if (v.state !== "open") {
    if (v.state === "approved") return html(410, shell(ending(v.resumed ? "done" : "held", v), v.conversationId, v.via), nonce);
    return html(410, shell(ending("expired", v), v.conversationId, v.via), nonce);
  }
  if (!v.passkey?.ok) {
    const main = label("APPROVE ONE SIGN-IN", { pen: true }) + headline(`Sign in to ${site}?`, "Face ID isn't ready on this phone.")
      + lede(v.passkey?.error === "cooling_off" ? "A Face ID added in the last day can't approve anything yet. Nothing was signed in to." : "Set up Face ID by saving a login first. Nothing was signed in to.")
      + backToMessages(v.conversationId, { via: v.via }) + TRUST;
    return html(200, shell(frame({ main, margin: margin() }), v.conversationId, v.via), nonce);
  }
  const ask = frame({
    step: "ask",
    main: label("APPROVE ONE SIGN-IN", { pen: true }) + (v.google
      ? headline(`Sign in to ${site} with your Google account?`, "Through its Continue with Google.")
      : headline(`Sign in to ${site}?`, "With your saved login."))
      + asked(v.request)
      + lede(v.google
        ? `I'll press ${site}'s own "Continue with Google" and type your saved Google login on Google's sign-in page, once, for ${v.request ? "that" : "the job you just asked for"}. This one approval covers the whole sign-in. I won't open Gmail, Drive or your Google settings. If Google asks you to confirm, I'll text you.`
        : `I'll sign in to ${site} once, for ${v.request ? "that" : "the job you just asked for"}, then text you how it went.`)
      + `<div class="vt-act"><button class="act pf-go vt-go" type="button" id="lu-go">${FACE}<span class="vt-t">Approve with Face ID</span> <span aria-hidden="true">→</span></button></div>`
      + `<p class="pf-note vt-err" id="lu-err" role="alert" hidden></p>` + TRUST,
    margin: margin(),
  });
  const ends = ["done", "held", "gone"].map((k) => ending(k, v, { step: k, off: true })).join("");
  return html(200, shell(ask + ends, v.conversationId, v.via), nonce, { base, challenge: v.challenge, options: v.passkey.options });
}

/** Everything under /web/login-use. `sub` is the path after it. null: the caller's flat 404. */
export async function loginUseRequest({ sub = "", method = "GET", headers = {}, readBody, runtime = null, log = () => {} }) {
  const [token, verb = "", extra] = String(sub).split("/");
  if (extra !== undefined || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const v = use.useView(token);
  if (!v) return null;
  const base = `${use.USE_PATH}${token}`;
  if (!verb) {
    if (method !== "GET" && method !== "HEAD") return json(405, { ok: false });
    return renderUse({ v, nonce: randomBytes(16).toString("base64"), base });
  }
  if (verb !== "approve") return null;
  if (method !== "POST") return json(405, { ok: false });
  if (!fromReason(headers)) { log({ login_use: "approve", ok: false, error: "origin" }); return json(403, { ok: false, error: "origin" }); }
  let body = null;
  try { const raw = (await readBody()) || "{}"; body = raw.length > 16_000 ? null : JSON.parse(raw); } catch { body = null; }
  if (!body) return json(400, { ok: false, error: "bad_json" });
  const out = await use.approveUse(token, body.assertion);
  log({ login_use: "approve", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  if (!out.ok) return json(400, { ok: false, error: out.error });
  // The yes carries on with the job they asked for, by itself (src/resume.js). The answer says only
  // whether it did: never the grant, the request or anything else.
  const resumed = afterApproval(runtime, out.resume, { log });
  return json(200, { ok: true, resumed });
}
