// Event business from a guest who is over this month's free conversations (owner, 2026-11-11; follow-up
// to REASON_EVENT_PAYWALL_TS, src/plan.js).
//
//   A guest who replies about the event itself — "can't make it", an RSVP change, leaving, muting it,
//   an answer to the host's question, a reply to the host's message — gets through free: the turn
//   runs, it is not one of their conversations, and the pay line is never the answer to it.
//   Only a real ask of Reason counts (a reminder, a search, a call, a booking, anything not the event).
//
// Read only when it matters: the person is on the monthly free tier, this text would land over the
// ceiling, and they are a guest at an event that is still current. The read is a small side model
// call, by meaning. With no read (the side model is off or down) the text passes only when the host
// or the event wrote to them in the last day, which is what a reply about the event follows; else the
// ceiling answers as before. In the free turn only a guest's own event tools are let past the lapsed
// gate (plan.waive): anything else that acts is still refused there, with its usual line.
import * as db from "./db.js";
import * as plan from "./plan.js";
import { clock } from "./config.js";
import { askStructured, sideAskAllowed } from "./backends/side.js";

/** What a guest does about an event they joined: the tools the free turn may use. */
export const GUEST_TOOLS = new Set(["event_info", "event_leave", "event_mute", "event_directory", "event_instagram", "event_answer", "event_ride", "event_list", "event_lookup"]);
/** An event stays current for this long after it starts ("thanks for having me", "left my jacket"). */
export const AFTER_MS = 3 * 24 * 3_600_000;
/** With no read: a text inside this long of the event's last line to them is taken as its reply. */
export const REPLY_MS = 24 * 3_600_000;

export const FRAME = "[This message is about an event they are a guest at. Deal with the event matter only (their RSVP, leaving, muting, an answer for the host, a detail of the event). Say nothing about plans, limits, prices or links.]";

/** The events they are a guest at (not the host of) that are still current. */
export function guestEvents(conversationId, now = clock.now()) {
  if (!conversationId) return [];
  return db.membershipsOf(conversationId).filter(e => e.role !== "organizer" && e.organizer_conversation_id !== conversationId
    && (e.starts_at == null || e.starts_at > now - AFTER_MS));
}

/** When the event (the host's message, a reminder, a question) last wrote to them, or 0. */
function lastEventLineAt(conversationId, eventIds) {
  if (!eventIds.length) return 0;
  const marks = eventIds.map(() => "?").join(",");
  return db.db.prepare(`SELECT MAX(created_at) AS at FROM event_deliveries WHERE conversation_id = ? AND event_id IN (${marks})`).get(conversationId, ...eventIds)?.at ?? 0;
}

/** The event's last few messages to them (the host's words, reminders), oldest first: what a reply answers. */
function lastEventLines(conversationId, eventIds, k = 3) {
  if (!eventIds.length) return [];
  const marks = eventIds.map(() => "?").join(",");
  return db.db.prepare(`SELECT m.body FROM event_deliveries d JOIN event_messages m ON m.id = d.message_id
    WHERE d.conversation_id = ? AND d.event_id IN (${marks}) ORDER BY d.id DESC LIMIT ?`).all(conversationId, ...eventIds, k).map(r => String(r.body ?? "").slice(0, 400)).reverse();
}

const SCHEMA = { type: "object", properties: { event_business: { type: "boolean" } }, required: ["event_business"] };
const SYSTEM = `Reason is an assistant people text. This person is a guest at an event that is run through Reason, and texts about the event reach Reason. Decide, by meaning, whether their newest message is ONLY event business: saying they can or cannot come, changing or dropping their RSVP, leaving the event, stopping its messages, answering something the host asked, replying to the host's message or reminder, their ride to it, their name on its guest list, or a question about the event's own time, place or details. It is NOT event business when any part of it asks Reason for something else: a reminder, a search, a recommendation, a call, a booking, shopping, a plan, a general question, or chat that has nothing to do with the event. Answer event_business true or false.`;

/** The read, by meaning. Throws when there is none. */
export async function read({ conversationId, texts = [], evs = [], ask = askStructured }) {
  if (ask === askStructured && !sideAskAllowed()) throw new Error("no side read");
  const recent = db.loadConversation(conversationId).slice(-4)
    .map(m => `${m.role === "assistant" ? "Reason" : "Them"}: ${(typeof m.content === "string" ? m.content : "").slice(0, 300)}`).filter(l => l.length > 8).join("\n");
  const fromEvent = lastEventLines(conversationId, evs.map(e => e.id)).map(l => `- ${l}`).join("\n");
  const r = await ask({
    prompt: `Their event${evs.length > 1 ? "s" : ""}: ${evs.map(e => String(e.name ?? "").slice(0, 80)).join("; ")}\n\nThe event's last messages to them, oldest first:\n${fromEvent || "(none)"}\n\nThe last lines in their thread, oldest first:\n${recent || "(none)"}\n\nTheir newest message:\n${texts.map(t => String(t ?? "").slice(0, 400)).join("\n").slice(0, 1_500)}`,
    system: SYSTEM,
    schema: SCHEMA,
    model: process.env.REASON_ONBOARDING_CLI_MODEL || "haiku",
    timeoutMs: Number(process.env.REASON_EVENT_BUSINESS_TIMEOUT_MS || 12_000),
    feature: "onboarding",
  });
  if (typeof r?.value?.event_business !== "boolean") throw new Error(r?.error || "no read");
  return r.value.event_business;
}

/**
 * The router's question before it counts a turn (Router #drainHeld): is this text free event business
 * from a guest who would otherwise meet the ceiling? False for everybody else, without any read.
 */
export async function free({ conversationId, texts = [], ask = askStructured, log = () => {}, now = clock.now() }) {
  if (!conversationId || !texts.some(t => String(t ?? "").trim())) return false;
  if (!plan.overNext(conversationId, now)) return false;
  const evs = guestEvents(conversationId, now);
  if (!evs.length) return false;
  try {
    const yes = await read({ conversationId, texts, evs, ask });
    log({ event_business: conversationId, free: yes, how: "read" });
    return yes;
  } catch (e) {
    const yes = now - lastEventLineAt(conversationId, evs.map(e2 => e2.id)) <= REPLY_MS;
    log({ event_business: conversationId, free: yes, how: "no_read", why: (e?.message ?? String(e)).split("\n")[0] });
    return yes;
  }
}
