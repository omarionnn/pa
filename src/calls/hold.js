// Waiting, menus, and the moment a different human picks up the phone.
//
// This is the part of a real call that no platform feature covers, and the owner named it first when
// he listed what matters: "reliable hold handling". So it is worth being exact about what is ours and
// what is theirs, because the temptation is to assume a feature exists.
//
// THEIRS, read from ElevenLabs' docs 2026-10-06:
//   `skip_turn`                — the agent stays silent and waits, without speaking. ("Skip turn")
//   `play_keypad_touch_tone`   — DTMF for a phone menu. ("Play keypad touch tone")
//   `voicemail_detection`      — a machine picked up. ("Voicemail detection")
//   `turn_timeout` 1–30 s      — how long SILENCE runs before the agent speaks again. ("Conversation flow")
//
// NOT THEIRS, and this is the important half:
//   There is no hold detection and no "they're back" signal. ElevenLabs' *hold audio* and *call
//   queueing* are the opposite direction — audio played to people queued for OUR agent at its
//   concurrency limit — and conflating the two would produce a hold feature that does nothing.
//   Worse: hold music is AUDIO, and `turn_timeout` measures silence, so the platform's own timer may
//   never fire during a hold at all and may keep handing us turns as though somebody were talking.
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

/**
 * The platform tools this file is the reason for enabling. Each one has to be switched on on the
 * agent in ElevenLabs or the function call is silently ignored — and silently is the problem: hold,
 * menus and voicemail all stop working while the call still *sounds* completely fine. That is why
 * these are listed in the setup checklist as things he has to tick, not as things we configure.
 */
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
      + " Call this as soon as you are sure. One message gets left and the call ends; you will never be"
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
    log({ call_menu_stuck: call.id, tones: t, tried: sameInARow });
    return {
      ok: false, stuck: true,
      error: `You have already pressed ${t} ${sameInARow} times and the menu has not reacted. Do not press it again.`
        + ` Say something out loud instead — most menus put you through to a person if you ask, or there is an`
        + ` option for one. If there is genuinely no way through, say so and end the call.`,
    };
  }
  patch(call, { menu_presses: JSON.stringify([...history, t].slice(-12)) });
  log({ call_menu_press: call.id, tones: t });
  return { ok: true, tones: t, pressedBefore: sameInARow };
}

// ---------- what the model is told about waiting ----------

/**
 * The waiting rules in the voice prompt. Short, because every line costs first-word latency on a
 * call, and only the things a model gets wrong on its own are in here.
 */
export const WAITING_RULES = [
  `If you are put on hold, or you hear music, ringing, or a recorded message repeating: call skip_turn and say nothing.`,
  `Never talk to hold music and never fill a silence with chatter. You are being timed; you do not have to watch the clock.`,
  `If a phone menu answers, listen to all of it before pressing anything, then press the key with play_keypad_touch_tone.`,
  `If a machine answers instead of a person, call voicemail_detection straight away.`,
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
