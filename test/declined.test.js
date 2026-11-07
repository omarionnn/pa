// "They declined X" — pinned offline. Reason raises something they did not ask about, they answer
// "leave it, I have reasons", and it is never raised again: not tomorrow, not reworded, not by a
// sweep. The prompt says so (the proactiveness rules in src/agent.js); this proves the memory under
// it. The decline is written to the said ledger (src/said.js) as an open_questions row closed
// 'declined', kept for months rather than the day the rest of the ledger is shown for, and put in
// front of every later turn — theirs and the ones nobody started.
//
// What the ledger's reader decides is stubbed; what is proved here is what code does with it. The
// real-model lane is test/flow-proactive-rules.test.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-declined-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { systemFor } = await import("../src/agent.js");
const db = await import("../src/db.js");
const said = await import("../src/said.js");
const { config, clock } = await import("../src/config.js");

const OWNER = "+12025551234";
const C = "dm:owner";
const OTHER = "dm:sendblue:+15550000001";
const DAY = 24 * 3_600_000;
const CATCH = "the card ending 4242 keeps failing on that bill — want me to send the link to switch it?";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM outbox; DELETE FROM requests; DELETE FROM request_messages;
    DELETE FROM open_questions; DELETE FROM sent_claims;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.saidLedger = true;
  config.burstQuietMs = 20;
  config.burstMaxMs = 200;
  said.setRecorder(null);
  said.setChecker(null);
});

/** Reason asked; they said no. */
function declineOne(conversationId = C) {
  const q = db.addOpenQuestion(conversationId, { question: CATCH });
  said.applyRecord(conversationId, { value: { claims: [], supersedes: [], questions: [], closes: [{ id: q, why: "declined" }], declined: [] }, claims: [], open: db.openQuestions(conversationId) });
  return q;
}

test("a no to a catch Reason raised is written down as declined, and kept off the short closed list", () => {
  const q = declineOne();
  assert.deepEqual(db.declinedQuestions(C).map(r => r.id), [q]);
  assert.equal(db.closedQuestions(C).length, 0, "a decline is not one of the hours-long 'closed' questions");
  assert.equal(db.openQuestions(C).length, 0);
});

test("a decline with no question behind it is written closed, with their words", () => {
  const out = said.applyRecord(C, { value: { claims: [], supersedes: [], questions: [], closes: [], declined: [{ topic: "moving the dentist to the morning", words: "leave it, i have reasons" }] }, claims: [], open: [] });
  assert.equal(out.counts.declined, 1);
  const [row] = db.declinedQuestions(C);
  assert.equal(row.status, "closed");
  assert.equal(row.closed_reason, "declined");
  assert.match(row.question, /moving the dentist to the morning — they said "leave it, i have reasons"/);
});

test("it is in front of their turns days later — the rest of the ledger is long gone by then", () => {
  declineOne();
  db.addClaim(C, { subject: "earliest showing", value: "11:00am" });
  const later = clock.now() + 5 * DAY;
  const note = said.standingNote(C, { now: later });
  assert.match(note, /TURNED DOWN/);
  assert.match(note, /keeps failing on that bill/);
  assert.match(note, /never raise these again, reworded or not/);
  assert.doesNotMatch(note, /11:00am/, "a five-day-old claim is not standing any more");
});

test("and it ages out after six months", () => {
  declineOne();
  assert.equal(said.standingNote(C, { now: clock.now() + 181 * DAY }), "");
});

test("a turn nobody started — a sweep, a timer — is shown what they turned down, and nothing else from the ledger", () => {
  declineOne();
  db.addClaim(C, { subject: "earliest showing", value: "11:00am" });
  const note = said.declinedNote(C);
  assert.match(note, /keeps failing on that bill/);
  assert.doesNotMatch(note, /11:00am/);
  assert.equal(said.declinedNote(OTHER), "", "nothing declined there");
});

test("one conversation's decline never reaches another's turn", () => {
  declineOne(OTHER);
  assert.equal(said.standingNote(C), "");
  assert.equal(said.declinedNote(C), "");
  assert.match(said.declinedNote(OTHER), /keeps failing/);
});

test("'leave it' answered with a tapback or nothing still closes the question — and only reads when one is open", async () => {
  let reads = 0;
  said.setRecorder(({ open }) => { reads++; return { claims: [], supersedes: [], questions: [], closes: open.map(q => ({ id: q.id, why: "declined" })), declined: [] }; });
  assert.equal(await said.record({ conversationId: C, userText: "thanks", reply: "NO_REPLY" }), null);
  assert.equal(reads, 0, "nothing open, nothing to read");
  db.addOpenQuestion(C, { question: CATCH });
  const out = await said.record({ conversationId: C, userText: "leave it, i have reasons", reply: "" });
  assert.equal(reads, 1);
  assert.equal(out.counts.closed, 1);
  assert.equal(db.declinedQuestions(C).length, 1);
});

test("the ledger's reader is told nothing went out, rather than handed an empty message", () => {
  assert.match(said.recordPrompt({ userText: "leave it", reply: "", claims: [], open: [] }), /no text: it said nothing, or only reacted/);
});

test("the send-time check, when it runs anyway, also catches a draft that raises a declined thing again", async () => {
  const q = declineOne();
  db.addClaim(C, { subject: "reminder", value: "10pm" });
  let seen = null;
  said.setChecker(({ closed }) => { seen = closed.map(r => r.id); return { changed_silently: [], asks_closed: [q] }; });
  const out = await said.checkDraft({ conversationId: C, draft: "set for 10pm. also that 4242 card keeps failing, want the link?" });
  assert.ok(seen.includes(q), "the declined row was in front of the checker");
  assert.equal(out.ok, false);
  assert.match(out.note, /already turned down\. Leave it out entirely/);
});

test("a declined thing never starts a send-time check on its own — the check stays as rare as before", async () => {
  declineOne();
  let asked = 0;
  said.setChecker(() => { asked++; return { changed_silently: [], asks_closed: [] }; });
  assert.deepEqual(await said.checkDraft({ conversationId: C, draft: "set for 10pm" }), { ok: true });
  assert.equal(asked, 0);
});

// ---------- the real runtime: a decline answered with silence is still written ----------

function harness(reply) {
  const runtime = new Runtime({
    log: () => {},
    runTurn: async (args) => {
      db.saveConversation(args.conversationId, [...db.loadConversation(args.conversationId), { role: "user", content: `[now] Omari: ${args.text}` }, { role: "assistant", content: reply }]);
      return reply;
    },
  });
  const router = new Router({ runtime, log: () => {} });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  return { router, fake };
}

test("they say 'leave it' and Reason answers with nothing: the catch is still marked declined", async () => {
  db.addOpenQuestion(C, { question: CATCH });
  said.setRecorder(({ userText, reply, open }) => ({
    claims: [], supersedes: [], questions: [], declined: [],
    closes: /leave it/.test(userText) && ["", "NO_REPLY"].includes(reply) ? open.map(q => ({ id: q.id, why: "declined" })) : [],
  }));
  const h = harness("NO_REPLY");
  await h.router.deliver({ channel: "fake", externalId: "H-1", from: OWNER, text: "leave it, i have reasons", chatId: null, service: "iMessage" });
  const t0 = Date.now();
  while (!db.declinedQuestions(C).length && Date.now() - t0 < 3_000) await new Promise(r => setTimeout(r, 5));
  // (The fake channel sits below the layer that drops NO_REPLY, so it shows the marker; no words went.)
  assert.ok(h.fake.sent.every(m => m.text.trim() === "NO_REPLY"), "no words went out");
  assert.equal(db.declinedQuestions(C).length, 1, "and the no was written down anyway");
});

// ---------- the prompt carries the rules ----------

test("the prompt carries the proactiveness rules, merged into the one 'next thing' rule, under budget", () => {
  const p = systemFor({ name: "Omari", isOperator: true, known: true });
  assert.match(p, /contradicts, or makes pointless, something they said or decided/);
  assert.match(p, /Look one step past the answer/);
  assert.match(p, /What the ask implies that is not there/);
  assert.match(p, /Join their services up: mail, calendar, purchases and memory/);
  assert.match(p, /Point it out, never act on it/);
  assert.match(p, /ONE catch at most, and only if it changes a decision of theirs/);
  assert.match(p, /it is settled for good/);
  // Pushing back on a money, risk or trading warning settles it too: no second case.
  assert.match(p, /a warning, money, risk and trading ones too/);
  assert.match(p, /Disagreeing is not new information: you made your case once, and they heard it\./);
  assert.match(p, /offer it in one line with how you will check it worked/);
  // A brief still gets its work and no question about the brief: the catch is extra, never instead.
  assert.match(p, /a brief still gets its work and no question about the brief itself/);
  assert.equal(p.split("Your job is not to wait for instructions").length - 1, 1, "one rule, not two");
  assert.ok(p.length < 72_500, `the system prompt is ${p.length} chars`);
});

test("the moment-aware rules ride inside the same rule, and the prompt stays under budget for everyone", () => {
  const p = systemFor({ name: "Omari", isOperator: true, known: true });
  const rule = p.slice(p.indexOf("Your job is not to wait for instructions"), p.indexOf("- When what they asked will take more than a few seconds"));
  // Inside the one proactiveness rule (#110/#112), not a second copy somewhere else.
  for (const re of [/Picture the moment they act on it/, /About to head out: the short version first/,
    /goes out when they need to leave, unless they named the time/, /At 2am or just before a flight: short, and hold what can wait/,
    /Answer the next question when you know enough/, /never a homepage/, /numbers they can tap, nothing to copy between apps/,
    /A line added for the moment must change what they do next: never a time-zone aside or a guess at what might go wrong/]) {
    assert.match(rule, re);
    assert.equal(p.split(re).length - 1, 1, `${re} appears once`);
  }
  // Reuse what they told you, said in passing so they can correct it — and only what they really said (#105).
  assert.match(p, /without asking again, and name it in passing so they can correct you/);
  assert.match(p, /Only what they actually told you, never a guess about them/);
  for (const me of [{ name: "Omari", isOperator: true, known: true }, { name: "Kwesi", isOperator: false, known: true }, { name: "Kwesi", isOperator: false }]) {
    const s = systemFor(me).length;
    assert.ok(s < 72_500, `the system prompt is ${s} chars for ${me.name}`);
  }
});
