// A channel that goes nowhere, for tests. It keeps every message it was asked to send so a test
// can assert on what really left, and it can be told to fail so the honest-failure path is
// exercised too.
//
// It also fakes the inbound side: `webhookFor()` builds a request body in the same shape its own
// `receive()` reads, so a test can drive the whole path — HTTP request, signature-free parse,
// dedupe, owner check, turn — without a provider.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { Channel } from "./channel.js";
import { clock } from "../config.js";

export class FakeChannel extends Channel {
  name = "fake";

  /**
   * `media: false` makes it a channel with no attachment support, so the honest fallback path
   * ("here is the summary; the audio could not be delivered here") is exercisable too.
   *
   * The outbox needs three more things from a fake channel, and all three are failure shapes
   * rather than successes, because the outbox is entirely about what happens when a send does not
   * work:
   *
   *   `retryable`   what a failure claims about itself. The outbox retries only on `true`, so a
   *                 test has to be able to produce both kinds.
   *   `failTimes`   fail this many attempts, then succeed — a flaky network, which is the case the
   *                 whole retry mechanism exists for.
   *   `findSentAs`  what this channel says when asked whether an interrupted message went out.
   *                 Left null it says it cannot tell, which is the base Channel's honest default.
   */
  constructor({ live = true, failWith = null, media = true, mediaFailWith = null, retryable = false, failTimes = 0, findSentAs = null, failFor = null, typingAs = null, markReadAs = null, reactAs = null, number = null } = {}) {
    super();
    this.live = live;
    this.typingAs = typingAs;
    this.markReadAs = markReadAs;
    this.markReadCalls = [];
    this.reactAs = reactAs;
    this.reactCalls = [];
    /** The "line" this fake sends from, which is the scope a per-line refusal is remembered against. */
    this.number = number;
    this.failWith = failWith;
    /** When set, only sends to this address fail — a number that is unreachable, not a dead line. */
    this.failFor = failFor;
    this.media = media;
    this.mediaFailWith = mediaFailWith;
    this.retryable = retryable;
    this.failTimes = failTimes;
    this.findSentAs = findSentAs;
    this.sent = [];
    this.typingCalls = [];
    /** Every attempt, including the ones that failed. `sent` is only what actually left. */
    this.attempts = [];
    this.findSentCalls = [];
    /**
     * Everything this channel was asked to do, in order, as one list. Order is the whole question
     * for the typing bubble — it has to go up before the turn and come down after the reply, and
     * two separate arrays cannot show that.
     */
    this.trace = [];
  }

  status() {
    return this.live
      ? { name: this.name, status: "live", missing: [], number: this.number, what: "a channel that goes nowhere, for tests" }
      : { name: this.name, status: "not_connected", missing: ["FAKE_CHANNEL_KEY"], number: this.number, what: "a channel that goes nowhere, for tests" };
  }

  async send({ to, text, chatId = null, idempotencyKey = null }) {
    this.attempts.push({ to, text, chatId, idempotencyKey, at: clock.now() });
    const mine = !this.failFor || this.failFor === to;
    if (mine && this.failTimes > 0) {
      this.failTimes--;
      return { ok: false, retryable: true, error: this.failWith ?? "the network dropped it" };
    }
    if (mine && this.failWith) return { ok: false, retryable: this.retryable, error: this.failWith };
    const delivered = {
      channel: this.name, to, text, chatId, idempotencyKey, media: null,
      message_id: `fake-${this.sent.length + 1}`, at: clock.now(),
    };
    this.sent.push(delivered);
    this.trace.push({ sent: text });
    return { ok: true, delivered };
  }

  /**
   * One message with text and one attachment. It lands in the same `sent` list as a plain
   * message, with the file on it — which is how a test asserts the owner got ONE message carrying
   * both the summary and the audio, rather than two things that happened to arrive together.
   */
  async sendMedia({ to, text, file, mimeType, filename = null, chatId = null, idempotencyKey = null }) {
    if (!this.media) return { ok: false, supported: false, error: "this fake channel is set up without attachment support" };
    if (this.mediaFailWith) return { ok: false, supported: true, error: this.mediaFailWith };
    if (!file) return { ok: false, supported: true, error: "no file was given" };
    // Read the bytes rather than trusting the path: a test that asserts audio arrived should fail
    // when the file is missing or empty, not when somebody later notices.
    let bytes = 0;
    try { bytes = statSync(file).size; } catch { return { ok: false, supported: true, error: `no such file: ${file}` }; }
    if (!bytes) return { ok: false, supported: true, error: `the file is empty: ${file}` };

    const delivered = {
      channel: this.name, to, text, chatId, idempotencyKey, at: clock.now(),
      media: { file, mimeType, filename: filename ?? basename(file), bytes },
    };
    this.sent.push(delivered);
    return { ok: true, supported: true, delivered };
  }

  /**
   * `typingAs` picks the answer, because the typing bubble's interesting cases are all failures:
   *   "unsupported"  the channel cannot do it at all — asked once, never again
   *   "fails"        it refused this time
   *   "throws"       it broke, which must still not cost anybody a reply
   */
  async typing({ to, on, maxDurationMs = null }) {
    this.typingCalls.push({ to, on, maxDurationMs });
    this.trace.push({ typing: on ? "start" : "stop" });
    if (this.typingAs === "throws") throw new Error("the typing endpoint fell over");
    if (this.typingAs === "unsupported") return { ok: true, supported: false };
    if (this.typingAs === "fails") return { ok: false, supported: true, error: "no route mapping for that number" };
    return { ok: true, supported: true };
  }

  /**
   * "Put a tapback on it." `reactAs` picks the answer, and the two 422s are the interesting pair:
   *   "line"    this number cannot send tapbacks at all — remembered
   *   "target"  this one message cannot take one — NOT remembered, the next may be fine
   */
  async react({ messageHandle, reaction, partIndex = null }) {
    this.reactCalls.push({ messageHandle, reaction, partIndex });
    if (this.reactAs === "line") {
      return { ok: false, supported: true, http_status: 422, error: "this Sendblue line cannot send tapbacks", remember: { scope: "line", why: "this Sendblue line cannot send tapbacks" } };
    }
    if (this.reactAs === "target") {
      return { ok: false, supported: true, http_status: 422, error: "that message cannot take a tapback" };
    }
    return { ok: true, supported: true, reaction };
  }

  /**
   * "Mark it read." `markReadAs` picks the answer, and the interesting ones are the two permanent
   * refusals, because those are the ones that must be remembered rather than re-asked:
   *   "line"       this line cannot do it at all (Sendblue's 422)
   *   "contact"    this contact is not verified (Sendblue's 403 on the free plan)
   *   "transient"  not right now (a 503 or a 429) — must NOT be remembered
   *   "throws"     broken, which must still not cost anybody a turn
   */
  async markRead({ to }) {
    this.markReadCalls.push({ to });
    if (this.markReadAs === "throws") throw new Error("mark-read fell over");
    if (this.markReadAs === "line") {
      return { ok: false, supported: true, http_status: 422, error: "unsupported_on_this_line", remember: { scope: "line", why: "this line cannot send read receipts" } };
    }
    if (this.markReadAs === "contact") {
      return { ok: false, supported: true, http_status: 403, error: "Contact has not been verified for this account", remember: { scope: "contact", why: "this contact is not verified" } };
    }
    if (this.markReadAs === "transient") {
      return { ok: false, supported: true, http_status: 503, error: "worker_unavailable", transient: true };
    }
    return { ok: true, supported: true };
  }

  /**
   * "Did this one go out?", for the crash-mid-send case.
   *
   * `findSentAs: "found"` / `"missing"` / `"unknowable"` picks the answer; without it this channel
   * says it cannot tell, which is the base Channel's default and the answer that makes the outbox
   * refuse to resend. `"real"` looks in its own `sent` list, which is what a channel that really
   * can check behaves like.
   */
  async findSent({ to, text, since, until }) {
    this.findSentCalls.push({ to, text, since, until });
    if (this.findSentAs === "found") return { ok: true, found: true, message_id: "fake-recovered" };
    if (this.findSentAs === "missing") return { ok: true, found: false };
    if (this.findSentAs === "real") {
      const hit = this.sent.find(s => s.to === to && s.text === text && s.at >= since && s.at <= until);
      return hit ? { ok: true, found: true, message_id: hit.message_id } : { ok: true, found: false };
    }
    return { ok: false, error: "this fake channel has no way to check" };
  }

  /** The body a test POSTs to the webhook route. */
  static webhookFor({ id, from, text, chatId = null, at = Date.now() }) {
    return JSON.stringify({ id, from, text, chat_id: chatId, at });
  }

  async receive({ rawBody }) {
    let body;
    try { body = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" }, inbound: [] }; }
    if (!body.id || !body.from) return { status: 400, body: { error: "id and from are required" }, inbound: [] };
    return {
      status: 200,
      body: { ok: true },
      inbound: [{
        channel: this.name, externalId: String(body.id), from: String(body.from),
        text: String(body.text ?? ""), chatId: body.chat_id ?? null, at: body.at ?? clock.now(),
      }],
    };
  }
}
