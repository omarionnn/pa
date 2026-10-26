// Reason's new number, told once to the people who knew the old one (src/linechange.js).
// No model, no network: the turn is a stub, the channel is the fake one wearing sendblue's name.
//
//   does somebody who texted the old line get the card, then the line, then their answer — once?
//   does a duplicate webhook, or two texts landing together, still make it once?
//   are brand-new people and the owner left alone?
//   does a card that fails still send the line, and count as done?
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-linechange-"));
process.env.REASON_DATA_DIR = dir;
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_BURST_QUIET_MS = "0";
delete process.env.REASON_LINE_CHANGE_AT;

const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { LINE_CHANGE_LINE, isReturning } = await import("../src/linechange.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";   // texted the old line
const AMA = "+14155550111";    // first texted after the switch
const LINE = "+16562167455";
const CUTOFF = Date.parse("2026-10-23T15:50:00Z");
const CARD = /^https:\/\/reason\.example\.test\/reason-[0-9a-f]{8}\.vcf$/;
const conv = (n) => `dm:sendblue:${n}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  // Everything but the owner's row, which the migration wrote and nothing here should need to.
  db.db.exec("DELETE FROM accounts; DELETE FROM outbox; DELETE FROM threads; DELETE FROM conversations; DELETE FROM inbound_messages; DELETE FROM usage; DELETE FROM line_change_cards WHERE conversation_id != 'dm:owner';");
  for (const [c, n, name, op] of [["dm:owner", OWNER, "Omari", true], [conv(KOFI), KOFI, "Kofi", false], [conv(AMA), AMA, "Ama", false]]) {
    db.upsertAccount({ conversationId: c, channel: "sendblue", address: n, name, isOperator: op });
    db.db.prepare("UPDATE accounts SET contact_card_sent_at = ? WHERE conversation_id = ?").run(CUTOFF - 1000, c);
  }
  // Their history: Kofi and the owner on the old line, Ama only after it was gone.
  const old = (c, id, at) => db.db.prepare("INSERT INTO inbound_messages (channel, external_id, conversation_id, received_at) VALUES ('sendblue', ?, ?, ?)").run(id, c, at);
  old(conv(KOFI), "old-k", CUTOFF - 3 * 24 * 3600_000);
  old("dm:owner", "old-o", CUTOFF - 3600_000);
  old(conv(AMA), "new-a", CUTOFF + 60_000);
});

function harness({ mediaFailWith = null } = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({ runTurn: async ({ conversationId, text }) => { turns.push({ conversationId, text }); return `answer to: ${text}`; } });
  const router = new Router({ runtime, log: (e) => logs.push(e), timers: { set: (fn) => { fn(); return 0; }, clear: () => {} } });
  const channel = new FakeChannel({ number: LINE, mediaFailWith });
  channel.name = "sendblue";
  router.register(channel);
  const consoleChannel = router.register(new ConsoleChannel({ write: () => {} }));
  // The real reply path, so the answer is a message on the channel like the card and the line.
  runtime.deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e) });
  return { router, channel, turns, logs };
}

const texts = (from, body, id = String(Math.random())) => ({ channel: "sendblue", externalId: id, from, text: body, at: clock.now() });
const cardsTo = (ch, to) => ch.sent.filter(m => m.to === to && m.media?.url);
const linesTo = (ch, to) => ch.sent.filter(m => m.to === to && m.text === LINE_CHANGE_LINE);

test("the line is one or two short sentences, says to add to the existing Reason contact, and names nobody", () => {
  assert.match(LINE_CHANGE_LINE, /new number/);
  assert.match(LINE_CHANGE_LINE, /Add to Existing Contact → Reason/);
  assert.doesNotMatch(LINE_CHANGE_LINE, /omari/i);
  assert.ok((LINE_CHANGE_LINE.match(/[.!?](\s|$)/g) ?? []).length <= 2, LINE_CHANGE_LINE);
  assert.ok(LINE_CHANGE_LINE.length < 220);
  assert.equal(config.lineChangeAt, CUTOFF, "the cutoff defaults to the switch");
});

test("a returning person gets the card, then the line, then their answer — and only the first time", async () => {
  const h = harness();
  assert.equal(isReturning(conv(KOFI)), true);
  const r = await h.router.deliver(texts(KOFI, "yo you still there?", "k1"));
  assert.equal(r.ok, true);

  const toKofi = h.channel.sent.filter(m => m.to === KOFI);
  assert.equal(toKofi.length, 3, JSON.stringify(toKofi));
  assert.match(toKofi[0].media?.url ?? "", CARD, "the card first, by its content-addressed /reason-<sha8>.vcf");
  assert.equal(toKofi[0].text, "", "the card carries no words of its own");
  assert.equal(toKofi[1].text, LINE_CHANGE_LINE, "then the one line");
  assert.equal(toKofi[2].text, "answer to: yo you still there?", "then what they said, answered as normal");
  assert.equal(h.turns.length, 1);
  assert.match(h.turns[0].text, /yo you still there\?/);

  const row = db.getLineChangeCard(conv(KOFI));
  assert.ok(row.sent_at > 0);
  assert.equal(row.card_ok, 1);
  assert.equal(isReturning(conv(KOFI)), false);

  await h.router.deliver(texts(KOFI, "ok cool", "k2"));
  assert.equal(cardsTo(h.channel, KOFI).length, 1, "no second card");
  assert.equal(linesTo(h.channel, KOFI).length, 1, "no second line");
  assert.equal(h.turns.length, 2, "and the next text is just answered");
});

test("a duplicate webhook, and two texts landing together, still tell them once", async () => {
  const h = harness();
  await h.router.deliver(texts(KOFI, "hey", "dup"));
  const again = await h.router.deliver(texts(KOFI, "hey", "dup"));
  assert.equal(again.duplicate, true);
  assert.equal(cardsTo(h.channel, KOFI).length, 1);
  assert.equal(linesTo(h.channel, KOFI).length, 1);
  assert.equal(h.turns.length, 1);

  // Same person, a fresh start, two different texts delivered at once.
  db.db.exec(`DELETE FROM line_change_cards WHERE conversation_id = '${conv(KOFI)}'; DELETE FROM outbox;`);
  const h2 = harness();
  // A card that takes a moment, as a real one does: Sendblue fetches the .vcf before it answers.
  const send = h2.channel.sendMediaUrl.bind(h2.channel);
  h2.channel.sendMediaUrl = async (a) => { await new Promise(r => setTimeout(r, 30)); return send(a); };
  await Promise.all([h2.router.deliver(texts(KOFI, "one", "c1")), h2.router.deliver(texts(KOFI, "two", "c2"))]);
  assert.equal(cardsTo(h2.channel, KOFI).length, 1, "one card for the burst");
  assert.equal(linesTo(h2.channel, KOFI).length, 1, "one line for the burst");
  const first = h2.channel.sent.findIndex(m => m.to === KOFI && /^answer to:/.test(m.text));
  const line = h2.channel.sent.findIndex(m => m.text === LINE_CHANGE_LINE);
  assert.ok(line >= 0 && line < first, "the answer does not overtake the card and line");

  // And the claim underneath it all: one winner per conversation, ever.
  db.db.exec("DELETE FROM line_change_cards WHERE conversation_id = 'dm:test-claim'");
  assert.equal(db.claimLineChangeCard("dm:test-claim"), true);
  assert.equal(db.claimLineChangeCard("dm:test-claim"), false);
});

test("brand-new people and the owner never get it", async () => {
  const h = harness();
  assert.equal(isReturning(conv(AMA)), false, "first texted after the switch");
  assert.equal(isReturning("dm:owner"), false, "marked done by the migration");
  assert.ok(db.getLineChangeCard("dm:owner"), "the owner's row is there from the start");
  const NEWBIE = "+14155550199";
  assert.equal(isReturning(conv(NEWBIE)), false, "never texted at all");

  await h.router.deliver(texts(AMA, "hi", "a1"));
  await h.router.deliver(texts(OWNER, "hey", "o1"));
  assert.equal(h.channel.sent.filter(m => m.media?.url).length, 0, "no card to anybody");
  assert.equal(h.channel.sent.filter(m => m.text === LINE_CHANGE_LINE).length, 0, "no line to anybody");
  assert.equal(h.turns.length, 2, "both just answered");
  assert.equal(db.getLineChangeCard(conv(AMA)), null);
});

test("a card that fails still sends the line, is marked done, and is not tried again", async () => {
  const h = harness({ mediaFailWith: "Sendblue could not fetch the file" });
  await h.router.deliver(texts(KOFI, "you there", "f1"));
  assert.equal(cardsTo(h.channel, KOFI).length, 0);
  assert.equal(linesTo(h.channel, KOFI).length, 1, "the line goes anyway");
  assert.ok(h.channel.sent.some(m => m.to === KOFI && m.text === "answer to: you there"), "and they are answered");
  const row = db.getLineChangeCard(conv(KOFI));
  assert.equal(row.card_ok, 0);
  assert.match(row.card_why, /could not fetch/);
  assert.ok(h.logs.some(l => l.line_change_told === conv(KOFI) && l.card === "failed"));

  await h.router.deliver(texts(KOFI, "hello?", "f2"));
  assert.equal(linesTo(h.channel, KOFI).length, 1, "done is done — no retry on the next text");
  assert.equal(h.turns.length, 2);
});
