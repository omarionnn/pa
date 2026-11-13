// Opening the sign-in window from a text, instead of from a terminal.
//
// The window itself is unchanged — it is `src/signin-cli.js`, the same visible Chromium in the same
// saved profile, with the same rule that signed-in is whatever the SITE says once the window has
// closed. What this adds is who starts it: Reason, when the person at the machine asks to sign in,
// so "can you sign into my Amazon" is answered with a window opening rather than with a command to
// go and type.
//
// What it does not change, and cannot: the window opens on the machine Reason runs on. Somebody
// texting from across town gets a window on a screen they are not looking at. So this is only for
// the operator, and the result says in words that the window is on the Mac.
//
// The window runs as its own process, for two reasons. A persistent browser profile can be open in
// one browser at a time, so Reason's own headless browser for that person is closed first and the
// window gets the profile to itself. And a window somebody forgets about must not hold the profile
// forever: after `signinWindowMaxMs` it is closed, and that is said too.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import { config, clock } from "./config.js";
import { holdProfile, releaseProfile } from "./browser.js";

const CLI = fileURLToPath(new URL("./signin-cli.js", import.meta.url));

/** One window per person at a time. conversationId → { site, child, startedAt, timer }. */
const windows = new Map();

export function openWindowFor(conversationId) {
  const w = windows.get(conversationId);
  return w ? { site: w.site, startedAt: w.startedAt } : null;
}

/**
 * What to tell the person once the window has gone, read off what the site said.
 *
 * Written as a note on a timer due now rather than sent from here: the sweep turns it into an
 * ordinary event turn, so the news arrives in Reason's own voice, through the outbox, on whichever
 * backend is running — and survives the process stopping between the window closing and the text.
 */
export function closedNote({ conversationId, site, label, startedAt, timedOut = false }) {
  if (timedOut) {
    return `the ${label} sign-in window you opened on the Mac sat open for ${Math.round(config.signinWindowMaxMs / 60_000)} minutes, so you closed it. Nothing was checked or recorded. Tell them that in one short line and that they can ask again when they are at the Mac.`;
  }
  const last = db.lastSigninCheck(conversationId, site);
  const fresh = last && last.checked_at >= startedAt;
  if (!fresh) {
    return `the ${label} sign-in window on the Mac has closed, but the check that asks ${label} whether they are signed in did not run, so nothing is recorded either way. Say that in one short line; signin_status with recheck will ask the site now.`;
  }
  if (last.state === "signed_in") {
    return `the ${label} sign-in window on the Mac has closed and ${label} says they ARE signed in now (${last.evidence || "its account page loaded"}). Tell them in one short line that it worked, and pick up whatever they wanted ${label} for.`;
  }
  return `the ${label} sign-in window on the Mac has closed and ${label} says they are still NOT signed in (${last.state}: ${last.evidence || "the account page asked for a sign-in"}). Tell them that plainly in one short line — it did not take — and offer to open the window again.`;
}

/**
 * Open the window. Returns straight away; the person is the slow part.
 *
 * `spawnImpl`, `closeBrowser` and `timers` are injected so a test opens no window and waits for
 * nothing.
 */
export async function openSigninWindow({
  conversationId, entry, closeBrowser = async () => {}, spawnImpl = spawn,
  timers = { set: setTimeout, clear: clearTimeout }, log = () => {}, provider = "",
}) {
  const already = windows.get(conversationId);
  if (already) {
    return { ok: false, already_open: already.site, error: `A sign-in window is already open on the Mac, on ${already.site}. One at a time: it has to be closed before another can open.` };
  }

  // The profile can be in one browser at a time, and the window needs it: it is the window's until the
  // window's process has gone, however it goes (src/browser.js holdProfile).
  const holder = Symbol("signin_window");
  if (!holdProfile(conversationId, holder)) {
    return { ok: false, busy: "signing_in", error: "A sign-in is already open on their saved profile. Let it finish first." };
  }
  try {
    await closeBrowser(conversationId);
  } catch (e) {
    releaseProfile(conversationId, holder);
    throw e;
  }

  let child;
  try {
    // `provider` (google/apple/facebook/microsoft, src/socialsignin.js): the window presses that
    // button on the sign-in page for them, and the site's "signed in" afterwards records which
    // button it was. The CLI reads it from its environment so the argument list stays one site name.
    // Never Google (src/socialsignin.js NEVER_PRESSED).
    const pressable = provider && provider !== "google" ? provider : "";
    const env = pressable ? { ...process.env, REASON_SIGNIN_PROVIDER: pressable } : process.env;
    // A site known only by its address goes as its sign-in page, so the window opens there.
    child = spawnImpl(process.execPath, [CLI, entry.generic ? entry.signin_url : entry.site], { env, stdio: "ignore" });
  } catch (e) {
    releaseProfile(conversationId, holder);
    return { ok: false, error: `The sign-in window could not be opened: ${(e?.message ?? String(e)).split("\n")[0]}` };
  }
  const startedAt = clock.now();
  const w = { site: entry.site, child, startedAt, timedOut: false, timer: null };
  windows.set(conversationId, w);
  log({ signin_window_open: entry.site, conversation: conversationId, pid: child.pid ?? null });

  w.timer = timers.set(() => {
    w.timedOut = true;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }, config.signinWindowMaxMs);
  w.timer?.unref?.();

  const finish = (how) => {
    if (windows.get(conversationId) !== w) return; // 'error' and 'exit' can both fire
    windows.delete(conversationId);
    releaseProfile(conversationId, holder);
    timers.clear(w.timer);
    const note = how === "failed"
      ? `the ${entry.label} sign-in window could not be opened on the Mac (the browser would not start). Tell them that in one short line, and that running "npm run signin -- ${entry.site}" in a terminal on the Mac does the same thing.`
      : closedNote({ conversationId, site: entry.site, label: entry.label, startedAt, timedOut: w.timedOut });
    log({ signin_window_closed: entry.site, conversation: conversationId, how: w.timedOut ? "timed_out" : how });
    db.createTimer(conversationId, { fireAt: clock.now(), note });
  };
  child.on("exit", (code) => finish(code === 0 || w.timedOut ? "closed" : "exited"));
  child.on("error", () => finish("failed"));

  return { ok: true, site: entry.site, opened_at: startedAt };
}
