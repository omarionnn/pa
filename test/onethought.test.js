// One thought, one answer — pinned offline, one test per case in the build spec, on the fake channel.
//
// The incident (2026-10-24, dm:owner): "No I want to watch when I leave work so somewhere around
// work" at 19:05:57 and "And I'd watch it on Tuesday" at 19:06:09. The second landed while the
// first was being answered, waited for that turn to end, and got a whole turn of its own: two
// answers, 11:15am "a maybe" + "want me to open the site?" and then 11:00am from the site, with a
// different closest theater in each. See src/onethought.js and src/said.js.
//
// The model is scripted: each test's turn function says what the model does with what it is handed,
// and the REAL router, runtime, tool wrapper, tables and send path do the rest. What the mid-turn
// reader and the ledger's reader decide is stubbed — what is proved here is what code does with it.
// The real-model lane is test/flow-onethought.test.js.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-onethought-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const { systemFor } = await import("../src/agent.js");
const db = await import("../src/db.js");
const onethought = await import("../src/onethought.js");
const said = await import("../src/said.js");
const { config } = await import("../src/config.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec(`DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM outbox; DELETE FROM requests; DELETE FROM request_messages;
    DELETE FROM open_questions; DELETE FROM sent_claims;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = 20;
  config.burstMaxMs = 200;
  config.saidLedger = true;
  onethought.setMidTurnReader(null);
  said.setRecorder(null);
  said.setChecker(null);
});

const tick = () => new Promise(r => setTimeout(r, 5));
async function until(pred, what, ms = 3_000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}
/** A gate a scripted turn waits on, so a text can land while it is "working". */
function gate() { let open; const p = new Promise(r => { open = r; }); return { wait: () => p, open: () => open() }; }

const burstFree = (t) => String(t).replace(/^\[they sent the following as \d+ separate texts[^\n]*\]\n/, "");

/**
 * The real router and runtime on a fake iMessage thread. `script(args, n)` is the model: it is
 * handed what the turn is handed (text, foldToken…) and returns the reply. Like both backends, the
 * turn's line and its reply are saved to the thread.
 */
function harness(script) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (args) => {
      turns.push(args);
      const reply = await script(args, turns.length);
      db.saveConversation(args.conversationId, [
        ...db.loadConversation(args.conversationId),
        { role: "user", content: `[now] Omari: ${args.keep ?? args.text}` },
        { role: "assistant", content: reply ?? "NO_REPLY" },
      ]);
      return reply;
    },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  return { runtime, router, fake, turns, logs };
}

let n = 0;
const text = (t, over = {}) => ({ channel: "fake", externalId: `H-${++n}`, from: OWNER, text: t, chatId: null, service: "iMessage", ...over });

/** One tool call the scripted model makes mid-turn — the shape a real turn takes while it researches. */
const lookUp = (args) => runTool("request_done", { id: -1 }, { conversationId: args.conversationId, foldToken: args.foldToken });

const WORK = "No I want to watch when I leave work so somewhere around work";
const TUESDAY = "And I'd watch it on Tuesday";

// ---------- 1. two bubbles, one thought ----------

test("two bubbles a couple of seconds apart are ONE turn and ONE reply that uses both", async () => {
  config.burstQuietMs = 60;
  const h = harness(async (args) => `showtimes for: ${burstFree(args.text).replace(/\n/g, " + ")}`);
  const first = h.router.deliver(text(WORK));
  await tick();
  await h.router.deliver(text(TUESDAY));
  await first;
  assert.equal(h.turns.length, 1, "one turn");
  assert.equal(h.fake.sent.length, 1, "one reply");
  assert.match(h.fake.sent[0].text, /around work \+ And I'd watch it on Tuesday/);
});

test("the incident: 'on Tuesday' 12s later, mid-research, is folded into the running turn — one reply, no second turn", async () => {
  onethought.setMidTurnReader(({ text: t }) => (t === TUESDAY ? "continuation" : "new"));
  const g = gate();
  const h = harness(async (args) => {
    await g.wait();
    // Still researching: the next tool result carries what they just added.
    const r = await lookUp(args);
    const day = r.NEW_FROM_THEM?.includes("Tuesday") ? "Tuesday" : "Monday";
    return `Alamo Lower Manhattan, closest to work: earliest ${day} showing 11:00am`;
  });
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "the first turn to start");
  const second = await h.router.deliver(text(TUESDAY));
  assert.equal(second.joined, true);
  await until(() => h.logs.some(l => l.folded), "the second text to be folded in");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C), "the request to finish");

  assert.equal(h.turns.length, 1, "no second turn for the second bubble");
  assert.equal(h.fake.sent.length, 1, "exactly one reply");
  assert.match(h.fake.sent[0].text, /Tuesday/, "and it uses the second bubble");
  assert.equal(db.countPendingInbound(C), 0, "nothing left to drain");
  const req = db.openRequests(C).concat(db.db.prepare("SELECT * FROM requests WHERE conversation_id = ?").all(C))[0];
  const links = db.requestMessages(C, req.id);
  assert.deepEqual(links.map(l => l.role), ["opened", "continuation"], "both bubbles belong to one request");
  assert.ok(db.loadConversation(C).some(m => m.role === "user" && String(m.content).endsWith(TUESDAY)), "their line is in the thread");
  assert.ok(h.logs.some(l => l.midturn === "continuation"));
});

test("a bubble that lands after the last tool call: the stale draft is discarded, never sent, and the turn recomposes once", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args, n) => {
    if (n === 1) { await g.wait(); return "Earliest Monday showing is 11:15am — want me to open the site and get exact times?"; }
    assert.match(args.text, /^And I'd watch it on Tuesday\n\[Before your reply went out/, "the recompose is handed their words and the unsent draft");
    assert.match(args.text, /11:15am/);
    assert.equal(args.keep, TUESDAY, "the thread keeps their words only");
    return "Tuesday at Alamo Lower Manhattan (closest to work): 11:00am, 11:30, 12:00 — straight from their site.";
  });
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "the first turn to start");
  await h.router.deliver(text(TUESDAY));
  await until(() => h.logs.some(l => l.folded), "the fold");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C), "the request to finish");

  assert.equal(h.fake.sent.length, 1, "one reply, not two");
  assert.match(h.fake.sent[0].text, /^Tuesday/);
  assert.ok(!h.fake.sent.some(m => /11:15/.test(m.text)), "the stale draft never went out");
  assert.ok(!db.loadConversation(C).some(m => m.role === "assistant" && /11:15/.test(String(m.content))), "and is not in the thread as said");
  assert.ok(h.logs.some(l => l.draft_superseded === C && l.had_draft));
});

test("a bubble that lands while the first text is still being screened — before the model has started — is folded in too", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args) => { const r = await lookUp(args); return r.NEW_FROM_THEM?.includes("Tuesday") ? "Tuesday: 11:00am" : "Monday: 11:15am"; });
  let screens = 0;
  h.runtime.screen = async () => { if (++screens === 1) await g.wait(); return { verdict: "clear" }; };
  const first = h.router.deliver(text(WORK));
  await until(() => screens === 1, "the first screen to start");
  assert.equal(h.turns.length, 0, "the model has not started");
  await h.router.deliver(text(TUESDAY));
  await until(() => h.logs.some(l => l.folded), "the fold");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C), "done");
  assert.equal(h.turns.length, 1);
  assert.deepEqual(h.fake.sent.map(m => m.text), ["Tuesday: 11:00am"]);
});

test("a text folded into a turn that never ran (refused by the screen) goes back for a turn of its own", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args) => `answered: ${burstFree(args.text)}`);
  let screens = 0;
  h.runtime.screen = async () => { if (++screens === 1) { await g.wait(); return { verdict: "harm", category: "other" }; } return { verdict: "clear" }; };
  const first = h.router.deliver(text("something refused"));
  await until(() => screens === 1, "the first screen");
  await h.router.deliver(text("and another thing"));
  await until(() => h.logs.some(l => l.folded), "the fold");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C) && h.turns.length === 1, "its own turn");
  assert.equal(burstFree(h.turns[0].text), "and another thing", "the folded text was answered on its own, not lost");
});

// ---------- 2. a correction mid-research ----------

test("a correction mid-research changes the single outgoing answer", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args) => {
    await g.wait();
    const r = await lookUp(args);
    const people = /3 people/.test(r.NEW_FROM_THEM ?? "") ? 3 : 2;
    return `table for ${people} at Carbone, friday 8pm`;
  });
  const first = h.router.deliver(text("book carbone friday 8pm for me and kofi"));
  await until(() => h.turns.length === 1, "the turn");
  await h.router.deliver(text("make it 3 people"));
  await until(() => h.logs.some(l => l.folded), "the fold");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C), "done");
  assert.deepEqual(h.fake.sent.map(m => m.text), ["table for 3 at Carbone, friday 8pm"]);
});

test("a message about to go out mid-turn is held while a folded text is waiting, and the turn is handed the text instead", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  let held = null;
  const h = harness(async (args) => {
    await g.wait();
    held = await runTool("message_send", { to: OWNER, text: "on it, checking monday" }, { conversationId: args.conversationId, foldToken: args.foldToken });
    return "tuesday it is: 11:00am";
  });
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "the turn");
  await h.router.deliver(text(TUESDAY));
  await until(() => h.logs.some(l => l.folded), "the fold");
  g.open();
  await first;
  assert.equal(held.not_sent, true);
  assert.match(held.NEW_FROM_THEM, /Tuesday/);
  assert.deepEqual(h.fake.sent.map(m => m.text), ["tuesday it is: 11:00am"]);
});

// ---------- 3. an unrelated new request mid-reply ----------

test("an unrelated new request mid-reply gets its own turn and threaded reply; the active request is unaffected", async () => {
  onethought.setMidTurnReader(({ text: t }) => (/weather/.test(t) ? "new" : "continuation"));
  const g = gate();
  const seen = [];
  const h = harness(async (args, n) => {
    if (n === 1) {
      await g.wait();
      const r = await lookUp(args);
      seen.push(r.NEW_FROM_THEM ?? null);
      return "Tuesday at Alamo: 11:00am";
    }
    return `sunday: sunny, 64°F (${burstFree(args.text)})`;
  });
  const first = h.router.deliver(text(WORK));
  const firstHandle = `H-${n}`;
  await until(() => h.turns.length === 1, "the turn");
  await h.router.deliver(text("also what's the weather sunday"));
  await until(() => h.logs.some(l => l.midturn === "new"), "the read");
  g.open();
  await first;
  await until(() => !h.router.waiting.has(C) && h.fake.sent.length === 2, "both answers");

  assert.deepEqual(seen, [null], "the running turn was never handed the new request");
  assert.equal(h.turns.length, 2, "the new request had a turn of its own");
  assert.equal(burstFree(h.turns[1].text), "also what's the weather sunday");
  assert.equal(h.fake.sent[0].text, "Tuesday at Alamo: 11:00am", "the first answer is exactly what it was");
  assert.equal(h.fake.sent[0].reply_to, firstHandle, "and is threaded under its own text, since the thread moved on");
  assert.match(h.fake.sent[1].text, /^sunday/);
});

test("chat mid-turn is left for a light turn of its own and never folded into the task", async () => {
  onethought.setMidTurnReader(() => "chat");
  const g = gate();
  const h = harness(async (args, n) => { if (n === 1) { await g.wait(); await lookUp(args); return "found 3 flats"; } return "😊"; });
  const first = h.router.deliver(text("find me flats near the L under 2k"));
  await until(() => h.turns.length === 1, "turn");
  await h.router.deliver(text("thanks!!"));
  await until(() => h.logs.some(l => l.midturn === "chat"), "read");
  g.open();
  await first;
  await until(() => h.fake.sent.length === 2, "both");
  assert.ok(!h.logs.some(l => l.folded));
  assert.equal(burstFree(h.turns[1].text), "thanks!!");
});

test("a reader that cannot answer folds the text in — the default is never a parallel second reply", async () => {
  onethought.setMidTurnReader(() => { throw new Error("no key"); });
  const g = gate();
  const h = harness(async (args) => { await g.wait(); const r = await lookUp(args); return r.NEW_FROM_THEM ? "one answer, both bubbles" : "first only"; });
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "turn");
  await h.router.deliver(text(TUESDAY));
  await until(() => h.logs.some(l => l.folded), "fold");
  g.open();
  await first;
  assert.deepEqual(h.fake.sent.map(m => m.text), ["one answer, both bubbles"]);
  assert.ok(h.logs.some(l => l.midturn === "continuation" && l.via === "fallback"));
});

test("a mid-turn text the harm screen does not pass as clear is never folded in: its own turn screens it", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args, n) => { if (n === 1) { await g.wait(); await lookUp(args); } return `turn ${n}`; });
  h.runtime.screen = async ({ text: t }) => (/sketchy/.test(t) ? { verdict: "borderline" } : { verdict: "clear" });
  const first = h.router.deliver(text("find a movie"));
  await until(() => h.turns.length === 1, "turn");
  await h.router.deliver(text("sketchy addition"));
  await until(() => h.logs.some(l => l.midturn), "read");
  g.open();
  await first;
  await until(() => h.turns.length === 2, "its own turn");
  assert.ok(!h.logs.some(l => l.folded));
});

test("an interrupted turn hands back the text it folded in, with its own, so the next run answers both together", async () => {
  onethought.setMidTurnReader(() => "continuation");
  const g = gate();
  const h = harness(async (args, n) => {
    if (n === 1) {
      await g.wait();
      await lookUp(args);
      const e = new Error("stopping"); e.interrupted = true; throw e;
    }
    return `answered: ${burstFree(args.text).replace(/\n/g, " + ")}`;
  });
  const first = h.router.deliver(text(WORK));
  await until(() => h.turns.length === 1, "turn");
  await h.router.deliver(text(TUESDAY));
  await until(() => h.logs.some(l => l.folded), "fold");
  g.open();
  await first;
  await until(() => h.fake.sent.length === 1, "the re-run");
  assert.ok(h.logs.some(l => l.drain_interrupted === C), "the turn was interrupted");
  assert.equal(burstFree(h.turns[1].text), `${WORK}\n${TUESDAY}`, "and the next run had both, in order");
  assert.deepEqual(h.fake.sent.map(m => m.text), [`answered: ${WORK} + ${TUESDAY}`]);
});

// ---------- 4. an uncertain answer, then finished research ----------

/** A ledger reader that reads the scripted replies the way the small model would. */
function scriptedRecorder({ reply, claims, open }) {
  const out = { claims: [], supersedes: [], questions: [], closes: [] };
  // The value the reply lands on: the last time in it ("earlier I said 11:15am … it's 11:00am").
  const time = [...reply.matchAll(/(\d{1,2}:\d{2}(?:am|pm)?)/gi)].at(-1)?.[1];
  if (time) out.claims.push({ subject: "earliest Tuesday showing at Alamo Lower Manhattan", value: time, certain: !/maybe/i.test(reply) });
  for (const c of claims) if (time && c.value !== time) out.supersedes.push({ id: c.id, flagged: /earlier i said/i.test(reply) });
  if (/want me to open/i.test(reply)) out.questions.push("Want me to open Alamo's site and get exact times?");
  for (const q of open) if (/straight from (their|alamo's) site/i.test(reply)) out.closes.push({ id: q.id, why: "answered_by_reason" });
  return out;
}

const settle = async (h, k) => until(() => h.logs.filter(l => l.said_recorded || l.said_record_failed).length >= k, `ledger write ${k}`);

test("an uncertain answer then finished research: ONE update that withdraws the stale value — nothing conflicting left standing", async () => {
  said.setRecorder(scriptedRecorder);
  // The send-time check, as the small model would read the draft against what stands.
  said.setChecker(({ draft, claims }) => ({
    changed_silently: claims.filter(c => !draft.includes(c.value) && !/earlier i said/i.test(draft) && /\d:\d\d/.test(draft)).map(c => c.id),
    asks_closed: [],
  }));
  const h = harness(async (args, n) => {
    if (n === 1) return "Alamo Lower Manhattan, closest to work: earliest Tuesday 11:15am — a maybe, not confirmed.";
    if (n === 2) return "Alamo has Tuesday up: earliest 11:00am, straight from their site.";
    // The rewrite: handed the note that it changed 11:15am without saying so.
    assert.match(args.text, /Your draft reply was NOT sent\. It changes what you told them earlier .* was 11:15am/);
    return "Earlier I said 11:15am — that was before I checked the site; it's 11:00am, straight from their site.";
  });
  await h.router.deliver(text(`${WORK} on tuesday`));
  await settle(h, 1);
  await h.router.deliver(text("did you check the site?"));
  await settle(h, 2);

  assert.equal(h.fake.sent.length, 2, "one answer, then one update — the unflagged draft never went");
  assert.match(h.fake.sent[1].text, /^Earlier I said 11:15am .* it's 11:00am/);
  const standing = db.standingClaims(C);
  assert.deepEqual(standing.map(c => c.value), ["11:00am"], "only the confirmed value stands");
  const old = db.db.prepare("SELECT * FROM sent_claims WHERE conversation_id = ? AND value = '11:15am'").get(C);
  assert.equal(old.status, "superseded");
  assert.equal(old.flagged, 1, "and the update said so out loud");
  assert.ok(!db.loadConversation(C).some(m => m.role === "user" && String(m.content).includes(onethought.CODE_LINE)), "code's re-ask is not left in the thread");
  assert.match(said.standingNote(C), /11:00am/);
  assert.doesNotMatch(said.standingNote(C), /11:15am/);
});

// ---------- 5. questions close ----------

test("a question Reason asked closes when its own research answers it, and a later 'yes' does not redo the work", async () => {
  said.setRecorder(scriptedRecorder);
  // A draft that asks a settled question again is caught at send time.
  said.setChecker(({ draft, closed }) => ({ changed_silently: [], asks_closed: /want me to open/i.test(draft) ? closed.map(q => q.id) : [] }));
  let lookups = 0;
  const h = harness(async (args, n) => {
    if (n === 1) return "Alamo might have an 11:00am Tuesday — want me to open Alamo's site and get exact times?";
    if (n === 2) { lookups++; return "Checked: 11:00am, 11:30, 12:00 on Tuesday, straight from their site."; }
    // The late "yes". The block it is shown says the question is settled.
    const note = said.standingNote(args.conversationId);
    if (/CLOSED/.test(note) && /Want me to open Alamo's site/.test(note)) return "Already done — Tuesday is 11:00am, 11:30 or 12:00. Want me to hold a seat?";
    lookups++;
    return "Want me to open Alamo's site and get exact times?";
  });
  await h.router.deliver(text("movie tuesday near work?"));
  await settle(h, 1);
  assert.equal(db.openQuestions(C).length, 1, "the question is open");
  await h.router.deliver(text("what about 11:30, is that real?"));
  await settle(h, 2);
  assert.equal(db.openQuestions(C).length, 0, "closed by its own research");
  assert.equal(db.closedQuestions(C)[0].closed_reason, "answered_by_reason");

  await h.router.deliver(text("yes"));
  await settle(h, 3);
  assert.equal(lookups, 1, "the 'yes' did not restart the lookup");
  assert.match(h.fake.sent.at(-1).text, /^Already done/);
});

test("a draft that re-asks a settled question is rewritten before it goes", async () => {
  said.setChecker(({ draft, closed }) => ({ changed_silently: [], asks_closed: /want me to open/i.test(draft) ? closed.map(q => q.id) : [] }));
  const q = db.addOpenQuestion(C, { question: "Want me to open Alamo's site and get exact times?" });
  db.closeOpenQuestion(C, q, "answered_by_reason");
  const h = harness(async (args, n) => (n === 1 ? "Want me to open Alamo's site and get exact times?" : "Tuesday is 11:00am, 11:30 or 12:00."));
  await h.router.deliver(text("yes"));
  assert.deepEqual(h.fake.sent.map(m => m.text), ["Tuesday is 11:00am, 11:30 or 12:00."]);
});

// ---------- 6. closest names its anchor ----------

test("the rules every turn is given: closest names its anchor and announces a switch; no permission to finish a lookup; grounded claims", () => {
  const sys = systemFor({ name: "Omari", known: true, isOperator: true });
  assert.match(sys, /"Closest", "nearest", "nearby" always say closest to WHAT/);
  assert.match(sys, /you said around work, so I switched from home/);
  assert.match(sys, /Never ask permission to finish what they asked for/);
  assert.match(sys, /Claims about their life .* come only from what they actually told you/);
  assert.match(sys, /Updates replace, out loud/);
  assert.match(sys, /NEW_FROM_THEM/);
  assert.doesNotMatch(sys, /Every message they send is its own request/, "the rule that split one thought in two is gone");
});

test("the ledger only ever touches its own conversation's rows", () => {
  const mine = db.addClaim(C, { subject: "s", value: "1" });
  const theirs = db.addClaim("dm:other", { subject: "s", value: "2" });
  const out = said.applyRecord(C, { value: { claims: [], supersedes: [{ id: theirs, flagged: false }, { id: mine, flagged: true }], questions: [], closes: [] }, claims: db.standingClaims(C), open: [] });
  assert.equal(out.counts.superseded, 1);
  assert.equal(db.getClaim("dm:other", theirs).status, "standing", "another person's claim is untouched");
});
