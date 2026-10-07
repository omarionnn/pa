// What changes about Reason when it is on a phone instead of in a text thread.
//
// Almost nothing about who it is changes: the persona, the honesty rules, the refusals and the
// no-false-progress rule in src/agent.js all still hold, and this file never restates them. What
// changes is that the words are going to be SPOKEN, and four things that are fine in a bubble are
// bad out loud:
//
//   1. **A link read aloud is not a link.** "h t t p s colon slash slash" is a thing nobody can
//      write down while holding a phone. So the rule is the one Reason already uses for anything
//      worth keeping: say "I'll text you that", and text it (see `textingMidCall` in ./voice.js —
//      the text is queued by code, during the call, so it has landed by the time they hang up).
//   2. **Markdown is read as punctuation.** Asterisks, hyphens and emoji become noises.
//   3. **"7:40" is not a spoken time.** A speech model will usually say it correctly; "twenty to
//      eight" is what a person says, and it is never wrong.
//   4. **Length.** A paragraph that scans fine on a screen is forty seconds of monologue nobody can
//      interrupt gracefully. Two or three sentences, then stop and let them talk.
//
// And one thing that is not about speech at all: on a call there is no going back and editing. A
// text can be followed by "sorry, I had that wrong". A call has to say it in the moment, which is
// why admitting a miss out loud is in here rather than left to the general persona.
import { config } from "../config.js";

/**
 * The rules every voice turn carries, both directions. Deliberately short — this is appended to a
 * system prompt that is already long, and every line in it has to be worth the first-word latency
 * it costs.
 */
export const VOICE_RULES = [
  `You are on a phone call right now. Everything you write is spoken out loud by a voice, immediately.`,
  `Two or three sentences at most, then stop. Let them cut in; if they talk over you, stop and listen.`,
  `No emoji, no markdown, no asterisks, no bullet points, no headings. Plain spoken sentences only.`,
  `Never say a web address, a link, an email address or a code out loud. If there is one, say you will text it and it gets texted.`,
  `Say numbers and times the way a person says them: "twenty to eight", not "7:40". "Two fifty" for $2.50.`,
  `If you get something wrong, say so out loud in the moment — "sorry, I had that wrong, it's actually Thursday" — rather than talking past it.`,
  `If you do not know something, say you will check and come back. Never fill a gap with a guess because silence feels bad.`,
  `Reply in the language the person on the line is speaking. If they switch language, switch with them and stay there.`,
].join("\n");

/**
 * The language rule, as the thing Reason is told to DO about it rather than as a preference.
 *
 * The voice half of switching language is the platform's `language_detection` system tool, which it
 * only acts on if the model answers with a function call — so "reply in Spanish" alone would have
 * Reason speaking Spanish words in an English voice configuration. The two halves have to happen
 * together, and the model is the only thing that knows a switch happened, so it is told explicitly.
 */
export const LANGUAGE_RULE = [
  `If the person on the line starts speaking a language the call is NOT already in, do two things in the same turn:`,
  `call the language_detection tool with that language's two-letter code and one short reason, and write your reply in that language.`,
  `Do not announce the switch and do not ask their permission for it. Just switch.`,
  // From the first rehearsal (2026-10-06): once the restaurant answered in Spanish it called this on
  // every turn afterwards. The words were right and the tool call was noise — and noise aimed at the
  // platform re-configures a live call. Code drops a switch to the language already in use
  // (`voiceTurn` in ./voice.js); this is so the model does not make them in the first place.
  `Only when it CHANGES. Once you are already speaking their language, do not call it again —`,
  `calling it every turn re-configures the call for no reason.`,
].join(" ");

/**
 * What Reason says about the recording after the language changes, in the new language.
 *
 * The announcement is spoken in the language the call opened in. If the call then moves to Spanish,
 * the disclosure has only ever been heard in a language the person may not have understood, which is
 * not a disclosure. So it is said again — once, at the top of the first reply in the new language.
 *
 * It is an instruction to say it rather than a fixed translated string on purpose: Reason knows the
 * language it has just switched to and this module does not, and a hand-written Spanish line here
 * would be the only translation in the codebase and the wrong one in the other forty languages.
 * What is NOT left to the model is whether to do it, which is why this is code deciding.
 */
export function announcementAgainIn(language, { ownerName = config.ownerName } = {}) {
  return `This call has just changed language, to ${language}. Before anything else in your next reply,`
    + ` say in ${language} that you are an AI assistant calling on behalf of ${ownerName} and that the call is recorded,`
    + ` and that they can tell you if they would rather not be. Then carry on with what they asked.`
    + ` Say it once; do not repeat it again later in the call.`;
}

/**
 * The frame on an OWNER call: who is on the line and what this moment is.
 *
 * It is a person's own Reason answering their own phone call, so almost nothing needs saying. The
 * two things that do: that the thread it can see is the same conversation (so it does not greet them
 * as a stranger or re-introduce itself), and that the recording line is NOT recited at them. The
 * owner is told once, by text, the first time their number ever calls — reciting a legal disclosure
 * at the person who set the thing up is the kind of detail that makes it feel like a product rather
 * than theirs.
 */
export function ownerCallFrame({ name, opening = "" }) {
  return [
    `${name} is on the phone with you right now. This is the same conversation as their texts — the recent ones are below —`
    + ` so do not introduce yourself, do not ask who is calling, and do not offer a menu of what you can do.`,
    `Do NOT recite anything about the call being recorded. They know; they set this up. Every call is recorded and that is already handled.`,
    opening
      ? `Open with this, in your own words, because it is what is actually going on: ${opening}`
      : `Open with whatever is actually going on between you — something open, something that just happened — rather than "how can I help".`,
    `You have your ordinary tools and you may use them on this call. Anything that needs their yes still needs it;`
    + ` their spoken yes counts, and you take it the same way you take a typed one.`,
    `When you do something that produces a link, an address, a time or anything they would want to keep, say you are texting it and it is texted for you.`,
  ].join("\n");
}

/**
 * The frame on a THIRD-PARTY call: the goal, the approved facts, the standing rules, and nothing
 * else at all.
 *
 * The isolation is not in these words. It is that the owner context builder is a different function
 * which this one does not call: there is no thread here, no memory, no open tasks and no tools but
 * the two the platform owns, because none of them are passed in. See ./voice.js. What the words add
 * is the thing a model cannot be told structurally — that an answer it does not have is a "let me
 * check with them", not an invention.
 */
export function thirdPartyFrame({ ownerName, goal, facts = [], rules = [], announcement = "" }) {
  const list = facts.map(f => String(f).trim()).filter(Boolean);
  return [
    `You are an AI assistant on a phone call for ${ownerName}. You are not ${ownerName} and you never say you are.`,
    announcement
      ? `Your opening line was already spoken for you, word for word: "${announcement}". Do not say it again and do not reword it.`
      : ``,
    `Rules for this call, whatever you are asked:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    `What this call is for:\n${String(goal ?? "").trim()}`,
    list.length
      ? `The only things you may say about ${ownerName} or their plans:\n${list.map(f => `- ${f}`).join("\n")}`
      : `You were given nothing you may share about ${ownerName} beyond the line above.`,
    `If they ask you anything that is not in that list, say you will check with ${ownerName} and come back to them. Do not guess and do not make anything up.`,
    `You have no access to ${ownerName}'s messages, calendar, or anything else on this call, and you do not imply that you do.`,
    // From the first rehearsal (2026-10-06): it said "thank you, goodbye" on the second turn of a
    // five-turn call, four separate times, while the call carried on. Saying goodbye and not hanging
    // up is worse than either on its own — the person on the line does not know whether to speak.
    `Do not say goodbye until you are actually ending the call. When you ARE ending it, thank them and`
      + ` call the end_call tool in the same turn — never one without the other.`,
    `Once you have the answer, or they tell you they cannot help, that is the moment to end it.`,
  ].filter(Boolean).join("\n\n");
}

/**
 * The one line a number nobody knows gets, and the end of the call.
 *
 * Same policy as a text from a stranger, and for the same reason: a model turn for an unapproved
 * caller is the operator's money spent by whoever dialled the number. So this is a fixed string, no
 * model is asked anything, and the master hears about it exactly as they do for a text.
 */
export function strangerLine({ ownerName = config.ownerName } = {}) {
  return `Hi — you've reached an AI assistant for ${ownerName}. I'm not set up to take calls from this number,`
    + ` so I'll pass on that you rang. Thanks.`;
}

/**
 * How long a spoken reply may run before it stops being a phone call and starts being a monologue.
 *
 * Not a hard truncation of what the model said — cutting a sentence in half mid-word is worse than
 * a long answer. It is the number the prompt above is enforced against in the test, so "two or three
 * sentences" is a thing that can fail rather than a hope.
 */
export const SPOKEN_REPLY_MAX_CHARS = 600;
