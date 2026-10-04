// What a channel is. Reason talks to people over something — a terminal, a phone number, a test
// harness — and the rest of the codebase should not care which.
//
// A channel does four things and nothing else:
//   status()        says honestly whether it can actually be used right now
//   send()          puts one plain-text message in front of one address
//   typing()        optional; shows "typing…" while a long step runs
//   receive()       optional; turns one raw inbound HTTP request into inbound messages
//
// Deliberately NOT a channel's job: deciding who the owner is, running a turn, writing the
// ledger, or spending a confirmation. Those are the router's and the tools', so a new adapter
// cannot accidentally hand a stranger the owner's authority by getting its own plumbing wrong.

export class Channel {
  /** Short stable id, used in webhook paths and ledger rows. */
  name = "channel";

  /**
   * Can this be used right now? `status` is "live" or "not_connected"; `missing` names the exact
   * env vars that are absent. Never optimistic: a channel with no credentials says not_connected
   * and the capabilities tool repeats that word for word.
   */
  status() {
    return { name: this.name, status: "not_connected", missing: [], what: "" };
  }

  /**
   * Send one message. Returns a delivery result rather than throwing for an expected failure,
   * because "it did not go out" is information the model has to be able to read and say.
   *
   * @param {{to: string, text: string, idempotencyKey?: string, chatId?: string|null}} _
   * @returns {Promise<{ok: boolean, delivered?: object, error?: string}>}
   */
  async send(_) {
    return { ok: false, error: `${this.name} cannot send anything: it is not connected.` };
  }

  /** Optional. `supported: false` is a fine answer and is never an error. */
  async typing(_) {
    return { ok: true, supported: false };
  }

  /**
   * Optional. Verify, parse and return what arrived. Returns the HTTP status and body to answer
   * the provider with, plus the inbound messages for the router to deliver.
   *
   * @param {{rawBody: string, headers: object}} _
   * @returns {Promise<{status: number, body: object, inbound: Array<object>}>}
   */
  async receive(_) {
    return { status: 404, body: { error: `${this.name} has no webhook` }, inbound: [] };
  }
}

/**
 * One inbound message, in the only shape the router accepts. Every adapter normalises to this,
 * so the owner check and the dedupe are written once instead of once per provider.
 *
 * @typedef {object} Inbound
 * @property {string} channel     which adapter it came from
 * @property {string} externalId  the provider's own event id — the dedupe key
 * @property {string} from        the sender's address, E.164 where it is a phone number
 * @property {string} text        plain text; non-text parts are described, never dropped silently
 * @property {string|null} chatId the provider's thread id, when it has one
 * @property {number} at          when it was sent, ms since epoch
 */
