// What a call audit needs to have numbers instead of guesses (2026-10-30 call quality audit):
// how long the caller waited on each turn, why each call ended, and what the platform says it cost.
//
// Nothing here changes what a caller hears. The turn meter watches the stream the endpoint already
// sends and writes one row when it ends; the end reason and the cost are read off the post-call
// payload the settle path already has in hand.

/**
 * The normalised reasons a call ended. One of these goes in `calls.end_reason`; the platform's own
 * words go in `calls.end_detail` beside it, so a mapping that turns out wrong can be redone.
 *
 *   caller_hung_up    the caller hung up — only from a platform that says which side did; ElevenLabs
 *                     does not ("Call ended by remote party" either way), so it is never set from it
 *   remote_hung_up    the line was hung up from the far end ("Call ended by remote party")
 *   end_call          Reason hung up itself, through the end_call tool
 *   voicemail         it reached a voicemail or answering machine
 *   platform_error    `metadata.error` was present, or "custom_llm generation failed" (code and reason
 *                     in end_detail)
 *   duration_cap      the platform's maximum call length ran out
 *   lost              nothing ever said how it ended; the lost-calls sweep closed it (replaced if a
 *                     post-call delivery arrives later)
 *   transfer          it was transferred to another number
 *   no_answer         nobody picked up, or the line was busy (end_detail says which)
 *   inactivity        the platform's silence/inactivity timeout ended it
 */
export const END_REASONS = [
  "caller_hung_up", "remote_hung_up", "end_call", "voicemail",
  "platform_error", "duration_cap", "lost", "transfer",
  // Not errors and not hang-ups: see endReasonOf.
  "no_answer", "inactivity",
];

/** The platform's termination words, from any of the places a payload has carried them. */
export function terminationOf(body) {
  const t = body?.metadata?.termination_reason ?? body?.termination_reason ?? "";
  return typeof t === "string" ? t.trim() : String(t ?? "").trim();
}

/** Their words when the custom LLM failed the call (calls 13 and 22, 2026-10-30). */
const LLM_FAILED = /custom_llm generation failed/i;

/**
 * An error the platform attached, as `{ code, type, message }`, or null.
 *
 * Only two things are an error: a present `metadata.error` — `{ code: 1002, error_type: "llm_error",
 * reason: "custom_llm_error: ..." }` on calls 13 and 22, null on a normal call — or the termination
 * words "custom_llm generation failed". A timeout for silence, no answer or a busy line is how a call
 * ends, not a platform fault, and is mapped on its own in `endReasonOf`.
 */
export function platformErrorOf(body, termination = terminationOf(body)) {
  const e = body?.metadata?.error ?? null;
  if (e && typeof e === "object") {
    const code = e.code ?? null;
    return {
      code: code == null ? null : (Number.isFinite(Number(code)) ? Number(code) : String(code)),
      type: String(e.error_type ?? "").trim(),
      message: String(e.reason ?? e.message ?? "").trim(),
    };
  }
  if (typeof e === "string" && e.trim()) return { code: null, type: "", message: e.trim() };
  if (LLM_FAILED.test(termination)) return { code: null, type: "", message: "" };
  return null;
}

/**
 * Why one call ended, normalised.
 *
 * `live` is what the provider read off the conversation (`readConversation`, plus `termination` and
 * `error`); `row` is our own call row, which knows a voicemail was left; `turns` is its call_turns
 * rows, whose tool names say whether Reason itself asked to hang up. Returns `{ reason, detail }`;
 * `reason` is null when nothing says why, rather than a guess — the raw words stay in `detail`.
 *
 * Beyond the eight in END_REASONS, two more endings are their own values rather than being filed as
 * errors: `no_answer` (nobody picked up, or the line was busy — the detail says which) and
 * `inactivity` (the platform's silence/inactivity timeout).
 */
export function endReasonOf({ live = {}, row = {}, turns = [] } = {}) {
  const why = String(live.termination ?? "").trim();
  const err = live.error ?? null;
  const detail = [
    why,
    err && (err.code != null || err.type || err.message)
      ? `error${err.code != null ? ` ${err.code}` : ""}${err.type ? ` ${err.type}` : ""}${err.message && err.message !== why ? `: ${err.message}` : ""}`
      : "",
  ].filter(Boolean).join(" | ");
  const say = (reason) => ({ reason, detail });

  if (live.state === "voicemail" || Number(row.voicemail_left) === 1 || /voicemail|answering[\s_-]?machine/i.test(why)) return say("voicemail");
  if (err || LLM_FAILED.test(why)) return say("platform_error");
  if (/transfer/i.test(why)) return say("transfer");
  if (/end_call/i.test(why)) return say("end_call");
  if (/max(imum)?[\s_-]*(call[\s_-]*)?duration|duration[\s_-]*(limit|exceeded|cap)/i.test(why)) return say("duration_cap");
  if (["no_answer", "busy"].includes(live.state) || /no[\s_-]?answer|not[\s_-]?answered|unanswered|busy/i.test(why)) return say("no_answer");
  if (/inactiv|silence|silent|timeout|timed[\s_-]?out/i.test(why)) return say("inactivity");
  // "Call ended by remote party" is their word for a hang-up on an outbound OR an inbound call (seen
  // on 32 and 20): it does not say which side, so neither does this. `caller_hung_up` stays in
  // END_REASONS for a platform that does say; ElevenLabs never produces it.
  if (/remote party|hung[\s_-]?up|hang[\s_-]?up|hangup|disconnect/i.test(why)) return say("remote_hung_up");
  // Nothing in their words, but our own turns asked to hang up as the last thing they did.
  const last = turns.length ? turns[turns.length - 1] : null;
  const lastTools = Array.isArray(last?.tools) ? last.tools : [];
  if (lastTools.includes("end_call")) return say("end_call");
  if (lastTools.includes("transfer_to_number")) return say("transfer");
  return say(null);
}

/**
 * A finished call's end reason and platform cost as call-row fields. Shared by the settle path, the
 * late-details path and a post-call delivery that arrives after the sweep wrote the call off.
 */
export function endFieldsFor(row, live, turns = []) {
  const end = endReasonOf({ live, row, turns });
  return {
    end_reason: end.reason, end_detail: end.detail,
    cost_credits: Number.isFinite(live.costCredits) ? live.costCredits : null,
    cost_raw: typeof live.costRaw === "string" ? live.costRaw : "",
  };
}

/**
 * What the platform reported the call cost, as it reported it.
 *
 * Confirmed on real conversations 2026-10-30: `metadata.cost` is credits (= `charging.call_charge`),
 * `metadata.cost_fiat` is USD (= `charging.platform_price`, which `costCentsOf` turns into cents), and
 * `charging` carries the tier and the TTS/ASR usage. Only those few numbers are kept in `cost_raw` —
 * the LLM price there is 0 because Reason is the custom LLM, and nothing else in the payload is cost.
 */
export function platformCostOf(body) {
  const md = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
  const n = Number(md.cost);
  const credits = md.cost == null || md.cost === "" || !Number.isFinite(n) ? null : n;
  const ch = md.charging && typeof md.charging === "object" ? md.charging : {};
  const picked = {
    cost: md.cost,
    cost_fiat: md.cost_fiat,
    tier: ch.tier,
    tts_audio_output_seconds: ch.tts_usage?.total_audio_output_seconds,
    tts_characters: ch.tts_usage?.total_characters,
    asr_audio_input_seconds: ch.asr_usage?.total_audio_input_seconds,
  };
  const raw = Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined && v !== null));
  return { credits, raw: Object.keys(raw).length ? JSON.stringify(raw) : "" };
}

// ---------- the turn meter ----------

/**
 * What one content delta was, for the first-content timings. Passed the exact strings voice.js
 * streams, so this does not drift from them: the holding line, a "one sec…" filler, a canned fallback
 * ("something broke", "let me come back to you") or — anything else — the model's own words.
 */
export function contentKind(content, { holdingLine, holdingLines = [], fillers = [], fallbacks = [], openings = [] } = {}) {
  const exact = String(content ?? "");
  const s = exact.trim();
  if (!s) return null;
  // The holding line and the late line (voice.js `LATE_LINE`) are both "holding_line".
  if ([holdingLine, ...holdingLines].some(h => h && s === String(h).trim())) return "holding_line";
  // Exact, not trimmed: the code's filler carries its trailing space; a model's own "..." does not.
  if (fillers.some(f => exact === String(f) || exact === ` ${f}`)) return "filler";
  if (fallbacks.some(f => s === String(f).trim())) return "fallback";
  // The disclosure on a third-party call, said by code before anything else.
  if (openings.some(f => s === String(f).trim())) return "opening";
  // Nothing but dots from the model: dead air on the line, not words.
  if (/^[.\s…]+$/.test(s)) return "dots";
  return "real";
}

/** One SSE string → its content delta and any tool-call names in it. */
function readSse(s) {
  const str = String(s);
  if (!str.startsWith("data: ") || str.includes("[DONE]")) return { content: "", tools: [] };
  try {
    const delta = JSON.parse(str.slice(6))?.choices?.[0]?.delta ?? {};
    const tools = Array.isArray(delta.tool_calls) ? delta.tool_calls.map(t => t?.function?.name).filter(Boolean) : [];
    return { content: typeof delta.content === "string" ? delta.content : "", tools };
  } catch { return { content: "", tools: [] }; }
}

/**
 * The same stream, watched. Times are from `t0` (the moment the request arrived) to the first
 * content, the first real content, and the end. `meter.tools` is shared with the turn so Reason's own
 * tools (which never appear in the stream) land in the same set as the platform's. `onEnd` gets the
 * numbers once, however the stream ends; `closedEarly` is true when the reader stopped before the
 * stream had finished (the platform closed the socket, or a newer turn replaced this one).
 */
export async function* metered(stream, { t0 = Date.now(), meter, kinds = {}, aborted = () => false, onEnd = () => {}, now = () => Date.now() }) {
  let finished = false;
  try {
    for await (const s of stream) {
      const { content, tools } = readSse(s);
      for (const t of tools) meter.tools.add(t);
      const kind = content ? contentKind(content, kinds) : null;
      if (kind) {
        if (meter.firstContentMs == null) { meter.firstContentMs = now() - t0; meter.firstContentKind = kind; }
        if (kind === "holding_line") meter.holdingLine = true;
        if (kind === "real" && meter.firstRealMs == null) meter.firstRealMs = now() - t0;
      }
      yield s;
    }
    finished = true;
  } finally {
    try {
      onEnd({ ...meter, totalMs: now() - t0, closedEarly: !finished || aborted() });
    } catch { /* a meter never breaks a call */ }
  }
}

/** A fresh meter for one turn. */
export function newMeter() {
  return { firstContentMs: null, firstContentKind: null, firstRealMs: null, holdingLine: false, tools: new Set(), usage: {} };
}

/** Add one model request's token usage into a turn's running total. */
export function addUsage(meter, u) {
  if (!meter || !u) return;
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const n = Number(u[k]);
    if (Number.isFinite(n)) meter.usage[k] = (meter.usage[k] ?? 0) + n;
  }
}

/** p-th percentile (nearest rank) of a list of numbers, or null for an empty one. */
export function percentile(values, p) {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[i];
}
