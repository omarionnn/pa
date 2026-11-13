// Which call gets the Cartesia voice trial (docs/calls-cartesia.md section 5, design 3), and the Twilio
// stream handed from one relay to the next when the trial falls back to GPT-Live. Nothing here talks
// to Cartesia: the relay itself (./cartesia.js) is only imported inside acceptStream's one branch.
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config } from "../config.js";

/**
 * Does this call get the Cartesia voice? Only all of these at once: REASON_CALL_CARTESIA=owner, the key
 * and the agent set, a call between the account's owner and Reason (`is_owner`, either direction), that
 * account the operator's, and his own choice on (`accounts.call_trial`, set by `call_voice_trial`).
 * Never a business, another person, or a stranger (who has no row and never reaches this): Cartesia
 * keeps a recording of every agent session, and they were not told.
 */
export function cartesiaTrialFor(row) {
  if (config.callCartesia !== "owner") return false;
  if (!row?.conversation_id || Number(row.is_owner) !== 1) return false;
  if (!config.cartesiaKey || !config.cartesiaAgentId) return false;
  try {
    if (accounts.ownerOf(row.conversation_id)?.isOperator !== true) return false;
    return db.callTrial(row.conversation_id) === "cartesia";
  } catch { return false; }
}

/** Is the trial offered to this account at all (the switch at owner, and the operator's account)? */
export function trialOffered(conversationId) {
  if (config.callCartesia !== "owner" || !conversationId) return false;
  try { return accounts.ownerOf(conversationId)?.isOperator === true; } catch { return false; }
}

/**
 * One Twilio stream that changes hands: each `pass()` gives the next holder a socket of its own, and the
 * one before it hears nothing more. The stream's own events (connected, start) are kept and told to every
 * new holder once it is listening (`flush`), so a relay built late still learns the stream's sid; audio is
 * kept only while nobody holds the stream, and stale audio is not replayed into a later holder.
 */
export function passableSocket(socket) {
  let holder = null;
  let closed = null;
  const events = [];
  let media = [];
  socket.onMessage((text) => {
    if (holder) return holder.message(text);
    if (/"event"\s*:\s*"media"/.test(String(text))) { if (media.length < 500) media.push(text); } else events.push(text);
  });
  socket.onClose((code) => { closed = code ?? 1000; if (holder) holder.closed(closed); });
  // Their own events are always remembered (a later holder needs `start` again); audio never twice.
  const remember = (text) => { if (!/"event"\s*:\s*"media"/.test(String(text))) events.push(text); };
  return {
    pass({ withAudio = false } = {}) {
      holder = null;
      const msg = [];
      const shut = [];
      const h = {
        message: (t) => { remember(t); for (const f of msg) { try { f(t); } catch { /* one handler never stops the stream */ } } },
        closed: (c) => { for (const f of shut) { try { f(c); } catch { /* never breaks the close */ } } },
      };
      return {
        send: (t) => socket.send(t),
        close: (c) => socket.close(c),
        open: () => (typeof socket.open === "function" ? socket.open() : closed == null),
        onMessage: (f) => msg.push(f),
        onClose: (f) => shut.push(f),
        /** Tell this holder what the stream said before it listened, then hand it the stream. */
        flush() {
          const told = [...events, ...(withAudio ? media : [])];
          media = [];
          for (const t of told) for (const f of msg) { try { f(t); } catch { /* as above */ } }
          holder = h;
          if (closed != null) h.closed(closed);
        },
      };
    },
  };
}
