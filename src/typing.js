// The "…" bubble, for as long as a turn actually takes.
//
// A turn can take twenty seconds. Without this, somebody texts Reason and gets nothing at all until
// the whole answer lands, which reads as being ignored rather than being answered.
//
// Three rules, and the order is the order of how much they matter:
//
//   1. **It never delays or blocks the reply.** Everything in here is fire-and-forget and nothing
//      throws. Sendblue calls the typing indicator best-effort, it only works on iMessage, and it
//      needs an existing conversation — so there are several perfectly ordinary reasons for it to
//      fail, and not one of them is a reason to make somebody wait longer for their answer.
//   2. **It is never left hanging.** Sendblue's bubble has its own expiry, and leaving
//      `max_duration_ms` out does NOT mean "until you say stop" — it means 60 seconds
//      (api-v2/typing-indicators). So the bubble is asked for in short chunks and renewed while the
//      turn is still running, which has a useful property: if this process dies mid-turn, the
//      bubble clears itself within one chunk instead of sitting on somebody's phone. A long chunk
//      would be fewer requests and a worse failure.
//   3. **It stops after the reply, not before.** Stopping first would leave a gap with no bubble
//      and no message. The send itself clears the bubble on the device anyway, and Sendblue
//      documents a stop with nothing showing as "a safe no-op", so stopping afterwards costs
//      nothing and covers the case where the turn produced no reply at all.
import { config, clock } from "./config.js";

/** Services that carry a typing indicator. "Typing indicators are only supported for iMessage". */
const CAN_TYPE = new Set(["imessage"]);

/**
 * Should this conversation get a bubble at all?
 *
 * An unknown service gets one. Only `service` says which rail a thread is on and only Sendblue
 * sends it, so a channel that reports nothing (the console, Linq, a fake) must not be silently
 * opted out — it says `supported: false` for itself. A thread that is KNOWN to be SMS or RCS is
 * skipped, because that request is refused every time and asking is just noise in the log.
 */
export function canShowTyping(service) {
  if (!service) return true;
  return CAN_TYPE.has(String(service).toLowerCase());
}

/**
 * One bubble, for one turn.
 *
 * Built around `start()` / `stop()` rather than wrapping a promise, because the thing it has to
 * stay out of the way of is the turn, and a wrapper is one more thing that can fail in front of a
 * reply. Both methods are safe to call twice and safe to call in either order.
 */
export class TypingBubble {
  /**
   * `timers` is injectable so a test can drive a multi-minute turn without waiting for one, and
   * `now` follows the fake clock for the same reason.
   */
  constructor({ channel, to, chatId = null, log = () => {}, timers = { set: setTimeout, clear: clearTimeout }, now = () => clock.now() } = {}) {
    this.channel = channel;
    this.to = to;
    this.chatId = chatId;
    this.log = log;
    this.timers = timers;
    this.now = now;
    this.timer = null;
    this.started = false;
    this.done = false;
    this.renewals = 0;
    this.startedAt = null;
    /** Set when the channel says it cannot do this, so nothing is asked a second time. */
    this.unsupported = false;
  }

  /** Show it, and keep showing it. Resolves once the first request has been answered. */
  async start() {
    if (this.started || this.done) return;
    this.started = true;
    this.startedAt = this.now();
    await this.#show();
  }

  async #show() {
    if (this.done || this.unsupported) return;
    let r;
    try {
      r = await this.channel.typing({ to: this.to, chatId: this.chatId, on: true, maxDurationMs: config.typingChunkMs });
    } catch (e) {
      // A channel that throws has already cost somebody nothing; it must not cost them a reply.
      this.log({ typing: this.to, threw: (e?.message ?? String(e)).split("\n")[0] });
      return;
    }
    if (r?.supported === false) {
      this.unsupported = true;
      return;
    }
    if (!r?.ok) {
      // Reported once, not once per renewal: a thread Sendblue has no route for will refuse every
      // request, and a log line per 24 seconds for a turn that is working fine is noise.
      this.log({ typing: this.to, could_not_show: r?.error ?? "no reason given" });
      this.unsupported = true;
      return;
    }
    this.#renewLater();
  }

  /**
   * Book the next renewal before the current chunk lapses.
   *
   * At 80% of the chunk, so a slow request does not leave a gap. The total ceiling exists because a
   * turn that has run for five minutes has something wrong with it, and a bubble that renews
   * forever would say "still typing" about a turn that is never going to answer.
   */
  #renewLater() {
    this.timers.clear(this.timer);
    if (this.done) return;
    if (this.now() - this.startedAt >= config.typingMaxMs) {
      this.log({ typing: this.to, gave_up_after_ms: this.now() - this.startedAt, note: "the turn is taking too long to keep claiming it is still typing" });
      return;
    }
    this.timer = this.timers.set(() => {
      this.renewals++;
      this.#show().catch(() => {});
    }, Math.round(config.typingChunkMs * 0.8));
    // Never a reason for the process to stay alive.
    this.timer?.unref?.();
  }

  /** Take it down. Safe at any point, including before start() and twice. */
  async stop() {
    this.done = true;
    this.timers.clear(this.timer);
    this.timer = null;
    // Nothing was ever shown, or the channel already said it cannot. Asking it to stop would be a
    // request whose only possible outcome is another refusal.
    if (!this.started || this.unsupported) return;
    try {
      await this.channel.typing({ to: this.to, chatId: this.chatId, on: false });
    } catch (e) {
      this.log({ typing: this.to, could_not_stop: (e?.message ?? String(e)).split("\n")[0] });
    }
  }
}

/**
 * A bubble for one inbound message, or a do-nothing stand-in.
 *
 * Returning an object with the same two methods rather than null keeps the caller free of a branch
 * around something that is allowed to be absent — the call site reads as "show it, run the turn,
 * stop it" whether or not anything can actually be shown.
 */
export function bubbleFor({ channel, to, chatId = null, service = null, log = () => {}, timers, now }) {
  const nothing = { start: async () => {}, stop: async () => {}, skipped: true };
  if (!channel || typeof channel.typing !== "function") return nothing;
  if (!canShowTyping(service)) return nothing;
  if (channel.status?.().status !== "live") return nothing;
  return new TypingBubble({ channel, to, chatId, log, ...(timers ? { timers } : {}), ...(now ? { now } : {}) });
}
