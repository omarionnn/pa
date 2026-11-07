// GPT-Live (OpenAI `gpt-live-1`): the voice of every Reason phone call, over Twilio. It is the only
// voice Reason has.
//
// The split is the whole design: GPT-Live is only the VOICE. It listens, speaks and decides when to
// ask for help; every question and every action goes to Reason through CLIENT delegation — the
// `llmRequest` turn in src/calls/voice.js, with its context, tools, memory, harm screen, confirm gate
// and NO_REPLY / spoken-args filtering. No OpenAI model does Reason's thinking.
//
// Who gets it: REASON_CALL_PROVIDER=gptlive makes it the call provider (`GptLiveCallProvider`), so
// every call — own, business, ring-back, inbound — is GPT-Live. REASON_CALL_VOICE /
// REASON_THIRD_PARTY_VOICE (gptlive, or owner for the operator only) put it in front of another
// provider instead (`withGptLive`); with REASON_CALL_PROVIDER=gptlive they change nothing.
//
// The phone line: Twilio Media Streams. Twilio carries the call and streams 8 kHz μ-law both ways over
// a WebSocket to /calls/gptlive/stream/{token}; this file relays it to a GPT-Live WebSocket session,
// which takes μ-law natively (audio/pcmu), so audio is forwarded byte for byte. Outbound, Reason asks
// Twilio to dial with that stream as the call's TwiML. Inbound, the number's voice webhook points at
// /calls/gptlive/inbound (`inboundTwiml`). Both need TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
// TWILIO_FROM_NUMBER and OPENAI_API_KEY.
//
// Docs read 2026-10-31: developers.openai.com/api/docs/guides/live, live-delegation (client mode),
// voice-websockets (pcmu 8k), voice-server-controls (playback control), live-conversations (greeting,
// usage, close), voice-sip, live-partner-integrations (Twilio Media Streams).
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config, clock, normalizeNumber } from "../config.js";
import { llmRequest, withoutSilenceMarker, METER_KINDS, THINKING_FILLER, generatorFor } from "./voice.js";
import { recordingFileFor } from "./recordings.js";
import { writeCallIntoThread, noteOnTask, tellTheOwner, noteThirdPartyTurns } from "./postcall.js";
import * as fromcall from "./fromcall.js";
import { thirdPartyIdentity, callIdentityFor, NO_NAME, speakToThem } from "./voice-prompt.js";
import * as hold from "./hold.js";
import * as callOutcome from "./outcome.js";
import { makerLine } from "../maker.js";
import { CallProvider, announcementFor, callRulesFor } from "./provider.js";
import { briefLines } from "./brief.js";
import { recordingNoticeFor } from "./consent.js";
import * as ambience from "./ambience.js";
import * as opener from "./opener.js";
import { goalPending } from "./goalmet.js";
import { openingLineFor, recordingNoteFor, whoseCallIsThis, strangerIntake, overCallCap } from "./inbound.js";
import * as strangerCall from "./stranger.js";
import * as strangerCalls from "../strangercalls.js";

export const PROVIDER = "gptlive";
export const STREAM_PATH = "/calls/gptlive/stream/";
export const STATUS_PATH = "/calls/gptlive/status/";
export const INBOUND_PATH = "/calls/gptlive/inbound";
export const AMD_PATH = "/calls/gptlive/amd/";
const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
/** $0.05 a minute for the voice layer (developers.openai.com/api/docs/models/gpt-live-1, 2026-10-31). */
export const CENTS_PER_MINUTE = 5;
/** The external id prefix, so a check() can tell a GPT-Live call from another provider's id. */
const EXT = "gptlive:";

// ---------- who gets it ----------

/** REASON_CALL_VOICE read: "everyone" (gptlive / on), "owner" (the operator only) or "" (off). */
export function gptliveMode(v = config.callVoice) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "owner") return "owner";
  return ["gptlive", "on", "everyone", "1", "true", "yes"].includes(s) ? "everyone" : "";
}

/** REASON_THIRD_PARTY_VOICE read, the same way: calls to businesses and other people (phase 3). */
export const thirdPartyMode = (v = config.thirdPartyVoice) => gptliveMode(v);

/** Is any GPT-Live route listened for at all? */
export const gptliveOn = () => gptliveIsProvider() || gptliveMode() !== "" || thirdPartyMode() !== "";

/** Is GPT-Live the call provider itself (REASON_CALL_PROVIDER=gptlive)? Then it is every call's voice. */
export const gptliveIsProvider = () => String(config.callProvider ?? "").trim().toLowerCase() === PROVIDER;

/**
 * Is GPT-Live the voice for the calls this account's Reason makes to OTHER people — a business, a
 * receptionist, a place ringing back (Omari, 2026-10-31: phase 3)? Everyone's on "gptlive"; the
 * operator's only on "owner", so his errands prove it first.
 */
export function thirdPartyVoiceFor(conversationId) {
  const mode = gptliveIsProvider() ? "everyone" : thirdPartyMode();
  if (!mode || !conversationId) return false;
  try {
    const me = accounts.ownerOf(conversationId);
    return mode === "everyone" ? me?.known === true : me?.isOperator === true;
  } catch { return false; }
}

/**
 * Is GPT-Live the voice for this account's own calls? Everyone with an account on "everyone"; only the
 * operator on "owner". Keyed on the call's own conversation, so it is that person's Reason either way.
 */
export function gptliveFor(conversationId) {
  const mode = gptliveIsProvider() ? "everyone" : gptliveMode();
  if (!mode || !conversationId) return false;
  try {
    const me = accounts.ownerOf(conversationId);
    return mode === "everyone" ? me?.known === true : me?.isOperator === true;
  } catch { return false; }
}

/** What this machine is missing to place a GPT-Live call. Empty when it can. */
export function missingForGptlive() {
  const need = {
    OPENAI_API_KEY: config.openaiKey, TWILIO_ACCOUNT_SID: config.twilioSid, TWILIO_AUTH_TOKEN: config.twilioToken,
    TWILIO_FROM_NUMBER: config.twilioFrom, REASON_PUBLIC_URL: config.publicUrl,
  };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}

// ---------- what the voice is told ----------

/**
 * Who is on the line, for the voice's instructions, from the account whose conversation this call is.
 */
export function whoFor(call) {
  let me = null;
  try { me = accounts.ownerOf(call.conversation_id); } catch { /* unknown conversation */ }
  const raw = me?.name || "";
  const named = !!raw && raw !== NO_NAME;
  // Only this call's own account, by the call row's conversation — never anyone else's. No profile:
  // the voice gets the name and nothing more (the backend has the rest, per turn, for this person).
  const own = !!call.is_owner;
  return {
    name: named ? raw : "them", named, owner: own, identity: callIdentityFor(call.conversation_id),
    ...(own ? { brief: preCallBrief(call), purpose: openingPurpose(call) } : {}),
  };
}

/**
 * Roughly where they are, for one own call's small talk, once it is known (it is looked up while the
 * call dials and never waited on): handed to the session like anything else told mid-call (`tellLive`).
 */
export function notePlace(callId, label) {
  const l = String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!l) return false;
  return tellLive(callId, placeLine(l));
}

const placeLine = (place) => `Roughly where they are right now (they share their location with you): ${place}. Fine for a light, relevant bit of small talk; never say an address.`;

const clip = (t, n) => {
  const x = String(t ?? "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x;
};

/** The words of one thread message, text parts only. */
const wordsOf = (m) => typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "";

/**
 * A few lines from this person's own recent chat, newest last — for a warm start and small talk, never
 * as facts to answer from. Only the call row's own conversation is read (sealed per person).
 */
export function recentChatLines(conversationId, { max = 6, chars = 700 } = {}) {
  let thread = [];
  try { thread = db.loadConversation(conversationId); } catch { return []; }
  const out = [];
  let used = 0;
  for (const m of thread.slice(-30).reverse()) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    // Their lines carry "[time] Name: " in front; the time and name are not for the voice.
    const raw = wordsOf(m).replace(/^\s*\[[^\]]*\]\s*[^:\n]{1,40}:\s*/, "");
    const line = clip(raw, 150);
    if (!line || /NO_REPLY/.test(line)) continue;
    const next = `${m.role === "user" ? "them" : "you"}: ${line}`;
    if (used + next.length > chars) break;
    out.unshift(next);
    used += next.length;
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The pre-call brief for a person's own call (Omari, 2026-11-01: warmer, chattier own calls that lead
 * with why Reason rang). Why it rang and what it brought (a call Reason placed), a few lines from
 * their recent chats, and — only while they share their location with Reason — roughly where they
 * are. Everything here is this call's own person's; nothing for any other call.
 */
export function preCallBrief(call, { place = "" } = {}) {
  if (!call?.is_owner) return "";
  const lines = [];
  if (call.direction !== "in") {
    const goal = clip(call.goal, 300);
    if (goal) lines.push(`Why you rang them: ${goal}`);
    const facts = (Array.isArray(call.facts) ? call.facts : (() => { try { return JSON.parse(call.facts ?? "[]"); } catch { return []; } })())
      .map(f => clip(f, 160)).filter(Boolean).slice(0, 5);
    if (facts.length) lines.push(`What you've got for it:\n${facts.map(f => `- ${f}`).join("\n")}`);
  }
  const chat = recentChatLines(call.conversation_id);
  if (chat.length) lines.push(`Lately in your chats:\n${chat.join("\n")}`);
  if (place) lines.push(placeLine(place));
  if (!lines.length) return "";
  return `PRE-CALL BRIEF — background for you, so the call starts warm and on point. Anything they ask still goes to Reason.\n${lines.join("\n")}`;
}

/** Why Reason is ringing, for the opening line, when the line itself does not already say it. */
export function openingPurpose(call) {
  if (!call?.is_owner || call.direction === "in" || call.timer_id) return "";
  const greeting = String(call.announcement ?? "");
  if (!/what's up\?\s*$/i.test(greeting)) return "";
  return clip(call.goal, 220);
}

/** Call 56: "do you know where I am?" was answered "you're Omari" (2026-10-31). Where/what goes to Reason. */
const NOT_WHO = "Where they are, or any other question, goes to Reason; if you're not sure whether they said who or where, ask.";

/**
 * Call 56's tone fixes (2026-10-31), the only lines added to call 53's: "Checking" before nearly every
 * reply, "how are you?" not returned, a "yeah" to Reason's offer answered "Okay." and never passed on,
 * flat goodbyes.
 */
export const CALL56_LINES = [
  "Only use a holding phrase when you've handed Reason something that takes a moment, vary it, and never put one before a quick answer or a simple yes.",
  "Small talk is yours: if they ask how you are, answer warmly and ask them back.",
  "If they say yes or no to something Reason offered, pass that answer to Reason; never just say okay.",
  "When you both say goodbye, sign off warmly and briefly.",
];

/**
 * The live prompt: call 53's (#290), the one Omari called "a big upgrade, really felt like a
 * conversation", word for word, plus only the minimal identity lines — it is Reason, who they are, who
 * made it — behind REASON_CALL_IDENTITY, and call 56's four short lines (`CALL56_LINES`). #293's longer prompt (tone section, profile block, who-rang-
 * whom) went out with calls 54–55, which he called confused and worse; it is not here (2026-10-31).
 */
export function liveInstructions({ name = "them", named = name !== "them", owner = false, identity = false, brief = "" } = {}) {
  const them = named ? name : "them";
  const theirs = named ? `${name}'s` : "their";
  const who = !identity
    ? []
    : owner
      ? [named
        ? `Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant, and they're ${name}, the person you work for. ${NOT_WHO}`
        : `Only if they ask who you are, who they are or their name, answer straight away yourself: you're Reason, their assistant; you don't have their name saved yet. ${NOT_WHO}`]
      : [thirdPartyIdentity({ ownerName: them })];
  return [
    `You are the voice of Reason, ${theirs} personal assistant, on a phone call with ${them}.`,
    ...who,
    makerLine(),
    "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.",
    `You are only the voice. Reason, the backend, does all of the thinking and every action: it has ${theirs} messages, calendar, memory, tasks and tools.`,
    "Delegate to the backend for every question, request, instruction or opinion — anything beyond a greeting, a brief listening sound, or asking them to repeat something.",
    "Never answer from your own knowledge, and never invent a fact, time, name, number or price.",
    "While the backend works, a very short acknowledgement is fine. Do not fill the silence with guesses.",
    ...CALL56_LINES,
    ...(owner ? OWN_CALL_LINES : []),
    "Never say anything is done, booked, sent, texted, ordered, paid, scheduled, cancelled or confirmed unless the backend's result says so. If the result says it is not done, only started, or needs their approval, say exactly that.",
    "When a backend result arrives, say it naturally and briefly, keeping every fact, number and name exactly as given. Do not add offers or questions the result did not include.",
    "Never read out links, codes, IDs or anything in square brackets, and never say the words NO_REPLY.",
    "Stop speaking when they talk over you, and listen.",
    ...(owner && brief ? [brief] : []),
  ].join("\n");
}

/**
 * A person's own call (Omari, 2026-11-01): warm and chatty, a friend glad to hear from them. Short on
 * purpose — the long tone section of #293 made calls 54–55 worse.
 */
export const OWN_CALL_LINES = [
  "This is their own call: be friendly, chatty and warm, like a friend who's glad to hear from them. React to what they say, ask a natural follow-up, enjoy the small talk.",
  "If you rang them for a reason, lead with it. If not, you may pick up one thing from your recent chats when it fits. If they want something quick done, get straight to it.",
  // Call 68 (2026-11-01): a whole critique, a rewrite read out and a three-way question in one breath.
  "Keep it a back-and-forth: one point at a time, a few short sentences, then let them react. Never read a long text out loud; offer to text it. Ask at most one question at a time.",
];

/**
 * The voice's instructions for somebody who rang and has no account (src/calls/stranger.js): the same
 * voice and the same split — every answer is Reason's pitch turn (`strangerReply`: no tools, nobody's
 * data, heyreason.com's public facts only) — and nothing about anybody.
 */
export function strangerInstructions() {
  return [
    "You are the voice of Reason, a personal AI assistant, on a phone call with somebody who rang Reason's number. They are not a Reason user, and you know nothing about them or about anybody else.",
    makerLine(),
    "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.",
    "You are only the voice. Reason, the backend, decides every answer about what Reason is, what it does, what it costs and how to start.",
    "Delegate to the backend for every question, request or remark — anything beyond a greeting, a brief listening sound, or asking them to repeat something.",
    "Never answer from your own knowledge, and never invent a fact, feature, date, price or promise. Never say anything is free, cheap, paid, a trial or a subscription unless the backend's result says exactly that.",
    "While the backend works, a very short acknowledgement is fine. Do not fill the silence with guesses.",
    ...CALL56_LINES,
    "When a backend result arrives, say it naturally and briefly, keeping every fact exactly as given. Do not add offers or questions the result did not include.",
    "Never mention any person, user, owner or account, and you cannot do anything for them on this call. Say the website as \"hey reason dot com\". Never read out other links, codes, phone numbers or anything in square brackets, and never say the words NO_REPLY.",
    "Stop speaking when they talk over you, and listen.",
  ].join("\n");
}

/**
 * The voice's instructions on a call Reason makes to somebody else — a business, a receptionist, a phone
 * menu (phase 3, 2026-10-31). Here the voice never decides anything, not even when to speak: Reason's
 * call turn hears every word on the line (the third-party context: brief, rules, hold, menus, machines,
 * the commit gate) and hands over the exact words to say, and code drops any audio it did not ask for
 * (`GptLiveCall#gateOpen`). So the line opens silent, a menu or hold music hears nothing, and the
 * recorded-call disclosure is said word for word.
 */
export function lineInstructions({ name = "them", named = name !== "them", identity = false } = {}) {
  const them = named ? name : "the person you work for";
  return [
    `You are the voice of Reason, an AI assistant, on a phone call Reason is making for ${them} to a business or another person.`,
    ...(identity ? [thirdPartyIdentity({ ownerName: them })] : []),
    makerLine(),
    "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.",
    "You are only the voice, and on this call you never speak on your own. Reason listens to the line and decides everything: whether anybody is there, when to press a key, when to wait on hold, and every word that is said.",
    "Hand everything the other side says to Reason, and wait in silence: no acknowledgement, no greeting and no answer of your own.",
    "When Reason's result arrives, it is the exact words for the line: say it word for word and in full, then stop and listen. If there is no result, say nothing.",
    "Only Reason's words are played down the line; nothing you say on your own is ever heard by them. So say every result in full as a fresh reply, even if you think you already said some of it.",
    "Never greet first, never fill a silence, never talk to a recording, a phone menu, hold music or a voicemail greeting, and never say that you are waiting.",
    "Never say anything is done, booked, sent, ordered, paid, scheduled, cancelled or confirmed unless those are the words you were given.",
    "Never read out links, codes, IDs or anything in square brackets, and never say the words NO_REPLY.",
    "Stop speaking when they talk over you, and listen.",
  ].join("\n");
}

/**
 * The voice's instructions for a business call that TALKS (REASON_LINE_TALK, on by default; 2026-10-31,
 * call 59). The puppet line above made every reply wait on a Reason turn: their "can I help you?" got
 * Reason's first word 8 s later, they said "hello? hello?", each new sound started another turn that
 * cut the last one off, and they hung up at 39 s. Here the voice talks with a person itself, the way
 * it does on an own call (call 57), from the brief Reason's turn has, and hands Reason anything it
 * would have to decide. Code still keeps it silent until somebody is there (`ownOpener`), presses keys,
 * waits on hold and keeps the honesty guard. Openers sound like a person calling: no "I'm an AI calling
 * for…" unless they ask, and the recording line only where the law wants it (./consent.js).
 */
export function lineTalkInstructions({ name = "them", named = name !== "them", brief = null, goal = "", facts = [], notice = false } = {}) {
  const first = named ? String(name).trim().split(/\s+/)[0] : "the person you work for";
  const b = brief ?? {};
  const told = (facts ?? []).map(f => String(f).trim()).filter(Boolean);
  const rules = callRulesFor({ ownerName: first });
  return [
    `You are the voice of Reason, an AI assistant, on a phone call Reason placed for ${first} to a business or another person.`,
    makerLine(),
    "Voice: a young woman with a light, natural British (London) accent — warm, quick, relaxed. Short sentences, like a friend on the phone.",
    `What the call is for: ${String(b.goal || goal || "").trim()}`,
    speakToThem({ ownerName: first }),
    told.length ? `The only things you may say about ${first} or their plans:\n${told.map(f => `- ${f}`).join("\n")}` : `Say nothing about ${first} beyond what the call is for.`,
    b.goal ? briefLines(b, { ownerName: first }) : "",
    `Rules, whatever you are asked:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    "Until a live person speaks to you, say nothing at all: not to a ringing line, a recording, a phone menu, hold music or a voicemail greeting. Reason handles those.",
    "When a person answers — a live greeting like \"…, can I help you?\", \"hello?\" or \"speaking\" — answer straight away, like a normal person calling: a quick warm hello, then what you're calling about, in one natural breath."
      + " For example: \"Oh hey, hi! I'm calling to find out what kind of service you'd recommend for someone with low back pain… and how much would an hour be?\"",
    notice
      ? "This call is recorded, and where they are the law says they must be told: in that first reply, right after hello, say \"just so you know, this call's recorded\" — lightly, then carry straight on."
      : "Don't bring up that the call is recorded; if they ask, say yes, it is.",
    "If they say \"hello?\" again while you're starting, don't start over: carry on with what you were saying.",
    `Don't open by saying you're an AI or who you're calling for. If they ask whether you're a robot, an AI, a recording or automated, say plainly: "yes, I'm an AI assistant calling for ${first}." Never deny it and never dodge it.`,
    `Say who you're calling for only when it matters — a booking or a name they need, or they ask who's calling: "I'm calling for ${first}." If they ask your name, it's Reason; never make up a person's name, and never say you are ${first}.`,
    "Then talk with them yourself, the way a person would: short replies, one thing at a time, and let them finish. If they start talking while you're speaking, stop at once and listen."
      + " A small sound — \"mm\", \"uh\", a breath, line noise — is not their turn: don't answer it and don't restart.",
    "No listening sounds: never \"mm\", \"mhm\" or \"uh-huh\" while they talk or after you've finished speaking. Say nothing until it's your turn.",
    "Don't fill pauses. Never say \"no rush\" or \"take your time\" unless they ask you to hold on. If they say \"hold on\" or put you on hold, say \"sure\" once, then stay silent — through hold music and recordings — until a person speaks to you again.",
    "Repeat back a price, a time or a name once, to be sure you have it right.",
    `Hand it to Reason (delegate) whenever they ask something you weren't given above (a name, number, email, address, a preference), they offer to book, hold, reserve, charge or sign ${first} up for anything, they want payment details, a phone menu wants a key pressed, or you aren't sure what to say.`
      + " While Reason works, a few words like \"let me check\" are fine. When Reason's result comes, say it naturally and briefly, keeping every fact, number and name exactly.",
    "Never invent a fact, time, name, number or price, and never agree to anything you weren't told you may.",
    "Once you have what the call is for, thank them and say bye. Don't stay on.",
    "Never say anything is done, booked, sent, ordered, paid, scheduled, cancelled or confirmed unless Reason's result says so.",
    "Never read out links, codes, IDs or anything in square brackets, and never say the words NO_REPLY.",
  ].filter(Boolean).join("\n");
}

/** The brief off a call row (a JSON column), or null. */
function briefOf(call) {
  try { return typeof call?.brief === "string" ? JSON.parse(call.brief) : (call?.brief ?? null); } catch { return null; }
}

/**
 * The disclosure a GPT-Live third-party call opens with: the provider's own line
 * (`announcementFor` in ./provider.js), naming Reason and the person by first name — "this is Reason,
 * an AI assistant calling for Omari. Just so you know, this call is recorded."
 */
export function lineAnnouncement(ann) {
  return String(ann ?? "").replace(/this is an AI assistant calling for ([^.]+)\./,
    (_, who) => `this is Reason, an AI assistant calling for ${who.trim().split(/\s+/)[0]}.`);
}

/** The session.start body. μ-law at 8 kHz both ways, so Twilio's frames go straight through. */
export function sessionConfig({ name, named, owner = false, identity = false, brief = "", purpose = "", greeting = "", instructions = "", line = false } = {}) {
  const session = {
    model: config.gptliveModel,
    instructions: instructions || liveInstructions({ name, named, owner, identity, brief }),
    audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: config.gptliveVoice } },
    // A line call: room to cancel the voice's automatic "one moment" before it is generated.
    delegation: line ? { type: "client", acknowledgement_delay_ms: 800 } : { type: "client" },
  };
  if (greeting) {
    session.input = [{ type: "message", role: "developer", content: [{ type: "input_text", text: greetingInstruction(greeting, purpose) }] }];
  }
  return session;
}

export function greetingInstruction(greeting, purpose = "") {
  const line = String(greeting).replace(/"/g, "'");
  if (purpose) {
    return `Greet them now in English, in your own voice, starting with "${line.replace(/,?\s*what's up\?\s*$/i, "")}" and then, in the same breath, a few natural words of why you're ringing`
      + ` (${String(purpose).replace(/"/g, "'")}) — like "hey, got your photos, wanted to talk them through". If it's only that they asked you to ring, say "${line}" as it is. Then stop and listen.`;
  }
  return `Greet them now in English with this line, in your own voice: "${line}" Then stop and listen.`;
}

// ---------- the honesty guard ----------

// A spoken claim that something has happened. First person ("I've booked", "I sent"), or about the
// thing ("it's booked", "that's been sent", "you're all set"). A negation in between breaks the match:
// "it's not booked yet" and "I haven't sent it" are not claims.
const DONE_WORDS = "done|booked|sent|texted|emailed|messaged|ordered|paid|cancel+ed|reserved|purchased|bought|scheduled|placed|submitted|confirmed|added|created|set up|sorted|arranged|finished";
const CLAIM = new RegExp([
  `\\b(?:i(?:'|’)ve|i have|i(?:'|’)ve just|it(?:'|’)s|that(?:'|’)s|it has|that has|it is|that is|they(?:'|’)re|those are|all)\\s+(?:all\\s+|now\\s+|just\\s+|already\\s+|been\\s+)*(?:${DONE_WORDS})\\b`,
  `\\bi\\s+(?:just\\s+|already\\s+)?(?:booked|sent|texted|emailed|messaged|ordered|paid|cancel+ed|reserved|purchased|bought|scheduled|placed|submitted|confirmed)\\b`,
  `\\byou(?:'|’)re (?:all )?(?:set|booked|confirmed|sorted)\\b`,
  `\\b(?:all )?done\\s*[.!]`,
  // The subject dropped, the way people talk: "Just texted." "Already sent it over." (call 67, 2026-11-01).
  `(?:^|[.!?…,]\\s*)(?:just|already)\\s+(?:booked|sent|texted|emailed|messaged|ordered|paid|cancel+ed|reserved|purchased|bought|scheduled|placed|submitted|confirmed)\\b`,
].join("|"), "i");

// A send the words say happened: the verbs that need a send tool behind them in the same turn.
const SENT_CLAIM = /\b(?:sent|texted|emailed|messaged)\b/i;
// A send from before this turn, said as such, is true and stays: "I texted you the link earlier".
const EARLIER = /\b(?:earlier|before|yesterday|this morning|last (?:night|week)|this afternoon)\b/i;
const SENDS = /send|email|text|message|page_|picture|voice_note/;

/**
 * A result's words with any sentence that claims a send this turn did not make taken out, and an
 * honest line in its place (call 67, 2026-11-01: the result said "Just texted." with only end_call
 * behind it; the guard trusted it as Reason's own words and he never got a text). Exported for tests.
 */
export function withoutUnbackedSends(spoken, tools = []) {
  const text = String(spoken ?? "");
  if (!SENT_CLAIM.test(unquoted(text)) || (tools ?? []).some(n => SENDS.test(String(n)))) return { text, dropped: 0 };
  // Split on sentence ends outside quotes only: a quoted caption's "???" is not the end of the sentence.
  // Quotes are held aside as tokens while splitting, so a lone or stray quote mark is just a character.
  const held = [];
  const masked = text.replace(QUOTED, (q) => `\u0000${held.push(q) - 1}\u0000`);
  const sentences = (masked.match(/[^.!?…]+[.!?…]*\s*/g) ?? [masked]).map(x => x.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]));
  const claims = (x) => { const own = unquoted(x); return SENT_CLAIM.test(own) && claimsDone(own) && !EARLIER.test(own); };
  let dropped = 0;
  // The honest line goes where the claim was, once — never in front of words that claimed nothing.
  const out = sentences.map(x => (claims(x) ? (dropped++ === 0 ? "I'll text that to you. " : "") : x));
  if (!dropped) return { text, dropped: 0 };
  return { text: out.join("").replace(/\s+/g, " ").trim(), dropped };
}

/**
 * The words with anything quoted taken out. Call 68 (2026-11-01): a result quoting his caption ("i texted
 * Reason one voice note…") read as Reason claiming a send, and "I'll text that to you." was said before
 * its opinion. Words in quotes are somebody else's, not a claim.
 */
export function unquoted(text) {
  return String(text ?? "").replace(QUOTED, " ");
}
// A quotation: opened at the start or after a space/bracket/dash, closed before a space, punctuation or the
// end, one line, at most 400 characters. A 5" screen's inch mark does not open one.
const QUOTED = /(?<=^|[\s([—–-])(?:"[^"\n]{1,400}"|“[^”\n]{1,400}”)(?=$|[\s.,!?;:…)\]—–-])/g;

/** Does this say something has been done? Exported for the tests. */
export function claimsDone(text) {
  return CLAIM.test(String(text ?? ""));
}

/** Are these spoken words (nearly all) the given line's own? */
export function fromLine(said, line) {
  const words = (t) => String(t ?? "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  const own = new Set(words(line));
  const w = words(said);
  return own.size > 0 && w.length > 0 && w.filter(x => own.has(x)).length / w.length >= 0.8;
}

// The voice's own "let me think / let me check / one sec" while a hand-off runs (`promisedThought`).
// Phrasings the live voice really used on drives (2026-11-01): "Lemme have a think", "Give me a moment.
// I'll have a proper think", "I'm giving it some thought", "one sec, I'm on it", "mull it over".
export const THINKING_ACK = /\b(?:(?:let me|lemme|let's|i'll)\s+(?:have a\s+(?:proper\s+|quick\s+)?)?(?:think|check|look|see)|have a (?:proper |quick )?(?:think|look)|giv(?:e|ing) it (?:some |a )?(?:thought|think)|mull|think(?:ing)? (?:it|that|about it) (?:over|through)|i'm (?:on it|checking|looking)|one (?:sec|second|moment)|just a (?:sec|second|moment)|give me a (?:sec|second|moment)|hang on|hold on|bear with me)\b/i;
/** What is said when Reason had nothing to add after the voice promised a thought: the turn handed back. */
export const SKIP_FOLLOW_UP = "So — what do you reckon?";

/** The words the voice is given when it claimed something nobody confirmed. Code's words, never the caller's. */
export const GUARD_CORRECTION = "Stop. Nothing has been confirmed as done yet. In a few words, correct yourself: say it is not done yet"
  + " and you are still waiting on it. Do not say it is done until the backend's result says so.";

// ---------- reading Reason's turn ----------

const SPOKEN_FILLERS = new Set([...METER_KINDS.holdingLines, ...METER_KINDS.fillers, THINKING_FILLER].map(s => s.trim().toLowerCase()));

/**
 * What one Reason turn (the SSE stream `llmRequest` answers with) says, for the voice to say.
 *
 * The code's own holding lines and "one sec" fillers are dropped — they exist to keep a voice platform
 * from hanging up on a silent turn, and GPT-Live holds the line itself. The NO_REPLY marker is taken
 * out again here as a second net. Platform tools come back as their names: `end_call` (with its
 * optional spoken message) is honoured; `skip_turn` means nothing to say.
 */
export async function readTurn(stream) {
  const said = [];
  const tools = new Map();
  for await (const chunk of stream) {
    for (const line of String(chunk).split("\n")) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === "[DONE]") continue;
      let j;
      try { j = JSON.parse(m[1]); } catch { continue; }
      const d = j?.choices?.[0]?.delta ?? {};
      if (typeof d.content === "string" && d.content) said.push(d.content);
      for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const k = t.index ?? 0;
        const got = tools.get(k) ?? { name: "", args: "" };
        if (t.function?.name) got.name = t.function.name;
        if (t.function?.arguments) got.args += t.function.arguments;
        tools.set(k, got);
      }
    }
  }
  const kept = said.filter(s => !SPOKEN_FILLERS.has(s.trim().toLowerCase()));
  const text = withoutSilenceMarker(kept.join("").replace(/\s+/g, " ").trim()).text;
  const names = [...tools.values()].map(t => t.name).filter(Boolean);
  let endCall = null;
  const end = [...tools.values()].find(t => t.name === "end_call");
  if (end) {
    let args = {};
    try { args = JSON.parse(end.args || "{}"); } catch { /* no args is a plain hang-up */ }
    endCall = { message: withoutSilenceMarker(String(args.message ?? "")).text.trim() };
  }
  // Every platform tool with its arguments, for a call whose voice carries them out itself: a key press
  // (`dtmf_tones`) or a hand-over on a third-party line (see `GptLiveCall#act`).
  const calls = [...tools.values()].filter(t => t.name).map(t => {
    let args = {};
    try { args = JSON.parse(t.args || "{}"); } catch { /* no args */ }
    return { name: t.name, args: args && typeof args === "object" ? args : {} };
  });
  return { text, tools: names, calls, endCall, skip: !text && names.includes("skip_turn") };
}

// ---------- reading the end of a call ----------

// Call 56 (2026-10-31): "Okay, bye" / "Bye." / ", bye" and the line stayed open until Omari hung up.
// The voice says its goodbyes itself, without delegating, so Reason's end_call never came. Now a
// goodbye-sounding line of the voice's is the cue to ASK the small model whether the call is over —
// this list only picks which lines are worth asking about; it never decides anything itself.
// Only a hint: the small model reads the ending (`judgeEnding`). Chattier own calls sign off more
// ways — "Lovely talking too. Chat soon." went unread on a 2026-11-01 drive and the call stayed up.
const FAREWELL_HINT = /\b(?:bye|goodbye|take care|(?:talk|chat|speak) (?:to you )?(?:soon|later)|see (?:you|ya)|catch you|good ?night|have a (?:good|great|nice|lovely)|(?:lovely|nice|great|good) (?:talking|chatting|speaking)|cheers)\b/i;
/** Does this line of the voice's sound like a goodbye, so the call's end is worth reading? */
export const soundsLikeFarewell = (text) => FAREWELL_HINT.test(String(text ?? ""));
/** The voice's goodbye has settled for this long before the end is read. */
export const BYE_SETTLE_MS = 900;

const ENDING_SYSTEM = "You read the last lines of a phone call between a person (Them) and their AI assistant (Reason)."
  + " Answer only from what was said. Reply with the JSON asked for, nothing else.";
const GOODBYE_SCHEMA = { type: "object", properties: { ended: { type: "boolean" } }, required: ["ended"], additionalProperties: false };
const CUTOFF_SCHEMA = { type: "object", properties: { cut_off: { type: "boolean" } }, required: ["cut_off"], additionalProperties: false };

export function goodbyePrompt(transcript) {
  return `${transcript}\n\nHave Them and Reason both said goodbye TO EACH OTHER, so the call is over and Reason should hang up now?`
    + " ended=false if Them is still asking or saying anything, if the goodbye was to someone else in the room,"
    + " or if only one side said goodbye. ended=true only for a mutual goodbye.";
}

export function cutOffPrompt(transcript, late) {
  return `${transcript}\n\nAs the call ended, right after Reason's goodbye, Them said: "${late}"`
    + "\nWas Them starting to say something new (a question, a request, more to tell) that got cut off? cut_off=false if it was"
    + " only them finishing the goodbye (bye, thanks, you too, okay) or just noise.";
}

/**
 * The small model's read of the end of a call: `{ kind: "goodbye" }` → is it a mutual goodbye;
 * `{ kind: "cutoff", late }` → were their last words cut off. true/false, or null when it could not be
 * asked (no subscription CLI, a timeout) — and null never hangs up or texts anyone. Subscription only.
 */
export async function judgeEnding({ kind, transcript, late = "" }, { ask = null } = {}) {
  try {
    const goodbye = kind === "goodbye";
    const q = {
      system: ENDING_SYSTEM, feature: goodbye ? "gptlive_goodbye" : "gptlive_cutoff",
      prompt: goodbye ? goodbyePrompt(transcript) : cutOffPrompt(transcript, late),
      schema: goodbye ? GOODBYE_SCHEMA : CUTOFF_SCHEMA,
    };
    const { value } = ask ? { value: await ask(q) } : await (await import("../onethought.js")).askJson(q);
    const v = goodbye ? value?.ended : value?.cut_off;
    return typeof v === "boolean" ? v : null;
  } catch { return null; }
}

// ---------- μ-law and the recording ----------

/** One G.711 μ-law byte as a 16-bit sample. */
export function ulawToPcm(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let s = ((mant << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

/**
 * Both sides of the call on one timeline, as the caller heard it. Their frames arrive in real time
 * (20 ms each) and set the clock; Reason's audio is laid down from where the clock is when it was
 * sent, and a `clear` (barge-in, guard) cuts what Twilio never played.
 */
export class CallTape {
  constructor() { this.caller = []; this.callerBytes = 0; this.segs = []; this.reasonEnd = 0; }
  them(buf) { this.caller.push(buf); this.callerBytes += buf.length; }
  reason(buf) {
    const at = Math.max(this.reasonEnd, this.callerBytes);
    this.segs.push({ at, buf });
    this.reasonEnd = at + buf.length;
  }
  /** Everything of Reason's from now on was never played. */
  cut() {
    const at = this.callerBytes;
    this.segs = this.segs.filter(s => s.at < at).map(s => (s.at + s.buf.length > at ? { at: s.at, buf: s.buf.subarray(0, at - s.at) } : s));
    this.reasonEnd = Math.min(this.reasonEnd, at);
  }
  seconds() { return Math.max(this.callerBytes, this.reasonEnd) / 8000; }
  /**
   * The mix as a mono 8 kHz WAV: 16-bit PCM, or G.711 μ-law (half the size) once PCM would pass the
   * 25 MB a recording may be (~26 minutes). Mixed straight into the output, one pass per side.
   */
  wav() {
    const n = Math.max(this.callerBytes, this.reasonEnd);
    const pcm = new Int16Array(n);
    let i = 0;
    for (const b of this.caller) for (const u of b) pcm[i++] = ulawToPcm(u);
    for (const s of this.segs) {
      for (let k = 0; k < s.buf.length; k++) {
        const v = pcm[s.at + k] + ulawToPcm(s.buf[k]);
        pcm[s.at + k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
    const ulaw = n * 2 + 44 > WAV_PCM_LIMIT;
    const body = ulaw ? Buffer.from(Uint8Array.from(pcm, pcmToUlaw)) : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + body.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(ulaw ? 7 : 1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(8000, 24); h.writeUInt32LE(ulaw ? 8000 : 16000, 28); h.writeUInt16LE(ulaw ? 1 : 2, 32); h.writeUInt16LE(ulaw ? 8 : 16, 34);
    h.write("data", 36); h.writeUInt32LE(body.length, 40);
    return Buffer.concat([h, body]);
  }
}

/** Under the 25 MB storeRecording takes, with room. */
const WAV_PCM_LIMIT = 24 * 1024 * 1024;

/** A 16-bit sample as one G.711 μ-law byte. */
export function pcmToUlaw(sample) {
  const BIAS = 0x84;
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > 32635) s = 32635;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

// ---------- the OpenAI side ----------

/** A GPT-Live WebSocket, as `{ send(obj), close(), on(name, fn) }`. Node's own WebSocket, key in a header. */
export function openLiveSocket({ url = LIVE_URL, key = config.openaiKey } = {}) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
  const handlers = { open: [], event: [], close: [] };
  // A throw inside a WebSocket listener is an uncaught exception, which would take the whole server
  // down with one call; every handler is run inside a catch.
  const run = (list, ...args) => { for (const f of list) { try { f(...args); } catch { /* one call never takes the process */ } } };
  ws.onopen = () => run(handlers.open);
  ws.onmessage = (m) => { let e; try { e = JSON.parse(String(m.data)); } catch { return; } run(handlers.event, e); };
  ws.onclose = (e) => run(handlers.close, e?.code ?? 1006);
  ws.onerror = () => { /* the close that follows says it */ };
  return {
    send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
    on: (name, fn) => handlers[name]?.push(fn),
  };
}

// ---------- warming the voice up while it rings ----------

/** A μ-law sample this loud or louder is speech, not the silence the session streams between words. */
const SPEECH_PEAK = 1500;

/** Does this chunk of μ-law audio carry speech? */
export function hasSpeech(b64) {
  for (const u of Buffer.from(String(b64 ?? ""), "base64")) {
    const s = ulawToPcm(u);
    if (s >= SPEECH_PEAK || s <= -SPEECH_PEAK) return true;
  }
  return false;
}

/**
 * A frame of somebody talking, by loudness rather than one peak: line hiss peaks past SPEECH_PEAK but
 * stays under this (RMS), a voice is well over it. Talk mode reads it to know someone has spoken before
 * the transcript of it arrives (GPT-Live's came 2.7 s after the receptionist started, 2026-10-31 drive).
 */
export const VOICE_RMS = 2000;
export function hasVoice(b64) {
  const buf = Buffer.from(String(b64 ?? ""), "base64");
  if (!buf.length) return false;
  let sum = 0;
  for (const u of buf) { const x = ulawToPcm(u); sum += x * x; }
  return Math.sqrt(sum / buf.length) >= VOICE_RMS;
}

/** 100 ms of μ-law silence: what the warm session is fed so its clock runs before anyone is on the line. */
const SILENCE_100MS = Buffer.alloc(800, 0xff).toString("base64");
/** The greeting is over once the voice has been quiet this long after speaking; the session is then paused. */
export const WARM_QUIET_MS = 700;
/** Fed this long and still no greeting: say it again once (the docs: the greeting is never guaranteed). */
export const WARM_RETRY_MS = 4000;
/** And this long: stop feeding it, so an unanswered phone costs seconds, not minutes. */
export const WARM_FEED_MAX_MS = 9000;
/** Nobody picked up within this: the session is closed. Twilio gives up ringing at 30 s. */
export const WARM_MAX_MS = 60_000;

/** Warm sessions waiting for their call to be answered, by call id. */
const warm = new Map();

/**
 * A GPT-Live session opened while the phone is still ringing, so Reason speaks the moment it is picked up.
 *
 * Call 53 (2026-10-31): Omari answered, said "hello, hello", and heard nothing for 3.1 s — the session
 * was only opened once Twilio's stream started, then took ~1 s to start and ~0.8 s more to greet. Now
 * the session starts when the call is placed, with the greeting asked for; a GPT-Live session's clock
 * only runs on input audio (measured: no input, no greeting), so it is fed silence until the greeting
 * has been said, then paused. Its audio is kept, and played into the line the moment the stream starts.
 *
 * Only for a call that opens with a greeting — an owner call Reason placed. A call that opens silent (a
 * third-party call, #232) never reaches GPT-Live and never gets one of these.
 */
export class WarmSession {
  constructor({ row, openLive = openLiveSocket, log = () => {}, now = () => Date.now(), timers = globalThis }) {
    this.row = row;
    this.log = log;
    this.now = now;
    this.timers = timers;
    this.who = whoFor(row);
    this.greeting = String(row.announcement ?? "");
    this.openedAt = now();
    this.audio = [];
    this.text = "";
    this.spoke = false;
    this.lastSpeechAt = 0;
    this.feeding = false;
    this.fedMs = 0;
    this.retried = false;
    this.started = false;
    this.closed = false;
    this.call = null;
    this.live = openLive();
    this.live.on("open", () => {
      this.live.send({ type: "session.start", event_id: `start_${row.id}`, session: sessionConfig({ ...this.who, greeting: this.greeting }) });
    });
    this.live.on("event", (e) => (this.call ? this.call.fromLive(e) : this.take(e)));
    this.live.on("close", (code) => (this.call ? this.call.liveClosed(code) : this.drop(`closed (${code})`)));
    this.expiry = timers.setTimeout(() => this.drop("never answered"), WARM_MAX_MS);
  }

  take(e) {
    if (e.type === "session.started") {
      this.started = true;
      this.sessionId = e.session?.id ?? "";
      this.startedAt = this.now();
      this.live.send({ type: "session.commentary.append", event_id: `greet_${this.row.id}`, delegation_id: null, content: greetingInstruction(this.greeting, this.who?.purpose ?? "") });
      this.feeding = true;
      this.feed();
    } else if (e.type === "session.output_audio.delta") {
      const speech = hasSpeech(e.delta);
      if (speech) { this.spoke = true; this.lastSpeechAt = this.now(); }
      if (this.spoke) this.audio.push(e.delta);
    } else if (e.type === "session.output_transcript.delta") {
      this.text += String(e.delta ?? "");
    } else if (e.type === "session.usage.updated" && Number.isFinite(e.usage?.seconds)) {
      this.seconds = e.usage.seconds;
    } else if (e.type === "error") {
      this.log({ gptlive_error: this.row.id, warm: true, code: e.error?.code ?? "", message: String(e.error?.message ?? "").slice(0, 200) });
    }
  }

  /** 100 ms of silence in, every 100 ms, until the greeting is said (or it is plainly not coming). */
  feed() {
    if (!this.feeding || this.closed || this.call) return;
    const t = this.now();
    if (this.spoke && t - this.lastSpeechAt >= WARM_QUIET_MS) return this.pause("greeted");
    if (this.fedMs >= WARM_FEED_MAX_MS) return this.pause("no greeting");
    if (!this.spoke && !this.retried && this.fedMs >= WARM_RETRY_MS) {
      this.retried = true;
      this.live.send({ type: "session.commentary.append", event_id: `greet2_${this.row.id}`, delegation_id: null, content: greetingInstruction(this.greeting, this.who?.purpose ?? "") });
    }
    this.live.send({ type: "session.input_audio.append", audio: SILENCE_100MS });
    this.fedMs += 100;
    this.feedTimer = this.timers.setTimeout(() => this.feed(), 100);
  }

  pause(why) {
    this.feeding = false;
    this.log({ gptlive_warm: this.row.id, why, ready_ms: this.now() - this.openedAt, spoke: this.spoke, said: this.text.trim().slice(0, 120) });
  }

  /** The call picked up: everything from here is the call's. */
  handOver(call) {
    this.timers.clearTimeout(this.expiry);
    if (this.feedTimer) this.timers.clearTimeout(this.feedTimer);
    this.feeding = false;
    this.call = call;
  }

  /** Nobody is coming: close it. */
  drop(why) {
    if (this.closed || this.call) return;
    this.closed = true;
    this.feeding = false;
    this.timers.clearTimeout(this.expiry);
    if (this.feedTimer) this.timers.clearTimeout(this.feedTimer);
    if (warm.get(this.row.id) === this) warm.delete(this.row.id);
    try { if (this.started) this.live.send({ type: "session.close", event_id: `close_${this.row.id}` }); } catch { /* going anyway */ }
    this.timers.setTimeout(() => this.live.close(), 1000);
    this.log({ gptlive_warm_dropped: this.row.id, why });
  }
}

/** Start the voice for a call about to be placed, if it opens with a greeting. Never throws. */
export function prewarm(row, { openLive = openLiveSocket, log = () => {}, now, timers } = {}) {
  try {
    if (!row?.id || !String(row.announcement ?? "").trim() || warm.has(row.id)) return null;
    const w = new WarmSession({ row, openLive, log, ...(now ? { now } : {}), ...(timers ? { timers } : {}) });
    warm.set(row.id, w);
    return w;
  } catch (e) {
    log({ gptlive_warm_failed: row?.id ?? null, why: (e?.message ?? String(e)).split("\n")[0] });
    return null;
  }
}

/** The warm session for a call, taken (it is the call's from now on), or null. */
export function takeWarm(callId) {
  const w = warm.get(callId);
  warm.delete(callId);
  return w && !w.closed ? w : null;
}

/** The call is over before it was answered (busy, no answer, failed). */
export function dropWarm(callId, why) {
  warm.get(callId)?.drop(why);
}

// ---------- one call ----------

/**
 * One call on the line: Twilio's media stream on one side, a GPT-Live session on the other, Reason
 * behind it through client delegation.
 *
 * `twilio` is the accepted media-stream socket (`send(text)`, `close()`, `onMessage`, `onClose`).
 * `openLive` and `brain` are injected so the suite can run a call with no network: `brain(messages)`
 * resolves `{ text, tools, endCall, skip }` (see `readTurn`).
 */
// A line call's timings. Words heard are handed to Reason once their side has paused for
// LINE_QUIET_MS (a line that never pauses, LINE_MAX_WAIT_MS after it started). The gate lets the
// voice's audio out until its speech has been quiet LINE_GATE_QUIET_MS.
export const LINE_QUIET_MS = 1000;
/** The voice's speech stops this long: the next speech is a new run (a new reply, not the old one's tail). */
export const VOICE_RUN_GAP_MS = 350;
/** Talk mode: nobody has spoken this long after the pickup, so Reason opens ("hi, is this …?"). */
export const LINE_OPEN_AFTER_MS = 3000;
export const LINE_OPEN_MIN_MS = 500;
/** Talk mode, recording-notice states: checked this long after the talk starts. */
export const LINE_NOTICE_CHECK_MS = 9000;
export const LINE_MAX_WAIT_MS = 8000;
export const LINE_GATE_QUIET_MS = 1500;
export const LINE_GATE_MAX_MS = 30_000;
/** How long the gate waits for the words' ack before it lets the voice through anyway. */
export const LINE_ACK_WAIT_MS = 2500;
/** The voice counts as mid-speech (of its own) when it spoke within this long. */
export const LINE_BUSY_MS = 600;
/** How often hold is checked against its budget, and how long a line with nobody on it is kept. */
export const LINE_HOLD_TICK_MS = 15_000;
export const LINE_SILENT_MS = 45_000;
/** Twilio's async AMD gives up after 30 s by default; a voicemail waits for its beep up to 20 s. */
export const LINE_AMD_WAIT_MS = 30_000;
export const LINE_VOICEMAIL_WAIT_MS = 20_000;
/** A key press re-opens the stream; a stream not back in this long is a lost call. */
export const LINE_REJOIN_MS = 20_000;
/**
 * Talk mode: a listening sound ("Mm.") is not a reply (2026-10-31 greet drives: "Mm." into the
 * receptionist's mid-sentence pause, and once into silence a second after its own opener). A sound
 * the voice starts within BC_CALLER_MS of their last word, or BC_SELF_MS after its own speech with
 * nothing from them since, is held: BC_REAL_MS of speech makes it a reply (let through), a sound
 * that ends sooner (BC_END_MS quiet in the audio, or BC_WAIT_MS with no audio) or that they talk
 * over is dropped. Replies to a finished sentence start ~1 s after it, so they are never held.
 */
export const BC_CALLER_MS = 650;
export const BC_SELF_MS = [600, 3000];
export const BC_REAL_MS = 450;
export const BC_END_MS = 300;
export const BC_WAIT_MS = 400;
const BARE_SOUND = /^[\s.,!?…-]*(?:m+|hm+|mhm+|mm-?hm+|uh-?huh|uh+|um+)?[\s.,!?…-]*$/i;
const AMD_NOTE = "Twilio's answering-machine check says a machine took this call and its greeting has just ended."
  + " If it was a voicemail greeting, call machine_on_the_line with what \"voicemail_greeting\" and do what it says."
  + " If it was a phone menu, a recording or hold, carry on exactly as you would.";
const LINE_STOP_OWN = "Stop speaking now and say nothing of your own. Nothing you said on your own reached the other side; Reason's exact words for them come next — say all of them.";
const AMD_BEEP_NOTE = "The voicemail greeting has ended at the beep: leave the message now, or hang up, as you were told.";

/** The TwiML for a key press: the digits (after a short pause), then the stream again, to the same call. */
export function pressTwiml(digits, row, base = config.publicUrl) {
  const wss = String(base).replace(/^http/, "ws").replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${xml(`w${digits}`)}"/><Connect><Stream url="${xml(`${wss}${STREAM_PATH}${row.webhook_token}`)}"/></Connect></Response>`;
}

/** What a place ringing back hears first: the disclosure, word for word, then what it is about. */
export function ringBackLine(row) {
  const about = String(row.goal ?? "").replace(/^They are ringing back about:\s*/, "").trim();
  const ann = String(row.announcement ?? "").trim();
  return about ? `${ann} You're calling back about ${about} — thanks for ringing back.` : ann;
}

export class GptLiveCall {
  constructor({ call, twilio, openLive = openLiveSocket, warm = null, brain = null, judge = null, log = () => {}, now = () => Date.now(), finish = async () => {}, timers = globalThis, persona = null, twilioApi = null }) {
    this.call = call;
    // A call with no account and no call row (a stranger on the line): its own instructions and
    // greeting, nothing written to any conversation, its audio kept on its stranger row (`strangerStream`).
    this.persona = persona;
    // A call Reason makes to somebody else, or a place ringing back about one (phase 3): the LINE
    // drives every turn and the voice only says the words it is handed (`lineTurn`, `gateOpen`).
    this.line = !persona && Number(call.is_owner) !== 1;
    this.twilioApi = twilioApi ?? ((path, form) => twilioPost(path, form));
    this.lineN = 0;
    this.lastLineTurnAt = 0;
    this.gate = null;
    this.gateClosedAt = 0;
    this.dropped = 0;
    this.openLive = openLive;
    this.warm = warm;
    this.brain = brain ?? ((messages) => reasonTurn({ call, messages, log }));
    this.judge = judge ?? ((q) => judgeEnding(q));
    this.farewellAt = 0;
    this.goodbyeAt = 0;
    this.byeTimer = null;
    this.byeAsking = false;
    this.endHeld = false;
    this.callerSpeechAt = 0;
    this.callerSpeechFrom = 0;
    this.log = log;
    this.now = now;
    this.finishCall = finish;
    this.timers = timers;
    this.who = persona ? { name: "them", named: false, owner: false, identity: false, instructions: persona.instructions } : whoFor(call);
    // The room under Reason's voice (REASON_CALL_AMBIENCE): a café on their own call, an office on an
    // errand; never on a stranger's call to Reason's number.
    this.bed = persona ? null : ambience.bedFor(call);
    if (!persona && call?.id != null) running.set(call.id, this);
    if (this.line) this.who = { ...this.who, instructions: lineInstructions(this.who) };
    // A business call Reason placed TALKS once a person answers (REASON_LINE_TALK; `lineTalkInstructions`).
    // A place ringing back keeps the puppet line: it hears who is calling first, by code.
    this.talk = !!(this.line && config.lineTalk && call.direction !== "in");
    this.talking = false;
    this.bargeIns = 0;
    if (this.talk) {
      this.notice = recordingNoticeFor(call.to_number);
      const facts = Array.isArray(call.facts) ? call.facts : (() => { try { return JSON.parse(call.facts ?? "[]"); } catch { return []; } })();
      this.who = { ...this.who, instructions: lineTalkInstructions({ ...this.who, brief: briefOf(call), goal: call.goal, facts, notice: this.notice.notice }) };
      // Reason's own turns put the row's opening line in front of their first words to a person: on
      // this call that is no "this is Reason, an AI assistant…", only the recording line where the law
      // wants it (and nothing at all elsewhere).
      const opening = this.notice.notice ? "Hi there — just so you know, this call's recorded." : "";
      try { db.updateCall(call.conversation_id, call.id, { announcement: opening }); } catch { /* the row's own line stands */ }
      this.call = { ...call, announcement: opening };
    }
    this.name = this.who.name;
    // The pickup opener (./opener.js): a clip made while it rang, played as soon as their hello ends
    // (or into a silent line) while the live voice connects. `state`: waiting → playing → played, or
    // cut (talked over) / none (no clip, or a long greeting that is a machine's).
    if (this.talk && opener.openerFor(call)) {
      const clip = opener.take(call.id);
      this.pickup = clip?.audio?.length ? { clip, state: "waiting" } : { clip: null, state: "none", why: "no clip ready" };
    } else this.pickup = null;
    // Their side's first audio, kept until the voice session is up (~1.2–1.9 s on calls 59–74), so their
    // "hello, Chelsea Bodywork" is heard by the voice instead of lost before it started.
    this.preStart = [];
    // A third-party call Reason placed opens SILENT (#232): nothing until their side has spoken, and the
    // disclosure then comes from Reason's own turn. A place ringing back hears it at once (it rang us).
    this.greeting = persona ? persona.greeting
      : this.line
        ? call.direction === "in" ? ringBackLine(call) : ""
        : call.direction === "in"
          ? openingLineFor({ person: accounts.ownerOf(call.conversation_id), conversationId: call.conversation_id })
          : String(call.announcement ?? "");
    // On a line call the greeting is not seeded: what was said comes from what was really played.
    this.turns = this.greeting && !this.line ? [{ who: "reason", text: this.greeting, at: now(), seeded: true }] : [];
    this.tape = new CallTape();
    this.pending = new Map();
    this.delegations = 0;
    this.latest = null;
    this.lastResultClaimed = false;
    this.lastResultAt = 0;
    this.lastCallerAt = 0;
    this.lastOutAt = 0;
    this.lastVoiceAt = 0;
    this.voiceEndsAt = 0;
    // Talk mode: a sound held back until it is a reply (`heldSound`), and their last loud frame.
    this.sound = null;
    this.soundDroppedAt = -Infinity;
    this.soundCutAt = -Infinity;
    this.soundsDropped = 0;
    this.theirVoiceAt = -Infinity;
    this.lastOutTextAt = 0;
    this.utter = "";
    this.playheadAt = 0;
    this.mute = null;
    this.guardTrips = 0;
    this.seconds = 0;
    this.endWhy = "";
    this.ending = false;
    this.done = false;
    this.started = false;
    this.streamSid = null;
    this.startedAt = now();
    this.attach(twilio);
  }

  /**
   * Listen to one Twilio stream. A key press re-opens the stream (Twilio plays the digits, then
   * connects a NEW stream, `press`), so the old socket going away mid-press is not the call ending,
   * and anything the old one still says once the new one is up is ignored.
   */
  attach(socket) {
    this.twilio = socket;
    socket.onMessage((text) => { if (this.twilio === socket) this.fromTwilio(text); });
    socket.onClose(() => { if (this.twilio === socket && !this.rejoining) this.end("caller hung up").catch(() => {}); });
  }

  /** The call row as the database has it now (Reason's turns write hold, machine and press state onto it). */
  freshRow() {
    try { return db.getCall(this.call.conversation_id, this.call.id) ?? this.call; } catch { return this.call; }
  }

  // --- Twilio side ---

  fromTwilio(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.event === "start") {
      this.streamSid = m.start?.streamSid ?? m.streamSid ?? null;
      this.callSid = m.start?.callSid ?? this.callSid ?? "";
      if (this.live) {
        // The stream back after a key press: the same voice session carries on.
        this.playheadAt = this.now();
        this.bed?.cleared(this.now());
        if (this.rejoining) this.log({ gptlive_keypad_rejoined: this.call.id, ms: this.now() - this.rejoining.at });
        this.rejoining = null;
        if (this.rejoinTimer) this.timers.clearTimeout(this.rejoinTimer);
        return;
      }
      this.streamStartAt = this.now();
      this.log({ gptlive_stream_start: this.call.id, sid: this.callSid, ...(this.bed ? { ambience: this.bed.kind } : {}), ...(this.pickup ? { opener: this.pickup.clip?.kind ?? "none" } : {}) });
      this.connect();
      this.roomTick();
    } else if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      const buf = Buffer.from(m.media.payload, "base64");
      this.tape.them(buf);
      const voiced = this.line && hasVoice(m.media.payload);
      // Their side's sound for the opener's timing: any speech, not only a loud voice — a receptionist's
      // "Hi … Chelsea Bodywork" is loud in short bursts (2026-11-07 greet drive).
      if (this.pickup && (this.pickup.state === "waiting" || this.pickup.state === "playing")) this.pickupFrame(this.now(), this.line && hasSpeech(m.media.payload));
      if (voiced) {
        this.firstCallerVoiceAt ??= this.now();
        if (this.talk) this.theirVoiceAt = this.now();
        // While the opener plays, their voice is not an answer to it yet (a hello over its first words).
        if (this.talk && !this.talking && !(this.pickup?.state === "playing")) this.callerVoiceAt = this.now();
      }
      if (hasSpeech(m.media.payload)) {
        const t = this.now();
        if (t - this.callerSpeechAt > 200) this.callerSpeechFrom = t;
        this.callerSpeechAt = t;
      }
      if (this.started) this.live.send({ type: "session.input_audio.append", audio: m.media.payload });
      else if (this.talk && this.pickup && this.preStart.length < 250) this.preStart.push(m.media.payload);
    } else if (m.event === "stop") {
      if (!this.rejoining) this.end("caller hung up").catch(() => {});
    }
  }

  toTwilio(obj) {
    if (!this.streamSid) return;
    if (this.bed && obj.event === "media" && obj.media?.payload) obj = { ...obj, media: { ...obj.media, payload: this.bed.mix(obj.media.payload, this.now()) } };
    this.twilio.send(JSON.stringify({ ...obj, streamSid: this.streamSid }));
  }

  /** The room under the call (src/calls/ambience.js): topped up every TICK_MS while the call is up. */
  roomTick() {
    if (!this.bed || this.done) return;
    const frames = this.streamSid && !this.rejoining ? this.bed.fill(this.now()) : null;
    if (frames) this.twilio.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: frames } }));
    this.roomTimer = this.timers.setTimeout(() => this.roomTick(), ambience.TICK_MS);
  }

  queuedMs() { return Math.max(0, this.playheadAt - this.now()); }

  /** Throw away whatever Twilio has buffered and not played. */
  clearPlayback(why) {
    this.toTwilio({ event: "clear" });
    this.tape.cut();
    this.playheadAt = this.now();
    this.bed?.cleared(this.now());
    this.log({ gptlive_cleared: this.call.id, why });
  }

  // --- GPT-Live side ---

  connect() {
    // The platform ceiling (`callPlatformCapSeconds`), so a call
    // never outlives the lost-call sweep's window and is written off while it is still going.
    this.capTimer = this.timers.setTimeout(() => { this.endWhy = "duration_cap"; this.end("duration_cap").catch(() => {}); }, config.callPlatformCapSeconds * 1000);
    const w = this.warm;
    if (w && !w.closed && !w.call) return this.adopt(w);
    this.live = this.openLive();
    this.live.on("open", () => {
      this.live.send({ type: "session.start", event_id: `start_${this.call.id}`, session: sessionConfig({ ...this.who, greeting: this.line ? "" : this.greeting, line: this.line }) });
    });
    this.live.on("event", (e) => this.fromLive(e));
    this.live.on("close", (code) => this.liveClosed(code));
  }

  /**
   * Take over the session warmed up while it rang (`WarmSession`): the greeting it has already said goes
   * straight down the line, and from here on the session is this call's. A session that has not started
   * yet, or has not finished greeting, carries on live — the rest of the greeting follows as it comes.
   */
  adopt(w) {
    w.handOver(this);
    this.live = w.live;
    this.adopted = true;
    if (w.started) this.onStarted(w.sessionId, { greet: false });
    if (Number.isFinite(w.seconds)) this.seconds = w.seconds;
    for (const delta of w.audio) this.audioOut(delta);
    if (w.text) this.textOut(w.text);
    this.log({ gptlive_warm_used: this.call.id, ready: !w.feeding && w.spoke, audio_ms: w.audio.reduce((n, d) => n + Buffer.from(d, "base64").length, 0) / 8, waited_ms: this.now() - w.openedAt });
  }

  liveClosed(code) {
    this.log({ gptlive_session_socket_closed: this.call.id, code });
    if (!this.done) this.end(this.endWhy || `voice session closed (${code})`).catch(() => {});
  }

  onStarted(sessionId, { greet = true } = {}) {
    this.started = true;
    this.sessionId = sessionId ?? "";
    this.log({ gptlive_session: this.call.id, session: this.sessionId, warm: !!this.adopted });
    if (!this.persona) try { db.updateCall(this.call.conversation_id, this.call.id, { tts_model: `${config.gptliveModel}/${config.gptliveVoice}` }); } catch { /* a label never breaks a call */ }
    if (this.line) {
      this.lineStarted();
      // What their side said before the session was up, now, after the opener note (`tellOpener`).
      const early = this.preStart;
      this.preStart = [];
      for (const audio of early) this.live.send({ type: "session.input_audio.append", audio });
      if (early.length) this.log({ gptlive_early_audio: this.call.id, ms: early.length * 20 });
      return;
    }
    if (greet && this.greeting) this.live.send({ type: "session.commentary.append", event_id: `greet_${this.call.id}`, delegation_id: null, content: greetingInstruction(this.greeting, this.who?.purpose ?? "") });
    this.flushTold();
  }

  /** Anything handed to this call while it was being placed (`tellLive`), now the session is up. */
  flushTold() {
    const notes = told.get(this.call.id);
    if (!notes?.length || !this.live) return;
    told.delete(this.call.id);
    for (const [i, content] of notes.entries()) {
      this.live.send({ type: "session.instructions.append", event_id: `told_${this.call.id}_${Date.now()}_${i}`, delegation_id: null, content });
    }
    this.log({ gptlive_told: this.call.id, notes: notes.length });
  }

  fromLive(e) {
    switch (e.type) {
      case "session.started":
        // An adopted session started before the call picked up; this is only ever a fresh one's.
        return this.onStarted(e.session?.id, { greet: !this.adopted });
      case "session.output_audio.delta":
        return this.audioOut(e.delta);
      case "session.output_transcript.delta":
        return this.textOut(String(e.delta ?? ""));
      case "session.input_transcript.delta":
        return this.textIn(String(e.delta ?? ""));
      case "session.delegation.created":
        return void this.delegate(e.delegation?.id).catch((err) => this.log({ gptlive_delegation_failed: this.call.id, why: (err?.message ?? String(err)).split("\n")[0] }));
      case "session.instructions.appended":
        if (this.mute && e.client_event_id === this.mute.eventId) this.mute.acked = true;
        return;
      case "session.commentary.appended":
        if (this.gate && e.client_event_id === this.gate.eventId) this.gate.acked = true;
        return;
      case "session.usage.updated":
        if (Number.isFinite(e.usage?.seconds)) this.seconds = e.usage.seconds;
        return;
      case "session.closed":
        if (Number.isFinite(e.usage?.seconds)) this.seconds = e.usage.seconds;
        this.closedReason = e.reason ?? "";
        this.closedResolve?.();
        return;
      case "error":
        this.log({ gptlive_error: this.call.id, code: e.error?.code ?? "", message: String(e.error?.message ?? "").slice(0, 200) });
        return;
      default:
    }
  }

  audioOut(b64) {
    const t = this.now();
    if (this.mute) {
      // The guard is holding the voice. Released once the correction is in and the claim's audio has
      // stopped arriving, or after four seconds whatever happens, so a lost ack never mutes a call.
      const quietFor = t - this.mute.lastDropAt;
      if ((this.mute.acked && quietFor >= 300) || t - this.mute.since > 4000) {
        this.log({ gptlive_guard_released: this.call.id, ms: t - this.mute.since });
        this.mute = null;
      } else {
        this.mute.lastDropAt = t;
        return;
      }
    }
    // A line call: only the words Reason handed over reach the line; the voice's own are dropped.
    // Runs of the voice's speech, as they arrive (a gap of VOICE_RUN_GAP_MS starts a new one): a run
    // begun before they answered the pickup opener is the voice's reply to their hello, never a reply.
    if (hasSpeech(b64)) {
      if (t - (this.voiceSpeechAt ?? -Infinity) > VOICE_RUN_GAP_MS) {
        this.voiceRunFrom = t;
        // Begun while they were speaking: not a reply to them (a reply waits for their pause).
        this.voiceRunOverThem = t - this.callerSpeechAt < VOICE_RUN_GAP_MS;
      }
      this.voiceSpeechAt = t;
    }
    if (this.line && !this.talking) {
      const open = this.gateOpen(t, b64) || this.ownOpener(t, b64);
      // Only speech that never reached the line is "its own" (`speakLine`). Counting the words it was
      // handed too told it "nobody heard you" mid-sentence, and it said the intro again (call 59).
      if (!open) { this.dropped++; if (hasSpeech(b64)) this.rawSpeechAt = t; return; }
    }
    if (this.talking && this.heldSound(t, b64)) return;
    const buf = Buffer.from(b64, "base64");
    if (this.firstVoiceMs == null && this.streamStartAt != null && hasSpeech(b64)) {
      // How long the person who picked up waited for Reason's first word (call 53: 3.1 s).
      this.firstVoiceMs = t - this.streamStartAt;
      this.log({ gptlive_first_voice: this.call.id, ms: this.firstVoiceMs, warm: !!this.adopted });
    }
    this.lastOutAt = t;
    this.tape.reason(buf);
    this.playheadAt = Math.max(this.playheadAt, t) + buf.length / 8;
    // The session streams silence between words, so "quiet" for a hang-up is no SPEECH arriving.
    if (hasSpeech(b64)) { this.lastVoiceAt = t; this.voiceEndsAt = this.playheadAt; }
    this.toTwilio({ event: "media", media: { payload: b64 } });
    for (const turn of this.pending.values()) if (turn.firstAudioMs == null) turn.firstAudioMs = t - turn.startedAt;
    for (const turn of this.answered ?? []) {
      if (turn.firstRealMs == null && t >= turn.resultAt) {
        turn.firstRealMs = t - turn.startedAt;
        if (turn.firstAudioMs == null) turn.firstAudioMs = turn.firstRealMs;
        this.heard(turn);
      }
    }
  }

  textOut(delta) {
    const t = this.now();
    // The words of a listening sound held back or dropped (`heldSound`) were never said.
    if (this.talking && (this.sound || t - this.soundDroppedAt < 1500) && BARE_SOUND.test(delta)) return;
    // Words of audio that never reached the line were never said (a line call's gate was shut).
    if (this.line && !this.talking && (this.gate ? !this.gate.acked : t - this.gateClosedAt > 1500)) return;
    if (t - this.lastOutTextAt > 1500) this.utter = "";
    this.lastOutTextAt = t;
    this.utter += delta;
    for (const p of this.pending.values()) { p.ackAt ??= t; p.ack = (p.ack ?? "") + delta; }
    // The seeded opener stands in until the voice's own words arrive, then gives way to them: call 68
    // (2026-11-01) had it once in the recording and twice in the transcript, seed then the real words.
    if (!this.line && this.turns.some(x => x.seeded)) this.turns = this.turns.filter(x => !x.seeded);
    const last = this.turns.at(-1);
    if (last && last.who === "reason" && !last.seeded && t - last.at < 4000) { last.text += delta; last.at = t; }
    else this.turns.push({ who: "reason", text: delta.trimStart(), at: t, from: t });
    const line = this.turns.at(-1);
    if (soundsLikeFarewell(line.text)) {
      this.farewellAt = line.from ?? t;
      if (this.byeTimer) this.timers.clearTimeout(this.byeTimer);
      if (!this.ending) this.byeTimer = this.timers.setTimeout(() => void this.readGoodbye(), BYE_SETTLE_MS);
    }
    // Words of the claim already being held back are not a second claim; anything a second on is.
    if (this.mute && t - this.mute.since < 1000) return;
    const said = withoutSilenceMarker(this.utter);
    // A claim is only ever the echo of Reason's own: nothing pending, and Reason's latest answer said
    // so within the last minute. A request since then starts the clock again (see `delegate`).
    const confirmed = this.pending.size === 0 && this.lastResultClaimed && t - this.lastResultAt < 60_000;
    // The opening line, before they have said a word or anything was asked, is code's words — a
    // stranger's intro says "getting things done" (2026-10-31 drive: the guard cut the intro mid-line).
    const opening = this.delegations === 0 && !this.turns.some(x => x.who === "them") && fromLine(this.utter, this.greeting);
    const unconfirmed = !opening && claimsDone(this.utter) && !confirmed;
    if (said.had || unconfirmed) this.guard(said.had ? "said the silence marker" : "claimed done before Reason confirmed it");
  }

  /** The honesty guard: stop the audio the caller has not heard yet and make the voice correct itself. */
  guard(why) {
    const t = this.now();
    this.guardTrips++;
    const eventId = `guard_${this.call.id}_${this.guardTrips}`;
    this.mute = { since: t, lastDropAt: t, acked: false, eventId };
    this.utter = "";
    this.clearPlayback("guard");
    this.live.send({ type: "session.instructions.append", event_id: eventId, delegation_id: null, content: GUARD_CORRECTION });
    this.log({ gptlive_guard: this.call.id, why, pending: this.pending.size });
  }

  textIn(delta) {
    const t = this.now();
    if (delta.trim()) this.lastCallerAt = t;
    // Their hello, said before the pickup opener and transcribed after it: written down before it,
    // and not a new thing to answer (the opener answered it).
    const pre = this.beforeOpener(t);
    const last = this.turns.at(-1);
    if (pre) { pre.text += pre.text ? delta : delta.trimStart(); pre.at = t; }
    else if (last && last.who === "them" && t - last.at < 4000) { last.text += delta; last.at = t; }
    else this.turns.push({ who: "them", text: delta.trimStart(), at: t, from: t });
    // Words while a goodbye hang-up waits: hold it, and read the end again with them in it.
    if (this.line && !this.talking && delta.trim() && !pre && !this.openerAnswers()) this.lineHeard();
    if (this.ending && this.endWhy === "goodbye" && !this.done && delta.trim()) {
      this.endHeld = true;
      void this.readGoodbye();
    }
    // Barge-in. The voice stops generating when it is talked over, but what Twilio already holds keeps
    // playing; if no new audio has come since they spoke, that buffer is stale and is dropped.
    // Not the opener: its own talk-over check reads their audio (`pickupFrame`), and a late transcript
    // of the hello it answers would cut it.
    if (this.queuedMs() > 250 && this.pickup?.state !== "playing") {
      this.timers.setTimeout(() => {
        if (this.lastOutAt < t && this.queuedMs() > 250) { this.bargeIns++; this.clearPlayback("barge_in"); }
      }, 350);
    }
  }

  /** The call so far, as the messages a Reason turn reads: their words as user turns, the voice's as assistant. */
  messages() {
    const out = [];
    for (const t of this.turns) {
      const text = t.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const role = t.who === "them" ? "user" : "assistant";
      if (out.length && out.at(-1).role === role) out.at(-1).content += ` ${text}`;
      else out.push({ role, content: text });
    }
    return out;
  }

  async delegate(id) {
    if (!id) return;
    if (this.line && !this.talking) {
      // On a line call Reason's turn is started by the line itself (`lineTurn`), not by this hand-off;
      // the hand-off is kept open, its automatic acknowledgement cancelled (an empty quiet update, per
      // the docs), and the next words Reason has for the line are its result.
      this.live.send({ type: "session.thinking.append", event_id: `quiet_${id}`, delegation_id: id, content: "" });
      this.openDelegation = id;
      return;
    }
    this.delegations++;
    const turn = { id, startedAt: this.now(), msgCount: 0, firstAudioMs: null, firstRealMs: null, resultAt: null };
    this.pending.set(id, turn);
    this.latest = id;
    this.lastResultClaimed = false;
    const messages = this.messages();
    turn.msgCount = messages.length;
    this.log({ gptlive_delegation: this.call.id, n: this.delegations, messages: messages.length });
    // A slow turn: the voice is told, not asked to speak, that nothing has finished — so if they ask,
    // the honest answer is to hand.
    const late = this.timers.setTimeout(() => {
      if (this.pending.has(id)) this.live.send({ type: "session.thinking.append", event_id: `late_${id}`, delegation_id: id, content: "Reason is still working on this; there is no result yet." });
    }, 8000);
    let reply;
    try {
      reply = await this.brain(messages);
    } catch (e) {
      reply = { text: "Something broke on my end there.", tools: [], endCall: null, skip: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    this.timers.clearTimeout(late);
    this.pending.delete(id);
    if (this.done) return;
    if (this.latest !== id) {
      // They said something new while this ran; Reason has already started on that, and this answer is
      // to a question that has moved on.
      this.log({ gptlive_delegation_superseded: this.call.id });
      return;
    }
    turn.resultAt = this.now();
    turn.totalMs = turn.resultAt - turn.startedAt;
    const honest = withoutUnbackedSends([reply.text, reply.endCall?.message].filter(Boolean).join(" ").trim(), reply.tools);
    if (honest.dropped) this.log({ gptlive_unbacked_send: this.call.id, dropped: honest.dropped, tools: reply.tools ?? [] });
    const spoken = honest.text;
    if (spoken) {
      this.lastResultClaimed = claimsDone(spoken);
      this.lastResultAt = turn.resultAt;
      this.live.send({ type: "session.commentary.append", event_id: `result_${id}`, delegation_id: id, content: spoken.slice(0, 1800) });
      (this.answered ??= []).push(turn);
    } else if (this.promisedThought(turn)) {
      // Call 68 (2026-11-01): "Hmm. Lemme have a think." then Reason skipped, the voice was told to say
      // nothing, and the line sat silent until he said "Hello". A thought announced is closed out loud.
      this.log({ gptlive_skip_followed_up: this.call.id });
      this.live.send({ type: "session.commentary.append", event_id: `result_${id}`, delegation_id: id, content: SKIP_FOLLOW_UP });
      (this.answered ??= []).push(turn);
    } else {
      this.live.send({ type: "session.thinking.append", event_id: `result_${id}`, delegation_id: id, content: "Reason has nothing to add right now. Say nothing more about it and listen." });
      this.heard(turn);
    }
    this.log({ gptlive_result: this.call.id, ms: turn.totalMs, chars: spoken.length, tools: reply.tools ?? [], ends: !!reply.endCall, ...(reply.error ? { error: reply.error } : {}) });
    // A machine verdict that came during this hand-off, after talk mode turned off: read now.
    if (this.line && !this.talking && this.amdNote && !this.pending.size) {
      const note = this.amdNote;
      this.amdNote = null;
      this.afterSpeech(() => this.runLine("amd", { note: `[${note}]` }));
    }
    if (this.line) {
      // A talking business call hands Reason a menu too: its key, or a hand-over, carried out here.
      const calls = reply.calls ?? [];
      const press = calls.find(c => c.name === "play_keypad_touch_tone");
      const transfer = calls.find(c => c.name === "transfer_to_number");
      if (press) this.afterSpeech(() => void this.press(String(press.args?.dtmf_tones ?? "")));
      if (transfer) this.handOff(transfer.args ?? {});
    }
    if (reply.endCall) this.hangUpAfterSpeech();
  }

  /**
   * Did the voice, while this hand-off ran, tell them it was thinking or checking — on a call where they
   * are talking with Reason (not a line call), with nothing said by them since? Then an empty result
   * must still be answered out loud.
   */
  promisedThought(turn) {
    if (this.line) return false;
    const ack = String(turn.ack ?? "").trim();
    // Their words up to the voice's "let me think" are the question still being transcribed; words after
    // it are them talking again. An ack that ends on a question already handed the turn back.
    // Any words of its own count, not only the phrasings in THINKING_ACK: drives showed the voice words
    // its promise a new way nearly every run. A bare listening sound ("mm-hmm") is not one.
    const promised = THINKING_ACK.test(ack) || (ack && !BARE_SOUND.test(ack) && !/^(?:mm-?hmm|uh-?huh|yeah|okay|right|sure)[.!,\s]*$/i.test(ack));
    return promised && !/\?\s*$/.test(ack) && this.lastCallerAt < (turn.ackAt ?? turn.startedAt);
  }

  /** What the caller heard for one turn, onto the call_turns row Reason's own turn wrote. */
  heard(turn) {
    this.answered = (this.answered ?? []).filter(t => t !== turn);
    if (this.persona) return;
    try {
      db.markCallTurnHeard(this.call.id, turn.msgCount, {
        voice: PROVIDER, firstContentMs: turn.firstAudioMs, firstRealMs: turn.firstRealMs,
        firstContentKind: turn.firstAudioMs == null ? null : turn.firstRealMs != null && turn.firstAudioMs >= turn.firstRealMs ? "real" : "ack",
      });
    } catch (e) {
      this.log({ gptlive_turn_row_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  }

  /** The last lines of the call, as the end readers are shown them. */
  tail(n = 8) {
    return this.turns.slice(-n).map(x => ({ who: x.who === "them" ? "Them" : "Reason", text: x.text.replace(/\s+/g, " ").trim() }))
      .filter(x => x.text).map(x => `${x.who}: ${x.text}`).join("\n");
  }

  /**
   * The voice just said something goodbye-ish: ask whether the call is over (a mutual goodbye) and, if
   * so, hang up once it has finished speaking. Run again while that hang-up waits and they speak, so
   * "bye — oh wait, one more thing" calls it off. A "bye" to someone in the room is not mutual, and an
   * unanswerable read (null) never hangs up: they can always hang up themselves, as before.
   */
  async readGoodbye() {
    this.byeTimer = null;
    if (this.done || !this.farewellAt) return;
    if (this.ending ? this.endWhy !== "goodbye" : this.pending.size > 0) return;
    if (this.byeAsking) { this.byeAgain = true; return; }
    this.byeAsking = true;
    const heardTo = this.lastCallerAt;
    const askedAt = this.now();
    const ended = await this.judge({ kind: "goodbye", transcript: this.tail() }).catch(() => null);
    this.byeAsking = false;
    this.log({ gptlive_goodbye_read: this.call.id, ended, waiting: this.ending, ms: this.now() - askedAt });
    if (this.done) return;
    if (this.byeAgain || this.lastCallerAt !== heardTo) { this.byeAgain = false; return void this.readGoodbye(); }
    if (this.ending) {
      if (ended === true) this.endHeld = false;
      else { this.ending = false; this.endWhy = ""; this.endHeld = false; this.goodbyeAt = 0; this.log({ gptlive_goodbye_called_off: this.call.id }); }
      return;
    }
    if (ended === true && this.pending.size === 0) { this.goodbyeAt = this.farewellAt; this.hangUpAfterSpeech("goodbye"); }
  }

  /**
   * Hang up once the goodbye has played out, by ending the stream (which ends the call): `end_call`
   * when Reason asked, `goodbye` when the voice and the caller said it to each other. A goodbye
   * hang-up also waits while they are talking, or while their words are being read.
   */
  hangUpAfterSpeech(why = "end_call") {
    if (this.ending) return;
    this.ending = true;
    this.endWhy = why;
    const started = this.now();
    const tick = () => {
      if (this.done || !this.ending) return;
      const t = this.now();
      const quiet = why === "goodbye"
        ? t - this.lastVoiceAt > 1000 && t >= this.voiceEndsAt + 500
        : t - this.lastOutAt > 1500 && this.queuedMs() === 0 && !(this.gate && !this.gate.heard) && !this.pendingSay;
      const held = why === "goodbye" && (this.endHeld || t - this.lastCallerAt < 1000);
      const minMs = why === "goodbye" ? 0 : 2500;
      if (!held && ((quiet && t - started >= minMs) || t - started > 15000)) return void this.end(why).catch(() => {});
      this.timers.setTimeout(tick, 250);
    };
    this.timers.setTimeout(tick, 250);
  }

  /**
   * Were they saying something as the call ended, right after Reason's goodbye? Their words after it
   * are read by the small model ("bye" / "you too" is only the goodbye finishing); with no words yet,
   * speech on their side in the last moments of a hang-up Reason made counts. `{ words }`, or null.
   */
  async cutOff() {
    const at = this.endedAt ?? this.now();
    if (!this.farewellAt || at - this.farewellAt > 20_000) return null;
    const late = this.turns.filter(x => x.who === "them" && (x.from ?? x.at) >= this.farewellAt)
      .map(x => x.text.replace(/\s+/g, " ").trim()).join(" ").replace(/^[\s,.;:—-]+/, "").trim();
    let cut;
    if (late) cut = (await this.judge({ kind: "cutoff", transcript: this.tail(), late }).catch(() => null)) === true;
    else {
      cut = ["goodbye", "end_call"].includes(this.endWhy) && this.callerSpeechFrom >= this.farewellAt
        && at - this.callerSpeechAt < 1500 && this.callerSpeechAt - this.callerSpeechFrom >= 300;
    }
    this.log({ gptlive_cut_off: this.call.id, cut, words: late.length });
    return cut ? { words: late.slice(0, 200) } : null;
  }

  // --- a line call: a business, a menu, hold, a mailbox (phase 3) ---

  // --- the pickup opener (./opener.js) ---

  /** One frame of their side while the opener waits for its moment or plays. */
  pickupFrame(t, voiced) {
    const p = this.pickup;
    if (this.done || this.rejoining) return;
    const since = t - (this.streamStartAt ?? t);
    if (p.state === "waiting") {
      if (voiced) { p.theirsFrom ??= t; p.theirsAt = t; }
      if (p.theirsFrom != null) {
        if (t - p.theirsAt >= opener.OPENER_AFTER_THEM_MS) return this.playOpener("after their hello");
        if (t - p.theirsFrom > opener.OPENER_MAX_THEIRS_MS) return this.skipOpener("a long greeting (a recording or a menu)");
      } else if (since >= opener.OPENER_SILENT_MS) return this.playOpener("a silent line");
      if (since > opener.OPENER_GIVE_UP_MS) this.skipOpener("the line never paused");
      return;
    }
    // Playing: done once its last frame has played; stopped if they talk over it for long.
    if (t >= p.endsAt) return this.openerPlayed(t);
    if (voiced) {
      p.overMs = (p.overMs ?? 0) + 20;
      p.overFrom ??= t;
      // Their hello a beat into the clip: stop, and say it again once they have finished.
      if (!p.replayed && p.overMs >= opener.OPENER_OVERLAP_MS && p.overFrom - p.startedAt <= opener.OPENER_REPLAY_WINDOW_MS) return this.replayOpener();
      if (p.overMs >= opener.OPENER_TALKED_OVER_MS) this.cutOpener();
    }
  }

  /**
   * The clip has played. Anything they said over its tail is theirs to be answered (the voice heard it);
   * a line that stays quiet after it gets one short "hello?" (the quiet-line opener, which waits for it).
   */
  openerPlayed(t) {
    const p = this.pickup;
    p.state = "played";
    if (p.overMs && !this.talking) this.callerVoiceAt = t;
    if (this.openTimer) this.timers.clearTimeout(this.openTimer);
    this.openTimer = this.timers.setTimeout(() => this.quietAfterOpener(), opener.OPENER_QUIET_AFTER_MS);
  }

  quietAfterOpener() {
    this.openTimer = null;
    if (this.done || this.talking || this.gate || this.pendingSay || this.pending.size || this.rejoining || this.callerVoiceAt) return;
    if (this.theirVoiceAt > (this.pickup?.endsAt ?? 0)) return;
    this.log({ gptlive_opener_quiet_after: this.call.id });
    this.speakLine("They have not said anything since your opening line. Say only this, then stop and wait for them: \"Hello — can you hear me okay?\"");
    if (this.gate) this.gate.opener = true;
    else if (this.pendingSay) this.pendingSay.opener = true;
  }

  /** They started their hello over the clip's first words: it stops, and waits for their pause. */
  replayOpener() {
    const p = this.pickup;
    const t = this.now();
    if (p.pumpTimer) this.timers.clearTimeout(p.pumpTimer);
    this.clearPlayback("opener: their hello came over it");
    this.turns = this.turns.filter(x => x !== p.turn);
    p.replayed = true;
    p.state = "waiting";
    p.theirsFrom = p.overFrom;
    p.theirsAt = t;
    p.overFrom = null; p.overMs = 0;
    p.turn = null;
    this.log({ gptlive_pickup_opener_again: this.call.id, played_ms: t - p.startedAt });
  }

  skipOpener(why) {
    this.pickup.state = "none";
    this.pickup.why = why;
    this.log({ gptlive_pickup_opener_skipped: this.call.id, why, ms: this.now() - (this.streamStartAt ?? this.startedAt) });
    // Words that came while it waited were held back for it: the line reads them now (a menu's key).
    if (this.line && !this.talking && this.theySpokeSince(0)) this.lineHeard();
  }

  /** Play the clip down the line now, and write it down as said. */
  playOpener(why) {
    const p = this.pickup;
    const t = this.now();
    const buf = p.clip.audio;
    p.state = "playing";
    p.startedAt = t;
    p.why = why;
    p.afterThem = p.theirsFrom != null;
    // Their hello, if its words are already written down, is placed already; else it is placed when they land.
    p.preDone = !p.afterThem || this.turns.some(x => x.who === "them" && x.text.trim());
    // Sent at the pace it plays (a little ahead), as the live voice's audio comes: a stop is then
    // exact, and nothing sits queued at Twilio past the moment it was cut.
    p.sent = 0;
    p.endsAt = Math.max(this.playheadAt, t) + buf.length / 8;
    this.voiceEndsAt = p.endsAt;
    this.pumpOpener();
    if (this.firstVoiceMs == null && this.streamStartAt != null) {
      this.firstVoiceMs = t - this.streamStartAt;
      this.log({ gptlive_first_voice: this.call.id, ms: this.firstVoiceMs, warm: false, opener: p.clip.kind });
    }
    p.turn = { who: "reason", text: p.clip.text, at: t, from: t, opener: true };
    this.turns.push(p.turn);
    // Only their voice after the opener answers it (`ownOpener`); a hand-off due on the hello is moot.
    this.callerVoiceAt = 0;
    if (this.lineTimer) { this.timers.clearTimeout(this.lineTimer); this.lineTimer = null; this.lineHeardFrom = null; }
    if (this.openTimer) { this.timers.clearTimeout(this.openTimer); this.openTimer = null; }
    this.log({ gptlive_pickup_opener: this.call.id, kind: p.clip.kind, why, ms: this.firstVoiceMs, audio_ms: Math.round(buf.length / 8), session_up: this.started });
    // A hello-only clip after they spoke: the voice says why straight on, so the call talks from here.
    if (p.clip.kind === "hello" && p.afterThem) this.startTalking("pickup opener");
    this.tellOpener();
  }

  /** The clip's next frames, keeping ~240 ms queued ahead of what is playing. */
  pumpOpener() {
    const p = this.pickup;
    if (!p || p.state !== "playing" || this.done) return;
    const buf = p.clip.audio;
    const t = this.now();
    while (p.sent < buf.length && this.playheadAt - t < 240) {
      const frame = buf.subarray(p.sent, p.sent + 160);
      p.sent += frame.length;
      this.toTwilio({ event: "media", media: { payload: frame.toString("base64") } });
      this.tape.reason(frame);
      this.playheadAt = Math.max(this.playheadAt, t) + frame.length / 8;
      this.lastOutAt = t; this.lastVoiceAt = t;
    }
    if (p.sent < buf.length) p.pumpTimer = this.timers.setTimeout(() => this.pumpOpener(), 100);
  }

  /** Tell the voice what the opener said for it — at once, or the moment its session is up. */
  tellOpener() {
    const p = this.pickup;
    if (!this.started) { p.tellOnStart = true; return; }
    if (p.state !== "cut" && p.told) return;
    p.told = true;
    const said = p.clip.text.replace(/"/g, "'");
    const id = `opener_${this.call.id}`;
    if (p.state === "cut") {
      this.live.send({ type: "session.instructions.append", event_id: `${id}_cut`, delegation_id: null, content: `The call opened with code saying "${said}" for you, but they talked over it, so they may not have heard it. When a person speaks to you, greet them briefly and say why you're calling.` });
    } else if (p.clip.kind === "hello" && p.afterThem) {
      this.live.send({ type: "session.commentary.append", event_id: id, delegation_id: null, content: `Code has just said "${said}" to them for you, in your voice. Without saying hi again, say in one short, natural breath what you're calling about, then stop and listen.` });
    } else if (p.clip.kind === "hello") {
      this.live.send({ type: "session.instructions.append", event_id: id, delegation_id: null, content: `The call has opened: code just said "${said}" to them for you, in your voice. When they answer, don't say hi again — go straight to what you're calling about.` });
    } else {
      this.live.send({ type: "session.instructions.append", event_id: id, delegation_id: null, content: `The call has opened: code just said this to them for you, in your voice: "${said}" They heard it. Don't greet them again and don't repeat why you're calling — your next words answer whatever they say to it.` });
    }
  }

  /** They talked over the opener: the rest of it is dropped, and the voice is told they may have missed it. */
  cutOpener() {
    const p = this.pickup;
    p.state = "cut";
    if (p.pumpTimer) this.timers.clearTimeout(p.pumpTimer);
    this.clearPlayback("opener talked over");
    this.callerVoiceAt = this.now();
    this.log({ gptlive_pickup_opener_cut: this.call.id, played_ms: this.now() - p.startedAt });
    this.tellOpener();
  }

  /**
   * Are their words, right now, ones the pickup opener answers (or is about to)? While it waits for
   * their hello to end or plays, yes; after it, only speech that came once it had finished is new.
   * Else a Reason line turn on their hello says a second opener over it (2026-11-07 greet drive:
   * "I'm Reason, an AI assistant calling for Omari…" 8 s in, after the clip had already said why).
   */
  openerAnswers() {
    const p = this.pickup;
    if (!p || p.state === "none" || p.state === "cut") return false;
    if (p.state === "waiting" || p.state === "playing") return p.state === "playing" || p.replayed || p.theirsFrom != null;
    return !(this.callerSpeechAt > p.endsAt);
  }

  /** Their first words after the opener began, from speech before it: the hello it answered. */
  beforeOpener(t) {
    const p = this.pickup;
    if (!p?.turn || !p.afterThem) return null;
    if (p.pre) return t - p.pre.at < 1500 ? p.pre : null;
    if (p.preDone) return null;
    p.preDone = true;
    if (t - p.startedAt > 4000) return null;
    const i = this.turns.indexOf(p.turn);
    p.pre = { who: "them", text: "", at: t, from: p.theirsFrom };
    this.turns.splice(i < 0 ? this.turns.length : i, 0, p.pre);
    return p.pre;
  }

  /** The session is up on a line call: a ring-back hears the disclosure; a call Reason placed waits. */
  lineStarted() {
    if (this.pickup?.tellOnStart) { this.pickup.tellOnStart = false; this.tellOpener(); }
    if (this.greeting) {
      this.speakLine(this.greeting);
      this.turns.push({ who: "reason", text: this.greeting, at: this.now(), from: this.now(), seeded: true });
    }
    this.holdTimer = this.timers.setTimeout(() => this.holdTick(), LINE_HOLD_TICK_MS);
    if (this.talk) {
      const wait = Math.max(LINE_OPEN_AFTER_MS - (this.now() - (this.streamStartAt ?? this.startedAt)), LINE_OPEN_MIN_MS);
      this.openTimer = this.timers.setTimeout(() => this.openIfQuiet(), wait);
    }
    if (this.amdLater) { const v = this.amdLater; this.amdLater = null; this.amd(v); }
  }

  /**
   * Talk mode: from here on the voice talks with whoever is there, as on an own call — no more line
   * turns, its own words reach them, and Reason only hears from it what it hands over (`delegate`).
   * The person is written down as told (the row's opening line is this call's only opener).
   */
  startTalking(why) {
    if (this.talking || !this.talk) return;
    this.talking = true;
    this.talkingAt = this.now();
    this.gate = null;
    if (this.lineTimer) { this.timers.clearTimeout(this.lineTimer); this.lineTimer = null; this.lineHeardFrom = null; }
    if (this.openTimer) { this.timers.clearTimeout(this.openTimer); this.openTimer = null; }
    // Words still waiting to be handed over are a second reply over the voice's own: dropped. A hand-off
    // the voice made while silent gets its answer now ("nothing"), so it never waits on it.
    this.pendingSay = null;
    if (this.openDelegation) {
      this.live.send({ type: "session.thinking.append", event_id: `talk_${this.openDelegation}`, delegation_id: this.openDelegation, content: "Reason has nothing to add right now. Talk with them yourself." });
      this.openDelegation = null;
    }
    if (this.noticeTimer) this.timers.clearTimeout(this.noticeTimer);
    try {
      const row = this.freshRow();
      hold.notePerson(row, { log: this.log });
      // Off hold: a person is talking (hold.js's whole hold detector is "Reason spoke").
      if (hold.onHold(row)) hold.noteSpeaking(row, { log: this.log });
      hold.markAnnounced(row, { party: hold.currentParty(row), log: this.log });
    } catch { /* bookkeeping never stops a call */ }
    this.log({ gptlive_line_talking: this.call.id, why, ms: this.now() - (this.streamStartAt ?? this.startedAt) });
    if (this.notice?.notice) this.noticeTimer = this.timers.setTimeout(() => this.checkNotice(), LINE_NOTICE_CHECK_MS);
  }

  /** Talk mode, before anyone is confirmed: the voice answering somebody who spoke is let through. */
  ownOpener(t, b64) {
    if (!this.talk || this.rejoining || this.heldVoicemail || !hasSpeech(b64)) return false;
    // Somebody has spoken (their voice, before its transcript arrives, or the transcript). After the
    // pickup opener only their voice since it counts: the transcript of the hello it answered lands late.
    // And the voice's speech must be a NEW run, begun after they started answering the opener: the tail
    // of the reply it made to their hello while the clip played (dropped) is still streaming when they
    // answer, and let through it reached them as "…low back" (2026-11-07 greet drive).
    if (this.pickup?.startedAt) {
      if (!this.callerVoiceAt) return false;
      // A pause inside that reply looks like a new run (greet drive 5: "…recommend? [pause] And how much
      // would" went out as they spoke), so a run begun while they were still talking is not one either.
      if ((this.voiceRunFrom ?? 0) < this.callerVoiceAt || this.voiceRunOverThem) {
        if (!this.staleRun || this.staleRun !== this.voiceRunFrom) { this.staleRun = this.voiceRunFrom; this.staleRuns = (this.staleRuns ?? 0) + 1; this.log({ gptlive_stale_voice_dropped: this.call.id }); }
        return false;
      }
    }
    else if (!this.callerVoiceAt && !this.theySpokeSince(this.talkCutoff ?? 0)) return false;
    // A mailbox stays silent (Reason's turn leaves the message, after the beep). A menu or hold does
    // not: the voice is silent through those itself (drives), and the person who comes on after them
    // gets its answer at once — blocked, Sam waited 12 s for Reason's turn (2026-10-31 ivr drive).
    if (this.mailboxNow(t)) return false;
    this.startTalking("the voice answered them");
    return true;
  }

  /**
   * Talk mode: is this frame part of a sound held back (BC_* above)? Returns true when the frame was
   * taken (held or dropped); a held sound that turns into a reply is played from its first frame.
   */
  heldSound(t, b64) {
    if (this.soundFlushing) return false;
    const speech = hasSpeech(b64);
    const ms = Buffer.from(b64, "base64").length / 8;
    const h = this.sound;
    if (!h) {
      if (!speech) return false;
      // The rest of a run of speech whose start was dropped: dropped too (never half a sentence).
      if (t - this.soundCutAt < BC_SELF_MS[0]) { this.soundCutAt = t; return true; }
      // Still the same run of speech: let it through.
      if (t - this.lastVoiceAt < BC_SELF_MS[0]) return false;
      const playsAt = Math.max(this.playheadAt, t);
      const intoTheirPause = playsAt - this.theirVoiceAt < BC_CALLER_MS;
      const sinceOwn = playsAt - this.voiceEndsAt;
      const afterItself = this.lastVoiceAt > 0 && this.theirVoiceAt < this.lastVoiceAt && sinceOwn >= BC_SELF_MS[0] && sinceOwn <= BC_SELF_MS[1]
        && !this.pending.size && t - this.lastResultAt > 4000 && !this.ending;
      if (!intoTheirPause && !afterItself) return false;
      this.sound = { since: t, frames: [b64], speechMs: ms, quietMs: 0, speechAt: t, why: intoTheirPause ? "into their pause" : "after its own words" };
      this.soundTimer = this.timers.setTimeout(() => this.soundEnded(), BC_WAIT_MS);
      return true;
    }
    h.frames.push(b64);
    if (speech) { h.speechMs += ms; h.quietMs = 0; h.speechAt = t; } else h.quietMs += ms;
    if (this.theirVoiceAt > h.since) this.dropSound("they talked");
    else if (h.speechMs >= BC_REAL_MS) this.playSound();
    else if (h.quietMs >= BC_END_MS) this.dropSound("a short sound");
    else {
      this.timers.clearTimeout(this.soundTimer);
      this.soundTimer = this.timers.setTimeout(() => this.soundEnded(), BC_WAIT_MS);
    }
    return true;
  }

  /** No more audio came for a held sound: it was short (dropped) unless it already ran long. */
  soundEnded() {
    this.soundTimer = null;
    if (!this.sound) return;
    if (this.sound.speechMs >= BC_REAL_MS && this.theirVoiceAt <= this.sound.since) this.playSound();
    else this.dropSound(this.theirVoiceAt > this.sound.since ? "they talked" : "a short sound");
  }

  playSound() {
    const h = this.sound;
    this.sound = null;
    if (this.soundTimer) { this.timers.clearTimeout(this.soundTimer); this.soundTimer = null; }
    this.soundFlushing = true;
    try { for (const f of h.frames) this.audioOut(f); } finally { this.soundFlushing = false; }
    this.log({ gptlive_sound_played: this.call.id, held_ms: this.now() - h.since });
  }

  dropSound(why) {
    const h = this.sound;
    this.sound = null;
    if (this.soundTimer) { this.timers.clearTimeout(this.soundTimer); this.soundTimer = null; }
    const t = this.now();
    this.soundDroppedAt = t;
    this.soundCutAt = h.speechAt;
    this.soundsDropped++;
    // Its words, if the transcript came first, were never said either.
    const last = this.turns.at(-1);
    if (last && last.who === "reason" && !last.seeded && t - last.at < 2000) {
      if (BARE_SOUND.test(last.text)) this.turns.pop();
      else last.text = last.text.replace(/\s+(?:m+|hm+|mhm+|mm-?hm+|uh-?huh)[.!?…]*\s*$/i, "");
    }
    this.log({ gptlive_sound_dropped: this.call.id, why, kind: h.why, speech_ms: h.speechMs });
  }

  /** Has Reason's turn written this line down as a mailbox? (Read at most every 400 ms: the audio path.) */
  mailboxNow(t) {
    if (t - (this.lineReadAt ?? -Infinity) > 400) {
      this.lineReadAt = t;
      this.lineIsMachine = callOutcome.reachedMachine(this.freshRow());
    }
    return this.lineIsMachine;
  }

  /** Did their side say any words after `at`? */
  theySpokeSince(at) {
    return this.turns.some(x => x.who === "them" && x.text.trim() && (x.at ?? 0) > at);
  }

  /**
   * Back to the silent line (a menu or a mailbox after all): what counted as "somebody spoke" is spent,
   * so only new words let the voice talk again, and the talk-mode timers go.
   */
  stopTalking(why) {
    if (!this.talking) return;
    if (this.sound) this.dropSound("talk stopped");
    this.talking = false;
    this.callerVoiceAt = 0;
    this.talkCutoff = this.now();
    if (this.noticeTimer) { this.timers.clearTimeout(this.noticeTimer); this.noticeTimer = null; }
    this.log({ gptlive_line_talking_stopped: this.call.id, why });
  }

  /** Nobody has said a word ~3 s after the pickup: open the way a person would. */
  openIfQuiet() {
    this.openTimer = null;
    if (this.done || this.talking || this.gate || this.pendingSay || this.pending.size || this.rejoining) return;
    // The pickup opener already said hello (or is about to).
    if (this.pickup && this.pickup.state !== "none") return;
    // Somebody has spoken (even if the words are not transcribed yet): they get answered, not talked over.
    if (this.callerVoiceAt || this.theySpokeSince(0)) return;
    const place = String(briefOf(this.call)?.place ?? "").trim();
    this.log({ gptlive_line_opened_quiet: this.call.id, ms: this.now() - (this.streamStartAt ?? this.startedAt) });
    const line = place ? `Hi, is this ${place}?` : "Hi there, hello?";
    // Talk mode reads a result as content for its own words; here it is only the hello, then a wait
    // (2026-10-31 drive: told the bare line, it went on into the whole errand to a silent line).
    this.speakLine(`Nobody has said anything yet. Say only this, then stop and wait for them to answer: "${line}"`);
    if (this.gate) this.gate.opener = true;
    else if (this.pendingSay) this.pendingSay.opener = true;
  }

  /** The law where they are wants them told it is recorded: said yet? If not, the next reply says it. */
  checkNotice() {
    this.noticeTimer = null;
    if (this.done) return;
    const said = this.turns.some(x => x.who === "reason" && /\brecord/i.test(x.text));
    this.log({ gptlive_notice: this.call.id, said, state: this.notice?.state ?? "" });
    if (!said) this.live.send({ type: "session.instructions.append", event_id: `notice_${this.call.id}`, delegation_id: null, content: "You have not yet told them this call is recorded, and you must: in your next reply, say lightly \"just so you know, this call's recorded\"." });
  }

  /**
   * Is this frame of the voice's audio allowed onto the line? Only while words Reason handed over are
   * being said: from `speakLine` until their speech has been quiet a moment (or a ceiling, so a lost
   * instruction never leaves the line open to whatever the voice says next).
   */
  gateOpen(t, b64) {
    const g = this.gate;
    if (!g) return false;
    // Not before the words have reached the model (its ack): until then the audio is whatever the voice
    // was already saying on its own (2026-10-31 drive: its own "…make a reservation" ran into the line).
    if (!g.acked) {
      if (t - g.since < LINE_ACK_WAIT_MS) return false;
      g.acked = true;
    }
    // Quiet long enough since its last word (read before this frame counts) and it has said its piece.
    const over = (g.heard && t - g.lastSpeech > LINE_GATE_QUIET_MS) || t - g.since > LINE_GATE_MAX_MS;
    if (over) { this.gate = null; this.gateClosedAt = t; return false; }
    if (hasSpeech(b64)) {
      g.heard = true; g.lastSpeech = t;
      // Reason's own first words to somebody (the voice had stayed quiet): from here the call talks.
      // Not a voicemail being left: that is the call's last word, not a conversation.
      // Nor the quiet-line hello: nobody has answered it yet.
      if (this.talk && !this.talking && !g.opener && g !== this.voicemailGate && !this.ending && !this.mailboxNow(t)) this.startTalking("reason's words reached them");
    }
    return true;
  }

  /**
   * Have the voice say these words down the line: as the result of its open hand-off when it made one
   * (the path every own call's answers take), else as a speakable update; its instructions say a
   * result is the exact words. A bare instruction was not spoken at all (2026-10-31 drive).
   */
  speakLine(text) {
    const t = this.now();
    // Mid-way through something of its own (never played): stopped first, and told nobody heard it,
    // then handed the words once it is quiet. Handed them while it talked, it ran them into its own
    // sentence and left out the disclosure it thought it had said (2026-10-31 drive).
    if (t - (this.rawSpeechAt ?? -Infinity) < LINE_BUSY_MS) {
      this.speakN = (this.speakN ?? 0) + 1;
      this.live.send({ type: "session.instructions.append", event_id: `stop_${this.call.id}_${this.speakN}`, delegation_id: null, content: LINE_STOP_OWN });
      this.pendingSay = { text, at: t };
      const tick = () => {
        if (this.done || !this.pendingSay) return;
        const now = this.now();
        const quiet = now - (this.rawSpeechAt ?? -Infinity) >= LINE_BUSY_MS;
        if (quiet || now - this.pendingSay.at > LINE_ACK_WAIT_MS) {
          const { text: say, opener } = this.pendingSay;
          this.pendingSay = null;
          this.sayNow(say, { quiet });
          if (opener && this.gate) this.gate.opener = true;
          return;
        }
        this.timers.setTimeout(tick, 100);
      };
      this.timers.setTimeout(tick, 100);
      this.log({ gptlive_line_stopped_own: this.call.id });
      return;
    }
    this.sayNow(text, { quiet: true });
  }

  sayNow(text, { quiet }) {
    const t = this.now();
    this.speakN = (this.speakN ?? 0) + 1;
    const eventId = `say_${this.call.id}_${this.speakN}`;
    const delegationId = this.openDelegation ?? null;
    this.openDelegation = null;
    // The voice quiet: its next speech is these words, let through from the first frame. Still talking:
    // held until the words are in (their ack), so its own tail stays off the line.
    this.gate = { since: t, heard: false, lastSpeech: t, acked: quiet, eventId };
    this.live.send({ type: "session.commentary.append", event_id: eventId, delegation_id: delegationId, content: String(text) });
    this.log({ gptlive_line_said: this.call.id, chars: String(text).length, on_delegation: !!delegationId });
  }

  /**
   * Their side said something. Reason's call turn runs once they pause (or, on a line that never
   * pauses, a few seconds in): every utterance on a line call goes to Reason, which is how a menu gets
   * a key press, hold music a wait, and a person the disclosure — the voice is never the one to judge.
   */
  lineHeard() {
    const t = this.now();
    this.lineHeardFrom ??= t;
    if (this.lineTimer) this.timers.clearTimeout(this.lineTimer);
    const wait = Math.max(0, Math.min(LINE_QUIET_MS, this.lineHeardFrom + LINE_MAX_WAIT_MS - t));
    this.lineTimer = this.timers.setTimeout(() => {
      this.lineTimer = null;
      this.lineHeardFrom = null;
      this.runLine("heard");
    }, wait);
  }

  /**
   * One Reason call turn for the line, the `llmRequest` turn (third-party
   * context, brief, commit gate, hold, menus, machines — all written onto the row by that turn), and
   * then what it asked for carried out here: words said, a key pressed, a wait, a hang-up.
   *
   * One at a time. Words heard while a turn runs do not start another: the answer that comes back is
   * said (it answers them too, as a re-ask joins a running turn, #275); if nothing was said — a wait, a
   * key — the line is read again with the new words in it.
   */
  /** `lineTurn`, from a timer or a webhook: never a rejection anybody has to catch. */
  runLine(why, opts) {
    this.lineTurn(why, opts).catch((e) => this.log({ gptlive_line_turn_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] }));
  }

  async lineTurn(why, { note = "" } = {}) {
    if (this.done || (this.ending && why !== "amd")) return;
    if (this.talking) return;
    // A voicemail waiting for its beep is the call's last word; the rest of the greeting is not a turn.
    if (this.heldVoicemail) return;
    // Words still arriving from the menu just answered with a key: the line after the press is a turn.
    if (this.rejoining && why === "heard") return;
    if (this.pending.size || this.lineBusy) { this.lineAgain = true; return; }
    const id = `line_${this.call.id}_${++this.lineN}`;
    this.delegations++;
    const turn = { id, startedAt: this.now(), msgCount: 0, firstAudioMs: null, firstRealMs: null, resultAt: null };
    this.pending.set(id, turn);
    this.latest = id;
    this.lastResultClaimed = false;
    this.lastLineTurnAt = turn.startedAt;
    const messages = this.messages();
    if (note) {
      if (messages.at(-1)?.role === "user") messages.at(-1).content += ` ${note}`;
      else messages.push({ role: "user", content: note });
    }
    turn.msgCount = messages.length;
    this.log({ gptlive_line_turn: this.call.id, n: this.lineN, why, messages: messages.length });
    let reply;
    try {
      reply = await this.brain(messages);
    } catch (e) {
      reply = { text: "", tools: [], calls: [], endCall: null, skip: true, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    this.pending.delete(id);
    if (this.done) return;
    turn.resultAt = this.now();
    turn.totalMs = turn.resultAt - turn.startedAt;
    // A turn begun on their hello before the pickup opener played: the opener answered it, so its words
    // would be a second opener. A key or a hang-up it decided still goes.
    if (!this.talking && this.pickup?.startedAt && turn.startedAt < this.pickup.startedAt) {
      const calls = reply.calls ?? [];
      if (!calls.some(c => c.name === "play_keypad_touch_tone" || c.name === "transfer_to_number") && !reply.endCall) {
        this.log({ gptlive_line_turn_before_opener: this.call.id, n: this.lineN });
        this.heard(turn);
        return;
      }
    }
    if (this.talking) {
      // The voice answered them while this ran (talk mode): its words are the reply, and these would be
      // a second one over the top (call 59: two openers queued). A key it asked for still goes.
      // A key or a hang-up decided on menu words only stands if nothing was said since: a menu that
      // put a person through ("front desk!") must not get the key pressed at her.
      const calls = reply.calls ?? [];
      const press = calls.find(c => c.name === "play_keypad_touch_tone");
      const transfer = calls.find(c => c.name === "transfer_to_number");
      const fresh = this.lastCallerAt <= turn.startedAt;
      this.log({ gptlive_line_turn_overtaken: this.call.id, n: this.lineN, press: !!press, fresh });
      this.heard(turn);
      if (!fresh) return;
      if (press) {
        this.stopTalking("a menu after all");
        this.live.send({ type: "session.instructions.append", event_id: `menu_${this.call.id}_${this.lineN}`, delegation_id: null, content: "That was a phone menu, not a person. Say nothing now until a person speaks to you." });
        await this.press(String(press.args?.dtmf_tones ?? ""));
      } else if (transfer) this.handOff(transfer.args ?? {});
      else if (reply.endCall && callOutcome.answeredByMachine(this.freshRow())) this.hangUpAfterSpeech();
      return;
    }
    // Busy until its answer is carried out (a key press waits on Twilio): no second turn meanwhile.
    this.lineBusy = true;
    let spoke = false;
    try { spoke = await this.act(reply, turn); } finally { this.lineBusy = false; }
    const again = this.lineAgain;
    this.lineAgain = false;
    const amdNote = this.amdNote;
    this.amdNote = null;
    if (this.ending || this.done || this.heldVoicemail) return;
    // A machine verdict that came while this turn ran is never dropped: read once its words are said.
    if (amdNote) this.afterSpeech(() => this.runLine("amd", { note: `[${amdNote}]` }));
    else if (again && !spoke) this.runLine("heard while busy");
  }

  /** Carry out one call turn's answer on the line. True when words were (or will be) said. */
  async act(reply, turn) {
    const calls = reply.calls ?? [];
    const transfer = calls.find(c => c.name === "transfer_to_number");
    const spoken = [reply.text, reply.endCall?.message, transfer?.args?.client_message].filter(Boolean).join(" ").trim();
    this.log({ gptlive_result: this.call.id, ms: turn.totalMs, chars: spoken.length, tools: reply.tools ?? [], ends: !!reply.endCall, line: true, ...(reply.error ? { error: reply.error } : {}) });
    const press = calls.find(c => c.name === "play_keypad_touch_tone");
    const tones = String(press?.args?.dtmf_tones ?? "");
    // A key pressed answers the menu as it was heard: what it says next starts the next turn, not
    // the same menu read again (2026-10-31 drive: a follow-up turn pressed 1 a second time).
    if (!spoken) {
      const pressed = press ? await this.press(tones) : false;
      this.heard(turn);
      if (reply.endCall) this.hangUpAfterSpeech();
      return pressed;
    }
    // Words AND a key: the words first — a press re-opens the stream, and audio sent meanwhile is lost.
    if (press) {
      this.sayResult(spoken, turn);
      this.afterSpeech(() => void this.press(tones));
      return true;
    }
    // A voicemail, before the machine has finished its greeting: kept until the beep (Twilio's
    // answering-machine verdict), so the message goes onto the tape instead of over the greeting.
    if (reply.endCall && callOutcome.reachedMachine(this.freshRow()) && this.amdPending()) {
      this.heldVoicemail = { spoken, turn };
      if (this.vmTimer) this.timers.clearTimeout(this.vmTimer);
      this.vmTimer = this.timers.setTimeout(() => this.releaseVoicemail("no beep heard"), LINE_VOICEMAIL_WAIT_MS);
      this.log({ gptlive_voicemail_waits_for_beep: this.call.id });
      return true;
    }
    this.sayResult(spoken, turn);
    if (reply.endCall && callOutcome.reachedMachine(this.freshRow())) this.voicemailGate = this.gate;
    if (transfer) this.handOff(transfer.args ?? {});
    else if (reply.endCall) this.hangUpAfterSpeech();
    return true;
  }

  sayResult(spoken, turn) {
    this.lastResultClaimed = claimsDone(spoken);
    this.lastResultAt = this.now();
    this.speakLine(spoken.slice(0, 1800));
    (this.answered ??= []).push(turn);
  }

  releaseVoicemail(why) {
    const held = this.heldVoicemail;
    if (!held || this.done) return;
    this.heldVoicemail = null;
    if (this.vmTimer) this.timers.clearTimeout(this.vmTimer);
    this.log({ gptlive_voicemail_left: this.call.id, why });
    this.sayResult(held.spoken, held.turn);
    this.voicemailGate = this.gate;
    this.hangUpAfterSpeech();
  }

  /** Once the words being said (or about to be) have been said: then `fn` (20 s at most). */
  afterSpeech(fn) {
    const started = this.now();
    const tick = () => {
      if (this.done) return;
      const t = this.now();
      const g = this.gate;
      // Talking: no gate to read, so its words are said once the voice has been quiet a moment.
      const said = this.talking
        ? t - started > 1000 && t - this.lastVoiceAt > LINE_GATE_QUIET_MS
        : !this.pendingSay && (!g || (g.heard && t - g.lastSpeech > LINE_GATE_QUIET_MS));
      if (said || t - started > 20_000) return void fn();
      this.timers.setTimeout(tick, 200);
    };
    tick();
  }

  /** Still waiting on Twilio's answering-machine verdict for a call Reason placed? */
  amdPending() {
    return this.call.direction !== "in" && !this.amdVerdict && this.now() - (this.streamStartAt ?? this.startedAt) < LINE_AMD_WAIT_MS;
  }

  /**
   * Twilio's answering-machine verdict (async AMD, `DetectMessageEnd`): a machine's greeting has ended
   * at the beep. A voicemail already written is said now; otherwise the machine is written down the
   * way Reason's own `voicemail_detection` does (`hold.noteMachine`: no message yet) and Reason's turn
   * decides — one short message, or none when a message would do nothing for the errand — under the
   * rules it already has. A person (or "unknown") changes nothing; a fax is hung up on.
   */
  amd(answeredBy) {
    const v = String(answeredBy ?? "");
    this.amdVerdict = v || "unknown";
    if (!this.started) { this.amdLater = v; return; }
    if (this.done) return;
    this.log({ gptlive_amd: this.call.id, answered_by: this.amdVerdict });
    if (v === "fax") {
      hold.noteMachineLine(this.freshRow(), { what: "mailbox_not_taking_messages", deadEnd: true, heard: "a fax machine answered", log: this.log });
      return void this.end("a fax machine answered").catch(() => {});
    }
    if (!v.startsWith("machine_end")) return;
    // No room behind a voicemail: a message on a tape should be only the words.
    if (this.heldVoicemail) { if (this.bed) this.bed.off = true; return this.releaseVoicemail("beep"); }
    if (this.ending) return;
    // Somebody is already talking with us: Twilio's "machine" there is its 30 s timeout guessing, not a
    // mailbox (call 59: machine_end_other at 30.0 s on the receptionist, and a turn re-introduced the
    // call over her). Only a beep is believed, and then the voice stops talking.
    // "Somebody" = words from their side since the voice started talking, not the voice having spoken.
    if (this.talking && v !== "machine_end_beep" && this.theySpokeSince(this.talkingAt)) return void this.log({ gptlive_amd_ignored: this.call.id, answered_by: v });
    if (this.bed) this.bed.off = true;
    if (this.talking) {
      this.stopTalking("answering machine");
      this.clearPlayback("voicemail");
      this.live.send({ type: "session.instructions.append", event_id: `vm_${this.call.id}`, delegation_id: null, content: "That was a voicemail greeting, not a person. Say nothing of your own now." });
    }
    // A phone menu or a recording also reads as "a machine" to Twilio, so the verdict is a fact for
    // Reason's own turn, not a decision: its rules tell a mailbox from a menu (machine_on_the_line),
    // and a mailbox gets the message (or none). Already a voicemail: just the cue.
    const note = callOutcome.reachedMachine(this.freshRow()) ? AMD_BEEP_NOTE : AMD_NOTE;
    if (this.pending.size) { this.amdNote = note; return; }
    this.runLine("amd", { note: `[${note}]` });
  }

  /**
   * Press keys on the far end's phone menu. Twilio cannot send tones down a media stream, so the call is
   * told to play the digits and then connect a fresh stream to this same call (`acceptStream` hands it
   * back here); the voice session carries on across it, and is told what was pressed.
   */
  async press(tones) {
    const digits = String(tones ?? "").toLowerCase().replace(/[^0-9*#w]/g, "").slice(0, 32);
    if (!digits || !this.callSid || this.done) return false;
    this.rejoining = { at: this.now(), digits };
    let out;
    try {
      out = await this.twilioApi(`/Calls/${encodeURIComponent(this.callSid)}.json`, { Twiml: pressTwiml(digits, this.call) });
    } catch (e) {
      out = { ok: false, status: 0, json: { message: (e?.message ?? String(e)).split("\n")[0] } };
    }
    if (!out?.ok) {
      this.rejoining = null;
      this.log({ gptlive_keypad_failed: this.call.id, status: out?.status ?? 0 });
      return false;
    }
    this.log({ gptlive_keypad: this.call.id, digits: hold.tonesForLog(digits) });
    this.live.send({ type: "session.thinking.append", event_id: `keys_${this.call.id}_${this.lineN}`, delegation_id: null, content: `Reason pressed ${digits.replace(/w/g, "")} on the keypad. Say nothing about it; listen to what the line says next.` });
    if (this.rejoinTimer) this.timers.clearTimeout(this.rejoinTimer);
    this.rejoinTimer = this.timers.setTimeout(() => {
      if (!this.rejoining) return;
      this.rejoining = null;
      this.log({ gptlive_keypad_lost: this.call.id });
      this.end("the line did not come back after a key press").catch(() => {});
    }, LINE_REJOIN_MS);
    return true;
  }

  /** A new Twilio stream for this call, after a key press. */
  rejoin(socket) {
    this.attach(socket);
    this.log({ gptlive_keypad_stream: this.call.id });
  }

  /**
   * Hand the call to the person it is for (`transfer_to_number`, already checked by Reason's turn —
   * `handOver` in ./voice.js): once the words are said, Twilio dials them and Reason leaves the line.
   */
  handOff(args) {
    const to = normalizeNumber(String(args?.transfer_number ?? args?.phone_number ?? args?.number ?? ""));
    if (!to || !/^\+\d{8,15}$/.test(to)) { this.log({ gptlive_transfer_refused: this.call.id }); return; }
    const started = this.now();
    const tick = () => {
      if (this.done) return;
      const t = this.now();
      if ((t - this.lastOutAt > 1500 && this.queuedMs() === 0 && !(this.gate && !this.gate.heard) && !this.pendingSay) || t - started > 15000) {
        this.endWhy = "transfer_to_number";
        void this.twilioApi(`/Calls/${encodeURIComponent(this.callSid)}.json`, { Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${xml(to)}</Dial></Response>` })
          .then((out) => this.log({ gptlive_transfer: this.call.id, ok: !!out?.ok }))
          .catch(() => this.log({ gptlive_transfer: this.call.id, ok: false }));
        return;
      }
      this.timers.setTimeout(tick, 250);
    };
    this.timers.setTimeout(tick, 250);
  }

  /**
   * On hold, nothing is said and nothing is asked: Reason's `skip_turn` started the clock (hold_since)
   * and its budget is the call's (hold_budget_s). Hold music may never produce a word, so code checks
   * the clock; once the budget is gone, Reason's turn is asked once more, and its own wait rule
   * (`hold.noteWaiting`) says the polite line and rings off — outcome `hold_gave_up`.
   * A person coming back is just words on the line, and the next turn takes the call off hold.
   */
  holdTick() {
    this.holdTimer = null;
    if (this.done) return;
    const t = this.now();
    const row = this.freshRow();
    const quietLine = !this.turns.some(x => x.who === "them") && t - (this.streamStartAt ?? this.startedAt) > LINE_SILENT_MS;
    if (quietLine && !this.pending.size && !this.ending) return void this.end("nobody said anything on the line").catch(() => {});
    if (this.talking && !this.ending && !this.pending.size) {
      // On hold the voice says nothing (its rule), while a hold recording keeps their side "talking":
      // so the clock is the voice's own silence.
      const quietFor = t - Math.max(this.lastVoiceAt, this.talkingAt ?? 0);
      const budget = Math.max(60, Number(row.hold_budget_s) || 300) * 1000;
      if (quietFor > budget) {
        this.log({ gptlive_talk_hold_gave_up: this.call.id, quiet_s: Math.round(quietFor / 1000) });
        this.live.send({ type: "session.commentary.append", event_id: `giveup_${this.call.id}`, delegation_id: null, content: "Say exactly this, then stop: \"Sorry, I'll try again another time. Thanks, bye!\"" });
        this.hangUpAfterSpeech();
      }
    }
    if (hold.onHold(row) && hold.holdLeft(row) <= 0 && !this.pending.size && !this.lineTimer && !this.ending) {
      this.runLine("hold budget", { note: "[Still on hold; nobody has come back.]" });
    }
    this.holdTimer = this.timers.setTimeout(() => this.holdTick(), LINE_HOLD_TICK_MS);
  }

  // --- the end ---

  /**
   * What the call's own clock says about how it went on Reason's side, for the message to the owner
   * (`thirdPartyEvent`). Call 59's recap guessed "the line was bad"; it was Reason's 8 s first reply
   * and replies cutting each other off. Facts only, no causes.
   */
  howItWent(seconds) {
    const t0 = this.streamStartAt ?? this.startedAt;
    // Their first sound (the transcript of it lags ~2.7 s), else their first transcribed words.
    const firstThem = this.firstCallerVoiceAt ?? this.turns.find(x => x.who === "them" && x.text.trim())?.from;
    const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
    const facts = [];
    if (firstThem != null) facts.push(`they first spoke ${s(firstThem - t0)} after picking up`);
    if (this.firstVoiceMs == null) facts.push("Reason never got a word to them");
    else {
      const after = firstThem != null ? t0 + this.firstVoiceMs - firstThem : null;
      facts.push(`Reason's first words reached them ${s(this.firstVoiceMs)} after pickup${after == null ? "" : after > 0 ? ` (${s(after)} after they first spoke)` : " (before they had said anything)"}`);
    }
    if (this.bargeIns) facts.push(`they spoke while Reason was talking ${this.bargeIns} time${this.bargeIns === 1 ? "" : "s"}`);
    const ENDS = { "caller hung up": "they hung up", goodbye: "both said goodbye", end_call: "Reason hung up", duration_cap: "it reached the call time limit", "nobody said anything on the line": "nobody said anything" };
    facts.push(`the call ended after ${seconds} s because ${ENDS[this.endWhy] ?? "it ended"}`);
    return facts.join("; ");
  }

  async end(why) {
    if (this.done) return;
    this.done = true;
    if (running.get(this.call.id) === this) running.delete(this.call.id);
    told.delete(this.call.id);
    this.endedAt = this.now();
    this.endWhy = this.endWhy || why;
    if (this.capTimer) this.timers.clearTimeout(this.capTimer);
    if (this.byeTimer) this.timers.clearTimeout(this.byeTimer);
    for (const k of ["lineTimer", "holdTimer", "rejoinTimer", "vmTimer", "openTimer", "noticeTimer", "roomTimer"]) if (this[k]) this.timers.clearTimeout(this[k]);
    if (this.pickup?.pumpTimer) this.timers.clearTimeout(this.pickup.pumpTimer);
    // Reason's turn wrote the voicemail down as left when it wrote the words; if the line went before
    // a word of it played (held for the beep, or never started), nothing was left (hold.noteVoicemail).
    if (this.line && (this.heldVoicemail || (this.voicemailGate && !this.voicemailGate.heard))) {
      try { hold.noteVoicemail(this.freshRow(), { message: "", log: this.log }); } catch { /* the row stands */ }
      this.log({ gptlive_voicemail_not_said: this.call.id });
    }
    for (const turn of [...this.pending.values(), ...(this.answered ?? [])]) this.heard(turn);
    // Their usage arrives on session.closed; wait for it briefly, then let go either way.
    if (this.live && this.started) {
      await new Promise((resolve) => {
        this.closedResolve = resolve;
        this.live.send({ type: "session.close", event_id: `close_${this.call.id}` });
        this.timers.setTimeout(resolve, 3000);
      });
    }
    this.live?.close();
    if (this.twilio.open?.()) this.twilio.close();
    // After the line is down, so reading their last words never keeps anyone on the phone.
    const cutOff = this.persona ? null : await this.cutOff();
    const seconds = this.seconds || Math.round((this.now() - this.startedAt) / 1000);
    const turns = this.turns.map(t => ({ who: t.who, text: t.text.replace(/\s+/g, " ").trim() })).filter(t => t.text);
    let recording = null;
    let recordingWhy = "";
    try {
      // A caller with no account is told the call is recorded, so it is (2026-10-31): onto their
      // stranger row, under the same retention as their words (src/strangercalls.js).
      if (this.persona && !this.persona.recordingPath) recordingWhy = "a caller with no account and no row to keep it on";
      else if (this.tape.seconds() >= 1) {
        const path = this.persona ? this.persona.recordingPath : recordingFileFor(this.call.id, "wav");
        writeFileSync(path, this.tape.wav(), { mode: 0o600 });
        recording = { path, format: "wav", seconds: Math.round(this.tape.seconds()) };
      } else recordingWhy = "the line carried less than a second of audio";
    } catch (e) {
      recordingWhy = `the call audio could not be written: ${(e?.message ?? String(e)).split("\n")[0]}`;
    }
    const live = {
      state: this.started || turns.some(t => t.who === "them") ? "completed" : "failed",
      outcome: "", summary: "",
      transcript: turns.map(t => `${t.who === "them" ? "Them" : "Reason"}: ${t.text}`).join("\n"),
      turns, durationS: seconds,
      costCents: Math.round((seconds / 60) * CENTS_PER_MINUTE),
      termination: this.endWhy === "caller hung up" ? "hung up" : this.endWhy === "goodbye" ? "end_call (mutual goodbye)" : this.endWhy,
      cutOff,
      costRaw: JSON.stringify({ voice_seconds: seconds, cents_per_minute: CENTS_PER_MINUTE, session: this.sessionId ?? "", guard_trips: this.guardTrips, first_voice_ms: this.firstVoiceMs ?? null, warm: !!this.adopted }),
      recording, recordingWhy,
      ...(this.line ? { howItWent: this.howItWent(seconds) } : {}),
    };
    // Pickup → first word they heard, on the row for /ops (src/ops.js `pickupCheck`).
    if (!this.persona) {
      try {
        db.updateCall(this.call.conversation_id, this.call.id, {
          first_audio_ms: this.firstVoiceMs ?? null,
          pickup_opener: this.pickup?.startedAt ? this.pickup.clip.kind : "",
        });
      } catch { /* a number never breaks a call */ }
    }
    this.log({ gptlive_call_ended: this.call.id, why: this.endWhy, seconds, ...(this.pickup ? { opener: this.pickup.startedAt ? `${this.pickup.clip.kind}:${this.pickup.state}` : `none:${this.pickup.why ?? ""}` } : {}), delegations: this.delegations, guard_trips: this.guardTrips, first_voice_ms: this.firstVoiceMs ?? null, warm: !!this.adopted, closed: this.closedReason ?? "", ...(this.line ? { line: true, dropped_frames: this.dropped, sounds_dropped: this.soundsDropped, stale_runs: this.staleRuns ?? 0, amd: this.amdVerdict ?? "" } : {}) });
    try { await this.finishCall(live); } catch (e) { this.log({ gptlive_settle_failed: this.call.id, why: (e?.message ?? String(e)).split("\n")[0] }); }
  }
}

/** One Reason turn for the call, run in process (`llmRequest` in ./voice.js). */
export async function reasonTurn({ call, messages, log = () => {}, extras = {} }) {
  const out = await llmRequest({
    rawBody: JSON.stringify({
      model: "reason", messages,
      extra_body: { reason_call_id: call.id, reason_conversation_id: call.conversation_id, reason_kind: call.is_owner ? "owner" : "third_party" },
    }),
    log, extras,
  });
  if (!out.stream) return { text: "", tools: [], endCall: null, skip: true, error: `turn refused (${out.status})` };
  return readTurn(out.stream);
}

/** How long the after-call text waits on the model's read of how the call went. */
export const GOAL_WAIT_MS = 30_000;

/** The settle path every finished call takes (the steps in ./postcall.js). */
export async function settleGptLive({ row, live, settle, runtime = null, log = () => {} }) {
  const fresh = db.getCall(row.conversation_id, row.id) ?? row;
  if (!["placing", "ringing", "in_progress"].includes(fresh.state) && fresh.recording_state !== "pending") return fresh;
  const settled = settle ? await settle(fresh.conversation_id, fresh, live, { log }) : fresh;
  // Begun with the thread, finished once the owner was told (`resumeSettles` reads both).
  db.updateCall(settled.conversation_id, settled.id, { settle_started_at: clock.now() });
  const wrote = writeCallIntoThread({ row: settled, live, log });
  noteThirdPartyTurns({ row: settled, live });
  const noted = noteOnTask({ row: settled, live, log });
  fromcall.onCallEnded(settled, { log });
  // How the call went is the model's read (./goalmet.js, started by the settle): waited for, briefly,
  // so the owner is told what really happened — a mailbox that isn't set up is one text of its own.
  const judging = goalPending(settled.id);
  if (judging) {
    let wait;
    try { await Promise.race([judging, new Promise(r => { wait = setTimeout(r, GOAL_WAIT_MS); })]); }
    finally { clearTimeout(wait); }
  }
  const read = db.getCall(settled.conversation_id, settled.id) ?? settled;
  const told = await tellTheOwner({ row: read, live, runtime, log });
  db.updateCall(settled.conversation_id, settled.id, { settled_at: clock.now() });
  log({ post_call: settled.id, provider: PROVIDER, state: settled.state, recording: settled.recording_state, turns_written: wrote.turns, told: told.sent, task: noted.taskId ?? null });
  return settled;
}

// ---------- Twilio ----------

/** Twilio's request signature: HMAC-SHA1 over the full URL plus the sorted POST params, base64. */
export function twilioSignature(url, params = {}, token = config.twilioToken) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + String(params[k] ?? ""), String(url));
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilio({ url, params, headers, token = config.twilioToken }) {
  if (!token) return false;
  const given = String(headers?.["x-twilio-signature"] ?? "");
  const want = twilioSignature(url, params, token);
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The TwiML that hands a call to the media stream for one call row. */
export function streamTwiml(row, base = config.publicUrl) {
  const wss = String(base).replace(/^http/, "ws").replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(`${wss}${STREAM_PATH}${row.webhook_token}`)}"/></Connect></Response>`;
}

async function twilioPost(path, form, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, String(one));
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json };
}

/** Twilio's call states, in Reason's words. */
export function stateFromTwilio(s) {
  return ({
    queued: "placing", initiated: "placing", ringing: "ringing", "in-progress": "in_progress",
    completed: "completed", busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "failed",
  })[String(s ?? "")] ?? "placing";
}

// ---------- the provider ----------

/**
 * Dial one call on GPT-Live: Twilio rings `args.to` with the media stream as the call's TwiML.
 * `{ ok: false, error }` when this machine cannot (`missingForGptlive`) or the row has no token.
 */
export async function dialGptLive(args, { fetchImpl = null } = {}) {
  const missing = missingForGptlive();
  if (missing.length) return { ok: false, error: `GPT-Live calls are not set up on this machine: no ${missing.join(", ")}` };
  const row = db.getCall(args?.conversationId, args?.callId);
  if (!row?.webhook_token) return { ok: false, error: "there is no call row to place" };
  const thirdParty = args?.kind !== "owner";
  if (thirdParty) {
    // The disclosure it will open with, naming Reason (the turn says it verbatim off the row).
    const ann = lineAnnouncement(row.announcement || args.announcement);
    if (ann && ann !== row.announcement) db.updateCall(row.conversation_id, row.id, { announcement: ann });
  }
  // The pickup opener, made while it rings (./opener.js): never waited on here.
  if (thirdParty && opener.openerFor(row)) {
    try { void opener.prepare(row, { notice: recordingNoticeFor(row.to_number).notice, log: args?.log ?? (() => {}) }); } catch { /* the call opens the old way */ }
  }
  // No warm-up while it rings (2026-10-31): calls 54–55 with it were "confused and incoherent".
  // The session opens when Twilio's stream starts, as on call 53. `prewarm` stays for a proven rework.
  const out = await twilioPost("/Calls.json", {
    To: args.to, From: config.twilioFrom, Twiml: streamTwiml(row),
    StatusCallback: `${config.publicUrl}${STATUS_PATH}${row.webhook_token}`,
    StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"], StatusCallbackMethod: "POST",
    Timeout: 30,
    // Twilio's answering-machine detection, in the background: the call connects at once (a person
    // is never kept waiting) and the verdict arrives on its own webhook once a machine's greeting
    // has ended at the beep (`amdRequest`).
    ...(thirdParty ? {
      MachineDetection: "DetectMessageEnd", AsyncAmd: "true",
      AsyncAmdStatusCallback: `${config.publicUrl}${AMD_PATH}${row.webhook_token}`, AsyncAmdStatusCallbackMethod: "POST",
    } : {}),
  }, fetchImpl ? { fetchImpl } : {});
  if (!out.ok || !out.json?.sid) {
    dropWarm(row.id, "Twilio refused the call");
    return { ok: false, error: `Twilio refused the call (${out.status}${out.json?.message ? `: ${out.json.message}` : ""})` };
  }
  return {
    ok: true, externalId: `${EXT}${out.json.sid}`, state: "placing", provider: PROVIDER, ttsModel: `${config.gptliveModel}/${config.gptliveVoice}`,
    profile: thirdParty ? "third_party" : "owner",
    // The line opens silent and the disclosure is owed to the first person heard (#232).
    ...(thirdParty ? { openingWaits: true } : {}),
  };
}

/**
 * A GPT-Live call's state, off its own row: Twilio's status callback and the stream keep it current.
 * A row still saying placing/ringing/in_progress with no voice session running in this process is not
 * something this can vouch for (a restart mid-call, a lost status callback): `{ ok: false }`, so the
 * lost-call sweep (`settleLostCalls`) writes it off instead of believing it is live forever.
 */
function checkGptLive(externalId) {
  const row = db.callByExternalId(PROVIDER, externalId);
  if (!row) return { ok: false, error: "no GPT-Live call under that id" };
  if (["placing", "ringing", "in_progress"].includes(row.state) && !running.has(row.id)) {
    return { ok: false, error: "no GPT-Live session is running for this call" };
  }
  return { ok: true, state: row.state };
}

/**
 * GPT-Live as the call provider (REASON_CALL_PROVIDER=gptlive): every call, both directions, on one
 * voice. Live once `missingForGptlive` is empty; `directions` is what `capabilities` reads, and both
 * directions need the same keys (inbound is the number's voice webhook, `inboundTwiml`).
 */
export class GptLiveCallProvider extends CallProvider {
  name = PROVIDER;

  constructor({ fetchImpl = null } = {}) {
    super();
    this.fetchImpl = fetchImpl;
  }

  status() {
    const missing = missingForGptlive();
    return {
      name: this.name,
      status: missing.length ? "not_connected" : "live",
      missing,
      what: "be Reason itself on a real phone call, both directions, with GPT-Live as the voice on a Twilio number — recorded, with the audio afterwards",
      records: true,
      directions: { out: !missing.length, in: !missing.length, missingIn: missing },
    };
  }

  async place(args) {
    return dialGptLive(args, this.fetchImpl ? { fetchImpl: this.fetchImpl } : {});
  }

  async check(externalId) {
    return checkGptLive(externalId);
  }
}

/**
 * GPT-Live in front of another provider (REASON_CALL_VOICE / REASON_THIRD_PARTY_VOICE), for the
 * calls `gptliveFor` / `thirdPartyVoiceFor` say yes to; everything else is the wrapped provider. With
 * no flag set this is the inner provider itself, and GPT-Live as the provider is handed back as it is.
 */
export function withGptLive(inner, { fetchImpl = null } = {}) {
  if (!gptliveOn() || !inner || inner instanceof GptLiveCallProvider) return inner;
  const place = async (args) => {
    const own = args?.kind === "owner" && gptliveFor(args?.conversationId);
    const thirdParty = args?.kind === "third_party" && thirdPartyVoiceFor(args?.conversationId);
    if (!own && !thirdParty) return inner.place(args);
    return dialGptLive(args, fetchImpl ? { fetchImpl } : {});
  };
  const check = async (externalId) => {
    if (!String(externalId ?? "").startsWith(EXT)) return inner.check(externalId);
    return checkGptLive(externalId);
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "place") return place;
      if (prop === "check") return check;
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// ---------- the routes ----------

/** Form-encoded body as an object. */
export function formOf(raw) {
  return Object.fromEntries(new URLSearchParams(String(raw ?? "")));
}

/**
 * Twilio's status callback for one GPT-Live call. A call that never connected (busy, no answer,
 * failed) settles here; one that connected settles when its stream ends.
 */
export async function statusRequest({ token, rawBody, headers, settle, runtime, log = () => {} }) {
  const row = db.callByWebhookToken(token);
  if (!row || row.provider !== PROVIDER) return { status: 404, body: "" };
  const params = formOf(rawBody);
  if (!verifyTwilio({ url: `${config.publicUrl}${STATUS_PATH}${token}`, params, headers })) return { status: 403, body: "" };
  const state = stateFromTwilio(params.CallStatus);
  log({ gptlive_status: row.id, status: params.CallStatus });
  if (["placing", "ringing", "in_progress"].includes(state)) {
    if (["placing", "ringing", "in_progress"].includes(row.state) && row.state !== state) db.updateCall(row.conversation_id, row.id, { state });
    return { status: 204, body: "" };
  }
  if (state === "completed" && streams.has(row.id)) return { status: 204, body: "" };
  dropWarm(row.id, `call ${params.CallStatus ?? "ended"} before it was answered`);
  await settleGptLive({
    row, settle, runtime, log,
    live: {
      state, outcome: "", summary: "", transcript: "", turns: [],
      durationS: Number(params.CallDuration) || 0, costCents: 0,
      termination: state === "completed" ? "hung up" : String(params.CallStatus ?? ""),
      recording: null, recordingWhy: "the call never connected, so there was nothing to record",
    },
  });
  return { status: 204, body: "" };
}

/** A line Twilio says itself, then hangs up: no model, no session, nothing that can answer back. */
export function sayAndHangUp(line) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${xml(config.gptliveSayVoice)}">${xml(line)}</Say><Hangup/></Response>`;
}

/** Streams for callers with no account (strangers), by token. Short-lived: Twilio connects within seconds. */
const rowless = new Map();
const ROWLESS_TTL_MS = 60_000;

/** A stream for a stranger: no call row, no conversation; the pitch persona and its no-tools brain. */
export function strangerStream({ address = "", callSid = "", kept = null, now = Date.now() } = {}) {
  for (const [k, v] of rowless) if (now - v.at > ROWLESS_TTL_MS) rowless.delete(k);
  const token = randomUUID().replace(/-/g, "");
  rowless.set(token, { at: now, address, callSid, kept, externalId: `${EXT}${callSid || token}` });
  return token;
}

/**
 * The number's voice webhook (Twilio → /calls/gptlive/inbound). Every caller is answered on GPT-Live:
 *
 *   - somebody with an account whose own calls are GPT-Live (`gptliveFor`): their own Reason, their
 *     identity, a call row on THEIR conversation — over today's call cap, one line and goodbye;
 *   - blocked / paused / removed: the neutral line (`stranger.neutralLine`), said by Twilio, and the
 *     call ends — nothing kept, nothing of anybody's;
 *   - an unknown or withheld number: the stranger pitch (src/calls/stranger.js) on GPT-Live, the master
 *     asked as for a first text, the call kept against the number (src/strangercalls.js);
 *   - a place ringing back about an errand: the third-party line, for the errand it is returning;
 *   - GPT-Live not set up here (no OPENAI_API_KEY / Twilio keys / REASON_PUBLIC_URL), or anything
 *     throwing while it rings: Twilio rejects the call (`<Reject/>`, the caller hears it as busy).
 *     There is no second voice to hand a call to, and no URL anywhere that names one.
 *
 * No greeting is made before the call is connected: the TwiML only opens the stream, and the session
 * is started when Twilio's stream starts (calls 54–55: a greeting made while ringing went unheard).
 */
export function inboundTwiml({ rawBody, headers, router = null, log = () => {} }) {
  const params = formOf(rawBody);
  if (!verifyTwilio({ url: `${config.publicUrl}${INBOUND_PATH}`, params, headers })) return { status: 403, body: "" };
  const away = `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
  // Nothing thrown here may leave a ringing call hanging: anything that fails is rejected at once.
  try {
    return routeInbound({ params, router, log, away });
  } catch (e) {
    log({ gptlive_inbound_failed: (e?.message ?? String(e)).split("\n")[0] });
    return { status: 200, body: away, type: "text/xml" };
  }
}

function routeInbound({ params, router, log, away }) {
  const twiml = (body) => ({ status: 200, body, type: "text/xml" });
  if (!gptliveOn() || missingForGptlive().length) return twiml(away);
  const callSid = String(params.CallSid ?? "");
  // A place ringing back about an errand: the third-party line on GPT-Live, for the errand it is returning.
  const from = normalizeNumber(params.From) || "";
  const back = from && /^\+\d{8,15}$/.test(from) ? whoseCallIsThis(from) : null;
  if (back?.allow && back.callingBack) {
    return twiml(streamTwiml(ringBackRow({ who: back, address: from, callSid, log })));
  }
  const address = normalizeNumber(params.From) || "";
  // A withheld or unusable caller id: a stranger with nothing to keep.
  if (!address || !/^\+\d{8,15}$/.test(address)) {
    // Kept on a row of its own (matched to nobody, ever), so the recording it is told about is kept
    // and goes under the same retention as anybody's.
    let kept = null;
    try { kept = strangerCalls.open({ phone: "", withheld: true, externalId: `${EXT}${callSid}` }); } catch { /* kept nothing */ }
    log({ gptlive_inbound_stranger: "withheld" });
    return twiml(streamTwimlFor(strangerStream({ callSid, kept })));
  }
  const who = whoseCallIsThis(address);
  if (!who.allow && ["blocked", "paused", "removed"].includes(who.reason)) {
    log({ gptlive_inbound_refused: who.reason });
    return twiml(sayAndHangUp(strangerCall.neutralLine()));
  }
  if (!who.allow) {
    const why = strangerIntake({ address, router, log, reason: who.reason });
    let kept = null;
    try { kept = strangerCalls.open({ phone: address, externalId: `${EXT}${callSid}` }); } catch (e) {
      log({ stranger_call_not_kept: (e?.message ?? String(e)).split("\n")[0] });
    }
    log({ gptlive_inbound_stranger: why, kept: kept?.id ?? null });
    return twiml(streamTwimlFor(strangerStream({ address, callSid, kept })));
  }
  const capped = overCallCap(who.conversationId, { log });
  if (capped) return twiml(sayAndHangUp(capped.line));
  const row = db.createCall(who.conversationId, {
    provider: PROVIDER, toNumber: address, isOwner: true,
    goal: `${accounts.ownerOf(who.conversationId).name} called Reason`, facts: [],
    direction: "in", externalId: `${EXT}${callSid || randomUUID()}`, state: "in_progress", announcement: "",
  });
  accounts.countUse(who.conversationId, "call");
  recordingNoteFor({ conversationId: who.conversationId, row, log });
  log({ gptlive_inbound: who.conversationId, call: row.id });
  return twiml(streamTwiml(row));
}

/**
 * The call row for a place ringing back: NOT an owner call; the errand's goal, facts, brief, errand and hold budget; the disclosure said first.
 */
function ringBackRow({ who, address, callSid, log }) {
  const about = who.aboutCall;
  const person = accounts.ownerOf(who.conversationId);
  const row = db.createCall(who.conversationId, {
    provider: PROVIDER, toNumber: address, isOwner: false,
    goal: `They are ringing back about: ${about.goal}`,
    facts: Array.isArray(about.facts) ? about.facts : [],
    direction: "in", externalId: `${EXT}${callSid || randomUUID()}`, state: "in_progress",
    announcement: lineAnnouncement(announcementFor({ ownerName: person.name })),
  });
  db.updateCall(who.conversationId, row.id, { brief: about.brief || "{}", errand_id: about.errand_id ?? null, hold_budget_s: about.hold_budget_s ?? null });
  accounts.countUse(who.conversationId, "call");
  log({ gptlive_inbound_callback: who.conversationId, call: row.id, about: about.id, errand: about.errand_id ?? null });
  return db.getCall(who.conversationId, row.id) ?? row;
}

/** The stream TwiML for a token (a call row's own, or a stranger stream's). */
function streamTwimlFor(token, base = config.publicUrl) {
  return streamTwiml({ webhook_token: token }, base);
}

/** Calls whose stream is up, by call id. */
const streams = new Map();

/** Notes for calls whose voice session is not up yet, by call id (`tellLive`). */
const told = new Map();
/** Every GptLiveCall this process is running, by call id, from construction to `end`. */
const running = new Map();

/**
 * Hand something new to a call that is already ringing or connected, instead of placing a second
 * call (calls 66 and 67, 2026-11-01: a second photo started a second turn, which rang the same phone
 * 19 s later). The note goes into the voice's instructions now, or the moment its session starts.
 */
/** Is this process running the voice for this call right now? */
export const isRunning = (callId) => running.has(callId);

export function tellLive(callId, content) {
  const text = String(content ?? "").trim();
  if (!text) return false;
  told.set(callId, [...(told.get(callId) ?? []), text]);
  const call = running.get(callId);
  if (call?.started && !call.done) call.flushTold();
  if (told.size > 50) told.delete(told.keys().next().value);
  return true;
}

/** The words a live call is handed: what the second call would have been about. */
export function toldNote({ goal = "", facts = [] } = {}) {
  const list = (facts ?? []).map(f => `- ${String(f).replace(/\s+/g, " ").trim()}`).filter(f => f.length > 2).join("\n");
  return `New since this call was placed — you were about to ring them again about it, so it is yours to bring up on THIS call:`
    + ` ${String(goal).replace(/\s+/g, " ").trim()}${list ? `\n${list}` : ""}`
    + `\nWork it in naturally at the next pause (for example "oh, and I've got your other photo now"). Do not say you were going to call again.`;
}

/**
 * Twilio's media stream for one call, upgraded. The token in the path is the call row's own; anything
 * else is closed at once.
 */
export function acceptStream({ token, socket, settle, runtime, log = () => {}, openLive = openLiveSocket, generate = null, twilioApi = null }) {
  const stranger = rowless.get(token);
  if (stranger) {
    rowless.delete(token);
    if (Date.now() - stranger.at > ROWLESS_TTL_MS) {
      log({ gptlive_stream_refused: "stranger token expired" });
      socket.close(1008);
      return null;
    }
    return acceptStrangerStream({ stranger, socket, log, openLive, generate });
  }
  const row = db.callByWebhookToken(token);
  // The stream back after a key press (`press`): the same call, the same voice session.
  const going = row ? streams.get(row.id) : null;
  if (going?.rejoining && !going.done) { going.rejoin(socket); return going; }
  if (!row || row.provider !== PROVIDER || !["placing", "ringing", "in_progress"].includes(row.state) || streams.has(row.id)) {
    log({ gptlive_stream_refused: row?.id ?? null });
    socket.close(1008);
    return null;
  }
  db.updateCall(row.conversation_id, row.id, { state: "in_progress" });
  const call = new GptLiveCall({
    call: db.getCall(row.conversation_id, row.id) ?? row, twilio: socket, openLive, log, warm: takeWarm(row.id), twilioApi,
    brain: (messages) => reasonTurn({ call: row, messages, log, extras: runtime?.turnExtras ?? {} }),
    finish: async (live) => {
      try { await settleGptLive({ row, live, settle, runtime, log }); } finally { streams.delete(row.id); }
    },
  });
  streams.set(row.id, call);
  const early = amdEarly.get(row.id);
  if (early) { amdEarly.delete(row.id); call.amd(early); }
  return call;
}

/** AMD verdicts that came in before the call's stream was up, by call id. */
const amdEarly = new Map();

/** Twilio's async answering-machine verdict for one third-party GPT-Live call (`GptLiveCall#amd`). */
export async function amdRequest({ token, rawBody, headers, log = () => {} }) {
  const row = db.callByWebhookToken(token);
  if (!row || row.provider !== PROVIDER) return { status: 404, body: "" };
  const params = formOf(rawBody);
  if (!verifyTwilio({ url: `${config.publicUrl}${AMD_PATH}${token}`, params, headers })) return { status: 403, body: "" };
  const answeredBy = String(params.AnsweredBy ?? "unknown");
  log({ gptlive_amd_webhook: row.id, answered_by: answeredBy, ms: Number(params.MachineDetectionDuration) || null });
  const call = streams.get(row.id);
  if (call) call.amd(answeredBy);
  else if (["placing", "ringing", "in_progress"].includes(row.state)) {
    amdEarly.set(row.id, answeredBy);
    setTimeout(() => amdEarly.delete(row.id), 120_000).unref?.();
  }
  return { status: 204, body: "" };
}

/**
 * A stranger's stream: the pitch persona, every answer from `strangerReply` (no tools, nobody's data),
 * and at the end only their own words and the length kept against their number. No call row, no
 * conversation, no audio file.
 */
function acceptStrangerStream({ stranger, socket, log, openLive, generate }) {
  const id = `stranger:${stranger.kept?.id ?? stranger.callSid ?? "withheld"}`;
  const extra = stranger.kept ? { reason_stranger_call: stranger.kept.id, reason_stranger_token: stranger.kept.token } : {};
  const gen = generate ?? generatorFor();
  return new GptLiveCall({
    call: { id, conversation_id: "", direction: "in", is_owner: 0 }, twilio: socket, openLive, log,
    // The intro says the call is recorded, so the audio is kept, on their stranger row.
    persona: { instructions: strangerInstructions(), greeting: strangerCall.introLine(), recordingPath: stranger.kept ? strangerCalls.recordingPathFor(stranger.kept.id) : "" },
    brain: async (messages) => {
      const r = await strangerCall.strangerReply({ messages, generate: gen, extra, log });
      return { text: r.text, tools: [], endCall: r.ends ? { message: "" } : null, skip: !r.text && !r.ends };
    },
    finish: async (live) => {
      try { strangerCalls.settleFromPostCall({ externalId: stranger.externalId, live }); } catch (e) {
        log({ stranger_call_not_settled: (e?.message ?? String(e)).split("\n")[0] });
      }
      log({ gptlive_stranger_ended: id, seconds: live.durationS, cost_cents: live.costCents });
    },
  });
}
