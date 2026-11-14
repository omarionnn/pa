// Set or change a call passphrase on Reason's own page (src/callpass.js, REASON_CALL_TRUST). The same
// family as the save-login page (./savelogin.js): a one-use thirty-minute link from their own text thread,
// only its hash kept; the paper look; no third-party script or frame, no script at all, framed by
// nobody, nothing cached, no referrer; the POST from Reason's own origin only (./websignin.js
// sameOrigin). Nothing typed is ever in the HTML, a log line or the thread: the phrase is hashed in
// src/callpass.js saveFromLink and the request body is dropped.
//
//   GET  /web/call-passphrase/{token}        one box, what it is for, Save
//   POST /web/call-passphrase/{token}/save   form field `phrase`
//
// Switch off for the link's person, or a link spent, run out or never issued: null, the caller's flat 404.
import { webPage } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, field, go, actions } from "./paperkit.js";
import { sameOrigin } from "./websignin.js";
import * as callpass from "../callpass.js";

const headersFor = () => ({
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});
const send = (status, html) => ({ status, headers: { "Content-Type": "text/html; charset=utf-8", ...headersFor(), "Content-Length": Buffer.byteLength(html) }, body: html });

const ERRORS = {
  short: "That needs at least three words.",
  long: "That's more than eight words. Use a shorter one.",
};
const margin = () => label("I NEVER SEE", { pen: true }) + para("The phrase. Only a scrambled fingerprint of it is kept, so it can be checked but never read back.")
  + label("ON A CALL", { sp: true }) + para("I ask for it only when something needs it, like sending a message for you. Never for payments: those stay Face ID.")
  + label("THE LINK", { sp: true }) + para("Works once, and runs out in thirty minutes.");

/** The form. `error`: short | long. */
export function renderForm({ token, change = false, error = "" }) {
  const main = headline(change ? "Change your" : "Set your", "call passphrase")
    + lede("Three to eight words you'll remember and can say clearly. Not one you use anywhere else.")
    + `<form method="post" action="/web/call-passphrase/${token}/save" autocomplete="off">`
    + field({ id: "phrase", label: "PASSPHRASE", attrs: ` name="phrase" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" required`, error: ERRORS[error] ?? "" })
    + actions(go("Save", { type: "submit" }))
    + `</form>`;
  return webPage({ title: "Call passphrase", header: header(), body: frame({ main, margin: margin() }), css: PAPER_CSS });
}
export function renderDone() {
  const main = headline("Saved.", "") + lede("Your call passphrase is on. You can close this page.")
    + para("To change it, text me 'change my call passphrase'. To remove it, text 'remove my call passphrase'.");
  return webPage({ title: "Call passphrase", header: header(), body: frame({ main }), css: PAPER_CSS });
}

/** Everything under /web/call-passphrase. `sub` is the path after it. null: the caller's flat 404. */
export async function callPassphraseRequest({ sub = "", method = "GET", headers = {}, readBody, log = () => {} }) {
  const [token, verb = "", extra] = String(sub).split("/");
  if (extra !== undefined || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const link = callpass.linkFor(token);
  if (!link || !callpass.callTrustFor(link.conversation_id)) return null;
  if (!verb) {
    if (method !== "GET" && method !== "HEAD") return send(405, "");
    return send(200, renderForm({ token, change: link.purpose === "change" }));
  }
  if (verb !== "save") return null;
  if (method !== "POST") return send(405, "");
  if (!sameOrigin(headers)) { log({ call_passphrase_page: "save", ok: false, error: "origin" }); return send(403, ""); }
  let raw = String((await readBody?.()) ?? "");
  if (raw.length > 2000) { raw = ""; log({ call_passphrase_page: "save", ok: false, error: "size" }); return send(413, ""); }
  const phrase = new URLSearchParams(raw).get("phrase") ?? "";
  raw = "";
  const out = callpass.saveFromLink(token, phrase);
  // Only the outcome: never the body, the phrase or its length.
  log({ call_passphrase_page: "save", ok: !!out.ok, ...(out.error ? { error: out.error } : {}) });
  if (out.ok) return send(200, renderDone());
  if (out.error === "link") return null;
  return send(200, renderForm({ token, change: link.purpose === "change", error: out.error }));
}
