// The turn gate (REASON_CALL_TURN_GATE = off | owner | on, default off): on their own call, Reason
// listens the way a person does (Omari 11-12). When they pause in the MIDDLE of a thought, a small
// sign of presence is welcome — "mm-hm", "go on", "I'm with you", "yeah" — in the pause, short and
// soft, never on top of their words, never the same one twice running, and only now and then. When
// they have FINISHED the thought, Reason answers promptly with a real reply, never with "go on".
// Which of the two a silence is, is the one thing the audio cannot say; that is the question asked.
//
// How: GPT-Live's native Decisions integration. A session trigger on their side's transcript
// (`session.triggers`, event_type `session.input_transcript.delta`) has Live itself ask Decisions one
// predicate, "has the speaker finished their thought?" — and, on a business call, "are they asking
// whether this is a person or a machine, or who is calling?". The answers come back on the session
// socket as `decision.event`. This file is the questions, the words and the bookkeeping (which words a
// verdict is about, whether it is still current); src/calls/gptlive.js acts on it in the audio path.
//
// Docs read 2026-11-12: developers.openai.com/api/docs/guides/decisions and decisions-voice ("React
// to transcripts"). From them: Live supplies the model and the trigger id; a result names the delta
// that prompted it (`source_event_id`); Live can combine pending deltas and results can arrive out of
// order, so only the newest counts; a refusal is an answer type. Measured the same morning on synthetic
// lines (/tmp/decisions-spike): finished? 39/40, robot/who? 20/20, one request with both ~0.2 s
// (p50 209 ms, p95 432 ms, max 582 ms over 120 requests).
//
// Privacy: the trigger is configured in session.start and carries only the question text below — no
// words from any call. The transcript it is asked about is the one Live already makes from the call's
// audio, and Live hands it to Decisions itself ("Live calls Decisions directly"); nothing new leaves
// this server, and nothing is sent to anyone but the provider the call's audio already goes to.
import { config } from "../config.js";
import * as accounts from "../accounts.js";
import { askedLine } from "./manner.js";

/**
 * How long the voice's first audio may wait for a verdict that is not in yet. From the measured
 * latency: p95 432 ms, max 582 ms. Past it the audio goes out exactly as it would have (fail open).
 */
export const TURN_GATE_BUDGET_MS = 500;
/** `finished` at or above this probability is a finished thought. */
export const FINISHED_AT = 0.5;
/**
 * Their sound may run this far past the end of the transcript piece that carried their last words (a
 * word's tail, a breath; the pieces' own timing is approximate, per the docs).
 */
export const COVER_SLACK_MS = 300;
/**
 * "Not finished" only stands once no newer piece of their transcript has followed for this long: the
 * transcript arrives in pieces, and a piece that ends mid-sentence is mid-sentence only until the next.
 */
export const UNFINISHED_SETTLE_MS = 300;
/** This much silence from them, thought finished or not, and whatever the voice says is welcome: the gate steps aside. */
export const TURN_GATE_QUIET_MS = 3000;

// ---------- the acknowledgement ----------
/** A real pause, not a breath: an acknowledgement only plays once they have been quiet this long. */
export const ACK_PAUSE_MS = 650;
/** More speech than this is not an acknowledgement: it is a reply, and a reply to half a thought is not played. */
export const ACK_MAX_SPEECH_MS = 1200;
/** A run of the voice's has ended: this much quiet in its audio, or no audio at all for ACK_WAIT_MS. */
export const ACK_END_QUIET_MS = 200;
export const ACK_WAIT_MS = 300;
/** Now and then, like a listener: none until they have talked this long since Reason last spoke… */
export const ACK_FIRST_TALK_MS = 2000;
/** …and at most one per this much of their talking (so never two without them speaking in between). */
export const ACK_EVERY_TALK_MS = 8000;
/** The voice gave none of its own this far into the pause: it is asked for one — unless the pause is already this old. */
export const ACK_PROMPT_AFTER_MS = 700;
export const ACK_PROMPT_BEFORE_MS = 2200;
/** What it is asked to say when code asks: one of these, never the one before. */
export const ACK_WORDS = Object.freeze(["Mm-hm.", "Yeah.", "Go on.", "I'm with you.", "Right.", "Mm."]);
/** A reply that is only a "carry on" (said to a finished thought, it is not an answer). */
export const CONTINUER = /^[\s.,!…-]*(?:(?:go on|keep going|carry on|i'?m with you|i'?m listening|i hear you|mm+-?hm+|mhm+|uh-?huh|mm+)[\s.,!…-]*)+$/i;

const plain = (s) => String(s ?? "").toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
/** The same acknowledgement as the last one played? (Unknown words are not the same as anything.) */
export const sameAck = (a, b) => !!plain(a) && plain(a) === plain(b);
/** Short and no question: a sign of presence, not a turn. Words not in yet (the transcript trails) pass on length alone. */
export function looksLikeAck(words) {
  const w = String(words ?? "").trim();
  return !w || (!w.includes("?") && plain(w).split(" ").length <= 3);
}
/** The next word code asks for: in order, skipping the one last played. */
export function nextAckWord(n, last = "") {
  for (let i = 0; i < ACK_WORDS.length; i++) { const w = ACK_WORDS[(n + i) % ACK_WORDS.length]; if (!sameAck(w, last)) return w; }
  return ACK_WORDS[0];
}
/** One honest answer per question: a second ask this soon is the same question still arriving. */
export const ASKED_AGAIN_MS = 6000;

export const INPUT_DELTA = "session.input_transcript.delta";

export const FINISHED_Q = "Look only at the last thing the person on the phone said, as transcribed so far (a live transcript: often no punctuation)."
  + " Has the speaker finished their thought, so the assistant should answer now? True for a complete question, request, statement or one-word answer."
  + " False when they trail off, stop on a filler or a conjunction (um, and, but, so, because, or), say they are thinking, checking or to hold on,"
  + " or are plainly partway through a sentence, a number or a list.";
export const ASKS_Q = "This is a phone call an AI assistant is making to a business or another person. In the other person's LAST words, what are they asking about the caller?";
export const ASKS_CHOICES = Object.freeze([
  { value: "asks_ai", description: "They ask whether the caller is an AI, a robot, a bot, a machine, a recording or a real person (alone or together with asking who it is)." },
  { value: "asks_who", description: "They ask who is calling, the caller's name, or where the call is from, without asking whether it is a machine." },
  { value: "neither", description: "Anything else, including questions about the booking, the name the booking is under, or a mention of robots or automation that is not about the caller." },
]);

/**
 * Told to the session when a full reply into a mid-thought pause is held back (session.instructions.append:
 * it can stop speech in progress). With a word: say that, softly, and keep listening. Without (one was
 * given a moment ago): say nothing.
 */
export function heldNote(word = "") {
  const head = "They paused in the middle of a thought and have not finished. They did not hear what you just started to say. Don't answer yet.";
  return word
    ? `${head} Right now say only "${word}" — softly, nothing more, no question — and keep listening until they finish. Then answer all of it.`
    : `${head} Say nothing and keep listening until they finish the thought. Then answer all of it.`;
}
/** They paused mid-thought and the voice gave no sign of listening: asked for one. */
export const ackPromptNote = (word) => `They have paused in the middle of a thought. Right now say only "${word}" — softly, nothing more, no question — and keep listening. They have not finished.`;
/** They went quiet without finishing: now a few words are welcome. */
export const TURN_GATE_QUIET_NUDGE = "They have gone quiet without finishing their thought. A few words are welcome now: if what they said is enough to answer, answer it briefly; otherwise invite them to go on, lightly.";
/** A "go on" said to a finished thought. */
export const ANSWER_NUDGE = "They had finished their thought and are waiting for your answer; \"go on\" is not one. Answer what they said now, properly and briefly. If what they said was \"what did you say?\" or \"what's that?\", say your last real sentence or question again.";

/**
 * The voice's instructions on their own call when the gate is on for it. They stand in for the line
 * that forbade every listening sound (./carryover.js, call 85: eight of them over one long thought,
 * on top of his words) — the sounds were never the problem, their timing and number were, and code
 * now keeps both: one that would land on their words, or too soon after the last, is never heard.
 */
export function ackVoiceLines({ repeatRule = true } = {}) {
  return [
    "Listen the way a good friend does on the phone. When they pause in the middle of a thought — trailing off on \"um\", \"so\", \"and\" or \"like\", or thinking out loud — a small sign that you're there is welcome, now and then:"
      + " one or two soft words in the pause, like \"mm-hm\", \"yeah\", \"go on\", \"right\", \"I'm with you\". Vary it: never the same one twice running, and not at every pause."
      + " It is never your turn: no content, no question, no \"sorry\", and stop at once if they carry on. This is the one exception to never speaking filler.",
    "When they have finished the thought — a question to you, \"you know?\", \"does that make sense?\" or a clear stop — answer the whole of it, promptly and properly. \"Go on\" is never an answer to a finished thought.",
    ...(repeatRule ? ["If they say \"what's that?\", \"what did you say?\" or \"sorry?\", they did not catch you: say your last real sentence or question again. Never answer that with \"go on\"."] : []),
  ];
}

/** REASON_CALL_TURN_GATE read: "on", "owner" or "off". */
export function turnGateSwitch(v = config.callTurnGate) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(s) ? "on" : "off";
}

/**
 * The gate for one call: "own" (their own call with Reason: acknowledgements placed, replies to half a thought held), "line" (a business
 * call Reason placed and talks on: the robot/who question is acted on, the finished verdict only
 * logged), or "" (off). "owner" is the operator's conversation only, like the repo's other =owner flags.
 */
export function turnGateFor(call) {
  const v = turnGateSwitch();
  if (v === "off" || !call?.conversation_id) return "";
  if (v === "owner") {
    try { if (accounts.ownerOf(call.conversation_id)?.isOperator !== true) return ""; } catch { return ""; }
  }
  if (Number(call.is_owner) === 1) return "own";
  return config.lineTalk && call.direction !== "in" ? "line" : "";
}

/** The `session.triggers` entry for a call's gate (none when it is off). */
export function turnTriggers(mode) {
  if (mode !== "own" && mode !== "line") return [];
  const questions = [{ type: "predicate", name: "finished", instructions: FINISHED_Q }];
  if (mode === "line") questions.push({ type: "choice", name: "asks", instructions: ASKS_Q, choices: ASKS_CHOICES.map(c => ({ ...c })) });
  return [{ type: "decisions", event_type: INPUT_DELTA, decisions: { questions } }];
}

/**
 * What the voice is told when a business asks if it is a machine, or who is calling: the truth, first.
 * The words are the ones its instructions already carry for the question, the same string
 * (`askedLine`, ./manner.js: "I'm an AI assistant calling for <first name>" and its nevers) — nothing
 * else is put in its mouth; this only makes sure they are said now, not a turn later.
 */
export function honestAnswerNote(asks, first = "") {
  // As `lineTalkInstructions` names them (./gptlive.js).
  const who = String(first ?? "").trim().split(/\s+/)[0] || "the person you work for";
  const asked = asks === "asks_ai" ? "They just asked whether they are talking to a person or a machine." : "They just asked who is calling.";
  return `${asked} Unless you have already said it in this reply, answer that first, right now. ${askedLine(who)}`;
}

/**
 * The bookkeeping, with no I/O and no clock of its own: every method is given the time.
 *   heard(id, t, endMs)  a piece of their transcript arrived (the trigger's source event); `endMs` is
 *                   where it ends on the session's own timeline (the delta's `end_ms`)
 *   decided(e, t)   a `decision.event` arrived; returns the verdict it carried, or null when it is not
 *                   ours, not final, or older than one already applied
 *   read(t, { speechAt, speechMs })  what the gate says about a reply starting now, given when their
 *                   last sound was (by the clock, and on the session's timeline):
 *       finished    their latest words are a whole thought: the reply goes out, no delay
 *       unfinished  they are mid-thought: an acknowledgement at most, never a reply (`heldOnce`
 *                   when a reply to these same words has already been held back)
 *       wait        no verdict on their latest words yet (transcript or decision still coming, or a
 *                   "not finished" too fresh to stand: the next piece may finish the sentence)
 *       open        nothing to go on (the decision failed or refused, or the transcript carries
 *                   no timing): behave as if there were no gate
 * A verdict only counts when the piece it is about reaches their last sound on the session timeline:
 * pieces arrive late and unevenly, and "not finished" about the first half of a sentence says nothing
 * about the whole of it. (By arrival time alone, the replay held every second good reply.)
 */
export class TurnGate {
  constructor({ mode = "own", threshold = FINISHED_AT, budgetMs = TURN_GATE_BUDGET_MS } = {}) {
    this.mode = mode;
    this.threshold = threshold;
    this.budgetMs = budgetMs;
    this.seq = 0;
    this.ids = new Map();
    this.last = null;
    this.verdict = null;
    this.droppedSeq = -1;
    this.unmatched = 0;
  }

  heard(id, t, endMs = null) {
    this.last = { seq: ++this.seq, at: t, endMs: Number.isFinite(endMs) ? Math.max(endMs, this.last?.endMs ?? 0) : null };
    if (id != null && id !== "") {
      this.ids.set(String(id), this.last);
      if (this.ids.size > 200) this.ids.delete(this.ids.keys().next().value);
    }
    return this.last;
  }

  decided(e, t) {
    if (!e || e.type !== "decision.event" || !this.last) return null;
    if (e.source_event_type && e.source_event_type !== INPUT_DELTA) return null;
    // A delegation's decision is not a trigger's.
    if (e.delegation_id) return null;
    const inner = e.event ?? {};
    const failed = !!inner.error || /fail|error|cancel/i.test(String(inner.type ?? ""));
    if (inner.type !== "decision.completed" && !failed) return null;
    // Live can combine pending deltas: a result whose source we never saw is taken as the newest words'.
    const src = this.ids.get(String(e.source_event_id ?? ""));
    const matched = !!src;
    if (!matched) this.unmatched++;
    const about = src ?? this.last;
    // Results can arrive out of order: only the newest words' verdict counts.
    if (this.verdict && about.seq < this.verdict.seq) return null;
    const answers = Array.isArray(inner.decision?.answers) ? inner.decision.answers : [];
    const fin = answers.find(a => a?.name === "finished");
    const asks = answers.find(a => a?.name === "asks");
    const p = fin?.type === "predicate" && Number.isFinite(fin.probability) ? fin.probability : null;
    this.verdict = {
      seq: about.seq, heardAt: about.at, at: t, latencyMs: t - about.at, matched,
      // No usable answer (failed, refused, missing): nothing to go on for these words.
      error: failed || p == null,
      p, finished: p == null ? null : p >= this.threshold,
      asks: asks?.type === "choice" && ASKS_CHOICES.some(c => c.value === asks.choice) ? asks.choice : null,
    };
    return this.verdict;
  }

  /** A reply to these words was held back once; a second one is not (`heldOnce`). */
  dropped(seq) { this.droppedSeq = seq; }

  read(t, { speechAt = -Infinity, speechMs = null } = {}) {
    const last = this.last;
    const v = this.verdict;
    // Nothing of theirs transcribed yet: it trails their voice (0.5–1.5 s, 2.7 s seen).
    if (!last) return { state: "wait", why: "no transcript" };
    const base = { seq: last.seq, transcriptMs: Number.isFinite(speechAt) ? Math.round(last.at - speechAt) : null };
    // No timing on the pieces, or none for their sound: nothing says which words a verdict covers.
    if (last.endMs == null || !Number.isFinite(speechMs)) return { ...base, state: "open", why: "no timeline" };
    if (last.endMs < speechMs - COVER_SLACK_MS) return { ...base, state: "wait", why: "no transcript" };
    if (!v || v.seq < last.seq) return { ...base, state: "wait", why: "no decision" };
    const got = { ...base, decisionMs: Math.round(v.latencyMs), leadMs: Math.round(t - v.at), p: v.p, matched: v.matched };
    if (v.error) return { ...got, state: "open", why: "error" };
    if (v.finished) return { ...got, state: "finished" };
    if (t - last.at < UNFINISHED_SETTLE_MS) return { ...got, state: "wait", why: "settling" };
    return { ...got, state: "unfinished", heldOnce: v.seq === this.droppedSeq };
  }
}
