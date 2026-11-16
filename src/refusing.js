// Sites that turn away browsers run by software, Reason's included (owner decision 2026-11-13).
//
// Why: Netflix answered every sign-in submit with "Something went wrong. Please try again in a few
// minutes." from the server AND from a home connection, with a plain, honest browser and a made-up
// login. It refuses a software-driven browser wherever it runs. Reason does not disguise its browser,
// so for such a site it says so up front, before any save link or Face ID ask, hands the person the
// site's exact page for what they asked about, and answers from the site's own emails.
//
// Per site, never per person: one row per registrable domain with the day it was seen and an evidence
// class from a fixed list. No person, no address, no page text. Every entry expires (sites change).
//
// Walls are often intermittent (DoorDash, 2026-11-13: the form on 3 runs, a challenge on 2), so a wall
// or a challenge is only a STRIKE: the site is marked on the second one, at least 10 minutes after the
// first, with no form reached or sign-in answered in between. A wall mark is believed 7 days; the
// generic error after a submit twice (Netflix) and the seed list, 30 days. Any later account-level
// answer (signed in, wrong password, a code asked) clears the site at once.
import { clock } from "./config.js";
import * as db from "./db.js";
import { registrableOf } from "./sitepolicy.js";

const DAY = 86_400_000;
/** How long a refusal is believed before the site is tried again, by evidence strength. */
export const REFUSAL_MAX_AGE_MS = 30 * DAY;
export const WALL_MAX_AGE_MS = 7 * DAY;
/** Two walls closer together than this are one bad moment (or one job), not two. */
export const STRIKE_GAP_MS = 10 * 60_000;
/** Why a site is on the list: a fixed word, never page text. */
// "browser_refused": Google's own "This browser or app may not be secure" / "Couldn't sign you in" at
// the email step of a Continue-with-Google job (src/federated.js), kept against google.com. A strike,
// like a wall: one is a bad moment, two 10+ minutes apart mark Google for 7 days, and any account-level
// answer from Google (signed in, a tap or a code asked, a wrong password) clears it.
export const EVIDENCE = ["seed_generic_error_two_networks", "generic_error_twice", "wall", "challenge", "browser_refused"];
const STRIKES = new Set(["wall", "challenge", "browser_refused"]);
const maxAgeOf = (evidence) => (STRIKES.has(evidence) ? WALL_MAX_AGE_MS : REFUSAL_MAX_AGE_MS);

/** Written down by hand, with the day it was seen. */
const SEEDS = [
  { site: "netflix.com", label: "Netflix", seen: "2026-11-13", evidence: "seed_generic_error_two_networks" },
];
/** Display names for sites the service marks itself. */
const LABELS = { "netflix.com": "Netflix", "google.com": "Google" };

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
  CREATE TABLE IF NOT EXISTS site_wall_strikes (
    site TEXT PRIMARY KEY,
    evidence TEXT NOT NULL,
    at INTEGER NOT NULL
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
export function _resetRefusals() { db.db.exec("DELETE FROM site_refusals; DELETE FROM site_wall_strikes"); }

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
  // "cleared": an account-level answer after the mark (or the seed) — the site let Reason in.
  if (!f || f.evidence === "cleared" || now - f.seen_at >= maxAgeOf(f.evidence)) return null;
  return { site: key, label: LABELS[key] ?? seed?.label ?? key, seen: isoDay(f.seen_at), evidence: f.evidence, source: f.source };
}

const putMark = (key, evidence, now) => {
  db.db.prepare("INSERT INTO site_refusals (site, evidence, seen_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET evidence = excluded.evidence, seen_at = excluded.seen_at")
    .run(key, evidence, now);
  db.db.prepare("DELETE FROM site_refusals WHERE seen_at < ?").run(now - REFUSAL_MAX_AGE_MS);
};

/**
 * The site turned Reason's browser away. `evidence` from EVIDENCE only. The generic error twice marks
 * it at once; a wall or a challenge is a strike, and marks it only as the second strike at least
 * STRIKE_GAP_MS after the first (with nothing reached in between: reachedForm clears the strike).
 * → the mark now in force, or null (a strike only).
 */
export function markRefusing(site, evidence, now = clock.now()) {
  const key = siteKey(site);
  if (!key || !EVIDENCE.includes(evidence)) return null;
  if (!STRIKES.has(evidence)) { putMark(key, evidence, now); return refusingSite(key, now); }
  const had = db.db.prepare("SELECT evidence, at FROM site_wall_strikes WHERE site = ?").get(key);
  const first = had && now - Number(had.at) < WALL_MAX_AGE_MS ? Number(had.at) : null;
  if (first != null && now - first >= STRIKE_GAP_MS) {
    db.db.prepare("DELETE FROM site_wall_strikes WHERE site = ?").run(key);
    putMark(key, evidence, now);
    return refusingSite(key, now);
  }
  // The first strike (or a second too soon after it, which keeps the first's time).
  if (first == null) {
    db.db.prepare("INSERT INTO site_wall_strikes (site, evidence, at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET evidence = excluded.evidence, at = excluded.at").run(key, evidence, now);
  }
  db.db.prepare("DELETE FROM site_wall_strikes WHERE at < ?").run(now - WALL_MAX_AGE_MS);
  return null;
}

/** One strike on record for this site, still within its 7 days (not yet a mark) → { evidence, seen } | null. */
export function strikeOn(site, now = clock.now()) {
  const key = siteKey(site);
  if (!key) return null;
  const had = db.db.prepare("SELECT evidence, at FROM site_wall_strikes WHERE site = ?").get(key);
  if (!had || now - Number(had.at) >= WALL_MAX_AGE_MS) return null;
  return { evidence: had.evidence, seen: isoDay(Number(had.at)) };
}

/**
 * The site's sign-in form was reached: an earlier single wall before the form is forgotten (it was a
 * bad moment). A challenge after a submit always comes after the form, so only an account-level answer
 * (clearRefusal) forgets that one.
 */
export function reachedForm(site) {
  const key = siteKey(site);
  if (key) db.db.prepare("DELETE FROM site_wall_strikes WHERE site = ? AND evidence = 'wall'").run(key);
}

/** An account-level answer (signed in, wrong password, a code asked): the site is not refusing. */
export function clearRefusal(site, now = clock.now()) {
  const key = siteKey(site);
  if (!key) return;
  db.db.prepare("DELETE FROM site_wall_strikes WHERE site = ?").run(key);
  if (SEEDS.some((x) => x.site === key)) putMark(key, "cleared", now); // newer than the seed, so it wins
  else db.db.prepare("DELETE FROM site_refusals WHERE site = ?").run(key);
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
  // Say what was seen: a wall mark is two walls, not a claim about the site in general.
  const seen = STRIKES.has(refusal.evidence)
    ? `${label} has turned my browser away the last two times I tried, so I can't sign in there right now. It isn't about your login.`
    : `${label} turns away browsers run by software, including mine, so I can't sign in there. It isn't about your login.`;
  const lines = [
    seen,
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
