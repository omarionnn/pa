#!/usr/bin/env node
// Encryption at rest, by hand (src/restcrypt.js). Run on the box as the reason user, with .env loaded:
//   node --env-file=.env scripts/encrypt-rest.mjs --status         sealed vs plain per column
//   node --env-file=.env scripts/encrypt-rest.mjs --seal           seal every plain row now (needs REASON_ENCRYPT_REST=on)
//   node --env-file=.env scripts/encrypt-rest.mjs --open           ROLLBACK: write every sealed row back as plain text
//                                                                  (set REASON_ENCRYPT_REST=off and restart first).
//                                                                  With REASON_ENCRYPT_REST=on and REASON_ENCRYPT_REST2=off,
//                                                                  it opens phase 2's columns only; phase 1 stays sealed.
//   node --env-file=.env scripts/encrypt-rest.mjs --rotate-install-key --server-stopped   new install key, every person key re-wrapped (Reason stopped)
//   ... --move-master --server-stopped        re-wrap install keys under REASON_REST_KEK_SOURCE (file -> aws-kms)
//   ... --rotate-master --server-stopped      new master key file; old backups' keystores become unopenable
//   ... --seal-recovery-copy                  write <master file>.age for the off-site backup (also after every rotation)
//   ... --prune-old-masters                   delete retired master files older than 3 days
// Batches of 500 with a short pause, so it can run beside the live server (WAL, busy_timeout).
const arg = process.argv[2] ?? "--status";
const childProcess = await import("node:child_process");
const { existsSync } = await import("node:fs");
const d = await import("../src/db.js");
const rc = d.restcrypt;
// The disaster-recovery copy of the master: sealed with age to the owner's key (the same one env.age
// uses), written beside it as <file>.age, which reason-offsite-backup uploads. Without one, losing the
// box loses everyone's history. REASON_REST_MASTER_AGE_RECIPIENT = the owner's age public key.
function ageSeal(from, to) {
  childProcess.execFileSync("age", ["-r", process.env.REASON_REST_MASTER_AGE_RECIPIENT, "-o", to, from]);
}
function sealRecoveryCopy() {
  if (!process.env.REASON_REST_MASTER_AGE_RECIPIENT) { console.error("REASON_REST_MASTER_AGE_RECIPIENT is not set: no recovery copy written."); process.exit(3); }
  const f = rc.kekFilePath();
  ageSeal(f, f + ".age");
  console.log(`recovery copy: ${f}.age`);
  // Phase 2's blind-index key (exact match on numbers) is recovered the same way.
  const ix = rc.indexKeyPath();
  if (existsSync(ix)) { ageSeal(ix, ix + ".age"); console.log(`recovery copy: ${ix}.age`); }
}
const pause = () => new Promise(r => setTimeout(r, 50));
if (arg === "--status") {
  console.table(rc.status(d.rawPrepare));
  console.table(d.restfiles.fileStatus());
  console.log(`flag=${rc.flagOn() ? "on" : "off"} flag2=${rc.flag2On() ? "on" : "off"} install_key=${rc.active() ? "unlocked" : "none"}`);
} else if (arg === "--seal" || arg === "--open") {
  if (arg === "--seal" && !rc.flagOn()) { console.error("REASON_ENCRYPT_REST is not on."); process.exit(2); }
  if (arg === "--open" && rc.flag2On()) { console.error("Set REASON_ENCRYPT_REST2=off (phase 2 only) or REASON_ENCRYPT_REST=off (everything), and restart the server, before opening rows back up, or new writes keep sealing."); process.exit(2); }
  // Phase 1 still on: roll back phase 2 alone.
  const phases = arg === "--open" && rc.flagOn() ? [2] : null;
  // Phase 2's files: sealed when phase 2 is on; opened on any rollback (files are phase 2 only).
  // A rollback opens files FIRST: with the rows open, a later start may not unlock the keystore.
  const files = async () => {
    const f = await d.restfiles.migrateFiles(d.rawPrepare, arg === "--seal" ? "seal" : "open");
    console.log(`files: ${JSON.stringify({ ...f, unowned_files: undefined })}`);
    if (f.unowned_files.length) console.log(`files with no owner found (left plain): ${f.unowned_files.join(", ")}`);
  };
  if (arg === "--open") await files();
  if (arg === "--open") rc.dropStrictTriggers(d.db);
  let total = 0, n;
  while ((n = rc.migrateBatch(d.rawPrepare, arg === "--seal" ? "seal" : "open", 500, phases)) > 0) { total += n; await pause(); }
  console.log(`${arg === "--seal" ? "sealed" : "opened"} ${total} value(s)${phases ? " (phase 2 only)" : ""}`);
  if (arg === "--seal" && rc.flag2On()) await files();
  const st = rc.status(d.rawPrepare).filter(r => !phases || phases.includes(r.phase));
  console.table(st);
  const left = st.reduce((n, r) => n + (arg === "--seal" ? r.plain : r.sealed), 0);
  if (left) console.error(`${left} value(s) left ${arg === "--seal" ? "plain (orphan facts with no person?)" : "sealed (two facts that read the same: UNIQUE(person_id, fact))"}. Keep keys.db until this is 0.`);
} else if (arg === "--rotate-install-key") {
  // The running server holds the install key in memory and would not see the new one: stop it first.
  if (!process.argv.includes("--server-stopped")) { console.error("Stop Reason first, then run with --rotate-install-key --server-stopped."); process.exit(2); }
  console.log(`install key now v${await rc.rotateInstallKey()}`);
} else if (arg === "--move-master" || arg === "--rotate-master") {
  if (!process.argv.includes("--server-stopped")) { console.error(`Stop Reason first, then run with ${arg} --server-stopped.`); process.exit(2); }
  if (arg === "--rotate-master" && !process.env.REASON_REST_MASTER_AGE_RECIPIENT) {
    console.error("REASON_REST_MASTER_AGE_RECIPIENT is not set: refusing to rotate without a recovery copy (losing this box would lose everyone's history).");
    process.exit(2);
  }
  console.log(arg === "--move-master" ? await rc.moveMaster()
    : await rc.rotateFileMaster({ sealRecovery: (from, to) => ageSeal(from, to) }));
} else if (arg === "--finish-rotation") {
  console.log(rc.finishRotation());
} else if (arg === "--seal-recovery-copy") {
  sealRecoveryCopy();
} else if (arg === "--prune-old-masters") {
  console.log(`removed ${rc.pruneOldMasters()} retired master key file(s) older than 3 days`);
} else { console.error("usage: --status | --seal | --open | --rotate-install-key | --move-master | --rotate-master | --seal-recovery-copy | --finish-rotation | --prune-old-masters"); process.exit(2); }
