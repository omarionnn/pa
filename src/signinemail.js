// Signing in to a site with the site's OWN emailed code or link, read from the person's Gmail by
// Reason itself (owner, 2026-11-11: "the person says sign me into notion, then we ask the site for the
// email code" and "remove that whole scary Google thing"). Behind REASON_SOCIAL_SIGNIN, like the rest
// of src/socialsignin.js.
//
// Why: Google refuses Reason's server browser on its own sign-in page by policy (see NEVER_PRESSED in
// src/socialsignin.js). Many sites offer an emailed code or link that works however the account was
// made (research 2026-11-11). Offering one is not the same as letting Reason's browser use it: the
// 2026-11-12 probe found Canva, DoorDash and Uber's sign-in walled outright and Spotify refusing
// after the email went in (src/sitefindings.js). Where the route is open:
//
//   1. Reason opens the site's sign-in page in the person's own saved profile (headless, the same
//      guarded browser the sign-in link uses) and takes its email route: the email box, or a
//      "Continue with email" button first. Google is never clicked; no provider button is.
//      The box is WAITED for (src/signinpage.js, about ten seconds, same-origin frames included):
//      a page that draws its form with its own script has none at first (Stripe Link, 2026-11-12).
//   2. It types the email it knows for them (or the one they named) and asks the site for a code.
//   3. Their Gmail connected: the newest mail from THAT site (sender domain + DKIM pass for it) that
//      arrived AFTER the request is read, and its code is typed — or its sign-in link opened in the
//      same browser. Polled for about 90 seconds.
//   4. No Gmail: the model asks them once, in one plain line; their reply is taken by
//      `takeCodeReply` before the model turn, so the code goes to the site and the thread keeps only a
//      placeholder.
//   5. The site's own account page says whether they are signed in (src/signin.js checkAndRecord),
//      and the model is woken with the result (db.createTimer, like the link's ending).
//
// The code is never logged, never returned from a tool, never written into a note. A provider's
// refusal page ("This browser or app may not be secure"), should one ever appear, is backed out of
// and the email route taken again. Nothing here hides the automation from any site.
import { clock, config } from "./config.js";
import * as db from "./db.js";
import * as social from "./socialsignin.js";
import * as signin from "./signin.js";
import * as restartGate from "./busy.js";
import * as findings from "./sitefindings.js";
import * as signinPage from "./signinpage.js";
import { logAttempt, logStep } from "./signinlog.js";
import { typedOnly } from "./trust.js";

/** How long Gmail is polled for the site's mail, and how often. */
export const MAIL_WAIT_MS = 90_000;
export const MAIL_POLL_MS = 5_000;
/** How long a code they were asked for is waited on. */
export const REPLY_WAIT_MS = 5 * 60_000;
/** Clock slack between this box and Gmail's receive time; a mail older than the request minus this is never taken. */
export const SKEW_MS = 3_000;

// ---------------------------------------------------------------- whose mail counts
/** Sites whose code mail comes from a sibling domain. Everything else: the site's own registrable domain. */
const SENDER_ALIASES = {
  "notion.so": ["notion.so", "notion.com", "makenotion.com"],
  "notion.com": ["notion.so", "notion.com", "makenotion.com"],
  "ubereats.com": ["uber.com", "ubereats.com"],
  "uber.com": ["uber.com", "ubereats.com"],
};
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ""; } };
/** The last two labels, or three for a two-letter country second level (co.uk). Enough for mail matching. */
export function registrableOf(host) {
  const parts = String(host ?? "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const two = parts.slice(-2).join(".");
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
}
/** The domains a site's sign-in mail may come from. */
/** Mail providers: anybody can send from them with a passing DKIM, so they are never a site's sender. */
const MAILBOX_DOMAINS = new Set(["gmail.com", "googlemail.com", "google.com", "outlook.com", "hotmail.com", "live.com", "microsoft.com", "yahoo.com", "icloud.com", "me.com", "apple.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "mail.com", "zoho.com", "fastmail.com", "yandex.com"]);
export function senderDomainsFor(entry) {
  const base = registrableOf(hostOf(entry?.signin_url) || hostOf(entry?.entry) || String(entry?.site ?? ""));
  if (!base || !base.includes(".") || MAILBOX_DOMAINS.has(base)) return [];
  return SENDER_ALIASES[base] ?? [base];
}
/** The domains that ARE the site (its own and its siblings), a mail provider included. */
export function siteDomainsFor(entry) {
  const base = registrableOf(hostOf(entry?.signin_url) || hostOf(entry?.entry) || String(entry?.site ?? ""));
  if (!base || !base.includes(".")) return [];
  return SENDER_ALIASES[base] ?? [base];
}
/**
 * Is the browser still on the site it was sent to? A code is only ever typed into the site's own
 * page: a sign-in address that redirects elsewhere (an open redirect, a lookalike) would otherwise be
 * handed that site's real code (review, 2026-11-12). Unreadable address: no.
 */
export function onSite(page, entry) {
  let host = "";
  try { host = hostOf(page.url()); } catch { host = ""; }
  return !!host && within(host, siteDomainsFor(entry));
}
const within = (domain, allowed) => {
  const d = String(domain ?? "").toLowerCase().replace(/^@/, "");
  return !!d && allowed.some(a => d === a || d.endsWith(`.${a}`));
};
/** The address's domain out of a From header ("Notion <notify@updates.notion.so>"). */
export function fromDomain(from) {
  const m = String(from ?? "").match(/<?[^\s<>@"]+@([^\s<>"]+?)>?\s*$/);
  return m ? m[1].toLowerCase() : "";
}
/**
 * Is this mail really from the site? The From domain is one of the site's, AND Gmail's own
 * Authentication-Results says DKIM passed for one of the site's domains. A From header alone can be
 * forged by anybody; a passing DKIM signature for the domain cannot.
 */
export function senderMatches({ from = "", auth = [] } = {}, allowed = []) {
  if (!allowed.length || !within(fromDomain(from), allowed)) return false;
  // Only the verdict Gmail itself wrote: the TOPMOST Authentication-Results, stamped mx.google.com.
  // Gmail prepends its own and keeps the sender's below, so any other one may be the sender's forgery
  // (cold review, 2026-11-11).
  const top = String((Array.isArray(auth) ? auth : [auth])[0] ?? "").toLowerCase().trim();
  if (!/^mx\.google\.com\s*;/.test(top)) return false;
  for (const m of top.matchAll(/dkim=pass[^;]*?header\.(?:i|d)=@?([a-z0-9.-]+)/g)) if (within(m[1], allowed)) return true;
  return false;
}

// ---------------------------------------------------------------- the code or link in a mail
const decodeB64 = (data) => { try { return Buffer.from(String(data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; } };
/** Every text/plain and text/html part of a Gmail `full` payload, decoded. */
export function partsOf(payload) {
  const out = { text: "", html: "" };
  const walk = (p) => {
    if (!p) return;
    const type = String(p.mimeType ?? "").toLowerCase();
    if (p.body?.data && type === "text/plain") out.text += decodeB64(p.body.data) + "\n";
    if (p.body?.data && type === "text/html") out.html += decodeB64(p.body.data) + "\n";
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}
const htmlToText = (h) => String(h ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d|li)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const CODE_WORDS = /\b(code|passcode|one[- ]time|verification|verify|otp|pin)\b/i;
/** A token that reads as a sign-in code: 4–8 digits; letters+digits 4–12; or word-word(-word) groups. */
function codeIn(line) {
  const l = String(line ?? "");
  const digits = l.match(/(?<![\w.,/$#-])(\d{4,8})(?![\w.,/%-])/);
  if (digits && !/^(19|20)\d\d$/.test(digits[1])) return digits[1];
  const spaced = l.match(/(?<![\w])(\d{3}[ -]\d{3})(?![\w])/);
  if (spaced) return spaced[1];
  const words = l.match(/(?<![\w-])([a-z0-9]{3,10}(?:-[a-z0-9]{3,10}){1,3})(?![\w-])/i);
  if (words && !/^(one-time|sign-in|log-in|two-factor|e-mail)$/i.test(words[1])) return words[1];
  const alnum = l.match(/(?<![\w-])((?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,12})(?![\w-])/);
  if (alnum) return alnum[1];
  return "";
}
const LINK_PATH = /log-?in|sign-?in|verify|magic|auth|token|confirm|callback|session/i;
const LINK_NEVER = /unsubscribe|preferences|settings|privacy|terms|help|support|policy|report|account\/security|download|\.(png|jpe?g|gif)(\?|$)/i;
/**
 * The sign-in code or link in one mail from the site. `allowed`: the site's domains — a link is only
 * ever one that opens on the site itself. A code is preferred (it goes in the box the page is on).
 *   → { kind: "code", code } | { kind: "link", url } | null
 */
export function extractSignin({ subject = "", text = "", html = "" } = {}, allowed = []) {
  const body = `${text}\n${htmlToText(html)}`;
  const lines = [subject, ...body.split(/\n+/)].map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!CODE_WORDS.test(lines[i])) continue;
    // The code on the same line after its word, else on the next short line (a big code alone).
    const after = lines[i].split(CODE_WORDS).slice(-1)[0] ?? "";
    const same = codeIn(after.replace(/^[\s:.\-–—is]+/i, "")) || codeIn(lines[i]);
    if (same) return { kind: "code", code: same };
    const next = lines[i + 1] ?? "";
    if (next.length <= 24) { const c = codeIn(next); if (c) return { kind: "code", code: c }; }
  }
  const hrefs = [...String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, "&"));
  const bare = [...body.matchAll(/https:\/\/[^\s<>"')]+/g)].map(m => m[0]);
  for (const u of [...hrefs, ...bare]) {
    let url; try { url = new URL(u); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) continue;
    if (!within(url.hostname, allowed)) continue;
    if (LINK_NEVER.test(url.pathname + url.search) || !LINK_PATH.test(url.pathname + url.search)) continue;
    return { kind: "link", url: url.toString() };
  }
  return null;
}

// ---------------------------------------------------------------- Gmail
/**
 * The newest sign-in code or link the site mailed since `since` (ms), from any of their connected
 * Gmail accounts, polled until `waitMs` runs out. Only mail that passes senderMatches and whose
 * Gmail receive time is at or after the request counts.
 *   → { connected: false } | { connected: true, found: false } | { connected: true, found: true, kind, code|url }
 * `tokens(conv)` and `api(token, method, path, opts)` default to src/google.js, handed in by tests.
 */
export async function codeFromGmail(conversationId, entry, { since, waitMs = MAIL_WAIT_MS, pollMs = MAIL_POLL_MS, tokens = null, api = null, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => clock.now() } = {}) {
  const google = (tokens && api) ? null : await import("./google.js");
  const getTokens = tokens ?? ((c) => google.allAccessTokens(c, { scope: google.TOOL_SCOPES.gmail_search }));
  const call = api ?? ((...a) => google.api(...a));
  const allowed = senderDomainsFor(entry);
  if (!allowed.length) return { connected: true, found: false, why: "no sender domain for this site" };
  let got;
  try { got = await getTokens(conversationId); } catch { got = null; }
  const accounts = got?.ok ? (got.accounts ?? []).filter(a => a?.token) : [];
  if (!accounts.length) return { connected: false };
  // Only that site's mail, and only mail from the moment of the ask on (Gmail takes `after:` in
  // epoch seconds): earlier mail from the site is never fetched at all.
  const q = `from:(${allowed.join(" OR ")}) newer_than:1d after:${Math.max(0, Math.floor((Number(since) - SKEW_MS) / 1000) - 1)}`;
  const seen = new Set();
  const deadline = now() + waitMs;
  for (;;) {
    let best = null;
    for (const a of accounts) {
      const list = await call(a.token, "GET", "/gmail/v1/users/me/messages", { query: { q, maxResults: 5 } }).catch(() => null);
      for (const m of list?.ok ? (list.body?.messages ?? []) : []) {
        if (!m?.id || seen.has(`${a.account}:${m.id}`)) continue;
        const one = await call(a.token, "GET", `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { query: { format: "full" } }).catch(() => null);
        if (!one?.ok) continue;
        const msg = one.body ?? {};
        const at = Number(msg.internalDate) || 0;
        // Older than the request: never this sign-in's mail, and never looked at again.
        if (at < since - SKEW_MS) { seen.add(`${a.account}:${m.id}`); continue; }
        const headers = msg.payload?.headers ?? [];
        const h = (name) => headers.filter(x => String(x?.name ?? "").toLowerCase() === name).map(x => String(x?.value ?? ""));
        if (!senderMatches({ from: h("from")[0] ?? "", auth: h("authentication-results") }, allowed)) { seen.add(`${a.account}:${m.id}`); continue; }
        const found = extractSignin({ subject: h("subject")[0] ?? "", ...partsOf(msg.payload) }, allowed);
        seen.add(`${a.account}:${m.id}`);
        if (found && (!best || at > best.at)) best = { ...found, at };
      }
    }
    if (best) return { connected: true, found: true, kind: best.kind, ...(best.kind === "code" ? { code: best.code } : { url: best.url }) };
    if (now() + pollMs > deadline) return { connected: true, found: false };
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- the page
/**
 * Runs in the page: the shape of the sign-in form and its controls, and (with `act`) one action on
 * it. Browser globals only — Playwright serialises the function across. Never reads a box's value.
 *   act: "" (just read) | "route" (click a "continue with email" control) | "submit" (click the
 *        form's continue/send-code control) | "codeinstead" (click "use a code instead") |
 *        "mark_email" / "mark_code" (tag the box so the caller can type into it by selector)
 */
export function emailPage(act) {
  var NEVER = /google|apple|facebook|microsoft|passkey|\bsso\b|saml|github|slack|twitter|\bx\b|linkedin|single sign|wallet|phone/i;
  function vis(el) { var r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false; var cs = window.getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; }
  function label(el) { return ((el.innerText || el.value || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).replace(/\s+/g, " ").trim(); }
  function about(i) { return [i.type, i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute("aria-label") || "", i.getAttribute("inputmode") || ""].join(" ").toLowerCase(); }
  var inputs = Array.prototype.slice.call(document.querySelectorAll("input")).filter(function (i) { return vis(i) && !/hidden|checkbox|radio|submit|button/.test(i.type); });
  var email = inputs.filter(function (i) { return i.type === "email" || /e-?mail|username/.test(about(i)); })[0] || null;
  var codes = inputs.filter(function (i) { return i.autocomplete === "one-time-code" || /\b(code|otp|verif|passcode|pin)\b/.test(about(i)) || (i.maxLength === 1 && /numeric|tel|text/.test(i.type + " " + (i.getAttribute("inputmode") || ""))); });
  var password = inputs.filter(function (i) { return i.type === "password"; })[0] || null;
  var ctrls = Array.prototype.slice.call(document.querySelectorAll('button,a[href],[role="button"],input[type="submit"],input[type="button"]')).filter(vis);
  function find(re) { for (var k = 0; k < ctrls.length; k++) { var t = label(ctrls[k]); var href = ctrls[k].getAttribute("href") || ""; if (t && t.length <= 60 && re.test(t) && !NEVER.test(t) && !/google|apple|facebook|microsoft/i.test(href)) return ctrls[k]; } return null; }
  var ROUTE = /^(continue|sign in|log ?in|sign up|get started)? ?(with|using|via|by)? ?(your |an |my )?e-?mail( address)?$|^use (your |my )?e-?mail|^(sign|log) ?in with (a |an )?(e-?mail|code|magic link)|^e-?mail( me)? (a )?(login |sign-?in )?(code|link)$/i;
  var SUBMIT = /^(continue|next|submit|log ?in|sign ?in|send( me)?( an?)?( login| sign-?in| magic| verification)? (code|link)|e-?mail me( an?)?( login| sign-?in)? (code|link)|get( an?)? (code|link)|continue with (login |e-?mail )?code|verify|confirm)$/i;
  var INSTEAD = /(use|send|e-?mail|get)( me)? (an? )?(login |sign-?in |one-time |verification )?code( instead)?$|continue with (a )?(login )?code|sign in with (a )?code|e-?mail (me )?(an? )?(login |magic )?link|(log|sign) ?in (with|using) (a |an )?(e-?mail|code)/i;
  var did = "";
  if (act === "route") { var r = find(ROUTE); if (r) { r.click(); did = label(r); } }
  else if (act === "submit") { var s = find(SUBMIT); if (s) { s.click(); did = label(s); } }
  else if (act === "codeinstead") { var c = find(INSTEAD); if (c) { c.click(); did = label(c); } }
  else if (act === "mark_email" && email) { document.querySelectorAll("[data-reason-box]").forEach(function (x) { x.removeAttribute("data-reason-box"); }); email.setAttribute("data-reason-box", "email"); did = "email"; }
  else if (act === "mark_code" && codes.length) { document.querySelectorAll("[data-reason-box]").forEach(function (x) { x.removeAttribute("data-reason-box"); }); codes[0].setAttribute("data-reason-box", "code"); did = codes.length > 1 ? "split" : "code"; }
  var text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ").slice(0, 4000);
  return { did: did, email: !!email, code: codes.length > 0, split: codes.length > 1, password: !!password, route: !!find(ROUTE), instead: !!find(INSTEAD), text: text, url: location.href };
}

const SENT = /(we('ve| have)? (just )?(sent|emailed)|check your (inbox|email)|enter (the |your )?(\d+[- ]digit )?(code|verification)|(login|sign-?in|temporary|verification) code|magic link|code (was )?sent|sent (a |you a )?(code|link))/i;
/**
 * The site turning THE EMAIL down, in words that are about the email ("Invalid email domain", "No
 * account found"). Only these are a rejected email.
 */
const REJECTED = /invalid e-?mail|not a valid|isn'?t valid|enter a valid|no account|couldn'?t find (an? |your )?account|account (does not|doesn'?t) exist|e-?mail (does not|doesn'?t) exist|not recogni[sz]ed|not registered/i;
const REJECTED_LINE = /(invalid e-?mail|not a valid|isn'?t valid|enter a valid|no account|couldn'?t find (an? |your )?account|account (does not|doesn'?t) exist|e-?mail (does not|doesn'?t) exist|not recogni[sz]ed|not registered)(\s+[a-z]+){0,1}/i;
/**
 * The site refusing REASON'S BROWSER: a generic failure with nothing about the email in it, a rate
 * limit, a captcha or challenge page. Spotify answered "Something went wrong" after the email went
 * in (2026-11-12) and the old pattern read that as a wrong email, asked which email they use and
 * tried another address — which is how an account gets locked. None of this is ever a rejected email.
 */
export const SITE_REFUSED = /something went wrong|went wrong|try again( later)?|too many (attempts|requests|tries|times)|unusual (activity|traffic)|suspicious activity|an? (unexpected |unknown )?error (has )?occurr?ed|unable to (process|complete) (your |this )?request|request (was )?blocked|access denied|temporarily (blocked|unavailable|locked)|rate limit|oops/i;
/** A challenge standing where the form should be: read only when the page has no email box and no code box. */
const CHALLENGE = /performing security verification|just a moment|verify(ing)? you(?:'re| are) (?:a )?human|i'?m not a robot|are you a (human|robot)|press (?:and|&) hold|unusual traffic|attention required|access denied|checking your browser|complete the (captcha|security check)/i;
/** The site turning the CODE down. */
const WRONG_CODE = /(incorrect|invalid|wrong|expired)[^.\n]{0,24}\b(code|passcode)\b|\b(code|passcode)\b[^.\n]{0,30}(is |was |has )?(incorrect|invalid|wrong|expired|not valid|didn'?t match|doesn'?t match)/i;
/**
 * What a sign-in page's words say went wrong after the email was submitted. `before`: the page's
 * words before the press, so copy that was always there ("Having trouble? Try again") is not news.
 * Words about the email win over a generic failure: "Invalid email. Try again." is a wrong email.
 *   → "rejected" | "refused" | ""
 */
export function failureKind(text, before = "") {
  const t = String(text ?? "");
  const b = String(before ?? "");
  // Any match that was not already on the page: the first match may be old copy with the news after it.
  const fresh = (re) => [...t.matchAll(new RegExp(re.source, "gi"))].some(m => !b.toLowerCase().includes(m[0].toLowerCase()));
  if (fresh(REJECTED)) return "rejected";
  if (fresh(SITE_REFUSED)) return "refused";
  return "";
}
const wait = (page, ms) => (page?.waitForTimeout ? page.waitForTimeout(ms).catch(() => {}) : new Promise(r => setTimeout(r, ms)));
const NOTHING = { did: "", email: false, code: false, split: false, password: false, route: false, instead: false, text: "", url: "" };
const read = async (page, act = "") => { try { const f = await page.evaluate(emailPage, act); return f && typeof f === "object" ? f : NOTHING; } catch { return NOTHING; } };
/** How long requestCode settles between reads when nobody says otherwise; the form wait scales with it. */
const SETTLE_MS = 2500;
/** The page's own frames on its own origin: a form the site draws inside its own iframe is its form. */
function sameOriginFrames(page) {
  try {
    const main = page.mainFrame?.();
    const origin = new URL(page.url()).origin;
    return (page.frames?.() ?? []).filter(f => f !== main && (() => { try { return new URL(f.url()).origin === origin; } catch { return false; } })());
  } catch { return []; }
}
/**
 * Wait for the site's email box: the page and its same-origin frames are read until one has it or
 * `waitMs` runs out. A "Continue with email" control standing where the box should be is pressed
 * once on the way. Stops the moment the box is there.
 *
 * It also stops early on a clear negative (src/signinpage.js settleWatch): a page that has finished
 * loading, has words on it, is fetching nothing and has not changed for two seconds has no email box
 * and is not about to draw one. Without that, every page with no email box (a home page, a
 * password-only form, a Google-only page) cost the whole bound. A bot check is the exception and
 * gets the whole bound: one that clears by itself is not a wall, and a wall is written down for
 * everybody.
 *   → { found, on (the page, or the frame whose document has the box), f (the last reading), ms, settled }
 */
export async function waitForEmailBox(page, { waitMs = signinPage.formWaitMs(), pollMs = 250, settleMs = SETTLE_MS, quietMs = signinPage.QUIET_MS } = {}) {
  let routed = false, main = NOTHING, on = page;
  const watch = signinPage.settleWatch(page, { quietMs, forMs: waitMs });
  try {
    const got = await signinPage.waitFor(page, async () => {
      main = await read(page);
      if (main.email) { on = page; return main; }
      for (const fr of sameOriginFrames(page)) {
        const f = await read(fr);
        if (f.email) { on = fr; return f; }
      }
      if (main.route && !routed) { routed = true; await read(page, "route"); await wait(page, Math.min(settleMs, 400)); }
      return null;
    }, { waitMs, pollMs, stop: async () => !CHALLENGE.test(main.text) && await watch.settled() });
    return { found: got.found, on: got.found ? on : page, f: got.found ? got.value : main, ms: got.ms, settled: !!got.settled };
  } finally { watch.stop(); }
}

/** Every page in the context but the first, closed: a provider popup is never left open. */
async function closePopups(page) {
  try { const ctx = page.context?.(); for (const p of ctx?.pages?.() ?? []) if (p !== page) await p.close().catch(() => {}); } catch { /* nothing to close */ }
}
/**
 * Is the browser on a provider's refusal page (or any Google page)? Then back out to the site's
 * sign-in page and take its email route again. The person never sees it; it is logged as a refusal.
 */
export async function backOutOfProvider(page, entry, conversationId, log = () => {}) {
  const pages = (() => { try { return page.context?.()?.pages?.() ?? [page]; } catch { return [page]; } })();
  for (const p of pages) {
    let raw = { url: "", text: "" };
    try { raw = { url: p.url(), text: await p.evaluate(() => document.body?.innerText ?? "") }; } catch { continue; }
    const no = social.providerRefused(raw);
    const onGoogle = /(^|\.)accounts\.google\.com$/.test(hostOf(raw.url));
    if (!no.refused && !onGoogle) continue;
    if (no.refused) social.recordRefusal(conversationId, entry.site, no.provider);
    log({ signin_email: "backed_out", site: entry.site, provider: no.provider || "google" });
    await closePopups(page);
    await page.goto(entry.signin_url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await wait(page, 1500);
    return true;
  }
  return false;
}

/**
 * Take the site's email route and ask for a code: the email box (after a "Continue with email" if
 * the page hides it), the email typed, the site's own continue pressed. A password box with a "use a
 * code instead" beside it takes the code. Never a provider button.
 *   → { ok, at (ms, just before the press that asks for the code), state: "code"|"sent"|"password"|"none", why }
 */
export async function requestCode(page, entry, email, { conversationId = "", log = () => {}, settleMs = SETTLE_MS, formWaitMs = null, pollMs = 250 } = {}) {
  await backOutOfProvider(page, entry, conversationId, log);
  // The email box is waited for, not read once: a page that draws its form with its own script has
  // none when it first loads (app.link.com's appears 1.3 s in; the single read at 1.1 s on
  // 2026-11-12 said "no email box"). The bound follows the settle time a caller runs at.
  const bound = formWaitMs ?? Math.round(signinPage.formWaitMs() * (settleMs / SETTLE_MS));
  const poll = Math.max(1, Math.min(pollMs, settleMs));
  let waited = await waitForEmailBox(page, { waitMs: bound, pollMs: poll, settleMs });
  let formMs = waited.ms;
  // Only a bare name was known and the page that opened has no sign-in form: the site's own
  // "Log in" link is followed once (src/signinpage.js), in this browser, before anybody is shown anything.
  let followed = false;
  if (!waited.found && entry?.generic && signinPage.isFrontPage(entry.signin_url) && !waited.f.code && !waited.f.password) {
    const door = await signinPage.followSigninDoor(page, entry);
    followed = door.followed;
    log({ signin_email: "signin_link_followed", site: entry.site, followed });
    if (followed) { await backOutOfProvider(page, entry, conversationId, log); waited = await waitForEmailBox(page, { waitMs: bound, pollMs: poll, settleMs }); formMs += waited.ms; }
  }
  // Where the form is: the page (or its own frame) every later read, type and press goes to.
  const on = waited.on;
  const here = () => (on !== page && on.isDetached?.() ? page : on);
  const where = (() => { try { return signinPage.pageOf(page.url()); } catch { return ""; } })();
  let f = waited.f;
  if (!waited.found) {
    const base = { ok: false, form_ms: formMs, where: "", followed };
    // A challenge where the form should be: the site refused the browser before any email was typed.
    if (!f.code && CHALLENGE.test(f.text)) return { ...base, state: "blocked", detail: "wall_before_form", why: `${entry.label} put a bot check where its sign-in form should be` };
    // A page whose only way in is Google: there is no route Reason's browser can take (Google
    // refuses it), and a sign-in link would only walk the person into that refusal.
    const offered = social.providersOffered(f.text);
    if (offered.length && !offered.some(social.usableProvider)) return { ...base, state: "google_only", why: `${entry.label}'s sign-in page offers only Google, and Google refuses Reason's browser` };
    // What the page IS, so a link is only ever offered onto a real step: a page with no form, no
    // challenge and no provider prompt (a home page) is not somewhere to send a person.
    const kind = (await signinPage.readPage(page)).kind;
    if (kind === "not_signin") return { ...base, state: "none", detail: "no_signin_page", page_kind: kind, why: `the ${entry.label} page that opened has no sign-in form on it${followed ? ", and neither does the page its own sign-in link leads to" : entry?.generic && signinPage.isFrontPage(entry.signin_url) ? ", and no sign-in link Reason could follow" : ""}` };
    return { ...base, where, state: "none", page_kind: kind, why: `${entry.label}'s sign-in page shows no email box Reason can use` };
  }
  const before = f.text;
  // The site's own 403 / 429 to the press that asks for the code: a refusal of the browser.
  let refusedStatus = 0;
  const onResponse = (res) => {
    try {
      const s = Number(res.status());
      if ((s === 403 || s === 429) && within(hostOf(res.url()), siteDomainsFor(entry)) && ["document", "xhr", "fetch"].includes(res.request().resourceType())) refusedStatus ||= s;
    } catch { /* a response that cannot be read says nothing */ }
  };
  // "Too many attempts" and a 429 are a limit on THIS address or this hour, not the site refusing
  // everybody: said as a block to this person, never written down for the others (startEmailSignin).
  const blocked = (f2, at2) => ({ ok: false, at: at2, state: "blocked", detail: refusedStatus === 429 || /too many|rate limit/i.test((f2.text.match(SITE_REFUSED) ?? [""])[0]) ? "rate_limited" : "refused_after_email", why: `${entry.label} refused Reason's browser after the email was submitted${refusedStatus ? ` (HTTP ${refusedStatus})` : ""}${(f2.text.match(SITE_REFUSED) ?? [""])[0] ? `: "${f2.text.match(SITE_REFUSED)[0].slice(0, 60)}"` : ""}` });
  // Read where the form is; a frame that showed nothing gives way to the page (a site may put the
  // code box on the page itself once its framed form has done its part).
  const readNow = async (act = "") => {
    const t = here();
    const a = await read(t, act);
    if (t === page || act || a.code || a.email || a.password) return a;
    const b = await read(page);
    return b.code || b.email || b.password ? b : a;
  };
  const found = { form_ms: formMs, where, followed, on };
  await read(here(), "mark_email");
  await here().fill('[data-reason-box="email"]', email);
  const at = clock.now();
  try { page.on?.("response", onResponse); } catch { /* a page with no events */ }
  try { return { ...found, ...(await afterPress()) }; } finally { try { page.off?.("response", onResponse); } catch { /* same */ } }
  async function afterPress() {
  const pressed = await read(here(), "submit");
  if (!pressed.did) await here().press('[data-reason-box="email"]', "Enter").catch(() => {});
  for (let i = 0; i < 6; i++) {
    await wait(page, settleMs);
    if (await backOutOfProvider(page, entry, conversationId, log)) return { ok: false, state: "none", why: "a provider page opened instead of the email route" };
    f = await readNow();
    if (f.code) return { ok: true, at, state: "code" };
    // A password box only means "it wants a password" once the email box has gone: Notion keeps one
    // on its first page for password managers (seen live 2026-11-11).
    if (f.password && !f.email && f.instead) { await read(here(), "codeinstead"); continue; }
    if (SENT.test(f.text)) return { ok: true, at, state: "sent" };
    const kind = failureKind(f.text, before);
    if (f.email && kind === "rejected") break;
    // A generic failure, a rate limit or a challenge: believed from the second read on, so a toast
    // that flashes while the page is still working is not taken as the answer.
    // A password box in place of the email box means the site took the email: that is not a refusal.
    const movedOn = f.password && !f.email;
    if (((kind === "refused" && !movedOn) || (!f.email && !f.password && CHALLENGE.test(f.text))) && i >= 1) return blocked(f, at);
  }
  const kind = failureKind(f.text, before);
  const said = (f.text.match(REJECTED_LINE) ?? [""])[0].trim();
  if (f.email && kind === "rejected" && said) return { ok: false, at, state: "rejected", why: `${entry.label} would not take that email: "${said.slice(0, 80)}"` };
  if ((kind === "refused" && !(f.password && !f.email)) || (!f.email && !f.password && CHALLENGE.test(f.text))) return blocked(f, at);
  if (f.password && !f.email) return { ok: false, at, state: "password", why: `${entry.label} asked for a password rather than sending a code` };
  // Nothing on the page says why, but the site answered the press with 403 / 429.
  if (refusedStatus) return blocked(f, at);
  return { ok: false, at, state: "none", why: `${entry.label} did not show that it sent a code` };
  }
}

/** Type the code into the site's box (one box, or split one-character boxes) and press its continue. */
export async function enterCode(page, code, { settleMs = 3000, on = null } = {}) {
  // `on`: the site's own frame the sign-in form was in (requestCode), used while its code box is there.
  let t = page;
  if (on && on !== page && !on.isDetached?.() && (await read(on)).code) t = on;
  const f = await read(t, "mark_code");
  if (!f.code) return { ok: false, why: "no code box on the page" };
  if (f.split) { await t.click('[data-reason-box="code"]').catch(() => {}); await page.keyboard.type(code, { delay: 40 }); }
  else await t.fill('[data-reason-box="code"]', code);
  await wait(page, 600);
  const after = await read(t);
  // Many code boxes submit themselves on the last character; only press continue if still there.
  if (after.code) { const s = await read(t, "submit"); if (!s.did) await t.press('[data-reason-box="code"]', "Enter").catch(() => {}); }
  await wait(page, settleMs);
  // The site saying the code is wrong or expired, on a page that still shows the code box.
  const end = await read(t);
  return { ok: true, wrong: end.code && WRONG_CODE.test(end.text) && !WRONG_CODE.test(f.text) };
}

/** Open the mailed link in the same browser — only ever on the site's own domains, https. */
export async function openLink(page, url, entry, { settleMs = 3000 } = {}) {
  const allowed = senderDomainsFor(entry);
  let u; try { u = new URL(url); } catch { return { ok: false, why: "not a link" }; }
  if (u.protocol !== "https:" || !within(u.hostname, allowed)) return { ok: false, why: "the link is not on the site" };
  await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await wait(page, settleMs);
  return { ok: true };
}

// ---------------------------------------------------------------- the job
/** conversationId → the one email sign-in running for them. In memory: a restart ends it, safely. */
const jobs = new Map();
export function emailSigninFor(conversationId) {
  const j = jobs.get(conversationId);
  return j && !j.done ? { site: j.entry.site, label: j.entry.label, state: j.state } : null;
}
export function _resetJobs() { for (const j of jobs.values()) j.reply?.(null); jobs.clear(); }

/**
 * Wait for their texted reply with a code they were asked for once, on behalf of another sign-in path
 * (src/filler.js, a saved login's texted second step). The reply is taken at intake by takeCodeReply,
 * exactly as an email sign-in's is, so the code never reaches the thread or the model. One wait per
 * person; another job already running means null at once. → Promise<code | null> (null: no reply in time).
 */
export function awaitCodeReply(conversationId, entry, { waitMs = REPLY_WAIT_MS } = {}) {
  const old = jobs.get(conversationId);
  if (old && !old.done) return Promise.resolve(null);
  const job = { entry, state: "waiting_reply", done: false, reply: null, asked: 1 };
  jobs.set(conversationId, job);
  return new Promise((resolve) => {
    const finish = (v) => { job.done = true; job.state = "done"; job.reply = null; if (jobs.get(conversationId) === job) jobs.delete(conversationId); resolve(v); };
    const t = setTimeout(() => finish(null), waitMs);
    t.unref?.();
    job.reply = (code) => { clearTimeout(t); finish(code); };
  });
}

/**
 * Their texted reply, when a sign-in is waiting on a code they were asked for: the code goes to the
 * job, and the thread (and the model) gets a placeholder instead. Anything that does not look like a
 * code goes through untouched. Called by src/runtime.js before a user turn.
 *   → the placeholder text | null
 */
export function takeCodeReply(conversationId, text) {
  const j = jobs.get(conversationId);
  if (!j || j.done || j.state !== "waiting_reply" || !j.reply) return null;
  // Only what they typed (trust.typedOnly): a note under it (a file's name, a screen effect) is never a
  // code, and never lets a code they typed through to the thread.
  const t = typedOnly(text ?? "");
  if (!t || t.length > 40) return null;
  const tidy = t.replace(/^(it'?s|the code is|code:?|here:?)\s*/i, "").replace(/[.!]+$/, "").trim();
  // Digits, letters with a digit, or three-plus word groups ("brave-otter-lamp"): never "thank-you"
  // or "follow-up", which are words (cold review, 2026-11-11).
  const looks = social.looksLikeCode(tidy) || /^[A-Za-z0-9]{4,12}$/.test(tidy) && /\d/.test(tidy)
    || /^[a-z0-9]{3,10}(-[a-z0-9]{3,10}){1,3}$/i.test(tidy) && (/\d/.test(tidy) || tidy.split("-").length >= 3);
  if (!looks) return null;
  const give = j.reply;
  j.reply = null;
  give(/^\d[\d\s-]*\d$/.test(tidy) ? social.normalizeCode(tidy) : tidy);
  return `[They replied with the ${j.entry.label} sign-in code. Reason passed it straight to ${j.entry.label}; it is not shown here. Do not ask for it again or repeat anything about it — you will be told how the sign-in ends. Reply with at most a few words, like "Got it, signing you in."]`;
}

/**
 * Start one email sign-in for this person, in the background. Returns at once; the model is woken
 * (db.createTimer) when it needs them (no Gmail: ask for the code once) and when it ends.
 * deps: launch({conversationId, url}) → { page, close }, closeBrowser(conv), check(page, conv, site),
 *       gmail(conv, entry, {since}) → codeFromGmail's answer, log, note(conv, text), timers.
 */
export function startEmailSignin({ conversationId, entry, email, launch, closeBrowser = async () => {}, check = signin.checkAndRecord, gmail = codeFromGmail, log = () => {}, note = null, replyWaitMs = REPLY_WAIT_MS, settleMs = SETTLE_MS, formWaitMs = null }) {
  const old = jobs.get(conversationId);
  if (old && !old.done) return { ok: false, busy: true, error: `An email sign-in to ${old.entry.label} is already running for them.` };
  const tell = note ?? ((c, text) => db.createTimer(c, { fireAt: clock.now(), note: text }));
  const job = { entry, state: "starting", done: false, reply: null, asked: 0 };
  jobs.set(conversationId, job);
  const id = `email:${conversationId}:${clock.now()}`;
  restartGate.hold(id, { kind: "signin_email", site: entry.site });
  const startedAt = clock.now();
  let route = "emailed_code";
  // The one line every attempt leaves (src/signinlog.js): host, route, outcome class, timing.
  const OUTCOME = { signed_in: "signed_in", blocked: "blocked_by_site", google_only: "no_email_route", no_mail: "code_not_found", no_reply: "abandoned", wrong_code: "wrong_code", rejected: "email_rejected", no_route: "no_email_route" };
  const finish = (text, state, detail = "") => {
    job.done = true; job.state = state;
    restartGate.release(id);
    log({ signin_email: "ended", site: entry.site, state });
    logAttempt(entry, { route, outcome: OUTCOME[state] ?? "failed", startedAt, detail });
    if (text) { try { tell(conversationId, text); } catch { /* the log still says */ } }
  };
  // The page this attempt is on. Every later link for it opens THIS page: remembered in code
  // (src/signinpage.js, read back by src/tools.js signinSite), and named whole in each instruction
  // below, so nothing depends on a model retyping an address. On 2026-11-12 the instruction named
  // the bare site ("link.com") and the link opened Link's marketing home page.
  let where = entry.generic ? signinPage.pageOf(entry.signin_url) : "";
  if (where && !signinPage.isFrontPage(where)) signinPage.rememberSigninPage(conversationId, entry, where);
  const linkSite = () => (entry.generic && where && !signinPage.isFrontPage(where) ? where : entry.site);
  const run = (async () => {
    let browser = null;
    try {
      await closeBrowser(conversationId);
      browser = await launch({ conversationId, url: entry.signin_url });
      const page = browser.page;
      job.state = "requesting";
      const asked = await requestCode(page, entry, email, { conversationId, log, settleMs, formWaitMs });
      // A step line of its own (src/signinlog.js): whether the page showed its email box, and how
      // long it was given. On 2026-11-12 the only trace was "no_email_route, 1147 ms".
      const sawForm = Number.isFinite(asked.form_ms) && (asked.ok || asked.at != null);
      if (Number.isFinite(asked.form_ms)) {
        logStep(entry, { step: sawForm ? "form_found" : "form_not_found", route: "emailed_code", startedAt, waitedMs: asked.form_ms, pageUrl: (() => { try { return page.url(); } catch { return ""; } })(), detail: asked.followed ? "signin_link_followed" : "" });
      }
      // The page the form was found on (the site's own "Log in" link may have been followed to it).
      if (asked.where && !signinPage.isFrontPage(asked.where) && signinPage.onSite(asked.where, entry)) { where = asked.where; signinPage.rememberSigninPage(conversationId, entry, where); }
      log({ signin_email: "requested", site: entry.site, ok: asked.ok, state: asked.state });
      if (!asked.ok) {
        const pw = asked.state === "password";
        if (asked.state === "blocked") {
          // The site refused Reason's browser. Written down with today's date so nothing tries again
          // until it is old, and said as what it is: never a wrong email, never another address.
          const kind = asked.detail === "wall_before_form" ? "walled" : "refuses_after_email";
          if (asked.detail !== "rate_limited") findings.recordFinding(entry, { kind, why: asked.why });
          const w = findings.blockedWords(entry, { kind }, { instead: !social.isFoodApp(entry.site) && social.wallInstead(entry).say ? social.wallInstead(entry) : null });
          return finish(`the ${entry.label} email sign-in stopped: ${asked.why}. This is ${entry.label} blocking automated sign-in, NOT a wrong email. Nothing was saved. ${w.never} Say ONE honest line, like: "${w.say}" Then the best route left: ${w.instead}`, "blocked", asked.detail);
        }
        if (asked.state === "google_only") {
          return finish(`the ${entry.label} email sign-in could not start: ${asked.why}. There is no route Reason's browser can take there, and a sign-in link would only walk them into Google's refusal, so do not send one. Say ONE honest line, like: "${entry.label} only lets you in with Google, and Google won't let my browser sign in, so I can't get into ${entry.label} for you." Then offer what is left: an answer from their mail if ${entry.label}'s notices are there (gmail_search), or them doing it in their own browser. Never say you will use or press their Google login.`, "google_only", "google_only");
        }
        if (asked.state === "rejected") return finish(`the ${entry.label} email sign-in stopped: ${asked.why}. Nothing was saved. Ask them ONCE, in one plain line, which email their ${entry.label} account uses, then signin_email again with it. Never offer Google.`, "rejected");
        // No sign-in form anywhere Reason could reach: a link would only show them that same page
        // (a home page under "finish this step"), so none is sent and the line says what is true.
        if (asked.detail === "no_signin_page") {
          // A page that turned out not to be a sign-in page is not kept as "the page this sign-in is on".
          signinPage.forgetSigninPage(conversationId, entry);
          return finish(`the ${entry.label} email sign-in could not start: ${asked.why}. Reason cannot find where to sign in on ${entry.label}. Nothing was saved. Do NOT send a sign-in link: it would only show them a page with nothing to sign in to. Say ONE plain line, like: "I can't find where to sign in on ${entry.label}." If they know the address of its sign-in page, signin_email or signin_link takes that address as the site.`, "no_route", "no_signin_page");
        }
        return finish(`the ${entry.label} email sign-in could not ask for a code: ${asked.why}. Nothing was saved. Say it in ONE plain line${pw ? `, and offer the secure sign-in link (signin_link with site "${linkSite()}", no provider) where they can type their ${entry.label} password themselves` : `, and offer the secure sign-in link (signin_link with site "${linkSite()}", no provider)`}. Use that site value exactly as written: it is the page this sign-in is on. Never offer Google.`, "no_route", pw ? "wants_password" : "no_email_box");
      }
      job.state = "waiting_mail";
      const mail = await gmail(conversationId, entry, { since: asked.at });
      let got = mail?.found ? mail : null;
      log({ signin_email: "mail", site: entry.site, connected: !!mail?.connected, found: !!got, kind: got?.kind ?? "" });
      if (!got) {
        if (mail?.connected) {
          return finish(`${entry.label} was asked for a sign-in code for ${email}, but no mail from ${entry.label} reached their Gmail within ${Math.round(MAIL_WAIT_MS / 1000)} seconds. Nothing was saved. Say it in ONE plain line: what happened, and that a fresh code needs them to say go (signin_email). Never offer to try again; never say "check your email".`, "no_mail");
        }
        // No Gmail: they are asked once, and their reply comes straight here (takeCodeReply).
        job.state = "waiting_reply";
        const code = await new Promise((resolve) => {
          job.reply = resolve;
          job.asked += 1;
          tell(conversationId, `${entry.label} just emailed a sign-in code to ${email}, and their Gmail is not connected, so the code has to come from them. Ask for it in ONE plain line, like: "What's the code ${entry.label} just sent to ${email}?" Nothing else, and do not ask again: their reply goes to ${entry.label} without you.`);
          const t = setTimeout(() => resolve(null), replyWaitMs);
          t.unref?.();
        });
        if (!code) return finish(`the ${entry.label} sign-in waited ${Math.round(replyWaitMs / 60_000)} minutes for the code and none came. Nothing was saved. Do not chase them about it; if they bring it up, offer to start again (signin_email).`, "no_reply");
        got = { kind: "code", code };
      }
      if (got.kind === "link") route = "emailed_link";
      job.state = "entering";
      // Only into the site's own page (a mailed link is checked by openLink itself).
      if (got.kind !== "link" && !onSite(page, entry)) {
        got = null;
        log({ signin_email: "left_site", site: entry.site });
        return finish(`the ${entry.label} email sign-in stopped: the sign-in page was no longer on ${entry.label}'s own site, so the code was not entered anywhere. Nothing was saved. Say it in ONE plain line and offer the secure sign-in link (signin_link with site "${linkSite()}", no provider).`, "left_site");
      }
      const entered = got.kind === "link" ? await openLink(page, got.url, entry) : await enterCode(page, got.code, { on: asked.on ?? null });
      got = null; // the code is not kept a moment longer than it is needed
      if (!entered.ok) return finish(`the ${entry.label} sign-in got its code but could not use it: ${entered.why}. Nothing was saved. Say it in ONE plain line and offer the secure sign-in link (signin_link with site "${linkSite()}", no provider).`, "failed");
      if (entered.wrong) return finish(`the ${entry.label} sign-in entered the code and ${entry.label} said the code was wrong or expired. Nothing was saved. Say it in ONE plain line and offer to start again (signin_email asks ${entry.label} for a fresh code). Do not ask them to re-send the same code.`, "wrong_code");
      await backOutOfProvider(page, entry, conversationId, log);
      // Asked on the page this attempt was on, never one rebuilt from the site's bare name.
      const out = await check(page, conversationId, entry.site, { entry: signin.entryOnItsPage(conversationId, entry) });
      const state = out?.ok === false ? "unknown" : out?.state ?? "unknown";
      if (state === "signed_in") return finish(`they are signed in to ${entry.label} now: Reason asked ${entry.label} for a code, read it ${mail?.found ? "from their Gmail" : "from their reply"} and entered it, and ${entry.label} says signed in (${out.why ?? ""}). Tell them in one short line, like "You're in to ${entry.label}." and pick up whatever they wanted it for. Never mention a code or their email being read unless they ask.`, "signed_in");
      if (state === "signed_out") return finish(`the ${entry.label} email sign-in entered the code, but ${entry.label} still says NOT signed in (${out?.why ?? out?.error ?? ""}). Nothing is recorded as signed in. Say it in ONE plain line; a sign-in that was refused is not tried again on its own. Never offer to try again.`, state);
      // Unknown is said as unknown, and nothing is started again because of it: a second run would
      // only ask the site for another code and end on the same page.
      return finish(`the ${entry.label} email sign-in entered the code, but whether they are signed in is UNKNOWN: ${entry.label}'s page showed nothing that proves it either way (${out?.why ?? out?.error ?? ""}). Nothing is recorded as signed in. Say ONE plain line, like: "I entered the ${entry.label} code but I can't tell whether it signed you in." Do not start another sign-in or send a link on your own; signin_status with recheck asks the site again.`, state);
    } catch (e) {
      log({ signin_email: "error", site: entry.site, why: (e?.message ?? String(e)).split("\n")[0].slice(0, 160) });
      return finish(`the ${entry.label} email sign-in broke on Reason's side before it finished. Nothing was saved. Say so in one plain line, and that a new sign-in needs them to say go. Never offer to try again.`, "error");
    } finally {
      if (browser) await browser.close?.().catch?.(() => {});
    }
  })();
  job.run = run;
  return { ok: true, started: true, run };
}
