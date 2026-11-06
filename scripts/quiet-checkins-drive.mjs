// A real-model drive of the repeating-check fixes (quiet unless new, chains capped, stop means
// stopped, never late), on a scratch database, through the same Runtime, router, outbox and deliver
// the server runs.
//
//   Real model (claude CLI subscription, never the API key):
//     env -i HOME=$HOME PATH=$PATH USER=$USER LOGNAME=$LOGNAME TMPDIR=$TMPDIR REASON_BACKEND=claude-cli \
//       node --import ./test/paid-key-guard.js scripts/quiet-checkins-drive.mjs
//   Scripted model (no model at all; replays the choices the live model made in the incident —
//   "no new setup this hour" without being asked, a timer set from each firing, resuming on START):
//     env -i HOME=$HOME PATH=$PATH TMPDIR=$TMPDIR DRIVE_MODEL=scripted node scripts/quiet-checkins-drive.mjs
//
// Runs the same script on main and on the branch, so it only uses what exists on both: on main,
// `chainedFrom` is ignored and the "chain" is a plain timer, which is exactly what the model's
// self-set timers were there. Prints a transcript. Fake numbers only; nothing leaves the machine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTED = process.env.DRIVE_MODEL === "scripted";
if (!SCRIPTED && process.env.REASON_BACKEND !== "claude-cli") throw new Error("REASON_BACKEND=claude-cli (or DRIVE_MODEL=scripted) only: this drive never runs on the API key");
delete process.env.ANTHROPIC_API_KEY;
const dir = mkdtempSync(join(tmpdir(), "reason-quiet-drive-"));
Object.assign(process.env, {
  REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: dir,
  REASON_PROFILE_ROOT: join(dir, "profiles"), REASON_SHOT_ROOT: join(dir, "shots"),
  REASON_OWNER_NAME: "Owner", REASON_TZ: "America/New_York",
  REASON_CONVERSATION: "dm:owner", REASON_OWNER_NUMBER: "+15550100000", REASON_MASTER_NUMBER: "+15550100000",
  REASON_PUBLIC_URL: "https://reason.example.test", REASON_MAX_SERIES: "3", REASON_AUTO_ADMIT: "1",
});

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const { ConsoleChannel } = await import("../src/channels/console.js");
const { makeDeliver } = await import("../src/deliver.js");
const db = await import("../src/db.js");
const series = await import("../src/series.js");
const { clock, stamp } = await import("../src/config.js");

const ADDR = "+15550101111";
const C = `dm:${ADDR}`;
const HOUR = 3600_000;
const MIN = 60_000;
const out = [];
const line = (s) => { out.push(s); console.log(s); };

const logs = [];
const router = new Router({ log: (e) => logs.push(e) });
const consoleChannel = new ConsoleChannel({ write: () => {} });
const deliver = makeDeliver({ router, consoleChannel, log: () => {}, warn: () => {} });
const { runTool } = await import("../src/tools.js");

/**
 * The scripted model: what the live model did in the incident, as tool calls and replies. It never
 * writes the send mark on a flat hour — the point is that code, not the model's compliance, decides.
 */
async function scriptedTurn(call) {
  const t = String(call.text ?? "");
  const tool = async (name, input) => {
    const out = await runTool(name, input, { ...call });
    logs.push({ tool: name, input, out });
    return out;
  };
  if (call.kind === "event") {
    if (/Set the next (ETH )?scan/i.test(t)) await tool("timer_set", { fire_at: new Date(clock.now() + HOUR).toISOString(), note: "hourly setup scan (next)" });
    const quietRule = /QUIET UNLESS NEW/.test(t);
    if (/broke the 71,000/.test(t)) return `${quietRule ? "[send] " : ""}BTC just broke 71k on 2.4x volume, first close above it this month. long setup above 71.2k, stop under 70.6k`;
    if (/move the car/.test(t)) return "move the car! street cleaning at 11";
    if (/ETH/.test(t)) return "no new ETH setup this hour, still inside 3,380-3,440";
    if (/hourly|scan/i.test(t)) return "no new setup this hour. BTC 70.1k and gold 2,391 both still inside range";
    return "NO_REPLY";
  }
  if (/^stop/i.test(t.trim())) { await tool("pause_everything", { said: t }); return "done, everything's paused. tell me when you want it back"; }
  if (/^start/i.test(t.trim())) {
    const r = await tool("resume_everything", {});
    let back = (r.restored ?? []).length;
    if (!r.ok) {
      // Not paused (the carrier STOP paused the check-ins, not Reason): bring back what is listed.
      const list = await tool("series_list", {});
      for (const s of list.series ?? []) if (s.state === "paused" && (await tool("series_resume", { series_id: s.series_id })).ok) back++;
    }
    // Says what the tools said, as the real model is told to.
    return back ? "you're back on. scans running again" : "you're back on, texts are coming through again. the scans are still off, want any of them back?";
  }
  return "ok";
}

const rt = new Runtime({
  log: (e) => { logs.push(e); if (process.env.DRIVE_DEBUG) console.error(JSON.stringify(e).slice(0, 300)); },
  channels: router, deliver,
  ...(SCRIPTED ? { runTurn: scriptedTurn, screen: async () => ({ verdict: "clear" }), screenReply: async () => ({ verdict: "clear" }) } : {}),
});
rt.on("error", (e) => line(`      error: ${String(e?.message ?? e).slice(0, 200)}`));
router.runtime = rt;
router.register(consoleChannel);
const fake = router.register(new FakeChannel({ number: "+15550109999" }));
const toThem = () => fake.sent.filter(m => m.to === ADDR);

function reset(label) {
  db.db.exec("DELETE FROM series; DELETE FROM timers; DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads;"
    + " DELETE FROM conversations; DELETE FROM inbound_messages; DELETE FROM action_ledger; DELETE FROM ops_state;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: ADDR, name: "Test Person", isOperator: false });
  db.upsertThread({ conversationId: C, channel: "fake", address: ADDR, isOwner: true, service: "iMessage" });
  line(`\n=== ${label} ===`);
}
function newTexts(before) {
  const got = toThem().slice(before);
  if (!got.length) line(`  [${stamp()}] Reason → them: (nothing sent)`);
  for (const m of got) line(`  [${stamp()}] Reason → them: ${m.text}`);
}
async function says(text) {
  const handle = `in-${clock.now()}-${Math.random()}`;
  db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
  db.upsertThread({ conversationId: C, channel: "fake", address: ADDR, isOwner: true, service: "iMessage", lastInboundId: handle });
  line(`  [${stamp()}] them: ${text}`);
  const before = toThem().length;
  const from = logs.length;
  await rt.inbound(C, text, { channel: "fake", to: ADDR, fromOwner: true });
  newTexts(before);
  const used = logs.slice(from).filter(l => l.tool).map(l => `${l.tool}${l.out?.ok === false ? ` → refused: ${String(l.out.error ?? "").slice(0, 110)}` : ""}`);
  if (used.length) line(`      tools: ${used.join("; ")}`);
  noteLogs(from);
}
async function tick(what, { sweep = false } = {}) {
  line(`  [${stamp()}] (${what})`);
  const before = toThem().length;
  const toolsBefore = logs.length;
  // The server's sweep makes series firings and fires due timers; a bare tick only fires timers.
  if (sweep) await rt.sweep();
  await rt.tick();
  newTexts(before);
  const used = logs.slice(toolsBefore).filter(l => l.tool).map(l => `${l.tool}${l.out?.ok === false ? ` → refused: ${String(l.out.error ?? "").slice(0, 110)}` : ""}`);
  if (used.length) line(`      tools: ${used.join("; ")}`);
  noteLogs(toolsBefore);
}
/** What code decided along the way (held back, skipped, failed), without the words of any reply. */
function noteLogs(from) {
  const keys = ["quiet_nothing_new", "silent_reply", "held_back", "skipped_late_min", "failed", "gave_up", "unreachable", "backend_down", "timer_held", "error"];
  for (const l of logs.slice(from)) {
    if (!l || typeof l !== "object") continue;
    const k = keys.find(k => k in l);
    if (k) line(`      code: ${JSON.stringify(l).slice(0, 220)}`);
  }
}
const setClock = (iso) => { clock.reset(); clock.skip(Date.parse(iso) - clock.now()); };
line(SCRIPTED ? "model: scripted (replays the live model's choices; no model call)" : `model: ${process.env.REASON_CLI_MODEL || "opus"} via the claude CLI turn path`);
const DATA_FLAT = "This hour's numbers from your feed: BTC 70,120 (range 69,800–70,300, no breakout, volume average); gold 2,391 (inside yesterday's range). Nothing crossed a level they care about.";
const DATA_BREAK = "This hour's numbers from your feed: BTC 72,450 — broke the 71,000 resistance on 2.4x average volume, first close above it this month; gold 2,392 flat.";

// ---------- A. an hourly scan with nothing new ----------
setClock("2026-11-04T15:05:00Z");
reset("A. hourly scan, nothing new this hour");
const root = db.createTimer(C, { fireAt: clock.now() - HOUR, note: "hourly BTC + gold setup scan" });
db.markTimerFired(root.id);
db.createTimer(C, { fireAt: clock.now() - MIN, note: `hourly BTC + gold setup scan they asked for ("scan every hour, text me when there's a setup"). ${DATA_FLAT} Set the next scan for an hour from now.`, chainedFrom: root.id });
await tick("the 10am scan fires");
const links = db.listTimers(C);
line(`      next scan armed: ${links.length ? links.map(t => `#${t.id} ${stamp(t.fire_at)}${t.chained_from != null ? " (chain link, counted)" : ""}`).join(", ") : "none"}`);

// ---------- A2. the next one finds something ----------
reset("A2. hourly scan, a real setup");
const root2 = db.createTimer(C, { fireAt: clock.now() - HOUR, note: "hourly BTC + gold setup scan" });
db.markTimerFired(root2.id);
db.createTimer(C, { fireAt: clock.now() - MIN, note: `hourly BTC + gold setup scan they asked for ("scan every hour, text me when there's a setup"). ${DATA_BREAK}`, chainedFrom: root2.id });
await tick("the 11am scan fires");

// ---------- B. the cap: three things running, a firing tries to start one more ----------
reset("B. at the cap (3), a firing sets itself up to repeat");
for (const [what, hour] of [["morning market brief", 8], ["gold levels check", 12], ["evening wrap", 18]]) {
  series.start({ conversationId: C, what, repeat: { kind: "daily", hour, their_time: true } });
}
db.createTimer(C, { fireAt: clock.now() - MIN, note: `they asked for an ETH scan every hour from now on ("keep scanning eth hourly, only text me on a setup"). ${DATA_FLAT.replace("BTC", "ETH").replace("70,120", "3,410").replace("69,800–70,300", "3,380–3,440")} Set the next ETH scan for an hour from now, and keep doing that each hour.` });
await tick("an ETH scan fires and tries to set the next one");
line(`      repeating things now: ${db.listSeries(C).length} series + ${db.listTimers(C).filter(t => !t.series_id).length} self-set timer(s)`);

// ---------- C. STOP (the carrier opt-out), then START ----------
reset("C. carrier opt-out, then they opt back in");
series.start({ conversationId: C, what: "BTC setup scan", repeat: { kind: "daily", hour: 11, their_time: true } });
const r3 = db.createTimer(C, { fireAt: clock.now() - HOUR, note: "hourly scan" });
db.markTimerFired(r3.id);
db.createTimer(C, { fireAt: clock.now() + 55 * MIN, note: "hourly BTC setup scan; set the next one an hour on", chainedFrom: r3.id });
const failed = db.enqueueOutbound({ idemKey: `optout-${Math.random()}`, conversationId: C, channel: "fake", address: ADDR, body: "earlier scan text", toOwner: true });
db.markOutboundFailed(failed.row.id, { error: "they've opted out of messages from this number", errorKey: "OPTED_OUT" });
line(`  [${stamp()}] them: STOP   (carrier opt-out; the last text to them failed OPTED_OUT)`);
clock.skip(HOUR);
await tick("the 11am scan comes due while they are opted out");
clock.skip(3 * HOUR);
await says("Start");
line(`      after START: series ${db.listSeries(C, { includeEnded: true }).map(s => s.state).join(",") || "none"}; pending timers ${db.listTimers(C).map(t => `#${t.id} ${stamp(t.fire_at)}`).join(", ") || "none"}`);
clock.skip(21 * HOUR);
await tick("next day at 11, the sweep runs", { sweep: true });

// ---------- C2. "stop" in words, then "start" ----------
reset("C2. they text stop everything, later start");
const t0 = clock.now();
const dueNextDay = series.partsIn(t0 + 25 * HOUR, "America/New_York");
series.start({ conversationId: C, what: "BTC setup scan", repeat: { kind: "daily", hour: dueNextDay.hour, their_time: true } });
const r4 = db.createTimer(C, { fireAt: clock.now() - HOUR, note: "hourly scan" });
db.markTimerFired(r4.id);
db.createTimer(C, { fireAt: clock.now() + 55 * MIN, note: "hourly BTC setup scan; set the next one an hour on", chainedFrom: r4.id });
await says("stop all the scans and alerts");
clock.skip(3 * HOUR);
await says("start");
line(`      after start: series ${db.listSeries(C, { includeEnded: true }).map(s => s.state).join(",") || "none"}; pending timers ${db.listTimers(C).map(t => `#${t.id} ${stamp(t.fire_at)}`).join(", ") || "none"}`);
clock.skip(series.atLocal({ ...dueNextDay, minute: 5 }, "America/New_York") - clock.now());
await tick("next day, 5 minutes after the scan's hour, the sweep runs", { sweep: true });

// ---------- D. a reminder whose time passed long ago ----------
reset("D. a reminder held 20 hours past its time");
const late = db.createTimer(C, { fireAt: clock.now() + 10 * MIN, note: "remind them to move the car before street cleaning at 11" });
clock.skip(20 * HOUR + 10 * MIN);
line(`      reminder #${late.id} was set for ${stamp(late.fire_at)}`);
await tick("the timer sweep finally reaches it");

line(`\n(${toThem().length} texts to them in all)`);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
