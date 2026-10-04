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
//   pre-upload a file          POST {base}/v3/attachments { filename, content_type, size_bytes }
//                              → { attachment_id, upload_url, http_method, required_headers,
//                                  expires_at } ; upload_url valid 15 minutes
//   upload the bytes           PUT <upload_url> with the raw bytes as the body — not JSON, not
//                              multipart — and every header from required_headers exactly as
//                              returned, or S3 rejects it
//   attach it to a message     a part of { type: "media", attachment_id } alongside the text part,
//                              so text + file are ONE message
//   media by public URL        a part of { type: "media", url } — 10MB cap, needs a publicly
//                              reachable HTTPS URL, which a local recording does not have
//   audio types                M4A, AAC, MP3, WAV, AIFF, CAF, AMR (pre-upload cap 100MB). Audio
//                              in a media part arrives as a downloadable attachment; the inline
//                              voice-memo bubble is a different endpoint
//                              (POST /v3/chats/{id}/voicememo) and is not used here
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
import { statSync, readFileSync } from "node:fs";
import { Channel } from "./channel.js";
import { config, clock, normalizeNumber } from "../config.js";

const REPLAY_WINDOW_S = 5 * 60;
// Linq's documented pre-upload ceiling. The `url` form of a media part is capped at 10MB, but a
// local file never takes that path.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class LinqChannel extends Channel {
  name = "linq";

  /**
   * `fetch` and `now` are injectable so the adapter can be tested without a network or a clock;
   * the two file reads are injectable for the same reason — an attachment test should not need a
   * real file on disk, and a real send should not need a test double.
   */
  constructor({ fetchImpl = globalThis.fetch, now = () => clock.now(), statFile = statSync, readFile = readFileSync } = {}) {
    super();
    this.fetch = fetchImpl;
    this.now = now;
    this.statFile = statFile;
    this.readFile = readFile;
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
   * One message carrying text and one file — a call summary arriving with its recording.
   *
   * A recording lives on this machine, so the `url` form of a media part is no use: Linq fetches
   * that URL itself and `file:///Users/...` is not reachable from their side. The documented
   * pre-upload flow is the one that works for local files, in three steps:
   *
   *   1. POST /v3/attachments with the filename, content type and exact size → an upload URL
   *      (good for 15 minutes), the headers it is signed with, and a reusable attachment_id.
   *   2. PUT the raw bytes to that URL with those headers, unchanged. The body must be exactly
   *      size_bytes long, which is why the size is read off disk rather than passed in.
   *   3. Send one message whose parts are [text, { type: "media", attachment_id }].
   *
   * Unverified, like the rest of this adapter: it follows the spec at
   * cdn.linqapp.com/openapi/linq-api-v3.yaml (read 2026-10-04) and has never run against the
   * real API.
   */
  async sendMedia({ to, text, file, mimeType, filename = null, chatId = null, idempotencyKey = null }) {
    const missing = this.missing();
    if (missing.length) {
      return { ok: false, supported: true, status: "not_connected", error: `Linq is not connected: this machine has no ${missing.join(", ")}.` };
    }
    const number = normalizeNumber(to);
    if (!chatId && !number) return { ok: false, supported: true, error: `'${to}' is not a phone number Linq can send to. It needs E.164, e.g. +14155559876.` };

    let size;
    try { size = this.statFile(file).size; }
    catch { return { ok: false, supported: true, error: `the file is not there: ${file}` }; }
    if (!size) return { ok: false, supported: true, error: `the file is empty: ${file}` };
    const mb = (n) => Math.round(n / (1024 * 1024));
    if (size > MAX_UPLOAD_BYTES) {
      return { ok: false, supported: true, error: `the file is ${mb(size)}MB; Linq's pre-upload limit is ${mb(MAX_UPLOAD_BYTES)}MB.` };
    }
    const name = filename ?? file.split("/").pop();

    // Step 1: ask for somewhere to put it.
    const ask = await this.#post("/v3/attachments", { filename: name, content_type: mimeType, size_bytes: size });
    if (!ask.ok || !ask.json?.upload_url || !ask.json?.attachment_id) {
      const why = ask.json?.error?.message ?? ask.json?.message ?? ask.text?.slice(0, 200) ?? "no body";
      return { ok: false, supported: true, error: `Linq would not take the file (HTTP ${ask.status}): ${why}` };
    }
    const { upload_url: uploadUrl, attachment_id: attachmentId, http_method: method, required_headers: required } = ask.json;

    // Step 2: the bytes, with the presigned headers exactly as given. Changing or adding to them
    // invalidates the signature, so they are passed through rather than merged with anything.
    let put;
    try {
      put = await this.fetch(uploadUrl, {
        method: method || "PUT",
        headers: { ...(required ?? {}) },
        body: this.readFile(file),
      });
    } catch (e) {
      return { ok: false, supported: true, error: `the upload failed: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    if (!put?.ok) return { ok: false, supported: true, error: `the upload was rejected (HTTP ${put?.status ?? "no response"}).` };

    // Step 3: one message, both parts.
    const parts = [];
    if (text) parts.push({ type: "text", value: text });
    parts.push({ type: "media", attachment_id: attachmentId });
    const message = { parts };
    if (idempotencyKey) message.idempotency_key = String(idempotencyKey).slice(0, 255);

    const r = chatId
      ? await this.#post(`/v3/chats/${encodeURIComponent(chatId)}/messages`, { message })
      : await this.#post(`/v3/messages`, { to: [number], message });

    if (!r.ok) {
      const why = r.json?.error?.message ?? r.json?.message ?? r.text?.slice(0, 200) ?? "no body";
      return { ok: false, supported: true, error: `Linq refused the message (HTTP ${r.status}): ${why}`, http_status: r.status };
    }
    return {
      ok: true, supported: true,
      delivered: {
        channel: this.name,
        to: number || null,
        chat_id: r.json?.chat_id ?? chatId ?? null,
        message_id: r.json?.message?.id ?? null,
        media: { file, mimeType, filename: name, bytes: size, attachment_id: attachmentId },
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
