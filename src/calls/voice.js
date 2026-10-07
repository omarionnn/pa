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
import { config, clock, stamp } from "../config.js";
import { EXTRA_BODY_KEYS, CALL_KINDS } from "./elevenlabs.js";
import { callRulesFor } from "./provider.js";
import {
  VOICE_RULES, LANGUAGE_RULE, announcementAgainIn, ownerCallFrame, thirdPartyFrame,
} from "./voice-prompt.js";

/** The route ElevenLabs is pointed at. One place, because the setup doc quotes it. */
export const LLM_PATH = "/calls/elevenlabs/llm";

/**
 * The platform's own tools, which Reason triggers by answering with a standard OpenAI function call
 * and which the platform — not this process — carries out.
 *
 * They are the only two tools a third-party call has, and they are the reason a tool call has to be
 * able to leave this endpoint at all rather than being executed here like Reason's own.
 */
export const SYSTEM_TOOL_NAMES = ["end_call", "language_detection"];

/** The shape they are offered in, when the platform did not send its own list. */
export const SYSTEM_TOOLS = [
  {
    name: "end_call",
    description: "Hang up. Call this once the call is finished — the answer is had, or they cannot help, or they asked you to go.",
    input_schema: { type: "object", properties: { reason: { type: "string", description: "One short phrase: why the call is over." } } },
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
];

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
 * The opening line matters more here than anywhere else in this file. A call that answers with "how
 * can I help" has thrown away the only thing it has that a phone tree does not: it already knows
 * what is going on. So the opening is built from what is really open (see `openingFor`) and handed to
 * the model as the thing to lead with.
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
    ownerCallFrame({ name: me.name, opening: openingFor(conversationId, { now }) }),
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
export function thirdPartyContext({ call, callMessages = [] }) {
  const ownerName = accounts.ownerOf(call.conversation_id).name;
  const facts = Array.isArray(call.facts) ? call.facts : [];
  // The language the disclosure still owes being said in, claimed as it is read so it is asked for
  // exactly once. Empty on a call that never changed language, which is almost all of them.
  const owed = announcementOwedIn(call);

  const parts = [
    thirdPartyFrame({
      ownerName,
      goal: call.goal,
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
    reasonTools: [],
    systemTools: SYSTEM_TOOLS,
    language: callLanguage(call).language,
  };
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
    : thirdPartyContext({ call, callMessages });
}

/**
 * What Reason opens an owner call with, built from what is actually going on.
 *
 * Not a greeting. The owner's bar for this is that it "knows something he texted it that morning
 * without being told", and the way a call fails that bar is by opening with a question. So: the most
 * recent real thing — a job that is open, a call that just finished, something kept — in one short
 * line, handed to the model as the thing to lead with. Empty when there genuinely is nothing, and
 * then the model opens however it likes, which is the honest version of having nothing to say.
 */
export function openingFor(conversationId, { now = clock.now() } = {}) {
  const bits = [];

  // Open only — `listTasks` leaves closed ones out unless asked for them, which is what is wanted:
  // "you are in the middle of" is false about a job that finished yesterday.
  for (const t of db.listTasks(conversationId).slice(0, 2)) {
    if (t?.title) bits.push(`you are in the middle of "${t.title}"`);
  }

  // A call that ended in the last few hours, with what came of it. "the Carbone table's confirmed,
  // that why you're calling?" is this line.
  const recent = db.listCalls(conversationId, { limit: 3 })
    .find(c => c.id !== undefined && c.ended_at && now - c.ended_at < 6 * 60 * 60 * 1000 && (c.summary || c.outcome));
  if (recent) bits.push(`your call to ${recent.to_number} ${stamp(recent.ended_at)}: ${recent.summary || recent.outcome}`);

  if (!bits.length) return "";
  return bits.join("; ");
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
 * An owner call only. There is nobody to text on a third-party call — the person on the line is a
 * restaurant, and the owner hears about it afterwards with the summary and the audio.
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
export async function* voiceTurn({ context, call, generate, model = "reason", log = () => {}, id = null }) {
  const streamId = id ?? `chatcmpl-${randomUUID()}`;
  const created = Math.floor(clock.now() / 1000);
  const chunk = (delta, finish = null) => sseChunk({ id: streamId, model, created, delta, finish });

  // The first chunk of an OpenAI stream carries the role and nothing else.
  yield chunk({ role: "assistant" });

  const messages = [...context.messages];
  let said = "";
  let filled = false;

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
          // One leading space between sentences, because each piece was trimmed on the way through.
          const content = said ? ` ${spoken}` : spoken;
          said += content;
          yield chunk({ content });
        }
      };

      for await (const ev of generate({ system: context.system, messages, tools: offeredTools(context), log })) {
        if (ev?.type === "text") {
          roundText += ev.text ?? "";
          yield* emit(splitter.push(ev.text ?? ""));
          continue;
        }
        if (ev?.type === "tool_use") toolUses.push(ev);
      }
      yield* emit(splitter.flush());

      if (!toolUses.length) {
        yield chunk({}, "stop");
        yield SSE_DONE;
        log({ voice_turn: call.id, kind: context.kind, said: said.length, rounds: round });
        return;
      }

      // A tool the PLATFORM owns. It leaves as an OpenAI function call and the turn is over: ending
      // the call and switching language are both things only ElevenLabs can do.
      let system = toolUses.find(t => SYSTEM_TOOL_NAMES.includes(t.name));
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
        log({ voice_turn: call.id, kind: context.kind, system_tool: system.name });
        return;
      }

      // Reason's own tools, run here. A third-party call has none — `reasonTools` is empty, so the
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
        log({ voice_turn_out_of_rounds: call.id, kind: context.kind });
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
      const results = [];
      for (const t of toolUses) {
        let out;
        try {
          out = await contextDeps.runTool(t.name, t.input ?? {}, {
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
  } catch (e) {
    log({ voice_turn_threw: call.id, why: (e?.message ?? String(e)).split("\n")[0] });
    yield chunk({ content: said ? " Sorry, something broke on my end there." : "Sorry — something broke on my end. Say that again?" });
    yield chunk({}, "stop");
  }
  yield SSE_DONE;
}

/** The tool list for one context, in the shape a generator wants: Reason's, plus the platform's. */
function offeredTools(context) {
  return [...context.reasonTools, ...context.systemTools];
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

  await prime();
  const { call, kind } = found;
  const context = contextFor({ call, kind, callMessages: body.messages, now });
  const gen = generate ?? generatorFor();
  return {
    status: 200,
    headers: SSEH,
    stream: voiceTurn({ context, call, generate: gen, model: String(body.model ?? "reason"), log }),
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
    model: config.model,
    // Short on purpose: this is two or three spoken sentences, and a ceiling that allows an essay is
    // a ceiling that allows forty seconds of monologue nobody can interrupt.
    max_tokens: 1024,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages,
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
  const rendered = messages.map(m => {
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "";
    return text.trim() ? `${m.role === "assistant" ? "You" : "Them"}: ${text.trim()}` : "";
  }).filter(Boolean).join("\n");

  const systemToolNote = tools.some(t => t.name === "language_detection")
    ? `\n\nYou have two tools and you ask for one by writing a single line on its own, nothing else on that line:`
      + `\nTOOL end_call {"reason":"..."}`
      + `\nTOOL language_detection {"language":"es","reason":"..."}`
      + `\nWrite your spoken words first, then the TOOL line if you need one.`
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
