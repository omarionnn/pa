// A DoorDash order on the person's own DoorDash account, in the hosted browser (src/remotebrowser.js),
// up to the moment of paying (owner, 2026-11-16: "order my usual from X", "get me pad thai from Y to
// my place", done for busy people).
//
// Who: a person the hosted-browser switch covers for doordash.com (REASON_REMOTE_BROWSER) AND food
// ordering is on for (REASON_FOOD). Nobody else is shown either tool, and nothing here runs for them.
//
// The browser work is the existing browser tools on the hosted page (browser_open / read / click /
// type), following the DoorDash playbook (src/playbooks.js). What this file adds is the part that has
// to be code, not the model's say-so:
//   - a budget check before an order starts, so it never dies half-built for want of minutes;
//   - the delivery address: what they said in their own words, or one they saved; never a different
//     one in silence. The checkout page must show it, or the job asks;
//   - the checkout reading: the full breakdown (items, each fee, tax, tip, total) and the delivery
//     estimate, read off the hosted page by code, each item they asked for checked to be in it, their
//     tip (or DoorDash's default, said as such), and every stop: an unavailable item (asked, never
//     swapped), an age-restricted item, a "verify your identity/phone" step, a DoorDash account or
//     payment problem, a card re-verification, a challenge;
//   - how it is paid, REASON_DOORDASH_PAY:
//       handoff (default)  the cart is left on their DoorDash account and they get the exact total and
//                          breakdown to place it themselves. Reason never presses Place order: there
//                          is no tool to, browser_submit / browser_click / Enter refuse it on DoorDash,
//                          and doordash_place refuses in this mode.
//       site_card          after their yes on the EXACT total (the existing confirm gate, the target
//                          pinned to the order, its revision, the total and the address), Reason
//                          presses Place order with the payment method already on their DoorDash
//                          account. It never views, changes or adds a card, and stops if DoorDash asks
//                          for a card number, a CVV, 3-D Secure or any re-verification. The page is read
//                          again just before the press: a total that moved is a new ask. Their own
//                          spending limits and the install's daily cap apply as to any purchase.
//   - after placing (site_card): the confirmation read once, said once, and one status check offered
//     that runs only when they ask (no polling that spends browser minutes).
// Typing a card number into DoorDash is not built and is not to be.
import * as db from "./db.js";
import * as food from "./food.js";
import * as remote from "./remotebrowser.js";
import * as sites from "./sites.js";
import { clock } from "./config.js";
import { sealFor, openAny } from "./restcrypt.js";
import * as passkey from "./passkey.js";

export const SITE = "doordash.com";
export const HOME = "https://www.doordash.com/";
export const ORDERS_URL = "https://www.doordash.com/orders";
export const LABEL = "DoorDash";

// ---------------------------------------------------------------- who, and how it is paid
/** handoff | site_card. Anything else, or unset, is handoff: the mode that needs no decision. */
export function payMode() {
  const v = String(process.env.REASON_DOORDASH_PAY ?? "").trim().toLowerCase();
  return v === "site_card" ? "site_card" : "handoff";
}
/** A DoorDash order in the hosted browser is for this person: the switch covers them for DoorDash and food is on for them. */
export function doordashFor(conversationId) {
  if (!remote.remoteFor(conversationId, SITE)) return false;
  return food.foodOn(conversationId);
}
export const DOORDASH_TOOLS = new Set(["doordash_order", "doordash_place"]);
/** doordash_order for a covered person; doordash_place only in site_card mode. Everybody else: neither. */
export function doordashToolVisible(name, conversationId) {
  if (!DOORDASH_TOOLS.has(name)) return true;
  if (!doordashFor(conversationId)) return false;
  return name === "doordash_place" ? payMode() === "site_card" : true;
}
const num = (v, d) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n > 0 ? n : d; };
/**
 * Browser-minutes one order is planned at, for the check before it starts (REASON_DOORDASH_ORDER_MINUTES,
 * default 10). The fixture walk takes seconds; a real one is pages, menus and a sign-in maybe, so the
 * plan is generous: an order that cannot finish is not started.
 */
export const orderMinutes = () => num(process.env.REASON_DOORDASH_ORDER_MINUTES, 10);

// ---------------------------------------------------------------- the record
db.db.exec(`
  CREATE TABLE IF NOT EXISTS doordash_orders (
    conversation_id TEXT NOT NULL,
    order_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    usual INTEGER NOT NULL DEFAULT 0,
    tip_said TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    address_source TEXT NOT NULL DEFAULT '',
    restaurant TEXT NOT NULL DEFAULT '',
    checkout_url TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER,
    lines_json TEXT NOT NULL DEFAULT '[]',
    tip_cents INTEGER,
    tip_source TEXT NOT NULL DEFAULT '',
    eta TEXT NOT NULL DEFAULT '',
    confirmation TEXT NOT NULL DEFAULT '',
    status_checks INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, order_id)
  );
`);
/** For tests. */
export function _resetDoordash() { db.db.exec("DELETE FROM doordash_orders"); allowUntil.clear(); }
const open = (v) => { try { return String(openAny(v) ?? ""); } catch { return ""; } };
function rowFor(c, orderId) {
  const r = orderId
    ? db.db.prepare("SELECT * FROM doordash_orders WHERE conversation_id = ? AND order_id = ?").get(String(c), Number(orderId))
    : db.db.prepare("SELECT * FROM doordash_orders WHERE conversation_id = ? ORDER BY updated_at DESC, order_id DESC LIMIT 1").get(String(c));
  if (!r) return null;
  return { ...r, address: open(r.address), restaurant: open(r.restaurant), checkout_url: open(r.checkout_url), confirmation: open(r.confirmation), lines: JSON.parse(r.lines_json || "[]") };
}
export const orderRow = rowFor;
function update(c, orderId, fields) {
  const sealed = new Set(["address", "restaurant", "checkout_url", "confirmation"]);
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const vals = cols.map((k) => (sealed.has(k) ? sealFor(String(c), String(fields[k] ?? "")) : fields[k]));
  db.db.prepare(`UPDATE doordash_orders SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE conversation_id = ? AND order_id = ?`)
    .run(...vals, clock.now(), String(c), Number(orderId));
}

// ---------------------------------------------------------------- money and addresses
const MONEY = /-?\$\s?\d{1,4}(?:,\d{3})*\.\d{2}/;
const cents = (s) => { const m = MONEY.exec(String(s ?? "")); if (!m) return null; const neg = m[0].startsWith("-"); const n = Math.round(Number(m[0].replace(/[^0-9.]/g, "")) * 100); return neg ? -n : n; };
/** An item's price as passed ("$14.95" or "14.95") → cents | null. */
const priceCents = (s) => { const m = /^\s*\$?\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,2})?)\s*$/.exec(String(s ?? "")); return m ? Math.round(Number(m[1].replace(/,/g, "")) * 100) : null; };
export const dollars = (n) => `${n < 0 ? "-" : ""}$${(Math.abs(n) / 100).toFixed(2)}`;

const SUFFIX = { avenue: "ave", av: "ave", street: "st", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", place: "pl", court: "ct", terrace: "ter", parkway: "pkwy", highway: "hwy", square: "sq",
  circle: "cir", expressway: "expy", turnpike: "tpke", plaza: "plz", concourse: "concourse", way: "way", alley: "aly", row: "row", walk: "walk" };
const SUFFIXES = new Set([...Object.keys(SUFFIX), ...Object.values(SUFFIX)]);
const DIRS = { n: "n", s: "s", e: "e", w: "w", north: "n", south: "s", east: "e", west: "w", ne: "ne", nw: "nw", se: "se", sw: "sw", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw" };
const DIR = new Set(Object.keys(DIRS));
const UNIT = new Set(["apt", "apartment", "unit", "suite", "ste", "#", "fl", "floor", "rm", "room"]);
const addrWords = (a) => String(a ?? "").toLowerCase().replace(/#\s*/g, " # ").replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
const isNum = (w) => /^\d+[a-z]?$/.test(w ?? "");
/**
 * An address read from where its house number is: the number, a direction ("W 4th St" is not "E 4th
 * St"), the street's name (every word up to its suffix), the suffix ("Bruner Ave" is not "Bruner St")
 * and the unit ("Apt 1" is not "Apt 4"). → { num, dir, name, suffix, unit } | null
 */
function addressAt(words, i) {
  if (!isNum(words[i])) return null;
  let j = i + 1;
  let dir = "";
  if (DIR.has(words[j]) && words[j + 1] && !SUFFIXES.has(words[j + 1])) { dir = DIRS[words[j]]; j += 1; }
  const first = words[j];
  if (!first || UNIT.has(first) || (/^\d/.test(first) && !/^\d+(st|nd|rd|th)$/.test(first))) return null;
  const name = [first];
  let suffix = "";
  let k = j + 1;
  for (; k < Math.min(words.length, j + 5); k++) {
    const w = words[k];
    if (SUFFIXES.has(w)) { suffix = SUFFIX[w] ?? w; k += 1; break; }
    if (DIR.has(w) || UNIT.has(w) || /^\d/.test(w)) break;
    name.push(w);
  }
  // No suffix within reach: the name is its first word only (what follows may be a city).
  const street = suffix ? name.join(" ") : first;
  if (!suffix && DIR.has(words[k]) && !dir) { dir = DIRS[words[k]]; }
  let unit = "";
  for (let u = k; u < Math.min(words.length, k + 6); u++) {
    if (UNIT.has(words[u]) && words[u + 1] && /^[a-z]?\d+[a-z]?$|^[a-z]$/.test(words[u + 1])) { unit = words[u + 1]; break; }
  }
  return { num: words[i], dir, name: street, first, suffix, unit };
}
/**
 * An address's house number and street, to compare two ways of writing it: "3247 Bruner Avenue, Apt 1"
 * and "3247 Bruner Ave" are the same; "3274 Bruner Ave", "3247 Bruner St", "3247 Baychester Ave",
 * "100 E 4th St" for "100 W 4th St" and "Apt 4" for "Apt 1" are not. → { num, street, ... } | null
 */
export function addressKey(a) {
  const words = addrWords(a);
  const i = words.findIndex(isNum);
  if (i < 0) return null;
  const k = addressAt(words, i);
  return k ? { ...k, street: k.first } : null;
}
/** Two readings agree: what one leaves out is not a difference, what both say must match. */
function agree(x, y, { unitRequired = false } = {}) {
  if (!x || !y || x.num !== y.num || x.first !== y.first) return false;
  if (x.suffix && y.suffix && (x.suffix !== y.suffix || x.name !== y.name)) return false;
  if (x.dir && y.dir && x.dir !== y.dir) return false;
  if (unitRequired && x.unit) return x.unit === y.unit;
  if (x.unit && y.unit && x.unit !== y.unit) return false;
  return true;
}
export function sameAddress(a, b) { return agree(addressKey(a), addressKey(b)); }
/**
 * Does this page's text show that address? Its number and street in either spelling, the same
 * direction and suffix where both say one, and, when the address has a unit, that same unit: food at
 * the right building and the wrong door is still lost.
 */
export function pageShowsAddress(text, address) {
  const k = addressKey(address);
  if (!k) return false;
  const words = addrWords(text);
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== k.num) continue;
    if (agree(k, addressAt(words, i), { unitRequired: true })) return true;
  }
  return false;
}
/** Their saved addresses: places they saved, and where their past food orders went. */
function savedAddresses(c) {
  const out = [];
  try { for (const p of db.listPlaces(c)) { const a = open(p.address); if (a) out.push({ address: a, label: open(p.name) }); } } catch { /* none */ }
  try { for (const a of food.history(c).addresses ?? []) if (a?.address) out.push({ address: a.address, label: a.label ?? "" }); } catch { /* none */ }
  return out;
}

// ---------------------------------------------------------------- the checkout reading (pure)
const LABELS = [
  ["subtotal", /^(items? )?subtotal$/i],
  ["delivery_fee", /^delivery fee$/i],
  ["service_fee", /^service fee$/i],
  ["small_order_fee", /^small order fee$/i],
  ["tax", /^(estimated )?tax(es)?( (and|&) (other )?fees)?$|^fees (and|&) estimated tax$/i],
  ["tip", /^(dasher )?tip$/i],
  ["discount", /^(discount|promotion|promo|credits?|dashpass savings|savings)\b/i],
  ["total", /^(order )?total$/i],
  // Any other fee by its short name ("Regulatory Response Fee"); a long line ending in "fee" is page text, not a line of the bill.
  ["fee", /^[a-z][a-z &'/-]{0,38}fee$/i],
];
const kindOf = (label) => (LABELS.find(([, re]) => re.test(label.trim())) ?? [""])[0];
/** What a covered person hears when DoorDash can't be used now, and what the model does next. */
export const FALLBACK_SAY = "I can try the restaurant's own online ordering instead, if you'd like.";
export const FALLBACK_NOTE = "DoorDash can't be used for this right now. If they want it, the order goes the usual way: the restaurant's own ordering (store_checkout on the restaurant's own site, never DoorDash), which asks for their yes on the exact total as always. Nothing is paid without that yes.";
export const STOPS = {
  // Checked in this order: the first one found is the one said.
  card: /\b(cvv|cvc|security code|card number|re-?enter (your )?card|verify (your )?card|confirm (your )?card|3-?d ?secure|3ds|authenticate (this|your) (payment|card))\b/i,
  identity: /\bverify (your )?(phone|identity|account|number)\b|\bconfirm (it'?s you|your identity|your phone( number)?)\b|\bidentity verification\b/i,
  account: /\bpayment (method )?(failed|declined|was declined|couldn'?t be processed)\b|\bcard (was )?declined\b|\baccount (is |has been )?(on hold|suspended|deactivated|locked|restricted|disabled)\b|\bunable to (process|place) (your )?(payment|order)\b|\bupdate your payment\b/i,
  age: /\b21\+|\bmust be 21\b|\bage[- ]restricted\b|\bvalid (government[- ]issued )?(photo )?id\b|\bid (will be|is) (checked|required)\b|\balcohol(ic)?\b/i,
  unavailable: /\b(sold out|currently unavailable|unavailable|no longer available|out of stock|isn'?t available)\b/i,
};
/**
 * Read DoorDash's checkout page text: the breakdown, the total, the estimate and any stop. Pure.
 * A label and its amount may be on one line ("Subtotal $27.40") or on two ("Subtotal" / "$27.40").
 *   → { lines: [{label, kind, cents}], total, tip, subtotal, eta, stop, adds_up, unavailable_line }
 */
export function readCheckout(text) {
  const rows = String(text ?? "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const m = /^(.*?[a-z].*?)\s*:?\s*(-?\$\s?\d[\d,]*\.\d{2})$/i.exec(r);
    let label = ""; let amount = null;
    if (m) { label = m[1]; amount = cents(m[2]); }
    else if (/[a-z]/i.test(r) && !MONEY.test(r) && i + 1 < rows.length && /^-?\$\s?\d[\d,]*\.\d{2}$/.test(rows[i + 1])) { label = r; amount = cents(rows[i + 1]); i += 1; }
    if (!label || amount == null) continue;
    const kind = kindOf(label);
    if (!kind) continue;
    lines.push({ label: label.replace(/:$/, "").trim(), kind, cents: kind === "discount" && amount > 0 ? -amount : amount });
  }
  const totals = lines.filter((l) => l.kind === "total");
  const total = totals.length ? totals[totals.length - 1].cents : null;
  const body = lines.filter((l) => l.kind !== "total");
  // One of each: a page that shows a line twice (a summary and a sticky footer) is counted once.
  const seen = new Set();
  const breakdown = body.filter((l) => { const k = `${l.label.toLowerCase()}|${l.cents}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const subtotal = breakdown.find((l) => l.kind === "subtotal")?.cents ?? null;
  const tip = breakdown.find((l) => l.kind === "tip")?.cents ?? null;
  const sum = breakdown.reduce((n, l) => n + l.cents, 0);
  const all = rows.join("\n");
  const etaM = /(\d{1,2}(?::\d{2})?\s?(?:[ap]m)?\s?[–-]\s?\d{1,2}(?::\d{2})?\s?(?:[ap]m|min))|(?:arrives?|delivered|here) by\s+(\d{1,2}:\d{2}\s?[ap]m)/i.exec(all);
  const eta = etaM ? (etaM[1] || etaM[2]).replace(/\s+/g, " ").trim() : "";
  let stop = "";
  for (const k of ["card", "identity", "account", "age", "unavailable"]) if (STOPS[k].test(all)) { stop = k; break; }
  const unavailable_line = stop === "unavailable" ? rows.find((r) => STOPS.unavailable.test(r)) ?? "" : "";
  return { lines: breakdown, total, tip, subtotal, eta, stop, adds_up: total != null && breakdown.length > 1 && Math.abs(sum - total) <= 1, unavailable_line };
}

/** Their tip as they said it ("$5", "5 dollars", "18%", "20 percent") → { cents } | { pct } | null. */
export function tipSaid(s) {
  const t = String(s ?? "").toLowerCase();
  const pct = /(\d{1,2}(?:\.\d)?)\s?(%|percent)/.exec(t);
  if (pct) return { pct: Number(pct[1]) };
  const usd = /\$\s?(\d{1,3}(?:\.\d{1,2})?)|(\d{1,3}(?:\.\d{1,2})?)\s?(dollars?|bucks)/.exec(t);
  if (usd) return { cents: Math.round(Number(usd[1] ?? usd[2]) * 100) };
  return null;
}

// ---------------------------------------------------------------- words
const STOP_WORDS = {
  card: () => `DoorDash asked me to re-enter or verify your card, which I never do, so I stopped before anything was placed. You can finish it in the DoorDash app.`,
  identity: () => `DoorDash wants to verify your identity or phone before this order, and only you can do that, so I stopped. Nothing was ordered.`,
  account: () => `DoorDash says there's a problem with your account or payment, like a payment that didn't go through or a hold on the account, so I stopped. Nothing was ordered; the DoorDash app will say what it needs.`,
  age: () => `This order has an age-restricted item (like alcohol) that needs an ID check, so I stopped and didn't order it. You can order it in the DoorDash app yourself.`,
};
export const stopWords = (k) => STOP_WORDS[k]?.() ?? "";
const breakdownText = (lines, total) => [...lines.map((l) => `${l.label} ${dollars(l.cents)}`), `Total ${dollars(total)}`].join(", ");

/**
 * What a yes to placing is pinned to (src/tools.js confirmTargetFor "doordash_place"): the order, its
 * cart revision, the exact total and the address, read off the stored checkout. A total that moves is
 * a new revision and a new target, so the old yes cannot pay it.
 */
export function placeTarget(c, orderId = null) {
  const r = rowFor(c, orderId);
  if (!r || r.total_cents == null) return "doordash: no checkout read yet";
  return `doordash order #${r.order_id} r${r.revision}: ${dollars(r.total_cents)} from ${r.restaurant || "the restaurant"} to ${r.address}`;
}
export function placeAmount(c, orderId = null) {
  const r = rowFor(c, orderId);
  return r?.total_cents ?? null;
}

/** Is this address a DoorDash page? */
export const onDoordashUrl = (u) => !!u && remote.remoteSiteOf(u) === SITE && (() => { try { return /^https?:$/.test(new URL(String(u)).protocol); } catch { return false; } })();

// ---------------------------------------------------------------- no other way to place
/** Words a DoorDash button that places the order goes by (src/sites.js commit_labels, and the like). */
export const PLACE_WORDS = /\b(place (your |the )?order|complete (your )?order|submit order|pay now|confirm (and|&) pay|order now)\b|\bplace\b|\bpay\b/i;
/** Words of an offer that signs them up for something: never pressed on DoorDash, in any mode. */
export const SIGNUP_WORDS = /\b(dash ?pass|membership|member|free trial|trial|subscribe|subscription|join|sign me up|enroll|donat\w*|round up|add (a )?donation)\b/i;
/** Is this page DoorDash, in the hosted browser? */
export function onHostedDoordash(page) {
  try { return remote.isRemoteContext(page.context()) && remote.remoteSiteOf(page.url()) === SITE; } catch { return false; }
}
const onCheckout = (page) => { try { return /checkout/i.test(new URL(page.url()).pathname); } catch { return false; } };
/**
 * The generic browser tools' refusal on DoorDash, whatever the mode: browser_submit never commits
 * there (placing goes only through doordash_place, which handoff refuses); browser_click never presses
 * a Place order control; Enter is never pressed on the checkout. → the answer, or null to go on.
 */
export function refuseGenericCommit(page, { tool, name = "" } = {}) {
  if (!onHostedDoordash(page)) return null;
  const why = payMode() === "site_card"
    ? "On DoorDash, Place order goes only through doordash_place, with their yes on the exact total."
    : "On DoorDash, Reason never places the order: it is handed to them to place themselves.";
  if (tool === "browser_submit") return { ok: false, refused: true, blocked: "doordash_place_only", error: `Not pressed. ${why} Nothing was submitted.` };
  if (tool === "browser_click" && PLACE_WORDS.test(String(name))) return { ok: false, refused: true, blocked: "doordash_place_only", error: `Not pressed. ${why}` };
  if (tool === "browser_click" && SIGNUP_WORDS.test(String(name)) && !/\b(no,? thanks|not now|skip|maybe later|close|dismiss)\b/i.test(String(name))) {
    return { ok: false, refused: true, blocked: "doordash_no_signup", error: "Not pressed: on DoorDash Reason never accepts a DashPass or membership offer, a trial, or a donation. Close the offer (its No thanks / close control) and carry on with only what they asked for." };
  }
  if (tool === "press_enter" && onCheckout(page)) return { ok: false, refused: true, blocked: "doordash_place_only", error: `Not pressed: Enter is never pressed on DoorDash's checkout. ${why} Type without press_enter.` };
  return null;
}

// ---------------------------------------------------------------- the tool
/**
 * doordash_order and doordash_place. `deps`: browser (src/browser.js), trust (src/trust.js), the
 * turn's facts (ownTurn, theirWords, ownerName), and the gate's ctx (spend, permission, confirmationId).
 */
export async function runDoordash(name, input, { conversationId: c, browser, trust, ownTurn = false, theirWords = [], ownerName = "them", ctx = {}, shoot = null, signinDeps = null } = {}) {
  if (!doordashFor(c)) return { ok: false, error: "Not available." };
  // A group thread: nobody can consent, sign in or order on another member's DoorDash (also refused by
  // the hosted browser's own switch; said here in words for a turn that names one).
  if (ctx.isGroup || remote.isGroupConversation(c)) return { ok: false, error: "Not in a group thread: a DoorDash order is only ever on one person's own account, from their own thread." };
  if (name === "doordash_place") return await place(c, input, { browser, trust, ctx, ownerName, shoot });
  const a = input?.action;
  if (a === "signin") return await signinByCode(c, input, { ownTurn, signinDeps });
  if (a === "start") return await start(c, input, { theirWords, ownTurn });
  if (a === "address") return await address(c, input, { browser, theirWords });
  if (a === "checkout") return await checkout(c, input, { browser, shoot });
  if (a === "status") return await status(c, input, { browser, ownTurn });
  return { ok: false, error: "Unknown action." };
}

// ---------------------------------------------------------------- when DoorDash, and when not
// The restaurant's own ordering comes first (proven to the exact total, no sign-in, no hosted-browser
// minutes). DoorDash in the hosted browser only when one of these is true, checked here in code, never
// on the model's say-so; and a hosted DoorDash session never opens for anything else (browsing,
// comparing prices): see the site gate below. Offered in this order: own site, DoorDash, phone pickup.
export const WHY = Object.freeze(["asked_by_name", "usual_from_doordash", "no_own_ordering", "own_site_hands_off", "own_site_failed"]);
const NAMED = /\bdoor\s?dash\b/i;
const YESISH = /(^|[^a-z'])(yes|yeah|yep|yup|ok|okay|sure|go ahead|do it|please do|sounds good|alright|all right|let'?s do (it|that))([^a-z']|$)/i;
const NOISH = /(^|[^a-z'])(no|nope|nah|don'?t|not)([^a-z']|$)/i;
const sameName = (a, b) => String(a ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === String(b ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Their usual (from that place, or their last order anywhere) came from DoorDash: the last food order they placed, or one Reason built on DoorDash for them since. */
export function usualFromDoordash(c, restaurant = "") {
  const placed = db.db.prepare("SELECT id, platform, placed_at FROM food_orders WHERE conversation_id = ? AND status = 'placed' ORDER BY placed_at DESC, id DESC LIMIT 30").all(String(c))
    .map((r) => ({ ...r, restaurant: food.ownOrder(c, r.id)?.restaurant ?? "" }))
    .filter((r) => !restaurant || sameName(r.restaurant, restaurant));
  const dd = db.db.prepare("SELECT order_id, restaurant, updated_at FROM doordash_orders WHERE conversation_id = ? AND state IN ('placed', 'handed_off') ORDER BY updated_at DESC LIMIT 30").all(String(c))
    .map((r) => ({ at: r.updated_at, restaurant: open(r.restaurant) }))
    .filter((r) => !restaurant || sameName(r.restaurant, restaurant));
  const lastPlaced = placed[0];
  const lastDd = dd[0];
  if (lastDd && (!lastPlaced || lastDd.at >= Number(lastPlaced.placed_at ?? 0))) return true;
  return lastPlaced?.platform === "doordash";
}
/** Why this order may go to DoorDash, checked: { ok } or { ok: false, error }. */
function routeAllowed(c, input, theirWords) {
  const why = String(input.why ?? "");
  const name = String(input.restaurant ?? "").trim();
  const latest = String(theirWords.at(-1) ?? "");
  const saidYes = (YESISH.test(latest) && !NOISH.test(latest)) || NAMED.test(latest);
  const place = name ? food.placeFor(c, name) : null;
  if (why === "asked_by_name" && theirWords.some((w) => NAMED.test(w))) return { ok: true };
  if (why === "usual_from_doordash" && usualFromDoordash(c, name)) return { ok: true };
  if (why === "no_own_ordering" && place?.no_direct) return { ok: true };
  if (why === "own_site_hands_off" && place?.direct_url && food.handoffAt(c, place.direct_url) === "doordash" && saidYes) return { ok: true };
  if (why === "own_site_failed" && saidYes) {
    const failed = db.db.prepare("SELECT id FROM food_orders WHERE conversation_id = ? AND route = 'direct' AND failures > 0 AND updated_at > ? ORDER BY id DESC LIMIT 5").all(String(c), clock.now() - 24 * 3600_000)
      .some((r) => !name || sameName(food.ownOrder(c, r.id)?.restaurant, name));
    if (failed) return { ok: true };
  }
  return {
    ok: false, not_doordash: true,
    error: `Not DoorDash for this${name ? ` (${name})` : ""}: the restaurant's own online ordering comes first (food_order and its own site, delivery or pickup), then DoorDash, then a phone order for pickup.`
      + " DoorDash opens only when: they asked for DoorDash by name (why asked_by_name); their usual came from DoorDash (usual_from_doordash);"
      + " Reason looked and the place has no online ordering of its own (no_own_ordering, after food_order place with no_direct); its own site hands delivery to DoorDash and they said yes to DoorDash (own_site_hands_off);"
      + " or its own checkout failed and they said yes to trying DoorDash (own_site_failed). Never to browse or compare prices. Nothing was opened.",
  };
}
/** How long a reason to be on DoorDash holds a hosted session open-able (an order, a sign-in, a status look). */
const allowUntil = new Map(); // conversationId -> ms
const allow = (c, ms) => allowUntil.set(String(c), Math.max(allowUntil.get(String(c)) ?? 0, clock.now() + ms));
export const endAllowance = (c) => allowUntil.delete(String(c));
/** A sign-in to DoorDash or a check of it, started by the other sign-in tools (signin_email, account_signin, signin_status): a reason too. */
export const allowSignin = (c) => { if (doordashFor(c)) allow(c, 20 * 60_000); };
/** The hosted browser's gate for DoorDash (src/remotebrowser.js setSiteGate): no session for a covered person without a reason. */
export function sessionAllowed(c) {
  if (!doordashFor(c)) return true;
  return (allowUntil.get(String(c)) ?? 0) > clock.now();
}
remote.setSiteGate(SITE, sessionAllowed);

async function start(c, input, { theirWords = [] } = {}) {
  // DoorDash only for a reason that holds (asked by name, their usual, no own ordering, a hand-off or a
  // failed own checkout with their yes); otherwise the restaurant's own way, and nothing is opened.
  { const route = routeAllowed(c, input, theirWords); if (!route.ok) return route; }
  // The minutes first, by Browserbase's own figure: an order that cannot finish is not begun (a
  // half-built cart helps nobody). Said as Reason's side, never a limit on them, never a plan.
  await remote.refreshUsage().catch(() => null);
  if (remote.minutesLeft() < orderMinutes()) {
    remote.minutesAlert().catch(() => null);
    return { ok: false, budget: true, fallback: FALLBACK_NOTE,
      say_exactly: `I can't take a DoorDash order through me right now. That's on my side, not a limit on you or your account. ${remote.SIDE_INSTEAD}`,
      note: "Send say_exactly as it is. Nothing was opened. Never mention minutes, a plan or a limit; if they want the restaurant's own site or pickup, go that way." };
  }
  // Consent, the key, a site that turned the hosted browser away: asked before anything opens.
  // Anything but their yes being asked for: DoorDash can't be had now, so the order goes the way it
  // would without it (the restaurant's own ordering, with their yes as always), never another way into DoorDash.
  const held = remote.gate(c, SITE, { alt: FALLBACK_SAY });
  if (held) return held.hosted_browser === "consent_needed" ? held : { ...held, fallback: FALLBACK_NOTE };
  const o = food.openOrder(c) ?? food.ownOrder(c, (await food.startOrder(c)).order_id);
  if (!o?.id) return { ok: false, error: "The food order could not be started." };
  const now = clock.now();
  db.db.prepare(`INSERT INTO doordash_orders (conversation_id, order_id, state, usual, tip_said, restaurant, created_at, updated_at) VALUES (?, ?, 'started', ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, order_id) DO UPDATE SET state = 'started', usual = excluded.usual, tip_said = excluded.tip_said, restaurant = excluded.restaurant, updated_at = excluded.updated_at`)
    .run(String(c), o.id, input.usual ? 1 : 0, String(input.tip ?? "").slice(0, 20), sealFor(String(c), String(input.restaurant ?? "").slice(0, 80)), now, now);
  allow(c, 60 * 60_000);
  return {
    ok: true, order_id: o.id, pay_mode: payMode(),
    next: `browser_open ${HOME}. Follow the DoorDash steps in this tool's description: their address first (doordash_order address), then the restaurant, then ${input.usual ? "their past order of it (Reorder) " : "the items one by one with their options"}, the tip, and the checkout (doordash_order checkout).`,
  };
}

async function address(c, input, { browser, theirWords }) {
  const r = rowFor(c, input.order_id);
  if (!r) return { ok: false, error: "Start the order first (doordash_order start)." };
  const said = String(input.address ?? "").trim();
  if (!addressKey(said)) return { ok: false, error: "Pass the street address with its house number (what they said, or the saved one you mean)." };
  // Whose address it is: their own words, or one they saved. Anything else is a guess: ask them.
  const inWords = theirWords.some((w) => pageShowsAddress(w, said));
  const saved = savedAddresses(c).find((s) => sameAddress(s.address, said));
  if (!inWords && !saved) {
    return { ok: false, ask: true, say_exactly: `Where should it go? I don't have ${said} from you.`, note: "Send say_exactly (or your own one-line question) and wait. Nothing was changed on DoorDash." };
  }
  const source = inWords ? "said" : "saved";
  update(c, r.order_id, { address: said, address_source: source, state: "address" });
  // What DoorDash shows now, when its page is open here.
  const page = browser.openPage(c);
  let shown = null;
  if (page && remote.isRemoteContext(page.context())) {
    const stop = await remote.stopIfChallenged(c, page);
    if (stop) return stop;
    shown = pageShowsAddress(await browser.pageText(page).catch(() => ""), said);
  }
  if (shown === false && source === "saved") {
    // Their saved address, not their words, and DoorDash is set somewhere else: never chosen for them.
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, ask: true, differs: true,
      say_exactly: `DoorDash is set to a different address than ${saved.label ? `${saved.label} (${said})` : said}. Should it go to ${said}?`,
      note: "Send say_exactly and wait for their answer. Nothing was changed on DoorDash. On their yes, call address again with that address." };
  }
  return { ok: true, address: said, source, on_page: shown,
    next: shown ? "DoorDash already shows it. Carry on to the restaurant."
      : `Set DoorDash's delivery address to ${said} (its address control at the top; pick it from their saved addresses there, or add it), then carry on. The checkout will be checked for it.` };
}

async function checkout(c, input, { browser, shoot }) {
  const r = rowFor(c, input.order_id);
  if (!r) return { ok: false, error: "Start the order first (doordash_order start)." };
  if (!r.address) return { ok: false, error: "Confirm the delivery address first (doordash_order address)." };
  const page = browser.openPage(c);
  if (!page || !remote.isRemoteContext(page.context()) || !remote.remoteSiteOf(page.url())) {
    return { ok: false, error: "DoorDash's checkout is not open in the hosted browser. Open the cart's checkout page first (browser_open / browser_click), then call checkout." };
  }
  { const stop = await remote.stopIfChallenged(c, page); if (stop) return stop; }
  let text = await browser.pageText(page).catch(() => "");
  let got = readCheckout(text);
  // Still on the cart: its own Checkout button, pressed here by code (the generic click treats
  // "Checkout" as a commit word; on DoorDash it only opens the checkout page, where nothing is placed
  // until Place order). Found by its role and words, never a control that places the order.
  if (got.total == null && !got.stop) {
    const go = page.getByRole("button", { name: /^\s*(go to |continue to )?checkout\b/i }).or(page.getByRole("link", { name: /^\s*(go to |continue to )?checkout\b/i })).first();
    const label = (await go.count().catch(() => 0)) ? await go.textContent({ timeout: 2_000 }).catch(() => "") : "";
    if (label && !PLACE_WORDS.test(label)) {
      await go.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500).catch(() => {});
      { const stop = await remote.stopIfChallenged(c, page); if (stop) return stop; }
      text = await browser.pageText(page).catch(() => "");
      got = readCheckout(text);
    }
  }
  const restaurant = String(input.restaurant || r.restaurant || "").trim();
  // A stop the person has to hear: said once, the hosted session closed, nothing pressed.
  if (got.stop && got.stop !== "unavailable") return await stopJob(c, r, got.stop, { browser });
  if (got.stop === "unavailable") {
    await browser.closeBrowser(c).catch(() => {});
    update(c, r.order_id, { state: "asked" });
    const which = (input.items ?? []).map((it) => String(it.name ?? "")).find((n) => n && got.unavailable_line.toLowerCase().includes(n.toLowerCase()));
    return { ok: false, ask: true, unavailable: which || true,
      say_exactly: `${which ? `The ${which}` : "One of the items"} isn't available at ${restaurant || "the restaurant"} right now. Want me to leave it out, or swap it for something?`,
      note: "Send say_exactly as it is and wait. Never pick a swap yourself. The cart stays on their DoorDash account." };
  }
  if (got.total == null) return { ok: false, error: "No total on this page: it isn't the checkout yet. Open the checkout (DoorDash's Checkout button on the cart), then call checkout again." };
  // The address: the one they gave, on the page, or nothing goes further.
  if (!pageShowsAddress(text, r.address)) {
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, ask: true, address_differs: true,
      say_exactly: `DoorDash's checkout shows a different delivery address than ${r.address}. Should I change it to ${r.address}?`,
      note: "Send say_exactly and wait. Nothing was placed and nothing was changed." };
  }
  // Every item they asked for, on the page by name.
  const items = (input.items ?? []).filter((it) => String(it?.name ?? "").trim());
  if (!items.length) return { ok: false, error: "Pass the items as they are in the cart (name, qty, options, price)." };
  const low = text.toLowerCase();
  const missing = items.filter((it) => !low.includes(String(it.name).toLowerCase().trim()));
  if (missing.length) return { ok: false, error: `The checkout doesn't show ${missing.map((m) => m.name).join(", ")}. Read the cart again (browser_read) and fix it before the checkout is read.` };
  // Only what they asked for, and every charge accounted for. The breakdown must add up to the total:
  // a charge it cannot name (a donation, a membership or trial, an add-on DoorDash put in) is asked
  // about, never handed over or paid in silence. And the subtotal must be the items they asked for:
  // something else in the cart (left from before, or an upsell) is never carried along.
  if (!got.adds_up) {
    await browser.closeBrowser(c).catch(() => {});
    update(c, r.order_id, { state: "asked" });
    return { ok: false, ask: true, unexplained: true,
      say_exactly: `DoorDash's checkout shows ${dollars(got.total)}, but its lines don't add up to that, so there's a charge I can't account for (like a donation, a membership or an add-on). I stopped there; nothing was placed. Want me to look at the cart again and take out anything you didn't ask for?`,
      note: "Send say_exactly as it is and wait. Never accept a DashPass or membership offer, a trial, a donation or an add-on they did not ask for." };
  }
  const priced = items.map((it) => ({ each: priceCents(it.price), qty: Math.max(1, Number.parseInt(String(it.qty ?? 1), 10) || 1) }));
  if (got.subtotal != null && priced.every((p) => p.each != null)) {
    // A cart shows either each item's price or its line's (quantity times price): either may be passed.
    const asked = priced.reduce((n, p) => n + p.each * p.qty, 0);
    const asLines = priced.reduce((n, p) => n + p.each, 0);
    if (Math.abs(asked - got.subtotal) > 1 && Math.abs(asLines - got.subtotal) > 1) {
      return { ok: false, extra: true, error: `The cart's subtotal is ${dollars(got.subtotal)} but the items you passed come to ${dollars(asked)}: the cart has something else in it (left from before, or an add-on). Read the cart (browser_read), remove anything they did not ask for, then call checkout again with every item and its price as the cart shows it.` };
    }
  } else if (got.subtotal != null) {
    return { ok: false, error: "Pass each item's price as the cart shows it (price), so the subtotal can be checked against what they asked for." };
  }
  // The tip: theirs, or DoorDash's default, said as which.
  const theirs = tipSaid(r.tip_said);
  let tipSource = "doordash_default";
  if (theirs) {
    const want = theirs.cents ?? (got.subtotal != null ? Math.round((got.subtotal * theirs.pct) / 100) : null);
    if (want == null) return { ok: false, error: "No subtotal on the page to work their tip out from. Read the page again." };
    const slack = theirs.pct ? 2 : 1;
    if (got.tip == null || Math.abs(got.tip - want) > slack) {
      return { ok: false, error: `Their tip is ${theirs.cents != null ? dollars(theirs.cents) : `${theirs.pct}%`} (${dollars(want)}); the page shows ${got.tip == null ? "no tip" : dollars(got.tip)}. Set the Dasher tip to ${dollars(want)} on the page (its tip choices, or Other), then call checkout again.` };
    }
    tipSource = "theirs";
  }
  // Recorded on their food order (history, the allergy check, the revision the yes is pinned to).
  const fees = got.lines.filter((l) => l.kind !== "tip").map((l) => ({ label: l.label, amount: dollars(l.cents) }));
  const rec = await food.recordCart(c, {
    order_id: r.order_id, store_url: page.url(), restaurant, their_choice: true,
    items: items.map((it) => ({ name: it.name, qty: it.qty, modifiers: it.modifiers, price: it.price })),
    fees, tip: got.tip != null ? dollars(got.tip) : "", total: dollars(got.total), address: r.address, eta: got.eta,
  });
  if (!rec?.ok) return { ok: false, error: rec?.say || rec?.error || "The cart could not be recorded." };
  let checkoutUrl = "";
  try { const u = new URL(page.url()); checkoutUrl = `${u.origin}${u.pathname}`; } catch { checkoutUrl = ""; }
  update(c, r.order_id, { state: "read", revision: rec.revision, total_cents: got.total, lines_json: JSON.stringify(got.lines), tip_cents: got.tip, tip_source: tipSource, eta: got.eta, restaurant, checkout_url: checkoutUrl });
  const tipWords = got.tip == null ? "no tip" : tipSource === "theirs" ? `your ${dollars(got.tip)} tip` : `DoorDash's default tip of ${dollars(got.tip)}`;
  const eta = got.eta ? `, about ${got.eta}` : "";
  const breakdown = breakdownText(got.lines, got.total);
  const flag = rec.allergy_flag ? `${rec.allergy_flag} ` : "";
  if (payMode() === "handoff") {
    // Never pressed. The hosted session closes now (it is billed by the minute); the cart stays on their account.
    await browser.closeBrowser(c).catch(() => {});
    update(c, r.order_id, { state: "handed_off" });
    endAllowance(c);
    try { await food.setStatus(food.ownOrder(c, r.order_id), "needs"); } catch { /* the words still go */ }
    // The web page that shows this cart: the store page when that is where it was read, else the checkout page itself.
    const store = (() => { try { const u = new URL(page.url()); return u.pathname.startsWith("/store/") ? `${u.origin}${u.pathname}` : checkoutUrl; } catch { return checkoutUrl; } })();
    return {
      ok: true, handed_off: true, order_id: r.order_id, total: dollars(got.total), tip_source: tipSource,
      say_exactly: `${flag}Your ${restaurant || "DoorDash"} order is ready in your DoorDash cart: ${dollars(got.total)} all in (${breakdown}), with ${tipWords}, to ${r.address}${eta}. I didn't place it: it's yours to place in the DoorDash app or on doordash.com.`
        + ` DoorDash doesn't say whether a cart made on the web shows up in the app, so if your app's cart is empty, it's on the web${store ? ` at ${store}` : ""}.`,
      note: "Send say_exactly as it is. Reason never places a DoorDash order in this mode, so never say it is ordered or on its way.",
    };
  }
  // site_card: the yes, on exactly this. The food order waits on that yes ('asked'): a new food request
  // drops it with one line, and this order can no longer be placed (stale-yes check in placeOnce).
  update(c, r.order_id, { state: "asked" });
  food.markAsked(c, r.order_id);
  try { await food.setStatus(food.ownOrder(c, r.order_id), "needs"); } catch { /* the words still go */ }
  const ask = `${flag}${dollars(got.total)} from ${restaurant || "DoorDash"} to ${r.address}${eta}, on the card already on your DoorDash account (${breakdown}; ${tipWords}). Place it?`;
  let picture = null;
  try {
    const o = food.ownOrder(c, r.order_id);
    ({ file: picture } = await food.drawApprovalCard({ restaurant: restaurant || "DoorDash", items: o?.items ?? [], lines: fees, tip: got.tip != null ? dollars(got.tip) : "", total: dollars(got.total), eta: got.eta, address: r.address, card: "Card on your DoorDash account" }, shoot ? { shoot } : {}));
  } catch { picture = null; }
  // Face ID on file (src/passkey.js): the same standard as every other purchase. No chat yes places it:
  // the link, bound to this order, its revision, the exact total and the address, is the ask.
  if (passkey.requiredFor(c)) {
    const url = approvalLink(c, r.order_id);
    return {
      ok: true, order_id: r.order_id, total: dollars(got.total), tip_source: tipSource, approve_with_face_id: true, url,
      say_exactly: `${ask.replace(/ Place it\?$/, "")} Approve it with Face ID here:\n${url}`,
      ...(picture ? { picture } : {}),
      note: `Send the picture${picture ? "" : " (if any)"} and say_exactly as it is, the url ON ITS OWN LINE as the last thing, untouched; it works once, for 30 minutes. A yes in the chat never places it. When they approve, Reason places it and tells them by itself.`,
    };
  }
  return {
    ok: true, order_id: r.order_id, total: dollars(got.total), tip_source: tipSource, use_target: placeTarget(c, r.order_id), say_exactly: ask,
    ...(picture ? { picture } : {}),
    note: `Ask with confirm_request (action "doordash_place", summary say_exactly, target use_target, amount ${(got.total / 100).toFixed(2)})${picture ? ", send the picture with it" : ""}, and wait for their answer. Only on their yes: confirm_record, then doordash_place with that confirmation_id. Never press Place order any other way.`,
  };
}

async function stopJob(c, r, kind, { browser }) {
  await browser.closeBrowser(c).catch(() => {});
  endAllowance(c);
  update(c, r.order_id, { state: "stopped" });
  try { await food.setStatus(food.ownOrder(c, r.order_id), "failed"); } catch { /* the words still go */ }
  return { ok: false, stopped: kind, say_exactly: stopWords(kind), note: "Send say_exactly as it is, once. Nothing was placed. Do not try again or try another way." };
}

// ---------------------------------------------------------------- the yes stays this order's
/** Why this DoorDash order can no longer be placed on the yes it was asked for, or "". */
function staleWhy(c, r) {
  const fo = food.ownOrder(c, r.order_id);
  if (!fo) return "no_food_order";
  if (["cancelled", "failed", "placed"].includes(fo.status)) return `food_order_${fo.status}`;
  if (Number(fo.revision ?? 0) !== Number(r.revision ?? 0)) return "cart_changed";
  return "";
}
/** Close any Face ID link still open for this order. */
function closeLinks(orderId) {
  const a = passkey.openApprovalFor(Number(orderId), "doordash");
  if (a) passkey.closeApproval(a, "closed");
}
/** A yes for an order they moved on from: nothing pressed, the link closed, said in a few words. */
async function dropped(c, r, why) {
  update(c, r.order_id, { state: "dropped" });
  closeLinks(r.order_id);
  return { ok: false, dropped: true, why,
    say_exactly: `That ${r.restaurant || "DoorDash"} order isn't waiting anymore${why === "cart_changed" ? ": its cart changed since you were asked" : ""}, so I didn't place it. Nothing was charged.`,
    note: "Send say_exactly as it is. Nothing was pressed." };
}
/** food.js, when a food order is closed or dropped: its DoorDash ask goes with it (no link left open). */
export function voidFor(c, orderId) {
  const r = rowFor(c, orderId);
  if (!r || !["asked", "read", "started", "address"].includes(r.state)) return false;
  update(c, orderId, { state: "dropped" });
  closeLinks(orderId);
  return true;
}
/** Is a Place order press under way for this order right now? food.js never closes one mid-press. */
export const placingFor = (c) => placing.has(String(c));

// ---------------------------------------------------------------- Face ID for a DoorDash order
/** The row a Face ID approval for this order is bound to (src/passkey.js kind 'doordash'). */
export function approvalRow(c, orderId) {
  const r = rowFor(c, orderId);
  if (!r || r.total_cents == null) return null;
  return {
    id: r.order_id, conversation_id: String(c), kind: "doordash", revision: r.revision, total_cents: r.total_cents, address: r.address, restaurant: r.restaurant,
    status: r.state === "asked" && !staleWhy(c, r) ? "asked" : r.state, amount_kind: "exact", amount: (r.total_cents / 100).toFixed(2), currency: "USD",
    merchant_name: r.restaurant || "DoorDash", eta: r.eta, lines: r.lines,
  };
}
/** A fresh one-use, 30-minute Face ID link for this order (older open ones close). */
export function approvalLink(c, orderId) {
  const base = String(process.env.REASON_SITE_URL || process.env.REASON_PUBLIC_URL || "https://heyreason.com").replace(/\/+$/, "");
  return `${base}/web/approve/${passkey.createApproval(approvalRow(c, orderId))}`;
}
/** What the approval page shows for a DoorDash order: its own reading, never page text. */
export function approvalView(a) {
  const row = approvalRow(a.conversation_id, a.payment_id);
  if (!row) return null;
  const state = a.state === "open" && row.status !== "asked" ? "closed" : a.state;
  const o = food.ownOrder(a.conversation_id, a.payment_id);
  const items = (o?.items ?? []).map((it) => `${it.qty > 1 ? `${it.qty}× ` : ""}${it.name}`).join(", ");
  return { a, row, kind: "doordash", state, amount: dollars(row.total_cents), store: `${row.restaurant || "DoorDash"} on DoorDash`, item: items || "Your order",
    breakdown: (row.lines ?? []).map((l) => [l.label, dollars(l.cents)]), address: row.address, eta: row.eta, card: "The card on your DoorDash account", expiresAt: a.expires_at };
}
/**
 * The approval page's tap, verified (src/shopconnect.js payByPasskey calls this for kind 'doordash').
 * Their own limits and the day's cap first, before the link is used; then the assertion against the
 * order as it is now (revision, total, address); then the one press, with the page re-read first.
 * The result is texted to them (no model turn runs here) and returned for the page.
 */
export async function placeApproved(v, response, { browser = null, trust = null, notify = async () => {}, verify = passkey.verifyApproval, shoot = null } = {}) {
  const c = v.row.conversation_id;
  const orderId = v.row.id;
  if (payMode() !== "site_card" || !doordashFor(c)) return { ok: false, error: "not_available" };
  trust = trust ?? await import("./trust.js");
  browser = browser ?? await import("./browser.js");
  if (v.row.status === "asked") {
    const caps = trust.checkCaps(c, v.row.total_cents, { hasYes: true });
    if (!caps.ok) return { ok: false, error: caps.blocked ?? "over_limit", say: caps.error };
    const cap = trust.checkSpendCap(c, v.row.total_cents);
    if (!cap.ok) return { ok: false, error: "over_daily_cap", say: cap.error };
  }
  const ok = await verify(v.a, v.row, response);
  if (!ok.ok) return ok;
  const key = String(c);
  if (placing.has(key)) return { ok: false, error: "already_placing" };
  placing.add(key);
  allow(c, 10 * 60_000);
  let out;
  try { out = await placeOnce(c, { order_id: orderId }, { browser, trust, ctx: { faceIdApproved: true, confirmationId: null }, ownerName: "them", shoot }); }
  finally { placing.delete(key); }
  const line = out.say_exactly || out.error || "";
  if (line) await Promise.resolve(notify(c, out.ok ? `Approved with Face ID. ${line}` : line)).catch(() => {});
  return out.ok ? { ok: true, placed: true } : { ok: false, error: out.total_changed ? "total_changed" : out.stopped ? `stopped_${out.stopped}` : out.dropped ? "order_dropped" : out.blocked ?? "not_placed" };
}

// ---------------------------------------------------------------- signing in, for everyone the hosted browser covers
/**
 * The narrowest way in: DoorDash's own one-time code (emailed or texted to them), which they relay in
 * the chat once; Reason types it only into DoorDash's own code box, in their own hosted context. No
 * password, no saved login, no Continue with Google, no reading their mailbox: those keep their own
 * switches. A DoorDash account that wants a password stops with one plain line.
 */
async function signinByCode(c, input, { ownTurn, signinDeps }) {
  if (!ownTurn) return { ok: false, error: "Only when they ask in their own message." };
  if (!signinDeps?.start) return { ok: false, error: "Not available." };
  const email = String(input.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, needs_email: true, ask: "Ask them once, in one plain line, which email their DoorDash account uses; then call doordash_order signin with it." };
  }
  await remote.refreshUsage().catch(() => null);
  const held = remote.gate(c, SITE, { alt: FALLBACK_SAY });
  if (held) return held.hosted_browser === "consent_needed" ? held : { ...held, fallback: FALLBACK_NOTE };
  const reg = sites.site("doordash");
  // Tests only: the fixture DoorDash's sign-in page (as the hosted browser's API address is read).
  const signinUrl = (process.env.NODE_TEST_CONTEXT && process.env.REASON_DOORDASH_TEST_SIGNIN_URL) || reg?.signin_url || "https://identity.doordash.com";
  const entry = remote.tagEntry(c, { site: "doordash", label: LABEL, signin_url: signinUrl, hosts: reg?.hosts ?? ["doordash.com"], entry: reg?.entry ?? HOME });
  allow(c, 20 * 60_000);
  const out = signinDeps.start({ conversationId: c, entry, email, relayOnly: true, gmail: async () => ({ connected: false }) });
  if (!out?.ok) return out;
  return { ok: true, started: true, say: `Say ONE short line like "Signing you in to DoorDash, one sec." DoorDash will send them a code; you are told when to ask for it. Never ask for a password.` };
}

const CONFIRMED = /\border (?:#|number|no\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})|\b(order (?:placed|confirmed|received)|thanks for your order|your order is (?:on the way|being prepared|confirmed|in))\b/i;
const ORDER_NO = /\border (?:#|number|no\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})/i;

/** Conversations with a doordash_place under way: a second call while one runs is refused, never a second press. */
const placing = new Set();
async function place(c, input, deps) {
  // handoff (the default): never pressed, whatever asked for it.
  if (payMode() !== "site_card") return { ok: false, refused: true, error: "DoorDash orders are handed to them to place in this setup. Nothing was pressed." };
  // Face ID on file: a chat yes never places it (as shop_pay). The tool hands back the link, or says the
  // one already out still works; the press happens only when the page verifies (placeApproved).
  if (passkey.requiredFor(c)) {
    const r = rowFor(c, input.order_id);
    const stale = r ? staleWhy(c, r) : "no_order";
    if (!r || r.total_cents == null || r.state !== "asked" || stale) return { ok: false, error: "There is no DoorDash checkout waiting for their approval. Read it first (doordash_order checkout)." };
    if (passkey.openApprovalFor(r.order_id, "doordash")) return { ok: false, approve_with_face_id: true, link_still_open: true, say: "Their purchases are approved with Face ID, and the link already sent for this order still works. Point them to it in one line; a yes in the chat doesn't place it." };
    return { ok: false, approve_with_face_id: true, url: approvalLink(c, r.order_id), say: "Their purchases are approved with Face ID, so a yes in the chat doesn't place it. Send this url ON ITS OWN LINE as the last thing, untouched; it works once, for 30 minutes." };
  }
  const key = String(c);
  if (placing.has(key)) return { ok: false, refused: true, error: "A DoorDash order is being placed for them right now. Nothing more was pressed; wait for that one's answer." };
  placing.add(key);
  allow(c, 10 * 60_000);
  try { return await placeOnce(c, input, deps); } finally { placing.delete(key); }
}
async function placeOnce(c, input, { browser, trust, ctx, ownerName, shoot = null }) {
  const r = rowFor(c, input.order_id);
  if (!r || r.total_cents == null || !["asked", "read"].includes(r.state)) return { ok: false, error: "There is no read checkout waiting for a yes. Read it first (doordash_order checkout)." };
  // The yes is for THIS food order as it stands: one they moved on from (a new request dropped it), or
  // whose cart changed since, is never placed on an old yes or approval.
  { const why = staleWhy(c, r); if (why) return dropped(c, r, why); }
  // Only a yes on this exact order (or, with Face ID on file, the page's verified approval): a standing
  // permission is never enough for a DoorDash charge.
  if (!ctx.faceIdApproved && passkey.requiredFor(c)) return { ok: false, approve_with_face_id: true, error: "Their purchases are approved with Face ID: a yes in the chat doesn't place it." };
  if (!ctx.faceIdApproved && (ctx.permission || !ctx.confirmationId)) return { ok: false, needs_yes: true, error: `Placing a DoorDash order needs ${ownerName}'s yes on the exact total. Ask with confirm_request (target "${placeTarget(c, r.order_id)}").` };
  // The checkout loaded fresh, never the page as it was when they were asked: DoorDash recomputes the
  // total on load, and a page left open shows the old one.
  if (!r.checkout_url) return { ok: false, error: "The checkout's address was not kept. Read it again with doordash_order checkout." };
  const page = await browser.pageFor(c, { url: r.checkout_url });
  try { await page.goto(r.checkout_url, { waitUntil: "domcontentloaded" }); } catch {
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, error: "DoorDash's checkout would not load just now. Nothing was placed. Say so in one line; do not try again on your own." };
  }
  { const stop = await remote.stopIfChallenged(c, page); if (stop) return stop; }
  // The page again, just before the press: what they said yes to must be what would be charged.
  const text = await browser.pageText(page).catch(() => "");
  const got = readCheckout(text);
  if (got.stop && got.stop !== "unavailable") return await stopJob(c, r, got.stop, { browser });
  if (got.stop === "unavailable" || got.total == null) {
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, error: "The checkout no longer reads as it did (an item changed or the page moved). Nothing was placed. Read it again with doordash_order checkout and ask again." };
  }
  if (got.total !== r.total_cents) {
    // A new total is a new ask: the stored total and revision move (the food order's with them), so the
    // old yes or approval cannot pay it; any link still open for the old one is closed.
    const rev = food.newTotal(c, r.order_id, dollars(got.total)) ?? r.revision + 1;
    update(c, r.order_id, { state: "asked", total_cents: got.total, revision: rev, lines_json: JSON.stringify(got.lines), tip_cents: got.tip });
    closeLinks(r.order_id);
    await browser.closeBrowser(c).catch(() => {});
    const head = `The total on DoorDash changed from ${dollars(r.total_cents)} to ${dollars(got.total)} since you said yes, so I didn't place it. ${dollars(got.total)} all in (${breakdownText(got.lines, got.total)}).`;
    if (passkey.requiredFor(c)) {
      const url = approvalLink(c, r.order_id);
      return { ok: false, total_changed: true, was: dollars(r.total_cents), now: dollars(got.total), approve_with_face_id: true, url,
        say_exactly: `${head} Approve the new total with Face ID here:\n${url}`, note: "Nothing was placed. Send say_exactly as it is, the url on its own line last." };
    }
    return { ok: false, total_changed: true, was: dollars(r.total_cents), now: dollars(got.total), use_target: placeTarget(c, r.order_id),
      say_exactly: `${head} Place it?`,
      note: "Nothing was placed. Ask again with confirm_request on the new use_target; the earlier yes does not cover this." };
  }
  if (!pageShowsAddress(text, r.address)) {
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, error: `The checkout no longer shows ${r.address}. Nothing was placed. Say so and ask where it should go.` };
  }
  // Their own limits, then the install's daily cap: as for any purchase.
  const caps = trust.checkCaps(c, got.total, { hasYes: true, ownerName });
  if (!caps.ok) return { ...caps, site: "doordash" };
  const cap = trust.checkSpendCap(c, got.total);
  if (!cap.ok) return { ...cap, site: "doordash" };
  const labels = sites.site("doordash")?.commit_labels ?? ["place order"];
  let button = null;
  for (const l of labels) {
    const b = page.getByRole("button", { name: new RegExp(`^\\s*${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i") }).first();
    if (await b.count().catch(() => 0)) { button = b; break; }
  }
  if (!button) return { ok: false, error: "No Place order button on the checkout. Nothing was pressed. Read the page (browser_read) and say what it shows." };
  const what = placeTarget(c, r.order_id);
  // The last look before the press: still this food order, still waiting on this yes.
  { const why = staleWhy(c, r); if (why) return dropped(c, r, why); }
  ctx.spend?.(); // past this line DoorDash may have the order
  update(c, r.order_id, { state: "pressing" });
  let after = "";
  try {
    await button.click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500).catch(() => {});
    after = await browser.pageText(page).catch(() => "");
  } catch { after = ""; }
  const post = readCheckout(after);
  // A card or identity step after the press: DoorDash did not take it without them.
  if (post.stop === "card" || post.stop === "identity" || post.stop === "account") {
    trust.settleUnknownOutcome({ conversationId: c, action: "doordash_place", target: what, confirmationId: ctx.confirmationId ?? null });
    return await stopJob(c, r, post.stop, { browser });
  }
  const conf = CONFIRMED.exec(after);
  if (!conf) {
    trust.noteSpend({ conversationId: c, cents: got.total, what: `${what} (OUTCOME UNKNOWN)`, site: "doordash", confirmationId: ctx.confirmationId ?? null });
    trust.noteUnknownOutcome({ conversationId: c, action: "doordash_place", target: what, why: "no confirmation on the page after the press", cents: got.total });
    update(c, r.order_id, { state: "unknown" });
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, blocked: "outcome_unknown",
      say_exactly: `I pressed Place order on DoorDash, but the page didn't confirm it, so I don't know if it went through. I won't try again. Check your DoorDash app's orders; it'll be there if it did.`,
      note: "Send say_exactly as it is. Never retry: a second press can order twice." };
  }
  const orderNumber = ORDER_NO.exec(after)?.[1] ?? "";
  const eta = post.eta || r.eta;
  trust.settleUnknownOutcome({ conversationId: c, action: "doordash_place", target: what, confirmationId: ctx.confirmationId ?? null });
  trust.noteSpend({ conversationId: c, cents: got.total, what, site: "doordash", confirmationId: ctx.confirmationId ?? null });
  update(c, r.order_id, { state: "placed", confirmation: orderNumber, eta });
  endAllowance(c);
  const line = await food.placedDirect(c, r.order_id, { amount: dollars(got.total), eta }).catch(() => "");
  await browser.closeBrowser(c).catch(() => {});
  return {
    ok: true, placed: true, order_id: r.order_id, total: dollars(got.total), ...(orderNumber ? { order_number: orderNumber } : {}), eta,
    say_exactly: `${line || `Placed: ${r.restaurant || "your DoorDash order"}, ${dollars(got.total)}${eta ? `, about ${eta}` : ""}. Going to ${r.address}.`} If you want, I can check on it once later.`,
    note: "Send say_exactly as it is, once. The order number is in order_number: give it only if they ask. A status check runs only when they ask (doordash_order status); never on your own.",
  };
}

// Fixed words and a time only: the status goes back to the model as an instruction, so no free page text rides along.
const STATUS_WORDS = /\b(delivered|on (?:the|its) way|picked up|arriving(?: (?:at|by) \d{1,2}(?::\d{2})?\s?[ap]m| in \d{1,3} min)?|preparing|being prepared|heading to you|dasher is (?:on the way|nearby|at the restaurant|arriving)|order (?:placed|confirmed)|cancell?ed)\b/i;
async function status(c, input, { browser, ownTurn }) {
  const r = rowFor(c, input.order_id);
  if (!r || r.state !== "placed") return { ok: false, error: "There is no DoorDash order Reason placed to check on." };
  // Only when they ask: never a check Reason starts, so no browser minutes go on polling.
  if (!ownTurn) return { ok: false, error: "A status check runs only when they ask for it." };
  if (remote.minutesLeft() < 2) return { ok: false, say_exactly: "I can't look at DoorDash for you right now; that's on my side. DoorDash's own order page shows where it is." };
  allow(c, 5 * 60_000);
  // Their orders page, on the same DoorDash origin the order was placed on.
  const ordersUrl = (() => { try { return `${new URL(r.checkout_url).origin}/orders`; } catch { return ORDERS_URL; } })();
  const page = await browser.pageFor(c, { url: ordersUrl });
  let text = "";
  try { await page.goto(ordersUrl, { waitUntil: "domcontentloaded" }); { const stop = await remote.stopIfChallenged(c, page); if (stop) return stop; } text = await browser.pageText(page).catch(() => ""); } catch { text = ""; }
  await browser.closeBrowser(c).catch(() => {});
  db.db.prepare("UPDATE doordash_orders SET status_checks = status_checks + 1, updated_at = ? WHERE conversation_id = ? AND order_id = ?").run(clock.now(), String(c), r.order_id);
  const m = STATUS_WORDS.exec(text);
  return m
    ? { ok: true, status: m[0], say: `Say where it is in one line, from this: "${m[0]}". Nothing else from the page.` }
    : { ok: true, status: "", say: "DoorDash's page didn't say where it is. Say that in one line and that the DoorDash app shows it live." };
}

/** The capability line for a covered person; "" for everybody else. */
export function capabilityWords(conversationId) {
  if (!doordashFor(conversationId)) return "";
  return payMode() === "site_card"
    ? ` DoorDash is one route, after the restaurant's own online ordering: on their own DoorDash account, Reason builds the cart, reads the exact total and places it only on their approval of that total (Face ID when they have it set up), with the card already on their DoorDash account.`
    : ` DoorDash is one route, after the restaurant's own online ordering: on their own DoorDash account, Reason builds the cart and reads the exact total, and they place it themselves in DoorDash; Reason never places a DoorDash order.`;
}
