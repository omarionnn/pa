// Reason Web's loading states for the app screens (v2 handoff §4d, reference sheet-loading-app L3–L5).
//
// The rule: no spinners and no grey shimmer. Where content is coming, faint ruled lines in the
// border colour sit in its place, keeping the real layout (headings where headings will be, a card
// where the card will be), and a typed status (role=status) says what is happening. If it is slow
// (over ~8 s) a Caveat line says so honestly, with Try again → and BACK TO CHAT. If it fails, the
// global error (9B) takes the page.
//
// Where it shows: moving between Web screens whose content the server has to gather. The Ongoing
// tab (L3) and one row's detail (L4) are opened in place: the screen is drawn at once from what the
// page already knows (the group headings and how many rows each has; a row's title and status),
// the real page is FETCHED, and when it arrives it replaces the drawn one, scripts and all. Nothing
// here waits on a timer except the 8 s "still looking": the lines stay exactly as long as the real
// request takes. Without script every link is an ordinary link and the server draws the page.
//
// Which links: the Ongoing tab, a row's detail, Saved, Ongoing's See all pages, or any link that opts in with
// data-load="ongoing|detail|list" (a list also takes data-title). Reduced motion: lines are still.

/** After this long a loading screen says it is taking a while (§4d L5). */
export const SLOW_MS = 8000;

export const LOAD_COPY = {
  ongoing: "GATHERING WHAT’S IN HAND…",
  detail: "PUTTING THE SUMMARY TOGETHER…",
  list: "LOOKING…",
  slow: "STILL LOOKING…",
  slowNote: "taking a little longer than usual. still here.",
};

export const LOAD_CSS = `
.ld{flex:1 0 auto;width:100%;padding:28px var(--gut) 20px;display:flex;flex-direction:column;gap:30px}
.ld-head{display:flex;flex-direction:column;gap:6px}
.ld .h1{font-size:40px;line-height:1.06}
.ld .lbl{font-size:11px;white-space:normal}
.ld-sec{display:flex;flex-direction:column}
.ld-sec>.lbl{margin:0 0 4px}
.ld-card{background:var(--lifted);border:1px solid var(--hair);border-radius:4px;box-shadow:var(--sh);padding:20px}
.ld-row{padding:18px 0;border-bottom:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:center;gap:16px}
.ld-row .ln{height:2px}.ld-row .ln.r{width:46px;height:1px;flex:none}
.ld-lines{display:flex;flex-direction:column;align-items:flex-start;gap:12px;width:100%}
.ld-lines.wide{gap:16px}
.ln{display:block;height:2px;background:var(--hair)}
${[30, 40, 48, 50, 55, 62, 70, 80, 85, 90, 95, 100].map(w => `.ln.w${w}{width:${w}%}`).join("")}
.ld-lines,.ld-row,.ld-rule{animation:ld-fade 1.6s ease-in-out infinite alternate}
@keyframes ld-fade{from{opacity:1}to{opacity:.5}}
.ld-d{max-width:720px;margin:0 auto;gap:24px}
.ld-d .h1{font-size:38px}
.ld-d .h1:empty{display:none}
.ld-rule{border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:18px 0}
.ld-rule .ln{width:100%;height:1px}
.ld-top{padding:20px var(--gut) 14px}
.ld-h{padding:16px var(--gut) 0;max-width:720px;width:100%;margin:0 auto}
.ld-h .act2{font-size:12px}
.ld-slow{display:flex;flex-direction:column;gap:22px}
.ld-slow .hand{font-size:22px;line-height:1.2;transform:rotate(-1deg);transform-origin:left center}
.ld-acts{display:flex;gap:26px;align-items:center;flex-wrap:wrap}
.ld-acts .act{font-size:22px;min-height:48px}
.ld-acts .act2{font-size:11.5px}
.ld-err{flex:1 0 auto;width:100%;max-width:640px;margin:0 auto;padding:40px 32px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.ld-err .quiet{margin:0;font-size:16px;line-height:1.55;color:var(--muted)}
@media (min-width:900px){.ld{padding:36px clamp(20px,4vw,48px) 24px}.ld-d .h1{font-size:56px}.ld-err .h1{font-size:64px}}
@media (prefers-reduced-motion:reduce){.ld-lines,.ld-row,.ld-rule{animation:none}}
`;

// The client half. Guarded so a page swapped in (its own copy of this script runs) never doubles up.
export const loadJs = (wordmarkHtml) => `(function(){if(window.reasonLoad||!window.__reasonPage||!window.fetch||!window.DOMParser||!history.pushState)return;
var P=window.__reasonPage,C=${JSON.stringify(LOAD_COPY)},LIST={'/web/saved':'Saved','/web/ongoing/hand':'In hand','/web/ongoing/back':'Back to you'},WM=${JSON.stringify(String(wordmarkHtml)).replace(/</g, "\\u003c")},SLOW=${SLOW_MS},ctl=null,slowT=0,shown=location.pathname+location.search;
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function ln(w,cls){return el('span','ln'+(w?' w'+w:'')+(cls?' '+cls:''))}
function lines(ws,wide){var d=el('div','ld-lines'+(wide?' wide':''));d.setAttribute('aria-hidden','true');ws.forEach(function(w){d.appendChild(ln(w))});return d}
function ghostRow(w){var r=el('div','ld-row');r.setAttribute('aria-hidden','true');r.appendChild(ln(w));r.appendChild(ln('','r'));return r}
function kindOf(a){var k=a.getAttribute('data-load');if(k)return k;var u;try{u=new URL(a.href,location.href)}catch(e){return''}
if(u.origin!==location.origin)return'';if(u.pathname==='/web'&&u.searchParams.get('tab')==='ongoing')return'ongoing';
if(/^\\/web\\/ongoing\\/(approval|task|timer|series)\\/\\d{1,12}$/.test(u.pathname))return'detail';if(u.pathname==='/web/saved'||/^\\/web\\/ongoing\\/(hand|back)$/.test(u.pathname))return'list';return''}
// What the page already knows about Ongoing: each group's heading (with its count) and how many rows it shows.
function groups(){var og=document.getElementById('og'),out=[];
if(og)og.querySelectorAll('.og-sec').forEach(function(s){var h=s.querySelector('h2,h3');if(!h)return;out.push({t:h.textContent,pen:h.classList.contains('pen'),cards:s.querySelectorAll('.appr,.og-vc').length,rows:s.querySelectorAll('.og-row,.ogv').length})});
if(!og&&document.querySelector('.appr,.og-vc'))out.push({t:'NEEDS YOU',pen:true,cards:1,rows:0});
if(!og)out.push({t:'IN HAND',pen:false,cards:0,rows:3});return out}
var STATE={approval:'NEEDS YOUR APPROVAL',working:'WORKING ON IT',needs:'WAITING ON YOU',stuck:'STUCK',ready:'READY',failed:"DIDN'T WORK",scheduled:'SCHEDULED'};
// What a row link says about the page it opens: its status, and its title.
function known(a){var card=a.closest('.appr,.og-vc'),row=a.closest('[data-state]')||a,t='',s='',pen=false;
if(card){var at=card.querySelector('.appr-t,.ogv-t');t=at?at.textContent:'';s=STATE.approval;pen=true}
else{var b=row.querySelector('.og-top b,.ogv-t,b,.t');t=b?b.textContent:'';var st=row.getAttribute('data-state'),l=row.querySelector('.lbl');s=STATE[st]&&st!=='waiting'?STATE[st]:(l?l.textContent:'');pen=st==='needs'}
return{t:t,s:s,pen:pen,title:a.getAttribute('data-title')||''}}
function status(text){var p=el('p','lbl','');p.setAttribute('role','status');p.textContent=text;return p}
function draw(k,info){var main=el('main','ld'),st;
document.querySelectorAll('.og-back,.netline,.ls,.needs-yes').forEach(function(x){x.remove()});
if(k==='detail'){main.className='ld ld-d';var h=document.querySelector('header');var nh=el('header','ld-h');var b=el('a','act2','\\u2190 ONGOING');b.href='/web?tab=ongoing';nh.appendChild(b);if(h)h.replaceWith(nh);else document.body.insertBefore(nh,document.body.firstChild);
var lb=el('p','lbl'+(info.pen?' pen':''),info.s);if(info.s)main.appendChild(lb);main.appendChild(el('h1','h1',info.t));st=status(C.detail);main.appendChild(st);
var r=el('div','ld-rule');r.setAttribute('aria-hidden','true');r.appendChild(ln(100));main.appendChild(r);main.appendChild(lines([90,95,70,85,40],true));
document.querySelectorAll('.tabs,.composer,.ogd-foot').forEach(function(x){x.remove()});document.body.classList.remove('has-tabs')}
else{var hd=el('div','ld-head');hd.appendChild(el('h1','h1',k==='ongoing'?'Ongoing':(info.title||'')));st=status(k==='ongoing'?C.ongoing:C.list);hd.appendChild(st);main.appendChild(hd);
(k==='ongoing'?info:[{t:'',rows:2}]).forEach(function(g){var s=el('section','ld-sec');if(g.t){var h2=el('h2','lbl'+(g.pen?' pen':''),g.t);s.appendChild(h2)}
for(var i=0;i<Math.min(g.cards,3);i++){var c=el('div','ld-card');c.setAttribute('aria-hidden','true');c.appendChild(lines([80,50,30]));s.appendChild(c)}
[62,48,55].slice(0,Math.min(g.rows,Math.max(0,3-g.cards))).forEach(function(w){s.appendChild(ghostRow(w))});main.appendChild(s)});
document.querySelectorAll('.tabs a').forEach(function(t){var on=kindOf(t)===k;if(on)t.setAttribute('aria-current','page');else t.removeAttribute('aria-current')});
document.querySelectorAll('.composer,.ogd-foot').forEach(function(x){x.remove()});if(document.querySelector('.tabs'))document.body.classList.add('has-tabs');
if(!document.querySelector('.top')){var oh=document.querySelector('header'),th=el('header','top ld-top');th.innerHTML=WM;if(oh)oh.replaceWith(th);else document.body.insertBefore(th,document.body.firstChild)}}
var old=document.querySelector('main');if(old)old.replaceWith(main);else document.body.appendChild(main);
document.querySelectorAll('body>main~main').forEach(function(x){x.remove()});window.scrollTo(0,0);main.st=st;return main}
function slow(main,url,k,info){if(!main.isConnected||main.querySelector('.ld-slow'))return;main.st.textContent=C.slow;
var w=el('div','ld-slow');w.appendChild(el('p','hand',C.slowNote));var acts=el('div','ld-acts');
var again=el('button','act','Try again ');again.type='button';var ar=el('span','','\\u2192');ar.setAttribute('aria-hidden','true');again.appendChild(ar);
again.onclick=function(){w.remove();main.st.textContent=k==='detail'?C.detail:k==='ongoing'?C.ongoing:C.list;load(main,url,k,info)};
var back=el('a','act2','BACK TO CHAT');back.href='/web?thread';back.onclick=function(){if(ctl)ctl.abort()};
acts.appendChild(again);acts.appendChild(back);w.appendChild(acts);main.appendChild(w)}
function failed(main,url){if(!main.isConnected)return;P.cancel(slowT);var m=el('main','ld-err');
var h=el('h1','h1','Something went wrong.');h.appendChild(document.createElement('br'));h.appendChild(el('em','','Nothing was lost.'));m.appendChild(h);
var q=el('p','quiet',"Your messages and anything I'm working on are safe.");m.appendChild(q);var a=el('a','act','Try again ');a.href=url;var ar=el('span','','\\u2192');ar.setAttribute('aria-hidden','true');a.appendChild(ar);m.appendChild(a);
var r=el('p','sr','Something went wrong.');r.setAttribute('role','alert');m.appendChild(r);main.replaceWith(m)}
// The real page, in place of the drawn one: its title, its stylesheet, its body and its script. The page
// being left is ended first (webkit PAGE_JS): its intervals, timeouts, streams and listeners stop.
function swap(html){var d=new DOMParser().parseFromString(html,'text/html');document.title=d.title;
var ns=d.head.querySelector('style'),os=document.head.querySelector('style');if(ns&&os)os.textContent=ns.textContent;
document.body.className=d.body.className;var code=[];
Array.prototype.slice.call(document.body.childNodes).forEach(function(n){n.remove()});
Array.prototype.slice.call(d.body.childNodes).forEach(function(n){if(n.nodeName==='SCRIPT'){code.push(n.textContent);return}document.body.appendChild(document.adoptNode(n))});
P.end();code.forEach(function(t){var s=document.createElement('script');s.textContent=t;document.body.appendChild(s)});
window.scrollTo(0,0);var f=document.querySelector('main h1')||document.querySelector('main');if(f){if(!f.hasAttribute('tabindex'))f.setAttribute('tabindex','-1');try{f.focus({preventScroll:true})}catch(e){}}}
function load(main,url,k,info){if(ctl)ctl.abort();ctl=window.AbortController?new AbortController():null;var mine=ctl;P.cancel(slowT);slowT=P.later(function(){slow(main,url,k,info)},SLOW);
fetch(url,{credentials:'same-origin',redirect:'manual',headers:{Accept:'text/html'},signal:mine?mine.signal:undefined}).then(function(r){
if(r.type==='opaqueredirect'||r.status===0||(r.status>=300&&r.status<400)||r.status===401){P.cancel(slowT);location.href=url;return}
return r.text().then(function(t){if(mine!==ctl)return;P.cancel(slowT);if(!/^<!doctype html>/i.test(t.trim()))return failed(main,url);swap(t)})})
.catch(function(e){if(e&&e.name==='AbortError')return;failed(main,url)})}
function go(a,k){var info=k==='detail'?known(a):k==='ongoing'?groups():{title:a.getAttribute('data-title')||LIST[new URL(a.href,location.href).pathname]||''},url=new URL(a.href,location.href).href;
var main=draw(k,info);history.pushState({reasonLoad:1},'',url);shown=location.pathname+location.search;load(main,url,k,info)}
P.on(document,'click',function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a||a.target||a.hasAttribute('download')||a.getAttribute('aria-current')==='page')return;
var k=kindOf(a);if(!k)return;e.preventDefault();go(a,k)});
// Back and forward: the page for that address, drawn by the server. A fragment (the skip link) is not a page.
P.on(window,'popstate',function(){if(location.pathname+location.search!==shown)location.replace(location.href)});
window.reasonLoad={go:go,kindOf:kindOf}})();`;
