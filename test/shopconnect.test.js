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
  // The rails read after the intent is made (2026-11-08): a card rail that is ready.
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
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
beforeEach(() => { reset(); said.length = 0; for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping"]) db.db.exec(`DELETE FROM ${t}`); });

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
  // The phone's preview of the texted link: the kind of link, never the store.
  const head = out.body.slice(0, out.body.indexOf("<title>"));
  assert.match(head, /<meta property="og:title" content="Connect your store account">/);
  assert.match(head, /\/web\/og\/secured\/store\.png\?v=\d+/);
  assert.doesNotMatch(head, /Target|og:url/);
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

test("a restaurant's checkout that runs on DoorDash asks for the DoorDash login, and the text and page say DoorDash (11-10 Chick-fil-A)", async () => {
  const out = await shop.startCheckout({ conversationId: OMARI, store: "target", startUrl: "https://www.target.com/", what: "Order one sandwich.", maxUsd: 15 });
  runs[out.runId].status = "awaiting_input";
  const rq = SIGNIN("req_dd_1", { key: "dd_password", label: "DoorDash account password" });
  rq.request.question = "Please enter your DoorDash account email and password so I can sign in and continue this Chick-fil-A delivery checkout.";
  runs[out.runId].requiredAction = rq;
  await shop.step(out.runId);
  const line = said.at(-1).t;
  assert.match(line, /^DoorDash needs you signed in/);
  assert.match(line, /Your password goes straight to DoorDash, not to me\./);
  assert.doesNotMatch(line, /Target|Chick/);
  const view = shop.linkView(shop.linkFor(line.split("/").pop()));
  assert.equal(view.store, "doordash");
  assert.equal(shop.storeName(view.store), "DoorDash", "named even when the food flag leaves DoorDash out of the store list");
  assert.equal(shop.storeHost(view.store), "www.doordash.com", "the page can still link to the account");
  // Past the sign-in: DoorDash is what's connected (Settings shows it, the next DoorDash order runs signed in).
  runs[out.runId].requiredAction = PAY("req_pay_dd");
  await shop.step(out.runId);
  assert.equal(shop.isConnected(OMARI, "doordash"), true);
});

test("whose login a form asks for: the one platform it names, else the store", () => {
  const f = (question, labels = []) => ({ question, fields: labels.map((label) => ({ label })) });
  assert.equal(shop.signinAccount("chickfila", f("Sign in", ["Uber Eats email", "Uber Eats password"])), "ubereats");
  assert.equal(shop.signinAccount("chickfila", f("Enter your Grubhub login")), "grubhub");
  assert.equal(shop.signinAccount("chickfila", f("Enter your Chick-fil-A One email and password")), "chickfila");
  assert.equal(shop.signinAccount("chickfila", f("Sign in with DoorDash or Uber Eats")), "chickfila", "two named: no guess");
  assert.equal(shop.signinAccount("doordash", f("Enter your email")), "doordash");
  assert.equal(shop.signinAccount("target", null), "target");
  // A restaurant's own login that merely mentions the platform it delivers through stays the restaurant's.
  assert.equal(shop.signinAccount("chickfila", f("Enter your Chick-fil-A One password to continue this DoorDash delivery", ["Email", "Password"])), "chickfila");
  assert.equal(shop.signinAccount("chickfila", f("Enter your DoorDash account email and password", ["Email", "Password"])), "doordash");
  assert.equal(shop.signinAccount("chickfila", { request: { question: "x", interaction: { fields: [{ label: "DoorDash account password" }] } } }), "doordash", "Crossmint's nested shape");
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
  assert.equal(said.at(-1).t, "OK to pay $9.79 (total incl. shipping and tax) at Best Buy for a 4-ft USB-C cable?");
  assert.equal(row.amount, "9.79");
});

test("no payment without a yes; the yes is pinned to the exact amount; the amount paid is Crossmint's", async () => {
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
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
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
  const row = await askedPayment("15.00", "maximum");
  assert.doesNotMatch(said.at(-1).t, /OK to pay/);
  assert.match(said.at(-1).t, /ceiling \(\$15\.00\).*Nothing was charged/);
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).at(-1).body.parts[0].action, "decline");
  q("UPDATE shop_payments SET status = 'asked' WHERE id = ?").run(row.id);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: row.id })).error, "not_exact_amount");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
});

test("pays once even when asked twice at the same time; an unknown answer is never retried", async () => {
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
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
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
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
  assert.match(page.body, /This link has expired/, "Ama's link opens nothing while the flag is owner-only");
});

// ---------------------------------------------------------------- 6. any store
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(120, 7)]);
const iconSite = (seen) => async (url) => {
  seen.push(url);
  const u = new URL(url);
  const res = (status, type, body, location) => ({ status, ok: status < 300, url, headers: { get: (h) => (h === "content-type" ? type : h === "location" ? location : null) }, text: async () => String(body), arrayBuffer: async () => (typeof body === "string" ? Buffer.from(body) : body) });
  if (u.hostname === "www.amazon.com" && u.pathname === "/") return res(200, "text/html", `<html><head><link rel="apple-touch-icon" href="/touch.png"></head></html>`);
  if (u.hostname === "www.amazon.com" && u.pathname === "/touch.png") return res(200, "image/png", PNG);
  if (u.hostname === "amazon.com") return res(301, "", "", "https://www.amazon.com/");
  return res(404, "text/html", "nope");
};
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

test("any store: its key and name come from its site; the page names it in text, never a logo", async () => {
  assert.equal(shop.storeKey("https://www.amazon.com/dp/B0"), "amazon");
  assert.equal(shop.storeKey("shop.costco.com"), "costco");
  assert.equal(shop.storeKey("argos.co.uk"), "argos");
  assert.equal(shop.storeKey("Home Depot"), "homedepot");
  assert.equal(shop.checkoutStoreKey("Trader Joe's", "https://www.traderjoes.com/home"), "traderjoes");
  assert.equal(shop.storeName("amazon"), "Amazon");
  assert.equal(shop.storeKey("https://www.target.co/x"), "targetco", "a lookalike is its own store");
  assert.equal(shop.checkoutStoreKey("Target", "https://target-deals.shop/p"), "targetdeals");
  assert.equal(shop.checkoutStoreKey("Target", "https://www.target.com/p/1"), "target");
  shop.noteStore({ store: "pinkfrogshop", name: "pinkfrogshop.com", url: "https://www.pinkfrogshop.com/x" });
  assert.equal(shop.storeName("pinkfrogshop"), "Pinkfrogshop");
  shop.noteStore({ store: "traderjoes", name: "Trader Joe's", url: "https://www.traderjoes.com/" });
  assert.equal(shop.storeName("traderjoes"), "Trader Joe's");
  const seen = [];
  shop._setIconFetch(iconSite(seen), publicDns);
  try {
    assert.equal(await shop.ensureIcon("pinkfrogshop"), "");
    assert.ok(seen.every((u) => u.startsWith("https://pinkfrogshop.com/")), seen.join(" "));
    const { renderView } = await import("../src/pages/webconnect.js");
    const page = renderView({ state: "signin", store: "pinkfrogshop", kind: "signin", request: { requestId: "r", question: "", fields: [] } }).html;
    assert.match(page, /Sign in to Pinkfrogshop\./);
    assert.doesNotMatch(page, /<img\b/, "no store icon");
    // a private address is never fetched
    shop.noteStore({ store: "evil", url: "https://evil.ts.net/" });
    seen.length = 0;
    await shop.ensureIcon("evil");
    assert.equal(seen.length, 0);
  } finally { shop._setIconFetch(null); }
});

test("a store whose name resolves to a private or internal address is never fetched, nor is a redirect to one", async () => {
  const PRIVATE = ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.101.102.103", "0.0.0.0", "::1", "fd00::1", "fc00::5", "fe80::1", "::ffff:127.0.0.1"];
  const seen = [];
  const site = async (url) => {
    seen.push(url);
    const u = new URL(url);
    const res = (status, type, body, location) => ({ status, ok: status < 300, url, headers: { get: (h) => (h === "content-type" ? type : h === "location" ? location : null) }, arrayBuffer: async () => (typeof body === "string" ? Buffer.from(body) : body) });
    if (u.hostname === "hopper.com") return res(302, "", "", "https://inside.hopperstatic.com/favicon.ico");
    return res(200, "image/png", PNG);
  };
  try {
    for (const [i, address] of PRIVATE.entries()) {
      const key = `rebind${i}x`;
      shop.noteStore({ store: key, url: `https://www.${key}.com/` });
      shop._setIconFetch(site, async () => [{ address, family: address.includes(":") ? 6 : 4 }]);
      seen.length = 0;
      assert.equal(await shop.ensureIcon(key), "", address);
      assert.equal(seen.length, 0, `${address}: nothing fetched`);
    }
    // one private answer among public ones is enough to refuse
    shop.noteStore({ store: "mixedstore", url: "https://mixedstore.com/" });
    shop._setIconFetch(site, async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    seen.length = 0;
    assert.equal(await shop.ensureIcon("mixedstore"), "");
    assert.equal(seen.length, 0);
    // DNS that fails is a monogram, not a fetch
    shop.noteStore({ store: "nodnsstore", url: "https://nodnsstore.com/" });
    shop._setIconFetch(site, async () => { throw new Error("ENOTFOUND"); });
    seen.length = 0;
    assert.equal(await shop.ensureIcon("nodnsstore"), "");
    assert.equal(seen.length, 0);
    // a public site that redirects to a private one: the redirect is re-checked and never followed
    shop.noteStore({ store: "hopper", url: "https://hopper.com/" });
    shop._setIconFetch(site, async (h) => [{ address: h === "inside.hopperstatic.com" ? "127.0.0.1" : "93.184.216.34", family: 4 }]);
    seen.length = 0;
    assert.equal(await shop.ensureIcon("hopper"), "");
    assert.ok(seen.length > 0 && seen.every((u) => new URL(u).hostname === "hopper.com"), seen.join(" "));
  } finally { shop._setIconFetch(null); }
});

test("Amazon's page: 'Sign in to Amazon', in text: no logo, and the page never fetches one", async () => {
  const seen = [];
  shop._setIconFetch(iconSite(seen), publicDns);
  try {
    const out = await shop.startCheckout({ conversationId: OMARI, store: "amazon", startUrl: "https://www.amazon.com/s?k=cable", what: "Buy one USB-C cable.", item: "a USB-C cable", maxUsd: 15 });
    assert.equal(out.plan, "sign_in", "Amazon has no guest checkout");
    runs[out.runId].status = "awaiting_input";
    runs[out.runId].requiredAction = SIGNIN("req_amz_1");
    await shop.step(out.runId);
    assert.match(said.at(-1).t, /^Amazon needs you signed in/);
    const token = said.at(-1).t.split("/").pop();
    const page = await connectRequest({ sub: token, method: "GET" });
    assert.equal(page.status, 200);
    assert.match(page.body, /Sign in to Amazon\./);
    assert.doesNotMatch(page.body, /<img\b/, "no store icon on the page (owner 10-30: never a store's logo)");
    assert.doesNotMatch(page.body, /src="https?:/, "the browser never calls the store");
    assert.equal(seen.length, 0, "drawing the page fetches nothing from the store");
  } finally { shop._setIconFetch(null); }
});

test("an unknown store walled off for a guest: remembered, and the same checkout starts again signed in", async () => {
  shop.noteStore({ store: "pinkfrogshop", name: "Pink Frog", url: "https://www.pinkfrogshop.com/" });
  const out = await shop.startCheckout({ conversationId: OMARI, store: "pinkfrogshop", startUrl: "https://www.pinkfrogshop.com/p/1", what: "Buy the frog mug.", item: "a frog mug", maxUsd: 20 });
  assert.equal(out.plan, "guest");
  runs[out.runId].status = "blocked";
  runs[out.runId].result = { code: "merchant.no_safe_path", summary: "Checkout requires you to sign in or create an account." };
  const done = await shop.step(out.runId);
  assert.ok(done.retried, "a signed-in checkout started");
  assert.equal(shop.storeSignIn("pinkfrogshop"), "required");
  const again = calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").at(-1).body;
  assert.equal(again.request.startUrl, "https://www.pinkfrogshop.com/p/1");
  assert.match(again.request.task, /Sign in to my Pink Frog account first/);
  assert.ok(again.browser?.profileId, "their own profile");
  // the next checkout at that store goes straight to signing in
  assert.equal(shop.checkoutPlan(OMARI, "pinkfrogshop"), "sign_in");
  // once per checkout: the signed-in one failing doesn't start a third
  runs[done.retried].status = "blocked";
  runs[done.retried].result = { code: "merchant.no_safe_path", summary: "sign in failed" };
  assert.ok(!(await shop.step(done.retried)).retried);
});

test("a guest run that failed for another reason is not retried", async () => {
  const out = await shop.startCheckout({ conversationId: OMARI, store: "bestbuy", startUrl: "https://www.bestbuy.com/", what: "Buy a cable.", maxUsd: 15 });
  runs[out.runId].status = "blocked";
  runs[out.runId].result = { code: "merchant.no_safe_path", summary: "The item is out of stock at every nearby store." };
  assert.ok(!(await shop.step(out.runId)).retried);
  const card = await shop.startCheckout({ conversationId: OMARI, store: "bestbuy", startUrl: "https://www.bestbuy.com/", what: "Buy a cable.", maxUsd: 15 });
  runs[card.runId].status = "failed";
  runs[card.runId].result = { code: "card.auth_declined" };
  assert.ok(!(await shop.step(card.runId)).retried, "a declined card is not a sign-in wall");
});

// ---------------------------------------------------------------- 7. the redesign (card and store sign-in handoff, 10-30)
const visible = (html) => html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "").replaceAll("&#39;", "'").replaceAll("&amp;", "&");

test("a code asked again after a code was answered reads as 'that code didn't match'", async () => {
  const { runId, token } = await signinLink();
  await shop.answerLink(token, { requestId: "req_signin_1", answers: { email: EMAIL, password: { protectedInputId: "pi_1" } } });
  runs[runId].requiredAction = OTP("req_otp_1");
  await shop.step(runId);
  const first = shop.linkView(shop.linkFor(token));
  assert.equal(first.state, "code", "a first code after the password is a plain code ask");
  assert.equal(first.answered, true);
  assert.ok((await shop.answerLink(token, { requestId: "req_otp_1", answers: { code: { protectedInputId: "pi_code_1" } } })).ok);
  runs[runId].requiredAction = OTP("req_otp_2");
  await shop.step(runId);
  assert.equal(shop.linkView(shop.linkFor(token)).state, "wrongcode");
  const page = visible((await connectRequest({ sub: token, method: "GET" })).body);
  assert.match(page, /That code didn't match\./);
  assert.match(page, /aria-invalid|class="pf-fld err"/, "the code line is drawn in its error state");
  assert.match(page, /that's not it\. check for a newer text or email\?/);
  assert.ok((await shop.answerLink(token, { requestId: "req_otp_2", answers: { code: { protectedInputId: "pi_code_2" } } })).ok, "and it can be answered");
});

test("a connected store that asks to sign in again: texted as 'signed me out', the page says so first", async () => {
  shop.markConnected(OMARI, "target");
  const out = await shop.startCheckout({ conversationId: OMARI, store: "target", startUrl: "https://www.target.com/p/1", what: "Buy one cable.", item: "a USB-C cable", maxUsd: 15 });
  assert.equal(out.plan, "signed");
  runs[out.runId].status = "awaiting_input";
  runs[out.runId].requiredAction = SIGNIN("req_again_1");
  await shop.step(out.runId);
  assert.match(said.at(-1).t, /^Target signed me out\./);
  const token = said.at(-1).t.split("/").pop();
  const view = shop.linkView(shop.linkFor(token));
  assert.equal(view.state, "signin");
  assert.equal(view.again, true);
  const page = visible((await connectRequest({ sub: token, method: "GET" })).body);
  assert.match(page, /Target signed me out\./);
  assert.match(page, /a USB-C cable/);
  assert.match(page, /data-step="signin"[^>]*inert/, "the form is one step away, still mounted");
});

test("no Crossmint, no store logo, no email in any screen, in Settings or in the texted link", async () => {
  const { renderView } = await import("../src/pages/webconnect.js");
  const { renderSettings } = await import("../src/pages/websettings.js");
  const fields = SIGNIN("r").request.interaction.fields;
  const rq = { requestId: "r", question: "", fields };
  const views = [
    ...["signin", "retry", "checking", "connected", "failed", "expired"].map((state) => ({ state, store: "target", kind: "signin", request: rq })),
    { state: "signin", store: "target", kind: "signin", request: rq, again: true, item: "a cable" },
    { state: "code", store: "walmart", kind: "signin", request: { requestId: "r", question: "", fields: OTP("r").request.interaction.fields } },
    { state: "wrongcode", store: "bestbuy", kind: "signin", request: { requestId: "r", question: "", fields: OTP("r").request.interaction.fields } },
    { state: "card", kind: "card" }, { state: "connected", kind: "card" }, { state: "expired", kind: "card" }, { state: "expired" },
  ];
  const shopping = { stores: [{ store: "target", name: "Target", connectedAt: clock.now() }], card: { brand: "visa", last4: "4242" }, lastUsed: { store: "Target", at: clock.now() } };
  const pages = [
    ...views.flatMap((v) => [renderView(v).html, renderView(v, { staging: true, card: { brand: "visa", last4: "4242" } }).html]),
    renderSettings({ csrf: "x", shopping }), renderSettings({ csrf: "x", shopping, confirmCard: true }), renderSettings({ csrf: "x", shopping: { stores: [], card: null } }),
  ];
  for (const html of pages) {
    const seen = visible(html);
    assert.doesNotMatch(seen, /crossmint/i, "Crossmint is never named on a page");
    assert.doesNotMatch(seen, /<img\b/, "no store icon");
    assert.doesNotMatch(seen, /#cc0000|#0071ce|#0046be|#ffc220|#fff200/i, "no store colours");
    assert.doesNotMatch(seen, /signed in as|@example\.com/i, "never their email");
    assert.doesNotMatch(seen, /guest/i, "no guest option");
    assert.doesNotMatch(seen, /text me when|i'll text you when it's done|deletes it|saved address/i);
  }
  await signinLink();
  assert.doesNotMatch(said.at(-1).t, /crossmint/i);
  assert.match(said.at(-1).t, /Your password goes straight to Target, not to me\./);
});

test("SEALED sits only over sealed fields, never over the email we draw ourselves", async () => {
  const { token } = await signinLink();
  const page = visible((await connectRequest({ sub: token, method: "GET" })).body);
  const email = /<div class="pf-fld[^"]*"><label class="pf-l" for="f-email">([^<]*)<\/label><input[^>]*>/.exec(page);
  assert.ok(email, "the email field is ours, a real label + input");
  assert.doesNotMatch(email[0], /SEALED/);
  assert.match(email[0], /autocomplete="email"/);
  assert.match(page, /id="f-password-l">PASSWORD<span class="pf-seal">/, "the password's label says SEALED");
});

test("Settings: the card's last use comes from this person's own paid payments; forgetting it asks first", async () => {
  const { settingsView, renderSettings } = await import("../src/pages/websettings.js");
  db.db.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
  const ins = db.db.prepare("INSERT INTO shop_payments (conversation_id, run_id, request_id, amount, currency, amount_kind, merchant_name, status, created_at, answered_at) VALUES (?, 'run_x', ?, '9.79', 'USD', 'exact', ?, ?, ?, ?)");
  const oct28 = Date.parse("2026-10-28T18:00:00Z"), oct29 = Date.parse("2026-10-29T18:00:00Z");
  assert.equal(shop.lastPaid(OMARI), null);
  ins.run(OMARI, "rq_paid", "Target", "paid", oct28, oct28);
  ins.run(OMARI, "rq_declined", "Walmart", "declined", oct29, oct29);
  ins.run(AMA, "rq_other", "Best Buy", "paid", oct29, oct29);
  assert.deepEqual(shop.lastPaid(OMARI), { store: "Target", at: oct28 }, "only a paid one, only theirs");
  const view = settingsView({ conversation_id: OMARI }, "tok");
  const page = visible(renderSettings({ csrf: "x", ...view }));
  assert.match(page, /LAST USED<\/span><p class="shp-u">Target · Oct 28</);
  assert.match(page, /VISA •••• 4242/);
  assert.match(page, /href="\/web\/settings\?confirm=card#shopping">Forget it</, "Forget it is a link to the confirm, not a removal");
  assert.doesNotMatch(page, /name="do" value="card-remove"/, "nothing removes the card from the first screen");
  const confirm = visible(renderSettings({ csrf: "x", ...view, confirmCard: true }));
  assert.match(confirm, /Forget this card\?/);
  assert.match(confirm, /name="do" value="card-remove"[\s\S]*Forget it<\/button>/);
  assert.match(confirm, /KEEP IT/);
  assert.match(page, /Signing out of your last store erases every saved sign-in\./);
  assert.match(page, /Your account on the store doesn't change\./);
});

test("a code field of our own is six cells that submit as one answer; a sealed one stays Crossmint's slot", async () => {
  const { renderView } = await import("../src/pages/webconnect.js");
  const std = [{ key: "code", label: "Code", required: true, handling: "standard", input: { kind: "text", autoComplete: "one-time-code", inputMode: "numeric" } }];
  const page = visible(renderView({ state: "code", store: "target", kind: "signin", request: { requestId: "r", question: "", fields: std } }).html);
  assert.equal((page.match(/aria-label="Digit \d of 6"/g) ?? []).length, 6);
  assert.match(page, /<input type="hidden" name="code" value="">/, "one named input carries the code");
  assert.equal((page.match(/autocomplete="one-time-code"/g) ?? []).length, 1, "the first cell takes the phone's autofill");
  const sealedPage = visible(renderView({ state: "code", store: "target", kind: "signin", request: { requestId: "r", question: "", fields: OTP("r").request.interaction.fields } }).html);
  assert.match(sealedPage, /data-protected="code"/);
  assert.doesNotMatch(sealedPage, /Digit 1 of 6|name="code"/, "a sealed code is never an input of ours");
});

test("a store's field key never escapes an attribute: ids and aria-describedby are escaped", async () => {
  const { renderView } = await import("../src/pages/webconnect.js");
  const bad = 'a"><img src=x onerror=alert(1)>';
  const fields = [
    { key: bad, label: "Code", required: true, handling: "standard", input: { kind: "text", autoComplete: "one-time-code", inputMode: "numeric" } },
    { key: bad + "2", label: "Name", required: true, handling: "standard", input: { kind: "text" } },
  ];
  for (const state of ["code", "wrongcode", "signin"]) {
    const html = renderView({ state, store: "target", kind: "signin", request: { requestId: "r", question: "", fields } }).html;
    assert.doesNotMatch(html, /<img src=x/, `${state}: the key stays inside its attribute`);
  }
});
