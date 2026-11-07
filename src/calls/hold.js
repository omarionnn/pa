// Waiting, menus, and the moment a different human picks up the phone.
//
// This is the part of a real call that no platform feature covers, and the owner named it first when
// he listed what matters: "reliable hold handling". So it is worth being exact about what is ours and
// what is theirs, because the temptation is to assume a feature exists.
//
// THE LINE'S (carried out by the voice relay, src/calls/gptlive.js):
//   `skip_turn`                — stay silent and wait, without speaking.
//   `play_keypad_touch_tone`   — DTMF for a phone menu (Twilio <Play digits>).
//   `voicemail_detection`      — a machine picked up (with Twilio's answering-machine verdict).
//
// NOT THE LINE'S, and this is the important half:
//   There is no hold detection and no "they're back" signal. Hold music is AUDIO, so a silence timer
//   may never fire during a hold at all, and the voice may keep handing us turns as though somebody
//   were talking.
//
// So the division of labour is: **Reason judges, code measures.** Reason decides from what it hears
// that this is hold music rather than a person, and says so the only way it can — by answering with
// `skip_turn`, which is the platform's own "wait without speaking". Every consecutive `skip_turn` is
// hold; the first time it speaks instead, hold is over. That is the whole detector, and it has no
// regex in it: nothing here reads the transcript for the word "hold" or listens for music. Code's job
// is the clock and the budget, which is the part a model should not be trusted with because the model
// does not know how long it has been and cannot be asked to count minutes reliably.
//
// The second thing in this file is the one the owner's spec implied without saying. When a
// receptionist puts the call through to somebody else, that somebody has not heard the announcement.
// The disclosure belongs to the PERSON, not to the call. Same shape as the existing per-language
// `announcementOwedIn` in ./voice.js, for the same reason.
import { config, clock } from "../config.js";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { announcementFor } from "./provider.js";

/** Whose Reason a call belongs to, falling back to the install's owner in a test with no account. */
function ownerNameFor(call) {
  try { return accounts.ownerOf(call?.conversation_id)?.name || config.ownerName; }
  catch { return config.ownerName; }
}

/** The line tools this file is the reason for: waiting, menus and machines. */
export const WAITING_TOOLS = [
  {
    name: "skip_turn",
    description: "Say nothing and keep listening. Use this the moment you realise you are on hold — music,"
      + " a repeating recorded message, ringing, a queue position — or when they ask you to hold on."
      + " Do not talk to hold music, and do not fill the silence. Call this again each time you are"
      + " still on hold. The call is being timed for you; you do not have to keep track of how long.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "In a few words, what you are waiting for: 'hold music', 'they said one moment', 'the menu is still reading options'." } },
      required: ["reason"],
    },
  },
  {
    name: "play_keypad_touch_tone",
    description: "Press keys on the phone keypad, for a menu or an extension. Listen to the WHOLE menu before"
      + " pressing anything — the option you want is often last, and pressing early gets the wrong"
      + " department. Digits 0-9, * and #; put 'w' for a half-second pause and 'W' for a full second"
      + " between presses rather than trying to time them yourself. If the menu does not react, send the"
      + " same tone once more before deciding it did not work: some phone systems miss the first one.",
    input_schema: {
      type: "object",
      properties: {
        dtmf_tones: { type: "string", description: "The keys to press, in order: '2', '1w1', '4321#'." },
        reason: { type: "string", description: "Which option this is: 'option 2, bookings'." },
      },
      required: ["dtmf_tones"],
    },
  },
  {
    name: "voicemail_detection",
    description: "A machine answered, not a person — an answering message, a mailbox greeting, a beep."
      + " Call this once the greeting has finished asking for a message, not in the middle of it. You"
      + " will then be told how to leave the one message; the call ends after it, and you will never be"
      + " asked to call this number back to leave another.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "What made it clear: 'recorded greeting, then a beep'." } },
      required: ["reason"],
    },
  },
];

/** Reason's own tool for the one thing nothing on the platform signals: somebody else is on the line. */
export const NEW_PERSON_TOOL = {
  name: "new_person_on_the_line",
  description: "A DIFFERENT person is now speaking — you were put through, transferred, handed over, or"
    + " somebody came back to the phone who is not who you started with. Call this before you say"
    + " anything to them. They have not heard who you are, so you will be told exactly what to say;"
    + " you do not start the call over and you do not lose anything already agreed.",
  input_schema: {
    type: "object",
    properties: {
      who: { type: "string", description: "Who they seem to be, if you know: 'the catering manager', 'a different receptionist'." },
      same_person_returning: {
        type: "boolean",
        description: "True if this is the SAME person coming back after putting you on hold, rather than a new one."
          + " They have already heard who you are, so nothing gets repeated to them.",
      },
    },
    required: ["who"],
  },
};

/**
 * Reason's own read of a machine that is not a person (2026-10-27, call 45 to the Strand).
 *
 * There is no signal on the turn itself that a recording is speaking: their `voicemail_detection` is
 * a model's judgement as well, and Twilio's carrier-level AMD (`twilio_machine_detection` on the
 * outbound-call request) arrives as a separate webhook event at any point in the call — even after it
 * — so it cannot decide what the next spoken word is, and it costs extra per call. The model hearing
 * the words is the only thing placed to tell "Strand Books, how can I help?" from "our flagship store
 * is open every day…". So it says which it is, and code does the rest: the row, the hang-up on a dead
 * end, and keeping every word off the line until a person is there.
 */
export const MACHINE_TOOL = {
  name: "machine_on_the_line",
  description: "What answered is a recording or a machine, not a person: a phone menu, a recorded message"
    + " (hours, an announcement), a voicemail greeting, a mailbox that is full or not taking messages, or"
    + " hold music / a queue. Call this as soon as you can tell, INSTEAD of speaking — nobody is listening."
    + " Call it again if what you hear changes (a menu hands you to a mailbox, a recording turns into hold"
    + " music). Never say anything to a machine except to leave a voicemail when told how.",
  input_schema: {
    type: "object",
    properties: {
      what: {
        type: "string",
        enum: ["phone_menu", "recorded_message", "voicemail_greeting", "mailbox_not_taking_messages", "hold_or_queue"],
        description: "phone_menu: it offers options or asks for an extension. recorded_message: an announcement with no"
          + " options. voicemail_greeting: a mailbox inviting you to leave a message. mailbox_not_taking_messages: a mailbox"
          + " that is full, unavailable or not accepting messages. hold_or_queue: music, 'please hold', a queue position.",
      },
      dead_end: {
        type: "boolean",
        description: "True only if the recording itself says nobody can be reached by phone this way — they do not take"
          + " phone inquiries, they are closed for good, the number is not in service — AND it offers no option for a person.",
      },
      heard: {
        type: "string",
        description: "In one or two short sentences, what it said that the person you work for can use: another way to"
          + " reach them (an email address, a website), opening hours, why nobody can take the call. Empty if nothing.",
      },
    },
    required: ["what"],
  },
};

/** The `what` values above, mapped to the outcome the row carries while (and if) the call ends on it. */
const MACHINE_OUTCOME = {
  phone_menu: "machine_menu",
  recorded_message: "machine_recording",
  hold_or_queue: "machine_recording",
  mailbox_not_taking_messages: "voicemail_full",
};

/**
 * A machine answered, as Reason read it. Writes it on the row and says what happens next:
 *
 *   `{endNow: true}` — a dead end or a mailbox that takes nothing. Code hangs up at once, without a
 *                      word: talking into a recording that has just said nobody is there is the thing
 *                      call 45 did, and waiting for a timeout is a minute of billing for nothing.
 *   otherwise        — an instruction for the model: stay quiet and press, wait, or leave a message.
 *
 * A voicemail greeting goes through `noteMachine`, the existing voicemail path, unchanged.
 */
export function noteMachineLine(call, { what = "", deadEnd = false, heard = "", log = () => {} } = {}) {
  const said = String(heard ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  // What it said is kept even when the next thing it says is different: the menu that read out an
  // email address is still the place the email address came from.
  const keep = said ? { machine_heard: said } : {};
  log({ call_machine: call?.id, what, dead_end: deadEnd === true, heard_chars: said.length });

  // A person already settled something on this call — answered, confirmed, paused for the owner — and
  // a handover then reached a machine. What the person did stands: the row is not rewritten as "no
  // person was reached", which would also make an agreed booking look safe to ring back and make again.
  const kindNow = String(call?.outcome_kind ?? "");
  if (kindNow && !["machine_menu", "machine_recording", "voicemail_no_message"].includes(kindNow)) {
    patch(call, keep);
    // Put through to a mailbox or a dead end: done. Put on hold or through to a menu: the rest of the
    // errand may still be on the other side of it, so wait or press like any other.
    if (deadEnd === true || what === "mailbox_not_taking_messages" || what === "voicemail_greeting") {
      return { ok: true, machine: true, endNow: true, kind: kindNow };
    }
    return {
      ok: true, machine: true, kind: kindNow,
      instruction: `Nobody is listening, so say nothing to it. Press the option for a person if one fits, or call skip_turn and keep listening.`,
    };
  }

  if (what === "voicemail_greeting") {
    patch(call, keep);
    return noteMachine(call, { reason: said || "voicemail greeting", log });
  }
  if (deadEnd === true || what === "mailbox_not_taking_messages") {
    const kind = what === "mailbox_not_taking_messages" ? "voicemail_full" : "machine_dead_end";
    patch(call, {
      ...keep, voicemail_left: 0, hold_since: null, outcome_kind: kind,
      outcome: kind === "voicemail_full" ? "a mailbox answered and is not taking messages" : "a recording said nobody can be reached by phone this way",
    });
    return { ok: true, machine: true, endNow: true, kind };
  }
  const kind = MACHINE_OUTCOME[what] ?? "machine_recording";
  patch(call, { ...keep, outcome_kind: kind, outcome: kind === "machine_menu" ? "a phone menu answered; no person yet" : "a recording answered; no person yet" });
  return {
    ok: true, machine: true, kind,
    instruction: kind === "machine_menu"
      ? `Nobody is listening, so say nothing to it. If you have heard an option that fits what this call is for, or one`
        + ` for a person (operator, reception, "any other enquiry", 0), press it now with play_keypad_touch_tone. If it`
        + ` asks for an extension you were not given and offers nothing that fits, press 0 once. If it is still reading`
        + ` its options, call skip_turn and keep listening. When a person comes on, just talk to them: who you are is`
        + ` said for you in front of your first words.`
      : `Nobody is listening, so say nothing to it: call skip_turn and keep listening — a menu or a person usually follows.`
        + ` When a person comes on, just talk to them: who you are is said for you in front of your first words.`,
  };
}

/**
 * The disclosure is owed to whoever is on the line, and nobody has heard it yet.
 *
 * Only on a call whose opening waited for their side (`opening_waits`, written by `call_place` when
 * the provider placed it that way) — a call placed the old way spoke it at pick-up, and saying it twice
 * is how a call stops sounding like a person. And only while nobody has been told: a handover to a new
 * person is `newParty`'s business, which has the model say it.
 */
export function openingOwed(call) {
  return Number(call?.opening_waits) === 1 && Number(call?.is_owner) !== 1
    && currentParty(call) === 1 && partiesTold(call).length === 0 && String(call?.announcement ?? "").trim() !== "";
}

/** A person is on the line after a menu or recording: the row stops saying it was a machine. */
export function notePerson(call, { log = () => {} } = {}) {
  if (!["machine_menu", "machine_recording"].includes(String(call?.outcome_kind ?? ""))) return false;
  patch(call, { outcome_kind: "", outcome: "" });
  log({ call_person_after_machine: call?.id });
  return true;
}

// ---------- the clock ----------

/** Is this call on hold right now? */
export const onHold = (call) => Number(call?.hold_since ?? 0) > 0;

/** Seconds spent on hold on this call, finished holds plus the one in progress. */
export function holdSeconds(call, { now = clock.now() } = {}) {
  const banked = Number(call?.hold_total_s ?? 0) || 0;
  const since = Number(call?.hold_since ?? 0) || 0;
  return since ? banked + Math.max(0, Math.round((now - since) / 1000)) : banked;
}

/** How long this call is allowed to wait in total. The brief's number, or the install default. */
export const holdBudget = (call) => {
  const b = Number(call?.hold_budget_s ?? 0);
  return Number.isFinite(b) && b > 0 ? b : config.callMaxHoldSeconds;
};

/** Seconds of waiting left before the call gives up. Never negative. */
export const holdLeft = (call, { now = clock.now() } = {}) => Math.max(0, holdBudget(call) - holdSeconds(call, { now }));

/**
 * Reason answered with `skip_turn`: it believes it is waiting rather than talking to anybody.
 *
 * Returns what to actually do, which is the one decision code makes here and the model does not:
 *
 *   `{wait: true}`  — forward `skip_turn` to the platform. There is budget left.
 *   `{wait: false}` — the budget is gone. The caller says a polite line and ends the call, with the
 *                     outcome `hold_gave_up` rather than a failure, because waiting five minutes and
 *                     ringing off is a thing that worked exactly as designed.
 *
 * The budget is wall-clock on our side on purpose. It cannot be the platform's `turn_timeout`, which
 * caps at 30 seconds and measures silence that hold music means never arrives.
 */
export function noteWaiting(call, { now = clock.now(), reason = "", log = () => {} } = {}) {
  const started = onHold(call) ? Number(call.hold_since) : now;
  const total = holdSeconds({ ...call, hold_since: started }, { now });
  const budget = holdBudget(call);
  const waits = Number(call?.hold_waits ?? 0) + 1;

  // Written down before the decision, so a call that crashes mid-hold still shows the wait.
  patch(call, { hold_since: started, hold_waits: waits });

  if (total >= budget) {
    // The hold is closed out here rather than left open: the call is about to end, and a row with an
    // open `hold_since` would keep growing every time anybody read it.
    patch(call, { hold_since: null, hold_total_s: total, hold_gave_up: 1 });
    log({ call_hold_gave_up: call.id, seconds: total, budget, waits });
    return {
      wait: false, seconds: total, budget,
      // Said rather than just hung up: somebody is going to come back to that line eventually and
      // find a dead call, and it costs one sentence not to be the assistant that does that.
      line: `Sorry — I've been holding a while and I'm going to have to let you go. I'll try again later. Thanks very much.`,
      why: `waited ${Math.round(total / 60)} min ${total % 60} s, which is the limit on this call (${budget}s).`,
    };
  }
  log({ call_hold_waiting: call.id, seconds: total, budget, waits, reason: reason.slice(0, 60) });
  return { wait: true, seconds: total, budget, left: budget - total };
}

/**
 * Reason spoke instead of waiting, so whatever it was waiting for has happened.
 *
 * Called on every turn that is not a `skip_turn`, which makes "they're back" a side effect of the
 * conversation resuming rather than something that has to be detected. Returns the hold that just
 * ended, when one did, so the caller can tell the model it has been waiting a while — a person coming
 * back after four minutes expects to be met with "no problem at all" and not with a fresh greeting.
 */
export function noteSpeaking(call, { now = clock.now(), log = () => {} } = {}) {
  if (!onHold(call)) return null;
  const total = holdSeconds(call, { now });
  const waited = total - (Number(call?.hold_total_s ?? 0) || 0);
  patch(call, { hold_since: null, hold_total_s: total });
  log({ call_off_hold: call.id, waited, total });
  return { waited, total };
}

// ---------- who has heard the announcement ----------

/** Which parties on this call have been told what they are talking to. */
export function partiesTold(call) {
  try {
    const v = JSON.parse(call?.parties_told ?? "[]");
    return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
  } catch { return []; }
}

/** Which party is on the line now. 1 is whoever answered. */
export const currentParty = (call) => Math.max(1, Number(call?.party_n ?? 1) || 1);

/**
 * A different person is on the line.
 *
 * Two outcomes, and the difference matters legally rather than conversationally. The same person
 * coming back from hold has heard the announcement and gets nothing repeated at them — reciting a
 * disclosure at somebody twice is how a call stops sounding like a person. A genuinely new human has
 * NOT heard it: they do not know they are talking to an AI, and they do not know they are being
 * recorded. So it is said again, in full, before anything else.
 *
 * `same` is the model's judgement because it is the only thing on the call that can make it; nothing
 * in the audio stream marks a handover. What is not the model's judgement is whether the disclosure
 * then gets repeated, which is this function.
 */
export function newParty(call, { who = "", same = false, now = clock.now(), ownerName = null, log = () => {} } = {}) {
  // A returning person ends the hold and changes nothing else.
  if (same) {
    const off = noteSpeaking(call, { now, log });
    return {
      newPerson: false, announce: false, party: currentParty(call),
      waited: off?.waited ?? 0,
      note: off?.waited
        ? `Same person, back after about ${Math.max(1, Math.round(off.waited / 60))} minute(s) on hold.`
          + ` Thank them for coming back, do not re-introduce yourself, and carry straight on from where you were.`
        : `Same person. Carry on; do not re-introduce yourself.`,
    };
  }

  // The FIRST person on a call that opened silent (#232), reached after a menu, a recording or hold, is
  // not a second party: nobody has heard the disclosure, so code still says it word for word in front
  // of the reply (`openingOwed`) rather than leaving it to the model. 2026-10-31 drive: menu → press 1 →
  // hold → "Hi, this is Sam", the model called this, and its reply to Sam skipped the disclosure.
  // GPT-Live calls only (an older provider's row is left as it was).
  if (call?.provider === "gptlive" && openingOwed(call)) {
    noteSpeaking(call, { now, log });
    log({ call_first_person: call.id, who: String(who).slice(0, 60) });
    return {
      newPerson: true, announce: false, party: currentParty(call),
      note: `This is the first person you have reached on this call. Who you are and that the call is recorded`
        + ` is said for you, word for word, just before your words: do not say it yourself. Then, in ONE`
        + ` sentence, say what you are calling about.`,
    };
  }
  const party = currentParty(call) + 1;
  const told = partiesTold(call);
  noteSpeaking(call, { now, log });
  patch(call, { party_n: party });
  log({ call_new_party: call.id, party, who: String(who).slice(0, 60) });

  // Whose Reason this is, which is not necessarily the operator: everyone who texts Reason has their
  // own, and the announcement names the person the call is actually for.
  const owner = ownerName || ownerNameFor(call);
  const owed = !told.includes(party);
  if (!owed) {
    return { newPerson: true, announce: false, party, note: `Already introduced yourself to this person. Carry on.` };
  }
  return {
    newPerson: true, announce: true, party,
    announcement: announcementFor({ ownerName: owner }),
    // The instruction rather than the finished sentence, because the call may be in Spanish by now and
    // a hand-written English line here would be the wrong one. Same decision as `announcementAgainIn`.
    note: [
      `This is a NEW person and they have not heard who you are. In your very next reply, before`
      + ` anything else, tell them in the language you are speaking that you are an AI assistant calling`
      + ` on behalf of ${owner}, that the call is recorded, and that they can say so if they would rather`
      + ` not be. That is not optional and it is not something to shorten away.`,
      `Then, in ONE sentence, say what you are calling about and what has already been settled, so they`
      + ` are caught up without you starting over. Everything you have been told still applies and`
      + ` everything already agreed still stands — you have not lost the call.`,
      `Do not ask them to repeat things the last person already told you.`,
    ].join(" "),
  };
}

/** Write down that this party has now heard it, so it is never recited at them twice. */
export function markAnnounced(call, { party = null, log = () => {} } = {}) {
  const p = party ?? currentParty(call);
  const told = partiesTold(call);
  if (told.includes(p)) return told;
  const next = [...told, p];
  patch(call, { parties_told: JSON.stringify(next) });
  log({ call_party_announced: call.id, party: p });
  return next;
}

// ---------- menus ----------

/** Keys this call has pressed, in order, so a menu loop is visible in the record. */
export function pressed(call) {
  try {
    const v = JSON.parse(call?.menu_presses ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/**
 * Reason pressed a key. Returns whether to let it, and the DTMF string actually sent.
 *
 * The one rule with teeth is the repeat limit. Their own docs say some IVRs miss in-band tones on
 * Twilio Native, so pressing the same key twice is a legitimate workaround and the voice prompt asks
 * for it. Pressing it a third and fourth time is a stuck call burning per-minute billing against a
 * menu that is never going to answer, so the third identical press in a row is refused and the model
 * is told to try speaking instead — most menus have a human option.
 */
/**
 * Keys as they go in the server log. A menu choice ("1", "0", "#", "1w1") is how a stuck call is
 * debugged, so it stays. A longer run is an account number, a PIN or a date of birth typed into
 * somebody's phone system: the log gets how long, never which keys. The full sequence is still on the
 * call row (`menu_presses`) for the people allowed to read that.
 */
export function tonesForLog(tones) {
  const t = String(tones ?? "");
  return t.replace(/[wW]/g, "").length <= 2 ? t : `${t.length} chars`;
}

export function notePress(call, { tones = "", log = () => {} } = {}) {
  // Validated, never salvaged. The first version of this stripped out anything that was not a valid
  // tone character, which quietly turned "press 1w1 now" into "1w1w" — the `w` came out of the word
  // "now" and a pause appeared in a sequence nobody asked for. Pressing keys into somebody's phone
  // system is not a place to guess, so prose is refused and handed back to be said properly.
  const raw = String(tones ?? "").replace(/[\s,]+/g, "");
  if (!raw) return { ok: false, error: "No keys to press. Digits 0-9, * and #, with w or W for a pause." };
  if (!/^[0-9*#wW]+$/.test(raw)) {
    return {
      ok: false,
      error: `"${String(tones).slice(0, 40)}" is not a key sequence, so nothing was pressed. Send ONLY the keys:`
        + ` digits 0-9, * and #, with w for a half-second pause and W for a full second. "1", "2", "1w1", "4321#".`,
    };
  }
  const t = raw;
  const history = pressed(call);
  let sameInARow = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === t; i--) sameInARow++;
  if (sameInARow >= 2) {
    log({ call_menu_stuck: call.id, tones: tonesForLog(t), tried: sameInARow });
    return {
      ok: false, stuck: true,
      // Not "say something out loud": words to a menu are taken as words to a person, and would spend
      // the disclosure on it (see `holdBack` in ./voice.js).
      error: `You have already pressed ${t} ${sameInARow} times and the menu has not reacted. Do not press it again.`
        + ` If there is an option for a person you have not tried (operator, reception, 0), press that instead.`
        + ` If there is genuinely no way through, call end_call without saying anything.`,
    };
  }
  patch(call, { menu_presses: JSON.stringify([...history, t].slice(-12)) });
  log({ call_menu_press: call.id, tones: tonesForLog(t) });
  return { ok: true, tones: t, pressedBefore: sameInARow };
}

// ---------- a machine answered ----------

/**
 * A machine answered. Written down as exactly that — a machine, no message yet — and the model is
 * told how to leave the one message.
 *
 * The 2026-10-13 call to Jeffrey is why this is Reason's step rather than the platform's. Forwarding
 * `voicemail_detection` to the voice platform ended the call, speaking the agent's `voicemail_message` first if
 * one was set; the agent had none and Reason's message is different on every call, so the call ended at
 * the beep with nothing said — and the row said "one message was left", which then locked the number
 * out of a retry under the never-a-second-voicemail rule. So the tool is not forwarded. The row gets
 * `voicemail_no_message` now, and `voicemail_left` only when `noteVoicemail` has the words.
 *
 * The message goes in `end_call`'s own `message` argument, which their docs describe as "a farewell
 * message to send to the user before ending the call": the platform speaks it and then hangs up, so
 * the words cannot be cut off by the hang-up that follows them. Nothing is dictated here — the goal
 * and the facts are already in the prompt, and the model composes the message from them.
 */
export function noteMachine(call, { reason = "", log = () => {} } = {}) {
  const owner = ownerNameFor(call);
  patch(call, { voicemail_left: 0, outcome_kind: "voicemail_no_message", outcome: "a machine answered; no message has been left yet" });
  log({ call_voicemail: call?.id, reason: String(reason ?? "").slice(0, 60) });
  return {
    ok: true, machine: true,
    instruction: `A machine answered and nobody is listening, so do not ask anything and do not wait for a reply.`
      // Not every errand is one a mailbox can do anything with. Asked for by the owner 2026-10-27:
      // "leave a short message only when the goal suits it".
      + ` If a message would do nothing for what this call is for, call end_call with no message and say nothing.`
      + ` Otherwise leave ONE short message now: call end_call with its "message" argument set to the whole voicemail —`
      + ` who you are (an AI assistant calling for ${owner}), what the call is about in one or two plain`
      + ` sentences from what this call is for, and how to reach ${owner} back if you were given a way.`
      + ` Put every word inside "message" and write nothing outside it: the call ends as soon as the message`
      + ` has been spoken, and words outside it may be cut off. Never say the name of a tool. This number will`
      + ` not be rung again to leave a second message.`,
  };
}

/**
 * The message went out, or it did not. `voicemail_left` is set by this and nothing else, so the
 * never-a-second-voicemail rule in ./redial.js only ever counts messages that were actually said.
 */
export function noteVoicemail(call, { message = "", log = () => {} } = {}) {
  const said = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!said) {
    patch(call, { voicemail_left: 0, outcome_kind: "voicemail_no_message", outcome: "a machine answered; no message was left" });
    log({ call_voicemail_left: call?.id, left: false });
    return { left: false };
  }
  patch(call, {
    voicemail_left: 1, outcome_kind: "voicemail_left",
    outcome: `a machine answered; one message was left: "${said.length > 240 ? `${said.slice(0, 237)}...` : said}"`,
  });
  log({ call_voicemail_left: call?.id, left: true, words: said.split(" ").length });
  return { left: true, message: said };
}

// ---------- what the model is told about waiting ----------

/**
 * The waiting rules in the voice prompt. Short, because every line costs first-word latency on a
 * call, and only the things a model gets wrong on its own are in here.
 */
export const WAITING_RULES = [
  // Call 45 (2026-10-27): the Strand's line answered with a ninety-second recording of opening hours
  // that ended "we're not accepting customer phone inquiries… email web@strandbooks.com… if you know
  // your party's extension, dial it now". Reason said "This is a recorded message, and it says they
  // aren't taking customer phone inquiries" OUT LOUD, into it, pressed nothing, and the menu timed out
  // into a mailbox that was not taking messages either.
  `FIRST, every time their side speaks before a person has: is it a PERSON or a MACHINE? A person answers like a`
  + ` person — "Strand, how can I help?", "hello?". A machine reads things out: opening hours, "press 1 for…",`
  + ` "if you know your party's extension", "please hold", music, a voicemail greeting. If it is a machine,`
  + ` call machine_on_the_line and write NO words at all — nothing you write reaches a machine usefully, and`
  + ` describing the recording out loud is talking into it. Then do what it tells you.`,
  `If the recording says they do not take calls or inquiries by phone, are closed for good, or the mailbox is full or`
  + ` not taking messages, and it offers no option for a person: that is a dead end — say so with machine_on_the_line`
  + ` (dead_end true), with any other way to reach them it gave in "heard", and the call is ended for you.`,
  `If you are put on hold, or you hear music, ringing, or a recorded message repeating: call skip_turn and say nothing.`,
  `Never talk to hold music and never fill a silence with chatter. You are being timed; you do not have to watch the clock.`,
  // Said out loud, to hold music, in the 2026-10-07 rehearsal: "The call is on hold, so I should stay
  // silent." Calling the tool IS the silence; announcing it is the one way to break it. There is a code
  // floor under this too — `aNoteToItself` in ./voice.js drops the sentence — because a rule recited
  // down a phone line is worse than no rule.
  `Never say out loud that you are on hold, that you are waiting, or that you should stay quiet, and never say the`
  + ` name of a tool. Calling skip_turn IS staying quiet, so there is nothing to announce. The only thing you say`
  + ` out loud about waiting is to the person who just asked you to hold, once: "of course, I'll hold".`,
  // The first version of this said only "listen to all of it before pressing anything", and in the
  // 2026-10-07 rehearsal that produced a call that never pressed anything at all: the menu read its
  // options, Reason had no way to know the list had finished, waited politely, and the whole call then
  // sat on hold until the budget ran out. A rule that cannot be satisfied is worse than no rule. So the
  // trigger is explicit — you have heard the option you want — and the "listen first" part is kept as
  // the thing it was actually for, which is not grabbing option one because it came first.
  `If a phone menu answers: once you have heard an option that matches what you are ringing about,`
  + ` press it with play_keypad_touch_tone straight away. Do not wait for the menu to finish repeating`
  + ` itself and do not wait for a person — a menu will not put you through on its own.`,
  `Hear the options out before choosing, so you pick the right one rather than the first one. But if the`
  + ` menu has read the option you need, that is your turn to press it.`,
  // Not "say something out loud" any more: words on a line where only a machine has spoken are taken as
  // Reason talking to a person (see `openingOwed`), so the disclosure would be spent on the menu.
  `If none of the options fit, press the one for a person (operator, reception, "all other enquiries"), or 0.`,
  // The 2026-10-13 call to Jeffrey: "straight away" had it calling this four seconds in, over the
  // greeting, and the forwarded tool hung the call up at the beep with nothing said. The tool is now
  // Reason's own step — it answers with how to leave the message — so the only timing that matters is
  // that the greeting has finished.
  `If a voicemail greeting answers, let it finish, then call machine_on_the_line with what "voicemail_greeting".`
  + ` Say nothing to the greeting. You will be told whether and how to leave the message.`,
  `If somebody different comes on the line, or you are put through to another person, call new_person_on_the_line FIRST,`
  + ` before you say anything to them, and do what it tells you.`,
  `If the same person comes back after holding, thank them for coming back and carry on — do not start again.`,
].join("\n");

/** One line for the prompt saying how long it has already been waiting, when it has. */
export function waitingNote(call, { now = clock.now() } = {}) {
  const s = holdSeconds(call, { now });
  if (!s) return "";
  const left = holdLeft(call, { now });
  return `You have been waiting on this call for about ${Math.max(1, Math.round(s / 60))} minute(s).`
    + (left <= 60
      ? ` You are nearly out of time to wait, so if somebody comes on now, get straight to the point.`
      : ``);
}

// ---------- writing it down ----------

/**
 * Patch the call row, tolerating a plain object in a test that has no database behind it.
 *
 * The in-place copy matters: callers hold the row they were given and read `hold_since` off it on the
 * next line, so an update that only went to SQLite would read stale within a single turn.
 */
function patch(call, fields) {
  if (!call) return;
  Object.assign(call, fields);
  if (!call.conversation_id || !call.id) return;
  try { db.updateCall(call.conversation_id, call.id, fields); }
  catch { /* a row that is not in the database is a test's row; the in-place copy is the state */ }
}
