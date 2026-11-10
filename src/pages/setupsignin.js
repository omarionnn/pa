// The remote store sign-in (src/signin-remote.js, the /s/<token> pages), drawn on paper like the
// store sign-in in the card and store sign-in design handoff (StoreSignIn, StoreConnected,
// StoreCantConnect; the same kit as src/pages/webconnect.js).
//
// Every sign-in link gets these pages (owner, 2026-11-10: he saw the plain one from a text and the
// paper one from the web setup, and wants the paper one everywhere). The live browser itself is the
// same picture and the same script; only the frame around it is paper. The one thing that differs
// by where the link came from is the way on at the end:
//
//   - a web setup's stand-in (`websetup:<id>`, src/websetup.js): "Back to setup", to the setup's
//     connect screen, and signed in goes back on its own after a moment;
//   - a text thread: "Back to Reason" (Messages, the reply typed: src/pages/render.js backToReason),
//     and nothing moves on its own — the person taps, and Reason texts them either way.
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { securedCardTags } from "./securedcard.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, note, sealed, go, two, actions, paper, live, LIVE_JS, codeInput, CODE_JS } from "./paperkit.js";

const CSS = `${PAPER_CSS}
.ss-facts{margin:28px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;max-width:480px}
.ss-facts li{font-size:15px;line-height:1.5;color:var(--muted)}
.ss-seal{margin:56px 0 0;display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px dashed var(--hair)}
.ss-form{margin:40px 0 0;display:flex;flex-direction:column;gap:28px}
.ss-form .pf-acts{margin-top:0}
.ss-live .pf-live{margin-top:0}
.ss-small{margin:0;font-size:14px;line-height:1.5;color:var(--muted)}
/* The live page: the picture of Reason's browser, on paper. */
.ss-lv{padding-top:24px;display:flex;flex-direction:column;gap:14px;max-width:460px}
.ss-lv .h1{font-size:clamp(2rem,8vw,3rem)}
#stage{position:relative;width:100%;aspect-ratio:var(--ss-ar);border:1px solid var(--hair);border-radius:var(--radius);box-shadow:var(--sh2);overflow:hidden;background:var(--lifted)}
#v{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:var(--lifted);color:var(--muted);font-size:15px;transition:opacity .2s}
#veil.off{opacity:0;pointer-events:none}
.spin{display:inline-block;width:18px;height:18px;margin-right:9px;border:2px solid var(--hair);border-top-color:var(--pen);border-radius:50%;animation:ss-sp .8s linear infinite;vertical-align:-4px}
@keyframes ss-sp{to{transform:rotate(360deg)}}
#f{position:absolute;inset:0;pointer-events:none;margin:0}
#f input{position:absolute;left:-9999px;top:0;width:10px;height:10px;min-height:0;padding:0 6px;margin:0;border:0;border-radius:3px;font:inherit;background:#fff;color:#000;pointer-events:auto;opacity:0;-webkit-appearance:none;appearance:none}
#f input.at{opacity:1;outline:2px solid var(--pen);outline-offset:-2px}
.ss-lv .pf-acts{margin-top:4px;gap:8px 28px}
.ss-lv .pf-go{font-size:26px}
.ss-lv .pf-acts+.pf-acts{margin-top:-8px}
/* The site's own provider choices, in Reason's paper: one outlined row each, the provider's
   official mark on the left, its words in plain sans (Google, Apple, Facebook and Microsoft brand
   guidelines all allow the white/outlined button with the full-colour mark). */
.ss-pv{display:flex;flex-direction:column;gap:12px;max-width:380px}
.ss-pv button{display:flex;align-items:center;gap:14px;width:100%;min-height:52px;padding:0 18px;border:1px solid var(--ink);border-radius:var(--radius);background:var(--lifted);color:var(--ink);font:500 17px/1 var(--sans);text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none}
.ss-pv button:hover,.ss-pv button:focus-visible{border-color:var(--pen);outline:none;box-shadow:0 0 0 1px var(--pen)}
.ss-pv button[aria-busy="true"]{opacity:.6}
.ss-pv svg{width:20px;height:20px;flex:0 0 20px}
.ss-pv .mine{margin-left:auto;font:400 10px/1 var(--mono);letter-spacing:.14em;color:var(--pen)}
.ss-or{display:flex;align-items:center;gap:12px;max-width:380px}
.ss-or:before,.ss-or:after{content:"";flex:1;border-top:1px dashed var(--hair)}
`;

const upper = (s) => String(s ?? "").toUpperCase();

function page(title, body, { entry, script = "", card = "signin", right } = {}) {
  const eyebrow = right === undefined ? `${upper(entry?.label || "STORE")} ACCOUNT` : right;
  return webPage({ title, body: `${header({ right: eyebrow })}<main class="pf" id="ss-main">${body}</main>`, css: CSS, script: `${LIVE_JS}${script}`, head: securedCardTags(card) });
}

/** What signing in lets Reason do, beside the sign-in. Amazon's own words; a store with none gets a plain line. */
function margin(entry) {
  const n = esc(entry.label);
  const amazon = entry.site === "amazon";
  return label("SIGNED IN, I CAN") + para(amazon ? "See your orders and help you reorder." : `Help with your ${n} account when you ask.`)
    + label("I NEVER", { pen: true, sp: true }) + para("Buy anything without your Face ID.") + para("Change your password or your address.")
    + label("AND", { sp: true }) + para(`Sign me out of ${n} anytime.`);
}

// The providers' own marks (the only marks on these pages: the owner asked for the site's
// "Continue with" choices in Reason's look, 2026-11-10). Official shapes and colours, unaltered.
export const PROVIDER_MARKS = {
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
  apple: `<svg viewBox="0 0 814 1000" aria-hidden="true"><path fill="#000" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11.5" fill="#fff"/><path fill="#0866FF" d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.32l-.53 3.5h-2.8V24C19.62 23.1 24 18.1 24 12.07"/></svg>`,
  microsoft: `<svg viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>`,
};
const PROVIDER_NAME = { google: "Google", apple: "Apple", facebook: "Facebook", microsoft: "Microsoft" };
/** The one-line heads-up for each provider's two-step, matching src/socialsignin.js expectLine. */
const PROVIDER_EXPECT = { google: "Google may ping your phone. Tap Yes.", apple: "Apple may show a code on your iPhone or Mac.", microsoft: "Microsoft may ping the Authenticator app.", facebook: "Facebook may ask you to confirm it's you." };

/**
 * The intro (StoreSignIn's place): what happens next, the facts in short muted lines, and Start.
 *
 * `offered` (src/socialsignin.js offeredFor): the "Continue with" choices the site itself has, shown
 * first in Reason's look, each a submit of the same Start form with `via` set; the site's own email
 * sign-in stays below as the plain Sign in. `mine`: the provider their saved login already uses.
 */
export function setupStartPage({ entry, action, offered = [], mine = "" }) {
  const n = entry.label;
  const pv = (offered ?? []).filter(p => PROVIDER_MARKS[p]);
  const buttons = pv.length
    ? `<div class="ss-pv">${pv.map(p => `<button type="submit" name="via" value="${p}" data-ss-busy="1">${PROVIDER_MARKS[p]}<span>Continue with ${PROVIDER_NAME[p]}</span>${p === mine ? `<span class="mine">YOURS</span>` : ""}</button>`).join("")}</div>`
      + `<p class="pf-l ss-or">OR</p>`
    : "";
  const lede0 = pv.length
    ? `${n} lets you sign in with ${pv.length === 1 ? PROVIDER_NAME[pv[0]] : `${pv.slice(0, -1).map(p => PROVIDER_NAME[p]).join(", ")} or ${PROVIDER_NAME[pv.at(-1)]}`}. Pick the one you use and you'll finish on its own page, inside my browser. I keep the signed-in session, never your password.`
    : `You'll see ${n}'s own sign-in page, inside my browser. I keep the signed-in session, never your password.`;
  const facts = pv.length
    ? `<li>${esc(PROVIDER_EXPECT[mine && pv.includes(mine) ? mine : pv[0]])}</li><li>${esc(n)} might send a code of its own after. that's normal.</li>`
      + `<li>passkeys and Face ID don't work here, since my browser isn't on this phone.</li><li>this link works once, on this device, for a few minutes.</li>`
    : `<li>a password or a code by text or email works.</li><li>passkeys and Face ID on ${esc(n)} don't, since my browser isn't on this phone.</li>`
      + `<li>your saved ${esc(n)} login won't pop up by itself: tap Passwords above the keyboard and pick ${esc(n)}.</li><li>this link works once, on this device, for a few minutes.</li>`;
  const main = headline(`Sign in to ${n}.`, "Just this once.")
    + lede(lede0)
    + `<div class="pf-l pen ss-seal">${sealed(`SEALED · YOUR ${upper(n)} LOGIN`)}</div>`
    + `<ul class="ss-facts">${facts}</ul>`
    + `<form class="ss-form" id="ss-start" method="post" action="${esc(action)}">${buttons}${actions(go(pv.length ? `Use my ${n} email` : "Sign in", { attrs: ` name="via" value="" data-ss-busy="1"` }))}`
    + `<div class="ss-live">${live({ id: "ss-wait", lines: startingLines(n), hidden: true })}</div></form>`
    + (pv.length ? "" : note(`${n} might send you a code. that's normal.`, { sp: true }));
  // The Start is a plain form post that waits for the browser to open: never a dead page meanwhile.
  // The tapped button is the one marked busy (a provider's or the email one); every one then stops.
  const script = `(function(){var f=document.getElementById('ss-start'),w=document.getElementById('ss-wait');if(!f)return;f.addEventListener('submit',function(e){var b=e.submitter||f.querySelector('button');if(b)b.setAttribute('aria-busy','true');setTimeout(function(){f.querySelectorAll('button').forEach(function(x){x.disabled=true})},0);if(w&&window.pfLive)pfLive(w,{})})})();`;
  return page(`Reason — sign in to ${n}`, frame({ main, margin: margin(entry) }), { entry, script, card: entry.site === "amazon" ? "amazon" : "signin" });
}

/** While Reason's browser opens (the Start post, until the live page loads). */
export const startingLines = (n) => [
  [0, "Opening my browser, sealed."],
  [6, `Loading ${n}'s sign-in page.`],
  [20, "Still opening. This can take a moment."],
  [45, "Taking longer than usual. Still on it."],
];

/** The live picture, framed in paper. The ids are the ones the live script (src/signin-remote.js) drives. */
export function setupLivePage({ entry, view, script, card = "signin" }) {
  const n = esc(entry.label);
  const body = `<div class="ss-lv" style="--ss-ar:${view.width}/${view.height}">`
    + headline(`Sign in to ${entry.label}.`)
    + `<p class="ss-small" id="tip">Tap the page and sign in the way you normally would.</p>`
    + `<div id="stage"><img id="v" alt=""><form id="f" autocomplete="on" onsubmit="return false">`
    + `<input id="in-u" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false">`
    + `<input id="in-p" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false">`
    + `<input id="in-o" type="text" autocomplete="one-time-code" inputmode="numeric" autocapitalize="off" autocorrect="off" spellcheck="false">`
    + `<input id="in-g" type="text" autocomplete="on"></form>`
    + `<div id="veil"><span><span class="spin"></span>Opening ${n}…</span></div></div>`
    + `<p class="ss-small" id="msg" role="status"></p>`
    + actions(go("I'm signed in", { type: "button", attrs: ` id="done"` })) + actions(two("BACK A PAGE", { attrs: ` id="back"` }), two("CANCEL", { attrs: ` id="stop"` }))
    + label("SEALED · NOTHING YOU TYPE IS KEPT", { pen: true })
    + `</div>`;
  return page(`Reason — sign in to ${entry.label}`, body, { entry, script, card });
}

/**
 * How it ended (StoreConnected, or StoreCantConnect's place), with the way on.
 *
 * A setup (`back`, the setup's connect screen): "Back to setup"; signed in goes back on its own after
 * a moment, anything else waits for the tap. A text thread (`thread.reply(text)`, the sms: link that
 * opens Messages with that reply typed, or "" with no number to text from): "Back to Reason", and
 * nothing moves on its own. "Reason will text you" stays true either way: the thread is woken by
 * the ending itself (src/signin-remote.js end), and the tap is only the faster of the two.
 */
export function setupResultPage({ entry, ended, back = "", thread = null, card = "signin", instead = "" }) {
  const n = entry.label;
  const state = ended?.state ?? null;
  const ok = state === "signed_in";
  const t = !!thread;
  /** The way on: the setup's link, or Messages with the reply that says how it went. */
  const way = (reply) => {
    if (!t) return `<div class="ss-form">${actions(go("Back to setup", { href: back, attrs: ` id="ss-back"` }))}</div>`;
    const href = thread.reply(reply);
    return href ? `<div class="ss-form">${actions(go("Back to Reason", { href, attrs: ` id="ss-back"` }))}${note("opens Messages with your reply typed. just hit send.")}</div>` : "";
  };
  let main, side;
  if (ok) {
    main = headline(`You're signed in to ${n}.`, t ? "Back to Reason." : "Back to your setup.")
      + lede(t
        ? (entry.site === "amazon" ? `${n} confirmed it. Reason will text you. I'll keep an eye on your orders, and nothing is bought without your Face ID.` : `${n} confirmed it. Reason will text you. Nothing is bought without your Face ID.`)
        : (entry.site === "amazon" ? `${n} confirmed it. I'll keep an eye on your orders, and nothing is bought without your Face ID.` : `${n} confirmed it. Nothing is bought without your Face ID.`))
      + paper({ stamp: "CONNECTED", label: upper(n), big: "Signed in.", mono: false })
      + way(`signed in to ${n}, keep going`);
    side = label("SIGNED IN, I CAN") + para(entry.site === "amazon" ? "See your orders and help you reorder." : `Help with your ${esc(n)} account.`)
      + label("AND", { sp: true }) + para(`Sign me out of ${esc(n)} anytime.`);
  } else {
    // A setup tries again from its connect screen; a thread asks Reason for a fresh link.
    const again = t ? "Ask Reason for a fresh link to try again." : "You can try again from your setup.";
    const prov = ended?.provider ? ({ google: "Google", apple: "Apple", microsoft: "Microsoft", facebook: "Facebook" })[ended.provider] ?? "The provider" : "The provider";
    const [h1, why, reply] = state === "refused"
      ? [`${prov} said no to my browser.`, `${prov} refused my browser for ${n}, so nothing was saved and I won't try it again. ${t ? `Reason will text you a secure link to sign in with your ${n} email and password instead.` : `You can sign in with your ${n} email and password from your setup.`}`, `${prov} refused the sign-in`]
      : state === "blocked"
      ? [`${n} is blocking my browser right now.`, `${n} stopped my browser with a security check before its sign-in page loaded. That's ${n}'s choice, not something you did${t ? ", and a fresh link would hit the same wall." : "."}${instead ? ` ${instead}` : ""}${t ? (instead ? " Reason will text you about it." : " Reason will text you what works instead.") : ""}`, `${n} blocked the sign-in`]
      : state === "signed_out"
        ? [`Not signed in to ${n}.`, `${n} still shows its sign-in page, so nothing was saved. ${again}`, `${n} didn't sign in`]
        : ended?.how === "launch_failed"
          ? [`${n} isn't answering.`, t ? `My browser couldn't open ${n} just now. It's usually a hiccup. Ask Reason for a fresh link in a minute.` : `My browser couldn't open ${n} just now. It's usually a hiccup, and it usually passes.`, `the ${n} sign-in link ended`]
          : ended?.how === "link_expired" || ended?.how === "replaced"
            ? ["This link has ended.", t ? "Sign-in links work once and only for a few minutes. Ask Reason for a fresh one." : `Sign-in links work once and only for a few minutes. Tap ${n} on your setup for a fresh one.`, `the ${n} sign-in link ended`]
            : state
              ? [`Couldn't tell with ${n}.`, t ? `The sign-in ended, but ${n}'s page couldn't be read to confirm it. Ask Reason to check.` : `The sign-in ended, but ${n}'s page couldn't be read to confirm it. You can try again from your setup.`, `${n} sign-in ended, not sure if it worked`]
              : [`${n} didn't connect.`, `The sign-in was closed before it finished. ${again}`, `the ${n} sign-in link ended`];
    main = headline(h1, "Nothing was lost.") + lede(why) + way(reply);
    side = label("WHAT YOU TYPED") + para("Wasn't kept. You'll sign in fresh next time.") + note("it's fine to skip it for now.", { sp: true });
  }
  // Signed in from a setup: back to it on its own after a moment (the setup reads the new state itself).
  const script = ok && !t ? `(function(){var a=document.getElementById('ss-back');if(a)setTimeout(function(){location.href=a.href},1500)})();` : "";
  return page(ok ? `Reason — ${n} connected` : `Reason — ${n} sign-in`, frame({ main, margin: side }), { entry, script, card });
}

/**
 * The code step, for a browser that is not the person's own proved one (src/signin-remote.js
 * codePage): the code went to their own thread first. Two posts to the same Start: the code, or
 * `send=1` for a fresh one.
 */
export function setupCodePage({ entry, action, error = "", card = "signin", via = null }) {
  const n = entry.label;
  // The choice they tapped on the intro (a provider, or "" for the site's own email), carried
  // through the code so it is the one used. null: no choice was shown, nothing is carried.
  const keep = via === "" || PROVIDER_MARKS[via] ? `<input type="hidden" name="via" value="${via}">` : "";
  const main = headline("Enter the code Reason texted you.", "Just this once.")
    + lede(`This browser isn't signed in to Reason yet, so Reason texted you a code first. That keeps a forwarded link from opening your ${n} sign-in. After this once, Reason remembers this browser and its links open straight away.`)
    + `<form class="ss-form" id="ss-code" method="post" action="${esc(action)}">${keep}${codeInput({ name: "code", legend: "THE CODE", error })}${actions(go("Sign in"))}</form>`
    + `<form class="ss-form" method="post" action="${esc(action)}">${keep}<input type="hidden" name="send" value="1">${actions(two("TEXT ME A NEW CODE", { type: "submit" }))}</form>`
    + note("didn't ask Reason for this? close the page. nothing happens without the code.", { sp: true });
  const side = label("WHY A CODE") + para("A sign-in link opens your saved logins, so only a browser you've proved as yours may start one.")
    + label("I NEVER", { pen: true, sp: true }) + para("Keep what you type here.");
  return page(`Reason — sign in to ${n}`, frame({ main, margin: side }), { entry, script: CODE_JS, card });
}

/** A link that is not good any more: unknown, used up, or somebody else's. The same words for all three. */
export function setupGonePage() {
  const main = headline("This link is no longer good.", "Nothing was lost.")
    + lede("Sign-in links work once and only for a few minutes. Ask Reason for a fresh one.");
  const side = label("WHAT YOU TYPED") + para("Wasn't kept. You'll sign in fresh next time.");
  return page("Reason — sign-in link", frame({ main, margin: side }), { right: "", card: "signin" });
}

/** One short notice with no way on: the link is somebody else's browser (403), or the profile is busy (409). */
export function setupNoticePage({ entry, h1, why, card = "signin" }) {
  const main = headline(h1, "Nothing was lost.") + lede(why);
  const side = label("WHAT YOU TYPED") + para("Wasn't kept. You'll sign in fresh next time.");
  return page(`Reason — sign in to ${entry.label}`, frame({ main, margin: side }), { entry, card });
}
