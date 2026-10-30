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

// REASON_STAMPS_ALL (off | on, 2026-10-30): Stamps for everyone — the book, its STAMPS link, the "New in
// your book" tile on Home, awards and shares — without the daily edition. Telling someone about a seal in
// their thread stays behind REASON_WEB_DAILY=on (stamps.js tellNew), so this sends nothing. Off: Stamps is
// wherever REASON_WEB_DAILY allows it, as before.
export function stampsOpen() {
  return ["1", "true", "on", "yes"].includes(String(process.env.REASON_STAMPS_ALL ?? "").trim().toLowerCase());
}

/** May this conversation have Stamps (the book, awards, shares)? REASON_WEB_DAILY's answer, or everyone at REASON_STAMPS_ALL. */
export function stampsAllowedFor(conversationId) {
  if (!conversationId) return false;
  return stampsOpen() || dailyAllowedFor(conversationId);
}

// REASON_WEB_REPLY (off | owner | on, 2026-10-30): reply to one message on Reason Web, the way holding a
// bubble and tapping Reply does it in Messages (src/pages/webreply.js). The Reply button, the composer's
// "replying to" line, the quote line over a reply in the thread (theirs from either place, and Reason's
// own pinned answers), and the reply read by the turn as answering THAT message. `owner`: only the
// operator's own conversation, for the owner's look first. Off: Web is as it was.
export function webReplyMode() {
  const v = String(process.env.REASON_WEB_REPLY ?? "").trim().toLowerCase();
  if (v === "owner") return "owner";
  return ["1", "true", "on", "yes"].includes(v) ? "on" : "off";
}

export function webReplyAllowedFor(conversationId) {
  if (!conversationId) return false;
  const mode = webReplyMode();
  if (mode === "off") return false;
  if (mode === "owner") return accounts.ownerOf(conversationId).isOperator;
  return true;
}
