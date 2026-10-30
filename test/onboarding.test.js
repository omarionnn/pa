// The first-chat onboarding (src/onboarding.js, REASON_ONBOARDING), through the real router, the real
// outbox and the real database, with the model's read of their text stated (it is a side call on the
// subscription in production) and the beat between bubbles recorded instead of slept.
//
//   "hey" → one opener from the list, rotating; a question first → its one-line answer, then the opener
//   their name → four bubbles in order, the contact card right after its line
//   what they do → 2–3 ideas and CLOSING, word for word
//   a detour at every step → its answer and one steer back to that step; a second detour moves on
//   existing, finished, operator and uncovered people never enter; the state survives a restart
//   their to-do photo → the real turn, told to say what it handled apart from what is only a reminder
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-onboarding-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";

const ob = await import("../src/onboarding.js");
const accounts = await import("../src/accounts.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { systemFor } = await import("../src/agent.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415555${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM usage; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM people; DELETE FROM person_facts;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

/**
 * A router over a live fake channel with a line number (so the card can go), a recorded turn, and
 * a stated read: `reads` maps what the person texts to what the model makes of it.
 */
function harness(reads = {}, { reply = "on it" } = {}) {
  const turns = [];
  const asked = [];
  const gaps = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text, kind, attachments }) => { turns.push({ conversationId, text, kind, attachments }); return reply; } });
  const ask = async ({ prompt, system }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    asked.push({ said, system });
    const r = typeof reads === "function" ? reads(said, system) : reads[said];
    if (!r) return { error: "no stated read" };
    return { value: { name: "", occupation: "", reply: "", ideas: [], ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async (ms) => { gaps.push(ms); } } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  return { runtime, router, channel, turns, asked, gaps };
}

const text = (from, body, extra = {}) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now(), ...extra });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);
const words = (h, num) => to(h, num).map(m => m.media ? `[card ${m.media.url}]` : m.text);
const state = (num) => db.getAccount(conv(num))?.onboarding ?? null;

const NAME = { "kofi": { kind: "answer", name: "Kofi" } };
const JOB = { "nursing student": { kind: "answer", occupation: "nursing student", ideas: ["I can track clinical shifts and remind you before each one", "I can keep your exam dates and make study reminders that build up to them", "I can look up drug info or study resources and send you a real pick"] } };
const GREET = { "hey": { kind: "greeting" } };

async function toTodo(h, num) {
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  await h.router.deliver(text(num, "nursing student"));
}

// ---------- step 1 ----------

test("a new user's 'hey' gets exactly one opener from the list, and no model turn", async () => {
  const h = harness(GREET);
  const num = newNumber();
  const out = await h.router.deliver(text(num, "hey"));
  assert.equal(out.onboarding, "awaiting_name");
  const got = words(h, num);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.ok(ob.OPENERS.includes(got[0]), got[0]);
  assert.equal(h.turns.length, 0, "the opener is code's bubble, not a turn");
  assert.equal(state(num), "awaiting_name");
  assert.ok(db.getAccount(conv(num)).onboarding_name_asked_at, "their name has been asked");
  assert.ok(!got.some(t => /save me as a contact/.test(t)), "no contact card ahead of the flow");
});

test("the opener rotates through the list", async () => {
  const h = harness(GREET);
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const num = newNumber();
    await h.router.deliver(text(num, "hey"));
    const [line] = words(h, num);
    assert.ok(ob.OPENERS.includes(line), line);
    seen.add(line);
  }
  assert.ok(seen.size >= 3, `only ${seen.size} different openers in 30`);
});

test("a first text that is a real question: its one-line answer first, then the opener", async () => {
  const h = harness({ "wait what is this": { kind: "question", reply: "i'm Reason, a friend who handles stuff for you over text" } });
  const num = newNumber();
  await h.router.deliver(text(num, "wait what is this"));
  const got = words(h, num);
  assert.equal(got.length, 2);
  assert.equal(got[0], "i'm Reason, a friend who handles stuff for you over text");
  assert.ok(ob.OPENERS.includes(got[1]));
  assert.equal(state(num), "awaiting_name");
});

test("a name in the very first text is never asked for: straight to step 2", async () => {
  const h = harness({ "hey it's ama": { kind: "answer", name: "Ama" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey it's ama"));
  assert.equal(words(h, num)[0], "nice to meet you, Ama");
  assert.equal(db.getAccount(conv(num)).name, "Ama");
  assert.equal(state(num), "awaiting_occupation");
});

// ---------- step 2 ----------

test("their name: saved, then four bubbles in order with the card right after its line, a beat apart", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  h.gaps.length = 0;
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  const got = words(h, num).slice(before);
  assert.deepEqual(got.map(t => t.startsWith("[card ") ? "[card]" : t), [
    "nice to meet you, Kofi", ob.WHAT_I_AM, ob.CARD_ASK, "[card]", ob.OCCUPATION_ASK,
  ]);
  assert.match(got[3], /^\[card https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}\.vcf\]$/);
  assert.equal(to(h, num).slice(before).filter(m => m.media).length, 1, "the vCard is attached once");
  assert.equal(to(h, num)[before + 3].text, "", "the card goes on its own, with no second line about it");
  assert.equal(db.getAccount(conv(num)).name, "Kofi");
  assert.ok(db.getAccount(conv(num)).contact_card_sent_at, "the card is marked sent, so nothing sends it again");
  assert.equal(state(num), "awaiting_occupation");
  assert.equal(h.gaps.length, 4, "a beat between every two of the five sends");
  for (const g of h.gaps) assert.ok(g >= 1000 && g <= 2000, `gap ${g}`);
  assert.ok(!got.some(t => /confirm|did you save|let me know when/i.test(t)), "never asks them to confirm the card");
});

test("no public address for the card: its line is not said either", async () => {
  const kept = config.publicUrl;
  config.publicUrl = "";
  try {
    const h = harness({ ...GREET, ...NAME });
    const num = newNumber();
    await h.router.deliver(text(num, "hey"));
    const before = to(h, num).length;
    await h.router.deliver(text(num, "kofi"));
    assert.deepEqual(words(h, num).slice(before), ["nice to meet you, Kofi", ob.WHAT_I_AM, ob.OCCUPATION_ASK]);
  } finally { config.publicUrl = kept; }
});

test("they would rather not give a name: not pushed, the flow carries on, and the prompt stops asking", async () => {
  const h = harness({ ...GREET, "rather not say": { kind: "decline" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "rather not say"));
  const got = words(h, num).slice(before);
  assert.equal(got[0], ob.MET(""));
  assert.equal(got.at(-1), ob.OCCUPATION_ASK);
  assert.ok(!got.some(t => /name/i.test(t)), "nothing about a name again");
  assert.equal(state(num), "awaiting_occupation");
  const prompt = systemFor(accounts.ownerOf(conv(num)));
  assert.match(prompt, /did not give it: do not ask again/);
  assert.doesNotMatch(prompt, /Early on, ask their name once/);
});

// ---------- step 3 ----------

test("what they do: saved, 2–3 ideas for that work, and the closing line word for word, last", async () => {
  const h = harness({ ...GREET, ...NAME, ...JOB });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "nursing student"));
  const got = words(h, num).slice(before);
  assert.deepEqual(got, [...JOB["nursing student"].ideas, ob.CLOSING]);
  assert.equal(ob.CLOSING, "or better yet, send me a picture of your to-do list and I'll knock them out right now.");
  assert.equal(state(num), "awaiting_todo");
  const facts = db.db.prepare("SELECT fact FROM person_facts").all().map(r => r.fact).join(" | ");
  assert.match(facts, /nursing student/);
  // The read at this step is told what Reason really does, and nothing flattering.
  const sys = h.asked.at(-1).system;
  assert.match(sys, /Reason asked what they do/);
  assert.match(sys, /Only from what Reason really does/);
  assert.match(sys, /never flattering or patronizing/);
});

test("ideas the model did not give: the true-for-anybody ones, and still the closing line", async () => {
  const h = harness({ ...GREET, ...NAME, "i make furniture": { kind: "answer", occupation: "makes furniture", ideas: [] } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "i make furniture"));
  assert.deepEqual(words(h, num).slice(before), [...ob.GENERAL_IDEAS, ob.CLOSING]);
});

// ---------- detours ----------

test("a question at every step: its one-line answer, then a steer back to exactly that step", async () => {
  const Q = (reply) => ({ kind: "question", reply });
  const h = harness({ ...GREET, ...NAME, ...JOB,
    "who made you": Q("Omarion Nyarko built me"),
    "are you a bot": Q("an AI, yeah, but a useful one"),
    "do you sleep": Q("never, which is kind of the point"),
  });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  let before = to(h, num).length;
  await h.router.deliver(text(num, "who made you"));
  assert.deepEqual(words(h, num).slice(before), ["Omarion Nyarko built me", ob.STEERS.awaiting_name]);
  assert.equal(state(num), "awaiting_name");

  await h.router.deliver(text(num, "kofi"));
  before = to(h, num).length;
  await h.router.deliver(text(num, "are you a bot"));
  assert.deepEqual(words(h, num).slice(before), ["an AI, yeah, but a useful one", ob.STEERS.awaiting_occupation]);
  assert.equal(state(num), "awaiting_occupation");

  await h.router.deliver(text(num, "nursing student"));
  before = to(h, num).length;
  await h.router.deliver(text(num, "do you sleep"));
  assert.deepEqual(words(h, num).slice(before), ["never, which is kind of the point", ob.STEERS.awaiting_todo]);
  assert.equal(state(num), "awaiting_todo");
  assert.equal(h.turns.length, 0);
  // Never a completed step again: one opener, one "nice to meet you", one closing line in the whole thread.
  const all = words(h, num);
  assert.equal(all.filter(t => ob.OPENERS.includes(t)).length, 1);
  assert.equal(all.filter(t => t.startsWith("nice to meet you")).length, 1);
  assert.equal(all.filter(t => t === ob.CLOSING).length, 1);
});

test("a second detour on the name step answers it and moves on — the name is asked twice at most", async () => {
  const h = harness({ ...GREET, "lol": { kind: "other", reply: "haha" }, "what can you do": { kind: "question", reply: "a lot, honestly" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "lol"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "what can you do"));
  const got = words(h, num).slice(before);
  assert.equal(got[0], "a lot, honestly");
  assert.equal(got[1], ob.MET(""));
  assert.equal(got.at(-1), ob.OCCUPATION_ASK);
  assert.equal(state(num), "awaiting_occupation");
});

test("something real mid-flow ends it, and the normal turn does the thing first", async () => {
  const h = harness({ ...GREET, "can you remind me to call my mom at 5": { kind: "task" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "can you remind me to call my mom at 5"));
  assert.equal(h.turns.length, 1);
  assert.match(h.turns[0].text, /remind me to call my mom at 5/);
  assert.equal(state(num), "complete");
  // …and the prompt knows the name was already asked, so it does not run a second onboarding.
  assert.match(systemFor(accounts.ownerOf(conv(num))), /do not ask again/);
});

test("the read failing: the normal turn answers, and the step is left where it was", async () => {
  const h = harness({ ...GREET });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "something the read cannot place"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "awaiting_name");
});

// ---------- step 4 ----------

test("their to-do photo: the real turn gets it with the note to do what it can, remind for the rest, and say which is which", async () => {
  const h = harness({ ...GREET, ...NAME, ...JOB });
  const num = newNumber();
  await toTodo(h, num);
  const photo = { kind: "image", url: "https://cdn.example.test/todo.jpg", media_id: 1 };
  await h.router.deliver(text(num, "", { attachments: [photo] }));
  assert.equal(h.turns.length, 1, "one real turn");
  const turn = h.turns[0];
  assert.ok(turn.text.startsWith(ob.TODO_FRAME), turn.text);
  assert.equal(turn.attachments.length, 1);
  assert.match(ob.TODO_FRAME, /Read every item/);
  assert.match(ob.TODO_FRAME, /set a reminder for it/);
  assert.match(ob.TODO_FRAME, /first what you handled, then what you only set reminders for/);
  assert.match(ob.TODO_FRAME, /Never say something is done unless a tool did it this turn/);
  assert.equal(state(num), "complete");
});

test("a typed to-do list counts too", async () => {
  const h = harness({ ...GREET, ...NAME, ...JOB, "laundry, email prof, book dentist": { kind: "todo_list" } });
  const num = newNumber();
  await toTodo(h, num);
  await h.router.deliver(text(num, "laundry, email prof, book dentist"));
  assert.ok(h.turns[0].text.startsWith(ob.TODO_FRAME));
  assert.equal(state(num), "complete");
});

// ---------- who never sees it ----------

test("finished, existing, operator and uncovered people never enter it", async () => {
  const h = harness({ ...GREET, ...NAME, ...JOB, "nah i'm good": { kind: "decline" } });
  // Finished: passes on the list → done, and the next "hey" is an ordinary turn.
  const done = newNumber();
  await toTodo(h, done);
  const before = to(h, done).length;
  await h.router.deliver(text(done, "nah i'm good"));
  assert.deepEqual(words(h, done).slice(before), [ob.LATER]);
  assert.equal(state(done), "complete");
  await h.router.deliver(text(done, "hey"));
  assert.equal(h.turns.length, 1);
  assert.ok(!ob.OPENERS.includes(words(h, done).at(-1)));

  // An account that already existed (here, from before the switch): never put in it.
  const old = newNumber();
  db.upsertAccount({ conversationId: conv(old), channel: "fake", address: old, name: "" });
  await h.router.deliver(text(old, "hey"));
  assert.equal(state(old), null);
  assert.equal(h.turns.length, 2);

  // Code refuses to put anybody finished back in.
  assert.equal(ob.begin(conv(done)), false);
  db.setOnboarding(conv(done), { state: "not_started" });
  assert.equal(state(done), "complete");

  // The operator.
  await h.router.deliver(text(MASTER, "hey"));
  assert.equal(db.getAccount(config.ownerConversation).onboarding ?? null, null);

  // The switch off: a brand-new person gets the ordinary turn.
  config.onboarding = "off";
  const off = newNumber();
  await h.router.deliver(text(off, "hey"));
  assert.equal(state(off), null);
  assert.equal(h.turns.length, 4);
});

test("REASON_ONBOARDING=test: only the listed numbers get it", async () => {
  config.onboarding = "test";
  const listed = newNumber(), other = newNumber();
  config.onboardingNumbers = [listed];
  const h = harness(GREET);
  await h.router.deliver(text(listed, "hey"));
  await h.router.deliver(text(other, "hey"));
  assert.equal(state(listed), "awaiting_name");
  assert.equal(state(other), null);
  assert.equal(h.turns.length, 1, "only the unlisted number got a turn");
});

// ---------- restart, and the one nudge ----------

test("the step survives a restart: a new router and runtime pick it up where it was", async () => {
  const h1 = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h1.router.deliver(text(num, "hey"));
  await h1.router.deliver(text(num, "kofi"));
  assert.equal(state(num), "awaiting_occupation");
  // A different process: nothing in memory carries over, only the database.
  const h2 = harness(JOB);
  await h2.router.deliver(text(num, "nursing student"));
  assert.deepEqual(words(h2, num), [...JOB["nursing student"].ideas, ob.CLOSING]);
  assert.equal(h2.turns.length, 0);
  assert.equal(state(num), "awaiting_todo");
});

test("going quiet: one nudge later on the timer system, never at night, never twice, cancelled when they reply", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const nudges = () => db.db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND label = ?").all(conv(num), db.ONBOARDING_NUDGE_LABEL);
  assert.equal(nudges().length, 1);
  assert.equal(db.listTimers(conv(num)).length, 0, "not one of their reminders");
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(nudges()[0].fire_at));
  assert.ok(hour >= 10 && hour < 21, `nudge at ${hour}h`);

  // They reply: the pending one is put down and a new one set for the new step.
  await h.router.deliver(text(num, "kofi"));
  assert.equal(nudges().filter(t => !t.cancelled_at).length, 1);

  // Quiet: it fires once, with the pending step's line.
  clock.skip(2 * 24 * 3_600_000);
  const before = to(h, num).length;
  await h.runtime.tick();
  assert.deepEqual(words(h, num).slice(before), [ob.NUDGES.awaiting_occupation]);
  assert.ok(db.getAccount(conv(num)).onboarding_nudged_at);
  // Never again, whatever happens next.
  assert.equal(ob.scheduleNudge(conv(num)), null);
  await h.runtime.tick();
  assert.equal(to(h, num).length, before + 1);
});

test("the night rule: a nudge due at 11pm lands at 10am", () => {
  const at = Date.parse("2026-11-03T04:00:00Z"); // 11pm in New York
  const moved = ob.wakingHour(at, "America/New_York");
  assert.equal(new Date(moved).toISOString(), "2026-11-03T15:00:00.000Z");
  const day = Date.parse("2026-11-03T17:00:00Z");
  assert.equal(ob.wakingHour(day, "America/New_York"), day);
});

test("the read is code-called with the step's question, never a keyword match", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  assert.equal(h.asked.length, 2);
  assert.match(h.asked[0].system, /very first text/);
  assert.match(h.asked[1].system, /Reason asked their name/);
});
