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
import * as invites from "../invites.js";
import * as events from "../events.js";
import * as trust from "../trust.js";
import * as outbox from "../outbox.js";
import * as parts from "../parts.js";
import * as replies from "../replies.js";
import * as reviewed from "../reviewed.js";
import { hearInto } from "../voice.js";
import { readContactsInto } from "../contacts.js";
import { bubbleFor } from "../typing.js";
import { markRead } from "../receipts.js";
import { servesOnThisBackend } from "../backends/guard.js";
import { offerContactCard } from "../contact.js";
import { tellNewLine, isReturning, LINE_CHANGE_CHANNEL } from "../linechange.js";
import { clock, config, normalizeNumber, stamp } from "../config.js";
import { OutageError, downLine, leftWhileDownLine } from "../down.js";
import * as onethought from "../onethought.js";
import { withoutNoReply } from "../plain.js";
import { effectPartIndex } from "../links.js";
import * as web from "../web.js";
import { webReplyAllowedFor } from "../dailyflag.js";
import * as choices from "../choicecards.js";
import { previousAssistant as previousAssistantLine } from "../purchasesnote.js";
import * as onboarding from "../onboarding.js";
import * as websetup from "../websetup.js";
import * as plan from "../plan.js";
import * as opsDigest from "../opsdigest.js";
import * as webhookAlert from "../webhookalert.js";

/** What somebody whose event code did not work is told, by why. */
const EVENT_CLAIM_LINES = {
  used: "that event code has already been used. open the event link again to get a fresh one.",
  expired: "that event code has expired. open the event link again to get a fresh one.",
  password_changed: "the organizer changed the event's password since you got that code. open the event link again and use the new password.",
  paused: "joining that event is paused right now. try again later.",
  cancelled: "that event was cancelled by its organizer.",
  full: "that event is full — it filled up before your join went through. if a spot opens up, the same link and password will work.",
  removed: "the organizer took you off that event, so you can't rejoin it.",
  organizer: "you're organizing that one — nothing to join.",
  not_found: "that event code didn't work. open the event link again to get a fresh one.",
};
/** The card line a new guest gets, after the welcome. */
export const EVENT_CARD_LINE = "save me as Reason so you can find me for event updates — and anything else you need.";

/**
 * How long a message on this channel waits for the rest of its thought before its turn starts
 * (config.burstQuietMs). A Web message arrives whole, so it waits the shorter Web window — never
 * longer than the text one, so the switch that turns holding off (`REASON_BURST_QUIET_MS=0`) still
 * turns it off everywhere, and a test that widens the window to hold everything holds Web too.
 */
export function quietWindowFor(channel) {
  return channel === web.WEB ? Math.min(config.burstQuietWebMs, config.burstQuietMs) : config.burstQuietMs;
}

/** A folded photo, in words: what they wrote with it, and which photo it is. */
export function photoWords(text, photos) {
  const which = photos.map(id => `[they sent a photo, #${id}: photo_look ${id} puts it in front of you]`).join(" ");
  return [String(text ?? "").trim(), which].filter(Boolean).join(" ");
}

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
  constructor({ runtime, log = () => {}, judge = null, timers = { set: setTimeout, clear: clearTimeout }, hear = hearInto, readContacts = readContactsInto, onboard = {} } = {}) {
    this.runtime = runtime;
    /** The first-chat onboarding's seams (src/onboarding.js handle): `ask` reads their text, `sleep`
     *  is the beat between bubbles. Injected so tests need no model and spend no seconds. */
    this.onboard = onboard;
    /** Turns a held message's voice notes into the words in them. Injected so tests need no model. */
    this.hear = hear;
    /** Turns a held message's contact cards into the info in them. Injected so tests need no model. */
    this.readContacts = readContacts;
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
    // §4h take it back: Web messages claimed and not yet held, `<external id>` → when claimed.
    this.preHold = new Map();
    /** One promise per drain in flight, so shutdown can wait for them. See `idle`. */
    this.draining = new Set();
    /** The new-number card on its way to somebody, so a second text of theirs waits for it. */
    this.lineCards = new Map();
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
   * A web message, resolved to the person it belongs to — or refused.
   *
   * Web is a route to a conversation that already exists, never a conversation of its own
   * (docs/plans/reason-web-phase1.md §3): `conversationIdFor` would mint `dm:web:…`, a second Reason
   * with no memory, so it is not asked. The conversation comes on the inbound as `conversationId`,
   * put there by server code from the browser's session — never from anything the client sent; a
   * `from` on a web inbound is ignored. From it the ACCOUNT gives the real channel and address, and
   * admission runs against those, so a paused or removed person is as signed out on web as they are
   * on their phone. Refused outright, before admission, when the switch is off or does not cover
   * this person: with REASON_WEB off a web message is a thing that cannot happen, and this is the
   * one place that makes it so.
   *
   * Returns `{ address, channel }` to admit with, or `{ refused }`.
   */
  #webSender(inbound) {
    if (!web.webOn()) return { refused: "web_off" };
    const conversationId = String(inbound.conversationId ?? "").trim();
    if (!conversationId) return { refused: "no_session" };
    const account = db.getAccount(conversationId);
    if (!account) return { refused: "no_account" };
    if (!web.webAllowedFor(conversationId)) return { refused: "web_not_for_them" };
    return { conversationId, address: account.address, channel: account.channel };
  }

  /**
   * One inbound message → at most one turn. Returns what happened, which is what the webhook
   * route answers the provider with.
   */
  async deliver(inbound) {
    let address = normalizeNumber(inbound.from) || String(inbound.from ?? "").trim();
    // Whose Reason admission is asked about. For a text that is the line it arrived on; for a web
    // message it is the account's own channel and number, because web has neither.
    let admitAs = inbound.channel;
    if (inbound.channel === web.WEB) {
      const sender = this.#webSender(inbound);
      if (sender.refused) {
        this.log({ inbound: inbound.externalId, web_refused: sender.refused });
        return { ok: false, refused: sender.refused, conversationId: null };
      }
      address = sender.address;
      admitAs = sender.channel;
      // A web message's id is the browser's own (a UUID it made up), where a provider's handle is
      // unique across everybody. The dedupe is UNIQUE(channel, external_id) over all conversations,
      // so one person's id must never be able to swallow another's message as a "duplicate": it is
      // put under their conversation here, once, before anything reads it.
      inbound = { ...inbound, conversationId: sender.conversationId, externalId: `${sender.conversationId}:${String(inbound.externalId ?? "").trim()}` };
    }

    // Before anything else: is this somebody Reason works for? A number with no account never
    // reaches the queue and never reaches the model — its words are written down as a quote for
    // the master to read, and that is all.
    const admitted = accounts.admit({ channel: admitAs, address });
    // Did THIS text just make their account, by itself — auto-admit, or a pre-approved number's
    // first text, or an invite claim (after the inviter's welcome line)? Those are the people the
    // first-chat onboarding starts for here (src/onboarding.js); an event join starts it from
    // #claimEvent, after the organizer's welcome. The master's yes sent "you're in".
    let arrivedNow = inbound.channel !== web.WEB && admitted.allow && admitted.created && !admitted.isOperator;
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
      // Nobody Reason knows — but they may be holding an invite. A text carrying a live invite's
      // code is the phone proving itself and the claim in one (src/invites.js): the invite is spent
      // and the account made in one transaction, and their turn runs like anybody's. A spent or
      // canceled code is told so, and nothing else happens on that message.
      // Or an event's: the code the event page put in their text. The same proof — only that phone
      // can send it — and the event join is its own way in, separate from invites (src/pages/event.js).
      const joined = await this.#claimEvent(inbound, address, null);
      if (joined) return joined;
      const claim = await this.#claimInvite(inbound, address);
      if (claim && !claim.joined) return claim.result;
      // Otherwise: auto-admit if configured, or ask the master.
      const accessResult = claim?.joined ? { autoAdmitted: true } : await this.#askForAccess(inbound, address);
      if (accessResult?.autoAdmitted) {
        // They were admitted on the spot — fall through to run a normal turn with their message.
        // With REASON_ONBOARDING covering them, the first-chat onboarding answers it instead
        // (src/onboarding.js) — an invite's joiner too, right after the inviter's welcome line;
        // otherwise the model's prompt asks their name once and offers one thing to try.
        arrivedNow = inbound.channel !== web.WEB;
      } else {
        return accessResult;
      }
    }
    // Re-read after a possible auto-admit created the account.
    const readmitted = admitted.allow ? admitted : accounts.admit({ channel: admitAs, address });
    const { conversationId, isOperator } = readmitted;
    // A web message is answered to the conversation its session named and no other. `admit` built
    // the id from the account's channel and number, so for the same account that is the same id —
    // checked all the same, because the alternative is one person's words landing in another's
    // Reason on a bookkeeping slip, and nothing below would notice.
    if (inbound.channel === web.WEB && conversationId !== inbound.conversationId) {
      this.log({ inbound: inbound.externalId, web_refused: "conversation_mismatch" });
      return { ok: false, refused: "conversation_mismatch", conversationId: null };
    }

    // No contact card here, before the turn (11-09). This used to send it to anybody without one, on
    // any text, off the turn's path — and its "not auto-admitted" check read a field accounts.admit
    // never sets. So a brand-new stranger's FIRST text from Reason was "one more thing — save me as
    // a contact", with no hello before it, and a nameless person's next text got it ahead of the
    // answer too. The card goes after a turn's reply instead, once they have a name
    // (#offerCardIfNamed, below the turn); the master's yes sends it after "you're in"; the startup
    // pass reaches accounts from before the card existed. Somebody in the first-chat onboarding gets
    // the card from it, after their name, with its own line.
    const onboardingNow = arrivedNow && !isOperator && onboarding.begin(conversationId);
    if (onboardingNow) this.log({ inbound: inbound.externalId, onboarding_started: conversationId });
    // Their first text, typed for them by the web setup (src/websetup.js, REASON_WEB_SETUP), carries
    // its code: what they chose and connected on the page becomes theirs, and the intro asks none of
    // it again (src/onboarding.js webHandoff). No code, or one that does not match: nothing changes.
    if (arrivedNow && !isOperator) {
      try { websetup.claimFromText({ conversationId, text: inbound.text ?? "", log: this.log }); }
      catch (e) { this.log({ websetup_claim_failed: (e?.message ?? String(e)).split("\n")[0] }); }
    }

    // The master's reply might be the answer to somebody's access request. Read before their turn,
    // by the same judge the confirm gate uses, with every fact around it owned by code: a real new
    // message from the master's own number, tied to one request, single use, with an expiry.
    // Never from a Web-only chat (owner 10-27): those asks were put in the shared thread, and a "yes"
    // typed in a chat about something else is not an answer to them.
    if (isOperator && !(inbound.channel === web.WEB && db.webChatOf(inbound.chatId))) {
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
    if (!db.claimInbound({
      channel: inbound.channel, externalId: inbound.externalId, conversationId, text: inbound.said ?? inbound.text ?? null,
      // Which thread it was sent in, kept with the message so a later reply in the same thread can
      // be read against this one (db.threadMessages).
      replyTo: inbound.replyTo ?? null, threadRoot: inbound.threadRoot ?? null,
    })) {
      this.log({ inbound: inbound.externalId, duplicate: true });
      return { ok: true, duplicate: true, conversationId };
    }
    // §4h: a Web message between its claim and its hold can still be taken back (takeBack). Pruned by
    // age, so one that returned early (capped, a dropped part) does not linger.
    if (inbound.channel === web.WEB) {
      const t = clock.now();
      for (const [k, at] of this.preHold) if (t - at > 120_000) this.preHold.delete(k);
      this.preHold.set(inbound.externalId, t);
    }

    // Somebody who already has a Reason sending the code an event page gave them: the page could not
    // tell it was them (no page session on that browser), and this text is how it finds out. They
    // are joined on their own account — no signup, no onboarding — and no turn runs on the code.
    const eventJoin = await this.#claimEvent(inbound, address, conversationId);
    if (eventJoin) return eventJoin;

    // Somebody who already has a Reason texting a live invite's code — their own, or one a friend
    // sent them. It is not spent on them, and they are told so in a line rather than a turn. (The
    // text that just claimed an invite names a redeemed one, so it never stops here.)
    const heldInvite = invites.inviteInText(inbound.text);
    const memberLine = heldInvite ? invites.memberLine(heldInvite, conversationId) : null;
    if (memberLine) {
      this.log({ inbound: inbound.externalId, invite_code_from_member: heldInvite.id });
      await this.send({ channel: inbound.channel, to: address, text: memberLine, chatId: inbound.chatId ?? null, conversationId, toOwner: true }).catch(() => {});
      return { ok: true, conversationId, invite: "member", replied: true };
    }

    // Somebody who texted Reason's old number, writing to the new one for the first time: the card
    // and one line about it, once, ahead of the answer and never instead of it (src/linechange.js).
    // After the claim, so a retried delivery never gets this far.
    await this.#tellNewLine({ inbound, address, conversationId });

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
    // A location they sent is kept on the thread, so it is still known on a later turn when
    // something they ask needs it — not only on the turn it arrived with.
    if (inbound.location) db.recordSharedLocation(conversationId, inbound.location);

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
      // losing it means looking broken rather than capped. And said ONCE per day per limit: keyed
      // to the conversation, the day and the limit, so every further text past the cap finds the
      // same outbox row and nothing goes out again — otherwise N texts in are N paid lines out on
      // the shared line. A new day, or a raised limit used up, is a new key and is told.
      await this.send({
        channel: inbound.channel, to: address, chatId: inbound.chatId ?? null,
        conversationId, toOwner: true,
        idempotencyKey: `capped:${conversationId}:${accounts.today()}:${cap.limit}`,
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
    // The thread it was sent in counts for more than the parent the provider named (replies.js).
    const under = (inbound.replyTo || inbound.threadRoot)
      ? replies.inboundReplyLine(conversationId, inbound.replyTo, inbound.threadRoot, { except: inbound.externalId })
      : "";
    // Options Reason just showed (src/choicecards.js): what each number was, and which card an
    // inline reply or a tapback is on when the provider says. Empty with nothing open.
    const picking = choices.inboundChoiceLine(conversationId, { text: inbound.text, replyTo: inbound.replyTo ?? null });
    // §4h: taken back between the claim and here (takeBack). Checked with no await before the hold.
    if (inbound.channel === web.WEB) {
      this.preHold.delete(inbound.externalId);
      if (db.inboundCancelled(web.WEB, inbound.externalId)) {
        this.log({ inbound: inbound.externalId, taken_back: true });
        return { ok: true, conversationId, cancelled: true, replied: false };
      }
    }
    const window = db.holdInbound({
      conversationId, channel: inbound.channel, address, chatId: inbound.chatId ?? null,
      externalId: inbound.externalId, text: [under, picking, inbound.text].filter(Boolean).join("\n"),
      attachments, service: inbound.service ?? null, isOperator,
      quietMs: Math.max(0, quietWindowFor(inbound.channel)), maxMs: Math.max(0, config.burstMaxMs),
    });

    // The "…" bubble, for the wait AND the turn. It goes up here rather than at the turn, because
    // the whole point of the wait is that somebody is mid-thought and should see that Reason is
    // there. Everything about it is best-effort and nothing in it can throw, so the worst case is
    // no bubble — never a slower reply. The drain takes it down, AFTER the reply has gone.
    // Joined texts already waiting for the model to come back (src/down.js). No bubble and no
    // wait: there is nothing to type and nothing to run until the reset, and the sweep runs it
    // then. They were told once when the outage began.
    if (window.down) {
      this.log({ inbound: inbound.externalId, joined_outage: conversationId, until: window.readyAt, held: window.held });
      return { ok: true, conversationId, fromOwner: true, isOperator, held: window.held, joined: true, down: true, until: window.readyAt };
    }

    const bubble = this.#bubble(conversationId, {
      channel: inbound.channel, address, chatId: inbound.chatId ?? null, service: inbound.service ?? null,
    });
    await bubble.start();

    // A request is already being worked on for them. This text is read before anything is done
    // with it: one that adds to that request is folded into the turn working on it, instead of
    // getting a turn and a second answer of its own (src/onethought.js). Not awaited — the webhook
    // is answered now and the read runs alongside the turn, which waits for it before it sends.
    // Never read into a turn for another chat (a Web-only chat and the shared thread are two talks).
    const working = onethought.activeFor(conversationId);
    if (working && (working.webChat ?? null) === (inbound.channel === web.WEB ? db.webChatOf(inbound.chatId) : null)) onethought.track(working, this.#readMidTurn(conversationId, working, { externalId: inbound.externalId, text: under ? `${under}\n${inbound.text}` : inbound.text }));

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
          // The model is down and the texts are back in the table for the reset. Nothing to
          // wait for here: holding the request open for hours would only tie up the webhook.
          if (mine?.down) break;
          continue;
        }
        // A turn for what landed mid-turn. This request's own answer has already gone, so a
        // failure here is logged the way the sweep logs one rather than thrown at the provider.
        try {
          const again = await this.drain(conversationId);
          if (again) this.log({ drained_again: conversationId, messages: again.messages, round });
          if (again?.down) break;
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
   * Read one text that landed while a request was being worked on, and fold it into that turn when
   * it adds to it (src/onethought.js). A new request or chat is left where it is, held, and gets its
   * own turn the moment this one ends — the ordinary path. So does any text the harm screen does
   * not pass as clear: its own turn screens it and does what that verdict needs. Never throws.
   */
  async #readMidTurn(conversationId, working, { externalId, text }) {
    try {
      // Words and photos. A voice note, a file or a contact card mid-turn keeps its own turn, where
      // it is heard or read like any other — the fold hands the turn words, so folding one would lose
      // what was in it. A link is words. A photo is folded by its media id and rides, as the picture
      // itself, on the turn's next tool result (calls 66/67, 2026-11-01: a second photo seconds
      // after the first got its own turn, and that turn rang the same phone a second time).
      // This message's own row, by its handle: the newest held row may already be a later one.
      const row = db.pendingByHandle(conversationId, externalId);
      const atts = row ? (() => { try { return JSON.parse(row.attachments || "[]"); } catch { return []; } })() : [];
      const isPhoto = (a) => a?.kind === "image" && Number.isInteger(a?.media_id);
      if (atts.some(a => a?.kind !== "link" && !isPhoto(a))) {
        this.log({ midturn: "left", inbound: externalId, conversation: conversationId, why: "attachments" });
        return { left: "attachments" };
      }
      const photos = atts.filter(isPhoto).map(a => a.media_id);
      if (photos.length && !String(text ?? "").trim()) {
        // A bare photo has no words to read or screen: it goes with what is being worked on.
        if (working.ended || working.closing) return { left: "turn_ended" };
        const taken = db.takePendingByHandle(conversationId, externalId);
        if (!taken) return { left: "already_taken" };
        onethought.fold(working, { handle: externalId, text: photoWords("", photos), photos, row: taken });
        const requestId = onethought.activeRequestId(working);
        if (requestId) db.linkRequestMessage(conversationId, requestId, externalId, "continuation");
        this.log({ folded: externalId, into: requestId, conversation: conversationId, photos: photos.length });
        return { folded: true };
      }
      // The thread this turn is in: a Web-only chat's own (fold.webChat), or the shared one.
      const thread = db.loadConversation(working.webChat ? db.historyKeyFor(conversationId, db.webChatRoute(working.webChat)) : conversationId);
      // One budget for the whole read, inside what the send waits for (onethought.READ_BUDGET_MS):
      // past it the text is left held and gets its own turn, never folded after the reply has gone.
      let timer;
      const outOfTime = new Promise(r => { timer = setTimeout(() => r(null), onethought.READ_BUDGET_MS); });
      const read = Promise.all([
        onethought.classify({ request: onethought.requestText(working), text, previous: previousAssistantLine(thread) }),
        Promise.resolve().then(() => this.runtime.screen?.({ text, messages: thread, who: accounts.ownerOf(conversationId).name || "them" }))
          .catch(e => ({ verdict: "unscreened", error: e?.message })),
      ]);
      const both = await Promise.race([read, outOfTime]).finally(() => clearTimeout(timer));
      if (!both) {
        this.log({ midturn: "left", inbound: externalId, conversation: conversationId, why: "out_of_time" });
        return { left: "out_of_time" };
      }
      const [verdict, screen] = both;
      const screenVerdict = screen?.verdict ?? "clear";
      this.log({ midturn: verdict.kind, inbound: externalId, conversation: conversationId, via: verdict.via, ms: verdict.ms, ...(verdict.why ? { why: verdict.why } : {}), ...(screenVerdict !== "clear" ? { screen: screenVerdict } : {}) });
      if (verdict.kind === "new" || verdict.kind === "chat") return { left: verdict.kind };
      if (screenVerdict !== "clear") return { left: "screen" };
      if (working.ended || working.closing) return { left: "turn_ended" };
      const taken = db.takePendingByHandle(conversationId, externalId);
      // A drain got there first (the turn had already ended and the next one took it): nothing to do.
      if (!taken) return { left: "already_taken" };
      onethought.fold(working, { handle: externalId, text: photos.length ? photoWords(text, photos) : text, photos, unclear: verdict.kind === "unclear", row: taken });
      const requestId = onethought.activeRequestId(working);
      if (requestId) {
        db.linkRequestMessage(conversationId, requestId, externalId, "continuation");
        db.extendRequestText(conversationId, requestId, String(text).slice(0, 300));
      }
      this.log({ folded: externalId, into: requestId, conversation: conversationId, unclear: verdict.kind === "unclear" });
      return { folded: true };
    } catch (e) {
      this.log({ midturn_failed: (e?.message ?? String(e)).split("\n")[0], conversation: conversationId });
      return { left: "error" };
    }
  }

  /**
   * Reason Web §4h "take it back": the person takes one Web message back before its turn starts.
   * `id` is the browser's own id for it, put under the conversation exactly as `deliver` puts it, so
   * nobody can name another person's message. The send is never held for this: the message waits
   * only the ordinary burst window, and whichever comes first — this, or the turn taking the held
   * rows — wins outright (db.cancelHeldInbound). With nothing left held and no turn running, the
   * "working on it" bubble the hold put up comes down.
   */
  takeBack({ conversationId, id, inFlight = false }) {
    const externalId = `${conversationId}:${String(id ?? "").trim()}`;
    let out = db.cancelHeldInbound({ conversationId, channel: web.WEB, externalId, inFlight });
    // Claimed but not held yet (deliver is between its claim and holdInbound, awaiting a read receipt,
    // say): no turn can have it, so it is taken back here and deliver drops it before the hold. Both
    // sides are synchronous at that point, so this and the hold cannot both happen.
    if (!out.ok && out.why === "started" && this.preHold.has(externalId)) {
      db.markInboundCancelled(web.WEB, externalId);
      out = { ok: true, cancelled: true };
    }
    this.log({ web_take_back: out.ok ? (out.already ? "already" : out.early ? "early" : "cancelled") : out.why, conversation: conversationId });
    if (out.ok && !out.already && db.pendingReadyAt(conversationId) === null && !onethought.activeFor(conversationId)) {
      const b = this.bubbles.get(conversationId);
      if (b && !b.done) void Promise.resolve().then(() => b.stop()).catch(() => {});
    }
    return out;
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
    // Tracked so shutdown can wait for it. An interrupted drain puts its messages back AFTER its
    // turn has already failed, and that write has to land before the process goes — see `idle`.
    let done;
    const tracked = new Promise(resolve => { done = resolve; });
    this.draining.add(tracked);
    try {
      return await this.#drainHeld(conversationId);
    } finally {
      done();
      this.draining.delete(tracked);
    }
  }

  async #drainHeld(conversationId) {
    const held = db.takePendingInbound(conversationId);
    if (!held.length) return null;
    const last = held[held.length - 1];
    // Web messages held when the switch was turned off (a restart with REASON_WEB gone): there is
    // no channel to answer them on, so a turn would be spent and its reply dropped. They go back
    // for an hour at a time instead, and are answered if the switch comes back. Nothing is lost
    // and nothing is said to a phone that did not ask.
    if (last.channel === web.WEB && !web.webOn()) {
      // Not counted as a hold against the model being down: `held_times` is that counter.
      // (reholdInbound adds one on the way back in, so one is taken off here: the row returns as it was.)
      const back = db.reholdInbound(held.map(r => ({ ...r, held_times: (r.held_times ?? 0) - 1 })), { readyAt: clock.now() + 60 * 60_000, downSince: null });
      this.log({ web_held_back: conversationId, messages: held.length, until: back.readyAt });
      return { ok: true, conversationId, messages: held.length, replied: false, webOff: true };
    }
    // One turn, so one turn off the day's allowance, however many texts it was. Counted before anything
    // else so the monthly free tier (src/plan.js) knows whether this is their 21st conversation.
    accounts.countUse(conversationId, "turn");
    // Over this month's free conversations (REASON_FREE_TIER=monthly): no turn at all — one line and the
    // pay link, once a conversation; anything else they text in it is kept in their history and left.
    try {
      const over = await plan.answerOverCeiling({ conversationId, texts: held.map(h => h.text), router: this, log: this.log });
      if (over) {
        this.log({ free_tier_over: conversationId, did: over.did, messages: held.length });
        return { ok: true, conversationId, fromOwner: true, isOperator: !!last.is_operator, messages: held.length, replied: over.did === "told", overCeiling: true };
      }
    } catch (e) { this.log({ free_tier_check_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); }
    // From the moment these texts are taken, a text that lands is read against them and can be
    // folded in (src/onethought.js) — while voice notes are heard and the screen runs, not only once
    // the model has started. The runtime adopts this for the turn; anything folded into a turn that
    // never ran goes back on the pile in the `finally` below.
    const fold = onethought.begin(conversationId, { text: held.map(h => h.text).join("\n") });
    fold.webChat = last.channel === web.WEB ? db.webChatOf(last.chat_id) : null;
    const bubble = this.#bubble(conversationId, {
      channel: last.channel, address: last.address, chatId: last.chat_id ?? null, service: last.service ?? null,
    });
    await bubble.start();

    if (held.length > 1) this.log({ burst: conversationId, messages: held.length, spanned_ms: last.arrived_at - held[0].arrived_at });

    let reply;
    // Hoisted out of the turn so the put-back below can drop the rows this turn opened.
    let requests = [];
    // A real request somebody made mid-way through the first-chat onboarding: the turn does it, and
    // the step still pending follows its reply (src/onboarding.js afterTask).
    let onboardAfter = null;
    try {
      // A voice note is listened to here, with the bubble already up, so the turn reads what was
      // said rather than a line saying sound arrived. Never allowed to cost the turn: if listening
      // breaks, the message goes in as it was, which already says it could not be heard.
      const texts = [];
      for (const h of held) {
        let t = h.text;
        try { t = await this.hear(h.text, h.attachments ?? [], { log: this.log, cover: reviewed.cover, conversationId }); }
        catch (e) { this.log({ hear_failed: h.external_id, why: (e?.message ?? String(e)).split("\n")[0] }); }
        try { t = await this.readContacts(t, h.attachments ?? [], { log: this.log, cover: reviewed.cover }); }
        catch (e) { this.log({ contact_read_failed: h.external_id, why: (e?.message ?? String(e)).split("\n")[0] }); }
        texts.push(t);
      }
      // Which text the reply answers, for a thread that can carry an inline reply: if the thread
      // has moved on by the time the reply is ready, it is pinned under this one (replies.js).
      const inline = !!this.get(last.channel)?.inlineReplies && (!last.service || /^imessage$/i.test(last.service));
      // Reason Web draws a pinned reply as a quote line (REASON_WEB_REPLY, src/pages/webreply.js), so a
      // Web turn's answer is pinned by the same rule (replies.answerTarget). Web has no reply_to tool, so
      // the burst line, which asks for one, stays the inline channels'.
      const canPin = inline || (last.channel === web.WEB && webReplyAllowedFor(conversationId));
      const said = texts.filter(Boolean);
      const several = inline ? replies.burstLine(said.length) : "";
      fold.text = said.join("\n");

      // History, one row per message they sent — their own words as heard, with the channel each
      // came on and when (src/web.js). Here, before any of the shortcuts below answer without a
      // turn, so the history never shows Reason's answer with no question in front of it. Not the
      // framing lines Reason adds for the model, which are its own.
      for (const [i, h] of held.entries()) {
        try {
          db.writeMessage({
            conversationId, role: "user", channel: h.channel, externalId: h.external_id,
            text: texts[i] || h.text || "", media: h.attachments ?? [], at: h.arrived_at ?? clock.now(),
            chatId: h.chat_id ?? null,
          });
        } catch { /* best-effort */ }
      }

      // (A call no longer waits on a texted "yes" while it is live — src/calls/verify.js, 2026-11-06 —
      // so there is no call verification for a text to answer here any more.)

      // Somebody mid-way through the first-chat onboarding (src/onboarding.js): its own bubbles answer
      // this step, before any request row is opened. Something real — a task, a picture, a to-do
      // list — falls through to the normal turn below, which does the thing first; the step follows.
      let onboardFrame = "";
      if (last.channel !== web.WEB && !fold.webChat && onboarding.active(conversationId)) {
        const thread = db.loadConversation(conversationId);
        const who = accounts.ownerOf(conversationId).name;
        const ob = await onboarding.handle({
          router: this, conversationId, texts: said,
          // The harm screen beside the read, as #readMidTurn does: anything not clear leaves the flow.
          screen: ({ text }) => this.runtime.screen?.({ text, messages: thread, who: who === "the person I work for" ? "them" : who }) ?? { verdict: "clear" },
          route: { channel: last.channel, to: last.address, chatId: last.chat_id ?? null },
          attachments: held.flatMap(h => h.attachments ?? []), log: this.log, ...this.onboard,
        });
        if (ob.handled) return { ok: true, conversationId, fromOwner: true, isOperator: !!last.is_operator, messages: held.length, replied: true, onboarding: ob.step };
        onboardFrame = ob.frame ?? "";
        if (ob.after) onboardAfter = { channel: last.channel, to: last.address, chatId: last.chat_id ?? null };
      }

      // A request record for each message, so the model can track what was asked and answer each
      // under its own text. Created here, before the turn, so the model sees them from the start.
      requests = held.map((h, i) => ({
        id: db.createRequest(conversationId, { handle: h.external_id, text: texts[i] || h.text }),
        handle: h.external_id,
        text: (texts[i] || h.text || "").slice(0, 300),
      }));
      for (const r of requests) db.linkRequestMessage(conversationId, r.id, r.handle, "opened");
      fold.requests = requests;
      // Anything folded in while the texts were being heard is linked to the request now.
      for (const a of fold.added) {
        db.linkRequestMessage(conversationId, requests.at(-1)?.id, a.handle, "continuation");
        if (requests.length) db.extendRequestText(conversationId, requests.at(-1).id, a.text.slice(0, 300));
      }
      if (requests.length) this.log({ requests_created: requests.map(r => r.id), conversation: conversationId });

      // Texts that waited out an outage are answered as such: the turn reads how long they
      // waited, and the reply is pinned under the text it answers however far the thread has
      // moved on since (src/down.js).
      const downSince = held.map(h => h.down_since).find(Boolean) ?? null;
      const gap = downSince ? leftWhileDownLine({ since: downSince, count: said.length }) : "";

      // Event log: record what the user said (after voice-note transcription) and enqueue extraction.
      const userText = [gap, onboardFrame, several, ...said].filter(Boolean).join("\n");
      let evId = null;
      try {
        evId = db.writeEvent({
          conversationId, channel: last.channel, messageId: last.external_id ?? "",
          role: "user", content: userText,
          attachments: held.flatMap(h => h.attachments ?? []),
        });
        db.enqueueExtraction(conversationId, evId);
      } catch { /* best-effort */ }

      try {
        reply = await this.runtime.inbound(conversationId, userText, {
          channel: last.channel, to: last.address, chatId: last.chat_id ?? null,
          fromOwner: true, isOperator: !!last.is_operator,
          ...(canPin ? { answering: { handle: fold.added.at(-1)?.handle ?? last.external_id, texts: said.length, ...(downSince ? { always: true } : {}) } } : {}),
          fold,
          attachments: held.flatMap(h => h.attachments ?? []),
          requests,
          downTries: Math.max(0, ...held.map(h => h.held_times ?? 0)),
        });
      } catch (e) {
        if (!(e instanceof OutageError)) throw e;
        // The model is down. Nothing this round wrote stands: the texts go back to wait for the
        // reset, the turn is refunded, and what the turn was about to read is forgotten so the
        // retry writes it once. They are told once per outage — keyed on the first text held, so
        // every retry that fails the same way finds the line already sent.
        db.forgetRequests(requests.map(r => r.id));
        if (evId !== null) db.forgetEvent(evId);
        accounts.countUse(conversationId, "turn", -1);
        // Texts the turn had folded in go back with its own, in the order they arrived.
        const back = db.reholdInbound([...held, ...(e.foldedRows ?? [])], { readyAt: e.until, downSince: downSince ?? e.since });
        this.log({ reheld: conversationId, messages: held.length, until: e.until, tries: Math.max(...held.map(h => (h.held_times ?? 0) + 1)) });
        await this.send({
          channel: last.channel, to: last.address, chatId: last.chat_id ?? null, conversationId, toOwner: true,
          text: downLine({ until: e.until, resetAt: e.resetAt, known: e.known }),
          idempotencyKey: `down:${conversationId}:${held[0].arrived_at}`,
        }).catch(() => {});
        return {
          ok: true, conversationId, fromOwner: true, isOperator: !!last.is_operator,
          messages: held.length, replied: false, down: true, until: back.readyAt,
        };
      }
    } catch (e) {
      if (!e?.interrupted) throw e;
      // The process is stopping and this turn did not finish. Put back exactly what it took, so
      // the next process's sweep answers it, and drop the request rows it had opened so nobody is
      // asked the same thing twice. Nothing is said to them: a restart costs a wait, not a reply.
      this.#handBack(conversationId, [...held, ...(e.foldedRows ?? [])], requests);
      this.log({
        drain_interrupted: conversationId, messages: held.length,
        why: (e?.message ?? String(e)).split("\n")[0],
      });
      return {
        ok: true, conversationId, fromOwner: true, isOperator: !!last.is_operator,
        messages: held.length, replied: false, interrupted: true,
      };
    } finally {
      // A turn that never ran (a call's yes answered by code, an outage, a failure before the model)
      // leaves what it folded in unanswered: back on the pile, ready now, for a turn of its own.
      if (!fold.started && fold.added.length) {
        try { db.reholdInbound(fold.added.map(a => a.row).filter(Boolean).map(r => ({ ...r, held_times: Math.max(0, (r.held_times ?? 0) - 1) })), { readyAt: clock.now(), downSince: null }); }
        catch (e) { this.log({ fold_hand_back_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }); }
      }
      onethought.end(fold);
      await bubble.stop();
      this.bubbles.delete(conversationId);
    }
    // After the turn: somebody in the first-chat onboarding who asked for something real gets the
    // step still pending now that it is done; their card comes from the flow, under the name they pick.
    if (onboardAfter && reply !== null) {
      await onboarding.afterTask({ router: this, conversationId, route: onboardAfter, log: this.log, ...this.onboard })
        .catch(e => this.log({ onboarding_after_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }));
    }
    // Otherwise: if this person now has a name and hasn't gotten their card, send it.
    // Fires here rather than before the turn so the card arrives after "nice to meet you" — and only
    // after a turn that actually said something, so it never follows a failure line or silence.
    if (reply !== null && !onboarding.active(conversationId)) void this.#offerCardIfNamed(conversationId);
    // The free trial's 25th-session bubbles, after that session's reply has answered them, and the
    // hold once they have lapsed (src/plan.js). Nothing under REASON_PAYWALL=off; never throws here.
    await plan.afterTurn({ conversationId, router: this, log: this.log })
      .catch(e => this.log({ paywall_after_turn_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] }));
    return {
      ok: true, conversationId, fromOwner: true, isOperator: !!last.is_operator,
      messages: held.length, replied: reply !== null,
    };
  }

  /**
   * Give back everything a turn took but never answered: the messages go back on the pile, and the
   * request rows that turn opened are dropped.
   *
   * They go back ready to run at once — `quietMs: 0` under their ORIGINAL arrival time — because
   * they have already waited out one quiet window and waiting out a second would be the restart
   * charging them twice. Keeping `arrived_at` is what keeps them in the order they were sent.
   *
   * Every write is synchronous and individually guarded: this runs with the process already on its
   * way out, and one message that cannot go back must not take the rest with it.
   */
  #handBack(conversationId, held, requests) {
    for (const r of requests) {
      try { db.dropRequest(r.id); }
      catch (e) { this.log({ hand_back_request_failed: r.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
    }
    for (const h of held) {
      try {
        db.holdInbound({
          conversationId, channel: h.channel, address: h.address, chatId: h.chat_id ?? null,
          externalId: h.external_id, text: h.text, attachments: h.attachments ?? [],
          service: h.service ?? null, isOperator: !!h.is_operator,
          quietMs: 0, maxMs: 0, now: h.arrived_at,
        });
      } catch (e) { this.log({ hand_back_failed: h.external_id, why: (e?.message ?? String(e)).split("\n")[0] }); }
    }
  }

  /**
   * Resolves when no drain is in flight. Shutdown waits on this after the turns themselves, so an
   * interrupted drain has finished putting its messages back before the process goes — the turn
   * failing and the messages going back are two steps, and only the first is a turn.
   */
  async idle() {
    while (this.draining.size) await Promise.allSettled([...this.draining]);
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
      // A drain that put the texts back for the model to come up is not a turn.
      if (r && !r.down) out.turns++;
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
   * An unknown number whose text carries an invite code. Null when it carries none.
   *
   * `{ joined: true }` means the invite was spent and their account exists: they were sent the
   * welcome line, the inviter was sent the join notice, and the caller runs their turn. Otherwise
   * `{ joined: false, result }`, and the caller returns `result` — nothing is admitted on a code
   * that did not work.
   */
  async #claimInvite(inbound, address) {
    const out = invites.claimByText({ channel: inbound.channel, address, text: inbound.text, name: inbound.displayName ?? "" });
    if (!out) return null;
    if (!out.joined) {
      this.log({ inbound: inbound.externalId, invite_refused: out.reason });
      if (out.toThem) {
        await this.sendNow({ channel: inbound.channel, to: address, text: out.toThem, chatId: inbound.chatId ?? null }).catch(() => {});
      }
      return { joined: false, result: { ok: true, admitted: false, invite: out.reason, conversationId: null } };
    }
    this.log({ inbound: inbound.externalId, invite_joined: out.inviteId, conversationId: out.conversationId });
    // The welcome first, durably, so it is the first thing in their thread; their turn follows and
    // the onboarding runs from it.
    await this.send({ channel: inbound.channel, to: address, text: out.welcome, chatId: inbound.chatId ?? null, conversationId: out.conversationId, toOwner: true })
      .catch(() => {});
    this.runtime?.say?.(out.inviter, out.toInviter);
    return { joined: true };
  }

  /**
   * A text carrying an event page's code (src/pages/event.js). Null when it carries none, so the
   * caller carries on as it always did.
   *
   * `conversationId` is the sender's when they already have an account, null when they do not. A new
   * guest's account is made in the same transaction that spends the code and puts them on the event
   * (db.redeemEventClaim); then, in this order: the organizer's welcome and the released details (a
   * tracked event message), then the first-chat onboarding (src/onboarding.js startAfterEvent) — or,
   * when it does not cover them, Reason's contact card and the one thing to try. Somebody already on
   * Reason gets the welcome and nothing else. No model turn runs on the code text itself.
   */
  async #claimEvent(inbound, address, conversationId) {
    if (!events.eventsOn()) return null;
    const code = invites.codesIn(inbound.text).find(c => db.eventClaimByCode(c));
    if (!code) return null;
    const out = db.redeemEventClaim({ code, channel: inbound.channel, address, existingConversationId: conversationId });
    const chatId = inbound.chatId ?? null;
    if (!out.ok) {
      const sender = conversationId ?? db.accountByAddress(inbound.channel, address)?.conversation_id ?? null;
      // A provider retrying the very text that joined them: already done, nothing to say twice.
      if (out.reason === "used" && sender && out.claim?.used_by === sender) return { ok: true, conversationId: sender, event: "already", replied: false };
      this.log({ inbound: inbound.externalId, event_claim_refused: out.reason });
      const line = EVENT_CLAIM_LINES[out.reason] ?? EVENT_CLAIM_LINES.used;
      if (conversationId) await this.send({ channel: inbound.channel, to: address, text: line, chatId, conversationId, toOwner: true }).catch(() => {});
      else await this.sendNow({ channel: inbound.channel, to: address, text: line, chatId }).catch(() => {});
      return { ok: true, admitted: !!conversationId, event: out.reason, conversationId, replied: true };
    }
    const conv = out.account.conversation_id;
    this.log({ inbound: inbound.externalId, event_joined: out.event.id, conversationId: conv, new_account: out.newAccount });
    // Written down as taken, so a retried delivery of this text stops at the duplicate check.
    if (!conversationId) db.claimInbound({ channel: inbound.channel, externalId: inbound.externalId, conversationId: conv, text: inbound.text ?? null });
    db.upsertThread({ conversationId: conv, channel: inbound.channel, address, chatId, isOwner: true, service: inbound.service ?? null, lastInboundId: inbound.baseHandle ?? inbound.externalId ?? null });
    const said = [];
    if (!out.already) {
      // A handle typed on the page is kept for their next events; somebody who already had Reason
      // gets the one guest-list note after the welcome (src/events.js afterJoin).
      const att = events.afterJoin({ ev: out.event, att: out.attendee, typedInstagram: out.claim?.instagram ?? null, newAccount: out.newAccount });
      await events.sendWelcome({ runtime: this.runtime, ev: out.event, att });
      if (!out.newAccount) events.scheduleListNote({ runtime: this.runtime, ev: out.event, att });
      // Not the welcome's own words: those are the organizer's, and a guest's history must not hold
      // somebody else's text as if Reason had written it. event_info has the details on demand.
      said.push(`[sent them the welcome for the event "${out.event.name.slice(0, 80)}" and the details its organizer has released]`);
    }
    // A new guest with the first-chat onboarding covering them: its steps, in place of the old card
    // and question follow-up — who Reason is, their name (the one typed on the page, or asked), what
    // they want to call Reason, the card under that name, the one thing to try (src/onboarding.js
    // startAfterEvent). Their code text
    // and the welcome go into the history first, so the flow's own lines follow them.
    let written = false;
    if (out.newAccount && inbound.channel !== web.WEB && onboarding.coversAddress(address)) {
      this.#eventHistory(conv, inbound, said);
      written = true;
      said.length = 0;
      const flow = await onboarding.startAfterEvent({
        router: this, conversationId: conv, route: { channel: inbound.channel, to: address, chatId }, log: this.log,
        ...this.onboard,
      }).catch(e => {
        // Out of the flow for good, so the old follow-up below is the only welcome they get.
        onboarding.finish(conv);
        this.log({ onboarding_event_failed: conv, why: (e?.message ?? String(e)).split("\n")[0] });
        return null;
      });
      if (flow) {
        this.log({ inbound: inbound.externalId, onboarding_started: conv, via: "event" });
        return { ok: true, conversationId: conv, event: "joined", newAccount: true, replied: true, onboarding: flow.step };
      }
    }
    if (out.newAccount) {
      const card = await offerContactCard({ router: this, account: db.getAccount(conv), log: this.log, line: EVENT_CARD_LINE });
      if (card.outcome === "sent") said.push(EVENT_CARD_LINE);
      // No interview (owner 2026-11-06): the one thing to try, a call or an event, and nothing asked about them.
      await this.send({ channel: inbound.channel, to: address, text: onboarding.TRY_LINE, chatId, conversationId: conv, toOwner: true }).catch(() => {});
      said.push(onboarding.TRY_LINE);
    }
    // Their history starts with what actually happened, so the turn their answer starts knows the
    // question it is answering. The code text they sent is theirs, on the channel it came on; what
    // Reason sent back went through the outbox and is history from there.
    if (!written) this.#eventHistory(conv, inbound, said);
    else if (said.length) db.saveConversation(conv, [...db.loadConversation(conv), { role: "assistant", content: said.join("\n\n") }]);
    return { ok: true, conversationId: conv, event: out.already ? "already" : "joined", newAccount: out.newAccount, replied: true };
  }

  /** An event join's start of history: the code text they sent, then what Reason sent back. */
  #eventHistory(conv, inbound, said) {
    try { db.writeMessage({ conversationId: conv, role: "user", channel: inbound.channel, externalId: inbound.externalId, text: inbound.text ?? "", at: inbound.at ?? clock.now() }); } catch { /* best-effort */ }
    db.saveConversation(conv, [...db.loadConversation(conv),
      { role: "user", content: String(inbound.text ?? "") },
      ...(said.length ? [{ role: "assistant", content: said.join("\n\n") }] : [])]);
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

    if (seen.action === "auto_admitted") {
      this.log({ inbound: inbound.externalId, auto_admitted: address, conversationId: seen.conversationId });
      const who = inbound.displayName ? `${inbound.displayName} (${address})` : address;
      // Not an emergency: one line in the owner's daily digest, not a text now (src/opsdigest.js).
      // Never who: how many, and that the page has the rest (owner, 2026-11-06).
      void who;
      try { opsDigest.hold({ text: `A new number texted Reason for the first time and was let in (auto-admit is on).`, key: `new-contact:${seen.conversationId}` }); } catch { /* never costs the admit */ }
      return { ok: true, autoAdmitted: true, conversationId: seen.conversationId };
    }

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
  async webAccess({ address, name = "" }) {
    const master = db.getAccount(config.ownerConversation);
    const isLive = (name) => name && name !== "console" && this.get(name)?.status?.().status === "live";
    const channel = isLive(master?.channel)
      ? master.channel
      : this.statuses().find(s => s.status === "live" && s.name !== "console")?.name ?? null;
    if (!channel) return { ok: false, reason: "not_ready" };

    const seen = access.handleWebRequest({ channel, address, name });
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
  async tellMaster(text, viaChannel = null, { idempotencyKey = null } = {}) {
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
    // A notice (not a question) comes with an `ops:` key, so its history row is tagged and Web's
    // Home never lists it as news (db.OPS_KEY_PREFIXES).
    return await this.send({ channel, to, text, conversationId: config.ownerConversation, toOwner: true, ...(idempotencyKey ? { idempotencyKey } : {}) });
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

  /** Contact card, but only once the person has a name. For auto-admitted people whose card
   *  is deferred until after the name-ask turn. */
  async #offerCardIfNamed(conversationId) {
    try {
      const account = db.getAccount(conversationId);
      if (!account || account.contact_card_sent_at) return;
      if (!account.name) return; // wait until they have given their name
      await offerContactCard({ router: this, account, log: this.log });
    } catch (e) {
      this.log({ contact_card_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  }

  /**
   * The new number's card and line, for one inbound. A second text that lands while they are on
   * their way waits for them rather than racing its own answer past the card.
   */
  async #tellNewLine({ inbound, address, conversationId }) {
    const going = this.lineCards.get(conversationId);
    if (going) return await going;
    if (inbound.channel !== LINE_CHANGE_CHANNEL || !isReturning(conversationId)) return null;
    const told = tellNewLine({ router: this, channel: inbound.channel, to: address, chatId: inbound.chatId ?? null, conversationId, log: this.log });
    this.lineCards.set(conversationId, told);
    try { return await told; } finally { this.lineCards.delete(conversationId); }
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
        // The pin goes on the first part and the effect on the last one with words in it: the answer
        // lands under the message it is about, and the animation belongs to the words, never a bare URL.
        last = await this.sendNow({
          channel, to, text, chatId, idempotencyKey,
          replyTo: i ? null : replyTo, sendStyle: i === effectPartIndex(parts) ? sendStyle : null,
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
    // A caption is words to a person: the silence marker comes off, and a caption that was only
    // the marker goes as no caption — the file still goes (src/plain.js withoutNoReply).
    text = withoutNoReply(text, { path: "media_url", log: this.log }).text;
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
  async sendNow({ channel, to, text, chatId = null, idempotencyKey, file = null, mimeType = null, filename = null, mediaUrl = null, sendStyle = null, replyTo = null }) {
    const ch = this.get(channel);
    if (!ch) return { ok: false, retryable: false, error: `No channel called '${channel}'. Registered: ${[...this.channels.keys()].join(", ") || "none"}.` };
    // The last step before an adapter, so the silence marker is checked here too, for the console,
    // for lines with no conversation, and for a row written before the outbox took it off
    // (src/plain.js withoutNoReply). Only the marker and no file: nothing goes.
    const quiet = withoutNoReply(text, { path: "send_now", log: this.log });
    if (quiet.stripped) {
      if (quiet.empty && !file) return { ok: false, not_sent: true, silent: true, retryable: false, error: "Not sent: once NO_REPLY was taken off there was nothing left to send." };
      text = quiet.text;
    }
    try {
      // A file the provider fetches by address (the contact card on an onboarding outbox row,
      // src/onboarding.js): the words and the card are one message, so neither goes without the other.
      if (mediaUrl) {
        if (typeof ch.sendMediaUrl !== "function") return { ok: false, retryable: false, supported: false, error: `${channel} cannot send a file by address` };
        return await ch.sendMediaUrl({ to, text, mediaUrl, chatId, idempotencyKey });
      }
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
  async webhook({ channel, rawBody, rawBytes, headers }) {
    const ch = this.get(channel);
    if (!ch) return { status: 404, body: { error: `no channel '${channel}'` } };
    let parsed;
    try {
      parsed = await ch.receive({ rawBody, rawBytes, headers });
    } catch (e) {
      this.log({ webhook: channel, threw: (e?.message ?? String(e)).split("\n")[0] });
      return { status: 500, body: { error: "webhook handler failed" } };
    }
    // Refused deliveries (a rotated secret, a missing header) raise an alert after a few; an
    // accepted one closes it (src/webhookalert.js). Never in the way of the answer.
    try { webhookAlert.note({ channel, status: parsed.status, error: parsed.body?.error ?? "", request: { headers, rawBody: rawBody ?? rawBytes?.toString?.("utf8") ?? "" } }); } catch { /* never blocks */ }
    const delivered = [];
    for (const inbound of parsed.inbound ?? []) {
      delivered.push(await this.deliver({ ...inbound, channel }));
    }
    return { status: parsed.status, body: { ...parsed.body, delivered: delivered.length }, results: delivered };
  }
}
