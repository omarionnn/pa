// Login tokens in oauth_tokens are sealed at rest (2026-10-23), the same way the AgentCard tokens
// were in #86. Before, access_token and refresh_token were plain text for every provider (Google,
// Spotify, Uber, X, GitHub) and access_token held the iCloud app-specific password, so any copy of
// reason.db was a working login. Pinned: a write is stored sealed and every reader gets the real
// value back; a refresh with no new refresh token keeps the old one; plain rows are sealed once, on
// the first open with a key, data and row count intact; with plain rows and no key the database
// refuses to open; a wrong key cannot read them; an export carries no token, sealed or not.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const KEY = "55".repeat(32);
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "reason-oauthseal-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Opening the database is module load, so each case runs in its own process.
function run(dbPath, key, js) {
  const env = { ...process.env, REASON_DB_PATH: dbPath, REASON_DATA_DIR: dir, REASON_TOKEN_KEY: key, ANTHROPIC_API_KEY: "" };
  return spawnSync(process.execPath, ["--input-type=module", "-e", js], { cwd: root, env, encoding: "utf8" });
}
const last = (r) => JSON.parse(r.stdout.trim().split("\n").pop());
const raw = (p) => { const d = new DatabaseSync(p); try { return d.prepare("SELECT * FROM oauth_tokens ORDER BY id").all(); } finally { d.close(); } };

test("a saved grant is stored sealed and every reader gets the real tokens back", () => {
  const p = join(dir, "a.db");
  const r = run(p, KEY, [
    'const db = await import("./src/db.js");',
    'const saved = db.saveOauthTokens("dm:a", "google", { accessToken: "ya29.AT-one", refreshToken: "1//RT-one", scope: "s", expiresAt: 1, accountLabel: "a@example.com" });',
    // A refresh: new access token, no refresh token in the response. The old one has to survive.
    'const again = db.saveOauthTokens("dm:a", "google", { accessToken: "ya29.AT-two", scope: "s", expiresAt: 2 });',
    'db.saveOauthTokens("dm:a", "icloud", { accessToken: "abcd-efgh-ijkl-mnop", accountLabel: "a@icloud.com" });',
    'const one = db.getOauthTokens("dm:a", "google"); const byAcct = db.getOauthTokens("dm:a", "google", { account: "A@example.com" });',
    'const list = db.listOauthTokens("dm:a", "google"); const ic = db.getOauthTokens("dm:a", "icloud");',
    'console.log(JSON.stringify([saved.access_token, saved.refresh_token, again.access_token, again.refresh_token, one.refresh_token, byAcct.access_token, list[0].access_token, ic.access_token, ic.refresh_token, db.oauthTokenAudit()]));',
  ].join("\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(last(r), ["ya29.AT-one", "1//RT-one", "ya29.AT-two", "1//RT-one", "1//RT-one", "ya29.AT-two", "ya29.AT-two", "abcd-efgh-ijkl-mnop", "",
    { rows: 2, sealed: 2, plain: 0, empty: 0, byProvider: { google: { rows: 1, sealed: 1, plain: 0 }, icloud: { rows: 1, sealed: 1, plain: 0 } } }]);
  const stored = raw(p);
  for (const row of stored) {
    assert.match(row.access_token, /^enc:v1:/);
    assert.ok(!/AT-|abcd-efgh/.test(row.access_token));
  }
  assert.match(stored[0].refresh_token, /^enc:v1:/);
  assert.equal(stored[1].refresh_token, "", "no token is not a secret; empty stays empty");
});

test("plain-text grants written before the change are sealed on the first open with a key, data and count intact", () => {
  const p = join(dir, "b.db");
  assert.equal(run(p, KEY, 'await import("./src/db.js");').status, 0);
  const d = new DatabaseSync(p);
  const ins = d.prepare("INSERT INTO oauth_tokens (conversation_id, provider, access_token, refresh_token, scope, expires_at, account_label, connected_at) VALUES (?,?,?,?,?,?,?,1)");
  ins.run("dm:old", "google", "ya29.OLD", "1//OLD", "gmail", 5, "old@example.com");
  ins.run("dm:old", "spotify", "BQ-OLD", "AQ-OLD", "", 5, "");
  ins.run("dm:old", "github", "gho_OLD", "", "repo", null, "octo");
  ins.run("dm:old", "icloud", "wxyz-wxyz-wxyz-wxyz", "", "", null, "old@icloud.com");
  ins.run("dm:other", "uber", "", "", "", null, "");
  d.close();
  const r = run(p, KEY, [
    'const db = await import("./src/db.js");',
    'const g = db.getOauthTokens("dm:old", "google"), s = db.getOauthTokens("dm:old", "spotify"), h = db.getOauthTokens("dm:old", "github"), i = db.getOauthTokens("dm:old", "icloud");',
    'console.log(JSON.stringify([db.oauthSealMigration, g.access_token, g.refresh_token, g.scope, g.account_label, s.access_token, s.refresh_token, h.access_token, h.refresh_token, i.access_token, db.oauthTokenAudit().plain]));',
  ].join("\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(last(r), [{ sealed: 4 }, "ya29.OLD", "1//OLD", "gmail", "old@example.com", "BQ-OLD", "AQ-OLD", "gho_OLD", "", "wxyz-wxyz-wxyz-wxyz", 0]);
  const rows = raw(p);
  assert.equal(rows.length, 5);
  for (const row of rows.filter(x => x.provider !== "uber")) assert.match(row.access_token, /^enc:v1:/);
  assert.deepEqual([rows[4].access_token, rows[4].refresh_token], ["", ""]);
  // Sealing again is a no-op: a second open leaves every stored value byte for byte.
  assert.equal(run(p, KEY, 'const db = await import("./src/db.js"); console.log(JSON.stringify(db.oauthSealMigration));').stdout.trim().split("\n").pop(), '{"sealed":0}');
  assert.deepEqual(raw(p), rows);
});

test("with grants stored and no key the database refuses to open; a wrong key cannot read them", () => {
  const p = join(dir, "b.db");
  const none = run(p, "", 'await import("./src/db.js");');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /REASON_TOKEN_KEY is not set/);
  const wrong = run(p, "66".repeat(32), 'const db = await import("./src/db.js"); db.getOauthTokens("dm:old", "google");');
  assert.notEqual(wrong.status, 0);
});

test("a plain-text grant on a keyless install refuses to open rather than be read in the clear", () => {
  const p = join(dir, "c.db");
  assert.equal(run(p, KEY, 'await import("./src/db.js");').status, 0);
  const d = new DatabaseSync(p);
  d.prepare("INSERT INTO oauth_tokens (conversation_id, provider, access_token, connected_at) VALUES ('dm:x','x','X-PLAIN',1)").run();
  d.close();
  const none = run(p, "", 'await import("./src/db.js");');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /REASON_TOKEN_KEY is not set/);
  assert.equal(raw(p)[0].access_token, "X-PLAIN", "nothing was rewritten by the process that refused");
});

test("an export carries the grant's record and no token, sealed or opened", () => {
  const p = join(dir, "d.db");
  const r = run(p, KEY, [
    'const db = await import("./src/db.js"); const { exportData } = await import("./src/data.js");',
    'db.saveOauthTokens("dm:e", "spotify", { accessToken: "BQ-EXPORT", refreshToken: "AQ-EXPORT", scope: "user-top-read" });',
    'const out = exportData(); const row = out.tables.oauth_tokens[0];',
    'const s = JSON.stringify(out);',
    'console.log(JSON.stringify([row.scope, row.access_token, s.includes("BQ-EXPORT") || s.includes("AQ-EXPORT"), s.includes("enc:v1:")]));',
  ].join("\n"));
  assert.equal(r.status, 0, r.stderr);
  const [scope, at, leaked, sealedOut] = last(r);
  assert.equal(scope, "user-top-read");
  assert.match(at, /live credential/);
  assert.equal(leaked, false);
  assert.equal(sealedOut, false);
});
