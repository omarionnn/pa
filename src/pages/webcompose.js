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
import { uploadIdOf, uploadPath, slipLabel, LIMITS, LIMITS_LINE, MAX_FILES } from "../webuploads.js";
import { FIT_BYTES } from "../webshrink.js";
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

/** The photos, slips and play control for one line (4B; sheet-uploads 3D). A file you sent is a slip that opens. */
export function mediaHtml(m) {
  const mine = m.role === "user";
  const photos = m.media.filter(x => x.kind === "photo").map(x => x.src
    ? `<a class="photo" href="${esc(x.src)}" target="_blank" rel="noopener"><img src="${esc(x.src)}" alt="${mine ? "Photo you sent" : "Photo from Reason"}" loading="lazy" decoding="async"></a>`
    : `<div class="photo" role="img" aria-label="${mine ? "Photo you sent" : "Photo from Reason"}"><span class="lbl">PHOTO</span></div>`).join("");
  const files = m.media.filter(x => x.kind === "file").map(x => x.src
    ? `<a class="slip fslip" href="${esc(x.src)}" target="_blank" rel="noopener"><span class="fn">${esc(x.label)}</span><span class="fs">TAP TO OPEN</span></a>`
    : `<span class="slip fslip"><span class="fn">${esc(x.label)}</span></span>`).join("");
  const voice = m.media.find(x => x.kind === "voice");
  const play = voice?.src ? playButton(voice) : "";
  return { photos, files, play, voice };
}

/** Can this server hear a recording (for the browsers with no speech recognition of their own)? */
export const serverHears = () => { try { return !!hearingStatus().ok; } catch { return false; } };

/** What each choice in the + sheet opens (sheet-uploads 3A). Video is offered as drawn; the server decides (Q-v2). */
export const PICKS = {
  media: { label: "Photo or video", accept: "image/*,video/*" },
  camera: { label: "Take a photo", accept: "image/*", capture: "environment" },
  file: { label: "A file or PDF", accept: "application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,.csv,text/plain" },
};

/** 4E: the mic blocked. Drawn in the composer so the line under it stays live ("or just type it"). */
function micOffHtml() {
  return `<section class="micoff" aria-labelledby="mo-h" hidden><div class="mo-ring" aria-hidden="true"><div>${bubble(2.6)}</div></div>`
    + `<h2 id="mo-h" class="mo-h" tabindex="-1">I can’t hear you yet.</h2>`
    + `<p class="mo-p">Your browser hasn’t allowed the microphone. Allow it next to the address bar, then try again.</p>`
    + `<button class="mo-try" type="button">Try again <span aria-hidden="true">→</span></button>`
    + `<p class="hand mo-or">or just type it. that works too.</p></section>`;
}

/**
 * The one-line composer (§3; reference composer 01–04, sheet-uploads 3A–3E, sheet-voice 4C/4E).
 * `+` and the mic appear only once the page's script is running and can make them work; without it
 * the line is the plain form that posts.
 */
export function composerHtml({ csrf, sendId, maxText }) {
  const picks = Object.entries(PICKS);
  return `<div class="composer">`
    + micOffHtml()
    + `<div class="cdrop" aria-hidden="true"><div>${DROP_SVG}<span class="hand">let go. i’ll read it.</span><span class="lbl">ON DESKTOP, DROP ANYWHERE</span></div></div>`
    + `<p class="lbl fromvoice" hidden>FROM YOUR VOICE · EDIT ANYTHING</p>`
    + `<div class="upl" hidden><ul class="on-line" aria-label="Attached"></ul><div class="upfail" hidden><div class="uf-list"></div><p class="lbl uf-lim">${esc(LIMITS_LINE)}</p></div></div>`
    + `<form class="cform" method="POST" action="/web/send"><input type="hidden" name="c" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(sendId)}">`
    + `<button class="ic c-add" type="button" aria-label="Add a photo or file" aria-haspopup="dialog" aria-expanded="false" hidden>${PLUS_SVG}</button>`
    + picks.map(([k, p]) => `<input class="c-file" data-pick="${k}" type="file" accept="${esc(p.accept)}"${p.capture ? ` capture="${p.capture}"` : ""}${k === "camera" ? "" : " multiple"} hidden tabindex="-1" aria-hidden="true">`).join("")
    + `<label class="sr" for="c-input">Message Reason</label><textarea id="c-input" name="text" rows="1" maxlength="${Number(maxText)}" placeholder="Tell Reason what you need" autocomplete="off" enterkeyhint="send" required></textarea>`
    + `<button class="ic c-mic" type="button" aria-label="Speak instead" hidden>${MIC_SVG}</button>`
    + `<button class="send" type="submit" aria-label="Send">${SEND_SVG}</button></form>`
    + `<div class="dict" hidden><button class="ic d-stop" type="button" aria-label="Stop without sending"><span class="rec" aria-hidden="true"></span></button>`
    + `<svg class="d-wave" aria-hidden="true" viewBox="0 0 240 32" preserveAspectRatio="none"><path d="M0 16h240" class="d-base"/><path class="d-bars" d=""/></svg>`
    + `<span class="d-clock" role="timer" aria-label="Recording time">0:00</span><button class="send d-send" type="button" aria-label="Stop and send">${SEND_SVG}</button></div>`
    + `<p class="hand c-note" role="alert" hidden></p>`
    + `<p class="under">Replies come here, not to your phone as well.</p>`
    + `<div class="addsheet" role="dialog" aria-label="Add to your message" hidden><span class="lbl as-h">ADD TO YOUR MESSAGE</span>`
    + picks.map(([k, p]) => `<button class="as-pick" type="button" data-pick="${k}">${esc(p.label)}</button>`).join("")
    + `<button class="as-never" type="button">NEVER MIND</button></div></div>`;
}

/**
 * Board D / sheet-voice 4A–4B and sheet-loading-actions L9, full screen: the words as they're heard
 * (4A); "writing it down…" while they're being written (L9); paused, about to send, with a way to
 * keep talking, edit or send now (4B).
 */
export function listeningHtml() {
  return `<div class="listen" role="dialog" aria-modal="true" aria-label="Listening" data-mode="listening" hidden>`
    + `<div class="ls-top">${wordmark()}<span class="ls-on"><span class="ls-dot" aria-hidden="true"></span>LISTENING · <span class="ls-t" role="timer">0:00</span></span><span class="ls-paused">PAUSED</span></div>`
    + `<div class="ls-main"><div class="ls-ring" aria-hidden="true"><div>${bubble(2.6)}</div></div>`
    + `<div class="ls-wring" aria-hidden="true">${bubble(2.6)}</div>`
    + `<p class="ls-words" aria-live="polite"><span class="ls-fin"></span> <span class="ls-int"></span></p>`
    + `<p class="hand ls-writing" role="status">writing it down…</p><div class="ls-ruled" aria-hidden="true"><span></span><span></span><span></span></div>`
    + `<div class="ls-count" role="status"><span class="ls-cn">SENDING IN 3…</span><span class="ls-dots" aria-hidden="true"><i></i><i></i><i></i></span></div></div>`
    + `<div class="ls-foot"><div class="ls-acts"><button class="ls-never" type="button"><span aria-hidden="true">←</span><span class="u">NEVER MIND</span></button>`
    + `<button class="ls-send" type="button">Send it <span aria-hidden="true">→</span></button></div>`
    + `<p class="lbl ls-hint"><span>PAUSE AND IT SENDS</span><span class="ls-sp"> · SPACE TO KEEP TALKING</span></p>`
    + `<div class="ls-pacts"><button class="ls-keep" type="button">KEEP TALKING</button><button class="ls-edit" type="button">Edit it first</button><button class="ls-now" type="button">Send now <span aria-hidden="true">→</span></button></div></div></div>`;
}

/** What the page's script needs to know before it decides to show the mic, and the limits it checks. */
export const composeBoot = () => `window.REASON_WEB=window.REASON_WEB||{};window.REASON_WEB.hear=${serverHears() ? "true" : "false"};window.REASON_WEB.lim=${JSON.stringify({ each: LIMITS.image, fit: FIT_BYTES, files: MAX_FILES })};`;

export const COMPOSE_CSS = `
.ic{width:44px;height:44px;flex:none;border:0;background:transparent;color:var(--ink);display:grid;place-items:center;cursor:pointer;border-radius:3px;padding:0}
.ic[hidden]{display:none}
.composer{position:sticky}
.cform .c-add{margin-left:-10px}
.cform .c-mic{margin-right:-10px}
.cform textarea{flex:1;min-width:0;min-height:44px;max-height:9.5em;box-sizing:border-box;border:0;border-radius:0;background:transparent;font:italic 400 21px/1.3 var(--serif);color:var(--ink);padding:8px 0;margin:0;resize:none;overflow-y:auto;field-sizing:content;-webkit-appearance:none;appearance:none}
.cform textarea::placeholder{color:var(--muted);opacity:1}
.cform textarea:focus-visible{outline:none}
.cform textarea:placeholder-shown~.send{display:none}
.cform textarea:not(:placeholder-shown)~.c-mic{display:none}
.cform.has-files .send{display:grid!important}
.cform.has-files .c-mic{display:none}
.home .cform textarea{min-height:52px;font-size:24px}
.composer.voiced .cform textarea{font-size:19px}
.fromvoice{padding-bottom:4px;font-size:10px}
.fromvoice[hidden]{display:none}
.upl{display:flex;flex-direction:column;gap:6px;padding-bottom:6px}
.upl[hidden],.upfail[hidden]{display:none}
.on-line{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:10px}
.on-line:empty{display:none}
.on-line li{position:relative;display:inline-flex;align-items:center;gap:10px;background:var(--lifted);border:1px solid var(--hair);border-radius:2px;box-shadow:var(--sh);padding:6px 4px 6px 6px;max-width:100%;min-width:0}
.on-line li[data-state=up]{opacity:.55}
.on-line .th{width:34px;height:34px;flex:none;background:var(--photo);border:1px solid var(--hair);object-fit:cover;display:inline-block;box-sizing:border-box}
.on-line .tx{display:flex;flex-direction:column;gap:2px;min-width:0}
.on-line .nm{font:400 11.5px/1.2 var(--mono);letter-spacing:.04em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.on-line .st2{font:400 9.5px/1.2 var(--mono);letter-spacing:.1em;color:var(--muted)}
.on-line .rm{position:relative;width:28px;height:32px;flex:none;border:0;background:transparent;cursor:pointer;color:var(--muted);font:400 14px/1 var(--mono);display:grid;place-items:center;margin:-6px 0;padding:0}
.on-line .rm::after{content:"";position:absolute;inset:-6px}
.upfail{display:flex;flex-direction:column;gap:6px}
.uf-list{display:flex;flex-direction:column;align-items:flex-start}
.uf-retry{min-height:40px;border:0;background:transparent;padding:0;cursor:pointer;font:400 21px/1.15 var(--hand);color:var(--pen);text-align:left}
.uf-lim{font-size:10px}
.addsheet{position:fixed;left:0;right:0;bottom:0;z-index:65;background:var(--lifted);border-top:1px solid var(--hair);padding:20px 24px calc(30px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:4px}
.addsheet[hidden]{display:none}
.composer.sheet-on{z-index:66}
body.dropping .composer{z-index:71}
.as-h{font-size:11px}
.as-pick{min-height:52px;border:0;border-bottom:1px dashed var(--hair);background:transparent;padding:0;text-align:left;cursor:pointer;font:italic 400 24px/1.2 var(--serif);color:var(--ink)}
.as-pick:hover{color:var(--hov)}
.as-never{align-self:flex-start;min-height:44px;border:0;background:transparent;padding:0;margin-top:8px;cursor:pointer;font:400 11.5px/1 var(--mono);letter-spacing:.14em;color:var(--muted)}
.cdrop{display:none;position:fixed;inset:12px;z-index:70;border:1.5px dashed var(--ink);border-radius:4px;background:color-mix(in srgb,var(--ground) 94%,transparent);align-items:center;justify-content:center;pointer-events:none}
.cdrop>div{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--ink)}
.cdrop svg{width:28px;height:28px}
.cdrop .hand{font-size:28px;color:var(--pen)}
.cdrop .lbl{font-size:10px}
body.dropping .cdrop{display:flex}
.dict{display:flex;align-items:center;gap:14px;border-top:1px solid var(--pen);padding-top:10px}
.dict[hidden]{display:none}
.composer.dictating .cform,.composer.dictating .upl{display:none}
.d-stop .rec{width:10px;height:10px;border-radius:50%;background:var(--pen);display:block}
.d-wave{flex:1 1 auto;height:32px;min-width:0}
.d-base{stroke:var(--hair);stroke-width:1;fill:none}
.d-bars{stroke:var(--ink);stroke-width:2;stroke-linecap:round;fill:none}
.d-clock{font:400 13px/1 var(--mono);letter-spacing:.08em}
.dict .send{display:grid}
.c-note{font-size:21px;transform:rotate(-1deg);transform-origin:left}
.c-note[hidden]{display:none}
.micoff{display:none;min-height:calc(100dvh - 260px);flex-direction:column;justify-content:center;gap:22px;padding:28px 0 20px}
body.mic-off .micoff{display:flex}
body.mic-off .convo>:not(.composer):not(h1),body.mic-off .home>:not(.composer){display:none}
.mo-ring{align-self:center;width:150px;height:150px;border-radius:50%;border:1px dashed var(--hair);display:grid;place-items:center}
.mo-ring>div{width:102px;height:102px;border-radius:50%;border:1px solid var(--hair);display:grid;place-items:center}
.mo-ring .bub,.ls-wring .bub{width:52px;height:52px;color:var(--pen);transform:skewX(-10deg)}
.mo-h{margin:0;font:italic 400 34px/1.06 var(--serif);letter-spacing:-.02em}
.mo-h:focus{outline:none}
.mo-p{margin:0;font-size:16px;line-height:1.55;color:var(--muted)}
.mo-try{align-self:flex-start;min-height:48px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 26px/1 var(--serif);color:var(--ink)}
.mo-try span{font-style:normal}
.mo-or{margin:0;font-size:21px;line-height:1.2;transform:rotate(-1deg);transform-origin:left}
.photo{overflow:hidden;text-decoration:none}
.photo img{display:block;width:100%;height:100%;object-fit:cover;background:var(--photo)}
.slip.fslip{display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px;padding:6px 10px;transform:none;min-height:0}
a.slip.fslip{min-height:44px;justify-content:center;color:var(--ink);text-decoration:none}
a.slip.fslip:hover{color:var(--hov)}
.fslip .fn{font:400 11.5px/1.2 var(--mono);letter-spacing:.04em;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.fslip .fs{font:400 9.5px/1.2 var(--mono);letter-spacing:.1em;color:var(--muted)}
.vplay{min-height:44px;border:0;background:transparent;display:flex;align-items:center;gap:10px;cursor:pointer;padding:0;color:var(--ink)}
.vplay .vt{font:400 11px/1 var(--mono)}
.vplay[aria-pressed=true] .vwave{color:var(--pen)}
.msg .said.hand{white-space:pre-wrap;overflow-wrap:anywhere}
.msg.just>.lbl:first-child{display:none}
.listen{position:fixed;inset:0;z-index:60;background:var(--ground);color:var(--ink);display:flex;flex-direction:column;overflow:auto}
.listen[hidden]{display:none}
.ls-top{display:flex;align-items:baseline;justify-content:space-between;padding:20px 24px 14px}
.ls-on{font:400 11px/1 var(--mono);letter-spacing:.14em;color:var(--pen);display:inline-flex;align-items:center;gap:8px}
.ls-paused{font:400 11px/1 var(--mono);letter-spacing:.14em;color:var(--muted)}
.ls-dot{width:8px;height:8px;border-radius:50%;background:var(--pen);display:inline-block}
.ls-main{flex:1 0 auto;width:100%;max-width:900px;margin:0 auto;box-sizing:border-box;padding:28px 24px 20px;display:flex;flex-direction:column;justify-content:center;gap:40px}
.ls-ring{align-self:center;width:180px;height:180px;border-radius:50%;border:1px dashed var(--hair);display:grid;place-items:center}
.ls-ring>div{width:122px;height:122px;border-radius:50%;border:1px solid var(--hair);display:grid;place-items:center;animation:breathe 3.2s ease-in-out infinite}
.ls-ring .bub{width:52px;height:52px;color:var(--pen);transform:skewX(-10deg)}
.ls-wring{align-self:center;width:150px;height:150px;border-radius:50%;border:1px dashed var(--hair);display:grid;place-items:center}
.ls-wring .bub{width:46px;height:46px}
.ls-words{margin:0;text-align:center;font:400 36px/1.15 var(--hand);color:var(--pen);transform:rotate(-1deg);overflow-wrap:anywhere;min-height:1.15em}
.ls-int{color:var(--muted)}
.ls-writing{margin:0;text-align:center;font-size:30px}
.ls-ruled{align-self:center;width:70%;display:flex;flex-direction:column;align-items:flex-start;gap:16px}
.ls-ruled span{display:block;height:2px;background:var(--hair);width:100%}
.ls-ruled span:nth-child(2){width:80%}.ls-ruled span:nth-child(3){width:60%}
.ls-count{display:flex;flex-direction:column;gap:6px}
.ls-cn{font:400 11px/1.2 var(--mono);letter-spacing:.14em;color:var(--ink)}
.ls-dots{display:flex;gap:6px}
.ls-dots i{width:8px;height:8px;border-radius:50%;box-sizing:border-box;border:1px solid var(--pen);background:var(--pen)}
.ls-dots i.off{background:transparent}
.ls-foot{display:flex;flex-direction:column;align-items:center;gap:10px;padding:0 24px 30px}
.ls-acts{display:flex;align-items:center;gap:40px;flex-wrap:wrap;justify-content:center}
.ls-never{min-height:44px;padding:0;border:0;background:transparent;color:var(--muted);font:400 11.5px/1 var(--mono);letter-spacing:.14em;cursor:pointer;display:flex;align-items:center;gap:8px}
.ls-never .u{border-bottom:1px dashed var(--hair);padding-bottom:3px}
.ls-send{min-height:52px;padding:0 6px;border:0;background:transparent;color:var(--ink);cursor:pointer;font:italic 400 30px/1 var(--serif)}
.ls-send span,.ls-now span{font-style:normal}
.ls-hint{font-size:10px;white-space:normal;text-align:center}
.ls-sp{display:none}
.ls-pacts{display:flex;gap:28px;align-items:center;justify-content:center;flex-wrap:wrap}
.ls-keep{min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:400 11.5px/1 var(--mono);letter-spacing:.14em;color:var(--ink)}
.ls-edit,.ls-now{min-height:48px;border:0;background:transparent;cursor:pointer;color:var(--ink);font:italic 400 22px/1 var(--serif);padding:0 6px}
.ls-now{font-size:28px}
.listen .ls-paused,.listen .ls-wring,.listen .ls-writing,.listen .ls-ruled,.listen .ls-count,.listen .ls-pacts{display:none}
.listen[data-mode=writing] .ls-on,.listen[data-mode=writing] .ls-ring,.listen[data-mode=writing] .ls-words,.listen[data-mode=writing] .ls-foot{display:none}
.listen[data-mode=writing] .ls-wring,.listen[data-mode=writing] .ls-writing{display:grid}
.listen[data-mode=writing] .ls-ruled{display:flex}
.listen[data-mode=writing] .ls-main{gap:30px}
.listen[data-mode=paused] .ls-on,.listen[data-mode=paused] .ls-ring,.listen[data-mode=paused] .ls-acts,.listen[data-mode=paused] .ls-hint{display:none}
.listen[data-mode=paused] .ls-paused{display:inline}
.listen[data-mode=paused] .ls-count{display:flex}
.listen[data-mode=paused] .ls-pacts{display:flex}
.listen[data-mode=paused] .ls-main{gap:32px}
.listen[data-mode=paused] .ls-words{font-size:34px;text-align:left}
.listen[data-mode=paused] .ls-int{color:inherit}
body.listening{overflow:hidden}
@media (min-width:900px){.photo img{height:100%}.cform textarea{font-size:24px;min-height:48px}.home .cform textarea{font-size:26px}
.addsheet{position:absolute;left:-12px;right:auto;width:380px;bottom:calc(100% - 4px);padding:20px 24px 24px;border:1px solid var(--hair);border-radius:4px;box-shadow:var(--sh2)}
.ls-top{padding:22px clamp(20px,4vw,48px)}.ls-on,.ls-paused{font-size:12px}
.ls-main{gap:56px;padding:40px 24px}.ls-ring{width:220px;height:220px}.ls-ring>div{width:150px;height:150px}.ls-ring .bub{width:64px;height:64px}
.ls-words{font-size:clamp(36px,5vw,60px);max-width:16em;align-self:center}.listen[data-mode=paused] .ls-words{font-size:clamp(34px,4.4vw,52px)}
.ls-foot{gap:18px;padding:0 24px 48px}.ls-acts{gap:64px}.ls-never{font-size:14px;min-height:56px}.ls-send{font-size:34px;min-height:56px}.ls-hint{font-size:11.5px}.ls-sp{display:inline}
.mo-h{font-size:46px}}
@media (max-width:359px){.ls-ring{width:150px;height:150px}.ls-ring>div{width:104px;height:104px}.ls-words{font-size:30px}}
`;

// The page's part: + and its sheet, drop, the slips and their states, the mic, Listening (4A/4B/L9),
// editing what was said (4C), the mic blocked (4E), what Reason is doing (3D), playing a note.
// It talks to the conversation's own script through REASON_WEB.api (webconvo.js).
export const COMPOSE_JS = String.raw`(function(){
var R=window.REASON_WEB||{},A=R.api,form=document.querySelector('.cform');if(!form||!A)return;
var comp=form.closest('.composer'),box=document.getElementById('c-input'),add=form.querySelector('.c-add'),mic=form.querySelector('.c-mic'),upl=comp.querySelector('.upl'),shelf=comp.querySelector('.on-line'),fail=comp.querySelector('.upfail'),failList=comp.querySelector('.uf-list'),note=comp.querySelector('.c-note'),sheet=comp.querySelector('.addsheet'),fromVoice=comp.querySelector('.fromvoice'),moff=comp.querySelector('.micoff'),body=document.body,onit=document.querySelector('.onit');
var files=[],blobs={},noteT=0,LIM=R.lim||{each:20971520,fit:7340032,files:6};
function say(t){if(!note)return;note.textContent=t;note.hidden=!t;clearTimeout(noteT);if(t)noteT=setTimeout(function(){note.hidden=true},9000)}
R.say=say;
// 3D: what Reason is doing, from the server's own record of the turn (src/doing.js); plain "on it." otherwise.
R.doing=function(t){var h=onit&&onit.querySelector('.hand');if(h)h.textContent=t?String(t):'on it.'};
// The box grows with what's in it (4C), wherever the browser can't size it by itself.
function fit(){if(!box||(window.CSS&&CSS.supports&&CSS.supports('field-sizing','content')))return;box.style.height='auto';box.style.height=Math.min(box.scrollHeight,240)+'px'}
if(box){box.addEventListener('input',function(){fit();if(!box.value.trim())unvoice()});
box.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!e.altKey){e.preventDefault();if(box.value.trim()||files.some(function(f){return f.state!=='failed'})){form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true}))}}});
box.addEventListener('focus',function(){if(body.classList.contains('mic-off'))micOff(false)})}
function nameOf(f){var s=String(f.name||'').replace(/\.[A-Za-z0-9]{1,5}$/,'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
if(!s||s.length>40||/^(img|dsc|scan|pxl|photo|image|document|file|untitled|download|screenshot)[\s\d.()]*$/.test(s)||/^[\d\s.()]+$/.test(s)||!/[a-z]/.test(s))return f.kind==='image'?'the photo':f.kind==='video'?'the video':'the file';return 'the '+s}
function live(f){return f.state!=='failed'&&!f.hidden}
function sync(){var shown=files.filter(function(f){return !f.hidden}),ok=files.some(function(f){return f.state!=='failed'});
form.classList.toggle('has-files',ok);comp.classList.toggle('has-files',shown.length>0);box.required=!ok;upl.hidden=!shown.length;
var bad=files.filter(function(f){return f.state==='failed'});fail.hidden=!bad.length;failList.textContent='';
bad.forEach(function(f){var b=document.createElement('button');b.type='button';b.className='uf-retry';b.textContent=nameOf(f)+' didn’t upload. tap to try again.';b.onclick=function(){send1(f)};failList.appendChild(b)})}
function slip(f){var li=document.createElement('li');li.dataset.state=f.state;
if(f.kind==='image'){var th=document.createElement(f.preview?'img':'span');th.className='th';if(f.preview){th.src=f.preview;th.alt=''}li.appendChild(th)}
var tx=document.createElement('span');tx.className='tx';var n=document.createElement('span');n.className='nm';n.textContent=f.label;tx.appendChild(n);
if(f.state!=='failed'){var st=document.createElement('span');st.className='st2';st.textContent=f.state==='up'?'UPLOADING…':'READY';tx.appendChild(st)}li.appendChild(tx);
var x=document.createElement('button');x.type='button';x.className='rm';x.setAttribute('aria-label','Remove '+f.name);x.textContent='×';x.onclick=function(){files=files.filter(function(g){return g!==f});draw();box.focus()};li.appendChild(x);return li}
function draw(){shelf.textContent='';files.forEach(function(f){if(!f.hidden)shelf.appendChild(slip(f))});sync()}
function upload(blob,name,extra){var h={'X-Reason-Csrf':R.c,'X-Reason-Name':encodeURIComponent(name||''),'Content-Type':blob.type||'application/octet-stream',Accept:'application/json'};if(extra)for(var k in extra)h[k]=extra[k];
return fetch('/web/upload',{method:'POST',credentials:'same-origin',headers:h,body:blob}).then(function(r){return r.json().catch(function(){return{ok:false,error:r.status===413?'too_big':'failed'}}).then(function(j){j.status=r.status;return j})})}
function shrink(file){// A camera photo bigger than the model looks at, made smaller here when this browser can draw it (the server does the rest).
return new Promise(function(res){if(file.size<=LIM.fit||!/^image\/(jpeg|png|webp)$/.test(file.type))return res(file);var u=URL.createObjectURL(file),im=new Image();im.onload=function(){var s=Math.min(1,2560/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(function(b){res(b&&b.size<file.size?b:file)},'image/jpeg',.86)};im.onerror=function(){URL.revokeObjectURL(u);res(file)};im.src=u})}
// One file up. A failure keeps the slip with "didn't upload. tap to try again." and the limits (3C); send leaves it out.
function send1(f){var v=f.kind==='voice';f.state='up';if(v)f.hidden=true;draw();
if(f.file.size>LIM.each){f.wait=Promise.resolve();f.state='failed';f.hidden=false;draw();return}
f.wait=(v?Promise.resolve(f.file):shrink(f.file)).then(function(b){return upload(b,v?'voice-note':f.file.name,v?{'X-Reason-Voice':'1','X-Reason-Seconds':String(f.seconds||1)}:null)}).then(function(j){if(j.status===401){location.href='/web?out=1';return}
if(!j.ok){f.state='failed';f.hidden=false;draw();return}f.id=j.id;f.src=j.src;f.name=j.name;if(!v){f.kind=j.kind;f.label=j.label}f.state='ready';if(f.preview)blobs[j.id]=f.preview;draw()}).catch(function(){f.state='failed';f.hidden=false;draw()})}
function take(list){say('');Array.prototype.slice.call(list||[]).slice(0,Math.max(0,LIM.files-files.length)).forEach(function(file){
var img=/^image\//.test(file.type)||/\.(heic|heif)$/i.test(file.name),vid=/^video\//.test(file.type),f={file:file,name:file.name||'file',label:String(file.name||'file').toUpperCase(),kind:img?'image':vid?'video':'file',state:'up',preview:img&&/^image\/(jpeg|png|gif|webp)$/.test(file.type)?URL.createObjectURL(file):''};
files.push(f);send1(f)});if(files.length&&!matchMedia('(pointer:coarse)').matches)box.focus()}
// Hand the attached files to the message being sent: the ones that made it; the failed ones are left out (3C).
R.takeFiles=function(){var out=files.filter(function(f){return f.id&&f.state==='ready'}).map(function(f){return{id:f.id,kind:f.kind,name:f.name,label:f.label,src:f.src,seconds:f.seconds,preview:f.preview}});files=[];draw();unvoice(true);return out};
function clk(s){s=Math.max(0,Math.round(s||0));return Math.floor(s/60)+':'+('0'+s%60).slice(-2)}
// A message with files, drawn the moment it's sent (3D / 4D): photos framed, slips that open, a voice note's words then ▶.
R.drawFiles=function(li,p){var fs=p.files||[],v=null;
fs.forEach(function(f){if(f.kind==='image'){var a=document.createElement('div');a.className='photo';var im=document.createElement('img');im.alt='Photo you sent';im.src=(f.id&&blobs[f.id])||f.src||f.preview||'';a.appendChild(im);li.appendChild(a)}});
fs.forEach(function(f){if(f.kind==='voice'){v=f;return}if(f.kind==='image')return;var s=document.createElement(f.src?'a':'span');s.className='slip fslip';if(f.src){s.href=f.src;s.target='_blank';s.rel='noopener'}var n=document.createElement('span');n.className='fn';n.textContent=f.label||String(f.name||'').toUpperCase();s.appendChild(n);if(f.src){var o=document.createElement('span');o.className='fs';o.textContent='TAP TO OPEN';s.appendChild(o)}li.appendChild(s)});
if(v){if(p.text){var w=document.createElement('p');w.className='said hand';w.textContent=p.text;li.appendChild(w)}var b=document.createElement('button');b.type='button';b.className='vplay';b.dataset.src=(v.id&&blobs[v.id])||v.src||v.preview||'';b.setAttribute('aria-label','Play voice note'+(v.seconds?', '+v.seconds+' seconds':''));b.innerHTML=${JSON.stringify(PLAY_SVG + WAVE_SVG + `<span class="vt"></span>`)};b.querySelector('.vt').textContent=v.seconds?clk(v.seconds):'';li.appendChild(b)}
else if(p.text){var s=document.createElement('div');s.className='said';s.textContent=p.text;li.appendChild(s)}};
form.addEventListener('submit',function(e){if(files.some(function(f){return f.state==='up'})){e.preventDefault();e.stopImmediatePropagation();Promise.all(files.map(function(f){return f.wait})).then(function(){if(files.some(function(f){return f.state==='ready'})||box.value.trim())form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true}))})}},true);
// ---- + and its sheet (3A), and the drop (3E) ----
var picks={};comp.querySelectorAll('.c-file').forEach(function(i){picks[i.dataset.pick]=i;i.onchange=function(){take(i.files);i.value=''}});
function sheetOpen(on){sheet.hidden=!on;comp.classList.toggle('sheet-on',!!on);add.setAttribute('aria-expanded',on?'true':'false');if(on)sheet.querySelector('.as-pick').focus()}
if(add&&sheet&&window.fetch){add.hidden=false;add.onclick=function(){sheetOpen(sheet.hidden)};
sheet.querySelectorAll('.as-pick').forEach(function(b){b.onclick=function(){sheetOpen(false);var i=picks[b.dataset.pick];if(i)i.click();add.focus()}});
sheet.querySelector('.as-never').onclick=function(){sheetOpen(false);add.focus()};
document.addEventListener('keydown',function(e){if(sheet.hidden)return;if(e.key==='Escape'){e.preventDefault();sheetOpen(false);add.focus()}else if(e.key==='Tab'){var f=sheet.querySelectorAll('button'),a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}});
document.addEventListener('pointerdown',function(e){if(!sheet.hidden&&!sheet.contains(e.target)&&!add.contains(e.target))sheetOpen(false)});
var depth=0;function hasFiles(e){var t=e.dataTransfer&&e.dataTransfer.types;return !!t&&Array.prototype.indexOf.call(t,'Files')>=0}
document.addEventListener('dragenter',function(e){if(!hasFiles(e))return;e.preventDefault();depth++;body.classList.add('dropping')});
document.addEventListener('dragover',function(e){if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy'});
document.addEventListener('dragleave',function(e){if(!hasFiles(e))return;depth=Math.max(0,depth-1);if(!depth)body.classList.remove('dropping')});
document.addEventListener('drop',function(e){if(!hasFiles(e))return;e.preventDefault();depth=0;body.classList.remove('dropping');take(e.dataTransfer.files)});
box.addEventListener('paste',function(e){var it=e.clipboardData&&e.clipboardData.files;if(it&&it.length){e.preventDefault();take(it)}})}
// ---- 4C: what was said, in the box to edit; the recording goes with it ----
function unvoice(sent){if(!comp.classList.contains('voiced'))return;comp.classList.remove('voiced');fromVoice.hidden=true;if(!sent){files=files.filter(function(f){return f.kind!=='voice'});draw()}}
function voiced(words,blob,seconds){var url=URL.createObjectURL(blob),f={file:blob,name:'voice note',label:'VOICE NOTE',kind:'voice',hidden:true,seconds:seconds,preview:url,state:'up'};files=files.filter(function(g){return g.kind!=='voice'});files.push(f);send1(f);
box.value=words;comp.classList.add('voiced');fromVoice.hidden=false;fit();box.focus();try{box.setSelectionRange(box.value.length,box.value.length)}catch(x){}}
// ---- 4E: the mic blocked ----
var lastFull=false;
function micOff(on){body.classList.toggle('mic-off',!!on);if(on){var h=moff.querySelector('.mo-h');h.focus()}}
if(moff)moff.querySelector('.mo-try').onclick=function(){micOff(false);start(lastFull)};
// ---- the mic ----
var SR=window.SpeechRecognition||window.webkitSpeechRecognition,MR=window.MediaRecorder,GUM=navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;
if(!mic||!MR||!GUM||!window.isSecureContext||!(SR||R.hear))return;
mic.hidden=false;
var dict=comp.querySelector('.dict'),dclock=dict.querySelector('.d-clock'),bars=dict.querySelector('.d-bars'),ls=document.querySelector('.listen'),lsT=ls&&ls.querySelector('.ls-t'),lsF=ls&&ls.querySelector('.ls-fin'),lsI=ls&&ls.querySelector('.ls-int'),lsN=ls&&ls.querySelector('.ls-cn'),lsD=ls?ls.querySelectorAll('.ls-dots i'):[];
var rec=null;
function pickType(){var t=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'];for(var i=0;i<t.length;i++)if(MR.isTypeSupported&&MR.isTypeSupported(t[i]))return t[i];return''}
function mode(m){if(ls)ls.dataset.mode=m;var f=m==='paused'?ls.querySelector('.ls-now'):m==='listening'?ls.querySelector('.ls-send'):null;if(f)f.focus()}
function blocked(r){r.done=true;if(rec===r)rec=null;clearInterval(r.tick);clearInterval(r.cd);if(r.stream)r.stream.getTracks().forEach(function(t){t.stop()});close();lastFull=r.full;micOff(true)}
function start(full){if(rec)return;say('');lastFull=full;var r=rec={full:full,t0:Date.now(),held:0,chunks:[],fin:'',int:'',keep:'',levels:[],spoke:false,last:Date.now(),done:false};
GUM.call(navigator.mediaDevices,{audio:true}).then(function(stream){if(r.done){stream.getTracks().forEach(function(t){t.stop()});return}r.stream=stream;var type=pickType();try{r.mr=type?new MR(stream,{mimeType:type}):new MR(stream)}catch(x){r.mr=new MR(stream)}
r.mr.ondataavailable=function(e){if(e.data&&e.data.size)r.chunks.push(e.data)};r.mr.start(250);
try{var AC=window.AudioContext||window.webkitAudioContext;r.ac=new AC();var src=r.ac.createMediaStreamSource(stream);r.an=r.ac.createAnalyser();r.an.fftSize=512;src.connect(r.an);r.buf=new Uint8Array(r.an.fftSize)}catch(x){}
if(SR){try{var s=r.sr=new SR();s.continuous=true;s.interimResults=true;s.lang=navigator.language||'en-US';
s.onresult=function(e){var f='',n='';for(var i=0;i<e.results.length;i++){var x=e.results[i][0].transcript;if(e.results[i].isFinal)f+=x;else n+=x}r.fin=(r.keep+f).trim();r.int=n;r.last=Date.now();r.spoke=true;words()};
s.onend=function(){if(r.ended)r.ended();if(!r.done&&!r.paused){r.keep=(r.fin?r.fin+' ':'');try{s.start()}catch(x){}}};
s.onerror=function(e){if(e.error==='not-allowed'||e.error==='service-not-allowed'){r.sr=null;if(!R.hear)blocked(r)}};s.start()}catch(x){r.sr=null}}
r.tick=setInterval(tick,100)}).catch(function(e){var n=e&&e.name;if(n==='NotAllowedError'||n==='SecurityError'||n==='PermissionDeniedError'){blocked(r);return}r.done=true;rec=null;close();say("i can't hear you here. there's no microphone i can use.")});
if(full)openFull();else{comp.classList.add('dictating');dict.hidden=false;dclock.textContent='0:00';bars.setAttribute('d','');dict.querySelector('.d-send').focus()}}
function words(){if(!ls||!rec)return;lsF.textContent=rec.fin;lsI.textContent=rec.int}
function secs(r){return(Date.now()-r.t0-r.held-(r.paused?Date.now()-r.pauseAt:0))/1000}
function tick(){var r=rec;if(!r||r.paused)return;var s=secs(r);dclock.textContent=clk(s);if(lsT)lsT.textContent=clk(s);
var lvl=0;if(r.an){r.an.getByteTimeDomainData(r.buf);var sum=0;for(var i=0;i<r.buf.length;i++){var v=(r.buf[i]-128)/128;sum+=v*v}lvl=Math.sqrt(sum/r.buf.length)}
if(!r.sr&&lvl>0.04){r.spoke=true;r.last=Date.now()}
if(Date.now()-(r.lt||0)>160){r.lt=Date.now();r.levels.push(lvl);if(r.levels.length>29)r.levels.shift();var d='';r.levels.forEach(function(l,i){var h=Math.max(2,Math.min(28,Math.round(l*90)));var x=4+i*8;d+='M'+x+' '+(16-h/2)+'v'+h});bars.setAttribute('d',d)}
// Pausing (4B): once they've said something and gone quiet for a moment, it's about to send, with a way out.
if(r.full&&r.spoke&&Date.now()-r.last>2600&&(!r.sr||r.fin||r.int))pause();
if(s>300)finish('send')}
function openFull(){if(!ls)return;lsF.textContent='';lsI.textContent='';lsT.textContent='0:00';ls.hidden=false;body.classList.add('listening');mode('listening')}
function close(){comp.classList.remove('dictating');dict.hidden=true;if(ls){ls.hidden=true;body.classList.remove('listening')}}
function srDone(r){// The browser's last words, once it has stopped listening (a moment at most).
return new Promise(function(res){if(!r.sr)return res();var t=setTimeout(res,1200);r.ended=function(){clearTimeout(t);r.ended=null;res()};try{r.sr.stop()}catch(x){clearTimeout(t);res()}})}
function soFar(r){return new Promise(function(res){if(!r.mr||r.mr.state==='inactive')return res();var h=function(){r.mr.removeEventListener('dataavailable',h);setTimeout(res,0)};r.mr.addEventListener('dataavailable',h);try{r.mr.requestData()}catch(x){r.mr.removeEventListener('dataavailable',h);res()}})}
function blobOf(r){return r.chunks.length?new Blob(r.chunks,{type:(r.mr&&r.mr.mimeType)||r.chunks[0].type||'audio/webm'}):null}
function pause(){var r=rec;if(!r||r.paused||r.done)return;r.paused=true;r.pauseAt=Date.now();r.early=null;try{r.mr&&r.mr.state==='recording'&&r.mr.pause()}catch(x){}
if(r.sr){srDone(r).then(function(){if(rec!==r||!r.paused)return;r.fin=(r.fin+' '+r.int).replace(/\s+/g,' ').trim();r.int='';words();countdown(r)})}
else{// No words from the browser (Firefox): written down on the server first (L9), then shown (4B).
mode('writing');soFar(r).then(function(){var b=blobOf(r);if(!b||!b.size)return null;return upload(b,'voice-note',{'X-Reason-Voice':'1','X-Reason-Hear':'1','X-Reason-Seconds':String(Math.max(1,Math.round(secs(r))))})}).then(function(j){if(rec!==r||!r.paused)return;if(j&&j.status===401){location.href='/web?out=1';return}
if(j&&j.ok){r.early={id:j.id,src:j.src,name:j.name,chunks:r.chunks.length};r.fin=j.words||''}words();countdown(r)}).catch(function(){if(rec===r&&r.paused)countdown(r)})}}
function countdown(r){mode('paused');var n=3;function show(){lsN.textContent='SENDING IN '+n+'…';for(var i=0;i<lsD.length;i++)lsD[i].className=i<n?'':'off'}show();clearInterval(r.cd);r.cd=setInterval(function(){if(rec!==r||!r.paused){clearInterval(r.cd);return}n--;if(n<=0){clearInterval(r.cd);finish('send')}else show()},1000)}
function keepTalking(){var r=rec;if(!r||!r.paused)return;clearInterval(r.cd);r.held+=Date.now()-r.pauseAt;r.paused=false;r.spoke=false;r.last=Date.now();r.early=null;try{r.mr&&r.mr.state==='paused'&&r.mr.resume()}catch(x){}
if(r.sr){r.keep=r.fin?r.fin+' ':'';try{r.sr.start()}catch(x){}}mode('listening')}
// The end of a recording: 'send' sends it, 'edit' puts the words in the box (4C), anything else lets it go.
function finish(how){var r=rec;if(!r||r.done)return;r.done=true;rec=null;clearInterval(r.tick);clearInterval(r.cd);var seconds=Math.max(1,Math.round(secs(r)));
var send=how==='send'||how==='edit';var wait=send&&r.sr&&!r.paused&&(r.int||'').trim()?(mode('writing'),srDone(r)):Promise.resolve();
wait.then(function(){try{r.sr&&r.sr.stop()}catch(x){}close();var said=((r.fin||'')+' '+(r.int||'')).replace(/\s+/g,' ').trim().slice(0,R.max||4000);
var done=function(){if(r.stream)r.stream.getTracks().forEach(function(t){t.stop()});try{r.ac&&r.ac.close()}catch(x){}if(!send){mic.focus();return}
var blob=blobOf(r);
if(how==='edit'){if(!blob||!blob.size){box.value=said;fit();box.focus();return}voiced(said,blob,seconds);return}
if(!blob||!blob.size){if(said){A.post({id:A.uid(),text:said});return}say("i didn't catch that.");return}
if(!said&&!R.hear){say("i didn't catch that.");return}
var url=URL.createObjectURL(blob),p={id:A.uid(),text:said,voice:seconds,files:[{kind:'voice',name:'voice-note',label:'VOICE NOTE',seconds:seconds,preview:url}]},li=A.pendingLine(p);
var e=r.early&&r.early.chunks===r.chunks.length?r.early:null;
var go=function(){A.state(li,'sending');(e?Promise.resolve({ok:true,id:e.id,src:e.src,name:e.name}):upload(blob,'voice-note',{'X-Reason-Voice':'1','X-Reason-Seconds':String(seconds)})).then(function(j){if(j.status===401){location.href='/web?out=1';return}if(!j.ok){A.state(li,'failed');return}
p.files=[{id:j.id,kind:'voice',name:j.name,label:'VOICE NOTE',seconds:seconds,src:j.src}];blobs[j.id]=url;A.post(p,li)}).catch(function(){A.state(li,'failed')})};li.retry=go;go()};
if(r.mr&&r.mr.state!=='inactive'){r.mr.onstop=done;try{r.mr.stop()}catch(x){done()}}else done()})}
// A tap dictates on the line (03); holding the mic opens Listening (4A).
var held=0;mic.addEventListener('pointerdown',function(e){if(e.button)return;held=setTimeout(function(){held=-1;start(true)},450)});
mic.addEventListener('pointerup',function(){if(held>0){clearTimeout(held);held=0}});mic.addEventListener('pointerleave',function(){if(held>0){clearTimeout(held);held=0}});
mic.addEventListener('contextmenu',function(e){e.preventDefault()});
mic.addEventListener('click',function(){if(held===-1){held=0;return}held=0;start(false)});
dict.querySelector('.d-send').onclick=function(){finish('send')};dict.querySelector('.d-stop').onclick=function(){finish(false)};
if(ls){ls.querySelector('.ls-send').onclick=function(){finish('send')};ls.querySelector('.ls-never').onclick=function(){finish(false)};
ls.querySelector('.ls-keep').onclick=keepTalking;ls.querySelector('.ls-edit').onclick=function(){finish('edit')};ls.querySelector('.ls-now').onclick=function(){finish('send')}}
document.addEventListener('keyup',function(e){if(rec&&rec.full&&(e.key===' '||e.code==='Space'))e.preventDefault()},true);
document.addEventListener('keydown',function(e){if(!rec)return;if(e.key==='Escape'){e.preventDefault();finish(false)}else if(rec.full&&(e.key===' '||e.code==='Space')){e.preventDefault();if(rec.paused)keepTalking();else rec.last=Date.now()}
else if(rec.full&&e.key==='Tab'){var f=Array.prototype.filter.call(ls.querySelectorAll('button'),function(b){return b.offsetParent!==null}),a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}});
})();
// Playing a voice note in the thread: one at a time.
(function(){var cur=null;document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('.vplay');if(!b)return;
if(cur&&cur.b===b){if(cur.a.paused)cur.a.play();else cur.a.pause();return}if(cur){cur.a.pause();cur.b.setAttribute('aria-pressed','false')}
var a=new Audio(b.dataset.src),t=b.querySelector('.vt');cur={a:a,b:b};a.onplay=function(){b.setAttribute('aria-pressed','true')};a.onpause=a.onended=function(){b.setAttribute('aria-pressed','false')};
a.onloadedmetadata=function(){if(t&&!t.textContent&&isFinite(a.duration)){var s=Math.round(a.duration);t.textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2)}};a.play().catch(function(){})})})();`;
