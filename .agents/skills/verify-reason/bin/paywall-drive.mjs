#!/usr/bin/env node
// The free trial and the subscription (src/plan.js), driven end to end on a fresh database with a
// fake Stripe on this machine: 24 sessions quiet, the 25th's bubbles once, the 26th lapsing, an acting
// tool refused once a session, a plain tool answering, a signed webhook paying them up (held things
// back, one line said), a redelivery doing nothing, cancel-by-text saying the end date. No model, no
// phone, nothing leaves the machine, no sound. Prints one line per step and "all ok" or "FAILED".
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
const after = () => plan.afterTurn({ conversationId: C, router, sleep: async () => {} });
const visit = () => { clock.skip(31 * 60_000); accounts.countUse(C, "turn"); };

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
fake.close();
console.log(failed ? `FAILED (${failed})` : "all ok");
process.exit(failed ? 1 : 0);
