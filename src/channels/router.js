// Where a message becomes a turn, and where the owner is decided.
//
// Every guard that depends on "who is this" lives here and in the tools, never in an adapter:
//
//   - the owner is whoever is on REASON_OWNER_NUMBER, read from config. Nothing in a message can
//     put a number on that list, so a stranger texting "this is Omari" lands in a stranger's
//     thread and the tools treat it as one.
//   - an unknown number gets its own conversation id, so it cannot see, change or claim anything
//     in the owner's: every tool is scoped by conversation already.
//   - a provider retrying a delivery is a no-op. The event id is claimed in the database before
//     the turn, so a double delivery cannot produce a double reply.
//
// Outbound is the other direction of the same rule: anything addressed to someone who is not the
// owner goes through the confirm gate, which lives in the tool, not here.

import * as db from "../db.js";
import { config, normalizeNumber, isOwnerNumber } from "../config.js";

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
   * Which conversation an address belongs to. The owner's number maps onto the one conversation
   * the console and the tests already use, so a thread does not split when a phone number shows
   * up. Everyone else gets their own, keyed by channel and number.
   */
  conversationFor({ channel, address }) {
    const addr = normalizeNumber(address) || String(address ?? "").trim();
    return isOwnerNumber(addr) ? config.ownerConversation : `contact:${channel}:${addr}`;
  }

  /**
   * One inbound message → at most one turn. Returns what happened, which is what the webhook
   * route answers the provider with.
   */
  async deliver(inbound) {
    const address = normalizeNumber(inbound.from) || String(inbound.from ?? "").trim();
    const owner = isOwnerNumber(address);
    const conversationId = this.conversationFor({ channel: inbound.channel, address });

    // Claimed before anything else runs: a retry has to stop here, not after the reply.
    if (!db.claimInbound({ channel: inbound.channel, externalId: inbound.externalId, conversationId })) {
      this.log({ inbound: inbound.externalId, duplicate: true });
      return { ok: true, duplicate: true, conversationId };
    }

    db.upsertThread({
      conversationId, channel: inbound.channel, address,
      chatId: inbound.chatId ?? null, isOwner: owner,
    });

    const text = owner
      ? inbound.text
      // A stranger's words arrive labelled as a stranger's. The label is a courtesy to the model;
      // what actually stops them authorizing anything is the thread, checked inside the tools.
      : `${address} (not ${config.ownerName} — a number you do not know) says: ${inbound.text}`;

    const reply = await this.runtime.inbound(conversationId, text, {
      channel: inbound.channel, to: address, chatId: inbound.chatId ?? null, fromOwner: owner,
    });
    return { ok: true, conversationId, fromOwner: owner, replied: reply !== null };
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
