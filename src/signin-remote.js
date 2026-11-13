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
// **How it is meant to feel (rebuilt 2026-10-05, after the first version was tried on a phone).**
// Open the link, see the site's sign-in page, tap the box, the phone's own keyboard comes up right
// there, type, tap the site's own button. There is no toolbar to learn and no "type here then
// send": every tap on a text box puts a REAL native input over that exact spot, so the keyboard
// opens inside the same tap and the phone can offer what it has saved. What is typed is forwarded
// into the site's field as it is typed, so the picture shows it landing where they tapped.
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
//   - no field's CONTENTS ever travel back. What the page is told about the site's fields is where
//     they are, what kind they are, their own label, and how many characters are in them — never a
//     character of what is in them. A password field is no different from any other in this: the
//     direction is one way;
//   - a password offered in a MESSAGE is still refused. That one is in the messaging app and the
//     transcript for good, which is a different thing from a relay that forgets.
//
// **Who can use a link.** The person themselves, first to tap Start, and nobody after: Start hands
// that browser a cookie and every later request needs it. Holding the link is not enough to tap
// Start (security audit lead 6, 2026-11-07): the browser must be one already signed in to Reason as
// this person (Web, or a connect/sign-in link's code, src/connectgate.js), or prove itself once with
// a code texted to their own thread, after which it is remembered — so a forwarded or misdirected
// link cannot open their saved profile. A link preview fetches the page but does not
// tap anything, so previews cannot take the session. A link is good for a few minutes, a session
// for a few more, and making a new link kills the old one.
//
// **What it cannot do.** Face ID, a passkey or a security key belong to the device doing the
// signing in, and that device is the machine, not the phone — so those will not work here and the
// page says so. A password, a code by text or email, and "is this you" taps all do.
import * as findings from "./sitefindings.js";
import { logAttempt, logStep } from "./signinlog.js";
import * as signinPage from "./signinpage.js";
import { FRAME_JS, fieldKind } from "./signinpage.js";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import * as db from "./db.js";
import * as signin from "./signin.js";
import * as social from "./socialsignin.js";
import * as emailRoute from "./signinemail.js";
import { readSignedInState } from "./sites.js";
import { profileDirFor, guardContext } from "./browser.js";
import * as restartGate from "./busy.js";
import { issueCode, trySubmittedCode, cookieHeader, codeHost, boundTo, CODE_TTL_MS, ATTEMPT_WINDOW_MS, MAX_CODES_SENT } from "./pages/access.js";
import { browserConversation, proofPage } from "./connectgate.js";
import { config, clock } from "./config.js";
import { backToReasonHref, dark, THEME, iconLinks } from "./pages/render.js";
import { securedCardTags } from "./pages/securedcard.js";
import { wordmark, WORDMARK_CSS } from "./pages/wordmark.js";
import { BRAND_PEN, BRAND_PEN_DARK, PAPER, PAPER_GRAIN, PAPER_GLOW, NIGHT_GLOW, GLOW_OFF, SHEET_BG } from "./pages/brand.js";
import { setupStartPage, setupLivePage, setupNativePage, nativeStepPanel, STEP_NEEDS_PAGE, setupResultPage, setupCodePage, setupGonePage, setupNoticePage, setupBackPage } from "./pages/setupsignin.js";

/** The picture the person sees. A phone held upright, at a size a desktop sign-in form fits in. */
export const VIEW = { width: 430, height: 700 };
export const PATH = "/s";
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const MAX_TYPED = 500;
const MAX_DEL = 500;
/** How many of the site's fields the page is told about. A sign-in form has one or two. */
const MAX_FIELDS = 12;
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** Where the page is scrolled to, and whether the page itself (not a box inside it) scrolls at all. */
const SCROLL_JS = `({ x: scrollX, y: scrollY, doc: (document.scrollingElement || document.documentElement).scrollHeight > innerHeight + 1 || (document.scrollingElement || document.documentElement).scrollWidth > innerWidth + 1 })`;
/** JPEG quality of a picture taken mid-scroll (a still one is 58). */
const MOVING_QUALITY = 40;
/** Two readings in a row before the session finishes itself, so one odd frame cannot end it. */
const SIGNED_IN_RUN = 2;
/** Nothing finishes itself in the first few seconds, when the site's own page is still settling. */
const EARLIEST_AUTO_FINISH_MS = 8_000;
/** How long a page that is not a sign-in page is left alone before the site's own "Log in" link is looked for. */
const LOOK_FIRST_MS = 2_500;

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
    // No launch flag that hides automation from the site (removed 2026-10-23): see src/browser.js.
    // Smooth scrolling off, and only that: a wheel otherwise animates for ~300 ms, so the picture
    // taken after a scroll showed the page before it had moved (measured 2026-11-10).
    args: ["--disable-smooth-scrolling"],
  });
  // Never this machine's own network, on every request — a link can name any site by its address.
  await guardContext(context);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.browserTimeoutMs);
  // The picture straight from the browser's compositor: about half the time of page.screenshot.
  // One compositor session per page, made when that page is first shown: a popup the session follows
  // (Notion's Google sign-in) is pictured itself, never the tab behind it (cold review, 2026-11-10).
  const cdps = new WeakMap();
  const shot = async (quality, pg = page) => {
    if (!cdps.has(pg)) cdps.set(pg, await context.newCDPSession(pg).catch(() => null));
    const cdp = cdps.get(pg);
    if (cdp) {
      try { return Buffer.from((await cdp.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true })).data, "base64"); } catch { /* the slower way below */ }
    }
    return pg.screenshot({ type: "jpeg", quality });
  };
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  return { page, shot, close: () => context.close().catch(() => {}) };
}

/** The same browser for the email sign-in (src/signinemail.js): their saved profile, headless, guarded. */
export const launchProfileBrowser = (args) => realLaunch(args);

export function remoteSigninStatus() {
  // The link a person taps lives on the website (heyreason.com/s/* is proxied to this server), else
  // the files domain, never the server's own address when either is set (owner rule, 2026-11-01).
  const base = (config.siteUrl || config.pagesUrl || config.publicUrl || `http://${config.host}:${config.port}`).replace(/\/+$/, "");
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

/** When the open link for this conversation was made (ms), or null: the web setup reads a stale, untapped link off it. */
export function remoteSessionSince(conversationId) {
  const s = sessions.get(byConversation.get(conversationId));
  return s && !s.ended ? s.createdAt : null;
}

/**
 * Make a link. Nothing is launched yet: the browser starts when somebody taps Start, so a link
 * nobody opens never holds the saved profile.
 */
export function createRemoteSignin({ conversationId, entry, afterSignedIn = "", onEnd = null, launch = realLaunch, check = signin.checkAndRecord, closeBrowser = async () => {}, busy = () => null, timers = { set: setTimeout, clear: clearTimeout }, log = () => {}, provider = "", offered = [], pressProvider = social.clickProviderButton }) {
  const old = sessions.get(byConversation.get(conversationId));
  if (old) end(old, "replaced").catch(() => {});

  const token = newToken();
  // `provider`: which button this site's account signs in through (google/apple/facebook/microsoft,
  // src/socialsignin.js). Only where that flag reaches this person: the button is pressed for them
  // when the page opens, and the provider goes on the saved-login row once the site says signed in.
  // Never Google (src/socialsignin.js NEVER_PRESSED): a link asked for Google opens on the site's email route.
  const prov = social.socialAllowedFor(conversationId) ? social.usableProvider(provider) : "";
  const s = {
    token, conversationId, entry, afterSignedIn, onEnd, launch, check, closeBrowser, busy, timers, log,
    provider: prov, pressProvider, pressed: "", lastFields: [],
    // The "Continue with" choices the intro page shows (src/socialsignin.js offeredFor); the one
    // tapped replaces `provider` at Start, and the email button clears it. None without the flag.
    offered: social.socialAllowedFor(conversationId) ? [...new Set([prov, ...(offered ?? []).map(social.usableProvider)].filter(Boolean))] : [],
    createdAt: clock.now(), secret: null, browser: null, queue: Promise.resolve(),
    ended: null, startedAt: null, timer: null, signedInRun: 0,
    // What the page's honesty and the step log hang off (src/signinpage.js): whether a real step
    // has been seen yet, the kind of page last seen, whether they have submitted anything, and
    // whether the site's own sign-in link has been tried. `tag` tells two sessions' log lines
    // apart: a hash, never the link.
    sawStep: false, kind: "", submitted: false, typed: false, opened: false, doorTried: false, lookSince: null, submits: 0,
    tag: createHash("sha256").update(`steplog:${token}`).digest("hex").slice(0, 8),
  };
  sessions.set(token, s);
  byConversation.set(conversationId, token);
  // A deploy restart must not cut this (src/busy.js; the gate is verify-reason/bin/idle.sh).
  restartGate.hold(token, { kind: "signin_link", site: entry.site });
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

/**
 * One line for one step of this session (src/signinlog.js): the site's host, the step, the kind of
 * page, timing since the link was made. Nothing typed, no address past its host, no conversation.
 * On 2026-11-12 a ten-minute session left only its summary line, and what the owner had been shown
 * had to be worked out afterwards.
 */
function step(s, name, extra = {}) {
  try { logStep(s.entry, { step: name, route: s.provider ? "provider" : "password_link", startedAt: s.createdAt, session: s.tag, ...extra }); } catch { /* a log line never breaks a sign-in */ }
}
/** They pressed something that sends the form on: Enter, Reason's own Continue, or a tap off the boxes after typing. */
function markSubmitted(s, how) {
  s.submitted = true;
  s.typed = false;
  s.submits += 1;
  if (s.submits <= 12) step(s, "submitted", { detail: how });
}
/**
 * What kind of page the browser is on (src/signinpage.js pageKind), noted on the session: the first
 * real step, the page a sign-in form was first seen on (so a later link opens there), and one log
 * line each time the kind changes.
 */
function noteKind(s, raw) {
  const kind = signinPage.pageKind(raw, { provider: s.provider, midFlow: s.sawStep });
  if (kind === "loading") return kind;
  if (signinPage.isStep(kind)) {
    if (!s.sawStep && kind === "signin_form" && s.entry.generic) { try { signinPage.rememberSigninPage(s.conversationId, s.entry, raw?.url); } catch { /* remembering is a help, never a requirement */ } }
    s.sawStep = true;
  }
  if (kind !== s.kind) {
    s.kind = kind;
    if (kind !== "signed_in") step(s, "page_kind", { kind, pageUrl: raw?.url });
  }
  return kind;
}
/** A link preview fetches the page without anybody having opened it. */
const PREVIEW_UA = /bot\b|facebookexternalhit|preview|crawler|spider|slurp|whatsapp|telegram|discord|skype|embedly/i;

/**
 * A site that opens its provider's page in a popup (Notion's "Continue with Google", seen live
 * 2026-11-10): the session follows it, so the picture and Reason's own panel show Google's page and
 * what is typed lands there; when the popup closes (Google hands back to the site), the session goes
 * back to the tab that opened it. The popup is in the same browser context, so the private-network
 * guard on every request (guardContext) covers it too. Nothing is navigated here — only followed.
 */
export const MAX_POPUPS = 4;
export function followPopups(s, page) {
  if (!page || typeof page.on !== "function") return;
  s.pages ??= [page];
  s.popups ??= 0;
  page.on("popup", (pop) => {
    if (s.ended || !s.browser) { pop.close?.().catch?.(() => {}); return; }
    // A site that keeps opening windows does not get to keep taking the session over.
    if (s.popups >= MAX_POPUPS) { pop.close?.().catch?.(() => {}); s.log({ signin_remote: "popup_refused", site: s.entry.site }); return; }
    s.popups += 1;
    s.pages.push(pop);
    s.browser.page = pop;
    s.log({ signin_remote: "popup_followed", site: s.entry.site });
    followPopups(s, pop);
    // Closed (Google handing back to the site): the newest page still open, never a closed one —
    // the opener may have closed first.
    pop.on("close", () => {
      s.pages = s.pages.filter(p => p !== pop && !(typeof p.isClosed === "function" && p.isClosed()));
      if (s.browser && s.browser.page === pop && s.pages.length) s.browser.page = s.pages.at(-1);
    });
  });
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
 * The check runs on every ending that had a browser — done, the site looking signed in, time
 * running out, a replacement — because a person who signed in and then put their phone down did
 * sign in, and the truth about that is on the site's account page, not in which button they
 * pressed or in what a screenshot looked like.
 */
async function end(s, how) {
  if (s.ended) return s.ended;
  s.ended = { how, state: null, why: "", at: clock.now() };
  restartGate.release(s.token);
  s.timers.clear(s.timer);
  const { conversationId: c, entry } = s;
  let note;
  if (how === "refused") {
    // The provider said no to Reason's browser. The account page is NOT asked and nothing is
    // recorded: this sign-in did not happen, and a check could only guess.
    const prov = s.refusal?.provider || s.provider;
    s.ended.state = "refused";
    s.ended.why = s.refusal?.why ?? "";
    s.ended.provider = prov;
    social.recordRefusal(c, entry.site, prov);
    if (s.browser) { try { await s.browser.close(); } catch { /* the note still goes */ } s.browser = null; }
    const a = social.refusalAnswer(entry, prov);
    note = `the ${entry.label} sign-in through ${social.LABELS[prov] ?? prov} stopped: ${s.ended.why}. Nothing was saved and it will not be tried again. Say it in ONE plain line, like: "${a.say}" ${a.instead}`;
  } else if (s.browser && how === "blocked") {
    // The site never showed its sign-in page: a bot check or a CDN refusal sat where the form
    // should have been. Asking the account page now would only say "signed out", which is true and
    // beside the point — the news is that this route does not reach this site from here.
    s.ended.state = "blocked";
    s.ended.why = `${entry.label} stopped Reason's browser with a bot check before its sign-in page loaded`;
    await s.browser.close();
    s.browser = null;
    note = `the ${entry.label} sign-in link you sent never got past ${entry.label}'s bot check: ${entry.label} blocks Reason's browser from its sign-in page, so nothing could be typed and nothing was saved, and a fresh link would hit the same wall. Say that plainly in one short line — it is ${entry.label}'s choice, not something they did — and offer what works instead${entry.deep_link ? ` (for a ride, uber_link opens Uber on their phone with the destination filled in)` : ""}${social.socialAllowedFor(c) ? ` — ${social.wallInstead(entry).tool}` : ""}.`;
  } else if (s.browser) {
    try {
      // Asked on the page this session's sign-in was on (the entry in hand), never a page rebuilt from the site's bare name.
      const out = await inTurn(s, () => s.check(s.browser.page, c, entry.site, { provider: s.provider, ...(entry.generic ? { entry } : {}) }));
      s.ended.state = out?.ok === false ? "unknown" : out.state;
      s.ended.why = out?.why ?? out?.error ?? "";
    } catch (e) {
      s.ended.state = "unknown";
      s.ended.why = (e?.message ?? String(e)).split("\n")[0];
    }
    await s.browser.close();
    s.browser = null;
    const tail = how === "done" || how === "finished" ? ""
      : how === "cancelled" ? " (they closed it without finishing)"
        : how === "replaced" ? " (a newer link replaced that one)"
          : how === "no_signin_page" ? " (no sign-in page was found)"
            : " (the link timed out before they finished)";
    // No link loops (owner, 2026-11-12: the session ran out and a third identical link went out).
    // An ending without progress gets ONE plain line and the next best route, and no new link made
    // by itself; src/tools.js signin_link refuses an identical one in a turn they did not start.
    const noProgress = signinPage.NO_PROGRESS.has(how);
    const mins = Math.max(1, Math.round((clock.now() - (s.startedAt ?? s.createdAt)) / 60_000));
    const route = `the next best route, in a few words: they can ask you for a fresh link when they have a couple of minutes, or do this part themselves in ${entry.label}'s own app or site and tell you when it is done`;
    const noLink = `Do NOT make another sign-in link now (no signin_link): a second identical link is not help, and none is made unless THEY ask for one.`;
    // A sign-in that went through a provider button: the row now says which, so the same login can
    // open the person's other sites through that provider (src/socialsignin.js RULES: say so once).
    const unlocked = s.ended.state === "signed_in" && s.provider
      ? ` Their ${entry.label} login is saved as ${s.provider === "apple" ? "an" : "a"} ${social.LABELS[s.provider]} sign-in${s.pressed ? "" : " (the site's own form had no such button, so this is what you were told rather than what was pressed)"}.`
        + ` After the task is done, say once what else that unlocks: any site of theirs that signs in with ${social.LABELS[s.provider]} can be opened the same way now without asking again.`
      : "";
    note = s.ended.state === "signed_in"
      ? `they finished signing in to ${entry.label} through the link you sent${tail}, and ${entry.label} says they ARE signed in now (${s.ended.why}). ${s.afterSignedIn ? s.afterSignedIn : `Tell them in one short line that it worked, and pick up whatever they wanted ${entry.label} for.`}${unlocked}`
      : how === "no_signin_page"
        ? `the ${entry.label} sign-in link you sent opened a page of ${entry.label}'s that is not a sign-in page, and Reason could not find a sign-in page from it, so they were shown no step and nothing was saved (${s.ended.why}). ${noLink} Say ONE plain line, like: "I can't find where to sign in on ${entry.label}." If they know the address of its sign-in page they can send it, and signin_link takes that address as the site.`
        // Replaced by a newer link and not signed in: the newer link is the one they have. There is
        // nothing to say about the old one, so the model is not woken for it at all.
        : how === "replaced"
          ? ""
          : noProgress && s.ended.state === "signed_out"
            ? `the ${entry.label} sign-in link you sent ended after about ${mins} minute${mins === 1 ? "" : "s"}${tail}${s.submitted ? "" : " with nothing submitted on it"}, and ${entry.label} says they are still NOT signed in (${s.ended.why}). Nothing was saved. ${noLink} Say ONE plain line that says what happened, like: "That ${entry.label} sign-in link ${how === "cancelled" ? "was closed" : "timed out"} before anything went through." Then ${route}. Or stop there.`
            : noProgress
              ? `the ${entry.label} sign-in link you sent ended after about ${mins} minute${mins === 1 ? "" : "s"}${tail}, and whether they are signed in is UNKNOWN: ${entry.label}'s page showed nothing that proves it either way (${s.ended.why}). Nothing is recorded either way. ${noLink} Say ONE plain line, like: "That ${entry.label} link ended and I can't tell whether you're signed in." signin_status with recheck asks the site again when they want it checked.`
              : s.ended.state === "signed_out"
                ? `the ${entry.label} sign-in through the link you sent has ended${tail}, and ${entry.label} says they are still NOT signed in (${s.ended.why}). Say that plainly in one short line and offer a fresh link in words; make one (signin_link) only once they say yes.`
                : `the ${entry.label} sign-in through the link you sent has ended${tail}, but whether they are signed in is UNKNOWN: it could not be read (${s.ended.why}). Nothing is recorded either way. Say that in one short line, as "I can't tell", not as signed out; signin_status with recheck asks the site again. Do not send another link on your own.`;
  } else if (how === "link_expired") {
    note = `the ${entry.label} sign-in link you sent was never opened and has expired. Do not chase them about it; if they bring it up, offer a fresh one.`;
  }
  s.log({ signin_remote: "ended", how, site: entry.site, conversation: c, state: s.ended.state });
  // The step log's last line, and what is remembered for the next link (src/signinpage.js): an
  // ending without progress is written down, so no second identical link goes out on its own.
  const expired = how === "timed_out" || how === "link_expired";
  step(s, s.ended.state === "signed_in" ? "signed_in" : expired ? "expired" : "ended", { detail: s.ended.state === "signed_in" ? "" : how === "link_expired" ? "never_opened" : String(how) });
  try {
    signinPage.noteEnding(c, entry, { how, state: s.ended.state ?? "", page: entry.signin_url });
    // A page that turned out not to be a sign-in page is not kept as "the page this sign-in is on".
    if (how === "no_signin_page" && signinPage.signinPageFor(c, entry) === signinPage.pageOf(entry.signin_url)) signinPage.forgetSigninPage(c, entry);
  } catch { /* the ending still stands */ }
  // A wall met by the link's own browser is a dated finding (src/sitefindings.js): no fresh link is
  // made into it until it is old enough to ask again.
  if (s.ended.state === "blocked") { try { findings.recordFinding(entry, { kind: "walled", why: s.ended.why }); } catch { /* the note still goes */ } }
  // One line per attempt that reached a browser (src/signinlog.js): host, route, outcome, timing.
  if (s.startedAt || s.ended.state) {
    const st = s.ended.state;
    const outcome = st === "signed_in" ? "signed_in" : st === "blocked" || st === "refused" ? "blocked_by_site"
      : how === "done" || how === "finished" || how === "no_signin_page" ? "failed" : "abandoned";
    logAttempt(entry, { route: s.provider ? "provider" : "password_link", outcome, startedAt: s.startedAt ?? s.createdAt, detail: st === "refused" ? "provider_refused" : st === "blocked" ? "wall_before_form" : how === "done" || how === "finished" ? "" : String(how) });
  }
  // Only news is worth a message. A link that was replaced unopened, or that simply lapsed, is not.
  // A web setup's sign-in (src/websetup.js) has no thread to wake: how it ended goes on the setup.
  if (s.onEnd) { try { s.onEnd(s.ended); } catch { /* the page reads the site's own check anyway */ } }
  else if (note && how !== "link_expired") db.createTimer(c, { fireAt: clock.now(), note });
  if (byConversation.get(c) === s.token) byConversation.delete(c);
  // Kept a little while so the page can show the result, then forgotten.
  const t = s.timers.set(() => sessions.delete(s.token), 10 * 60_000);
  t?.unref?.();
  return s.ended;
}

// ---------- reading the site's own page ----------

// What the page is told about the site's form (FRAME_JS) and which kind each box is (fieldKind) live
// in src/signinpage.js now, with what kind of page it is: the email sign-in and the check after a
// sign-in read pages the same way. Re-exported so nothing that imported them from here changes.
export { fieldKind };

/**
 * The hints the native box over that field is given.
 *
 * This is the whole reason the rebuild exists. A phone offers a saved login, or a code out of
 * Messages, only when the box it is looking at asks for one by name; the first version put
 * `autocomplete="off"` on a single password box, which told the phone to offer nothing at all.
 *
 * `type` is "text" rather than "email" or "tel" for the name boxes on purpose: Amazon's one box
 * takes a mobile number OR an email, and a `type="email"` box would refuse the number. The
 * keyboard is chosen with `inputmode`, which changes the keys without adding a rule.
 */
export function hintsFor(kind) {
  switch (kind) {
    case "password": return { slot: "p", type: "password", autocomplete: "current-password", inputmode: "", enterkeyhint: "go", autocapitalize: "off" };
    case "otp": return { slot: "o", type: "text", autocomplete: "one-time-code", inputmode: "numeric", enterkeyhint: "go", autocapitalize: "off" };
    case "email": return { slot: "u", type: "text", autocomplete: "username", inputmode: "email", enterkeyhint: "next", autocapitalize: "off" };
    case "tel": return { slot: "u", type: "text", autocomplete: "username", inputmode: "tel", enterkeyhint: "next", autocapitalize: "off" };
    case "username": return { slot: "u", type: "text", autocomplete: "username", inputmode: "text", enterkeyhint: "next", autocapitalize: "off" };
    case "number": return { slot: "g", type: "text", autocomplete: "off", inputmode: "numeric", enterkeyhint: "next", autocapitalize: "off" };
    case "search": return { slot: "g", type: "text", autocomplete: "off", inputmode: "search", enterkeyhint: "search", autocapitalize: "off" };
    default: return { slot: "g", type: "text", autocomplete: "on", inputmode: "text", enterkeyhint: "next", autocapitalize: "sentences" };
  }
}

/** Raw reading → what the phone is sent. Clamped, and carrying no content of any field. */
export function frameFor(raw = {}, { state = "working" } = {}) {
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, MAX_FIELDS).map(f => {
    const kind = fieldKind(f);
    const h = hintsFor(kind);
    return {
      x: round3(f.x), y: round3(f.y), w: round3(f.w), h: round3(f.h),
      k: kind, slot: h.slot, ty: h.type, ac: h.autocomplete, im: h.inputmode,
      ek: h.enterkeyhint, cap: h.autocapitalize,
      lb: String(f.label ?? "").slice(0, 60), len: Number(f.len) || 0,
      on: !!f.focused,
    };
  });
  const text = String(raw.text ?? "");
  // "There is nothing to show" is a state the page has to be able to say out loud, because the
  // first version could not and a person was left looking at a white rectangle.
  const blank = !raw.url || /^about:blank/.test(String(raw.url)) || (text.trim().length < 10 && fields.length === 0);
  return { fields, state, blank };
}
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Picture and page reading together, in one turn of the browser, so they always match. */
async function readView(s) {
  return inTurn(s, () => takeView(s));
}
/** The same reading, for a caller already holding the browser's turn (a scroll and its picture are one turn). */
async function takeView(s, { quality = 58 } = {}) {
  const page = s.browser.page;
  const shot = s.browser.shot ? await s.browser.shot(quality, page) : await page.screenshot({ type: "jpeg", quality });
  const raw = await page.evaluate(FRAME_JS).catch(() => ({ fields: [], url: "", text: "" }));
  // The shape of the last form the phone saw, so a typed code can be cleaned for the box it lands in.
  s.lastFields = Array.isArray(raw?.fields) ? raw.fields : [];
  return { shot, raw };
}

/**
 * What a typed text becomes when it is a code going into a code box. Anything else is typed as is.
 * The box is the focused one from the last view, or — when this edit came with a tap — the one
 * code box on the page, since the tap is what focuses it and the view has not caught up yet.
 */
export function cleanCodeFor(s, text, tapped = false) {
  if (!social.looksLikeCode(text)) return text;
  const fields = s?.lastFields ?? [];
  const otp = fields.filter(f => fieldKind(f) === "otp");
  const box = otp.find(f => f.focused) ?? (tapped && otp.length === 1 ? otp[0] : null);
  if (!box) return text;
  const numeric = box.type === "tel" || box.type === "number" || box.im === "numeric";
  return social.normalizeCode(text, { accepts: numeric ? "digits" : "any", max: Number(box.ml) || 0 }) || text;
}

/**
 * Does the site's CURRENT page look like a signed-in one? Read off what is already on screen —
 * the same rules the real check uses, but without navigating, because navigating mid-sign-in would
 * throw away the form the person is standing in.
 *
 * This only ever decides when to STOP. The claim that somebody is signed in still comes from
 * `end()` asking the site properly, on its own account page, after the browser stops being theirs.
 */
function looksSignedIn(s, raw) {
  // A page still showing somewhere to put a password or a name is a page mid-sign-in, whatever
  // else is written on it.
  const kinds = (raw.fields ?? []).map(fieldKind);
  const typing = kinds.some(k => k === "password" || k === "username" || k === "email" || k === "otp");
  if (s.entry.generic) {
    // A site with no playbook stops the session by itself only on positive evidence: they submitted
    // something, the browser has left the page the sign-in was on, and the page it is on now has a
    // log-out or account control. A page that merely lacks the words "sign in" (a marketing page,
    // an app's blank shell) is not that; then the session waits for them, or for the clock.
    if (typing || !s.submitted || !raw.acct) return false;
    return signinPage.isFrontPage(s.entry.signin_url) ? s.sawStep : signinPage.leftSigninPage(raw.url, s.entry);
  }
  const read = readSignedInState(s.entry, { url: raw.url, text: raw.text, status: null, error: null });
  return read.state === "signed_in" && !typing;
}

/**
 * Does the site's CURRENT page look like a wall rather than a form? Cloudflare's interstitial
 * ("Performing security verification … verifies you are not a bot"), CloudFront's refusal
 * ("Request blocked"), and the plain "Access Denied" page all read like this: a page with those
 * words on it and no box to type in. Seen for real on 2026-10-15, when the owner opened an Uber
 * link and watched the spinner. Like `looksSignedIn`, this only decides when to STOP — and it
 * waits for two readings in a row, because a challenge that clears in a second is not a wall.
 */
const WALL = [
  "performing security verification", "verify you are not a bot", "verifies you are not a bot",
  "checking your browser", "checking if the site connection is secure", "request blocked",
  "access denied", "the request could not be satisfied",
];
export function looksBlocked(raw) {
  const text = String(raw?.text ?? "").toLowerCase();
  if ((raw?.fields ?? []).length) return false;
  return WALL.some(w => text.includes(w));
}

const cookieName = (token) => `rs_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
function readCookie(headers, name) {
  for (const part of String(headers?.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// ---------- who may tap Start ----------
//
// The same proof connect links use (#358, src/connectgate.js): a browser signed in to Reason as this
// person through Web's own sign-in or a texted browser code. A right code here leaves that same
// `connect:` session on the browser (90 days, like pages), so the next sign-in link, or connect link,
// on it goes straight on. A new browser asks once; a browser that only holds the link never gets in.

/** Is this the person's own browser, proved the way connect links are? */
function provedOwner(s, headers) {
  return browserConversation(headers) === s.conversationId;
}

/** Codes and wrong guesses are counted per person, not per link, in the one table connect links use too. */
const gateFor = (s) => proofPage(s.conversationId, `${s.entry.label} sign-in`);

/** Text the person a code to their own thread, at most MAX_CODES_SENT in the window, and ask for it. */
function sendCode(s, tell, via = null) {
  if (typeof tell !== "function") {
    return { status: 403, headers: HTML(), body: setupNoticePage({ entry: s.entry, h1: "Open this on your own browser.", why: "This link only starts on a browser you've signed in to Reason on. Ask Reason for a fresh one.", card: cardKind(s.entry) }) };
  }
  const page = gateFor(s);
  if (db.pageCodesIssued(page.id, ATTEMPT_WINDOW_MS) >= MAX_CODES_SENT) {
    return codePage(s, { status: 429, via, error: `Reason has already texted you a code. Use that one, or try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60_000)} minutes.` });
  }
  const { id, code } = issueCode(page.id);
  const mins = Math.round(CODE_TTL_MS / 60_000);
  const line = `Your Reason code is ${code}, to start the ${s.entry.label} sign-in link on that browser. Good for ${mins} minutes. If that wasn't you, ignore this — nothing was opened.${boundTo(codeHost(remoteSigninStatus().base), code)}`;
  Promise.resolve()
    .then(() => tell(s.conversationId, line, { idempotencyKey: `scode:${cookieName(s.token)}:${id}` }))
    .catch((e) => s.log({ signin_remote: "code_text_failed", site: s.entry.site, why: (e?.message ?? String(e)).split("\n")[0] }));
  s.log({ signin_remote: "code_sent", site: s.entry.site, conversation: s.conversationId });
  return codePage(s, { status: 401, via });
}

/** Check a typed code. A right one proves this browser as the person's: `{ ok, cookie }` to remember it. */
function tryCode(s, typed, headers) {
  const tried = trySubmittedCode({ page: gateFor(s), code: typed });
  if (tried.ok) {
    s.log({ signin_remote: "browser_proved", site: s.entry.site, conversation: s.conversationId });
    return { ok: true, cookie: cookieHeader(tried.token, { path: "/", headers }) };
  }
  if (tried.reason === "rate_limited") {
    return { ok: false, status: 429, error: `Too many wrong codes. Try again in about ${Math.ceil(ATTEMPT_WINDOW_MS / 60_000)} minutes.` };
  }
  const left = tried.tries_left;
  return { ok: false, status: 401, error: `That code is not right.${left ? ` ${left} ${left === 1 ? "try" : "tries"} left.` : ""}` };
}

const HTML = (extra = {}) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", ...extra });
const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (status, body) => ({ status, headers: JSONH, body: JSON.stringify(body) });
const gone = () => ({ status: 404, headers: HTML(), body: setupGonePage() });

/**
 * One request to a sign-in link. Pulled out of the server like `pageRequest`, so the whole thing
 * is drivable without a socket and without a browser.
 *
 * A token that does not exist and a session somebody else already owns answer the same 404, so
 * the link space cannot be probed and a forwarded link tells its second reader nothing.
 */
export async function remoteRequest({ token, action = "", method = "GET", headers = {}, query = {}, readBody = async () => "", tell = null }) {
  const s = TOKEN.test(String(token ?? "")) ? sessions.get(token) : null;
  if (!s) return gone();
  const name = cookieName(s.token);
  const mine = s.secret && same(readCookie(headers, name), s.secret);
  // A web setup's link on a browser that is not the setup's own (no setup cookie, or a setup that has
  // run out): there is no thread and no code was ever texted, so never the code step — the way back
  // to the setup instead, before anything is started (src/pages/setupsignin.js setupBackPage).
  const toSetup = async (status = 403) => ({ status, headers: HTML(), body: setupBackPage({ entry: s.entry, back: await setupBack(s), card: cardKind(s.entry) }) });

  // ---------- the page ----------
  if (method === "GET" && action === "") {
    if (!s.opened && !s.ended && !PREVIEW_UA.test(String(headers?.["user-agent"] ?? ""))) { s.opened = true; step(s, "link_opened"); }
    if (s.ended) return { status: 200, headers: HTML(), body: await resultPage(s) };
    if (isSetup(s) && !s.secret && !provedOwner(s, headers)) return toSetup(200);
    if (!s.secret) return { status: 200, headers: HTML(), body: startPage(s) };
    if (!mine) return isSetup(s) ? toSetup(200) : gone();
    return { status: 200, headers: HTML(), body: livePage(s) };
  }

  // ---------- Start: this browser becomes the only one that can use the link ----------
  if (method === "POST" && action === "start") {
    if (s.ended) return gone();
    if (s.secret && !mine) return isSetup(s) ? toSetup() : gone();
    if (isSetup(s) && !s.secret && !provedOwner(s, headers)) { s.log({ signin_remote: "setup_unproved", site: s.entry.site }); return toSetup(); }
    let remember = null;
    if (!s.secret) {
      let form = null;
      // Holding the link is not enough (security audit lead 6, 2026-11-07): it opens the person's
      // whole saved profile, every site's session in it. The browser tapping Start must be the
      // person's own — a Reason session proved for this conversation — or prove the phone with a
      // code texted to their own thread, the same rule private pages and trips keep.
      if (!provedOwner(s, headers)) {
        // Only from this link's own page: a right code signs the browser in to Reason as this
        // person, and a page elsewhere posting someone's own code from a victim's browser would
        // plant that sign-in there (login CSRF), the hole #358 closed on connect links.
        // Loaded here, not at the top, for the same import-cycle reason as connectgate.js.
        const { sameOrigin } = await import("./pages/websignin.js");
        if (!sameOrigin(headers)) {
          s.log({ signin_remote: "cross_site_start", site: s.entry.site });
          return codePage(s, { status: 403, error: "This page has to be used directly. Open the link Reason texted again." });
        }
        form = new URLSearchParams(String((await readBody()) ?? ""));
        // Another tap may have claimed or ended it while the body was read.
        if (s.secret || s.ended) return gone();
        const via = chosenVia(s, form);
        const typed = form.get("code");
        if (typed === null || form.has("send")) return sendCode(s, tell, via);
        // An empty tap on Sign in is not a guess: it costs none of the few tries (review, 2026-11-10).
        if (!typed.trim()) return codePage(s, { status: 401, via, error: "Type the code Reason texted you first." });
        // Busy first, so a right code is not used up on a Start that cannot open anything.
        const busyNow = s.busy(s.conversationId);
        if (busyNow) return { status: 409, headers: HTML(), body: setupNoticePage({ entry: s.entry, h1: "Not right now.", why: busyNow, card: cardKind(s.entry) }) };
        const tried = tryCode(s, typed, headers);
        if (!tried.ok) return codePage(s, { status: tried.status, via, error: tried.error });
        remember = tried.cookie;
      } else {
        form = new URLSearchParams(String((await readBody()) ?? ""));
        if (s.secret || s.ended) return gone();
      }
      // The intro's "Continue with" tapped (or the email button): that is the button pressed.
      const via = chosenVia(s, form);
      if (via !== null && via !== s.provider) {
        s.log({ signin_remote: "provider_chosen", site: s.entry.site, provider: via || "email" });
        s.provider = via;
      }
      const blocked = s.busy(s.conversationId);
      if (blocked) return { status: 409, headers: HTML(), body: setupNoticePage({ entry: s.entry, h1: "Not right now.", why: blocked, card: cardKind(s.entry) }) };
      s.secret = newToken();
      s.startedAt = clock.now();
      step(s, "start_pressed");
      s.timers.clear(s.timer);
      s.timer = s.timers.set(() => { end(s, "timed_out").catch(() => {}); }, config.remoteSigninSessionMs);
      s.timer?.unref?.();
      try {
        // The saved profile can be in one browser at a time, and this one needs it.
        await s.closeBrowser(s.conversationId);
        s.browser = await s.launch({ conversationId: s.conversationId, url: s.entry.signin_url });
        followPopups(s, s.browser.page);
        // Their account on this site uses a provider: press that button so the page they see is the
        // provider's own, not a username box they would have to skip. A page with no such button is
        // left as it is — the person's form, as before — and nothing else is typed or pressed.
        if (s.provider) {
          const { pressed } = await inTurn(s, () => s.pressProvider(s.browser.page, s.provider)).catch(() => ({ pressed: "" }));
          s.pressed = pressed || "";
          s.log({ signin_remote: "provider_button", site: s.entry.site, provider: s.provider, pressed: !!s.pressed });
        }
      } catch (e) {
        s.log({ signin_remote: "launch_failed", site: s.entry.site, why: (e?.message ?? String(e)).split("\n")[0] });
        await end(s, "launch_failed");
        return { status: 500, headers: HTML(), body: await resultPage(s) };
      }
      s.log({ signin_remote: "started", site: s.entry.site, conversation: s.conversationId });
      restartGate.hold(s.token, { kind: "signin", site: s.entry.site });
    }
    const secure = /^https:/i.test(config.publicUrl || "") ? "; Secure" : "";
    const session = `${name}=${s.secret}; Path=${PATH}/${s.token}; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(config.remoteSigninSessionMs / 1000)}${secure}`;
    return {
      status: 303,
      headers: {
        Location: `${PATH}/${s.token}`, "Cache-Control": "no-store",
        // A browser that just proved itself with the code is remembered too, so the next link skips it.
        "Set-Cookie": remember ? [session, remember] : session,
      },
      body: "",
    };
  }

  // Everything below drives the browser, so it is this session's own browser or nothing.
  if (!mine) return gone();
  if (s.ended) return json(410, { ended: true, state: s.ended.state });
  if (!s.browser) return json(409, { error: "not started" });
  const page = s.browser.page;

  /**
   * The picture and the shape of the site's form, in one answer.
   *
   * One request rather than two, because the thing that broke the first version was a weak
   * connection and every extra round trip on a phone is another chance to stall. The body is
   * `[4 bytes: how long the JSON is][the JSON][the JPEG]`; when the picture has not changed since
   * the one the phone already has, the JPEG part is empty and only the JSON travels.
   */
  if (method === "GET" && action === "view") {
    let got;
    try { got = await readView(s); } catch (e) {
      return json(503, { why: (e?.message ?? String(e)).split("\n")[0].slice(0, 120) });
    }
    return viewAnswer(s, got, query?.h);
  }

  if (method === "POST") {
    let input = {};
    try { input = JSON.parse((await readBody()) || "{}"); } catch { return json(400, { error: "bad json" }); }
    const settle = () => new Promise(r => setTimeout(r, config.remoteSigninSettleMs));
    /** A point on the picture is only ever a fraction of it, so there is nowhere else it can land. */
    const point = (p) => {
      const x = Number(p?.x), y = Number(p?.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
      return [Math.round(x * VIEW.width), Math.round(y * VIEW.height)];
    };

    if (action === "tap") {
      const at = point(input);
      if (!at) return json(400, { error: "tap needs x and y between 0 and 1" });
      await inTurn(s, async () => { await page.mouse.click(at[0], at[1]); await settle(); });
      // A tap that is not on one of the site's boxes, after something was typed: its own button.
      if (s.typed && !(s.lastFields ?? []).some(f => input.x >= f.x - 0.01 && input.x <= f.x + f.w + 0.01 && input.y >= f.y - 0.01 && input.y <= f.y + f.h + 0.01)) markSubmitted(s, "tap");
      return json(200, { ok: true });
    }
    /**
     * A scroll answers with the picture it made, in the same turn of the browser: one round trip
     * per step instead of a post, a wait, and a separate /view (measured 2026-11-10: ~1.6 s from a
     * flick to the first moved picture, nothing at all moving under the finger). The phone moves
     * its last picture under the finger itself and sends what the finger did a frame at a time, so
     * this only has to say where the page really is. `q` is the phone's own count of its scrolls,
     * echoed back, so it knows which of what it sent the picture already shows.
     */
    if (action === "scroll") {
      const dy = Math.max(-2000, Math.min(2000, Math.round(Number(input.dy) || 0)));
      const dx = Math.max(-2000, Math.min(2000, Math.round(Number(input.dx) || 0)));
      const q = Math.max(0, Math.min(1e9, Math.trunc(Number(input.q) || 0)));
      let got, atEnd = false;
      try {
        got = await inTurn(s, async () => {
          const was = await page.evaluate(SCROLL_JS).catch(() => null);
          await page.mouse.wheel(dx, dy);
          // One frame of the site's own, so the picture is the page after the move, not before it.
          const now = await Promise.race([
            page.evaluate(`new Promise(r => requestAnimationFrame(() => r(${SCROLL_JS})))`).catch(() => null),
            new Promise(r => setTimeout(() => r(null), 150)),
          ]);
          // A picture while the page is moving is a lighter one: the eye cannot read a page in
          // motion, and on a weak signal the bytes ARE the delay. The sharp one comes from /view
          // once the page stops. (Same size, so it lines up; only the JPEG quality is lower.)
          const view = await takeView(s, { quality: MOVING_QUALITY });
          // The end of the page: the page itself scrolls and did not move. Read off where the page
          // is, never off the picture, which a blinking cursor or an ad changes on its own. A page
          // that scrolls a box of its own instead (no window scroll at all) is the picture's call.
          const hash = createHash("sha1").update(view.shot).digest("hex").slice(0, 16);
          if (was && now && was.x === now.x && was.y === now.y) atEnd = now.doc || hash === s.lastScrollHash;
          s.lastScrollHash = hash;
          return view;
        });
      } catch (e) {
        return json(503, { why: (e?.message ?? String(e)).split("\n")[0].slice(0, 120) });
      }
      // judge:false — two scroll answers 100 ms apart are not two readings of a page at rest: a
      // flick that pushes the form off screen must not count as "signed in" twice and end it.
      return viewAnswer(s, got, input.h, { sq: q, end: atEnd }, { judge: false });
    }
    if (action === "type") {
      // The one place a password passes through. It goes to the page and nowhere else: not to the
      // log, not to the database, not onto the session object, and not back in the response.
      //
      // Three things, in this order, so that one request is one edit as the person makes it:
      //   at   — put the cursor in this box first (the same clamped fraction a tap is)
      //   all  — clear what is in the box
      //   del  — rub out this many characters
      //   text — then type this
      const at = input.at === undefined ? null : point(input.at);
      if (input.at !== undefined && !at) return json(400, { error: "at needs x and y between 0 and 1" });
      const all = input.all === true;
      const del = Math.max(0, Math.min(MAX_DEL, Math.trunc(Number(input.del) || 0)));
      let text = typeof input.text === "string" ? input.text : "";
      if (text.length > MAX_TYPED) return json(400, { error: `type needs 1 to ${MAX_TYPED} characters` });
      // A verification code pasted the way it arrived — "G-123 456" — into a code box: the "G-", the
      // spaces and the dashes come off, and a numeric box gets digits only (src/socialsignin.js
      // normalizeCode). Only a code box, only where the social sign-in flag reaches this person; the
      // text is still never kept or logged. The last view's fields say which box is focused (or, when
      // a tap landed with this edit, which box is the only code box on the page).
      if (s.provider || social.socialAllowedFor(s.conversationId)) text = cleanCodeFor(s, text, !!at);
      if (!text && !del && !all && !at) return json(400, { error: `type needs 1 to ${MAX_TYPED} characters` });
      await inTurn(s, async () => {
        if (at) await page.mouse.click(at[0], at[1]);
        if (all) { await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); }
        for (let i = 0; i < del; i++) await page.keyboard.press("Backspace");
        if (text) await page.keyboard.type(text);
        await settle();
      });
      // That something was typed is kept (a yes or no); what was typed never is.
      if (text) s.typed = true;
      return json(200, { ok: true });
    }
    if (action === "key") {
      if (!KEYS.has(input.key)) return json(400, { error: "that key is not one of the few this sends" });
      await inTurn(s, async () => { await page.keyboard.press(input.key); await settle(); });
      if (input.key === "Enter" && s.typed) markSubmitted(s, "enter");
      return json(200, { ok: true });
    }
    if (action === "provider") {
      // The native chooser: press the site's own "Continue with <provider>" for them. Only the four
      // providers, only on a page that is theirs (checked above), only while the real page is still
      // the chooser, and nothing else is pressed.
      if (!nativeOn(s)) return json(400, { error: "not a provider" });
      // "Use my <site> email": the site's own email route (its "Continue with email" pressed, or its
      // email box already there). Google is never pressed.
      if (String(input.p ?? "") === "") {
        const { pressed, moved } = await inTurn(s, async () => {
          if (stepNow(s, await readRaw(page)).step !== "chooser") return { pressed: "", moved: true };
          const f = await page.evaluate(emailRoute.emailPage, "route").catch(() => ({ did: "", email: false }));
          return { pressed: f.did || (f.email ? "email box" : "") };
        }).catch(() => ({ pressed: "" }));
        if (moved) return json(409, { moved: true });
        if (pressed) { s.provider = ""; s.pressed = ""; s.emailRoute = true; }
        s.log({ signin_remote: "email_route", site: s.entry.site, pressed: !!pressed, native: true });
        return json(200, { ok: true, pressed: !!pressed });
      }
      const p = social.usableProvider(input.p);
      if (!p) return json(400, { error: "not a provider" });
      const { pressed, moved } = await inTurn(s, async () => {
        if (stepNow(s, await readRaw(page)).step !== "chooser") return { pressed: "", moved: true };
        return s.pressProvider(page, p);
      }).catch(() => ({ pressed: "" }));
      if (moved) return json(409, { moved: true });
      if (pressed) { s.provider = p; s.pressed = pressed; }
      s.log({ signin_remote: "provider_button", site: s.entry.site, provider: p, pressed: !!pressed, native: true });
      return json(200, { ok: true, pressed: !!pressed });
    }
    if (action === "relay") {
      // What was typed in Reason's own panel, into the real page's matching box, then Enter — all in
      // one turn of the browser, and only while the real page is still on the step the panel showed:
      // read before the click and again before Enter, so a page that moved on (a grant screen, "stay
      // signed in?") is never pressed by a relay. Only the person's own tap answers those (cold review,
      // 2026-11-10). The text goes to the page and nowhere else: not logged, not kept, not returned.
      const want = String(input.step ?? "");
      if (!nativeOn(s) || !RELAY_KINDS[want]) return json(400, { error: "not a relay step" });
      let text = typeof input.text === "string" ? input.text : "";
      if (!text || text.length > MAX_TYPED) return json(400, { error: `relay needs 1 to ${MAX_TYPED} characters` });
      const out = await inTurn(s, async () => {
        const raw = await readRaw(page);
        if (stepNow(s, raw).step !== want) return { moved: true };
        const f = (raw.fields ?? []).find(x => RELAY_KINDS[want].includes(fieldKind(x)));
        if (!f) return { nobox: true };
        if (want === "code") { s.lastFields = [{ ...f, focused: true }]; text = cleanCodeFor(s, text, true); }
        await page.mouse.click(Math.round((f.x + f.w / 2) * VIEW.width), Math.round((f.y + f.h / 2) * VIEW.height));
        await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
        await page.keyboard.type(text);
        text = "";
        await new Promise(r => setTimeout(r, Math.min(config.remoteSigninSettleMs, 400)));
        if (stepNow(s, await readRaw(page)).step !== want) return { sent: true, entered: false };
        await page.keyboard.press("Enter");
        await new Promise(r => setTimeout(r, config.remoteSigninSettleMs));
        return { sent: true, entered: true };
      });
      if (out.moved) return json(409, { moved: true });
      if (out.nobox) return json(409, { nobox: true });
      if (out.entered) markSubmitted(s, "enter"); else if (out.sent) s.typed = true;
      return json(200, { ok: true, entered: out.entered });
    }
    if (action === "back") {
      await inTurn(s, async () => { await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); await settle(); });
      return json(200, { ok: true });
    }
    if (action === "done" || action === "cancel") {
      const ended = await end(s, action === "done" ? "done" : "cancelled");
      return json(200, { ok: true, ended: true, state: ended.state });
    }
  }
  return json(404, { error: "not found" });
}

/**
 * The answer to /view, and to a scroll: the picture and the shape of the site's form, after the
 * same checks for a site that finished, refused the browser, or walled it.
 * `extra` rides along in the JSON (a scroll's `sq`).
 */
async function viewAnswer(s, got, h, extra = {}, { judge = true } = {}) {
  const settled = clock.now() - (s.startedAt ?? 0) > EARLIEST_AUTO_FINISH_MS;
  // A wall is read first, because a wall also reads as "no sign-in prompt on the page" — which
  // is exactly what `looksSignedIn` infers signed-in from. Uber's bot-check page has none of
  // Uber's sign-in words on it and no box, and the first version of this called that signed in.
  // The provider's own refusal of this browser ("This browser or app may not be secure"): ended at
  // once, nothing saved, nothing pressed again (src/socialsignin.js providerRefused).
  if (s.provider || social.socialAllowedFor(s.conversationId)) {
    const no = social.providerRefused(got.raw);
    // Google's "This browser or app may not be secure" (owner, 2026-11-11: the person never sees it):
    // backed out of — its popup closed, the site's sign-in page opened again on its email route — and
    // the fresh page is what goes back. Recorded as a refusal, so Google is not tried here again.
    // Apple's / Microsoft's refusal ends the link as before, once a back-out has already been tried.
    // At most twice: a site that keeps sending the browser back to Google ends as refused rather than
    // looping (cold review, 2026-11-11).
    if (no.refused && (s.backOuts ?? 0) < 2 && (no.provider === "google" || !s.backedOut) && social.socialAllowedFor(s.conversationId) && !s.backingOut) {
      s.backOuts = (s.backOuts ?? 0) + 1;
      s.backingOut = true;
      try {
        social.recordRefusal(s.conversationId, s.entry.site, no.provider);
        s.log({ signin_remote: "backed_out", site: s.entry.site, provider: no.provider });
        await inTurn(s, async () => {
          for (const p of s.pages ?? []) if (p !== s.pages[0]) await p.close?.().catch?.(() => {});
          s.pages = (s.pages ?? []).slice(0, 1);
          if (s.pages[0]) s.browser.page = s.pages[0];
          const pg = s.browser.page;
          await pg.goto?.(s.entry.signin_url, { waitUntil: "domcontentloaded", timeout: 45_000 })?.catch?.(() => {});
          await pg.waitForTimeout?.(1500)?.catch?.(() => {});
          await pg.evaluate(emailRoute.emailPage, "route").catch(() => null);
        });
        s.provider = ""; s.pressed = ""; s.backedOut = true; s.emailRoute = true;
        s.npKey = "";
      } finally { s.backingOut = false; }
      // The refusal picture never goes out: the fresh page (the site's email route) is read and sent
      // instead; if even that cannot be read, an empty answer and the next /view tries again.
      const fresh = await readView(s).catch(() => null);
      if (fresh && !social.providerRefused(fresh.raw).refused) return viewAnswer(s, fresh, h, extra, { judge });
      return json(200, { moved: true, backed_out: true });
    }
    if (no.refused) {
      s.refusal = no;
      const ended = await end(s, "refused");
      return json(200, { over: true, state: ended.state });
    }
  }
  // What kind of page this is, before anything is said about it: a real step, or not a sign-in page.
  const kind = noteKind(s, got.raw);
  // A site named only by its address, and the page that opened is not a sign-in page (a home page,
  // a marketing page): the person is never asked to "finish a step" on it. The page is given the
  // same bounded time to draw a form the emailed-code route gives; then the site's own "Log in" link
  // is followed ONCE; then the session ends and says plainly that no sign-in page was found.
  if (judge && s.entry.generic && !s.sawStep && kind === "not_signin") {
    s.lookSince ??= s.startedAt ?? clock.now();
    const waited = clock.now() - s.lookSince, bound = signinPage.formWaitMs();
    if (waited >= Math.min(bound, LOOK_FIRST_MS)) {
      // Already signed in on their saved profile: the page's own account control says so; the site is asked properly in end().
      if (got.raw?.acct) { const ended = await end(s, "finished"); return json(200, { over: true, state: ended.state }); }
      if (!s.doorTried) {
        const door = await inTurn(s, () => signinPage.followSigninDoor(s.browser.page, s.entry, { allowCurrentSite: true })).catch(() => ({ followed: false }));
        if (door.followed || waited >= bound) {
          s.doorTried = true;
          step(s, "signin_link_followed", { detail: door.followed ? "followed" : "none_found", pageUrl: got.raw?.url });
          s.log({ signin_remote: "signin_link_followed", site: s.entry.site, followed: !!door.followed });
        }
        if (door.followed) {
          s.lookSince = clock.now();
          s.npKey = "";
          const fresh = await readView(s).catch(() => null);
          if (fresh) return viewAnswer(s, fresh, h, extra, { judge });
          return json(200, { moved: true });
        }
      }
      if (waited >= bound) {
        const ended = await end(s, "no_signin_page");
        return json(200, { over: true, state: ended.state });
      }
    }
  }
  // Reason's own page: the step the real page is on and its panel ride along with every picture.
  extra = { ...extra, ...npFor(s, got.raw, kind) };
  // Only a picture of the page at rest says it is signed in or walled; a scroll's leaves the counts as they are.
  if (!judge) return frameAnswer(got, h, extra);
  const walled = looksBlocked(got.raw);
  if (!walled && looksSignedIn(s, got.raw) && settled) s.signedInRun += 1;
  else s.signedInRun = 0;
  if (s.signedInRun >= SIGNED_IN_RUN) {
    const ended = await end(s, "finished");
    return json(200, { over: true, state: ended.state });
  }
  // A wall where the form should be. Ended rather than left to spin, so the person is told the
  // truth instead of waiting on a page that will not change.
  if (walled && settled) s.blockedRun = (s.blockedRun ?? 0) + 1;
  else s.blockedRun = 0;
  if (s.blockedRun >= SIGNED_IN_RUN) {
    const ended = await end(s, "blocked");
    return json(200, { over: true, state: ended.state });
  }
  return frameAnswer(got, h, extra);
}
/**
 * Reason's own page (owner, 2026-11-10): which step the real page is on, and the branded panel for it,
 * so the phone shows native controls and a plain line rather than only the picture. Only where the
 * social sign-in flag reaches this person. Built from the step's own templates and the page's words —
 * never from anything typed: no field value is ever read (FRAME_JS carries none). The panel's HTML
 * travels only when the step changes.
 */
function npFor(s, raw, kind = signinPage.pageKind(raw, { provider: s.provider, midFlow: s.sawStep })) {
  if (!nativeOn(s)) return {};
  // A page still drawing is "opening", not a step to hand over to the picture.
  const blank = frameFor(raw).blank;
  let st = blank ? { step: "loading", provider: "", number: "", say: s.npSeen ? "Loading the next page…" : `Opening ${s.entry.label}…` } : stepNow(s, raw);
  // No phantom steps (owner, 2026-11-12: Link's marketing home page under "finish this step on the
  // page below"). A page with no form, no challenge and no provider prompt is not a step, whatever
  // its words read as. Before any step has been seen on a site named by its address, Reason is
  // still LOOKING for the sign-in page; anywhere else it is a page with nothing to fill in, shown
  // as exactly that.
  if (!blank && kind === "not_signin") {
    st = s.entry.generic && !s.sawStep
      ? { step: "looking", provider: "", number: "", say: `Looking for ${s.entry.label}'s sign-in page…` }
      : { step: "between", provider: "", number: "", say: `${s.entry.label} is showing a page with nothing to fill in.` };
  }
  if (!blank) s.npSeen = true;
  // Off a provider's page the machine says "The site"; the person knows it by its name.
  st.say = String(st.say ?? "").replace(/\bThe site\b/g, s.entry.label);
  const key = `${st.step}:${st.provider}:${st.number}:${(st.offered ?? []).join(",")}`;
  // `sum`: what the fold over the picture says when it is open. Only a real step says "finish this step".
  const np = { step: st.step, key, page: STEP_NEEDS_PAGE.has(st.step) || st.step === "between", say: st.say,
    ...(st.step === "between" ? { sum: "The page as it is now" } : {}),
    ...(key === s.npKey ? {} : { html: nativeStepPanel(st, { entry: s.entry }) }) };
  if (key !== s.npKey) s.log({ signin_remote: "step", site: s.entry.site, step: st.step, provider: st.provider || "" });
  s.npKey = key;
  return { np };
}
/** `[4 bytes: JSON length][JSON][JPEG]`, the JPEG left off when the phone already has that picture. */
function frameAnswer(got, h, extra = {}) {
  const hash = createHash("sha1").update(got.shot).digest("hex").slice(0, 16);
  const unchanged = String(h ?? "") === hash;
  const meta = { ...frameFor(got.raw), h: hash, same: unchanged, ...extra };
  const head = Buffer.alloc(4);
  const body = Buffer.from(JSON.stringify(meta), "utf8");
  head.writeUInt32BE(body.length, 0);
  return {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    body: Buffer.concat(unchanged ? [head, body] : [head, body, got.shot]),
  };
}

/** For tests, and for a shutdown that should not leave a browser holding somebody's profile. */
export async function endAllRemoteSignins(how = "shutdown") {
  await Promise.all([...sessions.values()].filter(s => !s.ended).map(s => end(s, how).catch(() => {})));
}
export function forgetAllRemoteSignins() { sessions.clear(); byConversation.clear(); }

// ---------- the pages ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The link card a session's pages carry: a site with its own card (Amazon: "Connect Amazon"), else the plain sign-in one. */
export const cardKind = (entry) => (entry?.site && SITE_CARDS.has(entry.site) ? entry.site : "signin");
const SITE_CARDS = new Set(["amazon"]);

export function shell(title, inner, { script = "", card = "signin" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${iconLinks()}
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="robots" content="noindex">
${securedCardTags(card)}
<title>${esc(title)}</title>
<script>${THEME.head}</script>
<style>
:root{color-scheme:light dark;--ground:${PAPER.ground};--bg:${PAPER.bg};--fg:${PAPER.ink};--mute:${PAPER.dim};--grain:${PAPER_GRAIN};--glow:${PAPER_GLOW};--card:${PAPER.card};--line:${PAPER.line};--soft:${PAPER.soft};--go:${PAPER.ink};--gofg:${PAPER.bg};--mark:${BRAND_PEN}}
${dark([["", `--grain:none;--glow:${NIGHT_GLOW};--ground:#0b0a09;--bg:#12110f;--fg:#f3efe8;--mute:#a39c91;--card:#1b1916;--line:#2c2924;--soft:#211f1b;--go:#f3efe8;--gofg:#12110f;--mark:${BRAND_PEN_DARK}`]])}
${GLOW_OFF}
*{box-sizing:border-box}body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;background:var(--grain) var(--ground);color:var(--fg)}
.bar{display:flex;align-items:center;gap:.45rem;padding:14px 16px 10px;color:var(--fg);font:500 1rem/1.2 ui-serif,"New York","Iowan Old Style",Georgia,serif}
${WORDMARK_CSS}
${THEME.css}
.sheet{background:${SHEET_BG};border-radius:1.5rem 1.5rem 0 0;min-height:100dvh}
main{max-width:460px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:8px 0 6px}.lead{color:var(--mute);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
ul{margin:0;padding-left:18px}li{margin:6px 0}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:10px 12px;min-height:44px}
button.go{background:var(--go);color:var(--gofg);border-color:var(--go);width:100%;font-weight:600}
.row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap}.row>*{flex:1}
input[type=text],input[type=password]{font:inherit;width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);min-height:44px}
.small{font-size:13px;color:var(--mute)}
/* The picture. Width of the phone, the shape of the browser behind it, so nothing is stretched. */
#stage{position:relative;width:100%;aspect-ratio:${VIEW.width}/${VIEW.height};border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}
#v{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:var(--card);color:var(--mute);font-size:15px;transition:opacity .2s}
#veil.off{opacity:0;pointer-events:none}
.spin{display:inline-block;width:18px;height:18px;margin-right:9px;border:2px solid var(--line);border-top-color:var(--mute);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-4px}
@keyframes sp{to{transform:rotate(360deg)}}
/* The real native boxes that sit on top of the site's own. Made to look like the box underneath. */
#f{position:absolute;inset:0;pointer-events:none;margin:0}
#f input{position:absolute;left:-9999px;top:0;width:10px;height:10px;min-height:0;padding:0 6px;margin:0;border:0;border-radius:3px;font:inherit;background:#fff;color:#000;pointer-events:auto;opacity:0;-webkit-appearance:none;appearance:none}
#f input.at{opacity:1;outline:2px solid ${BRAND_PEN};outline-offset:-2px}
header{display:flex;align-items:center;gap:10px;margin:2px 0 8px}
header h1{flex:1;margin:0;font-size:18px}
header button{min-height:38px;padding:7px 12px;font-size:14px;flex:none}
.foot{display:flex;gap:8px;margin:10px 0 4px}.foot button{flex:1;font-size:14px;min-height:42px}
</style></head><body>
<div class="bar">${wordmark()}</div>
<div class="sheet"><main>${inner}${THEME.markup}</main></div><script>${THEME.js}</script>${script}</body></html>`;
}

/**
 * Every link's pages are the paper store sign-in (src/pages/setupsignin.js). A web setup's sign-in
 * (src/websetup.js, conversation `websetup:<id>`) has no thread behind it, so its way on at the end
 * is back to the setup; a text thread's is back to Reason.
 */
export const isSetup = (s) => String(s?.conversationId ?? "").startsWith("websetup:");
/** The setup's connect screen on the site it was made on (loaded late: websetup.js reaches back here through amazonconnect.js). */
async function setupBack(s) {
  try { const ws = await import("./websetup.js"); return ws.backUrlFor(s.conversationId, s.entry.site); } catch { return `${(config.siteUrl || config.publicUrl || "").replace(/\/+$/, "")}/start/connect`; }
}

function startPage(s) {
  return setupStartPage({ entry: s.entry, action: `${PATH}/${s.token}/start`, offered: s.offered ?? [], mine: s.provider });
}

/** The code step, for a browser that is not the person's own proved one. The code went to their own thread. */
function codePage(s, { status = 401, error = "", via = null } = {}) {
  return { status, headers: HTML(), body: setupCodePage({ entry: s.entry, action: `${PATH}/${s.token}/start`, error, card: cardKind(s.entry), via }) };
}

/**
 * The intro's choice, from the Start post: a provider it offered, "" for the site's own email
 * button, or null when the post named none (an old page, or no choice was shown) — then the
 * provider the link was made with stands.
 */
function chosenVia(s, form) {
  if (!form || !form.has("via") || !(s.offered ?? []).length) return null;
  const v = social.providerKey(form.get("via"));
  return v && s.offered.includes(v) ? v : "";
}

/**
 * How it ended, and the way on.
 *
 * A setup goes back to its connect screen. A text thread ends with `backToReasonHref` rather than
 * "you can close this page": closing a tab tells Reason nothing, and the person who just signed in
 * is the one whose task is waiting on it. "Reason will text you" stays — both are true, and the
 * tap is the faster of the two.
 */
async function resultPage(s) {
  // A walled site's page says what still works (src/socialsignin.js wallInstead), where the flag reaches them.
  const instead = s.ended?.state === "blocked" && social.socialAllowedFor(s.conversationId) ? social.wallInstead(s.entry).say : "";
  if (isSetup(s)) return setupResultPage({ entry: s.entry, ended: s.ended, back: await setupBack(s), card: cardKind(s.entry), instead });
  return setupResultPage({ entry: s.entry, ended: s.ended, thread: { reply: backToReasonHref }, card: cardKind(s.entry), instead });
}

/**
 * The live page.
 *
 * Four things it must do that the first version did not:
 *
 *   1. Never sit blank and silent. Every request has a deadline, a failure is retried with a
 *      growing gap, and the covering panel says what is going on in a sentence. The thing that
 *      actually broke on the owner's phone was a single `/shot` that never came back: the old
 *      page had a `busy` flag it set before the fetch and cleared after, no timeout, and no
 *      message — so one stalled request on a weak signal left a white rectangle for good.
 *   2. Open the phone's own keyboard. A tap that lands on one of the site's boxes focuses a real
 *      native input, positioned over that box, INSIDE the same tap — never after a round trip,
 *      because iOS only opens the keyboard for a focus that happens inside the gesture. That is
 *      why the shape of the form is sent down with every picture: by the time a finger lands,
 *      the page already knows what is under it and does not have to go and ask.
 *   3. Let the phone offer what it has saved. Four real inputs live in one form, each with fixed
 *      hints — a name, a password, a one-time code, and a plain one. Whichever matches is moved
 *      over the box that was tapped. They are four rather than one because changing `type` on an
 *      input that already has the keyboard open is how you lose the keyboard.
 *   4. Carry what is typed into the site's box as it is typed. Each input remembers what the box
 *      behind it already has and sends only the difference, so a deletion is a deletion and not a
 *      retyping of the whole thing.
 *
 * These inputs are a window onto the site's form, never a form of Reason's own: they only ever
 * appear on top of a box the site itself drew, they have no action, and they submit nowhere.
 */
/** The panel's relay steps → the kinds of box (fieldKind) each one types into. */
const RELAY_KINDS = { email: ["email", "username", "tel"], password: ["password"], code: ["otp"] };
/** The real page's shape and words, read in the browser's turn (no picture). Carries no field value. */
const readRaw = (page) => page.evaluate(FRAME_JS).catch(() => ({ fields: [], url: "", text: "" }));
/** The step the real page is on now, the same reading /view gives the panel. */
const stepNow = (s, raw) => social.stepOf(raw, { provider: s.provider, fields: (raw?.fields ?? []).map(f => ({ k: fieldKind(f) })) });

/** Reason's own page for this person? Where the social sign-in flag reaches them (owner first). */
const nativeOn = (s) => social.socialAllowedFor(s.conversationId);

function livePage(s) {
  // A fresh page load starts the panel over (the first /view sends its HTML again).
  s.npKey = "";
  if (nativeOn(s)) return setupNativePage({ entry: s.entry, view: VIEW, step: { step: "loading", say: `Opening ${s.entry.label}…` }, script: liveScript(s) + nativeScript(), card: cardKind(s.entry) });
  return setupLivePage({ entry: s.entry, view: VIEW, script: liveScript(s), card: cardKind(s.entry) });
}

/**
 * Reason's own page, on top of the live script: swaps the branded panel as the real page moves (the
 * /view answer's `np`), and relays what is typed in the panel into the real page's matching box —
 * the same /type and /key the picture uses, so the same promise holds: the text goes to the page and
 * nowhere else, and the panel's box is emptied as soon as it is sent. Consent, the account picker,
 * a captcha and anything unknown open the picture ("Finish this step on the page below").
 */
function nativeScript() {
  return `(function(){
var B=location.pathname.replace(/\\/+$/,''),panel=document.getElementById('np-panel'),det=document.getElementById('np-page'),
    sum=det&&det.querySelector('summary'),msg=document.getElementById('msg'),key='',step='',fields=[];
var WANT={email:['email','username','tel'],password:['password'],code:['otp']};
function send(a,b){return fetch(B+'/'+a,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})})
  .then(function(r){if(r.status===404||r.status===410)location.reload();return r.json().catch(function(){return{}})})}
function openPage(on,why){if(!det)return;det.open=!!on;det.classList.toggle('forced',!!on);if(sum)sum.textContent=on?(why||'Finish this step on the page below'):'Show me the page'}
function box(){var ks=WANT[step]||[];for(var i=0;i<fields.length;i++)if(ks.indexOf(fields[i].k)>=0)return fields[i];return null}
function relay(){
  var inp=document.getElementById('np-in');if(!inp)return;var v=inp.value;if(!v)return;
  var f=box();
  if(!f){openPage(true,'Finish this step on the page below');msg.textContent="I can't see that box on the page yet — use the page below.";return}
  inp.value='';inp.blur();var g=document.getElementById('np-go');if(g)g.setAttribute('aria-busy','true');
  msg.textContent='Sending it on…';
  send('relay',{step:step,text:v}).then(function(j){v='';
    if(j&&j.moved){msg.textContent='The page moved on — here is where it is now.';return}
    if(j&&j.nobox){openPage(true);msg.textContent="I can't see that box on the page right now — use the page below.";return}
    msg.textContent=j&&j.entered===false?'Typed it in. The page changed before I pressed Continue — check below.':'Sent. Waiting for the next step…';
    if(j&&j.entered===false)openPage(true)});
}
function wire(){
  var c=panel.querySelectorAll('[data-via]');
  for(var i=0;i<c.length;i++)(function(b){b.addEventListener('click',function(){
    var p=b.getAttribute('data-via');
    if(!p){openPage(true,'Sign in with your email on the page below');return}
    b.setAttribute('aria-busy','true');msg.textContent='Opening '+b.textContent.replace('Continue with ','')+'…';
    send('provider',{p:p}).then(function(j){if(j&&j.moved){msg.textContent='The page moved on.';return}if(!j||!j.pressed){msg.textContent="That button isn't on the page right now — use the page below.";openPage(true)}})})})(c[i]);
  var g=document.getElementById('np-go');if(g)g.addEventListener('click',relay);
  var inp=document.getElementById('np-in');if(inp)inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();relay()}});
}
window.npStep=function(np,fl){
  fields=fl||[];
  if(np.html!==undefined&&np.key!==key){key=np.key;step=np.step;panel.innerHTML=np.html;wire();msg.textContent='';openPage(np.page,np.sum)}
  var say=document.getElementById('np-say');if(say&&np.say)say.textContent=np.say;
};
})();`;
}

/** The live page's script: the same for both frames, driving the ids both draw. */
function liveScript(s) {
  const base = `${PATH}/${s.token}`;
  const label = esc(s.entry.label);
  return `(function(){
var B=${JSON.stringify(base)},V=${JSON.stringify(VIEW)};
var v=document.getElementById('v'),stage=document.getElementById('stage'),veil=document.getElementById('veil'),
    msg=document.getElementById('msg'),tip=document.getElementById('tip'),dead=false;
var slots={u:document.getElementById('in-u'),p:document.getElementById('in-p'),o:document.getElementById('in-o'),g:document.getElementById('in-g')};
var SITE=${JSON.stringify(s.entry.label)},TIP='Tap the page and sign in the way you normally would.';
var fields=[],hash='',shown=false,misses=0,blank=false,lastTyped=null;

function say(t,spin){veil.innerHTML=(spin?'<span class="spin"></span>':'')+t;veil.className=t?'':'off'}
function over(){if(dead)return;dead=true;location.reload()}

// Every request has a deadline. A phone on a weak signal is the normal case, not the odd one, and
// a fetch with no deadline is how the picture died the first time.
function ask(path,opts,ms){
  var c=new AbortController(),t=setTimeout(function(){c.abort()},ms||12000);
  var o=opts||{};o.signal=c.signal;o.credentials='same-origin';
  return fetch(B+path,o).then(function(r){clearTimeout(t);if(r.status===404||r.status===410){over();throw new Error('over')}return r},
                              function(e){clearTimeout(t);throw e});
}
function post(a,b){return ask('/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})},12000)
  .then(function(){kick()},function(){})}

// ---------- the picture ----------
var timer=null,running=false,quickUntil=0;
function kick(){quickUntil=Date.now()+2500;schedule(0)}
function schedule(ms){if(dead)return;clearTimeout(timer);timer=setTimeout(pull,ms)}
function pull(){
  if(dead||running)return;
  // While a finger or a fling is moving the page, its own scrolls bring the pictures.
  if(scrolling()){schedule(150);return}
  running=true;
  var gen=sent;
  // Nine seconds is longer than a picture takes over a bad connection and short enough that a
  // request which is never coming back is given up on while somebody is still watching.
  ask('/view?h='+encodeURIComponent(hash),{},9000).then(function(r){
    if(r.status===503)throw new Error('no picture');
    var ct=r.headers.get('Content-Type')||'';
    if(ct.indexOf('application/json')===0)return r.json().then(function(j){if(j&&j.over){over()}throw new Error('ended')});
    // A picture asked for before a scroll began shows the page before it: not drawn.
    return r.arrayBuffer().then(function(b){if(gen===sent&&!scrolling())return draw(b)});
  }).then(function(){
    misses=0;
    // The panel comes off only once there is a real picture under it AND the site has drawn
    // something. Blank is a state the person is told about, not one they are shown.
    if(blank){say(SITE+" hasn't drawn anything on the page yet. Give it a moment, or tap Back.",true);shown=false}
    else if(v.src){shown=true;say('')}
    else {say('Opening '+SITE+'…',true)}
    schedule(Date.now()<quickUntil?120:1100);
  },function(){
    if(dead)return;
    misses++;
    if(misses>=2){
      say(shown?'Lost the connection to '+SITE+"'s page. Still trying…":'Still loading '+SITE+"'s page. This can be slow on a weak signal.",true);
      shown=false;
    }
    schedule(Math.min(600*misses,5000));
  }).then(function(){running=false},function(){running=false});
}
function unpack(buf){
  var d=new DataView(buf),n=d.getUint32(0);
  return {meta:JSON.parse(new TextDecoder().decode(new Uint8Array(buf,4,n))),jpeg:buf.byteLength>4+n?new Uint8Array(buf,4+n):null};
}
// The picture is decoded off screen first and swapped in with the shift that goes with it, in one
// frame, so a new picture never flashes at the old position.
function draw(buf,then){
  var p=unpack(buf),meta=p.meta;
  function apply(u){
    // A scroll's picture older than one already shown is dropped (two can be on the way at once).
    if(then&&then(meta,!!u)===false){if(u)URL.revokeObjectURL(u);return}
    hash=meta.h||hash;fields=meta.fields||[];blank=!!meta.blank;
    if(meta.np&&window.npStep)window.npStep(meta.np,fields);
    if(u){var old=v.src;v.src=u;if(old&&old.indexOf('blob:')===0)setTimeout(function(){URL.revokeObjectURL(old)},600)}
    place();
  }
  if(!p.jpeg){apply(null);return Promise.resolve()}
  var u=URL.createObjectURL(new Blob([p.jpeg],{type:'image/jpeg'})),im=new Image();
  im.src=u;
  return (im.decode?im.decode():Promise.resolve()).then(function(){apply(u)},function(){apply(u)});
}

// ---------- the real boxes, over the site's own ----------
// Measured off the picture itself, never off the frame around it: a field's position is a
// fraction OF the picture, and the frame's own border would shift every one of them.
// Without the shift a scroll gives the picture: the boxes move with it by their own transform.
function box(){var sr=stage.getBoundingClientRect();return {left:sr.left+stage.clientLeft+v.offsetLeft,top:sr.top+stage.clientTop+v.offsetTop,width:v.offsetWidth,height:v.offsetHeight}}
/** Put each native input over the site's box it matches, so an autofill of a pair lands in both. */
function place(){
  var r=box(),sr=stage.getBoundingClientRect(),ox=r.left-sr.left,oy=r.top-sr.top,used={};
  for(var k in slots){slots[k]._f=null}
  for(var i=0;i<fields.length;i++){
    var f=fields[i],el=slots[f.slot];
    if(!el||used[f.slot])continue;
    used[f.slot]=1;
    // A slot that has moved to a different box of the site's starts over, or the difference it
    // sends would be measured against a box that is no longer there.
    var key=f.slot+':'+f.k+':'+Math.round(f.y*1000);
    if(el._key!==key&&document.activeElement!==el){el._key=key;el._sent='';el.value='';el._fresh=true}
    el._f=f;
    el.style.left=(ox+f.x*r.width)+'px';el.style.top=(oy+f.y*r.height)+'px';
    el.style.width=(f.w*r.width)+'px';el.style.height=(f.h*r.height)+'px';
    el.style.fontSize=Math.max(16,Math.min(20,f.h*r.height*0.5))+'px';
    if(f.im)el.setAttribute('inputmode',f.im);else el.removeAttribute('inputmode');
    el.setAttribute('enterkeyhint',f.ek||'next');
    el.setAttribute('autocapitalize',f.cap||'off');
    if(f.lb)el.setAttribute('aria-label',f.lb);
  }
  // A box the site no longer shows is parked off screen so a stray tap cannot reach it.
  for(var k2 in slots){var e2=slots[k2];if(!e2._f&&document.activeElement!==e2){e2.style.left='-9999px';e2.classList.remove('at')}}
}
function at(nx,ny){for(var i=0;i<fields.length;i++){var f=fields[i];if(nx>=f.x-0.01&&nx<=f.x+f.w+0.01&&ny>=f.y-0.01&&ny<=f.y+f.h+0.01)return f}return null}

// ---------- scrolling: the picture follows the finger, the browser catches up ----------
// The last picture moves under the finger at once, every frame. What the finger did is added up
// and sent once a frame at most (two on the way at a time); each scroll comes back with the
// picture it made, and the shift still owed is whatever that picture does not show yet. A flick
// carries on after the finger lifts and slows the way a phone's own scroll does.
var pend={x:0,y:0},fly=[],sent=0,shownSq=0,drag=null,fling=null,raf=0;
function scrolling(){return !!(drag||fling||fly.length||pend.x||pend.y)}
function owed(){var x=pend.x,y=pend.y;for(var i=0;i<fly.length;i++){x+=fly[i].dx;y+=fly[i].dy}return {x:x,y:y}}
function shift(){
  var r=box(),o=owed(),k=r.width/V.width,tf=(o.x||o.y)?'translate('+(-o.x*k)+'px,'+(-o.y*k)+'px)':'';
  v.style.transform=tf;document.getElementById('f').style.transform=tf;
}
function loop(){
  raf=0;if(dead)return;
  var now=performance.now();
  if(fling){
    var dt=Math.min(48,now-fling.t);fling.t=now;
    pend.x+=fling.vx*dt;pend.y+=fling.vy*dt;
    var decay=Math.pow(0.996,dt);fling.vx*=decay;fling.vy*=decay;
    if(Math.abs(fling.vx)<0.03&&Math.abs(fling.vy)<0.03)fling=null;
  }
  // Less than a pixel left over once nothing is moving it is nothing: dropped, or the page would
  // count as scrolling for good and never fetch the sharp picture again.
  if(!fling&&!drag&&Math.abs(pend.x)<1&&Math.abs(pend.y)<1){pend.x=0;pend.y=0}
  if(fly.length<2&&(Math.abs(pend.x)>=1||Math.abs(pend.y)>=1))sendScroll();
  shift();
  if(scrolling())raf=requestAnimationFrame(loop);
  else kick();
}
function wake(){if(!raf)raf=requestAnimationFrame(loop)}
function sendScroll(){
  var dx=Math.max(-2000,Math.min(2000,Math.round(pend.x))),dy=Math.max(-2000,Math.min(2000,Math.round(pend.y)));
  pend.x-=dx;pend.y-=dy;if(!dx&&!dy)return;
  var q=++sent;fly.push({q:q,dx:dx,dy:dy});
  var done=function(){for(var i=fly.length-1;i>=0;i--)if(fly[i].q<=q)fly.splice(i,1);wake()};
  ask('/scroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dx:dx,dy:dy,q:q,h:hash})},9000).then(function(r){
    var ct=r.headers.get('Content-Type')||'';
    if(ct.indexOf('application/json')===0)return r.json().then(function(j){if(j&&j.over)over();done()});
    return r.arrayBuffer().then(function(b){
      return draw(b,function(meta,fresh){
        var sq=meta.sq||q;if(sq<shownSq)return false;shownSq=sq;
        // The page did not move: it is at its end (the server reads where the page is). What is still owed is dropped, so the picture
        // does not slide off and snap back over and over.
        if(meta.end){pend.x=pend.y=0;fling=null}
        for(var i=fly.length-1;i>=0;i--)if(fly[i].q<=sq)fly.splice(i,1);
        shift();
      });
    }).then(done,done);
  },done);
}
var sx=0,sy=0,moved=false,pid=null,halt=false;
function scale(){var r=box();return V.width/r.width}
stage.addEventListener('pointerdown',function(e){
  if(e.target!==v||!e.isPrimary)return;
  sx=e.clientX;sy=e.clientY;moved=false;pid=e.pointerId;
  // A finger on a moving page stops it, the way it does on the phone itself — and that touch is
  // only a stop, never a tap on the site: the picture under it is not where the page is yet.
  halt=scrolling();
  fling=null;
  drag={x:e.clientX,y:e.clientY,s:[{t:performance.now(),x:e.clientX,y:e.clientY}]};
  try{v.setPointerCapture(e.pointerId)}catch(err){}
},{passive:true});
stage.addEventListener('pointermove',function(e){
  if(!drag||e.pointerId!==pid)return;
  if(!moved&&(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10)){moved=true;blurAll();drag.x=e.clientX;drag.y=e.clientY}
  if(!moved)return;
  var k=scale(),now=performance.now();
  pend.x+=(drag.x-e.clientX)*k;pend.y+=(drag.y-e.clientY)*k;
  drag.x=e.clientX;drag.y=e.clientY;
  drag.s.push({t:now,x:e.clientX,y:e.clientY});while(drag.s.length>2&&now-drag.s[0].t>100)drag.s.shift();
  wake();
},{passive:true});
function release(e,flick){
  if(!drag||e.pointerId!==pid)return false;
  var d=drag;drag=null;pid=null;
  if(!moved){wake();return false}
  var a=d.s[0],b=d.s[d.s.length-1],dt=b.t-a.t,k=scale();
  if(flick&&dt>0&&performance.now()-b.t<80){
    var vx=(a.x-b.x)/dt*k,vy=(a.y-b.y)/dt*k,cap=8;
    vx=Math.max(-cap,Math.min(cap,vx));vy=Math.max(-cap,Math.min(cap,vy));
    if(Math.abs(vx)>0.15||Math.abs(vy)>0.15)fling={vx:vx,vy:vy,t:performance.now()};
  }
  wake();
  return true;
}
stage.addEventListener('pointercancel',function(e){release(e,false)},{passive:true});
// The paper page around the picture never scrolls under a finger that started on the picture.
stage.addEventListener('touchmove',function(e){if(drag)e.preventDefault()},{passive:false});
stage.addEventListener('pointerup',function(e){
  if(e.pointerId!==pid)return;
  if(release(e,true)||halt){halt=false;return}
  var r=box();
  var nx=(e.clientX-r.left)/r.width,ny=(e.clientY-r.top)/r.height,f=at(nx,ny);
  // Focus happens HERE, in the tap itself. Anything after an await is too late for iOS.
  if(f&&slots[f.slot]){
    var el=slots[f.slot];
    for(var k in slots)slots[k].classList.remove('at');
    el.classList.add('at');el.value='';el._sent='';el._at={x:nx,y:ny};el._fresh=true;
    el.focus();
    try{el.setSelectionRange(0,0)}catch(err){}
  } else { blurAll(); }
  post('tap',{x:nx,y:ny});
},{passive:true});
function blurAll(){for(var k in slots){slots[k].classList.remove('at');if(document.activeElement===slots[k])slots[k].blur()}}

// ---------- what they type, carried into the site's box as they type ----------
// Only the difference travels: the common start of old and new is left alone, what was rubbed out
// becomes a count of backspaces, and what is new becomes the characters. Nothing comes back.
function flush(el){
  if(!el._f)return;
  var val=el.value,was=el._sent||'',i=0;
  while(i<val.length&&i<was.length&&val[i]===was[i])i++;
  var body={del:was.length-i,text:val.slice(i)};
  // Put the cursor in the right box first whenever this is not the box last typed into. The phone
  // filling a saved login drops a name AND a password in at once, and the password one was never
  // tapped, so it has to say where it goes.
  if(lastTyped!==el||el._fresh){
    body.at=el._at||{x:el._f.x+el._f.w/2,y:el._f.y+el._f.h/2};
    if(el._fresh&&el._f.len>0)body.all=true;
    el._fresh=false;el._at=null;
  }
  if(!body.del&&!body.text&&!body.all&&!body.at)return;
  el._sent=val;lastTyped=el;
  post('type',body);
}
for(var k in slots){(function(el){
  el._sent='';el._f=null;
  var t=null;
  // A tap on a box that is already placed lands on the native input, not on the picture, so the
  // things that must happen when a box is entered hang off focus and not off the tap.
  el.addEventListener('focus',function(){
    for(var q in slots)if(slots[q]!==el)slots[q].classList.remove('at');
    el.classList.add('at');el._sent='';el._fresh=true;
    var f=el._f;
    tip.textContent=!f?TIP
      :f.k==='password'?'Tap Passwords above the keyboard to use your saved '+SITE+' login.'
      :f.k==='otp'?'Your code should appear above the keyboard.'
      :(f.lb||TIP);
  });
  el.addEventListener('input',function(){clearTimeout(t);t=setTimeout(function(){flush(el)},120)});
  el.addEventListener('blur',function(){clearTimeout(t);flush(el);el.classList.remove('at');tip.textContent=TIP});
  el.addEventListener('keydown',function(e){
    if(e.key!=='Enter')return;
    e.preventDefault();clearTimeout(t);flush(el);
    setTimeout(function(){post('key',{key:'Enter'})},200);
  });
})(slots[k])}
window.addEventListener('resize',place);
window.addEventListener('orientationchange',function(){setTimeout(place,300)});

// ---------- the few controls there are ----------
document.getElementById('back').onclick=function(){blurAll();post('back')};
document.getElementById('done').onclick=function(){blurAll();msg.textContent='Checking with ${label}…';dead=true;ask('/done',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},20000).then(function(){location.reload()},function(){location.reload()})};
document.getElementById('stop').onclick=function(){blurAll();msg.textContent='Closing…';dead=true;ask('/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},20000).then(function(){location.reload()},function(){location.reload()})};
say('<span class="spin"></span>Opening ${label}…');pull();
})();
`;
}
