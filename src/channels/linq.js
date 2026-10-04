// Linq: iMessage, RCS and SMS on a number Reason owns.
//
// Every endpoint, header, field name and signing rule below comes from Linq's public Partner API
// v3 docs (docs.linqapp.com, read 2026-10-04), not from guesswork:
//
//   send, line picked for us   POST {base}/v3/messages          { to: [E164], message: { parts } }
//   send into a known chat     POST {base}/v3/chats/{id}/messages        { message: { parts } }
//   typing on / off            POST|DELETE {base}/v3/chats/{id}/typing
//   auth                       Authorization: Bearer <token>
//   idempotency                message.idempotency_key, max 255 chars, in the body not a header
//   webhooks                   Standard Webhooks: webhook-id, webhook-timestamp,
//                              webhook-signature "v1,<base64>", HMAC-SHA256 over
//                              "{id}.{timestamp}.{rawBody}" with the base64 body of a
//                              whsec_-prefixed secret, 5-minute replay window
//
// Two documented webhook payload versions are handled, because a subscription pins one of them:
// 2026-02-03 nests the sender under data.sender_handle.handle and the thread under data.chat.id;
// 2025-01-01 puts them at data.from and data.chat_id. Both carry text in data.parts[].value.
//
// Unverified: no request in this file has ever been made against the real API. There are no
// credentials on this machine, so everything below is docs-faithful and untested in anger.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Channel } from "./channel.js";
import { config, clock, normalizeNumber } from "../config.js";

const REPLAY_WINDOW_S = 5 * 60;

export class LinqChannel extends Channel {
  name = "linq";

  /** `fetch` and `now` are injectable so the adapter can be tested without a network or a clock. */
  constructor({ fetchImpl = globalThis.fetch, now = () => clock.now() } = {}) {
    super();
    this.fetch = fetchImpl;
    this.now = now;
  }

  get key() { return config.linqKey; }
  get secret() { return config.linqWebhookSecret; }
  get base() { return config.linqBase.replace(/\/+$/, ""); }

  missing() {
    const out = [];
    if (!config.linqKey) out.push("LINQ_API_KEY");
    if (!config.linqWebhookSecret) out.push("LINQ_WEBHOOK_SECRET");
    return out;
  }

  status() {
    const missing = this.missing();
    return {
      name: this.name,
      status: missing.length ? "not_connected" : "live",
      missing,
      what: "text a real phone number over iMessage, RCS or SMS, and receive replies",
      number: config.linqFrom || null,
      // Half-set-up still counts as set up. Somebody with a Linq key in .env is on their way to
      // letting other people text this, which is what the subscription-backend guard looks at.
      configured: !!(config.linqKey || config.linqWebhookSecret || config.linqFrom),
    };
  }

  async #post(path, body, { method = "POST" } = {}) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is reported as-is */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  /**
   * One plain-text message. With a chat id it goes into that thread; without one Linq picks the
   * line and resolves the chat itself, which is the path its docs recommend.
   */
  async send({ to, text, chatId = null, idempotencyKey = null }) {
    const missing = this.missing();
    if (missing.length) {
      return { ok: false, status: "not_connected", error: `Linq is not connected: this machine has no ${missing.join(", ")}.` };
    }
    const message = { parts: [{ type: "text", value: text }] };
    if (idempotencyKey) message.idempotency_key = String(idempotencyKey).slice(0, 255);

    const number = normalizeNumber(to);
    if (!chatId && !number) return { ok: false, error: `'${to}' is not a phone number Linq can send to. It needs E.164, e.g. +14155559876.` };

    const r = chatId
      ? await this.#post(`/v3/chats/${encodeURIComponent(chatId)}/messages`, { message })
      : await this.#post(`/v3/messages`, { to: [number], message });

    if (!r.ok) {
      const why = r.json?.error?.message ?? r.json?.message ?? r.text?.slice(0, 200) ?? "no body";
      return { ok: false, error: `Linq refused it (HTTP ${r.status}): ${why}`, http_status: r.status };
    }
    return {
      ok: true,
      delivered: {
        channel: this.name,
        to: number || null,
        chat_id: r.json?.chat_id ?? chatId ?? null,
        message_id: r.json?.message?.id ?? null,
        from: r.json?.from ?? null,
        service: r.json?.service ?? null,
        at: this.now(),
      },
    };
  }

  /**
   * The typing indicator. Linq's docs say a start shows it for about 85–90 seconds, so anything
   * longer has to re-start it; this method is one call and the caller owns the repeat.
   */
  async typing({ chatId, on }) {
    if (this.missing().length) return { ok: true, supported: false };
    if (!chatId) return { ok: false, supported: true, error: "Linq's typing indicator is per chat and needs a chat id." };
    const r = await this.#post(`/v3/chats/${encodeURIComponent(chatId)}/typing`, undefined, { method: on ? "POST" : "DELETE" });
    return r.ok ? { ok: true, supported: true } : { ok: false, supported: true, error: `HTTP ${r.status}` };
  }

  /**
   * Standard Webhooks verification, exactly as Linq documents it. Returns a reason rather than a
   * bare false, because a webhook that is being rejected is something worth being able to read.
   */
  verify({ rawBody, headers }) {
    if (!this.secret) return { ok: false, why: "no LINQ_WEBHOOK_SECRET on this machine" };
    const h = lowerKeys(headers);
    const id = h["webhook-id"];
    const ts = h["webhook-timestamp"];
    const sig = h["webhook-signature"];
    if (!id || !ts || !sig) return { ok: false, why: "missing webhook-id, webhook-timestamp or webhook-signature" };

    const age = Math.floor(this.now() / 1000) - Number(ts);
    if (!Number.isFinite(age)) return { ok: false, why: "webhook-timestamp is not a number" };
    if (Math.abs(age) > REPLAY_WINDOW_S) return { ok: false, why: `webhook-timestamp is ${age}s off; the window is ${REPLAY_WINDOW_S}s` };

    const raw = this.secret.startsWith("whsec_") ? this.secret.slice("whsec_".length) : this.secret;
    const expected = createHmac("sha256", Buffer.from(raw, "base64"))
      .update(`${id}.${ts}.${rawBody}`)
      .digest();

    const matched = String(sig).split(" ").some(one => {
      if (!one.startsWith("v1,")) return false;
      const given = Buffer.from(one.slice(3), "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    return matched ? { ok: true, id } : { ok: false, why: "signature did not match" };
  }

  async receive({ rawBody, headers }) {
    const v = this.verify({ rawBody, headers });
    if (!v.ok) return { status: 401, body: { error: `rejected: ${v.why}` }, inbound: [] };

    let event;
    try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" }, inbound: [] }; }

    // Everything else is acknowledged and dropped. A delivery receipt or a typing indicator is
    // not something to wake the model for, and pretending otherwise would spend tokens on noise.
    if (event.event_type !== "message.received") {
      return { status: 200, body: { ok: true, ignored: event.event_type ?? "unknown" }, inbound: [] };
    }

    const d = event.data ?? {};
    const from = d.sender_handle?.handle ?? d.from ?? d.from_handle?.handle ?? "";
    const chatId = d.chat?.id ?? d.chat_id ?? null;
    const text = partsToText(d.parts);
    // The envelope's event_id is the dedupe key Linq's own docs point at; the message id is the
    // fallback for a payload version that somehow lacks it.
    const externalId = String(event.event_id ?? d.id ?? "");

    if (!externalId || !from) {
      return { status: 200, body: { ok: true, ignored: "no event id or sender" }, inbound: [] };
    }
    return {
      status: 200,
      body: { ok: true },
      inbound: [{
        channel: this.name, externalId, from, text, chatId,
        at: Date.parse(d.sent_at ?? event.created_at ?? "") || this.now(),
      }],
    };
  }
}

function lowerKeys(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/**
 * A Linq message is an array of parts. Text comes through as text; anything else is described in
 * a line rather than dropped, so Reason answers "they sent a photo" instead of an empty message
 * it has no explanation for.
 */
function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map(p => {
    if (p?.type === "text") return String(p.value ?? "");
    if (p?.type === "media") return `[they sent ${p.mime_type ?? "a file"}${p.filename ? ` named ${p.filename}` : ""}, which you cannot open]`;
    if (p?.type === "link") return String(p.url ?? "[a link]");
    return `[a ${p?.type ?? "part"} you cannot read]`;
  }).filter(Boolean).join("\n").trim();
}
