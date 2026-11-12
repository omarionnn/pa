// The turn gate (REASON_CALL_TURN_GATE = off | owner | on, default off): does Reason's voice know when
// they have finished? (Omari 11-12: he pauses mid-thought, the voice takes the silence for its turn and
// says "Go on" / "I'm with you" / "mm-hm" on top of him; prompt wording did not stop it.)
//
// How: GPT-Live's native Decisions integration. A session trigger on their side's transcript
// (`session.triggers`, event_type `session.input_transcript.delta`) has Live itself ask Decisions one
// predicate, "has the speaker finished their thought?" — and, on a business call, "are they asking
// whether this is a person or a machine, or who is calling?". The answers come back on the session
// socket as `decision.event`. This file is the questions and the bookkeeping (which words a verdict is
// about, whether it is still current); src/calls/gptlive.js holds or drops the voice's audio with it.
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
/** After a held reply: this much silence from them and a few words are welcome after all. */
export const TURN_GATE_QUIET_MS = 3000;
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

/** Told to the session when a reply is held back (session.instructions.append: it can stop speech in progress). */
export const TURN_GATE_NOTE = "They paused in the middle of a thought and have not finished. They did not hear what you just started to say."
  + " Stop speaking and say nothing — no \"go on\", \"mm-hm\" or \"I'm with you\" — until they have finished the thought. Then answer all of it.";
/** They went quiet after the pause: now a small acknowledgement is welcome. */
export const TURN_GATE_QUIET_NUDGE = "They have gone quiet without finishing their thought. A few words are welcome now: if what they said is enough to answer, answer it briefly; otherwise invite them to go on, lightly.";

/** REASON_CALL_TURN_GATE read: "on", "owner" or "off". */
export function turnGateSwitch(v = config.callTurnGate) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "owner" ? "owner" : ["1", "true", "on", "yes", "everyone"].includes(s) ? "on" : "off";
}

/**
 * The gate for one call: "own" (their own call with Reason: replies are held), "line" (a business
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
 * The words are the ones its instructions already carry for the question ("I'm an AI assistant
 * calling for <first name>"); this makes sure they are said now, not a turn later.
 */
export function honestAnswerNote(asks, first = "") {
  const who = String(first ?? "").trim().split(/\s+/)[0];
  const line = `"I'm an AI assistant${who ? ` calling for ${who}` : ""}."`;
  const never = `Never say or imply you are human, never make up a person's name${who ? `, never say you are ${who}` : ""}, and never dodge the question.`;
  const asked = asks === "asks_ai" ? "They just asked whether they are talking to a person or a machine." : "They just asked who is calling.";
  return `${asked} Unless you have already said it in this reply, answer that first, right now, plainly: ${line} ${never} Then carry on with the call.`;
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
 *       unfinished  they are mid-thought: the reply is held back
 *       wait        no verdict on their latest words yet (transcript or decision still coming, or a
 *                   "not finished" too fresh to stand: the next piece may finish the sentence)
 *       open        nothing to go on (the decision failed or refused, the transcript carries no
 *                   timing, or these words were already held once): behave as if there were no gate
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

  /** These words' reply was held once; it is not held for the same words again. */
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
    if (v.seq === this.droppedSeq) return { ...got, state: "open", why: "held once" };
    if (t - last.at < UNFINISHED_SETTLE_MS) return { ...got, state: "wait", why: "settling" };
    return { ...got, state: "unfinished" };
  }
}
