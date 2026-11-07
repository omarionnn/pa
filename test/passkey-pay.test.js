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
/** Refusals queued for the next order-intent calls (a test pushes { status, body }); empty means 201. */
let refuseIntents = [];
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: p, body });
  if (p === "/api/unstable/order-intents") { const no = refuseIntents.shift(); return no ? reply(no.status, no.body) : reply(201, { orderIntentId: `oi_${calls.length}` }); }
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return reply(202, { ok: true });
  if (/order-intent-registration$/.test(p) && init.method === "PUT") return body?.email ? reply(200, { status: "active" }) : reply(400, { error: { code: "CONSUMER_EMAIL_REQUIRED" } });
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
  calls = []; refuseIntents = []; said.length = 0; clock.reset();
  for (const t of ["shop_runs", "shop_cards", "shop_payments", "pay_passkeys", "pay_passkey_regs", "pay_approvals", "pay_approval_log"]) db.db.exec(`DELETE FROM ${t}`);
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_secret_123', 'visa', '4242', 0, 1)").run(OMARI);
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

test("the setup page needs a Reason Web sign-in; signed out it is a plain 404", async () => {
  assert.equal(await passkeySetupRequest({ account: null }), null);
  assert.equal(await passkeySetupRequest({ verb: "verify", method: "POST", headers: SAME, account: null, readBody: async () => "{}" }), null);
  // A token nobody was sent: the plain 404 too, for the page and both POSTs.
  assert.equal(await approveRequest({ sub: "not-a-real-token" }), null);
  assert.equal(await approveRequest({ sub: "not-a-real-token/decline", method: "POST", headers: SAME }), null);
  assert.equal(await approveRequest({ sub: "not-a-real-token/verify", method: "POST", headers: SAME, readBody: async () => "{}" }), null);
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
  // Without the timestamps: a ms clock reading …4242… matched once (2026-10-31, at:1793470994242).
  assert.doesNotMatch(JSON.stringify(log.map(({ at, ...l }) => l)), /pm_secret|4242|visa/i);
});

// ---------------------------------------------------------------- 6. the payment fails to start (2026-10-31 at CVS)
test("a refused order intent does not use up the link: Face ID worked, the page says the payment didn't start, the next tap pays", async () => {
  const a = await setUp();
  const row = asked("26.65");
  const token = await linkFor(row);
  const o1 = optionsOf((await page(token)).body);
  // Crossmint refuses the order intent: nothing could have been charged.
  refuseIntents.push({ status: 400, body: { error: { code: "payment_method_declined", message: "declined" } } });
  const first = await page(token, "verify", a.get(o1.challenge));
  assert.equal(first.status, 400);
  const out = JSON.parse(first.body);
  assert.equal(out.error, "order_intent_failed");
  assert.equal(out.retry, true, "the page is told the same link can be tapped again");
  assert.equal(shop.paymentRow(row.id).status, "asked");
  assert.equal(orderIntents().length, 1);
  assert.equal(answers().length, 0, "Crossmint was never told to pay");
  // Why it failed is on record (status + Crossmint's code), never a card detail.
  const log = passkey.approvalLog(OMARI);
  assert.ok(log.some((l) => l.event === "pay_failed" && /order_intent_failed 400 payment_method_declined/.test(l.detail)), JSON.stringify(log));
  assert.ok(log.some((l) => l.event === "link_reopened"));
  assert.doesNotMatch(JSON.stringify(log), /pm_secret|4242|visa/i);
  // The same link opens again — not "Already approved" — under a fresh challenge.
  const again = await page(token);
  assert.equal(again.status, 200, again.body);
  assert.match(again.body, /Pay \$26\.65 at Best Buy\?/);
  assert.doesNotMatch(again.body, /Already approved/);
  const o2 = optionsOf(again.body);
  assert.notEqual(o2.challenge, o1.challenge, "the first assertion cannot be replayed");
  assert.match((await page(token, "verify", a.get(o1.challenge))).body, /not_verified/);
  assert.equal(shop.paymentRow(row.id).status, "asked");
  // Second tap: paid, exactly one more order intent.
  const second = await page(token, "verify", a.get(o2.challenge));
  assert.equal(second.status, 200, second.body);
  assert.equal(orderIntents().length, 2);
  assert.equal(answers().length, 1);
  assert.equal(shop.paymentRow(row.id).status, "paid");
  assert.match(said.at(-1).t, /Approved with Face ID\. Paid \$26\.65 at Best Buy/);
  // And now it really is used up.
  assert.match((await page(token, "verify", a.get(o2.challenge))).body, /link_used/);
  assert.match((await page(token)).body, /Already approved/);
});

test("the page has a clear result for every outcome: payment didn't start, run out, Face ID refused; never 'didn't go through' when it did", async () => {
  await setUp();
  const row = asked("26.65");
  const token = await linkFor(row);
  const html = (await page(token)).body;
  // A screen for the payment not starting, with a retry — not the Face ID failure line.
  assert.match(html, /data-step="failed"/);
  assert.match(html, /Face ID worked\. The payment didn(?:&#39;|')t start\./);
  assert.match(html, /id="pk-retry"/);
  // Only a reopened link (retry) shows the failed screen; a link that stayed used reloads to Already approved.
  assert.match(html, /if\(out\.retry\)return show\('failed'\)/);
  assert.doesNotMatch(html, /e==='order_intent_failed'/);
  assert.match(html, /Couldn't reach Reason\. Nothing was charged/);
  // Run out: the page says so and says to ask for a fresh one.
  clock.skip(passkey.APPROVAL_TTL_MS + 1000);
  const gone = await page(token);
  assert.equal(gone.status, 410);
  assert.match(gone.body, /This link has run out\./);
  assert.match(gone.body, /tell me and I(?:&#39;|')ll send a fresh one/);
});

test("a counter that stays at 0 (iPhone passkeys) is accepted, twice; www. and the apex origin both verify", async () => {
  const a = await setUp();
  for (const value of ["5.00", "6.00"]) {
    const row = asked(value);
    const token = await linkFor(row);
    const o = optionsOf((await page(token)).body);
    const res = await page(token, "verify", a.get(o.challenge, { counter: 0 }));
    assert.equal(res.status, 200, res.body);
    assert.equal(shop.paymentRow(row.id).status, "paid");
  }
  assert.equal(q("SELECT counter FROM pay_passkeys WHERE id = ?").get(a.id).counter, 0);
  const row = asked("7.00");
  const token = await linkFor(row);
  const o = optionsOf((await page(token)).body);
  assert.deepEqual(passkey.ORIGINS(), ["https://heyreason.com", "https://www.heyreason.com"]);
  const www = await page(token, "verify", a.get(o.challenge, { origin: "https://www.heyreason.com" }));
  assert.equal(www.status, 200, www.body);
  assert.equal(orderIntents().length, 3);
});

test("once the card may have reached the store (unknown outcome) the link stays used: never paid twice", async () => {
  const a = await setUp();
  const row = asked("9.79");
  const token = await linkFor(row);
  const o = optionsOf((await page(token)).body);
  shop._setFetch(async (url, init) => { const p = new URL(url).pathname; if (p.endsWith("/messages")) throw new Error("timeout"); return fakeFetch(url, init); });
  try {
    const res = await page(token, "verify", a.get(o.challenge));
    assert.equal(res.status, 400);
    assert.match(res.body, /unknown_outcome/);
    assert.equal(shop.paymentRow(row.id).status, "unknown");
    // Counted against the day's cap as if it went through, and on record for the owner, the same as the
    // texted-yes path (security lead 5, 2026-11-07).
    const unk = db.listSpend(OMARI, (await import("../src/trust.js")).spendDay()).filter((l) => /\(OUTCOME UNKNOWN\)$/.test(l.what));
    assert.deepEqual(unk.map((l) => l.cents), [979]);
    const open = db.listUnknownOutcomes(OMARI).filter((u) => u.action === "shop_pay");
    assert.equal(open.length, 1);
    assert.equal(open[0].target, (await import("../src/trust.js")).normalizeTarget(shop.payTarget(shop.paymentRow(row.id))));
    assert.match((await page(token)).body, /Already approved/);
    assert.equal(passkey.approvalLog(OMARI).filter((l) => l.event === "link_reopened").length, 0);
  } finally { shop._setFetch(fakeFetch); }
});

test("shop_status after the link was used up without paying: a fresh link to resend, an open link named, a passed window said", async () => {
  const a = await setUp();
  const row = asked("26.65");
  q("UPDATE shop_runs SET stage = 'needs_approval', stage_at = ?, created_at = ?, updated_at = ? WHERE run_id = 'run_1'").run(clock.now(), clock.now(), clock.now());
  const token = await linkFor(row);
  // The link is still open: named, not remade.
  let view = shop.statusView(OMARI);
  assert.match(view.runs[0].approval, /still works for \d+ more minutes/);
  assert.equal(view.runs[0].approve_url, undefined);
  // Used up by a tap whose payment did not start... then run out before another tap (the link's half
  // hour is longer than Crossmint's usual hold since 2026-11-07, so this store's hold is longer still).
  q("UPDATE shop_payments SET expires_at = ? WHERE id = ?").run(new Date(clock.now() + 2 * passkey.APPROVAL_TTL_MS).toISOString(), row.id);
  clock.skip(passkey.APPROVAL_TTL_MS + 1000);
  view = shop.statusView(OMARI);
  assert.match(view.runs[0].approval, /used up without paying or ran out/);
  assert.match(view.runs[0].approve_url, /\/web\/approve\/[A-Za-z0-9_-]{20,}$/);
  const fresh = tokenOf(view.runs[0].approve_url);
  assert.notEqual(fresh, token);
  assert.equal((await page(fresh)).status, 200);
  const o = optionsOf((await page(fresh)).body);
  assert.equal((await page(fresh, "verify", a.get(o.challenge))).status, 200);
  assert.equal(shop.paymentRow(row.id).status, "paid");
  // Crossmint's own window passed: nothing to resend, start again.
  const row2 = asked("1.00");
  q("UPDATE shop_runs SET stage = 'needs_approval' WHERE run_id = 'run_1'").run();
  q("UPDATE shop_payments SET expires_at = ? WHERE id = ?").run(new Date(clock.now() - 1000).toISOString(), row2.id);
  view = shop.statusView(OMARI);
  assert.match(view.runs[0].approval, /payment window has passed/);
  assert.equal(view.runs[0].approve_url, undefined);
});

test("an expired checkout is described in plain words from the form's fields, never by quoting the store's prompt", () => {
  const prompt = "I'm at Ulta's guest checkout with the 16 oz cleanser in the cart. I need the shipping details.";
  const rq = { kind: "form", question: prompt, fields: [{ key: "email", label: "Email address" }, { key: "phone", label: "Phone" }, { key: "address1", label: "Street address" }, { key: "zip", label: "ZIP code" }] };
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES ('run_u', ?, 'ulta', 'guest', 'a 16 oz CeraVe cleanser', 'awaiting_input', 0, 0)").run(OMARI);
  q("UPDATE shop_runs SET stage = 'failed', stage_at = ?, result = 'input_expired', question = ?, request_json = ? WHERE run_id = 'run_u'").run(clock.now(), prompt, JSON.stringify(rq));
  const run = q("SELECT * FROM shop_runs WHERE run_id = 'run_u'").get();
  assert.equal(shop.askedFor(run), "your email, phone number and shipping address");
  const line = shop.stageLine(run);
  assert.match(line, /was waiting for your email, phone number and shipping address and it expired/);
  assert.doesNotMatch(line, /guest checkout|I'm at/);
  // Waiting on the payment: approval, in those words.
  q("UPDATE shop_runs SET stage = 'needs_approval' WHERE run_id = 'run_u'").run();
  assert.equal(shop.askedFor(q("SELECT * FROM shop_runs WHERE run_id = 'run_u'").get()), "your approval of the payment");
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

test("the card has no registration and no email is known: Face ID works, the payment does not start, they are texted once what to send, the link reopens; the email registers the card and the next tap pays", async () => {
  const shipping = await import("../src/shipping.js");
  db.db.exec("DELETE FROM shop_shipping");
  q("UPDATE shop_cards SET registered = NULL WHERE conversation_id = ?").run(OMARI);
  const a = await setUp();
  said.length = 0;
  const row = asked("26.65");
  const token = await linkFor(row);
  const o1 = optionsOf((await page(token)).body);
  const first = await page(token, "verify", a.get(o1.challenge));
  assert.equal(first.status, 400);
  const out = JSON.parse(first.body);
  assert.equal(out.error, "order_intent_failed");
  assert.equal(out.retry, true, "the link can be tapped again once the email is in");
  assert.equal(orderIntents().length, 0, "no order intent without a registration");
  assert.equal(shop.paymentRow(row.id).status, "asked");
  assert.deepEqual(said.map((s) => s.t), ["Face ID worked, but card ••••4242 can't pay yet until I have an email for its receipts. Which one should I use? Tell me here, then tap the link again."]);
  assert.ok(passkey.approvalLog(OMARI).some((l) => l.event === "pay_failed" && /CONSUMER_EMAIL_REQUIRED/.test(l.detail)));
  // A second tap before the email: the same text is not sent again.
  const o2 = optionsOf((await page(token)).body);
  assert.equal(JSON.parse((await page(token, "verify", a.get(o2.challenge))).body).error, "order_intent_failed");
  assert.equal(said.length, 1);
  // They send the email; the card is registered with it; the next tap pays once.
  const set = await shop.setReceiptEmail(OMARI, "omari.receipts@example.com");
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(shipping.profileRow(OMARI).email, "omari.receipts@example.com");
  const reg = calls.find((c) => c.method === "PUT" && /order-intent-registration$/.test(c.path));
  assert.equal(reg?.body?.email, "omari.receipts@example.com");
  const o3 = optionsOf((await page(token)).body);
  const paid = JSON.parse((await page(token, "verify", a.get(o3.challenge))).body);
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(orderIntents().length, 1);
  assert.equal(shop.paymentRow(row.id).status, "paid");
  assert.doesNotMatch(JSON.stringify(passkey.approvalLog(OMARI)), /example\.com/);
});
