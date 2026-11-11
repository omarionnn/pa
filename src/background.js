// The background lane on Reason's own subscription.
//
// Extraction and the profile moved off the paid API onto the CLI (2026-10-25). That is the same
// subscription every reply runs on, and it has a five-hour limit: on 2026-10-17 and 10-20 it ran out
// and replies stopped for hours. So background work here is the lowest priority there is:
//
//   - one job at a time, never two CLI runs of background work side by side;
//   - at least config.backgroundCliGapMs between two of them;
//   - nothing starts while a reply turn is in flight on the CLI (`whileTurn`);
//   - nothing starts while the subscription is limited — a CLI run (any, a reply's included) that
//     came back with a limit, a 429 or an overload parks the lane until the reset it names, or
//     fifteen minutes (src/down.js readOutage).
//
// A job that cannot run waits. It never falls back to the paid API, and it never holds up a reply:
// replies do not queue here at all. Jobs are keyed, so the sweep asking for "extract" every fifteen
// seconds while the lane is parked leaves one job waiting, not a pile.
import { config } from "./config.js";
import { readOutage } from "./down.js";
import { onCliRun } from "./backends/cli.js";
import * as zonescope from "./zonescope.js";

const POLL_MS = 1_000;

const lane = {
  turns: 0,
  limitedUntil: 0,
  limitedWhy: "",
  lastRunAt: 0,
  jobs: new Map(),
  pumping: null,
  now: () => Date.now(),
  gapMs: () => config.backgroundCliGapMs,
};

/** Run a reply turn, with the lane paused for as long as it is in flight. */
export async function whileTurn(fn) {
  lane.turns++;
  try {
    return await fn();
  } catch (e) {
    noteFailure(e);
    throw e;
  } finally {
    lane.turns--;
  }
}

/**
 * Hold the lane for a stretch that is not one CLI run — a person's whole turn, check and send
 * included (REASON_FAST_REPLY, src/runtime.js _turn). Returns the release; calling it twice is safe.
 */
export function holdLane() {
  lane.turns++;
  let released = false;
  return () => { if (!released) { released = true; lane.turns--; } };
}

/** A CLI run failed: if it says the subscription is limited, park the lane until it is not. */
export function noteFailure(err) {
  const o = readOutage(err, { now: lane.now() });
  if (!o) return false;
  if (o.until > lane.limitedUntil) { lane.limitedUntil = o.until; lane.limitedWhy = o.why.slice(0, 160); }
  return true;
}

// Every CLI run reports here, so a reply that hits the limit parks background work too.
onCliRun(r => { if (!r.ok && !r.interrupted) noteFailure(r.error ?? ""); });

/** Why the lane would not start a job now, and for how long: `{ why, waitMs }`, or null when it would. */
export function blocked(now = lane.now()) {
  if (lane.turns > 0) return { why: "reply_in_flight", waitMs: POLL_MS };
  if (lane.limitedUntil > now) return { why: "subscription_limited", waitMs: lane.limitedUntil - now, detail: lane.limitedWhy };
  const gap = lane.lastRunAt + lane.gapMs() - now;
  if (gap > 0) return { why: "gap", waitMs: gap };
  return null;
}

/**
 * Queue `fn` under `key` (a key already waiting is not queued twice). Resolves when the job has run,
 * to what it returned; rejects with what it threw. Starts the pump if it is idle.
 */
export function enqueue(key, fn) {
  const had = lane.jobs.get(key);
  if (had) return had.done;
  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });
  done.catch(() => {});
  lane.jobs.set(key, { fn, resolve, reject, done });
  pump();
  return done;
}

const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

function pump() {
  if (lane.pumping) return lane.pumping;
  // Shared by everyone: never on the clock of whichever person's turn happened to start it.
  lane.pumping = zonescope.outside(() => (async () => {
    try {
      while (lane.jobs.size) {
        const b = blocked();
        if (b) { await sleep(Math.min(b.waitMs, 5_000)); continue; }
        const [key, job] = lane.jobs.entries().next().value;
        lane.jobs.delete(key);
        lane.lastRunAt = lane.now();
        try { job.resolve(await job.fn()); } catch (e) { noteFailure(e); job.reject(e); }
        // The gap counts from when a job ENDS: a two-minute extraction is not followed at once.
        lane.lastRunAt = lane.now();
      }
    } finally {
      lane.pumping = null;
    }
  })());
  return lane.pumping;
}

/** What the lane is doing, for the status page and the log. */
export function status(now = lane.now()) {
  return { turns: lane.turns, waiting: [...lane.jobs.keys()], limited_until: lane.limitedUntil > now ? lane.limitedUntil : null, blocked: blocked(now)?.why ?? null };
}

/** For tests: a clean lane, a clock and a gap of the test's choosing. */
export function resetLane({ now = () => Date.now(), gapMs = null } = {}) {
  lane.turns = 0; lane.limitedUntil = 0; lane.limitedWhy = ""; lane.lastRunAt = 0; lane.jobs.clear(); lane.pumping = null;
  lane.now = now;
  lane.gapMs = gapMs == null ? () => config.backgroundCliGapMs : () => gapMs;
}
