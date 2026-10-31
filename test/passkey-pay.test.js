// Purchase approval by passkey (src/passkey.js, src/pages/webapprove.js, src/shopconnect.js), against a
// software authenticator that signs exactly what a phone's would (P-256, the same authenticator data
// and client data), and a fake Crossmint. What these hold:
//   1. Setting up needs Face ID / PIN (UV) and heyreason.com; a later passkey waits a day, and they hear.
//   2. With a passkey, a texted yes never pays: the ask and shop_pay hand out the Face ID link.
//   3. Pay only after a verified assertion, for the row's exact amount, once.
//   4. Wrong amount, a reused link, an expired link, a wrong origin, no UV, a counter going back, an
//      assertion made for another payment: all refused, and nothing is paid.
//   5. Decline needs no passkey and pays nothing. Every outcome is logged, with no card detail.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, createSign, randomBytes } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const dir = mkdtempSync(join(tmpdir(), "reason-passkey-"));
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
const { runTool } = await import("../src/tools.js");
const { approveRequest, passkeySetupRequest } = await import("../src/pages/webapprove.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const ORIGIN = "https://heyreason.com";
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const q = (sql) => db.db.prepare(sql);
const sha = (b) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------- a software authenticator
class Authenticator {
  constructor({ rpId = "heyreason.com" } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.key = privateKey;
    this.rawId = randomBytes(16);
    this.id = this.rawId.toString("base64url");
    this.cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
    this.counter = 0;
    this.rpId = rpId;
  }
  authData({ uv = true, attested = false, counter = this.counter } = {}) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const parts = [sha(this.rpId), Buffer.from([0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0)]), c];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length); parts.push(Buffer.alloc(16), len, this.rawId, this.cose); }
    return Buffer.concat(parts);
  }
  create(options, { origin = ORIGIN, uv = true } = {}) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ uv, attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
  }
  get(challenge, { origin = ORIGIN, uv = true, counter } = {}) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData({ uv, counter });
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
  return reply(404, {});
}
const said = [];
let nextReq = 1;
/** An asked payment at Best Buy, as Crossmint would send it, recorded the way step() records it. */
function asked(value = "9.79") {
  const requestId = `req_${nextReq++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES ('run_1', ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(OMARI);
  return shop.recordPayment({ conversationId: OMARI, runId: "run_1", item: "USB-C cable", request: {
    requestId, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
  } });
}
const tokenOf = (url) => url.split("/web/approve/")[1];
const orderIntents = () => calls.filter((c) => c.path === "/api/unstable/order-intents");
const answers = () => calls.filter((c) => c.path.endsWith("/messages"));
const page = (token, verb = "", body = undefined, headers = SAME) => approveRequest({ sub: verb ? `${token}/${verb}` : token, method: verb ? "POST" : "GET", headers, readBody: async () => (body === undefined ? "" : JSON.stringify(body)) });
const optionsOf = (html) => JSON.parse(/var B=(\{.*?\});\n/s.exec(html)[1]).options;
async function setUp(auth = new Authenticator()) {
  const o = await passkey.registrationOptions(OMARI);
  const out = await passkey.register(OMARI, auth.create(o.options));
  assert.equal(out.ok, true, JSON.stringify(out));
  return auth;
}
async function linkFor(row) {
  const out = await runTool("shop_pay", { payment_id: row.id }, { conversationId: OMARI });
  assert.equal(out.approve_with_face_id, true, JSON.stringify(out));
  return tokenOf(out.url);
}

before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }) }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; said.length = 0; clock.reset();
  for (const t of ["shop_runs", "shop_cards", "shop_payments", "pay_passkeys", "pay_passkey_regs", "pay_approvals", "pay_approval_log"]) db.db.exec(`DELETE FROM ${t}`);
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_secret_123', 'visa', '4242', 0)").run(OMARI);
});

// ---------------------------------------------------------------- 1. setting it up
test("setting up: UV and heyreason.com required; the first works at once, a later one waits a day and they hear", async () => {
  const a = new Authenticator();
  let o = await passkey.registrationOptions(OMARI);
  assert.equal(o.options.authenticatorSelection.userVerification, "required");
  assert.equal(o.options.rp.id, "heyreason.com");
  assert.equal((await passkey.register(OMARI, a.create(o.options, { uv: false }))).ok, false, "presence alone is not enough");
  o = await passkey.registrationOptions(OMARI);
  assert.equal((await passkey.register(OMARI, a.create(o.options, { origin: "https://heyreason.co" }))).ok, false, "a lookalike origin");
  o = await passkey.registrationOptions(OMARI);
  assert.equal((await passkey.register(OMARI, a.create(o.options))).ok, true);
  assert.equal((await passkey.register(OMARI, a.create(o.options))).error, "expired", "a registration challenge is single use");
  assert.equal(passkey.requiredFor(OMARI), true);
  assert.match(said.at(-1).t, /Face ID now approves your purchases/);
  const out = await setUp(new Authenticator());
  assert.ok(out);
  const keys = passkey.passkeysOf(OMARI);
  assert.equal(keys.length, 2);
  assert.ok(keys[1].usableAt >= clock.now() + passkey.COOL_MS - 1000, "the second waits a day");
  assert.match(said.at(-1).t, /new Face ID was just set up/);
});

test("the setup page needs a Reason Web sign-in", async () => {
  const out = await passkeySetupRequest({ account: null });
  assert.equal(out.status, 401);
  const post = await passkeySetupRequest({ verb: "verify", method: "POST", headers: SAME, account: null, readBody: async () => "{}" });
  assert.equal(post.status, 401);
  const acct = { conversation_id: OMARI };
  const got = await passkeySetupRequest({ account: acct });
  assert.equal(got.status, 200);
  assert.match(got.body, /Set up Face ID/);
});

// ---------------------------------------------------------------- 2. a texted yes doesn't pay
test("with a passkey, a texted yes doesn't pay: shop_pay and payApproved hand out the link, no order intent", async () => {
  await setUp();
  const row = asked();
  const out = await runTool("shop_pay", { payment_id: row.id, confirmation_id: 1 }, { conversationId: OMARI });
  assert.equal(out.ok, false);
  assert.match(out.url, /^https:\/\/heyreason\.com\/web\/approve\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: row.id, confirmationId: 1 })).error, "approve_with_passkey");
  assert.equal(orderIntents().length, 0);
  assert.equal(shop.paymentRow(row.id).status, "asked");
  // The ask itself carries the link.
  assert.match(shop.passkeyAsk(row), /^OK to pay \$9\.79 at Best Buy for USB-C cable\? Approve it with Face ID here:\nhttps:\/\/heyreason\.com\/web\/approve\//);
});

// ---------------------------------------------------------------- 3. pay after a verified assertion
test("approve: the page shows the exact total, the assertion pays that amount once, the link is used up", async () => {
  const a = await setUp();
  const row = asked("12.49");
  const token = await linkFor(row);
  const got = await page(token);
  assert.equal(got.status, 200);
  assert.match(got.body, /Pay \$12\.49 at Best Buy\?/);
  assert.match(got.body, /Approve with Face ID/);
  assert.match(got.body, /USB-C cable/);
  const o = optionsOf(got.body);
  assert.equal(o.userVerification, "required");
  assert.equal(o.rpId, "heyreason.com");
  assert.deepEqual(o.allowCredentials.map((c) => c.id), [a.id]);
  const res = await page(token, "verify", a.get(o.challenge));
  assert.equal(res.status, 200, res.body);
  assert.equal(orderIntents().length, 1);
  assert.deepEqual(orderIntents()[0].body.amount, { value: "12.49", currency: "USD" });
  assert.equal(orderIntents()[0].body.merchant.name, "Best Buy");
  assert.equal(answers()[0].body.parts[0].requestId, row.request_id);
  assert.equal(shop.paymentRow(row.id).status, "paid");
  assert.match(said.at(-1).t, /Approved with Face ID\. Paid \$12\.49 at Best Buy/);
  // 4. The same link again, the same assertion again: refused, nothing more paid.
  const again = await page(token, "verify", a.get(o.challenge, { counter: 0 }));
  assert.equal(again.status, 400);
  assert.equal(orderIntents().length, 1);
  const shown = await page(token);
  assert.match(shown.body, /Already approved/);
});

// ---------------------------------------------------------------- 4. refusals
test("refused: wrong amount (row changed), expired link, wrong origin, no UV, another payment's assertion", async () => {
  const a = await setUp();
  const row = asked("9.79");
  let token = await linkFor(row);
  let o = optionsOf((await page(token)).body);
  // Wrong amount: the row now says something else than the link was made for.
  q("UPDATE shop_payments SET amount = '99.79' WHERE id = ?").run(row.id);
  assert.match((await page(token, "verify", a.get(o.challenge))).body, /details_changed/);
  q("UPDATE shop_payments SET amount = '9.79' WHERE id = ?").run(row.id);
  // Wrong origin, and a passkey that only showed presence.
  token = await linkFor(row);
  o = optionsOf((await page(token)).body);
  assert.match((await page(token, "verify", a.get(o.challenge, { origin: "https://heyreason.co" }))).body, /not_verified/);
  assert.match((await page(token, "verify", a.get(o.challenge, { uv: false }))).body, /no_user_verification|not_verified/);
  // An assertion signed for another payment's link.
  const other = asked("1.00");
  const otherToken = await linkFor(other);
  const otherO = optionsOf((await page(otherToken)).body);
  assert.match((await page(token, "verify", a.get(otherO.challenge))).body, /not_verified/);
  // Expired: five minutes on.
  clock.skip(passkey.APPROVAL_TTL_MS + 1000);
  assert.match((await page(token, "verify", a.get(o.challenge))).body, /link_expired/);
  assert.equal((await page(token)).status, 410);
  assert.equal(orderIntents().length, 0, "nothing was ever paid");
  assert.equal(shop.paymentRow(row.id).status, "asked");
  // A post from somewhere else is refused before anything is looked at.
  const cross = await page(otherToken, "verify", a.get(otherO.challenge), { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  assert.equal(orderIntents().length, 0);
});

test("refused: an older link once a fresh one is out, a counter going backwards, a passkey still waiting", async () => {
  const a = await setUp();
  const row = asked();
  const first = await linkFor(row);
  const o1 = optionsOf((await page(first)).body);
  const second = await linkFor(row);
  assert.match((await page(first, "verify", a.get(o1.challenge))).body, /link_replaced/);
  // A counter that went up, then came back down.
  const o2 = optionsOf((await page(second)).body);
  q("UPDATE pay_passkeys SET counter = 7 WHERE id = ?").run(a.id);
  assert.match((await page(second, "verify", a.get(o2.challenge, { counter: 3 }))).body, /counter|not_verified/);
  // A second passkey, still in its day of waiting.
  const b = await setUp(new Authenticator());
  assert.match((await page(second, "verify", b.get(o2.challenge))).body, /cooling_off/);
  assert.equal(orderIntents().length, 0);
});

// ---------------------------------------------------------------- 5. decline, and the log
test("decline from the page: Crossmint told no, nothing paid; the log has events and no card detail", async () => {
  const a = await setUp();
  const row = asked();
  const token = await linkFor(row);
  const res = await page(token, "decline");
  assert.equal(res.status, 200);
  assert.equal(answers()[0].body.parts[0].action, "decline");
  assert.equal(shop.paymentRow(row.id).status, "declined");
  const o = optionsOf((await linkFor(asked()).then(page)).body);
  assert.ok(o);
  assert.match((await page(token, "verify", a.get(o.challenge))).body, /link_declined/);
  assert.equal(orderIntents().length, 0);
  const log = passkey.approvalLog(OMARI);
  assert.ok(log.some((l) => l.event === "declined" && l.amount === "9.79 USD" && l.merchant === "Best Buy"));
  assert.ok(log.some((l) => l.event === "rejected"));
  assert.doesNotMatch(JSON.stringify(log), /pm_secret|4242|visa/i);
});

test("without a passkey, or with the flag off, nothing changes: the texted yes path stands", async () => {
  const row = asked();
  assert.equal(passkey.requiredFor(OMARI), false);
  assert.doesNotMatch(shop.paymentAsk(row), /approve/i);
  await setUp();
  process.env.REASON_PASSKEY_PAY = "off";
  try {
    assert.equal(passkey.requiredFor(OMARI), false);
    assert.equal(shop.approvalView("x".repeat(32)), null);
  } finally { process.env.REASON_PASSKEY_PAY = "owner"; }
  // Somebody else's conversation never gets it while the flag says owner.
  assert.equal(passkey.passkeyAllowedFor("dm:fake:+13475550000"), false);
});
