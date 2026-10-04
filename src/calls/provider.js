// What a phone-call provider is, in the smallest shape that still makes a call useful.
//
// Reason does not dial; it hands someone a goal. "Ask if they have a table for 4 at 8 on
// Saturday, and if not, the nearest time." Whatever is on the other end — a realtime voice
// model, a hosted voice agent, a human — has to come back with a result that can be written
// down and quoted: what happened, what was said, how long, what it cost, and the recording.
//
// Deliberately NOT a provider's job: deciding whether the call is allowed (the gate, in
// tools.js), what the ledger says, who the owner is, or what the call opens with. A provider that
// gets its own plumbing wrong must not be able to place a call nobody agreed to, or one that
// starts without saying what it is.

export class CallProvider {
  name = "calls";

  /** Honest: "live" or "not_connected", with the exact env vars missing. */
  status() {
    return { name: this.name, status: "not_connected", missing: [], what: "", records: false };
  }

  /**
   * Place one call.
   *
   * `facts` is the *only* thing this call may tell the other end — a short list the owner
   * approved, not the conversation. `announcement` is built by Reason's own code (see
   * `announcementFor`) and MUST be spoken, verbatim, before anything else: a person picking up
   * the phone is told they are talking to an AI assistant, on whose behalf, and that they are
   * being recorded. It is not a suggestion to the model and not a field a provider may drop.
   *
   * The call is recorded. Not optionally — an adapter that cannot start a recording should fail
   * here rather than placing a call it cannot produce the audio of.
   *
   * Returns as soon as the call is accepted; the outcome arrives through `check` or a webhook.
   *
   * @param {{to: string, goal: string, facts: string[], maxSeconds: number,
   *          announcement: string, callbackUrl?: string}} _
   * @returns {Promise<{ok: boolean, externalId?: string, state?: string, error?: string}>}
   */
  async place(_) {
    return { ok: false, error: `${this.name} cannot place calls: it is not connected.` };
  }

  /**
   * Where a call got to. Returns the live state, and the result once it has one.
   *
   * `recording` is the audio: either a local `path` or a `url` to fetch, with whatever the
   * provider knows about it. A provider that lost the audio returns `recording: null` and says why
   * in `recordingWhy` — never an empty object, because "there is a recording" and "there is not"
   * must not look the same to the caller. For a call that was actually answered, that null is an
   * error state, reported to the owner and marked in the ledger.
   *
   * @param {string} _externalId
   * @returns {Promise<{ok: boolean, state: string, outcome?: string, summary?: string,
   *                    transcript?: string, durationS?: number|null, costCents?: number|null,
   *                    recording?: Recording|null, recordingWhy?: string, error?: string}>}
   */
  async check(_externalId) {
    return { ok: false, state: "unknown", error: `${this.name} cannot look up calls.` };
  }

  /**
   * Optional. Delete the provider's own copy of a recording. Reason's `data:delete` removes the
   * local file either way; this is for providers that keep their own.
   */
  async deleteRecording(_externalId) {
    return { ok: true, supported: false };
  }
}

/**
 * One recording, as a provider hands it over.
 *
 * @typedef {object} Recording
 * @property {string} [path]    a local file, already on this machine
 * @property {string} [url]     an HTTPS URL to fetch it from
 * @property {string} [format]  "wav", "mp3", "m4a" — the container, lowercase, no dot
 * @property {number} [seconds] how long the audio runs
 * @property {number} [bytes]   file size, when the provider knows it
 * @property {object} [headers] headers needed to fetch `url` (a provider auth token, say)
 */

/** The states a call moves through. Anything past in_progress is final. */
export const LIVE_STATES = ["placing", "ringing", "in_progress"];
export const FINAL_STATES = ["completed", "no_answer", "busy", "declined", "failed", "voicemail"];

/**
 * What the call says before anything else, written by code.
 *
 * Two things are disclosed, and both are the kind of thing a model should never be trusted to
 * remember: that the voice is an AI assistant acting for somebody, and that the call is being
 * recorded. Several of the states Reason will be calling into are all-party consent states for
 * recording a call, and "the model usually mentions it" is not a consent regime. So it is a string
 * this module builds, passed into `place()` as its own argument, and a provider that cannot speak
 * it is refused before the dial.
 *
 * Every call is recorded — there is no variant of this line that omits the recording, because
 * there is no call that is not recorded.
 */
export function announcementFor({ ownerName }) {
  return `Hi — this is an AI assistant calling on behalf of ${ownerName}. This call is recorded.`
    + ` If you'd rather not be recorded, tell me and I'll hang up.`;
}

/**
 * The announcement is a precondition, not a courtesy. Called by every provider at the top of
 * `place()`, so a provider cannot place a call that opens with nothing — including a provider
 * written later by somebody who did not read this file.
 */
export function requireAnnouncement({ announcement, ownerName }) {
  const a = String(announcement ?? "").trim();
  if (!a) return { ok: false, error: "refused: a call must open by saying what it is, and no announcement was given." };
  if (!/ai assistant/i.test(a)) {
    return { ok: false, error: "refused: the announcement must say the caller is an AI assistant." };
  }
  if (ownerName && !a.toLowerCase().includes(String(ownerName).toLowerCase())) {
    return { ok: false, error: `refused: the announcement must say who the call is on behalf of (${ownerName}).` };
  }
  if (!/recorded/i.test(a)) {
    return { ok: false, error: "refused: every call is recorded and the announcement does not say so." };
  }
  return { ok: true, announcement: a };
}

/**
 * Was there a conversation on this call that there ought to be audio of?
 *
 * The difference matters because it separates a provider failing from a phone simply not being
 * answered. A completed call or one that reached voicemail had something said on it, so a missing
 * recording is a real error. Nobody picking up is not: there was nothing to record, and treating
 * it as a fault would train the owner to ignore the warning that matters.
 */
export const SPOKE_TO_SOMETHING = ["completed", "voicemail"];
