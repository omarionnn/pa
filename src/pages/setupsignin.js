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

/** The intro (StoreSignIn's place): what happens next, the facts in short muted lines, and Start. */
export function setupStartPage({ entry, action }) {
  const n = entry.label;
  const main = headline(`Sign in to ${n}.`, "Just this once.")
    + lede(`You'll see ${n}'s own sign-in page, inside my browser. I keep the signed-in session, never your password.`)
    + `<div class="pf-l pen ss-seal">${sealed(`SEALED · YOUR ${upper(n)} LOGIN`)}</div>`
    + `<ul class="ss-facts"><li>a password or a code by text or email works.</li><li>passkeys and Face ID on ${esc(n)} don't, since my browser isn't on this phone.</li>`
    + `<li>your saved ${esc(n)} login won't pop up by itself: tap Passwords above the keyboard and pick ${esc(n)}.</li><li>this link works once, on this device, for a few minutes.</li></ul>`
    + `<form class="ss-form" id="ss-start" method="post" action="${esc(action)}">${actions(go("Sign in", { attrs: ` data-ss-busy="1"` }))}`
    + `<div class="ss-live">${live({ id: "ss-wait", lines: startingLines(n), hidden: true })}</div></form>`
    + note(`${n} might send you a code. that's normal.`, { sp: true });
  // The Start is a plain form post that waits for the browser to open: never a dead page meanwhile.
  const script = `(function(){var f=document.getElementById('ss-start'),w=document.getElementById('ss-wait');if(!f)return;f.addEventListener('submit',function(){var b=f.querySelector('button');if(b){b.setAttribute('aria-busy','true');setTimeout(function(){b.disabled=true},0)}if(w&&window.pfLive)pfLive(w,{})})})();`;
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
export function setupResultPage({ entry, ended, back = "", thread = null, card = "signin" }) {
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
    const [h1, why, reply] = state === "blocked"
      ? [`${n} wouldn't let me in.`, `${n} stopped my browser with a bot check before its sign-in page loaded. That isn't something you did${t ? ", and a fresh link would hit the same wall. Reason will text you what works instead." : "."}`, `${n} blocked the sign-in`]
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
export function setupCodePage({ entry, action, error = "", card = "signin" }) {
  const n = entry.label;
  const main = headline("Enter the code Reason texted you.", "Just this once.")
    + lede(`This browser isn't signed in to Reason yet, so Reason texted you a code first. That keeps a forwarded link from opening your ${n} sign-in. After this once, Reason remembers this browser and its links open straight away.`)
    + `<form class="ss-form" id="ss-code" method="post" action="${esc(action)}">${codeInput({ name: "code", legend: "THE CODE", error })}${actions(go("Sign in"))}</form>`
    + `<form class="ss-form" method="post" action="${esc(action)}"><input type="hidden" name="send" value="1">${actions(two("TEXT ME A NEW CODE", { type: "submit" }))}</form>`
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
