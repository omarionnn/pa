// How a message Reason wrote actually leaves: which channel, to which address, and what happens
// when it does not go.
//
// This used to live inside serve.js, where nothing could test it, and it had one rule for where a
// message goes: use the channel the turn was handed, and if it was handed none, print to the
// console. A reply always has a channel — it goes back the way the text came in. A message Reason
// STARTS does not: a timer firing, a task waking, a watcher finding something, a dropped thread.
// So every reminder was written, printed into the server's log, and never texted to anybody, while
// the conversation recorded it as said. Found on 2026-10-05 when a 5:30 AM and a 10:00 AM reminder
// both "went off" and neither arrived.
//
// The rule now: a message with no channel goes to the thread that conversation lives in. The
// console is only for a conversation that has no thread at all, which is the terminal itself.
import * as db from "./db.js";
import { config } from "./config.js";
import { linkParts } from "./links.js";

/**
 * Where a message for this conversation goes.
 *
 *   handed a channel      that channel — a reply going back the way it came.
 *   no channel, a thread  the thread's own channel and address — everything Reason starts itself.
 *   neither               the console, for the operator's terminal and for tests.
 *
 * `started` says the route was read from the thread rather than handed in, which is what makes a
 * failure to deliver worth logging loudly: nobody is sitting there waiting to notice it.
 */
export function whereTo({ conversationId, channel = null, to = null, chatId = null }) {
  if (channel) return { channel, to, chatId, started: false };
  const thread = db.getThread(conversationId);
  if (thread?.channel && thread.channel !== "console" && thread.address) {
    return { channel: thread.channel, to: thread.address, chatId: thread.chat_id ?? null, started: true };
  }
  return { channel: "console", to, chatId, started: false };
}

/** The console has no outbox, so its parts are kept in order by the loop and nothing else. */
async function sendEach(target, { to, parts }) {
  let last = { ok: true };
  for (const text of parts) {
    last = await target.send({ to, text });
    if (!last.ok) return last;
  }
  return last;
}

/**
 * The function the runtime calls to put one message out.
 *
 * When `media` is set, the runtime has a call recording waiting and wants it on this message. It
 * is one `sendMedia` rather than a text followed by a file, so the owner gets a single message
 * carrying the summary and the audio. `mediaOk: false` tells the runtime the audio did NOT go, so
 * it stays queued rather than being written down as sent — then the text is sent on its own with
 * a line saying the recording could not be delivered, because the alternative is Reason claiming
 * to have sent something it did not.
 */
export function makeDeliver({ router, consoleChannel, log = () => {}, warn = (line) => console.error(line) }) {
  return async function deliver({ conversationId, text, media, channel, to: toIn, chatId: chatIn, fromOwner, isOperator, replyTo = null }) {
    const route = whereTo({ conversationId, channel, to: toIn, chatId: chatIn });
    const { channel: name, to, chatId } = route;
    const target = name === "console" ? consoleChannel : null;
    // Which thread owes this message, and whether a failure to deliver it is news for somebody
    // else. A message going to a conversation's own thread is going to the person whose Reason
    // this is, whoever that is; without that the owner would be told about failing to reach
    // themselves, which is noise.
    const durable = { conversationId, toOwner: fromOwner ?? (route.started || conversationId === config.ownerConversation) };
    void isOperator;
    if (route.started) log({ started_message: conversationId, over: name, to });

    if (media) {
      const r = target
        ? await target.sendMedia({ to, text, file: media.file, mimeType: media.mimeType, filename: media.filename })
        : await router.sendMedia({ channel: name, to, text, chatId, file: media.file, mimeType: media.mimeType, filename: media.filename, ...durable });
      if (r.ok && !r.queued) return { ok: true, mediaOk: true };
      // Still trying. The audio stays queued on the call row too, because it has not arrived.
      if (r.queued) return { ok: true, mediaOk: false, queued: true, error: r.error };

      warn(`could not send the recording of call #${media.call_id} over ${name}: ${r.error}`);
      const fallback = `${text}\n\n(i couldn't get you the recording of that call here — ${r.error})`;
      const t = target ? await target.send({ to, text: fallback }) : await router.send({ channel: name, to, text: fallback, chatId, ...durable });
      if (!t.ok && !t.queued) warn(`could not send over ${name}: ${t.error}`);
      return { ok: t.ok || !!t.queued, mediaOk: false, error: r.error };
    }

    // A link goes out as its own message, with the words about it as a separate one (src/links.js).
    // Decided here, in code, so it holds however the model happened to write the reply — and the
    // common reply, which has no link in it, is one part and takes exactly the path it always did.
    const parts = linkParts(text);
    if (parts.length > 1) {
      log({ link_parts: parts.length, conversation: conversationId });
      const r = target
        ? await sendEach(target, { to, parts })
        : await router.sendParts({ channel: name, to, parts, chatId, replyTo, ...durable });
      if (!r.ok && !r.queued) {
        warn(`could not send over ${name}: ${r.error}`);
        if (route.started) log({ started_message_failed: conversationId, over: name, why: r.error });
      }
      if (r.queued) log({ outbound_queued: conversationId, to, why: r.error });
      return { ok: r.ok || !!r.queued, mediaOk: true, error: r.error, parts: r.parts };
    }

    // `replyTo` pins this reply under one earlier message. Text only: a summary arriving with its
    // recording is its own event and is never pinned.
    const r = target ? await target.send({ to, text }) : await router.send({ channel: name, to, text, chatId, replyTo, ...durable });
    // A queued message is not a failure to report to stderr and forget — it is a row that will
    // either arrive or be reported. Only a dead one is worth shouting about here.
    if (!r.ok && !r.queued) {
      warn(`could not send over ${name}: ${r.error}`);
      if (route.started) log({ started_message_failed: conversationId, over: name, why: r.error });
    }
    if (r.queued) log({ outbound_queued: conversationId, to, why: r.error });
    return { ok: r.ok || !!r.queued, mediaOk: true, error: r.error };
  };
}
