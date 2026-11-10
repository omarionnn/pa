// The status page fixes of 2026-11-09, found by reading the live page as the owner sees it:
//
//   - Reason's own Twilio line texted the Sendblue line once; Sendblue refused to text it back, and
//     the page went red with "texts over sendblue are failing". A text to Reason's own line is not
//     counted, and the line is not a person in the People count.
//   - A follow-up that died with its head inherits the head's reason, so a person's own refusal
//     (opted out) is amber for both rows, not red for the second.
//   - Gemini's key probe answered 200 every pass while every real Gemini call 404'd for four days,
//     and the row stayed green. A real call failing since the last good one is amber, quietly.
//   - The backups (rolling copy on the server, encrypted off-site) were not on the page at all.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-opsfix-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SEARCH_PROVIDER = "parallel";
process.env.PARALLEL_API_KEY = "test-parallel";
process.env.OPENAI_API_KEY = "test-openai";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.REASON_CALL_PROVIDER = "fake";
process.env.TWILIO_FROM_NUMBER = "+15550009999";

import os from "node:os";
os.loadavg = () => [0.5, 0.5, 0.5];
const ops = await import("../src/ops.js");
const db = await import("../src/db.js");
const { renderOps } = await import("../src/pages/ops.js");
const { clock, isOwnLine } = await import("../src/config.js");

const OK = async () => ({ ok: true, status: 200 });
const runtime = { say: () => {}, interval: {}, lastSweepAt: clock.now(), on() {} };
const H = 60 * 60_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM ops_checks; DELETE FROM ops_state; DELETE FROM provider_calls; DELETE FROM provider_state;
    DELETE FROM outbox; DELETE FROM accounts; DELETE FROM usage;`);
  runtime.lastSweepAt = clock.now();
  for (const f of ["reason.db.bak-rolling", "offsite-backup.json"]) rmSync(join(dir, f), { force: true });
});

let seq = 0;
function outboxRow({ address, state = "failed", error = "x", key = null, afterId = null }) {
  const now = clock.now();
  const r = db.db.prepare(`INSERT INTO outbox (idem_key, conversation_id, channel, address, body, state, attempts, last_error, last_error_key, after_id, created_at, updated_at, failed_at)
    VALUES (?, 'dm:x', 'sendblue', ?, 'hi', ?, 1, ?, ?, ?, ?, ?, ?)`).run(`k${++seq}`, address, state, error, key, afterId, now, now, state === "failed" ? now : null);
  return Number(r.lastInsertRowid);
}

test("isOwnLine knows Reason's own from-number in any spelling, and nothing else", () => {
  assert.equal(isOwnLine("+1 (555) 000-9999"), true);
  assert.equal(isOwnLine("15550009999"), true);
  assert.equal(isOwnLine("+15550001111"), false);
  assert.equal(isOwnLine(""), false);
  assert.equal(isOwnLine("someone@example.com"), false);
});

test("a text to Reason's own line that failed is not counted: Texts out stays green and says so", async () => {
  outboxRow({ address: "+15550009999", error: "Sendblue refused it (HTTP 400): BillingRule", key: "INBOUND_ONLY_PLAN" });
  const row = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "outbox");
  assert.equal(row.state, "ok", row.detail);
  assert.match(row.detail, /1 text to Reason's own line not counted/);
});

test("a real person's failure next to it is still red, and the own-line one is still left out of the count", async () => {
  outboxRow({ address: "+15550009999", key: "INBOUND_ONLY_PLAN" });
  outboxRow({ address: "+15550002222", error: "Sendblue refused it (HTTP 400): something" });
  const row = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "outbox");
  assert.equal(row.state, "bad");
  assert.match(row.detail, /^1 text failed in the last day — Sendblue refused it/);
});

test("a follow-up that dies with its head carries the head's reason: an opt-out is amber for both, not red", async () => {
  const head = outboxRow({ address: "+15550003333", state: "queued" });
  const follow = outboxRow({ address: "+15550003333", state: "queued", afterId: head });
  db.markOutboundFailed(head, { error: "they've opted out", errorKey: "OPTED_OUT" });
  assert.equal(db.db.prepare("SELECT last_error_key AS k FROM outbox WHERE id = ?").get(follow).k, "OPTED_OUT");
  const row = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "outbox");
  assert.equal(row.state, "warn", row.detail);
  assert.match(row.detail, /2 texts failed/);
});

test("a probed provider whose key works but whose real calls fail is amber and quiet, until a real call works again", async () => {
  const day = (await import("../src/accounts.js")).today(clock.now());
  db.recordProviderCall({ provider: "gemini", day, ok: true, status: 200, ms: 10, error: "" });
  clock.skip(1000);
  db.recordProviderCall({ provider: "gemini", day, ok: false, status: 404, ms: 10, error: "HTTP 404" });
  let report = await ops.runChecks({ runtime, probe: OK });
  let row = report.checks.find(c => c.id === "provider:gemini");
  assert.equal(row.state, "warn", row.detail);
  assert.equal(row.quiet, true, "the key works: shown on the page, never texted");
  assert.match(row.detail, /key works, but the last real call failed .* ago: HTTP 404/);

  // Settling it texts nobody, even once it has stayed amber past the alert delay — and nothing is
  // held for the digest either.
  const said = [];
  const say = { say: (c, t) => said.push(t) };
  let settled = ops.settle({ report, runtime: say });
  clock.skip(ops.ALERT_AFTER_MS + 60_000);
  runtime.lastSweepAt = clock.now();
  report = await ops.runChecks({ runtime, probe: OK });
  assert.equal(report.checks.find(c => c.id === "provider:gemini").state, "warn");
  settled = ops.settle({ report, runtime: say });
  assert.ok(!settled.changes.some(ch => ch.check.id === "provider:gemini"), "no alert for the quiet row");
  assert.ok(!said.some(t => /Gemini/.test(t)), said.join("\n"));
  assert.ok(!(db.opsGet("alerted:provider:gemini")), "never marked as told");

  // A good real call afterwards is green again, with the failure still counted in the tail.
  clock.skip(1000);
  db.recordProviderCall({ provider: "gemini", day, ok: true, status: 200, ms: 10, error: "" });
  row = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "provider:gemini");
  assert.equal(row.state, "ok");
  assert.match(row.detail, /working · 3 calls today, 1 failed · last failure .* ago/);
});

test("an old failure, more than a day back, does not hold a probed provider amber", async () => {
  const now = clock.now();
  db.db.prepare("INSERT INTO provider_state (provider, last_ok_at, last_fail_at, last_status, last_error) VALUES ('gemini', ?, ?, 404, 'HTTP 404')").run(now - 3 * 24 * H, now - 2 * 24 * H);
  const row = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "provider:gemini");
  assert.equal(row.state, "ok");
});

test("backups: off with nothing set up, ok when both are fresh, amber when either is late, red and quiet when off-site failed", () => {
  const now = clock.now();
  assert.equal(ops.backupCheck(now, dir).state, "off");

  const rolling = join(dir, "reason.db.bak-rolling");
  writeFileSync(rolling, "x");
  utimesSync(rolling, new Date(now - 5 * H), new Date(now - 5 * H));
  const off = join(dir, "offsite-backup.json");
  writeFileSync(off, JSON.stringify({ ok: true, at: new Date(now - 2 * H).toISOString(), snapshot: "6c115e85", step: "done" }));
  let row = ops.backupCheck(now, dir);
  assert.equal(row.state, "ok", row.detail);
  assert.match(row.detail, /server copy 5h ago · off-site 2h ago · snapshot 6c115e85/);
  assert.equal(row.group, "alive");

  utimesSync(rolling, new Date(now - 14 * H), new Date(now - 14 * H));
  row = ops.backupCheck(now, dir);
  assert.equal(row.state, "warn");
  assert.match(row.detail, /server copy 14h ago — late/);
  assert.ok(!row.quiet, "a copy that stopped being made tells nobody else, so this row does");

  utimesSync(rolling, new Date(now - H), new Date(now - H));
  writeFileSync(off, JSON.stringify({ ok: true, at: new Date(now - 30 * H).toISOString(), snapshot: "a" }));
  assert.equal(ops.backupCheck(now, dir).state, "warn");

  writeFileSync(off, JSON.stringify({ ok: false, at: new Date(now - H).toISOString(), step: "upload", message: "ssh: connection refused" }));
  row = ops.backupCheck(now, dir);
  assert.equal(row.state, "bad");
  assert.equal(row.quiet, true, "the backup script texts its own failure");
  assert.match(row.detail, /off-site FAILED 1h ago at upload: ssh: connection refused/);

  rmSync(off);
  row = ops.backupCheck(now, dir);
  assert.equal(row.state, "warn");
  assert.match(row.detail, /no off-site copy/);
});

test("the backups row is on the page, in Is it alive", async () => {
  const report = await ops.runChecks({ runtime, probe: OK });
  assert.ok(report.checks.find(c => c.id === "backup"), "a backups row in every report");
});

test("Reason's own line is listed in People with a tag, and never counted as a person", async () => {
  const now = clock.now();
  db.db.prepare("INSERT INTO accounts (conversation_id, channel, address, name, created_at, last_seen_at) VALUES ('dm:sendblue:+15550009999', 'sendblue', '+15550009999', '', ?, ?)").run(now, now);
  db.db.prepare("INSERT INTO accounts (conversation_id, channel, address, name, created_at, last_seen_at) VALUES ('dm:sendblue:+15550004444', 'sendblue', '+15550004444', 'Nia', ?, ?)").run(now, now);
  const report = await ops.runChecks({ runtime, probe: OK });
  assert.match(report.checks.find(c => c.id === "people").detail, /^1 person on the line · 1 texted in the last day/);
  const own = report.people.find(p => p.address === "+15550009999");
  assert.equal(own.own_line, true);
  const html = renderOps({ report, now });
  assert.match(html, /Reason&#39;s own line|Reason's own line/);
  assert.match(html, /1 on the line · 1 active today/);
});

test("a real call that timed out, then a good probe, is a blip: the probed row stays green", async () => {
  const day = (await import("../src/accounts.js")).today(clock.now());
  db.recordProviderCall({ provider: "gemini", day, ok: false, status: 0, ms: 10, error: "The operation was aborted due to timeout" });
  const row = (await ops.runChecks({ runtime, probe: OK })).checks.find(c => c.id === "provider:gemini");
  assert.equal(row.state, "ok", row.detail);
});
