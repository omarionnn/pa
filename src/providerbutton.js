// Which controls on a page are really a provider's sign-in button. Runs inside the page: browser
// globals only, no imports — Playwright serialises the function's source across.
//
// Why (probe, 2026-11-12): Marriott's footer has a "Facebook" link to its Facebook page, and the old
// finder — any visible control whose label names the provider — read it as "Continue with Facebook".
// A control is a provider sign-in button only when one of these holds:
//   - where it goes is the provider's own sign-in endpoint (accounts.google.com, appleid.apple.com,
//     facebook.com/…/dialog/oauth, login.microsoftonline.com …) or the site's own handoff to it
//     (/auth/facebook, /login/google, /oauth/…?provider=apple);
//   - its label is sign-in words ("Continue with Facebook") and it is not in the footer, not in a
//     share/follow strip, and not a link out to somewhere that is not a sign-in endpoint;
//   - its label is the bare name ("Google") AND it sits in the sign-in form or dialog, or beside the
//     page's email/password box.
// A link to the provider's own site that is not a sign-in endpoint (facebook.com/marriott, an App
// Store badge) is never one, whatever it is called.

/* eslint-env browser */
/**
 * `arg` is the provider to press ("apple") — the first real button for it is clicked and its label
 * returned, "" when there is none — or `{ labels: true }`, which presses nothing and returns every
 * control's label with the false provider buttons left out (for reading which buttons a page offers).
 */
export function findProviderButton(arg) {
  var labelsOnly = !!(arg && typeof arg === "object" && arg.labels);
  var want = labelsOnly ? "" : String(arg || "").toLowerCase();
  if (!labelsOnly && !want) return "";
  var NAMES = ["google", "apple", "facebook", "microsoft"];
  var AUTH = {
    google: /accounts\.google\.com|google\.com\/o\/oauth|googleapis\.com\/.*oauth/i,
    apple: /appleid\.apple\.com|idmsa\.apple\.com/i,
    facebook: /facebook\.com\/(v\d+(\.\d+)?\/)?(dialog\/oauth|login(\.php)?\b)/i,
    microsoft: /login\.(microsoftonline|live|microsoft)\.com/i,
  };
  var HANDOFF = /oauth|openid|\/auth\b|\/sso\b|\/login\b|\/signin\b|\/sign-in\b|\/connect\b|\/social\b|[?&](provider|connection|idp|strategy)=/i;
  function vis(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) return false;
    var cs = window.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function labelOf(el) {
    return ((el.innerText || el.value || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("data-provider") || "")).replace(/\s+/g, " ").trim().toLowerCase();
  }
  function target(el) {
    var t = el.getAttribute("href") || el.getAttribute("formaction") || "";
    if (!t && el.form && /submit/i.test(el.type || "")) t = el.form.getAttribute("action") || "";
    return t;
  }
  function offSite(t) {
    try { var u = new URL(t, location.href); return /^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, "") !== location.hostname.replace(/^www\./, ""); } catch (e) { return false; }
  }
  function inChrome(el) {
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      var tag = (p.tagName || "").toLowerCase();
      if (tag === "footer" || p.getAttribute("role") === "contentinfo") return true;
      var mark = ((typeof p.className === "string" ? p.className : "") + " " + (p.id || "") + " " + (p.getAttribute("aria-label") || "")).toLowerCase();
      if (/(^|[^a-z])(footer|share|sharing|follow(ing)?([-_ ]us)?)([^a-z]|$)|social[-_ ]?(links?|media|icons?|nav|bar|follow|share|networks?|channels?|profiles?)/.test(mark)) return true;
    }
    return false;
  }
  function inSigninForm(el) {
    if (el.closest && el.closest('form,dialog,[role="dialog"],[aria-modal="true"]')) return true;
    var p = el.parentElement;
    for (var up = 0; p && up < 6; up++, p = p.parentElement) {
      var boxes = p.querySelectorAll('input[type="email"],input[type="password"],input[type="text"],input[type="tel"],input:not([type])');
      for (var k = 0; k < boxes.length; k++) if (vis(boxes[k])) return true;
      if (p === document.body) break;
    }
    return false;
  }
  /** Is this control, whose label names `p`, really p's sign-in button? */
  function real(el, txt, p) {
    var t = target(el);
    if (t && AUTH[p].test(t)) return true;
    if (t && !offSite(t) && HANDOFF.test(t) && t.toLowerCase().indexOf(p) >= 0) return true;
    // A link out that is not a sign-in endpoint: the provider's own page for the brand, an app store.
    if (t && offSite(t)) return false;
    if (inChrome(el)) return false;
    if (txt === p) return inSigninForm(el);
    return /(continue|sign|log|use|with|account|via)/.test(txt);
  }
  var els = document.querySelectorAll('button,a[href],[role="button"],input[type="button"],input[type="submit"]');
  var out = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var txt = labelOf(el);
    if (!txt) continue;
    if (labelsOnly) {
      var named = NAMES.filter(function (n) { return txt.indexOf(n) >= 0; });
      // A control that names a provider is listed only when it is that provider's real button.
      if (named.length && (txt.length > 80 || !vis(el) || !named.some(function (n) { return real(el, txt, n); }))) continue;
      if (out.length < 200) out.push(txt.slice(0, 120));
      continue;
    }
    if (txt.indexOf(want) < 0 || txt.length > 80) continue;
    if (!/(continue|sign|log|use|with|account|via)/.test(txt) && txt !== want) continue;
    if (!vis(el)) continue;
    if (!real(el, txt, want)) continue;
    el.click();
    return txt.slice(0, 80);
  }
  return labelsOnly ? out : "";
}
