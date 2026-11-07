// Every connection Reason opens waits out another's write lock instead of failing at once.
//
// The incident (2026-11-06): the recall backfill (scripts/recall-backfill.mjs, its own process)
// wrote beside the running server and two writes failed with "database is locked". SQLite's
// default busy_timeout is 0, so a write that meets a lock gives up immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-busy-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;

const db = await import("../src/db.js");

test("the server's connection waits 5 s for a lock", () => {
  assert.equal(db.BUSY_TIMEOUT_MS, 5000);
  assert.equal(Object.values(db.db.prepare("PRAGMA busy_timeout").get())[0], 5000);
});

test("a write that meets another process's lock waits for it and lands, instead of 'database is locked'", async () => {
  db.db.exec("CREATE TABLE IF NOT EXISTS busy_probe (id INTEGER PRIMARY KEY, who TEXT)");
  // Another process (as the backfill was) takes the write lock and holds it for 700 ms.
  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1]);
    d.exec("BEGIN IMMEDIATE");
    d.prepare("INSERT INTO busy_probe (who) VALUES ('other')").run();
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    d.exec("COMMIT");
  `, process.env.REASON_DB_PATH], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { holder.stdout.once("data", res); holder.once("exit", c => rej(new Error(`holder exited ${c}`))); });
  const t0 = Date.now();
  db.db.prepare("INSERT INTO busy_probe (who) VALUES ('server')").run();
  assert.ok(Date.now() - t0 >= 200, "it did wait on the lock");
  await new Promise(r => holder.once("exit", r));
  assert.deepEqual(db.db.prepare("SELECT who FROM busy_probe ORDER BY id").all().map(r => r.who), ["other", "server"]);
});

test("the scripts that open their own connection set it too", () => {
  for (const f of ["scripts/call-report.js", "scripts/web-migrate-dry-run.mjs"]) {
    assert.match(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /PRAGMA busy_timeout = 5000/, f);
  }
});
