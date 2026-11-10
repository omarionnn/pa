// Sending one tapback: every check, the channel call, and the memory of a permanent refusal.
//
// This lives on its own because two different callers send the same tapback. The `react` tool
// sends one the moment the model asks for it. The runtime sends the one that was PARKED — asked for
// on a turn where the person had actually asked something, and therefore held back until words went
// out with it. Both have to make exactly the same checks, and a second copy of them would be a
// second place for "is this thread even iMessage" to drift.
//
// What is NOT in here is the decision. Which message deserves a tapback, and whether a word would
// have added anything, is the model's judgement in the system prompt. This file only knows whether
// the line, the rail and the message can carry one, and says so in words when they cannot.
import * as db from "./db.js";
import { checkReaction } from "./expressive.js";

/** On the end of every refusal, because the failure mode worth preventing is a claimed reaction. */
const WORDS = "Reply in words instead — do not say you reacted.";

/**
 * Put one tapback on the last message they sent.
 *
 * The handle is read from the thread, never from the caller: it is the id of the most recent
 * inbound message, stored when that message arrived. So there is nothing to get wrong about WHICH
 * message is being reacted to, and no way to point a reaction at a message in somebody else's
 * conversation.
 *
 * Returns the tool's own answer shape — `{ok: true, reacted_to, reaction}` or `{ok: false, error}`
 * with a sentence that can go straight to the model. Never throws for an expected failure: "the
 * line cannot do this" is information, not an exception.
 */
export async function sendTapback({ conversationId: c, channels, reaction, messageHandle = null }) {
  const thread = db.getThread(c);
  const ch = channels?.get?.(thread?.channel ?? "");
  if (!channels || !ch) {
    return { ok: false, status: "not_connected", error: "There is no texting channel running, so there is nothing to react to. Say so plainly." };
  }
  // A channel that never implemented react() — the console, say — says so in one plain word rather
  // than failing somewhere deeper, and the model falls back to words.
  if (typeof ch.react !== "function" || ch.status?.().status !== "live") {
    return { ok: false, supported: false, refused: "not_supported", error: `${thread?.channel ?? "this channel"} cannot send tapbacks. Reply in words instead, or say nothing.` };
  }
  // Checked before the request so a bad value costs nothing and the reason is specific.
  const check = checkReaction(reaction);
  if (!check.ok) return { ok: false, error: check.error };

  // A named message (a food order's status goes on the text that asked for it) has to be one of
  // THEIRS in THIS conversation: db.messageByHandle only finds handles inside the thread it is given.
  const target = messageHandle ? (db.messageByHandle(c, messageHandle)?.from === "them" ? String(messageHandle).replace(/_\d+$/, "") : null) : thread?.last_inbound_id;
  if (messageHandle && !target) return { ok: false, error: "that message is not one of theirs in this conversation." };
  if (!target) {
    return { ok: false, error: "there is no message of theirs to react to yet — a tapback goes on something they sent you. Reply in words." };
  }
  if (thread.service && !/^imessage$/i.test(thread.service)) {
    return { ok: false, supported: false, refused: "not_supported", error: `this thread is ${thread.service}, and tapbacks are iMessage only. ${WORDS}` };
  }
  // Already refused for good, so it is not asked again. Same memory read receipts use.
  const known = db.blockedFeature({ channel: ch.name, feature: "reaction", line: ch.status?.().number ?? null });
  if (known) return { ok: false, supported: false, refused: "not_supported", error: `${known.why}. ${WORDS}` };

  let r;
  try {
    r = await ch.react({ messageHandle: target, reaction: check.value });
  } catch (e) {
    // An adapter that throws rather than returning a result is a bug, and it must not cost
    // anybody a reply. A tapback is the most skippable thing Reason does.
    return { ok: false, error: `the ${ch.name} adapter threw sending that tapback: ${(e?.message ?? String(e)).split("\n")[0]} — ${WORDS}` };
  }
  if (r.remember) {
    db.recordChannelLimit({
      channel: ch.name, feature: "reaction",
      scope: r.remember.scope === "line" ? `line:${ch.status?.().number ?? "unknown"}` : `contact:${thread.address}`,
      why: r.remember.why, code: r.http_status ?? null,
    });
  }
  // "This channel does not do tapbacks at all" is a different answer from "that did not work", and
  // it has to stay one word the whole way up: the console and Linq both inherit the base class's
  // refusal, and the model's job on reading it is to fall back to words rather than to retry.
  if (r.supported === false) {
    return { ok: false, supported: false, refused: "not_supported", error: `${r.error}. ${WORDS}` };
  }
  if (!r.ok) return { ok: false, error: `${r.error} — reply in words instead, and do not say you reacted.` };
  return {
    ok: true, reacted_to: target, reaction: r.reaction ?? check.value, removed: !!check.removing,
    note: check.removing
      ? "That reaction is off their message now. Nothing else was sent."
      : "They can see that on their message now. Do NOT also send a text saying the same thing — the tapback was the reply.",
  };
}
