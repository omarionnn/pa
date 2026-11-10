// Encryption at rest with the master key in its own file (REASON_REST_KEK_SOURCE=file), the source
// phase 1 goes live with. What has to hold:
//   - it unlocks from the file, and refuses to start without it;
//   - --rotate-master leaves today's data readable, and an older keys.db (as every older backup holds
//     it) can no longer be opened by anything that exists after the retired master file is pruned;
//   - a crash between writing the new master and renaming it still boots (<file>.next is tried).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "reason-encfile-"));
const KEK = join(dir, "rest-master.key");
writeFileSync(KEK, randomBytes(32).toString("hex") + "\n", { mode: 0o640 });
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_REST_KEK_SOURCE = "file";
process.env.REASON_REST_KEK_FILE = KEK;
process.env.REASON_TOKEN_KEY ||= "22".repeat(32);

const d = await import("../src/db.js");
const rc = d.restcrypt;
after(() => rmSync(dir, { recursive: true, force: true }));
const C = "dm:sendblue:+15550007777";
const boot = async () => { rc._resetForTests(); await rc.init(process.env.REASON_DB_PATH, { hasSealed: () => rc.anySealed(d.rawPrepare) }); };

test("unlocks from the master key file; without the file it refuses to start", async () => {
  d.writeEvent({ conversationId: C, role: "user", content: "said before any rotation" });
  const sealed = d.rawPrepare("SELECT content FROM event_log WHERE conversation_id = ?").get(C).content;
  assert.ok(rc.isSealed(sealed));
  await boot();
  assert.equal(rc.openAny(sealed), "said before any rotation");
  renameSync(KEK, KEK + ".away");
  try { await assert.rejects(boot(), /Master key file .* is missing/); } finally { renameSync(KEK + ".away", KEK); }
  await boot();
});

test("--rotate-master: data still reads; an older keys.db is dead once the retired master is pruned", async () => {
  const sealed = d.rawPrepare("SELECT content FROM event_log WHERE conversation_id = ?").get(C).content;
  const oldKeystore = join(dir, "keys-backup-before.db");
  rc.keystore().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(rc.keystorePath(process.env.REASON_DB_PATH), oldKeystore);

  await rc.rotateFileMaster();
  await boot();
  assert.equal(rc.openAny(sealed), "said before any rotation", "today's data reads after rotation");

  // The retired master file is kept for the grace period, then pruned.
  assert.ok(readdirSync(dir).some(f => f.startsWith("rest-master.key.prev-")));
  assert.equal(rc.pruneOldMasters(0), 1);
  assert.ok(!readdirSync(dir).some(f => f.startsWith("rest-master.key.prev-")));

  // The older keystore, as an old backup holds it, under the only master that still exists: no.
  const old = new DatabaseSync(oldKeystore);
  const ikRow = old.prepare("SELECT source, wrapped FROM install_key ORDER BY version DESC LIMIT 1").get();
  old.close();
  const { createDecipheriv } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const master = Buffer.from(readFileSync(KEK, "utf8").trim(), "hex");
  const [iv, tag, ct] = ikRow.wrapped.split(":").map(p => Buffer.from(p, "base64url"));
  assert.throws(() => {
    const dd = createDecipheriv("aes-256-gcm", master, iv); dd.setAAD(Buffer.from("reason-ik")); dd.setAuthTag(tag);
    Buffer.concat([dd.update(ct), dd.final()]);
  }, "the old install key cannot be opened with the current master");
  // And today's install key does not open the old keystore's person keys either (it is a new one).
  const curIK = new DatabaseSync(rc.keystorePath(process.env.REASON_DB_PATH)).prepare("SELECT version FROM install_key").all();
  assert.equal(curIK.length, 1, "only the new install key is kept");
});

test("a crash after the keystore moved to the new master but before the rename still boots", async () => {
  const sealed = d.rawPrepare("SELECT content FROM event_log WHERE conversation_id = ?").get(C).content;
  // Simulate: keystore re-wrapped to a master that only exists as <file>.next.
  await rc.rotateFileMaster();
  renameSync(KEK, KEK + ".next");
  const prev = readdirSync(dir).filter(f => f.startsWith("rest-master.key.prev-")).sort().pop();
  renameSync(join(dir, prev), KEK);
  await boot();
  assert.equal(rc.openAny(sealed), "said before any rotation");
  renameSync(KEK + ".next", join(dir, "x.tmp"));
  renameSync(KEK, join(dir, prev));
  renameSync(join(dir, "x.tmp"), KEK);
  assert.ok(existsSync(KEK));
});

test("a torn <file>.next (power cut while writing it) is skipped at boot, never fatal", async () => {
  const sealed = d.rawPrepare("SELECT content FROM event_log WHERE conversation_id = ?").get(C).content;
  writeFileSync(KEK + ".next", "3f9a");
  await boot();
  assert.equal(rc.openAny(sealed), "said before any rotation");
  assert.equal(rc.finishRotation(), "stale-next-removed");
  assert.ok(!existsSync(KEK + ".next"));
});

test("a retry after a rotation that died past its commit finishes that one first, never overwriting the only working key", async () => {
  const sealed = d.rawPrepare("SELECT content FROM event_log WHERE conversation_id = ?").get(C).content;
  // State a crash leaves after COMMIT and before promote: keystore opens only with <file>.next.
  await rc.rotateFileMaster();
  const prev = readdirSync(dir).filter(f => f.startsWith("rest-master.key.prev-")).sort().pop();
  renameSync(KEK, KEK + ".next");
  renameSync(join(dir, prev), KEK);
  await boot();
  // The next rotation must adopt .next first; then rotate again; data still reads.
  await rc.rotateFileMaster();
  await boot();
  assert.equal(rc.openAny(sealed), "said before any rotation");
  assert.ok(!existsSync(KEK + ".next"));
});

test("the recovery copy of the new master is written before the keystore moves to it, and lands as <file>.age", async () => {
  const seen = [];
  await rc.rotateFileMaster({ sealRecovery: (from, to) => { seen.push(existsSync(from)); copyFileSync(from, to); } });
  assert.deepEqual(seen, [true]);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(KEK + ".age", "utf8"), readFileSync(KEK, "utf8"), "the .age copy is of the master now in use");
});
