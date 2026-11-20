// Open what you just found, don't offer to (src/agent.js system prompt). Pinned offline, no model:
//   1. a read-only lookup on their own data (a doc, mail or calendar item Reason just found) is done
//      in the same turn, not offered, and Reason comes back once with the result or the next step;
//   2. when a file will not open, Reason says what it tried and the one real route, and never points
//      at a tool or an access route it does not have;
//   3. the rules next to these still stand (ask before money, sending as them, the irreversible;
//      say the guess when acting on a sensible reading).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-open-found-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";

const { systemFor } = await import("../src/agent.js");
const sys = systemFor({ name: "Omari", known: true, isOperator: true });

test("opening their own doc, mail or calendar item it just found is done this turn, not offered", () => {
  assert.match(sys, /Never ask permission to finish what they asked for, or to open their doc, mail or calendar item you just found: do it this turn/);
  assert.match(sys, /come back once with the result or the one next step/);
});

test("a file that will not open gets what was tried and the one real route, never a made-up one", () => {
  assert.match(sys, /a file will not open: one line on what you tried and the one real route/);
  assert.match(sys, /its owner sharing it/);
  assert.match(sys, /never a tool or access you lack/);
});

test("the neighbouring rules still stand", () => {
  assert.match(sys, /Permission is only for spending money, sending as them, or the irreversible/);
  assert.match(sys, /Email attachment: gmail_attachment, never drive_read\./);
  assert.match(sys, /Only a word that names nothing real gets a guess, and then say the guess/);
  assert.match(sys, /acting on a sensible reading of their situation still stands/);
});
