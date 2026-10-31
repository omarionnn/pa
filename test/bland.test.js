// The Bland adapter, driven entirely by an injected fetch.
//
// Nothing in this file touches the network and nothing in it could ring a phone: every request is
// caught by a stub that records what it was handed, and the key is a string that is not a key. The
// point is that the *request* is right — the exact URL, the exact body, `record: true` on every
// one of them, the announcement in `first_sentence` word for word, and the standing rules ahead of
// the goal in `task` — because that is the whole of what can be proven before Omari has an account.
//
// Everything asserted against Bland's docs here is from the pages named in src/calls/bland.js,
// read on 2026-10-05. What those docs leave open is in docs/unverified.md, not guessed at here.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "reason-bland-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
// The daily call caps are proven here on the owner's own thread, so the operator's exemption from
// them is off (REASON_CALL_CAPS_EXEMPT; its default is proven in test/accounts.test.js).
process.env.REASON_CALL_CAPS_EXEMPT = "none";
// Calling hours off in here, so these tests do not depend on what time it is when the suite runs
// (REASON_CALL_QUIET_HOURS defaults to 21:00-08:00, and a suite run at midnight would see every
// call refused for the hour rather than for the reason being tested). The window itself is proven
// in test/call-handling.test.js, against a fixed clock.
process.env.REASON_CALL_QUIET_HOURS = "";
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_CALL_MAX_MINUTES = "10";
// Not a key. Nothing here authenticates against anything; this only proves the header shape.
process.env.BLAND_API_KEY = "bland-test-key";
// Not an undo-window test: anything reaching a third party is normally held for 30 seconds
// before it really goes, which would make every send in here come back 'held' instead of done.
// Off, so these keep asking what they are about. test/undo-window.test.js is where the window
// itself is proven.
process.env.REASON_UNDO_SECONDS = "0";

const { BlandCallProvider, buildTask, mapState, TASK_MAX_CHARS } = await import("../src/calls/bland.js");
const { chooseCallProvider } = await import("../src/calls/choose.js");
const { announcementFor, callRulesFor } = await import("../src/calls/provider.js");
const { runTool, capabilitiesNow } = await import("../src/tools.js");
const { callWebhookRequest } = await import("../src/http.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const OWNER = "+12025551234";
const PLACE = "+12125559999";
const ANN = announcementFor({ ownerName: "Omari" });
const RULES = callRulesFor({ ownerName: "Omari" });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  config.publicUrl = "";
  config.blandWebhookSecret = "";
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM confirmations; DELETE FROM action_ledger; DELETE FROM threads;");
});

const owner = (t) => ({ role: "user", content: `[Wed, Sep 30, 2026, 3:00 PM] Omari: ${t}` });

/** A fetch that answers whatever is scripted and keeps every request it was handed. */
function stubFetch(answers) {
  const seen = [];
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  const impl = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body ? JSON.parse(opts.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next();
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.json ?? {} };
  };
  impl.seen = seen;
  return impl;
}

/** A real WAV of the given length: 8 kHz, 8-bit, mono, silent. Small, and it is actually audio. */
function wavOf(seconds) {
  const data = Buffer.alloc(Math.round(seconds * 8000), 0x80);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1"); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1"); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
  head.write("data", 36, "latin1"); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** One fetch answer carrying a body and a content-type, the way a real response does. */
function answer(body, type, { status = 200 } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(bytes.toString("utf8")),
  };
}

/**
 * Bland's recording endpoint as it really behaves, copied from the first real call on 2026-10-05:
 * GET /v1/calls/{id}/recording answers 200 with JSON naming a second address, and the audio is
 * there. Keeps every request, so a test can say where the key went.
 */
function blandAudio({ pointer, audio = wavOf(45), audioType = "audio/x-wav" } = {}) {
  const seen = [];
  const impl = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers ?? {} });
    if (/\/v1\/calls\/[^/]+\/recording$/.test(String(url))) {
      const id = String(url).split("/").at(-2);
      return answer({ code: 200, status: "success", url: pointer ?? `https://api.bland.ai/v1/recordings/${id}` }, "application/json; charset=utf-8");
    }
    return answer(audio, audioType);
  };
  impl.seen = seen;
  return impl;
}

/** The happy-path place() arguments, so a test only states the bit it is about. */
const PLACE_ARGS = {
  to: PLACE, goal: "ask if they have a table for 4 at 8 on Saturday", facts: ["four people", "Saturday"],
  maxSeconds: 600, announcement: ANN, rules: RULES, onBehalfOf: "Omari",
};

/** Ask, answer yes — the confirm gate's happy path, so call_place can get as far as the provider. */
async function yesFor(summary, { target } = {}) {
  const asked = await runTool("confirm_request", { action: "call_place", summary, ...(target ? { target } : {}) },
    { conversationId: C, messages: [owner("do it")] });
  await runTool("confirm_record", { confirmation_id: asked.confirmation_id },
    { conversationId: C, messages: [owner("do it"), owner("yeah go")], judge: async () => ({ verdict: "yes" }) });
  return asked.confirmation_id;
}

// ---------- is it connected ----------

test("no key is not_connected and names the variable; a key is live and records", () => {
  const off = new BlandCallProvider({ key: "" });
  assert.equal(off.status().status, "not_connected");
  assert.deepEqual(off.status().missing, ["BLAND_API_KEY"]);

  const on = new BlandCallProvider({ key: "k" });
  assert.equal(on.status().status, "live");
  assert.equal(on.status().name, "bland");
  // Always true: `record: true` is on every request this adapter sends, so there is no
  // configuration in which it is a provider that cannot record.
  assert.equal(on.status().records, true);
});

test("capabilities says phone calls are connected only with the provider AND the key", () => {
  const withKey = capabilitiesNow({ calls: new BlandCallProvider({ key: "k" }) }).find(c => c.name === "phone_calls");
  assert.equal(withKey.status, "live");
  assert.match(withKey.what, /bland/);
  assert.match(withKey.what, /recorded/);

  const noKey = capabilitiesNow({ calls: new BlandCallProvider({ key: "" }) }).find(c => c.name === "phone_calls");
  assert.equal(noKey.status, "not connected");
  assert.match(noKey.what, /BLAND_API_KEY/);
  assert.match(noKey.what, /Do not offer to/i);
});

test("REASON_CALL_PROVIDER picks the provider, and a name Reason does not have says so", () => {
  assert.equal(chooseCallProvider({ provider: "bland" }).name, "bland");
  // The default is the fake, deliberately switched off.
  const fake = chooseCallProvider({ provider: "fake" });
  assert.equal(fake.name, "fake");
  assert.equal(fake.status().status, "not_connected");

  const nonsense = chooseCallProvider({ provider: "blandd" });
  assert.equal(nonsense.status().status, "not_connected");
  assert.match(nonsense.status().what, /not a call provider Reason has/);
  assert.match(nonsense.status().what, /bland, fake/);
  assert.equal(nonsense.status().records, false);
});

// ---------- placing one ----------

test("the request is exactly what Bland's Send Call page documents", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "9d404c1b" } });
  const p = new BlandCallProvider({ key: "bland-test-key", fetchImpl });

  const out = await p.place({ ...PLACE_ARGS, callbackUrl: "https://reason.example/calls/bland/webhook/TOK" });
  assert.deepEqual(out, { ok: true, externalId: "9d404c1b", state: "placing" });

  const [req] = fetchImpl.seen;
  assert.equal(req.url, "https://api.bland.ai/v1/calls");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.authorization, "Bearer bland-test-key");
  assert.equal(req.headers["content-type"], "application/json");

  assert.equal(req.body.phone_number, PLACE);
  // The one that cannot be left off: `record` defaults to FALSE at Bland.
  assert.equal(req.body.record, true);
  // 600 seconds is 10 minutes, and max_duration is in minutes.
  assert.equal(req.body.max_duration, 10);
  assert.equal(req.body.webhook, "https://reason.example/calls/bland/webhook/TOK");
  // Pinned rather than left to their defaults: neither of these may change under Reason.
  assert.deepEqual(req.body.voicemail, { action: "hangup" });
  assert.equal(req.body.ivr_mode, false);
  // No number of our own, so Bland dials from its own pool and `from` is not sent at all.
  assert.equal("from" in req.body, false);
});

test("the announcement is first_sentence, word for word, and is not also in the prompt", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c1" } });
  await new BlandCallProvider({ key: "k", fetchImpl }).place(PLACE_ARGS);

  const { body } = fetchImpl.seen[0];
  assert.equal(body.first_sentence, ANN);
  assert.match(body.first_sentence, /AI assistant/);
  assert.match(body.first_sentence, /Omari/);
  assert.match(body.first_sentence, /recorded/);
  // The prompt must not carry a second copy for the model to improvise around.
  assert.equal(body.task.includes(ANN), false);
  assert.match(body.task, /opening line is already set/i);
});

test("the standing rules go into task AHEAD of the goal", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c1" } });
  await new BlandCallProvider({ key: "k", fetchImpl }).place(PLACE_ARGS);

  const { task } = fetchImpl.seen[0].body;
  const payment = task.indexOf("Never give out payment details");
  const goal = task.indexOf("table for 4 at 8");
  assert.ok(payment > -1, "the payment rule is in the prompt");
  assert.ok(goal > -1, "the goal is in the prompt");
  assert.ok(payment < goal, "the rules come before the goal");
  // Every rule, not just the first.
  for (const r of RULES) assert.ok(task.includes(r), `missing rule: ${r.slice(0, 40)}`);
  // And only the facts that were approved.
  assert.match(task, /- four people/);
  assert.match(task, /- Saturday/);
});

test("a call with no announcement, or no payment rule, is refused and nothing is sent", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c1" } });
  const p = new BlandCallProvider({ key: "k", fetchImpl });

  const noAnn = await p.place({ ...PLACE_ARGS, announcement: "hi it's me" });
  assert.equal(noAnn.ok, false);
  assert.match(noAnn.error, /AI assistant/);

  const noRules = await p.place({ ...PLACE_ARGS, rules: ["be nice"] });
  assert.equal(noRules.ok, false);
  assert.match(noRules.error, /payment details/);

  const noRecordingLine = await p.place({ ...PLACE_ARGS, announcement: "Hi — this is an AI assistant calling on behalf of Omari." });
  assert.equal(noRecordingLine.ok, false);
  assert.match(noRecordingLine.error, /recorded/);

  assert.deepEqual(fetchImpl.seen, [], "nothing was sent");
});

test("a prompt that will not fit under Bland's limit is refused, never trimmed", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c1" } });
  const p = new BlandCallProvider({ key: "k", fetchImpl });

  const out = await p.place({ ...PLACE_ARGS, goal: "x".repeat(TASK_MAX_CHARS) });
  assert.equal(out.ok, false);
  assert.match(out.error, /Nothing was dialled/);
  assert.match(out.error, /rules are not the part that gets cut/);
  assert.deepEqual(fetchImpl.seen, []);

  // And the rules survive intact in the version that does fit.
  const fits = buildTask({ goal: "ask about a table", facts: [], rules: RULES, ownerName: "Omari" });
  assert.equal(fits.ok, true);
  assert.ok(fits.task.length <= TASK_MAX_CHARS);
  for (const r of RULES) assert.ok(fits.task.includes(r));
});

test("a number that is not E.164 is refused before a request is spent on it", async () => {
  const fetchImpl = stubFetch({ json: {} });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).place({ ...PLACE_ARGS, to: "212-555-9999" });
  assert.equal(out.ok, false);
  assert.match(out.error, /E\.164/);
  assert.deepEqual(fetchImpl.seen, []);
});

test("with no key nothing is attempted, whatever else is right", async () => {
  const fetchImpl = stubFetch({ json: {} });
  const out = await new BlandCallProvider({ key: "", fetchImpl }).place(PLACE_ARGS);
  assert.equal(out.ok, false);
  assert.match(out.error, /BLAND_API_KEY/);
  assert.deepEqual(fetchImpl.seen, []);
});

test("BLAND_FROM_NUMBER, when there is one, rides on the request", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c1" } });
  await new BlandCallProvider({ key: "k", from: "+15551230000", fetchImpl }).place(PLACE_ARGS);
  assert.equal(fetchImpl.seen[0].body.from, "+15551230000");
});

test("with no public URL no webhook is sent, and the call is still placed", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c1" } });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).place(PLACE_ARGS);
  assert.equal(out.ok, true);
  assert.equal("webhook" in fetchImpl.seen[0].body, false);
});

test("Bland refusing, or answering without a call_id, comes back in words", async () => {
  const refused = stubFetch({ ok: false, status: 429, json: { status: "error", message: "Call Frequency Limit" } });
  const a = await new BlandCallProvider({ key: "k", fetchImpl: refused }).place(PLACE_ARGS);
  assert.equal(a.ok, false);
  assert.match(a.error, /HTTP 429/);
  assert.match(a.error, /Call Frequency Limit/);

  const noId = stubFetch({ json: { status: "success" } });
  const b = await new BlandCallProvider({ key: "k", fetchImpl: noId }).place(PLACE_ARGS);
  assert.equal(b.ok, false);
  assert.match(b.error, /no call_id/);

  const threw = async () => { throw new Error("socket hang up"); };
  const c = await new BlandCallProvider({ key: "k", fetchImpl: threw }).place(PLACE_ARGS);
  assert.equal(c.ok, false);
  assert.match(c.error, /could not be reached/);
  assert.match(c.error, /socket hang up/);
});

// ---------- reading one back ----------

/** A Bland call object, shaped like the example on their Call Details page. */
const callBody = (over = {}) => ({
  call_id: "9d404c1b",
  completed: true,
  queue_status: "complete",
  status: "completed",
  answered_by: "human",
  corrected_duration: "45",
  call_length: 0.75,
  price: 0.068,
  record: true,
  recording_url: "https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/REy",
  summary: "They have a table at 8.",
  transcripts: [
    { id: 1, user: "assistant", text: "Do you have a table for four at eight?" },
    { id: 2, user: "user", text: "Yes, we do." },
    { id: 3, user: "agent-action", text: "Ended call" },
  ],
  ...over,
});

test("a finished call comes back with its outcome, length, cost and transcript", async () => {
  const fetchImpl = stubFetch({ json: callBody() });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).check("9d404c1b");

  assert.equal(fetchImpl.seen[0].url, "https://api.bland.ai/v1/calls/9d404c1b");
  assert.equal(fetchImpl.seen[0].headers.authorization, "Bearer k");
  assert.equal(out.ok, true);
  assert.equal(out.state, "completed");
  assert.equal(out.outcome, "they answered");
  assert.equal(out.summary, "They have a table at 8.");
  // corrected_duration is the real length in seconds, not max_duration.
  assert.equal(out.durationS, 45);
  // price is USD; the call row keeps whole cents.
  assert.equal(out.costCents, 7);
  assert.equal(out.transcript, "Reason: Do you have a table for four at eight?\nThem: Yes, we do.\n(call): Ended call");
});

test("the audio is fetched from Bland's own endpoint, with the key, never from recording_url", async () => {
  const fetchImpl = stubFetch({ json: callBody() });
  const out = await new BlandCallProvider({ key: "secret-key", fetchImpl }).check("9d404c1b");

  // recording_url in this payload points at api.twilio.com. Sending the key there would hand it to
  // a third party, and the docs never say that URL needs one.
  assert.equal(out.recording.url, "https://api.bland.ai/v1/calls/9d404c1b/recording");
  assert.equal(out.recording.headers.authorization, "Bearer secret-key");
  // "Defaults to WAV" when no content-type is asked for, and none is.
  assert.equal(out.recording.format, "wav");
  assert.equal(out.recording.seconds, 45);
  assert.equal(out.recordingWhy, "");
});

test("an answered call with no recording_url is a fault, and says so", async () => {
  const fetchImpl = stubFetch({ json: callBody({ recording_url: null }) });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).check("x");
  assert.equal(out.state, "completed");
  assert.equal(out.recording, null);
  assert.match(out.recordingWhy, /answered but Bland returned no recording_url/);

  // And the one that should be impossible: Bland saying the call was not recorded at all.
  const off = stubFetch({ json: callBody({ recording_url: null, record: false }) });
  const b = await new BlandCallProvider({ key: "k", fetchImpl: off }).check("x");
  assert.equal(b.recording, null);
  assert.match(b.recordingWhy, /record came back false/);
});

test("nobody picking up is not a missing recording", async () => {
  const fetchImpl = stubFetch({ json: callBody({ status: "no-answer", answered_by: "no-answer", recording_url: null, summary: "" }) });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).check("x");
  assert.equal(out.state, "no_answer");
  assert.equal(out.recording, null);
  assert.equal(out.recordingWhy, "", "no alarm: there was nothing to record");
});

test("Bland's statuses map onto Reason's, and voicemail is read from answered_by", () => {
  // The one that matters most: a voicemail is still status completed at Bland, so reading only
  // `status` would file every answering machine as a conversation that happened.
  assert.equal(mapState({ completed: true, status: "completed", answered_by: "voicemail" }), "voicemail");
  assert.equal(mapState({ completed: true, status: "completed", answered_by: "human" }), "completed");
  // "unknown is most likely a human", and null means still processing. Both count as a
  // conversation, which is the direction that errs towards reporting a missing recording.
  assert.equal(mapState({ completed: true, status: "completed", answered_by: "unknown" }), "completed");
  assert.equal(mapState({ completed: true, status: "completed", answered_by: null }), "completed");
  assert.equal(mapState({ completed: true, status: "completed", answered_by: "no-answer" }), "no_answer");

  assert.equal(mapState({ completed: true, status: "no-answer" }), "no_answer");
  assert.equal(mapState({ completed: true, status: "busy" }), "busy");
  assert.equal(mapState({ completed: true, status: "failed" }), "failed");
  // Bland has no state for the other end rejecting the call, and none for a cancelled one that
  // Reason also has. Neither is invented: see docs/unverified.md.
  assert.equal(mapState({ completed: true, status: "canceled" }), "failed");
  assert.equal(mapState({ completed: true, status: "unknown" }), "failed");

  // Still going, read off queue_status, because `status` is "only present for calls that have been
  // successfully created" and a live call may carry none.
  assert.equal(mapState({ completed: false, queue_status: "new" }), "placing");
  assert.equal(mapState({ completed: false, queue_status: "queued" }), "placing");
  assert.equal(mapState({ completed: false, queue_status: "allocated" }), "placing");
  assert.equal(mapState({ completed: false, queue_status: "started" }), "in_progress");
  assert.equal(mapState({ completed: false, queue_status: "pre_queue_error" }), "failed");
  assert.equal(mapState({ completed: false, queue_status: "call_error" }), "failed");
  assert.equal(mapState({}), "placing");
});

test("a failed call carries Bland's own error_message rather than a shrug", async () => {
  const fetchImpl = stubFetch({ json: callBody({ status: "failed", error_message: "The number you dialed is not found.", recording_url: null }) });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).check("x");
  assert.equal(out.state, "failed");
  assert.match(out.outcome, /The number you dialed is not found/);
});

test("a call still going reports where it is and claims no outcome", async () => {
  const fetchImpl = stubFetch({ json: { call_id: "x", completed: false, queue_status: "started" } });
  const out = await new BlandCallProvider({ key: "k", fetchImpl }).check("x");
  assert.equal(out.state, "in_progress");
  assert.equal(out.summary, "");
  assert.equal(out.recording, null);
  assert.equal(out.recordingWhy, "");
});

test("Bland being unreachable on a check is said, not swallowed", async () => {
  const out = await new BlandCallProvider({ key: "k", fetchImpl: async () => { throw new Error("ETIMEDOUT"); } }).check("x");
  assert.equal(out.ok, false);
  assert.match(out.error, /could not be reached/);

  const bad = stubFetch({ ok: false, status: 404, json: {} });
  const b = await new BlandCallProvider({ key: "k", fetchImpl: bad }).check("x");
  assert.equal(b.ok, false);
  assert.match(b.error, /HTTP 404/);
});

// ---------- the call-finished webhook ----------

const sign = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

test("with a signing secret, only a correctly signed delivery is taken", () => {
  const p = new BlandCallProvider({ key: "k", webhookSecret: "whsec" });
  const raw = JSON.stringify(callBody());

  const good = p.receiveWebhook({ rawBody: raw, headers: { "x-webhook-signature": sign("whsec", raw) } });
  assert.equal(good.ok, true);
  assert.equal(good.signed, true);
  assert.equal(good.live.state, "completed");

  const wrong = p.receiveWebhook({ rawBody: raw, headers: { "x-webhook-signature": sign("other", raw) } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 401);
  assert.match(wrong.error, /did not match/);

  const unsigned = p.receiveWebhook({ rawBody: raw, headers: {} });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.status, 401);
  assert.match(unsigned.error, /no X-Webhook-Signature/);
});

test("the re-serialised body Bland's own example signs is accepted too", () => {
  const p = new BlandCallProvider({ key: "k", webhookSecret: "whsec" });
  // Their verification snippet hashes JSON.stringify(req.body), which is not byte-for-byte what
  // arrived once a body has any whitespace in it.
  const raw = JSON.stringify(callBody(), null, 2);
  const overCompact = sign("whsec", JSON.stringify(JSON.parse(raw)));
  assert.equal(p.receiveWebhook({ rawBody: raw, headers: { "x-webhook-signature": overCompact } }).ok, true);
});

test("with no signing secret the delivery is taken on its per-call token alone, and says so", () => {
  const p = new BlandCallProvider({ key: "k", webhookSecret: "" });
  const out = p.receiveWebhook({ rawBody: JSON.stringify(callBody()), headers: {} });
  assert.equal(out.ok, true);
  assert.equal(out.signed, false, "nothing was verified beyond the token in the URL");
});

test("a body that is not JSON is a 400, not a crash", () => {
  const p = new BlandCallProvider({ key: "k" });
  assert.equal(p.receiveWebhook({ rawBody: "<html>", headers: {} }).status, 400);
});

test("a webhook settles the call: state, cost, and the audio filed", async () => {
  config.publicUrl = "https://reason.example";
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "bland-1" } }) });
  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  assert.equal(placed.ok, true);

  const row = db.getCall(C, placed.call_id);
  assert.ok(row.webhook_token, "a call is issued its own webhook token");

  // The audio fetch is the only thing the settle path reaches out for, and it is stubbed.
  const audio = blandAudio();
  const out = await callWebhookRequest({
    provider: "bland", token: row.webhook_token, rawBody: JSON.stringify(callBody({ call_id: "bland-1" })),
    headers: {}, calls, fetchImpl: audio,
  });

  assert.equal(out.status, 200);
  const after = db.getCall(C, placed.call_id);
  assert.equal(after.state, "completed");
  assert.equal(after.cost_cents, 7);
  assert.equal(after.duration_s, 45);
  assert.equal(after.recording_state, "stored");
  assert.match(after.recording_file, /call-\d+\.wav$/);
  // What is on disk is the audio, not the JSON that said where the audio was.
  assert.equal(readFileSync(after.recording_file).toString("latin1", 0, 4), "RIFF");
  assert.equal(after.recording_bytes, wavOf(45).length);
});

// ---------- the recording endpoint as it really answers ----------

/** Place a call and hand back its row, ready for a webhook to settle. */
async function placedCall(externalId) {
  config.publicUrl = "https://reason.example";
  const calls = new BlandCallProvider({ key: "secret-key", fetchImpl: stubFetch({ json: { status: "success", call_id: externalId } }) });
  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  assert.equal(placed.ok, true);
  return { calls, row: db.getCall(C, placed.call_id) };
}

const settleBy = (calls, row, body, fetchImpl) => callWebhookRequest({
  provider: "bland", token: row.webhook_token, rawBody: JSON.stringify(body), headers: {}, calls, fetchImpl,
});

test("the recording endpoint answers with JSON naming the audio, and the audio is what gets saved", async () => {
  const { calls, row } = await placedCall("0c045995");
  // The first real call, to the byte: 22 seconds, recording_url on Bland's own host.
  const body = callBody({ call_id: "0c045995", corrected_duration: undefined, call_length: 0.366666666666667, recording_url: "https://api.bland.ai/v1/recordings/0c045995" });
  const fetchImpl = blandAudio({ audio: wavOf(22) });
  await settleBy(calls, row, body, fetchImpl);

  assert.deepEqual(fetchImpl.seen.map(r => r.url), [
    "https://api.bland.ai/v1/calls/0c045995/recording",
    "https://api.bland.ai/v1/recordings/0c045995",
  ]);
  // The second address answers 401 without the key, so it goes there too — and it is Bland's host.
  assert.equal(fetchImpl.seen[1].headers.authorization, "Bearer secret-key");

  const after = db.getCall(C, row.id);
  assert.equal(after.recording_state, "stored");
  assert.equal(after.recording_seconds, 22);
  const saved = readFileSync(after.recording_file);
  assert.equal(saved.length, wavOf(22).length);
  assert.equal(saved.toString("latin1", 0, 4), "RIFF");
  assert.equal(saved.toString("latin1", 8, 12), "WAVE");
});

test("the key is never sent to an address the recording endpoint names on another host", async () => {
  for (const pointer of [
    "https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/REy",
    "https://api.bland.ai.evil.example/v1/recordings/x",
    "http://api.bland.ai/v1/recordings/x",
    "not a url",
  ]) {
    db.db.exec("DELETE FROM calls; DELETE FROM confirmations; DELETE FROM action_ledger;");
    const { calls, row } = await placedCall("bland-ptr");
    const fetchImpl = blandAudio({ pointer });
    await settleBy(calls, row, callBody({ call_id: "bland-ptr" }), fetchImpl);

    assert.deepEqual(fetchImpl.seen.map(r => r.url), ["https://api.bland.ai/v1/calls/bland-ptr/recording"], `${pointer} must not be fetched`);
    const after = db.getCall(C, row.id);
    assert.equal(after.recording_state, "missing", pointer);
    assert.match(after.recording_why, /only ever sent to api\.bland\.ai/);
    assert.equal(after.recording_file, null);
  }
});

test("a body that is not audio is a missing recording, never a stored one", async () => {
  const cases = [
    // What was really filed as call-1.wav: the pointer JSON, 111 bytes, answered for both requests.
    { name: "json twice", audio: Buffer.from('{"code":200,"status":"success","url":"https://api.bland.ai/v1/recordings/x"}'), type: "application/json; charset=utf-8", why: /not audio/ },
    { name: "json sent as audio", audio: Buffer.from('{"data":null,"errors":[{"error":"AUTHORIZATION_REQUIRED"}]}'), type: "audio/x-wav", why: /not audio/ },
    { name: "an html error page", audio: Buffer.from("<html><body>Bad gateway</body></html>"), type: "text/html", why: /sent as text\/html/ },
    { name: "real audio under the wrong type", audio: wavOf(45), type: "text/plain", why: /sent as text\/plain/ },
    { name: "a header and nothing after it", audio: wavOf(0.05), type: "audio/x-wav", why: /too small to be the recording: \d+ bytes for a 45-second call/ },
  ];
  for (const c of cases) {
    db.db.exec("DELETE FROM calls; DELETE FROM confirmations; DELETE FROM action_ledger;");
    const { calls, row } = await placedCall("bland-bad");
    await settleBy(calls, row, callBody({ call_id: "bland-bad" }), blandAudio({ audio: c.audio, audioType: c.type }));

    const after = db.getCall(C, row.id);
    assert.equal(after.recording_state, "missing", c.name);
    assert.match(after.recording_why, c.why, c.name);
    assert.equal(after.recording_file, null, c.name);
    assert.equal(existsSync(join(dir, "recordings", `call-${row.id}.wav`)), false, `${c.name}: nothing is written under the call's name`);
    // The same fault path as a provider that returned nothing: on the ledger, and said out loud.
    assert.equal(db.listActions(C).filter(a => a.action === "call_recording").length, 1, c.name);
    const view = (await runTool("call_status", { call_id: row.id }, { conversationId: C, calls })).calls[0];
    assert.match(view.recording_note, /SOMETHING WENT WRONG/, c.name);
  }
});

test("audio that comes back as MP3 is filed as MP3, whatever was expected", async () => {
  const { calls, row } = await placedCall("bland-mp3");
  // An ID3 tag and enough after it to be 45 seconds of something.
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x23", "latin1"), Buffer.alloc(60_000, 0x55)]);
  await settleBy(calls, row, callBody({ call_id: "bland-mp3" }), blandAudio({ audio: mp3, audioType: "audio/mpeg" }));
  const after = db.getCall(C, row.id);
  assert.equal(after.recording_state, "stored");
  assert.equal(after.recording_format, "mp3");
  assert.match(after.recording_file, /call-\d+\.mp3$/);
});

// ---------- what Bland fills in after the call has ended ----------

/** The first real call as it looked the moment it ended: over, and not yet priced or summarised. */
const justEnded = (over = {}) => callBody({ price: null, summary: null, ...over });

test("a call Bland has not priced yet is 'not known', never free", async () => {
  const p = new BlandCallProvider({ key: "k" });
  assert.equal(p.readCall(justEnded()).costCents, null, "price: null is not $0.00");
  assert.equal(p.readCall(callBody({ price: undefined })).costCents, null);
  assert.equal(p.readCall(callBody({ price: 0 })).costCents, null, "a 45-second call billed at nothing has not been billed yet");
  assert.equal(p.readCall(callBody({ price: 0.052 })).costCents, 5, "the first real call: $0.052");
  assert.equal(p.readCall(callBody({ price: 0.004 })).costCents, 1, "a real charge is never rounded to nothing");
  // Nobody picked up, nothing ran, nothing was charged: that zero is a real zero.
  assert.equal(p.readCall(callBody({ status: "no-answer", answered_by: "no-answer", corrected_duration: "0", call_length: 0, price: 0, recording_url: null })).costCents, 0);
});

test("the summary and the cost arrive after the call ends, and call_status goes back for them", async () => {
  const { row } = await placedCall("bland-late");
  // What call_status will be told when it asks again: the same call, now priced and summarised.
  const later = stubFetch({ json: callBody({ call_id: "bland-late", price: 0.052, summary: "It was a brief test call." }) });
  const calls = new BlandCallProvider({ key: "k", fetchImpl: later });

  await settleBy(calls, row, justEnded({ call_id: "bland-late" }), blandAudio());
  const settled = db.getCall(C, row.id);
  assert.equal(settled.state, "completed");
  assert.equal(settled.cost_cents, null);
  assert.equal(settled.summary, "");
  const minutes = db.db.prepare("SELECT * FROM usage").all();

  const view = (await runTool("call_status", { call_id: row.id }, { conversationId: C, calls })).calls[0];
  assert.equal(later.seen.length, 1, "a finished call that is still owed details is asked about once more");
  assert.equal(view.cost, "$0.05");
  // Their notes, behind who was really called: a provider's summary can take the owner named in the
  // greeting for the person rung (the 2026-10-27 Strand call).
  assert.match(view.what_was_said, /^Reason called \+12125559999 on Omari's behalf .*The call service's notes: It was a brief test call\.$/);

  const after = db.getCall(C, row.id);
  assert.equal(after.ended_at, settled.ended_at, "it ended when it ended");
  assert.equal(after.recording_sha256, settled.recording_sha256, "the audio is not fetched again");
  assert.deepEqual(db.db.prepare("SELECT * FROM usage").all(), minutes, "and its minutes are not counted twice");

  // Nothing is owed any more, so nothing is asked.
  await runTool("call_status", { call_id: row.id }, { conversationId: C, calls });
  assert.equal(later.seen.length, 1);
});

test("a webhook retry fills in what the first delivery was too early to carry", async () => {
  const { calls, row } = await placedCall("bland-retry");
  await settleBy(calls, row, justEnded({ call_id: "bland-retry" }), blandAudio());
  const out = await settleBy(calls, row, callBody({ call_id: "bland-retry", price: 0.052, summary: "They have a table at 8." }), blandAudio());
  assert.equal(out.body.already, true);
  const after = db.getCall(C, row.id);
  assert.equal(after.cost_cents, 5);
  assert.match(after.summary, /The call service's notes: They have a table at 8\.$/);
});

test("a call still unsummarised a week on is left alone", async () => {
  const { row } = await placedCall("bland-old");
  const later = stubFetch({ json: callBody({ call_id: "bland-old" }) });
  const calls = new BlandCallProvider({ key: "k", fetchImpl: later });
  await settleBy(calls, row, justEnded({ call_id: "bland-old" }), blandAudio());
  clock.skip(8 * 24 * 60 * 60 * 1000);
  await runTool("call_status", { call_id: row.id }, { conversationId: C, calls });
  assert.equal(later.seen.length, 0);
});

test("a webhook for a token nobody was issued is the same dull 404 as a made-up one", async () => {
  const calls = new BlandCallProvider({ key: "k" });
  const a = await callWebhookRequest({ provider: "bland", token: "A".repeat(32), rawBody: "{}", headers: {}, calls });
  assert.equal(a.status, 404);

  // And a provider that is not the one running.
  const b = await callWebhookRequest({ provider: "retell", token: "A".repeat(32), rawBody: "{}", headers: {}, calls });
  assert.equal(b.status, 404);

  // And with no provider at all.
  const c = await callWebhookRequest({ provider: "bland", token: "A".repeat(32), rawBody: "{}", headers: {}, calls: null });
  assert.equal(c.status, 404);
});

test("a webhook that arrives twice does not settle the call twice", async () => {
  config.publicUrl = "https://reason.example";
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "bland-2" } }) });
  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  const row = db.getCall(C, placed.call_id);

  const audio = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("RIFFfake-wav-bytes").buffer });
  const args = { provider: "bland", token: row.webhook_token, rawBody: JSON.stringify(callBody({ call_id: "bland-2" })), headers: {}, calls, fetchImpl: audio };
  await callWebhookRequest(args);
  const once = db.usageToday(C, new Date().toLocaleDateString("en-CA", { timeZone: config.tz })).call_seconds;

  const again = await callWebhookRequest(args);
  assert.equal(again.body.already, true);
  assert.equal(db.usageToday(C, new Date().toLocaleDateString("en-CA", { timeZone: config.tz })).call_seconds, once,
    "the same 45 seconds are not counted against the day twice");
});

test("a webhook whose payload is about a different call is refused, not written down", async () => {
  config.publicUrl = "https://reason.example";
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "bland-mine" } }) });
  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  const row = db.getCall(C, placed.call_id);

  const out = await callWebhookRequest({
    provider: "bland", token: row.webhook_token,
    rawBody: JSON.stringify(callBody({ call_id: "somebody-elses-call" })), headers: {}, calls,
  });
  assert.equal(out.status, 409);
  assert.equal(db.getCall(C, placed.call_id).state, "placing");
});

test("a webhook about a call that has not finished writes nothing", async () => {
  config.publicUrl = "https://reason.example";
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "bland-3" } }) });
  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  const row = db.getCall(C, placed.call_id);

  const out = await callWebhookRequest({
    provider: "bland", token: row.webhook_token,
    rawBody: JSON.stringify({ call_id: "bland-3", completed: false, queue_status: "started" }), headers: {}, calls,
  });
  assert.equal(out.status, 200);
  assert.equal(db.getCall(C, placed.call_id).state, "placing", "nothing was written down about an outcome");
});

// ---------- through call_place, end to end ----------

test("call_place sends the per-call webhook URL built from REASON_PUBLIC_URL", async () => {
  config.publicUrl = "https://reason.example";
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "bland-4" } });
  const calls = new BlandCallProvider({ key: "k", fetchImpl });

  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const out = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  assert.equal(out.ok, true);

  const row = db.getCall(C, out.call_id);
  assert.equal(fetchImpl.seen[0].body.webhook, `https://reason.example/calls/bland/webhook/${row.webhook_token}`);
  assert.equal(fetchImpl.seen[0].body.record, true);
});

test("with no REASON_PUBLIC_URL the call still goes, and the outcome is polled instead", async () => {
  config.publicUrl = "";
  const fetchImpl = stubFetch([
    { json: { status: "success", call_id: "bland-5" } },
    { json: callBody({ call_id: "bland-5", recording_url: null }) },
  ]);
  const calls = new BlandCallProvider({ key: "k", fetchImpl });

  const id = await yesFor(`ring ${PLACE} to ask about a table`, { target: PLACE });
  const placed = await runTool("call_place", { to: PLACE, goal: "ask about a table", facts: [], confirmation_id: id }, { conversationId: C, calls });
  assert.equal("webhook" in fetchImpl.seen[0].body, false);

  const status = await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });
  assert.equal(status.calls[0].state, "completed");
  // No recording came back for a call that was answered, so the owner is told in plain words.
  assert.match(status.audio_warning, /RECORDING MISSING/);
});

// ---------- what a day of calls may cost ----------

test("a person gets so many calls a day, and the refusal is honest about why", async () => {
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "c" } }) });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
  db.bumpUsage(C, day, "calls", config.maxCallsPerDay);

  const out = await runTool("call_place", { to: OWNER, goal: "remind them about dinner" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.status, "daily_call_cap");
  assert.match(out.error, /REASON_MAX_CALLS_PER_DAY/);
  assert.match(out.error, /Nobody's phone rang/);
  assert.equal(db.listCalls(C).length, 0, "no row, because nothing was placed");
});

test("a person gets so many call MINUTES a day, counted from calls that really ran", async () => {
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "c" } }) });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
  db.bumpUsage(C, day, "call_seconds", config.maxCallMinutesPerDay * 60);

  const out = await runTool("call_place", { to: OWNER, goal: "remind them about dinner" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.status, "daily_call_minutes_cap");
  assert.match(out.error, /REASON_MAX_CALL_MINUTES_PER_DAY/);
});

test("the operator's own calls are not stopped by the daily caps (only with REASON_CALL_CAPS_EXEMPT=operator)", async () => {
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "c" } }) });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
  db.bumpUsage(C, day, "calls", config.maxCallsPerDay + 2);
  db.bumpUsage(C, day, "call_seconds", (config.maxCallMinutesPerDay + 15) * 60);
  config.callCapsExempt = "operator";
  try {
    const out = await runTool("call_place", { to: OWNER, goal: "remind them about dinner" }, { conversationId: C, calls });
    assert.notEqual(out.status, "daily_call_cap");
    assert.notEqual(out.status, "daily_call_minutes_cap");
    assert.equal(out.ok, true, JSON.stringify(out));
  } finally { config.callCapsExempt = "none"; }
});

test("a finished call's real length is what goes against the day, once", async () => {
  const fetchImpl = stubFetch([
    { json: { status: "success", call_id: "bland-6" } },
    { json: callBody({ call_id: "bland-6", recording_url: null }) },
  ]);
  const calls = new BlandCallProvider({ key: "k", fetchImpl });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });

  const placed = await runTool("call_place", { to: OWNER, goal: "remind them about dinner" }, { conversationId: C, calls });
  assert.equal(placed.ok, true);
  assert.equal(db.usageToday(C, day).calls, 1, "placing it counts one call");
  assert.equal(db.usageToday(C, day).call_seconds, 0, "and no minutes until it has ended");

  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });
  assert.equal(db.usageToday(C, day).call_seconds, 45);

  // Asking again reads the finished row off the record and must not re-charge the day.
  await runTool("call_status", { call_id: placed.call_id }, { conversationId: C, calls });
  assert.equal(db.usageToday(C, day).call_seconds, 45);
});

test("0 means uncapped, for both call caps", async () => {
  const calls = new BlandCallProvider({ key: "k", fetchImpl: stubFetch({ json: { status: "success", call_id: "c" } }) });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
  db.bumpUsage(C, day, "calls", 9999);
  db.bumpUsage(C, day, "call_seconds", 9999 * 60);

  const limits = [config.maxCallsPerDay, config.maxCallMinutesPerDay];
  config.maxCallsPerDay = 0;
  config.maxCallMinutesPerDay = 0;
  try {
    const out = await runTool("call_place", { to: OWNER, goal: "remind them about dinner" }, { conversationId: C, calls });
    assert.equal(out.ok, true);
  } finally {
    [config.maxCallsPerDay, config.maxCallMinutesPerDay] = limits;
  }
});

// ---------- the refusals that were already there still hold ----------

test("a call carrying card details is refused before Bland is ever asked", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c" } });
  const calls = new BlandCallProvider({ key: "k", fetchImpl });
  const out = await runTool("call_place", {
    to: OWNER, goal: "hold the table", facts: ["card number 4242 4242 4242 4242"],
  }, { conversationId: C, calls });

  assert.equal(out.ok, false);
  assert.equal(out.status, "payment_details_refused");
  assert.deepEqual(fetchImpl.seen, [], "nothing reached Bland");
});

test("calling a third party still needs an explicit yes first", async () => {
  const fetchImpl = stubFetch({ json: { status: "success", call_id: "c" } });
  const calls = new BlandCallProvider({ key: "k", fetchImpl });
  const out = await runTool("call_place", { to: PLACE, goal: "ask about a table" }, { conversationId: C, calls });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, "needs_confirmation");
  assert.deepEqual(fetchImpl.seen, [], "nothing rang");
});
