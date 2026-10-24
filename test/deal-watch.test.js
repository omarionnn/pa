// Price watches (src/deals.js), step 7 of the shopping work (2026-10-23). Pinned, one per rule:
//
//   - a watch exists only on a turn they started, from words really in their message;
//   - a recheck goes through the offer_check path and saves an offer record;
//   - an alert exists only for a drop verified against the PREVIOUS VERIFIED offer;
//   - the alert carries that offer (price, link, when read) and passes the reply check;
//   - nothing about it opens a way to spend: no confirm, no permission, no purchase;
//   - quiet hours hold it for the morning through the ordinary notice gate;
//   - a shop that blocks stops the watch, and they are told — no retry, no workaround;
//   - rechecks are bounded: a floor on the interval and one read per shop per pass.
//
// A fake shop (an injected fetch), no Google connected, a fake model. No network, no key.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-deals-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "33".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const offers = await import("../src/offers.js");
const deals = await import("../src/deals.js");
const notice = await import("../src/notice.js");
const { config, clock } = await import("../src/config.js");

const HOUR = 3_600_000;
const OMARI = "dm:owner";
const TZ = "America/New_York";
const URL1 = "https://shop.example/p/headphones-123";

after(() => rmSync(dir, { recursive: true, force: true }));

// ---------- the fake shop ----------
let shop;
function fakeFetch(url) {
  shop.reads.push(String(url));
  const s = shop.pages[new URL(url).hostname] ?? shop;
  if (s.status && s.status !== 200) return Promise.resolve(new Response("no robots", { status: s.status }));
  const offer = s.price == null ? {} : { "@type": "Offer", price: s.price, priceCurrency: s.currency ?? "USD", availability: "https://schema.org/InStock" };
  const ld = { "@context": "https://schema.org", "@type": "Product", name: "Quiet Headphones", sku: s.sku ?? "QH-1", offers: offer };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>Quiet Headphones</body></html>`;
  const res = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(res, "url", { value: String(url) });
  return Promise.resolve(res);
}

function skipToLocalHour(hour) {
  for (let i = 0; i < 48; i++) { if (notice.localHour(clock.now(), TZ) === hour) return; clock.skip(HOUR); }
  throw new Error("never reached " + hour);
}

beforeEach(() => {
  clock.reset();
  skipToLocalHour(10);
  db.db.exec(`DELETE FROM watches; DELETE FROM offers; DELETE FROM notice_seen; DELETE FROM notice_budget; DELETE FROM notice_sweeps;
    DELETE FROM accounts; DELETE FROM confirmations; DELETE FROM permissions; DELETE FROM action_ledger; DELETE FROM timers;
    DELETE FROM agentcard_purchases; DELETE FROM conversations; DELETE FROM usage;`);
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.setNoticeWindow(OMARI, { askedAt: clock.now(), answeredAt: clock.now() });
  config.noticePerDay = 1; config.noticeHardCap = 3; config.noticeEveryMs = 2 * HOUR;
  config.noticeQuietStart = 22; config.noticeQuietEnd = 8;
  shop = { price: "199.00", status: 200, reads: [], pages: {} };
});

const call = (name, input) => runTool(name, input, { conversationId: OMARI, messages: [], fetchImpl: fakeFetch });

/** A turn they started, with their message, then offer_check on the page: the baseline offer. */
async function theyAsk(text, { url = URL1 } = {}) {
  offers.beginTurn(OMARI, text, "user");
  const checked = await call("offer_check", { url });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return checked.offer.offer_id;
}

async function watchIt({ said = "yeah watch it for me", text = "yeah watch it for me and tell me if it drops", ...rest } = {}) {
  const offerId = await theyAsk(text);
  const out = await call("deal_watch_set", { offer_id: offerId, said, ...rest });
  assert.equal(out.ok, true, JSON.stringify(out));
  return db.getWatch(OMARI, out.watch.id);
}

const rt = () => new Runtime({ fetchImpl: fakeFetch, runTurn: async () => null });
const due = () => clock.skip(13 * HOUR);

// ---------- consent ----------

test("a watch is made only on a turn they started, from words really in their message", async () => {
  const offerId = await theyAsk("how much are these headphones?");
  // Their words do not say yes: the model may not invent a quote.
  let out = await call("deal_watch_set", { offer_id: offerId, said: "yes please watch the price" });
  assert.equal(out.ok, false);
  assert.match(out.error, /their own words/);
  // A sweep or a timer cannot start one, whatever it quotes.
  offers.beginTurn(OMARI, "[event] yes please watch the price", "event");
  out = await call("deal_watch_set", { offer_id: offerId, said: "yes please watch the price" });
  assert.equal(out.ok, false);
  assert.match(out.error, /turn they started/);
  assert.equal(db.listWatches(OMARI).length, 0, "no watch without consent");

  // They say yes; the model passes their words: now it exists, with their sentence on the row.
  offers.beginTurn(OMARI, "Yes please   watch the price for me", "user");
  out = await call("deal_watch_set", { offer_id: offerId, said: "yes please watch the price" });
  assert.equal(out.ok, true, JSON.stringify(out));
  const w = db.getWatch(OMARI, out.watch.id);
  assert.equal(w.kind, "price");
  assert.equal(w.consent_said, "yes please watch the price");
  assert.equal(w.baseline_cents, 19900);
  assert.equal(w.offer_id, offerId);
});

test("they can list and stop a watch", async () => {
  const w = await watchIt();
  const list = await call("watch_list", {});
  assert.equal(list.count, 1);
  assert.equal(list.watches[0].kind, "price");
  assert.equal(list.watches[0].started_at_price, "$199.00");
  const stop = await call("watch_cancel", { watch_id: w.id });
  assert.equal(stop.ok, true);
  assert.equal((await call("watch_list", {})).count, 0);
  due();
  await rt().checkWatches();
  assert.equal(shop.reads.length, 1, "a stopped watch is never read again (only the original offer_check read)");
});

test("an offer with no verified price cannot be watched, and a target already met is said, not watched", async () => {
  shop.price = null;
  let id = await theyAsk("watch it");
  let out = await call("deal_watch_set", { offer_id: id, said: "watch it" });
  assert.equal(out.ok, false);
  assert.match(out.error, /no machine-readable price/);
  shop.price = "150.00";
  id = await theyAsk("watch it, tell me under 180");
  out = await call("deal_watch_set", { offer_id: id, said: "watch it", target_price: 180 });
  assert.equal(out.ok, false);
  assert.equal(out.status, "already_there");
});

// ---------- only a verified drop ----------

test("only a drop verified against the previous verified offer makes an alert", async () => {
  const w = await watchIt();
  const r = rt();

  // Not due yet: the floor holds.
  await r.checkWatches();
  assert.equal(shop.reads.length, 1, "nothing re-read before its interval");

  // The page loses its price: unverified, not a drop.
  shop.price = null; due();
  await r.checkWatches();
  let row = db.getWatch(OMARI, w.id);
  assert.equal(row.met_at, null);
  assert.equal(row.unverified_streak, 1);
  assert.equal(deals.candidates(OMARI).length, 0, "nothing to say about a price nobody read");

  // A different currency is not comparable, so not a drop.
  shop.price = "150.00"; shop.currency = "EUR"; due();
  await r.checkWatches();
  assert.equal(db.getWatch(OMARI, w.id).met_at, null);
  assert.equal(deals.candidates(OMARI).length, 0);

  // Higher, then back down to above where it started: verified, but not a drop below the start.
  shop.currency = "USD"; shop.price = "219.00"; due();
  await r.checkWatches();
  shop.price = "209.00"; due();
  await r.checkWatches();
  row = db.getWatch(OMARI, w.id);
  assert.equal(row.met_at, null);
  assert.equal(row.last_price_cents, 20900, "the last verified price is what the next check compares with");

  // Really lower than the last verified offer AND below where it started: a drop, with both records.
  shop.price = "179.00"; due();
  const out = await r.checkWatches();
  assert.equal(out.met, 1);
  row = db.getWatch(OMARI, w.id);
  assert.ok(row.met_at);
  const o = db.getOffer(OMARI, row.alert_offer_id);
  const p = db.getOffer(OMARI, row.alert_prev_offer_id);
  assert.equal(o.price_cents, 17900);
  assert.equal(p.price_cents, 20900, "compared with the previous VERIFIED offer, not the start or a guess");
  assert.equal(o.url, URL1);
  assert.ok(o.fetched_at > p.fetched_at);

  // Fires once.
  shop.price = "99.00"; due();
  await r.checkWatches();
  assert.equal(db.getWatch(OMARI, w.id).alert_offer_id, o.id);
});

test("a redirect to a different product is not a price for this one", async () => {
  const w = await watchIt();
  shop.price = "99.00"; shop.sku = "OTHER-9"; due();
  await rt().checkWatches();
  assert.equal(db.getWatch(OMARI, w.id).met_at, null);
  assert.equal(db.getWatch(OMARI, w.id).unverified_streak, 1);
});

// ---------- the alert ----------

test("the alert carries the verified offer and passes the reply check; nothing opens a way to spend", async () => {
  const w = await watchIt();
  shop.price = "179.00"; due();
  await rt().checkWatches();
  const row = db.getWatch(OMARI, w.id);
  skipToLocalHour(10);

  const [cand] = deals.candidates(OMARI);
  assert.equal(cand.kind, "deal_drop");
  assert.equal(cand.source, URL1, "the link is the page that was read");
  assert.match(cand.what, /\$179\.00 now, was \$199\.00/);
  assert.match(cand.detail, new RegExp(`offer_id ${row.alert_offer_id} read off the page at \\d{4}-`));

  // The sweep raises it, through the ordinary gate.
  let frame = "";
  const r = new Runtime({
    fetchImpl: fakeFetch,
    runTurn: async ({ conversationId, text, kind }) => {
      frame = text;
      offers.beginTurn(conversationId, text, kind);
      const sent = await runTool("notice_send", { key: cand.key, what: "it dropped", why_now: "they asked", specific_to_them: true, one_word_answerable: true }, { conversationId, kind, messages: [] });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      // A reply that leaves the offer out gets it added; one that has figures passes as is.
      const bare = offers.guardReply(conversationId, "they dropped! want them?");
      assert.ok(bare.text.includes(URL1), "the link is added");
      assert.ok(bare.text.includes("$179.00"), "the verified price is added");
      assert.match(bare.text, /checked /);
      const full = offers.guardReply(conversationId, `the headphones are $179.00 now, was $199.00 — ${URL1}`);
      assert.equal(full.flags.filter(f => f.rule === "dollar_unsourced").length, 0, "the figures are sourced");
      assert.equal(full.flags.filter(f => f.rule === "discount_unsourced").length, 0);
      return "they dropped";
    },
  });
  const out = await r.notice();
  assert.equal(out.turns, 1, JSON.stringify(out));
  assert.match(frame, /deal_drop:/);
  assert.match(frame, /Nothing has been bought/);

  // No way to spend was opened: no confirm pending, no permission, no purchase, no spend.
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM confirmations").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM permissions").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM agentcard_purchases").get().n, 0);
  const src = readFileSync(new URL("../src/deals.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\/(agentcard|trust|permissions)\.js"/, "deals.js cannot reach a spend path");
});

test("a drop found at night is held for the morning by the notice gate", async () => {
  await watchIt();
  shop.price = "179.00";
  skipToLocalHour(3);
  await rt().checkWatches();
  const turns = [];
  const r = new Runtime({ fetchImpl: fakeFetch, runTurn: async (a) => { turns.push(a); return null; } });
  let out = await r.notice();
  assert.equal(turns.length, 0, "no turn at 3am");
  assert.ok(out.skipped.some(s => s.why === "quiet_hours"), JSON.stringify(out));
  skipToLocalHour(10);
  out = await r.notice();
  assert.equal(turns.length, 1, "raised in the morning");
  assert.match(turns[0].text, /deal_drop:/);
});

// ---------- blocks and bounds ----------

test("a shop that blocks stops the watch, they are told, and it is never retried", async () => {
  const w = await watchIt();
  shop.status = 403; due();
  const out = await rt().checkWatches();
  assert.equal(out.gave_up, 1);
  const row = db.getWatch(OMARI, w.id);
  assert.ok(row.blocked_at && row.stopped_at && row.gave_up_at);
  assert.match(row.stopped_why, /refused to be read \(it answered 403\)/);
  const reads = shop.reads.length;
  for (let i = 0; i < 3; i++) { due(); await rt().checkWatches(); }
  assert.equal(shop.reads.length, reads, "no retry, no workaround");
  const [cand] = deals.candidates(OMARI);
  assert.equal(cand.kind, "deal_watch_stopped");
  assert.match(cand.what, /stopped watching/);
  assert.equal((await call("watch_list", { include_closed: true })).watches[0].blocked, true);
});

test("a page that stops carrying a price stops the watch after a few tries, and says so", async () => {
  const w = await watchIt();
  shop.price = null;
  for (let i = 0; i < config.dealWatchMaxUnverified; i++) { due(); await rt().checkWatches(); }
  const row = db.getWatch(OMARI, w.id);
  assert.ok(row.stopped_at);
  assert.equal(row.blocked_at, null);
  assert.equal(deals.candidates(OMARI)[0].kind, "deal_watch_stopped");
});

test("rechecks are bounded: a floor on the interval, one read per shop per pass", async () => {
  offers.beginTurn(OMARI, "watch both", "user");
  const a = (await call("offer_check", { url: URL1 })).offer.offer_id;
  const b = (await call("offer_check", { url: "https://shop.example/p/other-9" })).offer.offer_id;
  const wa = await call("deal_watch_set", { offer_id: a, said: "watch both", every_hours: 1 });
  assert.equal(wa.watch.every_hours, config.dealWatchMinEveryHours, "floored");
  await call("deal_watch_set", { offer_id: b, said: "watch both" });
  shop.reads.length = 0;
  due();
  await rt().checkWatches();
  assert.equal(shop.reads.length, 1, "two watches on one shop: one read this pass");
  await rt().checkWatches();
  assert.equal(shop.reads.length, 2, "the other on the next pass");
});
