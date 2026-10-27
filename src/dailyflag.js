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

// REASON_STAMPS_WAX (off | on): the wax-seal book (handoff 2026-10-27 "S3 · Old money, made real") in
// place of the typed stamps, wherever REASON_WEB_DAILY already shows Stamps. Off: the look stays as it
// was. The seals are the same rows either way; only how they are drawn and told changes.
export function waxLook() {
  return ["1", "true", "on", "yes"].includes(String(process.env.REASON_STAMPS_WAX ?? "").trim().toLowerCase());
}
