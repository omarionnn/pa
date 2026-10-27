// Reason Web Settings (design handoff 2026-10-26, HANDOFF.md "6 · Settings"; reference
// desk-settings-{paper,night}.html and sheet-settings-{paper,night}.html 8A/8B).
//
// One calm page, every control real, every one a plain form that posts here and comes back (no
// script needed); the theme also switches in place when script runs. Everything is the SESSION's
// person's: nothing in a form can name another conversation, a browser or an invite that is not theirs.
//
//   How Reason reaches you   accounts.web_reach. 'web' = a finished job's result stays on Web (not
//                            texted; src/deliver.js keptOnWeb); 'text' (the default, and how Reason
//                            always worked) = it is texted too. Timely things — approvals, questions,
//                            reminders, codes — are texted either way. Each dashed phrase is a button
//                            that switches between the two (SCOPE.md Q1).
//   Signed-in browsers       page_sessions for this person, with the browser each was last used from
//                            (page_sessions.user_agent); SIGN OUT deletes that row, so its cookie
//                            opens nothing anywhere; "Sign out everywhere" deletes every one, this too.
//   Connected                read only, from each integration's own store.
//   Invites                  src/invites.js: what is left, every link with its state, make one.
//   Theme                    accounts.web_theme, so every browser opens in it (webkit accountThemed).
import { createHash, timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import * as invites from "../invites.js";
import * as agentcard from "../agentcard.js";
import { invitesOpenFor } from "../tools.js";
import { config, clock } from "../config.js";
import { readCookie, clearCookieHeader, SESSION_TTL_MS } from "./access.js";
import { esc, renderNotFound } from "./render.js";
import { webPage, wordmark, hand, stamp } from "./webkit.js";
import { sameOrigin, SECURITY_HEADERS, WEB_IDLE_MS } from "./websignin.js";

/**
 * "Sensitive texts only say 'Reason needs your approval.' The details wait here, behind sign-in."
 * Not true today: an approval is asked in the text itself, with its details (src/tools.js confirm
 * gate). The line is drawn only once it is true (SCOPE.md, question for Omari).
 */
export const PRIVATE_BY_DEFAULT = false;

/** The two ways a finished job's result can go, as the sentence says them. */
export const REACH = {
  web: { first: "timely decisions", second: "routine results", sentence: (a, b) => `Text me for ${a}. Keep ${b} here.` },
  text: { first: "everything", second: "a copy", sentence: (a, b) => `Text me for ${a}. Keep ${b} here.` },
};

/** "Chrome on Mac", from a browser's user agent. */
export function deviceName(ua) {
  const u = String(ua ?? "");
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android"
    : /CrOS/.test(u) ? "Chromebook" : /Macintosh|Mac OS X/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "";
  const br = /Edg(?:A|iOS)?\//.test(u) ? "Edge" : /OPR\/|Opera/.test(u) ? "Opera" : /SamsungBrowser/.test(u) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(u) ? "Firefox" : /Chrome\/|CriOS/.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
  if (br && os) return `${br} on ${os}`;
  if (br) return br;
  return os ? `A browser on ${os}` : "Unknown browser";
}

/** NOW · 12 MIN AGO · 2 HOURS AGO · OCT 19, for when a browser was last used. */
export function lastActive(at, now = clock.now()) {
  const ago = Math.max(0, now - at);
  if (ago < 2 * 60_000) return "NOW";
  if (ago < 60 * 60_000) return `${Math.floor(ago / 60_000)} MIN AGO`;
  if (ago < 24 * 60 * 60_000) { const h = Math.floor(ago / 3_600_000); return `${h} HOUR${h === 1 ? "" : "S"} AGO`; }
  return new Date(at).toLocaleString("en-US", { timeZone: config.tz, month: "short", day: "numeric" }).toUpperCase();
}

/** A browser's handle on this page: a hash of its session, never the session itself. */
export const sessionHandle = (token) => createHash("sha256").update(String(token)).digest("base64url").slice(0, 22);

/** The integrations shown, in the handoff's order, each read from its own store for this person only. */
export function connections(conversationId) {
  const card = db.getAgentcardUser(conversationId);
  const has = (provider) => db.listOauthTokens(conversationId, provider).length > 0;
  return [
    { name: "AGENTCARD", phone: "CARD · AGENTCARD", on: !!card?.user_id && agentcard.connectionState(card).state !== "dead" },
    { name: "GOOGLE", on: has("google") },
    { name: "SPOTIFY", on: has("spotify") },
    { name: "UBER", on: has("uber") },
    { name: "GITHUB", on: has("github") },
    { name: "ICLOUD", on: has("apple_calendar") },
  ].filter(c => c.on);
}

const STAMP = { redeemed: ["JOINED", "pen"], unused: ["UNUSED", "ink"], canceled: ["CANCELED", "muted"] };
/** "files.heyreason.com/i/Ab3dE9…": a link as the list shows it. The whole link is the href, while it works. */
const shortLink = (token) => invites.inviteUrl(String(token).slice(0, 6)).replace(/^https?:\/\//, "") + "…";

// ---------------------------------------------------------------- the page
const CSS = `
.st-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px var(--gut) 0}
.st{flex:1 0 auto;width:100%;max-width:1080px;margin:0 auto;padding:32px var(--gut) 48px;display:flex;flex-direction:column;gap:40px}
.st-side{display:flex;flex-direction:column;gap:4px}
.st-h1{margin:0;font:italic 400 44px/1.05 var(--serif);letter-spacing:-.02em}
.st-nav{display:none}
.st-main{display:flex;flex-direction:column;gap:40px;min-width:0}
.st-sec{display:flex;flex-direction:column;gap:14px;padding-bottom:32px;border-bottom:1px dashed var(--hair);scroll-margin-top:24px}
.st-sec h2{margin:0;font:400 11px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted)}
.st-sec form{margin:0}
.reach-p{margin:0;font:400 26px/1.35 var(--serif)}
.ph{position:relative;border:0;border-bottom:1px dashed var(--ink);background:transparent;padding:0;font:inherit;font-style:italic;color:var(--ink);cursor:pointer}
.ph::after{content:"";position:absolute;left:0;right:0;top:50%;min-height:44px;transform:translateY(-50%);height:100%}
.ph:hover{color:var(--hov);border-bottom-color:var(--hov)}
.st-sec .hand{font-size:21px}
.priv{margin:0;font-size:16px;line-height:1.55}
.priv .q{font:400 14px/1.4 var(--mono)}
#browsers{gap:4px}
#browsers h2{margin-bottom:6px}
.br-row{padding:12px 0;border-bottom:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:center;gap:12px}
.br-row.here{align-items:baseline}
.br-who{display:flex;flex-direction:column;gap:2px;min-width:0}
.br-dev{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.br-when{font:400 11px/1.4 var(--mono);letter-spacing:.08em;color:var(--muted)}
.br-here{font:400 19px/1.2 var(--hand);color:var(--pen);white-space:nowrap}
.br-out{font-size:11px;letter-spacing:.14em}
.every{align-self:flex-start;margin-top:10px;min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 21px/1.2 var(--serif);color:var(--pen)}
.every:hover{color:var(--hov)}
#connected{gap:4px}
#connected h2{margin-bottom:6px}
.cn{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 12px;align-items:baseline}
.cn li{display:contents}
.cn-n{font:400 14px/1.4 var(--mono);letter-spacing:.06em}
.cn-s{font:400 19px/1.2 var(--hand);color:var(--pen)}
.st-quiet{margin:10px 0 0;font-size:14px;line-height:1.5;color:var(--muted)}
#invites{gap:4px}
.inv-n{margin:6px 0 10px;font:italic 400 38px/1 var(--serif)}
.inv{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.inv li{padding:10px 0;border-top:1px dashed var(--hair);display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.inv-l{font:400 12px/1.4 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
a.inv-l{min-height:44px;display:inline-flex;align-items:center}
.inv-l.gone{color:var(--muted)}
.inv .stamp{flex:none;align-self:center;font-size:10.5px;padding:3px 7px}
a.inv-l{text-decoration-color:var(--hair);text-underline-offset:3px}
.inv .stamp-ink{transform:rotate(2deg)}.inv .stamp-muted{transform:rotate(-2deg)}
.make{align-self:flex-start;margin-top:8px;min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 21px/1.2 var(--serif);color:var(--ink)}
.make:hover{color:var(--hov)}
#theme{border-bottom:0;padding-bottom:0;gap:40px}
.th-box{display:flex;flex-direction:column;gap:10px;padding-bottom:32px;border-bottom:1px dashed var(--hair)}
.th-g{display:flex;gap:22px;align-items:baseline;flex-wrap:wrap}
.th-g button{min-height:44px;border:0;background:transparent;padding:0;cursor:pointer;font:italic 400 26px/1.2 var(--serif);color:var(--muted)}
.th-g button[aria-checked=true]{color:var(--ink)}
.th-g .dot{color:var(--hair)}
.out{font-size:12px;letter-spacing:.14em;align-self:flex-start}
.d-only{display:none}
@media (max-width:359px){.reach-p{font-size:23px}}
@media (min-width:900px){
.st-head{padding:22px clamp(20px,4vw,48px)}
.st{flex-direction:row;flex-wrap:wrap;gap:80px;align-items:flex-start;padding:48px clamp(20px,4vw,48px) 64px}
.st-side{flex:1 1 200px;max-width:220px;position:sticky;top:24px}
.st-h1{margin:0 0 24px;font-size:48px;line-height:1;letter-spacing:0}
.st-nav{display:flex;flex-direction:column;gap:4px}
.st-nav a{min-height:44px;display:inline-flex;align-items:center;text-decoration:none;font:400 12px/1.3 var(--mono);letter-spacing:.14em;color:var(--muted)}
.st-nav a[aria-current]{color:var(--ink)}
.st-nav a[aria-current]::before{content:"\\2192\\00a0"}
.st-main{flex:999 1 520px;gap:56px;padding-top:8px}
.st-sec{gap:16px;padding-bottom:48px}
.st-sec h2{font-size:12px}
.reach-p{font-size:34px;line-height:1.3;max-width:18em}
.st-sec .hand{font-size:23px}
.priv{margin-top:12px;max-width:34em}
.priv .q{font:inherit}
#browsers,#connected,#invites{gap:0}
#browsers h2{margin-bottom:8px}
.br-row,.br-row.here{display:grid;grid-template-columns:minmax(0,1fr) 160px 120px;align-items:center;padding:14px 0;gap:16px}
.br-who{display:contents}
.br-dev{font-size:16px}
.br-when{font-size:12px;letter-spacing:0}
.br-here{font-size:20px;text-align:right}
.br-row form{justify-self:end}
.every{margin-top:14px;font-size:22px}
#connected{gap:14px}
#connected h2{margin-bottom:0}
.cn{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 24px}
.cn li{display:flex;flex-direction:column;gap:2px}
.st-quiet{margin-top:6px}
#invites{gap:6px}
.inv-n{margin:8px 0 12px;font-size:44px}
.inv{flex-direction:row;flex-wrap:wrap;gap:28px}
.inv li{border-top:0;padding:0;justify-content:flex-start}
.inv-l{font-size:13px}
.make{margin-top:16px;font-size:22px}
#theme{flex-direction:row;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:24px}
.th-box{padding-bottom:0;border-bottom:0}
.th-g button{font-size:30px}
.m-only{display:none}.d-only{display:inline}
}
`;

// The theme switches in place (kit window.reasonTheme, which also saves it for every browser), the
// radio group moves by arrow keys, and the index marks the section last jumped to. All of it over
// forms that already work without script.
const JS = `(function(){var g=document.querySelector('.th-g');
function mark(){var t=document.documentElement.dataset.theme,cur=t==='light'?'paper':t==='dark'?'night':'auto';g.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-checked',String(b.value===cur));b.tabIndex=b.value===cur?0:-1})}
if(g){mark();g.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||!window.reasonTheme)return;e.preventDefault();window.reasonTheme(b.value);mark();b.focus()});
g.addEventListener('keydown',function(e){var k=e.key,bs=[].slice.call(g.querySelectorAll('button')),i=bs.indexOf(document.activeElement);if(i<0)return;var n=k==='ArrowRight'||k==='ArrowDown'?(i+1)%bs.length:k==='ArrowLeft'||k==='ArrowUp'?(i+bs.length-1)%bs.length:-1;if(n<0)return;e.preventDefault();bs[n].click()})}
var nav=document.querySelectorAll('.st-nav a');function cur(){var h=location.hash||'#reach';nav.forEach(function(a){if(a.getAttribute('href')===h)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current')})}
window.addEventListener('hashchange',cur);if(location.hash)cur();
document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){var b=e.submitter||f.querySelector('[type=submit]');if(b)b.setAttribute('aria-busy','true')})});
})();`;

const SECTIONS = [["reach", "HOW I REACH YOU"], ["browsers", "BROWSERS"], ["connected", "CONNECTED"], ["invites", "INVITES"], ["theme", "THEME"]];
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const post = (csrf, what, inner, cls = "") => `<form method="POST" action="/web/settings"${cls ? ` class="${cls}"` : ""}>${hidden("c", csrf)}${hidden("do", what)}${inner}</form>`;
const saved = (on) => (on ? hand("got it.", { role: "status" }) : "");

/**
 * The whole page for one person. `browsers` are this person's sessions (`current` = this browser's
 * token); `invitesView` is invites.myInvites or null when invites are not open to them.
 */
export function renderSettings({ csrf, reach = "text", browsers = [], current = "", connected = [], invitesView = null, theme = null, done = "", now = clock.now() }) {
  const r = REACH[reach] ?? REACH.text;
  const other = reach === "web" ? "text" : "web";
  const ph = (t) => `<button class="ph" type="submit" name="reach" value="${other}" aria-describedby="reach-how">${esc(t)}</button>`;
  const reachSec = `<section class="st-sec" id="reach" aria-labelledby="reach-h"><h2 id="reach-h">HOW REASON REACHES YOU</h2>`
    + post(csrf, "reach", `<p class="reach-p">${r.sentence(ph(r.first), ph(r.second))}</p>`)
    + `<p class="sr" id="reach-how">${reach === "web" ? "Now: routine results stay here. Choosing switches to texting you everything." : "Now: everything is texted to you. Choosing switches to keeping routine results here."}</p>`
    + hand("or just ask me to text you for one thing.")
    + saved(done === "reach")
    + (PRIVATE_BY_DEFAULT ? `<p class="priv d-only"><span class="lbl" style="display:inline">PRIVATE BY DEFAULT · </span>Sensitive texts only say "Reason needs your approval." The details wait here, behind sign-in.</p>` : "")
    + `</section>`
    + (PRIVATE_BY_DEFAULT ? `<section class="st-sec m-only" aria-labelledby="priv-h"><h2 id="priv-h">PRIVATE BY DEFAULT</h2><p class="priv">Sensitive texts only say <span class="q">"Reason needs your approval."</span> The details wait here, behind sign-in.</p></section>` : "");

  // A session never used since browsers were noted (a Reason page's code, the status page, before
  // this list existed) has nothing to name it by: those are counted in one quiet line, not listed
  // one "Unknown browser" at a time. Sign out everywhere ends them too.
  const older = browsers.filter(s => !s.user_agent && s.token !== current).length;
  const rows = [...browsers].filter(s => s.user_agent || s.token === current).sort((a, b) => (b.token === current) - (a.token === current)).map(s => {
    const here = s.token === current;
    const dev = deviceName(s.user_agent);
    const when = here ? "NOW" : lastActive(s.last_seen_at, now);
    return `<div class="br-row${here ? " here" : ""}"><span class="br-who"><span class="br-dev">${esc(dev)}</span>`
      + `<span class="br-when">${here ? `<span class="m-only">THIS ONE · </span>` : ""}${esc(when)}</span></span>`
      + (here ? `<span class="br-here">you're here</span>`
        : post(csrf, "browser", `${hidden("b", sessionHandle(s.token))}<button class="act2 br-out" type="submit" aria-label="Sign out ${esc(dev)}, last active ${esc(when.toLowerCase())}">SIGN OUT</button>`))
      + `</div>`;
  }).join("");
  const browsersSec = `<section class="st-sec" id="browsers" aria-labelledby="br-h"><h2 id="br-h">SIGNED-IN BROWSERS</h2>${rows}`
    + (older ? `<p class="st-quiet">And ${older} other sign-in${older === 1 ? "" : "s"} that ${older === 1 ? "hasn't" : "haven't"} opened Reason Web, like Reason's pages. Signing out everywhere ends ${older === 1 ? "it" : "them"} too.</p>` : "")
    + post(csrf, "everywhere", `<button class="every" type="submit">Sign out everywhere</button>`)
    + saved(done === "browsers") + `</section>`;

  const connectedSec = `<section class="st-sec" id="connected" aria-labelledby="cn-h"><h2 id="cn-h">CONNECTED</h2>`
    + (connected.length
      ? `<ul class="cn">${connected.map(c => `<li><span class="cn-n">${c.phone ? `<span class="m-only">${esc(c.phone)}</span><span class="d-only">${esc(c.name)}</span>` : esc(c.name)}</span><span class="cn-s">connected</span></li>`).join("")}</ul>`
        + `<p class="st-quiet">To change one, ask Reason in the chat.</p>`
      : `<p class="st-quiet">Nothing is connected yet. To connect one, ask Reason in the chat.</p>`)
    + `</section>`;

  let invitesSec = "";
  if (invitesView) {
    const left = invitesView.links_you_can_still_make;
    const list = invitesView.links.map(l => {
      const inv = l.invite;
      const [word, tone] = STAMP[inv.state] ?? [String(inv.state).toUpperCase(), "muted"];
      const text = esc(shortLink(inv.token));
      const link = inv.state === "unused"
        ? `<a class="inv-l" href="${esc(invites.inviteUrl(inv.token))}">${text}</a>`
        : `<span class="inv-l${inv.state === "canceled" ? " gone" : ""}">${text}</span>`;
      return `<li>${link}${stamp(word, tone)}</li>`;
    }).join("");
    invitesSec = `<section class="st-sec" id="invites" aria-labelledby="inv-h"><h2 id="inv-h">INVITES</h2><p class="inv-n">${left} left</p>`
      + (list ? `<ul class="inv">${list}</ul>` : "")
      + (left > 0 ? post(csrf, "invite", `<button class="make" type="submit">Make an invite link <span aria-hidden="true">→</span></button>`) : "")
      + saved(done === "invite")
      + (done === "invite-name" ? hand("i need your name for the invite card first. tell me in the chat.", { role: "status" }) : "")
      + `</section>`;
  }

  const cur = theme ?? "auto";
  const opt = (v, t) => `<button type="submit" role="radio" name="theme" value="${v}" aria-checked="${cur === v}">${t}</button>`;
  const themeSec = `<section class="st-sec" id="theme" aria-labelledby="th-h"><div class="th-box"><h2 id="th-h">THEME</h2>`
    + post(csrf, "theme", `<div class="th-g" role="radiogroup" aria-labelledby="th-h">${opt("paper", "Paper")}<span class="dot" aria-hidden="true">·</span>${opt("night", "Night")}<span class="dot" aria-hidden="true">·</span>${opt("auto", "Auto")}</div>`)
    + saved(done === "theme") + `</div>`
    + `<form method="POST" action="/web/signout" class="out-f">${hidden("c", csrf)}<button class="act2 out" type="submit">SIGN OUT OF THIS BROWSER</button></form></section>`;

  const shown = SECTIONS.filter(([id]) => id !== "invites" || invitesView);
  const body = `<header class="st-head"><a class="act2" href="/web?thread">← BACK TO THE CHAT</a>${wordmark({ href: "/web" })}</header>`
    + `<main class="st"><div class="st-side"><h1 class="st-h1">Settings</h1><nav class="st-nav" aria-label="Settings sections">`
    + shown.map(([id, t], i) => `<a href="#${id}"${i === 0 ? ` aria-current="true"` : ""}>${t}</a>`).join("")
    + `</nav></div><div class="st-main">${reachSec}${browsersSec}${connectedSec}${invitesSec}${themeSec}</div></main>`;
  return webPage({ title: "Reason — Settings", body, css: CSS, script: JS, foot: "" });
}

// ---------------------------------------------------------------- the requests
function same(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra });
const back = (done, anchor) => ({ status: 303, headers: HTML({ Location: `/web/settings${done ? `?done=${done}` : ""}#${anchor}`, "Content-Length": 0 }), body: "" });
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body }; };
const NOT_HERE = "That didn't come from this page.";
const sessionsOf = (conv) => db.pageSessionsFor(conv, { maxAgeMs: SESSION_TTL_MS, idleMs: WEB_IDLE_MS });

/** What the page shows for one person, read fresh. */
export function settingsView(account, token) {
  const conv = account.conversation_id;
  return {
    reach: db.webReach(conv),
    browsers: sessionsOf(conv),
    current: token,
    connected: connections(conv),
    invitesView: invitesOpenFor(conv) ? { ...invites.myInvites(conv), links: db.listInvites(conv).map(invite => ({ invite })) } : null,
    theme: db.webTheme(conv),
  };
}

/**
 * GET /web/settings, and POST /web/settings with `do` = reach | theme | browser | everywhere | invite.
 * Signed in only (the router sends anybody else to sign in). Every POST carries the session's form
 * secret and comes from Reason's own page, like /web/send.
 */
export async function settingsRequest({ account, method, query = {}, headers = {}, readBody, log = () => {} }) {
  const token = readCookie(headers?.cookie);
  const conv = account.conversation_id;
  if (method === "GET" || method === "HEAD") {
    const body = renderSettings({ csrf: db.pageSessionCsrf(token), ...settingsView(account, token), done: String(query.done ?? "") });
    return { status: 200, headers: HTML({ "Content-Length": Buffer.byteLength(body) }), body };
  }
  if (method !== "POST") { const body = renderNotFound(); return { status: 405, headers: HTML({ Allow: "GET, HEAD, POST", "Content-Length": Buffer.byteLength(body) }), body }; }
  const wantsJson = String(headers.accept ?? "").includes("application/json");
  const form = new URLSearchParams((await readBody()) ?? "");
  if (!sameOrigin(headers) || !same(headers["x-reason-csrf"] || form.get("c"), db.pageSessionCsrf(token))) {
    log({ web_settings_refused: "origin_or_token" });
    return wantsJson ? json(403, { ok: false, error: "not_from_this_page" }) : { status: 403, headers: HTML({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(NOT_HERE) }), body: NOT_HERE };
  }
  const what = form.get("do");

  if (what === "reach") {
    const v = form.get("reach");
    if (v !== "web" && v !== "text") return back("", "reach");
    db.setWebReach(conv, v);
    log({ web_settings: "reach", to: v });
    return wantsJson ? json(200, { ok: true, reach: v }) : back("reach", "reach");
  }

  if (what === "theme") {
    const v = form.get("theme");
    if (!["paper", "night", "auto"].includes(v)) return wantsJson ? json(400, { ok: false, error: "bad_theme" }) : back("", "theme");
    db.setWebTheme(conv, v);
    log({ web_settings: "theme", to: v });
    return wantsJson ? json(200, { ok: true, theme: v }) : back("theme", "theme");
  }

  if (what === "browser") {
    // Only one of THIS person's browsers, found by its handle among their own sessions: a handle
    // from anybody else's list matches nothing here and changes nothing.
    const h = String(form.get("b") ?? "");
    const row = sessionsOf(conv).find(s => same(sessionHandle(s.token), h));
    if (!row) return back("", "browsers");
    db.endPageSessionOf(conv, row.token);
    log({ web_settings: "browser_signed_out", here: row.token === token });
    if (row.token === token) return signedOut(headers);
    return back("browsers", "browsers");
  }

  if (what === "everywhere") {
    const n = db.endPageSessionsFor(conv);
    log({ web_settings: "signed_out_everywhere", browsers: n });
    return signedOut(headers);
  }

  if (what === "invite") {
    if (!invitesOpenFor(conv)) return back("", "invites");
    const made = invites.makeLink(conv);
    log({ web_settings: "invite", ok: made.ok, ...(made.ok ? { number: made.number } : {}) });
    return back(made.ok ? "invite" : made.needs_name ? "invite-name" : "", "invites");
  }

  return back("", "reach");
}

/** This browser is signed out: every copy of its cookie cleared, and the sign-in page says so (6F). */
function signedOut(headers) {
  return { status: 303, headers: HTML({ Location: "/web?out=1", "Content-Length": 0, "Set-Cookie": clearCookieHeader({ path: "/", headers }) }), body: "" };
}
