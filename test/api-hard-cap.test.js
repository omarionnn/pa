// The paid key's hard caps (2026-10-25) — one pinned test per thing the owner asked for.
//
// PR #115 only TOLD the owner when a day's paid spend passed the cap; the key could still be
// drained. He would not top it up until it could not be. Now: past the daily cap every paid use but
// phone calls goes to the subscription until local midnight; calls have their own daily cap; the
// monthly cap binds everything until the 1st; and the owner hears it once. See src/spend.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-api-cap-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const spend = await import("../src/spend.js");
const harm = await import("../src/harm.js");
const ops = await import("../src/ops.js");
const voice = await import("../src/calls/voice.js");
const { cliConfig } = await import("../src/backends/cli.js");
cliConfig.bin = join(dir, "no-claude-here");

after(() => rmSync(dir, { recursive: true, force: true }));

const env = (vars, fn) => async () => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
// Noon and 23:59 New York time on given days (EDT, UTC-4).
const ny = (iso) => Date.parse(`${iso}-04:00`);
// $ straight into the usage table: haiku at $0.10/M input, so 1M tokens is $0.10.
const spent = (feature, usd, at) => spend.recordApi({ feature, model: "claude-haiku-5-5", usage: { input_tokens: Math.round(usd * 10_000_000) }, at });
const OK = { stop_reason: "tool_use", content: [{ type: "tool_use", name: "verdict", input: { verdict: "clear" } }], usage: { input_tokens: 10, output_tokens: 5 } };

beforeEach(() => {
  spend.resetApiOut();
  db.db.exec("DELETE FROM model_usage; DELETE FROM ops_checks;");
  for (const id of ["api_spend", "api_call_cap"]) db.opsDelete(`alerted:${id}`);
  Object.assign(config, { apiDailyCapUsd: 1, apiCallDailyCapUsd: 2, apiMonthlyCapUsd: 10, callBackend: "api" });
});

test("defaults: $1 a day, $2 a day for calls, $10 a month", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/config.js", "utf8");
  assert.match(src, /apiDailyCapUsd: Number\(process\.env\.REASON_API_DAILY_CAP_USD \|\| 1\)/);
  assert.match(src, /apiCallDailyCapUsd: Number\(process\.env\.REASON_API_CALL_DAILY_CAP_USD \|\| 2\)/);
  assert.match(src, /apiMonthlyCapUsd: Number\(process\.env\.REASON_API_MONTHLY_CAP_USD \|\| 10\)/);
});

test("cap: today's spend reaching the daily cap flips the pre-reply checks to the subscription — no paid call is made", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: "claude-cli" }, async () => {
  const now = ny("2026-10-25T12:00:00");
  let apiAsks = 0, cliAsks = 0;
  harm.setScreenClient({ messages: { create: async () => { apiAsks++; return OK; } } });
  harm.setCliScreen(async () => { cliAsks++; return { verdict: "clear" }; });
  const { clock } = await import("../src/config.js");
  const off = now - clock.now(); clock.skip(off);
  try {
    spent("harm", 0.99, now);
    assert.equal(spend.apiOut("harm"), false, "under the cap: on the API");
    assert.notEqual((await harm.screen({ text: "hey" })).via, "cli_fallback");
    assert.equal(apiAsks, 1);
    spent("onethought", 0.02, now);
    assert.equal(spend.capReached()?.which, "day");
    assert.match(spend.apiSkipWhy("said_check"), /daily cap \(\$1\.00\) is reached — on the subscription until midnight/);
    assert.equal((await harm.screen({ text: "and again" })).via, "cli_fallback");
    assert.equal(apiAsks, 1, "past the cap the API is never asked");
    assert.equal(cliAsks, 1);
    // callApi itself refuses for every non-call feature, so no path can slip past.
    for (const feature of ["harm", "onethought", "said_check", "extraction", "judge", "watch"]) {
      await assert.rejects(spend.callApi({ feature, client: { messages: { create: async () => { apiAsks++; return OK; } } }, params: { model: "claude-haiku-5-5" } }), /daily cap/);
    }
    assert.equal(apiAsks, 1);
  } finally { harm.setScreenClient(null); harm.setCliScreen(null); clock.skip(-off); }
}));

test("cap: it switches back by itself at local midnight", () => {
  spent("harm", 1.5, ny("2026-10-25T12:00:00"));
  assert.equal(spend.capReached({ now: ny("2026-10-25T23:59:00") })?.which, "day");
  assert.equal(spend.apiOut("harm", ny("2026-10-25T23:59:00")), true);
  // 00:00 in New York is 04:00 UTC: the new day, nothing to reset.
  assert.equal(spend.capReached({ now: ny("2026-10-26T00:00:30") }), null);
  assert.equal(spend.apiOut("harm", ny("2026-10-26T00:00:30")), false);
});

test("cap: the monthly cap holds every paid use but calls until the 1st — then lifts", () => {
  // $0.90 a day for twelve days: never the daily cap, $10.80 for October.
  for (let d = 10; d < 22; d++) spent("harm", 0.9, ny(`2026-10-${d}T12:00:00`));
  const late = ny("2026-10-31T23:59:00");
  assert.equal(spend.capReached({ now: late })?.which, "month");
  assert.equal(spend.apiOut("call_harm", late), false, "calls are never held back, even by the month");
  assert.match(spend.apiSkipWhy("harm", late), /monthly cap \(\$10\.00\) is reached — on the subscription until the 1st/);
  // November 1st, New York time (still Oct 31 in UTC-12, already Nov 1 at 04:00 UTC).
  const first = ny("2026-11-01T00:00:30");
  assert.equal(spend.capReached({ now: first }), null);
});

test("cap: calls are never stopped or moved by any cap — past their own they keep running on the API (owner, 10-25)", env({ REASON_BACKEND: "claude-cli" }, async () => {
  const { clock } = await import("../src/config.js");
  const now = ny("2026-10-25T12:00:00");
  const off = now - clock.now(); clock.skip(off);
  try {
    spent("harm", 1.2, now);
    assert.equal(spend.apiOut("harm"), true, "the pre-reply checks are capped");
    assert.equal(spend.apiOut("call_harm"), false, "a call's own screen is not");
    assert.equal(voice.callBackendName(), "api");
    spent("call", 2.5, now);
    assert.equal(spend.callCapCheck().state, "warn", "past the call cap: said on /ops");
    assert.equal(spend.apiOut("call_harm"), false);
    assert.equal(spend.apiOut("call"), false);
    assert.equal(voice.callBackendName(), "api", "still the API, not the subscription");
    // Past the monthly cap too.
    spent("call", 20, now);
    assert.equal(spend.capReached()?.which, "month");
    assert.equal(spend.apiOut("call_harm"), false);
    assert.equal(voice.callBackendName(), "api");
    process.env.REASON_BACKEND = "";
    assert.equal(voice.callBackendName(), "api");
    assert.equal(voice.generatorFor("api").name, "apiGenerator");
    // callApi lets a call feature through past every cap.
    let asked = 0;
    await spend.callApi({ feature: "call_harm", client: { messages: { create: async () => { asked++; return { usage: {} }; } } }, params: { model: "claude-haiku-5-5" } });
    assert.equal(asked, 1);
    // Calls never count toward the general daily cap.
    db.db.exec("DELETE FROM model_usage");
    spent("call", 1.9, now);
    assert.equal(spend.capReached(), null);
  } finally { clock.skip(-off); }
}));

test("cap: the owner gets exactly one text — not one per message, none at the midnight lift", env({ ANTHROPIC_API_KEY: "sk-test", REASON_BACKEND: "claude-cli" }, async () => {
  const sent = [];
  const runtime = { say: (c, text) => sent.push({ c, text }) };
  const t0 = ny("2026-10-25T15:00:00");
  const pass = (at) => {
    const sp = spend.spendCheck({ now: at });
    const cc = spend.callCapCheck({ now: at });
    const checks = [
      { id: "api_spend", group: "money", label: "API spend", ...sp },
      { id: "api_call_cap", group: "money", label: "Phone calls on the API", ...cc },
    ];
    ops.settle({ report: { at, checks, verdict: checks.every(c => c.state === "ok") ? "ok" : "warn" }, runtime });
  };
  pass(t0);
  spent("harm", 1.1, t0);
  // Messages keep coming all afternoon, each adding spend on record, across many ops passes.
  for (let i = 1; i <= 8; i++) { spent("said_check", 0.01, t0 + i * ops.ALERT_AFTER_MS); pass(t0 + i * ops.ALERT_AFTER_MS); }
  assert.equal(sent.length, 1, "one text for the whole day");
  assert.equal(sent[0].c, config.ownerConversation);
  assert.match(sent[0].text, /API daily cap reached \(\$1\.00\), the pre-reply checks are on the subscription until midnight\./);
  // Midnight: the cap lifts with no text at 00:00.
  pass(ny("2026-10-26T00:05:00"));
  pass(ny("2026-10-26T00:15:00"));
  assert.equal(sent.length, 1, "the lift is silent");
  // The call cap is its own one text — a heads-up only.
  const t1 = ny("2026-10-26T12:00:00");
  spent("call", 2.5, t1);
  for (let i = 0; i < 5; i++) pass(t1 + i * ops.ALERT_AFTER_MS);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Phone calls passed the \$2\.00 API cap today \(\$2\.50 so far\)\. They keep running on the API; this is a heads-up only\./);
  assert.doesNotMatch(sent[1].text, /pre-reply checks are on the subscription/, "the general cap is not hit by calls");
}));

test("cap: a day already texted for the daily cap still hears the monthly cap", env({ REASON_BACKEND: "claude-cli" }, () => {
  const sent = [];
  const runtime = { say: (c, text) => sent.push(text) };
  const pass = (at) => ops.settle({ report: { at, checks: [{ id: "api_spend", group: "money", label: "API spend", ...spend.spendCheck({ now: at }) }], verdict: "warn" }, runtime });
  for (let d = 1; d < 25; d++) spent("harm", 0.37, ny(`2026-10-${String(d).padStart(2, "0")}T09:00:00`));
  const t0 = ny("2026-10-25T14:00:00");
  spent("harm", 1.0, t0);
  for (let i = 0; i < 3; i++) pass(t0 + i * ops.ALERT_AFTER_MS);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /API daily cap reached/);
  const t1 = ny("2026-10-25T18:00:00");
  spent("harm", 0.5, t1);
  for (let i = 0; i < 3; i++) pass(t1 + i * ops.ALERT_AFTER_MS);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /API monthly cap reached \(\$10\.00\), the pre-reply checks are on the subscription until the 1st\. Phone calls keep running on the API\./);
}));

test("ops: the spend row reads '$X of $cap today · $Y of $cap this month'", () => {
  const now = ny("2026-10-25T12:00:00");
  spent("harm", 0.4, now);
  spent("call", 0.5, now);
  spent("harm", 2, ny("2026-10-03T12:00:00"));
  const row = spend.spendCheck({ now });
  assert.equal(row.state, "ok");
  assert.match(row.detail, /^\$0\.400 of \$1\.00 today · calls \$0\.500 of \$2\.00 · \$2\.90 of \$10\.00 this month/);
});
