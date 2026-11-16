// Classic feel for everyone (REASON_CALL_FEEL=classic with REASON_CALL_CARTESIA=on): every account's own call
// gets the same call-112 rule words, and every personal slot (name, greeting, keyterms, brief, earlier-call
// notes, texts since, their time, the passphrase line) is the caller's own or empty. Three made-up accounts:
// the operator (A) and two invited ones (B in Los Angeles, C in London). Free-tier people are on Cartesia too
// (no 5-minute cut since 2026-11-15). A Cartesia call has the platform ceiling. No network.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-classic-all-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_RECORDING_ROOT: join(dir, "recordings"),
  REASON_OWNER_NAME: "Ola", REASON_TZ: "America/New_York", REASON_CONVERSATION: "dm:owner", REASON_OWNER_NUMBER: "+12025551234",
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_UNDO_SECONDS: "0", REASON_TZ_ASK: "on",
  REASON_CALL_IDENTITY: "on", REASON_CALL_CARRYOVER: "on", REASON_CALL_FEEL: "classic", REASON_CALL_CARTESIA: "on", REASON_CALL_TRUST: "owner",
});
for (const k of ["CARTESIA_API_KEY", "REASON_CALL_MANNER", "REASON_CARTESIA_EMOTION_TAGS", "REASON_CARTESIA_VARIABLE_MAX", "REASON_FREE_TIER", "REASON_PAYWALL", "REASON_FREE_CALL_MINUTES"]) delete process.env[k];

const cartesia = await import("../src/calls/cartesia.js");
const classic = await import("../src/calls/callclassic.js");
const calltrust = await import("../src/calls/calltrust.js");
const carry = await import("../src/calls/carryover.js");
const trial = await import("../src/calls/calltrial.js");
const db = await import("../src/db.js");
const plan = await import("../src/plan.js");
const { config, clock } = await import("../src/config.js");

const A = config.ownerConversation;
const B = "sendblue:+13105550000";
const C = "sendblue:+447700900123";
const NUMBER = { [A]: "+12025551234", [B]: "+13105550000", [C]: "+447700900123" };
const NAME = { [A]: "Ola", [B]: "Bea", [C]: "Cyrus" };
const ZONE = { [A]: "America/New_York", [B]: "America/Los_Angeles", [C]: "Europe/London" };
// Each person's own made-up things: today's chat names, an earlier call's note, a text since it, a profile line.
const THEIRS = {
  [A]: { today: "Lunch with Kwame at Dishoom Kensington later", told: "Planning the Zanzibar trip", since: "the Zanzibar packing list", works: "Works at Halcyon Press" },
  [B]: { today: "Picking up Marisol from Lakeview Pottery at six", told: "Training for the Malibu half", since: "the Malibu race bib", works: "Works at Orchard Dental" },
  [C]: { today: "Coffee with Tobias at Brixton Rec", told: "Moving flat to Peckham Rye", since: "the Peckham Rye lease", works: "Works at Tidewater Books" },
};
const words = (xs) => xs.flatMap(s => s.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).filter(w => !["Lunch", "Picking", "Coffee", "Planning", "Training", "Moving", "Works"].includes(w));
// Everything of theirs (never in another's words), and what must reach their own call: the profile sits past
// the call-112 cut (12,000 in all, as on that call), so it is not looked for.
const tokens = (c) => [NAME[c], ...words(Object.values(THEIRS[c]))];
const reaches = (c) => [NAME[c], ...words([THEIRS[c].today, THEIRS[c].told, THEIRS[c].since])];
const MIN = 60_000;
const T0 = Date.parse("2026-11-14T19:21:00Z");
const KEYS = { cartesiaKey: "ck-test", cartesiaAgentId: "agent_test" };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset(); clock.skip(T0 - clock.now());
  delete process.env.REASON_FREE_TIER; delete process.env.REASON_PAYWALL;
  db.db.exec("DELETE FROM calls; DELETE FROM outbox; DELETE FROM threads; DELETE FROM accounts; DELETE FROM messages; DELETE FROM profile_blocks; DELETE FROM plan;");
  Object.assign(config, KEYS, { callFeel: "classic", callCartesia: "on" });
  carry.resetCarryover();
  for (const c of [A, B, C]) seed(c);
});

function seed(c) {
  db.upsertAccount({ conversationId: c, channel: "sendblue", address: NUMBER[c], name: NAME[c], isOperator: c === A });
  if (c !== A) db.setZoneFields(c, { confirmed: ZONE[c], confirmedAt: clock.now() });
  const day = new Intl.DateTimeFormat("en-US", { timeZone: ZONE[c], weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(T0));
  db.saveConversation(c, [{ role: "user", content: `[${day}, 9:00 AM] ${NAME[c]}: ${THEIRS[c].today}` }, { role: "assistant", content: "Noted." }]);
  const past = db.createCall(c, { provider: "cartesia", toNumber: NUMBER[c], isOwner: true, goal: "They called Reason", facts: [], announcement: "", direction: "in", state: "in_progress" });
  db.updateCall(c, past.id, { state: "completed", transcript: `Them: ${THEIRS[c].told}\nReason: Sounds good.`, outcome_kind: "talked", duration_s: 120, summary: `They told you: ${THEIRS[c].told}\nYou said you'd: Text ${THEIRS[c].since}\nLeft open: nothing` });
  db.db.prepare("UPDATE calls SET created_at = ?, ended_at = ? WHERE id = ?").run(T0 - 62 * MIN, T0 - 60 * MIN, past.id);
  db.db.prepare("INSERT INTO messages (conversation_id, role, channel, text, at) VALUES (?, 'assistant', 'sendblue', ?, ?)").run(c, `Here is ${THEIRS[c].since}`, T0 - 30 * MIN);
  db.saveProfile(c, [`**${NAME[c]}**`, `- ${THEIRS[c].works} (said, Nov 9)`].join("\n"), []);
}
function ownIn(c) {
  const row = db.createCall(c, { provider: "cartesia", toNumber: NUMBER[c], isOwner: true, goal: "", facts: [], announcement: "", direction: "in", state: "in_progress" });
  db.db.prepare("UPDATE calls SET created_at = ? WHERE id = ?").run(T0, row.id);
  return db.getCall(c, row.id);
}
const lineCall = (c) => db.createCall(c, { provider: "gptlive", toNumber: "+12125550100", isOwner: false, goal: "book a table", facts: [], announcement: `Hi, I'm calling for ${NAME[c]}.`, state: "placing" });
const terms = (v) => Object.entries(v).filter(([k]) => k.startsWith("keyterm_")).map(([, t]) => t);

test("classic for everyone: every own call is on Cartesia with the classic words; no business call ever is", () => {
  for (const c of [A, B, C]) {
    const call = ownIn(c);
    assert.equal(classic.classicFor(call), true, `${NAME[c]}: classic`);
    assert.equal(trial.cartesiaTrialFor(call), true, `${NAME[c]}: Cartesia`);
    assert.equal(cartesia.reasonCallReport(call).feel, "classic");
    const line = lineCall(c);
    assert.equal(classic.classicFor(line), false);
    assert.equal(trial.cartesiaTrialFor(line), false, `${NAME[c]}'s business call stays on the previous voice`);
  }
});

test("classic for everyone: each caller's instructions carry only their own name, greeting, keyterms, brief, notes and texts", () => {
  const vars = Object.fromEntries([A, B, C].map(c => [c, cartesia.sessionVariables(ownIn(c))]));
  for (const c of [A, B, C]) {
    const v = vars[c];
    assert.equal(v.their_name, NAME[c]);
    assert.match(v.greeting, new RegExp(NAME[c]));
    for (const t of reaches(c)) assert.ok(v.reason_call.includes(t), `${NAME[c]}: own "${t}" is there`);
    assert.ok(terms(v).some(t => tokens(c).some(x => t.includes(x))), `${NAME[c]}: own keyterms ${terms(v)}`);
    for (const o of [A, B, C].filter(o => o !== c)) {
      for (const t of tokens(o)) {
        assert.equal(v.reason_call.includes(t), false, `${NAME[c]}'s instructions never have ${NAME[o]}'s "${t}"`);
        assert.equal(v.greeting.includes(t), false);
        assert.equal(terms(v).some(k => k.includes(t)), false);
      }
    }
  }
});

test("classic for everyone: the shared rule words are the same text for all three, only the name differs", () => {
  const head = (c) => cartesia.sessionVariables(ownIn(c)).reason_call.split("\nPRE-CALL BRIEF")[0].replaceAll(NAME[c], "NAME");
  assert.equal(head(B), head(A));
  assert.equal(head(C), head(A));
  // The words themselves hold nobody's things: none of the three people's names, places or notes.
  const shared = [classic.classicVoiceWords({ name: "them", named: false, identity: true, carry: true }), classic.classicCallLines(), classic.MEMORY_LINE].join("\n");
  for (const c of [A, B, C]) for (const t of tokens(c)) assert.equal(shared.includes(t), false, `shared words hold "${t}"`);
  // The line's manner lines follow everyone's brief, the same.
  for (const c of [A, B, C]) assert.ok(cartesia.sessionVariables(ownIn(c)).reason_call.includes(classic.classicCallLines()));
});

test("classic for everyone: \"now\" is the caller's own time; the passphrase line is the operator's alone (call trust owner)", () => {
  const pass = calltrust.voiceLines(ownIn(A));
  assert.ok(pass.length > 0);
  for (const c of [A, B, C]) {
    const call = ownIn(c);
    const v = cartesia.sessionVariables(call);
    const when = new Intl.DateTimeFormat("en-US", { timeZone: ZONE[c], weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(T0));
    assert.ok(v.reason_call.includes(`Right now, where they are: ${when}.`), `${NAME[c]}: their own time (${when})`);
    assert.equal(v.reason_call.includes(pass), c === A, `${NAME[c]}: passphrase line ${c === A ? "there" : "absent"}`);
    assert.equal(calltrust.trustOn(call), c === A);
    assert.deepEqual(cartesia.reasonCallReport(call).kept.map(k => k.split(":")[0]).includes("passphrase"), c === A);
  }
});

test("free tier: someone on the monthly free tier is on Cartesia like everyone (no 5-minute cut, owner 2026-11-15); paying, free for good and the operator are on Cartesia", () => {
  Object.assign(process.env, { REASON_PAYWALL: "on", REASON_FREE_TIER: "monthly" });
  // B came in on their own after the paywall went on, with no plan row: the monthly free tier. C is free
  // for good. A is the operator.
  db.db.prepare("UPDATE accounts SET created_at = ? WHERE conversation_id = ?").run(plan.shipTs() + 1000, B);
  assert.equal(plan.onFreeTier(B), true, "B is on the monthly free tier");
  assert.equal(plan.FREE_CALL_SECONDS, null, "no cut is set");
  assert.equal(plan.callLimitSeconds(B), null);
  db.db.prepare("INSERT INTO plan (conversation_id, status, first_seen_at, updated_at) VALUES (?, 'free', ?, ?)").run(C, T0 - 86_400_000, T0);
  assert.equal(trial.cartesiaTrialFor(ownIn(B)), true, "free tier: Cartesia (the Gemma voice)");
  assert.equal(trial.cartesiaTrialFor(ownIn(C)), true, "free for good: Cartesia");
  assert.equal(trial.cartesiaTrialFor(ownIn(A)), true, "operator: Cartesia");
  db.db.prepare("INSERT INTO plan (conversation_id, status, first_seen_at, updated_at) VALUES (?, 'paid', ?, ?)").run(B, T0 - 86_400_000, T0);
  assert.equal(trial.cartesiaTrialFor(ownIn(B)), true, "paying: Cartesia");
  // At owner, nothing about the free tier changes who gets it (the operator's own choice only).
  Object.assign(config, { callCartesia: "owner" });
  assert.equal(trial.cartesiaTrialFor(ownIn(B)), false);
});

test("a Cartesia call has the platform ceiling, as a GPT-Live call does: ended at callPlatformCapSeconds, its copy deleted", async () => {
  let t = 1_000_000; let q = []; let n = 0;
  const timers = { setTimeout: (fn, ms) => { const id = ++n; q.push({ id, at: t + ms, fn }); return id; }, clearTimeout: (id) => { q = q.filter(x => x.id !== id); } };
  const advance = async (ms) => { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const x = q[0]; if (!x || x.at > end) break; q.shift(); t = x.at; x.fn(); await new Promise(r => setImmediate(r)); } t = end; };
  const h = { open: [], event: [], close: [] };
  const sent = [];
  const agent = { send: (o) => sent.push(o), close: () => {}, on: (k, f) => h[k].push(f) };
  const tw = { msg: [], close: [], isOpen: true };
  const twilio = { send: () => {}, open: () => tw.isOpen, close: () => { tw.isOpen = false; }, onMessage: (f) => tw.msg.push(f), onClose: (f) => tw.close.push(f) };
  const finished = []; const deleted = [];
  const call = new cartesia.CartesiaAgentCall({
    call: ownIn(B), twilio, openAgent: () => agent, now: () => t, timers, log: () => {}, brain: async () => ({ text: "", tools: [] }),
    finish: async (live) => { finished.push(live); }, deleteCall: async (id) => { deleted.push(id); return { ok: true, redacted: true, status: 200 }; },
  });
  call.begin();
  h.open.forEach(f => f());
  h.event.forEach(f => f({ type: "session_ready", call_id: "ac_cap" }));
  await advance(config.callPlatformCapSeconds * 1000 - 1000);
  assert.equal(finished.length, 0, "still going a second before the ceiling");
  await advance(2000);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].termination, "duration_cap");
  assert.deepEqual(deleted, ["ac_cap"]);
  assert.equal(q.length, 0, "no timer left behind");
});
