// The browser, as a channel. Nothing leaves the machine: a message "sent" over web is a row in the
// per-message history (written by the outbox the moment this returns ok — db.markOutboundSent) and
// an in-process event that a later phase's live stream will listen to. So this adapter has no
// credentials, no network and no provider id; what it has is the same six-method shape every other
// channel has, so the router, the outbox and the delivery layer treat it like any other and no
// special case for "web" leaks into them.
//
// Registered only while REASON_WEB is not off (src/serve.js). With it off the name `web` is not a
// channel at all: a send to it fails with "No channel called 'web'", which is the honest answer.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Channel } from "./channel.js";
import * as db from "../db.js";
import { webOn, WEB } from "../web.js";
import { clock } from "../config.js";

export class WebChannel extends Channel {
  name = WEB;

  constructor() {
    super();
    /** `message` events `{ to, text, message_id, at }` for whatever just went out; `typing` events `{ to, on, until }` (W2's live stream). */
    this.events = new EventEmitter();
    /** What this process has sent, newest last, so findSent can answer without the database when it can. */
    this.recent = [];
  }

  status() {
    return webOn()
      ? { name: this.name, status: "live", missing: [], what: "Reason Web, in a browser. Reaches only the person signed in to their own Reason." }
      : { name: this.name, status: "not_connected", missing: ["REASON_WEB"], what: "Reason Web, in a browser." };
  }

  /**
   * One message to one person's web history. In-process, so it cannot "fail to deliver": the only
   * failure is the switch being off, and that is said rather than swallowed.
   */
  async send({ to, text, idempotencyKey = null }) {
    if (!webOn()) return { ok: false, retryable: false, error: "web is switched off (REASON_WEB)" };
    const delivered = { channel: this.name, to, text, idempotencyKey, message_id: `web-${randomUUID()}`, at: clock.now() };
    this.recent.push(delivered);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    this.events.emit("message", delivered);
    return { ok: true, delivered };
  }

  /**
   * "Reason is working on it" in the open conversation tab (W2): an in-process `typing` event the
   * live stream passes on to that person's tabs only. Nothing is sent anywhere; with no tab open it
   * is heard by nobody, which is fine.
   */
  async typing({ to, on = true, maxDurationMs = 25_000 } = {}) {
    if (!webOn()) return { ok: true, supported: false };
    this.events.emit("typing", { to, on: !!on, until: on ? clock.now() + Math.max(5_000, Number(maxDurationMs) || 25_000) : 0 });
    return { ok: true };
  }

  /**
   * "Did this one go out?", for a row that was mid-flight when the process died. What makes a web
   * message real is its history row, so that is what is checked: this process's own memory first,
   * then the database for a history row written off an outbox row to this address with these words
   * in the window. Nothing durable means nothing was shown, and sending it is safe.
   */
  async findSent({ to, text, since, until }) {
    const mine = this.recent.find(s => s.to === to && s.text === text && s.at >= since && s.at <= until);
    if (mine) return { ok: true, found: true, message_id: mine.message_id };
    const row = db.webMessageSent({ address: to, text, since, until });
    return row ? { ok: true, found: true, message_id: row.external_id ?? null } : { ok: true, found: false };
  }
}
