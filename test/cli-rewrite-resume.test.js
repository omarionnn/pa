// The said check's rewrite continues the draft's own CLI session (speed audit 2026-10-27, item 5).
//
// Before: a draft the pre-send check rejected was rewritten by a whole second turn — rendered history,
// notes, a cold prefix, every tool redone — 8–15 s on 13% of turns and most of the p90 tail. Now every
// turn runs under a session id Reason chose, and the rewrite is `--resume` of that session with the
// note alone: the model sees exactly what it did, and the prefix is a cache hit.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-resume-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { runTurnViaCli, sessionFor } = await import("../src/backends/claude-cli.js");
const { cliInvocation } = await import("../src/backends/cli.js");
const onethought = await import("../src/onethought.js");

const C = "dm:owner";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noMcp = async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} });
const none = async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => db.saveConversation(C, [{ role: "user", content: "[10:00] Omari: when's dinner" }, { role: "assistant", content: "7pm at peaches" }]));

/** One turn through the CLI backend with `run` standing in for the CLI. */
function backend(answer) {
  const calls = [];
  const run = async (args) => { calls.push(args); return typeof answer === "function" ? answer(args, calls.length) : { ok: true, envelope: { result: answer } }; };
  const turn = (extra) => runTurnViaCli({ conversationId: C, text: "is it still 7?", images: none, startMcp: noMcp, recall: async () => [], run, ...extra });
  return { calls, turn };
}

test("every turn runs under a session id of Reason's own, and the rewrite resumes that very session with the note alone", async () => {
  const b = backend((args, n) => ({ ok: true, envelope: { result: n === 1 ? "it's at 8 now" : "earlier i said 7, it moved: 8pm" } }));
  const first = await b.turn();
  assert.equal(first, "it's at 8 now");
  const run1 = b.calls[0];
  assert.match(run1.sessionId, UUID, "the turn names its session");
  assert.equal(run1.resume, undefined);
  assert.match(run1.prompt, /The conversation so far:/);
  assert.equal(sessionFor(C), run1.sessionId, "the finished turn's session is the one a rewrite continues");

  const note = `[Your draft reply was NOT sent. It changes what you told them earlier. Write the reply again with that fixed.\nThe draft:\n"""it's at 8 now"""]`;
  const second = await b.turn({ text: note, keep: onethought.CODE_LINE, attachments: [], continueSession: true });
  assert.equal(second, "earlier i said 7, it moved: 8pm");
  const run2 = b.calls[1];
  assert.equal(run2.resume, run1.sessionId, "the rewrite continues the draft's session");
  assert.equal(run2.sessionId, undefined, "and does not start a new one");
  assert.equal(run2.system, run1.system, "same system prompt, so the prefix is a cache hit");
  assert.ok(!/The conversation so far:/.test(run2.prompt), "the history is not pasted again: the session has it");
  assert.match(run2.prompt, /The new message:\n.*Your draft reply was NOT sent/s);
  assert.match(run2.prompt, /Reply as Reason, in one short text/);
  assert.equal(run2.mcpUrl, run1.mcpUrl, "tools are still on hand for the rewrite");
  // Used once: a third turn asking to continue finds nothing and runs the long way.
  assert.equal(sessionFor(C), null);
  const kept = db.loadConversation(C).map(m => m.content);
  assert.ok(kept.includes("earlier i said 7, it moved: 8pm"), "the rewrite is what the thread keeps");
});

test("with no fresh session to continue, the rewrite runs the long way, exactly as before", async () => {
  const b = backend("earlier i said 7, it moved: 8pm");
  // No turn ran in this process for this thread (a restart in between): nothing to resume.
  assert.equal(sessionFor("dm:nobody"), null);
  await runTurnViaCli({ conversationId: C, historyId: C, text: "[Your draft reply was NOT sent…]", keep: onethought.CODE_LINE, continueSession: true, images: none, startMcp: noMcp, recall: async () => [], run: b.calls.push.bind(b.calls) && (async (args) => { b.calls.push(args); return { ok: true, envelope: { result: "fine" } }; }) });
  const run = b.calls.at(-1);
  assert.equal(run.resume, undefined);
  assert.match(run.sessionId, UUID);
  assert.match(run.prompt, /The conversation so far:/, "the full prompt, history included");
});

test("a resume the CLI refuses falls back to the full turn in the same call, and says so", async () => {
  const logs = [];
  const b = backend((args, n) => {
    if (n === 1) return { ok: true, envelope: { result: "it's at 8 now" } };
    if (args.resume) return { ok: false, error: "No conversation found with session ID" };
    return { ok: true, envelope: { result: "earlier i said 7, it moved: 8pm" } };
  });
  await b.turn();
  const sid = b.calls[0].sessionId;
  const reply = await b.turn({ text: "[Your draft reply was NOT sent…]", keep: onethought.CODE_LINE, continueSession: true, log: (e) => logs.push(e) });
  assert.equal(reply, "earlier i said 7, it moved: 8pm");
  assert.equal(b.calls.length, 3);
  assert.equal(b.calls[1].resume, sid);
  assert.equal(b.calls[2].resume, undefined);
  assert.match(b.calls[2].sessionId, UUID);
  assert.match(b.calls[2].prompt, /The conversation so far:/);
  assert.ok(logs.some(e => e.cli_resume_failed === C), "the failed resume is logged");
  // The thread holds the inbound line and the one reply — not two of either.
  const rows = db.loadConversation(C);
  assert.equal(rows.filter(m => m.role === "assistant" && m.content === "earlier i said 7, it moved: 8pm").length, 1);
});

test("a resumed run the model took part in and that then failed is a failed turn, never run twice", async () => {
  for (const failure of [
    { ok: false, envelope: { is_error: true, result: "API Error: 529 overloaded" }, error: "the CLI reported an error" },
    { ok: false, error: "the CLI did not finish inside 300000ms" },
  ]) {
    const b = backend((args, n) => n === 1 ? { ok: true, envelope: { result: "draft" } } : failure);
    await b.turn();
    await assert.rejects(() => b.turn({ text: "[note]", keep: onethought.CODE_LINE, continueSession: true }));
    assert.equal(b.calls.length, 2, `no second attempt after: ${failure.error}`);
    assert.equal(b.calls[1].resume, b.calls[0].sessionId);
  }
});

test("a turn stopped by a restart during the resume is not run again here: that is the drain's job", async () => {
  const b = backend((args, n) => n === 1 ? { ok: true, envelope: { result: "draft" } } : { ok: false, interrupted: true, error: "the CLI was stopped by SIGTERM before it finished" });
  await b.turn();
  await assert.rejects(() => b.turn({ text: "[note]", keep: onethought.CODE_LINE, continueSession: true }), (e) => e.interrupted === true);
  assert.equal(b.calls.length, 2, "no second attempt");
});

test("the command line carries the session id, or the resume, and never both", () => {
  const fresh = cliInvocation({ prompt: "p", system: "s", mcpUrl: "http://127.0.0.1:9/mcp", sessionId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(fresh.args[fresh.args.indexOf("--session-id") + 1], "11111111-1111-4111-8111-111111111111");
  assert.equal(fresh.args.includes("--resume"), false);
  assert.equal(fresh.args.includes("--no-session-persistence"), false, "resume needs the session kept");
  const again = cliInvocation({ prompt: "p", system: "s", mcpUrl: "http://127.0.0.1:9/mcp", resume: "11111111-1111-4111-8111-111111111111" });
  assert.equal(again.args[again.args.indexOf("--resume") + 1], "11111111-1111-4111-8111-111111111111");
  assert.equal(again.args.includes("--session-id"), false);
  assert.ok(again.args.includes("--mcp-config"), "the tools ride along on the resumed run");
  const side = cliInvocation({ prompt: "q", system: "s", jsonSchema: { type: "object" } });
  assert.equal(side.args.includes("--session-id"), false);
});
