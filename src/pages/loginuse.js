// Approve one sign-in with a saved login, with Face ID (vault PR 6; src/loginuse.js holds the ask).
//
//   GET  /web/login-use/{token}           the site's name and one button: Approve with Face ID
//   POST /web/login-use/{token}/approve   { assertion }: a signature only
//
// A careful site, or a login saved "ask me each time", is never signed in to on a standing yes: each
// use needs this tap. The page shows the site's name and nothing else; nothing typed, nothing read
// from the site. Scripts by nonce only, framed by nobody, nothing cached, no referrer. With the switch
// off, or an unknown token, every path answers null (the caller's flat 404).
import { randomBytes } from "node:crypto";
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, actions, STEP_JS } from "./paperkit.js";
import { fromReason } from "./savelogin.js";
import * as use from "../loginuse.js";

const TITLE = "Reason — approve a sign-in";
const shell = (main) => `${header()}<main class="pf" id="lu-main">${main}</main>`;
const margin = () => label("FACE ID SAYS YES TO", { pen: true }) + para("One sign-in to this site, in the next few minutes. Nothing else.")
  + label("I NEVER SEE", { sp: true }) + para("Your login. It goes straight from the vault into the site's own page.");
const FOOT = `<p class="pf-note">This page is heyreason.com. Reason sends this link only in your own thread.</p>`;

const headersFor = (nonce) => ({
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
});
const html = (status, body, nonce, boot = null) => {
  const script = `${STEP_JS}${boot ? JS(boot) : ""}`;
  const text = webPage({ title: TITLE, body, css: PAPER_CSS, script }).replace(/<script>/g, `<script nonce="${nonce}">`);
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headersFor(nonce), "Content-Length": Buffer.byteLength(text) }, body: text };
};
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headersFor("none"), "Content-Length": Buffer.byteLength(body) }, body }; };

const JS = (boot) => `(function(){var B=${JSON.stringify(boot).replace(/</g, "\\u003c")};
function b2u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function u2b(x){var u=new Uint8Array(x),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function oops(t){var e=document.getElementById('lu-err');if(e){e.textContent=t;e.hidden=false}}
var go=document.getElementById('lu-go');if(!go)return;
go.onclick=function(){var o=B.options;if(!o||!window.PublicKeyCredential){oops("This browser can't use Face ID. Open the link in Safari or Chrome.");return}go.disabled=true;
  navigator.credentials.get({publicKey:{challenge:b2u(B.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:(o.allowCredentials||[]).map(function(c){return{type:'public-key',id:b2u(c.id),transports:c.transports}})}})
  .then(function(c){var r=c.response;return fetch(B.base+'/approve',{method:'POST',credentials:'same-origin',referrerPolicy:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({assertion:{id:c.id,rawId:u2b(c.rawId),type:c.type,response:{clientDataJSON:u2b(r.clientDataJSON),authenticatorData:u2b(r.authenticatorData),signature:u2b(r.signature),userHandle:r.userHandle?u2b(r.userHandle):null},clientExtensionResults:c.getClientExtensionResults?c.getClientExtensionResults():{}}})}).then(function(x){return x.json()})})
  .then(function(out){if(out&&out.ok){if(window.pfShow)window.pfShow('done');return}go.disabled=false;oops("Face ID didn't go through. Nothing was signed in to. Try again.")},function(){go.disabled=false;oops("Face ID didn't go through. Nothing was signed in to.")})};
})();`;

export function renderUse({ v, nonce, base }) {
  const site = v.site;
  if (v.state !== "open") {
    const main = headline(v.state === "approved" ? "Already approved." : "This link ran out.", "Nothing to do here.")
      + lede(v.state === "approved" ? `Go back to the chat and I'll sign in to ${site}.` : "Approval links last ten minutes. Ask me again and I'll send a fresh one.") + FOOT;
    return html(410, shell(frame({ main, margin: margin() })), nonce);
  }
  if (!v.passkey?.ok) {
    const main = headline(`Approve signing in to ${site}.`, "Face ID isn't ready on this phone.")
      + lede(v.passkey?.error === "cooling_off" ? "A Face ID added in the last day can't approve anything yet." : "Set up Face ID by saving a login first.") + FOOT;
    return html(200, shell(frame({ main, margin: margin() })), nonce);
  }
  const ask = frame({
    step: "ask",
    main: headline(`Sign in to ${site} with your saved login?`, "Approve with Face ID.")
      + lede(`I'll sign in to ${site} once, for the job you just asked for.`)
      + actions(`<button class="act pf-go" type="button" id="lu-go">Approve with Face ID <span aria-hidden="true">→</span></button>`)
      + `<p class="pf-note" id="lu-err" role="alert" hidden></p>` + FOOT,
    margin: margin(),
  });
  const done = frame({ step: "done", off: true, main: headline("Approved.", "Back to the chat.") + lede(`Tell me to go ahead and I'll sign in to ${site}.`), margin: margin() });
  return html(200, shell(ask + done), nonce, { base, challenge: v.challenge, options: v.passkey.options });
}

/** Everything under /web/login-use. `sub` is the path after it. null: the caller's flat 404. */
export async function loginUseRequest({ sub = "", method = "GET", headers = {}, readBody, log = () => {} }) {
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
  return json(out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
}
