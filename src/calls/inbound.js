// Somebody rings the number: whose Reason it is, and the pieces of the answer every inbound call
// shares (src/calls/gptlive.js routes the ring itself, `inboundTwiml`).
//
// The policy is the same one a TEXT from a stranger gets, for the same reason:
//
//   - **A number Reason knows** reaches their own Reason (`whoseCallIsThis`).
//   - **A number nobody approved** gets the stranger pitch, and the master is asked about them
//     exactly as they are asked about a first text (`strangerIntake`).
//   - **A number over its day's limit** gets one honest line and the call ends (`overCallCap`). The
//     cap exists because a call bills by the minute, and a cap that only applies to calls Reason
//     places is a cap somebody can get round by dialling in.
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as access from "../access.js";
import { config, clock } from "../config.js";
import { greetingFor } from "./carryover.js";

/**
 * Over today's call limits? `{ line, reason }` to say and hang up on, or null. Both voices use it, so
 * a cap that applies to calls Reason places applies to calls dialled in too.
 */
export function overCallCap(conversationId, { log = () => {} } = {}) {
  const placed = accounts.withinCap(conversationId, "call");
  const minutes = accounts.withinCap(conversationId, "call_minutes");
  if (placed.ok && minutes.ok) return null;
  const which = !placed.ok
    ? `that's ${placed.used} calls today, which is the limit on this setup`
    : `you've used ${minutes.used} minutes of calls today, which is the limit on this setup`;
  log({ call_inbound_capped: conversationId, calls: placed.used, minutes: minutes.used });
  return {
    line: `hey — ${which}, so i can't take this one. text me instead and i'll pick it up there.`,
    reason: !placed.ok ? "daily_call_cap" : "daily_call_minutes_cap",
  };
}

/**
 * Whose Reason is on the other end of this number, and is it answering?
 *
 * The thing this gets right that a straight `admit` would not: a call has no channel of its own, so
 * the conversation is found by the NUMBER (`accountByNumber`) and the call joins the Reason that
 * number already texts. Admitting a caller on a channel named after the call provider would hand them a second,
 * empty Reason — no memory, no open jobs — and send the text they get ten minutes later somewhere
 * else.
 *
 * Everything else is the same policy a text gets, read from the same places: the operator is the
 * operator whatever they dial from, a blocked number is blocked, and a paused or removed account
 * stops answering without anything of theirs being touched.
 */
export function whoseCallIsThis(address) {
  if (db.isBlocked(address)) return { allow: false, reason: "blocked" };

  // The operator keeps the conversation their data is already under, whichever phone they ring from.
  if (accounts.isOperatorAddress(address)) {
    const conversationId = config.ownerConversation;
    // A call is not a channel change. Keep the text channel the owner already texts on;
    // overwriting it to the call provider's name would route every subsequent text (recording notes,
    // replies) to a channel that cannot send, and the disclosure text would fail.
    const existing = db.getAccount(conversationId);
    const channel = existing?.channel && existing.channel !== "console" ? existing.channel : "";
    db.upsertAccount({ conversationId, channel, address, name: config.ownerName, isOperator: true });
    return { allow: true, conversationId, isOperator: true };
  }

  const row = db.accountByNumber(address);
  if (row) {
    // A stop is per number, not per row: paused or removed on any line refuses the call too
    // (accounts.accountState), whichever row happens to be newest.
    const state = db.stoppedStateOf(address) ?? row.state ?? "active";
    if (state !== "active") return { allow: false, reason: state };
    return { allow: true, conversationId: row.conversation_id, isOperator: !!row.is_operator };
  }

  // Nobody Reason knows. Before the stranger line: is this a place RINGING BACK?
  //
  // A call brief hands out the Twilio number so a busy place can return the call (`returnNumber` in
  // ./brief.js), and without this that return call would get the one polite line meant for somebody
  // who found the number by accident — losing the errand, after Reason asked them to ring back.
  //
  // What they get is NOT an account. It is the third-party context for the call they are returning:
  // the goal, the approved facts, the standing rules, no thread, no memory, no tools. Exactly what
  // Reason had when it rang them, and exactly as isolated.
  const back = callingBack(address);
  if (back) {
    return {
      allow: true, conversationId: back.call.conversation_id, isOperator: false,
      callingBack: true, aboutCall: back.call, errandId: back.call.errand_id ?? null,
    };
  }

  // Never texted, never approved, and not returning a call. Being invited is the thing they do not
  // have, and ringing the number instead of texting it does not grant it.
  return { allow: false, reason: "no_account_yet" };
}

/**
 * Is this number one Reason has an open errand with?
 *
 * The newest call to that number wins, and only one that is finished or still live within the window —
 * a place ringing back about something from last month is not continuing that conversation, and
 * treating it as one would put a stale goal in front of somebody who rang about something else.
 *
 * Deliberately does not require the call to have ASKED them to ring back. Reason gives the number out
 * on calls where it was offered, and a receptionist who says "let me check and call you straight back"
 * does not always say it in a way anything recorded.
 */
export function callingBack(address, { within = CALLBACK_WINDOW_MS, now = clock.now(), limit = MAX_RING_BACKS } = {}) {
  const number = String(address ?? "").trim();
  if (!number) return null;
  // Anybody's errand, not only the operator's: every account's Reason places calls, and the place it
  // rang returns the call to the same number. A call older than the window cannot open one, and the
  // ring-backs counted below are all newer than the call they answer, so two windows back is everything.
  const calls = db.callsWithNumber({ toNumber: number, since: now - 2 * within });
  // Only a call Reason PLACED opens the window. A ring-back is written as a call row to the same
  // number, and letting it count would let every ring-back reopen the day for the next one, so a
  // caller who never settles the errand could keep the line open for ever (security audit lead 30).
  const placed = calls.filter(c => c.direction !== "in").reverse();
  for (const call of placed) {
    const when = Number(call.ended_at || call.updated_at || call.created_at || 0);
    if (when && now - when > within) continue;
    // A call that was already settled as "they said no" is not an open question. One that ran out of
    // hold, got voicemail, or dropped before it was confirmed is exactly the kind they ring back about.
    if (["refused_by_them", "confirmed"].includes(call.outcome_kind)) continue;
    // Somebody who has since left has no errand to come back to (their row is gone or stopped).
    if (call.conversation_id !== config.ownerConversation) {
      const acct = db.getAccount(call.conversation_id);
      if (!acct || (acct.state && acct.state !== "active")) continue;
    }
    // A ring-back runs on the conversation of the person the call was for; the operator's is exempt
    // from the daily call caps by default, so this is the bound: a few return calls per call Reason
    // made, then they are a stranger again.
    const rungBack = calls.filter(c => c.direction === "in" && !c.is_owner && c.id > call.id && c.conversation_id === call.conversation_id).length;
    if (rungBack >= limit) return null;
    return { call };
  }
  return null;
}

/**
 * How many times a place can ring back about one call Reason made. "Let me check and call you back"
 * is one return call, two if the line dropped; past three it is not an errand continuing.
 */
export const MAX_RING_BACKS = 3;

/**
 * How long after a call a return call is treated as being about it. A day: long enough for "I'll check
 * with the kitchen and ring you in the morning", short enough that last month's errand is not put in
 * front of somebody ringing about something else.
 */
export const CALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

// Phone networks need a few hundred ms after connect before audio passes through. Anything spoken
// in that window gets clipped. A short throwaway lead-in absorbs it: if clipped, the real greeting
// arrives clean; if not, it sounds like a natural pickup.
const LEAD_INS = ["oh,", "ah,", "hey —", "yo,"];

/**
 * What Reason says when it picks up.
 *
 * Code's words, not the model's, because this line is spoken before any turn has run — there is no
 * model in the loop yet. It is short on purpose: the opening line's job is to hand the conversation
 * to them having already shown it knows what is going on, and then get out of the way.
 */
export function openingLineFor({ person, conversationId = "", classic = false }) {
  // Their own call, carry-over on: fitted to the time of day, never the last call's line (./carryover.js).
  const varied = conversationId ? greetingFor({ conversationId, name: person?.name ?? "", direction: "in", classic }) : "";
  // REASON_CALL_FEEL=classic (./callclassic.js): call 112's opening, any lead-in in front (as at 752a9e72).
  if (classic) {
    const lead = LEAD_INS[Math.floor(Math.random() * LEAD_INS.length)];
    if (varied) return `${lead} ${varied}`;
    const named = person?.name && person.name !== "the person I work for" ? `hey ${person.name}` : "hey";
    return `${lead} ${named} — what's up?`;
  }
  // Never "hey — hey Omari" (calls 114-116): a line that opens on "hey" gets one of the other lead-ins.
  const first = person.name && person.name !== "the person I work for" ? `hey ${person.name}` : "hey";
  const line = varied || `${first} — what's up?`;
  const leads = /^hey\b/i.test(line) ? LEAD_INS.filter(l => !/^hey\b/i.test(l)) : LEAD_INS;
  return `${leads[Math.floor(Math.random() * leads.length)]} ${line}`;
}


/**
 * Tell this person, once ever, that their calls are recorded and that they get the audio.
 *
 * The owner's own calls are recorded like every other call — there is no variant of Reason that does
 * not record — but the greeting does not recite a legal disclosure at the person who set the thing
 * up. The honest middle is this: the first time their number ever rings, a text afterwards says it
 * plainly, and it is never said again.
 *
 * The claim and the record are one statement (`markToldCallsRecorded` only succeeds once), so it
 * cannot be sent twice by two calls arriving together. Queued rather than sent, because this runs
 * while the phone is still ringing.
 */
export function recordingNoteFor({ conversationId, row, log = () => {} }) {
  const who = db.getAccount(conversationId);
  const address = who?.address && who.address !== "console" ? who.address : "";
  const channel = who?.channel && who.channel !== "console" ? who.channel : "";
  // Nowhere to send it. The flag is deliberately NOT set: they still have not been told, and the
  // next call on an install that has a channel should still tell them.
  if (!address || !channel) return { queued: false, why: "no texting channel on this conversation" };
  if (!db.markToldCallsRecorded(conversationId)) return { queued: false, why: "already told" };

  const { row: queued } = db.enqueueOutbound({
    idemKey: `call:${row.id}:recording-note`,
    conversationId, channel, address,
    body: `btw — every call is recorded, this one included, and the audio comes to u right here after.`
      + ` that's how it works for all of em; just telling u once.`,
    toOwner: true,
    maxAttempts: config.outboxMaxAttempts,
  });
  log({ call_recording_note: conversationId, outbox: queued.id });
  return { queued: true, outbox_id: queued.id };
}

/**
 * The master is asked about an unknown number that rang, exactly as about a first text. Returns why
 * they are a stranger. Used by GPT-Live's inbound route (src/calls/gptlive.js).
 */
export function strangerIntake({ address, router = null, log = () => {}, reason = "no_account_yet" }) {
  // The request goes in on the TEXTING channel, not on the call provider's name. If the master says
  // yes, that is the channel their new Reason is set up on and the channel they are told yes over —
  // approving somebody onto the call provider's name would set up an account Reason cannot send a text to.
  const channel = liveTextingChannel(router);
  if (!channel) {
    // Nowhere to ask the master and nowhere to answer this person if the answer were yes. They still
    // get the one line; nothing is written down as a request nobody can act on.
    log({ call_inbound_unknown_no_channel: address });
    return "no_channel";
  }

  const seen = access.handleUnknown({
    channel, address,
    // What the master sees of them, quoted. A call has no words to quote, so this says what really
    // happened rather than putting an invented sentence in a stranger's mouth.
    text: "(they called your number instead of texting it)",
  });

  if (seen.action === "ask_master") {
    const ask = access.askMaster({
      request: seen.request,
      masterConversationId: config.ownerConversation,
      messages: db.loadConversation(config.ownerConversation),
    });
    if (ask.asked) {
      const told = queueToMaster({ text: ask.toMaster, router, idemKey: `call-access:${seen.requestId}`, log });
      log({ call_asked_master_about: address, request: seen.requestId, queued: told.queued });
    } else {
      log({ call_request_waiting: seen.requestId, why: ask.reason });
    }
  } else {
    log({ call_inbound_unknown: address, why: seen.reason });
  }
  return seen.reason ?? reason;
}

/** A channel that can really send a text right now, preferring the master's own. */
function liveTextingChannel(router) {
  const live = (name) => name && name !== "console" && router?.get?.(name)?.status?.().status === "live";
  const master = db.getAccount(config.ownerConversation);
  if (live(master?.channel)) return master.channel;
  return (router?.statuses?.() ?? []).find(s => s.status === "live" && s.name !== "console")?.name ?? null;
}

/**
 * Put one line to the master in the outbox.
 *
 * The channel is resolved the way `tellMaster` resolves it — their recorded one if it is really
 * running here, otherwise any live one — because a row that still says 'linq' on an install that now
 * runs Sendblue is not a reason to drop a question somebody is waiting on.
 */
function queueToMaster({ text, router = null, idemKey, log = () => {} }) {
  const master = db.getAccount(config.ownerConversation);
  const to = master?.address && master.address !== "console" ? master.address : config.masterNumbers[0];
  const channel = liveTextingChannel(router);
  if (!to || !channel) {
    log({ call_could_not_ask_master: `nowhere to reach ${config.ownerName}` });
    return { queued: false };
  }
  const { row } = db.enqueueOutbound({
    idemKey, conversationId: config.ownerConversation, channel, address: to,
    body: text, toOwner: true, maxAttempts: config.outboxMaxAttempts,
  });
  return { queued: true, outbox_id: row.id };
}
