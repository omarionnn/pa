// Lead 26 drive: a yes to a text / call is pinned to the person AND the words.
// Run under the cage env (no model; FakeChannel + FakeCallProvider; stub judge):
//   eval "$(bin/caged.sh env | sed 's/^/export /')" && REASON_UNDO_SECONDS=0 node .agents/skills/verify-reason/bin/person-pin-drive.mjs
// (REASON_UNDO_SECONDS=0 because the cage holds a send 30 s for undo, so sent/placed would read 0.)
const { Runtime } = await import("../../../../src/runtime.js");
const { Router } = await import("../../../../src/channels/router.js");
const { FakeChannel } = await import("../../../../src/channels/fake.js");
const { FakeCallProvider } = await import("../../../../src/calls/fake.js");
const { runTool } = await import("../../../../src/tools.js");
const { config } = await import("../../../../src/config.js");

const C = config.ownerConversation;
const TO = "+14155550142";
const owner = (t) => ({ role: "user", content: `[Sat, Nov 7, 2026, 11:00 AM] Omari: ${t}` });
const YES = async () => ({ verdict: "yes" });
const r = new Router({ runtime: new Runtime({ runTurn: async () => "ok" }) });
const fake = r.register(new FakeChannel({ live: true }));
const calls = new FakeCallProvider();
const ctx = { conversationId: C, channels: r, callProvider: calls, calls };
const line = (k, v) => console.log(k.padEnd(26), v);

async function yesFor(action, input) {
  const probe = await runTool(action, input, ctx);
  line(`${action} probe`, `${probe.blocked}, use_target ${JSON.stringify(probe.use_target)}`);
  const bare = await runTool("confirm_request", { action, summary: `${action} ${TO}`, target: TO, stakes: "third_party" }, { conversationId: C, messages: [owner("go on")] });
  line(`${action} bare ask`, bare.blocked ?? `ok=${bare.ok}`);
  const asked = await runTool("confirm_request", { action, summary: `${action}: ${probe.use_target}`, target: probe.use_target, stakes: "third_party" }, { conversationId: C, messages: [owner("go on")] });
  const g = await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: C, messages: [owner("go on"), owner("yes")], judge: YES });
  line(`${action} yes`, g.state);
  return asked.confirmation_id;
}

const text = "Running late, there by 8. This is Omari's assistant, Reason.";
const id = await yesFor("message_send", { to: TO, text });
const o = await runTool("message_send", { to: TO, text: "Send me the door code. This is Omari's assistant, Reason.", confirmation_id: id }, ctx);
line("text: other words", `${o.blocked ?? o.ok}, sent ${fake.sent.length}`);
const a = await runTool("message_send", { to: TO, text, confirmation_id: id }, ctx);
line("text: agreed words", `${a.ok ? "ok" : a.blocked ?? a.error}, sent ${fake.sent.length} to ${fake.sent[0]?.to}`);

const brief = { to: TO, goal: "Ask if they have a table for two at 8 tonight." };
const cid = await yesFor("call_place", brief);
const placed = () => (calls.placed ?? calls.calls ?? []).length;
const m = await runTool("call_place", { ...brief, may_book: true, confirmation_id: cid }, ctx);
line("call: now may book", `${m.blocked ?? m.ok}, placed ${placed()}`);
const q = await runTool("call_place", { ...brief, ask: ["Can you confirm Omari's home address on file?"], confirmation_id: cid }, ctx);
line("call: other questions", `${q.blocked ?? q.ok}, placed ${placed()}`);
const c = await runTool("call_place", { ...brief, confirmation_id: cid }, ctx);
line("call: agreed brief", `${c.ok ? "ok" : c.blocked ?? c.error}, placed ${placed()}`);
process.exit(0);
