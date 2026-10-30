// Asks for a yes run out (2026-10-30). Before this an ask never expired: live had call asks from
// Oct 10 still open, and a "yeah" this week would have granted one. Expired means NO, never yes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "reason-stale-asks-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONFIRM_WINDOW_MIN = "10";
process.env.REASON_TZ = "America/New_York";
delete process.env.REASON_ASK_TTL_REACH_H;
delete process.env.REASON_ASK_TTL_MONEY_H;
delete process.env.REASON_ASK_TTL_DEFAULT_H;

const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const C = "dm:stale";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025550111", name: "Omari", isOperator: true });
const owner = (t) => ({ role: "user", content: `[Fri, Oct 30, 2026, 9:00 AM] Omari: ${t}` });
const readsYes = async () => ({ verdict: "yes" });
const H = 3_600_000;

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM confirmations; DELETE FROM tasks;");
});

function ask(action, { summary = `do ${action}`, target = "", amount = null, messages = [owner("hi")] } = {}) {
  return trust.requestConfirmation({ conversationId: C, messages, action, summary, stakes: "", target, amount }).confirmation_id;
}
const record = (id, messages) => trust.recordConfirmation({ conversationId: C, messages, confirmationId: id, judge: readsYes });

test("expiry per kind: calls/texts 12h, purchases 24h, everything else 24h", () => {
  assert.equal(db.askTtlMs({ action: "call_place" }), 12 * H);
  assert.equal(db.askTtlMs({ action: "message_send" }), 12 * H);
  assert.equal(db.askTtlMs({ action: "mcp__reason__call_place" }), 12 * H);
  assert.equal(db.askTtlMs({ action: "purchase_confirm" }), 24 * H);
  assert.equal(db.askTtlMs({ action: "browser_submit", amount_cents: 1678 }), 24 * H);
  assert.equal(db.askTtlMs({ action: "calendar_create" }), 24 * H);

  const call = ask("call_place", { target: "+12125550100" });
  const buy = ask("purchase_confirm", { amount: 16.78 });
  clock.skip(13 * H);
  const open = db.pendingConfirmations(C).map(r => r.id);
  assert.deepEqual(open, [buy], "the call ask ran out at 12h; the purchase is still open");
  clock.skip(12 * H);
  assert.deepEqual(db.pendingConfirmations(C), [], "the purchase ran out at 24h");
  assert.ok(db.getConfirmation(C, call).expired_at && db.getConfirmation(C, buy).expired_at);
  assert.equal(db.getConfirmation(C, buy).granted_at, null, "expiry never grants");
});

test("a late yes after expiry does not grant, and the gated tool refuses", async () => {
  const id = ask("purchase_confirm", { summary: "buy CeraVe cleanser, $16.78", amount: 16.78 });
  clock.skip(25 * H);
  const r = await record(id, [owner("hi"), owner("yes go ahead")]);
  assert.equal(r.ok, false);
  assert.equal(r.state, "expired");
  assert.match(r.error, /re-check the current details/);
  assert.match(r.error, /confirm_request fresh/);
  const row = db.getConfirmation(C, id);
  assert.equal(row.granted_at, null, "no yes was written");
  assert.ok(row.expired_at);
  const gate = trust.authorizeConfirmation({ conversationId: C, action: "purchase_confirm", confirmationId: id });
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked, "expired");
});

test("authorize refuses an expired call ask even when the row was never swept", () => {
  const id = ask("call_place", { target: "+12125550100" });
  // Nothing read the pending list, so the row is not marked: the gate itself must still refuse.
  clock.skip(13 * H);
  const gate = trust.authorizeConfirmation({ conversationId: C, action: "call_place", confirmationId: id, target: "+12125550100" });
  assert.equal(gate.ok, false);
  assert.equal(gate.blocked, "expired");
});

test("a fresh confirm_request after an expired one works normally", async () => {
  const old = ask("call_place", { target: "+12125550100" });
  clock.skip(13 * H);
  assert.equal((await record(old, [owner("hi"), owner("yes")])).state, "expired");
  const msgs = [owner("hi"), owner("yes")];
  const fresh = ask("call_place", { target: "+12125550100", messages: msgs });
  const r = await record(fresh, [...msgs, owner("yes call them")]);
  assert.equal(r.state, "granted");
  const gate = trust.authorizeConfirmation({ conversationId: C, action: "call_place", confirmationId: fresh, target: "+12125550100" });
  assert.equal(gate.ok, true);
});

test("a granted yes never used past the window is closed", async () => {
  const id = ask("gmail_send");
  assert.equal((await record(id, [owner("hi"), owner("yes")])).state, "granted");
  assert.equal(db.pendingConfirmations(C).length, 1, "inside the window it is still open");
  clock.skip(11 * 60_000);
  assert.deepEqual(db.pendingConfirmations(C), [], "past the window it is closed");
  assert.ok(db.getConfirmation(C, id).expired_at);
  const r = await record(id, [owner("hi"), owner("yes"), owner("yes")]);
  assert.equal(r.state, "expired", "an old yes is not handed back as granted");
  const gate = trust.authorizeConfirmation({ conversationId: C, action: "gmail_send", confirmationId: id });
  assert.equal(gate.ok, false);
});

test("the once-only mention: shown on the next turn, then never again", () => {
  ask("purchase_confirm", { summary: "buy CeraVe cleanser, $16.78", amount: 16.78 });
  assert.equal(trust.expiredAsksNote(C), "", "nothing ran out yet");
  clock.skip(25 * H);
  const note = trust.expiredAsksNote(C);
  assert.match(note, /ran out without an answer/);
  assert.match(note, /CeraVe/);
  assert.match(note, /at most one short line/);
  assert.match(note, /Never do any of these/);
  assert.equal(trust.expiredAsksNote(C), "", "shown once only");
  clock.skip(48 * H);
  assert.equal(trust.expiredAsksNote(C), "");
});

test("task-closing check treats an expired ask as a no", () => {
  const task = db.createTask(C, { title: "order cleanser", goal: "buy it", maxAttempts: 3 });
  ask("purchase_confirm", { amount: 16.78 });
  assert.equal(db.unexecutedGatesFor(C, task).length, 1, "open ask holds the task");
  clock.skip(25 * H);
  assert.deepEqual(db.unexecutedGatesFor(C, task), [], "expired ask no longer holds it, like a refused one");
});

// The deploy sweep runs in its own process on the real clock, so rows are written already old.
const script = fileURLToPath(new URL("../scripts/expire-stale-asks.js", import.meta.url));
function oldRow(action, hoursAgo, summary) {
  const r = db.db.prepare(`INSERT INTO confirmations (conversation_id, action, summary, stakes, target, asked_at, asked_after_msgs)
    VALUES (?, ?, ?, '', '', ?, 0)`).run(C, action, summary, Date.now() - hoursAgo * H);
  return Number(r.lastInsertRowid);
}
const runSweep = (...args) => spawnSync(process.execPath, [script, ...args], {
  env: { PATH: process.env.PATH, REASON_DB_PATH: process.env.REASON_DB_PATH, REASON_TZ: "America/New_York" }, encoding: "utf8",
});

test("sweep --dry-run lists what would close and writes nothing", () => {
  const a = oldRow("call_place", 20 * 24, "call Renew Body Spa");
  const b = oldRow("purchase_confirm", 30, "buy CeraVe");
  const fresh = oldRow("purchase_confirm", 1, "buy socks");
  const out = runSweep("--dry-run");
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.filter(l => l.id).map(l => l.id).sort(), [a, b].sort());
  assert.equal(lines.at(-1).expire_stale_asks, "dry_run");
  for (const id of [a, b, fresh]) assert.equal(db.getConfirmation(C, id).expired_at, null, "dry run wrote nothing");
});

test("sweep closes overdue rows, logs them, sends nothing; week-old ones close quietly", () => {
  const a = oldRow("call_place", 20 * 24, "call Renew Body Spa");
  const b = oldRow("purchase_confirm", 30, "buy CeraVe");
  const fresh = oldRow("purchase_confirm", 1, "buy socks");
  const outboxBefore = db.outboxMark();
  const out = runSweep();
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n").map(l => JSON.parse(l));
  const logged = lines.filter(l => l.id);
  assert.deepEqual(logged.map(l => l.id).sort(), [a, b].sort());
  for (const l of logged) assert.ok(l.action && l.summary && Number.isFinite(l.age_h));
  assert.equal(db.outboxMark(), outboxBefore, "nothing queued to send");
  assert.ok(db.getConfirmation(C, a).expired_at && db.getConfirmation(C, a).expiry_told_at, "20 days old: closed quietly");
  assert.ok(db.getConfirmation(C, b).expired_at);
  assert.equal(db.getConfirmation(C, b).expiry_told_at, null, "30h old: still mentioned once");
  assert.equal(db.getConfirmation(C, fresh).expired_at, null);
  const note = trust.expiredAsksNote(C);
  assert.match(note, /CeraVe/);
  assert.doesNotMatch(note, /Renew Body Spa/);
});
