// The body: one real Chromium per conversation, in its own profile directory so logins stick.
// Playwright is imported lazily, so the rest of Reason runs fine on a machine where
// `npx playwright install chromium` was never run — the browser tools just say so.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";

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
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/i.test(e.message)) {
      throw new NoBrowser("Chromium is not downloaded on this machine. Run: npx playwright install chromium");
    }
    throw e;
  }
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
/* Runs inside the page. Browser globals only — Playwright serializes it across. */
/* eslint-env browser */
function snapshotInPage(maxChars) {
  const SEL = "a[href], button, input, select, textarea, [role=button], [role=link], [role=option], [role=tab], [role=checkbox], [role=radio], [onclick], summary";
  const labelFor = (el) => {
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
    const d = { ref, tag, name: labelFor(el).replace(/\s+/g, " ").slice(0, 120) };
    if (tag === "input" || tag === "textarea") {
      d.type = el.getAttribute("type") || "text";
      d.required = !!el.required;
      if (el.value) d.value = String(el.value).slice(0, 80);
    }
    if (tag === "select") {
      d.options = [...el.options].map(o => o.value).slice(0, 25);
      if (el.value) d.value = el.value;
    }
    if (tag === "a" && el.href) d.href = el.href.slice(0, 200);
    if (el.getAttribute("role")) d.role = el.getAttribute("role");
    out.push(d);
    if (n >= 150) break;
  }
  let text = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { title: document.title, url: location.href, text, text_truncated: truncated, elements: out };
}

/** Accessibility-ish snapshot: the page's visible text plus every interactive element with a ref. */
export async function snapshot(page, maxChars = 6000) {
  return await page.evaluate(snapshotInPage, maxChars);
}

/** The accessible name of one ref, used by the commit guard before a click goes through. */
export async function refName(page, ref) {
  return await page.evaluate((r) => {
    const el = document.querySelector(`[data-reason-ref="${r}"]`);
    if (!el) return null;
    const raw = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "") +
      " " + (el.getAttribute("name") || "");
    return raw.replace(/\s+/g, " ").trim();
  }, ref);
}

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
  return await page.evaluate((r) => {
    const el = document.querySelector(`[data-reason-ref="${r}"]`);
    if (!el) return null;
    const attr = (n) => el.getAttribute(n) || "";
    const name = ((attr("aria-label") || el.innerText || el.value || attr("title") || "") + " " + attr("name"))
      .replace(/\s+/g, " ").trim();
    const tag = el.tagName.toLowerCase();
    const type = (el.type || attr("type") || "").toLowerCase();
    return {
      tag,
      type,
      name,
      href: tag === "a" ? attr("href") : "",
      inForm: !!el.closest("form"),
      isSubmit: (tag === "button" && (type === "submit" || type === "")) || (tag === "input" && ["submit", "image"].includes(type)),
    };
  }, ref);
}

export function locate(page, ref) {
  return page.locator(`[data-reason-ref="${ref}"]`);
}
