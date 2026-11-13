// Account jobs (src/accountjobs.js, src/accountjobtools.js, the hooks in src/shopconnect.js): a
// subscription cancelled and a bill paid inside the person's own account, through Crossmint's Agent
// Checkouts. Every run state here is built to Crossmint's DOCUMENTED shapes (docs.crossmint.com
// agents/checkouts/statuses, buyer-inputs, payments, use-cases/manage-subscriptions and the
// agent-checkouts API reference, read 2026-11-12): no real cancellation and no real bill has been
// run, and the tests say so where a shape is constructed. A fake Crossmint; no key, no network.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-account-jobs-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TOKEN_KEY = "77".repeat(32);
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_ACCOUNT_JOBS = "owner";
process.env.CROSSMINT_SERVER_KEY = "sk_test_server";
process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
process.env.CROSSMINT_API_BASE = "https://cm.test";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });

const shop = await import("../src/shopconnect.js");
const jobs = await import("../src/accountjobs.js");
const jt = await import("../src/accountjobtools.js");
const offers = await import("../src/offers.js");
const trust = await import("../src/trust.js");
const { runTool, toolsFor } = await import("../src/tools.js");
const { sealTravelers } = await import("../src/privacy.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
await shop.acctReady;

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const q = (sql) => db.db.prepare(sql);

// ---------------------------------------------------------------- a fake Crossmint
let calls, runs, nextRun;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? "GET", path: u.pathname, body, headers: init.headers ?? {} });
  const p = u.pathname;
  if (p === "/api/unstable/agent-checkouts/browser-profiles" && init.method === "POST") return reply(201, { id: "7c3b1f2a-9d54-4e80-b1a6-2f0c8e5d4a31", label: body.label, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" });
  if (p === "/api/unstable/agent-checkouts" && init.method === "POST") {
    // The create schema's own amount pattern (api-reference/agent-checkouts/create-agent-checkout): zero is refused.
    if (!/^(?:0\.(?=\d*[1-9])\d{1,6}|[1-9]\d{0,14}(?:\.\d{1,6})?)$/.test(body.constraints?.maxCost?.amount ?? "")) return reply(400, { message: "Invalid arguments" });
    const runId = `run_${nextRun++}`;
    runs[runId] = { status: "running", requiredAction: null, revision: 1 };
    return reply(202, { runId, status: "queued" });
  }
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)(\/messages|\/cancel)?$/.exec(p);
  if (m && m[2]) return reply(202, { ok: true });
  if (m) return runs[m[1]] ? reply(200, { runId: m[1], ...runs[m[1]] }) : reply(404, { message: "not found" });
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}`, status: "active" });
  if (/^\/api\/unstable\/order-intents\/[^/]+$/.test(p)) return reply(200, { orderIntentId: decodeURIComponent(p.split("/").pop()), status: "active", rails: [{ rail: "encrypted-card", status: "active", credentialFormats: ["card"] }] });
  return reply(404, { message: "no route" });
}
const soon = () => new Date(clock.now() + 10 * 60_000).toISOString();
/** A question as the checkout sends one: requiredAction on the run (documented shape). */
const ask = (runId, requestId, question, fields) => { runs[runId] = { status: "awaiting_input", revision: (runs[runId]?.revision ?? 1) + 1, requiredAction: { type: "input_response", messageId: `msg_${requestId}`, requestId, request: { question, expiresAt: soon(), interaction: { kind: "form", fields } } } }; };
const payAsk = (runId, requestId, value, name = "Con Edison") => { runs[runId] = { status: "awaiting_input", revision: (runs[runId]?.revision ?? 1) + 1, requiredAction: { type: "input_response", messageId: `msg_${requestId}`, requestId, request: { question: `Authorize a card payment of ${value} USD at coned.com.`, expiresAt: soon(), interaction: { kind: "payment", purpose: "checkout_payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { url: "https://www.coned.com", name, countryCode: "US" } } } } }; };
const end = (runId, body) => { runs[runId] = { requiredAction: null, revision: (runs[runId]?.revision ?? 1) + 1, ...body }; };
const working = (runId) => { runs[runId] = { status: "running", requiredAction: null, revision: (runs[runId]?.revision ?? 1) + 1 }; };
const EMAIL = { key: "email", label: "Email", required: true, handling: "standard", input: { kind: "text", autoComplete: "email" } };
const PASSWORD = { key: "password", label: "Password", required: true, handling: "protected", input: { kind: "text", display: "masked", autoComplete: "current-password" } };
const CODE_OPEN = { key: "code", label: "Verification code", required: true, handling: "standard", input: { kind: "text", inputMode: "numeric", autoComplete: "one-time-code" } };
const CODE_SEALED = { ...CODE_OPEN, handling: "protected" };
const CONFIRM = { key: "confirm", label: "Cancel Cardboard Starter?", required: true, handling: "standard", input: { kind: "choice", selection: { kind: "one" }, options: [{ value: "yes", label: "Yes, cancel my plan" }, { value: "no", label: "Keep my plan" }] } };
const CONFIRM_Q = "CONFIRM CANCELLATION: Cardboard Starter, $12.00 per month. Your access ends Nov 27, 2026. Cancel it?";
const CANCELLED = { status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "nothing_placed" }, summary: "The Cardboard Starter subscription is cancelled. Access ends Nov 27, 2026.\nRESULT: CANCELLED" } };

const said = [], woke = [], lines = [];
let messages, mailbox, codeCalls;
const owner = (t) => ({ role: "user", content: "[Thu, Nov 12, 2026, 11:30 PM] Omari: " + t });
const say = (t, c = OMARI) => { messages = [...(messages ?? []), owner(t)]; offers.beginTurn(c, t, "user"); };
const call = (name, input, c = OMARI) => runTool(name, input, { conversationId: c, messages, judge: async () => ({ verdict: "yes" }) });
const names = (c) => toolsFor(c).map((t) => t.name);
const lastSaid = () => said.at(-1)?.t ?? "";
const posted = () => calls.filter((c) => c.path.endsWith("/messages")).map((c) => c.body.parts[0]);
const mail = (subject, from = "Cardboard <billing@cardboard.app>", auth = "mx.google.com; dkim=pass header.i=@cardboard.app") => ({ from, subject, auth: [auth], snippet: "", at: clock.now() });
const googleOn = (c = OMARI) => db.saveOauthTokens(c, "google", { accessToken: "t", refreshToken: "r", scope: "https://www.googleapis.com/auth/gmail.modify", accountLabel: "omari@example.com" });

before(() => {
  shop._setFetch(fakeFetch);
  shop.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }), base: "https://heyreason.test/web/connect" });
  jobs.attach({ say: (c, t) => said.push({ c, t }), wake: (c, t, { key }) => woke.push({ c, t, key }) });
  jobs.setSink((line) => lines.push(JSON.parse(line)));
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "test", address: "+13475550000", name: "Ama" });
});
after(() => { rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  calls = []; runs = {}; nextRun = 1; said.length = 0; woke.length = 0; lines.length = 0; messages = []; mailbox = { connected: true, hits: [] }; codeCalls = 0;
  clock.reset(); jobs._resetAttempts();
  process.env.REASON_ACCOUNT_JOBS = "owner"; process.env.REASON_SHOP_CONNECT = "on"; process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
  config.maxSpendPerDay = 1000;
  jobs._setMail({ look: async () => ({ ok: true, ...mailbox }), code: async () => { codeCalls++; return { connected: false }; } });
  for (const t of ["shop_profiles", "shop_stores", "shop_runs", "shop_links", "shop_cards", "shop_payments", "shop_sites", "shop_run_asks", "spend", "account_jobs", "oauth_tokens"]) db.db.exec(`DELETE FROM ${t}`);
});

async function cancelStarted(extra = {}) {
  say("cancel my Cardboard Starter subscription");
  const out = await call("account_cancel", { site: "cardboard.app", plan: "Cardboard Starter", name: "Cardboard", ...extra });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}
/** The gate, walked as the model walks it: refused with use_target, asked, their yes, granted, confirmed. */
async function yesThroughTheGate(jobId) {
  const refused = await call("account_cancel_confirm", { job_id: jobId });
  assert.equal(refused.ok, false);
  assert.ok(refused.use_target, JSON.stringify(refused));
  const req = await call("confirm_request", { action: "account_cancel_confirm", summary: "Cancel Cardboard Starter ($12/month)? Access ends Nov 27.", target: refused.use_target });
  assert.ok(req.confirmation_id, JSON.stringify(req));
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");
  return { refused, req, done: await call("account_cancel_confirm", { job_id: jobId, confirmation_id: req.confirmation_id }) };
}
const card = () => q("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', ?, 1)").run(OMARI, clock.now());
const BILL = { biller: "Con Edison", site: "coned.com", amount: 82.1, reference: "Account 44-1234-5678-9", due_date: "Nov 20, 2026" };
async function billStarted(input = BILL) {
  card();
  say("pay my con ed bill");
  const out = await call("account_bill_pay", input);
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------- the switch
test("the switch: off for everyone by default, owner = the owner's conversation only, and off looks like before", () => {
  const NEW = [...jt.ACCOUNT_JOB_TOOLS];
  for (const n of NEW) { assert.ok(names(OMARI).includes(n), n); assert.ok(!names(AMA).includes(n), `${n} for a non-owner`); }
  assert.equal(jobs.jobsAllowedFor(OMARI), true);
  assert.equal(jobs.jobsAllowedFor(AMA), false);
  // Where it is on, the browser-walking cancel route is gone; everybody else keeps it.
  assert.ok(!names(OMARI).includes("subscription_cancel_start") && !names(OMARI).includes("subscription_cancel_commit"));
  assert.ok(names(AMA).includes("subscription_cancel_start") && names(AMA).includes("subscription_cancel_commit"));
  delete process.env.REASON_ACCOUNT_JOBS;
  assert.equal(jobs.jobsMode(), "off");
  for (const n of NEW) assert.ok(!names(OMARI).includes(n), `${n} with the switch off`);
  assert.ok(names(OMARI).includes("subscription_cancel_start"), "off: the tools are today's, exactly");
  process.env.REASON_ACCOUNT_JOBS = "on";
  assert.equal(jobs.jobsAllowedFor(AMA), true);
  // On, but no checkout service for them: nothing to run it on.
  process.env.REASON_SHOP_CONNECT = "off";
  assert.equal(jobs.jobsAllowedFor(OMARI), false);
});

test("switch off or a non-owner: every tool is refused and nothing reaches Crossmint", async () => {
  say("cancel my Cardboard Starter", AMA);
  for (const [n, input] of [["account_cancel", { site: "cardboard.app", plan: "Starter" }], ["account_bill_pay", BILL], ["account_cancel_confirm", { job_id: 1 }], ["account_job_answer", { job_id: 1, answers: { a: "b" } }], ["account_job_status", {}], ["account_job_stop", { job_id: 1 }]]) {
    const out = await call(n, input, AMA);
    assert.equal(out.blocked, "not_available", `${n}: ${JSON.stringify(out)}`);
  }
  delete process.env.REASON_ACCOUNT_JOBS;
  say("cancel my Cardboard Starter");
  assert.equal((await call("account_cancel", { site: "cardboard.app", plan: "Starter" })).blocked, "not_available");
  assert.equal(calls.length, 0);
});

test("a job only starts on their own message", async () => {
  offers.beginTurn(OMARI, "", "event");
  const out = await call("account_cancel", { site: "cardboard.app", plan: "Cardboard Starter" });
  assert.equal(out.blocked, "not_their_turn");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- cancel: the request
test("cancel starts ONE run in their own browser profile, with the smallest cap the API takes and a task that stops before the last step", async () => {
  const out = await cancelStarted({ page: "https://cardboard.app/account/billing" });
  const start = calls.find((c) => c.method === "POST" && c.path === "/api/unstable/agent-checkouts");
  assert.equal(start.body.request.startUrl, "https://cardboard.app/account/billing");
  assert.equal(start.body.browser.profileId, "7c3b1f2a-9d54-4e80-b1a6-2f0c8e5d4a31", "their own profile, so a saved sign-in is used");
  assert.deepEqual(start.body.constraints.maxCost, { amount: jobs.CANCEL_CAP, currency: "USD" });
  assert.ok(Number(jobs.CANCEL_CAP) > 0 && Number(jobs.CANCEL_CAP) < 0.01, "below one cent: no real charge fits under it");
  assert.match(start.body.request.task, /Cancel one subscription in my Cardboard account: "Cardboard Starter"/);
  assert.match(start.body.request.task, /STOP at the last step/);
  assert.match(start.body.request.task, /CONFIRM CANCELLATION:/);
  assert.match(start.body.request.task, /Never pay, never buy/);
  assert.match(start.body.request.task, /RESULT: CANCELLED/);
  assert.equal(start.headers["x-crossmint-user-id"], shop.crossmintUser(OMARI), "scoped to this person at Crossmint");
  assert.equal(shop.runRow(out.run_id).mode, "job_cancel");
  assert.match(out.say, /NOTHING IS CANCELLED YET/);
  assert.match(out.say, /Never offer signin_link/);
});

test("a cap of zero is what the API refuses, which is why the cap is not zero", async () => {
  for (const zero of ["0", "0.00", "0.000000"]) {
    const r = await shop.startJobRun({ conversationId: OMARI, store: "cardboard", startUrl: "https://cardboard.app/", task: "x", cap: zero, kind: "cancel" });
    assert.equal(r.ok, false, zero);
    assert.equal(r.status, 400);
  }
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_runs").get().n, 0);
});

test("a page on another site, a private host, or no plan: nothing starts", async () => {
  say("cancel it");
  assert.equal((await call("account_cancel", { site: "localhost.localdomain.internal", plan: "X" })).error, "needs_site_and_plan");
  assert.equal((await call("account_cancel", { site: "cardboard.app", plan: "  " })).error, "needs_site_and_plan");
  const out = await call("account_cancel", { site: "cardboard.app", plan: "Starter", page: "https://evil.example.net/cancel" });
  assert.equal(calls.find((c) => c.path === "/api/unstable/agent-checkouts").body.request.startUrl, "https://cardboard.app/", "a page off the site is dropped, never opened");
  assert.equal(out.ok, true);
});

// ---------------------------------------------------------------- cancel: the happy path
test("cancel, start to finish: saved sign-in, the last step put to them, their yes through the gate, the page AND the email seen", async () => {
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_confirm");
  assert.equal(woke.length, 1);
  assert.match(woke[0].t, /\[account job\] #\d+ cancel "Cardboard Starter" at Cardboard/);
  assert.match(woke[0].t, /LAST step/);
  assert.match(woke[0].t, /Your access ends Nov 27, 2026/, "the site's own words reach the model, so the line names what and when");
  assert.match(woke[0].t, /NOTHING IS CANCELLED YET/);
  assert.equal(posted().length, 0, "nothing answered before their yes");
  // No yes yet: the confirm tool answers nothing.
  const { refused, done } = await yesThroughTheGate(job_id);
  assert.match(refused.use_target, /acct:cancel #\d+ "Cardboard Starter" at cardboard\.app \[run_1\/req_confirm\]/);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.say, /NOT done yet/);
  assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_confirm", action: "submit", response: { kind: "form", answers: { confirm: "yes" } } });
  assert.equal(jobs.jobRow(OMARI, job_id).state, "confirming");
  // The site's result, and the merchant's own cancellation email.
  mailbox.hits = [mail("Your Cardboard Starter subscription has been cancelled")];
  end(run_id, CANCELLED);
  await shop.step(run_id);
  const job = jobs.jobRow(OMARI, job_id);
  assert.equal(job.state, "done");
  assert.equal(job.outcome, "done");
  assert.equal(job.seen_result, 1); assert.equal(job.seen_mail, 1);
  assert.equal(job.route, "saved_profile");
  assert.equal(job.ends, "Nov 27, 2026");
  assert.equal(lastSaid(), `Done. Cardboard Starter at Cardboard is cancelled; access ends Nov 27, 2026. Seen: Cardboard's page said so, and their cancellation email arrived ("Your Cardboard Starter subscription has been cancelled").`);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_payments").get().n, 0);
  // One attempt record, and nothing personal in it.
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ["account_job", "at", "kind", "ms", "outcome", "route"]);
  assert.deepEqual({ ...lines[0], ms: 0, at: "" }, { account_job: "cardboard.app", kind: "cancel", route: "saved_profile", outcome: "done", ms: 0, at: "" });
  assert.ok(!JSON.stringify(lines[0]).includes("Starter") && !JSON.stringify(lines[0]).includes("dm:"));
});

test("the yes is pinned: a yes for another question, another job, or no yes at all cancels nothing", async () => {
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  const refused = await call("account_cancel_confirm", { job_id });
  // A target typed by hand (a different plan) is a different yes.
  const wrong = await call("confirm_request", { action: "account_cancel_confirm", summary: "Cancel Cardboard Pro?", target: refused.use_target.replace("Starter", "Pro") });
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: wrong.confirmation_id })).state, "granted");
  assert.equal((await call("account_cancel_confirm", { job_id, confirmation_id: wrong.confirmation_id })).blocked, "wrong_target");
  // Asked, not yet answered.
  const req = await call("confirm_request", { action: "account_cancel_confirm", summary: "Cancel Cardboard Starter?", target: refused.use_target });
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "waiting_for_yes");
  assert.equal((await call("account_cancel_confirm", { job_id, confirmation_id: req.confirmation_id })).ok, false);
  assert.equal(posted().length, 0, "nothing went to the site");
  // The plain-answer tool is not a way round the gate.
  const side = await call("account_job_answer", { job_id, answers: { confirm: "yes" } });
  assert.equal(side.error, "needs_the_gate");
  assert.equal(posted().length, 0);
  // A new question (the page moved on) is a new target: the old yes does not reach it.
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");
  ask(run_id, "req_confirm_2", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  assert.equal((await call("account_cancel_confirm", { job_id, confirmation_id: req.confirmation_id })).blocked, "wrong_target");
  assert.equal(posted().length, 0);
});

test("they say no at the last step: the site is told no, the run is ended, nothing is cancelled", async () => {
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  const out = await call("account_job_stop", { job_id });
  assert.equal(out.ok, true);
  assert.match(out.say, /Left as it is: Cardboard Starter at Cardboard is not cancelled\./);
  assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_confirm", action: "decline" });
  assert.ok(calls.some((c) => c.path.endsWith("/run_1/cancel")));
  end(run_id, { status: "cancelled" });
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "declined");
  assert.equal(lastSaid(), "Left as it is: Cardboard Starter at Cardboard is not cancelled.");
});

// ---------------------------------------------------------------- cancel: it can never charge
test("a charge appears: Crossmint's cap blocks it (policy.max_cost_exceeded) and it is said as not done", async () => {
  const { job_id, run_id } = await cancelStarted();
  end(run_id, { status: "blocked", result: { outcome: "blocked", code: "policy.max_cost_exceeded", summary: "Cancelling requires a $15.00 early termination fee, more than the limit." } });
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "refused_by_cap");
  assert.equal(lastSaid(), "Not done: cancelling Cardboard Starter at Cardboard would have cost money, and a cancellation through me can never pay. Nothing was charged. Cardboard Starter is unchanged.");
  assert.equal(lines[0].outcome, "refused_by_cap");
});

test("a payment question on a cancellation is declined and the run ended: no payment row, no ask, nothing to approve", async () => {
  const { job_id, run_id } = await cancelStarted();
  payAsk(run_id, "req_pay", "15.00", "Cardboard");
  await shop.step(run_id);
  assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_pay", action: "decline" });
  assert.ok(calls.some((c) => c.path.endsWith("/run_1/cancel")));
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_payments").get().n, 0, "a cancellation's run never holds a payment row");
  assert.equal(shop.openPayment(OMARI), null);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "payment_asked");
  assert.equal(lastSaid(), "Not done: Cardboard's page asked for a payment ($15.00) before it would cancel Cardboard Starter. I refused it and stopped. Nothing was charged. Cardboard Starter is unchanged.");
  assert.ok(!said.some((s) => /OK to pay|Approve it/.test(s.t)), "no payment ask ever went out");
  // Belt and braces: the shopping pay path itself refuses to record a payment for this run.
  assert.equal(shop.recordPayment({ conversationId: OMARI, runId: run_id, request: runs[run_id].requiredAction, item: "x" }), null);
});

// ---------------------------------------------------------------- sign-in, in order
test("sign-in by emailed code: read from their mail by code, answered without them, and said afterwards in one line", async () => {
  googleOn();
  let asked = null;
  jobs._setMail({ look: async () => ({ ok: true, ...mailbox }), code: async (c, entry, opts) => { asked = { c, entry, opts }; return { connected: true, found: true, kind: "code", code: "481516" }; } });
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_code", "Cardboard emailed a 6-digit code to o•••@example.com. Enter it to sign in.", [EMAIL, CODE_OPEN]);
  await shop.step(run_id);
  assert.equal(asked.c, OMARI);
  assert.equal(asked.entry.signin_url, "https://cardboard.app/", "only that site's own mail is read");
  assert.equal(asked.opts.since, shop.runRow(run_id).created_at, "only mail since this run began");
  assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_code", action: "submit", response: { kind: "form", answers: { email: "omari@example.com", code: "481516" } } });
  assert.equal(woke.length, 0, "nobody was asked");
  assert.equal(said.length, 0);
  assert.equal(jobs.jobRow(OMARI, job_id).route, "emailed_code");
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  assert.equal(said[0].t, "I signed in with the code Cardboard emailed you.", "said once, by code, before the question");
  assert.ok(!/signed in with the code/.test(woke[0].t), "never left to the model");
  await yesThroughTheGate(job_id);
  mailbox.hits = [mail("Cancellation confirmed")];
  end(run_id, CANCELLED);
  await shop.step(run_id);
  assert.equal(lastSaid(), 'Done. Cardboard Starter at Cardboard is cancelled; access ends Nov 27, 2026. Seen: Cardboard\'s page said so, and their cancellation email arrived ("Cancellation confirmed").');
  assert.equal(said.filter((x) => /signed in with the code/.test(x.t)).length, 1, "one line, once");
  assert.equal(lines[0].route, "emailed_code");
  // The code is in no record of the job and no log line.
  assert.ok(!JSON.stringify(q("SELECT * FROM account_jobs").all()).includes("481516"));
  assert.ok(!JSON.stringify(lines).includes("481516"));
});

test("sign-in by emailed link: the link from their mail is handed to the run", async () => {
  googleOn();
  jobs._setMail({ look: async () => ({ ok: true, ...mailbox }), code: async () => ({ connected: true, found: true, kind: "link", url: "https://cardboard.app/auth/magic?token=abc" }) });
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_link", "Cardboard emailed you a sign-in link. Paste the link or the code from the email.", [CODE_OPEN]);
  await shop.step(run_id);
  const part = posted().at(-1);
  assert.equal(part.action, "alternative");
  assert.match(part.text, /https:\/\/cardboard\.app\/auth\/magic\?token=abc/);
  assert.equal(jobs.jobRow(OMARI, job_id).route, "emailed_link");
});

test("a texted code: asked for ONCE in the thread, passed on, never kept", async () => {
  googleOn();
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_sms", "Cardboard texted a code to your phone ending 34. Enter it.", [CODE_OPEN]);
  await shop.step(run_id);
  assert.equal(codeCalls, 0, "a texted code is not looked for in mail");
  assert.equal(woke.length, 1);
  assert.match(woke[0].t, /texted a code to their phone\. Ask them ONCE/);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_code");
  // The same question on the next looks: nobody is asked again.
  await shop.step(run_id); await shop.step(run_id);
  assert.equal(woke.length, 1);
  say("it's 907331");
  const out = await call("account_job_answer", { job_id, answers: { code: "907331" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(posted().at(-1).response.answers, { code: "907331" });
  assert.equal(jobs.jobRow(OMARI, job_id).route, "texted_code");
  assert.ok(!JSON.stringify(q("SELECT * FROM account_jobs").all()).includes("907331"));
  // Sealed on the way into the tool log and the ledger.
  assert.deepEqual(sealTravelers("account_job_answer", { job_id, answers: { code: "907331" } }), { job_id, answers: "[sealed]" });
});

test("an emailed code with no mail connected: asked for once, like a texted one", async () => {
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_code", "We emailed you a code. Enter it to continue.", [CODE_OPEN]);
  await shop.step(run_id);
  assert.equal(codeCalls, 0);
  assert.match(woke[0].t, /emailed them a code, and their mail is not connected so you cannot read it\. Ask them ONCE/);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_code");
});

test("a password: ONE Reason page carrying Crossmint's protected input, texted once; a sealed code after it lands on the same page", async () => {
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_login", "Enter your email and password to sign in.", [EMAIL, PASSWORD]);
  await shop.step(run_id);
  assert.equal(said.length, 1);
  assert.match(said[0].t, /^Cardboard wants you signed in before I can cancel Cardboard Starter\. Sign in once here and it stays signed in for next time\. What you type goes straight to Cardboard, not to me\.\nhttps:\/\/heyreason\.test\/web\/connect\/[A-Za-z0-9_-]{20,}$/);
  assert.equal(woke.length, 0, "the model is never handed a password question");
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_page");
  const token = said[0].t.split("/").pop();
  const view = shop.linkView(shop.linkFor(token));
  assert.equal(view.state, "signin");
  assert.deepEqual(view.request.fields.map((f) => [f.key, f.handling]), [["email", "standard"], ["password", "protected"]]);
  // The page's answer: a typed password is refused; only Crossmint's reference goes through.
  assert.equal((await shop.answerLink(token, { requestId: "req_login", answers: { email: "omari@example.com", password: "hunter2" } })).error, "protected_must_be_reference");
  assert.equal((await shop.answerLink(token, { requestId: "req_login", answers: { email: "omari@example.com", password: { protectedInputId: "pi_123" } } })).ok, true);
  // The model cannot answer it either.
  assert.equal((await call("account_job_answer", { job_id, answers: { password: "hunter2" } })).error, "needs_the_page");
  // A sealed one-time code next: the same page, no second text.
  ask(run_id, "req_otp", "Enter the code Cardboard sent you.", [CODE_SEALED]);
  await shop.step(run_id);
  assert.equal(said.length, 1, "no second link");
  assert.equal(shop.linkView(shop.linkFor(token)).state, "code");
  assert.equal(codeCalls, 0, "a sealed code cannot be answered from mail: only the person's typing into Crossmint's field mints the reference");
  // Signed in: the last step comes, and the store is remembered as connected for next time.
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  await yesThroughTheGate(job_id);
  mailbox.connected = false;
  end(run_id, CANCELLED);
  await shop.step(run_id);
  assert.equal(shop.isConnected(OMARI, "cardboard"), true, "the profile stays signed in: next time nothing is asked");
  assert.equal(lines[0].route, "sign_in_page");
  assert.equal(said.filter((x) => x.t === "You signed in once on the page, and Cardboard stays signed in for next time.").length, 1, "said once, when they were past the sign-in");
});

test("no sign-in route at all: one line and stop (the page is not set up; a password asked for in the open)", async () => {
  delete process.env.CROSSMINT_CLIENT_KEY;
  let { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_login", "Enter your email and password.", [EMAIL, PASSWORD]);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "no_signin_route");
  assert.equal(lastSaid(), "Not done: Cardboard needs a sign-in I have no way to do from here (the sign-in page is not set up). Cardboard Starter is unchanged.");
  assert.ok(calls.some((c) => c.path.endsWith("/run_1/cancel")));
  assert.equal(said.length, 1);
  process.env.CROSSMINT_CLIENT_KEY = "ck_test_client";
  db.db.exec("DELETE FROM account_jobs");
  ({ job_id, run_id } = await cancelStarted());
  ask(run_id, "req_pw", "Type your password.", [{ ...PASSWORD, handling: "standard" }]);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "no_signin_route");
  assert.match(lastSaid(), /it asked for a password in a way I won't pass on/);
  assert.equal(posted().filter((p) => p.action === "submit").length, 0, "an unsealed password is never answered");
});

test("no path makes the picture sign-in link: signin_link is refused for a site a job is on, and the job's module never reaches for it", async () => {
  const { job_id, run_id } = await cancelStarted();
  const held = jt.signinLinkRefusal(OMARI, "https://app.cardboard.app/login");
  assert.equal(held.blocked, "handled_by_account_job");
  assert.equal(held.job_id, job_id);
  const other = jt.signinLinkRefusal(OMARI, "notion.so");
  assert.equal(other.blocked, "handled_by_account_job", "while a job is open no link is made for any site: the job may be signing in on an address that is not the merchant's own");
  assert.match(other.error, /while account job \d+ \(Cardboard\) is still open/);
  // Through the tool itself: refused, no link row, nothing texted.
  say("send me a sign in link for cardboard");
  const tool = await call("signin_link", { site: "cardboard.app" });
  assert.equal(tool.blocked, "handled_by_account_job", JSON.stringify(tool).slice(0, 200));
  assert.equal(said.length, 0, "nothing was texted");
  // The job over: another site is its own business again; the job's own site stays refused for a day.
  end(run_id, { status: "cancelled" });
  await shop.step(run_id);
  assert.equal(jt.signinLinkRefusal(OMARI, "notion.so"), null);
  assert.equal(jt.signinLinkRefusal(OMARI, "cardboard.app").blocked, "handled_by_account_job");
  // Before any job exists: a turn that asks to cancel a subscription or pay a bill never gets a sign-in link.
  db.db.exec("DELETE FROM account_jobs");
  assert.equal(jt.signinLinkRefusal(OMARI, "cardboard.app", { own: "Cancel my Cardboard Starter" }).blocked, "use_account_job");
  assert.equal(jt.signinLinkRefusal(OMARI, "coned.com", { own: "can you pay my con ed bill" }).blocked, "use_account_job");
  assert.equal(jt.signinLinkRefusal(OMARI, "notion.so", { own: "ok", cancelling: true }).blocked, "use_account_job", "a turn where cancel_route ran");
  assert.equal(jt.signinLinkRefusal(OMARI, "resy.com", { own: "cancel my reservation at Carbone" }), null, "a reservation is not a subscription");
  assert.equal(jt.signinLinkRefusal(OMARI, "notion.so", { own: "sign me in to notion" }), null);
  assert.equal(jt.signinLinkRefusal(AMA, "cardboard.app", { own: "Cancel my Cardboard Starter" }), null, "nobody else is affected");
  assert.equal(jt.signinLinkRefusal(AMA, "cardboard.app"), null, "nobody else is affected");
  const src = readFileSync(new URL("../src/accountjobs.js", import.meta.url), "utf8") + readFileSync(new URL("../src/accountjobtools.js", import.meta.url), "utf8");
  for (const never of ["signin-remote", "./signin.js", "socialsignin", "pictures.js", "browser.js", "playwright", "embedUrl"]) assert.ok(!src.includes(`from "${never}`) && !new RegExp(`import[^\\n]*${never.replace(/[.]/g, "\\.")}`).test(src), `${never} is not imported`);
  assert.ok(!/embedUrl/.test(src), "Crossmint's live browser view is never used");
});

// ---------------------------------------------------------------- the merchant blocks the browser, and the other endings
test("the merchant blocks the browser, asks for a human check, or errors: said as not done, each in its own words", async () => {
  const cases = [
    ["merchant.access_blocked", "blocked_browser", "Not done: Cardboard refused the browser I use for this, so I never got to your subscription. Cardboard Starter is unchanged."],
    ["merchant.human_verification_required", "human_check", "Not done: Cardboard put up a human check that I can't pass. Cardboard Starter is unchanged."],
    ["merchant.checkout_error", "site_error", "Not done: Cardboard's site kept showing an error (The page showed an error.). Cardboard Starter is unchanged."],
    ["merchant.no_safe_path", "no_safe_path", "Not done: I found no safe way to cancel Cardboard Starter on Cardboard's site (The page showed an error.). Cardboard Starter is unchanged."],
  ];
  for (const [code, outcome, line] of cases) {
    db.db.exec("DELETE FROM account_jobs"); said.length = 0; lines.length = 0;
    const { job_id, run_id } = await cancelStarted();
    end(run_id, { status: "blocked", result: { outcome: "blocked", code, summary: "The page showed an error." } });
    await shop.step(run_id);
    assert.equal(jobs.jobRow(OMARI, job_id).outcome, outcome, code);
    assert.equal(jobs.jobRow(OMARI, job_id).state, "not_done");
    assert.equal(lastSaid(), line);
    assert.equal(lines.length, 1); assert.equal(lines[0].outcome, outcome);
    assert.equal(said.length, 1, "one line, no offer to loop");
  }
});

test("the site did not confirm, or has no such plan: not done, never 'cancelled'", async () => {
  let { job_id, run_id } = await cancelStarted();
  end(run_id, { status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "nothing_placed" }, summary: "I could not find a Cardboard Starter subscription on this account.\nRESULT: NOT CANCELLED no such subscription" } });
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "not_found");
  assert.match(lastSaid(), /^Not done: I got into the Cardboard account, but there is no "Cardboard Starter" subscription on it/);
  db.db.exec("DELETE FROM account_jobs");
  ({ job_id, run_id } = await cancelStarted());
  end(run_id, { status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "nothing_placed" }, summary: "The cancel button did nothing; the plan is still active." } });
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "not_cancelled");
  assert.match(lastSaid(), /^Not done: Cardboard's page did not confirm the cancellation .* Treat Cardboard Starter as still active\.$/);
});

test("their yes never came, or the run broke: the page timing out is said plainly; a break after their yes is 'not confirmed' and the mail is watched", async () => {
  let { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  end(run_id, { status: "failed", reason: "input_expired" });
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "no_answer");
  assert.equal(lastSaid(), "Not done: Cardboard's page stopped waiting for your yes (it holds that last step about ten minutes). Cardboard Starter is unchanged. Tell me to cancel it again and I'll go straight back.");
  db.db.exec("DELETE FROM account_jobs");
  googleOn();
  ({ job_id, run_id } = await cancelStarted());
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  await yesThroughTheGate(job_id);
  end(run_id, { status: "failed", reason: "reconciliation_required" });
  await shop.step(run_id);
  const job = jobs.jobRow(OMARI, job_id);
  assert.equal(job.outcome, "unconfirmed");
  assert.ok(job.mail_until > clock.now());
  assert.equal(lastSaid(), "Not confirmed: your yes went to Cardboard, then the run broke off before it showed me the result (reconciliation_required). Cardboard Starter may or may not be cancelled. I'm watching your email for Cardboard's cancellation notice and will tell you if it lands.");
});

// ---------------------------------------------------------------- the page said cancelled, the mail has not come
test("the result says cancelled but no mail yet: NOT called done; the mail landing makes it done; a day of nothing is said once", async () => {
  googleOn();
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  await yesThroughTheGate(job_id);
  end(run_id, CANCELLED);
  await shop.step(run_id);
  let job = jobs.jobRow(OMARI, job_id);
  assert.equal(job.state, "not_done");
  assert.equal(job.outcome, "waiting_mail");
  assert.equal(job.seen_result, 1); assert.equal(job.seen_mail, 0);
  assert.equal(lastSaid(), "Not done yet: Cardboard's page says Cardboard Starter is cancelled; access ends Nov 27, 2026, but their cancellation email hasn't arrived. I'm watching your email and will tell you when it lands, or tomorrow if it never does.");
  assert.equal(jobs.statusView(OMARI)[0].line, "their page said it worked; their email has not arrived yet, so not called done");
  // A look with nothing new says nothing.
  const before = said.length;
  assert.deepEqual(await jobs.checkMail(OMARI, job_id), { done: false });
  assert.equal(said.length, before);
  // A marketing mail from them is not the proof; nor is a forged cancellation (no DKIM pass for their domain).
  mailbox.hits = [mail("New: Cardboard Pro is here"), mail("Your subscription has been cancelled", "Cardboard <billing@cardboard.app>", "mx.google.com; dkim=fail header.i=@cardboard.app"), mail("Subscription cancelled", "Cardboard <x@evil.example.net>", "mx.google.com; dkim=pass header.i=@evil.example.net")];
  assert.deepEqual(await jobs.checkMail(OMARI, job_id), { done: false });
  mailbox.hits.push(mail("Your Cardboard Starter subscription was cancelled"));
  assert.equal((await jobs.checkMail(OMARI, job_id)).seen, true);
  job = jobs.jobRow(OMARI, job_id);
  assert.equal(job.state, "done"); assert.equal(job.seen_mail, 1);
  assert.equal(lastSaid(), `Done. Cardboard's cancellation email arrived ("Your Cardboard Starter subscription was cancelled"). Cardboard Starter is cancelled; access ends Nov 27, 2026. Seen: their page and their email.`);
  assert.equal(jobs.statusView(OMARI)[0].line, "done (their page and their email both seen)");
  assert.deepEqual(await jobs.checkMail(OMARI, job_id), { done: true }, "the watch is over; nothing is said twice");

  // The other way: a day goes by.
  db.db.exec("DELETE FROM account_jobs"); mailbox.hits = [];
  const again = await cancelStarted();
  ask(again.run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(again.run_id);
  await yesThroughTheGate(again.job_id);
  end(again.run_id, CANCELLED);
  await shop.step(again.run_id);
  clock.skip(jobs.MAIL_WATCH_MS + 60_000);
  assert.equal((await jobs.checkMail(OMARI, again.job_id)).expired, true);
  assert.equal(lastSaid(), "Still no cancellation email from Cardboard a day later. Their page said Cardboard Starter was cancelled; access ends Nov 27, 2026; I can't confirm it beyond that, so check your next statement.");
  assert.equal(jobs.jobRow(OMARI, again.job_id).state, "not_done", "never upgraded to done without the mail");
});

test("mail not connected: done on the page alone, and it says the email could not be checked", async () => {
  mailbox.connected = false;
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  await yesThroughTheGate(job_id);
  end(run_id, CANCELLED);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "done_result_only");
  assert.equal(lastSaid(), "Done as far as I can see: Cardboard Starter at Cardboard is cancelled; access ends Nov 27, 2026. Seen: Cardboard's page said so. I can't see your email, so I couldn't look for their cancellation email.");
});

test("a billing service's mail counts only when it names the plan or the merchant", async () => {
  googleOn();
  const { job_id, run_id } = await cancelStarted({ notice_from: "receipts@stripe.com" });
  assert.equal(jobs.jobRow(OMARI, job_id).mail_domains, "stripe.com");
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  await yesThroughTheGate(job_id);
  mailbox.hits = [mail("Your subscription has been canceled", "Other Co <receipts@stripe.com>", "mx.google.com; dkim=pass header.i=@stripe.com")];
  end(run_id, CANCELLED);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "waiting_mail", "another merchant's cancellation through the same service is not this one's");
  mailbox.hits.push(mail("Your Cardboard Starter subscription has been canceled", "Cardboard <receipts@stripe.com>", "mx.google.com; dkim=pass header.i=@stripe.com"));
  assert.equal((await jobs.checkMail(OMARI, job_id)).seen, true);
});

// ---------------------------------------------------------------- no loops
test("no loops: the same ask answers with the job already running; three starts in a day and it stops trying", async () => {
  const first = await cancelStarted();
  const second = await call("account_cancel", { site: "cardboard.app", plan: "Cardboard Starter" });
  assert.equal(second.already_running, true);
  assert.equal(second.job_id, first.job_id);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 1, "one run");
  for (let i = 0; i < jobs.STARTS_PER_DAY; i++) {
    const row = q("SELECT * FROM account_jobs ORDER BY id DESC").get();
    end(row.run_id, { status: "blocked", result: { outcome: "blocked", code: "merchant.access_blocked", summary: "blocked" } });
    await shop.step(row.run_id);
    if (i < jobs.STARTS_PER_DAY - 1) await cancelStarted();
  }
  const more = await call("account_cancel", { site: "cardboard.app", plan: "Cardboard Starter" });
  assert.equal(more.blocked, "tried_enough");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, jobs.STARTS_PER_DAY);
});

test("a slow run says so once, never again", async () => {
  const { run_id } = await cancelStarted();
  working(run_id);
  await shop.step(run_id);
  assert.equal(said.length, 0);
  clock.skip(jobs.WAIT_MS + 1000);
  working(run_id);
  await shop.step(run_id); await shop.step(run_id);
  clock.skip(10 * 60_000);
  working(run_id);
  await shop.step(run_id);
  assert.deepEqual(said.map((s) => s.t), ["Still working inside Cardboard on cancelling Cardboard Starter. Not stuck; nothing is cancelled yet."]);
});

// ---------------------------------------------------------------- a bill
test("a bill needs every reference from the notice, a card, and room under the day's limit before anything starts", async () => {
  say("pay my con ed bill");
  const none = await call("account_bill_pay", { ...BILL, reference: "  " });
  assert.equal(none.error, "missing_reference");
  assert.deepEqual(none.missing, ["the account or invoice number (or the notice's own pay link)"]);
  assert.equal((await call("account_bill_pay", BILL)).blocked, "no_card");
  card();
  // Bill total over the daily cap: not started, nothing paid, said with the limit.
  config.maxSpendPerDay = 50;
  const over = await call("account_bill_pay", BILL);
  assert.equal(over.blocked, "over_daily_cap", JSON.stringify(over));
  assert.match(over.say, /^Nothing was started and nothing was paid: /);
  assert.equal(over.amount, 8210);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts").length, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM account_jobs").get().n, 0);
});

test("a notice that prints no number but carries its own pay link: the link is the reference, and only on the site named", async () => {
  card();
  say("pay the anthropic invoice that failed");
  const out = await call("account_bill_pay", { biller: "Anthropic", site: "invoice.stripe.com", amount: 6, page: "https://invoice.stripe.com/i/acct_1/live_abc", notice_from: "failed-payments@mail.anthropic.com" });
  assert.equal(out.ok, true, JSON.stringify(out));
  const start = calls.find((c) => c.method === "POST" && c.path === "/api/unstable/agent-checkouts");
  assert.equal(start.body.request.startUrl, "https://invoice.stripe.com/i/acct_1/live_abc");
  assert.match(start.body.request.task, /reference \(account or invoice number\) the invoice the notice links to; amount due 6\.00 USD/);
  const job = jobs.jobRow(OMARI, out.job_id);
  assert.equal(job.mail_domains, "anthropic.com", "the biller's own mail is where its confirmation is looked for");
  // A link on some other site is not the bill's: with no number either, nothing starts.
  db.db.exec("DELETE FROM account_jobs");
  const off = await call("account_bill_pay", { biller: "Anthropic", site: "anthropic.com", amount: 6, page: "https://invoice.stripe.com/i/acct_1/live_abc" });
  assert.equal(off.error, "missing_reference");
});

test("a bill is paid on the biller's own page through the pay path: exact total first, their yes, the daily cap, then the receipt AND the biller's email", async () => {
  googleOn();
  const { job_id, run_id } = await billStarted();
  const start = calls.find((c) => c.method === "POST" && c.path === "/api/unstable/agent-checkouts");
  assert.equal(start.body.request.startUrl, "https://coned.com/");
  assert.deepEqual(start.body.constraints.maxCost, { amount: "91.39", currency: "USD" }, "a ceiling: the bill and room for a card fee; never what is approved");
  assert.match(start.body.request.task, /^Pay one bill on Con Edison's own payment page\. The bill: reference \(account or invoice number\) Account 44-1234-5678-9; amount due 82\.10 USD; due Nov 20, 2026/);
  assert.match(start.body.request.task, /guest or one-time payment page/);
  assert.match(start.body.request.task, /Do not turn on autopay, do not save the card/);
  assert.match(start.body.request.task, /request payment approval from me and wait/);
  assert.ok(start.body.browser.profileId);
  assert.equal(shop.runRow(run_id).mode, "job_bill");
  // The page adds a fee: said before the ask, and the ask is the page's exact total.
  payAsk(run_id, "req_pay", "84.05");
  await shop.step(run_id);
  assert.equal(said.length, 2);
  assert.equal(said[0].t, "Con Edison's page total is $84.05; the notice said $82.10 ($1.95 more, likely a card fee). The approval below is for the page's total.");
  assert.match(said[1].t, /^OK to pay \$84\.05 \(the payment page's total\) to Con Edison for your Con Edison bill \(Account 44-1234-5678-9\)\?/);
  const row = shop.openPayment(OMARI);
  assert.equal(row.amount, "84.05");
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_approval");
  // The shopping gate, untouched: no yes, no payment.
  const refused = await call("shop_pay", { payment_id: row.id });
  assert.ok(refused.use_target.includes("exact 84.05 USD"), refused.use_target);
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
  const req = await call("confirm_request", { action: "shop_pay", summary: "OK to pay $84.05 at Con Edison?", stakes: "money", amount: 84.05, target: refused.use_target });
  messages.push(owner("yes"));
  assert.equal((await call("confirm_record", { confirmation_id: req.confirmation_id })).state, "granted");
  const paid = await call("shop_pay", { payment_id: row.id, confirmation_id: req.confirmation_id });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.deepEqual(calls.find((c) => c.path === "/api/unstable/order-intents").body.amount, { value: "84.05", currency: "USD" });
  assert.equal(trust.checkSpendCap(OMARI, 0).spent_today, 8405, "counted against the day");
  // The run ends with the receipt (documented shape), and the biller's own confirmation is in their mail.
  mailbox.hits = [mail("Payment received. Thank you", "Con Edison <noreply@coned.com>", "mx.google.com; dkim=pass header.d=coned.com")];
  end(run_id, { status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "receipt_captured", receipt: { total: { amount: "84.05", currency: "USD" }, merchantOrderId: "CE-99817" } }, summary: "Paid $84.05 to Con Edison." } });
  await shop.step(run_id);
  const job = jobs.jobRow(OMARI, job_id);
  assert.equal(job.state, "done"); assert.equal(job.outcome, "done");
  assert.equal(lastSaid(), `Done. $84.05 went to Con Edison for Account 44-1234-5678-9. Seen: the payment page's receipt ($84.05, confirmation CE-99817), and their confirmation email arrived ("Payment received. Thank you").`);
  assert.ok(!said.some((s) => /placed the order|checkout/.test(s.t)), "never told as a store order");
  assert.equal(woke.length, 0, "the shopping mail watch is not this job's");
  assert.equal(lines.length, 1); assert.equal(lines[0].kind, "bill"); assert.equal(lines[0].outcome, "done");
  assert.ok(!JSON.stringify(lines[0]).includes("44-1234"));
});

test("a bill's total over what is left of the day at payment: the pay path refuses, nothing reaches Crossmint, and the page timing out is said as not done", async () => {
  const { job_id, run_id } = await billStarted({ ...BILL, amount: 40 });
  config.maxSpendPerDay = 41;
  payAsk(run_id, "req_pay", "43.95");
  await shop.step(run_id);
  const row = shop.openPayment(OMARI);
  const refused = await call("shop_pay", { payment_id: row.id });
  const req = await call("confirm_request", { action: "shop_pay", summary: "OK to pay $43.95 at Con Edison?", stakes: "money", amount: 43.95, target: refused.use_target });
  messages.push(owner("yes"));
  await call("confirm_record", { confirmation_id: req.confirmation_id });
  const out = await call("shop_pay", { payment_id: row.id, confirmation_id: req.confirmation_id });
  assert.equal(out.ok, false);
  assert.equal(out.blocked ?? out.error, "over_daily_cap", JSON.stringify(out));
  assert.equal(calls.filter((c) => c.path === "/api/unstable/order-intents").length, 0);
  end(run_id, { status: "failed", reason: "input_expired" });
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "not_done");
  assert.equal(lastSaid(), "Not done: Con Edison's page stopped waiting for your approval. Nothing was paid. Tell me to pay it again and I'll bring the total back.");
  assert.ok(!said.some((s) => /asked again|fresh link/.test(s.t)), "no renewed checkout, no second link");
  assert.equal(calls.filter((c) => c.path === "/api/unstable/agent-checkouts" && c.method === "POST").length, 1);
});

test("a bill: the cap, a declined card, no receipt, and a run that breaks after the approval each have their own honest line", async () => {
  const run = async (body, prep = async () => {}) => {
    db.db.exec("DELETE FROM account_jobs; DELETE FROM shop_payments; DELETE FROM spend;"); said.length = 0;
    const s = await billStarted();
    await prep(s);
    end(s.run_id, body);
    await shop.step(s.run_id);
    return jobs.jobRow(OMARI, s.job_id);
  };
  let job = await run({ status: "blocked", result: { outcome: "blocked", code: "policy.max_cost_exceeded", summary: "Total $140.00 is over the limit." } });
  assert.equal(job.outcome, "refused_by_cap");
  assert.equal(lastSaid(), "Not done: Con Edison's page came to more than the bill plus a fee allowance, so it stopped before paying. Nothing was paid.");
  job = await run({ status: "blocked", result: { outcome: "blocked", code: "merchant.payment_declined", summary: "Card declined." } });
  assert.equal(lastSaid(), "Not done: Con Edison declined the card. Nothing was paid.");
  job = await run({ status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "nothing_placed" }, summary: "The account shows a zero balance; nothing to pay." } });
  assert.equal(job.outcome, "nothing_paid");
  assert.equal(lastSaid(), "Not done: the run ended without paying anything (The account shows a zero balance; nothing to pay.). Nothing was paid.");
  // Confirmed with no receipt, mail not connected: one weak proof is not "paid".
  mailbox.connected = false;
  const approved = async (s) => { payAsk(s.run_id, "req_pay", "82.10"); await shop.step(s.run_id); q("UPDATE shop_payments SET status = 'paid', answered_at = ? WHERE run_id = ?").run(clock.now(), s.run_id); };
  job = await run({ status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "confirmed_without_receipt" }, summary: "Payment submitted." } }, approved);
  assert.equal(job.outcome, "unconfirmed");
  assert.equal(lastSaid(), "Not confirmed: Con Edison's page said the payment went through but gave no receipt, and I can't see your email to look for theirs. Check Con Edison before paying again.");
  // A receipt with no mail connected: done on the receipt, said as such.
  job = await run({ status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "receipt_captured", receipt: { total: { amount: "82.10", currency: "USD" } } }, summary: "Paid." } }, approved);
  assert.equal(job.outcome, "done_result_only");
  assert.equal(lastSaid(), "Done as far as I can see: $82.10 went to Con Edison for Account 44-1234-5678-9. Seen: the payment page's receipt ($82.10). I can't see your email, so I couldn't look for their confirmation email.");
  // The approval went out and the run broke: never "nothing was paid".
  mailbox.connected = true;
  job = await run({ status: "failed", reason: "reconciliation_required" }, async (s) => {
    payAsk(s.run_id, "req_pay", "82.10");
    await shop.step(s.run_id);
    q("UPDATE shop_payments SET status = 'paid', answered_at = ? WHERE run_id = ?").run(clock.now(), s.run_id);
  });
  assert.equal(job.outcome, "unconfirmed");
  assert.ok(job.mail_until > clock.now());
  assert.match(lastSaid(), /^Not confirmed: your approval went out, then the run ended without a receipt \(reconciliation_required\)\. Don't pay it again yet\./);
});

test("a bill's plain question goes to the model; their email is answered from the record; a job run is never answered through shop_answer", async () => {
  googleOn();
  const { job_id, run_id } = await billStarted();
  ask(run_id, "req_mail", "Enter an email address for the receipt.", [EMAIL]);
  await shop.step(run_id);
  assert.deepEqual(posted().at(-1).response.answers, { email: "omari@example.com" });
  assert.equal(woke.length, 0);
  ask(run_id, "req_zip", "Enter the service address ZIP code to find this account.", [{ key: "zip", label: "ZIP code", required: true, handling: "standard", input: { kind: "text" } }]);
  await shop.step(run_id);
  assert.equal(woke.length, 1);
  assert.match(woke[0].t, /\[account job\] #\d+ pay the Con Edison bill \(\$82\.10, Account 44-1234-5678-9\): Con Edison asks: "Enter the service address ZIP code/);
  assert.equal((await call("shop_answer", { run_id, answers: { zip: "10001" } })).error, "account_job");
  const out = await call("account_job_answer", { job_id, answers: { zip: "10001" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await call("account_job_answer", { job_id, answers: { nope: "x" } })).error, "nothing_asked");
});

// ---------------------------------------------------------------- the words, all of them
test("every 'not done' line: none claims a change, each says what is true about money", () => {
  const cancel = { kind: "cancel", name: "Cardboard", what: "Cardboard Starter", host: "cardboard.app" };
  const bill = { kind: "bill", name: "Con Edison", what: "bill", amount: "82.10", reference: "Account 44", host: "coned.com" };
  const reasons = ["refused_by_cap", "payment_asked", "blocked_browser", "human_check", "site_error", "no_safe_path", "payment_declined", "not_found", "not_cancelled", "nothing_paid", "no_answer", "approval_timeout", "no_signin", "no_signin_route", "declined", "stopped", "start_failed", "unconfirmed", "service_failed"];
  for (const r of reasons) {
    for (const job of [cancel, bill]) {
      const line = jobs.notDoneLine(job, r, { detail: "why" });
      assert.match(line, /^(Not done|Not confirmed|Left |Stopped)/, `${job.kind}/${r}: ${line}`);
      assert.ok(!/—/.test(line), "plain punctuation");
      assert.ok(!/\b(is cancelled|was cancelled|has been cancelled|is paid|was paid\.|went through)\b/i.test(line.replace(/may or may not be cancelled|not cancelled|Nothing was paid/gi, "")), `${job.kind}/${r} claims nothing: ${line}`);
      assert.ok(line.length < 320);
    }
  }
  assert.equal(jobs.notDoneLine(cancel, "service_failed", { detail: "model_error" }), "Not done: the service I use for this broke off partway (model_error). Treat Cardboard Starter as still active.");
  assert.equal(jobs.notDoneLine(bill, "service_failed"), "Not done: the service I use for this broke off partway. Nothing was paid that I can see.");
  assert.equal(jobs.notDoneLine(cancel, "no_signin"), "Not done: the sign-in wasn't finished in time, so Cardboard let it go. Cardboard Starter is unchanged.");
  assert.equal(jobs.notDoneLine(bill, "declined"), "Left unpaid: the Con Edison bill was not paid.");
  assert.equal(jobs.notDoneLine(cancel, "stopped"), "Stopped. Cardboard Starter is unchanged.");
  assert.equal(jobs.notDoneLine(cancel, "start_failed", { detail: "the service answered 503" }), "Not done: I couldn't start (the service answered 503). Cardboard Starter is unchanged.");
});

test("what a result's words count as: the task's own last line first, a plain reading only without it", () => {
  assert.equal(jobs.saysCancelled("Done.\nRESULT: CANCELLED"), true);
  assert.equal(jobs.saysCancelled("It says cancelled somewhere.\nRESULT: NOT CANCELLED the button failed"), false);
  assert.equal(jobs.saysCancelled("Your subscription has been cancelled and will not renew."), true);
  assert.equal(jobs.saysCancelled("The subscription could not be cancelled."), false);
  assert.equal(jobs.saysCancelled("I was unable to cancel the plan."), false);
  assert.equal(jobs.saysCancelled("I opened the billing page."), false);
  assert.equal(jobs.saysCancelled(""), false);
  assert.equal(jobs.endsFrom("Cancelled. Access ends Nov 27, 2026."), "Nov 27, 2026");
  assert.equal(jobs.endsFrom("Your plan is active until 2026-11-27"), "2026-11-27");
  assert.equal(jobs.endsFrom("Cancelled."), "");
});

test("what a question is: sealed fields go to the page, open codes and identity are answered, the marker is the last step", () => {
  const c = (q2, fields) => jobs.classify({ kind: "cancel" }, { question: q2, fields });
  assert.equal(c("Sign in", [EMAIL, PASSWORD]), "page");
  assert.equal(c("Enter the code", [CODE_SEALED]), "page");
  assert.equal(c("Enter the code we emailed", [CODE_OPEN]), "code");
  assert.equal(c("What's your email?", [EMAIL]), "identity");
  assert.equal(c(CONFIRM_Q, [CONFIRM]), "confirm");
  assert.equal(c("Are you sure you want to cancel your plan? This is final.", [CONFIRM]), "confirm");
  assert.equal(c("Why are you leaving?", [{ key: "reason", label: "Reason", required: true, handling: "standard", input: { kind: "choice", options: ["Too expensive", "Other"] } }]), "plain");
  assert.equal(c("Enter your ZIP code", [{ key: "zip", label: "ZIP code", required: true, handling: "standard", input: { kind: "text" } }]), "plain");
  assert.equal(jobs.classify({ kind: "bill" }, { question: CONFIRM_Q, fields: [CONFIRM] }), "plain", "a bill has no gated last step of its own: its payment is the gate");
  assert.equal(jobs.codeChannel({ question: "We emailed you a code" }), "email");
  assert.equal(jobs.codeChannel({ question: "We texted a code to your phone" }), "text");
  assert.equal(jobs.codeChannel({ question: "Enter your code" }), "");
  assert.deepEqual(jobs.confirmAnswers({ fields: [CONFIRM] }), { confirm: "yes" });
  assert.deepEqual(jobs.confirmAnswers({ fields: [{ key: "ok", required: true, input: { kind: "boolean" } }] }), { ok: true });
  assert.equal(jobs.confirmAnswers({ fields: [{ key: "c", required: true, input: { kind: "choice", options: ["Maybe", "Later"] } }] }), null, "a yes that cannot be told is never guessed");
});

// ---------------------------------------------------------------- beside the shopping record
test("a job is not a checkout: it never shows as a store order, the model's record has its own lines, and the cancel rules name account_cancel", async () => {
  googleOn();
  const { job_id, run_id } = await cancelStarted();
  assert.deepEqual(shop.runsOf(OMARI), [], "not in the shopping record");
  assert.equal(shop.recentRun(OMARI), null);
  assert.match(shop.checkoutNote(OMARI), /^Account jobs \(code's own record; it overrides anything the chat says about them\):\n- #\d+ cancel Cardboard Starter at Cardboard: working inside the account\.\n/);
  assert.match(shop.checkoutNote(OMARI), /Never say one is cancelled or paid unless it reads done here/);
  assert.equal(shop.checkoutNote(AMA), "");
  ask(run_id, "req_confirm", CONFIRM_Q, [CONFIRM]);
  await shop.step(run_id);
  await yesThroughTheGate(job_id);
  mailbox.hits = [mail("Subscription cancelled")];
  end(run_id, CANCELLED);
  await shop.step(run_id);
  assert.deepEqual(shop.ordersPlaced(OMARI), [], "a cancellation is never counted as an order placed");
  assert.match(shop.checkoutNote(OMARI), /cancel Cardboard Starter at Cardboard: done \(their page and their email both seen\)\./);
  // The rules riding on cancel_route: account_cancel for them, today's words for everybody else.
  const rules = (c) => toolsFor(c).find((t) => t.name === "cancel_route").description;
  assert.match(rules(OMARI), /goes through account_cancel/);
  assert.ok(!/send them a sign-in link/.test(rules(OMARI)), "nobody on account jobs is told to send a sign-in link to cancel");
  assert.match(rules(AMA), /Cancelling has three rails/);
  assert.ok(!/account_cancel/.test(rules(AMA)));
  // With the tool diet on, the six tools are loaded whole for them (never left to a search).
  const diet = await import("../src/tooldiet.js");
  assert.ok(diet.statePacks(OMARI).includes("account_jobs"));
  assert.ok(!diet.statePacks(AMA).includes("account_jobs"));
  assert.equal(diet.packOf("account_cancel"), "account_jobs");
});

// ---------------------------------------------------------------- the daily note's test
test("can a job be finished? only with the switch on for them AND what the job needs", async () => {
  const cancel = { kind: "cancel", site: "cardboard.app" };
  assert.deepEqual(jobs.canFinish(AMA, cancel), { ok: false, why: "switch_off" });
  assert.deepEqual(jobs.canFinish(OMARI, cancel), { ok: false, why: "no_signed_in_route" }, "no saved sign-in and no proven emailed-code route: no card");
  shop.markConnected(OMARI, "cardboard");
  assert.deepEqual(jobs.canFinish(OMARI, cancel), { ok: true, route: "saved_profile" });
  db.db.exec("DELETE FROM shop_stores");
  // A site that let them in by an emailed code before, with mail still connected.
  q("INSERT INTO account_jobs (conversation_id, kind, host, name, what, state, route, seen_result, created_at) VALUES (?, 'cancel', 'cardboard.app', 'Cardboard', 'x', 'done', 'emailed_code', 1, ?)").run(OMARI, clock.now());
  assert.deepEqual(jobs.canFinish(OMARI, cancel), { ok: false, why: "no_signed_in_route" }, "mail not connected");
  googleOn();
  assert.deepEqual(jobs.canFinish(OMARI, cancel), { ok: true, route: "emailed_code" });
  // A bill: every reference present, and a card.
  const bill = { kind: "bill", site: "coned.com", amount: "82.10", reference: "44-1234" };
  assert.deepEqual(jobs.canFinish(OMARI, bill), { ok: false, why: "no_card" });
  card();
  assert.deepEqual(jobs.canFinish(OMARI, bill), { ok: true, route: "guest_pay_or_account" });
  assert.deepEqual(jobs.canFinish(OMARI, { ...bill, reference: "" }), { ok: false, why: "missing_reference" });
  delete process.env.REASON_ACCOUNT_JOBS;
  assert.deepEqual(jobs.canFinish(OMARI, bill), { ok: false, why: "switch_off" });
});

// ---------------------------------------------------------------- review, 2026-11-13: money on a cancellation, an unmarked last step, proof that is not proof
const CARD_NUMBER = { key: "card_number", label: "Card number", required: true, handling: "standard", input: { kind: "text", autoComplete: "cc-number" } };
const PAY_METHOD = { key: "method", label: "Payment method", required: true, handling: "standard", input: { kind: "choice", selection: { kind: "one" }, options: [{ value: "card", label: "Card on file" }, { value: "new", label: "A new card" }] } };
const GO = { key: "go", label: "Go ahead?", required: true, handling: "standard", input: { kind: "choice", selection: { kind: "one" }, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] } };

test("a cancellation asked for card details, a way to pay, or a fee: declined and ended by code, never put to anyone", async () => {
  for (const [question, fields, why] of [
    ["To finish cancelling, enter a card for the final balance.", [CARD_NUMBER], /comes with money to pay \(it asked for payment details\)/],
    ["Choose how to settle your account before it closes.", [PAY_METHOD], /comes with money to pay \(it asked for payment details\)/],
    ["CONFIRM CANCELLATION: Cardboard Starter, $12.00 per month. An early termination fee of $50.00 applies. Cancel it?", [CONFIRM], /comes with money to pay \(An early termination fee of \$50\.00 applies\.\)/],
  ]) {
    db.db.exec("DELETE FROM account_jobs; DELETE FROM shop_runs; DELETE FROM shop_payments;"); said.length = 0; woke.length = 0; calls.length = 0;
    const { job_id, run_id } = await cancelStarted();
    ask(run_id, "req_money", question, fields);
    await shop.step(run_id);
    assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_money", action: "decline" }, question);
    assert.ok(calls.some((c) => c.path.endsWith(`/${run_id}/cancel`)), "the run is ended");
    assert.equal(woke.length, 0, "the model is never asked a payment question");
    const job = jobs.jobRow(OMARI, job_id);
    assert.equal(job.state, "not_done");
    assert.equal(job.outcome, "payment_asked");
    assert.match(lastSaid(), why);
    assert.match(lastSaid(), /A cancellation through me can never pay, so I refused it and stopped\. Nothing was charged\. Cardboard Starter is unchanged\.$/);
    assert.equal(q("SELECT COUNT(*) AS n FROM shop_payments").get().n, 0);
    assert.equal((await call("account_job_answer", { job_id, answers: { card_number: "4242424242424242" } })).ok, false, "and nothing can answer it afterwards");
    assert.equal((await call("account_cancel_confirm", { job_id })).ok, false);
  }
});

test("a bill's page that wants card details typed into a form: never passed on, the run ended, nothing paid", async () => {
  const { job_id, run_id } = await billStarted();
  ask(run_id, "req_card", "Enter your card to pay $82.10.", [CARD_NUMBER]);
  await shop.step(run_id);
  assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_card", action: "decline" });
  assert.equal(woke.length, 0, "the model is never asked for a card number");
  assert.equal(jobs.jobRow(OMARI, job_id).outcome, "no_safe_path");
  assert.equal(lastSaid(), "Not done: I found no safe way to pay this bill on Con Edison's site (its page wanted card details typed in, which I never do). Nothing was paid.");
});

test("a last step that says there is NO fee is an ordinary last step; softer money words ride in the line they are asked", async () => {
  const { job_id, run_id } = await cancelStarted();
  ask(run_id, "req_confirm", "CONFIRM CANCELLATION: Cardboard Starter, $12.00 per month. There is no cancellation fee. You will still be billed $12.00 on Nov 20. Your access ends Nov 27, 2026. Cancel it?", [CONFIRM]);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_confirm");
  assert.match(woke[0].t, /From the page's words that line is: "Cancel Cardboard Starter at Cardboard \(\$12\.00 per month\)\? Access ends Nov 27, 2026\."/);
  assert.match(woke[0].t, /The page also says this about money: "You will still be billed \$12\.00 on Nov 20\."/);
  assert.match(woke[0].t, /Use the same line as confirm_request's summary/);
  assert.equal(jobs.feeStated("Cancelling is free of any termination fee."), "");
  assert.equal(jobs.feeStated("You won't pay a cancellation fee."), "");
  assert.equal(jobs.feeStated("A cancellation fee of $25 will be charged to your card."), "A cancellation fee of $25 will be charged to your card.");
});

test("before their yes, a go-ahead question in other words is still the last step: the gate, never a plain answer", async () => {
  const { job_id, run_id } = await cancelStarted();
  // An earlier step is the model's to answer.
  ask(run_id, "req_why", "Why are you cancelling?", [{ key: "reason", label: "Reason", required: true, handling: "standard", input: { kind: "text" } }]);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_answer");
  assert.equal((await call("account_job_answer", { job_id, answers: { reason: "Other" } })).ok, true);
  // The last step with no marker and no "confirm" in it.
  ask(run_id, "req_go", "Ready to end your subscription?", [GO]);
  await shop.step(run_id);
  assert.equal(jobs.jobRow(OMARI, job_id).state, "needs_confirm");
  assert.match(woke.at(-1).t, /is at the LAST step and asks: "Ready to end your subscription\?"/);
  assert.match(woke.at(-1).t, /Cardboard's page gave no end date\./);
  assert.equal((await call("account_job_answer", { job_id, answers: { go: "yes" } })).error, "needs_the_gate");
  assert.ok(!posted().some((p) => p.requestId === "req_go"), "nothing reached the site");
  const { done } = await yesThroughTheGate(job_id);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(posted().at(-1), { type: "input_response", requestId: "req_go", action: "submit", response: { kind: "form", answers: { go: "yes" } } });
  // What a question is, at the edges.
  const J = { kind: "cancel", confirmed_at: null };
  assert.equal(jobs.classify(J, { question: "Proceed?", fields: [GO] }), "confirm");
  assert.equal(jobs.classify(J, { question: "Unsubscribe now?", fields: [GO] }), "confirm");
  assert.equal(jobs.classify(J, { question: "Do you have an account with us?", fields: [GO] }), "plain");
  assert.equal(jobs.classify(J, { question: "We can pause your plan for a month instead. Would you like that?", fields: [GO] }), "plain", "an offer to stay is an earlier step: the model declines it");
  assert.equal(jobs.classify(J, { question: "Which subscription do you want to cancel?", fields: [GO] }), "plain");
  assert.equal(jobs.classify({ kind: "cancel", confirmed_at: 5 }, { question: "Proceed?", fields: [GO] }), "plain", "after their yes it goes through");
  assert.equal(jobs.classify({ kind: "bill" }, { question: "Proceed?", fields: [GO] }), "plain");
  assert.equal(jobs.classify({ kind: "bill" }, { question: "How do you want to pay?", fields: [PAY_METHOD] }), "plain", "a bill may be asked how to pay; only card details are refused");
});

test("mail that is about it but does not say it happened is never proof", async () => {
  const now = clock.now();
  const seen = async (job, subject, from, auth) => { mailbox.hits = [mail(subject, from, auth)]; return (await jobs.lookForMail(job)).state; };
  const cancelJob = { conversation_id: OMARI, kind: "cancel", host: "cardboard.app", name: "Cardboard", what: "Cardboard Starter", mail_domains: "", created_at: now, confirmed_at: now };
  for (const no of ["Confirm your cancellation", "We could not cancel your subscription", "Your cancellation request is pending", "Your order was cancelled", "Before you cancel: 50% off", "Cancellation policy update"]) assert.equal(await seen(cancelJob, no), "none", no);
  for (const yes of ["Your subscription has been canceled", "Cancellation confirmed", "Subscription cancelled", "You've cancelled Cardboard Starter", "Sorry to see you go"]) assert.equal(await seen(cancelJob, yes), "seen", yes);
  const billJob = { conversation_id: OMARI, kind: "bill", host: "coned.com", name: "Con Edison", what: "bill", amount: "82.10", mail_domains: "", created_at: now, paid_at: now };
  const coned = ["Con Edison <billing@coned.com>", "mx.google.com; dkim=pass header.i=@coned.com"];
  for (const no of ["Your invoice is unpaid", "Your payment failed", "Payment declined: update your card", "Your bill is past due", "We couldn't process your payment", "Your refund receipt"]) assert.equal(await seen(billJob, no, ...coned), "none", no);
  for (const yes of ["Payment received", "Your receipt from Con Edison", "Thank you for your payment", "Your bill has been paid"]) assert.equal(await seen(billJob, yes, ...coned), "seen", yes);
  // A bill paid on a payment service's address: that service's mail counts only when it names the biller or the amount paid.
  const hosted = { ...billJob, host: "invoice.stripe.com", name: "Anthropic", amount: "6.00", mail_domains: "anthropic.com" };
  const stripe = ["Stripe <receipts@stripe.com>", "mx.google.com; dkim=pass header.i=@stripe.com"];
  assert.equal(await seen(hosted, "Your receipt from Cardboard #1042", ...stripe), "none", "somebody else's receipt from the same service");
  assert.equal(await seen(hosted, "Your receipt from Anthropic, PBC #2231", ...stripe), "seen");
  assert.equal(await seen(hosted, "Payment received", "Anthropic <billing@mail.anthropic.com>", "mx.google.com; dkim=pass header.i=@mail.anthropic.com"), "seen", "the biller's own address needs no name in the subject");
});

test("a cancellation that went through without stopping for their yes is said as that; a purchase on a cancel run is never 'done'", async () => {
  mailbox.connected = false;
  let s = await cancelStarted();
  end(s.run_id, CANCELLED);
  await shop.step(s.run_id);
  assert.match(lastSaid(), /^Done as far as I can see: Cardboard Starter at Cardboard is cancelled; access ends Nov 27, 2026\..* It went through without stopping for your yes at the last step, which I had asked Cardboard's page to do\.$/);
  db.db.exec("DELETE FROM account_jobs"); said.length = 0;
  s = await cancelStarted();
  end(s.run_id, { status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "receipt_captured", receipt: { total: { amount: "12.00", currency: "USD" } } }, summary: "Renewed Cardboard Starter.\nRESULT: CANCELLED" } });
  await shop.step(s.run_id);
  const job = jobs.jobRow(OMARI, s.job_id);
  assert.equal(job.state, "not_done");
  assert.equal(job.outcome, "unexpected_purchase");
  assert.match(lastSaid(), /^Check this: Cardboard's page reports a purchase \(\$12\.00\) on a run that was only meant to cancel Cardboard Starter\. I approved no payment/);
  assert.equal(q("SELECT COUNT(*) AS n FROM shop_payments").get().n, 0);
});

test("a bill the page says was paid without their approval (a card saved at the biller): never 'done', said as what it is", async () => {
  mailbox.connected = false;
  const s = await billStarted();
  end(s.run_id, { status: "succeeded", result: { outcome: "succeeded", purchase: { kind: "receipt_captured", receipt: { total: { amount: "82.10", currency: "USD" }, merchantOrderId: "CE-1" } }, summary: "Paid with the card on file." } });
  await shop.step(s.run_id);
  const job = jobs.jobRow(OMARI, s.job_id);
  assert.equal(job.state, "not_done");
  assert.equal(job.outcome, "paid_unapproved");
  assert.equal(lastSaid(), "Check this: Con Edison's page says a payment went through ($82.10, confirmation CE-1), but not through the approval I ask you for, so it likely used a card saved at Con Edison. I did not approve it. Look at your Con Edison account before paying anything again.");
});

test("a subscription managed on a billing service's address: the sign-in line names that address, and the site's shared name is not taught the merchant's", async () => {
  say("cancel my Cardboard Starter subscription");
  const out = await call("account_cancel", { site: "app.link.com", plan: "Cardboard Starter", name: "Cardboard", notice_from: "stripe.com" });
  assert.equal(out.ok, true, JSON.stringify(out));
  ask(out.run_id, "req_login", "Enter the code sent to your phone.", [CODE_SEALED]);
  await shop.step(out.run_id);
  assert.match(said[0].t, /^Cardboard's account page \(link\.com\) wants you signed in before I can cancel Cardboard Starter\. Sign in once here and it stays signed in for next time\. What you type goes straight to link\.com, not to me\.\nhttps:\/\/heyreason\.test\/web\/connect\//);
  assert.ok(!q("SELECT name FROM shop_sites").all().some((r) => /cardboard/i.test(r.name)), "link.com is not renamed Cardboard for everyone");
});

test("a bill whose payment page names somebody else as the payee: said before the ask, in the page's word", async () => {
  let s = await billStarted();
  payAsk(s.run_id, "req_pay", "82.10", "QuickPay Services");
  await shop.step(s.run_id);
  assert.equal(said[0].t, 'Look before you approve: the payment page names who gets paid as "QuickPay Services", not Con Edison. The approval below pays QuickPay Services.');
  assert.match(said[1].t, /^OK to pay \$82\.10 \(the payment page's total\) to QuickPay Services for your Con Edison bill/);
  // The biller under its legal name, or the site's own name: nothing extra is said.
  for (const name of ["Consolidated Edison / Con Edison Company of New York, Inc.", "ConEd"]) {
    db.db.exec("DELETE FROM account_jobs; DELETE FROM shop_runs; DELETE FROM shop_payments;"); said.length = 0;
    s = await billStarted();
    payAsk(s.run_id, "req_pay2", "82.10", name);
    await shop.step(s.run_id);
    assert.ok(!said.some((x) => /Look before you approve/.test(x.t)), name);
  }
});

test("no loops across sites either: a day's starts for one person have a ceiling", async () => {
  say("cancel all of these");
  for (let i = 0; i < jobs.STARTS_PER_DAY_ALL; i++) assert.equal((await call("account_cancel", { site: `site${i}.example.org`, plan: "Plan" })).ok, true, `start ${i}`);
  const before = calls.length;
  const more = await call("account_cancel", { site: "one-more.example.org", plan: "Plan" });
  assert.equal(more.blocked, "tried_enough");
  assert.equal(calls.length, before, "nothing reached Crossmint");
});

test("cancel_route where account jobs are on: the last press is account_cancel_confirm's, and that turn gets no sign-in link", async () => {
  say("how do I get out of this subscription");
  const all = await call("cancel_route", {});
  assert.equal(all.ok, true, JSON.stringify(all).slice(0, 200));
  const r = await call("cancel_route", { service: all.routes[0].service });
  assert.match(r.gate, /account_cancel/);
  assert.ok(!/subscription_cancel_commit/.test(r.gate));
  assert.equal(offers.turnState(OMARI).cancelling, true);
  assert.equal(jt.signinLinkRefusal(OMARI, "notion.so", offers.turnState(OMARI)).blocked, "use_account_job");
  // Somebody the switch does not reach reads the old line and is refused nothing.
  say("how do I cancel", AMA);
  const theirs = await runTool("cancel_route", { service: all.routes[0].service }, { conversationId: AMA, messages: [] });
  if (theirs.ok) assert.match(theirs.gate, /subscription_cancel_commit/);
  assert.equal(jt.signinLinkRefusal(AMA, "notion.so", offers.turnState(AMA)), null);
});

test("the one sign-in page a job texts says what it is for, in true words: no checkout talk, the plan's name escaped", async () => {
  const pages = await import("../src/pages/webconnect.js");
  say("cancel my plan");
  const out = await call("account_cancel", { site: "cardboard.app", plan: "Starter <b>Plus</b>", name: "Cardboard" });
  assert.equal(out.ok, true, JSON.stringify(out));
  ask(out.run_id, "req_login", "Enter your email and password to sign in.", [EMAIL, PASSWORD]);
  await shop.step(out.run_id);
  const token = said[0].t.split("/").pop();
  const view = shop.linkView(shop.linkFor(token));
  assert.deepEqual(view.job, { kind: "cancel", what: "Starter <b>Plus</b>", name: "Cardboard" });
  const html = pages.renderView(view).html;
  assert.match(html, /Sign in to Cardboard\./);
  assert.match(html, /Then I can cancel Starter &lt;b&gt;Plus&lt;\/b&gt;\./);
  assert.match(html, /Cancel Starter &lt;b&gt;Plus&lt;\/b&gt;, and only after your yes in the chat\./);
  assert.match(html, /I change nothing else on your account\./);
  assert.match(html, /data-protected="password"/, "the password is Crossmint's sealed field");
  for (const never of ["check out", "Fill a cart", "account settings", "BOUGHT", "<b>Plus</b>", "ACCOUNT?"]) assert.ok(!html.includes(never), never);
  // A sealed code next, then the end screens: a job's words there too.
  ask(out.run_id, "req_otp", "Enter the code Cardboard sent you.", [CODE_SEALED]);
  await shop.step(out.run_id);
  const code = pages.renderView(shop.linkView(shop.linkFor(token))).html;
  assert.match(code, /NOTHING CANCELLED YET/);
  assert.match(code, /Ready to cancel Starter &lt;b&gt;Plus&lt;\/b&gt;/);
  assert.ok(!/BOUGHT|check out/.test(code));
  end(out.run_id, { status: "failed", reason: "input_expired" });
  await shop.step(out.run_id);
  const over = pages.renderView(shop.linkView(shop.linkFor(token))).html;
  assert.match(over, /Nothing was changed\./);
  assert.match(over, /NOTHING CANCELLED/);
  assert.ok(!/BOUGHT|Nothing was charged/.test(over));
  // A store checkout's page is word for word what it was.
  const store = pages.renderView({ state: "signin", store: "cardboard", kind: "signin", request: { requestId: "r", fields: [EMAIL, PASSWORD] }, answered: false }).html;
  assert.match(store, /Then I can check out there with your card\./);
  assert.match(store, /account settings/);
});
