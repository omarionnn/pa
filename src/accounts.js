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
import * as plan from "./plan.js";
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

/**
 * Does this number already have a Reason, and is it answering?
 *
 * Which Reason is per line (the row for this channel), but whether it answers is per person: a
 * number paused or removed on one line is paused or removed on every line, the way a block is.
 * Otherwise a stopped number texting the other line would look like a stranger and could be
 * auto-admitted into a fresh Reason, or put in front of the master as if new.
 */
export function accountState(channel, address) {
  const addr = normalizeNumber(address) || String(address ?? "").trim();
  if (!isOperatorAddress(addr)) {
    const stopped = db.stoppedStateOf(addr);
    if (stopped) return stopped;
  }
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
 * REASON_EARLY_ACCESS: comma-separated conversation ids (e.g. dm:sendblue:+15551234567) that get every
 * feature whose flag says "owner", as if they were the owner. FEATURE GATING ONLY: never operator powers,
 * ops pages, owner-routed sends, instance ownership, billing exemptions or anything else that asks
 * `isOperator`. Read at call time; nothing announces it to the people on the list.
 */
export function earlyAccessIds() {
  return String(process.env.REASON_EARLY_ACCESS ?? "").split(",").map(s => s.trim()).filter(Boolean);
}
export function earlyAccess(conversationId) {
  return !!conversationId && earlyAccessIds().includes(String(conversationId));
}
/** May this conversation have a feature whose flag is "owner"? The operator, or an early-access id. */
export function featureOwner(conversationId) {
  if (!conversationId) return false;
  return earlyAccess(conversationId) || ownerOf(conversationId).isOperator;
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
      // What their pages' top line is written in; "" is English. The owner's comes from config
      // until they say otherwise.
      language: row.language || (row.is_operator ? config.ownerLanguage : ""),
      address: row.address,
      channel: row.channel,
      isOperator: !!row.is_operator,
      // The first-chat onboarding already asked their name (src/onboarding.js), so the prompt does
      // not ask it again: somebody who would rather not say is not pushed a second time.
      nameAsked: !!row.onboarding_name_asked_at,
      // In the first-chat onboarding, or through it: code's welcome asks their name and sends the
      // card, so the prompt never runs an interview of its own on top of it.
      // "active" while it runs, "done" after it (null: never in it).
      firstChat: row.onboarding == null ? null : row.onboarding === "complete" ? (row.onboarding_at ? "done" : null) : "active",
      known: true,
    };
  }
  // No row yet: the console on a fresh install, or a test driving a conversation id directly.
  const isOwnerThread = conversationId === config.ownerConversation;
  return {
    conversationId,
    name: isOwnerThread ? config.ownerName : "the person I work for",
    language: isOwnerThread ? config.ownerLanguage : "",
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
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: config.installTz });
}

/**
 * The four things one person can use up in a day, and where each one is counted.
 *
 * `per` is what the stored number is counted in versus what the limit is written in: call minutes
 * are stored as seconds, because that is the only honest unit for a call that ran 40 seconds, and
 * compared in minutes, because that is the unit a limit is worth setting in.
 */
const CAPS = {
  turn: { column: "turns", limit: () => config.maxTurnsPerDay, per: 1 },
  proactive: { column: "proactive", limit: () => config.maxProactivePerDay, per: 1 },
  call: { column: "calls", limit: () => config.maxCallsPerDay, per: 1 },
  call_minutes: { column: "call_seconds", limit: () => config.maxCallMinutesPerDay, per: 60 },
};

/**
 * Has this person used up their day?
 *
 * `kind` is "turn" for anything they asked for, "proactive" for anything Reason started. They are
 * capped separately: being chatty is their business, but Reason interrupting people on the
 * operator's bill is Reason's.
 *
 * "call" and "call_minutes" are the same idea pointed at the expensive thing. A turn costs tokens;
 * a call costs a per-minute telephony rate for as long as somebody keeps talking, and nothing else
 * in Reason spends money by the minute. Capping the count alone would let ten long calls through,
 * and capping the minutes alone would let a hundred short ones, so both exist.
 */
export function withinCap(conversationId, kind = "turn") {
  const cap = CAPS[kind] ?? CAPS.turn;
  const limit = cap.limit();
  if (!limit) return { ok: true, limit: 0, used: 0 }; // 0 means uncapped
  // The operator pays the bill, so the DAILY call caps are not his (REASON_CALL_CAPS_EXEMPT,
  // "operator" by default; "none" caps him like everyone else). Each call's own length ceiling
  // (callPlatformCapSeconds) and the API spend caps still apply to him; they live elsewhere.
  if ((kind === "call" || kind === "call_minutes") && config.callCapsExempt === "operator"
      && isOperatorConversation(conversationId)) return { ok: true, limit: 0, used: 0, exempt: true };
  const used = Math.floor((db.usageToday(conversationId, today())[cap.column] ?? 0) / cap.per);
  return used >= limit
    ? { ok: false, limit, used, kind }
    : { ok: true, limit, used, kind };
}

/**
 * Count one use. `amount` is the only argument that is ever anything but 1: call minutes are
 * counted in real seconds, once, when the call has ended and its length is a settled fact.
 */
export function countUse(conversationId, kind = "turn", amount = 1) {
  const cap = CAPS[kind] ?? CAPS.turn;
  // A turn of theirs is also a visit for the free trial (src/plan.js): a new session when 30 minutes
  // have passed. A refund (negative) is not a visit. Never allowed to cost the turn.
  if (kind === "turn" && amount > 0) { try { plan.noteTurn(conversationId); } catch { /* the count above still stands */ } }
  return db.bumpUsage(conversationId, today(), cap.column, amount);
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

/** What somebody whose access was stopped is told. Once. No model call is spent on it. Names nobody. */
export function stoppedLine(reason) {
  return reason === "paused"
    ? `hey — this is paused for now, so i can't help at the moment. nothing of yours is gone.`
    : `hey — i'm not set up to help on this number any more. nothing of yours has been deleted.`;
}
