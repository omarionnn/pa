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
 * globals only — Playwright serialises it across.
 */
export const PROVIDER_BUTTON_JS = `((provider) => {
  var want = String(provider || "").toLowerCase();
  if (!want) return "";
  var els = document.querySelectorAll('button,a[href],[role="button"],input[type="button"],input[type="submit"]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var txt = ((el.innerText || el.value || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("data-provider") || "")).replace(/\\s+/g, " ").trim().toLowerCase();
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
})`;

/** The text of a candidate control, the way PROVIDER_BUTTON_JS judges it. Pure, for tests and for hand checks. */
export function providerButtonMatches(label, provider) {
  const want = providerKey(provider);
  const txt = String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!want || !txt || !txt.includes(want) || txt.length > 80) return false;
  return /(continue|sign|log|use|with|account|via)/.test(txt) || txt === want;
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
  try { pressed = String(await page.evaluate(PROVIDER_BUTTON_JS, key) ?? ""); } catch { pressed = ""; }
  if (pressed && settleMs > 0 && page.waitForTimeout) await page.waitForTimeout(settleMs).catch(() => {});
  return { pressed };
}

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
  `- HOW IT IS COLLECTED: never a password, a code or a card number in this chat. Send the secure sign-in link (signin_link, with the provider as its \`provider\`) and they sign in on the provider's own page inside it. The login is saved only once the site says they are signed in, and which provider each site uses is written down with it; you are told when that happens.`,
  `- TWO-STEP VERIFICATION: expect it. Least effort first: a Yes tap on their phone, then a code sent to an email you can read yourself (gmail_search, gmail_read — never "check your email"), then a texted code they forward to you. Tell them what to expect in one line: "Google will ping your phone. Tap Yes." A forwarded code is cleaned before it is typed (a "G-", spaces and dashes come off), so take it as they send it. If a code fails twice, switch methods once; if that fails too, stop and say plainly what blocked it. Sites often send a second code of their own after the provider approves: warn them one more may come.`,
  `- AFTER ACCESS: finish the task first. Then, once, say what it unlocked: "Now I can handle your Uber and Airbnb too, since they use the same Google sign-in." When a session lapses, sign back in yourself (signin_status with recheck tries the saved provider button for you); only involve them for an approval tap or a code.`,
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
  const { pressed } = await clickProviderButton(page, key, { settleMs });
  const recheck = check ?? (async (p, c, site) => (await import("./signin.js")).checkAndRecord(p, c, site, { provider: key }));
  const out = await recheck(page, conversationId, entry.site);
  return { ok: true, tried: true, provider: key, pressed, state: out?.state ?? "unknown", why: out?.why ?? out?.error ?? "" };
}
