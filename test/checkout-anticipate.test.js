// Anticipating the checkout's form (src/shipping.js, src/shopconnect.js step/answerRun, src/offers.js),
// pinned to 2026-10-31 12:16 ET. Ulta's guest checkout for the owner's CeraVe reached the shipping form
// and Reason texted "Ulta's checkout is at shipping and needs your address. Send me your last name, street
// address, city and zip (apt # too if you have one) in the next 10 min, or it times out." — while his
// address sat in the Walmart run's instruction, in his facts and in his account. He typed it; the model
// sent "NY" into a dropdown whose values are "option-N"; Crossmint refused twice; Reason offered him the
// store's page to buy it himself. His rule: if Reason knows it, it at most asks to confirm. What these hold:
//   1. The record is read out of what is already stored (prior checkout instructions, facts, the account,
//      the connected Gmail); a typed answer wins over it; an address without a ZIP is not trusted.
//   2. The exact live form (Ulta, 12:15) with a known address is answered by code — no question, one line
//      saying where it ships — and the dropdown gets the option's value.
//   3. One unknown field (email) → the model is woken naming only that; shop_answer with only that key
//      merges the rest; the record learns it; the next form is answered whole.
//   4. A correction after the auto-answer fixes the record and starts the checkout over; the old run's
//      payment is declined quietly.
//   5. The "buy it yourself" hedge and its link are dropped while a run is theirs; the note names the card
//      on file; the 400's reason comes back.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-checkout-anticipate-"));
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

const shipping = await import("../src/shipping.js");
const shop = await import("../src/shopconnect.js");
const offers = await import("../src/offers.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const ULTA = "https://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=2541605";

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, nextRun, refuseAnswer;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1, task: body.request.task };
    return reply(201, { runId });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages)?$/.exec(p);
  if (m && m[2]) {
    if (refuseAnswer && body?.parts?.[0]?.action === "submit") return reply(400, { error: true, message: refuseAnswer });
    return reply(202, { ok: true });
  }
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { error: true, message: `Checkout '${m[1]}' not found` });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  return reply(404, { message: "no route" });
}
// Ulta's live form at 12:15:58 ET, 2026-10-31 (run 6f457e81…): keys, kinds and the state dropdown as Crossmint sent them.
const STATE_OPTIONS = [{ value: "option-1", label: "Select state", disabled: false, selected: true, placeholder: true },
  { value: "option-2", label: "AA - Military/Washington" }, { value: "option-3", label: "AE - Military/New York" }, { value: "option-4", label: "AK - Alaska" },
  { value: "option-5", label: "AL - Alabama" }, { value: "option-33", label: "NY - New York" }, { value: "option-50", label: "WA - Washington" }];
const LIVE_ULTA_FORM = (requestId, { phoneRequired = false } = {}) => ({
  requestId, request: {
    question: "I'm at Ulta's guest checkout with one CeraVe Foaming Facial Cleanser (16 oz, $18.99; estimated total $25.94). I don't have an address on file, so please give me the shipping details:",
    expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
    interaction: { kind: "form", fields: [
      { key: "first_name", label: "First name", handling: "standard", input: { kind: "text", autoComplete: "given-name" }, required: true },
      { key: "last_name", label: "Last name", handling: "standard", input: { kind: "text", autoComplete: "family-name" }, required: true },
      { key: "address1", label: "Street address", handling: "standard", input: { kind: "text" }, required: true },
      { key: "city", label: "City", handling: "standard", input: { kind: "text" }, required: true },
      { key: "state", label: "State", handling: "standard", input: { kind: "choice", selection: { kind: "one" }, options: STATE_OPTIONS }, required: true },
      { key: "zip", label: "ZIP code", handling: "standard", input: { kind: "text", autoComplete: "postal-code" }, required: true },
      { key: "email", label: "Email", handling: "standard", input: { kind: "text", autoComplete: "email" }, required: true },
      { key: "phone", label: "Phone", handling: "standard", input: { kind: "text", autoComplete: "tel" }, required: phoneRequired },
    ] },
  },
});
const SIZE_FORM = (requestId) => ({ requestId, request: { question: "Which size?", expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
  interaction: { kind: "form", fields: [{ key: "size", label: "Size", handling: "standard", input: { kind: "choice", options: [{ value: "s", label: "Small" }, { value: "l", label: "Large" }] }, required: true }] } } });
const PAY = (requestId) => ({ requestId, request: { question: "Please approve a card payment of $25.94 to Ulta.", expiresAt: new Date(clock.now() + 10 * 60_000).toISOString(),
  interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value: "25.94", currency: "USD" }, merchant: { name: "Ulta", countryCode: "US", url: "https://www.ulta.com" } } } });

const said = [];
const woke = [];
const q = (sql) => db.db.prepare(sql);
const FULL = { first_name: "Omari", last_name: "Nyarko", address1: "3247 Bruner Ave", address2: "Apt 1", city: "Bronx", state: "NY", zip: "10469", phone: "7183062726", email: "omari@example.com" };
before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; refuseAnswer = null; said.length = 0; woke.length = 0; clock.reset(); shop._setMail(null);
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "shop_shipping", "person_facts", "people", "oauth_tokens"]) db.db.exec(`DELETE FROM ${t}`);
});
const start = (what = "One CeraVe Foaming Facial Cleanser, 16 oz, shipped to the address on file.") => shop.startCheckout({ conversationId: OMARI, store: "ulta", startUrl: ULTA, what, item: "CeraVe Foaming Facial Cleanser 16 oz", maxUsd: 40 });
const row = (runId) => q("SELECT * FROM shop_runs WHERE run_id = ?").get(runId);
const posted = (runId) => calls.filter((c) => c.path === `/api/unstable/agent-checkouts/${runId}/messages` && c.body?.parts?.[0]?.action === "submit").map((c) => c.body.parts[0]);

// ---------------------------------------------------------------- 1. the record
test("an address is read out of a checkout instruction, a typed reply and a fact; one without a ZIP is not trusted", () => {
  const a = shipping.parseAddress("One CeraVe Oil Control Foaming Facial Cleanser, 16 oz, shipped to Omari Nyarko, 3247 Bruner Ave, Apt 1, Bronx, NY 10469. Guest checkout, standard shipping.");
  assert.deepEqual({ ...a, span: undefined }, { address1: "3247 Bruner Ave", address2: "Apt 1", city: "Bronx", state: "NY", zip: "10469", first_name: "Omari", last_name: "Nyarko", span: undefined });
  // What he typed at 12:17: no state, apartment after the ZIP, one name word.
  const b = shipping.parseAddress("Nyarko, 3247 Bruner Ave, Bronx 10469 apt1");
  assert.equal(b.state, "NY"); assert.equal(b.address2, "Apt 1"); assert.equal(b.city, "Bronx"); assert.equal(b.name_word, "Nyarko");
  const c = shipping.parseAddress("Confirmed the CeraVe Walmart order should ship to 3247 Bruner Ave, Bronx 10469, apartment one");
  assert.equal(c.address2, "Apt 1"); assert.equal(c.zip, "10469");
  assert.equal(shipping.parseAddress("Lives at 3247 Brauna Avenue (home address, per voice note transcript)"), null);
  assert.equal(shipping.phoneIn("Confirmed the delivery phone number for the CeraVe order is 718-306-2726"), "7183062726");
  // The dropdown: the option's value, by code or name; placeholders never; a non-state never.
  assert.equal(shipping.matchOption(STATE_OPTIONS, "NY"), "option-33");
  assert.equal(shipping.matchOption(STATE_OPTIONS, "New York"), "option-33");
  assert.equal(shipping.matchOption(STATE_OPTIONS, "ny"), "option-33");
  assert.equal(shipping.matchOption(STATE_OPTIONS, "Select state"), null);
  assert.equal(shipping.matchOption(STATE_OPTIONS, "Ontario"), null);
});

test("the record is gathered from what is stored: the earlier run's instruction, the delivery-phone fact, the account's name, the default Gmail; a typed answer is never overwritten", async () => {
  // The live sources on 2026-10-31, as rows.
  const now = clock.now();
  q("INSERT INTO shop_runs (run_id, conversation_id, store, item, mode, status, created_at, updated_at) VALUES ('c551ca0c', ?, 'walmart', 'CeraVe', 'guest', 'failed', ?, ?)").run(OMARI, now - 86_400_000, now - 86_400_000);
  q("INSERT INTO shop_run_asks (run_id, start_url, what, max_usd) VALUES ('c551ca0c', 'https://www.walmart.com/ip/1', '1 CeraVe Foaming Facial Cleanser, 16 fl oz, delivered to Omari, 3247 Bruner Ave Apt 1, Bronx, NY 10469', 30)").run();
  q("INSERT INTO people (conversation_id, name, key, created_at, updated_at) VALUES (?, 'Omari', 'omari', ?, ?)").run(OMARI, now, now);
  const pid = q("SELECT id FROM people WHERE key = 'omari'").get().id;
  for (const f of ["Confirmed the delivery phone number for the CeraVe order is 718-306-2726", "Lives at 3247 Brauna Avenue (home address, per voice note transcript)", "Has two email accounts: omariij16@gmail.com and omariij25@gmail.com"]) {
    q("INSERT INTO person_facts (person_id, fact, created_at) VALUES (?, ?, ?)").run(pid, f, now);
  }
  db.saveOauthToken?.(OMARI, "google", { access_token: "a", refresh_token: "r", scope: "", expires_at: null, account_label: "omariij16@gmail.com" });
  if (!db.listOauthTokens(OMARI, "google").length) q("INSERT INTO oauth_tokens (conversation_id, provider, access_token, refresh_token, account_label, connected_at, is_default) VALUES (?, 'google', 'a', 'r', 'omariij16@gmail.com', ?, 1)").run(OMARI, now);
  else q("UPDATE oauth_tokens SET is_default = 1 WHERE conversation_id = ?").run(OMARI);
  const p = shipping.profileFor(OMARI);
  assert.equal(p.first_name, "Omari");
  assert.equal(p.last_name, "", "one name word that is the first name already known is not a last name");
  assert.equal(p.address1, "3247 Bruner Ave"); assert.equal(p.address2, "Apt 1"); assert.equal(p.city, "Bronx"); assert.equal(p.state, "NY"); assert.equal(p.zip, "10469");
  assert.equal(p.phone, "7183062726");
  assert.equal(p.email, "omariij16@gmail.com");
  assert.equal(shipping.complete(p), false);
  assert.deepEqual(shipping.missingOf(p), ["last_name"]);
  // He types his last name once: kept. Then a later gather never writes over a typed value.
  shipping.learnFromAnswers(OMARI, { fields: [{ key: "last_name", label: "Last name", input: { kind: "text" } }] }, { last_name: "Nyarko" });
  assert.equal(shipping.profileFor(OMARI).last_name, "Nyarko");
  q("UPDATE shop_run_asks SET what = 'Cleanser, shipped to Kofi Mensah, 1 Other St, Bronx, NY 10469'").run();
  shipping.gather(OMARI);
  assert.equal(shipping.profileRow(OMARI).last_name, "Nyarko");
  assert.equal(shipping.profileRow(OMARI).address1, "3247 Bruner Ave");
});

// ---------------------------------------------------------------- 2. the form, answered without asking
test("pinned 12:15: Ulta's exact shipping form with the address on record is answered by code — no question, no wake, one line saying where it ships; the state dropdown gets the option's value", async () => {
  shipping.learn(OMARI, FULL, { source: "answer" });
  const out = await start();
  assert.ok(out.ok);
  // The instruction carried the address, so Crossmint has it before any form.
  assert.match(runs[out.runId].task, /Ship to Omari Nyarko, 3247 Bruner Ave, Apt 1, Bronx, NY 10469\./);
  runs[out.runId].requiredAction = LIVE_ULTA_FORM("req_56506045");
  runs[out.runId].revision = 2;
  const s = await shop.step(out.runId);
  assert.equal(s.answered, "req_56506045");
  assert.equal(woke.length, 0, "the model is not woken for a form the record covers");
  const p = posted(out.runId);
  assert.equal(p.length, 1);
  assert.equal(p[0].requestId, "req_56506045");
  assert.deepEqual(p[0].response.answers, { first_name: "Omari", last_name: "Nyarko", address1: "3247 Bruner Ave", city: "Bronx", state: "option-33", zip: "10469", email: "omari@example.com", phone: "718-306-2726" });
  assert.equal(row(out.runId).stage, "in_progress");
  assert.equal(said.length, 1);
  assert.equal(said[0].t, "Shipping to 3247 Bruner Ave Apt 1, Bronx, as you gave it to me before. Say if that's wrong.");
  assert.doesNotMatch(said[0].t, /\?|10 min|times out|send me/i);
  // The same request on the next look: nothing more.
  await shop.step(out.runId);
  assert.equal(posted(out.runId).length, 1); assert.equal(said.length, 1);
  // The second time it is "the usual".
  const out2 = await start();
  runs[out2.runId].requiredAction = LIVE_ULTA_FORM("req_2"); runs[out2.runId].revision = 2;
  await shop.step(out2.runId);
  assert.equal(said[1].t, "Shipping to 3247 Bruner Ave Apt 1, Bronx, the usual. Say if that's wrong.");
  // The payment that follows is the itemless ask with the card's total, as before; never "do you have a card".
  runs[out2.runId].requiredAction = PAY("req_pay"); runs[out2.runId].revision = 3;
  await shop.step(out2.runId);
  assert.match(said[2].t, /\$25\.94/);
  assert.doesNotMatch(said[2].t, /have a card/i);
});

test("a form that is not shipping (a size) still goes to the model, as before", async () => {
  shipping.learn(OMARI, FULL, { source: "answer" });
  const out = await start();
  runs[out.runId].requiredAction = SIZE_FORM("req_size"); runs[out.runId].revision = 2;
  const s = await shop.step(out.runId);
  assert.equal(s.woke, "req_size");
  assert.equal(posted(out.runId).length, 0);
  assert.equal(said.length, 0);
  assert.match(woke[0].t, /Still needed, and the ONLY thing to ask for: size \(Size\)/);
});

// ---------------------------------------------------------------- 3. one unknown field
test("pinned: with everything but the email on record, the model is woken naming only the email, with the deadline as a clock time; shop_answer with only the email merges the rest; the record learns it; the next form is answered whole", async () => {
  const { email, ...rest } = FULL;
  shipping.learn(OMARI, rest, { source: "answer" });
  const out = await start();
  runs[out.runId].requiredAction = LIVE_ULTA_FORM("req_1"); runs[out.runId].revision = 2;
  const s = await shop.step(out.runId);
  assert.equal(s.woke, "req_1");
  assert.equal(posted(out.runId).length, 0, "nothing posted while a required field is unknown");
  assert.equal(said.length, 0);
  assert.equal(woke.length, 1);
  assert.match(woke[0].t, /Filled from their record already \(do not ask for these\): first name, last name, street, city, state, zip and phone\./);
  assert.match(woke[0].t, /Still needed, and the ONLY thing to ask for: email \(Email\)\. shop_answer needs only those keys/);
  assert.match(woke[0].t, /Ulta holds the cart until \d{1,2}:\d{2} [AP]M; say that as the time, never as a countdown or "or it times out"/);
  assert.doesNotMatch(woke[0].t, /expires in \d+ minutes/);
  // The record's own line says the same.
  assert.match(shop.stageLine(row(out.runId)), /still needed from them: Email \(the rest is on record\)/);
  assert.match(shop.checkoutNote(OMARI), /still needed from them: Email/);
  // The model answers with only what was missing.
  const ok = await runTool("shop_answer", { run_id: out.runId, answers: { email: "omari@example.com" } }, { conversationId: OMARI });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.from_them, ["email"]);
  assert.deepEqual(ok.from_record.sort(), ["address1", "city", "first_name", "last_name", "phone", "state", "zip"]);
  const p = posted(out.runId);
  assert.equal(p.length, 1);
  assert.equal(p[0].response.answers.state, "option-33");
  assert.equal(p[0].response.answers.email, "omari@example.com");
  assert.equal(row(out.runId).stage, "in_progress");
  assert.equal(shipping.profileRow(OMARI).email, "omari@example.com");
  // Next time: whole, by code.
  const out2 = await start();
  runs[out2.runId].requiredAction = LIVE_ULTA_FORM("req_2"); runs[out2.runId].revision = 2;
  await shop.step(out2.runId);
  assert.equal(woke.length, 1);
  assert.equal(posted(out2.runId).length, 1);
  assert.match(said[0].t, /^Shipping to 3247 Bruner Ave Apt 1, Bronx/);
});

test("the model's 'NY' into the dropdown becomes the option's value; a refusal carries Crossmint's reason back", async () => {
  const out = await start();
  runs[out.runId].requiredAction = LIVE_ULTA_FORM("req_1"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(woke.length, 1, "nothing on record but the account's first name: the model is asked");
  assert.match(woke[0].t, /Filled from their record already \(do not ask for these\): first name\./);
  assert.match(woke[0].t, /Still needed, and the ONLY thing to ask for: last_name \(Last name\), address1 \(Street address\), city \(City\), state \(State\), zip \(ZIP code\), email \(Email\)\./);
  const answers = { first_name: "Omari", last_name: "Nyarko", address1: "3247 Bruner Ave", city: "Bronx", state: "NY", zip: "10469", email: "omari@example.com" };
  refuseAnswer = "Invalid answer for field 'state': expected one of the option values";
  const no = await runTool("shop_answer", { run_id: out.runId, answers }, { conversationId: OMARI });
  assert.equal(no.ok, false);
  assert.equal(no.error, "crossmint_refused");
  assert.equal(no.status, 400);
  assert.match(no.detail, /Invalid answer for field 'state'/);
  assert.equal(row(out.runId).stage, "needs_input", "refused: still waiting");
  refuseAnswer = null;
  const ok = await runTool("shop_answer", { run_id: out.runId, answers }, { conversationId: OMARI });
  assert.equal(ok.ok, true);
  const p = posted(out.runId).at(-1);
  assert.equal(p.response.answers.state, "option-33", "the words became the option");
  // What he typed is the record now, state included.
  const r = shipping.profileRow(OMARI);
  assert.equal(r.last_name, "Nyarko"); assert.equal(r.state, "NY"); assert.equal(r.zip, "10469"); assert.equal(r.email, "omari@example.com");
});

// ---------------------------------------------------------------- 4. a correction
test("'that's wrong' after the auto-answer: the record is corrected, the checkout starts over with it, and the old run's payment is declined without a word", async () => {
  shipping.learn(OMARI, FULL, { source: "answer" });
  const out = await start("One CeraVe Foaming Facial Cleanser, 16 oz, shipped to Omari Nyarko, 3247 Bruner Ave, Apt 1, Bronx, NY 10469.");
  runs[out.runId].requiredAction = LIVE_ULTA_FORM("req_1"); runs[out.runId].revision = 2;
  await shop.step(out.runId);
  assert.equal(said.length, 1);
  const fix = await runTool("shop_answer", { run_id: out.runId, answers: { address1: "3249 Bruner Ave" } }, { conversationId: OMARI });
  assert.equal(fix.ok, true, JSON.stringify(fix));
  assert.equal(fix.superseded, out.runId);
  assert.notEqual(fix.run_id, out.runId);
  assert.match(fix.say, /now 3249 Bruner Ave Apt 1, Bronx/);
  assert.equal(shipping.profileRow(OMARI).address1, "3249 Bruner Ave");
  // The new run's instruction carries the corrected address; the old one's is not what Crossmint was told again.
  assert.match(runs[fix.run_id].task, /Omari Nyarko, 3249 Bruner Ave, Apt 1, Bronx, NY 10469/);
  assert.doesNotMatch(runs[fix.run_id].task, /3247/);
  // The old run asks for payment: declined, no text, over.
  runs[out.runId].requiredAction = PAY("req_pay_old"); runs[out.runId].revision = 3;
  const s = await shop.step(out.runId);
  assert.equal(s.done, true);
  assert.equal(row(out.runId).status, "cancelled");
  assert.ok(calls.some((c) => c.path === `/api/unstable/agent-checkouts/${out.runId}/messages` && c.body.parts[0].action === "decline"));
  assert.equal(said.length, 1, "nothing said about the superseded run");
  // Its end, when Crossmint reports it, is not texted either.
  runs[out.runId] = { status: "cancelled", requiredAction: null, revision: 4 };
  await shop.step(out.runId);
  assert.equal(said.length, 1);
  // The new run's form is answered from the corrected record.
  runs[fix.run_id].requiredAction = LIVE_ULTA_FORM("req_new"); runs[fix.run_id].revision = 2;
  await shop.step(fix.run_id);
  assert.equal(posted(fix.run_id)[0].response.answers.address1, "3249 Bruner Ave");
});

// ---------------------------------------------------------------- 5. the words around it
test("pinned 12:17: 'Here's the page if you'd rather just buy it yourself' and the bare link under it are dropped while a checkout of theirs is open; left alone with none", async () => {
  const text = "Ulta refused your address both times I sent it, so the checkout is stuck there. Nothing was ordered and nothing was charged.\nHere's the page if you'd rather just buy it yourself:\nhttps://www.ulta.com/p/foaming-facial-cleanser-xlsImpprod5140065?sku=2541605\nOr I can try Amazon instead.";
  assert.equal(offers.guardReply(OMARI, text).text, text, "no run: not Reason's to drop");
  await start();
  const g = offers.guardReply(OMARI, text);
  assert.equal(g.text, "Ulta refused your address both times I sent it, so the checkout is stuck there. Nothing was ordered and nothing was charged.\nOr I can try Amazon instead.");
  assert.ok(g.flags.some((f) => f.rule === "self_buy_hedge"));
  for (const s of ["If you'd rather buy it yourself, the page is https://www.ulta.com/p/x.", "You can finish it yourself here if you want: https://www.ulta.com/p/x"]) {
    const t = offers.guardReply(OMARI, s).text;
    assert.doesNotMatch(t, /yourself/, s);
  }
  // Not a hedge: a plain link to what was bought, or a question about something else.
  const fine = "Ulta placed the order. Here's the product page for reference:\nhttps://www.ulta.com/p/x";
  assert.equal(offers.guardReply(OMARI, fine).text, fine);
});

test("the turn note names the card on file and says never to ask whether they have one, and that a started checkout is Reason's to finish", async () => {
  await start();
  assert.match(shop.checkoutNote(OMARI), /never offer them the store's page to buy it themselves/);
  assert.doesNotMatch(shop.checkoutNote(OMARI), /Card on file/);
  q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at) VALUES (?, 'pm_1', 'mastercard', '1929', ?)").run(OMARI, clock.now());
  assert.match(shop.checkoutNote(OMARI), /Card on file for paying: Mastercard ••••1929\. Never ask whether they have a card/);
});
