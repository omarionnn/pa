// One identity on every surface: the name they gave their Reason, and one voice.
//
// Found 2026-11-12. The owner had renamed his Reason "Huey". Texts, the web and calls all said "You
// are Reason" in their prompts, and the only place a chosen name was ever kept (accounts.
// contact_card_name, from the first chat's "what do you want to call me?") was read by the contact
// card alone. And the voice: a voice note Reason texted was Gemini's text-to-speech in its "Puck"
// voice (a man's), while every call is OpenAI's live voice "marin" (a woman's, the owner's pick) —
// two providers, two voices, nothing tying them together.
//
// So, behind REASON_ONE_IDENTITY (off | owner | on):
//
//   NAME. The name they gave is said to every model that speaks for them, in the one block they all
//   already read (src/rules.js rulesNote: text turns, Web, reminders, Claude's turn on a call, the
//   GPT-Live voice's brief). It is saved by the remember tool (kind 'your_name') on their own word,
//   whatever the switch says; the switch decides whether it is used. To anybody else — a business
//   Reason rings, a person it messages for them — it is still "Reason": the disclosure a stranger
//   hears does not change.
//
//   VOICE. A texted voice note is spoken by OpenAI's speech model in the SAME voice name the live
//   call uses (config.gptliveVoice — the model the call's pickup opener already uses,
//   src/calls/opener.js), with the same accent direction. When that cannot be made (no key, an
//   error), the note falls back to Gemini in its closest voice (config.ttsCloseVoice), never to the
//   old default. Nothing about a live call changes: this reads the call's voice, it does not set it.
//
// Per person: `callVoiceFor` is the one place a person's own voice pick would be read. Nobody can
// pick one today (every call uses config.gptliveVoice), so it returns that for everyone.
import { config } from "./config.js";
import * as db from "./db.js";
import { cardName, DEFAULT_CARD_NAME } from "./contact.js";

/** Is the one-identity switch on for this conversation's account? */
export function oneIdentityFor(conversationId) {
  const v = config.oneIdentity;
  if (v === "on") return true;
  if (v !== "owner" || !conversationId) return false;
  try { return !!db.getAccount(conversationId)?.is_operator; } catch { return false; }
}

/** The name they gave their Reason, or "" when they gave none (or it is just "Reason"). */
export function givenName(conversationId) {
  if (!conversationId) return "";
  let n = "";
  try { n = promptName(db.getAccount(conversationId)?.contact_card_name); } catch { return ""; }
  return n && n.toLowerCase() !== DEFAULT_CARD_NAME.toLowerCase() ? n : "";
}

/**
 * A stored name made safe to sit inside a prompt, whoever wrote the row (the first chat and the web
 * setup write this column too, without this file's checks): one line, no control or invisible
 * characters, no quotes or brackets that could close the sentence it is quoted in, at most four
 * words and 40 characters. "" when nothing is left.
 */
export function promptName(raw) {
  const typed = String(raw ?? "").trim();
  if (!typed) return "";
  // cardName answers "Reason" for a name with nothing left in it, which givenName reads as none.
  const n = cardName(typed.replace(/["“”„«»\\[\]{}|]/g, " ")).split(" ").slice(0, 4).join(" ").trim();
  return n;
}

/** What Reason goes by with this person: their name for it when the switch covers them, else "Reason". */
export function nameFor(conversationId) {
  return (oneIdentityFor(conversationId) && givenName(conversationId)) || DEFAULT_CARD_NAME;
}

/**
 * Save the name they gave (their own word, through the remember tool). Tidied like a contact card's
 * name; "Reason" clears it. Returns `{ ok, name, was, used }`.
 */
export function setGivenName(conversationId, raw) {
  const typed = String(raw ?? "").replace(/["“”]/g, "").trim();
  if (!typed) return { ok: false, error: "Nothing was saved: the name goes in 'fact', on its own." };
  if (typed.split(/\s+/).length > 4) return { ok: false, error: "Nothing was saved: 'fact' must be the name alone (a word or two), not a sentence." };
  const was = givenName(conversationId);
  const name = promptName(typed);
  const set = db.setContactCardName(conversationId, name);
  if (!set) return { ok: false, error: "Nothing was saved: there is no account here to keep it on." };
  return { ok: true, name, was, used: oneIdentityFor(conversationId) };
}

/** The heading the name rides under, the same words on every surface. */
export const IDENTITY_HEADING = "WHO YOU ARE TO THEM:";

/**
 * The line every model that speaks for them reads, or "". It says whose name it is in the same
 * sentence the profile does (`assistantNameLine`): a turn Reason starts itself (a task's update, a
 * reminder) is shown this line and not the profile, and on 2026-11-14 one opened "Back on the …
 * setup, <the assistant's name>:" — addressed to them.
 */
export function identityNote(conversationId) {
  if (!oneIdentityFor(conversationId)) return "";
  const n = givenName(conversationId);
  if (!n) return "";
  const whose = assistantNameLine(n, theirOwnName(conversationId));
  return `${IDENTITY_HEADING} they named you "${n}". With them you are ${n} — the same one in their texts, on the web and on a phone call, with one memory of all of it.`
    + ` Answer to ${n}, and when you say who you are to them, say ${n} (you are still their Reason; "${n}" is your name with them).`
    + (whose ? ` ${whose}` : "")
    + ` To anybody else — a business you ring, somebody you message for them — you are "Reason", their assistant, exactly as before.`;
}

// ---------- the assistant's nickname is never their name ----------

// A saved fact or profile line that gives the ASSISTANT a name, in the forms facts are written in
// ("Wants the assistant to answer to the name Nimbus", "calls Reason Nimbus", "your name is Nimbus").
const NAMES_THE_ASSISTANT = [
  /\b(?:[Tt]he\s+assistant|[Rr]eason|[Yy]ou|(?:[Hh]is|[Hh]er|[Tt]heir)\s+assistant)\b[^.\n]{0,30}?\b(?:answer(?:s|ing)?\s+to|be\s+called|go(?:es)?\s+by|respond(?:s)?\s+to)\s+(?:the\s+name\s+|the\s+nickname\s+)?["“'‘]?([A-Z][\p{L}'’-]{1,30})/u,
  /\b(?:[Cc]alls?|[Cc]alling|[Cc]alled|[Nn]ames?|[Nn]amed|[Nn]aming|[Nn]icknamed?)\s+(?:[Tt]he\s+assistant|[Rr]eason|[Yy]ou|(?:[Hh]is|[Hh]er|[Tt]heir)\s+assistant)\s+(?:by\s+the\s+name\s+|as\s+)?["“'‘]?([A-Z][\p{L}'’-]{1,30})/u,
  /\b(?:[Tt]he\s+assistant(?:'|’)s|[Rr]eason(?:'|’)s|[Yy]our)\s+(?:nick)?name\s+(?:is|should\s+be)\s+["“'‘]?([A-Z][\p{L}'’-]{1,30})/u,
];

/** The name a profile line or saved fact gives the assistant, or "". */
export function assistantNameIn(line) {
  for (const re of NAMES_THE_ASSISTANT) { const m = re.exec(String(line ?? "")); if (m) return m[1].replace(/['’]s$/, ""); }
  return "";
}

/**
 * THE sentence that says a name is the assistant's and not theirs — the one helper every prompt that
 * shows the nickname uses (src/memorynote.js PROFILE_READERS). "" when there is nothing to say: no
 * name, "Reason", or a name that is their own too.
 */
export function assistantNameLine(nick, theirName = "") {
  const n = String(nick ?? "").trim();
  const own = String(theirName ?? "").trim();
  if (!n || n.toLowerCase() === DEFAULT_CARD_NAME.toLowerCase() || (own && n.toLowerCase() === own.toLowerCase())) return "";
  return `They call YOU, their assistant, "${n}": a nickname for you, not their name.${own ? ` Their own name is ${own}.` : ""} Never call them ${n}.`;
}

/** Their own name as the account has it, or "" (never a stand-in). */
export function theirOwnName(conversationId) {
  try {
    const row = db.getAccount(conversationId);
    const name = row?.name || (row?.is_operator || conversationId === config.ownerConversation ? config.ownerName : "");
    return name && name !== "the person I work for" ? name : "";
  } catch { return ""; }
}

/** Every name this person gave Reason: the one kept on the account, and any their profile gives it. */
export function assistantNicknames(conversationId) {
  const out = new Set();
  const own = theirOwnName(conversationId).toLowerCase();
  const add = (n) => { const x = String(n ?? "").trim(); if (x && x.toLowerCase() !== DEFAULT_CARD_NAME.toLowerCase() && x.toLowerCase() !== own) out.add(x); };
  add(givenName(conversationId));
  try { for (const line of String(db.getProfile(conversationId)?.block ?? "").split("\n")) add(assistantNameIn(line)); } catch { /* no profile */ }
  return [...out];
}

const GREETING = "(?:hey|hi|hiya|hello|yo|ok|okay|alright|morning|good morning|good afternoon|good evening|evening|night|good night|thanks|thank you|sorry)";
// Reason naming itself just before the name: "I'm your assistant, Nimbus", "it's me, Nimbus".
const SELF_BEFORE = /\b(?:i'?m|i am|it'?s|this is|me|assistant|reason|called|call me|go by)\b[^,.!?\n]*$/i;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The last line before a text goes to them: the assistant's nickname used to ADDRESS them is taken
 * out — "Back on the setup, Nimbus:" → "Back on the setup:", "hey Nimbus, …" → "hey, …",
 * "Nimbus, your …" → "Your …". Reason naming itself ("Nimbus here", "it's Nimbus", "— Nimbus") is
 * left alone. `names`: the nicknames (`assistantNicknames`). Returns { text, changed }.
 */
export function withoutNicknameVocative(text, names = []) {
  let out = String(text ?? "");
  const before = out;
  for (const n of names) {
    if (!n) continue;
    const N = `(?<![\\p{L}\\p{N}'’])${esc(n)}(?![\\p{L}\\p{N}'’])`;
    // ", Nimbus:" / ", Nimbus!" / ", Nimbus." / ", Nimbus" at a line's end — not after a dash (a sign-off).
    // "I'm your assistant, Nimbus." names itself: kept.
    out = out.replace(new RegExp(`(?<![—–-]\\s?),\\s*${N}(?=\\s*(?:[:!?.,;)]|$))`, "gimu"), (m, at, all) =>
      SELF_BEFORE.test(all.slice(Math.max(0, all.lastIndexOf("\n", at) + 1, at - 60), at)) ? m : "");
    // "hey Nimbus, …" / "thanks Nimbus!" → "hey, …" / "thanks!"
    out = out.replace(new RegExp(`(^|[\\n.!?]\\s*)(${GREETING})\\s+${N}(?=\\s*(?:[,:!?.;—–-]|$))`, "gimu"), "$1$2");
    // "Nimbus, your car …" / "Nimbus: …" at the start of a line → "Your car …"
    out = out.replace(new RegExp(`(^|[\\n.!?]\\s+)${N}\\s*[,:]\\s*(\\p{L})?`, "gimu"), (_, lead, c) => `${lead}${c ? (/^\p{Lu}/u.test(n) ? c.toUpperCase() : c) : ""}`);
  }
  return { text: out, changed: out !== before };
}

/** The voice their calls speak in. The one place a per-person pick would be read; today the install's. */
export function callVoiceFor(conversationId) {
  void conversationId;
  return config.gptliveVoice;
}

/** How the voice should sound in a texted note: the live call's own direction (src/calls/gptlive.js), for a note. */
export const NOTE_STYLE = "A young woman with a light, natural British (London) accent — warm, quick, relaxed, like a friend leaving a quick voice note.";

/**
 * Which voice a texted voice note is spoken in for this person, or null for the install's default
 * (src/voice.js). `{ provider: "openai", model, voice, instructions, fallbackVoice }` — the call's
 * voice on the call's provider — or, with no OpenAI key, `{ provider: "gemini", voice }`: the closest.
 */
export function noteVoiceFor(conversationId) {
  if (!oneIdentityFor(conversationId)) return null;
  if (config.openaiKey) {
    return { provider: "openai", model: config.openerTtsModel, voice: callVoiceFor(conversationId), instructions: NOTE_STYLE, fallbackVoice: config.ttsCloseVoice };
  }
  return { provider: "gemini", voice: config.ttsCloseVoice };
}
