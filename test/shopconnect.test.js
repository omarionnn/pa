// Crossmint checkouts (src/shopconnect.js, src/shoptools.js, src/pages/webconnect.js), against a fake
// Crossmint that answers the routes their docs document. What these hold, in the order Omari asked:
//   1. A store password or code never reaches this server as text, is never logged, never stored.
//   2. One Crossmint user and one browser profile per person; stores are remembered per person + store.
//   3. A connected store is reused without asking; guest stays guest; removing it brings the ask back.
//   4. A payment is paid only on a yes to that exact ask, for Crossmint's exact amount.
//   5. The page's states follow the record; the flag keeps all of it from everybody else.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-shop-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { connectRequest } = await import("../src/pages/webconnect.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const EMAIL = "omari.secret.mailbox@example.com";

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, profiles, nextRun;
function reset() {
  calls = []; runs = {}; profiles = {}; nextRun = 1;
}
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const h = init.headers ?? {};
  calls.push({ method: init.method ?? "GET", path: u.pathname, headers: h, body });
  const who = h["x-crossmint-user-id"];
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts/browser-profiles" && init.method === "POST") {
    if (profiles[who]) return reply(409, { message: "exists" });
    profiles[who] = { id: `bp_${Object.keys(profiles).length + 1}` };
    return reply(201, profiles[who]);
  }
  if (p === "/api/unstable/agent-checkouts/browser-profiles") return reply(200, profiles[who] ? [profiles[who]] : []);
  if (p.startsWith("/api/unstable/agent-checkouts/browser-profiles/") && init.method === "DELETE") {
    for (const k of Object.keys(profiles)) if (profiles[k].id === p.split("/").pop()) delete profiles[k];
    return reply(204);
  }
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages)?$/.exec(p);
  if (m && m[2]) { if (failMessages) throw new Error("socket hang up"); return reply(202, { ok: true }); }
  if (m) return reply(200, { runId: m[1], ...runs[m[1]] });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  if (p.startsWith("/api/2026-09-16/payment-methods/")) return reply(init.method === "DELETE" ? 204 : 200, { ok: true });
  return reply(404, { message: "no route" });
}
const SIGNIN = (requestId, password = { key: "password", label: "Password" }) => ({
  type: "input_response", requestId, request: {
    question: "Enter your Target email and password.",
    interaction: { kind: "form", fields: [
      { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text", autoComplete: "email" } },
      { ...password, required: true, handling: "protected", input: { kind: "text", display: "masked", autoComplete: "current-password" } },
    ] },
  },
});
const OTP = (requestId) => ({
  type: "input_response", requestId, request: {
    question: "Enter the code Target sent to ••• ••• 0142.",
    interaction: { kind: "form", fields: [{ key: "code", label: "Code", required: true, handling: "protected", input: { kind: "text", autoComplete: "one-time-code", inputMode: "numeric" } }] },
  },
});
const PAY = (requestId, value = "9.79", kind = "exact") => ({
  type: "input_response", requestId, request: {
    question: `Please approve a card payment of $${value} to Best Buy.`, expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind, value, currency: "USD" }, merchant: { name: "Best Buy", countryCode: "US", url: "https://www.bestbuy.com/" } },
  },
});
const said = [];
let failMessages = false;
const q = (sql) => db.db.prepare(sql);
before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }), base: "https://heyreason.test/web/connect" }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { reset(); said.length = 0; for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_store_info"]) db.db.exec(`DELETE FROM ${t}`); });

/** Runs a sign-in checkout at Target to its first question and returns the texted link's token. */
async function signinLink(conv = OMARI) {
  const out = await shop.startCheckout({ conversationId: conv, store: "target", startUrl: "https://www.target.com/s?searchTerm=swabs", what: "Buy one up&up cotton swabs.", maxUsd: 15 });
  runs[out.runId].status = "awaiting_input";
  runs[out.runId].requiredAction = SIGNIN("req_signin_1");
  await shop.step(out.runId);
  const token = said.at(-1).t.split("/").pop();
  return { runId: out.runId, token };
}
const dumpTables = () => ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments"].map((t) => JSON.stringify(db.db.prepare(`SELECT * FROM ${t}`).all())).join("\n");

// ---------------------------------------------------------------- 1. secrets
test("a password typed as text is refused; only Crossmint's reference goes through", async () => {
  const { runId, token } = await signinLink();
  const asText = await shop.answerLink(token, { requestId: "req_signin_1", answers: { email: EMAIL, password: "hunter2" } });
  assert.equal(asText.ok, false);
  assert.equal(asText.error, "protected_must_be_reference");
  const sneaky = await shop.answerLink(token, { requestId: "req_signin_1", answers: { email: EMAIL, password: { protectedInputId: "pi_1", value: "hunter2" } } });
  assert.equal(sneaky.ok, false, "a reference carrying anything else is refused too");
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 0, "nothing reached Crossmint");

  const ok = await shop.answerLink(token, { requestId: "req_signin_1", answers: { email: EMAIL, password: { protectedInputId: "pi_abc123" } } });
  assert.equal(ok.ok, true);
  const sent = calls.find((c) => c.path === `/api/unstable/agent-checkouts/${runId}/messages`).body.parts[0];
  assert.deepEqual(sent.response.answers.password, { protectedInputId: "pi_abc123" });
  assert.ok(!JSON.stringify(sent).includes("hunter2"));
});

test("answers are never stored or logged: only which fields were answered", async () => {
  const { token } = await signinLink();
  const logs = [];
  const out = await connectRequest({ sub: `${token}/answer`, method: "POST", readBody: async () => JSON.stringify({ requestId: "req_signin_1", answers: { email: EMAIL, password: { protectedInputId: "pi_zzz999" } } }), log: (e) => logs.push(e) });
  assert.equal(out.status, 200);
  const logged = JSON.stringify(logs);
  assert.ok(logged.includes("password") && logged.includes("email"), "the field keys are logged");
  assert.ok(!logged.includes(EMAIL) && !logged.includes("pi_zzz999"), "no value is");
  const stored = dumpTables();
  assert.ok(!stored.includes(EMAIL) && !stored.includes("pi_zzz999"), "no value is stored either");
  assert.ok(!stored.includes(token), "the link token itself is kept only as a hash");
});

test("the page draws the password as Crossmint's sealed slot, never an input of ours", async () => {
  const { token } = await signinLink();
  const out = await connectRequest({ sub: token, method: "GET" });
  assert.equal(out.status, 200);
  assert.match(out.body, /data-protected="password"/);
  assert.ok(!/name="password"/.test(out.body), "no form input of ours carries the password");
  assert.match(out.body, /Sign in to Target\./);
  assert.match(out.headers["Content-Security-Policy"], /frame-src https:\/\/www\.crossmint\.com/);
});

// ---------------------------------------------------------------- 2. per person, per store
test("one Crossmint user and one profile per person, never shared", async () => {
  process.env.REASON_SHOP_CONNECT = "on";
  try {
    assert.notEqual(shop.crossmintUser(OMARI), shop.crossmintUser(AMA));
    assert.ok(!shop.crossmintUser(AMA).includes("3475550000"), "the user id never carries their number");
    const a = await shop.ensureProfile(OMARI);
    const again = await shop.ensureProfile(OMARI);
    const b = await shop.ensureProfile(AMA);
    assert.equal(a, again);
    assert.notEqual(a, b);
    assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/browser-profiles")).length, 2, "one profile made per person");
    for (const c of calls) assert.ok(c.headers["x-crossmint-user-id"], "every server call names its person");
  } finally { process.env.REASON_SHOP_CONNECT = "owner"; }
});

test("a store is connected for that person and that store only", async () => {
  const { runId } = await signinLink(OMARI);
  runs[runId].requiredAction = PAY("req_pay_1");
  await shop.step(runId);
  assert.equal(shop.isConnected(OMARI, "target"), true, "past the sign-in, Target is theirs");
  assert.equal(shop.isConnected(OMARI, "walmart"), false);
  assert.equal(shop.isConnected(AMA, "target"), false);
});

// ---------------------------------------------------------------- 3. remembered
test("a connected store is reused without asking; guest stays guest; removing it asks again", async () => {
  assert.equal(shop.checkoutPlan(OMARI, "bestbuy"), "guest");
  assert.equal(shop.checkoutPlan(OMARI, "target"), "sign_in");
  shop.markConnected(OMARI, "target");
  await shop.ensureProfile(OMARI);
  calls.length = 0;
  const out = await shop.startCheckout({ conversationId: OMARI, store: "target", startUrl: "https://www.target.com/", what: "Buy swabs.", maxUsd: 10 });
  assert.equal(out.plan, "signed");
  const body = calls.find((c) => c.path === "/api/unstable/agent-checkouts").body;
  assert.ok(body.browser.profileId);
  assert.ok(!/Sign in to my/.test(body.request.task), "no sign-in step when they're already signed in");

  const guest = await shop.startCheckout({ conversationId: OMARI, store: "bestbuy", startUrl: "https://www.bestbuy.com/", what: "Buy a cable.", maxUsd: 15 });
  assert.equal(guest.plan, "guest");
  assert.equal(calls.at(-1).body.browser, undefined, "a guest checkout carries nothing of theirs");

  await shop.removeStore(OMARI, "target");
  assert.equal(shop.checkoutPlan(OMARI, "target"), "sign_in");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path.includes("/browser-profiles/")), "the last store removed erases the profile");
  assert.equal(shop.profileOf(OMARI), null);
});

test("the sign-in link is texted once per run; later questions land on the same page", async () => {
  const { runId, token } = await signinLink();
  assert.equal(said.length, 1);
  assert.match(said[0].t, /Target needs you signed in/);
  await shop.answerLink(token, { requestId: "req_signin_1", answers: { email: EMAIL, password: { protectedInputId: "pi_1" } } });
  assert.equal(shop.linkView(shop.linkFor(token)).state, "checking");
  runs[runId].requiredAction = OTP("req_otp_1");
  await shop.step(runId);
  assert.equal(said.length, 1, "no second text");
  assert.equal(shop.linkView(shop.linkFor(token)).state, "code");
});

// ---------------------------------------------------------------- 4. payment
async function askedPayment(value = "9.79", kind = "exact", requestId = "req_pay_9") {
  const out = await shop.startCheckout({ conversationId: OMARI, store: "bestbuy", startUrl: "https://www.bestbuy.com/", what: "Buy the BE 4' USB-C cable.", item: "a 4-ft USB-C cable", maxUsd: 15 });
  runs[out.runId].status = "awaiting_input";
  runs[out.runId].requiredAction = PAY(requestId, value, kind);
  await shop.step(out.runId);
  return db.db.prepare("SELECT * FROM shop_payments WHERE request_id = ?").get(requestId);
}
const owner = (t) => ({ role: "user", content: `[Fri, Oct 30, 2026, 1:00 PM] Omari: ${t}` });
const readsYes = async () => ({ verdict: "yes" });

test("the ask is Crossmint's exact amount, store and item", async () => {
  const row = await askedPayment();
  assert.equal(said.at(-1).t, "OK to pay $9.79 at Best Buy for a 4-ft USB-C cable?");
  assert.equal(row.amount, "9.79");
});

test("no payment without a yes; the yes is pinned to the exact amount; the amount paid is Crossmint's", async () => {
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'visa', '4242', ?)").run(OMARI, clock.now());
  const row = await askedPayment();
  const messages = [owner("buy me that cable")];
  const call = (name, input) => runTool(name, input, { conversationId: OMARI, messages, judge: readsYes });

  const refused = await call("shop_pay", { payment_id: row.id });
  assert.equal(refused.ok, false);
  assert.ok(refused.use_target.includes("exact 9.79 USD"), refused.use_target);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0, "nothing paid without a yes");

  // A yes collected against a different amount does not pay this one.
  const wrong = await call("confirm_request", { action: "shop_pay", summary: "Pay $9.80 at Best Buy?", stakes: "money", target: refused.use_target.replace("9.79", "9.80") });
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: wrong.confirmation_id })).state, "granted");
  const mismatch = await call("shop_pay", { payment_id: row.id, confirmation_id: wrong.confirmation_id });
  assert.equal(mismatch.blocked, "wrong_target");

  // No yes said yet: not granted.
  const req = await call("confirm_request", { action: "shop_pay", summary: "OK to pay $9.79 at Best Buy for the cable?", stakes: "money", target: refused.use_target });
  const early = await call("confirm_record", { confirmation_id: req.confirmation_id });
  assert.equal(early.state, "waiting_for_yes", "a yes that wasn't said after the ask doesn't count");
  messages.push(owner("yes go ahead"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");
  const paid = await call("shop_pay", { payment_id: row.id, confirmation_id: req.confirmation_id });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const oi = calls.find((c) => c.path === "/api/unstable/order-intents");
  assert.deepEqual(oi.body.amount, { value: "9.79", currency: "USD" }, "the order intent is for Crossmint's amount, as given");
  assert.equal(oi.body.merchant.name, "Best Buy");
  const answer = calls.filter((c) => c.path.endsWith("/messages")).at(-1).body.parts[0];
  assert.equal(answer.requestId, "req_pay_9");
  assert.equal(answer.response.kind, "payment");
  assert.equal(answer.response.orderIntentId, oi.body && answer.response.orderIntentId);

  const twice = await call("shop_pay", { payment_id: row.id, confirmation_id: req.confirmation_id });
  assert.equal(twice.ok, false, "a yes pays once");
  const { NEVER_STANDING } = await import("../src/permissions.js");
  assert.ok(NEVER_STANDING.has("shop_pay"), "no standing permission can ever stand in for the yes");
});

test("a no never pays: a refusal declines at Crossmint", async () => {
  const row = await askedPayment();
  const messages = [owner("buy me that cable")];
  const call = (name, input) => runTool(name, input, { conversationId: OMARI, messages, judge: async () => ({ verdict: "no" }) });
  const refused = await call("shop_pay", { payment_id: row.id });
  const req = await call("confirm_request", { action: "shop_pay", summary: "OK to pay $9.79?", stakes: "money", target: refused.use_target });
  messages.push(owner("actually no"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "refused");
  assert.equal((await call("shop_pay", { payment_id: row.id, confirmation_id: req.confirmation_id })).ok, false);
  assert.equal((await call("shop_decline", { payment_id: row.id })).ok, true);
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).at(-1).body.parts[0].action, "decline");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
});

test("a maximum is never asked or paid: declined at Crossmint, said as a ceiling", async () => {
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'visa', '4242', ?)").run(OMARI, clock.now());
  const row = await askedPayment("15.00", "maximum");
  assert.doesNotMatch(said.at(-1).t, /OK to pay/);
  assert.match(said.at(-1).t, /ceiling \(\$15\.00\).*Nothing was charged/);
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).at(-1).body.parts[0].action, "decline");
  q("UPDATE shop_payments SET status = 'asked' WHERE id = ?").run(row.id);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: row.id })).error, "not_exact_amount");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
});

test("pays once even when asked twice at the same time; an unknown answer is never retried", async () => {
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'visa', '4242', ?)").run(OMARI, clock.now());
  const row = await askedPayment();
  const both = await Promise.all([shop.payApproved({ conversationId: OMARI, paymentId: row.id }), shop.payApproved({ conversationId: OMARI, paymentId: row.id })]);
  assert.deepEqual(both.map((o) => o.ok).sort(), [false, true]);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 1);

  const row2 = await askedPayment("4.20", "exact", "req_pay_unknown");
  failMessages = true;
  try {
    const out = await shop.payApproved({ conversationId: OMARI, paymentId: row2.id });
    assert.equal(out.unknown_outcome, true);
    assert.equal(shop.paymentRow(row2.id).status, "unknown");
    assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: row2.id })).error, "payment_unknown");
  } finally { failMessages = false; }
});

test("an unreadable expiry counts as passed; someone else's payment reads as unknown", async () => {
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'visa', '4242', ?)").run(OMARI, clock.now());
  const row = await askedPayment();
  q("UPDATE shop_payments SET expires_at = 'soon' WHERE id = ?").run(row.id);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: row.id })).error, "payment_expired");
  const { shopPayTarget } = await import("../src/shoptools.js");
  assert.match(shopPayTarget({ payment_id: row.id }, AMA), /^unknown payment/);
  assert.match(shopPayTarget({ payment_id: row.id }, OMARI), /exact 9\.79 USD/);
});

// ---------------------------------------------------------------- 5. states and the flag
test("the link runs out after half an hour", async () => {
  const { token } = await signinLink();
  const real = clock.now;
  clock.now = () => real() + shop.LINK_TTL_MS + 1000;
  try { assert.equal(shop.linkView(shop.linkFor(token)).state, "expired"); } finally { clock.now = real; }
});

test("the same password asked again after an answer reads as 'try again'", async () => {
  const { runId, token } = await signinLink();
  await shop.answerLink(token, { requestId: "req_signin_1", answers: { email: EMAIL, password: { protectedInputId: "pi_1" } } });
  runs[runId].requiredAction = SIGNIN("req_signin_2");
  await shop.step(runId);
  assert.equal(shop.linkView(shop.linkFor(token)).state, "retry");
});

test("owner-only: nobody else sees the tools or the pages", async () => {
  assert.ok(toolsFor(OMARI).some((t) => t.name === "store_checkout"));
  assert.ok(!toolsFor(AMA).some((t) => t.name === "store_checkout" || t.name === "shop_pay"));
  process.env.REASON_SHOP_CONNECT = "on";
  const { token } = await signinLink(AMA);
  process.env.REASON_SHOP_CONNECT = "owner";
  const page = await connectRequest({ sub: token, method: "GET" });
  assert.match(page.body, /This link has run out/, "Ama's link opens nothing while the flag is owner-only");
});

// ---------------------------------------------------------------- 6. any store (owner 10-30)
const icons = await import("../src/storeicons.js");
const { shoppingSection } = await import("../src/pages/websettings.js");
// A fake web for store icons: amazon.com has an apple-touch-icon; everything else has nothing.
const PNG64 = (() => { const b = Buffer.alloc(40); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(64, 16); b.writeUInt32BE(64, 20); return b; })();
let webHits;
const page = (status, body, type) => ({ status, ok: status < 300, headers: { get: (h) => (h === "content-type" ? type : h === "location" ? null : null) }, arrayBuffer: async () => Buffer.from(body) });
function fakeWeb(url) {
  webHits.push(url);
  if (url === "https://www.amazon.com/") return page(200, `<html><head><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="https://m.media-amazon.com/touch-icon.png"></head></html>`, "text/html");
  if (url === "https://m.media-amazon.com/touch-icon.png") return page(200, PNG64, "image/png");
  return page(404, "", "text/html");
}
const publicDns = async (host) => [{ address: /(^|\.)evil\.example$/.test(host) ? "127.0.0.1" : "93.184.216.34", family: 4 }];
let retried;
beforeEach(() => { webHits = []; retried = []; icons._setNet({ fetch: async (u) => fakeWeb(u), lookup: publicDns }); shop._setFollow((id) => retried.push(id)); });

test("any store: its key is its site's name, its name is the one it was given, else its key capitalised", () => {
  assert.equal(shop.storeKey("https://www.amazon.com/dp/B0CX"), "amazon");
  assert.equal(shop.storeKey("Amazon"), "amazon");
  assert.equal(shop.storeKey("bestbuy.com"), "bestbuy", "known stores keep their keys");
  assert.equal(shop.storeKey("Home Depot"), "homedepot");
  assert.equal(shop.storeKey("https://shop.blue-bottle.co.uk/beans"), "bluebottle");
  assert.equal(shop.storeKey("Blue Bottle"), null, "a bare unknown name is keyed by the start URL instead");
  assert.equal(shop.storeName("acmecoffee"), "Acmecoffee");
  shop.rememberStore("acmecoffee", { name: "Acme Coffee", host: "https://www.acmecoffee.com/x" });
  assert.equal(shop.storeName("acmecoffee"), "Acme Coffee");
  assert.equal(shop.storeHost("acmecoffee"), "acmecoffee.com");
  shop.rememberStore("acmecoffee", { name: "ACME!!" });
  assert.equal(shop.storeName("acmecoffee"), "Acme Coffee", "the first name given sticks");
  for (const [k, n] of [["costco", "Costco"], ["cvs", "CVS"], ["walgreens", "Walgreens"], ["sephora", "Sephora"], ["ulta", "Ulta"], ["nike", "Nike"], ["apple", "Apple"]]) assert.equal(shop.storeName(k), n);
});

test("the tool keys an unknown store by its start URL and remembers what it's called", async () => {
  const out = await runTool("store_checkout", { store: "Acme Coffee", start_url: "https://www.acmecoffee.com/beans", what: "Buy one bag of house beans.", item: "a bag of house beans", max_usd: 25 }, { conversationId: OMARI });
  const r = typeof out === "string" ? JSON.parse(out) : out;
  assert.notEqual(r.ok, false, JSON.stringify(r));
  const run = q("SELECT * FROM shop_runs").get();
  assert.equal(run.store, "acmecoffee");
  assert.equal(run.mode, "guest", "an unknown store starts as a guest");
  assert.equal(shop.storeName("acmecoffee"), "Acme Coffee");
});

test("an unknown store's sign-in wall: remembered for that store, retried signed in, the link names it, a monogram", async () => {
  shop.rememberStore("acmecoffee", { name: "Acme Coffee", host: "acmecoffee.com" });
  const first = await shop.startCheckout({ conversationId: OMARI, store: "acmecoffee", startUrl: "https://www.acmecoffee.com/beans", what: "Buy one bag of beans.", item: "a bag of beans", maxUsd: 25 });
  assert.equal(first.plan, "guest");
  runs[first.runId].status = "blocked";
  runs[first.runId].result = { code: "merchant.no_safe_path", summary: "Checkout requires you to sign in or create an account." };
  const out = await shop.step(first.runId);
  assert.equal(shop.needsSignIn("acmecoffee"), true, "learned for the store");
  assert.ok(out.retried, "went again signed in");
  assert.deepEqual(retried, [out.retried]);
  const again = shop.runRow(out.retried);
  assert.equal(again.mode, "sign_in");
  assert.equal(again.start_url, "https://www.acmecoffee.com/beans");
  assert.equal(again.max_usd, 25);
  // The retried run asks to sign in: one text, naming the store, with the link.
  runs[out.retried].status = "awaiting_input";
  runs[out.retried].requiredAction = SIGNIN("req_acme_1");
  await shop.step(out.retried);
  assert.match(said.at(-1).t, /^Acme Coffee needs you signed in/);
  const token = said.at(-1).t.split("/").pop();
  const html = (await connectRequest({ sub: token })).body;
  assert.match(html, /Sign in to Acme Coffee\./);
  assert.match(html, /ACME COFFEE · VIA CROSSMINT/);
  assert.match(html, /cx-mark-x" aria-hidden="true">A</, "no icon on its site: the monogram");
  assert.doesNotMatch(html, /<img/, "never a broken image");
  // A guest run blocked by anything else is not a sign-in wall: no link, nothing learned.
  shop.rememberStore("beanery", { name: "Beanery", host: "beanery.com" });
  const oos = await shop.startCheckout({ conversationId: OMARI, store: "beanery", startUrl: "https://beanery.com/x", what: "Buy beans.", maxUsd: 20 });
  runs[oos.runId].status = "blocked";
  runs[oos.runId].result = { code: "merchant.no_safe_path", summary: "The item is out of stock." };
  const o2 = await shop.step(oos.runId);
  assert.equal(o2.retried, undefined);
  assert.equal(shop.needsSignIn("beanery"), false);
});

test("Amazon's page: its name everywhere and its own icon, fetched once and kept", async () => {
  const out = await shop.startCheckout({ conversationId: OMARI, store: "amazon", startUrl: "https://www.amazon.com/dp/B0", what: "Buy one cable.", maxUsd: 15 });
  assert.equal(out.plan, "sign_in", "Amazon is known to need an account");
  runs[out.runId].status = "awaiting_input";
  runs[out.runId].requiredAction = SIGNIN("req_amzn_1");
  await shop.step(out.runId);
  assert.match(said.at(-1).t, /^Amazon needs you signed in/);
  const token = said.at(-1).t.split("/").pop();
  const html = (await connectRequest({ sub: token })).body;
  assert.match(html, /Sign in to Amazon\./);
  assert.match(html, /AMAZON · VIA CROSSMINT/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /Sign in to Target|TARGET ·/, "nothing of another store");
  const hits = webHits.length;
  await connectRequest({ sub: token });
  assert.equal(webHits.length, hits, "kept: not fetched again");
});

test("remembered per store: connected Amazon is reused, other stores are not; the learned wall is the store's", async () => {
  shop.markConnected(OMARI, "amazon");
  shop.learnSignIn("acmecoffee");
  assert.equal(shop.checkoutPlan(OMARI, "amazon"), "signed");
  assert.equal(shop.checkoutPlan(OMARI, "acmecoffee"), "sign_in");
  assert.equal(shop.checkoutPlan(OMARI, "sephora"), "guest");
  assert.equal(shop.checkoutPlan(AMA, "amazon"), "sign_in", "someone else's Amazon is not Omari's");
  shop.markConnected(OMARI, "acmecoffee");
  shop.rememberStore("acmecoffee", { name: "Acme Coffee" });
  const listed = shop.connectedStores(OMARI).map((s) => s.name).sort();
  assert.deepEqual(listed, ["Acme Coffee", "Amazon"]);
  const sec = shoppingSection({ csrf: "x", shopping: { stores: shop.connectedStores(OMARI), card: null } });
  assert.match(sec, /Acme Coffee/);
  assert.match(sec, /Amazon/);
});

test("store icons: only public https hosts, tiny favicons refused, bytes must be an image", async () => {
  assert.equal(await icons.fetchIcon("evil.example"), "", "a name that resolves to loopback is never fetched");
  assert.equal(webHits.length, 0);
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "172.20.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(icons.privateAddress(ip), true, ip);
  assert.equal(icons.privateAddress("93.184.216.34"), false);
  const tiny = Buffer.from(PNG64); tiny.writeUInt32BE(16, 16);
  assert.equal(icons.sniff(tiny).px, 16);
  assert.equal(icons.sniff(Buffer.from("<html>not an image</html>")), null);
  assert.deepEqual(icons.iconLinks(`<link rel="mask-icon" href="/m.svg"><link rel="shortcut icon" href="/f.ico"><link rel="apple-touch-icon" href="/t.png">`, "https://x.com/"), ["https://x.com/t.png", "https://x.com/f.ico"]);
});
