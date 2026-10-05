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
  constructor({ live = true, failWith = null, media = true, mediaFailWith = null, retryable = false, failTimes = 0, findSentAs = null, failFor = null } = {}) {
    super();
    this.live = live;
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
  }

  status() {
    return this.live
      ? { name: this.name, status: "live", missing: [], what: "a channel that goes nowhere, for tests" }
      : { name: this.name, status: "not_connected", missing: ["FAKE_CHANNEL_KEY"], what: "a channel that goes nowhere, for tests" };
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

  async typing({ to, on }) {
    this.typingCalls.push({ to, on });
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
