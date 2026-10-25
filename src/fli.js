// Flight search through Fli (github.com/punitarani/fli, PyPI "flights"), run as a managed sidecar.
//
// Fli is Python and reads Google Flights' public search page; Reason is one Node process. This file
// owns the Python child: it starts it the first time somebody asks for flights, restarts it if it
// dies, stops it once nobody has searched for a while, and turns every way it can fail into an
// honest error. The child is `scripts/fli_sidecar.py`, which calls Fli's own `SearchFlights` /
// `SearchDates` with Fli's shipped rate limiter and retries untouched.
//
// Why not Fli's own MCP server (`fli-mcp`), which was the first path tried: in 0.9.0 it takes adults
// only (no children or infants), never exposes `top_n`, has no weekday filter, flattens Fli's typed
// errors into a string, and — the one that decided it — reports a request Google REFUSED as a
// successful search with zero flights. Reason must never say "no flights" when Google simply said
// no, so the sidecar looks at each response and calls a refusal what it is.
//
// The rules this file keeps, all of them from the owner's spec:
//
//   1. **Search only.** Nothing here books, holds or pays. Fli cannot, and nothing is added that could.
//   2. **No evasion.** When Google refuses, throttles or consent-gates us, Reason backs off
//      (`BLOCK_COOLDOWN_MS`) and says it couldn't check — no retries beyond Fli's own, no proxies, no
//      header tricks, no second transport.
//   3. **A dead sidecar is an error, never an empty result.** Every request that can't be answered
//      rejects with a `FliError` whose `kind` the tool turns into "I couldn't check flights right now".
//   4. **The last real outcome is remembered** (`lastOutcome()`), so /ops can show healthy / down /
//      blocked without ever calling Google itself.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SIDECAR_SCRIPT = path.join(HERE, "..", "scripts", "fli_sidecar.py");

/** Where the venv that holds the pinned Fli lives on the server; `FLI_PYTHON` overrides. */
export const DEFAULT_PYTHON = "/home/reason/fli-venv/bin/python";

/** Stop the child after this long with no request. It costs ~60MB resident while it waits. */
export const IDLE_MS = 10 * 60 * 1000;
/** One search may expand a round trip into 1 + top_n page fetches; Fli's own timeout is 60s each. */
export const REQUEST_TIMEOUT_MS = 150 * 1000;
/** After Google refuses us, don't ask again for this long — every caller gets the same honest answer. */
export const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
/** Three crashes inside this window and the sidecar is called down rather than restarted again. */
export const CRASH_WINDOW_MS = 5 * 60 * 1000;
export const CRASH_LIMIT = 3;

/** The kinds a caller can see. `empty` is not an error and never appears here. */
export const ERROR_KINDS = ["blocked", "network", "parse", "invalid", "down", "timeout", "internal"];

export class FliError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "FliError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/**
 * The sidecar, one per process. Construct with `{ python, script, spawnImpl, now, log }` — tests
 * hand in a fake `spawnImpl` and a fake clock so no Python and no Google is ever touched in CI.
 */
export class FliSidecar {
  constructor(opts = {}) {
    this.python = opts.python || process.env.FLI_PYTHON || DEFAULT_PYTHON;
    this.script = opts.script || SIDECAR_SCRIPT;
    this.spawnImpl = opts.spawnImpl || spawn;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || ((...a) => console.error("[fli]", ...a));
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.cooldownMs = opts.cooldownMs ?? BLOCK_COOLDOWN_MS;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
    this.crashes = [];
    this.blockedUntil = 0;
    this.outcome = null;
    this.onOutcome = opts.onOutcome === undefined ? recordInLedger : opts.onOutcome;
  }

  /** The last real outcome, for /ops: `{ at, state: "ok"|"empty"|<error kind>, op, detail, ms }`. */
  lastOutcome() {
    return this.outcome;
  }

  /** True when the python and script are where they should be — a cheap, local check. */
  installed() {
    return existsSync(this.python) && existsSync(this.script);
  }

  _record(state, op, detail, ms) {
    this.outcome = { at: this.now(), state, op, detail: detail ? String(detail).slice(0, 200) : null, ms };
    try {
      this.onOutcome?.(this.outcome);
    } catch {
      /* the ledger is never worth a search */
    }
  }

  _start() {
    if (this.child) return this.child;
    const recent = this.crashes.filter((t) => this.now() - t < CRASH_WINDOW_MS);
    this.crashes = recent;
    if (recent.length >= CRASH_LIMIT) {
      throw new FliError("down", `flight search sidecar crashed ${recent.length} times in 5 minutes`);
    }
    let child;
    try {
      child = this.spawnImpl(this.python, ["-I", this.script], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
      });
    } catch (e) {
      throw new FliError("down", `couldn't start the flight search sidecar: ${e.message}`);
    }
    this.child = child;
    this.buffer = "";
    // A write to a pipe the child already closed raises on stdin; unheard, that error would take
    // the whole Reason process down. The exit handler is what fails the requests.
    child.stdin?.on?.("error", (e) => this.log("sidecar stdin:", e.message));
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr?.on?.("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log("sidecar stderr:", text.slice(0, 2000));
    });
    child.on("error", (e) => this._onExit(child, `spawn error: ${e.message}`));
    child.on("exit", (code, signal) => this._onExit(child, `exited code=${code} signal=${signal}`));
    return child;
  }

  _onExit(child, why) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const expected = child._reasonStopping;
    if (!expected) {
      this.crashes.push(this.now());
      this.log(`sidecar died (${why}); ${this.pending.size} request(s) in flight`);
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new FliError("down", `flight search sidecar stopped mid-search (${why})`));
    }
    this.pending.clear();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log("sidecar wrote a line that isn't JSON:", line.slice(0, 200));
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = msg.error || {};
        const kind = ERROR_KINDS.includes(err.kind) ? err.kind : "internal";
        p.reject(new FliError(kind, err.message || "flight search failed", { type: err.type, status: err.status }));
      }
    }
    this._armIdle();
  }

  _armIdle() {
    clearTimeout(this.idleTimer);
    if (!this.child || this.pending.size) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Ask the child to stop: closing stdin lets in-flight answers finish, then it exits. */
  stop() {
    const child = this.child;
    if (!child) return;
    child._reasonStopping = true;
    // Let go of it now: a search that arrives while it winds down starts a fresh child instead of
    // writing into this one's closed stdin. Answers already in flight still land — its stdout
    // handler reads the same pending map — and any that don't are failed by their own timers.
    this.child = null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      child.stdin.end();
    } catch {}
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 5000);
    killer.unref?.();
  }

  /** Raw request to the sidecar. Callers want `searchFlights` / `searchDates` below. */
  async call(op, params = {}) {
    if (!this.child && !this.installed()) {
      throw new FliError("down", `flight search isn't installed here (${this.python})`);
    }
    const child = this._start();
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FliError("timeout", `flight search took longer than ${Math.round(this.timeoutMs / 1000)}s`));
        this._armIdle();
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, op, params }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new FliError("down", `couldn't reach the flight search sidecar: ${e.message}`));
      }
    });
  }

  /**
   * A search that touches Google. Refuses up front while a block cooldown runs, and records the
   * outcome either way so /ops reads the truth without making its own call.
   */
  async _search(op, params) {
    const started = this.now();
    if (this.now() < this.blockedUntil) {
      const err = new FliError("blocked", "Google refused a recent flight search; backing off before asking again", {
        retryAt: this.blockedUntil,
      });
      throw err;
    }
    try {
      const result = await this.call(op, { ...params, currency: params.currency || "USD" });
      // Part of it was refused (a round trip's return pages) while the rest answered: the results
      // are real, but Google is saying slow down, so the next search waits out the same back-off.
      if (result.refused_fetches > 0) {
        this.blockedUntil = this.now() + this.cooldownMs;
        this.log(`google refused ${result.refused_fetches} of ${result.fetches} page fetches; backing off`);
      }
      this._record(result.count ? "ok" : "empty", op, result.refused_fetches > 0 ? `${result.refused_fetches} page fetches refused` : null, this.now() - started);
      return result;
    } catch (e) {
      const err = e instanceof FliError ? e : new FliError("internal", e.message);
      if (err.kind === "blocked") this.blockedUntil = this.now() + this.cooldownMs;
      if (err.kind !== "invalid") this._record(err.kind, op, err.message, this.now() - started);
      throw err;
    }
  }

  searchFlights(params) {
    return this._search("search_flights", params);
  }

  searchDates(params) {
    return this._search("search_dates", params);
  }

  /** Local airport lookup — no network. */
  airports(query, limit = 8) {
    return this.call("airports", { query, limit });
  }
}

/** Provider id in the ops call ledger (`provider_state`); src/ops.js reads the row back. */
export const LEDGER_ID = "fli";

/**
 * Every real outcome goes into the same call ledger the other providers use, so /ops reads the
 * last search across a restart and never calls Google itself. The error text starts with the kind
 * (`blocked: …`) because that is what decides the row's colour.
 */
function recordInLedger(o) {
  Promise.all([import("./db.js"), import("./accounts.js")])
    .then(([db, accounts]) => db.recordProviderCall({
      provider: LEDGER_ID,
      day: accounts.today(o.at),
      ok: o.state === "ok" || o.state === "empty",
      status: 0,
      ms: o.ms,
      error: o.state === "ok" || o.state === "empty" ? "" : `${o.state}: ${o.detail || ""}`,
      at: o.at,
    }))
    .catch(() => {});
}

let shared = null;
/** The process-wide sidecar. Tests build their own `FliSidecar` instead. */
export function fli() {
  if (!shared) shared = new FliSidecar();
  return shared;
}
/** Test seam: swap the process-wide sidecar (pass null to reset). */
export function setFli(instance) {
  if (shared && shared !== instance) shared.stop();
  shared = instance;
}
