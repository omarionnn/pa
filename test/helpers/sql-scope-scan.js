// Static scan for SQL that touches a person's rows without naming whose rows.
//
// SQLite has no row-level security: one database holds everyone, and the only thing between one
// person's facts/messages/calls and another's is a `WHERE conversation_id = ?` in each query. This
// scanner finds every SQL string literal in src/ that reads or writes a table carrying a
// conversation_id column and reports the ones that never mention an owner key. The ratchet test
// (test/db-scope-ratchet.test.js) fails when a NEW one appears, so an unscoped query has to be
// either scoped or written down with its reason before it can land.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Columns that pin a row to one person. */
export const OWNER_KEYS = ["conversation_id", "owner_conversation_id", "organizer_conversation_id", "conversation"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); }
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/**
 * SQL string literals in a JS source, with their line numbers. Anchored on a quote that opens with
 * an upper-case SQL verb, then read to the matching close quote (escapes and ${…} handled), so a
 * stray backtick or apostrophe in a comment cannot knock the reader out of step for the rest of a file.
 */
function literals(src) {
  const out = [];
  const start = /(["'`])\s*(SELECT|UPDATE|DELETE|WITH)\s/g;
  let m;
  while ((m = start.exec(src))) {
    const q = m[1];
    let i = m.index + 1, depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") { i++; continue; }
      if (q === "`" && c === "$" && src[i + 1] === "{") { depth++; i++; continue; }
      if (depth && c === "}") { depth--; continue; }
      if (!depth && c === q) break;
      if (q !== "`" && c === "\n") break;
    }
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ text: src.slice(m.index + 1, i), line });
    start.lastIndex = i + 1;
  }
  return out;
}

/** Tables that carry conversation_id (or another owner key), from CREATE TABLE and addColumnIfMissing. */
export function ownedTables(files) {
  const owned = new Set();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
      const cols = m[2];
      if (OWNER_KEYS.some(k => new RegExp(`(^|[\\s,(])${k}\\s+TEXT`, "m").test(cols))) owned.add(m[1]);
    }
    for (const m of src.matchAll(/addColumnIfMissing\(\s*"(\w+)"\s*,\s*"(\w+)"/g)) {
      if (OWNER_KEYS.includes(m[2])) owned.add(m[1]);
    }
  }
  return owned;
}

const VERB = /^\s*(SELECT|UPDATE|DELETE|INSERT|WITH)\b/i;

/**
 * Every SQL literal that reads/updates/deletes an owned table and names no owner key anywhere in
 * the statement. INSERTs are skipped (they write the owner column by construction).
 * Returns [{ file, line, table, verb, sql }]; `file` is repo-relative.
 */
export function scan(root) {
  const files = walk(join(root, "src"));
  const owned = ownedTables(files);
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const { text, line } of literals(src)) {
      const m = VERB.exec(text);
      if (!m) continue;
      const verb = m[1].toUpperCase();
      if (verb === "INSERT") continue;
      if (/^\s*INSERT\b/i.test(text)) continue;
      const tables = [...text.matchAll(/\b(?:FROM|UPDATE|JOIN|INTO)\s+(\w+)/gi)].map(x => x[1]).filter(t => owned.has(t));
      if (!tables.length) continue;
      if (OWNER_KEYS.some(k => new RegExp(`\\b${k}\\b`, "i").test(text))) continue;
      hits.push({ file: relative(root, f), line, table: [...new Set(tables)].join(","), verb, sql: text.replace(/\s+/g, " ").trim().slice(0, 160) });
    }
  }
  return { owned, hits };
}

/** A stable key for a hit that survives line moves: file + verb + normalised SQL. */
export function hitKey(h) { return `${h.file} | ${h.verb} ${h.sql}`; }
