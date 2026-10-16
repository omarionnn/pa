// Reason's own brain, speaking. The endpoint ElevenLabs asks for every turn of every call.
//
// ElevenLabs Agents let an agent's LLM be an endpoint of yours implementing OpenAI **Chat
// Completions** over **SSE** — `data: {json}\n\n` chunks, ending `data: [DONE]\n\n`. That is what
// this is. The platform owns the phone line, the hearing, the speaking, the barge-in and the
// turn-taking; every word said is generated here, by the same Reason that answers their texts.
// ("Integrate your own model", read 2026-10-05/06.)
//
// Four things in this file are structural rather than instructions to a model, and each is here
// because asking nicely is not a guarantee:
//
//   1. **The bearer secret.** Without it this route is an unauthenticated way to spend the owner's
//      model credit and to have a stranger's questions answered out of somebody's private thread.
//      Compared in constant time, and with ELEVENLABS_LLM_SECRET unset every request is refused
//      rather than answered for free.
//   2. **Which call this is, read from the database and not from the body.** The request says which
//      call it belongs to; the row says whose Reason that is and what kind of call it is. If the two
//      disagree the turn is refused, because the difference between them is the difference between a
//      restaurant hearing a goal and a restaurant hearing somebody's calendar.
//   3. **Two context builders, and the third-party one has no way to reach a thread.** It is not a
//      prompt that says "do not mention their messages" — `thirdPartyContext` never loads a
//      conversation, never loads memory, and returns an empty tool list. The isolation is what is
//      *built*, which is why the test for it asserts on the context rather than on a model's answer.
//   4. **A URL is never spoken.** Not a rule in the prompt (though it is there too): any web address
//      in what the model wrote is taken OUT of the spoken words and queued as a text, during the
//      call, so it has landed by the time they hang up. "h t t p s colon slash slash" is not a link
//      anybody can use, and a model that forgets that once has read a URL down a phone.
//
// On streaming. Text is emitted as it arrives, but held back to the end of a sentence before it goes
// — which is what makes rule 4 above possible at all, since a web address split across two deltas
// could not be found in either. A sentence is also the unit a speech engine wants, so the cost is
// nothing: the first chunk goes as soon as the first sentence is done rather than when the whole
// reply is.
//
// NOTHING here has run against the real platform. There are no keys until 2026-10-09. The SSE shape,
// the bearer rejection, both context builders, the language switch and the URL rule are all pinned by
// tests with an injected generator; what is NOT proved is that ElevenLabs accepts this exact framing
// and sends these exact fields, and that is in docs/unverified.md rather than assumed here.
import { timingSafeEqual, randomUUID } from "node:crypto";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as harm from "../harm.js";
import { ledgerWrite } from "../trust.js";
import { config, clock, stamp } from "../config.js";
import { EXTRA_BODY_KEYS, CALL_KINDS } from "./elevenlabs.js";
import { callRulesFor } from "./provider.js";
import {
  VOICE_RULES, LANGUAGE_RULE, announcementAgainIn, ownerCallFrame, thirdPartyFrame,
} from "./voice-prompt.js";
import * as hold from "./hold.js";
import { WAITING_TOOLS, NEW_PERSON_TOOL, WAITING_RULES } from "./hold.js";
import * as callOutcome from "./outcome.js";
import * as commit from "./commit.js";
import { PROPOSE_TOOL, CONFIRM_TOOL, RELEASE_TOOL } from "./commit.js";
import * as errand from "./errand.js";
import { QUOTE_TOOL } from "./errand.js";
import { briefLines, buildBrief } from "./brief.js";
import { readBackInstruction, detail as readbackDetail, recordOf as recordOfDetails } from "./readback.js";
import * as verify from "./verify.js";
import * as fromcall from "./fromcall.js";
import { profileNote } from "./profile.js";

/** The route ElevenLabs is pointed at. One place, because the setup doc quotes it. */
export const LLM_PATH = "/calls/elevenlabs/llm";

/**
 * The platform's own tools, which Reason triggers by answering with a standard OpenAI function call
 * and which the platform — not this process — carries out.
 *
 * They are the reason a tool call has to be able to leave this endpoint at all rather than being
 * executed here like Reason's own.
 *
 * Every one of these has to be switched on on the agent in ElevenLabs, and the failure mode when one
 * is not is the quiet kind: the platform ignores a function call for a tool it does not have, so hold,
 * menus and voicemail all stop working while the call still sounds completely fine. They are in the
 * setup checklist as things the owner ticks, and `docs/calls-elevenlabs-setup.md` says why.
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
export const CALL_TOOLS = [NEW_PERSON_TOOL, PROPOSE_TOOL, CONFIRM_TOOL, RELEASE_TOOL, QUOTE_TOOL];

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

/** The filler that buys thinking time before a tool, rather than dead air. Their own suggestion. */
export const THINKING_FILLER = "... ";

// ---------- who is allowed in ----------

/**
 * Is this really ElevenLabs, carrying the secret this install configured?
 *
 * Constant time, because a byte-by-byte comparison of a secret is a way to learn the secret. No
 * secret configured is a no, not a yes: an endpoint that answers anybody is an endpoint that will
 * eventually answer somebody.
 */
export function verifyLlmBearer({ headers, secret = null }) {
  const want = String(secret ?? config.elevenLlmSecret ?? "");
  if (!want) {
    return { ok: false, why: "this machine has no ELEVENLABS_LLM_SECRET, so there is nothing to check a caller against and nothing is answered" };
  }
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  const raw = String(h.authorization ?? h["x-api-key"] ?? "").trim();
  const given = raw.replace(/^bearer\s+/i, "").trim();
  if (!given) return { ok: false, why: "no bearer token on the request" };
  const a = Buffer.from(want);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "the bearer token does not match ELEVENLABS_LLM_SECRET" };
  return { ok: true };
}

// ---------- which call is this ----------

/**
 * The call row this turn belongs to.
 *
 * Two routes in, because the two directions know different things about themselves:
 *
 *   - **Outbound.** Reason placed it, so it put its own ids into `custom_llm_extra_body` and they
 *     come back on every turn as `elevenlabs_extra_body`. Both ids are required and the row has to
 *     match both — an id without its conversation would be a call id anybody could count up to.
 *   - **Inbound.** Nothing of Reason's was in the request, because Reason did not start the call. The
 *     personalization webhook (./inbound.js) wrote a row with the platform's own conversation id on
 *     it while the phone was still ringing, and that id is what this looks up.
 *
 * `kind` comes off the ROW (`is_owner`), never off the body. The body's `reason_kind` is read only to
 * disagree with: a request that says third-party about a row that is an owner call, or the other way
 * round, is refused. One of those two is somebody's private thread read out to a stranger and the
 * other is Reason going mute on its own person, and neither should be reachable by editing a field.
 */
export function identifyCall(body, { provider = "elevenlabs" } = {}) {
  const extra = (body?.elevenlabs_extra_body ?? body?.extra_body ?? body?.custom_llm_extra_body ?? {}) || {};
  const callId = Number(extra[EXTRA_BODY_KEYS.callId]);
  const conversationId = String(extra[EXTRA_BODY_KEYS.conversationId] ?? "").trim();
  const saidKind = String(extra[EXTRA_BODY_KEYS.kind] ?? "").trim();

  let call = null;
  if (Number.isInteger(callId) && callId > 0 && conversationId) {
    call = db.getCall(conversationId, callId);
    if (!call) return { ok: false, why: `there is no call #${callId} on ${conversationId}` };
  } else {
    // Inbound. Every name the platform might carry its own conversation id under, in the order they
    // are documented; `user_id` last, because it is the one their docs describe loosest.
    const external = [
      body?.conversation_id, body?.conversationId, body?.elevenlabs_conversation_id, body?.user_id,
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
export function ownerContext({ call, callMessages = [], now = clock.now() }) {
  const conversationId = call.conversation_id;
  const me = accounts.ownerOf(conversationId);
  const { systemFor } = contextDeps;

  const lang = callLanguage(call);
  const parts = [
    systemFor(me),
    `--- you are ON A PHONE CALL right now, not texting ---`,
    VOICE_RULES,
    LANGUAGE_RULE,
    ownerCallFrame({ name: me.name }),
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

  const parts = [
    thirdPartyFrame({
      ownerName,
      goal: brief.goal || call.goal,
      facts,
      // Rebuilt rather than read off the row: the rules are the terms of every call and they are
      // built in code in exactly one place (src/calls/provider.js), so a row written by an older
      // version cannot be a call with weaker rules on it.
      rules: callRulesFor({ ownerName }),
      announcement: call.announcement ?? "",
    }),
    `--- you are ON A PHONE CALL right now ---`,
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
 * The call so far, as ElevenLabs sends it, turned into model messages.
 *
 * Their request carries OpenAI-shaped `messages`. The system message in it is dropped on purpose:
 * the system prompt for this turn is Reason's, built above, and an agent-level prompt configured in
 * their dashboard is not a thing that gets to edit it.
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
 * Two things from ElevenLabs' own docs shape this ("Transfer to number", read 2026-10-06). A conference
 * transfer **removes the agent from the call**, so after this Reason is not on the line to apologise or
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
  systemFor: null, toolsFor: null, runTool: null, openWorkNote: () => "", keptNote: () => "",
};

let primed = null;
export async function prime() {
  if (primed) return contextDeps;
  primed = (async () => {
    const [agent, tools, openwork, kept] = await Promise.all([
      import("../agent.js"), import("../tools.js"), import("../openwork.js"), import("../kept.js"),
    ]);
    contextDeps.systemFor = agent.systemFor;
    contextDeps.toolsFor = tools.toolsFor;
    contextDeps.runTool = tools.runTool;
    contextDeps.openWorkNote = openwork.openWorkNote;
    contextDeps.keptNote = kept.keptNote;
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

  // The first chunk of an OpenAI stream carries the role and nothing else.
  yield chunk({ role: "assistant" });

  const messages = [...context.messages];
  let said = "";
  let filled = false;
  // Scratch for things that may happen at most ONCE in a turn however many rounds it takes. See the
  // `new_person_on_the_line` branch in `runCallTool`.
  const turnState = {};

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
      }))
      .catch(e => ({ verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] }))
    : null;

  try {
    for (let round = 0; round <= MAX_VOICE_TOOL_ROUNDS; round++) {
      const splitter = sentenceSplitter();
      const toolUses = [];
      let roundText = "";

      const emit = function* (pieces) {
        for (const piece of pieces) {
          const { spoken, links } = withoutSpokenLinks(piece);
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
          // Thinking out loud, down a phone line. Dropped rather than cleaned, because there is no
          // useful half of it, and logged, because the real fix is the prompt and this is the floor.
          if (aNoteToItself(spoken)) {
            log({ voice_self_note_dropped: call.id, text: spoken.slice(0, 80) });
            continue;
          }
          // One leading space between sentences, because each piece was trimmed on the way through.
          const content = said ? ` ${spoken}` : spoken;
          said += content;
          if (!firstContentAt) firstContentAt = clock.now();
          yield chunk({ content });
        }
      };

      const gen = generate({ system: context.system, messages, tools: offeredTools(context), log });
      // On the screened round the model request is put in flight NOW, read ahead into a buffer, so
      // the screen below is read while the first token is already on its way (see `eagerly`).
      const events = round === 0 && screening ? eagerly(gen) : gen;

      // Read the screen before a word leaves, and only on the first round — the later rounds are
      // Reason's own tool results, not anything anybody said. A 'harm' verdict throws the reply away
      // unspoken: it was generated in parallel, which is what bought the latency, and it is not what
      // goes out.
      if (round === 0 && screening) {
        const read = await screening;
        const verdict = harm.VERDICTS.includes(read?.verdict) ? read.verdict : "unscreened";
        if (read?.skipped) log({ harm_screen_skipped: read.skipped, call: call.id });
        if (verdict === "harm" || verdict === "crisis") {
          const done = refuseOnCall({ call, text: spokenByThem, verdict, category: read?.category, note: read?.note, log });
          yield chunk({ content: done.line });
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

      for await (const ev of events) {
        if (ev?.type === "text") {
          roundText += ev.text ?? "";
          yield* emit(splitter.push(ev.text ?? ""));
          continue;
        }
        if (ev?.type === "tool_use") toolUses.push(ev);
      }
      yield* emit(splitter.flush());

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
        const left = hold.noteVoicemail(call, { message: roundText, log });
        yield* endCallChunks(chunk, left.left ? "left the voicemail" : "a machine answered; nothing to leave");
        log({ voice_turn: call.id, kind: context.kind, voicemail_left: left.left, rounds: round, ...timing() });
        return;
      }

      if (!toolUses.length) {
        yield chunk({}, "stop");
        yield SSE_DONE;
        log({ voice_turn: call.id, kind: context.kind, said: said.length, rounds: round, ...timing() });
        return;
      }

      // A tool the PLATFORM owns. It leaves as an OpenAI function call and the turn is over: ending
      // the call, switching language, waiting, pressing keys and hanging up on a machine are all
      // things only ElevenLabs can do.
      let system = toolUses.find(t => SYSTEM_TOOL_NAMES.includes(t.name));

      // Waiting. The platform stays silent; the budget is ours, because their silence timer measures
      // silence and hold music is audio. Out of budget, the call rings off politely rather than sitting
      // there — and that is an outcome of its own, not a failure.
      if (system?.name === "skip_turn") {
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
          log({ call_menu_refused: call.id, asked: String(asked.dtmf_tones ?? "").slice(0, 40), stuck: press.stuck === true });
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

      // The hang-up after a machine answered. Whatever is in `message` is what the mailbox gets, and
      // it is the only thing that makes this a voicemail left rather than a machine reached.
      if (system?.name === "end_call" && callOutcome.reachedMachine(call)) {
        const words = [roundText, system.input?.message].map(s => String(s ?? "").trim()).filter(Boolean).join(" ");
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
          yield chunk({ content: said ? " Let me come back to you on that one." : "Sorry — let me check on that and come back to you." });
          yield chunk({}, "stop");
          yield SSE_DONE;
          log({ voice_turn_out_of_rounds: call.id, kind: context.kind, on: "call_tools", ...timing() });
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
          results.push({ type: "tool_result", tool_use_id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, content: JSON.stringify(out) });
        }
        messages.push({
          role: "assistant",
          content: [
            ...(roundText.trim() ? [{ type: "text", text: roundText }] : []),
            ...callUses.map(t => ({ type: "tool_use", id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, name: t.name, input: t.input ?? {} })),
          ],
        });
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

      if (round === MAX_VOICE_TOOL_ROUNDS) {
        // Out of rounds with nothing said. Better a sentence admitting it than a silent line.
        yield chunk({ content: said ? " Let me come back to you on that one." : "Sorry — let me look into that and come back to you." });
        yield chunk({}, "stop");
        yield SSE_DONE;
        log({ voice_turn_out_of_rounds: call.id, kind: context.kind, ...timing() });
        return;
      }

      // The filler, once, so the pause while a tool runs is not dead air. Their own suggestion: a
      // chunk ending in "... " buys the time without the person thinking the line dropped.
      if (!filled) {
        filled = true;
        yield chunk({ content: said ? THINKING_FILLER : `One sec${THINKING_FILLER}` });
      }

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
        let out;
        // The second check, in front of the ordinary gate rather than instead of it (2026-10-07
        // addendum, section 6). Caller ID said whose Reason to be; it did not say who is holding the
        // phone, so the first thing on this call that spends, books, sends or changes state stops
        // here. `confirm_record` is on the list because it is how a spoken yes becomes a granted
        // confirmation — exactly the thing that must not be grantable by whoever is on the line.
        if (call.is_owner && !verify.isVerified(call) && verify.isConsequential(t.name)) {
          out = verify.gateRefusal({ call, name: t.name });
          log({ call_tool_needs_verification: t.name, call_id: call.id });
          results.push({ type: "tool_result", tool_use_id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, content: JSON.stringify(out) });
          continue;
        }
        try {
          out = await contextDeps.runTool(t.name, t.input ?? {}, {
            ...extras,
            conversationId: context.conversationId,
            kind: "user",
            // The gate reads the owner's own words itself rather than taking the model's word for a
            // yes, and on a call those words are what was said on the call. Same judge, same row.
            messages: context.messages,
            onCall: call.id,
          });
        } catch (e) {
          out = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
        }
        log({ call_tool: t.name, call_id: call.id, ok: out?.ok !== false });
        results.push({ type: "tool_result", tool_use_id: t.id ?? `tu_${randomUUID().slice(0, 8)}`, content: JSON.stringify(out) });
      }
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
    if (!said) {
      log({ voice_turn_nothing_said: call.id, kind: context.kind, ...timing() });
      yield chunk({ content: "Sorry — bear with me one moment." });
    }
    yield chunk({}, "stop");
  } catch (e) {
    log({ voice_turn_threw: call.id, why: (e?.message ?? String(e)).split("\n")[0], ...timing() });
    yield chunk({ content: said ? " Sorry, something broke on my end there." : "Sorry — something broke on my end. Say that again?" });
    yield chunk({}, "stop");
  }
  yield SSE_DONE;
}

/** The tool list for one context, in the shape a generator wants: Reason's, plus the platform's. */
function offeredTools(context) {
  return [...context.reasonTools, ...(context.callTools ?? []), ...context.systemTools];
}

/**
 * The whole request: verify, identify, build, stream.
 *
 * Returns `{ status, headers, stream }` where `stream` is an async iterable of strings, or
 * `{ status, headers, body }` for a refusal. A refusal is still valid SSE when it is one the PHONE
 * will hear — a call Reason cannot place is told one line and hung up on, rather than left listening
 * to nothing — while a request that failed the bearer check gets a plain 401 and no words at all,
 * because whoever sent it is not on a phone.
 */
export async function llmRequest({
  rawBody, headers, generate = null, log = () => {}, secret = null, now = clock.now(),
  // The harm screen, injected so a test can state a verdict rather than needing a model for one.
  screen = undefined,
  // The runtime's channels and call provider, handed through to every tool a turn runs.
  extras = {},
}) {
  const auth = verifyLlmBearer({ headers, secret });
  if (!auth.ok) {
    log({ voice_llm_rejected: auth.why });
    return { status: 401, headers: JSONH, body: JSON.stringify({ error: { message: `rejected: ${auth.why}`, type: "unauthorized" } }) };
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { body = null; }
  if (!body || typeof body !== "object") {
    return { status: 400, headers: JSONH, body: JSON.stringify({ error: { message: "bad json", type: "invalid_request_error" } }) };
  }

  const found = identifyCall(body);
  if (!found.ok) {
    log({ voice_llm_no_call: found.why });
    // Somebody IS on a phone. One honest line and the call ends, rather than silence.
    return { status: 200, headers: SSEH, stream: refusalStream({ why: found.why, model: body.model }) };
  }

  const { call, kind } = found;

  // Building the context is the one step here that reaches out to everything else Reason is: the
  // database, the agent's own system prompt, the tool registry, memory, open work. Any of those
  // failing used to throw out of this function, and a 500 to the platform is dead air on a live
  // call. So it is tried, and a failure becomes a turn that says so (sections 7 and 9).
  let context;
  try {
    await prime();
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

  const gen = generate ?? generatorFor();
  return {
    status: 200,
    headers: SSEH,
    stream: voiceTurn({
      context, call, generate: gen, model: String(body.model ?? "reason"), log, extras,
      ...(screen ? { screen } : {}),
    }),
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
  yield chunk({ content: "Sorry — I can't pick this one up. Something's wrong on my end, not yours." });
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
export function callBackendName() {
  const pinned = String(config.callBackend ?? "").trim().toLowerCase();
  if (pinned) return pinned;
  return process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api";
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
  };
}

/**
 * Load this call's prompt into the model's cache before the first turn needs it.
 *
 * What a voice turn sends ahead of the person's words — every tool they have and the system prompt —
 * is about 120k tokens, and the first turn of a call paid to read all of it cold: measured on the
 * live install 2026-10-12, ~1.3s to the first token cold against ~0.75s once cached. The ring is the
 * time to pay it. The personalization webhook has just written the row and the phone has not been
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
      log({ call_cache_warmed: call.id, ms: Date.now() - t0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 });
      return { warmed: true, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
    } catch (e) {
      const why = (e?.message ?? String(e)).split("\n")[0];
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
async function* apiGenerator({ system, messages, tools, log = () => {} }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const stream = await client.messages.create({
    // Short on purpose: this is two or three spoken sentences, and a ceiling that allows an essay is
    // a ceiling that allows forty seconds of monologue nobody can interrupt.
    ...apiRequestFor({ system, tools, messages, maxTokens: 1024 }),
    stream: true,
  });

  let open = null;
  let json = "";
  for await (const ev of stream) {
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      open = { name: ev.content_block.name, id: ev.content_block.id };
      json = "";
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
  log({ voice_backend: "api" });
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
async function* cliGenerator({ system, messages, tools, log = () => {} }) {
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

  const r = await runClaudeCli({ prompt: `${rendered}\n\nYou:`, system: `${system}${systemToolNote}` });
  log({ voice_backend: "claude-cli", ok: r.ok });
  if (!r.ok) throw new Error(r.error ?? "the CLI reported an error");

  const said = String(r.envelope?.result ?? "").trim();
  const lines = said.split("\n");
  const spoken = [];
  const asked = [];
  for (const line of lines) {
    const m = /^TOOL\s+([a-z_]+)\s*(\{.*\})?\s*$/i.exec(line.trim());
    if (m) {
      let input = {};
      try { input = m[2] ? JSON.parse(m[2]) : {}; } catch { input = {}; }
      asked.push({ type: "tool_use", name: m[1], input });
      continue;
    }
    spoken.push(line);
  }
  const text = spoken.join("\n").trim();
  if (text) yield { type: "text", text };
  for (const a of asked) yield a;
}
