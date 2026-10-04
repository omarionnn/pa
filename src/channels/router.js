// Where a message becomes a turn, and where it is decided whose Reason it belongs to.
//
// Every guard that depends on "who is this" lives here and in the tools, never in an adapter:
//
//   - **everyone who is admitted gets their own Reason.** A message lands in that person's own
//     conversation, and every table is keyed by it, so nothing one person stored, connected or
//     approved is reachable from another's thread. The operator's conversation is the one their
//     data is already under, so a single-owner install is unchanged.
//   - **invite-only by default.** A number nobody approved gets one polite line and **no model
//     turn** — refused before the queue, so texting an uninvited number at Reason cannot spend the
//     operator's money. It is told once a day, not once a message.
//   - **a cap per person per day.** Past it, Reason says so and stops, rather than the operator
//     finding out from a bill.
//   - **a provider retrying a delivery is a no-op.** The event id is claimed in the database
//     before the turn, so a double delivery cannot produce a double reply.
//
// Outbound is the other direction of the same rule: anything addressed to someone who is not the
// person whose Reason this is goes through the confirm gate, which lives in the tool, not here.

import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config, normalizeNumber } from "../config.js";

export class Router {
  constructor({ runtime, log = () => {} } = {}) {
    this.runtime = runtime;
    this.log = log;
    this.channels = new Map();
  }

  register(channel) {
    this.channels.set(channel.name, channel);
    return channel;
  }

  get(name) { return this.channels.get(name) ?? null; }
  list() { return [...this.channels.values()]; }

  /** Every channel's honest status, for the capabilities tool and /health. */
  statuses() { return this.list().map(ch => ch.status()); }

  /** True when at least one registered channel can actually put text in front of a person. */
  get anyLive() { return this.statuses().some(s => s.status === "live"); }

  /**
   * Which conversation an address belongs to. The operator's number maps onto the conversation the
   * console and their existing data already use, so nothing splits when a phone number shows up.
   * Everyone else gets their own.
   */
  conversationFor({ channel, address }) {
    return accounts.conversationIdFor({ channel, address });
  }

  /**
   * One inbound message → at most one turn. Returns what happened, which is what the webhook
   * route answers the provider with.
   */
  async deliver(inbound) {
    const address = normalizeNumber(inbound.from) || String(inbound.from ?? "").trim();

    // Before anything else: is this somebody Reason works for? A number nobody approved never
    // reaches the queue, so it cannot cost a model call. It gets one line, once a day.
    const admitted = accounts.admit({ channel: inbound.channel, address });
    if (!admitted.allow) {
      this.log({ inbound: inbound.externalId, turned_away: address, why: admitted.reason });
      if (accounts.shouldTellNotInvited(address)) {
        await this.send({ channel: inbound.channel, to: address, text: accounts.notInvitedLine(), chatId: inbound.chatId ?? null })
          .catch(() => {});
        return { ok: true, admitted: false, told: true, conversationId: null };
      }
      return { ok: true, admitted: false, told: false, conversationId: null };
    }
    const { conversationId, isOperator } = admitted;

    // Claimed before anything else runs: a retry has to stop here, not after the reply.
    if (!db.claimInbound({ channel: inbound.channel, externalId: inbound.externalId, conversationId })) {
      this.log({ inbound: inbound.externalId, duplicate: true });
      return { ok: true, duplicate: true, conversationId };
    }

    db.upsertThread({
      conversationId, channel: inbound.channel, address,
      chatId: inbound.chatId ?? null, isOwner: true,
    });

    // Their own day's worth of turns. The operator pays for all of them, so the limit is real and
    // it is counted in the database; past it Reason says so instead of going quiet.
    const cap = accounts.withinCap(conversationId, "turn");
    if (!cap.ok) {
      this.log({ inbound: inbound.externalId, capped: conversationId, used: cap.used, limit: cap.limit });
      await this.send({
        channel: inbound.channel, to: address, chatId: inbound.chatId ?? null,
        text: `that's me done for today — i've hit my limit of ${cap.limit} messages. i'll pick this back up tomorrow.`,
      }).catch(() => {});
      return { ok: true, conversationId, capped: true, replied: false };
    }
    accounts.countUse(conversationId, "turn");

    const reply = await this.runtime.inbound(conversationId, inbound.text, {
      channel: inbound.channel, to: address, chatId: inbound.chatId ?? null, fromOwner: true, isOperator,
    });
    return { ok: true, conversationId, fromOwner: true, isOperator, replied: reply !== null };
  }

  /**
   * Put one message out over a channel. This is the plumbing only — whether Reason was *allowed*
   * to send it was settled by the `message_send` tool and its gate before this is ever called.
   */
  async send({ channel, to, text, chatId = null, idempotencyKey }) {
    const ch = this.get(channel);
    if (!ch) return { ok: false, error: `No channel called '${channel}'. Registered: ${[...this.channels.keys()].join(", ") || "none"}.` };
    const st = ch.status();
    if (st.status !== "live") {
      return { ok: false, status: "not_connected", error: `${channel} is not connected: this machine has no ${st.missing.join(", ") || "credentials for it"}.` };
    }
    return await ch.send({ to, text, chatId, idempotencyKey });
  }

  /**
   * One message with text and a file over a channel. A channel that cannot do attachments says
   * `supported: false` and the caller falls back to text plus an honest line about the file —
   * never to pretending it went.
   */
  async sendMedia({ channel, to, text, file, mimeType, filename = null, chatId = null, idempotencyKey }) {
    const ch = this.get(channel);
    if (!ch) return { ok: false, supported: false, error: `No channel called '${channel}'. Registered: ${[...this.channels.keys()].join(", ") || "none"}.` };
    const st = ch.status();
    if (st.status !== "live") {
      return { ok: false, supported: true, status: "not_connected", error: `${channel} is not connected: this machine has no ${st.missing.join(", ") || "credentials for it"}.` };
    }
    try {
      return await ch.sendMedia({ to, text, file, mimeType, filename, chatId, idempotencyKey });
    } catch (e) {
      return { ok: false, supported: true, error: (e?.message ?? String(e)).split("\n")[0] };
    }
  }

  /** Best effort: a channel with no typing indicator is not an error. */
  async typing({ channel, to, chatId = null, on }) {
    const ch = this.get(channel);
    if (!ch || ch.status().status !== "live") return { ok: true, supported: false };
    try { return await ch.typing({ to, chatId, on }); }
    catch (e) { return { ok: false, supported: true, error: (e?.message ?? String(e)).split("\n")[0] }; }
  }

  /**
   * Hand a raw webhook request to the channel that owns it, then deliver whatever it parsed out.
   * A bad signature never reaches `deliver`.
   */
  async webhook({ channel, rawBody, headers }) {
    const ch = this.get(channel);
    if (!ch) return { status: 404, body: { error: `no channel '${channel}'` } };
    let parsed;
    try {
      parsed = await ch.receive({ rawBody, headers });
    } catch (e) {
      this.log({ webhook: channel, threw: (e?.message ?? String(e)).split("\n")[0] });
      return { status: 500, body: { error: "webhook handler failed" } };
    }
    const delivered = [];
    for (const inbound of parsed.inbound ?? []) {
      delivered.push(await this.deliver({ ...inbound, channel }));
    }
    return { status: parsed.status, body: { ...parsed.body, delivered: delivered.length }, results: delivered };
  }
}
