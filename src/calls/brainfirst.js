// The speaking brain (REASON_CALL_BRAIN, docs/calls-brain-first.md): on a person's own call, every
// sentence they hear is written by Reason, from what Reason knows, and the voice provider is only ears
// and a mouth. Today a Cartesia agent's own small model answers most turns and asks Reason only
// sometimes (calls 113-116: 0-1 asks); every bad moment on those calls came from that split.
//
// Two speeds, one brain:
//   - the SPEAKING turn (`speakTurn`): Reason's own call context (the same assembly a call turn has
//     today: profile, rules, today so far, earlier calls, what memory saved lately, open work, pages,
//     purchases, their thread) plus the facts closest to what they are likely to raise, read once while
//     the call opens (`preloadFor`), on a fast model with no tools but one. It speaks its first sentence
//     as soon as it is written.
//   - the THINKING turn: when the answer needs a lookup, an action, or anything not in front of it,
//     the speaking turn says a few words and hands over (`HANDOFF_TOOL`); the caller runs Reason's full
//     call brain (`reasonTurn` in ./gptlive.js: every tool, every gate) with the music the
//     ask already plays.
//
// Safety is code, not prompt, at the one place words leave (`guardSentence`): a done-claim from the
// speaking turn is never said (it hands over to the full brain, which reads the record); internal
// markers are taken out (`forVoice`); money, cards, codes and saved logins hand over at once, where the
// trust gate and the deferral line already are. Nothing here sends, saves or books anything.
//
// Off unless REASON_CALL_BRAIN is set (`brainFirstFor`): merging this changes no call.
import { config } from "../config.js";
import * as accounts from "../accounts.js";
import * as db from "../db.js";
import { memoryHits } from "../memorynote.js";
import { timingSafeEqual } from "node:crypto";
import { saysDone, confirmsDone, forVoice, SECRETISH, withDeferredLine } from "./cartesia.js";
import * as calltrust from "./calltrust.js";
import * as opening from "./brainopener.js";
import { instantReply } from "./brainbank.js";

/** The fast model the speaking turn runs on (one the app already uses). REASON_CALL_BRAIN_MODEL overrides. */
export const SPEAK_MODEL_DEFAULT = "claude-haiku-5-5";
export const speakModel = () => String(process.env.REASON_CALL_BRAIN_MODEL ?? "").trim() || SPEAK_MODEL_DEFAULT;
/** A speaking turn is short: past this many tokens it is not a phone sentence any more. */
export const SPEAK_MAX_TOKENS = 220;
// No per-turn memory search in front of the first word: measured 0.22-0.74 s (p50 ~0.29) and in time for
// a 250 ms race on 3 of 17 replayed turns. The preload carries memory; the full brain searches its own.
/** How many preloaded lines ride on the call (facts plus what Reason did and said). */
export const PRELOAD_MAX = 14;

/**
 * Does this call get the speaking brain? Mirrors `cartesiaTrialFor` (./calltrial.js): only a person's
 * own call with Reason (`is_owner`), and only at `owner` (the operator's account) or `on` (everyone's).
 * Never a business, another person, an errand or a stranger. Off or unset: never.
 */
export function brainFirstFor(row, { mode = config.callBrain } = {}) {
  if (mode !== "owner" && mode !== "on") return false;
  if (!row?.conversation_id || Number(row.is_owner) !== 1) return false;
  try {
    const me = accounts.ownerOf(row.conversation_id);
    return mode === "on" ? (me?.known === true || me?.isOperator === true) : me?.isOperator === true;
  } catch { return false; }
}

/** The one tool the speaking turn has: hand the turn to Reason's full brain. */
export const HANDOFF_TOOL = {
  name: "think_it_through",
  description: "Hand this turn to your full self, with every tool: anything that needs a lookup (web, calendar, email, a page, prices, directions, weather), an action (book, send, text, remind, order, sign in, pay, start or check a task), whether something has been done, or a fact you do not have in front of you. You say a few words first; your full self answers right after.",
  input_schema: {
    type: "object",
    properties: { ask: { type: "string", description: "What they want, in one sentence, with the details they gave." } },
    required: ["ask"],
  },
};

/** The text prompt's paragraphs a phone turn does not use: how to use the tools, how to lay out a text. */
const TEXT_ONLY = [/^How you work\b/, /^How you lay a message out\b/];
/** Reason's own persona and hard rules from the text prompt, without its tool manual (~70k chars). */
export function corePersona(textPrompt) {
  return String(textPrompt ?? "").split("\n\n").filter(p => p.length < 8000 && !TEXT_ONLY.some(re => re.test(p.trim()))).join("\n\n");
}

/** The speaking turn's frame: how it talks, what it may say itself, and when it hands over. */
export const SPEAK_FRAME = `--- YOU ARE SPEAKING ON A PHONE CALL: every word you write is said out loud, at once ---
This is their own call with you, Reason. You have everything in front of you that you have in a text: their profile, their rules, today's chats, your earlier calls, what you saved lately, open work, and the memories closest to what they are saying. Use it the way you do in a text: connect it, name it in passing ("the events idea from last night?"), never "I recall you mentioned".
- Answer from what is in front of you, right away, in one to three short spoken sentences. Lead with the answer. No lists, links, markdown, emoji or stage directions.
- You DO remember: earlier calls and texts are above. Never say you only know this call, or that you have no memory of earlier calls.
- If the answer needs a lookup, an action, a check of whether something was done, or a fact that is not above: say five words or fewer that promise nothing ("Let me check that.", "One sec, pulling that up."), then call think_it_through. Never guess, never invent a number, date, name or price.
- Never say anything is done, booked, sent, submitted, scheduled or paid. Whether something is done is always think_it_through.
- Money, card numbers, codes, passwords and saved logins are never said or taken by voice: call think_it_through.
- A question back to them is fine when you truly need one detail; ask one.
- If they say goodbye, say a short goodbye and nothing else.`;

/** The speaking turn's system prompt: the persona, the call's own context, the preload, the frame. */
export function speakingSystem({ context, preloaded = [] } = {}) {
  const sys = String(context?.system ?? "");
  const cut = sys.indexOf("--- you are ON A PHONE CALL");
  const textPart = cut > 0 ? sys.slice(0, cut) : "";
  const callPart = cut > 0 ? sys.slice(cut) : sys;
  return [
    corePersona(textPart),
    callPart,
    preloaded.length ? `WHAT YOU REMEMBER THAT MAY COME UP ON THIS CALL (saved facts and things you did or said, closest to what they have been on about; not something they said now):\n${preloaded.join("\n")}` : "",
    SPEAK_FRAME,
  ].filter(s => String(s).trim()).join("\n\n");
}

/**
 * What they are likely to raise, read once while the call opens: the facts and the history (what Reason
 * did and said) closest to the last call, today's thread and the open work. Before `until` only.
 * Never throws; [] when nothing could be read.
 */
export async function preloadFor(call, { until = Number(call?.created_at) || Date.now(), find = memoryHits, history = historyNear, topics = topicsFor(call, until), exclude = new Set(), log = () => {} } = {}) {
  if (!call?.conversation_id || !topics.length) return [];
  const c = call.conversation_id;
  try {
    const [facts, hist] = await Promise.all([
      Promise.all(topics.map(t => find(c, t, { log, exclude, timeoutMs: 2500 }).catch(() => []))),
      Promise.all(topics.map(t => history(c, t, { until }).catch(() => []))),
    ]);
    const lines = [];
    const seen = new Set();
    // Interleaved, so each topic gets its best line before any topic gets its third.
    const lists = [...facts, ...hist];
    for (let i = 0; lines.length < PRELOAD_MAX && i < 6; i++) {
      for (const list of lists) {
        const l = list[i];
        if (!l || seen.has(l)) continue;
        seen.add(l); lines.push(l);
        if (lines.length >= PRELOAD_MAX) break;
      }
    }
    log({ brain_preload: call.id, topics: topics.length, lines: lines.length });
    return lines;
  } catch (e) {
    log({ brain_preload_failed: call?.id, why: (e?.message ?? String(e)).split("\n")[0] });
    return [];
  }
}

/** The topics a call opens on: the last own call's summary, their newest lines today, open work. */
export function topicsFor(call, until) {
  const out = [];
  try {
    const last = db.listCalls(call.conversation_id, { limit: 10 }).find(r => r.id !== call.id && Number(r.is_owner) === 1 && Number(r.created_at) < until && String(r.summary ?? "").trim());
    if (last) out.push(String(last.summary).slice(0, 600));
  } catch { /* no calls */ }
  try {
    const theirs = db.db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'user' AND at < ? ORDER BY at DESC LIMIT 4").all(call.conversation_id, until)
      .map(r => String(r.text ?? "").replace(/^\[[^\]]*\]\s*[^:]{0,40}:\s*/, "").trim()).filter(Boolean);
    if (theirs.length) out.push(theirs.reverse().join(" ").slice(-600));
  } catch { /* no thread */ }
  return out;
}

/** What Reason did and said that is closest to `text` (src/recallindex.js), as "- (date) what" lines. */
export async function historyNear(conversationId, text, { until = Date.now(), limit = 3 } = {}) {
  if (!config.openaiKey || !String(text ?? "").trim()) return [];
  const [{ embed }, recallIndex] = await Promise.all([import("../embedding.js"), import("../recallindex.js")]);
  const [vector] = await embed(text);
  return recallIndex.searchHistory(conversationId, vector, { limit: limit + 3, minScore: 0.35 })
    .filter(h => !h.at || Number(h.at) < until).slice(0, limit)
    .map(h => `- (${h.date ?? "earlier"}, ${h.source === "calls" ? "a call" : "what you did"}) ${String(h.text ?? h.snippet ?? "").replace(/\s+/g, " ").trim()}`)
    .filter(l => l.length > 20);
}

/** Their words need the full brain before a word of ours: money, cards, codes, saved logins. */
export const needsFullBrain = (theirWords) => SECRETISH.test(String(theirWords ?? "")) || /\b(?:pay|charge|card|password|log\s*in|sign\s*in|bank|transfer|venmo|zelle)\b/i.test(String(theirWords ?? ""));

/**
 * They are asking whether something has been done ("is it done?", "did you send it?", "have you booked
 * it?"). Whether a thing is done is only ever the full brain's to say, from the record: these never reach
 * the speaking turn. Broader than `confirmsDone`'s question (which misses "did you send it?").
 */
const DONE_VERBS = "done|finish(?:ed)?|send|sent|book(?:ed)?|order(?:ed)?|submit(?:ted)?|pa(?:y|id)|schedul(?:e|ed)|text(?:ed)?|e-?mail(?:ed)?|cancel+(?:ed)?|reserv(?:e|ed)|confirm(?:ed)?|set\\s+up|sign(?:ed)?\\s+up|file[d]?|bought|buy|call(?:ed)?|go(?:ne)?\\s+through|went\\s+through";
const DONE_ASK = new RegExp(`\\b(?:did|have|has|is|was|were|are|didn'?t|haven'?t|hasn'?t)\\b(?:\\s+[\\w']+){0,4}?\\s+(?:${DONE_VERBS})\\b|\\b(?:${DONE_VERBS})\\b[^.?!]{0,30}\\byet\\b|^\\s*(?:so\\s+)?(?:is\\s+it|it'?s)\\s+(?:done|in|booked|sent)\\s*\\??\\s*$`, "i");
export const asksIfDone = (theirWords) => DONE_ASK.test(String(theirWords ?? ""));

/**
 * One spoken sentence through the guards. Returns { say } with the words to speak (markers out), or
 * { handoff: why } when the sentence must not be said: a done-claim, or a yes to "is it done?".
 */
export function guardSentence(sentence, { theirWords = "", saidSoFar = "" } = {}) {
  const say = forVoice(sentence);
  if (!say) return { say: "" };
  if (saysDone(say)) return { handoff: "done_claim" };
  if (!saidSoFar && confirmsDone(theirWords, say)) return { handoff: "done_yes" };
  return { say };
}

/**
 * No thinking before the first word, in each model's own words (each refuses the others'): Haiku takes
 * "disabled", Sonnet "between_tools", Opus only "adaptive" with low effort.
 */
export const thinkingFor = (model) => ({ type: /sonnet/.test(String(model)) ? "between_tools" : /opus/.test(String(model)) ? "adaptive" : "disabled" });
export const modelOptions = (model) => ({ thinking: thinkingFor(model), ...(/opus/.test(String(model)) ? { output_config: { effort: "low" } } : {}) });

/** Sentence ends for streaming: the first sentence goes the moment it is complete. */
const SENTENCE_END = /([.!?…]+)(["')\]]?)(\s+|$)/;

/**
 * One speaking turn, streamed. Yields, in order:
 *   { type: "say", text, ms }     a sentence ready for the voice (first one as soon as it is written)
 *   { type: "handoff", ask, why, ms }  hand the turn to the full brain now (after any "say" already given)
 *   { type: "done", text, usage, ms, firstMs }
 * `stream` is injectable: given a request body, an async iterable of Anthropic stream events.
 */
export async function* speakTurn({ system, messages, theirWords = "", model = speakModel(), stream, now = () => Date.now(), log = () => {}, callId = null, opener = "", prefill = OPENER_PREFILL }) {
  const t0 = now();
  const careful = needsFullBrain(theirWords) ? "careful_topic" : asksIfDone(theirWords) ? "done_question" : null;
  if (careful) {
    yield { type: "handoff", ask: theirWords, why: careful, ms: 0 };
    yield { type: "done", text: "", usage: {}, ms: 0, firstMs: null };
    return;
  }
  const body = {
    model, max_tokens: SPEAK_MAX_TOKENS,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [HANDOFF_TOOL],
    // With an opener already said, the turn is told so and writes only what follows it (./brainopener.js).
    messages: opener ? opening.withOpener(messages, opener, { prefill }) : messages,
    // No up-front thinking pass: on a phone it is seconds of silence before the first word (call 38).
    ...modelOptions(model),
    stream: true,
  };
  let buf = "";
  let said = "";
  let firstMs = null;
  let toolOpen = false;
  let json = "";
  const usage = {};
  let stopped = null;
  const emit = function* (piece) {
    const g = guardSentence(piece, { theirWords, saidSoFar: said });
    if (g.handoff) { stopped = g.handoff; return; }
    if (!g.say) return;
    said = said ? `${said} ${g.say}` : g.say;
    if (firstMs == null) firstMs = now() - t0;
    yield { type: "say", text: g.say, ms: now() - t0 };
  };
  for await (const ev of stream(body)) {
    if (ev.type === "message_start" && ev.message?.usage) Object.assign(usage, ev.message.usage);
    if (ev.type === "message_delta" && ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      if (buf.trim()) { yield* emit(buf); buf = ""; }
      toolOpen = true; json = "";
      continue;
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") { json += ev.delta.partial_json ?? ""; continue; }
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && !toolOpen) {
      buf += ev.delta.text ?? "";
      let m;
      while (!stopped && (m = buf.match(SENTENCE_END))) {
        const end = m.index + m[1].length + m[2].length;
        const piece = buf.slice(0, end);
        buf = buf.slice(end).replace(/^\s+/, "");
        yield* emit(piece);
      }
      if (stopped) break;
    }
  }
  if (!stopped && !toolOpen && buf.trim()) yield* emit(buf);
  if (stopped || toolOpen) {
    let ask = theirWords;
    try { ask = JSON.parse(json || "{}").ask || theirWords; } catch { /* their words */ }
    if (stopped) log({ brain_guard: callId, why: stopped });
    yield { type: "handoff", ask, why: stopped ?? "asked", ms: now() - t0 };
  }
  yield { type: "done", text: said, usage, ms: now() - t0, firstMs };
}

/** Whether the opener also rides as an assistant prefill (measured: see docs/calls-brain-first.md). */
export const OPENER_PREFILL = false;

/**
 * Two speaking turns started together the moment they stop talking: A as usual, B told it has already
 * said `opener`. If A's first sentence (or its hand-off) is in by `atMs`, A is used, B is stopped and no
 * opener is said. Otherwise the opener is said at `atMs` and B's words follow it as one sentence.
 * Yields the events of whichever won, with { opener } on the opener's own say event.
 */
export async function* withOpenerRace({ speakA, speakB, opener, atMs = opening.OPENER_AT_MS, stopA = () => {}, stopB = () => {}, timers = globalThis, now = () => Date.now() }) {
  const t0 = now();
  const queue = (gen) => {
    const q = { items: [], done: false, wake: null };
    (async () => {
      try { for await (const ev of gen) { q.items.push(ev); q.wake?.(); } } catch (e) { q.items.push({ type: "error", why: (e?.message ?? String(e)).split("\n")[0] }); }
      q.done = true; q.wake?.();
    })();
    return q;
  };
  const next = (q) => (q.items.length || q.done ? Promise.resolve() : new Promise(r => { q.wake = r; }));
  const a = queue(speakA);
  const b = queue(speakB);
  const firstOf = (q) => q.items.find(e => e.type === "say" || e.type === "handoff" || e.type === "error");
  let timer;
  const deadline = new Promise(r => { timer = timers.setTimeout(r, Math.max(0, atMs)); });
  while (!firstOf(a) && !a.done) {
    const late = await Promise.race([next(a).then(() => false), deadline.then(() => true)]);
    if (late) break;
  }
  timers.clearTimeout(timer);
  const drain = async function* (q) {
    for (let i = 0; ; i++) {
      while (i >= q.items.length && !q.done) await next(q);
      if (i >= q.items.length) return;
      yield q.items[i];
    }
  };
  if (firstOf(a) && firstOf(a).type !== "error") { stopB(); yield* drain(a); return; }
  stopA();
  yield { type: "say", text: opener, opener: true, ms: now() - t0 };
  let saidAfter = false;
  for await (const ev of drain(b)) {
    if (ev.type === "say") {
      const text = saidAfter ? ev.text : opening.joinAfter(opener, ev.text);
      if (text) { saidAfter = true; yield { ...ev, text }; }
      continue;
    }
    // A hand-off right after an unfinished opener ("Okay, so") closes the sentence first.
    if (ev.type === "handoff" && !saidAfter && !/[.!?…]$/.test(opener)) yield { type: "say", text: opening.HANDOFF_TAIL, ms: now() - t0 };
    if (ev.type === "error") { yield { type: "handoff", ask: "", why: "error" }; continue; }
    yield ev;
  }
}

/** The Anthropic stream for `speakTurn`, on the API key the call backend already uses. */
export function anthropicStream({ client = null, signal = null } = {}) {
  let api = client;
  return async function* (body) {
    if (!api) api = new (await import("@anthropic-ai/sdk")).default();
    const s = await api.messages.create(body, signal ? { signal } : {});
    for await (const ev of s) yield ev;
  };
}

// ---------- one call's brain: built once at the start, then one turn per thing they say ----------

/** Per call: the speaking system prompt (built once, so every turn reads the same cached prefix). */
const sessions = new Map();

/**
 * Open a call's speaking brain: its call context (`contextFor` in ./voice.js, the same build a call turn
 * has), the preload, and one cache warm-up, while the call connects. Never throws; the promise is kept,
 * so a turn that comes early waits on the one build instead of starting another.
 */
export function openBrain(call, { voice = null, preload = preloadFor, warm = true, client = null, log = () => {} } = {}) {
  if (!call?.id) return Promise.resolve(null);
  if (sessions.has(call.id)) return sessions.get(call.id);
  const p = (async () => {
    const v = voice ?? await import("./voice.js");
    await v.prime();
    const context = v.contextFor({ call, kind: "owner", callMessages: [] });
    const preloaded = await preload(call, { log });
    const system = speakingSystem({ context, preloaded });
    if (warm && process.env.ANTHROPIC_API_KEY) {
      const api = client ?? new (await import("@anthropic-ai/sdk")).default();
      const model = speakModel();
      void api.messages.create({ model, max_tokens: 1, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], tools: [HANDOFF_TOOL], messages: [{ role: "user", content: "(warming up)" }], ...modelOptions(model) }, { timeout: 15_000, maxRetries: 0 })
        .then(() => log({ brain_warmed: call.id }), (e) => log({ brain_warm_failed: call.id, why: (e?.message ?? String(e)).split("\n")[0] }));
    }
    log({ brain_open: call.id, system_chars: system.length, preloaded: preloaded.length });
    return { system, preloaded };
  })().catch((e) => { log({ brain_open_failed: call?.id, why: (e?.message ?? String(e)).split("\n")[0] }); sessions.delete(call.id); return null; });
  sessions.set(call.id, p);
  return p;
}
export function closeBrain(callId) { sessions.delete(callId); recentOpeners.delete(callId); }

/** Openers on the speaking turn: REASON_CALL_BRAIN_OPENERS=off turns them off (on with the brain). */
export const OPENERS_ON = () => String(process.env.REASON_CALL_BRAIN_OPENERS ?? "on").trim().toLowerCase() !== "off";
/** The openers said on each call so far, newest last (never the same one twice running). */
const recentOpeners = new Map();
export const recentFor = (call) => { const k = call?.id ?? ""; if (!recentOpeners.has(k)) recentOpeners.set(k, []); return recentOpeners.get(k); };

/** Their newest words in a history of {role, content}. */
const lastTheirs = (history) => String([...(history ?? [])].reverse().find(m => m?.role === "user")?.content ?? "").trim();

/** What a Reason turn's verify_deferred holds now (it only grows on a call: ./verify.js queueForAfter). */
const deferredOf = (call) => { try { return String(db.getCall(call.conversation_id, call.id)?.verify_deferred ?? ""); } catch { return ""; } };

/**
 * One turn on the call: what they just said in, spoken sentences out. Yields
 *   { type: "say", text, from: "speak" | "full" | "trust" }, { type: "hold" } (play the lookup music now),
 *   { type: "end_call" }, and last { type: "done", handoff, ms }.
 * The safety half of the full brain's answer is the one the Cartesia ask has today (./cartesia.js `ask`):
 * a passphrase ask in its fixed words, the deferral line when something was put off, markers out.
 */
export async function* brainTurn({ call, history, speak = speakTurn, full, stream = null, streamB = null, session = null, openers = OPENERS_ON(), openerAtMs = opening.OPENER_AT_MS, recent = recentFor(call), log = () => {}, now = () => Date.now(), timers = globalThis }) {
  const t0 = now();
  let words = lastTheirs(history);
  // Their passphrase answer is checked in code and never reaches a model: only the marker goes on.
  let screened = false;
  if (calltrust.trustOn(call) && calltrust.listening(call)) {
    const heard = calltrust.hear(call, words, { log });
    if (heard) { words = heard.text; screened = true; }
  }
  // A line code owes now (after a passphrase check, or for a set-up) is said instead of a model turn.
  const owed = calltrust.trustOn(call) ? calltrust.owedLine(call, { theirWords: words, log }) : null;
  if (owed) { yield { type: "say", text: forVoice(owed), from: "trust" }; yield { type: "done", handoff: null, ms: now() - t0 }; return; }
  // Bucket A (./brainbank.js): a turn that needs no brain ("are you with me?", "thanks") is answered at
  // once from the bank, and no model is called. Never for screened passphrase words.
  if (openers && !screened) {
    const instant = instantReply(words, { history, recent });
    if (instant) {
      log({ brain_instant: call.id, bucket: instant.bucket });
      yield { type: "say", text: instant.text, from: "bank", bucket: instant.bucket, delivery: instant.delivery };
      yield { type: "done", handoff: null, instant: instant.bucket, ms: now() - t0 };
      return;
    }
  }
  const messages = (history ?? []).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") })).filter(m => m.content.trim());
  if (screened && messages.at(-1)?.role === "user") messages[messages.length - 1] = { role: "user", content: words };
  let handoff = screened ? { ask: calltrust.SCREENED_REQUEST, why: "passphrase" } : null;
  const said = [];
  if (!handoff) {
    const s = session ?? await openBrain(call, { log });
    if (!s) handoff = { ask: words, why: "no_brain" };
    else {
      const kind = opening.classify(words);
      const careful = needsFullBrain(words) || asksIfDone(words);
      const ctlA = new AbortController(), ctlB = new AbortController();
      const turnA = speak({ system: s.system, messages, theirWords: words, stream: stream ?? anthropicStream({ signal: ctlA.signal }), log, callId: call.id });
      let events = turnA;
      if (openers && !careful) {
        const opener = opening.pickOpener(kind, recent);
        const turnB = speak({ system: s.system, messages, theirWords: words, stream: streamB ?? anthropicStream({ signal: ctlB.signal }), log, callId: call.id, opener });
        events = withOpenerRace({ speakA: turnA, speakB: turnB, opener, atMs: openerAtMs, stopA: () => ctlA.abort(), stopB: () => ctlB.abort(), timers, now });
      }
      for await (const ev of events) {
        if (ev.type === "say") { said.push(ev.text); yield { type: "say", text: ev.text, from: "speak", ...(ev.opener ? { opener: true, kind } : {}) }; }
        if (ev.type === "handoff") handoff = { ask: ev.ask || words, why: ev.why };
      }
      // A careful turn (money, logins, "is it done?") opens with a stand-alone line before the music.
      if (openers && careful && handoff) { const line = opening.pickStandalone(recent); said.push(line); yield { type: "say", text: line, from: "speak", opener: true, kind: "careful" }; }
    }
  }
  if (handoff && full) {
    yield { type: "hold" };
    const ask = String(handoff.ask ?? "").trim();
    const asked = [...messages, ...(said.length ? [{ role: "assistant", content: said.join(" ") }] : [])];
    if (ask && !(asked.at(-1)?.role === "user" && asked.at(-1).content.includes(ask))) asked.push({ role: "user", content: `(${ask})` });
    const deferredBefore = deferredOf(call);
    const armedBefore = calltrust.listening(call);
    let reply;
    try { reply = await full(asked); } catch (e) { reply = { text: "", error: (e?.message ?? String(e)).split("\n")[0] }; }
    if (!reply?.error && calltrust.listening(call) === "pass" && armedBefore !== "pass" && !String(reply?.text ?? "").includes(calltrust.LINES.ask)) reply = { ...(reply ?? {}), text: calltrust.LINES.ask, skip: false };
    const deferredAfter = deferredOf(call);
    if (!reply?.error && deferredAfter && deferredAfter !== deferredBefore) reply = withDeferredLine(reply).reply;
    const text = forVoice(reply?.text);
    if (reply?.error && !text) yield { type: "say", text: "Sorry, I couldn't get that just now. Want me to try again?", from: "full" };
    else if (text && !reply?.skip) yield { type: "say", text, from: "full" };
    if (reply?.endCall) yield { type: "end_call" };
  }
  log({ brain_turn: call.id, handoff: handoff?.why ?? null, spoke: said.length, ms: now() - t0 });
  yield { type: "done", handoff: handoff?.why ?? null, ms: now() - t0 };
}

/** The shared secret the ears-and-mouth side presents (REASON_CALL_BRAIN_SECRET), compared in constant time. */
function secretOk(given, want = String(process.env.REASON_CALL_BRAIN_SECRET ?? "")) {
  const a = Buffer.from(String(given ?? "")), b = Buffer.from(want);
  return want.length >= 24 && a.length === b.length && timingSafeEqual(a, b);
}

export const BRAIN_PATH = "/calls/brain/turn";

/**
 * POST BRAIN_PATH: one turn for the voice side (a self-hosted Line agent, docs/calls-brain-first.md).
 * Body: { token: the call row's webhook_token, history: [{ role, content }] }. Answers newline-delimited
 * JSON events from `brainTurn`. 404 with the switch off (as if the path did not exist); 401 without the
 * secret; 403 for any call that is not a person's own call at the switch's level.
 */
export async function brainTurnRequest({ rawBody, headers = {}, full = null, log = () => {} }) {
  if (config.callBrain === "off") return { status: 404, body: "not found" };
  if (!secretOk(headers["x-reason-brain"])) return { status: 401, body: "unauthorized" };
  let body;
  try { body = JSON.parse(String(rawBody ?? "")); } catch { return { status: 400, body: "bad json" }; }
  const row = db.callByWebhookToken(body?.token);
  if (!row || !brainFirstFor(row)) return { status: 403, body: "not this call" };
  const history = Array.isArray(body.history) ? body.history.slice(-40) : [];
  const runFull = full ?? (async (messages) => (await import("./gptlive.js")).reasonTurn({ call: row, messages, log }));
  async function* lines() {
    for await (const ev of brainTurn({ call: row, history, full: runFull, log })) yield JSON.stringify(ev) + "\n";
  }
  return { status: 200, headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" }, stream: lines() };
}
