// The checkout job (src/shopconnect.js, src/shoptools.js, src/offers.js checkoutClaims), pinned to
// 2026-10-31. At 10:58 ET store_checkout started a real Ulta run for the owner (CeraVe 16 oz); at
// 11:00 Crossmint asked a plain form — shipping and contact details — which the follower handed to
// nobody; at 11:10 the request expired, the run failed, and nothing was said. Asked "Updates?" at
// 11:17 the model said "the checkout never actually started" (false), started another, and that one
// died the same way. What these hold:
//   1. "I've started the checkout" with no run behind it is refused and one honest line goes instead;
//      "never actually started" with a run on record is corrected from the record.
//   2. A plain question wakes the model, once; shop_answer answers it and the job moves on; the
//      answers are sealed out of the log.
//   3. The end of a run is texted by code, once, saying what happened; a stall is texted once.
//   4. shop_status and the turn note read the row, never the chat.
//   5. A payment is itemized when Crossmint itemizes; after it, the mail is watched for the
//      confirmation (bounded) and the model is woken when it lands; a restart resumes all of it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-checkout-job-"));
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
const offers = await import("../src/offers.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { sealTravelers } = await import("../src/privacy.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const ULTA = "https://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=2541605";

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, nextRun;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1 };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages)?$/.exec(p);
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { error: true, message: `Checkout '${m[1]}' not found` });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  return reply(404, { message: "no route" });
}
// Crossmint's own shapes, as seen live on 2026-10-31 (bfbab17b…, 3e6845d9…).
const SHIPPING_FORM = (requestId) => ({
  requestId, request: {
    question: "What are Omari’s shipping and contact details for the Ulta order?", expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "form", fields: [
      { key: "first_name", label: "First name", required: true, handling: "standard", input: { kind: "text", autoComplete: "given-name" } },
      { key: "last_name", label: "Last name", required: true, handling: "standard", input: { kind: "text", autoComplete: "family-name" } },
      { key: "address_line_1", label: "Street address", required: true, handling: "standard", input: { kind: "text" } },
      { key: "address_line_2", label: "Apartment, suite, etc. (optional)", required: false, handling: "standard", input: { kind: "text" } },
      { key: "city", label: "City", required: true, handling: "standard", input: { kind: "text" } },
      { key: "state", label: "State", required: true, handling: "standard", input: { kind: "text" } },
      { key: "zip", label: "ZIP", required: true, handling: "standard", input: { kind: "text" } },
      { key: "phone", label: "Phone", required: true, handling: "standard", input: { kind: "text", autoComplete: "tel" } },
      { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text", autoComplete: "email" } },
    ] },
  },
});
const SIGNIN = (requestId) => ({
  requestId, request: { question: "Enter your Ulta email and password.", interaction: { kind: "form", fields: [
    { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text" } },
    { key: "password", label: "Password", required: true, handling: "protected", input: { kind: "text", display: "masked" } },
  ] } },
});
const PAY = (requestId, { value = "28.24", breakdown = null } = {}) => ({
  requestId, request: {
    question: `Please approve a card payment of $${value} to Ulta.`, expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value, currency: "USD", ...(breakdown ? { breakdown } : {}) }, merchant: { name: "Ulta", countryCode: "US", url: "https://www.ulta.com/" } },
  },
});
const EXPIRED = { status: "failed", requiredAction: null, reason: "input_expired", revision: 3 };

const said = [];
const woke = [];
const q = (sql) => db.db.prepare(sql);
before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; said.length = 0; woke.length = 0; clock.reset(); shop._setMail(null);
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping"]) db.db.exec(`DELETE FROM ${t}`);
});
const start = (conv = OMARI) => shop.startCheckout({ conversationId: conv, store: "ulta", startUrl: ULTA, what: "One CeraVe Foaming Facial Cleanser, 16 oz, shipped to home.", item: "CeraVe Foaming Facial Cleanser 16 oz", maxUsd: 35 });
const row = (runId) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(runId);

// ---------------------------------------------------------------- 1. the claim
const TEN58 = "I've started the Ulta checkout for the 16 oz. When it gets to payment I'll text you the exact total with shipping included, and nothing gets charged until you approve it.";
const ELEVEN17 = "My bad: the checkout never actually started at 10:58, even though I told you it had. Nothing was running and nothing was charged.\n\nI've started it for real now. It's a guest checkout on Ulta for the 16 oz.";

test("pinned 10:58: 'I've started the checkout' with no run behind it is refused, promises and all, and one honest line goes instead", () => {
  const g = offers.guardReply(OMARI, TEN58);
  assert.equal(g.text, "I haven't actually started a checkout: nothing is running and nothing has been charged. Want me to start it now?");
  assert.ok(g.changed);
  assert.ok(g.flags.some((f) => f.rule === "started_without_run"));
  // Other words around it survive; only the claim and the promises hung on it go.
  const g2 = offers.guardReply(OMARI, "Rags is on at 10 tomorrow. I've kicked off the checkout for the cleanser.");
  assert.match(g2.text, /^Rags is on at 10 tomorrow\.\nI haven't actually started a checkout/);
  // Not a claim: an offer to start, a question, a line about one that failed.
  for (const s of ["Want me to start checkout on the 16 oz?", "I'll start the checkout once you pick a size.", "The checkout failed; nothing was charged.", "Should I start the order?"]) {
    assert.equal(offers.guardReply(OMARI, s).text, s, s);
  }
  // Somebody without Crossmint checkouts is left alone.
  assert.equal(offers.guardReply(AMA, TEN58).text, TEN58);
});

test("the same line with a run of theirs behind it goes through untouched; an old run is not enough", async () => {
  const out = await start();
  assert.ok(out.ok && out.runId);
  assert.equal(offers.guardReply(OMARI, TEN58).text, TEN58);
  // A run still open an hour on still counts: it is running.
  clock.skip(60 * 60_000);
  assert.equal(offers.guardReply(OMARI, TEN58).text, TEN58);
  // Over and old: no.
  runs[out.runId] = { ...EXPIRED };
  await shop.step(out.runId);
  clock.skip(20 * 60_000);
  assert.ok(offers.guardReply(OMARI, TEN58).flags.some((f) => f.rule === "started_without_run"));
});

test("pinned 11:17: 'never actually started' about a run that ran and died is corrected from the record", async () => {
  const out = await start();
  runs[out.runId].requiredAction = SHIPPING_FORM("req_ship_1");
  runs[out.runId].revision = 2;
  await shop.step(out.runId);
  clock.skip(11 * 60_000);
  runs[out.runId] = { ...EXPIRED };
  await shop.step(out.runId);
  clock.skip(8 * 60_000);
  // The second run really did start, so that half of the line stands.
  await start();
  const g = offers.guardReply(OMARI, ELEVEN17);
  assert.match(g.text, /^Correction, from my record: the Ulta checkout for CeraVe Foaming Facial Cleanser 16 oz did start 19 min ago; now: failed 8 min ago \(Ulta was waiting for your name, shipping address, phone number and email and it expired after 10 minutes\); nothing charged\./);
  assert.doesNotMatch(g.text, /never actually started|Nothing was running/);
  assert.match(g.text, /I've started it for real now\. It's a guest checkout on Ulta for the 16 oz\./);
  assert.ok(g.flags.some((f) => f.rule === "never_started_with_run"));
  // A denial about something else is not corrected, run or no run.
  for (const s of ["The timer never started, sorry.", "The call didn't start; your line was busy.", "Nothing is running on the calendar today."]) {
    assert.equal(offers.guardReply(OMARI, s).text, s, s);
  }
});

// ---------------------------------------------------------------- 2. a plain question
test("pinned: Ulta's shipping form wakes the model once, with the fields; shop_answer answers it and the job moves on; answers are sealed", async () => {
  const out = await start();
  assert.equal(row(out.runId).stage, "started");
  runs[out.runId].requiredAction = SHIPPING_FORM("req_ship_1");
  runs[out.runId].revision = 2;
  const s = await shop.step(out.runId);
  assert.equal(s.woke, "req_ship_1");
  assert.equal(row(out.runId).stage, "needs_input");
  assert.equal(woke.length, 1);
  assert.equal(woke[0].c, OMARI);
  assert.equal(woke[0].key, `shop:${out.runId}:req_ship_1`);
  // Since 2026-10-31 (anticipate) the deadline is a clock time, never a countdown; what is still needed is named.
  assert.match(woke[0].t, /^\[checkout\] Ulta's checkout for CeraVe Foaming Facial Cleanser 16 oz \(run run_1\) is waiting on an answer\. Ulta asks:/);
  assert.match(woke[0].t, /Ulta holds the cart until \d{1,2}:\d{2} [AP]M; say that as the time, never as a countdown/);
  assert.doesNotMatch(woke[0].t, /expires in/);
  assert.match(woke[0].t, /Still needed, and the ONLY thing to ask for: last_name \(Last name\), address_line_1/);
  assert.match(woke[0].t, /address_line_1: Street address; address_line_2 \(optional\): Apartment/);
  assert.match(woke[0].t, /shop_answer/);
  assert.equal(said.length, 0, "nothing texted to them for a question code hands to the model");
  // The same request on the next look does not wake it again.
  await shop.step(out.runId);
  assert.equal(woke.length, 1);

  // The model answers from what it knows.
  const answers = { first_name: "Omari", last_name: "Nyarko", address_line_1: "1 Example St", city: "Bronx", state: "NY", zip: "10469", phone: "7185550000", email: "o@example.com" };
  const missing = await runTool("shop_answer", { run_id: out.runId, answers: { first_name: "Omari" } }, { conversationId: OMARI });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "missing_field");
  const ok = await runTool("shop_answer", { run_id: out.runId, answers }, { conversationId: OMARI });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.answered.sort(), Object.keys(answers).sort());
  const posted = calls.find((c) => c.path === `/api/unstable/agent-checkouts/${out.runId}/messages`).body.parts[0];
  assert.equal(posted.type, "input_response");
  assert.equal(posted.requestId, "req_ship_1");
  assert.equal(posted.response.answers.zip, "10469");
  assert.equal(row(out.runId).stage, "in_progress");
  // Answered: a second answer has nothing to answer.
  assert.equal((await runTool("shop_answer", { run_id: out.runId, answers }, { conversationId: OMARI })).error, "nothing_asked");
  // Sealed out of the tool log, like a passenger's details.
  const sealed = sealTravelers("shop_answer", { run_id: out.runId, answers });
  assert.equal(sealed.answers, "[sealed]");
  assert.equal(sealed.run_id, out.runId);
  assert.ok(!JSON.stringify(sealed).includes("10469"));
  // Somebody else cannot answer their checkout.
  assert.equal((await shop.answerRun(out.runId, { conversationId: AMA, answers })).error, "no_such_run");
});

test("a sign-in form still goes to the link, never through shop_answer", async () => {
  const out = await start();
  runs[out.runId].requiredAction = SIGNIN("req_signin_1");
  await shop.step(out.runId);
  assert.equal(woke.length, 0);
  assert.match(said.at(-1).t, /Ulta needs you signed in.*heyreason\.test\/web\/connect\//s);
  assert.equal(row(out.runId).stage, "needs_input");
  const r = await shop.answerRun(out.runId, { conversationId: OMARI, answers: { email: "o@example.com", password: "hunter2" } });
  assert.equal(r.error, "needs_signin_link");
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 0);
});

// ---------------------------------------------------------------- 3. the end, and a stall
test("pinned: a run that expires waiting on an answer is texted once — what was asked, nothing charged, the next step", async () => {
  const out = await start();
  runs[out.runId].requiredAction = SHIPPING_FORM("req_ship_1");
  await shop.step(out.runId);
  clock.skip(11 * 60_000);
  runs[out.runId] = { ...EXPIRED };
  const done = await shop.step(out.runId);
  assert.equal(done.done, true);
  assert.equal(row(out.runId).stage, "failed");
  assert.equal(row(out.runId).status, "failed");
  assert.equal(row(out.runId).result, "input_expired");
  assert.equal(said.at(-1).t, "The Ulta checkout for CeraVe Foaming Facial Cleanser 16 oz stopped: Ulta was waiting for your name, shipping address, phone number and email and didn't get it in time, so it expired. Nothing was charged. Want me to start it again?");
  const n = said.length;
  await shop.step(out.runId);
  await shop.step(out.runId);
  assert.equal(said.length, n, "said once");
});

test("other ends are texted too: blocked, cancelled, and an end after a payment went out", async () => {
  const a = await start();
  runs[a.runId] = { status: "blocked", result: { code: "merchant.out_of_stock", summary: "The 16 oz is out of stock online." }, revision: 4 };
  await shop.step(a.runId);
  assert.equal(said.at(-1).t, "The Ulta checkout for CeraVe Foaming Facial Cleanser 16 oz didn't go through (The 16 oz is out of stock online.). Nothing was charged. Want me to try again, or try another store?");
  const b = await start();
  runs[b.runId] = { status: "cancelled", revision: 2 };
  await shop.step(b.runId);
  assert.equal(said.at(-1).t, "The Ulta checkout for CeraVe Foaming Facial Cleanser 16 oz was cancelled. Nothing was charged.");
  assert.equal(row(b.runId).stage, "cancelled");
  // Paid, then the run failed: the outcome is unknown and they are told exactly that.
  q("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'visa', '4242', ?)").run(OMARI, clock.now());
  const c = await start();
  runs[c.runId].requiredAction = PAY("req_pay_1");
  await shop.step(c.runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(c.runId);
  const paid = await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 7 });
  assert.equal(paid.ok, true);
  assert.equal(row(c.runId).stage, "paid");
  runs[c.runId] = { status: "failed", result: { code: "merchant.error", summary: "Ulta's page errored after payment." }, revision: 9 };
  await shop.step(c.runId);
  assert.match(said.at(-1).t, /^Ulta's checkout for CeraVe Foaming Facial Cleanser 16 oz ended after the payment was approved \(Ulta's page errored after payment\.\)\. I can't tell from here whether the order went through/);
});

test("review: a payment Reason can't approve (not a card) is said once and never handed to the model; shop_answer refuses anything but a form", async () => {
  const out = await start();
  runs[out.runId].requiredAction = { requestId: "req_pay_x", request: { question: "Approve payment via store credit.", interaction: { kind: "payment", method: "store_credit", amount: { kind: "exact", value: "12.00", currency: "USD" }, merchant: { name: "Ulta" } } } };
  await shop.step(out.runId);
  assert.equal(woke.length, 0);
  assert.equal(row(out.runId).stage, "in_progress");
  assert.equal(said.at(-1).t, "Ulta asked for a payment I can't approve from here (by store_credit), so I didn't. Nothing was charged.");
  await shop.step(out.runId);
  assert.equal(said.length, 1, "once");
  // Even forced into needs_input, a payment request is not a form: refused before any POST.
  q("UPDATE shop_runs SET stage = 'needs_input' WHERE run_id = ?").run(out.runId);
  const r = await shop.answerRun(out.runId, { conversationId: OMARI, answers: {} });
  assert.equal(r.error, "not_a_form");
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 0);
});

test("review: an expired payment approval reads as that; a wake that failed is raised again on the next look", async () => {
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_pay_1");
  await shop.step(a.runId);
  clock.skip(11 * 60_000);
  runs[a.runId] = { ...EXPIRED };
  await shop.step(a.runId);
  assert.match(said.at(-1).t, /Ulta was waiting for your approval of the payment and didn't get it in time/);
  // The wake fails once (the runtime threw), and the same request is put to the model on the next look.
  const b = await start();
  runs[b.runId].requiredAction = SHIPPING_FORM("req_ship_b");
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: async () => { throw new Error("runtime down"); }, base: "https://heyreason.test/web/connect" });
  const s1 = await shop.step(b.runId);
  assert.equal(s1.woke, "req_ship_b");
  assert.ok(!String(row(b.runId).told).includes("woke:req_ship_b"));
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
  const s2 = await shop.step(b.runId);
  assert.equal(s2.woke, "req_ship_b");
  assert.equal(woke.length, 1);
  assert.ok(String(row(b.runId).told).includes("woke:req_ship_b"));
  const s3 = await shop.step(b.runId);
  assert.equal(s3.woke, null);
  assert.equal(woke.length, 1, "raised once it got through");
});

test("review: a run Crossmint stops answering about ends after LOST_MS, said once; a run already on live with no stage still moves", async () => {
  const out = await start();
  await shop.step(out.runId);
  delete runs[out.runId]; // Crossmint forgot it: 404 from here on
  clock.skip(shop.LOST_MS - 60_000);
  assert.equal((await shop.step(out.runId)).done, false);
  clock.skip(2 * 60_000);
  const s = await shop.step(out.runId);
  assert.equal(s.lost, true);
  assert.equal(row(out.runId).status, "failed");
  assert.equal(said.at(-1).t, "I lost track of the Ulta checkout for CeraVe Foaming Facial Cleanser 16 oz: the checkout service stopped answering about it. Nothing was charged that I can see. Want me to start it again?");
  assert.match(said.at(-2).t, /^Still at Ulta's checkout/, "the stall was said first, at twelve minutes");
  const n = said.length;
  assert.equal((await shop.step(out.runId)).done, true);
  assert.equal(said.length, n, "once");
  // A row from before this change (stage '') is treated as started.
  const old = await start();
  q("UPDATE shop_runs SET stage = '' WHERE run_id = ?").run(old.runId);
  await shop.step(old.runId);
  assert.equal(row(old.runId).stage, "in_progress");
});

test("a stall — nothing moved for ten minutes — is texted once, and progress is Crossmint's revision", async () => {
  const out = await start();
  await shop.step(out.runId);
  assert.equal(row(out.runId).stage, "in_progress");
  clock.skip(6 * 60_000);
  runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(said.length, 0, "it moved");
  clock.skip(11 * 60_000);
  await shop.step(out.runId);
  assert.equal(said.length, 0, "eleven minutes is not a stall: Crossmint's own input expiry is ten, and that is reported as expired");
  clock.skip(2 * 60_000);
  const s = await shop.step(out.runId);
  assert.equal(s.stalled, true);
  assert.equal(said.at(-1).t, "Still at Ulta's checkout for CeraVe Foaming Facial Cleanser 16 oz: nothing has moved for 13 minutes. Nothing has been charged. If it dies I'll say so.");
  clock.skip(5 * 60_000);
  await shop.step(out.runId);
  assert.equal(said.length, 1, "once");
});

// ---------------------------------------------------------------- 4. the record
test("shop_status and the turn note read the row: a failed run reads as failed, nothing as nothing", async () => {
  assert.equal(shop.checkoutNote(OMARI), "");
  assert.match((await runTool("shop_status", {}, { conversationId: OMARI })).note, /No checkout has run/);
  const out = await start();
  runs[out.runId].requiredAction = SHIPPING_FORM("req_ship_1");
  await shop.step(out.runId);
  let note = shop.checkoutNote(OMARI);
  assert.match(note, /^Checkout record \(code's own, from the database; it overrides anything the chat says about these orders\):\n- Ulta, CeraVe Foaming Facial Cleanser 16 oz: waiting since 1 min ago on an answer to "What are Omari’s shipping/);
  assert.match(note, /Never say a checkout started unless store_checkout returned a run_id this turn/);
  clock.skip(11 * 60_000);
  runs[out.runId] = { ...EXPIRED };
  await shop.step(out.runId);
  const st = await runTool("shop_status", {}, { conversationId: OMARI });
  assert.equal(st.runs.length, 1);
  assert.equal(st.runs[0].stage, "failed");
  assert.match(st.runs[0].where, /^failed 1 min ago \(Ulta was waiting for your name, shipping address, phone number and email and it expired/);
  assert.match(st.note, /Answer from it, never from the chat/);
  note = shop.checkoutNote(OMARI);
  assert.match(note, /failed 1 min ago/);
  // Theirs only; and not for somebody without checkouts.
  assert.equal(shop.checkoutNote(AMA), "");
  assert.equal((await runTool("shop_status", {}, { conversationId: AMA })).ok, false);
  const names = toolsFor(OMARI).map((t) => t.name);
  assert.ok(names.includes("shop_status") && names.includes("shop_answer"));
  const theirs = toolsFor(AMA).map((t) => t.name);
  assert.ok(!theirs.includes("shop_status") && !theirs.includes("shop_answer"));
});

// ---------------------------------------------------------------- 5. payment, the order, the mail
test("the payment ask is itemized when Crossmint itemizes it; plain when it doesn't", async () => {
  const a = await start();
  runs[a.runId].requiredAction = PAY("req_pay_1", { breakdown: { subtotal: { value: "18.99", currency: "USD" }, shipping: { value: "6.95", currency: "USD" }, tax: { value: "2.30", currency: "USD" } } });
  await shop.step(a.runId);
  assert.equal(said.at(-1).t, "Ulta's total for CeraVe Foaming Facial Cleanser 16 oz: item $18.99, shipping $6.95, tax $2.30; $28.24 all in.\nOK to pay $28.24 at Ulta for CeraVe Foaming Facial Cleanser 16 oz?");
  assert.equal(row(a.runId).stage, "needs_approval");
  const b = await start();
  runs[b.runId].requiredAction = PAY("req_pay_2");
  await shop.step(b.runId);
  assert.equal(said.at(-1).t, "OK to pay $28.24 at Ulta for CeraVe Foaming Facial Cleanser 16 oz?");
});

test("after the payment: placed is texted, the mail is watched for the confirmation, the model is woken when it lands, and the watch is bounded", async () => {
  q("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'visa', '4242', ?)").run(OMARI, clock.now());
  const out = await start();
  runs[out.runId].requiredAction = PAY("req_pay_1");
  await shop.step(out.runId);
  const pay = q("SELECT * FROM shop_payments WHERE run_id = ?").get(out.runId);
  assert.equal((await shop.payApproved({ conversationId: OMARI, paymentId: pay.id, confirmationId: 1 })).ok, true);
  const r = row(out.runId);
  assert.equal(r.stage, "paid");
  assert.ok(r.paid_at && r.mail_until === r.paid_at + shop.MAIL_WATCH_MS);
  // Placed.
  runs[out.runId] = { status: "succeeded", result: { code: "ok", orderNumber: "ULTA-1234567" }, revision: 12 };
  await shop.step(out.runId);
  assert.equal(row(out.runId).stage, "placed");
  assert.equal(row(out.runId).order_ref, "ULTA-1234567");
  assert.equal(said.at(-1).t, "Ulta placed the order for CeraVe Foaming Facial Cleanser 16 oz (order ULTA-1234567). Check your email for Ulta's confirmation; I can't see your mail, so the order number and delivery date will be there.");
  // The mail: nothing yet, then the confirmation.
  const asked = [];
  shop._setMail(async (c, { host, since }) => { asked.push({ c, host, since }); return { ok: true, connected: true, hits: asked.length < 2 ? [] : [{ account: "omari@gmail.com", thread_id: "t_9", message_id: "m_9", subject: "Your Ulta order ULTA-1234567 is confirmed", from: "Ulta Beauty <orders@ulta.com>", date: "Sat, 31 Oct 2026 11:40:00 -0400" }] }; });
  let m = await shop.checkMail(out.runId);
  assert.equal(m.done, false);
  assert.deepEqual(asked[0], { c: OMARI, host: "ulta.com", since: r.paid_at - 60_000 });
  m = await shop.checkMail(out.runId);
  assert.equal(m.hits, 1);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].key, `shop:${out.runId}:mail:m_9`);
  assert.match(woke[0].t, /^\[checkout\] Mail from Ulta arrived after the order for CeraVe Foaming Facial Cleanser 16 oz \(run run_1\): "Your Ulta order ULTA-1234567 is confirmed" from Ulta Beauty <orders@ulta\.com> \(Sat, 31 Oct 2026 11:40:00 -0400; account omari@gmail\.com, thread_id t_9\)\. Read it with gmail_read/);
  assert.match(woke[0].t, /say exactly NO_REPLY/);
  // The same mail again wakes nobody; the watch stays open for a later one (the first mail from a store
  // can be "rate your visit", and the model is the one that reads which it is).
  assert.equal((await shop.checkMail(out.runId)).done, false);
  assert.equal(woke.length, 1);
  shop._setMail(async () => ({ ok: true, connected: true, hits: [{ account: "omari@gmail.com", thread_id: "t_10", message_id: "m_10", subject: "Your Ulta order has shipped", from: "Ulta <orders@ulta.com>", date: "Sun, 1 Nov 2026 09:00:00 -0400" }] }));
  assert.equal((await shop.checkMail(out.runId)).hits, 1);
  assert.equal(woke.length, 2);
  assert.equal(woke[1].key, `shop:${out.runId}:mail:m_10`);
  // Placed, and the day ends with no more mail: nothing alarming is said.
  clock.skip(25 * 3600_000);
  const n = said.length;
  assert.equal((await shop.checkMail(out.runId)).expired, true);
  assert.equal(said.length, n, "a placed order with no further mail is not an alarm");
  assert.equal((await shop.checkMail(out.runId)).done, true);
  clock.reset();

  // Bounded: paid, never placed, a day with nothing → said once, and the watch ends.
  const late = await start();
  runs[late.runId].requiredAction = PAY("req_pay_2");
  await shop.step(late.runId);
  const pay2 = q("SELECT * FROM shop_payments WHERE run_id = ?").get(late.runId);
  await shop.payApproved({ conversationId: OMARI, paymentId: pay2.id, confirmationId: 2 });
  shop._setMail(async () => ({ ok: true, connected: true, hits: [] }));
  clock.skip(25 * 3600_000);
  const over = await shop.checkMail(late.runId);
  assert.equal(over.expired, true);
  assert.equal(said.at(-1).t, "No confirmation email from Ulta in the 24 hours since the payment. Check Ulta's site or your card for the charge, and tell me what you see; I'll take it from there.");
  // No mail connected: the watch ends quietly.
  const nomail = await start();
  q("UPDATE shop_runs SET paid_at = ?, mail_until = ? WHERE run_id = ?").run(clock.now(), clock.now() + 3600_000, nomail.runId);
  shop._setMail(async () => ({ ok: true, connected: false, hits: [] }));
  assert.equal((await shop.checkMail(nomail.runId)).connected, false);
  assert.equal((await shop.checkMail(nomail.runId)).done, true);
});

test("a restart resumes every open run and every open mail watch", async () => {
  const open = await start();
  const paid = await start();
  q("UPDATE shop_runs SET status = 'succeeded', stage = 'placed', paid_at = ?, mail_until = ? WHERE run_id = ?").run(clock.now(), clock.now() + 3600_000, paid.runId);
  const over = await start();
  q("UPDATE shop_runs SET status = 'failed', stage = 'failed' WHERE run_id = ?").run(over.runId);
  const done = await start();
  q("UPDATE shop_runs SET status = 'succeeded', stage = 'placed', mail_until = ?, told = 'end,mail' WHERE run_id = ?").run(clock.now() + 3600_000, done.runId);
  const resumed = shop.resumeFollowing();
  assert.deepEqual(resumed.runs, [open.runId]);
  assert.deepEqual(resumed.mail, [paid.runId]);
  // The followed run is looked at on the next tick.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((c) => c.path === `/api/unstable/agent-checkouts/${open.runId}` && c.method === "GET"));
  assert.equal(row(open.runId).stage, "in_progress");
});
