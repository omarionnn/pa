// A question sent back to a statement is counted, and only that.
//
//   does a reply that asks, to a message that did not, leave an asked_back row?     (yes)
//   does a reply that states leave nothing?                                          (yes)
//   does a reply to a QUESTION leave nothing, even when it asks back?                (yes)
//   does NO_REPLY, or a reply that never went out, leave nothing?                    (yes)
//   is a "?" inside a fenced block — a prompt they asked for — not Reason asking?     (yes)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-brief-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const db = await import("../src/db.js");
const brief = await import("../src/brief.js");
const { Runtime } = await import("../src/runtime.js");
const { clock } = await import("../src/config.js");

const C = "dm:owner";
const OWNER = "+12025551234";
const COMMUTE = "I leave at 3247 Bruner Ave I work at 430 w 17st on Thursday to Sunday from 8am to 8pm. I take the train. So update me on that";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations;"
    + " DELETE FROM inbound_messages; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

test("the detector: a question back to a statement, and nothing else", () => {
  assert.deepEqual(brief.askedBack({ text: COMMUTE, reply: "got it. what time do you usually leave the house?" }),
    { question: "what time do you usually leave the house?" });
  assert.deepEqual(brief.askedBack({ text: COMMUTE, reply: "Got it.\n\nWhich station do you get on at, and which line?" }),
    { question: "Which station do you get on at, and which line?" });
  // The reply the brief called for: route, leave time, first check. No "?" — nothing to note.
  assert.equal(brief.askedBack({ text: COMMUTE, reply: "from bruner ave it's the 5 to e 180, 2 to 14th, about 80 min. leave 6:20. first check thursday 5:45am." }), null);
  // They asked; a question in the answer is a conversation, not a miss.
  assert.equal(brief.askedBack({ text: "what's good for dinner near me?", reply: "ramen or tacos — which way are you leaning?" }), null);
  assert.equal(brief.askedBack({ text: COMMUTE, reply: "NO_REPLY" }), null);
  assert.equal(brief.askedBack({ text: COMMUTE, reply: "" }), null);
  assert.equal(brief.askedBack({ text: COMMUTE, reply: null }), null);
  // A "?" inside a fenced block is their paste, not Reason asking.
  assert.equal(brief.askedBack({ text: "write me a prompt for a cover letter", reply: "here you go\n```\nWhat makes you a fit for this role?\n```" }), null);
  assert.deepEqual(brief.askedBack({ text: "write me a prompt", reply: "```\nWhat?\n```\nwant it shorter?" }), { question: "want it shorter?" });
});

test("a question that went out to a statement is a ledger row; a plan is not", async () => {
  const rt = new Runtime({ runTurn: async () => "got it. what time do you usually leave the house?", deliver: async () => ({ ok: true }) });
  try {
    await rt.inbound(C, COMMUTE, { channel: "fake", to: OWNER, fromOwner: true });
  } finally { rt.stop(); }
  const rows = db.listActions(C).filter(a => a.action === "asked_back");
  assert.equal(rows.length, 1, JSON.stringify(db.listActions(C)));
  assert.equal(rows[0].outcome, "asked");
  const result = typeof rows[0].result === "string" ? JSON.parse(rows[0].result) : rows[0].result;
  assert.equal(result.question, "what time do you usually leave the house?");
  assert.match(rows[0].target, /^I leave at 3247 Bruner Ave/);
  assert.equal(rows[0].receipt, "asked back: what time do you usually leave the house?");

  db.db.exec("DELETE FROM action_ledger;");
  const rt2 = new Runtime({ runTurn: async () => "the 5 to e 180, 2 to 14th. leave 6:20. first check thursday 5:45am.", deliver: async () => ({ ok: true }) });
  try {
    await rt2.inbound(C, COMMUTE, { channel: "fake", to: OWNER, fromOwner: true });
  } finally { rt2.stop(); }
  assert.equal(db.listActions(C).filter(a => a.action === "asked_back").length, 0);
});

test("a question that never went out is not counted, and neither is one answering a question", async () => {
  const rt = new Runtime({ runTurn: async () => "which station?", deliver: async () => ({ ok: false, error: "line down" }) });
  try {
    await rt.inbound(C, COMMUTE, { channel: "fake", to: OWNER, fromOwner: true });
  } finally { rt.stop(); }
  assert.equal(db.listActions(C).filter(a => a.action === "asked_back").length, 0, "nothing was heard, so nothing was asked");

  const rt2 = new Runtime({ runTurn: async () => "the 5 or the 2 — which do you take?", deliver: async () => ({ ok: true }) });
  try {
    await rt2.inbound(C, "which train should i take tomorrow?", { channel: "fake", to: OWNER, fromOwner: true });
  } finally { rt2.stop(); }
  assert.equal(db.listActions(C).filter(a => a.action === "asked_back").length, 0, "they asked first");
});
