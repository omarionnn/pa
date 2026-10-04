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
import * as access from "../access.js";
import * as trust from "../trust.js";
import { servesOnThisBackend } from "../backends/guard.js";
import { config, normalizeNumber, stamp } from "../config.js";

export class Router {
  /**
   * `judge` is what reads the master's reply to an access request. Injectable for the same reason
   * the runtime's turn runner is: the bookkeeping around it has to be provable without a model.
   * Left out, it is the real judge.
   */
  constructor({ runtime, log = () => {}, judge = null } = {}) {
    this.runtime = runtime;
    this.log = log;
    this.judge = judge;
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

    // Before anything else: is this somebody Reason works for? A number with no account never
    // reaches the queue and never reaches the model — its words are written down as a quote for
    // the master to read, and that is all.
    const admitted = accounts.admit({ channel: inbound.channel, address });
    if (!admitted.allow) {
      if (admitted.reason === "blocked") {
        this.log({ inbound: inbound.externalId, blocked: address });
        return { ok: true, admitted: false, blocked: true, conversationId: null };
      }
      if (admitted.reason === "paused" || admitted.reason === "removed") {
        this.log({ inbound: inbound.externalId, stopped: address, why: admitted.reason });
        if (accounts.shouldTellAgain(address)) {
          await this.send({ channel: inbound.channel, to: address, text: accounts.stoppedLine(admitted.reason), chatId: inbound.chatId ?? null }).catch(() => {});
        }
        return { ok: true, admitted: false, stopped: admitted.reason, conversationId: null };
      }
      // Nobody Reason knows. Ask the master.
      return await this.#askForAccess(inbound, address);
    }
    const { conversationId, isOperator } = admitted;

    // The master's reply might be the answer to somebody's access request. Read before their turn,
    // by the same judge the confirm gate uses, with every fact around it owned by code: a real new
    // message from the master's own number, tied to one request, single use, with an expiry.
    if (isOperator) {
      const answered = await this.#readAccessAnswer({ conversationId, inbound, address });
      // If that message WAS the answer, code has already replied to both of them. Running a model
      // turn on top would mean the master gets told twice, in two voices, about one decision.
      if (answered?.decided) {
        return { ok: true, conversationId, isOperator: true, access: answered.granted ? "granted" : "declined", replied: true };
      }
    }


    // Which backend is running decides who can actually be served. On the operator's subscription
    // only their own test numbers get answers — everybody else gets one line and no model turn,
    // because every turn there is spent out of one person's personal plan. On the API backend this
    // passes everybody: that is what a key with credit buys.
    const serve = servesOnThisBackend(address);
    if (!serve.serves) {
      this.log({ inbound: inbound.externalId, not_served: address, why: serve.reason });
      await this.send({ channel: inbound.channel, to: address, text: serve.line, chatId: inbound.chatId ?? null })
        .catch(() => {});
      return { ok: true, conversationId, served: false, why: serve.reason };
    }

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
   * An unknown number: one line to them, and the master asked whether to let them in.
   *
   * No model turn is spent anywhere in here. Their message becomes a quote in a row, and the line
   * that goes back to them is written in code.
   */
  async #askForAccess(inbound, address) {
    const seen = access.handleUnknown({
      channel: inbound.channel, address,
      displayName: inbound.displayName ?? "",
      text: inbound.text, chatId: inbound.chatId ?? null,
    });

    if (seen.action === "ignore") {
      this.log({ inbound: inbound.externalId, no_account: address, why: seen.reason });
      return { ok: true, admitted: false, asked: false, why: seen.reason, conversationId: null };
    }
    if (seen.toThem) {
      await this.send({ channel: inbound.channel, to: address, text: seen.toThem, chatId: inbound.chatId ?? null }).catch(() => {});
    }
    if (seen.action !== "ask_master") {
      return { ok: true, admitted: false, asked: false, why: seen.reason, conversationId: null };
    }

    // Put it to the master, unless something is already in front of them or the hourly ceiling is
    // reached — in which case it simply waits, and is asked about after the current one.
    const masterId = config.ownerConversation;
    const ask = access.askMaster({
      request: seen.request,
      masterConversationId: masterId,
      messages: db.loadConversation(masterId),
    });
    if (ask.asked) {
      const r = await this.tellMaster(ask.toMaster, inbound.channel);
      if (!r.ok) this.log({ could_not_ask_master: r.error });
      this.log({ asked_master_about: address, request: ask.requestId, told: r.ok });
    } else {
      this.log({ request_waiting: seen.requestId, why: ask.reason, queued: ask.waiting });
    }
    return { ok: true, admitted: false, asked: ask.asked, requestId: seen.requestId, conversationId: null };
  }

  /**
   * Get a message to the master, wherever they are.
   *
   * Their own account says which channel and number; a console-only install has neither, so the
   * channel the request arrived on is the fallback. Returns the result rather than throwing,
   * because "the master could not be reached" is something to log, not something to crash on.
   */
  async tellMaster(text, viaChannel = null) {
    const master = db.getAccount(config.ownerConversation);
    const to = master?.address && master.address !== "console" ? master.address : config.masterNumbers[0];
    // Their recorded channel, but only if it is actually running here. A row that says 'linq' on
    // an install with no Linq is not a reason to drop the message on the floor.
    const recorded = master?.channel && master.channel !== "console" ? master.channel : null;
    const channel = (recorded && this.get(recorded)?.status?.().status === "live") ? recorded : viaChannel;
    if (!to || !channel) return { ok: false, error: `nowhere to reach ${config.ownerName}: no master number or live channel` };
    return await this.send({ channel, to, text });
  }

  /** Was the master's message an answer to the request in front of them? */
  async #readAccessAnswer({ conversationId, inbound, address }) {
    const before = access.requestInFrontOfMaster();
    if (!before) return null;

    // The judge reads the master's own latest message out of their real history, with this
    // message appended — the same messages their turn is about to see.
    const messages = [
      ...db.loadConversation(conversationId),
      { role: "user", content: `[${stamp()}] ${config.ownerName}: ${inbound.text}` },
    ];
    let out;
    try {
      out = await access.readMasterReply({ messages, masterConversationId: conversationId, ...(this.judge ? { judge: this.judge } : {}) });
    } catch (e) {
      // The judge being unreachable must not swallow the master's message. Nothing is granted,
      // nothing is refused, and their turn runs as normal.
      this.log({ access_answer_failed: e?.message });
      return null;
    }
    if (!out.decided) {
      this.log({ access_undecided: out.requestId, why: out.reason });
      return out;
    }

    const req = db.getAccessRequest(out.requestId);
    trust.ledgerWrite({
      conversationId, action: out.granted ? "access_grant" : "access_decline",
      input: { number: req.address, name: req.display_name || undefined },
      out: { ok: true, number: req.address, quote: out.quote },
      target: req.address, confirmationId: req.confirmation_id,
    });

    if (out.toThem) {
      await this.send({ channel: req.channel, to: req.address, text: out.toThem, chatId: req.chat_id ?? null }).catch(() => {});
    }
    if (out.toMaster) {
      await this.send({ channel: inbound.channel, to: address, text: out.toMaster, chatId: inbound.chatId ?? null }).catch(() => {});
    }
    this.log({ access: out.granted ? "granted" : "declined", number: req.address });

    // Whatever is next in the queue goes in front of the master now.
    const next = db.unannouncedRequests()[0];
    if (next) {
      const ask = access.askMaster({ request: next, masterConversationId: conversationId, messages: db.loadConversation(conversationId) });
      if (ask.asked) await this.tellMaster(ask.toMaster, inbound.channel);
    }
    return out;
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
