// Openers for the speaking brain (src/calls/brainfirst.js, docs/calls-brain-first.md "Openers").
//
// The moment they stop talking, a few content-free words are said ("Okay, so", "Hmm,", "Sorry about
// that,"), picked by fixed rules in well under a millisecond, and the speaking turn is TOLD those words
// are already its own: it writes only what comes after them, so the caller hears one sentence that
// starts at once. An opener carries no fact, no yes or no, nothing that says something is done or will
// be, and nothing upbeat (the answer may be bad news): if the class is wrong, the worst that is heard is
// a slightly odd "Hmm," before a plain answer. Whether an opener is said at all is decided by time
// (`OPENER_AT_MS`): when the speaking turn's own first sentence is in before then, none is.
import { saysDone } from "./cartesia.js";

/** The classes a caller's turn is read into. */
export const CLASSES = ["chat", "question", "lookup", "request", "memory", "repair"];

/**
 * The bank. Every entry is content-free (pinned by test/call-brain-first.test.js): no fact, number,
 * name, yes/no, "sure", "done", "got it", "no problem", nothing upbeat. An entry ending in a comma or
 * "so" is the start of a sentence the speaking turn finishes; one ending in a full stop stands alone.
 */
export const OPENERS = {
  // Small talk and check-ins: often a breath is enough.
  chat: ["Mm,", "Hey,", "Oh,", "Well,", "Hm,", "Mm, well,", "Oh, hey,", "Oh, well,"],
  // An opinion or a thing Reason can answer from what is in front of it.
  question: ["So,", "Okay, so", "Hmm,", "Well,", "Let me think.", "Hm, so", "Okay, well,", "So, honestly,", "Right, so", "Hmm, okay,"],
  // A fact that may need looking up (prices, times, places): nothing that implies the answer is known.
  lookup: ["Let me see.", "Okay, let me look.", "Hmm, let me check.", "One sec,", "Let's see,", "Okay, one moment,", "Let me pull that up.", "Hm, let me see,"],
  // Something to do: nothing that agrees to it before the full brain has.
  request: ["Okay,", "Okay, so", "Alright,", "Right,", "Hm, okay,", "Okay, let me see,", "Alright, so", "Let me see,"],
  // What happened before (an earlier call, a text): nothing that names it.
  memory: ["So,", "Right, so", "Let me think back.", "Okay, so", "Hmm, so", "Mm, so", "Let me think.", "Right,"],
  // A correction or a complaint: an apology says nothing about the answer.
  repair: ["Sorry,", "Ah, sorry,", "Sorry about that.", "Okay, sorry,", "Fair,", "Mm, sorry,", "Sorry, my mistake,", "Okay, fair,"],
};

/** Every opener, once. */
export const ALL_OPENERS = [...new Set(Object.values(OPENERS).flat())];

/** Words an opener must never hold (the content-free rule; the test reads every entry against it). */
export const NOT_IN_AN_OPENER = /\b(?:yes|yeah|yep|no|nope|sure|done|got\s+it|no\s+problem|of\s+course|absolutely|great|perfect|awesome|good\s+news|bad\s+news|booked|sent|set|ready|found|here(?:'|’)s|there(?:'|’)s|it(?:'|’)s|you(?:'|’)re|we\s+were|last\s+(?:time|call)|i\s+(?:can|will|have|did)|i(?:'|’)ll)\b|\d/i;

/** Their turn, read by rules (no model, under a millisecond). The first class whose rule matches wins. */
const RULES = [
  ["repair", /^\s*(?:(?:uh|um|oh|ah)[,.]?\s+)?(?:no(?:,|\s+no\b|\s+i\s+said\b|\s+that(?:'|’)s\b)|nope\b|that(?:'|’)s\s+(?:not|wrong)\b|wait,?\s+no\b|i\s+said\b|i\s+didn(?:'|’)?t\s+(?:want|say|mean|ask)\b)|\b(?:what\s+the\s+(?:fuck|hell|heck)|wtf|you(?:'|’)re\s+(?:wrong|not\s+listening)|that(?:'|’)s\s+wrong|not\s+what\s+i\s+(?:said|asked|meant)|i\s+(?:already\s+)?told\s+you|are\s+you\s+(?:even\s+)?listening)\b/i],
  ["memory", /\b(?:remember|recall|last\s+(?:call|time|night|week)|earlier|before|where\s+were\s+we|we\s+(?:talked|spoke|said)|you\s+(?:said|told\s+me|mentioned)|did\s+you\s+see\s+(?:that\s+)?i|i\s+(?:asked|told)\s+you|the\s+other\s+day|yesterday)\b/i],
  ["request", /\b(?:can|could|would|will)\s+you\s+(?:just\s+|please\s+)?(?!tell|explain|think|believe|imagine|hear)\w+|\b(?:please|go\s+ahead|do\s+(?:that|it)|book|send|text|call|order|remind|set\s+(?:up|a)|schedule|add|cancel|start|make)\b(?!\s*\?)/i],
  ["lookup", /\b(?:how\s+(?:much|many|long|far|big|late|early)|what\s+time|when\s+(?:is|does|do|are)|where\s+is|closest|nearest|price|cost|weather|open(?:\s+until)?|hours|tax|market\s+size|how\s+big)\b/i],
  // "...Hello?" at the end of a turn is a check-in: they think the line went quiet.
  ["chat", /\bhello\s*\?\s*$|^\s*(?:(?:hi|hey|hello|yo|sup|hiya)\b[\s,.!?]*|how\s+(?:are|is)\s+(?:you|it\s+going)|how(?:'|’)s\s+it\s+going|what(?:'|’)s\s+up|good|great|fine|yeah|yep|yes|ok(?:ay)?|mm+|uh[\s-]*huh|cool|nice|thanks|thank\s+you)\b[^?]{0,40}[.!?]*\s*$|^\s*(?:hello|hey)\??\s*$/i],
  ["question", /\?|\b(?:what|why|how|which|who|should|do\s+you\s+think|what\s+do\s+you)\b/i],
];
export function classify(theirWords) {
  const t = String(theirWords ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "chat";
  for (const [k, re] of RULES) if (re.test(t)) return k;
  return "question";
}

/**
 * The opener for this turn: one of the class's, never one said in the last `RECENT` turns of this call
 * (so never the same twice running), chosen at random among the rest. `recent` is the call's own list,
 * newest last; the pick is appended to it.
 */
export const RECENT = 3;
export function pickOpener(kind, recent = [], { random = Math.random } = {}) {
  const bank = OPENERS[kind] ?? OPENERS.question;
  const fresh = bank.filter(o => !recent.slice(-RECENT).includes(o));
  const from = fresh.length ? fresh : bank.filter(o => o !== recent.at(-1));
  const o = from[Math.floor(random() * from.length) % from.length];
  recent.push(o);
  if (recent.length > 12) recent.splice(0, recent.length - 12);
  return o;
}

/** When the speaking turn's own first sentence is not in by then, the opener is said (and its continuation used). */
export const OPENER_AT_MS = 700;

/** The note that tells the speaking turn its reply has begun with `opener`. */
export const openerNote = (opener) => `[You have ALREADY said, out loud, the first words of your reply: "${opener}" Write ONLY what comes next, carrying straight on from those words as one sentence. Do not repeat them, do not start with another filler ("so", "okay", "well", "got it", "fair", "right"), and do not start a new greeting.]`;

/**
 * The messages for the turn that continues an opener: the note rides on their words (never as theirs),
 * and the opener is the start of the assistant's turn where the model accepts a prefill.
 */
export function withOpener(messages, opener, { prefill = false } = {}) {
  const out = messages.map(m => ({ ...m }));
  const last = out.at(-1);
  if (last?.role === "user") last.content = `${last.content}\n\n${openerNote(opener)}`;
  if (prefill) out.push({ role: "assistant", content: opener });
  return out;
}

/**
 * The continuation, joined to the opener as the caller hears it: a repeated opener is dropped, the case
 * of the first letter follows the opener's end, and nothing is said twice. Returns the words to send
 * after the opener (the opener itself is already out).
 */
export function joinAfter(opener, continuation) {
  let c = String(continuation ?? "").replace(/^\s+/, "");
  const o = String(opener ?? "").trim();
  const bare = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  // A leading ellipsis or dash, the opener said again, or its own last word said again
  // ("Alright, so so the", "Fair, ... fair,"): out, word by word, never by character count.
  const words = bare(o).split(" ").filter(Boolean);
  const gap = "[\\s,.…!?;:-]*";
  c = c.replace(/^(?:\.{2,}|…|[-–—])\s*/, "");
  if (words.length) c = c.replace(new RegExp(`^${words.join(gap)}\\b${gap}`, "i"), "");
  if (words.length) c = c.replace(new RegExp(`^${words.at(-1)}\\b${gap}`, "i"), "");
  if (!c) return "";
  const endsSentence = /[.!?…]$/.test(o);
  if (endsSentence) return c[0].toUpperCase() + c.slice(1);
  // Mid-sentence: only a plain starting word loses its capital ("So, We were" -> "So, we were"), never a name.
  return c.replace(/^(The|We|It|That|This|There|You|Your|They|He|She|Let|My|Our|A|An|If|Last|Here|What|Yeah|Honestly|Right|Okay|So)\b/, w => w.toLowerCase());
}

/** The openers that stand alone before the lookup music (a hand-off with nothing after them). */
export const STANDALONE = ["Let me see.", "Okay, let me look.", "Hmm, let me check.", "Let me pull that up.", "Let me think."];
/** A stand-alone opener, never the last one said. */
export function pickStandalone(recent = [], { random = Math.random } = {}) {
  const from = STANDALONE.filter(o => !recent.slice(-RECENT).includes(o));
  const o = (from.length ? from : STANDALONE)[Math.floor(random() * (from.length || STANDALONE.length))];
  recent.push(o);
  return o;
}
/** Said after an opener when the continuation hands over with no words of its own, so no sentence dangles. */
export const HANDOFF_TAIL = "let me check on that.";

/** Is this opener safe to say on its own (the done guard and the content rule)? */
export const openerSafe = (o) => !NOT_IN_AN_OPENER.test(o) && !saysDone(o);
