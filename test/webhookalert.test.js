// Sendblue webhooks refused with a 401 (a rotated secret, a missing header) raise one alert: /ops
// red and the owner texted once, with which refusal it was and never the secret. An accepted
// delivery closes it. A single stray 401 stays quiet. Offline: real SendblueChannel, no network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-webhookalert-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
const SECRET = "the-real-secret-value-0123456789";
process.env.SENDBLUE_WEBHOOK_SECRET = SECRET;
delete process.env.SENDBLUE_WEBHOOK_SECRET_HEADER;

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");
const incidents = await import("../src/incidents.js");
const webhookAlert = await import("../src/webhookalert.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");

let texts = [];
after(() => { incidents.stop(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  texts = [];
  webhookAlert.reset();
  db.db.exec("DELETE FROM incidents; DELETE FROM ops_digest;");
  incidents.start({ send: (text, key) => { texts.push({ text, key }); return { ok: true }; }, link: (f) => `https://reason.example.test/ops?focus=${f}` });
});

const fetchImpl = async () => { throw new Error("no network in this test"); };
function harness() {
  const runtime = new Runtime({ log: () => {}, runTurn: async () => null });
  const router = new Router({ runtime, log: () => {} });
  router.register(new SendblueChannel({ fetchImpl }));
  return router;
}
const BODY = JSON.stringify({ is_outbound: true, status: "DELIVERED", message_handle: "m-1", number: "+14155559876" });
const hit = (router, headers) => router.webhook({ channel: "sendblue", rawBody: BODY, headers });
const wrong = { "sb-signing-secret": "an-old-rotated-secret-000000000" };
const right = { "sb-signing-secret": SECRET };
const openRow = () => incidents.open().find(r => r.key === "webhook:sendblue:rejected");
const card = () => incidents.checks().find(c => c.id === "incident:webhook:sendblue:rejected");

test("one stray 401 stays a journal line: no alert, no text", async () => {
  const router = harness();
  assert.equal((await hit(router, wrong)).status, 401);
  assert.equal(openRow(), undefined);
  assert.equal(texts.length, 0);
});

test("a mismatched secret, refused again and again, opens one alert, red on /ops, texted once, without the secret", async () => {
  const router = harness();
  for (let i = 0; i < 5; i++) {
    assert.equal((await hit(router, wrong)).status, 401);
  }
  const row = openRow();
  assert.ok(row, "the alert is open");
  assert.match(row.error, /did not match/);
  assert.equal(card().state, "bad");
  assert.equal(texts.length, 1, "one text, not one per refusal");
  assert.match(texts[0].text, /sendblue webhooks are being refused \(401\)/);
  assert.match(texts[0].text, /did not match/);
  for (const t of [...texts.map(x => x.text), row.error, row.tried, row.next, card().detail]) {
    assert.ok(!t.includes(SECRET) && !t.includes(wrong["sb-signing-secret"]), "never a secret value");
  }
});

test("a missing header is named as missing, not as a mismatch", async () => {
  const router = harness();
  await hit(router, {});
  await hit(router, {});
  const row = openRow();
  assert.ok(row);
  assert.match(row.error, /missing/);
  assert.doesNotMatch(row.error, /did not match/);
});

test("an accepted delivery closes it with one resolved text", async () => {
  const router = harness();
  await hit(router, wrong);
  await hit(router, wrong);
  assert.ok(openRow());
  const ok = await hit(router, right);
  assert.ok(ok.status >= 200 && ok.status < 300, `accepted, got ${ok.status}`);
  assert.equal(openRow(), undefined);
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /^Resolved: .*accepted again/);
  assert.equal(card().state, "ok");
});

test("refusals spread past the window do not add up", () => {
  const t0 = Date.parse("2026-11-08T15:00:00Z");
  webhookAlert.note({ channel: "sendblue", status: 401, error: "rejected: the shared secret did not match", at: t0 });
  webhookAlert.note({ channel: "sendblue", status: 401, error: "rejected: the shared secret did not match", at: t0 + webhookAlert.WINDOW_MS + 1 });
  assert.equal(openRow(), undefined);
  webhookAlert.note({ channel: "sendblue", status: 401, error: "rejected: the shared secret did not match", at: t0 + webhookAlert.WINDOW_MS + 60_000 });
  assert.ok(openRow());
});

test("another channel's accepted delivery does not break a sendblue streak", () => {
  const t0 = Date.parse("2026-11-08T15:00:00Z");
  webhookAlert.note({ channel: "sendblue", status: 401, error: "rejected: no sb-signing-secret header", at: t0 });
  webhookAlert.note({ channel: "linq", status: 200, at: t0 + 30_000 });
  webhookAlert.note({ channel: "sendblue", status: 401, error: "rejected: no sb-signing-secret header", at: t0 + 60_000 });
  assert.ok(openRow());
});
