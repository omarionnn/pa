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

    default:
      return "";
  }
}

const CSS = `
:root{--ink:#14171a;--dim:#5b6570;--line:#e3e7eb;--bg:#fff;--soft:#f6f8fa;--accent:#1f6feb}
@media (prefers-color-scheme:dark){:root{--ink:#e8edf2;--dim:#9aa7b4;--line:#2a313a;--bg:#14171a;--soft:#1c2128}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:46rem;margin:0 auto;padding:1.25rem 1.1rem 4rem}
h1{font-size:1.6rem;line-height:1.25;margin:.2rem 0 .3rem}
h2{font-size:1.15rem;margin:2rem 0 .6rem;padding-top:1rem;border-top:1px solid var(--line)}
h3{font-size:1rem;margin:1.4rem 0 .5rem}
p{margin:.6rem 0}
.meta{color:var(--dim);font-size:.82rem;margin:0 0 1.2rem}
.t p:first-child{margin-top:0}
figure{margin:1rem 0}
img{max-width:100%;height:auto;border-radius:.6rem;display:block}
figcaption{color:var(--dim);font-size:.85rem;margin-top:.4rem}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.55rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--dim);font-size:.82rem;text-transform:uppercase;letter-spacing:.03em}
ul{list-style:none;padding:0;margin:.6rem 0}
.links li{padding:.7rem 0;border-bottom:1px solid var(--line)}
.links a{color:var(--accent);text-decoration:none;font-weight:500}
.note{display:block;color:var(--dim);font-size:.85rem;margin-top:.15rem}
.cards{display:grid;gap:.9rem;grid-template-columns:1fr}
@media(min-width:34rem){.cards{grid-template-columns:1fr 1fr}}
.card{border:1px solid var(--line);border-radius:.8rem;overflow:hidden;background:var(--soft)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:0}
.cb{padding:.7rem .8rem .85rem}
.ct{font-weight:600}
.ct a{color:var(--ink);text-decoration:none}
.price{margin-top:.2rem;font-variant-numeric:tabular-nums}
.choice{margin:1.4rem 0;padding:1rem;border:1px solid var(--line);border-radius:.8rem;background:var(--soft)}
.q{font-weight:600;margin-bottom:.7rem}
.opts{display:grid;gap:.5rem}
.opt{display:block;width:100%;text-align:left;padding:.75rem .85rem;border:1px solid var(--line);border-radius:.6rem;background:var(--bg);color:var(--ink);font:inherit;cursor:pointer}
.opt.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.picked{color:var(--dim);font-size:.85rem;margin-top:.6rem;min-height:1.2em}
form{margin:2rem 0}
input[type=text]{width:100%;padding:.8rem;font:inherit;border:1px solid var(--line);border-radius:.6rem;background:var(--bg);color:var(--ink);letter-spacing:.25em;text-align:center}
button.go{margin-top:.8rem;width:100%;padding:.85rem;font:inherit;font-weight:600;border:0;border-radius:.6rem;background:var(--accent);color:#fff;cursor:pointer}
.bad{color:#b4232a;font-size:.9rem;margin-top:.7rem}
@media (prefers-color-scheme:dark){.bad{color:#ff7b72}}
.foot{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--dim);font-size:.8rem}
`;

// The only script on a page: post a pick, show it as picked. No libraries, no network beyond the
// page's own origin, nothing that runs unless there is a choice to press.
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

function shell({ title, body, script = false }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body><div class="wrap">${body}</div>${script ? `<script>${JS}</script>` : ""}</body></html>`;
}

/**
 * One page, rendered.
 *
 * @param {object} page       the row: title, blocks, shared, revision, updated_at
 * @param {object} opts
 * @param {boolean} opts.interactive  can a choice be pressed? true only on the owner's own view
 * @param {object} opts.picked        { [key]: label } already chosen
 */
export function renderPage(page, { interactive = false, picked = {} } = {}) {
  const body = `<h1>${esc(page.title)}</h1>`
    + `<p class="meta">${page.revision > 1 ? `updated ${esc(stamp(page.updated_at))}` : esc(stamp(page.created_at))}`
    + `${page.shared ? " · shared link" : ""}</p>`
    + page.blocks.map(b => block(b, { interactive, picked })).join("\n")
    + `<p class="foot">Made by Reason${page.shared ? ". Anyone with this link can read it." : ". Private — only this browser, after the code."}</p>`;
  const hasChoice = interactive && page.blocks.some(b => b.type === "choice");
  return shell({ title: page.title, body, script: hasChoice });
}

/** The code prompt a private page shows a browser that has not proved itself yet. */
export function renderCodeGate({ title = "Private page", error = "", ownerName = "the owner" } = {}) {
  const body = `<h1>Private page</h1>`
    + `<div class="t"><p>This page is ${esc(ownerName)}'s. The link on its own is not enough.</p>`
    + `<p>Reason has texted ${esc(ownerName)} a six-character code. Enter it once and this browser stays signed in.</p></div>`
    + `<form method="POST" action="">`
    + `<input type="text" name="code" inputmode="latin" autocapitalize="characters" autocomplete="one-time-code" `
    + `spellcheck="false" maxlength="6" placeholder="CODE" aria-label="Six character code" autofocus>`
    + `<button class="go" type="submit">Open</button>`
    + (error ? `<div class="bad">${esc(error)}</div>` : "")
    + `</form>`
    + `<p class="foot">If ${esc(ownerName)} did not expect this, close the tab — nothing has been shown.</p>`;
  return shell({ title, body });
}

/** What a stranger sees: nothing about whether the page exists. */
export function renderNotFound() {
  return shell({
    title: "Not found",
    body: `<h1>Not found</h1><div class="t"><p>There is nothing at this link.</p></div>`,
  });
}
