// The sign-in window, opened by Reason from a text instead of from a terminal. No browser is
// started here: the window is a stand-in process, which is all this code ever sees of it anyway.
//
//   asked to sign in, does Reason open the window or send you to a terminal?   (opens it)
//   does it claim you are signed in before the site has said so?               (no — it waits for the close)
//   can somebody who is not at the machine open a window on it?                (no)
//   does a forgotten window hold the saved profile forever?                    (no — closed, and said)
//   is the result guessed when the check did not run?                          (no — "nothing recorded")
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "reason-signin-window-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { runTool } = await import("../src/tools.js");
const win = await import("../src/signin-window.js");
const sites = await import("../src/sites.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";
const FRIEND = "+14155559876";
const CONV = "dm:owner";
const THEIRS = `dm:fake:${FRIEND}`;
const amazon = sites.site("amazon");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM timers; DELETE FROM accounts; DELETE FROM threads; DELETE FROM connected_accounts; DELETE FROM action_ledger;");
  db.upsertAccount({ conversationId: CONV, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

/** A window that is "open" until the test closes it. */
function fakeWindow() {
  const spawned = [];
  const booked = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = null;
    child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit("exit", null)); return true; };
    spawned.push({ bin, args, opts, child });
    return child;
  };
  const timers = { set: (fn, ms) => { const h = { fn, ms, cleared: false }; booked.push(h); return h; }, clear: (h) => { if (h) h.cleared = true; } };
  return { spawned, booked, spawnImpl, timers };
}
const tick = () => new Promise(r => setImmediate(r));
const notes = (c = CONV) => db.db.prepare("SELECT note, fire_at FROM timers WHERE conversation_id = ? ORDER BY id").all(c);

async function open(w, { conversationId = CONV, entry = amazon, closed = [] } = {}) {
  return await win.openSigninWindow({ conversationId, entry, spawnImpl: w.spawnImpl, timers: w.timers, closeBrowser: async (c) => { closed.push(c); } });
}

test("opening the window frees the saved profile first, then starts the same sign-in command", async () => {
  const w = fakeWindow();
  const closed = [];
  const out = await open(w, { closed });
  assert.equal(out.ok, true);
  assert.deepEqual(closed, [CONV], "Reason's own browser lets go of the profile before the window takes it");
  assert.equal(w.spawned.length, 1);
  assert.match(w.spawned[0].args[0], /signin-cli\.js$/);
  assert.equal(w.spawned[0].args[1], "amazon");
  assert.equal(w.spawned[0].opts.env, process.env, "with the server's own environment, so it writes to the same data folder");
  assert.deepEqual(win.openWindowFor(CONV).site, "amazon");
  assert.equal(notes().length, 0, "and nothing is said about the result while the window is still open");
  w.spawned[0].child.emit("exit", 0);
});

test("when the window closes and the site says signed in, that is what Reason is told", async () => {
  const w = fakeWindow();
  await open(w);
  clock.skip(90_000);
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "the order history page loaded" });
  w.spawned[0].child.emit("exit", 0);
  await tick();

  const [n] = notes();
  assert.match(n.note, /Amazon says they ARE signed in now \(the order history page loaded\)/);
  assert.ok(n.fire_at <= clock.now(), "due now, so the next sweep tells them");
  assert.equal(win.openWindowFor(CONV), null);
});

test("closing the window without signing in is reported as not signed in, never as done", async () => {
  const w = fakeWindow();
  await open(w);
  clock.skip(20_000);
  db.recordSiteSignin(CONV, "amazon", { state: "signed_out", evidence: "the account page redirected to sign-in" });
  w.spawned[0].child.emit("exit", 0);
  await tick();
  assert.match(notes()[0].note, /still NOT signed in \(signed_out: the account page redirected to sign-in\)/);
  assert.match(notes()[0].note, /offer to open the window again/);
});

test("a check that never ran is 'nothing recorded', not a guess from an older answer", async () => {
  const w = fakeWindow();
  // Signed in last week, by the look of the table.
  db.recordSiteSignin(CONV, "amazon", { state: "signed_in", evidence: "an old check" });
  clock.skip(3_600_000);
  await open(w);
  clock.skip(10_000);
  w.spawned[0].child.emit("exit", 1); // the window went away and the check after it did not happen
  await tick();
  assert.match(notes()[0].note, /did not run, so nothing is recorded either way/);
  assert.doesNotMatch(notes()[0].note, /ARE signed in/);
});

test("one window at a time", async () => {
  const w = fakeWindow();
  await open(w);
  const second = await open(w, { entry: sites.site("fandango") });
  assert.equal(second.ok, false);
  assert.equal(second.already_open, "amazon");
  assert.equal(w.spawned.length, 1);
  w.spawned[0].child.emit("exit", 0);
  await tick();
  assert.equal((await open(w, { entry: sites.site("fandango") })).ok, true, "and another can open once it has closed");
  w.spawned[1].child.emit("exit", 0);
});

test("a window nobody closes is closed after a while, and that is said", async () => {
  const w = fakeWindow();
  await open(w);
  assert.equal(w.booked[0].ms, config.signinWindowMaxMs);
  w.booked[0].fn(); // the time is up
  await tick(); await tick();
  assert.equal(w.spawned[0].child.killed, "SIGTERM");
  assert.match(notes()[0].note, /sat open for 15 minutes, so you closed it\. Nothing was checked or recorded/);
  assert.equal(win.openWindowFor(CONV), null, "and the profile is free again");
});

test("a browser that would not start says so, with the terminal command as the way round", async () => {
  const w = fakeWindow();
  await open(w);
  w.spawned[0].child.emit("error", new Error("spawn ENOENT"));
  w.spawned[0].child.emit("exit", 1); // both fire in real life; only one note is written
  await tick();
  assert.equal(notes().length, 1);
  assert.match(notes()[0].note, /could not be opened on the Mac/);
  assert.match(notes()[0].note, /npm run signin -- amazon/);
});

// ---------- the tool ----------

test("signin_open opens the window and tells the model exactly what it does not know yet", async () => {
  const opened = [];
  const out = await runTool("signin_open", { site: "amazon" }, {
    conversationId: CONV, channels: null,
    openSigninWindow: async (a) => { opened.push(a); return { ok: true, site: a.entry.site, opened_at: clock.now() }; },
  });
  assert.equal(out.ok, true);
  assert.equal(opened[0].conversationId, CONV);
  assert.equal(opened[0].entry.site, "amazon");
  assert.match(out.say, /A browser window is open on the Mac now, on Amazon's own sign-in page/);
  assert.match(out.where, /not on their phone/);
  assert.match(out.next, /do not say they are, and do not start the errand/);
  assert.equal(out.warning, undefined, "Amazon loads, so there is nothing to warn about");

  const receipt = db.db.prepare("SELECT action, target FROM action_ledger WHERE conversation_id = ?").get(CONV);
  assert.deepEqual({ ...receipt }, { action: "signin_open", target: "site:amazon" });
});

test("a site that refuses the browser still opens, with a warning that the page may not load", async () => {
  const out = await runTool("signin_open", { site: "doordash" }, { conversationId: CONV, channels: null, openSigninWindow: async (a) => ({ ok: true, site: a.entry.site }) });
  assert.equal(out.ok, true);
  assert.match(out.warning, /DoorDash refuses an automated browser/);
});

test("somebody who is not at the machine cannot open a window on it", async () => {
  db.upsertAccount({ conversationId: THEIRS, channel: "fake", address: FRIEND, name: "Kofi", isOperator: false });
  let opened = 0;
  const out = await runTool("signin_open", { site: "amazon" }, { conversationId: THEIRS, channels: null, openSigninWindow: async () => { opened++; return { ok: true }; } });
  assert.equal(out.ok, false);
  assert.equal(out.possible, false);
  assert.match(out.remote.why, /no window to show you from here/);
  assert.equal(opened, 0, "nothing opens on the operator's screen because a stranger asked");
});

test("an unknown site and an already-open window are both plain refusals", async () => {
  const none = await runTool("signin_open", { site: "netflix" }, { conversationId: CONV, channels: null });
  assert.match(none.error, /No site called 'netflix'/);

  const busy = await runTool("signin_open", { site: "amazon" }, { conversationId: CONV, channels: null, openSigninWindow: async () => ({ ok: false, already_open: "fandango", error: "A sign-in window is already open on the Mac, on fandango." }) });
  assert.equal(busy.ok, false);
  assert.equal(busy.already_open, "fandango");
  assert.ok(busy.never_a_password, "and the no-passwords answer is still to hand");
});
