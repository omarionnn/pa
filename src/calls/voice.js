// Reason's own brain, speaking: one spoken turn of a phone call. GPT-Live (src/calls/gptlive.js) is
// the voice on the line; every time it hands the turn to Reason (client delegation, `reasonTurn`
// there), this runs it in process — OpenAI Chat Completions shaped messages in, SSE-framed chunks
// (`data: {json}\n\n`, ending `data: [DONE]\n\n`) out, the same Reason that answers their texts.
// There is no HTTP route to it: only the voice's own relay calls it.
//
// Three things in this file are structural rather than instructions to a model, and each is here
// because asking nicely is not a guarantee:
//
//   1. **Which call this is, read from the database and not from the body.** The request says which
//      call it belongs to; the row says whose Reason that is and what kind of call it is. If the two
//      disagree the turn is refused, because the difference between them is the difference between a
//      restaurant hearing a goal and a restaurant hearing somebody's calendar.
//   2. **Two context builders, and the third-party one has no way to reach a thread.** It is not a
//      prompt that says "do not mention their messages" — `thirdPartyContext` never loads a
//      conversation, never loads memory, and returns an empty tool list. The isolation is what is
//      *built*, which is why the test for it asserts on the context rather than on a model's answer.
//   3. **A URL is never spoken.** Not a rule in the prompt (though it is there too): any web address
//      in what the model wrote is taken OUT of the spoken words and queued as a text, during the
//      call, so it has landed by the time they hang up. "h t t p s colon slash slash" is not a link
//      anybody can use, and a model that forgets that once has read a URL down a phone.
//
// On streaming. Text is emitted as it arrives, but held back to the end of a sentence before it goes
// — which is what makes rule 3 above possible at all, since a web address split across two deltas
// could not be found in either. A sentence is also the unit a speech engine wants, so the cost is
// nothing: the first chunk goes as soon as the first sentence is done rather than when the whole
// reply is.
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as harm from "../harm.js";
import { ledgerWrite } from "../trust.js";
import { config, clock, stamp } from "../config.js";
import { callRulesFor } from "./provider.js";
import { mannerFor } from "./manner.js";
import {
  VOICE_RULES, voiceRules, LANGUAGE_RULE, ownerLanguageRule, announcementAgainIn, ownerCallFrame, thirdPartyFrame, callIdentityFor,
} from "./voice-prompt.js";
import * as hold from "./hold.js";
import { WAITING_TOOLS, NEW_PERSON_TOOL, MACHINE_TOOL, WAITING_RULES } from "./hold.js";
import * as callOutcome from "./outcome.js";
import * as commit from "./commit.js";
import { PROPOSE_TOOL, CONFIRM_TOOL, RELEASE_TOOL } from "./commit.js";
import * as errand from "./errand.js";
import { QUOTE_TOOL } from "./errand.js";
import { briefLines, buildBrief, todaySoFarNote } from "./brief.js";
import { earlierCallsNote, CARRY_TURN_LINE } from "./carryover.js";
import { readBackInstruction, detail as readbackDetail, recordOf as recordOfDetails } from "./readback.js";
import * as verify from "./verify.js";
import { rulesNote } from "../rules.js";
import { whereaboutsNote, prepareCallMemory } from "./callmemory.js";
import { memoryHits } from "../memorynote.js";
import * as fromcall from "./fromcall.js";
import { profileNote } from "./profile.js";
import * as callMetrics from "./metrics.js";
import * as stranger from "./stranger.js";
import * as reviewed from "../reviewed.js";

/** The names Reason's own ids travel under in a turn's `extra_body`, so every turn knows which call it is. */
export const EXTRA_BODY_KEYS = { callId: "reason_call_id", conversationId: "reason_conversation_id", kind: "reason_kind" };

/** The two kinds of call. Which one a turn is comes off the call row, never off the request. */
export const CALL_KINDS = ["owner", "third_party"];

/**
 * The line's own tools, which Reason triggers by answering with a standard OpenAI function call
 * and which the voice relay (src/calls/gptlive.js `readTurn`) — not the turn — carries out.
 *
 * They are the reason a tool call has to be able to leave the turn at all rather than being
 * executed here like Reason's own.
 *
 * `transfer_to_agent` is deliberately absent: there is one Reason, and there is nobody to transfer to.
 */
export const SYSTEM_TOOL_NAMES = [
  "end_call", "language_detection",
  // Waiting, menus and machines (2026-10-07). See ./hold.js for which half is theirs and which ours.
  "skip_turn", "play_keypad_touch_tone", "voicemail_detection",
  // Handing the call to the owner himself. Hedged about heavily in `handOver` below, because their
  // docs are clear that a conference transfer removes the agent from the call — after it, Reason is
  // not on the line to fix anything.
  "transfer_to_number",
];

/** The shape they are offered in, when the platform did not send its own list. */
export const SYSTEM_TOOLS = [
  {
    name: "end_call",
    description: "Hang up. Call this once the call is finished — the answer is had, or they cannot help, or they asked you to go.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short phrase: why the call is over." },
        // Their documented optional argument: spoken by the platform, then the line goes. It is how
        // a voicemail is left — see `noteMachine` in ./hold.js.
        message: { type: "string", description: "Optional. Words spoken before the line goes — the whole of a voicemail goes here." },
      },
    },
  },
  {
    name: "language_detection",
    description: "The person on the line is speaking a different language from the one this call started in. Call this with their language, and write your reply in that language too.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", description: "Their language as a two-letter code: es, fr, de, pt, zh." },
        reason: { type: "string", description: "One short phrase: what they said that showed it." },
      },
      required: ["language"],
    },
  },
  // Waiting, menus and voicemail. Written in ./hold.js next to the state machine that reads them, so
  // the description a model sees and the code that enforces it are in the same file.
  ...WAITING_TOOLS,
  {
    name: "transfer_to_number",
    // Hedged hard on purpose. Their docs are clear that a conference transfer removes the agent from
    // the call, so this is the one tool here with no second attempt after it: once it fires, Reason is
    // off the line and cannot apologise, correct anything or finish the errand. `handOver` below
    // refuses it outright until the owner has actually said he is there.
    description: "Put this call through to the person you work for, in person. Only when they are genuinely needed"
      + " themselves — a decision only they can make, or the other person asking to speak to them directly."
      + " You will be stopped if they have not said they are free, and you must never tell the person on the"
      + " line that they are coming unless you have been told they are. Once this goes through you are off"
      + " the call and cannot say anything else, so say everything you need to say first.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why they are needed in person, in one phrase." },
        client_message: { type: "string", description: "What the person on the line hears as you hand over: 'let me put you through now'." },
      },
      required: ["reason"],
    },
  },
];

/**
 * Reason's own tools that exist only on a call, and that a THIRD-PARTY call has as well.
 *
 * Worth being careful about, because `reasonTools` being empty on a third-party call is a deliberate
 * safety property — a call to a restaurant with `calendar_add` on it is one prompt injection away from
 * a restaurant changing somebody's week. These are a different list, and they are safe for the same
 * reason the empty list was: none of them can touch the owner's thread, memory, calendar or files.
 * Each one only writes down something about the call it is already on, and the two that matter most
 * exist to STOP things happening: `propose_commitment` is how a call finds out it may not agree, and
 * `new_person_on_the_line` is how a disclosure gets repeated to somebody who has not heard it.
 */
// `machine_on_the_line` (2026-10-27) only writes down what answered and decides the hang-up on a dead end.
export const CALL_TOOLS = [NEW_PERSON_TOOL, MACHINE_TOOL, PROPOSE_TOOL, CONFIRM_TOOL, RELEASE_TOOL, QUOTE_TOOL];

/** Their names, for the dispatcher that runs them here instead of forwarding them to the platform. */
export const CALL_TOOL_NAMES = CALL_TOOLS.map(t => t.name);

/**
 * How many times one spoken turn may use a tool before it has to say something.
 *
 * Three, and low on purpose. This is a phone call: a person is holding a handset listening to
 * nothing. The ordinary text path allows far more rounds because nobody is waiting on the line, and
 * copying that number here would be how a call ends up with eleven seconds of silence in it.
 */
export const MAX_VOICE_TOOL_ROUNDS = 3;

/** The text path's silence marker (src/plain.js readSilence), however the model spelled it. Never spoken. */
// The underscore form in any case, or the two words in capitals. Not "no reply" in ordinary words:
// "she's sent no reply yet" is a real sentence about somebody's email.
export function withoutSilenceMarker(spoken) {
  const s = String(spoken ?? "");
  if (!/no_reply/i.test(s) && !/\bNO REPLY\b/.test(s)) return { text: s, had: false };
  const rest = s.replace(/[^\w]*no_reply[^\w]*/gi, " ").replace(/[^\w]*\bNO REPLY\b[^\w]*/g, " ").replace(/\s+/g, " ").trim();
  return { text: /[a-z0-9]/i.test(rest) ? rest : "", had: true };
}

/** Tools that end or hand over a turn: the line stays as it is, no "one sec" in front of them. */
/**
 * Tools that mean "nobody to talk to yet" — waiting, a key, a machine named, or a handover the model
 * is about to be told how to open. Words written in the same round as one of these were about the
 * line, not to anybody on it, and are not said while nobody has been heard (see `holdBack`).
 */
const QUIET_ON_A_MACHINE = new Set(["skip_turn", "play_keypad_touch_tone", "voicemail_detection", "machine_on_the_line", "new_person_on_the_line"]);

/** The first turn on a line that opened silent and has stayed silent. */
export const LINE_OPENED = `[The call has just connected and nothing has been heard from their side yet.]`;

/** A thing refused for the caller check, picked up by text after the call (verify_caller queued it). */
export const CHECK_LATER_LINE = "I'll text you to confirm that one — it'll be there as soon as we hang up.";
/** The same, when a passphrase is set and still has tries: the check is asked for out loud. */
export const CHECK_NOT_HERE_LINE = "Sure — just need your passphrase for that one first.";
const SILENT_TOOLS = new Set(["end_call", "skip_turn", "transfer_to_number", "voicemail_detection", "language_detection", "play_keypad_touch_tone", "machine_on_the_line"]);

/** The filler that buys thinking time before a tool, rather than dead air. Their own suggestion. */
export const THINKING_FILLER = "... ";
/** The one tool-start filler a call may say: "One sec..." — see `FILLER_AFTER_MS`. */
export const ONE_SEC = `One sec${THINKING_FILLER}`;

/**
 * How old a turn must be, with nothing said in it, before a tool start may say "One sec...".
 *
 * Call baseline (2026-10-30, 39 owner calls): 25 of the 26 "One sec..." were this code, said on every
 * tool start, and they arrived 4–15 s into the turn — after the model had already thought for seconds,
 * so they were filler, not a fast acknowledgement. 40 of 192 owner-call lines were filler. Now it goes
 * out only when nothing has been said this turn, the turn is at least this old, and it has not been
 * said on this call before. Otherwise a tool start says nothing extra.
 */
export const FILLER_AFTER_MS = 2_500;

/**
 * How long one of Reason's own tools may run on a call before the turn stops waiting for it.
 *
 * Call 30 (2026-10-17): "do the page for me on a Ghana one" had the model run `research` on the
 * line. It takes thirty to sixty seconds; the person heard "One sec..." and then nothing, said
 * "hello?" three times, and the platform closed the stream. The ordinary text path can wait a
 * minute for a tool because nobody is listening to it; a phone cannot. Past this, the tool keeps
 * running where it is, the model is told to hand the work to a task and say so, and talking resumes.
 */
export const CALL_TOOL_BUDGET_MS = 8_000;

/**
 * How long a turn may go with nothing said before it says something short to hold the line.
 *
 * Call 13 (2026-10-12): the platform waited ~24 seconds for the custom LLM's first words, got none,
 * and ended the call with "custom_llm_error: LLM Cascade Error: TimeoutError". A slow model start, a
 * cold CLI, a harm screen that has not answered — any of them is dead air, and dead air is how the
 * platform decides the LLM is gone. Past this, one brief acknowledgement goes out (never twice in a
 * turn) and the real reply follows it in the same stream.
 */
export const FIRST_WORD_DEADLINE_MS = 6_000;

/**
 * The late deadline: any later turn that reaches this long with nothing said gets the next of `LATE_LINES`.
 *
 * At 4 s the holding line would have fired on 24% of turns (36 of 148 had first_word > 4 s), making
 * it the new top filler, so it is said at most once per call, at `FIRST_WORD_DEADLINE_MS`. This is
 * the floor under every other turn. The agent's `cascade_timeout_seconds` is 15 s (live agent config,
 * 2026-10-30), counted from the request arriving; 9.5 s from that same moment leaves room for TTS and
 * the network before the platform gives up on the LLM and kills the call (call 13). (It was 9.5 s.)
 *
 * 7.5 s, not 9.5 s. Replaying the 15 timed owner calls (123 turns at their recorded latencies,
 * bin/call-filler-drive.mjs) through the #274 code: 11 turns sat silent past 8 s, 8 of them then
 * heard "Still working on it." — the same words again on the same call 5 times (calls 35 and 38).
 * At 7.5 s: 1 turn past 8 s (one on hold, where nothing is said by design), p95 silence 9.5 s → 7.5 s,
 * at the price of 3 more late lines on the turns that were silent 7.5–9.5 s.
 */
export const LATE_HOLDING_MS = 7_500;

/**
 * What is said at the late deadline. Short, and not the holding line again: a call that already
 * heard "one moment" should not hear it a second time. Not an apology and not a presence check.
 * A turn takes the next one in order, so a call never hears the same one twice running and none
 * again until all of them have been said (the replay's busiest call needed five).
 */
export const LATE_LINES = Object.freeze([
  "Still working on it.",
  "Still on it.",
  "Just a moment more.",
  "Hang on a second.",
  "Give me a moment.",
  "Still checking.",
]);
export const LATE_LINE = LATE_LINES[0];

/**
 * Which once-per-call lines a call has already said, by `conversation#call`. In memory: a restart
 * forgets it, and the worst that costs is one more "One sec..." or holding line on that call.
 */
const onceSaid = new Map();
const ONCE_SAID_KEEP = 500;
export function onceSaidFor(call) {
  // No call to key it on: this request's own record, kept nowhere, rather than one shared
  // "undefined#undefined" entry every such request would read.
  if (call?.id == null || call?.conversation_id == null) return { filler: false, holding: false, late: 0 };
  const key = `${call.conversation_id}#${call.id}`;
  let got = onceSaid.get(key);
  if (!got) {
    got = { filler: false, holding: false, late: 0 };
    onceSaid.set(key, got);
    if (onceSaid.size > ONCE_SAID_KEEP) onceSaid.delete(onceSaid.keys().next().value);
  }
  return got;
}

/**
 * What is said at that deadline. An acknowledgement, not an apology and not a check that they are
 * still there: they have just spoken, and the honest thing to say is that it was heard.
 */
export const HOLDING_LINE = "Mm-hm, one moment.";

/**
 * A turn that ends having said nothing of its own (after anything already said, so leading space).
 *
 * None of the code's own lines open with "Sorry" any more: in the stored owner calls 4 of the 14
 * apologies were the code's (BROKE_FIRST), and an apology adds nothing a caller can use. Not a late
 * line either: after "Still on it." the turn has to close the promise, not stall a second time.
 */
const NOTHING_SAID_AFTER = " Let me come back to you on that one.";
// The turn's other canned lines, named so the turn meter (src/calls/metrics.js) can tell them from the
// model's own words: "first real content" is the first thing said that was not one of these.
const COME_BACK_LATER = "Let me come back to you on that one.";
const COME_BACK_CHECK = "Let me check on that and come back to you.";
const COME_BACK_LOOK = "Let me look into that and come back to you.";
/**
 * Asked out loud when the turn has nothing to say where they are: get_location knew nothing (no live
 * share, no recent pin, no saved place) and the weather or a nearby search needed it. Drive 11-08 (OVH,
 * no saved places): 1 turn in 3 went round get_location → weather → get_location until it ran out of
 * rounds and said "let me come back to you" — no weather and no question. Code asks instead, so a
 * turn with nowhere to go always ends on the one question that unblocks it. Exported for the tests.
 */
export const WHERE_ASK = "Where are you right now? A neighbourhood or a cross street is enough.";
// The reads that need a position. A turn that already learned none is known asks the question instead
// of calling these again without coordinates.
const NEEDS_WHERE = new Set(["get_location", "weather", "nearby_places"]);
/** True when a result says where they are is not known (exported for the tests). */
export function whereUnknownIn(name, out) {
  if (name === "get_location") return out?.ok === false || (out?.source === "none" && !out?.requested);
  if (name === "weather") return out?.ok === false && /coordinates or a saved place|No saved place/i.test(String(out?.error ?? ""));
  return false;
}
/** A call to one of those with nothing new to go on: no coordinates, no saved place, not a card request. */
const blindWhereCall = (t) => NEEDS_WHERE.has(String(t.name))
  && t.input?.action !== "request"
  && !(Number.isFinite(t.input?.latitude) && Number.isFinite(t.input?.longitude))
  && !t.input?.place && !t.input?.near && !t.input?.address;
const BROKE_MID = "Something broke on my end there.";
const BROKE_FIRST = "Something broke on my end. Say that again?";
/**
 * What the turn meter counts as not-yet-real content. Exported for the tests. The fillers are matched
 * exactly, trailing space and all: the code's "... " is filler, while a model piece of just "..." has
 * been trimmed by the splitter and is the model's own dead air (kind "dots"), not filler.
 */
export const METER_KINDS = {
  holdingLine: HOLDING_LINE,
  holdingLines: [HOLDING_LINE, ...LATE_LINES],
  fillers: [THINKING_FILLER, ONE_SEC],
  fallbacks: [NOTHING_SAID_AFTER, COME_BACK_LATER, COME_BACK_CHECK, COME_BACK_LOOK, BROKE_MID, BROKE_FIRST],
};

/**
 * The messages a turn sends ALWAYS end on the other side's words.
 *
 * The platform sometimes asks for a reply with nothing new from the person: after it has closed a
 * stream it gave up waiting on, or when the line has been quiet. The history it sends then ends on
 * Reason's own last words — and the call model refuses a request that ends on an assistant message
 * ("does not support assistant message prefill", `claude-sonnet-5-5`, 400). On call 30 that was
 * eight refusals in ninety seconds, each spoken as "sorry, something broke on my end". So the model
 * is handed the turn explicitly, in a user line it can act on, rather than a request it cannot take.
 */
export const LINE_IS_QUIET = `[The line is quiet — they have not said anything new since your last words, and the turn is yours.`
  + ` If there is a task you were in the middle of, carry on with it in one short sentence. Do not repeat what you already said,`
  + ` and never ask whether they are there or can hear you.`
  + ` Otherwise stay quiet: call skip_turn and wait — never write NO_REPLY.]`;

/**
 * Their own call: a "let me think" the voice said is a promise (call 68, 2026-11-01: it said "Hmm. Lemme
 * have a think.", this turn skipped, and the line sat silent until he said "Hello").
 */
export const OWN_LINE_IS_QUIET = `[The line is quiet — they have not said anything new since your last words, and the turn is yours.`
  + ` If your last words told them you were thinking it over or checking something, follow through now: one or two short`
  + ` sentences — your take, or the question handed back to them. Never leave a "let me think" hanging.`
  + ` If there is a task you were in the middle of, carry on with it in one short sentence. Do not repeat what you already said,`
  + ` and never ask whether they are there or can hear you.`
  + ` Otherwise stay quiet: call skip_turn and wait — never write NO_REPLY.]`;

export function endOnTheirSide(messages = [], { own = false } = {}) {
  const out = [...messages];
  if (out.length && out.at(-1)?.role === "assistant") out.push({ role: "user", content: own ? OWN_LINE_IS_QUIET : LINE_IS_QUIET });
  return out;
}

/**
 * One tool run, as the call's record keeps it: when, what was asked, and the head of what came back.
 * Short, because every later turn of the call carries all of them in front of the first word.
 */
export function lookupEntry({ name, input = {}, out, at = clock.now() }) {
  return {
    at,
    name,
    input: JSON.stringify(input ?? {}).slice(0, 200),
    ok: out?.ok !== false,
    got: JSON.stringify(out ?? null).slice(0, 600),
  };
}

/**
 * The call's record of what Reason looked up, in front of the newest thing they said.
 *
 * The platform sends each turn back as spoken words only — the tool calls and their results are gone
 * by the next turn. On call 41 (2026-10-23) Reason searched, read a real Kitco gold price out, and one
 * turn later, seeing its own number with no search behind it, told him it had never looked and not to
 * trust it. This puts the searches back where the next turn can see them.
 */
export function withCallRecord(messages = [], lookups = []) {
  if (!lookups.length || !messages.length || messages.at(-1)?.role !== "user") return messages;
  const lines = lookups.map(l => `- ${stamp(l.at)} ${l.name} ${l.input}${l.ok ? "" : " (failed)"} → ${l.got}`);
  const record = `[Your own record of this call, kept by code — not something they said, and not something to mention.`
    + ` Every lookup you have really run on this call, with the head of what came back:\n${lines.join("\n")}]`;
  const last = messages.at(-1);
  const theirs = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  return [...messages.slice(0, -1), { role: "user", content: [{ type: "text", text: record }, ...theirs] }];
}

// ---------- which call is this ----------

/**
 * The call row this turn belongs to.
 *
 * The voice relay puts Reason's own ids into every turn's `extra_body` (`reasonTurn` in ./gptlive.js),
 * both directions: the row is written before the stream opens. Both ids are required and the row has
 * to match both — an id without its conversation would be a call id anybody could count up to. A
 * turn carrying only the voice's external call id is looked up by that instead.
 *
 * `kind` comes off the ROW (`is_owner`), never off the body. The body's `reason_kind` is read only to
 * disagree with: a request that says third-party about a row that is an owner call, or the other way
 * round, is refused. One of those two is somebody's private thread read out to a stranger and the
 * other is Reason going mute on its own person, and neither should be reachable by editing a field.
 */
export function identifyCall(body, { provider = "gptlive" } = {}) {
  const extra = (body?.extra_body ?? {}) || {};
  const callId = Number(extra[EXTRA_BODY_KEYS.callId]);
  const conversationId = String(extra[EXTRA_BODY_KEYS.conversationId] ?? "").trim();
  const saidKind = String(extra[EXTRA_BODY_KEYS.kind] ?? "").trim();

  let call = null;
  if (Number.isInteger(callId) && callId > 0 && conversationId) {
    call = db.getCall(conversationId, callId);
    if (!call) return { ok: false, why: `there is no call #${callId} on ${conversationId}` };
  } else {
    // No ids of Reason's. GPT-Live always sends them (`reasonTurn`), so no caller in the code takes this
    // branch today; it is kept so a turn carrying only the voice's external call id (`gptlive:<CallSid>`)
    // is still matched to its row rather than refused, and is pinned in test/call-voice.test.js.
    const external = [
      body?.conversation_id, body?.conversationId,
    ].map(v => (v == null ? "" : String(v).trim())).find(Boolean);
    if (!external) return { ok: false, why: "the request carries neither Reason's own call ids nor a conversation id to look one up by" };
    call = db.callByExternalId(provider, external);
    if (!call) return { ok: false, why: `no call of Reason's is open under conversation ${external}` };
  }

  const kind = call.is_owner ? "owner" : "third_party";
  if (saidKind && CALL_KINDS.includes(saidKind) && saidKind !== kind) {
    return { ok: false, why: `the request says this is a ${saidKind} call and call #${call.id} is a ${kind} call` };
  }
  // A call that is already over does not get more turns. A late delivery is a late delivery; a model
  // turn charged to a call that hung up ten minutes ago is money spent on nobody listening.
  if (["completed", "failed", "no_answer", "busy", "declined", "voicemail"].includes(call.state)) {
    return { ok: false, why: `call #${call.id} is already ${call.state}` };
  }
  return { ok: true, call, kind };
}

// ---------- what language the call is in ----------

/**
 * What language this call is in, and which languages its recorded-call disclosure has been spoken
 * in. Both off the call row, so they are deleted with the call and readable on it afterwards.
 */
export function callLanguage(call) {
  const announced = String(call?.language_announced ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return { language: String(call?.language ?? ""), announcedIn: announced };
}

/**
 * Write down that the call has moved to another language.
 *
 * Only the language. Whether the recorded-call disclosure has been said again in it is a separate
 * fact written at a separate moment — see `announcementOwedIn` — because the two happen one turn
 * apart: the switch happens on the turn the model hears Spanish, and the disclosure can only be
 * asked for on the turn AFTER that, which is the first one whose prompt can carry the instruction.
 */
export function noteCallLanguage(call, language) {
  const lang = String(language ?? "").trim();
  if (!lang) return callLanguage(call);
  db.updateCall(call.conversation_id, call.id, { language: lang });
  return { language: lang, announcedIn: callLanguage(call).announcedIn };
}

/**
 * Does the recorded-call disclosure still owe being said in the language this call has moved to? And
 * if so, write down that it has now been asked for.
 *
 * The disclosure is the whole point of tracking the language. The announcement is spoken in whatever
 * language the call opened in; if the call then moves to Spanish, the only language the person has
 * heard "this call is recorded" in may be one they do not speak, and that is not a disclosure.
 *
 * It writes as it reads, deliberately: "owed" and "asked for" have to be one statement or two turns
 * arriving together would both be told to say it, and a call that drifts between two languages would
 * recite it every other sentence. What is NOT claimed is that the model obeyed — that is unverifiable
 * from here and is in docs/unverified.md. What is claimed is that it was asked exactly once.
 *
 * Called by the third-party context builder only. Nothing about recording is ever recited at the
 * person who set Reason up, in any language; they were told once by text (src/calls/inbound.js).
 */
export function announcementOwedIn(call) {
  const { language, announcedIn } = callLanguage(call);
  if (!language || announcedIn.includes(language)) return "";
  db.updateCall(call.conversation_id, call.id, { language_announced: [...announcedIn, language].join(",") });
  return language;
}

// ---------- the two context builders ----------

/**
 * An OWNER call: their own Reason, with everything it has in a text thread.
 *
 * The person's normal system prompt, their open work, what Reason has made and kept for them, the
 * recent turns of their actual conversation, and their ordinary tools. The confirm gate is untouched
 * — `confirm_request` and `confirm_record` are in the tool list like any other, so a spoken yes is
 * read by the same judge and recorded on the same row as a typed one, and nothing about a call
 * weakens it.
 *
 * The opening line matters more here than anywhere else in this file. The greeting itself is code
 * (see `openingLineFor` in inbound.js); the model's job is to listen and let the caller lead.
 */
/** The owner's profile, as a text turn is shown it, or "" when there is none. */
export function ownerProfileNote(conversationId) {
  try {
    const block = db.getProfile(conversationId)?.block;
    return block ? `WHAT YOU KNOW ABOUT THEM (from past conversations — some inferred, treat those with less certainty; where two disagree, the later date wins):\n${block}` : "";
  } catch {
    return "";
  }
}

/** Why Reason rang them, for a call it placed. "" on a call they made, or one with no goal on the row. */
export function scheduledCallNote(call) {
  if (!call || call.direction === "in" || !call.timer_id) return "";
  const why = String(call.goal ?? "").trim();
  if (!why) return "";
  return `YOU rang THEM, at a time they asked for, and the call opened by saying why: "${why}".`
    + ` That is what this call is for — stay on it (a wake-up call checks they are actually up; a nudge to leave asks if they are leaving)`
    + ` until they say they are good or move on to something else, and do not ask what they called about: they did not call.`
    + ` Keep it short; they asked for a ring, not a conversation.`;
}

/**
 * Why Reason rang them, and what it already has for it, for a call it placed that no timer asked for
 * (call 67, 2026-11-01: the backend spent 19 s finding the photos the call was about). The goal and
 * facts off the row, and the photos they sent around then with what was seen in each and its id.
 */
export function placedCallNote(call) {
  if (!call || call.direction === "in" || call.timer_id || !Number(call.is_owner)) return "";
  const why = String(call.goal ?? "").trim();
  if (!why) return "";
  const facts = Array.isArray(call.facts) ? call.facts : (() => { try { return JSON.parse(call.facts ?? "[]"); } catch { return []; } })();
  let photos = "";
  try { photos = reviewed.recentPhotosNote(call.conversation_id, { since: Number(call.created_at ?? clock.now()) - 2 * 60 * 60_000 }); } catch { /* no note */ }
  return `YOU rang THEM, and this is why: "${why}". Lead with it and stay on it until they move on — do not ask what they called about: they did not call.`
    + (facts.length ? `\nWhat you already have for it:\n${facts.map(f => `- ${f}`).join("\n")}` : "")
    + (photos ? `\nThe ${photos}` : "");
}

export function ownerContext({ call, callMessages = [], now = clock.now() }) {
  const conversationId = call.conversation_id;
  const me = accounts.ownerOf(conversationId);
  const { systemFor } = contextDeps;

  const lang = callLanguage(call);
  const earlier = earlierCallsNote(call);
  const parts = [
    // `onCall`: the text-thread rules (src/threading.js) are about bubbles and pins, not a call.
    systemFor({ ...me, onCall: true }),
    `--- you are ON A PHONE CALL right now, not texting ---`,
    voiceRules({ manner: mannerFor(conversationId) }),
    ownerLanguageRule(lang.language || "en"),
    ownerCallFrame({ name: me.name, identity: callIdentityFor(conversationId), manner: mannerFor(conversationId) }),
    // A call REASON placed to them — scheduled ("call me at 7 to get me up") or asked for by text —
    // has a reason, and the model answering the turns must know it: a wake-up call whose second
    // line is "what's up?" is Reason forgetting why it rang. The opening line already said it.
    scheduledCallNote(call),
    placedCallNote(call),
    // The half of the turn profile the model is responsible for: telling a pause for thought from a
    // finished turn (2026-10-07 addendum, section 4). The numbers in that profile are agent-level
    // settings on the platform and nothing a prompt can act on; this sentence is the part that is.
    profileNote("owner"),
    // Who is on the line is not settled by the number it came from (section 6). Said here, in the
    // owner's own frame, because the gate in `voiceTurn` refusing a tool reads much better when the
    // model already knew the rule than when it is learning it from a refusal.
    verify.promptNote({ call }),
    contextDeps.openWorkNote(conversationId),
    contextDeps.keptNote(conversationId),
    // What they have really bought, read from the database — a call must not say "it's ordered"
    // about an order since cancelled any more than a text may (src/purchasesnote.js).
    contextDeps.purchasesNote(conversationId),
    // What Reason knows about them (src/extract.js rebuildProfile) — the same profile a text turn
    // is shown (src/memorynote.js). A call had none of it until 2026-10-19, so "what did we say
    // about my Gmail" worked by text and drew a blank on the phone. Profile only, no per-turn
    // search: it is one row read, and a phone turn pays for every millisecond before the first
    // word. Nothing new is exposed by it — this frame already carries their recent thread.
    ownerProfileNote(conversationId),
    // How they want to be treated (src/rules.js), read fresh each turn — call 80's own rule, "on a call,
    // just say the answer out loud", was saved after it and no call turn had ever been shown one.
    rulesNote(conversationId),
    // Their saved places and what they told you about their week (./callmemory.js), so "where I'm at"
    // on a shift day is work, not "I can't tell if you're home or elsewhere" (call 80).
    whereaboutsNote(call),
    // What happened between them today, before this call (call 79: its own pick by text, three hours
    // earlier, was "nothing saved" on the phone). Up to when the call was made, so every turn of the
    // call sends the same prefix and the prompt cache holds.
    todaySoFarNote(conversationId, { until: Number(call.created_at) || now, call: call.id }),
    // Their own earlier calls: a call is written to the thread one line per fragment and this turn
    // reads only its newest few, so the morning's call is gone by the afternoon (call 85 -> 86).
    ...(earlier ? [earlier, CARRY_TURN_LINE] : []),
  ];
  return {
    kind: "owner",
    conversationId,
    system: parts.filter(p => String(p ?? "").trim()).join("\n\n"),
    // The person's own thread, then what has been said on this call. Trimmed, because a phone turn
    // pays for every token in the gap before the first word.
    messages: [...threadMessages(conversationId), ...fromOpenAI(callMessages)],
    // Every tool they have in a text. This is the whole point of a call being their Reason rather
    // than a voice in front of it.
    reasonTools: contextDeps.toolsFor(conversationId),
    // The owner's own call gets the waiting tools through `systemTools` — "hold on a second" happens on
    // a call with a person you know too — but not the commitment or quote tools: there is nobody to
    // negotiate with and nothing to compare. A commitment on the owner's behalf goes through the
    // ordinary confirm gate, which is already in `reasonTools`.
    //
    // Two things here are the owner's alone and must never appear on a third-party call. `VERIFY_TOOL`
    // is how the person on the line proves they are holding his phone; offering it to a restaurant
    // would be offering a restaurant a way to try passphrases. `FROM_CALL_TOOLS` is "ring them for
    // me", and a business line that could ask Reason to place calls is a business line that could
    // make Reason dial anybody.
    callTools: [NEW_PERSON_TOOL, verify.VERIFY_TOOL, ...fromcall.FROM_CALL_TOOLS],
    systemTools: SYSTEM_TOOLS,
    language: lang.language,
  };
}

/**
 * A THIRD-PARTY call: the goal, the approved facts, the standing rules, and nothing else at all.
 *
 * Read what this function does NOT do. It does not call `threadMessages`. It does not call
 * `toolsFor`. It does not touch memory, tasks, pages, the calendar or the ledger. There is nothing
 * in the returned context that could carry a word of the owner's conversation, because nothing in
 * here ever goes and gets one. That is what "enforced by what is built, not by asking the model"
 * means, and it is why the test for it reads the context rather than reading a model's answer.
 *
 * `reasonTools` is empty for the same reason. A call to a restaurant with `calendar_add` on it is one
 * prompt injection away from a restaurant changing somebody's week.
 */
export function thirdPartyContext({ call, callMessages = [], now = clock.now() }) {
  const ownerName = accounts.ownerOf(call.conversation_id).name;
  const facts = Array.isArray(call.facts) ? call.facts : [];
  // The language the disclosure still owes being said in, claimed as it is read so it is asked for
  // exactly once. Empty on a call that never changed language, which is almost all of them.
  const owed = announcementOwedIn(call);
  // What this call may agree to, and the questions it has to come back with. Off the row, so a call
  // placed an hour ago is still held to the brief it was placed under rather than to a default.
  const brief = callBrief(call);
  // Nobody has been told who is calling yet, because the line opened silent (see `place` in
  // ./gptlive.js). Read once here so the prompt and `voiceTurn` agree on it for this turn.
  const openingOwed = hold.openingOwed(call);

  const parts = [
    thirdPartyFrame({
      identity: callIdentityFor(call.conversation_id),
      ownerName,
      goal: brief.goal || call.goal,
      facts,
      // Rebuilt rather than read off the row: the rules are the terms of every call and they are
      // built in code in exactly one place (src/calls/provider.js), so a row written by an older
      // version cannot be a call with weaker rules on it.
      rules: callRulesFor({ ownerName }),
      announcement: call.announcement ?? "",
      openingOwed,
      manner: mannerFor(call.conversation_id),
      // Code stops the recording on an objection only on a GPT-Live business call that talks (./gptlive.js).
      recordingOff: call.provider === "gptlive" && !!config.lineTalk && call.direction !== "in",
    }),
    `--- you are ON A PHONE CALL right now ---`,
    // The own-call swaps (task_start, "my bad", texting them) are not for a business (cold review 11-11).
    VOICE_RULES,
    LANGUAGE_RULE,
    // What it may and may not agree to, the questions it owes, and everything it would otherwise have
    // to go back and ask the owner for once somebody finally answers.
    briefLines(brief, { ownerName }),
    // Hold, menus, machines, and somebody different coming on the line.
    WAITING_RULES,
    // A business line is slower than a person's phone (2026-10-07 addendum, section 4). The patient
    // half of the turn profile, as the one sentence a model can act on.
    profileNote("third_party"),
    readBackRule(brief, { ownerName }),
    // How long it has already been waiting, when it has. The model cannot count minutes; code can.
    hold.waitingNote(call, { now }),
    // The recorded-call disclosure, again, in the language the call has just moved to. Once per
    // language, and only when it has moved at all.
    owed ? announcementAgainIn(owed, { ownerName }) : "",
  ];

  return {
    kind: "third_party",
    conversationId: call.conversation_id,
    system: parts.filter(p => String(p ?? "").trim()).join("\n\n"),
    // The call and nothing but the call.
    messages: fromOpenAI(callMessages),
    // Still empty of the ORDINARY tool registry, which is the safety property this context is built
    // around. `callTools` is a separate list that cannot reach the thread, memory, the calendar or a
    // file — see CALL_TOOLS above — and two of the five exist to stop things rather than do them.
    reasonTools: [],
    callTools: CALL_TOOLS,
    systemTools: SYSTEM_TOOLS,
    language: callLanguage(call).language,
    brief,
    // Until a person has been heard, nothing the model writes is spoken as it streams — see the
    // hold-back in `voiceTurn`.
    openingOwed,
    machineOnLine: callOutcome.onAMachine(call),
  };
}

/**
 * The brief a call was placed under.
 *
 * Falls back to a brief built from the goal and facts on the row, so a call placed by an older version
 * of the code — or by a path that has not been taught about briefs — gets the cautious default rather
 * than no brief at all. The cautious default is `book: false`: a call whose permissions nobody can find
 * is a call that may ask and may not agree.
 */
export function callBrief(call) {
  try {
    const b = JSON.parse(call?.brief ?? "{}");
    if (b && typeof b === "object" && b.goal) return b;
  } catch { /* an unreadable brief is the same as none: fall through to the cautious one */ }
  return buildBrief({ goal: call?.goal ?? "", facts: Array.isArray(call?.facts) ? call.facts : [] });
}

/**
 * The read-back rule, named to the details this particular call has to settle.
 *
 * The owner's "'Tuesday at 3' is not settled until the actual date and time zone are clear" as an
 * instruction. The exact wording of each value is not in here — it is built from the real values by
 * `readBackInstruction` at the moment a commitment is proposed, because that is the only point at
 * which the values exist.
 */
function readBackRule(brief, { ownerName }) {
  const kinds = Array.isArray(brief?.readBack) ? brief.readBack : [];
  const lines = [
    `Before you agree to ANYTHING — a booking, a time, a price, a slot — call propose_commitment first,`
    + ` every time, and do what it tells you. Asking them what they have available does not need it.`,
  ];
  if (kinds.length) {
    lines.push(
      `Nothing counts as settled until you have read these back to them and they have said yes:`
      + ` ${kinds.join(", ")}. A day without a date is not settled, and a time without a time zone is not`
      + ` settled — "Tuesday at three" is not an agreement until you both know which Tuesday and which three.`,
    );
  }
  lines.push(
    `If you do not catch something that matters — a price, a date, a reference, a name — say so and ask`
    + ` them to repeat it, and ask them to spell it if it has letters or numbers in it. Never guess at it,`
    + ` and never read back something you are not sure you heard.`,
    `Ask for a confirmation number before you finish, and read it back to them spelled out.`,
    `Everything worth keeping is texted to ${ownerName} afterwards for you, so you do not have to`
    + ` promise to send anything yourself.`,
  );
  return lines.join(" ");
}

/**
 * The right builder for this call, chosen by the row.
 *
 * One function so there is one place where that choice is made, and it is made from `is_owner` on a
 * database row rather than from anything in a request body.
 */
export function contextFor({ call, kind, callMessages = [], now = clock.now() }) {
  return kind === "owner"
    ? ownerContext({ call, callMessages, now })
    : thirdPartyContext({ call, callMessages, now });
}

/**
 * The context for a call whose context could not be built (2026-10-07 addendum, sections 7 and 9).
 *
 * Section 7 is explicit about the failure mode to avoid: "if context cannot load, say so. Offer a
 * safe retry or plain general conversation — never pretend to remember. Silence or a confident guess
 * is the failure mode to avoid." Before this existed, a database that would not answer or a module
 * that would not import threw out of `llmRequest`, the request 500'd, and the platform got nothing —
 * which on a phone is the one thing worse than a bad answer: dead air, from a line that has already
 * said hello.
 *
 * So the turn still happens, with everything that needs the missing context taken away rather than
 * faked. No thread, no memory, no opening built from his week, and — the half that matters for
 * section 9 — NO TOOLS. That is what "keeps the same safety boundaries" means here: a turn that
 * cannot read what it is allowed to do does not get to do anything. It cannot book, cannot send,
 * cannot agree to a thing, and cannot invent a commitment, because none of those are on the table.
 * It can talk, and it can tell him the truth about why it is only talking.
 *
 * A THIRD-PARTY call gets no degraded turn at all, and that is deliberate: its context IS the brief,
 * the approved facts and what it may agree to. A call to a restaurant with none of that loaded has
 * nothing it is safe to say, so the caller hangs it up with one honest line instead.
 */
export function degradedContext({ call, callMessages = [], why = "" } = {}) {
  const name = (() => {
    // Even the owner's name comes from a lookup that may be the thing that is broken.
    try { return accounts.ownerOf(call.conversation_id)?.name ?? ""; } catch { return ""; }
  })();
  return {
    kind: "owner",
    degraded: true,
    why: String(why || "context could not be loaded"),
    conversationId: call.conversation_id,
    system: [
      `You are Reason, and you are on a phone call with ${name || "the person you work for"} right now.`,
      VOICE_RULES,
      `--- something is wrong on your end, and they need telling ---`,
      `You cannot reach any of your own context for this call: not this conversation, not what they have told you`,
      `before, not their calendar, their jobs, their messages or their files. You also have NO tools on this turn,`,
      `so there is nothing you can look up, send, book, change or agree to.`,
      ``,
      `Say that plainly, in one or two sentences, early — "something's broken on my end, I can't get to any of`,
      `your stuff right now" — and then offer the two things that are actually true: they can ring back in a`,
      `minute and it will probably be working, or they can talk to you about anything that does not need it.`,
      ``,
      `What you must NOT do: pretend to remember anything, guess at what they have going on, say you will do`,
      `something or send something or look something up, or agree to anything at all. You cannot do any of it`,
      `and saying you will is the worst answer available. If they ask you to do something, say you cannot do it`,
      `right now and why, and that it is not lost — ask them to text it or ring back.`,
    ].join("\n"),
    // Their words on this call and nothing else. There is no thread to prepend, which is the point.
    messages: fromOpenAI(callMessages),
    reasonTools: [],
    callTools: [],
    // Hanging up is left on. A call that cannot do anything should be able to end politely.
    systemTools: SYSTEM_TOOLS.filter(t => t.name === "end_call" || t.name === "language_detection"),
    language: "en",
  };
}

// ---------- turning their messages into ours, and back ----------

/**
 * The person's own thread as model messages, newest `config.callHistoryTurns` of them.
 *
 * The stored history is already in the Messages API's shape, so this is a slice and a flattening of
 * anything that was stored as blocks: a picture they sent last week is not something a phone turn
 * can do anything with, and carrying it would cost first-word latency for nothing.
 */
export function threadMessages(conversationId, { limit = config.callHistoryTurns } = {}) {
  const out = [];
  for (const m of db.loadConversation(conversationId).slice(-Math.max(2, limit * 2))) {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ").trim()
        : "";
    if (!text) continue;
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
  }
  // The model's first message has to be a user one, and a thread that happens to start on a reply
  // would otherwise be a request the API refuses.
  while (out.length && out[0].role === "assistant") out.shift();
  return out.slice(-limit);
}

/**
 * The call so far, as the voice relay hands it over, turned into model messages.
 *
 * The turn carries OpenAI-shaped `messages`. A system message in it is dropped on purpose: the
 * system prompt for this turn is Reason's, built above, and nothing on the line gets to edit it.
 */
export function fromOpenAI(messages = []) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = String(m?.role ?? "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const text = typeof m?.content === "string"
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map(b => (typeof b === "string" ? b : String(b?.text ?? ""))).join(" ")
        : "";
    if (!text.trim()) continue;
    out.push({ role, content: text.trim() });
  }
  return out;
}

// ---------- the SSE they expect ----------

/** One `data: {json}\n\n` chunk of an OpenAI chat completion stream. */
export function sseChunk({ id, model = "reason", created, delta = {}, finish = null }) {
  const body = {
    id,
    object: "chat.completion.chunk",
    created: created ?? Math.floor(clock.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

/** The end of the stream, exactly as their docs give it. */
export const SSE_DONE = "data: [DONE]\n\n";

// ---------- never say a URL out loud ----------

/**
 * Anything that is a web address. Deliberately generous, in three alternatives: a scheme or a www,
 * then anything with a slash and a path in it whatever its top-level domain, then a bare host on the
 * handful of domains people say out loud.
 *
 * The middle one is the alternative that matters and the reason the list of endings is not the whole
 * pattern: `reason.example/p/abc123` has no ending anybody would have thought to list, and a voice
 * reading it down a phone at somebody holding a pen is exactly what this exists to stop. Err towards
 * treating a thing as a link — the cost is a texted line nobody needed.
 *
 * A bare host with no path still needs a known ending, because "I'll check and come back.Then we..."
 * would otherwise be a web address.
 */
const URLISH = new RegExp([
  // A scheme, or a www. Anything after it is part of the address.
  String.raw`\b(?:https?:\/\/|www\.)[^\s<>"')\]]+`,
  // host.anything/path — the ending is not guessed at, because the slash is already proof.
  String.raw`\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s<>"')\]]*`,
  // A bare host, on an ending people really say.
  String.raw`\b[a-z0-9][a-z0-9-]*\.(?:com|org|net|io|co|app|dev|me|ai|gov|edu)\b`,
].join("|"), "gi");

/**
 * Take the links out of what is about to be spoken, and say they are being texted instead.
 *
 * Returns the words to speak and the links to send. The caller queues the text (see `queueMidCall`),
 * which is what makes "I'll text you that" true at the moment it is said rather than a thing Reason
 * has to remember to do after hanging up.
 */
export function withoutSpokenLinks(text) {
  const links = [];
  const spoken = String(text ?? "").replace(URLISH, (m) => {
    // A bare sentence-ending period belongs to the sentence, not to the address.
    const link = m.replace(/[.,;:!?]+$/, "");
    const tail = m.slice(link.length);
    if (!links.includes(link)) links.push(link);
    return `the link — I'm texting it to you now${tail}`;
  });
  return { spoken: spoken.replace(/\s{2,}/g, " ").trim(), links };
}

/**
 * Put one message in the outbox during the call.
 *
 * Queued rather than sent inline on purpose: this is running inside a turn a person is waiting on
 * mid-sentence, and a channel that takes two seconds to answer must not be two seconds of silence on
 * the phone. The runtime's outbox pass picks it up within its tick, which is well inside the call.
 *
 * It always goes to the OWNER of the conversation the call belongs to, never to whoever is on the line.
 * On an owner call that is the person holding the handset, which is how "I'm texting it to you now"
 * works. On a third-party call it is the person the call is being made FOR, who is somewhere else
 * entirely — and that is the path a paused commitment uses to ask him about a fee nobody approved
 * while a restaurant waits on the line (see `./commit.js`).
 */
export function queueMidCall({ call, text, kind = "link", log = () => {} }) {
  if (!String(text ?? "").trim()) return { ok: false, why: "nothing to send" };
  const who = db.getAccount(call.conversation_id);
  const address = who?.address && who.address !== "console" ? who.address : "";
  const channel = who?.channel && who.channel !== "console" ? who.channel : "";
  if (!address || !channel) {
    log({ call_midcall_text_nowhere: call.id, why: "no channel or address on this conversation" });
    return { ok: false, why: "there is no texting channel for this conversation" };
  }
  const { fresh, row } = db.enqueueOutbound({
    // One row per call per thing, so a turn that is retried by the platform does not text twice.
    idemKey: `call:${call.id}:${kind}:${hashOf(text)}`,
    conversationId: call.conversation_id,
    channel, address, body: String(text), toOwner: true,
    maxAttempts: config.outboxMaxAttempts,
  });
  log({ call_midcall_text: call.id, outbox: row.id, fresh });
  return { ok: true, outbox_id: row.id, fresh };
}

/**
 * Reason's own call-side tools, run here rather than forwarded to the platform.
 *
 * Every one of them answers in the same shape: `say`, which is the instruction fed back into the next
 * round so the model's own next sentence is the right one. That is the pattern the whole file already
 * uses for tool results, and it is why "do not agree to that" ends up being spoken as a natural
 * sentence rather than as a canned string bolted onto the stream.
 *
 * Nothing in the list a THIRD-PARTY call is offered can reach the owner's thread, memory, calendar or
 * files, which is what makes it safe to offer where `reasonTools` is deliberately empty. The four at
 * the bottom of the switch are the owner's own and are guarded twice: by the context that did not
 * offer them, and by an `is_owner` check on each one here.
 *
 * Returns a result or a promise of one — `make_a_call_for_me` is async, because authorizing a dial
 * runs the real `call_place`. Callers await.
 */
export function runCallTool(name, input = {}, { call, context, log = () => {}, turnState = {} } = {}) {
  const brief = context?.brief ?? callBrief(call);
  const tell = (text) => queueMidCall({ call, text, kind: "call_decision", log }).ok === true;

  switch (name) {
    case "new_person_on_the_line": {
      // Once per turn, and this took a rehearsal to find. When a receptionist finally answered after a
      // long hold, the model called this, was handed the instruction to introduce itself, and then
      // called it AGAIN instead of speaking — three times in one turn. Each call counted another person,
      // so a call with two humans on it recorded four; and the rounds it burned meant the turn ended on
      // the out-of-rounds line, so the new person got "let me check on that and come back to you"
      // instead of being told they were talking to an AI on a recorded call. The announcement being
      // skipped is the serious half of that.
      if (turnState.newPerson) {
        log({ call_new_party_repeat: call.id });
        return {
          ok: true, alreadyDone: true,
          say: `You have already done that for the person now on the line. Do NOT call this again this turn.`
            + ` Say it out loud now: who you are, that the call is recorded, then one sentence on what you`
            + ` are calling about and what is already settled.`,
        };
      }
      turnState.newPerson = true;
      const r = hold.newParty(call, {
        who: input.who ?? "", same: input.same_person_returning === true, log,
      });
      // The disclosure is marked as given on the strength of being INSTRUCTED here, because the next
      // thing that happens is the model saying it. Marked now rather than after, since there is no
      // later point this code runs again for the same party.
      if (r.announce) hold.markAnnounced(call, { party: r.party, log });
      return { ok: true, ...r, say: r.note };
    }
    case "machine_on_the_line": {
      const r = hold.noteMachineLine(call, {
        what: String(input.what ?? ""), deadEnd: input.dead_end === true, heard: String(input.heard ?? ""), log,
      });
      return r.endNow ? { ok: true, endNow: true, kind: r.kind } : { ok: true, kind: r.kind, say: r.instruction };
    }
    case "propose_commitment": {
      const details = proposedDetails(call, input);
      const r = commit.propose({
        call, brief, errandId: call.errand_id ?? null,
        what: input.what ?? "", totalCents: input.total_cents ?? null, terms: input.terms ?? [],
        // Their whole side of the call, for the one check that compares what the model reported
        // against what was plainly said. Read here rather than in commit.js so that file stays about
        // permission.
        theirWords: theirSideOf(context?.messages ?? []),
        details, tell, log,
      });
      // When it may go ahead, the exact words to read back come with the permission — built from the
      // real values, so the model has nothing to format and cannot say "a hundred eighty" to somebody
      // who is writing a number down.
      // Kept on the row, so a later turn of this call does not have to re-establish a date somebody
      // already gave. Whatever was heard clearly, whether or not the proposal was allowed: a deposit
      // that pauses for the owner must not also throw away the date they had just given.
      //
      // Only the clear ones. A kind the model reported it could not make out is deliberately NOT
      // written down as unclear, because a row that remembers it would keep blocking every later
      // proposal on this call even after they repeated it clearly.
      const keep = recordOfDetails(details.filter(d => d && !d.unclear));
      if (Object.keys(keep).length) {
        try { db.updateCall(call.conversation_id, call.id, { readback: JSON.stringify(keep) }); }
        catch { /* a row that is not in the database is a test's row */ }
      }
      const words = r.allowed ? readBackInstruction(details) : "";
      return {
        ok: r.allowed, allowed: r.allowed, reason: r.reason,
        commitment_id: r.commitment?.id ?? null,
        say: words ? `${r.say}\n\n${words}` : r.say,
      };
    }
    case "confirm_commitment": {
      const r = commit.confirm({
        call, brief, commitmentId: Number(input.commitment_id),
        reference: input.reference ?? "", writtenPromised: input.written_promised === true,
        theySaidYes: input.they_said_yes === true,
        details: proposedDetails(call, input), log,
      });
      if (!r.ok) return { ok: false, error: r.error, say: r.error };
      // The outcome is settled here, from rows, rather than worked out from the transcript afterwards.
      db.updateCall(call.conversation_id, call.id, { outcome_kind: "confirmed" });
      return { ok: true, strength: r.strength, say: r.say };
    }
    case "release_commitment": {
      const r = commit.release({ call, commitmentId: Number(input.commitment_id), why: input.why ?? "", log });
      return { ok: r.ok, error: r.error, say: r.say ?? r.error };
    }
    case "note_answer": {
      if (!call.errand_id) {
        // A single call with no errand behind it has nothing to compare against. Written onto the call's
        // own summary instead of refused, because the answers are still the point of the call.
        log({ call_answer_no_errand: call.id });
        return { ok: true, say: `Noted. Carry on, and make sure you have all the answers before you finish.` };
      }
      errand.noteAnswer(call.conversation_id, {
        errandId: call.errand_id, callId: call.id, toNumber: call.to_number,
        place: input.place ?? "", totalCents: input.total_cents ?? null,
        priceCents: input.price_cents ?? null, feesCents: input.fees_cents ?? null,
        firmness: input.firmness ?? "unknown", holdsUntil: input.holds_until ?? "",
        earliest: input.earliest ?? "", included: input.included ?? [], excluded: input.excluded ?? [],
        saidBy: input.said_by ?? "", notes: input.notes ?? "",
      });
      db.updateCall(call.conversation_id, call.id, { outcome_kind: "answered" });
      log({ call_answer_noted: call.id, errand: call.errand_id });
      return {
        ok: true,
        say: `Got it, written down. If any of their answers was vague — especially whether the price is firm and how`
          + ` long it holds — ask once more plainly, then thank them and end the call.`,
      };
    }
    // ---------- the owner's own call only (2026-10-07 addendum, sections 6 and 8) ----------
    //
    // Reachable only when `ownerContext` offered them, because `voiceTurn` filters every tool call
    // against the list the context was built with. A third-party call that names one of these is
    // answered by the `default` below, which is the same answer it gives any invented tool.
    case "verify_caller": {
      if (!call.is_owner) break;
      return verify.verify({
        call, passphrase: input.passphrase ?? "", about: input.about ?? "",
        // The text leaves by the same outbox everything else mid-call uses, and the yes is read off
        // the owner's own thread as this turn already has it.
        tell, messages: context?.messages ?? [], log,
      });
    }
    case "make_a_call_for_me": {
      if (!call.is_owner) break;
      // Two steps, one tool. Without a `request_id` this is the errand being written down and read
      // back; with one it is the yes to that read-back, which is the only thing that can dial.
      if (!input.request_id) return fromcall.request({ call, input, log });
      return fromcall.go({
        call, requestId: input.request_id, saidYes: input.they_said_yes === true, log,
        // The one way out, and it goes through `call_place` — the ordinary tool, with its caps, its
        // quiet hours, its never-twice and its confirm gate all still on it. This file does not dial
        // and neither does fromcall.js.
        dial: async (args) => {
          const out = await contextDeps.runTool("call_place", args, {
            conversationId: call.conversation_id, kind: "user",
            messages: context?.messages ?? [], onCall: call.id,
          });
          return out?.ok ? { ok: true, call_id: out.call_id } : { ok: false, error: out?.error ?? "the call tool refused it" };
        },
      });
    }
    case "call_request_status": {
      if (!call.is_owner) break;
      return fromcall.status({ call, requestId: input.request_id ?? null });
    }
    case "call_request_cancel": {
      if (!call.is_owner) break;
      return fromcall.cancel({ call, requestId: input.request_id ?? null, why: input.why ?? "", log });
    }
    default:
      break;
  }
  return { ok: false, error: `${name} is not something you can do on a call.` };
}

/**
 * The details a proposed commitment is read back against.
 *
 * Deliberately NOT parsed out of the model's sentence. What a commitment is checked against is the
 * price it reported as a number and whatever the read-back record on the call row already holds, so
 * there is no step where free text is scraped for a date. Where there is nothing recorded yet, the
 * list is empty and `settled()` reports the kinds the brief required as missing — which is the correct
 * answer: nothing has been established.
 */
function proposedDetails(call, input = {}) {
  const out = [];
  const seen = new Set();

  // Details Reason could not make out. First, because an unclear detail stops the agreement whatever
  // else is present, and because a value reported alongside one is not to be trusted either.
  for (const kind of (Array.isArray(input.could_not_hear) ? input.could_not_hear : [])) {
    const k = String(kind).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: k, label: k, unclear: true, spoken: "", exact: null });
  }

  const add = (kind, value) => {
    if (seen.has(kind) || value === null || value === undefined || value === "") return;
    seen.add(kind);
    out.push(readbackDetail({ kind, value }));
  };

  // The moment, as a real instant. A string that is not a parseable date is NOT turned into one: it
  // comes back as nothing, so `settled` reports the date and time as missing and the call is told to
  // ask. "Saturday morning" becoming some arbitrary Saturday is the failure that would matter here.
  const when = String(input.when ?? "").trim();
  if (when) {
    const at = Date.parse(when);
    if (Number.isFinite(at)) {
      // Both halves of the same instant, because the owner's rule is that a day without a date and a
      // time without a zone are not agreements.
      add("date", at);
      add("time", at);
    }
  }
  add("price", input.total_cents);
  add("address", input.address);
  add("confirmation", input.confirmation);

  // Anything already written down on the row from an earlier turn of this call, for the kinds the model
  // has not just reported. A detail settled three turns ago does not have to be re-established.
  try {
    const saved = JSON.parse(call?.readback ?? "{}");
    for (const [label, v] of Object.entries(saved ?? {})) {
      if (!v || typeof v !== "object" || seen.has(label)) continue;
      seen.add(label);
      out.push(v.unclear
        ? { kind: label, label, unclear: true, spoken: "", exact: null }
        : { kind: v.kind ?? label, label, unclear: false, spoken: v.spoken ?? "", exact: v.exact ?? null });
    }
  } catch { /* nothing recorded yet */ }
  return out;
}

/**
 * The two chunks that hang up: the function call the platform acts on, and the end of the stream.
 *
 * One place, because there are now three reasons a turn ends the call itself — a refusal, a hold that
 * ran out of budget, and the ordinary end — and three copies of this is three chances to emit a
 * `tool_calls` finish without the call that was supposed to precede it.
 */
function* endCallChunks(chunk, reason) {
  yield chunk({
    tool_calls: [{
      index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function",
      function: { name: "end_call", arguments: JSON.stringify({ reason }) },
    }],
  });
  yield chunk({}, "tool_calls");
  yield SSE_DONE;
}

/**
 * Put a refused platform tool back to the model as a tool result, so the next round says something.
 *
 * Used where a system tool is NOT forwarded — a menu key that has already been pressed twice, a
 * transfer the owner has not agreed to. The alternative would be swallowing it silently, which leaves
 * a person on the phone listening to a model that thinks it did something it did not do.
 */
function feedBack(messages, { text = "", name, input = {}, result }) {
  const id = `tu_${randomUUID().slice(0, 8)}`;
  messages.push({
    role: "assistant",
    content: [
      ...(String(text).trim() ? [{ type: "text", text }] : []),
      { type: "tool_use", id, name, input },
    ],
  });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result) }] });
}

/**
 * Handing the call to the owner in person.
 *
 * The owner's rule: "If Omari needs to join personally, notify him before transferring; never leave the
 * other person expecting him when he is unavailable." So the order is fixed and it is code that fixes
 * it — he is texted, and the transfer only goes through once he has actually said he is there.
 *
 * Two things shape this. A transfer **removes the voice from the call** (the line is redirected to the
 * owner, `GptLiveCall#transfer` in ./gptlive.js), so after this Reason is not on the line to apologise or
 * to put anything right: there is no second chance at it. And `agent_message` is the only thing the
 * person receiving the transfer is told — nothing documents the conversation history going with it — so
 * it is written here to carry the state in one breath rather than left to a model that may assume the
 * platform passes context along.
 *
 * `transfer_number` is forced to the owner's own number whatever was asked for. A transfer is the one
 * tool on a third-party call that connects the person on the line to a real human being, and the only
 * human they may be connected to is the one the call is being made for.
 */
export function handOver({ call, context, input = {}, log = () => {} }) {
  const who = db.getAccount(call.conversation_id);
  const owner = accounts.ownerOf(call.conversation_id).name;
  const number = who?.address && /^\+?\d{7,}$/.test(String(who.address)) ? String(who.address) : "";

  if (!number) {
    log({ call_handover_no_number: call.id });
    return {
      ok: false,
      say: `There is no number on file for ${owner}, so you cannot put this call through to them. Do not say you`
        + ` will. Tell them you will have ${owner} get back to them, take anything they need noting down, and finish`
        + ` the call normally.`,
    };
  }

  // Has he said he is there? The paused-commitment path is the one that texts him mid-call, so a
  // handover is only allowed once something of his has come back on this call. Without that, the other
  // person would be put through to a phone nobody is holding.
  const reachable = db.callCommitments(call.conversation_id, call.id)
    .some(m => String(m.owner_said ?? "").trim());
  if (!reachable) {
    log({ call_handover_not_yet: call.id });
    return {
      ok: false,
      say: `Not yet — ${owner} has not said they are free, and putting this person through to a phone nobody picks`
        + ` up is worse than not offering. Tell them you will get ${owner} to call them straight back, and make sure`
        + ` you have a number and a name before you end the call. Do not promise that ${owner} is about to come on`
        + ` the line.`,
    };
  }

  const settled = String(input.client_message ?? "").trim();
  return {
    ok: true,
    input: {
      ...input,
      transfer_number: number,
      client_message: settled || `Let me put you through to ${owner} now — one moment.`,
      // What the owner hears as he is joined. Written here because it is the ONLY thing that reaches
      // him through the platform, and once the transfer completes Reason is off the call.
      agent_message: [
        `${owner} — this is your assistant handing over a call.`,
        call.to_number ? `You are being joined to ${call.to_number}.` : ``,
        `What it was about: ${String(context?.brief?.goal || call.goal || "").slice(0, 200)}`,
        `They are on the line now.`,
      ].filter(Boolean).join(" "),
    },
  };
}

/** A short stable id for a string, so the same text queued twice is one row. */
function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- sentences ----------

/**
 * A splitter that hands back whole sentences and keeps the rest.
 *
 * Streaming and "never speak a URL" pull against each other: an address split across two deltas
 * cannot be found in either of them. A sentence is the smallest unit that always contains a whole
 * address — addresses have no spaces in them, so a boundary of punctuation-then-space cannot fall
 * inside one — and it is also the unit a speech engine wants, so holding back to it costs nothing.
 */
export function sentenceSplitter() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      const out = [];
      // Punctuation, then whitespace: the end of something that can be said.
      const re = /[.!?…]+["')\]]*\s+|\n+/g;
      let last = 0;
      let m;
      while ((m = re.exec(buffer)) !== null) {
        out.push(buffer.slice(last, m.index + m[0].length));
        last = m.index + m[0].length;
      }
      buffer = buffer.slice(last);
      return out;
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return rest.trim() ? [rest] : [];
    },
  };
}

// ---------- the safety screen, on a phone ----------

/**
 * The harm screen (src/harm.js), on what was just said out loud.
 *
 * A phone is another way in. The screen that reads every text somebody sends lives in
 * `Runtime._turn`, and a voice turn does not go through the runtime at all — so without this, "plan
 * something bad" refused in a text would be answered on a call. The owner's line on this was strict
 * and did not mention a channel.
 *
 * Two things about how it is called here rather than what it decides:
 *
 *   - **It is RACED against generation, not awaited before it.** Nobody is waiting on a text; on a
 *     call there is a person holding a handset, and screen-then-generate would be two model calls
 *     end to end before the first word. So both start at once and nothing is spoken until the screen
 *     has answered: first-word latency is the longer of the two rather than their sum, and the
 *     refusal still lands instead of the reply rather than after it.
 *   - **Only what the other person just said is screened.** Not the whole call: the earlier turns
 *     were screened when they were said, and re-reading them every turn would pay for the same
 *     verdict five times on a five-turn call.
 *
 * On a third-party call this does not run. There is no thread, no memory and no tool there, Reason
 * is the one doing the asking, and a restaurant is not a person who can be struck or paused.
 */
export function latestSpoken(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (text.trim()) return text.trim();
  }
  return "";
}

/**
 * Everything the other side has said on this call, in order.
 *
 * Their whole side rather than their last line, and the 2026-10-07 rehearsal is why. The check in
 * commit.js that catches a condition missing from a proposal was given only the most recent thing
 * they said: Marco named the deposit, the proposal came back without it and was refused, and then
 * Marco answered a question about the time — so one turn later "their last words" held no deposit in
 * them, the empty `terms` list passed, and the booking was allowed with the condition still missing.
 * A thing somebody said on a call does not stop having been said.
 */
export function theirSideOf(messages = []) {
  const out = [];
  for (const m of messages) {
    if (m?.role !== "user") continue;
    if (typeof m.content === "string" && m.content.trim()) out.push(m.content.trim());
  }
  return out.join("\n");
}

/**
 * What code does about a 'harm' verdict on a call, which is the same as on a text with one
 * difference: the call ends.
 *
 * The consequences are the same primitives `Runtime._screen` uses — the thread keeps their line and
 * the refusal, a ledger row is written, a strike is counted, and enough strikes pause that person's
 * Reason and tell the master the count and the kind and never the words. The master's line is QUEUED
 * rather than sent, because this is running mid-call and a channel that takes two seconds would be
 * two seconds of silence on the phone.
 *
 * The master is refused and never paused, exactly as in a text.
 */
export function refuseOnCall({ call, text, verdict, category = "", note = "", log = () => {} }) {
  const conversationId = call.conversation_id;
  const me = accounts.ownerOf(conversationId);
  const who = me.name === "the person I work for" ? "them" : me.name;

  if (verdict === "crisis") {
    // Written down so "has this come up before" is answerable, and never a strike: this person is
    // the one at risk, and cutting them off would be the one wrong thing to do. The call carries on.
    db.recordHarmEvent({ conversationId, verdict, category: category || "self_harm", note });
    log({ call_harm_screen: "crisis", call: call.id });
    return { refused: false, line: harm.CRISIS_LINE, endCall: false };
  }

  db.saveConversation(conversationId, [...db.loadConversation(conversationId), ...harm.historyLines({ who, text })]);
  const strike = harm.recordStrike(conversationId, { category, note });
  ledgerWrite({
    conversationId, action: "harm_refuse",
    input: { category: category || "other", strike: strike.count, on_call: call.id },
    out: { ok: false, blocked: "harm", strikes: strike.count, limit: strike.limit },
    target: `harm:${category || "other"}`,
  });
  log({ call_harm_screen: "harm", call: call.id, category, strikes: strike.count });

  if (strike.reached && !me.isOperator) {
    db.setAccountState(conversationId, "paused");
    const strikes = harm.strikesFor(conversationId);
    ledgerWrite({
      conversationId, action: "harm_pause",
      input: { strikes: strikes.count, window_hours: strikes.windowHours, kinds: strikes.kinds },
      out: { ok: true, state: "paused" },
      target: me.address || conversationId,
    });
    log({ harm_paused: conversationId, strikes: strikes.count, kinds: strikes.kinds, on_call: call.id });
    queueToMaster({ text: harm.pausedLine({ address: me.address, strikes }), key: `harm-pause:${call.id}`, log });
  }
  // The call ends. A person who has just been told no is not somebody to leave on an open line.
  return { refused: true, line: harm.REFUSAL_LINE, endCall: true, strike };
}

/** One line to the master, queued, because this runs with somebody on the phone. */
function queueToMaster({ text, key, log = () => {} }) {
  const master = db.getAccount(config.ownerConversation);
  const to = master?.address && master.address !== "console" ? master.address : config.masterNumbers[0];
  const channel = master?.channel && master.channel !== "console" ? master.channel : "";
  if (!to || !channel) {
    log({ call_could_not_tell_master: `nowhere to reach ${config.ownerName}`, about: key });
    return { queued: false };
  }
  const { row } = db.enqueueOutbound({
    idemKey: `call:${key}`, conversationId: config.ownerConversation, channel, address: to,
    body: text, toOwner: true, maxAttempts: config.outboxMaxAttempts,
  });
  return { queued: true, outbox_id: row.id };
}

// ---------- the turn ----------

/**
 * Everything this module reaches into the rest of Reason for, in one object so a test can state it.
 *
 * Imported lazily rather than at the top on purpose: `src/tools.js` imports a great deal of the
 * codebase, and this module is also loaded by the rehearsal harness and by tests that have no
 * business starting a browser. `prime()` is called once before the first turn.
 */
export const contextDeps = {
  systemFor: null, toolsFor: null, runTool: null, toSelf: null, openWorkNote: () => "", keptNote: () => "", purchasesNote: () => "",
  // The saved facts closest to what they just said (src/memorynote.js), for a turn on their own call.
  recall: memoryHits,
};

/**
 * How long a turn on their own call waits for the facts closest to what they just said (call 80: a
 * text turn was shown them, a call turn never). It sits in front of the first word, so it is short;
 * past it the turn goes on without them and says so in the log.
 */
export const CALL_RECALL_WAIT_MS = 700;
/** On their own call, a round's words go out once this much is held (and more follows), or at its end. */
export const LEAD_IN_HOLD_CHARS = 160;
/** The first turn waits this long at most for the week's read still running from the ring. */
export const CALL_MEMORY_WAIT_MS = 900;

let primed = null;
export async function prime() {
  if (primed) return contextDeps;
  primed = (async () => {
    const [agent, tools, openwork, kept, purchases] = await Promise.all([
      import("../agent.js"), import("../tools.js"), import("../openwork.js"), import("../kept.js"), import("../purchasesnote.js"),
    ]);
    contextDeps.systemFor = agent.systemFor;
    contextDeps.toolsFor = tools.toolsFor;
    contextDeps.runTool = tools.runTool;
    contextDeps.toSelf = tools.addressedToOwner;
    contextDeps.openWorkNote = openwork.openWorkNote;
    contextDeps.keptNote = kept.keptNote;
    contextDeps.purchasesNote = purchases.purchasesNote;
    return contextDeps;
  })();
  return await primed;
}

/**
 * A sentence that is Reason talking to itself about the call rather than to the person on it.
 *
 * In the 2026-10-07 rehearsal, four minutes into a hold, the whole of one spoken turn was: "The call
 * is on hold, so I should stay silent." Said out loud, to hold music, on a call Omari was paying for.
 * The prompt rule it was reciting is correct — go quiet on hold — and reciting it is the one thing
 * that breaks it. There is the same floor on the text path (`withoutSelfNote` in src/plain.js), but
 * that one needs a second paragraph to be sure it is a note; a phone turn is often one sentence long
 * and nothing follows it, so the test here is the sentence itself.
 *
 * Narrow on purpose, and the guard is the direction it is facing: anything addressed to the person —
 * "I'll hold", "thanks, I'll wait while you check" — is speech and is kept. What is dropped is the
 * first person deciding, in the third person about the call, to say nothing. A tool name spoken aloud
 * is dropped too: there is no sentence containing `skip_turn` that a human should ever hear.
 */
// `\s*` rather than `\s` after the "i", because the contraction carries no space: "I'll stay quiet"
// is the sentence this was written for and the first version of it did not match.
const I_AM_ABOUT_TO = `\\bi\\s*(?:['’]ll|will|should|need to|have to|must|am going to)`;
const SELF_TALK = [
  new RegExp(`${I_AM_ABOUT_TO}\\s+(?:just\\s+)?(?:stay|remain|keep|be)\\s+(?:silent|quiet)\\b`, "i"),
  new RegExp(`${I_AM_ABOUT_TO}\\s+(?:not|n['’]?t)\\s+(?:say|speak|talk)\\b`, "i"),
  new RegExp(`${I_AM_ABOUT_TO}\\s+(?:say|speak)\\s+(?:nothing|not a word)\\b`, "i"),
  /\b(?:say|saying)\s+nothing\s+(?:here|now|and wait)\b/i,
];
export function aNoteToItself(piece) {
  const s = String(piece ?? "").trim();
  if (!s) return false;
  if (CALL_TOOL_NAMES.concat(SYSTEM_TOOL_NAMES).some(n => s.includes(n))) return true;
  // Addressed to them, or asking them something: speech, whatever else is in it.
  if (/\b(you|your|yours|thanks|thank you)\b/i.test(s) || s.includes("?")) return false;
  return SELF_TALK.some(re => re.test(s));
}

/**
 * Start an async generator NOW and buffer what it yields, so a consumer that only begins reading
 * after an `await` still sees every event, in order — and the work behind the generator (a model
 * request) has been running the whole time instead of waiting for the first `.next()`.
 *
 * This is what makes "the reply is generated in parallel with the harm screen" true. Before it,
 * `const gen = generate()` did nothing until the loop that reads it began, and that loop began after
 * the screen had been awaited — so the screen and the model's first token were paid for one after
 * the other, and an owner call opened with seconds of dead air (2026-10-12).
 *
 * Nothing leaves through this; it only reads ahead. The consumer still decides what is spoken, which
 * is how the screen keeps its veto: on 'harm' the buffer is never read and `return()` closes the
 * request behind it.
 */
export function eagerly(gen) {
  const buffer = [];
  let finished = false;
  let failure = null;
  let wake = null;
  const notify = () => { const w = wake; wake = null; if (w) w(); };
  (async () => {
    try {
      for await (const ev of gen) {
        if (finished) break;
        buffer.push(ev);
        notify();
      }
    } catch (e) {
      failure = e;
    } finally {
      finished = true;
      notify();
    }
  })();
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      for (;;) {
        if (buffer.length) return { value: buffer.shift(), done: false };
        if (failure) { const e = failure; failure = null; throw e; }
        if (finished) return { value: undefined, done: true };
        await new Promise(resolve => { wake = resolve; });
      }
    },
    async return() {
      finished = true;
      buffer.length = 0;
      // Not awaited: a generator's `return()` queues behind its pending `next()`, and a refusal must
      // not wait on a model stream for the next chunk before it can hang up.
      Promise.resolve().then(() => gen.return?.()).catch(() => {});
      return { value: undefined, done: true };
    },
  };
}

/**
 * One spoken turn, as the SSE chunks it becomes.
 *
 * An async generator so the caller can pipe it straight to a socket and the first sentence leaves
 * before the last one has been written. Yields strings that are already framed `data: ...\n\n`, and
 * always ends with `[DONE]` — including when something went wrong, because a stream the platform is
 * still waiting on is a call with dead air in it, and "something broke" said out loud is better than
 * silence.
 *
 * @param {object} _
 * @param {object} _.context   what `contextFor` built
 * @param {Function} _.generate  async generator of {type:'text'|'tool_use'} — injected in tests
 */
export async function* voiceTurn({
  context, call, generate, model = "reason", log = () => {}, id = null,
  // The harm screen, injected so a test can state a verdict rather than needing a model for one.
  screen = harm.screen,
  // The runtime's `turnExtras` — the texting router and the call provider — so a tool run from a
  // call can reach the same channels a tool run from a text can. Without it `message_send` on a
  // call answered "there is no texting channel running" on an install whose texting was live
  // (2026-10-12, call 19: the notes he asked for were read out loud instead).
  extras = {},
  // Set when the platform has moved on from this turn — it closed the socket, or asked for a newer
  // one on the same call. Nothing said after that is heard, so the turn stops rather than finishing
  // tools and model rounds into a stream nobody is reading (call 30: five turns ran at once).
  signal = null,
  // How long one of Reason's tools may hold the line. Injectable so a test does not wait eight seconds.
  toolBudgetMs = CALL_TOOL_BUDGET_MS,
  // How long the turn may say nothing at all before the holding line. Injectable for the same reason.
  firstWordDeadlineMs = FIRST_WORD_DEADLINE_MS,
  // The holding line's deadline once this call has already had one; see `LATE_HOLDING_MS`.
  lateHoldingMs = LATE_HOLDING_MS,
  // How old a silent turn must be before a tool start says "One sec..."; see `FILLER_AFTER_MS`.
  fillerAfterMs = FILLER_AFTER_MS,
  // When the platform's request arrived (`Date.now()` ms). The platform's own clock — its 15 s
  // cascade timeout — starts there, before context building and the screen, so every deadline in
  // this turn is measured from it too. Defaults to now for a direct caller.
  t0 = null,
  // The turn meter (src/calls/metrics.js): which tools ran and what the model used. Watched only.
  meter = null,
  // Resolves true once somebody is reading this turn, false once it is cancelled. `llmRequest` keeps a
  // turn alive for a moment after its socket closes, so the platform's retry can pick it up; nothing
  // with a side effect starts in that moment unless somebody has. Null (a direct caller): always read.
  attended = null,
  // Told the name of each of Reason's own tools as it starts (never the call's platform tools). The
  // GPT-Live voice reads it so a "let me check" is only ever said while a lookup really runs (call 79).
  // Called `onTool(name, "start")` as it starts and `onTool(name, "done", { ok })` once it has run, so
  // the voice knows which tools REALLY ran this turn (call 80: a real send read as an unbacked one).
  onTool = null,
  // How long their own call's turn waits for the facts closest to their words; see `CALL_RECALL_WAIT_MS`.
  recallWaitMs = CALL_RECALL_WAIT_MS,
}) {
  const streamId = id ?? `chatcmpl-${randomUUID()}`;
  const created = Math.floor(clock.now() / 1000);
  const chunk = (delta, finish = null) => sseChunk({ id: streamId, model, created, delta, finish });
  const turnStart = clock.now();
  let firstContentAt = 0;
  const timing = () => ({
    first_word_ms: firstContentAt ? firstContentAt - turnStart : null,
    turn_ms: clock.now() - turnStart,
  });
  const superseded = () => signal?.aborted === true;
  // A cancelled turn still ends the way every stream ends: a stop, then `[DONE]`. A stream left open
  // on its role chunk is what the platform reads as a failed reply and asks for again.
  const endSuperseded = function* (at, rounds) {
    log({ voice_turn_superseded: call.id, kind: context.kind, reason: "aborted", at, ...(rounds == null ? {} : { rounds }), ...timing() });
    yield chunk({}, "stop");
    yield SSE_DONE;
  };
  // Before anything with a side effect: wait for a reader (see `attended` above), or stop.
  const stillWanted = async () => (attended ? (await attended()) === true : true) && !superseded();

  // The first chunk of an OpenAI stream carries the role and nothing else.
  yield chunk({ role: "assistant" });

  const messages = withCallRecord(endOnTheirSide(context.messages, { own: context.kind === "owner" }), db.callLookups(call));
  // On their own call, what Reason remembers that is closest in meaning to what they just said — the
  // same search a text turn gets — riding in front of their words like the call record, never as theirs.
  const owned = context.kind === "owner";
  if (owned && recallWaitMs > 0 && messages.at(-1)?.role === "user") {
    const theirWords = latestSpoken(context.messages);
    let timer;
    const late = new Promise(r => { timer = setTimeout(() => r(null), recallWaitMs); timer.unref?.(); });
    const found = theirWords
      ? await Promise.race([Promise.resolve().then(() => contextDeps.recall(context.conversationId, theirWords, { log })).catch(() => []), late]).finally(() => clearTimeout(timer))
      : [];
    if (found === null) log({ call_recall_late: call.id, wait_ms: recallWaitMs });
    if (found?.length) {
      const last = messages.at(-1);
      const theirs = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      messages[messages.length - 1] = { role: "user", content: [{ type: "text", text: `[What you remember that may bear on this (saved facts closest in meaning to what they just said — not something they said):\n${found.join("\n")}]` }, ...theirs] };
    }
  }
  // A line that opened silent and stayed silent: the platform hands the turn over with nothing from
  // either side yet, and the call model refuses a request with no messages in it.
  if (!messages.length) messages.push({ role: "user", content: LINE_OPENED });
  let said = "";
  let filled = false;
  // Their own call: this round's newest sentences, held until more words follow them (`owned` above);
  // and the last round's words before its tools, dropped unsaid unless nothing comes after.
  let leadIn = [];
  let lastLeadIn = [];
  let lastLeadInRound = -1;
  // Set when a lookup came back with no position for them (WHERE_ASK).
  let whereUnknown = false;
  let lookedForWhere = false;
  // Already asked where they are this turn (their words or WHERE_ASK), so it is never asked twice.
  const askedWhere = () => /\bwhere\b[^.?!]*\?/i.test(said) || /share (your|their) location/i.test(said);
  function* askWhere(why, emit = null) {
    // Their own question, held as a lead-in before the tool ("I can't see where you are. Where are
    // you?"), is said rather than replaced; otherwise code's.
    const leadAsks = emit && (!said.trim() || onlyHolding()) && replayable() && /\bwhere\b[^.?!]*\?/i.test(lastLeadIn.join(""));
    log({ voice_where_ask: call.id, why, lead_in: Boolean(leadAsks), ...timing() });
    // Something refused for the caller check this turn, not yet said: that first (it is what they asked for).
    if (checkRefusalIsOwed()) {
      const line = turnState.checkQueued ? CHECK_LATER_LINE : CHECK_NOT_HERE_LINE;
      const content = said ? ` ${line}` : line;
      said += content;
      yield chunk({ content });
    }
    if (leadAsks) yield* emit(lastLeadIn);
    else if (!askedWhere()) yield chunk({ content: said ? ` ${WHERE_ASK}` : WHERE_ASK });
    yield chunk({}, "stop");
    yield SSE_DONE;
  }
  // The model's own words have been said this turn (a lead-in is then never replayed after them).
  let spokeOwn = false;
  let firstEventLogged = false;
  // A silent last round says the last lead-in only when nothing of the model's has been said yet —
  // or "Sent." after a send that went out, which is true whatever came before it.
  const replayable = () => lastLeadIn.join("").trim() && (!spokeOwn || (lastLeadIn.length === 1 && lastLeadIn[0] === SENT_LINE));
  // Reason's own tools as the voice is told of them: each one once at its start (the API streams a
  // tool_start and then a tool_use for the same call; the CLI only the tool_use) and once when done.
  // One left open at the end of a round (a refused or call-side tool) is closed then (second review).
  const toolsOpen = new Map();
  const startsSeen = new Map();
  const toolStart = (name) => {
    toolsOpen.set(name, (toolsOpen.get(name) ?? 0) + 1);
    if (onTool) { try { onTool(name, "start"); } catch { /* a watcher never breaks the turn */ } }
  };
  const toolDone = (name, ok) => {
    const c = (toolsOpen.get(name) ?? 0) - 1;
    if (c > 0) toolsOpen.set(name, c); else toolsOpen.delete(name);
    if (onTool) { try { onTool(name, "done", { ok }); } catch { /* a watcher never breaks the turn */ } }
  };
  const closeOpenTools = () => { for (const [n, c] of [...toolsOpen]) for (let i = 0; i < c; i++) toolDone(n, false); };
  let currentSplitter = null;
  const dropLeadIn = (round) => {
    const words = [...leadIn, ...(currentSplitter?.flush() ?? [])];
    leadIn = [];
    if (!words.join("").trim()) return;
    lastLeadIn = words;
    lastLeadInRound = round;
    log({ voice_lead_in_dropped: call.id, round, chars: words.join("").trim().length });
  };
  // The holding line, said at most once per turn — see `FIRST_WORD_DEADLINE_MS`.
  let holdingSaid = false;
  // Which line it was (the holding line, or the late line), for `onlyHolding`.
  let holdingText = "";
  const turnStartReal = Number.isFinite(t0) ? t0 : Date.now();
  // What this call has already had once: the tool-start filler, the holding line at the first deadline.
  const once = onceSaidFor(call);
  // The one "something was already said" the filler and the holding line share, so a turn never
  // gets both: the holding line sets `said`, the filler sets `filled`.
  const saidAnything = () => Boolean(said || filled || holdingSaid);
  // "One sec...", or nothing: only into a turn that has said nothing, is old enough for the pause to
  // be real, and on a call that has not had it yet. See `FILLER_AFTER_MS`.
  const oneSec = function* () {
    if (saidAnything() || once.filler || Date.now() - turnStartReal < fillerAfterMs) return;
    filled = true;
    once.filler = true;
    log({ voice_tool_filler: call.id, kind: context.kind, ms: Date.now() - turnStartReal });
    yield chunk({ content: ONE_SEC });
  };
  // Nobody on their side has been told who is calling, or only a machine has spoken. Either way the
  // words this turn writes are NOT streamed as they come: until the round's tools are known there is
  // no telling a reply to a person from a note about a recording, and call 45 said "This is a recorded
  // message, and it says they aren't taking customer phone inquiries" into the recording. Held to the
  // end of each round, then dropped (it waited, pressed a key, or named a machine) or said — with the
  // disclosure, verbatim, in front of it when nobody has heard it yet.
  let holdBack = context.kind === "third_party" && (context.openingOwed === true || context.machineOnLine === true);
  // Anything said to somebody who has not heard who is calling — even an apology — goes after the
  // disclosure. The held-words release below is the ordinary route; this is for the two fallbacks.
  const openingIfOwed = function* () {
    if (context.kind !== "third_party" || !hold.openingOwed(call) || callOutcome.reachedMachine(call)) return;
    hold.markAnnounced(call, { party: 1, log });
    said = String(call.announcement).trim();
    log({ call_opening_said: call.id, at: "fallback" });
    yield chunk({ content: said });
  };
  // Scratch for things that may happen at most ONCE in a turn however many rounds it takes. See the
  // `new_person_on_the_line` branch in `runCallTool`.
  const turnState = {};

  // Waits on `pending` — the model's next event, or the harm screen — and, if the turn has said
  // nothing by the deadline, says the holding line once while it keeps waiting. Not while words are
  // held back: a stranger who has not heard who is calling, or a machine on the line, hears nothing
  // before the disclosure. The line is an ordinary content delta in the same assistant message, so
  // the stream keeps its shape: the platform's next request carries it as Reason's own words, and a
  // history ending on it is handed back as the person's turn by `endOnTheirSide`, never a prefill.
  //
  // Armed only when a spoken reply is what this turn is for. Never on hold (the model is meant to
  // skip_turn, and a line into hold music is wasted on nobody), never with a menu, recording or
  // mailbox on the line (MACHINE_KINDS: anything said there is a key press or the voicemail itself),
  // never to somebody still owed the disclosure. Read again at the deadline, because a round can
  // change any of these mid-turn (a voicemail_detection, a skip_turn). So it is never said once a
  // machine is known, which keeps it out of any round whose words are recorded as the voicemail.
  const LATE = Symbol("late");
  const replyExpected = () => !holdBack && !superseded() && !hold.onHold(call) && !hold.openingOwed(call)
    && !callOutcome.MACHINE_KINDS.includes(String(call?.outcome_kind ?? ""));
  const onlyHolding = () => holdingSaid && said === holdingText;
  // A refusal for the caller check is owed out loud until something has been said after it: words
  // before the refused tool ("let me send that") are not the refusal (spoofed-inbound drive 11-08).
  const checkRefusalIsOwed = () => turnState.checkRefused != null && (said.length === turnState.checkRefused || onlyHolding());
  const untilFirstWord = async function* (pending) {
    // A turn closed while it waits here leaves `pending` behind; its rejection is nobody's to crash on.
    Promise.resolve(pending).catch(() => {});
    if (saidAnything() || !replyExpected()) return await pending;
    // The holding line once per call at the first deadline; after that, the next late line for any
    // turn still silent at the late deadline. See `LATE_HOLDING_MS`, `LATE_LINES`.
    const late = once.holding;
    const deadlineMs = late ? Math.max(firstWordDeadlineMs, lateHoldingMs) : firstWordDeadlineMs;
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve(LATE), Math.max(0, deadlineMs - (Date.now() - turnStartReal)));
      timer.unref?.();
    });
    let first;
    try { first = await Promise.race([pending, deadline]); } finally { clearTimeout(timer); }
    if (first !== LATE) return first;
    if (saidAnything() || !replyExpected()) return await pending;
    const line = late ? LATE_LINES[once.late % LATE_LINES.length] : HOLDING_LINE;
    if (late) once.late++;
    holdingSaid = true;
    once.holding = true;
    holdingText = line;
    said = line;
    if (!firstContentAt) firstContentAt = clock.now();
    log({ voice_holding_line: call?.id, kind: context.kind, ms: Date.now() - turnStartReal, deadline_ms: deadlineMs, late });
    yield chunk({ content: line });
    return await pending;
  };

  // The screen on what they just said, started NOW and read before anything is spoken. Racing it
  // against the reply rather than waiting for it first is what keeps first-word latency the longer
  // of the two instead of their sum — see `latestSpoken`. Owner calls only: a restaurant has no
  // thread to protect and is not somebody who can be struck.
  const spokenByThem = context.kind === "owner" ? latestSpoken(context.messages) : "";
  const screening = spokenByThem
    ? Promise.resolve()
      .then(() => screen({
        text: spokenByThem,
        messages: context.messages.slice(0, -1),
        who: accounts.ownerOf(call.conversation_id).name,
        // Screen on the call's own backend, not the global one: on a CLI install the global screen
        // is a ~4.5s cold start before the first spoken word. The API path with a fast model is ~1s.
        backend: callBackendName(),
        model: callBackendName() === "api" ? config.callHarmModel : null,
        // Counted as the call's own spend: never held back by a cap (the call cap only texts the owner).
        feature: "call_harm",
      }))
      .catch(e => ({ verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] }))
    : null;

  try {
    for (let round = 0; round <= MAX_VOICE_TOOL_ROUNDS; round++) {
      const splitter = sentenceSplitter();
      currentSplitter = splitter;
      const toolUses = [];
      let roundText = "";

      const held = [];
      const emit = function* (pieces) {
        if (holdBack) { held.push(...pieces); return; }
        for (const piece of pieces) {
          let { spoken, links } = withoutSpokenLinks(piece);
          if (links.length && context.kind === "owner") {
            // "I'm texting it to you now" said out loud, and the text in the outbox in the same
            // breath, so it is true at the moment it is said rather than something to remember after
            // hanging up.
            queueMidCall({ call, text: links.join("\n"), log });
          } else if (links.length) {
            // A third-party call has nobody to text. The address is taken out of the spoken words
            // anyway — reading one to a restaurant is worse than useless — and logged, so the owner's
            // summary is not the first anybody hears of it.
            log({ call_link_not_spoken: call.id, links });
          }
          if (!spoken) continue;
          // The text path's silence marker, said as words: "No reply. No reply." to Omari at the end
          // of call 42. On a call it is never speech. Taken out wherever it sits in the sentence;
          // whatever is left is still said, and a sentence that was only the marker is nothing.
          const marker = withoutSilenceMarker(spoken);
          if (marker.had) {
            log({ voice_no_reply_dropped: call.id, kept: marker.text.length });
            if (!marker.text) continue;
            spoken = marker.text;
          }
          // Thinking out loud, down a phone line. Dropped rather than cleaned, because there is no
          // useful half of it, and logged, because the real fix is the prompt and this is the floor.
          if (aNoteToItself(spoken)) {
            log({ voice_self_note_dropped: call.id, chars: spoken.length });
            continue;
          }
          // One leading space between sentences, because each piece was trimmed on the way through.
          const content = said ? ` ${spoken}` : spoken;
          said += content;
          // Words of the model's own are out this turn: an earlier lead-in is never said after them.
          if (holdingText !== spoken) spokeOwn = true;
          if (!firstContentAt) firstContentAt = clock.now();
          yield chunk({ content });
        }
      };
      // Something was refused for the caller check this turn and nobody has heard so: the refusal is
      // always said (spoofed-inbound drive 11-08: refused, then a skip_turn, and the caller got silence).
      const checkRefusalOwed = function* () {
        if (!checkRefusalIsOwed()) return;
        log({ voice_check_later_said: call.id, round });
        yield* emit([turnState.checkQueued ? CHECK_LATER_LINE : CHECK_NOT_HERE_LINE]);
      };

      if (superseded()) {
        yield* endSuperseded("round", round);
        return;
      }
      const saidAtRoundStart = said.length;

      const gen = generate({
        system: context.system, messages, tools: offeredTools(context), log, signal,
        ...(meter ? { onUsage: (u) => callMetrics.addUsage(meter, u) } : {}),
      });
      // On the screened round the model request is put in flight NOW, read ahead into a buffer, so
      // the screen below is read while the first token is already on its way (see `eagerly`).
      const events = round === 0 && screening ? eagerly(gen) : gen;

      // Read the screen before a word leaves, and only on the first round — the later rounds are
      // Reason's own tool results, not anything anybody said. A 'harm' verdict throws the reply away
      // unspoken: it was generated in parallel, which is what bought the latency, and it is not what
      // goes out.
      if (round === 0 && screening) {
        const read = yield* untilFirstWord(screening);
        const verdict = harm.VERDICTS.includes(read?.verdict) ? read.verdict : "unscreened";
        if (read?.skipped) log({ harm_screen_skipped: read.skipped, call: call.id });
        if (verdict === "harm" || verdict === "crisis") {
          const done = refuseOnCall({ call, text: spokenByThem, verdict, category: read?.category, note: read?.note, log });
          yield chunk({ content: said ? ` ${done.line}` : done.line });
          if (done.endCall) {
            // The reply that was being written in parallel is thrown away unread, and the request
            // behind it is closed rather than left running for a call that is ending.
            await events.return?.();
            yield chunk({
              tool_calls: [{
                index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function",
                function: { name: "end_call", arguments: JSON.stringify({ reason: "refused: this is not something to help with" }) },
              }],
            });
            yield chunk({}, "tool_calls");
            yield SSE_DONE;
            return;
          }
          // A crisis is not a refusal and not the end of a call. The help line is said, and then the
          // reply that was being written goes out after it, because this is a person to stay with.
          said = done.line;
        }
      }

      // Read by hand rather than `for await`, so each wait on the model can be raced against the
      // first-word deadline. The `finally` does what `for await` did on the way out: closes the
      // model's stream when the turn ends early (superseded, or the platform hung up mid-yield).
      const reading = events[Symbol.asyncIterator]();
      let readingDone = false;
      try {
        for (;;) {
          const step = yield* untilFirstWord(reading.next());
          if (step.done) { readingDone = true; break; }
          const ev = step.value;
          // When the model first had anything — words or a tool — for the wait it puts on the call
          // (the backend's share of the silence, apart from what code adds after it; drive 11-08).
          if (!firstEventLogged && (ev?.type === "text" ? String(ev.text ?? "").trim() : ev?.type === "tool_start" || ev?.type === "tool_use")) {
            firstEventLogged = true;
            log({ voice_first_event: call?.id, ms: Date.now() - turnStartReal, kind: ev.type === "text" ? "text" : "tool", round });
          }
          if (ev?.type === "text") {
            roundText += ev.text ?? "";
            if (owned) {
              // Their own call: a sentence is said once more words follow it in this round, or the round
              // ends with no tool. Words written just before a tool are the lead-in ("I'll grab your
              // location first"), and the spoken answer is what comes after the tool (call 80).
              // Held until it is longer than a lead-in ever is (LEAD_IN_HOLD_CHARS): "Okay. Let me grab
              // your location." is two sentences, and saying the first would start the answer early
              // and end the holding lines over a tool that has not even begun (cold review).
              if (leadIn.join("").length >= LEAD_IN_HOLD_CHARS && String(ev.text ?? "").trim()) { yield* emit(leadIn); leadIn = []; }
              leadIn.push(...splitter.push(ev.text ?? ""));
            } else yield* emit(splitter.push(ev.text ?? ""));
            continue;
          }
          // A backend with no streaming tool start (the CLI) reports the tool when its call is read.
          if ((ev?.type === "tool_start" || ev?.type === "tool_use") && !SILENT_TOOLS.has(ev.name)) {
            const n = String(ev.name ?? "");
            if (ev.type === "tool_start") { startsSeen.set(n, (startsSeen.get(n) ?? 0) + 1); toolStart(n); }
            else if (startsSeen.get(n) > 0) startsSeen.set(n, startsSeen.get(n) - 1);
            else toolStart(n);
          }
          if ((ev?.type === "tool_start" || ev?.type === "tool_use") && owned && !SILENT_TOOLS.has(ev.name)) {
            dropLeadIn(round);
            if (ev.type === "tool_start" && !filled) yield* oneSec();
            if (ev.type === "tool_start") continue;
          }
          if (ev?.type === "tool_start" && !filled && !holdBack && !SILENT_TOOLS.has(ev.name)) {
            // The filler goes out as the tool call begins, while the model is still writing its
            // input — a whole text message, for message_send. Waiting for the block to close put it
            // 8–11 seconds into the turn (call 35, 2026-10-21). Only into silence, though: words
            // already said (the model's own, or the holding line) bought this pause, and nothing extra
            // is added after them. See `oneSec`.
            yield* emit(splitter.flush());
            yield* oneSec();
            continue;
          }
          if (ev?.type === "tool_use") {
            toolUses.push(ev);
            if (meter && ev.name) meter.tools.add(String(ev.name));
          }
        }
      } finally {
        if (!readingDone) Promise.resolve(reading.return?.()).catch(() => {});
      }
      if (owned) {
        const rest = [...leadIn, ...splitter.flush()];
        leadIn = [];
        if (toolUses.some(t => !SILENT_TOOLS.has(t.name))) { leadIn = rest; dropLeadIn(round); }
        else if (rest.join("").trim()) yield* emit(rest);
        // The round after the tools said nothing at all: then the words before them were the answer
        // (a question it asked as it called the tool), and they are said rather than nothing. The
        // code's own holding line is not the model saying something (drive 11-08: "Still working on
        // it." landed mid-round and the turn ended on "Let me come back to you on that one.").
        // A skip_turn or other silent tool is not something said either (spoofed-inbound drive 11-08:
        // "I'll pick it up by text" written before verify_caller, then skip_turn, and the caller heard
        // nothing of Reason's). And a refusal for the caller check is always answered out loud.
        else if (round > 0 && (said.length === saidAtRoundStart || onlyHolding()) && !toolUses.some(t => !SILENT_TOOLS.has(t.name)) && !toolUses.some(t => t.name === "end_call")) {
          // Words written after a refusal for the caller check are the model's own answer to it ("I can't
          // send that on this call, I'll pick it up by text") and are said instead of code's. Words from
          // the refused tool's own round or before ("Let me check.") are said, then the refusal (#414:
          // always said; "owed" until something is said after it).
          const refusalOwed = checkRefusalIsOwed();
          if (replayable()) {
            log({ voice_lead_in_said: call.id, round });
            yield* emit(lastLeadIn);
            if (refusalOwed && lastLeadInRound <= (turnState.checkRefusedRound ?? -1)) {
              log({ voice_check_later_said: call.id, round, after: "lead_in" });
              yield* emit([turnState.checkQueued ? CHECK_LATER_LINE : CHECK_NOT_HERE_LINE]);
            }
          } else if (refusalOwed) yield* checkRefusalOwed();
        }
      } else yield* emit(splitter.flush());

      // Everything below this point writes down what this round did — the disclosure as said, a
      // voicemail as left, a wait, a key press, a hand-over — so none of it runs for a round nobody
      // is reading. Its socket closed mid-round: it waits here for a re-ask to join, or is cancelled.
      if (!(await stillWanted())) {
        yield* endSuperseded("round_end", round);
        return;
      }

      if (holdBack && held.length) {
        // A recording or menu is on the line and the model is hanging up: nobody hears the goodbye,
        // and saying it would spend the disclosure on a machine and file it as a person.
        const hangingUpOnAMachine = callOutcome.onAMachine(call) && toolUses.some(t => t.name === "end_call");
        if (hangingUpOnAMachine || toolUses.some(t => QUIET_ON_A_MACHINE.has(t.name))) {
          // It waited, pressed a key, or said a machine answered: whatever it wrote was about the line,
          // not to anybody on it. Logged, because the prompt says to write nothing and this is the floor.
          log({ call_machine_words_dropped: call.id, chars: held.join(" ").length });
          // Never said, so never a voicemail either: the mailbox branch below reads `roundText`.
          roundText = "";
        } else {
          holdBack = false;
          // Words for somebody: a person has come on. The row stops saying it was a machine, and the
          // disclosure goes first if nobody has heard it — word for word, from the row, by code. Not
          // on a voicemail: the message itself says who is calling (`noteMachine` in ./hold.js).
          const mailbox = callOutcome.reachedMachine(call);
          if (!mailbox) hold.notePerson(call, { log });
          if (!mailbox && hold.openingOwed(call)) {
            hold.markAnnounced(call, { party: 1, log });
            said = String(call.announcement).trim();
            if (!firstContentAt) firstContentAt = clock.now();
            log({ call_opening_said: call.id });
            yield chunk({ content: said });
          }
          yield* emit(held);
        }
      }

      // Nothing said and nothing asked for, while the call is on hold: that is a wait, so it leaves as
      // one, through the same skip_turn path as a wait the model asked for. An empty stop here was
      // read by the platform as a failed reply and asked again within a second (call 35, 2026-10-30:
      // four "said 0" turns in a row after a skip_turn), and it took the call off hold on the way.
      if (!toolUses.length && !said && hold.onHold(call) && !callOutcome.reachedMachine(call)) {
        log({ voice_empty_turn_waits: call.id, kind: context.kind, rounds: round });
        toolUses.push({ type: "tool_use", name: "skip_turn", id: `tu_${randomUUID().slice(0, 8)}`, input: { reason: "still waiting; nothing new to say" } });
      }

      // Reason spoke instead of waiting, so whatever it was holding for has happened. The whole hold
      // detector is this line and `skip_turn` below: no regex over the transcript, no listening for
      // music. It is checked on the first round only, because the later rounds are Reason's own tool
      // results rather than anybody on the line saying something.
      if (round === 0 && !toolUses.some(t => t.name === "skip_turn")) {
        const off = hold.noteSpeaking(call, { log });
        if (off?.waited) log({ call_resumed_after_hold: call.id, waited: off.waited });
      }

      // A machine answered earlier in this turn or on a previous one, and this round is not the
      // hang-up it was told to make. Nobody is listening, so whatever was said IS the message, and
      // the call ends on it rather than sitting in somebody's mailbox until it cuts off. A second
      // `voicemail_detection` lands here too: the machine is already known, and calling it again is
      // the model asking to hang up.
      if (callOutcome.reachedMachine(call) && !toolUses.some(t => t.name === "end_call")) {
        const left = hold.noteVoicemail(call, { message: withoutSilenceMarker(roundText).text, log });
        yield* endCallChunks(chunk, left.left ? "left the voicemail" : "a machine answered; nothing to leave");
        log({ voice_turn: call.id, kind: context.kind, voicemail_left: left.left, rounds: round, ...timing() });
        return;
      }

      if (!toolUses.length) {
        yield* checkRefusalOwed();
        // The holding line went out and the model then said nothing (only NO_REPLY, or a note to
        // itself): "one moment" with nothing after it is a promise left hanging, so the turn's
        // nothing-said sentence closes it, as it does when the rounds run out.
        if (onlyHolding()) {
          log({ voice_turn_nothing_said: call.id, kind: context.kind, after: "holding_line", ...timing() });
          said += NOTHING_SAID_AFTER;
          yield chunk({ content: NOTHING_SAID_AFTER });
        }
        yield chunk({}, "stop");
        yield SSE_DONE;
        log({ voice_turn: call.id, kind: context.kind, said: said.length, rounds: round, ...timing() });
        return;
      }

      // A tool the PLATFORM owns. It leaves as an OpenAI function call and the turn is over: ending
      // the call, switching language, waiting, pressing keys and hanging up on a machine are all
      // things only the line (the voice relay) can do.
      let system = toolUses.find(t => SYSTEM_TOOL_NAMES.includes(t.name));
      // end_call's `message` and transfer_to_number's `client_message` are spoken by the platform,
      // so they never passed the sentence filter in `emit`: one carrying "NO_REPLY" would have been
      // read down the line as "no reply". Same floor as the spoken words: marker out, and an
      // argument that was only the marker is dropped — the line goes quietly, or `handOver` uses
      // its own words.
      for (const key of ["message", "client_message"]) {
        if (!system || typeof system.input?.[key] !== "string") continue;
        const marker = withoutSilenceMarker(system.input[key]);
        if (!marker.had) continue;
        log({ voice_no_reply_dropped: call.id, kept: marker.text.length, tool: system.name });
        const { [key]: _dropped, ...rest } = system.input;
        system = { ...system, input: marker.text ? { ...rest, [key]: marker.text } : rest };
      }

      // Waiting. The platform stays silent; the budget is ours, because their silence timer measures
      // silence and hold music is audio. Out of budget, the call rings off politely rather than sitting
      // there — and that is an outcome of its own, not a failure.
      // Only a call to somebody else holds. On their own call a skip is them talking with Reason and a
      // pause in it, not a hold (call 68, 2026-11-01: "waiting for Omari to answer" started a hold clock).
      if (system?.name === "skip_turn" && context.kind === "owner") {
        log({ voice_own_call_skip: call.id, reason: String(system.input?.reason ?? "").slice(0, 60) });
      } else if (system?.name === "skip_turn") {
        const wait = hold.noteWaiting(call, { reason: String(system.input?.reason ?? ""), log });
        if (!wait.wait) {
          db.updateCall(call.conversation_id, call.id, { outcome_kind: "hold_gave_up", outcome: wait.why });
          yield chunk({ content: said ? ` ${wait.line}` : wait.line });
          yield* endCallChunks(chunk, "waited on hold as long as this call allows");
          log({ voice_turn: call.id, kind: context.kind, gave_up_on_hold: wait.seconds, ...timing() });
          return;
        }
      }

      // A phone menu. The tones are cleaned here and the re-send limit is enforced here, so a menu that
      // never reacts becomes a sentence rather than four minutes of billing and the same key forever.
      if (system?.name === "play_keypad_touch_tone") {
        const asked = { ...(system.input ?? {}) };
        const press = hold.notePress(call, { tones: String(asked.dtmf_tones ?? ""), log });
        if (!press.ok) {
          // Logged, because a press that is refused is invisible otherwise: the call simply never
          // presses anything and stalls on a menu, which is exactly how it was found.
          log({ call_menu_refused: call.id, asked: hold.tonesForLog(asked.dtmf_tones), stuck: press.stuck === true });
          // NOT forwarded. Fed back as a tool result so the next round speaks instead of pressing, which
          // is what gets a human on most menus anyway.
          system = null;
          feedBack(messages, { text: roundText, name: "play_keypad_touch_tone", input: asked, result: press });
          continue;
        }
        system = { ...system, input: { ...asked, dtmf_tones: press.tones } };
      }

      // A machine answered. NOT forwarded: at the platform, detection ends the call, speaking the
      // agent's canned `voicemail_message` first if it has one — it has none, and the message is
      // different on every call. Fed back instead, so the next round leaves the message through
      // `end_call`'s own `message` argument. The row says "a machine, nothing left yet" from here and
      // "one message was left" only once there are words — see `noteMachine`/`noteVoicemail`.
      if (system?.name === "voicemail_detection") {
        const asked = { ...(system.input ?? {}) };
        const machine = hold.noteMachine(call, { reason: String(asked.reason ?? ""), log });
        system = null;
        feedBack(messages, { text: roundText, name: "voicemail_detection", input: asked, result: machine });
        continue;
      }

      // Hanging up on a menu or a recording: nothing is said into it, not even a farewell message.
      if (system?.name === "end_call" && callOutcome.onAMachine(call) && system.input?.message) {
        system = { ...system, input: { reason: String(system.input?.reason ?? "") } };
      }

      // The hang-up after a machine answered. Whatever is in `message` is what the mailbox gets, and
      // it is the only thing that makes this a voicemail left rather than a machine reached.
      if (system?.name === "end_call" && callOutcome.reachedMachine(call)) {
        // The record of what the mailbox got: what was actually spoken, so never the marker.
        const words = [withoutSilenceMarker(roundText).text, system.input?.message].map(s => String(s ?? "").trim()).filter(Boolean).join(" ");
        hold.noteVoicemail(call, { message: words, log });
      }

      // Handing the call to the owner himself. Guarded, because his own rule is that the other person
      // is never left expecting him when he is not there — and because a conference transfer removes
      // Reason from the call, so there is nothing to put right afterwards.
      if (system?.name === "transfer_to_number") {
        const asked = { ...(system.input ?? {}) };
        const over = handOver({ call, context, input: asked, log });
        if (!over.ok) {
          system = null;
          feedBack(messages, { text: roundText, name: "transfer_to_number", input: asked, result: over });
          continue;
        }
        system = { ...system, input: over.input };
      }
      if (system?.name === "language_detection") {
        const to = String(system.input?.language ?? "").trim();
        // A switch to the language the call is ALREADY in is not a switch. Dropped here rather than
        // asked of the model, because the first rehearsal (2026-10-06) had it calling this on every
        // single turn once the restaurant answered in Spanish — the words were right and the tool
        // call was noise, and noise aimed at the platform is noise that re-configures a live call.
        if (!to || to === context.language) {
          log({ call_language_already: call.id, to: to || "(none)" });
          system = null;
          // Nothing else was asked for, so this turn is just the words it already said.
          if (toolUses.length === 1) {
            yield chunk({}, "stop");
            yield SSE_DONE;
            return;
          }
        } else {
          // The language only. Whether the disclosure owes being said again in it is settled on the
          // next turn, when there is a prompt that can carry the instruction — and never at all on an
          // owner call, which never recites a recording line in any language.
          noteCallLanguage(call, to);
          log({ call_language_switch: call.id, to, kind: context.kind });
        }
      }
      // A key pressed or a wait begun before anybody has been spoken to is a machine on the line, even
      // when the model went straight to the key without naming it (the claude-cli run of the menu case,
      // 2026-10-27). Written so a call that ends on the menu is not filed as a person who answered.
      if (system && context.kind === "third_party" && hold.openingOwed(call) && !call.outcome_kind
        && (system.name === "play_keypad_touch_tone" || system.name === "skip_turn")) {
        hold.noteMachineLine(call, { what: system.name === "play_keypad_touch_tone" ? "phone_menu" : "recorded_message", log });
      }
      if (system && system.name !== "end_call") yield* checkRefusalOwed();
      // Hanging up on a refusal nobody has heard: the platform says end_call's message, so the text-back
      // goes in front of it rather than being lost.
      else if (system?.name === "end_call" && checkRefusalIsOwed()) {
        const line = turnState.checkQueued ? CHECK_LATER_LINE : CHECK_NOT_HERE_LINE;
        const msg = String(system.input?.message ?? "").trim();
        system = { ...system, input: { ...(system.input ?? {}), message: msg ? `${line} ${msg}` : line } };
        log({ voice_check_later_said: call.id, round, on: "end_call" });
      }
      if (system) {
        yield chunk({
          tool_calls: [{
            index: 0,
            id: `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: system.name, arguments: JSON.stringify(system.input ?? {}) },
          }],
        });
        yield chunk({}, "tool_calls");
        yield SSE_DONE;
        log({ voice_turn: call.id, kind: context.kind, system_tool: system.name, ...timing() });
        return;
      }

      // Reason's CALL-side tools — hold, a new person on the line, a commitment, a quote. Run here,
      // offered on third-party calls as well, and checked against the list this context was built with
      // so a model that invents one on a call that was not offered it gets nothing.
      const callUses = toolUses.filter(t => (context.callTools ?? []).some(d => d.name === t.name));
      if (callUses.length) {
        if (round === MAX_VOICE_TOOL_ROUNDS) {
          // A machine on the line hears nothing useful from an apology: the turn just ends quietly.
          if (callOutcome.onAMachine(call) || callOutcome.reachedMachine(call)) {
            yield chunk({}, "stop");
            yield SSE_DONE;
            log({ voice_turn_out_of_rounds: call.id, kind: context.kind, on: "call_tools", machine: true, ...timing() });
            return;
          }
          yield* openingIfOwed();
          yield chunk({ content: said ? ` ${COME_BACK_LATER}` : COME_BACK_CHECK });
          yield chunk({}, "stop");
          yield SSE_DONE;
          log({ voice_turn_out_of_rounds: call.id, kind: context.kind, on: "call_tools", ...timing() });
          return;
        }
        if (!(await stillWanted())) {
          yield* endSuperseded(callUses[0].name, round);
          return;
        }
        // No filler before these. They answer from this process without a network call in them, so the
        // next sentence follows immediately and "one sec..." would be a pause that never happened.
        const fresh = db.getCall(call.conversation_id, call.id) ?? call;
        Object.assign(call, fresh);
        const results = [];
        for (const t of callUses) {
          let out;
          // Awaited because one of these is async: `make_a_call_for_me` authorizing a dial goes
          // through `call_place`, which is a real tool doing real work. The rest answer from this
          // process and resolve immediately, so awaiting them costs a microtask and nothing else.
          try { out = await runCallTool(t.name, t.input ?? {}, { call, context, log, turnState }); }
          catch (e) { out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
          if (t.name === "verify_caller" && out?.deferred) turnState.checkQueued = true;
          // make_a_call_for_me refused for the check (./fromcall.js go): owed out loud like any other.
          if (out?.blocked === "needs_verification") {
            turnState.checkRefused ??= said.length;
            if (out.queued) turnState.checkQueued = true;
          }
          // Words have already left this turn, and a refusal that says "ask them for the date" does not
          // know that. In the 2026-10-07 rehearsal that produced a call which asked the same question
          // twice in one breath, every turn: the model asked about the date, proposed the booking, was
          // told it did not have a date, and asked again — out loud, to somebody who had not had a
          // chance to answer the first one. The instruction is right and the timing is what is wrong,
          // so it is the timing that gets said.
          if (out && out.ok === false && out.say && roundText.trim()) {
            out.say += ` You have ALREADY spoken this turn. Do not say any of that again and do not ask again —`
              + ` if you have just asked them for something, stop talking now and wait for their answer.`;
          }
          // The same tool, refused, over and over inside one turn. In the rehearsal a proposal that was
          // missing a condition was made three times in a single turn with the identical input, which
          // spent the turn's whole round budget on an answer that was never going to change while
          // somebody held a handset. The answer does not change; what it is told to do next does.
          turnState.ran = turnState.ran ?? {};
          turnState.ran[t.name] = (turnState.ran[t.name] ?? 0) + 1;
          if (out && out.ok === false && out.say && turnState.ran[t.name] > 1) {
            out.say += ` That is ${turnState.ran[t.name]} times you have called ${t.name} in this one turn and the`
              + ` answer has not changed. Stop calling it. Either send it with what is actually missing, or say`
              + ` something out loud to the person on the line, who has been waiting through all of this.`;
          }
          log({ call_side_tool: t.name, call_id: call.id, ok: out?.ok !== false });
          toolDone(String(t.name), out?.ok !== false);
          // A recording said nobody can be reached this way, or a mailbox takes nothing. Hung up by code,
          // now, without a word: there is nothing to say to it and every second is billed.
          if (out?.endNow) {
            yield* endCallChunks(chunk, "a recording said nobody can be reached this way");
            log({ voice_turn: call.id, kind: context.kind, machine_dead_end: out.kind, rounds: round, ...timing() });
            return;
          }
          results.push({ type: "tool_result", tool_use_id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, content: JSON.stringify(out) });
        }
        messages.push({
          role: "assistant",
          content: [
            ...(roundText.trim() ? [{ type: "text", text: roundText }] : []),
            ...callUses.map(t => ({ type: "tool_use", id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, name: t.name, input: t.input ?? {} })),
          ],
        });
        closeOpenTools();
        startsSeen.clear();
        messages.push({ role: "user", content: results });
        continue;
      }

      // Reason's ORDINARY tools, run here. A third-party call has none — `reasonTools` is empty, so the
      // model was never offered any and anything claiming to be one is refused rather than run.
      if (!context.reasonTools.length) {
        log({ call_tool_refused: call.id, kind: context.kind, names: toolUses.map(t => t.name) });
        yield chunk({}, "stop");
        yield SSE_DONE;
        return;
      }

      // Nothing new to go on: a lookup already said where they are is not known, and this round only
      // asks again without coordinates. The question, now, not another round (owner's own call only —
      // an unverified caller was refused these by the gate and hears the refusal).
      if (owned && whereUnknown && toolUses.every(blindWhereCall)) {
        yield* askWhere("repeat_without_position", emit);
        return;
      }

      if (round === MAX_VOICE_TOOL_ROUNDS) {
        if (owned && whereUnknown) {
          yield* askWhere("out_of_rounds", emit);
          return;
        }
        // Out of rounds with nothing said. Better a sentence admitting it than a silent line — a refusal
        // for the caller check that nobody has heard yet is that sentence; else, on their own call, the
        // last words it wrote before its tools first ("search is down on my end, so I'll try a news site
        // directly"), so they hear what happened, not only a promise.
        if (checkRefusalIsOwed()) yield* checkRefusalOwed();
        else {
          if (owned && (!said.trim() || onlyHolding()) && replayable()) {
            log({ voice_lead_in_said: call.id, round, out_of_rounds: true });
            yield* emit(lastLeadIn);
          }
          yield chunk({ content: said ? ` ${COME_BACK_LATER}` : COME_BACK_LOOK });
        }
        yield chunk({}, "stop");
        yield SSE_DONE;
        log({ voice_turn_out_of_rounds: call.id, kind: context.kind, ...timing() });
        return;
      }

      // The filler, so the pause while a tool runs is not dead air — but only under the same rule as
      // at tool start: a silent turn, old enough, and never twice on a call. See `oneSec`.
      if (!(await stillWanted())) {
        yield* endSuperseded(toolUses[0].name, round);
        return;
      }
      yield* oneSec();

      messages.push({
        role: "assistant",
        content: [
          ...(roundText.trim() ? [{ type: "text", text: roundText }] : []),
          ...toolUses.map(t => ({ type: "tool_use", id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, name: t.name, input: t.input ?? {} })),
        ],
      });
      // Read the row again before the gate below reads `verified_at` off it. `verify_caller` runs in
      // the CALL-side branch above, which may have been an earlier round of this same turn, and it
      // writes to the database rather than to this object — so without this the check that just
      // passed would still look unpassed and the tool it was for would be refused.
      {
        const fresh = db.getCall(call.conversation_id, call.id);
        if (fresh) Object.assign(call, fresh);
      }
      const results = [];
      for (const t of toolUses) {
        // Checked before every tool, not once per round: the socket can close while the one before runs.
        if (!(await stillWanted())) {
          yield* endSuperseded(t.name, round);
          return;
        }
        let out;
        // The second check, in front of the ordinary gate rather than instead of it (2026-10-07
        // addendum, section 6). Caller ID said whose Reason to be; it did not say who is holding the
        // phone, so the first thing on this call that spends, books, sends or changes state stops
        // here. `confirm_record` is on the list because it is how a spoken yes becomes a granted
        // confirmation — exactly the thing that must not be grantable by whoever is on the line.
        if (call.is_owner && !verify.isVerified(call) && verify.isConsequential(t.name, t.input, { toSelf: (to) => contextDeps.toSelf?.(context.conversationId, to) ?? false })) {
          out = verify.gateRefusal({ call, name: t.name, input: t.input, log });
          turnState.checkRefused ??= said.length;
          if (out.queued) turnState.checkQueued = true;
          turnState.checkRefusedRound ??= round;
          log({ call_tool_needs_verification: t.name, call_id: call.id });
          toolDone(String(t.name), false);
          results.push({ type: "tool_result", tool_use_id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, content: JSON.stringify(out) });
          continue;
        }
        try {
          // Raced against the same deadlines as the model reads: a tool started early (no "One
          // sec...", the turn was too young) can run for `toolBudgetMs`, and the next round starts
          // after it — long enough, unwatched, for the platform's cascade timeout to end the call.
          out = yield* untilFirstWord(withinBudget(contextDeps.runTool(t.name, t.input ?? {}, {
            ...extras,
            conversationId: context.conversationId,
            kind: "user",
            // The gate reads the owner's own words itself rather than taking the model's word for a
            // yes, and on a call those words are what was said on the call. Same judge, same row.
            messages: context.messages,
            onCall: call.id,
          }), toolBudgetMs, { name: t.name }));
        } catch (e) {
          out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
        }
        if (out?.slow) log({ call_tool_over_budget: t.name, call_id: call.id, budget_ms: toolBudgetMs });
        // Only once get_location itself has looked (review 11-08): weather's own "give coordinates" before
        // anyone checked for a live share or a recent pin is not "unknown" yet.
        if (String(t.name) === "get_location") lookedForWhere = true;
        if (whereUnknownIn(String(t.name), out) && lookedForWhere) whereUnknown = true;
        else if (NEEDS_WHERE.has(String(t.name)) && out?.ok !== false && (out?.latitude != null || out?.now)) whereUnknown = false;
        log({ call_tool: t.name, call_id: call.id, ok: out?.ok !== false });
        // Ran, and how it came back: what the voice may say was done this turn rests on this (call 80).
        toolDone(String(t.name), out?.ok !== false && !out?.slow);
        // A send that went out: the words before it ("I'll text that to you") are not said after it as
        // if still to come. A last round with nothing to add says what is true now instead.
        if (SEND_TOOLS.has(String(t.name)) && out?.ok !== false && !out?.error && !out?.scheduled) lastLeadIn = [SENT_LINE];
        // Kept even when the platform has moved on: the search happened, and the next turn has to know.
        try { db.addCallLookup(call.conversation_id, call.id, lookupEntry({ name: t.name, input: t.input, out })); }
        catch { /* the record is a help, never a reason for the turn to fail */ }
        // The platform stopped listening while the tool ran. The result is not for anybody now.
        if (superseded()) {
          yield* endSuperseded(t.name, round);
          return;
        }
        results.push({ type: "tool_result", tool_use_id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, content: JSON.stringify(out) });
      }
      closeOpenTools();
      startsSeen.clear();
      messages.push({ role: "user", content: results });
    }

    // Out of rounds, having said nothing. Somebody is holding a handset, so this says a sentence.
    //
    // Reachable, and it took a rehearsal to find out: a model that keeps asking for a tool which is
    // REFUSED rather than run — the same menu key a third time, a transfer the owner has not agreed to
    // — goes round the loop on the `continue` paths above, which are deliberately before the
    // out-of-rounds guard because a refusal is not a round spent on a tool. Falling off the end then
    // produced an empty stream: no words, no finish reason, just `[DONE]`. Dead air is the worst answer
    // a phone call can give, and an unframed one is worse than that.
    if (checkRefusalIsOwed()) {
      log({ voice_check_later_said: call.id, after: "out_of_rounds" });
      yield* openingIfOwed();
      const line = turnState.checkQueued ? CHECK_LATER_LINE : CHECK_NOT_HERE_LINE;
      const content = said ? ` ${line}` : line;
      said += content;
      yield chunk({ content });
    } else if (owned && whereUnknown && (!said.trim() || onlyHolding())) {
      yield* askWhere("fell_through");
      return;
    } else if (!said || onlyHolding()) {
      log({ voice_turn_nothing_said: call.id, kind: context.kind, ...timing() });
      yield* openingIfOwed();
      yield chunk({ content: said ? NOTHING_SAID_AFTER : NOTHING_SAID_AFTER.trim() });
    }
    yield chunk({}, "stop");
  } catch (e) {
    // The request behind this turn was cancelled because the platform moved on. That is not the
    // model falling over, and nobody is listening for an apology.
    if (superseded()) {
      yield* endSuperseded("model");
      return;
    }
    log({ voice_turn_threw: call.id, why: (e?.message ?? String(e)).split("\n")[0], ...timing() });
    const before = said;
    yield* openingIfOwed();
    const lead = said !== before ? " " : "";
    yield chunk({ content: before ? ` ${BROKE_MID}` : `${lead}${BROKE_FIRST}` });
    yield chunk({}, "stop");
  }
  yield SSE_DONE;
}

/**
 * A tool's promise, or — past the call's budget — a result that tells the model what to do instead.
 *
 * The tool itself is NOT cancelled: `runTool` has no cancellation and the work it is doing may be
 * worth having. It finishes where it is, its result goes nowhere, and a rejection it throws later is
 * swallowed so an abandoned tool cannot become an unhandled rejection in the server.
 */
export function withinBudget(promise, budgetMs, { name = "that tool" } = {}) {
  let timer;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      ok: false,
      slow: true,
      say: `${name} is still running after ${Math.round(budgetMs / 1000)} seconds and a phone call cannot wait on it.`
        + ` Do not call it again on this call. Tell them in one sentence that you will text them the result, start the work`
        + ` as something that outlives the call — task_start with what they asked for — and carry on talking.`,
    }), budgetMs);
    timer.unref?.();
  });
  Promise.resolve(promise).catch(() => {});
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}

/** The tool list for one context, in the shape a generator wants: Reason's, plus the platform's. */
function offeredTools(context) {
  return [...context.reasonTools, ...(context.callTools ?? []), ...context.systemTools];
}

/**
 * The whole turn: identify, build, stream.
 *
 * Returns `{ status, headers, stream }` where `stream` is an async iterable of strings, or
 * `{ status, headers, body }` for a refusal. A refusal is still valid SSE when it is one the PHONE
 * will hear — a call Reason cannot place is told one line and hung up on, rather than left listening
 * to nothing; a body that is not JSON is a plain 400.
 */
export async function llmRequest({
  rawBody, headers = {}, generate = null, log = () => {}, now = clock.now(),
  // The harm screen, injected so a test can state a verdict rather than needing a model for one.
  screen = undefined,
  // The runtime's channels and call provider, handed through to every tool a turn runs.
  extras = {},
  // How long one of Reason's tools may hold the line; see `CALL_TOOL_BUDGET_MS`.
  toolBudgetMs = CALL_TOOL_BUDGET_MS,
  // How long a turn may say nothing before the holding line; see `FIRST_WORD_DEADLINE_MS`.
  firstWordDeadlineMs = FIRST_WORD_DEADLINE_MS,
  // The later holding-line deadline and the filler's minimum turn age; see `voiceTurn`.
  lateHoldingMs = LATE_HOLDING_MS,
  fillerAfterMs = FILLER_AFTER_MS,
  // How long a turn whose socket closed waits for the platform's retry to join it; see `ATTACH_GRACE_MS`.
  attachGraceMs = ATTACH_GRACE_MS,
  // Each of Reason's own tools as it starts; see `voiceTurn`. Only the turn this request starts tells it.
  onTool = null,
  // How long a turn on their own call waits for the facts closest to their words; see `voiceTurn`.
  recallWaitMs = CALL_RECALL_WAIT_MS,
}) {
  // The moment the platform's request arrived — the person has stopped talking — which is where the
  // caller's wait starts. Every turn timing in call_turns is measured from here.
  const t0 = Date.now();
  let body;
  try { body = JSON.parse(rawBody); } catch { body = null; }
  if (!body || typeof body !== "object") {
    // Calls 13 and 22 left no line at all in the journal. A body that will not parse is read for the
    // call id by hand, so the 400 can be tied to a call even though the platform hears nothing.
    const idIn = /"reason_call_id"\s*:\s*"?(\d+)/.exec(String(rawBody ?? ""));
    log({ voice_llm_bad_json: idIn ? Number(idIn[1]) : null, bytes: Buffer.byteLength(String(rawBody ?? "")) });
    return { status: 400, headers: JSONH, body: JSON.stringify({ error: { message: "bad json", type: "invalid_request_error" } }) };
  }

  // Somebody Reason does not know rang the number (src/calls/stranger.js): the pitch, with no call
  // row, no account, nobody's data and no tools. Marked by inbound.js on the call's extra body.
  const extra = (body?.extra_body ?? {}) || {};
  if (extra[EXTRA_BODY_KEYS.kind] === stranger.KIND) {
    log({ voice_llm_stranger: Array.isArray(body.messages) ? body.messages.length : 0 });
    return { status: 200, headers: SSEH, stream: stranger.strangerTurn({ body, generate: generatorFor(), sseChunk, SSE_DONE, log, now }) };
  }

  const found = identifyCall(body);
  if (!found.ok) {
    log({ voice_llm_no_call: found.why });
    // Somebody IS on a phone. One honest line and the call ends, rather than silence.
    return { status: 200, headers: SSEH, stream: refusalStream({ why: found.why, model: body.model }) };
  }

  const { call, kind } = found;
  // Every turn the platform asks for is logged as it arrives, before anything that can stall —
  // context, the screen, the model — so a request that came in and then went quiet is visible.
  log({ voice_llm_request: call.id, kind, messages: Array.isArray(body.messages) ? body.messages.length : 0 });

  // Building the context is the one step here that reaches out to everything else Reason is: the
  // database, the agent's own system prompt, the tool registry, memory, open work. Any of those
  // failing used to throw out of this function, and a 500 to the platform is dead air on a live
  // call. So it is tried, and a failure becomes a turn that says so (sections 7 and 9).
  let context;
  try {
    await prime();
    // Where they usually are (./callmemory.js): read while it rang, so this is normally already done.
    if (kind === "owner") await Promise.race([prepareCallMemory(call, { log }), new Promise(r => setTimeout(r, CALL_MEMORY_WAIT_MS).unref?.())]);
    context = contextFor({ call, kind, callMessages: body.messages, now });
  } catch (e) {
    const why = (e?.message ?? String(e)).split("\n")[0];
    log({ voice_context_failed: call.id, kind, why });
    // A third-party call IS its brief. With nothing loaded there is nothing it is safe to say to a
    // stranger on the owner's behalf, so it gets the one honest line and a hang-up.
    if (kind !== "owner") {
      return { status: 200, headers: SSEH, stream: refusalStream({ why: `context unavailable: ${why}`, model: body.model }) };
    }
    context = degradedContext({ call, callMessages: body.messages, why });
  }

  // One turn in flight per call. The platform asks for a turn whenever the person speaks or the line
  // goes quiet — and it also asks AGAIN for the same turn when it judges a reply failed: four to six
  // requests a second or so apart, the same history each time (2026-10-30 audit: 407 re-asks against
  // 267 turns over ten calls, 1.6–6.7 s of silence each). So:
  //   - the same history (nothing new from their side) joins the turn already running: what it has
  //     said so far, then the rest live. One model run, and every tool in it runs once.
  //   - anything new from their side cancels the running turn, whose stream still ends with a stop
  //     and `[DONE]`, and starts this one. On call 30 five turns ran at once, each re-doing the same
  //     research, and every later word was three seconds late for it.
  const key = `${call.conversation_id}#${call.id}`;
  const theirs = theirSideKey(body.messages);
  const earlier = inFlight.get(key);
  if (earlier && !earlier.over() && earlier.theirs === theirs && t0 - earlier.t0 < ATTACH_MAX_AGE_MS) {
    const reader = earlier.attach({ alreadySaid: trailingSaid(body.messages) });
    log({
      voice_turn_attached: call.id, kind, messages: Array.isArray(body.messages) ? body.messages.length : 0,
      buffered: reader.replaying, readers: earlier.readers(), since_first_ms: t0 - earlier.t0,
    });
    return { status: 200, headers: SSEH, stream: reader.stream, abort: reader.detach };
  }
  if (earlier && !earlier.over()) {
    log({ voice_turn_superseded: call.id, kind, reason: "new_from_their_side", readers: earlier.readers(), ms: t0 - earlier.t0 });
    log({ voice_turn_replaced: call.id, kind });
    earlier.cancel();
  }
  const control = new AbortController();

  const gen = generate ?? generatorFor();
  // One call_turns row per turn: what the caller waited through. Timed in memory from t0 and written
  // once the stream has ended, however it ended, so nothing touches the database before the first
  // byte. A request that joins this turn writes nothing of its own; a cancelled-and-restarted turn
  // with the same message count replaces the row. A database fault never costs the turn.
  const meter = callMetrics.newMeter();
  const msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const model = String(body.model ?? "reason");
  const streamId = `chatcmpl-${randomUUID()}`;
  let shared = null;
  const turn = voiceTurn({
    context, call, generate: gen, model, id: streamId, log, extras,
    signal: control.signal, toolBudgetMs, firstWordDeadlineMs, lateHoldingMs, fillerAfterMs, t0, meter, recallWaitMs,
    attended: () => shared.attended(),
    ...(onTool ? { onTool } : {}),
    ...(screen ? { screen } : {}),
  });
  const source = callMetrics.metered(turn, {
    t0, meter,
    // The disclosure is the code's words, read off the row, not the model's: never "real content".
    kinds: { ...METER_KINDS, openings: [String(call.announcement ?? "")].filter(s => s.trim()) },
    aborted: () => control.signal.aborted,
    onEnd: (m) => {
      try { db.recordCallTurn({ callId: call.id, conversationId: call.conversation_id, msgCount, kind, startedAt: t0, ...m }); }
      catch (e) { log({ call_turn_row_failed: call.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
      log({
        call_turn_heard: call.id, messages: msgCount, first_content_ms: m.firstContentMs, first_kind: m.firstContentKind,
        first_real_ms: m.firstRealMs, total_ms: m.totalMs, closed_early: m.closedEarly,
      });
    },
  });
  shared = sharedTurn({
    source, control, t0, theirs, streamId, model, graceMs: attachGraceMs,
    settle: () => { if (inFlight.get(key) === shared) inFlight.delete(key); },
    onUnread: () => log({ voice_turn_superseded: call.id, kind, reason: "socket_closed", ms: Date.now() - t0 }),
  });
  inFlight.set(key, shared);
  const reader = shared.attach();
  return {
    status: 200,
    headers: SSEH,
    stream: reader.stream,
    // For the server: this socket closed. The turn keeps going for `attachGraceMs` in case the
    // platform's retry joins it, and is cancelled if nobody does.
    abort: reader.detach,
  };
}

/** The turn in flight for each call, by `conversation#call`. See `llmRequest`. */
const inFlight = new Map();

/**
 * How long a turn nobody is reading is kept for a retry to join. The platform re-asks 1–1.5 s after a
 * failed attempt (2026-10-30 audit), so three seconds covers one retry with room. Past it the turn is
 * cancelled as it always was. While nobody reads it, it starts nothing with a side effect.
 */
export const ATTACH_GRACE_MS = 3_000;

/**
 * The oldest a running turn can be and still be joined. The platform gives up on a turn at its 15 s
 * cascade timeout, so a re-ask is never later than that; this is a backstop against joining a turn
 * that is stuck, not a tuning knob.
 */
const ATTACH_MAX_AGE_MS = 30_000;

/** Their side of a history: everything up to and including the last thing anybody but Reason said. */
const SILENT_THEIRS = new Set([LINE_IS_QUIET, LINE_OPENED]);
function theirSideKey(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let end = list.length;
  // Trailing words of Reason's own, or the platform's system notes, or an empty / quiet-line user
  // message, are not anything new from them.
  while (end > 0) {
    const m = list[end - 1];
    const text = typeof m?.content === "string" ? m.content.trim() : null;
    if (m?.role === "assistant" || m?.role === "system" || (m?.role === "user" && text !== null && (!text || SILENT_THEIRS.has(text)))) end--;
    else break;
  }
  return JSON.stringify(list.slice(0, end).map(m => [m?.role ?? "", m?.content ?? ""]));
}

/** What the platform says Reason has already said since their last words: the trailing assistant text. */
function trailingSaid(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.role === "system") continue;
    if (m?.role !== "assistant") break;
    if (typeof m.content === "string") out.unshift(m.content);
  }
  return out.join(" ");
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const HOLDING_SQUASHED = new Set([HOLDING_LINE, ...LATE_LINES].map(squash));

/** What one framed chunk carries, for replay decisions. */
function chunkInfo(s) {
  const str = String(s);
  if (str === SSE_DONE) return { done: true, finish: false, content: "" };
  try {
    const c = JSON.parse(str.slice(6))?.choices?.[0] ?? {};
    return { done: false, finish: c.finish_reason != null, content: typeof c.delta?.content === "string" ? c.delta.content : "" };
  } catch { return { done: false, finish: false, content: "" }; }
}

/**
 * One running turn that several requests can read.
 *
 * The turn is pulled only while somebody is waiting on it, so a turn nobody reads sits at its next
 * chunk rather than running ahead. Each reader gets the chunks from the start (a joining reader:
 * minus the holding line, which the first reader already had, and minus whatever the platform's own
 * history shows was said), then the rest as they come. Every reader's stream ends with `[DONE]`,
 * however the turn ends: a cancelled turn's readers get a stop and `[DONE]` at once.
 */
function sharedTurn({ source, control, t0, theirs, streamId, model, graceMs = ATTACH_GRACE_MS, settle = () => {}, onUnread = () => {} }) {
  const created = Math.floor(clock.now() / 1000);
  const chunks = [];
  const readers = new Set();
  let iterator = null;
  let pulling = null;
  let ended = false;
  let waiters = [];
  let attendWaiters = [];
  let grace = null;
  const wake = () => { const w = waiters; waiters = []; for (const f of w) f(); };
  const cancelled = () => control.signal.aborted;
  // A turn whose `[DONE]` is already out is finished, even before its generator has returned.
  let doneOut = false;
  const over = () => ended || doneOut || cancelled();
  const finish = () => { if (ended) return; ended = true; settle(); wake(); };
  // Closes the turn's own generator, so its finally blocks (the turn row, the model request) run.
  const closeSource = () => { if (iterator) Promise.resolve().then(() => iterator.return?.()).catch(() => {}); };
  const pull = () => {
    if (pulling || ended) return;
    if (cancelled()) { closeSource(); finish(); return; }
    iterator ??= source[Symbol.asyncIterator]();
    pulling = iterator.next().then(
      (step) => {
        if (step.done) return finish();
        const c = { s: step.value, ...chunkInfo(step.value) };
        if (c.done) doneOut = true;
        chunks.push(c);
      },
      () => finish(),
    ).finally(() => {
      pulling = null;
      if (cancelled() && !ended) { closeSource(); finish(); }
      wake();
      // After `[DONE]` nobody needs another chunk, but the turn still has its last lines to run (its
      // log line, its call_turns row): read it to the end.
      if (doneOut && !ended) pull();
    });
  };
  const cancel = () => {
    if (grace) { clearTimeout(grace); grace = null; }
    if (!cancelled()) control.abort();
    for (const f of attendWaiters.splice(0)) f(false);
    if (!pulling) { closeSource(); finish(); }
    wake();
  };

  function attach({ alreadySaid = "" } = {}) {
    const me = { open: true };
    readers.add(me);
    if (grace) { clearTimeout(grace); grace = null; }
    for (const f of attendWaiters.splice(0)) f(true);
    // What this reader is handed from before it joined, and what it skips of that.
    const replayEnd = chunks.length;
    let carried = squash(alreadySaid);
    const detach = () => {
      if (!me.open) return;
      me.open = false;
      readers.delete(me);
      if (readers.size || over()) return;
      grace = setTimeout(() => {
        grace = null;
        if (readers.size || over()) return;
        onUnread();
        cancel();
      }, Math.max(0, graceMs));
      grace.unref?.();
    };
    async function* stream() {
      let i = 0;
      let finished = false;
      try {
        for (;;) {
          // Let go of (its socket closed): nothing more is handed to it, so nothing is marked heard.
          if (!me.open) return;
          if (cancelled() && !ended) break;
          if (i < chunks.length) {
            const c = chunks[i++];
            if (i <= replayEnd && c.content) {
              const said = squash(c.content);
              // The holding line already went to a reader; it is never said twice. One that was
              // written while nobody was reading was never heard, so it is still said.
              if (HOLDING_SQUASHED.has(said) && c.delivered) continue;
              // Already in the platform's history as Reason's words: said, so not said again.
              if (carried && said && carried.startsWith(said)) { carried = carried.slice(said.length).trim(); continue; }
              carried = "";
            }
            if (c.finish) finished = true;
            c.delivered = true;
            yield c.s;
            if (c.done) {
              // `[DONE]` is already on the wire. The few lines the turn runs after it (its log, its
              // row) finish before this stream does, as they did when the turn was the stream.
              while (!ended && !cancelled()) await new Promise(resolve => { waiters.push(resolve); pull(); });
              return;
            }
            continue;
          }
          if (ended) break;
          await new Promise(resolve => { waiters.push(resolve); pull(); });
        }
        // Cancelled, or the turn ended without its own `[DONE]`: closed cleanly all the same.
        if (i === 0) yield sseChunk({ id: streamId, model, created, delta: { role: "assistant" } });
        if (!finished) yield sseChunk({ id: streamId, model, created, delta: {}, finish: "stop" });
        yield SSE_DONE;
      } finally {
        detach();
      }
    }
    return { stream: stream(), detach, replaying: replayEnd };
  }

  return {
    t0, theirs, attach, cancel, over,
    readers: () => readers.size,
    // True as soon as somebody reads this turn; false if it is cancelled first.
    attended: () => (readers.size ? Promise.resolve(true) : cancelled() ? Promise.resolve(false)
      : new Promise(resolve => attendWaiters.push(resolve))),
  };
}

const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const SSEH = { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" };

/** One line, then hang up: what a turn Reason cannot place sounds like on the phone. */
async function* refusalStream({ why, model = "reason" }) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(clock.now() / 1000);
  const chunk = (delta, finish = null) => sseChunk({ id, model, created, delta, finish });
  yield chunk({ role: "assistant" });
  yield chunk({ content: "I can't pick this one up. Something's wrong on my end, not yours." });
  yield chunk({
    tool_calls: [{
      index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function",
      function: { name: "end_call", arguments: JSON.stringify({ reason: why }) },
    }],
  });
  yield chunk({}, "tool_calls");
  yield SSE_DONE;
}

// ---------- the model behind the voice ----------

/**
 * Which backend answers a voice turn.
 *
 * `REASON_CALL_BACKEND` is the whole of Friday's switch: empty means the same backend every other
 * turn uses, so an install that sets nothing behaves exactly as it does now, and `api` pins the API
 * path for calls alone. That matters because the two are not interchangeable here — a headless CLI
 * start is seconds, and seconds of silence is what a phone call cannot have — while the rest of
 * Reason may still be running on the subscription.
 */
/**
 * The tools that really send something to somebody — by name, since a turn's tools include reads
 * (page_list, undo_send, message_effects are not sends; cold review, call 80). Shared with gptlive.js.
 */
/** Said after a send that ran, when the turn has nothing else to say (in place of its lead-in). */
export const SENT_LINE = "Sent.";
export const SEND_TOOLS = new Set(["message_send", "message_people", "email", "gmail_send", "document_send", "drive_send", "send_picture", "send_pictures", "voice_note_send", "voice_note_say", "spotify_send_link", "notice_send", "resend_contact_card", "event_blast", "event_cancel"]);

export function callBackendName() {
  const pinned = String(config.callBackend ?? "").trim().toLowerCase();
  // Never moved by a spend cap (owner, 2026-10-25): the call cap only texts him (src/spend.js).
  return pinned || (process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api");
}

/** The generator for the backend this install runs calls on. */
export function generatorFor(name = callBackendName()) {
  return name === "claude-cli" ? cliGenerator : apiGenerator;
}

/**
 * The request a voice turn sends, built in one place, so the warm-up below and the real turn send a
 * byte-identical prefix — the tools, then the system prompt, with the cache mark on it. Identical
 * bytes are the whole mechanism of a prompt-cache hit; two builders that drift by a character are
 * two cold prefills.
 */
function apiRequestFor({ system, tools, messages, maxTokens = 1024 }) {
  return {
    model: config.callModel || config.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages,
    ...(config.callThinking ? { thinking: { type: config.callThinking } } : {}),
  };
}

/**
 * Load this call's prompt into the model's cache before the first turn needs it.
 *
 * What a voice turn sends ahead of the person's words — every tool they have and the system prompt —
 * is about 120k tokens, and the first turn of a call paid to read all of it cold: measured on the
 * live install 2026-10-12, ~1.3s to the first token cold against ~0.75s once cached. The ring is the
 * time to pay it. The row has just been written and the phone has not been
 * picked up; a request now, one token out, means the first real turn reads the prefix warm and the
 * screen becomes the only thing in front of the first word.
 *
 * Never awaited by the ring and never throws: a warm-up that fails is a call exactly as slow as it
 * was before, and nothing else. Only on the API backend — the CLI has no cache to warm.
 */
export function warmCallCache({ call, log = () => {}, now = clock.now(), client = null }) {
  if (callBackendName() !== "api") return Promise.resolve({ warmed: false, why: "not the api backend" });
  if (!client && !process.env.ANTHROPIC_API_KEY) return Promise.resolve({ warmed: false, why: "no ANTHROPIC_API_KEY" });
  return (async () => {
    try {
      await prime();
      // The same words the first turn will send (./callmemory.js), so the warm prefix is the real one.
      if (Number(call.is_owner) === 1) await prepareCallMemory(call, { log });
      const context = contextFor({ call, kind: call.is_owner ? "owner" : "third_party", callMessages: [], now });
      const api = client ?? new (await import("@anthropic-ai/sdk")).default();
      const t0 = Date.now();
      const res = await api.messages.create(
        apiRequestFor({
          system: context.system, tools: offeredTools(context),
          // The messages sit after the cached prefix and are not part of it; one short line is enough.
          messages: [{ role: "user", content: "(warming up)" }],
          maxTokens: 1,
        }),
        { timeout: 20_000, maxRetries: 0 },
      );
      const u = res?.usage ?? {};
      countCall(config.callModel || config.model, u);
      log({ call_cache_warmed: call.id, ms: Date.now() - t0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 });
      return { warmed: true, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
    } catch (e) {
      const why = (e?.message ?? String(e)).split("\n")[0];
      countCall(config.callModel || config.model, null, e);
      log({ call_cache_warm_failed: call?.id, why });
      return { warmed: false, why };
    }
  })();
}

/**
 * The API path: real token streaming, which is the one that belongs on a phone.
 *
 * Text deltas go out as they arrive and a tool call is recognised the moment its block opens, so the
 * first word leaves while the rest of the sentence is still being written. Untestable offline — it
 * needs a key — so everything around it is injectable and the shape of what it yields is what the
 * tests pin.
 */
async function* apiGenerator({ system, messages, tools, log = () => {}, signal = null, onUsage = null }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const stream = await client.messages.create({
    // Short on purpose: this is two or three spoken sentences, and a ceiling that allows an essay is
    // a ceiling that allows forty seconds of monologue nobody can interrupt.
    ...apiRequestFor({ system, tools, messages, maxTokens: 1024 }),
    stream: true,
    // A turn the platform has moved on from closes its request too, instead of paying for tokens
    // nobody will hear.
  }, signal ? { signal } : {});

  let open = null;
  let json = "";
  // What the call cost, off the stream's own usage events (src/spend.js). Counted only: nothing
  // about how a call runs — backend, model, request — changes for it.
  const usage = {};
  for await (const ev of stream) {
    if (ev.type === "message_start" && ev.message?.usage) Object.assign(usage, ev.message.usage);
    if (ev.type === "message_delta" && ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      open = { name: ev.content_block.name, id: ev.content_block.id };
      json = "";
      // Said the moment the model starts a tool call, not when it has finished writing one. See
      // the filler in voiceTurn: a text it means to send is written out in full as the tool's input
      // before the block closes, and on call 35 that was 8 seconds of silence before "one sec".
      yield { type: "tool_start", name: open.name };
      continue;
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      yield { type: "text", text: ev.delta.text };
      continue;
    }
    if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      json += ev.delta.partial_json ?? "";
      continue;
    }
    if (ev.type === "content_block_stop" && open) {
      let input = {};
      try { input = json.trim() ? JSON.parse(json) : {}; } catch { input = {}; }
      yield { type: "tool_use", name: open.name, id: open.id, input };
      open = null;
      json = "";
    }
  }
  countCall(config.callModel || config.model, usage);
  onUsage?.(usage);
  log({ voice_backend: "api" });
}

/** Count one call request in the usage table. Never throws, never changes the call. */
function countCall(model, usage, error = null) {
  import("../spend.js").then(m => m.recordApi({ feature: "call", model, usage, error })).catch(() => {});
}

/**
 * The subscription path, through the `claude` CLI. One process, one answer, no streaming — the CLI
 * prints a result when it is done.
 *
 * It is here because it is what the rehearsal harness runs on: the words Omari reads before Friday
 * have to be real words from the real model, and this is the backend that costs nothing. It is NOT
 * what a real call should run on, and `callBackendName` is how that gets switched; the README says
 * so, and so does the setup checklist.
 */
async function* cliGenerator({ system, messages, tools, log = () => {}, onUsage = null }) {
  const { runClaudeCli } = await import("../backends/cli.js");
  // The CLI takes a prompt and a system prompt, not a message list, so the call so far is rendered
  // into the prompt. The tools are described rather than offered: without the MCP server attached
  // there is no tool loop here, and a tool it cannot call is one it must not pretend to.
  // Tool uses and their RESULTS are rendered, not dropped.
  //
  // They used to be: this filtered for `type === "text"` and threw the rest away, which was harmless
  // while the only tools were `end_call` and `language_detection` — neither answers with anything to
  // read. It stopped being harmless the moment a tool replied with an instruction. In the 2026-10-07
  // rehearsal a receptionist finally picked up after four minutes on hold, Reason called
  // `new_person_on_the_line`, was told "say who you are, say the call is recorded, then one sentence
  // on what you are calling about" — and never saw it. So it called the tool again, and again, until
  // the turn ran out of rounds, and the new person got "let me check on that and come back to you"
  // instead of the disclosure. Three separate things looked broken — the announcement being skipped,
  // the rounds being burnt, the model apparently ignoring its own tools — and all three were this.
  //
  // The API backend passes real `tool_result` blocks and never had the problem, so this is about the
  // REHEARSAL being faithful. Which matters, because the rehearsal is what gets read before Friday.
  const rendered = messages.map(m => {
    const who = m.role === "assistant" ? "You" : "Them";
    if (typeof m.content === "string") {
      return m.content.trim() ? `${who}: ${m.content.trim()}` : "";
    }
    if (!Array.isArray(m.content)) return "";
    const parts = [];
    for (const b of m.content) {
      if (b?.type === "text" && String(b.text ?? "").trim()) {
        parts.push(`${who}: ${String(b.text).trim()}`);
      } else if (b?.type === "tool_use") {
        parts.push(`You asked for: TOOL ${b.name} ${JSON.stringify(b.input ?? {})}`);
      } else if (b?.type === "tool_result") {
        // `say` is the half written to be acted on; the rest is shown raw so detail is still reachable.
        let said = "";
        try { said = JSON.parse(b.content ?? "{}")?.say ?? ""; } catch { /* not one of ours */ }
        parts.push(said
          ? `That tool answered. DO THIS NOW, in the words you speak next: ${said}`
          : `That tool answered: ${String(b.content ?? "").slice(0, 600)}`);
      }
    }
    return parts.join("\n");
  }).filter(Boolean).join("\n");

  // The tools, described from the list this turn was actually given rather than from a hard-coded pair.
  //
  // It used to name exactly two — `end_call` and `language_detection` — from when those were the only
  // two there were. Once there were eleven, the rehearsal became quietly misleading in the worst
  // direction: the model could see the prompt RULES telling it to press a key at a menu, had no idea
  // what the argument was called, and so called `play_keypad_touch_tone` with nothing in it. The call
  // then stalled on the menu and sat on hold until the budget ran out, and the printed transcript looked
  // like a model that did not understand phone menus rather than a harness that never told it the
  // argument name. The rehearsal is the thing the owner reads before Friday, so it has to be faithful
  // about this even though the API backend — which is what a real call runs on — passes real schemas and
  // never had the problem.
  const systemToolNote = tools.length
    ? `\n\nYou ask for a tool by writing a single line on its own, nothing else on that line:\n`
      + tools.map(t => {
        const props = t.input_schema?.properties ?? {};
        const required = new Set(t.input_schema?.required ?? []);
        // An example of the shape, required fields first, so what to write is unambiguous.
        // The shape of each field, not just its name. `"terms":"..."` taught the model to send a
        // string where an array belongs, `Array.isArray` then read it as "they attached no
        // conditions", and six proposals in a row were refused for leaving out a deposit the model
        // had been trying to report all along. A rehearsal that lies about the shape of an argument
        // is worse than one that does not mention it.
        const shape = (p) => {
          const t = p?.type;
          if (t === "array") return p?.items?.type === "string" ? `["...","..."]` : `[...]`;
          if (t === "integer" || t === "number") return `0`;
          if (t === "boolean") return `true`;
          if (t === "object") return `{}`;
          return `"..."`;
        };
        const fields = Object.keys(props)
          .sort((a, b) => (required.has(b) ? 1 : 0) - (required.has(a) ? 1 : 0))
          .map(k => `"${k}":${shape(props[k])}`)
          .join(",");
        return `TOOL ${t.name} {${fields}}`;
      }).join("\n")
      + `\nWrite your spoken words first, then the TOOL line if you need one.`
      + `\nUse the exact field names above. A tool line missing its required field does nothing at all.`
    : "";

  // Streamed, like the API path (drive 11-08 on OVH): the CLI's words are handed on as they are
  // written and a tool line is known the moment it starts, so a drive on this backend hears the same
  // waits a real call does. Before, the whole turn arrived at once at the end — 6–20 s of nothing that
  // was the CLI, not the call.
  const t0 = Date.now();
  let firstTextMs = null;
  const parse = cliLineStream();
  const queue = [];
  let wake = null;
  let finished = false;
  let deltas = 0;
  let r = null;
  const run = runClaudeCli({
    prompt: `${rendered}\n\nYou:`, system: `${system}${systemToolNote}`, feature: "call",
    onEvent: (e) => {
      const ev = e?.type === "stream_event" ? e.event : null;
      if (ev?.type !== "content_block_delta" || ev.delta?.type !== "text_delta") return;
      deltas++;
      firstTextMs ??= Date.now() - t0;
      queue.push(...parse.push(ev.delta.text ?? ""));
      wake?.();
    },
  }).then(x => { r = x; }, e => { r = { ok: false, error: e?.message ?? String(e) }; }).finally(() => { finished = true; wake?.(); });
  for (;;) {
    while (queue.length) yield queue.shift();
    if (finished) break;
    await new Promise(res => { wake = res; });
    wake = null;
  }
  await run;
  log({ voice_backend: "claude-cli", ok: r.ok, first_text_ms: firstTextMs, ms: Date.now() - t0 });
  if (r.envelope?.usage) onUsage?.(r.envelope.usage);
  if (!r.ok) throw new Error(r.error ?? "the CLI reported an error");
  // Nothing came as a stream (an older CLI): the printed result, read whole, as it always was.
  if (!deltas) {
    const all = cliLineStream();
    for (const ev of [...all.push(String(r.envelope?.result ?? "")), ...all.end()]) yield ev;
    return;
  }
  for (const ev of parse.end()) yield ev;
}

/**
 * The CLI's written turn, read as it streams: spoken words go out as they come, and a line of the
 * shape `TOOL name {...}` is held to its end — a `tool_start` the moment its name is written, then
 * the `tool_use` once the line is whole. A line that only began like one ("To…") is words.
 */
const CLI_TOOL_LINE = /^TOOL\s+([a-z_]+)\s*(\{.*\})?\s*$/i;
export function cliLineStream() {
  let line = "";
  let mode = null; // null: not known yet; "text": said as written; "tool": held to the line's end
  let started = false;
  const decide = (out) => {
    const s = line.replace(/^\s+/, "");
    if (!s) return;
    // Known as a tool call once its JSON has begun, written the way the prompt asks (upper-case TOOL):
    // "Tool up the volume" or a TOOL line that never becomes one is never a tool that started.
    if (/^TOOL\s+[a-z_]+\s*\{/.test(s)) {
      mode = "tool";
      if (!started) { started = true; out.push({ type: "tool_start", name: /^TOOL\s+([a-z_]+)/i.exec(s)[1] }); }
      return;
    }
    if ("TOOL ".startsWith(s.slice(0, 5)) || /^TOOL\s+[a-z_]*\s*$/.test(s)) return;
    mode = "text";
    out.push({ type: "text", text: line });
    line = "";
  };
  const lineEnd = (out) => {
    const whole = line.trim();
    const m = mode === "text" ? null : CLI_TOOL_LINE.exec(whole);
    if (m) {
      let input = {};
      try { input = m[2] ? JSON.parse(m[2]) : {}; } catch { input = {}; }
      if (!started) out.push({ type: "tool_start", name: m[1] });
      out.push({ type: "tool_use", name: m[1], input });
    } else if (line) out.push({ type: "text", text: line });
    line = ""; mode = null; started = false;
    return !!m;
  };
  return {
    push(text) {
      const out = [];
      for (const part of String(text ?? "").replace(/\r/g, "").split(/(\n)/)) {
        if (part === "\n") {
          // The end of a tool line is not words; the end of a spoken one is.
          if ((mode === "text" || !lineEnd(out))) out.push({ type: "text", text: "\n" });
          mode = null; started = false; line = "";
          continue;
        }
        if (!part) continue;
        if (mode === "text") { out.push({ type: "text", text: part }); continue; }
        line += part;
        if (mode === null) decide(out);
      }
      return out.filter(e => e.type !== "text" || e.text);
    },
    end() { const out = []; if (mode !== "text") lineEnd(out); return out.filter(e => e.type !== "text" || e.text.trim()); },
  };
}
