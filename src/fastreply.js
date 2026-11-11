// REASON_FAST_REPLY (off | owner | on; default off): the reply-speed pass of 2026-11-11.
//
// Read on every call so a restart is the only thing a flip needs. "owner" = the operator's own
// thread only, the same check src/contextfirst.js and src/threading.js use. Each thing it switches
// on keeps the reply the model writes exactly what it was; what changes is how long it takes to
// arrive. What is behind it, and where:
//
//   1. The history anchor fits instead of being dropped (src/backends/claude-cli.js historyParts):
//      when the system prompt plus the whole 40-line anchor would pass the argument limit, the
//      oldest lines that fit are anchored and the rest ride in the message. The model reads the
//      same lines in the same order; the prompt cache keeps most of the history instead of none.
//      On 2026-11-11 the anchor was dropped ("too_long") on 30 owner turns (9 the day before),
//      and those turns wrote 40k tokens of cache each against 15k for a kept anchor.
//   2. Anchors survive a restart (same file): written to the data dir when set, read back at the
//      first turn after a boot. Every deploy forgot them, and the first turn of every thread after
//      it wrote the whole history again ("new": 70k tokens written, 8 times on 11-11).
//   3. The CLI starts before the prompt is ready (runTurnOnCli): its boot (~0.7 s on the server)
//      overlaps the memory lookup and the notes instead of following them. The prompt goes down
//      stdin the moment it is built, the way a turn with pictures already sends it.
//   4. The said check is not asked when it cannot find anything (src/said.js checkDraft): no tool
//      of the turn acted, and the draft shares not one figure or content word with any standing
//      claim or closed question. ~2.3 s off those replies; the warm CLI is put down unasked.
//   5. The background lane stays paused through the check and the send (src/runtime.js _turn),
//      not only through the model: extraction's CLI was booting beside the said check's.
import { config } from "./config.js";

/** off | owner | on. */
export function fastReplyMode() {
  const v = String(process.env.REASON_FAST_REPLY ?? "off").trim().toLowerCase();
  return v === "on" || v === "owner" ? v : "off";
}

/** Is it on for this conversation? Either the operator's flag or the conversation id names the owner. */
export function fastReplyOn({ isOperator = false, conversationId = null } = {}) {
  const m = fastReplyMode();
  if (m === "on") return true;
  if (m !== "owner") return false;
  return !!isOperator || (conversationId != null && conversationId === config.ownerConversation);
}
