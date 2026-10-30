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
 *   caller_hung_up    the person on an inbound call hung up
 *   remote_hung_up    the person Reason rang hung up (outbound)
 *   end_call          Reason hung up itself, through the end_call tool
 *   voicemail         it reached a voicemail or answering machine
 *   platform_error    the platform ended it on an error (custom_llm_error, a websocket error code…)
 *   duration_cap      the platform's maximum call length ran out
 *   lost              nothing ever said how it ended; the lost-calls sweep closed it
 *   transfer          it was transferred to another number
 */
export const END_REASONS = [
  "caller_hung_up", "remote_hung_up", "end_call", "voicemail",
  "platform_error", "duration_cap", "lost", "transfer",
];

/** The platform's termination words, from any of the places a payload has carried them. */
export function terminationOf(body) {
  const t = body?.metadata?.termination_reason ?? body?.termination_reason ?? "";
  return typeof t === "string" ? t.trim() : String(t ?? "").trim();
}

/**
 * An error the platform attached, as `{ code, message }`, or null.
 *
 * Read from `metadata.error` (object or string) and from the termination words. Which of these the
 * platform really fills on a failed call has NOT been seen on a real payload; the audit only knows
 * the dashboard showed "custom_llm_error: LLM Cascade Error: TimeoutError" and a 1002.
 */
export function platformErrorOf(body, termination = terminationOf(body)) {
  const e = body?.metadata?.error ?? body?.error ?? null;
  let code = null;
  let message = "";
  if (e && typeof e === "object") {
    code = e.code ?? e.error_code ?? null;
    message = String(e.reason ?? e.message ?? e.detail ?? "").trim();
  } else if (typeof e === "string" && e.trim()) {
    message = e.trim();
  }
  const text = `${message} ${termination}`;
  if (code == null) {
    const m = /\b(1\d{3}|4\d{3})\b/.exec(text);
    if (m) code = Number(m[1]);
  }
  const errorish = /error|exception|failed|failure|timeout|timed out|custom_llm/i.test(text);
  // A websocket close code of 1000 is a normal close, not an error.
  const badCode = code != null && Number(code) !== 1000;
  if (!errorish && !badCode) return null;
  return { code: code == null ? null : (Number.isFinite(Number(code)) ? Number(code) : String(code)), message: message || termination };
}

/**
 * Why one call ended, normalised.
 *
 * `live` is what the provider read off the conversation (`readConversation`, plus `termination` and
 * `error`); `row` is our own call row, which knows things the platform does not — that a voicemail
 * was left, which direction the call went — and `turns` is its call_turns rows, whose tool names say
 * whether Reason itself asked to hang up. Returns `{ reason, detail }`; `reason` is null when nothing
 * says why, rather than a guess.
 */
export function endReasonOf({ live = {}, row = {}, turns = [] } = {}) {
  const why = String(live.termination ?? "").trim();
  const err = live.error ?? null;
  const detail = [
    why,
    err ? `error${err.code != null ? ` ${err.code}` : ""}${err.message && err.message !== why ? `: ${err.message}` : ""}` : "",
  ].filter(Boolean).join(" | ");
  const say = (reason) => ({ reason, detail });

  if (live.state === "voicemail" || Number(row.voicemail_left) === 1 || /voicemail|answering[\s_-]?machine/i.test(why)) return say("voicemail");
  if (/transfer/i.test(why)) return say("transfer");
  if (/end_call|agent ended|ended by (the )?agent/i.test(why)) return say("end_call");
  if (/max(imum)?[\s_-]*(call[\s_-]*)?duration|duration[\s_-]*(limit|exceeded|cap)|time[\s_-]*limit/i.test(why)) return say("duration_cap");
  if (err || live.state === "failed") {
    if (err || why) return say("platform_error");
  }
  if (/remote party|hung[\s_-]?up|hang[\s_-]?up|hangup|disconnect|user ended|caller|client/i.test(why)) {
    return say(row.direction === "in" ? "caller_hung_up" : "remote_hung_up");
  }
  // Nothing in their words, but our own turns asked to hang up as the last thing they did.
  const last = turns.length ? turns[turns.length - 1] : null;
  const lastTools = Array.isArray(last?.tools) ? last.tools : [];
  if (lastTools.includes("end_call")) return say("end_call");
  if (lastTools.includes("transfer_to_number")) return say("transfer");
  return say(null);
}

/**
 * What the platform reported the call cost, as it reported it.
 *
 * `metadata.cost` is the one field the code already knew (credits, per `costCentsOf`). Every other
 * key in `metadata` whose name looks cost- or usage-shaped (`charging`, `llm_usage`, …) is kept raw,
 * because none of them has been seen on a real payload and reading them would be guessing.
 */
export function platformCostOf(body) {
  const md = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
  const n = Number(md.cost);
  const credits = md.cost == null || md.cost === "" || !Number.isFinite(n) ? null : n;
  const raw = {};
  for (const [k, v] of Object.entries(md)) {
    if (/cost|charg|usage|billing|credit|price/i.test(k) && v != null) raw[k] = v;
  }
  for (const k of ["cost", "charging", "llm_usage"]) {
    if (body?.[k] != null && raw[k] === undefined) raw[`top.${k}`] = body[k];
  }
  return { credits, raw: Object.keys(raw).length ? JSON.stringify(raw) : "" };
}

// ---------- the turn meter ----------

/**
 * What one content delta was, for the first-content timings. Passed the exact strings voice.js
 * streams, so this does not drift from them: the holding line, a "one sec…" filler, a canned fallback
 * ("something broke", "let me come back to you") or — anything else — the model's own words.
 */
export function contentKind(content, { holdingLine, fillers = [], fallbacks = [] } = {}) {
  const s = String(content ?? "").trim();
  if (!s) return null;
  if (holdingLine && s === String(holdingLine).trim()) return "holding_line";
  if (fillers.some(f => s === String(f).trim())) return "filler";
  if (fallbacks.some(f => s === String(f).trim())) return "fallback";
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
