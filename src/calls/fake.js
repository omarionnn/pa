// A provider that dials nothing. This is the only one wired up: no paid telephony account
// exists, and a test that could reach a real phone is a test that will eventually ring one.
//
// It is scriptable so every branch is exercisable — the restaurant answers, nobody picks up, it
// goes to voicemail, the provider itself falls over, the recording fails — and it records exactly
// what it was asked to say and to announce, which is how "it only shared what was approved" and
// "it said it was an AI and recording" become assertable rather than hoped for.
//
// Its default recording is a real 4.8 KB WAV sitting next to this file: a short tone, so a test
// can prove a file with audio in it actually reached the owner rather than a path that was never
// checked.
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { CallProvider, requireAnnouncement, requireCallRules } from "./provider.js";
import { clock, config } from "../config.js";

export const FIXTURE_RECORDING = fileURLToPath(new URL("./fixture-recording.wav", import.meta.url));

export class FakeCallProvider extends CallProvider {
  name = "fake";

  /**
   * @param {object} opts
   * @param {boolean} opts.live            whether status() reports live
   * @param {Array|Function} opts.script   per-call results, in order, or a function of the request
   * @param {boolean} opts.ringFirst       report `ringing` on the first check and settle on the next
   * @param {boolean} opts.records         `false` makes it a provider that cannot record, which
   *                                       is a provider that cannot place a call at all
   */
  constructor({ live = true, script = null, ringFirst = false, records = true } = {}) {
    super();
    this.live = live;
    this.script = script;
    this.ringFirst = ringFirst;
    this.records = records;
    this.placed = [];
    this.results = new Map();
    this.checks = new Map();
    this.deleted = [];
    this.n = 0;
  }

  status() {
    const what = "a call provider that dials nothing, for tests";
    return this.live
      ? { name: this.name, status: "live", missing: [], what, records: this.records }
      : { name: this.name, status: "not_connected", missing: ["REASON_TELEPHONY_KEY"], what, records: this.records };
  }

  async place({ to, goal, facts, maxSeconds, announcement, rules }) {
    if (!this.live) return { ok: false, error: "the fake provider is switched off" };

    // The same preconditions a real provider is held to. A call that would open with nothing, or
    // one that does not carry the no-payment rule, is refused here — before anything is written
    // down as placed.
    const ann = requireAnnouncement({ announcement, ownerName: config.ownerName });
    if (!ann.ok) return { ok: false, error: ann.error };
    const rul = requireCallRules({ rules });
    if (!rul.ok) return { ok: false, error: rul.error };

    // Every call is recorded, so a provider that cannot record cannot place one. A real adapter
    // that fails to start its recording should refuse here in exactly this way.
    if (!this.records) return { ok: false, error: "refused: this provider cannot record a call, and every call is recorded" };

    const externalId = `fake-call-${++this.n}`;
    this.placed.push({ externalId, to, goal, facts, maxSeconds, announcement: ann.announcement, rules: rul.rules, at: clock.now() });

    const scripted = typeof this.script === "function"
      ? this.script({ to, goal, facts, n: this.n })
      : Array.isArray(this.script) ? this.script[this.n - 1] : null;

    if (scripted?.placeFails) return { ok: false, error: scripted.placeFails };

    this.results.set(externalId, {
      state: "completed",
      outcome: "they answered",
      // The transcript opens with what was really announced, because that is what was really said.
      summary: "Answered. Said yes to the goal.",
      transcript: `Reason: ${ann.announcement}\nReason: ${goal}\nThem: sure, that works.`,
      durationS: 42,
      costCents: 3,
      recording: { path: FIXTURE_RECORDING, format: "wav", seconds: 1, bytes: statSync(FIXTURE_RECORDING).size },
      recordingWhy: "",
      // A script can override any of the above — including setting `recording: null` to exercise
      // the provider losing the audio, which is the error path that matters most.
      ...(scripted ?? {}),
    });
    return { ok: true, externalId, state: "placing" };
  }

  async check(externalId) {
    const r = this.results.get(externalId);
    if (!r) return { ok: false, state: "unknown", error: `no call ${externalId}` };
    const seen = (this.checks.get(externalId) ?? 0) + 1;
    this.checks.set(externalId, seen);
    if (this.ringFirst && seen === 1) return { ok: true, state: "ringing" };
    return { ok: true, durationS: null, costCents: null, recording: null, recordingWhy: "", ...r };
  }

  async deleteRecording(externalId) {
    this.deleted.push(externalId);
    return { ok: true, supported: true };
  }
}
