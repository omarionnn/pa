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
:root{--ink:#16130f;--dim:#6f675d;--line:#e7e0d6;--bg:#faf7f2;--card:#fff;--soft:#f3eee6;--accent:#3b3bf5;--accent-ink:#fff;--mark:#ff5a3c;--shadow:0 1px 2px rgba(22,19,15,.05),0 8px 24px rgba(22,19,15,.06)}
@media (prefers-color-scheme:dark){:root{--ink:#f3efe8;--dim:#a39c91;--line:#2c2924;--bg:#12110f;--card:#1b1916;--soft:#211f1b;--accent:#8f8fff;--accent-ink:#12110f;--mark:#ff6b4f;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
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
.t{font-size:1.02rem}
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

function shell({ title, body, script = false, pill = "" }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>
<header class="bar"><div class="brand"><span class="dot"></span>Reason</div>${pill ? `<span class="pill">${esc(pill)}</span>` : ""}</header>
<div class="wrap">${body}</div>${script ? `<script>${JS}</script>` : ""}</body></html>`;
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
  const hasChoice = interactive && page.blocks.some(b => b.type === "choice");
  return shell({ title: page.title, body, script: hasChoice, pill: page.shared ? "Shared" : "Private" });
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
