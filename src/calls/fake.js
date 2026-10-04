// A provider that dials nothing. This is the only one wired up: no paid telephony account
// exists, and a test that could reach a real phone is a test that will eventually ring one.
//
// It is scriptable so every branch is exercisable — the restaurant answers, nobody picks up, it
// goes to voicemail, the provider itself falls over — and it records exactly what it was asked
// to say, which is how "it only shared what was approved" becomes assertable.
import { CallProvider } from "./provider.js";
import { clock } from "../config.js";

export class FakeCallProvider extends CallProvider {
  name = "fake";

  /**
   * @param {object} opts
   * @param {boolean} opts.live            whether status() reports live
   * @param {Array|Function} opts.script   per-call results, in order, or a function of the request
   * @param {boolean} opts.ringFirst       report `ringing` on the first check and settle on the next
   */
  constructor({ live = true, script = null, ringFirst = false } = {}) {
    super();
    this.live = live;
    this.script = script;
    this.ringFirst = ringFirst;
    this.placed = [];
    this.results = new Map();
    this.checks = new Map();
    this.n = 0;
  }

  status() {
    return this.live
      ? { name: this.name, status: "live", missing: [], what: "a call provider that dials nothing, for tests" }
      : { name: this.name, status: "not_connected", missing: ["REASON_TELEPHONY_KEY"], what: "a call provider that dials nothing, for tests" };
  }

  async place({ to, goal, facts, maxSeconds }) {
    if (!this.live) return { ok: false, error: "the fake provider is switched off" };
    const externalId = `fake-call-${++this.n}`;
    this.placed.push({ externalId, to, goal, facts, maxSeconds, at: clock.now() });

    const scripted = typeof this.script === "function"
      ? this.script({ to, goal, facts, n: this.n })
      : Array.isArray(this.script) ? this.script[this.n - 1] : null;

    if (scripted?.placeFails) return { ok: false, error: scripted.placeFails };

    this.results.set(externalId, scripted ?? {
      state: "completed", outcome: "they answered",
      summary: "Answered. Said yes to the goal.",
      transcript: `Reason: ${goal}\nThem: sure, that works.`,
      durationS: 42, costCents: 3,
    });
    return { ok: true, externalId, state: "placing" };
  }

  async check(externalId) {
    const r = this.results.get(externalId);
    if (!r) return { ok: false, state: "unknown", error: `no call ${externalId}` };
    const seen = (this.checks.get(externalId) ?? 0) + 1;
    this.checks.set(externalId, seen);
    if (this.ringFirst && seen === 1) return { ok: true, state: "ringing" };
    return { ok: true, durationS: null, costCents: null, ...r };
  }
}
