// Getting a Reason of your own: you text the number, and the master says yes.
//
// Anyone may text Reason. What they must not be able to do is spend the master's money, or put
// their words in front of the model, before the master has agreed. So an unknown number's first
// message is **written down as a quote, not run as a turn**, and the master is asked in plain
// words whether to let them in.
//
// The master answers however people answer — "yeah go on", "no thanks", "who's that?" — so what
// their reply *means* is read by the same judge the confirm gate uses everywhere else, and every
// fact a model cannot be trusted with is enforced here in code:
//
//   - the reply has to be a real new message from the master's own number, after the ask;
//   - it is tied to **one** request, so a yes can never let in somebody it was not about;
//   - single use, with an expiry;
//   - only the master's number can approve — nobody can approve themselves, and nobody else's
//     "yes let them in" counts for anything at all.
//
// And the limits that stop this becoming a way to harass the master: a declined number is not
// announced again for a cool-off, only one request is in front of the master at a time, there is
// an hourly ceiling on how many get put to them, and a number already waiting is told so once
// rather than on every message.
import * as db from "./db.js";
import * as trust from "./trust.js";
import * as accounts from "./accounts.js";
import { servesOnThisBackend } from "./backends/guard.js";
import { config, clock, normalizeNumber, stamp } from "./config.js";

/**
 * The one thing a brand-new person is told about how to talk to Reason.
 *
 * Omari's line, 2026-10-07: "give me a messy goal rather than a perfect prompt." It is here, in the
 * first message somebody ever gets, because the cost of not saying it is paid immediately and
 * invisibly — somebody who thinks they are talking to a prompt box writes a careful paragraph, gets
 * a careful answer, and never finds out they could have said "sort my drive out". Said once, in
 * Reason's own words, as part of the hello rather than as a line of instructions.
 *
 * One sentence on purpose: it rides on a message that is already doing a job, and a tip that doubles
 * the length of somebody's welcome text is a tip nobody reads. It is also exported rather than
 * written twice, because the capabilities summary says the same thing to the model (src/tools.js)
 * and the two drifting apart would mean Reason promising one way of working and behaving another.
 */
export const MESSY_GOAL_LINE =
  "and you don't have to word it perfectly — tell me the messy version, i'll work out what i can on my own"
  + " and only come back to u for the calls that are actually yours. what's up?";

/** Only one request is ever in front of the master, so "which one did that yes mean" has an answer. */
export function requestInFrontOfMaster() {
  return db.announcedRequest();
}

/**
 * What to do about a message from a number with no account.
 *
 * Returns what the caller should say to them and, when it is time to trouble the master, what to
 * say to the master. Never runs a model turn, and never puts their words in front of the model.
 */
export function handleUnknown({ channel, address, displayName = "", text, chatId = null }) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();

  // Blocked is blocked: no line, no request, no announcement, nothing.
  if (db.isBlocked(addr)) return { action: "ignore", reason: "blocked" };

  const pending = db.pendingRequestFor(addr);
  if (pending) {
    // Already waiting. One reminder every so often, so somebody texting six times gets one reply.
    const gapMs = config.waitingGapMin * 60_000;
    if (pending.told_waiting_at && clock.now() - pending.told_waiting_at < gapMs) {
      return { action: "ignore", reason: "already_waiting", requestId: pending.id };
    }
    db.markToldWaiting(pending.id);
    return {
      action: "tell_them",
      reason: "already_waiting",
      requestId: pending.id,
      toThem: `still waiting on ${config.ownerName} to say yes — i'll text you the moment they do.`,
    };
  }

  // Declined recently: left alone, and the master is not troubled about them again yet.
  const last = db.lastDecisionFor(addr);
  if (last?.state === "declined" && last.decided_at) {
    const coolOffMs = config.declineCoolOffDays * 24 * 60 * 60 * 1000;
    if (clock.now() - last.decided_at < coolOffMs) {
      return { action: "ignore", reason: "declined_cooloff", until: last.decided_at + coolOffMs };
    }
  }

  const request = db.createAccessRequest({
    channel, address: addr, displayName,
    // Quoted exactly. This is the one thing of theirs the master ever sees, so it is stored as
    // they typed it rather than summarised by anything.
    firstMessage: String(text ?? "").slice(0, 1000),
    chatId,
  });
  db.markToldWaiting(request.id);

  return {
    action: "ask_master",
    requestId: request.id,
    toThem: `hey — i'm ${config.ownerName}'s assistant. i've asked them whether to set you up with your own. i'll text you either way.`,
    request,
  };
}

/**
 * A phone number as the website may hand one over: E.164, nothing else.
 *
 * Stricter than `normalizeNumber` on purpose. That one tidies a number a phone network already
 * vouched for; this one is reading a box a stranger typed into, and whatever it lets through ends
 * up in a text to the master and, on a yes, becomes somewhere Reason sends messages. North American
 * numbers get the extra shape check because that is where a typo'd number is most likely to be a
 * real stranger's phone.
 */
export function validWebNumber(raw) {
  if (typeof raw !== "string" || raw.length > 20) return null;
  if (!/^\+[1-9]\d{7,14}$/.test(raw)) return null;
  if (raw.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(raw)) return null;
  return raw;
}

/**
 * Somebody left their number on the website's "request access" form.
 *
 * The same queue and the same question to the master as a first text, with three differences that
 * all come from one fact — this person has never texted Reason:
 *
 *   - **nothing is sent to them here.** A number typed into a web form proves nothing about who
 *     holds the phone, so the first text it ever gets is the one after the master says yes.
 *   - **there are no words of theirs**, so nothing is quoted to the master.
 *   - **the answer the form gets is the same whatever happened**, apart from "full for today". A
 *     form that said "that number is already a customer" or "that number was declined" would be a
 *     way to look people up.
 *
 * `outcome` is for the log and the tests. It is never for the browser.
 *
 * @returns {{ok: true, outcome: string, request?: object} | {ok: false, reason: string}}
 */
export function handleWebRequest({ channel, address }) {
  const addr = validWebNumber(address);
  if (!addr) return { ok: false, reason: "bad_number" };

  if (db.isBlocked(addr)) return { ok: true, outcome: "blocked" };
  // Already somebody Reason works for, or about to be: the master's own number, a number they
  // wrote into the test list, or an account in any state. Nothing to ask.
  if (accounts.isOperatorAddress(addr) || accounts.isPreApproved(addr) || accounts.accountState(channel, addr)) {
    return { ok: true, outcome: "already_in" };
  }
  // Already waiting, whichever way they asked. One row per number, and the master is not asked twice.
  if (db.pendingRequestFor(addr)) return { ok: true, outcome: "already_waiting" };

  const last = db.lastDecisionFor(addr);
  if (last?.state === "declined" && last.decided_at) {
    const coolOffMs = config.declineCoolOffDays * 24 * 60 * 60 * 1000;
    if (clock.now() - last.decided_at < coolOffMs) return { ok: true, outcome: "declined_cooloff" };
  }

  // The one refusal the form does hear about, because it is not about this number: the website has
  // queued as many new numbers today as it is allowed to.
  if (config.webAccessPerDay && db.webRequestsSince(clock.now() - 24 * 60 * 60 * 1000) >= config.webAccessPerDay) {
    return { ok: false, reason: "full_today" };
  }

  const request = db.createAccessRequest({ channel, address: addr, firstMessage: "", source: "web" });
  return { ok: true, outcome: "queued", request };
}

/**
 * Put one request to the master, as a confirmation in their own conversation.
 *
 * The message is written here rather than by the model, for two reasons: the quote has to be
 * exact, and a stranger's text must not become model input before the master has agreed to it.
 *
 * Returns null when the master should be left alone for now — something is already in front of
 * them, or the hourly ceiling is reached — and the request simply waits.
 */
export function askMaster({ request, masterConversationId, messages = [] }) {
  if (requestInFrontOfMaster()) {
    return { asked: false, reason: "one_at_a_time", waiting: db.unannouncedRequests().length };
  }
  const shown = db.requestsAnnouncedSince(clock.now() - 60 * 60 * 1000);
  if (config.maxRequestsShownPerHour && shown >= config.maxRequestsShownPerHour) {
    return { asked: false, reason: "hourly_cap", waiting: db.unannouncedRequests().length };
  }
  const shownToday = db.requestsAnnouncedSince(clock.now() - 24 * 60 * 60 * 1000);
  if (config.maxRequestsShownPerDay && shownToday >= config.maxRequestsShownPerDay) {
    return { asked: false, reason: "daily_cap", waiting: db.unannouncedRequests().length };
  }

  const who = request.display_name ? `${request.display_name} (${request.address})` : request.address;
  const summary = `give ${who} their own Reason — their own private assistant, separate from yours`;

  const asked = trust.requestConfirmation({
    conversationId: masterConversationId,
    messages,
    action: "access_grant",
    summary,
    stakes: "third_party",
    // The yes is tied to this number. The gate already refuses a confirmation pointed at anybody
    // else, which is exactly the property needed here.
    target: request.address,
  });
  if (!asked.confirmation_id) return { asked: false, reason: "gate_refused", detail: asked };

  db.markRequestAnnounced(request.id, asked.confirmation_id);

  const alsoWaiting = db.unannouncedRequests().length;
  // From the website there are no words of theirs to quote, and saying "texted me" would be untrue.
  const how = request.source === "web"
    ? [`${who} asked for access on the website. they haven't texted me, so all i have is the number they typed.`]
    : [`${who} just texted me for the first time.`, ``, `they said: "${request.first_message}"`];
  const toMaster = [
    ...how,
    ``,
    `want me to set them up with their own Reason? it'd be completely separate from yours — i'd never show you their stuff, or them yours. just say yes or no.`,
    ...(alsoWaiting ? [``, `(${alsoWaiting} other ${alsoWaiting === 1 ? "person is" : "people are"} waiting too — i'll ask about them after.)`] : []),
  ].join("\n");

  return { asked: true, requestId: request.id, confirmationId: asked.confirmation_id, toMaster, alsoWaiting };
}

/**
 * Did the master's latest message answer the request in front of them?
 *
 * Run on every inbound message from the master, before their turn. The judge reads what they
 * meant; code owns everything else. `decided: false` means their message was not an answer to it —
 * which is the common case, because most of what the master says has nothing to do with this — and
 * their normal turn carries on with the request still pending.
 *
 * @param {{messages: Array, masterConversationId: string, judge?: Function}} _
 */
export async function readMasterReply({ messages, masterConversationId, judge }) {
  const request = requestInFrontOfMaster();
  if (!request) return { decided: false, reason: "nothing_pending" };

  // Stale: the master never got round to it. Not a decline — nobody said no — so the number may
  // ask again rather than being left in silence for good.
  const windowMs = config.accessWindowMin * 60_000;
  if (request.announced_at && clock.now() - request.announced_at > windowMs) {
    db.decideRequest(request.id, "expired");
    return { decided: false, reason: "expired", requestId: request.id };
  }

  const verdict = await trust.recordConfirmation({
    conversationId: masterConversationId,
    messages,
    confirmationId: request.confirmation_id,
    ...(judge ? { judge } : {}),
  });

  const fromWeb = request.source === "web";
  if (verdict.state === "granted") {
    const account = approve(request);
    const name = request.display_name || request.address;
    // "You're in" is a promise that texting back will work. On the operator's subscription it would
    // not — only their own test numbers are answered there — so the promise is not made, and the
    // master is told why and what would make it true.
    const serve = servesOnThisBackend(request.address);
    if (!serve.serves) {
      return {
        decided: true, granted: true, requestId: request.id, account,
        quote: verdict.quote,
        toThem: null,
        toMaster: `done — ${name} is approved. i haven't texted them though: on the setup i'm running on right now i can only answer your own test numbers, so "you're in" wouldn't be true yet. add their number to the test list or switch me to the paid setup, then tell me to let them know.`,
      };
    }
    return {
      decided: true, granted: true, requestId: request.id, account,
      quote: verdict.quote,
      toThem: fromWeb
        ? `hey, it's Reason — you asked for access on the website and ${config.ownerName} said yes. i'm your own assistant now: plans, reminders, looking things up, whatever you need. ${MESSY_GOAL_LINE}`
        : `you're in — ${config.ownerName} said yes. i'm your own assistant now: plans, reminders, looking things up, whatever you need. ${MESSY_GOAL_LINE}`,
      toMaster: `done — ${name} is set up with their own. i'll keep their stuff and yours completely separate.`,
    };
  }
  if (verdict.state === "refused") {
    db.decideRequest(request.id, "declined");
    if (fromWeb) {
      // They never texted, so a "no" arriving out of nowhere is a text they did not ask for.
      return {
        decided: true, granted: false, requestId: request.id,
        quote: verdict.quote,
        toThem: null,
        toMaster: `no worries. i haven't texted them anything, and i won't bring them up again for ${config.declineCoolOffDays} days.`,
      };
    }
    return {
      decided: true, granted: false, requestId: request.id,
      quote: verdict.quote,
      toThem: `thanks for texting — ${config.ownerName} isn't setting anyone up right now. all the best.`,
      toMaster: `no worries, i've told them no. i won't bring them up again for ${config.declineCoolOffDays} days.`,
    };
  }
  // unclear or changed: nothing is granted and nothing is refused. The request stays in front of
  // the master, and their turn runs normally — so Reason can ask again in its own words rather
  // than code nagging them.
  return { decided: false, reason: verdict.state ?? "unclear", requestId: request.id, detail: verdict.error };
}

/** The account itself. Separate from the decision so a test can make one directly. */
export function approve(request) {
  db.decideRequest(request.id, "approved");
  const conversationId = `dm:${request.channel}:${request.address}`;
  return db.upsertAccount({
    conversationId,
    channel: request.channel,
    address: request.address,
    name: request.display_name || "",
    isOperator: false,
  });
}

/** For the master's own listing: who is waiting, and for how long. */
export function pendingForMaster({ limit = 20 } = {}) {
  return db.listAccessRequests({ state: "pending", limit }).map(r => ({
    request_id: r.id,
    number: r.address,
    name: r.display_name || null,
    said: r.first_message,
    asked_you: r.announced_at ? stamp(r.announced_at) : null,
    waiting_since: stamp(r.requested_at),
    in_front_of_you: !!r.announced_at && !!r.confirmation_id,
  }));
}
