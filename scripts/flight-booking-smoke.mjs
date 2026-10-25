#!/usr/bin/env node
// The one gated live smoke test for flight booking (owner's spec, Step 8c). Run it BY HAND after an
// install or an upgrade of the AgentCard side — never on a schedule, never from CI.
//
//   REASON_FLIGHT_SMOKE=1 AGENTCARD_SMOKE_USER_ID=usr_… node scripts/flight-booking-smoke.mjs [path/to/.env]
//
// What it does, against AgentCard's SANDBOX and nothing else:
//   1. reads ONLY AGENTCARD_SANDBOX_CLIENT_ID / _SECRET out of the env file (default ./.env),
//   2. mints an org token and REFUSES to go on unless AgentCard's answer says `sandbox: true`,
//   3. one purchase conversation for a sandbox user: a flight search, a pick, a test passenger,
//   4. reads the cart the way Reason does (src/agentcard.js readTurn → src/flightbook.js priceView),
//   5. the sandbox confirm, which must come back `declined` / `sandbox_mode` / `charge_status: none`.
//
// It never reads AGENTCARD_CLIENT_ID / AGENTCARD_CLIENT_SECRET (production), never calls a refresh
// endpoint, and cannot place an order: sandbox stops before payment by AgentCard's design.
import { readFileSync } from "node:fs";
import { readTurn } from "../src/agentcard.js";
import { priceView, priceLines, isFlightCart, TICKETING_FIELDS } from "../src/flightbook.js";

if (process.env.REASON_FLIGHT_SMOKE !== "1") {
  console.error("Refusing: set REASON_FLIGHT_SMOKE=1 to run the flight booking smoke test (sandbox only, by hand).");
  process.exit(2);
}
const userId = process.env.AGENTCARD_SMOKE_USER_ID ?? "";
if (!/^usr_[A-Za-z0-9]+$/.test(userId)) {
  console.error("Refusing: AGENTCARD_SMOKE_USER_ID must be a SANDBOX user id (usr_…) connected to the sandbox org.");
  process.exit(2);
}
const envFile = process.argv[2] ?? ".env";
const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n")
  .filter(l => /^AGENTCARD_SANDBOX_CLIENT_(ID|SECRET)=/.test(l))
  .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const base = "https://api.agentcard.sh";
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok   ${m}`);

const tokRes = await fetch(`${base}/api/v2/oauth/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.AGENTCARD_SANDBOX_CLIENT_ID ?? "", client_secret: env.AGENTCARD_SANDBOX_CLIENT_SECRET ?? "" }).toString(),
});
const tok = await tokRes.json().catch(() => ({}));
if (!tokRes.ok || !tok.access_token) fail(`no sandbox token (HTTP ${tokRes.status})`);
if (tok.sandbox !== true) fail("the token is not a sandbox token — stopping before any /buy call");
ok("sandbox org token (sandbox: true)");

async function buy(body) {
  const r = await fetch(`${base}/buy`, { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, user_id: userId }), signal: AbortSignal.timeout(140_000) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) fail(`/buy answered HTTP ${r.status}: ${b?.error?.message ?? b?.message ?? b?.error ?? ""}`);
  return readTurn(b);
}

const day = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
const t1 = await buy({ ask: `Book a one-way economy flight for 1 adult from JFK to BOS on ${day}, cheapest nonstop` });
const offer = t1.catalog?.items?.find(i => i.flight);
if (!offer) fail(`no flight offers in the catalog (status ${t1.status})`);
ok(`search: ${t1.catalog.items.length} offers, first ${offer.name} ${offer.price}`);

const t2 = await buy({ ask: "This one.", conversation_id: t1.conversation_id, pick: { product_id: offer.product_id } });
if (!isFlightCart(t2.cart)) fail(`no flight cart after the pick (status ${t2.status}, next ${t2.next_action})`);
ok(`cart ${t2.cart.hash}, next_action ${t2.next_action}`);

const t3 = await buy({ ask: "Passenger 1: Testy Spikeson (legal name exactly as on the government ID), date of birth 1990-01-15, gender male, email spike-test@example.com, phone +12025550143.", conversation_id: t1.conversation_id });
if (t3.next_action !== "confirm") fail(`AgentCard did not reach confirm after the passenger (next ${t3.next_action})`);
if (t3.cart?.hash !== t2.cart.hash) console.log(`note the cart hash CHANGED with the passenger (${t2.cart.hash} → ${t3.cart?.hash}) — Reason's traveler pin still holds either way`);
const view = priceView(t3.cart);
for (const l of priceLines(view)) console.log(`     ${l}`);
console.log(`     estimate flag sent: ${t3.cart.estimate_flag_sent}; final: ${view.final} (${view.finality})`);

const t4 = await buy({ conversation_id: t1.conversation_id, confirm: t3.cart.hash, payment_source: "vault" });
if (t4.status !== "declined" || t4.decline_code !== "sandbox_mode") fail(`the sandbox confirm did not stop at sandbox_mode (status ${t4.status}, code ${t4.decline_code})`);
if (t4.charge_status && t4.charge_status !== "none") fail(`sandbox confirm reports charge_status ${t4.charge_status}`);
ok("sandbox confirm: declined, sandbox_mode, nothing charged");
console.log(`\nTicketing fields known: ${JSON.stringify(TICKETING_FIELDS)} — a placed flight order can only be seen with live credentials and real money (the owner's decision).`);
