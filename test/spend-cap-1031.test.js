// The daily spending limit, per person (2026-10-31, owner's decision 16:35 ET): the install's default
// (REASON_MAX_SPEND_PER_DAY, $100 on live) holds for everybody who has not set their own; a person's own
// number (src/spendcap.js daily_caps) overrides it. Lowering is immediate. Raising above the default is a
// money control: Face ID on the payment-style link when they have a passkey, else a plain yes that
// expires like any ask about money. Nobody sets more than $1,000 a day for themselves. A payment that
// does not fit says the limit, where it would take them, and how to change it — never words to type.
// shop_status / spend_today / caps_show read the real figures. Settings → Shopping round-trips the field.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, createSign, randomBytes } from "node:crypto";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const dir = mkdtempSync(join(tmpdir(), "reason-spendcap-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_CHOICE_CARDS = "on";
process.env.REASON_PASSKEY_PAY = "on";
process.env.REASON_WEB = "on";
process.env.REASON_SITE_URL = "https://heyreason.com";
process.env.REASON_MAX_SPEND_PER_DAY = "100";
process.env.REASON_ASK_TTL_MONEY_H = "24";
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const spendcap = await import("../src/spendcap.js");
const shop = await import("../src/shopconnect.js");
const passkey = await import("../src/passkey.js");
const trust = await import("../src/trust.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { approveRequest } = await import("../src/pages/webapprove.js");
const st = await import("../src/pages/websettings.js");
const db = await import("../src/db.js");
const accounts = await import("../src/accounts.js");
const { clock, config } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
db.upsertAccount({ conversationId: OMARI, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
assert.equal(accounts.ownerOf(AMA).isOperator, false);
const ORIGIN = "https://heyreason.com";
const SAME = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
const q = (sql) => db.db.prepare(sql);
const sha = (b) => createHash("sha256").update(b).digest();
const HOUR = 3600_000;

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
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: clientDataJSON.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"), signature: sig.toString("base64url"), userHandle: null }, authenticatorAttachment: "platform", clientExtensionResults: {} };
  }
}
async function setUp(c, auth = new Authenticator()) {
  const o = await passkey.registrationOptions(c);
  const out = await passkey.register(c, auth.create(o.options));
  assert.equal(out.ok, true, JSON.stringify(out));
  return auth;
}

// ---------------------------------------------------------------- a fake Crossmint, and payments asked of a person
let calls;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname;
  calls.push({ method: init.method ?? "GET", path: p, body: init.body ? JSON.parse(init.body) : undefined });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}` });
  // The rails read after the intent is made (2026-11-08): a card rail that is ready.
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return reply(202, { ok: true });
  if (/order-intent-registration$/.test(p)) return reply(200, { status: "active" });
  return reply(404, {});
}
const orderIntents = () => calls.filter((c) => c.path === "/api/unstable/order-intents");
const said = [];
let nextReq = 1;
function asked(c, value) {
  const requestId = `req_${nextReq++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES (?, ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(`run_${c}`, c);
  return shop.recordPayment({ conversationId: c, runId: `run_${c}`, item: "USB-C cable", request: {
    requestId, request: { question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
      interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } },
  } });
}
const page = (token, verb = "", body = undefined) => approveRequest({ sub: verb ? `${token}/${verb}` : token, method: verb ? "POST" : "GET", headers: SAME, readBody: async () => (body === undefined ? "" : JSON.stringify(body)) });
const optionsOf = (html) => JSON.parse(/var B=(\{.*?\});\n/s.exec(html)[1]).options;
const tokenOf = (url) => url.split("/web/approve/")[1];
const spend = (c, cents) => trust.noteSpend({ conversationId: c, cents, what: "test", site: "bestbuy" });
/** Words the person might be told to type: a quoted imperative, or a "say/text/reply ..." instruction. */
const QUOTED_PHRASE = /["“'](raise|set|change|make)[^"”']*["”']|\b(say|text|reply|type)\b[^.]*["“]/i;

// ---------------------------------------------------------------- Settings (src/pages/websettings.js), signed in as one person
let n = 0;
function browser(conv) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conv}`, token, { conversationId: conv });
  return { token, conv, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const account = (conv) => db.getAccount(conv);
const settingsGet = (b, query = {}) => st.settingsRequest({ account: account(b.conv), method: "GET", query, headers: { cookie: b.cookie, host: "heyreason.com", origin: ORIGIN, "sec-fetch-site": "same-origin" }, readBody: async () => "" });
const settingsPost = (b, fields) => st.settingsRequest({ account: account(b.conv), method: "POST", headers: { cookie: b.cookie, host: "heyreason.com", origin: ORIGIN, "sec-fetch-site": "same-origin" }, readBody: async () => new URLSearchParams({ c: b.csrf, ...fields }).toString() });
const fieldValue = (html) => /id="cap-f"[^>]*value="([^"]*)"/.exec(html)?.[1];

before(() => { shop._setFetch(fakeFetch); shop.attach({ say: (c, t) => said.push({ c, t }) }); });
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; said.length = 0; clock.reset();
  for (const t of ["shop_runs", "shop_cards", "shop_payments", "shop_links", "pay_passkeys", "pay_passkey_regs", "pay_approvals", "pay_approval_log", "spend", "daily_caps", "cap_changes", "page_sessions"]) db.db.exec(`DELETE FROM ${t}`);
  for (const c of [OMARI, AMA]) q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, ?, 'visa', '4242', 0, 1)").run(c, `pm_${c}`);
});

// ---------------------------------------------------------------- 1. the default, for a non-owner
test("the default ($100 from the env) applies to a non-owner who set nothing, and a payment over it says the limit, where it would take them, and how to change it", async () => {
  assert.equal(config.maxSpendPerDay, 100);
  assert.deepEqual({ cents: spendcap.capFor(AMA).cents, own: spendcap.capFor(AMA).own }, { cents: 10000, own: false });
  spend(AMA, 1800);
  const cap = trust.checkSpendCap(AMA, 10000);
  assert.equal(cap.ok, false);
  assert.equal(cap.blocked, "over_daily_cap");
  assert.equal(cap.say, "Your daily limit is $100 and this would take you to $118. You can raise it in Settings → Shopping, or tell me a new limit.");
  assert.doesNotMatch(cap.say, QUOTED_PHRASE);
  assert.doesNotMatch(cap.error, /REASON_MAX_SPEND_PER_DAY/);
  // The texted-yes path hands the same line back as what to say; nothing reaches Crossmint.
  const row = asked(AMA, "100.00");
  const out = await shop.payApproved({ conversationId: AMA, paymentId: row.id, confirmationId: 1 });
  assert.equal(out.error, "over_daily_cap");
  assert.equal(out.say, cap.say);
  assert.equal(orderIntents().length, 0);
  // Under it pays, and the record moves.
  const ok = await shop.payApproved({ conversationId: AMA, paymentId: asked(AMA, "20.00").id, confirmationId: 2 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(spendcap.view(AMA).spent_cents, 3800);
  assert.equal(spendcap.view(AMA).left, "$62");
});

test("the Face ID path over the limit: one text with the limit and how to change it, the page says the same, no phrase to type anywhere", async () => {
  const auth = await setUp(AMA);
  said.length = 0; // setting up a passkey texts them; not what this test counts
  spend(AMA, 9000);
  const row = asked(AMA, "25.00");
  const out = await runTool("shop_pay", { payment_id: row.id }, { conversationId: AMA });
  const token = tokenOf(out.url);
  const first = await page(token);
  assert.match(first.body, /over_daily_cap:"This is past your daily spending limit\. Nothing was charged\. You can raise it in Settings → Shopping, or text me a new limit\."/);
  const res = await page(token, "verify", auth.get(optionsOf(first.body).challenge));
  assert.equal(JSON.parse(res.body).error, "over_daily_cap");
  assert.equal(said.length, 1);
  assert.equal(said[0].t, "$25.00 at Best Buy wasn't paid. Your daily limit is $100 and this would take you to $115. You can raise it in Settings → Shopping, or tell me a new limit. Nothing was charged.");
  assert.doesNotMatch(said[0].t, QUOTED_PHRASE);
  assert.equal(orderIntents().length, 0);
  assert.equal(passkey.approvalFor(token)?.state, "open");
});

// ---------------------------------------------------------------- 2. their own number
test("a person's own cap overrides the default for them alone; lowering is immediate; the tool says it back", async () => {
  for (const c of [AMA, OMARI]) assert.ok(toolsFor(c).some((t) => t.name === "spend_limit_set") && toolsFor(c).some((t) => t.name === "spend_limit_confirm"), `${c} sees the tools`);
  const out = await runTool("spend_limit_set", { daily: 50, text: "set my daily cap to 50" }, { conversationId: AMA });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.applied, true);
  assert.deepEqual([out.from, out.to], ["$100", "$50"]);
  assert.match(out.say, /now \$50 a day/);
  assert.equal(spendcap.ownCap(AMA).said, "set my daily cap to 50");
  assert.deepEqual({ cents: spendcap.capFor(AMA).cents, own: spendcap.capFor(AMA).own }, { cents: 5000, own: true });
  assert.equal(spendcap.capFor(OMARI).cents, 10000, "somebody else's number is untouched");
  assert.equal(trust.checkSpendCap(AMA, 6000).blocked, "over_daily_cap");
  assert.equal(trust.checkSpendCap(AMA, 6000).say, "Your daily limit is $50 and this would take you to $60. You can raise it in Settings → Shopping, or tell me a new limit.");
  assert.equal(trust.checkSpendCap(OMARI, 6000).ok, true);
  // Back up to the default (or anything under it) needs nobody's yes either.
  const up = await runTool("spend_limit_set", { daily: 100 }, { conversationId: AMA });
  assert.equal(up.applied, true);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  // Nonsense is refused, nothing changes.
  const bad = await runTool("spend_limit_set", { daily: 0.001 }, { conversationId: AMA });
  assert.equal(bad.ok, false);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
});

// ---------------------------------------------------------------- 3. a raise above the default, without a passkey: a yes that expires
test("without a passkey a raise above the default waits for a yes; yes applies it, no keeps it, and the question runs out after a day", async () => {
  // Their own messages, as the turn has them: a yes is read off a message of theirs after the ask.
  const amaSaid = (t) => ({ role: "user", content: `[Sat, Oct 31, 2026, 1:00 PM] Ama: ${t}` });
  const asked = [amaSaid("raise my shopping limit to 250")];
  const answered = [...asked, amaSaid("yes, raise it")];
  const ask = await runTool("spend_limit_set", { daily: 250, text: "raise my shopping limit to 250" }, { conversationId: AMA, messages: asked });
  assert.equal(ask.ok, false);
  assert.equal(ask.needs, "yes");
  assert.ok(ask.change_id > 0);
  assert.match(ask.say, /needs a yes/);
  assert.doesNotMatch(ask.say, QUOTED_PHRASE);
  assert.equal(spendcap.capFor(AMA).cents, 10000, "nothing changed yet");
  assert.equal(spendcap.view(AMA).pending.to, "$250");
  // Somebody else cannot confirm it.
  assert.equal((await runTool("spend_limit_confirm", { change_id: ask.change_id, answer: "yes" }, { conversationId: OMARI })).ok, false);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  // Their no leaves it.
  const no = await runTool("spend_limit_confirm", { change_id: ask.change_id, answer: "no" }, { conversationId: AMA });
  assert.equal(no.ok, true);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  assert.equal(spendcap.changeRow(ask.change_id).status, "declined");
  // Asked again and answered yes: applied, with their words on the row.
  const ask2 = await runTool("spend_limit_set", { daily: 250, text: "raise my shopping limit to 250" }, { conversationId: AMA, messages: asked });
  // The model's "yes" with nothing from them since the ask changes nothing (security audit 2026-11-06).
  assert.equal((await runTool("spend_limit_confirm", { change_id: ask2.change_id, answer: "yes" }, { conversationId: AMA, messages: asked, judge: async () => ({ verdict: "yes" }) })).ok, false);
  const yes = await runTool("spend_limit_confirm", { change_id: ask2.change_id, answer: "yes" }, { conversationId: AMA, messages: answered, judge: async () => ({ verdict: "yes" }) });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.deepEqual([yes.from, yes.to], ["$100", "$250"]);
  assert.equal(spendcap.capFor(AMA).cents, 25000);
  assert.equal(spendcap.ownCap(AMA).said, "raise my shopping limit to 250");
  assert.equal((await runTool("spend_limit_confirm", { change_id: ask2.change_id, answer: "yes" }, { conversationId: AMA, messages: answered, judge: async () => ({ verdict: "yes" }) })).ok, false, "a yes is spent once");
  // A raise asked and left for a day runs out, like any ask about money.
  const ask3 = await runTool("spend_limit_set", { daily: 400 }, { conversationId: AMA, messages: asked });
  clock.skip(24 * HOUR + 1000);
  const late = await runTool("spend_limit_confirm", { change_id: ask3.change_id, answer: "yes" }, { conversationId: AMA, messages: answered, judge: async () => ({ verdict: "yes" }) });
  assert.equal(late.ok, false);
  assert.equal(late.error, "change_expired");
  assert.equal(spendcap.capFor(AMA).cents, 25000);
  assert.equal(spendcap.changeRow(ask3.change_id).status, "expired");
  // Lowering from there is still immediate.
  assert.equal((await runTool("spend_limit_set", { daily: 200 }, { conversationId: AMA })).applied, true);
  assert.equal(spendcap.capFor(AMA).cents, 20000);
});

// ---------------------------------------------------------------- 4. a raise with a passkey: Face ID on the link
test("with a passkey a raise above the default is a Face ID link: the page shows the new number, the tap applies it, one text says so, the link is spent", async () => {
  const auth = await setUp(AMA);
  const ask = await runTool("spend_limit_set", { daily: 250, text: "raise my limit to 250" }, { conversationId: AMA });
  assert.equal(ask.needs, "face_id");
  assert.match(ask.url, /^https:\/\/heyreason\.com\/web\/approve\/[A-Za-z0-9_-]{32}$/);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  const token = tokenOf(ask.url);
  const got = await page(token);
  assert.equal(got.status, 200);
  assert.match(got.body, /Raise your daily limit to \$250\?/);
  assert.match(got.body, /From \$100 a day/);
  assert.doesNotMatch(got.body, /Best Buy|Pay \$/);
  const o = optionsOf(got.body);
  assert.deepEqual(o.allowCredentials.map((c) => c.id), [auth.id]);
  // The row changing under the link (a different number) fails the binding.
  q("UPDATE cap_changes SET to_cents = 90000 WHERE id = ?").run(ask.change_id);
  assert.equal(JSON.parse((await page(token, "verify", auth.get(o.challenge))).body).error, "details_changed");
  q("UPDATE cap_changes SET to_cents = 25000 WHERE id = ?").run(ask.change_id);
  said.length = 0;
  const res = await page(token, "verify", auth.get(o.challenge));
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(spendcap.capFor(AMA).cents, 25000);
  assert.equal(spendcap.changeRow(ask.change_id).status, "applied");
  assert.equal(said.length, 1);
  assert.equal(said[0].t, "Approved with Face ID. Done. Your daily spending limit is $250 a day (it was $100).");
  assert.equal(orderIntents().length, 0, "nothing was paid");
  assert.equal(JSON.parse((await page(token, "verify", auth.get(o.challenge))).body).error, "link_used");
  assert.equal((await page(token)).status, 200);
  assert.match((await page(token)).body, /Already approved/);
  // No payment row was invented for it.
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_payments").get().n, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM pay_approval_log WHERE payment_id IS NOT NULL").get().n, 0, "cap events never borrow a payment id");
});

test("with a passkey, declining the link keeps the limit and says so once; a link and a payment never share an approval", async () => {
  const auth = await setUp(AMA);
  const ask = await runTool("spend_limit_set", { daily: 300 }, { conversationId: AMA });
  // A payment asked at the same time has its own link; neither closes the other.
  const pay = asked(AMA, "9.79");
  const payLink = await runTool("shop_pay", { payment_id: pay.id }, { conversationId: AMA });
  assert.equal(passkey.approvalFor(tokenOf(ask.url)).state, "open");
  assert.equal(passkey.approvalFor(tokenOf(payLink.url)).state, "open");
  said.length = 0;
  const res = await page(tokenOf(ask.url), "decline");
  assert.equal(res.status, 200);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  assert.equal(spendcap.changeRow(ask.change_id).status, "declined");
  assert.deepEqual(said.map((s) => s.t), ["Left as it was: your daily spending limit stays $100."]);
  assert.equal(shop.paymentRow(pay.id).status, "asked", "the payment was not declined with it");
  // The payment's own link still pays.
  const got = await page(tokenOf(payLink.url));
  const ok = await page(tokenOf(payLink.url), "verify", auth.get(optionsOf(got.body).challenge));
  assert.equal(ok.status, 200, ok.body);
  assert.equal(orderIntents().length, 1);
});

// ---------------------------------------------------------------- 5. the ceiling
test("nobody sets more than $1,000 a day for themselves — the owner included — and the answer names the ceiling, not who could go higher", async () => {
  for (const c of [AMA, OMARI]) {
    const out = await runTool("spend_limit_set", { daily: 1500 }, { conversationId: c });
    assert.equal(out.ok, false);
    assert.equal(out.error, "over_ceiling");
    assert.equal(out.ceiling, "$1,000");
    assert.match(out.say, /\$1,000 a day/);
    assert.doesNotMatch(out.say, /\.env|REASON_|operator/);
    assert.equal(spendcap.capFor(c).cents, 10000);
    assert.equal(q("SELECT COUNT(*) AS n FROM cap_changes WHERE conversation_id = ?").get(c).n, 0, "nothing parked either");
  }
  // Exactly the ceiling is allowed (with the yes).
  const ask = await runTool("spend_limit_set", { daily: 1000 }, { conversationId: AMA, messages: [{ role: "user", content: "[Sat, Oct 31, 2026, 1:00 PM] Ama: make it 1000 a day" }] });
  assert.equal(ask.needs, "yes");
  assert.equal((await runTool("spend_limit_confirm", { change_id: ask.change_id, answer: "yes" }, { conversationId: AMA, judge: async () => ({ verdict: "yes" }), messages: [{ role: "user", content: "[Sat, Oct 31, 2026, 1:00 PM] Ama: make it 1000 a day" }, { role: "user", content: "[Sat, Oct 31, 2026, 1:01 PM] Ama: yes" }] })).ok, true);
  assert.equal(spendcap.capFor(AMA).cents, 100000);
  assert.equal(spendcap.SELF_MAX_CENTS, 100000);
});

// ---------------------------------------------------------------- 6. the figures
test("shop_status, spend_today and caps_show read the real figures: spent today, the limit, what is left", async () => {
  spend(AMA, 1800);
  const status = await runTool("shop_status", {}, { conversationId: AMA });
  assert.deepEqual({ spent: status.spending.spent_today, cap: status.spending.daily_limit, left: status.spending.left_today, by: status.spending.limit_set_by },
    { spent: "$18", cap: "$100", left: "$82", by: "the default here ($100)" });
  assert.doesNotMatch(status.spending.note, QUOTED_PHRASE);
  const today = await runTool("spend_today", {}, { conversationId: AMA });
  assert.deepEqual({ spent: today.spent, cap: today.cap, left: today.left, by: today.cap_set_by }, { spent: "$18.00", cap: "$100.00", left: "$82.00", by: "the default here" });
  const caps = await runTool("caps_show", {}, { conversationId: AMA });
  assert.equal(caps.today.spent, "$18.00");
  assert.equal(caps.today.cap, "$100.00");
  // Their own number shows as theirs.
  await runTool("spend_limit_set", { daily: 40 }, { conversationId: AMA });
  const after = await runTool("shop_status", {}, { conversationId: AMA });
  assert.deepEqual({ cap: after.spending.daily_limit, left: after.spending.left_today, by: after.spending.limit_set_by }, { cap: "$40", left: "$22", by: "them" });
  assert.equal((await runTool("shop_status", {}, { conversationId: OMARI })).spending.spent_today, "$0");
});

// ---------------------------------------------------------------- 7. Settings → Shopping
test("Settings → Shopping: the field shows the limit and the default, saves a lowering at once, round-trips, and refuses the ceiling", async () => {
  const b = browser(AMA);
  const html = (await settingsGet(b)).body;
  assert.match(html, /Daily limit\. <em>\$100 a day, the default\.<\/em>/);
  assert.match(html, /The default here is \$100; you can set up to \$1,000\./);
  assert.equal(fieldValue(html), "100");
  // Lowered: saved now, the page says so and shows it.
  const low = await settingsPost(b, { do: "cap", cap: "60" });
  assert.equal(low.status, 303);
  assert.equal(low.headers.Location, "/web/settings?done=cap#shopping");
  assert.equal(spendcap.capFor(AMA).cents, 6000);
  const again = (await settingsGet(b, { done: "cap" })).body;
  assert.equal(fieldValue(again), "60");
  assert.match(again, /Daily limit\. <em>\$60 a day\.<\/em>/);
  assert.match(again, /daily limit saved\./);
  // Dollars with a sign and cents work; nonsense does not.
  assert.equal((await settingsPost(b, { do: "cap", cap: "$82.50" })).headers.Location, "/web/settings?done=cap#shopping");
  assert.equal(spendcap.capFor(AMA).cents, 8250);
  assert.equal(fieldValue((await settingsGet(b)).body), "82.50");
  assert.equal((await settingsPost(b, { do: "cap", cap: "lots" })).headers.Location, "/web/settings?done=cap-bad#shopping");
  assert.equal(spendcap.capFor(AMA).cents, 8250);
  // Over the ceiling: refused, said on the page.
  assert.equal((await settingsPost(b, { do: "cap", cap: "5000" })).headers.Location, "/web/settings?done=cap-ceiling#shopping");
  assert.match((await settingsGet(b, { done: "cap-ceiling" })).body, /the most you can set here is \$1,000 a day\./);
  assert.equal(spendcap.capFor(AMA).cents, 8250);
  // Somebody else's page shows their own number, not Ama's.
  assert.equal(fieldValue((await settingsGet(browser(OMARI))).body), "100");
  // Without the page's own secret nothing changes.
  const forged = await st.settingsRequest({ account: account(AMA), method: "POST", headers: { cookie: b.cookie, host: "heyreason.com", origin: ORIGIN, "sec-fetch-site": "same-origin" }, readBody: async () => new URLSearchParams({ c: "nope", do: "cap", cap: "10" }).toString() });
  assert.equal(forged.status, 403);
  assert.equal(spendcap.capFor(AMA).cents, 8250);
});

test("Settings → Shopping: a raise above the default without a passkey asks right there; yes applies it, keep leaves it, a day later it has run out", async () => {
  const b = browser(AMA);
  const raise = await settingsPost(b, { do: "cap", cap: "250" });
  assert.equal(raise.status, 303);
  const m = /^\/web\/settings\?confirm=cap&i=(\d+)#shopping$/.exec(raise.headers.Location);
  assert.ok(m, raise.headers.Location);
  assert.equal(spendcap.capFor(AMA).cents, 10000, "nothing changed yet");
  const confirm = (await settingsGet(b, { confirm: "cap", i: m[1] })).body;
  assert.match(confirm, /Raise your daily limit to \$250\? <em>From \$100 a day\.<\/em>/);
  assert.match(confirm, /Yes, raise it/);
  assert.match(confirm, /KEEP \$100/);
  // Somebody else's change id draws nothing to confirm.
  assert.doesNotMatch((await settingsGet(browser(OMARI), { confirm: "cap", i: m[1] })).body, /Raise your daily limit/);
  // Keep: the number stays.
  assert.equal((await settingsPost(b, { do: "cap-keep", i: m[1] })).headers.Location, "/web/settings?done=cap-kept#shopping");
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  assert.equal((await settingsPost(b, { do: "cap-confirm", i: m[1] })).headers.Location, "/web/settings#shopping", "a kept change cannot be confirmed after");
  // Yes: applied.
  const again = /i=(\d+)/.exec((await settingsPost(b, { do: "cap", cap: "250" })).headers.Location)[1];
  assert.equal((await settingsPost(b, { do: "cap-confirm", i: again })).headers.Location, "/web/settings?done=cap#shopping");
  assert.equal(spendcap.capFor(AMA).cents, 25000);
  assert.equal(fieldValue((await settingsGet(b)).body), "250");
  // Run out: a day on, the yes finds nothing.
  const late = /i=(\d+)/.exec((await settingsPost(b, { do: "cap", cap: "400" })).headers.Location)[1];
  clock.skip(24 * HOUR + 1000);
  assert.equal((await settingsPost(b, { do: "cap-confirm", i: late })).headers.Location, "/web/settings?done=cap-expired#shopping");
  assert.equal(spendcap.capFor(AMA).cents, 25000);
});

test("Settings → Shopping: with a passkey a raise above the default goes to the Face ID page, and the page shows the raise", async () => {
  const auth = await setUp(AMA);
  const b = browser(AMA);
  assert.match((await settingsGet(b)).body, /Raising it above the default needs Face ID\./);
  const raise = await settingsPost(b, { do: "cap", cap: "250" });
  assert.equal(raise.status, 303);
  assert.match(raise.headers.Location, /^\/web\/approve\/[A-Za-z0-9_-]{32}$/);
  assert.equal(spendcap.capFor(AMA).cents, 10000);
  const token = raise.headers.Location.split("/web/approve/")[1];
  const got = await page(token);
  assert.match(got.body, /Raise your daily limit to \$250\?/);
  assert.match((await settingsGet(b)).body, /A raise to \$250 is waiting for your Face ID/);
  const res = await page(token, "verify", auth.get(optionsOf(got.body).challenge));
  assert.equal(res.status, 200, res.body);
  assert.equal(spendcap.capFor(AMA).cents, 25000);
  assert.equal(fieldValue((await settingsGet(b)).body), "250");
  assert.equal(said.at(-1).t, "Approved with Face ID. Done. Your daily spending limit is $250 a day (it was $100).");
});

test("with a passkey, a texted yes or the Settings button never raises the limit: the code refuses and hands back a fresh Face ID link", async () => {
  const auth = await setUp(AMA);
  const ask = await runTool("spend_limit_set", { daily: 250, text: "raise my limit to 250" }, { conversationId: AMA });
  assert.equal(ask.needs, "face_id");
  const first = tokenOf(ask.url);
  // The model asserting a yes (spend_limit_confirm) is not enough.
  const yes = await runTool("spend_limit_confirm", { change_id: ask.change_id, answer: "yes" }, { conversationId: AMA });
  assert.equal(yes.ok, false);
  assert.equal(yes.error, "needs_face_id");
  assert.match(yes.url, /^https:\/\/heyreason\.com\/web\/approve\/[A-Za-z0-9_-]{32}$/);
  assert.match(yes.say, /Face ID/);
  assert.equal(spendcap.capFor(AMA).cents, 10000, "a texted yes raised nothing");
  assert.equal(spendcap.changeRow(ask.change_id).status, "asked");
  // Nor is a POST to the Settings yes button.
  const b = browser(AMA);
  const web = await settingsPost(b, { do: "cap-confirm", i: String(ask.change_id) });
  assert.equal(web.status, 303);
  assert.match(web.headers.Location, /^\/web\/approve\/[A-Za-z0-9_-]{32}$/);
  assert.equal(spendcap.capFor(AMA).cents, 10000, "the Settings button raised nothing");
  // The newest link is the live one; the first was replaced. Face ID on the live link applies it.
  const token = web.headers.Location.split("/web/approve/")[1];
  assert.notEqual(token, first);
  const got = await page(token);
  assert.match(got.body, /Raise your daily limit to \$250\?/);
  const res = await page(token, "verify", auth.get(optionsOf(got.body).challenge));
  assert.equal(res.status, 200, res.body);
  assert.equal(spendcap.capFor(AMA).cents, 25000);
});
