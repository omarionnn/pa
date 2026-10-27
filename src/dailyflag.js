// REASON_WEB_DAILY (off | owner | on): the daily edition Home, Stamps and stamp shares (2026-10-27).
// `owner`: only the operator's own conversation sees them, for the owner's look before anyone else does.
// Read at call time so a test can set the env and a restart is the only switch.
import * as accounts from "./accounts.js";

export function dailyMode() {
  const v = String(process.env.REASON_WEB_DAILY ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

export function dailyAllowedFor(conversationId) {
  if (!conversationId) return false;
  const mode = dailyMode();
  if (mode === "owner") return accounts.ownerOf(conversationId).isOperator;
  return mode === "on";
}
