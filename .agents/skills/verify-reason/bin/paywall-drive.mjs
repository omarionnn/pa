#!/usr/bin/env node
// The free trial and the subscription (src/plan.js), driven end to end on a fresh database with a
// fake Stripe on this machine: 24 sessions quiet, the 25th's bubbles once (she has a win on the record),
// the 26th lapsing, an acting tool refused once a session, a plain tool answering, a signed webhook
// paying them up (held things back, one line said), a redelivery doing nothing, cancel-by-text saying
// the end date. Then the win rule (2026-11-01): a second person with no win is not asked at the 25th
// and the trial runs on; a win at the 27th is asked on the next text; a third with no win through the
// 30th is asked there with the softer line. No model, no phone, nothing leaves the machine, no sound.
// Prints one line per step and "all ok" or "FAILED".
//
//   REASON_DB_PATH=$(mktemp -d)/paywall.db node bin/paywall-drive.mjs
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-paywall-drive-"));
process.env.REASON_DB_PATH ||= join(dir, "paywall.db");
process.env.REASON_DATA_DIR ||= dir;
Object.assign(process.env, {
  REASON_OWNER_NAME: "Omari", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner",
  REASON_OWNER_NUMBER: "+12025551234", REASON_MASTER_NUMBER: "+12025551234", REASON_TEST_NUMBERS: "",
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_TOKEN_KEY: process.env.REASON_TOKEN_KEY || "55".repeat(32),
  REASON_PAYWALL: "on", REASON_PAYWALL_SHIP_TS: "2026-10-31T00:00:00Z",
  STRIPE_SECRET_KEY: "sk_test_drive", STRIPE_WEBHOOK_SECRET: "whsec_drive", STRIPE_PRICE_ID: "price_drive", STRIPE_PAYMENT_LINK_URL: "",
  SENDBLUE_API_KEY: "", SENDBLUE_API_SECRET: "", ANTHROPIC_API_KEY: "",
});

const calls = [];
const fake = http.createServer((req, res) => {
  let body = ""; req.on("data", c => { body += c; });
  req.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    calls.push({ path: req.url, form });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/checkout/sessions") return res.end(JSON.stringify({ id: "cs_d", url: `https://checkout.stripe.test/c/pay/cs_d#${form.client_reference_id}` }));
    if (/^\/v1\/subscriptions\//.test(req.url)) return res.end(JSON.stringify({ id: "sub_d", status: "active", cancel_at_period_end: true, current_period_end: 1_800_000_000 }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise(r => fake.listen(0, "127.0.0.1", r));
process.env.STRIPE_API_BASE = `http://127.0.0.1:${fake.address().port}`;

const plan = await import("../../../../src/plan.js");
const stripe = await import("../../../../src/stripe.js");
const pause = await import("../../../../src/pause.js");
const accounts = await import("../../../../src/accounts.js");
const { runTool } = await import("../../../../src/tools.js");
const { stripeWebhookRequest } = await import("../../../../src/http.js");
const db = await import("../../../../src/db.js");
const { clock } = await import("../../../../src/config.js");

let failed = 0;
const step = (name, ok, detail = "") => { console.log(`${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };
const C = "dm:fake:+13475550001";
db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
db.upsertAccount({ conversationId: C, channel: "fake", address: "+13475550001", name: "Ama", isOperator: false });
const sent = [];
const router = { send: async (m) => { sent.push(m); return { ok: true }; } };
const said = [];
const runtime = { say: (c, t) => said.push({ c, t }) };
const after = (c = C) => plan.afterTurn({ conversationId: c, router, sleep: async () => {} });
const visit = (c = C) => { clock.skip(31 * 60_000); accounts.countUse(c, "turn"); };
const taskDone = (c) => db.db.prepare("INSERT INTO tasks (conversation_id, title, goal, state, max_attempts, created_at, updated_at, finished_at) VALUES (?, 'w', 'w', 'done', 3, ?, ?, ?)").run(c, clock.now(), clock.now(), clock.now());

taskDone(C); // Ama has a win on the record, so the 25th asks
for (let i = 0; i < 24; i++) { visit(); await after(); }
step("24 sessions: nothing said, still trial", sent.length === 0 && plan.status(C).status === "trial", `${plan.row(C).sessions_used} used`);
visit(); const r25 = await after();
step("25th session: three bubbles once, link last", r25.did === "asked" && sent.length === 3 && /^https:\/\/checkout/.test(sent[2].text), sent.map(m => m.text.slice(0, 40)).join(" | "));
await after();
step("asked once only", sent.length === 3);
visit(); await after();
step("26th session: lapsed and held", plan.status(C).status === "lapsed" && pause.isPaused(C) && plan.row(C).held_at > 0);
const refused = await runTool("timer_set", { note: "gym", fire_at: new Date(clock.now() + 3_600_000).toISOString() }, { conversationId: C, messages: [] });
step("acting tool refused with the line and link", refused.blocked === "trial_over" && /\$24\.99/.test(refused.error) && !!refused.pay_url);
const second = await runTool("research", { question: "boots" }, { conversationId: C, messages: [] });
step("second refusal this session: no repeat", second.blocked === "trial_over" && second.pay_url === null && /ALREADY told/.test(second.error));
const show = await runTool("subscription_show", {}, { conversationId: C, messages: [] });
step("plain tool still answers", show.ok === true && show.status === "lapsed");
const ev = JSON.stringify({ id: "evt_d1", type: "checkout.session.completed", data: { object: { client_reference_id: plan.refFor(C), customer: "cus_d", subscription: "sub_d" } } });
// Signed on Reason's clock (the drive has skipped it forward a day): a real-time signature would read stale.
const sign = (raw, secret) => stripe.sign(raw, secret, Math.floor(clock.now() / 1000));
const bad = await stripeWebhookRequest({ rawBody: ev, headers: { "stripe-signature": sign(ev, "whsec_wrong") } });
step("webhook with a wrong signature: 401, nothing changed", bad.status === 401 && plan.status(C).status === "lapsed");
const good = await stripeWebhookRequest({ rawBody: ev, headers: { "stripe-signature": sign(ev, "whsec_drive") }, runtime });
step("signed checkout.session.completed: paid, released, one line", good.status === 200 && plan.status(C).status === "paid" && !pause.isPaused(C) && said.length === 1 && /all set/.test(said[0].t));
const dup = await stripeWebhookRequest({ rawBody: ev, headers: { "stripe-signature": sign(ev, "whsec_drive") }, runtime });
step("redelivery: duplicate, nothing said twice", dup.body.duplicate === true && said.length === 1);
const ok = await runTool("timer_set", { note: "gym", fire_at: new Date(clock.now() + 3_600_000).toISOString() }, { conversationId: C, messages: [] });
step("acting tool works again once paid", ok.ok === true);
const cancel = await runTool("subscription_cancel", {}, { conversationId: C, messages: [] });
step("cancel by text: Stripe asked for cancel_at_period_end, date said back", cancel.ok === true && calls.some(x => /subscriptions\/sub_d/.test(x.path) && x.form.cancel_at_period_end === "true") && !!cancel.access_until, cancel.access_until);
step("ops label", plan.opsLabel(C)?.startsWith("cancelled · until "), plan.opsLabel(C));

// ---- the win rule
const D = "dm:fake:+13475550002";
db.upsertAccount({ conversationId: D, channel: "fake", address: "+13475550002", name: "Kofi", isOperator: false });
const before = sent.length;
for (let i = 0; i < 25; i++) { visit(D); await after(D); }
step("no win at the 25th: nothing said, trial runs on", sent.length === before && plan.status(D).status === "trial" && plan.status(D).extended === true && plan.row(D).ask_due === 0, plan.opsLabel(D));
step("ops label says so", plan.opsLabel(D) === "trial 25/30 (no win yet)", plan.opsLabel(D));
step("the turn is told to stay quiet about paying", /Nothing has been said to them about paying/.test(plan.note(D)));
visit(D); await after(D); visit(D); await after(D);
step("27th, still no win: still quiet, still free", sent.length === before && plan.row(D).sessions_used === 27 && !plan.blocked(D), plan.opsLabel(D));
taskDone(D);
clock.skip(2 * 60_000); accounts.countUse(D, "turn"); const r27 = await after(D);
step("a win lands: the next text (same session) gets the three bubbles, counting 27 chats", r27.did === "asked" && sent.length === before + 3 && /^that's 27 chats between us, Kofi\. so far i've finished 1 thing/.test(sent[before].text), sent[before]?.text.slice(0, 60));
visit(D); await after(D);
step("the session after that lapses, as before", plan.status(D).status === "lapsed" && plan.opsLabel(D) === "lapsed");

const E = "dm:fake:+13475550003";
db.upsertAccount({ conversationId: E, channel: "fake", address: "+13475550003", name: "Efua", isOperator: false });
const b2 = sent.length;
for (let i = 0; i < 29; i++) { visit(E); await after(E); }
step("29 sessions, no win: nothing said", sent.length === b2 && plan.opsLabel(E) === "trial 29/30 (no win yet)", plan.opsLabel(E));
visit(E); const r30 = await after(E);
step("the 30th, no win: asked anyway, softer first line", r30.did === "asked" && sent.length === b2 + 3 && sent[b2].text === "that's 30 chats between us, Efua. i haven't pulled off something real for you yet, and i'd like the chance to." && /^https:\/\/checkout/.test(sent[b2 + 2].text), sent[b2]?.text.slice(0, 60));
visit(E); await after(E);
step("the 31st lapses", plan.status(E).status === "lapsed");
step("the operator (grandfathered under `on`) is never asked and never extended", (() => { for (let i = 0; i < 30; i++) visit("dm:owner"); return plan.status("dm:owner").status === "free" && plan.status("dm:owner").extended === false && plan.row("dm:owner").ask_due === 0; })());
// ---- Payment Link mode: only a reference the server issued binds a payment (security, 2026-11-07)
process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/test_drive";
const F = "dm:fake:+13475550004";
db.upsertAccount({ conversationId: F, channel: "fake", address: "+13475550004", name: "Akua", isOperator: false });
visit(F); await after(F);
const hook = async (obj, id) => { const raw = JSON.stringify({ id, type: "checkout.session.completed", data: { object: obj } }); return stripeWebhookRequest({ rawBody: raw, headers: { "stripe-signature": sign(raw, "whsec_drive") }, runtime }); };
const forged = Buffer.from(F, "utf8").toString("base64url");
const fr = await hook({ client_reference_id: forged, customer: "cus_attacker", subscription: "sub_attacker" }, "evt_pl_forged");
step("payment link: a reference made from her number by somebody else binds nothing", fr.status === 200 && fr.body.matched === false && plan.status(F).status === "trial" && !plan.row(F).stripe_subscription_id, JSON.stringify(fr.body));
const link = await plan.payLink(F);
const issued = new URL(link).searchParams.get("client_reference_id");
const pr = await hook({ client_reference_id: issued, customer: "cus_akua", subscription: "sub_akua" }, "evt_pl_issued");
step("payment link: the reference Reason gave her pays her up", pr.status === 200 && plan.status(F).status === "paid" && plan.row(F).stripe_subscription_id === "sub_akua" && /^[A-Za-z0-9_-]{1,200}$/.test(issued) && issued !== forged, `${issued.length} chars`);
process.env.STRIPE_PAYMENT_LINK_URL = "";
// ---- one number, two texting lines: one trial, one grandfather decision (security, 2026-11-08)
const G = "dm:fake:+13475550005", G2 = "dm:other:+13475550005";
db.upsertAccount({ conversationId: G, channel: "fake", address: "+13475550005", name: "Yaa", isOperator: false });
for (let i = 0; i < 10; i++) visit(G);
db.upsertAccount({ conversationId: G2, channel: "other", address: "+13475550005", name: "Yaa", isOperator: false });
db.db.prepare("UPDATE accounts SET joined_via_event = 1 WHERE conversation_id = ?").run(G2);
visit(G2);
step("second line, same number: the trial carries on (11 of 25), an event join there does not make it free", plan.status(G2).status === "trial" && plan.status(G2).sessions_used === 11 && plan.status(G).sessions_used === 11 && plan.status(G).status === "trial", plan.opsLabel(G2));
fake.close();
console.log(failed ? `FAILED (${failed})` : "all ok");
process.exit(failed ? 1 : 0);
