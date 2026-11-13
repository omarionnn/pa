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
//   AFTER THE CALL, BY TEXT. With no passphrase set, or after two wrong ones, the thing waits for the
//   call to end and is picked up in their own text thread, where the ordinary gate asks for its yes
//   on the phone that is really theirs. Until 2026-11-06 a "reply yes" text was sent mid-call and the
//   call waited on it; the owner's rule from the 7-day review is no "reply yes" prompts during a live
//   call, so nothing is texted while the line is open.
//
//   A call REASON PLACED to their own number needs neither: whoever picked up answered the phone that
//   is theirs, which is the same proof a text to it is. Only a call that came IN is checked.
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
import { EVENT_ORGANIZER_TOOLS, EVENT_RIDE_ORGANIZER_TOOLS, EVENT_RIDE_GUEST_TOOLS, EVENT_GUEST_TOOLS, EVENT_ANSWER_TOOLS } from "../eventtools.js";
import { ALBUM_ORGANIZER_TOOLS, ALBUM_MEMBER_TOOLS } from "../albumtools.js";
import { config, clock } from "../config.js";

/** How many wrong passphrases before the call is pushed to the texted check. */
export const MAX_PASSPHRASE_TRIES = 2;

/** The tools that need the person on an owner call to be verified before they run. */
export function isConsequential(name, input = null, { toSelf = () => false } = {}) {
  // A text to their own phone is not "a text to somebody else" (call 67, 2026-11-01: "text me the
  // options" on his own call was held for a check that texted the same phone). Whoever is holding
  // this phone, the words land with the owner, so there is nothing for a voice to authorize.
  if (SELF_SENDS.has(name) && input && toSelf(input.to)) return false;
  return GATED_ACTIONS.has(name) || name === "confirm_record" || CHANGES_THE_GATE.has(name) || eventWrite(name, input);
}

/**
 * An event organizer's tools reach the guests: a cancel, a change, a released detail or a removal is
 * texted to them, and the rest change what guests or strangers see. Only event_blast and
 * event_schedule are in GATED_ACTIONS (they need a yes to exact words in a text too), so the others
 * slipped past this check and a voice spoofing an organizer's number could cancel the event and text
 * every guest (security audit run 2, lead R2-G). A guest's ride tool is on the same footing: it
 * passes free text to their ride partner, swaps phone numbers, and tells the organizer.
 *
 * A guest's own writes too (R2-G leftover): joining an event (Reason texts the welcome and they show
 * on its guest list), their name or Instagram on a who's-going list other guests read, muting an
 * event's updates, signing their browsers out, and photos put into an album as "Shared by" them. A
 * voice spoofing their number must not do any of that as them.
 *
 * Derived from the tool lists themselves, so a new organizer, guest, ride or album tool needs the
 * check on a call until it is named here as a read. event_create is the one write not on it: a new
 * event reaches nobody until somebody joins it, and everything an organizer then does is covered.
 */
const EVENT_READS = {
  event_guests: () => true,
  event_list: () => true,
  event_lookup: () => true,
  event_info: () => true,
  album_info: () => true,
  event_scheduled: (input) => input?.action === "list",
  event_questions: (input) => input?.action === "list",
  event_cover: (input) => input?.action === "status",
  event_rides_setting: (input) => input != null && input.enabled === undefined,
  event_ride: (input) => input?.action === "neither",
  album_manage: (input) => input?.action === "status",
};
// event_leave: it ends their ride offers, which texts the ride partner and sends new matches.
// The album's organizer tool releases it (texting every checked-in guest) and checks guests in or out;
// album_remove lets an organizer delete any guest's photo, which cannot be undone.
const REACHES_GUESTS = new Set([
  ...EVENT_ORGANIZER_TOOLS, ...EVENT_RIDE_ORGANIZER_TOOLS, ...EVENT_RIDE_GUEST_TOOLS,
  ...EVENT_GUEST_TOOLS, ...EVENT_ANSWER_TOOLS, ...ALBUM_ORGANIZER_TOOLS, ...ALBUM_MEMBER_TOOLS,
]);
function eventWrite(name, input) {
  if (!REACHES_GUESTS.has(name)) return false;
  return !(EVENT_READS[name]?.(input) ?? false);
}
/** An event or album write that reaches guests (for the call-trust levels, ./calltrust.js). */
export const reachesGuests = (name, input = null) => eventWrite(name, input);

/**
 * What changes the gate itself rather than passing through it: a standing permission skips later yeses,
 * and a spending limit decides what needs one. A voice on a caller-ID-only call must never set either
 * (security audit 2026-11-06, lead 11), so these wait for the check like anything consequential.
 */
// call_hours_set: it moves or removes the no-call hours every later call of theirs is held by, so a voice
// on a spoofed number must not be able to switch them off.
const CHANGES_THE_GATE = new Set(["permission_grant", "caps_set", "spend_limit_set", "spend_limit_confirm", "call_hours_set"]);

/** Sends whose `to` may be the owner themself: those are not gated when it is. */
const SELF_SENDS = new Set(["message_send"]);

/** Has the person on this call passed the second check? Read off the row, never off a turn. */
export function isVerified(call) {
  if (call?.verified_at) return true;
  // Reason rang their own number: the phone that answered is theirs (owner, 2026-11-06).
  return Boolean(call?.is_owner) && String(call?.direction ?? "out") !== "in";
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
    + " with the passphrase they said, if they have one; without one, call it with `about` set to what they asked,"
    + " and that thing is picked up by text after the call — nothing is texted while you are on the line. Never say"
    + " what the passphrase is, never hint at it, and never tell them the check passed unless this tool says so.",
  input_schema: {
    type: "object",
    properties: {
      passphrase: { type: "string", description: "The passphrase exactly as they said it. Leave it out when they have none: the thing then waits for a text after the call." },
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
    ? `you need their passphrase, said out loud, first: call verify_caller with it. Once, for the whole call.`
      + ` Treat it as the small ordinary thing it is — "one sec, just need your passphrase for that" — never as suspicion.`
    : `it waits for the call to end: call verify_caller with \`about\` set to what they asked, say in one line that you'll`
      + ` pick it up by text as soon as you hang up, and carry on. Never ask them to reply to a text while you are on the call.`;
  return `--- one check, on anything consequential ---\n`
    + `This call came from their number, which tells you whose Reason to be. It does NOT tell you who is holding`
    + ` the phone. So ordinary conversation is exactly as it always is — talk, remember, look things up, answer.`
    + ` But when they ask for something that spends money, books something, sends a message to somebody`
    + ` else, or changes something, ${how}`
    + ` Never mention any of this to someone who has not asked for anything like that.`;
}

/**
 * The refusal a consequential tool gets before the check has passed. Handed to the model as the
 * tool's result, so the next thing said is the ask rather than the thing.
 */
export function gateRefusal({ call, name, input = null, expected = config.callPassphrase, log = () => {} }) {
  // With no passphrase to ask for, the refused thing is queued for after the call right here, so "I'll text
  // you to confirm" is true whatever the model does next (the after-call turn asks for its yes in their
  // own thread, src/calls/postcall.js).
  const queued = deferredOnly(call, { expected }) && queueForAfter(call, describeAsk(name, input), { log });
  const how = !deferredOnly(call, { expected })
    ? `Ask them for their passphrase, then call verify_caller with what they say. Say plainly that this is a one-time check for anything that spends, books or sends.`
    : queued
      ? `It waits for the call to end and is already queued for a text: say warmly, in one line, that you'll text them to confirm it as soon as you hang up. Never leave this unsaid, and do not ask them to reply to anything while you are on the call.`
      : `It waits for the call to end: call verify_caller with \`about\` set to what they asked, and say warmly in one line that you'll text them to confirm it as soon as you hang up. Do not ask them to reply to anything while you are on the call.`;
  return {
    ok: false, blocked: "needs_verification", tool: name, queued: Boolean(queued),
    say: `Not on this call. ${name} is the kind of thing a voice alone cannot authorize. ${how} Do not run ${name} now.`,
    call_id: call?.id ?? null,
  };
}

/** What was asked for, in a line the after-call turn can read back: the caller's own words quoted, short. */
export function describeAsk(name, input = null) {
  const q = (v, n = 120) => {
    const t = String(v ?? "").replace(/\s+/g, " ").replace(/"/g, "'").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const i = input && typeof input === "object" ? input : {};
  const to = i.to ?? i.recipient ?? i.number ?? i.name ?? "";
  const words = i.text ?? i.message ?? i.body ?? i.subject ?? i.query ?? i.item ?? i.title ?? "";
  const what = String(name ?? "").replace(/_/g, " ");
  return `${what}${to ? ` to ${q(to, 60)}` : ""}${words ? ` (caller said: "${q(words)}")` : ""}`;
}

/**
 * Add one refused thing to this call's after-call queue (calls.verify_deferred): every refusal on the call
 * is kept, none overwrites another. Returns true when it is on the row.
 */
export function queueForAfter(call, what, { log = () => {} } = {}) {
  const line = String(what ?? "").trim();
  if (!call?.id || !line) return false;
  try {
    const have = String(db.getCall(call.conversation_id, call.id)?.verify_deferred ?? call.verify_deferred ?? "").trim();
    const parts = have ? have.split("; ") : [];
    if (!parts.includes(line)) parts.push(line);
    const next = parts.join("; ").slice(0, 600);
    const row = db.updateCall(call.conversation_id, call.id, { verify_deferred: next });
    if (row) Object.assign(call, { verify_deferred: row.verify_deferred });
    log({ call_verify_queued: call.id, items: parts.length });
    return Boolean(row?.verify_deferred);
  } catch { return false; }
}

/** No passphrase to ask for on this call (none set, or its tries are spent): only the texted check is left. */
export function deferredOnly(call, { expected = config.callPassphrase } = {}) {
  return !(passphraseSet({ expected }) && Number(call?.verify_tries ?? 0) < MAX_PASSPHRASE_TRIES);
}

/**
 * Run the check. `tell` and `messages` are still accepted from the voice turn and no longer used:
 * nothing is texted mid-call any more, so there is no texted answer to read.
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
        : `That's not it either, and that was the last try by voice. Say you will pick it up by text as soon as you hang up, and call verify_caller with nothing but \`about\` in it.`,
    };
  }

  // No passphrase to check (none set, or the tries ran out): the thing waits for the call to end.
  // Nothing is texted while the line is open (owner, 2026-11-06: no "reply yes" during a live call).
  // It is written on the row, and the after-call turn (src/calls/postcall.js ownerEvent) picks it
  // up in their own thread, where the ordinary gate asks on the phone that is theirs.
  const what = String(about ?? "").trim().slice(0, 300);
  if (what) queueForAfter(call, what, { log });
  log({ call_verify_deferred: call.id, said_passphrase: !!said });
  return {
    ok: false, verified: false, blocked: "after_the_call", deferred: what || null,
    say: `That one can't be done on this call. Say in one line that you'll pick it up by text as soon as you hang up —`
      + ` nothing for them to do now — and carry on with the call. Do not do it on the call.`,
  };
}

