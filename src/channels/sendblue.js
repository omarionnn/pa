// Sendblue: iMessage, SMS and RCS on a number Reason owns. The texting channel.
//
// Every endpoint, header, field name, error key and plan limit below is read off Sendblue's public
// docs (docs.sendblue.com, read 2026-10-04). Nothing is guessed; where the docs are silent the
// method says so in words rather than inventing a shape:
//
//   auth                 sb-api-key-id + sb-api-secret-key, two headers, on every request
//                        (docs.sendblue.com/getting-started/credentials)
//   base                 https://api.sendblue.com
//   send one message     POST /api/send-message { number, from_number, content }
//                        `from_number` is REQUIRED and must be a line on the account; there is no
//                        "pick a line for me" form. 18,996 character ceiling.
//                        (getting-started/sending-messages)
//   send a file          two steps, because a recording on this machine is not a URL Sendblue can
//                        fetch: POST /api/upload-file (multipart, field name `file`, 100MB cap)
//                        → { media_url }, then /api/send-message with that media_url alongside
//                        content, so text + file are ONE message. (api-v2/media)
//   typing               POST /api/send-typing-indicator { number, from_number, state,
//                        max_duration_ms }. iMessage only, needs an existing conversation,
//                        best effort, 1–300000ms. (api-v2/typing-indicators)
//   inbound              POST to the account's `receive` webhook. Flat JSON, not an envelope:
//                        content, number, from_number, to_number, message_handle, date_sent,
//                        is_outbound, status, group_id, media_url, service.
//                        (getting-started/receiving-messages)
//   dedupe               message_handle. Sendblue's own words: "Use message_handle for message
//                        events and event_id for events that provide it." Delivery is at least
//                        once; 3 retries on 5xx, 45s timeout. (getting-started/webhooks)
//
// TWO THINGS THE DOCS DO NOT SAY, both handled as failures rather than guesses:
//
//   1. The webhook verification scheme. The webhooks page says only that a configured secret is
//      "included in the webhook request headers" — it never names the header and never describes a
//      signature. There is no HMAC, no timestamp and no replay window documented anywhere, so this
//      is a constant-time comparison of a shared secret, not a signature check. The header name
//      `sb-signing-secret` is the one documented default in Sendblue's own Chat SDK adapter
//      (guides/chat-sdk-adapter), which also says it is overridable — hence
//      SENDBLUE_WEBHOOK_SECRET_HEADER. If the real header turns out to be something else, every
//      webhook is refused with a readable reason instead of being let through.
//   2. The exact response when the free shared line refuses an unverified contact. The free-plan
//      rule is documented (limits, getting-started) but its failure shape is not. What IS
//      documented is the pre-reply family — error_key PRE_REPLY_* with codes 4007–4010 — and a 403
//      for an unverified contact on the Free API plan on the read-receipts endpoint. Those are
//      mapped to lines Reason can repeat; anything else comes back as Sendblue's own words.
//
// Unverified: no request in this file has ever been made against the real Sendblue API. There are
// no Sendblue credentials on this machine. See docs/unverified.md.
import { timingSafeEqual } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { Channel } from "./channel.js";
import { config, clock, normalizeNumber } from "../config.js";

/** POST /api/upload-file: "Maximum file size: 100 MB" (api-v2/media). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** "We recommend keeping attachments under 20 MB for the most reliable delivery" (sending-messages). */
const RECOMMENDED_BYTES = 20 * 1024 * 1024;
/** "Messages sent using Sendblue must be less than 18996 characters" (sending-messages). */
const MAX_TEXT_CHARS = 18_996;
/** max_duration_ms "Must be between 1 and 300000" (api-v2/typing-indicators). */
const TYPING_MAX_MS = 300_000;

/**
 * The statuses a message goes through. An inbound message is "RECEIVED"; every one of these is a
 * status callback about something Reason itself sent, and waking the model for one would spend a
 * turn on a delivery receipt. (sending-messages: "There are currently 8 different possible
 * statuses".)
 */
const OUTBOUND_STATUSES = new Set([
  "REGISTERED", "PENDING", "DECLINED", "QUEUED", "ACCEPTED", "SENT", "DELIVERED", "ERROR",
]);

/**
 * What Reason says when a send is refused, keyed on the one field Sendblue tells you to branch on:
 * "Branch on this field; error_reason is for display and its wording can change." (limits).
 *
 * These are sentences, not codes, because the model has to be able to repeat them to the person
 * waiting. Every one of them is the documented rule in plain words.
 */
const REFUSALS = {
  // limits#before-the-first-reply — the whole family lifts the moment the contact texts back.
  PRE_REPLY_CONTENT_BLOCKED: "they need to text this number once first — until they reply, a message to them can't contain a link, a phone number, an email address or a file",
  PRE_REPLY_LENGTH_EXCEEDED: "they need to text this number once first — until they reply, a message to them has to be 300 characters or less",
  PRE_REPLY_LIMIT_REACHED: "they need to text this number once first — six messages have already gone to them with no reply, and only their reply lifts that",
  PRE_REPLY_OVERRIDE_EXHAUSTED: "they need to text this number once first — the one-a-day override for reaching them anyway is already used up today",
  // security — Sendblue detects opt-out words itself (stop, unsubscribe, cancel, opt out, revoke,
  // end, quit) and declines afterwards.
  OPTED_OUT: "they've opted out of messages from this number, so nothing more can go to them",
};

/**
 * The free shared line and the AI Agent plan, as the limits page states them. Quoted here so the
 * capabilities text and the README are repeating something that was read rather than remembered.
 *
 * Deliberately NOT here: the number of verified contacts a free account may hold. The docs say a
 * contact must be verified ("they text your Sendblue number once") but never give a ceiling, so
 * there is no number to enforce — Sendblue's own refusal is what surfaces, in its own words.
 * (limits, getting-started)
 */
export const PLAN_LIMITS = {
  free_shared_line: "a shared number: somebody has to text it once before Reason can message them",
  ai_agent_inbound_contacts_per_day: 1000,
  ai_agent_reply_window_hours: 24,
  ai_agent_follow_ups_per_day_after_window: 200,
  cite: "docs.sendblue.com/limits, read 2026-10-04",
};

export class SendblueChannel extends Channel {
  name = "sendblue";

  /**
   * `fetch`, `now` and the two file reads are injectable for the same reason they are on the Linq
   * adapter: an attachment test should not need a real file on disk, and no test should need a
   * network or a Sendblue account.
   */
  constructor({ fetchImpl = globalThis.fetch, now = () => clock.now(), statFile = statSync, readFile = readFileSync } = {}) {
    super();
    this.fetch = fetchImpl;
    this.now = now;
    this.statFile = statFile;
    this.readFile = readFile;
  }

  get keyId() { return config.sendblueKeyId; }
  get secretKey() { return config.sendblueSecretKey; }
  get from() { return normalizeNumber(config.sendblueFrom); }
  get webhookSecret() { return config.sendblueWebhookSecret; }
  get secretHeader() { return (config.sendblueWebhookSecretHeader || "sb-signing-secret").toLowerCase(); }
  get base() { return config.sendblueBase.replace(/\/+$/, ""); }

  /**
   * `from_number` is in here, unlike Linq's line, because Sendblue's send endpoint requires it:
   * "The from_number parameter is required when sending messages" (sending-messages). Credentials
   * without a line cannot send anything, so saying "live" would be a lie.
   */
  missing() {
    const out = [];
    if (!config.sendblueKeyId) out.push("SENDBLUE_API_KEY_ID");
    if (!config.sendblueSecretKey) out.push("SENDBLUE_API_SECRET_KEY");
    if (!config.sendblueFrom) out.push("SENDBLUE_FROM_NUMBER");
    if (!config.sendblueWebhookSecret) out.push("SENDBLUE_WEBHOOK_SECRET");
    return out;
  }

  status() {
    const missing = this.missing();
    return {
      name: this.name,
      status: missing.length ? "not_connected" : "live",
      missing,
      what: "text a real phone number over iMessage, SMS or RCS, and receive replies",
      number: config.sendblueFrom || null,
      // Half-set-up still counts as set up: somebody with a Sendblue key in .env is on their way
      // to letting other people text this, which is what the subscription-backend guard looks at.
      configured: !!(config.sendblueKeyId || config.sendblueSecretKey || config.sendblueFrom || config.sendblueWebhookSecret),
    };
  }

  get #authHeaders() {
    return { "sb-api-key-id": this.keyId, "sb-api-secret-key": this.secretKey };
  }

  async #postJson(path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { ...this.#authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is reported as-is */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  /**
   * One refusal, in words the model can repeat to the person waiting.
   *
   * The order matters. `error_key` is the field Sendblue says to branch on, so it wins. A 403 is
   * next: the read-receipts endpoint documents 403 for "on the Free API plan a verified contact",
   * and the free shared line is the plan this install is on — so a 403 on a send is read as the
   * same thing. Everything else comes back as Sendblue's own `error_reason` or message, which the
   * docs say is for display, which is exactly what this is.
   */
  #why(r) {
    const j = r.json ?? {};
    const key = j.error_key || (REFUSALS[j.error_message] ? j.error_message : null);
    if (key && REFUSALS[key]) return { line: REFUSALS[key], key, code: j.error_code ?? null };
    if (r.status === 403) {
      return {
        line: "they need to text this number once first — this is a free shared Sendblue line, and it will only message somebody who has texted it",
        key: "unverified_contact_inferred",
        code: j.error_code ?? null,
      };
    }
    const said = j.error_reason || j.error_message || j.message || r.text?.slice(0, 200) || "no body";
    return { line: `Sendblue refused it (HTTP ${r.status}): ${said}`, key: j.error_key ?? null, code: j.error_code ?? null };
  }

  /**
   * One plain-text message.
   *
   * `idempotencyKey` is accepted and deliberately NOT sent: /api/send-message documents no
   * idempotency field or header (the only documented one is `idempotency_key` on App Card
   * updates). It is kept on the delivery record so the ledger still has it, but Reason calling
   * send twice would produce two texts. See docs/unverified.md.
   */
  async send({ to, text, chatId = null, idempotencyKey = null }) {
    const missing = this.missing();
    if (missing.length) {
      return { ok: false, status: "not_connected", error: `Sendblue is not connected: this machine has no ${missing.join(", ")}.` };
    }
    const number = normalizeNumber(to);
    if (!number) return { ok: false, error: `'${to}' is not a phone number Sendblue can send to. It needs E.164, e.g. +14155559876.` };
    if (String(text ?? "").length > MAX_TEXT_CHARS) {
      return { ok: false, error: `that message is ${String(text).length} characters; Sendblue's ceiling is ${MAX_TEXT_CHARS}. Send it as more than one message.` };
    }

    const r = await this.#postJson("/api/send-message", { number, from_number: this.from, content: text });
    if (!r.ok) {
      const why = this.#why(r);
      return { ok: false, error: why.line, error_key: why.key, error_code: why.code, http_status: r.status };
    }
    // A 200 whose body says DECLINED is still a refusal: "A declined send returns HTTP 400" is the
    // documented case, but the status field is the authority on whether it went (limits).
    if (r.json?.status === "DECLINED" || r.json?.status === "ERROR") {
      const why = this.#why(r);
      return { ok: false, error: why.line, error_key: why.key, error_code: why.code, http_status: r.status };
    }
    return { ok: true, delivered: this.#deliveredFrom(r, { number, chatId, idempotencyKey }) };
  }

  #deliveredFrom(r, { number, chatId, idempotencyKey, media = null }) {
    return {
      channel: this.name,
      to: number,
      chat_id: r.json?.group_id || chatId || null,
      message_id: r.json?.message_handle ?? null,
      from: r.json?.from_number ?? this.from,
      service: r.json?.service ?? null,
      status: r.json?.status ?? null,
      idempotencyKey: idempotencyKey ?? null,
      ...(media ? { media } : {}),
      at: this.now(),
    };
  }

  /**
   * One message carrying text and one file — a call summary arriving with its recording.
   *
   * A recording lives in data/recordings on this machine, so `media_url` on its own is no use:
   * Sendblue downloads that URL from their side and file:///Users/... is not reachable. The
   * documented route for a local file is the upload, in two steps (api-v2/media):
   *
   *   1. POST /api/upload-file, multipart, the file in a field called `file` → { media_url }.
   *   2. POST /api/send-message with content AND that media_url, so one message carries both.
   *
   * About audio: ".caf files are rendered as voice memos on the recipient's device"
   * (sending-messages, guides/voice-notes), and .caf is the only format Apple renders inline. A
   * Reason call recording is a .wav, so it arrives as a playable audio attachment rather than a
   * voice-memo bubble. Converting would mean `ffmpeg -i input.mp3 -acodec opus -b:a 24k output.caf`
   * (the exact command from guides/voice-notes) — ffmpeg is NOT a dependency of this repo and is
   * deliberately not being added, so nothing here converts anything. If the voice-memo bubble is
   * wanted later, that is a dependency decision to make out loud, not a silent shell-out.
   */
  async sendMedia({ to, text, file, mimeType, filename = null, chatId = null, idempotencyKey = null }) {
    const missing = this.missing();
    if (missing.length) {
      return { ok: false, supported: true, status: "not_connected", error: `Sendblue is not connected: this machine has no ${missing.join(", ")}.` };
    }
    const number = normalizeNumber(to);
    if (!number) return { ok: false, supported: true, error: `'${to}' is not a phone number Sendblue can send to. It needs E.164, e.g. +14155559876.` };

    let size;
    try { size = this.statFile(file).size; }
    catch { return { ok: false, supported: true, error: `the file is not there: ${file}` }; }
    if (!size) return { ok: false, supported: true, error: `the file is empty: ${file}` };
    const mb = (n) => Math.round(n / (1024 * 1024));
    if (size > MAX_UPLOAD_BYTES) {
      return { ok: false, supported: true, error: `the file is ${mb(size)}MB; Sendblue's upload limit is ${mb(MAX_UPLOAD_BYTES)}MB.` };
    }
    const name = filename ?? file.split("/").pop();

    // Step 1: the bytes, as multipart with the field named `file`.
    const form = new FormData();
    form.append("file", new Blob([this.readFile(file)], { type: mimeType || "application/octet-stream" }), name);
    let up;
    try {
      up = await this.fetch(`${this.base}/api/upload-file`, { method: "POST", headers: { ...this.#authHeaders }, body: form });
    } catch (e) {
      return { ok: false, supported: true, error: `the upload failed: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    const upText = await up.text();
    let upJson = null;
    try { upJson = upText ? JSON.parse(upText) : null; } catch { /* reported as-is below */ }
    if (!up.ok || !upJson?.media_url) {
      const said = upJson?.message ?? upText?.slice(0, 200) ?? "no body";
      return { ok: false, supported: true, error: `Sendblue would not take the file (HTTP ${up.status}): ${said}` };
    }

    // Step 2: one message, text and the uploaded file together.
    const r = await this.#postJson("/api/send-message", {
      number, from_number: this.from, ...(text ? { content: text } : {}), media_url: upJson.media_url,
    });
    if (!r.ok || r.json?.status === "DECLINED" || r.json?.status === "ERROR") {
      const why = this.#why(r);
      return { ok: false, supported: true, error: why.line, error_key: why.key, error_code: why.code, http_status: r.status };
    }
    return {
      ok: true, supported: true,
      delivered: this.#deliveredFrom(r, {
        number, chatId, idempotencyKey,
        media: {
          file, mimeType, filename: name, bytes: size, media_url: upJson.media_url,
          // Said out loud on the record rather than left for somebody to wonder about.
          renders_as: name.toLowerCase().endsWith(".caf") ? "voice memo" : "attachment",
          ...(size > RECOMMENDED_BYTES ? { note: `${mb(size)}MB is over Sendblue's recommended 20MB for reliable delivery` } : {}),
        },
      }),
    };
  }

  /**
   * The "…" bubble. Per-recipient rather than per-chat: Sendblue's typing endpoint takes `number`,
   * and it needs an existing conversation ("No route mapping found for number, have you messaged
   * them before?"). iMessage only, best effort, and a failure here is never worth failing a turn
   * over — so it comes back as a reason, not an exception.
   *
   * `on: false` sends state "stop", which the docs call a safe no-op when nothing is showing.
   */
  async typing({ to, chatId = null, on, maxDurationMs = null }) {
    void chatId;
    if (this.missing().length) return { ok: true, supported: false };
    const number = normalizeNumber(to);
    if (!number) return { ok: false, supported: true, error: "Sendblue's typing indicator needs the recipient's number in E.164." };

    const body = { number, from_number: this.from, state: on ? "start" : "stop" };
    if (on && maxDurationMs) body.max_duration_ms = Math.min(Math.max(1, Math.round(maxDurationMs)), TYPING_MAX_MS);

    const r = await this.#postJson("/api/send-typing-indicator", body);
    if (!r.ok || r.json?.status === "ERROR") {
      const said = r.json?.error_message ?? r.json?.message ?? `HTTP ${r.status}`;
      return { ok: false, supported: true, error: said };
    }
    return { ok: true, supported: true };
  }

  /**
   * Is this webhook really from Sendblue?
   *
   * A shared-secret comparison, because that is all Sendblue documents: a secret configured on the
   * webhook (or a globalSecret for the account) is sent back in a request header. There is no
   * signature over the body, so this proves the sender knows the secret and nothing about the
   * payload; and there is no timestamp, so there is no replay window to check. Both of those are
   * weaker than the Standard Webhooks scheme the Linq adapter verifies, and that is Sendblue's
   * design, not a shortcut here — see docs/unverified.md.
   */
  verify({ headers }) {
    if (!this.webhookSecret) return { ok: false, why: "no SENDBLUE_WEBHOOK_SECRET on this machine" };
    const h = lowerKeys(headers);
    const given = h[this.secretHeader];
    if (!given) {
      return { ok: false, why: `no ${this.secretHeader} header (the docs do not name the header Sendblue sends the secret in; set SENDBLUE_WEBHOOK_SECRET_HEADER if it is something else)` };
    }
    const a = Buffer.from(String(given));
    const b = Buffer.from(this.webhookSecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "the shared secret did not match" };
    return { ok: true };
  }

  /**
   * One raw webhook request → the inbound messages worth a turn, and nothing else.
   *
   * Everything that is not a person's own DM is acknowledged with a 200 and dropped, so Sendblue
   * stops retrying and no turn is spent:
   *
   *   - our own outbound echo and every status callback (is_outbound, or a status from the
   *     documented outbound set) — a delivery receipt is not somebody talking;
   *   - typing indicators (is_typing), calls (event_type inbound_call / call_log), profile and
   *     contact events — each is a different webhook type pointed at the same account-level URL,
   *     because Sendblue's webhooks are account-level and all lines share them;
   *   - group messages. A non-empty group_id means several people, and every account, ledger row
   *     and confirmation in Reason belongs to ONE person — so a group is never silently treated as
   *     that person's DM. It is logged as ignored, which is honest, rather than answered.
   */
  async receive({ rawBody, headers }) {
    const v = this.verify({ headers });
    if (!v.ok) return { status: 401, body: { error: `rejected: ${v.why}` }, inbound: [] };

    let event;
    try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "bad json" }, inbound: [] }; }

    // A different webhook type on the shared account URL.
    if (event.event_type) return { status: 200, body: { ok: true, ignored: String(event.event_type) }, inbound: [] };
    if (typeof event.is_typing === "boolean") return { status: 200, body: { ok: true, ignored: "typing_indicator" }, inbound: [] };

    // Ours, coming back to us.
    if (event.is_outbound === true) return { status: 200, body: { ok: true, ignored: "outbound echo" }, inbound: [] };
    const status = String(event.status ?? "");
    if (status && status !== "RECEIVED" && OUTBOUND_STATUSES.has(status)) {
      return { status: 200, body: { ok: true, ignored: `status ${status}` }, inbound: [] };
    }

    // Several people, not one person's Reason.
    const groupId = String(event.group_id ?? "").trim();
    if (groupId) return { status: 200, body: { ok: true, ignored: "group", group_id: groupId }, inbound: [] };

    // `number` is the field the docs define as "your end-user (not the Sendblue-provided phone
    // number)", so it is the sender even on a payload where from_number happens to match.
    const from = normalizeNumber(event.number || event.from_number || "");
    const externalId = String(event.message_handle ?? "");
    if (!externalId || !from) {
      return { status: 200, body: { ok: true, ignored: "no message_handle or sender" }, inbound: [] };
    }

    return {
      status: 200,
      body: { ok: true },
      inbound: [{
        channel: this.name,
        externalId,
        from,
        text: describe(event),
        // Sendblue has no thread id for a one-to-one conversation — group_id is the only one it
        // has, and a group never gets here. The recipient's number is the thread.
        chatId: null,
        at: Date.parse(event.date_sent ?? "") || this.now(),
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
 * What they actually said. An attachment is described in a line rather than dropped, so Reason
 * answers "they sent a photo" instead of an empty message it has no explanation for. Inbound
 * media_url expires after 30 days (receiving-messages), which is another reason not to pretend
 * Reason can open it.
 */
function describe(event) {
  const parts = [];
  const content = String(event.content ?? "").trim();
  if (content) parts.push(content);
  const media = String(event.media_url ?? "").trim();
  if (media) parts.push(`[they sent a file, which you cannot open: ${media.split("?")[0].split("/").pop() || media}]`);
  if (event.app_card) parts.push("[they sent an App Card, which you cannot read]");
  return parts.join("\n").trim();
}
