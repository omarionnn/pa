// scripts/gcp-kms-check.mjs against the stand-in Google KMS: booleans only, dry run by default.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "gcp-kms-check-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const { standInGcp } = await import("./helpers/gcpkms-standin.js");
const g = await standInGcp({ dir });
after(() => g.close());
const keyJson = JSON.parse(readFileSync(g.keyFile, "utf8"));

function run(args, env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("REASON_GCP_")) delete base[k];
  return new Promise(res => execFile(process.execPath, [join(root, "scripts/gcp-kms-check.mjs"), ...args], {
    env: { ...base, REASON_GCP_KMS_ENDPOINT: g.endpoint, REASON_GCP_CRM_ENDPOINT: g.endpoint, ...env }, timeout: 30_000,
  }, (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout, err: stderr })));
}
// Every line is "name: true|false|null", the mode line, or a fixed note.
function onlyBooleans(out) {
  for (const line of out.trim().split("\n")) {
    if (/^mode: /.test(line) || /^note: /.test(line) || /^live checks skipped/.test(line)) continue;
    assert.match(line, /^ {0,2}[A-Za-z.0-9]+(: (true|false|null)| failed: [A-Za-z0-9_]+|: Google would not answer .*)$/, line);
  }
}
function nothingSecret(text) {
  for (const v of [keyJson.project_id, keyJson.client_email, keyJson.private_key_id, ...keyJson.private_key.split("\n").filter(l => l.length > 40)]) {
    assert.ok(!text.includes(v), "a value from the key file was printed");
  }
}

test("dry run (the default): checks the file and the names, asks Google nothing, prints booleans only", async () => {
  const before = g.calls.length + g.state.grantCalls;
  const r = await run(["--file", g.keyFile]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^mode: dry run/m);
  for (const k of ["file.privateKey", "file.tokenUri", "names.valid", "names.vault", "names.intake", "names.rest", "names.projectIsReasonKeys", "account.isReasonServer"]) {
    assert.match(r.out, new RegExp(`^${k.replace(".", "\\.")}: true$`, "m"), k);
  }
  assert.match(r.out, /^all: true$/m);
  assert.doesNotMatch(r.out, /live\./);
  onlyBooleans(r.out);
  nothingSecret(r.out + r.err);
  assert.equal(g.calls.length + g.state.grantCalls, before, "no network in a dry run");
});

test("dry run: a world-readable file, a wrong key name or a broken file fail, still with booleans only", async () => {
  chmodSync(g.keyFile, 0o644);
  let r = await run(["--file", g.keyFile]);
  chmodSync(g.keyFile, 0o600);
  assert.equal(r.code, 1);
  assert.match(r.out, /^file\.privateToOwner: false$/m);
  assert.match(r.out, /^note: the file is readable by others/m);
  assert.match(r.out, /^names\.valid: true$/m, "the names are still checked");
  nothingSecret(r.out + r.err);

  r = await run(["--file", g.keyFile], { REASON_GCP_VAULT_KEY: "reason-vault-2" });
  assert.equal(r.code, 1);
  assert.match(r.out, /^names\.vault: false$/m);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, readFileSync(g.keyFile, "utf8").slice(0, 300), { mode: 0o600 });
  r = await run(["--file", broken, "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^file\.json: false$/m);
  assert.match(r.out, /^live checks skipped/m);
  onlyBooleans(r.out);
  nothingSecret(r.out + r.err);
});

test("--yes: one round-trip on reason-vault, the other AAD refused, the intake public key, and no rights beyond the keys", async () => {
  const before = g.calls.length;
  const r = await run(["--file", g.keyFile, "--yes"]);
  assert.equal(r.code, 0, r.out + r.err);
  for (const k of ["live.token", "live.vault.encrypt", "live.vault.decryptMatches", "live.vault.otherAadRefused", "live.intake.publicKeyRsa4096Oaep",
    "rights.noneOnProject", "rights.noneOnKeyRing", "rights.vault.useOnly", "rights.intake.useOnly", "rights.rest.useOnly"]) {
    assert.match(r.out, new RegExp(`^${k.replaceAll(".", "\\.")}: true$`, "m"), k);
  }
  const ops = g.calls.slice(before).filter(c => c.op !== "testIamPermissions" && c.op !== "projectTestIamPermissions");
  assert.deepEqual(ops.map(c => [c.op, c.key, c.ok]), [["encrypt", "reason-vault", true], ["decrypt", "reason-vault", true],
    ["decrypt", "reason-vault", false], ["getPublicKey", "reason-vault-intake", true]]);
  onlyBooleans(r.out);
  nothingSecret(r.out + r.err);
});

test("--yes: a right on the whole project, an admin right on a key, or a missing grant fails the check", async () => {
  g.held.project.add("resourcemanager.projects.setIamPolicy");
  let r = await run(["--file", g.keyFile, "--yes"]);
  g.held.project.clear();
  assert.equal(r.code, 1);
  assert.match(r.out, /^rights\.noneOnProject: false$/m);

  g.held.key.add("cloudkms.cryptoKeys.setIamPolicy");
  r = await run(["--file", g.keyFile, "--yes"]);
  g.held.key.delete("cloudkms.cryptoKeys.setIamPolicy");
  assert.equal(r.code, 1);
  assert.match(r.out, /^rights\.vault\.useOnly: false$/m);

  g.keys.get("reason-vault").grants.delete("decrypt");
  r = await run(["--file", g.keyFile, "--yes"]);
  g.keys.get("reason-vault").grants.add("decrypt");
  assert.equal(r.code, 1);
  assert.match(r.out, /^live\.vault\.decryptMatches: false$/m);
  assert.match(r.out, /^ {2}live\.vault\.decryptMatches failed: PERMISSION_DENIED$/m);
  onlyBooleans(r.out);
  nothingSecret(r.out + r.err);
});
