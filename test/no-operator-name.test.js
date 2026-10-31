// Omari's rule (2026-10-31): nothing about him reaches other people — not even his name. Every line a
// stranger, an access asker, or a stopped account is sent names nobody.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-noname-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Zebedee";
process.env.REASON_CONVERSATION = "dm:owner";

const { config } = await import("../src/config.js");
const accounts = await import("../src/accounts.js");
const stranger = await import("../src/calls/stranger.js");

test("stopped, stranger and neutral lines never contain config.ownerName", () => {
  try {
    for (const name of ["Zebedee", "Omari"]) {
      config.ownerName = name;
      for (const line of [accounts.stoppedLine("paused"), accounts.stoppedLine("removed"), stranger.introLine(), stranger.neutralLine(), stranger.strangerPrompt()]) {
        assert.ok(!line.includes(name), `${name} in: ${line.slice(0, 80)}`);
      }
    }
    assert.match(accounts.stoppedLine("paused"), /^hey — this is paused for now/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no line sent to somebody asking for access (toThem) is built with the operator's name", () => {
  const src = readFileSync(new URL("../src/access.js", import.meta.url), "utf8");
  const toThem = src.split("\n").filter(l => /toThem\s*[:=]|^\s*[?:]\s*`/.test(l));
  assert.ok(toThem.length >= 5, "the access lines were found");
  for (const l of toThem) assert.doesNotMatch(l, /ownerName/, l.trim());
});
