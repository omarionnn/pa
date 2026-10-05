// "Oh btw you can connect your gmail now" — said once, to the right person, and only about
// something that really works. No model, no network.
//
// Every question here is about what must NOT happen, because the cost of being wrong is a promise
// Reason cannot keep:
//
//   is something nobody has tried ever mentioned?          (no — no verified record, no offer)
//   is something not plumbed in here ever mentioned?       (no — the capability must be live for them)
//   can one person hear the same thing twice?              (no — a committed row per person per entry)
//   does the model skipping it lose it?                    (no — it stays unheard and comes back)
//   is it ever said on a reply nobody asked for?           (no — event turns are never offered one)
//   can it land in the middle of waiting for a yes?        (no — an open confirmation holds it)
//   does a reply that never arrived count as heard?        (no — the claim is dropped)
//   does somebody who arrived after the feature hear it?   (no — it was already there for them)
//   can a person be told two new things in a day?          (no — one, counted from the table)
//   does the export carry it, and the delete remove it?    (yes, both)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-whatsnew-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const whatsnew = await import("../src/whatsnew.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const { exportData, deleteData } = await import("../src/data.js");
const { userMessageFor } = await import("../src/agent.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = "dm:owner";
const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const THEIRS = `dm:fake:${FRIEND}`;
const LINE = "+15122164639";
const DAY = 86_400_000;

/** The same day string accounts.today() produces, so test dates line up with the real comparison. */
const dayOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: config.tz });

after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A verified entry, injected rather than added to the real list: a verified record is somebody
 * saying they watched the thing work, and a test must not be able to make that claim. `capability`
 * is what decides whether it is live — "plan" always is, "email" never is on this machine.
 */
const live = (over = {}) => ({
  id: "new-thing",
  capability: "plan",
  what: "they can do the new thing now",
  verified: { on: dayOf(clock.now() - 2 * DAY), evidence: "used it end to end on the live Reason" },
  ...over,
});
const second = () => live({ id: "other-thing", what: "they can do the other new thing now" });
const notPlumbedIn = () => live({ id: "email-thing", capability: "email", what: "they can read their email here now" });

const caps = (conversationId = C, extras = {}) => capabilitiesNow({ conversationId, ...extras });
const offer = (over = {}) => whatsnew.offerFor({ conversationId: C, capabilities: caps(), ...over });
const note = (over = {}) => whatsnew.noteFor({ conversationId: C, capabilities: caps(), ...over });

/** When this person's Reason started. Older than an entry's verified day means it is news to them. */
function arrived(conversationId, atMs) {
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(atMs, conversationId);
}

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM whats_new_told; DELETE FROM confirmations; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM outbox; DELETE FROM usage; DELETE FROM plans; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  arrived(C, clock.now() - 30 * DAY);
  arrived(THEIRS, clock.now() - 30 * DAY);
  config.burstQuietMs = 0;
  config.burstMaxMs = 0;
});

/** The server's own wiring: a real Runtime and the deliver function serve.js uses. */
function harness({ channel = {}, turn = async () => "ok" } = {}) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: turn, channels: router, deliver });
  router.runtime = runtime;
  router.register(consoleChannel);
  const fake = router.register(new FakeChannel({ number: LINE, ...channel }));
  db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
  return { runtime, router, fake, logs };
}

/** A turn that mentions the new thing and calls the tool, the way the model is told to. */
const mentionsIt = (id = "new-thing", said = "yeah friday works. oh btw u can do the new thing now") =>
  async ({ conversationId }) => {
    await runTool("whats_new_said", { id }, { conversationId });
    return said;
  };

// ---------- the gate ----------

test("the list that ships is clean: nothing verified without a date and real evidence", () => {
  assert.deepEqual(whatsnew.verifiedProblems(), []);
});

test("a half-filled verified record is caught rather than shipped", () => {
  const problems = whatsnew.verifiedProblems([
    { id: "blank", capability: "plan", what: "x", verified: { on: "", evidence: "" } },
    { id: "someday", capability: "plan", what: "x", verified: { on: "soon", evidence: "it worked" } },
    { id: "promised", capability: "plan", what: "x", verified: { on: "2026-10-01", evidence: "   " } },
  ]);
  assert.equal(problems.length, 4, problems.join(" | "));
  assert.ok(problems.some(p => p.startsWith("blank:") && /YYYY-MM-DD/.test(p)));
  assert.ok(problems.some(p => p.startsWith("blank:") && /evidence/.test(p)));
  assert.ok(problems.some(p => p.startsWith("someday:") && /YYYY-MM-DD/.test(p)));
  assert.ok(problems.some(p => p.startsWith("promised:") && /evidence/.test(p)));
});

test("Gmail ships with no verified record, so it is offered to nobody", () => {
  const gmail = whatsnew.ANNOUNCEABLE.find(e => e.id === "gmail");
  assert.ok(gmail, "the seeded entry is still there");
  assert.equal(gmail.capability, "email");
  assert.equal("verified" in gmail, false, "nothing for Gmail is built, so it must not carry a verified record");
  assert.equal(whatsnew.isVerified(gmail), false);

  // Against the real list, with a real conversation: nothing to say, to anybody.
  assert.equal(offer(), null);
  assert.equal(note(), "");
  assert.deepEqual(whatsnew.liveFor({ conversationId: C, capabilities: caps() }), []);
  assert.equal(whatsnew.offerFor({ conversationId: THEIRS, capabilities: caps(THEIRS) }), null);
});

test("a turn with nothing to announce never even asks what is plumbed in", () => {
  // This runs on every single message, and until somebody marks something verified the answer is
  // always no, so it has to cost nothing beyond a couple of cheap reads.
  let asked = 0;
  assert.equal(whatsnew.noteFor({ conversationId: C, capabilities: () => { asked++; return caps(); } }), "");
  assert.equal(asked, 0);
});

test("verified, but the capability is not live for this person: never offered", () => {
  const restore = whatsnew.withFeatures([notPlumbedIn()]);
  try {
    assert.equal(caps().find(c => c.name === "email").status, "not connected", "email really is not plumbed in here");
    assert.equal(offer(), null, "telling them about it would be a promise the tool then refuses");
    assert.equal(note(), "");
    assert.deepEqual(whatsnew.liveFor({ conversationId: C, capabilities: caps() }), []);
  } finally { restore(); }
});

test("verified and live: offered once, with the fact and the id the model needs", () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    assert.equal(offer()?.id, "new-thing");
    const n = note();
    assert.match(n, /they can do the new thing now/, "the fact is handed over for the model to phrase");
    assert.match(n, /whats_new_said with id "new-thing"/, "and how to record having said it");
    assert.match(n, /in passing/);
    assert.match(n, /Skip it entirely if the moment is wrong/, "the moment is the model's call");
  } finally { restore(); }
});

test("an open confirmation holds it: not on a turn where Reason is waiting on a yes", () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    assert.equal(offer()?.id, "new-thing");
    db.askConfirmation({
      conversationId: C, action: "browser_submit", summary: "book the 8:00 at lucali for 4",
      stakes: "money", target: "the 8:00 at lucali", askedAfterMsgs: 1,
    });
    assert.equal(offer(), null, "a second subject in that reply is how a yes lands on the wrong question");
    assert.equal(note(), "");
  } finally { restore(); }
});

test("never on a message Reason started itself", () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    // Timers, watchers, dropped threads, task wakes and page taps all arrive as event turns.
    assert.equal(offer({ kind: "event" }), null);
    assert.equal(note({ kind: "event" }), "");
    assert.equal(offer({ kind: "user" })?.id, "new-thing", "and an ordinary message still gets it");
  } finally { restore(); }
});

test("somebody whose Reason is newer than the feature does not hear it as new", () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    assert.equal(offer()?.id, "new-thing", "an account older than the verified day hears about it");
    arrived(C, clock.now()); // they turned up today; the entry was verified two days ago
    assert.equal(offer(), null, "it was already there when they arrived, so it is not news");

    // And it is per person: the older account still hears it.
    assert.equal(whatsnew.offerFor({ conversationId: THEIRS, capabilities: caps(THEIRS) })?.id, "new-thing");
  } finally { restore(); }
});

test("one a day, counted from the table rather than from the turn", () => {
  const restore = whatsnew.withFeatures([live(), second()]);
  try {
    db.claimWhatsNew({ conversationId: C, entryId: "new-thing" });
    assert.equal(db.markWhatsNewTold(C), "new-thing");

    assert.equal(offer(), null, "the other one waits, even though it is eligible");
    assert.equal(whatsnew.unheardFor({ conversationId: C, capabilities: caps() }).map(e => e.id).join(), "other-thing");

    clock.skip(DAY + 60_000);
    assert.equal(offer()?.id, "other-thing", "tomorrow it comes round");
  } finally { restore(); }
});

// ---------- the tool: the model's claim, checked ----------

test("the tool refuses an id that is not this person's to hear, and records nothing", async () => {
  const restore = whatsnew.withFeatures([live(), notPlumbedIn()]);
  try {
    for (const id of ["invented", "gmail", "email-thing"]) {
      const out = await runTool("whats_new_said", { id }, { conversationId: C });
      assert.equal(out.ok, false, `${id} should not be claimable`);
    }
    assert.deepEqual(db.whatsNewHeard(C), []);
    assert.equal(db.pendingWhatsNew(C), null, "and nothing is left waiting on the next reply either");
  } finally { restore(); }
});

test("at most one entry rides on one reply: a second claim replaces the first", async () => {
  const restore = whatsnew.withFeatures([live(), second()]);
  try {
    const { runtime, fake } = harness({
      turn: async ({ conversationId }) => {
        await runTool("whats_new_said", { id: "new-thing" }, { conversationId });
        await runTool("whats_new_said", { id: "other-thing" }, { conversationId });
        return "ok";
      },
    });
    await runtime.inbound(C, "hey");
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(db.whatsNewHeard(C), ["other-thing"], "one reply, one thing heard");
  } finally { restore(); }
});

// ---------- said, sent, written down ----------

test("said on a reply that goes out: heard once, and never offered again", async () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    const { runtime, fake } = harness({ turn: mentionsIt() });
    await runtime.inbound(C, "friday good?");

    assert.equal(fake.sent.length, 1, "the reply really left");
    assert.deepEqual(db.whatsNewHeard(C), ["new-thing"]);
    const row = db.db.prepare("SELECT * FROM whats_new_told WHERE conversation_id = ?").get(C);
    assert.ok(row.told_at, "told_at is set the moment the reply went");
    assert.ok(row.claimed_at <= row.told_at);

    // Tomorrow, with the day limit out of the way, there is still nothing to say to them.
    clock.skip(2 * DAY);
    assert.equal(offer(), null);
    await runtime.inbound(C, "and saturday?");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM whats_new_told WHERE conversation_id = ?").get(C).n, 1);
  } finally { restore(); }
});

test("the model skips it: still unheard, and offered again on a later reply", async () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    const { runtime, fake } = harness({ turn: async () => "ugh that sucks, sorry" });
    await runtime.inbound(C, "my flight got cancelled");

    assert.equal(fake.sent.length, 1);
    assert.deepEqual(db.whatsNewHeard(C), [], "nothing was said about it, so nothing is written down");
    assert.equal(db.pendingWhatsNew(C), null);
    assert.equal(offer()?.id, "new-thing", "it comes back round");
  } finally { restore(); }
});

test("a reply that could not be sent is not heard", async () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    const { runtime, fake } = harness({
      channel: { failWith: "that number is unreachable", retryable: false },
      turn: mentionsIt(),
    });
    await runtime.inbound(C, "friday good?");

    assert.equal(fake.sent.length, 0, "nothing arrived");
    assert.deepEqual(db.whatsNewHeard(C), [], "so nobody heard anything");
    assert.equal(db.pendingWhatsNew(C), null, "and the claim is gone rather than left to be committed later");
    assert.equal(offer()?.id, "new-thing");
  } finally { restore(); }
});

test("a turn that ends in silence does not count as having said it", async () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    const { runtime, fake } = harness({
      turn: async ({ conversationId }) => {
        await runTool("whats_new_said", { id: "new-thing" }, { conversationId });
        return null; // NO_REPLY
      },
    });
    await runtime.inbound(C, "k");
    assert.equal(fake.sent.length, 0);
    assert.deepEqual(db.whatsNewHeard(C), []);
    assert.equal(db.pendingWhatsNew(C), null);
  } finally { restore(); }
});

test("a claim left over from a turn that sent nothing is not committed by the next one", async () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    // A crash between the tool call and the send leaves a claim behind in the table.
    db.claimWhatsNew({ conversationId: C, entryId: "new-thing" });
    assert.ok(db.pendingWhatsNew(C));

    const { runtime, fake } = harness({ turn: async () => "morning" });
    await runtime.inbound(C, "hey");
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(db.whatsNewHeard(C), [], "this reply said nothing about it, so it is still unheard");
  } finally { restore(); }
});

test("one person hearing it is not another person hearing it", async () => {
  const restore = whatsnew.withFeatures([live()]);
  try {
    db.claimWhatsNew({ conversationId: C, entryId: "new-thing" });
    db.markWhatsNewTold(C);
    assert.deepEqual(db.whatsNewHeard(C), ["new-thing"]);
    assert.deepEqual(db.whatsNewHeard(THEIRS), []);
    assert.equal(whatsnew.offerFor({ conversationId: THEIRS, capabilities: caps(THEIRS) })?.id, "new-thing");
  } finally { restore(); }
});

// ---------- "what's new?" ----------

test("capabilities answers 'what's new' from the same list, verified and live only", async () => {
  const restore = whatsnew.withFeatures([live(), notPlumbedIn()]);
  try {
    const out = await runTool("capabilities", {}, { conversationId: C });
    assert.deepEqual(out.whats_new.map(e => e.id), ["new-thing"], "the unplumbed one is not on offer here");
    assert.equal(out.whats_new[0].what, "they can do the new thing now");
    assert.equal(out.whats_new[0].already_told_them, false);
    assert.match(out.note, /whats_new/);

    // Heard or not, it can still be answered when they ask outright.
    db.claimWhatsNew({ conversationId: C, entryId: "new-thing" });
    db.markWhatsNewTold(C);
    const after = await runTool("capabilities", {}, { conversationId: C });
    assert.deepEqual(after.whats_new.map(e => e.id), ["new-thing"]);
    assert.equal(after.whats_new[0].already_told_them, true);
  } finally { restore(); }
});

test("with nothing verified, capabilities says there is nothing new rather than naming Gmail", async () => {
  const out = await runTool("capabilities", {}, { conversationId: C });
  assert.deepEqual(out.whats_new, []);
});

// ---------- the note is true of one turn only, on both backends ----------

test("the note goes to the model and not into the thread's history", () => {
  const { forModel, forHistory } = userMessageFor({
    prefix: "[Mon Oct 5, 2026, 9:02 AM] Omari:", text: "friday good?",
    turnNote: "there is one new thing this person has not heard about yet",
  });
  assert.match(forModel.content, /one new thing/);
  assert.doesNotMatch(forHistory.content, /one new thing/,
    "a copy left in the history would go on asking for a line that has already been decided about");
  assert.match(forHistory.content, /friday good\?/, "what they actually said is kept");
});

test("both backends ask for the note, including the one the live Reason runs on", () => {
  // Asserted against the source, the way test/deploy.test.js checks src/config.js reads no file.
  // The claude-cli backend builds its own prompt and cannot be driven without the CLI, so this is
  // what stands between "it works on the API path" and the backend Reason is actually running.
  for (const file of ["../src/agent.js", "../src/backends/claude-cli.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /whatsnew\.noteFor\(/, `${file} must offer the note`);
    assert.match(src, /turnNote/, `${file} must put it in front of the model`);
  }
});

// ---------- your data ----------

test("the export carries what somebody was told, and a delete removes it", async () => {
  db.claimWhatsNew({ conversationId: C, entryId: "new-thing" });
  db.markWhatsNewTold(C);
  db.claimWhatsNew({ conversationId: THEIRS, entryId: "new-thing" });
  db.markWhatsNewTold(THEIRS);

  const all = exportData();
  assert.equal(all.tables.whats_new_told.length, 2);

  const ours = exportData({ conversation: C });
  assert.deepEqual(ours.tables.whats_new_told.map(r => r.conversation_id), [C], "a scoped export stays in one conversation");

  const out = await deleteData({ conversation: C });
  assert.equal(out.rows.whats_new_told, 1);
  assert.deepEqual(db.whatsNewHeard(C), []);
  assert.deepEqual(db.whatsNewHeard(THEIRS), ["new-thing"], "a scoped delete does not reach into another thread");

  await deleteData();
  assert.deepEqual(exportData().tables.whats_new_told, []);
});
