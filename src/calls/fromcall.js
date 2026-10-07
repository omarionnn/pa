// "Can you ring them for me?" — said to Reason on the phone, about somewhere else.
//
// From the 2026-10-07 addendum, section 8, and the biggest thing in it. He is on a call with his
// own Reason and asks it to go and call somewhere. What has to be true, in the order it has to be
// true in:
//
//   1. The errand is taken down WHILE STILL TALKING TO HIM, and he is not made to repeat it. Only
//      what is missing and matters is asked for: the number, what the call is for, what may be said
//      about him, and whether it may agree to anything.
//   2. The recipient and the brief are READ BACK before anything dials — casual discussion is not
//      approval; neither is the fact that he rang. Unless a standing permission covers that exact
//      kind of call, the dial waits for a yes to the read-back.
//   3. The dial is a SERVER-SIDE DECISION FROM A ROW, not a model command. The request is one
//      persisted row carrying the brief and the authorization state; code checks who may ask (the
//      owner, on an owner call, past the second check in ./verify.js), that the number is the one
//      that was reviewed, that nothing has changed since the review, that there is not already a
//      request open to that number, and that no earlier call already committed there. Then it goes
//      through `call_place` with every ordinary check on it — caps, quiet hours, never-twice, the
//      brief — on a confirmation row that records the spoken yes and what it was for.
//   4. He is told WHICH STATE it is in, in words — preparing, dialing, waiting, needs your word,
//      result — and a queued request is never described as a finished call.
//   5. He chooses: keep talking, or hang up and get the result by text. A conference or a bridge is
//      not promised, because nothing has verified that the platform can do one.
//   6. Stop means stop, before any new effect; and if something was already agreed, that is said
//      and the cancellation options come with it.
//   7. ONE result back into the same conversation when the outgoing call ends — that is the
//      existing post-call path, which already writes the transcript into the thread and tells him.
import { createHash } from "node:crypto";
import * as db from "../db.js";
import * as permissions from "../permissions.js";
import { normalizeTarget } from "../trust.js";
import { config, clock, normalizeNumber } from "../config.js";
import { buildBrief } from "./brief.js";
import { spokenPhone, spokenMoney } from "./readback.js";
import { LIVE_STATES } from "./provider.js";
import * as verify from "./verify.js";

/** The states, in order, and what each is called out loud. */
export const STATES = {
  preparing: "preparing — written down, waiting on your yes",
  dialing: "dialing",
  waiting: "on the call now",
  needs_your_word: "paused — it needs your word",
  result: "done — there's a result",
  cancelled: "cancelled",
};

export const MAKE_CALL_TOOL = {
  name: "make_a_call_for_me",
  description: "They are asking you, on this call, to ring somewhere ELSE for them — a restaurant, a garage, a clinic."
    + " Call this the moment you have the number and what the call is for; it writes the request down and hands you"
    + " the read-back to say to them. Nothing dials until they say yes to that read-back AND they have passed the"
    + " caller check. Ask only for what is missing and matters: the number (a name is not a number), what the call"
    + " should achieve, what may be said about them, and whether it may actually agree to something and up to"
    + " how much. Do not make them repeat what they already said.",
  input_schema: {
    type: "object",
    properties: {
      request_id: { type: "integer", description: "On the SECOND call only: the id from the first, once they have said yes to the read-back." },
      they_said_yes: { type: "boolean", description: "True only when they said yes to the read-back, out loud, just now." },
      to: { type: "string", description: "The number to ring, E.164: +12125551234. If they only gave a name, ask for the number." },
      name: { type: "string", description: "Who it is: 'the Thai place on 3rd', 'Dr Okafor's office'." },
      goal: { type: "string", description: "What the call is for, specific enough that the result settles it." },
      may_tell: { type: "array", items: { type: "string" }, description: "The ONLY things the call may say about them: a name, a party size, a number to hold it under." },
      may_book: { type: "boolean", description: "Whether the call may actually agree to something. Leave it out unless they said so." },
      max_price_cents: { type: "integer", description: "The most it may agree to spend, including fees, when it may book. 15000 for $150." },
      ask: { type: "array", items: { type: "string" }, description: "The questions it must come back with answers to." },
    },
  },
};

export const REQUEST_STATUS_TOOL = {
  name: "call_request_status",
  description: "Where the call you were asked to make has got to, in the words to say: preparing, dialing, on the call,"
    + " paused for their word, or done with a result. Use it whenever they ask how it is going. Never say it is"
    + " done, booked or answered unless this says so.",
  input_schema: {
    type: "object",
    properties: { request_id: { type: "integer", description: "From make_a_call_for_me. Leave it out for the latest." } },
  },
};

export const REQUEST_CANCEL_TOOL = {
  name: "call_request_cancel",
  description: "They said stop, never mind, don't ring them. Call this before saying anything is stopped: it tells you"
    + " whether nothing happened yet, whether the call is already going, or whether something was already agreed"
    + " and what they can do about it.",
  input_schema: {
    type: "object",
    properties: {
      request_id: { type: "integer", description: "From make_a_call_for_me. Leave it out for the latest." },
      why: { type: "string", description: "Their reason, in a phrase, if they gave one." },
    },
  },
};

export const FROM_CALL_TOOLS = [MAKE_CALL_TOOL, REQUEST_STATUS_TOOL, REQUEST_CANCEL_TOOL];

/** The hash a yes is tied to: the recipient and the brief as they were read back. Any change breaks it. */
export function reviewHashOf({ to, goal, facts = [], book = false, maxCents = null, ask = [] }) {
  return createHash("sha256")
    .update(JSON.stringify({ to, goal, facts, book: !!book, maxCents: maxCents ?? null, ask }))
    .digest("hex").slice(0, 24);
}

/** The read-back, built from the row so the model has nothing to compose and nothing to get wrong. */
export function reviewLine(req) {
  const b = req.brief ?? {};
  const who = req.name ? `${req.name} on ${spokenPhone(req.to_number)}` : spokenPhone(req.to_number);
  const facts = Array.isArray(b.facts) && b.facts.length ? `I can tell them ${b.facts.join(", ")}.` : `I won't say anything about you beyond that.`;
  const book = b.approved?.book
    ? (b.approved.maxCents != null ? `I may agree to it up to ${spokenMoney(b.approved.maxCents)}, and nothing past that.` : `I may agree to it; you have not given me a ceiling, so I'll check with you on any price.`)
    : `I'll only ask — I won't book or agree to anything.`;
  return `So I'd ring ${who}, to ${req.goal}. ${facts} ${book} Shall I?`;
}

/**
 * Step one: write the request down and hand back the read-back. Also what a second request to the
 * same number gets: the one already open, rather than a second row and eventually two calls.
 */
export function request({ call, input = {}, log = () => {} }) {
  if (!call?.is_owner) return { ok: false, error: "only the owner, on their own call, can ask for a call to be made" };
  const c = call.conversation_id;
  const to = normalizeNumber(input.to ?? "");
  const missing = [];
  if (!to) missing.push("the number");
  if (!String(input.goal ?? "").trim()) missing.push("what the call is for");
  if (missing.length) {
    return {
      ok: false, missing,
      say: `Not written down yet — ask them for ${missing.join(" and ")}, in one question, then call this again.`
        + (input.to && !to ? ` "${input.to}" is a name, not a number; a call needs digits.` : ""),
    };
  }

  const open = db.openCallRequests(c, { toNumber: to })[0];
  if (open) {
    log({ call_request_repeat: open.id });
    return { ok: true, request_id: open.id, state: open.state, already: true, say: `Already on it: that one is ${STATES[open.state]}. ${stateAdvice(open)}` };
  }

  const brief = buildBrief({
    goal: String(input.goal).trim(),
    facts: (input.may_tell ?? []).map(s => String(s).trim()).filter(Boolean),
    approved: { book: input.may_book === true, maxCents: input.max_price_cents ?? null, terms: [] },
    questions: input.ask ?? [],
    readBack: input.may_book === true ? ["date", "time", "price"] : [],
    returnNumber: config.elevenPhoneNumber || "",
    language: "en",
  });
  const hash = reviewHashOf({ to, goal: brief.goal, facts: brief.facts, book: brief.approved.book, maxCents: brief.approved.maxCents, ask: brief.questions });
  const task = db.createTask(c, {
    title: `ring ${input.name ? String(input.name).trim() : to}: ${brief.goal}`.slice(0, 120),
    goal: `asked on a call: ring ${to} to ${brief.goal}`,
    maxAttempts: 1,
  });
  const draft = { to_number: to, name: String(input.name ?? "").trim(), goal: brief.goal, brief };
  const review = reviewLine(draft);
  const row = db.createCallRequest(c, {
    askedOnCallId: call.id, toNumber: to, name: draft.name, goal: brief.goal, brief,
    taskId: task?.id ?? null, review, reviewHash: hash,
  });
  db.logTask(row.task_id, "progress", `read back to them on the call, waiting for a yes`);
  log({ call_request_opened: row.id, to, book: brief.approved.book });

  // A standing permission that covers exactly this kind of call skips the read-back's yes — "you
  // can ring the garage without asking" is a sentence he is entitled to have said — but not the
  // caller check, which is about who is holding the phone and not about what he once allowed.
  const standing = permissions.covering({ conversationId: c, action: "call_place", target: to, amountCents: brief.approved.maxCents ?? null });
  return {
    ok: true, request_id: row.id, state: "preparing",
    review,
    standing_permission: standing.ok ? standing.permission : null,
    say: standing.ok
      ? `Written down, and they have a standing permission that covers this ("${standing.permission.said}"), so no yes is needed.`
        + ` Say what you are about to do in one line, then call make_a_call_for_me again with request_id ${row.id} and they_said_yes true.`
      : `Written down. Read this back to them, close to word for word, and WAIT for their answer: "${review}"`
        + ` When they say yes, call make_a_call_for_me again with request_id ${row.id} and they_said_yes true. If they change anything, start a new request.`,
  };
}

/**
 * Step two: the dial, decided from the row.
 *
 * `dial` is the only way out of here and is injected by the voice turn: it runs `call_place` with a
 * confirmation that this function created, so every check that tool has stays on. This function
 * never touches a phone itself.
 */
export async function go({ call, requestId, saidYes = false, dial, log = () => {}, now = clock.now() }) {
  if (!call?.is_owner) return { ok: false, error: "only the owner, on their own call, can authorize a call" };
  const c = call.conversation_id;
  const req = db.getCallRequest(c, Number(requestId));
  if (!req) return { ok: false, error: `No request #${requestId} on this conversation.`, say: `There is no request with that id. Start again with make_a_call_for_me.` };
  if (req.state !== "preparing") {
    return { ok: false, state: req.state, say: `That one is already ${STATES[req.state]}. ${stateAdvice(req)}` };
  }

  // Who is on the phone, first. The yes is worth nothing until this has passed.
  if (!verify.isVerified(call)) {
    const r = verify.gateRefusal({ call, name: "make_a_call_for_me" });
    log({ call_request_unverified: req.id });
    return { ...r, request_id: req.id, state: "preparing" };
  }

  const standing = permissions.covering({ conversationId: c, action: "call_place", target: req.to_number, amountCents: req.brief?.approved?.maxCents ?? null });
  if (!saidYes && !standing.ok) {
    return { ok: false, request_id: req.id, state: "preparing", say: `Not without their yes to the read-back. Say it again if you need to: "${req.review}"` };
  }

  // The yes is tied to what was read back. If the row no longer hashes to the review — somebody
  // edited the brief between the read-back and now — the yes does not reach it.
  const b = req.brief ?? {};
  const hash = reviewHashOf({ to: req.to_number, goal: req.goal, facts: b.facts ?? [], book: b.approved?.book, maxCents: b.approved?.maxCents ?? null, ask: b.questions ?? [] });
  if (!req.review_hash || hash !== req.review_hash) {
    log({ call_request_review_drift: req.id });
    return { ok: false, request_id: req.id, state: "preparing", say: `What was read back no longer matches the request, so their yes does not cover it. Start a new request and read it back again.` };
  }

  // Never twice: a number that already has something agreed at it is not rung to agree again. The
  // same check call_place runs, but asked here so the answer is a sentence to him rather than a
  // refused dial after he has said yes.
  const agreed = db.commitmentsAtNumber(c, req.to_number).find(k => k.state === "committed");
  if (agreed && b.approved?.book) {
    db.updateCallRequest(c, req.id, { state: "cancelled", result: `not placed: ${agreed.what} is already agreed at that number` });
    log({ call_request_already_agreed: req.id, commitment: agreed.id });
    return { ok: false, request_id: req.id, state: "cancelled", say: `Nothing was dialed: something is already agreed at that number — ${agreed.what}. Say so, and ask whether they want to change it rather than book again.` };
  }

  // The spoken yes becomes a confirmation row with the evidence on it, so `call_place` goes through
  // its ordinary gate on a real yes rather than around it, and the ledger says what the yes was.
  const how = standing.ok && !saidYes ? `standing permission #${standing.permission.id}` : `spoken yes on call #${call.id}, caller verified by ${call.verified_how}`;
  const conf = db.askConfirmation({
    conversationId: c, action: "call_place", summary: req.review, stakes: b.approved?.book ? "may agree, within the ceiling" : "asking only",
    target: normalizeTarget(req.to_number), askedAfterMsgs: 0, taskId: req.task_id,
  });
  db.grantConfirmation(conf.id, how);
  db.updateCallRequest(c, req.id, { state: "dialing", authorized_at: now, authorized_how: how, confirmation_id: conf.id });

  let placed;
  try {
    placed = await dial({
      to: req.to_number, goal: req.goal, facts: b.facts ?? [],
      may_book: b.approved?.book === true, max_price_cents: b.approved?.maxCents ?? undefined,
      ask: b.questions ?? [], read_back: b.readBack ?? [], confirmation_id: conf.id, task_id: req.task_id ?? undefined,
    });
  } catch (e) {
    placed = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
  }
  if (!placed?.ok) {
    db.updateCallRequest(c, req.id, { state: "cancelled", result: `could not be placed: ${placed?.error ?? "unknown"}` });
    if (req.task_id) db.logTask(req.task_id, "call", `not placed: ${placed?.error ?? "unknown"}`);
    log({ call_request_not_placed: req.id, why: placed?.error });
    return { ok: false, request_id: req.id, state: "cancelled", say: `It did not go through: ${placed?.error ?? "no reason given"}. Nobody's phone rang. Say exactly that.` };
  }
  db.updateCallRequest(c, req.id, { placed_call_id: placed.call_id ?? null });
  if (req.task_id) db.logTask(req.task_id, "call", `placed call #${placed.call_id} to ${req.to_number}`);
  log({ call_request_dialing: req.id, call: placed.call_id });
  return {
    ok: true, request_id: req.id, state: "dialing", call_id: placed.call_id ?? null,
    say: `It is dialing now — that is all that is true yet: not answered, not done. Tell them, and give them the two choices:`
      + ` stay on with you and you will say when there is news, or hang up and get the result by text. Do NOT offer to`
      + ` join them onto that call or put the two calls together — that is not something you can do.`,
  };
}

/** Where a request is, read from the request and the outgoing call it placed. */
export function status({ call, requestId = null }) {
  const c = call.conversation_id;
  const req = requestId ? db.getCallRequest(c, Number(requestId)) : (db.openCallRequests(c)[0] ?? latest(c));
  if (!req) return { ok: false, say: `There is no call request on this conversation. If they asked for one, make_a_call_for_me is how it starts.` };
  const live = req.placed_call_id ? db.getCall(c, req.placed_call_id) : null;
  const state = stateOf(req, live);
  if (state !== req.state) db.updateCallRequest(c, req.id, { state });
  const bits = [`#${req.id}: ring ${req.name || req.to_number} to ${req.goal} — ${STATES[state]}.`];
  if (live?.hold_since) bits.push(`On hold at the moment.`);
  if (state === "needs_your_word") {
    const paused = db.callCommitments(c, live.id).find(k => k.state === "paused_for_owner");
    if (paused) bits.push(`It needs their word on: ${paused.what}${paused.total_cents != null ? ` at ${spokenMoney(paused.total_cents)}` : ""}. Their yes or no goes by text, not by voice here.`);
  }
  if (state === "result") bits.push(`What came of it: ${req.result || live?.summary || live?.outcome || "no summary yet"}.`);
  return { ok: true, request_id: req.id, state, call_id: live?.id ?? null, say: `${bits.join(" ")} ${stateAdvice({ ...req, state })}` };
}

/** Stop, before any new effect; and if there was one already, say what it was. */
export function cancel({ call, requestId = null, why = "", log = () => {} }) {
  const c = call.conversation_id;
  const req = requestId ? db.getCallRequest(c, Number(requestId)) : (db.openCallRequests(c)[0] ?? null);
  if (!req) return { ok: false, say: `There is nothing open to cancel. Say so plainly rather than saying it is cancelled.` };
  if (!["preparing", "dialing", "waiting", "needs_your_word"].includes(req.state)) {
    return { ok: false, state: req.state, say: `That one is already ${STATES[req.state]}; there is nothing to stop.` };
  }
  const live = req.placed_call_id ? db.getCall(c, req.placed_call_id) : null;
  const agreed = live ? db.callCommitments(c, live.id).find(k => k.state === "committed") : null;
  const note = why ? ` (${why})` : "";

  if (!live) {
    db.updateCallRequest(c, req.id, { state: "cancelled", result: `cancelled before dialing${note}` });
    if (req.task_id) db.updateTask(c, req.task_id, { state: "cancelled", progress: `cancelled on the call before dialing${note}` });
    log({ call_request_cancelled: req.id, before: "dial" });
    return { ok: true, request_id: req.id, state: "cancelled", say: `Stopped. Nothing was dialed and nobody was rung. Say exactly that.` };
  }

  // The call is already going. It cannot be told to agree to anything from here on: the brief on
  // its row loses `book`, which is the thing the commitment gate reads.
  const brief = { ...(live.brief ? JSON.parse(live.brief) : {}) };
  if (brief.approved) brief.approved = { ...brief.approved, book: false };
  db.updateCall(c, live.id, { brief: JSON.stringify(brief) });
  db.updateCallRequest(c, req.id, { state: "cancelled", result: agreed ? `stopped after ${agreed.what} was agreed${note}` : `stopped while the call was going${note}` });
  if (req.task_id) db.updateTask(c, req.task_id, { state: "cancelled", progress: `stopped on the call${agreed ? ` after something was agreed` : ""}${note}` });
  log({ call_request_cancelled: req.id, before: agreed ? "nothing — already agreed" : "any agreement", call: live.id });
  return agreed
    ? {
      ok: true, request_id: req.id, state: "cancelled", already_agreed: agreed.what,
      say: `Too late for nothing to have happened: ${agreed.what} was already agreed on that call${agreed.reference ? ` (reference ${agreed.reference})` : ""}.`
        + ` Say so plainly. Their options are to leave it, or to have it cancelled with the place — which is a new call, not something this one undoes.`,
    }
    : {
      ok: true, request_id: req.id, state: "cancelled",
      say: `The call is already going, and from now it may not agree to anything — it will only ask, and ring off. Say that: it was already on the phone, nothing is agreed, and nothing will be.`,
    };
}

/**
 * The outgoing call ended. Called from the post-call path, so the request's state and result come
 * from the row that was written at the end of the call and not from anything the model said.
 */
export function onCallEnded(row, { log = () => {} } = {}) {
  if (!row?.id) return { ok: false };
  const req = db.callRequestForCall(row.conversation_id, row.id);
  if (!req) return { ok: false, why: "not a requested call" };
  if (req.state === "cancelled") return { ok: true, state: "cancelled" };
  const result = [row.outcome, row.summary].map(s => String(s ?? "").trim()).filter(Boolean).join(" — ") || row.state;
  db.updateCallRequest(row.conversation_id, req.id, { state: "result", result });
  if (req.task_id) db.updateTask(row.conversation_id, req.task_id, { state: "done", progress: `the call ended: ${result}` });
  log({ call_request_result: req.id, call: row.id });
  return { ok: true, state: "result", result };
}

// ---------- helpers ----------

function latest(c) {
  const r = db.db.prepare("SELECT * FROM call_requests WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(c);
  return r ? { ...r, brief: JSON.parse(r.brief || "{}") } : null;
}

/** The state as the rows say it is now, not as it was last written. */
export function stateOf(req, live) {
  if (req.state === "cancelled" || req.state === "preparing") return req.state;
  if (!live) return req.state;
  if (LIVE_STATES.includes(live.state)) {
    const paused = db.callCommitments(req.conversation_id, live.id).some(k => k.state === "paused_for_owner");
    if (paused) return "needs_your_word";
    return live.state === "in_progress" ? "waiting" : "dialing";
  }
  return "result";
}

function stateAdvice(req) {
  switch (req.state) {
    case "preparing": return `Nothing has dialed. They can still change anything or drop it.`;
    case "dialing": case "waiting": return `They can stay on and you will say when there is news, or hang up and get the result by text. Do not offer to join them onto it.`;
    case "needs_your_word": return `Nothing will be agreed until they answer the text. Do not take their answer by voice here.`;
    case "result": return `Say what came of it in one or two sentences, only what is in the result, and whether anything still needs them.`;
    case "cancelled": return `It is stopped. Say what did and did not happen, exactly as the result says.`;
    default: return ``;
  }
}
