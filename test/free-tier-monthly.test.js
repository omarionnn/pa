// The monthly free tier (src/plan.js, REASON_FREE_TIER=monthly; owner's decisions 2026-11-09):
//
//   people who came in on their own get 20 conversations + 2 calls (5 minutes each) a month, from the
//   day they first texted; $24.99 is unlimited
//   the 20th conversation runs to its end; the 21st's first text gets ONE line + the link, no model
//   turn; anything else in that conversation is left; the month turning restores everything
//   over the 20 or the 2 calls, a call in hears one line, hangs up, and the link is texted
//   call_place past the 2 calls is refused with the line + link; a free call wraps at 5:00, ends at 6:00
//   trial users get no invites; an invite or event from a non-free-for-good member makes nobody free
//   auto-admit lets ~30 an hour in; past that a new number gets the access-list text and is queued
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-freetier-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_TOKEN_KEY = "55".repeat(32);
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PAYWALL = "on";
process.env.REASON_FREE_TIER = "monthly";
process.env.REASON_PAYWALL_SHIP_TS = "2026-10-31T00:00:00Z";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_PRICE_ID = "price_test_2499";
process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.test/reason";

const plan = await import("../src/plan.js");
const accounts = await import("../src/accounts.js");
const access = await import("../src/access.js");
const { runTool, toolsFor, invitesOpenFor } = await import("../src/tools.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const gl = await import("../src/calls/gptlive.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OMARI = "dm:owner";
const MASTER = "+12025551234";
const NUMBER = "+16465550000";
const MIN = 60_000;
let n = 0;
const newNumber = () => `+1347444${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.autoAdmit = true;
  config.signupsPerHour = 30;
  db.db.exec("DELETE FROM accounts; DELETE FROM plan; DELETE FROM usage; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM calls; DELETE FROM access_requests; DELETE FROM events;");
  db.upsertAccount({ conversationId: OMARI, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function newcomer(name = "Ama") {
  const num = newNumber();
  const c = conv(num);
  db.upsertAccount({ conversationId: c, channel: "fake", address: num, name, isOperator: false });
  return { c, num };
}
/** `k` conversations, 31 minutes apart, through the real countUse path. */
function conversations(c, k) {
  for (let i = 0; i < k; i++) { if (i || plan.row(c)) clock.skip(31 * MIN); accounts.countUse(c, "turn"); }
}
function fakeRouter() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { ok: true }; } };
}
const noSleep = async () => {};

// ---------------------------------------------------------------- what "a conversation" is, and the month

test("a conversation = the 30-minute session; 20 a month; the month runs from the day they first texted", () => {
  const { c } = newcomer();
  accounts.countUse(c, "turn");
  clock.skip(29 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).sessions_used, 1, "29 minutes later is the same conversation");
  conversations(c, 19);
  const st = plan.status(c);
  assert.equal(st.status, "trial");
  assert.equal(st.monthly, true);
  assert.equal(st.sessions_used, 20);
  assert.equal(st.left, 0);
  assert.equal(st.calls_left, 2);
  assert.equal(st.resets_at, plan.addMonths(plan.row(c).first_seen_at, 1));
  assert.match(plan.note(c), /last free conversation this month/);
  assert.match(plan.opsLabel(c), /^free 20\/20 · calls 0\/2$/);
  // Soft: more texts inside the 20th conversation are still that conversation.
  clock.skip(10 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).status, "trial");
  // The 21st conversation: over.
  clock.skip(31 * MIN); accounts.countUse(c, "turn");
  assert.equal(plan.status(c).status, "lapsed");
  assert.ok(plan.blocked(c), "Reason starts nothing for them while over");
});

test("the month turning gives the 20 and the 2 calls back, with nothing to undo", () => {
  const { c } = newcomer();
  conversations(c, 21);
  plan.noteCall(c); plan.noteCall(c);
  assert.equal(plan.status(c).status, "lapsed");
  const resets = plan.status(c).resets_at;
  clock.skip(resets + MIN - clock.now());
  assert.equal(plan.status(c).status, "trial", "read as a new month before they even text");
  assert.equal(plan.status(c).sessions_used, 0);
  assert.equal(plan.status(c).calls_left, 2);
  accounts.countUse(c, "turn");
  assert.equal(plan.status(c).sessions_used, 1);
  assert.equal(plan.row(c).period_calls, 0);
  assert.ok(!plan.blocked(c));
});

test("month ends clamp: first texted Jan 31 → the next month starts Feb 28, then Mar 31", () => {
  const a = Date.UTC(2027, 0, 31, 15);
  assert.equal(new Date(plan.periodOf(a, Date.UTC(2027, 1, 27)).end).toISOString(), "2027-02-28T15:00:00.000Z");
  const p = plan.periodOf(a, Date.UTC(2027, 2, 5));
  assert.equal(new Date(p.start).toISOString(), "2027-02-28T15:00:00.000Z");
  assert.equal(new Date(p.end).toISOString(), "2027-03-31T15:00:00.000Z");
});

// ---------------------------------------------------------------- over the 20, down the real router

test("over the 20: the 21st conversation gets ONE line + the link and no model turn; the rest of it is left", async () => {
  const num = newNumber();
  const c = conv(num);
  const turns = [];
  const runtime = new Runtime({ runTurn: async ({ text: t }) => { turns.push(t); return "on it"; } });
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }) });
  const channel = router.register(new FakeChannel({ number: "+16562167455" }));
  runtime.turnExtras.channels = router;
  const text = (body) => ({ channel: "fake", externalId: `m${Math.random()}`, from: num, text: body, at: clock.now() });
  await router.deliver(text("hey"));
  for (let i = 1; i < 20; i++) { clock.skip(31 * MIN); await router.deliver(text(`msg ${i}`)); }
  clock.skip(5 * MIN); await router.deliver(text("one more in the 20th"));
  assert.equal(turns.length, 21, "all 20 conversations answered, the 20th to its end");
  const before = channel.sent.length;

  clock.skip(31 * MIN);
  await router.deliver(text("can you find me a dentist"));
  assert.equal(turns.length, 21, "no model turn for the 21st conversation");
  const out = channel.sent.slice(before).filter(m => m.to === num).map(m => m.text);
  assert.equal(out.length, 3, JSON.stringify(out));
  const resets = plan.when(plan.status(c).resets_at, c);
  const name = db.getAccount(c)?.name ? `, ${String(db.getAccount(c).name).split(/\s+/)[0]}` : "";
  assert.equal(out[0], `that's 20 conversations between us${name}. i haven't pulled off something real for you yet, and i'd like the chance to.`);
  assert.equal(out[1], `the free ones come back ${resets}. or it's $24.99 a month for unlimited texts and calls. everything stays exactly as it is, what i remember, your reminders, all of it, and you can cancel any time just by telling me.`);
  assert.match(out[2], /^https:\/\/buy\.stripe\.test\/reason\?client_reference_id=/);
  assert.ok(!/unlock|upgrade|trial/i.test(out.join(" ")));

  // Same conversation, another text: nothing at all.
  clock.skip(2 * MIN); await router.deliver(text("hello??"));
  assert.equal(turns.length, 21);
  assert.equal(channel.sent.slice(before).filter(m => m.to === num).length, 3, "said once a conversation");
  // Their texts are kept, so the turn after they pay knows what they asked.
  assert.match(JSON.stringify(db.loadConversation(c)), /find me a dentist/);

  // A new conversation while still over: the line once more.
  clock.skip(31 * MIN); await router.deliver(text("hi again"));
  assert.equal(turns.length, 21);
  assert.equal(channel.sent.slice(before).filter(m => m.to === num).length, 6);

  // Paid: unlimited, the turn runs again.
  await plan.markPaid(c, { customerId: "cus_1", subscriptionId: "sub_1" });
  clock.skip(31 * MIN); await router.deliver(text("ok paid"));
  assert.equal(turns.length, 22);
});

test("the operator, a pre-flip account and a payer are never counted against the 20", async () => {
  const old = conv(newNumber());
  db.upsertAccount({ conversationId: old, channel: "fake", address: "+13474449999", name: "Old", isOperator: false });
  db.db.prepare("UPDATE accounts SET created_at = 1 WHERE conversation_id = ?").run(old);
  const { c: payer } = newcomer("Payer");
  await plan.markPaid(payer, { customerId: "cus_2", subscriptionId: "sub_2" });
  for (const c of [OMARI, old, payer]) {
    conversations(c, 25);
    assert.notEqual(plan.status(c).status, "lapsed", c);
    assert.equal(await plan.overTextReply(c), null, c);
    assert.equal(plan.callGate(c), null, c);
    assert.equal(plan.callLimitSeconds(c), null, c);
  }
});

// ---------------------------------------------------------------- calls

const TWILIO = { callVoice: "gptlive", twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: NUMBER, openaiKey: "sk-test" };
let sids = 0;
const ring = (from, via) => {
  Object.assign(config, TWILIO);
  const params = { CallSid: `CA${++sids}`, From: from, To: NUMBER };
  const url = `${config.publicUrl}${gl.INBOUND_PATH}`;
  return gl.inboundTwiml({ rawBody: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": gl.twilioSignature(url, params) }, router: via });
};
const liveRouter = () => {
  const sent = [];
  return {
    sent,
    get: (name) => (name === "fake" ? { status: () => ({ status: "live" }) } : null),
    statuses: () => [{ name: "fake", status: "live" }],
    send: async (m) => { sent.push(m); return { ok: true }; },
  };
};
// The link's bubbles go out a beat apart (config.onboardingGapMs + up to 600 ms): wait for them.
const tick = async (via, num, want = 2) => {
  for (let t = 0; t < 150; t++) {
    if (via && via.sent.filter(m => m.to === num).length >= want) break;
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 20));
};

test("2 calls a month: the 3rd call in hears one line, the line closes, and the link is texted", async () => {
  const { c, num } = newcomer("Kofi");
  accounts.countUse(c, "turn");
  const via = liveRouter();
  for (let i = 0; i < 2; i++) {
    const out = ring(num, via);
    assert.match(out.body, /<Connect><Stream/, `call ${i + 1} goes through`);
  }
  assert.equal(plan.status(c).calls_used, 2);
  const third = ring(num, via);
  assert.doesNotMatch(third.body, /<Stream/);
  assert.match(third.body, /<Say[^>]*>hey Kofi, it's Reason\. that's both free calls this month, so i can't stay on\. i'm texting you the link right now\. talk soon\.<\/Say><Hangup\/>/);
  await tick(via, num);
  const texts = via.sent.filter(m => m.to === num).map(m => m.text);
  assert.equal(texts.length, 2, JSON.stringify(texts));
  assert.match(texts[0], /^here's that link\. \$24\.99 a month for unlimited texts and calls, cancel any time by texting me\. otherwise your 2 calls come back [A-Z][a-z]{2} \d{1,2}\.$/);
  assert.match(texts[1], /^https:\/\/buy\.stripe\.test\/reason\?client_reference_id=/);
  // A 4th ring the same day: the line again, but the link is not texted twice.
  ring(num, via); await tick(via, num, 3);
  assert.equal(via.sent.filter(m => m.to === num).length, 2);
});

test("over the 20 texts, a call in is refused the same way (conversations line)", async () => {
  const { c, num } = newcomer();
  conversations(c, 21);
  const via = liveRouter();
  const out = ring(num, via);
  assert.match(out.body, /it's Reason\. that's all 20 free conversations this month, so i can't stay on/);
  assert.match(out.body, /<Hangup\/>/);
  await tick(via, num, 2);
  assert.match(via.sent.find(m => m.to === num)?.text ?? "", /otherwise your 20 conversations come back /);
});

test("a free call: wrap-up cue at 4:30, the line closed at 5:00; an errand call and a payer's call have no such limit", async () => {
  const { c } = newcomer();
  accounts.countUse(c, "turn");
  Object.assign(config, TWILIO);
  const start = (conversationId, isOwner = true) => {
    let t = 1_000_000; let q = []; let id = 0;
    const timers = { now: () => t, setTimeout: (fn, ms) => { q.push({ id: ++id, at: t + ms, fn }); return id; }, clearTimeout: (x) => { q = q.filter(e => e.id !== x); },
      async advance(ms) { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const nx = q[0]; if (!nx || nx.at > end) break; q.shift(); t = nx.at; nx.fn(); await new Promise(r => setImmediate(r)); } t = end; } };
    const row = db.createCall(conversationId, { provider: "gptlive", toNumber: "+13470000000", isOwner, goal: "chat", facts: [], announcement: "hey", state: "placing" });
    const sent = []; const h = { open: [], event: [], close: [] };
    const live = { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) };
    const twilio = { sent: [], open: () => true, send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} };
    const lines = [];
    const call = new gl.GptLiveCall({ call: row, twilio, openLive: () => live, brain: async () => ({ text: "", tools: [] }), now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
    call.connect();
    return { call, timers, lines };
  };
  const free = start(c);
  await free.timers.advance(4.5 * 60_000 - 1000);
  assert.ok(!free.lines.some(l => l.gptlive_free_call_wrap), "no cue before 4:30");
  await free.timers.advance(2000);
  assert.ok(free.lines.some(l => l.gptlive_free_call_wrap), "the cue at 4:30");
  assert.ok(!free.call.done);
  await free.timers.advance(28_000);
  assert.ok(!free.call.done, "still open just before 5:00");
  await free.timers.advance(2000);
  assert.ok(free.call.done, "the line closed at 5:00");
  assert.equal(free.call.endWhy, "free_call_limit");

  // An errand call to a business for a free-tier person: not cut at 5, no plan talk to the business.
  const errand = start(c, false);
  await errand.timers.advance(10 * 60_000);
  assert.ok(!errand.call.done && !errand.lines.some(l => l.gptlive_free_call_wrap), "errand call not limited");
  await errand.call.end("test");

  await plan.markPaid(c, { customerId: "cus_3", subscriptionId: "sub_3" });
  const paid = start(c);
  await paid.timers.advance(20 * 60_000);
  assert.ok(!paid.call.done && !paid.lines.some(l => l.gptlive_free_call_wrap));
  await paid.call.end("test");
});

test("call_place past the 2 calls: nothing dialled, the line + link for the model, once a conversation", async () => {
  const { c } = newcomer("Ama");
  accounts.countUse(c, "turn");
  plan.noteCall(c); plan.noteCall(c);
  const ctx = { conversationId: c, messages: [], kind: "user" };
  const first = await runTool("call_place", { to: "+13475550000", goal: "book a table for two at 7", facts: [] }, ctx);
  assert.equal(first.blocked, "free_calls_used", JSON.stringify(first));
  assert.match(first.error, /nobody's phone rang/);
  assert.match(first.error, /\$24\.99 a month/);
  assert.match(first.error, /https:\/\/buy\.stripe\.test\/reason\?client_reference_id=/);
  const again = await runTool("call_place", { to: "+13475550000", goal: "book a table for two at 7", facts: [] }, ctx);
  assert.equal(again.blocked, "free_calls_used");
  assert.match(again.error, /ALREADY told/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM calls").get().n, 0);
});

// ---------------------------------------------------------------- invites and events

test("trial users get no invites, and a trial user's invitee or event guest is on the free tier, not free for good", () => {
  const { c: walkIn } = newcomer("WalkIn");
  assert.equal(invitesOpenFor(walkIn), false);
  assert.ok(!toolsFor(walkIn).some(t => t.name === "invite_link_create"));
  // An invite made before (or around) the rule: redeeming it makes nobody free.
  db.db.prepare(`INSERT INTO invite_allowances (conversation_id, remaining, updated_at) VALUES (?, 2, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET remaining = 2`).run(walkIn, clock.now());
  const made = db.createInvite(walkIn);
  assert.ok(made.ok, JSON.stringify(made));
  const invited = db.redeemInvite({ claimCode: made.invite.claim_code, channel: "fake", address: newNumber(), name: "Friend" });
  assert.ok(invited.ok);
  assert.equal(plan.grandfathered(invited.account.conversation_id), false);
  assert.equal(plan.status(invited.account.conversation_id).status, "trial");
  assert.equal(plan.status(invited.account.conversation_id).monthly, true);

  const event = (organizer) => {
    const at = clock.now() + (n++);
    return db.db.prepare(`INSERT INTO events (public_id, organizer_conversation_id, name, name_key, tz, password_hash, organizer_token, created_at, updated_at)
      VALUES (?, ?, 'Party', 'party', 'America/New_York', 'x', ?, ?, ?)`).run(`ev-${at}`, organizer, `tok-${at}`, at, at).lastInsertRowid;
  };
  const { c: guest } = newcomer("Guest");
  db.db.prepare("UPDATE accounts SET joined_via_event = ? WHERE conversation_id = ?").run(event(walkIn), guest);
  assert.equal(plan.grandfathered(guest), false, "a trial organizer's guest is not free for good");

  // The operator's event (and anybody free for good): its guests are free, as before.
  const { c: vip } = newcomer("Vip");
  db.db.prepare("UPDATE accounts SET joined_via_event = ? WHERE conversation_id = ?").run(event(OMARI), vip);
  assert.equal(plan.status(vip).status, "free");
  // …and so is the next link down the chain: invited by somebody who came in on the operator's event.
  assert.equal(invitesOpenFor(vip), invitesOpenFor(vip) && true);
  const { c: chain } = newcomer("Chain");
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(vip, chain);
  assert.equal(plan.status(chain).status, "free");
  // A loop never spins.
  db.db.prepare("UPDATE accounts SET invited_by = ? WHERE conversation_id = ?").run(guest, walkIn);
  db.db.prepare("UPDATE accounts SET invited_by = ?, joined_via_event = NULL WHERE conversation_id = ?").run(walkIn, guest);
  assert.equal(plan.grandfathered(guest), false);
});

// ---------------------------------------------------------------- the signup ceiling

test("auto-admit lets 30 an hour in; the 31st gets the access-list text and is queued; next hour their text lets them in", () => {
  for (let i = 0; i < 30; i++) {
    const out = access.handleUnknown({ channel: "fake", address: newNumber(), text: "hey" });
    assert.equal(out.action, "auto_admitted", `#${i + 1}`);
  }
  // Invite and event joins do not use the hour up (they never come through here) and are not counted.
  const late = newNumber();
  const out = access.handleUnknown({ channel: "fake", address: late, text: "hey" });
  assert.equal(out.action, "ask_master");
  assert.equal(out.signupsFull, true);
  assert.equal(out.toThem, "hey, it's Reason — lots of people are joining right now, so you're on the list and i'll text you the moment you're in. more here: https://heyreason.com/access");
  assert.equal(db.getAccount(conv(late)), null, "no account made");
  assert.equal(db.pendingRequestFor(late)?.state, "pending", "in the approval queue");
  // Texting again inside the hour: the queue's own "still waiting" line, at most once in a while.
  assert.equal(access.handleUnknown({ channel: "fake", address: late, text: "hello?" }).reason, "already_waiting");
  // An hour on there is room again: their next text lets them in and closes their request.
  clock.skip(61 * MIN);
  const again = access.handleUnknown({ channel: "fake", address: late, text: "still there?" });
  assert.equal(again.action, "auto_admitted");
  assert.equal(db.pendingRequestFor(late), null);
  // 0 = no ceiling.
  config.signupsPerHour = 0;
  for (let i = 0; i < 40; i++) assert.equal(access.handleUnknown({ channel: "fake", address: newNumber(), text: "hey" }).action, "auto_admitted");
});

// ---------------------------------------------------------------- the flag

test("REASON_FREE_TIER unset: the old 25-session trial, untouched (no monthly fields, no line, no call limit)", async () => {
  process.env.REASON_FREE_TIER = "";
  try {
    const { c } = newcomer();
    conversations(c, 22);
    const st = plan.status(c);
    assert.equal(st.status, "trial");
    assert.equal(st.trial_sessions, 25);
    assert.equal(st.monthly, undefined);
    assert.equal(await plan.overTextReply(c), null);
    assert.equal(plan.callLimitSeconds(c), null);
    plan.noteCall(c); plan.noteCall(c); plan.noteCall(c);
    assert.equal(plan.callGate(c), null);
  } finally { process.env.REASON_FREE_TIER = "monthly"; }
});

test("subscription_show and the turn note speak the new numbers", async () => {
  const { c } = newcomer("Ama");
  conversations(c, 3);
  plan.noteCall(c);
  const v = await runTool("subscription_show", {}, { conversationId: c, messages: [] });
  assert.equal(v.conversations_used, 3);
  assert.equal(v.calls_left, 1);
  assert.match(v.note, /20 conversations and 2 calls \(up to 5 minutes each\) a month/);
  assert.match(v.note, /3 of 20 conversations and 1 of 2 calls used/);
  const r = fakeRouter();
  assert.equal((await plan.afterTurn({ conversationId: c, router: r, sleep: noSleep })).did, "nothing", "no 25th-session bubbles under the monthly rule");
  assert.equal(r.sent.length, 0);
});

test("the approved over-ceiling words: wins counted first, the reset date before the price, the link alone", () => {
  const counts = { calls: 2, tasks: 11, orders: 0, reminders: 0, events: 0 };
  const b = plan.overTextBubbles({ url: "https://pay.test/x", resets: "Dec 9", counts, name: "Ama" });
  assert.deepEqual(b, [
    "that's 20 conversations between us this month, Ama. so far i've made 2 calls that got answers and finished 11 things you asked for.",
    "the free ones come back Dec 9. or it's $24.99 a month for unlimited texts and calls. everything stays exactly as it is, what i remember, your reminders, all of it, and you can cancel any time just by telling me.",
    "https://pay.test/x",
  ]);
  assert.ok(b[1].indexOf("Dec 9") < b[1].indexOf("$24.99"), "reset date before the price");
  const none = plan.overTextBubbles({ url: "https://pay.test/x", resets: "Dec 9" });
  assert.equal(none[0], "that's 20 conversations between us. i haven't pulled off something real for you yet, and i'd like the chance to.");
  assert.match(plan.overTextBubbles({ url: null, resets: "Dec 9" })[1], /i'll text you the link in a bit\.$/);
  assert.equal(plan.overCallLine("calls", "Ama"), "hey Ama, it's Reason. that's both free calls this month, so i can't stay on. i'm texting you the link right now. talk soon.");
  assert.deepEqual(plan.callLinkBubbles({ url: "https://pay.test/x", resets: "Dec 9", why: "calls", counts }), [
    "here's that link. so far i've made 2 calls that got answers and finished 11 things you asked for. $24.99 a month for unlimited texts and calls, cancel any time by texting me. otherwise your 2 calls come back Dec 9.",
    "https://pay.test/x",
  ]);
  for (const line of [...b, ...none, plan.overCallLine("calls"), plan.overCallLine("conversations"), ...plan.callLinkBubbles({ url: "u", resets: "Dec 9", why: "calls" })]) {
    assert.ok(!/unlock|upgrade|trial/i.test(line), line);
  }
});
