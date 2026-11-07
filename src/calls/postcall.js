// The call is over. This is what Reason does about it.
//
// ElevenLabs sends three post-call webhooks, HMAC-signed in `ElevenLabs-Signature`
// ("Post-call webhooks", read 2026-10-05):
//
//   post_call_transcription    the conversation, with the transcript and the metadata
//   post_call_audio            the audio, base64, for an account configured to get it that way
//   call_initiation_failure    the call never happened at all
//
// Four things happen here and each is the answer to a way a call can quietly go wrong:
//
//   1. **The transcript becomes part of the conversation.** Written into the person's own thread as
//      real turns, so a text ten minutes later continues what was said on the phone instead of
//      starting again. This is the thing that makes a call part of Reason rather than a feature
//      beside it.
//   2. **The audio is filed, or its absence is reported.** Through `settleCall`, which is the same
//      function `call_status` and Bland's webhook use, so a call that was pushed and a call that was
//      polled produce the same row. Every call is recorded; a call that was answered and has no audio
//      is a fault the owner is told about, not a shrug.
//   3. **Voicemail is not a conversation.** An outbound call that reached an answering machine had
//      nobody on it, and filing it as a conversation would tell the owner their message was heard by
//      a person. The transcript of a voicemail greeting is NOT written into anybody's thread.
//   4. **A job hears what its own call said.** A call placed as a step of a task is stamped with that
//      task (`calls.task_id`), and the outcome goes onto the task's log — so the job knows, four
//      hours and sixty trimmed messages later, what the call came back with.
//
// Nothing here has run against the real platform. The signature scheme, the event names and the
// field names are from their docs; which of `metadata.termination_reason` and friends really carries
// "voicemail" is the one that most needs proving on Friday, and it is in docs/unverified.md.
import * as strangerCalls from "../strangercalls.js";
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config, clock, stamp } from "../config.js";
import { LIVE_STATES, SPOKE_TO_SOMETHING } from "./provider.js";
import { mimeFor } from "./recordings.js";
import * as fromcall from "./fromcall.js";
import * as callOutcome from "./outcome.js";
import { endFieldsFor } from "./metrics.js";

/** The route ElevenLabs is pointed at for post-call deliveries. Quoted in the setup checklist. */
export const POST_CALL_PATH = "/calls/elevenlabs/post-call";

/**
 * One post-call delivery.
 *
 * `settle` is `settleCall` from src/tools.js, injected rather than imported: this module is loaded by
 * http.js, by tests and by the rehearsal harness, and src/tools.js pulls in most of the codebase.
 * Same reason `storeAudio` is injectable.
 *
 * Returns `{ status, body }`. A rejected signature is a 401 and nothing is written — a delivery that
 * writes a transcript into somebody's own thread is not something to take on trust.
 */
export async function postCallRequest({
  rawBody, headers, provider = null, runtime = null, log = () => {},
  settle = null, fetchImpl = null, now = clock.now(),
}) {
  const st = provider?.status?.();
  if (!provider || typeof provider.receiveWebhook !== "function" || st?.name !== "elevenlabs") {
    return { status: 404, body: { error: "not found" } };
  }

  const parsed = provider.receiveWebhook({ rawBody, headers, now });
  if (!parsed.ok) {
    log({ post_call_rejected: parsed.error });
    return { status: parsed.status ?? 401, body: { error: parsed.error } };
  }

  // The call this is about, by the platform's own conversation id. Nothing else in the body is used
  // to decide which row gets written to.
  const row = parsed.externalId ? db.callByExternalId("elevenlabs", parsed.externalId) : null;
  if (!row) {
    // Acknowledged so they stop retrying — there is nothing wrong with the delivery, Reason simply
    // has no call under that id, which is what a conversation started outside Reason looks like.
    log({ post_call_unknown: parsed.externalId, type: parsed.type });
    // An unknown caller's call has no row, only its stranger_calls entry: its real length and words.
    if (parsed.type !== "post_call_audio" && parsed.live) {
      try { if (strangerCalls.settleFromPostCall({ externalId: parsed.externalId, live: parsed.live, now })) log({ stranger_call_settled: parsed.externalId }); } catch { /* acknowledged anyway */ }
    }
    return { status: 200, body: { ok: true, known: false, type: parsed.type } };
  }

  if (parsed.type === "post_call_audio") {
    const out = await fileAudioFromWebhook({ row, base64: parsed.audioBase64, log });
    return { status: 200, body: { ok: out.ok, call_id: row.id, type: parsed.type, recording: out.state, ...(out.error ? { error: out.error } : {}) } };
  }

  const live = parsed.live;
  if (!live) return { status: 200, body: { ok: true, call_id: row.id, type: parsed.type, nothing: true } };

  // Nothing has finished. Acknowledged so they stop retrying, and nothing written: a call still going
  // has no outcome to write.
  if (LIVE_STATES.includes(live.state)) {
    return { status: 200, body: { ok: true, call_id: row.id, state: live.state } };
  }
  // Already settled. Providers retry, and settling twice would count the same minutes twice and
  // write the same transcript into the thread again.
  if (!LIVE_STATES.includes(row.state) && row.recording_state !== "pending") {
    // Except for the record of how it ended: the lost-calls sweep writes 'lost' when nobody has said,
    // and a delivery that arrives after it is somebody saying. Only the end reason and the platform's
    // cost are filled — nothing is settled twice.
    if (row.end_reason === "lost") lateEnd({ row, live, log });
    return { status: 200, body: { ok: true, call_id: row.id, state: row.state, already: true } };
  }

  // One place where a call's outcome is written down, whoever found out. Counts the minutes against
  // the person's day and files the audio or reports its absence.
  const settled = settle
    ? await settle(row.conversation_id, row, live, fetchImpl ? { fetchImpl } : {})
    : row;
  // Stamped in the same tick as the steps up to the owner's turn, so a restart from here on finds a
  // call with only that turn left (see resumeSettles).
  db.updateCall(settled.conversation_id, settled.id, { settle_started_at: clock.now() });

  const wrote = writeCallIntoThread({ row: settled, live, log });
  noteThirdPartyTurns({ row: settled, live });
  const noted = noteOnTask({ row: settled, live, log });
  // A call he asked for BY VOICE, mid-call, closes its request here (2026-10-07 addendum, section 8:
  // "one result back into the same conversation"). From the settled row, so what the request ends up
  // saying is what the call record says and not what any model reported about it. A call nobody
  // requested this way is not one of these, and `onCallEnded` says so and does nothing.
  const request = fromcall.onCallEnded(settled, { log });
  const told = await tellTheOwner({ row: settled, live, runtime, log });
  db.updateCall(settled.conversation_id, settled.id, { settled_at: clock.now() });

  log({
    post_call: row.id, state: settled.state, recording: settled.recording_state,
    turns_written: wrote.turns, told: told.sent, task: noted.taskId ?? null,
    ...(request.ok ? { call_request: request.state } : {}),
  });
  return {
    status: 200,
    body: {
      ok: true, call_id: row.id, type: parsed.type, state: settled.state,
      recording: settled.recording_state, turns_written: wrote.turns, told_owner: told.sent,
      // Only on a call he asked for by voice mid-call, and absent on every other call rather than
      // reported as a request in no state.
      ...(request.ok ? { call_request: request.state } : {}),
    },
  };
}

/**
 * At boot: the calls a restart cut off between the thread and the owner's turn, finished once.
 *
 * Call 57 (2026-10-31): end_call at 19:33:54, a deploy restarted the service at 19:34:06, and the
 * turn that sends the summary and the audio died with it. The row, the thread and the task note are
 * written in one tick with `settle_started_at` (both providers), so what is left is `tellTheOwner`
 * alone; it runs once per call (`settle_resumes`), and not at all when the owner was already told.
 * The call's words come back off the row's own transcript. Run after the port is open: Sendblue
 * fetches the audio from this process.
 */
export async function resumeSettles({ runtime, log = () => {}, now = clock.now(), withinMs = 24 * 60 * 60 * 1000 } = {}) {
  const resumed = [];
  for (const row of db.callsToResumeSettle(now - withinMs)) {
    db.updateCall(row.conversation_id, row.id, { settle_resumes: (row.settle_resumes ?? 0) + 1 });
    try {
      if (!row.told_at) {
        const live = {
          turns: turnsFromTranscriptString(row.transcript ?? ""), transcript: row.transcript ?? "",
          summary: row.summary ?? "", outcome: row.outcome ?? "", cutOff: null,
        };
        await tellTheOwner({ row, live, runtime, log });
      }
      db.updateCall(row.conversation_id, row.id, { settled_at: clock.now() });
      log({ call_settle_resumed: row.id, provider: row.provider });
      resumed.push(row.id);
    } catch (e) {
      log({ call_settle_resume_failed: row.id, why: (e?.message ?? String(e)).split("\n")[0] });
    }
  }
  return resumed;
}

/** A late delivery's end reason and cost onto a row the sweep wrote off as lost. */
function lateEnd({ row, live, log = () => {} }) {
  let turns = [];
  try { turns = db.callTurns(row.id); } catch { /* no turns is no evidence */ }
  const end = endFieldsFor(row, live, turns);
  if (!end.end_reason) return;
  db.updateCall(row.conversation_id, row.id, {
    end_reason: end.end_reason, end_detail: end.end_detail,
    ...(row.cost_credits == null && end.cost_credits != null ? { cost_credits: end.cost_credits } : {}),
    ...(!row.cost_raw && end.cost_raw ? { cost_raw: end.cost_raw } : {}),
    ...(row.cost_cents == null && Number.isFinite(live.costCents) ? { cost_cents: live.costCents } : {}),
  });
  log({ call_end_corrected: row.id, from: "lost", to: end.end_reason });
}

/**
 * The call, written into the person's thread as turns.
 *
 * This is the whole of "a text ten minutes later continues the call". The turns go in in the shape
 * the thread already uses — a stamped line for them, plain text for Reason — so the next turn's model
 * reads the call exactly as it reads the messages around it.
 *
 * Three calls are deliberately NOT written:
 *
 *   - **A third-party call.** The restaurant is not in this conversation. What the owner gets is the
 *     summary, the outcome and the audio (see `tellTheOwner`), which is what they got before any of
 *     this existed. Writing the restaurant's half into their thread as though they had said it would
 *     make "you told me Thursday" a thing Reason could believe about the wrong person.
 *   - **A voicemail.** Nobody was on it. An answering machine's greeting written in as turns is a
 *     conversation that did not happen.
 *   - **A call that never connected.** Same reason, with nothing even said.
 */
/**
 * Third-party calls: the transcript doesn't go into conversations.messages but should feed memory.
 * Not when only a machine answered: a recording's opening hours are not something a person said.
 * Both voices (ElevenLabs' delivery here, GPT-Live's `settleGptLive`).
 */
export function noteThirdPartyTurns({ row, live }) {
  if (row.is_owner || !SPOKE_TO_SOMETHING.includes(row.state) || callOutcome.answeredByMachine(row)) return 0;
  const turns = Array.isArray(live?.turns) && live.turns.length
    ? live.turns
    : turnsFromTranscriptString(live?.transcript ?? row.transcript ?? "");
  let n = 0;
  for (const t of turns) {
    try {
      const evId = db.writeEvent({
        conversationId: row.conversation_id, channel: "call",
        messageId: String(row.id),
        role: t.who === "them" ? "call_user" : "call_assistant",
        content: t.text,
      });
      n++;
      if (worthExtracting(t.text)) db.enqueueExtraction(row.conversation_id, evId);
    } catch { /* best-effort */ }
  }
  return n;
}

export function writeCallIntoThread({ row, live, log = () => {} }) {
  if (!row.is_owner) return { turns: 0, why: "a third-party call is not part of this conversation" };
  if (row.state === "voicemail") return { turns: 0, why: "it went to voicemail, so there was no conversation" };
  if (!SPOKE_TO_SOMETHING.includes(row.state)) return { turns: 0, why: `the call ${row.state}, so nothing was said` };

  // The structured turns the provider read off the payload, or — for a payload that only carried
  // the string — the string parsed back. The structured ones are preferred because a turn with a
  // newline in it survives them and does not survive the string.
  const all = Array.isArray(live?.turns) && live.turns.length
    ? live.turns
    : turnsFromTranscriptString(live?.transcript ?? row.transcript ?? "");
  if (!all.length) return { turns: 0, why: "there was no transcript to write" };

  const who = accounts.ownerOf(row.conversation_id);
  const at = row.ended_at ?? clock.now();
  const messages = db.loadConversation(row.conversation_id);

  // One line saying what this is, so a model reading the thread back knows these words were spoken on
  // a phone rather than typed. Without it, "see you at eight" reads as a text that was never sent.
  messages.push({
    role: "user",
    content: `[${stamp(at)}] [on a phone call with ${who.name}, ${row.direction === "in" ? "they called" : "you rang them"}${row.duration_s ? `, ${Math.round(row.duration_s)}s` : ""}]`,
  });
  for (const t of all) {
    if (t.who === "them") messages.push({ role: "user", content: `[${stamp(at)}] ${who.name} (on the call): ${t.text}` });
    else messages.push({ role: "assistant", content: t.text });
  }
  // What was really looked up on the call, so the texts after it do not "correct" an answer that was
  // checked. Call 41 (2026-10-23): the thread only had the spoken words, and the next turn took a real
  // Kitco gold price for a made-up one.
  const lookups = db.callLookups(row);
  if (lookups.length) {
    messages.push({
      role: "user",
      content: `[${stamp(at)}] [your own record of that call, kept by code: the lookups you really ran on it — `
        + lookups.map(l => `${l.name} ${l.input}${l.ok ? "" : " (failed)"}`).join("; ")
        + `. What you said from them was checked.]`,
    });
  }
  // A thread must not end on a user turn that nothing answered, or the next turn reads as a reply to
  // the last thing said on the phone rather than to their new message.
  if (messages[messages.length - 1]?.role === "user") {
    messages.push({ role: "assistant", content: "(that was the end of the call)" });
  }

  db.saveConversation(row.conversation_id, messages);
  // Write call transcript turns into event_log for extraction.
  for (const t of all) {
    try {
      const evId = db.writeEvent({
        conversationId: row.conversation_id, channel: "call",
        messageId: String(row.id),
        role: t.who === "them" ? "call_user" : "call_assistant",
        content: t.text,
      });
      if (worthExtracting(t.text)) db.enqueueExtraction(row.conversation_id, evId);
    } catch { /* best-effort */ }
  }
  log({ call_written_into_thread: row.id, turns: all.length });
  return { turns: all.length };
}

const MIN_EXTRACT_CHARS = 12;
const FILLER = /^(\(.*\)|okay|ok|yeah|yep|uh-huh|mm-hmm|mhm|right|sure|got it|bye|hello|hi|hey)\.?$/i;
export function worthExtracting(text) {
  const s = String(text ?? "").trim();
  return s.length >= MIN_EXTRACT_CHARS && !FILLER.test(s);
}

/** A two-speaker transcript string back into turns, for a payload that only carried the string. */
export function turnsFromTranscriptString(text) {
  return String(text ?? "").split("\n").map(line => {
    const m = /^(Them|Reason)\s*:\s*(.+)$/.exec(line.trim());
    if (!m) return null;
    return { who: m[1] === "Them" ? "them" : "reason", text: m[2].trim() };
  }).filter(Boolean);
}

/**
 * The outcome, onto the job this call was a step of.
 *
 * A job whose own log does not say what its call came back with is a job that has to be told again by
 * somebody. The line is short and factual — the task's own sheet is where the model writes what it
 * MEANS, on the next wake; this is only the record that the call happened and how it went.
 */
export function noteOnTask({ row, live, log = () => {} }) {
  if (!row.task_id) return { taskId: null };
  const task = db.getTask(row.conversation_id, row.task_id);
  if (!task) return { taskId: null, why: "the job is gone" };
  const what = [row.outcome || live?.outcome, row.summary || live?.summary].map(s => String(s ?? "").trim()).filter(Boolean).join(" — ");
  db.logTask(row.task_id, "call", `called ${row.to_number}: ${what || row.state}`);
  log({ call_noted_on_task: row.task_id, call: row.id });
  return { taskId: row.task_id };
}

/**
 * What the owner hears, and when.
 *
 * Both kinds go out as an EVENT TURN rather than as a line this module writes, and that is the whole
 * design decision here. Reason is told what happened and decides what, if anything, to say — which
 * gets two things for free that a hand-written line would not:
 *
 *   - **The audio rides out attached.** `Runtime._emit` reads the queue off the calls table, so the
 *     recording goes with the message about THIS call (`forCall`), attached by code rather than by
 *     the model remembering. `say` bypasses that path; an event turn does not.
 *   - **Silence is available.** An event turn may answer NO_REPLY, and after their own call that is
 *     usually the right answer: they were just on it, and recounting it back to them is the kind of
 *     thing that makes a product feel like it is talking to itself. The recording then goes on its
 *     own (flushRecording) rather than riding on whatever message happens to leave next.
 *
 * The two differ in what the event SAYS, because they leave the owner needing different things: work
 * done out of their sight needs reporting, and a conversation they were just in does not.
 */
export async function tellTheOwner({ row, live, runtime = null, log = () => {} }) {
  if (!runtime?.event) return { sent: false, why: "nothing to say it through" };

  if (!row.is_owner) {
    // Work Reason did out of their sight. An interruption on the operator's bill, so it is held to
    // the same daily ceiling as anything else Reason starts.
    if (runtime.mayInterrupt && !runtime.mayInterrupt(row.conversation_id)) {
      log({ call_recap_capped: row.id });
      return { sent: false, why: "their proactive limit for today is used up" };
    }
    const reply = await runtime.event(row.conversation_id, thirdPartyEvent({ row, live }), { forCall: row.id });
    if (reply) {
      accounts.countUse(row.conversation_id, "proactive");
      db.updateCall(row.conversation_id, row.id, { told_at: clock.now() });
    }
    log({ call_told_owner: row.id, said: !!reply });
    return { sent: !!reply };
  }

  // Their own call. Nothing at all when nobody was on it: Reason ringing them and them not picking
  // up is not news that needs a text.
  if (!SPOKE_TO_SOMETHING.includes(row.state) || row.state === "voicemail") return { sent: false, why: "nobody was on it" };
  // Not counted against their day. They were on the phone with it thirty seconds ago; a line that
  // finishes that conversation is not Reason starting one.
  // An unverified caller's ask waits for a yes typed on their own phone: nothing standing covers it.
  const reply = await runtime.event(row.conversation_id, ownerEvent({ row, live }), { forCall: row.id },
    String(row.verify_deferred ?? "").trim() ? { onlyAnExplicitYes: true } : null);
  if (reply) {
    db.updateCall(row.conversation_id, row.id, { told_at: clock.now() });
  } else if (row.recording_state === "stored" && runtime.flushRecording) {
    // The model said nothing — silence after your own call is right. But the recording
    // is owed. Send it now rather than letting it ride on the next unrelated message.
    const mins = row.duration_s ? Math.max(1, Math.round(row.duration_s / 60)) : null;
    await runtime.flushRecording(
      row.conversation_id,
      mins ? `your call — ${mins} min` : `your call`,
      { forCall: row.id },
    );
  }
  log({ call_after_note: row.id, said: !!reply });
  return { sent: !!reply };
}

/**
 * What Reason is told about a call it made for somebody, so it can report it in its own words.
 *
 * The transcript goes in whole. It is the only record of what was actually said, and a summary of a
 * summary is how "they said Thursday or Friday" becomes "they said Thursday".
 */
export function thirdPartyEvent({ row, live }) {
  const what = String(row.summary || live?.summary || "").trim();
  const outcome = String(row.outcome || live?.outcome || row.state).trim();
  const audio = row.recording_state === "stored"
    ? `The recording is saved and goes out attached to this message automatically — you do not attach it and you may say it is there.`
    : row.recording_state === "missing"
      ? `There is NO audio for this call: ${row.recording_why || "the provider never gave it to Reason"}. Every call is meant to be recorded, so say that plainly rather than implying a recording exists.`
      : `There is no audio, because nobody was on the call.`;
  // Only a machine answered (2026-10-27, call 45). Said outright, because the transcript's "Them:"
  // lines read like a person, and the next step is whatever the recording offered instead of a person.
  const heard = String(row.machine_heard ?? "").trim();
  const machine = callOutcome.answeredByMachine(row) && row.outcome_kind !== "voicemail_left"
    ? `\nNo person was reached: only a machine answered (${callOutcome.OUTCOMES[row.outcome_kind].label}).`
      + `${heard ? ` What the recording said that matters: ${heard}` : ""}`
      + ` If it gave another way to reach them — an email address, a website, hours to ring back — that is the next step: offer it.`
    : "";
  return `the call you placed to ${row.to_number} has ended. goal: ${row.goal}.`
    + ` outcome: ${outcome}.${what ? ` summary: ${what}${/[.!?]$/.test(what) ? "" : "."}` : ""}${machine}`
    + `${row.duration_s ? ` it ran ${Math.round(row.duration_s)} seconds.` : ""}`
    + `\nwhat was actually said:\n${row.transcript || live?.transcript || "(no transcript came back)"}`
    // How it went on Reason's side, from the call's own clock (gptlive \`howItWent\`). Call 59's recap
    // blamed "a bad line" for what was Reason's 8 s first reply and replies cutting each other off.
    + `${live?.howItWent ? `\nhow it went on Reason's side, measured on the call: ${live.howItWent}.` : ""}`
    + `\nNever guess a cause the transcript and those facts don't show — not a bad line, not that they couldn't hear.`
    + ` If it went badly because of Reason (slow to answer, talking over them, repeating itself), say that plainly as Reason's fault.`
    + `\n${audio}`
    + `\nTell them what came of it in your own words, short, and only what the transcript really says.`
    + ` If it did not get the answer it was for, say so rather than rounding it up.`
    + ` If payment was asked for, that is the thing to lead with.`
    // His standing message format (2026-10-07 addendum, section 12), which the errand summary and the
    // commitment ask already follow. Said here because a single call's result is the one that used to
    // come back as a paragraph, and a paragraph is where "they need a deposit" goes unnoticed.
    + `\nShape it the way he reads things: the first lines are what happened and what it means for him,`
    + ` as plain "- " lines when they really are separate points, with the one thing that needs HIS word`
    + ` last and as a question. Anything technical goes underneath, if it goes in at all.`
    + ` A link, an address or a reference number does not go in this message: say you are sending it`
    + ` and it goes out on its own.`;
}

/**
 * What Reason is told after a call with its own person.
 *
 * Mostly an instruction to say nothing. They were there. Anything with characters in it — a link, an
 * address — already left during the call through the outbox (`queueMidCall` in ./voice.js), so there
 * is rarely anything owed; the two cases where there is are an unkept promise and missing audio.
 */
export function ownerEvent({ row, live = null }) {
  const mins = row.duration_s ? Math.max(1, Math.round(row.duration_s / 60)) : 0;
  const audio = row.recording_state === "stored"
    ? `The audio is saved and goes out attached to the message you send about this call, automatically. Do not attach it yourself.`
    : row.recording_state === "missing"
      ? `There is NO audio for it: ${row.recording_why || "it never came back from the provider"}. Every call is recorded and they were told that, so this one is worth a short honest line.`
      : "";
  // Call 56 (2026-10-31): "Want me to check live train status right before you go?" — "Yeah" — "Okay."
  // The yes never reached Reason on the call; this is where it is caught (GPT-Live calls, owner-only).
  const cut = live?.cutOff;
  return `your call with them just ended${mins ? ` — about ${mins} minute${mins === 1 ? "" : "s"}` : ""}.`
    + ` what was said on it is already in this conversation above, so do NOT recount it to them: they were on the call.`
    + ` ${audio}`
    + `\nSay something ONLY if something is genuinely owed — you promised to send something and it has not gone,`
    + ` or there is no audio for a call they were told was recorded. Otherwise reply NO_REPLY.`
    + ` A friendly sign-off is not news.`
    + (row.provider === "gptlive"
      ? `\nIf on the call they said yes to something you offered to do later (a check before they leave, a reminder) and it is`
        + ` not set up yet, set it up now with your tools and say so in one line; if you can't, say that instead.`
      : "")
    + (String(row.verify_deferred ?? "").trim()
      ? `\nSomething IS owed: on the call they asked for something that could not be done by voice and waits for this text:`
        + ` "${String(row.verify_deferred).replace(/"/g, "'")}". Pick it up now, in one short message: the caller was not verified,`
        + ` so ask for their yes here before doing anything with it (this text goes to their own phone) — a lookup that changes nothing and reaches nobody may be done and said;`
        + ` anything that texts, calls, books, buys or changes something waits for that yes, even if they gave you a standing permission.`
      : "")
    + (cut
      ? `\nSomething IS owed: they started saying something just as the call ended${cut.words ? ` (all that came through: "${String(cut.words).replace(/"/g, "'")}")` : ""}`
        + ` and it was cut off. Send one short, warm line saying it sounded like they were saying something as you hung up, and ask what it was.`
      : "");
}

/**
 * The audio off a `post_call_audio` delivery, filed as the file Reason owns.
 *
 * The base64 is written to a temp file and handed to the same `storeRecording` every other recording
 * goes through, which is what sniffs the bytes. The Bland lesson applies here with nothing changed:
 * a body that is not audio must not become `call-7.mp3` and be reported as saved, and the only thing
 * that can tell is the bytes.
 */
export async function fileAudioFromWebhook({ row, base64, log = () => {} }) {
  if (row.recording_state === "stored") return { ok: true, state: "stored", already: true };
  if (!base64 || typeof base64 !== "string") {
    return { ok: false, state: row.recording_state, error: "the delivery carried no audio" };
  }
  const { storeRecording } = await import("./recordings.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  let dir = null;
  try {
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) return { ok: false, state: row.recording_state, error: "the audio in the delivery was empty" };
    dir = mkdtempSync(join(tmpdir(), "reason-call-audio-"));
    // `.mp3` is a guess and is treated as one: `storeRecording` names the file for what the bytes
    // really are and refuses anything that is not audio at all.
    const tmp = join(dir, `call-${row.id}.mp3`);
    writeFileSync(tmp, bytes);
    const saved = await storeRecording(row.id, { path: tmp, format: "mp3", seconds: row.duration_s ?? undefined });
    if (!saved.ok) {
      db.updateCall(row.conversation_id, row.id, { recording_state: "missing", recording_why: saved.error });
      log({ call_audio_webhook_refused: row.id, why: saved.error });
      return { ok: false, state: "missing", error: saved.error };
    }
    db.updateCall(row.conversation_id, row.id, {
      recording_state: "stored", recording_file: saved.file, recording_format: saved.format,
      recording_seconds: saved.seconds ?? row.duration_s ?? null, recording_bytes: saved.bytes,
      recording_sha256: saved.sha256, recording_why: "",
    });
    log({ call_audio_webhook_stored: row.id, bytes: saved.bytes, format: saved.format, mime: mimeFor(saved.format) });
    return { ok: true, state: "stored", bytes: saved.bytes, format: saved.format };
  } catch (e) {
    const why = (e?.message ?? String(e)).split("\n")[0];
    log({ call_audio_webhook_threw: row.id, why });
    return { ok: false, state: row.recording_state, error: why };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir is not worth failing over */ } }
  }
}

/** Only here so a caller can log the install's owner name without importing config itself. */
export const ownerName = () => config.ownerName;
