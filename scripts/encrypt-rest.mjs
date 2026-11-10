#!/usr/bin/env node
// Encryption at rest, by hand (src/restcrypt.js). Run on the box as the reason user, with .env loaded:
//   node --env-file=.env scripts/encrypt-rest.mjs --status         sealed vs plain per column
//   node --env-file=.env scripts/encrypt-rest.mjs --seal           seal every plain row now (needs REASON_ENCRYPT_REST=on)
//   node --env-file=.env scripts/encrypt-rest.mjs --open           ROLLBACK: write every sealed row back as plain text
//                                                                  (set REASON_ENCRYPT_REST=off and restart first)
//   node --env-file=.env scripts/encrypt-rest.mjs --rotate-install-key --server-stopped   new install key, every person key re-wrapped (Reason stopped)
// Batches of 500 with a short pause, so it can run beside the live server (WAL, busy_timeout).
const arg = process.argv[2] ?? "--status";
const d = await import("../src/db.js");
const rc = d.restcrypt;
const pause = () => new Promise(r => setTimeout(r, 50));
if (arg === "--status") {
  console.table(rc.status(d.rawPrepare));
  console.log(`flag=${rc.flagOn() ? "on" : "off"} install_key=${rc.active() ? "unlocked" : "none"}`);
} else if (arg === "--seal" || arg === "--open") {
  if (arg === "--seal" && !rc.flagOn()) { console.error("REASON_ENCRYPT_REST is not on."); process.exit(2); }
  if (arg === "--open" && rc.flagOn()) { console.error("Set REASON_ENCRYPT_REST=off (and restart the server) before opening rows back up, or new writes keep sealing."); process.exit(2); }
  if (arg === "--open") rc.dropStrictTriggers(d.db);
  let total = 0, n;
  while ((n = rc.migrateBatch(d.rawPrepare, arg === "--seal" ? "seal" : "open", 500)) > 0) { total += n; await pause(); }
  console.log(`${arg === "--seal" ? "sealed" : "opened"} ${total} value(s)`);
  const st = rc.status(d.rawPrepare);
  console.table(st);
  const left = st.reduce((n, r) => n + (arg === "--seal" ? r.plain : r.sealed), 0);
  if (left) console.error(`${left} value(s) left ${arg === "--seal" ? "plain (orphan facts with no person?)" : "sealed (two facts that read the same: UNIQUE(person_id, fact))"}. Keep keys.db until this is 0.`);
} else if (arg === "--rotate-install-key") {
  // The running server holds the install key in memory and would not see the new one: stop it first.
  if (!process.argv.includes("--server-stopped")) { console.error("Stop Reason first, then run with --rotate-install-key --server-stopped."); process.exit(2); }
  console.log(`install key now v${await rc.rotateInstallKey()}`);
} else { console.error("usage: --status | --seal | --open | --rotate-install-key"); process.exit(2); }
