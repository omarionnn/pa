// What a phone-call provider is, in the smallest shape that still makes a call useful.
//
// Reason does not dial; it hands someone a goal. "Ask if they have a table for 4 at 8 on
// Saturday, and if not, the nearest time." Whatever is on the other end — a realtime voice
// model, a hosted voice agent, a human — has to come back with a result that can be written
// down and quoted: what happened, what was said, how long, what it cost.
//
// Deliberately NOT a provider's job: deciding whether the call is allowed (the gate, in
// tools.js), what the ledger says, or who the owner is. A provider that gets its own plumbing
// wrong must not be able to place a call nobody agreed to.

export class CallProvider {
  name = "calls";

  /** Honest: "live" or "not_connected", with the exact env vars missing. */
  status() {
    return { name: this.name, status: "not_connected", missing: [], what: "" };
  }

  /**
   * Place one call. `facts` is the *only* thing this call may tell the other end — a short list
   * the owner approved, not the conversation. Returns as soon as the call is accepted by the
   * provider; the outcome arrives through `check` or a webhook.
   *
   * @param {{to: string, goal: string, facts: string[], maxSeconds: number, callbackUrl?: string}} _
   * @returns {Promise<{ok: boolean, externalId?: string, state?: string, error?: string}>}
   */
  async place(_) {
    return { ok: false, error: `${this.name} cannot place calls: it is not connected.` };
  }

  /**
   * Where a call got to. Returns the live state, and the result once it has one.
   *
   * @param {string} _externalId
   * @returns {Promise<{ok: boolean, state: string, outcome?: string, summary?: string,
   *                    transcript?: string, durationS?: number|null, costCents?: number|null,
   *                    error?: string}>}
   */
  async check(_externalId) {
    return { ok: false, state: "unknown", error: `${this.name} cannot look up calls.` };
  }
}

/** The states a call moves through. Anything past in_progress is final. */
export const LIVE_STATES = ["placing", "ringing", "in_progress"];
export const FINAL_STATES = ["completed", "no_answer", "busy", "declined", "failed", "voicemail"];
