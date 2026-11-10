// Reason never hands people a phrase to type (owner copy rule, 2026-10-25): no 'text "undo"', no
// 'reply YES', no 'say "my invites"'. It says what they can do in plain words and the model reads
// whatever they write back for its meaning. A real one-time code is the only thing ever quoted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url).pathname;
const scriptsDir = new URL("../scripts/", import.meta.url).pathname;
const files = (d) => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.m?js$/.test(p) ? [p] : []; });
/** say/text/reply/type followed by a quoted phrase or a capitalised keyword, outside comments. */
const COACH = /\b(say|text|reply|type|send)\s+(back\s+)?(with\s+)?(just\s+)?(["“][a-z#][^"”]{0,40}["”]|\b(YES|NO|STOP|HELP|START|UNDO)\b)/;
// Lines that are about what REASON says (never say "done") rather than what the person should send,
// and the prompt rule itself, which quotes the forbidden shape to forbid it.
// Reviewed 2026-10-26: each of these quotes words REASON says, a tool's own value, or what a person
// might ask for — none tells the person what to type.
const REVIEWED = ['reply "yes" to confirm', 'reply with just "yes" or "no"', 'say "nothing was done"', 'type "description"', 'they say "buy me X"', 'say "not quoted"'];
const ALLOWED = [...REVIEWED.map(t => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), /never (say|write)/i, /Never give them words to type/, /\bnot\s+say\b/i, /don't say/i, /do not say/i, /Never say/];

test("no user-facing string or prompt coaches an exact phrase to send", () => {
  const hits = [];
  for (const f of [...files(root), ...files(scriptsDir)]) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      if (!code.trim() || !COACH.test(code) || ALLOWED.some(r => r.test(code))) return;
      // Only lines that coach the person: "you" / "them" / "they" near the phrase.
      if (!/\b(you|your|them|they|their|him|her)\b/i.test(code)) return;
      hits.push(`${f.replace(root, "src/")}:${i + 1}: ${code.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

test("the prompt tells the model never to coach exact words", async () => {
  // Its own directory: the keystore (keys.db) sits beside the database, and a shared tmpdir keeps one
  // from an earlier run under another key.
  process.env.REASON_DB_PATH ||= join((await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "ncp-")), "reason.db");
  const { SYSTEM } = await import("../src/agent.js");
  assert.match(SYSTEM, /Never give them words to type/);
});

test("the specific lines rewritten read as plain intent", async () => {
  const undo = await import("../src/undo.js");
  assert.equal(undo.holdLine({ doing: "texting Marta", seconds: 30 }), "texting Marta in 30s — just tell me if you want to stop it");
  const src = (p) => readFileSync(join(root, p), "utf8");
  assert.ok(!/say "my invites"|say "approve/.test(src("invites.js")));
  // The call security check no longer texts anything mid-call (2026-11-06), so the one exception is gone.
  assert.doesNotMatch(src("calls/verify.js"), /reply "yes"/);
  assert.ok(!/\(yes or no;/.test(src("eventrides.js")));
  assert.ok(!/text "undo"/.test(src("activity.js")));
  assert.ok(!/"Forget #12"|"make leg day 8"|"stop texting me unless I ask"/.test(src("memory.js")));
});

test("rules the model must see: no promised page picture/title (page_create), owning a misread (prompt)", async () => {
  process.env.REASON_DB_PATH ||= join((await import("node:os")).tmpdir(), `ncp2-${process.pid}.db`);
  const { SYSTEM } = await import("../src/agent.js");
  const { toolsFor } = await import("../src/tools.js");
  const page = toolsFor(process.env.REASON_CONVERSATION || "dm:owner").find(t => t.name === "page_create");
  assert.ok(page, "page_create is shown to the model");
  assert.match(page.description, /never promise a preview card, a picture of the page or a title/);
  assert.match(SYSTEM, /Misread something\? Own it out loud/);
});
