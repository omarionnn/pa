// Reason Web: reply to one message (REASON_WEB_REPLY, src/dailyflag.js), the way holding a bubble and
// tapping Reply does it in Messages.
//
// Three parts, all of them drawn from rows the thread already keeps — nothing new is stored:
//
//   send   the composer names one history row (`re`, its messages.id). The server turns that into the
//          message's own handle — theirs: the inbound row's id; Reason's: the outbox's message_id — in
//          the SESSION's conversation and no other, plus the thread it sits in, and hands both to
//          Router.deliver as `replyTo` / `threadRoot`. From there it is exactly an iMessage inline reply:
//          claimInbound keeps both on the row, replies.inboundReplyLine tells the turn which message
//          (and which thread) it answers, db.threadMessages finds it later. The browser never names a
//          handle, so it cannot point a reply into anybody else's thread.
//   draw   a line whose message was a reply — theirs, sent from Web or inside an iMessage thread, or
//          Reason's, pinned under a message (replies.answerTarget, latePin, the reply_to tool) — gets a
//          quiet quote line of the message it answers. Clicking it goes to that message.
//   button each line that has a handle carries a small Reply button, shown on hover or focus, on a tap
//          (or a long press, which replies at once) where there is no hover.
//
// The words of the reply note the turn read ("[they sent this as an inline reply …]") are kept on the
// history row (the model reads them); a line that draws its quote does not repeat them as words.
import * as db from "../db.js";
import { esc } from "./render.js";
import { webReplyAllowedFor } from "../dailyflag.js";

export { webReplyAllowedFor };

/** How much of the message replied to the quote line and the composer show. */
export const QUOTE_MAX = 80;

/** The reply note at the head of a reply's stored words (src/replies.js inboundReplyLine), as one line. */
export const REPLY_NOTE = /^\s*\[they sent this as an inline reply\b[^\n]*\]\s*(?:\n|$)/i;

/** The words a quote of this row says: its own words, without any note Reason put in front of them. */
function quoteWords(row) {
  let t = String(row.text ?? "");
  if (row.role === "user") t = t.replace(REPLY_NOTE, "").replace(/^\s*\[they (?:sent|shared) [^\n]*\]\s*$/gm, "");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) {
    let media = [];
    try { media = Array.isArray(row.media) ? row.media : JSON.parse(row.media || "[]"); } catch { media = []; }
    const kind = String(media[0]?.kind ?? media[0]?.type ?? "");
    t = !media.length ? "" : /audio|voice/i.test(kind) ? "a voice note" : /image|photo/i.test(kind) || media[0]?.choice ? "a photo" : "a file";
  }
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1).trimEnd()}…` : t;
}

const one = (sql, ...args) => db.db.prepare(sql).get(...args);

/**
 * The provider's handle for one of this conversation's own history rows, or null: theirs is the
 * inbound row's id, Reason's the id its channel gave the message when it went. Only the shared
 * thread's rows, only ones that are still there, only messages that really arrived or went.
 */
export function handleOfRow(conversationId, rowId) {
  const id = Number(rowId);
  if (!conversationId || !Number.isSafeInteger(id) || id <= 0) return null;
  const row = one("SELECT role, external_id, outbox_id FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL AND chat_id IS NULL", id, conversationId);
  if (!row) return null;
  if (row.role === "user") {
    if (!row.external_id) return null;
    return one("SELECT external_id FROM inbound_messages WHERE conversation_id = ? AND external_id = ?", conversationId, String(row.external_id))?.external_id ?? null;
  }
  if (!row.outbox_id) return null;
  return one("SELECT message_id FROM outbox WHERE id = ? AND conversation_id = ? AND state = 'sent' AND message_id IS NOT NULL", row.outbox_id, conversationId)?.message_id ?? null;
}

/**
 * The message the thread `handle` sits in started with — Apple keeps a thread by its first message,
 * and a reply under a message that is itself in a thread is in that thread (src/replies.js). A
 * message in no thread starts its own. A few hops at most; a loop ends where it began.
 */
export function threadRootOf(conversationId, handle) {
  let h = String(handle ?? "");
  const seen = new Set();
  for (let hop = 0; h && hop < 6; hop++) {
    seen.add(h.toLowerCase());
    const theirs = one("SELECT thread_root, reply_to FROM inbound_messages WHERE conversation_id = ? AND external_id = ? COLLATE NOCASE", conversationId, h);
    const up = theirs
      ? (theirs.thread_root || theirs.reply_to)
      : one("SELECT reply_to FROM outbox WHERE conversation_id = ? AND message_id = ? COLLATE NOCASE AND state = 'sent'", conversationId, h)?.reply_to;
    if (!up || seen.has(String(up).toLowerCase())) return h;
    h = String(up);
  }
  return h;
}

/** What a Web reply to row `rowId` is sent as: `{ replyTo, threadRoot }`, or null when the row has no handle. */
export function replyFor(conversationId, rowId) {
  const replyTo = handleOfRow(conversationId, rowId);
  return replyTo ? { replyTo, threadRoot: threadRootOf(conversationId, replyTo) } : null;
}

/**
 * Which message a history row answers, as a handle, or null. Theirs from Web: the message they
 * pressed Reply on. Theirs from iMessage: the thread it was sent in (the parent Sendblue names can be
 * the newest message in the conversation instead, 2026-10-06; src/replies.js). Reason's: the message
 * it was pinned under.
 */
function parentHandleOf(conversationId, row) {
  if (row.role === "user") {
    if (!row.external_id) return null;
    const ib = one("SELECT reply_to, thread_root FROM inbound_messages WHERE conversation_id = ? AND external_id = ?", conversationId, String(row.external_id));
    if (!ib) return null;
    return row.channel === "web" ? (ib.reply_to || ib.thread_root) : (ib.thread_root || ib.reply_to);
  }
  if (!row.outbox_id) return null;
  return one("SELECT reply_to FROM outbox WHERE id = ? AND conversation_id = ?", row.outbox_id, conversationId)?.reply_to ?? null;
}

/** The history row for a handle in this conversation's shared thread, or null. */
function rowByHandle(conversationId, handle) {
  const h = String(handle ?? "");
  if (!h) return null;
  const theirs = one("SELECT id, role, text, media FROM messages WHERE conversation_id = ? AND role = 'user' AND external_id = ? COLLATE NOCASE AND deleted_at IS NULL AND chat_id IS NULL ORDER BY id LIMIT 1", conversationId, h);
  if (theirs) return theirs;
  const ob = one("SELECT id FROM outbox WHERE conversation_id = ? AND message_id = ? COLLATE NOCASE AND state = 'sent'", conversationId, h);
  return ob ? one("SELECT id, role, text, media FROM messages WHERE outbox_id = ? AND conversation_id = ? AND deleted_at IS NULL AND chat_id IS NULL", ob.id, conversationId) : null;
}

/**
 * What a history row's quote line says — `{ id, who, text }` of the message it answers — or null for
 * an ordinary line, or one whose parent this install never kept (sent before handles were, or a
 * message Reason never saw): no quote rather than a wrong one.
 */
export function quoteFor(conversationId, row) {
  const handle = parentHandleOf(conversationId, row);
  if (!handle) return null;
  const parent = rowByHandle(conversationId, handle);
  if (!parent || parent.id === row.id) return null;
  const text = quoteWords(parent);
  if (!text) return null;
  return { id: parent.id, who: parent.role === "user" ? "YOU" : "REASON", text };
}

/** Can a reply be put under this row? Only a message with a handle (a draft, a fold, a Web-only chat's line cannot). */
export function canReplyTo(conversationId, row) {
  if (row.chat_id) return false;
  if (row.role === "user") return !!row.external_id;
  // Reason's line only once it really went out with a handle (handleOfRow), so Reply never offers a pin that cannot be.
  return !!row.outbox_id && !!one("SELECT 1 AS x FROM outbox WHERE id = ? AND conversation_id = ? AND state = 'sent' AND message_id IS NOT NULL", row.outbox_id, conversationId);
}

/** The reply arrow: one stroke, the ink of whatever it sits in. */
export const REPLY_SVG = `<svg class="rp-i" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/></svg>`;

/** The quote line over a reply: who, and their words, muted; a link to the message (the page scrolls to it when it is drawn). */
export function quoteHtml(q) {
  const id = Number(q.id);
  return `<a class="rq" href="/web?thread&amp;at=${id}#m-${id}" data-to="${id}" aria-label="In reply to ${q.who === "YOU" ? "you" : "Reason"}: ${esc(q.text)}. Go to that message"><span class="rq-w" aria-hidden="true">${REPLY_SVG}${q.who}</span><span class="rq-t" aria-hidden="true">${esc(q.text)}</span></a>`;
}

/** The Reply button, at the end of a line's label: shown on hover, focus, or a tap where there is no hover. */
export const REPLY_BUTTON = `<button class="rp" type="button" aria-label="Reply to this message">${REPLY_SVG}<span class="rp-w">REPLY</span></button>`;

/** Above the composer: which message the next send answers, and a way not to. Filled by the page's script. */
export const REPLY_CHIP = `<div class="rchip" hidden><span class="rc-w">${REPLY_SVG}<span class="rc-who">REPLYING TO</span></span><span class="rc-t"></span><button class="rc-x" type="button" aria-label="Cancel the reply (Esc)"><span aria-hidden="true">×</span></button><span class="sr rc-say" role="status" aria-live="polite"></span></div>`;

export const REPLY_CSS = `
.msg{position:relative}
.rp{position:absolute;margin:-12px 0 0 6px;min-height:40px;min-width:40px;padding:0 6px;border:0;background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;color:var(--muted);font:400 10px/1 var(--mono);letter-spacing:.14em;opacity:0;pointer-events:none;transition:opacity .15s ease,color .15s ease}
.you .rp{right:100%;margin:-12px 6px 0 0}
.rp:hover,.rp:focus-visible{color:var(--pen)}
.rp:focus-visible{opacity:1;pointer-events:auto}
@media (hover:hover){.msg:hover>.lbl .rp,.msg:focus-within>.lbl .rp{opacity:1;pointer-events:auto}}
.msg.rp-on>.lbl .rp{opacity:1;pointer-events:auto;color:var(--pen)}
@media (hover:none){.rp-w{display:none}.msg.you,.msg.re{-webkit-touch-callout:none}}
.rq{display:flex;flex-direction:column;gap:3px;max-width:min(34em,100%);padding:2px 0 2px 12px;border-left:1.5px solid var(--hair);text-decoration:none;color:var(--muted)}
.you .rq{align-self:flex-end;align-items:flex-end;text-align:right;padding:2px 12px 2px 0;border-left:0;border-right:1.5px solid var(--hair)}
.rq:hover{color:var(--ink);border-color:var(--pen)}
.rq-w{display:inline-flex;align-items:center;gap:6px;font:400 10px/1.3 var(--mono);letter-spacing:.14em}
.rq-w .rp-i{color:var(--pen)}
.you .rq-w .rp-i{transform:scaleX(-1)}
.rq-t{font-size:14px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.msg.lit{animation:rlit 1.8s ease-out}
@keyframes rlit{0%,35%{background:var(--deep);box-shadow:0 0 0 10px var(--deep)}100%{background:transparent;box-shadow:0 0 0 10px transparent}}
@media (prefers-reduced-motion:reduce){.msg.lit{animation:none;outline:1px dashed var(--pen);outline-offset:8px}.rp{transition:none}}
.rchip{display:flex;align-items:center;gap:10px;margin:0 0 6px;padding:4px 0 4px 12px;border-left:1.5px solid var(--pen);min-width:0}
.rchip[hidden]{display:none}
.rc-w{flex:none;display:inline-flex;align-items:center;gap:6px;font:400 10px/1.3 var(--mono);letter-spacing:.14em;color:var(--muted)}
.rc-w .rp-i{color:var(--pen)}
.rc-t{flex:1;min-width:0;font:italic 400 16px/1.3 var(--serif);color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-x{flex:none;width:40px;height:40px;margin:-8px -10px -8px 0;border:0;background:transparent;cursor:pointer;color:var(--muted);font:400 18px/1 var(--mono);display:grid;place-items:center;border-radius:3px}
.rc-x:hover{color:var(--pen)}
`;

/**
 * The page's part (thread only): the buttons, the composer line, Esc, the quote line's jump. It hands
 * the thread's own script two things on REASON_WEB — `rp()` takes the reply being written (and clears
 * the line), `rqLine(q)` draws a quote for a line still sending — and nothing else; the message itself
 * goes through the thread's one send, under the same id, so a retry or a reload is still one message.
 */
export const REPLY_JS = `(function(){
var R=window.REASON_WEB,list=document.querySelector('.thread'),box=document.getElementById('c-input'),chip=document.querySelector('.rchip');if(!R||!list||!box||!chip)return;
var who=chip.querySelector('.rc-who'),txt=chip.querySelector('.rc-t'),say=chip.querySelector('.rc-say'),x=chip.querySelector('.rc-x'),cur=null,calm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches,touch=window.matchMedia&&matchMedia('(hover: none)').matches;
function short(t){t=String(t||'').replace(/\\s+/g,' ').trim();return t.length>${QUOTE_MAX}?t.slice(0,${QUOTE_MAX - 1}).replace(/\\s+$/,'')+'\\u2026':t}
function words(li){var w=li.querySelector(':scope>.said,:scope>.rsay');var t=w?w.textContent:'';if(!t.trim()){var s=li.querySelector('.slip');t=s?s.textContent:li.querySelector('.photo')?'a photo':li.querySelector('.play,audio')?'a voice note':''}return short(t)}
function pick(li){if(!li||!li.dataset.id)return;cur={id:li.dataset.id,who:li.classList.contains('you')?'YOU':'REASON',text:words(li)};who.textContent='REPLYING TO '+(cur.who==='YOU'?'YOU':'REASON');txt.textContent=cur.text;chip.hidden=false;say.textContent='Replying to '+(cur.who==='YOU'?'your':"Reason's")+' message: '+cur.text+'. Escape cancels.';list.querySelectorAll('.rp-on').forEach(function(o){o.classList.remove('rp-on')});box.focus()}
function clear(focus){cur=null;chip.hidden=true;txt.textContent='';say.textContent='';if(focus)box.focus()}
R.rp=function(){var c=cur;if(c)clear();return c};
R.rqLine=function(q){var a=document.createElement('a');a.className='rq';a.href='/web?thread&at='+q.id+'#m-'+q.id;a.dataset.to=q.id;var w=document.createElement('span');w.className='rq-w';var ic=chip.querySelector('.rp-i');if(ic)w.appendChild(ic.cloneNode(true));w.appendChild(document.createTextNode(q.who));var t=document.createElement('span');t.className='rq-t';t.textContent=q.text;a.appendChild(w);a.appendChild(t);return a};
function go(id){var t=list.querySelector('.msg[data-id="'+id+'"]')||list.querySelector('[data-ids~="'+id+'"]');if(!t)return false;t.scrollIntoView({block:'center',behavior:calm?'auto':'smooth'});t.classList.remove('lit');void t.offsetWidth;t.classList.add('lit');setTimeout(function(){t.classList.remove('lit')},2000);return true}
x.addEventListener('click',function(){clear(true)});
// Esc is the open sheet's or the recording's first (src/pages/webcompose.js); the reply line is cancelled only when neither is up.
document.addEventListener('keydown',function(e){if(e.key!=='Escape'||!cur||e.defaultPrevented)return;if(document.querySelector('.addsheet:not([hidden])')||document.querySelector('.composer.dictating')||document.body.classList.contains('listening'))return;e.preventDefault();clear(true)});
list.addEventListener('click',function(e){var t=e.target;if(!t.closest)return;var b=t.closest('.rp');if(b&&list.contains(b)){e.preventDefault();pick(b.closest('.msg'));return}
var q=t.closest('.rq');if(q&&list.contains(q)){if(go(q.dataset.to))e.preventDefault();return}
if(!touch||t.closest('a,button,audio,input,textarea'))return;var li=t.closest('.msg');if(!li||!li.querySelector(':scope>.lbl .rp'))return;var on=li.classList.contains('rp-on');list.querySelectorAll('.rp-on').forEach(function(o){o.classList.remove('rp-on')});if(!on)li.classList.add('rp-on')});
var lp=null,lpd=false;function lpStop(){if(lp){clearTimeout(lp);lp=null}}
list.addEventListener('touchstart',function(e){lpd=false;var li=e.target.closest&&e.target.closest('.msg');if(!li||!li.querySelector(':scope>.lbl .rp')||e.target.closest('a,button,audio'))return;lpStop();lp=setTimeout(function(){lp=null;lpd=true;if(navigator.vibrate)try{navigator.vibrate(8)}catch(x){}pick(li)},480)},{passive:true});
list.addEventListener('touchmove',lpStop,{passive:true});list.addEventListener('touchend',function(e){lpStop();if(lpd){e.preventDefault();lpd=false}});list.addEventListener('touchcancel',lpStop);
list.addEventListener('contextmenu',function(e){if(lpd)e.preventDefault()});
})();`;
