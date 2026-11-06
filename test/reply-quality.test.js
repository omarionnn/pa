// Six ways a reply went wrong on its way to a phone, found by the 2026-10-18 audit of the live
// outbox and the owner's thread, each pinned by one test. No model, no network, no port: the CLI
// turn is driven with an injected `run`, the runtime with an injected `runTurn`.
//
//   1. the stall line went out 14 times — once per failed text, five inside two minutes
//   2. "NO_REPLY." and a reply with NO_REPLY on its last line were texted, marker and all
//   3. the CLI thread was never cut: 1,847 messages and 552 KB, of which 40 were ever read
//   4. a turn the model's outage killed left their line in the thread, once per retry
//   5. texts sent through message_send mid-turn were missing from the thread the next turn read
//   6. (the call recording that rode on an unrelated reply is in test/call-audio.test.js and
//      test/deliver-plain.test.js, next to the tests for the path it changes)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-reply-quality-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");
const { Runtime, STALL_REPEAT_AFTER_MS } = await import("../src/runtime.js");
const { readSilence } = await import("../src/plain.js");
const { THREAD_KEEP } = await import("../src/thread.js");
const trust = await import("../src/trust.js");

const C = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM outbox; DELETE FROM confirmations; DELETE FROM ops_state;");
  db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
});

/** One CLI turn with everything outside this file stubbed. `run` decides what the model did. */
const cliTurn = (text, run) => runTurnViaCli({
  conversationId: C, text, run,
  startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
  images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
  capture: async () => null,
  recall: async () => [],
});
const says = (result) => async () => ({ ok: true, envelope: { result } });
const lines = () => db.loadConversation(C);

test("the stall line goes out once per episode, and again only after a turn of theirs has worked", async () => {
  const sent = [];
  let broken = true;
  const rt = new Runtime({
    screen: async () => ({ verdict: "clear" }),
    runTurn: async () => { if (broken) throw new Error("the CLI exited 1"); return "ok i'm back"; },
  });
  rt.on("outbound", (m) => sent.push(m.text));
  const stall = /broke on my end/;

  // Five texts in two minutes while it is broken, which is the 2026-10-11 02:45 night.
  for (let i = 0; i < 5; i++) { await rt.inbound(C, `hello? ${i}`); clock.skip(25_000); }
  assert.equal(sent.filter(t => stall.test(t)).length, 1, "told once, not once per text");

  // It works again, then breaks again: that is a new failure and they hear about it.
  broken = false;
  await rt.inbound(C, "you there");
  broken = true;
  await rt.inbound(C, "and now?");
  assert.equal(sent.filter(t => stall.test(t)).length, 2, "a failure after a working turn is news");

  // And an episode with no end in sight is not silence forever.
  clock.skip(STALL_REPEAT_AFTER_MS + 1);
  await rt.inbound(C, "still broken?");
  assert.equal(sent.filter(t => stall.test(t)).length, 3);
});

test("NO_REPLY written any way at all is silence, and a trailing NO_REPLY line comes off a real reply", async () => {
  for (const quiet of ["NO_REPLY.", "**NO_REPLY**", "`NO_REPLY`", " NO_REPLY\n", "NO_REPLY\n\nnothing new on the watch"]) {
    assert.equal(await cliTurn("ping", says(quiet)), null, JSON.stringify(quiet));
  }
  assert.equal(await cliTurn("ping", says("got it, tuesday at 4\n\nNO_REPLY")), "got it, tuesday at 4");
  assert.equal(lines().at(-1).content, "got it, tuesday at 4", "the thread does not keep the marker either");
  // The same helper on the API path (src/agent.js), and prose that only mentions it is prose.
  assert.equal(readSilence("i'd have said NO_REPLY to that").silent, false);
});

test("the CLI thread is cut to size on save, and a yes after the cut still answers the ask made before it", async () => {
  const pile = [];
  for (let i = 0; i < 900; i++) pile.push({ role: "user", content: `[Sat] Omari: msg ${i}` }, { role: "assistant", content: `reply ${i}` });
  db.saveConversation(C, pile);

  let asked;
  await cliTurn("book the 8pm table", async () => {
    // What the MCP server does for confirm_request: count what the thread holds right now.
    asked = trust.requestConfirmation({ conversationId: C, messages: db.loadConversation(C), action: "browser_submit", summary: "book Carbone 8pm", stakes: "" });
    return { ok: true, envelope: { result: "carbone at 8 for 2 — book it?" } };
  });
  assert.ok(lines().length <= THREAD_KEEP, `kept ${lines().length}, not the whole 1,800`);

  let got;
  await cliTurn("yes", async () => {
    got = await trust.recordConfirmation({
      conversationId: C, messages: db.loadConversation(C), confirmationId: asked.confirmation_id,
      judge: async () => ({ verdict: "yes" }),
    });
    return { ok: true, envelope: { result: "booked" } };
  });
  assert.equal(got.state, "granted", "the cut must not make a real yes read as 'not answered yet'");
});

test("a turn that dies leaves no line of theirs behind, so retries do not stack the same text", async () => {
  db.saveConversation(C, [{ role: "user", content: "[Sat] Omari: earlier" }, { role: "assistant", content: "hi" }]);
  const down = async () => ({ ok: false, error: "You've hit your session limit · resets 7:10pm (UTC)" });
  for (let i = 0; i < 3; i++) await assert.rejects(cliTurn("what do you think about past.dev", down));
  assert.equal(lines().length, 2, "three failed tries wrote nothing");

  await cliTurn("what do you think about past.dev", says("solid pick"));
  assert.equal(lines().filter(m => /past\.dev/.test(m.content)).length, 1, "the retry that works writes it once");
});

test("what a turn texted them through message_send is in the thread the next turn reads", async () => {
  db.saveConversation(C, []);
  await cliTurn("find me a flight to lisbon", async () => {
    // A message_send to their own thread, as src/tools.js puts it in the outbox.
    db.enqueueOutbound({ idemKey: "mid-1", conversationId: C, channel: "test", address: "+12025551234", body: "on it, checking tap and united now", toOwner: true });
    // One to somebody else is not part of this thread.
    db.enqueueOutbound({ idemKey: "mid-2", conversationId: C, channel: "test", address: "+15555550000", body: "hi from omari's assistant", toOwner: false });
    // And one identical to the final reply is not written twice.
    db.enqueueOutbound({ idemKey: "mid-3", conversationId: C, channel: "test", address: "+12025551234", body: "tap at 9:40, $612", toOwner: true });
    return { ok: true, envelope: { result: "tap at 9:40, $612" } };
  });
  assert.deepEqual(lines().slice(1).map(m => [m.role, m.content]), [
    ["assistant", "on it, checking tap and united now"],
    // The final reply is the one the figures check ran on (src/offers.js): no tool fetched $612, so
    // it is sent back for a rewrite (Runtime._turn), never tagged — and the identical mid-turn text
    // is still not written twice.
    ["assistant", "tap at 9:40, $612"],
  ]);
});
