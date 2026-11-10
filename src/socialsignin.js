// Signing in to a site through a social provider — Google, Apple, Facebook, Microsoft — behind
// REASON_SOCIAL_SIGNIN (off by default; "owner": the operator's conversation only; "on": everyone).
//
// The spec this is written from is Omari's "Reason Social Sign-In Prompt" (2026-11-10). One provider
// login can open dozens of a person's accounts, so securing it is high-leverage — and the whole design
// is that it is EARNED through a real task, never a cold ask, and that Reason never holds the
// credential. Nothing here changes how a sign-in happens: the person still signs in themselves on
// the site's own page through a sign-in link (src/signin-remote.js) or the window on the Mac
// (src/signin-window.js), and what Reason keeps is the session the site hands the saved profile, as
// before. What is new:
//
//   - **the rules** the model is given (`RULES`): when to ask, how, the two-step order, what to do
//     when a code fails, what the access is for and what it is not;
//   - **which button** each site's account uses, written on the existing saved-login row
//     (connected_accounts.provider, src/db.js recordSiteSignin) only once the site says signed in,
//     sealed at rest with the other phase-2 columns (src/restcrypt.js SENSITIVE2);
//   - **a no is remembered** per provider for 30 days (social_declines), and the model is told not to
//     ask again until then;
//   - **the provider button is pressed for them** when a link or a re-check opens a site whose saved
//     login says "google": the person lands on Google's own page rather than a username box they would
//     have to skip past. A lapsed session on such a site is tried again the same way before anybody is
//     asked for anything (`signInAgain`, the one piece that works without the person);
//   - **a code is normalised** before it is typed: "G-123 456" → "123456"
//     (`normalizeCode`, used by the sign-in page's typed text when a code box is focused).
//
// Never a password, a code or a card number in the chat: that rule predates this file (src/signin.js
// refuseAPassword) and this file only repeats it in the provider's words.
import { clock, config } from "./config.js";
import * as db from "./db.js";
import * as accounts from "./accounts.js";
import { guardedFetch } from "./netguard.js";

// ---------------------------------------------------------------- the flag
const OFF = ["", "0", "off", "false", "no"];
/** off (the default) | owner | on. Read at call time so a test can set it; a restart is the only switch on live. */
export function socialMode() {
  const v = String(process.env.REASON_SOCIAL_SIGNIN ?? "off").trim().toLowerCase();
  if (OFF.includes(v)) return "off";
  if (v === "owner") return "owner";
  return ["1", "on", "true", "yes"].includes(v) ? "on" : "off";
}
export function socialAllowedFor(conversationId) {
  const m = socialMode();
  if (m === "off") return false;
  if (m === "owner") return !!conversationId && (conversationId === config.ownerConversation || accounts.ownerOf(conversationId).isOperator);
  return true;
}

// ---------------------------------------------------------------- providers
export const PROVIDERS = ["google", "apple", "facebook", "microsoft"];
export const LABELS = { google: "Google", apple: "Apple", facebook: "Facebook", microsoft: "Microsoft" };
export function isProvider(p) { return PROVIDERS.includes(String(p ?? "").trim().toLowerCase()); }
export function providerKey(p) { const k = String(p ?? "").trim().toLowerCase(); return isProvider(k) ? k : ""; }

/** "your Google login" — the words the rules use; never "OAuth", never "social provider", to the person. */
export const loginWords = (p) => `your ${LABELS[providerKey(p)] ?? "Google"} login`;

/** The one-line expectation for the two-step check, by provider, least effort first. */
export function expectLine(p) {
  const name = LABELS[providerKey(p)] ?? "The site";
  if (name === "Google") return "Google will ping your phone. Tap Yes.";
  if (name === "Apple") return "Apple will show a code on your iPhone or Mac. Send it to me.";
  if (name === "Microsoft") return "Microsoft will ping the Authenticator app. Tap Approve.";
  return `${name} will ask you to confirm it's you on your phone. Tap Yes.`;
}

// ---------------------------------------------------------------- codes
/**
 * A verification code the way the field will take it. "G-123456", "123 456", "123-456" all become
 * "123456". `accepts: "digits"` (the default: a numeric code box) keeps the digits only; `"any"` keeps
 * letters too (Microsoft and some site codes are alphanumeric), still with the "G-" prefix, spaces and
 * dashes gone. `max` is the field's maxlength when the site states one.
 */
export function normalizeCode(raw, { accepts = "digits", max = 0 } = {}) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^\s*g\s*-\s*/i, "");          // Google texts "G-123456"
  s = s.replace(/[\s –—-]+/g, ""); // spaces, dashes of every kind
  if (accepts === "digits") s = s.replace(/\D/g, "");
  else s = s.replace(/[^0-9a-z]/gi, "");
  if (max > 0) s = s.slice(0, max);
  return s;
}
/** Does this text look like it is a code being pasted into a code box, rather than ordinary typing? */
export function looksLikeCode(text) {
  const t = String(text ?? "").trim();
  return /^(g\s*-\s*)?[0-9][0-9\s-]{2,}[0-9]$/i.test(t) || /^[0-9]{4,8}$/.test(t);
}

// ---------------------------------------------------------------- reading a sign-in page
/**
 * Which providers a sign-in page offers, read off its text: "Continue with Google", "Sign in with
 * Apple", a bare "Google" button. Pure, so it runs on a page's innerText, on an email's body ("You
 * signed up with Google") or on anything else somebody can show it. Order is the page's order.
 */
export function providersOffered(text) {
  const t = String(text ?? "").toLowerCase();
  const out = [];
  for (const p of PROVIDERS) {
    const re = new RegExp(`(continue|sign(?:ing|ed)?\\s*(?:in|up)|log(?:ging|ged)?\\s*in|register(?:ed|ing)?)\\s+(with|via|using|through)\\s+(your\\s+)?${p}(\\s+account)?\\b|\\b${p}\\s+(sign[- ]?in|account|login)\\b`);
    const m = re.exec(t);
    if (m) out.push({ provider: p, at: m.index });
  }
  return out.sort((a, b) => a.at - b.at).map(o => o.provider);
}

/**
 * Runs inside the page: find the site's own "Continue with <provider>" control and press it. Returns
 * what it pressed (the control's text) or "" when there is none. Only visible buttons, links and
 * role=button elements whose own text or aria-label names the provider; never a form field. Browser
 * globals only — Playwright serialises the function's source across and calls it with the provider.
 * (A real function, not a string: Playwright evaluates a string as an expression and never calls
 * it, which the hand-made Uber page in test/social-signin-uber.test.js was the first to show.)
 */
export function findProviderButton(provider) {
  var want = String(provider || "").toLowerCase();
  if (!want) return "";
  var els = document.querySelectorAll('button,a[href],[role="button"],input[type="button"],input[type="submit"]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var txt = ((el.innerText || el.value || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("data-provider") || "")).replace(/\s+/g, " ").trim().toLowerCase();
    if (!txt || txt.indexOf(want) < 0) continue;
    if (txt.length > 80) continue;
    if (!/(continue|sign|log|use|with|account|via)/.test(txt) && txt !== want) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) continue;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    el.click();
    return txt.slice(0, 80);
  }
  return "";
}
/** The finder's source, for anything that wants to read it; `String(fn)` is what Playwright sends. */
export const PROVIDER_BUTTON_JS = String(findProviderButton);

/** The text of a candidate control, the way PROVIDER_BUTTON_JS judges it. Pure, for tests and for hand checks. */
export function providerButtonMatches(label, provider) {
  const want = providerKey(provider);
  const txt = String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!want || !txt || !txt.includes(want) || txt.length > 80) return false;
  return /(continue|sign|log|use|with|account|via)/.test(txt) || txt === want;
}

/**
 * Which providers a rendered sign-in page offers, from its controls' own labels (text, aria-label,
 * title) — the same match that presses one, so a bare "Google" button counts (Notion) and a word in
 * a paragraph does not. `read` is either those labels (an array) or a page's text.
 */
export function providersOnPage(read) {
  if (!Array.isArray(read)) return providersOffered(String(read ?? ""));
  return PROVIDERS.filter(p => read.some(l => providerButtonMatches(l, p)));
}

/**
 * Press the site's provider button on a page already on its sign-in page. `{ pressed }` is the
 * control's text, "" when the page had none (then the person's own form is where they are, as before).
 * A page that will not run the script (closed, navigating) is "" too: nothing was pressed.
 */
export async function clickProviderButton(page, provider, { settleMs = 1500 } = {}) {
  const key = providerKey(provider);
  if (!key || !page?.evaluate) return { pressed: "" };
  let pressed = "";
  try { pressed = String(await page.evaluate(findProviderButton, key) ?? ""); } catch { pressed = ""; }
  if (pressed && settleMs > 0 && page.waitForTimeout) await page.waitForTimeout(settleMs).catch(() => {});
  return { pressed };
}

// ---------------------------------------------------------------- the provider's own page
/**
 * What the provider's page is asking for, read off the text the link's browser is showing. After
 * the site's button is pressed the person is on Google's (Apple's, …) page, and the spec's order of
 * two-step methods — a tap on the phone, then a code — is what this names, so the link's view and
 * the model can say the one line that fits ("Google will ping your phone. Tap Yes."). Pure, and it
 * only ever reads the page's words; nothing on that page is pressed or typed by this file.
 *   kind: "account" (pick / type the account) | "password" | "phone_tap" | "code" | "" (not a prompt
 *   this file knows).
 */
export function providerPrompt(raw = {}) {
  const url = String(raw?.url ?? "").toLowerCase();
  const text = String(raw?.text ?? "").replace(/\s+/g, " ").trim();
  const t = text.toLowerCase();
  const google = /accounts\.google\.com|google\.com\/signin|google\.com\/o\/oauth/.test(url) || /\bgoogle\b/.test(t.slice(0, 200));
  const apple = /appleid\.apple\.com/.test(url) || /\bapple id\b|\bsign in with apple\b/.test(t.slice(0, 300));
  const microsoft = /login\.(microsoftonline|live)\.com|login\.microsoft\.com/.test(url) || /\bmicrosoft\b/.test(t.slice(0, 200));
  const facebook = /facebook\.com/.test(url);
  const provider = google ? "google" : apple ? "apple" : microsoft ? "microsoft" : facebook ? "facebook" : "";
  if (!provider) return { provider: "", kind: "", say: "" };
  const name = LABELS[provider];
  if (/check your (phone|device)|tap yes|tap the number|open the gmail app|google sent a notification|approve (this )?sign[- ]?in|approve the request|authenticator app/.test(t)) {
    return { provider, kind: "phone_tap", say: provider === "google" ? "Google is pinging your phone. Tap Yes there." : provider === "microsoft" ? "Microsoft is pinging your Authenticator app. Tap Approve there." : `${name} wants a Yes on your phone.` };
  }
  if (/enter (the )?(\d+[- ]digit )?(verification )?code|g-\d|code (was )?sent to|text message with|2-step verification|two-factor|verification code/.test(t)) {
    return { provider, kind: "code", say: `${name} wants the code it sent. Send it to me as it came — I'll clean it up.` };
  }
  if (/enter your password|password/.test(t) && /sign in|welcome|hi,? /.test(t)) {
    return { provider, kind: "password", say: `${name} wants your password — type it here on ${name}'s own page, never to me.` };
  }
  if (/choose an account|use another account|sign in with your google account|email or phone|sign in to continue|use your .* account/.test(t)) {
    return { provider, kind: "account", say: `${name} is asking which account. Pick yours.` };
  }
  return { provider, kind: "", say: "" };
}

// ---------------------------------------------------------------- the one step a page is on
/**
 * Which screen the sign-in is on right now, read off the page, so Reason's own branded page can show
 * the right native control and a plain live line instead of a streamed picture (owner, 2026-11-10:
 * "your own page with native controls while you drive the real pages behind, and say plainly what's
 * happening"). The fast, deterministic screens for the providers that matter are named here; a screen
 * this cannot place comes back `unknown` and the page falls back to the streamed view for that step.
 *
 * Pure. Reads the page's url + text (`raw`), the form shape the reader already found (`fields`, as
 * src/signin-remote.js fieldKind names them), and which provider this account signs in through.
 * Order is by how sure the words are: a refusal and a captcha are read before anything that could be
 * mistaken for a form.
 *
 *   { step, provider, number, say }
 *     step: refused | captcha | consent | number_match | phone_tap | code | account | password
 *           | email | chooser | signed_in | unknown
 *     number: the match number to tap, when step is number_match (a short string, else "")
 *     say: the live line for the person, plain words, honest about what is happening behind
 */
const CAPTCHA = /i'?m not a robot|are you a human|verify you(?:'re| are) (?:a )?human|select all (?:images|squares)|press (?:and hold|& hold)|slide to|unusual traffic|recaptcha|hcaptcha|cloudflare|verify it'?s you|help us keep your account safe|confirm it'?s really you|prove you'?re not a robot/;
const SIGNED = /you(?:'re| are) signed in|signed in successfully|you can close this|signed in to/;
export function stepOf(raw = {}, { provider = "", fields = [] } = {}) {
  const t = String(raw?.text ?? "").replace(/\s+/g, " ").trim();
  const low = t.toLowerCase();
  const kinds = (Array.isArray(fields) ? fields : []).map(f => String(f?.k ?? f?.kind ?? "").toLowerCase());
  const has = (k) => kinds.includes(k);
  const no = providerRefused(raw);
  if (no.refused) return { step: "refused", provider: no.provider, number: "", say: `${LABELS[no.provider]} refused my browser.` };
  // A bot wall / "verify it's you" / a slider: nothing native can answer it, the person finishes it
  // on the streamed page. Read before the form screens, since a captcha page often has a stray box.
  if (CAPTCHA.test(low)) return { step: "captcha", provider, number: "", say: providerKey(provider) ? `${LABELS[providerKey(provider)]} wants to check you're human.` : "The page wants to check you're human." };
  // Which provider's OWN page this is, by its host — the only place a provider's wording ("enter your
  // password", "check your phone") is believed. A site's own page that merely names Google in a button
  // is not Google's page (seen live on Notion's login, 2026-11-10: read as Google's password step).
  const host = String(raw?.url ?? "").toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  const onProvider = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|idmsa\.apple\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|facebook\.com)$/.test(host);
  const prompt0 = providerPrompt({ ...raw, text: t });
  const prompt = onProvider ? prompt0 : { provider: "", kind: "", say: "" };
  const prov = providerKey(provider) || prompt.provider || "";
  const name = LABELS[prov] || "The site";
  // The grant screen: "<app> wants access to…", "Continue to <app>?", "<app> will be able to…". Only
  // the person's own tap grants it (the rule: never auto-grant a new third-party access).
  // A consent screen is buttons only: a page with somewhere to type is a sign-in step, whatever it
  // says ("Sign in to continue to Notion" is Google's email page, not a grant).
  const typing = ["email", "username", "tel", "password", "otp"].some(has);
  if (!typing && /(wants? (to )?access|will be able to|is requesting access|allow .{1,40} to access|grant .{1,30} permission|will share your|share your .{1,30} with)/.test(low)
      && /(allow|continue|authori[sz]e|accept|grant)/.test(low)) {
    return { step: "consent", provider: prov, number: "", say: `${name} is asking if you allow access. Read it and tap to allow — I won't grant it for you.` };
  }
  // Google's / Microsoft's number match: a 1–3 digit number to tap on the phone. The number is shown
  // on its own, big; "2-Step" and "6-digit code" are NOT it, so only standalone digit groups count
  // and the last one wins (the prompt's number sits below its instructions).
  if (onProvider && /(tap|choose|select|enter|press) (?:the )?number|number (?:shown|match|you see)|match the number/.test(low)) {
    const nums = [...t.matchAll(/(?:^|[\s.:>])(\d{1,3})(?=$|[\s.<])/g)].map(m => m[1]);
    const number = nums.at(-1) ?? "";
    return { step: "number_match", provider: prov, number, say: `${name} sent a prompt to your phone. Tap the number ${number || "shown"} there.` };
  }
  if (prompt.kind === "phone_tap") return { step: "phone_tap", provider: prov, number: "", say: prompt.say };
  // The site's OWN sign-in page offering Continue-with buttons (Notion: buttons above an email box) is
  // the chooser, even with an email box on it: the person picks the provider or their own email.
  // Only off the providers' hosts — on Google's own page the box is Google's email step.
  const offered0 = onProvider ? [] : [...new Set([...providersOffered(t), ...(Array.isArray(raw?.buttons) ? providersOnPage(raw.buttons) : [])])];
  // A password box alone does not stop it when an email box sits beside it (Notion keeps one on its
  // first page for password managers); a password box with no email box is the password step.
  if (offered0.length && !has("otp") && (!has("password") || has("email") || has("username") || has("tel"))) return { step: "chooser", provider: providerKey(provider), number: "", offered: offered0, say: "Pick how you sign in." };
  if (prompt.kind === "code" || has("otp")) return { step: "code", provider: prov, number: "", say: `${name} sent a code. Send it to me as it came — I'll clean it up.` };
  if (prompt.kind === "password" || has("password")) return { step: "password", provider: prov, number: "", say: `${name} wants your password. Type it here on ${name}'s own page — it never reaches me.` };
  // An input box for the email/number comes before the account-picker words: "Email or phone" on
  // Google's identifier page reads as a picker to the word test, but it is the email step.
  if (has("email") || has("username") || has("tel")) return { step: "email", provider: prov, number: "", say: `${name} wants your ${has("tel") ? "number or email" : "email"}.` };
  if (prompt.kind === "account" || /choose an account|use another account|pick an account|which account/.test(low)) {
    return { step: "account", provider: prov, number: "", say: `${name} is asking which account. Pick yours.` };
  }
  // No field, no prompt, but the page offers providers: the chooser.
  const offered = providersOffered(t);
  if (offered.length) return { step: "chooser", provider: prov, number: "", offered, say: `Pick how you sign in.` };
  if (SIGNED.test(low)) return { step: "signed_in", provider: prov, number: "", say: `Signed in.` };
  return { step: "unknown", provider: prov, number: "", say: prov ? `Working on the ${LABELS[prov]} page…` : "Working on the page…" };
}

// ---------------------------------------------------------------- the provider says no
/**
 * Google, Apple and Microsoft refuse some automated browsers on their own sign-in page: Google's
 * "Couldn't sign you in — This browser or app may not be secure", Apple's and Microsoft's "this
 * browser is not supported". That screen is the provider's decision about Reason's browser, not a
 * wrong password: nothing is saved, nothing is pressed again, and the person is told in one line,
 * with the site's own email/password sign-in offered instead. Nothing here hides the automation or
 * changes how the browser looks (the repo's rule): the refusal is read and believed.
 * Pure: reads the page's url and words only.   { provider, refused, why } | { refused: false }
 */
const REFUSAL = {
  google: /this browser or app may not be secure|try using a different browser/,
  apple: /(this|your) browser (is not|isn[’']t) supported|browser not supported|use a supported browser/,
  microsoft: /(this|your) browser (is not|isn[’']t) supported|browser not supported/,
};
export function providerRefused(raw = {}) {
  const url = String(raw?.url ?? "").toLowerCase();
  const t = String(raw?.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return { refused: false };
  // Google's words are its own; Apple's and Microsoft's ("browser not supported") are only theirs on their own host.
  const onGoogle = /accounts\.google\.com|google\.com\/(signin|o\/oauth|v3\/signin)/.test(url);
  const onApple = /appleid\.apple\.com|idmsa\.apple\.com/.test(url);
  const onMicrosoft = /login\.(microsoftonline|live|microsoft)\.com/.test(url);
  let provider = "";
  if ((onGoogle || /this browser or app may not be secure/.test(t)) && REFUSAL.google.test(t)) provider = "google";
  else if (onApple && REFUSAL.apple.test(t)) provider = "apple";
  else if (onMicrosoft && REFUSAL.microsoft.test(t)) provider = "microsoft";
  if (!provider) return { refused: false };
  return { provider, refused: true, why: `${LABELS[provider]} refused Reason's browser on its own sign-in page ("${provider === "google" ? "This browser or app may not be secure" : "this browser is not supported"}")` };
}

/** The one line for the person, and what to offer instead. */
export function refusalAnswer(entry, provider) {
  const name = LABELS[providerKey(provider)] ?? "The provider";
  const ownForm = !!entry?.signin_url && !entry?.signin_blocked;
  return {
    say: `${name} refused my browser for ${entry?.label ?? "that site"}, so I couldn't sign you in through ${name} there.${ownForm ? ` I can send you a secure link to sign in with your ${entry.label} email and password instead.` : ""}`,
    instead: ownForm
      ? `Offer ${entry.label}'s own email/password sign-in: signin_link with site "${entry.site}" and NO provider. Do not try ${name} for ${entry.label} again.`
      : `${entry?.label ?? "That site"} has no sign-in of its own Reason can open; do not try ${name} for it again, and finish the task another way if there is one.`,
  };
}

// ---------------------------------------------------------------- the choice on the link's page
/**
 * The provider buttons a sign-in link's page offers (owner, 2026-11-10: "when a site offers Sign in
 * with Google, Reason's own page should offer the same choices"). In order: the provider their saved
 * login already went through, the one Reason was told, then what the site's own sign-in page names
 * (signinWall's providers_offered). Never one refused for this site in the last 7 days, and nothing
 * at all where the flag does not reach this person.
 */
export function offeredFor(conversationId, entry, { asked = "", live = [] } = {}) {
  if (!socialAllowedFor(conversationId) || !entry?.site) return [];
  const out = [];
  for (const p of [providerOf(conversationId, entry.site), asked, ...(live ?? [])]) {
    const k = providerKey(p);
    if (k && !out.includes(k) && !refusedRecently(conversationId, entry.site, k)) out.push(k);
  }
  return out;
}

/** "Google", "Google or Apple", "Google, Apple or Facebook". */
export function namesOf(list) {
  const n = (list ?? []).map(p => LABELS[providerKey(p)]).filter(Boolean);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} or ${n.at(-1)}`;
}

/**
 * The one line that goes with the link, naming the choice in plain words. `recorded`: their saved
 * login for this site already goes through that provider, so it is said as theirs, not as an option.
 */
export function choiceLine(entry, offered, recorded = "") {
  const n = entry?.label ?? "the site";
  const rec = providerKey(recorded);
  if (rec) return `${n} signs in through your ${LABELS[rec]} account. Tap Continue with ${LABELS[rec]} on the page and ${expectLine(rec).replace(/^\w+ will/, (m) => m.toLowerCase().replace(/^\w+/, "it"))}`;
  if (!offered?.length) return "";
  return `${n} lets you sign in with ${namesOf(offered)}, or with your ${n} email. Pick whichever you use on the page.`;
}

/** Sites that only deliver food: walled, the restaurant's own ordering still works (src/food.js, #449). */
const FOOD_APPS = new Set(["doordash", "uber_eats", "grubhub", "postmates", "caviar", "seamless"]);
/**
 * What works instead when a site walls Reason's browser off its sign-in page, for the page and the
 * text alike. Plain words, no "bot", no blame on them.
 */
export function wallInstead(entry) {
  const site = entry?.site ?? "";
  if (FOOD_APPS.has(site)) return { say: "Ordering straight from the restaurant's own site still works, and it's often cheaper.", tool: "food_order: build the order direct at the restaurant's own ordering page (route direct), with the delivery app only as the fallback it already is." };
  if (site === "uber" || site === "uber_eats") return { say: "Connecting Uber with its own Connect button still works.", tool: "uber_connect with they_asked_to_connect true; for a ride, uber_link needs no sign-in." };
  return { say: "", tool: "Offer what does not need a sign-in here, or say plainly this one has to be done by them on their own phone." };
}

const REFUSAL_DAYS = 7;
db.db.exec(`
  CREATE TABLE IF NOT EXISTS social_refusals (
    conversation_id TEXT NOT NULL,
    site TEXT NOT NULL,
    provider TEXT NOT NULL,
    refused_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, site, provider)
  );
`);
/** The provider refused Reason's browser for this site: kept 7 days so no link, window or lapse re-try goes round again. */
export function recordRefusal(conversationId, site, provider) {
  const key = providerKey(provider);
  if (!key || !site) return;
  db.db.prepare("INSERT INTO social_refusals (conversation_id, site, provider, refused_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, site, provider) DO UPDATE SET refused_at = excluded.refused_at")
    .run(conversationId, site, key, clock.now());
}
export function refusedRecently(conversationId, site, provider, now = clock.now()) {
  const key = providerKey(provider);
  if (!key) return false;
  const row = db.db.prepare("SELECT refused_at FROM social_refusals WHERE conversation_id = ? AND site = ? AND provider = ?").get(conversationId, site, key);
  return !!row && now - row.refused_at < REFUSAL_DAYS * 86_400_000;
}

// ---------------------------------------------------------------- the wall, asked live
/**
 * Can Reason's browser reach a site's sign-in page from where it runs, today? Asked of the site
 * itself and kept ten minutes per site (a walled answer thirty seconds, so a wall that lifts is seen).
 *
 * `src/sites.js` carries `signin_blocked` as a dated finding: Uber's auth.uber.com answered the
 * Hetzner box with Cloudflare's "Performing security verification" on 2026-10-15, and the live box
 * again on 2026-11-10 (HTTP 403 to headless Chromium, never clearing in 20 s). A finding with a date
 * on it is not a property of the site, and the Google route is only worth offering when the page
 * loads — so the social path asks each time, and the static finding stays for everybody else.
 *
 * `{ in, status, why, providers_offered, checked_at }`: `in` only when the page came back 2xx with
 * no challenge marker on it; `providers_offered` is what the page's words name.
 */
const WALL_TTL_MS = 10 * 60_000;
const WALL_BLOCKED_TTL_MS = 30_000;
const CHALLENGE = /performing security verification|just a moment|challenge-platform|cf-chl|attention required|access denied/i;
const walls = new Map();
export function _resetWalls() { walls.clear(); }
/** The last live answer for a site, or null when nobody has asked (or it has gone stale). */
export function wallCached(site) {
  const hit = walls.get(site);
  if (!hit) return null;
  return clock.now() - hit.at < (hit.out.in ? WALL_TTL_MS : WALL_BLOCKED_TTL_MS) ? hit.out : null;
}
export async function signinWall(entry, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const site = entry?.site ?? "";
  const url = entry?.signin_url ?? "";
  if (!site || !url) return { in: false, status: 0, why: "the site has no sign-in page on record", providers_offered: [], checked_at: clock.now() };
  const hit = wallCached(site);
  if (hit) return hit;
  let out;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const label = entry.label ?? site;
  try {
    // Through the network guard (src/netguard.js): since #454 the page can be any site the model
    // named by its address, so neither it nor a redirect from it may reach this machine's network.
    const got = await guardedFetch(url, { signal: ctl.signal, fetchImpl, httpsOnly: true, headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", Accept: "text/html" } });
    if (!got.ok) return { in: false, status: 0, why: `${label}'s sign-in page was not fetched: ${got.why}`, providers_offered: [], checked_at: clock.now() };
    const res = got.res;
    const status = Number(res?.status ?? 0);
    const html = String((await res.text().catch(() => "")) ?? "").slice(0, 400_000);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const marker = CHALLENGE.exec(text)?.[0] ?? "";
    if (marker || status === 403 || status === 503) {
      out = { in: false, status, why: `${label}'s sign-in page answers Reason's browser from here with a bot check (HTTP ${status}${marker ? `, "${marker}"` : ""}), so a link would show the wall and nothing else.`, providers_offered: [], checked_at: clock.now() };
    } else if (status >= 200 && status < 300) {
      out = { in: true, status, why: "", providers_offered: providersOffered(text), checked_at: clock.now() };
    } else {
      out = { in: false, status, why: `${label}'s sign-in page answered HTTP ${status} from here.`, providers_offered: [], checked_at: clock.now() };
    }
  } catch (e) {
    out = { in: false, status: 0, why: `${label}'s sign-in page could not be reached from here: ${(e?.message ?? String(e)).split("\n")[0]}`, providers_offered: [], checked_at: clock.now() };
  } finally { clearTimeout(timer); }
  walls.set(site, { at: clock.now(), out });
  return out;
}

// ---------------------------------------------------------------- Uber
/**
 * Uber is NOT a social sign-in (owner, 2026-11-10, reversing the same day's "Uber first"): the Uber
 * connect card (uber_connect, src/uber.js authorizeUrl, the web setup's Uber card) is how an Uber
 * account is connected, and a ride is uber_link. Nothing here asks for a Google login for Uber.
 */
export const UBER_SIGNIN_HOSTS = ["uber.com", "m.uber.com", "riders.uber.com", "auth.uber.com"];

// ---------------------------------------------------------------- the record
/** The provider a site's saved login uses for this person, from the live row; "" when none or not signed in. */
export function providerOf(conversationId, site) {
  const row = db.liveAccount(conversationId, site);
  if (!row || row.state !== "signed_in") return "";
  return providerKey(row.provider);
}

/** Every site this person has signed in to through a given provider — what else one login unlocks. */
export function sitesThrough(conversationId, provider) {
  const key = providerKey(provider);
  if (!key) return [];
  return db.liveSigninsFor(conversationId).filter(r => providerKey(r.provider) === key).map(r => r.name);
}

// ---------------------------------------------------------------- a no, for 30 days
export const DECLINE_DAYS = 30;
const DECLINE_MS = DECLINE_DAYS * 24 * 60 * 60_000;

db.db.exec(`
  CREATE TABLE IF NOT EXISTS social_declines (
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    declined_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, provider)
  );
`);

/** They said no to "want me to use your Google login?". Remembered per provider; a newer no restarts the 30 days. */
export function recordDecline(conversationId, provider) {
  const key = providerKey(provider);
  if (!key) throw new Error(`not a provider: ${provider}`);
  const now = clock.now();
  db.db.prepare("INSERT INTO social_declines (conversation_id, provider, declined_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id, provider) DO UPDATE SET declined_at = excluded.declined_at")
    .run(conversationId, key, now);
  return { provider: key, declined_at: now, until: now + DECLINE_MS };
}

/** Where the ask stands for one provider: may Reason ask, and if not, until when. */
export function askState(conversationId, provider, now = clock.now()) {
  const key = providerKey(provider);
  const row = key ? db.db.prepare("SELECT declined_at FROM social_declines WHERE conversation_id = ? AND provider = ?").get(conversationId, key) : null;
  if (!row) return { provider: key, ask_allowed: true, declined_at: null, until: null };
  const until = row.declined_at + DECLINE_MS;
  return { provider: key, ask_allowed: now >= until, declined_at: row.declined_at, until, days_left: Math.max(0, Math.ceil((until - now) / 86_400_000)) };
}
export const askAllowed = (conversationId, provider, now) => askState(conversationId, provider, now).ask_allowed;

/** Forget the no (they brought it up themselves). */
export function clearDecline(conversationId, provider) {
  db.db.prepare("DELETE FROM social_declines WHERE conversation_id = ? AND provider = ?").run(conversationId, providerKey(provider));
}

// ---------------------------------------------------------------- the rules
/**
 * What the model is told, in the system prompt, where the sign-in rules already live (src/agent.js).
 * One block, only when the flag reaches this person. Every line here is a line of the spec.
 */
export const RULES = [
  `- Many sites sign in through a Google, Apple, Facebook or Microsoft account, and one of those logins opens dozens of their accounts — so getting it is high-leverage and you treat it as a priority, but you EARN it through a real task and never make a cold ask.`,
  `- WHEN TO ASK: the first time a real task needs a site whose account uses one of those. Tie the ask to that task, one line, specific: "DoorDash signs in through your Google account. Want me to use it? It'll also let me get into your other Google sign-in sites later without asking again." Never during onboarding chit-chat, never mid-vent, never late at night unless they are actively asking you to do something right then, and never when the task can be done without signing in. Say "your Google login", never "social provider" or "OAuth".`,
  `- If they do not know how they sign in somewhere, find out before you ask: signin_provider with action "infer" reads the site's sign-in page for which buttons it offers, and gmail_search for that site's welcome or receipt email ("you signed up with Google") settles it. Then confirm in one line; never guess out loud as if you knew.`,
  `- A no is a no: finish the task another way if you can, and do not ask about that provider again for ${DECLINE_DAYS} days unless they bring it up. Record it with signin_provider action "declined", and check signin_provider action "ask_check" before any ask — it says whether the ${DECLINE_DAYS} days are up. Never pressure, never repeat a declined ask.`,
  `- ANY SITE: this works on any site whose sign-in page has one of those buttons — Notion, Airbnb, Figma, a gym's booking site — not only the sites signin_link names. For a site not on its list, pass the site's web address as \`site\` (its sign-in page if you know it, e.g. https://www.notion.so/login, else its domain); signin_provider infer and signin_status take the address the same way. When a real task needs their account on a site you are not signed in to, the answer is the one-line ask and then the secure link — never "I can't get into it" or "that site isn't supported", and capabilities listing no saved sign-in for it does not mean it cannot be signed in to.`,
  `- HOW IT IS COLLECTED: never a password, a code or a card number in this chat. Send the secure sign-in link (signin_link, with the provider as its \`provider\`) and they sign in on the provider's own page inside it. The login is saved only once the site says they are signed in, and which provider each site uses is written down with it; you are told when that happens.`,
  `- TWO-STEP VERIFICATION: expect it. Least effort first: a Yes tap on their phone, then a code sent to an email you can read yourself (gmail_search, gmail_read — never "check your email"), then a texted code they forward to you. Tell them what to expect in one line: "Google will ping your phone. Tap Yes." A forwarded code is cleaned before it is typed (a "G-", spaces and dashes come off), so take it as they send it. If a code fails twice, switch methods once; if that fails too, stop and say plainly what blocked it. Sites often send a second code of their own after the provider approves: warn them one more may come.`,
  `- REFUSED: Google (or Apple/Microsoft) sometimes refuses Reason's browser on its own page ("This browser or app may not be secure"). You are told when that happens. Then say it in one plain line — Google refused my browser for that site — never retry it, and offer that site's own email/password sign-in through the secure link (signin_link with no provider) if it has one.`,
  `- AFTER ACCESS: finish the task first. Then, once, say what it unlocked: "Now I can handle your DoorDash and Airbnb too, since they use the same Google sign-in." When a session lapses, sign back in yourself (signin_status with recheck tries the saved provider button for you); only involve them for an approval tap or a code.`,
  `- UBER: never ask for their Google (or any provider) login for Uber. Connecting their Uber account is the Uber connect card (uber_connect), only when they ask to connect it; a ride is uber_link, every time, as before.`,
  `- TRUST: use provider access only for tasks they asked for or approved — no curiosity browsing. Never change passwords, security settings, recovery emails or connected apps. Never grant a new third-party app access without asking. Money, a message sent as them, and anything permanent still need their go-ahead. If they ask what you can get into, answer honestly from signin_status and say how to revoke it (account_revoke, or the provider's own connected-apps page). Signing in with Google is not the same as reading their Gmail: it opens that site, nothing else.`,
].join("\n");

/** The block for one person's prompt, or "" where the flag does not reach them. */
export function rulesFor(conversationId) {
  return socialAllowedFor(conversationId) ? RULES : "";
}

// ---------------------------------------------------------------- signing back in
/**
 * A session that lapsed on a site whose saved login says which provider it uses: open the sign-in
 * page, press that provider's button, and ask the site again. Works when the provider's own session
 * is still good in the same profile (Google keeps one for weeks); when it is not, the site lands on
 * the provider's page waiting for the person, and that is what comes back — nothing is typed for them.
 */
export async function signInAgain(page, conversationId, entry, { provider = "", check = null, settleMs = 2500 } = {}) {
  const key = providerKey(provider || providerOf(conversationId, entry.site));
  if (!key) return { ok: false, tried: false, why: "no provider is on record for this site" };
  if (!entry?.signin_url) return { ok: false, tried: false, why: "the site has no sign-in page on record" };
  try {
    await page.goto(entry.signin_url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (page.waitForTimeout) await page.waitForTimeout(1000).catch(() => {});
  } catch (e) {
    return { ok: false, tried: true, provider: key, pressed: "", why: `${entry.label}'s sign-in page did not load: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }
  if (refusedRecently(conversationId, entry.site, key)) return { ok: false, tried: false, provider: key, refused: true, why: `${LABELS[key]} refused Reason's browser for ${entry.label} recently; not tried again` };
  const { pressed } = await clickProviderButton(page, key, { settleMs });
  // The provider's own "this browser may not be secure": never saved, never pressed again.
  try {
    const raw = { url: page.url ? page.url() : "", text: await page.evaluate(() => document.body?.innerText ?? "") };
    const no = providerRefused(raw);
    if (no.refused) { recordRefusal(conversationId, entry.site, no.provider); return { ok: true, tried: true, provider: key, pressed, refused: true, state: "signed_out", why: no.why }; }
  } catch { /* unreadable: the site's own check answers */ }
  const recheck = check ?? (async (p, c, site) => (await import("./signin.js")).checkAndRecord(p, c, site, { provider: key }));
  const out = await recheck(page, conversationId, entry.site);
  return { ok: true, tried: true, provider: key, pressed, state: out?.state ?? "unknown", why: out?.why ?? out?.error ?? "" };
}
