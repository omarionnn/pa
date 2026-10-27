// The daily edition's top bar (handoff 2026-10-27 "Coming back daily", reference/home.html and
// reference/stamps.html): the wordmark, then HOME · THE THREAD · STAMPS in typed capitals, the page
// you are on underlined in pen (1.5px). One file for both pages, so Home and Stamps can never drift.
//
// Shown only behind REASON_WEB_DAILY (src/dailyflag.js); the caller decides that, this only draws.
import { wordmark } from "./webkit.js";

/** Where each item goes. THE THREAD is the thread itself (`?thread`), never the arrival. */
export const DAILY_NAV = [
  ["home", "HOME", "/web?home"],
  ["thread", "THE THREAD", "/web?thread"],
  ["stamps", "STAMPS", "/web/stamps"],
];

/** The bar's own CSS (reference header: 22px clamp(20px,4vw,48px), nav 12px mono .14em, 28px apart). */
export const DAILY_HEAD_CSS = `
.dh{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 24px;padding:22px clamp(20px,4vw,48px)}
.dh .wm{font-size:26px}
.dh nav{display:flex;flex-wrap:wrap;gap:4px 28px;font:400 12px/1.3 var(--mono);letter-spacing:.14em}
.dh nav a{text-decoration:none;padding:14px 0;min-height:44px;box-sizing:border-box;display:inline-flex;align-items:center;color:var(--ink);border-bottom:1.5px solid transparent}
.dh nav a[aria-current=page]{border-bottom-color:var(--pen)}
`;

/** The bar. `active`: "home" | "thread" | "stamps" (anything else marks nothing). */
export function dailyHeader(active = "") {
  const items = DAILY_NAV.map(([key, text, href]) =>
    `<a href="${href}"${key === active ? ` aria-current="page"` : ""}>${text}</a>`).join("");
  return `<header class="dh">${wordmark({ href: "/web?home" })}<nav aria-label="Reason">${items}</nav></header>`;
}
