#!/usr/bin/env node
// The use-case index in README.md is generated from docs/features list in docs/usecases.json, so
// the list cannot drift from the record: one line per use case, newest first, the detail folded
// under it. Run `node scripts/usecases.mjs` after editing the JSON; `--check` exits 1 instead of
// writing, which is what test/usecases.test.js does. The site at reason-site reads the same JSON.
import { readFileSync, writeFileSync } from "node:fs";

export const START = "<!-- usecases:start -->";
export const END = "<!-- usecases:end -->";
const WIDTH = 100;

// A GitHub heading anchor, so `section` can point an index line at the long section above it.
export function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

function wrap(text, first, rest) {
  const lines = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const start = lines.length === 0 ? first : rest;
    if (line === start) line += word;
    else if (line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = rest + word;
    } else line += " " + word;
  }
  lines.push(line);
  return lines;
}

// "before 2026-09-30" is an honest unknown and sorts older than 2026-09-30 itself.
export function sortKey(landed) {
  return landed.startsWith("before ") ? landed.slice(7) + "-0" : landed + "-1";
}

export function render(data) {
  const out = [];
  for (const section of data.sections) {
    out.push(`### ${section.heading}`, "");
    for (const para of section.intro) out.push(...wrap(para, "", ""), "");
    const items = data.usecases
      .filter((u) => u.status === section.status)
      .sort((a, b) => sortKey(b.landed).localeCompare(sortKey(a.landed)));
    for (const u of items) {
      const name = u.section ? `[${u.name}](#${slug(u.section)})` : u.name;
      // Deliberately not wrapped: one line per use case is what makes the source an index too.
      out.push(`- **${name}** — ${u.hook} · landed ${u.landed}`);
      out.push(`  <details><summary>${u.name}</summary>`, "");
      for (const para of u.detail.split("\n\n")) out.push(...wrap(para, "  ", "  "), "");
      out.push("  </details>", "");
    }
    for (const para of section.outro ?? []) out.push(...wrap(para, "", ""), "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export function splice(readme, body) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1) throw new Error(`README.md is missing ${START} / ${END}`);
  return readme.slice(0, a + START.length) + "\n\n" + body + "\n" + readme.slice(b);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = new URL("../docs/usecases.json", import.meta.url);
  const readmePath = new URL("../README.md", import.meta.url);
  const wanted = splice(readFileSync(readmePath, "utf8"), render(JSON.parse(readFileSync(json, "utf8"))));
  if (process.argv.includes("--check")) {
    if (wanted !== readFileSync(readmePath, "utf8")) {
      console.error("README.md has drifted from docs/usecases.json; run node scripts/usecases.mjs");
      process.exit(1);
    }
  } else writeFileSync(readmePath, wanted);
}
