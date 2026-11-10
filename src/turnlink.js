// Which of their messages a reply answers (iPhone app, 2026-11-09). One turn runs on the messages a drain
// took (src/channels/router.js); everything that turn sends runs inside this scope, so the outbox row it
// writes is stamped with the message being answered (db.enqueueOutbound) and the history row carries it on
// (`messages.reply_to_id`). Anything sent outside a turn — a reminder firing, a sweep, a call's outcome,
// work a turn left running after it ended — has no scope and is stamped with nothing: it answers nobody.
//
// No imports on purpose, like src/zonescope.js: db.js reads this.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();
/** Every turn still open, so a tool call that arrives outside the turn's async scope can find it (ofCall). */
const openTurns = new Set();

/**
 * Run one turn. `held` are the inbound rows it took (oldest first); `to` is where its reply goes. The
 * fold (src/onethought.js) is attached once the router has it, so texts folded in mid-turn count too.
 */
export function run({ conversationId, to, held }, fn) {
  const turn = { conversationId, to: String(to ?? ""), handles: held.map(h => String(h.external_id ?? "")).filter(Boolean), fold: null, open: true, said: null };
  openTurns.add(turn);
  return { turn, result: scope.run(turn, () => fn(turn)) };
}

/**
 * The open turn a tool call belongs to, or null. Inside the turn's own async scope (the API backend) that
 * is the scope. The CLI backend's tool calls arrive as their own HTTP requests (src/backends/mcp-http.js),
 * outside it, carrying the turn's fold token (src/runtime.js toolCtx.foldToken): that token names exactly
 * one turn, so nothing is guessed from the time or from which conversation happens to be busy.
 */
export function ofCall(conversationId, foldToken = null) {
  const s = scope.getStore();
  if (s) return s.open && s.conversationId === conversationId ? s : null;
  if (!foldToken) return null;
  for (const t of openTurns) if (t.conversationId === conversationId && t.fold?.token === foldToken) return t;
  return null;
}

/** Run `fn` inside this turn's scope (a CLI tool call found by ofCall), so what it sends is a reply too. */
export function enter(turn, fn) {
  return turn && scope.getStore() !== turn ? scope.run(turn, fn) : fn();
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
export function close(turn) { if (turn) { turn.open = false; openTurns.delete(turn); } }
