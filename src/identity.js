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
  try { n = String(db.getAccount(conversationId)?.contact_card_name ?? "").trim(); } catch { return ""; }
  return n && n.toLowerCase() !== DEFAULT_CARD_NAME.toLowerCase() ? n : "";
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
  const name = cardName(typed);
  const set = db.setContactCardName(conversationId, name);
  if (!set) return { ok: false, error: "Nothing was saved: there is no account here to keep it on." };
  return { ok: true, name, was, used: oneIdentityFor(conversationId) };
}

/** The heading the name rides under, the same words on every surface. */
export const IDENTITY_HEADING = "WHO YOU ARE TO THEM:";

/** The line every model that speaks for them reads, or "". */
export function identityNote(conversationId) {
  if (!oneIdentityFor(conversationId)) return "";
  const n = givenName(conversationId);
  if (!n) return "";
  return `${IDENTITY_HEADING} they named you "${n}". With them you are ${n} — the same one in their texts, on the web and on a phone call, with one memory of all of it.`
    + ` Answer to ${n}, and when you say who you are to them, say ${n} (you are still their Reason; "${n}" is your name with them).`
    + ` To anybody else — a business you ring, somebody you message for them — you are "Reason", their assistant, exactly as before.`;
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
