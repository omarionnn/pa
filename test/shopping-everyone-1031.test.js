// Shopping for everyone (2026-10-31, owner's go at 15:59 ET): REASON_SHOP_CONNECT, REASON_CHOICE_CARDS and
// REASON_PASSKEY_PAY all `on`. What a NON-owner conversation gets, pinned: the Crossmint tools and no
// AgentCard buying, a connect link whose JWT is theirs alone, a shipping record of their own, the Face ID
// ask (first passkey at once, a later one after the cooling-off), and the install's daily spend cap asked
// BEFORE a payment — on the texted-yes path and on the Face ID path — which until now only AgentCard's
// purchase_confirm and browser_submit asked (src/shopconnect.js payRow). Plus the store-icon fetch pinned
// to the addresses it checked (DNS rebinding).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, createSign, randomBytes } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const dir = mkdtempSync(join(tmpdir(), "reason-shopall-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_CHOICE_CARDS = "on";
process.env.REASON_PASSKEY_PAY = "on";
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_MAX_SPEND_PER_DAY = "20";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const passkey = await import("../src/passkey.js");
const shipping = await import("../src/shipping.js");
const trust = await import("../src/trust.js");
const { choiceCardsOn } = await import("../src/choicecards.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { connectRequest } = await import("../src/pages/webconnect.js");
const { approveRequest } = await import("../src/pages/webapprove.js");
const db = await import("../src/db.js");
const accounts = await import("../src/accounts.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
// Ama is an account of her own, let in the way the live install lets testers in (src/accounts.js admit).
db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
assert.equal(accounts.admit({ channel: "fake", address: "+13475550000", name: "Ama" }).allow, true);
assert.equal(accounts.conversationIdFor({ channel: "fake", address: "+13475550000" }), AMA);
const ORIGIN = "https://heyreason.com";
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const q = (sql) => db.db.prepare(sql);
const sha = (b) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------- a software authenticator (as test/passkey-pay.test.js)
class Authenticator {
  constructor({ rpId = "heyreason.com" } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.key = privateKey; this.rawId = randomBytes(16); this.id = this.rawId.toString("base64url");
    this.cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
    this.counter = 0; this.rpId = rpId;
  }
  authData({ uv = true, attested = false, counter = this.counter } = {}) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const parts = [sha(this.rpId), Buffer.from([0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0)]), c];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length); parts.push(Buffer.alloc(16), len, this.rawId, this.cose); }
    return Buffer.concat(parts);
  }
  create(options) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, authenticatorAttachment: "platform", clientExtensionResults: {} };
  }
  get(challenge) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }));
    const authenticatorData = this.authData({ counter: ++this.counter });
    const sig = createSign("SHA256").update(Buffer.concat([authenticatorData, sha(clientDataJSON)])).sign(this.key);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: sig.toString("base64url") }, clientExtensionResults: {} };
  }
}

// ---------------------------------------------------------------- a fake Crossmint
let calls;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: p, body });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}` });
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return reply(202, { ok: true });
  if (/order-intent-registration$/.test(p)) return reply(200, { status: "active" });
  return reply(404, {});
}
const said = [];
let nextReq = 1;
function asked(c, value = "9.79") {
  const requestId = `req_${nextReq++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES (?, ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(`run_${c}`, c);
  return shop.recordPayment({ conversationId: c, runId: `run_${c}`, item: "USB-C cable", request: {
    requestId, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
  } });
}
const orderIntents = () => calls.filter((c) => c.path === "/api/unstable/order-intents");
const page = (token, verb = "", body = undefined) => approveRequest({ sub: verb ? `${token}/${verb}` : token, method: verb ? "POST" : "GET", headers: SAME, readBody: async () => (body === undefined ? "" : JSON.stringify(body)) });
const optionsOf = (html) => JSON.parse(/var B=(\{.*?\});\n/s.exec(html)[1]).options;
async function setUp(c, auth = new Authenticator()) {
  const o = await passkey.registrationOptions(c);
  const out = await passkey.register(c, auth.create(o.options));
  assert.equal(out.ok, true, JSON.stringify(out));
  return { auth, out };
}
const bootOf = (html) => JSON.parse(/var B=(\{.*?\});/s.exec(html)[1]);
const jwtSub = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub;

before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }) }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; said.length = 0; clock.reset();
  for (const t of ["shop_runs", "shop_cards", "shop_payments", "shop_links", "shop_shipping", "shop_sites", "pay_passkeys", "pay_passkey_regs", "pay_approvals", "pay_approval_log", "spend"]) db.db.exec(`DELETE FROM ${t}`);
  for (const c of [OMARI, AMA]) q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, ?, 'visa', '4242', 0, 1)").run(c, `pm_${c}`);
});

// ---------------------------------------------------------------- 1. the tools, for everyone
test("on: a non-owner gets the Crossmint tools and choice cards, and none of AgentCard's buying", async () => {
  for (const c of [AMA, OMARI]) {
    const names = new Set(toolsFor(c).map((t) => t.name));
    for (const t of ["store_checkout", "shop_pay", "shop_decline", "shop_card", "shop_status", "shop_answer", "show_choices"]) assert.ok(names.has(t), `${c} sees ${t}`);
    for (const t of ["purchase", "purchase_confirm", "vault_enroll", "purchase_track", "purchases_recent", "flight_book"]) assert.ok(!names.has(t), `${c} never sees ${t}`);
    assert.equal(shop.connectAllowedFor(c), true);
    assert.equal(passkey.passkeyAllowedFor(c), true);
    assert.equal(choiceCardsOn(c), true);
  }
  // AgentCard's tools are refused outright, not just hidden.
  const refused = await runTool("purchases_recent", {}, { conversationId: AMA });
  assert.equal(refused.ok, false);
  assert.equal(refused.blocked, "not_available");
  assert.match(String(refused.error), /store_checkout/);
  // Ama is an account of her own, not the operator.
  assert.equal(accounts.ownerOf(AMA).isOperator, false);
  assert.equal(accounts.ownerOf(OMARI).isOperator, true);
  // shop_card hands a non-owner their own link.
  const card = await runTool("shop_card", { send_link: true }, { conversationId: AMA });
  assert.equal(card.ok, true);
  assert.match(card.url, /^https:\/\/heyreason\.com\/web\/connect\/[A-Za-z0-9_-]{20,}$/);
});

// ---------------------------------------------------------------- 2. the connect link is theirs
test("a non-owner's connect link opens, and its JWT names them — never the owner", async () => {
  const token = shop.cardLink(AMA);
  const got = await connectRequest({ sub: token, method: "GET" });
  assert.equal(got.status, 200, got.body?.slice?.(0, 200));
  const boot = bootOf(got.body);
  assert.equal(boot.apiKey, "ck_test_client");
  assert.equal(jwtSub(boot.jwt), jwtSub(shop.mintJwt(AMA)));
  assert.notEqual(jwtSub(boot.jwt), jwtSub(shop.mintJwt(OMARI)));
});

// ---------------------------------------------------------------- 3. a shipping record of their own
test("a non-owner's shipping record is kept for them and is not the owner's", () => {
  const row = shipping.learn(AMA, { first_name: "Ama", last_name: "Mensah", address1: "12 Elm St", city: "Bronx", state: "NY", zip: "10469", email: "ama@example.com" }, { source: "test" });
  assert.equal(row.first_name, "Ama");
  assert.equal(shipping.profileFor(AMA)?.zip, "10469");
  assert.equal(shipping.profileFor(OMARI)?.zip ?? "", "");
  assert.deepEqual(shipping.knownEmails(AMA), ["ama@example.com"]);
});

// ---------------------------------------------------------------- 4. Face ID for a non-owner
test("a non-owner's first passkey works at once, a later one cools off 24h, and with one saved a texted yes never pays", async () => {
  const first = await setUp(AMA);
  assert.equal(first.out.coolingUntil, null, "the first passkey pays at once");
  assert.equal(passkey.requiredFor(AMA), true);
  const second = await setUp(AMA);
  assert.ok(Math.abs(second.out.coolingUntil - (clock.now() + passkey.COOL_MS)) < 5000, "a later passkey waits a day");
  assert.equal(passkey.passkeysOf(AMA).length, 2);
  const row = asked(AMA);
  const out = await runTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: AMA });
  assert.equal(out.approve_with_face_id, true, JSON.stringify(out));
  assert.match(out.url, /^https:\/\/heyreason\.com\/web\/approve\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 1 })).error, "approve_with_passkey");
  assert.equal(orderIntents().length, 0);
  // The approve page lists only the usable passkey (the second is cooling), and Face ID pays.
  const token = out.url.split("/web/approve/")[1];
  const got = await page(token);
  assert.equal(got.status, 200);
  const o = optionsOf(got.body);
  assert.deepEqual(o.allowCredentials.map((c) => c.id), [first.auth.id]);
  const res = await page(token, "verify", first.auth.get(o.challenge));
  assert.equal(res.status, 200, res.body);
  assert.equal(orderIntents().length, 1);
  assert.deepEqual(orderIntents()[0].body.amount, { value: "9.79", currency: "USD" });
  assert.equal(shop.paymentRow(row.id).status, "paid");
  assert.equal(trust.spendToday(AMA).spent_cents, 979, "a Face ID payment counts against their day");
  assert.equal(trust.spendToday(OMARI).spent_cents, 0);
});

// ---------------------------------------------------------------- 5. the daily cap, asked before paying
test("over the install's daily cap: a texted yes does not pay, nothing reaches Crossmint, the row stays asked", async () => {
  const big = asked(AMA, "25.00");
  const out = await shop.payApproved({ conversationId: AMA, paymentId: big.id, confirmationId: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.error, "over_daily_cap");
  assert.equal(out.cap, 2000);
  assert.equal(out.spent_today, 0);
  assert.match(out.say, /\$25\.00 and the day's limit is \$20\.00/);
  assert.equal(orderIntents().length, 0);
  assert.equal(shop.paymentRow(big.id).status, "asked");
  // Under it: paid and counted; the next one that would cross the line is refused with what is left.
  const ok = await shop.payApproved({ conversationId: AMA, paymentId: asked(AMA, "9.79").id, confirmationId: 2 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(trust.spendToday(AMA).spent_cents, 979);
  const next = await shop.payApproved({ conversationId: AMA, paymentId: asked(AMA, "12.00").id, confirmationId: 3 });
  assert.equal(next.error, "over_daily_cap");
  assert.equal(next.left, 1021);
  assert.equal(orderIntents().length, 1);
  assert.match(next.say, /\$9\.79 is already committed/);
  // Somebody else's day is their own.
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: asked(OMARI, "19.00").id, confirmationId: 5 })).ok, true);
});

test("over the daily cap with Face ID: the assertion verifies, the payment is refused, the page and a text say so", async () => {
  const { auth } = await setUp(AMA);
  const row = asked(AMA, "25.00");
  const out = await runTool("shop_pay", { payment_id: row.id }, { conversationId: AMA });
  const token = out.url.split("/web/approve/")[1];
  const first = await page(token);
  const o = optionsOf(first.body);
  // The page's own words for it, ready before the tap.
  assert.match(first.body, /over_daily_cap:"Face ID worked, but this is past the day's spending limit here/);
  said.length = 0;
  const res = await page(token, "verify", auth.get(o.challenge));
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, "over_daily_cap");
  assert.equal(orderIntents().length, 0);
  assert.equal(shop.paymentRow(row.id).status, "asked");
  assert.equal(said.length, 1);
  assert.equal(said[0].c, AMA);
  assert.match(said[0].t, /past the day's spending limit here \(\$0\.00 of \$20\.00 already spent today\)\. Nothing was charged/);
  assert.equal(q("SELECT event FROM pay_approval_log WHERE payment_id = ? ORDER BY id DESC LIMIT 1").get(row.id)?.event, "pay_failed");
});

// ---------------------------------------------------------------- 6. the icon fetch connects to the addresses it checked
test("the store icon is fetched at the addresses the check resolved — every hop pinned, never resolved twice", async () => {
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(120, 7)]);
  const seen = [];
  const site = async (url, init) => {
    seen.push({ url, addresses: init.addresses });
    const u = new URL(url);
    const res = (status, type, body, location) => ({ status, ok: status < 300, url, headers: { get: (h) => (h === "content-type" ? type : h === "location" ? location : null) }, arrayBuffer: async () => body });
    if (u.hostname === "pinstore.com") return res(302, "", "", "https://cdn.pinstore.com/favicon.ico");
    if (u.hostname === "cdn.pinstore.com" && u.pathname === "/favicon.ico") return res(200, "image/png", PNG);
    return res(404, "text/html", Buffer.from("nope"));
  };
  const dns = { "pinstore.com": [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }], "cdn.pinstore.com": [{ address: "151.101.1.69", family: 4 }] };
  let lookups = 0;
  try {
    shop.noteStore({ store: "pinstore", url: "https://pinstore.com/" });
    shop._setIconFetch(site, async (h) => { lookups++; return dns[h] ?? []; });
    assert.match(await shop.ensureIcon("pinstore"), /^data:image\/png;base64,/);
    const hops = seen.map((s) => [new URL(s.url).hostname, s.addresses?.map((a) => a.address)]);
    assert.deepEqual(hops[0], ["pinstore.com", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]]);
    assert.deepEqual(hops[hops.length - 1], ["cdn.pinstore.com", ["151.101.1.69"]]);
    assert.ok(seen.every((s) => s.addresses?.length > 0), "every request carries the addresses it was checked against");
    assert.equal(lookups, seen.length, "every request is resolved once, right before it, and connects to that answer");
  } finally { shop._setIconFetch(null); }
  // The pin answers dns.lookup's two shapes from the checked list, whatever the name resolves to now.
  const lookup = shop._pinnedLookup([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
  await new Promise((r) => lookup("pinstore.com", { all: true }, (err, list) => { assert.equal(err, null); assert.deepEqual(list, [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]); r(); }));
  await new Promise((r) => lookup("pinstore.com", {}, (err, address, family) => { assert.equal(err, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4); r(); }));
  await new Promise((r) => lookup("pinstore.com", (err, address) => { assert.equal(address, "93.184.216.34"); r(); }));
  // A store named by a bare address (public or loopback) is not a store name at all (hostOf): no DNS, no request.
  const seen2 = [];
  try {
    shop._setIconFetch(async (url, init) => { seen2.push(init.addresses); return { status: 404, ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) }; }, async () => { throw new Error("never"); });
    for (const [key, url] of [["literal", "https://93.184.216.34/"], ["loopback", "https://127.0.0.1/"], ["meta", "https://169.254.169.254/"]]) {
      shop.noteStore({ store: key, url });
      assert.equal(await shop.ensureIcon(key), "", key);
    }
    assert.equal(seen2.length, 0);
  } finally { shop._setIconFetch(null); }
});
