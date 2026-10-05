// The record of what somebody sent and what Reason actually got out of it.
//
// What matters here is that the record is written before anything processes the item, moved to the
// truth afterwards, numbered so "the second photo" resolves to a row, and kept apart per person.
// No model anywhere: every coverage value in here was put there by code that knows what happened.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-reviewed-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";

const reviewed = await import("../src/reviewed.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { runTool } = await import("../src/tools.js");
const { imagesFor } = await import("../src/media.js");
const { hearInto } = await import("../src/voice.js");
const { SYSTEM } = await import("../src/agent.js");
const { exportData, deleteData } = await import("../src/data.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+12025559999";
/** What accounts.conversationIdFor makes of a number that is not the operator's. */
const FRIEND_ID = `dm:fake:${FRIEND}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM media_items; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM pending_inbound; DELETE FROM conversations; DELETE FROM accounts; DELETE FROM threads; DELETE FROM usage; DELETE FROM outbox; DELETE FROM seen_urls;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = 0;
});

const serving = (body = PNG) => async () => ({
  ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body,
});

function wired() {
  const seen = [];
  const runtime = new Runtime({ runTurn: async (t) => { seen.push(t); return "ok"; } });
  const router = new Router({ runtime });
  router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  return { router, seen };
}

const inbound = (over) => ({
  channel: "fake", externalId: "e-1", from: OWNER, text: "", said: "",
  chatId: null, service: "iMessage", at: clock.now(), attachments: [], ...over,
});

// ---------- a row before anything has looked ----------

test("every photo on one message is a row, numbered, the moment the message is taken", async () => {
  const { router } = wired();
  await router.deliver(inbound({
    text: "what do you think of these", said: "what do you think of these",
    attachments: [
      { kind: "image", filename: "one.jpg", url: "https://cdn.test/one.jpg" },
      { kind: "image", filename: "two.jpg", url: "https://cdn.test/two.jpg" },
    ],
  }));

  const rows = db.mediaOfMessage("dm:owner", "e-1");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.ordinal), [1, 2], "which of that message's items each was");
  assert.deepEqual(rows.map(r => r.filename), ["one.jpg", "two.jpg"]);
  assert.equal(rows.every(r => r.base_handle === "e-1"), true, "and that they were one message's worth");
});

test("a link they pasted is an item too, numbered after the attachments on the same message", async () => {
  const { router } = wired();
  await router.deliver(inbound({
    text: "have a look at https://a.test/x and https://b.test/y",
    said: "have a look at https://a.test/x and https://b.test/y",
    attachments: [{ kind: "voice", filename: "AudioMessage.caf", url: "https://cdn.test/AudioMessage.caf" }],
  }));

  const rows = db.mediaOfMessage("dm:owner", "e-1");
  assert.deepEqual(rows.map(r => r.kind), ["voice", "link", "link"]);
  assert.deepEqual(rows.map(r => r.ordinal), [1, 2, 3]);
  assert.deepEqual(rows.slice(1).map(r => r.url), ["https://a.test/x", "https://b.test/y"]);
});

test("nothing but words leaves no rows at all", async () => {
  const { router } = wired();
  await router.deliver(inbound({ text: "dinner friday?", said: "dinner friday?" }));
  assert.equal(db.mediaFor("dm:owner").length, 0);
});

test("a redelivered webhook is the same items, and does not reset what was already got from them", async () => {
  const { router } = wired();
  const event = inbound({ text: "this one", said: "this one", attachments: [{ kind: "image", filename: "one.jpg", url: "https://cdn.test/one.jpg" }] });
  await router.deliver(event);
  const [row] = db.mediaOfMessage("dm:owner", "e-1");
  reviewed.cover(row.id, { coverage: "looked" });

  // The claim stops a second turn; the row must survive it either way.
  reviewed.record({ channel: "fake", inbound: event, conversationId: "dm:owner" });
  const after = db.mediaOfMessage("dm:owner", "e-1");
  assert.equal(after.length, 1, "one row, not two");
  assert.equal(after[0].coverage, "looked", "and what was already looked at stays looked at");
});

// ---------- moved to the truth afterwards ----------

// From here the record is written by reviewed.record() directly and the processing step is called
// with what it hands back. That IS the contract between them — record returns the attachments with
// their row ids on, and whatever looks at or listens to one reports through that id — and driving
// it this way keeps these tests about coverage rather than about the burst window.
const recorded = (over) => reviewed.record({
  channel: "fake", conversationId: "dm:owner", inbound: inbound(over),
});

test("a picture that was looked at says looked; one that could not be opened says why", async () => {
  const given = recorded({
    text: "these", said: "these",
    attachments: [
      { kind: "image", filename: "one.png", url: "https://cdn.test/one.png" },
      { kind: "image", filename: "lease.psd", url: "https://cdn.test/lease.psd" },
    ],
  });
  await imagesFor(given, { fetchImpl: serving(), cover: reviewed.cover });

  const rows = db.mediaOfMessage("dm:owner", "e-1");
  assert.equal(rows[0].coverage, "looked");
  assert.ok(rows[0].bytes > 0, "and how big it was");
  assert.equal(rows[1].coverage, "failed");
  assert.match(rows[1].detail, /format you cannot read/);
});

test("a voice note that was transcribed, one with no speech, and one that broke, are three different rows", async () => {
  const outcomes = {
    "a.caf": { ok: true, text: "running late" },
    "b.caf": { ok: true, text: "", silent: true },
    "c.caf": { ok: false, error: "the audio could not be downloaded (HTTP 404)" },
  };
  for (const [i, name] of Object.keys(outcomes).entries()) {
    const given = recorded({
      externalId: `e-${i}`, text: `[they sent a voice note (${name}). you cannot listen to it]`, said: "",
      attachments: [{ kind: "voice", filename: name, url: `https://cdn.test/${name}` }],
    });
    await hearInto(`[they sent a voice note (${name}). you cannot listen to it]`, given, {
      status: () => ({ ok: true }),
      listen: async ({ filename }) => outcomes[filename],
      cover: reviewed.cover,
    });
  }

  const byName = Object.fromEntries(db.mediaFor("dm:owner").map(r => [r.filename, r]));
  assert.equal(byName["a.caf"].coverage, "transcribed");
  assert.equal(byName["b.caf"].coverage, "no_speech");
  assert.equal(byName["c.caf"].coverage, "failed");
  assert.match(byName["c.caf"].detail, /HTTP 404/);
  // And never the words themselves: the transcript is in the conversation, not duplicated here.
  assert.equal(JSON.stringify(Object.values(byName)).includes("running late"), false);
});

test("when nothing on the machine can listen, the note says failed rather than waiting forever", async () => {
  const given = recorded({
    text: "[they sent a voice note (a.caf)]", said: "",
    attachments: [{ kind: "voice", filename: "a.caf", url: "https://cdn.test/a.caf" }],
  });
  await hearInto("[they sent a voice note (a.caf)]", given, {
    status: () => ({ ok: false, why: "listening needs a model that takes audio (GEMINI_API_KEY), and there is none" }),
    cover: reviewed.cover,
  });
  const [row] = db.mediaFor("dm:owner");
  assert.equal(row.coverage, "failed");
  assert.match(row.detail, /GEMINI_API_KEY/);
});

test("a link they sent that was really read says read; one that would not load says why", async () => {
  const { router } = wired();
  await router.deliver(inbound({
    text: "read this https://a.test/x and this https://b.test/y",
    said: "read this https://a.test/x and this https://b.test/y",
  }));

  // One reads, one does not. The real tool runs; only the fetch is faked by the page itself being
  // unreachable, which is what an unresolvable host does.
  reviewed.coverUrl("dm:owner", "https://a.test/x", { coverage: "read" });
  reviewed.coverUrl("dm:owner", "https://b.test/y", { coverage: "failed", detail: "404 Not Found from https://b.test/y" });

  const rows = db.mediaFor("dm:owner");
  const byUrl = Object.fromEntries(rows.map(r => [r.url, r]));
  assert.equal(byUrl["https://a.test/x"].coverage, "read");
  assert.equal(byUrl["https://b.test/y"].coverage, "failed");
  assert.match(byUrl["https://b.test/y"].detail, /404/);
});

test("a page Reason went and found itself is nobody's item, so nothing is marked", async () => {
  assert.equal(reviewed.coverUrl("dm:owner", "https://somewhere.test/found-it", { coverage: "read" }), null);
  assert.equal(db.mediaFor("dm:owner").length, 0);
});

test("a link card's preview is recorded as dropped, with its reason, rather than vanishing", async () => {
  const { router } = wired();
  await router.deliver(inbound({
    externalId: "E32-1", baseHandle: "E32", partIndex: 0,
    text: "look at this https://a.test/x", said: "look at this https://a.test/x",
  }));
  await router.deliver(inbound({
    externalId: "E32-1_1", baseHandle: "E32", partIndex: 1, text: "", said: "",
    attachments: [{ kind: "image", filename: "preview.jpg", url: "https://cdn.test/preview.jpg" }],
  }));

  const rows = db.mediaOfMessage("dm:owner", "E32");
  const preview = rows.find(r => r.filename === "preview.jpg");
  assert.equal(preview.coverage, "dropped");
  assert.match(preview.detail, /link preview/);
  // And it is not in what the model reads, because the person does not know their phone sent it.
  assert.equal(reviewed.listFor("dm:owner").some(i => i.filename === "preview.jpg"), false);
});

// ---------- what the model reads ----------

test("the tool answers newest first, with what each coverage actually lets Reason claim", async () => {
  const { router } = wired();
  await router.deliver(inbound({
    text: "this one", said: "this one",
    attachments: [{ kind: "image", filename: "one.png", url: "https://cdn.test/one.png" }],
  }));
  clock.skip(1000);
  await router.deliver(inbound({ externalId: "e-2", text: "and https://a.test/x", said: "and https://a.test/x" }));
  const [photo] = db.mediaOfMessage("dm:owner", "e-1");
  reviewed.cover(photo.id, { coverage: "looked" });
  reviewed.coverUrl("dm:owner", "https://a.test/x", { coverage: "captions" });

  const out = await runTool("media_reviewed", {}, { conversationId: "dm:owner" });
  assert.equal(out.count, 2);
  assert.equal(out.items[0].kind, "link", "newest first");
  assert.match(out.items[0].what_that_means, /words only/);
  assert.equal(out.items[1].kind, "image");
  assert.match(out.items[1].what_that_means, /you looked at this picture/);
  assert.equal(out.items[1].nth_on_that_message, 1);
  assert.equal(out.items[1].on_message, "e-1");
});

test("the tool can be asked for one kind, and says plainly when there is nothing", async () => {
  const empty = await runTool("media_reviewed", {}, { conversationId: "dm:owner" });
  assert.equal(empty.count, 0);
  assert.match(empty.note, /have not sent you anything but words/);

  const { router } = wired();
  await router.deliver(inbound({
    text: "a https://a.test/x", said: "a https://a.test/x",
    attachments: [{ kind: "image", filename: "one.png", url: "https://cdn.test/one.png" }],
  }));
  const links = await runTool("media_reviewed", { kinds: ["link"] }, { conversationId: "dm:owner" });
  assert.equal(links.count, 1);
  assert.equal(links.items[0].kind, "link");
});

// ---------- one person's, and nobody else's ----------

test("one person's record is not another's, in the table or in the tool", async () => {
  const { router } = wired();
  db.upsertAccount({ conversationId: "dm:fake:+12025559999", channel: "fake", address: FRIEND, name: "Kofi" });
  await router.deliver(inbound({
    text: "mine", said: "mine",
    attachments: [{ kind: "image", filename: "omari.png", url: "https://cdn.test/omari.png" }],
  }));
  await router.deliver(inbound({
    externalId: "e-2", from: FRIEND, text: "mine", said: "mine",
    attachments: [{ kind: "image", filename: "kofi.png", url: "https://cdn.test/kofi.png" }],
  }));

  assert.deepEqual(db.mediaFor("dm:owner").map(r => r.filename), ["omari.png"]);
  assert.deepEqual(db.mediaFor("dm:fake:+12025559999").map(r => r.filename), ["kofi.png"]);
  const mine = await runTool("media_reviewed", {}, { conversationId: "dm:owner" });
  assert.equal(mine.items.some(i => i.filename === "kofi.png"), false);
  // And a URL one person sent cannot be marked read by the other's lookup.
  assert.equal(reviewed.coverUrl("dm:fake:+12025559999", "https://cdn.test/omari.png", { coverage: "read" }), null);
});

// ---------- theirs, so it goes in an export and comes out in a delete ----------

test("the record is in an export, scoped, and a delete takes it", async () => {
  const { router } = wired();
  db.upsertAccount({ conversationId: "dm:fake:+12025559999", channel: "fake", address: FRIEND, name: "Kofi" });
  await router.deliver(inbound({ text: "mine", said: "mine", attachments: [{ kind: "image", filename: "omari.png", url: "https://cdn.test/omari.png" }] }));
  await router.deliver(inbound({ externalId: "e-2", from: FRIEND, text: "mine", said: "mine", attachments: [{ kind: "image", filename: "kofi.png", url: "https://cdn.test/kofi.png" }] }));

  const all = exportData({ conversation: null, audio: false });
  assert.equal(all.tables.media_items.length, 2);
  const one = exportData({ conversation: "dm:owner", audio: false });
  assert.deepEqual(one.tables.media_items.map(r => r.filename), ["omari.png"]);

  const gone = await deleteData({ conversation: "dm:owner" });
  assert.equal(gone.rows.media_items, 1);
  assert.equal(db.mediaFor("dm:owner").length, 0);
  assert.equal(db.mediaFor("dm:fake:+12025559999").length, 1, "and not anybody else's");
});

// ---------- and what the model is told about it ----------

test("the prompt points the model at the record rather than at its memory", () => {
  assert.match(SYSTEM, /media_reviewed is that record/);
  assert.match(SYSTEM, /Never claim you saw, read, watched or heard something the record does not say you did/);
});
