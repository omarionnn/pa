// Who Reason trusts on a call (owner decision 2026-11-13; src/calls/calltrust.js, src/callpass.js).
// REASON_CALL_TRUST on: the caller's own number is enough for low-risk things; a spoken passphrase is
// asked for only at the moment something needs it; money and saved logins never by voice. Off: today.
// Fixtures only: no model, no network, no real call.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call-trust-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
process.env.REASON_CALL_PASSPHRASE = "";
delete process.env.REASON_CALL_TRUST;

const voice = await import("../src/calls/voice.js");
const verify = await import("../src/calls/verify.js");
const ct = await import("../src/calls/calltrust.js");
const cp = await import("../src/callpass.js");
const cartesia = await import("../src/calls/cartesia.js");
const gl = await import("../src/calls/gptlive.js");
const page = await import("../src/pages/callpassphrase.js");
const db = await import("../src/db.js");
const { loginsDb, loginsDbPath } = await import("../src/savedlogins.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OWN = "+12025551234";
const PHRASE = "purple otter dances at midnight";
const on = () => { process.env.REASON_CALL_TRUST = "on"; };
const off = () => { delete process.env.REASON_CALL_TRUST; };

after(() => { off(); rmSync(dir, { recursive: true, force: true }); });
let realRunTool;
beforeEach(async () => {
  clock.reset();
  off();
  db.db.exec("DELETE FROM calls; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM confirmations; DELETE FROM outbox;");
  loginsDb({ create: true }).exec("DELETE FROM call_passphrases; DELETE FROM call_passphrase_links;");
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: OWN, name: "Omari", isOperator: true });
  Object.assign(config, { callIdentity: false, callVoice: "gptlive", callCacheWarm: false, callPassphrase: "", openaiKey: "sk-test" });
  await voice.prime();
  realRunTool ??= voice.contextDeps.runTool;
  voice.contextDeps.runTool = realRunTool;
});

const inbound = (over = {}) => db.createCall(C, {
  provider: "gptlive", toNumber: OWN, isOwner: true, direction: "in", goal: "They rang Reason", facts: [],
  announcement: "", state: "in_progress", ...over,
});
const lines = [];
const log = (o) => lines.push(o);

// ---------------------------------------------------------------- the level table
test("level table: every kind lands where it should, and an unknown consequential tool is never low risk", () => {
  const self = (to) => to === OWN;
  const L = ct.LEVEL;
  const want = [
    ["weather", {}, L.OPEN], ["recall", {}, L.OPEN], ["timer_set", {}, L.OPEN], ["remember", {}, L.OPEN],
    ["message_send", { to: OWN, text: "the link" }, L.OPEN], // a text to themselves was never held
    ["calendar_create", { summary: "Dentist" }, L.LOW],
    ["calendar_create", { summary: "Dinner", attendees: ["a@b.test"] }, L.PASSPHRASE],
    ["voice_note_send", { to: OWN }, L.LOW],
    ["message_send", { to: "+13105550000", text: "late" }, L.PASSPHRASE],
    ["gmail_send", { to: "a@b.test" }, L.PASSPHRASE], ["call_place", { to: "+13105550000" }, L.PASSPHRASE],
    ["make_a_call_for_me", {}, L.PASSPHRASE], ["x_post", {}, L.PASSPHRASE], ["gmail_trash", {}, L.PASSPHRASE],
    ["calendar_delete", {}, L.PASSPHRASE], ["calendar_change", {}, L.PASSPHRASE], ["call_hours_set", {}, L.PASSPHRASE],
    ["ledger_list", {}, L.PASSPHRASE], ["purchases_recent", {}, L.PASSPHRASE],
    ["purchase_confirm", {}, L.TEXT], ["uber_request", {}, L.TEXT], ["account_connect", {}, L.TEXT],
    ["subscription_cancel_commit", {}, L.TEXT], ["permission_grant", {}, L.TEXT], ["spend_limit_set", {}, L.TEXT],
    ["github_pr_merge", {}, L.TEXT], ["remote_approve", {}, L.TEXT],
  ];
  for (const [n, input, level] of want) assert.equal(ct.levelOf(n, input, { toSelf: self }), level, n);
  // Not named anywhere, and consequential: text only. (A made-up name in the gated list stands in.)
  assert.equal(ct.levelOf("flight_checkin_commit", {}), L.TEXT);
  assert.equal(ct.levelOf("todo_approve", {}), L.TEXT);
  for (const n of ct.TEXT_ONLY) assert.equal(ct.levelOf(n, {}), L.TEXT, n);
  for (const n of ct.PASSPHRASE_TOOLS) assert.notEqual(ct.levelOf(n, { to: "+13105550000" }), L.LOW, n);
});

test("a booking is low risk only when nothing on the page or the line is about money; a fee is a passphrase; no page is text", () => {
  const free = "Genius Bar\nChoose a time\nFriday 3:40 PM\nReserve";
  assert.equal(ct.bookingKind("Genius Bar Friday 3:40", free), "free");
  assert.equal(ct.levelOf("browser_submit", { what: "Genius Bar Friday 3:40" }, { page: free }), ct.LEVEL.LOW);
  const fee = "Table for 2, 8pm\nA $25 no-show fee applies.\nConfirm";
  assert.equal(ct.bookingKind("table 8pm", fee), "fee");
  assert.equal(ct.levelOf("browser_submit", { what: "table 8pm" }, { page: fee }), ct.LEVEL.PASSPHRASE);
  for (const pays of ["Card number\nExpiry\nPay now", "Deposit required: $50", "Total $120.00", "Card on file needed to hold"]) {
    assert.equal(ct.levelOf("browser_submit", { what: "x" }, { page: pays }), ct.LEVEL.TEXT, pays);
  }
  assert.equal(ct.levelOf("browser_submit", { what: "x" }, { page: null }), ct.LEVEL.TEXT);
  assert.equal(ct.levelOf("browser_submit", { what: "$40 haircut" }, { page: free }), ct.LEVEL.TEXT);
  // A yes recorded for a money confirmation is never unlocked by voice.
  assert.equal(ct.levelOf("confirm_record", {}, { confirmation: { action: "browser_submit", stakes: "money", target: "x" } }), ct.LEVEL.TEXT);
  assert.equal(ct.levelOf("confirm_record", {}, { confirmation: { action: "calendar_create", stakes: "", target: "Dentist" } }), ct.LEVEL.LOW);
});

// ---------------------------------------------------------------- caller ID
test("caller ID: only the account's own number, inbound, not forwarded, nobody else on the line", () => {
  on();
  assert.equal(ct.callerIdTrusted(inbound()), true, "own number");
  assert.equal(ct.callerIdTrusted(inbound({ toNumber: "+13105550000" })), false, "a contact's / any other number");
  assert.equal(ct.callerIdTrusted(inbound({ toNumber: "" })), false, "withheld");
  assert.equal(ct.callerIdTrusted({ ...inbound(), direction: "out" }), false, "outbound");
  const fwd = inbound(); db.updateCall(C, fwd.id, { caller_forwarded: "+15550001111" });
  assert.equal(ct.callerIdTrusted(db.getCall(C, fwd.id)), false, "forwarded");
  const bad = inbound(); db.updateCall(C, bad.id, { caller_attest: "TN-Validation-Failed-A" });
  assert.equal(ct.callerIdTrusted(db.getCall(C, bad.id)), false, "carrier check failed");
  const third = inbound(); db.updateCall(C, third.id, { party_n: 2 });
  assert.equal(ct.callerIdTrusted(db.getCall(C, third.id)), false, "a third party on the line");
  assert.equal(ct.callerIdTrusted({ ...inbound(), provider: "bland" }), false, "a relay that does not screen");
  assert.equal(ct.callerIdTrusted({ ...inbound(), is_owner: 0 }), false, "not an own call");
});

test("low risk runs on the own number; the same thing on a mismatched or third-party call waits for the text", () => {
  on();
  const ok = ct.decide({ call: inbound(), name: "calendar_create", input: { summary: "Dentist" }, log });
  assert.equal(ok.allow, true);
  const third = inbound(); db.updateCall(C, third.id, { party_n: 2 });
  const no = ct.decide({ call: db.getCall(C, third.id), name: "calendar_create", input: { summary: "Dentist" }, log });
  assert.equal(no.allow, false);
  assert.equal(no.out.queued, true);
  // Level 2 with somebody else on the line: never asked out loud, straight to the text.
  cp.setActive(C, PHRASE);
  const send = ct.decide({ call: db.getCall(C, third.id), name: "message_send", input: { to: "+13105550000", text: "hi" }, log });
  assert.equal(send.allow, false);
  assert.equal(send.line, null);
  assert.equal(ct.listening(db.getCall(C, third.id)), null);
});

// ---------------------------------------------------------------- matching
test("matching: normalised, numbers as words, filler in front, one word off only from five words", () => {
  const rec = cp.hashPhrase("Blue heron 7");
  assert.equal(cp.phraseMatches("blue heron seven", rec), "exact");
  assert.equal(cp.phraseMatches("Blue, Heron... 7!", rec), "exact");
  assert.equal(cp.phraseMatches("it's blue heron seven", rec), "exact");
  assert.equal(cp.phraseMatches("blue herring seven", rec), null, "3 words: no tolerance");
  assert.equal(cp.phraseMatches("blue heron", rec), null);
  const five = cp.hashPhrase(PHRASE);
  assert.equal(cp.phraseMatches("purple otter dances at midnight", five), "exact");
  assert.equal(cp.phraseMatches("purple otter dancers at midnight", five), "near", "one word misheard");
  assert.equal(cp.phraseMatches("purple order dancers at midnight", five), null, "two words off");
  assert.equal(cp.phraseMatches("purple otter dances midnight", five), null, "a dropped word");
  assert.equal(cp.numberWords("21"), "twenty one");
  assert.equal(cp.numberWords("1905"), "one thousand nine hundred five");
  assert.deepEqual(cp.normalWords("twenty-one Don't"), ["twenty", "one", "dont"]);
  assert.equal(cp.hashPhrase("two words"), null, "at least three");
  const stored = JSON.stringify(five);
  for (const w of PHRASE.split(" ")) assert.ok(!stored.includes(w), `the stored form has no "${w}"`);
});

// ---------------------------------------------------------------- the passphrase flow
test("passphrase: asked at the moment, a match unlocks that one action, which runs once; the window closes", () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  const SEND = { to: "+13105550000", text: "running late" };
  const asked = ct.decide({ call: row, name: "message_send", input: SEND, log });
  assert.equal(asked.allow, false);
  assert.equal(asked.line, ct.LINES.ask);
  assert.equal(asked.line, "Say your passphrase and I'll do it now, or I'll do it by text right after.");
  assert.equal(asked.out.queued, true, "queued for the text too, until it runs");
  assert.equal(ct.listening(row), "pass");
  const heard = ct.hear(row, "purple otter dances at midnight", { log });
  assert.equal(heard.text, ct.MARKER);
  assert.equal(heard.ok, true);
  const fresh = () => db.getCall(C, row.id);
  assert.equal(ct.decide({ call: fresh(), name: "message_send", input: SEND, log }).allow, true);
  assert.equal(ct.decide({ call: fresh(), name: "gmail_send", input: { to: "x@y.test" }, log }).allow, false, "only that one action");
  ct.ran(fresh(), "message_send", { ok: true }, { log });
  assert.doesNotMatch(fresh().verify_deferred, /message send/, "it ran: off the after-call list");
  assert.match(fresh().verify_deferred, /gmail send/, "the refused one is still on it");
  assert.equal(ct.decide({ call: fresh(), name: "message_send", input: SEND, log }).allow, false, "spent once it ran");
  // A new match, then the clock: five minutes and it is gone.
  ct.decide({ call: fresh(), name: "message_send", input: SEND, log });
  ct.hear(fresh(), PHRASE, { log });
  clock.skip(ct.GRANT_MS + 1000);
  assert.equal(ct.decide({ call: fresh(), name: "message_send", input: SEND, log }).allow, false, "the window closed");
});

test("passphrase: a near miss (5+ words) counts; two misses fall back to the text; three tries a call at most", () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  const fresh = () => db.getCall(C, row.id);
  ct.decide({ call: row, name: "message_send", input: { to: "+13105550000", text: "a" }, log });
  assert.equal(ct.hear(fresh(), "purple otter dancers at midnight", { log }).ok, true, "one word misheard");
  const r2 = inbound();
  const f2 = () => db.getCall(C, r2.id);
  ct.decide({ call: r2, name: "message_send", input: { to: "+13105550000", text: "b" }, log });
  assert.equal(ct.hear(f2(), "green giraffe", { log }).ok, false);
  assert.equal(ct.owedLine(f2(), { log }), ct.LINES.missAgain);
  assert.equal(ct.listening(f2()), "pass", "one more try");
  assert.equal(ct.hear(f2(), "red lion roars at noon", { log }).ok, false);
  assert.equal(ct.owedLine(f2(), { log }), ct.LINES.missLast);
  assert.equal(ct.listening(f2()), null, "no third try on this ask");
  assert.match(f2().verify_deferred, /message send/, "it waits for the text");
  // Third try on a new ask, then the call's cap.
  const again = ct.decide({ call: f2(), name: "gmail_send", input: { to: "x@y.test" }, log });
  assert.equal(again.line, ct.LINES.ask);
  assert.equal(ct.hear(f2(), "wrong wrong wrong", { log }).ok, false);
  assert.equal(f2().trust_tries, 3);
  const capped = ct.decide({ call: f2(), name: "x_post", input: {}, log });
  assert.equal(capped.allow, false);
  assert.equal(capped.line, null, "past three tries: never asked again, the text after the call");
  for (const l of [...Object.values(ct.LINES)].filter(v => typeof v === "string")) assert.doesNotMatch(l, /try again\?|want me to/i);
});

test("money and saved logins refuse by voice with or without the passphrase, even with a grant on the row", () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  for (const n of ["purchase_confirm", "uber_request", "account_connect", "vault_enroll", "event_refund"]) {
    const r = ct.decide({ call: row, name: n, input: {}, log });
    assert.equal(r.allow, false, n);
    assert.equal(r.line, null, `${n}: no passphrase is asked for`);
    assert.match(r.out.say, /never done by voice/);
  }
  db.updateCall(C, row.id, { trust_grant: JSON.stringify({ action: "purchase_confirm", until: clock.now() + 60_000, used: false }) });
  assert.equal(ct.decide({ call: db.getCall(C, row.id), name: "purchase_confirm", input: {}, log }).allow, false);
});

test("a one-time code in a tool's answer is held until the passphrase", () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  const held = ct.holdsCode({ call: row, name: "gmail_read", out: { body: "Your verification code is 482913" }, log });
  assert.equal(held.allow, false);
  assert.equal(held.line, ct.LINES.ask);
  ct.hear(db.getCall(C, row.id), PHRASE, { log });
  assert.equal(ct.holdsCode({ call: db.getCall(C, row.id), name: "gmail_read", out: { body: "Your verification code is 482913" }, log }), null);
  assert.equal(ct.holdsCode({ call: row, name: "weather", out: { temp: 61 }, log }), null);
});

// ---------------------------------------------------------------- telling people
test("no passphrase set: told once, at most once more, never twice on a call", () => {
  on();
  const SEND = { to: "+13105550000", text: "hi" };
  const c1 = inbound();
  assert.equal(ct.decide({ call: c1, name: "message_send", input: SEND, log }).line, ct.LINES.notice);
  assert.equal(ct.decide({ call: db.getCall(C, c1.id), name: "message_send", input: SEND, log }).line, null, "not twice on one call");
  assert.equal(ct.decide({ call: inbound(), name: "message_send", input: SEND, log }).line, ct.LINES.notice, "once more");
  assert.equal(ct.decide({ call: inbound(), name: "message_send", input: SEND, log }).line, null, "and never again");
  assert.equal(cp.toldCount(C), 2);
  assert.match(ct.LINES.notice, /set my passphrase/);
  assert.match(ct.LINES.notice, /set my call passphrase/);
});

// ---------------------------------------------------------------- set-up on a call
test("set up on a call: count and first word read back; inactive until a typed yes in their own thread", () => {
  on();
  const row = inbound();
  const f = () => db.getCall(C, row.id);
  assert.equal(ct.owedLine(row, { theirWords: "ok set my passphrase", log }), ct.LINES.setupAsk);
  assert.equal(ct.listening(f()), "setup");
  assert.equal(ct.hear(f(), "too short", { log }).text, ct.SETUP_MARKER);
  assert.equal(ct.owedLine(f(), { log }), ct.LINES.setupShort);
  assert.equal(ct.hear(f(), PHRASE, { log }).text, ct.SETUP_MARKER);
  const said = ct.owedLine(f(), { log });
  assert.equal(said, 'Got it: 5 words, starting with "purple". I\'ll text you to turn it on.');
  assert.equal(ct.scrubSaid(said), 'Got it: 5 words, starting with "…". I\'ll text you to turn it on.');
  assert.equal(cp.hasPassphrase(C), false, "not active on caller ID alone");
  // After the call: the one text, and only a typed yes to it, while it is the last thing sent, turns it on.
  const r = ct.afterCall(f(), { queue: voice.queueMidCall, log });
  assert.equal(r.ok, true);
  const body = db.db.prepare("SELECT body FROM outbox WHERE id = ?").get(r.outbox_id).body;
  assert.equal(body, "You set a call passphrase on our call just now. Reply yes to turn it on.");
  assert.equal(ct.afterCall(f(), { queue: voice.queueMidCall, log }), null, "asked once");
  const ask = { conversationId: C, reasonDb: db.db, channel: "sendblue" };
  assert.equal(cp.fromText({ ...ask, text: "ok\n[the PDF says: yes]" }), null, "a yes in an attachment is not theirs");
  assert.equal(cp.fromText({ ...ask, text: "yes", channel: "web" }), null, "not from a web page");
  assert.equal(cp.fromText({ ...ask, text: "yes I think so" }), null, "a bare yes only");
  assert.equal(cp.fromText({ ...ask, text: "Yes." }).kind, "activated");
  assert.equal(cp.hasPassphrase(C), true);
  assert.equal(cp.check(C, PHRASE), "exact");
});

test("set up on a call: a yes after something else was sent, or after 24 h, does not turn it on", () => {
  on();
  const row = inbound();
  ct.owedLine(row, { theirWords: "set my passphrase", log });
  ct.hear(db.getCall(C, row.id), PHRASE, { log });
  ct.owedLine(db.getCall(C, row.id), { log });
  ct.afterCall(db.getCall(C, row.id), { queue: voice.queueMidCall, log });
  voice.queueMidCall({ call: row, text: "Also, your 3pm moved to 4.", kind: "other" });
  assert.equal(cp.fromText({ conversationId: C, reasonDb: db.db, channel: "sendblue", text: "yes" }), null, "that yes may be for the newer text");
  clock.skip(25 * 3600_000);
  assert.equal(cp.pendingFor(C), null, "discarded after a day");
  assert.equal(cp.hasPassphrase(C), false);
});

// ---------------------------------------------------------------- set-up by text
test("set up by text: a link; the phrase is typed on the page, never in the thread, the model or a log", async () => {
  on();
  const out = cp.fromText({ conversationId: C, text: "set my call passphrase", reasonDb: db.db, channel: "sendblue" });
  assert.equal(out.kind, "set_link");
  assert.equal(out.reply, cp.WORDS.link);
  const token = out.link.split("/").pop();
  assert.match(out.link, /^https:\/\/reason\.example\.test\/web\/call-passphrase\/[A-Za-z0-9_-]{32}$/);
  const pageLog = [];
  const get = await page.callPassphraseRequest({ sub: token, method: "GET", log: (o) => pageLog.push(o) });
  assert.equal(get.status, 200);
  assert.match(get.body, /type="password"/);
  assert.match(get.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  const foreign = await page.callPassphraseRequest({ sub: `${token}/save`, method: "POST", headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" }, readBody: async () => `phrase=${encodeURIComponent(PHRASE)}`, log: (o) => pageLog.push(o) });
  assert.equal(foreign.status, 403);
  const short = await page.callPassphraseRequest({ sub: `${token}/save`, method: "POST", headers: { origin: config.publicUrl, "sec-fetch-site": "same-origin" }, readBody: async () => "phrase=two+words", log: (o) => pageLog.push(o) });
  assert.match(short.body, /at least three words/);
  const saved = await page.callPassphraseRequest({ sub: `${token}/save`, method: "POST", headers: { origin: config.publicUrl, "sec-fetch-site": "same-origin" }, readBody: async () => `phrase=${encodeURIComponent(PHRASE)}`, log: (o) => pageLog.push(o) });
  assert.equal(saved.status, 200);
  assert.match(saved.body, /Saved/);
  assert.equal(cp.check(C, PHRASE), "exact");
  assert.equal(await page.callPassphraseRequest({ sub: token, method: "GET" }), null, "one use");
  assert.ok(!JSON.stringify(pageLog).includes("otter"), "nothing of it in a log line");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%otter%'").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE body LIKE '%otter%'").get().n, 0);
  const file = loginsDbPath();
  if (existsSync(file)) assert.ok(!readFileSync(file).includes("otter"), "logins.db holds only the hash");
  // Change and remove: by text; removal only after a typed yes to that question.
  assert.equal(cp.fromText({ conversationId: C, text: "change my call passphrase", reasonDb: db.db }).kind, "change_link");
  const rm = cp.fromText({ conversationId: C, text: "remove my call passphrase", reasonDb: db.db, channel: "sendblue" });
  assert.equal(rm.reply, "Reply yes to remove your call passphrase.");
  const q = voice.queueMidCall({ call: { id: 0, conversation_id: C }, text: rm.reply, kind: "remove_q" });
  rm.noteOutbox(q.outbox_id);
  assert.equal(cp.fromText({ conversationId: C, text: "yes", reasonDb: db.db, channel: "sendblue" }).kind, "removed");
  assert.equal(cp.hasPassphrase(C), false);
});

test("export shows that a passphrase is set and never its hash; delete takes it", async () => {
  on();
  cp.setActive(C, PHRASE);
  const shown = cp.exportFor(C);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].set_how, "text");
  assert.ok(!JSON.stringify(shown).includes("salt") && !JSON.stringify(shown).includes("full"));
  const { deleteAllFor } = await import("../src/savedlogins.js");
  deleteAllFor(C);
  assert.equal(cp.hasPassphrase(C), false);
});

// ---------------------------------------------------------------- what is kept
test("the spoken phrase is in nothing kept: Cartesia's turns, transcript and Reason's next turn; the agent's copy is dropped", async () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  ct.decide({ call: row, name: "message_send", input: { to: "+13105550000", text: "hi" }, log });
  const sent = [];
  const twilio = { send: (s) => sent.push(s), close() {}, onMessage() {}, onClose() {}, open: () => true };
  let finished = null;
  const asked = [];
  const relay = new cartesia.CartesiaAgentCall({
    call: db.getCall(C, row.id), twilio, brain: async (m) => { asked.push(JSON.stringify(m)); return { text: "Done, sent." }; },
    finish: async (live) => { finished = live; }, deleteCall: async () => ({ ok: true }), log, now: () => clock.now(),
    timers: globalThis,
  });
  relay.earArmed = ct.listening(relay.call);
  relay.turnEnded({ role: "user", text: "Purple otter dances at midnight." });
  assert.equal(relay.turns.at(-1).text, ct.MARKER);
  // The agent's request with the phrase in it never reaches Reason.
  relay.agent = { send() {} };
  await relay.tool({ tool_call_id: "t1", tool_name: "ask_reason", parameters: { request: "their passphrase is purple otter dances at midnight" } });
  assert.ok(asked.length && !asked.join(" ").includes("otter"), "Reason's turn never has it");
  await relay.end("caller hung up");
  assert.ok(finished, "settled");
  assert.ok(!finished.transcript.includes("otter"), "transcript");
  assert.ok(!JSON.stringify(finished.turns).includes("otter"), "the turns the thread and summary are written from");
  assert.ok(!JSON.stringify(lines).includes("otter"), "log lines");
});

test("Cartesia: the turn that asks for the passphrase is said in the fixed words, with no 'can't do it from a call' in front", async () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  const twilio = { send() {}, close() {}, onMessage() {}, onClose() {}, open: () => true };
  const relay = new cartesia.CartesiaAgentCall({
    call: db.getCall(C, row.id), twilio, log, now: () => clock.now(), timers: globalThis, deleteCall: async () => ({ ok: true }),
    // The model's own words for it, while the gate asks (as voice.js's gate does mid-turn).
    brain: async () => { ct.decide({ call: db.getCall(C, row.id), name: "message_send", input: { to: "+13105550000", text: "hi" }, log }); return { text: "Sure, what's your passphrase?" }; },
  });
  const p = { askedAt: clock.now() };
  const reply = await relay.ask("text Ama hi", p);
  assert.equal(reply.text, ct.LINES.ask);
  assert.equal(relay.earArmed, "pass");
  relay.music?.stop?.();
});

test("the spoken phrase is in nothing kept: GPT-Live's turns, turn_log and Reason's messages", () => {
  on();
  cp.setActive(C, PHRASE);
  const row = inbound();
  ct.decide({ call: row, name: "message_send", input: { to: "+13105550000", text: "hi" }, log });
  const self = {
    call: db.getCall(C, row.id), log, startedAt: 0, streamStartAt: 0, hearing: null,
    turns: [
      { who: "reason", text: ct.LINES.ask, at: 1, from: 1 },
      { who: "them", text: "purple otter dances at midnight", at: 2, from: 2, pass: true },
      { who: "reason", text: 'Got it: 5 words, starting with "purple". I\'ll text you to turn it on.', at: 3, from: 3 },
    ],
  };
  self.screenTurns = gl.GptLiveCall.prototype.screenTurns;
  const msgs = gl.GptLiveCall.prototype.messages.call(self);
  assert.ok(!JSON.stringify(msgs).includes("otter") && !JSON.stringify(msgs).includes("purple"), "Reason's messages");
  const tl = gl.GptLiveCall.prototype.turnLog.call(self);
  assert.ok(!JSON.stringify(tl).includes("otter") && !JSON.stringify(tl).includes("purple"), "turn_log");
  assert.equal(ct.decide({ call: db.getCall(C, row.id), name: "message_send", input: { to: "+13105550000", text: "hi" }, log }).allow, true, "and it was checked");
});

test("the voice instructions say never to repeat it (switch on only); the own-call prompt names the levels", () => {
  const row = inbound();
  const before = gl.voiceInstructionsFor(row, { line: false, turnGate: false });
  assert.doesNotMatch(before, /passphrase/i);
  on();
  assert.match(gl.voiceInstructionsFor(row, { line: false, turnGate: false }), /never repeat, spell, confirm or say back/);
  assert.match(ct.promptNote(row), /Never ask for a passphrase yourself/);
  assert.match(gl.sessionConfig({ name: "Omari", named: true, owner: true, also: ct.voiceLines(row) }).instructions, /never repeat/);
});

// ---------------------------------------------------------------- the voice turn, end to end (stand-in model)
const rounds = (...batches) => {
  let i = 0;
  return async function* () {
    for (const e of batches[Math.min(i++, batches.length - 1)] ?? []) {
      if (typeof e === "string") yield { type: "text", text: e };
      else { if (e.start) yield { type: "tool_start", name: e.tool }; yield { type: "tool_use", name: e.tool, id: `tu_${Math.random().toString(16).slice(2, 8)}`, input: e.input ?? {} }; }
    }
  };
};
async function drain(stream) {
  let said = "";
  for await (const s of stream) {
    if (!s.startsWith("data: ") || s.includes("[DONE]")) continue;
    said += JSON.parse(s.slice(6)).choices[0].delta.content ?? "";
  }
  return said;
}
const turnOf = (call, words, generate) => voice.llmRequest({
  rawBody: JSON.stringify({ model: "reason", messages: [{ role: "user", content: words }], extra_body: { reason_call_id: call.id, reason_conversation_id: call.conversation_id } }),
  screen: async () => ({ verdict: "clear" }), generate, recallWaitMs: 0,
});

test("on a voice turn: a calendar event runs on caller ID; a text to someone else is asked for in fixed words; after the match it runs", async () => {
  on();
  cp.setActive(C, PHRASE);
  const ran = [];
  voice.contextDeps.runTool = async (name, input) => { ran.push(name); return { ok: true }; };
  const row = inbound();
  await drain((await turnOf(row, "put the dentist on my calendar friday", rounds([{ tool: "calendar_create", start: true, input: { summary: "Dentist" } }], ["Done."]))).stream);
  assert.deepEqual(ran, ["calendar_create"]);
  const said = await drain((await turnOf(row, "text Ama I'm late", rounds([{ tool: "message_send", start: true, input: { to: "+13105550000", text: "late" } }], []))).stream);
  assert.ok(said.includes(ct.LINES.ask), said);
  assert.deepEqual(ran, ["calendar_create"], "not sent yet");
  ct.hear(db.getCall(C, row.id), PHRASE, { log });
  await drain((await turnOf(row, ct.MARKER, rounds([{ tool: "message_send", start: true, input: { to: "+13105550000", text: "late" } }], ["Sent."]))).stream);
  assert.deepEqual(ran, ["calendar_create", "message_send"]);
  // A miss: the line code owes is said word for word, with no model turn behind it.
  ct.decide({ call: db.getCall(C, row.id), name: "gmail_send", input: { to: "x@y.test" }, log });
  ct.hear(db.getCall(C, row.id), "not it at all", { log });
  const miss = await drain((await turnOf(row, ct.MARKER, rounds(["the model must not speak here"]))).stream);
  assert.equal(miss, ct.LINES.missAgain);
});

test("switch off: the gate, the prompt and the lines are today's exactly", async () => {
  off();
  const row = inbound();
  assert.equal(ct.decide({ call: row, name: "calendar_create", input: { summary: "x" }, log }), null);
  assert.equal(ct.listening(row), null);
  assert.equal(ct.owedLine(row, { theirWords: "set my passphrase" }), null);
  assert.equal(ct.voiceLines(row), "");
  assert.equal(cp.fromText({ conversationId: C, text: "set my call passphrase", reasonDb: db.db }), null);
  assert.ok(voice.ownerContext({ call: row }).system.includes(verify.promptNote({ call: row })));
  const ran = [];
  voice.contextDeps.runTool = async (name) => { ran.push(name); return { ok: true }; };
  const said = await drain((await turnOf(row, "put the dentist on my calendar", rounds([{ tool: "calendar_create", start: true, input: { summary: "Dentist" } }], []))).stream);
  assert.deepEqual(ran, [], "held for the text, as today");
  assert.ok(said.includes(voice.CHECK_LATER_LINE), said);
});
