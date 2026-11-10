// What is running in this process right now that a restart would kill: a sign-in link somebody is
// mid-way through (its browser and its session live only in memory).
//
// Why a file: on 2026-11-10 a deploy restart at 22:38:55 UTC killed a live Notion sign-in mid-flow.
// The restart gate (.agents/skills/verify-reason/bin/idle.sh) only looked at calls in the database,
// and sign-in sessions are not in the database. So this process writes what it is holding to
// data/busy.json (kind, a short one-way id, the site key, when it began — never a token, a field, a
// number or a name), and the gate reads it. The file names the pid that wrote it, so a file left by
// a process that is gone says nothing. Checkouts are in the database (shop_runs) and the gate reads
// those there.
import { writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { config, clock } from "./config.js";

const held = new Map();
// Next to the database: /opt/reason/data on live, a test's own temp dir in a test.
let path = process.env.REASON_BUSY_PATH || join(dirname(config.dbPath), "busy.json");

/** Tests point this somewhere else. */
export function setBusyPath(p) { path = p; }
export const busyPath = () => path;

/** A short id that cannot be turned back into the link's token. */
export const shortId = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 10);

function write() {
  const body = JSON.stringify({ pid: process.pid, at: clock.now(), items: [...held.values()] });
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o640 });
    renameSync(tmp, path);
  } catch {
    // A write that fails must NOT leave an older file that still names this pid — the gate would
    // trust it (pid matches) and could read empty items while a sign-in is really in progress, the
    // very false-idle this exists to stop. So drop the file: no file for this pid makes the gate
    // fall back to the running process's journal, which still shows the sign-in.
    try { rmSync(path, { force: true }); } catch { /* nothing more to do; the gate then cannot tell → busy */ }
  }
}

/**
 * Something a restart must not cut. `kind`: signin_link (made, nobody has opened it yet) or signin
 * (a browser is open for it). `site` is the registry key or domain, nothing personal.
 */
export function hold(id, { kind, site = "" }) {
  const prev = held.get(id);
  held.set(id, { id: shortId(id), kind, site: String(site).slice(0, 60), since: prev?.since ?? clock.now() });
  write();
}

export function release(id) {
  if (held.delete(id)) write();
}

export const holding = () => [...held.values()];

/** At boot: whatever an earlier process left is not ours. Writes the file so the gate sees this pid. */
export function resetBusy() { held.clear(); write(); }
