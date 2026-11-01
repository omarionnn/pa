// Calls 65–67 (2026-11-01) and the warmer, livelier own calls that came out of them, offline:
//   1. one phone, one call — a second call_place to a number already ringing/connected is handed into
//      that call; a long brief is fitted, not refused;
//   2. the call's goal and facts reach the voice, its opening line and Reason's call turn;
//   3. "Just texted." with no send behind it is never said, and a text to their own phone is not held
//      for the caller check;
//   4. the pre-call brief (purpose, their own recent chats, rough place only when they share it);
//   5. the café / office room under Reason's voice (REASON_CALL_AMBIENCE).
// Nothing dials, nothing runs a model, nothing reaches the network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-warmth-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_CALL_AMBIENCE;

const gl = await import("../src/calls/gptlive.js");
const amb = await import("../src/calls/ambience.js");
const db = await import("../src/db.js");
const voice = await import("../src/calls/voice.js");
const verify = await import("../src/calls/verify.js");
const tools = await import("../src/tools.js");
const { photoWords } = await import("../src/channels/router.js");
const { config, clock } = await import("../src/config.js");
const { FakeCallProvider } = await import("../src/calls/fake.js");

const C = config.ownerConversation;
const OTHER = "sendblue:+13105550000";
const TWILIO = { twilioSid: "AC_test", twilioToken: "twilio-test-token", twilioFrom: "+16562167455", openaiKey: "sk-test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM media_items;");
  db.saveConversation(C, []);
  db.saveConversation(OTHER, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: OTHER, channel: "sendblue", address: "+13105550000", name: "Ama", isOperator: false });
  Object.assign(config, { callIdentity: false, callVoice: "", callAmbience: "", ...TWILIO });
});

const call = (over = {}) => db.createCall(over.conversationId ?? C, {
  provider: over.provider ?? "gptlive", toNumber: over.toNumber ?? "+12025551234", isOwner: over.isOwner ?? true,
  goal: over.goal ?? "Talk through the two ad screenshots he sent", facts: over.facts ?? ["Car one: caption too long"],
  announcement: over.announcement ?? "hey Omari, what's up?", state: over.state ?? "placing",
});

function fakeTimers() {
  let t = 1_000_000;
  let q = [];
  let n = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { q = q.filter(x => x.id !== id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        t = next.at;
        next.fn();
        await new Promise(r => setImmediate(r));
      }
      t = end;
    },
  };
}
function fakeTwilio() {
  const sent = [];
  const handlers = { msg: [], close: [] };
  return {
    sent, open: () => true, send: (s) => sent.push(JSON.parse(s)), close: () => {},
    onMessage: (f) => handlers.msg.push(f), onClose: (f) => handlers.close.push(f),
    say: (obj) => handlers.msg.forEach(f => f(JSON.stringify(obj))),
  };
}
function fakeLive() {
  const sent = [];
  const h = { open: [], event: [], close: [] };
  return {
    sent, socket: { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) },
    open: () => h.open.forEach(f => f()), emit: (e) => h.event.forEach(f => f(e)),
    of: (type) => sent.filter(e => e.type === type),
  };
}
function startCall({ row = call(), brain = async () => ({ text: "", tools: [] }) } = {}) {
  config.callVoice = "gptlive";
  const timers = fakeTimers();
  const twilio = fakeTwilio();
  const live = fakeLive();
  const lines = [];
  const c = new gl.GptLiveCall({ call: db.getCall(row.conversation_id, row.id) ?? row, twilio, openLive: () => live.socket, brain, now: timers.now, timers, log: (o) => lines.push(o), finish: async () => {} });
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  live.open();
  return { c, timers, twilio, live, lines, row };
}

// ---------- 1. one phone, one call ----------

test("fitCallBrief: a 700-character goal is fitted, every word kept, instead of 'at most 600'", () => {
  const goal = "Talk through ad styles for Reason with Omari. ".repeat(16).trim();
  const out = tools.fitCallBrief({ to: "owner", goal, facts: ["x".repeat(450)] });
  assert.ok(out.goal.length <= 600);
  assert.ok(out.facts.every(f => f.length <= 200) && out.facts.length <= 20);
  const words = (t) => t.replace(/\s+/g, "");
  assert.equal(words(out.goal + out.facts.join("")), words(goal + "x".repeat(450)), "nothing lost");
  const short = { to: "owner", goal: "say hi" };
  assert.deepEqual(tools.fitCallBrief(short), short, "a brief that fits is untouched");
});

test("call_place: the long goal that failed on calls 66 and 67 now places", async () => {
  const calls = new FakeCallProvider();
  const goal = "Talk through ad styles for Reason with Omari, based on the two screenshots he sent. ".repeat(9);
  const out = await tools.runTool("call_place", { to: "owner", goal }, { conversationId: C, calls });
  assert.equal(out.ok, true, out.error);
  assert.equal(calls.placed.length, 1);
});

test("call_place: a second call to a phone already ringing is handed into that call, never dialled", async () => {
  const calls = new FakeCallProvider();
  const first = await tools.runTool("call_place", { to: "owner", goal: "Talk through the car screenshot" }, { conversationId: C, calls });
  assert.equal(first.ok, true, first.error);
  const second = await tools.runTool("call_place", { to: "owner", goal: "Talk through both screenshots", facts: ["Night street one: strong hook"] }, { conversationId: C, calls });
  assert.equal(second.ok, true);
  assert.equal(second.status, "already_on_the_call");
  assert.equal(second.call_id, first.call_id);
  assert.equal(calls.placed.length, 1, "one phone, one call");
  assert.ok(db.getCall(C, first.call_id).facts.includes("Night street one: strong hook"), "the new part is on the live call's row");
});

test("call_place: the same number on somebody else's live call is busy — refused, and nothing crosses over", async () => {
  call({ conversationId: OTHER, toNumber: "+12125550123", isOwner: false, state: "in_progress", goal: "Ama's errand" });
  const calls = new FakeCallProvider();
  const out = await tools.runTool("call_place", { to: "+12125550123", goal: "ask the hours", confirmation_id: 1 }, { conversationId: C, calls, confirmationId: 1 });
  if (out.status === "line_busy") {
    assert.doesNotMatch(JSON.stringify(out), /Ama/);
    assert.equal(calls.placed.length, 0);
  } else {
    assert.equal(out.ok, false, "refused one way or another (the confirm gate comes first)");
  }
  assert.equal(db.liveCallTo("+12125550123").conversation_id, OTHER);
});

test("liveCallTo: a call older than the platform cap is a crash, not a ringing phone", () => {
  const row = call({ state: "in_progress" });
  assert.equal(db.liveCallTo("+12025551234").id, row.id);
  assert.equal(db.liveCallTo("+12025551234", { now: clock.now() + 2 * 60 * 60_000 }), null);
  db.updateCall(C, row.id, { state: "completed" });
  assert.equal(db.liveCallTo("+12025551234"), null);
});

test("tellLive: a note for a call still ringing waits for its session, then goes in as instructions", async () => {
  const row = call();
  assert.equal(gl.tellLive(row.id, gl.toldNote({ goal: "his second photo came in", facts: ["photo #197"] })), true);
  const { live } = startCall({ row });
  assert.equal(live.of("session.instructions.append").length, 0);
  live.emit({ type: "session.started", session: { id: "s1" } });
  const told = live.of("session.instructions.append");
  assert.equal(told.length, 1);
  assert.match(told[0].content, /^New since this call was placed.*second photo came in\n- photo #197/s);
  assert.match(told[0].content, /Do not say you were going to call again/);
  gl.tellLive(row.id, "and one more thing");
  assert.equal(live.of("session.instructions.append").length, 2, "a started call is told at once");
});

test("photoWords: a folded photo is named by id, with its words when it had some", () => {
  assert.equal(photoWords("", [197]), "[they sent a photo, #197: photo_look 197 puts it in front of you]");
  assert.match(photoWords("this one", [5, 6]), /^this one \[they sent a photo, #5.*#6/);
});

// ---------- 2 + 4. what the voice, the opener and the backend know ----------

test("the voice gets the call's purpose, facts and their own recent chats in a short pre-call brief", () => {
  db.saveConversation(C, [
    { role: "user", content: "[Sun, Nov 1, 2026, 1:05 PM] Omari: here's the ad style I like" },
    { role: "assistant", content: "Got it — the car one. Ringing you now 📞" },
  ]);
  db.saveConversation(OTHER, [{ role: "user", content: "[Sun, Nov 1, 2026, 1:00 PM] Ama: my locker code is 4471" }]);
  const row = call();
  const s = gl.sessionConfig({ ...gl.whoFor(db.getCall(C, row.id)), greeting: "hey Omari, what's up?" });
  assert.match(s.instructions, /PRE-CALL BRIEF/);
  assert.match(s.instructions, /Why you rang them: Talk through the two ad screenshots he sent/);
  assert.match(s.instructions, /- Car one: caption too long/);
  assert.match(s.instructions, /them: here's the ad style I like\nyou: Got it — the car one/);
  assert.doesNotMatch(s.instructions, /locker|4471|Ama|Sun, Nov 1/, "nothing of anybody else's, and no stamps");
  for (const l of gl.OWN_CALL_LINES) assert.ok(s.instructions.includes(l));
  assert.doesNotMatch(s.instructions, /Roughly where they are/, "no place unless they share it");
});

test("the brief is sealed per person: Ama's own call gets her chat, never Omari's", () => {
  db.saveConversation(C, [{ role: "user", content: "[x] Omari: my gate code is 9911" }]);
  db.saveConversation(OTHER, [{ role: "user", content: "[x] Ama: lunch at Dig was great" }]);
  const brief = gl.preCallBrief(db.getCall(OTHER, call({ conversationId: OTHER, toNumber: "+13105550000", goal: "check in" }).id));
  assert.match(brief, /lunch at Dig/);
  assert.doesNotMatch(brief, /9911|gate|Omari/);
});

test("no brief, no warm lines on a call to somebody else", () => {
  const row = call({ isOwner: false, toNumber: "+12125550123" });
  const who = gl.whoFor(db.getCall(C, row.id));
  assert.equal(who.brief, undefined);
  assert.doesNotMatch(gl.liveInstructions(who), /PRE-CALL BRIEF|friendly, chatty/);
});

test("roughly where they are: only while they share their location, and a neighbourhood, never an address", async () => {
  const geo = async () => ({ neighbourhood: "Williamsburg", city: "New York", road: "Bedford Ave", display_name: "123 Bedford Ave" });
  assert.equal(await tools.roughPlaceFor(C, { reverseGeocode: geo }), "", "nothing shared");
  db.upsertThread?.({ conversationId: C, channel: "sendblue", address: "+12025551234" });
  db.db.prepare("INSERT OR IGNORE INTO threads (conversation_id, channel, address, updated_at) VALUES (?, 'sendblue', '+12025551234', ?)").run(C, clock.now());
  db.recordSharedLocation(C, { latitude: 40.71, longitude: -73.96, at: clock.now() - 4 * 60 * 60_000 });
  assert.equal(await tools.roughPlaceFor(C, { reverseGeocode: geo }), "", "a location sent four hours ago and no live share: not shared now");
  db.recordSharedLocation(C, { latitude: 40.71, longitude: -73.96, at: clock.now() - 10 * 60_000 });
  assert.equal(await tools.roughPlaceFor(C, { reverseGeocode: geo }), "Williamsburg, New York");
  assert.equal(await tools.roughPlaceFor(OTHER, { reverseGeocode: geo }), "", "never another person's");
  const row = call();
  const { live } = startCall({ row });
  gl.notePlace(row.id, "Williamsburg, New York");
  live.emit({ type: "session.started", session: { id: "s2" } });
  assert.match(live.of("session.instructions.append").at(-1).content, /Roughly where they are right now .*Williamsburg, New York.*never say an address/);
});

test("the opening line leads with why: the model's opening, or the voice told the purpose", async () => {
  const calls = new FakeCallProvider();
  const out = await tools.runTool("call_place", { to: "owner", goal: "Talk through his two ad screenshots", opening: "got your two screenshots, wanted to talk them through" }, { conversationId: C, calls });
  assert.equal(out.ok, true, out.error);
  assert.equal(db.getCall(C, out.call_id).announcement, "hey Omari — got your two screenshots, wanted to talk them through.");
  const bare = call();
  const who = gl.whoFor(db.getCall(C, bare.id));
  assert.equal(who.purpose, "Talk through the two ad screenshots he sent");
  const g = gl.greetingInstruction("hey Omari, what's up?", who.purpose);
  assert.match(g, /starting with "hey Omari" and then, in the same breath, a few natural words of why you're ringing \(Talk through the two ad screenshots he sent\)/);
  assert.equal(gl.whoFor(db.getCall(C, call({ announcement: "hey Omari — got your photos." }).id)).purpose, "", "a line that already says why is said as it is");
});

test("Reason's call turn is told why it rang, what it has, and the photos with their ids — no hunting", () => {
  db.recordMedia({ conversationId: C, channel: "sendblue", externalId: "m1", ordinal: 1, kind: "image", filename: "IMG_5207.heic", url: "https://x/y" });
  const media = db.db.prepare("SELECT id FROM media_items ORDER BY id DESC LIMIT 1").get();
  db.coverMedia(media.id, { coverage: "looked", detail: "night street, 'I don't mean to alarm anyone'" });
  const row = db.getCall(C, call().id);
  const note = voice.placedCallNote(row);
  assert.match(note, /^YOU rang THEM, and this is why: "Talk through the two ad screenshots he sent"/);
  assert.match(note, /- Car one: caption too long/);
  if (/photo #/.test(note)) assert.match(note, new RegExp(`photo #${media.id}`));
  assert.equal(voice.placedCallNote({ ...row, direction: "in" }), "", "not on a call they made");
  assert.equal(voice.placedCallNote({ ...row, is_owner: 0 }), "", "not on an errand");
});

// ---------- 3. honest about texts ----------

test("'Just texted.' is a claim, and a result that says it with no send behind it never reaches the voice", () => {
  assert.equal(gl.claimsDone("Just texted. Pick whichever one feels most like you."), true);
  assert.equal(gl.claimsDone("I'll just text you that."), false);
  const r = gl.withoutUnbackedSends("Sounds good. Just texted. Pick whichever one feels most like you.", ["end_call"]);
  assert.equal(r.dropped, 1);
  assert.doesNotMatch(r.text, /Just texted/);
  assert.match(r.text, /^I'll text that over to you now\./);
  assert.equal(gl.withoutUnbackedSends("Just texted it.", ["message_send"]).dropped, 0, "a send that ran stands");
});

test("call 67's ending: the unbacked 'Just texted.' is replaced before the voice hears it", async () => {
  const { live, timers } = startCall({ brain: async () => ({ text: "Just texted. Pick whichever one feels most like you and let me know.", tools: ["end_call"], endCall: null }) });
  live.emit({ type: "session.started", session: { id: "s3" } });
  live.emit({ type: "session.input_transcript.delta", delta: " Yeah, do that" });
  live.emit({ type: "session.delegation.created", delegation: { id: "d1", type: "delegation", target: "client" } });
  await timers.advance(10);
  const said = live.of("session.commentary.append").find(e => e.delegation_id === "d1").content;
  assert.doesNotMatch(said, /Just texted/);
  assert.match(said, /I'll text that over to you now/);
});

test("a text to their own phone is not held for the caller check; a text to anybody else still is", () => {
  const toSelf = (to) => tools.addressedToOwner(C, to);
  assert.equal(verify.isConsequential("message_send", { to: "owner", text: "the options" }, { toSelf }), false);
  assert.equal(verify.isConsequential("message_send", { to: "+12025551234", text: "x" }, { toSelf }), false);
  assert.equal(verify.isConsequential("message_send", { to: "+13105550000", text: "x" }, { toSelf }), true);
  assert.equal(verify.isConsequential("message_send"), true, "no input: gated, as before");
});

// ---------- 5. the room under the voice ----------

test("REASON_CALL_AMBIENCE: unset is off; owner is the operator's calls; on is everyone's; café own, office errands", () => {
  assert.equal(amb.ambienceMode(""), "");
  assert.equal(amb.ambienceMode("off"), "");
  assert.equal(amb.ambienceMode("owner"), "owner");
  assert.equal(amb.ambienceMode("on"), "everyone");
  const own = db.getCall(C, call().id);
  const errand = db.getCall(C, call({ isOwner: false, toNumber: "+12125550123" }).id);
  const ama = db.getCall(OTHER, call({ conversationId: OTHER, toNumber: "+13105550000" }).id);
  assert.equal(amb.ambienceKind(own), "", "unset: nobody");
  config.callAmbience = "owner";
  assert.equal(amb.ambienceKind(own), "cafe");
  assert.equal(amb.ambienceKind(errand), "office");
  assert.equal(amb.ambienceKind(ama), "", "owner: not another person's");
  config.callAmbience = "on";
  assert.equal(amb.ambienceKind(ama), "cafe");
});

test("the beds: 20 s each, quiet (about 20 dB under a voice), and seamless at the wrap", async () => {
  const { readFileSync } = await import("node:fs");
  for (const kind of ["cafe", "office"]) {
    const bed = new amb.Bed(kind);
    assert.equal(bed.s.length, 160_000);
    const rms = Math.sqrt(bed.s.reduce((a, v) => a + v * v, 0) / bed.s.length);
    assert.ok(rms > 150 && rms < 700, `${kind} rms ${rms.toFixed(0)}`);
    const jump = Math.abs(bed.s[0] - bed.s.at(-1));
    assert.ok(jump < 2500, `${kind}: no click at the loop point (${jump})`);
    assert.equal(readFileSync(new URL(`../assets/calls/ambience-${kind}.ulaw`, import.meta.url)).length, 160_000);
  }
});

test("mix and fill: the room goes under every frame and keeps the line topped up, never on the call's playhead", () => {
  const bed = new amb.Bed("cafe");
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  const mixed = Buffer.from(bed.mix(silence, 1000), "base64");
  assert.ok(mixed.some(b => b !== 0xff), "silence comes out as the room");
  assert.equal(bed.at, 1020);
  assert.equal(bed.fill(1000 - amb.FILL_BELOW_MS), null, "FILL_BELOW_MS or more queued: nothing yet");
  const topped = Buffer.from(bed.fill(1000), "base64");
  assert.equal(topped.length, 60 * 8, "20 ms queued: topped up to LEAD_MS (80) in whole 20 ms frames");
  assert.equal(bed.at, 1000 + amb.LEAD_MS);
  bed.cleared(2000);
  assert.equal(bed.at, 2000);
  bed.off = true;
  assert.equal(bed.fill(5000), null, "off: nothing");
  assert.equal(bed.mix(silence, 5000), silence, "off: the voice untouched");
});

test("a live own call with ambience on: café frames flow from the start, under the voice, and stop at the end", async () => {
  config.callAmbience = "owner";
  const { c, twilio, timers, live } = startCall();
  assert.equal(c.bed.kind, "cafe");
  await timers.advance(200);
  const room = twilio.sent.filter(m => m.event === "media");
  assert.ok(room.length >= 3, "the room is there before a word is said");
  assert.equal(c.queuedMs(), 0, "and the call's own playhead does not count it");
  live.emit({ type: "session.started", session: { id: "s4" } });
  const voiceFrame = Buffer.alloc(160, 0xff).toString("base64");
  live.emit({ type: "session.output_audio.delta", delta: voiceFrame });
  assert.notEqual(twilio.sent.filter(m => m.event === "media").at(-1).media.payload, voiceFrame, "the voice frame went out with the room under it");
  void c.end("test").catch(() => {});
  const n = twilio.sent.length;
  await timers.advance(500);
  assert.equal(twilio.sent.length, n, "nothing after the call is down");
});

test("ambience unset: not one extra frame on the line (today's calls, byte for byte)", async () => {
  const { c, twilio, timers } = startCall();
  assert.equal(c.bed, null);
  await timers.advance(500);
  assert.equal(twilio.sent.filter(m => m.event === "media").length, 0);
});

test("an errand that reaches a voicemail: the office room stops before the message", async () => {
  config.callAmbience = "owner";
  Object.assign(config, { thirdPartyVoice: "gptlive" });
  const row = call({ isOwner: false, toNumber: "+12125550123", announcement: "" });
  const { c } = startCall({ row });
  assert.equal(c.bed?.kind, "office");
  c.started = true;
  c.amd("machine_end_beep");
  assert.equal(c.bed.off, true);
  void c.end("test").catch(() => {});
});
