// GET /health answers anybody who can reach the listener — through the Tailscale Funnel that is the
// whole internet, and Funnel traffic arrives from the local tailscaled, so the remote address says
// nothing about who is asking. So the answer a stranger gets carries no person's identifiers: no
// texter's number or email (held conversations are `dm:<channel>:<address>`, a contact-scoped
// channel limit is `contact:<address>`) and not the operator's name. Every count monitoring reads
// stays where it was. The full rows are for the operator's signed-in browser only — the same
// session the status page (/ops) takes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-health-redact-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Zebulon";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { createServer, health } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const TEXTER = "+15550000001";
const CONTACT = "+15550000002";
const EMAILER = "someone@example.test";

db.upsertAccount({ conversationId: config.ownerConversation, channel: "test", address: "+12025551234", name: "Zebulon", isOperator: true });
db.holdInbound({ conversationId: `dm:sendblue:${TEXTER}`, channel: "sendblue", address: TEXTER, externalId: "x1", text: "hi", attachments: [], isOperator: false, quietMs: 60_000, maxMs: 120_000 });
db.holdInbound({ conversationId: `dm:email:${EMAILER}`, channel: "email", address: EMAILER, externalId: "x2", text: "hello", attachments: [], isOperator: false, quietMs: -1, maxMs: 120_000 });
db.recordChannelLimit({ channel: "sendblue", feature: "read_receipt", scope: `contact:${CONTACT}`, why: `not verified (Sendblue said: ${CONTACT} / 555-000-0003 / a@b.example is not verified, 403)` });
db.recordChannelLimit({ channel: "sendblue", feature: "read_receipt", scope: "line:+16565550100", why: "line cannot" });

const router = new Router({ log: () => {} });
router.register(new ConsoleChannel({ write: () => {} }));

let server;
let base;
before(async () => {
  server = createServer({ router, runtime: null, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const getHealth = async (headers = {}) => {
  const res = await fetch(`${base}/health`, { headers });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
};

test("a stranger's /health names nobody: no texter's number or email, no contact, no operator", async () => {
  const { status, text } = await getHealth();
  assert.equal(status, 200);
  for (const leak of [TEXTER, CONTACT, EMAILER, "555-000-0003", "a@b.example", "15550000002", "Zebulon", "dm:sendblue:", "dm:email:", "contact:+"]) {
    assert.equal(text.includes(leak), false, `/health must not carry ${leak}`);
  }
});

test("a stranger's /health keeps every key and count monitoring reads", async () => {
  const { body } = await getHealth();
  assert.equal(body.ok, true);
  assert.equal(typeof body.now, "string");
  assert.ok("owner" in body, "the key is still there");
  assert.equal(body.holding.length, 2, "one row per held conversation, as before");
  assert.equal(body.holding.filter(r => r.due).length, 1, "and which of them are overdue");
  assert.deepEqual(body.holding.map(r => r.channel).sort(), ["email", "sendblue"]);
  assert.ok(body.holding.every(r => r.messages === 1 && typeof r.ready_at === "number"));
  assert.equal(body.channel_limits.length, 2);
  assert.deepEqual(body.channel_limits.map(l => l.scope).sort(), ["contact", "line:+16565550100"], "a line is Reason's own number; a contact is only its kind");
  assert.match(body.channel_limits.find(l => l.scope === "contact").why, /not verified \(Sendblue said: … \/ … \/ … is not verified, 403\)/, "the reason is kept, the addresses are not");
  assert.ok(body.channels.some(c => c.name === "console" && c.status === "live"));
  for (const k of ["sweeping", "outbox", "spotify", "uber", "open_tasks", "due_tasks", "pending_timers", "retrying_timers", "missed_timers", "live_watches", "threads"]) {
    assert.ok(k in body, `${k} is still reported`);
  }
});

test("someone else's session, or a made-up cookie, gets the stranger's answer", async () => {
  db.startPageSession("ops", "tok-not-operator", { conversationId: `dm:sendblue:${TEXTER}` });
  for (const cookie of ["reason_page=tok-not-operator", "reason_page=made-up"]) {
    const { text } = await getHealth({ cookie });
    assert.equal(text.includes(TEXTER), false);
    assert.equal(text.includes("Zebulon"), false);
  }
});

test("the operator's signed-in browser sees the full rows", async () => {
  db.startPageSession("ops", "tok-operator", { conversationId: config.ownerConversation });
  const { body } = await getHealth({ cookie: "reason_page=tok-operator" });
  assert.equal(body.owner, "Zebulon");
  assert.ok(body.holding.some(r => r.conversation_id === `dm:sendblue:${TEXTER}`));
  assert.ok(body.channel_limits.some(l => l.scope === `contact:${CONTACT}`));
});

test("health() called directly is the redacted answer unless asked for the full one", () => {
  const out = JSON.stringify(health({ router, runtime: null }));
  assert.equal(out.includes(TEXTER), false);
  assert.equal(out.includes("Zebulon"), false);
  const full = JSON.stringify(health({ router, runtime: null, full: true }));
  assert.ok(full.includes(TEXTER) && full.includes("Zebulon"));
});
