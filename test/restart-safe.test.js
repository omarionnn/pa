// A restart costs a wait, never a reply.
//
// The failure, from the live journal on 2026-10-17 at 15:00:20 UTC: `systemctl restart reason`
// logged "Stopping reason.service", the app logged "SIGTERM — finishing what's in flight…", and one
// second later the turn that was running died with `{"cli_failed":"the CLI returned no JSON (exit
// 143)"}`. Omari got "ugh — that one broke on my end partway through" for a message that was not
// broken at all, and the `requests` row for his text was left `status=dropped`. 143 is 128+15: the
// `claude` CLI had been sent the same SIGTERM the server was, because systemd's default
// `KillMode=control-group` signals every process in the unit's cgroup.
//
// Losing the reply is the part that matters. `Router.drain` takes a conversation's held messages by
// DELETING them (that delete is the lock that makes two overlapping drains one turn), so a turn
// that dies after the take has nothing left behind for the sweep to find. The messages were not
// waiting anywhere — they were gone.
//
// So: a turn that dies while the process is stopping is unfinished, not failed. The messages go
// back exactly as they came, the request rows that turn opened are dropped, nothing is said, and
// the next process's sweep answers them.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-restart-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const QUIET = 2_500;
const CAP = 8_000;

// The clock these tests read. Nothing here asserts on a difference between two readings, so it
// stays on real time plus whatever has been skipped — see test/burst.test.js for why a test that
// owns the router's timers has to own the clock too.
let skippedMs = 0;
clock.now = () => Date.now() + skippedMs;
clock.skip = (ms) => { skippedMs += ms; };
clock.reset = () => { skippedMs = 0; };

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM pending_inbound; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM requests;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.burstQuietMs = QUIET;
  config.burstMaxMs = CAP;
});

/**
 * A router and runtime whose turn does whatever the test says. `turn` is called with the same
 * argument the real `runTurn` gets, so a test can throw the error a signalled CLI really produces.
 */
function harness({ turn = null } = {}) {
  const turns = [];
  const logs = [];
  const runtime = new Runtime({
    log: (e) => logs.push(e),
    runTurn: async (arg) => {
      turns.push({ kind: arg.kind, text: arg.text });
      if (turn) return await turn(arg);
      return "ok";
    },
  });
  const router = new Router({ runtime, log: (e) => logs.push(e) });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;
  runtime.on("outbound", async ({ to, text, chatId }) => { await fake.send({ to, text, chatId }); });
  return { runtime, router, fake, turns, logs };
}

/** The error a turn dies of when the CLI it was riding on got the restart's SIGTERM. */
const signalled = () => {
  const e = new Error("the CLI was stopped by SIGTERM before it finished");
  e.interrupted = true;
  return e;
};

/** Everything that actually went out to a person. */
const outbound = (fake) => fake.sent.map(s => s.text ?? "").join("\n");
const BROKE = /broke on my end/;

/** One message held and due, as if it had waited out its window. */
const hold = (text, externalId) => db.holdInbound({
  conversationId: "dm:owner", channel: "fake", address: OWNER, externalId,
  text, quietMs: 0, maxMs: CAP, isOperator: true,
});

// ---------- the turn that was in flight when the process was told to stop ----------

test("a turn killed by the restart puts its messages back, says nothing, and the next sweep answers them", async () => {
  hold("can you find me a flight to accra", "e-1");

  // The process is told to stop. serve.js sets this before it awaits anything, and the CLI dies of
  // the same SIGTERM a moment later — which is the error the turn throws.
  const dying = harness({ turn: () => { throw signalled(); } });
  dying.runtime.stopping = true;
  const r = await dying.router.drain("dm:owner");
  await dying.router.idle();

  assert.equal(r.interrupted, true, "the drain says it did not finish");
  assert.equal(r.replied, false);
  assert.equal(outbound(dying.fake), "", "nothing at all is said to them");
  assert.doesNotMatch(outbound(dying.fake), BROKE, "and specifically not that it broke");
  assert.equal(db.countPendingInbound("dm:owner"), 1, "the message is back on the pile, not gone");
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE conversation_id = ? AND status = 'open'").get("dm:owner").n,
    0, "and the request row that turn opened is not left open",
  );

  // Nothing of that process is used again: a new one, as `npm run serve` would build on restart.
  const fresh = harness();
  const swept = await fresh.runtime.sweep();

  assert.equal(swept.held.turns, 1, "the next sweep answers it");
  const answered = fresh.turns.filter(t => t.kind === "user");
  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /can you find me a flight to accra/);
  assert.equal(db.countPendingInbound("dm:owner"), 0, "and it is not answered twice");
});

test("a burst goes back whole and in order, under one turn, not one turn each", async () => {
  hold("you around", "e-1");
  clock.skip(1_000);
  hold("need a favour", "e-2");
  assert.equal(db.countPendingInbound("dm:owner"), 2);

  const dying = harness({ turn: () => { throw signalled(); } });
  dying.runtime.stopping = true;
  await dying.router.drain("dm:owner");
  await dying.router.idle();

  assert.equal(db.countPendingInbound("dm:owner"), 2, "both are back");

  const fresh = harness();
  await fresh.runtime.sweep();
  const answered = fresh.turns.filter(t => t.kind === "user");
  assert.equal(answered.length, 1, "one turn for both, the way the burst was one thought");
  const body = answered[0].text;
  assert.ok(
    body.indexOf("you around") < body.indexOf("need a favour"),
    "in the order he sent them",
  );
});

test("the messages go back due, so the restart does not charge them a second quiet window", async () => {
  hold("still there?", "e-1");
  const dying = harness({ turn: () => { throw signalled(); } });
  dying.runtime.stopping = true;
  await dying.router.drain("dm:owner");
  await dying.router.idle();

  assert.deepEqual(db.dueConversations(clock.now()), ["dm:owner"], "due now, not in another window");
});

// ---------- what must NOT change ----------

test("a turn that really broke still says so, because nothing is stopping", async () => {
  hold("what's the weather", "e-1");
  const { router, fake, runtime } = harness({ turn: () => { throw new Error("the model returned nothing"); } });
  assert.equal(runtime.stopping, false);

  const r = await router.drain("dm:owner");

  assert.notEqual(r.interrupted, true);
  assert.match(outbound(fake), BROKE, "an ordinary failure is still owned out loud");
  assert.equal(db.countPendingInbound("dm:owner"), 0, "and is not put back to be run again");
});

test("stopping alone is enough: a backend that cannot prove it was signalled is still unfinished", async () => {
  hold("book it", "e-1");
  // An HTTP backend abandoned mid-request throws something ordinary — there is no exit code to
  // read. The shutdown flag is what makes it unfinished rather than broken.
  const dying = harness({ turn: () => { throw new Error("socket hang up"); } });
  dying.runtime.stopping = true;

  const r = await dying.router.drain("dm:owner");
  await dying.router.idle();

  assert.equal(r.interrupted, true);
  assert.equal(outbound(dying.fake), "");
  assert.equal(db.countPendingInbound("dm:owner"), 1);
});

test("a turn that finished is untouched by any of this", async () => {
  hold("morning", "e-1");
  const { router, turns } = harness();
  const r = await router.drain("dm:owner");

  assert.equal(r.replied, true);
  assert.notEqual(r.interrupted, true);
  assert.equal(turns.length, 1);
  assert.equal(db.countPendingInbound("dm:owner"), 0);
});

// ---------- the exit code the whole chain rests on ----------
//
// Everything above believes the backend can tell "stopped" from "broken". These spawn a real
// process and kill it for real, because the claim is about what a dying child actually reports and
// a mock would only prove that the mock was written to agree.

const { runClaudeCli, cliConfig } = await import("../src/backends/cli.js");

/** A stand-in for the `claude` binary that does exactly one thing and exits. */
function fakeCli(name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

test("exit 143 is read as stopped, not as a turn that returned nothing", async () => {
  // What the real CLI did in the journal: it handled the SIGTERM itself and exited 128+15, so Node
  // sees a code and no signal. Before this it fell through to "the CLI returned no JSON (exit 143)"
  // and the person was told their message broke.
  const saved = cliConfig.bin;
  cliConfig.bin = fakeCli("cli-143.sh", "exit 143");
  try {
    const r = await runClaudeCli({ prompt: "hi", system: "s" });
    assert.equal(r.ok, false);
    assert.equal(r.interrupted, true);
    assert.match(r.error, /stopped by SIGTERM/);
  } finally { cliConfig.bin = saved; }
});

test("a child that did not handle the signal is read as stopped too", async () => {
  // The other shape: killed outright, so Node reports signal 'SIGTERM' and a null code.
  const saved = cliConfig.bin;
  cliConfig.bin = fakeCli("cli-kill.sh", "kill -TERM $$");
  try {
    const r = await runClaudeCli({ prompt: "hi", system: "s" });
    assert.equal(r.ok, false);
    assert.equal(r.interrupted, true);
    assert.match(r.error, /stopped by SIGTERM/);
  } finally { cliConfig.bin = saved; }
});

test("an ordinary non-zero exit is still a failure, not something to retry", async () => {
  const saved = cliConfig.bin;
  cliConfig.bin = fakeCli("cli-1.sh", "echo 'something went wrong' >&2; exit 1");
  try {
    const r = await runClaudeCli({ prompt: "hi", system: "s" });
    assert.equal(r.ok, false);
    assert.notEqual(r.interrupted, true, "nothing is put back for this one");
    assert.match(r.error, /returned no JSON \(exit 1\)/);
  } finally { cliConfig.bin = saved; }
});

// ---------- the restart gate sees a reply being written ----------
//
// 2026-11-16 00:43:49 UTC: a text arrived, about 4 s later verify-reason/bin/idle.sh said IDLE, and the
// restart cut the turn writing the answer (turn_interrupted). It came back after the restart, a minute
// late. The gate now reads three things in the database, never the text: a held message due, a person's
// history row whose turn has not ended (turn_done_at), and a text received with no row yet. This runs
// the real gate script against this test's database while a real turn is in the middle of running.
const GATE = fileURLToPath(new URL("../.agents/skills/verify-reason/bin/idle.sh", import.meta.url));
const HAS_SQLITE = spawnSync("sqlite3", ["-version"]).status === 0;
function gate(env = {}) {
  // The server's systemctl (the running pid: this one, so busy.json, if any, is believed), its journal
  // (empty) and GNU date (milliseconds), so the script runs anywhere.
  const shim = join(dir, "gate-shim");
  mkdirSync(shim, { recursive: true });
  const put = (name, body) => { writeFileSync(join(shim, name), `#!/bin/bash\n${body}\n`); chmodSync(join(shim, name), 0o755); };
  put("systemctl", `echo ${process.pid}`);
  put("journalctl", "exit 0");
  put("date", `if [ "$1" = "+%s%3N" ]; then echo $(( $(${process.execPath} -e 'process.stdout.write(String(Date.now() + ${skippedMs}))') )); else exec /bin/date "$@"; fi`);
  const r = spawnSync("bash", [GATE], {
    env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, REASON_LIVE_SSH: "local", REASON_IDLE_DATA: dir, ...env },
    encoding: "utf8",
  });
  return r.stdout;
}

test("the restart gate waits while a reply is being written to a person, and not once it has gone", { skip: !HAS_SQLITE && "no sqlite3 CLI" }, async () => {
  const savedWeb = config.web;
  config.web = "owner"; // history rows on, as on live
  try {
    db.db.exec("DELETE FROM messages; DELETE FROM inbound_messages");
    assert.match(gate(), /^IDLE/m, "nothing going on");

    db.claimInbound({ channel: "fake", externalId: "g-1", conversationId: "dm:owner" });
    assert.match(gate(), /^BUSY:[\s\S]*received \d+s ago, being read/, "a text just received and not yet held or written down is waited for");

    hold("are you free at 6", "g-1");
    assert.match(gate(), /^BUSY:[\s\S]*1 held message\(s\) waiting for their turn/, "held for its turn: waited for");

    let during = "";
    const h = harness({ turn: async () => { during = gate(); return "yes, free at 6"; } });
    await h.router.drain("dm:owner");
    await h.router.idle();
    assert.match(during, /^BUSY:[\s\S]*turn running for 1 message\(s\)/, "the turn itself (the model, its tools) is waited for");
    assert.doesNotMatch(during, /are you free/, "and the gate never says what they wrote");

    assert.match(gate(), /^IDLE/m, "the reply has gone: nothing holds the restart");
    assert.match(gate({ REASON_IDLE_TURNS: "off" }), /^WARN reply check off/m, "the switch says it is off");

    // A row whose turn never ended (a process that died) stops counting after 10 minutes.
    db.claimInbound({ channel: "fake", externalId: "g-2", conversationId: "dm:owner" });
    db.writeMessage({ conversationId: "dm:owner", role: "user", channel: "fake", externalId: "g-2", text: "x", at: clock.now() });
    assert.match(gate(), /^BUSY:[\s\S]*turn running/);
    clock.skip(11 * 60_000);
    assert.match(gate(), /^IDLE/m, "stale after 10 minutes: it cannot hold a deploy for ever");
  } finally { config.web = savedWeb; }
});
