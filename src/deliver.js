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
import { outgoingParts } from "./plain.js";

// A page link goes out BARE, on purpose. On 2026-10-06 the link's own bubble briefly carried the
// page's picture as an attachment, so the page would arrive looking like a page whether or not the
// phone drew a card. With Reason saved as a contact the phone draws the card itself — from the
// page's og:image (src/pages/render.js, src/pages/card.js) — and the attachment was the same
// picture a second time, one bubble above. Omari: "I don't like that extra picture card on top. I
// just wanted the link preview and it works fine." So the picture lives at /p/{id}/card.png for the
// phone to fetch, and nothing is attached to the link.

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
 * When `media` is set, the runtime has a call recording waiting and wants it to go with this
 * message. The words go first, as an ordinary message — split, pinned and with any effect, exactly
 * as they would without a recording — and the audio follows as its own message with nothing
 * written on it. It used to be one `sendMedia` with the words as the file's caption, so the owner
 * got "the summary and the audio in one message". On iMessage they did not: a .caf with a caption
 * renders as a voice memo, and on 2026-10-17 the caption — the whole answer to two questions — did
 * not show in Messages at all. A caption also skipped everything the text path does (no link split,
 * no pin under the message it answered, no effect).
 *
 * `mediaOk: false` tells the runtime the audio did NOT go and is not going, so it stays unsent
 * rather than being written down as sent, and a line says so, because the alternative is Reason
 * claiming to have sent something it did not. Audio the outbox has QUEUED is going (it is retried
 * and reported if it never arrives), so that is `mediaOk: true, mediaQueued: true` and the runtime
 * marks it sent — otherwise it rode out again on the next message while the first copy retried.
 */
export function makeDeliver({ router, consoleChannel, log = () => {}, warn = (line) => console.error(line) }) {
  return async function deliver({ conversationId, text, media, channel, to: toIn, chatId: chatIn, fromOwner, isOperator, replyTo = null, sendStyle = null, idempotencyKey = null }) {
    const route = whereTo({ conversationId, channel, to: toIn, chatId: chatIn });
    const { channel: name, to, chatId } = route;
    const target = name === "console" ? consoleChannel : null;
    // Does the thing this is going to draw markdown? Asked of the adapter rather than assumed, and
    // every adapter says no (src/channels/channel.js). A channel that is not registered at all is
    // about to fail anyway, and the honest default for one is to send plain text.
    const plain = !((target ?? router.get?.(name))?.rendersMarkdown);
    // Which thread owes this message, and whether a failure to deliver it is news for somebody
    // else. A message going to a conversation's own thread is going to the person whose Reason
    // this is, whoever that is; without that the owner would be told about failing to reach
    // themselves, which is noise.
    //
    // `idempotencyKey` is for a caller that may come back and ask for the same message again — a
    // timer whose turn is being retried (Runtime.tick). The outbox keeps one row per key, so the
    // second ask finds the first and nothing is sent twice. Without one the outbox makes its own.
    const durable = {
      conversationId, toOwner: fromOwner ?? (route.started || conversationId === config.ownerConversation),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    void isOperator;
    if (route.started) log({ started_message: conversationId, over: name, to });

    if (media) {
      // The words first, on the ordinary path below, then the file on its own. A recording flushed
      // with no words at all (src/calls/postcall.js, after a silent turn) is the file alone.
      const said = String(text ?? "").trim() ? await deliver({ conversationId, text, media: null, channel, to: toIn, chatId: chatIn, fromOwner, isOperator, replyTo, sendStyle, idempotencyKey }) : { ok: true };
      const mediaKey = idempotencyKey ? { idempotencyKey: `${idempotencyKey}:media` } : {};
      const r = target
        ? await target.sendMedia({ to, text: "", file: media.file, mimeType: media.mimeType, filename: media.filename })
        : await router.sendMedia({ channel: name, to, text: "", chatId, file: media.file, mimeType: media.mimeType, filename: media.filename, ...durable, ...mediaKey });
      if (r.ok && !r.queued) return { ...said, mediaOk: true };
      // Still trying, in the outbox, which owns it from here.
      if (r.queued) return { ...said, mediaOk: true, mediaQueued: true, error: said.error ?? r.error };

      warn(`could not send the recording of call #${media.call_id} over ${name}: ${r.error}`);
      const line = `(i couldn't get you the recording of that call here — ${r.error})`;
      // Its own key: this is a different message from the one with the file on it, and under the
      // same key the outbox would hand back the attempt that just failed instead of sending this.
      const t = target ? await target.send({ to, text: line }) : await router.send({ channel: name, to, text: line, chatId, ...durable, ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:no-media` } : {}) });
      if (!t.ok && !t.queued) warn(`could not send over ${name}: ${t.error}`);
      return { ok: said.ok !== false, mediaOk: false, error: r.error };
    }

    // What this message actually becomes on a phone: markers a text thread cannot draw taken off,
    // a link on its own so it is tappable, anything meant to be pasted in a bubble of its own and
    // whole, and a cap on how many bubbles that comes to (src/plain.js). Decided here, in code, so
    // it holds however the model happened to write the reply — and the common reply, which has
    // none of those things in it, is still exactly one message.
    const split = outgoingParts(text, { plain });
    const parts = split.parts.map(p => p.text);
    if (split.over) log({ bubbles_over_cap: parts.length, cap: config.maxBubbles, conversation: conversationId });
    if (parts.length > 1) {
      log({ parts: split.parts.map(p => p.kind), conversation: conversationId });
      const r = target
        ? await sendEach(target, { to, parts })
        // The effect goes on the LAST part, which is the one with the words in it: a bare link
        // arriving with confetti on it is an animation on a URL, and the sentence it belongs to
        // is still to come.
        : await router.sendParts({ channel: name, to, parts, chatId, replyTo, sendStyle, ...durable });
      if (target && r.ok) { for (const p of parts) { try { db.writeMessage({ conversationId, role: "assistant", channel: name, text: p }); } catch { /* never costs a send */ } } }
      if (!r.ok && !r.queued) {
        warn(`could not send over ${name}: ${r.error}`);
        if (route.started) log({ started_message_failed: conversationId, over: name, why: r.error });
      }
      if (r.queued) log({ outbound_queued: conversationId, to, why: r.error });
      return { ok: r.ok || !!r.queued, mediaOk: true, error: r.error, parts: r.parts };
    }

    // One bubble, which is the overwhelmingly common reply. `one` is the message with the markers
    // off; it falls back to what the model wrote if there was nothing left after them, because an
    // empty text is a message nobody gets and that is worse than a stray asterisk.
    const one = parts[0] || text;
    // `replyTo` pins this reply under one earlier message. Text only: a summary arriving with its
    // recording is its own event and is never pinned.
    const r = target ? await target.send({ to, text: one, sendStyle }) : await router.send({ channel: name, to, text: one, chatId, replyTo, sendStyle, ...durable });
    // The console has no outbox, so its history row is written here; every other channel's is
    // written when the outbox marks the row sent (db.markOutboundSent).
    if (target && r.ok) { try { db.writeMessage({ conversationId, role: "assistant", channel: name, text: one }); } catch { /* never costs a send */ } }
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
