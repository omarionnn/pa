// One thought, one answer, with the REAL model (opt-in: skipped with no model reachable, like every
// flow-*.test.js — see test/live.js).
//
//   1. The mid-turn reader (src/onethought.js classify) on the incident and a few continuation,
//      new-request and chat cases. Asserts the kind only, and logs the time each read took.
//   2. The incident replayed end to end on the fake channel: "No I want to watch when I leave work so
//      somewhere around work", then "And I'd watch it on Tuesday" while that is being answered. One
//      reply, and it is about Tuesday. Asserts counts and the day, never wording.
//
// The reader runs over the API when the account answers, else — on the claude-cli backend — through
// the CLI, exactly as live does. The log line says which.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-onethought-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const onethought = await import("../src/onethought.js");
const { config } = await import("../src/config.js");
const { skip, label } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM pending_inbound;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  // Their contact card went long ago: the one-time "save me as a contact" is not part of this.
  db.db.prepare("UPDATE accounts SET contact_card_sent_at = ? WHERE conversation_id = ?").run(Date.now(), C);
});

const MOVIE = "I'll have a night shift on Monday from 8pm to 8am. Check for the movie then";
const WORK = "No I want to watch when I leave work so somewhere around work";
const CASES = [
  { request: `${MOVIE}\n${WORK}`, text: "And I'd watch it on Tuesday", want: ["continuation"] },
  { request: MOVIE, text: WORK, want: ["continuation"] },
  { request: "book carbone friday 8pm for me and kofi", text: "make it 3 people", want: ["continuation"] },
  { request: "find me a flight to accra on the 14th", text: "actually the 15th works better", want: ["continuation"] },
  { request: `${MOVIE}\n${WORK}`, text: "also what's the weather sunday", want: ["new"] },
  { request: "find me a flight to accra on the 14th", text: "remind me to call my mom at 6", want: ["new"] },
  { request: "find me a flight to accra on the 14th", text: "thanks!!", want: ["chat"] },
  { request: "what's a good dinner spot near union square", text: "lol you're the best", want: ["chat"] },
];

const times = [];
for (const c of CASES) {
  test(`mid-turn read: ${JSON.stringify(c.text)} → ${c.want.join("|")}`, { skip }, async () => {
    const r = await onethought.classify({ request: c.request, text: c.text });
    times.push(r.ms);
    console.log(JSON.stringify({ text: c.text, kind: r.kind, via: r.via, ms: r.ms, ...(r.why ? { why: r.why } : {}) }));
    assert.notEqual(r.via, "fallback", `the reader did not answer: ${r.why}`);
    assert.ok(c.want.includes(r.kind), `read as ${r.kind}`);
  });
}

test("mid-turn read latency", { skip }, () => {
  const s = [...times].sort((a, b) => a - b);
  console.log(JSON.stringify({ reads: s.length, p50_ms: s[Math.floor(s.length / 2)], max_ms: s.at(-1), model: label }));
});

const tick = () => new Promise(r => setTimeout(r, 50));

test("the incident, replayed: two bubbles 12s apart, the second mid-turn → ONE reply, about Tuesday", { skip, timeout: 600_000 }, async () => {
  config.burstQuietMs = 500;
  const logs = [];
  const rt = new Runtime({ log: (e) => { logs.push(e); if (e.tool || e.midturn || e.folded || e.draft_superseded) console.log(JSON.stringify(e).slice(0, 240)); } });
  const router = new Router({ runtime: rt, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  try {
    // Some of the thread before it, as it stood: the movie and the shift.
    db.saveConversation(C, [
      { role: "user", content: `[Sat, Oct 24, 2026, 3:04 PM] Omari: is "You Can See Everything" showing in nyc this week?` },
      { role: "assistant", content: "It is — AMC Bay Plaza and Alamo Drafthouse Lower Manhattan both have it this week." },
      { role: "user", content: `[Sat, Oct 24, 2026, 3:05 PM] Omari: ${MOVIE}` },
      { role: "assistant", content: "Monday's times aren't posted yet at Bay Plaza. If they look like today's, an 11:30am or 2:30pm would get you out in time for your 8pm start." },
    ]);
    const t0 = Date.now();
    const first = router.deliver({ channel: "fake", externalId: "R-1", from: OWNER, text: WORK, service: "iMessage" });
    // The second bubble lands once the turn is working.
    while (!onethought.activeFor(C) && Date.now() - t0 < 60_000) await tick();
    await new Promise(r => setTimeout(r, 4_000));
    await router.deliver({ channel: "fake", externalId: "R-2", from: OWNER, text: "And I'd watch it on Tuesday", service: "iMessage" });
    await first;
    while (router.waiting.has(C)) await tick();
    console.log(JSON.stringify({ sent: fake.sent.map(m => m.text), ms: Date.now() - t0, model: label }));
    assert.equal(fake.sent.length, 1, "one reply to one thought");
    assert.match(fake.sent[0].text, /tues/i, "and it answers for Tuesday");
    assert.ok(logs.some(l => l.folded === "R-2"), "the second bubble was folded into the running turn");
  } finally { await rt.shutdown(); }
});
