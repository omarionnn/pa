// Shopping friction from the 7-day review (2026-11-07). One face wash took 20 hours, 8 runs, 4 stores:
// the CVS payment ask (16:22 UTC 10-31, $26.65) and its Face ID link died at minute ten — Crossmint holds
// a payment request ten minutes and the link was cut to that — before he reached it. What these hold:
//   1. The approval lasts thirty minutes from the first ask. When the store's hold runs out first, the
//      same checkout is asked again by code, one line says so, and the half hour carries over.
//   2. One reminder before it runs out, per purchase, never twice.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-shop-small-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.REASON_PASSKEY_PAY = "owner";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const passkey = await import("../src/passkey.js");
const { approveRequest } = await import("../src/pages/webapprove.js");
const shoptools = await import("../src/shoptools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const CVS = "https://www.cvs.com/shop/cerave-hydrating-facial-cleanser-16-oz";
const q = (sql) => db.db.prepare(sql);

let calls, runs, nextRun;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  calls.push({ method: init.method ?? "GET", path: u.pathname });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1 };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages|\/cancel)?$/.exec(p);
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { message: "not found" });
  return reply(404, { message: "no route" });
}
const PAY = (requestId, { value = "26.65", question = `Please approve a card payment of $${value} to CVS.`, breakdown = null } = {}) => ({
  requestId, request: {
    question, expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value, currency: "USD", ...(breakdown ? { breakdown } : {}) }, merchant: { name: "CVS", countryCode: "US", url: "https://www.cvs.com/" } },
  },
});
const EXPIRED = { status: "failed", requiredAction: null, reason: "input_expired", revision: 3 };

const said = [];
before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: () => {}, base: "https://heyreason.com/web/connect" });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; said.length = 0; clock.reset();
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "pay_passkeys", "pay_approvals"]) db.db.exec(`DELETE FROM ${t}`);
});
const start = () => shop.startCheckout({ conversationId: OMARI, store: "cvs", startUrl: CVS, what: "One CeraVe Hydrating Facial Cleanser, 16 oz, for dry skin, shipped to home.", item: "CeraVe Hydrating Facial Cleanser 16 oz", maxUsd: 35 });
const runRow = (id) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(id);
/** A passkey on file (its key is never used here: these tests stop before Face ID). */
const withPasskey = () => q("INSERT INTO pay_passkeys (id, conversation_id, public_key, counter, created_at, usable_at) VALUES ('pk1', ?, x'00', 0, ?, ?)").run(OMARI, clock.now(), clock.now());
const tokenIn = (text) => /\/web\/approve\/([A-Za-z0-9_-]{20,})/.exec(text)?.[1];
const page = (token) => approveRequest({ sub: token, method: "GET", headers: {}, readBody: async () => "" });

// ---------------------------------------------------------------- 1. thirty minutes
test("the Face ID link lasts thirty minutes from the ask, not the store's ten-minute hold", async () => {
  withPasskey();
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  await shop.step(a.runId);
  const token = tokenIn(said.at(-1).t);
  assert.ok(token, "the ask carries the link");
  const appr = passkey.approvalFor(token);
  assert.ok(Math.abs(appr.expires_at - appr.created_at - 30 * 60_000) < 2000, "thirty minutes");
  const body = (await page(token)).body;
  assert.match(body, /RUNS OUT IN 30 MIN/);
  assert.match(body, /runs out in thirty minutes/);
});

test("the store lets go at minute ten: the same checkout is asked again once, one line, nothing charged; the old link says why; the new link keeps the first half hour", async () => {
  withPasskey();
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  await shop.step(a.runId);
  const first = tokenIn(said.at(-1).t);
  const askedAt = runRow(a.runId).ask_since;
  assert.ok(askedAt);
  clock.skip(10 * 60_000 + 5000);
  runs[a.runId] = { ...EXPIRED };
  const out = await shop.step(a.runId);
  assert.equal(out.renewed, "run_2");
  assert.equal(said.at(-1).t, "CVS let go of the cart before you approved, so I'm asking again for CeraVe Hydrating Facial Cleanser 16 oz. Nothing was charged. A fresh link comes with the total.");
  assert.doesNotMatch(said.map((s) => s.t).join("\n"), /didn't get it in time|Want me to start it again/);
  const fresh = runRow("run_2");
  assert.equal(fresh.ask_since, askedAt);
  assert.equal(fresh.renewals, 1);
  // The old link can't pay, and its page says what happened instead of "run out".
  assert.equal(passkey.approvalFor(first).state, "renewed");
  const old = await page(first);
  assert.match(old.body, /The store let go of the cart/);
  assert.match(old.body, /fresh link comes by text/);
  // The store asks again; the new link ends where the first half hour ends.
  clock.skip(2 * 60_000);
  runs.run_2.requiredAction = PAY("req_2");
  await shop.step("run_2");
  const second = passkey.approvalFor(tokenIn(said.at(-1).t));
  assert.equal(second.expires_at, askedAt + 30 * 60_000);
});

test("past the half hour, or asked again twice already, the run ends as before with the question", async () => {
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  await shop.step(a.runId);
  q("UPDATE shop_runs SET renewals = ? WHERE run_id = ?").run(shop.RENEW_MAX, a.runId);
  clock.skip(10 * 60_000 + 5000);
  runs[a.runId] = { ...EXPIRED };
  const out = await shop.step(a.runId);
  assert.equal(out.renewed, undefined);
  assert.match(said.at(-1).t, /didn't get it in time/);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 1);
});

test("a declined payment is never asked again", async () => {
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  await shop.step(a.runId);
  q("UPDATE shop_payments SET status = 'declined'").run();
  runs[a.runId] = { ...EXPIRED };
  const out = await shop.step(a.runId);
  assert.equal(out.renewed, undefined);
});

test("a payment still in flight (Face ID tapped) when the hold runs out is not asked again", async () => {
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  await shop.step(a.runId);
  q("UPDATE shop_payments SET status = 'paying'").run();
  runs[a.runId] = { ...EXPIRED };
  const out = await shop.step(a.runId);
  assert.equal(out.renewed, undefined);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 1);
});

// ---------------------------------------------------------------- 2. one reminder
test("one reminder before the approval runs out: amount, store, the clock time; once across a store asked again", async () => {
  withPasskey();
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  // This store holds the cart the whole half hour.
  runs[a.runId].requiredAction.request.expiresAt = new Date(clock.now() + 40 * 60_000).toISOString();
  await shop.step(a.runId);
  const n = said.length;
  clock.skip(20 * 60_000);
  await shop.step(a.runId);
  assert.equal(said.length, n, "nothing yet at minute 20");
  clock.skip(5 * 60_000 + 1000);
  const out = await shop.step(a.runId);
  assert.equal(out.reminded, true);
  assert.match(said.at(-1).t, /^Still waiting on your approval: \$26\.65 at CVS for CeraVe Hydrating Facial Cleanser 16 oz, until \d{1,2}:\d{2} [AP]M\. The Face ID link I sent still works until then\.$/);
  clock.skip(60_000);
  await shop.step(a.runId);
  assert.equal(said.filter((s) => /^Still waiting on your approval/.test(s.t)).length, 1);
});

test("the store's last hold ends before the half hour: the reminder comes before the hold does", async () => {
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1");
  await shop.step(a.runId);
  q("UPDATE shop_runs SET renewals = ? WHERE run_id = ?").run(shop.RENEW_MAX, a.runId);
  clock.skip(5 * 60_000 + 1000);
  const out = await shop.step(a.runId);
  assert.equal(out.reminded, true);
  assert.match(said.at(-1).t, /Still waiting on your approval: \$26\.65 at CVS/);
});

// ---------------------------------------------------------------- 3. the price, in parts
test("the Face ID page shows item, shipping, tax and total from the store's figures (Walmart's words, 10-31)", async () => {
  withPasskey();
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1", { value: "25.00", question: "Order total $25.00 (item $15.97, shipping $6.99, estimated tax $2.04). Approve the card payment?" });
  await shop.step(a.runId);
  const row = q("SELECT * FROM shop_payments WHERE request_id = 'req_1'").get();
  assert.deepEqual(JSON.parse(row.breakdown), [["item", "15.97"], ["shipping", "6.99"], ["tax", "2.04"]]);
  const body = (await page(tokenIn(said.at(-1).t))).body;
  const rows = [...body.matchAll(/<tr[^>]*><th scope="row">([^<]+)<\/th><td>([^<]+)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows.slice(0, 4), [["Item", "$15.97"], ["Shipping", "$6.99"], ["Tax", "$2.04"], ["Total", "$25.00"]]);
});

test("a structured breakdown is shown too; a store that gave one number is said plainly, never invented", async () => {
  withPasskey();
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_1", { value: "28.24", breakdown: { subtotal: { value: "19.99" }, shipping: { value: "5.99" }, tax: { value: "2.26" } } });
  await shop.step(a.runId);
  let body = (await page(tokenIn(said.at(-1).t))).body;
  assert.match(body, /<th scope="row">Item<\/th><td>\$19\.99<\/td>.*<th scope="row">Shipping<\/th><td>\$5\.99<\/td>.*<th scope="row">Tax<\/th><td>\$2\.26<\/td>.*<th scope="row">Total<\/th><td>\$28\.24<\/td>/s);
  const b = await start();
  runs[b.runId].requiredAction = PAY("req_2", { value: "26.65" });
  await shop.step(b.runId);
  body = (await page(tokenIn(said.at(-1).t))).body;
  assert.match(body, /Item, shipping and tax<\/th><td>all in the total/);
  assert.match(body, /<th scope="row">Total<\/th><td>\$26\.65<\/td>/);
  assert.match(body, /CVS gave one number, with shipping and tax in it\./);
  assert.doesNotMatch(body, /\$0\.00/);
});

// ---------------------------------------------------------------- 4. the right variant
// 10-31: three runs bought toward the Foaming cleanser (normal to oily skin) before the Hydrating one
// (normal to dry). Whether the item fits what they said is the model's read, never a keyword list.
const FOAMING = { store: "CVS", start_url: "https://www.cvs.com/shop/cerave-foaming-16oz", what: "One CeraVe Foaming Facial Cleanser, 16 oz, shipped to home.", item: "CeraVe Foaming Facial Cleanser 16 oz", max_usd: 35, their_need: "for my dry skin" };
const said11 = [{ role: "user", content: "Buy me the CeraVe face wash, the one for dry skin" }, { role: "assistant", content: "On it." }];
const posts = () => calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length;

test("a variant that doesn't fit what they said is not started: the model hears what they said and how this differs", async () => {
  let asked = null;
  shoptools._setFitCheck(async (args) => { asked = args; return { value: { verdict: "mismatch", need: "dry skin", why: "The Foaming cleanser is made for normal to oily skin." } }; });
  try {
    const out = await shoptools.runShopTool("store_checkout", FOAMING, { conversationId: OMARI, messages: said11 });
    assert.equal(out.ok, false);
    assert.equal(out.blocked, "variant_mismatch");
    assert.match(out.say, /^Not started: they said dry skin\. The Foaming cleanser is made for normal to oily skin\. Find the variant/);
    assert.match(out.say, /variant_confirmed: true/);
    assert.equal(posts(), 0, "nothing reached the store");
    // Their own words and the noted need went to the model; its own lines did not.
    assert.match(asked.prompt, /- Buy me the CeraVe face wash, the one for dry skin/);
    assert.doesNotMatch(asked.prompt, /On it\./);
    assert.match(asked.prompt, /The need the assistant noted: for my dry skin/);
    assert.match(asked.prompt, /The checkout will buy: CeraVe Foaming Facial Cleanser 16 oz/);
    // They said they want this one anyway: started, and the check is not asked again.
    asked = null;
    const again = await shoptools.runShopTool("store_checkout", { ...FOAMING, variant_confirmed: true }, { conversationId: OMARI, messages: said11 });
    assert.equal(again.ok, true);
    assert.equal(asked, null);
    assert.equal(posts(), 1);
  } finally { shoptools._setFitCheck(null); }
});

test("a fit, an unclear read, or a side call that fails all start the checkout (it fails open; nothing is charged by starting)", async () => {
  for (const ask of [async () => ({ value: { verdict: "fits", need: "dry skin", why: "" } }), async () => ({ value: { verdict: "unclear", need: "", why: "" } }), async () => { throw new Error("cli down"); }, async () => ({ error: "timeout" })]) {
    shoptools._setFitCheck(ask);
    try {
      const out = await shoptools.runShopTool("store_checkout", { ...FOAMING, item: "CeraVe Hydrating Facial Cleanser 16 oz" }, { conversationId: OMARI, messages: said11 });
      assert.equal(out.ok, true);
    } finally { shoptools._setFitCheck(null); }
  }
  assert.equal(posts(), 4);
});
