// How Reason comes across to everybody who is not the person it works for.
//
// Reason talks to its person like a sharp friend: short lines, lowercase, slang, a joke when it
// fits. That voice is right in their thread and wrong everywhere else. An email to a landlord, a
// text to a contractor, a form filled in at a clinic — those are read by somebody who is deciding
// what to think about the PERSON, not about the assistant, and a lowercase line with a 🔥 in it is
// a judgment about them that they did not get to make.
//
// Two halves, and they are deliberately different kinds of thing:
//
//   the prompt   clear, polite, properly capitalized, no slang, no emoji, only the details the
//                message needs. Judgment, so it lives with the model (src/agent.js).
//   this file    two facts about the text that code can check without reading anybody's intent —
//                is there an emoji in it, and does it say whose assistant is writing. Both are
//                questions about characters in a string, which is why they are allowed to be
//                mechanical. Neither is a guess about tone.
//
// And one list: the people for whom Reason does not send at all. See `draftOnly`.
import { config, normalizeNumber } from "./config.js";

// Emoji, by Unicode's own property, rather than by a list somebody has to keep adding to. The three
// exceptions are the characters that are technically pictographic and are not emoji in any sense a
// person would mean: a copyright line at the bottom of a signature is not a 🔥.
const PICTOGRAPHIC = /\p{Extended_Pictographic}/gu;
const NOT_REALLY_EMOJI = new Set(["©", "®", "™"]);

/** Every emoji in a string, deduplicated, in the order they appear. */
export function emojiIn(text) {
  const found = [];
  for (const m of String(text ?? "").matchAll(PICTOGRAPHIC)) {
    if (NOT_REALLY_EMOJI.has(m[0]) || found.includes(m[0])) continue;
    found.push(m[0]);
  }
  return found;
}

/** The signature a third party has to be able to read off the message. */
export const signature = (ownerName) => `${ownerName}'s assistant, Reason`;

const named = (ownerName) => !!ownerName && ownerName !== "the person I work for";

/**
 * Does this text say whose assistant wrote it?
 *
 * Two things have to be in there: that it is this person's assistant, and that the assistant is
 * called Reason. Both, because each on its own leaves the reader somewhere worse than not knowing —
 * "Omari's assistant" with no name reads like a human employee, and "Reason" with no owner reads
 * like a stranger. With no name saved for the person yet, the first half cannot be checked and the
 * word assistant is what is required instead.
 */
export function saysWhoseAssistant(text, ownerName = config.ownerName) {
  const t = String(text ?? "").toLowerCase();
  const owner = named(ownerName)
    ? new RegExp(`${ownerName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['’\`]?s\\s+assistant`).test(t)
    : /\bassistant\b/.test(t);
  return owner && /\breason\b/.test(t);
}

// What has to happen after the words change, and it is not a complication — it is the confirm gate
// working. A yes covers the exact words the person was shown, so a body that has been rewritten is a
// body they have not seen. Their yes is still unspent (a tool that refuses never spends one), and it
// is a yes for the old wording, which is why the new wording has to be asked about.
const AGAIN = " If they had already said yes to the old wording, that yes was for those words:"
  + " show them the new version and ask again, which the gate will make you do anyway.";

/**
 * The two checks, on anything a third party will read. `{ ok: true }` or a refusal to hand back.
 *
 * `exactly` is the one way past them: the person said to send it exactly like that, and the model
 * passes their words through. It is not verified — nothing here can see their message — so it is
 * recorded on the receipt as the reason the rules were skipped and listed in docs/unverified.md.
 * Being overridable by the person it protects is the point; being overridable silently is not.
 */
export function checkOutgoing({ text, ownerName = config.ownerName, what = "message", exactly = "" } = {}) {
  if (String(exactly ?? "").trim()) {
    return {
      ok: true, sent_exactly_as_asked: String(exactly).trim(),
      note: `Sent word for word because they said so ("${String(exactly).trim()}"), so the usual rules about emoji and signing off were not applied. That is on the receipt.`,
    };
  }
  const emoji = emojiIn(text);
  if (emoji.length) {
    return {
      ok: false, blocked: "emoji_in_an_outside_message", found: emoji,
      error: `That ${what} has ${emoji.join(" ")} in it and it is going to somebody who is not ${ownerName}.`
        + ` Nothing was sent. Anything a third party reads is a judgment they make about ${ownerName}, so it goes out clear, polite,`
        + ` properly capitalized and with no emoji in it. Write it again that way.${AGAIN}`
        + ` If ${ownerName} specifically told you to send it exactly as it is, pass their words in exactly_as_asked and it will go.`,
    };
  }
  if (!saysWhoseAssistant(text, ownerName)) {
    return {
      ok: false, blocked: "no_assistant_line",
      error: `That ${what} does not say who is writing it, and it is going to somebody who is not ${ownerName}.`
        + ` Nothing was sent. You are never ${ownerName} and you are not a person: say so in the ${what}, plainly —`
        + ` "${signature(ownerName)}" — so whoever reads it knows what they are replying to. Add that.${AGAIN}`
        + ` If ${ownerName} specifically told you to send it exactly as it is, pass their words in exactly_as_asked and it will go.`,
    };
  }
  return { ok: true };
}

// ---------- the people Reason does not write to ----------
//
// Some people are not a message to get right, they are a message to not send. A note to somebody's
// mother, their boss, an investor, their landlord or their doctor is theirs to send: the cost of
// Reason getting the tone slightly wrong is not a bad email, it is a relationship.
//
// So those people go on a list, and for anybody on it Reason writes the draft and hands it over.
// The person presses send. That is the whole mechanism — no scoring, no confidence threshold.

/**
 * How a saved contact or a recipient is compared: a number as its digits, an address as itself.
 *
 * `Mum <mum@example.com>` is unwrapped to the address first, because that is a shape a recipient
 * really arrives in and comparing the whole string would miss the one person the list is for.
 */
export function contactKey(contact) {
  const raw = String(contact ?? "").trim();
  const angled = raw.match(/<([^>]+)>\s*$/);
  const c = (angled ? angled[1] : raw).trim().toLowerCase();
  if (!c) return "";
  if (c.includes("@")) return c;
  return normalizeNumber(c) || c;
}

/** The subject of a list entry, so "Mum", "mum" and " Mum " are one person. */
export const whoKey = (who) => String(who ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Is this recipient on the draft-only list? Returns the entry, or null.
 *
 * Matched on what is actually comparable, and nothing is inferred from a name alone beyond one
 * narrow case: a saved contact (a number or an address), or an email whose local part IS their name
 * — `mum@example.com` for "Mum". A name appearing anywhere inside an address is deliberately NOT a
 * match: "dad" inside "dadaist@gallery.com" would quietly stop a message to a stranger, and a list
 * that blocks the wrong people gets turned off.
 *
 * The honest consequence is that an entry with no contact saved protects nothing by itself, and
 * `important_list` says so per entry rather than letting somebody believe otherwise.
 */
export function draftOnly(entries, recipients = []) {
  const want = recipients.map(contactKey).filter(Boolean);
  const locals = want
    .filter(r => r.includes("@"))
    .map(r => r.split("@")[0].replace(/[._-]+/g, " ").trim());
  for (const e of entries) {
    const saved = (e.contacts ?? []).map(contactKey).filter(Boolean);
    if (saved.some(s => want.includes(s))) return { entry: e, matched: "a contact they gave you" };
    if (locals.includes(whoKey(e.who))) return { entry: e, matched: `the address itself (${e.who})` };
  }
  return null;
}

/** The refusal for a send to somebody on the list, with the draft handed back as a draft. */
export function handOver({ entry, ownerName = config.ownerName, how = "text", text = "", to = "" }) {
  return {
    ok: false, blocked: "draft_only",
    who: entry.who, why: entry.why || null, matched_on: to,
    draft: text,
    error: `${entry.who} is on ${ownerName}'s draft-only list${entry.why ? ` (${entry.why})` : ""}, so Reason does not send to them — they send it themselves.`
      + ` Nothing was sent. Hand the draft over instead: put it in a fenced block, on its own, with nothing of yours inside the fences,`
      + ` and say in one line who it is for and that they should check it and send it.`
      + (how === "email" ? ` Or leave it in their Gmail with gmail_draft, which is usually easier for an email — say which you did.` : "")
      + ` Do not argue the list and do not offer to send it anyway.`,
  };
}
