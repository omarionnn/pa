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
export function _resetDoordash() { db.db.exec("DELETE FROM doordash_orders"); }
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
export const dollars = (n) => `${n < 0 ? "-" : ""}$${(Math.abs(n) / 100).toFixed(2)}`;

const SUFFIX = { avenue: "ave", av: "ave", street: "st", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", place: "pl", court: "ct", terrace: "ter", parkway: "pkwy", highway: "hwy", square: "sq" };
const DIR = new Set(["n", "s", "e", "w", "north", "south", "east", "west", "ne", "nw", "se", "sw"]);
/**
 * An address's house number and street name, to compare two ways of writing it: "3247 Bruner Avenue,
 * Apt 1" and "3247 Bruner Ave" are the same; "3274 Bruner Ave" and "3247 Baychester Ave" are not.
 * → { num, street } | null
 */
export function addressKey(a) {
  const words = String(a ?? "").toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => /^\d+[a-z]?$/.test(w));
  if (i < 0) return null;
  const rest = words.slice(i + 1).filter((w) => !DIR.has(w));
  const street = rest.find((w) => !/^\d/.test(w) || /^\d+(st|nd|rd|th)$/.test(w));
  return street ? { num: words[i], street: SUFFIX[street] ?? street } : null;
}
export function sameAddress(a, b) {
  const x = addressKey(a); const y = addressKey(b);
  return !!x && !!y && x.num === y.num && x.street === y.street;
}
/** Does this page's text show that address (its number and street, in either spelling)? */
export function pageShowsAddress(text, address) {
  const k = addressKey(address);
  if (!k) return false;
  const words = String(text ?? "").toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? w);
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== k.num) continue;
    const next = words.slice(i + 1, i + 4).filter((w) => !DIR.has(w));
    if (next[0] === k.street) return true;
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
  ["fee", /fee$/i],
];
const kindOf = (label) => (LABELS.find(([, re]) => re.test(label.trim())) ?? [""])[0];
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
export const PLACE_WORDS = /\b(place (your )?order|complete (your )?order|submit order|pay now|confirm (and|&) pay|order now)\b/i;
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
  if (tool === "press_enter" && onCheckout(page)) return { ok: false, refused: true, blocked: "doordash_place_only", error: `Not pressed: Enter is never pressed on DoorDash's checkout. ${why} Type without press_enter.` };
  return null;
}

// ---------------------------------------------------------------- the tool
/**
 * doordash_order and doordash_place. `deps`: browser (src/browser.js), trust (src/trust.js), the
 * turn's facts (ownTurn, theirWords, ownerName), and the gate's ctx (spend, permission, confirmationId).
 */
export async function runDoordash(name, input, { conversationId: c, browser, trust, ownTurn = false, theirWords = [], ownerName = "them", ctx = {}, shoot = null } = {}) {
  if (!doordashFor(c)) return { ok: false, error: "Not available." };
  if (name === "doordash_place") return await place(c, input, { browser, trust, ctx, ownerName });
  const a = input?.action;
  if (a === "start") return await start(c, input);
  if (a === "address") return await address(c, input, { browser, theirWords });
  if (a === "checkout") return await checkout(c, input, { browser, shoot });
  if (a === "status") return await status(c, input, { browser, ownTurn });
  return { ok: false, error: "Unknown action." };
}

async function start(c, input) {
  // The minutes first: an order that cannot finish is not begun (a half-built cart helps nobody).
  const leftSec = remote.monthBudgetMinutes() * 60 - remote.monthSeconds();
  if (leftSec < orderMinutes() * 60) {
    const left = Math.max(0, Math.floor(leftSec / 60));
    return { ok: false, budget: true, minutes_left: left,
      say_exactly: `I have about ${left} minute${left === 1 ? "" : "s"} of hosted-browser time left this month and a DoorDash order takes about ${orderMinutes()}, so I won't start one I might not finish. You can order it in the DoorDash app.`,
      note: "Send say_exactly as it is. Nothing was opened." };
  }
  // Consent, the key, a site that turned the hosted browser away: asked before anything opens.
  const held = remote.gate(c, SITE);
  if (held) return held;
  const o = food.openOrder(c) ?? food.ownOrder(c, (await food.startOrder(c)).order_id);
  if (!o?.id) return { ok: false, error: "The food order could not be started." };
  const now = clock.now();
  db.db.prepare(`INSERT INTO doordash_orders (conversation_id, order_id, state, usual, tip_said, restaurant, created_at, updated_at) VALUES (?, ?, 'started', ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, order_id) DO UPDATE SET state = 'started', usual = excluded.usual, tip_said = excluded.tip_said, restaurant = excluded.restaurant, updated_at = excluded.updated_at`)
    .run(String(c), o.id, input.usual ? 1 : 0, String(input.tip ?? "").slice(0, 20), sealFor(String(c), String(input.restaurant ?? "").slice(0, 80)), now, now);
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
    try { await food.setStatus(food.ownOrder(c, r.order_id), "needs"); } catch { /* the words still go */ }
    const store = (() => { try { const u = new URL(page.url()); return u.pathname.startsWith("/store/") ? `${u.origin}${u.pathname}` : ""; } catch { return ""; } })();
    return {
      ok: true, handed_off: true, order_id: r.order_id, total: dollars(got.total), tip_source: tipSource,
      say_exactly: `${flag}Your ${restaurant || "DoorDash"} order is ready in your DoorDash cart: ${dollars(got.total)} all in (${breakdown}), with ${tipWords}, to ${r.address}${eta}. I didn't place it: it's yours to place in the DoorDash app or on doordash.com.`
        + ` DoorDash doesn't say whether a cart made on the web shows up in the app, so if your app's cart is empty, it's on the web${store ? ` at ${store}` : ""}.`,
      note: "Send say_exactly as it is. Reason never places a DoorDash order in this mode, so never say it is ordered or on its way.",
    };
  }
  // site_card: the yes, on exactly this.
  update(c, r.order_id, { state: "asked" });
  try { await food.setStatus(food.ownOrder(c, r.order_id), "needs"); } catch { /* the words still go */ }
  const ask = `${flag}${dollars(got.total)} from ${restaurant || "DoorDash"} to ${r.address}${eta}, on the card already on your DoorDash account (${breakdown}; ${tipWords}). Place it?`;
  let picture = null;
  try {
    const o = food.ownOrder(c, r.order_id);
    ({ file: picture } = await food.drawApprovalCard({ restaurant: restaurant || "DoorDash", items: o?.items ?? [], lines: fees, tip: got.tip != null ? dollars(got.tip) : "", total: dollars(got.total), eta: got.eta, address: r.address, card: "Card on your DoorDash account" }, shoot ? { shoot } : {}));
  } catch { picture = null; }
  return {
    ok: true, order_id: r.order_id, total: dollars(got.total), tip_source: tipSource, use_target: placeTarget(c, r.order_id), say_exactly: ask,
    ...(picture ? { picture } : {}),
    note: `Ask with confirm_request (action "doordash_place", summary say_exactly, target use_target, amount ${(got.total / 100).toFixed(2)})${picture ? ", send the picture with it" : ""}, and wait for their answer. Only on their yes: confirm_record, then doordash_place with that confirmation_id. Never press Place order any other way.`,
  };
}

async function stopJob(c, r, kind, { browser }) {
  await browser.closeBrowser(c).catch(() => {});
  update(c, r.order_id, { state: "stopped" });
  try { await food.setStatus(food.ownOrder(c, r.order_id), "failed"); } catch { /* the words still go */ }
  return { ok: false, stopped: kind, say_exactly: stopWords(kind), note: "Send say_exactly as it is, once. Nothing was placed. Do not try again or try another way." };
}

const CONFIRMED = /\border (?:#|number|no\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})|\b(order (?:placed|confirmed|received)|thanks for your order|your order is (?:on the way|being prepared|confirmed|in))\b/i;

async function place(c, input, { browser, trust, ctx, ownerName }) {
  // handoff (the default): never pressed, whatever asked for it.
  if (payMode() !== "site_card") return { ok: false, refused: true, error: "DoorDash orders are handed to them to place in this setup. Nothing was pressed." };
  const r = rowFor(c, input.order_id);
  if (!r || r.total_cents == null || !["asked", "read"].includes(r.state)) return { ok: false, error: "There is no read checkout waiting for a yes. Read it first (doordash_order checkout)." };
  // Only a yes on this exact order: a standing permission is never enough for a DoorDash charge.
  if (ctx.permission || !ctx.confirmationId) return { ok: false, needs_yes: true, error: `Placing a DoorDash order needs ${ownerName}'s yes on the exact total. Ask with confirm_request (target "${placeTarget(c, r.order_id)}").` };
  const page = await browser.pageFor(c, { url: r.checkout_url || HOME });
  if (r.checkout_url && (() => { try { const u = new URL(page.url()); return `${u.origin}${u.pathname}` !== r.checkout_url; } catch { return true; } })()) {
    await page.goto(r.checkout_url, { waitUntil: "domcontentloaded" }).catch(() => {});
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
    // A new total is a new ask: the stored total and revision move, so the old yes cannot pay it.
    update(c, r.order_id, { state: "read", total_cents: got.total, revision: r.revision + 1, lines_json: JSON.stringify(got.lines), tip_cents: got.tip });
    await browser.closeBrowser(c).catch(() => {});
    return { ok: false, total_changed: true, was: dollars(r.total_cents), now: dollars(got.total), use_target: placeTarget(c, r.order_id),
      say_exactly: `The total on DoorDash changed from ${dollars(r.total_cents)} to ${dollars(got.total)} since you said yes, so I didn't place it. ${dollars(got.total)} all in (${breakdownText(got.lines, got.total)}). Place it?`,
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
  const orderNumber = conf[1] ?? "";
  const eta = post.eta || r.eta;
  trust.settleUnknownOutcome({ conversationId: c, action: "doordash_place", target: what, confirmationId: ctx.confirmationId ?? null });
  trust.noteSpend({ conversationId: c, cents: got.total, what, site: "doordash", confirmationId: ctx.confirmationId ?? null });
  update(c, r.order_id, { state: "placed", confirmation: orderNumber, eta });
  const line = await food.placedDirect(c, r.order_id, { amount: dollars(got.total), eta }).catch(() => "");
  await browser.closeBrowser(c).catch(() => {});
  return {
    ok: true, placed: true, order_id: r.order_id, total: dollars(got.total), ...(orderNumber ? { order_number: orderNumber } : {}), eta,
    say_exactly: `${line || `Placed: ${r.restaurant || "your DoorDash order"}, ${dollars(got.total)}${eta ? `, about ${eta}` : ""}. Going to ${r.address}.`} If you want, I can check on it once later.`,
    note: "Send say_exactly as it is, once. The order number is in order_number: give it only if they ask. A status check runs only when they ask (doordash_order status); never on your own.",
  };
}

const STATUS_WORDS = /\b(delivered|on (?:the|its) way|picked up|arriving(?: (?:at|by|in) [^.\n]{1,20})?|preparing|being prepared|heading to you|dasher is [^.\n]{1,40}|order (?:placed|confirmed)|cancell?ed)\b/i;
async function status(c, input, { browser, ownTurn }) {
  const r = rowFor(c, input.order_id);
  if (!r || r.state !== "placed") return { ok: false, error: "There is no DoorDash order Reason placed to check on." };
  // Only when they ask: never a check Reason starts, so no browser minutes go on polling.
  if (!ownTurn) return { ok: false, error: "A status check runs only when they ask for it." };
  const leftSec = remote.monthBudgetMinutes() * 60 - remote.monthSeconds();
  if (leftSec < 120) return { ok: false, say_exactly: "I'm out of hosted-browser time this month, so I can't check it. The DoorDash app shows where it is." };
  const page = await browser.pageFor(c, { url: ORDERS_URL });
  let text = "";
  try { await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded" }); { const stop = await remote.stopIfChallenged(c, page); if (stop) return stop; } text = await browser.pageText(page).catch(() => ""); } catch { text = ""; }
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
    ? ` DoorDash orders run on their own DoorDash account: Reason builds the cart, reads the exact total and places it only on their yes to that total, with the card already on their DoorDash account.`
    : ` DoorDash orders run on their own DoorDash account: Reason builds the cart and reads the exact total, and they place it themselves in DoorDash; Reason never places a DoorDash order.`;
}
