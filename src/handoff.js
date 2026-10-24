// The handoff: what Reason gives somebody when it cannot buy the thing itself.
//
// Before 2026-10-23 a purchase that failed (AgentCard unreachable, not set up, a cart that was the
// wrong product, a declined confirm) came back as one error sentence and nothing else: no link, no
// record of what had been checked, no next step. Somebody who wanted the thing was left to start the
// search again. Now every one of those failures carries a handoff, built by code from an offer
// record (src/offers.js) and never from the model's idea of a shop:
//
//   - one link, and plain words for what tapping it does;
//   - what was verified (each field, with where and when it was read) and what was not;
//   - exactly one next step;
//   - cart_transferred: false, always. Reason has no way to move a cart to somebody's phone. A cart
//     built in Reason's own browser profile (an Amazon cart, say) stays in Reason's browser; the link
//     opens the site, not that cart, and the words say so.
//
// Links are only ever of two kinds, and the add-to-cart kind exists only where the merchant documents
// a format AND the page told us the exact item:
//   - Shopify stores: a cart permalink, https://{store}/cart/{variant_id}:{qty}, with
//     ?storefront=true to land on the cart page instead of checkout (help.shopify.com/en/manual/
//     products/details/cart-permalink, read 2026-10-23). Only when the page is a Shopify store (its
//     own markup says so) and one variant is pinned by the page's url or is the only one on offer.
//   - Everything else: the product page that was read. Amazon included: its Add to Cart form
//     (gp/aws/cart/add.html, ASIN.n/Quantity.n) was documented under the Product Advertising API,
//     whose page is now a deprecation notice, and a live read of it on 2026-10-23 landed on a bot
//     check (/ax/claim) — so it is not offered. Amazon gets its canonical /dp/{ASIN} page.

import { offerView, productKey } from "./offers.js";

const money = (cents) => "$" + (Number(cents) / 100).toFixed(2);

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

/** Is this page a Shopify store, by its own markup? */
function isShopify(html, url) {
  if (/\.myshopify\.com$/i.test(hostOf(url))) return true;
  return /cdn\.shopify\.com|Shopify\.shop\s*=|window\.Shopify\b|shopify-section/i.test(String(html ?? "").slice(0, 2_000_000));
}

/**
 * A Shopify cart permalink for the exact item on this page, or "" when the variant is not pinned.
 * The variant comes from the page url's ?variant=, else from the product markup when exactly one
 * offer url carries one. Never guessed from a sku or a product id.
 */
export function cartLinkFromHtml(html, url) {
  if (!isShopify(html, url)) return "";
  let u;
  try { u = new URL(String(url)); } catch { return ""; }
  let variant = /^\d{6,20}$/.test(u.searchParams.get("variant") ?? "") ? u.searchParams.get("variant") : "";
  if (!variant) {
    const found = new Set();
    for (const m of String(html ?? "").matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const v of m[1].matchAll(/[?&]variant=(\d{6,20})/g)) found.add(v[1]);
    }
    if (found.size === 1) variant = [...found][0];
  }
  if (!variant) return "";
  return u.origin + "/cart/" + variant + ":1?storefront=true";
}

/** The product page to send: Amazon's canonical /dp/ page when the url carries an ASIN, else the url read. */
function productPage(offer) {
  const url = String(offer?.url ?? "");
  if (!/^https?:\/\//i.test(url)) return "";
  const key = productKey(url);
  if (key.startsWith("amazon:")) {
    try { return new URL(url).origin + "/dp/" + key.slice("amazon:".length); } catch { return url; }
  }
  return url;
}

const SITE_NAMES = { "amazon.com": "Amazon", "walmart.com": "Walmart", "target.com": "Target", "bestbuy.com": "Best Buy", "homedepot.com": "Home Depot", "ebay.com": "eBay" };
function siteName(offer, host) {
  return SITE_NAMES[host] || offer?.seller || host || "the shop";
}

/**
 * A handoff from one offer record.
 *
 * "why" is the reason Reason could not buy it, in a few words, said as given. "reasonCartOn" is the
 * host of a cart in Reason's own browser, if there is one — said to stay there.
 */
export function handoffFor(offer, { why = "", reasonCartOn = "" } = {}) {
  if (!offer) return null;
  const view = offerView(offer);
  const pageUrl = productPage(offer);
  const host = hostOf(offer.cart_url || pageUrl || offer.url);
  const site = siteName(offer, host);
  const kind = offer.cart_url ? "add_to_cart" : pageUrl ? "product_page" : "none";
  const url = offer.cart_url || pageUrl || "";
  const browserCart = !!(reasonCartOn && host && hostOf("https://" + reasonCartOn) === host);

  const opens = kind === "add_to_cart"
    ? "opens a NEW cart on " + site + " (" + host + ") with this one item, qty 1, on their phone. It is a fresh cart built by the link, not anything Reason filled."
    : kind === "product_page"
      ? "opens the product page on " + site + ". Nothing is in their cart — they add it there."
      : "there is no link on record for this one.";

  const verified = [];
  const at = view.fetched_at;
  const from = offer.source === "page" ? site + "'s page" : offer.source === "agentcard_cart" ? "AgentCard's cart" : "AgentCard's search";
  const add = (field, value) => verified.push({ field, value, source: from, read_at: at });
  if (!view.unverified.includes("price") && offer.price_cents != null) add("price", money(offer.price_cents) + (offer.source === "agentcard_cart" ? " (AgentCard's all-in total)" : ""));
  if (!view.unverified.includes("seller")) add("seller", view.seller);
  if (!view.unverified.includes("stock")) add("stock", view.stock);
  if (!view.unverified.includes("shipping cost")) add("shipping cost", view.shipping_cost);
  if (!view.unverified.includes("shipping time")) add("shipping time", view.shipping_time);
  if (!view.unverified.includes("return terms")) add("return terms", view.return_terms);
  const unverified = view.unverified.filter(f => f !== "url");

  const priceBit = offer.price_cents != null && !view.unverified.includes("price") ? " — it was " + money(offer.price_cents) + " when read" : "";
  const next_step = kind === "add_to_cart"
    ? "Tap the link and check out on " + site + priceBit + "."
    : kind === "product_page"
      ? "Tap the link and buy it on " + site + "'s page" + priceBit + "."
      : "Search " + site + " for \"" + (offer.product || "the item") + "\" — there is no link to send.";

  return {
    why_not_bought: why || undefined,
    product: offer.product || "unverified",
    link: { url: url || null, kind, opens },
    verified,
    unverified,
    next_step,
    cart_transferred: false,
    ...(browserCart ? { reason_browser_cart: "Reason's own browser is on " + site + ". Anything put in a cart there stays in Reason's browser profile — it is NOT in their " + site + " account, and the link does not carry it over." } : {}),
    say: "Give them: the link on its own line and what it opens, in those words; what was verified (with where it was read) and what was not; and the one next step. "
      + "Never say or imply a cart is ready, waiting, filled or transferred for them — cart_transferred is false." + (browserCart ? " If you added it to a cart in your browser, say that cart stays in your browser and the link opens the site, not that cart." : ""),
  };
}

