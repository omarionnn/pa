// Fewer yes-checks and nags (the 7-day review, owner-approved plan, 2026-11-06). One test group per item:
//
//   1. a clear, low-risk call is placed without "plain yes before I dial"; money, people they know and
//      Reason-started turns still ask
//   2. (src/calls/verify.js — test/call-addendum.test.js) no "reply yes" text during a live call
//   3. at most one "btw" aside per person per day, across every kind
//   4. ops notices go into one daily digest; only emergencies are live
//   5. the Web line never before their third day
//   6. the Google consent line speaks to them ("your mail")
//   7. the owner may ask about Reason's own code
//
// The model's reading in (1) is stubbed here (`askedCallJudge`): nothing in this file reaches a model.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-fewer-gates-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_UNDO_SECONDS = "0";

const { runTool } = await import("../src/tools.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");
const askedCall = await import("../src/askedcall.js");
const aside = await import("../src/aside.js");
const whatsnew = await import("../src/whatsnew.js");
const notice = await import("../src/notice.js");
const digest = await import("../src/opsdigest.js");
const incidents = await import("../src/incidents.js");
const ops = await import("../src/ops.js");
const deliverLib = await import("../src/deliver.js");
const { systemFor } = await import("../src/agent.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
const SHOP = "+12125550188";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Put the clock at an exact instant. */
const setClock = (ms) => { clock.reset(); clock.skip(ms - Date.now()); };

after(() => { incidents.stop(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clock.reset();
  askedCall.forgetVerdicts();
  db.db.exec(`DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads;
    DELETE FROM ops_state; DELETE FROM ops_digest; DELETE FROM whats_new_told; DELETE FROM ops_checks; DELETE FROM incidents; DELETE FROM important_people;`);
});

const owner = (t) => ({ role: "user", content: `[Thu, Nov 5, 2026, 7:07 PM] Omari: ${t}` });
/** A stand-in for the side model: says what it was told to, and counts how often it was asked. */
function judge(value) {
  const asked = [];
  return { asked, ask: async (args) => { asked.push(args); return { value }; } };
}
const CLEAR = { asked: "yes", callee: "business", only_asks: "yes" };
const HOURS = { to: SHOP, goal: "ask what time they close tonight", facts: [] };

// ---------- 1. a clear, low-risk call ----------

test("1. 'call joe's pizza and ask when they close': placed straight away, no yes asked, the request on the receipt", async () => {
  const calls = new FakeCallProvider();
  const j = judge(CLEAR);
  const out = await runTool("call_place", HOURS, {
    conversationId: C, calls, kind: "user", askedCallJudge: j.ask,
    messages: [owner("call joe's pizza on 2nd ave and ask what time they close tonight")],
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.call_id > 0);
  assert.equal(out.under_permission.asked_for_call, true);
  assert.match(out.permission_note, /Do not ask them to confirm it/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM confirmations").get().n, 0, "nothing was asked");
  assert.equal(j.asked.length, 1);
  // The side model sees their own words and the call, nothing else.
  assert.match(j.asked[0].prompt, /ask what time they close tonight/);
  assert.match(j.asked[0].prompt, /joe's pizza/);
});

test("1. confirm_request for that same call answers 'not needed', and call_place reuses the one reading", async () => {
  const calls = new FakeCallProvider();
  const j = judge(CLEAR);
  const ctx = { conversationId: C, calls, kind: "user", askedCallJudge: j.ask, messages: [owner("call the pharmacy at 212-555-0188 and ask if they're open til 9")] };
  const asked = await runTool("confirm_request", { action: "call_place", stakes: "third_party", target: SHOP, summary: "ask what time they close tonight" }, ctx);
  assert.equal(asked.not_needed, true, JSON.stringify(asked));
  assert.match(asked.note, /no confirmation_id/);
  const placed = await runTool("call_place", HOURS, ctx);
  assert.equal(placed.ok, true, JSON.stringify(placed));
  assert.equal(j.asked.length, 1, "one reading per message and number");
});

test("1. still asked: a call that could book or spend, a person they know, a turn Reason started, an unclear request", async () => {
  const calls = new FakeCallProvider();
  const msgs = [owner("call joe's pizza and book us a table for 4 at 8")];
  // Could agree to something: the side model is never even asked.
  const j = judge(CLEAR);
  const book = await runTool("call_place", { ...HOURS, may_book: true, read_back: ["date", "time"] }, { conversationId: C, calls, kind: "user", askedCallJudge: j.ask, messages: msgs });
  assert.equal(book.blocked, "needs_confirmation");
  const priced = await runTool("call_place", { ...HOURS, max_price_cents: 5000 }, { conversationId: C, calls, kind: "user", askedCallJudge: j.ask, messages: msgs });
  assert.equal(priced.blocked, "needs_confirmation");
  assert.equal(j.asked.length, 0);

  // Somebody they know, read off their people list — code's answer, whatever the model thought.
  db.addImportantPerson(C, { who: "Mum", contact: SHOP });
  const mum = await runTool("call_place", HOURS, { conversationId: C, calls, kind: "user", askedCallJudge: j.ask, messages: [owner("call mum and ask when she's free")] });
  assert.equal(mum.blocked, "needs_confirmation");
  db.db.exec("DELETE FROM important_people");

  // A turn nobody asked for (a timer, a sweep, a task wake).
  const event = await runTool("call_place", HOURS, { conversationId: C, calls, kind: "event", askedCallJudge: j.ask, messages: msgs });
  assert.equal(event.blocked, "needs_confirmation");

  // The model reads it as anything short of a clear yes on all three.
  for (const v of [{ ...CLEAR, asked: "unclear" }, { ...CLEAR, callee: "person" }, { ...CLEAR, only_asks: "no" }, null]) {
    askedCall.forgetVerdicts();
    const out = await runTool("call_place", HOURS, { conversationId: C, calls, kind: "user", askedCallJudge: judge(v).ask, messages: [owner("maybe see if they're open later?")] });
    assert.equal(out.blocked, "needs_confirmation", JSON.stringify(v));
  }
  // A side model that throws is a no, never a yes.
  askedCall.forgetVerdicts();
  const boom = await runTool("call_place", HOURS, { conversationId: C, calls, kind: "user", askedCallJudge: async () => { throw new Error("down"); }, messages: msgs });
  assert.equal(boom.blocked, "needs_confirmation");
  assert.equal(calls.placed?.length ?? 0, 0, "nothing dialled in any of these");
});

test("1. texting somebody new is untouched: still gated however clearly it was asked", async () => {
  const j = judge(CLEAR);
  const out = await runTool("message_send", { to: SHOP, text: "Hello, this is Omari's assistant, Reason." }, {
    conversationId: C, kind: "user", askedCallJudge: j.ask, messages: [owner("text joe's pizza and ask if they cater")],
  });
  assert.notEqual(out.ok, true);
  assert.equal(j.asked.length, 0);
});

test("1. the prompt says it: a clear ask-only call to a business is placed without a second yes", () => {
  const s = systemFor({ name: "Omari", isOperator: true });
  assert.match(s, /A call they plainly asked for, to a business, only to ask, needs no second yes/);
});

// ---------- 3. one aside a day ----------

test("3. at most one aside per turn — the held catch wins — and none once today's is spent", () => {
  assert.deepEqual(aside.onlyOne(C, ["held", "miss", "new"]), ["held", "", ""]);
  assert.deepEqual(aside.onlyOne(C, ["", "miss", "new"]), ["", "miss", ""]);
  aside.spend(C);
  assert.deepEqual(aside.onlyOne(C, ["held", "miss", "new"]), ["", "", ""]);
  // Tomorrow is a new day.
  clock.skip(DAY);
  assert.deepEqual(aside.onlyOne(C, ["", "", "new"]), ["", "", "new"]);
});

test("3. a new-feature line told today spends the day for every other kind of aside", () => {
  db.db.prepare("INSERT INTO whats_new_told (conversation_id, entry_id, claimed_at, told_at) VALUES (?, ?, ?, ?)").run(C, "x", clock.now(), clock.now());
  assert.equal(aside.spentToday(C), true);
  assert.equal(whatsnew.resolvedMissNote({ conversationId: C }), "");
});

test("3. a catch said on the end of THEIR reply spends the day; one sent on Reason's own turn does not", async () => {
  // notice_send's own gate is not under test here: only the bookkeeping after it.
  const before = aside.spentToday(C);
  assert.equal(before, false);
  await runTool("cant_do_resolved", { id: 999999 }, { conversationId: C, kind: "user" });
  assert.equal(aside.spentToday(C), false, "nothing resolved, nothing said");
  const id = db.recordCapabilityMiss({ conversationId: C, capability: "gmail", summary: "read my mail" });
  await runTool("cant_do_resolved", { id }, { conversationId: C, kind: "event" });
  assert.equal(aside.spentToday(C), false, "an event turn is not a reply of theirs");
  const id2 = db.recordCapabilityMiss({ conversationId: C, capability: "gmail", summary: "read my mail" });
  await runTool("cant_do_resolved", { id: id2 }, { conversationId: C, kind: "user" });
  assert.equal(aside.spentToday(C), true);
});

test("3. every aside note carries the same rule: only when it bears on what they are talking about", () => {
  const held = notice.heldNote({ conversationId: C, held: [{ key: "k", what: "your dentist moved to 4", first_seen: clock.now() }] });
  assert.ok(held.includes(aside.RELATED));
  assert.match(aside.RELATED, /Unrelated to what they just said\? Leave it out/);
});

// ---------- 4. the daily digest ----------

test("4. a non-urgent incident is held for the digest; an outage-shaped one is still texted live", () => {
  const texts = [];
  incidents.start({ send: (text) => { texts.push(text); } });
  incidents.raise({ key: "timer:gave_up", area: "reminders", what: "a reminder was given up on" });
  assert.equal(texts.length, 0);
  assert.equal(digest.pending().length, 1);
  incidents.raise({ key: "send:sendblue:x", area: "messaging", what: "texts over sendblue are failing" });
  assert.equal(texts.length, 1);
  assert.match(texts[0], /texts over sendblue are failing/);
  incidents.stop();
});

test("4. which status checks are emergencies: Reason down, a provider down, a spending cap — nothing else", () => {
  assert.equal(digest.checkIsUrgent({ id: "process", group: "alive", state: "bad" }), true);
  assert.equal(digest.checkIsUrgent({ id: "outbox", group: "alive", state: "warn" }), false);
  assert.equal(digest.checkIsUrgent({ id: "provider:openai", group: "services", state: "warn" }), true);
  assert.equal(digest.checkIsUrgent({ id: "spend", group: "money", state: "warn" }), true);
  assert.equal(digest.checkIsUrgent({ id: "api_spend", group: "money", state: "warn" }), true);
  assert.equal(digest.checkIsUrgent({ id: "access", group: "people", state: "warn" }), false);
  assert.equal(digest.checkIsUrgent({ id: "extraction", group: "memory", state: "bad" }), false);
  assert.equal(digest.checkIsUrgent({ id: "misses", group: "quality", state: "bad" }), false);
});

test("4. the digest goes once a day, after the digest hour, as one message, and only with something in it", async () => {
  // 07:00 in New York.
  setClock(Date.parse("2026-11-06T12:00:00Z"));
  const sent = [];
  const send = async (text, key) => { sent.push({ text, key }); };
  assert.equal(await digest.flush({ send }), null, "nothing held");
  digest.hold({ text: "somebody new texted", key: "new-contact:a" });
  digest.hold({ text: "an event was made\nits page: x", key: "event:1" });
  digest.hold({ text: "an event was made — updated", key: "event:1" });
  assert.equal(await digest.flush({ send }), null, "before the digest hour");
  setClock(Date.parse("2026-11-06T14:30:00Z")); // 09:30
  const text = await digest.flush({ send, link: "https://status" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].key, /^ops:digest:2026-11-06$/);
  assert.match(text, /^Reason daily digest — 2 things/);
  assert.match(text, /• somebody new texted/);
  assert.match(text, /• an event was made — updated/, "the latest word under one key");
  assert.doesNotMatch(text, /its page: x/);
  digest.hold({ text: "another", key: "x" });
  assert.equal(await digest.flush({ send }), null, "once a day");
  setClock(Date.parse("2026-11-07T14:30:00Z"));
  await digest.flush({ send });
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /• another/);
});

test("4. the five-minute pass: a non-urgent check goes to the digest, a provider outage is live, and its all-clear follows it", async () => {
  const said = [];
  const runtime = { say: (_c, text) => said.push(text), interval: 1, lastSweepAt: clock.now() };
  const t = clock.now();
  const report = (checks) => ({ at: clock.now(), verdict: "warn", checks });
  ops.settle({ report: report([{ id: "extraction", group: "memory", label: "Memory", state: "bad", detail: "stuck" }, { id: "provider:openai", group: "services", label: "OpenAI", state: "warn", detail: "timeout" }]), runtime });
  setClock(t + 5 * MIN);
  ops.settle({ report: report([{ id: "extraction", group: "memory", label: "Memory", state: "bad", detail: "stuck" }, { id: "provider:openai", group: "services", label: "OpenAI", state: "warn", detail: "timeout" }]), runtime });
  assert.equal(said.length, 1);
  assert.match(said[0], /OpenAI/);
  assert.doesNotMatch(said[0], /Memory/);
  assert.match(digest.pending().map(r => r.text).join("\n"), /Memory: stuck/);
  setClock(t + 10 * MIN);
  ops.settle({ report: report([{ id: "extraction", group: "memory", label: "Memory", state: "ok", detail: "" }, { id: "provider:openai", group: "services", label: "OpenAI", state: "ok", detail: "" }]), runtime });
  assert.equal(said.length, 2);
  assert.match(said[1], /back to normal: OpenAI/);
  assert.match(digest.pending().map(r => r.text).join("\n"), /Memory is back to normal/, "the digest line ends where it ended");
});

// ---------- 5. the Web line ----------

test("5. the Web line never rides on day 1 or 2 of an account, and can from day 3", () => {
  const ADDR = "+13125550101";
  const conv = `dm:${ADDR}`;
  db.upsertAccount({ conversationId: conv, channel: "sendblue", address: ADDR, name: "Ama" });
  // Made 'now'.
  assert.equal(deliverLib.accountDay(conv), 1);
  clock.skip(DAY);
  assert.equal(deliverLib.accountDay(conv), 2);
  clock.skip(DAY);
  assert.equal(deliverLib.accountDay(conv), 3);
  assert.equal(deliverLib.WEB_HINT_FROM_DAY, 3);
  assert.equal(deliverLib.accountDay("dm:nobody"), Infinity, "no account row: long-standing");
});

// ---------- 6. second-person consent: test/drive.test.js ("the consent line speaks to them") ----------

// ---------- 7. the owner and Reason's own code ----------

test("7. the owner may ask how Reason's own code works; nobody else is told about it", () => {
  const mine = systemFor({ name: "Omari", isOperator: true });
  assert.match(mine, /Omari may ask how Reason's own code works: explain it/);
  assert.doesNotMatch(mine, /If asked, say plainly that you don't do code/);
  const theirs = systemFor({ name: "Ama", isOperator: false });
  assert.doesNotMatch(theirs, /Reason's own code/);
  assert.doesNotMatch(theirs, /Omari/);
  // Running code is still refused for everybody.
  assert.match(theirs, /Running code is not your job/);
});
