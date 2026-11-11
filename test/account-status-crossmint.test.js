// A store connected through Crossmint (shop_stores) is connected for account_list, the same way the
// connect-the-rest page (src/connectafter.js connectedAt) counts it. Found 2026-11-11: Reason placed
// an Amazon order for the owner and then said "your Amazon isn't connected", because account_list
// only read Reason's own-browser sign-in probe.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-acct-crossmint-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
delete process.env.CROSSMINT_CLIENT_KEY;
delete process.env.CROSSMINT_SERVER_KEY;

const trust = await import("../src/trust.js");
const shop = await import("../src/shopconnect.js");
const ca = await import("../src/connectafter.js");
const db = await import("../src/db.js");
const { runTool } = await import("../src/tools.js");
const { clock } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));
const C = "dm:acct-crossmint";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025550199", name: "Omari", isOperator: true });

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM shop_stores; DELETE FROM connected_accounts;");
});

const amazonStatus = () => trust.accountStatus(C, "amazon");

test("connected through Crossmint only -> connected, no npm run signin", () => {
  shop.markConnected(C, "amazon");
  const s = amazonStatus();
  assert.equal(s.status, "connected");
  assert.equal(s.via, "crossmint");
  assert.ok(s.connected_at);
  assert.equal(s.owner_must_supply, undefined);
  assert.ok(!JSON.stringify(s).includes("npm run signin"));
  // the connect-the-rest page agrees
  assert.notEqual(ca.connectedAt(C).amazon, null);
});

test("another store connected through Crossmint does not make Amazon connected", () => {
  shop.markConnected(C, "walmart");
  assert.equal(trust.accountStatus(C, "amazon").status, "not_connected");
  assert.equal(ca.connectedAt(C).amazon, null);
});

test("own browser sign-in only -> connected (unchanged)", () => {
  db.recordSiteSignin(C, "amazon", { state: "signed_in", evidence: "order history loaded" });
  const s = amazonStatus();
  assert.equal(s.status, "connected");
  assert.notEqual(s.via, "crossmint");
  assert.notEqual(ca.connectedAt(C).amazon, null);
});

test("neither -> not_connected, with the sign-in instruction", () => {
  const s = amazonStatus();
  assert.equal(s.status, "not_connected");
  assert.match(s.owner_must_supply, /npm run signin -- amazon/);
  assert.equal(ca.connectedAt(C).amazon, null);
});

test("a store that was removed -> not_connected", async () => {
  shop.markConnected(C, "amazon");
  assert.equal(amazonStatus().status, "connected");
  await shop.removeStore(C, "amazon").catch(() => {});
  db.db.prepare("UPDATE shop_stores SET status = 'removed' WHERE conversation_id = ? AND store = ?").run(C, "amazon");
  assert.equal(amazonStatus().status, "not_connected");
  assert.equal(ca.connectedAt(C).amazon, null);
});

test("account_list tool shows Amazon connected when only Crossmint has it", async () => {
  shop.markConnected(C, "amazon");
  const out = await runTool("account_list", {}, { conversationId: C });
  const list = Object.values(out).find((v) => Array.isArray(v) && v.some((a) => a?.name === "amazon"));
  assert.ok(list, JSON.stringify(out).slice(0, 300));
  assert.equal(list.find((a) => a.name === "amazon").status, "connected");
});

test("signin_list marks a Crossmint store and offers no sign-in link for it", async () => {
  shop.markConnected(C, "amazon");
  const out = await runTool("signin_status", { site: "amazon" }, { conversationId: C });
  const r = out.sites?.find((x) => x.site === "amazon");
  assert.ok(r, JSON.stringify(out).slice(0, 300));
  assert.equal(r.connected_via_crossmint, true);
  assert.equal(r.how_to_sign_in, undefined);
});
