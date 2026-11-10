// Isolation ratchet: no NEW SQL may read, change or delete a person's rows without naming whose.
//
// One SQLite file holds everyone; isolation is a `conversation_id = ?` in each statement. Existing
// statements that touch an owned table by row id alone (internal sweeps, a row this code just loaded
// for the same person, ops) are frozen in test/fixtures/unscoped-sql-baseline.json. A new statement
// that names no owner key fails here: scope it (preferred), or, if it is genuinely cross-person
// (scheduler, ops, a token lookup that IS the identity), add it to the baseline in the same PR so a
// reviewer sees it. Removing an entry from the baseline when a statement gets scoped is encouraged;
// the test also fails on stale entries so the file stays an honest list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scan, hitKey } from "./helpers/sql-scope-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "test/fixtures/unscoped-sql-baseline.json");

test("every SQL statement on a per-person table names its owner, or is on the reviewed baseline", () => {
  const { hits } = scan(root);
  const now = new Map();
  for (const h of hits) now.set(hitKey(h), (now.get(hitKey(h)) ?? 0) + 1);
  if (process.env.UPDATE_SCOPE_BASELINE === "1") {
    writeFileSync(baselinePath, JSON.stringify(Object.fromEntries([...now].sort()), null, 1) + "\n");
  }
  const base = new Map(Object.entries(JSON.parse(readFileSync(baselinePath, "utf8"))));
  const added = [...now].filter(([k, n]) => n > (base.get(k) ?? 0)).map(([k]) => {
    const h = hits.find(x => hitKey(x) === k);
    return `${h.file}:${h.line}  ${h.sql}`;
  });
  const stale = [...base].filter(([k, n]) => (now.get(k) ?? 0) < n).map(([k]) => k);
  assert.deepEqual(added, [], `New SQL on a per-person table with no conversation_id/owner condition. Scope it, or add it to ${baselinePath} with a reason in the PR:\n` + added.join("\n"));
  assert.deepEqual(stale, [], "Baseline lists statements that are gone or now scoped; rerun with UPDATE_SCOPE_BASELINE=1 to shrink it:\n" + stale.join("\n"));
});

test("the scanner itself catches an unscoped statement and passes a scoped one", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync: w } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "scope-scan-"));
  mkdirSync(join(dir, "src"));
  w(join(dir, "src/x.js"), [
    "db.exec(`CREATE TABLE IF NOT EXISTS memories (",
    "  id INTEGER PRIMARY KEY,",
    "  conversation_id TEXT NOT NULL,",
    "  fact TEXT",
    "  );`);",
    "// a comment with a stray ` backtick and it's apostrophe",
    'db.prepare("DELETE FROM memories WHERE id = ?").run(id);',
    'db.prepare("DELETE FROM memories WHERE id = ? AND conversation_id = ?").run(id, c);',
    "db.prepare(`SELECT fact FROM memories WHERE id = ${'?'}`).get(id);",
  ].join("\n"));
  const { hits, owned } = scan(dir);
  assert.ok(owned.has("memories"));
  assert.deepEqual(hits.map(h => [h.line, h.verb]), [[7, "DELETE"], [9, "SELECT"]]);
});
