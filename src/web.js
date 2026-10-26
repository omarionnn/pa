// Reason Web: the switch, and the two rules every other file asks it about.
//
// Web is a ROUTE to a person's existing conversation, never a conversation of its own. Phase W0
// (docs/plans/reason-web-phase1.md §6) lays the foundations and nothing a person can see: the flag,
// the `web` channel adapter, the per-message history every channel now writes into, and the guard
// that stops a web message from stealing where Reason's own texts go. There are no routes yet.
//
// Who may be reached over web is REASON_WEB (off | owner | on), like REASON_EVENTS. `owner` is
// "only the owner's conversation", because the first person to use Web is the owner, alone, for a
// soak (§7 decision 10).
import * as accounts from "./accounts.js";
import { config } from "./config.js";

/** The channel name a web message arrives on and leaves by. One spelling, everywhere. */
export const WEB = "web";

/** Web exists at all. Off: no adapter is registered, nothing is written, nothing routes. */
export function webOn() {
  return config.web === "owner" || config.web === true;
}

/**
 * May THIS conversation be reached over web? `owner`: the operator's own conversation only. On:
 * anybody with a Reason. Off: nobody. Asked with the conversation the SESSION resolved to, never
 * one the client named.
 */
export function webAllowedFor(conversationId) {
  if (!conversationId) return false;
  if (config.web === "owner") return accounts.ownerOf(conversationId).isOperator;
  return config.web === true;
}

/**
 * Should a message be written into the per-message history (db.writeMessage)? Only while web is
 * not off: with the flag off the table stays exactly as empty as it was, which is the "zero
 * behaviour change" the rollout rests on. Written for EVERY conversation once the flag is `owner`
 * or `on`, so the owner's soak builds everybody's history from that day and turning it `on` later
 * does not start them from nothing.
 */
export function historyOn() {
  return webOn();
}
