// REASON_CALL_FEEL=classic: every account's own Cartesia call (`is_owner` is "their own call", whichever
// account) as the owner's was on call 112 (2026-11-13 16:38 UTC), the call he said was perfect. The rule
// words are the same for everyone; every personal slot (name, greeting, keyterms, brief, notes) is the caller's. That call ran on main 752a9e72 (#543, lookup music on) with the agent at
// version av_f1C22VxgaAQd8zn2MFk8RS. Everything the voice is handed comes out as that build gave it:
//   - `reason_call`: the build's own rule words (./callclassic-words.js), in its order, with the pre-call brief
//     in its order, cut at the end as it was then (12,000 less this line's manner lines), then those lines;
//   - the greeting (./inbound.js `openingLineFor` and ./carryover.js `greetingFor`, `classic`), and the
//     keyterms (today's names, else "Reason": no time words).
// After that text, and only there, the short keep-list (docs/calls-cartesia.md, "Classic"): the earlier-calls
// notes and what was texted since (no links), one line on answering memory questions from them, and the
// passphrase line when call trust is on. The quiet-turn line and the done-claim check are in ./cartesia.js.
// The agent's own saved settings are put back by scripts/cartesia-agent-classic.mjs.
import { config, clock } from "../config.js";
import * as accounts from "../accounts.js";
import * as carryover from "./carryover.js";
import * as calltrust from "./calltrust.js";
import { recentChatLines, briefSections } from "./gptlive.js";
import { ownerProfileNote } from "./voice.js";
import { rulesNote } from "../rules.js";
import { whereaboutsNote } from "./callmemory.js";
import { todaySoFar } from "./brief.js";
import { NO_NAME, callIdentityFor } from "./voice-prompt.js";
import { makerLine } from "../maker.js";
import { section, fitSections } from "./fitprompt.js";
import * as W from "./callclassic-words.js";

export const REF_COMMIT = "752a9e72";
export const REF_AGENT_VERSION = "av_f1C22VxgaAQd8zn2MFk8RS";

/** REASON_CALL_FEEL read: "classic" or "current" (the default). */
export const classicOn = () => config.callFeel === "classic";
/** A call that gets the classic feel: any account's own call, with the switch at classic (Cartesia calls only use it). */
export const classicFor = (call) => classicOn() && Number(call?.is_owner) === 1;

/**
 * The cap for `reason_call` in classic mode: the call-112 text (at most 12,000) and the keep-list after it.
 * REASON_CARTESIA_VARIABLE_MAX, when set, wins (as in current mode).
 */
export const CLASSIC_MAX = (n => (Number.isInteger(n) && n >= 4000 && n <= 60_000 ? n : 16_500))(Number(process.env.REASON_CARTESIA_VARIABLE_MAX));

/** Kept in classic mode (call 115): a memory question is answered from the notes, or by asking Reason. */
export const MEMORY_LINE = "Earlier calls: when they ask about an earlier call or what has happened since, answer from the EARLIER CALLS and SINCE YOUR LAST CALL notes here, or call ask_reason; never say you have no memory of earlier calls or only know this call.";

/** On an error turn, the words that build gave (before #555). */
export const ERROR_LINE = "Reason could not answer that just now. Say so briefly and offer to try again.";

// The call-112 build's own inline lines (src/calls/gptlive.js `liveInstructions` at 752a9e72, owner branch).
const NOT_WHO = "Where they are, or any other question, goes to Reason; if you're not sure whether they said who or where, ask.";
const VOICE_LINE = "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.";
const WAIT_LINE = "While the backend works, do not fill the silence with guesses.";
const SMALL_TALK = "Small talk is yours: if they ask how you are, answer warmly and ask them back.";
const GOODBYE = "When you both say goodbye, sign off warmly and briefly.";
const TAIL = [
  "Never say anything is done, booked, sent, texted, ordered, paid, scheduled, cancelled or confirmed unless the backend's result says so. If the result says it is not done, only started, or needs their approval, say exactly that.",
  "When a backend result arrives, say it naturally and briefly, keeping every fact, number and name exactly as given. Do not add offers or questions the result did not include.",
  "Never read out links, codes, IDs or anything in square brackets, and never say the words NO_REPLY.",
  "Stop speaking when they talk over you, and listen.",
];
const BRIEF_HEAD = "PRE-CALL BRIEF — what you know going in, about them and from your chats. Answer from it yourself where it does; any lookup, action or live fact still goes to Reason.";

const clipBrief = (t, n) => {
  const x = String(t ?? "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x;
};
const clipEnd = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The pre-call brief in the call-112 build's order (`preCallBrief` at 752a9e72), from today's readers. */
export function classicBrief(call) {
  if (Number(call?.is_owner) !== 1) return "";
  const lines = [];
  const nowIs = carryover.nowLine(call);
  if (nowIs) lines.push(nowIs);
  if (call.direction !== "in") {
    const goal = clipBrief(call.goal, 300);
    if (goal) lines.push(`Why you rang them: ${goal}`);
    const facts = (Array.isArray(call.facts) ? call.facts : (() => { try { return JSON.parse(call.facts ?? "[]"); } catch { return []; } })())
      .map(f => clipBrief(f, 160)).filter(Boolean).slice(0, 5);
    if (facts.length) lines.push(`What you've got for it:\n${facts.map(f => `- ${f}`).join("\n")}`);
  }
  const chat = recentChatLines(call.conversation_id);
  if (chat.length) lines.push(`Lately in your chats:\n${chat.join("\n")}`);
  const today = todaySoFar(call.conversation_id, { until: Number(call.created_at) || clock.now(), call: call.id });
  const lately = carryover.recentMemoryNote(call);
  if (lately) lines.push(lately);
  if (today?.lines?.length) lines.push(`Today so far in your chats, before this call (newest last):\n${today.lines.join("\n")}`);
  if (today?.names?.length) lines.push(`Names from your chats today — on a bad line, a word that sounds odd is often one of these: ${today.names.join(", ")}`);
  const earlier = carryover.earlierCallsNote(call);
  if (earlier) lines.push(earlier);
  const comingUp = carryover.comingUpNote(call);
  if (comingUp) lines.push(comingUp);
  const profile = ownerProfileNote(call.conversation_id);
  if (profile) lines.push(profile.length > 2500 ? `${profile.slice(0, 2499).trimEnd()}…` : profile);
  const rules = rulesNote(call.conversation_id);
  if (rules) lines.push(rules);
  const area = carryover.areaNote(call);
  if (area) lines.push(area);
  const where = whereaboutsNote(call);
  if (where) lines.push(where);
  if (!lines.length) return "";
  return `${BRIEF_HEAD}\n${lines.join("\n")}`;
}

/**
 * The own-call voice words of the call-112 build (`liveInstructions` for their own call: the manner switch
 * off and no turn-gate lines, as on that call), with `brief` last.
 */
export function classicVoiceWords({ name = "them", named = name !== "them", identity = false, carry = false, brief = "" } = {}) {
  const them = named ? name : "them";
  const theirs = named ? `${name}'s` : "their";
  const bye = (l) => carry && l === GOODBYE ? W.CARRY_GOODBYE : l;
  const reword = (l) => !carry ? l : l === SMALL_TALK ? W.CARRY_SMALL_TALK : l === W.OWN_CALL_LINES[1] ? W.CARRY_NO_PROBING : l;
  const who = !identity ? [] : [named
    ? `Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant, and they're ${name}, the person you work for. ${NOT_WHO}`
    : `Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant; you don't have their name saved yet. ${NOT_WHO}`];
  return [
    `You are Reason, ${theirs} personal assistant — the same Reason they text with — on a phone call with ${them}. You are who they hear and talk with; Reason's backend has ${theirs} messages, calendar, memory, tasks and tools, and does every lookup and every action.`,
    ...who,
    makerLine(),
    VOICE_LINE,
    W.OWN_VOICE_PERSONA, ...W.OWN_VOICE_SPLIT,
    WAIT_LINE,
    ...W.OWN_CALL56_LINES.map(bye).map(reword),
    W.PIECES_LINE,
    ...W.HEARING_LINES,
    ...W.OWN_CALL_LINES.map(reword),
    ...(carry ? W.CARRY_VOICE_LINES : []),
    ...TAIL,
    ...(brief ? [brief] : []),
  ].join("\n");
}

/** That build's lines for the Cartesia line (`cartesiaCallLines` at 752a9e72). */
export function classicCallLines({ tags = config.cartesiaEmotionTags } = {}) {
  return [...W.MANNER_LINES, ...W.MOMENT_LINES, ...W.EXPRESSION_LINES, ...(tags ? [W.EMOTION_TAG_LINE] : [])].join("\n");
}

/** Call 112's `reason_call` exactly: the own-call words with the brief, cut at the end as then, then the line's manner. */
export function classicBase(call) {
  let me = null;
  try { me = accounts.ownerOf(call.conversation_id); } catch { /* unknown */ }
  const raw = me?.name || "";
  const named = !!raw && raw !== NO_NAME;
  const carry = carryover.carryoverFor(call.conversation_id);
  const words = classicVoiceWords({ name: named ? raw : "them", named, identity: callIdentityFor(call.conversation_id), carry, brief: classicBrief(call) });
  const lines = classicCallLines();
  return `${clipEnd(words, W.VARIABLE_MAX - lines.length - 1)}\n${lines}`;
}

/** The keep-list after the call-112 text, as ranked sections: the memory line, the notes (no links), the passphrase line. */
export function keptSections(call) {
  const notes = briefSections(call).filter(s => s.name === "earlier_calls" || s.name === "since_last_call");
  return [section("memory_line", 0, MEMORY_LINE), ...notes, section("passphrase", 0, calltrust.voiceLines(call))].filter(s => s.lines.length);
}

/**
 * `reason_call` in classic mode, with its fit: `{ text, size, base, max, kept, trimmed, dropped }`. The call-112
 * text is never touched; only the notes after it are fitted, inside CLASSIC_MAX (`max`).
 */
export function classicReasonCall(call, { max = CLASSIC_MAX } = {}) {
  const base = classicBase(call);
  const fit = fitSections(keptSections(call), Math.max(0, max - base.length - 1));
  const text = fit.text ? `${base}\n${fit.text}` : base;
  return { text, size: text.length, base: base.length, max, kept: [`classic_base:${base.length}`, ...fit.kept], trimmed: fit.trimmed, dropped: fit.dropped };
}

/** Call 112's keyterms: today's names, every slot left over "Reason" (no time words). */
export function classicKeyterms(names, slots) {
  return Object.fromEntries(Array.from({ length: slots }, (_, i) => [`keyterm_${i + 1}`, names[i] ?? "Reason"]));
}
