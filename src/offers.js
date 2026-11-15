// Verified offers, and the check every outgoing reply passes before it is sent.
//
// An "offer" here is a price somebody could act on, and the rule is that code writes it from what
// was really read this turn — a live page's own product markup, an AgentCard search result, an
// AgentCard cart — and nothing else. A field the source did not carry is left empty and named in
// `unverified`; it is never filled from what the model remembers about a shop, because a remembered
// return window or shipping fee said as fact is exactly the wrong answer somebody pays for.
//
// The reply check (guardReply) reads Reason's own outgoing text against what is known:
//   - a dollar figure is known when a tool read it this turn, when it is THEIRS — anything they said
//     or sent in the last weeks of the thread (texts, voice notes, what was read off their photos and
//     screenshots), their purchase and checkout record — or when Reason remembers it about them
//     (saved facts, the profile). Known figures are never hedged. A remembered price older than two
//     weeks is said with its date. A figure that is none of those is NOT labelled by code: the reply
//     goes back to the model once (Runtime._turn) to check it with a tool, or to say ONCE, in its own
//     words, that it hasn't confirmed it. Until 2026-11-05 code stamped "(unverified)" after every
//     such figure — 618 times in a week, on people's own budgets and balances;
//   - a coupon / discount / sale claim needs something read or theirs that mentions one, or the
//     model is sent back to check it or drop it; on the rewrite, a deal still unchecked comes out;
//   - "best deal" / "cheapest" needs at least two verified offers read this turn, or the model is
//     sent back to compare or say what it looked at;
//   - a purchase ask (confirm_request for purchase_confirm) has to carry the offer record: if the
//     reply does not show AgentCard's total and the source, the code-composed ask line is added.
// Nothing here decides what the person meant. Intent is the model's; this checks figures.
import { guardedFetch } from "./netguard.js";
import { clock } from "./config.js";
import * as shop from "./shopconnect.js";
import { choiceWording } from "./choicecards.js";
import * as db from "./db.js";

// ---------- "I've started the checkout" ----------
// 2026-10-31 10:58: "I've started the Ulta checkout for the 16 oz. When it gets to payment I'll text
// you the exact total…" — that one had a run behind it, but the shape is the problem: a started line
// is a claim about a job, and the only evidence for it is a run of theirs on record (started in the
// last 15 minutes, or still open). Without one, the claim and the promises hung on it are dropped and
// one honest line goes instead. At 11:17 the opposite line went out — "the checkout never actually
// started" — about a run that had run and died; with a run on record that is corrected from the record.
// Reason, in the first person, saying it started the checkout/order/purchase; or the checkout itself
// said to be started/running. Never "your Amazon order is in progress, per the email", "I started
// looking into the order", "I've started a list of things to buy": those are not claims about a job here.
const CHECKOUT_WORD = /\b(?:checkout|check-out|check out|order|purchase)\b/i;
const I_STARTED = /\bi(?:'ve| have|'m| am| just|'ve just| have just)?\s+(?:just\s+)?(?:started|kicked off|launched|began|begun|fired off|put through|placed)\s+(?!(?:\w+ing)\b)(?:the |a |an |your |that |this )?(?:[\w'-]+ ){0,4}?(?:checkout|check-out|order|purchase)\b/i;
const CHECKOUT_IS = /\b(?:checkout|check-out|order|purchase)(?:'s| is| has)\s+(?:now\s+)?(?:started|running|under ?way|underway|in progress|live|begun|going through)\b/i;
const START_IT = /\bi(?:'ve| have)?\s+(?:just\s+)?(?:started|kicked off|launched|began|begun|fired off)\s+(?:it|that|this|one)\b/i;
const NOT_A_START = /\b(?:want me to|should i|shall i|can i|could i|do you want|if you want|didn'?t|did not|never|hasn'?t|haven'?t|couldn'?t|wasn'?t|isn'?t|not (?:yet |actually )?(?:started|running)|failed|stopped|expired|once you|when you|before i|after you|i'?ll start|i can start|ready to start|about to start|will start|going to start|let me start|per (?:the|your)|according to|says|said|tracking|delivery|arrived|shipped|email|mail)\b/i;
const START_FOLLOWUP = /\b(?:when it (?:gets|reaches|hits)|once it (?:gets|reaches|hits)|i'?ll (?:text|send|message) you|you'?ll get a text|nothing (?:gets|is|will be|'s) charged|until you (?:approve|say)|i'?ll let you know|i'?ll keep you posted)\b/i;
// A denial about STARTING only: "didn't go through" is a true line about a run that ran and failed.
const NEVER_STARTED = /\b(?:never (?:actually |really )?(?:started|ran|began|got going|kicked off)|didn'?t (?:actually |really )?(?:start|run|kick off)|did not (?:actually |really )?(?:start|run)|wasn'?t (?:actually |really )?(?:started|running)|nothing (?:was|is|'s) running|no checkout (?:was|is) running|hadn'?t (?:actually )?started)\b/i;
const SELF_BUY_HEDGE = /\b(?:if you(?:'d| would) rather(?: just)? (?:buy|order|finish|place|check out|checkout) (?:it|this|the order|that)(?: yourself| on your own)?|if you(?:'d| would) rather(?: just)? (?:get|grab|do) (?:it|this|that) yourself|(?:buy|order|finish|place|check out) (?:it|this|the order) (?:yourself|on your own)|here'?s the (?:page|link) (?:if|in case) you(?:'d| would)? (?:rather|want to|prefer to) (?:buy|order|finish|place|do|get) (?:it|this|that|the order))\b/i;
// The record against the draft (audit 11-11): the newest run of the last two hours decides. "Nothing's
// charged" after a payment went out (10-31 14:10, Walmart), "started / running" about a run that ended
// failed or cancelled (10-31 10:58), "declined" about a payment Reason called off itself (10-30 20:00).
const NOTHING_CHARGED = /\b(?:nothing(?:'s| is| has| was| got| gets| will be)?(?: been)? (?:charged|paid|gone (?:out|through))|nothing goes (?:out|through)|(?:you )?(?:haven'?t|hasn'?t|have not|has not|weren'?t|wasn'?t|were not|was not|aren'?t|are not|won'?t be|not) (?:been |yet been |be )?charged|no charge (?:yet|has|went)|(?:you )?(?:haven'?t|have not) paid)\b/i;
const SAYS_DECLINED = /\b(?:was|got|been|were|is|it|they|card|payment|store|merchant)\s+(?:\w+\s+){0,2}?declined\b|\bdeclined (?:it|the (?:card|payment|order|charge))\b/i;
const recordLine = (run) => `Actually, checking my record: the ${shop.storeName(run.store) || "store"} checkout${run.item ? ` for ${run.item}` : ""}: ${shop.stageLine(run)}.`;
/** Sentences that say the opposite of the newest run's record go; one line from the record goes first. */
function againstRecord(conversationId, text) {
  const latest = shop.runsOf(conversationId, { sinceMs: 2 * 3600_000, limit: 1 })[0];
  if (!latest) return null;
  const charged = shop.chargedOf(latest);
  const all = sentencesOf(text).filter((p) => typeof p !== "string").flat();
  const about = aboutCheckout(turnOf(conversationId).own, latest);
  const tests = [];
  if (/^(?:yes|unknown|being paid)/.test(charged) && about) tests.push(["charged_contradicts_record", (s) => NOTHING_CHARGED.test(s)]);
  if (["failed", "cancelled"].includes(latest.stage) && !shop.runsOf(conversationId, { sinceMs: 2 * 3600_000 }).some((r) => r.status === "running"))
    tests.push(["running_contradicts_record", (s, i) => isStartClaim(s, `${all[i - 1] ?? ""} ${all[i + 1] ?? ""}`)]);
  if (shop.stoppedByReason(latest) && about) tests.push(["declined_contradicts_record", (s) => SAYS_DECLINED.test(s) && !/\?\s*$/.test(s)]);
  for (const [rule, hit] of tests) {
    const drop = new Set(all.filter((s, i) => hit(s, i)));
    if (!drop.size) continue;
    if (rule === "charged_contradicts_record") for (const s of all) if (START_FOLLOWUP.test(s)) drop.add(s);
    const kept = sentencesOf(text).map((p) => (typeof p === "string" ? p : p.filter((s) => !drop.has(s)))).filter((p) => typeof p === "string" || p.length);
    return { text: [recordLine(latest), joinBack(kept)].filter(Boolean).join("\n"), flag: { rule, run_id: latest.run_id } };
  }
  return null;
}
const HONEST_NOT_STARTED ="I haven't actually started a checkout: nothing is running and nothing has been charged. Want me to start it now?";
const isStartClaim = (s, near) => !NOT_A_START.test(s) && !/\?\s*$/.test(s) && (I_STARTED.test(s) || CHECKOUT_IS.test(s) || (START_IT.test(s) && CHECKOUT_WORD.test(near)));
const ABOUT_BUYING = /\b(?:checkout|check-?out|order(?:s|ed)?|purchase[sd]?|buy|bought|buying|cart|shop(?:ping)?|pay(?:ment|ing)?|paid|charge[sd]?|store)\b/i;
/** Is what they wrote this turn about the checkout: its words, the store, or the item? Nothing written (an event turn) is. */
export function aboutCheckout(own, run) {
  const text = String(own ?? "").trim();
  if (!text) return true;
  if (ABOUT_BUYING.test(text)) return true;
  const store = shop.storeName(run?.store) || run?.store || "";
  if (store && new RegExp(`\\b${store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return true;
  return !!run?.item && shop.mentionsItem(text, run.item);
}
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
    // Only a denial ABOUT the checkout: "the timer never started" is somebody else's business.
    const denies = (s, i) => NEVER_STARTED.test(s) && (CHECKOUT_WORD.test(s) || /\bnothing was running\b/i.test(s) || (/\bit (?:never|didn'?t|did not|wasn'?t)\b/i.test(s) && CHECKOUT_WORD.test(`${all[i - 1] ?? ""} ${all[i + 1] ?? ""}`)));
    // And only on a turn where THEY asked about the checkout (14:18 on 2026-10-31: "Look at the time of
    // it", about a card charge, got "Correction, from my record: …" in front of the answer). A turn with
    // no words of theirs (an event about the run) counts as about it.
    if (ran && aboutCheckout(turnOf(conversationId).own, ran) && all.some(denies)) {
      const drop = new Set(all.filter(denies));
      const kept = sentencesOf(text).map((p) => (typeof p === "string" ? p : p.filter((s) => !drop.has(s))));
      const store = shop.storeName(ran.store) || "The store";
      const line = `Actually, checking my record: the ${store} checkout${ran.item ? ` for ${ran.item}` : ""} did start ${Math.max(1, Math.round((clock.now() - ran.created_at) / 60_000))} min ago; now: ${shop.stageLine(ran)}.`;
      text = [line, joinBack(kept)].filter(Boolean).join("\n");
      flag = { rule: "never_started_with_run", run_id: ran.run_id };
    }
    if (!flag) { const r = againstRecord(conversationId, text); if (r) ({ text, flag } = r); }
    // A checkout Reason started is Reason's to finish (owner, 2026-10-31 12:17): "Here's the page if
    // you'd rather just buy it yourself" — and the bare store link under it — goes, while a run of theirs is open or just ran.
    if (behind || half.length) {
      const parts2 = sentencesOf(text);
      const all2 = parts2.filter((p) => typeof p !== "string").flat();
      const hedges = all2.filter((s) => SELF_BUY_HEDGE.test(s));
      if (hedges.length) {
        const drop = new Set(hedges);
        all2.forEach((s, i) => { if (i > 0 && drop.has(all2[i - 1]) && /^\s*https?:\/\/\S+\s*$/.test(s)) drop.add(s); });
        // A line emptied by the drop goes with its newline, so no blank line is left where it was.
        const kept = parts2.map((p) => (typeof p === "string" ? p : p.filter((s) => !drop.has(s)))).filter((p) => typeof p === "string" || p.length);
        const squeezed = kept.filter((p, i) => !(typeof p === "string" && typeof kept[i - 1] === "string"));
        text = joinBack(squeezed);
        flag = flag ?? { rule: "self_buy_hedge", dropped: drop.size };
      }
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
export async function fetchOfferPage(url, { fetchImpl = null, timeoutMs = 15_000 } = {}) {
  let parsed;
  try { parsed = new URL(String(url ?? "").trim()); } catch { return { ok: false, blocked: false, invalid: true, error: `'${url}' is not a link.` }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, blocked: false, invalid: true, error: "Only http and https pages can be read." };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Never this machine's own network, on any hop (src/netguard.js).
    const got = await guardedFetch(parsed.href, { fetchImpl, signal: ctl.signal, headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" } });
    if (!got.ok) return { ok: false, blocked: false, invalid: true, error: `That page was not read: ${got.why}.` };
    const res = got.res;
    if (!res.ok) {
      const walled = res.status === 503 && !!res.headers?.get?.("cf-mitigated");
      return { ok: false, status: res.status, blocked: BLOCK_STATUSES.has(res.status) || walled, error: `the shop answered ${res.status}` };
    }
    return { ok: true, html: (await res.text()).slice(0, 3_000_000), url: got.url || parsed.href };
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

/**
 * Start a turn: forget last turn's sources. The person's own message this turn counts as a source.
 * `carry`: this is the one rewrite of a draft the check sent back (Runtime._turn) — the same turn
 * going on, so what its tools already read still counts, the rewrite instruction (which quotes the
 * draft) is NOT a source, and the check on the rewrite is the last one (`recomposed`).
 */
export function beginTurn(conversationId, ownText = "", kind = "user", { carry = false } = {}) {
  const prev = turns.get(conversationId);
  if (carry && prev) { prev.recomposed = true; prev.recompose = null; return; }
  // `own` and `kind` are kept apart from the sources for deal_watch_set (src/tools.js): a price
  // watch is only made on a turn THEY started, from words that are really in their message.
  // `started_at` is for flight_traveler_confirm: details read back on an earlier turn can only be
  // agreed to on a later one, so "those are right" is never the same turn that wrote them.
  turns.set(conversationId, { sources: ownText ? [String(ownText)] : [], offers: [], asks: [], own: String(ownText ?? ""), kind, started_at: clock.now(), warned: new Set(), recompose: null, recomposed: !!carry });
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
/**
 * The photos looked at this turn, as a reader of their words (src/looked.js capturedWords, bound by
 * the backend). Kept on the turn so every check of it reads them: a message_send mid-turn, and the
 * one rewrite, which runs with no attachments of its own (review 11-07: a figure read off their
 * screenshot was dropped from the rewrite as unchecked). Set once, on the turn that looked.
 */
export function notePhotos(conversationId, read) { if (conversationId && typeof read === "function") turnOf(conversationId).photos = read; }
/** What this turn's photos said: { texts, unread }. Nothing looked at: no words, nothing unread. */
export async function photoWords(conversationId) {
  const read = turns.get(conversationId)?.photos;
  if (!read) return { texts: [], unread: false };
  try { return (await read()) ?? { texts: [], unread: true }; } catch { return { texts: [], unread: true }; }
}

// A figure never ends on a comma: "$3, now $4" is "$3". Said with a sign ("$40", "£40", "€40"), a code
// ("USD 40") or a word ("40 dollars", "40 bucks"): until gate 11-05 only the "$" form was read, so
// "1299 dollars" went out unchecked.
const MONEY_NUM = String.raw`\d(?:[\d,]*\d)?(?:\.\d{1,2})?`;
const REPLY_MONEY = new RegExp(String.raw`(?:US)?[$£€]\s?${MONEY_NUM}(?:k\b|K\b)?|\bUSD\s?${MONEY_NUM}|(?<![\d.,$£€])${MONEY_NUM}\s?(?:[Dd]ollars|[Bb]ucks|USD)\b`, "g");

// An inline reply arrives with a line code wrote quoting the message it answers (src/replies.js
// inboundReplyLine) — usually Reason's own. Those words are not theirs: a figure Reason made up and
// they replied under would otherwise vouch for itself, on this turn and for weeks in their history.
const QUOTED_LINE = /^\[they sent this as an inline reply\b[^\n]*$/gm;
const ownWords = (s) => String(s ?? "").replace(QUOTED_LINE, "");

/** Every amount in a piece of source text, as cents. Lenient on purpose: a source is evidence, not prose. */
function sourceAmounts(text, { bare = false } = {}) {
  const out = new Set();
  const t = String(text);
  const add = (s, scale = 100) => { const n = Number(String(s).replace(/,/g, "")); if (Number.isFinite(n)) out.add(Math.round(n * scale)); };
  for (const m of t.matchAll(/[$£€]\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) add(m[1]);
  for (const m of t.matchAll(/(?<![\d.])(\d[\d,]*\.\d{1,4})(?!\d)/g)) add(m[1]);
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?![\d,])/g)) add(m[1]);
  for (const m of t.matchAll(/(?:_cents|Cents)\\?"?\s*:\s*(\d+)/g)) add(m[1], 1);
  for (const m of t.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|bucks|USD)\b/gi)) add(m[1]);
  for (const m of t.matchAll(/(?:USD|price\\?"?\s*:\s*\\?"?)\s?(\d[\d,]*(?:\.\d{1,2})?)/gi)) add(m[1]);
  // "4k" — in their words only when used as money ("budget is 5k"), never "ran a 5k" (review 11-07).
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s?k\b/gi)) if (!bare || usedAsMoney(t, m.index, m.index + m[0].length)) add(m[1], 100_000);
  // What THEY wrote, sent or are remembered by: a plain number in it counts too — but only one they
  // used as money ("keep it under 100", "rent is 1850", "dinner was 84, what's the tip"), never every
  // number they typed: a zip, a room, an age or "45 minutes" vouched for any invented $10001 or $45
  // (review 11-05). Not a small one — "3 of us", "at 4" — nor a year. A tool's JSON is never read
  // this way: its ids and timestamps are not prices.
  if (bare) {
    for (const m of t.matchAll(/(?<![\d.,:\/-])(\d[\d,]*)(?![\d.,:\/]?\d)/g)) {
      const n = Number(m[1].replace(/,/g, ""));
      if (n < 20 || (n >= 1900 && n <= 2100 && !m[1].includes(","))) continue;
      if (usedAsMoney(t, m.index, m.index + m[0].length)) add(m[1]);
    }
  }
  return out;
}

// Whether a plain number in their words is a sum of money: a structured-token read of the words
// around it, the same kind of parse as "$" itself. A unit after it ("45 minutes", "300 miles",
// "20 of us") says it is not; a money word before it ("under", "budget", "rent is") or in the same
// sentence ("dinner was 84, what's the tip") says it is. Neither: it is not theirs as a price.
const NOT_MONEY_UNIT = /^\s?(?:%|percent|people|ppl|persons?|guests?|of us|of them|kids?|min(?:ute)?s?|hours?|hrs?|h\b|days?|nights?|weeks?|wks?|months?|mos?\b|years?|yrs?|y\/?o\b|miles?|mi\b|km|kms|meters?|ft|feet|foot|inch(?:es)?|lbs?|kg|kgs|oz|g\b|grams?|cal(?:orie)?s?|degrees?|°|mph|gb|mb|tb|am\b|pm\b|st\b|nd\b|rd\b|th\b|floor|times?|x\b|pages?|steps?|items?|pieces?|pcs|units?|boxes?|bottles?|tickets? left|reps?|sets?|points?|pts|followers?|likes?|views?)/i;
const MONEY_BEFORE = /\b(?:under|below|over|above|less than|more than|no more than|up to|max(?:imum)?|at most|tops|around|about|roughly|budget(?:ed)?(?: is| of)?|spend(?:ing)?|spent|pay(?:ing)?|paid|costs?|costing|cost me|price[ds]?|priced at|charged?|owe[ds]?|tip|bill|rent|total|salary|income|balance|afford|worth|sold (?:it )?for|bought (?:it )?for|offered|asking|deposit|fee|fare)\b[^\d.!?\n]{0,12}$/i;
const MONEY_AFTER = /^\s?(?:a (?:month|mo|year|yr|week|night|day|head|person)|\/\s?(?:mo|month|yr|year|wk|night)|per\b|each\b|total\b|tops\b|or (?:less|under|so)|max\b|budget\b|all in\b|bucks|dollars|usd)/i;
const MONEY_WORD = /\b(?:tip|tips|bill|owe[ds]?|pay(?:ing)?|paid|costs?|costing|price[ds]?|budget|spend|spent|rent|charged?|split|afford|cheap(?:er)?|expensive|refund|deposit|fee|fare|salary|balance|total|cash)\b|[$£€]/i;
// A label right before the number says what it is: "zip is 10001", "room 304", "flight 1850".
const NOT_MONEY_LABEL = /\b(?:zip(?: ?code)?|postal(?: code)?|room|rm|apt|apartment|unit|suite|floor|flight|gate|seat|platform|age|aged|number|no\.?|code|pin|id|order|ref|route|bus|train|exit|highway|hwy|street|ext(?:ension)?|phone|model|version|ran|run|running)\b(?:\s(?:a|an|the|is|was|of|#))?\s?#?\s?$/i;
/** How many words either side of the number a money word may sit and still be about it. */
const NEAR_WORDS = 4;
function usedAsMoney(text, start, end) {
  const after = text.slice(end, end + 24);
  if (NOT_MONEY_UNIT.test(after)) return false;
  const before = text.slice(Math.max(0, start - 40), start);
  if (NOT_MONEY_LABEL.test(before)) return false;
  if (MONEY_AFTER.test(after) || MONEY_BEFORE.test(before)) return true;
  // A money word next to it, in the same sentence ("dinner was 84, what's the tip") — not anywhere in
  // the sentence: "my zip is 10001, rent's high" vouched $10,001 (review 11-07).
  const from = Math.max(text.lastIndexOf("\n", start), ...[".", "!", "?"].map(c => text.lastIndexOf(c + " ", start))) + 1;
  const stops = ["\n", ". ", "! ", "? "].map(c => text.indexOf(c, end)).filter(i => i >= 0);
  const words = (x) => x.split(/\s+/).filter(w => /[\p{L}$£€]/u.test(w));
  const near = [...words(text.slice(from, start)).slice(-NEAR_WORDS), ...words(text.slice(end, stops.length ? Math.min(...stops) : text.length)).slice(0, NEAR_WORDS)];
  return near.some(w => MONEY_WORD.test(w));
}

/**
 * Does a figure in the reply stand on a known amount? Exact for anything with cents. A whole-dollar
 * figure stands on the amount it rounds or truncates from ("$4,012" off 4012.35); a round one
 * ("$4,000", "$100", "$4k") on an amount within a few percent, which is how people say a number they
 * read. Arithmetic, not meaning.
 */
function figureKnown(figure, cents, amounts, { approx = true } = {}) {
  if (amounts.has(cents)) return true;
  const f = String(figure).trim();
  if (/\.\d{1,2}(?!\d)/.test(f)) return false;
  const dollars = cents / 100;
  const k = /k$/i.test(f);
  const digits = String(Math.trunc(dollars)).length;
  const round = approx && (k || (dollars >= 10 && dollars % 10 ** Math.max(1, digits - 2) === 0));
  for (const a of amounts) {
    if (Math.floor(a / 100) * 100 === cents || Math.round(a / 100) * 100 === cents) return true;
    if (round && Math.abs(a - cents) <= cents * (k ? 0.05 : 0.03)) return true;
  }
  return false;
}

const DAY = 86_400_000;
/** The amount a receipt labels its total ("Total $40.10", the last one; never "Subtotal"), when it is one of its amounts. */
function labelledTotal(text, amounts) {
  let last = null;
  for (const m of String(text).matchAll(/(?<![a-z])(?:grand )?total\b[^\d\n]{0,12}?(\d[\d,]*\.\d{2})(?!\d)/gi)) {
    const c = Math.round(Number(m[1].replace(/,/g, "")) * 100);
    if (amounts.has(c)) last = c;
  }
  return last;
}
/** How far back what they said or sent counts as theirs. */
export const THEIR_WORDS_MS = 45 * DAY;
/** A remembered price older than this is said with its date ("as of Oct 3"). */
export const STALE_MEMORY_MS = 14 * DAY;
const shortDate = (at) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Everything known that is THEIRS, each with its amounts: what they said and sent (src/db.js
 * theirOwnWords), and what Reason remembers about them — saved facts and the profile. Never throws.
 */
function theirSources(conversationId, now) {
  const out = [];
  try {
    for (const r of db.theirOwnWords(conversationId, { since: now - THEIR_WORDS_MS })) out.push({ kind: r.kind, at: r.at, text: ownWords(r.text) });
  } catch { /* no history: nothing of theirs to add */ }
  try {
    for (const f of db.memoryFacts(conversationId)) out.push({ kind: "memory", at: f.created_at, text: f.fact });
    const p = db.getProfile(conversationId);
    if (p?.block) out.push({ kind: "memory", at: p.built_at, text: p.block });
  } catch { /* no memory */ }
  return out.map(s => ({ ...s, amounts: sourceAmounts(s.text, { bare: true }) }));
}

function replyAmountCents(s) {
  const k = /k$/i.test(s.trim());
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Math.round(n * (k ? 1000 : 1) * 100);
}

// "BOGO", "free shipping" and "$10 off" are deals too (gate 11-05: they went out unchecked before).
const DISCOUNT = /\b(coupons?|promo(?:tional)? codes?|promos?|discounts?|vouchers?|\d{1,2}\s?% off|percent off|on sale|sale price|price drop|clearance|markdown|deal ends|bogo|buy one,? get one|free (?:shipping|delivery))\b|[$£€]\s?\d+(?:\.\d{2})? off\b/i;
const DISCOUNT_SOURCE = /coupon|promo|discount|voucher|% off|percent off|sale|clearance|markdown|save \$|was \$|list price|bogo|buy one,? get one|free (?:shipping|delivery)|\$\s?\d+(?:\.\d{2})? off/i;
const THEIR_DEAL_WORDS = /\b(bogo|buy one,? get one|free (?:shipping|delivery))\b/i;
/** A whole bracketed line that is a tool's note, not words to a person: "(compared: a seller $18.99, …)". */
export const TOOL_NOTE_LINE = /^\s*\((?:compared|tool note|internal|debug)\s*:.*\)\s*$|^\s*\(.*\ba seller \$\d.*\)\s*$/i;
const DEAL_TOKEN = /\b[Cc]ode:?\s+([A-Z0-9]{4,})\b|(\d{1,2})\s?% off|\$\s?(\d+(?:\.\d{2})?) off/g;
const THEIR_DEAL = /\d{1,2}\s?% off|\$\s?\d+(?:\.\d{2})? off|\b[Cc]ode:?\s+[A-Z0-9]{4,}\b|\bsave \$\d/;
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

/** What goes out when every sentence of a rewrite stated a price nothing backs. */
export const PRICE_LEFT_OUT = "I couldn't confirm the price, so I've left it out rather than guess. Want me to look it up?";
/** The line above what is left, when they asked a price and the one it gave had to come out. */
export const PRICE_NOT_GIVEN = "I couldn't confirm a price for that, so I've left the number out rather than guess.";

// Reason's own estimate, said as one, when they asked what something costs. A taxi fare asked on
// 2026-11-15 lost its sentence ("about $64 …") to the drop below and went out as "That assumes
// roughly 16 miles…": a reply about a number with no number in it. An estimate that says it is one,
// with what it assumes, is an answer, not a fact presented as real; it stands. A live fare, a quote,
// or a figure off their own records (a balance, what they paid) never stands on this.
// The label is Reason's own: "my estimate", "I'd guess". A bare "estimated" is anybody's ("Uber's
// estimated fare is $64", "Joe's Taxi estimates $64") and labels nothing as Reason's.
const ESTIMATE_LABEL = /\b(?:my (?:own |best |rough |quick )?(?:estimate|guess|math|ballpark)|I(?:'d|’d| would)? (?:estimate|guess|ballpark)|I'?m (?:estimating|guessing)|rough (?:estimate|guess|figure|math)|guesstimate|back[- ]of[- ](?:the[- ])?envelope|not a (?:live|real|quoted|confirmed) (?:fare|price|quote|number))\b/i;
const ESTIMATE_BASIS = /\b(?:assum(?:es|ing|ed|ption)|based on|figuring|working from|going by|per (?:mile|minute|hour|night|day)|a (?:mile|minute)|\d+ (?:miles?|minutes?|mins?|hours?|nights?|days?))\b/i;
// A figure said to come from somewhere (an app showing it, a site listing it, a business quoting it)
// is a claim about that place, never Reason's own estimate.
const CLAIMS_REAL = /\b(?:right now|currently|quot(?:e|es|ed|ing)|exact(?:ly)?|confirmed|checked|listed|lists?|listing|show(?:s|ing|n)|according to|on (?:the|their|its) (?:app|site|website|page|menu))\b/i;
const NEGATED_REAL = /(?:\bnot|\bnever|\bno|n't|n’t)\s+(?:(?:a|an|the|yet|been|really)\s+)*(?:live|quoted?|exact|confirmed|checked)\b/gi;
const THEIR_RECORDS = /\b(?:balances?|accounts?|statements?|spent|paid|charged|owe[ds]?|owing|receipts?|refunds?|refunded|deposits?|deposited|invoices?|order total|payouts?|salary|paychecks?|billed|bills?|checking|savings|bank|(?:credit|debit) card|subscriptions?|membership|rent|mortgage|your (?:total|share|cut|half|portion|part|card|plan|tab)|you(?: have|'ve got|’ve got) (?:about|around|roughly|maybe|\$))\b/i;
// They asked what a thing or a trip costs. Not "how much time/longer", and never a question about
// their own money or records ("how much is in my checking", "how much do I owe Sam"): a figure
// there is a fact about them, and an estimate of it is an invented fact.
const ASKS_PRICE = /\b(?:how much(?!\s+(?:time|longer|later|further|farther|more time|sleep|space|room|data|storage|battery|weight|water|left)\b)|cost|costs|price[ds]?|pricing|fares?|estimate|run me|set me back|expensive|cheap(?:er|est)?)\b/i;
const ASKS_THEIRS = /\b(?:balances?|checking|savings|bank|statements?|owe[ds]?|owing|paid|spent|charged|refunds?|refunded|receipts?|deposits?|deposited|paychecks?|salary|invoices?|billed|payouts?|did (?:i|we) (?:pay|spend)|(?:in|on|from) (?:my|our) (?:account|card))\b|\b(?:my|our)\s+(?:[\w'’-]+\s+){0,3}?(?:accounts?|cards?|bills?|rent|mortgage|subscriptions?|membership|plan|orders?|total|budget|share|cut|tab|tuition|insurance|loan)\b/i;
// A sentence that only means something about the one before it: "That assumes 16 miles" under a
// dropped fare reads as if the fare were still there.
const LEANS_BACK = /^(?:that|this|which|those|these)(?:'s|’s| is| was| would| assumes| includes| covers| comes| works| adds| does| doesn't| isn't)\b|^(?:assuming|based on)\b/i;
/**
 * Is sentence i (of `all`, every sentence in order) Reason's own estimate, labelled as one: the label
 * and what it assumes in it or the sentence after, and in the sentence itself no claim that it is
 * live, quoted or checked and nothing off their records.
 */
function labelledEstimate(all, i) {
  const s = all[i];
  // The sentence after labels this one only when it states no figure of its own: "My estimate for
  // the cab is $64, assuming 16 miles" labels the cab, never "The hotel is $189" before it.
  const next = all[i + 1] ?? "";
  const near = new RegExp(REPLY_MONEY.source).test(next) ? s : `${s} ${next}`;
  if (!ESTIMATE_LABEL.test(near) || !ESTIMATE_BASIS.test(near)) return false;
  return !CLAIMS_REAL.test(s.replace(NEGATED_REAL, "")) && !THEIR_RECORDS.test(s);
}

/**
 * The check, on the text about to be sent — the turn's reply, and every message_send mid-turn
 * (src/tools.js). `asks: false` leaves rule 4 to the reply; `extraSources` adds text that counts as
 * evidence for this one message (the person's own words when it is sent exactly as they asked, the
 * notes on the photos they sent this turn). `unread`: they sent something this turn whose words code
 * could not read (a photo note still being written), so an unmatched figure may well be theirs.
 * `turnReply`: this is the turn's reply, so what it needs fixing is kept for Runtime._turn (takeRecompose).
 *
 * Returns { text, changed, flags, recompose } — `text` is what to send; `recompose` is null, or the
 * instruction for the model to rewrite it once: check an unchecked figure, or say ONCE in its own
 * words that it hasn't confirmed it. Code never writes a hedge or a footnote into the text
 * (owner, 2026-11-05: 618 "(unverified)" tags in a week, most on the person's own numbers).
 * `flags` names every rule that fired, for the log. Never throws: a broken check must not eat a reply.
 */
export function guardReply(conversationId, reply, { asks = true, extraSources = [], records = [], unread = false, turnReply = false } = {}) {
  try {
    if (!reply || typeof reply !== "string") return { text: reply, changed: false, flags: [], recompose: null };
    const t = turnOf(conversationId);
    const now = clock.now();
    const known = new Set();
    // The checkout record of the last two days is a source on every turn (src/shopconnect.js recordSource).
    let record = "";
    try { record = shop.connectAllowedFor(conversationId) ? shop.recordSource(conversationId) : ""; } catch { record = ""; }
    const flags = [];
    const fixes = [];

    // 0. A tool's bookkeeping line copied into the text ("(compared: a seller $18.99, …)") never goes out.
    const original = reply;
    const noted = reply.split("\n");
    const kept = noted.filter(l => !TOOL_NOTE_LINE.test(l));
    if (kept.length < noted.length) {
      flags.push({ rule: "tool_note_stripped", lines: noted.length - kept.length });
      reply = kept.join("\n").replace(/\n+$/, "");
    }
    let text = reply;

    // What is known is only read when the reply states a figure or a deal: almost every reply states
    // neither, and pays for no history query and no pass over the turn's sources.
    const figures = [...reply.matchAll(REPLY_MONEY)].map(m => ({ fig: m[0].trim(), cents: replyAmountCents(m[0].trim()) }));
    const weighs = figures.length > 0 || DISCOUNT.test(reply);
    // Their own message is read without the line code put above an inline reply (QUOTED_LINE).
    // `records` (their purchase record, src/purchasesnote.js) is known like a tool read: a figure on
    // it stands, but it is no base for the arithmetic below — fifty carts of amounts summed and
    // multiplied vouched for nearly any whole-dollar price (review 11-07).
    // Their own message is read as their words (a "5k" they ran is no $5,000), every other source leniently.
    if (figures.length) for (const s of [...t.sources, record, ...records.filter(Boolean).map(String)]) for (const c of (s === t.own ? sourceAmounts(ownWords(s), { bare: true }) : sourceAmounts(s))) known.add(c);
    // Their own words this turn and what they sent with them are theirs: read like their history.
    const extra = extraSources.filter(Boolean).map(String);
    const theirs = weighs ? [...[t.kind === "user" ? ownWords(t.own) : "", ...extra].filter(Boolean).map(text => ({ kind: "them", at: now, text, amounts: sourceAmounts(text, { bare: true }) })), ...(t.theirs ??= theirSources(conversationId, now))] : [];
    const fresh = new Set(known);
    for (const s of theirs) if (s.kind !== "memory" || now - s.at < STALE_MEMORY_MS) for (const c of s.amounts) fresh.add(c);

    // 1. Dollar figures. Known when a tool read it this turn, when it is THEIRS (said, sent, a photo
    // of theirs, anywhere in the last weeks of the thread), or when Reason remembers it about them.
    // Those are never hedged. A figure that is none of those is not labelled in code: the model is
    // sent back once to check it or say, once, in its own words, that it hasn't confirmed it.
    const unchecked = [];
    const stale = [];
    const loose = [];
    for (const f of figures) {
      if (figureKnown(f.fig, f.cents, fresh)) continue;
      const remembered = theirs.filter(s => s.kind === "memory" && figureKnown(f.fig, f.cents, s.amounts));
      if (remembered.length) { stale.push({ figure: f.fig, as_of: shortDate(Math.max(...remembered.map(s => s.at))) }); continue; }
      loose.push(f);
    }
    // Sums worked out of known figures in the same message ("$2,341.17 less the $1,850 rent leaves
    // $491", "two at $45 is $90") are known too: arithmetic on what is known, not a new claim.
    // A percentage of one ("18% tip on $84 is $15.12") and a split ("$33.04 each") count the same way.
    const settled = [...figures.filter(f => !loose.includes(f)).map(f => f.cents), ...theirs.filter(s => s.at === now).flatMap(s => [...s.amounts])];
    const pcts = [reply, ...theirs.filter(s => s.at === now).map(s => s.text)].flatMap(x => [...String(x).matchAll(/(\d{1,2}(?:\.\d+)?)\s?(?:%|percent)/g)].map(m => Number(m[1]) / 100));
    const worked = new Set();
    for (const a of settled) {
      for (let k = 2; k <= 10; k++) { worked.add(a * k); worked.add(Math.round(a / k)); }
      for (const p of pcts) { const part = Math.round(a * p); worked.add(part); worked.add(a + part); worked.add(a - part); for (let k = 2; k <= 10; k++) worked.add(Math.round((a + part) / k)); }
      for (const b of settled) { worked.add(a + b); if (a > b) worked.add(a - b); }
    }
    // A total of several known figures ("that comes to $261.95" over six receipts) is arithmetic too:
    // the sum of them all and each running subtotal in the order they stand, bounded at one value each.
    let run = 0;
    for (const a of settled.slice(0, 40)) worked.add(run += a);
    // Receipts they sent on earlier turns are known but not restated in the reply, so they are no base
    // above: a grand total or a per-store subtotal of them was sent back as nothing-backs. Each recent
    // thing they said or sent (the last day, not memory) counts once, by its labelled total ("Total
    // $40.10", not "Subtotal") or else its largest amount — a "Cash $50.00" tendered line is no total.
    // Up to 8 of them: every subset sum (≤255 values), so any grouping by store stands. Up to 12:
    // contiguous runs and pairs only (≤144). Never every amount on every receipt summed. Those
    // groupings count only to the exact cent: with whole-dollar rounding, 255 sums under a $260 grand
    // total cover most whole-dollar figures below it, so an invented "$150" would stand. The grand total
    // of them all keeps the rounding ("about $262").
    const seenText = new Set();
    const totals = theirs.filter(s => s.kind !== "memory" && now - s.at < DAY && s.amounts.size && !seenText.has(s.text) && seenText.add(s.text))
      .sort((x, y) => x.at - y.at).slice(-12).map(s => labelledTotal(s.text, s.amounts) ?? Math.max(...s.amounts));
    const grouped = new Set();
    if (totals.length >= 2) {
      worked.add(totals.reduce((x, y) => x + y, 0));
      if (totals.length <= 8) {
        for (let mask = 1; mask < 1 << totals.length; mask++) {
          let sum = 0;
          for (let i = 0; i < totals.length; i++) if (mask & (1 << i)) sum += totals[i];
          grouped.add(sum);
        }
      } else {
        for (let i = 0; i < totals.length; i++) {
          let sum = 0;
          for (let j = i; j < totals.length; j++) { grouped.add(sum += totals[j]); if (j > i) grouped.add(totals[i] + totals[j]); }
        }
      }
    }
    for (const f of loose) if (!grouped.has(f.cents) && !figureKnown(f.fig, f.cents, worked, { approx: false })) unchecked.push(f.fig);
    // They asked what a thing or a trip costs (ASKS_PRICE), and this is the turn's reply: the only
    // place a labelled estimate of Reason's own may stand. A message_send is refused either way.
    const askedPrice = turnReply && t.kind === "user" && ASKS_PRICE.test(ownWords(t.own)) && !ASKS_THEIRS.test(ownWords(t.own));
    if (unchecked.length) {
      flags.push({ rule: "dollar_unsourced", figures: unchecked });
      if (!unread) fixes.push({ key: "dollar:" + unchecked.join(","), hard: true, line: `It states ${unchecked.length > 1 ? "figures" : "a figure"} nothing backs — ${unchecked.join(", ")}: no tool read ${unchecked.length > 1 ? "them" : "it"} this turn, and ${unchecked.length > 1 ? "they are" : "it is"} not something they said or sent or something you remember about them. If a quick tool can check it (web_search, offer_check, a quote), check it now and use what it says. ${askedPrice ? "They asked what something costs: if nothing can give a real price, you may give your own estimate: in the same sentence call it your estimate (\"my estimate\") and say what it assumes (the distance, the time, the rates you used); it must never read as a live price, a quote, something an app or a business shows, or a figure from their records. " : ""}Otherwise leave the figure out: a price nothing backs${askedPrice ? " that is not labelled that way" : ""} is taken out of this rewrite before it is sent, hedged or not. Then say plainly, once and in your own words, that you can't give a number and that you'll check it if they want.` });
    }
    const staleNow = stale.filter(x => !new RegExp(`as of|${x.as_of.split(" ")[0]}`, "i").test(reply));
    if (staleNow.length) {
      flags.push({ rule: "dollar_remembered_stale", figures: staleNow });
      fixes.push({ key: "stale:" + staleNow.map(x => x.figure).join(","), line: staleNow.map(x => `${x.figure} is from what you saved about them on ${x.as_of}: give that date with it (as of ${x.as_of}).`).join(" ") });
    }

    // 2. A coupon / discount / sale needs something read or theirs that mentions one.
    // A concrete deal in the reply (a code, "40% off", "$25 off") stands only on a source or words of
    // theirs that carry that same code or amount. A deal in general words ("there's a coupon too")
    // needs a source that mentions one, or a concrete deal of theirs from the last day — "is there a
    // promo?" vouches for none, and a code they mentioned weeks ago for another store vouches for nothing here.
    const discountSourced = () => {
      const toolText = [...t.sources.filter(s => s !== t.own).map(s => s.slice(0, 200_000)), record].join("\n");
      const theirText = theirs.map(s => s.text).join("\n");
      const deals = [...reply.matchAll(DEAL_TOKEN)].map(m => m[1] ? { re: new RegExp(`\\b${m[1]}\\b`, "i") }
        : m[2] ? { re: new RegExp(`(?<![\\d.])${m[2]}\\s?%`) } : { re: new RegExp(`\\$\\s?${m[3].replace(".", "\\.")}(?![\\d])|(?<![\\d.])${m[3].replace(".", "\\.")}\\s?(?:dollars|bucks) off`) });
      return deals.length
        ? deals.every(d => d.re.test(toolText) || d.re.test(theirText))
        : DISCOUNT_SOURCE.test(toolText) || theirs.some(s => now - s.at < DAY && s.kind !== "memory" && (THEIR_DEAL.test(s.text) || THEIR_DEAL_WORDS.test(s.text)));
    };
    const discountClaimed = DISCOUNT.test(reply) && !discountSourced();
    if (discountClaimed) {
      flags.push({ rule: "discount_unsourced" });
      fixes.push({ key: "discount", hard: true, line: "It mentions a coupon, discount or sale that nothing you read this turn shows and they never mentioned. Check it with a tool now, or leave it out — never point them at a deal you haven't seen." });
    }
    // 3. "Best deal" needs a comparison set of verified offers; otherwise say what was compared.
    // A flight search or date sweep this turn IS the comparison set (src/flightsearch.js): "the
    // cheapest dates are early december" is read off the fares it just pulled.
    if (claimsBest(reply) && !t.faresCompared) {
      const priced = t.offers.filter(o => o.price_cents != null);
      if (priced.length < 2) {
        flags.push({ rule: "best_unsupported", compared: priced.length });
        fixes.push({ key: "best", line: `It calls something the best or cheapest, but ${priced.length ? `you only looked at ${priced[0].seller || "one seller"} (${money(priced[0].price_cents)})` : "you didn't compare sellers this turn"}. Compare a few now, or say plainly what you did look at instead of "best".` });
      } else if (!priced.every(o => text.includes(money(o.price_cents)))) {
        // Compared for real: logged, never glued onto the text.
        flags.push({ rule: "best_compared_listed", compared: priced.length });
      }
    }
    // The rewrite's own check is the last. What it still says unchecked does not go out: the
    // sentences carrying an unchecked price, and an unchecked deal's, come out (review 11-05: a price
    // nothing backs that survived its one rewrite was sent anyway). A stale remembered figure is only
    // missing its date, so it is logged and left. If nothing is left, one plain line says why.
    if (t.recomposed && turnReply) {
      // Whole figures only: an unchecked "$4" takes no sentence that says "$45" (review 11-07).
      const carries = unchecked.map(fig => new RegExp(`(?<![\\d.,])${fig.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")}(?![\\d]|[.,]\\d)`));
      if (discountClaimed || unchecked.length) {
        const parts = sentencesOf(text);
        const all = parts.filter(p => typeof p !== "string").flat();
        // Their own estimate, labelled as one, stands when they asked a price (see labelledEstimate).
        const estimates = new Set();
        const dropAt = new Set();
        all.forEach((x, i) => {
          if (discountClaimed && DISCOUNT.test(x)) { dropAt.add(i); return; }
          const hit = unchecked.filter((fig, k) => carries[k].test(x));
          if (!hit.length) return;
          if (askedPrice && labelledEstimate(all, i)) { for (const fig of hit) estimates.add(fig); return; }
          dropAt.add(i);
        });
        // What only leaned on a dropped sentence goes with it.
        // Never a sentence carrying a figure that stands: what is checked is a fact on its own.
        for (let i = 1; i < all.length; i++) if (dropAt.has(i - 1) && LEANS_BACK.test(all[i].trim()) && !new RegExp(REPLY_MONEY.source).test(all[i])) dropAt.add(i);
        let n = 0;
        const left = joinBack(parts.map(p => (typeof p === "string" ? p : p.filter(() => !dropAt.has(n++)))));
        const dropped = unchecked.filter((fig, k) => all.some((x, i) => dropAt.has(i) && carries[k].test(x)));
        // A price they asked for that had to come out is said to be out, never left to read as if it
        // were still there: when nothing of a price is left, one plain line goes first.
        const saysOut = /\b(?:couldn'?t|can'?t|cannot|could not) (?:confirm|give|get|find|check)\b[^.!?\n]{0,40}\b(?:price|fare|number|cost|figure)/i;
        const noFigureLeft = !new RegExp(REPLY_MONEY.source).test(left);
        text = !left ? PRICE_LEFT_OUT
          : dropAt.size && askedPrice && noFigureLeft && !saysOut.test(left) ? `${PRICE_NOT_GIVEN}\n\n${left}` : left;
        if (discountClaimed) flags.push({ rule: "discount_dropped" });
        if (dropped.length) flags.push({ rule: "dollar_dropped", figures: dropped });
        if (estimates.size) flags.push({ rule: "dollar_estimate_kept", figures: [...estimates] });
      }
      fixes.length = 0;
    }
    const recompose = fixes.length ? fixes.map(f => f.line).join(" ") : null;
    const out = { text, changed: false, flags, recompose, fixes };
    // 4. A purchase ask carries its offer record: AgentCard's total and the source.
    // Only on the reply: a message sent mid-turn (message_send) is not where the ask is put, and
    // the ask line glued onto a text to somebody else would be wrong twice over.
    const asksExtra = [];
    for (const ask of asks ? t.asks : []) {
      if (!ask?.line) continue;
      const hasTotal = !ask.total || text.includes(ask.total);
      const hasSource = !ask.url || text.includes(ask.url);
      if (!hasTotal || !hasSource) { flags.push({ rule: "ask_without_offer" }); asksExtra.push(ask.line); }
    }
    // 5. "I've started the checkout" needs a checkout run behind it (src/shopconnect.js): one of
    // theirs started in the last 15 minutes or still open. On 2026-10-31 the opposite happened too —
    // "the checkout never actually started" about a run that had run and died — so a never-started
    // line with a run on record is corrected from the record as well.
    const started = checkoutClaims(conversationId, text);
    if (started.flag) { flags.push(started.flag); text = started.text; }
    // 6. The line over a set of picture cards never says the prices couldn't be confirmed (src/choicecards.js).
    // The reply only (the cards go out with it), for a set drawn on this turn.
    if (asks) {
      const chosen = choiceWording(conversationId, text, { since: t.started_at });
      if (chosen.flag) { flags.push(chosen.flag); text = chosen.text; }
    }
    if (asksExtra.length) text = text + "\n" + asksExtra.join("\n");
    if (turnReply) t.recompose = recompose;
    return { ...out, text, changed: text !== original };
  } catch {
    return { text: reply, changed: false, flags: [{ rule: "guard_error" }], recompose: null };
  }
}

/**
 * The rewrite the turn's reply needs (set by guardReply with `turnReply`), taken once: the
 * instruction Runtime._turn hands the model, or null. The rewrite's own check never sets one.
 */
export function takeRecompose(conversationId) {
  const t = turns.get(conversationId);
  const r = t?.recompose ?? null;
  if (t) t.recompose = null;
  return r;
}

/**
 * A message_send that needs fixing (src/tools.js): the first time a thing is pointed out this turn it
 * is sent back; the model has then had its chance, and the same thing goes on the next try. An
 * unchecked price or deal (`hard`) is sent back every time: it never goes out unchecked.
 */
export function sendBack(conversationId, fixes = []) {
  const t = turnOf(conversationId);
  const back = fixes.filter(f => f.hard || !t.warned.has(f.key));
  for (const f of fixes) t.warned.add(f.key);
  return back.length ? back.map(f => f.line).join(" ") : null;
}

