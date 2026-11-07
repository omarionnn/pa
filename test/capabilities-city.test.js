// Audit lead 24: the `capabilities` result named the operator's city (REASON_OWNER_CITY) in every
// conversation, labelled `city` beside the caller's own name. The system prompt (agent.js whoLine)
// keeps that city to the operator alone and tells everyone else's turn never to assume a city, so a
// non-operator turn that called capabilities was handed the operator's location and invited to take
// it as the user's. The city is the operator's only; nobody else's turn ever sees it.
//
// No model, no network: the real runTool against a temp database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-capcity-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_OWNER_CITY = "Testville";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { runTool } = await import("../src/tools.js");

const KOFI = "+14155559876";
const KOFI_ID = `dm:fake:${KOFI}`;

before(() => {
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_ID, channel: "fake", address: KOFI, name: "Kofi", isOperator: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("a non-operator's capabilities result never carries the operator's city", async () => {
  const out = await runTool("capabilities", {}, { conversationId: KOFI_ID });
  assert.equal(out.owner, "Kofi");
  assert.equal(out.city, undefined, "the operator's city reached another person's turn");
  assert.doesNotMatch(JSON.stringify(out), /Testville/);
});

test("a conversation with no account row is not the operator either", async () => {
  const out = await runTool("capabilities", {}, { conversationId: "dm:fake:+15550000009" });
  assert.equal(out.city, undefined);
  assert.doesNotMatch(JSON.stringify(out), /Testville/);
});

test("the operator still gets their own city", async () => {
  const out = await runTool("capabilities", {}, { conversationId: config.ownerConversation });
  assert.equal(out.owner, "Omari");
  assert.equal(out.city, "Testville");
});
