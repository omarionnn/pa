// A call remembers the last one (call 115, 2026-11-14): six minutes after his previous call he rang back
// and asked "where were we on the last call?"; the voice said it only knew this call. The per-call
// instructions came to ~18k characters and were cut at the end to 12k, before the brief began.
// Prompt assembly, guards and the opening line only: nothing here changes when anyone speaks. No network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call-memory-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_RECORDING_ROOT = join(dir, "recordings");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_UNDO_SECONDS = "0";
delete process.env.REASON_CALL_CARTESIA;
delete process.env.CARTESIA_API_KEY;
delete process.env.REASON_CARTESIA_VARIABLE_MAX;

const gl = await import("../src/calls/gptlive.js");
const cartesia = await import("../src/calls/cartesia.js");
const carry = await import("../src/calls/carryover.js");
const inbound = await import("../src/calls/inbound.js");
const voice = await import("../src/calls/voice.js");
const fit = await import("../src/calls/fitprompt.js");
const memorynote = await import("../src/memorynote.js");
const db = await import("../src/db.js");
const { config, clock } = await import("../src/config.js");

const C = config.ownerConversation;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NICK_FACT = "- Wants the assistant to answer to the name Hewie (inferred, Nov 10)";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  clock.reset();
  db.db.exec("DELETE FROM calls; DELETE FROM usage; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM timers; DELETE FROM tasks; DELETE FROM profile_blocks;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: "+12025551234", name: "Omari", isOperator: true });
  Object.assign(config, { callCarryover: "owner", callManner: "off", callIdentity: true, callVoice: "gptlive", callCacheWarm: false, openaiKey: "sk-test",
    callCartesia: "owner", cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" });
  carry.resetCarryover();
  await voice.prime();
});

/** A finished own call of theirs, `endedAgo` ms before now. */
function pastCall({ endedAgo, seconds = 170, summary = "", transcript = "Them: I want to get the market page out tonight and look at the ad copy after\nReason: Sure, I'll text you the market page." } = {}) {
  const row = db.createCall(C, { provider: "cartesia", toNumber: "+12025551234", isOwner: true, goal: "Omari called Reason", facts: [], announcement: "", direction: "in", state: "in_progress" });
  db.updateCall(C, row.id, { state: "completed", transcript, outcome_kind: "talked", duration_s: seconds, ...(summary ? { summary } : {}) });
  const end = clock.now() - endedAgo;
  db.db.prepare("UPDATE calls SET created_at = ?, ended_at = ? WHERE id = ?").run(end - seconds * 1000, end, row.id);
  return db.getCall(C, row.id);
}
const thisCall = () => db.createCall(C, { provider: "cartesia", toNumber: "+12025551234", isOwner: true, goal: "", facts: [], announcement: "", direction: "in", state: "in_progress" });
const text = (role, at, words) => db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, ?, 'sendblue', ?, ?)").run(C, role, words, at);

const LAST = "They told you: Wants the market page out tonight; Is reworking the ad copy\nYou said you'd: Text the market page MARKETPAGE-114\nLeft open: Whether to post the ad tonight";

/** Tonight's size: about 18k characters of instructions before any limit. */
function tonight() {
  const now = clock.now();
  pastCall({ endedAgo: 6 * MIN, summary: LAST });
  for (let i = 1; i <= 3; i++) pastCall({ endedAgo: i * 2 * HOUR, summary: `They told you: ${"older detail ".repeat(12)}${i}\nYou said you'd: ${"look into something ".repeat(8)}\nLeft open: ${"an older open thing ".repeat(8)}` });
  // Texted since the last call ended (8:26 PM in the story).
  text("assistant", now - 4 * MIN, "Here is the market page you asked for SINCE-TEXT-1");
  // A day of chats: today so far runs long.
  for (let i = 0; i < 40; i++) text(i % 2 ? "assistant" : "user", now - 10 * HOUR + i * 10 * MIN, `${"a line from today's chat about plans and errands ".repeat(3)}${i}`);
  db.saveProfile(C, ["**Omari**", NICK_FACT, ...Array.from({ length: 30 }, (_, i) => `- A standing fact about his week and his work number ${i} (inferred, Nov 9)`)].join("\n"), []);
  for (let i = 0; i < 4; i++) db.createTimer?.(C, { fireAt: now + (i + 1) * HOUR, note: `a reminder about something later ${i}`, kind: "reminder" });
  return thisCall();
}

// ---------- 1. priority order inside the limit ----------

test("call 115 at tonight's size: the earlier calls (newest first, the last one whole), what was texted since and the honesty rules are all in the agent's text", () => {
  const row = tonight();
  const uncut = cartesia.reasonCallFit(row, { max: 1_000_000 }).text;
  assert.ok(uncut.length >= 17_000, `the fixture is as large as tonight's (${uncut.length})`);
  const vars = cartesia.sessionVariables(row);
  const said = vars.reason_call;
  assert.ok(said.length <= cartesia.VARIABLE_MAX, `inside the limit (${said.length})`);
  // (b) the earlier calls, newest first, the last call's notes whole.
  assert.match(said, /EARLIER CALLS with them, newest first/);
  assert.ok(said.includes("MARKETPAGE-114"), "the last call's promise is there");
  assert.ok(said.includes("Whether to post the ad tonight"), "what was left open is there");
  const first = said.indexOf("MARKETPAGE-114");
  assert.ok(first < said.indexOf("older detail") || !said.includes("older detail"), "newest first");
  // (c) what was texted since.
  assert.match(said, /SINCE YOUR LAST CALL/);
  assert.ok(said.includes("SINCE-TEXT-1"));
  // (a) honesty, the memory rule and the line's own honesty lines, never cut.
  for (const l of [...gl.MEMORY_LINES, ...cartesia.HONESTY_LINES]) assert.ok(said.includes(l), l.slice(0, 50));
  assert.match(said, /Never say anything is done, booked, sent, texted/);
  assert.ok(said.includes(cartesia.clockLine(row)), "their clock");
  // Trimmed from the least important, never a cut mid-line at the end.
  const r = cartesia.reasonCallReport(row);
  assert.ok(r.dropped.length || r.trimmed.length, "something had to give");
  for (const keep of ["frame", "honesty", "earlier_calls", "since_last_call", "cartesia_honesty", "clock"]) assert.ok(r.kept.some(k => k.startsWith(`${keep}:`)), keep);
  assert.ok(!said.endsWith("…"), "no blind cut");
});

test("the last call of the past day is never cut, even with almost no room; older calls go first", () => {
  const row = tonight();
  const tiny = cartesia.reasonCallFit(row, { max: 1000 });
  assert.ok(tiny.text.includes("MARKETPAGE-114"));
  assert.ok(!tiny.text.includes("older detail"), "older calls were trimmed first");
  for (const l of gl.MEMORY_LINES) assert.ok(tiny.text.includes(l));
});

test("GPT-Live gets the same sections whole: memory rules, earlier calls first in the brief, since-last-call", () => {
  const row = tonight();
  const g = gl.voiceInstructionsFor(row, { line: false });
  for (const l of gl.MEMORY_LINES) assert.ok(g.includes(l));
  assert.ok(g.indexOf("EARLIER CALLS") < g.indexOf("Today so far"), "earlier calls lead the brief");
  assert.ok(g.includes("SINCE-TEXT-1"));
  // Not on anyone else's call.
  const line = gl.voiceInstructionsFor({ ...row, is_owner: 0 }, { line: false });
  assert.ok(!line.includes(gl.MEMORY_LINES[0]));
});

test("fitSections: rank 0 is never touched, order is kept, a section that runs oldest first loses its oldest lines", () => {
  const s = (n, r, lines, o) => fit.section(n, r, lines, o);
  const out = fit.fitSections([
    s("rules", 0, ["R".repeat(50)]),
    s("today", 9, ["Today:", "old 1", "old 2", "new 3"], { head: 1, from: "start" }),
    s("extra", 12, ["E".repeat(40)]),
    s("calls", 1, ["CALLS:", "newest", "older"], { head: 1, keep: 1 }),
  ], 90);
  assert.ok(out.text.startsWith("R".repeat(50)));
  assert.deepEqual(out.dropped, ["extra"]);
  assert.ok(out.text.includes("new 3") && !out.text.includes("old 1"));
  assert.ok(out.text.indexOf("Today:") < out.text.indexOf("CALLS:"), "order kept");
  const none = fit.fitSections([s("rules", 0, ["R".repeat(80)]), s("calls", 1, ["CALLS:", "newest"], { head: 1, keep: 1 })], 10);
  assert.ok(none.text.includes("newest") && none.text.includes("R".repeat(80)), "what may never be cut stays");
});

test("a newest call with no notes still says when it was", () => {
  // Midday in New York: on the real clock the call (begun about nine minutes before "now") fell on
  // yesterday for the first minutes after midnight, and "today" did not match.
  clock.skip(Date.UTC(2026, 10, 14, 17, 0) - clock.now());
  pastCall({ endedAgo: 6 * MIN, summary: "", transcript: "Them: hi\nReason: Hey." });
  const note = carry.earlierCallsNote(thisCall());
  assert.match(note, /today .*they called.*no notes were kept/);
});

// ---------- 2. memory questions go to the brain; "I only know this call" is flagged ----------

test("saysNoMemory: call 115's lines and their kin are flagged; a bad line and ordinary facts are not", () => {
  for (const t of ["I don't have the earlier bit.", "Sorry, I only know what's been said in this call.", "I don't have any memory of our last call.", "Each call starts fresh for me.",
    "I can't see our previous conversations.", "I wasn't on that call.", "This call is all I know.", "I don't remember our last conversation."]) assert.ok(gl.saysNoMemory(t), t);
  for (const t of ["Sorry, I didn't catch the last bit.", "Your last call with the dentist is at 3.", "I don't have anything on your calendar before 9.", "Asking Reason where we got to.", "I texted you the market page earlier."])
    assert.ok(!gl.saysNoMemory(t), t);
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
function relay() {
  const timers = fakeTimers();
  const h = { msg: [] };
  const twilio = { send: () => {}, open: () => true, close: () => {}, onMessage: (f) => h.msg.push(f), onClose: () => {}, say: (o) => h.msg.forEach(f => f(JSON.stringify(o))) };
  const sent = [];
  const ah = { open: [], event: [], close: [] };
  const socket = { send: (o) => sent.push(o), close: () => {}, on: (k, f) => ah[k].push(f) };
  const lines = [];
  const asked = [];
  const row = thisCall();
  const call = new cartesia.CartesiaAgentCall({
    call: row, twilio, openAgent: () => socket, now: timers.now, timers, log: (l) => lines.push(l),
    brain: (messages) => { asked.push(messages); return new Promise((r) => timers.setTimeout(() => r({ text: "Last call you wanted the market page; I texted it at 8:26." }), 100)); },
    deleteCall: async () => ({ ok: true, redacted: true, status: 200 }),
    textOwner: () => ({ ok: true }),
  });
  call.begin();
  twilio.say({ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } });
  ah.open.forEach(f => f());
  ah.event.forEach(f => f({ type: "session_ready", call_id: "ac_mem" }));
  let n = 1;
  const emit = (e) => ah.event.forEach(f => f(e));
  return {
    call, row, timers, lines, asked, sent,
    user: (t) => emit({ type: "turn_ended", turn: n++, role: "user", text: t, interrupted: false }),
    said: (t) => emit({ type: "turn_ended", turn: n++, role: "assistant", text: t, interrupted: false }),
    ask: (request) => emit({ type: "client_tool_call", tool_call_id: `tc_${n++}`, tool_name: "ask_reason", parameters: { request }, expects_response: true }),
    stop: () => { for (const k of ["roomTimer", "readyTimer"]) if (call[k]) timers.clearTimeout(call[k]); call.done = true; },
  };
}

test("a \"where were we\" turn goes to Reason's brain, whose call turn has the earlier calls; the answer is what the agent says", async () => {
  pastCall({ endedAgo: 6 * MIN, summary: LAST });
  const s = relay();
  s.user("Where were we on the last call?");
  s.ask("Where were we on the last call?");
  await s.timers.advance(300);
  assert.equal(s.asked.length, 1, "the brain was asked");
  assert.match(s.asked[0].at(-1).content, /where were we on the last call/i);
  const result = s.sent.filter(e => e.type === "client_tool_result").map(e => e.result);
  assert.match(result[0], /market page/);
  // The brain's own call turn reads the earlier calls (src/calls/voice.js ownerContext).
  const ctx = JSON.stringify(voice.ownerContext({ call: db.getCall(C, s.row.id) }));
  assert.ok(ctx.includes("MARKETPAGE-114"), "Reason's call turn has the last call");
  s.stop();
});

test("the agent saying it only knows this call is flagged: logged, counted, and the note is in the record for the next turn and the after-call text", async () => {
  const s = relay();
  s.user("Where were we on the last call?");
  s.said("I only know what's been said in this call.");
  assert.equal(s.call.m.memoryClaims, 1);
  assert.ok(s.lines.some(l => l.cartesia_memory_claim === s.row.id));
  assert.equal(s.call.turns.at(-1).text, gl.MEMORY_NOTE);
  assert.ok(s.call.messages("anything").some(m => m.content.includes(gl.MEMORY_NOTE)), "Reason's next turn reads it");
  s.said("Sure, asking Reason now.");
  assert.equal(s.call.m.memoryClaims, 1, "an ordinary line is not flagged");
  s.stop();
});

// ---------- 3. the opening line soon after a call ----------

test("ringing back within 30 minutes of a call with notes: the opening picks up from it; later, or with no notes, today's greeting", () => {
  pastCall({ endedAgo: 6 * MIN, summary: LAST });
  const soon = inbound.openingLineFor({ person: { name: "Omari" }, conversationId: C });
  assert.match(soon, /hey again, Omari — picking up from just now: I said I'd text the market page MARKETPAGE-114\./);
  assert.ok(!/what did we miss/.test(soon));
  db.db.exec("DELETE FROM calls"); carry.resetCarryover();
  pastCall({ endedAgo: 45 * MIN, summary: LAST });
  assert.ok(!/picking up/.test(inbound.openingLineFor({ person: { name: "Omari" }, conversationId: C })), "45 minutes on: the ordinary greeting");
  db.db.exec("DELETE FROM calls");
  pastCall({ endedAgo: 6 * MIN, summary: "" });
  assert.ok(!/picking up/.test(inbound.openingLineFor({ person: { name: "Omari" }, conversationId: C })), "no notes: the ordinary greeting");
});

test("the pick-up line says nothing about anyone in the third person, and falls back to what was left open", () => {
  assert.equal(carry.pickUpLine({ summary: "You said you'd: Send him the list\nLeft open: Which day for the dentist" }, "Omari"),
    "hey again, Omari — picking up from just now: we'd left off on which day for the dentist. what's up?");
  assert.equal(carry.pickUpLine({ summary: "They told you: Is tired" }, ""), "hey again — picking up from just now. what's up?");
  assert.equal(carry.pickUpLine({ summary: "" }, "Omari"), "");
});

// ---------- 4. a name they gave Reason is Reason's, never theirs ----------

test("the name he gave the assistant is said as the assistant's in texts and calls alike; the stored profile is unchanged", async () => {
  db.saveProfile(C, ["**Omari**", NICK_FACT, "- Works nights Thursday to Sunday (Nov 9)"].join("\n"), []);
  const call = voice.ownerProfileNote(C);
  const texts = (await memorynote.memoryNotes(C, "", { enabled: false })).join("\n");
  for (const shown of [call, texts]) {
    assert.match(shown, /They call YOU, their assistant, "Hewie": a nickname for you, not their name\. Their own name is Omari\. Never call them Hewie\. \(inferred, Nov 10\)/);
    assert.ok(!shown.includes(NICK_FACT), "the ambiguous wording is not shown");
    assert.ok(shown.includes("- Works nights Thursday to Sunday (Nov 9)"), "other lines as stored");
  }
  assert.ok(db.getProfile(C).block.includes(NICK_FACT), "his stored data is not changed");
  // The call's own identity line says who is who.
  const g = gl.voiceInstructionsFor(thisCall(), { line: false });
  assert.match(g, /you're Reason, their assistant, and they're Omari/);
  assert.match(g, /They call YOU, their assistant, "Hewie"/);
});

test("assistantNameIn: the forms such a fact takes, and not other names", () => {
  assert.equal(memorynote.assistantNameIn(NICK_FACT), "Hewie");
  assert.equal(memorynote.assistantNameIn("- Calls the assistant Hewie"), "Hewie");
  assert.equal(memorynote.assistantNameIn("- Prefers you to go by Hewie"), "Hewie");
  for (const no of ["- Has a cat named Biscuit", "- Asked Reason to call him back", "- His brother Kofi calls him Kwame"]) assert.equal(memorynote.assistantNameIn(no), "", no);
  assert.equal(memorynote.profileForPrompt("- Named the assistant Reason", "Omari"), "- Named the assistant Reason");
});

// ---------- call 116: a skipped question, a stale opener, a lost text ----------

test("call 116: a bare link texted since never takes the room of the words it came with", () => {
  const now = clock.now();
  pastCall({ endedAgo: 2 * HOUR, summary: LAST });
  // Newest last, the shape of the night: the page's words, its link, then a long evening of texts.
  text("assistant", now - 107 * MIN, `back on your events idea: at a 2% cut MARKET-NUMBERS-116 ${"the market is worth this much ".repeat(8)}`);
  text("assistant", now - 107 * MIN + 1, "https://files.example.test/abc?k=SECRETKEY");
  text("user", now - 91 * MIN, "Help me buy a case for my iPhone 14 Pro");
  text("assistant", now - 90 * MIN, `Here's the one I'd get ${"a long case answer ".repeat(12)}`);
  text("assistant", now - 90 * MIN + 1, "https://www.example.test/products/case");
  text("assistant", now - 59 * MIN, `Hope you're home by now ${"a long reminder ".repeat(14)}`);
  text("user", now - 11 * MIN, "Next week we're starting a crazy strict workout body care regiment");
  text("assistant", now - 11 * MIN + 1, `let's go ${"a long reply about the plan ".repeat(8)}`);
  const said = carry.sinceLastCallNote(thisCall());
  assert.ok(said.includes("MARKET-NUMBERS-116"), "the words kept");
  assert.ok(!said.includes("SECRETKEY") && !/https?:\/\//.test(said), "no bare link line");
});

test("call 116: the opener is never the last call's line (the call being greeted is a row with no words yet), and never 'hey — hey'", () => {
  const at = Date.UTC(2026, 10, 14, 3, 14); // 10:14 PM in New York
  clock.skip(at - Date.now());
  pastCall({ endedAgo: 2 * HOUR, seconds: 36, transcript: "Reason: hey — hey Omari, good to hear from you again — what's up?\nThem: where were we?" });
  for (let i = 0; i < 7; i++) pastCall({ endedAgo: (3 + i) * HOUR, transcript: "Reason: hey Omari\nThem: hi" });
  thisCall();
  // Written ahead now (src/calls/greetings.js): with none written, the plain line; never a stutter, never "what did we miss".
  const line = carry.greetingFor({ conversationId: C, name: "Omari", direction: "in" });
  assert.ok(!/good to hear from you again/.test(line), `not the last call's line: "${line}"`);
  assert.ok(!/what did we miss/.test(line));
  assert.equal(carry.GREETINGS, undefined, "no fixed list left to repeat");
  for (let i = 0; i < 40; i++) {
    const open = inbound.openingLineFor({ person: { name: "Omari" }, conversationId: C });
    assert.ok(!/^hey\s*—\s*hey\b/i.test(open), `stutter: "${open}"`);
    assert.doesNotMatch(open, /^(oh,|ah,|yo,) /, "no lead-in of code's");
  }
});

test("call 116: the turn rules skip only on a last-word filler, answer a finished sentence, and pick a missed turn back up after 'hello?'", async () => {
  const lines = cartesia.cartesiaCallLines({ tags: false });
  assert.match(lines, /Only when their very last word is a filler/);
  assert.match(lines, /even with an "um" inside it/);
  assert.match(lines, /If they say "hello\?" or "you there\?" after you said nothing, you missed their last turn/);
  assert.ok(!/stop on a filler or mid-thought/.test(lines), "the old, wider skip rule is gone");
  const setup = await import("../scripts/cartesia-agent-setup.mjs");
  assert.match(setup.SKIP_TURN_DESCRIPTION, /very last word is a filler/);
  assert.match(setup.SKIP_TURN_DESCRIPTION, /never because you didn't catch it/);
  assert.ok(setup.SKIP_TURN_DESCRIPTION.length <= 2000);
});

test("call 114/116: what Reason texted after an earlier call rides with that call, so a delivered thing is never read as still open", () => {
  const LEFT = "They told you: Wants total addressable market\nYou said you'd: Text the market sizing research when done\nLeft open: Total addressable market still unsized";
  const c114 = pastCall({ endedAgo: 3 * HOUR, summary: LEFT });
  text("assistant", carry.endOf(c114) + 20 * MIN, "Market sizing is done: about 1.2B a year in the US for small-venue ticketing, page here https://heyreason.com/p/abc?k=SECRETKEY");
  const c115 = pastCall({ endedAgo: 1 * HOUR, summary: "They told you: Asked where we were" });
  const now = thisCall();
  const note = carry.earlierCallsNote(db.getCall(C, now.id));
  const line114 = note.split("\n").find((l) => l.includes("still unsized"));
  assert.ok(line114, note);
  assert.match(line114, /Texted them after this call \(done, whatever is listed open above\): .*Market sizing is done/);
  assert.ok(!/https?:|SECRETKEY/.test(note), "no link, no access key");
  assert.match(note, /settles what it delivered: never call that still open/);
  // The newest earlier call's after-texts are in SINCE YOUR LAST CALL instead, not doubled here.
  assert.ok(!note.split("\n").find((l) => l.includes("Asked where we were"))?.includes("Texted them after"));
  assert.ok(c115);
});

test("since the last call: a link inside a text comes out, the words stay; texts past the room stay as one-line gists, not dropped", () => {
  const last = pastCall({ endedAgo: 2 * HOUR, summary: LAST });
  const base = carry.endOf(last);
  text("assistant", base + 1 * MIN, "MARKET-GIST the market numbers are in: 1.2B, see https://heyreason.com/p/x?k=KEY123 for the page");
  for (let i = 0; i < 6; i++) text(i % 2 ? "user" : "assistant", base + (5 + i) * MIN, `Filler message number ${i} `.repeat(12));
  const now = thisCall();
  const note = carry.sinceLastCallNote(db.getCall(C, now.id));
  assert.ok(!/https?:|KEY123/.test(note), note);
  assert.match(note, /you texted: MARKET-GIST the market numbers are in: 1\.2B/, "the oldest text survives as a gist");
  assert.match(note, /shortened to their first words/);
  assert.ok(note.length <= 850 + 300 + 300, `bounded: ${note.length}`);
  assert.equal(carry.withoutLinks("https://heyreason.com/p/x?k=1"), "");
  assert.equal(carry.withoutLinks("Here it is: https://a.test/x."), "Here it is");
  assert.equal(carry.withoutLinks("The page (https://a.test/x?k=1) has the numbers"), "The page has the numbers");
});
