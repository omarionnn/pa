// Sites that turn away browsers run by software, Reason's included (owner decision 2026-11-13).
//
// Why: Netflix answered every sign-in submit with "Something went wrong. Please try again in a few
// minutes." from the server AND from a home connection, with a plain, honest browser and a made-up
// login. It refuses a software-driven browser wherever it runs. Reason does not disguise its browser,
// so for such a site it says so up front, before any save link or Face ID ask, hands the person the
// site's exact page for what they asked about, and answers from the site's own emails.
//
// Per site, never per person: one row per registrable domain with the day it was seen and an evidence
// class from a fixed list. No person, no address, no page text. Every entry expires after 30 days, so
// the site is tried again later (sites change).
import { clock } from "./config.js";
import * as db from "./db.js";
import { registrableOf } from "./sitepolicy.js";

const DAY = 86_400_000;
/** How long a refusal is believed before the site is tried again. */
export const REFUSAL_MAX_AGE_MS = 30 * DAY;
/** Why a site is on the list: a fixed word, never page text. */
export const EVIDENCE = ["seed_generic_error_two_networks", "generic_error_twice", "wall", "challenge"];

/** Written down by hand, with the day it was seen. */
const SEEDS = [
  { site: "netflix.com", label: "Netflix", seen: "2026-11-13", evidence: "seed_generic_error_two_networks" },
];
/** Display names for sites the service marks itself. */
const LABELS = { "netflix.com": "Netflix" };

/**
 * The site's own pages for common account tasks, reviewed by hand. Each was checked load-only on
 * 2026-11-13 (signed out, it answers 302 to the sign-in page with itself as the next page; a made-up
 * path answers 302 to NotFound). `words`: what their request has to say for that page.
 */
export const DEEP_LINKS = {
  "netflix.com": [
    { task: "cancel", url: "https://www.netflix.com/cancelplan", words: /\b(cancel|end|stop|quit)\b[^.]{0,30}\b(membership|subscription|plan|netflix|account)\b|\bcancel(l?ation|l?ing)?\b|\bunsubscribe\b/i },
    { task: "sign_out_all", url: "https://www.netflix.com/manageaccountaccess", words: /\bsign(ed)? ?out\b|\blog(ged)? ?out\b|\b(all|other) devices\b|\bkick (people|someone|them) (off|out)\b|\bwho('?s| is) (using|on)\b/i },
    { task: "billing", url: "https://www.netflix.com/BillingActivity", words: /\b(bill(ing|ed)?|charge[ds]?|payment|paid|pay|receipt|invoice|card|last charge|renew(al|s)?|next (bill|payment))\b/i },
    { task: "profiles", url: "https://www.netflix.com/account/profiles", words: /\bprofiles?\b|\bparental\b|\bkids\b|\bmaturity\b|\bpin\b/i },
    { task: "plan", url: "https://www.netflix.com/account/membership", words: /\b(plan|membership|tier|subscription|upgrade|downgrade|price|cost|ads?|premium|standard|basic)\b/i },
  ],
};
const ACCOUNT_HOME = { "netflix.com": "https://www.netflix.com/account" };

db.db.exec(`
  CREATE TABLE IF NOT EXISTS site_refusals (
    site TEXT PRIMARY KEY,
    evidence TEXT NOT NULL,
    seen_at INTEGER NOT NULL
  );
`);

const dayMs = (iso) => Date.parse(`${iso}T12:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** A domain or host to the site key: its registrable domain ("www.netflix.com" -> "netflix.com"). */
export function siteKey(site) {
  const h = String(site ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  return /^[a-z0-9.-]{3,253}$/.test(h) ? registrableOf(h) : "";
}
/** For tests. */
export function _resetRefusals() { db.db.exec("DELETE FROM site_refusals"); }

/**
 * Is this site on the list right now? → { site, label, seen ("2026-11-13"), evidence, source } | null.
 * The newer of the seed and the service's own mark wins; either is believed for 30 days.
 */
export function refusingSite(site, now = clock.now()) {
  const key = siteKey(site);
  if (!key) return null;
  const seed = SEEDS.find((s) => s.site === key);
  const row = db.db.prepare("SELECT evidence, seen_at FROM site_refusals WHERE site = ?").get(key);
  const cands = [
    seed ? { evidence: seed.evidence, seen_at: dayMs(seed.seen), source: "seed" } : null,
    row ? { evidence: row.evidence, seen_at: Number(row.seen_at), source: "live" } : null,
  ].filter(Boolean).sort((a, b) => b.seen_at - a.seen_at);
  const f = cands[0];
  if (!f || now - f.seen_at >= REFUSAL_MAX_AGE_MS) return null;
  return { site: key, label: LABELS[key] ?? seed?.label ?? key, seen: isoDay(f.seen_at), evidence: f.evidence, source: f.source };
}

/** Write it down: the site turned Reason's browser away. `evidence` from EVIDENCE only. */
export function markRefusing(site, evidence, now = clock.now()) {
  const key = siteKey(site);
  if (!key || !EVIDENCE.includes(evidence)) return null;
  db.db.prepare("INSERT INTO site_refusals (site, evidence, seen_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET evidence = excluded.evidence, seen_at = excluded.seen_at")
    .run(key, evidence, now);
  db.db.prepare("DELETE FROM site_refusals WHERE seen_at < ?").run(now - REFUSAL_MAX_AGE_MS);
  return refusingSite(key, now);
}

/** The site's own page for what they asked about (their words), else its account page, else null. */
export function deepLinkFor(site, words = "") {
  const key = siteKey(site);
  const w = String(words ?? "");
  for (const d of DEEP_LINKS[key] ?? []) if (d.words.test(w)) return { task: d.task, url: d.url };
  return ACCOUNT_HOME[key] ? { task: "account", url: ACCOUNT_HOME[key] } : null;
}

/**
 * The up-front answer for a refusing site, before any save link or Face ID ask. `words`: their own
 * request. `mail`: whether they have mail connected. → { ok:false, result, say_exactly, link, note }.
 * Fixed words; what Reason does next is said as what it is doing, never offered as a question.
 */
export function refusalAnswer(refusal, { words = "", mail = false } = {}) {
  const label = refusal.label;
  const link = deepLinkFor(refusal.site, words);
  const lines = [
    `${label} turns away browsers run by software, including mine, so I can't sign in there. It isn't about your login.`,
    link ? `Here's ${label}'s own page for that, to finish in the ${label} app or your own browser:\n${link.url}` : `You can do it in the ${label} app or your own browser.`,
  ];
  if (mail) lines.push(`I'm also checking your ${label} emails for what I can answer from them.`);
  return {
    ok: false, result: "refuses_software", refused: true, say_exactly: lines.join("\n"), ...(link ? { link: link.url, task: link.task } : {}),
    note: `Send say_exactly as it is. Nothing was opened, no save link or Face ID was made, and do not offer to try anyway. `
      + (mail
        ? `Now, without asking: answer the question they asked from ${label}'s own emails with gmail_search (sender ${refusal.site}: receipts, plan or price changes, renewal or billing notices), then gmail_read the newest match, and tell them what it says (plan, price, renewal date, last charge or change), with its date. If nothing matches, say so in one line.`
        : `They have no mail connected, so that is all for now.`),
  };
}
