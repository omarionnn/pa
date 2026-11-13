// REASON_KEEP_SESSION: a reply continues the CLI session the last reply of the thread ran in, so what
// Reason has already read is not sent again (owner, 2026-11-12: "if Reason has already read
// something, it should not be reading it again").
//
// What is pinned here, with the CLI played by a function: what the continued session is handed
// (only what is new: the message, lines added from elsewhere, notes that changed, notes that are
// gone), and every case where it must NOT be continued and the turn runs fresh, exactly as before.
// What the real model does with it is measured on the real lane (PR body).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-keep-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const cli = await import("../src/backends/claude-cli.js");
const { runTurnViaCli, chainFor, chainOf, resetChains, resetAnchors, notesForChain, forgetCliThreads, CHAIN_IDLE_MS, CHAIN_MAX_GROWN } = cli;
const onethought = await import("../src/onethought.js");
const { keepSessionOn, keepSessionMode } = await import("../src/fastreply.js");
const { deleteData } = await import("../src/data.js");

const C = "dm:owner";
const noMcp = async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} });
const none = async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] });
const SEED = [{ role: "user", content: "[10:00] Omari: when's dinner" }, { role: "assistant", content: "7pm at peaches" }];
const PROFILE = "WHAT YOU KNOW ABOUT THEM (from past conversations):\n- lives in Bed-Stuy";

after(() => { delete process.env.REASON_KEEP_SESSION; delete process.env.REASON_FAST_REPLY; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  process.env.REASON_KEEP_SESSION = "on";
  delete process.env.REASON_FAST_REPLY;
  resetChains(); resetAnchors();
  rmSync(join(dir, "cli-sessions.json"), { force: true });
  db.saveConversation(C, SEED);
});

/** The CLI, played: `answer(args, n)` is the nth run. Every run gets an envelope with a session id, as the real one has. */
function backend(answer = (args, n) => `reply ${n}`, { notes = () => [PROFILE] } = {}) {
  const calls = [], logs = [];
  const run = async (args) => {
    calls.push(args);
    // A run started before its message is ready (REASON_FAST_REPLY §3) is asked on stdin.
    if (args.input) { const sent = await args.input; args.prompt = sent == null ? null : JSON.parse(sent).message.content.at(-1).text; }
    const a = await answer(args, calls.length);
    if (a && typeof a === "object") return a;
    return { ok: true, envelope: { result: a, session_id: args.resume ?? args.sessionId, usage: { cache_creation_input_tokens: 1_000 } } };
  };
  const turn = (text, extra = {}) => runTurnViaCli({ conversationId: C, text, images: none, startMcp: noMcp, recall: async () => notes(calls.length + 1), run, log: (e) => logs.push(e), ...extra });
  return { calls, logs, turn };
}

test("off by default, and off means every reply is a fresh process with the thread rendered into it, as before", async () => {
  delete process.env.REASON_KEEP_SESSION;
  assert.equal(keepSessionMode(), "off");
  assert.equal(keepSessionOn({ conversationId: C }), false);
  const b = backend();
  await b.turn("is it still 7?");
  await b.turn("and where");
  assert.equal(b.calls[1].resume, undefined);
  assert.match(b.calls[1].prompt, /The conversation so far/);
  assert.match(b.calls[1].prompt, /WHAT YOU KNOW ABOUT THEM/, "every note, every reply");
  assert.equal(chainOf(C), null, "and nothing is kept");
  assert.equal(existsSync(join(dir, "cli-sessions.json")), false);
});

test("owner reaches the operator's own thread only", () => {
  process.env.REASON_KEEP_SESSION = "owner";
  assert.equal(keepSessionOn({ conversationId: C }), true);
  assert.equal(keepSessionOn({ conversationId: "dm:fake:+14155550000" }), false);
  assert.equal(keepSessionOn({ conversationId: "dm:fake:+14155550000", isOperator: true }), true);
});

test("the next reply continues the last one's session: same instructions, and only the new message is sent", async () => {
  const b = backend();
  assert.equal(await b.turn("is it still 7?"), "reply 1");
  const first = b.calls[0];
  assert.equal(first.resume, undefined, "the first reply of a thread starts a session");
  assert.match(first.prompt, /WHAT YOU KNOW ABOUT THEM/);
  assert.ok(b.logs.some(e => e.session_fresh === C && e.why === "none"));

  assert.equal(await b.turn("and where"), "reply 2");
  const second = b.calls[1];
  assert.equal(second.resume, first.sessionId, "the second continues that very session");
  assert.equal(second.sessionId, undefined);
  assert.equal(second.system, first.system, "under the same bytes of instructions, anchor and all: the whole prefix is a cache hit");
  assert.ok(!/The conversation so far/.test(second.prompt), "the history is not sent again");
  assert.ok(!/is it still 7\?/.test(second.prompt), "nor the message it already answered");
  assert.ok(!/reply 1/.test(second.prompt), "nor its own reply");
  assert.ok(!/WHAT YOU KNOW ABOUT THEM/.test(second.prompt), "nor a note that reads the same as last time");
  assert.match(second.prompt, /The new message:\n\[[^\]]+\] Omari: and where/, "the new message, with its timestamp");
  assert.match(second.prompt, /Reply as Reason, in one short text/);
  assert.match(second.prompt, /Anything saved or live \(reminders, tasks, orders, mail, calendar, memory, where they are\) may have been changed from outside since you last read it: when this message needs it, read it from its tool again, as if for the first time\.$/, "saved and live things are read again; nothing is said of things that move with time when no time has passed");
  assert.doesNotMatch(second.prompt, /moves with time|weather|price/);
  assert.ok(!/It is now/.test(second.prompt), "a reply seconds after the last says nothing about a gap");
  const kept = b.logs.find(e => e.session_kept === C);
  assert.deepEqual({ turns: kept.turns, since: kept.since, sent: kept.notes_sent, same: kept.notes_same, gone: kept.notes_gone }, { turns: 2, since: 0, sent: 0, same: 1, gone: 0 });

  // And the third continues it again: a session is not used up by being continued.
  await b.turn("ok thanks");
  assert.equal(b.calls[2].resume, first.sessionId);
  assert.equal(chainOf(C).turns, 3);
  // The thread holds every line once, as it always did.
  assert.deepEqual(db.loadConversation(C).filter(m => m.role === "assistant").map(m => m.content), ["7pm at peaches", "reply 1", "reply 2", "reply 3"]);
});

test("a note that changed is sent whole, one that is gone is said to be gone, and one picked per message is never called gone", async () => {
  const notes = (n) => n === 1 ? [PROFILE, "RELEVANT MEMORIES (closest in meaning to this message):\n- dinner: likes peaches"]
    : n === 2 ? [`${PROFILE}\n- sister is Maya`] : [];
  const b = backend(undefined, { notes });
  await b.turn("is it still 7?");
  await b.turn("my sister is maya btw");
  const p2 = b.calls[1].prompt;
  assert.match(p2, /Notes for this message\. Each replaces the earlier note of the same kind above/);
  assert.match(p2, /\[WHAT YOU KNOW ABOUT THEM[^\]]*sister is Maya\]/, "the changed profile, whole");
  assert.ok(!/no longer applies/.test(p2), "the memories picked for the last message are not called gone");
  await b.turn("ok");
  const p3 = b.calls[2].prompt;
  assert.match(p3, /\[This earlier note no longer applies, nothing stands under it now: "WHAT YOU KNOW ABOUT THEM \(from past conversations\):"\]/, "a standing note that is gone is named, so nothing stale stands");
  assert.ok(!/Notes for this message/.test(p3));
  // Told once: the turn after that has nothing to say about it.
  await b.turn("cool");
  assert.ok(!/no longer applies/.test(b.calls[3].prompt));
});

test("notesForChain: same → not sent; changed → sent; a timer's turn does not report a person-turn note gone", () => {
  const sent = { profile: { h: "x", head: "WHAT YOU KNOW" }, kept: { h: "y", head: "pages you made" } };
  const user = notesForChain([{ k: "profile", t: "new profile" }], sent, "user");
  assert.deepEqual({ changed: user.changed, same: user.same, gone: user.gone }, { changed: 1, same: 0, gone: 1 });
  const event = notesForChain([], sent, "event");
  assert.equal(event.gone, 0);
  assert.equal(event.text, "");
});

test("what was added to the thread from elsewhere since the last reply is handed over, in order", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  // A reminder fired and a call was written into the thread: neither came through the session.
  db.saveConversation(C, [...db.loadConversation(C), { role: "assistant", content: "reminder: leave by 6:15" }, { role: "user", content: "[11:00] Omari: (on a call) move it to 8" }]);
  await b.turn("did you move it");
  const p = b.calls[1].prompt;
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.match(p, /Added to the conversation since your last reply, oldest first \(these did not come through you\):\nReason: reminder: leave by 6:15\n\[11:00\] Omari: \(on a call\) move it to 8\n\nThe new message:/);
  assert.equal(b.logs.find(e => e.session_kept === C).since, 2);
});

test("a line of the thread rewritten or removed since (forget that, a scrubbed password) starts afresh: the session still holds the old words", async () => {
  for (const edit of [
    (m) => m.map(x => x.content === "7pm at peaches" ? { ...x, content: "7pm at [removed]" } : x),
    (m) => m.filter(x => x.content !== "[10:00] Omari: when's dinner"),
    (m) => [m[0], { role: "assistant", content: "put in among the old lines" }, ...m.slice(1)],
  ]) {
    resetChains(); resetAnchors(); db.saveConversation(C, SEED);
    const b = backend();
    await b.turn("is it still 7?");
    db.saveConversation(C, edit(db.loadConversation(C)));
    await b.turn("and where");
    assert.equal(b.calls[1].resume, undefined, "not continued");
    assert.match(b.calls[1].sessionId, /^[0-9a-f-]{36}$/);
    assert.match(b.calls[1].prompt, /The conversation so far|at the end of your instructions/, "the thread as it stands now, rendered afresh");
    assert.match(b.calls[1].prompt, /WHAT YOU KNOW ABOUT THEM/, "with every note");
    assert.ok(b.logs.some(e => e.session_fresh === C && e.why === "thread_changed"));
  }
});

test("a full thread cut to size from its front does not end a session", async () => {
  // 60 lines is where src/thread.js cuts: the oldest two go as a reminder's two lines are added.
  const long = Array.from({ length: 30 }, (_, i) => [{ role: "user", content: `[10:${10 + i}] Omari: line ${i}` }, { role: "assistant", content: `answer ${i}` }]).flat();
  db.saveConversation(C, long);
  const b = backend();
  await b.turn("is it still 7?");
  const { saveThread } = await import("../src/thread.js");
  saveThread(C, [...db.loadConversation(C), { role: "user", content: "[11:00] Omari: (on a call) move it to 8" }, { role: "assistant", content: "moved to 8" }]);
  assert.equal(db.loadConversation(C).length, 60);
  await b.turn("and where");
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.match(b.calls[1].prompt, /Added to the conversation since your last reply[^\n]*\n\[11:00\] Omari: \(on a call\) move it to 8\nReason: moved to 8\n/);
});

test("chainFor: idle past the cache's life, grown too long, or under changed instructions → fresh, with the reason", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  const stored = { ...chainOf(C) };
  const all = db.loadConversation(C).map(m => m.role === "assistant" ? `Reason: ${m.content}` : m.content);
  const logs = [];
  const ask = (over = {}) => chainFor(C, { base: over.base ?? "", all, now: over.now ?? Date.now(), log: (e) => logs.push(e) });
  // The base this test passes is not the one the turn ran under.
  assert.equal(ask(), null);
  assert.equal(logs.at(-1).why, "instructions_changed");
  assert.equal(chainOf(C), null, "and a session that cannot be continued is forgotten");
  const { systemFor } = await import("../src/agent.js");
  const accounts = await import("../src/accounts.js");
  const base = systemFor(accounts.ownerOf(C));
  const put = (over = {}) => { resetChains(); cliPut({ ...stored, ...over }); };
  const cliPut = (c) => { /* through the file, the way a restart reads it */
    writeFileSync(join(dir, "cli-sessions.json"), JSON.stringify({ [C]: c }));
    resetChains({ disk: true });
  };
  put();
  assert.equal(ask({ base })?.id, stored.id, "the same instructions, the same thread, minutes later: continued");
  put();
  assert.equal(ask({ base, now: stored.at + CHAIN_IDLE_MS }), null);
  assert.equal(logs.at(-1).why, "idle");
  put({ grown: CHAIN_MAX_GROWN });
  assert.equal(ask({ base }), null);
  assert.equal(logs.at(-1).why, "grown");
  put({ turns: 30 });
  assert.equal(ask({ base }), null);
  assert.equal(logs.at(-1).why, "turns");
});

test("a restart continues too: the record is on disk, holds no line of the thread but the anchor, and is read back", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  const file = join(dir, "cli-sessions.json");
  const onDisk = JSON.parse(readFileSync(file, "utf8"))[C];
  assert.equal(onDisk.id, b.calls[0].sessionId);
  assert.ok(onDisk.lines.every(l => /^[0-9a-f]{16}$/.test(l)), "the thread's lines as hashes");
  assert.ok(!readFileSync(file, "utf8").includes("is it still 7?"));
  resetChains({ disk: true });   // the process is new
  await b.turn("and where");
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.equal(b.calls[1].system, b.calls[0].system);
});

test("a session the CLI will not resume falls back to the fresh turn in the same call; the reply after that continues the new session", async () => {
  const b = backend((args, n) => args.resume && n === 2 ? { ok: false, error: "No conversation found with session ID" } : `reply ${n}`);
  await b.turn("is it still 7?");
  assert.equal(await b.turn("and where"), "reply 3");
  assert.equal(b.calls.length, 3);
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.equal(b.calls[2].resume, undefined);
  assert.match(b.calls[2].prompt, /The conversation so far|at the end of your instructions/);
  assert.match(b.calls[2].prompt, /WHAT YOU KNOW ABOUT THEM/);
  assert.ok(b.logs.some(e => e.session_resume_failed === C));
  assert.equal(db.loadConversation(C).filter(m => m.content === "reply 3").length, 1);
  await b.turn("ok");
  assert.equal(b.calls[3].resume, b.calls[2].sessionId);
});

test("a continued run the model took part in and that then failed is a failed turn, never run twice, and nothing continues it", async () => {
  const b = backend((args, n) => n === 2 ? { ok: false, envelope: { is_error: true, result: "API Error: 529 overloaded" }, error: "the CLI reported an error" } : `reply ${n}`);
  await b.turn("is it still 7?");
  await assert.rejects(() => b.turn("and where"));
  assert.equal(b.calls.length, 2, "not run again");
  assert.equal(chainOf(C), null, "a session with half a turn in it is never continued");
  assert.ok(!db.loadConversation(C).some(m => String(m.content).endsWith("and where")), "and the line is taken back, as ever");
  await b.turn("and where");
  assert.equal(b.calls[2].resume, undefined);
});

test("a draft taken back before it was sent: the session is continued and told its last reply did not go", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  assert.ok(db.retractDraft(C, "reply 1"));
  await b.turn("And I'd watch it on Tuesday");
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.match(b.calls[1].prompt, /^\[Your last reply above was NOT sent\.\]\n\n/);
});

test("the said check's rewrite continues the session, and so does the reply after it; the code's own line never counts against it", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  // Runtime._turn, in order: the draft comes off the thread, the rewrite runs, its code line comes off.
  db.retractDraft(C, "reply 1");
  await b.turn(`[Your draft reply was NOT sent. Fix it.\nThe draft:\n"""reply 1"""]`, { keep: onethought.CODE_LINE, attachments: [], continueSession: true, recompose: true });
  db.dropUserLineEndingWith(C, onethought.CODE_LINE);
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  await b.turn("and where");
  assert.equal(b.calls[2].resume, b.calls[0].sessionId, "one session through the draft, its rewrite and the next reply");
  assert.ok(!/NOT sent/.test(b.calls[2].prompt), "the rewrite went: nothing to say about it");
  assert.equal(b.logs.filter(e => e.session_kept === C).at(-1).since, 0);
});

test("a question that was waiting is listed each time while it waits, and once it is answered the session is told nothing is waiting", async () => {
  const b = backend();
  const id = db.askConfirmation({ conversationId: C, action: "message_send", summary: "text kofi 'running late'", stakes: "low", askedAfterMsgs: 0 });
  await b.turn("text kofi im late");
  assert.match(b.calls[0].prompt, /Questions you already asked and are still waiting on:\n  - confirmation #\d+ \(message_send\)/);
  await b.turn("hmm");
  assert.match(b.calls[1].prompt, /Questions you already asked and are still waiting on:/, "still waiting: said again, it is the confirm gate's list");
  db.grantConfirmation(typeof id === "object" ? id.id : id, "yes send it");
  await b.turn("yes send it");
  assert.equal(b.calls[2].resume, b.calls[0].sessionId);
  assert.ok(!/still waiting on/.test(b.calls[2].prompt));
  assert.match(b.calls[2].prompt, /None of your earlier questions is waiting on an answer any more\./);
  await b.turn("thx");
  assert.ok(!/None of your earlier questions/.test(b.calls[3].prompt), "said once");
});

test("deleting a person's data forgets their anchor and kept session, and nobody else's", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  assert.ok(chainOf(C));
  forgetCliThreads("dm:fake:+14155550000");
  assert.ok(chainOf(C), "another person's delete touches nothing here");
  await deleteData({ conversation: C });
  assert.equal(chainOf(C), null);
  assert.ok(!readFileSync(join(dir, "cli-sessions.json"), "utf8").includes(b.calls[0].sessionId));
  const anchorsFile = join(dir, "cli-anchors.json");
  if (existsSync(anchorsFile)) assert.ok(!readFileSync(anchorsFile, "utf8").includes("peaches"));
});

test("with REASON_FAST_REPLY on, the continued session is started before its message is ready and asked on stdin", async () => {
  process.env.REASON_FAST_REPLY = "on";
  const b = backend();
  await b.turn("is it still 7?");
  await b.turn("and where");
  assert.ok(b.calls[1].input, "started early");
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.match(b.calls[1].prompt, /^The new message:\n/);
});

test("a saved fact or rule retired, reworded or deleted since the last reply starts afresh; one only ADDED does not", async () => {
  const facts = () => db.listFacts(C, { limit: 500 });
  // Added since: the session is continued, and the new fact reaches it through the notes.
  db.remember(C, "Maya", "is allergic to peanuts");
  let profile = PROFILE;
  let b = backend(undefined, { notes: () => [profile] });
  await b.turn("is it still 7?");
  db.remember(C, "Maya", "lives in Oakland");
  profile = `${PROFILE}\n- Maya lives in Oakland`;
  await b.turn("and where");
  assert.equal(b.calls[1].resume, b.calls[0].sessionId, "a fact added is not a reason to read everything again");
  assert.match(b.calls[1].prompt, /Maya lives in Oakland/, "and it is handed over, whole");

  // Retired (the nightly review, "forget that", the memory page).
  const oakland = facts().find(f => /Oakland/.test(f.fact));
  assert.equal(db.retireFact(C, oakland.id).ok, true);
  await b.turn("ok");
  assert.equal(b.calls[2].resume, undefined, "the session read the retired fact: not continued");
  assert.match(b.calls[2].prompt, /The conversation so far|at the end of your instructions/);
  assert.ok(b.logs.some(e => e.session_fresh === C && e.why === "memory_removed"));

  // Reworded: a correction retires the old row and writes a new one.
  await b.turn("one more");
  assert.equal(b.calls[3].resume, b.calls[2].sessionId, "and the fresh session is continued in its turn");
  const peanuts = facts().find(f => /peanuts/.test(f.fact));
  assert.equal(db.correctFact(C, peanuts.id, { fact: "is allergic to tree nuts, not peanuts" }).ok, true);
  await b.turn("again");
  assert.equal(b.calls[4].resume, undefined, "a reworded fact: not continued");

  // A rule about how they want to be treated, dropped.
  const rule = db.addRule(C, { rule: "never use emoji" });
  await b.turn("and again");
  assert.equal(b.calls[5].resume, b.calls[4].sessionId, "a rule added: continued");
  assert.ok(db.dropRule(C, rule.id ?? rule.rule?.id ?? db.activeRules(C)[0].id));
  await b.turn("last");
  assert.equal(b.calls[6].resume, undefined, "a rule dropped: not continued");

  // A record written before the mark existed is never trusted.
  await b.turn("x");
  const c = chainOf(C); delete c.memory;
  await b.turn("y");
  assert.equal(b.calls.at(-1).resume, undefined);
});

test("after a gap the continued session is told what time it is and how old everything it holds is", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  chainOf(C).at = Date.now() - 20 * 60_000;
  await b.turn("and now?");
  assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  assert.match(b.calls[1].prompt, /^\[It is now [^\]]+\. Everything above, your tool results included, is from 20 minutes ago or earlier\.\]/);  assert.match(b.calls[1].prompt, /what a tool or a page told you above about something that moves with time \(weather[^)]*\) is as old as the note at the top says: when this message needs it as it is now, fetch it again\.$/, "and only then, that what moves with time is fetched again");
});

test("one fact retired while an older one is put back (the count is unchanged) still starts afresh", async () => {
  db.remember(C, "Maya", "works at the bakery");
  db.remember(C, "Maya", "is allergic to peanuts");
  const facts = () => db.listFacts(C, { limit: 500 });
  const bakery = facts().find(f => /bakery/.test(f.fact));
  db.retireFact(C, bakery.id);
  const b = backend();
  await b.turn("is it still 7?");
  // From elsewhere: the peanuts fact goes and the bakery one comes back. As many active as before.
  db.retireFact(C, facts().find(f => /peanuts/.test(f.fact)).id);
  db.db.prepare("UPDATE person_facts SET status = 'active', valid_to = NULL WHERE id = ?").run(bakery.id);
  await b.turn("ok");
  assert.equal(b.calls[1].resume, undefined, "the session read the peanuts fact: not continued");
  assert.ok(b.logs.some(e => e.session_fresh === C && e.why === "memory_removed"));
});

test("a fact whose stored words were changed in place starts afresh", async () => {
  db.remember(C, "Maya", "lives in Oakland");
  const b = backend();
  await b.turn("is it still 7?");
  const row = db.db.prepare("SELECT f.id FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.conversation_id = ? AND f.status = 'active' ORDER BY f.id DESC").get(C);
  db.db.prepare("UPDATE person_facts SET fact = ? WHERE id = ?").run("something else entirely", row.id);
  await b.turn("ok");
  assert.equal(b.calls[1].resume, undefined);
  assert.ok(b.logs.some(e => e.session_fresh === C && e.why === "memory_removed"));
});

test("a line put into the thread by something else WHILE a reply ran is never recorded as read: the next reply starts afresh and so sees it", async () => {
  const b = backend(async (args, n) => {
    if (n === 1) db.saveConversation(C, [...db.loadConversation(C), { role: "assistant", content: "heads up, your package was delivered at 3:12pm" }]);
    return `reply ${n}`;
  });
  await b.turn("is it still 7?");
  assert.equal(chainOf(C), null, "nothing is kept of a session that missed a line");
  assert.ok(b.logs.some(e => e.session_fresh === C && e.why === "thread_added_mid_turn"));
  await b.turn("what got delivered");
  assert.equal(b.calls[1].resume, undefined);
  assert.match(b.calls[1].system + b.calls[1].prompt, /package was delivered at 3:12pm/, "the fresh turn is handed the line");
  await b.turn("thanks");
  assert.equal(b.calls[2].resume, b.calls[1].sessionId, "and the reply after that continues again");
});

test("a session whose continuing turn never finished (the process was killed under it) is not continued after the restart", async () => {
  const b = backend();
  await b.turn("is it still 7?");
  // The second turn dies with the process: what is on disk at that moment is what a restart reads.
  let onDisk = null;
  const b2 = backend(async () => { onDisk = readFileSync(join(dir, "cli-sessions.json"), "utf8"); return "reply"; });
  await b2.turn("and where");
  assert.equal(JSON.parse(onDisk)[C].open, true, "marked in use on disk while the turn runs");
  assert.equal(chainOf(C).open, undefined, "and cleared when it ends");
  resetChains({ disk: true });
  writeFileSync(join(dir, "cli-sessions.json"), onDisk);
  const b3 = backend();
  await b3.turn("you there?");
  assert.equal(b3.calls[0].resume, undefined);
  assert.ok(b3.logs.some(e => e.session_fresh === C && e.why === "unfinished"));
});
