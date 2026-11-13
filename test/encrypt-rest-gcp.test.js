// Encryption at rest with its master key on Google Cloud KMS (REASON_REST_KEK_SOURCE=gcp-kms, key
// "reason-rest"), against the stand-in in test/helpers/gcpkms-standin.js. An option beside aws-kms:
// the default source stays "file", and this file checks that too. Nothing here reaches Google.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const realSetTimeout = globalThis.setTimeout;
const BACKOFF = new Set([500, 1000, 2000, 4000, 8000]);
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, BACKOFF.has(ms) ? 1 : ms, ...a);

const dir = mkdtempSync(join(tmpdir(), "encrest-gcp-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.REASON_ENCRYPT_REST = "on";
delete process.env.REASON_REST_KEK;
delete process.env.REASON_REST_KMS_KEY_ID;

const { standInGcp, useStandIn } = await import("./helpers/gcpkms-standin.js");
mkdirSync(join(dir, "g"));
const g = await standInGcp({ dir: join(dir, "g") });
after(() => g.close());
useStandIn(g);
const rc = await import("../src/restcrypt.js");

const C = "dm:encrest-gcp-person";
const SECRET = "a made-up note for the gcp-kms master key test";
const sources = dbPath => { const d = new DatabaseSync(rc.keystorePath(dbPath)); try { return d.prepare("SELECT source FROM install_key ORDER BY version").all().map(r => r.source); } finally { d.close(); } };
const ops = () => g.calls.filter(c => c.op === "encrypt" || c.op === "decrypt");

test("the default source is still the file, and Google is not asked, even with the Google key file set", async () => {
  delete process.env.REASON_REST_KEK_SOURCE;
  const kek = join(dir, "master.key");
  writeFileSync(kek, "ab".repeat(32) + "\n", { mode: 0o600 });
  process.env.REASON_REST_KEK_FILE = kek;
  const db = join(dir, "default", "reason.db");
  mkdirSync(join(dir, "default"));
  rc._resetForTests();
  await rc.init(db);
  assert.deepEqual(sources(db), ["file"]);
  assert.equal(g.calls.length, 0);
});

test("gcp-kms: the install key is wrapped by reason-rest with the install-key AAD; a fresh process opens it with one decrypt", async () => {
  process.env.REASON_REST_KEK_SOURCE = "gcp-kms";
  const db = join(dir, "gcp", "reason.db");
  mkdirSync(join(dir, "gcp"));
  rc._resetForTests();
  await rc.init(db);
  assert.deepEqual(sources(db), ["gcp-kms"]);
  assert.deepEqual(ops().map(c => [c.op, c.key, c.ok, c.aad]), [["encrypt", "reason-rest", true, '{"app":"reason","purpose":"install-key"}']]);
  const sealed = rc.sealFor(C, SECRET);
  assert.ok(rc.isSealed(sealed));

  rc._resetForTests();
  const before = ops().length;
  await rc.init(db);
  assert.equal(rc.openAny(sealed), SECRET);
  assert.deepEqual(ops().slice(before).map(c => [c.op, c.key, c.ok]), [["decrypt", "reason-rest", true]]);

  // A throttle at boot is retried; a refusal is not, and the keystore does not unlock.
  rc._resetForTests();
  g.fail.push([429, "RESOURCE_EXHAUSTED"], [503, "UNAVAILABLE"]);
  await rc.init(db);
  assert.equal(rc.openAny(sealed), SECRET);
  rc._resetForTests();
  const b2 = g.calls.length;
  g.fail.push([403, "PERMISSION_DENIED"]);
  await assert.rejects(rc.init(db), { gcpCode: "PERMISSION_DENIED" });
  assert.equal(g.calls.length - b2, 1);

  // Someone else's Google project (same names, other keys) cannot unlock this keystore.
  mkdirSync(join(dir, "theirs"));
  const theirs = await standInGcp({ dir: join(dir, "theirs") });
  useStandIn(theirs);
  try {
    rc._resetForTests();
    await assert.rejects(rc.init(db), { gcpCode: "INVALID_ARGUMENT" });
  } finally { await theirs.close(); useStandIn(g); }
  rc._resetForTests();
  await rc.init(db);
  assert.equal(rc.openAny(sealed), SECRET);
});

test("moving the master from the file to gcp-kms (moveMaster, Reason stopped): no data row changes, and the file is no longer needed", async () => {
  delete process.env.REASON_REST_KEK_SOURCE;           // today's source: the file
  const db = join(dir, "move", "reason.db");
  mkdirSync(join(dir, "move"));
  rc._resetForTests();
  await rc.init(db);
  const sealed = rc.sealFor(C, SECRET);
  assert.deepEqual(sources(db), ["file"]);

  process.env.REASON_REST_KEK_SOURCE = "gcp-kms";
  const r = await rc.moveMaster();
  assert.deepEqual(r, { source: "gcp-kms", versions: 1 });
  assert.deepEqual(sources(db), ["gcp-kms"]);

  process.env.REASON_REST_KEK_FILE = join(dir, "no-such-master.key");   // the file is gone
  rc._resetForTests();
  await rc.init(db);
  assert.equal(rc.openAny(sealed), SECRET, "the same sealed value opens through Google");
});
