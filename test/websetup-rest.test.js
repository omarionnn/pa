// The web setup under encryption at rest (#425/#438): once claimed, a setup keeps no name and no phone.
// Byte-searches the database file itself, like test/encrypt-rest.test.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "websetup-rest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "33".repeat(32);
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_WEB_SETUP = "on";
process.env.REASON_BURST_QUIET_MS = "0";

const db = await import("../src/db.js");
const store = await import("../src/websetupstore.js");
const ws = await import("../src/websetup.js");
const ob = await import("../src/onboarding.js");
const data = await import("../src/data.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { config, clock } = await import("../src/config.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const USER = "zebulonq", REASON = "quillmarrow";
const inFile = (needle) => [process.env.REASON_DB_PATH, `${process.env.REASON_DB_PATH}-wal`].some(p => existsSync(p) && readFileSync(p).toString("latin1").toLowerCase().includes(needle.toLowerCase()));

function harness() {
  const runtime = new Runtime({ runTurn: async () => "on it" });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask: async () => ({ error: "none" }), sleep: async () => {} } });
  const channel = router.register(new FakeChannel({ number: "+16562167455" }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel };
}

test("claimed: names blanked, owner is a blind index, the hand-off still greets by name, and no setup name is left in the DB file", async () => {
  config.autoAdmit = true; config.onboarding = "on"; config.onboardingNumbers = [];
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Owner", isOperator: true });
  const s = store.create();
  store.save(s.id, { user: USER, reasonName: REASON });
  db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.ok(inFile(USER), "the check can see an unclaimed name (sanity)");

  const h = harness();
  const num = "+14155550123", conv = `dm:fake:${num}`;
  await h.router.deliver({ channel: "fake", externalId: "m1", from: num, text: ws.firstText({ user: USER, reasonName: REASON, code: s.code }), at: clock.now() });
  const sent = h.channel.sent.filter(m => m.to === num).map(m => m.text);
  assert.equal(sent[0], ob.WEB_HELLO(USER), "hello by name, from the account");
  const row = db.db.prepare("SELECT * FROM web_setups WHERE id = ?").get(s.id);
  assert.equal(row.user_name, ""); assert.equal(row.reason_name, "");
  assert.match(row.claimed_by, /^bi1:/); assert.ok(!row.claimed_by.includes(num));
  assert.equal(store.claimedBy(conv)?.id, s.id, "still found by its conversation");
  assert.equal(ob.handledOnWeb(conv), true);

  // The account keeps its own name + card name by design (outside this change): clear them, then
  // nothing of the setup's names may remain anywhere in the file (web_setups, messages, outbox, WAL).
  db.db.prepare("UPDATE accounts SET name = '', contact_card_name = NULL WHERE conversation_id = ?").run(conv);
  db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(inFile(USER), false, `${USER} survives in the DB file`);
  assert.equal(inFile(REASON), false, `${REASON} survives in the DB file`);
});

test("rows claimed before this are scrubbed at boot; export/delete still reaches them by conversation", () => {
  const s = store.create();
  db.db.prepare("UPDATE web_setups SET user_name = 'olda', reason_name = 'oldb', claimed_by = 'dm:fake:+14155550777', claimed_at = 1 WHERE id = ?").run(s.id);
  store.scrubClaimed();
  const row = db.db.prepare("SELECT * FROM web_setups WHERE id = ?").get(s.id);
  assert.equal(row.user_name, ""); assert.equal(row.reason_name, "");
  assert.match(row.claimed_by, /^bi1:/);
  assert.equal(store.claimedBy("dm:fake:+14155550777")?.id, s.id);
  store.scrubClaimed();
  assert.equal(db.db.prepare("SELECT claimed_by FROM web_setups WHERE id = ?").get(s.id).claimed_by, row.claimed_by, "idempotent");
  const n = db.db.prepare("SELECT count(*) n FROM web_setups WHERE claimed_by IN (?, websetup_owner(?))").get("dm:fake:+14155550777", "dm:fake:+14155550777").n;
  assert.equal(n, 1, "the data.js scope fragment matches");
  assert.ok(data.COVERAGE, "data.js loads with the new fragment");
});

test("data.js alone (the export/delete CLI) can run the web_setups scope", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const d = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)}); await import(${JSON.stringify(new URL("../src/data.js", import.meta.url).href)}); console.log(d.db.prepare("SELECT count(*) n FROM web_setups WHERE claimed_by IN (?, websetup_owner(?))").get("x","x").n)`],
    { env: { ...process.env, REASON_DB_PATH: join(dir, "fresh.db") }, encoding: "utf8" });
  assert.equal(out.trim(), "0");
});
