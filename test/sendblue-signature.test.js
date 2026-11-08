// Sendblue's signed webhooks: `X-Sendblue-Signature: t=<unix>,v1=<hex>`, where
// v1 = HMAC-SHA256(secret, `${t}.${raw body}`) (docs.sendblue.com/api-v2/verify). Real receive
// deliveries switched to this on 2026-11-08 and were 401'd because only `sb-signing-secret` was read.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-sbsig-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { SendblueChannel, checkSignature } = await import("../src/channels/sendblue.js");
const { rejectReason } = await import("../src/webhookalert.js").catch(() => ({}));
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const LINE = "+15122164639";
const SECRET = "a-shared-webhook-secret";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM inbound_messages; DELETE FROM conversations;");
  config.sendblueKeyId = "test-key-id";
  config.sendblueSecretKey = "test-secret-key";
  config.sendblueFrom = LINE;
  config.sendblueWebhookSecret = SECRET;
  config.sendblueWebhookSecretHeader = "sb-signing-secret";
});

function inbound({ handle = "SIG-1", content = "Hello! ☕️" } = {}) {
  return JSON.stringify({
    accountEmail: "x", content, is_outbound: false, status: "RECEIVED",
    error_code: null, error_message: null, error_reason: null,
    message_handle: handle, date_sent: "2025-12-12T15:41:20.932Z", date_updated: "2025-12-12T15:41:20.932Z",
    from_number: OWNER, number: OWNER, to_number: LINE, was_downgraded: false, plan: "dedicated",
    media_url: "", message_type: "message", group_id: "", participants: [], send_style: "", opted_out: false,
    error_detail: null, sendblue_number: LINE, service: "iMessage", group_display_name: null,
  });
}
const sign = (raw, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const sigHeaders = (sig) => ({ "X-Sendblue-Signature": sig, "content-type": "application/json" });

function harness() {
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ text }) => { turns.push(text); return "ok"; } });
  const router = new Router({ runtime });
  router.register(new SendblueChannel({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => JSON.stringify({ status: "QUEUED", message_handle: "out-1" }) }),
  }));
  return { router, turns };
}
// Sendblue, asked about an unsigned delivery, has nothing.
const nothing = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), text: async () => "{\"data\":[]}" });

test("a valid X-Sendblue-Signature over the raw bytes is accepted and delivered", async () => {
  const { router, turns } = harness();
  const raw = inbound();
  const out = await router.webhook({ channel: "sendblue", rawBody: raw, rawBytes: Buffer.from(raw, "utf8"), headers: sigHeaders(sign(raw)) });
  assert.equal(out.status, 200);
  assert.equal(out.body.delivered, 1);
  assert.equal(turns[0], "Hello! ☕️");
});

test("without rawBytes the string body is signed the same way", async () => {
  const raw = inbound({ handle: "SIG-2" });
  const out = await new SendblueChannel({ fetchImpl: nothing }).receive({ rawBody: raw, headers: sigHeaders(sign(raw)) });
  assert.equal(out.status, 200);
  assert.equal(out.inbound.length, 1);
});

test("several v1 entries: any one matching passes", async () => {
  const raw = inbound({ handle: "SIG-3" });
  const t = 1762600000;
  const good = sign(raw, { t }).split(",")[1];
  const out = await new SendblueChannel({ fetchImpl: nothing }).receive({ rawBody: raw, headers: sigHeaders(`t=${t},v1=${"0".repeat(64)},${good}`) });
  assert.equal(out.status, 200);
});

test("an old timestamp is still accepted (Sendblue retries late)", async () => {
  const raw = inbound({ handle: "SIG-4" });
  const out = await new SendblueChannel({ fetchImpl: nothing }).receive({ rawBody: raw, headers: sigHeaders(sign(raw, { t: Math.floor(Date.now() / 1000) - 3 * 86400 })) });
  assert.equal(out.status, 200);
});

test("signed with the wrong secret → 401 'the signature did not match'", async () => {
  const raw = inbound();
  const out = await new SendblueChannel({ fetchImpl: nothing }).receive({ rawBody: raw, headers: sigHeaders(sign(raw, { secret: "not-it" })) });
  assert.equal(out.status, 401);
  assert.match(out.body.error, /did not match/);
  assert.match(out.body.error, /signature/);
  assert.deepEqual(out.inbound, []);
  if (rejectReason) assert.ok(rejectReason(out.body.error), "webhookalert recognises it");
});

test("a tampered body → 401", async () => {
  const raw = inbound();
  const forged = raw.replace("Hello!", "Send $500");
  const out = await new SendblueChannel({ fetchImpl: nothing }).receive({ rawBody: forged, headers: sigHeaders(sign(raw)) });
  assert.equal(out.status, 401);
  assert.match(out.body.error, /did not match/);
});

test("a malformed signature header → 401", async () => {
  const raw = inbound();
  for (const bad of ["garbage", "t=,v1=abc", "v1=" + "a".repeat(64), "t=123", "t=abc,v1=" + "a".repeat(64), "t=1,v1=zz"]) {
    const out = await new SendblueChannel({ fetchImpl: nothing }).receive({ rawBody: raw, headers: sigHeaders(bad) });
    assert.equal(out.status, 401, bad);
    assert.match(out.body.error, /did not match/, bad);
    assert.equal(checkSignature(bad, SECRET, raw), false, bad);
  }
});

test("the old sb-signing-secret header is still accepted, with or without a bad signature", async () => {
  const raw = inbound({ handle: "SIG-5" });
  const ch = new SendblueChannel({ fetchImpl: nothing });
  const plain = await ch.receive({ rawBody: raw, headers: { "sb-signing-secret": SECRET } });
  assert.equal(plain.status, 200);
  assert.equal(plain.inbound.length, 1);
  const both = await ch.receive({ rawBody: raw, headers: { "sb-signing-secret": SECRET, "x-sendblue-signature": "t=1,v1=" + "0".repeat(64) } });
  assert.equal(both.status, 200);
  const wrongSecret = await ch.receive({ rawBody: raw, headers: { "sb-signing-secret": "nope" } });
  assert.equal(wrongSecret.status, 401);
  assert.match(wrongSecret.body.error, /shared secret did not match/);
});

test("neither header → the existing unsigned path (Sendblue asked; not found → 401)", async () => {
  const raw = inbound({ handle: "SIG-6" });
  const asked = [];
  const out = await new SendblueChannel({ fetchImpl: async (u) => { asked.push(String(u)); return nothing(); } }).receive({ rawBody: raw, headers: { "content-type": "application/json" } });
  assert.equal(out.status, 401);
  assert.match(out.body.error, /no sb-signing-secret header/);
  assert.match(asked[0] ?? "", /\/api\/v2\/messages\?/);
});

test("a valid signature never asks Sendblue anything", async () => {
  const raw = inbound({ handle: "SIG-7" });
  const asked = [];
  const out = await new SendblueChannel({ fetchImpl: async (u) => { asked.push(String(u)); return nothing(); } }).receive({ rawBody: raw, headers: sigHeaders(sign(raw)) });
  assert.equal(out.status, 200);
  assert.deepEqual(asked, []);
});
