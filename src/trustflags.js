// The three texting-trust switches added 2026-11-11, each off by default and each read on every
// call so a restart is the only thing a flip needs. The same three-way shape REASON_THREADING has:
//
//   off     nothing changes (the default)
//   owner   only the operator's own thread
//   on      everybody
//
//   REASON_TAPBACK_ACK        a fixed-meaning tapback the moment a text goes to the model (src/tapbackack.js)
//   REASON_DELIVERY_GATED     "sent" only once the provider confirms delivery (src/outbox.js noteDelivery)
//   REASON_QUICK_CORRECTION   a check after an outward action, and a "quick correction:" text when it
//                             did not hold (src/verifications.js)
//   REASON_TAPBACK_TOPIC      with REASON_TAPBACK_ACK, the first tapback says what the text is about
//                             (💻 a tech problem, 🛍️ shopping...) instead of 👀 (src/acktopic.js)
import * as accounts from "./accounts.js";

export const FLAGS = {
  tapbackAck: "REASON_TAPBACK_ACK",
  deliveryGated: "REASON_DELIVERY_GATED",
  quickCorrection: "REASON_QUICK_CORRECTION",
  tapbackTopic: "REASON_TAPBACK_TOPIC",
};

/** off | owner | on, for one switch. Anything else reads as off. */
export function modeOf(envName) {
  const v = String(process.env[envName] ?? "off").trim().toLowerCase();
  return v === "on" || v === "owner" || v === "1" || v === "true" ? (v === "owner" ? "owner" : "on") : "off";
}

/**
 * Is this switch on for this conversation? Decided from the account row, never from the model:
 * "owner" covers the operator's thread (accounts.ownerOf), and nobody else's.
 */
export function onFor(envName, conversationId) {
  const m = modeOf(envName);
  if (m === "on") return true;
  if (m !== "owner" || !conversationId) return false;
  try { return !!accounts.ownerOf(conversationId).isOperator; } catch { return false; }
}

export const tapbackAckOn = (conversationId) => onFor(FLAGS.tapbackAck, conversationId);
export const deliveryGatedOn = (conversationId) => onFor(FLAGS.deliveryGated, conversationId);
export const quickCorrectionOn = (conversationId) => onFor(FLAGS.quickCorrection, conversationId);
export const tapbackTopicOn = (conversationId) => onFor(FLAGS.tapbackTopic, conversationId);
