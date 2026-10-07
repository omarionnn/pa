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
//     `runTool`, and a borderline reply is screened again on the way out.
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
import { config, clock, stamp } from "./config.js";
import { screenViaCli } from "./backends/cli.js";
import * as db from "./db.js";

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

Say 'crisis' when the person is talking about ending their life, wanting to die, or hurting themselves — however casual, however much it sounds like a joke. Never 'harm' for that: they are the one at risk.

Say 'clear' for everything ordinary, and do not reach: slang ("this exam is killing me", "shoot me a text", "that's the bomb", "I could murder a burger"), sports ("shooting", "kill shot"), cooking, gardening ("poison ivy", "killing weeds"), medicine for themselves ("is 2 ibuprofen ok"), news and history as subjects, self-defence and safety questions ("how do I know if my drink was spiked"), fiction talked about as fiction with no operational detail asked for, games, and strong feelings said in words ("I'm so angry I could scream").

Say 'borderline' only when it genuinely could be either and the thread does not settle it — a question about a chemical, a medication dose, a person's whereabouts, a lock, a network — and you cannot tell what it is for. Not as a hedge: if it is clearly innocent say 'clear', and if it is clearly seeking help toward harm say 'harm'.

Judge the message you are given against the context you are given. Do not imagine a worse conversation than the one in front of you, and do not imagine a kinder one either.`;

let client = null;
const anthropic = () => (client ??= new Anthropic());

/** The most recent lines of a thread, as the screen is shown them. Short on purpose. */
export function contextLines(messages = [], { limit = 6, width = 400 } = {}) {
  const lines = [];
  for (const m of messages.slice(-limit)) {
    if (m.role === "user" && typeof m.content === "string") lines.push(m.content.slice(0, width));
    else if (m.role === "assistant" && typeof m.content === "string") lines.push(`Reason: ${m.content.slice(0, width)}`);
    else if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      if (text) lines.push(`Reason: ${text.slice(0, width)}`);
    }
  }
  return lines.join("\n");
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
 * the caller treats that as "not clear" — the turn runs with every outward tool refused.
 *
 * With no model configured at all (the offline suite, a console with no key) it answers `clear`
 * with `skipped` set: nothing in that state can run a model turn either, so there is nothing a
 * refusal would be protecting against, and it is said in the result rather than hidden.
 */
export async function screen({ text, messages = [], who = "them" }) {
  if (!modelAvailable()) return { verdict: "clear", category: "", note: "", skipped: "no_model" };
  const context = contextLines(messages);
  const prompt = (context ? `The last few lines of the conversation:\n${context}\n\n` : "")
    + `The new message, verbatim:\n${who}: ${text}`;
  if (process.env.REASON_BACKEND === "claude-cli") {
    const r = await screenViaCli({ prompt, instructions: INSTRUCTIONS, verdicts: VERDICTS, categories: CATEGORIES });
    if (r.platform_refusal) return PLATFORM_REFUSAL;
    return r.error ? { verdict: "unscreened", error: r.error } : tidy(r);
  }
  try {
    const res = await anthropic().messages.create(
      {
        model: config.harmModel,
        max_tokens: 200,
        system: INSTRUCTIONS,
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: "verdict" },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: config.harmTimeoutMs, maxRetries: 1 },
    );
    // The platform's own safeguards declining to read it is the strongest 'harm' there is: the
    // turn this screen guards would meet the same wall.
    if (res.stop_reason === "refusal") return PLATFORM_REFUSAL;
    const block = res.content.find(b => b.type === "tool_use" && b.name === "verdict");
    return tidy(block?.input);
  } catch (e) {
    return { verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] };
  }
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
  const prompt = `What they had asked:\n${String(asked).slice(0, 600)}\n\nThe reply the assistant wrote, verbatim:\n${text}`;
  if (process.env.REASON_BACKEND === "claude-cli") {
    const r = await screenViaCli({ prompt, instructions: REPLY_INSTRUCTIONS, verdicts: ["clear", "harm"], categories: CATEGORIES });
    if (r.platform_refusal) return PLATFORM_REFUSAL;
    return r.error ? { verdict: "unscreened", error: r.error } : tidy(r);
  }
  try {
    const res = await anthropic().messages.create(
      {
        model: config.harmModel,
        max_tokens: 200,
        system: REPLY_INSTRUCTIONS,
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: "verdict" },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: config.harmTimeoutMs, maxRetries: 1 },
    );
    if (res.stop_reason === "refusal") return PLATFORM_REFUSAL;
    const block = res.content.find(b => b.type === "tool_use" && b.name === "verdict");
    return tidy(block?.input);
  } catch (e) {
    return { verdict: "unscreened", error: (e?.message ?? String(e)).split("\n")[0] };
  }
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
