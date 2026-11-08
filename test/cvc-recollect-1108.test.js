// The card's CVC after Face ID, and a ledger that counts only money that can still be drawn (2026-11-08).
//
// Live, that day: the owner approved Amazon $14.83 (run 650f8c4c) with Face ID; the order intent was made
// and handed to the checkout, the row marked paid and $14.83 counted, while Crossmint read the intent's
// encrypted-card rail as pending_cvc_recollection (spent 0.00, reserved 0.00). The checkout could not fill
// the card, asked again, and every new link hit the same wall. What these hold:
//   1. cardRail reads Crossmint's rails the way its docs say (ready / cvc / blocked / unlisted).
//   2. Face ID on a card whose CVC lapsed: nothing reaches the checkout, nothing is counted, the row stays
//      asked, and the page gets what Crossmint's own CVC field needs (client key, the person's JWT, the
//      card's id) — only in the answer to a verified assertion, never in the page, never in a log.
//   3. The page's /cvc after Crossmint's field said complete: the SAME intent is read again and, once its
//      card rail is ready, paid once; still pending, it stays open; no Face ID behind it, it pays nothing.
//   4. The texted-yes path is told in words and never gets the card's id; an unreadable intent pays nothing.
//   5. A paid row whose checkout ended without placing and whose intent drew nothing (closed, or past its
//      expiry) stops counting, the way an unknown one does (releasedLineOf). Anything less stays counted.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, createSign, randomBytes } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const dir = mkdtempSync(join(tmpdir(), "reason-cvc-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_PASSKEY_PAY = "owner";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_MAX_SPEND_PER_DAY = "100";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const passkey = await import("../src/passkey.js");
const { runTool } = await import("../src/tools.js");
const { approveRequest, APPROVE_HEADERS } = await import("../src/pages/webapprove.js");
const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:+15550001111";
const ORIGIN = "https://heyreason.com";
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const q = (sql) => db.db.prepare(sql);
const sha = (b) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------- a software authenticator (as in passkey-pay.test.js)
class Authenticator {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.key = privateKey;
    this.rawId = randomBytes(16);
    this.id = this.rawId.toString("base64url");
    this.cose = Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])));
  }
  authData({ attested = false } = {}) {
    const parts = [sha("heyreason.com"), Buffer.from([0x01 | 0x04 | (attested ? 0x40 : 0)]), Buffer.alloc(4)];
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length); parts.push(Buffer.alloc(16), len, this.rawId, this.cose); }
    return Buffer.concat(parts);
  }
  create(options) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
  }
  get(challenge) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }));
    const authenticatorData = this.authData();
    const sig = createSign("SHA256").update(Buffer.concat([authenticatorData, sha(clientDataJSON)])).sign(this.key);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: sig.toString("base64url") }, clientExtensionResults: {} };
  }
}

// ---------------------------------------------------------------- a fake Crossmint
// The live intent's shape (11-08 21:13 UTC), rails as Crossmint listed them. `cvcDone` is what
// Crossmint's field changes: once the code is typed, the encrypted-card rail reads active.
let calls, cvcDone, railMode, intentAnswer;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
const liveRails = () => [
  { rail: "agentic-token", provider: "agentpay", status: "pending_verification", credentialFormats: ["card", "network-token"] },
  { rail: "spt", provider: "stripe", status: "active", credentialFormats: ["identifier"] },
  { rail: "encrypted-card", status: cvcDone ? "active" : "pending_cvc_recollection", credentialFormats: ["card"] },
];
const intents = new Map();
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: p, body, auth: init.headers?.Authorization ?? "" });
  if (p === "/api/unstable/order-intents" && method === "POST") {
    const id = `oi_${calls.length}`;
    intents.set(id, { pm: body.paymentMethodId, amount: body.amount, expiresAt: body.expiresAt });
    return reply(201, { orderIntentId: id });
  }
  const oi = /^\/api\/unstable\/order-intents\/([^/]+)$/.exec(p);
  if (oi) {
    const id = decodeURIComponent(oi[1]);
    if (intentAnswer) return intentAnswer(id);
    const it = intents.get(id);
    if (!it) return reply(404, {});
    return reply(200, {
      orderIntentId: id, paymentMethodId: it.pm, status: "active", description: "x", expiresAt: it.expiresAt,
      amount: { total: it.amount.value, spent: "0.00", reserved: "0.00", available: it.amount.value, currency: it.amount.currency },
      rails: railMode === "live" ? liveRails() : railMode === "error" ? [{ rail: "encrypted-card", status: "error", error: { code: "CARD_DECLINED" } }] : [],
      verificationConfig: { environment: "production", publicApiKey: "pk", allowanceId: "al" },
    });
  }
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return reply(202, { ok: true });
  if (/order-intent-registration$/.test(p)) return reply(200, { status: "active" });
  return reply(404, {});
}
const said = [], logged = [];
let nextReq = 1;
function asked(value = "14.83", { conversationId = OMARI, runId = "run_amz" } = {}) {
  const requestId = `req_${nextReq++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES (?, ?, 'amazon', 'guest', 'CeraVe PM lotion', 'awaiting_input', 0, 0)").run(runId, conversationId);
  return shop.recordPayment({ conversationId, runId, item: "CeraVe PM lotion", request: {
    requestId, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Amazon.com", url: "https://www.amazon.com", countryCode: "US" } } },
  } });
}
const creates = () => calls.filter((c) => c.path === "/api/unstable/order-intents");
const answers = () => calls.filter((c) => c.path.endsWith("/messages"));
const spentToday = (c = OMARI) => trust.checkSpendCap(c, 1).spent_today;
const lines = (c = OMARI) => q("SELECT cents, what FROM spend WHERE conversation_id = ? ORDER BY id").all(c);
const page = (token, verb = "", body = undefined) => approveRequest({ sub: verb ? `${token}/${verb}` : token, method: verb ? "POST" : "GET", headers: SAME, readBody: async () => (body === undefined ? "" : JSON.stringify(body)) });
const optionsOf = (html) => JSON.parse(/var B=(\{.*?\});\n/s.exec(html)[1]).options;
async function setUp() {
  const a = new Authenticator();
  const o = await passkey.registrationOptions(OMARI);
  assert.equal((await passkey.register(OMARI, a.create(o.options))).ok, true);
  return a;
}
async function linkFor(row) {
  const out = await runTool("shop_pay", { payment_id: row.id }, { conversationId: OMARI });
  return out.url.split("/web/approve/")[1];
}
/** Face ID on the page for this link, as the phone would: the page's options, then /verify. */
async function faceId(a, token) {
  const got = await page(token);
  assert.equal(got.status, 200, got.body);
  const res = await page(token, "verify", a.get(optionsOf(got.body).challenge));
  return { res, out: JSON.parse(res.body) };
}

before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }), log: (e) => logged.push(e) }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; cvcDone = false; railMode = "live"; intentAnswer = null; intents.clear(); said.length = 0; logged.length = 0; clock.reset();
  for (const t of ["shop_runs", "shop_cards", "shop_payments", "pay_passkeys", "pay_passkey_regs", "pay_approvals", "pay_approval_log", "spend"]) db.db.exec(`DELETE FROM ${t}`);
  for (const c of [OMARI, AMA]) q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_secret_1929', 'mastercard', '1929', 0, 1)").run(c);
});

// ---------------------------------------------------------------- 1. reading the rails
test("cardRail: Crossmint's rails read the way its docs say", () => {
  cvcDone = false;
  assert.equal(shop.cardRail({ rails: liveRails() }), "cvc", "the live 11-08 intent: only spt active, which can't give a card");
  cvcDone = true;
  assert.equal(shop.cardRail({ rails: liveRails() }), "ready");
  assert.equal(shop.cardRail({ rails: [{ rail: "agentic-token", status: "active", credentialFormats: ["card", "network-token"] }, { rail: "encrypted-card", status: "pending_cvc_recollection" }] }), "ready", "the network rail ready pays");
  assert.equal(shop.cardRail({ rails: [{ rail: "spt", status: "active" }, { rail: "encrypted-card", status: "pending_cvc_recollection" }] }), "cvc", "formats left out: spt is no card rail");
  assert.equal(shop.cardRail({ rails: [{ rail: "encrypted-card", status: "active" }] }), "ready", "formats left out: encrypted-card by name");
  assert.equal(shop.cardRail({ rails: [{ rail: "encrypted-card", status: "error", error: { code: "X" } }] }), "blocked");
  assert.equal(shop.cardRail({ rails: [{ rail: "agentic-token", status: "pending_verification" }] }), "unlisted", "no encrypted card listed: Crossmint says send it anyway");
  assert.equal(shop.cardRail({}), "unlisted");
});

// ---------------------------------------------------------------- 2 + 3. Face ID, then the CVC, then paid once
test("Face ID on a lapsed CVC: nothing paid or counted, the page gets Crossmint's field; /cvc pays the same intent once", async () => {
  const a = await setUp();
  const row = asked("14.83");
  const token = await linkFor(row);
  said.length = 0;
  const { res, out } = await faceId(a, token);
  assert.equal(res.status, 400);
  assert.equal(out.needs_cvc, true);
  assert.equal(out.ok, false);
  assert.equal(out.cvc.apiKey, "ck_test_client");
  assert.equal(out.cvc.paymentMethodId, "pm_secret_1929");
  const claims = JSON.parse(Buffer.from(out.cvc.jwt.split(".")[1], "base64url"));
  assert.equal(claims.sub, shop.crossmintUser(OMARI), "the person's own JWT");
  assert.ok(claims.exp - claims.iat <= 600, "ten minutes at most");
  // Nothing reached the checkout, nothing counted, the row is still open, the link open again.
  assert.equal(creates().length, 1);
  assert.equal(answers().length, 0, "the checkout never got the intent");
  const r = shop.paymentRow(row.id);
  assert.equal(r.status, "asked");
  assert.equal(r.order_intent_id, "oi_1");
  assert.equal(spentToday(), 0, "no spend line while the card can't pay");
  assert.equal(lines().length, 0);
  assert.equal(passkey.openApprovalFor(row.id)?.state, "open");
  assert.equal(said.length, 0, "no text: the page carries on");

  // /cvc before Crossmint has the code: still needs it, nothing paid, the link still open.
  let fin = JSON.parse((await page(token, "cvc")).body);
  assert.equal(fin.needs_cvc, true);
  assert.equal(fin.cvc, undefined, "no second JWT without Face ID");
  assert.equal(answers().length, 0);
  assert.equal(shop.paymentRow(row.id).status, "asked");

  // Crossmint's field said complete: the same intent, now ready, is handed over, once.
  cvcDone = true;
  const done = await page(token, "cvc");
  assert.equal(done.status, 200, done.body);
  assert.equal(JSON.parse(done.body).ok, true);
  assert.equal(creates().length, 1, "the same intent: no second order intent");
  assert.equal(answers().length, 1);
  assert.equal(answers()[0].body.parts[0].response.orderIntentId, "oi_1");
  assert.equal(shop.paymentRow(row.id).status, "paid");
  assert.equal(spentToday(), 1483);
  assert.match(said.at(-1).t, /Approved with Face ID\. Paid \$14\.83 at Amazon\.com/);
  // Again: the link is used up, nothing more.
  const again = JSON.parse((await page(token, "cvc")).body);
  assert.equal(again.ok, false);
  assert.equal(answers().length, 1);
  assert.equal(spentToday(), 1483);
  // The log has the steps and no card id, no JWT, no key.
  const log = passkey.approvalLog(OMARI).map((l) => l.event);
  assert.ok(log.includes("needs_cvc") && log.includes("cvc_entered") && log.includes("paid"), log.join(","));
  assert.doesNotMatch(JSON.stringify([passkey.approvalLog(OMARI), logged]), /pm_secret|1929|ck_test|eyJ/);
});

test("/cvc with no Face ID behind it, after its ten minutes, or for a changed payment pays nothing", async () => {
  const a = await setUp();
  const row = asked("14.83");
  const token = await linkFor(row);
  cvcDone = true;
  // Never through Face ID: no window.
  assert.equal(JSON.parse((await page(token, "cvc")).body).error, "cvc_window_closed");
  assert.equal(creates().length, 0);
  cvcDone = false;
  await faceId(a, token);
  cvcDone = true;
  clock.skip(shop.CVC_MS + 1000);
  assert.equal(JSON.parse((await page(token, "cvc")).body).error, "cvc_window_closed");
  assert.equal(answers().length, 0);
  // A row that changed since Face ID (another amount): refused.
  clock.reset();
  const row2 = asked("20.00", { runId: "run_b" });
  const t2 = await linkFor(row2);
  cvcDone = false;
  await faceId(a, t2);
  q("UPDATE shop_payments SET amount = '99.00' WHERE id = ?").run(row2.id);
  cvcDone = true;
  assert.equal(JSON.parse((await page(t2, "cvc")).body).error, "details_changed");
  assert.equal(answers().length, 0);
  assert.equal(spentToday(), 0);
});

test("the page closed during the CVC: the next Face ID reuses the same intent and asks for the code again", async () => {
  const a = await setUp();
  const row = asked("14.83");
  const token = await linkFor(row);
  await faceId(a, token);
  const { out } = await faceId(a, token);
  assert.equal(out.needs_cvc, true);
  assert.ok(out.cvc?.jwt);
  assert.equal(creates().length, 1, "the intent made the first time is reused");
  assert.equal(answers().length, 0);
});

test("the page: the CVC step in plain words, Crossmint allowed in, and no JWT or card id in the HTML", async () => {
  await setUp();
  const row = asked("14.83");
  const token = await linkFor(row);
  const got = await page(token);
  assert.match(got.body, /Enter your card&#39;s 3-digit code to finish\.|Enter your card's 3-digit code to finish\./);
  assert.match(got.body, /Finish paying \$14\.83/);
  assert.doesNotMatch(got.body, /pm_secret|ck_test|eyJ/);
  const words = got.body.replace(/<script>[\s\S]*?<\/script>/g, " ").replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
  assert.match(words, /3 digits on the back of the card/);
  assert.doesNotMatch(words, /CVC|rail|order intent|Crossmint|JWT/i, "no jargon on the page");
  const csp = APPROVE_HEADERS["Content-Security-Policy"];
  assert.match(csp, /frame-src https:\/\/www\.crossmint\.com https:\/\/\*\.crossmint\.com/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // The page's own script parses.
  const js = [...got.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.doesNotThrow(() => new Function(js));
});

// ---------------------------------------------------------------- 4. the other paths
test("the texted yes (no Face ID set up): told in words, never the card's id; nothing paid or counted", async () => {
  const row = asked("14.83", { conversationId: AMA, runId: "run_ama" });
  const out = await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.error, "needs_cvc");
  assert.match(out.say, /3-digit security code/);
  assert.equal(out.paymentMethodId, undefined);
  assert.equal(answers().length, 0);
  assert.equal(shop.paymentRow(row.id).status, "asked");
  assert.equal(spentToday(AMA), 0);
});

test("an intent that can't be read, or whose card rail is in error, pays nothing and counts nothing", async () => {
  intentAnswer = () => reply(500, { message: "down" });
  let row = asked("14.83", { conversationId: AMA, runId: "run_x" });
  let out = await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 3 });
  assert.equal(out.error, "order_intent_failed");
  assert.equal(out.detail, "intent_unreadable");
  assert.equal(answers().length, 0);
  assert.equal(shop.paymentRow(row.id).status, "asked");
  intentAnswer = null; railMode = "error";
  row = asked("14.83", { conversationId: AMA, runId: "run_y" });
  out = await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 4 });
  assert.equal(out.detail, "card_rail_unavailable");
  assert.equal(answers().length, 0);
  assert.equal(spentToday(AMA), 0);
  // No rails listed at all (a card with no network rail): sent, as Crossmint's docs say.
  railMode = "none";
  row = asked("14.83", { conversationId: AMA, runId: "run_z" });
  out = await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 5 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(spentToday(AMA), 1483);
});

// ---------------------------------------------------------------- 5. the ledger
/** Row 3 as it was live: paid, counted, its checkout then failed; the intent active past its expiry, nothing drawn. */
function paidRow({ runStatus = "failed", stage = "failed", spent = "0.00", expired = true, railAtPay = "", railNow = "cvc" } = {}) {
  const row = asked("14.83", { runId: `run_${nextReq}` });
  const id = `oi_live_${row.id}`;
  q("UPDATE shop_payments SET status = 'paid', order_intent_id = ?, answered_at = ?, rail_at_pay = ? WHERE id = ?").run(id, clock.now(), railAtPay, row.id);
  cvcDone = railNow !== "cvc";
  q("INSERT INTO spend (conversation_id, day, cents, what, site, confirmation_id, at) VALUES (?, ?, 1483, ?, 'Amazon.com', NULL, ?)").run(OMARI, trust.spendDay(), shop.spendLineOf({ ...shop.paymentRow(row.id) }), clock.now());
  q("UPDATE shop_runs SET status = ?, stage = ? WHERE run_id = ?").run(runStatus, stage, row.run_id);
  intentAnswer = (oid) => reply(200, { orderIntentId: oid, status: "active", paymentMethodId: "pm_secret_1929", expiresAt: new Date(clock.now() + (expired ? -60_000 : 10 * 60_000)).toISOString(),
    amount: { total: "14.83", spent, reserved: "0.00", available: "14.83", currency: "USD" }, rails: liveRails() });
  return shop.paymentRow(row.id);
}

test("a paid $14.83 whose checkout failed and whose intent drew nothing stops counting, once, the line kept as a $0 note", async () => {
  const row = paidRow();
  assert.equal(spentToday(), 1483);
  assert.equal(await shop.settleUnknownPayments(), 1);
  assert.equal(spentToday(), 0);
  assert.deepEqual(lines().map((l) => ({ ...l })), [{ cents: 0, what: shop.releasedLineOf(row) }]);
  assert.match(lines()[0].what, /^Amazon\.com: CeraVe PM lotion \(\$14\.83\) \(CROSSMINT CONFIRMED NOT CHARGED, not counted\)$/);
  assert.equal(shop.paymentRow(row.id).status, "failed");
  assert.equal(await shop.settleUnknownPayments(), 0, "once");
  assert.equal(await shop.backfillSpend(), 0, "the boot backfill doesn't count it again");
  assert.equal(spentToday(), 0);
});

for (const [why, opts] of [
  ["the checkout still running", { runStatus: "running", stage: "paid" }],
  ["the order placed", { runStatus: "succeeded", stage: "placed" }],
  ["money drawn on the intent", { spent: "14.83" }],
  ["the intent not yet past its expiry", { expired: false }],
  // Review 11-08: once a ready rail handed the card over, a store charge may not show on the intent.
  ["the card rail read ready when the checkout got it (paid since the fix)", { railAtPay: "ready" }],
  ["the card rail ready now (the card could have been minted)", { railNow: "ready" }],
]) {
  test(`a paid row stays counted with ${why}`, async () => {
    const row = paidRow(opts);
    assert.equal(await shop.settleUnknownPayments(), 0);
    assert.equal(spentToday(), 1483);
    assert.equal(shop.paymentRow(row.id).status, "paid");
  });
}

test("the CVC step finishes only on the link Face ID was on, and the day's cap is asked before the link is claimed", async () => {
  const a = await setUp();
  const row = asked("14.83");
  const token = await linkFor(row);
  await faceId(a, token);
  // A fresh link for the same payment (a resend) can't ride the first link's Face ID.
  const fresh = await linkFor(shop.paymentRow(row.id));
  cvcDone = true;
  assert.equal(JSON.parse((await page(fresh, "cvc")).body).error, "cvc_window_closed");
  assert.equal(answers().length, 0);
  // Back on a Face ID'd link: spending elsewhere crossed the $100 day meanwhile → refused, link still open.
  const t2 = fresh;
  cvcDone = false;
  await faceId(a, t2);
  q("INSERT INTO spend (conversation_id, day, cents, what, site, confirmation_id, at) VALUES (?, ?, 9000, 'Elsewhere: thing ($90.00)', 'Elsewhere', NULL, ?)").run(OMARI, trust.spendDay(), clock.now());
  cvcDone = true;
  const capped = JSON.parse((await page(t2, "cvc")).body);
  assert.equal(capped.error, "over_daily_cap");
  assert.equal(answers().length, 0);
  assert.equal(passkey.openApprovalFor(row.id)?.state, "open", "the link stays open");
});
