// Reason Web's edge screens on /web (v2 handoff §4f, reference sheet-edge E1 and E5). Calm, in
// Reason's voice, the same frame as the global error (9B): centred, with more room on desktop.
//
//   E1  404: a torn paper slip, `404`, "This page isn't here. Nothing's lost.", the line about a typo,
//       "Back to the thread →" only for a browser that is signed in, and OR GO TO HEYREASON.COM.
//   E5  maintenance: the mark in a dashed ring, BACK BY ABOUT {time} ET, "Tidying up for a few
//       minutes.", texting still works, "Text Reason →" with its hint. Every /web page answers it
//       (503) while the switch is on; texting Reason is untouched.
//
// The maintenance switch is the owner's: a row in ops_state (never .env), set from /ops or
// scripts/web-maintenance.mjs, with the time Web should be back. It turns itself off at that time,
// so a switch somebody forgot never keeps Web shut: to keep it longer, set a later time.
// E2–E4 (turned off / not yours / archived) belong to pages on files. and events., not here.
import * as db from "../db.js";
import { config } from "../config.js";
import { smsHref } from "./websignin.js";
import { webPage, wordmark, label, hand, action, typed, textReason, bubble } from "./webkit.js";

/** The ops_state key the switch lives under. */
export const MAINT_KEY = "web:maintenance";
/** The zone the return time is said in (the design's `ET`). */
const ET = "America/New_York";

/** The switch as it stands: { on, until } — `until` in ms. Off once the time has passed. */
export function maintenance(now = Date.now()) {
  let v = null;
  try { v = JSON.parse(db.opsGet(MAINT_KEY) ?? "null"); } catch { v = null; }
  const until = Number(v?.until);
  if (!v || !Number.isFinite(until) || until <= now) return { on: false, until: null };
  return { on: true, until, by: v.by ?? null, at: v.at ?? null };
}

/** Turn it on until `until` (ms, in the future, within a day). `by` says who: "ops" or "cli". */
export function startMaintenance({ until, by = "ops", now = Date.now() }) {
  const t = Number(until);
  if (!Number.isFinite(t) || t <= now) return { ok: false, reason: "past" };
  if (t - now > 24 * 60 * 60_000) return { ok: false, reason: "too_far" };
  db.opsSet(MAINT_KEY, JSON.stringify({ until: t, by, at: now }));
  return { ok: true, until: t };
}

export function endMaintenance() {
  db.opsDelete(MAINT_KEY);
  return { ok: true };
}

/** "3:30 PM": the return time in Eastern time, as the label says it. */
export function etTime(ms) {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" }).format(ms).toUpperCase();
}

/**
 * When "HH:MM" (24-hour, Eastern) next comes round after `now`, in ms; or a count of minutes from now
 * ("45", "45m"). Null for anything else. For the /ops form and the CLI.
 */
export function parseUntil(text, now = Date.now()) {
  const s = String(text ?? "").trim().toLowerCase();
  const mins = /^(\d{1,4})\s*m?$/.exec(s);
  if (mins) return now + Number(mins[1]) * 60_000;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!hm) return null;
  const h = Number(hm[1]), m = Number(hm[2]);
  if (h > 23 || m > 59) return null;
  // Eastern wall-clock today, as an instant: try the two offsets New York ever uses.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(p => [p.type, p.value]));
  for (let day = 0; day < 2; day++) {
    for (const off of [4, 5]) {
      const t = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + day, h + off, m);
      const back = new Intl.DateTimeFormat("en-GB", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
      if (back === `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` && t > now) return t;
    }
  }
  return null;
}

const EDGE_CSS = `
.eg-head{padding:20px var(--gut) 14px}
.eg{flex:1 0 auto;width:100%;max-width:640px;margin:0 auto;padding:40px 28px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.eg .h1{font-size:40px;line-height:1.06}
.eg .lbl{font-size:11px}
.eg-q{margin:0;font-size:16px;line-height:1.55;color:var(--muted)}
.eg .act{font-size:24px;min-height:48px}
.eg .act2{font-size:11.5px}
.torn{align-self:flex-start;width:150px;height:104px;background:var(--lifted);border:1px solid var(--hair);box-shadow:var(--sh);transform:rotate(-4deg);padding:18px;display:flex;flex-direction:column;gap:12px;clip-path:polygon(0 0,100% 0,100% 78%,86% 92%,70% 80%,52% 96%,34% 82%,18% 95%,0 84%)}
.torn span{display:block;height:2px;background:var(--hair)}
.eg-m{gap:20px}
.eg-ring{align-self:flex-start;width:120px;height:120px;border-radius:50%;border:1px dashed var(--hair);display:grid;place-items:center}
.eg-ring .bub{width:42px;height:42px;color:var(--pen);transform:skewX(-10deg)}
.eg-m .hand{font-size:23px;line-height:1.2;transform:rotate(-1deg);transform-origin:left center}
.eg-m .tr .act{font-size:26px}
.eg-m .tr-h{font-size:10px}
@media (min-width:900px){.eg-head{padding:22px clamp(20px,4vw,48px)}.eg{padding:60px 32px 80px}.eg .h1{font-size:64px}.eg .act{font-size:28px}.eg-m .tr .act{font-size:30px}.torn{width:180px;height:124px}.eg-ring{width:140px;height:140px}.eg-q{font-size:18px}.eg-m .hand{font-size:26px}}
`;

const head = () => `<header class="eg-head">${wordmark({ href: "/web" })}</header>`;
const siteLink = () => {
  const site = String(config.siteUrl || "").replace(/\/+$/, "");
  if (!site) return "";
  let host = "";
  try { host = new URL(site).hostname.replace(/^www\./, ""); } catch { return ""; }
  return typed(`OR GO TO ${host.toUpperCase()}`, { href: site });
};

/** E1: a /web address that isn't anything. "Back to the thread →" only for a browser signed in. */
export function renderWebNotFound({ signedIn = false } = {}) {
  const body = head() + `<main class="eg" aria-labelledby="eg-h">`
    + `<div class="torn" aria-hidden="true"><span style="width:80%"></span><span style="width:55%"></span></div>`
    + label("404")
    + `<h1 id="eg-h" class="h1">This page isn’t here.<br><em>Nothing’s lost.</em></h1>`
    + `<p class="eg-q">The link may have a typo, or the page moved.</p>`
    + (signedIn ? action("Back to the thread", { href: "/web?thread" }) : "")
    + siteLink()
    + `</main>`;
  return webPage({ title: "Reason — not here", body, css: EDGE_CSS, foot: "" });
}

/** E5: Web is paused. `until` (ms) is when it should be back; `joinNumber` the live line, or null. */
export function renderMaintenance({ until = null, joinNumber = null } = {}) {
  const sms = joinNumber ? smsHref(joinNumber) : null;
  const body = head() + `<main class="eg eg-m" aria-labelledby="eg-h">`
    + `<div class="eg-ring" aria-hidden="true">${bubble(2.6)}</div>`
    + (until ? label(`BACK BY ABOUT ${etTime(until)} ET`) : "")
    + `<h1 id="eg-h" class="h1">Tidying up <em>for a few minutes.</em></h1>`
    + `<p class="eg-q">The web is paused while we work on it.${sms ? " Texting Reason still works, and nothing you’ve handed over stops." : " Nothing you’ve handed over stops."}</p>`
    + (sms ? hand("text me in the meantime. i’m still here.") + textReason(sms) : "")
    + `</main>`;
  return webPage({ title: "Reason — back soon", body, css: EDGE_CSS, foot: "" });
}

