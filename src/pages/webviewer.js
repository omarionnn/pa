// Reason Web: opening what is on a line without leaving Reason. 2026-10-31, Omari: a tap on a photo
// in the thread took the whole tab to /web/media/m/1611/0, a black browser page with the picture
// stuck small in the corner and no way back but the back button.
//
// Now a photo, a PDF, a video, a recording or a text file opens in a viewer over the thread: on the
// warm paper, the thing itself in the middle in its paper frame, who sent it and when in the mono
// eyebrow, the words that came with it in the serif underneath. Left and right (keys, the arrows, a
// swipe) walk every photo in the thread; Esc, the ×, a tap beside it or a swipe down close it, and
// focus goes back to the photo it came from. Anything a browser can't show here (a .docx, a sheet, a
// HEIC this machine could not turn into a JPEG) is a file card with its name, size and Download.
//
// The thread's links keep their real addresses, so a new tab, a long-press or a page with no script
// still gets the file (/web/media/…, signed in, this conversation only, src/webmedia.js). Every
// word on the viewer is set with textContent; nothing here builds markup from a message.

/** What the viewer does with a file, by its type or its name: image, pdf, video, audio, text or file. */
export function viewOf(name = "", mime = "") {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(String(name ?? ""))?.[1] ?? "").toLowerCase();
  const t = String(mime ?? "").toLowerCase();
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(t) || /^(png|jpe?g|gif|webp|heic|heif)$/.test(ext)) return "image";
  if (t.startsWith("video/") || /^(mp4|mov|m4v|webm)$/.test(ext)) return "video";
  if (t.startsWith("audio/") || /^(mp3|m4a|wav|aac|ogg|opus)$/.test(ext)) return "audio";
  if (/^text\/(plain|markdown|csv)/.test(t) || /^(txt|md|csv|log)$/.test(ext)) return "text";
  return "file";
}

/**
 * The address a picture is SHOWN from: the same file, except a HEIC (what an iPhone shoots), which
 * the server hands over as a JPEG for this (`?as=jpeg`, src/webmedia.js) — Chrome draws no HEIC.
 * The link itself keeps the original, so Download still gets the photo as it was sent.
 */
export function viewSrc(src, name = "") {
  if (!src || /^blob:/.test(src)) return src || "";
  return /\.hei[cf]$/i.test(String(name ?? "")) ? `${src}${src.includes("?") ? "&" : "?"}as=jpeg` : src;
}

const X_SVG = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const DL_SVG = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`;
const OPEN_SVG = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>`;
const PREV_SVG = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`;
const NEXT_SVG = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`;
const DOC_SVG = `<svg class="vw-mark" aria-hidden="true" width="44" height="54" viewBox="0 0 30 36" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3 2h16l8 8v24H3z"/><path d="M19 2v8h8"/><text x="15" y="27" text-anchor="middle" font-size="7" font-family="ui-monospace,Menlo,monospace" letter-spacing=".5" fill="currentColor" stroke="none"></text></svg>`;

/** The viewer's fixed frame. No message reaches it as markup: the page's script fills it with textContent. */
const SHELL = `<div class="vw-top"><p class="lbl vw-h" id="vw-h"><span class="vw-what"></span></p>`
  + `<div class="vw-acts"><a class="vw-act vw-open" target="_blank" rel="noopener" hidden>${OPEN_SVG}<span class="vw-at">OPEN</span></a>`
  + `<a class="vw-act vw-dl" hidden>${DL_SVG}<span class="vw-at">DOWNLOAD</span></a>`
  + `<button class="vw-x" type="button" aria-label="Close">${X_SVG}</button></div></div>`
  + `<div class="vw-stage"><div class="vw-body"></div><p class="lbl vw-wait" aria-hidden="true">OPENING…</p></div>`
  + `<div class="vw-foot"><button class="vw-nav vw-prev" type="button" aria-label="Previous photo">${PREV_SVG}</button>`
  + `<div class="vw-mid"><p class="vw-cap"></p><p class="lbl vw-n"></p></div>`
  + `<button class="vw-nav vw-next" type="button" aria-label="Next photo">${NEXT_SVG}</button></div>`
  + `<p class="sr vw-live" aria-live="polite"></p>`;

/** A constant as a script string literal, with no `<` in it (no `</script>`, nothing that reads as markup). */
const js = (t) => JSON.stringify(t).replace(/</g, "\\u003c");

export const VIEWER_CSS = `
.msg .photo{position:relative;border-radius:4px;cursor:zoom-in}
.msg .photo img{border-radius:1px;transition:opacity .2s ease}
.msg .photo:focus-visible,.msg a.fchip:focus-visible{outline:2px solid var(--pen);outline-offset:3px}
.msg .photo.ld img{opacity:0}
.msg .photo.ld{animation:vw-pulse 1.3s ease-in-out infinite}
.msg .photo.bad img{display:none}
.msg .photo.bad::after{content:"PHOTO";position:absolute;inset:0;display:grid;place-items:center;font:400 10px/1 var(--mono);letter-spacing:.14em;color:var(--muted)}
@keyframes vw-pulse{50%{background:color-mix(in srgb,var(--photo) 70%,var(--lifted))}}
body.viewing{overflow:hidden}
.vw{position:fixed;inset:0;z-index:90;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--ground);color:var(--ink);padding:env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);outline:0}
.vw[hidden]{display:none}
.vw-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px calc(var(--gut) - 10px) 6px var(--gut);min-height:64px;border-bottom:1px dashed var(--hair)}
.vw-h{margin:0;min-width:0;font-size:11px;letter-spacing:.14em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-h b{font-weight:400;color:var(--ink)}
.vw-acts{display:flex;align-items:center;gap:2px;flex:none}
.vw-act{min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 10px;color:var(--ink);text-decoration:none;font:400 11.5px/1 var(--mono);letter-spacing:.14em;border-radius:3px}
.vw-act[hidden]{display:none}
.vw-act:hover,.vw-x:hover{color:var(--hov)}
.vw-x{width:44px;height:44px;border:0;background:transparent;color:var(--ink);display:grid;place-items:center;cursor:pointer;padding:0;border-radius:3px}
.vw :focus-visible{outline:1px dashed var(--pen);outline-offset:-3px}
.vw-stage{position:relative;min-height:0;display:grid;place-items:center;padding:14px var(--gut);overflow:hidden;touch-action:pinch-zoom}
.vw-body{display:grid;place-items:center;max-width:100%;max-height:100%;min-height:0;transform:translateY(var(--dy,0px)) scale(var(--sc,1))}
.vw-wait{position:absolute;inset:auto 0 50%;margin:0;text-align:center;font-size:10.5px;display:none}
.vw.wait .vw-wait{display:block}
.vw-img{display:block;max-width:calc(100vw - 2 * var(--gut) - env(safe-area-inset-left) - env(safe-area-inset-right));max-height:calc(100vh - 210px);max-height:calc(100dvh - 210px - env(safe-area-inset-top) - env(safe-area-inset-bottom));width:auto;height:auto;object-fit:contain;background:var(--lifted);border:6px solid var(--lifted);border-radius:4px;box-shadow:var(--shp);-webkit-user-select:none;user-select:none;-webkit-touch-callout:default}
.vw.wait .vw-img{visibility:hidden}
.vw-doc{display:block;width:min(calc(100vw - 2 * var(--gut)),920px);height:calc(100vh - 210px);height:calc(100dvh - 210px - env(safe-area-inset-top) - env(safe-area-inset-bottom));border:1px solid var(--hair);border-radius:4px;background:var(--lifted);box-shadow:var(--sh)}
.vw-text{margin:0;width:min(calc(100vw - 2 * var(--gut)),760px);max-height:calc(100vh - 210px);max-height:calc(100dvh - 210px - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow:auto;box-sizing:border-box;padding:22px 26px;background:var(--lifted);border:1px solid var(--hair);border-radius:4px;box-shadow:var(--sh);font:400 13.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);-webkit-overflow-scrolling:touch}
.vw-video{display:block;max-width:calc(100vw - 2 * var(--gut));max-height:calc(100vh - 210px);max-height:calc(100dvh - 210px - env(safe-area-inset-top) - env(safe-area-inset-bottom));border-radius:4px;background:var(--ink);box-shadow:var(--shp)}
.vw-card{width:min(calc(100vw - 2 * var(--gut)),380px);box-sizing:border-box;display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:26px 26px 18px;background:var(--lifted);border:1px solid var(--hair);border-radius:2px;box-shadow:var(--sh2);transform:rotate(-.4deg)}
.vw-card .vw-mark{color:var(--pen)}
.vw-cn{margin:4px 0 0;font:italic 400 26px/1.15 var(--serif);letter-spacing:-.01em;overflow-wrap:anywhere}
.vw-cf{margin:0;font-size:10.5px}
.vw-why{margin:6px 0 0;font-size:15px;line-height:1.5;color:var(--muted)}
.vw-card audio{width:100%;margin-top:6px}
.vw-get{min-height:48px;display:inline-flex;align-items:center;gap:8px;margin-top:4px;color:var(--ink);text-decoration:none;font:italic 400 24px/1 var(--serif)}
.vw-get span{font-style:normal}
.vw-get:hover{color:var(--hov)}
.vw-foot{display:grid;grid-template-columns:48px minmax(0,1fr) 48px;align-items:center;gap:12px;padding:8px calc(var(--gut) - 4px) calc(14px + env(safe-area-inset-bottom));min-height:72px}
.vw-mid{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;text-align:center}
.vw-cap{margin:0;max-width:34em;font:italic 400 19px/1.3 var(--serif);color:var(--ink);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.vw-cap:empty,.vw-n:empty{display:none}
.vw-n{margin:0;font-size:10.5px}
.vw-nav{width:48px;height:48px;border-radius:50%;border:1px solid var(--hair);background:var(--lifted);color:var(--ink);display:grid;place-items:center;cursor:pointer;padding:0;box-shadow:var(--sh)}
.vw-nav:disabled{opacity:.35;cursor:default;box-shadow:none}
.vw-nav[hidden]{visibility:hidden;display:grid}
.vw-nav:not(:disabled):hover{color:var(--hov)}
@media (min-width:760px){.vw-nav{position:absolute;top:50%;margin-top:-24px;width:52px;height:52px}.vw-prev{left:clamp(16px,3vw,40px)}.vw-next{right:clamp(16px,3vw,40px)}
.vw-mid{grid-column:2}.vw-stage{padding:18px 104px}.vw-img,.vw-video{max-width:calc(100vw - 220px)}.vw-h{font-size:12px}.vw-cap{font-size:21px}}
@media (max-width:520px){.vw-at{display:none}.vw-act{padding:0}}
@media (prefers-reduced-motion:no-preference){.vw-body,.vw-top,.vw-foot{transition:opacity .18s ease,transform .22s cubic-bezier(.2,.8,.2,1)}.vw:not(.on) .vw-body{--sc:.97;opacity:0}.vw:not(.on) .vw-top,.vw:not(.on) .vw-foot{opacity:0}.vw.drag .vw-body{transition:none}}
@media (prefers-reduced-motion:reduce){.msg .photo.ld{animation:none}}
`;

export const VIEWER_JS = String.raw`(function(){
if(window.reasonViewer)return;
var d=document,body=d.body,vw=null,ui={},items=[],at=0,opener=null,inerted=[],pushed=false,token=0,calm=function(){return !!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)};
function kind(name,mime){var e=(/\.([a-z0-9]{1,5})$/i.exec(String(name||''))||[])[1]||'';e=e.toLowerCase();var t=String(mime||'').toLowerCase();
if(t==='application/pdf'||e==='pdf')return 'pdf';if(/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(t)||/^(png|jpe?g|gif|webp|heic|heif)$/.test(e))return 'image';
if(/^video\//.test(t)||/^(mp4|mov|m4v|webm)$/.test(e))return 'video';if(/^audio\//.test(t)||/^(mp3|m4a|wav|aac|ogg|opus)$/.test(e))return 'audio';
if(/^text\/(plain|markdown|csv)/.test(t)||/^(txt|md|csv|log)$/.test(e))return 'text';return 'file'}
window.reasonViewKind=kind;
function el(t,c,txt){var e=d.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
// ---- the thread: photos get a loading state and a frame shaped to the picture ----
function shape(img){var a=img.closest&&img.closest('.msg .photo');if(!a)return;a.classList.remove('ld');
if(!img.naturalWidth){a.classList.add('bad');return}a.classList.remove('bad');if(a.classList.contains('choice'))return;
var h=a.clientHeight;if(!h)return;var r=img.naturalWidth/img.naturalHeight,w=Math.round(Math.max(h*0.75,Math.min(h*1.6,h*r))),cs=getComputedStyle(a);
a.style.width=(w+(cs.boxSizing==='border-box'?a.offsetWidth-a.clientWidth:0))+'px'}
function watch(root){(root||d).querySelectorAll('.msg .photo img').forEach(function(img){if(img.dataset.vw)return;img.dataset.vw='1';if(img.complete&&img.getAttribute('src'))shape(img);else img.closest('.photo').classList.add('ld')})}
d.addEventListener('load',function(e){var t=e.target;if(t&&t.tagName==='IMG'&&t.closest&&t.closest('.msg .photo'))shape(t)},true);
d.addEventListener('error',function(e){var t=e.target;if(t&&t.tagName==='IMG'&&t.closest&&t.closest('.msg .photo')){var a=t.closest('.photo');a.classList.remove('ld');a.classList.add('bad')}},true);
watch();if(window.MutationObserver)new MutationObserver(function(ms){for(var i=0;i<ms.length;i++)if(ms[i].addedNodes.length){watch();return}}).observe(body,{childList:true,subtree:true});
// ---- what is on a line, as the viewer shows it ----
function itemOf(a){var li=a.closest('.msg'),img=a.querySelector('img'),t=li&&li.querySelector('.lbl time'),cap=li&&li.querySelector(':scope>.said,:scope>.rsay');
var href=a.getAttribute('href')||'',k=a.dataset.view||(img?'image':kind(a.dataset.name||href));
return{a:a,kind:k,src:a.dataset.src||(img&&img.getAttribute('src'))||href,href:href,name:a.dataset.name||'',size:a.dataset.size||'',
who:li?(li.classList.contains('you')?'YOU':'REASON'):'',time:t?t.textContent.trim():'',cap:cap?cap.textContent.replace(/\s+/g,' ').trim().slice(0,240):''}}
function photos(){return Array.prototype.filter.call(d.querySelectorAll('.msg .photo'),function(p){return p.querySelector('img')})}
// ---- the viewer ----
function build(){vw=el('div','vw');vw.setAttribute('role','dialog');vw.setAttribute('aria-modal','true');vw.setAttribute('aria-labelledby','vw-h');vw.tabIndex=-1;vw.hidden=true;vw.innerHTML=${js(SHELL)};
['vw-what','vw-open','vw-dl','vw-x','vw-stage','vw-body','vw-prev','vw-next','vw-cap','vw-n','vw-live'].forEach(function(c){ui[c.slice(3)]=vw.querySelector('.'+c)});
ui.x.onclick=function(){close()};ui.prev.onclick=function(){go(-1)};ui.next.onclick=function(){go(1)};
ui.stage.addEventListener('click',function(e){if(e.target===ui.stage||e.target===ui.body)close()});
swipe();body.appendChild(vw)}
function what(it){return({image:'PHOTO',pdf:'PDF',video:'VIDEO',audio:'RECORDING',text:'TEXT FILE',file:'FILE'})[it.kind]||'FILE'}
function ext(it){return((/\.([a-z0-9]{1,5})$/i.exec(it.name||'')||[])[1]||'').toUpperCase()}
function card(it,why){var c=el('div','vw-card');c.insertAdjacentHTML('afterbegin',${js(DOC_SVG)});var tx=c.querySelector('text');if(tx)tx.textContent=ext(it).slice(0,4);
c.appendChild(el('p','vw-cn',it.name||'File'));var f=[ext(it)||'FILE',it.size].filter(Boolean).join(' · ');c.appendChild(el('p','lbl vw-cf',f));
c.appendChild(el('p','vw-why',why||'This one opens in its own app.'));
if(it.href&&!/^blob:/.test(it.href)){var g=el('a','vw-get');g.href=it.href;g.setAttribute('download',it.name||'');g.textContent='Download it ';g.appendChild(el('span',null,'→'));c.appendChild(g)}
else c.appendChild(el('p','lbl vw-cf','NOT KEPT HERE'));return c}
function done(n){if(n===token)vw.classList.remove('wait')}
function show(i){at=i;var it=items[i],n=++token;ui.body.textContent='';vw.classList.add('wait');vw.dataset.kind=it.kind;
ui.what.textContent='';ui.what.appendChild(el('b',null,what(it)));var by=[it.who,it.time].filter(Boolean).join(' · ');if(by)ui.what.appendChild(d.createTextNode(' · '+by));
ui.cap.textContent=it.kind==='image'?it.cap:it.kind==='file'||it.kind==='audio'?'':(it.name||it.cap);
var many=items.length>1;ui.prev.hidden=ui.next.hidden=!many;ui.prev.disabled=i===0;ui.next.disabled=i===items.length-1;ui.n.textContent=many?(i+1)+' OF '+items.length:'';
var real=it.href&&!/^blob:/.test(it.href);ui.dl.hidden=!real;if(real){ui.dl.href=it.href;ui.dl.setAttribute('download',it.name||'');ui.dl.setAttribute('aria-label','Download '+(it.name||what(it).toLowerCase()))}
ui.open.hidden=!(real&&(it.kind==='pdf'||it.kind==='text'));if(!ui.open.hidden){ui.open.href=it.href;ui.open.setAttribute('aria-label','Open '+(it.name||'it')+' in a new tab')}
var fail=function(why){if(n!==token)return;ui.body.textContent='';ui.body.appendChild(card(it,why));done(n)};
if(it.kind==='image'){var im=el('img','vw-img');im.alt=it.cap||(it.who==='YOU'?'Photo you sent':'Photo from Reason');im.decoding='async';im.onload=function(){done(n)};im.onerror=function(){fail('This photo can’t be shown here. Download it to see it.')};im.src=it.src;ui.body.appendChild(im);if(im.complete&&im.naturalWidth)done(n);
[items[i+1],items[i-1]].forEach(function(o){if(o&&o.kind==='image'){var p=new Image();p.src=o.src}})}
else if(it.kind==='pdf'){var f=el('iframe','vw-doc');f.title=it.name||'PDF';f.onload=function(){done(n)};f.src=it.src;ui.body.appendChild(f);setTimeout(function(){done(n)},2500)}
else if(it.kind==='video'){var v=el('video','vw-video');v.controls=true;v.playsInline=true;v.setAttribute('playsinline','');v.preload='metadata';v.onloadedmetadata=function(){done(n)};v.onerror=function(){fail('This browser can’t play this video. Download it to watch.')};v.src=it.src;ui.body.appendChild(v)}
else if(it.kind==='audio'){var c=card(it,'');var w=c.querySelector('.vw-why');if(w)w.remove();var au=el('audio');au.controls=true;au.preload='metadata';au.src=it.src;au.onerror=function(){fail('This browser can’t play this recording. Download it to listen.')};c.insertBefore(au,c.querySelector('.vw-get,.vw-cf:last-child'));ui.body.appendChild(c);done(n)}
else if(it.kind==='text'){fetch(it.src,{credentials:'same-origin'}).then(function(r){if(!r.ok)throw 0;return r.text()}).then(function(t){if(n!==token)return;var p=el('pre','vw-text');p.tabIndex=0;p.textContent=t.length>200000?t.slice(0,200000)+'\n…':t;ui.body.appendChild(p);done(n)}).catch(function(){fail('This file can’t be shown here.')})}
else fail('');
ui.live.textContent=[what(it).toLowerCase(),it.name,many?(i+1)+' of '+items.length:''].filter(Boolean).join(', ')}
function go(k){var j=at+k;if(!vw||vw.hidden||j<0||j>=items.length)return;show(j)}
function open(a,byKey){if(!vw)build();var it=itemOf(a);if(it.kind==='image'&&a.classList.contains('photo')){items=photos().map(itemOf);var i=items.findIndex(function(x){return x.a===a});at=i<0?0:i;if(i<0)items=[it]}else{items=[it];at=0}
opener=a;inerted=[];Array.prototype.forEach.call(body.children,function(c){if(c!==vw&&!c.inert&&!/^(SCRIPT|STYLE)$/.test(c.tagName)){c.inert=true;inerted.push(c)}});
body.classList.add('viewing');vw.hidden=false;show(at);if(!pushed){try{history.pushState(Object.assign({},history.state||{},{reasonViewer:1}),'');pushed=true}catch(x){}}
void vw.offsetWidth;vw.classList.add('on');(byKey?ui.x:vw).focus({preventScroll:true})}
function close(fromHistory){if(!vw||vw.hidden)return;token++;vw.classList.remove('on');vw.classList.remove('drag');ui.body.style.removeProperty('--dy');ui.body.style.removeProperty('opacity');
var fin=function(){if(vw.classList.contains('on'))return;vw.hidden=true;ui.body.textContent=''};ui.body.querySelectorAll('video,audio').forEach(function(m){try{m.pause()}catch(x){}});
if(calm())fin();else setTimeout(fin,200);
inerted.forEach(function(c){c.inert=false});inerted=[];body.classList.remove('viewing');
if(pushed){pushed=false;if(!fromHistory&&history.state&&history.state.reasonViewer){try{history.back()}catch(x){}}}
if(opener&&opener.isConnected)opener.focus({preventScroll:true});opener=null}
window.addEventListener('popstate',function(){if(pushed){pushed=false;close(true)}});
// A swipe on a photo: down closes it, sideways walks the thread. Pinch still zooms (touch-action).
function swipe(){var s=null;ui.stage.addEventListener('pointerdown',function(e){if(e.pointerType==='mouse'||!e.isPrimary||vw.dataset.kind!=='image')return;s={x:e.clientX,y:e.clientY,id:e.pointerId,dx:0,dy:0,ax:null}});
ui.stage.addEventListener('pointermove',function(e){if(!s||e.pointerId!==s.id)return;s.dx=e.clientX-s.x;s.dy=e.clientY-s.y;if(s.ax==null&&Math.abs(s.dx)+Math.abs(s.dy)>10)s.ax=Math.abs(s.dy)>Math.abs(s.dx)?'y':'x';
if(s.ax==='y'&&s.dy>0){vw.classList.add('drag');ui.body.style.setProperty('--dy',s.dy+'px');ui.body.style.opacity=String(Math.max(.35,1-s.dy/500))}});
var end=function(e){if(!s||e.pointerId!==s.id)return;var g=s;s=null;vw.classList.remove('drag');ui.body.style.removeProperty('opacity');
if(g.ax==='y'&&g.dy>110){close();return}ui.body.style.removeProperty('--dy');if(g.ax==='x'&&Math.abs(g.dx)>60)go(g.dx<0?1:-1)};
ui.stage.addEventListener('pointerup',end);ui.stage.addEventListener('pointercancel',function(e){if(s&&e.pointerId===s.id){s=null;vw.classList.remove('drag');ui.body.style.removeProperty('opacity');ui.body.style.removeProperty('--dy')}})}
d.addEventListener('keydown',function(e){if(!vw||vw.hidden)return;
if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return}
if((e.key==='ArrowRight'||e.key==='ArrowLeft')&&!(e.target&&/^(VIDEO|AUDIO|PRE)$/.test(e.target.tagName))){e.preventDefault();go(e.key==='ArrowRight'?1:-1);return}
if(e.key==='Tab'){var f=Array.prototype.filter.call(vw.querySelectorAll('a[href],button,iframe,video,audio,pre[tabindex]'),function(x){return !x.hidden&&!x.disabled&&x.offsetParent!==null&&getComputedStyle(x).visibility!=='hidden'});if(!f.length){e.preventDefault();return}
var a=f[0],z=f[f.length-1];if(!vw.contains(d.activeElement)||d.activeElement===vw){e.preventDefault();(e.shiftKey?z:a).focus()}else if(e.shiftKey&&d.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&d.activeElement===z){e.preventDefault();a.focus()}}},true);
// A tap on a photo or a file on a line opens it here; a new tab (⌘/Ctrl/middle click) still gets the file itself.
d.addEventListener('click',function(e){if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var a=e.target&&e.target.closest&&e.target.closest('.msg .photo, .msg a.fchip[data-view], .msg a.fslip[data-view]');if(!a)return;
if(a.classList.contains('photo')&&!a.querySelector('img'))return;e.preventDefault();open(a,e.detail===0)},true);
window.reasonViewer={open:open,close:close};
})();`;
