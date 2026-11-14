// Where an account job goes, found from the person's own mail before it starts (src/accountjobs.js).
//
// Why (owner, 2026-11-13): "I had to send the link for it to know where to go. That's not great. It should
// ask questions, or figure out from my email exactly where to go." His first run was sent to the merchant's
// front page and came back "not found"; the second, with the manage link he pasted, worked.
//
// What is read: their OWN connected mailboxes, the merchant's and its billing service's mail (receipts,
// renewal notices, "manage your subscription"), a handful of messages per mailbox. Out of each: who sent
// it (which says who bills it), which of their mailboxes it went to (which says the account the
// subscription is under), and the links in it whose words say manage / billing / subscription / account.
//
// What a link has to be to be used: on the merchant's own site or its billing service's (same registrable
// domain), or a tracking redirect that lands there when followed through the network guard
// (src/netguard.js guardedFetch: public addresses only, a few hops). Anything that lands elsewhere is
// dropped. A link that reads as unsubscribe or cancel-now is never followed.
//
// What comes back: { url, biller, account } to start with no question; { store } for Apple / Google Play
// billing, which no merchant site can cancel; or { ask } with what is unclear (none found, two mailboxes,
// two billers), for ONE short question built in code.
import { registrableOf, fromDomain } from "./signinemail.js";
import { guardedFetch } from "./netguard.js";

/** Billing services by their mail's domain: their name, and the sites a manage link of theirs may be on. */
export const BILLERS = Object.freeze({
  "stripe.com": { name: "Stripe", sites: ["stripe.com", "link.com"] },
  "link.com": { name: "Link (Stripe)", sites: ["link.com", "stripe.com"] },
  "paddle.com": { name: "Paddle", sites: ["paddle.com", "paddle.net"] },
  "paddle.net": { name: "Paddle", sites: ["paddle.com", "paddle.net"] },
  "chargebee.com": { name: "Chargebee", sites: ["chargebee.com", "chargebeeportal.com"] },
  "recurly.com": { name: "Recurly", sites: ["recurly.com"] },
  "fastspring.com": { name: "FastSpring", sites: ["fastspring.com", "onfastspring.com"] },
  "lemonsqueezy.com": { name: "Lemon Squeezy", sites: ["lemonsqueezy.com"] },
  "gumroad.com": { name: "Gumroad", sites: ["gumroad.com"] },
  "paypal.com": { name: "PayPal", sites: ["paypal.com"] },
});
/** App stores: a subscription billed there is cancelled in the store, never on the merchant's site. */
export const STORES = Object.freeze({ "apple.com": "apple", "itunes.com": "apple", "google.com": "google_play" });
const isStoreMail = (from) => {
  const d = registrableOf(fromDomain(from));
  if (d === "google.com") return /googleplay|payments-noreply|play/i.test(String(from));
  return Object.hasOwn(STORES, d);
};

const MANAGE_WORDS = /\b(manage|billing|subscription|subscriptions|account|membership|plan|portal|view (your )?(invoice|receipt|bill)|pay (your )?bill|update payment)\b/i;
const NEVER_FOLLOW = /\bunsubscribe\b|\bopt[- ]?out\b|\bcancel( now| subscription| my| your)?\b|\bdelete\b|\bconfirm\b|\bverify\b|\bsign[- ]?in link\b|\bmagic\b/i;
const MANAGE_PATH = /manage|billing|subscri|account|membership|portal|invoice|settings/i;
const decode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/");
/** The links in a message's html (with their words) and plain text (address only). */
export function linksIn({ html = "", text = "" } = {}) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ url: decode(m[1]).trim(), words: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  for (const m of String(text).matchAll(/https:\/\/[^\s<>"')\]]+/g)) out.push({ url: m[0], words: "" });
  return out.filter((l) => /^https:\/\//i.test(l.url));
}
/** Is this link one that says "manage it here" (and never one that acts when opened)? */
export function looksLikeManage({ url, words }) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (NEVER_FOLLOW.test(words) || NEVER_FOLLOW.test(decodeURIComponent(u.pathname))) return false;
  return words ? MANAGE_WORDS.test(words) : MANAGE_PATH.test(u.pathname);
}
const onSites = (url, sites) => { try { return sites.includes(registrableOf(new URL(url).hostname.toLowerCase())); } catch { return false; } };
/**
 * The link as a start page, or "": on one of `sites` already, or a redirect that lands on one of them when
 * followed through the network guard. Only the landing address is kept (no tracker in front of it).
 */
export async function ownLink(url, sites, { fetchImpl = null } = {}) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  if (u.protocol !== "https:" || u.username || u.password) return "";
  if (onSites(u.href, sites)) return u.href;
  try {
    const r = await guardedFetch(u.href, { fetchImpl, httpsOnly: true, maxHops: 5 });
    try { await r.res?.body?.cancel?.(); } catch { /* the body is never read */ }
    if (r.ok && onSites(r.url, sites)) return new URL(r.url).href;
  } catch { /* a link that does not resolve is no link */ }
  return "";
}

/**
 * From the hits of one mail search ([{ account, from, subject, at, html, text }], newest first) for a
 * merchant at `site`: where to start, or what to ask. `sites` the merchant's own registrable domains.
 */
export async function placeFrom(hits, { site, fetchImpl = null } = {}) {
  const own = registrableOf(site);
  const mine = (hits ?? []).filter((h) => h && h.from);
  if (!mine.length) return { ask: "where" };
  if (mine.some((h) => isStoreMail(h.from)) && mine.every((h) => isStoreMail(h.from) || !Object.hasOwn(BILLERS, registrableOf(fromDomain(h.from))))) {
    const d = registrableOf(fromDomain(mine.find((h) => isStoreMail(h.from)).from));
    // A store's receipt AND the merchant's own billing mail: the store only when nothing says otherwise.
    if (!mine.some((h) => registrableOf(fromDomain(h.from)) === own)) return { store: STORES[d] };
  }
  // Who bills it, per mail: a known billing service, or the site itself.
  const billerOf = (h) => { const d = registrableOf(fromDomain(h.from)); return Object.hasOwn(BILLERS, d) ? d : d === own ? own : ""; };
  const usable = mine.filter((h) => billerOf(h));
  if (!usable.length) return { ask: "where" };
  const billers = [...new Set(usable.map(billerOf).map((d) => (BILLERS[d]?.name ?? own)))];
  if (billers.length > 1) return { ask: "biller", billers };
  const accounts = [...new Set(usable.map((h) => String(h.account ?? "").toLowerCase()).filter(Boolean))];
  if (accounts.length > 1) return { ask: "account", accounts };
  const biller = billerOf(usable[0]);
  const sites = [own, ...(BILLERS[biller]?.sites ?? [])];
  let tried = 0;
  for (const h of usable) {
    for (const l of linksIn(h)) {
      if (!looksLikeManage(l)) continue;
      if (!onSites(l.url, sites) && ++tried > 3) continue;
      const url = await ownLink(l.url, sites, { fetchImpl });
      if (url) return { url, biller: biller === own ? "" : BILLERS[biller].name, account: accounts[0] ?? "" };
    }
  }
  // Their mail says who and where they are known, but gives no page: start at the site, as that account.
  return { url: "", biller: biller === own ? "" : BILLERS[biller].name, account: accounts[0] ?? "" };
}

/** The one question, built from what is unclear. */
export function placeQuestion(job, p) {
  const n = job.name;
  if (p.ask === "account") return `Is ${n} under ${p.accounts.slice(0, -1).join(", ")} or ${p.accounts.at(-1)}?`;
  if (p.ask === "biller") return `Is ${n} billed through ${p.billers.slice(0, -1).join(", ")} or ${p.billers.at(-1)}?`;
  if (p.ask === "where_again") return `I still can't tell where ${n} bills you. Do you have its manage link, or the email address the account is under?`;
  return job.kind === "bill"
    ? `I can't find where ${n} bills you. Do you have their bill email, or the page you pay it on?`
    : `I can't find where ${n} bills you. Do you have a receipt or renewal email from them, or the page where you manage it?`;
}

/** Their mail, searched: the merchant's and billing services' recent messages per mailbox, with their links. */
export async function gmailFind(conversationId, { site, name, domains = [] }) {
  const google = await import("./google.js");
  const tokens = await google.allAccessTokens(conversationId, { scope: google.TOOL_SCOPES.gmail_search });
  if (!tokens.ok) return { connected: false, hits: [] };
  const own = registrableOf(site);
  const from = [...new Set([own, ...domains, ...Object.keys(BILLERS), "apple.com", "googleplay-noreply@google.com"])];
  const nm = String(name ?? "").replace(/["()]/g, " ").trim();
  // Their own site's mail, or a billing service's / store's mail that names them.
  const q = `(from:(${own}${domains.length ? ` OR ${domains.join(" OR ")}` : ""}) OR (from:(${from.join(" OR ")}) "${nm || own}")) newer_than:400d`;
  const hits = [];
  for (const a of tokens.accounts ?? []) {
    const list = await google.api(a.token, "GET", "/gmail/v1/users/me/messages", { query: { q, maxResults: 5 } });
    if (!list.ok) continue;
    for (const m of list.body?.messages ?? []) {
      const one = await google.api(a.token, "GET", `/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`, { query: { format: "full" } });
      if (!one.ok) continue;
      const headers = one.body?.payload?.headers ?? [];
      const h = (k) => String(headers.find((x) => String(x?.name ?? "").toLowerCase() === k)?.value ?? "");
      const parts = [];
      const walk = (p, d = 0) => { if (!p || d > 6) return; if (p.body?.data && /^text\/(html|plain)/.test(p.mimeType ?? "")) parts.push(p); for (const c of p.parts ?? []) walk(c, d + 1); };
      walk(one.body?.payload);
      const body = (t) => parts.filter((p) => p.mimeType.startsWith(t)).map((p) => Buffer.from(p.body.data, "base64url").toString("utf8")).join("\n").slice(0, 200_000);
      hits.push({ account: String(a.account ?? ""), from: h("from"), subject: h("subject"), at: Number(one.body?.internalDate) || 0, html: body("text/html"), text: body("text/plain") });
    }
  }
  return { connected: true, hits: hits.sort((x, y) => y.at - x.at) };
}
