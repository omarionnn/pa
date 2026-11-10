// Which button a saved login uses (connected_accounts.provider, src/socialsignin.js) is login data,
// so it is sealed at rest with the other phase-2 columns (src/restcrypt.js SENSITIVE2,
// REASON_ENCRYPT_REST2=on on top of phase 1): the file never holds the word in the clear, every read
// opens it, and strict mode refuses a plain write.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-social-rest-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_ENCRYPT_REST = "on";
process.env.REASON_ENCRYPT_REST2 = "on";
process.env.REASON_ENCRYPT_STRICT = "1";
process.env.REASON_REST_KEK_SOURCE = "local";
process.env.REASON_REST_KEK = "35".repeat(32);
process.env.REASON_TOKEN_KEY ||= "44".repeat(32);
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SOCIAL_SIGNIN = "owner";

const d = await import("../src/db.js");
const rc = d.restcrypt;
const social = await import("../src/socialsignin.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const C = "dm:owner";
const PROVIDER = "microsoft"; // the one provider name that appears nowhere else in a fresh test database

function fileHas(needle) {
  d.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = [process.env.REASON_DB_PATH, process.env.REASON_DB_PATH + "-wal"].filter(existsSync);
  return files.some(f => readFileSync(f).includes(Buffer.from(needle)));
}

test("the provider is written sealed, reads back plain, and the file never holds it in the clear", () => {
  assert.ok(rc.flag2On());
  assert.ok(rc.SENSITIVE2.some(s => s.table === "connected_accounts" && s.cols.includes("provider")));
  const row = d.recordSiteSignin(C, "amazon", { state: "signed_in", evidence: "the order page loaded", provider: PROVIDER });
  assert.equal(row.provider, PROVIDER, "a read opens it");
  const raw = d.rawPrepare("SELECT provider FROM connected_accounts WHERE id = ?").get(row.id).provider;
  assert.ok(rc.isSealed(raw), `stored sealed, not as ${raw}`);
  assert.equal(social.providerOf(C, "amazon"), PROVIDER);
  assert.deepEqual(social.sitesThrough(C, PROVIDER), ["amazon"]);
  assert.equal(fileHas(PROVIDER), false, "the database file does not contain the provider in the clear");
  // Strict mode: a plain write to that column is refused.
  assert.throws(() => d.db.prepare("UPDATE connected_accounts SET provider = 'google' WHERE id = ?").run(row.id), /plaintext write to connected_accounts\.provider/);
  // A row with no provider is fine (the empty string passes through unsealed, like every other column).
  const plain = d.recordSiteSignin(C, "opentable", { state: "signed_in", evidence: "t" });
  assert.equal(plain.provider, "");
});
