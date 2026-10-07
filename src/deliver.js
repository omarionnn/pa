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
import * as accounts from "./accounts.js";
import { config } from "./config.js";
import { outgoingParts, plainText, LINK } from "./plain.js";
import { pageUrl } from "./pages/access.js";
import { pageCard, cardFilename } from "./pages/card.js";

/**
 * The page a link part points at, if it is one of this conversation's own pages (or a page that is
 * shared, which anyone holding the link may read). A link to somebody else's private page is not
 * decorated — nothing about it should be read off here — and neither is any other URL.
 */
export function pageForLink(text, conversationId) {
  const base = pageUrl("").replace(/\/$/, "");
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9_-]{8,64})(?:[?#]|$)`).exec(String(text ?? "").trim());
  if (!m) return null;
  const page = db.getPage(m[1]);
  if (!page) return null;
  if (page.conversation_id !== conversationId && !page.shared) return null;
  return page;
}

/**
 * The picture of a page on the page's own link.
 *
 * A bare link becomes a card only if the recipient's phone decides so, and Apple's phones decide
 * no for any number not in Contacts. The picture here does not wait on that decision: it is sent,
 * on the same message as the link, so the page arrives looking like a page. Omari, 2026-10-06.
 *
 * Only the link parts, only for pages this conversation may read, and never at the cost of the
 * link: a picture that cannot be drawn (no Chromium, a timeout) is a log line and a bare link,
 * exactly what went out before. REASON_LINK_CARDS=off turns it off without a deploy.
 */
export async function withPageCards(parts, { conversationId, draw = pageCard, log = () => {} }) {
  if (config.linkCards === false) return parts.map(p => ({ text: p.text, media: null }));
  const out = [];
  for (const p of parts) {
    let media = null;
    if (p.kind === LINK) {
      const page = pageForLink(p.text, conversationId);
      if (page) {
        try {
          const card = await draw(page, { forName: accounts.ownerOf(page.conversation_id).name });
          media = { file: card.file, mimeType: "image/png", filename: cardFilename(page) };
          log({ link_card: page.id, bytes: card.bytes, fresh: card.fresh, conversation: conversationId });
        } catch (e) {
          log({ link_card_failed: page.id, why: (e?.message ?? String(e)).split("\n")[0], conversation: conversationId });
        }
      }
    }
    out.push({ text: p.text, media });
  }
  return out;
}

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
export function makeDeliver({ router, consoleChannel, log = () => {}, warn = (line) => console.error(line), draw = pageCard }) {
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
      // One message carrying the summary AND the file, so it is never split — but the summary is
      // still text on a phone, so the markers come off it.
      const summary = plain ? plainText(text) : text;
      const r = target
        ? await target.sendMedia({ to, text: summary, file: media.file, mimeType: media.mimeType, filename: media.filename })
        : await router.sendMedia({ channel: name, to, text: summary, chatId, file: media.file, mimeType: media.mimeType, filename: media.filename, ...durable });
      if (r.ok && !r.queued) return { ok: true, mediaOk: true };
      // Still trying. The audio stays queued on the call row too, because it has not arrived.
      if (r.queued) return { ok: true, mediaOk: false, queued: true, error: r.error };

      warn(`could not send the recording of call #${media.call_id} over ${name}: ${r.error}`);
      const fallback = `${summary}\n\n(i couldn't get you the recording of that call here — ${r.error})`;
      // Its own key: this is a different message from the one with the file on it, and under the
      // same key the outbox would hand back the attempt that just failed instead of sending this.
      const t = target ? await target.send({ to, text: fallback }) : await router.send({ channel: name, to, text: fallback, chatId, ...durable, ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:text` } : {}) });
      if (!t.ok && !t.queued) warn(`could not send over ${name}: ${t.error}`);
      return { ok: t.ok || !!t.queued, mediaOk: false, error: r.error };
    }

    // What this message actually becomes on a phone: markers a text thread cannot draw taken off,
    // a link on its own so it is tappable, anything meant to be pasted in a bubble of its own and
    // whole, and a cap on how many bubbles that comes to (src/plain.js). Decided here, in code, so
    // it holds however the model happened to write the reply — and the common reply, which has
    // none of those things in it, is still exactly one message.
    const split = outgoingParts(text, { plain });
    // A link to one of this conversation's pages carries the page's picture (withPageCards). The
    // console draws no pictures, so it is handed the words alone.
    const items = target ? split.parts.map(p => ({ text: p.text, media: null })) : await withPageCards(split.parts, { conversationId, draw, log });
    const parts = items.map(p => p.text);
    if (split.over) log({ bubbles_over_cap: parts.length, cap: config.maxBubbles, conversation: conversationId });
    if (parts.length > 1) {
      log({ parts: split.parts.map(p => p.kind), conversation: conversationId });
      const r = target
        ? await sendEach(target, { to, parts })
        // The effect goes on the LAST part, which is the one with the words in it: a bare link
        // arriving with confetti on it is an animation on a URL, and the sentence it belongs to
        // is still to come.
        : await router.sendParts({ channel: name, to, parts: items, chatId, replyTo, sendStyle, ...durable });
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
    // A reply that is nothing but a page link: the picture goes on it, same as in a sequence.
    if (items[0]?.media && !target) {
      const r = await router.sendMedia({ channel: name, to, text: one, chatId, ...items[0].media, ...durable });
      if (r.ok || r.queued) {
        if (r.queued) log({ outbound_queued: conversationId, to, why: r.error });
        return { ok: true, mediaOk: true, error: r.error };
      }
      // The picture would not go; the link still must. Its own key, for the same reason as above.
      log({ link_card_dropped: conversationId, why: r.error });
      const t = await router.send({ channel: name, to, text: one, chatId, replyTo, sendStyle, ...durable, ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:text` } : {}) });
      if (!t.ok && !t.queued) warn(`could not send over ${name}: ${t.error}`);
      return { ok: t.ok || !!t.queued, mediaOk: true, error: t.error };
    }
    // `replyTo` pins this reply under one earlier message. Text only: a summary arriving with its
    // recording is its own event and is never pinned.
    const r = target ? await target.send({ to, text: one, sendStyle }) : await router.send({ channel: name, to, text: one, chatId, replyTo, sendStyle, ...durable });
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
