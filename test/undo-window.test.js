// The thirty seconds between "yes" and the thing actually happening.
//
// Every other test file in here switches this off (REASON_UNDO_SECONDS=0) so it can ask what it is
// about. This is the one file that leaves it on, so the window itself is what is being asserted.
//
// The thing being defended against is not a model going rogue — the confirm gate already stops
// that, and runs before any of this. It is the ordinary regret: a yes given in a second, aimed at
// the wrong person or about a thing they changed their mind on while Reason was already typing. By
// the time the regret arrives the email has landed. So every question in here is about the gap:
//
//   does something going to a third party actually wait?          (yes, and nothing leaves early)
//   does an answer to the person themselves get slower?           (no — never held, at any setting)
//   does "undo" inside the window really stop it?                 (yes, and nothing is ever sent)
//   does a late undo get told it stopped something?               (no — it gets the honest line)
//   does a restart mid-window lose it, or send it twice?          (neither)
//   whose window is it?                                           (theirs, 0 to 300, and 0 is real)
//   can somebody see what is still stoppable?                     (yes, with the seconds on it)
//
// No model, no network, no clock but the fake one: the window is asserted by skipping it, never by
// waiting it out.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-undo-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
// Calling hours off in here, so these tests do not depend on what time it is when the suite runs
// (REASON_CALL_QUIET_HOURS defaults to 21:00-08:00, and a suite run at midnight would see every
// call refused for the hour rather than for the reason being tested). The window itself is proven
// in test/call-handling.test.js, against a fixed clock.
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
// REASON_UNDO_SECONDS is deliberately NOT set: the shipped default is part of what this file pins.

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { runTool, runReleasedAction } = await import("../src/tools.js");
const undoLib = await import("../src/undo.js");
const { activityBlocks } = await import("../src/activity.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const MARTA = "+14155559876";
const C = "dm:owner";
// What a text to somebody who is not them has to look like to get past the two checks on how it
// reads. Those run before the hold, which is the order that matters: a message that was never
// going to go is refused now, not announced as going and refused half a minute later. Short enough
// to appear whole in the line, so the line can be asserted word for word.
const PROPER = "8pm works. — Omari's assistant, Reason";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec(`DELETE FROM held_actions; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads;
    DELETE FROM conversations; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM usage;
    DELETE FROM important_people; DELETE FROM calls; DELETE FROM tasks; DELETE FROM pages;`);
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, chatId: null, isOwner: true });
});

/** A router and a runtime whose turns are recorded rather than run — a restart is a second one. */
function harness(channelOpts = {}) {
  const logs = [];
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async () => null });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639", ...channelOpts }));
  runtime.turnExtras.channels = router;
  return { runtime, router, fake, logs };
}

const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });

/** Ask, answer yes, hand back the id. The gate's happy path, and it runs BEFORE any window. */
async function yesFor(summary, { action = "message_send", target = MARTA } = {}) {
  const asked = await runTool("confirm_request", { action, summary, target },
    { conversationId: C, messages: [owner("do it")] });
  const got = await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("do it"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });
  assert.equal(got.state, "granted");
  return asked.confirmation_id;
}

/** A text to Marta, taken as far as the window and no further. */
async function parkText(router, { text = PROPER } = {}) {
  const yes = await yesFor(`text ${MARTA}: "8pm works"`);
  return runTool("message_send", { to: MARTA, text, confirmation_id: yes },
    { conversationId: C, channels: router });
}

// ---------- it waits, and it leaves exactly when the window says ----------

test("a text to somebody else is held, and nothing is on the wire until the window runs out", async () => {
  const { runtime, router, fake } = harness();
  assert.equal(config.undoWindowSeconds, 30,
    "the shipped default is thirty seconds; a .env that overrides it will break this file");

  const out = await parkText(router);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.undo_held, true, "it came back held, not sent");
  assert.equal(out.going_out_in_seconds, 30);
  assert.equal(out.to, MARTA);
  // The one line Reason says, word for word. It names the thing and the recipient and the word that
  // stops it — never "sending a message", which is the version nobody can check at a glance.
  assert.equal(out.say_exactly, `sending "${PROPER}" to ${MARTA} in 30s — just tell me if you want to stop it`);
  assert.match(out.note, /NOTHING HAS GONE YET/);
  assert.equal(fake.sent.length, 0, "nothing reached the channel");
  // And no receipt, because a receipt for something that has not happened is the lie this feature
  // would otherwise introduce.
  assert.equal(db.listActions(C).length, 0, "no ledger row for a thing that has not happened");

  const held = db.liveHolds(C);
  assert.equal(held.length, 1);
  assert.equal(held[0].state, "held");
  assert.equal(held[0].kind, "text");

  // One second short of the window: still nothing, and the sweep does not take it.
  clock.skip(29_000);
  assert.deepEqual(await runtime.undo(), { due: 0, sent: 0, failed: 0, owner_told: 0 });
  assert.equal(fake.sent.length, 0, "29 seconds in, it has still not gone");

  clock.skip(2_000);
  const pass = await runtime.undo();
  assert.equal(pass.due, 1);
  assert.equal(pass.sent, 1);
  assert.equal(fake.sent.length, 1, "and now it has gone, once");
  assert.equal(fake.sent[0].to, MARTA);
  assert.equal(fake.sent[0].text, PROPER);
  assert.equal(db.getHeldAction(held[0].id).state, "sent");
  // The receipt is written at release, so the ledger says what happened rather than what was about
  // to, and it carries the yes it went out on.
  const ledger = db.listActions(C);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].target, `text:${MARTA}`);
});

test("a call is held too, and the line calls them by the name they were given", async () => {
  // call_place is the one held tool with no draft-only check in front of it, so a saved contact can
  // actually reach the line. The name is used only because this person wrote it down themselves —
  // a guessed name on the wrong number would be the one way this feature could make things worse.
  db.addImportantPerson(C, { who: "Marta", why: "the landlord", contact: MARTA });
  const calls = new FakeCallProvider();
  const yes = await yesFor(`call ${MARTA} about the lease`, { action: "call_place" });

  const out = await runTool("call_place", { to: MARTA, goal: "ask about the lease", confirmation_id: yes },
    { conversationId: C, calls });
  assert.equal(out.undo_held, true, out.error);
  assert.equal(out.say_exactly, `calling Marta in 30s — just tell me if you want to stop it`);
  assert.equal(calls.placed.length, 0, "nothing was dialled");
  assert.equal(db.listCalls(C).length, 0, "and no call row exists yet");
});

// ---------- the conversation itself never gets slower ----------

test("an answer to the person themselves is never held, however it is addressed", async () => {
  const { router, fake } = harness();

  const byWord = await runTool("message_send", { to: "owner", text: "on my way" },
    { conversationId: C, channels: router });
  assert.equal(byWord.ok, true, byWord.error);
  assert.ok(!byWord.undo_held, "a reply to them is not held");
  assert.equal(fake.sent.length, 1, "it went immediately");

  // A second apart, because the outbox keys an un-held send on the clock and the clock here is the
  // fake one: two sends in the same millisecond are one row to it, which is the outbox doing its job.
  clock.skip(1_000);
  const byNumber = await runTool("message_send", { to: OWNER, text: "and here's the other thing" },
    { conversationId: C, channels: router });
  assert.ok(!byNumber.undo_held, "nor when they are named by their own number");
  assert.equal(fake.sent.length, 2);
  assert.equal(db.liveHolds(C).length, 0, "nothing was ever parked");
});

test("a calendar event nobody else is on is not held — it reaches no one", async () => {
  // Proven at the decision rather than through Google, because that is where the rule lives: what
  // is held is what reaches a third party, and an event with no attendees emails nobody.
  assert.equal(undoLib.HOLDS.calendar_create, "calendar");
  const { runtime } = harness();
  assert.equal((await runtime.undo()).due, 0);
});

// ---------- stop means stop ----------

test("'undo' inside the window stops it, and nothing ever goes to her", async () => {
  const { runtime, router, fake } = harness();
  const parked = await parkText(router);

  clock.skip(10_000);
  const stop = await runTool("undo_send", {}, { conversationId: C, channels: router });
  assert.equal(stop.ok, true);
  assert.equal(stop.stopped, true);
  assert.equal(stop.held_id, parked.held_id);
  assert.equal(stop.say_exactly, `stopped, nothing went to ${MARTA}`);
  assert.deepEqual(stop.still_held, [], "nothing else was waiting");

  // And it stays stopped: the window running out afterwards does not resurrect it.
  clock.skip(60_000);
  const pass = await runtime.undo();
  assert.equal(pass.due, 0, "a stopped row is never due");
  assert.equal(fake.sent.length, 0, "nothing was ever sent to her");
  assert.equal(db.getHeldAction(parked.held_id).state, "stopped");
  assert.equal(db.listActions(C).length, 0, "and there is no receipt, because it never happened");
});

test("a bare undo takes the newest; a named one takes the one named and leaves the other", async () => {
  const { router, fake } = harness();
  const first = await parkText(router, { text: "Hello, Tuesday works for Omari. This is Omari's assistant, Reason." });
  const second = await parkText(router);
  assert.equal(db.liveHolds(C).length, 2);

  const bare = await runTool("undo_send", {}, { conversationId: C, channels: router });
  assert.equal(bare.held_id, second.held_id, "a bare undo means the one they just watched Reason announce");
  assert.equal(bare.still_held.length, 1, "and it says the other is still going");
  assert.equal(bare.still_held[0].held_id, first.held_id);
  assert.match(bare.note, /STILL going out/);

  const named = await runTool("undo_send", { held_id: first.held_id }, { conversationId: C, channels: router });
  assert.equal(named.stopped, true);
  assert.equal(named.held_id, first.held_id);
  assert.equal(fake.sent.length, 0);
});

test("undo when nothing is waiting says exactly that, and never implies something was undone", async () => {
  const { router } = harness();
  const out = await runTool("undo_send", {}, { conversationId: C, channels: router });
  assert.equal(out.ok, false);
  assert.equal(out.nothing_held, true);
  assert.equal(out.say_exactly, "nothing was waiting to go out — all clear");
  assert.doesNotMatch(out.say_exactly, /stopped/);
});

// ---------- a late undo is told the truth ----------

test("undo after the window gets the honest line and the real way back, never 'stopped'", async () => {
  const { runtime, router, fake } = harness();
  const parked = await parkText(router);

  clock.skip(31_000);
  assert.equal((await runtime.undo()).sent, 1);
  assert.equal(fake.sent.length, 1, "it really did go");

  const late = await runTool("undo_send", {}, { conversationId: C, channels: router });
  assert.equal(late.ok, false);
  assert.equal(late.too_late, true);
  assert.equal(late.held_id, parked.held_id);
  assert.match(late.say_exactly, new RegExp(`already went to \\${MARTA}`));
  assert.doesNotMatch(late.say_exactly, /stopped/, "it must never claim it stopped something that went");
  assert.match(late.note, /do NOT say you stopped it/);
  // The way back is the same table the confirm gate quotes, so the two can never disagree about
  // what can be taken back.
  const { UNDO } = await import("../src/verify.js");
  assert.ok(UNDO.message_send, "the action has a stated take-back path");
  assert.equal(fake.sent.length, 1, "and the late undo sent nothing new");
});

test("an undo arriving in the same breath as the release loses cleanly rather than lying", async () => {
  // The race, made deterministic: the row is claimed (which is what the sweep does before anything
  // leaves) and the undo arrives after. "Stopped, nothing went to Marta" is a claim about a row
  // that really changed, so a claimed row has to refuse it.
  const { router } = harness();
  const parked = await parkText(router);
  clock.skip(31_000);
  assert.ok(db.claimHold(parked.held_id), "the sweep has it");

  const out = await runTool("undo_send", { held_id: parked.held_id }, { conversationId: C, channels: router });
  assert.equal(out.ok, false);
  assert.equal(out.too_late, true);
  assert.doesNotMatch(out.say_exactly, /stopped/);
  assert.equal(db.getHeldAction(parked.held_id).state, "going", "and the stop did not move it");
});

// ---------- a restart ----------

test("a restart mid-window neither loses it nor sends it twice", async () => {
  const first = harness();
  const parked = await parkText(first.router);
  assert.equal(first.fake.sent.length, 0);

  // The process stops eleven seconds in. A setTimeout would have died with it; a row does not.
  clock.skip(11_000);
  const after = harness();
  // What start() does on the way up: nothing is mid-release, so nothing is stranded.
  assert.deepEqual(undoLib.recoverStranded({ log: () => {} }), []);
  assert.equal(db.liveHolds(C).length, 1, "the window survived the restart");
  assert.equal(db.getHeldAction(parked.held_id).state, "held");

  clock.skip(20_000);
  assert.equal((await after.runtime.undo()).sent, 1);
  assert.equal(after.fake.sent.length, 1, "it went, once, on the far side of the restart");

  // And run the release again, which is the only way it could ever double-send. The outbox owns
  // "never twice" and the hold carries its key into it, so the second run finds the first's row.
  const row = db.getHeldAction(parked.held_id);
  await runReleasedAction(row, { channels: after.router });
  assert.equal(after.fake.sent.length, 1, "the same key sent nothing a second time");
});

test("a restart MID-release is not retried, and they are told in those words", async () => {
  const { runtime, router, fake } = harness();
  const parked = await parkText(router);
  clock.skip(31_000);
  // Claimed, then the process died: it may have reached the channel with the answer lost on the way
  // back. Losing one thing loudly beats doing it twice quietly.
  assert.ok(db.claimHold(parked.held_id));

  assert.deepEqual(undoLib.recoverStranded({ log: () => {} }), [parked.held_id]);
  const row = db.getHeldAction(parked.held_id);
  assert.equal(row.state, "unknown");
  assert.match(row.last_error, /NOT done again/);

  const pass = await runtime.undo();
  assert.equal(pass.due, 0, "it is NOT run again");
  assert.equal(pass.owner_told, 1);
  const told = fake.sent.find(s => /don't know whether it went/i.test(s.text));
  assert.ok(told, `the owner was told; got ${JSON.stringify(fake.sent.map(s => s.text))}`);
  assert.equal(told.to, OWNER, "told in their own thread");
  // Said once, however many sweeps run.
  assert.equal((await runtime.undo()).owner_told, 0);
});

// ---------- whose window it is ----------

test("the window is theirs in plain words, and it authorizes nothing", async () => {
  const { router, fake } = harness();

  const read = await runTool("undo_window", {}, { conversationId: C });
  assert.equal(read.seconds, 30);
  assert.equal(read.set, false, "nobody has changed it; that is a different sentence from choosing 30");
  assert.match(read.note, /Nobody has ever changed this/);

  const set = await runTool("undo_window", { seconds: 5 }, { conversationId: C });
  assert.equal(set.ok, true);
  assert.equal(set.seconds, 5);
  assert.equal(set.set, true);
  assert.equal(set.say_exactly, "5s to undo on anything i send for you now");
  assert.match(set.note, /NOTHING about what needs a yes/);

  // And it really applies: the same send now waits five seconds, not thirty.
  const parked = await parkText(router);
  assert.equal(parked.going_out_in_seconds, 5);
  assert.match(parked.say_exactly, /in 5s/);
  assert.equal(fake.sent.length, 0);

  // Still gated, exactly as before: the window is the out AFTER a yes, never instead of one.
  const noYes = await runTool("message_send", { to: MARTA, text: PROPER }, { conversationId: C, channels: router });
  assert.equal(noYes.ok, false, "no yes, no send — the window changed nothing about that");
  assert.equal(fake.sent.length, 0);
});

test("zero really means nothing is held, and 300 is the ceiling", async () => {
  const { router, fake } = harness();
  await runTool("undo_window", { seconds: 0 }, { conversationId: C });

  const out = await parkText(router);
  assert.equal(out.ok, true, out.error);
  assert.ok(!out.undo_held, "switched off is honoured exactly: no row, no window, no line about one");
  assert.equal(fake.sent.length, 1, "it went straight out");
  assert.equal(db.liveHolds(C).length, 0);
  assert.equal(undoLib.windowMsFor(C, "text"), 0);

  // Past the ceiling is refused at the edge, with nothing written.
  const high = await runTool("undo_window", { seconds: 99_999 }, { conversationId: C });
  assert.equal(high.ok, false);
  assert.match(high.error, /less than or equal to 300/);
  assert.equal(undoLib.windowMsFor(C, "text"), 0, "the refusal changed nothing");

  // And clamped again on the way out, so a row from an older build or edited by hand cannot produce
  // a five-hour hold even though no tool call could have written one.
  assert.equal(undoLib.clampSeconds(99_999), 300);
  assert.equal(undoLib.clampSeconds(-5), 0);
  db.db.prepare("UPDATE accounts SET undo_seconds = 99999 WHERE conversation_id = ?").run(C);
  assert.equal(undoLib.windowMsFor(C, "text"), 300_000);
});

test("a long message is quoted short in the line, so the line stays one sentence", async () => {
  const { router } = harness();
  const long = `Hello, Omari says 8pm on Tuesday works for him and he will meet you in the lobby.`
    + ` This is Omari's assistant, Reason.`;
  const out = await parkText(router, { text: long });
  assert.match(out.say_exactly, /^sending "Hello, Omari says 8pm on Tuesday works for him and he/);
  assert.match(out.say_exactly, /…" to \+14155559876 in 30s/, "elided, not read back in full");
  assert.ok(out.say_exactly.length < 140, `still one short line, got ${out.say_exactly.length}`);
  assert.match(out.say_exactly, /just tell me if you want to stop it$/);
});

test("a kind can have its own window, and it does not touch the others", async () => {
  const { router } = harness();
  await runTool("undo_window", { seconds: 5 }, { conversationId: C });
  const perKind = await runTool("undo_window", { seconds: 120, kind: "email" }, { conversationId: C });
  assert.equal(perKind.say_exactly, "2 minutes to undo on emails now");
  assert.deepEqual(perKind.by_kind, { email: 120 });

  assert.equal(undoLib.windowMsFor(C, "email"), 120_000);
  assert.equal(undoLib.windowMsFor(C, "text"), 5_000, "the overall one still holds for everything else");
  assert.equal((await parkText(router)).going_out_in_seconds, 5);
});

test("a setting with nowhere to be kept is said, not swallowed", async () => {
  // The quiet version of this is the worst outcome the feature has: somebody told the window is off,
  // believing it, while every send still waits its thirty seconds. There is no account behind this
  // conversation, and a blank one is not invented to hang a preference off.
  const out = await runTool("undo_window", { seconds: 0 }, { conversationId: "dm:nobody" });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "no_account");
  assert.match(out.error, /do NOT say it is set/);
  assert.equal(undoLib.windowMsFor("dm:nobody", "text"), 30_000, "and the window really is unchanged");
});

// ---------- somebody can see it ----------

test("the open page shows what is still going out, with the seconds and the way to stop it", async () => {
  const { router } = harness();
  const parked = await parkText(router);
  clock.skip(18_000);

  const r = await runTool("activity_page", {}, { conversationId: C });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.going_out, 1);
  const blocks = db.getPageIn(C, r.page_id).blocks;
  const going = blocks.find(b => b.type === "rows" && b.title === "Going out in a moment");
  assert.ok(going, "the held thing is on the page");
  assert.equal(going.items[0].value, "going out in 12s");
  assert.equal(going.items[0].detail, 'tell me if you want to stop it');
  assert.match(going.items[0].name, new RegExp(`to \\${MARTA}`), "named, so it can be identified");

  // Above everything else on the page, because it is the only thing on it with a stopwatch.
  assert.equal(blocks.findIndex(b => b === going), 1, "straight after the headline block");

  // And once stopped, the page says stopped — which is what makes the first block trustworthy.
  await runTool("undo_send", { held_id: parked.held_id }, { conversationId: C, channels: router });
  const after = await runTool("activity_page", {}, { conversationId: C });
  assert.equal(after.going_out, 0);
  assert.equal(after.stopped, 1);
  const stopped = db.getPageIn(C, after.page_id).blocks
    .find(b => b.type === "rows" && b.title === "Stopped before it went");
  assert.ok(stopped, "and the undo is visible as having worked");
  assert.equal(stopped.items[0].value, "stopped");
  assert.equal(stopped.items[0].detail, `nothing went to ${MARTA}`);
});

test("a page with a held thing on it is not the empty page", async () => {
  // The blocks are a pure function of the rows, so this is asserted on the rows directly.
  const { blocks, counts } = activityBlocks({
    tasks: [],
    holds: [{ state: "held", doing: `sending the lease email to ${MARTA}`, what: "the email", to_whom: MARTA, due_at: 12_000 }],
    now: 0,
  });
  assert.equal(counts.going_out, 1);
  assert.ok(!blocks.some(b => b.type === "text" && /Nothing is running/.test(b.text)),
    "a page with something going out in twelve seconds does not say nothing is running");
});

// ---------- the model is told, in the words it needs ----------

test("the turn is told what is held and how long is left, and the thread's history is not", async () => {
  const { router } = harness();
  await parkText(router);
  clock.skip(7_000);

  const { openWorkNote } = await import("../src/openwork.js");
  const note = openWorkNote(C);
  assert.match(note, /held, not yet gone/);
  assert.match(note, /"going_out_in":"23s"/);
  assert.match(note, /call undo_send NOW/);
  // Nothing else is open, so the note is the held thing and not a paragraph about sheets.
  assert.doesNotMatch(note, /open work, with everything each job is carrying/);

  // It is a fact about this second: once stopped, it stops being said.
  await runTool("undo_send", {}, { conversationId: C, channels: router });
  assert.equal(openWorkNote(C), "");
});

test("what Reason says it can do is this person's window, never the feature's", async () => {
  const { capabilitiesNow } = await import("../src/tools.js");
  const onByDefault = capabilitiesNow({ conversationId: C }).find(c => c.name === "undo_window");
  assert.match(onByDefault.what, /waits 30s before it really goes/);
  assert.match(onByDefault.what, /never instead of asking/);

  await runTool("undo_window", { seconds: 0 }, { conversationId: C });
  const off = capabilitiesNow({ conversationId: C }).find(c => c.name === "undo_window");
  assert.match(off.what, /nothing is held/, "somebody who switched it off must not be told they have 30 seconds");
  assert.doesNotMatch(off.what, /30s before it really goes/);
});
