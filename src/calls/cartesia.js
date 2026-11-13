// The Cartesia voice on a person's own calls with Reason (design 3, "bridged": docs/calls-cartesia.md
// section 5): the operator's alone with REASON_CALL_CARTESIA=owner, every account's with =on.
// Twilio's media stream stays ours; its audio goes to one Cartesia Managed Agent over their agent
// WebSocket (mulaw_8000 both ways, continuous input, paced output), and what the agent says comes back
// through the same room-tone mixer and call tape GPT-Live calls use. Reason's brain sits behind the
// agent's `ask_reason` client tool (`reasonTurn`, the same turn a GPT-Live hand-off runs). The call ends
// through the same settle as every GPT-Live call (`settleGptLive`), so the thread, carryover and the
// after-call text are unchanged; then Cartesia's copy of the call is deleted, and the delete is checked.
//
// Imported only inside acceptStream's one branch (./gptlive.js), for a call `cartesiaTrialFor` says yes
// to (./calltrial.js). If the agent is not ready within READY_MS, or fails before it is, the same call
// carries on with GPT-Live (`fallBack`) and that is logged.
import { writeSealed } from "../restfiles.js";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config, clock } from "../config.js";
import { recordingFileFor } from "./recordings.js";
import * as manner from "./manner.js";
import * as ambience from "./ambience.js";
import { lookupMusicFor, MUSIC_DELAY_MS } from "./lookupmusic.js";
import { CallTape, hasSpeech, voiceInstructionsFor, claimsDone } from "./gptlive.js";
import { queueMidCall } from "./voice.js";
import { openingLineFor } from "./inbound.js";
import { todaySoFar } from "./brief.js";
import { NO_NAME } from "./voice-prompt.js";
import * as calltrust from "./calltrust.js";
import * as zonescope from "../zonescope.js";
import { zoneFor } from "../zone.js";

export const API_BASE = "https://api.cartesia.ai";
export const VERSION = "2026-08-14";
/** How long the agent has, from the stream reaching us, to say `session_ready` before GPT-Live takes the call. */
export const READY_MS = 1500;
/** After a fall-back, how long a session still coming up has to say its call id, so it can be deleted. */
export const LATE_READY_MS = 5000;
/** What Cartesia charges for an agent minute (docs.cartesia.ai/pricing, read 2026-11-12); tokens are on top. */
export const CENTS_PER_MINUTE = 3;
/** The client tool Reason's brain sits behind (made by scripts/cartesia-agent-setup.mjs). */
export const ASK_REASON = "ask_reason";
/** A tool result may be 16 KiB (docs.cartesia.ai/agents/client-tools); Reason's words are cut well inside it. */
export const RESULT_MAX = 12_000;
/** Per-call keyterm slots on the agent (scripts/cartesia-agent-setup.mjs `KEYTERM_SLOTS`). */
export const KEYTERM_SLOTS = 8;
/** How long an ask_reason waits for the caller's passphrase answer to be screened (./calltrust.js). */
export const EAR_WAIT_MS = 1500;
/** A dynamic variable's text, kept inside a size their docs do not state (docs/unverified.md). */
export const VARIABLE_MAX = 12_000;

// ---------- how this call sounds (Cartesia calls only) ----------

// The GPT-Live own-call words in `reason_call` were written for a voice that hands nearly everything to
// Reason and stops ("Answer first, then stop", "don't add questions"). On this line that made every
// reply close the topic, and a person thinking out loud got a lookup. These lines are added after them
// on the Cartesia agent only, and win where they differ. No GPT-Live prompt changes.

/** Conversation manner: react, then the substance, and now and then one step further. */
export const MANNER_LINES = [
  "# How this call sounds (these win over any line above that differs)",
  "Talk like a friend on the phone, not an assistant taking questions. React first, the way a person does, with a few genuine words (\"Oh, nice.\", \"Ah, that's annoying.\", \"Ha, fair.\"), then the substance.",
  "After you answer, when there's a real opening (they shared a plan, a feeling, a worry or something unfinished, or invited your reaction), you may add ONE short follow-up question or a thought of your own that moves things on. About one reply in three at most, never two questions in a row: if your last reply ended in a question, this one doesn't.",
  "No follow-up after a lookup, a task, a goodbye, or when they sound busy or rushed: just the answer.",
  "Never repeat their sentence back to them. Keep replies short: no lists, and never \"is there anything else\".",
  "Like this (made-up examples):",
  "- They: \"Repainting the kitchen this weekend, finally.\" Closed: \"Nice, good luck with it.\" Better: \"Oh, finally! What colour are you going for?\"",
  "- They: \"Long day. Glad it's over.\" Closed: \"Glad it's over.\" Better: \"Ah, one of those. Go easy on yourself tonight.\"",
  "- They: \"I keep putting off ringing my landlord.\" Closed: \"Want me to set a reminder?\" Better: \"Ugh, I get it. Is it the call itself, or what you've got to say?\"",
  "- They: \"What's on tomorrow?\" Answer what Reason gives you, and stop.",
];

/** Stay in the moment: talk about them from what is already known; ask_reason is for data and actions. */
export const MOMENT_LINES = [
  "When they talk about themselves (how they feel, what they're thinking, what they want, something they've been putting off), answer from this conversation and what you already know from the brief and earlier calls above. That is a conversation, not a lookup: stay in it.",
  "Call ask_reason only for what needs their data or an action: their calendar, mail or messages, the weather, a booking, a reminder, or \"do this\". If they then ask you to do something about it, that is when it goes to ask_reason.",
];

/**
 * Done is Reason's word, never the agent's. Call 113 (2026-11-13): asked "Have you finished filling the
 * form?" and "and submitted?", the agent answered "Yeah, it's done." and "Yeah, submitted." on its own,
 * with no ask_reason behind either, about a Genius Bar booking nothing had made. These win over the
 * conversation lines above ("answer from this conversation") and over the agent's own pre-tool line.
 */
export const HONESTY_LINES = [
  "Only Reason's answer (ask_reason) in this call can tell you something has been done. Never say anything is done, booked, sent, submitted, filled in, scheduled, ordered or confirmed unless Reason's answer in this call said exactly that. This wins over every other line.",
  "If they ask whether something is done, booked, sent, submitted or finished, call ask_reason with that question; never answer it yourself, even if it was asked for earlier in this call.",
  "Before an action, your short line says you are asking Reason (\"Asking Reason to book that.\"), never that it is happening or done (\"Booking it.\", \"On it, done.\").",
  "If Reason's answer says it is not done yet, needs something from them, or will be picked up by text after the call, say exactly that. Never state a price, time, distance or opening hour that Reason's answers in this call did not give you.",
];

/**
 * Turn-taking, as words (call 113): it talked over him five times, said "Skipping for now." out loud,
 * asked "You still there?" four times (once right after "give me a second"), and two of Reason's answers
 * were lost when he spoke over them. When to speak is Cartesia's turn detection; these are the parts a
 * prompt can carry. The agent settings that go with them are `CALL_FEEL` in scripts/cartesia-agent-setup.mjs.
 */
export const TURN_LINES = [
  "If their words stop on a filler or mid-thought (\"um\", \"so\", \"and\", \"like\", \"because\", \"I said\"), they are not done: use skip_turn and wait. Never start talking over them.",
  "When they ask you to wait (\"give me a second\", \"hold on\", \"one sec\", \"wait\"), use skip_turn and say nothing until they speak again.",
  "When you skip a turn, say nothing at all: never say \"skipping\", never name a tool, never read out a marker or anything in brackets.",
  "Only ask if they're still there when the line has really gone quiet: never while Reason is looking something up, never after they asked you to wait, never right after you skipped a turn, at most once per silence and at most twice in a call.",
  "If they talk over you before you got to the point of Reason's answer, first answer what they just said, then give that point again in one short sentence. Never drop it.",
  "When Reason's answer reads a time, date or number back to check it (\"eight ten PM, right?\"), say it exactly that way and wait for their yes. Never read one back or confirm one yourself: Reason does that.",
];

/** Expression: Sonic reads the feeling from the words, so the words carry it. */
export const EXPRESSION_LINES = [
  "Your voice takes its feeling from your words, so write the way you'd say it: warm and easy on personal things, light on a joke, calmer and slower on something heavy (short sentences, a comma for a beat). Keep it subtle: no exclamation marks on ordinary lines, never gushing.",
  "Say temperatures and measures in the units Reason's answer uses (it picks them from their profile, as their texts do); never convert them, and don't tack the unit's name on the end unless it would be unclear.",
];

/** With REASON_CARTESIA_EMOTION_TAGS=on: Sonic's inline emotion tag (docs.cartesia.ai .../ssml-tags, beta). */
export const EMOTION_TAG_LINE = "You may start a reply with one tag that sets its feel: <emotion value=\"content\"/> for warm, <emotion value=\"happy\"/> for good news or a joke, <emotion value=\"calm\"/> for something heavy or serious, <emotion value=\"sympathetic\"/> for something hard. Most replies need none. Never more than one in a reply, never one at odds with the words.";

/** The lines added to `reason_call` on this line: no names, nothing about anyone. */
export function cartesiaCallLines({ tags = config.cartesiaEmotionTags } = {}) {
  return [...MANNER_LINES, ...MOMENT_LINES, ...HONESTY_LINES, ...TURN_LINES, ...EXPRESSION_LINES, ...(tags ? [EMOTION_TAG_LINE] : [])].join("\n");
}

// ---------- a slow ask_reason ----------

// The ask_reason call stays open until Reason answers, so the answer is what the agent speaks (the agent
// says its own short line before calling, and the lookup music covers the wait). Cartesia's client can send
// only a tool result back (docs.cartesia.ai/api-reference/agents/agent-websocket: session_create,
// audio_input, dtmf_input, client_tool_result), so a line said mid-wait would mean answering the call
// early, and the real answer would then have no way back onto the call: there is no holding line.
// The tool is waited for up to 60 s on their side (scripts/cartesia-agent-setup.mjs).

/** Not back by now (from the ask): the agent says it will text it, and the answer goes by text. */
export const TEXT_MS = 25_000;
export const TEXT_RESULT = "Reason is taking too long on this one: say in one short sentence that it's taking a while and Reason will text them the answer, then carry on the conversation (don't say it's still loading, don't ask if they're still there, and don't call ask_reason for it again).";
/** How a late answer's text opens, so it reads as part of the call. */
export const lateText = (text) => `From our call: ${text}`;
/**
 * Reason's turn had no words for the call (a skip, or nothing said). Call 113: the old "Reply yourself in a
 * few words" was the agent's licence to answer a booking on its own three times running.
 */
export const NOTHING_TO_ADD = "Reason has nothing to add yet. Reply in a few words with no fact, number or time of your own, and never say anything is done, booked, sent or submitted.";
/** How long a done-claim in Reason's answer backs the agent saying it (the GPT-Live guard's window). */
export const CLAIM_BACKED_MS = 60_000;
/** In the call's record after a done-claim nothing backed: the brain's next turn and the after-call text see it. */
export const UNBACKED_NOTE = "(Said on the call without Reason confirming it: unless the record shows it was really done, it is NOT done.)";
// Bare done-words the way a voice says them: "Yeah, submitted." "Booked: 8:10 tonight." "Done."
const BARE_DONE = /(?:^|[.!?…]\s+)(?:(?:yeah|yes|yep|yup)[,.!]?\s+)?(?:all\s+)?(?:done|booked|sent|texted|submitted|scheduled|confirmed|ordered|paid|cancel+ed|reserved)\s*(?:[:.!,]|$)/i;
// The rephrasings a voice reaches for instead ("All set." "You're good." "Taken care of." "Got you booked
// for 3." "Sent it over." "It went through." "I've filled it in."), read one clause at a time below.
const DONE_PARTS = "done|booked|sent|texted|emailed|messaged|submitted|scheduled|rescheduled|confirmed|ordered|paid|cancel+ed|reserved|purchased|bought|placed|finished|completed|handled|sorted|arranged|registered|filed|added|filled\\s+(?:it\\s+|that\\s+|them\\s+)?(?:in|out)|signed\\s+(?:you\\s+)?up|set\\s+up|locked\\s+in|squared\\s+away|taken\\s+care\\s+of";
const DONE_CLAUSE = new RegExp([
  `\\b(?:${DONE_PARTS})\\b`,
  `\\b(?:all|you(?:'|’)re|you\\s+are|we(?:'|’)re|we\\s+are|it(?:'|’)s|that(?:'|’)s)\\s+(?:all\\s+)?(?:set\\b|good\\s+to\\s+go\\b|(?:good|in)\\s*[.!,;…]*$)`,
  `\\b(?:went|gone|got)\\s+through\\b`,
  `\\b(?:put|got|have)\\s+(?:you|it|that|them|him|her)\\s+(?:down|in|on)\\b`,
  `\\bi\\s+(?:did|have)(?:\\s+(?:it|that|so))?\\s*[.!…]*$`,
  `\\b(?:form|order|booking|request|application|reservation|appointment|payment)(?:'|’)s\\s+in\\b`,
].join("|"), "i");
// What makes a clause not a claim: a negation, a future or a condition, an offer, or a question.
const NOT_A_CLAIM = /\b(?:not|never|nothing|no\s+one|yet\s+to|will|i(?:'|’)ll|it(?:'|’)ll|gonna|going\s+to|once|when|whenever|after|if|until|unless|as\s+soon\s+as|want\s+me|should\s+i|shall\s+i|can\s+i|could|would|ask(?:ing|ed)?\s+reason|let\s+me|try(?:ing)?\s+to|about\s+to|need(?:s)?\s+to|still|checking|check)\b|n(?:'|’)t\b/i;
/** One spoken reply as clauses, each with its own end mark ("?" marks a question). */
function clauses(t) {
  return (String(t).match(/[^.!?;…,]+[.!?;…,]*/g) ?? []).flatMap(s => s.split(/\s+but\s+/i)).map(s => s.replace(/,+$/, "").trim()).filter(Boolean);
}
/** Does this say something has been done? GPT-Live's `claimsDone`, plus the bare forms and the rephrasings. Exported for tests. */
export function saysDone(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return clauses(t.replace(/\bno\s+(?:worries|problem|prob)\b/gi, "")).some(c => !/\?\s*$/.test(c) && !NOT_A_CLAIM.test(c) && (claimsDone(c) || BARE_DONE.test(c) || DONE_CLAUSE.test(c)));
}
// Their words asking whether something is done ("Have you finished filling the form?" "and submitted?").
const DONE_QUESTION = new RegExp(`(?:\\b(?:is|was|are|were|did|does|has|have|had)\\b.*\\b(?:${DONE_PARTS}|through|in)\\b|\\b(?:${DONE_PARTS})\\b.*(?:\\?|\\byet\\b))`, "i");
const YES_FIRST = /^(?:yes|yeah|yep|yup|ya|yea|sure|of\s+course|absolutely|definitely|correct|right|that(?:'|’)s\s+right|it\s+is|it\s+has|i\s+did|i\s+have|we\s+did|uh[\s-]*huh|mm[\s-]*hmm)\b/i;
const HOLDING = /\b(?:ask|asking|check|checking|reason|not\s+sure|don(?:'|’)t\s+know|let\s+me|hold\s+on|one\s+(?:sec|moment))\b/i;
/** A bare yes to "is it done?" ("Yeah." "Yes, I did."): the same claim in fewer words. Exported for tests. */
export function confirmsDone(question, reply) {
  const r = String(reply ?? "").trim();
  return !!r && DONE_QUESTION.test(String(question ?? "")) && YES_FIRST.test(r) && !HOLDING.test(r) && !NOT_A_CLAIM.test(r);
}

// ---------- what the voice is handed, and what it was cut off saying (call 113) ----------

/**
 * Internal words that are never for the phone: a skip-turn marker said as words (call 113: "Skipping for
 * now." out loud), the silence marker, and tool names. `forVoice` takes them out of Reason's words at the
 * one place those words are handed to the voice (`spoken`); the agent's own lines are checked when they
 * end (`turnEnded`, logged) and kept out by `TURN_LINES`. Each entry is one spoken form, for the test.
 */
export const VOICE_MARKERS = [
  "Skipping for now.", "Skipping this turn.", "Skipping my turn.", "Skip turn.", "skip_turn", "[skip]", "<skip/>",
  "[silence]", "[no reply]", "NO_REPLY", "ask_reason", "verify_caller", "end_call", "message_send", "task_start", "web_search",
];
// A spoken skip marker is a sentence of its own ("Skipping for now.", "Okay, skip turn."), never words inside
// one: "skip the turn onto Main" and "I'm skipping for now the 8 am class" are left alone.
const SENTENCE_START = String.raw`(?:^|(?<=[.!?…]\s*))(?:(?:ok(?:ay)?|alright|sure|right)[,.]?\s+)?`;
const SENTENCE_END = String.raw`(?:[.!…]+(?=\s|$)|\s*$)`;
const MARKER_RES = [
  new RegExp(`${SENTENCE_START}(?:I'?m\\s+|I\\s+am\\s+|I'?ll\\s+be\\s+)?skipping\\s+(?:this\\s+turn|my\\s+turn|the\\s+turn|a\\s+turn|for\\s+now)${SENTENCE_END}`, "gi"),
  new RegExp(`${SENTENCE_START}skip(?:ped|ping)?[\\s-]+(?:this\\s+|my\\s+|the\\s+|a\\s+)?turn${SENTENCE_END}`, "gi"),
  /[[<]\/?\s*(?:skip|silence|pause|turn|no[\s_-]?reply)\s*\/?\s*[\]>]/gi,
  /\bNO[_\s]REPLY\b[.!,]*/g,
];
// A snake_case word (not inside a link or an address): a tool name or marker of ours comes out; any other
// ("store_credit", "model_error") is said as its words, so nothing real is lost.
const SNAKE = /(?<![\w/.:@-])[a-z]+(?:_[a-z0-9]+)+(?![\w/@-]|\.\w)([.!,]*)/g;
const DROP_SNAKE = new Set(VOICE_MARKERS.filter(m => /^[a-z]+(?:_[a-z0-9]+)+$/.test(m)));
/** Reason's words with every internal marker taken out, and the spacing put right after; words with none are returned as they came. */
export function forVoice(text) {
  let t = String(text ?? "");
  let removed = false;
  for (const re of MARKER_RES) t = t.replace(re, () => { removed = true; return " "; });
  t = t.replace(SNAKE, (w, punct) => {
    const word = w.slice(0, w.length - punct.length);
    if (DROP_SNAKE.has(word)) { removed = true; return " "; }
    return word.replace(/_/g, " ") + punct;
  });
  if (!removed) return t.trim();
  // Only where something came out: the spacing and stray punctuation it left (an ellipsis stays).
  return t.replace(/\(\s*\)/g, " ").replace(/\s+([.,!?;:)])/g, "$1").replace(/^[\s.,;:!?…-]+/, "")
    .replace(/([.!?])[,;:]+/g, "$1").replace(/(?<!\.)\.\.(?!\.)/g, ".").replace(/([!?])\./g, "$1").replace(/\s{2,}/g, " ").trim();
}
/** Did this line carry a marker? (Text the agent already spoke: logged, it cannot be unsaid.) */
export const hasMarker = (text) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return !!t && forVoice(t) !== t.replace(/\s+([.,!?;:])/g, "$1"); };

/** The agent's "You still there?" (Cartesia's inactivity check-in, `config.turn.inactivity_check_in_secs`). */
export const CHECK_IN = /\b(?:(?:are\s+)?you\s+still\s+(?:there|with\s+me)|are\s+you\s+there|you\s+there\s*\?|still\s+(?:there|with\s+me)\s*\?|hello\s*\?\s*$)/i;
/** They asked Reason to wait: "give me a second", "hold on", "one sec", "wait" (not "wait for 8"). */
export const WAIT_ASK = /\b(?:give\s+me\s+(?:a|one|a\s+quick)\s+(?:sec(?:ond)?|minute|moment|min)|hold\s+on|hang\s+on|one\s+sec(?:ond)?|just\s+a\s+(?:sec(?:ond)?|minute|moment)|wait\s+a\s+(?:sec(?:ond)?|minute|moment)|(?:^|[.,!?]\s*)wait(?=\s*(?:[.,!?]|$)))/i;

/** An answer counts as heard once this share of its words was spoken before they cut in. */
export const HEARD_SHARE = 0.6;
/** The short form of an answer they did not hear: its first sentence, cut to this. */
export const SHORT_MAX = 160;
export function shortForm(text, max = SHORT_MAX) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const first = (t.match(/^.+?[.!?](?=\s|$)/) ?? [t])[0];
  return first.length > max ? `${first.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : first;
}
const wordsOf = (s) => String(s ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
/** How much of `answer` is in what was `spoken`, 0..1, by words. */
export function heardShare(spoken, answer) {
  const want = wordsOf(answer);
  if (!want.length) return 1;
  const got = new Set(wordsOf(spoken));
  return want.filter(w => got.has(w)).length / want.length;
}
/** An answer carrying a code, password or account-like number: never offered again by `unheard`. */
export const SECRETISH = /\b(?:code|passcode|password|passphrase|pin|one[-\s]time|otp|verification|cvv|card\s+number|account\s+number|routing\s+number|social\s+security|ssn)\b|\b\d(?:[\s-]?\d){5,}\b/i;
/** What the next answer leads with when they talked over the last one before its point. */
export const reofferLead = (short) => `They spoke over Reason's last answer before hearing it: first say its point again in one short sentence ("${short}"), then the new answer.`;
/** The result when Reason has nothing new but an answer was lost: say the lost point again. */
export const reofferOnly = (short) => `They spoke over Reason's last answer before hearing it: say its point again now, in one short sentence: "${short}"`;
/** In the call's record when an answer was lost: the brain's next turn and the after-call text see it. */
export const unheardNote = (short) => `(They spoke over this before hearing it, so they have NOT heard it: "${short}")`;

/** A lookup this slow (ask to answer): the answer opens by owning the wait, in a few words. */
export const SLOW_ACK_MS = 12_000;
export const SLOW_ACK_LEAD = "That took a while: open with a few words owning the wait (\"Sorry, that took a minute.\"), then the answer.";

/**
 * Reason's turn put an ask off until after the call (src/calls/verify.js: an inbound call is not verified
 * by caller ID alone), and its words for the call don't say so. Call 113: the line was never heard, three
 * times. This is said at once instead of nothing.
 */
export const DEFERRED_LINE = "I can't do that one from a call. I'll do it by text right after we hang up, and tell you there.";
const SAYS_DEFERRED = /\b(?:by\s+text|text\s+you|texting|after\s+(?:the|this|our)\s+call|after\s+we\s+hang\s+up|when\s+we\s+hang\s+up|as\s+soon\s+as\s+(?:I|we)\s+hang\s+up)\b/i;
/** Reason's reply with the deferral said, if its words leave it out. Exported for tests. */
export function withDeferredLine(reply) {
  const text = String(reply?.text ?? "").trim();
  if (text && SAYS_DEFERRED.test(text) && !reply?.skip) return { reply, added: false };
  return { reply: { ...(reply ?? {}), text: reply?.skip || !text ? DEFERRED_LINE : `${DEFERRED_LINE} ${text}`, skip: false }, added: true };
}

/** The caller's likely ways of saying a time, in the keyterm slots their names leave free (call 113: "8:10" heard as "8 to 10"). */
export const TIME_KEYTERMS = ["PM", "AM", "o'clock", "half past", "quarter past", "quarter to"];

// ---------- falling back, by reason ----------

/**
 * Why a call fell back, as one of a fixed set (db.CARTESIA_FALLBACK_REASONS): read off what Cartesia
 * said (a close reason, an error code or message) where it says a refusal, else `fallback`. Their docs
 * name 429 for a plan's limit and say new calls stop once the agent balance is $0; the exact words of a
 * refused agent session are not documented (docs/unverified.md), so this reads codes and plain words.
 */
export function fallBackReason(said, fallback = "other") {
  const t = String(said ?? "");
  if (/\b402\b|payment|credit|balance|insufficient|billing|quota|funds|overage/i.test(t)) return "refused_out_of_credits";
  if (/\b429\b|rate.?limit|concurren|too many|limit (?:reached|exceeded)|plan limit|capacity/i.test(t)) return "refused_plan_limit";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|api.?key/i.test(t)) return "refused_auth";
  return fallback;
}

/** Today's numbers (db.cartesia_daily): calls, ready, fell_back:<reason>, on the app's clock. Never throws, never names anyone. */
export function count(what) {
  try { db.bumpCartesia(accounts.today(clock.now()), what); } catch { /* a number never breaks a call */ }
}

// ---------- talked over ----------

/** A gap this long in his speech starts a new run of it (the onset a barge-in is timed from). */
export const RUN_GAP_MS = 500;
/** He counts as talking at a clear when his last speech frame was this recent. */
export const TALKING_MS = 1_000;
/** The agent counts as playing at a clear when its last speech frame was this recent. */
export const PLAYING_MS = 300;

/** Cartesia's agent WebSocket, as `{ send(obj), close(), on(name, fn) }` (the shape `openLiveSocket` has). */
export function openAgentSocket({ agentId = config.cartesiaAgentId, key = config.cartesiaKey, base = API_BASE } = {}) {
  const url = `${base.replace(/^http/, "ws")}/v1/agents/websocket/${encodeURIComponent(agentId)}?cartesia_version=${VERSION}`;
  const ws = new WebSocket(url, { headers: { "X-API-Key": key, "Cartesia-Version": VERSION } });
  const handlers = { open: [], event: [], close: [] };
  const run = (list, ...args) => { for (const f of list) { try { f(...args); } catch { /* one call never takes the process */ } } };
  ws.onopen = () => run(handlers.open);
  ws.onmessage = (m) => { let e; try { e = JSON.parse(String(m.data)); } catch { return; } run(handlers.event, e); };
  ws.onclose = (e) => run(handlers.close, e?.code ?? 1006, String(e?.reason ?? "").slice(0, 200));
  ws.onerror = () => { /* the close that follows says it */ };
  return {
    send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
    on: (name, fn) => handlers[name]?.push(fn),
  };
}

/**
 * Cartesia's copy of one agent call deleted (DELETE /agents/calls/{id}): its transcript, recording and
 * logs. Only a finished call can be deleted, so a 400 is tried again a few times. `{ ok, redacted, status }`;
 * `ok` only when the answer carries `redacted_at`. Never throws.
 */
export async function deleteAgentCall(callId, { key = config.cartesiaKey, base = API_BASE, fetchImpl = globalThis.fetch, tries = 4, waitMs = 1500, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!callId) return { ok: false, redacted: false, status: 0, why: "no call id" };
  let last = { ok: false, redacted: false, status: 0, why: "" };
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(`${base}/agents/calls/${encodeURIComponent(callId)}`, { method: "DELETE", headers: { "X-API-Key": key, "Cartesia-Version": VERSION } });
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      const redacted = !!json?.redacted_at;
      last = { ok: res.ok && redacted, redacted, status: res.status, why: res.ok ? (redacted ? "" : "no redacted_at in the answer") : String(json?.message ?? json?.error ?? "").slice(0, 120) };
      if (last.ok || (res.status !== 400 && res.status !== 409 && res.status < 500)) return last;
    } catch (e) {
      last = { ok: false, redacted: false, status: 0, why: (e?.message ?? String(e)).split("\n")[0].slice(0, 120) };
    }
    if (i < tries - 1) await sleep(waitMs);
  }
  return last;
}

/**
 * What the agent is told for this call, as dynamic variables its saved instructions use: the same words a
 * GPT-Live own call is given (`voiceInstructionsFor`: the name he gave Reason, the one identity, persona,
 * carryover and his brief), and the same opening line. No second persona is written for Cartesia.
 */
export function sessionVariables(call) {
  // On this person's own clock (src/zonescope.js), as their turns are: "today", "now" and the brief's
  // times are theirs, never the install's or another account's.
  return zonescope.runFor(call?.conversation_id, () => variablesOf(call));
}

function variablesOf(call) {
  const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  let name = "";
  // The name they gave, or nothing: never the stand-in an unnamed account reads as ("the person I work for").
  try { const me = accounts.ownerOf(call.conversation_id); name = me?.name && me.name !== NO_NAME ? me.name : ""; } catch { /* unknown */ }
  const greeting = call.direction === "in"
    ? openingLineFor({ person: accounts.ownerOf(call.conversation_id), conversationId: call.conversation_id })
    : String(call.announcement ?? "");
  // Names from their own chats today (this call's conversation only), the ones the brief tells GPT-Live a bad line often garbles: the recognizer
  // favours them. A slot with nothing for it says "Reason" (an empty keyterm is not known to be allowed).
  let names = [];
  try { names = (todaySoFar(call.conversation_id, { until: Number(call.created_at) || clock.now(), call: call.id })?.names ?? []).map(n => clip(n, 60)).filter(Boolean); } catch { /* none */ }
  // Two slots are kept for the ways a time is said (TIME_KEYTERMS), whatever the names.
  const terms = [...names.slice(0, KEYTERM_SLOTS - 2), ...TIME_KEYTERMS.filter(t => !names.includes(t))];
  const keyterms = Object.fromEntries(Array.from({ length: KEYTERM_SLOTS }, (_, i) => [`keyterm_${i + 1}`, terms[i] ?? "Reason"]));
  return {
    ...keyterms,
    // No turn gate here: the agent's own turn-taking replaces it (section 3), so its lines are left out.
    // This line's own manner goes last, after the brief, and is never the part cut.
    reason_call: reasonCall(call, clip),
    greeting: clip(greeting || "Hey, it's Reason.", 400),
    their_name: clip(name, 80),
  };
}

/**
 * Their clock, said: the agent has one time zone set on it for every call (scripts/cartesia-agent-setup.mjs),
 * so each call says whose time it is. Their confirmed zone, else the install's (src/zone.js `zoneFor`).
 */
export function clockLine(call) {
  let tz = "";
  try { tz = zoneFor(call.conversation_id); } catch { tz = config.installTz; }
  const at = Number(call.created_at) || clock.now();
  let when = "";
  try { when = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" }).format(new Date(at)); } catch { return ""; }
  return `Their clock: it is ${when} where they are (${tz}) as the call starts. Any time or day you say is in their time, never another clock.`;
}

/** The GPT-Live own-call words (cut to fit), then their clock and this line's manner (`cartesiaCallLines`). */
function reasonCall(call, clip) {
  const lines = [clockLine(call), cartesiaCallLines()].filter(Boolean).join("\n");
  return `${clip(voiceInstructionsFor(call, { line: false, turnGate: false }), VARIABLE_MAX - lines.length - 1)}\n${lines}`;
}

const WAITED = Symbol("waited");

/**
 * One of their own calls on the Cartesia agent: Twilio's stream on one side, the agent on the other.
 * Everything a call holds is on its own instance (its row, its socket, its turns, its asks, its tape,
 * its Cartesia call id): calls running at once on the one agent share nothing but the agent's id.
 */
export class CartesiaAgentCall {
  constructor({ call, twilio, openAgent = openAgentSocket, brain, finish = async () => {}, fallBack = null, deleteCall = deleteAgentCall, log = () => {}, now = () => Date.now(), timers = globalThis, readyMs = READY_MS, textMs = TEXT_MS, textOwner = null, deferredNow = null }) {
    this.call = call;
    this.twilio = twilio;
    this.openAgent = openAgent;
    this.brain = brain;
    this.finishCall = finish;
    this.fallBackTo = fallBack;
    this.deleteCall = deleteCall;
    this.log = log;
    this.now = now;
    this.timers = timers;
    this.readyMs = readyMs;
    this.textMs = textMs;
    // A slow answer the agent said it would text: the outbox, as any mid-call text of Reason's (./voice.js).
    this.textOwner = textOwner ?? ((text) => queueMidCall({ call, text, kind: "cartesia_late_answer", log }));
    // What this call has put off until after it (calls.verify_deferred, src/calls/verify.js), read fresh.
    this.deferredNow = deferredNow ?? (() => { try { return String(db.getCall(call.conversation_id, call.id)?.verify_deferred ?? ""); } catch { return ""; } });
    // Asks still waiting on Reason; one still waiting when the call ends goes by text.
    this.asking = new Set();
    // The room under the call, and with REASON_CARTESIA_LOOKUP_MUSIC on, soft music over it while a
    // lookup runs (./lookupmusic.js): `bed` is then the room with the music on top.
    const room = ambience.bedFor(call);
    const lm = lookupMusicFor(call, room, { log });
    this.music = lm?.music ?? null;
    this.musicSource = lm?.source ?? "";
    this.bed = lm?.bed ?? room;
    // Their own call is taped as a GPT-Live own call is (`GptLiveCall`: only a line call asks `callRecorded`).
    this.recorded = true;
    this.tape = new CallTape();
    if (!this.recorded) this.tape.stopAt(0);
    this.turns = [];
    // REASON_CALL_TRUST (./calltrust.js): what the caller's next words are for ("pass" | "setup" | null),
    // whether the latest ones were a screened passphrase, and asks waiting on that screen.
    this.earArmed = null;
    this.earJust = false;
    this.earWaiters = [];
    // The words just screened, in memory for this call only (never kept), so the agent saying them back is not
    // kept either; and where on the tape the ask began, so their side of the recording is silence until the screen.
    this.earEcho = null;
    this.earTapeFrom = null;
    this.streamSid = null;
    this.agentCallId = "";
    this.ready = false;
    this.done = false;
    this.handedOff = false;
    this.endWhy = "";
    this.startedAt = now();
    // The numbers the first call is for (section 5): kept per reply, logged as they happen and at the end.
    this.m = { replies: [], asks: [], overs: [], turnClock: [], laughs: 0, firstVoiceMs: null, unbacked: 0, markers: 0, checkIns: 0, unheard: 0, reoffered: 0, deferredSaid: 0 };
    // Reason's latest answer handed to the voice, until the agent's next turn says how much of it was
    // spoken; one they talked over before its point, until it is said again (`turnEnded`, `spoken`).
    this.answerOut = null;
    this.unheard = null;
    // When they last asked Reason to wait, and when Reason last had nothing to say (a skip).
    this.waitAskedAt = -Infinity;
    this.skippedAt = -Infinity;
    // The after-call queue as it stood when the deferral line was last added (`ask`).
    this.deferredSaidFor = "";
    /** When Reason's latest answer said something was done (`claimsDone`), for `turnEnded`'s check. */
    this.claimedAt = -Infinity;
    this.theirTurnEndAt = null;
    this.askAnsweredAt = null;
    this.replyKind = "plain";
    // Talked over (`audio_output_clear`): his current run of speech, and the agent's, each from its onset.
    this.agentSpeechAt = -Infinity;
    this.agentRunAt = null;
    this.lastSpeechAt = -Infinity;
    this.speechRunAt = null;
    twilio.onMessage((text) => { if (!this.handedOff) this.fromTwilio(text); });
    twilio.onClose(() => { if (!this.handedOff) this.end("caller hung up").catch(() => {}); });
  }

  /** Open the agent and start the clock it has to be ready by. */
  begin() {
    count("calls");
    this.readyTimer = this.timers.setTimeout(() => { if (!this.ready) this.fallBack(`not ready in ${this.readyMs} ms`, "not_ready"); }, this.readyMs);
    try {
      this.agent = this.openAgent();
    } catch (e) {
      const msg = (e?.message ?? String(e)).split("\n")[0];
      return this.fallBack(`could not open: ${msg}`, fallBackReason(msg, "could_not_open"));
    }
    this.agent.on("open", () => {
      this.openedMs = this.now() - this.startedAt;
      this.agent.send({ type: "session_create", audio: { input_format: "mulaw_8000", output_delivery: "speaking_pace", continuous_input: true }, dynamic_variables: sessionVariables(this.call) });
    });
    this.agent.on("event", (e) => this.fromAgent(e));
    this.agent.on("close", (code, said = "") => {
      if (this.done || this.handedOff) return;
      // A refused session (plan limit, no credits, a bad key) closes before it is ready: why, from what they said.
      if (!this.ready) return this.fallBack(`closed before ready (${code})`, fallBackReason(`${code} ${said}`, "closed_before_ready"));
      // A clean close is the agent hanging up (its end_call); anything else is a failure, and he is still
      // on the line: GPT-Live takes the rest of the call.
      if (code === 1000 || this.endWhy === "goodbye") return void this.end(this.endWhy || "agent ended").catch(() => {});
      this.fallBack(`closed mid-call (${code})`, fallBackReason(`${code} ${said}`, "closed_mid_call"));
    });
    this.twilio.flush?.();
  }

  // --- Twilio side ---

  fromTwilio(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.event === "start") {
      this.streamSid = m.start?.streamSid ?? m.streamSid ?? null;
      this.callSid = m.start?.callSid ?? "";
      this.streamStartAt = this.now();
      this.log({ cartesia_stream_start: this.call.id, ...(this.bed?.kind ? { ambience: this.bed.kind } : {}), ...(this.music ? { lookup_music: this.musicSource } : {}) });
      this.roomTick();
    } else if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      const buf = Buffer.from(m.media.payload, "base64");
      this.tape.them(buf);
      // His speech, as runs: a gap of RUN_GAP_MS starts a new one (the onset a barge-in is timed from).
      if (hasSpeech(m.media.payload)) {
        const t = this.now();
        if (t - this.lastSpeechAt > RUN_GAP_MS) this.speechRunAt = t;
        this.lastSpeechAt = t;
        this.music?.speech(t);
      }
      if (this.ready) this.agent.send({ type: "audio_input", audio: m.media.payload });
    } else if (m.event === "stop") {
      this.end("caller hung up").catch(() => {});
    }
  }

  toTwilio(obj) {
    if (!this.streamSid || this.done) return;
    if (this.bed && obj.event === "media" && obj.media?.payload) obj = { ...obj, media: { ...obj.media, payload: this.bed.mix(obj.media.payload, this.now()) } };
    this.twilio.send(JSON.stringify({ ...obj, streamSid: this.streamSid }));
  }

  /** The room under the call (./ambience.js), topped up as on a GPT-Live call. */
  roomTick() {
    if (!this.bed || this.done || this.handedOff) return;
    const frames = this.streamSid ? this.bed.fill(this.now(), { talking: false }) : null;
    if (frames) this.twilio.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: frames } }));
    this.roomTimer = this.timers.setTimeout(() => this.roomTick(), ambience.TICK_MS);
  }

  // --- the agent's side ---

  fromAgent(e) {
    // Fallen back before it was ready: a session that comes up late is a call on their side, so its id is
    // kept, the socket closed and the call deleted (no audio was ever sent to it).
    if (this.handedOff && e?.type === "session_ready" && !this.agentCallId) {
      this.agentCallId = String(e.call_id ?? "");
      if (this.lateTimer) this.timers.clearTimeout(this.lateTimer);
      try { this.agent?.close(); } catch { /* already gone */ }
      this.log({ cartesia_late_ready: this.call.id, ms: this.now() - this.startedAt });
      if (this.agentCallId) void this.deleteAndCheck();
      return;
    }
    if (this.done || this.handedOff || !e?.type) return;
    const t = this.now();
    switch (e.type) {
      case "session_ready": {
        this.agentCallId = String(e.call_id ?? "");
        if (this.ready) return;
        this.ready = true;
        if (this.readyTimer) this.timers.clearTimeout(this.readyTimer);
        count("ready");
        this.log({ cartesia_ready: this.call.id, ms: t - this.startedAt, open_ms: this.openedMs ?? null });
        return;
      }
      case "audio_output": return this.audioOut(String(e.audio ?? ""));
      case "audio_output_clear": {
        // Their talk-over, cleared on the phone too: his first sound → their clear → ours.
        this.toTwilio({ event: "clear" });
        this.tape.cut();
        this.bed?.cleared(t);
        // Timed from when the two of them were first talking at once: his run's onset, or the agent's if it
        // started over him. Their clear also comes with nothing playing (their docs: "there is nothing to
        // clear"); that is no barge-in, and `playing` says which. Not talking now: no time.
        const playing = t - this.agentSpeechAt < PLAYING_MS;
        const talking = t - this.lastSpeechAt < TALKING_MS && this.speechRunAt != null;
        const from = talking ? Math.max(this.speechRunAt, playing && this.agentRunAt != null ? this.agentRunAt : -Infinity) : null;
        const over = { sound_to_clear_ms: from == null ? null : t - from, playing, clear_to_twilio_ms: this.now() - t };
        this.m.overs.push(over);
        this.log({ cartesia_talked_over: this.call.id, ...over });
        this.agentSpeechAt = -Infinity;
        this.agentRunAt = null;
        return;
      }
      case "client_tool_call": return void this.tool(e);
      case "turn_ended": return this.turnEnded(e);
      case "error": {
        this.log({ cartesia_error: this.call.id, code: String(e.code ?? "").slice(0, 60), fatal: !!e.fatal });
        const said = `${e.code ?? ""} ${e.status ?? ""} ${e.message ?? ""}`;
        if (e.fatal && !this.ready) return this.fallBack(`error before ready: ${String(e.code ?? "")}`, fallBackReason(said, "error_before_ready"));
        if (e.fatal) return this.fallBack(`error mid-call: ${String(e.code ?? "")}`, fallBackReason(said, "error_mid_call"));
        return;
      }
      default: return;
    }
  }

  audioOut(b64) {
    if (!b64) return;
    const t = this.now();
    const speech = hasSpeech(b64);
    if (speech) {
      if (this.m.firstVoiceMs == null && this.streamStartAt != null) {
        this.m.firstVoiceMs = t - this.streamStartAt;
        this.log({ cartesia_first_voice: this.call.id, ms: this.m.firstVoiceMs });
      }
      // He stopped talking → the first audio with speech in it, per reply; an ask_reason reply apart.
      if (this.theirTurnEndAt != null) {
        const reply = { kind: this.replyKind, ms: t - this.theirTurnEndAt, ...(this.askAnsweredAt != null ? { answered_to_speech_ms: t - this.askAnsweredAt } : {}) };
        this.m.replies.push(reply);
        this.log({ cartesia_reply: this.call.id, ...reply });
        this.theirTurnEndAt = null;
        this.askAnsweredAt = null;
        this.replyKind = "plain";
      }
      if (t - this.agentSpeechAt > RUN_GAP_MS) this.agentRunAt = t;
      this.agentSpeechAt = t;
      // The music ducks under this frame (the agent's own line), or is gone within it (the answer).
      this.music?.speech(t);
    }
    this.tape.reason(Buffer.from(b64, "base64"));
    this.toTwilio({ event: "media", media: { payload: b64 } });
  }

  turnEnded(e) {
    let text = String(e.text ?? "").replace(/\s+/g, " ").trim();
    const who = e.role === "user" ? "them" : "reason";
    // REASON_CALL_TRUST: their words right after Reason asked for a passphrase are checked in code and
    // kept only as a marker (./calltrust.js), before they reach the turns, the transcript or Reason.
    if (who === "them" && this.earArmed && text) {
      const heard = calltrust.hear(this.call, text, { log: this.log });
      if (heard) { text = heard.text; this.earJust = true; if (heard.echo) this.earEcho = heard.echo; }
      this.tape.blank(this.earTapeFrom ?? this.tape.callerBytes - 15_000 * 8, this.tape.callerBytes);
      this.earTapeFrom = null;
      this.earArmed = null;
      this.earWaiters.splice(0).forEach(f => f());
    }
    if (who === "reason" && text) text = calltrust.unechoed(calltrust.scrubSaid(text), this.earEcho);
    if (text) this.turns.push({ who, text, at: this.now(), ...(e.interrupted ? { interrupted: true } : {}) });
    // The honesty guard (GPT-Live's `claimsDone`, on this line too): the agent said something is done and
    // no answer of Reason's in the last minute said so. The words are already spoken (their socket takes
    // no correction mid-call), so it is logged, counted and written into the record, where Reason's next
    // turn and the after-call text read it.
    const asked = who === "reason" ? this.turns.findLast(t => t.who === "them" && t !== this.turns.at(-1))?.text : "";
    if (who === "reason" && text && (saysDone(text) || confirmsDone(asked, text)) && this.now() - this.claimedAt > CLAIM_BACKED_MS) {
      this.m.unbacked += 1;
      this.log({ cartesia_unbacked_claim: this.call.id, turn: Number(e.turn) || 0, chars: text.length });
      this.turns.push({ who: "reason", text: UNBACKED_NOTE, at: this.now() });
    }
    if (who === "them") {
      this.theirTurnEndAt = this.now();
      this.replyKind = "plain";
      this.askAnsweredAt = null;
      if (WAIT_ASK.test(text)) this.waitAskedAt = this.now();
    } else {
      this.m.laughs += (String(e.text ?? "").match(/\[laughter\]/gi) ?? []).length;
      this.agentTurnEnded(e, text);
    }
    // Their clock beside ours (seconds into their session).
    const clock = { turn: Number(e.turn) || 0, role: who, end_time: Number(e.end_time) || null, eager_end: Number(e.eager_end_timestamp) || null, at_ms: this.now() - this.startedAt };
    this.m.turnClock.push(clock);
    this.log({ cartesia_turn: this.call.id, ...clock });
  }

  /**
   * One of the agent's turns ended (`text` is what it actually spoke, `interrupted` whether he cut in:
   * their agent WebSocket's turn_ended). Three checks, none of which changes when anyone speaks:
   * a marker said out loud, a check-in and what it came after, and Reason's answer talked over before
   * its point (kept, and offered again by the next answer: `spoken`).
   */
  agentTurnEnded(e, text) {
    const t = this.now();
    if (text && hasMarker(text)) {
      this.m.markers += 1;
      this.log({ cartesia_marker_spoken: this.call.id, turn: Number(e.turn) || 0 });
    }
    if (text && CHECK_IN.test(text) && text.length <= 40) {
      this.m.checkIns += 1;
      const ago = (at) => (Number.isFinite(at) ? t - at : null);
      this.log({ cartesia_check_in: this.call.id, n: this.m.checkIns, after_wait_ask_ms: ago(this.waitAskedAt), after_skip_ms: ago(this.skippedAt), lookup_pending: this.asking.size > 0 });
    }
    const out = this.answerOut;
    this.answerOut = null;
    if (out) {
      const share = heardShare(text, out.text);
      // A code, password or long number is never said again from memory: no offer, no note quoting it. Nor a
      // call-passphrase line (./calltrust.js): said again later, the words after it would not be screened.
      if (e.interrupted && share < HEARD_SHARE && (SECRETISH.test(out.text) || (calltrust.trustOn(this.call) && calltrust.isTrustLine(out.text)))) {
        this.log({ cartesia_answer_unheard: this.call.id, turn: Number(e.turn) || 0, heard_pct: Math.round(share * 100), withheld: true });
      } else if (e.interrupted && share < HEARD_SHARE) {
        this.unheard = { text: out.text, short: shortForm(out.text), at: t };
        this.m.unheard += 1;
        this.turns.push({ who: "reason", text: unheardNote(this.unheard.short), at: t });
        this.log({ cartesia_answer_unheard: this.call.id, turn: Number(e.turn) || 0, heard_pct: Math.round(share * 100) });
      }
      return;
    }
    // The agent said the lost point again on its own (TURN_LINES): nothing left to offer.
    if (this.unheard && !e.interrupted && heardShare(text, this.unheard.short) >= HEARD_SHARE) {
      this.m.reoffered += 1;
      this.log({ cartesia_answer_reoffered: this.call.id, by: "agent" });
      this.unheard = null;
    }
  }

  /** The conversation so far as Reason's turn reads it (the same shape a GPT-Live hand-off sends). */
  messages(request = "") {
    const out = [];
    for (const t of this.turns) {
      const role = t.who === "them" ? "user" : "assistant";
      if (out.length && out.at(-1).role === role) out.at(-1).content += ` ${t.text}`;
      else out.push({ role, content: t.text });
    }
    const asked = String(request ?? "").replace(/\s+/g, " ").trim();
    if (asked && !(out.at(-1)?.role === "user" && out.at(-1).content.includes(asked))) {
      if (out.at(-1)?.role === "user") out.at(-1).content += ` (${asked})`;
      else out.push({ role: "user", content: asked });
    }
    return out;
  }

  async tool(e) {
    const id = String(e.tool_call_id ?? "");
    const answer = (result, isError = false) => {
      if (e.expects_response === false || this.done) return;
      this.agent.send({ type: "client_tool_result", tool_call_id: id, result: String(result).slice(0, RESULT_MAX), is_error: !!isError });
    };
    if (e.tool_name !== ASK_REASON) return answer(`No tool called ${String(e.tool_name ?? "")}.`, true);
    let request = e.parameters?.request ?? e.parameters?.question ?? "";
    // Their passphrase answer may reach this tool before its own turn_ended: waited for, briefly, so it is
    // screened first; then the agent's copy of it is never passed on.
    if (this.earArmed) await new Promise(r => { this.earWaiters.push(r); this.timers.setTimeout(r, EAR_WAIT_MS); });
    // Still not screened after the wait (their turn_ended is late), or the agent's words repeat what was: the
    // agent's copy is never passed on either way.
    if (this.earJust || this.earArmed || calltrust.echoes(request, this.earEcho)) { this.earJust = false; request = calltrust.SCREENED_REQUEST; }
    this.replyKind = "ask_reason";
    const askedAt = this.now();
    const p = { askedAt, texting: false, texted: false, reply: undefined, done: null };
    // The lookup has begun: music under it from MUSIC_DELAY_MS, until its answer goes back or to a text.
    this.music?.start(p, askedAt);
    this.asking.add(p);
    p.done = this.ask(request, p);
    // Waited for, up to TEXT_MS: the answer itself is the result, and the agent speaks it.
    const out = await this.within(p.done, this.textMs);
    if (p.texting) return; // the call ended meanwhile: it went by text
    if (out !== WAITED) { this.asking.delete(p); this.music?.end(p); return answer(...this.spoken(out, { waitedMs: this.now() - askedAt })); }
    // Past TEXT_MS: the agent says once that it will come by text, and the answer is texted when it lands.
    this.toText(p);
    this.log({ cartesia_ask_to_text: this.call.id, ms: this.now() - askedAt });
    return answer(TEXT_RESULT);
  }

  /** This ask goes by text now: its answer as soon as it is back (at once, if it already is). */
  toText(p) {
    if (p.texting) return;
    p.texting = true;
    this.asking.delete(p);
    this.music?.end(p);
    if (p.reply !== undefined) this.textLate(p);
  }

  /** Reason's turn for one ask; logged once it is back. A late one the agent said it would text goes by text. */
  async ask(request, p) {
    let reply;
    const deferredBefore = this.deferredNow();
    const armedBefore = calltrust.listening(this.call);
    try {
      reply = await this.brain(this.messages(request));
    } catch (err) {
      reply = { text: "", error: (err?.message ?? String(err)).split("\n")[0] };
    }
    // REASON_CALL_TRUST: this turn asked for the passphrase (./calltrust.js). The ask is said in its fixed
    // words, whatever the model wrote; they say the text-after-the-call half too, so no deferral line is added.
    const armedNow = calltrust.listening(this.call);
    if (!reply?.error && armedNow === "pass" && armedBefore !== "pass" && !String(reply?.text ?? "").includes(calltrust.LINES.ask)) {
      reply = { ...(reply ?? {}), text: calltrust.LINES.ask, skip: false };
      this.log({ cartesia_trust_ask_fixed: this.call.id });
    }
    // This turn put something off until after the call: it is said now, in words, never a skip.
    // verify_deferred only grows on a call (verify.js queueForAfter); a growth another ask already said is not said twice.
    const deferredAfter = this.deferredNow();
    if (!reply?.error && deferredAfter && deferredAfter !== deferredBefore && deferredAfter !== this.deferredSaidFor) {
      this.deferredSaidFor = deferredAfter;
      const d = withDeferredLine(reply);
      reply = d.reply;
      this.m.deferredSaid += 1;
      this.log({ cartesia_deferred_said: this.call.id, line_added: d.added });
    }
    const answeredAt = this.now();
    const ask = { asked_to_answered_ms: answeredAt - p.askedAt, error: !!reply?.error, skip: !!reply?.skip, to_text: p.texting, ...(this.music ? { music: answeredAt - p.askedAt >= MUSIC_DELAY_MS } : {}) };
    this.m.asks.push(ask);
    this.log({ cartesia_ask_reason: this.call.id, ...ask });
    this.askAnsweredAt = answeredAt;
    if (!reply?.skip && saysDone(reply?.text)) this.claimedAt = answeredAt;
    p.reply = reply;
    // Reason asked for a passphrase (or a new one) in this answer: their next words are for code.
    this.earArmed = armedNow;
    if (armedNow && this.earTapeFrom == null) this.earTapeFrom = this.tape.callerBytes;
    if (p.texting) this.textLate(p);
    return reply;
  }

  /** A late answer by text, once, through the outbox; words only when Reason had some. */
  textLate(p) {
    if (p.texted) return;
    p.texted = true;
    const reply = p.reply;
    const text = String(reply?.text ?? "").trim();
    if (!text || reply?.skip) { this.log({ cartesia_late_answer: this.call.id, texted: false, why: reply?.error ? "error" : "nothing to say" }); return; }
    let r;
    try { r = this.textOwner(lateText(text)); } catch (e) { r = { ok: false, why: (e?.message ?? String(e)).split("\n")[0] }; }
    this.log({ cartesia_late_answer: this.call.id, texted: !!r?.ok });
    // In the call's own record, so the after-call turn sees it went (and the read of the call does too).
    if (r?.ok && !this.done) this.turns.push({ who: "reason", text: `(Texted them: ${text.length > 300 ? `${text.slice(0, 299)}…` : text})`, at: this.now() });
  }

  /** `promise`'s value, or WAITED once `ms` have gone by first. */
  within(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => resolve(WAITED), Math.max(0, ms));
      promise.then((v) => { this.timers.clearTimeout(timer); resolve(v); });
    });
  }

  /**
   * What the agent is answered with for one reply of Reason's: `[result, isError]`. The one place Reason's
   * words are handed to the voice, so the markers come out here (`forVoice`); a lost answer is offered
   * again ahead of the new one, and a slow one opens by owning the wait.
   */
  spoken(reply, { waitedMs = 0 } = {}) {
    if (reply?.error && !reply?.text) return ["Reason could not answer that just now. Say so briefly and offer to try again.", true];
    const text = forVoice(reply?.text);
    const lost = this.unheard;
    if (reply?.skip || !text) {
      this.skippedAt = this.now();
      if (lost) { this.unheard = null; this.m.reoffered += 1; this.log({ cartesia_answer_reoffered: this.call.id, by: "nothing_new" }); return [reofferOnly(lost.short), false]; }
      return [NOTHING_TO_ADD, false];
    }
    if (reply?.endCall) this.endWhy = "goodbye";
    this.answerOut = { text, at: this.now() };
    const lead = [waitedMs >= SLOW_ACK_MS ? SLOW_ACK_LEAD : "", lost ? reofferLead(lost.short) : ""].filter(Boolean);
    if (lost) { this.unheard = null; this.m.reoffered += 1; this.log({ cartesia_answer_reoffered: this.call.id, by: "next_answer" }); }
    return [lead.length ? `${lead.join(" ")} Reason's answer: ${text}` : text, false];
  }

  /** Answering-machine detection is only asked for on third-party calls; their own call has nothing to do with a verdict. */
  amd() {}

  // --- falling back, and the end ---

  /** Not ready in time, or broken before it was: the same call carries on with GPT-Live. */
  fallBack(why, reason = fallBackReason(why)) {
    if (this.done || this.handedOff) return null;
    this.handedOff = true;
    this.music?.stop();
    for (const k of ["readyTimer", "roomTimer"]) if (this[k]) this.timers.clearTimeout(this[k]);
    // `reason`: one word from a fixed set, the same word counted for the day (`count`).
    count(`fell_back:${reason}`);
    this.log({ cartesia_fell_back: this.call.id, reason, why: String(why).slice(0, 120), ms: this.now() - this.startedAt });
    this.noteMinutes(true);
    // A session that did start is a call on their side, kept until deleted. One still coming up is given
    // LATE_READY_MS to say its id (`fromAgent`), then let go.
    if (this.agentCallId) { try { this.agent?.close(); } catch { /* already gone */ } void this.deleteAndCheck(); }
    else if (this.agent && !/closed|could not open/.test(String(why))) this.lateTimer = this.timers.setTimeout(() => { try { this.agent?.close(); } catch { /* already gone */ } }, LATE_READY_MS);
    else { try { this.agent?.close(); } catch { /* already gone */ } }
    // What was said so far goes with the call, so Reason's turns and the thread have all of it.
    return this.fallBackTo ? this.fallBackTo(why, this.turns.map(t => ({ ...t }))) : null;
  }

  /**
   * What the Cartesia voice ran on this call, on the call row for the plan meter on /ops
   * (src/planmeter.js): written once, when this relay lets the call go. Numbers only.
   */
  noteMinutes(fellBack, seconds = Number.isFinite(this.startedAt) ? Math.round((this.now() - this.startedAt) / 1000) : 0) {
    const s = Math.max(0, Number(seconds) || 0);
    try {
      db.updateCall(this.call.conversation_id, this.call.id, {
        cartesia_seconds: s, cartesia_cents: Math.round((s / 60) * config.cartesiaRateUsdPerMin * 100), cartesia_fell_back: fellBack ? 1 : 0,
      });
    } catch { /* a number never breaks a call */ }
  }

  async deleteAndCheck() {
    const d = await this.deleteCall(this.agentCallId);
    this.log({ cartesia_recording_deleted: this.call.id, ok: !!d?.ok, redacted: !!d?.redacted, status: d?.status ?? 0 });
    return d;
  }

  async end(why = "") {
    if (this.done || this.handedOff) return;
    this.done = true;
    this.music?.stop();
    // A lookup still running when the call ends: its answer goes by text when it lands.
    for (const p of [...this.asking]) this.toText(p);
    this.endWhy = this.endWhy || why;
    for (const k of ["readyTimer", "roomTimer"]) if (this[k]) this.timers.clearTimeout(this[k]);
    try { this.agent?.close(); } catch { /* already gone */ }
    if (this.twilio.open?.()) this.twilio.close();
    const seconds = Math.round((this.now() - this.startedAt) / 1000);
    const turns = this.turns.map(t => ({ who: t.who, text: t.text })).filter(t => t.text);
    let recording = null;
    let recordingWhy = "";
    try {
      if (!this.recorded) recordingWhy = manner.NOT_RECORDED_WHY;
      else if (this.tape.seconds() >= 1) {
        const file = recordingFileFor(this.call.id, "wav");
        writeSealed(file, this.call.conversation_id, this.tape.wav());
        recording = { path: file, format: "wav", seconds: Math.round(this.tape.seconds()) };
      } else recordingWhy = "the line carried less than a second of audio";
    } catch (e) {
      recordingWhy = `the call audio could not be written: ${(e?.message ?? String(e)).split("\n")[0]}`;
    }
    const live = {
      state: this.ready || turns.some(t => t.who === "them") ? "completed" : "failed",
      outcome: "", summary: "",
      transcript: turns.map(t => `${t.who === "them" ? "Them" : "Reason"}: ${t.text}`).join("\n"),
      turns, durationS: seconds,
      costCents: Math.round((seconds / 60) * CENTS_PER_MINUTE),
      termination: this.endWhy === "caller hung up" ? "hung up" : this.endWhy === "goodbye" ? "end_call (mutual goodbye)" : this.endWhy,
      cutOff: null,
      costRaw: JSON.stringify({ voice: "cartesia", voice_seconds: seconds, cents_per_minute: CENTS_PER_MINUTE, first_voice_ms: this.m.firstVoiceMs }),
      recording, recordingWhy,
      ...(this.recorded ? {} : { notRecorded: true }),
    };
    try { db.updateCall(this.call.conversation_id, this.call.id, { first_audio_ms: this.m.firstVoiceMs ?? null }); } catch { /* a number never breaks a call */ }
    this.noteMinutes(false, seconds);
    const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    this.log({
      cartesia_call_ended: this.call.id, why: this.endWhy, seconds, cents: live.costCents, first_voice_ms: this.m.firstVoiceMs,
      replies: this.m.replies.length, plain_reply_ms: med(this.m.replies.filter(r => r.kind === "plain").map(r => r.ms)),
      ask_reply_ms: med(this.m.replies.filter(r => r.kind === "ask_reason").map(r => r.ms)),
      asks: this.m.asks.length, ask_answered_ms: med(this.m.asks.map(a => a.asked_to_answered_ms)),
      talked_over: this.m.overs.filter(o => o.playing).length, clears: this.m.overs.length,
      talked_over_ms: med(this.m.overs.filter(o => o.playing).map(o => o.sound_to_clear_ms)),
      asks_texted: this.m.asks.filter(a => a.to_text).length, laughs_written: this.m.laughs, unbacked_claims: this.m.unbacked,
      markers_spoken: this.m.markers, check_ins: this.m.checkIns, answers_unheard: this.m.unheard, answers_reoffered: this.m.reoffered, deferrals_said: this.m.deferredSaid,
    });
    // Their copy goes whatever the settle does; both are waited for, neither stops the other.
    const deleting = this.agentCallId ? this.deleteAndCheck().catch(() => null) : Promise.resolve(null);
    try { await this.finishCall(live); } catch (e) { this.log({ cartesia_settle_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
    await deleting;
  }
}
