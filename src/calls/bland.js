// Bland: the first provider that dials a real phone.
//
// Everything here comes from Bland's own docs, read on 2026-10-05, and the page each field came
// from is named next to it. Nothing is inferred from another provider's API and nothing is a guess
// — where their docs leave something open, it is written down in docs/unverified.md instead of
// being decided here quietly.
//
//   POST /v1/calls              place one                 docs.bland.ai/api-v1/post/calls
//   GET  /v1/calls/{id}         where it got to           docs.bland.ai/api-v1/get/calls-id
//   GET  /v1/calls/{id}/recording   the audio             docs.bland.ai/api-v1/get/calls-id-recording
//   X-Webhook-Signature         HMAC-SHA256, hex          docs.bland.ai/tutorials/webhook-signing
//
// Three things about this adapter are not negotiable, and each is code rather than prompt:
//
//   1. **`record: true` goes on every call.** Bland's `record` parameter "defaults to false", so a
//      call placed without it is a call with no audio — while Reason's announcement is telling the
//      person on the other end that they are being recorded. It is set here, on every request, and
//      there is no setting that turns it off.
//   2. **The announcement is `first_sentence`, verbatim.** Not pasted into the prompt and hoped
//      for: `first_sentence` is the field Bland documents as making "your agent say a specific
//      phrase or sentence for it's first response", so the disclosure is a fixed string rather than
//      something a model composes. The prompt additionally tells the agent not to repeat it.
//   3. **The standing rules go in `task` ahead of the goal,** and a `task` that cannot fit them
//      both under Bland's documented 2,000-character guidance is refused rather than trimmed. The
//      rules are the part that must not be the thing that gets cut.
//
// On fetching the audio: the call object carries a `recording_url`, and in Bland's own examples
// that URL is sometimes api.twilio.com. Sending this account's API key to whatever host happens to
// be in that field would hand the key to a third party, and the docs never say the URL needs
// authentication anyway. So the audio is fetched from Bland's own documented endpoint,
// GET /v1/calls/{id}/recording, which does take the key. `recording_url` is read only as the
// yes/no of whether a recording exists.
//
// What that endpoint really answers, seen on the first real call (2026-10-05), is not the audio.
// It is 111 bytes of JSON — `{"code":200,"status":"success","url":"https://api.bland.ai/v1/recordings/<id>"}`
// — and the WAV is at that second address, which answers 401 AUTHORIZATION_REQUIRED without the
// key and `audio/x-wav` with it. So the pointer is followed, once, and only when it is on Bland's
// own host: the rule above is about where the key goes, and it holds for an address Bland hands
// back in a body exactly as it does for one in the call object.
import { createHmac, timingSafeEqual } from "node:crypto";
import { CallProvider, requireAnnouncement, requireCallRules, SPOKE_TO_SOMETHING } from "./provider.js";
import { config } from "../config.js";

/**
 * Bland's own guidance on the prompt: "Keep the prompt under 2,000 characters where possible."
 * Treated as a hard ceiling rather than a suggestion, because the alternative to refusing is
 * sending a prompt that may be truncated somewhere Reason cannot see — and the end of this prompt
 * is the goal and the approved facts.
 */
export const TASK_MAX_CHARS = 2_000;

/** What Bland calls a call that is still on its way to happening, in the order it moves through. */
const QUEUE_LIVE = new Set(["new", "queued", "allocated"]);
const QUEUE_STARTED = "started";
const QUEUE_ERRORS = new Set(["pre_queue_error", "queue_error", "call_error", "complete_error"]);
/** The whole of Bland's documented `status` list. Anything in it means the call is over. */
const FINAL_BLAND_STATUSES = new Set(["completed", "failed", "busy", "no-answer", "canceled", "unknown"]);

export class BlandCallProvider extends CallProvider {
  name = "bland";

  /**
   * @param {object} opts
   * @param {Function} opts.fetchImpl  injected in every test; nothing here ever reaches the network
   *                                   in the suite, because a test that could place a call is a
   *                                   test that will eventually ring somebody
   */
  constructor({
    fetchImpl = null,
    key = null,
    base = null,
    from = null,
    webhookSecret = null,
    timeoutMs = null,
  } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this._key = key;
    this._base = base;
    this._from = from;
    this._webhookSecret = webhookSecret;
    this._timeoutMs = timeoutMs;
  }

  // Read through to config each time rather than captured at construction, so a test that sets an
  // env var and a process that reads .env behave the same way.
  get key() { return this._key ?? config.blandKey; }
  get base() { return (this._base ?? config.blandBase).replace(/\/+$/, ""); }
  get from() { return this._from ?? config.blandFrom; }
  get webhookSecret() { return this._webhookSecret ?? config.blandWebhookSecret; }
  get timeoutMs() { return this._timeoutMs ?? config.blandTimeoutMs; }

  get fetch() { return this.fetchImpl ?? globalThis.fetch; }

  /**
   * Live only with a key. There is deliberately no "probably fine" state: `capabilities` turns this
   * straight into what Reason tells people it can do, and a provider that reported itself live
   * without a key would have Reason offering to ring a restaurant it cannot ring.
   *
   * `records` is always true, because `record: true` is on every request this adapter sends.
   */
  status() {
    const what = "place a real phone call through Bland, recorded, and fetch the audio afterwards";
    if (!this.key) {
      return { name: this.name, status: "not_connected", missing: ["BLAND_API_KEY"], what, records: true };
    }
    return { name: this.name, status: "live", missing: [], what, records: true };
  }

  headers() {
    // "Send it as `Bearer YOUR_API_KEY`" — api-v1/post/calls, Headers.
    return { authorization: `Bearer ${this.key}`, "content-type": "application/json" };
  }

  /**
   * Place one call.
   *
   * The order of the checks matters: the announcement and the rules are verified before anything is
   * built, so a caller that dropped either gets a refusal rather than a dialled phone.
   */
  async place({ to, goal, facts = [], maxSeconds, announcement, rules, onBehalfOf, callbackUrl = null }) {
    const ann = requireAnnouncement({ announcement, ownerName: onBehalfOf ?? config.ownerName });
    if (!ann.ok) return { ok: false, error: ann.error };
    const rul = requireCallRules({ rules });
    if (!rul.ok) return { ok: false, error: rul.error };
    if (!this.key) return { ok: false, error: "Bland is not connected: this machine has no BLAND_API_KEY." };
    if (!/^\+[1-9]\d{6,14}$/.test(String(to ?? ""))) {
      // "Must be a valid phone number in E.164 format" — refused here rather than spending a
      // request to be told so.
      return { ok: false, error: `'${to}' is not an E.164 phone number, which is the only kind Bland dials.` };
    }

    const built = buildTask({ goal, facts, rules: rul.rules, ownerName: onBehalfOf ?? config.ownerName });
    if (!built.ok) return { ok: false, error: built.error };

    const body = {
      phone_number: to,
      task: built.task,
      // The disclosure, word for word. Everything else on this call is the model's; this is not.
      first_sentence: ann.announcement,
      // Not a default, not a setting. See the header of this file.
      record: true,
      // "a timer is set for the max_duration minutes" — minutes, not seconds, and at least one.
      max_duration: Math.max(1, Math.ceil((Number(maxSeconds) || 0) / 60)),
      // Bland's own default is "hangup"; it is sent explicitly so that a change to their default
      // cannot start leaving voicemails in somebody's name. Reason was asked to have a
      // conversation, not to record a message — and no `message` is sent, because their docs say
      // "Supplying a message implies leaving one".
      voicemail: { action: "hangup" },
      // Also their default, also pinned. `ivr_mode: true` would suppress voicemail handling
      // entirely ("the effective voicemail action becomes ignore no matter what you passed"), and
      // whether a given number answers with a phone menu is not something Reason knows up front.
      ivr_mode: false,
    };
    // Optional: with no number of its own, "calls are initiated from a separate pool of numbers
    // owned by Bland", which is the ordinary case for an install that has just signed up.
    if (this.from) body.from = this.from;
    // Only when Reason has an address Bland can actually reach. With none, the outcome is polled
    // instead, and that path is not a degraded one — their own quickstart calls polling "the right
    // answer, not a workaround" for an agent with no inbound URL.
    if (callbackUrl) body.webhook = callbackUrl;

    let res;
    let json;
    try {
      res = await this.fetch(`${this.base}/v1/calls`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      json = await res.json().catch(() => null);
    } catch (e) {
      return { ok: false, error: `Bland could not be reached: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }

    if (!res?.ok || json?.status === "error" || !json?.call_id) {
      return { ok: false, error: placeError(res, json) };
    }
    // POST /v1/calls "dispatches the call and returns immediately with a call_id. It does not wait
    // for the call to finish." So nothing is known yet beyond that it was accepted.
    return { ok: true, externalId: String(json.call_id), state: "placing" };
  }

  /** Where one call got to, read off Bland's call details. */
  async check(externalId) {
    if (!this.key) return { ok: false, state: "unknown", error: "Bland is not connected: this machine has no BLAND_API_KEY." };
    let res;
    let json;
    try {
      res = await this.fetch(`${this.base}/v1/calls/${encodeURIComponent(externalId)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      json = await res.json().catch(() => null);
    } catch (e) {
      return { ok: false, state: "unknown", error: `Bland could not be reached: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    if (!res?.ok || !json) {
      return { ok: false, state: "unknown", error: `Bland answered HTTP ${res?.status ?? "nothing"} for call ${externalId}` };
    }
    return { ok: true, ...this.readCall(json) };
  }

  /**
   * One Bland call object → what Reason writes down. Shared by `check` and the webhook, because a
   * call that was pushed and a call that was polled must produce the same row; anything else and
   * the outcome depends on whether REASON_PUBLIC_URL happened to be set.
   */
  readCall(body) {
    const state = mapState(body);
    const durationS = durationOf(body);
    const recording = this.recordingFor(body, state);
    return {
      state,
      outcome: outcomeOf(body, state),
      summary: typeof body?.summary === "string" ? body.summary : "",
      transcript: transcriptOf(body),
      durationS,
      costCents: costCentsOf(body),
      recording: recording.ref,
      recordingWhy: recording.why,
      externalId: body?.call_id != null ? String(body.call_id) : null,
    };
  }

  /**
   * The audio, or the reason there is none.
   *
   * `recording_url` being present is the only thing that says a recording exists; the URL itself is
   * not used, for the reason in the header of this file. A call that was answered and has no
   * recording returns null with a reason, which is what makes the existing missing-recording error
   * path fire rather than the audio quietly not being there.
   */
  recordingFor(body, state) {
    const id = body?.call_id != null ? String(body.call_id) : "";
    const hasUrl = typeof body?.recording_url === "string" && body.recording_url.trim() !== "";
    if (hasUrl && id) {
      return {
        ref: {
          url: `${this.base}/v1/calls/${encodeURIComponent(id)}/recording`,
          // WAV is what comes back when no other type is asked for, and none is. The file is
          // named for what the bytes turn out to be either way.
          format: "wav",
          seconds: durationOf(body) ?? undefined,
          headers: { authorization: `Bearer ${this.key}` },
          // The endpoint answers with JSON naming where the audio is. That address gets the key
          // only if it is on the host the key belongs to.
          pointerHosts: [new URL(this.base).host],
        },
        why: "",
      };
    }
    if (!SPOKE_TO_SOMETHING.includes(state)) {
      // Nobody was on the call. There was nothing to record, and saying otherwise would bury the
      // times it really is a fault.
      return { ref: null, why: "" };
    }
    if (body?.record === false) {
      return { ref: null, why: "Bland says this call was not recorded (record came back false) even though Reason sends record: true on every call" };
    }
    return { ref: null, why: "the call was answered but Bland returned no recording_url for it" };
  }

  /**
   * Is this webhook really from Bland, and is it about this call?
   *
   * Two independent things have to hold, and neither is the other's backup:
   *
   *   - **The URL carries a per-call token** nobody but Bland and this machine has ever seen. That
   *     is what says which call a payload is about, so a forged payload for a different call is not
   *     a thing that can be aimed at this route at all.
   *   - **The signature, when there is a secret to check it with.** Bland signs with HMAC-SHA256
   *     over the body, hex, in `X-Webhook-Signature`. The secret is created by hand in their
   *     dashboard, so an account may not have one — with BLAND_WEBHOOK_SECRET empty this falls back
   *     to the token alone, and docs/unverified.md says so rather than leaving it to be discovered.
   *     With a secret set, an unsigned delivery is rejected.
   *
   * Their own verification example hashes `JSON.stringify(req.body)` — the re-serialised body, not
   * the bytes that arrived — so both are accepted. Either one matching still proves the sender knew
   * the secret, and refusing the re-serialised form would reject real deliveries from the scheme
   * Bland themselves document.
   */
  verifyWebhook({ rawBody, headers }) {
    if (!this.webhookSecret) return { ok: true, signed: false };
    const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]));
    const given = String(h["x-webhook-signature"] ?? "").trim();
    if (!given) return { ok: false, signed: false, why: "no X-Webhook-Signature header, and BLAND_WEBHOOK_SECRET is set on this machine" };

    const raw = String(rawBody ?? "");
    const candidates = [raw];
    try {
      const restringified = JSON.stringify(JSON.parse(raw));
      if (restringified !== raw) candidates.push(restringified);
    } catch { /* not JSON: the raw bytes are the only thing to check */ }

    for (const candidate of candidates) {
      const want = createHmac("sha256", this.webhookSecret).update(candidate).digest("hex");
      const a = Buffer.from(want);
      const b = Buffer.from(given);
      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, signed: true };
    }
    return { ok: false, signed: false, why: "the X-Webhook-Signature did not match BLAND_WEBHOOK_SECRET" };
  }

  /**
   * One raw call-finished delivery → the same shape `check()` returns.
   *
   * "When the call ends, Bland POSTs the full call object to that URL" — so the payload is a call
   * object and is read with exactly the same code, rather than a second parser that could drift.
   */
  receiveWebhook({ rawBody, headers }) {
    const v = this.verifyWebhook({ rawBody, headers });
    if (!v.ok) return { ok: false, status: 401, error: `rejected: ${v.why}` };
    let body;
    try { body = JSON.parse(rawBody); } catch { return { ok: false, status: 400, error: "bad json" }; }
    if (!body || typeof body !== "object") return { ok: false, status: 400, error: "bad json" };
    return { ok: true, status: 200, signed: v.signed, live: this.readCall(body) };
  }
}

// ---------- the prompt ----------

/**
 * What the agent on the phone is told, in the order it has to be told it.
 *
 * The rules come before the goal on purpose. A prompt is read as a whole, but the thing most likely
 * to be reached for under pressure — "we just need a card to hold the table" — is the thing that
 * should not be at the bottom of a page of instructions about booking a table.
 *
 * `ok: false` rather than a trim when it will not fit. Everything that could be cut to make room is
 * something the call needs: the rules are the rules, the goal is why the call exists, and the facts
 * are the only things the call is allowed to say.
 */
export function buildTask({ goal, facts = [], rules = [], ownerName }) {
  const who = ownerName || config.ownerName;
  const list = (facts ?? []).map(f => String(f).trim()).filter(Boolean);

  const parts = [
    `You are an AI assistant making this phone call for ${who}. You are not ${who}, and you never say you are.`,
    `Your opening line is already set and will be spoken for you before you say anything else.`
      + ` Do not say it again, do not reword it, and do not put anything in front of it.`,
    `Rules for this call, whatever you are asked:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    `What this call is for:\n${String(goal ?? "").trim()}`,
    list.length
      ? `The only things you may say about ${who} or their plans:\n${list.map(f => `- ${f}`).join("\n")}`
      : `You were given nothing to share about ${who} beyond the line above.`,
    `If they ask anything you were not told, say you will check with ${who} and come back. Do not guess.`,
    `Once you have the answer, or they tell you they cannot help, thank them and end the call.`,
  ];
  const task = parts.join("\n\n");

  if (!String(goal ?? "").trim()) return { ok: false, error: "refused: a call needs a goal, and none was given." };
  if (task.length > TASK_MAX_CHARS) {
    return {
      ok: false,
      error: `Refused: what this call would have to say runs to ${task.length} characters and Bland's limit is ${TASK_MAX_CHARS}.`
        + ` Nothing was dialled. The standing rules are not the part that gets cut, so shorten the goal and the facts`
        + ` — say the one thing being asked for and leave out anything the person on the phone does not need.`,
    };
  }
  return { ok: true, task };
}

// ---------- reading a call back ----------

/**
 * Bland's view of a call → one of Reason's states.
 *
 * The whole point of this function is which ones count as having spoken to something, because
 * `SPOKE_TO_SOMETHING` is what turns a missing recording from a shrug into a reported fault. So the
 * two that matter are read carefully:
 *
 *   - **Voicemail is `answered_by`, not `status`.** Bland's own warning: "A completed call that
 *     reached voicemail is still status: completed." Reading only `status` would file every
 *     answering machine as a conversation that happened.
 *   - **`unknown` and `null` are treated as a conversation.** Their docs say `unknown` "is most
 *     likely a human", and `null` means the determination is still processing. Both are called
 *     `completed`, which is the direction that errs towards shouting about a missing recording
 *     rather than quietly not having one.
 *
 * `declined` is one of Reason's states that Bland never produces: their status list has no "they
 * rejected the call", and a rejected call reads as busy or no-answer at the carrier. Nothing here
 * invents it. `canceled` has no Reason state either and comes back as `failed`, with the word
 * "cancelled" in the outcome so the row still says what happened. Both are in docs/unverified.md.
 */
export function mapState(body) {
  const status = String(body?.status ?? "").toLowerCase();
  const queue = String(body?.queue_status ?? "").toLowerCase();
  const answered = String(body?.answered_by ?? "").toLowerCase();
  const completed = body?.completed === true;

  // Still on its way. Checked first, because `status` is documented as "only present for calls that
  // have been successfully created" and a live call may carry no status at all.
  if (!completed && !FINAL_BLAND_STATUSES.has(status)) {
    if (QUEUE_LIVE.has(queue)) return "placing";
    if (queue === QUEUE_STARTED) return "in_progress";
    if (QUEUE_ERRORS.has(queue)) return "failed";
    // No status, no recognisable queue stage: it has been accepted and nothing else is known.
    return "placing";
  }

  switch (status) {
    case "completed":
      if (answered === "voicemail") return "voicemail";
      if (answered === "no-answer") return "no_answer";
      return "completed";
    case "no-answer": return "no_answer";
    case "busy": return "busy";
    case "failed": return "failed";
    case "canceled": return "failed";
    // "Status could not be determined". Not claimed as a conversation — Reason must not report an
    // outcome it does not have — and not claimed as nobody answering either.
    case "unknown": return "failed";
    default:
      if (QUEUE_ERRORS.has(queue)) return "failed";
      return completed ? "failed" : "placing";
  }
}

/** A short plain line for the call row: what happened, in the words a person would use. */
function outcomeOf(body, state) {
  const err = typeof body?.error_message === "string" ? body.error_message.trim() : "";
  const answered = String(body?.answered_by ?? "").toLowerCase();
  const status = String(body?.status ?? "").toLowerCase();
  switch (state) {
    case "placing": return "";
    case "in_progress": return "on the call now";
    case "voicemail": return "it went to voicemail; Reason hung up rather than leaving a message";
    case "no_answer": return "nobody answered";
    case "busy": return "the line was busy";
    case "completed":
      return answered === "human" ? "they answered"
        : answered === "unknown" || !answered ? "the call connected and somebody was on it (Bland could not tell whether it was a person or a machine)"
          : `the call connected (${answered})`;
    case "failed":
      if (status === "canceled") return `the call was cancelled before it finished${err ? `: ${err}` : ""}`;
      if (status === "unknown") return `Bland could not tell how this call ended${err ? `: ${err}` : ""}`;
      return err ? `the call failed: ${err}` : "the call failed";
    default: return "";
  }
}

/**
 * How long the call ran, in seconds.
 *
 * `corrected_duration` is documented as "the actual length of the call, not the max_duration", in
 * seconds, and comes back as a string. `call_length` is in minutes and is the fallback.
 */
function durationOf(body) {
  const corrected = Number(body?.corrected_duration);
  if (Number.isFinite(corrected) && corrected >= 0) return Math.round(corrected);
  const minutes = Number(body?.call_length);
  if (Number.isFinite(minutes) && minutes >= 0) return Math.round(minutes * 60);
  return null;
}

/**
 * What the call really cost, in whole cents.
 *
 * `price` is "the cost of the call in USD" — a real number Bland bills, not an estimate from a rate
 * card, which is what makes `cost_cents` on the call row worth reading. The column is integer
 * cents, so a 1.7-cent call is written down as 2. Null means Bland has not said yet, which is not
 * the same as nothing.
 */
function costCentsOf(body) {
  // Bland fills `price` in a few seconds after the call ends, and until then it is null. `Number(null)`
  // is 0, which is how the first real call — 22 seconds, $0.052 — was written down as free. Not
  // priced yet is null, so it reads as "not known" and gets asked for again.
  const raw = body?.price;
  if (raw === null || raw === undefined || raw === "") return null;
  const price = Number(raw);
  if (!Number.isFinite(price) || price < 0) return null;
  // A call that ran is never billed nothing, so a zero against a real length is also "not yet".
  if (price === 0) return (durationOf(body) ?? 0) > 0 ? null : 0;
  // And a real charge is never rounded away to $0.00.
  return Math.max(1, Math.round(price * 100));
}

/** Bland's turn list → the two-speaker transcript the rest of Reason quotes from. */
function transcriptOf(body) {
  const turns = Array.isArray(body?.transcripts) ? body.transcripts : [];
  if (turns.length) {
    return turns
      .map(t => {
        const text = String(t?.text ?? "").trim();
        if (!text) return "";
        // "user" is the person who was called; "assistant" and "robot" are the voice Reason sent;
        // "agent-action" is Bland narrating something the agent did, like ending the call.
        const who = String(t?.user ?? "").toLowerCase();
        const label = who === "user" ? "Them" : who === "agent-action" ? "(call)" : "Reason";
        return `${label}: ${text}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return typeof body?.concatenated_transcript === "string" ? body.concatenated_transcript.trim() : "";
}

/** Why a placement did not take, in words the owner can be told. */
function placeError(res, json) {
  const said = typeof json?.message === "string" && json.message.trim() ? json.message.trim() : "";
  const errs = Array.isArray(json?.errors)
    ? json.errors.map(e => (typeof e === "string" ? e : e?.message ?? e?.error)).filter(Boolean).join("; ")
    : "";
  const detail = [said, errs].filter(Boolean).join(" — ");
  if (res && !res.ok) return `Bland refused the call (HTTP ${res.status})${detail ? `: ${detail}` : ""}`;
  if (detail) return `Bland refused the call: ${detail}`;
  return "Bland accepted the request but returned no call_id, so there is no call to follow";
}
