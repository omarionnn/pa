// What a card may promise (Omari, 2026-11-12 23:00 ET): a card is an offer to do the WHOLE job.
//
// "If you are going to suggest something, it is something that, when they say you should do it, you
// can do autonomously. Something you can drive to completion. Even 'draft a reply' is not good
// enough." The night that was written, the note carried four cards (replace an API key, verify a
// cloud account, fix a billing problem, cancel a subscription) and Reason could finish none of them:
// every one sat behind a sign-in it did not have. One was tapped, and he got a meaningless page and
// the same link three times.
//
// So "can Reason finish this" is decided HERE, in code, never on the model's word. The model proposes,
// per candidate, the job and the ROUTE it would take; this file checks that route against what is
// really there for this person right now, and the card is dropped when it is not. A route is only a
// route when code can also verify its DONE afterwards:
//
//   calendar  an event of theirs changed through a connected Google account whose grant covers
//             calendar writes.                      DONE: Google answered the write (ledger: ok).
//   email     a reply actually SENT from their account in the thread the candidate came from, shown
//             to them first (the confirm gate is part of the one yes). Needs the send grant and a
//             sender that reads replies.           DONE: Gmail returned the sent message (ledger: ok).
//   pay       an order or payment the existing checkout carries end to end: the same confirm gate,
//             the per-person daily cap, the passkey approval. Needs the checkout on for them, a card
//             on file, and a store the checkout has already reached an exact total at for them (or
//             one they connected); a store that needs their sign-in is not a route.
//                                                  DONE: the payment row reads paid.
//   call      a phone call Reason places whose goal can be met on the call. Needs the phone line up,
//             a number that is really in the candidate's own words, and the call-hours rule to allow
//             it now.                              DONE: the call's own outcome reads success.
//   site      a site where Reason holds a saved signed-in session that checks out NOW (asked of the
//             site, not read off a cookie). Never a site in the dated blocked findings
//             (src/sitefindings.js), never a site with no saved session.
//                                                  DONE: the site's own final step went through on
//                                                  their yes (ledger: the commit, ok).
//
// What is NOT a route, whatever the model says: a reminder, a list, a draft, a link to the place, a
// sign-in for them to do. Anything they would have to do by hand is not Reason finishing it.
//
// Everything here reads this person's own rows; nothing is logged but the route's name and a reason word.
import * as db from "./db.js";
import * as google from "./google.js";
import * as shop from "./shopconnect.js";
import * as spendcap from "./spendcap.js";
import * as signin from "./signin.js";
import * as findings from "./sitefindings.js";
import * as browser from "./browser.js";
import * as busy from "./busy.js";
import * as zone from "./zone.js";
import { withinCallingHours, callHoursFor } from "./calls/brief.js";
import { isSuccess } from "./calls/outcome.js";
import { clock } from "./config.js";

const DAY = 24 * 3_600_000;

// ---------------------------------------------------------------- the sender check

/**
 * "Your account is suspended, response required" is the oldest phishing subject there is. So a mail
 * may become a card or a worth-knowing line only when Gmail's OWN authentication verdict for it
 * passes and lines up with the address it claims to be from:
 *
 *   dmarc=pass with header.from on the From address's organisational domain, or
 *   (no DMARC verdict at all) a passing DKIM signature whose domain is the From address's.
 *
 * SPF alone never counts (it speaks for the envelope, not the From line), and a dmarc=fail is a fail
 * whatever else passed. Gmail's verdict is the Authentication-Results header ITS server stamped: the
 * topmost one, with authserv-id mx.google.com. A header further down saying the same thing is
 * something the sender wrote, and is not read.
 */
export function orgDomain(host) {
  const parts = String(host ?? "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length < 2) return parts.join(".");
  const two = parts.slice(-2).join(".");
  return parts.length >= 3 && /^(co|com|org|net|ac|gov|ne|or|edu)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
}
const domainOf = (address) => String(address ?? "").trim().toLowerCase().split("@")[1]?.replace(/[>\s].*$/, "") ?? "";

export function senderCheck({ headers = [], from = "" } = {}) {
  const fromDomain = domainOf(from);
  if (!fromDomain) return { pass: false, why: "no_from" };
  const results = (headers ?? []).filter(h => /^authentication-results$/i.test(String(h?.name ?? "")));
  const top = String(results[0]?.value ?? "");
  if (!top) return { pass: false, why: "no_result" };
  // Comments can hold anything, a semicolon included: gone before the verdicts are read.
  const flat = top.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const [server, ...verdicts] = flat.split(";").map(s => s.trim());
  if (!/^mx\.google\.com$/i.test(server.split(" ")[0] ?? "")) return { pass: false, why: "not_gmails" };
  const want = orgDomain(fromDomain);
  let dmarc = "", dmarcFrom = "", dkimAligned = false;
  for (const v of verdicts) {
    const m = /^(dkim|dmarc|spf)=([a-z]+)/i.exec(v);
    if (!m) continue;
    const method = m[1].toLowerCase(), result = m[2].toLowerCase();
    if (method === "dmarc") {
      dmarc = result;
      dmarcFrom = (/\bheader\.from=([^\s;]+)/i.exec(v)?.[1] ?? "").toLowerCase();
    } else if (method === "dkim" && result === "pass") {
      const d = (/\bheader\.d=([^\s;]+)/i.exec(v)?.[1] ?? /\bheader\.i=[^\s;@]*@([^\s;]+)/i.exec(v)?.[1] ?? "").toLowerCase();
      if (d && orgDomain(d) === want) dkimAligned = true;
    }
  }
  if (dmarc === "pass") return orgDomain(dmarcFrom) === want ? { pass: true, why: "dmarc" } : { pass: false, why: "dmarc_other_domain" };
  if (dmarc && dmarc !== "none") return { pass: false, why: `dmarc_${dmarc}`.slice(0, 24) };
  return dkimAligned ? { pass: true, why: "dkim_aligned" } : { pass: false, why: "unauthenticated" };
}

// ---------------------------------------------------------------- the routes

/**
 * The closed set. `promise` is what a card on this route may say it will do, `done` is what code
 * looks for afterwards, `actions` are the ledger actions whose `ok` is that proof, and `verbs` are
 * the eyebrow words the route can honestly carry.
 */
export const ROUTES = Object.freeze({
  calendar: {
    promise: "change the event on their Google calendar (accept, decline, move, add or cancel it)",
    done: "Google answered the calendar write",
    actions: ["calendar_change", "calendar_create", "calendar_delete"],
    verbs: ["ACCEPT", "DECLINE", "MOVE", "CANCEL", "CONFIRM", "BOOK"],
  },
  email: {
    promise: "send the reply from their own address (they see it first; their yes sends it)",
    done: "Gmail returned the sent message",
    actions: ["gmail_send"],
    verbs: ["REPLY", "SEND", "CONFIRM", "DECLINE", "ACCEPT", "CANCEL"],
  },
  pay: {
    promise: "place the order or make the payment through the checkout (they approve the exact total)",
    done: "the payment reads paid",
    actions: ["shop_pay"],
    verbs: ["PAY", "ORDER", "RENEW", "BOOK"],
  },
  call: {
    promise: "place the call and get it settled on the call",
    done: "the call's own outcome reads success",
    actions: ["call_place"],
    verbs: ["CALL", "BOOK", "CONFIRM", "CANCEL", "MOVE"],
  },
  site: {
    promise: "do it on the site in their saved signed-in session (their yes covers the final step)",
    done: "the site's final step went through",
    actions: ["subscription_cancel_commit", "flight_checkin_commit", "browser_submit"],
    verbs: ["CANCEL", "RENEW", "REPLACE", "PAY", "CONFIRM", "BOOK", "ORDER"],
  },
});
export const ROUTE_NAMES = Object.freeze(Object.keys(ROUTES));
/** A route that failed for this person on this target is not offered again for this long. */
export const FAILED_ROUTE_MS = 14 * DAY;
/** How long a tapped card may wait on their yes, an approval or a call before it is settled. */
export const PENDING_MS = 6 * 3_600_000;

/**
 * Tools that hand the job back to the person: a sign-in link, a sign-in window, a page to finish on.
 * A card promised Reason would finish it alone, so on a card's own run these are refused (src/tools.js):
 * the run fails honestly, once, instead of texting links.
 */
export const HANDOFF_TOOLS = Object.freeze(new Set(["signin_link", "signin_email", "signin_provider", "signin_open", "shop_handoff", "uber_link", "account_connect", "google_connect", "uber_connect", "spotify_connect", "github_connect", "x_connect", "apple_calendar_connect"]));
export const HANDOFF_REFUSAL = Object.freeze({
  ok: false, blocked: "card_must_finish",
  error: "This job came from a card on their note, and a card promises Reason finishes it without them. Do NOT send a sign-in link, a page, or anything for them to do by hand, and do not offer one. Tell them ONCE, plainly, that you could not finish it and the one real reason, say what (if anything) was already done or undone, and stop.",
});

const hostOf = (s) => {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return "";
  let host = t;
  try { if (/^https?:\/\//.test(t)) host = new URL(t).hostname; } catch { return ""; }
  host = host.replace(/\/.*$/, "").replace(/^www\d?\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && /[a-z]/.test(host.split(".").pop()) ? host : "";
};
const digits = (s) => String(s ?? "").replace(/\D+/g, "");
/** A US number as its ten digits, or "" (a card never rings a number code cannot read). */
const national = (s) => { const d = digits(s); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 ? d : ""; };

// ---------- what is really there, read off this person's own rows (each one injectable for tests)

let callsStatus = () => false;
/** The runtime's phone provider, wired once at boot (src/actionengine.js useRuntime). */
export function useCalls(fn) { callsStatus = typeof fn === "function" ? fn : () => false; }

/** Has a checkout of THEIRS at this store ever reached an exact total (a payment request exists)? */
function reachedATotal(conversationId, store) {
  return !!db.db.prepare(`SELECT 1 FROM shop_payments WHERE conversation_id = ? AND run_id IN
    (SELECT run_id FROM shop_runs WHERE conversation_id = ? AND store = ?) LIMIT 1`).get(conversationId, conversationId, store);
}

/** The site asked now: is the saved session still signed in? `unknown` is never yes. */
async function liveSession(conversationId, entry, { timeoutMs = 20_000 } = {}) {
  // A sign-in link or a checkout in progress owns the browser: not now, and not-now is not yes.
  if (busy.holding().length) return { state: "unknown", why: "busy" };
  const work = (async () => {
    const page = await browser.pageFor(conversationId);
    const out = await signin.checkAndRecord(page, conversationId, entry.site, { entry });
    if (!out.ok) return { state: "unknown", why: "probe_failed" };
    // By-address sites have no signed-in words of their own: an absence of "sign in" is not proof.
    if (out.state === "signed_in" && out.inferred && entry.generic) return { state: "unknown", why: "inferred_only" };
    return { state: out.state };
  })();
  const timer = new Promise(r => { const t = setTimeout(() => r({ state: "unknown", why: "timeout" }), timeoutMs); t.unref?.(); });
  try { return await Promise.race([work, timer]); } catch { return { state: "unknown", why: "probe_failed" }; }
}

export const REAL = Object.freeze({
  scopes: (c, account) => google.grantedScopes(c, account),
  missingScope: (tool, scopes) => google.missingScopeFor(tool, scopes),
  shop: (c) => ({ allowed: shop.connectAllowedFor(c), card: shop.cardOf(c), capCents: spendcap.capFor(c).cents }),
  storeKey: (site) => shop.storeKey(site),
  checkoutPlan: (c, store) => shop.checkoutPlan(c, store),
  reachedATotal,
  callsLive: () => { try { return !!callsStatus(); } catch { return false; } },
  callHours: (c, number, now) => {
    const mine = callHoursFor(c);
    const callee = zone.calleeZone(`+1${number}`, c);
    return withinCallingHours({ now, window: mine.window, own: mine.own, userTz: zone.zoneFor(c), ...(callee ? { tz: callee.zones ?? callee.zone, whose: callee.source } : {}) });
  },
  siteEntry: (site) => signin.anyEntryFor(site),
  // The dated findings (src/sitefindings.js): the registry's own note, the probe list and what the
  // service itself saw. A finding gone stale is still a block here: a card is not where that is retested.
  blocked: (entry, now) => {
    if (entry?.signin_blocked) return true;
    try { return findings.signinAccessStored(entry, now).state === "blocked"; } catch { return false; }
  },
  savedSession: (c, entry) => { const r = db.lastSigninCheck(c, entry.site); return !!r && !r.revoked_at && r.state === "signed_in"; },
  liveSession,
});

/**
 * Is this route really open for this person, for this candidate, right now?
 * `proposal` is the model's `{ route, site, phone }`. Returns `{ ok: true, route, target }` or
 * `{ ok: false, why }` with a reason word (never a title, an address or a number).
 */
export async function checkRoute(conversationId, proposal, cand, { now = clock.now(), deps = {} } = {}) {
  const d = { ...REAL, ...deps };
  const c = conversationId;
  const route = String(proposal?.route ?? "").toLowerCase();
  if (!ROUTES[route]) return { ok: false, why: "no_route" };
  if (route === "calendar") {
    const account = cand?.source === "calendar" || cand?.source === "mail" ? String(cand.refs?.account ?? "") : "";
    const scopes = d.scopes(c, account);
    if (!scopes) return { ok: false, why: "no_google_account" };
    if (d.missingScope("calendar_change", scopes)) return { ok: false, why: "no_calendar_permission" };
    return { ok: true, route, target: `calendar:${account.toLowerCase() || "default"}` };
  }
  if (route === "email") {
    // The address has to be one code can see: the thread the candidate came from. "Email my landlord"
    // off a chat line names nobody code can check.
    if (cand?.source !== "mail" || !cand.from) return { ok: false, why: "no_address_to_send_to" };
    if (cand.bulk || google.isNoReply(cand.from)) return { ok: false, why: "nobody_reads_replies" };
    const scopes = d.scopes(c, String(cand.refs?.account ?? ""));
    if (!scopes) return { ok: false, why: "no_google_account" };
    if (d.missingScope("gmail_send", scopes)) return { ok: false, why: "no_send_permission" };
    return { ok: true, route, target: `email:${orgDomain(domainOf(cand.from))}` };
  }
  if (route === "pay") {
    const s = d.shop(c);
    if (!s?.allowed) return { ok: false, why: "no_checkout" };
    if (!s.card?.paymentMethodId || s.card.registered === 0 || s.card.registered === false) return { ok: false, why: "no_card_on_file" };
    if (!(s.capCents > 0)) return { ok: false, why: "no_daily_cap" };
    const site = hostOf(proposal.site);
    if (!site) return { ok: false, why: "no_site" };
    const store = d.storeKey(site);
    if (!store) return { ok: false, why: "no_site" };
    const entry = d.siteEntry(site);
    if (entry && d.blocked(entry, now)) return { ok: false, why: "site_blocked" };
    const plan = d.checkoutPlan(c, store);
    if (plan === "sign_in") return { ok: false, why: "store_needs_their_sign_in" };
    // A guest checkout (a biller's public pay page included) counts once the checkout has got to an
    // exact total there for them; a store they connected is already theirs.
    if (plan !== "signed" && !d.reachedATotal(c, store)) return { ok: false, why: "total_not_reachable" };
    return { ok: true, route, target: `pay:${store}`, site };
  }
  if (route === "call") {
    if (!d.callsLive()) return { ok: false, why: "no_phone_line" };
    const number = national(proposal.phone);
    // Only a number that is in the candidate's own words: never one the model remembered or made up.
    if (!number || !digits(`${cand?.line ?? ""} ${cand?.snippet ?? ""} ${cand?.subject ?? ""}`).includes(number)) return { ok: false, why: "no_number_on_it" };
    const hours = d.callHours(c, number, now);
    if (!hours?.ok) return { ok: false, why: "outside_call_hours" };
    return { ok: true, route, target: `call:${number}`, phone: `+1${number}` };
  }
  // site
  const site = hostOf(proposal.site);
  if (!site) return { ok: false, why: "no_site" };
  const entry = d.siteEntry(site);
  if (!entry) return { ok: false, why: "no_site" };
  if (d.blocked(entry, now)) return { ok: false, why: "site_blocked" };
  if (!d.savedSession(c, entry)) return { ok: false, why: "no_saved_session" };
  const live = await d.liveSession(c, entry);
  if (live?.state !== "signed_in") return { ok: false, why: live?.state === "signed_out" ? "session_lapsed" : "session_unchecked" };
  return { ok: true, route, target: `site:${entry.site}`, site };
}

// ---------------------------------------------------------------- DONE, read back by code

/**
 * After a card was tapped at `since`: did its route's DONE happen? Reads the ledger, the payments,
 * the calls. `{ state: "done", via }`, `{ state: "pending", why }` (their yes, an approval or a call
 * is still out), or `{ state: "failed", why }`. Never the model's word for any of it.
 */
export function readOutcome(conversationId, route, since, { now = clock.now() } = {}) {
  const c = conversationId;
  const def = ROUTES[route];
  if (!def) return { state: "failed", why: "no_route" };
  const rows = db.listActions(c, { since, limit: 200 });
  if (route === "pay") {
    if (db.db.prepare("SELECT 1 FROM shop_payments WHERE conversation_id = ? AND status = 'paid' AND answered_at >= ? LIMIT 1").get(c, since)) return { state: "done", via: "shop_pay" };
  } else if (route === "call") {
    const calls = db.listCalls(c, { limit: 20 }).filter(r => r.created_at >= since && !r.is_owner);
    if (calls.some(r => isSuccess(r.outcome_kind))) return { state: "done", via: "call_place" };
    if (calls.some(r => !r.ended_at)) return { state: "pending", why: "call_in_progress" };
  } else {
    const hit = rows.find(r => def.actions.includes(r.action) && r.outcome === "ok");
    if (hit) return { state: "done", via: hit.action };
  }
  // Still out: their yes not given yet, a send inside its undo window, a checkout or a job running.
  if (db.pendingConfirmations(c).some(k => k.asked_at >= since)) return { state: "pending", why: "waiting_for_their_yes" };
  if (db.db.prepare("SELECT 1 FROM held_actions WHERE conversation_id = ? AND state = 'held' AND created_at >= ? LIMIT 1").get(c, since)) return { state: "pending", why: "inside_undo_window" };
  if (route === "pay" && (db.db.prepare("SELECT 1 FROM shop_payments WHERE conversation_id = ? AND status = 'asked' LIMIT 1").get(c)
    || db.db.prepare("SELECT 1 FROM shop_runs WHERE conversation_id = ? AND status = 'running' AND created_at >= ? LIMIT 1").get(c, since))) return { state: "pending", why: "checkout_running" };
  if (db.listTasks(c).some(t => (t.createdAt ?? t.created_at ?? 0) >= since)) return { state: "pending", why: "job_running" };
  // Failed. The reason is the last thing that was refused or broke, as a tool name and a word.
  const bad = rows.find(r => r.outcome !== "ok" && r.action !== "asked_back");
  const why = bad ? `${bad.action}:${String(bad.result?.blocked ?? bad.result?.status ?? bad.outcome).replace(/[^a-z0-9_]/gi, "").slice(0, 24)}` : "nothing_was_done";
  return { state: "failed", why: why.slice(0, 60), ...(now - since >= PENDING_MS ? { late: true } : {}) };
}
