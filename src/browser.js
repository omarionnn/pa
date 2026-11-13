// The body: one real Chromium per conversation, in its own profile directory so logins stick.
// Playwright is imported lazily, so the rest of Reason runs fine on a machine where
// `npx playwright install chromium` was never run — the browser tools just say so.
import { findProviderButton } from "./providerbutton.js";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";
import { isPrivateHost } from "./pictures.js";
import { publicUrl, allowPrivate } from "./netguard.js";
import * as signinPage from "./signinpage.js";
import { inPage, rememberPasswordBoxes } from "./pagesecrets.js";

const sessions = new Map(); // conversationId -> { context, page }
let playwright = null;

async function chromium() {
  if (!playwright) {
    try {
      playwright = await import("playwright");
    } catch {
      throw new NoBrowser("Playwright is not installed. Run: npm install");
    }
  }
  return playwright.chromium;
}

export class NoBrowser extends Error {}

/**
 * Where one person's logins live on disk.
 *
 * Exported because saved sign-ins need the SAME directory the errand browser will use: the whole
 * point is that the window Omari signs in to by hand and the headless one Reason drives later are
 * the same profile. Two functions that each worked out the path would be two functions that could
 * disagree, and the symptom would be a sign-in that silently did not take.
 */
export function profileDirFor(conversationId) {
  const dir = profilePath(conversationId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The same path, without creating anything.
 *
 * Separate from `profileDirFor` because that one makes the directory, and two callers want only to
 * talk about it: the delete, which must not conjure a profile into existence in order to report
 * having removed it, and the listing, which should not create a profile for a site nobody has ever
 * signed in to. The sanitising is here so both answers are the same string.
 */
export function profilePath(conversationId) {
  const safe = String(conversationId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return resolve(join(config.profileRoot, safe));
}

function profileDir(conversationId) {
  return profileDirFor(conversationId);
}

/** The live page for this conversation, launching Chromium the first time. */
export async function pageFor(conversationId) {
  const existing = sessions.get(conversationId);
  if (existing && !existing.page.isClosed()) return existing.page;

  const launcher = await chromium();
  let context;
  try {
    context = await launcher.launchPersistentContext(profileDir(conversationId), {
      headless: !config.browserHeaded,
      viewport: { width: 1280, height: 900 },
      // A service worker's requests do not pass the request guard below, so pages get none.
      serviceWorkers: "block",
      // No launch flag that hides automation from the site (removed 2026-10-23). A site that blocks
      // an automated browser gets a hand-back, never a workaround — the no-stealth rule in agent.js.
    });
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/i.test(e.message)) {
      throw new NoBrowser("Chromium is not downloaded on this machine. Run: npx playwright install chromium");
    }
    throw e;
  }
  // No request this browser makes reaches this machine's own network: a page (or a redirect, or a
  // script on it) pointing at 127.0.0.1, 169.254.169.254 or a name that resolves there is refused.
  // Every request by name; a page load also by its resolved addresses (security audit 2026-11-06).
  await guardContext(context);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.browserTimeoutMs);
  sessions.set(conversationId, { context, page });
  return page;
}

/**
 * The page this conversation already has open, or null — without launching anything.
 *
 * Separate from `pageFor` because one caller must not start a browser in order to look: the
 * furthest-point capture asks "is there a walk in progress to write down" on paths where the
 * answer is usually no, and `pageFor` would answer it by opening Chromium.
 */
export function openPage(conversationId) {
  const s = sessions.get(conversationId);
  if (!s || s.page.isClosed()) return null;
  return s.page;
}

export async function closeBrowser(conversationId) {
  const s = sessions.get(conversationId);
  sessions.delete(conversationId);
  await s?.context.close().catch(() => {});
}
export async function closeAllBrowsers() {
  await Promise.all([...sessions.keys()].map(closeBrowser));
}
export function openConversations() {
  return [...sessions.keys()];
}

// ---------- snapshots ----------
// Every interactive element gets a stable ref stamped onto the DOM, so the model can say
// "click e7" and the click lands on the thing the snapshot described.
//
// What a secret box holds never leaves the page (src/pagesecrets.js): a password, a one-time code, a
// card number or the like is reported as `secret: true, filled: true|false` and nothing else, and
// any copy of it the site printed elsewhere on the page is cut from the text, the names, the other
// boxes and the addresses before the reading is returned. `S` is those rules, handed in by `inPage`.
/* Runs inside the page. Browser globals only — Playwright serializes it across. */
/* eslint-env browser */
function snapshotInPage(S, maxChars) {
  const SEL = "a[href], button, input, select, textarea, [role=button], [role=link], [role=option], [role=tab], [role=checkbox], [role=radio], [onclick], summary";
  const labelFor = (el) => {
    // A secret box is never named by what is typed in it.
    if (S.kind(el)) return S.nameOf(el);
    const byAria = el.getAttribute("aria-label");
    if (byAria) return byAria.trim();
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.innerText.trim()) return lab.innerText.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    return (el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  document.querySelectorAll("[data-reason-ref]").forEach(el => el.removeAttribute("data-reason-ref"));
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el) || el.disabled) continue;
    const ref = "e" + (++n);
    el.setAttribute("data-reason-ref", ref);
    const tag = el.tagName.toLowerCase();
    const secret = S.kind(el);
    // Cut before it is shortened: a copy of a secret cut in half would no longer match and be kept.
    const d = { ref, tag, name: S.hide(labelFor(el).replace(/\s+/g, " ")).slice(0, 120) };
    if (tag === "input" || tag === "textarea") {
      d.type = el.getAttribute("type") || "text";
      d.required = !!el.required;
      if (secret) { d.secret = true; d.filled = !!el.value; }
      else if (el.value) d.value = S.hide(String(el.value)).slice(0, 80);
    }
    if (tag === "select") {
      d.options = [...el.options].map(o => S.hide(o.value)).slice(0, 25);
      if (secret) { d.secret = true; d.filled = !!el.value; }
      else if (el.value) d.value = S.hide(el.value);
    }
    if (tag === "a" && el.href) d.href = S.hideUrl(el.href).slice(0, 200);
    if (el.getAttribute("role")) d.role = el.getAttribute("role");
    out.push(d);
    if (n >= 150) break;
  }
  let text = S.hide(document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { title: S.hide(document.title), url: S.hideUrl(location.href), text, text_truncated: truncated, elements: out };
}
const SNAPSHOT = inPage(snapshotInPage);

/** Accessibility-ish snapshot: the page's visible text plus every interactive element with a ref. */
export async function snapshot(page, maxChars = 6000) {
  return await page.evaluate(SNAPSHOT, maxChars);
}

/**
 * The page's visible words and nothing else, with the same cut as the snapshot: no copy of what a
 * secret box holds. For every caller that reads a page's text without wanting its elements.
 */
export async function pageText(page, maxChars = 20_000) {
  return await page.evaluate(PAGE_TEXT, maxChars);
}
const PAGE_TEXT = inPage((S, maxChars) => S.hide(document.body ? document.body.innerText : "").slice(0, maxChars));

/** The address the page is on, as a reading may repeat it (see hideUrl in src/pagesecrets.js). */
export async function pageUrl(page) {
  return await page.evaluate(PAGE_URL).catch(() => "");
}
const PAGE_URL = inPage((S) => S.hideUrl(location.href));

/**
 * Is this ref a secret box, and which kind ("" when it is an ordinary one, null when there is no
 * such element)? For the tools that type: what goes into a secret box is never repeated back.
 */
export async function secretRef(page, ref) {
  return await page.evaluate(SECRET_REF, ref);
}
const SECRET_REF = inPage((S, r) => {
  const el = document.querySelector(`[data-reason-ref="${r}"]`);
  return el ? S.kind(el) : null;
});

/**
 * Before a picture of the page is taken: marks every secret box, so the picture can cover them
 * (`mask` below). A password box draws dots, but one switched to "show" draws the password.
 */
export async function secretBoxesToMask(page) {
  await page.evaluate(MARK_SECRETS).catch(() => {});
  return [page.locator("[data-reason-secret]")];
}
const MARK_SECRETS = inPage((S) => {
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (S.kind(el)) el.setAttribute("data-reason-secret", "1"); else el.removeAttribute("data-reason-secret");
  }
});

/**
 * The real photo URLs on the page that is open, not icons or layout graphics.
 *
 * Same principle as imageUrls in weblookup.js — these are the addresses something really published,
 * not guessed — but running inside the browser where JS has loaded, so a page that builds its
 * gallery in React still hands back real image URLs. Anything smaller than 100×100 is skipped.
 */
export async function pageImages(page, max = 20) {
  return page.evaluate((max) => {
    const seen = new Set();
    const out = [];
    for (const img of document.querySelectorAll("img")) {
      const src = img.currentSrc || img.src;
      if (!src || !src.startsWith("https://")) continue;
      if (img.naturalWidth < 100 || img.naturalHeight < 100) continue;
      if (seen.has(src)) continue;
      seen.add(src);
      out.push({ url: src, alt: (img.alt || "").slice(0, 120), width: img.naturalWidth, height: img.naturalHeight });
      if (out.length >= max) break;
    }
    return out;
  }, max);
}

/**
 * Park a page that is sitting on a navigation which failed, so the NEXT one is not poisoned by it.
 *
 * There is one Chromium page per conversation and it is reused all day, which is the whole point of
 * it — the sign-ins and the cookies live there. The cost is that a `goto` which did not arrive
 * leaves the tab on `chrome-error://chromewebdata/` with a navigation Chromium still considers
 * in flight, and the next `goto` on that same page comes back with "Navigation to … is interrupted
 * by another navigation" — an error about the LAST page, reported against the new one.
 *
 * That is how a site refusing turns into a lie: Delta's check-in page refuses, Reason says so
 * honestly, and then the next thing it is asked to open comes back "would not load" having never
 * been tried. So every place that catches a failed navigation calls this, and the tab goes back to
 * a blank page it can leave cleanly. Deliberately swallows its own failure: this is tidying up
 * after an error that has already been reported, and a second error on top of it says nothing new.
 */
export async function settle(page, { timeout = 5_000 } = {}) {
  try {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout });
    return true;
  } catch {
    // The goto gave up; the navigation it asked for may not have. On a loaded machine the blank
    // page can commit AFTER this goto's own timeout — and if this returned now, that late commit
    // landed in the middle of whatever the caller opened next, which then came back "interrupted
    // by another navigation to about:blank" (#279: a signed-in person told they were signed out).
    // So whatever is still pending is cancelled before the tab is handed back. This is CDP's
    // Page.stopLoading, not `window.stop()`: a navigation the browser started (every `goto`) is
    // not the page's to cancel, and a tab already sitting on about:blank cannot tell its old blank
    // page from the one still on the way, so waiting for the URL would prove nothing.
    await stopLoading(page);
    return false;
  }
}

/** Cancel every navigation still pending on the tab. Never throws, never hangs past `ms`. */
async function stopLoading(page, ms = 3_000) {
  const stop = (async () => {
    const cdp = await page.context().newCDPSession(page);
    try { await cdp.send("Page.stopLoading"); } finally { await cdp.detach().catch(() => {}); }
  })().catch(() => {});
  let timer;
  await Promise.race([stop, new Promise(r => { timer = setTimeout(r, ms); timer.unref?.(); })]);
  clearTimeout(timer);
}

/** The accessible name of one ref, used by the commit guard before a click goes through. */
export async function refName(page, ref) {
  return await page.evaluate(REF_NAME, ref);
}
// A secret box is named by its label, never by what is typed in it (src/pagesecrets.js).
const REF_NAME = inPage((S, r) => {
  const el = document.querySelector(`[data-reason-ref="${r}"]`);
  if (!el) return null;
  const raw = (S.kind(el) ? S.nameOf(el) : (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "")) +
    " " + (el.getAttribute("name") || "");
  return S.hide(raw.replace(/\s+/g, " ").trim());
});

/**
 * What an element actually IS, as opposed to what anyone says about it.
 *
 * This exists because the commit guard used to read the model's own description of a click, which
 * meant the model's wording decided whether the owner got asked. A page that labels its time
 * slots with a /reserve link, and a model that writes "reserve the 8pm slot", between them turned
 * a navigation into a commit and spent a yes on opening a form. What a click does is a property
 * of the element, so the element is what gets inspected.
 */
export async function describeRef(page, ref) {
  return await page.evaluate(DESCRIBE_REF, ref);
}
const DESCRIBE_REF = inPage((S, r) => {
  const el = document.querySelector(`[data-reason-ref="${r}"]`);
  if (!el) return null;
  const attr = (n) => el.getAttribute(n) || "";
  const secret = S.kind(el);
  const name = S.hide(((secret ? S.nameOf(el) : (attr("aria-label") || el.innerText || el.value || attr("title") || "")) + " " + attr("name"))
    .replace(/\s+/g, " ").trim());
  const tag = el.tagName.toLowerCase();
  const type = (el.type || attr("type") || "").toLowerCase();
  return {
    tag,
    type,
    name,
    href: tag === "a" ? S.hideUrl(attr("href")) : "",
    inForm: !!el.closest("form"),
    isSubmit: (tag === "button" && (type === "submit" || type === "")) || (tag === "input" && ["submit", "image"].includes(type)),
    ...(secret ? { secret } : {}),
  };
});

export function locate(page, ref) {
  return page.locator(`[data-reason-ref="${ref}"]`);
}

/**
 * The private-network guard, on any browser context Reason launches: no request reaches this
 * machine's own network — a page, a redirect or a script pointing at 127.0.0.1, 169.254.169.254 or
 * a name that resolves there is refused. Every request by name; a page load also by its resolved
 * addresses (security audit 2026-11-06). Shared with the sign-in browsers (src/signin-remote.js,
 * src/signin-cli.js), which since 2026-11-10 can be pointed at any site by its address.
 */
export async function guardContext(context) {
  // And on every one of them: a box that was ever a password box stays one for the life of its page,
  // whatever a "show password" switch turns it into (src/pagesecrets.js).
  await rememberPasswordBoxes(context);
  await context.route("**/*", async (route) => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch { return route.continue(); }
    if (allowPrivate() || !/^(https?|wss?):$/.test(u.protocol)) return route.continue();
    if (isPrivateHost(u.hostname)) return route.abort("blockedbyclient");
    if (req.isNavigationRequest() && !(await publicUrl(u.href)).ok) return route.abort("blockedbyclient");
    return route.continue();
  });
}

/**
 * One page's button and link labels, read in a throwaway headless browser — no profile, no cookies,
 * nobody's errand page — under the same private-network guard. For reading which "Continue with"
 * buttons a site's sign-in page draws (src/tools.js signin_link, signin_provider infer). Bounded:
 * never longer than `timeoutMs` in all, and always closed.
 */
export async function readPageLabels(url, { timeoutMs = 20_000, settleMs = 2000 } = {}) {
  const launcher = await chromium();
  const b = await launcher.launch({ headless: true });
  let timer;
  try {
    const work = (async () => {
      const ctx = await b.newContext({ viewport: { width: 430, height: 900 } });
      await guardContext(ctx);
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForTimeout(settleMs);
      // Every control's label, with false provider buttons left out: a footer "Facebook" link to the
      // site's social page is not a sign-in button (src/providerbutton.js).
      return await page.evaluate(findProviderButton, { labels: true });
    })();
    const cap = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); });
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
    await b.close().catch(() => {});
  }
}

/**
 * Where a site's sign-in page is, found the way a person would find it: the address is opened in a
 * throwaway guarded browser (never anybody's own profile), a sign-in form is waited for, and when
 * the page that opened is not a sign-in page the site's own "Sign in" / "Log in" link is followed
 * once (src/signinpage.js arriveAtSignin). For a site known only by its bare name, BEFORE a link is
 * made: on 2026-11-12 a link for "link.com" showed the owner Link's marketing home page.
 * Bounded, and always closed. Nothing is typed and nothing but that one link is pressed.
 *   → { found, url (origin + path), kind, followed, ms }
 */
export async function locateSigninPage(entry, { timeoutMs = 40_000 } = {}) {
  const launcher = await chromium();
  const b = await launcher.launch({ headless: true });
  let timer;
  try {
    const work = (async () => {
      // A desktop's width: at a phone's, a site folds its "Log in" link into a menu.
      const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
      await guardContext(ctx);
      const page = await ctx.newPage();
      await page.goto(entry.signin_url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const at = await signinPage.arriveAtSignin(page, entry, { allowCurrentSite: true });
      return { found: signinPage.isStep(at.kind), url: at.page, kind: at.kind, followed: at.followed, ms: at.ms };
    })();
    const cap = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); });
    return await Promise.race([work, cap]);
  } finally {
    clearTimeout(timer);
    await b.close().catch(() => {});
  }
}
