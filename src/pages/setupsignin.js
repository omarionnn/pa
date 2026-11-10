// The web setup's store sign-in (heyreason.com/start → Amazon), drawn in the same paper look as the
// store sign-in a person gets in texts (src/pages/webconnect.js, the 10-30 card and store sign-in
// handoff): wordmark header, a serif headline with its muted turn, a margin column, a step checklist,
// and the lifted CONNECTED paper at the end. The mechanics are the remote sign-in's own
// (src/signin-remote.js: Start, Reason's browser on the store's real page, done/cancel); only the
// screens change, and the way out goes back to the setup's connect screen, never a thread.
//
// No store logo, mark or colour: the store is named in text, like every Connect page.
import { webPage } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, note, go, two, actions, paper, steps, STEP_JS } from "./paperkit.js";
import { withSecuredCard } from "./securedcard.js";
import { esc } from "./render.js";

const CSS = `${PAPER_CSS}
.ss-form{margin-top:28px}
.ss-note{margin-top:20px}
.ss-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 10px}
.ss-live .pf-mn{padding-top:24px}
.ss-live .pf .h1,.ss-live .h1{font-size:clamp(2rem,5vw,3rem)}
#tip,#msg{margin:10px 0 0;font-size:15px;line-height:1.5;color:var(--muted);min-height:1.5em}
#stage{position:relative;width:100%;border:1px solid var(--hair);border-radius:var(--radius);overflow:hidden;background:var(--lifted);box-shadow:var(--sh2)}
#v{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:var(--lifted);color:var(--muted);font-size:15px;transition:opacity .2s}
#veil.off{opacity:0;pointer-events:none}
.spin{display:inline-block;width:18px;height:18px;margin-right:9px;border:2px solid var(--hair);border-top-color:var(--pen);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-4px}
@keyframes sp{to{transform:rotate(360deg)}}
#f{position:absolute;inset:0;pointer-events:none;margin:0}
#f input{position:absolute;left:-9999px;top:0;width:10px;height:10px;min-height:0;padding:0 6px;margin:0;border:0;border-radius:3px;font:inherit;background:#fff;color:#000;pointer-events:auto;opacity:0;-webkit-appearance:none;appearance:none}
#f input.at{opacity:1;outline:2px solid var(--pen);outline-offset:-2px}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
`;

const page = (title, body, { kind = "signin", script = "", cls = "" } = {}) =>
  withSecuredCard(webPage({ title, body, css: CSS, script: `${STEP_JS}${script}`, bodyClass: cls }), kind);

/** What signing in lets Reason do, and what it never sees: beside the sign-in, as on the texted page. */
function margin(n) {
  return label("SIGNED IN, I CAN") + para("See your orders, track them, and reorder.") + para("Only buy after you approve the exact total with Face ID.")
    + label("I NEVER SEE", { pen: true, sp: true }) + para(`Your password, or the codes ${esc(n)} sends. They go straight to ${esc(n)}.`)
    + label("GOOD TO KNOW", { sp: true }) + para(`Your saved ${esc(n)} login: tap <b>Passwords</b> above the keyboard and pick ${esc(n)}.`)
    + para("A password or a code by text works. Face ID and passkeys don't: the browser isn't on this phone.", { muted: true });
}

/** StoreSignIn's intro: what happens, then Start (which opens Reason's browser on the store's page). */
export function startPage({ name, action, kind }) {
  const main = headline(`Sign in to ${name}.`, "Just this once.", "cx-h")
    + lede(`You'll sign in on ${name}'s real page, inside Reason's own browser. I keep the signed-in session, never your password.`)
    + `<div class="ss-form">${steps([[`Open ${name}'s sign-in`, "now"], ["Sign in the way you normally do", "todo"], ["Back to your setup", "todo"]])}</div>`
    + `<form method="post" action="${esc(action)}" class="ss-note">${actions(go("Start", { attrs: ` data-busy="Starting…"` }))}</form>`
    + `<div class="ss-note">${note("this link works once, on this device, for a few minutes.")}</div>`;
  return page(`Reason — sign in to ${name}`, `${header()}<main class="pf" id="cx-main">${frame({ main, margin: margin(name) })}</main>`, { kind });
}

/**
 * The live sign-in: the store's real page in Reason's browser, inside the paper frame. `stage` is the
 * remote sign-in's own picture and input overlay, and `script` its own driver (ids #v, #stage, #veil,
 * #f, #tip, #msg, #back, #done, #stop), unchanged.
 */
export function livePage({ name, stage, script, kind }) {
  const main = `<div class="ss-top">${label(`SIGNING IN TO ${name.toUpperCase()}`)}${two("BACK", { attrs: ` id="back"` })}</div>`
    + headline(`Sign in to ${name}.`, "Tap the page.", "cx-h")
    + `<p id="tip">Tap the page and sign in the way you normally would.</p>${stage}<p id="msg" role="status" aria-live="polite"></p>`
    + actions(go("I'm signed in", { type: "button", attrs: ` id="done"` }), two("CANCEL", { attrs: ` id="stop"` }));
  const side = label("WHILE YOU SIGN IN") + steps([[`${name}'s sign-in is open`, "done"], ["Sign in the way you normally do", "now"], ["Back to your setup", "todo"]])
    + label("I NEVER SEE", { pen: true, sp: true }) + para(`What you type. It goes straight to ${esc(name)}, and isn't saved or logged.`);
  // The driver arrives as a <script> element; webPage puts its own tag around what it is given.
  const js = String(script).trim().replace(/^<script>/, "").replace(/<\/script>$/, "");
  return page(`Reason — sign in to ${name}`, `${header()}<main class="pf" id="cx-main">${frame({ main, margin: side })}</main>`, { kind, script: js, cls: "ss-live" });
}

/** How it ended (StoreConnected, or StoreCantConnect), and the way back to the setup. */
export function resultPage({ name, state, back, kind }) {
  const N = name.toUpperCase();
  let main;
  if (state === "signed_in") {
    main = headline(`You're signed in to ${name}.`, "Back to your setup.", "cx-h")
      + lede(`${name} confirmed it. When you want something, just text me. I'll send the exact total before buying.`)
      + paper({ stamp: "CONNECTED", label: N, big: "Signed in.", mono: false })
      + `<div class="ss-note">${actions(go("Back to your setup", { href: back }))}</div>`;
  } else {
    const [h, turn, why] = state === "blocked"
      ? [`${name} wouldn't let me in.`, "Nothing was saved.", `${name} stopped the page with a bot check before you could sign in. That isn't something you did. You can still connect it later from a text.`]
      : state === "signed_out"
        ? [`Not signed in to ${name}.`, "Nothing was saved.", `${name} still shows its sign-in page. Go back and tap ${name} to try again.`]
        : state
          ? ["Couldn't tell.", "Nothing was saved.", `The sign-in ended, but ${name}'s page couldn't be read to confirm it. Go back and tap ${name} to try again.`]
          : ["This link has ended.", "Nothing was saved.", `Sign-in links work once and only for a few minutes. Go back and tap ${name} for a fresh one.`];
    main = headline(h, turn, "cx-h") + lede(why) + `<div class="ss-note">${actions(go("Back to your setup", { href: back }))}</div>`;
  }
  const side = label("NOTHING BOUGHT") + para("Connecting never buys anything.") + label("AND", { sp: true }) + para(`Sign me out of ${esc(name)} any time.`);
  // Signed in: back to the setup on its own after a moment (the setup's connect screen then shows it connected).
  const script = state === "signed_in" ? `;setTimeout(function(){location.href=${JSON.stringify(back).replace(/</g, "\\u003c")}},2500)` : "";
  return page(`Reason — ${name}${state === "signed_in" ? " connected" : " sign-in"}`, `${header()}<main class="pf" id="cx-main">${frame({ main, margin: side })}</main>`, { kind, script });
}
