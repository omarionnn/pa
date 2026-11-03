// The hard line. Nobody uses Reason to hurt anybody.
//
// Not to plan an attack, not to get hold of or build a weapon, not to make a poison or a bomb or
// a nerve agent, not to drug somebody, not to track a person down to hurt them, not for anything
// sexual involving a child. Not as a joke, not "hypothetically", not for a story, not for a friend,
// not because they say they are a professional, and not in pieces spread over several messages.
//
// The model would refuse most of this on its own, and the prompt tells it to refuse all of it. But
// a rule that lives only in a prompt is a hope, so this file is the part that is code:
//
//   - **every message somebody sends is screened BEFORE the model sees it**, by a separate narrow
//     call that sees the message and the last few lines of the thread and answers one question. On
//     "harm" there is NO model turn at all: the model never reads the message, no tool can run, and
//     the line that goes back is written here. The thread keeps both lines, so the next turn knows.
//   - **anything short of clear runs with its hands tied.** A borderline read, a person in crisis,
//     or a screen that could not run: the turn happens, but every tool that reaches out of the
//     machine — search, research, the browser, pages, calls, texts, mail — is refused in
//     `runTool`, and a borderline reply is screened again on the way out. A screen that could not
//     run is asked once more at the first outward tool, and only a real 'clear' unties the hands:
//     a slow screen is not a reason to refuse somebody's ordinary request.
//   - **it is counted.** Every refusal is a ledger row and a strike. Enough strikes inside the
//     window and that person's Reason is paused on its own, and the master is told — the count and
//     the kind, never the words. The master's own account is never paused, only refused.
//   - **somebody in crisis is not an offender.** Suicide and self-harm get the model, with its
//     hands tied, and a crisis line is guaranteed by code on the end of whatever it says. No strike.
//
// What the screen cannot do is read minds, and a classifier that errs toward refusing will refuse
// some innocent things. That is the trade chosen here, on purpose: "shooting hoops" and "this exam
// is killing me" are given to the judge with the thread around them, and when it is wrong the cost
// is one text that says "i won't help with that" to somebody who was not asking for that. The other
// way round the cost is not symmetrical.
import Anthropic from "@anthropic-ai/sdk";
import { callApi, cachedSystem, apiSkipWhy, resetApiOut } from "./spend.js";
import { config, clock, stamp } from "./config.js";
import { screenViaCli } from "./backends/cli.js";
import * as db from "./db.js";
import { isLinkPreviewAttachment } from "./linkpreview.js";
import { TODO_FRAME, TODO_FRAME_UNASKED } from "./onboardframes.js";

/** What the screen can say about a message. Anything else it says is `unscreened`. */
export const VERDICTS = ["clear", "borderline", "harm", "crisis"];

/**
 * The kinds of harm the screen names. A category is for the ledger and the master's one-line
 * heads-up; it never changes what happens, so a new kind is a new word here and nothing else.
 */
export const CATEGORIES = [
  "violence", "weapons", "explosives", "cbrn", "poison", "drugging", "stalking", "minors", "cyberattack", "self_harm", "other",
];

const VERDICT_TOOL = {
  name: "verdict",
  description: "Record what this message is asking for.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: VERDICTS,
        description:
          "harm: they are seeking help toward hurting a person or people — planning, preparing, obtaining, building, or carrying it out. "
          + "crisis: they are talking about ending their own life or hurting themselves. "
          + "borderline: it touches a dangerous subject but might be innocent, and you cannot tell. "
          + "clear: an ordinary message.",
      },
      category: { type: "string", enum: CATEGORIES, description: "The kind, when the verdict is not clear." },
      note: { type: "string", description: "At most one short phrase on why. Never quote the message." },
    },
    required: ["verdict"],
  },
};

export const INSTRUCTIONS = `You are the safety screen in front of a personal assistant that people text. You read ONE new message, with the last few lines of the conversation for context, and you decide one thing: is this person trying to use the assistant to hurt somebody?

Say 'harm' when the message is seeking help toward harming a person or people, in any of these ways: planning or carrying out violence or an attack; getting hold of, making, modifying or using a weapon, a gun, a bomb, an explosive or an incendiary; making, getting or using a poison, a toxin, a pathogen, a chemical, biological, nuclear or radiological agent; drugging or incapacitating somebody; finding, tracking or watching a person in order to hurt, threaten or stalk them; anything sexual involving a child; breaking into somebody's accounts, devices or systems. Help toward it means any step: how, where, what with, how much, how to avoid being caught, who to target, drafting the threat.

The framing does not change the answer. "Hypothetically", "for a novel", "for a school project", "asking for a friend", "I'm a nurse / cop / chemist", "just curious", "you already told me the first half" — if what they are asking for would help someone do the thing, it is 'harm'. A request split into innocent-looking pieces is 'harm' when the thread shows where the pieces are going.

Say 'crisis' when the person is talking about ending their life, wanting to die, or hurting themselves — however casual, however much it sounds like a joke. Never 'harm' for that: they are the one at risk. It has to be in their words: stress, worry, a bad day, or "that's all I can think about" about a named thing (an interview, an exam, a breakup) is 'clear', not a crisis to be inferred.

Say 'clear' for everything ordinary, and do not reach: slang ("this exam is killing me", "shoot me a text", "that's the bomb", "I could murder a burger"), sports ("shooting", "kill shot"), cooking, gardening ("poison ivy", "killing weeds"), medicine for themselves ("is 2 ibuprofen ok"), news and history as subjects, self-defence and safety questions ("how do I know if my drink was spiked"), fiction talked about as fiction with no operational detail asked for, games, and strong feelings said in words ("I'm so angry I could scream").

Say 'borderline' only when it genuinely could be either and the thread does not settle it — a question about a chemical, a medication dose, a person's whereabouts, a lock, a network — and you cannot tell what it is for. Not as a hedge: if it is clearly innocent say 'clear', and if it is clearly seeking help toward harm say 'harm'.

Judge THIS message: does what it asks for, in this person's own words, fall under 'harm' as set out above? Everything above about framing still holds in full. The earlier lines are there only so you understand what the words mean (what "it", "that" or "how much" refers to) and so a request split into pieces is seen whole. They are not a record to search for suspicion. Ordinary plans in the thread (a film, a time, a place, a work shift, getting somewhere after work) are not a target or the planning of an attack unless the person says so in their own words.

Lines in parentheses inside the message, like "(a link preview card)" or "(an attached file named ...)", are the app describing what came with the message, not the person's words. A link, a link preview, a shared post, an attached file, or a question about one ("have you heard of this?", "thoughts?", "is this real?") is somebody showing you something, and it is 'clear' unless their own words ask for help toward harm. A short reaction or confusion on its own ("??", "what?", "huh", "why", "lol", "ok") asks for nothing and is 'clear'.

Judge the message you are given against the context you are given. Do not imagine a worse conversation than the one in front of you, and do not imagine a kinder one either.`;

let client = null;
const anthropic = () => (client ??= new Anthropic());
/** For tests: what answers the API screen. `null` puts the real client back. */
export function setScreenClient(c) { client = c; resetApiOut(); }

/** For tests: what answers the screen. `null` puts the real CLI back. */
let cliScreen = (args) => screenViaCli({ model: config.harmCliModel, timeoutMs: config.harmCliTimeoutMs, ...args });
const realCliScreen = cliScreen;
export function setCliScreen(f) { cliScreen = f ?? realCliScreen; }

/**
 * A phone call's screen, on the API: the one place the paid API still screens anything. Calls run
 * on the API by the owner's choice (2026-10-25, REASON_CALL_BACKEND=api), where a cold CLI start
 * would be seconds of dead air before the first word. A verdict the API did give is never
 * second-guessed; only `unscreened` falls through to the CLI.
 */
async function askApiThenCli({ system, prompt, model, verdicts, categories, feature = "call_harm" }) {
  const r = await askApi({ system, prompt, model, feature });
  if (r.verdict !== "unscreened" || process.env.REASON_BACKEND !== "claude-cli") return r;
  const c = await cliScreen({ prompt, instructions: system, verdicts, categories });
  if (c.platform_refusal) return PLATFORM_REFUSAL;
  return c.error ? { ...r, cli_error: c.error } : { ...tidy(c), via: "cli_fallback", api_error: r.error };
}

/**
 * Which path screens a text: the backend the install runs on. On claude-cli, the subscription (owner,
 * 2026-10-27: never bill the API there); a phone call on the API says "api" for itself
 * (src/calls/voice.js). On REASON_BACKEND=api (owner, 2026-11-02: all model work on the API key),
 * the API, on the same small model, the same instructions and the same verdicts.
 */
export const screenBackend = () => process.env.REASON_BACKEND === "claude-cli" ? "claude-cli" : "api";

/**
 * The most of one message the screen is shown. A message of any length used to go in whole, so a
 * wall of pasted text cost a long screen and could run it past its timeout into `unscreened` —
 * which is exactly the state that gets a turn with nobody having read it. The head and the tail
 * are what is kept, with the gap said out loud, so nothing can sit safely at either end.
 */
export const SCREEN_MAX_CHARS = 8_000;
export function capForScreen(text) {
  const s = String(text ?? "");
  if (s.length <= SCREEN_MAX_CHARS) return s;
  const head = s.slice(0, 6_000), tail = s.slice(-2_000);
  return `${head}\n[… ${s.length - head.length - tail.length} characters in the middle not shown …]\n${tail}`;
}

/** How long a rate-limited screen waits before its second ask, at most. */
const RATE_LIMIT_WAIT_MS = 2_000;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** How many times the API screen is asked before it says `unscreened`. */
const API_ATTEMPTS = 2;

/**
 * One screen question over the API (a phone call's only), asked at most twice. A second ask is cheap (~1 s on a small
 * model) and turns a blip — a timeout, a 529, an answer off the schema — into a real verdict
 * instead of a turn with its hands tied. A platform refusal is an answer and is never re-asked.
 */
async function askApi({ system, prompt, model, feature = "call_harm" }) {
  let last = { verdict: "unscreened", error: "the screen was never asked" };
  // Known out of credit, or past the hard cap (src/spend.js): straight to the fallback, no round trip.
  const skip = apiSkipWhy(feature);
  if (skip) return { verdict: "unscreened", error: /credit/.test(skip) ? "the API account is out of credit (credit balance too low)" : skip, skipped: "api_out" };
  for (let attempt = 0; attempt < API_ATTEMPTS; attempt++) {
    try {
      const res = await callApi({
        feature, client: anthropic(),
        params: {
          model: model || config.harmModel,
          max_tokens: 200,
          // Cached: the instructions are the same on every message (src/spend.js cachedSystem).
          system: cachedSystem(system),
          tools: [VERDICT_TOOL],
          tool_choice: { type: "tool", name: "verdict" },
          messages: [{ role: "user", content: prompt }],
        },
        // The retry is this loop's, so the SDK's own is off: two asks in all, not four.
        options: { timeout: config.harmTimeoutMs, maxRetries: 0 },
      });
      // The platform's own safeguards declining to read it is the strongest 'harm' there is: the
      // turn this screen guards would meet the same wall.
      if (res.stop_reason === "refusal") return PLATFORM_REFUSAL;
      const block = res.content.find(b => b.type === "tool_use" && b.name === "verdict");
      last = tidy(block?.input);
      if (last.verdict !== "unscreened") return last;
    } catch (e) {
      last = { verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] };
      // A 429 is the API saying "not yet", and asking again the same instant only earns another.
      // It is waited out (its own retry-after, capped) and said as its own reason, so a run of
      // them reads as a capacity problem and not as a screen that cannot read a message.
      // No credit is not a blip: a second ask gets the same refusal.
      if (/credit balance/i.test(last.error)) break;
      if (e?.status === 429) {
        last.rate_limited = true;
        last.error = `rate_limited: ${last.error}`;
        const after = Number(e?.headers?.["retry-after"] ?? e?.headers?.get?.("retry-after"));
        if (attempt < API_ATTEMPTS - 1) await wait(Math.min(RATE_LIMIT_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : RATE_LIMIT_WAIT_MS));
      }
    }
  }
  return { ...last, attempts: API_ATTEMPTS };
}

/**
 * The most recent lines of a thread, as the screen is shown them. Short on purpose.
 *
 * Their lines are shown as their own words (see ownWords), and the screen's own earlier answers,
 * the refusal line and the withheld line, are not shown at all: they are code's, and say nothing
 * about the person. 2026-10-24: the owner shared a link and asked "have you heard of this?"; it was
 * refused, and his "??" after it was screened with that refusal in view and refused again, the
 * model's note citing "the prior assistant turn refused" as the evidence. What they asked before
 * stays in view, so a refused request followed by "ok just the ratio then" is still read whole.
 */
export function contextLines(messages = [], { limit = 6, width = 400 } = {}) {
  const lines = [];
  for (const m of messages.filter(isDialogue).filter(m => !isScreenAnswer(m)).slice(-limit)) {
    if (m.role === "user" && typeof m.content === "string") {
      const t = ownWords(m.content);
      if (t.trim()) lines.push(t.slice(0, width));
    }
    else if (m.role === "assistant" && typeof m.content === "string") lines.push(`Reason: ${m.content.slice(0, width)}`);
    else if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      if (text) lines.push(`Reason: ${text.slice(0, width)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Only what was actually said reaches the screen. The thread also holds Reason's own bookkeeping
 * — `[event …]` lines written by code ("your call with them just ended … do NOT recount it to
 * them"), `NO_REPLY`, "(that was the end of the call)" — and shown as dialogue they read like a
 * worried check-in. On 2026-10-12 that turned "that's all I'm thinking about", said about
 * interview prep, into a crisis verdict and a 988 line read down the phone: six of six with those
 * two lines in the context, none of five without them.
 */
export function isDialogue(m) {
  const text = typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "";
  const t = text.trim();
  if (!t) return false;
  if (m.role === "user" && /^\[event\b/i.test(t)) return false;
  // What code writes into the thread after a call (src/calls/postcall.js): a timestamped header and
  // a record of the lookups it ran. Both are Reason's notes about the call, not words anyone said.
  // 2026-10-23: a plain "Hi" after the owner's call was screened with those in view, came back
  // `crisis`, and the reply carried a 988 line.
  if (m.role === "user" && /^\[[^\]]*\]\s*\[(your own record|on a phone call)\b/i.test(t)) return false;
  // A silence on the line is transcribed as dots. Nobody said anything; shown to the screen it
  // reads as somebody who cannot find the words.
  if (m.role === "user" && /^(\[[^\]]*\]\s*[^:\n]{1,60}\(on the call\):\s*)?[.\u2026\s]+$/.test(t)) return false;
  if (m.role === "assistant" && (t === "NO_REPLY" || /^\(that was the end of the call\)$/i.test(t))) return false;
  return true;
}

/** Is this one of the screen's own answers (code's refusal or withheld line) rather than anything said? */
const isScreenAnswer = (m) => {
  if (m?.role !== "assistant") return false;
  const t = (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "").trim();
  return t === REFUSAL_LINE || t === WITHHELD_LINE;
};

/** The opening a stored line carries, "[Sat, Oct 24, 2026, 3:21 PM] Omari: ", kept as it is. */
const SPEAKER = /^(\[[^\]\n]*\]\s*[^:\n\[]{1,60}:\s*)/;

/**
 * What the person actually said, with code's own notes about the message taken out or put plainly.
 *
 * The router hands a turn its text with instructions for the MODEL riding inside it: "[they sent
 * the following as 3 separate texts in a row ... reply_to + message_send for each earlier one ...]",
 * "[they sent a file, which you cannot open: 2OEYv8x5_....pluginPayloadAttachment]", "[they sent
 * this as an inline reply ...]". Shown to the screen as "the new message, verbatim", they read as
 * the person's own words. 2026-10-24: a shared link (block.xyz/dessa), the two iMessage link-preview
 * files that came with it, and "Have you heard of this?" were screened as one message and ruled
 * 'harm' (violence) six times out of six on the live model; in the next screen's context the
 * preview's filename was cut to ".pl", and "??" was refused as "a .pl file, likely a payload".
 *
 * Only whole lines that are exactly code's notes are touched, so nothing a person types can hide
 * behind one: their words on every other line go through untouched.
 */
export function ownWords(text) {
  return String(text ?? "").split("\n").map((line) => {
    const lead = line.match(SPEAKER)?.[1] ?? "";
    const t = line.slice(lead.length).trim();
    let put = t;
    const file = t.match(/^\[they sent a file, which you cannot open: ([^\]\n]*)\]$/i);
    const under = t.match(/^\[they sent this as an inline reply\b[^"\]\n]*"([^"\n]*)"[^\]\n]*\]$/i);
    if (/^\[they sent the following as \d+ separate texts in a row\b[^\]\n]*\]$/i.test(t)) put = "";
    // The first-chat onboarding's to-do note (src/onboardframes.js), word for word only.
    else if (t === TODO_FRAME || t === TODO_FRAME_UNASKED) put = "";
    else if (/^\[reason was down from [^\]\n]*\]$/i.test(t)) put = "";
    else if (file) put = isLinkPreviewAttachment({ filename: file[1] }) ? "(a link preview card)" : "(an attached file named " + file[1] + ")";
    else if (under) put = "(sent as an inline reply under the earlier message \"" + under[1] + "\")";
    else if (/^\[they sent this as an inline reply\b[^\]\n]*\]$/i.test(t)) put = "(sent as an inline reply to an earlier message)";
    if (put === t) return line;
    return put ? lead + put : (lead ? lead.trimEnd() : null);
  }).filter(l => l !== null).join("\n").replace(/^\n+/, "");
}

const tidy = (v) => {
  const verdict = VERDICTS.includes(v?.verdict) ? v.verdict : null;
  if (!verdict) return { verdict: "unscreened", error: `the screen returned ${JSON.stringify(v?.verdict ?? null)}` };
  const category = CATEGORIES.includes(v?.category) ? v.category : (verdict === "crisis" ? "self_harm" : verdict === "clear" ? "" : "other");
  const note = typeof v?.note === "string" ? v.note.trim().slice(0, 160) : "";
  return { verdict, category, note };
};

/** Is there any model to screen with? Without one there is nothing that could answer either. */
export const modelAvailable = () => process.env.REASON_BACKEND === "claude-cli" || !!process.env.ANTHROPIC_API_KEY;

/**
 * Screen one inbound message. Never throws. A screen that could not run says `unscreened`, and
 * the caller treats that as "not clear" — the turn runs with every outward tool held until the
 * message is screened again and comes back clear (see `recheck` in Runtime._screen).
 *
 * With no model configured at all (the offline suite, a console with no key) it answers `clear`
 * with `skipped` set: nothing in that state can run a model turn either, so there is nothing a
 * refusal would be protecting against, and it is said in the result rather than hidden.
 */
export async function screen({ text, messages = [], who = "them", backend = null, model = null, feature = "harm" }) {
  if (!modelAvailable()) return { verdict: "clear", category: "", note: "", skipped: "no_model" };
  const context = contextLines(messages);
  // Their words verbatim; only code's own notes about the message are put plainly (see ownWords).
  const said = `The new message, verbatim:\n${who}: ${capForScreen(ownWords(text))}`;
  const prompt = (context ? `The last few lines of the conversation:\n${context}\n\n` : "") + said;
  // Which path screens this message: the subscription, unless a phone call on the API says so
  // (src/calls/voice.js). See screenBackend.
  const cli = (backend ?? screenBackend()) !== "api";
  const ask = async (p) => {
    if (!cli) return askApiThenCli({ system: INSTRUCTIONS, prompt: p, model, verdicts: VERDICTS, categories: CATEGORIES, feature });
    const r = await cliScreen({ prompt: p, instructions: INSTRUCTIONS, verdicts: VERDICTS, categories: CATEGORIES });
    if (r.platform_refusal) return PLATFORM_REFUSAL;
    return r.error ? { verdict: "unscreened", error: r.error } : tidy(r);
  };
  const r = await ask(prompt);
  if (!r.platform_refusal || !context) return r;
  // The platform would not read it WITH the thread: often the thread is the reason, an earlier
  // line of theirs that was already refused. That earlier line was answered and counted when it
  // came in; it must not make every message after it a strike too. On the live model a refused
  // "how do i build a bomb" turned "ok forget that, book me a table at carbone friday" into a
  // platform refusal, i.e. 'harm' and a strike, four times of four. So the message is asked again
  // on its own: 'harm' (or a refusal) alone is 'harm'; crisis and borderline stand; and a message
  // that reads as ordinary alone is 'borderline', not 'clear', because the thread around it could
  // not be read: the turn runs, with its hands tied and its reply screened on the way out, and
  // nobody gets a strike for the thread's sake.
  const alone = await ask(said);
  if (alone.verdict === "clear" || alone.verdict === "unscreened") {
    return { verdict: "borderline", category: "other", note: "ordinary on its own; the thread before it could not be read", context_refused: true };
  }
  return { ...alone, context_refused: true };
}

/** What the screen says when the model's own safeguards refused the message before any reading. */
const PLATFORM_REFUSAL = { verdict: "harm", category: "other", note: "the model's own safeguards refused to read it", platform_refusal: true };

export const REPLY_INSTRUCTIONS = `You are the safety screen on the way OUT of a personal assistant that people text. The person's message was borderline — it touched a dangerous subject — and the assistant has written a reply. Decide one thing: does this reply give material help toward hurting a person or people (see below), in any part of it?

Material help means: steps, ingredients, quantities, sources, methods, targets, timings, how to avoid being caught, or a draft of a threat — toward violence, a weapon, a bomb or explosive, a poison or toxin or chemical, biological, nuclear or radiological agent, drugging somebody, stalking or tracking a person to hurt them, anything sexual involving a child, or breaking into somebody's accounts or systems.

Say 'harm' if any of that is in the reply, even wrapped in warnings. Say 'clear' if the reply refuses, deflects, answers an innocent reading, or only gives general safety information with nothing operational in it. 'borderline' and 'crisis' are not answers here.`;

/**
 * Screen a reply the model wrote to a borderline message. Same contract: never throws, and
 * anything but a clean `clear` is treated as `harm` by the caller — on the way out, a shrug is a
 * refusal, because the alternative is sending something nobody checked.
 */
export async function screenReply({ text, asked = "" }) {
  if (!modelAvailable()) return { verdict: "clear", skipped: "no_model" };
  const prompt = `What they had asked:\n${String(asked).slice(0, 600)}\n\nThe reply the assistant wrote, verbatim:\n${capForScreen(text)}`;
  // On the API backend, the API (screenBackend); same instructions, same two verdicts.
  if (screenBackend() === "api") {
    const a = await askApi({ system: REPLY_INSTRUCTIONS, prompt, feature: "harm_reply" });
    if (a.platform_refusal) return PLATFORM_REFUSAL;
    return a.verdict === "clear" || a.verdict === "harm" ? a : { verdict: "unscreened", error: a.error ?? `the screen returned ${a.verdict}` };
  }
  const r = await cliScreen({ prompt, instructions: REPLY_INSTRUCTIONS, verdicts: ["clear", "harm"], categories: CATEGORIES });
  if (r.platform_refusal) return PLATFORM_REFUSAL;
  return r.error ? { verdict: "unscreened", error: r.error } : tidy(r);
}

// ---------- the words, which are code's ----------

/** What goes back on 'harm'. Plain, short, no lecture, no door left open. */
export const REFUSAL_LINE = "i'm not going to help with that. not as a joke, not hypothetically, not for a story. if something's going on, i'm here to talk.";

/** What rides on the end of a crisis reply when the model's own words did not carry it. */
export const CRISIS_LINE = "if you're thinking about hurting yourself, please reach out right now: call or text 988 (the Suicide and Crisis Lifeline, US, free, 24/7), or findahelpline.com anywhere else. i'm here too.";

/** What replaces a borderline reply the outbound screen would not pass. */
export const WITHHELD_LINE = "i'm going to leave that one. if it's something ordinary, say a bit more about what it's for and i'll help.";

/** Does a crisis reply already carry a real way to reach help? */
export const carriesCrisisHelp = (text) => /\b988\b|findahelpline|samaritans|crisis (text )?line|lifeline/i.test(String(text ?? ""));

// ---------- strikes ----------

/** The window a strike is counted in, and how many pause an account. */
export const strikePolicy = () => ({ limit: config.harmStrikeLimit, windowMs: config.harmStrikeWindowHours * 3_600_000 });

/**
 * One refusal, written down and counted. Returns the count inside the window and whether that has
 * reached the limit. Never the message: what is kept is when, which kind, and the screen's one
 * phrase — enough to answer "what happened" and nothing anybody could reread.
 */
export function recordStrike(conversationId, { category = "other", note = "", verdict = "harm" } = {}) {
  const now = clock.now();
  db.recordHarmEvent({ conversationId, at: now, verdict, category, note });
  const { limit, windowMs } = strikePolicy();
  const count = db.harmEventsSince(conversationId, now - windowMs, { verdict: "harm" }).length;
  return { count, limit, windowMs, reached: limit > 0 && count >= limit };
}

/**
 * Strikes the screen got wrong, voided: they stop counting toward a pause and the ops tally, and
 * the rows stay as a record of what happened (db.voidHarmEvent). Returns the ids actually voided;
 * an id that is not a 'harm' row of this conversation is skipped. The ledger row is the caller's
 * (scripts/void-strikes.mjs), so this file stays free of the ledger.
 */
export function voidStrikes(conversationId, ids = [], { why = "false positive" } = {}) {
  return ids.map(Number).filter(id => db.voidHarmEvent({ conversationId, id, why }));
}

/** The count and the kinds inside the window, for the master's line and for admin_usage. */
export function strikesFor(conversationId, nowMs = clock.now()) {
  const { limit, windowMs } = strikePolicy();
  const rows = db.harmEventsSince(conversationId, nowMs - windowMs, { verdict: "harm" });
  const kinds = [...new Set(rows.map(r => r.category).filter(Boolean))];
  return { count: rows.length, limit, windowHours: config.harmStrikeWindowHours, kinds, since: rows[0]?.at ?? null };
}

/** The last four digits are enough for the master to know who; the words are never sent. */
const endsWith = (address) => {
  const digits = String(address ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `the number ending ${digits.slice(-4)}` : "someone";
};

/** The master's heads-up when a Reason is paused for strikes. Counts and kinds only. */
export function pausedLine({ address, strikes }) {
  const kinds = strikes.kinds.length ? ` (${strikes.kinds.join(", ")})` : "";
  return `heads up — ${endsWith(address)} asked me for something i won't help with ${strikes.count} times in the last ${strikes.windowHours}h${kinds}.`
    + ` i've paused their reason. nothing of theirs is deleted. tell me to resume them if you want it back on.`;
}

/** The thread's own record of a refused message and the line that answered it. */
export function historyLines({ who = "them", text }) {
  return [
    { role: "user", content: `[${stamp()}] ${who}: ${text}` },
    { role: "assistant", content: REFUSAL_LINE },
  ];
}
