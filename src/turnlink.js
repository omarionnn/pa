// Which of their messages a reply answers (iPhone app, 2026-11-09). One turn runs on the messages a drain
// took (src/channels/router.js); everything that turn sends runs inside this scope, so the outbox row it
// writes is stamped with the message being answered (db.enqueueOutbound) and the history row carries it on
// (`messages.reply_to_id`). Anything sent outside a turn — a reminder firing, a sweep, a call's outcome,
// work a turn left running after it ended — has no scope and is stamped with nothing: it answers nobody.
//
// No imports on purpose, like src/zonescope.js: db.js reads this.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();

/**
 * Run one turn. `held` are the inbound rows it took (oldest first); `to` is where its reply goes. The
 * fold (src/onethought.js) is attached once the router has it, so texts folded in mid-turn count too.
 */
export function run({ conversationId, to, held }, fn) {
  const turn = { conversationId, to: String(to ?? ""), handles: held.map(h => String(h.external_id ?? "")).filter(Boolean), fold: null, open: true };
  return { turn, result: scope.run(turn, () => fn(turn)) };
}

/** Every message this turn answers: the ones it took, then the ones folded into it, in that order. */
export function handlesOf(turn) {
  const folded = (turn?.fold?.added ?? []).map(a => String(a.handle ?? "")).filter(Boolean);
  return [...new Set([...(turn?.handles ?? []), ...folded])];
}

/** The message a reply sent now answers: the newest folded text, else the last one taken. */
export function answering(turn) {
  return turn?.fold?.added?.at(-1)?.handle ?? turn?.handles?.at(-1) ?? null;
}

/**
 * The handle an outbound message to (conversationId, address) is answering, or null. Only inside an
 * open turn, for the same conversation and the same address the turn replies to: a text to somebody
 * else, or to this person on another line, answers nothing.
 */
export function answeringFor(conversationId, address) {
  const t = scope.getStore();
  if (!t || !t.open || t.conversationId !== conversationId || t.to !== String(address ?? "")) return null;
  return answering(t);
}

/** The turn is over: nothing sent from its scope after this is a reply. */
export function close(turn) { if (turn) turn.open = false; }
