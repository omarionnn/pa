// AgentCard bearer tokens are sealed at rest (2026-10-23). Before, agentcard_users.access_token and
// refresh_token were plain text, so any copy of reason.db could spend as the person. Pinned: a write
// is stored sealed and read back opened; a database with plain rows is sealed on the first open with
// a key; with token rows and no key the database refuses to open; nothing seals without a key; the
// server refuses to start without one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const KEY = "22".repeat(32);
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "reason-seal-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Opening the database is module load, so each case runs in its own process.
function run(dbPath, key, js) {
  const env = { ...process.env, REASON_DB_PATH: dbPath, REASON_DATA_DIR: dir, REASON_TOKEN_KEY: key, ANTHROPIC_API_KEY: "" };
  return spawnSync(process.execPath, ["--input-type=module", "-e", js], { cwd: root, env, encoding: "utf8" });
}
const raw = (p) => { const d = new DatabaseSync(p); try { return d.prepare("SELECT * FROM agentcard_users").all(); } finally { d.close(); } };

test("a saved token pair is stored sealed and read back as the real tokens", () => {
  const p = join(dir, "a.db");
  const r = run(p, KEY, [
    'const db = await import("./src/db.js");',
    'db.startAgentcardEnrollment({ conversationId: "dm:a", vaultSessionId: "vs_1" });',
    'db.saveAgentcardConnection({ conversationId: "dm:a", userId: "u_1", accessToken: "AT-secret", refreshToken: "RT-secret", expiresAt: 1 });',
    'const row = db.getAgentcardUser("dm:a"); const byId = db.agentcardUserById("u_1");',
    'console.log(JSON.stringify([row.access_token, row.refresh_token, byId.access_token, db.agentcardTokenAudit()]));',
  ].join("\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), ["AT-secret", "RT-secret", "AT-secret", { rows: 1, sealed: 1, plain: 0 }]);
  const [stored] = raw(p);
  assert.match(stored.access_token, /^enc:v1:/);
  assert.match(stored.refresh_token, /^enc:v1:/);
  assert.ok(!stored.access_token.includes("AT-secret") && !stored.refresh_token.includes("RT-secret"));
});

test("plain-text rows written before the change are sealed on the first open with a key, data intact", () => {
  const p = join(dir, "b.db");
  assert.equal(run(p, KEY, 'await import("./src/db.js");').status, 0);
  const d = new DatabaseSync(p);
  d.prepare("INSERT INTO agentcard_users (conversation_id, user_id, access_token, refresh_token, card_last4, created_at, updated_at) VALUES ('dm:old','u_old','OLD-AT','OLD-RT','4242',1,1)").run();
  d.prepare("INSERT INTO agentcard_users (conversation_id, created_at, updated_at) VALUES ('dm:none',1,1)").run();
  d.close();
  const r = run(p, KEY, 'const db = await import("./src/db.js"); const r = db.getAgentcardUser("dm:old"); console.log(JSON.stringify([r.access_token, r.refresh_token, r.card_last4, db.agentcardTokenAudit()]));');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), ["OLD-AT", "OLD-RT", "4242", { rows: 1, sealed: 1, plain: 0 }]);
  const rows = raw(p);
  assert.match(rows.find(x => x.conversation_id === "dm:old").access_token, /^enc:v1:/);
  assert.equal(rows.find(x => x.conversation_id === "dm:none").access_token, "");
  // Sealing again is a no-op: a second open leaves the stored value byte for byte.
  const before = rows.find(x => x.conversation_id === "dm:old").access_token;
  assert.equal(run(p, KEY, 'await import("./src/db.js");').status, 0);
  assert.equal(raw(p).find(x => x.conversation_id === "dm:old").access_token, before);
});

test("with token rows and no key the database refuses to open; a wrong key cannot read them", () => {
  const p = join(dir, "b.db");
  const none = run(p, "", 'await import("./src/db.js");');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /REASON_TOKEN_KEY is not set/);
  const wrong = run(p, "33".repeat(32), 'const db = await import("./src/db.js"); db.getAgentcardUser("dm:old");');
  assert.notEqual(wrong.status, 0);
});

test("nothing is sealed, and so nothing is stored, without a key", async () => {
  const saved = process.env.REASON_TOKEN_KEY;
  delete process.env.REASON_TOKEN_KEY;
  try {
    const box = await import("../src/secretbox.js");
    assert.throws(() => box.seal("AT"), /REASON_TOKEN_KEY is not set/);
    assert.equal(box.seal(""), "");
    process.env.REASON_TOKEN_KEY = "abc";
    assert.throws(() => box.requireKey(), /not a 32-byte key/);
  } finally { if (saved === undefined) delete process.env.REASON_TOKEN_KEY; else process.env.REASON_TOKEN_KEY = saved; }
});

test("the server will not start without the key", () => {
  const env = { ...process.env, REASON_DB_PATH: join(dir, "c.db"), REASON_DATA_DIR: dir, REASON_TOKEN_KEY: "", PORT: "0", REASON_PORT: "0" };
  const r = spawnSync(process.execPath, ["src/serve.js"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REASON_TOKEN_KEY is not set/);
});
