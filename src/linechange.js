// Reason changed numbers, and the people who knew the old one are told once.
//
// On 2026-10-23 at about 15:50 UTC Reason's texting line moved from the shared Sendblue number
// +1 808 319 9759, which is gone, to a dedicated line, +1 656 216 7455. That line is inbound-only:
// it can answer anybody who texts it and nobody else, so there is no telling people in advance.
// What happens instead is here. Somebody who texted Reason before the switch texts the new number,
// and their phone treats it as a stranger: the old thread and their saved "Reason" contact both
// still point at the dead line. So, the first time and only the first time:
//
//   1. Reason's contact card (GET /reason.vcf, the live card — 656 for texts, 914 for calls), by
//      address, the same way src/contact.js sends it;
//   2. one line saying this is the new number, and to choose Add to Existing Contact → Reason so
//      the old contact is updated rather than a second one appearing;
//   3. and then their message is answered exactly as it would have been. This is in front of the
//      turn, never instead of it.
//
// Who counts as returning is a fact about the database, not a list: a sendblue conversation with
// at least one inbound message received before the cutoff (`REASON_LINE_CHANGE_AT`). Somebody who
// first texted after it already has the new number and never sees this. The owner had moved over
// before this existed, so the migration marks him done (src/db.js).
//
// Once means a row (`line_change_cards`), claimed before anything is sent: a retried webhook, a
// duplicate delivery or a second text in the same burst finds the row and sends nothing. A card
// that does not go is not tried again — the line still goes, and the row says the card failed —
// because a nicety retried on every text is not a nicety.
import * as db from "./db.js";
import { config } from "./config.js";
import { contactCardUrl } from "./contact.js";

/** The line that follows the card. Any person, any thread — so no names in it. */
export const LINE_CHANGE_LINE = "heads up — this is my new number, the old one's gone. tap my contact card and choose Add to Existing Contact → Reason, so your saved contact updates instead of doubling up.";

/** The channel the old line was on. Only its conversations can be returning. */
export const LINE_CHANGE_CHANNEL = "sendblue";

/** Whether this conversation should be told, right now. Read-only; `tellNewLine` is what claims. */
export function isReturning(conversationId, { at = config.lineChangeAt } = {}) {
  if (!Number.isFinite(at)) return false;
  return db.lineChangeDue(conversationId, { channel: LINE_CHANGE_CHANNEL, before: at });
}

/**
 * The card and the line, once, for one inbound from a returning person. Never throws: whatever
 * happens here, their message is still answered. Returns what happened, for the log and the tests:
 * `not_returning` (new, the owner, another channel, or already told), `told` with whether the card
 * went.
 */
export async function tellNewLine({ router, channel, to, chatId = null, conversationId, log = () => {} }) {
  try {
    if (channel !== LINE_CHANGE_CHANNEL || !isReturning(conversationId)) return { outcome: "not_returning" };
    // Claimed before either send. A duplicate webhook that lands while the card is on its way loses
    // here and goes straight to its turn.
    if (!db.claimLineChangeCard(conversationId)) return { outcome: "not_returning" };

    const url = contactCardUrl();
    let card;
    if (!url) card = { ok: false, error: "REASON_PUBLIC_URL is not set, so there is no address to serve the card from" };
    else {
      try { card = await router.sendMediaUrl({ channel, to, mediaUrl: url, chatId }); }
      catch (e) { card = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] }; }
    }
    // A card that went is also the contact card src/contact.js would otherwise send them later.
    if (card?.ok) db.markContactCardSent(conversationId);

    let line;
    try {
      line = await router.send({
        channel, to, text: LINE_CHANGE_LINE, chatId, conversationId, toOwner: true,
        // The outbox's own guard as well as the row's: one line per person, whatever calls this.
        idempotencyKey: `line-change:${conversationId}`,
      });
    } catch (e) {
      line = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    db.recordLineChangeCard(conversationId, { cardOk: !!card?.ok, why: card?.ok ? null : (card?.error ?? "unknown") });
    log({ line_change_told: conversationId, card: card?.ok ? "sent" : "failed", ...(card?.ok ? {} : { card_why: card?.error }), line: line?.ok ? "sent" : "failed" });
    return { outcome: "told", card: !!card?.ok, line: !!line?.ok };
  } catch (e) {
    log({ line_change_failed: conversationId, why: (e?.message ?? String(e)).split("\n")[0] });
    return { outcome: "failed" };
  }
}
