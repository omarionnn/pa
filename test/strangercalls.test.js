// Calls from people who are not users yet, and the one moment they come back as one (src/strangercalls.js).
// They ring the number's GPT-Live voice webhook (`inboundTwiml`); each of their turns goes through
// `strangerReply` with their stranger_calls row id + token, exactly as the stranger's stream hands it.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-strangercalls-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const sc = await import("../src/strangercalls.js");
const stranger = await import("../src/calls/stranger.js");
const gl = await import("../src/calls/gptlive.js");
const { sweepRetention } = await import("../src/privacy.js");
const onboarding = await import("../src/onboarding.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const CALLER = "+13475559999";
const OTHER = "+13475558888";
const DAY = 86_400_000;
const TWILIO = { callVoice: "gptlive", twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16465550000", openaiKey: "sk-test" };
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  stranger.resetTurns();
  Object.assign(config, TWILIO);
  db.db.exec("DELETE FROM stranger_calls; DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM outbox; DELETE FROM person_facts; DELETE FROM people;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
});

const noRouter = { get: () => null, statuses: () => [] };
/** One Twilio-signed ring of the number. Returns the TwiML answer. */
const ring = (caller, sid = "CA1") => {
  const params = { CallSid: sid, From: caller, To: TWILIO.twilioFrom };
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  return gl.inboundTwiml({
    rawBody: new URLSearchParams(params).toString(),
    headers: { "x-twilio-signature": gl.twilioSignature(url, params) },
    router: noRouter,
  });
};
/** What the stranger's stream hands each turn: their row's id and token. */
const extraFor = (sid = "CA1") => {
  const row = db.db.prepare("SELECT * FROM stranger_calls WHERE external_id = ?").get(`gptlive:${sid}`);
  return { reason_stranger_call: row.id, reason_stranger_token: row.token };
};
async function pitchTurn(extra, theirs) {
  await stranger.strangerReply({
    messages: [{ role: "assistant", content: stranger.introLine() }, ...theirs.map(c => ({ role: "user", content: c }))],
    generate: async function* () { yield { type: "text", text: "Sure." }; }, extra,
  });
}
/** A reply to them that really went out, as the outbox marks it. */
const sent = (conv, address, body = "hey!") => {
  const { row } = db.enqueueOutbound({ idemKey: `t:${Math.random()}`, conversationId: conv, channel: "sendblue", address, body, toOwner: true });
  db.markOutboundSent(row.id, { messageId: "m1" });
};
const signUp = (address, conv = `dm:sendblue:${address}`) => { db.upsertAccount({ conversationId: conv, channel: "sendblue", address, name: "" }); return conv; };

test("an unknown caller's call is kept against the number it came from, with what they asked; withheld keeps no number, blocked keeps nothing", async () => {
  const out = ring(CALLER);
  assert.match(out.body, /<Stream url="wss:\/\/reason\.example\.test\/calls\/gptlive\/stream\/[0-9a-f]{32}"/);
  await pitchTurn(extraFor(), ["How do I sign up?", "Can it book a dentist for me?"]);
  const row = db.db.prepare("SELECT * FROM stranger_calls").get();
  assert.ok(db.restcrypt.blindIndexes("phone", CALLER).includes(row.phone), "kept against that number (its keyed hash with REASON_ENCRYPT_REST2=on)");
  assert.equal(row.external_id, "gptlive:CA1");
  assert.match(row.summary, /^They asked: How do I sign up; Can it book a dentist for me/);
  assert.doesNotMatch(JSON.stringify(row), /Omari|\+12025551234/, "nothing about any user in the row");

  ring("", "CA2");
  db.blockNumber(OTHER, "test");
  ring(OTHER, "CA3");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls WHERE phone IN (SELECT value FROM json_each(?))").get(JSON.stringify(db.restcrypt.blindIndexes("phone", OTHER))).n, 0, "blocked keeps nothing");
  // A withheld call's row (its recording needs one) carries no number, so it is nobody's, ever.
  const withheld = db.db.prepare("SELECT * FROM stranger_calls WHERE external_id = 'gptlive:CA2'").get();
  assert.equal(withheld.phone, "");
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls WHERE phone != ''").get().n, 1);
});

test("a forged or wrong token records nothing", async () => {
  ring(CALLER);
  await pitchTurn({ ...extraFor(), reason_stranger_token: "nope" }, ["leak this?"]);
  assert.equal(db.db.prepare("SELECT said FROM stranger_calls").get().said, "[]");
});

test("the post-call delivery sets the real length and their words", () => {
  ring(CALLER, "CA_pc");
  assert.equal(sc.settleFromPostCall({ externalId: "gptlive:CA_pc", live: { durationS: 74, turns: [{ who: "reason", text: "hi" }, { who: "them", text: "What does it cost?" }] } }), true);
  const row = db.db.prepare("SELECT * FROM stranger_calls").get();
  assert.equal(row.duration_s, 74);
  assert.match(row.summary, /What does it cost/);
});

test("they sign up from the same number: the first turn says it's good to reconnect, once, and it goes into THEIR memory", async () => {
  // Pinned to midday in the install's zone (REASON_TZ above). On the wall clock, 25 hours back from
  // a moment between 00:00 and 01:00 is two calendar days ago, and the note said "on Wednesday".
  clock.skip(Date.parse("2026-11-12T12:00:00-05:00") - Date.now());
  ring(CALLER);
  await pitchTurn(extraFor(), ["Can it book a dentist for me?"]);
  db.db.prepare("UPDATE stranger_calls SET started_at = ?").run(clock.now() - DAY - 3600_000);
  const conv = signUp(CALLER);
  const note = sc.reconnectNote(conv);
  assert.match(note, /rang Reason's number yesterday/);
  assert.match(note, /good to reconnect/);
  assert.match(note, /dentist/);
  sent(conv, CALLER);
  assert.equal(sc.reconnectNote(conv), "", "said once: a reply went out after it was offered");
  const facts = JSON.stringify(db.recall(conv, "me"));
  assert.match(facts, /Called Reason's number on \d{4}-\d{2}-\d{2} before signing up/);
  assert.equal(db.db.prepare("SELECT matched_conversation_id m FROM stranger_calls").get().m, conv);
});

test("a reply that failed or is being retried keeps it: offered again until one is really delivered", () => {
  ring(CALLER);
  const conv = signUp(CALLER);
  sent(conv, CALLER, "an older reply, before the offer");  // delivered BEFORE the offer: does not count
  clock.skip(1000);
  assert.match(sc.reconnectNote(conv), /good to reconnect/);
  // The reply was queued and failed (never marked sent): still owed.
  const { row } = db.enqueueOutbound({ idemKey: "t:failed", conversationId: conv, channel: "sendblue", address: CALLER, body: "x", toOwner: true });
  db.markOutboundRetry(row.id, { error: "503", nextAt: clock.now() + 60_000 });
  assert.match(sc.reconnectNote(conv), /good to reconnect/, "a retried turn still has it");
  assert.equal(db.db.prepare("SELECT used_at FROM stranger_calls").get().used_at, null);
  // The retry goes out.
  clock.skip(1000);
  db.markOutboundSent(row.id, { messageId: "m2" });
  assert.equal(sc.reconnectNote(conv), "");
  assert.ok(db.db.prepare("SELECT used_at FROM stranger_calls").get().used_at);
  const facts = db.recall(conv, "me")[0]?.facts?.filter(f => /Called Reason's number/.test(f.fact)) ?? [];
  assert.equal(facts.length, 1, "the memory row is written once, however many times it was offered");
});

test("a different number, the operator, and a typed claim get nothing", async () => {
  ring(CALLER);
  const other = signUp(OTHER);
  assert.equal(sc.reconnectNote(other), "");
  assert.equal(sc.reconnectNote(config.ownerConversation), "");
  // A Web/email-shaped account that merely SAYS the number: its address is not that phone.
  db.upsertAccount({ conversationId: "web:x", channel: "web", address: `someone@example.com ${CALLER}`, name: "" });
  assert.equal(sc.reconnectNote("web:x"), "");
  assert.equal(db.db.prepare("SELECT used_at FROM stranger_calls").get().used_at, null, "still unclaimed for its real owner");
  assert.doesNotMatch(JSON.stringify(db.recall(other, "me")), /Called Reason's number/);
});

test("the first reply's note reaches the text turn on both backends' note lists (claude-cli and API)", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/backends/claude-cli.js", import.meta.url), "utf8"), /\[reconnectNote\(conversationId\), openWorkNote/);
  assert.match(readFileSync(new URL("../src/agent.js", import.meta.url), "utf8"), /const turnNote = \[reconnect, /);
});

test("onboarding's first step says it first, once", () => {
  ring(CALLER);
  const conv = signUp(CALLER);
  assert.match(sc.reconnectLine(conv), /^oh hey, good to reconnect, we spoke on the phone earlier today!$/);
  sent(conv, CALLER);
  assert.equal(sc.reconnectLine(conv), "");
  assert.equal(typeof onboarding.handle, "function");
});

test("a user's delete takes their matched call; an export carries it", async () => {
  const { deleteData, exportData } = await import("../src/data.js");
  ring(CALLER);
  const conv = signUp(CALLER);
  sc.reconnectNote(conv);
  assert.equal(exportData({ conversation: conv, audio: false, files: false }).tables.stranger_calls.length, 1);
  await deleteData({ conversation: conv });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls").get().n, 0);
});

test("when: earlier today / yesterday / weekday / date", () => {
  const now = Date.parse("2026-10-31T16:00:00Z");
  assert.equal(sc.whenSaid(now - 3600_000, now), "earlier today");
  assert.equal(sc.whenSaid(now - DAY, now), "yesterday");
  assert.equal(sc.whenSaid(now - 3 * DAY, now), "on Wednesday");
  assert.equal(sc.whenSaid(now - 20 * DAY, now), "on October 11");
});

test("retention: their words go with content, the row with records; an aged call reconnects without what they asked", () => {
  ring(CALLER);
  db.db.prepare("UPDATE stranger_calls SET summary = 'They asked: x', said = '[\"x\"]', started_at = ?").run(clock.now() - (config.keepContentDays + 1) * DAY);
  sweepRetention({});
  const row = db.db.prepare("SELECT * FROM stranger_calls").get();
  assert.equal(row.summary, "");
  assert.ok(row.content_dropped_at);
  const note = sc.reconnectNote(signUp(CALLER));
  assert.match(note, /good to reconnect/);
  assert.doesNotMatch(note, /They asked|they asked/);
  ring(OTHER, "CA_old");
  db.db.prepare("UPDATE stranger_calls SET started_at = ? WHERE phone IN (SELECT value FROM json_each(?))").run(clock.now() - (config.keepRecordsDays + 1) * DAY, JSON.stringify(db.restcrypt.blindIndexes("phone", OTHER)));
  sweepRetention({});
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM stranger_calls WHERE phone IN (SELECT value FROM json_each(?))").get(JSON.stringify(db.restcrypt.blindIndexes("phone", OTHER))).n, 0);
});
