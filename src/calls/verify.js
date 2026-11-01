// The second check on an owner call: caller ID says whose Reason to be, not who is on the phone.
//
// From the 2026-10-07 addendum, section 6. The plan said "caller ID = identity, for now" and filed
// spoofing in docs/unverified.md. The owner's own prompt is stricter, and this is it built rather
// than documented: ordinary conversation on his number stays exactly as it was, and anything
// CONSEQUENTIAL — money, a booking, a text to somebody else, a change of state — needs one more
// thing first. Two things can be that one more thing:
//
//   A SPOKEN PASSPHRASE (`REASON_CALL_PASSPHRASE`). He says it; code compares it. It is never in
//   the prompt, never read back and never confirmed character by character — a wrong one gets "that's
//   not it", not a hint. Two wrong tries and the call falls to the texted check, so a voice that is
//   guessing gets at most two guesses and then has to be holding his phone as well.
//
//   A TEXTED YES. With no passphrase set, or after two wrong ones, Reason texts the owner's own
//   number what it is about to do, on the ordinary channel, and the yes has to come back THERE. A
//   caller who is not holding that phone cannot answer it. The yes is read off the thread the same
//   way the ordinary gate reads one: only a message that arrived after the ask counts.
//
// One check per call, not per action. Once the person on this call is verified, the ordinary
// confirm gate still asks for its yes on every gated action exactly as before — this is in front of
// that gate, not instead of it — and a spoken yes is taken by that gate only when it is tied to the
// scope that was read back, which is what the gate's `target` already does.
//
// What is consequential is decided here from the same list the permission system is built on
// (`GATED_ACTIONS`): a tool that needs a yes in a text is a tool that needs the second check on a
// call. `confirm_record` is on top of that list, because it is how a spoken yes becomes a granted
// confirmation — the thing that must not be grantable by whoever happens to be on the line.
import { timingSafeEqual } from "node:crypto";
import * as db from "../db.js";
import { GATED_ACTIONS } from "../permissions.js";
import { config, clock } from "../config.js";

/** How many wrong passphrases before the call is pushed to the texted check. */
export const MAX_PASSPHRASE_TRIES = 2;

/** The tools that need the person on an owner call to be verified before they run. */
export function isConsequential(name, input = null, { toSelf = () => false } = {}) {
  // A text to their own phone is not "a text to somebody else" (call 67, 2026-11-01: "text me the
  // options" on his own call was held for a check that texted the same phone). Whoever is holding
  // this phone, the words land with the owner, so there is nothing for a voice to authorize.
  if (SELF_SENDS.has(name) && input && toSelf(input.to)) return false;
  return GATED_ACTIONS.has(name) || name === "confirm_record";
}

/** Sends whose `to` may be the owner themself: those are not gated when it is. */
const SELF_SENDS = new Set(["message_send"]);

/** Has the person on this call passed the second check? Read off the row, never off a turn. */
export function isVerified(call) {
  return Boolean(call?.verified_at);
}

/**
 * Is a passphrase configured at all? Decides which of the two checks a call gets.
 *
 * Takes the expected value rather than only reading it, for the same reason the provider's own
 * credentials are read through a getter: a test that states the setting and a process that read it
 * out of `.env` should go down the same code path. Nothing passes it in production.
 */
export const passphraseSet = ({ expected = config.callPassphrase } = {}) => Boolean(String(expected ?? "").trim());

/**
 * What a spoken passphrase is compared as: lower case, letters and digits only. "Blue Heron 7",
 * "blue heron seven"? No — digits are not turned into words or back; the passphrase is what he
 * SAYS, and a transcript of it is letters and digits with the punctuation gone.
 */
function normalized(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Constant-time comparison of the normalized forms; a mismatch in length is still a full compare. */
export function passphraseMatches(spoken, { expected = config.callPassphrase } = {}) {
  const a = Buffer.from(normalized(spoken));
  const b = Buffer.from(normalized(expected));
  if (!b.length) return false;
  if (a.length !== b.length) {
    // Compare anyway so the time taken does not say whether the length was right.
    timingSafeEqual(Buffer.alloc(b.length), b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** The platform tool the model is offered on an owner call to do the check. */
export const VERIFY_TOOL = {
  name: "verify_caller",
  description: "Before anything that spends money, books, sends to somebody else or changes something, the person on"
    + " this call has to pass one more check — a voice alone is not proof of who is holding the phone. Call this"
    + " with the passphrase they said, if they have one; call it with nothing to send a yes/no to their own"
    + " phone instead, and again once they say they have answered it. Never say what the passphrase is, never"
    + " hint at it, and never tell them the check passed unless this tool says so.",
  input_schema: {
    type: "object",
    properties: {
      passphrase: { type: "string", description: "The passphrase exactly as they said it. Leave it out to use the texted check." },
      about: { type: "string", description: "One short phrase: what they asked for that needs the check ('ring the cleaners and book')." },
    },
  },
};

/**
 * The rule in the owner's own call frame, so the model knows it before a refusal teaches it.
 *
 * Nothing in here is the check — code does the check — and nothing in here is the passphrase. It is
 * one paragraph about what kind of request needs one more step, said in the direction the model will
 * have to say it: this is ordinary and quick, not an accusation.
 *
 * Empty once the call is verified. A rule about a check that has already passed is a prompt telling
 * the model to go and ask for something it has.
 */
export function promptNote({ call, expected = config.callPassphrase } = {}) {
  if (isVerified(call)) return "";
  const how = passphraseSet({ expected })
    ? `their passphrase, said out loud`
    : `a yes to a message I send to their own phone`;
  return `--- one check, on anything consequential ---\n`
    + `This call came from their number, which tells you whose Reason to be. It does NOT tell you who is holding`
    + ` the phone. So ordinary conversation is exactly as it always is — talk, remember, look things up, answer.`
    + ` But the first time they ask for something that spends money, books something, sends a message to somebody`
    + ` else, or changes something, you need ${how} first: call verify_caller. Once, for the whole call.`
    + ` Treat it as the small ordinary thing it is — "one sec, just need your passphrase for that" — never as`
    + ` suspicion, and never say it to someone who has not asked for anything like that.`;
}

/**
 * The refusal a consequential tool gets before the check has passed. Handed to the model as the
 * tool's result, so the next thing said is the ask rather than the thing.
 */
export function gateRefusal({ call, name, expected = config.callPassphrase }) {
  const how = passphraseSet({ expected })
    ? `Ask them for their passphrase, then call verify_caller with what they say.`
    : `Call verify_caller with nothing in it: it texts their own phone a yes/no, and the yes has to come from there.`;
  return {
    ok: false, blocked: "needs_verification", tool: name,
    say: `Not yet. ${name} is the kind of thing a voice alone cannot authorize on a call. ${how}`
      + ` Say plainly that this is a one-time check for anything that spends, books or sends, and do not run ${name} until it passes.`,
    call_id: call?.id ?? null,
  };
}

/**
 * Run the check. `tell` is how a text leaves during the call (voice.js's `queueMidCall`), injected
 * so this file never imports the turn; `messages` is the owner's thread as the turn sees it, which
 * is where a texted yes arrives.
 */
export function verify({
  call, passphrase = "", about = "", tell = () => false, messages = [],
  expected = config.callPassphrase, now = clock.now(), log = () => {},
} = {}) {
  if (!call?.id) return { ok: false, error: "no call to verify" };
  if (isVerified(call)) {
    return { ok: true, verified: true, already: true, how: call.verified_how, say: `They are already verified on this call. Carry on with what they asked.` };
  }

  const said = String(passphrase ?? "").trim();
  const tries = Number(call.verify_tries ?? 0);

  if (said && passphraseSet({ expected }) && tries < MAX_PASSPHRASE_TRIES) {
    if (passphraseMatches(said, { expected })) {
      const row = db.updateCall(call.conversation_id, call.id, { verified_at: now, verified_how: "passphrase" });
      log({ call_verified: call.id, how: "passphrase" });
      return { ok: true, verified: true, how: "passphrase", call: row, say: `Verified. Carry on with what they asked, and do not mention the passphrase again.` };
    }
    const left = MAX_PASSPHRASE_TRIES - tries - 1;
    db.updateCall(call.conversation_id, call.id, { verify_tries: tries + 1 });
    log({ call_verify_wrong: call.id, tries: tries + 1 });
    return {
      ok: false, verified: false, blocked: "wrong_passphrase", tries_left: left,
      say: left > 0
        ? `That's not it. Say so plainly, and ask once more. Do not say what it should have been or how close it was.`
        : `That's not it either, and that was the last try by voice. Say you will text their phone instead, and call verify_caller with nothing in it.`,
    };
  }

  if (said && !passphraseSet({ expected })) {
    log({ call_verify_no_passphrase: call.id });
    // No hint that nothing is set up: to the person on the line this is the same as a wrong one,
    // and the texted check is what happens next either way.
    return {
      ok: false, verified: false, blocked: "no_passphrase_configured",
      say: `A passphrase cannot be checked on this install. Say you will text their phone a yes/no instead, and call verify_caller with nothing in it.`,
    };
  }

  // The texted check. First time: send it and wait. After: look for the yes, and only in a message
  // that arrived after the text went.
  const ownerTexts = (messages ?? []).filter(m => m?.role === "user").length;
  if (!call.verify_sent_at) {
    // The one place a word is named on purpose (exception to the no-phrases copy rule, 2026-10-26):
    // a security check read by exact match in code (readYesNo), so it must say what counts.
    const sent = tell(`On the phone with you now — reply "yes" to confirm what was just asked. Anything else and I won't do it.`);
    if (!sent) {
      log({ call_verify_text_failed: call.id });
      return {
        ok: false, verified: false, blocked: "cannot_text",
        say: `The text could not be sent, so there is no way to run the check on this call. Say that plainly: this one has to wait until you can text them, and do not do the thing.`,
      };
    }
    db.updateCall(call.conversation_id, call.id, { verify_sent_at: now, verify_sent_after_msgs: ownerTexts });
    log({ call_verify_texted: call.id });
    return {
      ok: false, verified: false, waiting: true,
      say: `A yes/no has been texted to their own phone. Tell them to answer it there — not out loud — and call verify_caller again, with nothing in it, once they say they have.`,
    };
  }

  const sentAfter = Number(call.verify_sent_after_msgs ?? 0);
  const since = (messages ?? []).filter(m => m?.role === "user").slice(sentAfter)
    .map(m => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join(" ") : "")
    .map(s => String(s ?? "").replace(/^\[[^\]]*\]\s*[^:]*:\s*/, "").trim())
    .filter(Boolean);
  const answer = since.map(readYesNo).find(a => a !== "unclear");
  if (answer === "yes") {
    const row = db.updateCall(call.conversation_id, call.id, { verified_at: now, verified_how: "text" });
    log({ call_verified: call.id, how: "text" });
    return { ok: true, verified: true, how: "text", call: row, say: `Verified — they answered yes by text. Carry on with what they asked.` };
  }
  if (answer === "no") {
    log({ call_verify_refused: call.id });
    return { ok: false, verified: false, blocked: "refused_by_text", say: `They answered no by text. Do not do it. Say you have left it, and carry on with anything else.` };
  }
  return {
    ok: false, verified: false, waiting: true,
    say: since.length
      ? `Their text was not a plain yes or no, so it does not count. Ask them to reply with just "yes" or "no", and check again.`
      : `No answer by text yet. Tell them it is waiting on their phone, and call verify_caller again when they say they have answered.`,
  };
}

/**
 * What a texted answer to the check means. Deliberately narrow and failing closed: a check that
 * exists because a voice is not proof is not a check that should take "I guess" as a yes. Anything
 * that is not plainly one or the other is "unclear", and the person is asked for the one word.
 */
export function readYesNo(text) {
  const t = String(text ?? "").toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "unclear";
  if (/^(yes|yeah|yep|yup|ya|go ahead|do it|go for it|ok|okay|sure|confirmed|confirm|yes please|yes do it|yes go ahead)$/.test(t)) return "yes";
  if (/^(no|nope|nah|don't|do not|stop|cancel|no thanks|no don't)$/.test(t)) return "no";
  return "unclear";
}
