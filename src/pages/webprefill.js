// Reason Web: a link that hands the composer some words (`/web?draft=<text>&from=<where>`), for the
// /updates "tear-off pad" on heyreason.com (owner handoff 10-31). The words land in the composer,
// focused, cursor at the end — typed in two characters every 24 ms, or all at once for reduced
// motion — and the address loses `draft`/`from`. NOTHING IS EVER SENT: the person presses send.
//
//   - Plain text only: control and invisible characters out, ~500 characters at most, set as the
//     textarea's .value (never markup). The server never draws it into the page at all.
//   - Words already in the composer are kept: the draft goes under them on a new line.
//   - Signed out: kept in this tab (sessionStorage) through the sign-in; the sign-in forms are told
//     to land on the thread (`next=thread`), and the thread's composer takes it there.
//   - Logged: `draft_prefilled` when a /web address arrives with one, `draft_sent` when the message
//     it became is sent — `from` only, a short token, never the words.

/** At most this many characters (code points) of a draft are kept. */
export const DRAFT_MAX = 500;
/** `from` is a short safe token ("updates-events"), or not kept at all. */
export const FROM_RE = /^[a-z0-9-]{1,40}$/;
/** Where a draft waits in this tab until a composer takes it (sign-in, the first-visit note). */
export const DRAFT_KEY = "reason-web-draft";
/** A draft not taken within this long is dropped. */
export const DRAFT_TTL_MS = 60 * 60_000;

/**
 * A draft as plain text: line breaks normalised, tabs to spaces, control / invisible / bidi
 * characters dropped, at most three lines' worth of blank lines, trimmed, cut to `max` code points.
 * Plain ES5 so the page runs this very function (DRAFT_JS).
 */
export function cleanDraft(raw, max) {
  var t = String(raw == null ? "" : raw)
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g, "")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  var a = Array.from(t);
  return a.length > max ? a.slice(0, max).join("").trim() : t;
}

/** `from` if it is a safe token, else "". */
export function fromToken(raw) {
  const s = String(raw ?? "");
  return FROM_RE.test(s) ? s : "";
}

/** What GET /web logs for an address that carries a draft, or null when it carries none. Never the words. */
export function prefillLog(query = {}, { signedIn = false } = {}) {
  if (query.draft == null) return null;
  const chars = Array.from(cleanDraft(query.draft, DRAFT_MAX)).length;
  if (!chars) return null;
  return { draft_prefilled: fromToken(query.from) || "none", signed_in: !!signedIn, chars };
}

/** The page's part, on every Web page (webkit webPage). Runs after the page's own scripts. */
export const DRAFT_JS = String.raw`(function(){try{
var clean=${cleanDraft.toString()},K='${DRAFT_KEY}',M=${DRAFT_MAX},F=${FROM_RE},TTL=${DRAFT_TTL_MS},L=location,H=document.documentElement,p=null;
function fill(box,t,f){if(!t)return;var max=box.maxLength>0?box.maxLength:4000,have,start,goal;
function aim(){have=box.value.replace(/\s+$/,'');start=have?have+'\n':'';goal=Array.from(start+t).slice(0,max).join('')}aim();if(goal===have)return;
function put(v){box.value=v;box.dispatchEvent(new Event('input',{bubbles:true}));try{box.setSelectionRange(v.length,v.length)}catch(e){}box.scrollTop=box.scrollHeight}
function mark(){box.dataset.df=f||'none';box.addEventListener('input',function cl(){if(!box.value.trim()){delete box.dataset.df;box.removeEventListener('input',cl)}})}
function go(){aim();try{box.focus({preventScroll:true})}catch(e){box.focus()}
if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches){put(goal);mark();return}
var cs=Array.from(goal.slice(start.length)),i=0,done=false,tm;put(start);
function end(){if(done)return;done=true;clearInterval(tm);removeEventListener('keydown',end,true);removeEventListener('submit',end,true);box.removeEventListener('blur',end);put(goal);mark()}
addEventListener('keydown',end,true);addEventListener('submit',end,true);box.addEventListener('blur',end);
tm=setInterval(function(){i=Math.min(cs.length,i+2);put(start+cs.slice(0,i).join(''));if(i>=cs.length)end()},24)}
if(!H.classList.contains('loading'))return go();
var w0=Date.now(),w=setInterval(function(){if(!H.classList.contains('loading')||Date.now()-w0>3000){clearInterval(w);go()}},60)}
function ss(){try{return window.sessionStorage}catch(e){return null}}
var q=new URLSearchParams(L.search);
if(q.has('draft')||q.has('from')){var d=clean(q.get('draft'),M),f=q.get('from')||'';if(!F.test(f))f='';
if(d){p={t:d,f:f,at:Date.now()};try{ss().setItem(K,JSON.stringify(p))}catch(e){}}
var rest=L.search.replace(/^\?/,'').split('&').filter(function(x){var k=x.split('=')[0];try{k=decodeURIComponent(k.replace(/\+/g,' '))}catch(e){}return x&&k!=='draft'&&k!=='from'}).join('&');
try{history.replaceState(history.state,'',L.pathname+(rest?'?'+rest:'')+L.hash)}catch(e){}}
if(!p){try{p=JSON.parse(ss().getItem(K)||'null')}catch(e){p=null}}
if(!p||!p.t||!(Date.now()-(p.at||0)<TTL)){try{ss().removeItem(K)}catch(e){}return}
var box=document.getElementById('c-input');
if(box&&!box.disabled&&box.form){try{ss().removeItem(K)}catch(e){}fill(box,clean(p.t,M),F.test(p.f||'')?p.f:'');return}
var sf=document.querySelectorAll('form[action="/web/signin"],form[action="/web/code"]');
if(sf.length){Array.prototype.forEach.call(sf,function(fm){if(fm.querySelector('input[name="next"]'))return;var i=document.createElement('input');i.type='hidden';i.name='next';i.value='thread';fm.appendChild(i)});return}
if(L.pathname==='/web'&&document.querySelector('a[href="/web?thread"]'))L.replace('/web?thread');
}catch(e){}})();`;
