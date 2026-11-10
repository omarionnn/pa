// Encryption at rest (src/restcrypt.js, REASON_ENCRYPT_REST=on). What has to hold:
//   - with the flag on, no sensitive column is ever written as plain text (strict triggers make
//     SQLite refuse it, and a raw scan of the file finds no plain words);
//   - everything reads back exactly as written, through the ordinary functions;
//   - old plain rows are sealed online in batches, and --open (rollback) puts them back;
//   - "forget everything" re-keys the person, so a backup copy taken before is unreadable,
//     while the rows that stay still read;
//   - a copy of reason.db without the keystore and master key gives up no words.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-encrest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "11".repeat(32);
process.env.REASON_WEB = "1";
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);

const d = await import("../src/db.js");
const rc = d.restcrypt;
const ios = await import("../src/ios/memory.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:sendblue:+15550001111";
const SECRET = "my blood type is AB negative and the safe code is 4417";

function rawScan(needle) {
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return readFileSync(process.env.REASON_DB_PATH).includes(Buffer.from(needle));
}

test("flag on: every phase-1 column is written sealed, and reads back as written", () => {
  assert.ok(rc.active());
  d.saveConversation(C, [{ role: "user", content: SECRET }]);
  d.writeEvent({ conversationId: C, role: "user", content: SECRET, toolCalls: [{ name: "remember", input: { fact: SECRET } }] });
  d.writeMessage({ conversationId: C, role: "user", channel: "sendblue", text: SECRET });
  const r = d.remember(C, "me", SECRET);
  assert.ok(r.factId);
  const call = d.createCall(C, { provider: "twilio", toNumber: "+15550002222", isOwner: true, goal: "check in", facts: [] });
  d.updateCall(C, call.id, { transcript: `them: ${SECRET}`, summary: SECRET, turn_log: JSON.stringify([{ heard: SECRET }]) });

  assert.deepEqual(d.loadConversation(C), [{ role: "user", content: SECRET }]);
  assert.equal(d.recentEvents(C, { limit: 5 }).find(e => e.role === "user").content, SECRET);
  assert.ok(d.personFacts(r.personId ?? d.db.prepare("SELECT person_id FROM person_facts WHERE id = ?").get(r.factId).person_id).some(f => f.fact === SECRET));
  const back = d.getCall(C, call.id);
  assert.equal(back.summary, SECRET);
  assert.equal(back.transcript, `them: ${SECRET}`);

  // Raw rows: every value sealed, none plain.
  for (const s of rc.status(d.rawPrepare)) assert.equal(s.plain, 0, `${s.column} has plain rows`);
  assert.equal(rawScan("AB negative"), false, "the words are nowhere in the database file");
});

test("strict mode: a write path that forgets to seal is refused by SQLite", () => {
  assert.throws(() => d.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, 'user', ?, 1)").run(C, "plain words"),
    /plaintext write to event_log\.content/);
  assert.throws(() => d.db.prepare("UPDATE calls SET transcript = 'plain' WHERE conversation_id = ?").run(C), /plaintext write to calls\.transcript/);
  // Empty and the empty list are not secrets and stay as they are.
  d.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, 'user', '', 1)").run(C);
});

test("a stolen copy of reason.db alone opens nothing", () => {
  const copy = join(dir, "stolen.db");
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(process.env.REASON_DB_PATH, copy);
  const s = new DatabaseSync(copy);
  const vals = s.prepare("SELECT content FROM event_log WHERE content <> ''").all().map(r => r.content);
  assert.ok(vals.length > 0 && vals.every(v => v.startsWith("enc:u1:")));
  s.close();
});

test("online migration seals old plain rows, and rollback opens them again", () => {
  rc.dropStrictTriggers(d.db);
  const old = "an old plain message from before the switch";
  d.rawPrepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, 'user', ?, 2)").run(C, old);
  d.rawPrepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'user', 'sendblue', ?, 2)").run(C, old);
  assert.ok(rc.status(d.rawPrepare).some(s => s.plain > 0));
  let n, total = 0;
  while ((n = rc.migrateBatch(d.rawPrepare, "seal", 1)) > 0) total += n;
  assert.ok(total >= 2);
  assert.ok(rc.status(d.rawPrepare).every(s => s.plain === 0));
  assert.ok(d.recentEvents(C, { limit: 20 }).some(e => e.content === old), "reads the same after sealing");

  // Rollback: everything written back as plain text, reads unchanged.
  while (rc.migrateBatch(d.rawPrepare, "open", 50) > 0);
  assert.ok(rc.status(d.rawPrepare).every(s => s.sealed === 0));
  assert.ok(d.recentEvents(C, { limit: 20 }).some(e => e.content === old));
  assert.equal(d.loadConversation(C)[0].content, SECRET);
  // And forward again, for the tests after this one.
  while (rc.migrateBatch(d.rawPrepare, "seal", 50) > 0);
  rc.installStrictTriggers(d.db);
});

test("forget everything re-keys the person: an earlier backup is unreadable, kept call rows still read", async () => {
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const backup = join(dir, "backup-before.db");
  copyFileSync(process.env.REASON_DB_PATH, backup);
  const sealedThen = new DatabaseSync(backup).prepare("SELECT content FROM event_log WHERE conversation_id = ? AND content <> '' ORDER BY id LIMIT 1").get(C).content;
  assert.equal(rc.openAny(sealedThen), SECRET, "readable while the key exists");

  d.upsertAccount({ conversationId: C, channel: "sendblue", address: "+15550001111" });
  const res = await ios.forgetEverything({ conversation_id: C });
  assert.equal(res.ok, true);
  // The backup's ciphertext now has no key anywhere: it reads as nothing.
  assert.equal(rc.openAny(sealedThen), rc.SHREDDED);
  // The call record stays and still reads, under the new key.
  const call = d.db.prepare("SELECT summary FROM calls WHERE conversation_id = ?").get(C);
  assert.equal(call.summary, SECRET);
});

test("a fresh process unlocks with the same master key; a wrong master key cannot", async () => {
  const sealed = d.rawPrepare("SELECT summary FROM calls WHERE conversation_id = ?").get(C).summary;
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH);
  assert.equal(rc.openAny(sealed), SECRET);
  rc._resetForTests();
  process.env.REASON_REST_KEK = "33".repeat(32);
  await assert.rejects(rc.init(process.env.REASON_DB_PATH));
  process.env.REASON_REST_KEK = "11".repeat(32);
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH);
});

test("install key rotation re-wraps person keys without touching data rows", async () => {
  const before = d.rawPrepare("SELECT summary FROM calls WHERE conversation_id = ?").get(C).summary;
  const v = await rc.rotateInstallKey();
  assert.equal(v, 2);
  assert.equal(d.rawPrepare("SELECT summary FROM calls WHERE conversation_id = ?").get(C).summary, before);
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH);
  assert.equal(rc.openAny(before), SECRET);
});

test("a missing or wrong keystore refuses to start instead of reading everyone as blank", async () => {
  const { renameSync } = await import("node:fs");
  const ksPath = rc.keystorePath(process.env.REASON_DB_PATH);
  rc._resetForTests();
  renameSync(ksPath, ksPath + ".away");
  try {
    await assert.rejects(rc.init(process.env.REASON_DB_PATH, { hasSealed: () => rc.anySealed(d.rawPrepare) }), /keystore .* is missing/);
  } finally { renameSync(ksPath + ".away", ksPath); }
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH, { hasSealed: () => rc.anySealed(d.rawPrepare) });
  // A key id that is neither in the keystore nor destroyed is a loud error, never a blank.
  assert.throws(() => rc.openAny("enc:u1:999:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA"), /not in the keystore and was never destroyed/);
});

test("a person key wrapped under a retired install key still opens (a process that missed a rotation)", async () => {
  const conv = "dm:sendblue:+15550003333";
  const sealed = rc.forceSeal(conv, "made before the rotation");
  await rc.rotateInstallKey();
  rc._resetForTests();
  await rc.init(process.env.REASON_DB_PATH);
  assert.equal(rc.openAny(sealed), "made before the rotation");
});

test("delete my data (src/data.js deleteData) destroys their key: a backup copy taken before is unreadable", async () => {
  const conv = "dm:sendblue:+15550004444";
  d.writeEvent({ conversationId: conv, role: "user", content: "the words a deleted person said" });
  const before = d.rawPrepare("SELECT content FROM event_log WHERE conversation_id = ?").get(conv).content;
  assert.ok(rc.isSealed(before));
  const { deleteData } = await import("../src/data.js");
  const res = await deleteData({ conversation: conv, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.equal(res.key_destroyed, true);
  assert.equal(rc.openAny(before), rc.SHREDDED, "the old ciphertext, as a backup holds it, opens to nothing");
});

test("AWS SigV4 matches the published get-vanilla vector", () => {
  // aws-sig-v4-test-suite/get-vanilla: GET / on example.amazonaws.com, service "service", us-east-1.
  const h = rc.sigv4({ method: "GET", host: "example.amazonaws.com", path: "/", query: "", headers: {}, body: "",
    region: "us-east-1", service: "service", accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", amzDate: "20150830T123600Z" });
  assert.equal(h.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});
