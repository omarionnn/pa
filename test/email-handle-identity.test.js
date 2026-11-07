// An address is a phone number or it is not one. normalizeNumber used to keep every digit of
// anything, so an Apple ID email or a SIP/client URI carrying somebody's digits collapsed into that
// person's number: "12025551234@attacker.example" was admitted as the operator (dm:owner), and an
// admitted user's digits put a stranger in that user's conversation. A handle that is not a phone
// number now normalizes to nothing and is kept as its own literal address.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-email-handle-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Owner";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TEST_NUMBERS = "";
process.env.SENDBLUE_API_KEY_ID = "";
process.env.SENDBLUE_API_SECRET_KEY = "";
process.env.SENDBLUE_FROM_NUMBER = "";
process.env.SENDBLUE_WEBHOOK_SECRET = "";

const { config, normalizeNumber, isOwnerNumber } = await import("../src/config.js");
const accounts = await import("../src/accounts.js");
const db = await import("../src/db.js");
const { SendblueChannel } = await import("../src/channels/sendblue.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => db.db.exec("DELETE FROM accounts; DELETE FROM blocked_numbers;"));

const USER = "+14155559876";

test("a phone number still normalizes the way it always did", () => {
  assert.equal(normalizeNumber("+1 (415) 555-9876"), USER);
  assert.equal(normalizeNumber("14155559876"), USER);
  assert.equal(normalizeNumber("tel:+14155559876"), USER);
  assert.equal(normalizeNumber("TEL:+14155559876"), USER);
  assert.equal(normalizeNumber("  +1 415 555 9876  "), USER);
  assert.equal(normalizeNumber("Mom: +1 415 555 9876"), USER, "a label before a number is not a scheme");
});

test("an email, SIP or client handle is not a number", () => {
  for (const h of ["14155559876@attacker.example", "omari12025551234@icloud.com", "sip:+12025551234@evil.example", "client:12025551234", "sips:12025551234@x", "14155559876\uFF20icloud.com", "14155559876%40icloud.com", " SIP:+12025551234"]) {
    assert.equal(normalizeNumber(h), "", h);
  }
  assert.equal(isOwnerNumber("12025551234@attacker.example"), false);
});

test("an Apple ID email with the operator's digits is not the operator", () => {
  const h = "12025551234@attacker.example";
  assert.equal(accounts.isOperatorAddress(h), false);
  const out = accounts.admit({ channel: "linq", address: h });
  assert.notEqual(out.conversationId, config.ownerConversation);
  assert.notEqual(out.isOperator, true);
  assert.equal(out.allow, false, "a stranger with no account is not let in");
});

test("an Apple ID email with an admitted user's digits does not land in their conversation", () => {
  db.upsertAccount({ conversationId: `dm:linq:${USER}`, channel: "linq", address: USER, name: "User" });
  assert.equal(accounts.admit({ channel: "linq", address: USER }).conversationId, `dm:linq:${USER}`);
  const out = accounts.admit({ channel: "linq", address: "14155559876@attacker.example" });
  assert.equal(out.allow, false);
  assert.notEqual(out.conversationId, `dm:linq:${USER}`);
  assert.notEqual(accounts.conversationIdFor({ channel: "linq", address: "14155559876@attacker.example" }), `dm:linq:${USER}`);
});

test("Sendblue drops an Apple ID email with digits in it, like any other email", async () => {
  config.sendblueKeyId = "k"; config.sendblueSecretKey = "s"; config.sendblueFrom = "+15122164639";
  config.sendblueWebhookSecret = "sec"; config.sendblueWebhookSecretHeader = "sb-signing-secret";
  try {
    const h = "12025551234@attacker.example";
    const out = await new SendblueChannel().receive({
      rawBody: JSON.stringify({ content: "hey", is_outbound: false, status: "RECEIVED", message_handle: "H-digits", number: h, from_number: h, to_number: "+15122164639", group_id: "", media_url: "", service: "iMessage" }),
      headers: { "sb-signing-secret": "sec", "content-type": "application/json" },
    });
    assert.deepEqual(out.inbound, []);
    assert.match(out.body.ignored, /email address/);
  } finally {
    config.sendblueKeyId = ""; config.sendblueSecretKey = ""; config.sendblueFrom = ""; config.sendblueWebhookSecret = "";
  }
});
