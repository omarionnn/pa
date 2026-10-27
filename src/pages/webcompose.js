// Reason Web: the composer's inputs and the message types that aren't plain words — HANDOFF §3
// (Composer, Voice mode, Voice note, Photo you sent, File slip), reference pages `composer-*`
// (01 at rest · 02 with files · 03 dictating · 04 dropping), `listening-*` (board D), and
// `sheet-messages-*` 4B. The conversation itself stays in src/pages/webconvo.js; this file draws
// what it hands over and runs what the page needs for it.
//
//   - `+` ("Add a photo or file") and a drop anywhere on the page put paper slips on the line
//     (LISTING.PNG, LEASE.PDF · 4 PP). Each file is uploaded as it lands (POST /web/upload,
//     src/webmedia.js); the message that names them goes the ordinary way (/web/send) with or
//     without words, so one message is still one turn however often it is retried.
//   - the mic: a tap dictates on the line (03: the rule in pen, a red dot, the waveform, the clock,
//     send); holding it opens Listening (D) full screen: the words in Caveat as they are heard,
//     not-yet-final ones muted, pausing sends. Live words come from the browser's own speech
//     recognition where it has one (Chrome, Edge, Safari). Where it has none (Firefox) the
//     recording is heard on the server by the same listening a texted voice note gets
//     (src/voice.js, Gemini). A browser that can't record at all, or can't be heard either way,
//     never shows the mic.
//   - in the thread: a photo in a thick paper frame, tilted, on the right; a voice note as its words
//     in Caveat with ▶, a waveform and its length; a file as a typed slip. All of it served from
//     /web/media/… to this conversation's own signed-in session only.
//
// Every word a person typed or said is put on the page with textContent; the server's lines arrive
// already escaped (webconvo.js). Nothing here builds markup from a message.
import * as db from "../db.js";
import { esc } from "./render.js";
import { bubble, wordmark } from "./webkit.js";
import { uploadIdOf, uploadPath, slipLabel, LIMITS } from "../webuploads.js";
import { hearingStatus } from "../voice.js";

const PLUS_SVG = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const MIC_SVG = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
const SEND_SVG = `<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5"/></svg>`;
const DROP_SVG = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v12M6 11l6 6 6-6M5 20h14"/></svg>`;
const PLAY_SVG = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>`;
/** The voice note's waveform, bar for bar as 4B draws it. */
const WAVE_SVG = `<svg class="vwave" aria-hidden="true" width="110" height="20" viewBox="0 0 110 20"><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 8v4M10 5v10M18 2v16M26 7v6M34 3v14M42 6v8M50 8v4M58 4v12M66 7v6M74 2v16M82 6v8M90 8v4M98 5v10M106 8v4"/></g></svg>`;

/** What a photo is, by the kind the pipeline gave it (src/channels/sendblue.js attachmentOf) or its type. */
export function kindOf(x) {
  const k = String(x?.kind ?? "").toLowerCase();
  const t = String(x?.mimeType ?? x?.type ?? "").toLowerCase();
  if (k === "image" || k === "photo" || t.startsWith("image/")) return "photo";
  if (k === "voice" || k === "audio" || t.startsWith("audio/")) return "voice";
  return "file";
}

/** `0:07` */
export const clockOf = (s) => { const n = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; };

/**
 * A history row's attachments as the page gets them: the kind, the name, the typed slip label, the
 * address it is served at (this conversation's session only), a voice note's length and words.
 */
export function mediaOut(row, conversationId) {
  return (row.media ?? []).slice(0, 6).map((x, i) => {
    const kind = kindOf(x);
    const name = String(x?.filename ?? "").slice(0, 80) || "FILE";
    const up = uploadIdOf(x?.url);
    const src = x?.url ? (up ? uploadPath(up, name) : `/web/media/m/${Number(row.id)}/${i}`) : "";
    let seconds = Number(x?.seconds) || null;
    let transcript = x?.transcript ? String(x.transcript) : null;
    if (kind === "voice" && x?.media_id && (!transcript || !seconds)) {
      try {
        const it = db.mediaItem(conversationId, x.media_id);
        transcript ||= it?.transcript || null;
        seconds ||= Number(it?.seconds) || null;
      } catch { /* the words are a nicety; the note still plays */ }
    }
    return { kind, name, src, label: slipLabel({ name, kind: String(x?.kind ?? ""), pages: Number(x?.pages) || null }), seconds: seconds ? Math.round(seconds) : null, transcript };
  });
}

// The framing lines Reason's pipeline writes into a message about what came with it ("[they sent a
// file …]", "[they sent a voice note. this is what they said …]") are for the model, not the page.
const FRAMING = /^\s*\[they (?:sent|shared) [^\n]*\]\s*$/gm;
/** The words a person's own line shows: theirs, without the pipeline's notes about attachments. */
export const ownWords = (text, media = []) => (media.length ? String(text ?? "").replace(FRAMING, "").replace(/\n{3,}/g, "\n\n").trim() : String(text ?? ""));

/** The play control: ▶, the waveform and the length. A real button; the page's script plays it. */
export function playButton({ src, seconds }) {
  const len = seconds ? `, ${seconds} second${seconds === 1 ? "" : "s"}` : "";
  return `<button type="button" class="vplay" data-src="${esc(src)}" aria-label="Play voice note${len}">${PLAY_SVG}${WAVE_SVG}<span class="vt">${seconds ? esc(clockOf(seconds)) : ""}</span></button>`;
}

/** The photos, slips and play control for one line (4B). `you`: a photo of theirs tilts right. */
export function mediaHtml(m) {
  const mine = m.role === "user";
  const photos = m.media.filter(x => x.kind === "photo").map(x => x.src
    ? `<a class="photo" href="${esc(x.src)}" target="_blank" rel="noopener"><img src="${esc(x.src)}" alt="${mine ? "Photo you sent" : "Photo from Reason"}" loading="lazy" decoding="async"></a>`
    : `<div class="photo" role="img" aria-label="${mine ? "Photo you sent" : "Photo from Reason"}"><span class="lbl">PHOTO</span></div>`).join("");
  const files = m.media.filter(x => x.kind === "file").map(x => x.src
    ? `<a class="slip" href="${esc(x.src)}" target="_blank" rel="noopener">${esc(x.label)}</a>`
    : `<span class="slip">${esc(x.label)}</span>`).join("");
  const voice = m.media.find(x => x.kind === "voice");
  const play = voice?.src ? playButton(voice) : "";
  return { photos, files, play, voice };
}

/** Can this server hear a recording (for the browsers with no speech recognition of their own)? */
export const serverHears = () => { try { return !!hearingStatus().ok; } catch { return false; } };

/**
 * The one-line composer (§3; reference composer 01–04). `+` and the mic appear only once the page's
 * script is running and can make them work; without it the line is the plain form that posts.
 */
// `slot` is the conversation's own control inside the line, before the mic (the thread's TODAY ↓,
// src/pages/webconvo.js TODAY_SLOT): the one hook the thread has into this composer.
export function composerHtml({ csrf, sendId, maxText, slot = "" }) {
  return `<div class="composer">`
    + `<div class="cdrop" aria-hidden="true">${DROP_SVG}<span class="hand">let go. i'll read it.</span></div>`
    + `<ul class="on-line" aria-label="Attached" hidden></ul>`
    + `<form class="cform" method="POST" action="/web/send"><input type="hidden" name="c" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(sendId)}">`
    + `<button class="ic c-add" type="button" aria-label="Add a photo or file" hidden>${PLUS_SVG}</button>`
    + `<input class="c-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" multiple hidden tabindex="-1" aria-hidden="true">`
    + `<label class="sr" for="c-input">Message Reason</label><input id="c-input" type="text" name="text" maxlength="${Number(maxText)}" placeholder="Tell Reason what you need" autocomplete="off" enterkeyhint="send" required>`
    + slot
    + `<button class="ic c-mic" type="button" aria-label="Speak instead" hidden>${MIC_SVG}</button>`
    + `<button class="send" type="submit" aria-label="Send">${SEND_SVG}</button></form>`
    + `<div class="dict" hidden><button class="ic d-stop" type="button" aria-label="Stop without sending"><span class="rec" aria-hidden="true"></span></button>`
    + `<svg class="d-wave" aria-hidden="true" viewBox="0 0 240 32" preserveAspectRatio="none"><path d="M0 16h240" class="d-base"/><path class="d-bars" d=""/></svg>`
    + `<span class="d-clock" role="timer" aria-label="Recording time">0:00</span><button class="send d-send" type="button" aria-label="Stop and send">${SEND_SVG}</button></div>`
    + `<p class="hand c-note" role="alert" hidden></p>`
    + `<p class="under">Replies come here, not to your phone as well.</p></div>`;
}

/** Board D, Listening: full screen, the words as they're heard, never mind / Send it, pausing sends. */
export function listeningHtml() {
  return `<div class="listen" role="dialog" aria-modal="true" aria-label="Listening" hidden>`
    + `<div class="ls-top">${wordmark()}<span class="ls-on"><span class="ls-dot" aria-hidden="true"></span>LISTENING · <span class="ls-t" role="timer">0:00</span></span></div>`
    + `<div class="ls-main"><div class="ls-ring" aria-hidden="true"><div>${bubble(2.6)}</div></div>`
    + `<p class="ls-words" aria-live="polite"><span class="ls-fin"></span> <span class="ls-int"></span></p></div>`
    + `<div class="ls-foot"><div class="ls-acts"><button class="ls-never" type="button"><span aria-hidden="true">←</span><span class="u">NEVER MIND</span></button>`
    + `<button class="ls-send" type="button">Send it <span aria-hidden="true">→</span></button></div>`
    + `<p class="lbl ls-hint">PAUSE AND IT SENDS · SPACE TO KEEP TALKING</p></div></div>`;
}

/** What the page's script needs to know before it decides to show the mic. */
export const composeBoot = () => `window.REASON_WEB=window.REASON_WEB||{};window.REASON_WEB.hear=${serverHears() ? "true" : "false"};window.REASON_WEB.lim=${JSON.stringify({ image: LIMITS.image, pdf: LIMITS.pdf })};`;

export const COMPOSE_CSS = `
.ic{width:44px;height:44px;flex:none;border:0;background:transparent;color:var(--ink);display:grid;place-items:center;cursor:pointer;border-radius:3px;padding:0}
.ic[hidden]{display:none}
.cform .c-add{margin-left:-10px}
.cform .c-mic{margin-right:-10px}
.cform.has-files .send{display:grid!important}
.cform.has-files .c-mic{display:none}
.cform input[type=text]:not(:placeholder-shown)~.c-mic{display:none}
.on-line{list-style:none;margin:0;padding:8px 0 4px;display:flex;flex-wrap:wrap;gap:10px}
.on-line[hidden]{display:none}
.composer.has-files .on-line{border-top:1px solid var(--ink);padding-top:14px}
.composer.has-files .cform{border-top:0;padding-top:4px}
.on-line li{display:inline-flex;align-items:center;gap:10px;background:var(--lifted);border:1px solid var(--hair);border-radius:2px;box-shadow:var(--sh);padding:6px 4px 6px 10px;transform:rotate(.5deg);max-width:100%;min-width:0}
.on-line li:nth-child(odd){transform:rotate(-.6deg)}
.on-line li.ph{padding-left:6px}
.on-line .th{width:36px;height:36px;flex:none;background:var(--deep);border:1px solid var(--hair);object-fit:cover;display:inline-block}
.on-line .nm{font:400 12px/1.2 var(--mono);letter-spacing:.04em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.on-line li[data-busy] {opacity:.6}
.on-line .rm{width:32px;height:32px;min-height:32px;flex:none;border:0;background:transparent;cursor:pointer;color:var(--muted);font:400 14px/1 var(--mono);display:grid;place-items:center;margin:-6px 0}
.on-line .rm::after{content:"";position:absolute;inset:-6px}
.on-line li{position:relative}
.cdrop{display:none;height:92px;border:1.5px dashed var(--ink);border-radius:4px;align-items:center;justify-content:center;gap:14px;color:var(--ink)}
.cdrop .hand{font-size:26px;transform:rotate(-1deg);display:inline-block}
body.dropping .cdrop{display:flex}
body.dropping .composer .cform,body.dropping .composer .on-line,body.dropping .composer .dict{display:none}
.dict{display:flex;align-items:center;gap:14px;border-top:1px solid var(--pen);padding-top:10px}
.dict[hidden]{display:none}
.composer.dictating .cform,.composer.dictating .on-line{display:none}
.d-stop .rec{width:10px;height:10px;border-radius:50%;background:var(--pen);display:block}
.d-wave{flex:1 1 auto;height:32px;min-width:0}
.d-base{stroke:var(--hair);stroke-width:1;fill:none}
.d-bars{stroke:var(--ink);stroke-width:2;stroke-linecap:round;fill:none}
.d-clock{font:400 13px/1 var(--mono);letter-spacing:.08em}
.dict .send{display:grid}
.c-note{font-size:21px;transform:rotate(-1deg);transform-origin:left}
.c-note[hidden]{display:none}
.photo{overflow:hidden;text-decoration:none}
.photo img{display:block;width:100%;height:100%;object-fit:cover;background:var(--photo)}
a.slip{color:var(--ink);text-decoration:none;min-height:44px}
a.slip:hover{color:var(--hov)}
.vplay{min-height:44px;border:0;background:transparent;display:flex;align-items:center;gap:10px;cursor:pointer;padding:0;color:var(--ink)}
.vplay .vt{font:400 12px/1 var(--mono)}
.vplay[aria-pressed=true] .vwave{color:var(--pen)}
.msg .said.hand{white-space:pre-wrap;overflow-wrap:anywhere}
.msg.just>.lbl:first-child{display:none}
.listen{position:fixed;inset:0;z-index:60;background:var(--ground);color:var(--ink);display:flex;flex-direction:column;overflow:auto}
.listen[hidden]{display:none}
.ls-top{display:flex;align-items:center;justify-content:space-between;padding:22px clamp(20px,4vw,48px)}
.ls-on{font:400 12px/1 var(--mono);letter-spacing:.14em;color:var(--pen);display:inline-flex;align-items:center;gap:8px}
.ls-dot{width:8px;height:8px;border-radius:50%;background:var(--pen);display:inline-block}
.ls-main{flex:1 0 auto;width:100%;max-width:900px;margin:0 auto;padding:40px 24px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px}
.ls-ring{width:220px;height:220px;border-radius:50%;border:1px dashed var(--hair);display:grid;place-items:center}
.ls-ring>div{width:150px;height:150px;border-radius:50%;border:1px solid var(--hair);display:grid;place-items:center;animation:breathe 3.2s ease-in-out infinite}
.ls-ring .bub{width:64px;height:64px;color:var(--pen);transform:skewX(-10deg)}
.ls-words{margin:0;text-align:center;font:400 clamp(36px,6.5vw,60px)/1.15 var(--hand);color:var(--pen);max-width:16em;transform:rotate(-1deg);overflow-wrap:anywhere;min-height:1.15em}
.ls-int{color:var(--muted)}
.ls-foot{display:flex;flex-direction:column;align-items:center;gap:18px;padding:0 24px 48px}
.ls-acts{display:flex;align-items:center;gap:clamp(28px,8vw,64px);flex-wrap:wrap;justify-content:center}
.ls-never{height:56px;padding:0 8px;border:0;background:transparent;color:var(--muted);font:400 14px/1 var(--mono);letter-spacing:.14em;cursor:pointer;display:flex;align-items:center;gap:10px}
.ls-never .u{border-bottom:1px dashed var(--hair);padding-bottom:3px}
.ls-send{height:56px;padding:0 8px;border:0;background:transparent;color:var(--ink);cursor:pointer;font:italic 400 34px/1 var(--serif)}
.ls-send span{font-style:normal}
.ls-hint{font-size:11.5px;white-space:normal;text-align:center}
body.listening{overflow:hidden}
@media (min-width:900px){.photo img{height:100%}.on-line{padding-top:14px}}
@media (max-width:359px){.ls-ring{width:180px;height:180px}.ls-ring>div{width:124px;height:124px}}
`;

// The page's part: + and drop, the slips, the mic, Listening, playing a note. It talks to the
// conversation's own script through REASON_WEB.api (webconvo.js): post a message, draw its line.
export const COMPOSE_JS = `(function(){
var R=window.REASON_WEB||{},A=R.api,form=document.querySelector('.cform');if(!form||!A)return;
var comp=form.closest('.composer'),box=document.getElementById('c-input'),add=form.querySelector('.c-add'),pick=form.querySelector('.c-file'),mic=form.querySelector('.c-mic'),shelf=comp.querySelector('.on-line'),note=comp.querySelector('.c-note'),body=document.body;
var files=[],blobs={},noteT=0;
function say(t){if(!note)return;note.textContent=t;note.hidden=!t;clearTimeout(noteT);if(t)noteT=setTimeout(function(){note.hidden=true},9000)}
R.say=say;
function sync(){var any=files.length>0;form.classList.toggle('has-files',any);comp.classList.toggle('has-files',any);box.required=!any;shelf.hidden=!any}
function slip(f){var li=document.createElement('li');if(f.kind==='image')li.className='ph';if(f.busy)li.dataset.busy='1';
if(f.kind==='image'){var th=document.createElement(f.preview?'img':'span');th.className='th';if(f.preview){th.src=f.preview;th.alt=''}li.appendChild(th)}
var n=document.createElement('span');n.className='nm';n.textContent=f.label;li.appendChild(n);
var x=document.createElement('button');x.type='button';x.className='rm';x.setAttribute('aria-label','Remove '+f.name);x.textContent='\\u00d7';x.onclick=function(){files=files.filter(function(g){return g!==f});li.remove();sync();box.focus()};li.appendChild(x);return li}
function draw(){shelf.textContent='';files.forEach(function(f){f.li=slip(f);shelf.appendChild(f.li)});sync()}
var ERR={unsupported:"i can only read photos and PDFs here.",too_big:"that one's too big for me. photos up to 7 MB, PDFs up to 20 MB.",signed_out:''};
function upload(blob,name,extra){var h={'X-Reason-Csrf':R.c,'X-Reason-Name':encodeURIComponent(name||''),'Content-Type':blob.type||'application/octet-stream',Accept:'application/json'};if(extra)for(var k in extra)h[k]=extra[k];
return fetch('/web/upload',{method:'POST',credentials:'same-origin',headers:h,body:blob}).then(function(r){return r.json().catch(function(){return{ok:false,error:r.status===413?'too_big':'failed'}}).then(function(j){j.status=r.status;return j})})}
function shrink(file){// A camera photo over the model's limit, made smaller here when this browser can draw it.
return new Promise(function(res){if(file.size<=R.lim.image||!/^image\\/(jpeg|png|webp)$/.test(file.type))return res(file);var u=URL.createObjectURL(file),im=new Image();im.onload=function(){var s=Math.min(1,2560/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(function(b){res(b||file)},'image/jpeg',.86)};im.onerror=function(){URL.revokeObjectURL(u);res(file)};im.src=u})}
function take(list){say('');Array.prototype.slice.call(list||[]).slice(0,6-files.length).forEach(function(file){
var img=/^image\\//.test(file.type)||/\\.(heic|heif)$/i.test(file.name),f={name:file.name||'file',label:String(file.name||'file').toUpperCase(),kind:img?'image':'pdf',busy:true,preview:img&&/^image\\/(jpeg|png|gif|webp)$/.test(file.type)?URL.createObjectURL(file):''};
files.push(f);draw();
f.wait=shrink(file).then(function(b){return upload(b,file.name)}).then(function(j){if(j.status===401){location.href='/web?out=1';return}if(!j.ok){files=files.filter(function(g){return g!==f});draw();say(ERR[j.error]||"that didn't upload. try it again?");return}
f.id=j.id;f.kind=j.kind;f.label=j.label;f.name=j.name;f.src=j.src;f.busy=false;if(f.preview)blobs[j.id]=f.preview;draw()}).catch(function(){files=files.filter(function(g){return g!==f});draw();say("that didn't upload. try it again?")})});if(files.length)box.focus()}
// Hand the attached files to the message being sent; it waits for any still on their way up.
R.takeFiles=function(){var out=files.filter(function(f){return f.id}).map(function(f){return{id:f.id,kind:f.kind,name:f.name,label:f.label,src:f.src}});files=[];draw();return out};
function clk(s){s=Math.max(0,Math.round(s||0));return Math.floor(s/60)+':'+('0'+s%60).slice(-2)}
// A message with files, drawn the moment it's sent (4B): photos framed, slips, a voice note's words then ▶.
R.drawFiles=function(li,p){var fs=p.files||[],v=null;
fs.forEach(function(f){if(f.kind==='image'){var a=document.createElement('div');a.className='photo';var im=document.createElement('img');im.alt='Photo you sent';im.src=(f.id&&blobs[f.id])||f.src||f.preview||'';a.appendChild(im);li.appendChild(a)}});
fs.forEach(function(f){if(f.kind==='pdf'||f.kind==='file'){var s=document.createElement('span');s.className='slip';s.textContent=f.label||String(f.name||'').toUpperCase();li.appendChild(s)}else if(f.kind==='voice')v=f});
if(v){if(p.text){var w=document.createElement('p');w.className='said hand';w.textContent=p.text;li.appendChild(w)}var b=document.createElement('button');b.type='button';b.className='vplay';b.dataset.src=(v.id&&blobs[v.id])||v.src||v.preview||'';b.setAttribute('aria-label','Play voice note'+(v.seconds?', '+v.seconds+' seconds':''));b.innerHTML=${JSON.stringify(PLAY_SVG + WAVE_SVG + `<span class="vt"></span>`)};b.querySelector('.vt').textContent=v.seconds?clk(v.seconds):'';li.appendChild(b)}
else if(p.text){var s=document.createElement('div');s.className='said';s.textContent=p.text;li.appendChild(s)}};
form.addEventListener('submit',function(e){if(files.some(function(f){return f.busy})){e.preventDefault();e.stopImmediatePropagation();Promise.all(files.map(function(f){return f.wait})).then(function(){if(files.length||box.value.trim())form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true}))})}},true);
if(add&&pick&&window.fetch&&window.FormData){add.hidden=false;add.onclick=function(){pick.click()};pick.onchange=function(){take(pick.files);pick.value=''};
// The whole page takes a drop (04).
var depth=0;function hasFiles(e){var t=e.dataTransfer&&e.dataTransfer.types;return !!t&&Array.prototype.indexOf.call(t,'Files')>=0}
document.addEventListener('dragenter',function(e){if(!hasFiles(e))return;e.preventDefault();depth++;body.classList.add('dropping')});
document.addEventListener('dragover',function(e){if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy'});
document.addEventListener('dragleave',function(e){if(!hasFiles(e))return;depth=Math.max(0,depth-1);if(!depth)body.classList.remove('dropping')});
document.addEventListener('drop',function(e){if(!hasFiles(e))return;e.preventDefault();depth=0;body.classList.remove('dropping');take(e.dataTransfer.files)});
box.addEventListener('paste',function(e){var it=e.clipboardData&&e.clipboardData.files;if(it&&it.length){e.preventDefault();take(it)}})}
// ---- the mic ----
var SR=window.SpeechRecognition||window.webkitSpeechRecognition,MR=window.MediaRecorder,GUM=navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;
if(!mic||!MR||!GUM||!window.isSecureContext||!(SR||R.hear))return;
mic.hidden=false;
var dict=comp.querySelector('.dict'),dclock=dict.querySelector('.d-clock'),bars=dict.querySelector('.d-bars'),ls=document.querySelector('.listen'),lsT=ls&&ls.querySelector('.ls-t'),lsF=ls&&ls.querySelector('.ls-fin'),lsI=ls&&ls.querySelector('.ls-int');
var rec=null;
function pickType(){var t=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'];for(var i=0;i<t.length;i++)if(MR.isTypeSupported&&MR.isTypeSupported(t[i]))return t[i];return''}
function start(full){if(rec)return;say('');var r=rec={full:full,t0:Date.now(),chunks:[],fin:'',int:'',levels:[],spoke:false,last:Date.now(),done:false};
GUM.call(navigator.mediaDevices,{audio:true}).then(function(stream){if(r.done){stream.getTracks().forEach(function(t){t.stop()});return}r.stream=stream;var type=pickType();try{r.mr=type?new MR(stream,{mimeType:type}):new MR(stream)}catch(x){r.mr=new MR(stream)}
r.mr.ondataavailable=function(e){if(e.data&&e.data.size)r.chunks.push(e.data)};r.mr.start(250);
try{var AC=window.AudioContext||window.webkitAudioContext;r.ac=new AC();var src=r.ac.createMediaStreamSource(stream);r.an=r.ac.createAnalyser();r.an.fftSize=512;src.connect(r.an);r.buf=new Uint8Array(r.an.fftSize)}catch(x){}
if(SR){try{var s=r.sr=new SR();s.continuous=true;s.interimResults=true;s.lang=navigator.language||'en-US';
s.onresult=function(e){var f='',n='';for(var i=0;i<e.results.length;i++){var x=e.results[i][0].transcript;if(e.results[i].isFinal)f+=x;else n+=x}r.fin=((r.keep||'')+f).trim();r.int=n;r.last=Date.now();r.spoke=true;words()};
s.onend=function(){if(!r.done){r.keep=(r.fin?r.fin+' ':'');try{s.start()}catch(x){}}};s.onerror=function(e){if(e.error==='not-allowed'||e.error==='service-not-allowed'){r.sr=null;if(!R.hear){stop(false);say("i can't hear you here. the mic is off for this page.")}}};s.start()}catch(x){r.sr=null}}
r.tick=setInterval(tick,100)}).catch(function(){r.done=true;rec=null;close();say("i can't hear you here. the mic is off for this page.")});
if(full)openFull();else{comp.classList.add('dictating');dict.hidden=false;dclock.textContent='0:00';bars.setAttribute('d','');dict.querySelector('.d-send').focus()}}
function words(){if(!ls||!rec)return;lsF.textContent=rec.fin;lsI.textContent=rec.int}
function tick(){var r=rec;if(!r)return;var s=(Date.now()-r.t0)/1000;dclock.textContent=clk(s);if(lsT)lsT.textContent=clk(s);
var lvl=0;if(r.an){r.an.getByteTimeDomainData(r.buf);var sum=0;for(var i=0;i<r.buf.length;i++){var v=(r.buf[i]-128)/128;sum+=v*v}lvl=Math.sqrt(sum/r.buf.length)}
if(!r.sr&&lvl>0.04){r.spoke=true;r.last=Date.now()}
if(Date.now()-(r.lt||0)>160){r.lt=Date.now();r.levels.push(lvl);if(r.levels.length>29)r.levels.shift();var d='';r.levels.forEach(function(l,i){var h=Math.max(2,Math.min(28,Math.round(l*90)));var x=4+i*8;d+='M'+x+' '+(16-h/2)+'v'+h});bars.setAttribute('d',d)}
// Pausing sends (board D): once they've said something and gone quiet for a moment.
if(r.full&&r.spoke&&Date.now()-r.last>2600&&(!r.sr||r.fin||r.int))stop(true);
if(s>300)stop(true)}
function openFull(){if(!ls)return;lsF.textContent='';lsI.textContent='';lsT.textContent='0:00';ls.hidden=false;body.classList.add('listening');ls.querySelector('.ls-send').focus()}
function close(){comp.classList.remove('dictating');dict.hidden=true;if(ls){ls.hidden=true;body.classList.remove('listening')}}
function stop(send){var r=rec;if(!r||r.done)return;r.done=true;rec=null;clearInterval(r.tick);close();var seconds=Math.max(1,Math.round((Date.now()-r.t0)/1000)),words=((r.fin||'')+' '+(r.int||'')).replace(/\\s+/g,' ').trim().slice(0,R.max||4000);
try{r.sr&&r.sr.stop()}catch(x){}
var finish=function(){if(r.stream)r.stream.getTracks().forEach(function(t){t.stop()});try{r.ac&&r.ac.close()}catch(x){}if(!send){mic.focus();return}
var blob=r.chunks.length?new Blob(r.chunks,{type:(r.mr&&r.mr.mimeType)||r.chunks[0].type||'audio/webm'}):null;
if(!blob||!blob.size){if(words){A.post({id:A.uid(),text:words});return}say("i didn't catch that.");return}
if(!words&&!R.hear){say("i didn't catch that.");return}
var url=URL.createObjectURL(blob),p={id:A.uid(),text:words,voice:seconds,files:[{kind:'voice',name:'voice-note',label:'VOICE NOTE',seconds:seconds,preview:url}]},li=A.pendingLine(p);
var go=function(){A.state(li,'sending');upload(blob,'voice-note',{'X-Reason-Voice':'1','X-Reason-Seconds':String(seconds)}).then(function(j){if(j.status===401){location.href='/web?out=1';return}if(!j.ok){A.state(li,'failed');return}
p.files=[{id:j.id,kind:'voice',name:j.name,label:j.label,seconds:seconds,src:j.src}];blobs[j.id]=url;A.post(p,li)}).catch(function(){A.state(li,'failed')})};li.retry=go;go()};
if(r.mr&&r.mr.state!=='inactive'){r.mr.onstop=finish;try{r.mr.stop()}catch(x){finish()}}else finish()}
// A tap dictates on the line (03); holding the mic opens Listening (D).
var held=0,downAt=0;mic.addEventListener('pointerdown',function(e){if(e.button)return;downAt=Date.now();held=setTimeout(function(){held=-1;start(true)},450)});
mic.addEventListener('pointerup',function(){if(held>0){clearTimeout(held);held=0}});mic.addEventListener('pointerleave',function(){if(held>0){clearTimeout(held);held=0}});
mic.addEventListener('contextmenu',function(e){e.preventDefault()});
mic.addEventListener('click',function(e){if(held===-1){held=0;return}held=0;start(false)});
dict.querySelector('.d-send').onclick=function(){stop(true)};dict.querySelector('.d-stop').onclick=function(){stop(false)};
if(ls){ls.querySelector('.ls-send').onclick=function(){stop(true)};ls.querySelector('.ls-never').onclick=function(){stop(false)}}
document.addEventListener('keyup',function(e){if(rec&&rec.full&&(e.key===' '||e.code==='Space'))e.preventDefault()},true);
document.addEventListener('keydown',function(e){if(!rec)return;if(e.key==='Escape'){e.preventDefault();stop(false)}else if(rec.full&&(e.key===' '||e.code==='Space')){e.preventDefault();rec.last=Date.now()}
else if(rec.full&&e.key==='Tab'){var f=ls.querySelectorAll('button'),a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}});
})();
// Playing a voice note in the thread: one at a time.
(function(){var cur=null;document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('.vplay');if(!b)return;
if(cur&&cur.b===b){if(cur.a.paused)cur.a.play();else cur.a.pause();return}if(cur){cur.a.pause();cur.b.setAttribute('aria-pressed','false')}
var a=new Audio(b.dataset.src),t=b.querySelector('.vt');cur={a:a,b:b};a.onplay=function(){b.setAttribute('aria-pressed','true')};a.onpause=a.onended=function(){b.setAttribute('aria-pressed','false')};
a.onloadedmetadata=function(){if(t&&!t.textContent&&isFinite(a.duration)){var s=Math.round(a.duration);t.textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2)}};a.play().catch(function(){})})})();`;
