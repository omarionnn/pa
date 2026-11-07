// Audit lead 26: a yes to a text, a voice note or a call is pinned to the person AND to what reaches
// them. A yes for "text Kofi: running late" used to be pinned to Kofi's number only, so the same yes
// could carry any words to Kofi (or any call brief) for as long as it lasted. Offline: a fake channel
// and a fake call provider, a stub judge, no model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-person-pin-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.LINQ_API_KEY = "";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_CALL_MAX_MINUTES = "10";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876";
const PLACE = "+12125559999";
const C = config.ownerConversation;
const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });
const YES = async () => ({ verdict: "yes" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM permissions;");
});

function router() {
  const r = new Router({ runtime: new Runtime({ runTurn: async () => "ok" }) });
  const fake = r.register(new FakeChannel({ live: true }));
  return { r, fake };
}

/** The honest flow: the tool hands back what the yes is pinned to, that is asked, and it is granted. */
async function yesFor(action, input, ctx = {}) {
  const probe = await runTool(action, input, { conversationId: C, ...ctx });
  assert.equal(probe.blocked, "needs_confirmation", "nothing goes out before the yes");
  assert.ok(probe.use_target, "the refusal hands back what the yes will be pinned to");
  const asked = await runTool("confirm_request", { action, summary: `${action}: ${probe.use_target}`, target: probe.use_target, stakes: "third_party" },
    { conversationId: C, messages: [owner("go on")] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const granted = await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("go on"), owner("yes")], judge: YES });
  assert.equal(granted.state, "granted");
  return asked.confirmation_id;
}

test("a yes to one text cannot carry different words to the same person", async () => {
  const { r, fake } = router();
  const id = await yesFor("message_send", { to: KOFI, text: "Running late, there by 8. This is Omari's assistant, Reason." }, { channels: r });
  const other = await runTool("message_send", { to: KOFI, text: "Please send me the door code. This is Omari's assistant, Reason.", confirmation_id: id }, { conversationId: C, channels: r });
  assert.equal(other.ok, false, "different words on the same yes are refused");
  assert.equal(other.blocked, "wrong_target");
  assert.deepEqual(fake.sent, [], "nothing reached Kofi");
  const right = await runTool("message_send", { to: KOFI, text: "Running late, there by 8. This is Omari's assistant, Reason.", confirmation_id: id }, { conversationId: C, channels: r });
  assert.equal(right.ok, true, "the words they agreed to still go");
  assert.equal(fake.sent.length, 1);
});

test("a yes that only named the number cannot send anything", async () => {
  const { r, fake } = router();
  // The old shape of ask, pinned to the number alone, is not asked any more: the words are missing.
  const bare = await runTool("confirm_request", { action: "message_send", summary: "text Kofi: running late", target: KOFI, stakes: "third_party" },
    { conversationId: C, messages: [owner("text kofi")] });
  assert.equal(bare.ok, false, "a number alone does not say what the text says");
  assert.equal(bare.confirmation_id, undefined);
  // And a row like that from before this change (written straight through the gate) authorizes nothing.
  const trust = await import("../src/trust.js");
  const old = trust.requestConfirmation({ conversationId: C, messages: [owner("text kofi")], action: "message_send", summary: "text Kofi: running late", stakes: "third_party", target: KOFI });
  await runTool("confirm_record", { confirmation_id: old.confirmation_id }, { conversationId: C, messages: [owner("text kofi"), owner("yes")], judge: YES });
  const out = await runTool("message_send", { to: KOFI, text: "Anything at all. This is Omari's assistant, Reason.", confirmation_id: old.confirmation_id }, { conversationId: C, channels: r });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "wrong_target");
  assert.deepEqual(fake.sent, []);
});

test("a yes to one call brief cannot ring the same number with a different one", async () => {
  const calls = new FakeCallProvider();
  const brief = { to: PLACE, goal: "ask if they have a table for 4 at 8pm Saturday", facts: ["the name is Omari"] };
  const id = await yesFor("call_place", brief, { calls });
  const swapped = await runTool("call_place", { ...brief, goal: "ask them to read out the card on file", confirmation_id: id }, { conversationId: C, calls });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.blocked, "wrong_target");
  const more = await runTool("call_place", { ...brief, facts: ["the name is Omari", "his home address is 1 Main St"], confirmation_id: id }, { conversationId: C, calls });
  assert.equal(more.blocked, "wrong_target", "facts the yes never covered are a different call");
  const books = await runTool("call_place", { ...brief, may_book: true, max_price_cents: 50000, read_back: ["date"], confirmation_id: id }, { conversationId: C, calls });
  assert.equal(books.blocked, "wrong_target", "a yes to asking is not a yes to booking");
  assert.deepEqual(calls.placed, []);
  const right = await runTool("call_place", { ...brief, confirmation_id: id }, { conversationId: C, calls });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(calls.placed.length, 1);
});

test("a yes to one voice note cannot send a different file", async () => {
  const { r } = router();
  const id = await yesFor("voice_note_send", { to: KOFI, file: "/tmp/a.caf", text: "hey" }, { channels: r });
  const other = await runTool("voice_note_send", { to: KOFI, file: "/tmp/b.caf", text: "hey", confirmation_id: id }, { conversationId: C, channels: r });
  assert.equal(other.blocked, "wrong_target");
});

test("a yes to connect one account is not a yes to connect another", async () => {
  const id = await yesFor("account_connect", { name: "phone_out" });
  const other = await runTool("account_connect", { name: "github", confirmation_id: id }, { conversationId: C });
  assert.equal(other.ok, false);
  assert.equal(other.blocked, "wrong_target", "the yes named one provider");
  const none = await runTool("confirm_request", { action: "account_connect", summary: "connect it", stakes: "third_party" },
    { conversationId: C, messages: [owner("connect it")] });
  assert.equal(none.blocked, "ask_says_nothing", "an ask that names no account is not asked");
});

test("how the number is written in the ask is not a different person", async () => {
  const { r, fake } = router();
  const text = "Running late, there by 8. This is Omari's assistant, Reason.";
  const asked = await runTool("confirm_request", { action: "message_send", summary: `text Kofi: ${text}`, target: `+1 (415) 555-9876: ${text}`, stakes: "third_party" },
    { conversationId: C, messages: [owner("go on")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id }, { conversationId: C, messages: [owner("go on"), owner("yes")], judge: YES });
  const out = await runTool("message_send", { to: KOFI, text, confirmation_id: asked.confirmation_id }, { conversationId: C, channels: r });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(fake.sent.length, 1);
});
