// The paper form kit: the parts of a "line on paper" screen, from the card and store sign-in design
// handoff (2026-10-30, reason-card-and-store-signin: README "Design rules", tokens.json). Used by the
// Connect pages (src/pages/webconnect.js) and Settings → Shopping (src/pages/websettings.js).
//
//   frame       wordmark header, then two columns (the form, and a margin column behind a dashed rule)
//               that stack under 700px, the margin moving under a dashed top rule
//   field       a typed label over a line: 1.5px ink underline; active = 2px solid pen and the label
//               in pen; error = 2px dashed pen, aria-invalid, and a handwritten note it points at
//   slot        the same line around a sealed field (Crossmint's iframe mounts inside): focus inside
//               the iframe is focus on the iframe element here, so :focus-within draws the red line
//   note        one Caveat line in pen, tilted −1°
//   go / two / forget   primary (serif italic →), secondary (typed caps), destructive (serif italic pen)
//   paper       the one lifted thing on a screen, with a rubber stamp at −3°
//   steps       a checklist of real steps: ✓ done, ○ in pen = now, ○ muted = not yet
//   codeInput   six cells that take one digit each, or the whole code pasted into any of them
//
// Every value comes from tokens.json through the kit's variables (src/pages/webkit.js TOKENS: --ground
// bg, --lifted paper, --ink text, --muted text-secondary, --hair border, --pen stamp, --sh2
// shadow-stage / shadow-night), so Paper and Night paper both follow.
import { esc } from "./render.js";
import { wordmark, action, typed } from "./webkit.js";

// tokens.json spacing / radius, by name.
const SPACE = "--max-w:1120px;--gutter:1.25rem;--gutter-wide:3rem;--part-gap:56px;--message-gap:40px;--label-gap:.75rem;--card-pad:2rem;--radius:4px;--radius-btn:3px";

export const PAPER_CSS = `
:root{${SPACE}}
.pf-hd{width:100%;max-width:calc(var(--max-w) + 2 * clamp(var(--gutter),4vw,var(--gutter-wide)));margin:0 auto;padding:0 clamp(var(--gutter),4vw,var(--gutter-wide));height:88px;display:flex;align-items:center;justify-content:space-between}
.pf-hd .wm{font-size:30px}
.pf{flex:1 0 auto;width:100%;max-width:calc(var(--max-w) + 2 * clamp(var(--gutter),4vw,var(--gutter-wide)));margin:0 auto;padding:0 clamp(var(--gutter),4vw,var(--gutter-wide)) 80px}
.pf-mn{padding-top:72px;display:flex;flex-wrap:wrap;gap:64px}
.pf-col{flex:999 1 520px;min-width:0;max-width:620px;display:flex;flex-direction:column}
.pf-as{flex:1 1 280px;min-width:0;max-width:360px;padding-left:40px;border-left:1px dashed var(--hair);display:flex;flex-direction:column;gap:14px;align-self:flex-start;margin-top:12px}
.pf .h1{font:italic 400 clamp(2.6rem,6vw,4.5rem)/1.08 var(--serif);letter-spacing:-.02em}
.pf .h1 em{color:var(--muted)}
.pf-lede{margin:24px 0 0;max-width:480px;font-size:1.15rem;line-height:1.55;color:var(--muted)}
.pf-l{margin:0;font:400 11px/1.6 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);-webkit-font-smoothing:auto}
.pf-l.pen{color:var(--pen)}
.pf-p{margin:0;font-size:16px;line-height:1.6}
.pf-p.mut{color:var(--muted)}
.pf-sp{margin-top:20px}
.pf-note{display:block;margin:0;font:400 1.3rem/1.3 var(--hand);color:var(--pen);transform:rotate(-1deg);transform-origin:left center}
.pf-form{margin:64px 0 0;display:flex;flex-direction:column;gap:40px}
.pf-fld{display:flex;flex-direction:column;gap:6px;min-width:0}
.pf-fld>label,.pf-fld>.pf-l{display:flex;align-items:center;justify-content:space-between;gap:12px}
.pf-seal{display:inline-flex;align-items:center;gap:6px;color:var(--pen)}
.pf-seal svg{width:12px;height:14px}
.pf-in{width:100%;height:52px;padding:0 2px;border:0;border-bottom:1.5px solid var(--ink);border-radius:0;background:transparent;font:400 20px/1 var(--sans);color:var(--ink);outline:none;-webkit-appearance:none;appearance:none}
.pf-in.mono{font:400 24px/1 var(--mono);letter-spacing:.08em}
.pf-in::placeholder{color:var(--muted);opacity:1}
.pf-in:hover,.pf-slot:hover{border-bottom-color:var(--pen)}
.pf-in:focus,.pf-slot:focus-within{border-bottom:2px solid var(--pen)}
.pf-fld:focus-within>label,.pf-fld:focus-within>.pf-l,.pf-fld.err>label,.pf-fld.err>.pf-l,.pf-cells-f:focus-within>legend,.pf-cells-f.err>legend{color:var(--pen)}
.pf-fld.err .pf-in,.pf-fld.err .pf-slot,.pf-cells-f.err .pf-in{border-bottom:2px dashed var(--pen)}
.pf-slot{min-height:52px;border-bottom:1.5px solid var(--ink);display:flex;align-items:center}
.pf-slot>*{flex:1;min-width:0}
.pf-slot iframe{width:100%!important;display:block}
.pf-slot .pf-in{border-bottom:0!important}
.pf-slot.code{min-height:72px}
.pf-slot.code .pf-in{height:72px;font:400 40px/1 var(--mono);letter-spacing:.4em}
.pf-sealed{display:flex;flex-direction:column;gap:40px}
.pf-sealed .pf-sl{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px dashed var(--hair)}
.pf-card-slot{min-height:300px}
.pf-card-slot iframe{width:100%!important;display:block}
.pf-g2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}
.pf-acts{margin-top:16px;display:flex;flex-wrap:wrap;align-items:center;gap:12px 40px}
.pf-acts+.pf-l,.pf-acts+.pf-note{margin-top:-24px}
.pf-go{min-height:48px;font-size:34px;line-height:1.15}
.pf-two{min-height:44px;font-size:12px;color:var(--muted)}
.pf-two:hover{color:var(--ink)}
.pf-x{min-height:48px;display:inline-flex;align-items:center;border:0;background:transparent;padding:0;cursor:pointer;text-decoration:none;font:italic 400 34px/1.15 var(--serif);color:var(--pen)}
.pf-x:hover{color:var(--ink)}
.pf-x:focus-visible{outline-color:var(--pen)}
.pf-paper{margin-top:var(--part-gap);background:var(--lifted);border:1px solid var(--hair);border-radius:var(--radius);box-shadow:var(--sh2);padding:var(--card-pad);position:relative}
.pf-stamp{position:absolute;top:-16px;right:24px;background:var(--lifted);font:700 13px/1.3 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--pen);border:2px solid var(--pen);border-radius:var(--radius-btn);padding:6px 12px;transform:rotate(-3deg)}
.pf-big{margin:8px 0 0;font:400 26px/1.3 var(--mono);letter-spacing:.08em}
.pf-big.t{font:400 26px/1.3 var(--sans);letter-spacing:0}
.pf-steps{margin:var(--part-gap) 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:18px;font-size:18px;line-height:1.5}
.pf-steps li{display:flex;gap:.7em}
.pf-steps .m{flex:none;width:1em;text-align:center}
.pf-steps .now .m{color:var(--pen)}
.pf-steps .todo{color:var(--muted)}
.pf-as .pf-steps{margin:0;gap:6px;font-size:16px;line-height:1.6}
.pf-rows{margin-top:var(--part-gap);border-top:1px dashed var(--hair)}
.pf-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 16px;padding:20px 0;border-bottom:1px dashed var(--hair)}
.pf-row form{margin:0}
.pf-cells-f{margin:0;padding:0;border:0;min-width:0;display:flex;flex-direction:column;gap:10px}
.pf-cells-f>legend{padding:0;margin-bottom:10px}
.pf-cells{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px;max-width:460px}
.pf-cells .pf-in{height:72px;padding:0;text-align:center;font:400 40px/1 var(--mono);letter-spacing:0}
.pf-off{position:absolute!important;left:-10000px!important;top:0!important;width:600px!important;height:1px!important;overflow:hidden!important}
.pf .pf-step:focus{outline:none}
@media (max-width:700px){
.pf-hd{height:72px}.pf-hd .wm{font-size:26px}
.pf-mn{padding-top:32px;gap:48px}
.pf-as{padding:32px 0 0;border-left:0;border-top:1px dashed var(--hair);max-width:none;margin-top:0}
.pf-form{margin-top:48px}
.pf-go,.pf-x{font-size:30px}
.pf-g2{gap:20px}
.pf-paper{padding:24px}.pf-stamp{right:16px}
.pf-cells{gap:10px}.pf-cells .pf-in{height:60px;font-size:32px}
}
`;

// ---------------------------------------------------------------- parts
/** The page's header: the wordmark, home. */
export const header = () => `<header class="pf-hd">${wordmark({ href: "/web?home" })}</header>`;

/**
 * One screen: the main column and its margin column. `step` names it when a page holds several
 * screens and its script moves between them (only the first is shown at load: `off` hides the rest
 * while keeping anything mounted in them, like Crossmint's iframe, alive).
 */
export function frame({ main, margin = "", step = "", off = false, label = "" }) {
  const attrs = step ? ` data-step="${esc(step)}" tabindex="-1"${off ? " inert" : ""}` : "";
  return `<div class="pf-mn${step ? " pf-step" : ""}${off ? " pf-off" : ""}"${attrs}><section class="pf-col"${label ? ` aria-label="${esc(label)}"` : ""}>${main}</section>`
    + (margin ? `<aside class="pf-as">${margin}</aside>` : "") + `</div>`;
}
/** The headline that turns once: a plain line, then the turn in <em>. Both escaped. */
export const headline = (plain, turn = "", id = "") =>
  `<h1 class="h1"${id ? ` id="${esc(id)}"` : ""}>${esc(plain)}${turn ? `<br><em>${esc(turn)}</em>` : ""}</h1>`;
export const lede = (text) => `<p class="pf-lede">${esc(text)}</p>`;
/** A typed label. `pen` for the one that matters (I NEVER SEE). */
export const label = (text, { pen = false, sp = false, tag = "span" } = {}) =>
  `<${tag} class="pf-l${pen ? " pen" : ""}${sp ? " pf-sp" : ""}">${esc(text)}</${tag}>`;
export const para = (html, { muted = false } = {}) => `<p class="pf-p${muted ? " mut" : ""}">${html}</p>`;
/** The margin voice. `id` when a field's aria-describedby points at it. */
export const note = (text, { id = "", role = "", sp = false, hidden = false } = {}) =>
  `<p class="pf-note${sp ? " pf-sp" : ""}"${id ? ` id="${esc(id)}"` : ""}${role ? ` role="${esc(role)}"` : ""}${hidden ? " hidden" : ""}>${esc(text)}</p>`;

const LOCK = `<svg viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
/** "SEALED", only ever beside a field that really is sealed (Crossmint's own iframe). */
export const sealed = (text = "SEALED") => `<span class="pf-seal">${LOCK}<span>${esc(text)}</span></span>`;

/**
 * An underlined field of ours: label, input, and the error note (aria-invalid + aria-describedby).
 * `input` is the attribute string for the <input> (type, autocomplete, name…); `mono` for numbers.
 */
export function field({ id, label: text, attrs = "", error = "", hint = "", mono = false }) {
  const desc = error ? `${id}-e` : hint ? `${id}-h` : "";
  return `<div class="pf-fld${error ? " err" : ""}"><label class="pf-l" for="${esc(id)}">${esc(text)}</label>`
    + `<input class="pf-in${mono ? " mono" : ""}" id="${esc(id)}"${attrs}${error ? ` aria-invalid="true"` : ""}${desc ? ` aria-describedby="${esc(desc)}"` : ""}>`
    + (error ? note(error, { id: `${id}-e` }) : hint ? note(hint, { id: `${id}-h` }) : "") + `</div>`;
}
/**
 * A sealed field: the same line, drawn around a slot that Crossmint's iframe mounts into. The label is
 * ours (the iframe holds only the input); SEALED sits beside it. `inner` is a staging stand-in, or "".
 */
export function slot({ id, label: text, attrs = "", error = "", code = false, inner = "" }) {
  return `<div class="pf-fld${error ? " err" : ""}"><span class="pf-l" id="${esc(id)}-l">${esc(text)}${sealed()}</span>`
    + `<div class="pf-slot${code ? " code" : ""}"${attrs} role="group" aria-labelledby="${esc(id)}-l"${error ? ` aria-describedby="${esc(id)}-e"` : ""}>${inner}</div>`
    + (error ? note(error, { id: `${id}-e` }) : "") + `</div>`;
}

/** Primary: serif italic with →. A link, or a submit button. */
export const go = (text, opts = {}) => action(text, { ...opts, cls: `pf-go${opts.cls ? ` ${opts.cls}` : ""}` });
/** Secondary: typed capitals. Defaults to a plain button (never a submit by accident). */
export const two = (text, opts = {}) => typed(text, { type: "button", ...opts, cls: `pf-two${opts.cls ? ` ${opts.cls}` : ""}` });
/** Destructive ("Forget it"): serif italic in pen, no arrow. */
export const forget = (text, { href = "", type = "submit", attrs = "" } = {}) => href
  ? `<a class="pf-x" href="${esc(href)}"${attrs}>${esc(text)}</a>`
  : `<button class="pf-x" type="${esc(type)}"${attrs}>${esc(text)}</button>`;
export const actions = (...parts) => `<div class="pf-acts">${parts.filter(Boolean).join("")}</div>`;

/** The one lifted thing: a typed label, the fact in big type, and a rubber stamp at −3°. */
export function paper({ stamp = "", label: text = "", big = "", mono = true, extra = "" }) {
  return `<div class="pf-paper">${stamp ? `<span class="pf-stamp">${esc(stamp)}</span>` : ""}${text ? label(text) : ""}`
    + (big ? `<p class="pf-big${mono ? "" : " t"}">${esc(big)}</p>` : "") + `${extra}</div>`;
}

/** A checklist of real steps. Each: [text, "done" | "now" | "todo"]. role=list so it reads as one. */
export function steps(list, { id = "", live = false } = {}) {
  const mark = { done: "✓", now: "○", todo: "○" };
  const said = { done: "done", now: "now", todo: "not yet" };
  return `<ol class="pf-steps"${id ? ` id="${esc(id)}"` : ""}${live ? ` aria-live="polite"` : ""}>${list.map(([t, s]) => `<li class="${s}"><span class="m" aria-hidden="true">${mark[s]}</span><span>${esc(t)}<span class="sr"> (${said[s]})</span></span></li>`).join("")}</ol>`;
}

/**
 * Six cells, one digit each, that also take the whole code pasted (or autofilled) into any of them.
 * The answer rides in one hidden input named `name`; the cells themselves are never submitted.
 */
export function codeInput({ name, legend, digits = 6, error = "", hint = "", id = "code" }) {
  const desc = error ? `${id}-e` : hint ? `${id}-h` : "";
  const cells = Array.from({ length: digits }, (_, i) => `<input class="pf-in" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${digits}" aria-label="Digit ${i + 1} of ${digits}"${i === 0 ? ` autocomplete="one-time-code"` : ` autocomplete="off"`}${error ? ` aria-invalid="true"` : ""}${desc ? ` aria-describedby="${esc(desc)}"` : ""}>`).join("");
  return `<fieldset class="pf-cells-f${error ? " err" : ""}" data-code="${digits}"><legend class="pf-l">${esc(legend)}</legend>`
    + `<div class="pf-cells">${cells}</div><input type="hidden" name="${esc(name)}" value="">`
    + (error ? note(error, { id: `${id}-e` }) : hint ? note(hint, { id: `${id}-h` }) : "") + `</fieldset>`;
}
/** The cells' behaviour: one digit per cell, a paste or autofill spreads across them, ← and ⌫ move back. */
export const CODE_JS = `(function(){document.querySelectorAll('[data-code]').forEach(function(f){var cs=[].slice.call(f.querySelectorAll('.pf-cells input')),out=f.querySelector('input[type=hidden]');
function sync(){out.value=cs.map(function(c){return c.value}).join('')}
function fill(from,s){var d=String(s).replace(/\\D/g,'').split('');for(var i=from;i<cs.length&&d.length;i++)cs[i].value=d.shift();sync();var n=cs.filter(function(c){return !c.value})[0]||cs[cs.length-1];n.focus()}
cs.forEach(function(c,i){c.addEventListener('paste',function(e){var t=(e.clipboardData||window.clipboardData).getData('text');if(!t)return;e.preventDefault();fill(t.replace(/\\D/g,'').length>=cs.length?0:i,t)});
c.addEventListener('input',function(){var v=c.value.replace(/\\D/g,'');if(v.length>1){c.value='';fill(v.length>=cs.length?0:i,v);return}c.value=v;sync();if(v&&cs[i+1])cs[i+1].focus()});
c.addEventListener('keydown',function(e){if(e.key==='Backspace'&&!c.value&&cs[i-1]){cs[i-1].focus();cs[i-1].value='';sync();e.preventDefault()}else if(e.key==='ArrowLeft'&&cs[i-1]){cs[i-1].focus();e.preventDefault()}else if(e.key==='ArrowRight'&&cs[i+1]){cs[i+1].focus();e.preventDefault()}})})})})();`;

/**
 * Moving between the screens a page holds (frame `step`): show one, hide the rest (kept mounted),
 * and put focus on the shown one's headline. `[data-show=name]` anywhere moves there; so does a
 * #step-name address (how the staging pages open a later screen).
 */
export const STEP_JS = `(function(){window.pfShow=function(n){var hit=null;document.querySelectorAll('.pf-step').forEach(function(s){var on=s.getAttribute('data-step')===n;s.classList.toggle('pf-off',!on);if(on){s.removeAttribute('inert');hit=s}else s.setAttribute('inert','')});if(hit){scrollTo(0,0);var h=hit.querySelector('h1');(h||hit).setAttribute('tabindex','-1');(h||hit).focus()}};
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-show]');if(!b)return;e.preventDefault();pfShow(b.getAttribute('data-show'))});
var m=/^#step-([a-z]+)$/.exec(location.hash);if(m&&document.querySelector('.pf-step[data-step="'+m[1]+'"]'))pfShow(m[1])})();`;
