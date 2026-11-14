// Scenarios for the classic-feel golden test (test/call-classic.test.js). The same seeding runs against the
// build that was live on call 112 (main 752a9e72) to write call-classic-baseline.json, and against this
// build in the test, so the two outputs come from the same inputs. Fixed times, no names of real people.
export const T0 = Date.parse("2026-11-13T16:38:11Z");
const MIN = 60_000, HOUR = 60 * MIN;
export const NAME = "Sam";
export const NUMBER = "+12025551234";
/** The app clock at the call's start (greetings and "now" lines read it). */
export const pin = (clock) => { clock.reset(); clock.skip(T0 - clock.now()); };

/** The env both builds are run with: the live call flags of 2026-11-13 (identity on, carry-over on, manner off). */
export const ENV = {
  REASON_OWNER_NAME: NAME, REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_OWNER_NUMBER: NUMBER,
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_UNDO_SECONDS: "0", REASON_CALL_IDENTITY: "on", REASON_CALL_CARRYOVER: "on",
  REASON_CALL_TURN_GATE: "on", REASON_CALL_CARTESIA: "owner", REASON_CARTESIA_LOOKUP_MUSIC: "soft-keys",
};
export const UNSET = ["REASON_CALL_MANNER", "REASON_CARTESIA_EMOTION_TAGS", "REASON_LINE_TALK", "REASON_CARTESIA_VARIABLE_MAX", "REASON_CALL_FEEL", "REASON_CALL_TRUST"];

function reset(db, C) {
  db.db.exec("DELETE FROM calls; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM timers; DELETE FROM profile_blocks;");
  db.saveConversation(C, []);
  db.upsertAccount({ conversationId: C, channel: "sendblue", address: NUMBER, name: NAME, isOperator: true });
}
const text = (db, C, role, at, words) => db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, ?, 'sendblue', ?, ?)").run(C, role, words, at);
function pastCall(db, C, { endedAt, seconds = 170, summary = "", transcript = "Them: I want to get the market page out tonight\nReason: Sure, I'll text you the market page." }) {
  const row = db.createCall(C, { provider: "cartesia", toNumber: NUMBER, isOwner: true, goal: "They called Reason", facts: [], announcement: "", direction: "in", state: "in_progress" });
  db.updateCall(C, row.id, { state: "completed", transcript, outcome_kind: "talked", duration_s: seconds, ...(summary ? { summary } : {}) });
  db.db.prepare("UPDATE calls SET created_at = ?, ended_at = ? WHERE id = ?").run(endedAt - seconds * 1000, endedAt, row.id);
}
function thisCall(db, C) {
  const row = db.createCall(C, { provider: "cartesia", toNumber: NUMBER, isOwner: true, goal: "", facts: [], announcement: "", direction: "in", state: "in_progress" });
  db.db.prepare("UPDATE calls SET created_at = ? WHERE id = ?").run(T0, row.id);
  return db.getCall(C, row.id);
}

/** Each returns this call's row, the DB seeded for it. */
export const SCENARIOS = {
  // A first call: nothing in the thread, no earlier calls.
  first(db, C) { reset(db, C); return thisCall(db, C); },
  // A quiet morning: two lines of chat, nothing else.
  quiet(db, C) {
    reset(db, C);
    db.saveConversation(C, [{ role: "user", content: "[09:10] Sam: morning, what's on today?" }, { role: "assistant", content: "Gym at 6, then the dentist at 2. Weather's dry." }]);
    return thisCall(db, C);
  },
  // A busy day, like call 112's: a long thread (the cut falls inside the brief), earlier calls with notes,
  // texts after the last one (one with a link), a profile and reminders.
  busy(db, C) {
    reset(db, C);
    const thread = [];
    for (let i = 0; i < 24; i++) thread.push(i % 2 ? { role: "assistant", content: `Done: the plan for item ${i} is set, and the next step is on your list ${"with a few more words ".repeat(3)}` } : { role: "user", content: `[10:${String(10 + i).padStart(2, "0")}] Sam: can you look at thing ${i} for me ${"and some detail ".repeat(4)}` });
    db.saveConversation(C, thread);
    pastCall(db, C, { endedAt: T0 - 25 * MIN, summary: "They told you: Wants the market page out tonight; Is reworking the ad copy\nYou said you'd: Text the market page\nLeft open: Whether to post the ad tonight" });
    pastCall(db, C, { endedAt: T0 - 5 * HOUR, summary: `They told you: ${"an older detail ".repeat(10)}\nYou said you'd: ${"look into something ".repeat(6)}\nLeft open: ${"an older open thing ".repeat(5)}` });
    text(db, C, "assistant", T0 - 20 * MIN, "Here is the market page you asked for: https://heyreason.com/p/abc123?k=secretkey and the copy notes");
    text(db, C, "user", T0 - 15 * MIN, "thanks, looks good");
    for (let i = 0; i < 30; i++) text(db, C, i % 2 ? "assistant" : "user", T0 - 9 * HOUR + i * 10 * MIN, `${"a line from today's chat about plans and errands ".repeat(3)}${i}`);
    db.saveProfile(C, ["**Sam**", ...Array.from({ length: 20 }, (_, i) => `- A standing fact about their week number ${i} (inferred, Nov 9)`)].join("\n"), []);
    return thisCall(db, C);
  },
};
