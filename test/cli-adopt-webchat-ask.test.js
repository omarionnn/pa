// One shared thread only (owner 10-27 07:08). An approval left open in an earlier Web-only chat is
// adopted by the shared thread on the claude-cli turn that first sees it — counted WITH that turn's
// own message, so a "yes" texted about something else on that turn is never read as its answer.
// Found by the review of the retirement PR: counting only the history before the message let the
// very message that adopted the ask grant it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-cli-adopt-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const db = await import("../src/db.js");
const trust = await import("../src/trust.js");
const { runTurnViaCli } = await import("../src/backends/claude-cli.js");

const C = "dm:owner";
const CHAT = "OldChatAAAAAAAAAAAAAAA";
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
db.saveConversation(C, [{ role: "user", content: "[imessage] Omari: dinner at 8?" }, { role: "assistant", content: "done." }]);

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("the turn that adopts an old chat's ask can't be its yes; the next reply can", async () => {
  const c = db.askConfirmation({ conversationId: C, action: "buy", summary: "Buy the $300 headphones", stakes: "money", askedAfterMsgs: 0, threadKey: `${C}#web:${CHAT}` });
  let prompt = "";
  await runTurnViaCli({
    conversationId: C,
    text: "yes, go ahead",
    startMcp: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
    images: async () => ({ blocks: [], notes: [], seen: [], viewedMediaIds: [] }),
    run: async (opts) => { prompt = JSON.stringify(opts); return { ok: true, envelope: { result: "which one?" } }; },
  });
  const row = db.getConfirmation(C, c.id);
  assert.equal(row.thread_key, null, "the shared thread adopted it");
  assert.match(prompt, new RegExp(`confirmation #${c.id}`), "and lists it as waiting");

  const judge = async () => ({ verdict: "yes" });
  const now = await trust.recordConfirmation({ conversationId: C, messages: db.loadConversation(C), confirmationId: c.id, judge });
  assert.equal(now.state, "waiting_for_yes", "the message that adopted it is not its answer");

  const later = [...db.loadConversation(C), { role: "user", content: "[imessage] Omari: yes, buy the headphones" }];
  const granted = await trust.recordConfirmation({ conversationId: C, messages: later, confirmationId: c.id, judge });
  assert.equal(granted.state, "granted");
});
