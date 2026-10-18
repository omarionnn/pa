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
//                        Two ceilings, not one: iMessage 20MB recommended / 100MB max, SMS 5MB max.
//                        A fallback to SMS compresses the file and FAILS THE MESSAGE if it cannot
//                        get under 5MB, so size is reported on the record. (sending-messages)
//   typing               POST /api/send-typing-indicator { number, from_number?, state?,
//                        max_duration_ms? }. iMessage only, needs an existing conversation, best
//                        effort. `from_number` is optional HERE and required on send-message.
//                        max_duration_ms is 1–300000 and DEFAULTS TO 60000 when left out, so a
//                        bubble set once and forgotten disappears a minute in.
//                        (api-v2/typing-indicators)
//   inbound              POST to the account's `receive` webhook. Flat JSON, not an envelope:
//                        content, number, from_number, to_number, message_handle, date_sent,
//                        is_outbound, status, group_id, media_url, service, was_downgraded.
//                        (getting-started/receiving-messages)
//   dedupe               message_handle. Sendblue's own words: "Use message_handle for message
//                        events and event_id for events that provide it." Delivery is at least
//                        once; 3 retries on 5xx, 45s timeout. (getting-started/webhooks)
//   retryability         sending-messages#error-codes and limits#before-the-first-reply, read into
//                        canRetry() below. Sendblue states it in words: the declines "return HTTP
//                        400, never HTTP 429, so HTTP clients that retry 429 automatically do not
//                        resend them", and a 429 means "slow down ... before retrying".
//
// WHAT THE DOCS DO NOT SETTLE. Each one is handled as a failure or said out loud, never guessed:
//
//   1. The webhook verification scheme. The webhooks page says only that a configured secret is
//      "included in the webhook request headers" — it never names the header and never describes a
//      signature. There is no HMAC, no timestamp and no replay window documented anywhere, so this
//      is a constant-time comparison of a shared secret, not a signature check. The header name
//      `sb-signing-secret` is the one documented default in Sendblue's own Chat SDK adapter
//      (guides/chat-sdk-adapter), which also says it is overridable — hence
//      SENDBLUE_WEBHOOK_SECRET_HEADER. One real night of inbound traffic on this install arrived
//      and verified on that default, which is evidence for this account and not a spec.
//   2. The exact response when the free shared line refuses an unverified contact ON A SEND. The
//      free-plan rule is documented (limits, getting-started) and read-receipts documents a 403
//      "Contact Not Verified" for it — but send-message's error table never lists that case. A 403
//      on a send is therefore read as the same thing, labelled `unverified_contact_inferred` so
//      the inference is visible rather than hidden in a sentence.
//   3. No idempotency on /api/send-message. The parameter table has number, from_number, content,
//      media_url, app_card, send_style, status_callback, seat_id, reply_to and
//      pre_reply_override — and nothing else. `idempotency_key` exists only on App Card updates.
//      So two identical POSTs are two texts, and not-sending-twice has to be enforced before the
//      request. That is what the outbox in src/outbox.js is for.
//   4. Inbound tapbacks and expressive effects. Nothing inbound carries a reaction (see receive()).
//      `send_style` IS on the inbound payload, so an effect somebody sent Reason is visible; a
//      tapback somebody sent Reason is not, at all.
//   5. `line_blocked`, `line_assigned` and `contact_created` have no published payload.
//   6. The `_1`/`_2` suffix on a multi-part message's handle. api-v2/reactions says a message with
//      attachments has one "primary message_handle" plus parts selected by `part_index`, and that
//      "an attachment-specific handle returns 422" — so the two kinds of handle exist and are
//      different strings. It never says what an attachment-specific one looks like, and nothing
//      documents one message arriving as several `receive` webhooks. Both are read off one real
//      night here and implemented in splitHandle(); see docs/unverified.md.
//   7. `pre_reply_override: true` is documented and deliberately never sent. It would push one
//      otherwise-blocked message per contact per day past the pre-reply rules; spending somebody's
//      one override without being asked is a decision for the person who owns the line, not for a
//      retry loop. The refusal lines say the override exists so it can be asked for.
//   8. Inline replies (guides/inline-replies). `reply_to: { message_handle }` on a send pins the
//      message under that one, and "a rejected reply is not sent as a standalone message" — it
//      comes back as a 400 "validation failure" with no error key given. So a 400 on a send that
//      carried `reply_to` is answered by sending the same message once more without it: the pin is
//      an extra, the message is not, and the docs' own promise that the first was not sent is what
//      makes the second safe. Inbound, BOTH `reply_to.message_handle` and
//      `thread_originator.message_handle` are read and carried. Until 2026-10-06 only the parent
//      was, "because the immediate parent is the thing being answered" — and that night the parent
//      Sendblue named was the newest message in the conversation, which sat in a different thread
//      from the `thread_originator` on the same webhook (and from the thread on the phone). Apple
//      keeps threads by their first message, so the originator is the record and the parent is a
//      hint; which to believe is the router's call (replies.inboundReplyLine), not the adapter's.
//      V2 iMessage lines only, and whether the line this install runs on is one has never been
//      tried. See docs/unverified.md.
//
// Unverified: no request in this file has ever been made against the real Sendblue API from this
// repo's tests. There are no Sendblue credentials on this machine. See docs/unverified.md.
import { timingSafeEqual } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { Channel } from "./channel.js";
import { isAudio, cannotHearLine } from "../voice.js";
import { checkReaction, checkSendStyle } from "../expressive.js";
import { config, clock, normalizeNumber } from "../config.js";
import { reverseGeocode } from "../places.js";

/** POST /api/upload-file: "Maximum file size: 100 MB" (api-v2/media). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** "We recommend keeping attachments under 20 MB for the most reliable delivery" (sending-messages). */
const RECOMMENDED_BYTES = 20 * 1024 * 1024;
/**
 * The SMS ceiling, which is a different number from the iMessage one: the file-size table on
 * sending-messages reads iMessage 20 MB recommended / 100 MB maximum, SMS 5 MB maximum. It matters
 * even when the send is addressed to an iPhone, because "Sendblue automatically falls back from
 * iMessage to SMS when the recipient does not have iMessage enabled", and then "Sendblue will
 * attempt to compress the file to fit within the 5 MB SMS limit. If compression fails, the message
 * will fail to send." So a 30 MB attachment is legal and still might not arrive, and the delivery
 * record says so rather than letting that look like success.
 */
const SMS_MAX_BYTES = 5 * 1024 * 1024;
/**
 * "Messages sent using Sendblue must be less than 18996 characters in length" (sending-messages).
 * Less than, so 18996 itself is over the line — hence `>=` at the check.
 */
const MAX_TEXT_CHARS = 18_996;
/** max_duration_ms "Must be between 1 and 300000" (api-v2/typing-indicators). */
const TYPING_MAX_MS = 300_000;
/**
 * What Sendblue uses when `max_duration_ms` is left out: "Defaults to 60000 (60 seconds)"
 * (api-v2/typing-indicators). Named because a turn that outlives it loses the bubble, which is the
 * whole reason the typing indicator has to be refreshed rather than set once.
 */
export const TYPING_DEFAULT_MS = 60_000;

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
 * Can this exact request succeed later, unchanged?
 *
 * This is the question the outbox has to answer before it retries anything, and it is answered
 * here because this file is the only one that has read Sendblue's error table. Every entry is from
 * sending-messages#error-codes or limits#before-the-first-reply, which states retryability in
 * words ("Can the same request succeed later?") for the pre-reply family.
 *
 *   `false`  the same bytes will be refused again. Retrying is a second failure, not a second
 *            chance: the message has to change, or the person has to text in first.
 *   `true`   the refusal is about this moment — a rate window, a busy server, a dropped socket.
 *
 * Deliberately NOT here: 4010 (PRE_REPLY_OVERRIDE_EXHAUSTED). The docs say it can succeed "after
 * the next 3 AM ET, sent again with pre_reply_override: true" — a different request, tomorrow, and
 * only because somebody chose to spend the override. That is not a retry, so it is permanent to
 * the outbox and the reason says what would actually change it.
 */
const RETRYABLE_CODES = new Set([
  4001,  // Rate Limit Exceeded
  5000,  // Internal Error
  5003,  // Server Rate Exceeded
  5509,  // "Rate limit window exceeded — reduce send frequency or wait for the current window to reset"
  10001, // "Message failed to send"
  10002, // "Failed to resolve message status"
]);
const PERMANENT_CODES = new Set([
  4000, // "Validation Error: see error_message field" — the request is wrong, not early
  4002, // Blacklisted Number (e.g. 911)
  4007, 4008, 4009, 4010, // the pre-reply family; limits says waiting does not help for any of them
]);
/** `SMS_LIMIT_REACHED` is the one documented non-numeric code: "Wait for the limit window to reset". */
const RETRYABLE_STRING_CODES = new Set(["SMS_LIMIT_REACHED"]);

/**
 * One refusal → may the outbox try this again?
 *
 * The order is the order of how much Sendblue is actually telling us. `error_code` is their own
 * table and wins. `error_key` is the field they say to branch on, and every documented key is a
 * rule that a retry cannot satisfy. After that it is the HTTP status, where their own words are
 * unusually clear: a 429 means "slow down ... before retrying", while the declines "return HTTP
 * 400, never HTTP 429, so HTTP clients that retry 429 automatically do not resend them".
 *
 * The default is NOT to retry. An unrecognised refusal retried on a timer is how a messaging
 * system texts somebody six times, and Reason saying "that never went out" once is better than
 * Reason saying it after sending four copies.
 */
export function canRetry({ status = null, errorKey = null, errorCode = null } = {}) {
  if (typeof errorCode === "number") {
    if (RETRYABLE_CODES.has(errorCode)) return true;
    if (PERMANENT_CODES.has(errorCode)) return false;
  }
  if (typeof errorCode === "string" && errorCode) {
    if (RETRYABLE_STRING_CODES.has(errorCode)) return true;
    const n = Number(errorCode);
    if (Number.isFinite(n)) return canRetry({ status, errorKey, errorCode: n });
  }
  // Every key Sendblue documents is a rule about the message or the contact, never about timing.
  if (errorKey && (REFUSALS[errorKey] || errorKey === "unverified_contact_inferred")) return false;
  if (status === 429) return true;          // limits: "slow down your request rate ... before retrying"
  if (status === 408) return true;          // not in the docs; a timeout is a timeout
  if (typeof status === "number" && status >= 500) return true;
  return false;
}

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

  /**
   * One POST, and never a thrown socket error.
   *
   * A dropped connection is reported in the same shape as a refusal, with `transport: true` on it,
   * because the outbox has to tell the two apart: Sendblue saying no is an answer, and never
   * reaching Sendblue is not. `status: 0` is this file's own marker for "no HTTP happened" — it is
   * not a Sendblue code and nothing branches on the number itself.
   */
  async #postJson(path, body) {
    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { ...this.#authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, status: 0, json: null, text: "", transport: (e?.message ?? String(e)).split("\n")[0] };
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is reported as-is */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  /**
   * One refusal: words the model can repeat to the person waiting, plus whether trying again could
   * ever work.
   *
   * The order matters. `error_key` is the field Sendblue says to branch on, so it wins. A 403 is
   * next: the read-receipts endpoint documents 403 as "Contact Not Verified ... Free API plan
   * only", and the free shared line is the plan this install is on — so a 403 on a send is read as
   * the same thing. Everything else comes back as Sendblue's own `error_reason` or message, which
   * the docs say is for display, which is exactly what this is.
   *
   * `retryable` comes from canRetry() rather than from the sentence, so the outbox and the wording
   * can never disagree about whether a message is dead.
   */
  #why(r) {
    const j = r.json ?? {};
    const code = j.error_code ?? null;
    const done = (line, key) => ({ line, key, code, retryable: canRetry({ status: r.status, errorKey: key, errorCode: code }) });

    // Never got there at all. Worth retrying, and worth not calling it a refusal.
    if (r.transport) {
      return {
        line: `Sendblue could not be reached: ${r.transport}`,
        key: "transport", code: null, retryable: true, transport: true,
      };
    }
    const key = j.error_key || (REFUSALS[j.error_message] ? j.error_message : null);
    if (key && REFUSALS[key]) return done(REFUSALS[key], key);
    if (r.status === 403) {
      return done(
        "they need to text this number once first — this is a free shared Sendblue line, and it will only message somebody who has texted it",
        "unverified_contact_inferred",
      );
    }
    const said = j.error_reason || j.error_message || j.message || r.text?.slice(0, 200) || "no body";
    // Sendblue's own wording for the one failure this install has actually seen: a send where
    // `number` equals `from_number` comes back HTTP 400 "Cannot send messages to self". There is no
    // error_key on it, so without this it would read as an unclassified 400 — true but useless,
    // and a 400 is not retried, which is right but for the wrong reason.
    if (r.status === 400 && /cannot send messages to self/i.test(said)) {
      return {
        line: "that is this Sendblue line's own number — it cannot text itself, so there is nobody to send that to",
        key: "cannot_send_to_self", code, retryable: false,
      };
    }
    return { line: `Sendblue refused it (HTTP ${r.status}): ${said}`, key: j.error_key ?? null, code, retryable: canRetry({ status: r.status, errorKey: j.error_key ?? null, errorCode: code }) };
  }

  /**
   * One plain-text message.
   *
   * `idempotencyKey` is accepted and deliberately NOT sent: /api/send-message documents no
   * idempotency field or header (the only documented one is `idempotency_key` on App Card
   * updates). It is kept on the delivery record so the ledger still has it, but Reason calling
   * send twice would produce two texts. See docs/unverified.md.
   */
  /** Sendblue can pin a message under an earlier one (guides/inline-replies). iMessage only. */
  get inlineReplies() { return true; }

  /**
   * No. `content` is plain text and there is no parameter that says otherwise: the full table for
   * POST /api/send-message is number, from_number, content, media_url, app_card, send_style,
   * status_callback, seat_id, reply_to and pre_reply_override (getting-started/sending-messages,
   * read 2026-10-05), and markdown is not mentioned anywhere in Sendblue's documentation. So the
   * markers come off before the text goes out (src/plain.js). That Messages itself draws none of
   * them is the reason this is right and is the one part only a real iPhone can settle — it is in
   * docs/unverified.md.
   */
  get rendersMarkdown() { return false; }

  async send({ to, text, chatId = null, idempotencyKey = null, sendStyle = null, replyTo = null }) {
    const missing = this.missing();
    if (missing.length) {
      return { ok: false, status: "not_connected", error: `Sendblue is not connected: this machine has no ${missing.join(", ")}.` };
    }
    const number = normalizeNumber(to);
    if (!number) return { ok: false, retryable: false, error: `'${to}' is not a phone number Sendblue can send to. It needs E.164, e.g. +14155559876.` };
    // "must be less than 18996 characters", so 18996 is already too many. Not retryable: the same
    // bytes are the same length tomorrow.
    if (String(text ?? "").length >= MAX_TEXT_CHARS) {
      return { ok: false, retryable: false, error: `that message is ${String(text).length} characters; Sendblue takes fewer than ${MAX_TEXT_CHARS}. Send it as more than one message.` };
    }
    // An unknown effect is caught here rather than sent: a bad `send_style` would take the whole
    // message down with it, and a lost message is a far worse outcome than a missing animation.
    if (sendStyle) {
      const style = checkSendStyle(sendStyle);
      if (!style.ok) return { ok: false, retryable: false, error: style.error };
    }

    const body = { number, from_number: this.from, content: text, ...(sendStyle ? { send_style: sendStyle } : {}) };
    const under = String(replyTo ?? "").trim();
    let r = await this.#postJson("/api/send-message", under ? { ...body, reply_to: { message_handle: under } } : body);
    // The reply was refused, so NOTHING was sent: "a rejected reply is not sent as a standalone
    // message and is not downgraded to SMS" and it comes back as a 400. The docs give that 400 no
    // error key, so it cannot be told apart from any other refusal — and it does not need to be.
    // The same message goes once more without the pin: if the pin was the problem it now arrives,
    // and if something else was, the second answer is the real reason. Only on a 400, never on a
    // timeout or a 5xx, where "nothing was sent" is not known and a second POST could be a second
    // text.
    let replyDropped = null;
    if (under && r.status === 400) {
      replyDropped = String(r.json?.message ?? r.json?.error_message ?? "Sendblue would not pin it under that message").slice(0, 200);
      r = await this.#postJson("/api/send-message", body);
    }
    // A 200 whose body says DECLINED is still a refusal: "A declined send returns HTTP 400" is the
    // documented case, but the status field is the authority on whether it went (limits).
    if (!r.ok || r.json?.status === "DECLINED" || r.json?.status === "ERROR") {
      const why = this.#why(r);
      return {
        ok: false, error: why.line, error_key: why.key, error_code: why.code,
        http_status: r.status, retryable: why.retryable,
      };
    }
    return { ok: true, delivered: this.#deliveredFrom(r, { number, chatId, idempotencyKey, replyDropped }) };
  }

  /**
   * One message carrying text and a file Sendblue fetches by address.
   *
   * The documented route for a contact card (guides/contact-card): `number` and a `media_url` that
   * is "a downloadable or accessible link" ending in `.vcf` or `.vcard`, with no space in it.
   * Sendblue downloads it from their side, so the address has to be reachable from the internet —
   * which is why src/contact.js refuses to call this without REASON_PUBLIC_URL. `content` is
   * allowed alongside (sending-messages), so the card and its one line are ONE message.
   */
  async sendMediaUrl({ to, text = "", mediaUrl, chatId = null, idempotencyKey = null }) {
    const missing = this.missing();
    if (missing.length) {
      return { ok: false, supported: true, status: "not_connected", error: `Sendblue is not connected: this machine has no ${missing.join(", ")}.` };
    }
    const number = normalizeNumber(to);
    if (!number) return { ok: false, supported: true, retryable: false, error: `'${to}' is not a phone number Sendblue can send to. It needs E.164, e.g. +14155559876.` };
    const url = String(mediaUrl ?? "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) return { ok: false, supported: true, retryable: false, error: `'${mediaUrl}' is not an address Sendblue can fetch a file from.` };

    const r = await this.#postJson("/api/send-message", {
      number, from_number: this.from, ...(text ? { content: text } : {}), media_url: url,
    });
    if (!r.ok || r.json?.status === "DECLINED" || r.json?.status === "ERROR") {
      const why = this.#why(r);
      return {
        ok: false, supported: true, error: why.line, error_key: why.key, error_code: why.code,
        http_status: r.status, retryable: why.retryable,
      };
    }
    return { ok: true, supported: true, delivered: this.#deliveredFrom(r, { number, chatId, idempotencyKey, media: { media_url: url, renders_as: /\.vcf$|\.vcard$/i.test(url) ? "contact card" : "attachment" } }) };
  }

  #deliveredFrom(r, { number, chatId, idempotencyKey, media = null, replyDropped = null }) {
    return {
      channel: this.name,
      to: number,
      chat_id: r.json?.group_id || chatId || null,
      message_id: r.json?.message_handle ?? null,
      from: r.json?.from_number ?? this.from,
      service: r.json?.service ?? null,
      status: r.json?.status ?? null,
      // "was_downgraded: True if the end user does not support iMessage" (sending-messages). Kept
      // because it is the one field that says this text went as an SMS — which is also what says a
      // tapback, a typing bubble or a read receipt on this conversation would be refused.
      was_downgraded: r.json?.was_downgraded ?? null,
      // Echoed back by Sendblue as "" when none was used, so this is what actually happened to the
      // bubble rather than what was asked for.
      send_style: r.json?.send_style || null,
      // What it ended up pinned under, read off Sendblue's answer rather than off what was asked
      // for — and, when the pin was refused and the message went anyway, why.
      reply_to: r.json?.reply_to?.message_handle || null,
      ...(replyDropped ? { reply_dropped: replyDropped } : {}),
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
      return {
        ok: false, supported: true, error: why.line, error_key: why.key, error_code: why.code,
        http_status: r.status, retryable: why.retryable,
      };
    }
    // Two different ceilings, so two different warnings, and the SMS one is the one that bites: a
    // file that is fine over iMessage has to be squeezed under 5 MB if the recipient turns out not
    // to have iMessage, and the docs say that squeeze can fail the whole message.
    const notes = [];
    if (size > RECOMMENDED_BYTES) notes.push(`${mb(size)}MB is over Sendblue's recommended 20MB for reliable delivery`);
    if (size > SMS_MAX_BYTES) {
      notes.push(`${mb(size)}MB is over the ${mb(SMS_MAX_BYTES)}MB SMS ceiling, so if this falls back to SMS Sendblue has to compress it and the message fails if that does not work`);
    }
    return {
      ok: true, supported: true,
      delivered: this.#deliveredFrom(r, {
        number, chatId, idempotencyKey,
        media: {
          file, mimeType, filename: name, bytes: size, media_url: upJson.media_url,
          // Said out loud on the record rather than left for somebody to wonder about.
          renders_as: name.toLowerCase().endsWith(".caf") ? "voice memo" : "attachment",
          ...(notes.length ? { note: notes.join("; ") } : {}),
        },
      }),
    };
  }

  /**
   * The "…" bubble. Per-recipient rather than per-chat: Sendblue's typing endpoint takes `number`,
   * and it needs an existing conversation ("No route mapping found for number, have you messaged
   * them before?" — a 400). iMessage only, best effort, and a failure here is never worth failing a
   * turn over, so it comes back as a reason rather than an exception.
   *
   * Three things in here are read off api-v2/typing-indicators rather than assumed:
   *
   *   - `from_number` is optional on this endpoint, unlike /api/send-message where it is required.
   *     It is still sent, because an account with more than one line should not be left to Sendblue
   *     to guess at, but a missing line is not a reason to refuse to try.
   *   - the bubble has an expiry, and leaving `max_duration_ms` out does not mean "forever": it
   *     "Defaults to 60000 (60 seconds)". So one `start` at the top of a long turn shows a bubble
   *     that quietly vanishes a minute in. The duration is always sent explicitly and always
   *     returned as `expires_at`, so the caller can refresh before it lapses instead of hoping.
   *   - a 503 is specifically "Worker firmware ... does not yet support typing-v2", and the docs
   *     say in the same breath that "Legacy start requests with no duration are unaffected and
   *     always succeed". So a 503 on a start is retried once as a bare legacy start rather than
   *     reported as a failure; the result says `degraded: true` and gives the 60-second default as
   *     the expiry, because that is what an old worker will do with it.
   *
   * `on: false` sends state "stop", which the docs call a safe no-op when nothing is showing. A 503
   * on a stop is NOT retried as a legacy call — there is no legacy stop, so the honest answer is
   * that the bubble will time out on its own.
   */
  async typing({ to, chatId = null, on, maxDurationMs = null }) {
    void chatId;
    if (this.missing().length) return { ok: true, supported: false };
    const number = normalizeNumber(to);
    if (!number) return { ok: false, supported: true, error: "Sendblue's typing indicator needs the recipient's number in E.164." };

    if (!on) {
      const r = await this.#postJson("/api/send-typing-indicator", { number, from_number: this.from, state: "stop" });
      const bad = this.#typingFailure(r);
      return bad ? { ok: false, supported: true, ...bad } : { ok: true, supported: true, state: "stop" };
    }

    const ms = Math.min(Math.max(1, Math.round(maxDurationMs ?? TYPING_DEFAULT_MS)), TYPING_MAX_MS);
    const r = await this.#postJson("/api/send-typing-indicator", {
      number, from_number: this.from, state: "start", max_duration_ms: ms,
    });
    const bad = this.#typingFailure(r);
    if (!bad) return { ok: true, supported: true, state: "start", duration_ms: ms, expires_at: this.now() + ms };

    // The one documented recovery: an older worker takes a start with no duration and nothing else.
    if (bad.http_status === 503) {
      const legacy = await this.#postJson("/api/send-typing-indicator", { number, from_number: this.from });
      const stillBad = this.#typingFailure(legacy);
      if (!stillBad) {
        return {
          ok: true, supported: true, state: "start", degraded: true,
          duration_ms: TYPING_DEFAULT_MS, expires_at: this.now() + TYPING_DEFAULT_MS,
          note: `this line's worker does not support typing-v2 yet (${bad.error}), so the bubble runs on Sendblue's 60s default and cannot be stopped early`,
        };
      }
      return { ok: false, supported: true, ...stillBad };
    }
    return { ok: false, supported: true, ...bad };
  }

  /**
   * Did a typing call fail, and in whose words? Null when it worked.
   *
   * The success body is `{ status: "QUEUED", status_code: 200, error_message: null, number }` — not
   * "OK" — and every documented error body carries its HTTP code again inside as `status_code`.
   * That inner code is trusted over `res.status` when they differ, because it is the one the docs
   * attach the firmware explanation to.
   */
  #typingFailure(r) {
    const j = r.json ?? {};
    const code = Number(j.status_code ?? r.status) || r.status;
    if (r.transport) return { error: `Sendblue could not be reached: ${r.transport}`, http_status: 0 };
    if (r.ok && j.status !== "ERROR") return null;
    const said = j.error_message ?? j.detail ?? j.message ?? `HTTP ${code}`;
    if (code === 400 && /no route mapping/i.test(String(said))) {
      // Sendblue's own sentence is kept — it is the thing to search for in a log — with what it
      // actually means in front of it, because "no route mapping" is not a sentence about a person.
      return { error: `there is no conversation with that number yet, so there is no thread to show a typing bubble in (${said})`, http_status: 400 };
    }
    return { error: String(said), http_status: code };
  }

  /**
   * A tapback on a message Reason received.
   *
   * POST /api/send-reaction with from_number, the message_handle from an inbound webhook, and the
   * reaction (api-v2/reactions). The value itself is checked before the request by
   * checkReaction() — Sendblue validates it strictly and publishes the grammar, so a bad value is
   * worth catching here rather than spending a round trip on.
   *
   * What the docs are firm about, and what each means here:
   *
   *   only RECEIVED messages      an outbound message, an SMS or RCS one, an attachment-specific
   *                               handle and an App Card all return 422. So this is only ever
   *                               pointed at a handle that came off a `receive` webhook.
   *   422 unsupported_on_this_line  not every Sendblue number supports reactions. A permanent fact
   *                               about the LINE, so it is remembered and not re-asked.
   *   422 unsupported_target      this particular message cannot take one. About the MESSAGE, not
   *                               the line, so nothing is remembered — the next message may be fine.
   *   404                         an unknown handle, or one belonging to another account.
   *   part_index                  for a multi-part message, with the PRIMARY handle.
   *
   * "Reactions can be sent to messages received within the last few days. Very old messages may not
   * accept reactions" — so a stale handle failing is expected, and says so rather than looking broken.
   */
  async react({ messageHandle, reaction, partIndex = null }) {
    if (this.missing().length) return { ok: false, supported: false, error: "Sendblue is not connected" };
    const handle = String(messageHandle ?? "").trim();
    if (!handle) return { ok: false, supported: true, error: "a tapback needs the handle of the message it is going on, and there isn't one." };
    const check = checkReaction(reaction);
    if (!check.ok) return { ok: false, supported: true, error: check.error };

    const body = { from_number: this.from, message_handle: handle, reaction: check.value };
    if (Number.isInteger(partIndex) && partIndex >= 0) body.part_index = partIndex;

    const r = await this.#postJson("/api/send-reaction", body);
    if (r.transport) return { ok: false, supported: true, error: `Sendblue could not be reached: ${r.transport}` };
    const j = r.json ?? {};
    if (r.ok && j.status !== "ERROR") return { ok: true, supported: true, reaction: j.reaction ?? check.value, removing: check.removing };

    // Their error bodies are two fields with two jobs: `message` is the stable key
    // (`unsupported_on_this_line`, `unsupported_target`) and `detail` is the sentence for a human
    // ("This line cannot deliver reactions."). So the branch reads the key and the wording reads
    // the detail — branching on the sentence would break the moment they reworded it.
    const key = String(j.message ?? "").trim();
    const said = j.detail || j.message || r.text?.slice(0, 200) || `HTTP ${r.status}`;
    // Two different 422s with the same status and different meanings. Only the line one is a fact
    // worth keeping: it is true for every contact forever and only Sendblue's support can change it.
    if (r.status === 422 && /unsupported_on_this_line/i.test(key)) {
      return {
        ok: false, supported: true, http_status: 422, error: `this Sendblue line cannot send tapbacks (${said})`,
        remember: { scope: "line", why: `this Sendblue line cannot send tapbacks (${said})` },
      };
    }
    if (r.status === 422) {
      return {
        ok: false, supported: true, http_status: 422,
        error: `that message cannot take a tapback — Sendblue only puts them on iMessages it received, and not on App Cards or attachments (${said})`,
      };
    }
    if (r.status === 404) {
      return {
        ok: false, supported: true, http_status: 404,
        error: `Sendblue does not have that message any more. Tapbacks only work on messages from the last few days (${said})`,
      };
    }
    return { ok: false, supported: true, http_status: r.status, error: said };
  }

  /**
   * Mark this conversation read, so the sender's message shows "Read" instead of sitting there
   * looking unseen while a turn runs.
   *
   * POST /api/mark-read with `number` and `from_number` (api-v2/read-receipts). Unlike the typing
   * bubble this is NOT iMessage-only — "The request marks the conversation as read on your line
   * whether it is iMessage, RCS, or SMS", and only the visible result differs, since SMS has no
   * read status to show. So nothing here gates on `service`.
   *
   * The documented failures are what make this worth a method rather than a one-liner, because two
   * of them are permanent facts worth remembering and the rest are not:
   *
   *   422 unsupported_on_this_line   this LINE cannot do read receipts. True for every contact, and
   *                                  only Sendblue support can change it. `scope: "line"`.
   *   403 Contact Not Verified       free plan only, this CONTACT is not verified. `scope:
   *                                  "contact"`. Odd here — they just texted in, which is what
   *                                  verifies them — so it is reported rather than explained away.
   *   503 worker_unavailable /       the line is momentarily not connected. Transient; nothing is
   *       worker_version_unsupported  remembered, because it will work later.
   *   429                            rate limited on this endpoint. Transient.
   *   404 The from_number is not registered / 400 missing field — a misconfiguration, so permanent
   *                                  for the line, and said in Sendblue's own words.
   *
   * `remember` is what the caller stores so it never asks again; its absence means ask next time.
   */
  async markRead({ to }) {
    if (this.missing().length) return { ok: false, supported: false, error: "Sendblue is not connected" };
    const number = normalizeNumber(to);
    if (!number) return { ok: false, supported: true, error: `'${to}' is not a number in E.164, so there is no conversation to mark read` };

    const r = await this.#postJson("/api/mark-read", { number, from_number: this.from });
    if (r.transport) return { ok: false, supported: true, error: `Sendblue could not be reached: ${r.transport}` };

    const j = r.json ?? {};
    const said = j.detail || j.message || r.text?.slice(0, 200) || `HTTP ${r.status}`;
    if (r.ok && j.status !== "ERROR") return { ok: true, supported: true };

    if (r.status === 422) {
      return { ok: false, supported: true, http_status: 422, error: said, remember: { scope: "line", why: `this Sendblue line cannot send read receipts (${said})` } };
    }
    if (r.status === 403) {
      return { ok: false, supported: true, http_status: 403, error: said, remember: { scope: "contact", why: `this contact is not verified for read receipts on the free plan (${said})` } };
    }
    if (r.status === 404 || r.status === 400) {
      return { ok: false, supported: true, http_status: r.status, error: said, remember: { scope: "line", why: `Sendblue refused the read receipt and will keep refusing it (${said})` } };
    }
    // 503 and 429 are both "not now". Nothing is remembered, so the next message tries again.
    return { ok: false, supported: true, http_status: r.status, error: said, transient: true };
  }

  /**
   * Read the current location of a contact who is already sharing with this line (api-v2/
   * location-sharing). Returns their latest cached fix without sending a request card. A contact
   * must already be sharing — either they accepted a request_location, or they started sharing
   * from Find My on their own — otherwise Sendblue returns an empty locations array.
   */
  async readLocation({ number: raw }) {
    if (this.missing().length) return { ok: false, supported: false, error: "Sendblue is not connected" };
    const number = normalizeNumber(raw);
    if (!number) return { ok: false, supported: true, error: `'${raw}' is not a number in E.164` };

    const q = new URLSearchParams({ from_number: this.from });
    let res;
    try {
      res = await this.fetch(`${this.base}/api/location/${encodeURIComponent(number)}?${q}`, {
        method: "GET", headers: { ...this.#authHeaders },
      });
    } catch (e) {
      return { ok: false, supported: true, error: `Sendblue could not be reached: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* reported as-is */ }

    if (!res.ok) {
      const said = json?.message ?? json?.detail ?? text?.slice(0, 200) ?? `HTTP ${res.status}`;
      return { ok: false, supported: true, http_status: res.status, error: said };
    }

    const loc = json?.location ?? null;
    if (!loc || loc.latitude == null || loc.longitude == null) {
      return { ok: true, supported: true, sharing: false };
    }

    const geo = await reverseGeocode(loc.latitude, loc.longitude).catch(() => null);
    return {
      ok: true, supported: true, sharing: true,
      latitude: loc.latitude, longitude: loc.longitude,
      accuracy: loc.accuracy ?? null, altitude: loc.altitude ?? null,
      timestamp: loc.timestamp ?? null,
      address: geo?.display_name ?? loc.address ?? null,
      expires_at: loc.expiresAt ?? null,
    };
  }

  /**
   * Send a native "Share My Location" request card (api-v2/location-sharing). The recipient sees
   * it in iMessage and can accept with a duration. When they do, the shared location arrives on
   * the receive webhook as message_type "location" with a location object — the same path that
   * describe() already handles.
   */
  async requestLocation({ number: raw }) {
    if (this.missing().length) return { ok: false, supported: false, error: "Sendblue is not connected" };
    const number = normalizeNumber(raw);
    if (!number) return { ok: false, supported: true, error: `'${raw}' is not a number in E.164` };

    const r = await this.#postJson("/api/request-location", { number, from_number: this.from });
    if (r.transport) return { ok: false, supported: true, error: `Sendblue could not be reached: ${r.transport}` };

    const j = r.json ?? {};
    if (r.ok && j.status !== "ERROR") {
      return { ok: true, supported: true, status: j.status ?? "QUEUED" };
    }

    const said = j.detail || j.message || j.error_message || r.text?.slice(0, 200) || `HTTP ${r.status}`;
    return { ok: false, supported: true, http_status: r.status, error: said };
  }

  /**
   * Did this message already go out? Asked only about a send that was interrupted mid-flight.
   *
   * `GET /api/v2/messages` is the documented way to look (api-v2/messages): `number` filters to
   * "either party's phone", `is_outbound=true` to things this account sent, and `created_at_gte` /
   * `created_at_lte` to the window the interrupted attempt happened in. The window matters — the
   * same reply text could legitimately have been sent to the same person yesterday, and finding
   * yesterday's copy would make Reason drop today's.
   *
   * The match is on content, because content is all there is: /api/send-message takes no
   * idempotency key and returns the `message_handle` only in the response that was lost. A message
   * whose text is empty (a bare attachment) therefore cannot be matched and says so rather than
   * matching the first thing in the window.
   */
  async findSent({ to, text, since, until }) {
    if (this.missing().length) return { ok: false, error: "Sendblue is not connected, so it cannot be asked" };
    const number = normalizeNumber(to);
    if (!number) return { ok: false, error: `'${to}' is not a number Sendblue could have sent to` };
    const body = String(text ?? "");
    if (!body) return { ok: false, error: "there is no text to match on, so Sendblue cannot be asked whether this one went" };

    const q = new URLSearchParams({
      number,
      is_outbound: "true",
      limit: "100",
      created_at_gte: new Date(since).toISOString(),
      created_at_lte: new Date(until).toISOString(),
    });
    let res;
    try {
      res = await this.fetch(`${this.base}/api/v2/messages?${q}`, { method: "GET", headers: { ...this.#authHeaders } });
    } catch (e) {
      return { ok: false, error: `Sendblue could not be reached to ask: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* reported as-is */ }
    if (!res.ok || !Array.isArray(json?.data)) {
      return { ok: false, error: `Sendblue would not answer (HTTP ${res.status}): ${json?.message ?? raw?.slice(0, 200) ?? "no body"}` };
    }

    const hit = json.data.find(m => String(m.content ?? "") === body);
    // A row that exists but says ERROR or DECLINED is not a delivery. It went to Sendblue and
    // Sendblue refused it, which is the same end state as never sending it — so `found: false`,
    // with the reason carried so the outbox does not have to go and ask twice.
    if (hit && (hit.status === "ERROR" || hit.status === "DECLINED")) {
      return { ok: true, found: false, refused: String(hit.status), message_id: hit.message_handle ?? null };
    }
    return hit
      ? { ok: true, found: true, message_id: hit.message_handle ?? null, status: hit.status ?? null }
      : { ok: true, found: false };
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
   *     because Sendblue's webhooks are account-level and all lines share them. The full list is
   *     nine: receive, outbound, typing_indicator, call_log, inbound_call, line_blocked,
   *     line_assigned, contact_profile, contact_created (webhooks#webhook-types). Only `receive`
   *     and `outbound` are documented field by field; `line_blocked`, `line_assigned` and
   *     `contact_created` have no published payload at all, so they are dropped by having neither a
   *     message_handle nor a sender rather than by a guess at their shape.
   *   - group messages. A non-empty group_id means several people, and every account, ledger row
   *     and confirmation in Reason belongs to ONE person — so a group is never silently treated as
   *     that person's DM. It is logged as ignored, which is honest, rather than answered.
   *
   * What is NOT in here, because the docs do not carry it: an inbound tapback. No webhook type is a
   * reaction, `message_type` is documented as exactly "message or group" (api-v2/messages), and
   * neither the receive nor the outbound payload has a reaction field. Sendblue can SEND a tapback
   * (api-v2/send-reaction) and documents no way to hear about one.
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
    const said = String(event.number || event.from_number || "").trim();
    const from = normalizeNumber(said);
    const externalId = String(event.message_handle ?? "");

    // An iMessage can come from an Apple ID rather than a phone ("Can receive from iCloud email
    // addresses" — faq), and an address is not a number: normalizeNumber strips it to nothing.
    // Said out loud as its own reason, because a real person texting from their Apple ID being
    // dropped as a malformed payload is the kind of silence that takes a night to find.
    if (externalId && !from && said.includes("@")) {
      return { status: 200, body: { ok: true, ignored: "sender is an email address, not a phone number", from: said }, inbound: [] };
    }
    if (!externalId || !from) {
      return { status: 200, body: { ok: true, ignored: "no message_handle or sender" }, inbound: [] };
    }

    // Which message this is, and which part of it. `externalId` stays the FULL handle, because it
    // is the dedupe key and each part is its own at-least-once delivery; `baseHandle` is what says
    // these three webhooks were one thing somebody sent.
    const { base, partIndex } = splitHandle(externalId);
    const attachment = attachmentOf(event.media_url);

    return {
      status: 200,
      body: { ok: true },
      inbound: [{
        channel: this.name,
        externalId,
        from,
        text: await describe(event),
        // The words on their own, with nothing added. `text` above is what a turn reads; this is
        // what the part rules look at, and the difference matters: a part whose only content is a
        // description Reason wrote is not a part that carried anything.
        said: String(event.content ?? "").trim(),
        messageHandle: externalId,
        // Sent as an inline reply under this message (guides/inline-replies: "Reply relationships
        // are returned on ... inbound/outbound message webhooks"). A handle and nothing more: what
        // that message SAID is the router's to look up, in the one conversation it belongs to.
        replyTo: String(event.reply_to?.message_handle ?? "").trim() || null,
        // The message the thread started with. Apple's record of the thread, and the one that held
        // up when the two disagreed (note 8 above): a reply read against the wrong parent answered
        // the wrong question.
        threadRoot: String(event.thread_originator?.message_handle ?? "").trim() || null,
        baseHandle: base,
        partIndex,
        // Structured rather than only described, so an image can actually be fetched and looked at.
        attachments: attachment ? [attachment] : [],
        // Sendblue has no thread id for a one-to-one conversation — group_id is the only one it
        // has, and a group never gets here. The recipient's number is the thread.
        chatId: null,
        // Which rail this arrived on: "iMessage", "SMS" or "RCS". Carried because the three things
        // Reason can do back to a thread — a typing bubble, a read receipt, a tapback — are all
        // iMessage-only, and knowing is better than finding out from a 422 every time.
        service: String(event.service ?? "").trim() || null,
        at: Date.parse(event.date_sent ?? "") || this.now(),
      }],
    };
  }

  /**
   * Fetch recent inbound messages from Sendblue and return any that this process has not seen.
   *
   * Called once at startup so a restart gap (the 10–15 seconds between SIGTERM and the new process
   * listening) does not silently eat a message. Sendblue delivers webhooks at least once with 3
   * retries on 5xx and a 45-second timeout — but if the server is down for ALL of those attempts the
   * message is gone. This poll covers that window.
   *
   * `windowMs` defaults to 90 seconds — generous enough to cover a restart plus Sendblue's retry
   * window, short enough that the query is small. The router's `claimInbound` dedupe means anything
   * already processed is skipped for free.
   */
  async catchUp({ windowMs = 90_000 } = {}) {
    if (this.missing().length) return { ok: false, skipped: true, why: "not connected" };
    const owner = await this.ownsWebhook();
    if (!owner.owns) return { ok: false, skipped: true, why: owner.why };
    const since = new Date(this.now() - windowMs).toISOString();
    const q = new URLSearchParams({
      is_outbound: "false",
      limit: "50",
      created_at_gte: since,
    });
    let res;
    try {
      res = await this.fetch(`${this.base}/api/v2/messages?${q}`, {
        method: "GET", headers: { ...this.#authHeaders },
      });
    } catch (e) {
      return { ok: false, error: `could not reach Sendblue: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    let json;
    try { json = await res.json(); } catch { return { ok: false, error: `Sendblue returned non-JSON (HTTP ${res.status})` }; }
    if (!res.ok || !Array.isArray(json?.data)) {
      return { ok: false, error: `Sendblue refused (HTTP ${res.status}): ${json?.message ?? "unknown"}` };
    }

    const messages = [];
    for (const m of json.data) {
      if (m.is_outbound) continue;
      if (m.group_id) continue;
      const handle = String(m.message_handle ?? "");
      const from = normalizeNumber(m.number || m.from_number || "");
      if (!handle || !from) continue;
      const { base, partIndex } = splitHandle(handle);
      const attachment = attachmentOf(m.media_url);
      messages.push({
        channel: this.name,
        externalId: handle,
        from,
        text: await describe(m),
        said: String(m.content ?? "").trim(),
        messageHandle: handle,
        replyTo: String(m.reply_to?.message_handle ?? "").trim() || null,
        threadRoot: String(m.thread_originator?.message_handle ?? "").trim() || null,
        baseHandle: base,
        partIndex,
        attachments: attachment ? [attachment] : [],
        chatId: null,
        service: String(m.service ?? "").trim() || null,
        at: Date.parse(m.date_sent ?? m.created_at ?? "") || this.now(),
      });
    }
    return { ok: true, messages };
  }

  /**
   * Whether Sendblue's receive webhook points at THIS install.
   *
   * Every install holding the same Sendblue keys can read the messages API, but only one of them is
   * the one Sendblue delivers to, and only that one may catch up. On 2026-10-12 an idle copy on Fly
   * restarted, pulled a text meant for the live install out of the API, and answered it from a
   * database three days stale — in a different voice, with none of the live install's memory. So
   * before a catch-up, ask Sendblue who it delivers to (GET /api/account/webhooks) and refuse unless
   * the receive list names `${REASON_PUBLIC_URL}/channels/sendblue/webhook`.
   *
   * Any doubt is a no: no public URL, the call failing, an answer in a shape this does not know. A
   * restart-gap message lost that way costs one text; a stray install answering costs trust. The
   * webhook route itself is untouched — Sendblue still delivers to whoever it delivers to.
   */
  async ownsWebhook() {
    const mine = webhookUrlOf(config.publicUrl);
    if (!mine) return { owns: false, why: "no REASON_PUBLIC_URL, so this install cannot be the one Sendblue delivers to" };
    let res;
    try {
      res = await this.fetch(`${this.base}/api/account/webhooks`, { method: "GET", headers: { ...this.#authHeaders } });
    } catch (e) {
      return { owns: false, why: `could not ask Sendblue who it delivers to: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    let json;
    try { json = await res.json(); } catch { return { owns: false, why: `Sendblue returned non-JSON (HTTP ${res.status}) when asked who it delivers to` }; }
    const receive = json?.webhooks?.receive;
    if (!res.ok || !Array.isArray(receive)) return { owns: false, why: `Sendblue refused (HTTP ${res.status}) when asked who it delivers to` };
    const listed = receive.map(e => normalizeUrl(typeof e === "string" ? e : e?.url)).filter(Boolean);
    if (!listed.includes(mine)) {
      return { owns: false, why: `Sendblue delivers to ${listed.length ? listed.join(", ") : "nobody"}, not ${mine}` };
    }
    return { owns: true, why: "" };
  }
}

/** The receive webhook this install would own, or "" when it has no public address. */
function webhookUrlOf(publicUrl) {
  const base = normalizeUrl(publicUrl);
  return base ? `${base}/channels/sendblue/webhook` : "";
}

/** Trailing slashes and letter case never make two addresses different installs. */
function normalizeUrl(u) {
  return String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

function lowerKeys(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** The extensions Apple renders as an inline voice memo, which is the only audio hint the docs give. */
const VOICE_EXTS = [".caf", ".amr"];
/** Everything else that is obviously sound rather than a document (api-v2/media's audio row). */
const AUDIO_EXTS = [".m4a", ".mp3", ".aac", ".wav", ".aiff"];
/**
 * Extensions that mean "this is a picture somebody took or screenshotted".
 *
 * Wider than the set a model can actually read: .heic is what an iPhone shoots by default and
 * Claude takes JPEG, PNG, GIF and WebP only. Both facts are kept, in different places — this list
 * decides what a thing IS, and src/media.js decides whether it can be looked at and says so when
 * it cannot. Calling a photo "a file you cannot open" because of its container would be the same
 * lie in a new coat.
 */
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"];
/** A contact card shared from the Contacts app — always a vCard (.vcf or .vcard). */
const CONTACT_EXTS = [".vcf", ".vcard"];
/** A PDF — receipts, tickets, boarding passes, menus, leases. Read on this machine by src/pdf.js. */
const PDF_EXTS = [".pdf"];
/** A video sent from the camera roll or screen-recorded. .mov is what iPhones shoot by default. */
const VIDEO_EXTS = [".mov", ".mp4", ".m4v", ".avi", ".webm", ".mkv", ".3gp"];

/**
 * One message_handle → the message it belongs to, and which part of that message this is.
 *
 * Sendblue's docs describe multi-part messages without ever describing this suffix. What they DO
 * say (api-v2/reactions) is that a message with attachments has one "primary message_handle" plus
 * parts selected by `part_index`, and that "an attachment-specific handle returns 422" — so an
 * attachment-specific handle exists, is a different string from the primary one, and is not the
 * thing to point an API call at. They never say what one looks like.
 *
 * One real iMessage on this install — a line of text, then a pasted link, which iMessage renders
 * as a rich link card — arrived as THREE separate `receive` webhooks, ten seconds apart:
 *
 *   E32ECEF5-…        the text and the link
 *   E32ECEF5-…_1      empty content, a media_url
 *   E32ECEF5-…_2      empty content, a media_url
 *
 * So `_N` is read as the attachment-specific handle for part N of the message whose primary handle
 * is the stem. That reading comes from observed traffic, not from the docs — see
 * docs/unverified.md. The suffix is greedy on purpose: a stem that itself ends in `_1` keeps it.
 */
export function splitHandle(handle) {
  const h = String(handle ?? "");
  const m = /^(.+)_(\d+)$/.exec(h);
  return m ? { base: m[1], partIndex: Number(m[2]) } : { base: h, partIndex: 0 };
}

/**
 * One `media_url` → what kind of thing it is, by the only clue the payload carries.
 *
 * There is no content type on an inbound message: `media_url` is "A CDN link to any media attached
 * to the message" and that is the whole of it (receiving-messages). So the extension on the path is
 * all there is, and the honest consequence is that a link with no extension is "a file" rather than
 * a guess. Returns null when there is no attachment at all.
 */
export function attachmentOf(mediaUrl) {
  const url = String(mediaUrl ?? "").trim();
  if (!url) return null;
  const filename = url.split("?")[0].split("/").pop() || url;
  const lower = filename.toLowerCase();
  const kind = VOICE_EXTS.some(e => lower.endsWith(e)) ? "voice"
    : AUDIO_EXTS.some(e => lower.endsWith(e)) ? "audio"
      : IMAGE_EXTS.some(e => lower.endsWith(e)) ? "image"
        : PDF_EXTS.some(e => lower.endsWith(e)) ? "pdf"
          : VIDEO_EXTS.some(e => lower.endsWith(e)) ? "video"
            : CONTACT_EXTS.some(e => lower.endsWith(e)) ? "contact"
              : "file";
  return { url, filename, kind };
}

/**
 * The line a turn reads when a contact card arrived and nothing has read it yet. Same role as
 * cannotHearLine in voice.js: it is the exact string the drain replaces once the card IS read.
 */
export function cannotReadContactLine(a) {
  return `[they shared a contact card (${a.filename}), which you cannot read yet]`;
}

/**
 * What they actually said. An attachment is described in a line rather than dropped, so Reason
 * answers "they sent a photo" instead of an empty message it has no explanation for. Inbound
 * media_url expires after 30 days (receiving-messages), which is another reason not to pretend
 * Reason can open it.
 *
 * A voice memo is called a voice memo. ".caf files are rendered as voice memos on the recipient's
 * device" is documented for the sending direction only, and Sendblue documents no inbound field
 * that says "this one is a voice note" — so the extension is all there is to go on, and the line
 * Reason reads says what it is AND that Reason has not heard it. Nothing here transcribes audio:
 * the transcriber in this repo is wired to video, and a voice note arriving as text Reason never
 * actually listened to would be the exact lie these lines exist to avoid.
 */
async function describe(event) {
  const parts = [];
  const content = String(event.content ?? "").trim();
  if (content) parts.push(content);
  const a = attachmentOf(event.media_url);
  if (a && isAudio(a)) {
    // The honest default. The router swaps this exact line for what was said once the note has
    // actually been listened to (src/voice.js), and leaves it alone when nothing here can listen.
    parts.push(cannotHearLine(a));
  } else if (a && a.kind === "contact") {
    parts.push(cannotReadContactLine(a));
  } else if (a && a.kind === "file") {
    parts.push(`[they sent a file, which you cannot open: ${a.filename}]`);
  }
  // A picture is deliberately NOT described here. It is fetched and handed to the model as an
  // image (src/media.js), so a sentence saying what it is would either duplicate what the model
  // can see for itself or contradict it. Whoever assembles the turn owns that line, because only
  // they know whether the running backend can take a picture at all.
  // A PDF is the same: it is fetched and read on this machine (src/pdf.js), and the text is
  // handed to the model by the turn (src/media.js:pdfsFor). A sentence here would either
  // duplicate what the model can read or claim it cannot when it can.
  // An effect THEY used. `send_style` is on the documented receive payload ("Expressive message
  // style if used (empty string if none)"), so this one really is readable — and worth reading: an
  // answer that is oblivious to somebody sending "we got the table" with fireworks on it has
  // missed what they meant by it. The reverse, a tapback somebody put on a message of Reason's,
  // is in no webhook Sendblue publishes; see the note at the top of this file.
  const style = String(event.send_style ?? "").trim();
  if (style) parts.push(`[they sent that with the '${style}' screen effect on it — that is them being emphatic, so read it that way]`);
  // Location share via Find My (api-v2/location-sharing: message_type "location" + a location
  // object with lat/lng). This is the real thing — they accepted a share and Sendblue delivered
  // the coordinates. request_location is how Reason asks for one.
  if (event.message_type === "location" && event.location) {
    const loc = event.location;
    const coords = `${loc.latitude}, ${loc.longitude}`;
    const acc = loc.accuracy != null ? `, accuracy ~${Math.round(loc.accuracy)}m` : "";
    const dur = loc.duration ? ` (sharing: ${loc.duration})` : "";
    const geo = await reverseGeocode(loc.latitude, loc.longitude).catch(() => null);
    if (geo?.display_name) {
      parts.push(`[they shared their location: ${geo.display_name} (${coords}${acc})${dur} — use this as their current position for anything location-related. Use nearby_places with these coordinates to find places near them]`);
    } else {
      parts.push(`[they shared their location: ${coords}${acc}${dur} — use this as their current position for anything location-related]`);
    }
  } else if (event.app_card) {
    parts.push("[they sent an iMessage app card — this is often a location share, but could be a game, a sticker or another app. You cannot read what is in it. If context suggests they were trying to share where they are, use get_location to check whether their coordinates are available]");
  }
  return parts.join("\n").trim();
}
