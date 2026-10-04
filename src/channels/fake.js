// A channel that goes nowhere, for tests. It keeps every message it was asked to send so a test
// can assert on what really left, and it can be told to fail so the honest-failure path is
// exercised too.
//
// It also fakes the inbound side: `webhookFor()` builds a request body in the same shape its own
// `receive()` reads, so a test can drive the whole path — HTTP request, signature-free parse,
// dedupe, owner check, turn — without a provider.
import { Channel } from "./channel.js";
import { clock } from "../config.js";

export class FakeChannel extends Channel {
  name = "fake";

  constructor({ live = true, failWith = null } = {}) {
    super();
    this.live = live;
    this.failWith = failWith;
    this.sent = [];
    this.typingCalls = [];
  }

  status() {
    return this.live
      ? { name: this.name, status: "live", missing: [], what: "a channel that goes nowhere, for tests" }
      : { name: this.name, status: "not_connected", missing: ["FAKE_CHANNEL_KEY"], what: "a channel that goes nowhere, for tests" };
  }

  async send({ to, text, chatId = null, idempotencyKey = null }) {
    if (this.failWith) return { ok: false, error: this.failWith };
    const delivered = { channel: this.name, to, text, chatId, idempotencyKey, at: clock.now() };
    this.sent.push(delivered);
    return { ok: true, delivered };
  }

  async typing({ to, on }) {
    this.typingCalls.push({ to, on });
    return { ok: true, supported: true };
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
