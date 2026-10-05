// What somebody sent that was not words, and what Reason actually got out of it.
//
// A picture is in front of the model for exactly one turn and then it is gone — the bytes are not
// kept, because a stored image block would be resent on every later turn and an inbound media_url
// expires after 30 days anyway (src/agent.js, src/media.js). So without a row, the only trace of a
// photo is a sentence the model wrote about having looked at it, and three things become
// impossible:
//
//   - **"this one", "the second photo".** An item needs an identity before it can be pointed at.
//   - **several photos on one message.** Knowing they were ONE message's worth is what makes them
//     one thing to consider, rather than three arrivals.
//   - **"what did you actually look at?"** The honest answer is a record, not a recollection.
//
// Hence a row per item, written the moment the message is claimed and before anything has
// processed it, and then MOVED as processing happens. The vocabulary of `coverage` is in the
// media_items comment in src/db.js and it is deliberately small: each value is a different claim
// Reason is allowed to make about the same file.
//
// What is NOT in here: the content. No bytes, no transcript, no page text. Those live where they
// already lived — the transcript in the conversation, the video account in video_accounts — and
// this is the index over them. A record of what was reviewed should not be a second copy of
// somebody's photos.
import * as db from "./db.js";
import { urlsIn } from "./parts.js";

/** The honest word for each coverage value, in the model's own terms rather than the column's. */
const SAYS = {
  waiting: "arrived; nothing has looked at it yet",
  processing: "being worked on right now; there is no answer about it yet",
  looked: "you looked at this picture",
  transcribed: "you have the words that were said in it",
  no_speech: "there was no speech in it",
  captions: "you read its captions — words only, nothing was watched",
  watched: "a video model watched it, picture and sound",
  heard: "only the audio could be taken and transcribed — words only, nothing was watched",
  metadata: "only what the page claims about itself; none of it was read or watched",
  read: "the page was fetched and read",
  failed: "it could not be opened",
  dropped: "not something they sent — a fragment of a message already answered",
};

export const coverageSays = (coverage) => SAYS[coverage] ?? coverage;

/**
 * One inbound message → a row per thing on it, and the same attachments back with the row id on
 * each, so whatever processes one can say what it got.
 *
 * Links they sent are items too. A pasted URL is the thing a follow-up means by "that one" as
 * often as a photo is, and "did you actually read it" is the same question about both.
 *
 * `dropped` is passed when the part this is being called for is a fragment of a message already
 * handled — a link card's preview image. The row is still written, with its reason, because that
 * judgement is an honest guess (src/parts.js) and a photo wrongly eaten should leave a trace
 * rather than nothing at all.
 */
export function record({ channel, inbound, conversationId, dropped = null }) {
  const attachments = inbound.attachments ?? [];
  const said = String(inbound.said ?? inbound.text ?? "");
  const baseHandle = inbound.baseHandle ?? inbound.externalId;
  const out = [];
  let ordinal = 0;

  for (const a of attachments) {
    ordinal++;
    const row = db.recordMedia({
      conversationId, channel, externalId: inbound.externalId,
      baseHandle, partIndex: inbound.partIndex ?? 0, ordinal,
      kind: a?.kind ?? "file", filename: a?.filename ?? "", url: a?.url ?? "",
      ...(dropped ? { coverage: "dropped", detail: dropped } : {}),
    });
    out.push({ ...a, media_id: row.id, ordinal });
  }

  // Their links. Numbered after the attachments on the same message so one message's items are one
  // run of ordinals and nothing collides.
  if (!dropped) {
    for (const url of urlsIn(said)) {
      ordinal++;
      db.recordMedia({
        conversationId, channel, externalId: inbound.externalId,
        baseHandle, partIndex: inbound.partIndex ?? 0, ordinal,
        kind: "link", url, filename: "",
      });
    }
  }
  return out;
}

/** What was got out of one item. A no-op for anything with no row, so callers need no branch. */
export function cover(mediaId, { coverage, detail = "", bytes = null, seconds = null, transcript = null } = {}) {
  if (!mediaId) return null;
  return db.coverMedia(mediaId, { coverage, detail, bytes, seconds, transcript });
}

/**
 * A page or a video that has just been read, joined back to the link somebody sent.
 *
 * Matched on the URL within the one conversation, and silent when there is no such link: Reason
 * reads plenty of pages nobody sent it, and those are not items in anybody's record.
 */
export function coverUrl(conversationId, url, { coverage, detail = "" } = {}) {
  const row = db.mediaByUrl(conversationId, url);
  if (!row) return null;
  return db.coverMedia(row.id, { coverage, detail });
}

/**
 * The record, as the model reads it.
 *
 * Newest first, because "this one" means the last thing far more often than the first. Each item
 * says which message it came on and which of that message's items it was, so "the second photo"
 * resolves to a row rather than to a guess — and says in words what coverage succeeded, so a
 * sentence about what Reason reviewed comes off the record instead of out of memory.
 */
export function listFor(conversationId, { limit = 40, kinds = null } = {}) {
  const rows = db.mediaFor(conversationId, { limit, kinds });
  return rows.filter(r => r.coverage !== "dropped").map(view);
}

/** One row as the model reads it. The transcript is deliberately not in here; see `one()`. */
function view(r) {
  return {
    id: r.id,
    kind: r.kind,
    ...(r.filename ? { filename: r.filename } : {}),
    ...(r.url && r.kind === "link" ? { url: r.url } : {}),
    on_message: r.base_handle,
    nth_on_that_message: r.ordinal,
    coverage: r.coverage,
    what_that_means: coverageSays(r.coverage),
    ...(r.detail ? { why: r.detail } : {}),
    ...(r.seconds ? { seconds: r.seconds } : {}),
    ...(r.transcript ? { has_transcript: true } : {}),
    at: r.at,
  };
}

/**
 * One item, in full, including a voice note's own words.
 *
 * Separate from the list on purpose. A transcript is the content rather than the index, and
 * putting every one of them into every turn that asks what arrived would pour somebody's voice
 * notes into the context of a conversation about something else. Asked for by id, it is there for
 * the one question it answers: what exactly did they say in that note.
 */
export function one(conversationId, id) {
  const r = db.mediaItem(conversationId, id);
  if (!r) return null;
  if (r.coverage === "dropped") return null;
  return {
    ...view(r),
    ...(r.transcript
      ? { transcript: r.transcript, transcript_note: "Their own words, as transcribed when it arrived. A transcript can mishear a name or a number, and [inaudible] means a stretch nobody could make out — never fill one in." }
      : {}),
  };
}
