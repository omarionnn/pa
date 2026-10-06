// Blocks in, HTML out. This is the only place a page becomes markup.
//
// Everything the model supplied is escaped on the way through — text, titles, captions, table
// cells, labels, and every URL attribute. There is no path by which a string from a tool result
// becomes a tag, an attribute boundary, or a script, which is why the content checker can allow
// free text at all.
//
// Mobile first, because a page is opened from a text message on a phone. One column, big tap
// targets, system fonts, no webfonts, no external anything, no JavaScript except the few lines
// that post a choice back. It has to look decent on a four-year-old phone on bad signal.
import { stamp } from "../config.js";

/** The only escaping function. Used on every single interpolated value. */
export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A URL safe to put in an attribute, or "" if it is not one. Belt and braces: the content checker
 * already parsed these, but render is the last gate before the browser and `javascript:` in an
 * href is the oldest trick there is.
 */
function safeUrl(v, { httpsOnly = false } = {}) {
  try {
    const u = new URL(String(v));
    if (httpsOnly ? u.protocol !== "https:" : !["https:", "http:"].includes(u.protocol)) return "";
    return esc(u.href);
  } catch { return ""; }
}

// Paragraphs from the model's text, with single newlines kept as line breaks. Escaped first, so
// the <br> and </p> below are the only tags that can possibly come out of this.
function paragraphs(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// The word a state is shown as, and the set of state words that have a style. Both are maps keyed
// by the fixed list in content.js, which is what keeps a string the model chose out of a class
// name: an unknown state falls back to a known one rather than being interpolated.
const STATUS_WORD = {
  working: "Working on it",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Broke",
  stopped: "Stopped",
  queued: "Queued",
};
const STATUS_CLASS = STATUS_WORD;
const STEP_CLASS = new Set(["done", "now", "waiting", "failed", "plain"]);

function block(b, { interactive, picked }) {
  switch (b.type) {
    case "section":
      return `<h2>${esc(b.title)}</h2>`;

    case "text":
      return `<div class="t">${paragraphs(b.text)}</div>`;

    case "image": {
      const url = safeUrl(b.url, { httpsOnly: true });
      if (!url) return "";
      return `<figure><img src="${url}" alt="${esc(b.caption ?? "")}" loading="lazy">`
        + (b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : "")
        + `</figure>`;
    }

    case "table": {
      const head = b.columns.map(c => `<th>${esc(c)}</th>`).join("");
      const body = b.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
      return (b.title ? `<h3>${esc(b.title)}</h3>` : "")
        + `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    case "links": {
      const items = b.items.map(it => {
        const url = safeUrl(it.url);
        const label = esc(it.label);
        const note = it.note ? `<span class="note">${esc(it.note)}</span>` : "";
        return url
          ? `<li><a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>${note}</li>`
          : `<li>${label}${note}</li>`;
      }).join("");
      return (b.title ? `<h3>${esc(b.title)}</h3>` : "") + `<ul class="links">${items}</ul>`;
    }

    case "cards": {
      const items = b.items.map(it => {
        const img = it.image ? safeUrl(it.image, { httpsOnly: true }) : "";
        const url = it.url ? safeUrl(it.url) : "";
        const title = url
          ? `<a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${esc(it.title)}</a>`
          : esc(it.title);
        return `<li class="card">`
          + (img ? `<img src="${img}" alt="" loading="lazy">` : "")
          + `<div class="cb"><div class="ct">${title}</div>`
          + (it.price ? `<div class="price">${esc(it.price)}</div>` : "")
          + (it.note ? `<div class="note">${esc(it.note)}</div>` : "")
          + `</div></li>`;
      }).join("");
      return (b.title ? `<h3>${esc(b.title)}</h3>` : "") + `<ul class="cards">${items}</ul>`;
    }

    // The badge. Deliberately the loudest thing on the page and deliberately short: on a phone,
    // held at arm's length, the colour and the one line have to answer "where is this" before
    // anything else is read. The state word is looked up from a fixed map, so nothing the model
    // wrote ever reaches a class name.
    case "status": {
      const state = STATUS_CLASS[b.state] ? b.state : "queued";
      return `<div class="status s-${state}">`
        + `<div class="sl"><span class="sd"></span>${esc(STATUS_WORD[state])}</div>`
        + `<div class="sh">${esc(b.headline)}</div>`
        + (b.detail ? `<div class="t sx">${paragraphs(b.detail)}</div>` : "")
        + `</div>`;
    }

    case "timeline": {
      const items = b.items.map(it => {
        const state = STEP_CLASS.has(it.state) ? it.state : "plain";
        return `<li class="step k-${state}">`
          + `<div class="sm">${esc(it.label)}</div>`
          + (it.at ? `<div class="sw">${esc(it.at)}</div>` : "")
          + (it.note ? `<div class="note">${esc(it.note)}</div>` : "")
          + `</li>`;
      }).join("");
      return (b.title ? `<h3>${esc(b.title)}</h3>` : "") + `<ol class="tl">${items}</ol>`;
    }

    // A real <details> rather than a script: it folds, it is keyboard reachable, and it works on a
    // phone with JavaScript turned off. Monospace inside, because what goes in here is commit hashes
    // and file paths, and those are read character by character.
    case "details":
      return `<details class="more"><summary>${esc(b.title)}</summary><div class="mb">${paragraphs(b.text)}</div></details>`;

    case "choice": {
      const key = esc(b.key);
      const mine = picked?.[b.key] ?? null;
      const opts = b.options.map(o => {
        const on = mine === o.label;
        const label = esc(o.label);
        const note = o.note ? `<span class="note">${esc(o.note)}</span>` : "";
        // On a shared page a choice is something to read, not something to press: only the owner's
        // own private view can record a pick, and letting a stranger press it would feed somebody
        // else's answer back to Reason as though it were the owner's.
        return interactive
          ? `<button type="button" class="opt${on ? " on" : ""}" data-key="${key}" data-label="${label}">${label}${note}</button>`
          : `<div class="opt${on ? " on" : ""}">${label}${note}</div>`;
      }).join("");
      return `<div class="choice" id="c-${key}"><div class="q">${esc(b.question)}</div><div class="opts">${opts}</div>`
        + `<div class="picked" data-for="${key}">${mine ? `you picked: ${esc(mine)}` : ""}</div>`
        + (interactive ? "" : `<div class="note">this is a copy — answers can only be given on the owner's own page</div>`)
        + `</div>`;
    }

    case "copy": {
      // Something to take away rather than read: a prompt, a letter, a bio. The text sits in a
      // <pre> so the script can lift it back out with textContent, entities and all undone, and
      // the download is a plain data: link that works with no script at all. Copying and
      // downloading are read-only, so a shared copy of the page offers them too.
      const label = esc(b.label);
      const done = esc(b.label.charAt(0).toUpperCase() + b.label.slice(1) + " copied.");
      const href = `data:text/plain;charset=utf-8,${encodeURIComponent(b.text)}`;
      return `<div class="copy">`
        + `<div class="acts">`
        + `<button type="button" class="cp" data-done="${done}">Copy full ${label}</button>`
        + `<a class="dl" href="${esc(href)}" download="${esc(b.filename)}">Download .txt</a>`
        + `</div>`
        + `<pre>${esc(b.text)}</pre>`
        // Said in words as well as drawn, because a fade is a hint and a clipped prompt is the kind
        // of thing somebody copies half of. Hidden unless the script finds it really overflows.
        + `<p class="more-below">Scroll for the rest — Copy takes all of it either way.</p>`
        + `<div class="copied" aria-live="polite"></div>`
        + `</div>`;
    }

    default:
      return "";
  }
}

const CSS = `
:root{--ink:#16130f;--dim:#6f675d;--line:#e7e0d6;--bg:#faf7f2;--card:#fff;--soft:#f3eee6;--accent:#3b3bf5;--accent-ink:#fff;--mark:#ff5a3c;--shadow:0 1px 2px rgba(22,19,15,.05),0 8px 24px rgba(22,19,15,.06);--edge:rgba(22,19,15,.19)}
@media (prefers-color-scheme:dark){:root{--ink:#f3efe8;--dim:#a39c91;--line:#2c2924;--bg:#12110f;--card:#1b1916;--soft:#211f1b;--accent:#8f8fff;--accent-ink:#12110f;--mark:#ff6b4f;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);--edge:rgba(255,255,255,.17)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:.7rem 1.15rem;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:.45rem;font:600 1.02rem/1 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.01em}
.dot{width:.62rem;height:.62rem;border-radius:50%;background:var(--mark);box-shadow:0 0 0 .22rem color-mix(in srgb,var(--mark) 18%,transparent)}
.pill{font-size:.72rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:.28rem .6rem;background:var(--card)}
.wrap{max-width:44rem;margin:0 auto;padding:1.6rem 1.15rem 4.5rem}
.hero{margin:.6rem 0 1.6rem}
.kicker{font-size:.74rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--mark);margin:0 0 .55rem}
h1{font:600 2.05rem/1.12 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.022em;margin:0;text-wrap:balance}
.meta{color:var(--dim);font-size:.84rem;margin:.7rem 0 0}
h2{font:600 1.32rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.012em;margin:2.4rem 0 .7rem}
h2::before{content:"";display:block;width:1.6rem;height:.19rem;border-radius:9px;background:var(--mark);margin-bottom:.85rem}
h3{font-size:.76rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:1.7rem 0 .6rem}
p{margin:.7rem 0}
.t p:first-child{margin-top:0}
.t p:last-child{margin-bottom:0}
.t{font-size:1.02rem}
/* A guide read on a phone is mostly paragraphs, and 11px between them at this size reads as one
   slab. The blank line the model wrote between two ideas should look like a blank line. */
.t p{margin:1rem 0}
figure{margin:1.2rem 0}
img{max-width:100%;height:auto;display:block}
figure img{border-radius:1rem;box-shadow:var(--shadow)}
figcaption{color:var(--dim);font-size:.84rem;margin-top:.55rem}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;background:var(--card);border:1px solid var(--line);border-radius:1rem;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.7rem .85rem;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
th{font-weight:600;color:var(--dim);font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;background:var(--soft);white-space:nowrap}
td:first-child{font-weight:600}
/* On a phone, a header that refuses to wrap is what pushes a three-column comparison off the side
   of the screen and hides a column behind a sideways scroll nobody knows is there. Let it wrap.

   Wrapping buys three columns and not four, so a table CAN still run past the edge — and iOS
   draws no scrollbar to say so. Hence the fade: two background layers in the card colour attached
   "local", which scroll with the table, sitting over two fixed shadow layers at the same edges.
   At rest each cover sits exactly on its own end of the content and hides the shadow under it; as
   soon as there is table in that direction the cover has scrolled away and the shadow shows. So a
   table that fits has no fade at all, one scrolled to the far left has a fade only on the right,
   and one in the middle has both — the cue is the truth about that table, with no script to run
   and nothing to keep in sync. The header's tint goes transparent at this width so the fade is one
   unbroken edge rather than stopping at the header band; the uppercase dim lettering and the rule
   under it are what make it read as a header, and they are untouched. */
@media(max-width:30rem){
th{white-space:normal;background:transparent}th,td{padding:.65rem .6rem}
.scroll{background-image:linear-gradient(var(--card),var(--card)),linear-gradient(var(--card),var(--card)),linear-gradient(to right,var(--edge),transparent),linear-gradient(to left,var(--edge),transparent);background-position:0 0,100% 0,0 0,100% 0;background-size:1.5rem 100%;background-repeat:no-repeat;background-attachment:local,local,scroll,scroll}
}
ul{list-style:none;padding:0;margin:.6rem 0}
.links{background:var(--card);border:1px solid var(--line);border-radius:1rem;box-shadow:var(--shadow);overflow:hidden}
.links li{position:relative;padding:.85rem 2.4rem .85rem 1rem;border-bottom:1px solid var(--line)}
.links li:last-child{border-bottom:0}
.links a{color:var(--ink);text-decoration:none;font-weight:600}
.links a::after{content:"";position:absolute;inset:0}
.links li:has(a)::after{content:"›";position:absolute;right:1rem;top:50%;transform:translateY(-54%);color:var(--dim);font-size:1.35rem;line-height:1}
.note{display:block;color:var(--dim);font-size:.86rem;font-weight:400;margin-top:.15rem}
.cards{display:grid;gap:.9rem;grid-template-columns:1fr}
@media(min-width:34rem){.cards{grid-template-columns:1fr 1fr}}
.card{position:relative;border:1px solid var(--line);border-radius:1.1rem;overflow:hidden;background:var(--card);box-shadow:var(--shadow)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover}
.cb{padding:.85rem 1rem 1rem}
.ct{font-weight:600;font-size:1.03rem;line-height:1.3}
.ct a{color:var(--ink);text-decoration:none}
.ct a::after{content:"";position:absolute;inset:0}
.price{display:inline-block;margin-top:.45rem;padding:.16rem .55rem;border-radius:99px;background:var(--soft);font-size:.86rem;font-weight:600;font-variant-numeric:tabular-nums}
.choice{margin:1.6rem 0;padding:1.1rem;border:1px solid var(--line);border-radius:1.1rem;background:var(--card);box-shadow:var(--shadow)}
.q{font:600 1.12rem/1.3 ui-serif,"New York","Iowan Old Style",Georgia,serif;margin-bottom:.85rem}
.opts{display:grid;gap:.55rem}
.opt{position:relative;display:block;width:100%;text-align:left;padding:.85rem 1rem .85rem 2.7rem;border:1px solid var(--line);border-radius:.85rem;background:var(--bg);color:var(--ink);font:inherit;font-weight:600;cursor:pointer;transition:border-color .15s,background .15s,transform .05s}
.opt::before{content:"";position:absolute;left:.95rem;top:1.02rem;width:1.05rem;height:1.05rem;border-radius:50%;border:2px solid var(--line);background:var(--card)}
button.opt:active{transform:scale(.99)}
.opt.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 9%,var(--bg))}
.opt.on::before{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 42%,var(--card) 48%)}
.picked{color:var(--dim);font-size:.86rem;margin-top:.7rem;min-height:1.2em}
.status{margin:.2rem 0 1.5rem;padding:1.15rem 1.2rem;border:1px solid var(--line);border-left:.28rem solid var(--sc);border-radius:1.1rem;background:var(--card);box-shadow:var(--shadow);--sc:var(--dim)}
.sl{display:flex;align-items:center;gap:.45rem;font-size:.74rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--sc)}
.sd{width:.52rem;height:.52rem;border-radius:50%;background:var(--sc);flex:none}
.sh{font:600 1.3rem/1.25 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.012em;margin-top:.5rem;text-wrap:balance}
.sx{margin-top:.6rem;color:var(--dim);font-size:.95rem}
.sx p:first-child{margin-top:0}
.sx p:last-child{margin-bottom:0}
.s-working{--sc:#b25f00}
.s-waiting{--sc:var(--accent)}
.s-done{--sc:#17794a}
.s-failed{--sc:#b4232a}
.s-stopped,.s-queued{--sc:var(--dim)}
@media (prefers-color-scheme:dark){.s-working{--sc:#ffa94d}.s-done{--sc:#52c793}.s-failed{--sc:#ff7b72}}
.status.s-working .sd{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.status.s-working .sd{animation:none}}
.tl{list-style:none;counter-reset:none;padding:0;margin:.6rem 0 0}
.step{position:relative;padding:0 0 1.15rem 1.6rem;--kc:var(--line)}
.step::before{content:"";position:absolute;left:0;top:.42rem;width:.62rem;height:.62rem;border-radius:50%;background:var(--bg);border:2px solid var(--kc);box-sizing:border-box;z-index:1}
.step::after{content:"";position:absolute;left:.27rem;top:1.05rem;bottom:-.1rem;width:1.5px;background:var(--line)}
.step:last-child{padding-bottom:0}
.step:last-child::after{display:none}
.sm{font-weight:600;line-height:1.35}
.sw{color:var(--dim);font-size:.8rem;margin-top:.1rem;font-variant-numeric:tabular-nums}
.step .note{margin-top:.25rem}
.k-done{--kc:#17794a}
.k-done::before{background:var(--kc)}
.k-now{--kc:#b25f00}
.k-now::before{background:var(--kc);box-shadow:0 0 0 .22rem color-mix(in srgb,var(--kc) 20%,transparent)}
.k-waiting{--kc:var(--accent)}
.k-failed{--kc:#b4232a}
.k-failed::before{background:var(--kc)}
@media (prefers-color-scheme:dark){.k-done{--kc:#52c793}.k-now{--kc:#ffa94d}.k-failed{--kc:#ff7b72}}
.more{margin:1.7rem 0 0;border:1px solid var(--line);border-radius:1rem;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
.more>summary{cursor:pointer;padding:.9rem 1rem;font-size:.76rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);list-style:none}
.more>summary::-webkit-details-marker{display:none}
.more>summary::after{content:"+";float:right;font-size:1.1rem;line-height:1;color:var(--dim)}
.more[open]>summary::after{content:"–"}
.more[open]>summary{border-bottom:1px solid var(--line)}
.mb{padding:.9rem 1rem 1.1rem;font:.88rem/1.6 ui-monospace,"SF Mono",Menlo,monospace;overflow-wrap:anywhere}
.mb p:first-child{margin-top:0}
.mb p:last-child{margin-bottom:0}
@media print{.more{box-shadow:none}}
.gate{max-width:24rem;margin:3.5rem auto 0;text-align:center}
.gate h1{font-size:1.7rem}
.lock{width:3.2rem;height:3.2rem;margin:0 auto 1.1rem;border-radius:1rem;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow);display:grid;place-items:center;font-size:1.4rem}
form{margin:1.6rem 0 0}
input[type=text]{width:100%;padding:.95rem;font:600 1.35rem/1 ui-monospace,"SF Mono",Menlo,monospace;border:1px solid var(--line);border-radius:.9rem;background:var(--card);color:var(--ink);letter-spacing:.32em;text-align:center;text-transform:uppercase;box-shadow:var(--shadow)}
input[type=text]:focus{outline:2px solid var(--accent);outline-offset:2px}
button.go{margin-top:.8rem;width:100%;padding:.95rem;font:inherit;font-weight:600;border:0;border-radius:.9rem;background:var(--ink);color:var(--bg);cursor:pointer}
.bad{color:#b4232a;font-size:.9rem;margin-top:.8rem}
@media (prefers-color-scheme:dark){.bad{color:#ff7b72}}
.foot{margin-top:3.2rem;padding-top:1.1rem;border-top:1px solid var(--line);color:var(--dim);font-size:.8rem;display:flex;gap:.5rem;align-items:baseline}
.foot .dot{flex:none;width:.45rem;height:.45rem;box-shadow:none;transform:translateY(-.05rem)}
@media print{.bar{position:static}.card,.scroll,.links,.choice{box-shadow:none}}
`;

// Only on a page with something to copy, so every other page is drawn exactly as before.
const COPY_CSS = `
.copy{margin:1.4rem 0}
.acts{display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:.7rem}
.cp,.dl{flex:1 1 10rem;display:inline-flex;align-items:center;justify-content:center;min-height:3rem;padding:.8rem 1rem;border-radius:.85rem;font:inherit;font-weight:600;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;transition:transform .05s,opacity .15s}
.cp{background:var(--accent);color:var(--accent-ink);border:1.5px solid var(--accent)}
.dl{background:transparent;color:var(--ink);border:1.5px solid var(--ink)}
.cp:active,.dl:active{transform:scale(.99)}
/* 24rem of prompt is nearly a whole phone screen, and 14px monospace is a squint. Sized off the
   viewport so a short prompt is not in a scroller at all and a long one leaves the page navigable. */
.copy pre{margin:0;padding:1rem;max-height:min(24rem,60vh);overflow:auto;-webkit-overflow-scrolling:touch;background:var(--card);border:1px solid var(--line);border-radius:1rem;box-shadow:var(--shadow);font:.92rem/1.6 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
.copied{color:var(--dim);font-size:.86rem;margin-top:.6rem;min-height:1.2em}
/* The box is capped so a long prompt does not become the whole page, which means it clips — and on
   a phone there is no scrollbar to say so, so it just reads as text that stops mid-sentence. The
   fade and the line below are drawn only when it really does overflow (see COPY_JS), so a short
   one is not given a cue to scroll something that does not scroll. */
.copy.over{position:relative}
.copy.over pre::after{content:"";position:sticky;bottom:-1rem;display:block;height:3rem;margin:0 -1rem -1rem;background:linear-gradient(transparent,var(--card));pointer-events:none}
.more-below{color:var(--dim);font-size:.82rem;margin:.5rem 0 0;text-align:center}
.copy:not(.over) .more-below{display:none}
@media print{.acts{display:none}.copy pre{box-shadow:none;max-height:none}.copy.over pre::after{display:none}.more-below{display:none}}
`;

// Copy the text of the nearest <pre> to the clipboard and say so. The async clipboard API first;
// when it is missing or refuses (older iOS Safari, a page not in focus) fall back to selecting a
// hidden textarea and execCommand, which is the only route those browsers have. Nothing leaves
// the page: the text is already on it.
const COPY_JS = `
function markOverflow(){
  var all=document.querySelectorAll('.copy');
  for(var i=0;i<all.length;i++){
    var pre=all[i].querySelector('pre');
    if(pre)all[i].classList.toggle('over',pre.scrollHeight-pre.clientHeight>4);
  }
}
addEventListener('load',markOverflow);addEventListener('resize',markOverflow);
document.addEventListener('click',function(e){
  var b=e.target.closest('button.cp');if(!b)return;
  var box=b.closest('.copy'),pre=box.querySelector('pre'),out=box.querySelector('.copied');
  var text=pre.textContent,done=b.dataset.done;
  function say(ok){if(out)out.textContent=ok?done:'Could not copy. Press and hold the text to select it.'}
  function fallback(){
    var ok=false,ta=document.createElement('textarea');
    ta.value=text;ta.setAttribute('readonly','');ta.setAttribute('aria-hidden','true');
    ta.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    try{
      if(/ipad|iphone|ipod/i.test(navigator.userAgent)){
        ta.contentEditable=true;ta.readOnly=true;
        var r=document.createRange();r.selectNodeContents(ta);
        var s=window.getSelection();s.removeAllRanges();s.addRange(r);
        ta.setSelectionRange(0,text.length);
      }else{ta.select();}
      ok=document.execCommand('copy');
    }catch(_){ok=false}
    document.body.removeChild(ta);
    say(ok);
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){say(true)},fallback);
  }else fallback();
});
`;

// Post a pick, show it as picked. No libraries, no network beyond the page's own origin, nothing
// that runs unless there is a choice to press.
const JS = `
document.addEventListener('click',function(e){
  var b=e.target.closest('button.opt');if(!b)return;
  var key=b.dataset.key,label=b.dataset.label;
  b.parentNode.querySelectorAll('.opt').forEach(function(o){o.classList.remove('on')});
  b.classList.add('on');
  var out=document.querySelector('.picked[data-for="'+key+'"]');
  if(out)out.textContent='saving…';
  fetch(location.pathname+'/choice',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:key,label:label})})
    .then(function(r){return r.json()})
    .then(function(j){if(out)out.textContent=j.ok?'you picked: '+label:(j.error||'could not save that')})
    .catch(function(){if(out)out.textContent='could not save that — no connection?'});
});
`;

// Everything made for one person is kept out of search engines. The two public pages — the home page
// and the privacy policy — are the exception and say so: a privacy policy is meant to be findable,
// and Google will not publish a consent screen pointing at one that asks not to be read.
// `script` is the script text itself (empty = no script tag); `css` is appended to the base styles.
function shell({ title, body, script = "", css = "", pill = "", indexable = false, head = "" }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">${head}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="${indexable ? "index,follow" : "noindex,nofollow,noarchive"}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<style>${CSS}${css}</style>
</head><body>
<header class="bar"><div class="brand"><span class="dot"></span>Reason</div>${pill ? `<span class="pill">${esc(pill)}</span>` : ""}</header>
<div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

/**
 * One page, rendered.
 *
 * @param {object} page       the row: title, blocks, shared, revision, updated_at
 * @param {object} opts
 * @param {boolean} opts.interactive  can a choice be pressed? true only on the owner's own view
 * @param {object} opts.picked        { [key]: label } already chosen
 */
/** "Put together for Kofi", or "for you" when Reason has not been told a name. First name only. */
export function kickerFor(name) {
  const n = String(name ?? "").trim();
  if (!n || n === "the person I work for") return "Put together for you";
  return `Put together for ${n.split(/\s+/)[0]}`;
}

export function renderPage(page, { interactive = false, picked = {}, forName = "" } = {}) {
  const when = page.revision > 1 ? `Updated ${esc(stamp(page.updated_at))}` : esc(stamp(page.created_at));
  const body = `<div class="hero"><p class="kicker">${esc(kickerFor(forName))}</p><h1>${esc(page.title)}</h1>`
    + `<p class="meta">${when}${page.shared ? " · shared link" : ""}</p></div>`
    + page.blocks.map(b => block(b, { interactive, picked })).join("\n")
    + `<p class="foot"><span class="dot"></span><span>Made by Reason${page.shared ? ". Anyone with this link can read it." : ". Private — only this browser, after the code."}</span></p>`;
  // One script tag at most, holding only what the page needs: the choice handler on the owner's
  // own view, the copy handler wherever there is something to copy — a shared copy included,
  // because copying is reading.
  const hasChoice = interactive && page.blocks.some(b => b.type === "choice");
  const hasCopy = page.blocks.some(b => b.type === "copy");
  const script = [hasChoice ? JS : "", hasCopy ? COPY_JS : ""].join("");
  return shell({ title: page.title, body, script, css: hasCopy ? COPY_CSS : "", pill: page.shared ? "Shared" : "Private" });
}

/**
 * A plain page with something short to say: a connection that worked, or one that did not.
 *
 * Here rather than in the module that needs it so there is one Reason look and not two. The things
 * that use it — src/google.js's callback page, and the home and privacy pages — have nothing to
 * render but a heading and a few sentences, and a second copy of the stylesheet is how those quietly
 * drift into looking like somebody else's website.
 *
 * `sections` is for a page long enough to need headings; `lines` alone is for a page that is not.
 */
export function renderNotice({ title, lines = [], sections = [], kicker = "", meta = "", ok = true, pill = "", indexable = false, links = [], head = "" }) {
  const body = `<div class="hero">${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ""}<h1>${esc(title)}</h1>`
    + `${meta ? `<p class="meta">${esc(meta)}</p>` : ""}</div>`
    + (lines.length ? `<div class="t">${lines.map(l => `<p>${esc(l)}</p>`).join("")}</div>` : "")
    + sections.map(s => `<h2>${esc(s.title)}</h2><div class="t">${(s.lines ?? []).map(l => `<p>${esc(l)}</p>`).join("")}</div>`).join("")
    + noticeLinks(links)
    + `<p class="foot"><span class="dot"></span><span>${ok ? "Reason" : "Reason — nothing was changed"}</span></p>`;
  return shell({ title, body, pill, indexable, head });
}

/**
 * Somewhere to go from a plain page: a path on this server, or a web address. Anything else — a
 * `javascript:` address, a bare word — is left out rather than turned into a link.
 */
function noticeLinks(links) {
  const items = (links ?? [])
    // A path on this server — "/" itself included, "//host" not — or a web address.
    .filter(l => l?.label && (/^\/(?!\/)/.test(l.href ?? "") || /^https?:\/\/[^\s"'<>]+$/.test(l.href ?? "")))
    .map(l => `<li><a href="${esc(l.href)}"${l.href.startsWith("/") ? "" : ` rel="noopener"`}>${esc(l.label)}</a>`
      + `${l.note ? `<span class="note">${esc(l.note)}</span>` : ""}</li>`);
  return items.length ? `<ul class="links">${items.join("")}</ul>` : "";
}

/** The code prompt a private page shows a browser that has not proved itself yet. */
export function renderCodeGate({ title = "Private page", error = "", ownerName = "the owner" } = {}) {
  const body = `<div class="gate"><div class="lock" aria-hidden="true">🔒</div><h1>Private page</h1>`
    + `<div class="t"><p>This page is ${esc(ownerName)}'s, and it has not been shared.</p>`
    + `<p>${esc(ownerName)} opens it from the link Reason texted them. If you were given a six-character code, enter it once and this browser stays signed in.</p></div>`
    + `<form method="POST" action="">`
    + `<input type="text" name="code" inputmode="latin" autocapitalize="characters" autocomplete="one-time-code" `
    + `spellcheck="false" maxlength="6" placeholder="CODE" aria-label="Six character code" autofocus>`
    + `<button class="go" type="submit">Open</button>`
    + (error ? `<div class="bad">${esc(error)}</div>` : "")
    + `</form>`
    + `<p class="meta">If ${esc(ownerName)} did not expect this, close the tab — nothing has been shown.</p></div>`;
  return shell({ title, body, pill: "Private" });
}

/** What a stranger sees: nothing about whether the page exists. */
export function renderNotFound() {
  return shell({
    title: "Not found",
    body: `<div class="gate"><h1>Not found</h1><div class="t"><p>There is nothing at this link.</p></div></div>`,
  });
}
