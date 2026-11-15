// A delete that cannot miss a table (security audit lead 14).
//
// deleteData() is driven by lists in src/data.js. Modules that make their own tables were never added
// to them, so a delete left a person's Web thread, memory graph, saved card, AgentCard link, passkeys
// and shipping address behind under a conversation id that is deterministic (dm:<channel>:<addr>):
// re-admitting the same number handed all of it straight back.
//
// Two things are pinned here, both by enumerating the database rather than by naming tables:
//   1. every table in sqlite_master is classified in src/data.js (deleted, global, kept with a
//      reason, or install-wide), and no table with a conversation_id column is called install-wide;
//   2. a scoped delete leaves zero rows for that conversation in every table with a conversation_id
//      column except the ones kept on purpose, and leaves somebody else's rows alone.
//
// No API key, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-data-coverage-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_TOKEN_KEY = "44".repeat(32);
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
after(() => rmSync(dir, { recursive: true, force: true }));

const data = await import("../src/data.js");
// Every module that makes its own tables, so the database here has all of them.
for (const m of ["plaid", "pictureout", "actioncards", "actionengine", "connectafter", "daily", "eventpay", "passkey", "plan", "saved", "shipping", "shopconnect", "socialsignin", "refusing", "spendcap", "stamps", "strangercalls", "ownfiles", "tooldiet", "websetupstore", "verifications"]) {
  await import(`../src/${m}.js`);
}
const db = await import("../src/db.js");
const sql = db.db;

const GONE = "dm:sendblue:+15550000001";
const STAYS = "dm:sendblue:+15550000002";

const tables = () => sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
const columns = (t) => sql.prepare(`PRAGMA table_info(${t})`).all();
// Every column that names a person's conversation, whatever the table calls it.
const PERSON_COLS = /(^|_)conversation_id$/;
const coverage = () => data.COVERAGE ?? { deleted: [], global: [], kept: {}, installWide: {} };
const kept = () => coverage().kept ?? {};

test("every CREATE TABLE in src/ exists here, so the checks below see every table", async () => {
  const made = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        for (const m of readFileSync(p, "utf8").matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*) *\(/g)) made.add(m[1]);
      }
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  // A rebuild's scratch table, renamed onto oauth_tokens in the same migration.
  made.delete("oauth_tokens_per_account");
  // The keystore's own tables live in data/keys.db (src/restcrypt.js), deliberately not in reason.db.
  for (const t of ["install_key", "user_keys", "shredded"]) made.delete(t);
  // The vault's tables live in data/logins.db (src/savedlogins.js), deliberately not in reason.db: a copy of
  // reason.db must never carry a saved login. Only the tables in its LOGINS_COVERAGE are let off here, and
  // the next test requires each of them to be exported (or kept out with a reason) and deleted.
  const { LOGINS_COVERAGE: LC } = await import("../src/savedlogins.js");
  for (const t of [...LC.exported, ...Object.keys(LC.notExported)]) made.delete(t);
  const have = new Set(tables());
  const missing = [...made].filter(t => !have.has(t));
  assert.deepEqual(missing, [], `tables made in src/ that this test never loaded — import their module above: ${missing.join(", ")}`);
});

test("the vault cannot be forgotten: every logins.db table is in LOGINS_COVERAGE, exported or kept out with a reason, and deleted by deleteAllFor, which deleteData calls before the key goes", async () => {
  const vault = readFileSync(new URL("../src/savedlogins.js", import.meta.url), "utf8");
  const sl = await import("../src/savedlogins.js");
  const LC = sl.LOGINS_COVERAGE;
  // The real file, built from the vault's own DDL, enumerated: no table is named by hand here.
  const { DatabaseSync } = await import("node:sqlite");
  const file = sl.loginsDbPath();
  assert.ok(file.startsWith(dir), "logins.db is in this test's directory");
  const ld = new DatabaseSync(file);
  ld.exec(sl.LOGINS_SCHEMA);
  const own = ld.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  const fromSource = [...vault.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*) *\(/g)].map(m => m[1]).sort();
  assert.deepEqual(own, fromSource, "every CREATE TABLE in savedlogins.js is in logins.db");
  const notExp = Object.keys(LC.notExported);
  for (const t of own) {
    assert.equal(LC.exported.includes(t) + notExp.includes(t), 1, `${t}: exported by exportFor, or kept out of an export with a reason (exactly one)`);
    assert.ok(LC.deleted.includes(t), `${t}: deleted by deleteAllFor and deleteEveryLogin`);
    assert.ok(!tables().includes(t), `${t} lives in logins.db, never in reason.db`);
  }
  for (const [t, why] of Object.entries(LC.notExported)) assert.ok(typeof why === "string" && why.length > 10, `${t}: a reason`);
  assert.deepEqual([...LC.exported, ...notExp, ...LC.deleted].filter(t => !own.includes(t)), [], "LOGINS_COVERAGE names no table that does not exist");
  // Rows for two people in every table; the export shows the saved login (no ciphertext, no key), the
  // scoped delete takes every row of one person and none of the other's.
  const row = (c, id) => {
    ld.prepare("INSERT INTO vault_people (conversation_id, handle) VALUES (?, ?)").run(c, `handle-${id}`);
    ld.prepare(`INSERT INTO saved_logins (id, conversation_id, site, label, signin_origin, signin_path, username_ct, password_ct, wrapped_key,
      kms_key, permission, consent_version, consent_at, consent_credential, created_at) VALUES (?, ?, 'example.test', 'Example',
      'https://example.test', '/signin', x'00', x'00', 'wrapped-${id}', 'stand-in', 'each_time', 'v1', 1, 'cred', 1)`).run(id, c);
    ld.prepare("INSERT INTO signin_routes (conversation_id, site, route, set_at) VALUES (?, 'doordash.test', 'google', 1)").run(c);
    ld.prepare("INSERT INTO call_passphrases (conversation_id, active_hash, active_set_how, active_set_at, active_words) VALUES (?, '{}', 'text', 1, 3)").run(c);
    ld.prepare("INSERT INTO call_passphrase_links (token_hash, conversation_id, purpose, expires_at) VALUES (?, ?, 'set', 1)").run(`t-${id}`, c);
    ld.prepare("INSERT INTO save_offers (conversation_id, site, offered_at) VALUES (?, 'example.test', 1)").run(c);
  };
  row(GONE, 1); row(STAYS, 2);
  const shown = sl.exportFor(GONE);
  assert.deepEqual(shown.map(r => [r.site, r.label]), [["example.test", "Example"]]);
  for (const k of ["username_ct", "password_ct", "totp_ct", "wrapped_key", "kms_key", "consent_credential", "handle"]) assert.ok(!(k in shown[0]), `export has no ${k}`);
  const personCols = t => ld.prepare(`PRAGMA table_info(${t})`).all().filter(c => PERSON_COLS.test(c.name)).map(c => c.name);
  const rowsOf = (t, c) => personCols(t).reduce((n, col) => n + ld.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).get(c).n, 0);
  for (const t of own) assert.ok(personCols(t).length, `${t} names whose rows they are`);
  sl.deleteAllFor(GONE);
  for (const t of own) {
    assert.equal(rowsOf(t, GONE), 0, `deleteAllFor leaves nothing of the person in ${t}`);
    assert.equal(rowsOf(t, STAYS), 1, `deleteAllFor leaves somebody else's row in ${t}`);
  }
  sl.deleteEveryLogin();
  for (const t of own) assert.equal(ld.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `deleteEveryLogin empties ${t}`);
  ld.close();
  const body = (src, name) => {
    const at = src.indexOf(`export function ${name}(`) >= 0 ? src.indexOf(`export function ${name}(`) : src.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, `${name} exists`);
    const next = src.indexOf("\nexport ", at + 1);
    return src.slice(at, next < 0 ? undefined : next);
  };
  for (const fn of ["deleteAllFor", "deleteEveryLogin"]) {
    const b = body(vault, fn);
    for (const t of LC.deleted) assert.match(b, new RegExp(`DELETE FROM ${t}\\b`), `${fn} deletes from ${t}`);
  }
  const src = readFileSync(new URL("../src/data.js", import.meta.url), "utf8");
  const del = body(src, "deleteData");
  const call = del.indexOf("deleteAllFor(conversation");
  assert.ok(call >= 0, "deleteData calls deleteAllFor for a scoped delete");
  assert.ok(del.indexOf("deleteEveryLogin()") >= 0, "and deleteEveryLogin for the whole install");
  for (const later of ["rotatePersonKey(", "destroyAllKeys(", "for (const t of CHILDREN_FIRST)"]) {
    assert.ok(del.indexOf(later) > call, `deleteAllFor runs before ${later}`);
  }
  assert.match(body(src, "exportData"), /exportFor\(conversation\)\.map\(r => \(\{ \.\.\.r, login: REDACTED \}\)\)/);
});

test("every table in the database is classified in src/data.js", () => {
  const c = coverage();
  const classes = [
    ["deleted", new Set(c.deleted)], ["global", new Set(c.global)],
    ["kept", new Set(Object.keys(c.kept ?? {}))], ["installWide", new Set(Object.keys(c.installWide ?? {}))],
  ];
  const none = [], twice = [];
  for (const t of tables()) {
    const hits = classes.filter(([, s]) => s.has(t)).map(([n]) => n);
    if (hits.length === 0) none.push(t);
    if (hits.length > 1) twice.push(`${t} (${hits.join(", ")})`);
  }
  assert.deepEqual(none, [], `tables a delete knows nothing about — add each to TABLES, KEPT_ON_DELETE (with a reason) or INSTALL_WIDE: ${none.join(", ")}`);
  assert.deepEqual(twice, [], `tables in more than one list: ${twice.join("; ")}`);
  for (const [t, why] of Object.entries({ ...(c.kept ?? {}), ...(c.installWide ?? {}) })) {
    assert.ok(typeof why === "string" && why.length > 10, `${t} is kept without a reason`);
  }
  const personal = Object.keys(c.installWide ?? {}).filter(t => tables().includes(t) && columns(t).some(col => PERSON_COLS.test(col.name)));
  assert.deepEqual(personal, [], `install-wide tables that hold a conversation id: ${personal.join(", ")}`);
});

/** One row in `t` with every person column set to `who` and every other required column filled. */
function seed(t, who, n, set = {}) {
  const cols = columns(t);
  const names = [], vals = [];
  for (const c of cols) {
    const type = String(c.type).toUpperCase();
    if (c.name in set) { names.push(c.name); vals.push(set[c.name]); continue; }
    if (PERSON_COLS.test(c.name)) { names.push(c.name); vals.push(who); continue; }
    if (c.pk && type.includes("INT") && cols.filter(x => x.pk).length === 1) continue;
    if (!c.notnull && !c.pk) continue;
    if (c.dflt_value != null && !c.pk) continue;
    names.push(c.name);
    vals.push(type.includes("INT") || type.includes("REAL") || type.includes("NUM") ? 1_000_000 + n : type.includes("BLOB") ? Buffer.from("x") : `seed-${t}-${c.name}-${n}`);
  }
  return sql.prepare(`INSERT INTO ${t} (${names.map(x => `"${x}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...vals).lastInsertRowid;
}

test("a scoped delete leaves nothing of that person in any table keyed by conversation, and nobody else's goes", async () => {
  const keyed = tables().filter(t => columns(t).some(c => PERSON_COLS.test(c.name)));
  assert.ok(keyed.length > 50, `only ${keyed.length} keyed tables found`);
  const unseedable = [];
  keyed.forEach((t, i) => {
    try { seed(t, GONE, i * 2); seed(t, STAYS, i * 2 + 1); } catch (e) { unseedable.push(`${t}: ${e.message}`); }
  });
  assert.deepEqual(unseedable, [], "rows the test could not seed");

  // The child tables reached through a parent rather than a conversation column.
  const run = sql.prepare("SELECT run_id FROM shop_runs WHERE conversation_id = ?").get(GONE).run_id;
  sql.prepare("INSERT INTO shop_run_asks (run_id, start_url, what, max_usd) VALUES (?, 'https://shop.example', 'socks', 20)").run(run);

  await data.deleteData({ conversation: GONE, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });

  const left = [], lostOther = [];
  for (const t of keyed) {
    const cols = columns(t).filter(c => PERSON_COLS.test(c.name)).map(c => c.name);
    const where = cols.map(c => `"${c}" = ?`).join(" OR ");
    const mine = sql.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get(...cols.map(() => GONE)).n;
    if (mine && !kept()[t]) left.push(`${t} (${mine})`);
    const theirs = sql.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get(...cols.map(() => STAYS)).n;
    if (!theirs) lostOther.push(t);
  }
  assert.deepEqual(left, [], `the deleted person's rows survived in: ${left.join(", ")}`);
  assert.deepEqual(lostOther, [], `somebody else's rows went too in: ${lostOther.join(", ")}`);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM shop_run_asks WHERE run_id = ?").get(run).n, 0, "the checkout run's ask survived its run");
  // The Web thread the next holder of this conversation id would read.
  assert.deepEqual(db.messagesBefore(GONE), []);
});

test("the photos they added to an event album go from disk with the rows", async () => {
  const ev = seed("events", STAYS, 9001, { public_id: "evpub1" });
  const album = seed("event_albums", STAYS, 9002, { event_id: ev });
  const albumDir = join(dir, "event-albums", "evpub1");
  mkdirSync(albumDir, { recursive: true });
  for (const [who, name] of [[GONE, "a.jpg"], [STAYS, "b.jpg"]]) {
    writeFileSync(join(albumDir, name), "jpeg");
    seed("event_photos", who, 9003 + name.length, { album_id: album, event_id: ev, file: join(albumDir, name), sha256: name });
  }
  await data.deleteData({ conversation: GONE, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(existsSync(join(albumDir, "a.jpg")), false, "their photo is still on disk");
  assert.equal(existsSync(join(albumDir, "b.jpg")), true, "somebody else's photo went too");
});

test("an export of the new tables does not carry the links and handles that open something", () => {
  sql.prepare("INSERT OR REPLACE INTO shop_cards (conversation_id, payment_method_id, saved_at) VALUES (?, 'pm_live_secret', 1)").run(STAYS);
  const out = data.exportData({ conversation: STAYS, audio: false, files: false });
  assert.ok(out.tables.shop_cards?.length, "shop_cards is in the export");
  assert.ok(!JSON.stringify(out).includes("pm_live_secret"), "the saved card's payment method id left in an export");
});
