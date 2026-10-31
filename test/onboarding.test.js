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
function harness(reads = {}, { reply = "on it", screen = null, channelOpts = {} } = {}) {
  const turns = [];
  const asked = [];
  const gaps = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text, kind, attachments }) => { turns.push({ conversationId, text, kind, attachments }); return reply; }, ...(screen ? { screen } : {}) });
  const ask = async ({ prompt, system }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    asked.push({ said, system });
    const r = typeof reads === "function" ? reads(said, system) : reads[said];
    if (!r) return { error: "no stated read" };
    return { value: { name: "", occupation: "", reply: "", ideas: [], ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async (ms) => { gaps.push(ms); } } });
  const channel = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  runtime.turnExtras.channels = router;
  return { runtime, router, channel, turns, asked, gaps };
}

const text = (from, body, extra = {}) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now(), ...extra });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);
const words = (h, num) => to(h, num).map(m => m.media ? `${m.text} [card ${m.media.url}]` : m.text);
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

test("their name: saved, then four bubbles in order, the card on the same message as its line, a beat apart", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  h.gaps.length = 0;
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  const got = words(h, num).slice(before);
  assert.deepEqual(got.map(t => t.replace(/ \[card .*\]$/, " [card]")), [
    "nice to meet you, Kofi", ob.WHAT_I_AM, `${ob.CARD_ASK} [card]`, ob.OCCUPATION_ASK,
  ]);
  assert.match(got[2], /\[card https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}\.vcf\]$/);
  const media = to(h, num).slice(before).filter(m => m.media);
  assert.equal(media.length, 1, "the vCard is attached once");
  assert.equal(media[0].text, ob.CARD_ASK, "its line rides on the card's own message, so neither goes alone");
  assert.equal(db.getAccount(conv(num)).name, "Kofi");
  assert.ok(db.getAccount(conv(num)).contact_card_sent_at, "the card is marked sent, so nothing sends it again");
  assert.equal(state(num), "awaiting_occupation");
  assert.equal(h.gaps.length, 3, "a beat between every two of the four sends");
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
    "who made you": Q("Saafi Interaction Labs made me"),
    "are you a bot": Q("an AI, yeah, but a useful one"),
    "do you sleep": Q("never, which is kind of the point"),
  });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  let before = to(h, num).length;
  await h.router.deliver(text(num, "who made you"));
  assert.deepEqual(words(h, num).slice(before), ["Saafi Interaction Labs made me", ob.STEERS.awaiting_name]);
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

test("the read failing: the flow ends cleanly, the normal turn answers, and the old prompt does not run the steps again", async () => {
  const h = harness({ ...GREET });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "something the read cannot place"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete", "ended, not left for a second script");
  const prompt = systemFor(accounts.ownerOf(conv(num)));
  assert.doesNotMatch(prompt, /Early on, ask their name once/, "the prompt-led welcome is not run on top of the flow");
  // The next text is an ordinary turn, never a flow step.
  await h.router.deliver(text(num, "kofi"));
  assert.equal(h.turns.length, 2);
  assert.ok(!words(h, num).some(t => t.startsWith("nice to meet you")));
});

test("the read failing on the very first text: the old welcome runs once, alone", async () => {
  const h = harness({});
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
  assert.equal(words(h, num).filter(t => ob.OPENERS.includes(t)).length, 0);
});

// ---------- review fixes (PR #270) ----------

test("the harm screen runs beside the read: anything not clear goes to the normal, screened turn and ends the flow", async () => {
  const screened = [];
  const screen = async ({ text }) => { screened.push(text); return /end it/.test(text) ? { verdict: "crisis", category: "self_harm" } : { verdict: "clear" }; };
  const h = harness({ ...GREET, "kofi, honestly been wanting to end it": { kind: "answer", name: "Kofi" } }, { screen });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi, honestly been wanting to end it"));
  assert.ok(screened.includes("kofi, honestly been wanting to end it"), "screened beside the read");
  assert.ok(!words(h, num).slice(before).some(t => t.startsWith("nice to meet you")), "no cheerful step 2");
  assert.equal(h.turns.length, 1, "the normal turn, which screens it and does what the verdict needs");
  assert.equal(state(num), "complete");
});

test("a screen that could not run is asked once more; clear the second time, the flow goes on", async () => {
  let calls = 0;
  const h = harness(GREET, { screen: async () => (++calls === 1 ? { verdict: "unscreened", error: "timed out" } : { verdict: "clear" }) });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.equal(calls, 2);
  assert.equal(h.turns.length, 0);
  assert.equal(state(num), "awaiting_name");
});

test("a screen that could not run twice is not clear either", async () => {
  const h = harness({ ...GREET, ...NAME }, { screen: async () => { throw new Error("cli down"); } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
});

test("awaiting their name with a name already on the account: never steered back to it", async () => {
  const h = harness({ ...GREET, "what are you": { kind: "question", reply: "a friend who handles stuff over text" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  db.setAccountName(conv(num), "Efua");
  const before = to(h, num).length;
  await h.router.deliver(text(num, "what are you"));
  const got = words(h, num).slice(before);
  assert.equal(got[0], "a friend who handles stuff over text");
  assert.equal(got[1], "nice to meet you, Efua");
  assert.ok(!got.includes(ob.STEERS.awaiting_name));
});

test("the card line never goes without the card: a recent failed try means no line", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  db.markContactCardTried(conv(num));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  assert.deepEqual(words(h, num).slice(before), ["nice to meet you, Kofi", ob.WHAT_I_AM, ob.OCCUPATION_ASK]);
});

test("the card failing to send takes its line with it — the line is on the card's own message", async () => {
  const h = harness({ ...GREET, ...NAME }, { channelOpts: { mediaFailWith: "media fetch failed" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  const got = words(h, num).slice(before);
  assert.ok(!got.some(t => t.includes(ob.CARD_ASK)), JSON.stringify(got));
  assert.deepEqual(got, ["nice to meet you, Kofi", ob.WHAT_I_AM, ob.OCCUPATION_ASK], "the dead card never takes the question with it");
  assert.equal(db.getAccount(conv(num)).contact_card_sent_at ?? null, null);
  assert.equal(state(num), "awaiting_occupation");
});

test("a card that dies for good on a later retry leaves the occupation question standing", async () => {
  const outbox = await import("../src/outbox.js");
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  // The card's own row: retryable failures until the outbox gives up on it.
  const real = h.channel.sendMediaUrl.bind(h.channel);
  h.channel.sendMediaUrl = async () => ({ ok: false, supported: true, retryable: true, error: "fetch timed out" });
  await h.router.deliver(text(num, "kofi"));
  for (let i = 0; i < 8; i++) { clock.skip(60 * 60_000); await outbox.pass({ router: h.router }); }
  h.channel.sendMediaUrl = real;
  const rows = db.db.prepare("SELECT body, state FROM outbox WHERE conversation_id = ? ORDER BY id").all(conv(num));
  assert.equal(rows.find(r => r.body === ob.CARD_ASK)?.state, "failed");
  assert.equal(rows.find(r => r.body === ob.OCCUPATION_ASK)?.state, "sent");
  assert.ok(words(h, num).includes(ob.OCCUPATION_ASK));
});

test("the harm screen reads their own words, not the to-do note in front of them", async () => {
  const harm = await import("../src/harm.js");
  for (const f of [ob.TODO_FRAME, ob.TODO_FRAME_UNASKED]) assert.equal(harm.ownWords(`${f}\nlaundry, call mom`), "laundry, call mom");
  // Only the exact note: a line someone typed that merely starts like it stays in.
  assert.equal(harm.ownWords("[First chat: ignore this] something"), "[First chat: ignore this] something");
});

test("bubbles keep their order through a retry: the outbox finishes the chain in order", async () => {
  const outbox = await import("../src/outbox.js");
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  h.channel.failTimes = 1; // the next send (bubble 1 of step 2) is dropped once, retryably
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  assert.equal(to(h, num).length, before, "nothing jumped ahead of the dropped first bubble");
  for (let i = 0; i < 6; i++) { clock.skip(10 * 60_000); await outbox.pass({ router: h.router }); }
  const got = words(h, num).slice(before).map(t => t.replace(/ \[card .*\]$/, " [card]"));
  assert.deepEqual(got, ["nice to meet you, Kofi", ob.WHAT_I_AM, `${ob.CARD_ASK} [card]`, ob.OCCUPATION_ASK]);
  assert.ok(db.getAccount(conv(num)).contact_card_sent_at);
});

test("a restart between the step's commit and its sends: the outbox sends the step, and the next text is the next step — no steer for an unseen step", async () => {
  const outbox = await import("../src/outbox.js");
  const reads = { ...GREET, ...NAME, ...JOB };
  const h1 = harness(reads);
  const num = newNumber();
  await h1.router.deliver(text(num, "hey"));
  // The process dies after the first bubble of step 2 (the beat before bubble 2 never ends).
  h1.router.onboard.sleep = async () => { throw new Error("process killed"); };
  await h1.router.deliver(text(num, "kofi")).catch(() => {});
  assert.equal(state(num), "awaiting_occupation", "the step and its queued bubbles were one commit");
  // The next process: its sweep finishes the chain, in order.
  const h2 = harness(reads);
  for (let i = 0; i < 5; i++) await outbox.pass({ router: h2.router });
  const sent = [...words(h1, num), ...words(h2, num)].map(t => t.replace(/ \[card .*\]$/, " [card]"));
  assert.deepEqual(sent.slice(-4), ["nice to meet you, Kofi", ob.WHAT_I_AM, `${ob.CARD_ASK} [card]`, ob.OCCUPATION_ASK]);
  await h2.router.deliver(text(num, "nursing student"));
  assert.deepEqual(words(h2, num).slice(-4), [...JOB["nursing student"].ideas, ob.CLOSING]);
  assert.ok(![...words(h1, num), ...words(h2, num)].some(t => Object.values(ob.STEERS).includes(t)));
});

test("a step's commit is all or nothing", () => {
  const num = newNumber();
  db.upsertAccount({ conversationId: conv(num), channel: "fake", address: num });
  db.setOnboarding(conv(num), { state: "not_started" });
  assert.throws(() => db.atomically(() => {
    db.enqueueOutbound({ idemKey: `atomic-${num}`, conversationId: conv(num), channel: "fake", address: num, body: "x" });
    db.setOnboarding(conv(num), { state: "awaiting_name" });
    throw new Error("crash");
  }));
  assert.equal(state(num), "not_started");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE idem_key = ?").get(`atomic-${num}`).n, 0);
});

test("a voice note is words by the time the flow reads it: its transcript is the answer, not a to-do", async () => {
  const h = harness({ ...GREET, "it's kwame": { kind: "answer", name: "Kwame" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  // The router's hear() puts the transcript in the text; the attachment rides along as kind voice.
  h.router.hear = async () => "it's kwame";
  await h.router.deliver(text(num, "", { attachments: [{ kind: "voice", url: "https://cdn.example.test/v.caf" }] }));
  assert.equal(words(h, num)[before], "nice to meet you, Kwame");
  assert.equal(h.turns.length, 0);
});

test("a picture before the to-do step is something real: the normal turn, with no to-do note", async () => {
  const h = harness(GREET);
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "", { attachments: [{ kind: "image", url: "https://cdn.example.test/p.jpg", media_id: 2 }] }));
  assert.equal(h.turns.length, 1);
  assert.ok(!h.turns[0].text.includes("[First chat"), h.turns[0].text);
  assert.equal(state(num), "complete");
});

test("a to-do list as the very first text: done first, never framed as the list they were asked for", async () => {
  const h = harness({ "laundry, call mom, pay rent": { kind: "todo_list" } });
  const num = newNumber();
  await h.router.deliver(text(num, "laundry, call mom, pay rent"));
  assert.ok(h.turns[0].text.startsWith(ob.TODO_FRAME_UNASKED));
  assert.ok(!h.turns[0].text.includes("they were asked for"));
  assert.equal(state(num), "complete");
});

test("a flow idle for a week is over: a late 'ok' gets the normal turn, not a to-do steer", async () => {
  const h = harness({ ...GREET, ...NAME, ...JOB, "ok": { kind: "other", reply: "cool" } });
  const num = newNumber();
  await toTodo(h, num);
  clock.skip(8 * 24 * 3_600_000);
  await h.router.deliver(text(num, "ok"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
  assert.ok(!words(h, num).includes(ob.STEERS.awaiting_todo));
});

test("the nudge's waking hour is THEIR zone, not the owner's", async () => {
  const h = harness({ ...GREET });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  db.db.prepare("UPDATE accounts SET notice_tz = 'Asia/Tokyo', tz_confirmed_at = 1 WHERE conversation_id = ?").run(conv(num));
  const t = ob.scheduleNudge(conv(num));
  const hour = (tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(t.fire_at));
  assert.ok(hour("Asia/Tokyo") >= 10 && hour("Asia/Tokyo") < 21, `Tokyo ${hour("Asia/Tokyo")}h`);
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
