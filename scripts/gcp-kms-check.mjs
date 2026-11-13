#!/usr/bin/env node
// Check Reason's Google Cloud KMS setup (the vault keys). Prints booleans only: never a value from the
// key file, never the project id or the account's email, never a key or a ciphertext.
//
//   node scripts/gcp-kms-check.mjs --file <service-account.json>          dry run (the default): no network
//   node scripts/gcp-kms-check.mjs --file <service-account.json> --yes    also asks Google, once each:
//        an encrypt + decrypt round-trip of a dummy value on reason-vault (plus one decrypt with another
//        AAD, which Google must refuse), getPublicKey on reason-vault-intake, and whether the account holds
//        any right on the whole project, the key ring, or beyond use on the keys.
// --file defaults to REASON_GCP_KEY_FILE. Key names follow src/gcpkms.js keyName (env overrides).
// Exit 0: every check true (a check Google cannot answer prints null and does not fail). Exit 1: any false.
import { randomBytes } from "node:crypto";
import * as gcp from "../src/gcpkms.js";

const args = process.argv.slice(2);
const at = args.indexOf("--file");
if (at >= 0) process.env.REASON_GCP_KEY_FILE = args[at + 1] ?? "";
const live = args.includes("--yes");
const results = [];
const say = (name, v) => { results.push(v); console.log(`${name}: ${v === null ? "null" : v ? "true" : "false"}`); };
const quiet = fn => { try { return fn(); } catch { return null; } };

// ---------------------------------------------------------------- dry run: the file and the names
console.log(`mode: ${live ? "live (asks Google)" : "dry run (no network)"}`);
const file = gcp.checkKeyFile();
for (const [k, v] of Object.entries(file)) say(`file.${k}`, v);
const fileOk = Object.values(file).every(Boolean);
const shapeOk = Object.entries(file).every(([k, v]) => v || k === "privateToOwner");
if (shapeOk && !file.privateToOwner) console.log("note: the file is readable by others; chmod 600 (or 640 root:reason) before Reason uses it");

// A fresh download is often readable by others: name the keys from its project id anyway (dry run only).
const identity = shapeOk ? gcp.fileIdentity() : null;
if (identity && !file.privateToOwner && !process.env.REASON_GCP_PROJECT) process.env.REASON_GCP_PROJECT = identity.projectId;
const names = shapeOk ? quiet(() => ({ vault: gcp.keyName("vault"), intake: gcp.intakeVersionName(), rest: gcp.keyName("rest") })) : null;
say("names.valid", !!names);
if (names) {
  const ring = names.vault.replace(/\/cryptoKeys\/[^/]+$/, "");
  say("names.locationUsWest1", /\/locations\/us-west1\/keyRings\//.test(ring));
  say("names.ringReason", ring.endsWith("/keyRings/reason"));
  say("names.vault", names.vault.endsWith("/cryptoKeys/reason-vault"));
  say("names.intake", names.intake.endsWith("/cryptoKeys/reason-vault-intake/cryptoKeyVersions/1"));
  say("names.rest", names.rest.endsWith("/cryptoKeys/reason-rest"));
  say("names.projectIsReasonKeys", /^projects\/reason-keys(-[a-z0-9-]+)?\//.test(names.vault));
  say("account.isReasonServer", String(identity?.email ?? "").startsWith("reason-server@"));
}

// ---------------------------------------------------------------- live: one call of each kind
async function liveChecks() {
  const ring = names.vault.replace(/\/cryptoKeys\/[^/]+$/, "");
  const AAD = Buffer.from('{"app":"reason","purpose":"gcp-kms-check"}');
  const dummy = randomBytes(32);
  const step = async (name, fn) => {
    try { say(name, await fn()); }
    catch (e) { say(name, false); console.log(`  ${name} failed: ${String(e?.gcpCode || e?.name || "error").replace(/[^A-Za-z0-9_]/g, "")}`); }
  };
  let wrapped = null;
  await step("live.token", async () => !!(await gcp.accessToken()));
  await step("live.vault.encrypt", async () => { wrapped = (await gcp.encrypt(names.vault, dummy, AAD)).ciphertext; return !!wrapped; });
  await step("live.vault.decryptMatches", async () => { const b = await gcp.decrypt(names.vault, wrapped, AAD); const ok = b.equals(dummy); b.fill(0); return ok; });
  await step("live.vault.otherAadRefused", async () => {
    try { (await gcp.decrypt(names.vault, wrapped, Buffer.from('{"app":"reason","purpose":"other"}'))).fill(0); return false; }
    catch (e) { return e?.gcpCode === "INVALID_ARGUMENT"; }
  });
  dummy.fill(0);
  await step("live.intake.publicKeyRsa4096Oaep", async () => (await gcp.getPublicKey(names.intake)).algorithm === "RSA_DECRYPT_OAEP_4096_SHA256");

  // Rights: none on the project, none on the key ring, and on each key nothing beyond using it.
  const projectPerms = ["resourcemanager.projects.getIamPolicy", "resourcemanager.projects.setIamPolicy", "iam.serviceAccountKeys.create",
    "iam.serviceAccounts.actAs", "serviceusage.services.enable", "cloudkms.keyRings.create", "cloudkms.cryptoKeys.create",
    "cloudkms.cryptoKeyVersions.useToDecrypt", "cloudkms.cryptoKeyVersions.destroy"];
  try {
    const project = names.vault.split("/")[1];
    say("rights.noneOnProject", (await gcp.testProjectPermissions(project, projectPerms)).length === 0);
  } catch {
    say("rights.noneOnProject", null);
    console.log("  rights.noneOnProject: Google would not answer (often the Cloud Resource Manager API is off); key-level checks below still count");
  }
  await step("rights.noneOnKeyRing", async () => (await gcp.testKmsPermissions(ring, ["cloudkms.keyRings.getIamPolicy", "cloudkms.keyRings.setIamPolicy",
    "cloudkms.cryptoKeys.create", "cloudkms.cryptoKeys.list", "cloudkms.importJobs.create"])).length === 0);
  const admin = ["cloudkms.cryptoKeys.setIamPolicy", "cloudkms.cryptoKeys.getIamPolicy", "cloudkms.cryptoKeys.update",
    "cloudkms.cryptoKeyVersions.create", "cloudkms.cryptoKeyVersions.destroy", "cloudkms.cryptoKeyVersions.update"];
  const use = ["cloudkms.cryptoKeyVersions.useToEncrypt", "cloudkms.cryptoKeyVersions.useToDecrypt", "cloudkms.cryptoKeyVersions.viewPublicKey"];
  const want = { vault: ["cloudkms.cryptoKeyVersions.useToEncrypt", "cloudkms.cryptoKeyVersions.useToDecrypt"],
    rest: ["cloudkms.cryptoKeyVersions.useToEncrypt", "cloudkms.cryptoKeyVersions.useToDecrypt"],
    intake: ["cloudkms.cryptoKeyVersions.useToDecrypt", "cloudkms.cryptoKeyVersions.viewPublicKey"] };
  for (const which of ["vault", "intake", "rest"]) {
    const key = which === "intake" ? names.intake.replace(/\/cryptoKeyVersions\/\d+$/, "") : names[which];
    await step(`rights.${which}.useOnly`, async () => {
      const held = await gcp.testKmsPermissions(key, [...admin, ...use]);
      return held.every(p => use.includes(p)) && want[which].every(p => held.includes(p));
    });
  }
}

if (live) {
  if (!fileOk || !names) { console.log("live checks skipped: fix the file checks above first"); results.push(false); }
  else await liveChecks();
}
const failed = results.some(v => v === false);
console.log(`all: ${failed ? "false" : "true"}`);
process.exitCode = failed ? 1 : 0;
