#!/usr/bin/env node
// Drive a scheduled call end to end, in process: the real timer_set tool, the real Runtime's timer
// sweep, the real call_place path, the fake call provider (dials nothing, records what it was asked
// to say) and the fake texting channel (records what was texted). A throwaway database. No model,
// no phone, nothing can leave this machine. Run under the cage's env:
//
//   cd ~/Desktop/pa && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/timer-call.db node .agents/skills/verify-reason/bin/timer-call-drive.mjs
//
// One line per step, `ok` or `FAIL`; exits non-zero on any FAIL.
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER ||= "+12025550100";
process.env.REASON_MASTER_NUMBER ||= process.env.REASON_OWNER_NUMBER;
process.env.REASON_OWNER_NAME ||= "Omari";
process.env.REASON_TZ ||= "America/New_York";
process.env.REASON_MAX_CALLS_PER_DAY = "2";
process.env.REASON_UNDO_SECONDS = "0";
{
  const { resolve, dirname } = await import("node:path");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = process.env.REASON_DB_PATH ? resolve(process.env.REASON_DB_PATH) : "";
  const parent = db && existsSync(dirname(db)) ? realpathSync(dirname(db)) + "/" : "";
  const roots = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", realpathSync(tmpdir()) + "/"];
  if (!db || existsSync(db) || !parent || !roots.some(r => parent.startsWith(r))) {
    console.error("refusing: set REASON_DB_PATH to a new file in a temp directory, e.g. $(mktemp -d)/timer-call.db");
    process.exit(2);
  }
  process.env.REASON_DATA_DIR ||= dirname(db) + "/data";
  process.env.REASON_RECORDING_ROOT ||= dirname(db) + "/recordings";
}
for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "BLAND_API_KEY", "AGENTCARD_CLIENT_SECRET"]) {
  if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
}

const root = new URL("../../../../", import.meta.url);
const imp = (p) => import(new URL(p, root));
const { Router } = await imp("src/channels/router.js");
const { Runtime } = await imp("src/runtime.js");
const { FakeChannel } = await imp("src/channels/fake.js");
const { ConsoleChannel } = await imp("src/channels/console.js");
const { FakeCallProvider } = await imp("src/calls/fake.js");
const { makeDeliver } = await imp("src/deliver.js");
const { runTool, callLostAfterMs } = await imp("src/tools.js");
const db = await imp("src/db.js");
const accounts = await imp("src/accounts.js");
const { clock } = await imp("src/config.js");

const OWNER = process.env.REASON_OWNER_NUMBER;
const CONV = "dm:owner";
const MIN = 60_000;
let failed = 0;
const step = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
db.upsertThread({ conversationId: CONV, channel: "fake", address: OWNER, isOwner: true, service: "iMessage" });
db.markToldCallsRecorded(CONV);

// Call 1 is answered; nobody answers call 2; call 3 cannot be placed at all. (The cap step places none.)
const calls = new FakeCallProvider({ script: [null, { state: "no_answer", outcome: "no answer", transcript: "", durationS: 0, recording: null }, { placeFails: "the provider is out of credit" }] });
const turns = [];
const logs = [];
const router = new Router({ log: (e) => logs.push(e) });
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: (e) => logs.push(e), warn: () => {} });
const runtime = new Runtime({ log: (e) => logs.push(e), runTurn: async (call) => { turns.push(call); return "time to get up"; }, channels: router, calls, deliver });
router.runtime = runtime;
router.register(consoleChannel);
const fake = router.register(new FakeChannel({ number: "+15122164639" }));
const iso = (ms) => new Date(ms).toISOString();
const ctx = { conversationId: CONV, calls };

// 1. "call me in 10 minutes to make sure i've left"
const GOAL = "you asked me to call so you actually leave";
const set = await runTool("timer_set", { fire_at: iso(clock.now() + 10 * MIN), note: "leave nudge", then_call: GOAL }, ctx);
step("timer_set with then_call makes a call timer", set.ok === true && set.timer?.calls_them === GOAL, JSON.stringify(set).slice(0, 160));
step("timer_list shows which one rings", (await runTool("timer_list", {}, ctx)).timers[0]?.calls_them === GOAL);
step("nothing rings early", (await runtime.tick()) === 0 && calls.placed.length === 0);
clock.skip(10 * MIN + 1000);
step("firing places the call, no model turn, no text", (await runtime.tick()) === 1 && calls.placed.length === 1 && turns.length === 0 && fake.sent.length === 0);
step("rings their own number with the goal", calls.placed[0]?.to === OWNER && calls.placed[0]?.goal === GOAL);
step("first words say why", calls.placed[0]?.announcement === `hey Omari — ${GOAL}.`, calls.placed[0]?.announcement);
step("call row points at the timer", db.listCalls(CONV)[0]?.timer_id === set.timer.id);
step("fired exactly once", (await runtime.tick()) === 0 && calls.placed.length === 1);

// 2. "remind me in 5 minutes" stays a text
const text = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "remind them to leave" }, ctx);
clock.skip(5 * MIN + 1000);
await runtime.tick();
step("a plain reminder is a text, not a call", text.ok && turns.length === 1 && fake.sent.length === 1 && calls.placed.length === 1, fake.sent[0]?.text);

// 3. "never mind the call"
const nm = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: "wake you" }, ctx);
const cancelled = await runTool("timer_cancel", { timer_id: nm.timer.id }, ctx);
clock.skip(5 * MIN + 1000);
step("never mind the call: cancelled, nothing rings", cancelled.ok && (await runtime.tick()) === 0 && calls.placed.length === 1);

// 4. nobody picks up → one text when the call settles
const na = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: "you asked me to wake you at 6:30" }, ctx);
clock.skip(5 * MIN + 1000);
await runtime.tick();
step("second call placed (the one nobody answers)", calls.placed.length === 2 && fake.sent.length === 1);
clock.skip(callLostAfterMs() + 1000);
const settled = await runtime.lostCalls();
await runtime.outbox();
const missed = fake.sent.at(-1);
// Both outbound calls are still "placing" to the sweep (nothing settled the answered one either), so two settle; only the unanswered one texts.
step("no answer → one text saying it tried", settled.settled === 2 && fake.sent.length === 2 && /tried calling u/.test(missed?.text ?? "") && /didn't pick up/.test(missed?.text ?? ""), missed?.text);
await runtime.lostCalls(); await runtime.outbox();
step("and never a second", fake.sent.length === 2);
step("that was timer-keyed", !!db.db.prepare("SELECT id FROM outbox WHERE idem_key = ?").get(`timer:${na.timer.id}:call_missed`));

// 5. the day's call cap → a text, not silence (two calls placed today; cap is 2)
const capped = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: "you asked for a 7am call" }, ctx);
clock.skip(5 * MIN + 1000);
await runtime.tick();
step("call cap reached → a text, no call, in their words", accounts.withinCap(CONV, "call").ok === false && calls.placed.length === 2 && fake.sent.length === 3 && /call limit is used up/.test(fake.sent.at(-1).text) && !/REASON_|Omari|Say that/.test(fake.sent.at(-1).text), fake.sent.at(-1)?.text);
step("timer finished with", !!db.getTimer(CONV, capped.timer.id).fired_at);

// 6. provider fails to place → a text naming why (new day so the cap is clear)
db.db.exec("DELETE FROM usage");
const pf = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: "you asked for a call before the flight" }, ctx);
clock.skip(5 * MIN + 1000);
await runtime.tick();
step("provider failure → one honest text with the reason", calls.placed.length === 3 && fake.sent.length === 4 && /out of credit/.test(fake.sent.at(-1).text), fake.sent.at(-1)?.text);
step("failed attempt is on the record", db.listCalls(CONV).some(r => r.timer_id === pf.timer.id && r.state === "failed"));

// 7. a standing series of calls
const series = await runTool("timer_set", { note: "weekday wake-up", then_call: "you asked me to call every weekday at 7", repeat: { kind: "weekdays", hour: 7, their_time: true } }, ctx);
step("call me every weekday at 7 → a series whose firings ring", series.ok && series.series?.calls_them && db.getTimer(CONV, series.timer_id)?.call_goal === "you asked me to call every weekday at 7", series.say_back);

// 8. no provider → refused at set time
const off = await runTool("timer_set", { fire_at: iso(clock.now() + 5 * MIN), note: "wake-up", then_call: "x" }, { conversationId: CONV, calls: new FakeCallProvider({ live: false }) });
step("no phone line → refused when asked, text offered", off.ok === false && off.status === "not_connected" && /offer a text/.test(off.error));

console.log(failed ? `\n${failed} FAIL` : "\nall ok");
process.exit(failed ? 1 : 0);
