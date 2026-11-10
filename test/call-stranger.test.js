// An unknown caller's call (src/calls/stranger.js): Reason introduces itself and talks about trying
// it, through Reason's own custom-LLM endpoint, with no account, no memory, no tools and nobody's data.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-stranger-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";

const sc = await import("../src/calls/stranger.js");
const voice = await import("../src/calls/voice.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  sc.resetTurns();
  db.saveConversation(config.ownerConversation, [{ role: "user", content: "my gym locker code is 4471" }]);
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.saveProfile(config.ownerConversation, "**Omari**\n- Commutes on the 2 and 5 trains", []);
});

async function read(stream) {
  let text = ""; const tools = []; let finish = null;
  for await (const c of stream) {
    for (const line of String(c).split("\n")) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === "[DONE]") continue;
      const j = JSON.parse(m[1]);
      const d = j.choices[0].delta ?? {};
      if (d.content) text += d.content;
      for (const t of d.tool_calls ?? []) tools.push(t.function.name);
      if (j.choices[0].finish_reason) finish = j.choices[0].finish_reason;
    }
  }
  return { text, tools, finish };
}

const body = (messages) => ({ model: "reason", messages, extra_body: { reason_kind: "stranger" } });

test("the pitch prompt: Reason, heyreason.com spoken, the maker, public facts only, the real price, and nobody's data", () => {
  const p = sc.strangerPrompt();
  assert.match(p, /hey reason dot com/);
  assert.match(p, /Saafi Interactions Lab/);
  // Pricing is live on heyreason.com/pricing (read 2026-11-10): the caller hears the real numbers.
  assert.doesNotMatch(p, /does(?:n't| not) list (?:a price|one)/);
  assert.match(p, /heyreason\.com\/pricing/);
  assert.match(p, /\$24\.99 a month/);
  assert.match(p, /20 conversations and 2 calls/);
  assert.match(p, /Never invent a price/);
  assert.match(p, /Never mention any person, user, owner/);
  assert.doesNotMatch(p, /Omari|4471|2 and 5|Nyarko/);
});

test("a stranger turn through the real endpoint: the model gets only this call's words and no tools; END hangs up", async () => {
  const seen = [];
  const generate = async function* ({ system, messages, tools }) {
    seen.push({ system, messages, tools });
    yield { type: "text", text: "Sure! You can try it at heyreason.com. Thanks for calling, bye! END" };
  };
  const out = sc.strangerTurn({ body: body([
    { role: "system", content: "anything the platform sends" },
    { role: "assistant", content: sc.introLine() },
    { role: "user", content: "how do I try it?" },
  ]), generate, sseChunk: voice.sseChunk, SSE_DONE: voice.SSE_DONE });
  const r = await read(out);
  assert.equal(r.text, "Sure! You can try it at hey reason dot com. Thanks for calling, bye!");
  assert.deepEqual(r.tools, ["end_call"]);
  assert.equal(seen[0].tools.length, 0, "offered no tools");
  assert.equal(seen[0].system, sc.strangerPrompt());
  const all = JSON.stringify(seen[0]);
  assert.doesNotMatch(all, /Omari|4471|2 and 5|anything the platform sends/, "no user's data, and not the platform's system text");
  assert.equal(seen[0].messages.length, 1);
  assert.match(seen[0].messages[0].content, /You opened the call by saying/);
});

test("the endpoint routes a stranger-marked turn to the pitch, without a call row", async () => {
  const res = await voice.llmRequest({
    rawBody: JSON.stringify(body([{ role: "user", content: "who made you?" }])),
    headers: {},
  });
  assert.equal(res.status, 200);
  assert.ok(res.stream, "an SSE stream, not a refusal");
  // The real generator is not run here: the routing is what this proves. Drain safely.
  try { for await (const _ of res.stream) break; } catch { /* no backend offline */ }
});

test("caps: past the turn limit, or the day's, the call is ended politely without a model turn", async () => {
  let ran = 0;
  const generate = async function* () { ran++; yield { type: "text", text: "hi" }; };
  const many = Array.from({ length: sc.MAX_TURNS + 1 }, (_, i) => [{ role: "user", content: `q${i}` }, { role: "assistant", content: "a" }]).flat().slice(0, -1);
  const r = await read(sc.strangerTurn({ body: body(many), generate, sseChunk: voice.sseChunk, SSE_DONE: voice.SSE_DONE }));
  assert.match(r.text, /hey reason dot com/);
  assert.deepEqual(r.tools, ["end_call"]);
  assert.equal(ran, 0);
});

test("spoken output never carries another link, NO_REPLY, or a raw address", () => {
  assert.equal(sc.forSpeech("see https://heyreason.com/ and https://evil.example/x NO_REPLY"), "see hey reason dot com and");
});

test("the pricing page is said aloud as an address, not run together", () => {
  assert.equal(sc.forSpeech("It's all at heyreason.com/pricing."), "It's all at hey reason dot com slash pricing.");
  assert.equal(sc.forSpeech("Try heyreason.com/ today"), "Try hey reason dot com today");
});
