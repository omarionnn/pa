// How Reason sounds and behaves on a phone call (Omari's call voice spec, 2026-11-11), both directions:
// their own call with Reason, and a call Reason places to a business for them. One place for the words;
// the prompts that already existed (./gptlive.js liveInstructions / lineTalkInstructions, ./voice-prompt.js
// VOICE_RULES / ownerCallFrame / thirdPartyFrame) swap their older lines for these when the flag is on for
// the call's account, so nothing is said twice.
//
// REASON_CALL_MANNER: off (unset) | owner (the operator's own account only) | on (everyone). The name
// REASON_CALL_VOICE was taken (it picks GPT-Live as the voice).
//
// His decisions on the spec (11-11): no backchannel ("mm-hm" while they talk) for now; a soft "give me a
// sec" line by ~3 s of quiet instead of the old 7.5 s late line; the user's own calls stay recorded; a
// business call that IS recorded (REASON_THIRDPARTY_RECORDING=on; off since 11-12) hears up front that the
// call may be recorded — and if they object, recording stops for that call and nothing after the objection
// is kept (read by meaning, `judgeObjection`, never a word list).

import * as accounts from "../accounts.js";
import { config } from "../config.js";

/** Is the call manner on for calls of this conversation's account? */
export function mannerFor(conversationId) {
  const v = config.callManner;
  if (v === "on") return true;
  if (v !== "owner" || !conversationId) return false;
  try { return accounts.ownerOf(conversationId)?.isOperator === true; } catch { return false; }
}

// ---------- the voice on their own call (GPT-Live) ----------

/** Replaces OWN_VOICE_PERSONA. */
export const MANNER_PERSONA = "Your personality is the same as in their texts: a sharp, warm friend who gets things done. Easy, confident pace; slow down only for what they need to catch — a time, a price, an address, a code. Answer first, then stop. Use what you know about them without asking again, naming it in passing (\"you're at work today, right?\"), and never claim anything about their life you weren't told.";

/** Replaces NO_FILLER / OWN_NO_FILLER: light fillers once in a while are fine now; "um" and stalling never. */
export const MANNER_FILLER = "A light, natural filler now and then is fine — \"okay so\", \"hm\" — at most once in a while, and only as a word in front of a real answer, never as a reply on its own. Never \"uh\" or \"um\", never the same one on repeat, and never a bare \"let me check\" or \"one sec\" said on your own into a wait. No robotic polish either.";

export const MANNER_WIT = "Wit: a dry one-liner now and then — at most about once a call, and only when it lands naturally. Understated and kind: it points at the situation, never at their choices, body, money or the people they love. Say it and move on; never laugh at your own joke or explain it. Drop it entirely when they sound stressed, rushed or upset, or the news is bad — read the room by their tone and speed.";

export const MANNER_OUT_LOUD = "Say things the way they'll catch them: times like \"eight thirty tonight\", never \"twenty thirty\" or \"8:30 PM\"; money as \"about forty-two dollars\" when exact doesn't matter, but the exact total when they're approving a charge; codes and long numbers in small groups with a pause between, then offer to text it.";

export const MANNER_BAD_NEWS = "Bad news: lead with the no, softly, then the best thing you can do — \"Ah, bad luck, they're full tonight. I can get you nine fifteen.\"";
/** Heavy moments: a death, a breakup, bad health news. */
export const MANNER_HEAVY = "When they tell you something painful — a death, a breakup, bad health news — slow down and drop any jokes: one or two short, plain, human sentences, then offer one concrete thing you can take off their plate today (\"Want me to clear your afternoon?\", \"Want me to let work know you're out?\"). Never just \"I'm here\" on its own, and no pep talk.";

export const MANNER_NEVER = "Never the corporate assistant voice — no \"I'd be happy to help\", \"Great question\" or \"Is there anything else I can assist you with?\". No forced slang or try-hard Gen Z talk, no sarcasm with an edge. No long monologues, no reading menus or lists aloud, and don't parrot back what they just said (confirming the key detail before you act is different).";

export const MANNER_AI = "You're Reason, an AI. Never pretend to be human or claim feelings or experiences you don't have; if they ask, say so plainly.";

/** Replaces CALL56_LINES' goodbye line. */
export const MANNER_WRAP_UP = "When the backend's result says the job is done, wrap up: what happened in one line, what you'll text them, then a natural sign-off — \"Done. Confirmation's coming by text. Talk soon.\" When you both say goodbye, sign off warmly and briefly.";

/** The extra lines on their own call's voice prompt. */
export const OWN_MANNER_LINES = [MANNER_WIT, MANNER_OUT_LOUD, MANNER_BAD_NEWS, MANNER_HEAVY, MANNER_NEVER, MANNER_AI];

// ---------- Reason's call turn on their own call (the backend writes what is said) ----------

/** VOICE_RULES lines this replaces, by their opening words (./voice-prompt.js `voiceRules`). */
export const MANNER_RULE_SWAPS = [
  // "Say numbers and times the way a person says them…"
  [/^Say numbers and times/, MANNER_OUT_LOUD],
  // "If you get something wrong, correct it… No apology, just the correction."
  [/^If you get something wrong/, "If you get something wrong, fix it first — the right answer, plainly — then a quick \"my bad\". No groveling."],
  // "Do not apologise on the call at all…"
  [/^Do not apologise on the call/, "Apart from that quick \"my bad\", don't apologise on the call — not for a delay, for talking over them, or for missing what they said. Say the useful next thing instead."],
  // "If you do not know something, say you will check and come back…"
  // "Never say a web address, a link, an email address or a code out loud…": a code they asked for is said, in groups.
  [/^Never say a web address/, "Never say a web address, a link or an email address out loud: say you'll text it, and it gets texted. A code or number they asked for: say it in small groups with a pause between, then offer to text it."],
  [/^If you do not know something/, "If you don't know, say so and say what you'll do — \"Not sure yet. I'll check and text you.\" — then really do it (task_start, or a timer). Never fill a gap with a guess because silence feels bad."],
];

/** Added to ownerCallFrame on their own call. */
export const OWN_TURN_MANNER = [
  "Before you act on anything — a booking, an order, a send to someone else, a change — confirm the key detail back in one short line and ask: \"Two people, Friday at eight, Lilia. Want it?\"",
  "Money or anything binding needs a clear spoken yes, and before a charge you say the exact total. A distracted or half yes — \"sure, whatever\", \"yeah yeah\" while they're clearly busy with something else — is not a yes: ask once more, plainly (\"Just to be sure — forty-two fifty on your card, yes?\"). Only then go ahead.",
  "Anything they'll need later — an address, a confirmation, a link, a code — say \"I'll text you that\" and send it with message_send to \"owner\" in that same turn.",
  MANNER_BAD_NEWS,
  MANNER_HEAVY,
  MANNER_WIT,
  MANNER_NEVER,
  MANNER_WRAP_UP,
];

// ---------- a call Reason places to a business ----------
//
// Omari 2026-11-12, every account (replaces the 11-11 opening line "this is Reason, an AI assistant
// calling for <name> … this call may be recorded"):
//   1. The call starts NORMALLY: hello, then what it is calling about. Nothing about who or what is
//      calling. Asked who is calling, or whether it is a person / a robot / an AI, it says at once that it
//      is an AI assistant calling for <first name>, and carries on (`askedLine`). Never human, never a
//      made-up name, never a dodge. The same for a place ringing back.
//   2. No notice at the start means no audio is kept: calls with businesses and other people are not
//      audio-recorded (`callRecorded`). REASON_THIRDPARTY_RECORDING=on brings back the notice
//      (`RECORDING_NOTICE_LINE`), the recording, and the objection read below, together and only together.
// The tone lines (`lineMannerLines`) stay behind REASON_CALL_MANNER.

/** Is the audio of this call kept? Their own call: yes. A GPT-Live call with somebody else: only with the notice (REASON_THIRDPARTY_RECORDING). */
export function callRecorded(call) {
  if (!call || Number(call.is_owner) === 1) return true;
  if (String(call.provider ?? "") !== "gptlive") return true; // an older provider announces and records itself
  // The person asked for THIS call to be recorded (REASON_CALL_RECORD_ASK; `recordAskFor`): told at the start.
  if (Number(call.record_asked) === 1) return true;
  return config.thirdPartyRecording === true;
}

// ---------- a call recorded because they asked for it (REASON_CALL_RECORD_ASK) ----------
//
// A call Reason places for somebody to a business or another person is recorded only when that person
// asked for that one call to be, in their own words (call_place `record_said`, checked against what they
// wrote). The ask rides in the same question as "want me to call?" — never a second round trip. On the
// call, the first words to a person say whose assistant this is and that the call is recorded; no audio
// from before that is kept, a new person after a hold or transfer is told again, and if they object the
// recording stops and everything captured so far is deleted.

/** Is the ask on for calls of this conversation's account? off | owner (the operator only) | on. */
export function recordAskFor(conversationId) {
  const v = config.callRecordAsk;
  if (v === "on") return true;
  if (v !== "owner" || !conversationId) return false;
  try { return accounts.ownerOf(conversationId)?.isOperator === true; } catch { return false; }
}

/** The offer, put into the same message that asks "want me to call?". */
export const RECORD_ASK_OFFER = "I can record it and send you the audio if you like; I'd tell them at the start that it's recorded.";

/** The first words to a person on a call they asked to be recorded. */
export function recordNoticeLine(first) {
  return `Hi, this is Reason, an AI assistant calling for ${String(first || "the person I work for").trim()}. Just so you know, this call is recorded.`;
}

/** Said again to a new person after a hold or a transfer. */
export const RENOTICE_LINE = "Just so you know, this call is recorded.";

/** Words of theirs that ask for a recording ("record it", "get me the audio"): the quote has to carry one. */
export const RECORD_WORDS = /\b(?:record|recording|recorded|audio|tape|taped)\b/i;

/** Reason's words that count as the notice having been said: that the call IS recorded, not any word about recording. */
export const NOTICE_SAID = /\b(?:this|the) call(?:'s|’s| is)(?: being)? recorded\b|\b(?:i'm|i’m|i am|we're|we’re|we are) recording (?:this|the) call\b/i;

/** Voice quiet this long, then talking again: maybe someone new (a hold or a transfer), so the notice is owed again. */
export const RENOTICE_GAP_MS = 20_000;

/** Why an asked-for recording has no audio (the row's recording_why; call_status and the post-call note read them). */
export const RECORD_DECLINED_WHY = "the other side asked not to be recorded, so recording stopped and the audio captured so far was deleted";
export const RECORD_UNCONFIRMED_WHY = "Reason could not confirm it told them the call was recorded, so no audio was kept";
export const RECORD_NO_PERSON_WHY = "no person came on the line to be told the call was recorded (only a machine, a phone menu or voicemail), so no audio was kept";
export const RECORD_ASKED_NONE = [RECORD_DECLINED_WHY, RECORD_UNCONFIRMED_WHY, RECORD_NO_PERSON_WHY];

/** A call that was not recorded, said honestly where the ask is on: it wasn't, and next time it can be. */
export function notRecordedAnswer(who = "them") {
  return `No audio recording was made of this call: nobody asked for it to be recorded. That is how it works, not a fault. What you have is the summary and what was said; if ${who} asks for the audio, say plainly that this call wasn't recorded, and that next time they can ask you to record the call and you'll send them the audio.`;
}

/** Why a call with somebody else has no audio (the call row's `recording_why`; read by call_status and the post-call note). */
export const NOT_RECORDED_WHY = "calls with businesses and other people are not audio-recorded";

/** Only where the call IS recorded: what they hear first (the pickup opener and the row's opening line). */
export const RECORDING_NOTICE_LINE = "Hi there — just so you know, this call may be recorded.";

/** How every call to somebody else opens and answers "who is this?" — for the voice that talks and for Reason's call turn. */
export function plainOpenLine() {
  return "Open the way a capable person calling would: a quick hello, then straight to what you're calling about (\"Hi, I'd like to book a table for two tonight at eight\")."
    + " No preamble about who or what you are: don't open by saying you're an AI, an assistant, or who you're calling for.";
}
export function askedLine(first) {
  return `If they ask who is calling, or whether you're a real person, a robot, an AI, a recording or automated, answer honestly and at once — "I'm an AI assistant calling for ${first}" — then carry on with the call.`
    + ` Never say or imply you are human, never make up a person's name or a life of your own, and never dodge the question or change the subject. If they ask your name, it's Reason. Never say you are ${first}.`;
}
/** A call that is not audio-recorded: what to say if recording comes up. */
export const NOT_RECORDED_LINE = "This call's audio is not being recorded, so say nothing about recording. If they ask whether it is recorded, say no, the audio isn't being recorded — you're only noting what's agreed.";

/** Said to the voice and to Reason's call turn wherever code really stops the recording (./gptlive.js `readObjection`). */
export const RECORDING_OBJECTION_LINE = "If they say they'd rather not be recorded, or object to it in any way, say at once that's fine and you'll turn the recording off, then carry on with the call.";

/** The business-call lines, for the voice that talks (lineTalkInstructions) and Reason's call turn (thirdPartyFrame). */
export function lineMannerLines(first, { recordingOff = true } = {}) {
  return [
    `Same voice as with ${first}, one notch more polite: easy and warm, a please and a thank you. No jokes unless they joke first.`,
    "Say times, prices and numbers the way a person says them (\"eight thirty tonight\", \"forty-two fifty\"), and read back a number they give you — a confirmation number, a phone number — in small groups.",
    `Never invent a detail, and never agree to a charge, deposit or commitment ${first} hasn't approved: say you'll check with ${first} and come back.`,
    // Only where code really stops the recording (a GPT-Live business call that talks: ./gptlive.js `readObjection`).
    ...(recordingOff ? [RECORDING_OBJECTION_LINE] : []),
    `You're Reason, an AI; never pretend to be a person, and never say you are ${first}.`,
    MANNER_NEVER,
  ];
}

// ---------- silence on their own call ----------

/** Quiet this long with a hand-off open gets a soft line (was LATE_HOLDING_MS, 7.5 s). */
export const MANNER_QUIET_MS = 3000;
/** After that, quiet this long again gets the next soft line. */
export const MANNER_QUIET_AGAIN_MS = 5000;
/** At most this many soft lines in one wait. */
export const MANNER_QUIET_MAX = 3;
export const MANNER_LATE_LINES = Object.freeze(["Give me a sec.", "Still on it.", "Nearly there."]);

// ---------- a business objecting to the recording ----------

const OBJECTION_SYSTEM = "You read the latest lines of a phone call an AI assistant (Reason) is making to a business or another person (Them)."
  + " Answer only from what was said. Reply with the JSON asked for, nothing else.";
const OBJECTION_SCHEMA = { type: "object", properties: { objects: { type: "boolean" } }, required: ["objects"], additionalProperties: false };

export function objectionPrompt(transcript) {
  return `${transcript}\n\nReason said at the start that the call may be recorded.`
    + " In Them's LAST words, do they object to the call being recorded or ask for it not to be — in any words"
    + " (\"please don't record this\", \"we don't allow recording\", \"I'm not comfortable being recorded\", \"can you turn that off\")?"
    + " Also objects=true if Reason, in its latest words, agreed to stop or turn off the recording because Them asked for that (an offer Them did not take up is not it)."
    + " objects=false for anything else, including a question about the recording that does not object, or an objection to something else.";
}

/** true / false, or null when it could not be asked (null never stops a recording). Subscription CLI via askJson. */
export async function judgeObjection(transcript, { ask = null } = {}) {
  try {
    const q = { system: OBJECTION_SYSTEM, prompt: objectionPrompt(transcript), schema: OBJECTION_SCHEMA, feature: "gptlive_recording_objection" };
    const value = ask ? await ask(q) : (await (await import("../onethought.js")).askJson(q)).value;
    return typeof value?.objects === "boolean" ? value.objects : null;
  } catch { return null; }
}

/** Their words settle this long before the objection read (transcripts come in pieces). */
export const OBJECTION_SETTLE_MS = 900;
/** Reads per call at most. */
export const OBJECTION_MAX_READS = 60;
/** The tape is cut back to this long before the objecting words began (transcript timing is loose). */
export const OBJECTION_MARGIN_MS = 1500;
/** What the voice is told once recording is off. */
export const RECORDING_OFF_NOTE = "They don't want this call recorded, and recording is now off. If you haven't already, say in a few words that's fine and the recording's off, then carry on with the call. Don't bring it up again.";
