// Price watches: "tell me if it drops" about one product page, and nothing more (2026-10-23).
//
// Not a scheduler and not a speaker. The schedule is the watches table and the sweep's
// checkWatches pass (src/runtime.js): a price watch is a row with kind 'price', so it is due,
// claimed, counted and called off by exactly the code a page watch is. Saying anything is the
// notice gate's (src/notice.js): a verified drop becomes a candidate in gather(), off Reason's own
// rows like a flight check-in, so quiet hours, the day's budget, digest, snooze and "off" all apply
// to it unchanged, and a drop found at 3am is held for the morning by the same code that holds
// everything else.
//
// What this file owns is the evidence. A recheck reads the page through the same path offer_check
// does (offers.fetchOfferPage + offerFromHtml) and saves the offer record. A drop exists only when
// that record has a machine-read price and it is lower than the PREVIOUS VERIFIED offer on the row,
// in the same currency. A page that would not read, or read without a price, is not a lower price;
// a shop that refuses to be read stops the watch, and the person is told it stopped.
//
// What it never does: buy, hold, cart, confirm or pre-approve anything. The alert names the offer
// and says nothing is bought; buying it is the ordinary purchase call and its hash-pinned confirm.
import * as db from "./db.js";
import * as offers from "./offers.js";
import { clock, config, stamp } from "./config.js";

const DAY = 24 * 60 * 60_000;
const money = offers.money;
const iso = (t) => new Date(Number(t)).toISOString();
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

export const KINDS = {
  deal_drop: { what: "a price they asked Reason to watch dropped, verified on a fresh read of the page", speakable: true },
  deal_watch_stopped: { what: "a price watch they asked for has stopped, and why", speakable: true },
};
export const MINE = new Set(Object.keys(KINDS));

export const RULES = "A deal_drop or deal_watch_stopped is about a price watch THEY asked for, so it is specific to them and"
  + " it is today's news; it still waits for its moment like anything else. For a drop: say the product, the new price, what"
  + " it was at the last check, and the link, exactly as written on the line — those figures were read off the page by code"
  + " just now. Do not call it the best or lowest price anywhere; one shop was checked. Nothing has been bought, held or put"
  + " in a cart, and nothing is approved: if they want it, that is a purchase call with this offer_id and the ordinary"
  + " confirm, after they say so. For a stop: say plainly that you stopped and why, and do not offer a way round a shop"
  + " that blocked you.";

/** The line an alert has to carry: the verified offer, its source, when it was read, and that nothing is bought. */
export function alertLine(o, p) {
  return `${o.product || "it"}: ${money(o.price_cents)} at ${o.seller || hostOf(o.url)} (was ${money(p.price_cents)}) — ${o.url} · checked ${stamp(o.fetched_at)}. nothing's bought — say if u want it.`;
}

/**
 * One recheck of one price watch, already claimed. Returns { outcome } where outcome is one of
 * drop | same | unverified | stopped | blocked, plus the offer row that was saved, if any.
 */
export async function checkPrice(w, { fetchImpl = fetch } = {}) {
  const c = w.conversation_id;
  const host = hostOf(w.url);
  const got = await offers.fetchOfferPage(w.url, { fetchImpl });
  if (!got.ok && got.blocked) {
    db.stopPriceWatch(w.id, { blocked: true, why: `${host} refused to be read (it answered ${got.status}), so the watch stopped there` });
    return { outcome: "blocked", status: got.status };
  }
  let row = null;
  if (got.ok) row = db.saveOffer(c, offers.offerFromHtml(got.html, got.url, clock.now()));
  const base = w.offer_id ? db.getOffer(c, w.offer_id) : null;
  // The same product, by the shop's own id when both reads carry one. A redirect to a different item
  // is not a price for this one.
  const sameItem = !row || !base?.product_id || !row.product_id || row.product_id === base.product_id;
  if (!row || row.price_cents == null || !sameItem) {
    const streak = db.notePriceUnverified(w.id);
    const why = !got.ok ? `could not read it: ${got.error}` : !sameItem ? "the page now shows a different product" : "the page no longer carries a machine-readable price";
    if (streak >= config.dealWatchMaxUnverified) {
      db.stopPriceWatch(w.id, { why: `${streak} checks in a row verified no price (${why}), so the watch stopped rather than guess` });
      return { outcome: "stopped", why, offer: row };
    }
    return { outcome: "unverified", why, offer: row };
  }
  // The comparison is against the previous VERIFIED offer record, never against a remembered number.
  const prev = w.last_offer_id ? db.getOffer(c, w.last_offer_id) : null;
  const d = offers.verifiedDrop(prev, row);
  const wanted = w.target_cents != null ? row.price_cents <= w.target_cents : row.price_cents < (w.baseline_cents ?? Infinity);
  if (d.drop && wanted) {
    db.markPriceDrop(w.id, {
      offerId: row.id, priceCents: row.price_cents, prevOfferId: prev.id,
      why: `${money(row.price_cents)}, was ${money(prev.price_cents)} (offer #${prev.id})`,
    });
    return { outcome: "drop", offer: row, prev };
  }
  db.notePriceVerified(w.id, { offerId: row.id, priceCents: row.price_cents });
  return { outcome: "same", offer: row };
}

/** What the notice sweep gets from price watches: verified drops and stops, off Reason's own rows. */
export function candidates(conversationId, now = clock.now()) {
  const out = [];
  for (const w of db.priceWatchNews(conversationId, { since: now - config.dealNewsDays * DAY })) {
    if (w.alert_offer_id) {
      const o = db.getOffer(conversationId, w.alert_offer_id);
      const p = db.getOffer(conversationId, w.alert_prev_offer_id);
      // No offer records, no alert. A drop is only ever said off the two reads that prove it.
      if (o?.price_cents == null || p?.price_cents == null) continue;
      out.push({
        kind: "deal_drop", key: `deal_drop:${w.id}:${o.id}`, thing: `deal:${w.id}`, state: String(o.id),
        what: `the price you are watching for them dropped: ${o.product || "the item"} at ${o.seller || hostOf(o.url)} is ${money(o.price_cents)} now, was ${money(p.price_cents)} at the last verified check`,
        detail: `watch #${w.id}; verified offer_id ${o.id} read off the page at ${iso(o.fetched_at)}; the previous verified offer_id ${p.id} read at ${iso(p.fetched_at)}. nothing is bought`,
        source: o.url,
      });
    } else if (w.stopped_at) {
      out.push({
        kind: "deal_watch_stopped", key: `deal_stop:${w.id}`, thing: `deal:${w.id}`,
        what: `you stopped watching the price on ${hostOf(w.url)} for them: ${w.stopped_why}`,
        detail: `watch #${w.id}`, source: w.url,
      });
    }
  }
  return out;
}

/** The notice recheck for these kinds: Reason's own row is the truth, no mailbox needed. */
export function recheck(conversationId, row) {
  const id = Number(/^deal_(?:drop|stop):(\d+)/.exec(String(row?.key ?? ""))?.[1]);
  const w = Number.isFinite(id) ? db.getWatch(conversationId, id) : null;
  if (!w) return { handled: "that price watch is no longer written down" };
  if (w.cancelled_at) return { handled: "they called that price watch off" };
  return { ok: true };
}

/**
 * notice_send just cleared a deal_drop: put the two offer records in this turn's sources and the
 * alert line on the turn, so the reply check (offers.guardReply) adds the offer — price, link, when
 * it was read — to any reply that leaves it out. The same rule a purchase ask is held to.
 */
export function onNoticeCleared(conversationId, row) {
  if (row?.kind !== "deal_drop") return;
  const [, wid, oid] = /^deal_drop:(\d+):(\d+)$/.exec(String(row.key)) ?? [];
  const w = wid ? db.getWatch(conversationId, Number(wid)) : null;
  const o = oid ? db.getOffer(conversationId, Number(oid)) : null;
  const p = w?.alert_prev_offer_id ? db.getOffer(conversationId, w.alert_prev_offer_id) : null;
  if (!o || !p) return;
  const line = alertLine(o, p);
  offers.noteSource(conversationId, offers.offerView(o));
  offers.noteSource(conversationId, offers.offerView(p));
  offers.noteSource(conversationId, line);
  offers.noteAsk(conversationId, { line, total: money(o.price_cents), url: o.url });
}

/** A price watch as the model reads it in watch_list. */
export function view(w) {
  return {
    kind: "price", product_url: w.url,
    started_at_price: w.baseline_cents != null ? money(w.baseline_cents) : "unverified",
    last_verified_price: w.last_price_cents != null ? money(w.last_price_cents) : "unverified",
    ...(w.target_cents != null ? { tell_them_at_or_below: money(w.target_cents) } : { tell_them: "on any verified drop" }),
    every_hours: Math.round(w.every_ms / 3_600_000),
    ...(w.stopped_at ? { stopped: w.stopped_why, blocked: !!w.blocked_at } : {}),
    they_said: w.consent_said || undefined,
  };
}
