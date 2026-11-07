#!/usr/bin/env node
// The spend warnings (#374, 2026-11-07), in process, no model, no network, nothing sent.
//
//   REASON_DB_PATH=$(mktemp -d)/x.db node .agents/skills/verify-reason/bin/spend-alert-drive.mjs
//
// Run from the repo root. Refuses without REASON_DB_PATH (never the checkout's data/reason.db).
// Drives the real src/spend.js + src/ops.js against a throwaway database with a fake owner thread:
//   1. 80% daily heads-up: none at 78%, one at 81%, none again that day;
//   2. 80% monthly heads-up, once;
//   3. at the cap: no 80% line;
//   4. the provider's usage-limit refusal (11-05 wording) texts once per episode; a 429 rate limit
//      does not; a success within 60 s of the last refusal does not end it (LIFT_MARGIN_MS); one
//      later does, and the next refusal texts again;
//   5. the /ops rows from the real runChecks: "API usage limit (provider)" bad + quiet, then ok
//      "not hit now · last hit …"; "API spend" carries "daily 80% warning sent … UTC";
//   6. startOps wiring: the pass sends the 80% line through runtime.say to the owner, toMaster, ops: key.
// Prints one line per step and "all ok" (exit 0) or the failures (exit 1).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.REASON_DB_PATH) { console.error("set REASON_DB_PATH to a throwaway file"); process.exit(2); }
process.env.REASON_DATA_DIR ||= mkdtempSync(join(tmpdir(), "spend-alert-data-"));
process.env.REASON_CONVERSATION ||= "dm:owner";
process.env.ANTHROPIC_API_KEY = "";

const root = process.cwd();
const db = await import(join(root, "src/db.js"));
const { config, clock } = await import(join(root, "src/config.js"));
const spend = await import(join(root, "src/spend.js"));
const ops = await import(join(root, "src/ops.js"));

const fails = [];
const step = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fails.push(name); };
const sent = [];
const send = (text, key) => { sent.push({ text, key }); };
const at = (iso) => { clock.reset(); clock.skip(Date.parse(iso) - Date.now()); return clock.now(); };
const spendUsd = (usd, when, feature = "reply") =>
  spend.recordApi({ feature, model: "claude-opus-5-5", usage: { input_tokens: Math.round(usd / 4 * 1e6) }, at: when });
const LIMIT = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}'), { status: 400 });
const RATE = Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), { status: 429 });

config.apiDailyCapUsd = 60; config.apiMonthlyCapUsd = 1200; config.apiCallDailyCapUsd = 6;
const reset = () => { sent.length = 0; db.db.exec("DELETE FROM model_usage; DELETE FROM ops_state; DELETE FROM ops_checks;"); spend.stopAlerts(); spend.resetApiOut(); };

// 1. daily 80%
reset();
let now = at("2026-11-07T15:00:00Z");
spendUsd(47, now);
step("78% of the daily cap: nothing", spend.capWarnings({ send, now }).length === 0);
spendUsd(2, now);
spend.capWarnings({ send, now });
step("81%: one heads-up", sent.length === 1 && /81% of the daily cap, \$49\.00 of \$60\.00 today \(phone calls not counted\)/.test(sent[0]?.text) && sent[0]?.key === "ops:api_warn:daily:2026-11-07", sent[0]?.text);
spendUsd(5, now);
spend.capWarnings({ send, now: now + 60_000 });
step("later that day: no second", sent.length === 1);

// 2. monthly 80%
reset();
now = at("2026-11-20T15:00:00Z");
for (let d = 1; d <= 19; d++) spendUsd(51, Date.parse(`2026-11-${String(d).padStart(2, "0")}T15:00:00Z`));
spend.capWarnings({ send, now });
const monthly = sent.filter(s => /monthly cap/.test(s.text));
step("80% of the monthly cap: one heads-up", monthly.length === 1 && monthly[0].key === "ops:api_warn:monthly:2026-11", monthly[0]?.text);
spend.capWarnings({ send, now: now + 3_600_000 });
step("monthly: once per month", sent.filter(s => /monthly cap/.test(s.text)).length === 1);

// 3. at the cap
reset();
now = at("2026-11-07T15:00:00Z");
spendUsd(61, now);
step("past the daily cap: no 80% line", spend.capWarnings({ send, now }).length === 0 && sent.length === 0);

// 4. usage-limit episode
reset();
now = at("2026-11-05T22:05:03Z");
spend.startAlerts({ send });
spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: RATE, at: now });
step("429 rate limit: not a usage limit", sent.length === 0 && spend.limitHit() === null);
spend.recordApi({ feature: "said", model: "claude-opus-5-5", error: LIMIT, at: now });
step("first usage-limit refusal: owner texted", sent.length === 1 && /workspace usage limit is reached.*until 2026-12-01 at 00:00 UTC \(the API's words\)/.test(sent[0]?.text) && sent[0]?.key.startsWith("ops:api-limit:"), sent[0]?.text);
for (let i = 0; i < 4; i++) spend.recordApi({ feature: "harm", model: "claude-opus-5-5", error: LIMIT, at: now + 7000 + i });
step("four more refusals: no more texts", sent.length === 1 && spend.limitHit()?.count === 5);
const report1 = await ops.runChecks({ now: now + 10_000, probe: async () => ({ ok: true }), usageFetch: async () => new Response("{}") });
const row1 = report1.checks?.find?.(c => c.id === "api_limit") ?? report1.find?.(c => c.id === "api_limit");
step("/ops row bad + quiet while refused", row1?.state === "bad" && row1?.quiet === true && /5 refused · access back 2026-12-01 at 00:00 UTC per the API · owner texted/.test(row1?.detail), `${row1?.label}: ${row1?.detail}`);
spendUsd(0.01, now + 30_000);
step("a success under 60 s after the last refusal (LIFT_MARGIN_MS): episode stays open", spend.limitHit()?.count === 5);
spendUsd(0.01, now + 70_000);
step("a paid call through 60 s+ later: episode over", spend.limitHit() === null);
const report2 = await ops.runChecks({ now: now + 80_000, probe: async () => ({ ok: true }), usageFetch: async () => new Response("{}") });
const row2 = (report2.checks ?? report2).find(c => c.id === "api_limit");
step("/ops row ok, last hit shown", row2?.state === "ok" && /^not hit now · last hit 2026-11-05 22:05 UTC, over .* \(5 refused\)$/.test(row2?.detail), row2?.detail);
spend.recordApi({ feature: "reply", model: "claude-opus-5-5", error: LIMIT, at: now + 120_000 });
step("next episode texts again", sent.length === 2);

// 5. the spend row says the warning went
reset();
now = at("2026-11-07T15:00:00Z");
spendUsd(49, now);
spend.capWarnings({ send, now });
const report3 = await ops.runChecks({ now, probe: async () => ({ ok: true }), usageFetch: async () => new Response("{}") });
const sp = (report3.checks ?? report3).find(c => c.id === "api_spend");
step("API spend row: daily 80% warning sent, still green", sp?.state === "ok" && /daily 80% warning sent 2026-11-07 15:00 UTC/.test(sp?.detail), sp?.detail);

// 6. startOps wiring
reset();
now = at("2026-11-08T15:00:00Z");
spendUsd(50, now);
const said = [];
const runtime = { say: async (conv, text, opts) => { said.push({ conv, text, opts }); }, on: () => {} };
const handle = ops.startOps({ runtime, everyMs: 3_600_000, firstAfterMs: 50 });
await new Promise(r => setTimeout(r, 4000));
handle?.stop?.(); spend.stopAlerts();
const w = said.find(s => /heads-up/.test(s.text));
step("startOps: the pass texts the 80% line to the owner", !!w && w.conv === config.ownerConversation && w.opts?.toMaster === true && w.opts?.idempotencyKey === "ops:api_warn:daily:2026-11-08", w ? `${w.conv} ${w.opts?.idempotencyKey}` : `said ${said.length}`);

clock.reset();
console.log(fails.length ? `${fails.length} FAIL: ${fails.join("; ")}` : "all ok");
process.exit(fails.length ? 1 : 0);
