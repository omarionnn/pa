// The Amazon offer right after the contact card in the first chat (owner, 2026-11-10: Amazon, never
// email). Through the real router, outbox and database, with the model's read stated and the link
// stood in for (the real one is src/signin-remote.js, covered in test/signin-remote.test.js).
//
//   the card → one optional offer, no nudge ever
//   a yes (by the model's read) → what the link is, the link alone in its bubble, then the try line; done
//   a no → "no worries" and the try line; done, never asked again
//   a question about it → its answer, the offer still open but not asked again; a second detour lets it go
//   a real request → the turn does it, and the offer is let go silently
//   no public address, the switch off, or Amazon blocked → the card goes straight to the try line
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-onboarding-amazon-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_ONBOARDING;
process.env.REASON_INTRO_AMAZON = "on";

const ob = await import("../src/onboarding.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const remote = await import("../src/signin-remote.js");
const amazon = await import("../src/amazonconnect.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const MASTER = "+12025551234";
const LINE = "+16562167455";
const LINK = "https://heyreason.example/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
let n = 0;
const newNumber = () => `+1415556${String(1000 + (n++)).slice(-4)}`;
const conv = (num) => `dm:fake:${num}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  remote.forgetAllRemoteSignins();
  process.env.REASON_INTRO_AMAZON = "on";
  config.autoAdmit = true;
  config.onboarding = "on";
  config.onboardingNumbers = [];
  config.onboardingNudgeMin = 240;
  config.publicUrl = "https://reason.example.test";
  db.db.exec("DELETE FROM accounts; DELETE FROM access_requests; DELETE FROM usage; DELETE FROM conversations; DELETE FROM threads; DELETE FROM inbound_messages; DELETE FROM outbox; DELETE FROM timers; DELETE FROM people; DELETE FROM person_facts; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: MASTER, name: "Omari", isOperator: true });
});

function harness(reads = {}, { reply = "on it", link = async () => LINK } = {}) {
  const turns = [];
  const asked = [];
  const links = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return reply; } });
  const ask = async ({ prompt, system }) => {
    const said = prompt.replace(/^Their text, verbatim:\n/, "");
    asked.push({ said, system });
    const r = reads[said];
    if (!r) return { error: "no stated read" };
    return { value: { name: "", card_name: "", reply: "", name_line: "", amazon: "", ...r } };
  };
  const amazonLink = async (c, opts) => { links.push(c); return link(c, opts); };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {}, amazonLink } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  return { router, channel, turns, asked, links };
}

const text = (from, body) => ({ channel: "fake", externalId: `m${Math.random()}`, from, text: body, at: clock.now() });
const to = (h, num) => h.channel.sent.filter(m => m.to === num);
const state = (num) => db.getAccount(conv(num))?.onboarding ?? null;
const FLOW = { "hey": { kind: "greeting" }, "kofi": { kind: "answer", name: "Kofi" }, "jarvis": { kind: "answer", card_name: "Jarvis" } };
const nudges = (num) => db.db.prepare("SELECT * FROM timers WHERE conversation_id = ? AND label = ? AND cancelled_at IS NULL AND fired_at IS NULL").all(conv(num), db.ONBOARDING_NUDGE_LABEL);

async function toOffer(h, num) {
  await h.router.deliver(text(num, "hey"));
  await h.router.deliver(text(num, "kofi"));
  const before = to(h, num).length;
  const out = await h.router.deliver(text(num, "jarvis"));
  return { out, sent: to(h, num).slice(before) };
}

test("the card, then one optional Amazon offer in its own bubble: no email, no words to type, no nudge", async () => {
  const h = harness(FLOW);
  const num = newNumber();
  const { out, sent } = await toOffer(h, num);
  assert.equal(out.onboarding, "awaiting_amazon");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, ob.CARD_SENT("Jarvis", true));
  assert.ok(sent[0].media, "the card on its line's message");
  assert.equal(sent[1].text, amazon.OFFER);
  assert.ok(!sent[1].media);
  assert.equal(amazon.OFFER, "also, totally optional: if you shop on amazon, i can connect to your account so i can keep an eye on your orders and help you reorder the stuff you run out of. want the link?");
  for (const line of [amazon.OFFER, amazon.LINK_LINE, amazon.NO_LINE]) {
    assert.doesNotMatch(line, /email|gmail|outlook|inbox/i, "Amazon, never email (owner, 2026-11-10)");
    assert.doesNotMatch(line, /["“”'‘’](?![a-z])|\b(say|type|reply|text me)\b/i, "no phrase for them to say or type");
    assert.doesNotMatch(line, /contacts|your phone/i);
  }
  assert.equal((amazon.OFFER.match(/\?/g) ?? []).length, 1, "one question");
  assert.deepEqual(nudges(num), [], "the offer is never chased");
  assert.equal(h.turns.length, 0);
});

test("a yes, read by the model: what the link is, the link alone in its own bubble, then the try line; done", async () => {
  const h = harness({ ...FLOW, "ok sure": { kind: "answer", amazon: "yes" } });
  const num = newNumber();
  await toOffer(h, num);
  const before = to(h, num).length;
  const out = await h.router.deliver(text(num, "ok sure"));
  assert.equal(out.onboarding, "complete");
  const sent = to(h, num).slice(before).map(m => m.text);
  assert.deepEqual(sent, [amazon.LINK_LINE, LINK, ob.TRY_LINE]);
  assert.equal(amazon.LINK_LINE, "here you go. i'll text you a quick code to open it, then you sign in on amazon's own page. i never keep or see your password. once you're in, i'll be back shortly with a few ideas");
  assert.deepEqual(h.links, [conv(num)], "the link is made for them, once");
  assert.equal(state(num), "complete");
  assert.equal(h.turns.length, 0);
  // The read was told what the pending offer is and how to read a yes or a no.
  const sys = h.asked.at(-1).system;
  assert.match(sys, /offered \(optional\) to connect their Amazon account/);
  assert.match(sys, /"amazon": only when Reason last offered the Amazon link\. "yes" when they want it, however they say it/);
  // The next text is an ordinary turn.
  await h.router.deliver(text(num, "what's the weather"));
  assert.equal(h.turns.length, 1);
});

test("a no: one easy line and the try line; done, the link never made, never asked again", async () => {
  const h = harness({ ...FLOW, "nah i don't use amazon": { kind: "decline", amazon: "no" } });
  const num = newNumber();
  await toOffer(h, num);
  const before = to(h, num).length;
  const out = await h.router.deliver(text(num, "nah i don't use amazon"));
  assert.equal(out.onboarding, "complete");
  assert.deepEqual(to(h, num).slice(before).map(m => m.text), [`no worries. ${ob.TRY_LINE}`]);
  assert.deepEqual(h.links, []);
  await h.router.deliver(text(num, "what's the weather"));
  assert.equal(h.turns.length, 1, "after that, ordinary turns");
  assert.ok(!to(h, num).some(m => m.text === amazon.OFFER && to(h, num).indexOf(m) >= before));
});

test("a question about it: its answer, and the offer stays open without being asked again; then a yes still gets the link", async () => {
  const h = harness({ ...FLOW,
    "is that safe?": { kind: "question", reply: "yep, you sign in on amazon's own page and i never keep your password" },
    "ok go for it": { kind: "answer", amazon: "yes" } });
  const num = newNumber();
  await toOffer(h, num);
  let before = to(h, num).length;
  await h.router.deliver(text(num, "is that safe?"));
  assert.deepEqual(to(h, num).slice(before).map(m => m.text), ["yep, you sign in on amazon's own page and i never keep your password"], "the answer only, no re-ask");
  assert.equal(state(num), "awaiting_amazon");
  assert.deepEqual(nudges(num), []);
  before = to(h, num).length;
  await h.router.deliver(text(num, "ok go for it"));
  assert.deepEqual(to(h, num).slice(before).map(m => m.text), [amazon.LINK_LINE, LINK, ob.TRY_LINE]);
  assert.equal(state(num), "complete");
});

test("two detours: the second lets the offer go with the try line", async () => {
  const h = harness({ ...FLOW,
    "what's it for": { kind: "question", reply: "so i can see your orders and help you reorder" },
    "lol": { kind: "other", reply: "haha" } });
  const num = newNumber();
  await toOffer(h, num);
  await h.router.deliver(text(num, "what's it for"));
  const before = to(h, num).length;
  await h.router.deliver(text(num, "lol"));
  assert.deepEqual(to(h, num).slice(before).map(m => m.text), ["haha", ob.TRY_LINE]);
  assert.equal(state(num), "complete");
  assert.deepEqual(h.links, []);
});

test("a real request on the offer: the turn does it, and the offer is let go without a word", async () => {
  const h = harness({ ...FLOW, "remind me to call mom at 5": { kind: "task" } }, { reply: "done, i'll remind you at 5" });
  const num = newNumber();
  await toOffer(h, num);
  const before = to(h, num).length;
  await h.router.deliver(text(num, "remind me to call mom at 5"));
  assert.equal(h.turns.length, 1);
  assert.deepEqual(to(h, num).slice(before).map(m => m.text), ["done, i'll remind you at 5"]);
  assert.equal(state(num), "complete");
  assert.deepEqual(h.links, []);
});

test("the link cannot be made: said plainly, then the try line; done", async () => {
  const h = harness({ ...FLOW, "yes": { kind: "answer", amazon: "yes" } }, { link: async () => null });
  const num = newNumber();
  await toOffer(h, num);
  const before = to(h, num).length;
  await h.router.deliver(text(num, "yes"));
  assert.deepEqual(to(h, num).slice(before).map(m => m.text), ["hmm, i couldn't make the amazon link just now. ask me for it anytime", ob.TRY_LINE]);
  assert.equal(state(num), "complete");
});

test("no offer when it cannot be kept: the hook is off unless REASON_INTRO_AMAZON is on; no public address; the operator", async () => {
  delete process.env.REASON_INTRO_AMAZON;
  const h = harness(FLOW);
  const num = newNumber();
  const { out, sent } = await toOffer(h, num);
  assert.equal(out.onboarding, "complete");
  assert.deepEqual(sent.map(m => m.text), [ob.CARD_SENT("Jarvis", true), ob.TRY_LINE], "off by default: the card, then the try line, as before");
  assert.equal(ob.amazonOfferOn(), false);
  for (const v of ["on", "1", "true", "yes"]) { process.env.REASON_INTRO_AMAZON = v; assert.equal(ob.amazonOfferOn(), true, v); }
  assert.equal(ob.amazonCanOffer(conv(num)), true);
  config.publicUrl = "";
  assert.equal(amazon.available(conv(num)), false, "without a public address the link only opens on the server");
  config.publicUrl = "https://reason.example.test";
  assert.equal(amazon.available(config.ownerConversation), false, "never the operator");
  assert.equal(amazon.available("dm:fake:+19999999999"), false, "no account, no saved profile");
});

test("the real link: Reason's own sign-in link for Amazon, purpose intro, on the ledger, never the password", async () => {
  // No stand-in: handle's default makes the link through src/signin-remote.js (nothing launches until Start).
  const reads = { ...FLOW, "yes please": { kind: "answer", amazon: "yes" } };
  const runtime = new Runtime({ runTurn: async () => "on it" });
  const ask = async ({ prompt }) => {
    const r = reads[prompt.replace(/^Their text, verbatim:\n/, "")];
    return r ? { value: { name: "", card_name: "", reply: "", name_line: "", amazon: "", ...r } } : { error: "none" };
  };
  const router = new Router({ runtime, judge: async () => ({ verdict: "unclear" }), onboard: { ask, sleep: async () => {} } });
  const channel = router.register(new FakeChannel({ number: LINE }));
  runtime.turnExtras.channels = router;
  runtime.deliver = makeDeliver({ router, consoleChannel: new ConsoleChannel(), log: () => {} });
  const num = newNumber();
  for (const t of ["hey", "kofi", "jarvis"]) await router.deliver(text(num, t));
  const before = channel.sent.length;
  await router.deliver(text(num, "yes please"));
  const sent = channel.sent.slice(before).map(m => m.text);
  assert.equal(sent[0], amazon.LINK_LINE);
  assert.match(sent[1], /^https?:\/\/[^\s]+\/s\/[A-Za-z0-9_-]{32,64}$/, "the sign-in link, alone");
  assert.deepEqual(remote.remoteSessionFor(conv(num)), { site: "amazon", started: false }, "nothing launched before Start");
  // A link preview (no cookie) reads the "Connect Amazon" card, and nothing of theirs.
  const page = await remote.remoteRequest({ token: sent[1].split("/").pop(), method: "GET", headers: {}, query: {}, readBody: async () => "" });
  const head = String(page.body).split("</head>")[0];
  assert.match(head, /<meta property="og:title" content="Connect Amazon">/);
  assert.match(head, /\/web\/og\/secured\/amazon\.png/);
  assert.doesNotMatch(head, /Kofi|Jarvis|\+1415/);
  const ledger = db.db.prepare("SELECT action, target FROM action_ledger WHERE conversation_id = ?").all(conv(num));
  assert.ok(ledger.some(r => r.action === "signin_link" && r.target === "site:amazon"));
  assert.equal(state(num), "complete");
});
