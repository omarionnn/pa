// "How to treat me" rules reach every model that speaks for a person (owner, 2026-11-08, after call
// 80). One reader, src/rules.js `rulesNote`, read fresh at each turn and each call's start.
//   - the contract: every prompt builder in RULE_READERS calls rulesNote (or is exempt, with why), and
//     every file in src/ that can reach a model is accounted for — a new one fails here until it is
//   - nothing but rules.js reads the rules for a prompt (the memory page and the nightly review read
//     them as their subject)
//   - a rule saved after call N is in call N+1's GPT-Live instructions and Claude's call turn
//   - every path that was missing them before now has them: event turns (API and CLI), the call turn,
//     the voice, the Web daily greeting, onboarding's one-line answers
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-rules-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";

const rules = await import("../src/rules.js");
const gl = await import("../src/calls/gptlive.js");
const voice = await import("../src/calls/voice.js");
const onboarding = await import("../src/onboarding.js");
const { memoryNotes } = await import("../src/memorynote.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const ROOT = new URL("../", import.meta.url);
const src = (f) => readFileSync(new URL(f, ROOT), "utf8");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM accounts; DELETE FROM treat_rules; DELETE FROM messages;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callCacheWarm: false });
  await voice.prime();
});

/** A function's source, from its declaration to the matching closing brace. */
function bodyOf(file, fn) {
  const s = src(file);
  const at = s.search(new RegExp(`(?:async\\s+)?function\\*?\\s+${fn}\\s*\\(|(?:const|let)\\s+${fn}\\s*=`));
  assert.ok(at >= 0, `${file}: no function ${fn}`);
  // Past the parameter list (which may hold destructuring braces and default calls), to the body.
  let p = s.indexOf("(", at);
  for (let d = 0; p < s.length; p++) { if (s[p] === "(") d++; else if (s[p] === ")" && --d === 0) break; }
  const open = s.indexOf("{", p);
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(at, i + 1);
  }
  return s.slice(at);
}

test("contract: every prompt builder for a person calls rulesNote; the exempt ones say why", () => {
  assert.ok(rules.RULE_READERS.length >= 8);
  for (const r of rules.RULE_READERS) {
    if (r.exempt) { assert.ok(r.exempt.length > 20, `${r.path}: an exemption says why`); continue; }
    assert.match(bodyOf(r.file, r.fn), /\brulesNote\(/, `${r.path} (${r.file} ${r.fn}) must load the rules through rulesNote`);
  }
});

// Every file in src/ that can reach a model. A new one fails this test until it is placed: in
// RULE_READERS (it speaks for a person), or here with why it does not.
const NOT_SPEAKING = {
  "src/askedcall.js": "decides whether an errand call was plainly asked for",
  "src/backends/side.js": "the side-model plumbing itself",
  "src/backends/cli.js": "the CLI plumbing itself",
  "src/background.js": "the background queue's bookkeeping",
  "src/calls/goalmet.js": "judges whether a call met its goal",
  "src/channels/router.js": "one-thought bookkeeping (no model call of its own)",
  "src/choicecards.js": "labels and photos for options inside a turn whose model already carries the rules",
  "src/eventcover.js": "an event's cover picture",
  "src/extract.js": "reads facts out of what they said",
  "src/factgroups.js": "files facts into groups",
  "src/harm.js": "the harm screen",
  "src/itemtitle.js": "a short title for a row, from Reason's own note",
  "src/judge.js": "the confirm gate's judge",
  "src/looked.js": "checks whether something was looked up",
  "src/onethought.js": "folds texts that arrive mid-turn",
  "src/runtime.js": "routes turns to the backends listed in RULE_READERS",
  "src/said.js": "the ledger of what was said",
  "src/shoptools.js": "answers a checkout form's fields",
  "src/spend.js": "usage accounting",
  "src/subusage.js": "subscription usage accounting",
  "src/ticketcheck.js": "reads an e-ticket email",
  "src/tools.js": "tools run inside a turn whose model already carries the rules",
  "src/watch.js": "judges whether a watched page changed",
  "src/webchats.js": "titles an old Web chat",
};
const MODEL = /from "(?:\.\.\/|\.\/)+(?:backends\/side|onethought|backends\/cli|backends\/claude-cli)\.js"|@anthropic-ai\/sdk|import\("(?:\.\.\/|\.\/)+(?:backends\/side|onethought|backends\/cli)\.js"\)/;

function walk(d, out = []) {
  for (const n of readdirSync(new URL(d, ROOT))) {
    const p = `${d}/${n}`;
    if (statSync(new URL(p, ROOT)).isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

test("contract: every file in src/ that reaches a model is a rule reader or says why it is not", () => {
  const readers = new Set(rules.RULE_READERS.map(r => r.file));
  const missing = walk("src").filter(f => MODEL.test(src(f)) && !readers.has(f) && !NOT_SPEAKING[f]);
  assert.deepEqual(missing, [], "place each in src/rules.js RULE_READERS, or in NOT_SPEAKING here with why");
});

test("contract: only rules.js reads the rules for a prompt (the memory page and the nightly review read them as their subject)", () => {
  const allowed = new Set(["src/rules.js", "src/db.js", "src/dream.js", "src/memory.js", "src/pages/webmemory.js"]);
  const readers = walk("src").filter(f => /\bactiveRules\(/.test(src(f)) && !allowed.has(f));
  assert.deepEqual(readers, []);
});

test("rulesNote: fresh from the database each time, this conversation's own only, at most the cap", () => {
  assert.equal(rules.rulesNote(C), "");
  db.addRule(C, { rule: "no 'one sec' on calls" });
  db.addRule(OTHER, { rule: "call me Ama-ji" });
  assert.match(rules.rulesNote(C), /^HOW THEY WANT YOU TO TREAT THEM[^]*- no 'one sec' on calls$/);
  assert.doesNotMatch(rules.rulesNote(C), /Ama-ji/);
  for (let i = 0; i < 11; i++) db.addRule(C, { rule: `rule number ${i}` });
  assert.equal(rules.rulesFor(C).length, db.RULES_CAP);
  assert.equal(rules.rulesNote(null), "");
});

test("a rule saved after call N is in call N+1's GPT-Live instructions and Claude's call turn — and in neither of anyone else's", () => {
  const mk = (conv = C) => db.createCall(conv, { provider: "gptlive", toNumber: "+12025551234", isOwner: true, goal: "check in", facts: [], announcement: "Hey Omari, what's up?", state: "in_progress" });
  const n = mk();
  assert.doesNotMatch(gl.liveInstructions(gl.whoFor(n)), /just say the answer out loud/);
  // Call 80's own rule, saved by the remember tool after he hung up.
  db.addRule(C, { rule: "on a call, just say the answer out loud. don't offer to text it or stall with 'one sec'" });
  const next = mk();
  assert.match(gl.liveInstructions(gl.whoFor(next)), /HOW THEY WANT YOU TO TREAT THEM[^]*just say the answer out loud/);
  assert.match(voice.contextFor({ call: next, kind: "owner" }).system, /HOW THEY WANT YOU TO TREAT THEM[^]*just say the answer out loud/);
  // Mid-call too: Claude's turn reads them fresh every turn.
  db.addRule(C, { rule: "keep the weather to one line" });
  assert.match(voice.contextFor({ call: next, kind: "owner" }).system, /keep the weather to one line/);
  const hers = mk(OTHER);
  assert.doesNotMatch(gl.liveInstructions(gl.whoFor(hers)), /answer out loud|weather to one line/);
  assert.doesNotMatch(voice.contextFor({ call: hers, kind: "owner" }).system, /answer out loud|weather to one line/);
  const errand = db.createCall(C, { provider: "gptlive", toNumber: "+13105559999", isOwner: false, goal: "book a table", facts: [], announcement: "", state: "in_progress" });
  assert.doesNotMatch(voice.contextFor({ call: errand, kind: "third_party" }).system, /answer out loud/, "a business call carries nothing of his memory");
});

test("text turns: their own turns carry the rules (memoryNotes), as before", async () => {
  db.addRule(C, { rule: "lowercase only" });
  assert.match((await memoryNotes(C, "hey", { enabled: false })).join("\n"), /lowercase only/);
});

test("event turns (reminders, check-ins, the note after a call) carry them on both backends — missing before 2026-11-08", () => {
  assert.match(bodyOf("src/agent.js", "runTurnOnTheirClock"), /kind === "user" \? await memoryNotes\([^)]*\) : \[rulesNote\(conversationId\)\]/);
  assert.match(bodyOf("src/backends/claude-cli.js", "runTurnOnCli"), /kind === "event" \? \[saidLedger\.declinedNote\(conversationId\), rulesNote\(conversationId\)\]/);
});

test("onboarding's one-line answers and the Web daily greeting carry them — missing before", async () => {
  db.addRule(C, { rule: "call me O" });
  let asked = null;
  await onboarding.readText({ state: "not_started", text: "what are you?", conversationId: C, ask: async (q) => { asked = q; return { value: { kind: "question" } }; } });
  assert.match(asked.prompt, /HOW THEY WANT YOU TO TREAT THEM[^]*call me O/);
  assert.match(bodyOf("src/daily.js", "written"), /rulesNote\(conversationId\)/);
});
