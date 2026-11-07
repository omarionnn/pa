#!/usr/bin/env node
// Drive "a Crossmint payment with an unknown outcome counts against the daily cap" (#357,
// src/shopconnect.js payRow `unknown` → countSpend, backfillSpend) at tool level. Crossmint is a stand-in
// inside this process (shop._setFetch, as test/shop-unknown-spend.test.js does it); every other fetch is
// refused; texts land in an array. No model, nothing texted, nothing charged.
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && D=$(mktemp -d) && REASON_DATA_DIR=$D REASON_DB_PATH=$D/su.db node .agents/skills/verify-reason/bin/spend-unknown-drive.mjs
//
// Steps: $100 cap; a $90 payment whose checkout message answers 500 after the order intent → unknown,
// $90 counted, ledger line ends "(OUTCOME UNKNOWN)", spend_today says $90 spent / $10 left; a second $90
// → over_daily_cap, never reaches Crossmint; an uncounted unknown row (as if from before #357) is
// counted once by backfillSpend, never twice. One line per step, exits non-zero on any FAIL.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_SHOP_CONNECT = "on";
process.env.REASON_MAX_SPEND_PER_DAY = "100";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dbp = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = dbp && existsSync(dirname(dbp)) ? realpathSync(dirname(dbp)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  const data = process.env.REASON_DATA_DIR && existsSync(process.env.REASON_DATA_DIR) ? realpathSync(process.env.REASON_DATA_DIR) + "/" : "";
  if (!dbp || existsSync(dbp) || !parent || !roots.some(r => parent.startsWith(r)) || !data || !roots.some(r => data.startsWith(r))) {
    console.error("refusing: set REASON_DATA_DIR to a temp directory and REASON_DB_PATH to a new file in it");
    process.exit(2);
  }
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "AGENTCARD_CLIENT_SECRET", "ELEVENLABS_API_KEY"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}
const { generateKeyPairSync } = await import("node:crypto");
process.env.CROSSMINT_SERVER_KEY = "sk_drive_fake";
process.env.CROSSMINT_CLIENT_KEY = "ck_drive_fake";
process.env.CROSSMINT_API_BASE = "https://cm.drive.invalid";
process.env.CROSSMINT_JWT_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
globalThis.fetch = async (u) => { throw new Error(`refused: no network in this drive (${new URL(u).host})`); };

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const shop = await imp("src/shopconnect.js");
const trust = await imp("src/trust.js");
const db = await imp("src/db.js");
const { runTool } = await imp("src/tools.js");
const { clock } = await imp("src/config.js");

let fails = 0;
const step = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

const AMA = "dm:drive:ama";
db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+12025550123", name: "Ama", isOperator: false });
const q = (sql) => db.db.prepare(sql);
q("INSERT INTO shop_cards (conversation_id, payment_method_id, brand, last4, saved_at, registered) VALUES (?, 'pm_1', 'visa', '4242', 0, 1)").run(AMA);

let calls = [], messages = "500", intent = null;
const reply = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body ?? {}) });
shop._setFetch(async (url, init = {}) => {
  const p = new URL(url).pathname;
  calls.push(p);
  if (p === "/api/unstable/order-intents") return reply(201, { orderIntentId: `oi_${calls.length}` });
  const oi = /^\/api\/unstable\/order-intents\/([^/]+)$/.exec(p);
  if (oi) return intent ? reply(200, { orderIntentId: decodeURIComponent(oi[1]), status: intent.status, paymentMethodId: "pm_1", description: "x", expiresAt: new Date().toISOString(), rails: [],
    amount: { total: "90.00", spent: intent.spent, reserved: "0.00", available: "0.00", currency: "USD" } }) : reply(404, {});
  if (/^\/api\/unstable\/agent-checkouts\/[^/]+\/messages$/.test(p)) return messages === "500" ? reply(500, { message: "internal" }) : reply(202, { ok: true });
  const m = /^\/api\/unstable\/agent-checkouts\/([^/]+)$/.exec(p);
  if (m) return reply(200, { runId: m[1], status: "running" });
  if (/order-intent-registration$/.test(p)) return reply(200, { status: "active" });
  return reply(404, {});
});
const texts = [];
shop.attach({ say: (c, t) => texts.push(t) });

let n = 1;
function asked(value) {
  const runId = `run_${n}`, requestId = `req_${n++}`;
  q("INSERT OR IGNORE INTO shop_runs (run_id, conversation_id, store, mode, item, status, created_at, updated_at) VALUES (?, ?, 'bestbuy', 'guest', 'USB-C cable', 'awaiting_input', 0, 0)").run(runId, AMA);
  return shop.recordPayment({ conversationId: AMA, runId, item: "USB-C cable", request: { requestId, request: {
    question: `Approve $${value}`, expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    interaction: { kind: "payment", method: "card", amount: { kind: "exact", value, currency: "USD" }, merchant: { name: "Best Buy", url: "https://www.bestbuy.com", countryCode: "US" } } } } });
}
const spent = () => db.spentToday(AMA, trust.spendDay()).cents;

step("cap is $100", trust.spendToday(AMA).cap === "$100.00", trust.spendToday(AMA).cap);

const first = asked("90.00");
const out = await shop.payApproved({ conversationId: AMA, paymentId: first.id, confirmationId: 1 });
step("$90 with Crossmint 500 after the order intent → unknown_outcome", out.unknown_outcome === true && shop.paymentRow(first.id).status === "unknown", JSON.stringify(out));
step("the $90 counts against today", spent() === 9000, `spent ${spent()}c`);
const line = db.listSpend(AMA, trust.spendDay())[0];
step("ledger line ends (OUTCOME UNKNOWN)", /\(OUTCOME UNKNOWN\)$/.test(line?.what ?? ""), line?.what);
const st = await runTool("spend_today", {}, { conversationId: AMA, messages: [] });
step("spend_today: $90 spent, $10 left", st.spent_cents === 9000 && st.left === "$10.00", `${st.spent} spent, ${st.left} left`);

messages = "ok";
const before = calls.filter(p => p === "/api/unstable/order-intents").length;
const second = asked("90.00");
const again = await shop.payApproved({ conversationId: AMA, paymentId: second.id, confirmationId: 2 });
step("second $90 → over_daily_cap", again.error === "over_daily_cap", JSON.stringify({ error: again.error, say: again.say }));
step("second payment never reached Crossmint", calls.filter(p => p === "/api/unstable/order-intents").length === before && shop.paymentRow(second.id).status === "asked", `status ${shop.paymentRow(second.id).status}`);
step("spend still $90", spent() === 9000, `spent ${spent()}c`);

// Lead 5b: Crossmint asked about the unknown payment's order intent. Not definite → still counted.
intent = { status: "active", spent: "0.00" };
const third = asked("90.00");
const still = await shop.payApproved({ conversationId: AMA, paymentId: third.id, confirmationId: 3 });
step("intent still active (not definite) → unknown $90 stays counted, second $90 refused", still.error === "over_daily_cap" && shop.paymentRow(first.id).status === "unknown" && spent() === 9000 && calls.some(p => p.startsWith("/api/unstable/order-intents/")), `${still.error}, ${shop.paymentRow(first.id).status}, ${spent()}c`);
// Definite: expired, nothing spent or reserved → released once, the second $90 goes through.
intent = { status: "expired", spent: "0.00" };
const fourth = asked("90.00");
const paid = await shop.payApproved({ conversationId: AMA, paymentId: fourth.id, confirmationId: 4 });
const lines = db.listSpend(AMA, trust.spendDay());
const note = lines.find(l => l.cents === 0);
step("Crossmint: expired, $0 spent → second $90 under the $100 cap is paid", paid.ok === true && shop.paymentRow(first.id).status === "failed" && spent() === 9000, `${JSON.stringify({ ok: paid.ok, error: paid.error })}, first ${shop.paymentRow(first.id).status}, ${spent()}c`);
step("ledger keeps a $0 note for the released line", /\(CROSSMINT CONFIRMED NOT CHARGED, not counted\)$/.test(note?.what ?? ""), note?.what);
const r2 = await shop.settleUnknownPayments();
step("released once: a second settle releases nothing", r2 === 0 && spent() === 9000 && db.listSpend(AMA, trust.spendDay()).filter(l => l.cents === 0).length === 1, `released ${r2}, ${spent()}c`);

// Before #357: an unknown row the ledger never counted. Boot's backfillSpend counts it once.
const BEN = "dm:drive:ben";
db.upsertAccount({ conversationId: BEN, channel: "fake", address: "+12025550124", name: "Ben", isOperator: false });
const old = shop.recordPayment({ conversationId: BEN, runId: "run_old", item: "Lamp", request: { requestId: "req_old", request: {
  question: "Approve $30", expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
  interaction: { kind: "payment", method: "card", amount: { kind: "exact", value: "30.00", currency: "USD" }, merchant: { name: "Target", url: "https://www.target.com", countryCode: "US" } } } } });
q("UPDATE shop_payments SET status = 'unknown', answered_at = ? WHERE id = ?").run(clock.now(), old.id);
const b1 = await shop.backfillSpend();
const benSpent = () => db.spentToday(BEN, trust.spendDay()).cents;
step("backfillSpend counts an old unknown row", b1 >= 1 && benSpent() === 3000, `added ${b1}, Ben ${benSpent()}c, line ${db.listSpend(BEN, trust.spendDay())[0]?.what}`);
const b2 = await shop.backfillSpend();
step("a second backfill adds nothing", b2 === 0 && benSpent() === 3000 && spent() === 9000, `added ${b2}`);

console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
