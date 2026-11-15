// The name a person gives their Reason is Reason's, never theirs — on every path, not only the text
// turn's profile. Found 2026-11-14: a task's event turn (no profile on it, only the identity line
// "they named you …, answer to …") opened "Back on the … setup, <the assistant's name>:", addressing
// the person by it. A reminder the same evening ("<name> here, reminding you…") was right.
//
//   - the contract: every builder in src/memorynote.js PROFILE_READERS goes through the one helper
//     (src/identity.js assistantNameLine, via profileForPrompt / factForPrompt / profileNote /
//     identityNote / rulesNote); every src/ file that reads facts, the profile or the given name raw
//     is a reader or says here why it shows no model those words
//   - the identity line every event turn reads says whose name it is
//   - the recall tool, a call's recent facts: the fact says whose name it is; the stored fact is unchanged
//   - the last line out (src/outbox.js notByTheNickname): the name used to address them is dropped;
//     Reason naming itself is left alone; texts to anybody else are untouched
// Fixtures only: the nickname is "Nimbus", the person "Pat".
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-nickname-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Pat";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");
const identity = await import("../src/identity.js");
const rules = await import("../src/rules.js");
const memorynote = await import("../src/memorynote.js");
const outbox = await import("../src/outbox.js");
const carryover = await import("../src/calls/carryover.js");
const { runTool } = await import("../src/tools.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const FACT = "Wants the assistant to answer to the name Nimbus";
const ROOT = new URL("../", import.meta.url);
const src = (f) => readFileSync(new URL(f, ROOT), "utf8");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM accounts; DELETE FROM person_facts; DELETE FROM people; DELETE FROM profile_blocks;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Pat", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Sam", isOperator: false });
  config.oneIdentity = "owner";
});

/** A function's source, from its declaration to the matching closing brace (as test/rules-everywhere.test.js). */
function bodyOf(file, fn) {
  const s = src(file);
  const at = s.search(new RegExp(`(?:async\\s+)?function\\*?\\s+${fn}\\s*\\(|(?:const|let)\\s+${fn}\\s*=`));
  assert.ok(at >= 0, `${file}: no function ${fn}`);
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
function walk(d, out = []) {
  for (const n of readdirSync(new URL(d, ROOT))) {
    const p = `${d}/${n}`;
    if (statSync(new URL(p, ROOT)).isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

const HELPER = /\b(?:profileForPrompt|factForPrompt|profileNote|profileForCall|ownerProfileNote|identityNote|rulesNote|assistantNameLine)\(/;

test("contract: every builder that shows a model their profile, a saved fact or the given name goes through the one helper", () => {
  assert.ok(memorynote.PROFILE_READERS.length >= 9);
  for (const r of memorynote.PROFILE_READERS) assert.match(bodyOf(r.file, r.fn), HELPER, `${r.path} (${r.file} ${r.fn}) must show the nickname through the helper`);
  // The helpers themselves end in the one sentence.
  for (const fn of ["profileForPrompt", "factForPrompt"]) assert.match(bodyOf("src/memorynote.js", fn), /\bassistantNameLine\(/);
  assert.match(bodyOf("src/identity.js", "identityNote"), /\bassistantNameLine\(/);
  assert.match(bodyOf("src/rules.js", "rulesNote"), /\bidentityNote\(/);
  // The last line out runs on every durable send to them.
  for (const fn of ["sendDurable", "sendSequence"]) assert.match(bodyOf("src/outbox.js", fn), /\bnotByTheNickname\(/);
  assert.match(bodyOf("src/calls/voice.js", "queueMidCall"), /\bnotByTheNickname\(/);
});

// Every file in src/ that reads saved facts, the profile or the name they gave Reason raw. A new one
// fails here until it is placed: in PROFILE_READERS, or here with why no model is shown those words.
const RAW = /\bgetProfile\(|\bdb\.recall\(|\bmemoryFacts\(|\blistFacts\(|\bactiveFacts\(|\bgetFact\(|person_facts|\bgivenName\(|contact_card_name|memory\.remembered\(/;
const SHOWS_NO_MODEL = {
  "src/db.js": "the queries themselves",
  "src/identity.js": "keeps the given name; its prompt line is identityNote (a reader)",
  "src/contact.js": "the contact card's name, not a prompt",
  "src/data.js": "the data export: their own stored words, back to them",
  "src/restcrypt.js": "encryption at rest of the columns",
  "src/embedding.js": "vectors of facts; says nothing",
  "src/recallindex.js": "the search index; its rows reach a model only through memory_search (a reader)",
  "src/samefact.js": "deduplicates facts",
  "src/extract.js": "the extractor and the profile builder: they must read the stored words to rewrite them",
  "src/dream.js": "the nightly memory review: reviews the stored words as its subject",
  "src/food.js": "the allergy check reads a cart against facts; it writes no words to anyone",
  "src/shipping.js": "reads a shipping address out of facts; no model",
  "src/offers.js": "the figures check reads amounts in facts; no model",
  "src/memory.js": "the memory page's sections: the page shows them their stored words; the tool's copy is memoryPageForModel (a reader)",
  "src/pages/webmemory.js": "the Web memory page: their stored words, to them",
  "src/ios/memory.js": "the iOS memory API: their stored words, to them",
  "src/onboarding.js": "fixed welcome words and the contact card under the name; no model",
};
test("contract: every src/ file that reads facts, the profile or the given name raw is a reader or says why not", () => {
  const readers = new Set(memorynote.PROFILE_READERS.map(r => r.file));
  const missing = walk("src").filter(f => RAW.test(src(f)) && !readers.has(f) && !SHOWS_NO_MODEL[f]);
  assert.deepEqual(missing, [], "place each in src/memorynote.js PROFILE_READERS, or in SHOWS_NO_MODEL here with why");
});

test("the identity line an event turn reads (a task's update, a reminder) says the name is Reason's, not theirs", () => {
  identity.setGivenName(C, "Nimbus");
  const note = rules.rulesNote(C);
  assert.match(note, /they named you "Nimbus"/);
  assert.match(note, /They call YOU, their assistant, "Nimbus": a nickname for you, not their name\. Their own name is Pat\. Never call them Nimbus\./);
  assert.match(note, /Answer to Nimbus, and when you say who you are to them, say Nimbus/, "Reason still goes by it");
  // Their own name the same as the one they gave Reason: nothing to warn about.
  identity.setGivenName(OTHER, "Sam");
  config.oneIdentity = "on";
  assert.doesNotMatch(identity.identityNote(OTHER), /Never call them/);
});

test("the one sentence, from the profile and from a bare fact", () => {
  assert.equal(memorynote.factForPrompt(FACT, "Pat"), identity.assistantNameLine("Nimbus", "Pat"));
  assert.equal(memorynote.factForPrompt("Works the early shift at the depot", "Pat"), "Works the early shift at the depot");
  assert.equal(memorynote.profileForPrompt(`Pat:\n- ${FACT} (saved Nov 2)\n- Likes oat milk`, "Pat"),
    `Pat:\n- ${identity.assistantNameLine("Nimbus", "Pat")} (saved Nov 2)\n- Likes oat milk`);
  assert.equal(identity.assistantNameLine("Reason", "Pat"), "");
  assert.equal(identity.assistantNameLine("Pat", "Pat"), "");
});

test("the recall tool hands the model the fact with whose name it is; the stored fact is unchanged", async () => {
  db.remember(C, "Pat", FACT);
  const r = await runTool("recall", {}, { conversationId: C });
  const facts = r.people.flatMap(p => p.facts.map(f => f.fact));
  assert.ok(facts.some(f => /not their name.*Never call them Nimbus/.test(f)), JSON.stringify(r));
  assert.ok(!facts.includes(FACT));
  assert.ok(db.listFacts(C).some(f => f.fact === FACT), "stored as it was");
});

test("a call's recently saved facts say whose name it is", () => {
  db.remember(C, "Pat", FACT);
  db.remember(C, "Pat", "Has a dentist appointment on Friday");
  const was = config.callCarryover;
  try {
    config.callCarryover = "on";
    const note = carryover.recentMemoryNote({ id: 9001, conversation_id: C, is_owner: 1, created_at: clock.now() + 1000 });
    assert.match(note, /Never call them Nimbus/);
    assert.match(note, /- Has a dentist appointment on Friday/);
    assert.doesNotMatch(note, new RegExp(FACT));
  } finally { config.callCarryover = was; }
});

test("last line out: the nickname addressing them is dropped; Reason naming itself is left alone", () => {
  identity.setGivenName(C, "Nimbus");
  const out = (text, toOwner = true, c = C) => outbox.notByTheNickname(text, { conversationId: c, toOwner });
  assert.equal(out("Back on the Workspace setup, Nimbus: the domain is verified."), "Back on the Workspace setup: the domain is verified.");
  assert.equal(out("hey Nimbus, your package came"), "hey, your package came");
  assert.equal(out("Nimbus, your car is ready."), "Your car is ready.");
  assert.equal(out("Got it, Nimbus!"), "Got it!");
  // Self-reference stays.
  for (const t of ["Nimbus here, reminding you about the dentist at 3.", "it's Nimbus — quick one", "I'm your assistant, Nimbus.", "talk soon\n— Nimbus", "Nimbus will text you at 5."]) assert.equal(out(t), t);
  // Not to them: untouched. No nickname: untouched.
  assert.equal(out("Back on the setup, Nimbus:", false), "Back on the setup, Nimbus:");
  assert.equal(out("Back on the setup, Nimbus:", true, OTHER), "Back on the setup, Nimbus:");
});

test("last line out also knows a nickname that is only in their profile", () => {
  db.saveProfile(C, `Pat:\n- ${FACT}`, []);
  assert.deepEqual(identity.assistantNicknames(C), ["Nimbus"]);
  assert.equal(outbox.notByTheNickname("Thanks, Nimbus.", { conversationId: C, toOwner: true }), "Thanks.");
});
