// Which call gets the Cartesia voice (docs/calls-cartesia.md section 5, design 3), and the Twilio
// stream handed from one relay to the next when the trial falls back to GPT-Live. Nothing here talks
// to Cartesia: the relay itself (./cartesia.js) is only imported inside acceptStream's one branch.
import * as db from "../db.js";
import * as accounts from "../accounts.js";
import { config } from "../config.js";

/**
 * Does this call get the Cartesia voice? Only a call between an account's own person and Reason
 * (`is_owner`, either direction), with the key and the agent set, and:
 *   - REASON_CALL_CARTESIA=owner: the operator's account, and his choice on (`accounts.call_trial`
 *     "cartesia", set by `call_voice_trial`). As before `on` existed.
 *   - REASON_CALL_CARTESIA=on: any account, unless that person chose the usual voice ("usual").
 *   - off or unset: never.
 * Never, in any mode, a call to a business or another person, a call on someone's behalf, an event
 * call or a stranger (who has no row and never reaches this): Cartesia keeps a recording of every
 * agent session while it runs, and those people were not told.
 */
export function cartesiaTrialFor(row) {
  const mode = config.callCartesia;
  if (mode !== "owner" && mode !== "on") return false;
  if (!row?.conversation_id || Number(row.is_owner) !== 1) return false;
  if (!config.cartesiaKey || !config.cartesiaAgentId) return false;
  try {
    return cartesiaChosen(row.conversation_id);
  } catch { return false; }
}

/** Is the voice choice offered to this account at all? owner: the operator's only; on: every account. */
export function trialOffered(conversationId) {
  const mode = config.callCartesia;
  if ((mode !== "owner" && mode !== "on") || !conversationId) return false;
  try {
    const me = accounts.ownerOf(conversationId);
    if (!me) return false;
    // on: anyone with an account (a row to keep their choice on); owner: the operator only.
    return me.isOperator === true || (mode === "on" && me.known === true);
  } catch { return false; }
}

/**
 * This person's own calls are on the Cartesia voice (their choice, read for the mode the switch is at):
 * owner: only "cartesia" is yes ("" was the usual voice before `on` existed); on: everything but "usual".
 * False wherever the choice is not offered.
 */
export function cartesiaChosen(conversationId) {
  if (!trialOffered(conversationId)) return false;
  const t = db.callTrial(conversationId);
  return config.callCartesia === "on" ? t !== "usual" : t === "cartesia";
}

/** What `call_voice_trial off` stores: "usual" under on (so the default does not win), "" under owner (as before). */
export function usualValue() {
  return config.callCartesia === "on" ? "usual" : "";
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
