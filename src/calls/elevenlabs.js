// ElevenLabs Agents: the provider where the voice is theirs and the brain is Reason's.
//
// Everything about their API here comes from ElevenLabs' own docs, read 2026-10-05/06, with the page
// named next to each field. Nothing is inferred from Bland's shape and nothing is a guess — where
// their docs leave something open it is written into docs/unverified.md instead of being decided
// here quietly. NOTHING in this file has run against the real platform: there are no keys until
// 2026-10-09. Every request is shape-tested with an injected fetch, exactly as Bland's was.
//
//   POST /v1/convai/twilio/outbound-call        place one       ("Outbound call via twilio")
//   GET  /v1/convai/conversations/{id}          where it got to ("Get conversation")
//   GET  /v1/convai/conversations/{id}/audio    the audio       ("Get conversation audio")
//   ElevenLabs-Signature                        HMAC-SHA256     ("Post-call webhooks")
//
// What makes this provider different from Bland is not in this file: it is that the agent's LLM is
// Reason's own endpoint (src/calls/voice.js), so the words on the call are Reason's turn-by-turn
// rather than a prompt handed over once. This file is still only the telephony — placing, reading
// back, and the audio.
//
// Four things here are code rather than prompt, and three of them are the same three Bland's are:
//
//   1. **The announcement is the agent's first message, verbatim**, through
//      `conversation_config_override.agent.first_message`. Not pasted into a prompt and hoped for.
//      `requireAnnouncement` runs before anything is built, so a caller that dropped it gets a
//      refusal rather than a dialled phone.
//   2. **The standing rules travel with the call** and `requireCallRules` refuses one that arrives
//      without the no-payment rule. They are not sent as part of the agent's prompt override at all
//      — they go to Reason's own endpoint with the call id, which is the only place they can be
//      enforced turn by turn rather than hoped for once.
//   3. **The audio is fetched as BYTES.** `GET /v1/convai/conversations/{id}/audio` is documented as
//      a file download. The lesson behind this being written down is Bland's: its recording endpoint
//      answered 200 with 111 bytes of JSON, that was filed as `call-1.wav`, and Reason told the owner
//      the audio was saved. `storeRecording` sniffs the bytes now (src/calls/recordings.js), so a
//      JSON body is refused rather than named `.wav` — and no `pointerHosts` is set here, because
//      ElevenLabs documents this endpoint as the audio itself and a pointer we have not seen is not
//      a thing to pre-authorise sending the key to.
//   4. **Every env var a call cannot happen without is in `status().missing`.** `capabilities` turns
//      this straight into what Reason tells people it can do, so there is no "probably fine": with
//      no agent id, Reason says it cannot ring anyone rather than offering to.
import { createHmac, timingSafeEqual } from "node:crypto";
import { CallProvider, requireAnnouncement, requireCallRules, SPOKE_TO_SOMETHING } from "./provider.js";
import { requireBrief } from "./brief.js";
import { config } from "../config.js";

/**
 * What ElevenLabs is told about this call, under their own `custom_llm_extra_body`, and what comes
 * back to Reason's endpoint as `elevenlabs_extra_body` on every turn of it.
 *
 * This is the whole of how a voice turn knows whose call it is. It is NOT trusted on its own — the
 * endpoint looks the id up in the calls table and uses the row, not the body (see ./voice.js) — but
 * it is what makes the lookup possible for an outbound call, where there is no caller id to go on.
 */
export const EXTRA_BODY_KEYS = { callId: "reason_call_id", conversationId: "reason_conversation_id", kind: "reason_kind" };

/** The kinds of call there are, which is the same thing as which context builder answers for it. */
export const CALL_KINDS = ["owner", "third_party"];

/**
 * How their conversation statuses map onto Reason's.
 *
 * `initiated` and `in-progress` are theirs; `processing` is the gap after the audio stops while they
 * work out the transcript, and it is NOT live — the call is over, Reason simply does not have all of
 * it yet. `done` and `failed` are final. Read from "Get conversation", 2026-10-06. Any status not on
 * this list is treated as still placing rather than as an outcome, because reporting an outcome
 * Reason does not have is the one thing a call must never do.
 */
const STATUS_MAP = new Map([
  ["initiated", "placing"],
  ["in-progress", "in_progress"],
  ["in_progress", "in_progress"],
  ["processing", "completed"],
  ["done", "completed"],
  ["failed", "failed"],
]);

/**
 * The fields that say a call reached an answering machine rather than a person.
 *
 * Bland's lesson, which cost a real call: "a completed call that reached voicemail is still
 * status: completed", so reading only the status files every answering machine as a conversation
 * that happened. ElevenLabs' own field for this is not something these docs pin down to one name, so
 * every name they use for it in the pages read is checked, and the *value* is matched rather than
 * the key — `voicemail` anywhere in a termination or call-status field means voicemail.
 *
 * Erring is one-directional on purpose: a human call mistaken for voicemail loses a summary, while a
 * voicemail mistaken for a human call files a conversation that never happened and tells the owner
 * their message was heard. Which is why this is in docs/unverified.md to confirm on Friday.
 */
const VOICEMAIL_MARK = /voice[\s_-]?mail|answering[\s_-]?machine/i;

export class ElevenLabsCallProvider extends CallProvider {
  name = "elevenlabs";

  /**
   * @param {object} opts
   * @param {Function} opts.fetchImpl  injected in every test; nothing here ever reaches the network
   *                                   in the suite, because a test that could place a call is a test
   *                                   that will eventually ring somebody
   */
  constructor({
    fetchImpl = null, key = null, base = null, agentId = null, phoneNumberId = null,
    voiceId = null, webhookSecret = null, llmSecret = null, timeoutMs = null,
  } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this._key = key;
    this._base = base;
    this._agentId = agentId;
    this._phoneNumberId = phoneNumberId;
    this._voiceId = voiceId;
    this._webhookSecret = webhookSecret;
    this._llmSecret = llmSecret;
    this._timeoutMs = timeoutMs;
  }

  // Read through to config each time rather than captured at construction, so a test that sets an
  // env var and a process that reads .env behave the same way. Same reasoning as Bland's.
  get key() { return this._key ?? config.elevenKey; }
  get base() { return (this._base ?? config.elevenBase).replace(/\/+$/, ""); }
  get agentId() { return this._agentId ?? config.elevenAgentId; }
  get phoneNumberId() { return this._phoneNumberId ?? config.elevenPhoneNumberId; }
  get voiceId() { return this._voiceId ?? config.elevenVoiceId; }
  get webhookSecret() { return this._webhookSecret ?? config.elevenWebhookSecret; }
  get llmSecret() { return this._llmSecret ?? config.elevenLlmSecret; }
  get timeoutMs() { return this._timeoutMs ?? config.elevenTimeoutMs; }

  get fetch() { return this.fetchImpl ?? globalThis.fetch; }

  /**
   * What is missing, by name, for each direction separately.
   *
   * Two directions is the thing this provider adds, and they do not need the same settings: ringing
   * somebody needs the imported number's id, while answering a call needs nothing but the endpoint
   * ElevenLabs is pointed at. So they are reported apart, and `capabilities` says which of the two
   * works rather than collapsing both into one yes or no (src/tools.js).
   *
   * `ELEVENLABS_VOICE_ID` is not on either list. The voice is configured on the agent itself; this
   * is only how Reason pins the same one on every call, and an agent with its own voice set still
   * speaks. Saying a call could not be placed over a voice id would be false.
   */
  missingFor(direction) {
    const missing = [];
    if (!this.key) missing.push("ELEVENLABS_API_KEY");
    if (!this.agentId) missing.push("ELEVENLABS_AGENT_ID");
    // The call's own words come from Reason's endpoint, and ElevenLabs will not be let into it
    // without this. A call with no brain behind it is not a call Reason will place.
    if (!this.llmSecret) missing.push("ELEVENLABS_LLM_SECRET");
    if (direction === "out" && !this.phoneNumberId) missing.push("ELEVENLABS_PHONE_NUMBER_ID");
    // Inbound only. A call that comes in is written into the person's own thread when it ends, and
    // an unsigned delivery that can do that is a stranger writing in somebody's conversation.
    if (direction === "in" && !this.webhookSecret) missing.push("ELEVENLABS_WEBHOOK_SECRET");
    return missing;
  }

  /**
   * Live only when outbound really works, because `place()` is what the rest of Reason calls this
   * provider for. `directions` carries the finer answer for `capabilities`, which does report the two
   * separately: an install that can answer a phone but not ring one should say exactly that.
   *
   * `records` is always true. Every call is recorded; the audio endpoint is documented and the
   * announcement says so on every third-party call.
   */
  status() {
    const what = "be Reason itself on a real phone call, both directions, through ElevenLabs on a Twilio number — recorded, with the audio afterwards";
    const out = this.missingFor("out");
    const inbound = this.missingFor("in");
    return {
      name: this.name,
      status: out.length ? "not_connected" : "live",
      missing: out,
      what,
      records: true,
      directions: { out: !out.length, in: !inbound.length, missingIn: inbound },
    };
  }

  headers() {
    // "xi-api-key: <your key>" — their authentication page. Not a bearer token.
    return { "xi-api-key": this.key, "content-type": "application/json" };
  }

  /**
   * Place one call.
   *
   * The order of the checks is the order it is in for a reason: the announcement and the rules are
   * verified before anything at all is built, so a caller that dropped either gets a refusal rather
   * than a ringing phone.
   *
   * @param {{to: string, goal: string, facts: string[], maxSeconds: number, announcement: string,
   *          rules: string[], onBehalfOf: string, callbackUrl?: string, callId?: number|null,
   *          conversationId?: string|null, kind?: string, language?: string|null}} _
   */
  async place({
    to, goal, facts = [], maxSeconds, announcement, rules, onBehalfOf, callbackUrl = null,
    // Reason's own identity for this call, handed to the agent so that every turn of it comes back
    // to the endpoint knowing which call it is. `call_place` passes the row it just created.
    callId = null, conversationId = null, kind = "third_party", language = null,
    // What this call may agree to, ask and wait for (2026-10-07). Its own argument, like the
    // announcement and the rules, and a precondition for the same reason.
    brief = null,
  }) {
    const ownerName = onBehalfOf ?? config.ownerName;
    const ann = requireAnnouncement({ announcement, ownerName });
    if (!ann.ok) return { ok: false, error: ann.error };
    const rul = requireCallRules({ rules });
    if (!rul.ok) return { ok: false, error: rul.error };
    const bri = requireBrief({ brief });
    if (!bri.ok) return { ok: false, error: bri.error };

    const missing = this.missingFor("out");
    if (missing.length) {
      return { ok: false, error: `ElevenLabs is not connected: this machine has no ${missing.join(", ")}.` };
    }
    if (!CALL_KINDS.includes(kind)) {
      return { ok: false, error: `'${kind}' is not a kind of call Reason makes. It has: ${CALL_KINDS.join(", ")}.` };
    }
    // E.164 only, refused here rather than spending a request to be told so.
    if (!/^\+[1-9]\d{6,14}$/.test(String(to ?? ""))) {
      return { ok: false, error: `'${to}' is not an E.164 phone number, which is the only kind a phone network dials.` };
    }
    if (!String(goal ?? "").trim()) return { ok: false, error: "refused: a call needs a goal, and none was given." };

    const body = {
      agent_id: this.agentId,
      agent_phone_number_id: this.phoneNumberId,
      to_number: to,
      conversation_initiation_client_data: {
        // What the agent says before anything else, word for word. Everything else on this call is
        // generated turn by turn by Reason's own endpoint; this one line is not.
        conversation_config_override: {
          agent: { first_message: ann.announcement },
          // One pinned voice, when the owner has picked one. Left off entirely otherwise, so the
          // agent's own configured voice is used rather than an empty id being sent.
          ...(this.voiceId ? { tts: { voice_id: this.voiceId } } : {}),
          // Their own field for the ceiling, in seconds, 60–7200 with a documented default of 600
          // ("Conversation flow", read 2026-10-06). Sent on every call: `call_place` already holds a
          // maximum and a call that runs past it is money spent with nobody watching.
          //
          // It has to clear the HOLD budget as well as the talking, which is the easy mistake here. A
          // call allowed to wait five minutes on a ten-minute cap has five left to do the errand in, and
          // the platform cutting the line the moment somebody finally picks up would look exactly like a
          // dropped call — the one outcome that makes the next step ambiguous. So the floor is the hold
          // budget plus the time the conversation itself needs, and their minimum is respected.
          conversation: { max_duration_seconds: callCeilingSeconds({ maxSeconds, brief: bri.brief }) },
        },
        // Reason's identity for this call. Comes back on every turn as `elevenlabs_extra_body`.
        custom_llm_extra_body: {
          [EXTRA_BODY_KEYS.callId]: callId,
          [EXTRA_BODY_KEYS.conversationId]: conversationId,
          [EXTRA_BODY_KEYS.kind]: kind,
        },
        // Theirs, for anything the agent's own prompt template interpolates. The one that is worth
        // setting is the name, because an agent configured with {{owner_name}} in its greeting is
        // the ordinary way somebody sets one of these up.
        dynamic_variables: { owner_name: ownerName, ...(language ? { language } : {}) },
      },
    };

    let res;
    let json;
    try {
      res = await this.fetch(`${this.base}/v1/convai/twilio/outbound-call`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      json = await res.json().catch(() => null);
    } catch (e) {
      return { ok: false, error: `ElevenLabs could not be reached: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }

    // Their own response names it `conversation_id`, with `callSid` alongside. The conversation id is
    // what every other endpoint here takes, so that is the external id Reason keeps.
    const conversation = json?.conversation_id ?? json?.conversationId ?? null;
    if (!res?.ok || json?.success === false || !conversation) {
      return { ok: false, error: placeError(res, json) };
    }
    // The endpoint "returns immediately"; nothing is known yet beyond that it was accepted.
    return { ok: true, externalId: String(conversation), state: "placing", callSid: json?.callSid ?? json?.call_sid ?? null };
  }

  /** Where one call got to, read off their conversation object. */
  async check(externalId) {
    const missing = this.missingFor("out").filter(m => m === "ELEVENLABS_API_KEY");
    if (missing.length) return { ok: false, state: "unknown", error: "ElevenLabs is not connected: this machine has no ELEVENLABS_API_KEY." };
    let res;
    let json;
    try {
      res = await this.fetch(`${this.base}/v1/convai/conversations/${encodeURIComponent(externalId)}`, {
        method: "GET",
        headers: { "xi-api-key": this.key },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      json = await res.json().catch(() => null);
    } catch (e) {
      return { ok: false, state: "unknown", error: `ElevenLabs could not be reached: ${(e?.message ?? String(e)).split("\n")[0]}` };
    }
    if (!res?.ok || !json) {
      return { ok: false, state: "unknown", error: `ElevenLabs answered HTTP ${res?.status ?? "nothing"} for conversation ${externalId}` };
    }
    return { ok: true, ...this.readConversation(json) };
  }

  /**
   * One conversation object → what Reason writes down.
   *
   * Shared by `check` and the post-call webhook, because a call that was pushed and a call that was
   * polled must produce the same row. Anything else and the outcome depends on whether
   * REASON_PUBLIC_URL happened to be set on the machine.
   */
  readConversation(body) {
    const state = mapState(body);
    const durationS = durationOf(body);
    const recording = this.recordingFor(body, state);
    return {
      state,
      outcome: outcomeOf(body, state),
      summary: summaryOf(body),
      transcript: transcriptOf(body),
      // The same transcript as a two-sided list, because the two are wanted for different things:
      // the string is what the call row keeps and what the model quotes, while these are what
      // src/calls/postcall.js turns into real conversation turns so a text ten minutes later
      // continues the call. Carried here rather than re-parsed from the string, which would lose a
      // turn that happened to have a newline in it.
      turns: transcriptTurns(body),
      durationS,
      costCents: costCentsOf(body),
      recording: recording.ref,
      recordingWhy: recording.why,
      externalId: conversationIdOf(body),
      // What language the call ended up in, when they say. Not used for a decision — it is on the
      // row so "it finished the booking in Spanish" is a thing the record says rather than a thing
      // the owner has to take on trust from a summary.
      language: typeof body?.conversation_initiation_client_data?.dynamic_variables?.language === "string"
        ? body.conversation_initiation_client_data.dynamic_variables.language
        : (typeof body?.metadata?.main_language === "string" ? body.metadata.main_language : ""),
    };
  }

  /**
   * The audio, or the reason there is none.
   *
   * Their audio endpoint is documented as the file itself, so unlike Bland's there is no pointer to
   * follow and `pointerHosts` is deliberately unset: pre-authorising the key to be sent to whatever
   * a JSON body names is only worth doing for a provider that is documented to answer that way.
   *
   * `format` is "mp3" because their TTS output is MP3 by default and their audio endpoint is
   * documented as returning the conversation's audio. It is only a hint either way — `storeRecording`
   * names the file for what the bytes turn out to be, which is the whole reason that sniff exists.
   */
  recordingFor(body, state) {
    const id = conversationIdOf(body);
    if (!id) {
      return { ref: null, why: SPOKE_TO_SOMETHING.includes(state) ? "the call was answered but ElevenLabs returned no conversation id to fetch the audio with" : "" };
    }
    // Nobody was on the call: there was nothing to record, and calling that a fault would train the
    // owner to ignore the warning that matters.
    if (!SPOKE_TO_SOMETHING.includes(state)) return { ref: null, why: "" };
    // Their own flag for whether there is audio at all, when they set one. Only read as a no: a
    // missing flag is not evidence of a missing recording.
    if (body?.has_audio === false) {
      return { ref: null, why: "ElevenLabs says this conversation has no audio (has_audio came back false) even though every call Reason makes is recorded" };
    }
    return {
      ref: {
        url: `${this.base}/v1/convai/conversations/${encodeURIComponent(id)}/audio`,
        format: "mp3",
        seconds: durationOf(body) ?? undefined,
        headers: { "xi-api-key": this.key },
      },
      why: "",
    };
  }

  /**
   * Is this post-call delivery really from ElevenLabs?
   *
   * Their scheme, from "Post-call webhooks": `ElevenLabs-Signature: t=<unix>,v0=<hex>`, where the hex
   * is HMAC-SHA256 over `${t}.${rawBody}` with the webhook secret. Their JS SDK's `constructEvent`
   * verifies exactly that; this is the same check without the dependency, over the raw bytes rather
   * than a re-serialisation, because signing the bytes is what they document.
   *
   * Two differences from Bland's verify, both deliberate:
   *
   *   - **No secret means no.** Bland's secret is optional in their dashboard, so there it falls back
   *     to the per-call token in the URL. Here the secret is part of setting the webhook up at all,
   *     and a delivery that writes a transcript into somebody's thread is not something to accept on
   *     a shrug.
   *   - **The timestamp is checked.** A valid old delivery replayed is a call settled twice and a
   *     transcript written twice, so anything outside the tolerance is refused. Thirty minutes:
   *     wide enough for a clock that drifts and for their own retries, narrow enough that a captured
   *     body is not usable tomorrow.
   */
  verifyWebhook({ rawBody, headers, now = Date.now(), toleranceMs = 30 * 60_000 }) {
    if (!this.webhookSecret) {
      return { ok: false, signed: false, why: "this machine has no ELEVENLABS_WEBHOOK_SECRET, and a post-call delivery writes into somebody's conversation, so it is not accepted unsigned" };
    }
    const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]));
    const given = String(h["elevenlabs-signature"] ?? "").trim();
    if (!given) return { ok: false, signed: false, why: "no ElevenLabs-Signature header on the delivery" };

    const parts = Object.fromEntries(given.split(",").map(p => {
      const i = p.indexOf("=");
      return i === -1 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }));
    const t = String(parts.t ?? "");
    const v0 = String(parts.v0 ?? "");
    if (!t || !v0) return { ok: false, signed: false, why: "the ElevenLabs-Signature header is not in the documented t=,v0= shape" };

    const seconds = Number(t);
    if (!Number.isFinite(seconds)) return { ok: false, signed: false, why: "the timestamp in the ElevenLabs-Signature header is not a number" };
    if (Math.abs(now - seconds * 1000) > toleranceMs) {
      return { ok: false, signed: false, why: `the delivery is signed for ${new Date(seconds * 1000).toISOString()}, which is too far from now to be a live one` };
    }

    const want = createHmac("sha256", this.webhookSecret).update(`${t}.${String(rawBody ?? "")}`).digest("hex");
    const a = Buffer.from(want);
    const b = Buffer.from(v0);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, signed: true };
    return { ok: false, signed: false, why: "the ElevenLabs-Signature did not match ELEVENLABS_WEBHOOK_SECRET" };
  }

  /**
   * One raw post-call delivery → the same shape `check()` returns, plus which of their three event
   * types it was.
   *
   * The three, from their docs: `post_call_transcription` (the conversation, with the transcript),
   * `post_call_audio` (the audio, base64, for an account that asked for it that way), and
   * `call_initiation_failure` (the call never happened at all). They are different enough that
   * src/calls/postcall.js branches on them; what this does is verify, parse, and hand over the
   * conversation object read by the same code `check()` uses.
   */
  receiveWebhook({ rawBody, headers, now = Date.now() }) {
    const v = this.verifyWebhook({ rawBody, headers, now });
    if (!v.ok) return { ok: false, status: 401, error: `rejected: ${v.why}` };
    let body;
    try { body = JSON.parse(rawBody); } catch { return { ok: false, status: 400, error: "bad json" }; }
    if (!body || typeof body !== "object") return { ok: false, status: 400, error: "bad json" };

    const type = String(body.type ?? "").trim();
    const data = body.data && typeof body.data === "object" ? body.data : body;

    if (type === "call_initiation_failure") {
      return {
        ok: true, status: 200, signed: true, type,
        externalId: conversationIdOf(data),
        live: {
          state: "failed",
          outcome: `the call never started: ${String(data?.reason ?? data?.error ?? "ElevenLabs did not say why")}`,
          summary: "", transcript: "", durationS: null, costCents: null,
          recording: null,
          // Nobody's phone was ever answered, so there was nothing to record. Not an audio fault.
          recordingWhy: "",
          externalId: conversationIdOf(data),
        },
      };
    }
    if (type === "post_call_audio") {
      // Audio and nothing else. The base64 is handed over as-is for src/calls/postcall.js to file;
      // it is not parsed here, because what it is is a question for the byte sniff.
      return {
        ok: true, status: 200, signed: true, type,
        externalId: conversationIdOf(data),
        audioBase64: typeof data?.full_audio === "string" ? data.full_audio : null,
        live: null,
      };
    }
    // Their transcription event, and anything else they send that carries a conversation: read by
    // the same function `check()` uses, so a pushed call and a polled one write the same row.
    return {
      ok: true, status: 200, signed: true, type: type || "post_call_transcription",
      externalId: conversationIdOf(data),
      live: this.readConversation(data),
    };
  }
}

/**
 * The platform's hard stop for one call, in seconds.
 *
 * Their range is 60–7200 with a default of 600 ("Conversation flow", read 2026-10-06), and 600 is the
 * number that would bite: a call allowed to wait five minutes on hold has five minutes left to do the
 * errand in, and the platform hanging up the moment a human finally comes on the line would look
 * exactly like a dropped call — which is the one outcome that leaves "did it go through?" unanswerable
 * and forces a second call to find out. So the hold budget is added to the talking time rather than
 * taken out of it.
 */
export function callCeilingSeconds({ maxSeconds = 0, brief = null } = {}) {
  const talking = Math.round(Number(maxSeconds) || 0) || 600;
  const waiting = Math.max(0, Math.round(Number(brief?.maxHoldSeconds) || 0));
  // Their documented bounds. Clamped rather than sent out of range, because a request they reject is a
  // call that never happens at all.
  return Math.min(7200, Math.max(60, talking + waiting));
}

// ---------- reading a conversation back ----------

/** Their id for this conversation, under whichever of the two names the payload uses. */
export function conversationIdOf(body) {
  const id = body?.conversation_id ?? body?.conversationId ?? body?.id ?? null;
  return id == null || id === "" ? null : String(id);
}

/**
 * Their view of a conversation → one of Reason's states.
 *
 * The one that matters is voicemail, for the reason in `VOICEMAIL_MARK` above: a call that reached
 * an answering machine must not be filed as a conversation that happened, because the owner would be
 * told their message was heard by somebody. So the termination fields are read before the status is.
 *
 * `declined` and `busy` are Reason states ElevenLabs may never produce — a rejected call reads as a
 * failure at the carrier — and nothing here invents them. Both are in docs/unverified.md.
 */
export function mapState(body) {
  const status = String(body?.status ?? body?.call_status ?? "").toLowerCase().trim();
  const mapped = STATUS_MAP.get(status) ?? null;

  // Still on its way, or on the call. Checked before anything else is read, because a live call has
  // no outcome to read and the termination fields on it are empty rather than meaningful.
  if (mapped === "placing" || mapped === "in_progress") return mapped;

  const termination = [
    body?.metadata?.termination_reason,
    body?.termination_reason,
    body?.metadata?.call_status,
    body?.call_successful,
    body?.analysis?.call_successful,
  ].map(v => String(v ?? "")).join(" ");

  if (VOICEMAIL_MARK.test(termination) || VOICEMAIL_MARK.test(status)) return "voicemail";
  if (/no[\s_-]?answer|not[\s_-]?answered|unanswered/i.test(termination)) return "no_answer";
  if (/busy/i.test(termination)) return "busy";

  if (mapped) return mapped;
  // A status their docs do not list. Not claimed as a conversation and not claimed as nobody
  // answering: a call with a recognisable length and some transcript did happen, and one with
  // neither has not got anywhere yet.
  if ((durationOf(body) ?? 0) > 0 || transcriptOf(body)) return "completed";
  return "placing";
}

/** A short plain line for the call row: what happened, in the words a person would use. */
function outcomeOf(body, state) {
  const why = String(body?.metadata?.termination_reason ?? body?.termination_reason ?? "").trim();
  switch (state) {
    case "placing": return "";
    case "in_progress": return "on the call now";
    case "voicemail": return "it went to voicemail; nothing was said to a person";
    case "no_answer": return "nobody answered";
    case "busy": return "the line was busy";
    case "completed": return "they answered";
    case "failed": return why ? `the call failed: ${why}` : "the call failed";
    default: return "";
  }
}

/**
 * How long the call ran, in seconds. `metadata.call_duration_secs` is their own field for it; the
 * two fallbacks are the names the same number appears under elsewhere in their payloads.
 */
function durationOf(body) {
  for (const raw of [body?.metadata?.call_duration_secs, body?.call_duration_secs, body?.metadata?.call_duration_seconds, body?.duration_secs]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

/**
 * What the call cost, in whole cents — or null, which is not the same as nothing.
 *
 * Their `metadata.cost` is in credits, not dollars, and what a credit costs depends on the plan. So
 * the honest answer is almost always null: Reason does not know, and writing a credit count into a
 * cents column would put a number on the owner's receipt that means nothing. Only an explicit
 * dollar figure, if a payload ever carries one, is turned into cents.
 *
 * Bland's lesson is still applied to that figure: a call that ran is never billed nothing, so a zero
 * against a real length reads as "not priced yet" rather than as free.
 */
function costCentsOf(body) {
  const raw = body?.metadata?.cost_usd ?? body?.cost_usd ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const price = Number(raw);
  if (!Number.isFinite(price) || price < 0) return null;
  if (price === 0) return (durationOf(body) ?? 0) > 0 ? null : 0;
  return Math.max(1, Math.round(price * 100));
}

/** Their summary of the call, when the agent is configured to produce one. */
function summaryOf(body) {
  for (const raw of [body?.analysis?.transcript_summary, body?.transcript_summary, body?.summary]) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return "";
}

/**
 * Their turn list → the two-speaker transcript the rest of Reason quotes from.
 *
 * `role` is `user` for the person on the phone and `agent` for the voice Reason sent. Named "Reason"
 * rather than "Agent" because this string is what gets written into somebody's own thread, and a
 * transcript they read later should say who was talking in the words they use.
 */
export function transcriptOf(body) {
  const turns = Array.isArray(body?.transcript) ? body.transcript
    : Array.isArray(body?.transcript?.turns) ? body.transcript.turns
      : Array.isArray(body?.messages) ? body.messages : [];
  const lines = turns.map(t => {
    const text = String(t?.message ?? t?.text ?? t?.content ?? "").trim();
    if (!text) return "";
    const who = String(t?.role ?? t?.speaker ?? "").toLowerCase();
    return `${who === "user" || who === "human" ? "Them" : "Reason"}: ${text}`;
  }).filter(Boolean);
  if (lines.length) return lines.join("\n");
  return typeof body?.transcript === "string" ? body.transcript.trim() : "";
}

/**
 * The turns of a transcript as the two-sided list a thread can be written from.
 *
 * Separate from `transcriptOf` because they are wanted for different things: the string above is
 * what the call row keeps and what the model quotes, while this is what src/calls/postcall.js turns
 * into real conversation turns so a text ten minutes later continues the call.
 */
export function transcriptTurns(body) {
  const turns = Array.isArray(body?.transcript) ? body.transcript
    : Array.isArray(body?.transcript?.turns) ? body.transcript.turns
      : Array.isArray(body?.messages) ? body.messages : [];
  return turns.map(t => {
    const text = String(t?.message ?? t?.text ?? t?.content ?? "").trim();
    if (!text) return null;
    const who = String(t?.role ?? t?.speaker ?? "").toLowerCase();
    return { who: who === "user" || who === "human" ? "them" : "reason", text };
  }).filter(Boolean);
}

/** Why a placement did not take, in words the owner can be told. */
function placeError(res, json) {
  const detail = [
    typeof json?.detail === "string" ? json.detail : "",
    typeof json?.detail?.message === "string" ? json.detail.message : "",
    typeof json?.message === "string" ? json.message : "",
    typeof json?.error === "string" ? json.error : "",
  ].map(s => s.trim()).filter(Boolean).join(" — ");
  if (res && !res.ok) return `ElevenLabs refused the call (HTTP ${res.status})${detail ? `: ${detail}` : ""}`;
  if (detail) return `ElevenLabs refused the call: ${detail}`;
  return "ElevenLabs accepted the request but returned no conversation_id, so there is no call to follow";
}
