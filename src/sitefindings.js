// Which sites let Reason's browser onto their sign-in page, as DATED findings that expire.
//
// Why this file (probe of 44 sites, 2026-11-12): signin_status said "can sign in here" for DoorDash
// while every DoorDash page answered 403, and a reply that morning repeated a finding from Oct 5
// without trying the site. A finding about a site is a fact about one day, so every one here has
// the day it was seen and an age after which it is no longer believed without asking the site again
// (sites change both ways: a wall goes up, a wall comes down).
//
// Two sources, newest wins:
//   - PROBE: a probe run, written down by hand from its record in docs/ (docs/site-probe-*.json).
//   - the site_findings table: what the running service saw itself — a live fetch of the sign-in
//     page (src/socialsignin.js signinWall), a link that ended on a bot check, an emailed-code run
//     the site refused after the email went in.
//
// Kinds:
//   walled               the sign-in page itself refuses the browser (403/429, a challenge page).
//                        No link, no window, no emailed code: all three would show the wall.
//   refuses_after_email  the page loads and takes the email, then answers with a generic failure
//                        ("Something went wrong"). Reason typing is refused; the person typing on
//                        the secure link may not be.
//   open                 the sign-in page loaded with no challenge on it.
//
// Nothing here gets around a wall. A wall is read, dated and believed until it is old.
import { clock } from "./config.js";
import * as db from "./db.js";
import { createHash } from "node:crypto";

const DAY = 86_400_000;
/** How long each kind of finding is believed before the site is asked again. */
export const MAX_AGE_MS = {
  probe: 14 * DAY,              // a probe run's wall
  live_walled: 1 * DAY,         // a wall the service hit itself
  // One person's run is what writes this, and it shuts the emailed code for everybody: a day, like a wall.
  live_refuses_after_email: 1 * DAY,
  open: 6 * 60 * 60_000,        // a page that loaded
};

/**
 * The probe runs. `names`: registry keys (src/sites.js, src/cancel-routes.js) and registrable
 * domains (a site named by its address is keyed by its domain, src/signin.js genericEntry).
 * `hosts`: where the sign-in page lives. The 2026-11-12 run is docs/site-probe-2026-11-12-signin.json.
 */
const WALL = "its sign-in page answered Reason's browser with a bot wall (HTTP 403 or a challenge page that never clears)";
export const PROBE = [
  { names: ["doordash", "doordash.com"], hosts: ["doordash.com"], label: "DoorDash", kind: "walled", seen: "2026-11-12", why: "every page, sign-in included, answered Reason's browser with HTTP 403 and Cloudflare's check, which never clears" },
  { names: ["uber", "uber_eats", "uber.com", "ubereats.com"], hosts: ["auth.uber.com"], label: "Uber / Uber Eats", kind: "walled", seen: "2026-11-12", why: "auth.uber.com (the sign-in for Uber and Uber Eats) answered Reason's browser with HTTP 403 and Cloudflare's check" },
  { names: ["linkedin.com"], hosts: ["linkedin.com"], label: "LinkedIn", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["medium.com"], hosts: ["medium.com"], label: "Medium", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["cloudflare.com"], hosts: ["dash.cloudflare.com"], label: "Cloudflare dashboard", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["claude.ai"], hosts: ["claude.ai"], label: "claude.ai", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["godaddy.com"], hosts: ["godaddy.com"], label: "GoDaddy", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["amctheatres.com"], hosts: ["amctheatres.com"], label: "AMC", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["ticketmaster", "ticketmaster.com", "livenation.com"], hosts: ["ticketmaster.com", "livenation.com"], label: "Ticketmaster", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["canva.com"], hosts: ["canva.com"], label: "Canva", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["openai.com"], hosts: ["platform.openai.com"], label: "OpenAI platform", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["indeed.com"], hosts: ["indeed.com"], label: "Indeed", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["x.com", "twitter.com"], hosts: ["x.com", "twitter.com"], label: "X", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["walmart.com"], hosts: ["walmart.com"], label: "Walmart", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["target.com"], hosts: ["target.com"], label: "Target", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["eventbrite.com"], hosts: ["eventbrite.com"], label: "Eventbrite", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["reddit.com"], hosts: ["reddit.com"], label: "Reddit", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["opentable", "opentable.com"], hosts: ["opentable.com"], label: "OpenTable", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["hetzner.com"], hosts: ["hetzner.com"], label: "Hetzner", kind: "walled", seen: "2026-11-12", why: WALL },
  { names: ["spotify", "spotify.com"], hosts: ["spotify.com"], label: "Spotify", kind: "refuses_after_email", seen: "2026-11-12", why: "its sign-in page loads and takes the email, then answers \"Something went wrong\": it refuses the automated browser after the email is submitted" },
];

db.db.exec(`
  CREATE TABLE IF NOT EXISTS site_findings (
    site TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status INTEGER,
    why TEXT NOT NULL DEFAULT '',
    seen_at INTEGER NOT NULL,
    page TEXT NOT NULL DEFAULT ''
  );
`);
if (!db.db.prepare("PRAGMA table_info(site_findings)").all().some(c => c.name === "page")) db.db.exec("ALTER TABLE site_findings ADD COLUMN page TEXT NOT NULL DEFAULT ''");
/** The most rows kept. The site can be any address a person named, so the table is capped and old rows go. */
export const MAX_ROWS = 2000;
const KEEP_MS = 14 * DAY;
/**
 * Which sign-in page a finding is about, as a short one-way mark (never the address itself). The
 * table is shared by every account, and for a site named by its address the page is whatever the
 * person typed: a finding only speaks for the page it was seen on, so one person naming a page that
 * answers 403 (their own page on a shared host, an admin path) cannot mark the site blocked for
 * people who named its real sign-in page.
 */
export const pageMark = (entry) => createHash("sha256").update(String(entry?.signin_url ?? "")).digest("hex").slice(0, 16);
/** For tests: forget what the service saw itself. */
export function _resetFindings() { db.db.exec("DELETE FROM site_findings"); }

const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const within = (h, base) => !!h && (h === base || h.endsWith(`.${base}`));
const dayMs = (iso) => Date.parse(`${iso}T12:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function probeFor(entry) {
  const site = String(entry?.site ?? "").toLowerCase();
  const host = hostOf(entry?.signin_url);
  let best = null;
  for (const f of PROBE) {
    if (!(f.names.includes(site) || f.hosts.some(h => within(host, h)))) continue;
    if (!best || dayMs(f.seen) > dayMs(best.seen)) best = f;
  }
  // The registry's own dated note (src/sites.js signin_blocked) is a probe finding too.
  const b = entry?.signin_blocked;
  if (b?.seen && (!best || dayMs(b.seen) > dayMs(best.seen))) best = { kind: "walled", seen: b.seen, why: b.why };
  return best ? { kind: best.kind, why: best.why, seen_at: dayMs(best.seen), source: "probe", status: null } : null;
}

/**
 * The newest finding about one site's sign-in, with its date and whether it is still believed.
 *   → { kind, why, status, source: "probe"|"live", seen ("2026-11-12"), seen_at, age_days, fresh } | null
 */
export function signinFinding(entry, now = clock.now()) {
  if (!entry?.site) return null;
  const p = probeFor(entry);
  const row = db.db.prepare("SELECT kind, status, why, seen_at FROM site_findings WHERE site = ? AND page = ?").get(entry.site, pageMark(entry));
  const live = row ? { ...row, source: "live" } : null;
  const f = p && live ? (live.seen_at >= p.seen_at ? live : p) : (live ?? p);
  if (!f) return null;
  const maxAge = f.kind === "open" ? MAX_AGE_MS.open : f.source === "probe" ? MAX_AGE_MS.probe : (MAX_AGE_MS[`live_${f.kind}`] ?? MAX_AGE_MS.live_walled);
  const age = now - f.seen_at;
  return { kind: f.kind, why: f.why || "", status: f.status ?? null, source: f.source, seen: isoDay(f.seen_at), seen_at: f.seen_at, age_days: Math.max(0, Math.floor(age / DAY)), fresh: age < maxAge };
}

/** Write down what the service just saw. `kind`: walled | refuses_after_email | open. */
export function recordFinding(entry, { kind, status = null, why = "" } = {}, now = clock.now()) {
  if (!entry?.site || !["walled", "refuses_after_email", "open"].includes(kind)) return null;
  db.db.prepare("INSERT INTO site_findings (site, kind, status, why, seen_at, page) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site) DO UPDATE SET kind = excluded.kind, status = excluded.status, why = excluded.why, seen_at = excluded.seen_at, page = excluded.page")
    .run(String(entry.site).slice(0, 255), kind, Number.isFinite(Number(status)) && status != null ? Number(status) : null, String(why ?? "").slice(0, 300), now, pageMark(entry));
  // Bounded: nothing older than any finding is believed, and never more than MAX_ROWS sites.
  db.db.prepare("DELETE FROM site_findings WHERE seen_at < ?").run(now - KEEP_MS);
  if (db.db.prepare("SELECT COUNT(*) AS n FROM site_findings").get().n > MAX_ROWS) {
    db.db.prepare("DELETE FROM site_findings WHERE site NOT IN (SELECT site FROM site_findings ORDER BY seen_at DESC LIMIT ?)").run(MAX_ROWS);
  }
  return signinFinding(entry, now);
}

/**
 * Is a live answer (signinWall's shape) a wall? 403/429, or a challenge page served as an error
 * (signinWall words that as a "bot check"). A bare 503, a timeout, a name that does not resolve, a
 * 404 and a page that loaded are not: an outage is never written down as the site blocking anybody.
 */
export function isWall(wall) {
  if (!wall || wall.in) return false;
  const s = Number(wall.status) || 0;
  return s === 403 || s === 429 || (/bot check/.test(String(wall.why ?? "")) && !(s >= 200 && s < 300));
}

/**
 * A live answer about the sign-in page, written down. A page that loaded does NOT clear a
 * "refuses after the email" finding that is still fresh: the page loading was never in question.
 */
export function recordWall(entry, wall, now = clock.now()) {
  if (!wall) return null;
  if (isWall(wall)) return recordFinding(entry, { kind: "walled", status: wall.status, why: wall.why }, now);
  if (wall.in) {
    const had = signinFinding(entry, now);
    if (had?.kind === "refuses_after_email" && had.fresh) return had;
    return recordFinding(entry, { kind: "open", status: wall.status }, now);
  }
  return null;
}

/**
 * Where a site's sign-in stands for Reason's browser, from a fresh finding or a live ask.
 * `live(entry)`: signinWall, or null when the site may not be asked (tests hand one in).
 *   → { state: "blocked"|"open"|"unknown", kind, seen, source, why, checked_live, stale, wall }
 * A stale wall that cannot be re-asked stays "blocked", marked `stale`, with its date: the last
 * thing known, said as old.
 */
export async function signinAccess(entry, { live = null, now = clock.now() } = {}) {
  const shape = (f, extra = {}) => ({
    state: f.kind === "open" ? "open" : "blocked", kind: f.kind, seen: f.seen, source: f.source, why: f.why, status: f.status,
    checked_live: false, stale: !f.fresh, ...extra,
  });
  const had = signinFinding(entry, now);
  if (had?.fresh) return shape(had);
  if (live) {
    let wall = null;
    try { wall = await live(entry); } catch { wall = null; }
    const got = recordWall(entry, wall, now);
    if (got) return shape(got, { checked_live: true, stale: false, wall });
    // Neither a wall nor a page: an outage, a 404. Nothing new is known.
    if (had && had.kind !== "open") return shape(had, { wall });
    return { state: "unknown", kind: "", seen: had?.seen ?? "", source: "", why: wall?.why ?? "", status: wall?.status ?? null, checked_live: !!wall, stale: false, wall };
  }
  if (had && had.kind !== "open") return shape(had);
  return { state: "unknown", kind: "", seen: had?.seen ?? "", source: "", why: "", status: null, checked_live: false, stale: false, wall: null };
}

/** The stored view only (no network), for a list of sites. */
export function signinAccessStored(entry, now = clock.now()) {
  const f = signinFinding(entry, now);
  if (!f) return { state: "unknown", seen: "" };
  if (f.kind === "open") return f.fresh ? { state: "open", seen: f.seen, source: f.source } : { state: "unknown", seen: f.seen };
  return { state: "blocked", kind: f.kind, seen: f.seen, source: f.source, why: f.why, ...(f.fresh ? {} : { stale: true }) };
}

/**
 * What to say and do when a site refuses Reason's browser. One honest line for the person, and the
 * best route that is left. `food` / `uber`: the caller's own words for those (wallInstead).
 */
export function blockedWords(entry, access, { instead = null } = {}) {
  const label = entry?.label ?? "That site";
  const afterEmail = access?.kind === "refuses_after_email";
  const mail = `Answer from their mail where the question can be answered there: gmail_search for ${label}'s receipts, confirmations and notices.`;
  return {
    say: `${label} blocks automated sign-in, so I can't sign you in there myself. That's ${label}'s choice, not something you did.${instead?.say ? ` ${instead.say}` : ""}`,
    instead: [
      instead?.tool ?? "",
      mail,
      afterEmail
        ? `Or their own sign-in: the page itself loads, so signin_link with site "${entry.site}" (no provider) lets them type it themselves. Offer it once; if that ends blocked too, stop and say it has to be done in their own browser or the ${label} app.`
        : `No sign-in link or window: it would only show ${label}'s wall. If their mail cannot answer it, say plainly this one has to be done by them in their own browser or the ${label} app.`,
    ].filter(Boolean).join(" "),
    never: `Do NOT ask which email they use and do NOT try another address: ${label} refused the browser, not their email, and repeated tries can lock their account.`,
  };
}
