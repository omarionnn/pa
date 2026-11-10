// The first-chat onboarding (src/onboarding.js, REASON_ONBOARDING, on by default since 2026-11-06),
// through the real router, the real outbox and the real database, with the model's read of their
// text stated (it is a side call in production) and the beat between bubbles recorded, not slept.
//
//   "hey" → the opener (who Reason is, their name); a question first → its one-line answer, then it
//   their name → what it means and a warm word (the model's line), then what do you want to call me
//   the name they pick → the contact card under THAT name, on its line's message, then one thing
//   to try (a call or an event); done
//   skipped / "whatever" → the card as Reason
//   a real request → the turn does it first, the pending step follows its reply
//   existing, finished, operator and uncovered people never enter; the state survives a restart
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
delete process.env.REASON_ONBOARDING;

const ob = await import("../src/onboarding.js");
const accounts = await import("../src/accounts.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { systemFor } = await import("../src/agent.js");
const { assetRequest } = await import("../src/http.js");
const { backfillContactCards } = await import("../src/contact.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
let n = 0;
const newNumber = () => `+1415555${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

// Read before any test changes it: with REASON_ONBOARDING unset, the flow is on.
const DEFAULT_MODE = config.onboarding;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  config.publicUrl = "https://reason.example.test";
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
    return { value: { name: "", card_name: "", reply: "", ...r } };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async (ms) => { gaps.push(ms); } } });
  const channel = router.register(new FakeChannel({ number: LINE, ...channelOpts }));
  runtime.turnExtras.channels = router;
  // The turn's reply really goes out, as on the server, so its order against the flow's bubbles shows.
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { runtime, router, channel, turns, asked, gaps };
}

const text = (from, body, extra = {}) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now(), ...extra });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);
const words = (h, num) => to(h, num).map(m => m.media ? `${m.text} [card ${m.media.url}]` : m.text);
const plain = (list) => list.map(t => t.replace(/ \[card .*\]$/, " [card]"));
const state = (num) => db.getAccount(conv(num))?.onboarding ?? null;
const liveLine = { name: "fake", status: () => ({ status: "live", number: LINE }) };
const cardFile = (url) => assetRequest({ pathname: new URL(url).pathname, router: { list: () => [liveLine], get: () => liveLine } });

const GREET = { "hey": { kind: "greeting" } };
const NAME = { "kofi": { kind: "answer", name: "Kofi" } };
const PICK = { "jarvis": { kind: "answer", card_name: "Jarvis" } };
const STEP2 = (who) => [ob.MET(who), ob.CARD_NAME_ASK];
const card = (h, num) => to(h, num).filter(m => m.media).at(-1);

async function toCardName(h, num) {
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
}

// ---------- the switch ----------

test("REASON_ONBOARDING unset means on; off, 0, false and no turn it off; test stays test", async () => {
  assert.equal(DEFAULT_MODE, "on");
  const { execFileSync } = await import("node:child_process");
  const read = (v) => execFileSync(process.execPath, ["--input-type=module", "-e", "const { config } = await import(process.argv[1]); console.log(config.onboarding)", new URL("../src/config.js", import.meta.url).href],
    { env: { PATH: process.env.PATH, REASON_DB_PATH: join(dir, "cfg.db"), ...(v === undefined ? {} : { REASON_ONBOARDING: v }) } }).toString().trim();
  assert.equal(read(undefined), "on");
  for (const v of ["off", "0", "false", "no", "OFF"]) assert.equal(read(v), "off", v);
  assert.equal(read("test"), "test");
  assert.equal(read("on"), "on");
});

// ---------- step 1: their name ----------

test("a new user's 'hey' gets exactly one opener, in the owner's words, no model turn, and no card yet", async () => {
  const h = harness(GREET);
  const num = newNumber();
  const out = await h.router.deliver(text(num, "hey"));
  assert.equal(out.onboarding, "awaiting_name");
  const got = words(h, num);
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.equal(got[0], "hey, i'm Reason. i will help you with errands and complete your to do list for you", "bubble 1: who Reason is");
  assert.equal(got[1], "what's your name?", "bubble 2: the name question, alone, after the intro");
  // Two outbox rows, the question chained after the intro: it can never go first, or alone.
  const rows = db.db.prepare("SELECT id, body, after_id FROM outbox WHERE conversation_id = ? ORDER BY id").all(conv(num));
  assert.deepEqual(rows.map(r => r.body), ob.OPENER);
  assert.equal(rows[1].after_id, rows[0].id);
  assert.equal(h.turns.length, 0);
  assert.ok(!to(h, num).some(m => m.media), "no contact card ahead of the flow");
  assert.ok(db.getAccount(conv(num)).onboarding_name_asked_at);
});

test("a first text that is a real question: its one-line answer first, then the opener", async () => {
  const h = harness({ "wait what is this": { kind: "question", reply: "i'm Reason, a friend who handles stuff for you over text" } });
  const num = newNumber();
  await h.router.deliver(text(num, "wait what is this"));
  const got = words(h, num);
  assert.equal(got.length, 3);
  assert.equal(got[0], "i'm Reason, a friend who handles stuff for you over text");
  assert.deepEqual(got.slice(1), ob.OPENER);
  assert.equal(state(num), "awaiting_name");
});

test("a name in the very first text is never asked for: who Reason is, the name met, then what to call Reason", async () => {
  const h = harness({ "hey it's ama": { kind: "answer", name: "Ama" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey it's ama"));
  assert.deepEqual(words(h, num), [ob.INTRO, ...STEP2("Ama")]);
  assert.equal(db.getAccount(conv(num)).name, "Ama");
  assert.equal(state(num), "awaiting_card_name");
});

// ---------- step 2: their name met, and what to call Reason ----------

test("their name: saved, then the model's line on what it means, then exactly what do you want to call me — a beat apart, no card yet", async () => {
  const meaning = "Omar means long-lived, flourishing. it's arabic and tied to leadership, and that suits you";
  const h = harness({ ...GREET, "omar": { kind: "answer", name: "Omar", name_line: meaning } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "omar"));
  assert.deepEqual(words(h, num).slice(before), [meaning, "what do you want to call me?"]);
  assert.equal(ob.CARD_NAME_ASK, "what do you want to call me?", "the nickname question, exactly, alone in its bubble");
  assert.equal(db.getAccount(conv(num)).name, "Omar");
  // The read is told how to meet a name: meaning from its own knowledge, never invented, warm otherwise.
  const sys = h.asked.at(-1).system;
  assert.match(sys, /Never invent a meaning/);
  assert.match(sys, /not sure, or the meaning is awkward or negative, leave the meaning out and just say nice to meet you with their name/);
  // Real-name trial 2026-11-07 (haiku via the CLI): capitalised, wordy lines and chat filler
  // ("glad we're connecting", "hope your day is going well"), and praise for Adolf's name.
  assert.match(sys, /all lowercase like a text from a friend/);
  assert.match(sys, /No filler about the chat or their day/);
  assert.match(sys, /painful history gets nothing about the name at all/);
});

test("a nickname (Bubba): saved as given, met with a warm line and no meaning, then still exactly what do you want to call me", async () => {
  const warm = "love that name, bubba";
  const h = harness({ ...GREET, "bubba": { kind: "answer", name: "Bubba", name_line: warm } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "bubba"));
  assert.deepEqual(words(h, num).slice(before), [warm, ob.CARD_NAME_ASK], "the warm line, then the nickname question in its own bubble");
  assert.equal(db.getAccount(conv(num)).name, "Bubba", "saved as they gave it, like my_name");
  assert.equal(state(num), "awaiting_card_name");
  // The model judges nickname vs given name (owner, 2026-11-07); a nickname gets no meaning or origin.
  const sys = h.asked.at(-1).system;
  assert.match(sys, /judge, by its meaning, whether what they gave is their given name or a nickname/);
  assert.match(sys, /A nickname gets no meaning and no origin at all: just a few warm words about loving the name/);
  assert.match(sys, /A short form of a given name \(Mike, Liz\) counts as a given name/);
  assert.match(sys, /a nickname, initials or a handle they go by is a name/);
  // The stand-alone line (event page, name inside a request) carries the same judgment.
  let asked = null;
  await ob.nameLine({ name: "Big T", ask: async (a) => { asked = a; return { value: { line: "big t, i like that" } }; } });
  assert.match(asked.system, /A nickname gets no meaning and no origin at all/);
  assert.match(asked.system, /A nickname or handle they go by is a name/);
  // A handle keeps its underscores (trial 2026-11-07: Xx_Slayer_xX came back as xxslayerxx); markdown still goes.
  assert.equal(await ob.nameLine({ name: "Xx_Slayer_xX", ask: async () => ({ value: { line: "love that handle, _xx_slayer_xx_" } }) }), "love that handle, xx_slayer_xx");
  const r = await ob.readText({ state: "awaiting_name", text: "Xx_Slayer_xX", ask: async () => ({ value: { kind: "answer", name: "Xx_Slayer_xX", card_name: "", reply: "", name_line: "xx_slayer_xx, love that" } }) });
  assert.equal(r.name, "Xx_Slayer_xX");
  assert.equal(r.nameLine, "xx_slayer_xx, love that");
});

test("a field of only quote marks is empty: \"hey\" read as name `\"\"` is no name (cage drive 2026-11-10)", async () => {
  const r = await ob.readText({ state: "not_started", text: "hey", ask: async () => ({ value: { kind: "greeting", name: '""', card_name: "''", reply: "", name_line: '""' } }) });
  assert.equal(r.name, "");
  assert.equal(r.cardName, "");
  assert.equal(r.nameLine, "");
  const q = await ob.readText({ state: "awaiting_name", text: "\"Kofi\"", ask: async () => ({ value: { kind: "answer", name: '"Kofi"', card_name: "", reply: "", name_line: "kofi, nice" } }) });
  assert.equal(q.name, "Kofi");
});

test("the stand-alone name line: same rules, a non-name is left out, and it is cleaned to one line", async () => {
  let asked = null;
  const line = await ob.nameLine({ name: "Kofi", ask: async (a) => { asked = a; return { value: { line: "kofi is an akan name for a boy born on a friday.\n nice to meet you, *kofi*" } }; } });
  assert.equal(line, "kofi is an akan name for a boy born on a friday. nice to meet you, kofi");
  assert.equal(asked.prompt, "Their name: Kofi");
  assert.match(asked.system, /Never invent a meaning/);
  assert.match(asked.system, /not really a name .* leave it out and just say nice to meet you/);
  assert.match(asked.system, /No question in it/);
  assert.equal(await ob.nameLine({ name: "Kofi", ask: async () => { throw new Error("down"); } }), null, "no line: the caller says MET");
  assert.equal(await ob.nameLine({ name: "", ask: async () => ({ value: { line: "x" } }) }), null);
});

test("no line from the model on their name: a plain nice to meet you, never a made-up meaning", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  h.gaps.length = 0;
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  assert.deepEqual(words(h, num).slice(before), STEP2("Kofi"));
  assert.ok(!to(h, num).some(m => m.media), "the card waits for the name they pick");
  assert.equal(db.getAccount(conv(num)).name, "Kofi");
  assert.equal(db.getAccount(conv(num)).contact_card_sent_at ?? null, null);
  assert.equal(state(num), "awaiting_card_name");
  assert.equal(h.gaps.length, 1);
  for (const g of h.gaps) assert.ok(g >= 1000 && g <= 2000, `gap ${g}`);
  // Nothing else is asked: no job, no to-do list, no list of features.
  assert.ok(!words(h, num).some(t => /what do you do|to-do|student, engineer/i.test(t)));
});

test("they would rather not give a name: not pushed, the flow carries on, and the prompt stops asking", async () => {
  const h = harness({ ...GREET, "rather not say": { kind: "decline" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "rather not say"));
  assert.deepEqual(words(h, num).slice(before), STEP2(""));
  assert.equal(state(num), "awaiting_card_name");
  const prompt = systemFor(accounts.ownerOf(conv(num)));
  assert.match(prompt, /did not give it: do not ask again/);
  assert.doesNotMatch(prompt, /Early on, ask their name once/);
});

// ---------- step 3: the card under their name ----------

test("the name they pick: the card under THAT name, its line on the card's own message, then the one thing to try; done", async () => {
  const h = harness({ ...GREET, ...NAME, ...PICK });
  const num = newNumber();
  await toCardName(h, num);
  const before = to(h, num).length;
  const out = await h.router.deliver(text(num, "jarvis"));
  assert.equal(out.onboarding, "complete");
  const sent = to(h, num).slice(before);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, ob.CARD_SENT("Jarvis", true));
  assert.equal(sent[0].text, "Jarvis it is. here's my card, save it so you can always find me");
  assert.equal(sent[1].text, ob.TRY_LINE);
  assert.ok(!sent[1].media);
  assert.match(sent[0].media.url, /^https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}-[A-Za-z0-9_-]{16}\.vcf$/);
  const acct = db.getAccount(conv(num));
  assert.equal(acct.contact_card_name, "Jarvis");
  assert.ok(acct.contact_card_sent_at);
  assert.equal(state(num), "complete");
  assert.equal(h.turns.length, 0);
  // The card that address serves is saved under Jarvis, and still says Reason as the company.
  const file = cardFile(sent[0].media.url);
  assert.equal(file.status, 200);
  assert.match(file.body, /\r\nFN:Jarvis\r\n/);
  assert.match(file.body, /\r\nN:Jarvis;;;;\r\n/);
  assert.match(file.body, /\r\nORG:Reason\r\n/);
  assert.match(file.headers["Content-Disposition"], /filename="Jarvis\.vcf"/);
  // The model knows what happened, and that it is still Reason.
  const history = JSON.stringify(db.loadConversation(conv(num)));
  assert.match(history, /under the name they chose for it: Jarvis\. Saving it is up to them; Reason cannot touch their phone\. You are still Reason/);
  // The next text is an ordinary turn.
  await h.router.deliver(text(num, "what's the weather"));
  assert.equal(h.turns.length, 1);
});

test("skipping the name ('whatever', 'you pick'): the card as Reason", async () => {
  for (const [said, read] of [["whatever", { kind: "decline" }], ["you pick", { kind: "decline" }], ["sure", { kind: "answer", card_name: "" }]]) {
    const h = harness({ ...GREET, ...NAME, [said]: read });
    const num = newNumber();
    await toCardName(h, num);
    await h.router.deliver(text(num, said));
    const last = card(h, num);
    assert.equal(last.text, ob.CARD_SENT("Reason", false), said);
    assert.match(last.text, /^Reason it is\./);
    assert.equal(to(h, num).at(-1).text, ob.TRY_LINE);
    assert.equal(db.getAccount(conv(num)).contact_card_name, "Reason");
    assert.match(cardFile(last.media.url).body, /\r\nFN:Reason\r\n/);
    assert.equal(state(num), "complete");
  }
});

test("a detour on the card's name: its answer and one steer back; a second detour sends the card as Reason", async () => {
  const h = harness({ ...GREET, ...NAME, "why do i need it": { kind: "question", reply: "so my links open properly on your phone" }, "lol": { kind: "other", reply: "haha" } });
  const num = newNumber();
  await toCardName(h, num);
  let before = to(h, num).length;
  await h.router.deliver(text(num, "why do i need it"));
  assert.deepEqual(words(h, num).slice(before), ["so my links open properly on your phone", ob.STEERS.awaiting_card_name]);
  assert.equal(state(num), "awaiting_card_name");
  before = to(h, num).length;
  await h.router.deliver(text(num, "lol"));
  assert.deepEqual(plain(words(h, num).slice(before)), ["haha", `${ob.CARD_SENT("Reason", false)} [card]`, ob.TRY_LINE]);
  assert.equal(state(num), "complete");
});

test("no public address for the card: nothing to name, so no ask — the name met, then the one thing to try", async () => {
  config.publicUrl = "";
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi"));
  assert.deepEqual(words(h, num).slice(before), [ob.MET("Kofi"), ob.TRY_LINE]);
  assert.equal(state(num), "complete");
});

test("the card failing to send: its line goes with it, and the flow still ends", async () => {
  const h = harness({ ...GREET, ...NAME, ...PICK }, { channelOpts: { mediaFailWith: "media fetch failed" } });
  const num = newNumber();
  await toCardName(h, num);
  await h.router.deliver(text(num, "jarvis"));
  assert.ok(!words(h, num).some(t => t.startsWith("Jarvis it is")));
  assert.equal(db.getAccount(conv(num)).contact_card_sent_at ?? null, null);
  assert.equal(to(h, num).at(-1).text, ob.TRY_LINE, "the one thing to try still goes");
  assert.equal(state(num), "complete");
});

test("a later retry of a card that did not go keeps the name they picked", async () => {
  const { offerContactCard } = await import("../src/contact.js");
  const h = harness({ ...GREET, ...NAME, ...PICK }, { channelOpts: { mediaFailWith: "media fetch failed" } });
  const num = newNumber();
  await toCardName(h, num);
  await h.router.deliver(text(num, "jarvis"));
  assert.equal(db.getAccount(conv(num)).contact_card_sent_at ?? null, null);
  clock.skip(7 * 3_600_000);
  const sent = [];
  const r = await offerContactCard({ router: { get: () => h.channel, sendMediaUrl: async (m) => { sent.push(m); return { ok: true }; } }, account: db.getAccount(conv(num)) });
  assert.equal(r.outcome, "sent");
  assert.match(sent[0].mediaUrl, /-[A-Za-z0-9_-]{16}\.vcf$/);
  assert.match(cardFile(sent[0].mediaUrl).body, /\r\nFN:Jarvis\r\n/);
});

test("the line not live: the step does not move and nothing is written as said", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const kept = h.channel.status.bind(h.channel);
  h.channel.status = () => ({ ...kept(), status: "not_connected" });
  await h.router.deliver(text(num, "kofi"));
  h.channel.status = kept;
  assert.equal(state(num), "awaiting_name");
  assert.doesNotMatch(JSON.stringify(db.loadConversation(conv(num))), /call me/);
});

// ---------- a real request first ----------

test("a real request as the very first text: done first by the turn, THEN the name is asked — never kept waiting", async () => {
  const h = harness({ "remind me to call my mom at 5": { kind: "task" }, ...NAME, ...PICK }, { reply: "done, i'll remind you at 5" });
  const num = newNumber();
  await h.router.deliver(text(num, "remind me to call my mom at 5"));
  assert.equal(h.turns.length, 1);
  assert.match(h.turns[0].text, /remind me to call my mom at 5/);
  assert.deepEqual(words(h, num), ["done, i'll remind you at 5", ob.BY_THE_WAY, "what's your name?"], "the answer first, then who Reason is, then the name question in its own bubble");
  assert.equal(state(num), "awaiting_name");
  // Then the rest of the flow as normal.
  await h.router.deliver(text(num, "kofi"));
  assert.deepEqual(words(h, num).slice(3), STEP2("Kofi"));
  await h.router.deliver(text(num, "jarvis"));
  assert.equal(card(h, num).text, ob.CARD_SENT("Jarvis", true));
  assert.equal(h.turns.length, 1);
});

test("the turn's prompt during a request-first chat: no name ask, no interview, no feature list", () => {
  const prompt = systemFor({ name: "the person I work for", firstChat: "active" });
  assert.match(prompt, /just do what they asked/);
  assert.match(prompt, /Do not ask their name/);
  assert.doesNotMatch(prompt, /Early on, ask their name once|show them 3-4 things/);
  // And the account really reads as in the flow at that moment.
  const num = newNumber();
  db.upsertAccount({ conversationId: conv(num), channel: "fake", address: num });
  ob.begin(conv(num));
  assert.equal(accounts.ownerOf(conv(num)).firstChat, "active");
});

test("a request with their name in it: the name is kept, and after the turn who Reason is, the name met (the model's line), what to call Reason", async () => {
  const meaning = "Ama is an akan name for a girl born on saturday. a weekend person, love that";
  const h = harness((said) => said === "hey it's ama, what's 15% of 80" ? { kind: "task", name: "Ama" } : said === "Their name: Ama" ? { line: meaning } : null, { reply: "12" });
  const num = newNumber();
  await h.router.deliver(text(num, "hey it's ama, what's 15% of 80"));
  assert.deepEqual(words(h, num), ["12", ob.BY_THE_WAY, meaning, ob.CARD_NAME_ASK]);
  assert.equal(db.getAccount(conv(num)).name, "Ama");
  assert.equal(state(num), "awaiting_card_name");
});

test("a request on the card step: the turn, then one steer; a second request, the turn, then the card as Reason", async () => {
  const h = harness({ ...GREET, ...NAME, "find me a coffee spot": { kind: "task" }, "and one for lunch": { kind: "task" } }, { reply: "here's one" });
  const num = newNumber();
  await toCardName(h, num);
  let before = to(h, num).length;
  await h.router.deliver(text(num, "find me a coffee spot"));
  assert.deepEqual(words(h, num).slice(before), ["here's one", ob.STEERS.awaiting_card_name]);
  before = to(h, num).length;
  await h.router.deliver(text(num, "and one for lunch"));
  assert.deepEqual(plain(words(h, num).slice(before)), ["here's one", `${ob.CARD_SENT("Reason", false)} [card]`, ob.TRY_LINE]);
  assert.equal(state(num), "complete");
  assert.equal(h.turns.length, 2);
});

test("a picture is something real: the turn first, then the step", async () => {
  const h = harness(GREET, { reply: "nice pic" });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "", { attachments: [{ kind: "image", url: "https://cdn.example.test/p.jpg", media_id: 2 }] }));
  assert.equal(h.turns.length, 1);
  assert.deepEqual(words(h, num).slice(2), ["nice pic", ob.STEERS.awaiting_name]);
});

// ---------- detours and failures ----------

test("a detour on the name step: answer and one steer; a second moves on — the name is asked twice at most", async () => {
  const h = harness({ ...GREET, "who made you?": { kind: "question", reply: "Saafi Interactions Lab built me" }, "lol": { kind: "other", reply: "haha" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  let before = to(h, num).length;
  await h.router.deliver(text(num, "who made you?"));
  assert.deepEqual(words(h, num).slice(before), ["Saafi Interactions Lab built me", ob.STEERS.awaiting_name]);
  before = to(h, num).length;
  await h.router.deliver(text(num, "lol"));
  assert.deepEqual(words(h, num).slice(before), ["haha", ...STEP2("")]);
  assert.equal(state(num), "awaiting_card_name");
});

test("the read failing: the flow ends, the normal turn answers, and the prompt never starts an interview", async () => {
  const h = harness({ ...GREET });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "something the read cannot place"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
  const prompt = systemFor(accounts.ownerOf(conv(num)));
  assert.doesNotMatch(prompt, /Early on, ask their name once|what do you do|show them 3-4 things/);
  await h.router.deliver(text(num, "kofi"));
  assert.equal(h.turns.length, 2);
  assert.ok(!words(h, num).some(t => t.startsWith("nice to meet you")));
});

test("the read failing on the very first text: the turn answers it; the prompt asks the name once, nothing more", async () => {
  const h = harness({});
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
  const prompt = systemFor(accounts.ownerOf(conv(num)));
  assert.match(prompt, /Ask their name once, naturally/);
  assert.doesNotMatch(prompt, /what do you do|show them 3-4 things/);
});

test("the harm screen runs beside the read: anything not clear goes to the normal, screened turn and ends the flow", async () => {
  const screen = async ({ text: t }) => (/end it/.test(t) ? { verdict: "crisis", category: "self_harm" } : { verdict: "clear" });
  const h = harness({ ...GREET, "kofi, honestly been wanting to end it": { kind: "answer", name: "Kofi" } }, { screen });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "kofi, honestly been wanting to end it"));
  assert.ok(!words(h, num).slice(before).some(t => t.startsWith("nice to meet you")));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
});

test("a screen that could not run is asked once more; clear the second time, the flow goes on", async () => {
  let calls = 0;
  const h = harness(GREET, { screen: async () => (++calls === 1 ? { verdict: "unscreened", error: "timed out" } : { verdict: "clear" }) });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  assert.equal(calls, 2);
  assert.equal(state(num), "awaiting_name");
});

test("a voice note is words by the time the flow reads it", async () => {
  const h = harness({ ...GREET, "it's kwame": { kind: "answer", name: "Kwame" } });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const before = to(h, num).length;
  h.router.hear = async () => "it's kwame";
  await h.router.deliver(text(num, "", { attachments: [{ kind: "voice", url: "https://cdn.example.test/v.caf" }] }));
  assert.equal(words(h, num)[before], "nice to meet you, Kwame");
  assert.equal(h.turns.length, 0);
});

// ---------- who is in it ----------

test("existing users are unaffected: an account that already existed never enters, and gets the ordinary turn", async () => {
  const h = harness({ ...GREET, ...NAME });
  const old = newNumber();
  db.upsertAccount({ conversationId: conv(old), channel: "fake", address: old, name: "Yaw" });
  await h.router.deliver(text(old, "hey"));
  assert.equal(state(old), null);
  assert.equal(h.turns.length, 1);
  assert.ok(!words(h, old).some(t => ob.OPENER.includes(t) || t === ob.CARD_NAME_ASK));
  // Even with no name on it.
  const nameless = newNumber();
  db.upsertAccount({ conversationId: conv(nameless), channel: "fake", address: nameless, name: "" });
  await h.router.deliver(text(nameless, "hey"));
  assert.equal(state(nameless), null);
  assert.equal(h.turns.length, 2);
  assert.equal(accounts.ownerOf(conv(nameless)).firstChat, null, "their prompt is the one it always was");
});

test("finished, operator and uncovered people never enter it", async () => {
  const h = harness({ ...GREET, ...NAME, ...PICK });
  const done = newNumber();
  await toCardName(h, done);
  await h.router.deliver(text(done, "jarvis"));
  assert.equal(state(done), "complete");
  await h.router.deliver(text(done, "hey"));
  assert.equal(h.turns.length, 1);
  assert.equal(ob.begin(conv(done)), false);
  db.setOnboarding(conv(done), { state: "not_started" });
  assert.equal(state(done), "complete");

  await h.router.deliver(text(MASTER, "hey"));
  assert.equal(db.getAccount(config.ownerConversation).onboarding ?? null, null);

  config.onboarding = "off";
  const off = newNumber();
  await h.router.deliver(text(off, "hey"));
  assert.equal(state(off), null);
  assert.equal(h.turns.length, 3);
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
  assert.equal(h.turns.length, 1);
});

test("somebody left mid-way through the old, longer flow is not walked through it: it ends, and they get a turn", async () => {
  const h = harness(GREET);
  const num = newNumber();
  db.upsertAccount({ conversationId: conv(num), channel: "fake", address: num, name: "Esi" });
  db.db.prepare("UPDATE accounts SET onboarding = 'awaiting_occupation', onboarding_at = ? WHERE conversation_id = ?").run(clock.now(), conv(num));
  await h.router.deliver(text(num, "hey"));
  assert.equal(h.turns.length, 1);
  assert.equal(state(num), "complete");
});

// ---------- the card: privacy and the startup pass ----------

test("one person's card address draws only their own pick; an unknown token draws the plain card", async () => {
  const h = harness({ ...GREET, ...NAME, ...PICK, "my guy": { kind: "answer", card_name: "My Guy" } });
  const a = newNumber(), b = newNumber();
  await toCardName(h, a);
  await h.router.deliver(text(a, "jarvis"));
  await toCardName(h, b);
  await h.router.deliver(text(b, "my guy"));
  const ua = card(h, a).media.url, ub = card(h, b).media.url;
  assert.notEqual(ua, ub);
  const fa = cardFile(ua).body, fb = cardFile(ub).body;
  assert.match(fa, /FN:Jarvis/); assert.doesNotMatch(fa, /My Guy|Kofi|\+1415/);
  assert.match(fb, /FN:My Guy/); assert.doesNotMatch(fb, /Jarvis/);
  const unknown = cardFile(ua.replace(/-[A-Za-z0-9_-]{16}\.vcf$/, "-AAAAAAAAAAAAAAAA.vcf")).body;
  assert.match(unknown, /\r\nFN:Reason\r\n/);
  // Nothing of the person is in the address: the hash and a random token.
  assert.doesNotMatch(ua, /jarvis|kofi|1415/i);
});

test("the startup card pass never sends the plain card to somebody mid-flow; it does once they are through", async () => {
  const h = harness({ ...GREET });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  await backfillContactCards({ router: h.router });
  assert.ok(!to(h, num).some(m => m.media));
  ob.finish(conv(num));
  await backfillContactCards({ router: h.router });
  assert.ok(to(h, num).some(m => m.media), "after the flow, the ordinary card pass covers them");
});

// ---------- restart, and the one nudge ----------

test("the step survives a restart: a new router and runtime pick it up where it was", async () => {
  const h1 = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await toCardName(h1, num);
  assert.equal(state(num), "awaiting_card_name");
  const h2 = harness(PICK);
  await h2.router.deliver(text(num, "jarvis"));
  assert.equal(words(h2, num).length, 2);
  assert.equal(to(h2, num)[0].text, ob.CARD_SENT("Jarvis", true));
  assert.equal(h2.turns.length, 0);
  assert.equal(state(num), "complete");
});

test("going quiet: one nudge later on the timer system, never at night, never twice", async () => {
  const h = harness({ ...GREET, ...NAME });
  const num = newNumber();
  await h.router.deliver(text(num, "hey"));
  const nudges = () => db.db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND label = ?").all(conv(num), db.ONBOARDING_NUDGE_LABEL);
  assert.equal(nudges().length, 1);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(nudges()[0].fire_at));
  assert.ok(hour >= 10 && hour < 21, `nudge at ${hour}h`);
  await h.router.deliver(text(num, "kofi"));
  assert.equal(nudges().filter(t => !t.cancelled_at).length, 1);

  // Quiet: it fires once, at its time, with the pending step's line. (Its time, not two days on:
  // a timer more than config.timerLateMs past its moment is skipped, never sent late.)
  clock.skip(nudges().find(t => !t.cancelled_at).fire_at - clock.now() + 60_000);
  const before = to(h, num).length;
  await h.runtime.tick();
  assert.deepEqual(words(h, num).slice(before), [ob.NUDGES.awaiting_card_name]);
  assert.equal(ob.scheduleNudge(conv(num)), null);
  await h.runtime.tick();
  assert.equal(to(h, num).length, before + 1);
});

test("the night rule: a nudge due at 11pm lands at 10am", () => {
  const at = Date.parse("2026-11-03T04:00:00Z");
  assert.equal(new Date(ob.wakingHour(at, "America/New_York")).toISOString(), "2026-11-03T15:00:00.000Z");
  const day = Date.parse("2026-11-03T17:00:00Z");
  assert.equal(ob.wakingHour(day, "America/New_York"), day);
});

test("the read is code-called with the step's question, never a keyword match; the maker is the company", async () => {
  const h = harness({ ...GREET, ...NAME, ...PICK });
  const num = newNumber();
  await toCardName(h, num);
  await h.router.deliver(text(num, "jarvis"));
  assert.equal(h.asked.length, 3);
  assert.match(h.asked[0].system, /very first text/);
  assert.match(h.asked[1].system, /asked their name/);
  assert.match(h.asked[2].system, /asked what they want to call it/);
  for (const a of h.asked) {
    assert.match(a.system, /Saafi Interactions Lab/);
    assert.doesNotMatch(a.system, /Omarion|Nyarko/);
  }
  for (const line of FIXED()) {
    assert.doesNotMatch(line, /["“”]/, `no quoted words for them to type: ${line}`);
  }
});

// ---------- owner pins, 2026-11-06 ----------

const FIXED = () => [ob.INTRO, ...ob.OPENER, ob.BY_THE_WAY, ...ob.NAME_ASK, ob.NAME_Q, ob.MET("Kofi"), ob.MET(""), ob.CARD_NAME_ASK, ob.CARD_SENT("X", true), ob.CARD_SENT("Reason", false), ob.TRY_LINE, ...Object.values(ob.STEERS), ...Object.values(ob.NUDGES)];
const PHONE_CONTROL = /save (myself|me) (in|to|into) your|in your (contacts|phone)|i'?ll save|i saved|already saved|added (myself|me)|i'?m in your|on your phone|your phone/i;

test("pin: nothing in the first chat asks what they do — not a bubble, not the read, not any prompt", () => {
  for (const line of FIXED()) assert.doesNotMatch(line, /what do you do/i, line);
  for (const st of ob.STATES) assert.doesNotMatch(ob.instructions(st), /what do you do/i);
  for (const me of [{ name: "" }, { name: "", firstChat: "active" }, { name: "", firstChat: "done" }, { name: "", nameAsked: true }]) {
    const p = systemFor(me);
    assert.doesNotMatch(p, /what do you do|ask what they do|show them 3-4 things/i, JSON.stringify(me));
  }
});

test("pin: no wording that says Reason controls their phone or is already in their contacts", () => {
  for (const line of FIXED()) assert.doesNotMatch(line, PHONE_CONTROL, line);
  assert.match(ob.CARD_SENT("Jarvis", true), /save it/, "the card invites them to save it themselves");
  // The read and the stand-alone prompt both forbid it.
  assert.match(ob.instructions("awaiting_card_name"), /Never say Reason saves itself in their phone, is in their contacts/);
  assert.match(systemFor({ name: "" }), /Never say you save yourself in their phone or are in their contacts/);
});

test("pin: the one nudge names a call Reason can make for them and an event, and never a call to chat with them", () => {
  assert.match(ob.TRY_LINE, /make a call for you/);
  assert.match(ob.TRY_LINE, /restaurant/);
  assert.match(ob.TRY_LINE, /set up and run an event/);
  assert.doesNotMatch(ob.TRY_LINE, /call you|chat/i);
  assert.equal((ob.TRY_LINE.match(/\?/g) ?? []).length, 1, "one question");
  assert.match(systemFor({ name: "" }), /Never offer to call them to chat/);
});

test("pin: one question per message across the fixed bubbles", () => {
  for (const line of FIXED()) assert.ok((line.match(/\?/g) ?? []).length <= 1, line);
});

test("an invite's joiner gets the same first chat, right after the inviter's welcome line", async () => {
  const invites = await import("../src/invites.js");
  config.autoAdmit = false;
  const inviter = newNumber();
  db.upsertAccount({ conversationId: conv(inviter), channel: "fake", address: inviter, name: "Yaw" });
  db.backfillInviteAllowances();
  const made = invites.makeLink(conv(inviter));
  assert.ok(made.ok, JSON.stringify(made));
  const code = db.getInvite(conv(inviter), made.number).claim_code;
  const hello = invites.joinText(code);
  const h = harness((said) => said === hello ? { kind: "greeting" } : said === "kofi" ? { kind: "answer", name: "Kofi" } : said === "jarvis" ? { kind: "answer", card_name: "Jarvis" } : null);
  const num = newNumber();
  await h.router.deliver(text(num, hello));
  const got = words(h, num);
  assert.match(got[0], /^You're in, invited by/);
  assert.deepEqual(got.slice(1, 3), ob.OPENER);
  assert.equal(h.turns.length, 0, "the flow answers, not a turn");
  assert.equal(state(num), "awaiting_name");
  await h.router.deliver(text(num, "kofi"));
  assert.equal(to(h, num).at(-1).text, ob.CARD_NAME_ASK);
  await h.router.deliver(text(num, "jarvis"));
  assert.equal(card(h, num).text, ob.CARD_SENT("Jarvis", true));
  assert.equal(to(h, num).at(-1).text, ob.TRY_LINE);
  assert.equal(state(num), "complete");
});
