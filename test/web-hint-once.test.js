// Owner 10-27: "reason should stop always saying our full convo including whatever is on web, it's
// annoying, should say it only once." The decision-9 line (src/deliver.js WEB_HINT) is said once per
// PERSON, ever — not once per switch — and anyone who had already heard it before this rule existed
// (their outbox carries it) is marked told when the column is added, so they never hear it again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-web-hint-once-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_CONVERSATION = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));

const LINE = "Our full conversation, the Web part included, is on Reason Web.";

// A database as it was before the rule: built by today's code, then the new column taken away, with
// one person who has heard the line (Omari, 8 times) and one who never has.
const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
  await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
`], { env: process.env, encoding: "utf8" });
assert.equal(seed.status, 0, seed.stderr);
{
  const raw = new DatabaseSync(process.env.REASON_DB_PATH);
  raw.exec("ALTER TABLE threads DROP COLUMN web_hint_told_at");
  const t = raw.prepare("INSERT INTO threads (conversation_id, channel, address, is_owner, last_channel, created_at, updated_at) VALUES (?, 'fake', ?, 1, 'fake', 1, 1)");
  t.run("dm:owner", "+12025551234");
  t.run("dm:fake:+12025550000", "+12025550000");
  const o = raw.prepare("INSERT INTO outbox (idem_key, conversation_id, channel, address, body, created_at, updated_at) VALUES (?, ?, 'fake', 'x', ?, ?, ?)");
  o.run("a", "dm:owner", `added it\n\n${LINE}`, 500, 500);
  o.run("b", "dm:owner", `another\n\n${LINE}`, 900, 900);
  o.run("c", "dm:fake:+12025550000", "hello", 700, 700);
  raw.close();
}

const db = await import("../src/db.js");
const { WEB_HINT } = await import("../src/deliver.js");

test("the pinned line is the one the migration looks for", () => {
  assert.equal(WEB_HINT, LINE);
});

test("someone who already heard it is marked told when the column arrives, and never owed it again", () => {
  assert.equal(db.getThread("dm:owner").web_hint_told_at, 500, "the first time they heard it");
  assert.equal(db.getThread("dm:fake:+12025550000").web_hint_told_at, null, "someone who never heard it is not");
  // A switch from Web to texting: Web message, then a text.
  db.upsertThread({ conversationId: "dm:owner", channel: "web", address: "+12025551234", isOwner: true });
  db.upsertThread({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", isOwner: true });
  assert.equal(db.getThread("dm:owner").web_hint_due, 0, "no switch makes it owed");
  assert.equal(db.takeWebHint("dm:owner"), false);
});

test("someone new hears it on their first switch, then never on any later one", () => {
  const c = "dm:fake:+12025550000";
  const sw = () => {
    db.upsertThread({ conversationId: c, channel: "web", address: "+12025550000", isOwner: true });
    db.upsertThread({ conversationId: c, channel: "fake", address: "+12025550000", isOwner: true });
  };
  sw();
  assert.equal(db.takeWebHint(c), true, "the first switch");
  assert.equal(db.takeWebHint(c), false, "not twice for one switch");
  assert.ok(db.getThread(c).web_hint_told_at, "marked told");
  for (let i = 0; i < 3; i++) { sw(); assert.equal(db.takeWebHint(c), false, `switch ${i + 2}: never again`); }
});

test("an owed line that went stale is not 'told': the next fresh switch still says it once", () => {
  const c = "dm:fake:+12025559999";
  db.upsertThread({ conversationId: c, channel: "fake", address: "+12025559999", isOwner: true });
  db.upsertThread({ conversationId: c, channel: "web", address: "+12025559999", isOwner: true });
  db.upsertThread({ conversationId: c, channel: "fake", address: "+12025559999", isOwner: true });
  const due = db.getThread(c).web_hint_due;
  assert.equal(db.takeWebHint(c, due + db.WEB_SWITCH_WINDOW_MS + 1), false, "stale, so not said");
  assert.equal(db.getThread(c).web_hint_told_at, null, "and so not marked told");
  db.upsertThread({ conversationId: c, channel: "web", address: "+12025559999", isOwner: true });
  db.upsertThread({ conversationId: c, channel: "fake", address: "+12025559999", isOwner: true });
  assert.equal(db.takeWebHint(c), true);
  assert.equal(db.takeWebHint(c), false);
});
