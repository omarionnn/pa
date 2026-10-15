#!/usr/bin/env node
// One-shot: fix the AgentCard webhook endpoint URL (trailing dot) and event list.
// Run once on Hetzner: node scripts/fix-webhook-endpoint.mjs
// Safe to re-run — PATCHes are idempotent.

import { getAccessToken } from "../src/agentcard.js";

const BASE = process.env.AGENTCARD_API_BASE || "https://api.agentcard.sh";
const ENDPOINT_ID = "we_20e70530cc3c010b79cf4347";
const CORRECT_URL = "https://reason.tail3753c7.ts.net/agentcard/webhook";
const CORRECT_EVENTS = ["vault.*", "checkout_authorization.*", "order.*"];

const { ok, token } = await getAccessToken();
if (!ok) { console.error("cannot get org token"); process.exit(1); }

// Read current state
const before = await fetch(`${BASE}/api/v2/webhook_endpoints/${ENDPOINT_ID}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const beforeBody = await before.json();
console.log("BEFORE:", JSON.stringify({
  url: beforeBody.url,
  enabled_events: beforeBody.enabled_events,
  last_success_at: beforeBody.last_success_at,
}, null, 2));

// PATCH
const res = await fetch(`${BASE}/api/v2/webhook_endpoints/${ENDPOINT_ID}`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: CORRECT_URL, enabled_events: CORRECT_EVENTS }),
});
const body = await res.json();
console.log("PATCH", res.status, JSON.stringify({
  url: body.url,
  enabled_events: body.enabled_events,
}, null, 2));

if (res.status >= 200 && res.status < 300) {
  console.log("webhook endpoint fixed.");
} else {
  console.error("PATCH failed:", JSON.stringify(body));
  process.exit(1);
}
