// REASON_WEB_DRAFTS: a Web reply grows in the open tab as claude-cli writes it (src/webdraft.js).
// No CLI, no network: the CLI's own event lines are fed in by hand. What is pinned here:
//
//   is anything streamed with the switch off?                         (no — the turn is unchanged)
//   does a piece reach the tab before the said check passes it?       (never)
//   does a draft the said check rejects ever reach the tab?           (never; what was shown is taken back)
//   are the words of a message that calls a tool shown?               (no; taken back if one slips through)
//   self-note first line, NO_REPLY, an unsourced figure?              (held or never shown, as the reply drops them)
//   iMessage?                                                          (never streamed)
//   does the finished reply replace the draft, and the end clear it?  (yes)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-web-stream-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_PAGES_URL = "https://files.heyreason.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";
delete process.env.REASON_WEB_DRAFTS;

const { webRequestFor } = await import("../src/http.js");
const convo = await import("../src/pages/webconvo.js");
const { Router } = await import("../src/channels/router.js");
const { Runtime } = await import("../src/runtime.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { WebChannel } = await import("../src/channels/web.js");
const { makeDeliver } = await import("../src/deliver.js");
const { cliInvocation } = await import("../src/backends/cli.js");
const wd = await import("../src/webdraft.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const KOFI = "+14155559876";
const OWNER_C = "dm:owner";
const KOFI_C = `dm:fake:${KOFI}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.web = true;
  delete process.env.REASON_WEB_DRAFTS;
  convo.resetSendLimits();
  db.db.exec(`DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage;
    DELETE FROM inbound_messages; DELETE FROM pending_inbound; DELETE FROM messages; DELETE FROM event_log; DELETE FROM extraction_queue;
    DELETE FROM requests; DELETE FROM page_sessions;`);
  for (const [c, a, n, op] of [[OWNER_C, OWNER, "Omari", true], [KOFI_C, KOFI, "Kofi", false]]) {
    db.upsertAccount({ conversationId: c, channel: "fake", address: a, name: n, isOperator: op });
    db.upsertThread({ conversationId: c, channel: "fake", address: a, isOwner: true, service: "iMessage" });
  }
  db.db.exec("UPDATE accounts SET contact_card_sent_at = 1");
});

// ---------- the CLI's own event lines ----------
const ev = (event) => ({ type: "stream_event", event });
const start = () => ev({ type: "message_start", message: {} });
const words = (text) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const toolStart = () => ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__reason__x" } });
const endTurn = () => ev({ type: "message_delta", delta: { stop_reason: "end_turn" } });
const settle = () => new Promise(r => setTimeout(r, 15));

/** A drafter whose shown pieces are collected; `check` decides the said check. */
function drafter({ check = async () => ({ ok: true }), conversationId = `dm:unit:${Math.random()}` } = {}) {
  const shown = [], checked = [];
  const d = wd.startDraft({ conversationId, check: async (a) => { checked.push(a.draft); return check(a); }, emit: (e) => shown.push(e.text) });
  return { d, shown, checked };
}

test("the switch: off unless named, on for 'on', or for the listed conversations only", () => {
  assert.equal(wd.streamOn(KOFI_C, undefined), false);
  assert.equal(wd.streamOn(KOFI_C, ""), false);
  assert.equal(wd.streamOn(KOFI_C, "0"), false);
  assert.equal(wd.streamOn(KOFI_C, "off"), false);
  assert.equal(wd.streamOn(KOFI_C, "on"), true);
  assert.equal(wd.streamOn(KOFI_C, "1"), true);
  assert.equal(wd.streamOn(KOFI_C, `dm:x, ${KOFI_C}`), true);
  assert.equal(wd.streamOn(OWNER_C, `dm:x, ${KOFI_C}`), false);
});

test("the CLI is asked for the reply's words as they come only when someone is listening", () => {
  const plain = cliInvocation({ prompt: "hi", system: "s" });
  assert.deepEqual(plain.args.slice(0, 4), ["-p", "hi", "--output-format", "json"]);
  assert.equal(plain.streamed, false);
  assert.ok(!plain.args.includes("--include-partial-messages"));
  const live = cliInvocation({ prompt: "hi", system: "s", partial: true });
  assert.deepEqual(live.args.slice(0, 6), ["-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
  assert.equal(live.streamed, true);
  const pics = cliInvocation({ prompt: "hi", system: "s", images: [{ type: "image" }] });
  assert.deepEqual(pics.args.slice(0, 6), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
});

test("sentences: cut only where one ends, never at a list number or mid-figure", () => {
  assert.equal(wd.sentenceEnd("hey. how are"), 4);
  assert.equal(wd.sentenceEnd("it's $3.50 a"), 0);
  assert.equal(wd.sentenceEnd("1. one"), 0);
  assert.equal(wd.sentenceEnd("e.g. this"), 0);
  assert.equal(wd.sentenceEnd("line one\nline"), 9);
});

test("whole sentences only, and each one only after the said check passed it", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { d, shown, checked } = drafter({ check: async () => { await gate; return { ok: true }; } });
  d.feed(start());
  d.feed(words("sure, you can pick it up at 5. it's "));
  await settle();
  assert.deepEqual(checked, ["sure, you can pick it up at 5."]);
  assert.deepEqual(shown, [], "nothing shown while the check is still out");
  release();
  await settle();
  assert.deepEqual(shown, ["sure, you can pick it up at 5."]);
  d.feed(words("on the second floor."));
  d.feed(endTurn());
  await settle();
  assert.equal(shown.at(-1), "sure, you can pick it up at 5. it's on the second floor.");
  const n = checked.length;
  assert.deepEqual(await d.check("sure, you can pick it up at 5. it's on the second floor."), { ok: true });
  assert.equal(checked.length, n, "the finished reply's check is the piece's, not a second one");
  d.end();
  assert.equal(shown.at(-1), null, "the end takes it back");
});

test("a draft the said check rejects never reaches the tab, and what was shown is taken back", async () => {
  const { d, shown } = drafter({ check: async ({ draft }) => ({ ok: !/friday/.test(draft), note: "changed the day" }) });
  d.feed(start());
  d.feed(words("you've got it. the dinner is on friday now. "));
  d.feed(endTurn());
  await settle();
  assert.ok(!shown.some(t => t && /friday/.test(t)), "the blocked sentence was never shown");
  assert.equal(shown.at(-1) ?? null, null, "anything shown before is taken back");
  d.feed(start()); d.feed(words("more words. and more. ")); d.feed(endTurn());
  await settle();
  assert.equal(shown.filter(Boolean).every(t => !/more words/.test(t)), true, "stopped for the rest of the turn");
});

test("the words of a message that calls a tool are not the reply: never shown, or taken back", async () => {
  // The usual shape: a line of narration, then the tool. The check is still out when the tool starts.
  const a = drafter({ check: async () => { await settle(); return { ok: true }; } });
  a.d.feed(start());
  a.d.feed(words("you want the weather, let me look. "));
  a.d.feed(toolStart());
  await settle(); await settle();
  assert.deepEqual(a.shown, [], "narration before a tool never shows");
  // Then the real reply, in the next message.
  a.d.feed(start()); a.d.feed(words("you'll want a jacket, it's 48 out.")); a.d.feed(endTurn());
  await settle(); await settle();
  assert.deepEqual(a.shown, ["you'll want a jacket, it's 48 out."]);

  // One that slipped out before the tool began is taken back the moment it does.
  const b = drafter();
  b.d.feed(start());
  b.d.feed(words("ok you got it. let me "));
  await settle();
  assert.deepEqual(b.shown, ["ok you got it."]);
  b.d.feed(toolStart());
  assert.equal(b.shown.at(-1), null);
});

test("the floor: a self-note line, NO_REPLY and an unsourced figure are never shown", async () => {
  // A first line that might be a note to self waits until it can be judged, then goes as the reply drops it.
  const a = drafter();
  a.d.feed(start());
  a.d.feed(words("a quick check-in. i'll keep it short."));
  await settle();
  assert.deepEqual(a.shown, [], "held while the first line could still be a note");
  a.d.feed(words("\nhey! all good here, how's the trip?"));
  a.d.feed(endTurn());
  await settle();
  assert.ok(a.shown.length && a.shown.every(t => !/check-in|keep it short/.test(t)), "the note never shows");
  assert.equal(a.shown.at(-1), "hey! all good here, how's the trip?");

  const b = drafter();
  b.d.feed(start()); b.d.feed(words("NO_REPLY. nothing to add for you here. ")); b.d.feed(endTurn());
  await settle();
  assert.deepEqual(b.shown, []);

  const c = drafter();
  c.d.feed(start()); c.d.feed(words("you can get it for $49.99 today. want it? ")); c.d.feed(endTurn());
  await settle();
  assert.deepEqual(c.shown, [], "a figure the figures check would mark is not shown early");
});

// ---------- the whole path: a Web send, the turn, the live stream ----------
function harness(turn) {
  const logs = [];
  const router = new Router({ log: (e) => logs.push(e) });
  const consoleChannel = new ConsoleChannel({ write: () => {} });
  const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
  const turns = [];
  const runtime = new Runtime({ log: (e) => logs.push(e), channels: router, deliver, runTurn: async (args) => { turns.push(args); return turn(args); } });
  router.runtime = runtime;
  router.register(consoleChannel);
  router.register(new FakeChannel({ number: "+16562167455" }));
  router.register(new WebChannel());
  runtime.on("outbound", async ({ conversationId, text, channel: name, to, chatId, fromOwner, replyTo }) => {
    await deliver({ conversationId, text, media: null, channel: name, to, chatId, fromOwner, replyTo });
  });
  return { router, runtime, logs, turns };
}
let n = 0;
function browser(conversationId) {
  const token = `tok-${++n}-${Math.random().toString(36).slice(2)}`;
  db.startPageSession(`wsign:${conversationId}`, token, { conversationId });
  return { conv: conversationId, token, cookie: `reason_page=${token}`, csrf: db.pageSessionCsrf(token) };
}
const headersFor = (b, extra = {}) => ({ host: "heyreason.test", origin: "https://heyreason.test", "sec-fetch-site": "same-origin", cookie: b.cookie, ...extra });
const send = (h, b, { id, text }) => webRequestFor({ sub: "send", method: "POST", query: {}, headers: headersFor(b, { accept: "application/json", "x-reason-csrf": b.csrf }),
  remoteAddress: "127.0.0.1", readBody: async () => new URLSearchParams({ id, text, c: b.csrf }).toString(), runtime: h.runtime, router: h.router, log: (e) => h.logs.push(e) });
function openStream(h, b) {
  const out = convo.streamRequest({ account: db.getAccount(b.conv), headers: headersFor(b), query: {}, router: h.router, log: () => {} });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { write: (s) => chunks.push(s), end: () => {} });
  const req = new EventEmitter();
  out.stream(res, req);
  const events = () => chunks.join("").split("\n\n").filter(Boolean).map(block => {
    const e = /^event: (.+)$/m.exec(block)?.[1] ?? null;
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return e ? { event: e, data: data ? JSON.parse(data) : null } : null;
  }).filter(Boolean);
  return { events, close: () => req.emit("close") };
}
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); return pred(); };
/** A turn that writes its reply the way the CLI prints it, when handed a drafter. */
const writing = (reply) => async ({ draft }) => {
  if (draft) {
    draft.feed(start());
    for (const piece of reply.match(/.{1,7}/gs)) { draft.feed(words(piece)); await new Promise(r => setTimeout(r, 2)); }
    draft.feed(endTurn());
    await new Promise(r => setTimeout(r, 10));
  }
  return reply;
};

test("switch off: a Web turn is handed no drafter and the stream carries no draft", async () => {
  const h = harness(writing("you're all set for tomorrow. see you then."));
  const b = browser(KOFI_C);
  const s = openStream(h, b);
  await send(h, b, { id: "w-off-0001", text: "am i set?" });
  assert.ok(await until(() => s.events().some(e => e.event === "message" && e.data.role === "assistant")));
  assert.equal(h.turns[0].draft, undefined);
  assert.ok(!s.events().some(e => e.event === "draft"));
  s.close();
});

test("switch on for this person: the reply grows in their tab as a Reason line, then the saved one arrives and the draft is cleared", async () => {
  process.env.REASON_WEB_DRAFTS = KOFI_C;
  const reply = "you're all set for tomorrow. the table is under your name. see you then.";
  const h = harness(writing(reply));
  const b = browser(KOFI_C);
  const s = openStream(h, b);
  const other = openStream(h, browser(OWNER_C));
  await send(h, b, { id: "w-on-00001", text: "am i set?" });
  assert.ok(await until(() => s.events().some(e => e.event === "draft" && e.data.html === null)));
  const evs = s.events();
  const drafts = evs.filter(e => e.event === "draft" && e.data.html);
  assert.ok(drafts.length >= 2, "it grew in more than one piece");
  assert.match(drafts[0].data.html, /<p class="lbl"><span>REASON · WEB · <\/span><time/, "drawn with the same label as a saved Reason line");
  assert.match(drafts[0].data.html, /<div class="rsay">/);
  assert.match(drafts[0].data.html, /all set for tomorrow\./);
  assert.ok(!/see you then/.test(drafts[0].data.html), "the first piece came before the reply was finished");
  const saved = evs.findIndex(e => e.event === "message" && e.data.role === "assistant");
  const cleared = evs.findIndex(e => e.event === "draft" && e.data.html === null);
  assert.ok(saved >= 0 && cleared > saved, "the saved reply lands before the draft is cleared");
  assert.equal(evs[saved].data.text, reply);
  assert.ok(!other.events().some(e => e.event === "draft"), "nobody else's tab hears it");
  assert.equal(wd.draftNow(KOFI_C), null, "nothing left to replay once the turn is over");
  s.close(); other.close();
});

test("the finished reply fails the said check: what was shown is taken back before anything else, and the rewrite arrives whole and never streamed", async () => {
  process.env.REASON_WEB_DRAFTS = "on";
  const said = await import("../src/said.js");
  const c = db.addClaim(KOFI_C, { subject: "dinner time", value: "7pm" });
  // Each piece on its own passes; only the whole first draft changes the time without saying so.
  said.setChecker(({ draft }) => ({ changed_silently: draft === "you're booked. it's at 8 now, see you." ? [c] : [], asks_closed: [] }));
  let calls = 0;
  const h = harness(async (args) => {
    calls++;
    if (calls === 1) return writing("you're booked. it's at 8 now, see you.")(args);
    assert.equal(args.draft, undefined, "the rewrite is never streamed");
    return "earlier i said 7, it moved: you're booked at 8.";
  });
  try {
    const b = browser(KOFI_C);
    const s = openStream(h, b);
    await send(h, b, { id: "w-rw-00001", text: "what time?" });
    assert.ok(await until(() => s.events().some(e => e.event === "message" && e.data.role === "assistant")));
    const evs = s.events();
    assert.ok(!evs.some(e => e.event === "draft" && e.data.html && /at 8 now, see you\./.test(e.data.html)), "the rejected whole draft never showed");
    const saved = evs.findIndex(e => e.event === "message" && e.data.role === "assistant");
    const firstClear = evs.findIndex(e => e.event === "draft" && e.data.html === null);
    assert.ok(firstClear >= 0 && firstClear < saved, "taken back before the rewrite lands");
    assert.ok(!evs.slice(firstClear + 1).some(e => e.event === "draft" && e.data.html), "nothing streamed after");
    assert.equal(evs[saved].data.text, "earlier i said 7, it moved: you're booked at 8.");
    s.close();
  } finally { said.setChecker(null); db.db.exec("DELETE FROM sent_claims"); }
});

test("iMessage is never streamed, even with the switch on for everyone", async () => {
  process.env.REASON_WEB_DRAFTS = "on";
  const h = harness(writing("hey, got it. on my way."));
  await h.router.deliver({ channel: "fake", externalId: "im-1", from: KOFI, text: "you there?", chatId: null, at: clock.now() });
  assert.ok(await until(() => h.turns.length === 1));
  assert.equal(h.turns[0].draft, undefined);
});

test("a tab whose stream reconnects mid-turn gets the draft as it stands, at once", async () => {
  process.env.REASON_WEB_DRAFTS = "on";
  let release;
  const hold = new Promise(r => { release = r; });
  const h = harness(async ({ draft }) => {
    draft.feed(start()); draft.feed(words("you're all set for tomorrow. the table "));
    await hold;
    draft.feed(words("is under your name.")); draft.feed(endTurn());
    await new Promise(r => setTimeout(r, 10));
    return "you're all set for tomorrow. the table is under your name.";
  });
  const b = browser(KOFI_C);
  const first = openStream(h, b);
  await send(h, b, { id: "w-re-00001", text: "am i set?" });
  assert.ok(await until(() => first.events().some(e => e.event === "draft" && e.data.html)));
  first.close();
  const again = openStream(h, b);
  const d = again.events().find(e => e.event === "draft");
  assert.ok(d && /all set for tomorrow\./.test(d.data.html), "the reconnected tab has the draft without waiting for the next piece");
  release();
  assert.ok(await until(() => again.events().some(e => e.event === "draft" && e.data.html === null)));
  again.close();
});
