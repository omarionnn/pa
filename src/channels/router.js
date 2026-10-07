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
import * as outbox from "../outbox.js";
import * as parts from "../parts.js";
import * as replies from "../replies.js";
import * as reviewed from "../reviewed.js";
import { hearInto } from "../voice.js";
import { bubbleFor } from "../typing.js";
import { markRead } from "../receipts.js";
import { servesOnThisBackend } from "../backends/guard.js";
import { offerContactCard } from "../contact.js";
import { clock, config, normalizeNumber, stamp } from "../config.js";

export class Router {
  /**
   * `judge` is what reads the master's reply to an access request. Injectable for the same reason
   * the runtime's turn runner is: the bookkeeping around it has to be provable without a model.
   * Left out, it is the real judge.
   */
  /**
   * `timers` is injectable for the same reason the typing bubble's are: the quiet window a message
   * waits in is real seconds, and a test about admission or access should not spend them. The
   * instant timer a test passes makes a held message run the moment it arrives, which is also what
   * `REASON_BURST_QUIET_MS=0` does in production.
   */
  constructor({ runtime, log = () => {}, judge = null, timers = { set: setTimeout, clear: clearTimeout }, hear = hearInto } = {}) {
    this.runtime = runtime;
    /** Turns a held message's voice notes into the words in them. Injected so tests need no model. */
    this.hear = hear;
    this.log = log;
    this.judge = judge;
    this.timers = timers;
    this.channels = new Map();
    /** Conversations with a request already waiting out the window. The second text of a burst
     *  joins that wait rather than starting its own, so one burst is one turn. The request stays
     *  in here until the conversation holds nothing, so a text that lands mid-turn is its too. */
    this.waiting = new Set();
    /** The "…" bubble for each conversation, which has to outlive the wait AND the turn. */
    this.bubbles = new Map();
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
          // sendNow, not the outbox: a courtesy line to somebody Reason is not answering is not a
          // promise it made, and a failed one is already logged. Nothing is owed.
          await this.sendNow({ channel: inbound.channel, to: address, text: accounts.stoppedLine(admitted.reason), chatId: inbound.chatId ?? null }).catch(() => {});
        }
        return { ok: true, admitted: false, stopped: admitted.reason, conversationId: null };
      }
      // Nobody Reason knows. Ask the master.
      return await this.#askForAccess(inbound, address);
    }
    const { conversationId, isOperator } = admitted;

    // Somebody Reason works for who has never been sent its contact card: a pre-approved number's
    // first text, or an account from before the card existed whose startup send did not go. Once,
    // and off the turn's path — a card is a nicety, and nothing about it may delay an answer.
    void this.#offerCard(conversationId);

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
      await this.sendNow({ channel: inbound.channel, to: address, text: serve.line, chatId: inbound.chatId ?? null })
        .catch(() => {});
      return { ok: true, conversationId, served: false, why: serve.reason };
    }

    // Claimed before anything else runs: a retry has to stop here, not after the reply.
    // What they said goes on the row with the handle, so a later reply can be pinned under this
    // message by quoting it. Their own words only — never a description Reason wrote.
    if (!db.claimInbound({ channel: inbound.channel, externalId: inbound.externalId, conversationId, text: inbound.said ?? inbound.text ?? null })) {
      this.log({ inbound: inbound.externalId, duplicate: true });
      return { ok: true, duplicate: true, conversationId };
    }

    db.upsertThread({
      conversationId, channel: inbound.channel, address,
      chatId: inbound.chatId ?? null, isOwner: true,
      // Kept for the turn that is about to run: a tapback needs the handle of the message it is
      // reacting to, and an effect needs to know this is an iMessage thread.
      //
      // The BASE handle, not this part's. A tapback goes on the message, and api-v2/reactions is
      // firm that an attachment-specific handle returns 422 — so a text-plus-photo message, which
      // arrives as `H`, `H_1`, `H_2`, must leave `H` here however many parts landed after it.
      // Pointing at `H_2` would 422 on every single one, which reads as "tapbacks are broken"
      // rather than as the one wrong field it is. The one reader of this column is src/tapbacks.js.
      service: inbound.service ?? null,
      lastInboundId: inbound.baseHandle ?? inbound.externalId ?? null,
    });

    // Parts of one message are one message. Written down first — including the ones about to be
    // dropped, because a part arriving out of order has to be readable against whatever is on
    // record — and then judged. A dropped part is not marked read, does not count against the
    // day's turns, and is never mentioned to anybody: as far as the person is concerned their
    // phone sent one message, and it got one answer.
    parts.remember({ channel: inbound.channel, inbound, conversationId });
    const part = parts.classify({ channel: inbound.channel, inbound });
    if (part.drop) {
      // Written down anyway, as dropped, with the reason. Deciding a picture is a link card's
      // preview is an honest guess (src/parts.js), and a photo wrongly eaten should leave a row
      // rather than nothing at all.
      reviewed.record({ channel: inbound.channel, inbound, conversationId, dropped: part.why });
      this.log({ inbound: inbound.externalId, dropped_part: part.why });
      return { ok: true, conversationId, dropped: part.why, replied: false };
    }

    // One row per thing on this message that was not words — every photo, voice note, file and
    // link — before anything has processed any of it. Each attachment comes back with its row id
    // on it, which is how whatever looks at or listens to it says what it got (src/reviewed.js).
    const attachments = reviewed.record({ channel: inbound.channel, inbound, conversationId });

    // "Read", now that the message has really been taken. Deliberately here and not earlier: after
    // the sender is admitted and after the event id is claimed, so a retried delivery does not mark
    // the same thing read twice and nothing Reason is never going to answer is marked read at all.
    // Marking something read and then ignoring it would be worse than silence.
    await markRead({ channel: this.get(inbound.channel), to: address, log: this.log });

    // Their own day's worth of turns. The operator pays for all of them, so the limit is real and
    // it is counted in the database; past it Reason says so instead of going quiet.
    const cap = accounts.withinCap(conversationId, "turn");
    if (!cap.ok) {
      this.log({ inbound: inbound.externalId, capped: conversationId, used: cap.used, limit: cap.limit });
      // Durable: this is the one message that explains Reason's silence for the rest of the day, so
      // losing it means looking broken rather than capped.
      await this.send({
        channel: inbound.channel, to: address, chatId: inbound.chatId ?? null,
        conversationId, toOwner: true,
        text: `that's me done for today — i've hit my limit of ${cap.limit} messages. i'll pick this back up tomorrow.`,
      }).catch(() => {});
      return { ok: true, conversationId, capped: true, replied: false };
    }
    // Held, not answered yet: two texts sent seconds apart are one thought, so this waits a moment
    // to see whether the rest of it is coming. It is a ROW before it is a wait, so a process that
    // dies inside somebody's window loses nothing — the next one's sweep finds it past its ready
    // time. The day's turns are counted when the turn actually runs, because a burst is one turn.
    // Sent as an inline reply under an earlier message: which one is most of what it means, so the
    // turn is told. Resolved here, against this conversation only, and after the claim — so a
    // handle from anybody else's thread finds nothing and a retried delivery is not read twice.
    const under = inbound.replyTo ? replies.inboundReplyLine(conversationId, inbound.replyTo) : "";
    const window = db.holdInbound({
      conversationId, channel: inbound.channel, address, chatId: inbound.chatId ?? null,
      externalId: inbound.externalId, text: under ? `${under}\n${inbound.text}` : inbound.text,
      attachments, service: inbound.service ?? null, isOperator,
      quietMs: Math.max(0, config.burstQuietMs), maxMs: Math.max(0, config.burstMaxMs),
    });

    // The "…" bubble, for the wait AND the turn. It goes up here rather than at the turn, because
    // the whole point of the wait is that somebody is mid-thought and should see that Reason is
    // there. Everything about it is best-effort and nothing in it can throw, so the worst case is
    // no bubble — never a slower reply. The drain takes it down, AFTER the reply has gone.
    const bubble = this.#bubble(conversationId, {
      channel: inbound.channel, address, chatId: inbound.chatId ?? null, service: inbound.service ?? null,
    });
    await bubble.start();

    // Somebody is already waiting out this conversation's window; this message just joined their
    // turn. Answering the webhook now is the right thing anyway: the provider wants a 2xx, not a
    // turn.
    if (this.waiting.has(conversationId)) {
      this.log({ inbound: inbound.externalId, joined_burst: conversationId, held: window.held });
      return { ok: true, conversationId, fromOwner: true, isOperator, held: window.held, joined: true };
    }

    this.waiting.add(conversationId);
    try {
      // Round and round until nothing is held. A text that lands while a turn is running joined
      // this wait (above) but not that turn — the drain had already taken its rows — so when the
      // turn ends this is the one place that knows it is there. Left to the sweep it would sit for
      // up to a sweep interval after an answer that plainly was not to it. The check and the
      // `finally` have no await between them, so nothing can be held in the gap and missed.
      let mine = null;
      for (let round = 0; ; round++) {
        // Re-read the window each time round rather than sleeping once: a text that arrives while
        // this is waiting pushes ready_at forward, and the point is to wait for the whole thought.
        // The newly held texts get the same quiet window and the same hard cap as any others.
        let held = true;
        for (;;) {
          const readyAt = db.pendingReadyAt(conversationId);
          if (readyAt === null) {
            // Nothing (more) held — or drained by the sweep while this was asleep. Nothing owed
            // and nothing lost.
            held = false;
            break;
          }
          const wait = readyAt - clock.now();
          if (wait <= 0) break;
          if (round > 0) await this.#bubbleForHeld(conversationId);
          await this.#after(wait);
        }
        if (!held) break;
        if (round === 0) {
          mine = await this.drain(conversationId);
          continue;
        }
        // A turn for what landed mid-turn. This request's own answer has already gone, so a
        // failure here is logged the way the sweep logs one rather than thrown at the provider.
        try {
          const again = await this.drain(conversationId);
          if (again) this.log({ drained_again: conversationId, messages: again.messages, round });
        } catch (e) {
          this.log({ drain_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
        }
      }
      return mine ?? { ok: true, conversationId, fromOwner: true, isOperator, joined: true };
    } finally {
      this.waiting.delete(conversationId);
    }
  }

  /**
   * Run one turn on everything a conversation is holding, in the order it arrived.
   *
   * Called two ways and the same either way: by the request that waited out the window — again for
   * anything that landed while its turn was running — and by the sweep, which is what picks up
   * messages held by a process that has since stopped. Returns null
   * when there was nothing held — which is how two overlapping drains come to only one turn.
   */
  async drain(conversationId) {
    const held = db.takePendingInbound(conversationId);
    if (!held.length) return null;
    const last = held[held.length - 1];
    const bubble = this.#bubble(conversationId, {
      channel: last.channel, address: last.address, chatId: last.chat_id ?? null, service: last.service ?? null,
    });
    await bubble.start();

    // One turn, so one turn off the day's allowance, however many texts it was.
    accounts.countUse(conversationId, "turn");
    if (held.length > 1) this.log({ burst: conversationId, messages: held.length, spanned_ms: last.arrived_at - held[0].arrived_at });

    let reply;
    try {
      // A voice note is listened to here, with the bubble already up, so the turn reads what was
      // said rather than a line saying sound arrived. Never allowed to cost the turn: if listening
      // breaks, the message goes in as it was, which already says it could not be heard.
      const texts = [];
      for (const h of held) {
        let t = h.text;
        try { t = await this.hear(h.text, h.attachments ?? [], { log: this.log, cover: reviewed.cover }); }
        catch (e) { this.log({ hear_failed: h.external_id, why: (e?.message ?? String(e)).split("\n")[0] }); }
        texts.push(t);
      }
      // Which text the reply answers, for a thread that can carry an inline reply: if the thread
      // has moved on by the time the reply is ready, it is pinned under this one (replies.js).
      const canPin = !!this.get(last.channel)?.inlineReplies && (!last.service || /^imessage$/i.test(last.service));
      const said = texts.filter(Boolean);
      const several = canPin ? replies.burstLine(said.length) : "";
      reply = await this.runtime.inbound(conversationId, [several, ...said].filter(Boolean).join("\n"), {
        channel: last.channel, to: last.address, chatId: last.chat_id ?? null,
        fromOwner: true, isOperator: !!last.is_operator,
        ...(canPin ? { answering: { handle: last.external_id, texts: said.length } } : {}),
        // Every picture in the burst, in the order it arrived, so a photo sent with a caption
        // reaches the model alongside the caption rather than as a sentence about a file.
        attachments: held.flatMap(h => h.attachments ?? []),
      });
    } finally {
      await bubble.stop();
      this.bubbles.delete(conversationId);
    }
    return {
      ok: true, conversationId, fromOwner: true, isOperator: !!last.is_operator,
      messages: held.length, replied: reply !== null,
    };
  }

  /**
   * Every conversation whose window has elapsed. The sweep's half of the bargain: without this, a
   * message held when the process stopped would sit in the table forever.
   */
  async drainDue(now = clock.now()) {
    const out = { conversations: 0, turns: 0 };
    for (const conversationId of db.dueConversations(now)) {
      if (this.waiting.has(conversationId)) continue; // somebody is already on it
      out.conversations++;
      let r;
      try {
        r = await this.drain(conversationId);
      } catch (e) {
        this.log({ drain_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
        continue;
      }
      if (r) out.turns++;
    }
    return out;
  }

  /** One bubble per conversation, reused so the wait and the turn are one bubble and not two. */
  #bubble(conversationId, { channel, address, chatId, service }) {
    const live = this.bubbles.get(conversationId);
    if (live && !live.done) return live;
    const b = bubbleFor({
      channel: this.get(channel), to: address, chatId, service, log: this.log,
    });
    this.bubbles.set(conversationId, b);
    return b;
  }

  /**
   * The bubble for texts that are held with no turn running: the ones that landed mid-turn, whose
   * bubble came down with that turn's reply, and whose own quiet window has not elapsed yet.
   */
  async #bubbleForHeld(conversationId) {
    const last = db.lastPendingInbound(conversationId);
    if (!last) return;
    await this.#bubble(conversationId, {
      channel: last.channel, address: last.address, chatId: last.chat_id ?? null, service: last.service ?? null,
    }).start();
  }

  /** Wait, on the injected timer, so a test does not spend real seconds on a quiet window. */
  #after(ms) {
    return new Promise(resolve => {
      const t = this.timers.set(resolve, ms);
      t?.unref?.();
    });
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
      // A number with no account has no conversation to owe a message to, so this is sendNow.
      await this.sendNow({ channel: inbound.channel, to: address, text: seen.toThem, chatId: inbound.chatId ?? null }).catch(() => {});
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
   * A number left on the website's form. Joins the same queue a first text does, and the master is
   * asked the same way. Nothing is sent to the number itself.
   *
   * `ok: false, reason: "not_ready"` means there is no channel a text could go out on — no line to
   * ask the master over, and no line to answer the person on if the master said yes — so the form
   * is told it did not go through rather than being told something that is not going to happen.
   */
  async webAccess({ address }) {
    const master = db.getAccount(config.ownerConversation);
    const isLive = (name) => name && name !== "console" && this.get(name)?.status?.().status === "live";
    const channel = isLive(master?.channel)
      ? master.channel
      : this.statuses().find(s => s.status === "live" && s.name !== "console")?.name ?? null;
    if (!channel) return { ok: false, reason: "not_ready" };

    const seen = access.handleWebRequest({ channel, address });
    if (!seen.ok || seen.outcome !== "queued") {
      this.log({ web_access: seen.ok ? seen.outcome : seen.reason });
      return seen;
    }

    const masterId = config.ownerConversation;
    const ask = access.askMaster({ request: seen.request, masterConversationId: masterId, messages: db.loadConversation(masterId) });
    if (ask.asked) {
      const r = await this.tellMaster(ask.toMaster, channel);
      if (!r.ok) this.log({ could_not_ask_master: r.error });
      this.log({ web_access: "asked_master", request: ask.requestId, told: r.ok });
    } else {
      this.log({ web_access: "waiting", request: seen.request.id, why: ask.reason, queued: ask.waiting });
    }
    return { ok: true, outcome: "queued", asked: ask.asked, requestId: seen.request.id };
  }

  /**
   * The oldest request nobody has put to the master yet, put to them now if they may be asked.
   * Called from the sweep, so a request that arrived over a ceiling is asked about when the
   * ceiling lifts rather than left where it fell.
   */
  async askNextWaiting() {
    if (access.requestInFrontOfMaster()) return { asked: false, reason: "one_at_a_time" };
    const next = db.unannouncedRequests()[0];
    if (!next) return { asked: false, reason: "nobody_waiting" };
    const masterId = config.ownerConversation;
    const ask = access.askMaster({ request: next, masterConversationId: masterId, messages: db.loadConversation(masterId) });
    if (!ask.asked) return { asked: false, reason: ask.reason };
    const r = await this.tellMaster(ask.toMaster, next.channel);
    this.log({ asked_master_about: next.address, request: ask.requestId, told: r.ok, from: "sweep" });
    return { asked: true, requestId: ask.requestId };
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
    // Their recorded channel, but only if it is actually running here. A row that still says
    // 'linq' on an install that now runs Sendblue is not a reason to drop the message on the
    // floor — the channel the request arrived on is used instead.
    const recorded = master?.channel && master.channel !== "console" ? master.channel : null;
    const channel = (recorded && this.get(recorded)?.status?.().status === "live") ? recorded : viaChannel;
    if (!to || !channel) return { ok: false, error: `nowhere to reach ${config.ownerName}: no master number or live channel` };
    // Durable. Somebody is waiting on the master's answer, so an access question that fails to send
    // and is dropped leaves that person waiting on a question nobody was ever asked.
    return await this.send({ channel, to, text, conversationId: config.ownerConversation, toOwner: true });
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
      // Durable, and attributed to the conversation the decision created: "you're in" failing to
      // send leaves somebody who WAS let in sitting in silence thinking they were refused. If it
      // never arrives the master is told, because they are the one who said yes.
      await this.send({
        channel: req.channel, to: req.address, text: out.toThem, chatId: req.chat_id ?? null,
        conversationId: this.conversationFor({ channel: req.channel, address: req.address }), toOwner: false,
      }).catch(() => {});
    }
    // Let in: the welcome, then the card to save, so the first link they ever get can expand.
    if (out.granted && out.account) await this.#offerCard(out.account.conversation_id);
    if (out.toMaster) {
      await this.send({ channel: inbound.channel, to: address, text: out.toMaster, chatId: inbound.chatId ?? null, conversationId, toOwner: true }).catch(() => {});
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
   * Put one message out over a channel, durably.
   *
   * Durably means: it is a row in the outbox before it is an HTTP request, so a failure that could
   * work later comes back on its own and a failure that cannot gets somebody told. The return value
   * is still the FIRST attempt's result, so a caller that needs to know "has this gone, right now"
   * — `message_send` telling the model it may say it sent something — still finds out right now.
   *
   * The console is deliberately exempt. There is nothing to retry about writing to a terminal, and
   * a row per console line would make the outbox a log rather than a list of things still owed.
   *
   * This is the plumbing only — whether Reason was *allowed* to send it was settled by the
   * `message_send` tool and its gate before this is ever called.
   */
  async send({ channel, to, text, chatId = null, idempotencyKey, conversationId = null, toOwner = false, sendStyle = null, replyTo = null }) {
    const pre = this.#ready(channel);
    if (pre) return pre;
    if (channel === "console" || !conversationId) return await this.sendNow({ channel, to, text, chatId, idempotencyKey, sendStyle, replyTo });
    return await outbox.sendDurable({
      channel, router: this, conversationId, to, text, chatId, idempotencyKey, toOwner, sendStyle, replyTo, log: this.log,
    });
  }

  /** Reason's contact card to one account, once. See src/contact.js; failures are log lines. */
  async #offerCard(conversationId) {
    try {
      const account = db.getAccount(conversationId);
      if (!account || account.contact_card_sent_at) return;
      await offerContactCard({ router: this, account, log: this.log });
    } catch (e) {
      this.log({ contact_card_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  }

  /**
   * Several messages that are one answer, over a channel, durably and in order.
   *
   * What a reply with a link in it becomes: the bare URL, then the words about it. The split
   * itself is src/links.js and the ordering is src/outbox.js; this is only the route. The console
   * has no outbox, so it writes each part in turn and the ordering is the loop.
   */
  async sendParts({ channel, to, parts, chatId = null, idempotencyKey, conversationId = null, toOwner = false, replyTo = null, sendStyle = null }) {
    const pre = this.#ready(channel);
    if (pre) return pre;
    if (channel === "console" || !conversationId) {
      let last = { ok: true };
      for (const [i, text] of parts.entries()) {
        // The pin goes on the first part and the effect on the last: the answer lands under the
        // message it is about, and the animation belongs to the words rather than to a bare URL.
        last = await this.sendNow({
          channel, to, text, chatId, idempotencyKey,
          replyTo: i ? null : replyTo, sendStyle: i === parts.length - 1 ? sendStyle : null,
        });
        if (!last.ok) return last;
      }
      return last;
    }
    return await outbox.sendSequence({
      channel, router: this, conversationId, to, parts, chatId, idempotencyKey, toOwner, replyTo, sendStyle, log: this.log,
    });
  }

  /**
   * One message with text and a file over a channel, durably — same bargain as send().
   *
   * A channel that cannot do attachments says `supported: false` and the caller falls back to text
   * plus an honest line about the file, never to pretending it went. That answer is not retryable
   * and the outbox treats it accordingly.
   */
  async sendMedia({ channel, to, text, file, mimeType, filename = null, chatId = null, idempotencyKey, conversationId = null, toOwner = false }) {
    const pre = this.#ready(channel, { media: true });
    if (pre) return pre;
    if (channel === "console" || !conversationId) {
      return await this.sendNow({ channel, to, text, file, mimeType, filename, chatId, idempotencyKey });
    }
    return await outbox.sendDurable({
      channel, router: this, conversationId, to, text, chatId, idempotencyKey, toOwner, log: this.log,
      media: { file, mimeType, filename },
    });
  }

  /**
   * One message with text and a file the provider fetches by address — the contact card. Not
   * durable on purpose: it is sent once as a nicety and src/contact.js remembers whether it went;
   * a retry an hour later from the outbox would be a second card.
   */
  async sendMediaUrl({ channel, to, text = "", mediaUrl, chatId = null }) {
    const pre = this.#ready(channel, { media: true });
    if (pre) return pre;
    try {
      return await this.get(channel).sendMediaUrl({ to, text, mediaUrl, chatId });
    } catch (e) {
      return { ok: false, supported: true, retryable: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
  }

  /**
   * One attempt, right now, with no row and no retry. The outbox's hands.
   *
   * Everything that wants a message to be remembered goes through send()/sendMedia(); this is what
   * those turn into once the bookkeeping is done. It is also the honest path for the console and
   * for the handful of code-written lines that belong to no conversation.
   */
  async sendNow({ channel, to, text, chatId = null, idempotencyKey, file = null, mimeType = null, filename = null, sendStyle = null, replyTo = null }) {
    const ch = this.get(channel);
    if (!ch) return { ok: false, retryable: false, error: `No channel called '${channel}'. Registered: ${[...this.channels.keys()].join(", ") || "none"}.` };
    try {
      return file
        ? await ch.sendMedia({ to, text, file, mimeType, filename, chatId, idempotencyKey })
        // A handle only ever reaches a channel that pins. To any other it would be a field the
        // adapter has never heard of, so the message goes as an ordinary one.
        : await ch.send({ to, text, chatId, idempotencyKey, sendStyle, ...(replyTo && ch.inlineReplies ? { replyTo } : {}) });
    } catch (e) {
      // An adapter that throws rather than returning a result is a bug. Retryable, because the
      // message was probably fine and the alternative is losing it to somebody else's mistake.
      return { ok: false, retryable: true, supported: true, error: (e?.message ?? String(e)).split("\n")[0] };
    }
  }

  /** Registered and live, or the honest refusal. Null when the channel is good to go. */
  #ready(channel, { media = false } = {}) {
    const ch = this.get(channel);
    if (!ch) {
      return { ok: false, retryable: false, ...(media ? { supported: false } : {}), error: `No channel called '${channel}'. Registered: ${[...this.channels.keys()].join(", ") || "none"}.` };
    }
    const st = ch.status();
    if (st.status !== "live") {
      // Not retryable: a missing credential is not a thing that clears on its own, and a message
      // retrying for ten minutes against an unconfigured channel helps nobody.
      return {
        ok: false, retryable: false, status: "not_connected", ...(media ? { supported: true } : {}),
        error: `${channel} is not connected: this machine has no ${st.missing.join(", ") || "credentials for it"}.`,
      };
    }
    return null;
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
