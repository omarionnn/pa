// Parts of one message are one message.
//
// Somebody sent Reason a line of text and, a second later, pasted a link. iMessage showed that as
// one bubble with a rich link card on it. Sendblue delivered it as three `receive` webhooks ten
// seconds apart — the text and the link, then two more with empty content and a `media_url` each,
// which are the link card's preview images. Reason answered all three: the real one got a real
// answer, and the two previews got "that one came through blank on my end too, files don't open for
// me" and then "still getting blanks on my end, that's 3 now 😅". Three replies to one message, two
// of them complaining about files nobody sent.
//
// So this module answers one question per inbound event: is this a thing somebody sent, or is it a
// fragment of something already handled?
//
//   - **part 0 is always real.** It is the message. Nothing in here can drop it.
//   - **a part that carries words is real.** Whatever else it is, somebody typed something.
//   - **a part with nothing in it at all** — no words, no attachment — is not a message. There is
//     nothing to answer and nothing to describe.
//   - **a part whose only content is a preview image of a URL that is already in the message's own
//     text** is the link card, not a file somebody chose to send. Dropped, silently: the person
//     does not know their phone sent it and does not want to hear about it.
//
// Everything else is a real attachment and gets handled as one — a photo sent alongside a caption
// is exactly this shape, and dropping it would be the opposite mistake.
//
// WHERE THIS IS HONESTLY A GUESS. Sendblue's payload has no field that distinguishes a link-card
// preview thumbnail from a photo (there is no content type on an inbound message at all, only
// `media_url`). The rule above therefore also drops a photo attached to a message whose text
// happens to contain a link. That trade is deliberate and recorded in docs/unverified.md: three
// wrong replies to every link somebody pastes is a daily failure, and a caption-with-a-link-plus-a-
// photo is not. Every drop is logged with its reason so the real traffic can settle it.
import * as db from "./db.js";

/**
 * Every URL in a piece of text.
 *
 * This is a regex and that is correct: it is not judging what somebody meant, it is finding a
 * literal string that starts with http. "The model reads meaning, code enforces facts" cuts both
 * ways — whether a URL is present is a fact, and asking a model for it would be slower, dearer and
 * less certain than the thing it replaced.
 */
export function urlsIn(text) {
  return String(text ?? "").match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
}

/**
 * Write down what this part was, so a part that arrives later can be understood against it.
 *
 * Keyed on (channel, base handle, part index), so a provider redelivering the same part overwrites
 * one row rather than growing the table, and a restart between parts loses nothing.
 */
export function remember({ channel, inbound, conversationId }) {
  db.rememberInboundPart({
    channel,
    baseHandle: inbound.baseHandle ?? inbound.externalId,
    partIndex: inbound.partIndex ?? 0,
    conversationId,
    text: inbound.said ?? inbound.text ?? "",
    urls: urlsIn(inbound.said ?? inbound.text ?? ""),
    attachments: inbound.attachments ?? [],
  });
}

/**
 * Is this inbound event worth a turn, or is it a fragment of one already handled?
 *
 * Returns `{ drop, why }`. `why` is for the log and for the tests — nobody is ever told about a
 * dropped part, which is the entire point.
 */
export function classify({ channel, inbound }) {
  const partIndex = inbound.partIndex ?? 0;
  if (!partIndex) return { drop: false, why: "the message itself" };

  const said = String(inbound.said ?? "").trim();
  if (said) return { drop: false, why: "this part carries words" };

  const attachments = inbound.attachments ?? [];
  if (!attachments.length) {
    return { drop: true, why: `part ${partIndex} carried no words and no file` };
  }
  // Only a picture can be a link card's preview. A PDF, a vCard or a voice note attached to a
  // message is always something somebody chose to send.
  if (!attachments.every(a => a.kind === "image")) {
    return { drop: false, why: "this part is a file, not a preview" };
  }

  const base = db.getInboundPart({ channel, baseHandle: inbound.baseHandle ?? inbound.externalId, partIndex: 0 });
  if (!base) {
    // The message this belongs to was never seen — a restart, or a part delivered before its own
    // message. Nothing to check it against, so it is treated as a real attachment. Answering about
    // a photo nobody sent is a smaller failure than silently eating a photo somebody did.
    return { drop: false, why: `part ${partIndex} arrived with no record of the message it belongs to` };
  }
  const urls = base.urls ?? [];
  if (!urls.length) return { drop: false, why: "the message had no link, so this picture is a picture" };

  return { drop: true, why: `part ${partIndex} is a link preview for ${urls[0]}` };
}
