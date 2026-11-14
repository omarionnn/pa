// The way back to Messages, at the end of every page Reason texts a link to (the page kit's shared
// ending; used by the save-login and saved-login approval pages, and the end-of-flow pages after them).
//
// Owner, 2026-11-13, after the first saved-login sign-in on his iPhone: the page said "Approved" and
// left him there. Every page where the person does something for Reason ends the same way now: one
// sentence in the page's own voice, then ONE button, Back to Messages, that opens their thread with
// Reason. Where Reason already knows (it texts them by itself), the button opens the thread and
// types nothing. Where it doesn't, the button types a short reply for them ("done, go ahead"), which
// they still send themselves: nothing leaves their phone without them.
//
// The thread is the line their conversation is on (the account's channel: Sendblue or Linq), not
// whichever number happens to be configured first. No number at all (a console or web-only person):
// the web thread instead. The link carries a number and a fixed sentence only, never a token, a site
// or anything about them (backHref is checked for that in test/pages-back-and-resume.test.js).
//
// iOS reads `sms:NUMBER&body=` (Apple's own form; `?body=` is dropped by Messages on some versions);
// Android reads `sms:NUMBER?body=`. The page is drawn with the Apple form and BACK_JS swaps in the `?`
// on anything that isn't Apple. No automatic open: a programmatic jump to sms: without a tap is blocked
// or prompts on iOS Safari and does nothing at all on desktop, so the page offers the button and waits.
import { esc } from "./render.js";
import { config, normalizeNumber } from "../config.js";
import * as db from "../db.js";

export const WEB_THREAD = "/web?thread";
/** The fixed replies a button may type for them. Nothing else ever goes in a body. */
export const REPLIES = Object.freeze({
  go: "done, go ahead", again: "go ahead", saved: "saved it, go ahead", fresh: "send me a fresh link", connected: "done, keep going",
});

/** Which channel a conversation's thread is on: the account's own, else what its id says (dm:<channel>:…). */
function channelOf(conversationId) {
  const c = String(conversationId ?? "");
  let acct = null;
  try { acct = c ? db.getAccount(c) : null; } catch { acct = null; }
  return String(acct?.channel ?? /^dm:([a-z0-9_-]+):/i.exec(c)?.[1] ?? "").toLowerCase();
}

/** The number this person texts Reason on, "+1…", or "" when there is none. */
export function threadNumber(conversationId) {
  const ch = channelOf(conversationId);
  const raw = ch === "linq" ? config.linqFrom : ch === "sendblue" ? config.sendblueFrom : (config.sendblueFrom || config.linqFrom);
  return raw ? normalizeNumber(raw) || "" : "";
}

/**
 * Where Back to Messages goes. `reply`: a key of REPLIES (or "" for none). `apple`: the iOS form.
 * → { href, sms } ; sms false means the web thread (no number to text).
 */
export function backHref(conversationId, { reply = "", apple = true, via = "" } = {}) {
  // The thread the link was SENT in decides (2026-11-13): a link sent in a web chat goes back to the web
  // thread; one sent in their text thread goes to Messages. Never the browser it is opened in.
  if (via === "web") return { href: WEB_THREAD, sms: false };
  const number = threadNumber(conversationId);
  if (!number || !/^\+\d{6,15}$/.test(number)) return { href: WEB_THREAD, sms: false };
  const body = Object.hasOwn(REPLIES, reply) ? REPLIES[reply] : "";
  return { href: body ? `sms:${number}${apple ? "&" : "?"}body=${encodeURIComponent(body)}` : `sms:${number}`, sms: true };
}

/**
 * The ending: what just happened (`said`, the page's own voice), the one button, and the small line
 * under it saying what the button does. `reply` as backHref. `id` names the button for the page script.
 */
export function backToMessages(conversationId, { reply = "", id = "", label = "Back to Messages", via = "" } = {}) {
  const { href, sms } = backHref(conversationId, { reply, via });
  const under = !sms ? "Opens your thread with Reason."
    : reply ? "Opens Messages with a reply typed for you. Just hit send." : "Opens your thread with Reason in Messages.";
  return `<div class="pf-back"><a class="act pf-go pf-back-a" href="${esc(href)}"${sms ? " data-sms" : ""}${id ? ` id="${esc(id)}"` : ""}>${esc(label)} <span aria-hidden="true">→</span></a>`
    + `<p class="pf-back-u">${esc(under)}</p></div>`;
}

/** Set a back button's reply after the page learns it (the approval answered "resumed: false"). */
export const BACK_JS = `(function(){var apple=/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
function fix(a){var h=a.getAttribute('href')||'';if(!apple&&/^sms:[^?&]+&body=/.test(h))a.setAttribute('href',h.replace('&body=','?body='))}
document.querySelectorAll('a[data-sms]').forEach(fix);
window.pfBackReply=function(a,body,under){if(!a||!a.hasAttribute('data-sms'))return;var n=(a.getAttribute('href')||'').replace(/^sms:/,'').split(/[?&]/)[0];a.setAttribute('href','sms:'+n+(body?'&body='+encodeURIComponent(body):''));fix(a);var u=a.parentNode&&a.parentNode.querySelector('.pf-back-u');if(u&&under)u.textContent=under}})();`;

export const BACK_CSS = `
.pf-back{margin-top:40px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.pf-back-a{width:100%;max-width:440px;min-height:64px;padding:8px 2px;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);font-size:clamp(24px,7.2vw,32px)}
.pf-back-a>[aria-hidden=true]:last-child{margin-left:auto}
.pf-back-u{margin:0;font-size:14px;line-height:1.45;color:var(--muted);max-width:30em}
`;
