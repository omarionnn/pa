// Somebody rings the number. This answers while it is still ringing.
//
// ElevenLabs' inbound personalization webhook: before the audio connects, they POST
// `{caller_id, agent_id, called_number, call_sid, conversation_id}` and take back
// `dynamic_variables` + `conversation_config_override` — the opening line, the prompt, the voice.
// It is fetched in parallel with the ring, so it is free in latency terms only as long as it really
// is fast. ("Twilio personalization", read 2026-10-05.)
//
// Which is why there is NO MODEL CALL in this file. Everything it answers with is built from data
// already on hand: the account row for the number, their open jobs, their last call. A model turn
// here would be a second or two of ringing, and the first words of a call are the thing that decides
// whether it feels alive.
//
// The policy is the same one a TEXT from a stranger gets, for the same reason:
//
//   - **A number Reason knows** reaches their own Reason. Their name goes in as a dynamic variable,
//     and the opening line is built from what is actually going on in their thread, so the call opens
//     with the thing rather than with "how can I help".
//   - **A number nobody approved** gets one fixed line and the call ends. No model turn is spent on
//     them — an agent that answers any number that dials it is an agent anybody can run a bill up on
//     — and the master is asked about them exactly as they are asked about a first text.
//   - **A number over its day's limit** gets one honest line and the call ends. The cap exists
//     because a call bills by the minute, and a cap that only applies to calls Reason places is a cap
//     somebody can get round by dialling in.
//
// The row is created HERE rather than when the call ends. That is what makes the custom-LLM endpoint
// able to find the call at all (there is nothing of Reason's in an inbound turn's body to go on), and
// it means a call that crashes the process mid-way is still on the record.
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import * as access from "../access.js";
import { config, clock, normalizeNumber } from "../config.js";
import * as strangerCall from "./stranger.js";
import { warmCallCache } from "./voice.js";
import { announcementFor } from "./provider.js";

/** The route ElevenLabs is pointed at for personalization. Quoted in the setup checklist. */
export const INBOUND_PATH = "/calls/elevenlabs/inbound";

/** Reason's channel name for a call, so an access request from one is distinguishable from a text. */
export const CALL_CHANNEL = "elevenlabs";

/**
 * One inbound personalization request.
 *
 * Returns `{ status, body }` — `body` already in the shape their docs give for this webhook. Never
 * throws: a webhook that errors during the ring is a call that connects with default settings, which
 * for a stranger would mean a full Reason answering them.
 *
 * `provider` is passed in rather than imported so this is testable without a key, and because the
 * same handler is what http.js calls with whatever provider is really running.
 */
export function inboundRequest({
  rawBody, headers = {}, provider = null, router = null, log = () => {}, now = clock.now(),
  // Loads the call's prompt into the model's cache while the phone is still ringing. Injected so the
  // suite can watch it being asked for without a model; never awaited here, never allowed to throw.
  warm = warmCallCache,
}) {
  // The provider that is actually running has to be this one. A personalization request arriving for
  // a provider nobody configured is not a late webhook, it is somebody poking the listener.
  const st = provider?.status?.();
  if (!st || st.name !== "elevenlabs") return { status: 404, body: { error: "not found" } };
  // Answering a phone needs its own settings, and the honest answer when they are missing is that
  // this route is not set up — not a call answered by half a Reason.
  if (st.directions?.in !== true) {
    log({ call_inbound_not_ready: st.directions?.missingIn ?? [] });
    return { status: 503, body: { error: `inbound calls are not set up on this machine: no ${(st.directions?.missingIn ?? []).join(", ") || "ELEVENLABS settings"}` } };
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { body = null; }
  if (!body || typeof body !== "object") return { status: 400, body: { error: "bad json" } };

  const callerId = String(body.caller_id ?? body.callerId ?? "").trim();
  const conversationId = String(body.conversation_id ?? body.conversationId ?? "").trim();
  const calledNumber = String(body.called_number ?? body.calledNumber ?? "").trim();
  const callSid = String(body.call_sid ?? body.callSid ?? "").trim();
  if (!conversationId) return { status: 400, body: { error: "no conversation_id on the request" } };

  const address = normalizeNumber(callerId) || callerId;
  log({ call_inbound: conversationId, from: address || "(no caller id)", to: calledNumber, sid: callSid });

  // No caller id at all — a withheld number. Treated exactly as an unknown one: there is nobody to
  // look up, so there is nobody to be.
  if (!address) return { ...stranger({ address: "", router, log, reason: "withheld" }), conversationId };

  const who = whoseCallIsThis(address);
  if (!who.allow) {
    if (who.reason === "blocked") {
      log({ call_inbound_blocked: address });
      return { status: 200, body: endItHere({ line: strangerCall.neutralLine(), reason: "blocked" }), conversationId };
    }
    if (who.reason === "paused" || who.reason === "removed") {
      // Told once, in their own words, and then left alone — the same rule as a text.
      // A short neutral line naming nobody (2026-10-31). The texted stoppedLine names the operator.
      return { status: 200, body: endItHere({ line: strangerCall.neutralLine(), reason: who.reason }), conversationId };
    }
    return { ...stranger({ address, router, log, reason: who.reason }), conversationId };
  }

  const person = accounts.ownerOf(who.conversationId);
  const seen = { conversationId: who.conversationId };

  // A place ringing back about a call Reason made. NOT an owner call, and the difference is the whole
  // point: this is a business, so it gets the third-party context — the goal, the approved facts, the
  // standing rules, no thread, no memory, no tools — and it gets the announcement, because it is a
  // person who has not been told what they are talking to.
  //
  // Handled before the owner path below so the `isOwner: true` row that path creates can never be
  // written for a restaurant. A caller id is not proof of identity (see docs/unverified.md), and the
  // one place that matters most is here, where the alternative would be a stranger reaching somebody's
  // own Reason by spoofing a number Reason happened to have called.
  if (who.callingBack) {
    const about = who.aboutCall;
    const ann = announcementFor({ ownerName: person.name });
    const row = db.createCall(seen.conversationId, {
      provider: "elevenlabs",
      toNumber: address,
      isOwner: false,
      goal: `They are ringing back about: ${about.goal}`,
      facts: Array.isArray(about.facts) ? about.facts : [],
      direction: "in",
      externalId: conversationId,
      state: "in_progress",
      announcement: ann,
    });
    // The same brief, the same errand, the same budget — so the call that comes back is the same
    // errand continuing rather than a new conversation that has to be explained from scratch. Booking
    // is left exactly as it was: if the original call was only asking, this one is only asking too.
    db.updateCall(seen.conversationId, row.id, {
      brief: about.brief || "{}",
      errand_id: about.errand_id ?? null,
      hold_budget_s: about.hold_budget_s ?? null,
    });
    accounts.countUse(seen.conversationId, "call");
    log({ call_inbound_callback: seen.conversationId, call: row.id, about: about.id, errand: about.errand_id ?? null });
    warm({ call: db.getCall(seen.conversationId, row.id) ?? row, log, now });
    return {
      status: 200,
      conversationId,
      body: {
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          owner_name: person.name,
          [`reason_call_id`]: row.id,
          [`reason_conversation_id`]: seen.conversationId,
          [`reason_kind`]: "third_party",
        },
        conversation_config_override: {
          // The announcement, word for word, exactly as on an outbound call. They are a new person on a
          // recorded call and they are told so before anything else.
          agent: { first_message: `${ann} You're calling back about ${about.goal} — thanks for ringing back.` },
          ...(config.elevenVoiceId ? { tts: { voice_id: config.elevenVoiceId } } : {}),
        },
        custom_llm_extra_body: {
          reason_call_id: row.id,
          reason_conversation_id: seen.conversationId,
          reason_kind: "third_party",
        },
      },
    };
  }

  // The day's limits, counted in the database and therefore surviving a restart. Checked before any
  // turn is possible, because the whole reason a call has its own caps is that it bills by the minute
  // for as long as somebody keeps talking.
  const placed = accounts.withinCap(seen.conversationId, "call");
  const minutes = accounts.withinCap(seen.conversationId, "call_minutes");
  if (!placed.ok || !minutes.ok) {
    const which = !placed.ok
      ? `that's ${placed.used} calls today, which is the limit on this setup`
      : `you've used ${minutes.used} minutes of calls today, which is the limit on this setup`;
    log({ call_inbound_capped: seen.conversationId, calls: placed.used, minutes: minutes.used });
    return {
      status: 200,
      conversationId,
      body: endItHere({
        line: `hey — ${which}, so i can't take this one. text me instead and i'll pick it up there.`,
        reason: !placed.ok ? "daily_call_cap" : "daily_call_minutes_cap",
      }),
    };
  }

  // On the record before a word is said. The goal is what it is — nobody handed this call one — and
  // saying so plainly is better than inventing one; `facts` is empty because an inbound call shares
  // nothing with anybody, it is somebody talking to their own Reason.
  const row = db.createCall(seen.conversationId, {
    provider: "elevenlabs",
    toNumber: address,
    isOwner: true,
    goal: `${person.name} called Reason`,
    facts: [],
    direction: "in",
    externalId: conversationId,
    // It is not placing and it is not ringing: somebody is about to be on it.
    state: "in_progress",
    // Nothing is recited at the person who set this up. They are told once, by text, the first time
    // their number ever calls — see `recordingNoteFor`.
    announcement: "",
  });
  accounts.countUse(seen.conversationId, "call");

  // The one text an owner call does produce: the first time this person's number ever rings, they are
  // told afterwards that calls are recorded and that they get the audio. Queued rather than sent, so
  // it costs the ring nothing, and once ever, so it is a disclosure rather than a nag.
  const note = recordingNoteFor({ conversationId: seen.conversationId, row, log });

  log({ call_inbound_known: seen.conversationId, call: row.id, told_recording: note.queued });
  // While it is still ringing, the model's cache is loaded with this call's prompt so the first turn
  // reads it warm (see `warmCallCache`). Not awaited: the ring owes this nothing.
  warm({ call: db.getCall(seen.conversationId, row.id) ?? row, log, now });
  return {
    status: 200,
    conversationId,
    body: {
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        // Their name, for an agent whose greeting template interpolates one. Reason's own opening is
        // the override below; this is for the platform's own copy of the same fact.
        owner_name: person.name,
        user_name: person.name,
        [`reason_call_id`]: row.id,
        [`reason_conversation_id`]: seen.conversationId,
        [`reason_kind`]: "owner",
      },
      conversation_config_override: {
        agent: {
          // What it says first, built from what is actually open rather than from a greeting. This is
          // the difference between their own Reason answering and a phone tree.
          first_message: openingLineFor({ person, conversationId: seen.conversationId, now }),
        },
        ...(config.elevenVoiceId ? { tts: { voice_id: config.elevenVoiceId } } : {}),
      },
      custom_llm_extra_body: {
        reason_call_id: row.id,
        reason_conversation_id: seen.conversationId,
        reason_kind: "owner",
      },
    },
  };
}

/**
 * Whose Reason is on the other end of this number, and is it answering?
 *
 * The thing this gets right that a straight `admit` would not: a call has no channel of its own, so
 * the conversation is found by the NUMBER (`accountByNumber`) and the call joins the Reason that
 * number already texts. Admitting a caller on a channel called "elevenlabs" would hand them a second,
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
    // overwriting it to "elevenlabs" would route every subsequent text (recording notes,
    // replies) to a channel that cannot send, and the disclosure text would fail.
    const existing = db.getAccount(conversationId);
    const channel = existing?.channel && existing.channel !== "console" ? existing.channel : "";
    db.upsertAccount({ conversationId, channel, address, name: config.ownerName, isOperator: true });
    return { allow: true, conversationId, isOperator: true };
  }

  const row = db.accountByNumber(address);
  if (row) {
    const state = row.state ?? "active";
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
export function callingBack(address, { within = CALLBACK_WINDOW_MS, now = clock.now() } = {}) {
  const number = String(address ?? "").trim();
  if (!number) return null;
  for (const call of db.callsToNumber(config.ownerConversation, { toNumber: number }).reverse()) {
    const when = Number(call.ended_at || call.updated_at || call.created_at || 0);
    if (when && now - when > within) continue;
    // A call that was already settled as "they said no" is not an open question. One that ran out of
    // hold, got voicemail, or dropped before it was confirmed is exactly the kind they ring back about.
    if (["refused_by_them", "confirmed"].includes(call.outcome_kind)) continue;
    return { call };
  }
  return null;
}

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
export function openingLineFor({ person }) {
  const lead = LEAD_INS[Math.floor(Math.random() * LEAD_INS.length)];
  const first = person.name && person.name !== "the person I work for" ? `hey ${person.name}` : "hey";
  return `${lead} ${first} — what's up?`;
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
 * A number with no account: one line, hang up, and the master is asked.
 *
 * Identical in policy to `handleUnknown` for a text, because it IS `handleUnknown` — the request
 * joins the same queue, the master is asked the same question with the same cooling-off rules, and
 * a yes there means their next call reaches their own Reason.
 *
 * The master's text is QUEUED, not sent. This is running while a phone rings; a channel that takes
 * two seconds would be two seconds of ringing, and the outbox pass picks it up well inside the call.
 */
function stranger({ address, router = null, log = () => {}, reason = "no_account_yet" }) {
  if (!address) {
    log({ call_inbound_withheld: true });
    return { status: 200, body: pitch({ reason: "withheld" }) };
  }

  // The request goes in on the TEXTING channel, not on the call provider's name. If the master says
  // yes, that is the channel their new Reason is set up on and the channel they are told yes over —
  // approving somebody onto "elevenlabs" would set up an account Reason cannot send a text to.
  const channel = liveTextingChannel(router);
  if (!channel) {
    // Nowhere to ask the master and nowhere to answer this person if the answer were yes. They still
    // get the one line; nothing is written down as a request nobody can act on.
    log({ call_inbound_unknown_no_channel: address });
    return { status: 200, body: pitch({ reason: "no_channel" }) };
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

  return { status: 200, body: pitch({ reason: seen.reason ?? reason }) };
}

/**
 * An unknown caller: Reason introduces itself and talks about trying it (src/calls/stranger.js). The
 * turns come to Reason's own endpoint marked `stranger`, where they get the pitch prompt, no tools and
 * nobody's data; `end_call` is the only tool the platform may run. Nothing here names anybody.
 */
function pitch({ reason }) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: { reason_kind: strangerCall.KIND, reason_why: reason },
    conversation_config_override: {
      agent: {
        first_message: strangerCall.introLine(),
        prompt: {
          prompt: "You are Reason, introducing yourself to somebody who rang. You know nothing about anybody.",
          tools: [{ type: "system", name: "end_call" }],
        },
      },
      ...(config.elevenVoiceId ? { tts: { voice_id: config.elevenVoiceId } } : {}),
    },
    custom_llm_extra_body: { reason_kind: strangerCall.KIND },
  };
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

/**
 * The answer that says: speak this one line, allow nothing else, and hang up.
 *
 * `end_call` is in the allowed tool list so the agent CAN hang up; `prompt` is replaced so there is
 * no model turn worth running behind it. Both together are what makes a stranger's call one line
 * rather than a conversation — and the prompt override is the half that matters, because an allowed
 * `end_call` on a full Reason would be a stranger talking to a full Reason that is also able to hang
 * up.
 */
function endItHere({ line, reason }) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: { reason_kind: "stranger", reason_why: reason },
    conversation_config_override: {
      agent: {
        first_message: line,
        prompt: {
          prompt: `Say nothing beyond the line you have already said. Whatever they say next, do not answer it:`
            + ` call the end_call tool immediately. You have no other tools and no information about anybody.`,
          tools: [{ type: "system", name: "end_call" }],
        },
      },
      ...(config.elevenVoiceId ? { tts: { voice_id: config.elevenVoiceId } } : {}),
    },
  };
}
