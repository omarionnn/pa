// Who Reason belongs to.
//
// It used to belong to one person: `REASON_OWNER_NUMBER` was the owner and everybody else was a
// stranger with no memory, no plans and no authority. That is now one case of a general rule —
// **every person who texts Reason gets their own Reason.** Their own memory, plans, tasks, timers,
// watchers, pages, calls, receipts, connected accounts and confirmations, none of it visible from
// anybody else's thread.
//
// The thing that makes that safe was already in the code: every tool is scoped by
// `conversationId`, and nothing reads across conversations. So an account IS a conversation id,
// and the isolation is the scoping that was already there rather than a new layer bolted over it.
// What this module adds is who gets one, which conversation their messages land in, and what it
// costs the operator when they use it.
//
// Three deliberate choices:
//
//   - **The operator's conversation id stays `dm:owner`.** Their existing plans, memory and
//     receipts are already under it, so they become the operator's account with no data migration
//     and single-owner self-hosting behaves exactly as before.
//   - **Invite-only by default.** A number nobody approved gets one line and no model turn. An
//     agent that answers any number that texts it is an agent anybody can run a bill up on.
//   - **A cap per person per day**, counted in the database. The operator pays for every turn, so
//     one person cannot spend the whole month.
import * as db from "./db.js";
import { config, clock, normalizeNumber } from "./config.js";

/** The console is always the operator: there is nobody else on the other end of a terminal. */
export const CONSOLE_ADDRESS = "console";

/** Where one person's Reason lives. The operator keeps the id their data is already under. */
export function conversationIdFor({ channel, address }) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  if (isOperatorAddress(addr) || channel === "console") return config.ownerConversation;
  return `dm:${channel}:${addr}`;
}

/** Read from config only — nothing a message says can put a number on this list. */
export function isOperatorAddress(address) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  if (!addr) return false;
  if (addr === CONSOLE_ADDRESS) return true;
  return config.operatorNumbers.some(n => normalizeNumber(n) === addr);
}

/** Does this number already have a Reason, and is it answering? */
export function accountState(channel, address) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  const row = db.accountByAddress(channel, addr) ?? db.getAccount(conversationIdFor({ channel, address: addr }));
  return row ? (row.state ?? "active") : null;
}

/**
 * May this address have a Reason, and which one?
 *
 * Returns `{ allow: true, conversationId, isOperator, created }` or
 * `{ allow: false, reason: "not_invited" }`. The caller does not get to guess: a refusal here
 * means no turn runs, which is the whole point — a number nobody approved must not be able to
 * spend the operator's money by texting.
 */
/** Did the master pre-approve this number by listing it in REASON_TEST_NUMBERS? */
export function isPreApproved(address) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  return !!addr && config.testNumbers.some((n) => (normalizeNumber(n) || n) === addr);
}

export function admit({ channel, address, name = "" }) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  if (!addr) return { allow: false, reason: "no_address" };

  const operator = isOperatorAddress(addr);
  if (!operator) {
    if (db.isBlocked(addr)) return { allow: false, reason: "blocked", address: addr };
    const state = accountState(channel, addr);
    // No account yet: they have to be let in by the master first (src/access.js) — unless the
    // master already did, by writing their number into REASON_TEST_NUMBERS. Putting a number in
    // that list IS the approval, so asking again by text would be asking the master a question
    // they have answered. Their first text creates the account and gets a real turn. A blocked
    // number is still refused above; the list does not outrank a block.
    if (!state && !isPreApproved(addr)) return { allow: false, reason: "no_account_yet", address: addr };
    // Paused or removed: Reason stops answering, and nothing of theirs is touched. "Stop" and
    // "destroy" are different instructions and the master gives them separately.
    if (state && state !== "active") return { allow: false, reason: state, address: addr };
  }
  const conversationId = conversationIdFor({ channel, address: addr });
  const existing = db.getAccount(conversationId);
  db.upsertAccount({
    conversationId, channel, address: addr,
    name: name || existing?.name || (operator ? config.ownerName : ""),
    isOperator: operator,
  });
  return { allow: true, conversationId, isOperator: operator, created: !existing };
}

/**
 * Whose Reason is this conversation? Used everywhere a tool needs to say "the person I work for".
 *
 * Falls back to config for the operator's own thread so that an install with one number in
 * `REASON_OWNER_NUMBER`, or somebody typing in the console, behaves exactly as it did before any
 * of this existed.
 */
export function ownerOf(conversationId) {
  const row = db.getAccount(conversationId);
  if (row) {
    return {
      conversationId,
      // An invited person Reason has not learned the name of yet. "they" would read badly in a
      // call announcement ("on behalf of they"), so the fallback is something that is true.
      name: row.name || (row.is_operator ? config.ownerName : "the person I work for"),
      address: row.address,
      channel: row.channel,
      isOperator: !!row.is_operator,
      known: true,
    };
  }
  // No row yet: the console on a fresh install, or a test driving a conversation id directly.
  const isOwnerThread = conversationId === config.ownerConversation;
  return {
    conversationId,
    name: isOwnerThread ? config.ownerName : "the person I work for",
    address: isOwnerThread ? (config.operatorNumbers[0] ?? CONSOLE_ADDRESS) : "",
    channel: "console",
    isOperator: isOwnerThread,
    known: false,
  };
}

/** Is this conversation's person allowed to run admin commands? */
export function isOperatorConversation(conversationId) {
  return ownerOf(conversationId).isOperator;
}

// ---------- what it costs ----------

/** The day a cap is counted against, in the operator's timezone rather than UTC. */
export function today(nowMs = clock.now()) {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: config.tz });
}

/**
 * Has this person used up their day?
 *
 * `kind` is "turn" for anything they asked for, "proactive" for anything Reason started. They are
 * capped separately: being chatty is their business, but Reason interrupting people on the
 * operator's bill is Reason's.
 */
export function withinCap(conversationId, kind = "turn") {
  const limit = kind === "proactive" ? config.maxProactivePerDay : config.maxTurnsPerDay;
  if (!limit) return { ok: true, limit: 0, used: 0 }; // 0 means uncapped
  const used = db.usageToday(conversationId, today())[kind === "proactive" ? "proactive" : "turns"];
  return used >= limit
    ? { ok: false, limit, used, kind }
    : { ok: true, limit, used, kind };
}

export function countUse(conversationId, kind = "turn") {
  return db.bumpUsage(conversationId, today(), kind === "proactive" ? "proactive" : "turns");
}

/**
 * Should a line go out to this number again?
 *
 * Somebody whose Reason is paused or removed should be told once and then left alone; repeating it
 * on every message turns Reason into the thing sending unsolicited texts.
 */
export function shouldTellAgain(address) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  const last = db.lastTurnedAway(addr);
  if (last && clock.now() - last < config.turnedAwayGapMin * 60_000) return false;
  db.recordTurnedAway(addr);
  return true;
}

/** What somebody whose access was stopped is told. Once. No model call is spent on it. */
export function stoppedLine(reason) {
  return reason === "paused"
    ? `hey — ${config.ownerName} has paused this for now, so i can't help at the moment. nothing of yours is gone.`
    : `hey — i'm not set up to help on this number any more. nothing of yours has been deleted.`;
}
