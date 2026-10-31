// Verified offers, and the check every outgoing reply passes before it is sent.
//
// An "offer" here is a price somebody could act on, and the rule is that code writes it from what
// was really read this turn — a live page's own product markup, an AgentCard search result, an
// AgentCard cart — and nothing else. A field the source did not carry is left empty and named in
// `unverified`; it is never filled from what the model remembers about a shop, because a remembered
// return window or shipping fee said as fact is exactly the wrong answer somebody pays for.
//
// The reply check (guardReply) is mechanical on purpose, and it only reads Reason's own outgoing
// text against the sources this turn fetched:
//   - every dollar figure in the reply has to appear in a source fetched this turn (or in the
//     person's own message this turn, or in their own purchase record — purchaseRecordSource in
//     src/purchasesnote.js, passed in as `extraSources`), or it gets the word "unverified" put next
//     to it — ", unverified" inside a parenthesis it already sits in, never a second pair of brackets;
//   - a coupon / discount / sale claim needs a source this turn that mentions one, or a line saying
//     there was none is added;
//   - "best deal" / "cheapest" needs at least two verified offers read this turn, or a line saying
//     exactly what was compared is added;
//   - a purchase ask (confirm_request for purchase_confirm) has to carry the offer record: if the
//     reply does not show AgentCard's total and the source, the code-composed ask line is added.
// Nothing here decides what the person meant. Intent is the model's; this checks figures.
import { clock } from "./config.js";
import * as shop from "./shopconnect.js";

// ---------- "I've started the checkout" ----------
// 2026-10-31 10:58: "I've started the Ulta checkout for the 16 oz. When it gets to payment I'll text
// you the exact total…" — that one had a run behind it, but the shape is the problem: a started line
// is a claim about a job, and the only evidence for it is a run of theirs on record (started in the
// last 15 minutes, or still open). Without one, the claim and the promises hung on it are dropped and
// one honest line goes instead. At 11:17 the opposite line went out — "the checkout never actually
// started" — about a run that had run and died; with a run on record that is corrected from the record.
const START_VERB = /\b(?:started|starting|kicked off|kicking off|began|begun|launched|fired off|got (?:it |that )?going|(?:is|'s|are|was) (?:now )?(?:running|under ?way|in progress|going|live)|(?:is|'s) (?:now )?started|put (?:it |that )?through)\b/i;
const CHECKOUT_WORD = /\b(?:checkout|check-out|check out|order(?:ing)?|purchase|buy(?:ing)?|cart)\b/i;
const START_IT = /\b(?:started|starting|kicked off|launched|began|begun|fired off)\s+(?:it|that|this|one|things)\b/i;
const NOT_A_START = /\b(?:want me to|should i|shall i|can i|could i|do you want|if you want|didn'?t|did not|never|hasn'?t|haven'?t|couldn'?t|wasn'?t|isn'?t|not (?:yet |actually )?(?:started|running)|failed|stopped|expired|once you|when you|before i|after you|i'?ll start|i can start|ready to start|about to start|will start|going to start|let me start)\b/i;
const START_FOLLOWUP = /\b(?:when it (?:gets|reaches|hits)|once it (?:gets|reaches|hits)|i'?ll (?:text|send|message) you|you'?ll get a text|nothing (?:gets|is|will be|'s) charged|until you (?:approve|say)|i'?ll let you know|i'?ll keep you posted)\b/i;
const NEVER_STARTED = /\b(?:never (?:actually |really )?(?:started|ran|began|got going|kicked off)|didn'?t (?:actually |really )?(?:start|run|go through|kick off)|did not (?:actually |really )?(?:start|run)|wasn'?t (?:actually |really )?(?:started|running)|nothing (?:was|is|'s) running|no checkout (?:was|is) running|hadn'?t (?:actually )?started)\b/i;
const HONEST_NOT_STARTED = "I haven't actually started a checkout: nothing is running and nothing has been charged. Want me to start it now?";
const isStartClaim = (s, near) => START_VERB.test(s) && !NOT_A_START.test(s) && !/\?\s*$/.test(s) && (CHECKOUT_WORD.test(s) || (START_IT.test(s) && CHECKOUT_WORD.test(near)));
/** Lines, and each line's sentences: `[[sentence, …], …]`, joined back with the same newlines. */
function sentencesOf(text) { return String(text).split(/(\n+)/).map((part) => (/^\n+$/.test(part) ? part : part.split(/(?<=[.!?])\s+/))); }
const joinBack = (parts) => parts.map((p) => (typeof p === "string" ? p : p.join(" "))).join("").replace(/\n{3,}/g, "\n\n").trim();
export function checkoutClaims(conversationId, text) {
  try {
    if (!conversationId || !text || !shop.connectAllowedFor(conversationId)) return { text, flag: null };
    const parts = sentencesOf(text);
    const all = parts.filter((p) => typeof p !== "string").flat();
    const behind = shop.recentRun(conversationId, { withinMs: 15 * 60_000 });
    let flag = null;
    if (!behind) {
      const claims = all.filter((s, i) => isStartClaim(s, `${all[i - 1] ?? ""} ${all[i + 1] ?? ""}`));
      if (claims.length) {
        const drop = new Set(claims);
        for (const s of all) if (START_FOLLOWUP.test(s)) drop.add(s);
        const kept = parts.map((p) => (typeof p === "string" ? p : p.filter((s) => !drop.has(s))));
        text = [joinBack(kept), HONEST_NOT_STARTED].filter(Boolean).join("\n");
        flag = { rule: "started_without_run", dropped: drop.size };
      }
    }
    // The run being denied is the one that ran and ended (11:17 was about the 10:58 run, not the one
    // just started in the same breath): the oldest ended run of the last half hour, else the oldest open one.
    const half = shop.runsOf(conversationId, { sinceMs: 30 * 60_000 }).reverse();
    const ran = half.find((r) => r.status !== "running") ?? half[0] ?? null;
    if (ran && all.some((s) => NEVER_STARTED.test(s))) {
      const kept = sentencesOf(text).map((p) => (typeof p === "string" ? p : p.filter((s) => !NEVER_STARTED.test(s))));
      const store = shop.storeName(ran.store) || "The store";
      const line = `Correction, from my record: the ${store} checkout${ran.item ? ` for ${ran.item}` : ""} did start ${Math.max(1, Math.round((clock.now() - ran.created_at) / 60_000))} min ago; now: ${shop.stageLine(ran)}.`;
      text = [line, joinBack(kept)].filter(Boolean).join("\n");
      flag = { rule: "never_started_with_run", run_id: ran.run_id };
    }
    return { text, flag };
  } catch {
    return { text, flag: null };
  }
}

// ---------- reading an offer off a page ----------

const LD_BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }
function typeIs(node, name) { return asArray(node?.["@type"]).some(t => String(t).toLowerCase() === name.toLowerCase()); }

/** Every schema.org node on the page, flattened out of @graph and nested arrays. */
function ldNodes(html) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    out.push(n);
    if (n["@graph"]) walk(n["@graph"]);
  };
  for (const m of String(html ?? "").matchAll(LD_BLOCK)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* a broken block is skipped, not guessed at */ }
  }
  return out;
}

function toCents(v) {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!/\d/.test(s)) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp("<meta[^>]+(?:property|name|itemprop)=[\"']" + name.replace(/[.:]/g, "\\$&") + "[\"'][^>]*>", "i");
    const tag = re.exec(String(html ?? ""))?.[0];
    const v = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (v) return v;
  }
  return "";
}

const STOCK = { instock: "in stock", outofstock: "out of stock", preorder: "pre-order", backorder: "backorder", limitedavailability: "limited availability", soldout: "sold out", instoreonly: "in store only", onlineonly: "in stock (online only)", discontinued: "discontinued" };

function readDuration(d) {
  // schema.org ShippingDeliveryTime: transitTime is a QuantitativeValue {minValue, maxValue, unitCode}.
  const t = d?.transitTime ?? null;
  if (!t || typeof t !== "object") return "";
  const code = String(t.unitCode ?? "DAY").toUpperCase();
  const unit = code === "DAY" || code === "D" ? "days" : code === "HUR" || code === "H" ? "hours" : code.toLowerCase();
  if (t.minValue != null && t.maxValue != null) return t.minValue + "–" + t.maxValue + " " + unit;
  if (t.value != null) return t.value + " " + unit;
  if (t.maxValue != null) return "up to " + t.maxValue + " " + unit;
  return "";
}

function readReturns(p) {
  const r = asArray(p).find(x => x && typeof x === "object");
  if (!r) return "";
  const bits = [];
  if (r.merchantReturnDays != null) bits.push(r.merchantReturnDays + "-day returns");
  const cat = String(r.returnPolicyCategory ?? "").split("/").pop();
  if (/NotPermitted/i.test(cat)) bits.push("no returns");
  else if (/Unlimited/i.test(cat)) bits.push("unlimited return window");
  const fees = String(r.returnFees ?? "").split("/").pop();
  if (/FreeReturn/i.test(fees)) bits.push("free returns");
  else if (/ReturnShippingFees|ReturnFeesCustomerResponsibility/i.test(fees)) bits.push("buyer pays return shipping");
  return bits.join(", ");
}

const CHECKED = { price_cents: "price", stock: "stock", seller: "seller", shipping_cents: "shipping cost", shipping_time: "shipping time", return_terms: "return terms", url: "url" };

/** The names of the fields this record could not verify, in plain words. */
export function unverifiedOf(rec) {
  return Object.entries(CHECKED).filter(([k]) => rec[k] == null || rec[k] === "").map(([, v]) => v);
}

const money = (cents) => "$" + (Number(cents) / 100).toFixed(2);

/**
 * An offer record from one page's HTML, by its own schema.org Product/Offer markup (falling back to
 * the product:price meta tags for the price alone). Fields the markup does not carry come back
 * empty and are listed in `unverified`. `url` is the page that was fetched; `fetchedAt` when.
 */
export function offerFromHtml(html, url, fetchedAt = Date.now()) {
  const nodes = ldNodes(html);
  const product = nodes.find(n => typeIs(n, "Product") || typeIs(n, "ProductGroup")) ?? null;
  let offer = null;
  if (product) {
    const offers = asArray(product.offers).flatMap(o => typeIs(o, "AggregateOffer") ? [o, ...asArray(o.offers)] : [o]);
    offer = offers.find(o => o && (o.price != null || o.lowPrice != null || o.priceSpecification)) ?? offers[0] ?? null;
  } else {
    offer = nodes.find(n => typeIs(n, "Offer")) ?? null;
  }
  const spec = asArray(offer?.priceSpecification)[0];
  let price = toCents(offer?.price ?? spec?.price ?? null);
  let currency = String(offer?.priceCurrency ?? spec?.priceCurrency ?? "");
  if (price == null && offer?.lowPrice != null) price = toCents(offer.lowPrice);
  if (price == null) {
    price = toCents(metaContent(html, ["product:price:amount", "og:price:amount"]));
    if (price != null) currency = currency || metaContent(html, ["product:price:currency", "og:price:currency"]);
  }
  const availRaw = offer?.availability ?? metaContent(html, ["product:availability", "og:availability"]);
  const avail = String(availRaw ?? "").split("/").pop().toLowerCase().replace(/[^a-z]/g, "");
  const ship = asArray(offer?.shippingDetails)[0];
  const rate = asArray(ship?.shippingRate)[0];
  const seller = typeof offer?.seller === "string" ? offer.seller : (offer?.seller?.name ?? "");
  const rec = {
    source: "page",
    url: String(url ?? ""),
    product: String(product?.name ?? metaContent(html, ["og:title"]) ?? "").trim(),
    product_id: String(product?.sku ?? product?.gtin13 ?? product?.gtin12 ?? product?.mpn ?? ""),
    seller: String(seller || "").trim(),
    price_cents: price,
    currency,
    stock: STOCK[avail] ?? "",
    shipping_cents: rate?.value != null ? toCents(rate.value) : null,
    shipping_time: readDuration(ship?.deliveryTime),
    return_terms: readReturns(offer?.hasMerchantReturnPolicy ?? product?.hasMerchantReturnPolicy),
    fetched_at: fetchedAt,
  };
  rec.unverified = unverifiedOf(rec);
  return rec;
}

/**
 * An offer record from an AgentCard cart. The price is AgentCard's all-in total, labelled as such.
 * Shipping cost is read only from a fee line AgentCard itself labelled shipping/delivery; stock,
 * shipping time and return terms are not in a cart, so they are unverified.
 */
export function offerFromCart(cart, { buyConversationId = "", fetchedAt = Date.now() } = {}) {
  if (!cart) return null;
  const first = cart.items?.[0] ?? {};
  const shipLine = (cart.fee_lines ?? []).find(f => /ship|deliver/i.test(f.label));
  const url = [first.url, first.product_id, first.link].find(u => /^https?:\/\//i.test(String(u ?? ""))) ?? "";
  const rec = {
    source: "agentcard_cart",
    url,
    product: (cart.items ?? []).map(i => (i.qty > 1 ? i.qty + "× " + i.name : i.name)).join(", "),
    product_id: first.product_id || first.ref || "",
    seller: cart.merchant_name || cart.merchant || "",
    price_cents: Number.isFinite(cart.total_cents) ? cart.total_cents : null,
    currency: cart.currency || "",
    stock: "",
    shipping_cents: shipLine ? shipLine.amount_cents : null,
    shipping_time: "",
    return_terms: "",
    buy_conversation_id: buyConversationId,
    fetched_at: fetchedAt,
  };
  rec.unverified = unverifiedOf(rec);
  return rec;
}

/** An offer record from one AgentCard search result (price and link only; the rest is unverified). */
export function offerFromCatalogItem(item, merchant, { fetchedAt = Date.now() } = {}) {
  const rec = {
    source: "agentcard_catalog",
    url: item.url || "",
    product: item.name || "",
    product_id: item.product_id || item.link || "",
    seller: merchant || "",
    price_cents: Number.isFinite(item.price_cents) && item.price_cents > 0 ? item.price_cents : null,
    currency: "", stock: "", shipping_cents: null, shipping_time: "", return_terms: "",
    fetched_at: fetchedAt,
  };
  rec.unverified = unverifiedOf(rec);
  return rec;
}

/** An offer as the model and the person see it: every field, with "unverified" where it is. */
export function offerView(row) {
  if (!row) return null;
  const un = new Set(row.unverified ?? unverifiedOf(row));
  const v = (k, val) => (un.has(k) ? "unverified" : val);
  const cur = row.currency && row.currency.toUpperCase() !== "USD" ? " " + row.currency : "";
  return {
    offer_id: row.id,
    source: row.source,
    url: row.url || "unverified",
    product: row.product || "unverified",
    seller: v("seller", row.seller),
    price: v("price", row.price_cents != null ? money(row.price_cents) + cur : ""),
    stock: v("stock", row.stock),
    shipping_cost: v("shipping cost", row.shipping_cents === 0 ? "free" : row.shipping_cents != null ? money(row.shipping_cents) : ""),
    shipping_time: v("shipping time", row.shipping_time),
    return_terms: v("return terms", row.return_terms),
    fetched_at: new Date(Number(row.fetched_at)).toISOString(),
    unverified: [...un],
  };
}

// ---------- reading a product page, the one way both offer_check and a price watch do it ----------

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
// What a shop says when it does not want to be read by a machine. A price watch that hears one of
// these stops (src/deals.js): retrying, switching user agents or going round through a browser is a
// workaround, and a watch is never worth that.
const BLOCK_STATUSES = new Set([401, 403, 429, 451]);

/**
 * Fetch one product page. { ok, html, url } or { ok: false, status?, blocked, error }. `blocked` is
 * true only for an answer that means "no robots": the statuses above, or a 503 a bot wall labelled.
 */
export async function fetchOfferPage(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let parsed;
  try { parsed = new URL(String(url ?? "").trim()); } catch { return { ok: false, blocked: false, invalid: true, error: `'${url}' is not a link.` }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, blocked: false, invalid: true, error: "Only http and https pages can be read." };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(parsed.href, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" } });
    if (!res.ok) {
      const walled = res.status === 503 && !!res.headers?.get?.("cf-mitigated");
      return { ok: false, status: res.status, blocked: BLOCK_STATUSES.has(res.status) || walled, error: `the shop answered ${res.status}` };
    }
    return { ok: true, html: (await res.text()).slice(0, 3_000_000), url: res.url || parsed.href };
  } catch (e) {
    return { ok: false, blocked: false, error: e?.name === "AbortError" ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : (e?.message ?? String(e)).split("\n")[0] };
  } finally { clearTimeout(timer); }
}

/**
 * Is `next` a verified drop from `prev`? Both have to be priced offer records, in the same currency.
 * Anything less is not a drop: a price that could not be read is not a lower price.
 */
export function verifiedDrop(prev, next) {
  if (prev?.price_cents == null || next?.price_cents == null) return { drop: false, why: "not both verified" };
  const cur = (o) => String(o.currency || "USD").toUpperCase();
  if (cur(prev) !== cur(next)) return { drop: false, why: "different currencies" };
  if (!(Number(next.price_cents) < Number(prev.price_cents))) return { drop: false, why: "not lower" };
  return { drop: true, by_cents: Number(prev.price_cents) - Number(next.price_cents) };
}

export { money };

// ---------- matching a cart line against the offer that was picked ----------

/** A product's identity from a url or id: the shop's own id where the url carries one, else host+path. */
export function productKey(x) {
  const s = String(x ?? "").trim();
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { return s.toLowerCase(); }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const p = u.pathname;
  const asin = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i.exec(p)?.[1];
  if (/amazon\./.test(host) && asin) return "amazon:" + asin.toUpperCase();
  const wm = /\/ip\/(?:[^/]+\/)?(\d+)/.exec(p)?.[1];
  if (/walmart\.com$/.test(host) && wm) return "walmart:" + wm;
  const tg = /\/A-(\d+)/.exec(p)?.[1];
  if (/target\.com$/.test(host) && tg) return "target:" + tg;
  const bb = u.searchParams.get("skuId") || /\/(\d{6,8})\.p/.exec(p)?.[1];
  if (/bestbuy\.com$/.test(host) && bb) return "bestbuy:" + bb;
  return (host + p.replace(/\/+$/, "")).toLowerCase();
}

/**
 * Does any cart line carry the offer's product? Compared on AgentCard's product_id/ref and the
 * line's url against the offer's product_id and url — ids only, never names. Returns
 * { match, line } or { match: false, offered, got } so a mismatch can be shown as the difference.
 */
export function matchCartToOffer(cart, offer) {
  const want = new Set([offer?.product_id, offer?.url].map(productKey).filter(Boolean));
  const lines = cart?.items ?? [];
  for (const line of lines) {
    const have = [line.product_id, line.ref, line.url, line.link].map(productKey).filter(Boolean);
    if (have.some(k => want.has(k))) return { match: true, line };
  }
  return {
    match: false,
    offered: { product: offer?.product || "", seller: offer?.seller || "", url: offer?.url || "", product_id: offer?.product_id || "", price: offer?.price_cents != null ? money(offer.price_cents) : "unverified" },
    got: lines.map(l => ({ name: l.name, qty: l.qty, price: l.price, product_id: l.product_id || l.ref || "", url: l.url || "" })),
  };
}

// ---------- the turn's sources, and the reply check ----------

const turns = new Map(); // conversationId -> { sources: string[], offers: object[], asks: object[] }

/** Start a turn: forget last turn's sources. The person's own message this turn counts as a source. */
export function beginTurn(conversationId, ownText = "", kind = "user") {
  // `own` and `kind` are kept apart from the sources for deal_watch_set (src/tools.js): a price
  // watch is only made on a turn THEY started, from words that are really in their message.
  // `started_at` is for flight_traveler_confirm: details read back on an earlier turn can only be
  // agreed to on a later one, so "those are right" is never the same turn that wrote them.
  turns.set(conversationId, { sources: ownText ? [String(ownText)] : [], offers: [], asks: [], own: String(ownText ?? ""), kind, started_at: clock.now() });
}
function turnOf(conversationId) {
  if (!turns.has(conversationId)) beginTurn(conversationId);
  return turns.get(conversationId);
}
/** Whatever a tool handed back this turn, kept as text to check figures against. */
export function noteSource(conversationId, value) {
  if (!conversationId || value == null) return;
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { return; }
  if (text) turnOf(conversationId).sources.push(text.slice(0, 400_000));
}
/** An offer record written this turn. */
export function noteOffer(conversationId, row) { if (row) turnOf(conversationId).offers.push(row); }
/** A money ask put to the person this turn, with the line it has to carry. */
export function noteAsk(conversationId, ask) { if (ask) turnOf(conversationId).asks.push(ask); }
export function turnState(conversationId) { return turnOf(conversationId); }

// A figure never ends on a comma: "$3, now $4" is "$3", or its label lands after the comma.
const REPLY_MONEY = /(?:US)?\$\s?\d(?:[\d,]*\d)?(?:\.\d{1,2})?(?:k\b|K\b)?/g;

/** Every amount in a piece of source text, as cents. Lenient on purpose: a source is evidence, not prose. */
function sourceAmounts(text) {
  const out = new Set();
  const t = String(text);
  const add = (s, scale = 100) => { const n = Number(String(s).replace(/,/g, "")); if (Number.isFinite(n)) out.add(Math.round(n * scale)); };
  for (const m of t.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) add(m[1]);
  for (const m of t.matchAll(/(?<![\d.])(\d[\d,]*\.\d{2})(?!\d)/g)) add(m[1]);
  for (const m of t.matchAll(/(?:_cents|Cents)\\?"?\s*:\s*(\d+)/g)) add(m[1], 1);
  for (const m of t.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|USD)\b/gi)) add(m[1]);
  for (const m of t.matchAll(/(?:USD|price\\?"?\s*:\s*\\?"?)\s?(\d[\d,]*(?:\.\d{1,2})?)/gi)) add(m[1]);
  return out;
}

/** Is `offset` inside an open "(" on its own line? A stray ")" (a smiley) never takes it below zero. */
function insideParens(whole, offset) {
  let depth = 0;
  for (let i = whole.lastIndexOf("\n", offset - 1) + 1; i < offset; i++) {
    if (whole[i] === "(") depth++;
    else if (whole[i] === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

function replyAmountCents(s) {
  const k = /k$/i.test(s.trim());
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Math.round(n * (k ? 1000 : 1) * 100);
}

const DISCOUNT = /\b(coupons?|promo(?:tional)? codes?|promos?|discounts?|vouchers?|\d{1,2}\s?% off|percent off|on sale|sale price|price drop|clearance|markdown|deal ends)\b/i;
const DISCOUNT_SOURCE = /coupon|promo|discount|voucher|% off|percent off|sale|clearance|markdown|save \$|was \$|list price/i;
/** A whole bracketed line that is a tool's note, not words to a person: "(compared: a seller $18.99, …)". */
export const TOOL_NOTE_LINE = /^\s*\((?:compared|tool note|internal|debug)\s*:.*\)\s*$|^\s*\(.*\ba seller \$\d.*\)\s*$/i;
const BEST = /\b(best (?:deal|price|value|offer)|cheapest|lowest(?:-| )price[ds]?|lowest cost|least expensive|can't beat|cannot beat)\b/i;

// "I'll find the cheapest total" is a promise, not a claim: no correction under it (cage, 2026-10-31).
const ABOUT_TO = /\b(?:find(?:ing)?|look(?:ing)? for|search(?:ing)? for|hunt(?:ing)? for|check(?:ing)?|compar(?:e|ing)|get you|track(?:ing)? down|looking)\b[^.!?\n—–;:,]{0,16}$/i;
// "That's not a proven best deal" already says the thing the correction would.
const SAYS_NOT = /\b(?:not|no|isn't|isnt|never|can't say|cannot say)(?:\s+(?:a|an|the|really|necessarily|proven|checked|verified|confirmed|guaranteed))*\s*$/i;
/** Does the text say something IS the best / cheapest (not that it will go looking for it)? */
export function claimsBest(text) {
  const re = new RegExp(BEST.source, "gi");
  for (const m of String(text ?? "").matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!ABOUT_TO.test(before) && !SAYS_NOT.test(before)) return true;
  }
  return false;
}

/**
 * The check, on the text about to be sent — the turn's reply, and every message_send mid-turn
 * (src/tools.js), which until 2026-10-23 went out unchecked. `asks: false` leaves rule 4 to the
 * reply; `extraSources` adds text that counts as evidence for this one message (the person's own
 * words when it is sent exactly as they asked). Returns { text, changed, flags } — `text` is what to send.
 * `flags` names every rule that fired, for the log. Never throws: a broken check must not eat a reply.
 */
export function guardReply(conversationId, reply, { asks = true, extraSources = [] } = {}) {
  try {
    if (!reply || typeof reply !== "string") return { text: reply, changed: false, flags: [] };
    const t = turnOf(conversationId);
    const known = new Set();
    for (const s of [...t.sources, ...extraSources.filter(Boolean).map(String)]) for (const c of sourceAmounts(s)) known.add(c);
    const flags = [];

    // 1. Dollar figures: in a source this turn, or labelled. A figure already inside a parenthesis
    // gets ", unverified" rather than a bracket of its own: "($18.99)" became "($18.99 (unverified))"
    // on 2026-10-24, and nested brackets in a text read as broken.
    const unlabelled = [];
    // 0. A tool's bookkeeping line copied into the text ("(compared: a seller $18.99, …)") never goes out.
    const original = reply;
    const noted = reply.split("\n");
    const kept = noted.filter(l => !TOOL_NOTE_LINE.test(l));
    if (kept.length < noted.length) {
      flags.push({ rule: "tool_note_stripped", lines: noted.length - kept.length });
      reply = kept.join("\n").replace(/\n+$/, "");
    }
    let text = reply.replace(REPLY_MONEY, (m, offset, whole) => {
      if (known.has(replyAmountCents(m))) return m;
      const near = whole.slice(Math.max(0, offset - 40), offset + m.length + 40);
      if (/unverified/i.test(near)) return m;
      unlabelled.push(m.trim());
      return insideParens(whole, offset) ? m + ", unverified" : m + " (unverified)";
    });
    if (unlabelled.length) flags.push({ rule: "dollar_unsourced", figures: unlabelled });

    const extra = [];
    // 2. Coupon / discount claims need a live source this turn.
    if (DISCOUNT.test(reply) && !t.sources.some(s => DISCOUNT_SOURCE.test(s.slice(0, 200_000)))) {
      flags.push({ rule: "discount_unsourced" });
      extra.push("(i didn't find a live source for any coupon or discount this time, so don't count on one.)");
    }
    // 3. "Best deal" needs a comparison set of verified offers; otherwise say what was compared.
    // A flight search or date sweep this turn IS the comparison set (src/flightsearch.js): "the
    // cheapest dates are early december" is read off the fares it just pulled, and a line about not
    // comparing sellers under it is wrong. Its own limits ("from $X", not every fare) ride in the
    // tool result.
    if (claimsBest(reply) && !t.faresCompared) {
      const priced = t.offers.filter(o => o.price_cents != null);
      if (priced.length < 2) {
        flags.push({ rule: "best_unsupported", compared: priced.length });
        extra.push(priced.length
          ? "(that's not a checked best price — i only looked at " + (priced[0].seller || "one seller") + ": " + money(priced[0].price_cents) + ".)"
          : "(that's not a checked best price — i didn't compare sellers this time.)");
      } else if (!priced.every(o => text.includes(money(o.price_cents)))) {
        // Compared for real: logged, never glued onto the text. "(compared: a seller $18.99, …)"
        // under the owner's CeraVe options on 2026-10-31 read as debug output, not an answer.
        flags.push({ rule: "best_compared_listed", compared: priced.length });
      }
    }
    // 4. A purchase ask carries its offer record: AgentCard's total and the source.
    // Only on the reply: a message sent mid-turn (message_send) is not where the ask is put, and
    // the ask line glued onto a text to somebody else would be wrong twice over.
    for (const ask of asks ? t.asks : []) {
      if (!ask?.line) continue;
      const hasTotal = !ask.total || text.includes(ask.total);
      const hasSource = !ask.url || text.includes(ask.url);
      if (!hasTotal || !hasSource) { flags.push({ rule: "ask_without_offer" }); extra.push(ask.line); }
    }
    // 5. "I've started the checkout" needs a checkout run behind it (src/shopconnect.js): one of
    // theirs started in the last 15 minutes or still open. On 2026-10-31 the opposite happened too —
    // "the checkout never actually started" about a run that had run and died — so a never-started
    // line with a run on record is corrected from the record as well.
    const started = checkoutClaims(conversationId, text);
    if (started.flag) { flags.push(started.flag); text = started.text; }
    if (extra.length) text = text + "\n" + extra.join("\n");
    return { text, changed: text !== original, flags };
  } catch {
    return { text: reply, changed: false, flags: [{ rule: "guard_error" }] };
  }
}

