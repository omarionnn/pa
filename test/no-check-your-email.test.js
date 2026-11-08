// Owner 2026-11-08: Reason's text about an Amazon order said "check your email for Amazon's
// confirmation" while his Gmail was connected. Reason reads the mail itself; it never hands that job
// to the person. This pins every source file: no code-written line and no instruction to the model
// tells them to check / look in their email or inbox. The one place that names the phrase is the rule
// against it (the system prompt, and the "never tell them to check their email" lines that quote it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(m?js)$/.test(n) ? [p] : [];
});
// Handing the job over: "check your email", "say to check their email", "it's in your email or the
// airline's app", "check your inbox".
const HANDOFF = /\bcheck (?:your|their) (?:e-?mail|inbox|mail|gmail)\b|\blook in your (?:e-?mail|inbox|mail)\b|\b(?:is|are|will be) in (?:your|their) (?:e-?mail|inbox)\b/i;
// A line that forbids the handoff, quoting it, is the rule itself.
const RULE = /\bnever (?:tell|ask|say)[^.]{0,40}(?:check|look)|never your reply|is never|never "go check"/i;

test("no source line tells the person to check their own email", () => {
  const hits = [];
  for (const f of files(SRC)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (HANDOFF.test(line) && !RULE.test(line) && !/^\s*(?:\/\/|\*)/.test(line)) hits.push(`${f.slice(SRC.length)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, [], `lines that hand the person their own email to check:\n${hits.join("\n")}`);
});

test("the system prompt carries the standing rule: never tell them to check something Reason has a tool for", async () => {
  const { systemFor } = await import("../src/agent.js");
  const s = systemFor();
  assert.match(s, /Never tell them to check something you have a tool for\./);
  assert.match(s, /Never "check your email" with Google connected: search it \(gmail_search, gmail_read\), say what you found\./);
  assert.match(s, /Not connected: say so, offer google_connect\./);
});
