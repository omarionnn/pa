// Blocks in, HTML out. This is the only place a page becomes markup.
//
// Everything the model supplied is escaped on the way through — text, titles, captions, table
// cells, labels, and every URL attribute. There is no path by which a string from a tool result
// becomes a tag, an attribute boundary, or a script, which is why the content checker can allow
// free text at all.
//
// Mobile first, because a page is opened from a text message on a phone. One column, big tap
// targets, system fonts, no webfonts, no external anything, and no JavaScript beyond the page's
// own few lines: the opening moment (INTRO_JS, which touches nothing but the page's own styles),
// the choice handler that posts a pick back, and the copy button. It has to look decent on a
// four-year-old phone on bad signal, and it has to read as a page with script turned off.
import { stamp, config } from "../config.js";
import { CALLOUT_TONES } from "./content.js";
import { pageUrl } from "./access.js";

const CALLOUT_CLASS = new Set(CALLOUT_TONES);

/** "Oct 5" — short enough for the top line of a page. */
function shortDate(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: config.tz, month: "short", day: "numeric" });
}

/** "Oct 5, 2026" — for the closing line, where the year matters once the page is old. */
function longDate(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: config.tz, month: "short", day: "numeric", year: "numeric" });
}

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

    // Numbered, one per hairline row. The number comes from the position, drawn in grey.
    case "steps": {
      const items = b.items.map((s, i) => `<li><span class="n">${i + 1}.</span><span class="sb">${esc(s)}</span></li>`).join("");
      return (b.title ? `<h3>${esc(b.title)}</h3>` : "") + `<ol class="steps">${items}</ol>`;
    }

    // Bold name, grey detail under it, a value on the right when there is one.
    case "rows": {
      const items = b.items.map((it, i) => {
        const n = it.n ?? (b.numbered ? `${i + 1}.` : null);
        return `<li class="row">`
          + (n !== null ? `<span class="n">${esc(n)}</span>` : "")
          + `<span class="rm"><span class="rn">${esc(it.name)}</span>${it.detail ? `<span class="rd">${esc(it.detail)}</span>` : ""}</span>`
          + (it.value ? `<span class="rv">${esc(it.value)}</span>` : "")
          + `</li>`;
      }).join("");
      return (b.title ? `<h3>${esc(b.title)}</h3>` : "") + `<ul class="rows">${items}</ul>`;
    }

    // The tone is looked up from the fixed list, so nothing the model wrote reaches a class name.
    case "callout": {
      const tone = CALLOUT_CLASS.has(b.tone) ? b.tone : "plain";
      return `<aside class="co co-${tone}">`
        + (b.title ? `<div class="cot">${esc(b.title)}</div>` : "")
        + `<div class="t">${paragraphs(b.text)}</div></aside>`;
    }

    default:
      return "";
  }
}

// The two grounds, the colour the phone's own chrome takes behind the page. Named once because the
// head script and the meta tags both need them (THEME_HEAD_JS, shell()).
export const GROUND = { light: "#f3eee6", dark: "#0b0a09" };

/**
 * Dark rules, written once and applied two ways: under the phone's own dark setting unless the
 * reader has chosen light, and whenever the reader has chosen dark whatever the phone says. The
 * choice is `data-theme` on <html> (light | dark; absent = follow the phone), set by THEME_HEAD_JS
 * before the first paint and by the switch at the foot of a page. `rules` is a list of
 * [selector, declarations]; an empty selector is :root itself.
 */
function dark(rules) {
  const under = root => rules.map(([s, d]) => `${root}${s ? ` ${s}` : ""}{${d}}`).join("");
  return `@media (prefers-color-scheme:dark){${under(":root:not([data-theme=light])")}}${under(":root[data-theme=dark]")}`;
}

const CSS = `
:root{--ink:#1c1915;--dim:#6f675d;--line:#e6e0d7;--bg:#fbf9f5;--ground:${GROUND.light};--card:#fff;--soft:#f3eee6;--accent:#3b3bf5;--accent-ink:#fff;--mark:#ff5a3c;--warn:#b4232a;--shadow:none;--edge:rgba(22,19,15,.19)}
${dark([["", `--ink:#f3efe8;--dim:#a39c91;--line:#2c2924;--bg:#12110f;--ground:${GROUND.dark};--card:#1b1916;--soft:#211f1b;--accent:#8f8fff;--accent-ink:#12110f;--mark:#ff6b4f;--warn:#ff7b72;--edge:rgba(255,255,255,.17)`]])}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
/* Two tones: the top line sits on a slightly darker ground, and the page itself is a pale sheet with
   rounded top corners resting on it. Once the page is open the sheet fills the screen and the ground
   is just the strip behind the top line, but it is what the sheet rises out of (see INTRO_CSS). */
body{margin:0;background:var(--ground);color:var(--ink);font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
.sheet{background:var(--bg);border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
/* The top line scrolls away with the page. It says whose page this is and when, and nothing else:
   a sticky bar with a blur was the one thing that made a page read as an app screen. */
.bar{display:flex;align-items:center;justify-content:space-between;gap:.8rem;max-width:44rem;margin:0 auto;padding:1.1rem 1.15rem 1rem;font-size:.9rem}
.brand{display:flex;align-items:center;gap:.45rem;min-width:0;color:var(--ink);font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
.who{color:var(--dim);font:400 .9rem/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dot{flex:none;width:.5rem;height:.5rem;border-radius:50%;background:var(--mark)}
.pill{flex:none;font-size:.68rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:.2rem .55rem}
.wrap{max-width:44rem;margin:0 auto;padding:1.6rem 1.15rem 3.5rem}
.hero{margin:0 0 2.2rem}
h1{font:400 1.75rem/1.12 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.025em;margin:0;text-wrap:balance}
.sub{color:var(--dim);font-size:1.02rem;margin:.6rem 0 0;text-wrap:pretty}
.kicker{font-size:.74rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--mark);margin:0 0 .55rem}
.meta{color:var(--dim);font-size:.84rem;margin:.7rem 0 0}
/* 48px above a section heading, 16px below: the page breathes between parts, not inside them. */
h2{font:400 1.32rem/1.15 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.02em;margin:3rem 0 1rem}
h3{font-size:1rem;font-weight:600;margin:1.6rem 0 .45rem}
p{margin:.7rem 0}
.t p:first-child{margin-top:0}
.t p:last-child{margin-bottom:0}
.t{font-size:1.02rem}
/* A guide read on a phone is mostly paragraphs, and 11px between them at this size reads as one
   slab. The blank line the model wrote between two ideas should look like a blank line. */
.t p{margin:1rem 0}
figure{margin:1.4rem 0}
img{max-width:100%;height:auto;display:block}
figure img{border-radius:.5rem}
figcaption{color:var(--dim);font-size:.86rem;margin-top:.6rem}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;background:var(--card);border:1px solid var(--line);border-radius:.5rem}
table{border-collapse:collapse;width:100%;font-size:.95rem;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:.75rem .85rem;border-bottom:1px solid var(--line);vertical-align:top}
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
ul,ol{list-style:none;padding:0;margin:.6rem 0}
/* Hairlines, not boxes. A list of sources is part of the page, not a widget on it. */
.links{border-top:1px solid var(--line)}
.links li{position:relative;padding:.8rem 1.8rem .8rem 0;border-bottom:1px solid var(--line)}
.links a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px;font-weight:500}
.links a::after{content:"";position:absolute;inset:0}
.links li:has(a)::after{content:"›";position:absolute;right:.2rem;top:50%;transform:translateY(-54%);color:var(--dim);font-size:1.35rem;line-height:1}
.note{display:block;color:var(--dim);font-size:.9rem;font-weight:400;margin-top:.15rem}
.cards{display:grid;gap:.9rem;grid-template-columns:1fr}
@media(min-width:34rem){.cards{grid-template-columns:1fr 1fr}}
.card{position:relative;border:1px solid var(--line);border-radius:.75rem;overflow:hidden;background:var(--card)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover}
.cb{padding:.85rem 1rem 1rem}
.ct{font-weight:600;font-size:1.03rem;line-height:1.3}
.ct a{color:var(--ink);text-decoration:none}
.ct a::after{content:"";position:absolute;inset:0}
.price{display:inline-block;margin-top:.45rem;padding:.16rem .55rem;border-radius:99px;background:var(--soft);font-size:.86rem;font-weight:600;font-variant-numeric:tabular-nums}
/* Steps and rows: one item per hairline row, the number in grey in its own slot. */
.steps,.rows{margin:.4rem 0 0}
.steps li,.row{display:flex;gap:.6rem;align-items:flex-start;padding:.75rem 0;border-bottom:1px solid var(--line);text-wrap:pretty}
.steps li:last-child,.row:last-child{border-bottom:0}
.n{flex:none;width:1.6rem;color:var(--dim);font-variant-numeric:tabular-nums}
.sb{flex:1;min-width:0}
.rm{flex:1;min-width:0;display:flex;flex-direction:column}
.rn{font-weight:600}
.rd{color:var(--dim)}
.rv{flex:none;max-width:40%;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
/* A callout: a thin rule, or a soft box, or a soft box with a red title. */
.co{margin:1.6rem 0;text-wrap:pretty}
.co-plain{padding:0 0 0 1rem;border-left:2px solid var(--line)}
.co-note,.co-warning{padding:1rem 1.1rem;border-radius:.5rem;background:var(--soft)}
.cot{font-weight:600;margin-bottom:.35rem}
.co-warning .cot{color:var(--warn)}
.choice{margin:1.6rem 0;padding:1.1rem;border:1px solid var(--line);border-radius:.75rem;background:var(--card)}
.q{font:500 1.12rem/1.3 ui-serif,"New York","Iowan Old Style",Georgia,serif;margin-bottom:.85rem}
.opts{display:grid;gap:.55rem}
.opt{position:relative;display:block;width:100%;text-align:left;padding:.85rem 1rem .85rem 2.7rem;border:1px solid var(--line);border-radius:.6rem;background:var(--bg);color:var(--ink);font:inherit;font-weight:600;cursor:pointer;transition:border-color .15s,background .15s,transform .05s}
.opt::before{content:"";position:absolute;left:.95rem;top:1.02rem;width:1.05rem;height:1.05rem;border-radius:50%;border:2px solid var(--line);background:var(--card)}
button.opt:active{transform:scale(.99)}
.opt.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 9%,var(--bg))}
.opt.on::before{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 42%,var(--card) 48%)}
.picked{color:var(--dim);font-size:.86rem;margin-top:.7rem;min-height:1.2em}
.status{margin:.2rem 0 1.5rem;padding:1.15rem 1.2rem;border:1px solid var(--line);border-left:.28rem solid var(--sc);border-radius:.75rem;background:var(--card);--sc:var(--dim)}
.sl{display:flex;align-items:center;gap:.45rem;font-size:.74rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--sc)}
.sd{width:.52rem;height:.52rem;border-radius:50%;background:var(--sc);flex:none}
.sh{font:500 1.3rem/1.25 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.012em;margin-top:.5rem;text-wrap:balance}
.sx{margin-top:.6rem;color:var(--dim);font-size:.95rem}
.sx p:first-child{margin-top:0}
.sx p:last-child{margin-bottom:0}
.s-working{--sc:#b25f00}
.s-waiting{--sc:var(--accent)}
.s-done{--sc:#17794a}
.s-failed{--sc:#b4232a}
.s-stopped,.s-queued{--sc:var(--dim)}
${dark([[".s-working", "--sc:#ffa94d"], [".s-done", "--sc:#52c793"], [".s-failed", "--sc:#ff7b72"]])}
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
${dark([[".k-done", "--kc:#52c793"], [".k-now", "--kc:#ffa94d"], [".k-failed", "--kc:#ff7b72"]])}
.more{margin:1.7rem 0 0;border:1px solid var(--line);border-radius:.5rem;background:var(--card);overflow:hidden}
.more>summary{cursor:pointer;padding:.9rem 1rem;font-size:.76rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);list-style:none}
.more>summary::-webkit-details-marker{display:none}
.more>summary::after{content:"+";float:right;font-size:1.1rem;line-height:1;color:var(--dim)}
.more[open]>summary::after{content:"–"}
.more[open]>summary{border-bottom:1px solid var(--line)}
.mb{padding:.9rem 1rem 1.1rem;font:.88rem/1.6 ui-monospace,"SF Mono",Menlo,monospace;overflow-wrap:anywhere}
.mb p:first-child{margin-top:0}
.mb p:last-child{margin-bottom:0}
.gate{max-width:24rem;margin:3.5rem auto 0;text-align:center}
.gate h1{font-size:1.7rem}
.lock{width:3.2rem;height:3.2rem;margin:0 auto 1.1rem;border-radius:1rem;background:var(--card);border:1px solid var(--line);display:grid;place-items:center;font-size:1.4rem}
form{margin:1.6rem 0 0}
input[type=text]{width:100%;padding:.95rem;font:600 1.35rem/1 ui-monospace,"SF Mono",Menlo,monospace;border:1px solid var(--line);border-radius:.6rem;background:var(--card);color:var(--ink);letter-spacing:.32em;text-align:center;text-transform:uppercase}
input[type=text]:focus{outline:2px solid var(--accent);outline-offset:2px}
button.go{margin-top:.8rem;width:100%;padding:.95rem;font:inherit;font-weight:600;border:0;border-radius:.6rem;background:var(--ink);color:var(--bg);cursor:pointer}
.bad{color:var(--warn);font-size:.9rem;margin-top:.8rem}
.closing{margin:3rem 0 0;color:var(--dim);text-wrap:pretty}
.foot{margin-top:1.4rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--dim);font-size:.8rem;display:flex;gap:.5rem;align-items:baseline}
.foot .dot{flex:none;width:.45rem;height:.45rem;transform:translateY(-.05rem)}
.theme{display:inline-flex;gap:.15rem;margin:1.1rem 0 0;padding:.15rem;border:1px solid var(--line);border-radius:99px}
.theme[hidden]{display:none}
.theme button{font:inherit;font-size:.78rem;line-height:1;color:var(--dim);background:none;border:0;border-radius:99px;padding:.45rem .8rem;cursor:pointer;-webkit-tap-highlight-color:transparent}
.theme button[aria-pressed=true]{background:var(--line);color:var(--ink)}
.theme button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* Printed — a PDF Reason wrote, or somebody printing the page from their browser. The theme switch
   goes because paper has no choice to offer. min-height is 100dvh on screen so the sheet always
   fills the phone; on paper that is a mostly-blank second sheet for any short document, so it goes. */
@media print{.theme{display:none}body{background:#fff}.sheet{border-radius:0;min-height:0}.wrap{padding-bottom:1rem}.card,.scroll,.choice,.co{break-inside:avoid}h2,h3{break-after:avoid}}
`;

// The opening moment of a page made for someone, borrowed from how Instinct's Files pages arrive:
// the wordmark alone in the middle of a bare ground with a word under it and a thin dashed line
// crawling, then the word goes, the wordmark glides up into its place on the top line and the sheet
// rises from the bottom to meet it. About a second and a half, and then it is just a page.
//
// Omari, 2026-10-07: "it will say like reasoning, then [the page] pulls up."
//
// Every rule here hangs off html[data-intro], which only the inline script in the head sets, and only
// for a fresh arrival: a tap on the link. A reload, back/forward, a reader who asked for reduced
// motion, a fetcher building a link card, a browser with no script: none of them see any of this,
// they get the page exactly as it was. The content is already in the HTML either way; nothing is
// fetched or decided during the hold, and the hold is the beat, not a wait.
//
// The wordmark itself says what is happening: it reads "Reasoning" through the hold, and as it
// glides up the "ing" fades off it so what lands on the top line is "Reason". One word doing the
// work, no second line under it. The "ing" keeps its width while it fades, so the left edge the
// glide was measured from never moves.
const INTRO_CSS = `
.intro{display:none}
html[data-intro]{overflow:hidden}
html[data-intro] .intro{display:flex;position:fixed;inset:0;z-index:9;flex-direction:column;align-items:center;justify-content:center;gap:1.1rem;padding-bottom:12dvh;background:var(--ground);color:var(--ink);animation:intro-in .25s cubic-bezier(.32,.72,0,1) both}
@keyframes intro-in{0%{opacity:0}}
.ib{display:flex;align-items:center;gap:.7rem;font:500 1.55rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif;letter-spacing:-.01em;transform-origin:0 50%;will-change:transform}
.ib .dot{width:.78rem;height:.78rem}
.il{width:105px;height:1px;color:var(--ink);background-image:repeating-linear-gradient(90deg,currentColor 0 1px,transparent 1px 5px);background-size:5px 1px}
html[data-intro] .bar{opacity:0}
html[data-intro] .sheet{transform:translateY(100dvh)}
html[data-intro=entering] .intro{background:transparent;pointer-events:none;transition:background .35s}
html[data-intro=entering] .ib{transform:translate(var(--dx,0px),var(--dy,0px)) scale(var(--s,1));opacity:0;transition:transform .8s cubic-bezier(.25,.46,.45,.94),opacity .2s .62s}
html[data-intro=entering] .ib .ing{opacity:0;transition:opacity .3s cubic-bezier(.32,.72,0,1)}
html[data-intro=entering] .il{opacity:0;transition:opacity .2s cubic-bezier(.32,.72,0,1)}
html[data-intro=entering] .bar{opacity:1;transition:opacity .25s .6s}
html[data-intro=entering] .sheet{transform:none;transition:transform .8s cubic-bezier(.25,.46,.45,.94) 60ms}
`;

// Set before the first paint, in the head, so the page never flashes open and then covers itself.
// A fresh navigation only: the link tapped from a text. Anything else leaves the attribute off and
// the page is drawn as it always was.
// Light, dark or auto, the reader's choice for this browser. Auto is no attribute at all: the
// stylesheet follows the phone. A choice is one word in localStorage under one key, read here in
// the head before anything is painted (so a page never opens light and then turns dark), and
// written by the switch at the foot of the page (THEME_JS). It is sent nowhere. The phone's own
// chrome follows too: the theme-color metas are repointed at the chosen ground, and put back to
// their media-matched defaults on auto. `tint` is the same text in both scripts on purpose — the
// head one has to stand alone, before the body exists.
const THEME_KEY = "reason-theme";
const THEME_TINT = `function tint(){var t=document.documentElement.dataset.theme,c=t==='dark'?'${GROUND.dark}':t==='light'?'${GROUND.light}':null;`
  + `document.querySelectorAll('meta[name=theme-color]').forEach(function(m){m.setAttribute('content',c||m.getAttribute('data-auto'))})}`;
const THEME_HEAD_JS = `
(function(){try{${THEME_TINT}
var t=localStorage.getItem('${THEME_KEY}');
if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;tint()}
}catch(e){}})();
`;
const THEME_JS = `
(function(){${THEME_TINT}
var h=document.documentElement,box=document.querySelector('.theme');if(!box)return;box.hidden=false;
function show(){var cur=h.dataset.theme||'auto';box.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.set===cur))})}
box.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var t=b.dataset.set;
try{if(t==='auto')localStorage.removeItem('${THEME_KEY}');else localStorage.setItem('${THEME_KEY}',t)}catch(x){}
if(t==='auto')delete h.dataset.theme;else h.dataset.theme=t;tint();show()});
show()})();
`;
/** The switch itself: hidden until the script shows it, so a browser with no script sees no dead buttons. */
const THEME_SWITCH = `<div class="theme" role="group" aria-label="Appearance" hidden>`
  + `<button type="button" data-set="light" aria-pressed="false">Light</button>`
  + `<button type="button" data-set="dark" aria-pressed="false">Dark</button>`
  + `<button type="button" data-set="auto" aria-pressed="true">Auto</button></div>`;

const INTRO_HEAD_JS = `
(function(){try{
var n=performance.getEntriesByType('navigation')[0];
if(n&&n.type!=='navigate')return;
if(matchMedia('(prefers-reduced-motion:reduce)').matches)return;
document.documentElement.dataset.intro='loading';
}catch(e){}})();
`;

// Runs at the end of the body, so the top line it measures is laid out. The dashed line crawls at
// about sixty pixels a second with a slow breath in its speed, the same movement as Instinct's.
// After the hold the wordmark is told exactly where the real one on the top line is (so the glide
// lands on it, whatever the font did), the phase flips, and nine hundred milliseconds later every
// hook is removed and the page is an ordinary page. A backstop clears it regardless: nothing on this
// page is allowed to stay hidden behind an animation that did not finish.
const INTRO_JS = `
(function(){
var h=document.documentElement;if(h.dataset.intro!=='loading')return;
var HOLD=900,ENTER=900;
function done(){delete h.dataset.intro;window.scrollTo(0,0)}
var backstop=setTimeout(done,HOLD+ENTER+1500);
try{
var ib=document.querySelector('.intro .ib'),tb=document.querySelector('.bar .brand'),ln=document.querySelector('.intro .il');
var raf=0,pos=0,t0=0,tl=0;
function tick(t){if(!t0){t0=t;tl=t}var f=(t-t0)/1000,dt=Math.min(.05,(t-tl)/1000);tl=t;
pos=(pos+60*(1+.55*Math.sin(f*2*Math.PI/3.2))*dt)%5;ln.style.backgroundPosition=(-pos).toFixed(2)+'px 0';raf=requestAnimationFrame(tick)}
raf=requestAnimationFrame(tick);
setTimeout(function(){
var a=ib.getBoundingClientRect(),b=tb.getBoundingClientRect();
ib.style.setProperty('--dx',(b.left-a.left).toFixed(2)+'px');
ib.style.setProperty('--dy',((b.top+b.height/2)-(a.top+a.height/2)).toFixed(2)+'px');
ib.style.setProperty('--s',(b.height/a.height).toFixed(4));
h.dataset.intro='entering';
setTimeout(function(){cancelAnimationFrame(raf);clearTimeout(backstop);done()},ENTER);
},HOLD);
}catch(e){done()}
})();
`;

// Only on a page whose top line is in the reader's language. The line sits in the top bar's grey
// text and looks like the rest of it, apart from a dotted underline: the one hint that it does
// something. Resting a pointer on it (or a tap, where there is no pointer) fades the English in
// where the words were, and the line widens to fit — the same quarter-second ease as the opening
// moment, so it feels like the page and not like a browser tooltip. Without the script it is just
// the words.
const SAY_CSS = `
.say{position:relative;display:inline-block;vertical-align:baseline;padding:0;margin:0;border:0;background:none;font:inherit;color:inherit;line-height:inherit;cursor:pointer;white-space:nowrap;text-align:left;width:var(--w,auto);transition:width .25s cubic-bezier(.32,.72,0,1);-webkit-tap-highlight-color:transparent}
.say .s1,.say .s2{display:inline-block;transition:opacity .25s cubic-bezier(.32,.72,0,1)}
.say .s1{text-decoration:underline dotted;text-decoration-color:var(--edge);text-underline-offset:.22em}
.say .s2{position:absolute;left:0;top:0;opacity:0}
.say.on .s1{opacity:0}
.say.on .s2{opacity:1}
.say:focus-visible{outline:1.5px solid var(--ink);outline-offset:3px;border-radius:2px}
`;

// Measures both words once the fonts are in, so the widening is exact; then a pointer resting on
// the line shows the English, a tap flips it and a second tap flips it back. A tap on a laptop with
// a mouse is also a flip, so the hover and the click never fight.
const SAY_JS = `
(function(){
var b=document.querySelector('.say');if(!b)return;
var s1=b.querySelector('.s1'),s2=b.querySelector('.s2'),hover=matchMedia('(hover:hover)').matches,pinned=false;
function fit(){b.style.setProperty('--w',(b.classList.contains('on')?s2:s1).getBoundingClientRect().width.toFixed(2)+'px')}
function set(on){b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false');fit()}
fit();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);
b.addEventListener('click',function(){pinned=!pinned;set(pinned)});
if(hover){b.addEventListener('pointerenter',function(){if(!pinned)set(true)});b.addEventListener('pointerleave',function(){if(!pinned)set(false)})}
addEventListener('resize',fit);
})();
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
/**
 * The icon every page points at, served by this process (src/http.js assetRequest). Absolute when
 * there is a public address, because a phone building a card for a link resolves these itself and
 * a relative path is fine for a browser but not for every fetcher. The same on the gate and the
 * not-found page as on a real page, so those two stay identical to each other.
 */
function iconLinks() {
  const base = config.publicUrl || "";
  return `<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">\n<link rel="icon" type="image/png" href="${base}/apple-touch-icon.png">`;
}

// `intro` is the opening moment (INTRO_CSS): only a page made for someone gets it. The gate, the
// not-found page and a plain notice open flat, and the first two stay byte-identical to each other.
function shell({ title, body, script = "", css = "", pill = "", indexable = false, head = "", top = "", intro = false }) {
  // A page made for someone carries the theme choice too (head + foot); the flat pages follow the
  // phone and nothing else, so they stay script-free.
  const scripts = `${script}${intro ? `${INTRO_JS}${THEME_JS}` : ""}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">${head}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="${indexable ? "index,follow" : "noindex,nofollow,noarchive"}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${GROUND.light}" data-auto="${GROUND.light}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${GROUND.dark}" data-auto="${GROUND.dark}" media="(prefers-color-scheme: dark)">
${iconLinks()}
<title>${esc(title)}</title>${intro ? `\n<script>${THEME_HEAD_JS}${INTRO_HEAD_JS}</script>` : ""}
<style>${CSS}${css}${intro ? INTRO_CSS : ""}</style>
</head><body>${intro ? `\n<div class="intro" aria-hidden="true"><div class="ib"><span class="dot"></span><span class="w">Reason<span class="ing">ing</span></span></div><div class="il"></div></div>` : ""}
<header class="bar"><div class="brand"><span class="dot"></span>Reason${top ? `<span class="who"> · ${top}</span>` : ""}</div>${pill ? `<span class="pill">${esc(pill)}</span>` : ""}</header>
<main class="sheet"><div class="wrap">${body}</div></main>${scripts ? `<script>${scripts}</script>` : ""}</body></html>`;
}

/**
 * The line a phone shows under the title when it draws a card for this link.
 *
 * The first real sentences on the page, flattened to one line. Deliberately the page's own words
 * rather than a description written about it: "Beans, grind, water, ratio and how to fix a sour
 * cup" is what the page says, and anything else would be a second thing to keep true.
 */
function previewLine(blocks) {
  const first = blocks.find(b => b.type === "text" && String(b.text ?? "").trim());
  const raw = first ? String(first.text) : blocks.filter(b => b.type === "section" && b.title).map(b => b.title).join(" · ");
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= 160) return flat;
  // Cut on a word, not mid-syllable, and say that it is cut.
  return `${flat.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

/**
 * What a link preview is built from, when a phone decides to draw one.
 *
 * Omari, 2026-10-05: "it will be nice to have a preview. if theres no preview don't say there is.
 * but try to have previews." A page had no Open Graph tags at all, so there was nothing to make a
 * card out of and the link arrived bare.
 *
 * These go ONLY on a page the fetcher is already allowed to see. That matters: the gate and the
 * not-found page must stay byte-identical to each other, and a tag on either would turn a link
 * preview into a way to ask "is this id real?" and read the title off the answer. A fetcher with
 * the owner's key in the link already receives the whole page, so naming the title here gives away
 * nothing it did not already have.
 *
 * No `og:url`: leaving it out means a tap follows the link that was actually sent, key and all.
 * Writing one would mean either baking the owner's key into a meta tag or publishing a keyless
 * address that lands on the gate — and a preview whose card leads to "Private page" is worse than
 * no preview.
 *
 * `og:image` (2026-10-06) is the page's own picture, `/p/{id}/card.png` (src/pages/card.js), drawn
 * from its title and subtitle. The fetcher that reads this HTML then goes and gets the picture with
 * no cookie, so a PRIVATE page's picture address carries the same key the link did — the fetcher
 * already holds that key, or it would be reading the gate rather than this — and a shared page's
 * does not need one. The revision is on the address so a changed page is a changed picture rather
 * than a cached old one.
 */
function previewTags(page) {
  const line = previewLine(page.blocks);
  return [
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Reason">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    line ? `<meta property="og:description" content="${esc(line)}">` : "",
    `<meta property="og:image" content="${esc(cardUrl(page))}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(page.title)}">`,
    line ? `<meta name="twitter:description" content="${esc(line)}">` : "",
    `<meta name="twitter:image" content="${esc(cardUrl(page))}">`,
  ].filter(Boolean).join("\n");
}

/** Where this page's picture is fetched from. Keyed for a private page, bare for a shared one. */
export function cardUrl(page) {
  const q = new URLSearchParams({ v: String(page.revision ?? 1) });
  if (!page.shared && page.owner_key) q.set("k", page.owner_key);
  return `${pageUrl(page.id)}/card.png?${q}`;
}

/**
 * One page, rendered.
 *
 * @param {object} page       the row: title, blocks, shared, revision, updated_at
 * @param {object} opts
 * @param {boolean} opts.interactive  can a choice be pressed? true only on the owner's own view
 * @param {object} opts.picked        { [key]: label } already chosen
 */
/** "Made for Kofi", or "Made for you" when Reason has not been told a name. First name only. */
export function madeFor(name) {
  const n = String(name ?? "").trim();
  if (!n || n === "the person I work for") return "Made for you";
  return `Made for ${n.split(/\s+/)[0]}`;
}

/**
 * The same line in the reader's own language, when Reason has been told one and has the words.
 *
 * Omari, 2026-10-06: the top line should read in the person's language, "Omari dea", with the
 * English a hover (or a tap, on a phone) away. "dea" is the Twi noun "own": "Kofi dea" is "Kofi's
 * own", the thing that belongs to Kofi, and "wo dea" is "yours" (learnakan.com, Twi possessive
 * pronouns). Only Twi is written. A language nobody has written the words for gets the English line
 * and no hover, rather than a guess on the first line of every page.
 *
 * @returns {{ text: string, english: string, language: string }|null}  null when the line is English
 */
export const LANGUAGES = {
  twi: { name: "Twi", line: (first) => (first ? `${first} dea` : "Wo dea") },
};

export function topLine(name, language = "") {
  const lang = LANGUAGES[String(language ?? "").trim().toLowerCase()];
  if (!lang) return null;
  const n = String(name ?? "").trim();
  const first = !n || n === "the person I work for" ? "" : n.split(/\s+/)[0];
  return { text: lang.line(first), english: madeFor(name), language: lang.name };
}

/** The "Made for" part of the top line as markup: plain text, or the translated line with the English behind it. */
function whoseMarkup(forName, language) {
  const t = topLine(forName, language);
  if (!t) return esc(madeFor(forName));
  // A button, because it does something on a phone: a tap shows the English, a second tap puts
  // the line back. On a laptop the pointer resting on it is enough. The aria label says both, so a
  // screen reader never needs to press anything.
  return `<button class="say" type="button" aria-label="${esc(t.text)} — ${esc(t.language)} for ${esc(t.english)}">`
    + `<span class="s1">${esc(t.text)}</span><span class="s2" aria-hidden="true">${esc(t.english)}</span></button>`;
}

/**
 * The grey line at the bottom: when it was written (or last changed), then the model's own closing
 * sentence if it gave one — "Start easy for the first two weeks."
 */
export function closingLine(page) {
  const when = page.revision > 1 ? `Updated ${longDate(page.updated_at)}.` : `Written ${longDate(page.created_at)}.`;
  return page.closing ? `${when} ${page.closing}` : when;
}

/**
 * @param {object} opts
 * @param {boolean} opts.printing  this HTML is about to be printed to a PDF rather than opened.
 *   Three things change, and each of them is a thing that would come out wrong on paper: the
 *   opening animation is off (it starts with the sheet pushed a screen down, so a print taken
 *   before it finishes is a blank page), there are no link-preview tags (a PDF has no link and no
 *   card), and the footer says the document was written rather than describing who can open a link.
 *   Nothing about the content changes: a printed document is the same blocks, in the same look.
 */
export function renderPage(page, { interactive = false, picked = {}, forName = "", language = "", printing = false } = {}) {
  const said = !!topLine(forName, language);
  const top = `${whoseMarkup(forName, language)} · ${esc(shortDate(page.created_at))}`;
  const body = `<div class="hero"><h1>${esc(page.title)}</h1>`
    + (page.subtitle ? `<p class="sub">${esc(page.subtitle)}</p>` : "")
    + `</div>`
    + page.blocks.map(b => block(b, { interactive, picked })).join("\n")
    + `<p class="closing">${esc(closingLine(page))}</p>`
    + `<p class="foot"><span class="dot"></span><span>${printing
      ? "Written by Reason."
      : `Made by Reason${page.shared ? ". Anyone with this link can read it." : ". Private — only this browser, after the code."}`}</span></p>`
    // Light · Dark · Auto is a choice a reader makes in a browser. A printed document is already
    // whichever one it was printed as, so the switch is left out rather than drawn and hidden.
    + (printing ? "" : THEME_SWITCH);
  // One script tag at most, holding only what the page needs: the choice handler on the owner's
  // own view, the copy handler wherever there is something to copy — a shared copy included,
  // because copying is reading. (shell() adds the opening moment and the theme switch to it.)
  const hasChoice = interactive && page.blocks.some(b => b.type === "choice");
  const hasCopy = page.blocks.some(b => b.type === "copy");
  const script = printing ? "" : [hasChoice ? JS : "", hasCopy ? COPY_JS : "", said ? SAY_JS : ""].join("");
  return shell({
    title: page.title, body, script,
    css: `${hasCopy ? COPY_CSS : ""}${said ? SAY_CSS : ""}`,
    pill: printing ? "" : (page.shared ? "Shared" : "Private"),
    head: printing ? "" : `\n${previewTags(page)}`,
    top,
    intro: !printing,
  });
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
