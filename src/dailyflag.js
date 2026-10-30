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

// REASON_STAMPS_EVERYDAY (off | on, 2026-10-30): everyday seals in the wax book — a call that got what it
// was for, a question researched — on top of the rare ones, so ordinary errands land in the book too.
// Wax book only. Off: nothing new is awarded and the hints are as they were.
export function everydaySeals() {
  return waxLook() && ["1", "true", "on", "yes"].includes(String(process.env.REASON_STAMPS_EVERYDAY ?? "").trim().toLowerCase());
}

// REASON_STAMPS_TIERS (off | on, 2026-10-30): one seal per kind, never two alike. An everyday seal earned
// again counts up instead of adding a copy, and at its kind's milestones (stamps.js TIERS: research 500 /
// 1000 / 2000, a call 25 / 100 / 250) the same seal is upgraded in place (a numbered ribbon, then gold).
// Needs REASON_STAMPS_EVERYDAY. Off: the book is as #251 drew it.
export function sealTiers() {
  return everydaySeals() && ["1", "true", "on", "yes"].includes(String(process.env.REASON_STAMPS_TIERS ?? "").trim().toLowerCase());
}
