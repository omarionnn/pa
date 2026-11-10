// The Connect pages: sign in to a store, and add a card, for Crossmint agent checkouts (src/shopconnect.js).
//
//   GET  /web/connect/{token}            the page for that link, drawn in its current state
//   GET  /web/connect/{token}/state      { state } for the open page to notice a change and redraw
//   POST /web/connect/{token}/answer     { requestId, answers }: the sign-in answer (secrets as references only)
//   POST /web/connect/{token}/card       { paymentMethodId, brand, last4 } after Crossmint saved the card
//   GET  /web/connect/island.js          Crossmint's two fields (web-island/, built and committed)
//   GET  /web/connect/jwks.json          the public key Crossmint checks the person's JWT against
//   GET  /web/connect/new-card           signed in (and allowed): a fresh "Add a card" link, then there
//
// One thing per screen, drawn on paper (card and store sign-in design handoff, 2026-10-30):
//   store — sign in (StoreSignIn), signed out first when a connected store asked again (StoreSignedOut),
//           no account (StoreNoAccount, a step on the same page), wrong password (StoreWrongPassword),
//           a code (StoreCode), a wrong code (StoreWrongCode), checking (a step checklist), connected
//           (StoreConnected), stopped (StoreCantConnect), run out
//   card  — add (CardAdd), then on the same page while Crossmint saves it: saving (CardSaving) and
//           error (CardError); saved (CardSaved). Manage and remove live in Settings → Shopping.
// The secret fields are Crossmint's own iframe: what is typed there never reaches this page's script
// or this server, and the field is drawn masked. Copy says what to do, never words to type.
import { readFileSync } from "node:fs";
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { withSecuredCard } from "./securedcard.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, note, sealed, field, slot, go, two, actions, paper, steps, codeInput, live, CODE_JS, STEP_JS, LIVE_JS } from "./paperkit.js";
import { SECURITY_HEADERS } from "./websignin.js";
import * as shop from "../shopconnect.js";
import * as passkey from "../passkey.js";

// No store logos, marks, icons or colours anywhere on these pages (owner 10-30): they are Reason's
// pages and name the store in text. Nothing here says Crossmint either: people know Reason. Copy
// says a store login is sealed and goes straight to the store, a card is kept securely and Reason
// sees only its brand and last four, and never what to type.

// ---------------------------------------------------------------- the stylesheet
// The paper form kit (src/pages/paperkit.js) draws every part; this is only what these screens add.
const CSS = `${PAPER_CSS}
.cx-store{margin:8px 0 0}
.cx-says{margin:16px 0 0;max-width:480px;font-size:16px;line-height:1.55;color:var(--muted)}
.cx-says b{color:var(--ink);font-weight:500}
.cx-make{display:flex;flex-direction:column;gap:2px;max-width:380px}
.cx-make b{font-weight:600}
.cx-make-go .pf-go{font-size:26px}
.cx-note{margin-top:24px}
.stg{position:fixed;right:12px;bottom:12px;z-index:60;font:700 10px/1 var(--mono);letter-spacing:.12em;padding:6px 8px;border:1px solid var(--pen);color:var(--pen);background:var(--lifted)}
`;

// ---------------------------------------------------------------- pieces
const nameOf = (store) => shop.storeName(store) || "the store";
const NAME = (store) => (shop.storeName(store) || "the store").toUpperCase();
/** The store's own site, for "make one" and "reset it there". "" when it isn't known. */
const siteOf = (store) => { const h = store ? shop.storeHost(store) : ""; return h ? `https://${h}/` : ""; };
const out = (href, text, { primary = false } = {}) => primary
  ? go(text, { href, attrs: ` target="_blank" rel="noopener noreferrer"` })
  : two(text, { href, attrs: ` target="_blank" rel="noopener noreferrer"` });
const SETTINGS = `<a href="/web/settings#shopping">Settings</a>`;
const BACK = "/web?thread";
const brandOf = (card) => (card?.brand ? card.brand.toUpperCase() : "CARD");

const isCode = (f) => f.input?.autoComplete === "one-time-code" || f.input?.inputMode === "numeric" || f.input?.kind === "number" || f.input?.kind === "integer";

/**
 * One field of the store's question. A protected one is a sealed slot Crossmint's iframe mounts into
 * (on staging, a masked stand-in); a standard one is ours: the underlined input, or for a code, the
 * six cells.
 */
function storeField(f, { store, staging = false, error = "" }) {
  const id = `f-${f.key}`;
  const code = isCode(f);
  const text = code ? `CODE FROM ${NAME(store)}` : String(f.label || f.key).toUpperCase();
  if (f.handling === "protected") {
    const inner = staging
      ? `<input class="pf-in" type="${code ? "text" : "password"}" value="${code ? (error ? "482017" : "482913") : "correcthorse"}" readonly tabindex="-1" aria-label="${esc(text)} (sealed, staging stand-in)">`
      : "";
    return slot({ id, label: text, attrs: ` data-protected="${esc(f.key)}"`, error, code, inner });
  }
  if (code) return codeInput({ name: f.key, legend: text, id, error, hint: error ? "" : "pasting the whole thing works too." });
  const email = f.input?.autoComplete === "email" || f.input?.inputMode === "email";
  // Store login fields always carry autocomplete, so the browser can fill the person's own login.
  const auto = f.input?.autoComplete || (email ? "username" : "");
  const mode = f.input?.inputMode ? ` inputmode="${esc(f.input.inputMode)}"` : email ? ` inputmode="email"` : "";
  const type = email ? "email" : f.input?.display === "masked" ? "password" : "text";
  return field({ id, label: text, attrs: ` name="${esc(f.key)}" type="${type}"${auto ? ` autocomplete="${esc(auto)}"` : ""}${mode}${f.required ? " required" : ""} spellcheck="false" autocapitalize="off"` });
}

// Never a dead page (owner 2026-10-31, 14:10 ET: after Sign in at Walmart the page sat still for ~100 s
// while Reason texted that Walmart was checking). Every wait shows a live() block: a sweeping line, a
// status line that changes the longer it takes, and a clock. The words are by elapsed time, in seconds.
/** After the answer went in: what the store is doing with it, as the wait grows. */
export const checkingLines = (n) => [
  [0, `Sent to ${n}, sealed.`],
  [8, `${n} is checking it.`],
  [30, "Still checking. This can take a minute."],
  [75, "Taking longer than usual. Still on it."],
  [180, `${n} hasn't answered yet. I'm still here, and I'll text you either way.`],
];
/** While the answer is on its way (the tap, until the page redraws). */
export const sendingLines = (n) => [[0, `Sending to ${n}, sealed.`], [6, "Still sending. One moment."], [20, "Taking longer than usual. Still on it."]];
/** While Crossmint saves a card. */
export const savingLines = () => [
  [0, "Saving it securely."],
  [8, "Checking the card with your bank."],
  [30, "Still saving. This can take a minute."],
  [75, "Taking longer than usual. Still on it."],
  [180, "No answer yet. It's never saved twice. If this page closes, ask me for a fresh link."],
];

/** The store's own question, when it says more than "sign in". Shown as theirs. */
const storeSays = (rq, store) => rq?.question
  ? `<p class="cx-says">${esc(nameOf(store))} says: <b>${esc(rq.question)}</b></p>` : "";

/**
 * How a payment gets its yes. Since #285 a texted yes never pays for anyone with a passkey (src/passkey.js
 * requiredFor): their yes gets a Face ID link, and the link pays. So with a passkey the page names Face ID;
 * without one a texted yes really does pay, and the page says so.
 */
const approveLine = (passkey) => passkey ? "approve the exact total with Face ID" : "text yes to the exact total";

// ---------------------------------------------------------------- the store's sign-in
/** What signing in lets Reason do, and what it never sees: beside the sign-in. */
function signinMargin(store, passkey) {
  const n = esc(nameOf(store));
  return label("SIGNED IN, I CAN") + para("Fill a cart and check out.") + para(`Only after you ${approveLine(passkey)}.`)
    + label("I NEVER SEE", { pen: true, sp: true }) + para(`Your password, or the codes ${n} sends. They're sealed and go straight to ${n}.`)
    + label("AND", { sp: true }) + para("I don't touch your password or account settings.") + para(`Sign me out of ${n} any time in ${SETTINGS}.`);
}

export function renderSignin({ view, staging = false, passkey = false }) {
  const { store, request: rq, state } = view;
  const n = nameOf(store);
  const fields = rq?.fields ?? [];
  const code = state === "code" || state === "wrongcode";
  // Which line the store refused, and the calm note under it.
  const error = state === "retry" ? "that's not it. try again?" : state === "wrongcode" ? "that's not it. check for a newer text or email?" : "";
  const drawn = fields.map((f) => storeField(f, { store, staging, error: error && f.handling === "protected" ? error : "" })).join("");
  const site = siteOf(store);

  let head, after, margin, acts;
  if (state === "retry") {
    head = headline(`Sign in to ${n}.`, "That password didn't work.", "cx-h") + lede(`${n} didn't take it. You can try again.`);
    acts = actions(go("Sign in", { attrs: ` data-busy="1"` }), site ? out(site, `FORGOT IT? RESET ON ${NAME(store)}`) : "");
    after = "";
    margin = label("WHY RESET THERE") + para(`Your password lives with ${esc(n)}. Reset it on their site, then come back and sign in with the new one.`)
      + label("HEADS UP", { sp: true }) + para(`After a few wrong tries, ${esc(n)} may pause sign-ins for a while.`);
  } else if (state === "wrongcode") {
    head = headline("That code didn't match.", "Try the newest one.", "cx-h") + lede(`Codes from ${n} run out after a few minutes, and only the latest one works.`) + storeSays(rq, store);
    acts = actions(go("Try again", { attrs: ` data-busy="1"` }));
    after = "";
    margin = label("STILL NOTHING?") + para(`Check spam, and that the phone or email on your ${esc(n)} account is current.`) + label("NOTHING BOUGHT YET", { sp: true });
  } else if (code) {
    head = headline(`${n} sent a code.`, "Type it here.", "cx-h") + lede(`It went to the phone or email on your ${n} account.`) + storeSays(rq, store);
    acts = actions(go("Confirm", { attrs: ` data-busy="1"` }));
    after = label("NOTHING BOUGHT YET");
    margin = label("ALMOST DONE") + steps([...(view.answered ? [["Password accepted", "done"]] : []), ["Confirming it's you", "now"], ["Ready to check out", "todo"]])
      + note("no code? check spam, or wait a minute.", { sp: true });
  } else {
    head = headline(`Sign in to ${n}.`, "Just this once.", "cx-h") + lede(`Use the same login you use on ${n}. Then I can check out there with your card.`) + storeSays(rq, store);
    acts = actions(go("Sign in", { attrs: ` data-busy="1"` }), two(`NO ${NAME(store)} ACCOUNT?`, { attrs: ` data-show="noaccount"` }));
    after = note(`${n} might send you a code next. that's normal.`);
    margin = signinMargin(store, passkey);
  }
  const form = `<form class="pf-form" id="cx-form" data-request="${esc(rq?.requestId ?? "")}" novalidate>${drawn}${acts}${after}`
    + `<p class="pf-note" id="cx-err" role="alert" hidden></p>${live({ id: "cx-wait", lines: sendingLines(n), hidden: true })}</form>`;
  const screens = [];
  // The store signed them out of a store they'd connected: say so first, the form one tap away.
  if (view.again) screens.push(signedOut(view));
  screens.push(frame({ main: head + form, margin, step: "signin", off: !!view.again }));
  if (state === "signin") screens.push(noAccount(store, passkey));
  return page(`Reason — sign in to ${n}`, `${header()}<main class="pf" id="cx-main">${screens.join("")}</main>`, { staging });
}

/** StoreSignedOut: a checkout at a store they'd connected was asked to sign in again. */
function signedOut(view) {
  const n = nameOf(view.store);
  const main = headline(`${n} signed me out.`, "Sign in again?", "cx-h0") + lede("Stores do this every so often. Sign in once more and I'll pick up where we left off.")
    + paper({ stamp: "NOTHING BOUGHT YET", label: "WAITING ON THIS", big: view.item || `Your ${n} order`, mono: false })
    + `<div class="cx-note">${actions(go("Sign in again", { type: "button", attrs: ` data-show="signin"` }), two("NOT NOW", { href: BACK }))}</div>`;
  const margin = label("WHY THIS HAPPENS") + para("Stores end sign-ins after a while, or when you change your password.");
  return frame({ main, margin, step: "signedout" });
}

/** StoreNoAccount: make one on the store's own site, or go back. No guest option: guest was already tried. */
function noAccount(store, passkey = false) {
  const n = nameOf(store);
  const site = siteOf(store);
  const row = `<div class="pf-rows"><div class="pf-row"><div class="cx-make"><b>Make one on ${esc(n)}</b>${para("A couple of minutes. Come back here and sign in.", { muted: true })}</div>`
    + (site ? `<div class="cx-make-go">${out(site, `Open ${n}`, { primary: true })}</div>` : "") + `</div></div>`;
  const main = headline(`No ${n} account?`, "Make one first.", "cx-h1") + lede("You can always sign in later.") + row
    + `<div class="cx-note">${actions(two("I DO HAVE ONE", { attrs: ` data-show="signin"` }))}</div>`;
  return frame({ main, margin: note(`nothing's bought until you ${approveLine(passkey)}.`), step: "noaccount", off: true });
}

export function renderChecking({ view, staging = false, passkey = false, setupBack = "" }) {
  const n = nameOf(view.store);
  // A web setup's sign-in (src/websetup.js): nobody is texted; before the store has asked for the login
  // the page is waiting on the store opening, not on an answer.
  const opening = !!setupBack && !view.answered;
  const main = headline(opening ? `Opening ${n}.` : `Signing in to ${n}.`, "Hang tight.", "cx-h")
    + lede(opening ? `Keep this page open. ${n}'s sign-in will ask for your login right here, and the password goes to ${n} sealed, never to me.`
      : `Keep this page open. If ${n} sends you a code, it'll ask for it right here.${setupBack ? "" : " However it goes, I'll text you too."}`)
    + steps(opening ? [[`Opening ${n}`, "now"], ["Your login, sealed", "todo"], ["Signed in", "todo"]] : [[`Sent straight to ${n}, sealed`, "done"], [`${n} is checking it`, "now"], ["Signed in", "todo"]])
    + live({ id: "cx-live", lines: opening ? [[0, `Opening ${n}.`], [8, `${n} is loading.`], [30, "Still opening. This can take a minute."], [75, "Taking longer than usual. Still on it."]] : checkingLines(n) });
  const margin = label("WHILE YOU WAIT") + para(setupBack ? "Nothing is bought without your Face ID." : `Nothing is bought until you ${approveLine(passkey)}.`)
    + label("IF IT TAKES A WHILE", { sp: true }) + para(`Stores sometimes take a minute or two. If ${esc(n)} stops it, this page says so${setupBack ? "." : ", and so do I in the chat."}`);
  return page("Reason — signing in", `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging });
}

export function renderConnected({ view, staging = false, passkey = false, setupBack = "" }) {
  const n = nameOf(view.store);
  if (setupBack) {
    // Signed in from the web setup (src/websetup.js): no thread yet, so the way on is back to the setup,
    // on its own after a moment (the setup reads the new state itself).
    const main = headline(`You're signed in to ${n}.`, "Back to your setup.", "cx-h")
      + lede(`${n} confirmed it. When you want something from ${n}, I can check out there, and nothing is bought without your Face ID.`)
      + paper({ stamp: "CONNECTED", label: NAME(view.store), big: "Signed in.", mono: false })
      + `<div class="cx-note">${actions(go("Back to your setup", { href: setupBack, attrs: ` id="cx-back"` }))}</div>`
      + `<script>(function(){var a=document.getElementById('cx-back');if(a)setTimeout(function(){location.href=a.href},1500)})();</script>`;
    const margin = label("SIGNED IN, I CAN") + para("Check out there, only after your Face ID.")
      + label("AND", { sp: true }) + para(`Sign out of ${esc(n)} any time in ${SETTINGS}.`);
    return page(`Reason — ${n} connected`, `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging });
  }
  const main = headline(`You're signed in to ${n}.`, "Back to the chat.", "cx-h")
    + lede(`Next time you want something from ${n}, just text me. I'll send the exact total before buying.`)
    + paper({ stamp: "CONNECTED", label: NAME(view.store), big: "Signed in.", mono: false })
    + `<div class="cx-note">${actions(go("Back to Reason", { href: BACK }), two("SEE IT IN SETTINGS", { href: "/web/settings#shopping" }))}</div>`;
  const margin = label("SIGNED IN, I CAN") + para(`Check out there, after you ${approveLine(passkey)}.`)
    + label("AND", { sp: true }) + para(`Sign out of ${esc(n)} any time in ${SETTINGS}.`);
  return page(`Reason — ${n} connected`, `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging });
}

/** Run out (any link), or a sign-in the store stopped (StoreCantConnect). */
export function renderEnded({ view, staging = false, setupBack = "" }) {
  const card = view.kind === "card";
  const failed = view.state === "failed";
  const n = shop.storeName(view.store) || "";
  let main, margin;
  const s = n || "The store";
  if (setupBack) {
    // A web setup's link (src/websetup.js): nobody to text for a fresh one; the setup's connect screen
    // starts it again. Never "text me".
    const why = failed
      ? (view.reason === "timeout" ? `${s} was waiting too long and gave up on this sign-in.` : view.reason === "replaced" ? "A newer attempt replaced this one." : `${s} stopped it before it finished.`)
      : card ? "This card link has run out. Nothing was saved." : "This sign-in link has run out. Nothing was signed in.";
    main = headline(failed ? "That didn't go through." : "This link has run out.", "Nothing was lost.", "cx-h")
      + lede(`${why} You can try again from your setup.`)
      + `<div class="cx-note">${actions(go("Back to your setup", { href: setupBack }))}</div>`;
    margin = label("NOTHING BOUGHT") + para("Nothing was charged, and nothing of yours was kept here.")
      + label("NEXT", { sp: true }) + para(`Tap ${card ? "Card" : esc(s)} on your setup for a fresh link.`);
    return page("Reason — link", `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging, status: failed ? 200 : 410 });
  }
  if (failed) {
    // Which end it was (src/shopconnect.js failReason), and the next step, the same as the chat says.
    const why = view.reason === "timeout" ? `${s} was waiting too long and gave up on this sign-in. It happens when a code or a password takes a while to arrive.`
      : view.reason === "lost" ? `I lost track of this sign-in: the checkout service stopped answering about it.`
        : view.reason === "replaced" ? `I started this checkout over, so this link is out of date. The newest link I texted you is the one to use.`
          : `${s} stopped it before it finished. It's usually on their side, and it usually passes.`;
    main = headline(view.reason === "replaced" ? "This link was replaced." : "That sign-in didn't go through.", "Nothing was charged.", "cx-h")
      + lede(`${why} This link is done.${view.reason === "replaced" ? "" : " Text me and I'll send a fresh one, or say so and I'll leave it."}`)
      + `<div class="cx-note">${actions(go("Back to Reason", { href: BACK }), siteOf(view.store) ? out(siteOf(view.store), `CHECK YOUR ${NAME(view.store)} ACCOUNT`) : "")}</div>`;
    margin = label("NOTHING BOUGHT") + para("Nothing was charged, and nothing of yours was kept here.")
      + label("NEXT", { sp: true }) + para(`Ask me in the chat for a new link. If ${esc(s)} keeps stopping it, check your account there first.`);
    return page("Reason — link", `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging });
  }
  main = headline("This link has expired.", "Ask me for a new one.", "cx-h")
    + lede(card ? "Links to add a card last half an hour. Nothing was saved. Text me and I'll send a fresh one, or add it in Settings."
      : view.store ? `Links to sign in last half an hour. Nothing was signed in. Text me and I'll send a fresh ${n} link.` : "Links like this last half an hour. Text me and I'll send a fresh one.");
  margin = label("WHY") + para("A link runs out so an old one can't be used by anyone else.");
  main += `<div class="cx-note">${actions(go("Back to Reason", { href: BACK }))}</div>`;
  return page("Reason — link", `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging, status: 410 });
}

// ---------------------------------------------------------------- the card
const CARD_NEVER = () => label("I NEVER SEE", { pen: true, sp: true }) + para("The card number, the expiry or the security code.");

/** The staging stand-in for the card form: where Crossmint's one iframe draws its fields, live. */
const cardStandIn = () => `<div aria-label="Card form (staging stand-in)" class="pf-sealed">`
  + field({ id: "s-n", label: "NAME ON CARD", attrs: ` value="Ama Owusu" readonly tabindex="-1"` })
  + field({ id: "s-c", label: "CARD NUMBER", mono: true, attrs: ` value="4242 4242 4242 4242" readonly tabindex="-1"` })
  + `<div class="pf-g2">${field({ id: "s-e", label: "EXPIRES", mono: true, attrs: ` value="12 / 29" readonly tabindex="-1"` })}${field({ id: "s-s", label: "SECURITY CODE", mono: true, attrs: ` value="•••" readonly tabindex="-1"` })}</div></div>`;

export function renderCard({ staging = false, card = null, faceId = false, passkey = false, setupBack = "" }) {
  if (card && setupBack) {
    // Saved from the web setup (src/websetup.js): no thread yet, so the way on is back to the setup.
    const main = headline("Card saved.", "Back to your setup.", "cx-h")
      + lede("It's locked to you. When you want something, I'll text you the exact total first, and nothing is charged without your Face ID.")
      + paper({ stamp: "SAVED", label: "ON FILE", big: `${brandOf(card)} •••• ${card.last4 || "····"}` })
      + `<div class="cx-note">${actions(go("Back to your setup", { href: setupBack }))}</div>`;
    const margin = label("I CAN SEE") + para("The brand and the last four digits.") + CARD_NEVER();
    return page("Reason — card saved", `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging });
  }
  if (card) {
    // faceId: purchase approval by passkey is on for them and not set up yet (src/passkey.js).
    // passkey: it is set up, so their payments already go through Face ID.
    const main = headline("Card saved.", faceId ? "Now approve with Face ID." : "Back to the chat.", "cx-h")
      + lede(faceId ? "Set up Face ID and every payment needs it, from a link I text you with the exact total. A yes alone won't pay." : `Next time you want something, I'll text you the exact total first. Nothing is bought until you ${approveLine(passkey)}.`)
      + paper({ stamp: "SAVED", label: "ON FILE", big: `${brandOf(card)} •••• ${card.last4 || "····"}` })
      + `<div class="cx-note">${faceId ? actions(go("Set up Face ID", { href: "/web/connect/passkey" }), two("BACK TO REASON", { href: BACK }))
        : actions(go("Back to Reason", { href: BACK }), two("SEE IT IN SETTINGS", { href: "/web/settings#shopping" }))}</div>`;
    const margin = label("I CAN SEE") + para("The brand and the last four digits.") + CARD_NEVER();
    return page("Reason — card saved", `${header()}<main class="pf" id="cx-main">${frame({ main, margin })}</main>`, { staging });
  }
  // CardAdd, then (moved to by the page's script while Crossmint saves it) CardSaving and CardError.
  const form = `<form class="pf-form" id="cx-card" novalidate><div class="pf-sealed"><div class="pf-sl pf-l pen">${sealed("SEALED · KEPT SECURELY, NOT BY ME")}</div>`
    + `<div class="pf-card-slot" data-card="1">${staging ? cardStandIn() : ""}</div></div>`
    + actions(go("Save card", { attrs: ` data-busy="1"` }), two("NEVER MIND", { href: BACK })) + label("NOTHING CHARGED YET")
    + `<p class="pf-note" id="cx-err" role="alert" hidden></p>${live({ id: "cx-wait", lines: savingLines(), hidden: true })}</form>`;
  const add = frame({
    step: "add",
    main: headline("Add a card.", passkey ? "I only pay with your Face ID." : "I only pay when you say yes.", "cx-h") + lede("It's sealed and kept securely. I only ever see the brand and the last four digits.") + form,
    margin: label("SAVING IT") + para("Spends nothing.") + para(`Lets me pay at a store's checkout, only after you ${approveLine(passkey)}.`)
      + CARD_NEVER() + label("AND", { sp: true }) + para(`Remove it any time in ${SETTINGS}.`),
  });
  const saving = frame({
    step: "saving", off: true,
    main: headline("Saving your card.", "A few seconds.") + lede("It's going in sealed. Keep this page open until it's done.")
      + steps([["Card typed in, sealed", "done"], ["Saving it securely", "now"], ["Ready to use", "todo"]], { id: "cx-steps", live: true })
      + live({ id: "cx-save-live", lines: savingLines() }),
    margin: label("SO FAR") + para("Spends nothing.") + para("When it's done, all I'll see is the brand and the last four digits."),
  });
  // "Nothing was saved" only when the save itself failed; a lost answer may have saved it (trying again
  // returns the same card, never a second one), so then it says only what is certain.
  const error = frame({
    step: "error", off: true,
    main: `<h1 class="h1">Lost the line for a sec.<br><em id="cx-err-t" data-failed="Nothing was saved or charged." data-other="Nothing was charged.">Nothing was saved or charged.</em></h1>`
      + lede("Something went wrong while saving it. Give it another go.")
      + `<div class="cx-note">${actions(go("Try again", { type: "button", attrs: ` data-show="add"` }), two("DO IT LATER", { href: BACK }))}</div>`,
    margin: label("IF IT KEEPS HAPPENING") + para("Text me and I'll look into it.") + note("usually it's just a hiccup.", { sp: true }),
  });
  return page("Reason — add a card", `${header()}<main class="pf" id="cx-main">${add}${saving}${error}</main>`, { staging });
}

/** The right screen for a link's view. */
export function renderView(view, opts = {}) {
  if (["signin", "code", "wrongcode", "retry"].includes(view.state)) return renderSignin({ view, ...opts });
  if (view.state === "checking") return renderChecking({ view, ...opts });
  if (view.state === "connected") return view.kind === "card" ? renderCard({ ...opts, card: opts.card ?? { brand: "", last4: "" } }) : renderConnected({ view, ...opts });
  if (view.state === "card") return renderCard(opts);
  return renderEnded({ view, ...opts });
}

// ---------------------------------------------------------------- the page and its script
// The script: mount Crossmint's fields (island.js), collect the references, post the answer, then
// watch /state and redraw when the record moves on. It never reads a secret: there is none to read.
//
// look(): Crossmint's appearance, as near the paper line as its schema goes. Its sealed sign-in fields
// take colours, font and radius only (no rules), so their own box border is drawn in the ground colour
// (invisible) and our slot draws the line; focus inside the iframe is focus on the iframe here, so the
// slot's :focus-within turns it red. The card form also takes rules: no box (border = ground), the line
// as an inset bottom shadow, red on hover and focus; its errors use `danger` (pen).
const JS = (boot) => `(function(){var B=${JSON.stringify(boot).replace(/</g, "\\u003c")};if(!B.token)return;
var base='/web/connect/'+B.token,form=document.getElementById('cx-form')||document.getElementById('cx-card'),err=document.getElementById('cx-err');
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
var MONO='"Courier New",Courier,monospace',SANS='Inter,system-ui,-apple-system,sans-serif';
function look(f){var g=css('--ground'),code=f&&(f.input&&(f.input.autoComplete==='one-time-code'||f.input.inputMode==='numeric'||f.input.kind==='number'||f.input.kind==='integer'));
return{variables:{fontFamily:code?MONO:SANS,fontSizeUnit:code?'8px':'5px',borderRadius:'0px',colors:{backgroundPrimary:g,textPrimary:css('--ink'),textSecondary:css('--muted'),borderPrimary:g,accent:css('--pen'),danger:css('--pen'),warning:css('--pen')}}}}
function cardLook(){var g=css('--ground'),i=css('--ink'),m=css('--muted'),p=css('--pen');
return{variables:{fontFamily:MONO,fontSizeUnit:'5px',borderRadius:'0px',colors:{backgroundPrimary:g,textPrimary:i,textSecondary:m,borderPrimary:css('--hair'),accent:p,danger:p,warning:p}},
rules:{Label:{font:{family:MONO,size:'11px',weight:'400'},colors:{text:m}},
Input:{borderRadius:'0px',font:{family:MONO,size:'22px',weight:'400'},colors:{text:i,background:g,border:g,boxShadow:'inset 0 -1.5px 0 '+i,placeholder:m},hover:{colors:{text:i,background:g,border:g,boxShadow:'inset 0 -1.5px 0 '+p}},focus:{colors:{background:g,border:g,boxShadow:'inset 0 -2px 0 '+p}}}}}}
function oops(t){if(!err)return;err.textContent=t;err.hidden=false}
var wt=document.getElementById('cx-wait'),wl=null,sv=null;
function busy(on){var b=form&&form.querySelector('button.act');if(b){b.setAttribute('aria-busy',on?'true':'false');b.disabled=on}
if(wt&&window.pfLive){if(on&&!wl)wl=pfLive(wt,{});else if(!on&&wl){wl.hide();wl=null}}}
var fields={},card=null;
function mount(){if(!window.ReasonCrossmint||!form)return;
form.querySelectorAll('[data-protected]').forEach(function(el){var f=(B.fields||[]).filter(function(x){return x.key===el.getAttribute('data-protected')})[0];if(f)fields[f.key]=ReasonCrossmint.protectedField(el,{apiKey:B.apiKey,jwt:B.jwt,field:f,appearance:look(f)})});
var c=form.querySelector('[data-card]');if(c)card=ReasonCrossmint.cardForm(c,{apiKey:B.apiKey,jwt:B.jwt,appearance:cardLook()})}
function post(path,body){return fetch(base+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{ok:false}})})}
function stepTo(n){var li=document.querySelectorAll('#cx-steps li');for(var i=0;i<li.length;i++){var s=i<n?'done':i===n?'now':'todo';li[i].className=s;li[i].querySelector('.m').textContent=s==='done'?'\\u2713':'\\u25cb';var sr=li[i].querySelector('.sr');if(sr)sr.textContent=' ('+(s==='done'?'done':s==='now'?'now':'not yet')+')'}}
function cardFailed(sure){busy(false);var t=document.getElementById('cx-err-t');if(t)t.textContent=t.getAttribute(sure?'data-failed':'data-other');pfShow('error')}
if(form)form.addEventListener('submit',function(e){e.preventDefault();if(err)err.hidden=true;busy(true);
if(card){card.submit().then(function(r){
if(r.status==='invalid'){busy(false);pfShow('add');return oops('something in there needs a look. it\\u2019s marked in red.')}
if(r.status==='superseded'){busy(false);return pfShow('add')}
if(r.status!=='saved')return cardFailed(r.status==='failed');
pfShow('saving');stepTo(2);var sl=document.getElementById('cx-save-live');if(sl&&window.pfLive){if(sv)sv.stop();sv=pfLive(sl,{waited:wl?wl.waited():0})}return post('/card',r.card).then(function(o){if(o.ok){stepTo(3);location.reload()}else cardFailed(false)})}).catch(function(){cardFailed(false)});return}
var answers={},keys=Object.keys(fields);
form.querySelectorAll('input[name]').forEach(function(i){if(i.value!=='')answers[i.name]=i.value});
Promise.all(keys.map(function(k){return fields[k].collect()})).then(function(rs){for(var i=0;i<rs.length;i++){if(rs[i].status!=='collected'){fields[keys[i]].setInvalid(true);busy(false);return oops('that one needs another look.')}answers[keys[i]]=rs[i].input}
return post('/answer',{requestId:form.getAttribute('data-request'),answers:answers}).then(function(o){if(o.ok||o.state)location.reload();else{busy(false);oops('that didn\\u2019t go through. try once more?')}})}).catch(function(){busy(false);oops('that didn\\u2019t go through. try once more?')})});
var lv=document.getElementById('cx-live'),liv=lv&&window.pfLive?pfLive(lv,{waited:B.waited||0}):null;
function poll(){fetch(base+'/state',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}).then(function(r){return r.json()}).then(function(o){if(!o||!o.state)return;if(o.state!==B.state)return location.reload();if(liv&&typeof o.waited==='number')liv.sync(o.waited)}).catch(function(){})}
if(B.watch){setInterval(poll,2500);if(window.pfWake)pfWake(poll)}
if(form&&B.apiKey){var s=document.createElement('script');s.src='/web/connect/island.js';s.onload=mount;document.head.appendChild(s)}})();`;

function page(title, body, { staging = false, status = 200 } = {}) {
  const html = webPage({ title, body: body + (staging ? `<p class="stg">STAGING · SAMPLE</p>` : ""), css: CSS, script: `${STEP_JS}${CODE_JS}${LIVE_JS}` });
  return { status, html };
}

// ---------------------------------------------------------------- routes
// Web's own headers, with room for Crossmint and nothing else: its iframe (the sealed fields and the
// card form), its SDK's calls, and our own island script. Still no framing of this page by anybody.
const CROSSMINT = "https://www.crossmint.com https://*.crossmint.com";
export const CONNECT_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${CROSSMINT}; frame-src ${CROSSMINT}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
};
const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...CONNECT_HEADERS, ...extra });
const json = (status, obj) => { const body = JSON.stringify(obj); return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, "Content-Length": Buffer.byteLength(body) }, body }; };
const send = ({ status, html }) => ({ status, headers: HTML({ "Content-Length": Buffer.byteLength(html) }), body: html });
let ISLAND = null;
const island = () => (ISLAND ??= readFileSync(new URL("../../assets/connect/crossmint-island.js", import.meta.url)));

/**
 * Everything under /web/connect. `sub` is the path after it. `account` is the signed-in Web account
 * or null (a texted link works on its own: the token is the key, it lasts 30 minutes, one run).
 */
export async function connectRequest({ sub = "", method = "GET", account = null, readBody, log = () => {} }) {
  if (sub === "island.js") {
    const body = island();
    return { status: 200, headers: { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": body.length, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }, body };
  }
  if (sub === "jwks.json") {
    let keys;
    try { keys = shop.jwks(); } catch { return json(404, { error: "not configured" }); }
    const out = json(200, keys);
    return { ...out, headers: { ...out.headers, "Cache-Control": "public, max-age=300" } };
  }
  if (sub === "new-card") {
    if (!account || !shop.connectAllowedFor(account.conversation_id)) return null;
    const token = shop.cardLink(account.conversation_id);
    return { status: 303, headers: HTML({ Location: `/web/connect/${token}`, "Content-Length": 0 }), body: "" };
  }
  const [token, verb = ""] = String(sub).split("/");
  const link = shop.linkFor(token);
  // Every page a texted link opens carries the "Secured by Reason" card (src/pages/securedcard.js):
  // the phone's preview fetcher reads this page with no cookie. The kind of link, never the store.
  const secured = (drawn, kind) => ({ ...drawn, html: withSecuredCard(drawn.html, kind) });
  if (!link || !shop.connectAllowedFor(link.conversation_id)) return send(secured(renderEnded({ view: { state: "expired" } }), "connect"));
  const view = shop.linkView(link);
  // The open page's poll: the state, and while the store is checking, how long for (so a page frozen in
  // the background says the right thing the moment it is back) and how far the checkout has got.
  if (verb === "state") return json(200, { state: view.state, ...(view.state === "checking" ? { waited: view.waited, stage: view.stage } : {}) });
  if (verb === "answer" || verb === "card") {
    if (method !== "POST") return json(405, { ok: false });
    let body = {};
    try { body = JSON.parse((await readBody()) || "{}"); } catch { return json(400, { ok: false, error: "bad_json" }); }
    // Only which link and which field keys: never a value (src/shopconnect.js says why).
    const out = verb === "answer" ? await shop.answerLink(token, body) : await shop.saveCard(token, body);
    log({ shop_connect: verb, ok: !!out.ok, ...(out.error ? { error: out.error } : {}), ...(verb === "answer" && body?.answers && typeof body.answers === "object" ? { keys: Object.keys(body.answers) } : {}) });
    return json(out.ok ? 200 : 400, out);
  }
  if (verb) return null;
  // A web setup's link (src/websetup.js): its card form, or its store sign-in (shop.setupStoreLink). No
  // thread behind it, so every way on is back to the setup's connect screen.
  const setupMod = String(link.conversation_id).startsWith("websetup:") ? await import("../websetup.js") : null;
  const setupBack = setupMod ? setupMod.backUrlFor(link.conversation_id, link.kind === "card" ? "card" : "amazon") : "";
  // A setup's form: its Crossmint JWT ends by the setup's 15-minute mark (src/websetup.js setupJwtSec).
  const setupTtl = setupMod ? setupMod.setupJwtSec(link.conversation_id) : null;
  const card = view.kind === "card" && view.state === "connected" ? shop.cardOf(link.conversation_id) : null;
  const interactive = ["signin", "code", "wrongcode", "retry", "card"].includes(view.state);
  if (setupMod && interactive && setupTtl < 60) return send(secured(renderEnded({ view: { state: "expired", kind: link.kind, store: link.store }, setupBack }), link.kind === "card" ? "card" : "store"));
  const boot = interactive || view.state === "checking"
    ? {
      token, state: view.state, watch: view.state !== "card", ...(view.state === "checking" ? { waited: view.waited } : {}),
      // A web setup's card page gets a short JWT: its Crossmint user can become an account's on the claim.
      ...(interactive ? { apiKey: process.env.CROSSMINT_CLIENT_KEY || "", jwt: shop.mintJwt(link.conversation_id, setupMod ? { ttlSec: setupTtl } : {}), fields: (view.request?.fields ?? []).filter((f) => f.handling === "protected") } : {}),
    } : null;
  // A web setup's card (src/websetup.js): Face ID is set up later on Web, signed in; the page goes back to the setup.
  const faceId = !setupBack && !!card && passkey.passkeyAllowedFor(link.conversation_id) && !passkey.hasPasskey(link.conversation_id);
  // Has a passkey, so every payment is approved with Face ID: the copy says so instead of "text yes".
  const drawn = secured(renderView(view, { card, faceId, setupBack, passkey: passkey.requiredFor(link.conversation_id) }), link.kind === "card" ? "card" : "store");
  return send(boot ? { ...drawn, html: withBoot(drawn.html, boot) } : drawn);
}
/** The screen is drawn once; a live page's boot data and script ride in their own tag at the end. */
export const withBoot = (html, boot) => html.replace("</body></html>", `<script>${JS(boot)}</script></body></html>`);
