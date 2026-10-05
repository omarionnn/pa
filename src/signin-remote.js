// Signing in from a phone: a link that shows the person Reason's browser, live, so they can sign in
// to a site themselves from wherever they are.
//
// The sign-in has to happen inside the browser Reason will later use, because that is where the
// site puts the session. That browser is on the machine Reason runs on. So instead of bringing the
// person to the machine (`signin_open`, a window on its screen), this brings the browser to the
// person: a page that shows a picture of it a few times a second, and sends back where they
// tapped and what they typed. The site sees one browser throughout, and the session it grants
// lands in that person's own saved profile.
//
// **What this costs, said plainly, because the owner decided it with this in front of him
// (2026-10-05).** What the person types — a password included — travels from their phone to this
// process and from this process into the site's own page. Reason relays it. So "Reason never sees
// a password" is no longer strictly true of this path, and nothing here pretends otherwise. What
// stays true, and is enforced below rather than promised:
//
//   - nothing typed is ever logged, stored, written to the database, or put in a conversation —
//     the only things kept are that a session started, that it ended, and what the SITE said;
//   - no picture of the browser is kept either: each one is sent and dropped;
//   - the model never sees any of it. No tool returns a keystroke or a screenshot, so there is
//     nothing for a prompt to ask for;
//   - a password offered in a MESSAGE is still refused. That one is in the messaging app and the
//     transcript for good, which is a different thing from a relay that forgets.
//
// **Who can use a link.** Whoever opens it first and taps Start, and nobody after: Start hands that
// browser a cookie and every later request needs it. A link preview fetches the page but does not
// tap anything, so previews cannot take the session. A link is good for a few minutes, a session
// for a few more, and making a new link kills the old one.
//
// **What it cannot do.** Face ID, a passkey or a security key belong to the device doing the
// signing in, and that device is the machine, not the phone — so those will not work here and the
// page says so. A password, a code by text or email, and "is this you" taps all do.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import * as db from "./db.js";
import * as signin from "./signin.js";
import { profileDirFor } from "./browser.js";
import { config, clock } from "./config.js";

/** The picture the person sees. A phone held upright, at a size a desktop sign-in form fits in. */
export const VIEW = { width: 430, height: 700 };
export const PATH = "/s";
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const MAX_TYPED = 500;
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** token → session. In memory on purpose: a restart ends every session, which is the safe way to fail. */
const sessions = new Map();
/** conversationId → token, so one person has one link and a new one replaces the old. */
const byConversation = new Map();

const newToken = () => randomBytes(24).toString("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** The real browser: the person's own saved profile, headless, at the size the page shows. */
async function realLaunch({ conversationId, url }) {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(profileDirFor(conversationId), {
    headless: true, viewport: VIEW, deviceScaleFactor: 2,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.browserTimeoutMs);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  return { page, close: () => context.close().catch(() => {}) };
}

export function remoteSigninStatus() {
  const base = config.publicUrl || `http://${config.host}:${config.port}`;
  return {
    reachable_from_a_phone: !!config.publicUrl,
    base,
    ...(config.publicUrl ? {} : { why: `REASON_PUBLIC_URL is not set, so the link is ${base}/… and only opens on the machine Reason runs on.` }),
  };
}

/** Is a remote sign-in in progress for this person? Their saved profile is busy while one is. */
export function remoteSessionFor(conversationId) {
  const s = sessions.get(byConversation.get(conversationId));
  return s && !s.ended ? { site: s.entry.site, started: !!s.browser } : null;
}

/**
 * Make a link. Nothing is launched yet: the browser starts when somebody taps Start, so a link
 * nobody opens never holds the saved profile.
 */
export function createRemoteSignin({ conversationId, entry, launch = realLaunch, check = signin.checkAndRecord, closeBrowser = async () => {}, busy = () => null, timers = { set: setTimeout, clear: clearTimeout }, log = () => {} }) {
  const old = sessions.get(byConversation.get(conversationId));
  if (old) end(old, "replaced").catch(() => {});

  const token = newToken();
  const s = {
    token, conversationId, entry, launch, check, closeBrowser, busy, timers, log,
    createdAt: clock.now(), secret: null, browser: null, queue: Promise.resolve(),
    ended: null, lastShot: null, startedAt: null, timer: null,
  };
  sessions.set(token, s);
  byConversation.set(conversationId, token);
  // Unopened, it is good for linkTtl. Once started, the session clock replaces this one.
  s.timer = timers.set(() => { end(s, "link_expired").catch(() => {}); }, config.remoteSigninLinkTtlMs);
  s.timer?.unref?.();
  const st = remoteSigninStatus();
  log({ signin_remote: "link", site: entry.site, conversation: conversationId });
  return {
    ok: true, url: `${st.base}${PATH}/${token}`, site: entry.site,
    good_for_minutes: Math.round(config.remoteSigninLinkTtlMs / 60_000),
    reachable_from_a_phone: st.reachable_from_a_phone, ...(st.why ? { why: st.why } : {}),
  };
}

/** One thing at a time per browser: a tap and a screenshot racing each other is how a click lands on the wrong page. */
function inTurn(s, fn) {
  const run = s.queue.then(fn, fn);
  s.queue = run.catch(() => {});
  return run;
}

/**
 * End a session, whichever way it ends, and say what the SITE says.
 *
 * The check runs on every ending that had a browser — Done, time running out, a replacement —
 * because a person who signed in and then put their phone down did sign in, and the truth about
 * that is on the site's account page, not in which button they pressed.
 */
async function end(s, how) {
  if (s.ended) return s.ended;
  s.ended = { how, state: null, why: "", at: clock.now() };
  s.timers.clear(s.timer);
  const { conversationId: c, entry } = s;
  let note;
  if (s.browser) {
    try {
      const out = await inTurn(s, () => s.check(s.browser.page, c, entry.site));
      s.ended.state = out?.ok === false ? "unknown" : out.state;
      s.ended.why = out?.why ?? out?.error ?? "";
    } catch (e) {
      s.ended.state = "unknown";
      s.ended.why = (e?.message ?? String(e)).split("\n")[0];
    }
    await s.browser.close();
    s.browser = null;
    const tail = how === "done" ? "" : how === "replaced" ? " (a newer link replaced that one)" : " (the link timed out before they tapped Done)";
    note = s.ended.state === "signed_in"
      ? `they finished signing in to ${entry.label} through the link you sent${tail}, and ${entry.label} says they ARE signed in now (${s.ended.why}). Tell them in one short line that it worked, and pick up whatever they wanted ${entry.label} for.`
      : s.ended.state === "signed_out"
        ? `the ${entry.label} sign-in through the link you sent has ended${tail}, and ${entry.label} says they are still NOT signed in (${s.ended.why}). Say that plainly in one short line and offer a fresh link.`
        : `the ${entry.label} sign-in through the link you sent has ended${tail}, but whether they are signed in could not be read (${s.ended.why}). Nothing is recorded either way. Say that in one short line; signin_status with recheck asks the site again.`;
  } else if (how === "link_expired") {
    note = `the ${entry.label} sign-in link you sent was never opened and has expired. Do not chase them about it; if they bring it up, offer a fresh one.`;
  }
  s.log({ signin_remote: "ended", how, site: entry.site, conversation: c, state: s.ended.state });
  // Only news is worth a message. A link that was replaced unopened, or that simply lapsed, is not.
  if (note && how !== "link_expired") db.createTimer(c, { fireAt: clock.now(), note });
  if (byConversation.get(c) === s.token) byConversation.delete(c);
  // Kept a little while so the page can show the result, then forgotten.
  const t = s.timers.set(() => sessions.delete(s.token), 10 * 60_000);
  t?.unref?.();
  return s.ended;
}

const cookieName = (token) => `rs_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
function readCookie(headers, name) {
  for (const part of String(headers?.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", ...extra });
const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (status, body) => ({ status, headers: JSONH, body: JSON.stringify(body) });
const gone = () => ({ status: 404, headers: HTML(), body: shell("This link is no longer good", `<p class="lead">Sign-in links work once and only for a few minutes. Ask Reason for a fresh one.</p>`) });

/**
 * One request to a sign-in link. Pulled out of the server like `pageRequest`, so the whole thing
 * is drivable without a socket and without a browser.
 *
 * A token that does not exist and a session somebody else already owns answer the same 404, so
 * the link space cannot be probed and a forwarded link tells its second reader nothing.
 */
export async function remoteRequest({ token, action = "", method = "GET", headers = {}, readBody = async () => "" }) {
  const s = TOKEN.test(String(token ?? "")) ? sessions.get(token) : null;
  if (!s) return gone();
  const name = cookieName(s.token);
  const mine = s.secret && same(readCookie(headers, name), s.secret);

  // ---------- the page ----------
  if (method === "GET" && action === "") {
    if (s.ended) return { status: 200, headers: HTML(), body: resultPage(s) };
    if (!s.secret) return { status: 200, headers: HTML(), body: startPage(s) };
    if (!mine) return gone();
    return { status: 200, headers: HTML(), body: livePage(s) };
  }

  // ---------- Start: this browser becomes the only one that can use the link ----------
  if (method === "POST" && action === "start") {
    if (s.ended) return gone();
    if (s.secret && !mine) return gone();
    if (!s.secret) {
      const blocked = s.busy(s.conversationId);
      if (blocked) return { status: 409, headers: HTML(), body: shell("Not right now", `<p class="lead">${esc(blocked)}</p>`) };
      s.secret = newToken();
      s.startedAt = clock.now();
      s.timers.clear(s.timer);
      s.timer = s.timers.set(() => { end(s, "timed_out").catch(() => {}); }, config.remoteSigninSessionMs);
      s.timer?.unref?.();
      try {
        // The saved profile can be in one browser at a time, and this one needs it.
        await s.closeBrowser(s.conversationId);
        s.browser = await s.launch({ conversationId: s.conversationId, url: s.entry.signin_url });
      } catch (e) {
        s.log({ signin_remote: "launch_failed", site: s.entry.site, why: (e?.message ?? String(e)).split("\n")[0] });
        await end(s, "launch_failed");
        return { status: 500, headers: HTML(), body: shell("That did not start", `<p class="lead">The browser would not open. Nothing was changed. Ask Reason for a fresh link in a minute.</p>`) };
      }
      s.log({ signin_remote: "started", site: s.entry.site, conversation: s.conversationId });
    }
    const secure = /^https:/i.test(config.publicUrl || "") ? "; Secure" : "";
    return {
      status: 303,
      headers: {
        Location: `${PATH}/${s.token}`, "Cache-Control": "no-store",
        "Set-Cookie": `${name}=${s.secret}; Path=${PATH}/${s.token}; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(config.remoteSigninSessionMs / 1000)}${secure}`,
      },
      body: "",
    };
  }

  // Everything below drives the browser, so it is this session's own browser or nothing.
  if (!mine) return gone();
  if (s.ended) return json(410, { ended: true, state: s.ended.state });
  if (!s.browser) return json(409, { error: "not started" });
  const page = s.browser.page;

  if (method === "GET" && action === "shot") {
    const shot = await inTurn(s, () => page.screenshot({ type: "jpeg", quality: 55 })).catch(() => null);
    if (!shot) return json(503, { error: "no picture" });
    return { status: 200, headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }, body: shot };
  }

  if (method === "POST") {
    let input = {};
    try { input = JSON.parse((await readBody()) || "{}"); } catch { return json(400, { error: "bad json" }); }
    const settle = () => new Promise(r => setTimeout(r, config.remoteSigninSettleMs));

    if (action === "tap") {
      const x = Number(input.x), y = Number(input.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return json(400, { error: "tap needs x and y between 0 and 1" });
      await inTurn(s, async () => { await page.mouse.click(Math.round(x * VIEW.width), Math.round(y * VIEW.height)); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "type") {
      // The one place a password passes through. It goes to the page and nowhere else: not to the
      // log, not to the database, not onto the session object, and not back in the response.
      const text = typeof input.text === "string" ? input.text : "";
      if (!text || text.length > MAX_TYPED) return json(400, { error: `type needs 1 to ${MAX_TYPED} characters` });
      await inTurn(s, async () => { await page.keyboard.type(text); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "key") {
      if (!KEYS.has(input.key)) return json(400, { error: "that key is not one of the few this sends" });
      await inTurn(s, async () => { await page.keyboard.press(input.key); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "scroll") {
      const dy = Math.max(-2000, Math.min(2000, Number(input.dy) || 0));
      const dx = Math.max(-2000, Math.min(2000, Number(input.dx) || 0));
      await inTurn(s, async () => { await page.mouse.wheel(dx, dy); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "back") {
      await inTurn(s, async () => { await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "done") {
      const ended = await end(s, "done");
      return json(200, { ok: true, ended: true, state: ended.state });
    }
  }
  return json(404, { error: "not found" });
}

/** For tests, and for a shutdown that should not leave a browser holding somebody's profile. */
export async function endAllRemoteSignins(how = "shutdown") {
  await Promise.all([...sessions.values()].filter(s => !s.ended).map(s => end(s, how).catch(() => {})));
}
export function forgetAllRemoteSignins() { sessions.clear(); byConversation.clear(); }

// ---------- the pages ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function shell(title, inner, { script = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#16181d;--mute:#6b7280;--card:#fff;--line:#e2e2df;--go:#16181d;--gofg:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0f1114;--fg:#eceef1;--mute:#9aa1ac;--card:#181b20;--line:#2a2e35;--go:#eceef1;--gofg:#0f1114}}
*{box-sizing:border-box}body{margin:0;font:16px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:460px;margin:0 auto;padding:16px}h1{font-size:20px;margin:8px 0 6px}.lead{color:var(--mute);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
ul{margin:0;padding-left:18px}li{margin:6px 0}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:10px 12px;min-height:44px}
button.go{background:var(--go);color:var(--gofg);border-color:var(--go);width:100%;font-weight:600}
#v{display:block;width:100%;border:1px solid var(--line);border-radius:12px;background:#fff;touch-action:none;-webkit-user-select:none;user-select:none}
.row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}.row>*{flex:1}
input[type=text],input[type=password]{font:inherit;width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);min-height:44px}
.bar{position:sticky;top:0;z-index:2;background:var(--bg);padding:8px 0 6px;border-bottom:1px solid var(--line);margin-bottom:8px}
.bar .row{margin:6px 0}.tight button{padding:8px 4px;min-height:40px;font-size:14px}
.small{font-size:13px;color:var(--mute)}label.small{display:flex;gap:6px;align-items:center;flex:none}
</style></head><body><main>${inner}</main>${script}</body></html>`;
}

function startPage(s) {
  const label = esc(s.entry.label);
  return shell(`Sign in to ${s.entry.label}`, `
<h1>Sign in to ${label}</h1>
<p class="lead">This shows you Reason's own browser so you can sign in to ${label} yourself. Reason keeps the signed-in session, not your password.</p>
<div class="card"><ul>
<li>You will see ${label}'s real sign-in page. Tap it and type as you normally would.</li>
<li>What you type is passed straight to ${label}. It is not saved, logged, or shown to the assistant.</li>
<li>A password or a code by text works. Face ID and passkeys do not, because the browser is not on this phone.</li>
<li>This link works once, on this device, for a few minutes.</li>
</ul></div>
<form method="post" action="${PATH}/${s.token}/start"><button class="go" type="submit">Start</button></form>
<p class="small">Did not ask Reason for this? Close the page. Nothing happens unless you tap Start.</p>`);
}

function resultPage(s) {
  const label = esc(s.entry.label);
  const body = s.ended.state === "signed_in"
    ? `<h1>You're signed in to ${label}</h1><p class="lead">${label} confirmed it. You can close this page; Reason will text you.</p>`
    : s.ended.state === "signed_out"
      ? `<h1>Not signed in to ${label}</h1><p class="lead">${label} still shows its sign-in page, so nothing was saved. Ask Reason for a fresh link to try again.</p>`
      : s.ended.state
        ? `<h1>Could not tell</h1><p class="lead">The sign-in ended, but ${label}'s page could not be read to confirm it. Ask Reason to check.</p>`
        : `<h1>This link has ended</h1><p class="lead">Ask Reason for a fresh one.</p>`;
  return shell(`${s.entry.label} sign-in`, body);
}

function livePage(s) {
  const base = `${PATH}/${s.token}`;
  const label = esc(s.entry.label);
  // The controls sit at the top and stay there. A phone's keyboard covers the bottom half of the
  // screen, so a typing box under the picture would be typed into blind; up here the box, and the
  // top of the site's page where sign-in forms live, are both still in view while typing.
  return shell(`Sign in to ${s.entry.label}`, `
<div class="bar">
<div class="row"><h1 style="flex:2;margin:0;align-self:center">${label}</h1><button class="go" id="done" style="flex:3">Done, I'm signed in</button></div>
<div class="row"><input id="t" type="password" placeholder="Type here, then Send" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" style="flex:4"><button id="send">Send</button></div>
<div class="row tight"><button id="enter" aria-label="Enter">⏎</button><button id="bksp">⌫</button><button id="tab">Tab</button><button id="up">▲</button><button id="down">▼</button><button id="back">Back</button><label class="small"><input id="show" type="checkbox"> show</label></div>
</div>
<p class="small">Tap the picture to tap the page. Type in the box above and press Send.</p>
<img id="v" alt="${label} in Reason's browser" width="${VIEW.width}" height="${VIEW.height}">
<p class="small" id="msg"></p>`, { script: `<script>
(function(){
var base=${JSON.stringify(base)},v=document.getElementById('v'),t=document.getElementById('t'),msg=document.getElementById('msg'),busy=false,dead=false,last=0;
function post(a,b){return fetch(base+'/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{}),credentials:'same-origin'}).then(function(r){if(r.status===404||r.status===410){over()}return r})}
function over(){if(dead)return;dead=true;location.reload()}
function shot(){if(dead||busy)return;busy=true;fetch(base+'/shot?'+Date.now(),{credentials:'same-origin'}).then(function(r){if(r.status===404||r.status===410){over();return null}return r.ok?r.blob():null}).then(function(b){if(b){var u=URL.createObjectURL(b),old=v.src;v.src=u;if(old&&old.indexOf('blob:')===0)setTimeout(function(){URL.revokeObjectURL(old)},500)}}).catch(function(){}).then(function(){busy=false;last=Date.now()})}
function soon(){setTimeout(shot,60);setTimeout(shot,700)}
setInterval(function(){if(Date.now()-last>900)shot()},450);shot();
var sx=0,sy=0,moved=false;
v.addEventListener('pointerdown',function(e){sx=e.clientX;sy=e.clientY;moved=false;e.preventDefault()});
v.addEventListener('pointermove',function(e){if(Math.abs(e.clientX-sx)>12||Math.abs(e.clientY-sy)>12)moved=true});
v.addEventListener('pointerup',function(e){var r=v.getBoundingClientRect(),k=${VIEW.width}/r.width;
 if(moved){post('scroll',{dx:Math.round((sx-e.clientX)*k),dy:Math.round((sy-e.clientY)*k)}).then(soon)}
 else{post('tap',{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}).then(soon)}e.preventDefault()});
function send(){var x=t.value;if(!x)return;t.value='';post('type',{text:x}).then(soon)}
document.getElementById('send').onclick=send;
t.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();if(t.value){send()}else{key('Enter')}}});
function key(k){post('key',{key:k}).then(soon)}
document.getElementById('enter').onclick=function(){if(t.value){var x=t.value;t.value='';post('type',{text:x}).then(function(){key('Enter')})}else key('Enter')};
document.getElementById('bksp').onclick=function(){key('Backspace')};
document.getElementById('tab').onclick=function(){key('Tab')};
document.getElementById('up').onclick=function(){post('scroll',{dy:-420}).then(soon)};
document.getElementById('down').onclick=function(){post('scroll',{dy:420}).then(soon)};
document.getElementById('back').onclick=function(){post('back').then(soon)};
document.getElementById('show').onchange=function(e){t.type=e.target.checked?'text':'password'};
document.getElementById('done').onclick=function(){msg.textContent='Checking with ${label}…';post('done').then(function(){dead=true;location.reload()})};
})();
</script>` });
}
