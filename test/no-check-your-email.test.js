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
// A match is exempt only when the rule forbidding it sits right in front of it in the same sentence
// ("never tell them to check their email", 'Never "check your email"'): the line around it still counts.
const forbids = (line, at) => /\bnever\b(?!\s+mind)(?:(?![.!?:;,](?:\s|$)).){0,30}$/i.test(line.slice(Math.max(0, at - 40), at));
const handoffs = (line) => [...line.matchAll(new RegExp(HANDOFF.source, "gi"))].filter((m) => !forbids(line, m.index));

test("the guard itself: a rule quoting the phrase passes, a handoff on the same line as a 'never' does not", () => {
  assert.equal(handoffs('Never tell them to check their email: you just did.').length, 0);
  assert.equal(handoffs('- Never "check your email" with Google connected.').length, 0);
  assert.equal(handoffs('Payment went through. Check your email for the receipt; I never saw it.').length, 1);
  assert.equal(handoffs('It is never late: the pass is in your email.').length, 1);
  assert.equal(handoffs('Never mind. Check your inbox.').length, 1);
  assert.equal(handoffs('Never mind, check your inbox.').length, 1);
  assert.equal(handoffs('If you never got it, check your email.').length, 1);
});

test("no source line tells the person to check their own email", () => {
  const hits = [];
  for (const f of files(SRC)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (handoffs(line).length && !/^\s*(?:\/\/|\*)/.test(line)) hits.push(`${f.slice(SRC.length)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, [], `lines that hand the person their own email to check:\n${hits.join("\n")}`);
});

test("the system prompt carries the standing rule: never tell them to check something Reason has a tool for", async () => {
  const { systemFor } = await import("../src/agent.js");
  const s = systemFor();
  assert.match(s, /Never tell them to check something you have a tool for\./);
  assert.match(s, /Their email: search it \(gmail_search, gmail_read\), say what you found; not connected, say so and offer google_connect\./);
  assert.match(s, /Email attachment: gmail_attachment, never drive_read\./);
});
